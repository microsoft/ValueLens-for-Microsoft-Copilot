// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../src/http.js';
import { classifyFailure, conditionMet, failedCards, fillRerun, loadCards, RERUN, statusConfigJson } from '../src/loads.js';
import { PIPELINE_TEMPLATE } from '../src/sources.js';
import { ensureSparkSettings, notebookSettings } from '../src/steps/fabric.js';
import { BUSY_RETRIES, BUSY_WAIT_MS, dependencyOrder, evaluate, rerunFailed, rerunSteps, runParameters } from '../src/steps/rerun.js';
import {
  AGENT365_FALLBACK,
  AGENT365_REGISTRY,
  buildPipeline,
  findActivity,
  PIPELINE_VERSION,
  REFRESH_ACTIVITY,
  SESSION_TAG,
  STATUS_ACTIVITY,
} from '../src/transform/pipeline.js';
import { NOTEBOOKS } from '../src/catalog.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(join(here, '..', '..', PIPELINE_TEMPLATE), 'utf8'));

const WS = 'f0000000-0000-0000-0000-000000000000';
const id = (/** @type {number} */ n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ids = {
  auditIngester: id(1),
  licensedUsers: id(2),
  processor: id(3),
  orgData: id(4),
  agent365Registry: id(5),
  agent365Lander: id(6),
  productFeedback: id(7),
  m365Activity: id(8),
  refreshModel: id(9),
  loadStatus: id(10),
};
const modules = { orgData: true, m365Activity: true, agent365: true, productFeedback: false, consumption: false, agentEvaluator: false };
/** @param {Partial<import('../src/transform/pipeline.js').PipelineSettings>} [more] */
const build = (more = {}) => buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules, semanticModelId: 'model-1', ...more });

/** Every activity, nested ones included. @param {any[]} activities @returns {any[]} */
const all = (activities) =>
  activities.flatMap((a) => [a, ...all([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])])]);

/** "Run_X: Succeeded" style runs, as activityRuns returns them. @param {Record<string, string | [string, any]>} spec */
const runsOf = (spec) =>
  new Map(Object.entries(spec).map(([name, s]) => {
    const [status, error] = Array.isArray(s) ? s : [s, undefined];
    return [name, { activityName: name, status, error, attempts: 1 }];
  }));

const BUSY = { errorCode: 'RequestExecutionFailed', message: 'Failed to create Livy session. Error: [TooManyRequestsForCapacity] You have hit a spark compute limit.' };

/* ---------- Pipeline ---------- */

test('pipeline: every notebook shares one Spark session, nested ones too', () => {
  const doc = build();
  const notebooks = all(doc.properties.activities).filter((a) => a.type === 'TridentNotebook');
  assert.ok(notebooks.length > 5);
  for (const nb of notebooks) assert.equal(nb.typeProperties.sessionTag, SESSION_TAG, nb.name);
  assert.ok(PIPELINE_VERSION >= 4);
});

test('pipeline: the status step runs last, whatever happened before it', () => {
  const doc = build();
  const acts = doc.properties.activities;
  const status = findActivity(acts, STATUS_ACTIVITY);
  assert.equal(acts.at(-1).name, STATUS_ACTIVITY);
  assert.equal(status.typeProperties.notebookId, ids.loadStatus);
  const others = acts.filter((/** @type {any} */ a) => a.name !== STATUS_ACTIVITY);
  const leaves = others.filter((/** @type {any} */ a) => !others.some((/** @type {any} */ b) => b.dependsOn?.some((/** @type {any} */ d) => d.activity === a.name)));
  assert.ok(leaves.length >= 1);
  assert.deepEqual(status.dependsOn.map((/** @type {any} */ d) => d.activity).sort(), leaves.map((/** @type {any} */ a) => a.name).sort());
  for (const d of status.dependsOn) assert.deepEqual(d.dependencyConditions, ['Completed', 'Skipped']);
  assert.match(status.typeProperties.parameters.PIPELINE_RUN_ID.value.value, /pipeline\(\)\.RunId/);

  const { loadStatus: _, ...without } = ids;
  const old = buildPipeline(template, { workspaceId: WS, notebookIds: without, modules });
  assert.equal(findActivity(old.properties.activities, STATUS_ACTIVITY), undefined, 'no status notebook, no status step');
});

test('the status notebook is a core notebook that gets the labels and reasons', () => {
  const nb = NOTEBOOKS.find((n) => n.key === 'loadStatus');
  assert.ok(nb);
  assert.equal(nb.module, 'core');
  assert.deepEqual(nb.parameters, ['PIPELINE_RUN_ID', 'PIPELINE_TRIGGER_TIME']);
  const { ctx } = fakeCtx({ fabric: fakeFabric().api });
  const settings = notebookSettings(ctx, nb);
  assert.equal(settings.values?.STATUS_JSON, statusConfigJson());
  const json = JSON.parse(statusConfigJson());
  assert.equal(json.labels.Run_Audit_Log_Ingester, 'Copilot audit log');
  assert.ok(json.reasons.every((/** @type {any} */ r) => r.kind && r.pattern && r.text && !('fix' in r)));
});

/* ---------- Cards ---------- */

test('classifyFailure names the usual reasons in plain words', () => {
  assert.equal(classifyFailure({ errorCode: '430', message: 'x' }).kind, 'capacity');
  assert.equal(classifyFailure(BUSY).kind, 'capacity');
  assert.equal(classifyFailure({ message: 'AADSTS7000215: Invalid client secret' }).kind, 'signIn');
  assert.equal(classifyFailure({ errorCode: '2011', message: 'Forbidden' }).kind, 'signIn');
  assert.equal(classifyFailure({ message: 'The activity timed out' }).kind, 'timeout');
  const lag = classifyFailure({ errorCode: '2011', message: "RuntimeError: The refresh ended as Failed. Table 'copilot_interactions_curated' is not in database" });
  assert.equal(lag.kind, 'notSynced');
  assert.ok(lag.fix.includes(RERUN));
  const other = classifyFailure({ message: 'KeyError: tenant\n  at line 3' });
  assert.equal(other.kind, 'other');
  assert.equal(other.text, 'It stopped with an error: KeyError: tenant');
  assert.equal(classifyFailure(null).text, 'It stopped without saying why.');
  assert.ok(other.fix.includes(RERUN));
});

test('conditionMet follows Fabric dependency rules', () => {
  assert.equal(conditionMet('Succeeded', ['Succeeded']), true);
  assert.equal(conditionMet('Failed', ['Succeeded']), false);
  assert.equal(conditionMet('Failed', ['Completed']), true);
  assert.equal(conditionMet(undefined, ['Completed']), false);
  assert.equal(conditionMet(undefined, ['Completed', 'Skipped']), true);
  assert.equal(conditionMet('TimedOut', ['Failed']), true);
});

test('loadCards: one card per source; switched-off sources and covered API loads are left out', () => {
  const acts = build().properties.activities;
  const runs = runsOf({
    Run_Audit_Log_Ingester: 'Succeeded',
    Run_Licensed_Users_Ingester: ['Failed', BUSY],
    Conditionally_Run_Agent365: 'Failed',
    [AGENT365_REGISTRY]: 'Failed',
    [AGENT365_FALLBACK]: 'Succeeded',
    Conditionally_Run_Org_Data: 'Succeeded',
    Conditionally_Run_M365_Activity: 'Succeeded',
    Run_M365_Activity_Ingester: 'Succeeded',
  });
  const cards = loadCards(runs, acts);
  const by = Object.fromEntries(cards.map((c) => [c.activity, c]));
  assert.equal(by.Run_Audit_Log_Ingester.state, 'ok');
  assert.equal(by.Run_Licensed_Users_Ingester.state, 'failed');
  assert.equal(by.Run_Licensed_Users_Ingester.kind, 'capacity');
  assert.equal(by[AGENT365_FALLBACK].state, 'ok');
  assert.equal(by[AGENT365_REGISTRY], undefined, 'the export covered it');
  assert.equal(by.Run_Org_Data_Ingester, undefined, 'its condition chose the empty branch');
  assert.equal(by[STATUS_ACTIVITY], undefined);
  const processor = by.Run_Audit_Log_Processor;
  assert.equal(processor.state, 'skipped');
  assert.match(processor.reason ?? '', /waits for: Licensed users/);
  assert.deepEqual(failedCards(cards).map((c) => c.activity), ['Run_Licensed_Users_Ingester']);
});

test('fillRerun capitalises the instruction at the start of a sentence', () => {
  assert.equal(fillRerun(`${RERUN}. Or wait.`, 'run "x rerun-failed"'), 'Run "x rerun-failed". Or wait.');
  assert.equal(fillRerun(`Fix it. ${RERUN}.`, 'run it'), 'Fix it. Run it.');
  assert.equal(fillRerun(`Fix it, then ${RERUN}.`, 'run it'), 'Fix it, then run it.');
});

/* ---------- Rerun ---------- */

test('evaluate reads the expressions the pipeline uses', () => {
  const p = { EnableOrgDataPull: true, AuditMode: 'Backfill', BackfillDays: 90 };
  assert.equal(evaluate('@pipeline().parameters.EnableOrgDataPull', p), true);
  assert.equal(evaluate("@equals(pipeline().parameters.AuditMode, 'backfill')", p), true);
  assert.equal(evaluate("@if(equals(pipeline().parameters.AuditMode,'incremental'), 1, pipeline().parameters.BackfillDays)", p), 90);
  assert.equal(evaluate('@and(true, not(false))', p), true);
  assert.equal(evaluate('@or(false, false)', p), false);
  assert.equal(evaluate("@string('it''s')", p), "it's");
  assert.throws(() => evaluate('@pipeline().RunId', p), /can't fill in pipeline\(\)\.RunId/);
  assert.throws(() => evaluate('@pipeline().parameters.Nope', p), /no parameter Nope/);
  assert.throws(() => evaluate('@concat(1)', p), /can't evaluate concat/);
});

test('dependencyOrder puts each step after what it waits for', () => {
  const order = dependencyOrder([
    { name: 'c', dependsOn: [{ activity: 'b' }] },
    { name: 'b', dependsOn: [{ activity: 'a' }] },
    { name: 'a' },
  ]).map((a) => a.name);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('rerunSteps reruns the failed load, what waited for it and the refresh, but not what worked', async () => {
  const acts = build().properties.activities;
  const params = runParameters(build(), /** @type {any} */ ({ firstRun: undefined }), 'job-1');
  const runs = runsOf({
    Run_Audit_Log_Ingester: 'Succeeded',
    Run_Licensed_Users_Ingester: ['Failed', BUSY],
    Conditionally_Run_Agent365: 'Succeeded',
    [AGENT365_REGISTRY]: 'Succeeded',
    Conditionally_Run_Org_Data: 'Succeeded',
    Run_Org_Data_Ingester: 'Succeeded',
    Conditionally_Run_M365_Activity: 'Succeeded',
    Run_M365_Activity_Ingester: 'Succeeded',
  });
  /** @type {string[]} */
  const ran = [];
  /** @type {Record<string, any>} */
  const given = {};
  const result = await rerunSteps(acts, runs, params, async (a, parameters) => {
    ran.push(a.name);
    given[a.name] = parameters;
    return { status: 'Succeeded' };
  });
  assert.equal(ran[0], 'Run_Licensed_Users_Ingester');
  assert.ok(ran.includes('Run_Audit_Log_Processor'));
  assert.ok(ran.includes(REFRESH_ACTIVITY));
  assert.ok(!ran.includes('Run_Audit_Log_Ingester'));
  assert.ok(!ran.includes(STATUS_ACTIVITY));
  assert.ok(ran.indexOf('Run_Audit_Log_Processor') < ran.indexOf(REFRESH_ACTIVITY));
  assert.equal(given.Run_Audit_Log_Processor?.WRITE_MODE?.value, 'merge', 'expressions are filled in from the run parameters');
  assert.equal(result.runs.get('Run_Licensed_Users_Ingester').status, 'Succeeded');
});

test('rerunSteps runs a condition branch, and marks steps whose loads still fail as skipped', async () => {
  const acts = build().properties.activities;
  const params = runParameters(build(), /** @type {any} */ ({}), 'job-1');
  const runs = runsOf({
    Run_Audit_Log_Ingester: ['Failed', BUSY],
    Run_Licensed_Users_Ingester: 'Succeeded',
    Conditionally_Run_Org_Data: 'Failed',
    Run_Org_Data_Ingester: ['Failed', { message: 'Forbidden' }],
  });
  /** @type {string[]} */
  const ran = [];
  const result = await rerunSteps(acts, runs, params, async (a) => {
    ran.push(a.name);
    return a.name === 'Run_Audit_Log_Ingester' ? { status: 'Failed', error: BUSY } : { status: 'Succeeded' };
  });
  assert.ok(ran.includes('Run_Org_Data_Ingester'), 'the condition is evaluated and its branch run');
  assert.equal(result.runs.get('Conditionally_Run_Org_Data').status, 'Succeeded');
  assert.ok(!ran.includes('Run_Audit_Log_Processor'));
  assert.equal(result.runs.get('Run_Audit_Log_Processor').status, 'Skipped');
});

test('runParameters uses the first load history for the first-load job', () => {
  const doc = build();
  const config = /** @type {any} */ ({ firstRun: { jobId: 'job-1' }, history: { days: 30 } });
  assert.equal(runParameters(doc, config, 'job-1').AuditMode, 'backfill');
  assert.equal(runParameters(doc, config, 'job-1').BackfillDays, 30);
  assert.equal(runParameters(doc, config, 'job-2').AuditMode, 'incremental');
});

/** A workspace whose latest pipeline run left the licensed users unloaded. */
function failedRun() {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config, sleeps } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  const pipe = fabric.add('DataPipeline', 'AnalyticsHub_Pipeline', build({ workspaceId: 'ws-1' }));
  config.fabric.pipelineId = pipe.id;
  fabric.jobList.push({ id: 'j-1', status: 'Failed', startTimeUtc: '2026-06-01T02:00:00', endTimeUtc: '2026-06-01T03:00:00' });
  const ran = (/** @type {string} */ activityName, /** @type {string} */ status = 'Succeeded', /** @type {any} */ error = undefined) => ({
    activityName,
    activityType: activityName.startsWith('Conditionally_') ? 'IfCondition' : 'TridentNotebook',
    status,
    activityRunStart: '2026-06-01T02:00:00Z',
    error,
  });
  fabric.activityRuns['j-1'] = [
    ran('Run_Audit_Log_Ingester'),
    ran('Run_Licensed_Users_Ingester', 'Failed', BUSY),
    ran('Conditionally_Run_Agent365'),
    ran(AGENT365_REGISTRY),
    ran('Conditionally_Run_Org_Data'),
    ran('Run_Org_Data_Ingester'),
    ran('Conditionally_Run_M365_Activity'),
    ran('Run_M365_Activity_Ingester'),
  ];
  // A test that starts more jobs than it planned for fails instead of polling forever.
  const getJob = fabric.api.getJob;
  fabric.api.getJob = async () => {
    if (!fabric.jobs.length) throw new Error('no job status left in the fake');
    return getJob();
  };
  return { fabric, ui, ctx, config, sleeps };
}

test('rerun-failed: a busy capacity is waited out, then the rest of the chain runs', async () => {
  const { fabric, ui, ctx, sleeps } = failedRun();
  // Licensed users: busy, then loads. The processor and the model refresh load first time.
  fabric.jobs.push({ status: 'Failed', failureReason: BUSY }, { status: 'Completed' }, { status: 'Completed' }, { status: 'Completed' });
  const result = await rerunFailed(ctx);
  assert.deepEqual(result.reran, ['Run_Licensed_Users_Ingester', 'Run_Audit_Log_Processor', REFRESH_ACTIVITY]);
  assert.deepEqual(result.failed, []);
  assert.ok(sleeps.includes(BUSY_WAIT_MS));
  const text = ui.text();
  assert.match(text, /capacity is busy\. Trying again in 5 minutes/);
  assert.match(text, /Licensed users: loaded/);
  assert.match(text, /Now, by source/);
  const runs = fabric.calls.filter((c) => c.startsWith('runJob'));
  assert.equal(runs.length, 4, 'one extra start for the busy retry');
  assert.match(runs[1], /^runJob RunNotebook/);
  assert.match(runs[3], /^runJob RunNotebook/, 'the model refresh is a notebook');
});

test('rerun-failed gives up after the busy retries and says so', async () => {
  const { fabric, ctx } = failedRun();
  for (let i = 0; i <= BUSY_RETRIES; i++) fabric.jobs.push({ status: 'Failed', failureReason: BUSY });
  const result = await rerunFailed(ctx);
  assert.deepEqual(result.reran, ['Run_Licensed_Users_Ingester']);
  assert.deepEqual(result.failed, ['Run_Licensed_Users_Ingester']);
});

test("rerun-failed doesn't run anything while the pipeline is running", async () => {
  const { fabric, ui, ctx } = failedRun();
  fabric.jobList.push({ id: 'j-2', status: 'InProgress', startTimeUtc: '2026-06-01T11:30:00' });
  assert.deepEqual(await rerunFailed(ctx), { reran: [], failed: [] });
  assert.deepEqual(fabric.calls, []);
  assert.match(ui.text(), /pipeline is running/);
});

/* ---------- Shared Spark session ---------- */

test('ensureSparkSettings turns on high concurrency for pipelines once', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureSparkSettings(ctx);
  assert.deepEqual(fabric.calls, ['updateSparkSettings {"highConcurrency":{"notebookPipelineRunEnabled":true}}']);
  assert.equal(fabric.spark.highConcurrency.notebookInteractiveRunEnabled, true, 'other settings are left alone');
  await ensureSparkSettings(ctx);
  assert.equal(fabric.calls.length, 1, 'already on');
  assert.match(ui.text(), /share one Spark session/);
});

test('ensureSparkSettings only warns when it may not change the setting', async () => {
  const fabric = fakeFabric();
  fabric.failures.updateSparkSettings = [new HttpError('Forbidden', { status: 403, method: 'PATCH', url: '/spark/settings' })];
  const ui = fakeUi();
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureSparkSettings(ctx);
  assert.match(ui.text(), /needs the workspace Admin role/);
  assert.match(ui.text(), /High concurrency/);
});
