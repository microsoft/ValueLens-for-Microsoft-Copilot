// @ts-check
/** The install record when its workspace has gone, and what the launch and the wording say. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startFresh } from '../src/cli.js';
import { archiveConfig, emptyConfig, loadConfig, saveConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { recordWorkspaceGone, staleRecordMessage } from '../src/steps/fabric.js';
import { adoptUploadedRecord, CLOUD_SHELL_ENV, cloudShellKeepsFiles, cloudShellRecordMessage } from '../src/launch.js';
import { confirmPlan, KEEP_AWAKE, KEEP_CLOUD_SHELL_OPEN, keepAwake } from '../src/steps/plan.js';
import { runPipeline } from '../src/steps/run.js';
import { createUi } from '../src/ui.js';
import { createWebUi } from '../src/web-ui.js';
import { createSession } from '../src/web-session.js';
import { fakeCtx, fakeFabric, fakeUi, httpError } from './fakes.js';

const SRC = new URL('../src/', import.meta.url);

/** A Fabric install record for workspace ws-1 in tenant-1. */
function record() {
  const config = emptyConfig();
  config.tenantId = 'tenant-1';
  config.fabric.workspaceId = 'ws-1';
  config.fabric.workspaceName = 'Analytics';
  config.fabric.lakehouseId = 'lh-1';
  return config;
}

/** @param {(dir: string) => Promise<void> | void} fn */
async function inDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vl-record-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {() => Promise<any>} getWorkspace */
const fabricThat = (getWorkspace) => ({ getWorkspace: async (/** @type {string} */ _id) => getWorkspace() });

test('record: archiving renames it beside itself with the date and time, and never overwrites', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    saveConfig(file, record());
    const at = new Date(2026, 4, 7, 9, 3, 2);
    const to = archiveConfig(file, at);
    assert.equal(to, join(dir, 'valuelens-setup.20260507-090302.json'));
    assert.ok(!existsSync(file));
    assert.equal(loadConfig(to).config.fabric.workspaceId, 'ws-1');

    saveConfig(file, record());
    assert.equal(archiveConfig(file, at), join(dir, 'valuelens-setup.20260507-090302-2.json'));
    assert.deepEqual(readdirSync(dir).sort(), ['valuelens-setup.20260507-090302-2.json', 'valuelens-setup.20260507-090302.json']);
  }));

/** @param {string} code */
const locked = (code) => Object.assign(new Error(code), { code });

test('record: a rename blocked for a moment (a synced folder) is retried', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    let calls = 0;
    /** @type {number[]} */
    const waits = [];
    const rename = (/** @type {string} */ from, /** @type {string} */ to) => {
      if (++calls < 3) throw locked('EPERM');
      renameSync(from, to);
    };
    saveConfig(file, record(), { rename, wait: (ms) => waits.push(ms) });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [100, 200]);
    assert.equal(loadConfig(file).config.fabric.workspaceId, 'ws-1');
    assert.deepEqual(readdirSync(dir), ['valuelens-setup.json']);
  }));

test('record: a rename that stays blocked writes the record in place, so progress is kept', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    saveConfig(file, emptyConfig());
    let calls = 0;
    const rename = () => { calls++; throw locked('EBUSY'); };
    saveConfig(file, record(), { rename, wait: () => {}, tries: 3 });
    assert.equal(calls, 3);
    assert.equal(loadConfig(file).config.fabric.workspaceId, 'ws-1');
    assert.deepEqual(readdirSync(dir), ['valuelens-setup.json']);
  }));

test('record: any other rename error is not retried', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    let calls = 0;
    const rename = () => { calls++; throw locked('ENOSPC'); };
    assert.throws(() => saveConfig(file, record(), { rename, wait: () => {} }), /ENOSPC/);
    assert.equal(calls, 1);
  }));

test("record: a save that doesn't read back as written fails, so no step counts as done", () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    assert.throws(() => saveConfig(file, record(), { read: () => '{}\n' }), /didn't save: it reads back different/);
    saveConfig(file, record(), { read: (f) => readFileSync(f, 'utf8') });
    assert.equal(loadConfig(file).config.fabric.workspaceId, 'ws-1');
  }));

test('record: the access command saving while the install waits on its first load keeps its changes when the install saves after it', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    // The install: a new record, then the viewer group.
    const install = loadConfig(file).config;
    Object.assign(install, { tenantId: 'tenant-1' });
    Object.assign(install.fabric, { workspaceId: 'ws-1', workspaceName: 'ValueLens', lakehouseId: 'lh-1' });
    saveConfig(file, install);
    install.access = { groupId: 'group-1', groupName: 'ValueLens Viewers', contact: 'admin@contoso.com', createdGroup: true, grantedModels: [] };
    const access = install.access;
    saveConfig(file, install);
    // The first load starts; the install waits for it, for hours on a large tenant.
    install.firstRun = { jobId: 'job-1', status: 'NotStarted', startedAt: '2026-06-01T12:30:00.000Z' };
    saveConfig(file, install);

    // Meanwhile the access command, in another window, grants the model and turns on org-scoped access.
    const other = loadConfig(file).config;
    other.access = { ...other.access, grantedModels: ['vl'] };
    saveConfig(file, other);
    Object.assign(/** @type {import('../src/config.js').AccessConfig} */ (other.access), { rls: { enabled: true, orgAttribute: 'country', applied: [] } });
    saveConfig(file, other);
    const changed = structuredClone(other.access);

    // The first load finishes and the install saves what it holds in memory.
    install.firstRun = { ...install.firstRun, status: 'Completed', finishedAt: '2026-06-01T16:00:00.000Z' };
    saveConfig(file, install);

    const saved = loadConfig(file).config;
    assert.deepEqual(saved.access, changed, "the access command's changes survive the install's save");
    assert.equal(saved.firstRun?.status, 'Completed');
    assert.equal(saved.firstRun?.finishedAt, '2026-06-01T16:00:00.000Z');
    assert.deepEqual(install.access, changed, 'and the install has them in memory, for its summary');
    assert.equal(install.access, access, 'in the same object, so code holding it sees them too');
    assert.equal(access.rls?.orgAttribute, 'country');

    install.history.days = 90;
    saveConfig(file, install);
    assert.deepEqual(loadConfig(file).config.access, changed, 'and later saves keep it');
    assert.equal(loadConfig(file).config.history.days, 90);
  }));

test('record: when two commands change the same field the later save wins; a field the other removed stays removed', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    const first = loadConfig(file).config;
    first.access = { groupId: 'group-1', groupName: 'ValueLens Viewers', contact: 'admin@contoso.com' };
    first.uploads.flowIds = { feedback: 'flow-1' };
    saveConfig(file, first);

    const install = loadConfig(file).config;
    const other = loadConfig(file).config;
    other.schedule.time = '04:00';
    other.access = { ...other.access, contact: 'helpdesk@contoso.com' };
    delete other.uploads.flowIds;
    saveConfig(file, other);
    install.schedule.time = '03:00';
    install.history.days = 90;
    saveConfig(file, install);

    for (const config of [loadConfig(file).config, install]) {
      assert.equal(config.schedule.time, '03:00');
      assert.equal(config.history.days, 90);
      assert.equal(config.access?.contact, 'helpdesk@contoso.com');
      assert.equal(config.access?.groupName, 'ValueLens Viewers');
      assert.equal(config.uploads.flowIds, undefined);
    }
  }));

test('record: the groups that were the viewer group, and the models they still have Build on, read back as saved', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    const config = record();
    const retiredGroups = [{ groupId: 'g-2', groupName: 'Old viewers', datasets: ['ds-1', 'ds-2'] }, { groupId: 'g-3', datasets: ['ds-1'] }];
    config.access = { groupId: 'g-1', grantedModels: ['ds-1'], retiredGroups: structuredClone(retiredGroups) };
    saveConfig(file, config);
    assert.deepEqual(loadConfig(file).config.access?.retiredGroups, retiredGroups);
  }));

test('record: a record saved to another file, such as the setup draft, is written as it is', () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    const draft = `${file}.draft.json`;
    const live = loadConfig(file).config;
    saveConfig(draft, live);
    saveConfig(draft, { ...live, setup: { completed: [], approved: true } });
    live.history.days = 90;
    saveConfig(draft, live);
    assert.equal(loadConfig(draft).config.setup, undefined);
    assert.equal(loadConfig(draft).config.history.days, 90);
    assert.equal(live.setup, undefined);
  }));

test("record: a half-written record from another command is waited for; if it stays unreadable, this command's changes are saved", () =>
  inDir((dir) => {
    const file = join(dir, 'valuelens-setup.json');
    saveConfig(file, record());
    const install = loadConfig(file).config;
    const other = loadConfig(file).config;
    other.semanticModel.id = 'model-1';
    const whole = `${JSON.stringify(other, null, 2)}\n`;
    // Written in place, as a save does when a synced folder keeps blocking the rename, and caught part way.
    writeFileSync(file, whole.slice(0, 40), 'utf8');
    install.history.days = 90;
    /** @type {number[]} */
    const waits = [];
    saveConfig(file, install, { wait: (ms) => { waits.push(ms); writeFileSync(file, whole, 'utf8'); } });
    assert.deepEqual(waits, [100]);
    assert.equal(loadConfig(file).config.semanticModel.id, 'model-1');
    assert.equal(loadConfig(file).config.history.days, 90);

    writeFileSync(file, '{\n  "version": 1,\n  "fabr', 'utf8');
    install.schedule.time = '05:00';
    waits.length = 0;
    saveConfig(file, install, { wait: (ms) => waits.push(ms) });
    assert.deepEqual(waits, [100, 200]);
    const saved = loadConfig(file).config;
    assert.equal(saved.schedule.time, '05:00');
    assert.equal(saved.history.days, 90);
    assert.equal(saved.semanticModel.id, 'model-1');
  }));

test('record: only a definite not-found, or another tenant, makes the workspace gone', async () => {
  const config = record();
  const gone = (/** @type {() => Promise<any>} */ get, tenantId = 'tenant-1') => recordWorkspaceGone({ config, fabric: fabricThat(get), tenantId });

  assert.equal(await gone(async () => ({ id: 'ws-1' })), null, 'still there');
  assert.deepEqual(await gone(async () => { throw httpError(404); }), { workspace: 'Analytics', reason: 'not-found' });
  const coded = new HttpError('Gone', { status: 400, method: 'GET', url: 'https://x', code: 'WorkspaceNotFound' });
  assert.deepEqual(await gone(async () => { throw coded; }), { workspace: 'Analytics', reason: 'not-found' });

  assert.equal(await gone(async () => { throw httpError(403, 'Forbidden'); }), null, 'a 403 is not a not-found');
  const forbiddenCode = new HttpError('No', { status: 403, method: 'GET', url: 'https://x', code: 'WorkspaceNotFound' });
  assert.equal(await gone(async () => { throw forbiddenCode; }), null, 'not even with a not-found code');
  assert.equal(await gone(async () => { throw new TypeError('fetch failed'); }), null, 'a network error');
  assert.equal(await gone(async () => { throw httpError(500, 'Oops'); }), null);

  let asked = false;
  const other = await gone(async () => {
    asked = true;
    return { id: 'ws-1' };
  }, 'tenant-2');
  assert.deepEqual(other, { workspace: 'Analytics', reason: 'other-tenant' });
  assert.equal(asked, false, 'another tenant is gone without asking Fabric');
  assert.equal(await gone(async () => ({}), 'TENANT-1'), null, 'tenant IDs match whatever their case');

  assert.equal(await recordWorkspaceGone({ config: emptyConfig(), fabric: fabricThat(async () => { throw httpError(404); }), tenantId: 'tenant-1' }), null);

  assert.equal(staleRecordMessage({ workspace: 'Analytics', reason: 'not-found' }), 'This workspace no longer exists: "Analytics".');
  assert.match(staleRecordMessage({ workspace: 'Analytics', reason: 'other-tenant' }), /"Analytics" in another tenant/);
});

/**
 * A browser session over a record in a temporary folder, signed in to `tenantId`.
 * @param {string} dir
 * @param {() => Promise<any>} getWorkspace
 * @param {string} [tenantId]
 */
function session(dir, getWorkspace, tenantId = 'tenant-1') {
  const configFile = join(dir, 'valuelens-setup.json');
  saveConfig(configFile, record());
  const ui = createWebUi({ now: () => 1000 });
  /** @type {any} */
  const api = { fabric: fabricThat(getWorkspace) };
  const connect = async () => ({ api, user: { id: 'u', upn: 'admin@contoso.com', tenantId } });
  const s = createSession({ ui, configFile, version: '0.0.0', connect: /** @type {any} */ (connect) });
  const ended = () => ui.history().filter((e) => e.type === 'command' && e.state !== 'running');
  return { s, ui, configFile, ended };
}

test('web session: a workspace that has gone stops the command, and the home page offers to start fresh', () =>
  inDir(async (dir) => {
    const { s, ui, configFile, ended } = session(dir, async () => { throw httpError(404); });
    assert.equal(s.state().stale, null, 'nothing is known before sign-in');
    assert.equal(s.start({ command: 'status' }).ok, true);
    await s.settled();
    assert.deepEqual(ended().map((e) => [e.state, e.stale]), [['failed', true]]);
    assert.match(String(ended()[0].error), /^This workspace no longer exists: "Analytics"\. Go back to the home page/);
    assert.ok(ui.history().some((e) => e.type === 'record-checked'));
    assert.deepEqual(s.state().stale, { workspace: 'Analytics', reason: 'not-found' });

    const fresh = s.startFresh();
    assert.equal(fresh.ok, true);
    const archived = /** @type {{ archived: string }} */ (fresh).archived;
    assert.match(archived, /valuelens-setup\.\d{8}-\d{6}\.json$/);
    assert.ok(existsSync(archived) && !existsSync(configFile));
    const st = s.state();
    assert.equal(st.record, null, 'the home page is a fresh install');
    assert.equal(st.stale, null);
    assert.equal(st.user?.upn, 'admin@contoso.com', 'still signed in');
  }));

test('web session: another tenant counts as gone; keeping the record lets commands run again', () =>
  inDir(async (dir) => {
    let calls = 0;
    const { s, ended } = session(dir, async () => {
      calls++;
      return { id: 'ws-1' };
    }, 'tenant-2');
    s.start({ command: 'status', tenant: 'tenant-2' });
    await s.settled();
    assert.deepEqual(s.state().stale, { workspace: 'Analytics', reason: 'other-tenant' });
    assert.equal(ended()[0].stale, true);
    assert.equal(calls, 0);

    assert.deepEqual(s.keepRecord(), { ok: true });
    assert.equal(s.state().stale, null);
    s.start({ command: 'status', tenant: 'tenant-2' });
    await s.settled();
    assert.equal(ended().length, 2);
    assert.equal(ended()[1].stale, undefined, 'kept: the command goes on, and fails the usual way');
    assert.match(String(ended()[1].error), /install record is for tenant tenant-1/);
  }));

test('web session: a 403 or a network error leaves the record as it is', () =>
  inDir(async (dir) => {
    for (const err of [httpError(403, 'Forbidden'), new TypeError('fetch failed')]) {
      const { s, ended } = session(dir, async () => { throw err; });
      s.start({ command: 'status' });
      await s.settled();
      assert.equal(s.state().stale, null);
      assert.notEqual(ended()[0].stale, true);
      assert.ok(s.state().record, 'the record is still there');
    }
  }));

test('web session: start fresh waits for a running command, and works with no record', () =>
  inDir(async (dir) => {
    const { s, configFile } = session(dir, async () => new Promise(() => {}));
    s.start({ command: 'status' });
    const busy = s.startFresh();
    assert.equal(busy.ok, false);
    assert.equal(/** @type {any} */ (busy).status, 409);
    assert.ok(existsSync(configFile));
    rmSync(configFile);
    const none = createSession({ ui: createWebUi(), configFile, version: '0.0.0' }).startFresh();
    assert.deepEqual(none, { ok: true, archived: null });
  }));

test('terminal: install offers to start fresh, other commands and --yes stop and say how', () =>
  inDir(async (dir) => {
    const file = join(dir, 'valuelens-setup.json');
    const missing = fabricThat(async () => { throw httpError(404); });

    saveConfig(file, record());
    const yes = fakeUi({ answers: [true] });
    assert.equal(await startFresh({ ui: yes.ui, config: record(), file, fabric: missing, tenantId: 'tenant-1', command: 'install' }), true);
    assert.match(yes.asked[0], /^Start fresh\? The old install record is kept/);
    assert.match(yes.text(), /This workspace no longer exists: "Analytics"/);
    assert.match(yes.text(), /The old install record is now .*valuelens-setup\.\d{8}-\d{6}\.json/);
    assert.ok(!existsSync(file));

    saveConfig(file, record());
    const keep = fakeUi({ answers: [false] });
    assert.equal(await startFresh({ ui: keep.ui, config: record(), file, fabric: missing, tenantId: 'tenant-1', command: 'install' }), false);
    assert.ok(existsSync(file), 'kept');

    await assert.rejects(startFresh({ ui: fakeUi().ui, config: record(), file, fabric: missing, tenantId: 'tenant-1', command: 'status' }), /no longer exists.*To start fresh, run install\./);
    await assert.rejects(startFresh({ ui: fakeUi({ yes: true }).ui, config: record(), file, fabric: missing, tenantId: 'tenant-1', command: 'install' }), /run install without --yes/);
    const forbidden = fabricThat(async () => { throw httpError(403, 'Forbidden'); });
    assert.equal(await startFresh({ ui: fakeUi().ui, config: record(), file, fabric: forbidden, tenantId: 'tenant-1', command: 'status' }), false);
    assert.ok(existsSync(file));
  }));

test('wording: the run says the web page can be closed, and the terminal Ctrl+C', async () => {
  assert.equal(createUi().web, false);
  assert.equal(createWebUi().web, true);
  for (const web of [false, true]) {
    const fabric = fakeFabric();
    fabric.jobs.push({ status: 'Completed', startTimeUtc: '2026-06-01T12:00:00', endTimeUtc: '2026-06-01T12:01:00' });
    const ui = fakeUi();
    const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: { ...ui.ui, web } });
    config.fabric.pipelineId = 'pipe-1';
    await runPipeline(ctx, { wait: true });
    if (web) {
      assert.match(ui.text(), /You can close this window; the run carries on in Fabric\./);
      assert.doesNotMatch(ui.text(), /Ctrl\+C/);
    } else assert.match(ui.text(), /You can press Ctrl\+C; the run carries on in Fabric\./);
  }
});

test('wording: the plan says to keep the PC awake, just before Go ahead', async () => {
  const ui = fakeUi({ answers: [true] });
  const t = fakeCtx({ ui: ui.ui });
  assert.equal(await confirmPlan(t.ctx), true);
  assert.match(ui.text(), new RegExp(`${KEEP_AWAKE.replace('.', '\\.')}\\n$`));
  assert.equal(ui.asked.at(-1), 'Go ahead?');
});

test('wording: in Cloud Shell the plan says to keep the tab open, not the PC awake', async () => {
  const before = process.env[CLOUD_SHELL_ENV];
  process.env[CLOUD_SHELL_ENV] = '1';
  try {
    const ui = fakeUi({ answers: [true] });
    const t = fakeCtx({ ui: ui.ui });
    assert.equal(await confirmPlan(t.ctx), true);
    assert.match(ui.text(), new RegExp(`${KEEP_CLOUD_SHELL_OPEN.replace('.', '\\.')}\\n$`));
    assert.doesNotMatch(ui.text(), /plugged in/);
  } finally {
    if (before === undefined) delete process.env[CLOUD_SHELL_ENV];
    else process.env[CLOUD_SHELL_ENV] = before;
  }
  assert.equal(keepAwake({}), KEEP_AWAKE);
});

test('Cloud Shell: without a storage account, the end of a run says how to download the record', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-cs-'));
  try {
    assert.equal(cloudShellKeepsFiles(home), false);
    const msg = cloudShellRecordMessage(join(home, 'valuelens', 'valuelens-setup.json'), home);
    assert.match(msg, /Manage files > Download and enter valuelens[\\/]valuelens-setup\.json\./);
    assert.match(msg, /Manage files > Upload, then run the installer again\./);
    mkdirSync(join(home, 'clouddrive'));
    assert.equal(cloudShellKeepsFiles(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Cloud Shell: an uploaded install record is moved to where the installer looks', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-cs-'));
  try {
    const file = join(home, 'valuelens', 'valuelens-setup.json');
    assert.equal(adoptUploadedRecord(file, home), undefined);

    writeFileSync(join(home, 'valuelens-setup.json'), '{"installId":"up"}');
    assert.equal(adoptUploadedRecord(file, home), join(home, 'valuelens-setup.json'));
    assert.equal(readFileSync(file, 'utf8'), '{"installId":"up"}');
    assert.equal(existsSync(join(home, 'valuelens-setup.json')), false);

    // A record already in place wins over a later upload, which stays put.
    writeFileSync(join(home, 'valuelens-setup.json'), '{"installId":"old"}');
    assert.equal(adoptUploadedRecord(file, home), undefined);
    assert.equal(readFileSync(file, 'utf8'), '{"installId":"up"}');
    assert.equal(existsSync(join(home, 'valuelens-setup.json')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('wording: a page that lost its link says to press Enter in the installer window', () => {
  const page = readFileSync(new URL('web/app.js', SRC), 'utf8');
  assert.match(page, /press Enter there to open it again/);
});
