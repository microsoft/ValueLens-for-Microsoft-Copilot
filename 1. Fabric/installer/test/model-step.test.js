// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { DATA_CLI, deployApp, deploymentKey, ensureAppName, ensureFabricApp, FABRIC_CONFIG, fabricConfigFile, findDeployment, nodeVersionOk, PREBUILT_MARKER, PREBUILT_STATIC, profileName, RAYFIN_CLI, yamlValue } from '../src/steps/app.js';
import { CONNECTION_SECRET_NAME, connectionName, ensureModelConnection, ensureSemanticModel, refreshModel, rotateModelSecret } from '../src/steps/model.js';
import { blockedSettings } from '../src/steps/plan.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

/** @param {any} item */
const modelBim = (item) => JSON.parse(Buffer.from(item.content.parts.find((/** @type {any} */ p) => p.path === 'model.bim').payload, 'base64').toString('utf8'));

/** @param {{ answers?: any[], yes?: boolean, config?: any }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const powerBi = fakePowerBi();
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  const config = o.config ?? emptyConfig();
  config.semanticModel.enabled = true;
  config.app.displayName = 'ValueLens Data Collector';
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, graph: graph.api, powerBi: powerBi.api, config });
  return { ...made, fabric, graph, powerBi, ui };
}

test('semantic model: created from the template, left alone on re-run, updated when modules change', async () => {
  const t = setup();
  await ensureSemanticModel(t.ctx);
  const item = t.fabric.items.find((i) => i.type === 'SemanticModel');
  assert.ok(item);
  assert.equal(item.displayName, 'Analytics Hub Model');
  assert.deepEqual(item.content.parts.map((/** @type {any} */ p) => p.path), ['model.bim', 'definition.pbism']);
  const bim = modelBim(item);
  assert.ok(bim.model.expressions.find((/** @type {any} */ e) => e.name === 'Fabric SQL Endpoint').expression.startsWith('"abc.datawarehouse.fabric.microsoft.com"'));
  assert.equal(t.config.semanticModel.id, item.id);
  assert.equal(t.config.semanticModel.bound, false);
  assert.equal(t.config.semanticModel.server, 'abc.datawarehouse.fabric.microsoft.com');

  t.config.semanticModel.bound = true;
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createSemanticModel Analytics Hub Model']);
  assert.equal(t.config.semanticModel.bound, true);

  t.config.modules.agent365 = !t.config.modules.agent365;
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateSemanticModel Analytics Hub Model']);
  assert.equal(t.config.semanticModel.bound, false, 'an update needs the connection bound again');

  await ensureSemanticModel(t.ctx, { force: true });
  assert.equal(t.fabric.calls.length, 3);
});

test('semantic model: waits for the SQL endpoint; a same-name model that is not ours is left alone', async () => {
  const t = setup();
  t.fabric.sqlStates.push({ provisioningStatus: 'InProgress' }, { connectionString: null });
  const existing = t.fabric.add('SemanticModel', 'Analytics Hub Model', 'theirs');
  await ensureSemanticModel(t.ctx);
  assert.equal(t.sleeps.length, 2);
  assert.deepEqual(t.ui.asked, [], 'never asks to replace it');
  assert.notEqual(t.config.semanticModel.id, existing.id);
  assert.equal(t.config.semanticModel.name, 'Analytics Hub Model 2');
  assert.deepEqual(t.fabric.calls, ['createSemanticModel Analytics Hub Model 2']);
  assert.equal(existing.content, 'theirs');
  assert.match(t.ui.text(), /"Analytics Hub Model" is already in the workspace/);

  const failed = setup();
  failed.fabric.sqlStates.push({ provisioningStatus: 'Failed' });
  await assert.rejects(ensureSemanticModel(failed.ctx), /failed to provision/);
});

test('semantic model: a deleted model is deployed again', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'gone', bound: true, signature: 'x' });
  await ensureSemanticModel(t.ctx);
  assert.notEqual(t.config.semanticModel.id, 'gone');
  assert.deepEqual(t.fabric.calls, ['createSemanticModel Analytics Hub Model']);
  assert.match(t.ui.text(), /was deleted/);
});

/** @param {ReturnType<typeof setup>} t */
async function withModel(t) {
  await ensureSemanticModel(t.ctx);
  t.fabric.calls.length = 0;
}

test('connection: the app gets Viewer and its own secret; the model is bound to the connection', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = t.config.semanticModel;
  const name = connectionName('ws-1');
  assert.deepEqual(t.fabric.calls, ['addRoleAssignment sp-1 Viewer', `createConnection ${name}`, `bindConnection Analytics Hub Model ${sm.connectionId} abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
  assert.deepEqual(t.graph.calls, [`addPassword ${CONNECTION_SECRET_NAME}`]);
  const body = /** @type {any} */ (t.fabric.connections[0].body);
  assert.equal(body.connectivityType, 'ShareableCloud');
  assert.deepEqual(body.connectionDetails.parameters.map((/** @type {any} */ p) => p.value), ['abc.datawarehouse.fabric.microsoft.com', 'ValueLens']);
  assert.deepEqual(body.credentialDetails.credentials, { credentialType: 'ServicePrincipal', tenantId: 'tenant-1', servicePrincipalClientId: 'app-1', servicePrincipalSecret: 'secret-1' });
  assert.equal(sm.bound, true);
  assert.equal(sm.secretKeyId, 'key-1');
  assert.equal(sm.connectionName, name);

  t.fabric.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'nothing to do on a re-run');
  assert.equal(t.graph.passwords.length, 1);
});

test('connection: retried while a new secret takes effect; a failure takes the secret off the app', async () => {
  const t = setup();
  await withModel(t);
  t.fabric.failures.createConnection = [httpError(400, 'Credentials are invalid'), httpError(401, 'Login failed')];
  await ensureModelConnection(t.ctx);
  assert.equal(t.fabric.calls.filter((c) => c.startsWith('createConnection')).length, 3);
  assert.deepEqual(t.sleeps, [30_000, 30_000]);
  assert.equal(t.config.semanticModel.bound, true);

  const bad = setup();
  await withModel(bad);
  bad.fabric.failures.createConnection = [httpError(409, 'Duplicate')];
  await assert.rejects(ensureModelConnection(bad.ctx), /couldn't set up the model's connection: Duplicate/);
  assert.deepEqual(bad.graph.passwords, []);
  assert.equal(bad.config.semanticModel.connectionId, undefined);
});

test('connection: one with the same name is reused with a new secret; without rights to add one, the user pastes it', async () => {
  const t = setup({ answers: ['pasted-secret'] });
  await withModel(t);
  t.fabric.connections.push({ id: 'conn-old', displayName: connectionName('ws-1') });
  t.fabric.roles.push({ principal: { id: 'sp-1' } });
  t.graph.failures.addPassword = [httpError(403, 'Forbidden')];
  await ensureModelConnection(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(0, 1), ['updateConnection conn-old']);
  assert.equal(/** @type {any} */ (t.fabric.connections[0].body).credentialDetails.credentials.servicePrincipalSecret, 'pasted-secret');
  assert.equal(t.config.semanticModel.connectionId, 'conn-old');
  assert.equal(t.config.semanticModel.secretKeyId, undefined);
  assert.match(t.ui.asked.join('\n'), /client secret/);
});

test('connection: when binding fails the user can retry, say they did it, or skip', async () => {
  const skip = setup({ answers: ['retry', 'skip'] });
  await withModel(skip);
  skip.fabric.failures.bindConnection = [httpError(400, 'No match'), httpError(400, 'No match')];
  await ensureModelConnection(skip.ctx);
  assert.equal(skip.config.semanticModel.bound, false);
  assert.match(skip.ui.text(), /Gateway and cloud connections/);

  const done = setup({ answers: ['done'] });
  await withModel(done);
  done.fabric.failures.bindConnection = [httpError(400, 'No match')];
  await ensureModelConnection(done.ctx);
  assert.equal(done.config.semanticModel.bound, true);

  const unattended = setup({ yes: true });
  await withModel(unattended);
  unattended.fabric.failures.bindConnection = [httpError(400, 'No match')];
  await ensureModelConnection(unattended.ctx);
  assert.equal(unattended.config.semanticModel.bound, false);
});

test('refresh: polls until it ends and reports a failure with its messages', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  t.powerBi.states.push({ status: 'Unknown', extendedStatus: 'InProgress' }, { status: 'Completed', extendedStatus: 'Completed' });
  const ok = await refreshModel(t.ctx);
  assert.deepEqual(ok, { ok: true, status: 'Completed' });
  assert.deepEqual(t.powerBi.calls, ['refresh model-1 full', 'getRefresh request-1', 'getRefresh request-1']);
  assert.deepEqual(t.sleeps, [20_000]);

  t.powerBi.states.push({ status: 'Failed', messages: [{ message: 'Login failed for user' }] });
  const bad = await refreshModel(t.ctx);
  assert.deepEqual(bad, { ok: false, status: 'Failed' });
  assert.match(t.ui.text(), /Login failed for user/);

  const quick = await refreshModel(t.ctx, { wait: false });
  assert.equal(quick.ok, true);
});

test('refresh: one already running is followed; an unconnected model is not refreshed', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  t.powerBi.failures.refresh = [httpError(409, 'Another refresh is in progress')];
  t.powerBi.history.push({ requestId: 'running-1', status: 'Unknown' });
  await refreshModel(t.ctx);
  assert.deepEqual(t.powerBi.calls, ['refresh model-1 full', 'getRefresh running-1']);

  t.config.semanticModel.bound = false;
  assert.deepEqual(await refreshModel(t.ctx), { ok: false });
  assert.match(t.ui.text(), /isn't connected to the Lakehouse/);
});

test('rotate: the connection gets a new secret and the old one leaves the app', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  await rotateModelSecret(t.ctx);
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), ['key-2']);
  assert.equal(/** @type {any} */ (t.fabric.connections[0].body).credentialDetails.credentials.servicePrincipalSecret, 'secret-2');
  assert.equal(t.config.semanticModel.secretKeyId, 'key-2');
  assert.equal(t.config.semanticModel.secretExpires?.slice(0, 10), '2027-06-01');
});

test('tenant settings: only a setting that is off and not delegated is flagged; app settings only with the app', () => {
  const settings = {
    ServicePrincipalAccessPermissionAPIs: { enabled: false },
    DatasetExecuteQueries: { enabled: false },
    AppBackendTenant: { enabled: false, delegateToCapacity: true },
  };
  assert.deepEqual(blockedSettings(settings, { app: false }).map((s) => s.name), ['ServicePrincipalAccessPermissionAPIs']);
  assert.deepEqual(blockedSettings(settings, { app: true }).map((s) => s.name), ['ServicePrincipalAccessPermissionAPIs', 'DatasetExecuteQueries']);
  assert.deepEqual(blockedSettings(undefined, { app: true }), []);
});

test('app helpers: Node version, YAML values, deployment lookup', () => {
  assert.equal(nodeVersionOk('22.13.0'), true);
  assert.equal(nodeVersionOk('22.12.9'), false);
  assert.equal(nodeVersionOk('24.0.0'), true);
  assert.equal(nodeVersionOk('20.19.0'), false);
  assert.equal(yamlValue('id: valuelens\nname: "Analytics Hub"\n', 'name'), 'Analytics Hub');
  assert.equal(yamlValue('activeProfile: msit\r\n', 'activeProfile'), 'msit');
  assert.equal(yamlValue(null, 'x'), undefined);
  const d = { active: 'a', deployments: { a: { fabricWorkspaceId: 'WS-OTHER' }, b: { fabricWorkspaceId: 'ws-1', fabricItemId: 'i' } } };
  assert.deepEqual(findDeployment(d, 'WS-1'), { key: 'b', fabricWorkspaceId: 'ws-1', fabricItemId: 'i' });
  assert.equal(findDeployment(d, 'nope'), undefined);
  assert.equal(profileName('9778B2D8-f798'), 'valuelens-9778b2d8');
});

/**
 * A copy of the app folder's shape, with a runner that acts like the data CLI and rayfin.
 * @param {{ tools?: boolean, upFails?: boolean }} [o]
 */
function appSetup(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vl-app-'));
  mkdirSync(join(dir, 'rayfin'), { recursive: true });
  writeFileSync(join(dir, 'rayfin', 'rayfin.yml'), 'id: valuelens\nname: Analytics Hub\n');
  writeFileSync(join(dir, 'fabric.yaml'), 'activeProfile: msit\nprofiles: {}\n');
  const deploymentsFile = join(dir, 'rayfin', '.deployments.json');
  writeFileSync(deploymentsFile, JSON.stringify({ active: 'team', deployments: { team: { fabricWorkspaceId: 'ws-team', fabricItemId: 'team-app' } } }));
  writeFileSync(join(dir, 'rayfin', '.env'), 'TEAM=1\n');
  const tools = () => {
    for (const f of [RAYFIN_CLI, DATA_CLI]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), '');
    }
  };
  if (o.tools !== false) tools();

  const t = setup({ answers: [] });
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  t.config.fabricApp.enabled = true;
  /** @type {string[]} */
  const runs = [];
  /** @type {import('../src/steps/app.js').Runner} */
  const runner = async (command, args) => {
    const line = [command === process.execPath ? 'node' : command, ...args.map((a) => a.replace(dir, '<app>'))].join(' ');
    runs.push(line);
    if (command.startsWith('npm ci')) tools();
    if (args[1] === 'use') writeFileSync(join(dir, 'fabric.yaml'), `activeProfile: ${args[2]}\nprofiles: {}\n`);
    if (args[1] === 'up') {
      writeFileSync(join(dir, 'rayfin', '.env'), 'CUSTOMER=1\n');
      if (o.upFails) return { code: 1, output: '' };
      const now = existsSync(deploymentsFile) ? JSON.parse(readFileSync(deploymentsFile, 'utf8')) : { deployments: {} };
      // Like rayfin: deploy to the item recorded for the workspace, or make one named like the project.
      const recorded = findDeployment(now, 'ws-1');
      const id = recorded?.fabricItemId ?? t.fabric.add('AppBackend', 'valuelens', null).id;
      const key = recorded?.key ?? 'valuelens-ws';
      now.deployments[key] = { ...now.deployments[key], fabricWorkspaceId: 'ws-1', fabricItemId: id, fabricDeepLink: `https://app.fabric.microsoft.com/groups/ws-1/appbackends/${id}`, deployedAt: '2026-06-01T12:00:00Z' };
      now.active = key;
      writeFileSync(deploymentsFile, JSON.stringify(now));
    }
    return { code: 0, output: '' };
  };
  t.ctx.runner = runner;
  t.ctx.sources = { ...realSources(), appDir: dir };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { ...t, dir, runs, deploymentsFile, cleanup };
}

test('app: deployed to the customer workspace under the app name, and a developer checkout put back as it was', async () => {
  const t = appSetup();
  try {
    await deployApp(t.ctx);
    const data = `node ${join('<app>', DATA_CLI)}`;
    assert.deepEqual(t.runs, [
      `${data} add semanticModel vl --workspace ws-1 --item model-1 --profile valuelens-ws-1`,
      `${data} use valuelens-ws-1 -o src/fabric.generated.ts`,
      `node ${join('<app>', RAYFIN_CLI)} up --tenant tenant-1 --workspace-id ws-1 --yes`,
      `${data} use msit -o src/fabric.generated.ts`,
    ]);
    const fa = t.config.fabricApp;
    assert.equal(fa.name, 'Analytics Hub');
    assert.match(String(fa.url), /appbackends\//);
    assert.equal(fa.profile, 'valuelens-ws-1');
    assert.ok(t.fabric.calls.includes('createItem AppBackend Analytics Hub'));
    assert.ok(!t.fabric.calls.some((c) => c.startsWith('renameItem')));
    assert.deepEqual(t.fabric.items.filter((i) => i.type === 'AppBackend').map((i) => i.id), [fa.itemId]);
    assert.equal(JSON.parse(readFileSync(t.deploymentsFile, 'utf8')).active, 'team');
    assert.equal(readFileSync(join(t.dir, 'rayfin', '.env'), 'utf8'), 'TEAM=1\n');
    assert.equal(yamlValue(readFileSync(join(t.dir, 'fabric.yaml'), 'utf8'), 'activeProfile'), 'msit');
  } finally {
    t.cleanup();
  }
});

test('app: a failed deploy still restores the checkout; missing tools are installed first', async () => {
  const t = appSetup({ tools: false, upFails: true });
  try {
    await assert.rejects(deployApp(t.ctx), /rayfin up" failed/);
    assert.ok(t.runs[0].startsWith('npm ci'));
    assert.ok(existsSync(join(t.dir, RAYFIN_CLI)));
    assert.equal(readFileSync(join(t.dir, 'rayfin', '.env'), 'utf8'), 'TEAM=1\n');
    assert.equal(yamlValue(readFileSync(join(t.dir, 'fabric.yaml'), 'utf8'), 'activeProfile'), 'msit');
    assert.equal(t.config.fabricApp.itemId, undefined);
  } finally {
    t.cleanup();
  }
});

test('app: an app already deployed is left alone unless asked; a deleted one is deployed again', async () => {
  const t = appSetup();
  try {
    const item = t.fabric.add('AppBackend', 'Analytics Hub', null);
    t.config.fabricApp.itemId = item.id;
    await ensureFabricApp(t.ctx);
    assert.deepEqual(t.runs, []);
    assert.ok(!t.fabric.calls.some((c) => c.startsWith('renameItem')));
    assert.match(t.ui.text(), /App Analytics Hub is in place/);

    t.fabric.items.splice(t.fabric.items.indexOf(item), 1);
    await ensureFabricApp(t.ctx);
    assert.equal(t.runs.length, 4);
    assert.notEqual(t.config.fabricApp.itemId, item.id);
  } finally {
    t.cleanup();
  }
});

test('app: an app in the workspace that is not from this install is never taken over', async () => {
  const t = appSetup();
  try {
    const theirs = t.fabric.add('AppBackend', 'valuelens', null);
    t.config.fabric.workspaceName = 'Team_A  Workspace!';
    const runner = /** @type {import('../src/steps/app.js').Runner} */ (t.ctx.runner);
    /** @type {any} */
    let seen;
    t.ctx.runner = async (command, args, opts) => {
      if (args[1] !== 'up') return runner(command, args, opts);
      seen = JSON.parse(readFileSync(t.deploymentsFile, 'utf8'));
      // Rayfin deploys to the item recorded for the workspace.
      const record = findDeployment(seen, 'ws-1');
      seen.deployments[record.key] = { ...record, fabricDeepLink: `https://app.fabric.microsoft.com/groups/ws-1/appbackends/${record.fabricItemId}` };
      delete seen.deployments[record.key].key;
      writeFileSync(t.deploymentsFile, JSON.stringify(seen));
      return { code: 0, output: '' };
    };
    await deployApp(t.ctx);
    assert.ok(t.fabric.calls.includes('createItem AppBackend Analytics Hub'));
    assert.ok(!t.fabric.calls.some((c) => c.startsWith('renameItem')), 'their app keeps its name');
    const ours = t.fabric.items.find((i) => i.type === 'AppBackend' && i.displayName === 'Analytics Hub');
    assert.equal(seen.active, 'team-a-workspace');
    assert.equal(seen.deployments['team-a-workspace'].fabricItemId, ours?.id);
    assert.equal(seen.deployments['team-a-workspace'].fabricTenantId, 'tenant-1');
    assert.equal(seen.deployments.team.fabricItemId, 'team-app', 'other deployments are kept');
    assert.equal(t.config.fabricApp.itemId, ours?.id);
    assert.equal(t.config.fabricApp.name, 'Analytics Hub');
    assert.notEqual(t.config.fabricApp.itemId, theirs.id);
    assert.match(t.ui.text(), /"valuelens" is already in the workspace and isn't from this install/);

    t.fabric.add('AppBackend', 'Analytics Hub', null);
    t.fabric.calls.length = 0;
    t.config.fabricApp.itemId = undefined;
    writeFileSync(t.deploymentsFile, JSON.stringify({ deployments: {} }));
    await deployApp(t.ctx);
    assert.ok(t.fabric.calls.includes('createItem AppBackend Analytics Hub 2'));
    assert.equal(t.config.fabricApp.name, 'Analytics Hub 2');
  } finally {
    t.cleanup();
  }
});

test('app: findDeployment prefers the active deployment for the workspace', () => {
  const reg = { active: 'b', deployments: { a: { fabricWorkspaceId: 'WS-1', fabricItemId: 'x' }, b: { fabricWorkspaceId: 'ws-1', fabricItemId: 'y' } } };
  assert.equal(findDeployment(reg, 'ws-1')?.fabricItemId, 'y');
  assert.equal(findDeployment({ ...reg, active: 'c' }, 'ws-1')?.fabricItemId, 'x');
  assert.equal(findDeployment(reg, 'ws-2'), undefined);
  assert.equal(deploymentKey("Keith's  Team_Space (Prod)"), 'keiths-team-space-prod');
});

test('app: one still called AI in One 2.0 takes the new name without a rebuild; a name the customer chose stays', async () => {
  const t = appSetup();
  try {
    const item = t.fabric.add('AppBackend', 'AI in One 2.0', null);
    Object.assign(t.config.fabricApp, { itemId: item.id, name: 'AI in One 2.0' });
    await ensureFabricApp(t.ctx);
    assert.deepEqual(t.runs, []);
    assert.ok(t.fabric.calls.includes('renameItem AI in One 2.0 -> Analytics Hub'));
    assert.equal(t.config.fabricApp.name, 'Analytics Hub');
    assert.match(t.ui.text(), /Renamed the app "AI in One 2\.0" to "Analytics Hub"/);

    item.displayName = 'Contoso Copilot Insights';
    t.fabric.calls.length = 0;
    await ensureFabricApp(t.ctx);
    assert.ok(!t.fabric.calls.some((c) => c.startsWith('renameItem')));
    assert.match(t.ui.text(), /App Contoso Copilot Insights is in place/);

    item.displayName = 'AI in One 2.0';
    await ensureAppName(t.ctx);
    assert.ok(t.fabric.calls.includes('renameItem AI in One 2.0 -> Analytics Hub'), 'an update that skips the rebuild still renames');
    assert.deepEqual(t.runs, []);
  } finally {
    t.cleanup();
  }
});

test('app: the credit consumption pages get the cc alias, and a deployed app is rebuilt to add them', async () => {
  const t = appSetup();
  try {
    const item = t.fabric.add('AppBackend', 'Analytics Hub', null);
    Object.assign(t.config.fabricApp, { itemId: item.id, models: ['vl'] });
    t.config.modules.consumption = true;
    Object.assign(t.config.consumption.model, { id: 'cc-1', bound: true });
    await ensureFabricApp(t.ctx);
    const data = `node ${join('<app>', DATA_CLI)}`;
    assert.deepEqual(t.runs.slice(0, 2), [
      `${data} add semanticModel vl --workspace ws-1 --item model-1 --profile valuelens-ws-1`,
      `${data} add semanticModel cc --workspace ws-1 --item cc-1 --profile valuelens-ws-1`,
    ]);
    assert.match(t.ui.asked.join('\n'), /needs rebuilding to add the credit consumption pages/);
    assert.deepEqual(t.config.fabricApp.models, ['vl', 'cc']);

    t.runs.length = 0;
    await ensureFabricApp(t.ctx);
    assert.deepEqual(t.runs, [], 'same models: left alone by default');

    t.config.modules.consumption = false;
    await deployApp(t.ctx);
    assert.equal(t.runs[1], `${data} remove cc --profile valuelens-ws-1`);
    assert.deepEqual(t.config.fabricApp.models, ['vl']);
  } finally {
    t.cleanup();
  }
});

test('app: needs the model and the app source', async () => {
  const t = appSetup();
  try {
    t.config.semanticModel.id = undefined;
    await assert.rejects(deployApp(t.ctx), /needs the semantic model/);
    t.ctx.sources = { ...t.ctx.sources, appDir: undefined };
    await assert.rejects(deployApp(t.ctx), /no "1\. Fabric\/Fabric App" folder/);
  } finally {
    t.cleanup();
  }
});

/**
 * The installer download's prebuilt app: no source, no fabric.yaml, and none of Rayfin's state
 * from earlier runs, since each installer version unpacks a fresh copy.
 * @param {{ upFails?: boolean }} [o]
 */
function prebuiltSetup(o = {}) {
  const t = appSetup(o);
  rmSync(join(t.dir, 'fabric.yaml'));
  rmSync(t.deploymentsFile);
  rmSync(join(t.dir, 'rayfin', '.env'));
  rmSync(join(t.dir, DATA_CLI));
  writeFileSync(join(t.dir, PREBUILT_MARKER), '{}');
  mkdirSync(join(t.dir, PREBUILT_STATIC));
  const fresh = () => {
    for (const f of [t.deploymentsFile, join(t.dir, 'rayfin', '.env'), join(t.dir, PREBUILT_STATIC, FABRIC_CONFIG)]) rmSync(f, { force: true });
  };
  return { ...t, fresh };
}

test('app: the prebuilt app is deployed as it is, with its models in fabric.config.json', async () => {
  const t = prebuiltSetup();
  try {
    t.config.modules.consumption = true;
    Object.assign(t.config.consumption.model, { id: 'cc-1', bound: true });
    await deployApp(t.ctx);
    assert.deepEqual(t.runs, [`node ${join('<app>', RAYFIN_CLI)} up --tenant tenant-1 --workspace-id ws-1 --yes`]);
    assert.deepEqual(JSON.parse(readFileSync(join(t.dir, PREBUILT_STATIC, FABRIC_CONFIG), 'utf8')), {
      semanticModels: {
        vl: { workspaceId: 'ws-1', itemId: 'model-1' },
        cc: { workspaceId: 'ws-1', itemId: 'cc-1' },
      },
      modules: {
        m365Activity: true,
        agent365: false,
        productFeedback: false,
        consumption: true,
        agentEvaluator: false,
      },
    });
    const fa = t.config.fabricApp;
    assert.equal(fa.name, 'Analytics Hub');
    assert.equal(fa.profile, undefined);
    assert.deepEqual(fa.models, ['vl', 'cc']);
    assert.equal(findDeployment(fa.rayfin?.deployments, 'ws-1')?.fabricItemId, fa.itemId);
    assert.equal(fa.rayfin?.env, 'CUSTOMER=1\n');
  } finally {
    t.cleanup();
  }
});

test('app: a newer installer updates the app the last one deployed rather than adding another', async () => {
  const t = prebuiltSetup();
  try {
    await deployApp(t.ctx);
    const first = t.config.fabricApp.itemId;
    t.fresh();

    /** @type {any} */
    let seen;
    const runner = /** @type {import('../src/steps/app.js').Runner} */ (t.ctx.runner);
    t.ctx.runner = async (command, args, opts) => {
      if (args[1] === 'up') seen = { deployments: readFileSync(t.deploymentsFile, 'utf8'), env: readFileSync(join(t.dir, 'rayfin', '.env'), 'utf8') };
      return runner(command, args, opts);
    };
    await deployApp(t.ctx);
    assert.equal(findDeployment(JSON.parse(seen.deployments), 'ws-1')?.fabricItemId, first, 'rayfin sees the item it deployed before');
    assert.equal(seen.env, 'CUSTOMER=1\n');
  } finally {
    t.cleanup();
  }
});

test('app: a first deploy that fails part way keeps the app item it made, so the next run reuses it', async () => {
  const o = { upFails: true };
  const t = prebuiltSetup(o);
  try {
    await assert.rejects(deployApp(t.ctx), /rayfin up" failed/);
    const made = t.fabric.items.filter((i) => i.type === 'AppBackend');
    assert.deepEqual(made.map((i) => i.displayName), ['Analytics Hub']);
    assert.equal(findDeployment(t.config.fabricApp.rayfin?.deployments, 'ws-1')?.fabricItemId, made[0].id);

    o.upFails = false;
    t.fresh();
    t.fabric.calls.length = 0;
    await deployApp(t.ctx);
    assert.ok(!t.fabric.calls.some((c) => c.startsWith('createItem')), 'no second app');
    assert.equal(t.config.fabricApp.itemId, made[0].id);
    assert.equal(t.fabric.items.filter((i) => i.type === 'AppBackend').length, 1);
  } finally {
    t.cleanup();
  }
});

test('app: a prebuilt deploy that fails keeps what Rayfin recorded, and needs its deploy tools', async () => {
  const t = prebuiltSetup({ upFails: true });
  try {
    const half = t.fabric.add('AppBackend', 'valuelens', null);
    t.config.fabricApp.rayfin = { deployments: { active: 'x', deployments: { x: { fabricWorkspaceId: 'ws-1', fabricItemId: half.id } } } };
    await assert.rejects(deployApp(t.ctx), /rayfin up" failed/);
    assert.equal(t.config.fabricApp.rayfin?.deployments.deployments.x.fabricItemId, half.id);
    assert.ok(!t.fabric.calls.some((c) => c.startsWith('createItem')), 'the half-made app is ours, so it is reused');
    assert.equal(t.config.fabricApp.rayfin?.env, 'CUSTOMER=1\n');
    assert.equal(t.config.fabricApp.itemId, undefined);

    rmSync(join(t.dir, RAYFIN_CLI));
    await assert.rejects(deployApp(t.ctx), /missing its deploy tools/);
    assert.ok(!t.runs.some((r) => r.startsWith('npm')), 'never builds the prebuilt app');
  } finally {
    t.cleanup();
  }
});

test('app: a prebuilt app is offered a redeploy, not a rebuild, when its pages change', async () => {
  const t = prebuiltSetup();
  try {
    const item = t.fabric.add('AppBackend', 'Analytics Hub', null);
    Object.assign(t.config.fabricApp, { itemId: item.id, models: ['vl'] });
    t.config.modules.consumption = true;
    Object.assign(t.config.consumption.model, { id: 'cc-1', bound: true });
    await ensureFabricApp(t.ctx);
    const asked = t.ui.asked.join('\n');
    assert.match(asked, /needs redeploying to add the credit consumption pages\. Deploy it again\?/);
    assert.doesNotMatch(asked, /Build and deploy/);
    assert.ok(!t.runs.some((r) => r.startsWith('npm')), 'never builds the prebuilt app');
  } finally {
    t.cleanup();
  }
});

test('app: fabricConfigFile lists only the models the app is built with', () => {
  const t = setup({ answers: [] });
  Object.assign(t.config.semanticModel, { id: 'm' });
  Object.assign(t.config.agentEvaluator.model, { id: 'ae-1' });
  assert.deepEqual(fabricConfigFile(t.config, 'ws', ['vl', 'ae']), {
    semanticModels: { vl: { workspaceId: 'ws', itemId: 'm' }, ae: { workspaceId: 'ws', itemId: 'ae-1' } },
    modules: {
      m365Activity: true,
      agent365: false,
      productFeedback: false,
      consumption: false,
      agentEvaluator: false,
    },
  });
});

test('app: fabricConfigFile omits module choices from older records that do not have them', () => {
  const t = setup({ answers: [] });
  Object.assign(t.config.semanticModel, { id: 'm' });
  const config = /** @type {any} */ ({ ...t.config });
  delete config.modules;
  assert.deepEqual(fabricConfigFile(config, 'ws', ['vl']), {
    semanticModels: { vl: { workspaceId: 'ws', itemId: 'm' } },
  });
});
