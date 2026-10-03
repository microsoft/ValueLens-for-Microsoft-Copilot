// @ts-check
/**
 * What the installer deploys: the notebooks, the modules that switch them on,
 * and the Graph application permissions each module needs.
 */

/** Microsoft Graph's application ID. Same in every tenant. */
export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

/** @typedef {'core' | 'orgData' | 'agent365' | 'productFeedback' | 'consumption' | 'agentEvaluator'} ModuleId */

/**
 * @typedef {object} ModuleInfo
 * @property {ModuleId} id
 * @property {string} label
 * @property {string} description
 * @property {boolean} required
 * @property {boolean} defaultOn
 * @property {string[]} permissions  Graph application permissions (by value).
 * @property {string | null} pipelineParameter  The pipeline's Enable* switch.
 */

/** @type {Record<ModuleId, ModuleInfo>} */
export const MODULES = {
  core: {
    id: 'core',
    label: 'Copilot usage and licences',
    description: 'Audit log, licensed users and the processor that builds the curated table.',
    required: true,
    defaultOn: true,
    permissions: ['AuditLogsQuery.Read.All', 'Reports.Read.All'],
    pipelineParameter: null,
  },
  orgData: {
    id: 'orgData',
    label: 'Org data from Entra',
    description: 'Department, job title, manager and location for each user.',
    required: false,
    defaultOn: true,
    permissions: ['User.Read.All'],
    pipelineParameter: 'EnableOrgDataPull',
  },
  agent365: {
    id: 'agent365',
    label: 'Agent 365 registry',
    description: 'Agents in your tenant. Needs an Agent 365 licence; falls back to a CSV export.',
    required: false,
    defaultOn: false,
    permissions: ['CopilotPackages.Read.All', 'Application.Read.All', 'User.Read.All'],
    pipelineParameter: 'EnableAgent365',
  },
  productFeedback: {
    id: 'productFeedback',
    label: 'Product feedback',
    description: 'Reads the feedback CSV export you land in Files/product_feedback. No API.',
    required: false,
    defaultOn: false,
    permissions: [],
    pipelineParameter: 'EnableProductFeedback',
  },
  consumption: {
    id: 'consumption',
    label: 'Credit consumption',
    description: 'Azure AI spend and tokens, plus Copilot Studio and Cowork credits from exports you land in the Lakehouse.',
    required: false,
    defaultOn: false,
    permissions: [],
    pipelineParameter: null,
  },
  agentEvaluator: {
    id: 'agentEvaluator',
    label: 'Agent Evaluator',
    description: 'Copilot Studio agent conversations from Dataverse: how they ended, what people thought, and where agents fall short.',
    required: false,
    defaultOn: false,
    permissions: [],
    pipelineParameter: null,
  },
};

/** Modules that change the ValueLens semantic model. The others have their own model or none. */
export const MODEL_MODULES = /** @type {const} */ (['core', 'orgData', 'agent365', 'productFeedback']);

/** Modules offered under "What to collect", in order. */
export const OPTIONAL_MODULES = /** @type {const} */ (['orgData', 'agent365', 'productFeedback', 'consumption', 'agentEvaluator']);

/** @typedef {'auditIngester' | 'licensedUsers' | 'processor' | 'dataCheck' | 'orgData' | 'agent365Registry' | 'agent365Lander' | 'productFeedback' | 'refreshModel' | 'azureAi' | 'studioConsumption' | 'vivaConsumption' | 'agentTranscripts'} NotebookKey */

/**
 * A text change the installer makes to its copy of a notebook. `find` must occur exactly once.
 * @typedef {{ find: string, replace: string }} NotebookPatch
 */

/**
 * @typedef {object} NotebookInfo
 * @property {NotebookKey} key
 * @property {string} file  File name in `dir`.
 * @property {string} [dir]  Folder under `1. Fabric`. Defaults to `notebooks`.
 * @property {string} displayName  Item name in the Fabric workspace.
 * @property {ModuleId} module
 * @property {boolean} credentials  Has TENANT_ID / CLIENT_ID / CLIENT_SECRET to fill in.
 * @property {string[]} parameters  Assignments the pipeline overrides; the cell holding them is tagged `parameters`.
 * @property {string | null} placeholder  Notebook-ID placeholder in the pipeline template.
 * @property {boolean} [semanticModel]  Only deployed with the semantic model.
 * @property {boolean} [azure]  Only deployed when an Azure subscription is chosen for Azure AI.
 * @property {boolean} [dataverse]  Only deployed when at least one Dataverse environment is chosen.
 * @property {NotebookPatch[]} [patches]
 */

export const CONSUMPTION_NOTEBOOKS_DIR = 'Add Credit Consumption/notebooks';
export const AGENT_EVALUATOR_NOTEBOOKS_DIR = 'Add Agent Evaluator/notebooks';
export const STUDIO_LANDING = 'Files/landing/studio';
export const VIVA_LANDING = 'Files/landing/viva';

/** @type {NotebookInfo[]} */
export const NOTEBOOKS = [
  {
    key: 'auditIngester',
    file: 'Copilot_Audit_Log_Direct_Ingester.ipynb',
    displayName: 'Copilot_Audit_Log_Direct_Ingester',
    module: 'core',
    credentials: true,
    parameters: ['MODE', 'BACKFILL_DAYS'],
    placeholder: 'REPLACE_WITH_AUDIT_LOG_NOTEBOOK_ID',
  },
  {
    key: 'licensedUsers',
    file: 'Copilot_Licensed_Users_Direct_Ingester.ipynb',
    displayName: 'Copilot_Licensed_Users_Direct_Ingester',
    module: 'core',
    credentials: true,
    parameters: [],
    placeholder: 'REPLACE_WITH_LICENSED_USERS_NOTEBOOK_ID',
  },
  {
    key: 'processor',
    file: 'Copilot_Audit_Log_Processor.ipynb',
    displayName: 'Copilot_Audit_Log_Processor',
    module: 'core',
    credentials: false,
    parameters: ['WRITE_MODE'],
    placeholder: 'REPLACE_WITH_AUDIT_LOG_PROCESSOR_NOTEBOOK_ID',
  },
  {
    key: 'dataCheck',
    file: 'ValueLens_Data_Check.ipynb',
    displayName: 'ValueLens_Data_Check',
    module: 'core',
    credentials: false,
    parameters: [],
    placeholder: null,
  },
  {
    key: 'orgData',
    file: 'Copilot_Org_Data_Direct_Ingester.ipynb',
    displayName: 'Copilot_Org_Data_Direct_Ingester',
    module: 'orgData',
    credentials: true,
    parameters: [],
    placeholder: 'REPLACE_WITH_ORG_DATA_NOTEBOOK_ID',
  },
  {
    key: 'agent365Registry',
    file: 'Copilot_Agent365_Registry_Ingester.ipynb',
    displayName: 'Copilot_Agent365_Registry_Ingester',
    module: 'agent365',
    credentials: true,
    parameters: [],
    placeholder: 'REPLACE_WITH_AGENT365_REGISTRY_NOTEBOOK_ID',
  },
  {
    key: 'agent365Lander',
    file: 'Copilot_Agent365_Lander.ipynb',
    displayName: 'Copilot_Agent365_Lander',
    module: 'agent365',
    credentials: false,
    parameters: [],
    placeholder: 'REPLACE_WITH_AGENT365_LANDER_NOTEBOOK_ID',
  },
  {
    key: 'productFeedback',
    file: 'Copilot_ProductFeedback_Ingester.ipynb',
    displayName: 'Copilot_ProductFeedback_Ingester',
    module: 'productFeedback',
    credentials: false,
    parameters: [],
    placeholder: 'REPLACE_WITH_PRODUCT_FEEDBACK_NOTEBOOK_ID',
  },
  {
    key: 'refreshModel',
    file: 'ValueLens_Refresh_Model.ipynb',
    displayName: 'ValueLens_Refresh_Model',
    module: 'core',
    credentials: false,
    parameters: ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID', 'WRITE_MODE'],
    placeholder: null,
    semanticModel: true,
  },
  {
    key: 'azureAi',
    file: 'Ingest_Azure_AI.ipynb',
    dir: CONSUMPTION_NOTEBOOKS_DIR,
    displayName: 'Consumption_Ingest_Azure_AI',
    module: 'consumption',
    credentials: false,
    parameters: [],
    placeholder: null,
    azure: true,
  },
  {
    key: 'studioConsumption',
    file: 'Ingest_Studio.ipynb',
    dir: CONSUMPTION_NOTEBOOKS_DIR,
    displayName: 'Consumption_Ingest_Studio',
    module: 'consumption',
    credentials: false,
    parameters: [],
    placeholder: null,
  },
  {
    key: 'vivaConsumption',
    file: 'Ingest_Viva_Consumption.ipynb',
    dir: CONSUMPTION_NOTEBOOKS_DIR,
    displayName: 'Consumption_Ingest_Viva',
    module: 'consumption',
    credentials: false,
    parameters: [],
    placeholder: null,
    // Cowork data usually arrives through a Dataflow, so an empty landing folder is normal.
    patches: [
      {
        find: 'for f in notebookutils.fs.ls(LANDING)\n',
        replace: 'for f in (notebookutils.fs.ls(LANDING) if notebookutils.fs.exists(LANDING) else [])\n',
      },
      {
        find: "raise ValueError(f'No PersonServiceCreditsMetrics CSV files found in {LANDING}')",
        replace: "notebookutils.notebook.exit(f'No PersonServiceCreditsMetrics CSV files in {LANDING}, so nothing to load.')  # Set by the ValueLens installer",
      },
    ],
  },
  {
    key: 'agentTranscripts',
    file: 'Copilot_Agent_Transcript_Parser.ipynb',
    dir: AGENT_EVALUATOR_NOTEBOOKS_DIR,
    displayName: 'AgentEval_Transcript_Parser',
    module: 'agentEvaluator',
    credentials: true,
    parameters: ['LOOKBACK_DAYS'],
    placeholder: null,
    dataverse: true,
  },
];

/** @typedef {{ orgData: boolean, agent365: boolean, productFeedback: boolean, consumption: boolean, agentEvaluator: boolean }} ModuleChoice */

/** @returns {ModuleChoice} */
export function defaultModules() {
  return {
    orgData: MODULES.orgData.defaultOn,
    agent365: MODULES.agent365.defaultOn,
    productFeedback: MODULES.productFeedback.defaultOn,
    consumption: MODULES.consumption.defaultOn,
    agentEvaluator: MODULES.agentEvaluator.defaultOn,
  };
}

/**
 * @param {Partial<ModuleChoice> | undefined} choice
 * @returns {ModuleChoice}
 */
export function normaliseModules(choice) {
  return { ...defaultModules(), ...(choice ?? {}) };
}

/**
 * @param {ModuleChoice} modules
 * @returns {ModuleId[]}
 */
export function enabledModules(modules) {
  /** @type {ModuleId[]} */
  const out = ['core'];
  if (modules.orgData) out.push('orgData');
  if (modules.agent365) out.push('agent365');
  if (modules.productFeedback) out.push('productFeedback');
  if (modules.consumption) out.push('consumption');
  if (modules.agentEvaluator) out.push('agentEvaluator');
  return out;
}

/**
 * Notebooks to deploy for the chosen modules, in deployment order.
 * @param {ModuleChoice} modules
 * @param {{ semanticModel?: boolean, azureAi?: boolean, dataverse?: boolean }} [opts]
 * @returns {NotebookInfo[]}
 */
export function notebooksFor(modules, opts = {}) {
  const on = new Set(enabledModules(modules));
  return NOTEBOOKS.filter(
    (nb) => on.has(nb.module) && (!nb.semanticModel || opts.semanticModel) && (!nb.azure || opts.azureAi) && (!nb.dataverse || opts.dataverse),
  );
}

/**
 * Graph application permissions the app registration needs, de-duplicated and sorted.
 * Org data's User.Read.All is always included: the docs treat it as core, and it
 * lets a customer switch org data on later without another consent.
 * @param {ModuleChoice} modules
 * @returns {string[]}
 */
export function permissionsFor(modules) {
  const set = new Set([...MODULES.core.permissions, ...MODULES.orgData.permissions]);
  for (const id of enabledModules(modules)) {
    for (const p of MODULES[id].permissions) set.add(p);
  }
  return [...set].sort();
}
