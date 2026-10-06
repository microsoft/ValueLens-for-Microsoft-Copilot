// @ts-check
/**
 * The optional Power Automate flows: product feedback exports emailed to the admin, and Copilot
 * Studio credits from the Power Platform licensing API. The installer creates each flow, turned
 * off, in a Power Platform environment the user picks; the user signs in to its connections and
 * turns it on. When a flow can't be created, it is written to a file to import instead.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { orgUrl } from '../clients/dataverse.js';
import {
  CONNECTORS,
  connectorsUsed,
  FEEDBACK_FLOW_NAME,
  FEEDBACK_SUBJECT,
  feedbackFlowDefinition,
  flowClientData,
  flowFile,
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
export const flowsWanted = (config) => [
  ...(config.uploads.feedbackFlow && config.dataSources.productFeedback === 'csv' ? /** @type {const} */ (['feedback']) : []),
  ...(config.uploads.studioFlow && config.dataSources.studioCredits === 'csv' ? /** @type {const} */ (['studio']) : []),
];

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
 * Asks about the flows for the sources that take exports, and where to create them.
 * @param {Ctx} ctx
 */
export async function planFlows(ctx) {
  const { ui, config } = ctx;
  const up = config.uploads;
  const ds = config.dataSources;
  if (ds.productFeedback === 'csv') {
    up.feedbackFlow = await ui.confirm(
      `Also create a Power Automate flow that saves product feedback exports emailed to you (subject "${FEEDBACK_SUBJECT}") into the drop folder? It needs a Power Automate Premium licence.`,
      up.feedbackFlow ?? false,
    );
  } else up.feedbackFlow = false;
  if (ds.studioCredits === 'csv') {
    up.studioFlow = await ui.confirm(
      'Also create a Power Automate flow that reads Copilot Studio credits from the Power Platform licensing API each day? It signs in as you, so you need to be a Power Platform, Billing or Global administrator, and it needs Power Automate Premium.',
      up.studioFlow ?? false,
    );
  } else up.studioFlow = false;
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
  const t = {
    tenantId,
    clientId: config.app.appId ?? '',
    secretName: config.keyVault.secretName,
    workspaceId: config.fabric.workspaceId ?? '',
    lakehouseId: config.fabric.lakehouseId ?? '',
  };
  return {
    feedback: {
      name: FEEDBACK_FLOW_NAME,
      description: `Saves product feedback exports emailed with the subject "${FEEDBACK_SUBJECT}" to ${config.fabric.lakehouseName ?? 'the Lakehouse'} > ${UPLOAD_DIR}. Created by the Analytics Hub installer.`,
      definition: feedbackFlowDefinition(t),
    },
    studio: {
      name: STUDIO_FLOW_NAME,
      description: `Saves Copilot Studio credits from the Power Platform licensing API to ${config.fabric.lakehouseName ?? 'the Lakehouse'} > ${UPLOAD_DIR} each day. Created by the Analytics Hub installer.`,
      definition: studioFlowDefinition(t, { time: config.schedule.time, timeZone: config.schedule.timeZone }),
    },
  };
}

/** @param {any} definition */
const signatureOf = (definition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);

/**
 * Creates the flows chosen, or brings them up to date. A flow that can't be created is written to
 * a file beside the install record.
 * @param {Ctx} ctx
 */
export async function ensureFlows(ctx) {
  const { ui, config, api } = ctx;
  const kinds = flowsWanted(config);
  if (!kinds.length) return;
  const up = config.uploads;
  try {
    await ensureWorkspaceRole(ctx, 'Contributor', 'so the Power Automate flows can write to the drop folder');
  } catch (err) {
    ui.warn(`Couldn't give ${config.app.displayName ?? 'the app'} Contributor on the workspace (${/** @type {Error} */ (err).message}). The flows can't save files until it has it.`);
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
            await dv.updateFlow(existing.workflowid, flowClientData(definition));
            ui.ok(`Updated the flow ${existing.name}. Open it to check its connections are still signed in.`);
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
  const note = `Written by the Analytics Hub installer because the flow couldn't be created. In Power Automate, create an automated or scheduled cloud flow, open it in the code view (or use the Power Automate Management connector) and paste "definition". Then sign in to its connections: ${connectorsUsed(definition).map((n) => Object.values(CONNECTORS).find((k) => k.name === n)?.label ?? n).join(', ')}.`;
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
 * What's left to do for each flow.
 * @param {Ctx} ctx
 */
export function flowsSummary(ctx) {
  const { ui, config } = ctx;
  const kinds = flowsWanted(config);
  if (!kinds.length) return;
  const up = config.uploads;
  const env = up.flowEnvironment;
  const link = env?.id ? `${MAKER}environments/${env.id}/flows` : MAKER;
  const vault = config.keyVault.name ?? 'your Key Vault';
  ui.heading('Power Automate flows');
  for (const kind of kinds) {
    const name = kind === 'feedback' ? FEEDBACK_FLOW_NAME : STUDIO_FLOW_NAME;
    const file = up.flowFiles?.[kind];
    if (up.flowIds?.[kind] && !file) ui.info(c.bold(name) + c.dim(`  in ${env?.name ?? env?.url}, turned off`));
    else if (file) ui.info(c.bold(name) + c.dim(`  to import: ${file}`));
    else continue;
    ui.info(`  1. Open it in Power Automate (${link}) and sign in to each connection:`);
    ui.info(`     ${CONNECTORS.keyVault.label} to ${vault}${kind === 'feedback' ? `, and ${CONNECTORS.outlook.label} as the mailbox the export is emailed to` : `, and ${CONNECTORS.entra.label} with Base Resource URL and Resource URI https://api.powerplatform.com`}.`);
    if (kind === 'studio') ui.info('     Sign in as a Power Platform, Billing or Global administrator: the licensing API reads as you.');
    ui.info('  2. Save, then turn the flow on.');
    if (kind === 'feedback') ui.info(`  3. In the Microsoft 365 admin center, schedule the product feedback export to be emailed to that mailbox with the subject "${FEEDBACK_SUBJECT}".`);
    else ui.info(`  3. It runs an hour before the pipeline each day and saves the last ten days. The exports still add per-user figures.`);
  }
  if (config.keyVault.private) ui.note(`  ${vault} only takes private connections, so the Key Vault connector can't reach it. Allow public access from trusted services or use a gateway.`);
  ui.note(`  The flows write to ${config.fabric.lakehouseName ?? 'the Lakehouse'} > ${UPLOAD_DIR} as ${config.app.displayName ?? 'the app'}, which has Contributor on the workspace for it.`);
}
