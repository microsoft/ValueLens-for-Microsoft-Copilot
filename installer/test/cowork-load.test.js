// @ts-check
/** The Cowork Dataflow's first load, its sign-in to-do, Load Cowork now, and reruns of what reads it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { classifyFailure, loadCards, statusConfigJson, VIVA_ACTIVITY } from '../src/loads.js';
import { coworkConnections, coworkNextStep, STAGING_ITEMS_NOTE, VIVA_LOAD_FILE } from '../src/steps/consumption.js';
import { DOWNSTREAM_READERS, evaluate, loadCoworkNow, PUBLISH_POLL_MS, PUBLISH_RETRY_MS, rerunSteps, runParameters } from '../src/steps/rerun.js';
import { countedFailures, coworkSkipForFirstLoad, runPipeline } from '../src/steps/run.js';
import {
  buildPipeline,
  CONSUMPTION_REFRESH_ACTIVITY,
  COWORK_DATAFLOW_ACTIVITY,
  COWORK_WRAPPER_ACTIVITY,
  REFRESH_ACTIVITY,
  SKIP_COWORK_PARAMETER,
  STATUS_ACTIVITY,
} from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeUi, realSources } from './fakes.js';

const STUDIO = 'Run_Consumption_Studio';
const UNSIGNED = { errorCode: 'JobInstanceFailed', message: 'Job instance failed without detail error' };
const SIGNED_IN = [{ path: 'VivaInsights', kind: 'VivaInsights' }, { path: 'Lakehouse', kind: 'Lakehouse' }];

const ids = { auditIngester: 'a', licensedUsers: 'b', processor: 'c', orgData: 'd', refreshModel: 'e', studioConsumption: 'f', vivaConsumption: 'g', loadStatus: 'h' };
const modules = { orgData: false, m365Activity: false, agent365: false, productFeedback: false, consumption: true, agentEvaluator: false };
/** @param {boolean} [dataflow] */
const build = (dataflow = true) =>
  buildPipeline(realSources().pipeline, {
    workspaceId: 'ws-1',
    notebookIds: ids,
    modules,
    semanticModelId: 'model-1',
    consumptionModelId: 'model-2',
    ...(dataflow ? { coworkDataflowId: 'df-1' } : {}),
  });

/** Every activity, nested ones included, as Succeeded, with some changed. @param {any[]} acts @param {Record<string, string | [string, any]>} [changed] */
function runsOf(acts, changed = {}) {
  /** @type {Map<string, any>} */
  const runs = new Map();
  const put = (/** @type {string} */ name, /** @type {string} */ type, /** @type {string | [string, any]} */ s) => {
    const [status, error] = Array.isArray(s) ? s : [s, undefined];
    runs.set(name, { activityName: name, activityType: type, status, error, attempts: 1 });
  };
  for (const a of acts) {
    if (a.name === STATUS_ACTIVITY) continue;
    put(a.name, a.type, changed[a.name] ?? 'Succeeded');
    for (const inner of [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])]) {
      put(inner.name, inner.type, changed[inner.name] ?? 'Succeeded');
    }
  }
  for (const [name, s] of Object.entries(changed)) if (s === 'absent') runs.delete(name);
  return runs;
}

/** A record with the Cowork Dataflow. */
function coworkConfig() {
  const config = emptyConfig();
  config.modules.consumption = true;
  config.dataSources.coworkCredits = 'api';
  config.consumption.dataflowId = 'df-1';
  config.consumption.dataflowName = 'AnalyticsHub_Cowork_Credits';
  config.fabric.workspaceId = 'ws-1';
  config.fabric.workspaceName = 'Analytics Hub';
  config.fabric.lakehouseName = 'ValueLens';
  return config;
}

/* ---------- Pipeline ---------- */

test('pipeline: the Dataflow sits in an If on SkipCowork, which defaults to false so scheduled runs refresh it', () => {
  const doc = build();
  assert.deepEqual(doc.properties.parameters[SKIP_COWORK_PARAMETER], { type: 'Boolean', defaultValue: false });
  const wrapper = doc.properties.activities.find((/** @type {any} */ a) => a.name === COWORK_WRAPPER_ACTIVITY);
  assert.deepEqual(wrapper.typeProperties.ifFalseActivities, []);
  const params = runParameters(doc, /** @type {any} */ ({}), 'job-1');
  assert.equal(params[SKIP_COWORK_PARAMETER], false);
  assert.equal(evaluate(wrapper.typeProperties.expression.value, params), true, 'a scheduled run refreshes the Dataflow');
  assert.equal(evaluate(wrapper.typeProperties.expression.value, { ...params, [SKIP_COWORK_PARAMETER]: true }), false);
  assert.match(doc.properties.description, /SkipCowork=true only when the Cowork Dataflow isn't signed in/);

  const without = build(false);
  assert.equal(without.properties.parameters[SKIP_COWORK_PARAMETER], undefined, 'no switch without a Dataflow');
  assert.ok(!without.properties.activities.some((/** @type {any} */ a) => a.name === COWORK_WRAPPER_ACTIVITY));
});

/* ---------- Rerun ---------- */

test('rerun: a rerun Dataflow reruns the Viva load and the consumption model refresh, which had succeeded', async () => {
  assert.deepEqual(DOWNSTREAM_READERS[VIVA_ACTIVITY], [COWORK_DATAFLOW_ACTIVITY]);
  const doc = build();
  const acts = doc.properties.activities;
  const runs = runsOf(acts, { [COWORK_WRAPPER_ACTIVITY]: 'Failed', [COWORK_DATAFLOW_ACTIVITY]: ['Failed', UNSIGNED] });
  /** @type {string[]} */
  const ran = [];
  const result = await rerunSteps(acts, runs, runParameters(doc, /** @type {any} */ ({}), 'j'), async (a) => {
    ran.push(a.name);
    return { status: 'Succeeded' };
  });
  assert.deepEqual(ran, [COWORK_DATAFLOW_ACTIVITY, VIVA_ACTIVITY, CONSUMPTION_REFRESH_ACTIVITY]);
  assert.ok(!ran.includes(STUDIO) && !ran.includes(REFRESH_ACTIVITY) && !ran.includes('Run_Audit_Log_Ingester'), 'what reads nothing that reran is left');
  assert.equal(result.runs.get(COWORK_WRAPPER_ACTIVITY).status, 'Succeeded');
});

test('rerun: a Dataflow that fails again leaves the Viva load and the refresh alone; an unrelated rerun leaves the Viva load alone', async () => {
  const doc = build();
  const acts = doc.properties.activities;
  /** @type {string[]} */
  const ran = [];
  await rerunSteps(acts, runsOf(acts, { [COWORK_WRAPPER_ACTIVITY]: 'Failed', [COWORK_DATAFLOW_ACTIVITY]: 'Failed' }), runParameters(doc, /** @type {any} */ ({}), 'j'), async (a) => {
    ran.push(a.name);
    return { status: 'Failed', error: UNSIGNED };
  });
  assert.deepEqual(ran, [COWORK_DATAFLOW_ACTIVITY]);

  ran.length = 0;
  await rerunSteps(acts, runsOf(acts, { [STUDIO]: 'Failed', [CONSUMPTION_REFRESH_ACTIVITY]: 'absent' }), runParameters(doc, /** @type {any} */ ({}), 'j'), async (a) => {
    ran.push(a.name);
    return { status: 'Succeeded' };
  });
  assert.deepEqual(ran, [STUDIO, CONSUMPTION_REFRESH_ACTIVITY], 'the Viva load and the Dataflow read nothing the Studio load wrote');
});

/* ---------- Reasons and cards ---------- */

test('reasons: "Job instance failed without detail error" on the Cowork Dataflow means it needs signing in; elsewhere it doesn\'t', () => {
  const dataflow = classifyFailure(UNSIGNED, COWORK_DATAFLOW_ACTIVITY);
  assert.equal(dataflow.kind, 'signIn');
  assert.equal(dataflow.text, 'Needs sign-in: the Cowork Dataflow\'s connections aren\'t signed in (or it hadn\'t finished publishing).');
  assert.equal(classifyFailure(UNSIGNED, 'Run_Licensed_Users_Ingester').kind, 'other');
  assert.equal(classifyFailure(UNSIGNED).kind, 'other');
  const reasons = JSON.parse(statusConfigJson()).reasons;
  assert.equal(reasons[0].activity, COWORK_DATAFLOW_ACTIVITY, 'the notebook gets the step it is tied to');
  assert.ok(reasons.slice(1).every((/** @type {any} */ r) => !('activity' in r)));
});

test('cards: a skipped Dataflow is a to-do, and the Viva load after it isn\'t green', () => {
  const acts = build().properties.activities;
  const skipped = loadCards(runsOf(acts, { [COWORK_DATAFLOW_ACTIVITY]: 'absent' }), acts);
  const by = Object.fromEntries(skipped.map((c) => [c.activity, c]));
  assert.equal(by[COWORK_DATAFLOW_ACTIVITY].state, 'todo');
  assert.match(by[COWORK_DATAFLOW_ACTIVITY].reason ?? '', /needs signing in first/);
  assert.equal(by[VIVA_ACTIVITY].state, 'todo');
  assert.match(by[VIVA_ACTIVITY].reason ?? '', /nothing new came from the Cowork Dataflow/);
  assert.equal(by[STUDIO].state, 'ok');

  const failed = loadCards(runsOf(acts, { [COWORK_WRAPPER_ACTIVITY]: 'Failed', [COWORK_DATAFLOW_ACTIVITY]: ['Failed', UNSIGNED] }), acts);
  const f = Object.fromEntries(failed.map((c) => [c.activity, c]));
  assert.equal(f[COWORK_DATAFLOW_ACTIVITY].state, 'failed');
  assert.equal(f[COWORK_DATAFLOW_ACTIVITY].kind, 'signIn');
  assert.equal(f[VIVA_ACTIVITY].state, 'todo');

  const worked = loadCards(runsOf(acts), acts);
  assert.equal(worked.find((c) => c.activity === VIVA_ACTIVITY)?.state, 'ok');
});

test('coworkNextStep: the sign-in to-do, with the real names, only when the Dataflow needs it', () => {
  const config = coworkConfig();
  const todo = [{ activity: COWORK_DATAFLOW_ACTIVITY, name: 'Cowork', state: /** @type {const} */ ('todo'), fix: [] }];
  const step = coworkNextStep(config, todo);
  assert.ok(step);
  assert.equal(step.title, 'To do: sign in to the Cowork Dataflow');
  assert.equal(step.name, 'AnalyticsHub_Cowork_Credits');
  assert.equal(step.url, 'https://app.fabric.microsoft.com/groups/ws-1/dataflows-gen2/df-1');
  assert.equal(step.action, 'load-cowork');
  assert.equal(step.note, STAGING_ITEMS_NOTE);
  assert.match(step.note, /DataflowsStagingLakehouse and DataflowsStagingWarehouse.*expected/);
  assert.match(step.steps[0], /Open AnalyticsHub_Cowork_Credits in Analytics Hub: https:\/\/app\.fabric\.microsoft\.com\/groups\/ws-1\/dataflows-gen2\/df-1/);
  assert.match(step.steps[1], /"Configure connection" twice.*Viva Insights source.*Lakehouse destination \(ValueLens\)/);
  assert.match(step.steps[3], /Save.*finished publishing/);
  assert.match(step.steps[4], /Load Cowork now/);

  const signIn = [{ activity: COWORK_DATAFLOW_ACTIVITY, name: 'Cowork', state: /** @type {const} */ ('failed'), kind: /** @type {const} */ ('signIn'), fix: [] }];
  assert.ok(coworkNextStep(config, signIn));
  const busy = [{ ...signIn[0], kind: /** @type {const} */ ('capacity') }];
  assert.equal(coworkNextStep(config, busy), null, 'a busy capacity is not a sign-in');
  assert.equal(coworkNextStep(config, [{ ...signIn[0], state: 'ok', kind: undefined }]), null);
  assert.equal(coworkNextStep(config, []), null);
  config.firstRun = { jobId: 'j', status: 'Completed', coworkSkipped: true };
  assert.ok(coworkNextStep(config), 'from the record when there are no cards');
  config.dataSources.coworkCredits = 'csv';
  assert.equal(coworkNextStep(config, todo), null, 'no Dataflow, no to-do');
});

test('countedFailures: every failed load, except the Cowork Dataflow while signing it in is to do', () => {
  const config = coworkConfig();
  /** @param {string} activity @param {import('../src/loads.js').LoadCard['state']} state @param {import('../src/loads.js').ReasonKind} [kind] */
  const card = (activity, state, kind) => ({ activity, name: activity, state, kind, fix: [] });
  /** @param {import('../src/loads.js').LoadCard[]} cards */
  const counted = (cards) => countedFailures(config, cards).map((c) => c.activity);
  assert.deepEqual(counted([card(COWORK_DATAFLOW_ACTIVITY, 'failed', 'signIn')]), [], 'its sign-in is a next step');
  assert.deepEqual(counted([card(COWORK_DATAFLOW_ACTIVITY, 'failed', 'other')]), [], 'which a failure that gives no reason points to as well');
  assert.deepEqual(counted([card(COWORK_DATAFLOW_ACTIVITY, 'failed', 'capacity')]), [COWORK_DATAFLOW_ACTIVITY], 'a busy capacity is not a sign-in');
  assert.deepEqual(counted([card(COWORK_DATAFLOW_ACTIVITY, 'failed', 'timeout')]), [COWORK_DATAFLOW_ACTIVITY]);
  assert.deepEqual(counted([card(COWORK_DATAFLOW_ACTIVITY, 'failed', 'signIn'), card(STUDIO, 'failed', 'signIn')]), [STUDIO], 'any other load counts');
  assert.deepEqual(counted(/** @type {const} */ (['ok', 'warning', 'skipped', 'running', 'todo']).map((s) => card(STUDIO, s))), [], 'only loads that failed');
  config.dataSources.coworkCredits = 'csv';
  assert.deepEqual(counted([card(COWORK_DATAFLOW_ACTIVITY, 'failed', 'signIn')]), [COWORK_DATAFLOW_ACTIVITY], 'with no Dataflow there is no sign-in to do');
});

/* ---------- First load ---------- */

/** A workspace with the Cowork Dataflow and a pipeline that can skip it. */
function workspace() {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const made = fakeCtx({ fabric: fabric.api, ui: ui.ui, config: coworkConfig() });
  const pipe = fabric.add('DataPipeline', 'AnalyticsHub_Pipeline', build());
  made.config.fabric.pipelineId = pipe.id;
  made.config.history.days = 30;
  return { ...made, fabric, ui };
}

test('coworkConnections reads the Dataflow\'s saved connections', async () => {
  const t = workspace();
  t.fabric.dataflowConnections.push([], SIGNED_IN);
  assert.equal(await coworkConnections(t.ctx), 'unbound');
  assert.equal(await coworkConnections(t.ctx), 'bound');
  t.fabric.failures.getDataflowDefinition = [new Error('nope')];
  assert.equal(await coworkConnections(t.ctx), 'unknown', 'when Fabric can\'t say');
});

test('first load: leaves the Cowork Dataflow out only while it isn\'t signed in, and says so', async () => {
  const t = workspace();
  const skip = await coworkSkipForFirstLoad(t.ctx);
  assert.equal(skip, true);
  assert.match(t.ui.text(), /Cowork credits are left out of this first load: the Cowork Dataflow isn't signed in yet/);
  await runPipeline(t.ctx, { backfillDays: 30, wait: false, first: true, skipCowork: skip });
  const start = t.fabric.calls.find((c) => c.startsWith('runJob Pipeline'));
  assert.ok(start);
  const data = JSON.parse(start.slice('runJob Pipeline '.length));
  assert.equal(data.parameters[SKIP_COWORK_PARAMETER], true);
  assert.equal(data.parameters.AuditMode, 'backfill');
  assert.equal(t.config.firstRun?.coworkSkipped, true);

  const signed = workspace();
  signed.fabric.dataflowConnections.push(SIGNED_IN);
  assert.equal(await coworkSkipForFirstLoad(signed.ctx), false);
  await runPipeline(signed.ctx, { backfillDays: 30, wait: false, first: true, skipCowork: false });
  assert.doesNotMatch(signed.fabric.calls.find((c) => c.startsWith('runJob Pipeline')) ?? '', /SkipCowork/);
  assert.equal(signed.config.firstRun?.coworkSkipped, undefined);

  const unsure = workspace();
  unsure.fabric.failures.getDataflowDefinition = [new Error('nope')];
  assert.equal(await coworkSkipForFirstLoad(unsure.ctx), false, 'when unsure it runs the Dataflow');

  const old = workspace();
  const oldPipe = old.fabric.items.find((i) => i.type === 'DataPipeline');
  assert.ok(oldPipe);
  oldPipe.content = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules, consumptionModelId: 'model-2' });
  assert.equal(await coworkSkipForFirstLoad(old.ctx), false, 'a pipeline without the switch runs as it is');

  const scheduled = workspace();
  await runPipeline(scheduled.ctx, { wait: false });
  assert.doesNotMatch(scheduled.fabric.calls.find((c) => c.startsWith('runJob Pipeline')) ?? '', /SkipCowork/, 'other runs never skip');
});

test('runPipeline: a run that completes with a load failed counts it, except the Cowork Dataflow while signing it in is to do, and flags its card', async () => {
  const acts = build().properties.activities;
  /** @param {Record<string, string | [string, any]>} changed */
  const finish = async (changed) => {
    const t = workspace();
    t.fabric.jobs.push({ status: 'Completed', startTimeUtc: '2026-06-01T12:01:00Z', endTimeUtc: '2026-06-01T14:00:00Z' });
    t.fabric.api.queryActivityRuns = async () => [...runsOf(acts, changed).values()];
    /** @type {import('../src/loads.js').LoadCard[]} */
    let cards = [];
    const show = t.ctx.ui.loads;
    t.ctx.ui.loads = (c) => show((cards = c));
    const result = await runPipeline(t.ctx, { wait: true });
    // The web page shows the cards it's told count as failed, so they must be the ones the install counts.
    assert.deepEqual(cards.filter((c) => c.counted).map((c) => c.activity), result.counted);
    return { result, text: t.ui.text() };
  };
  /** @type {Record<string, string | [string, any]>} */
  const dataflow = { [COWORK_WRAPPER_ACTIVITY]: 'Failed', [COWORK_DATAFLOW_ACTIVITY]: ['Failed', UNSIGNED] };
  const unsigned = await finish(dataflow);
  assert.equal(unsigned.result.status, 'Completed');
  assert.equal(unsigned.result.ok, false, 'run and rerun-failed still see it');
  assert.deepEqual(unsigned.result.failed, [COWORK_DATAFLOW_ACTIVITY]);
  assert.deepEqual(unsigned.result.counted, [], 'its sign-in is a next step');
  assert.match(unsigned.text, /To do: sign in to the Cowork Dataflow/);

  const busy = await finish({ ...dataflow, [COWORK_DATAFLOW_ACTIVITY]: ['Failed', { errorCode: 'TooManyRequestsForCapacity', message: 'The capacity is too busy.' }] });
  assert.deepEqual(busy.result.counted, [COWORK_DATAFLOW_ACTIVITY], 'a busy capacity is not a sign-in');
  assert.doesNotMatch(busy.text, /To do: sign in/);

  const studio = await finish({ ...dataflow, [STUDIO]: ['Failed', { errorCode: 'NotebookFailed', message: 'Table not found.' }] });
  assert.deepEqual([...(studio.result.failed ?? [])].sort(), [COWORK_DATAFLOW_ACTIVITY, STUDIO].sort());
  assert.deepEqual(studio.result.counted, [STUDIO]);

  const fine = await finish({});
  assert.equal(fine.result.ok, true);
  assert.deepEqual(fine.result.counted, []);
});

/* ---------- Load Cowork now ---------- */

/** @param {any} [summary] What the Viva notebook wrote. */
function signedIn(summary = { dataflowRows: 1234, csvRows: 0 }) {
  const fabric = fakeFabric();
  const ui = fakeUi();
  /** @type {string[]} */
  const read = [];
  const oneLake = {
    readJson: async (/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path) => {
      read.push(path);
      return summary;
    },
  };
  const made = fakeCtx({ fabric: fabric.api, ui: ui.ui, config: coworkConfig(), oneLake });
  made.config.fabric.pipelineId = fabric.add('DataPipeline', 'AnalyticsHub_Pipeline', build()).id;
  made.config.firstRun = { jobId: 'j-1', status: 'Completed', coworkSkipped: true };
  const getJob = fabric.api.getJob;
  fabric.api.getJob = async () => {
    if (!fabric.jobs.length) throw new Error('no job status left in the fake');
    return getJob();
  };
  return { ...made, fabric, ui, read };
}

test('Load Cowork now: waits for publishing, retries a refresh that fails straight after the save, then loads Viva and refreshes the model', async () => {
  const t = signedIn();
  t.fabric.dataflowConnections.push([], SIGNED_IN);
  t.fabric.jobs.push({ status: 'Failed', failureReason: UNSIGNED }, { status: 'Completed' }, { status: 'Completed' }, { status: 'Completed' });
  const result = await loadCoworkNow(t.ctx);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.reran.filter((n) => n !== COWORK_WRAPPER_ACTIVITY), [COWORK_DATAFLOW_ACTIVITY, VIVA_ACTIVITY, CONSUMPTION_REFRESH_ACTIVITY]);
  assert.ok(t.sleeps.includes(PUBLISH_POLL_MS), 'it waited for the Dataflow to publish');
  assert.ok(t.sleeps.includes(PUBLISH_RETRY_MS), 'it waited a minute before trying again');
  const starts = t.fabric.calls.filter((c) => c.startsWith('runJob'));
  assert.deepEqual(starts.map((c) => c.split(' ')[1]), ['Refresh', 'Refresh', 'RunNotebook', 'RunNotebook']);
  const text = t.ui.text();
  assert.match(text, /may not have finished publishing, so trying again in 1 minute/);
  assert.match(text, /Loaded 1,234 rows of Cowork credits/);
  assert.ok(t.read.includes(VIVA_LOAD_FILE));
  assert.equal(t.config.firstRun?.coworkSkipped, false, 'the to-do is done');
  assert.doesNotMatch(text, /To do: sign in/);
});

test('Load Cowork now: still not signed in, it refreshes nothing and shows the sign-in steps', async () => {
  const t = signedIn();
  const result = await loadCoworkNow(t.ctx);
  assert.deepEqual(result.failed, [COWORK_DATAFLOW_ACTIVITY]);
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('runJob')), [], 'nothing started');
  const text = t.ui.text();
  assert.match(text, /connections still aren't signed in/);
  assert.match(text, /Needs sign-in: the Cowork Dataflow's connections aren't signed in/);
  assert.match(text, /To do: sign in to the Cowork Dataflow/);
  assert.equal(t.config.firstRun?.coworkSkipped, true);
});

test('Load Cowork now: no rows from the Dataflow is not green', async () => {
  const t = signedIn({ dataflowRows: 0, csvRows: 0 });
  t.fabric.dataflowConnections.push(SIGNED_IN);
  t.fabric.jobs.push({ status: 'Completed' }, { status: 'Completed' }, { status: 'Completed' });
  const result = await loadCoworkNow(t.ctx);
  assert.deepEqual(result.failed, [VIVA_ACTIVITY]);
  assert.match(t.ui.text(), /no rows came from the Cowork Dataflow/);
  assert.equal(t.config.firstRun?.coworkSkipped, true);
});

test('Load Cowork now: not while the pipeline runs, and not without a Dataflow', async () => {
  const t = signedIn();
  t.fabric.jobList.push({ id: 'j-2', status: 'InProgress', startTimeUtc: '2026-06-01T11:30:00' });
  assert.deepEqual(await loadCoworkNow(t.ctx), { reran: [], failed: [] });
  assert.match(t.ui.text(), /pipeline is running/);

  const none = signedIn();
  none.config.dataSources.coworkCredits = 'csv';
  await assert.rejects(loadCoworkNow(none.ctx), /no Cowork credits Dataflow/);

  // On Azure, Cowork credits come from the CSV export: say where it goes, not "no pipeline".
  const azure = signedIn();
  azure.config.target = 'azure';
  azure.config.azure = /** @type {any} */ ({ outputs: { storageAccountName: 'stah' } });
  const before = azure.fabric.calls.length;
  await assert.rejects(loadCoworkNow(azure.ctx), /^Error: load-cowork is for the Fabric target's Cowork Dataflow\. On Azure.*CSV export: put it in stah > landing\/viva, and the next run loads it\.$/);
  assert.equal(azure.fabric.calls.length, before, 'nothing touched Fabric');
});
