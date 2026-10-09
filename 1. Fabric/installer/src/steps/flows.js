// @ts-check
/**
 * The Power Automate flows: product feedback exports emailed to the admin, and Copilot Studio
 * credits from the Power Platform licensing API. The installer creates each flow, turned off, in a
 * Power Platform environment the user picks; the user signs in to its connections and turns it on.
 * When a flow can't be created, it is written to a file to import instead.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { orgUrl } from '../clients/dataverse.js';
import { flowIdentity, secretMode } from '../config.js';
import { commandLine } from '../launch.js';
import {
  BACKFILL_MARKER,
  connectionReferencesOf,
  connectorByName,
  connectorsUsed,
  CONNECTORS,
  FEEDBACK_FLOW_NAME,
  FEEDBACK_SUBJECT,
  feedbackFlowDefinition,
  flowClientData,
  FLOW_STATE_DIR,
  flowFile,
  isBound,
  newConnections,
  ONELAKE_DFS,
  oneLakeEndpoint,
  PPAPI,
  STORAGE_RESOURCE,
  STUDIO_FLOW_NAME,
  studioFlowDefinition,
} from '../transform/flows.js';
import { c } from '../ui.js';
import { UPLOAD_DIR } from '../uploads.js';
import { ensureWorkspaceRole } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {'feedback' | 'studio'} FlowKind */

const MAKER = 'https://make.powerautomate.com/';
export const FLOW_FILES = /** @type {Record<FlowKind, string>} */ ({
  feedback: 'analytics-hub-feedback-flow.json',
  studio: 'analytics-hub-studio-credits-flow.json',
});

/** @param {import('../config.js').InstallConfig} config @returns {FlowKind[]} */
const flowsChosen = (config) => [
  ...(config.target !== 'azure' && config.dataSources.productFeedback === 'api' ? /** @type {const} */ (['feedback']) : []),
  ...(config.dataSources.studioCredits === 'api' ? /** @type {const} */ (['studio']) : []),
];

/** The ADLS container an Azure install's flows and uploads land in. */
export const AZURE_LANDING = 'landing';
/** Folders under the Azure landing place: what the jobs read, and the flow's own state, which they don't. */
export const AZURE_LANDING_DIRS = /** @type {const} */ ({ studio: 'studio', viva: 'viva', flows: 'flows' });

/**
 * The credit files go to a SharePoint folder rather than the landing container. The plan sets the folder
 * only with private networking, where Power Automate can't reach the storage account.
 * @param {import('../config.js').AzureConfig | undefined} az
 */
export const azureDropsToSharePoint = (az) => !!az?.drop?.siteId;

/**
 * Where an Azure install's flows write: the landing container through a signed-in storage connection,
 * or, when storage takes no public traffic, the SharePoint drop folder.
 * @param {import('../config.js').AzureConfig | undefined} az
 * @returns {import('../transform/flows.js').FlowTarget}
 */
export function azureFlowTarget(az) {
  const dirs = { dropDir: AZURE_LANDING_DIRS.studio, stateDir: AZURE_LANDING_DIRS.flows };
  if (azureDropsToSharePoint(az)) {
    return { identity: 'user', endpoint: '', sharePoint: { siteUrl: az?.drop?.siteUrl ?? '', folder: az?.drop?.sitePath ?? '' }, ...dirs };
  }
  return { identity: 'user', endpoint: `https://${az?.outputs?.storageAccountName ?? 'storage'}.dfs.core.windows.net/${AZURE_LANDING}`, ...dirs };
}

/**
 * Where an Azure install's Studio flow saves, for people.
 * @param {import('../config.js').AzureConfig | undefined} az
 */
export function azureDropLabel(az) {
  if (azureDropsToSharePoint(az)) return az?.drop?.folderUrl ? `${az.drop.folderUrl.replace(/\/+$/, '')}/${AZURE_LANDING_DIRS.studio}` : 'the SharePoint drop folder';
  return `${az?.outputs?.storageAccountName ?? 'the storage account'} > ${AZURE_LANDING}/${AZURE_LANDING_DIRS.studio}`;
}

/** The app identity reads its secret from Key Vault, which notebook mode doesn't use. @param {import('../config.js').InstallConfig} config */
const appWithoutVault = (config) => flowIdentity(config) === 'app' && secretMode(config) === 'notebook';

/** @param {import('../config.js').InstallConfig} config @returns {FlowKind[]} */
export const flowsWanted = (config) => (appWithoutVault(config) ? [] : flowsChosen(config));

/**
 * Flows the user asked for that can't be made: the app identity with the secret in the notebooks.
 * @param {import('../config.js').InstallConfig} config
 */
export const flowsSkipped = (config) => (appWithoutVault(config) ? flowsChosen(config).map((k) => (k === 'feedback' ? FEEDBACK_FLOW_NAME : STUDIO_FLOW_NAME)) : []);

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
 * "Power Automate (emailed export)" and Studio credits' "Connected (Power Automate flow)".
 * @param {Ctx} ctx
 */
export async function planFlows(ctx) {
  if (flowsWanted(ctx.config).length) await pickFlowEnvironment(ctx);
}

/**
 * Picks the Power Platform environment the flows go in.
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
  if (found?.length) {
    const listed = found.map((i) => ({ i, url: orgUrl(i.Url) })).sort((a, b) => (a.i.FriendlyName ?? a.url).localeCompare(b.i.FriendlyName ?? b.url));
    const url = await ui.select(
      'Which Power Platform environment should the flows go in?',
      listed.map(({ i, url }) => ({ name: `${i.FriendlyName ?? i.UniqueName ?? new URL(url).host} (${new URL(url).host})`, value: url })),
      listed.some((l) => l.url === saved?.url) ? saved?.url : listed[0].url,
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
  const azure = config.target === 'azure';
  /** @type {import('../transform/flows.js').FlowTarget} */
  const t = azure
    ? azureFlowTarget(config.azure)
    : {
        identity,
        endpoint: oneLakeEndpoint(config.fabric.workspaceId ?? '', config.fabric.lakehouseId ?? ''),
        ...(identity === 'app' ? { tenantId, clientId: config.app.appId ?? '', secretName: config.keyVault.secretName } : {}),
      };
  const where = azure ? azureDropLabel(config.azure) : `${config.fabric.lakehouseName ?? 'the Lakehouse'} > ${UPLOAD_DIR}`;
  return {
    feedback: {
      name: FEEDBACK_FLOW_NAME,
      description: `Saves product feedback exports emailed with the subject "${FEEDBACK_SUBJECT}" to ${where}. Created by the Analytics Hub installer.`,
      definition: feedbackFlowDefinition(t),
    },
    studio: {
      name: STUDIO_FLOW_NAME,
      description: `Saves Copilot Studio credits from the Power Platform licensing API to ${where} each day. Created by the Analytics Hub installer.`,
      definition: studioFlowDefinition(t, { time: config.schedule.time, timeZone: config.schedule.timeZone }),
    },
  };
}

/** @param {any} definition */
const signatureOf = (definition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);

/** @param {string[]} names @param {import('../config.js').InstallConfig} [config] */
const labels = (names, config) => names.map((n) => connectorLabel(n, config)).join('; ');

/** @param {string} name @param {import('../config.js').InstallConfig} [config] */
const connectorLabel = (name, config) => {
  const label = connectorByName(name)?.label ?? name;
  return config?.target === 'azure' && name === CONNECTORS.storage.name ? label.replace('for OneLake', 'for Azure Storage') : label;
};

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
          ui.ok(`Created the flow ${name}, turned off until you sign in to its connections`);
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
  const { ui, config } = ctx;
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
    ui.ok(`Replaced the flow ${name} with the new version, turned off until you sign in to its connections`);
    return id;
  }
  if (wasOn) await dv.turnOffFlow(existing.workflowid);
  try {
    await dv.updateFlow(existing.workflowid, flowClientData(definition, current));
    ui.warn(`Updated the flow ${existing.name}${wasOn ? ' and turned it off' : ''}. Sign in to: ${labels(fresh, config)}. Then turn it on.`);
    return existing.workflowid;
  } catch (err) {
    if (!missingConnection(err)) throw err;
  }
  const id = await dv.deleteFlow(existing.workflowid).then(() => dv.createFlow({ name, description, clientdata: flowClientData(definition) }));
  ui.warn(`Dataverse won't update a flow with a connection still to sign in to, so ${name} was replaced. Sign in to all its connections again (your existing connections are still there to pick): ${labels(connectorsUsed(definition), config)}. Then turn it on.`);
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
  const note = `Written by the Analytics Hub installer because the flow couldn't be created. In Power Automate, create an automated or scheduled cloud flow, open it in the code view (or use the Power Automate Management connector) and paste "definition". Then sign in to its connections: ${labels(connectorsUsed(definition), config)}.`;
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
 * The connection sign-ins a flow needs, one line each.
 * @param {import('../config.js').InstallConfig} config
 * @param {FlowKind} kind
 */
export function connectionSteps(config, kind) {
  const workspace = config.fabric.workspaceName ?? 'the workspace';
  const storage =
    config.target === 'azure'
      ? azureStorageStep(config.azure)
      : flowIdentity(config) === 'app'
        ? `${CONNECTORS.keyVault.label}: vault ${config.keyVault.name ?? 'your Key Vault'}.`
        : `${CONNECTORS.storage.label}: Base Resource URL ${ONELAKE_DFS}, Resource URI ${STORAGE_RESOURCE}. Sign in as someone with Contributor or higher on ${workspace}.`;
  return kind === 'feedback'
    ? [`${CONNECTORS.outlook.label}: sign in as the mailbox the export is emailed to.`, storage]
    : [`${CONNECTORS.entra.label}: Base Resource URL and Resource URI ${PPAPI}. Sign in as a Power Platform, Billing or Global administrator.`, storage];
}

/**
 * The storage sign-in for an Azure install's flow.
 * @param {import('../config.js').AzureConfig | undefined} az
 */
function azureStorageStep(az) {
  if (azureDropsToSharePoint(az)) {
    return `${CONNECTORS.sharePoint.label}: sign in as someone who can add files to ${az?.drop?.folderUrl ?? 'the drop folder'}.`;
  }
  const account = az?.outputs?.storageAccountName ?? '<storage account>';
  return `${connectorLabel(CONNECTORS.storage.name, /** @type {any} */ ({ target: 'azure' }))}: Base Resource URL https://${account}.dfs.core.windows.net, Resource URI ${STORAGE_RESOURCE}. Sign in as someone with Storage Blob Data Contributor on ${account} (the installer gave it to you).`;
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
    const name = kind === 'feedback' ? FEEDBACK_FLOW_NAME : STUDIO_FLOW_NAME;
    const file = up.flowFiles?.[kind];
    if (up.flowIds?.[kind] && !file) ui.info(c.bold(name) + c.dim(`  in ${env?.name ?? env?.url}, turned off`));
    else if (file) ui.info(c.bold(name) + c.dim(`  to import: ${file}`));
    else continue;
    let n = 1;
    ui.info(`  ${n++}. Open it: ${link}`);
    for (const step of connectionSteps(config, kind)) ui.info(`  ${n++}. ${step}`);
    ui.info(`  ${n++}. Save, then turn it on.`);
    if (kind === 'feedback') ui.info(`  ${n++}. In the Microsoft 365 admin center, schedule the product feedback export to that mailbox, subject "${FEEDBACK_SUBJECT}".`);
    else {
      ui.info(`  ${n++}. To load about six months now rather than at its first daily run, click Run. Or use "${commandLine('run')}", which offers to run it before the pipeline.`);
      ui.note('     After that it runs daily, an hour before the pipeline.');
    }
  }
  ui.note('  Tip: sign in with a dedicated admin account and add a co-owner, so the flows outlive any one person.');
  if (flowIdentity(config) === 'app' && config.keyVault.private) {
    ui.warn(`${config.keyVault.name ?? 'The Key Vault'} blocks public network access, which the Key Vault connector needs. Run install --flow-identity user so the flows sign in to OneLake instead.`);
  }
}

/** How often, and how many times, to check on a Studio flow run before carrying on without it. */
export const STUDIO_RUN_POLL_MS = 30_000;
export const STUDIO_RUN_POLLS = 120;
const RUN_ACTIVE = new Set(['Running', 'Waiting']);

/**
 * The Studio credits flow loads about six months on its first run, which is otherwise the next
 * daily one. When the flow is on and hasn't done that yet, offers to run it now as the signed-in
 * user, and to wait so the pipeline that follows picks up its files. When it's off, says how to.
 * Never throws: anything that goes wrong ends in the steps to do it by hand.
 * @param {Ctx} ctx
 * @param {{ pipelineNext?: boolean, quietWhenOff?: boolean }} [opts]
 *   pipelineNext: the pipeline runs straight after, so waiting is the default.
 *   quietWhenOff: say nothing when the flow is off (the flows summary covers it).
 * @returns {Promise<'ran' | 'started' | 'off' | 'done' | 'skipped' | 'failed'>}
 */
export async function offerStudioRun(ctx, opts = {}) {
  const { ui, config } = ctx;
  const up = config.uploads;
  const id = up.flowIds?.studio;
  if (!flowsWanted(config).includes('studio') || !id || up.flowFiles?.studio || !up.flowEnvironment) return 'skipped';
  const steps = (/** @type {string} */ why) => {
    const link = up.flowEnvironment?.id ? `${MAKER}environments/${up.flowEnvironment.id}/flows` : MAKER;
    ui.info(`${why ? `${why} ` : ''}To load about six months of Copilot Studio credits now:`);
    ui.info(`  1. Open ${link} and open ${STUDIO_FLOW_NAME}.`);
    ui.info('  2. If it is off, sign in to its connections, save, and turn it on.');
    ui.info('  3. Click Run. Otherwise it loads them at its next daily run, an hour before the pipeline.');
  };
  try {
    const env = await flowEnvironmentId(ctx);
    if (!env) {
      steps("Couldn't find the Power Platform environment's ID.");
      return 'failed';
    }
    const flow = await ctx.api.flow.getFlow(env, id);
    const state = flow?.properties?.state;
    if (state && state !== 'Started') {
      if (!opts.quietWhenOff) steps(`${STUDIO_FLOW_NAME} is ${state === 'Suspended' ? 'suspended' : 'off'}.`);
      return 'off';
    }
    if (await backfillDone(ctx, env, id)) return 'done';
    const running = (await ctx.api.flow.listRuns(env, id)).find((r) => RUN_ACTIVE.has(r.properties?.status ?? ''));
    if (running) {
      if (!opts.pipelineNext || ui.yes || !(await ui.confirm(`${STUDIO_FLOW_NAME} is running now. Wait for it before starting the pipeline?`, true))) return 'started';
      return await waitForStudioRun(ctx, env, id, running.name);
    }
    if (ui.yes) {
      ui.note(`${STUDIO_FLOW_NAME} hasn't loaded its first six months yet. Run it in Power Automate, or run this without --yes to be offered it.`);
      return 'skipped';
    }
    const choice = await ui.select(
      `${STUDIO_FLOW_NAME} hasn't loaded its first six months of Copilot Studio credits yet. Run it now?`,
      [
        { name: `Run it now and wait${opts.pipelineNext ? ', so the pipeline picks up its files (recommended)' : ''}`, value: 'wait' },
        { name: "Run it now, don't wait", value: 'start' },
        { name: 'Not now (it runs at its next daily run)', value: 'no' },
      ],
      opts.pipelineNext ? 'wait' : 'start',
    );
    if (choice === 'no') return 'skipped';
    const before = new Set((await ctx.api.flow.listRuns(env, id)).map((r) => r.name));
    await ctx.api.flow.runTrigger(env, id, 'Daily');
    ui.ok(`Started ${STUDIO_FLOW_NAME}`);
    if (choice !== 'wait') return 'started';
    return await waitForStudioRun(ctx, env, id, undefined, before);
  } catch (err) {
    const e = /** @type {any} */ (err);
    ui.warn(/CannotRunUnpublishedSolutionFlow/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`)
      ? `${STUDIO_FLOW_NAME} can't run until it is turned on.`
      : `Couldn't run ${STUDIO_FLOW_NAME} (${e?.message ?? err}).`);
    steps('');
    return 'failed';
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

/**
 * Whether the flow has loaded its six months. On Fabric its marker file says so; on Azure, or if
 * OneLake can't be read, any run that succeeded.
 * @param {Ctx} ctx
 * @param {string} env
 * @param {string} id
 */
async function backfillDone(ctx, env, id) {
  const { config, api } = ctx;
  if (config.target !== 'azure' && config.fabric.workspaceId && config.fabric.lakehouseId) {
    try {
      return await api.oneLake.exists(config.fabric.workspaceId, config.fabric.lakehouseId, `${FLOW_STATE_DIR}/${BACKFILL_MARKER}`);
    } catch {
      // Fall back to the run history.
    }
  }
  return (await api.flow.listRuns(env, id)).some((r) => r.properties?.status === 'Succeeded');
}

/**
 * Waits for a Studio flow run: the named one, or the first not in `before`.
 * @param {Ctx} ctx
 * @param {string} env
 * @param {string} id
 * @param {string} [name]
 * @param {Set<string>} [before]
 * @returns {Promise<'ran' | 'started' | 'failed'>}
 */
async function waitForStudioRun(ctx, env, id, name, before) {
  const { ui } = ctx;
  const progress = ui.progress(STUDIO_FLOW_NAME);
  /** @type {import('../clients/flow.js').FlowRun | undefined} */
  let found;
  try {
    for (let i = 0; i < STUDIO_RUN_POLLS; i++) {
      const runs = await ctx.api.flow.listRuns(env, id);
      found = runs.find((r) => (name ? r.name === name : !before?.has(r.name))) ?? found;
      const status = found?.properties?.status;
      progress.update(status ?? 'Starting');
      if (status && !RUN_ACTIVE.has(status)) break;
      await ctx.sleep(STUDIO_RUN_POLL_MS);
    }
  } finally {
    progress.done();
  }
  const status = found?.properties?.status;
  if (status === 'Succeeded') {
    ui.ok(`${STUDIO_FLOW_NAME} loaded its first six months`);
    return 'ran';
  }
  if (!status || RUN_ACTIVE.has(status)) {
    ui.warn(`${STUDIO_FLOW_NAME} is still running. Carrying on; the next pipeline run picks up whatever it hasn't saved yet.`);
    return 'started';
  }
  ui.warn(`${STUDIO_FLOW_NAME} ${status.toLowerCase()}${found?.properties?.error?.message ? `: ${found.properties.error.message}` : ''}. Open its run history in Power Automate to see why.`);
  return 'failed';
}