// @ts-check
/**
 * The Power Automate flows: product feedback exports emailed to the admin, and the Power Platform
 * inventory of Copilot Studio agents. The installer creates each flow, turned off, in a Power
 * Platform environment the user picks. It makes the HTTP with Microsoft Entra ID connections
 * the flows need, gives a sign-in link for each, and once they're signed in to, points the flows at
 * them and turns them on. Anything else (e.g. Outlook) the user signs in to in Power Automate.
 * When a flow can't be created, it is written to a file to import instead.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isConnected } from '../clients/connections.js';
import { orgUrl } from '../clients/dataverse.js';
import { flowIdentity, secretMode } from '../config.js';
import { commandLine } from '../launch.js';
import {
  AGENT_INVENTORY_DIR,
  AGENT_INVENTORY_FLOW_NAME,
  agentInventoryFlowDefinition,
  connectionReferencesOf,
  connectorByName,
  connectorsUsed,
  CONNECTORS,
  FEEDBACK_FLOW_NAME,
  FEEDBACK_SUBJECT,
  feedbackFlowDefinition,
  flowClientData,
  flowFile,
  isBound,
  nameByConnection,
  newConnections,
  ONELAKE_DFS,
  oneLakeEndpoint,
  PPAPI,
  STORAGE_RESOURCE,
} from '../transform/flows.js';
import { c } from '../ui.js';
import { UPLOAD_DIR } from '../uploads.js';
import { ensureWorkspaceRole } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {'feedback' | 'agents'} FlowKind */

const MAKER = 'https://make.powerautomate.com/';
export const FLOW_FILES = /** @type {Record<FlowKind, string>} */ ({
  feedback: 'analytics-hub-feedback-flow.json',
  agents: 'analytics-hub-agent-inventory-flow.json',
});

/** @type {Record<FlowKind, string>} */
export const FLOW_NAMES = { feedback: FEEDBACK_FLOW_NAME, agents: AGENT_INVENTORY_FLOW_NAME };

/** @param {import('../config.js').InstallConfig} config @returns {FlowKind[]} */
const flowsChosen = (config) => [
  ...(config.dataSources.productFeedback === 'api' ? /** @type {const} */ (['feedback']) : []),
  ...(config.dataSources.resourceGraph === 'api' && config.resourceGraph?.agents !== false ? /** @type {const} */ (['agents']) : []),
];

/** The app identity reads its secret from Key Vault, which notebook mode doesn't use. @param {import('../config.js').InstallConfig} config */
const appWithoutVault = (config) => flowIdentity(config) === 'app' && secretMode(config) === 'notebook';

/** @param {import('../config.js').InstallConfig} config @returns {FlowKind[]} */
export const flowsWanted = (config) => (appWithoutVault(config) ? [] : flowsChosen(config));

/**
 * Flows the user asked for that can't be made: the app identity with the secret in the notebooks.
 * @param {import('../config.js').InstallConfig} config
 */
export const flowsSkipped = (config) => (appWithoutVault(config) ? flowsChosen(config).map((k) => FLOW_NAMES[k]) : []);

/** @param {string} v */
function validateUrl(v) {
  if (!v.trim()) return true;
  try {
    return new URL(v.trim()).protocol === 'https:' ? true : 'Use the https:// address.';
  } catch {
    return 'Use the environment URL, like https://contoso.crm.dynamics.com.';
  }
}

/**
 * Asks where to create the flows. Each comes with its source's api mode: product feedback's
 * "Power Automate (emailed export)" and the agent inventory under Azure Resource Graph.
 * @param {Ctx} ctx
 */
export async function planFlows(ctx) {
  if (flowsWanted(ctx.config).length) await pickFlowEnvironment(ctx);
}

/** What the user should know before picking the flows' environment. */
export const FLOW_ENVIRONMENT_HINT =
  'The flows run in this environment, and people with access to it can see them. Its data policy (DLP) must allow the "HTTP with Microsoft Entra ID (preauthorized)" connector, and whoever signs in to the flows needs a Power Automate Premium licence.';

/**
 * The tenant's default Power Platform environment ID, from Power Automate. If that can't be read,
 * it is "Default-<tenant ID>", which is what Power Platform calls it.
 * @param {Ctx} ctx
 */
async function defaultEnvironmentId(ctx) {
  try {
    const envs = (await ctx.api.flow?.listEnvironments()) ?? [];
    const found = envs.find((e) => e.properties?.isDefault === true)?.name;
    if (found) return found;
  } catch {
    // Falls back to the name below.
  }
  return ctx.user?.tenantId ? `Default-${ctx.user.tenantId}` : undefined;
}

/**
 * Picks the Power Platform environment the flows go in. The saved one first, then the tenant's
 * default environment.
 * @param {Ctx} ctx
 */
async function pickFlowEnvironment(ctx) {
  const { ui, config, api } = ctx;
  const saved = config.uploads.flowEnvironment;
  /** @type {import('../clients/dataverse.js').DataverseInstance[] | undefined} */
  let found;
  try {
    found = (await api.discovery.instances()).filter((i) => i.Url && (i.State ?? 0) === 0);
  } catch (err) {
    ui.warn(`Couldn't list your Power Platform environments (${/** @type {Error} */ (err).message}).`);
  }
  ui.note(FLOW_ENVIRONMENT_HINT);
  if (found?.length) {
    const defaultId = (await defaultEnvironmentId(ctx))?.toLowerCase();
    const isDefault = (/** @type {import('../clients/dataverse.js').DataverseInstance} */ i) => !!defaultId && i.EnvironmentId?.toLowerCase() === defaultId;
    const listed = found.map((i) => ({ i, url: orgUrl(i.Url) })).sort((a, b) => (a.i.FriendlyName ?? a.url).localeCompare(b.i.FriendlyName ?? b.url));
    const fallback = listed.find((l) => isDefault(l.i)) ?? listed[0];
    const url = await ui.select(
      'Which Power Platform environment should the flows go in?',
      listed.map(({ i, url }) => ({ name: `${i.FriendlyName ?? i.UniqueName ?? new URL(url).host} (${new URL(url).host})${isDefault(i) ? ', the default environment' : ''}`, value: url })),
      listed.some((l) => l.url === saved?.url) ? saved?.url : fallback.url,
    );
    const i = listed.find((l) => l.url === url)?.i;
    config.uploads.flowEnvironment = { url, ...(i?.EnvironmentId ? { id: i.EnvironmentId } : {}), ...(i?.FriendlyName ? { name: i.FriendlyName } : {}) };
    return;
  }
  const answer = await ui.input('The environment URL to create the flows in. Leave blank to write them to files to import instead.', {
    default: saved?.url ?? '',
    validate: validateUrl,
  });
  config.uploads.flowEnvironment = answer.trim() ? { url: orgUrl(answer.trim()), ...(saved?.url === orgUrl(answer.trim()) && saved.id ? { id: saved.id } : {}) } : undefined;
}

/**
 * The definitions this install would create.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} tenantId
 * @returns {Record<FlowKind, { name: string, description: string, definition: any }>}
 */
export function flowDefinitions(config, tenantId) {
  const identity = flowIdentity(config);
  /** @type {import('../transform/flows.js').FlowTarget} */
  const t = {
    identity,
    endpoint: oneLakeEndpoint(config.fabric.workspaceId ?? '', config.fabric.lakehouseId ?? ''),
    ...(identity === 'app' ? { tenantId, clientId: config.app.appId ?? '', secretName: config.keyVault.secretName } : {}),
  };
  const where = `${config.fabric.lakehouseName ?? 'the Lakehouse'} > ${UPLOAD_DIR}`;
  const schedule = { time: config.schedule.time, timeZone: config.schedule.timeZone };
  const inventoryWhere = `${config.fabric.lakehouseName ?? 'the Lakehouse'} > ${AGENT_INVENTORY_DIR}`;
  return {
    feedback: {
      name: FEEDBACK_FLOW_NAME,
      description: `Saves product feedback exports emailed with the subject "${FEEDBACK_SUBJECT}" to ${where}. Created by the Analytics Hub installer.`,
      definition: nameByConnection(feedbackFlowDefinition(t), t),
    },
    agents: {
      name: AGENT_INVENTORY_FLOW_NAME,
      description: `Saves the Power Platform inventory of Copilot Studio agents, environments and agent flows to ${inventoryWhere} each day, for when Azure Resource Graph won't return agents. The inventory API takes delegated sign-ins only, so its connection signs in as a Power Platform or Global Reader-type administrator. Created by the Analytics Hub installer.`,
      definition: nameByConnection(agentInventoryFlowDefinition(t, schedule, AGENT_INVENTORY_DIR), t),
    },
  };
}

/** @param {any} definition */
const signatureOf = (definition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);

/** @param {string[]} names */
const labels = (names) => names.map((n) => connectorLabel(n)).join('; ');

/** @param {string} name */
const connectorLabel = (name) => connectorByName(name)?.label ?? name;

/**
 * Creates the flows chosen, or brings them up to date. An update keeps the connections already
 * signed in to; when it adds one, the flow is turned off until the user signs in, and replaced
 * when Dataverse won't update it. A flow that can't be created is written to a file beside the
 * install record.
 * @param {Ctx} ctx
 */
export async function ensureFlows(ctx) {
  const { ui, config, api } = ctx;
  const kinds = flowsWanted(config);
  if (!kinds.length) return;
  const up = config.uploads;
  if (flowIdentity(config) === 'app') {
    try {
      await ensureWorkspaceRole(ctx, 'Contributor', 'so the Power Automate flows can write to the drop folder');
    } catch (err) {
      ui.warn(`Couldn't give ${config.app.displayName ?? 'the app'} Contributor on the workspace (${/** @type {Error} */ (err).message}). The flows can't save files until it has it.`);
    }
  }
  const defs = flowDefinitions(config, ctx.user.tenantId);
  const dv = up.flowEnvironment ? api.dataverse(up.flowEnvironment.url) : undefined;
  up.flowIds ??= {};
  up.flowSignatures ??= {};
  for (const kind of kinds) {
    const { name, description, definition } = defs[kind];
    const signature = signatureOf(definition);
    if (dv) {
      try {
        const id = up.flowIds[kind];
        const existing = id ? await dv.getFlow(id) : undefined;
        if (existing) {
          if (up.flowSignatures[kind] !== signature) {
            up.flowIds[kind] = await updateFlow(ctx, dv, existing, defs[kind]);
          } else ui.ok(`Flow ${existing.name} is in place`);
        } else {
          if (id) ui.warn(`The flow ${name} was deleted. Creating it again.`);
          up.flowIds[kind] = await dv.createFlow({ name, description, clientdata: flowClientData(definition) });
          ui.ok(`Created the flow ${name}, turned off until it is signed in to its connections`);
        }
        up.flowSignatures[kind] = signature;
        delete up.flowFiles?.[kind];
        ctx.save();
        continue;
      } catch (err) {
        ui.warn(`Couldn't create the flow ${name} in ${up.flowEnvironment?.name ?? up.flowEnvironment?.url} (${/** @type {Error} */ (err).message}).`);
      }
    }
    writeFlowFile(ctx, kind, name, definition);
  }
  const on = await connectFlows(ctx);
  // The steps for whatever is still off, here rather than only on the Done page.
  const off = kinds.filter((k) => up.flowIds?.[k] && !up.flowFiles?.[k] && !on.has(k) && !flowConnected(config, k));
  const env = up.flowEnvironment;
  const link = env?.id ? `${MAKER}environments/${env.id}/flows` : MAKER;
  for (const kind of off) {
    ui.info(`To finish ${c.bold(FLOW_NAMES[kind])} in Power Automate:`);
    flowSteps(ctx, kind, link);
  }
}

/**
 * Brings an existing flow up to date and returns its ID, which changes when it has to be replaced.
 * Every connection already signed in to is kept. Dataverse rejects an update that leaves any
 * connection unsigned (FlowMissingConnection), even on a flow that's off, though a create accepts
 * one. So a flow with nothing signed in to yet is replaced, and one that gains a connection is
 * turned off, then replaced if Dataverse turns the update down.
 * @param {Ctx} ctx
 * @param {import('../clients/dataverse.js').DataverseApi} dv
 * @param {{ workflowid: string, name: string, statecode: number, clientdata?: string }} existing
 * @param {{ name: string, description: string, definition: any }} def
 */
async function updateFlow(ctx, dv, existing, { name, description, definition }) {
  const { ui } = ctx;
  const current = connectionReferencesOf(existing.clientdata);
  const fresh = newConnections(definition, current);
  const wasOn = existing.statecode === 1;
  const replace = async () => {
    if (wasOn) await dv.turnOffFlow(existing.workflowid);
    await dv.deleteFlow(existing.workflowid);
    return dv.createFlow({ name, description, clientdata: flowClientData(definition) });
  };
  if (!fresh.length) {
    await dv.updateFlow(existing.workflowid, flowClientData(definition, current));
    ui.ok(`Updated the flow ${existing.name}, keeping its connections`);
    return existing.workflowid;
  }
  if (!Object.values(current).some(isBound)) {
    const id = await replace();
    ui.ok(`Replaced the flow ${name} with the new version, turned off until it is signed in to its connections`);
    return id;
  }
  if (wasOn) await dv.turnOffFlow(existing.workflowid);
  try {
    await dv.updateFlow(existing.workflowid, flowClientData(definition, current));
    ui.warn(`Updated the flow ${existing.name}${wasOn ? ' and turned it off' : ''}. Sign in to: ${labels(fresh)}. Then turn it on.`);
    return existing.workflowid;
  } catch (err) {
    if (!missingConnection(err)) throw err;
  }
  const id = await dv.deleteFlow(existing.workflowid).then(() => dv.createFlow({ name, description, clientdata: flowClientData(definition) }));
  ui.warn(`Dataverse won't update a flow with a connection still to sign in to, so ${name} was replaced. Sign in to all its connections again (your existing connections are still there to pick): ${labels(connectorsUsed(definition))}. Then turn it on.`);
  return id;
}

/** Dataverse's 400 for a flow update that leaves a connection unsigned. @param {unknown} err */
function missingConnection(err) {
  const e = /** @type {any} */ (err);
  return e?.status === 400 && /FlowMissingConnection|0x80060467/i.test(`${e.code ?? ''} ${e.message ?? ''}`);
}

/**
 * @param {Ctx} ctx
 * @param {FlowKind} kind
 * @param {string} name
 * @param {any} definition
 */
function writeFlowFile(ctx, kind, name, definition) {
  const { ui, config } = ctx;
  const file = join(ctx.configFile ? dirname(ctx.configFile) : process.cwd(), FLOW_FILES[kind]);
  const note = `Written by the Analytics Hub installer because the flow couldn't be created. In Power Automate, create an automated or scheduled cloud flow, open it in the code view (or use the Power Automate Management connector) and paste "definition". Then sign in to its connections: ${labels(connectorsUsed(definition))}.`;
  try {
    writeFileSync(file, `${JSON.stringify(flowFile(name, definition, note), null, 2)}\n`);
    config.uploads.flowFiles = { ...config.uploads.flowFiles, [kind]: file };
    ctx.save();
    ui.ok(`Wrote the flow ${name} to ${file}`);
  } catch (err) {
    ui.warn(`Couldn't write the flow ${name} (${/** @type {Error} */ (err).message}).`);
  }
}

/**
 * The names of the connections the installer makes. Cleaning up only ever deletes these.
 */
export const CONNECTION_NAMES = {
  ppApi: 'Analytics Hub - Power Platform API',
  oneLake: 'Analytics Hub - OneLake',
};
const OWNED_NAME = /^Analytics Hub - (Power Platform API|OneLake)$/;
/** Whether a connection's display name is one the installer gives. @param {string | undefined} name */
export const isOwnedConnectionName = (name) => OWNED_NAME.test(name ?? '');

/**
 * The name of the connection the installer makes for a connection reference, if it makes one.
 * @param {import('../config.js').InstallConfig} _config
 * @param {string} ref
 */
export function ownedConnectionName(_config, ref) {
  if (ref === CONNECTORS.entra.name) return CONNECTION_NAMES.ppApi;
  if (ref === CONNECTORS.storage.name) return CONNECTION_NAMES.oneLake;
  return undefined;
}

/** The connector both HTTP with Microsoft Entra ID references use. */
const WEBCONTENTS = CONNECTORS.entra.api;
/** How often, and how many times, to look at the connections after the user says they've signed in. */
export const CONNECT_POLL_MS = 5_000;
export const CONNECT_POLLS = 12;

/**
 * A connection the installer makes, with its URLs filled in.
 * @typedef {object} OwnedConnection
 * @property {string} ref  The connection reference it fills.
 * @property {string} displayName
 * @property {Record<string, string>} parameters  The connector's connection parameters.
 * @property {string} who  Who signs in to it.
 */

/**
 * The HTTP with Microsoft Entra ID connections these flows use, one per connection reference.
 * @param {Ctx} ctx
 * @param {FlowKind[]} kinds
 * @returns {OwnedConnection[]}
 */
export function ownedConnections(ctx, kinds) {
  const { config } = ctx;
  const defs = flowDefinitions(config, ctx.user.tenantId);
  const used = new Set(kinds.flatMap((k) => connectorsUsed(defs[k].definition)));
  /** @type {OwnedConnection[]} */
  const out = [];
  if (used.has(CONNECTORS.entra.name)) {
    out.push({
      ref: CONNECTORS.entra.name,
      displayName: CONNECTION_NAMES.ppApi,
      parameters: { baseResourceUrl: PPAPI, 'token:ResourceUri': PPAPI },
      who: 'a Power Platform administrator',
    });
  }
  const storageName = ownedConnectionName(config, CONNECTORS.storage.name);
  if (used.has(CONNECTORS.storage.name) && storageName) {
    out.push({
      ref: CONNECTORS.storage.name,
      displayName: storageName,
      parameters: { baseResourceUrl: ONELAKE_DFS, 'token:ResourceUri': STORAGE_RESOURCE },
      who: `someone with Contributor or higher on ${config.fabric.workspaceName ?? 'the workspace'}`,
    });
  }
  return out;
}

/** Whether the signed-in user made the connection. @param {Ctx} ctx @param {import('../clients/connections.js').Connection} c */
const madeByMe = (ctx, c) => !!ctx.user.id && c.properties?.createdBy?.id?.toLowerCase() === ctx.user.id.toLowerCase();

/** Whether a connection points at the same place. Rows without their parameters match on name alone. @param {import('../clients/connections.js').Connection} c @param {OwnedConnection} want */
const sameTarget = (c, want) => {
  const url = c.properties?.connectionParameters?.baseResourceUrl;
  return typeof url !== 'string' || url.replace(/\/+$/, '') === want.parameters.baseResourceUrl;
};

/**
 * Signs the flows in for the user. Makes each HTTP with Microsoft Entra ID connection a flow needs,
 * with its URLs filled in and a name the installer owns, and gives one sign-in link for each. Once
 * they're signed in to, points each flow at them and turns it on, so the flows can run before
 * the first load. Connections the installer made before and nobody signed in to are deleted.
 * Never throws: whatever it can't do is left to the steps.
 * @param {Ctx} ctx
 * @returns {Promise<Set<FlowKind>>}  The flows that are on.
 */
export async function connectFlows(ctx) {
  const { ui, config, api } = ctx;
  const up = config.uploads;
  /** @type {Set<FlowKind>} */
  const on = new Set();
  const connections = api.connections;
  const kinds = flowsWanted(config).filter((k) => up.flowIds?.[k] && !up.flowFiles?.[k]);
  if (!connections || !kinds.length || !up.flowEnvironment) return on;
  try {
    const env = await flowEnvironmentId(ctx);
    if (!env) return on;
    /** @type {Partial<Record<FlowKind, Awaited<ReturnType<typeof api.flow.getFlowDetails>>>>} */
    const flows = {};
    /** @type {Awaited<ReturnType<typeof api.flow.getFlowDetails>>[]} */
    const details = [];
    for (const kind of kinds) {
      const flow = await api.flow.getFlowDetails(env, /** @type {string} */ (up.flowIds?.[kind]));
      details.push(flow);
      if (flow?.properties?.state === 'Started') {
        on.add(kind);
        up.flowsConnected = { ...up.flowsConnected, [kind]: /** @type {string} */ (up.flowIds?.[kind]) };
      } else {
        flows[kind] = flow;
        if (up.flowsConnected?.[kind]) delete up.flowsConnected[kind];
      }
    }
    const pending = kinds.filter((k) => !on.has(k));
    ctx.save();
    const wanted = ownedConnections(ctx, pending);
    if (!pending.length || !wanted.length) return on;

    ui.heading('Flow connections');
    const page = `${MAKER}environments/${env}/connections`;
    const existing = await connections.list(env, WEBCONTENTS);
    /** @type {Map<string, import('../clients/connections.js').Connection>} */
    const chosen = new Map();
    for (const want of wanted) {
      const same = existing.filter((c) => c.properties?.displayName === want.displayName && sameTarget(c, want));
      const saved = up.flowConnections?.[want.ref];
      const found =
        same.find((c) => isConnected(c) && madeByMe(ctx, c)) ??
        same.find(isConnected) ??
        same.find((c) => c.name === saved) ??
        same.find((c) => madeByMe(ctx, c));
      if (found) {
        chosen.set(want.ref, found);
        continue;
      }
      chosen.set(want.ref, await connections.create(env, WEBCONTENTS, { displayName: want.displayName, parameters: want.parameters }));
      ui.ok(`Created the connection ${want.displayName}, with its URLs filled in`);
    }
    up.flowConnections = { ...up.flowConnections, ...Object.fromEntries([...chosen].map(([ref, c]) => [ref, c.name])) };
    ctx.save();

    const left = () => wanted.filter((w) => !isConnected(chosen.get(w.ref)));
    if (left().length) {
      await showSignIns(ctx, env, left(), chosen, page);
      if (!ui.yes) await waitForSignIns(ctx, env, wanted, chosen);
    }
    if (!left().length) ui.ok('The flow connections are signed in to');

    const defs = flowDefinitions(config, ctx.user.tenantId);
    const owned = new Set(wanted.map((w) => w.ref));
    const byName = new Map(existing.map((conn) => [conn.name, conn]));
    for (const conn of chosen.values()) byName.set(conn.name, conn);
    let waiting = false;
    for (const kind of pending) {
      const id = /** @type {string} */ (up.flowIds?.[kind]);
      const flow = flows[kind];
      const definition = flow?.properties?.definition ?? defs[kind].definition;
      const current = flow?.properties?.connectionReferences ?? {};
      /** @type {Record<string, any>} */
      const refs = {};
      const missing = [];
      for (const ref of connectorsUsed(definition)) {
        const conn = chosen.get(ref);
        const bound = current[ref]?.connectionName;
        const boundOk = typeof bound === 'string' && bound !== '' && (owned.has(ref) ? isConnected(byName.get(bound)) : true);
        if (boundOk) refs[ref] = current[ref];
        else if (conn && isConnected(conn)) refs[ref] = { connectionName: conn.name, source: 'Embedded', id: `/providers/Microsoft.PowerApps/apis/${WEBCONTENTS}`, tier: 'NotSpecified' };
        else missing.push(ref);
      }
      if (missing.length) {
        const others = missing.filter((ref) => !owned.has(ref));
        if (others.length) ui.info(`${FLOW_NAMES[kind]} also needs ${labels(others)}, which only Power Automate can sign in to. Its steps below say how.`);
        else waiting = true;
        continue;
      }
      try {
        await api.flow.setConnections(env, id, { displayName: flow?.properties?.displayName ?? FLOW_NAMES[kind], definition, connectionReferences: refs });
        await api.flow.start(env, id);
        up.flowsConnected = { ...up.flowsConnected, [kind]: id };
        ctx.save();
        on.add(kind);
        ui.ok(`Pointed ${FLOW_NAMES[kind]} at its connections and turned it on`);
      } catch (err) {
        ui.warn(`Couldn't turn on ${FLOW_NAMES[kind]} (${/** @type {Error} */ (err).message}). Its steps below say how to do it in Power Automate.`);
      }
    }
    if (waiting) ui.note(`When the connections are signed in to, run "${commandLine('update')}" to point the flows at them and turn them on. Or follow the steps below.`);
    await tidyConnections(ctx, env, new Set([...chosen.values()].map((conn) => conn.name).concat(boundTo(Object.values(details)))), page);
  } catch (err) {
    ui.warn(`Couldn't set up the flow connections (${/** @type {Error} */ (err).message}). Sign in to them in Power Automate instead; the steps below say how.`);
  }
  return on;
}

/** The connections the flows already use. @param {any[]} flows @returns {string[]} */
const boundTo = (flows) =>
  flows.flatMap((f) => Object.values(f?.properties?.connectionReferences ?? {}).map((r) => r?.connectionName).filter((n) => typeof n === 'string' && n));

/**
 * One sign-in link for each connection, and who signs in.
 * @param {Ctx} ctx
 * @param {string} env
 * @param {OwnedConnection[]} wanted
 * @param {Map<string, import('../clients/connections.js').Connection>} chosen
 * @param {string} page  The environment's Connections page.
 */
async function showSignIns(ctx, env, wanted, chosen, page) {
  const { ui, api } = ctx;
  const connections = /** @type {import('../clients/connections.js').ConnectionsApi} */ (api.connections);
  ui.info('Sign in to each connection: open its link and sign in as the person shown. Each is one click.');
  let n = 1;
  for (const want of wanted) {
    const conn = /** @type {import('../clients/connections.js').Connection} */ (chosen.get(want.ref));
    /** @type {string | undefined} */
    let link;
    try {
      link = await connections.consentLink(env, WEBCONTENTS, conn.name, page);
    } catch {
      // The Connections page does the same.
    }
    ui.info(`  ${n++}. ${c.bold(want.displayName)}: sign in as ${want.who}.`);
    ui.info(`     ${link ?? `${page} (find "${want.displayName}" and click Fix connection)`}`);
  }
  ui.note('  If a link opens nothing, your browser blocked the pop-up: allow pop-ups for make.powerautomate.com and login.microsoftonline.com, then open it again.');
  ui.note(`  If a link has expired, open ${page}, find the connection by its name and click Fix connection.`);
  ui.note('  HTTP with Microsoft Entra ID (preauthorized) is a Premium connector: whoever signs in, and you as the flows\' owner, need a Power Automate Premium licence.');
}

/**
 * Asks the user to sign in, then looks at the connections until they're signed in to, or the user
 * leaves it for later. Updates `chosen` as they change.
 * @param {Ctx} ctx
 * @param {string} env
 * @param {OwnedConnection[]} wanted
 * @param {Map<string, import('../clients/connections.js').Connection>} chosen
 * @returns {Promise<boolean>}  Whether they're all signed in to.
 */
async function waitForSignIns(ctx, env, wanted, chosen) {
  const { ui, api } = ctx;
  const connections = /** @type {import('../clients/connections.js').ConnectionsApi} */ (api.connections);
  const left = () => wanted.filter((w) => !isConnected(chosen.get(w.ref)));
  for (;;) {
    const choice = await ui.select(
      'Signed in to the connections?',
      [
        { name: "I've signed in, check now", value: 'check' },
        { name: 'Do this later', value: 'later' },
      ],
      'check',
    );
    if (choice === 'later') return false;
    const progress = ui.progress('Flow connections');
    try {
      for (let i = 0; i < CONNECT_POLLS; i++) {
        for (const w of left()) {
          const conn = /** @type {import('../clients/connections.js').Connection} */ (chosen.get(w.ref));
          chosen.set(w.ref, (await connections.get(env, WEBCONTENTS, conn.name)) ?? conn);
        }
        if (!left().length) return true;
        progress.update(`Waiting for ${left().map((w) => w.displayName).join(', ')}`);
        await ctx.sleep(CONNECT_POLL_MS);
      }
    } finally {
      progress.done();
    }
    ui.warn(`Not signed in to yet: ${left().map((w) => w.displayName).join(', ')}. Use the links above, then check again.`);
  }
}

/**
 * Deletes the connections the installer made that nobody signed in to and nothing uses, so they
 * don't pile up. Lists the user's other HTTP with Microsoft Entra ID connections that aren't signed
 * in to, but never deletes them.
 * @param {Ctx} ctx
 * @param {string} env
 * @param {Set<string>} keep  Connections in use, or just made.
 * @param {string} page
 */
async function tidyConnections(ctx, env, keep, page) {
  const { ui, api } = ctx;
  const connections = /** @type {import('../clients/connections.js').ConnectionsApi} */ (api.connections);
  const stale = (await connections.list(env, WEBCONTENTS)).filter((conn) => !isConnected(conn) && !keep.has(conn.name) && madeByMe(ctx, conn));
  const ours = stale.filter((conn) => isOwnedConnectionName(conn.properties?.displayName));
  let removed = 0;
  for (const conn of ours) {
    try {
      await connections.remove(env, WEBCONTENTS, conn.name);
      removed++;
    } catch {
      // Left for next time.
    }
  }
  if (removed) ui.ok(`Deleted ${removed} connection${removed === 1 ? '' : 's'} the installer made before that nobody signed in to`);
  const others = stale.filter((conn) => !ours.includes(conn));
  if (others.length) {
    ui.note(`You have ${others.length} other HTTP with Microsoft Entra ID connection${others.length === 1 ? '' : 's'} that ${others.length === 1 ? "isn't" : "aren't"} signed in to. The installer leaves ${others.length === 1 ? 'it' : 'them'} alone; delete any you don't need at ${page}:`);
    for (const conn of others.slice(0, 10)) ui.note(`  ${conn.properties?.displayName ?? conn.name}`);
    if (others.length > 10) ui.note(`  and ${others.length - 10} more`);
  }
}

/**
 * The connection sign-ins a flow needs, one line each.
 * @param {import('../config.js').InstallConfig} config
 * @param {FlowKind} kind
 */
export function connectionSteps(config, kind) {
  const workspace = config.fabric.workspaceName ?? 'the workspace';
  const made = config.uploads.flowConnections ?? {};
  const orPick = (/** @type {string} */ ref) => {
    const name = ownedConnectionName(config, ref);
    return made[ref] && name ? ` Or pick the connection "${name}" the installer made, once it's signed in to.` : '';
  };
  const storage =
    (flowIdentity(config) === 'app'
      ? `${CONNECTORS.keyVault.label}: vault ${config.keyVault.name ?? 'your Key Vault'}.`
      : `${CONNECTORS.storage.label}: Base Resource URL ${ONELAKE_DFS}, Resource URI ${STORAGE_RESOURCE}. Sign in as someone with Contributor or higher on ${workspace}. Its actions end in "via OneLake".`) +
    (flowIdentity(config) === 'app' ? '' : orPick(CONNECTORS.storage.name));
  if (kind === 'feedback') return [`${CONNECTORS.outlook.label}: sign in as the mailbox the export is emailed to.`, storage];
  const ppApi = `${CONNECTORS.entra.label}: Base Resource URL and Resource URI ${PPAPI}.`;
  const ppActions = `Its actions end in "via Power Platform API".${orPick(CONNECTORS.entra.name)}`;
  return [`${ppApi} Sign in as a Power Platform administrator, or an admin with Global Reader: the inventory API takes delegated sign-ins only. ${ppActions}`, storage];
}

/** The Microsoft 365 admin center page for product feedback (Health > Product feedback), where the export is scheduled. */
export const FEEDBACK_EXPORT_URL = 'https://admin.microsoft.com/Adminportal/Home#/tenantfeedback';
const feedbackExportStep = `Schedule the product feedback export to that mailbox, subject "${FEEDBACK_SUBJECT}": ${FEEDBACK_EXPORT_URL} (Microsoft 365 admin center > Health > Product feedback).`;

/**
 * Whether the installer signed the flow in and turned it on, and it hasn't been replaced since.
 * @param {import('../config.js').InstallConfig} config
 * @param {FlowKind} kind
 */
const flowConnected = (config, kind) => !!config.uploads.flowIds?.[kind] && config.uploads.flowsConnected?.[kind] === config.uploads.flowIds[kind];

/**
 * The numbered steps to sign a flow in and turn it on by hand.
 * @param {Ctx} ctx
 * @param {FlowKind} kind
 * @param {string} link  The flows page.
 */
function flowSteps(ctx, kind, link) {
  const { ui, config } = ctx;
  let n = 1;
  ui.info(`  ${n++}. Open it: ${link}`);
  ui.info(`  ${n++}. Allow pop-ups for make.powerautomate.com: each sign-in opens one. Sign in on the first action for each connection below, then pick that connection on its other actions.`);
  for (const step of connectionSteps(config, kind)) ui.info(`  ${n++}. ${step}`);
  ui.info(`  ${n++}. Save, then turn it on.`);
  if (kind === 'feedback') ui.info(`  ${n++}. ${feedbackExportStep}`);
  else ui.note('     It runs daily, an hour before the pipeline. The collector reads its newest file only when Azure Resource Graph returns no agents.');
}

/**
 * What's left to do for each flow, as short numbered steps.
 * @param {Ctx} ctx
 */
export function flowsSummary(ctx) {
  const { ui, config } = ctx;
  const kinds = flowsWanted(config);
  if (!kinds.length) return;
  const up = config.uploads;
  const env = up.flowEnvironment;
  const link = env?.id ? `${MAKER}environments/${env.id}/flows` : MAKER;
  ui.heading('Power Automate flows');
  for (const kind of kinds) {
    const name = FLOW_NAMES[kind];
    const file = up.flowFiles?.[kind];
    if (up.flowIds?.[kind] && !file && flowConnected(config, kind)) {
      ui.info(c.bold(name) + c.dim(`  in ${env?.name ?? env?.url}, signed in and on`));
      if (kind === 'feedback') ui.info(`  1. ${feedbackExportStep}`);
      continue;
    }
    if (up.flowIds?.[kind] && !file) ui.info(c.bold(name) + c.dim(`  in ${env?.name ?? env?.url}, turned off`));
    else if (file) ui.info(c.bold(name) + c.dim(`  to import: ${file}`));
    else continue;
    flowSteps(ctx, kind, link);
  }
  ui.note('  Tip: sign in with a dedicated admin account and add a co-owner, so the flows outlive any one person.');
  if (flowIdentity(config) === 'app' && config.keyVault.private) {
    ui.warn(`${config.keyVault.name ?? 'The Key Vault'} blocks public network access, which the Key Vault connector needs. Run install --flow-identity user so the flows sign in to OneLake instead.`);
  }
}

/**
 * The flow environment's ID, which Power Automate uses rather than the org URL. Looked up and saved
 * when an older record only has the URL.
 * @param {Ctx} ctx
 */
async function flowEnvironmentId(ctx) {
  const env = ctx.config.uploads.flowEnvironment;
  if (!env) return undefined;
  if (env.id) return env.id;
  const found = (await ctx.api.discovery.instances()).find((i) => i.Url && orgUrl(i.Url) === orgUrl(env.url));
  if (!found?.EnvironmentId) return undefined;
  env.id = found.EnvironmentId;
  ctx.save();
  return env.id;
}
