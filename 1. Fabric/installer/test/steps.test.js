// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { runCommand } from '../src/install.js';
import { ensureLakehouse, ensureNotebooks, ensurePipeline, ensureSchedule, freeName } from '../src/steps/fabric.js';
import { ensureConsent } from '../src/steps/identity.js';
import { connectionName } from '../src/steps/model.js';
import { APP_NAME, lakehouseNameFrom, planReview, reserveNames, validateNewLakehouseName } from '../src/steps/plan.js';
import { capacityBusy, chooseLoad, historyLoaded, printDataCheck, ranSince, runDataCheck, runPipeline, status, waitForJob } from '../src/steps/run.js';
import { DATA_CHECK_FILE } from '../src/transform/notebook.js';
import { PIPELINE_CHANGE, PIPELINE_VERSION, REFRESH_ACTIVITY } from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const defaultNotebooks = notebooksFor(emptyConfig().modules);

test('notebooks: first run creates, a re-run changes nothing, update pushes content', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });

  await ensureNotebooks(ctx);
  assert.deepEqual(
    fabric.calls,
    defaultNotebooks.map((nb) => `createNotebook ${nb.displayName}`),
  );
  for (const nb of defaultNotebooks) assert.ok(config.fabric.notebooks[nb.key], `${nb.key} is recorded`);
  const audit = fabric.items.find((i) => i.displayName === 'Copilot_Audit_Log_Direct_Ingester');
  assert.match(audit?.content, /notebookutils\.credentials\.getSecret\('https:\/\/kv-test\.vault\.azure\.net\/', 'valuelens-client-secret'\)/);
  assert.match(audit?.content, /tenant-1/);
  assert.doesNotMatch(audit?.content, /"default_lakehouse": "00000000/);

  fabric.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, [], 'nothing to do on a re-run');

  await ensureNotebooks(ctx, { force: true });
  assert.deepEqual(
    fabric.calls,
    defaultNotebooks.map((nb) => `updateNotebook ${nb.displayName}`),
  );
});

test('notebooks: a deleted one is deployed again; one with the same name that is not ours is left alone', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  await ensureNotebooks(ctx);

  const gone = fabric.items.findIndex((i) => i.displayName === 'AnalyticsHub_Data_Check');
  fabric.items.splice(gone, 1);
  fabric.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, ['createNotebook AnalyticsHub_Data_Check']);
  assert.ok(config.fabric.notebooks.dataCheck);

  const other = fakeFabric();
  const theirs = other.add('Notebook', 'Copilot_Audit_Log_Processor', 'theirs');
  const ui = fakeUi();
  const shared = fakeCtx({ fabric: other.api, ui: ui.ui });
  await ensureNotebooks(shared.ctx);
  assert.deepEqual(ui.asked, [], 'never asks to replace it');
  assert.notEqual(shared.config.fabric.notebooks.processor, theirs.id);
  assert.equal(theirs.content, 'theirs');
  assert.equal(theirs.displayName, 'Copilot_Audit_Log_Processor');
  assert.ok(other.calls.includes('createNotebook Copilot_Audit_Log_Processor_2'));
  assert.ok(!other.calls.some((c) => c.startsWith('updateNotebook')));
  assert.equal(shared.config.fabric.notebookNames?.processor, 'Copilot_Audit_Log_Processor_2');
  assert.match(ui.text(), /"Copilot_Audit_Log_Processor" is already in the workspace and isn't from this install/);

  other.calls.length = 0;
  await ensureNotebooks(shared.ctx, { force: true });
  assert.ok(other.calls.includes('updateNotebook Copilot_Audit_Log_Processor_2'));
  assert.ok(!other.calls.includes('updateNotebook Copilot_Audit_Log_Processor'));
});

test('freeName: numbers a clash, with a space for names that have spaces', () => {
  assert.equal(freeName('ValueLens', []), 'ValueLens');
  assert.equal(freeName('ValueLens', ['valuelens']), 'ValueLens_2');
  assert.equal(freeName('ValueLens', ['ValueLens', 'ValueLens_2']), 'ValueLens_3');
  assert.equal(freeName('Analytics Hub Model', ['Analytics Hub Model']), 'Analytics Hub Model 2');
});

test('plan: a new Lakehouse needs a name no Lakehouse in the workspace has', () => {
  const check = validateNewLakehouseName(['ValueLens']);
  assert.match(String(check(' valuelens ')), /already a Lakehouse called valuelens here\. Analytics Hub only writes to a Lakehouse it creates/);
  assert.equal(check('ValueLens_2'), true);
  assert.match(String(check('2bad')), /Start with a letter/);
});

test('plan: spaces and hyphens in a Lakehouse name become underscores', () => {
  assert.equal(lakehouseNameFrom('My Lakehouse'), 'My_Lakehouse');
  assert.equal(lakehouseNameFrom(' my-lake  house '), 'my_lake_house');
  assert.equal(validateNewLakehouseName([])('My Lakehouse'), true);
  const check = validateNewLakehouseName(['My_Lakehouse']);
  assert.match(String(check('my lakehouse')), /already a Lakehouse called my_lakehouse here/);
  assert.match(String(check('My Lake!')), /only letters, numbers and underscores/);
});

test('plan: new items get names nothing in the workspace has; a name someone chose stays', async () => {
  const fabric = fakeFabric();
  fabric.add('Notebook', 'Copilot_Audit_Log_Processor', null);
  fabric.add('DataPipeline', 'AnalyticsHub_Pipeline', null);
  fabric.add('SemanticModel', 'Analytics Hub Model', null);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.semanticModel.enabled = true;

  await reserveNames(ctx);
  assert.equal(fabric.calls.length, 0, 'planning changes nothing');
  assert.equal(config.fabric.notebookNames?.processor, 'Copilot_Audit_Log_Processor_2');
  assert.equal(config.fabric.notebookNames?.dataCheck, 'AnalyticsHub_Data_Check');
  assert.equal(config.fabric.pipelineName, 'AnalyticsHub_Pipeline_2');
  assert.equal(config.semanticModel.name, 'Analytics Hub Model 2');
  assert.match(ui.text(), /already has "Copilot_Audit_Log_Processor", "AnalyticsHub_Pipeline", "Analytics Hub Model", not from this install/);
  const review = planReview(ctx);
  assert.match(String(review.creates.find((i) => i.kind === 'Notebooks')?.detail), /Copilot_Audit_Log_Processor_2/);
  assert.equal(review.creates.find((i) => i.kind === 'Pipeline')?.name, 'AnalyticsHub_Pipeline_2');

  fabric.items.length = 0;
  config.semanticModel.name = 'Contoso Model';
  await reserveNames(ctx);
  assert.equal(config.fabric.notebookNames?.processor, 'Copilot_Audit_Log_Processor', 'back to the usual name once it is free');
  assert.equal(config.fabric.pipelineName, 'AnalyticsHub_Pipeline');
  assert.equal(config.semanticModel.name, 'Contoso Model');

  await ensureNotebooks(ctx);
  assert.ok(fabric.calls.includes('createNotebook Copilot_Audit_Log_Processor'));
});

test('lakehouse: never writes to one it did not create', async () => {
  const fabric = fakeFabric();
  const theirs = fabric.add('Lakehouse', 'ValueLens', null);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  delete config.fabric.lakehouseId;
  await ensureLakehouse(ctx);
  assert.deepEqual(fabric.calls, ['createLakehouse ValueLens_2']);
  assert.notEqual(config.fabric.lakehouseId, theirs.id);
  assert.equal(config.fabric.lakehouseName, 'ValueLens_2');
  assert.match(ui.text(), /"ValueLens" is already in the workspace/);
});

test('pipeline: one with the same name that is not ours is left alone', async () => {
  const fabric = fakeFabric();
  const theirs = fabric.add('DataPipeline', 'AnalyticsHub_Pipeline', 'theirs');
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(fabric.calls, ['createPipeline AnalyticsHub_Pipeline_2']);
  assert.equal(theirs.content, 'theirs');
  assert.notEqual(config.fabric.pipelineId, theirs.id);
  assert.equal(config.fabric.pipelineName, 'AnalyticsHub_Pipeline_2');
});

test('names: new installs use Analytics Hub names; an older install keeps the names its items have', async () => {
  const config = emptyConfig();
  assert.equal(config.semanticModel.name, 'Analytics Hub Model');
  assert.equal(config.consumption.model.name, 'Analytics Hub Consumption Model');
  assert.equal(config.agentEvaluator.model.name, 'Analytics Hub Agent Evaluator Model');
  assert.equal(APP_NAME, 'Analytics Hub Data Collector');
  assert.equal(connectionName('12345678-aaaa'), 'Analytics Hub SQL 12345678');

  const fabric = fakeFabric();
  const ui = fakeUi();
  const old = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(old.ctx);
  const check = /** @type {string} */ (old.config.fabric.notebooks.dataCheck);
  const item = fabric.items.find((i) => i.id === check);
  if (item) item.displayName = 'ValueLens_Data_Check';
  old.config.fabric.notebookNames = {};
  old.config.fabric.pipelineId = fabric.add('DataPipeline', 'ValueLens_Pipeline', {}).id;
  delete old.config.fabric.pipelineName;
  fabric.calls.length = 0;
  await ensureNotebooks(old.ctx, { force: true });
  await ensurePipeline(old.ctx);
  assert.equal(old.config.fabric.notebookNames.dataCheck, 'ValueLens_Data_Check');
  assert.equal(old.config.fabric.pipelineName, 'ValueLens_Pipeline');
  assert.ok(fabric.calls.includes('updateNotebook ValueLens_Data_Check'));
  assert.ok(fabric.calls.includes('updatePipeline ValueLens_Pipeline'));
  assert.ok(!fabric.calls.some((c) => c.startsWith('create')), 'nothing is created under the new names');
});

test('pipeline: created once, left alone on re-run, updated when modules change', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  fabric.calls.length = 0;

  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['createPipeline AnalyticsHub_Pipeline']);
  const pipeline = fabric.items.find((i) => i.type === 'DataPipeline');
  assert.equal(config.fabric.pipelineId, pipeline?.id, 'ID found by name when the create returns no body');
  assert.equal(config.fabric.pipelineModules, 'core,orgData,m365Activity');
  const json = JSON.stringify(pipeline?.content);
  assert.doesNotMatch(json, /REPLACE_WITH_/);
  assert.match(json, new RegExp(config.fabric.notebooks.auditIngester ?? 'missing'));

  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, []);

  config.modules.m365Activity = false;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['updatePipeline AnalyticsHub_Pipeline']);
  assert.equal(config.fabric.pipelineModules, 'core,orgData');
  assert.match(ui.text(), /replaces the pipeline definition/);
});

test('pipeline: rewritten when a deleted notebook comes back with a new ID', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  await ensurePipeline(ctx);
  const old = /** @type {string} */ (config.fabric.notebooks.processor);
  fabric.items.splice(fabric.items.findIndex((i) => i.id === old), 1);

  await ensureNotebooks(ctx);
  assert.notEqual(config.fabric.notebooks.processor, old);
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['updatePipeline AnalyticsHub_Pipeline']);
  assert.equal(config.fabric.pipelineModules, 'core,orgData,m365Activity');
});

test('pipeline: declining an update keeps the old module signature', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: fakeUi({ answers: [false] }).ui });
  await ensureNotebooks(ctx);
  config.fabric.pipelineId = fabric.add('DataPipeline', 'AnalyticsHub_Pipeline', {}).id;
  config.fabric.pipelineName = 'AnalyticsHub_Pipeline';
  config.fabric.pipelineModules = 'core';
  fabric.calls.length = 0;

  await ensurePipeline(ctx, { force: true });
  assert.deepEqual(fabric.calls, []);
  assert.equal(config.fabric.pipelineModules, 'core');
  assert.equal(config.fabric.pipelineVersion, undefined, 'so the next run offers the update again');
});

test('pipeline: one an older installer built is updated to run in lanes', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  await ensurePipeline(ctx);
  assert.equal(config.fabric.pipelineVersion, PIPELINE_VERSION);
  assert.ok(!ui.text().includes(PIPELINE_CHANGE), 'a new pipeline needs no explanation');

  delete config.fabric.pipelineVersion;
  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['updatePipeline AnalyticsHub_Pipeline']);
  assert.ok(ui.text().includes(PIPELINE_CHANGE));
  assert.equal(config.fabric.pipelineVersion, PIPELINE_VERSION);

  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, [], 'nothing to do once it is up to date');
});

test('schedule: created, unchanged on re-run, updated when the time changes, adopted if one exists', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.pipelineId = 'pipe-1';

  await ensureSchedule(ctx);
  assert.deepEqual(fabric.calls, ['createSchedule']);
  assert.equal(config.fabric.scheduleId, fabric.schedules[0].id);
  assert.equal(fabric.schedules[0].configuration.startDateTime, '2026-06-02T00:00:00');

  await ensureSchedule(ctx);
  assert.deepEqual(fabric.calls, ['createSchedule']);

  config.schedule = { frequency: 'weekly', time: '05:00', weekday: 'Monday', timeZone: 'UTC' };
  await ensureSchedule(ctx);
  assert.deepEqual(fabric.calls, ['createSchedule', 'updateSchedule']);
  assert.deepEqual(fabric.schedules[0].configuration.weekdays, ['Monday']);

  const other = fakeFabric();
  other.schedules.push({ id: 'theirs', enabled: true, configuration: { type: 'Daily', times: ['09:00'] } });
  const adopt = fakeCtx({ fabric: other.api });
  adopt.config.fabric.pipelineId = 'pipe-2';
  await ensureSchedule(adopt.ctx);
  assert.deepEqual(other.calls, []);
  assert.equal(adopt.config.fabric.scheduleId, 'theirs');
});

/**
 * @param {string[]} have  App role IDs already assigned.
 */
function fakeGraph(have) {
  /** @type {string[]} */
  const granted = [];
  const graphSp = {
    id: 'graph-sp',
    appRoles: [
      { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
      { id: 'r-reports', value: 'Reports.Read.All' },
      { id: 'r-users', value: 'User.Read.All' },
    ],
  };
  const api = {
    graphServicePrincipal: async () => graphSp,
    appRoleAssignments: async () => [...have, ...granted].map((appRoleId) => ({ resourceId: 'graph-sp', appRoleId })),
    /** @param {string} _r @param {string} _p @param {string} role */
    grantAppRole: async (_r, _p, role) => {
      granted.push(role);
    },
  };
  return { api, granted };
}

test('consent: an admin grants only what is missing', async () => {
  const graph = fakeGraph(['r-audit']);
  const { ctx } = fakeCtx({ graph: graph.api });
  assert.equal(await ensureConsent(ctx, { canConsent: true }), true);
  assert.deepEqual(graph.granted, ['r-reports', 'r-users']);

  const ui = fakeUi();
  const again = fakeCtx({ graph: graph.api, ui: ui.ui });
  assert.equal(await ensureConsent(again.ctx, { canConsent: true }), true);
  assert.deepEqual(graph.granted, ['r-reports', 'r-users']);
  assert.match(ui.text(), /Admin consent is in place/);
});

test('consent: without admin rights the user gets a link, and can check again', async () => {
  const graph = fakeGraph([]);
  const quiet = fakeUi({ yes: true });
  const unattended = fakeCtx({ graph: graph.api, ui: quiet.ui });
  assert.equal(await ensureConsent(unattended.ctx, { canConsent: false }), false);
  assert.match(quiet.text(), /CallAnAPI\/appId\/app-1/);
  assert.match(quiet.text(), /login\.microsoftonline\.com\/tenant-1\/adminconsent\?client_id=app-1/);
  assert.deepEqual(graph.granted, []);

  const ui = fakeUi();
  /** @type {any} */ (ui.ui).select = async () => {
    // An admin approves in the portal while the installer waits.
    graph.granted.push('r-audit', 'r-reports', 'r-users');
    return 'check';
  };
  const { ctx } = fakeCtx({ graph: graph.api, ui: ui.ui });
  assert.equal(await ensureConsent(ctx, { canConsent: false }), true);
  assert.match(ui.text(), /needs to approve/);
  assert.match(ui.text(), /Admin consent is in place/);

  const skip = fakeCtx({ graph: fakeGraph([]).api, ui: fakeUi({ answers: ['skip'] }).ui });
  assert.equal(await ensureConsent(skip.ctx, { canConsent: false }), false);
});

test('waitForJob polls until the job ends', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'NotStarted' }, { status: 'InProgress' }, { status: 'Completed' });
  const { ctx, sleeps } = fakeCtx({ fabric: fabric.api });
  const job = await waitForJob(ctx, 'https://x/jobs/instances/j', 'Pipeline', { pollMs: 5 });
  assert.equal(job.status, 'Completed');
  assert.deepEqual(sleeps, [5, 5]);
});

test('first run starts with a backfill, records the job and reports the result', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'InProgress' }, { status: 'Completed', startTimeUtc: '2026-06-01T12:00:00', endTimeUtc: '2026-06-01T12:21:30' });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';

  const result = await runPipeline(ctx, { backfillDays: 30, wait: true, first: true });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'Completed');
  assert.match(fabric.calls[0], /^runJob Pipeline /);
  assert.match(fabric.calls[0], /"AuditMode":"backfill"/);
  assert.match(fabric.calls[0], /"BackfillDays":30/);
  assert.match(fabric.calls[0], /"ProcessorWriteMode":"overwrite"/);
  assert.equal(config.firstRun?.jobId, result.jobId);
  assert.equal(config.firstRun?.status, 'Completed');
  assert.ok(config.firstRun?.finishedAt);
  assert.match(ui.text(), /Pipeline finished in 21m 30s/);
});

test('a failed run says why; --no-wait returns straight away', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Failed', failureReason: { errorCode: 'X', message: 'AADSTS7000215: Invalid client secret' } });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';
  const failed = await runPipeline(ctx, { wait: true });
  assert.equal(failed.ok, false);
  assert.match(ui.text(), /Pipeline failed/);
  assert.match(ui.text(), /Invalid client secret/);
  assert.equal(config.firstRun, undefined);

  const later = await runPipeline(ctx, { wait: false });
  assert.equal(later.status, 'NotStarted');
  assert.equal(fabric.calls.at(-1), 'runJob Pipeline');
});

/** What Fabric says when a trial capacity can't start another notebook. */
const BUSY =
  "Notebook execution failed at Notebook service with http status code - '430', please check the Run logs on Notebook, additional details - 'Error name - Exception, Error value - Failed to create Livy session for executing notebook. Error: [TooManyRequestsForCapacity] This spark job can't be run because you have hit a spark compute or API rate limit.'";

/**
 * An activity run, as Fabric lists it.
 * @param {string} activityName
 * @param {string} status
 * @param {string} [activityRunStart]
 * @param {any} [more]
 */
const activity = (activityName, status, activityRunStart = '2026-06-01T12:00:00Z', more = {}) => ({
  activityName,
  activityType: activityName.startsWith('Conditionally_') ? 'IfCondition' : 'TridentNotebook',
  status,
  activityRunStart,
  ...more,
});

test('capacityBusy spots a busy capacity, and nothing else', () => {
  assert.equal(capacityBusy({ errorCode: '430' }), true);
  assert.equal(capacityBusy({ errorCode: 'RequestExecutionFailed', message: BUSY }), true);
  assert.equal(capacityBusy({ message: 'TooManyRequestsForCapacity' }), true);
  assert.equal(capacityBusy({ message: 'HTTP status code: 430' }), true);
  assert.equal(capacityBusy({ message: 'Read 430 rows' }), false);
  assert.equal(capacityBusy({ errorCode: '4301', message: 'code 4301' }), false);
  assert.equal(capacityBusy({ errorCode: 'X', message: 'AADSTS7000215: Invalid client secret' }), false);
  assert.equal(capacityBusy(null), false);
});

test('a run that completed with a failed load says which, and still checks the data', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed', startTimeUtc: '2026-06-01T12:00:00', endTimeUtc: '2026-06-01T12:30:00' }, { status: 'Completed' });
  fabric.activityRuns['job-1'] = [
    activity('Run_Audit_Log_Ingester', 'Succeeded'),
    activity('Conditionally_Run_Org_Data', 'Failed', '2026-06-01T12:05:00Z'),
    activity('Run_Org_Data_Ingester', 'Failed', '2026-06-01T12:05:05Z', { error: { errorCode: '2011', message: 'Forbidden' } }),
    activity('Conditionally_Run_M365_Activity', 'Succeeded', '2026-06-01T12:10:00Z'),
  ];
  const oneLake = { readJson: async () => ({ checkedAt: '2026-06-01T12:40:00+00:00', tables: { licensed: { rows: 5 } } }) };
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';
  config.fabric.pipelineName = 'AnalyticsHub_Pipeline';
  config.fabric.notebooks.dataCheck = 'nb-check';
  config.firstRun = { jobId: 'job-0', status: 'Completed' };

  assert.equal(await runCommand(ctx, 'run', { wait: true }), false);
  const text = ui.text();
  assert.match(text, /✓ Pipeline finished in 30m/);
  assert.match(text, /! Org Data Ingester failed/);
  assert.doesNotMatch(text, /Conditionally/);
  assert.match(text, /To see why, open AnalyticsHub_Pipeline in Fabric/);
  assert.deepEqual(fabric.calls, ['runJob Pipeline', 'runJob RunNotebook'], 'the data check still runs');
  assert.match(text, /✓ Licensed users: 5 rows/);
});

test('a run a busy capacity turned away says to wait and run it again', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Failed', failureReason: { errorCode: 'RequestExecutionFailed', message: BUSY } });
  fabric.activityRuns['job-1'] = [
    activity('Run_Audit_Log_Ingester', 'Failed', '2026-06-01T12:00:00Z', { error: { errorCode: '430', message: BUSY } }),
    activity('Run_Licensed_Users_Ingester', 'Succeeded'),
  ];
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';

  const result = await runPipeline(ctx, { wait: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['Run_Audit_Log_Ingester']);
  const text = ui.text();
  assert.match(text, /! Audit Log Ingester failed/);
  assert.match(text, /capacity was too busy to start a notebook\. Nothing is lost\./);
  assert.equal(text.split('too busy').length, 2, 'said once');
  assert.match(text, /Wait a few minutes, then run "valuelens-install run" again\./);
  assert.doesNotMatch(text, /To see why/);
});

test("run doesn't start a second run while one is going, but ignores one stuck for over a day", async () => {
  const fabric = fakeFabric();
  fabric.jobList.push({ id: 'j-running', status: 'InProgress', startTimeUtc: '2026-06-01T11:30:00' });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';

  const result = await runPipeline(ctx, { backfillDays: 90, wait: true, first: true });
  assert.deepEqual(result, { jobId: 'j-running', status: 'InProgress', ok: false });
  assert.deepEqual(fabric.calls, []);
  assert.equal(config.firstRun, undefined);
  assert.match(ui.text(), /already running, so this didn't start another/);

  fabric.jobList[0].startTimeUtc = '2026-05-30T11:30:00';
  fabric.jobs.push({ status: 'Completed' });
  assert.equal((await runPipeline(ctx, { wait: true })).ok, true);
  assert.deepEqual(fabric.calls, ['runJob Pipeline']);
});

test('run loads the history until a run has loaded it, then runs as usual', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  config.fabric.pipelineId = 'pipe-1';
  const wait = { wait: true };

  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true, backfillDays: 90, first: true }, 'nothing has run yet');

  config.firstRun = { jobId: 'job-9', status: 'Completed' };
  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true });
  assert.deepEqual(await chooseLoad(ctx, { wait: true, backfillDays: 30 }), { wait: true, backfillDays: 30, first: false }, 'asking for days reloads them');

  // A first load where only another load failed did load the history.
  config.firstRun = { jobId: 'job-9', status: 'Failed' };
  fabric.activityRuns['job-9'] = [activity('Run_Audit_Log_Ingester', 'Succeeded'), activity('Run_Audit_Log_Processor', 'Succeeded'), activity('Run_Org_Data_Ingester', 'Failed')];
  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true });
  assert.equal(config.firstRun?.status, 'Completed', 'and is marked so');

  // It must also have refreshed the model and read the transcripts, when they are installed.
  config.firstRun = { jobId: 'job-9', status: 'Failed' };
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1', bound: true });
  assert.equal(await historyLoaded(ctx), false);
  fabric.activityRuns['job-9'].push(activity(REFRESH_ACTIVITY, 'Succeeded'));
  config.modules.agentEvaluator = true;
  config.agentEvaluator.environments = [{ url: 'https://org.crm.dynamics.com', access: true }];
  assert.deepEqual(await chooseLoad(ctx, wait), { wait: true, backfillDays: 90, first: true }, 'the transcripts are missing');
  assert.deepEqual(await chooseLoad(ctx, { wait: true, backfillDays: 30 }), { wait: true, backfillDays: 30, first: true });
  fabric.activityRuns['job-9'].push(activity('Run_Agent_Evaluator_Transcripts', 'Succeeded'));
  assert.equal(await historyLoaded(ctx), true);

  // Installs from before the installer tracked the first load count any completed run.
  delete config.firstRun;
  assert.equal(await historyLoaded(ctx), false);
  fabric.jobList.push({ id: 'old', status: 'Completed' });
  assert.equal(await historyLoaded(ctx), true);
});

test("run starts the first load again when the last one didn't load the history", async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed' });
  fabric.activityRuns['job-0'] = [activity('Run_Audit_Log_Ingester', 'Failed', undefined, { error: { errorCode: '430', message: BUSY } })];
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.pipelineId = 'pipe-1';
  config.firstRun = { jobId: 'job-0', status: 'Failed' };

  await runCommand(ctx, 'run', { wait: true });
  assert.match(fabric.calls[0], /"AuditMode":"backfill"/);
  assert.match(fabric.calls[0], /"BackfillDays":90/);
  assert.match(ui.text(), /Started the first load: 90 days of audit history/);
  assert.equal(config.firstRun?.jobId, 'job-1');
  assert.equal(config.firstRun?.status, 'Completed');
});

test('status names the loads that failed in the latest run, unless a retry or the fallback covered them', async () => {
  const fabric = fakeFabric();
  fabric.jobList.push(
    { id: 'j-1', status: 'Completed', startTimeUtc: '2026-06-01T02:00:00', endTimeUtc: '2026-06-01T02:40:00', invokeType: 'Scheduled' },
    { id: 'j-2', status: 'Completed', startTimeUtc: '2026-06-02T02:00:00', endTimeUtc: '2026-06-02T02:40:00', invokeType: 'Scheduled' },
  );
  const busy = { errorCode: '430', message: BUSY };
  fabric.activityRuns['j-1'] = [activity('Run_Org_Data_Ingester', 'Failed')];
  fabric.activityRuns['j-2'] = [
    // Fabric lists a retried load's attempts in any order; the last one counts.
    activity('Run_Licensed_Users_Ingester', 'Succeeded', '2026-06-02T02:06:00Z'),
    activity('Run_Licensed_Users_Ingester', 'Failed', '2026-06-02T02:00:05Z', { error: busy }),
    activity('Conditionally_Run_Agent365', 'Failed', '2026-06-02T02:07:00Z'),
    activity('Run_Agent365_Registry_Ingester', 'Failed', '2026-06-02T02:07:05Z'),
    activity('Run_Agent365_CSV_Fallback', 'Succeeded', '2026-06-02T02:09:00Z'),
    activity('Conditionally_Run_M365_Activity', 'Failed', '2026-06-02T02:12:00Z'),
    activity('Run_M365_Activity_Ingester', 'Failed', '2026-06-02T02:12:05Z', { error: busy }),
  ];
  const run = async () => {
    const ui = fakeUi();
    const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake: { readJson: async () => null }, ui: ui.ui });
    config.fabric.pipelineId = 'pipe-1';
    await status(ctx);
    return ui.text();
  };

  let text = await run();
  assert.match(text, /! M365 Activity Ingester failed in the latest run/);
  assert.doesNotMatch(text, /Licensed Users Ingester failed/, 'its retry worked');
  assert.doesNotMatch(text, /Agent365 Registry Ingester failed/, 'the fallback stood in');
  assert.doesNotMatch(text, /Org Data Ingester failed/, 'that was an earlier run');
  assert.doesNotMatch(text, /Conditionally/);
  assert.match(text, /capacity was too busy to start a notebook/);

  fabric.activityRuns['j-2'][4].status = 'Failed';
  text = await run();
  assert.match(text, /! Agent365 Registry Ingester failed in the latest run/);
  assert.match(text, /! Agent365 CSV Fallback failed in the latest run/);
});

test('data check runs the notebook and prints the summary it saved', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed' });
  /** @type {string[]} */
  const reads = [];
  const oneLake = {
    /** @param {string} ws @param {string} lh @param {string} path */
    readJson: async (ws, lh, path) => {
      reads.push(`${ws}/${lh}/${path}`);
      return {
        checkedAt: '2026-06-01T12:30:00+00:00',
        tables: {
          licensed: { table: 'dbo.licensed', rows: 1250 },
          audit: { table: 'dbo.audit', rows: 48211, from: '2026-03-03 00:01:00', to: '2026-05-31 23:59:00' },
          agents: null,
          org: { table: 'dbo.copilot_org_data', rows: 0 },
          m365: { table: 'dbo.m365_activity_daily', rows: 118, from: '2026-09-06', to: '2026-09-29' },
        },
      };
    },
  };
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake, ui: ui.ui });
  config.fabric.notebooks.dataCheck = 'nb-check';
  const summary = await runDataCheck(ctx);
  assert.ok(summary);
  assert.deepEqual(fabric.calls, ['runJob RunNotebook']);
  assert.deepEqual(reads, [`ws-1/lh-1/${DATA_CHECK_FILE}`]);
  const text = ui.text();
  assert.match(text, /✓ Licensed users: 1,250 rows/);
  assert.match(text, /✓ Copilot interactions: 48,211 rows, 2026-03-03 to 2026-05-31/);
  assert.match(text, /! Org data: 0 rows/);
  assert.match(text, /✓ Microsoft 365 activity: 118 rows, 2026-09-06 to 2026-09-29/);
  assert.match(text, /Agents: not loaded/);
});

test('check runs the data check on its own, and needs its notebook', async () => {
  const fabric = fakeFabric();
  fabric.jobs.push({ status: 'Completed' });
  const oneLake = { readJson: async () => ({ checkedAt: '2026-06-01T12:30:00+00:00', tables: { licensed: { rows: 5 } } }) };
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake, ui: ui.ui });
  await assert.rejects(runCommand(ctx, 'check', { wait: true }), /no data check notebook yet/);
  assert.deepEqual(fabric.calls, []);

  config.fabric.notebooks.dataCheck = 'nb-check';
  assert.equal(await runCommand(ctx, 'check', { wait: true }), true);
  assert.deepEqual(fabric.calls, ['runJob RunNotebook'], 'the pipeline is left alone');
  assert.match(ui.text(), /✓ Licensed users: 5 rows/);

  fabric.jobs.push({ status: 'Failed' });
  assert.equal(await runCommand(ctx, 'check', { wait: true }), false);
});

test('ranSince: a run that ended after the check makes it out of date', () => {
  const at = '2026-06-01T12:30:00+00:00';
  const run = (/** @type {string} */ status, /** @type {string} */ end) => ({ status, endTimeUtc: end });
  assert.equal(ranSince([run('Completed', '2026-06-02T02:20:00')], at), true);
  assert.equal(ranSince([run('Failed', '2026-06-02T02:20:00')], at), true);
  assert.equal(ranSince([run('Completed', '2026-06-01T12:00:00')], at), false, 'the run the check followed');
  assert.equal(ranSince([run('InProgress', '')], at), false);
  assert.equal(ranSince([run('Completed', '2026-06-02T02:20:00')], undefined), false);
});

test('status says when the last data check is out of date, or has never run', async () => {
  const fabric = fakeFabric();
  /** @type {any[]} */
  let jobs = [{ id: 'j-1', status: 'Completed', startTimeUtc: '2026-06-02T02:00:00', endTimeUtc: '2026-06-02T02:20:00', invokeType: 'Scheduled' }];
  /** @type {any} */ (fabric.api).listJobs = async () => jobs;
  /** @type {any} */
  let saved = { checkedAt: '2026-06-01T12:30:00+00:00', tables: { m365: null } };
  const oneLake = { readJson: async () => saved ?? Promise.reject(new Error('404')) };
  const run = async () => {
    const ui = fakeUi();
    const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake, ui: ui.ui });
    config.fabric.pipelineId = 'pipe-1';
    config.fabric.notebooks.dataCheck = 'nb-check';
    await status(ctx);
    return ui.text();
  };

  let text = await run();
  assert.match(text, /Last data check \(2026-06-01 12:30 UTC\)/);
  assert.match(text, /! The pipeline has run since this check, so these results may be out of date/);
  assert.match(text, /Run "valuelens-install check" to check the data again/);
  assert.match(text, /Microsoft 365 activity: not loaded/);

  saved = { ...saved, checkedAt: '2026-06-02T02:40:00+00:00' };
  text = await run();
  assert.doesNotMatch(text, /out of date/);

  saved = null;
  text = await run();
  assert.match(text, /It hasn't run yet. Run "valuelens-install check"/);

  jobs = [];
  text = await run();
  assert.doesNotMatch(text, /Data check|hasn't run/, 'nothing to check before the pipeline has loaded anything');
});

test('printDataCheck flags missing core tables', () => {
  const ui = fakeUi();
  const { ctx } = fakeCtx({ ui: ui.ui });
  printDataCheck(ctx, { tables: { licensed: null } });
  assert.match(ui.text(), /! Licensed users: no table yet/);
  assert.match(ui.text(), /! Copilot interactions: no table yet/);
  assert.match(ui.text(), /Microsoft 365 activity: not loaded/);
  assert.doesNotMatch(ui.text(), /! Microsoft 365 activity/);
});

test('printDataCheck explains hidden user names in the licence roster', () => {
  const ui = fakeUi();
  const { ctx } = fakeCtx({ ui: ui.ui });
  printDataCheck(ctx, { tables: {}, identity: { licensed: 98, audit: 166, matched: 0, masked: 98 } });
  assert.match(ui.text(), /! Licensed users: 98 of 98 user names are hidden/);
  assert.match(ui.text(), /Settings > Org settings > Reports/);
  assert.match(ui.text(), /Display concealed user, group, and site names in all reports/);
});

test('printDataCheck warns when no licence matches Copilot activity', () => {
  const ui = fakeUi();
  const { ctx } = fakeCtx({ ui: ui.ui });
  printDataCheck(ctx, { tables: {}, identity: { licensed: 1250, audit: 900, matched: 0, masked: 0 } });
  assert.match(ui.text(), /! Licensed users: none of the 900 people using Copilot match a licensed user/);
  assert.doesNotMatch(ui.text(), /concealed/);
});

test('printDataCheck reports how many people using Copilot have a licence', () => {
  const ui = fakeUi();
  const { ctx } = fakeCtx({ ui: ui.ui });
  printDataCheck(ctx, { tables: {}, identity: { licensed: 1250, audit: 900, matched: 812, masked: 0 } });
  assert.match(ui.text(), /✓ Licensed users: 812 of 900 people using Copilot have a licence/);
});

test('printDataCheck says nothing about matching when the check did not run', () => {
  const ui = fakeUi();
  const { ctx } = fakeCtx({ ui: ui.ui });
  printDataCheck(ctx, { tables: {}, identity: null });
  printDataCheck(ctx, { tables: {}, identity: { licensed: 0, audit: 900, matched: 0, masked: 0 } });
  assert.doesNotMatch(ui.text(), /match|have a licence/);
});
