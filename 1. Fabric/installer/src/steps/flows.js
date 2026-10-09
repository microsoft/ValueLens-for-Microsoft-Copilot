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
import {
  connectionReferencesOf,
  connectorByName,
  connectorsUsed,
  CONNECTORS,
  FEEDBACK_FLOW_NAME,
  FEEDBACK_SUBJECT,
  feedbackFlowDefinition,
  flowClientData,
  flowFile,
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
  ...(config.uploads.feedbackFlow && config.dataSources.productFeedback === 'csv' ? /** @type {const} */ (['feedback']) : []),
  ...(config.dataSources.studioCredits === 'api' ? /** @type {const} */ (['studio']) : []),
];

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
 * Asks about the feedback flow, and where to create the flows. The Studio flow comes with the
 * Studio credits api mode.
 * @param {Ctx} ctx
 */
export async function planFlows(ctx) {
  const { ui, config } = ctx;
  const up = config.uploads;
  if (config.dataSources.productFeedback === 'csv') {
    up.feedbackFlow = await ui.confirm(
      `Also create a Power Automate flow that saves product feedback exports emailed to you (subject "${FEEDBACK_SUBJECT}")? It needs Power Automate Premium.`,
      up.feedbackFlow ?? false,
    );
  } else up.feedbackFlow = false;
  if (flowsWanted(config).length) await pickFlowEnvironment(ctx);
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
  /** @type {import('../transform/flows.js').FlowTarget} */
  const t = {
    identity,
    endpoint: oneLakeEndpoint(config.fabric.workspaceId ?? '', config.fabric.lakehouseId ?? ''),
    ...(identity === 'app' ? { tenantId, clientId: config.app.appId ?? '', secretName: config.keyVault.secretName } : {}),
  };
  const where = `${config.fabric.lakehouseName ?? 'the Lakehouse'} > ${UPLOAD_DIR}`;
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

/** @param {string[]} names */
const labels = (names) => names.map((n) => connectorByName(n)?.label ?? n).join('; ');

/**
 * Creates the flows chosen, or brings them up to date. An update keeps the connections already
 * signed in to; when it adds one, the flow is turned off until the user signs in. A flow that
 * can't be created is written to a file beside the install record.
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
            const current = connectionReferencesOf(existing.clientdata);
            const fresh = newConnections(definition, current);
            const wasOn = existing.statecode === 1;
            if (fresh.length && wasOn) await dv.turnOffFlow(existing.workflowid);
            await dv.updateFlow(existing.workflowid, flowClientData(definition, current));
            if (fresh.length) ui.warn(`Updated the flow ${existing.name}${wasOn ? ' and turned it off' : ''}. Sign in to: ${labels(fresh)}. Then turn it on.`);
            else ui.ok(`Updated the flow ${existing.name}`);
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
 * The connection sign-ins a flow needs, one line each.
 * @param {import('../config.js').InstallConfig} config
 * @param {FlowKind} kind
 */
export function connectionSteps(config, kind) {
  const workspace = config.fabric.workspaceName ?? 'the workspace';
  const storage =
    flowIdentity(config) === 'app'
      ? `${CONNECTORS.keyVault.label}: vault ${config.keyVault.name ?? 'your Key Vault'}.`
      : `${CONNECTORS.storage.label}: Base Resource URL ${ONELAKE_DFS}, Resource URI ${STORAGE_RESOURCE}. Sign in as someone with Contributor or higher on ${workspace}.`;
  return kind === 'feedback'
    ? [`${CONNECTORS.outlook.label}: sign in as the mailbox the export is emailed to.`, storage]
    : [`${CONNECTORS.entra.label}: Base Resource URL and Resource URI ${PPAPI}. Sign in as a Power Platform, Billing or Global administrator.`, storage];
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
    else ui.note('     The first run loads about six months. Then it runs daily, an hour before the pipeline.');
  }
  ui.note('  Tip: sign in with a dedicated admin account and add a co-owner, so the flows outlive any one person.');
  if (flowIdentity(config) === 'app' && config.keyVault.private) {
    ui.warn(`${config.keyVault.name ?? 'The Key Vault'} blocks public network access, which the Key Vault connector needs. Run install --flow-identity user so the flows sign in to OneLake instead.`);
  }
}
