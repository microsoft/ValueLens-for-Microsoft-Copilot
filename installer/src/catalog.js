// @ts-check
/**
 * What the installer deploys: the notebooks, the modules that switch them on,
 * and the Graph application permissions each module needs.
 */
import { routerWanted } from './uploads.js';

/** Microsoft Graph's application ID. Same in every tenant. */
export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

/** @typedef {'core' | 'orgData' | 'm365Activity' | 'agent365' | 'productFeedback' | 'defender'} ModuleId */

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
    description: 'From the Microsoft 365 audit log and your Copilot licences. Shows who uses Copilot, in which apps and how often.',
    required: true,
    defaultOn: true,
    permissions: ['AuditLogsQuery.Read.All', 'Reports.Read.All'],
    pipelineParameter: null,
  },
  orgData: {
    id: 'orgData',
    label: 'Org data',
    description: 'From Microsoft Entra ID. Adds each person\'s department, job title, manager and location, so you can compare teams.',
    required: true,
    defaultOn: true,
    permissions: ['User.Read.All'],
    pipelineParameter: 'EnableOrgDataPull',
  },
  m365Activity: {
    id: 'm365Activity',
    label: 'Microsoft 365 activity',
    description: 'From the Microsoft 365 usage reports. Shows how people work across Teams, Outlook, SharePoint, OneDrive, Viva Engage and the Office apps.',
    required: false,
    defaultOn: true,
    permissions: ['Reports.Read.All'],
    pipelineParameter: 'EnableM365Activity',
  },
  agent365: {
    id: 'agent365',
    label: 'Agent 365 registry',
    description: 'From the Agent 365 registry, or its CSV export from the Microsoft 365 admin center. Lists the agents in your tenant and who made them. The registry needs an Agent 365 licence.',
    required: false,
    defaultOn: false,
    permissions: ['CopilotPackages.Read.All', 'Application.Read.All', 'User.Read.All'],
    pipelineParameter: 'EnableAgent365',
  },
  productFeedback: {
    id: 'productFeedback',
    label: 'Product feedback',
    description: 'From the product feedback export in the Microsoft 365 admin center, which you upload. Shows what people say about Copilot.',
    required: false,
    defaultOn: false,
    permissions: [],
    pipelineParameter: 'EnableProductFeedback',
  },
  defender: {
    id: 'defender',
    label: 'Defender (shadow AI and agent risk)',
    description: 'From Microsoft Defender advanced hunting and Cloud Discovery. Shows AI tools other than Copilot in use on your devices and network, and agents that answer without sign-in. Needs Defender for Endpoint P2 or Defender for Cloud Apps; probes you aren\'t licensed for are skipped.',
    required: false,
    defaultOn: false,
    permissions: ['ThreatHunting.Read.All', 'CloudApp-Discovery.Read.All'],
    pipelineParameter: 'EnableDefender',
  },
};

/** Modules that change the ValueLens semantic model. */
export const MODEL_MODULES = /** @type {const} */ (['core', 'orgData', 'm365Activity', 'agent365', 'productFeedback', 'defender']);

/** Always collected: the dashboard is built on them. Shown locked on the Data sources screen. */
export const ESSENTIAL_MODULES = /** @type {const} */ (['core', 'orgData']);

/** Modules the Data sources screen can switch on, in order. */
export const OPTIONAL_MODULES = /** @type {const} */ (['m365Activity', 'agent365', 'productFeedback', 'defender']);

/** @typedef {'auditIngester' | 'licensedUsers' | 'processor' | 'dataCheck' | 'orgData' | 'm365Activity' | 'agent365Registry' | 'agent365Lander' | 'productFeedback' | 'refreshModel' | 'uploadRouter' | 'workdayLander' | 'loadStatus' | 'defender' | 'resourceGraph' | 'accessScope'} NotebookKey */

/**
 * A text change the installer makes to its copy of a notebook. `find` must occur exactly once.
 * @typedef {{ find: string, replace: string }} NotebookPatch
 */

/**
 * @typedef {object} NotebookInfo
 * @property {NotebookKey} key
 * @property {string} file  File name in `dir`.
 * @property {string} [dir]  Folder under the source folder. Defaults to {@link NOTEBOOKS_DIR}.
 * @property {string} displayName  Item name in the Fabric workspace.
 * @property {ModuleId} module
 * @property {boolean} credentials  Has TENANT_ID / CLIENT_ID / CLIENT_SECRET to fill in.
 * @property {string[]} parameters  Assignments the pipeline overrides; the cell holding them is tagged `parameters`.
 * @property {string | null} placeholder  Notebook-ID placeholder in the pipeline template.
 * @property {boolean} [semanticModel]  Only deployed with the semantic model.
 * @property {boolean} [uploads]  Only deployed when a source arrives as an uploaded CSV.
 * @property {boolean} [workday]  Only deployed when Workday org data is uploaded.
 * @property {boolean} [registry]  Left out when Agent 365 comes from its CSV export instead of the API.
 * @property {boolean} [resourceGraph]  Only deployed when agent configuration and Foundry come from Azure Resource Graph.
 * @property {boolean} [access]  Only deployed with org-scoped access (row-level security) on.
 * @property {Record<string, string>} [values]  String settings the installer's copy always has.
 * @property {Record<string, string>} [expressions]  Python expressions the installer's copy always has, e.g. `True`.
 * @property {NotebookPatch[]} [patches]
 */

/** The files for setting Fabric up by hand, which the installer deploys from, under the source folder. */
export const SETUP_DIR = '1. Fabric/Manual setup';
export const NOTEBOOKS_DIR = `${SETUP_DIR}/notebooks`;
export const WORKDAY_NOTEBOOKS_DIR = `${NOTEBOOKS_DIR}/workday-org-data`;

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
    displayName: 'AnalyticsHub_Data_Check',
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
    key: 'workdayLander',
    file: 'Copilot_Org_Data_Workday_Lander.ipynb',
    dir: WORKDAY_NOTEBOOKS_DIR,
    displayName: 'Copilot_Org_Data_Workday_Lander',
    module: 'orgData',
    credentials: false,
    parameters: [],
    placeholder: null,
    workday: true,
    // Runs after the Graph org data load each time, so it enriches the published table itself.
    values: { OUTPUT_TABLE: 'dbo.copilot_org_data' },
    expressions: { ALLOW_BASE_OVERWRITE: 'True' },
  },
  {
    key: 'uploadRouter',
    file: 'AnalyticsHub_Upload_Router.ipynb',
    displayName: 'AnalyticsHub_Upload_Router',
    module: 'core',
    credentials: false,
    parameters: [],
    placeholder: null,
    uploads: true,
  },
  {
    key: 'resourceGraph',
    file: 'Copilot_Resource_Graph_Ingester.ipynb',
    displayName: 'Copilot_Resource_Graph_Ingester',
    module: 'core',
    credentials: true,
    parameters: [],
    placeholder: null,
    resourceGraph: true,
  },
  {
    key: 'loadStatus',
    file: 'AnalyticsHub_Load_Status.ipynb',
    displayName: 'AnalyticsHub_Load_Status',
    module: 'core',
    credentials: false,
    parameters: ['PIPELINE_RUN_ID', 'PIPELINE_TRIGGER_TIME'],
    placeholder: null,
  },
  {
    key: 'm365Activity',
    file: 'Copilot_M365_Activity_Ingester.ipynb',
    displayName: 'Copilot_M365_Activity_Ingester',
    module: 'm365Activity',
    credentials: true,
    parameters: [],
    placeholder: 'REPLACE_WITH_M365_ACTIVITY_NOTEBOOK_ID',
  },
  {
    key: 'agent365Registry',
    file: 'Copilot_Agent365_Registry_Ingester.ipynb',
    displayName: 'Copilot_Agent365_Registry_Ingester',
    module: 'agent365',
    credentials: true,
    parameters: ['TIME_BUDGET_MIN'],
    placeholder: 'REPLACE_WITH_AGENT365_REGISTRY_NOTEBOOK_ID',
    registry: true,
  },
  {
    key: 'agent365Lander',
    file: 'Copilot_Agent365_Lander.ipynb',
    displayName: 'Copilot_Agent365_Lander',
    module: 'agent365',
    credentials: false,
    parameters: [],
    placeholder: 'REPLACE_WITH_AGENT365_LANDER_NOTEBOOK_ID',
    // Without an export, an empty table keeps the Agents page dormant instead of failing the model.
    patches: [
      {
        find: '          f"Preserving any existing {OUTPUT_TABLE} snapshot.")\n',
        replace: `          f"Preserving any existing {OUTPUT_TABLE} snapshot.")
    if not _table_exists(OUTPUT_TABLE):  # Set by the Analytics Hub installer: an empty table, not a missing one
        from pyspark.sql.types import StructField, StructType, StringType, TimestampType
        _empty_cols, _ = _build_alias_plan()
        (spark.createDataFrame([], StructType([StructField(c, StringType(), True) for c in _empty_cols]
                                              + [StructField('Snapshot As Of', TimestampType(), True)]))
            .write.mode('overwrite')
            .option('delta.columnMapping.mode', 'name')
            .option('delta.minReaderVersion', '2')
            .option('delta.minWriterVersion', '5')
            .format('delta').saveAsTable(OUTPUT_TABLE))
        print(f"Created an empty {OUTPUT_TABLE}; it fills on the first run after an export is uploaded.")
`,
      },
    ],
  },
  {
    key: 'productFeedback',
    file: 'Copilot_ProductFeedback_Ingester.ipynb',
    displayName: 'Copilot_ProductFeedback_Ingester',
    module: 'productFeedback',
    credentials: false,
    parameters: [],
    placeholder: 'REPLACE_WITH_PRODUCT_FEEDBACK_NOTEBOOK_ID',
    // Until the first export is uploaded, an empty table keeps the User Feedback page dormant.
    expressions: { ALLOW_EMPTY_FIRST_SNAPSHOT: 'True' },
  },
  {
    key: 'defender',
    file: 'Copilot_Defender_Ingester.ipynb',
    displayName: 'Copilot_Defender_Ingester',
    module: 'defender',
    credentials: true,
    parameters: [],
    placeholder: 'REPLACE_WITH_DEFENDER_NOTEBOOK_ID',
  },
  {
    key: 'refreshModel',
    file: 'ValueLens_Refresh_Model.ipynb',
    displayName: 'AnalyticsHub_Refresh_Model',
    module: 'core',
    credentials: false,
    parameters: ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID', 'WRITE_MODE', 'CHECK_AUDIT_STATE'],
    placeholder: null,
    semanticModel: true,
  },
  {
    key: 'accessScope',
    file: 'AnalyticsHub_Access_Scope.ipynb',
    displayName: 'AnalyticsHub_Access_Scope',
    module: 'core',
    credentials: false,
    parameters: ['MODE', 'ROLES_B64', 'ROLES_FILE', 'WORKSPACE_ID'],
    placeholder: null,
    access: true,
  },
];

/** @typedef {{ orgData: boolean, m365Activity: boolean, agent365: boolean, productFeedback: boolean, defender?: boolean }} ModuleChoice */

/** @returns {ModuleChoice} */
export function defaultModules() {
  return {
    orgData: MODULES.orgData.defaultOn,
    m365Activity: MODULES.m365Activity.defaultOn,
    agent365: MODULES.agent365.defaultOn,
    productFeedback: MODULES.productFeedback.defaultOn,
    defender: MODULES.defender.defaultOn,
  };
}

/**
 * Org data is always on, even in records saved when it could be switched off.
 * @param {Partial<ModuleChoice> | undefined} choice
 * @returns {ModuleChoice}
 */
export function normaliseModules(choice) {
  return { ...defaultModules(), ...(choice ?? {}), orgData: true };
}

/**
 * Names of the data being collected: the essentials, then the ticked extras.
 * @param {ModuleChoice} modules
 * @returns {string[]}
 */
export function collectedLabels(modules) {
  return [...ESSENTIAL_MODULES, ...OPTIONAL_MODULES.filter((id) => modules[id])].map((id) => MODULES[id].label);
}

/**
 * @param {ModuleChoice} modules
 * @returns {ModuleId[]}
 */
export function enabledModules(modules) {
  /** @type {ModuleId[]} */
  const out = ['core'];
  if (modules.orgData) out.push('orgData');
  if (modules.m365Activity) out.push('m365Activity');
  if (modules.agent365) out.push('agent365');
  if (modules.productFeedback) out.push('productFeedback');
  if (modules.defender) out.push('defender');
  return out;
}

/**
 * Notebooks to deploy for the chosen modules, in deployment order.
 * @param {ModuleChoice} modules
 * @param {{ semanticModel?: boolean, access?: boolean, dataSources?: import('./uploads.js').DataSourceModes }} [opts]
 * @returns {NotebookInfo[]}
 */
export function notebooksFor(modules, opts = {}) {
  const on = new Set(enabledModules(modules));
  const ds = opts.dataSources;
  return NOTEBOOKS.filter(
    (nb) =>
      on.has(nb.module) &&
      (!nb.semanticModel || opts.semanticModel) &&
      (!nb.uploads || (!!ds && routerWanted(ds))) &&
      (!nb.workday || ds?.workday === 'csv') &&
      (!nb.registry || ds?.agent365 !== 'csv') &&
      (!nb.resourceGraph || ds?.resourceGraph === 'api') &&
      (!nb.access || !!opts.access),
  );
}

/**
 * Graph application permissions the app registration needs, de-duplicated and sorted.
 * Org data's User.Read.All is always included, because org data is always collected.
 * Agent 365 from its CSV export needs none of the registry's permissions.
 * @param {ModuleChoice} modules
 * @param {import('./uploads.js').DataSourceModes} [dataSources]
 * @returns {string[]}
 */
export function permissionsFor(modules, dataSources) {
  const set = new Set([...MODULES.core.permissions, ...MODULES.orgData.permissions]);
  for (const id of enabledModules(modules)) {
    if (id === 'agent365' && dataSources?.agent365 === 'csv') continue;
    for (const p of MODULES[id].permissions) set.add(p);
  }
  return [...set].sort();
}
