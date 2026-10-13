// @ts-check
/**
 * The Fabric data agent behind the app's Ask page: business questions answered in plain
 * language from the installer's semantic models, with the same measures the pages use.
 */
import { commandLine } from '../launch.js';
import { dataAgentDefinition, dataAgentSignature } from '../transform/data-agent.js';
import { buildAgentEvaluatorModel, buildConsumptionModel, buildModel, loadTemplateModel } from '../transform/model.js';
import { c } from '../ui.js';
import { agentEvaluatorModelWanted } from './agent-evaluator.js';
import { consumptionModelWanted } from './consumption.js';
import { createdId, displayNames, freeName, noteRenamed } from './fabric.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../transform/data-agent.js').AgentSource} AgentSource */

export const DATA_AGENT_TYPE = 'DataAgent';

/**
 * Data agents run on a paid Fabric (F) or Premium (P) capacity, not a trial.
 * @param {{ sku?: string }} capacity
 */
export const runsDataAgent = (capacity) => /^(F|P)\d+$/i.test(String(capacity.sku ?? ''));

/**
 * Tenant settings a data agent needs. Their API names aren't documented, so they're found by title.
 * @type {{ title: RegExp, label: string }[]}
 */
export const DATA_AGENT_SETTINGS = [
  { title: /data agent/i, label: 'Users can create and share data agent items' },
  { title: /copilot and other features powered by azure openai/i, label: 'Users can use Copilot and other features powered by Azure OpenAI' },
  { title: /outside your capacity.s geographic/i, label: 'Data sent to Azure OpenAI can be processed outside your capacity\'s geographic region' },
];

/**
 * Data agent settings that look switched off.
 * @param {Record<string, any> | undefined} settings  Preflight's tenant settings, by name.
 */
export function blockedDataAgentSettings(settings) {
  if (!settings) return [];
  const all = Object.values(settings);
  return DATA_AGENT_SETTINGS.filter((s) => {
    const found = all.find((t) => s.title.test(String(t?.title ?? '')));
    return found && found.enabled === false && !found.delegateToCapacity;
  });
}

/**
 * The installer can build the data agent: a Fabric install with the semantic model, and a checkout that has the Ask catalogue.
 * @param {Ctx} ctx
 */
export const dataAgentPossible = (ctx) => ctx.config.target !== 'azure' && !!ctx.config.semanticModel.enabled && !!ctx.sources.ask;

/**
 * The data agent is wanted: possible, not switched off, and on a capacity that runs it.
 * @param {Ctx} ctx
 */
export const dataAgentWanted = (ctx) =>
  dataAgentPossible(ctx) && ctx.config.dataAgent.enabled !== false && ctx.config.dataAgent.capacityOk !== false;

/**
 * Decides the data agent with the capacity: on unless switched off, and only on a paid capacity.
 * @param {Ctx} ctx
 * @param {import('./plan.js').Preflight} pre
 * @param {{ sku?: string, displayName?: string } | undefined} capacity
 * @param {boolean} advanced  Ask whether to create it.
 */
export async function planDataAgent(ctx, pre, capacity, advanced) {
  const { ui, config } = ctx;
  const da = config.dataAgent;
  if (!dataAgentPossible(ctx)) return;
  da.capacityOk = !capacity || runsDataAgent(capacity);
  if (!da.capacityOk) {
    ui.note(`The Ask data agent needs a paid Fabric capacity (F2 or larger) or Premium; ${capacity?.displayName ?? 'this capacity'} is ${capacity?.sku}. The Ask page still lists the questions.`);
    return;
  }
  if (advanced) {
    da.enabled = await ui.confirm('Create the Ask data agent, so people can ask Analytics Hub questions in plain language?', da.enabled !== false);
  }
  if (da.enabled === false) return;
  for (const s of blockedDataAgentSettings(pre.tenantSettings)) {
    ui.warn(`The tenant setting "${s.label}" looks off. The Ask data agent won't answer without it.`);
    ui.note('A Fabric administrator can switch it on in the admin portal, under Tenant settings.');
  }
}

/**
 * The deployed models the agent reads, each with its built definition for the table list.
 * @param {Ctx} ctx
 * @returns {AgentSource[]}
 */
export function agentSources(ctx) {
  const { config, sources } = ctx;
  const sm = config.semanticModel;
  const server = sm.server ?? '';
  const database = sm.database ?? '';
  const resourceGraph = config.dataSources?.resourceGraph === 'api';
  /** @type {AgentSource[]} */
  const list = [];
  if (sm.id && sources.modelFile) {
    list.push({
      alias: 'vl',
      id: sm.id,
      name: sm.name,
      bim: buildModel(loadTemplateModel(sources.modelFile), { server, database, modules: config.modules, resourceGraph, currency: config.reporting?.currency }),
    });
  }
  const cm = config.consumption.model;
  if (consumptionModelWanted(ctx) && cm.id && sources.consumptionModelFile) {
    list.push({ alias: 'cc', id: cm.id, name: cm.name, bim: buildConsumptionModel(loadTemplateModel(sources.consumptionModelFile), { server, database, resourceGraph }) });
  }
  const am = config.agentEvaluator.model;
  if (agentEvaluatorModelWanted(ctx) && am.id && sources.agentEvaluatorModelFile) {
    list.push({ alias: 'ae', id: am.id, name: am.name, bim: buildAgentEvaluatorModel(loadTemplateModel(sources.agentEvaluatorModelFile), { server, database }) });
  }
  return list;
}

/**
 * Creates the data agent, or updates it when its models or the Ask catalogue changed, then publishes it.
 * @param {Ctx} ctx
 */
export async function deployDataAgent(ctx) {
  const { ui, api, config } = ctx;
  const da = config.dataAgent;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const ask = /** @type {import('../transform/data-agent.js').Ask} */ (ctx.sources.ask);
  const models = agentSources(ctx);
  if (!models.some((m) => m.alias === 'vl')) {
    ui.warn(`Skipped the Ask data agent: ${config.semanticModel.name} isn't deployed.`);
    return;
  }
  const definition = dataAgentDefinition(ask, ws, models);
  const signature = dataAgentSignature(definition);
  const items = await api.fabric.listItems(ws, DATA_AGENT_TYPE);

  if (da.id && !items.some((i) => i.id === da.id)) {
    ui.warn(`The ${da.name} data agent was deleted. Creating it again.`);
    delete da.id;
    delete da.publishedSignature;
  }
  if (!da.id) {
    const name = freeName(da.name, displayNames(items));
    noteRenamed(ctx, da.name, name);
    const created = await api.fabric.createDataAgent(ws, name, definition);
    da.id = await createdId(ctx, created, DATA_AGENT_TYPE, name);
    da.name = name;
    da.signature = signature;
    ctx.save();
    ui.ok(`Created the ${name} data agent, over ${models.map((m) => m.name).join(', ')}`);
  } else if (da.signature !== signature) {
    await api.fabric.updateDataAgent(ws, da.id, definition);
    da.signature = signature;
    ctx.save();
    ui.ok(`Updated the ${da.name} data agent`);
  } else {
    ui.ok(`The ${da.name} data agent is in place`);
  }
  if (da.publishedSignature !== signature) {
    await api.fabric.publishDataAgent(ws, da.id, 'Answers questions about Microsoft 365 Copilot and agents from Analytics Hub.');
    da.publishedSignature = signature;
    ctx.save();
    ui.ok(`Published ${da.name}`);
  }
}

/**
 * Creates, updates and publishes the data agent. Nothing else depends on it, so a failure is
 * reported and the install carries on.
 * @param {Ctx} ctx
 */
export async function ensureDataAgent(ctx) {
  if (!dataAgentWanted(ctx)) return;
  try {
    await deployDataAgent(ctx);
  } catch (err) {
    ctx.ui.fail(`The ${ctx.config.dataAgent.name} data agent wasn't set up: ${/** @type {Error} */ (err).message}`);
    ctx.ui.info(`Fix the problem, then run "${commandLine('update')}".`);
  }
}

/**
 * The data agent in the Fabric portal.
 * @param {string} workspaceId @param {string} id
 */
export const dataAgentUrl = (workspaceId, id) => `https://app.fabric.microsoft.com/groups/${workspaceId}/dataagents/${id}`;

/**
 * The data agent, for the summary, with what's left to do by hand.
 * @param {Ctx} ctx
 */
export function dataAgentSummary(ctx) {
  const { ui, config } = ctx;
  const da = config.dataAgent;
  if (!dataAgentWanted(ctx) || !da.id) return;
  ui.info(`Ask:        ${da.name}  ${c.dim(dataAgentUrl(/** @type {string} */ (config.fabric.workspaceId), da.id))}`);
  ui.note('People who ask it questions need Build or Read on the semantic models it reads, and access to the workspace or the agent.');
  ui.note('To use it in Microsoft 365 Copilot or Teams, open it in Fabric and publish it to Microsoft 365 Copilot. There\'s no API for that step.');
}
