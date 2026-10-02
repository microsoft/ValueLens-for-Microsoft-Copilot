// @ts-check
/**
 * What the installer deploys: the notebooks, the modules that switch them on,
 * and the Graph application permissions each module needs.
 */

/** Microsoft Graph's application ID. Same in every tenant. */
export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

/** @typedef {'core' | 'orgData' | 'agent365' | 'productFeedback'} ModuleId */

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
};

/** @typedef {'auditIngester' | 'licensedUsers' | 'processor' | 'dataCheck' | 'orgData' | 'agent365Registry' | 'agent365Lander' | 'productFeedback' | 'refreshModel'} NotebookKey */

/**
 * @typedef {object} NotebookInfo
 * @property {NotebookKey} key
 * @property {string} file  File name in `3. Fabric/notebooks`.
 * @property {string} displayName  Item name in the Fabric workspace.
 * @property {ModuleId} module
 * @property {boolean} credentials  Has TENANT_ID / CLIENT_ID / CLIENT_SECRET to fill in.
 * @property {string[]} parameters  Assignments the pipeline overrides; the cell holding them is tagged `parameters`.
 * @property {string | null} placeholder  Notebook-ID placeholder in the pipeline template.
 * @property {boolean} [semanticModel]  Only deployed with the semantic model.
 */

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
];

/** @typedef {{ orgData: boolean, agent365: boolean, productFeedback: boolean }} ModuleChoice */

/** @returns {ModuleChoice} */
export function defaultModules() {
  return {
    orgData: MODULES.orgData.defaultOn,
    agent365: MODULES.agent365.defaultOn,
    productFeedback: MODULES.productFeedback.defaultOn,
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
  return out;
}

/**
 * Notebooks to deploy for the chosen modules, in deployment order.
 * @param {ModuleChoice} modules
 * @param {{ semanticModel?: boolean }} [opts]
 * @returns {NotebookInfo[]}
 */
export function notebooksFor(modules, opts = {}) {
  const on = new Set(enabledModules(modules));
  return NOTEBOOKS.filter((nb) => on.has(nb.module) && (!nb.semanticModel || opts.semanticModel));
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
