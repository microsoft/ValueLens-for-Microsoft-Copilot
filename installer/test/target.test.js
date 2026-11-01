// @ts-check
/** The two routes: which one a record is on, the flags that go with each, and what the commands do on each. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { permissionsFor } from '../src/catalog.js';
import { help, parseCli, routeFromFlags } from '../src/cli.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { preview, runCommand } from '../src/install.js';
import { PRODUCT } from '../src/product.js';
import { setupRecovery } from '../src/setup.js';
import { recordWorkspaceGone } from '../src/steps/fabric.js';
import { PAX_RELEASE, RUNNER_SCRIPTS } from '../src/steps/pax/local.js';
import { PAX_SCRIPTS } from '../src/sources.js';
import {
  appName,
  askTarget,
  holdTarget,
  isPax,
  PAX_AGENT365_PERMISSIONS,
  PAX_PERMISSIONS,
  paxHostProblem,
  requiredPermissions,
  ROUTE_NAMES,
  settledRoute,
  TARGETS,
} from '../src/target.js';
import { fakeCtx, fakeUi, realSources } from './fakes.js';

const WINDOWS = Object.freeze({ platform: 'win32', cloudShell: false });

/** A PAX record that has started: its task is registered. */
function paxRecord() {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = 'tenant-1';
  config.pax = { task: { name: PRODUCT.pax.task, at: '02:00', registeredAt: '2026-06-01T12:00:00Z' } };
  return config;
}

/**
 * Just enough of a context for the route questions.
 * @param {import('../src/config.js').InstallConfig} config
 * @param {{ answers?: any[], targetChosen?: boolean, host?: { platform: string, cloudShell: boolean } }} [o]
 */
function routeCtx(config, o = {}) {
  const ui = fakeUi({ answers: o.answers });
  let saves = 0;
  const ctx = /** @type {import('../src/install.js').Ctx} */ (/** @type {unknown} */ ({
    ui: ui.ui,
    config,
    save: () => {
      saves++;
    },
    paxHost: o.host ?? WINDOWS,
    targetChosen: o.targetChosen,
  }));
  return { ctx, ui, saves: () => saves };
}

test('target: two routes, named as the installers agreed', () => {
  assert.deepEqual([...TARGETS], ['fabric', 'pax']);
  assert.deepEqual({ ...ROUTE_NAMES }, { fabric: 'Fabric', pax: 'No Fabric: PAX + SharePoint' });
  assert.ok(Object.isFrozen(ROUTE_NAMES));
  assert.equal(emptyConfig().target, 'fabric', 'a new record is on the Fabric route until asked');
  assert.equal(isPax(emptyConfig()), false);
  assert.equal(isPax(paxRecord()), true);
});

test('target: each route has its own app registration name', () => {
  assert.equal(appName(emptyConfig()), 'ValueLens (Fabric)');
  assert.equal(appName(paxRecord()), 'ValueLens (PAX)');
  assert.equal(appName(emptyConfig()), PRODUCT.fabric.app);
  assert.equal(appName(paxRecord()), PRODUCT.pax.app);
});

test('requiredPermissions: the PAX app asks for what PAX reads and one site, sorted; Agent 365 adds its two', () => {
  const fabric = emptyConfig();
  assert.deepEqual(requiredPermissions(fabric), permissionsFor(fabric.modules, fabric.dataSources), 'the Fabric route keeps its catalogue');

  const pax = paxRecord();
  assert.deepEqual(requiredPermissions(pax), ['AuditLogsQuery.Read.All', 'Organization.Read.All', 'Sites.Selected', 'User.Read.All']);
  assert.deepEqual(requiredPermissions(pax), [...PAX_PERMISSIONS].sort());
  for (const broad of ['Sites.ReadWrite.All', 'Sites.Read.All', 'Files.ReadWrite.All', 'Directory.Read.All']) {
    assert.ok(!requiredPermissions(pax).includes(broad), `no ${broad}: Sites.Selected reaches only the granted site`);
  }

  /** @type {any} */ (pax.pax).agent365 = true;
  const withRegistry = requiredPermissions(pax);
  assert.deepEqual(withRegistry, [...withRegistry].sort());
  assert.equal(new Set(withRegistry).size, withRegistry.length, 'no duplicates');
  for (const p of [...PAX_PERMISSIONS, ...PAX_AGENT365_PERMISSIONS]) assert.ok(withRegistry.includes(p), p);
  assert.equal(withRegistry.length, PAX_PERMISSIONS.length + PAX_AGENT365_PERMISSIONS.length);
});

test('settledRoute: a record keeps the route it started on; the workspace alone settles nothing', () => {
  const config = emptyConfig();
  assert.equal(settledRoute(config), undefined);
  config.fabric.workspaceId = 'ws-1';
  assert.equal(settledRoute(config), undefined, 'both routes have a workspace');

  for (const set of [
    (/** @type {any} */ c) => (c.fabric.lakehouseId = 'lh-1'),
    (/** @type {any} */ c) => (c.fabric.pipelineId = 'pl-1'),
    (/** @type {any} */ c) => (c.fabric.notebooks = { dataCheck: 'nb-1' }),
  ]) {
    const c = emptyConfig();
    set(c);
    assert.equal(settledRoute(c), 'fabric');
  }
  for (const set of [
    (/** @type {any} */ c) => (c.pax = { task: { name: 't', at: '02:00' } }),
    (/** @type {any} */ c) => (c.pax = { credentialTarget: `${PRODUCT.pax.credentialPrefix}tenant-1` }),
    (/** @type {any} */ c) => (c.sharePoint = { folderUrl: 'https://contoso.sharepoint.com/sites/a/Shared%20Documents', siteUrl: 'x', sitePath: 'x', library: 'Shared Documents', folderPath: '/' }),
  ]) {
    const c = emptyConfig();
    set(c);
    assert.equal(settledRoute(c), 'pax');
  }
  const empty = emptyConfig();
  empty.pax = {};
  assert.equal(settledRoute(empty), undefined, 'an empty pax section settles nothing');
});

test('paxHostProblem: the PAX route needs a Windows PC, not Cloud Shell', () => {
  assert.equal(paxHostProblem(WINDOWS), undefined);
  const cloud = paxHostProblem({ platform: 'linux', cloudShell: true });
  assert.match(String(cloud), /can't be set up from Azure Cloud Shell/);
  assert.match(String(cloud), new RegExp(`^The ${ROUTE_NAMES.pax.replace(/[+]/g, '\\+')} route runs a daily task on a Windows PC`));
  assert.match(String(paxHostProblem({ platform: 'win32', cloudShell: true })), /Azure Cloud Shell/, 'Cloud Shell, whatever it reports');
  for (const platform of ['linux', 'darwin']) {
    const why = String(paxHostProblem({ platform, cloudShell: false }));
    assert.match(why, /Windows Task Scheduler, so it needs a Windows PC/);
    assert.match(why, /or choose the Fabric route\.$/);
  }
});

test('holdTarget: commands follow the record\'s route, and --target can\'t move it', () => {
  // A PAX record saved before the route was known reads as Fabric; its PAX parts settle it.
  const pax = paxRecord();
  pax.target = 'fabric';
  const held = routeCtx(pax);
  holdTarget(held.ctx);
  assert.equal(pax.target, 'pax');
  assert.equal(held.saves(), 0, 'holding changes nothing on disk');

  const fresh = emptyConfig();
  fresh.target = 'pax';
  holdTarget(routeCtx(fresh).ctx);
  assert.equal(fresh.target, 'pax', 'an unsettled record keeps what --target or the flags chose');

  const fabric = emptyConfig();
  fabric.fabric.lakehouseId = 'lh-1';
  fabric.target = 'pax';
  assert.throws(() => holdTarget(routeCtx(fabric, { targetChosen: true }).ctx), /This install record is for the Fabric route, so --target pax doesn't apply to it\./);
  const same = paxRecord();
  assert.doesNotThrow(() => holdTarget(routeCtx(same, { targetChosen: true }).ctx));
});

test('askTarget: a new install asks where it runs, Fabric first; the answer is saved', async () => {
  const fresh = routeCtx(emptyConfig(), { answers: ['pax'] });
  assert.equal(await askTarget(fresh.ctx), 'pax');
  assert.equal(fresh.ctx.config.target, 'pax');
  assert.deepEqual(fresh.ui.asked, [`Where should ${PRODUCT.name} run?`]);
  assert.match(fresh.ui.text(), /Where it runs/);
  assert.equal(fresh.saves(), 1);

  const taken = routeCtx(emptyConfig());
  assert.equal(await askTarget(taken.ctx), 'fabric', 'the default is Fabric');

  const chosen = emptyConfig();
  chosen.target = 'pax';
  const flag = routeCtx(chosen, { targetChosen: true });
  assert.equal(await askTarget(flag.ctx), 'pax');
  assert.deepEqual(flag.ui.asked, [], '--target answers it');
  assert.doesNotMatch(flag.ui.text(), /Where it runs/);
});

test('askTarget: a started record stays on its route, and PAX stops on a PC that can\'t run it', async () => {
  const pax = paxRecord();
  pax.target = 'fabric';
  const started = routeCtx(pax);
  assert.equal(await askTarget(started.ctx), 'pax');
  assert.deepEqual(started.ui.asked, []);

  const fabric = emptyConfig();
  fabric.fabric.lakehouseId = 'lh-1';
  fabric.target = 'pax';
  await assert.rejects(askTarget(routeCtx(fabric, { targetChosen: true }).ctx), /This install record is for the Fabric route\. Uninstall it first to change route, or pass --config with a new file name/);

  const cloud = routeCtx(emptyConfig(), { answers: ['pax'], host: { platform: 'linux', cloudShell: true } });
  await assert.rejects(askTarget(cloud.ctx), /can't be set up from Azure Cloud Shell/);
  assert.equal(cloud.saves(), 0, 'nothing is saved for a route this PC can\'t run');
  const mac = routeCtx(emptyConfig(), { host: { platform: 'darwin', cloudShell: false } });
  assert.equal(await askTarget(mac.ctx), 'fabric', 'the Fabric route runs from anywhere');
});

test('routeFromFlags: --target, then the record, then the flags given; flags from both routes clash', () => {
  const none = { fabricFlags: [], paxFlags: [] };
  assert.equal(routeFromFlags(none, undefined), undefined);
  assert.equal(routeFromFlags({ ...none, target: 'pax' }, undefined), 'pax');
  assert.equal(routeFromFlags(none, 'pax'), 'pax');
  assert.equal(routeFromFlags({ ...none, target: 'fabric' }, 'fabric'), 'fabric');
  assert.equal(routeFromFlags({ fabricFlags: ['--data'], paxFlags: [] }, undefined), 'fabric');
  assert.equal(routeFromFlags({ fabricFlags: [], paxFlags: ['--environment-id'] }, undefined), 'pax');

  assert.throws(
    () => routeFromFlags({ fabricFlags: ['--data'], paxFlags: ['--environment-id'] }, undefined),
    /^Error: --data is for the Fabric route and --environment-id is for the No Fabric: PAX \+ SharePoint route, so they can't go together\.$/,
  );
  assert.throws(() => routeFromFlags({ target: 'pax', fabricFlags: ['--data', '--csv'], paxFlags: [] }, undefined), /--data and --csv are for the Fabric route, so they don't go with --target pax\./);
  assert.throws(() => routeFromFlags({ fabricFlags: ['--run'], paxFlags: [] }, 'pax'), /--run is for the Fabric route, so it doesn't go with this install record\./);
  assert.throws(() => routeFromFlags({ target: 'fabric', fabricFlags: [], paxFlags: ['--folder'] }, undefined), /--folder is for the No Fabric: PAX \+ SharePoint route, so it doesn't go with --target fabric\./);
  assert.throws(() => routeFromFlags({ fabricFlags: ['--key-vault', '--csv', '--data'], paxFlags: [] }, 'pax'), /--key-vault, --csv and --data are for the Fabric route/);
});

test('parseCli: --target, deploy-app and the PAX route\'s flags', () => {
  /** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] */
  const parse = (argv, env = {}) => parseCli(argv, env);
  assert.equal(parse([]).target, undefined);
  assert.deepEqual([parse([]).fabricFlags, parse([]).paxFlags], [[], []]);
  assert.equal(parse(['--target', 'pax']).target, 'pax');
  assert.equal(parse(['prereqs', '--target', 'fabric']).target, 'fabric');
  assert.throws(() => parse(['--target', 'azure']), /--target must be "fabric" or "pax"\./);
  assert.throws(() => parse(['--target', 'pax'], { ACC_CLOUD: 'PROD' }), /can't be set up from Azure Cloud Shell/);
  assert.equal(parse(['--target', 'fabric'], { ACC_CLOUD: 'PROD' }).target, 'fabric');

  assert.equal(parse(['deploy-app']).command, 'deploy-app');
  assert.equal(parse(['deploy-app', '--environment-id', 'Default-1234']).environmentId, 'Default-1234');
  assert.deepEqual(parse(['install', '--environment-id', 'env-1']).paxFlags, ['--environment-id']);
  assert.throws(() => parse(['run', '--environment-id', 'env-1']), /--environment-id goes with install or deploy-app\./);
  assert.throws(() => parse(['install', '--environment-id', 'not an id!']), /--environment-id should be the environment's ID/);
  assert.throws(() => parse(['install', '--environment-id=-env']), /--environment-id should be the environment's ID/);
  assert.throws(() => parse(['install', '--environment-id', 'env-1', '--data', 'workday=csv']), /can't go together/);
  assert.throws(() => parse(['install', '--target', 'fabric', '--environment-id', 'env-1']), /doesn't go with --target fabric/);
  assert.throws(() => parse(['install', '--target', 'pax', '--key-vault']), /--key-vault is for the Fabric route, so it doesn't go with --target pax\./);

  const up = parse(['upload', 'a.csv', '--folder', 'Exports/2026']);
  assert.equal(up.folder, 'Exports/2026');
  assert.deepEqual(up.files, ['a.csv']);
  assert.deepEqual(up.paxFlags, ['--folder']);
  assert.throws(() => parse(['status', '--folder', 'x']), /--folder goes with upload\./);
  assert.throws(() => parse(['upload', 'a.csv', '--folder', 'x', '--run']), /can't go together/);
  assert.deepEqual(parse(['upload', 'a.csv', '--run']).fabricFlags, ['--run']);

  assert.throws(() => parse(['--ui', '--target', 'pax']), /With --ui, choose where it runs on the page\./);
  assert.throws(() => parse(['--ui', '--environment-id', 'env-1']), /With --ui, choose where it runs on the page\./);
});

test('help: both routes, the route flag and the PAX commands, and never the retired label', () => {
  const text = help();
  for (const name of Object.values(ROUTE_NAMES)) assert.ok(text.includes(name), name);
  assert.match(text, /--target <target>\s+The route, fabric or pax\./);
  assert.match(text, /\n {2}deploy-app {7}PAX: deploy the app/);
  assert.match(text, /--environment-id <id>/);
  assert.match(text, /--folder <path>/);
  assert.match(text, /No Fabric: PAX \+ SharePoint route options/);
  assert.doesNotMatch(text, /App Edition/i);
  assert.doesNotMatch(text, /Analytics Hub|Credit Consumption|Agent Evaluator/, 'this installer is ValueLens only');
});

test('runCommand: deploy-app is the PAX route\'s; upload --run is the Fabric route\'s', async () => {
  const fabric = fakeCtx();
  await assert.rejects(runCommand(fabric.ctx, 'deploy-app', { wait: true }), /^Error: deploy-app is for the No Fabric: PAX \+ SharePoint route\. On the Fabric route the installer sets up the report, not the app\.$/);

  const pax = fakeCtx({ config: paxRecord() });
  delete pax.config.fabric.lakehouseId;
  await assert.rejects(runCommand(pax.ctx, 'upload', { wait: true, run: true, files: ['a.csv'] }), /--run loads uploaded exports on the Fabric route\. On this route the report reads only the files the refresh writes, so leave out --run\./);
  assert.equal(pax.saves(), 0);

  const moved = fakeCtx({ config: paxRecord() });
  moved.ctx.targetChosen = true;
  moved.config.target = 'fabric';
  delete moved.config.fabric.lakehouseId;
  await assert.rejects(runCommand(moved.ctx, 'status', { wait: true }), /This install record is for the No Fabric: PAX \+ SharePoint route, so --target fabric doesn't apply to it\./);
});

test('recordWorkspaceGone: a PAX record is only checked for its tenant, since its workspace may be Pro', async () => {
  const config = paxRecord();
  config.fabric.workspaceId = 'ws-1';
  config.fabric.workspaceName = 'ValueLens';
  let asked = 0;
  const fabric = {
    getWorkspace: async () => {
      asked++;
      throw new HttpError('Not found', { status: 404, method: 'GET', url: 'https://api.fabric.microsoft.com/v1/workspaces/ws-1' });
    },
  };
  assert.equal(await recordWorkspaceGone({ config, fabric, tenantId: 'tenant-1' }), null);
  assert.equal(await recordWorkspaceGone({ config, fabric, tenantId: 'TENANT-1' }), null, 'tenant IDs compare without case');
  assert.deepEqual(await recordWorkspaceGone({ config, fabric, tenantId: 'tenant-2' }), { workspace: 'ValueLens', reason: 'other-tenant' });
  assert.equal(asked, 0, 'Fabric is never asked about a PAX record\'s workspace');

  const fabricRecord = emptyConfig();
  fabricRecord.fabric.workspaceId = 'ws-1';
  assert.deepEqual(await recordWorkspaceGone({ config: fabricRecord, fabric }), { workspace: 'ws-1', reason: 'not-found' }, 'the Fabric route still asks');
  assert.equal(asked, 1);
});

test('setupRecovery: a PAX setup that fails has no settings page to reopen', () => {
  const pax = paxRecord();
  for (const message of ['RequestDisallowedByPolicy', 'The region is out of capacity', 'SkuNotAvailable']) {
    assert.equal(setupRecovery(new Error(message), pax).section, undefined, message);
    assert.equal(setupRecovery(new Error(message), emptyConfig()).section !== undefined, true, `the Fabric route reopens a section for ${message}`);
  }
});

test('preview: on the PAX route, refresh.json, the task\'s scripts and the app\'s permissions, without signing in', () => {
  const out = mkdtempSync(join(tmpdir(), 'vl-preview-pax-'));
  try {
    const config = emptyConfig();
    config.target = 'pax';
    const ui = fakeUi();
    preview({ ui: ui.ui, config, sources: realSources(), outDir: out });

    assert.deepEqual(readdirSync(out).sort(), ['graph-permissions.txt', 'refresh.json', 'scripts']);
    assert.ok(!existsSync(join(out, 'notebooks')), 'no Fabric items');
    const refresh = JSON.parse(readFileSync(join(out, 'refresh.json'), 'utf8'));
    assert.equal(refresh.product, PRODUCT.name);
    assert.equal(refresh.tenantId, '00000000-0000-0000-0000-000000000000');
    assert.equal(refresh.clientId, '00000000-0000-0000-0000-000000000001');
    assert.equal(refresh.credentialTarget, `${PRODUCT.pax.credentialPrefix}00000000-0000-0000-0000-000000000000`);
    assert.equal(refresh.paxReleaseTag, PAX_RELEASE.tag);
    assert.match(refresh.paxSha256, /^[0-9a-f]{64}$/, 'PAX is pinned by its SHA-256');
    assert.equal(refresh.folderPath, `/${PRODUCT.name}`);
    assert.deepEqual(refresh.files, { ...PRODUCT.pax.files });
    assert.equal(config.sharePoint, undefined, 'the placeholders stay out of the record');

    const scripts = readdirSync(join(out, 'scripts')).sort();
    const shipped = realSources().paxScripts ? [...RUNNER_SCRIPTS, ...PAX_SCRIPTS] : [...RUNNER_SCRIPTS];
    assert.deepEqual(scripts, [...shipped].sort());

    const perms = readFileSync(join(out, 'graph-permissions.txt'), 'utf8');
    for (const p of PAX_PERMISSIONS) assert.ok(perms.includes(`  ${p}\n`), p);
    assert.match(perms, /Sites\.Selected reaches only the site the installer grants it\./);
    assert.doesNotMatch(perms, /Files\.ReadWrite\.All|Sites\.ReadWrite\.All/);
    assert.match(ui.text(), /Preview written/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
