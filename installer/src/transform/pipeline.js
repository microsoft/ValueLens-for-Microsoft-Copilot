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
  defender: { activities: ['Conditionally_Run_Defender'], parameter: 'EnableDefender' },
};

/**
 * Pipeline parameters the installer adds. Their defaults are what the schedule runs;
 * the first run overrides them for the backfill.
 */
export const RUN_PARAMETERS = {
  AuditMode: { type: 'String', defaultValue: 'incremental' },
  BackfillDays: { type: 'Int', defaultValue: 30 },
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

/** @typedef {'standard' | 'large'} TenantScale */

/**
 * How the loads are sized for the tenant. Standard keeps the template's timeouts for the core loads and
 * pulls the audit log in day-long windows, so a small tenant sends few queries. Large is for tens of thousands of
 * users: the audit service fails long windows on busy tenants, so it pulls 2-hour windows, splits a
 * failing one after a single retry, re-reads 3 trailing days rather than 7 to keep the daily query count
 * down, and gives the Graph loads and the model refresh more time.
 *
 * `budget` is the audit load's TIME_BUDGET_MIN: it stops starting windows in time to write what it has
 * fetched before the activity timeout, and the retry carries on where it stopped.
 *
 * Both sizes give the slow Graph loads more time than the template: the Agent 365 registry reads every
 * agent's detail, and on a large tenant its weekly refresh outgrew the template's 2 hours. `registry`
 * sets that load's TIME_BUDGET_MIN, after which it leaves scheduled refreshes to the next run and writes
 * what it has, and its retry count (the CSV fallback covers a failure, so it keeps its own).
 * @type {Record<TenantScale, ScaleProfile>}
 */
export const SCALE_PROFILES = {
  standard: {
    audit: { CHUNK_HOURS: 24, TIME_BUDGET_MIN: 90 },
    timeouts: {
      Run_Agent365_Registry_Ingester: '0.03:00:00',
      Run_Defender_Ingester: '0.01:00:00',
    },
    registry: { budget: 120, retry: 1 },
    refresh: { timeout: '0.03:00:00', minutes: 170 },
  },
  large: {
    audit: { CHUNK_HOURS: 2, WINDOW_RETRIES: 1, LOOKBACK_DAYS: 3, TIME_BUDGET_MIN: 300 },
    timeouts: {
      Run_Audit_Log_Ingester: '0.06:00:00',
      Run_Audit_Log_Processor: '0.03:00:00',
      Run_Licensed_Users_Ingester: '0.00:30:00',
      Run_Org_Data_Ingester: '0.01:00:00',
      Run_M365_Activity_Ingester: '0.02:00:00',
      Run_Agent365_Registry_Ingester: '0.06:00:00',
      Run_Defender_Ingester: '0.02:00:00',
    },
    registry: { budget: 270, retry: 2 },
    refresh: { timeout: '0.05:00:00', minutes: 290 },
  },
};

/**
 * @typedef {object} ScaleProfile
 * @property {Record<string, number>} audit  The audit load's window size, retries and time budget.
 * @property {Record<string, string>} timeouts  Activity timeouts that replace the template's.
 * @property {{ budget: number, retry: number }} [registry]  The Agent 365 registry load's TIME_BUDGET_MIN and retry count.
 * @property {{ timeout: string, minutes: number }} refresh
 */

/**
 * An install from before tenant sizes keeps the template's windows and time limits until someone picks a
 * size, so a large tenant isn't moved to day-long windows by an update. It only gains the time budget,
 * so a long load that runs out of time is carried on by the retry. The registry load keeps the
 * notebook's own budget, which fits the template's 2 hours.
 * @type {ScaleProfile}
 */
export const UNSIZED_PROFILE = { audit: { TIME_BUDGET_MIN: 90 }, timeouts: {}, refresh: SCALE_PROFILES.standard.refresh };

/** @param {TenantScale | undefined} scale */
export const scaleProfile = (scale) => (scale === 'large' || scale === 'standard' ? SCALE_PROFILES[scale] : UNSIZED_PROFILE);

/**
 * @typedef {object} PipelineSettings
 * @property {string} workspaceId
 * @property {TenantScale} [scale]  Sizes windows, budgets and timeouts. Absent on an install from before tenant sizes: see UNSIZED_PROFILE.
 * @property {Partial<Record<import('../catalog.js').NotebookKey, string>>} notebookIds
 * @property {import('../catalog.js').ModuleChoice} modules
 * @property {number} [backfillDays]  Default for BackfillDays.
 * @property {string} [semanticModelId]  Adds a last step that refreshes this model.
 * @property {boolean} [uploadRouter]  Runs the upload router first in lane 2, so uploaded CSVs reach their loads.
 * @property {boolean} [workday]  Enriches org data from the uploaded Workday export after the Entra ID load.
 * @property {boolean} [agent365Csv]  Agent 365 comes from its admin center export: the lander replaces the registry load.
 * @property {boolean} [resourceGraph]  Reads agent configuration and Foundry from Azure Resource Graph, after Agent 365.
 * @property {boolean} [access]  Org-scoped access is on: loads the access tables after org data, before the model refreshes.
 */

export const REFRESH_ACTIVITY = 'Refresh_Semantic_Model';
/** Loads access_scope and rebuilds access_people. Only with org-scoped access on. */
export const ACCESS_ACTIVITY = 'Run_Access_Scope';

/** The template's Agent 365 load. Without an Agent 365 licence it fails every time, and the fallback stands in. */
export const AGENT365_REGISTRY = 'Run_Agent365_Registry_Ingester';
/** The template's fallback, which runs only when the Agent 365 load fails. */
export const AGENT365_FALLBACK = 'Run_Agent365_CSV_Fallback';

/** In CSV mode, the Agent 365 branch runs the lander under this name instead of the registry load. */
export const AGENT365_LANDER = 'Run_Agent365_Lander';
export const UPLOAD_ROUTER_ACTIVITY = 'Run_Upload_Router';
export const WORKDAY_ACTIVITY = 'Run_Org_Data_Workday';
/** Agent configuration and Foundry from Azure Resource Graph. It never fails for want of access: the notebook records that in arg_status. */
export const RESOURCE_GRAPH_ACTIVITY = 'Run_Resource_Graph_Ingester';

/** Bump when the pipeline's layout changes, so re-running the installer updates a pipeline an older version built. */
export const PIPELINE_VERSION = 7;
/** What this version changed, for people whose pipeline an older version built. */
export const PIPELINE_CHANGE =
  'This version gives the Agent 365 registry and Defender loads more time, sized by tenant size, and gives the registry load a time budget so a long weekly refresh finishes on the next run instead of timing out. Your data and settings are kept.';

/** Notebooks with the same tag share one high-concurrency Spark session (letters, digits and underscores only). */
export const SESSION_TAG = 'analytics_hub';
/** Last step: records each load's outcome in dbo.load_log and fails the run when a load failed. */
export const STATUS_ACTIVITY = 'Record_Load_Status';

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
  RESOURCE_GRAPH_ACTIVITY,
  'Conditionally_Run_Org_Data',
  WORKDAY_ACTIVITY,
  ACCESS_ACTIVITY,
  'Conditionally_Run_M365_Activity',
  'Conditionally_Run_Product_Feedback',
  'Conditionally_Run_Defender',
  ...ARCHIVED_ACTIVITIES,
];

/** Lane 2 steps that keep their own conditions. Each already waits for the step before it. */
const OWN_CONDITIONS = new Set([AGENT365_FALLBACK]);

/**
 * Chains the lane 2 steps that are present. Each waits for the one before it to finish, whether it
 * succeeded or failed. The fallback keeps its own conditions, and the next step also runs when it
 * is skipped.
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
 * Every notebook, including those in IfCondition branches, joins one high-concurrency session.
 * Fabric starts a new session for the sixth notebook, or when the Lakehouse or Spark settings differ.
 * @param {any[]} activities
 */
export function applySessionTag(activities) {
  for (const a of notebookActivities(activities)) a.typeProperties = { ...a.typeProperties, sessionTag: SESSION_TAG };
}

/**
 * The status step waits for every activity nothing else waits for, whether it succeeded, failed or
 * was skipped. Being the only last step, its result is the run's result.
 * @param {any[]} activities  Top-level activities.
 * @param {PipelineSettings} settings
 */
function statusActivity(activities, settings) {
  const waitedOn = new Set(activities.flatMap((a) => (a.dependsOn ?? []).map((/** @type {any} */ d) => d.activity)));
  return {
    name: STATUS_ACTIVITY,
    description: 'Records how each load went in dbo.load_log, in plain words, and fails the run when a load failed so the failure is visible in the run history.',
    type: 'TridentNotebook',
    dependsOn: activities
      .filter((a) => !waitedOn.has(a.name))
      .map((a) => ({ activity: a.name, dependencyConditions: ['Completed', 'Skipped'] })),
    policy: { timeout: '0.00:20:00', retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false },
    typeProperties: {
      notebookId: settings.notebookIds.loadStatus,
      workspaceId: settings.workspaceId,
      parameters: {
        PIPELINE_RUN_ID: { value: { value: '@pipeline().RunId', type: 'Expression' }, type: 'string' },
        PIPELINE_TRIGGER_TIME: { value: { value: '@string(pipeline().TriggerTime)', type: 'Expression' }, type: 'string' },
      },
    },
  };
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
 * A step that runs the Refresh Model notebook against one model.
 * @param {PipelineSettings} settings
 * @param {{ name: string, description: string, modelId: string, dependsOn: any[], writeMode: any }} o
 */
function refreshStep(settings, o) {
  const notebookId = settings.notebookIds.refreshModel;
  if (!notebookId) throw new Error('The semantic model refresh notebook has not been deployed.');
  const { refresh } = scaleProfile(settings.scale);
  return {
    name: o.name,
    description: o.description,
    type: 'TridentNotebook',
    dependsOn: o.dependsOn,
    policy: { timeout: refresh.timeout, retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false },
    typeProperties: {
      notebookId,
      workspaceId: settings.workspaceId,
      parameters: {
        WORKSPACE_ID: { value: settings.workspaceId, type: 'string' },
        SEMANTIC_MODEL_ID: { value: o.modelId, type: 'string' },
        WRITE_MODE: { value: o.writeMode, type: 'string' },
        CHECK_AUDIT_STATE: { value: o.name === REFRESH_ACTIVITY, type: 'bool' },
        TIMEOUT_MINUTES: { value: refresh.minutes, type: 'int' },
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
  for (const name of [RESOURCE_GRAPH_ACTIVITY, 'Conditionally_Run_Org_Data', WORKDAY_ACTIVITY, ACCESS_ACTIVITY, 'Conditionally_Run_M365_Activity', 'Conditionally_Run_Product_Feedback', 'Conditionally_Run_Defender']) {
    if (has(name)) dependsOn.push({ activity: name, dependencyConditions: ['Completed'] });
  }
  return refreshStep(settings, {
    name: REFRESH_ACTIVITY,
    description: 'Refreshes ValueLens, including historical audit partitions changed by processing or conversation updates.',
    modelId: /** @type {string} */ (settings.semanticModelId),
    dependsOn,
    writeMode: { value: '@pipeline().parameters.ProcessorWriteMode', type: 'Expression' },
  });
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
  applyScale(props.activities, scaleProfile(settings.scale));

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
  if (settings.resourceGraph) {
    filled.properties.activities.push(
      notebookStep(settings, {
        key: 'resourceGraph',
        name: RESOURCE_GRAPH_ACTIVITY,
        description: 'Reads Copilot Studio agent configuration, Power Platform environments, agent flows and Foundry resources from Azure Resource Graph, or the agent inventory flow\'s newest file in Files/arg_inventory. Writes arg_agent_config, arg_environments, arg_agent_flows, arg_foundry_resources and arg_status; what it can\'t read is recorded there, not failed.',
        timeout: '0.00:30:00',
      }),
    );
  }
  if (workday) {
    filled.properties.activities.push(
      notebookStep(settings, {
        key: 'workdayLander',
        name: WORKDAY_ACTIVITY,
        description: 'Adds the columns of the Workday export in Files/org_workday that copilot_org_data doesn\'t have. Existing columns aren\'t changed or filled in. Does nothing without an export.',
        timeout: '0.00:30:00',
      }),
    );
  }
  if (settings.access) {
    filled.properties.activities.push(
      notebookStep(settings, {
        key: 'accessScope',
        name: ACCESS_ACTIVITY,
        description: 'Org-scoped access: loads who sees what from Files/analytics_hub_access/access_scope.csv into access_scope, and rebuilds access_people from org data, so the models refresh with current scopes.',
        timeout: '0.00:20:00',
      }),
    );
  }
  if (settings.semanticModelId) filled.properties.activities.push(refreshActivity(filled.properties.activities, settings));
  chainLanes(filled.properties.activities);
  const status = !!settings.notebookIds.loadStatus;
  if (status) filled.properties.activities.push(statusActivity(filled.properties.activities, settings));
  applySessionTag(filled.properties.activities);

  filled.properties.description =
    'Created by the Analytics Hub installer. The loads run in two lanes rather than all at once, so a trial or small capacity isn\'t overloaded. ' +
    'Every notebook shares one Spark session (high concurrency for pipelines must be on in the workspace\'s Spark settings). ' +
    `Lane 1 loads the audit log, then runs the Audit Log Processor${settings.semanticModelId ? ', then refreshes the semantic model' : ''}. ` +
    'Lane 2 runs the other loads one after another; a load that fails doesn\'t stop the next. ' +
    `${settings.uploadRouter ? 'Lane 2 starts by routing any CSV exports dropped in Files/analytics_hub_uploads to the loads that read them. ' : ''}` +
    `${status ? `${STATUS_ACTIVITY} runs last: it writes each load's outcome to dbo.load_log and fails the run if any load failed. ` : ''}` +
    `Each load retries up to 3 times, ${RETRY_INTERVAL_SECONDS / 60} minutes apart. ` +
    'Scheduled runs use the parameter defaults (incremental audit load, merge into the curated table). ' +
    'The first run overrides them with AuditMode=backfill and ProcessorWriteMode=overwrite. ' +
    'Re-run the installer with "update" to pick up new notebook and pipeline versions.';
  return filled;
}

/**
 * Fixes the audit load's window size and budget, lengthens the timeouts the profile names, and sets the
 * Agent 365 registry load's budget and retries. Runs before `applyRetries`, which reads the timeouts
 * and leaves the registry load's retries alone.
 * @param {any[]} activities
 * @param {ScaleProfile} profile
 */
function applyScale(activities, profile) {
  const audit = findActivity(activities, 'Run_Audit_Log_Ingester');
  for (const [name, value] of Object.entries(profile.audit)) audit.typeProperties.parameters[name] = { value, type: 'int' };
  for (const [name, timeout] of Object.entries(profile.timeouts)) {
    const activity = findActivity(activities, name);
    if (activity) activity.policy = { ...activity.policy, timeout };
  }
  const registry = profile.registry && findActivity(activities, AGENT365_REGISTRY);
  if (registry && profile.registry) {
    registry.typeProperties.parameters = { ...registry.typeProperties.parameters, TIME_BUDGET_MIN: { value: profile.registry.budget, type: 'int' } };
    registry.policy = { ...registry.policy, retry: profile.registry.retry };
  }
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
