// @ts-check
/** The install record when its workspace has gone, and what the launch and the wording say. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startFresh } from '../src/cli.js';
import { archiveConfig, emptyConfig, loadConfig, saveConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { confirmAzurePlan } from '../src/steps/azure/index.js';
import { recordWorkspaceGone, staleRecordMessage } from '../src/steps/fabric.js';
import { confirmPlan, KEEP_AWAKE } from '../src/steps/plan.js';
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
    const file = join(dir, 'valuelens-install.json');
    saveConfig(file, record());
    const at = new Date(2026, 4, 7, 9, 3, 2);
    const to = archiveConfig(file, at);
    assert.equal(to, join(dir, 'valuelens-install.20260507-090302.json'));
    assert.ok(!existsSync(file));
    assert.equal(loadConfig(to).config.fabric.workspaceId, 'ws-1');

    saveConfig(file, record());
    assert.equal(archiveConfig(file, at), join(dir, 'valuelens-install.20260507-090302-2.json'));
    assert.deepEqual(readdirSync(dir).sort(), ['valuelens-install.20260507-090302-2.json', 'valuelens-install.20260507-090302.json']);
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

  const azure = { ...record(), target: /** @type {const} */ ('azure') };
  assert.equal(await recordWorkspaceGone({ config: azure, fabric: fabricThat(async () => { throw httpError(404); }), tenantId: 'tenant-2' }), null);
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
  const configFile = join(dir, 'valuelens-install.json');
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
    assert.match(archived, /valuelens-install\.\d{8}-\d{6}\.json$/);
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
    const file = join(dir, 'valuelens-install.json');
    const missing = fabricThat(async () => { throw httpError(404); });

    saveConfig(file, record());
    const yes = fakeUi({ answers: [true] });
    assert.equal(await startFresh({ ui: yes.ui, config: record(), file, fabric: missing, tenantId: 'tenant-1', command: 'install' }), true);
    assert.match(yes.asked[0], /^Start fresh\? The old install record is kept/);
    assert.match(yes.text(), /This workspace no longer exists: "Analytics"/);
    assert.match(yes.text(), /The old install record is now .*valuelens-install\.\d{8}-\d{6}\.json/);
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

test('wording: no user-facing text names Rayfin', () => {
  const app = readFileSync(new URL('steps/app.js', SRC), 'utf8');
  const shown = [...app.matchAll(/(?:ui\.(?:info|ok|warn|note|fail|line)|new Error)\(\s*(['`"])(.*?)\1/g)].map((m) => m[2]);
  assert.ok(shown.length > 10);
  assert.deepEqual(shown.filter((s) => /rayfin/i.test(s)), []);
  assert.match(app, /A browser window may open for sign-in\./);
});

test('wording: the plan says to keep the PC awake, just before Go ahead', async () => {
  const ui = fakeUi({ answers: [true] });
  const t = fakeCtx({ ui: ui.ui });
  assert.equal(await confirmPlan(t.ctx), true);
  assert.match(ui.text(), new RegExp(`${KEEP_AWAKE.replace('.', '\\.')}\\n$`));
  assert.equal(ui.asked.at(-1), 'Go ahead?');

  const az = fakeUi({ answers: [true] });
  const a = fakeCtx({ ui: az.ui });
  a.config.target = 'azure';
  a.config.azure = { ...a.config.azure, subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'ah' };
  assert.equal(await confirmAzurePlan(a.ctx), true);
  assert.match(az.text(), /Keep this PC plugged in and awake until setup finishes\./);
});

test('wording: a page that lost its link says to press Enter in the installer window', () => {
  const page = readFileSync(new URL('web/app.js', SRC), 'utf8');
  assert.match(page, /press Enter there to open it again/);
});
