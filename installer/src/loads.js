// @ts-check
/**
 * How each load in a pipeline run went, in plain words: one card per source, with why a load
 * failed and what to do about it. The Record_Load_Status notebook uses the same labels and reasons
 * (`statusConfigJson`), so dbo.load_log and the installer say the same thing.
 */
import {
  ACCESS_ACTIVITY,
  AGENT365_FALLBACK,
  AGENT365_LANDER,
  AGENT365_REGISTRY,
  AGENT_EVALUATOR_ACTIVITY,
  AGENT_EVALUATOR_REFRESH_ACTIVITY,
  CONSUMPTION_REFRESH_ACTIVITY,
  COWORK_DATAFLOW_ACTIVITY,
  COWORK_WRAPPER_ACTIVITY,
  REFRESH_ACTIVITY,
  RESOURCE_GRAPH_ACTIVITY,
  STATUS_ACTIVITY,
  UPLOAD_ROUTER_ACTIVITY,
  WORKDAY_ACTIVITY,
} from './transform/pipeline.js';

/** Plain names for the pipeline's loads. */
export const LOAD_LABELS = /** @type {Record<string, string>} */ ({
  Run_Audit_Log_Ingester: 'Copilot audit log',
  Run_Audit_Log_Processor: 'Copilot usage (audit log processing)',
  [REFRESH_ACTIVITY]: 'ValueLens model refresh',
  Run_Licensed_Users_Ingester: 'Licensed users',
  [UPLOAD_ROUTER_ACTIVITY]: 'Uploaded CSV exports',
  [AGENT365_REGISTRY]: 'Agent 365 (API)',
  [AGENT365_FALLBACK]: 'Agent 365 (export)',
  [AGENT365_LANDER]: 'Agent 365 (export)',
  Run_Org_Data_Ingester: 'Org data (Entra ID)',
  [WORKDAY_ACTIVITY]: 'Org data (Workday export)',
  [ACCESS_ACTIVITY]: 'Who sees which orgs (org-scoped access)',
  Run_M365_Activity_Ingester: 'Microsoft 365 activity',
  Run_ProductFeedback_Ingester: 'Product feedback',
  Run_Consumption_Azure_AI: 'Azure AI spend',
  Run_Consumption_Studio: 'Copilot Studio credits',
  [COWORK_DATAFLOW_ACTIVITY]: 'Cowork credits (Viva Insights)',
  Run_Consumption_Viva: 'Cowork credits (load)',
  [CONSUMPTION_REFRESH_ACTIVITY]: 'Consumption model refresh',
  [AGENT_EVALUATOR_ACTIVITY]: 'Agent transcripts',
  [AGENT_EVALUATOR_REFRESH_ACTIVITY]: 'Agent Evaluator model refresh',
  [RESOURCE_GRAPH_ACTIVITY]: 'Agent configuration and Foundry (Resource Graph)',
  Run_Defender_Ingester: 'Shadow AI and agent risk (Defender)',
  [STATUS_ACTIVITY]: 'Load status record',
});

/** "Run_Org_Data_Ingester" reads "Org Data Ingester". @param {string} name */
export const loadLabel = (name) => LOAD_LABELS[name] ?? name.replace(/^Run_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

/** Stands for the rerun command in fix texts; the terminal, web page and notebook each fill it in. */
export const RERUN = '{rerun}';

/**
 * Why a load failed, tested in order against "errorCode=<code> <message>". The patterns use only
 * syntax JavaScript and Python share, matched case-insensitively.
 */
export const REASONS = [
  {
    // Fabric's whole error when a Dataflow's connections have no sign-in, or it is still publishing.
    kind: 'signIn',
    activity: COWORK_DATAFLOW_ACTIVITY,
    pattern: 'Job instance failed without detail error',
    text: 'Needs sign-in: the Cowork Dataflow\'s connections aren\'t signed in (or it hadn\'t finished publishing).',
    fix: 'Sign in to the Cowork Dataflow\'s two connections, save it and wait until it has finished publishing, then choose Load Cowork now.',
  },
  {
    kind: 'capacity',
    pattern: 'TooManyRequestsForCapacity|(?:code|status)[\\s:\'"=-]{0,6}430\\b',
    text: 'Fabric\'s capacity was too busy to start it.',
    fix: `Nothing is lost. ${RERUN} once the capacity is quieter, such as outside working hours. If it keeps happening, ask your Fabric admin for a larger capacity.`,
  },
  {
    kind: 'notSynced',
    pattern: 'is not in (?:the )?database|SQL (?:analytics )?endpoint (?:to|has not|hasn.t) (?:sync|caught up)',
    text: 'The model refreshed before the Lakehouse\'s SQL endpoint had caught up with the new tables.',
    fix: `Nothing is lost. Wait a couple of minutes, then ${RERUN}.`,
  },
  {
    kind: 'signIn',
    pattern: 'AADSTS\\d+|\\b401\\b|\\b403\\b|Unauthori[sz]ed|Forbidden|invalid_client|consent|credential|sign.?in',
    text: 'It couldn\'t sign in, or wasn\'t allowed to read the data.',
    fix: `Check the app registration still has admin consent for its permissions and its client secret hasn't expired (if a vault admin adds it, that it's in the vault and you can read it), then ${RERUN}.`,
  },
  {
    kind: 'timeout',
    pattern: 'timed? ?out|timeout|exceeded the (?:maximum|allowed)',
    text: 'It ran out of time.',
    fix: `${RERUN}. If it keeps happening, load less history or ask for a larger capacity.`,
  },
  {
    kind: 'noData',
    pattern: 'PATH_NOT_FOUND|Path does not exist|FileNotFound|No such file',
    text: 'The file it reads wasn\'t there.',
    fix: `Upload the export on the Data sources screen, or set the source to Skip, then ${RERUN}.`,
  },
];

/**
 * Loads that write a status table saying what they couldn't read. They succeed either way, so the
 * Record_Load_Status notebook reads the table and marks a load that ran but loaded nothing, or wasn't
 * allowed to read part of its source, as a Warning. Each load replaces its table every run.
 */
export const STATUS_TABLES = [
  { activity: RESOURCE_GRAPH_ACTIVITY, table: 'arg_status', item: 'Probe', status: 'Status' },
  { activity: 'Run_Defender_Ingester', table: 'defender_status', item: 'Probe', status: 'Status' },
  { activity: AGENT_EVALUATOR_ACTIVITY, table: 'evaluator_status', item: 'Environment', status: 'Status' },
];

/**
 * Why a load that succeeded is a warning, tested in order against its status table's rows. `all`
 * means every row must be empty or skipped. `{items}` is filled with the probes or environments.
 */
export const WARNINGS = [
  {
    kind: 'forbidden',
    statuses: ['forbidden'],
    text: 'It ran, but wasn\'t allowed to read {items}.',
    fix: `Give the app that runs the load the role this source needs (docs/PERMISSIONS.md lists them), then ${RERUN}.`,
  },
  {
    kind: 'unlicensed',
    statuses: ['unlicensed'],
    text: 'It ran, but the tenant isn\'t licensed for {items}.',
    fix: 'Nothing to do unless you add the licence. The rest of the source loaded.',
  },
  {
    kind: 'other',
    statuses: ['error'],
    text: 'It ran, but couldn\'t read {items}.',
    fix: `Open the load's notebook run in Fabric to see why, then ${RERUN}.`,
  },
  {
    kind: 'empty',
    statuses: ['empty'],
    all: true,
    text: 'It ran, but found nothing to load in {items}.',
    fix: 'Check the source has data for the period it reads. For Agent transcripts, choose the environments that hold your Copilot Studio agents with Repair or change in the installer.',
  },
];

/** @typedef {'capacity' | 'notSynced' | 'signIn' | 'timeout' | 'noData' | 'empty' | 'forbidden' | 'unlicensed' | 'other'} ReasonKind */

/**
 * @param {{ errorCode?: unknown, message?: unknown } | null | undefined} error
 * @param {string} [activity]  The step that failed. A reason tied to one step matches only that step.
 * @returns {{ kind: ReasonKind, text: string, fix: string }}
 */
export function classifyFailure(error, activity) {
  const subject = `errorCode=${error?.errorCode ?? ''} ${error?.message ?? ''}`;
  const hit = REASONS.find((r) => (!r.activity || r.activity === activity) && new RegExp(r.pattern, 'i').test(subject));
  if (hit) return { kind: /** @type {ReasonKind} */ (hit.kind), text: hit.text, fix: hit.fix };
  const first = String(error?.message ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return {
    kind: 'other',
    text: first ? `It stopped with an error: ${first.slice(0, 240)}` : 'It stopped without saying why.',
    fix: `Open the pipeline's latest run in Fabric to see the full error, then ${RERUN}.`,
  };
}

/** Labels, reasons, status tables and warnings as the Record_Load_Status notebook has them. */
export function statusConfigJson() {
  return JSON.stringify({
    labels: LOAD_LABELS,
    reasons: REASONS.map(({ kind, pattern, text, ...r }) => ({ kind, pattern, text, ...('activity' in r ? { activity: r.activity } : {}) })),
    statusTables: STATUS_TABLES,
    warnings: WARNINGS.map(({ kind, statuses, all, text }) => ({ kind, statuses, all: !!all, text })),
  });
}

/** Marks the warnings in the Record_Load_Status notebook's error message, when a load also failed. */
export const WARNINGS_MARK = 'load_warnings=';

/**
 * The warnings the Record_Load_Status notebook found, by activity: from its exit value, or from
 * its error message when a load failed. Empty when it didn't say, such as on an older notebook.
 * @param {any} statusRun  The notebook's activity run.
 * @returns {Record<string, { kind: ReasonKind, reason: string }>}
 */
export function loadWarnings(statusRun) {
  const exit = statusRun?.output?.result?.exitValue;
  const marked = String(statusRun?.error?.message ?? '').split(/\r?\n/).find((l) => l.trim().startsWith(WARNINGS_MARK));
  const text = typeof exit === 'string' && exit.trim() ? exit : marked?.trim().slice(WARNINGS_MARK.length);
  if (!text) return {};
  try {
    const warnings = JSON.parse(text)?.warnings;
    return warnings && typeof warnings === 'object' ? warnings : {};
  } catch {
    return {};
  }
}

/**
 * @typedef {object} LoadCard
 * @property {string} activity
 * @property {string} name  Plain name of the source.
 * @property {'ok' | 'warning' | 'failed' | 'skipped' | 'running' | 'todo'} state  A warning loaded, but not all of its source. todo: left for you to finish, such as a sign-in.
 * @property {string} [reason]
 * @property {ReasonKind} [kind]
 * @property {string[]} fix  What to do, with {@link RERUN} still in it.
 * @property {number} [attempts]
 * @property {boolean} [counted]  Failed in a way that leaves an install partly set up. The Cowork Dataflow failing
 *   while signing it in is still to do isn't: that's a next step.
 */

/** The Viva load, which reads what the Cowork Dataflow wrote. */
export const VIVA_ACTIVITY = 'Run_Consumption_Viva';
const COWORK_TODO_FIX = 'Sign in to the Cowork Dataflow, then choose Load Cowork now.';

const RUN_STATES = /** @type {Record<string, LoadCard['state']>} */ ({
  Succeeded: 'ok',
  Failed: 'failed',
  Cancelled: 'failed',
  TimedOut: 'failed',
  InProgress: 'running',
  Queued: 'running',
  Skipped: 'skipped',
});

/** @param {any} a */
const branches = (a) => [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])];

/**
 * Whether one dependency held, given its activity's status.
 * @param {string | undefined} status  Succeeded, Failed or Skipped; anything else counts as Skipped.
 * @param {string[]} conditions
 */
export function conditionMet(status, conditions) {
  const s = status === 'Succeeded' || status === 'Failed' ? status : status === 'Cancelled' || status === 'TimedOut' ? 'Failed' : 'Skipped';
  return conditions.some((c) => c === s || (c === 'Completed' && s !== 'Skipped'));
}

/**
 * One card per source in a run. A source switched off (its IfCondition chose the empty branch) gets
 * no card. When the Agent 365 export covered a failed API load, only the export's card shows.
 * @param {Map<string, any> | null} runs  The last attempt of each activity, by name.
 * @param {any[]} [activities]  Top-level activities of the pipeline definition, so loads that never
 *   started show as skipped with the steps they were waiting for. Without it, only the runs show.
 * @returns {LoadCard[]}
 */
export function loadCards(runs, activities) {
  if (!runs) return [];
  /** @param {string} name */
  const statusOf = (name) => runs.get(name)?.status ?? 'Skipped';
  const fallbackWorked = statusOf(AGENT365_FALLBACK) === 'Succeeded';
  const registryWorked = statusOf(AGENT365_REGISTRY) === 'Succeeded';
  const warnings = loadWarnings(runs.get(STATUS_ACTIVITY));

  /** @type {{ load: any, parent?: any }[]} */
  const loads = [];
  if (activities) {
    for (const a of activities) {
      if (a.type === 'IfCondition') for (const inner of branches(a)) loads.push({ load: inner, parent: a });
      else loads.push({ load: a });
    }
  } else {
    for (const r of runs.values()) if (r.activityType !== 'IfCondition') loads.push({ load: { name: r.activityName, type: r.activityType } });
  }

  /** @type {LoadCard[]} */
  const cards = [];
  for (const { load, parent } of loads) {
    const name = load.name;
    if (name === STATUS_ACTIVITY) continue;
    const run = runs.get(name);
    if (!run && parent?.name === COWORK_WRAPPER_ACTIVITY && runs.get(parent.name)?.status === 'Succeeded') {
      // The run was told to leave the Dataflow out (SkipCowork) because it wasn't signed in yet.
      cards.push({ activity: name, name: loadLabel(name), state: 'todo', reason: 'Not loaded yet: the Cowork Dataflow needs signing in first.', fix: [COWORK_TODO_FIX] });
      continue;
    }
    if (!run && parent && runs.get(parent.name)?.status === 'Succeeded') continue;
    if (name === AGENT365_REGISTRY && fallbackWorked) continue;
    if (name === AGENT365_FALLBACK && registryWorked) continue;
    const state = RUN_STATES[run?.status ?? 'Skipped'] ?? 'running';
    /** @type {LoadCard} */
    const card = { activity: name, name: loadLabel(name), state, fix: [] };
    if (run?.attempts > 1) card.attempts = run.attempts;
    const warning = state === 'ok' ? warnings[name] : undefined;
    if (warning?.reason) {
      const rule = WARNINGS.find((w) => w.kind === warning.kind);
      card.state = 'warning';
      card.reason = warning.reason;
      card.kind = warning.kind;
      card.fix = rule ? [rule.fix] : [];
    } else if (state === 'failed') {
      const why = classifyFailure(run?.error, name);
      card.reason = why.text;
      card.kind = why.kind;
      card.fix = [why.fix];
    } else if (state === 'skipped') {
      const waiting = ((parent ?? load).dependsOn ?? [])
        .filter((/** @type {any} */ d) => !conditionMet(statusOf(d.activity), d.dependencyConditions ?? ['Succeeded']))
        .map((/** @type {any} */ d) => loadLabel(innerName(activities, d.activity)));
      card.reason = waiting.length ? `It didn't run, because it waits for: ${[...new Set(waiting)].join(', ')}.` : 'It didn\'t run.';
      card.fix = [`It runs again once those succeed: ${RERUN}.`];
    }
    cards.push(card);
  }
  // The Viva load "succeeds" on nothing new when the Dataflow didn't refresh first: not green.
  const cowork = cards.find((c) => c.activity === COWORK_DATAFLOW_ACTIVITY);
  const viva = cards.find((c) => c.activity === VIVA_ACTIVITY);
  if (viva?.state === 'ok' && (cowork?.state === 'todo' || cowork?.state === 'failed')) {
    viva.state = 'todo';
    viva.reason = 'It ran, but nothing new came from the Cowork Dataflow: the Dataflow didn\'t refresh first.';
    viva.fix = cowork.state === 'todo' ? [COWORK_TODO_FIX] : cowork.fix;
  }
  return cards;
}

/**
 * The load inside an IfCondition, so a dependency on the condition reads as the source it runs.
 * @param {any[] | undefined} activities
 * @param {string} name
 */
function innerName(activities, name) {
  const a = activities?.find((x) => x.name === name);
  const inner = a?.type === 'IfCondition' ? branches(a)[0] : undefined;
  return inner?.name ?? name;
}

/**
 * Puts the rerun instruction into a fix text, capitalised at the start of a sentence.
 * @param {string} text
 * @param {string} phrase  e.g. `run "AnalyticsHubInstaller.exe rerun-failed"`.
 */
export function fillRerun(text, phrase) {
  const cap = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return text.replace(/(^|\. )\{rerun\}/g, (_, p) => p + cap).replace(/\{rerun\}/g, phrase);
}

/** @param {LoadCard[]} cards */
export const failedCards = (cards) => cards.filter((c) => c.state === 'failed');
