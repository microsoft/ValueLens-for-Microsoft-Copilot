// @ts-check
/**
 * Builds the customer's pipeline from the repo template: real IDs in, unused
 * branches out, and run-time parameters for the audit load mode.
 */
import { NOTEBOOKS } from '../catalog.js';

/** Activities whose notebooks are archived. The installer never deploys them. */
export const ARCHIVED_ACTIVITIES = ['Conditionally_Run_Dataverse_Transcripts', 'Conditionally_Run_Credit_Consumption'];
export const ARCHIVED_PARAMETERS = ['EnableDataverse', 'EnableConsumption'];

/** Module branches in the template, so they can be dropped when a module is off. */
const MODULE_BRANCHES = {
  orgData: { activities: ['Conditionally_Run_Org_Data'], parameter: 'EnableOrgDataPull' },
  m365Activity: { activities: ['Conditionally_Run_M365_Activity'], parameter: 'EnableM365Activity' },
  agent365: { activities: ['Conditionally_Run_Agent365', 'Run_Agent365_CSV_Fallback'], parameter: 'EnableAgent365' },
  productFeedback: { activities: ['Conditionally_Run_Product_Feedback'], parameter: 'EnableProductFeedback' },
};

/**
 * Pipeline parameters the installer adds. Their defaults are what the schedule runs;
 * the first run overrides them for the backfill.
 */
export const RUN_PARAMETERS = {
  AuditMode: { type: 'String', defaultValue: 'incremental' },
  BackfillDays: { type: 'Int', defaultValue: 180 },
  ProcessorWriteMode: { type: 'String', defaultValue: 'merge' },
};

/** Notebook parameters bound to the pipeline parameters above, per activity. */
const BINDINGS = {
  Run_Audit_Log_Ingester: {
    MODE: { parameter: 'AuditMode', type: 'string' },
    BACKFILL_DAYS: { parameter: 'BackfillDays', type: 'int' },
  },
  Run_Audit_Log_Processor: {
    WRITE_MODE: { parameter: 'ProcessorWriteMode', type: 'string' },
  },
};

/**
 * @typedef {object} PipelineSettings
 * @property {string} workspaceId
 * @property {Partial<Record<import('../catalog.js').NotebookKey, string>>} notebookIds
 * @property {import('../catalog.js').ModuleChoice} modules
 * @property {number} [backfillDays]  Default for BackfillDays.
 * @property {string} [semanticModelId]  Adds a last step that refreshes this model.
 * @property {boolean} [azureAi]  Runs the Azure AI notebook (credit consumption).
 * @property {string} [consumptionModelId]  Adds a step that refreshes the consumption model.
 * @property {boolean} [agentTranscripts]  Runs the Agent Evaluator transcript parser.
 * @property {string} [agentEvaluatorModelId]  Adds a step that refreshes the Agent Evaluator model.
 * @property {boolean} [uploadRouter]  Runs the upload router first in lane 2, so uploaded CSVs reach their loads.
 * @property {boolean} [workday]  Enriches org data from the uploaded Workday export after the Entra ID load.
 * @property {boolean} [agent365Csv]  Agent 365 comes from its admin center export: the lander replaces the registry load.
 */

export const REFRESH_ACTIVITY = 'Refresh_Semantic_Model';
export const CONSUMPTION_REFRESH_ACTIVITY = 'Refresh_Consumption_Model';
export const AGENT_EVALUATOR_ACTIVITY = 'Run_Agent_Evaluator_Transcripts';
export const AGENT_EVALUATOR_REFRESH_ACTIVITY = 'Refresh_Agent_Evaluator_Model';

/** Days of transcripts each scheduled run re-reads. Merge keeps the overlap from duplicating. */
export const TRANSCRIPT_LOOKBACK_DAYS = 14;

/** The credit consumption notebooks, as pipeline activities. */
export const CONSUMPTION_ACTIVITIES = /** @type {const} */ ([
  {
    key: 'azureAi',
    name: 'Run_Consumption_Azure_AI',
    description: 'Azure AI spend from Cost Management and token use from Azure Monitor for one subscription, plus Copilot pay-as-you-go from each billing policy\'s subscription. Writes azure_ai_spend, azure_ai_tokens and copilot_payg_spend.',
    timeout: '0.01:00:00',
  },
  {
    key: 'studioConsumption',
    name: 'Run_Consumption_Studio',
    description: 'Loads the Copilot Studio exports from Files/landing/studio. Writes studio_tenant_daily, studio_agent and studio_user. Does nothing when the folder is empty.',
    timeout: '0.00:30:00',
  },
  {
    key: 'vivaConsumption',
    name: 'Run_Consumption_Viva',
    description: 'Loads Viva Insights Copilot credit CSVs from Files/landing/viva. Writes viva_credits_weekly and viva_spending_policy. Does nothing when the folder is empty.',
    timeout: '0.00:30:00',
  },
]);

/** The template's Agent 365 load. Without an Agent 365 licence it fails every time, and the fallback stands in. */
export const AGENT365_REGISTRY = 'Run_Agent365_Registry_Ingester';
/** The template's fallback, which runs only when the Agent 365 load fails. */
export const AGENT365_FALLBACK = 'Run_Agent365_CSV_Fallback';

/** In CSV mode, the Agent 365 branch runs the lander under this name instead of the registry load. */
export const AGENT365_LANDER = 'Run_Agent365_Lander';
export const UPLOAD_ROUTER_ACTIVITY = 'Run_Upload_Router';
export const WORKDAY_ACTIVITY = 'Run_Org_Data_Workday';

/** Bump when the pipeline's layout changes, so re-running the installer updates a pipeline an older version built. */
export const PIPELINE_VERSION = 3;
/** What this version changed, for people whose pipeline an older version built. */
export const PIPELINE_CHANGE =
  'This version runs the loads in two lanes so a trial or small capacity isn\'t overloaded, and first routes any CSV exports dropped in Files/analytics_hub_uploads to the load that reads them.';

/**
 * Lane 2: every step except the audit log, its processor and the semantic model refresh, one after
 * another while lane 1 runs. A trial or small capacity can start only a few notebooks at once and
 * turns the rest away.
 */
export const LANE_ORDER = [
  'Run_Licensed_Users_Ingester',
  UPLOAD_ROUTER_ACTIVITY,
  'Conditionally_Run_Agent365',
  AGENT365_FALLBACK,
  'Conditionally_Run_Org_Data',
  WORKDAY_ACTIVITY,
  'Conditionally_Run_M365_Activity',
  'Conditionally_Run_Product_Feedback',
  ...ARCHIVED_ACTIVITIES,
  ...CONSUMPTION_ACTIVITIES.map((a) => a.name),
  CONSUMPTION_REFRESH_ACTIVITY,
  AGENT_EVALUATOR_ACTIVITY,
  AGENT_EVALUATOR_REFRESH_ACTIVITY,
];

/** Lane 2 steps that keep their own conditions. Each already waits for the step before it. */
const OWN_CONDITIONS = new Set([AGENT365_FALLBACK, CONSUMPTION_REFRESH_ACTIVITY, AGENT_EVALUATOR_REFRESH_ACTIVITY]);

/**
 * Chains the lane 2 steps that are present. Each waits for the one before it to finish, whether it
 * succeeded or failed. The fallback and the two model refreshes keep their own conditions, and the
 * next step also runs when one of them is skipped.
 * @param {any[]} activities  Top-level activities.
 */
export function chainLanes(activities) {
  /** @type {{ activity: string, dependencyConditions: string[] } | undefined} */
  let after;
  for (const name of LANE_ORDER) {
    const activity = activities.find((a) => a.name === name);
    if (!activity) continue;
    const own = OWN_CONDITIONS.has(name);
    if (!own) activity.dependsOn = after ? [after] : [];
    after = { activity: name, dependencyConditions: own ? ['Completed', 'Skipped'] : ['Completed'] };
  }
}

/** Seconds between retries: long enough for a busy capacity to free up. */
export const RETRY_INTERVAL_SECONDS = 300;

/**
 * A load that runs for up to an hour or more retries twice; a shorter one three times.
 * @param {string | undefined} timeout  Activity timeout, as d.hh:mm:ss.
 */
export function retryPolicy(timeout) {
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(timeout ?? '');
  const long = !m || Number(m[1] ?? 0) > 0 || Number(m[2]) >= 1;
  return { retry: long ? 2 : 3, retryIntervalInSeconds: RETRY_INTERVAL_SECONDS };
}

/**
 * Applies `retryPolicy` to every notebook, including those inside IfCondition branches. The Agent 365
 * load keeps the template's policy: its fallback covers a failure, and longer retries would only delay it.
 * @param {any[]} activities
 */
export function applyRetries(activities) {
  for (const a of notebookActivities(activities)) {
    if (a.name !== AGENT365_REGISTRY) a.policy = { ...a.policy, ...retryPolicy(a.policy?.timeout) };
  }
}

/**
 * @param {any[]} activities
 * @returns {Generator<any>}
 */
function* notebookActivities(activities) {
  for (const a of activities) {
    if (a.type === 'TridentNotebook') yield a;
    yield* notebookActivities([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])]);
  }
}

/**
 * A step that runs ValueLens_Refresh_Model against one model.
 * @param {PipelineSettings} settings
 * @param {{ name: string, description: string, modelId: string, dependsOn: any[], writeMode: any }} o
 */
function refreshStep(settings, o) {
  const notebookId = settings.notebookIds.refreshModel;
  if (!notebookId) throw new Error('The semantic model refresh notebook has not been deployed.');
  return {
    name: o.name,
    description: o.description,
    type: 'TridentNotebook',
    dependsOn: o.dependsOn,
    policy: { timeout: '0.03:00:00', retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false },
    typeProperties: {
      notebookId,
      workspaceId: settings.workspaceId,
      parameters: {
        WORKSPACE_ID: { value: settings.workspaceId, type: 'string' },
        SEMANTIC_MODEL_ID: { value: o.modelId, type: 'string' },
        WRITE_MODE: { value: o.writeMode, type: 'string' },
      },
    },
  };
}

/**
 * Runs once the curated table is built and the optional tables have had their turn,
 * so the model never reads a half-loaded Lakehouse.
 * @param {any[]} activities
 * @param {PipelineSettings} settings
 */
function refreshActivity(activities, settings) {
  const has = (/** @type {string} */ name) => activities.some((a) => a.name === name);
  const dependsOn = [{ activity: 'Run_Audit_Log_Processor', dependencyConditions: ['Succeeded'] }];
  for (const name of ['Conditionally_Run_Org_Data', WORKDAY_ACTIVITY, 'Conditionally_Run_M365_Activity', 'Conditionally_Run_Product_Feedback']) {
    if (has(name)) dependsOn.push({ activity: name, dependencyConditions: ['Completed'] });
  }
  return refreshStep(settings, {
    name: REFRESH_ACTIVITY,
    description: 'Refreshes the ValueLens semantic model. After a backfill it reloads every partition of the audit table.',
    modelId: /** @type {string} */ (settings.semanticModelId),
    dependsOn,
    writeMode: { value: '@pipeline().parameters.ProcessorWriteMode', type: 'Expression' },
  });
}

/**
 * One activity per consumption notebook. `chainLanes` puts them in lane 2.
 * @param {PipelineSettings} settings
 */
function consumptionActivities(settings) {
  return CONSUMPTION_ACTIVITIES.filter((a) => a.key !== 'azureAi' || settings.azureAi).map((/** @type {{ key: 'azureAi' | 'studioConsumption' | 'vivaConsumption', name: string, description: string, timeout: string }} */ a) => {
    const notebookId = settings.notebookIds[a.key];
    if (!notebookId) throw new Error(`The ${a.name.replace(/^Run_/, '').replace(/_/g, ' ')} notebook has not been deployed.`);
    return {
      name: a.name,
      description: a.description,
      type: 'TridentNotebook',
      dependsOn: [],
      policy: { timeout: a.timeout, ...retryPolicy(a.timeout), secureOutput: false, secureInput: false },
      typeProperties: { notebookId, workspaceId: settings.workspaceId, parameters: {} },
    };
  });
}

/**
 * Refreshes the consumption model only when every consumption load succeeded, so a
 * failed collection never shows up as an empty page.
 * @param {any[]} activities
 * @param {PipelineSettings} settings
 */
function consumptionRefreshActivity(activities, settings) {
  const dependsOn = activities
    .filter((a) => CONSUMPTION_ACTIVITIES.some((c) => c.name === a.name))
    .map((a) => ({ activity: a.name, dependencyConditions: ['Succeeded'] }));
  dependsOn.push(...orgDataDependencies(activities));
  return refreshStep(settings, {
    name: CONSUMPTION_REFRESH_ACTIVITY,
    description: 'Refreshes the consumption model once every consumption load has succeeded.',
    modelId: /** @type {string} */ (settings.consumptionModelId),
    dependsOn,
    writeMode: 'merge',
  });
}

/**
 * Reads Copilot Studio transcripts from Dataverse. A backfill reads as far back as the audit load.
 * @param {PipelineSettings} settings
 */
function agentTranscriptsActivity(settings) {
  const notebookId = settings.notebookIds.agentTranscripts;
  if (!notebookId) throw new Error('The Copilot Studio transcript notebook has not been deployed.');
  return {
    name: AGENT_EVALUATOR_ACTIVITY,
    description: 'Reads Copilot Studio conversation transcripts from each chosen Dataverse environment and merges them into agent_sessions, agent_turns and the other agent tables.',
    type: 'TridentNotebook',
    dependsOn: [],
    policy: { timeout: '0.02:00:00', ...retryPolicy('0.02:00:00'), secureOutput: false, secureInput: false },
    typeProperties: {
      notebookId,
      workspaceId: settings.workspaceId,
      parameters: {
        LOOKBACK_DAYS: {
          value: {
            value: `@if(equals(pipeline().parameters.AuditMode, 'backfill'), pipeline().parameters.BackfillDays, ${TRANSCRIPT_LOOKBACK_DAYS})`,
            type: 'Expression',
          },
          type: 'int',
        },
      },
    },
  };
}

/**
 * Refreshes the Agent Evaluator model once the transcripts have loaded and the org data has had its turn.
 * @param {any[]} activities
 * @param {PipelineSettings} settings
 */
function agentEvaluatorRefreshActivity(activities, settings) {
  const dependsOn = [{ activity: AGENT_EVALUATOR_ACTIVITY, dependencyConditions: ['Succeeded'] }, ...orgDataDependencies(activities)];
  return refreshStep(settings, {
    name: AGENT_EVALUATOR_REFRESH_ACTIVITY,
    description: 'Refreshes the Agent Evaluator model once the transcripts have loaded.',
    modelId: /** @type {string} */ (settings.agentEvaluatorModelId),
    dependsOn,
    writeMode: 'merge',
  });
}

/**
 * A model refresh waits for the org data loads that are present, whether they succeeded or not.
 * @param {any[]} activities
 */
function orgDataDependencies(activities) {
  return ['Conditionally_Run_Org_Data', WORKDAY_ACTIVITY]
    .filter((name) => activities.some((a) => a.name === name))
    .map((name) => ({ activity: name, dependencyConditions: ['Completed'] }));
}

/**
 * A notebook step with no parameters. `chainLanes` sets its place in lane 2.
 * @param {PipelineSettings} settings
 * @param {{ key: import('../catalog.js').NotebookKey, name: string, description: string, timeout: string }} o
 */
function notebookStep(settings, o) {
  const notebookId = settings.notebookIds[o.key];
  if (!notebookId) throw new Error(`The ${o.name.replace(/^Run_/, '').replace(/_/g, ' ')} notebook has not been deployed.`);
  return {
    name: o.name,
    description: o.description,
    type: 'TridentNotebook',
    dependsOn: [],
    policy: { timeout: o.timeout, ...retryPolicy(o.timeout), secureOutput: false, secureInput: false },
    typeProperties: { notebookId, workspaceId: settings.workspaceId, parameters: {} },
  };
}

/**
 * Agent 365 from its export: the branch runs the lander, and there is no registry load to fall back from.
 * The processor, which waited for the fallback, waits for the branch instead.
 * @param {any[]} activities
 */
function agent365FromCsv(activities) {
  const branch = activities.find((a) => a.name === 'Conditionally_Run_Agent365');
  const inner = branch && findActivity([branch], AGENT365_REGISTRY);
  if (!inner) throw new Error(`Pipeline template is missing ${AGENT365_REGISTRY}.`);
  inner.name = AGENT365_LANDER;
  inner.description = 'Loads the Agent 365 export from Files/agent365/agents.csv into agent_365_registry.';
  inner.typeProperties.notebookId = 'REPLACE_WITH_AGENT365_LANDER_NOTEBOOK_ID';
  const processor = activities.find((a) => a.name === 'Run_Audit_Log_Processor');
  if (processor) processor.dependsOn = [...(processor.dependsOn ?? []), { activity: branch.name, dependencyConditions: ['Completed'] }];
}

/**
 * @param {any} template  Parsed `pipeline-content.json`.
 * @param {PipelineSettings} settings
 */
export function buildPipeline(template, settings) {
  const doc = structuredClone(template);
  const props = doc.properties;
  if (!props || !Array.isArray(props.activities)) throw new Error('Pipeline template has no activities.');

  const drop = new Set(ARCHIVED_ACTIVITIES);
  const dropParams = new Set(ARCHIVED_PARAMETERS);
  for (const [module, branch] of Object.entries(MODULE_BRANCHES)) {
    const on = settings.modules[/** @type {keyof typeof MODULE_BRANCHES} */ (module)];
    if (on) {
      if (props.parameters?.[branch.parameter]) props.parameters[branch.parameter].defaultValue = true;
    } else {
      branch.activities.forEach((a) => drop.add(a));
      dropParams.add(branch.parameter);
    }
  }
  const agent365Csv = !!(settings.modules.agent365 && settings.agent365Csv);
  if (agent365Csv) drop.add(AGENT365_FALLBACK);

  props.activities = props.activities.filter((/** @type {any} */ a) => !drop.has(a.name));
  for (const activity of props.activities) {
    if (Array.isArray(activity.dependsOn)) {
      activity.dependsOn = activity.dependsOn.filter((/** @type {any} */ d) => !drop.has(d.activity));
    }
  }
  for (const name of dropParams) delete props.parameters?.[name];
  if (agent365Csv) agent365FromCsv(props.activities);

  props.parameters = { ...(props.parameters ?? {}), ...structuredClone(RUN_PARAMETERS) };
  if (settings.backfillDays) props.parameters.BackfillDays.defaultValue = settings.backfillDays;

  for (const [activityName, params] of Object.entries(BINDINGS)) {
    const activity = findActivity(props.activities, activityName);
    if (!activity) throw new Error(`Pipeline template is missing ${activityName}.`);
    activity.typeProperties.parameters = activity.typeProperties.parameters ?? {};
    for (const [notebookParam, { parameter, type }] of Object.entries(params)) {
      activity.typeProperties.parameters[notebookParam] = {
        value: { value: `@pipeline().parameters.${parameter}`, type: 'Expression' },
        type,
      };
    }
  }

  /** @type {Record<string, string>} */
  const ids = { REPLACE_WITH_WORKSPACE_ID: settings.workspaceId };
  for (const nb of NOTEBOOKS) {
    const id = settings.notebookIds[nb.key];
    if (nb.placeholder && id) ids[nb.placeholder] = id;
  }
  const filled = replacePlaceholders(doc, ids);

  const left = [...JSON.stringify(filled).matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((m) => m[0]);
  if (left.length) throw new Error(`Pipeline still has placeholders: ${[...new Set(left)].join(', ')}`);

  applyRetries(filled.properties.activities);
  if (settings.uploadRouter) {
    filled.properties.activities.push(
      notebookStep(settings, {
        key: 'uploadRouter',
        name: UPLOAD_ROUTER_ACTIVITY,
        description: 'Moves each CSV export dropped in Files/analytics_hub_uploads to the folder its load reads, recognised by its headers. Does nothing when the folder is empty.',
        timeout: '0.00:30:00',
      }),
    );
  }
  const workday = !!(settings.workday && settings.modules.orgData !== false);
  if (workday) {
    filled.properties.activities.push(
      notebookStep(settings, {
        key: 'workdayLander',
        name: WORKDAY_ACTIVITY,
        description: 'Adds or overrides org fields in copilot_org_data from the Workday export in Files/org_workday. Does nothing without an export.',
        timeout: '0.00:30:00',
      }),
    );
  }
  if (settings.semanticModelId) filled.properties.activities.push(refreshActivity(filled.properties.activities, settings));
  if (settings.modules.consumption) {
    filled.properties.activities.push(...consumptionActivities(settings));
    if (settings.consumptionModelId) filled.properties.activities.push(consumptionRefreshActivity(filled.properties.activities, settings));
  }
  const transcripts = !!(settings.modules.agentEvaluator && settings.agentTranscripts);
  if (transcripts) {
    filled.properties.activities.push(agentTranscriptsActivity(settings));
    if (settings.agentEvaluatorModelId) filled.properties.activities.push(agentEvaluatorRefreshActivity(filled.properties.activities, settings));
  }
  chainLanes(filled.properties.activities);

  filled.properties.description =
    'Created by the Analytics Hub installer. The loads run in two lanes rather than all at once, so a trial or small capacity isn\'t overloaded. ' +
    `Lane 1 loads the audit log, then runs the Audit Log Processor${settings.semanticModelId ? ', then refreshes the semantic model' : ''}. ` +
    'Lane 2 runs the other loads one after another; a load that fails doesn\'t stop the next. ' +
    `${settings.uploadRouter ? 'Lane 2 starts by routing any CSV exports dropped in Files/analytics_hub_uploads to the loads that read them. ' : ''}` +
    `${settings.modules.consumption ? `The credit consumption loads run in lane 2${settings.consumptionModelId ? ' and refresh the consumption model when they all succeed' : ''}. ` : ''}` +
    `${transcripts ? `The Agent Evaluator reads Copilot Studio transcripts at the end of lane 2${settings.agentEvaluatorModelId ? ', then refreshes its model' : ''}. ` : ''}` +
    `Each load retries up to 3 times, ${RETRY_INTERVAL_SECONDS / 60} minutes apart. ` +
    'Scheduled runs use the parameter defaults (incremental audit load, merge into the curated table). ' +
    'The first run overrides them with AuditMode=backfill and ProcessorWriteMode=overwrite. ' +
    'Re-run the installer with "update" to pick up new notebook and pipeline versions.';
  return filled;
}

/**
 * Depth-first search, including activities nested in IfCondition branches.
 * @param {any[]} activities
 * @param {string} name
 * @returns {any}
 */
export function findActivity(activities, name) {
  for (const a of activities) {
    if (a.name === name) return a;
    const nested = [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])];
    const hit = nested.length ? findActivity(nested, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/**
 * @param {any} value
 * @param {Record<string, string>} ids
 * @returns {any}
 */
function replacePlaceholders(value, ids) {
  if (typeof value === 'string') return Object.prototype.hasOwnProperty.call(ids, value) ? ids[value] : value;
  if (Array.isArray(value)) return value.map((v) => replacePlaceholders(v, ids));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replacePlaceholders(v, ids)]));
  }
  return value;
}

/**
 * Parameters for the first run: a backfill that rebuilds the curated table.
 * @param {number} days
 */
export function firstRunParameters(days) {
  return { AuditMode: 'backfill', BackfillDays: days, ProcessorWriteMode: 'overwrite' };
}
