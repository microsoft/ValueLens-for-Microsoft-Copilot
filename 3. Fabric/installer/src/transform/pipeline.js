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
 */

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

  props.activities = props.activities.filter((/** @type {any} */ a) => !drop.has(a.name));
  for (const activity of props.activities) {
    if (Array.isArray(activity.dependsOn)) {
      activity.dependsOn = activity.dependsOn.filter((/** @type {any} */ d) => !drop.has(d.activity));
    }
  }
  for (const name of dropParams) delete props.parameters?.[name];

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

  filled.properties.description =
    'Created by the ValueLens installer. Runs the ingesters, then the Audit Log Processor. ' +
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
