// @ts-check
/**
 * Credit consumption, from Consumption Central: Azure AI costs read by the app registration,
 * Lakehouse folders for the Copilot Studio and Cowork exports, and the Consumption model,
 * which reads the Lakehouse through the ValueLens model's connection.
 */
import { STUDIO_LANDING, VIVA_LANDING } from '../catalog.js';
import { ROLES } from '../clients/azure.js';
import { semanticModelDefinition } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { COWORK_DATAFLOW_TABLE, coworkDataflowDefinition, isVivaId } from '../transform/dataflow.js';
import { buildConsumptionModel, loadTemplateModel, PBISM } from '../transform/model.js';
import { c } from '../ui.js';
import { UPLOAD_DIR } from '../uploads.js';
import { azureAiOn, coworkDataflowOn, createdId, displayNames, freeName, noteRenamed } from './fabric.js';
import { bindModel, deployModel, modelUrl, waitForSqlEndpoint } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/** Azure roles the Azure AI notebook needs on the subscription. */
export const AZURE_AI_ROLES = [
  { id: ROLES.reader, name: 'Reader' },
  { id: ROLES.costManagementReader, name: 'Cost Management Reader' },
  { id: ROLES.monitoringReader, name: 'Monitoring Reader' },
];

/** Subscriptions are only searched for AI resources when there are this many or fewer. */
export const MAX_SUBSCRIPTIONS_TO_SEARCH = 25;

const DATAFLOW_GUIDE = 'https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric';

/** The Dataflow that reads Cowork credits from Viva Insights. */
export const COWORK_DATAFLOW_NAME = 'AnalyticsHub_Cowork_Credits';

/**
 * How to give the Cowork Dataflow its sign-ins. The editor's preview uses the user's own sign-in, so
 * rows can show there while every refresh still fails until the connections are saved with the Dataflow.
 * @param {import('../config.js').InstallConfig} config
 * @returns {string[]}
 */
export function coworkSignInSteps(config) {
  const name = config.consumption?.dataflowName ?? COWORK_DATAFLOW_NAME;
  return [
    `Open ${name} in ${config.fabric.workspaceName ?? 'the workspace'} and choose Edit dataflow. Under Home > Manage connections,`,
    `sign in to Viva Insights and to ${config.fabric.lakehouseName ?? 'the Lakehouse'} (Edit on any without a connection). Then choose`,
    'Save, wait until it says the Dataflow is published, and choose Refresh now. Rows in the preview alone are not enough.',
  ];
}

/**
 * Asks for the Viva Insights query the Cowork credits Dataflow reads. Without one, Cowork
 * credits come from the CSV export instead.
 * @param {Ctx} ctx
 */
export async function planCowork(ctx) {
  const { ui, config } = ctx;
  const cc = config.consumption;
  if (config.dataSources.coworkCredits !== 'api') return;
  ui.note('A Dataflow reads Cowork credits from a Viva Insights query. In Viva Insights > Analysis, build a query with the Copilot credit metrics and turn on Auto-refresh; then, in Analysis results, choose the link icon to copy its partition and query IDs.');
  ui.note(`Guide: ${DATAFLOW_GUIDE}`);
  const guid = 'It looks like 00000000-0000-0000-0000-000000000000.';
  const partition = (await ui.input('Viva Insights partition ID. Leave blank to upload the CSV export instead.', {
    default: cc.vivaPartition ?? '',
    validate: (v) => !v.trim() || isVivaId(v) || guid,
  })).trim();
  if (!partition) {
    config.dataSources.coworkCredits = 'csv';
    ui.note(`Cowork credits come from the Consumption Dashboard's CSV export. Drop it in ${UPLOAD_DIR}.`);
    return;
  }
  const query = (await ui.input('Viva Insights query ID', { default: cc.vivaQuery ?? '', validate: (v) => isVivaId(v) || guid })).trim();
  cc.vivaPartition = partition;
  cc.vivaQuery = query;
}

/**
 * Creates the Dataflow that reads Cowork credits from Viva Insights, or points it at a new query.
 * Once it exists its definition is only replaced when the query changes, so the sign-ins the
 * user added to it are kept. If it can't be made, Cowork credits come from the CSV export.
 * @param {Ctx} ctx
 */
export async function ensureCoworkDataflow(ctx) {
  const { ui, config, api } = ctx;
  const cc = config.consumption;
  if (config.dataSources.coworkCredits !== 'api') return;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const lh = /** @type {string} */ (config.fabric.lakehouseId);
  const toCsv = (/** @type {string} */ why) => {
    ui.warn(`${why} Cowork credits come from the CSV export for now.`);
    ui.info(`Drop the Consumption Dashboard's export in ${config.fabric.lakehouseName} > ${UPLOAD_DIR}, or run the installer again to retry.`);
    config.dataSources.coworkCredits = 'csv';
    ctx.save();
  };
  if (!isVivaId(cc.vivaPartition) || !isVivaId(cc.vivaQuery)) return toCsv('The Dataflow needs the Viva Insights partition and query IDs.');

  const signature = `${cc.vivaPartition};${cc.vivaQuery};${lh}`.toLowerCase();
  let name = cc.dataflowName ?? COWORK_DATAFLOW_NAME;
  try {
    const items = await api.fabric.listItems(ws, 'Dataflow');
    if (cc.dataflowId && !items.some((i) => i.id === cc.dataflowId)) {
      ui.warn(`${name} was deleted. Creating it again.`);
      delete cc.dataflowId;
      delete cc.dataflowSignature;
    }
    if (!cc.dataflowId) {
      const wanted = name;
      name = freeName(wanted, displayNames(items));
      noteRenamed(ctx, wanted, name);
      const created = await api.fabric.createDataflow(ws, name, 'Cowork Copilot credits from Viva Insights, for Analytics Hub. The pipeline refreshes it before loading them.');
      cc.dataflowId = await createdId(ctx, created, 'Dataflow', name);
      cc.dataflowName = name;
      ctx.save();
      ui.ok(`Created Dataflow ${name}`);
    }
    if (cc.dataflowSignature === signature) {
      ui.ok(`Dataflow ${name} reads Viva Insights query ${cc.vivaQuery}`);
      return;
    }
    await api.fabric.updateDataflow(ws, cc.dataflowId, coworkDataflowDefinition(name, {
      partitionId: /** @type {string} */ (cc.vivaPartition),
      queryId: /** @type {string} */ (cc.vivaQuery),
      workspaceId: ws,
      lakehouseId: lh,
    }));
    cc.dataflowSignature = signature;
    ctx.save();
    ui.ok(`Dataflow ${name} reads Viva Insights query ${cc.vivaQuery} into ${COWORK_DATAFLOW_TABLE}`);
    for (const line of coworkSignInSteps(config)) ui.info(line);
  } catch (err) {
    // A Dataflow that exists but never got its definition would only fail on every run.
    if (!cc.dataflowSignature) toCsv(`Couldn't set up the Cowork credits Dataflow (${/** @type {Error} */ (err).message}).`);
    else ui.warn(`Couldn't update Dataflow ${name} (${/** @type {Error} */ (err).message}). It still reads the last query it was given.`);
  }
}

/**
 * The Consumption model is deployed: credit consumption is on, the ValueLens model (whose
 * connection it shares) is on, and this checkout has the template.
 * @param {Ctx} ctx
 */
export const consumptionModelWanted = (ctx) => !!(ctx.config.modules.consumption && ctx.config.semanticModel.enabled && ctx.sources.consumptionModelFile);

/**
 * Asks which subscription the Azure AI notebook reads.
 * @param {Ctx} ctx
 * @param {import('./plan.js').Preflight} pre
 */
export async function planConsumption(ctx, pre) {
  const { ui, config, api, sources } = ctx;
  const cc = config.consumption;
  ui.heading('Credit consumption');
  if (!config.semanticModel.enabled) {
    ui.note('The credit consumption model shares the main semantic model\'s connection, so it is only deployed with it.');
    ui.note('The notebooks still load the data; publish the credit consumption report ("Consumption Central - Fabric.pbit") yourself.');
  } else if (!sources.consumptionModelFile) {
    ui.note('This checkout has no credit consumption report ("Consumption Central - Fabric.pbit"), so only the notebooks are deployed.');
  }

  const subs = pre.subscriptions;
  if (config.dataSources.azureAi === 'skip') {
    if (cc.azureSubscriptionId) cc.azureAccess = false;
    cc.azureSubscriptionId = '';
    cc.azureSubscriptionName = undefined;
    cc.paygSubscriptions = [];
    return;
  }
  if (!subs.length) {
    if (cc.azureSubscriptionId) ui.ok(`Azure AI: ${cc.azureSubscriptionName ?? cc.azureSubscriptionId}`);
    else {
      ui.note('No Azure subscription to read Azure AI costs from, so Azure AI is left out.');
      config.dataSources.azureAi = 'skip';
    }
    return;
  }

  /** @type {(number | undefined)[]} */
  let counts = subs.map(() => undefined);
  if (subs.length <= MAX_SUBSCRIPTIONS_TO_SEARCH) {
    ui.info('Looking for Azure AI resources in your subscriptions.');
    counts = await Promise.all(subs.map((s) => api.arm.listAiAccounts(s.subscriptionId).then((a) => a.length, () => undefined)));
  }
  const policies = await readBillingPolicies(ctx);
  const billed = policiesBySubscription(policies ?? []);
  const label = (/** @type {number | undefined} */ n, /** @type {string} */ sub) => {
    const ai = n === undefined ? '' : n === 1 ? ', 1 AI resource' : `, ${n} AI resources`;
    const payg = billed.get(sub.toLowerCase())?.length ?? 0;
    return `${ai}${payg === 0 ? '' : payg === 1 ? ', 1 billing policy' : `, ${payg} billing policies`}`;
  };
  const withAi = subs.find((_, i) => (counts[i] ?? 0) > 0);
  const withPayg = subs.find((s) => billed.has(s.subscriptionId.toLowerCase()));
  const current = subs.some((s) => s.subscriptionId === cc.azureSubscriptionId)
    ? cc.azureSubscriptionId
    : cc.azureSubscriptionId === ''
      ? ''
      : (withAi ?? withPayg)?.subscriptionId ?? '';
  const choice = await ui.select(
    'Which subscription\'s Azure OpenAI and AI Foundry costs should it read? The notebook reads one, plus Copilot pay-as-you-go from every billing policy\'s subscription.',
    [
      ...subs.map((s, i) => ({ name: `${s.displayName} (${s.subscriptionId}${label(counts[i], s.subscriptionId)})`, value: s.subscriptionId })),
      { name: 'Leave Azure AI out', value: '', description: 'Copilot Studio and Cowork credits from the exports only.' },
    ],
    current,
  );
  if (choice !== cc.azureSubscriptionId) cc.azureAccess = false;
  // '' remembers that Azure AI was left out on purpose.
  cc.azureSubscriptionId = choice;
  if (!choice) config.dataSources.azureAi = 'skip';
  cc.azureSubscriptionName = choice ? subs.find((s) => s.subscriptionId === choice)?.displayName : undefined;
  if (policies) planPayg(ctx, billed, subs);
  else if (cc.paygSubscriptions) cc.paygSubscriptions = cc.paygSubscriptions.filter((p) => p.subscriptionId.toLowerCase() !== choice.toLowerCase());

  const extra = cc.paygSubscriptions ?? [];
  if (!choice && (billed.size || extra.length)) ui.note('Copilot pay-as-you-go billed in Azure is left out too: the Azure AI notebook reads it.');
  else if (extra.length) ui.note(`The notebook also reads Copilot pay-as-you-go from ${joinList(extra.map(paygName))}.`);
}

/**
 * The billing policies that charge Copilot pay-as-you-go to Azure. Undefined when they couldn't be read.
 * @param {Ctx} ctx
 * @returns {Promise<import('../clients/powerplatform.js').BillingPolicy[] | undefined>}
 */
async function readBillingPolicies(ctx) {
  try {
    return await ctx.api.powerPlatform.billingPolicies();
  } catch (err) {
    ctx.ui.note(`Couldn't read Power Platform billing policies (${/** @type {Error} */ (err).message}).`);
    ctx.ui.note('Only the chosen subscription\'s Copilot pay-as-you-go is read. A Power Platform admin can run the installer again to add the rest.');
    return undefined;
  }
}

/**
 * Billing policy names by Azure subscription, lower-cased.
 * @param {import('../clients/powerplatform.js').BillingPolicy[]} policies
 */
export function policiesBySubscription(policies) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const p of policies) {
    const sub = p.billingInstrument?.subscriptionId?.toLowerCase();
    if (!sub) continue;
    out.set(sub, [...(out.get(sub) ?? []), p.name ?? p.id]);
  }
  return out;
}

/**
 * The billing policies' subscriptions other than the Azure AI one, keeping access already given.
 * @param {Ctx} ctx
 * @param {Map<string, string[]>} billed
 * @param {{ subscriptionId: string, displayName: string }[]} subs
 */
function planPayg(ctx, billed, subs) {
  const cc = ctx.config.consumption;
  const main = (cc.azureSubscriptionId ?? '').toLowerCase();
  const before = new Map((cc.paygSubscriptions ?? []).map((p) => [p.subscriptionId.toLowerCase(), p]));
  cc.paygSubscriptions = [...billed]
    .filter(([sub]) => sub !== main)
    .map(([sub, names]) => {
      const known = subs.find((s) => s.subscriptionId.toLowerCase() === sub);
      return {
        subscriptionId: known?.subscriptionId ?? sub,
        name: known?.displayName,
        policies: names,
        ...(before.get(sub)?.access ? { access: true } : {}),
      };
    });
}

/** @param {import('../config.js').PaygSubscription} p */
const paygName = (p) => p.name ?? p.subscriptionId;

/** @param {string[]} names */
const joinList = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Gives the app's service principal read access to Azure costs and metrics in the chosen subscription.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether the Azure AI notebook can run.
 */
export async function ensureAzureAiAccess(ctx) {
  const { ui, config, api } = ctx;
  const cc = config.consumption;
  const sub = cc.azureSubscriptionId;
  if (!sub) {
    ui.note('Azure AI is left out.');
    return false;
  }
  const where = cc.azureSubscriptionName ?? sub;
  const app = config.app.displayName ?? 'the app';
  const names = AZURE_AI_ROLES.map((r) => r.name).join(', ');
  if (cc.azureAccess) {
    ui.ok(`${app} can read Azure AI costs in ${where}`);
    await ensurePaygAccess(ctx);
    return true;
  }
  try {
    for (const r of AZURE_AI_ROLES) await api.arm.assignRole(`/subscriptions/${sub}`, r.id, /** @type {string} */ (config.app.servicePrincipalId), 'ServicePrincipal');
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 403) throw err;
    ui.warn(`You can't assign Azure roles in ${where}, so Azure AI is left out of the pipeline for now.`);
    ui.info(`An Owner or User Access Administrator can give ${app} (${config.app.appId}) ${names} on the subscription.`);
    if (!ui.yes) {
      const done = await ui.select('Then:', [
        { name: 'Leave Azure AI out for now', value: false, description: 'Run the installer again once the roles are there.' },
        { name: 'It already has these roles', value: true },
      ], false);
      if (done) {
        cc.azureAccess = true;
        ctx.save();
        await ensurePaygAccess(ctx);
        return true;
      }
    }
    ui.note('Run the installer again once the roles are assigned.');
    return false;
  }
  cc.azureAccess = true;
  ctx.save();
  ui.ok(`Gave ${app} ${names} on ${where}`);
  ui.note('New Azure roles can take a few minutes to apply. The notebook retries if they haven\'t yet.');
  await ensurePaygAccess(ctx);
  return true;
}

/**
 * Cost Management Reader on the other subscriptions that billing policies charge Copilot pay-as-you-go to.
 * One the user can't grant is left out of the notebook rather than failing every run.
 * @param {Ctx} ctx
 */
async function ensurePaygAccess(ctx) {
  const { ui, config, api } = ctx;
  const app = config.app.displayName ?? 'the app';
  for (const p of config.consumption.paygSubscriptions ?? []) {
    const where = paygName(p);
    if (p.access) {
      ui.ok(`${app} can read Copilot pay-as-you-go costs in ${where}`);
      continue;
    }
    try {
      await api.arm.assignRole(`/subscriptions/${p.subscriptionId}`, ROLES.costManagementReader, /** @type {string} */ (config.app.servicePrincipalId), 'ServicePrincipal');
    } catch (err) {
      if (!(err instanceof HttpError) || ![403, 404].includes(err.status)) throw err;
      ui.warn(`You can't assign Azure roles in ${where}, so its Copilot pay-as-you-go is left out for now.`);
      ui.info(`An Owner or User Access Administrator can give ${app} (${config.app.appId}) Cost Management Reader on it.`);
      const done = !ui.yes && (await ui.select('Then:', [
        { name: 'Leave it out for now', value: false, description: 'Run the installer again once the role is there.' },
        { name: 'It already has this role', value: true },
      ], false));
      if (done) {
        p.access = true;
        ctx.save();
      }
      continue;
    }
    p.access = true;
    ctx.save();
    ui.ok(`Gave ${app} Cost Management Reader on ${where}`);
  }
}

/**
 * Makes the folders the Copilot Studio and Cowork exports are uploaded to.
 * @param {Ctx} ctx
 */
export async function ensureLandingFolders(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  try {
    for (const path of [STUDIO_LANDING, VIVA_LANDING]) {
      await api.oneLake.createDirectory(/** @type {string} */ (f.workspaceId), /** @type {string} */ (f.lakehouseId), path);
    }
  } catch (err) {
    ui.warn(`Couldn't make the upload folders in ${f.lakehouseName} (${/** @type {Error} */ (err).message}).`);
    ui.info(`Make ${STUDIO_LANDING} and ${VIVA_LANDING} yourself: in the Lakehouse, choose the ... next to Files, then New subfolder.`);
    return;
  }
  config.consumption.landing = true;
  ctx.save();
  ui.ok(`Upload folders ${STUDIO_LANDING} and ${VIVA_LANDING} are in ${f.lakehouseName}`);
}

/**
 * Creates the Consumption model, or updates it when the Lakehouse changed or `force` is set,
 * and connects it through the ValueLens model's connection.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureConsumptionModel(ctx, opts = {}) {
  const { config, sources } = ctx;
  const m = config.consumption.model;
  const file = sources.consumptionModelFile;
  if (!file) throw new Error('This checkout has no "Consumption Central - Fabric.pbit" to build the credit consumption model from.');
  const { server, database } = await waitForSqlEndpoint(ctx);
  await deployModel(ctx, m, {
    signature: `${server.toLowerCase()};${database}`,
    definition: () => semanticModelDefinition(buildConsumptionModel(loadTemplateModel(file), { server, database }), PBISM),
    force: opts.force,
  });
  if (!m.bound && config.semanticModel.connectionId) await bindModel(ctx, m);
}

/**
 * Where the consumption data comes from, and the two exports the customer lands themselves.
 * @param {Ctx} ctx
 */
export function consumptionSummary(ctx) {
  const { ui, config } = ctx;
  const cc = config.consumption;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const lakehouse = config.fabric.lakehouseName;

  ui.heading('Credit consumption');
  if (azureAiOn(config)) ui.info(`Azure AI:   ${cc.azureSubscriptionName ?? cc.azureSubscriptionId}, read on every run`);
  else if (cc.azureSubscriptionId) ui.info(`Azure AI:   ${c.dim(`left out until ${config.app.displayName ?? 'the app'} has ${AZURE_AI_ROLES.map((r) => r.name).join(', ')} on ${cc.azureSubscriptionName ?? cc.azureSubscriptionId}`)}`);
  else ui.info(`Azure AI:   ${c.dim('left out')}`);
  const payg = cc.paygSubscriptions ?? [];
  if (azureAiOn(config)) {
    const read = [cc.azureSubscriptionName ?? /** @type {string} */ (cc.azureSubscriptionId), ...payg.filter((p) => p.access).map(paygName)];
    ui.info(`PAYG:       Copilot Studio and Cowork pay-as-you-go billed to ${joinList(read)}`);
    const missing = payg.filter((p) => !p.access);
    if (missing.length) ui.info(`            ${c.dim(`not ${joinList(missing.map(paygName))} until ${config.app.displayName ?? 'the app'} has Cost Management Reader there`)}`);
  }
  if (cc.model.id) ui.info(`Model:      ${cc.model.name}  ${c.dim(modelUrl(ws, cc.model.id))}`);

  const ds = config.dataSources;
  if (ds.studioCredits !== 'skip') {
    const api = ds.studioCredits === 'api';
    ui.info(c.bold('Copilot Studio credits') + c.dim(api ? '  (a daily flow reads the licensing API)' : '  (upload the exports)'));
    if (api) {
      ui.info('  1. Sign in to the flow and turn it on: see Power Automate flows.');
      ui.note(`     Optional: drop the Power Platform admin center exports in ${UPLOAD_DIR}. They add user emails and the exact prepaid split, and win for the months they cover.`);
    } else {
      ui.info('  1. Power Platform admin center > Licensing > Products > Copilot Studio. On the Summary,');
      ui.info('     Environments and Agents tabs, download the EntitlementConsumption*_MCSMessages*.csv files.');
      ui.info(`  2. Drop them in ${lakehouse} > ${UPLOAD_DIR}. Each export counts as the month it is loaded in.`);
    }
  }

  if (coworkDataflowOn(config)) {
    ui.info(c.bold('Cowork credits') + c.dim(`  (Dataflow ${cc.dataflowName ?? COWORK_DATAFLOW_NAME}, refreshed by the pipeline)`));
    coworkSignInSteps(config).forEach((line, i) => ui.info(`${i ? '     ' : '  1. '}${line}`));
    ui.info('     Until then, each pipeline run notes that the refresh failed.');
    ui.info('  2. Keep the Viva Insights query on Auto-refresh. The pipeline refreshes the Dataflow before each Viva load.');
    ui.note(`     Guide: ${DATAFLOW_GUIDE}`);
    ui.note(`     Exports of earlier weeks can still go in ${UPLOAD_DIR}: the Dataflow wins for the weeks it covers.`);
  } else if (ds.coworkCredits === 'csv') {
    ui.info(c.bold('Cowork credits') + c.dim('  (upload the export)'));
    ui.info('  1. Viva Insights > Copilot > Consumption Dashboard: download the CSV export.');
    ui.info(`  2. Drop it in ${lakehouse} > ${UPLOAD_DIR}.`);
    ui.note('     To read it straight from a Viva Insights query instead, run the installer again and choose Connected (Dataflow).');
  }
}
