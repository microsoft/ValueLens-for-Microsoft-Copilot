// @ts-check
/**
 * The install's verdict. A step that fails (✗) and lets the install carry on leaves it partly set up; one that only
 * warns, or recovers when it's tried again, doesn't.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../src/config.js';
import { createCtx, install, update } from '../src/install.js';
import { fakeAzureGraph, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';

const forbidden = async () => {
  throw new Error('Forbidden');
};

/** A notebook run Fabric turned away because the capacity was busy. */
const busy = { status: 'Failed', failureReason: { errorCode: 'TooManyRequestsForCapacity', message: 'The capacity is too busy.' } };

/** @param {string} message A notebook run that failed. */
const failed = (message) => ({ status: 'Failed', failureReason: { errorCode: 'NotebookFailed', message } });

const M365 = 'Run_M365_Activity_Ingester';
/** A load the source turned away. */
const refused = { status: 'Failed', error: { errorCode: '403', message: 'Forbidden' } };
/** A load Fabric didn't start because the capacity was busy. */
const turnedAway = { status: 'Failed', error: { errorCode: 'TooManyRequestsForCapacity', message: 'The capacity is too busy.' } };

/**
 * @typedef {object} Run
 * @property {boolean} [report]  Publishing the report fails.
 * @property {'works' | 'fails'} [upload]  An export to upload, and how its upload goes.
 * @property {boolean} [noDropFolder]  The drop folder can't be made.
 * @property {object[]} [access]  Org-scoped access is on, and the access notebook's runs end like these, then Completed.
 * @property {object[]} [check]  The data check's runs end like these, then Completed.
 * @property {Record<string, { status: string, error?: object }[]>} [loads]  Loads that don't simply succeed: each one's
 *   attempts in the pipeline run, in order. The run itself completes.
 * @property {number} [reload]  Reload this many days of audit history instead of the first load.
 */

/**
 * A new Fabric install, run to the end through the real install record, waiting on the first load or the reload.
 * @param {import('node:test').TestContext} t
 * @param {Run} [o]
 */
async function runInstall(t, o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'installer-verdict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'valuelens-setup.json');
  const config = loadConfig(file).config;
  config.target = 'fabric';
  config.tenantId = 'tenant-1';
  Object.assign(config.fabric, { workspaceId: 'ws-1', workspaceName: 'Analytics', lakehouseId: 'lh-1', lakehouseName: 'ValueLens' });
  Object.assign(config.app, { appId: 'app-1', objectId: 'obj-1', servicePrincipalId: 'sp-1' });
  config.keyVault.mode = 'notebook';
  config.semanticModel.enabled = true;
  if (o.access) {
    config.access = /** @type {any} */ ({ groupId: 'group-1', groupName: 'ValueLens Viewers', rls: { enabled: true, orgAttribute: 'department', applied: [] } });
  }
  // A reload is a repair or change, once the first load has completed.
  if (o.reload) config.firstRun = { jobId: 'job-0', status: 'Completed' };
  /** @type {string[]} */
  const csvFiles = [];
  if (o.upload) {
    config.dataSources.productFeedback = 'csv';
    const csv = join(dir, o.upload === 'fails' ? 'broken-feedback.csv' : 'feedback.csv');
    writeFileSync(csv, 'Feedback Id,Date submitted (UTC),Feedback type,App,Feedback,Email\n1,2026-05-01,Bug,Teams,Slow to open,ana@contoso.com\n');
    csvFiles.push(csv);
  }
  saveConfig(file, config);

  const fabric = fakeFabric();
  if (o.report) fabric.failures.createReport = [new Error('Report publish failed')];
  const accessRuns = [...(o.access ?? [])];
  const checkRuns = [...(o.check ?? [])];
  const completed = { status: 'Completed', startTimeUtc: '2026-06-01T12:01:00Z', endTimeUtc: '2026-06-01T14:00:00Z' };
  // The fake's getJob takes no URL; this one tells the notebooks apart by it.
  fabric.api.getJob = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      const item = url.split('/items/')[1]?.split('/')[0];
      const { notebooks } = config.fabric;
      if (item && item === notebooks.accessScope) return { ...completed, ...accessRuns.shift() };
      if (item && item === notebooks.dataCheck) return { ...completed, ...checkRuns.shift() };
      return { id: 'job-1', ...completed };
    }
  );
  const loads = Object.entries(o.loads ?? {});
  const failing = new Set(loads.filter(([, attempts]) => attempts.at(-1)?.status !== 'Succeeded').map(([name]) => name));
  fabric.api.queryActivityRuns = async () => [
    ...(fabric.items.find((i) => i.type === 'DataPipeline')?.content.properties.activities ?? []).map((/** @type {any} */ a) => ({
      activityName: a.name,
      // An If fails with the load in it.
      status: [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])].some((/** @type {{ name: string }} */ i) => failing.has(i.name))
        ? 'Failed'
        : 'Succeeded',
      activityRunStart: '2026-06-01T12:01:00Z',
    })),
    ...loads.flatMap(([activityName, attempts]) => attempts.map((a, i) => ({ activityName, activityRunStart: `2026-06-01T12:0${i + 2}:00Z`, ...a }))),
  ];
  const graph = fakeAzureGraph();
  graph.applications.push({ id: 'obj-1', appId: 'app-1', displayName: 'ValueLens' });
  const powerBi = fakePowerBi();
  const ui = fakeUi();
  if (o.reload) {
    const select = ui.ui.select;
    ui.ui.select = /** @type {any} */ (
      async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) =>
        message.startsWith('Load more audit history?') ? o.reload : select(message, choices, def)
    );
  }
  let sleeps = 0;
  const ctx = createCtx({
    ui: ui.ui,
    config,
    file,
    api: /** @type {any} */ ({
      fabric: { ...fabric.api, tenantSettings: forbidden },
      graph: {
        ...graph.api,
        subscribedSkus: forbidden,
        myDirectoryRoles: async () => [],
        usersCanRegisterApps: async () => true,
        ensureRequiredAccess: async () => false,
        findGroupByName: async (/** @type {string} */ name) => ({ id: 'group-1', displayName: name }),
        getGroup: async (/** @type {string} */ id) => ({ id, displayName: 'ValueLens Viewers' }),
        appRoleAssignments: async () => (await graph.api.graphServicePrincipal()).appRoles.map((r) => ({ resourceId: 'graph-sp', appRoleId: r.id })),
      },
      powerBi: { ...powerBi.api, datasetUsers: async () => [], addDatasetUser: async () => null },
      arm: { listSubscriptions: async () => [] },
      keyVault: {},
      oneLake: {
        readJson: async () => null,
        readText: async () => null,
        createDirectory: async () => {
          if (o.noDropFolder) throw new Error('403 Forbidden');
        },
        writeFile: async (/** @type {string} */ ws, /** @type {string} */ lh, /** @type {string} */ path) => {
          if (path.includes('broken')) throw new Error('403 Forbidden');
        },
      },
      discovery: {},
    }),
    user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
    sources: realSources(),
    sleep: async () => {
      if (++sleeps > 300) throw new Error('The install is stuck waiting.');
    },
    now: () => new Date('2026-06-01T12:00:00Z'),
  });
  if (!o.reload) ctx.runFirstLoad = true;
  ctx.csvFiles = csvFiles;
  const ok = await install(ctx, { wait: true });
  const text = ui.text();
  if (o.reload) {
    assert.match(text, /Reload audit history/);
    assert.equal(config.history.days, o.reload);
  } else assert.equal(config.firstRun?.status, 'Completed', 'the history loaded, whatever else failed');
  return { ok, text, ctx, ui, fabric, config };
}

/** @param {{ ok: boolean, text: string }} run */
function setUp({ ok, text }) {
  assert.equal(ok, true);
  assert.match(text, /ValueLens is set up/);
  assert.doesNotMatch(text, /partly set up/);
}

/** @param {{ ok: boolean, text: string }} run */
function partlySetUp({ ok, text }) {
  assert.equal(ok, false);
  assert.match(text, /ValueLens is partly set up/);
  assert.match(text, /A step above didn't finish\. Fix what it says, then run the installer again/);
  assert.doesNotMatch(text, /ValueLens is set up/);
}

test('install: with nothing failing it is set up', async (t) => {
  setUp(await runInstall(t));
});

test('install: a report that fails to publish leaves it partly set up', async (t) => {
  const run = await runInstall(t, { report: true });
  assert.match(run.text, /The ValueLens report wasn't published: Report publish failed/);
  partlySetUp(run);
});

test("install: an export that fails to upload leaves it partly set up; a drop folder it couldn't make only warns", async (t) => {
  const run = await runInstall(t, { upload: 'fails' });
  assert.match(run.text, /✗ Couldn't upload broken-feedback\.csv: 403 Forbidden/);
  assert.match(run.text, /yourself, or run ".*upload <file>" again\./);
  partlySetUp(run);

  const warned = await runInstall(t, { upload: 'works', noDropFolder: true });
  assert.match(warned.text, /! Couldn't make .+ \(403 Forbidden\)/);
  assert.match(warned.text, /✓ Uploaded feedback\.csv/);
  assert.doesNotMatch(warned.text, /✗/);
  setUp(warned);
});

test('install: org-scoped access that fails leaves it partly set up; a busy capacity it waits out does not', async (t) => {
  const run = await runInstall(t, { access: [failed('The XMLA endpoint is read-only.')] });
  assert.match(run.text, /✗ The roles weren't applied: The XMLA endpoint is read-only\./);
  assert.match(run.text, /Then try again from "access"\./);
  partlySetUp(run);

  const retried = await runInstall(t, { access: [busy] });
  assert.match(retried.text, /! Org-scoped access: the capacity is busy\. Trying again in 5 minutes\./);
  assert.match(retried.text, /✓ Org-scoped access applied to/);
  assert.doesNotMatch(retried.text, /✗/);
  setUp(retried);
});

test('install: a data check that fails leaves it partly set up; one that only warns, or waits out a busy capacity, does not', async (t) => {
  const run = await runInstall(t, { check: [failed('Table not found.')] });
  assert.match(run.text, /✗ Data check failed/);
  assert.match(run.text, /Run ".*check" to try it again\./);
  partlySetUp(run);

  const warned = await runInstall(t, { check: [{ status: 'Cancelled' }] });
  assert.match(warned.text, /! Data check ended with status Cancelled/);
  assert.doesNotMatch(warned.text, /✗/);
  setUp(warned);

  const retried = await runInstall(t, { check: [busy] });
  assert.match(retried.text, /Data check: Fabric's capacity is still busy\. Trying again in 5 minutes\./);
  assert.match(retried.text, /✓ Data check finished/);
  assert.doesNotMatch(retried.text, /✗/);
  setUp(retried);
});

test('install: a load that fails in a run that completes leaves it partly set up', async (t) => {
  for (const reload of [undefined, 90]) {
    const run = await runInstall(t, { loads: { [M365]: [refused] }, reload });
    assert.match(run.text, /✗ Microsoft 365 activity: failed/);
    assert.match(run.text, /then run ".*rerun-failed"\./);
    partlySetUp(run);
  }
});

test("install: a load that failed on a busy capacity counts; one that loads when it's tried again doesn't", async (t) => {
  const run = await runInstall(t, { loads: { [M365]: [turnedAway] } });
  assert.match(run.text, /✗ Microsoft 365 activity: failed/);
  assert.match(run.text, /Fabric's capacity was too busy to start it\./);
  partlySetUp(run);

  for (const reload of [undefined, 90]) {
    const retried = await runInstall(t, { loads: { [M365]: [refused, { status: 'Succeeded' }] }, reload });
    assert.match(retried.text, /✓ Microsoft 365 activity \(2 attempts\)/);
    assert.doesNotMatch(retried.text, /✗ Microsoft 365 activity/);
    setUp(retried);
  }
});

test('update: a step that fails leaves it not finished, never "Up to date"', async (t) => {
  const run = await runInstall(t);
  setUp(run);
  let from = run.ui.text().length;
  const since = () => run.ui.text().slice(from);
  assert.equal(await update(run.ctx, { wait: true }), true);
  assert.match(since(), /Up to date/);

  from = run.ui.text().length;
  /** @type {any} */ (run.config.semanticModel.report).signature = 'from an older version';
  run.ctx.api.fabric.updateReport = async () => {
    throw new Error('Report update failed');
  };
  assert.equal(await update(run.ctx, { wait: true }), false);
  assert.match(since(), /✗ The ValueLens report wasn't published: Report update failed/);
  assert.match(since(), /✗ The update isn't finished: a step above failed\. Fix what it says, then run ".*update" again\./);
  assert.doesNotMatch(since(), /Up to date|Updated\./);
});
