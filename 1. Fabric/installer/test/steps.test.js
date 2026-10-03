// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { ensureNotebooks, ensurePipeline, ensureSchedule } from '../src/steps/fabric.js';
import { ensureConsent } from '../src/steps/identity.js';
import { printDataCheck, runDataCheck, runPipeline, waitForJob } from '../src/steps/run.js';
import { DATA_CHECK_FILE } from '../src/transform/notebook.js';
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

test('notebooks: a deleted one is deployed again; a same-name one is replaced only with consent', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api });
  await ensureNotebooks(ctx);

  const gone = fabric.items.findIndex((i) => i.displayName === 'ValueLens_Data_Check');
  fabric.items.splice(gone, 1);
  fabric.calls.length = 0;
  await ensureNotebooks(ctx);
  assert.deepEqual(fabric.calls, ['createNotebook ValueLens_Data_Check']);

  const other = fakeFabric();
  const theirs = other.add('Notebook', 'Copilot_Audit_Log_Processor', 'theirs');
  const yes = fakeCtx({ fabric: other.api, ui: fakeUi({ answers: [true] }).ui });
  await ensureNotebooks(yes.ctx);
  assert.equal(yes.config.fabric.notebooks.processor, theirs.id);
  assert.ok(other.calls.includes('updateNotebook Copilot_Audit_Log_Processor'));

  const third = fakeFabric();
  third.add('Notebook', 'Copilot_Audit_Log_Direct_Ingester', 'theirs');
  const no = fakeCtx({ fabric: third.api, ui: fakeUi({ answers: [false] }).ui });
  await assert.rejects(ensureNotebooks(no.ctx), /Stopped: Copilot_Audit_Log_Direct_Ingester already exists/);
  assert.equal(third.calls.length, 0);
  assert.equal(no.config.fabric.notebooks.auditIngester, undefined);
  assert.ok(config.fabric.notebooks.dataCheck);
});

test('pipeline: created once, left alone on re-run, updated when modules change', async () => {
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  await ensureNotebooks(ctx);
  fabric.calls.length = 0;

  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['createPipeline ValueLens_Pipeline']);
  const pipeline = fabric.items.find((i) => i.type === 'DataPipeline');
  assert.equal(config.fabric.pipelineId, pipeline?.id, 'ID found by name when the create returns no body');
  assert.equal(config.fabric.pipelineModules, 'core,orgData,m365Activity');
  const json = JSON.stringify(pipeline?.content);
  assert.doesNotMatch(json, /REPLACE_WITH_/);
  assert.match(json, new RegExp(config.fabric.notebooks.auditIngester ?? 'missing'));

  fabric.calls.length = 0;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, []);

  config.modules.orgData = false;
  await ensurePipeline(ctx);
  assert.deepEqual(fabric.calls, ['updatePipeline ValueLens_Pipeline']);
  assert.equal(config.fabric.pipelineModules, 'core,m365Activity');
  assert.match(ui.text(), /replaces the pipeline definition/);
});

test('pipeline: declining an update keeps the old module signature', async () => {
  const fabric = fakeFabric();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: fakeUi({ answers: [false] }).ui });
  await ensureNotebooks(ctx);
  config.fabric.pipelineId = fabric.add('DataPipeline', 'ValueLens_Pipeline', {}).id;
  config.fabric.pipelineName = 'ValueLens_Pipeline';
  config.fabric.pipelineModules = 'core';
  fabric.calls.length = 0;

  await ensurePipeline(ctx, { force: true });
  assert.deepEqual(fabric.calls, []);
  assert.equal(config.fabric.pipelineModules, 'core');
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
  assert.match(text, /Agents: not loaded/);
});

test('printDataCheck flags missing core tables', () => {
  const ui = fakeUi();
  const { ctx } = fakeCtx({ ui: ui.ui });
  printDataCheck(ctx, { tables: { licensed: null } });
  assert.match(ui.text(), /! Licensed users: no table yet/);
  assert.match(ui.text(), /! Copilot interactions: no table yet/);
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
