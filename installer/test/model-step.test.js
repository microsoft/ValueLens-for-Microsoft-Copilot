// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { DATA_CLI, deployApp, deploymentKey, ensureAppName, ensureFabricApp, FABRIC_CONFIG, fabricConfigFile, findDeployment, installerVersion, laterVersion, nodeVersionOk, PREBUILT_MARKER, PREBUILT_STATIC, profileName, RAYFIN_CLI, rayfinEnv, rayfinSignedInAsOther, rayfinSignIn, yamlValue } from '../src/steps/app.js';
import { CONNECTION_SECRET_NAME, connectionName, definitionHash, ensureModelConnection, ensureSemanticModel, MODEL_PROBE, refreshModel, rotateModelSecret, verifyModel } from '../src/steps/model.js';
import { blockedSettings } from '../src/steps/plan.js';
import { buildModel, loadTemplateModel } from '../src/transform/model.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, httpError, realSources, throttledThenTaken } from './fakes.js';

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

test('semantic model: a re-run redeploys a model whose definition changed, such as one from an older installer', async () => {
  const t = setup();
  await ensureSemanticModel(t.ctx);
  const sm = t.config.semanticModel;
  assert.match(String(sm.signature), /;[0-9a-f]{16}$/, 'the signature carries the definition hash');
  sm.bound = true;

  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createSemanticModel Analytics Hub Model'], 'the same definition is left in place');

  sm.signature = String(sm.signature).replace(/;[0-9a-f]{16}$/, '');
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateSemanticModel Analytics Hub Model'], 'a record without the hash (0.3.3) is updated');
  assert.equal(sm.bound, false, 'so the connection is bound again and the repair refreshes it');

  sm.signature = `${String(sm.signature).slice(0, -16)}0000000000000000`;
  await ensureSemanticModel(t.ctx);
  assert.equal(t.fabric.calls.length, 3, 'a different template is updated');
  assert.equal(definitionHash({ a: 1 }), definitionHash({ a: 1 }));
  assert.notEqual(definitionHash({ a: 1 }), definitionHash({ a: 2 }));
});

test('the built model has no DAX variable named after a reserved word, which would leave its tables uncalculated', () => {
  const reserved = new Set(
    readFileSync(new URL('../../tests/fixtures/dax_reserved_names.txt', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l && !l.startsWith('#')),
  );
  assert.ok(reserved.has('LASTDATE'));
  const sources = realSources();
  const models = [buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { server: 's', database: 'd', modules: emptyConfig().modules })];
  /** @type {string[]} */
  const bad = [];
  for (const model of models) {
    for (const table of model.model.tables) {
      const texts = [
        ...(table.measures ?? []).map((/** @type {any} */ m) => m.expression),
        ...(table.columns ?? []).map((/** @type {any} */ c) => c.expression),
        ...(table.partitions ?? []).filter((/** @type {any} */ p) => p.source?.type === 'calculated').map((/** @type {any} */ p) => p.source.expression),
      ];
      for (const text of texts) {
        const dax = Array.isArray(text) ? text.join('\n') : String(text ?? '');
        for (const [, name] of dax.matchAll(/\bVAR\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) if (reserved.has(name.toUpperCase())) bad.push(`${table.name}: VAR ${name}`);
      }
    }
  }
  assert.deepEqual(bad, []);
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
  assert.deepEqual(unref(t.graph.calls), [`addPassword ${CONNECTION_SECRET_NAME}`]);
  assert.match(t.graph.passwords[0].displayName, new RegExp(`^${CONNECTION_SECRET_NAME} \\(ref [0-9a-f]{12}\\)$`), 'named with the ref saved before Entra was asked');
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

test('connection: one a throttled create made anyway is reused when the retry finds the name taken', async () => {
  const t = setup();
  await withModel(t);
  const name = connectionName('ws-1');
  const throttled = throttledThenTaken(t.fabric);
  t.fabric.api.createConnection = throttled.createConnection;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(throttled.sent, [`POST ${name}`, `POST ${name}`], 'the client sends it again after the 429, and Fabric answers 409');
  assert.deepEqual(t.fabric.calls, ['addRoleAssignment sp-1 Viewer', 'updateConnection conn-throttled', `bindConnection Analytics Hub Model conn-throttled abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
  assert.equal(t.fabric.connections.length, 1);
  assert.equal(/** @type {any} */ (t.fabric.connections[0].body).credentialDetails.credentials.servicePrincipalSecret, 'secret-1', 'given the secret again');
  const sm = t.config.semanticModel;
  assert.equal(sm.connectionId, 'conn-throttled');
  assert.equal(sm.secretKeyId, 'key-1');
  assert.equal(sm.bound, true);
  assert.match(t.ui.text(), new RegExp(`Fabric already has a connection named "${name}", probably from an earlier request that it throttled or that timed out\\. Using that one\\.`));
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

test('refresh: Completed with a warning or error message is a failure, since parts of the model were not calculated', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  const warning = "Failed to save modifications to the server. Error returned: 'The syntax for 'LastDate' is incorrect.'";
  t.powerBi.states.push({ status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Warning', message: warning }] });
  assert.deepEqual(await refreshModel(t.ctx), { ok: false, status: 'Completed' });
  const text = t.ui.text();
  assert.match(text, /Power BI reported problems/);
  assert.match(text, /The syntax for 'LastDate' is incorrect/);
  assert.match(text, /Run the installer again/);

  t.powerBi.states.push({ status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Error', message: 'x' }] });
  assert.equal((await refreshModel(t.ctx)).ok, false);
  t.powerBi.states.push({ status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Information', message: 'fine' }] });
  assert.deepEqual(await refreshModel(t.ctx), { ok: true, status: 'Completed' });
});

test('probe: a model whose Calendar has days passes; an empty or broken one fails; a blocked API is skipped', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, calendarDays: 90 });
  assert.deepEqual(t.powerBi.calls, ['executeQueries model-1']);
  assert.match(MODEL_PROBE, /COUNTROWS\('Calendar'\)/);
  assert.match(t.ui.text(), /answers queries \(its Calendar has 90 days\)/);

  t.powerBi.answers.push({ results: [{ tables: [{ rows: [{ '[CalendarDays]': 0 }] }] }] });
  assert.equal((await verifyModel(t.ctx)).ok, false);
  assert.match(t.ui.text(), /its Calendar table is empty/);

  const detail = "Query (1, 26) The expression referenced column 'Calendar'[Date] which does not hold any data because it needs to be recalculated.";
  t.powerBi.failures.executeQueries = [new HttpError('Bad request', { status: 400, method: 'POST', url: 'https://x', body: { error: { code: 'DatasetExecuteQueriesError', 'pbi.error': { details: [{ code: 'DetailsMessage', detail: { value: detail } }] } } } })];
  const broken = await verifyModel(t.ctx);
  assert.equal(broken.ok, false);
  assert.match(String(broken.error), /needs to be recalculated/);
  assert.match(t.ui.text(), /a test query failed, so report pages will fail/);

  t.powerBi.failures.executeQueries = [httpError(401, 'Unauthorized')];
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, skipped: true });
  assert.match(t.ui.text(), /Execute Queries REST API/);

  t.powerBi.failures.executeQueries = [httpError(500, 'Boom')];
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, skipped: true }, 'a service hiccup does not fail a finished install');
  assert.match(t.ui.text(), /Couldn't query Analytics Hub Model to check it \(Boom\)/);

  t.config.semanticModel.bound = false;
  const before = t.powerBi.calls.length;
  assert.deepEqual(await verifyModel(t.ctx), { ok: true, skipped: true });
  assert.equal(t.powerBi.calls.length, before, 'an unconnected model is not queried');
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

/** Graph calls without the per-run ref in a new secret's name. @param {string[]} calls */
const unref = (calls) => calls.map((c) => c.replace(/ \(ref [0-9a-f]{12}\)$/, ''));

test('connection secret: one Entra made before a stopped run saved its key is found by its ref, replaced, then removed', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = t.config.semanticModel;
  // The stopped run had saved its ref and Entra had made the secret; then it stopped.
  t.graph.passwords.push({ keyId: 'key-lost', displayName: `${CONNECTION_SECRET_NAME} (ref aaaaaaaaaaaa)` }, { keyId: 'key-other', displayName: CONNECTION_SECRET_NAME });
  sm.secretAttempts = [{ ref: 'aaaaaaaaaaaa', at: '2026-06-01T11:59:00Z' }];
  t.graph.calls.length = 0;
  t.fabric.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(unref(t.graph.calls), ['listPasswords', `addPassword ${CONNECTION_SECRET_NAME}`, 'removePassword key-1', 'removePassword key-lost']);
  assert.deepEqual(t.fabric.calls, [`updateConnection ${sm.connectionId}`], 'the connection gets the new one before any is removed');
  assert.equal(sm.secretKeyId, 'key-2');
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId).sort(), ['key-2', 'key-other'], "one without the ref isn't touched");
  for (const f of /** @type {const} */ (['secretAttempts', 'pendingSecretKeyIds', 'retiredSecretKeyIds'])) assert.equal(sm[f], undefined, f);
  assert.match(t.ui.text(), /without recording it/);
});

test("connection secret: a failed update keeps the new key tracked unless Fabric turned it down; the next run settles it", async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = t.config.semanticModel;

  // Fabric may have stored it before the error: kept, and the one in use stays.
  t.fabric.failures.updateConnection = [httpError(500, 'Internal')];
  await assert.rejects(rotateModelSecret(t.ctx), /Internal/);
  assert.equal(sm.secretKeyId, 'key-1');
  assert.deepEqual(sm.pendingSecretKeyIds, ['key-2']);
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), ['key-1', 'key-2']);

  // The next run gives the connection a newer one, then removes both.
  t.graph.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(unref(t.graph.calls), [`addPassword ${CONNECTION_SECRET_NAME}`, 'removePassword key-1', 'removePassword key-2']);
  assert.equal(sm.secretKeyId, 'key-3');
  assert.equal(sm.pendingSecretKeyIds, undefined);
  assert.match(t.ui.text(), /may have given it to the connection/);

  // Turned down: nothing holds it, so it's removed and the one in use stays.
  t.fabric.failures.updateConnection = [httpError(400, 'Bad request')];
  t.graph.calls.length = 0;
  await assert.rejects(rotateModelSecret(t.ctx), /Bad request/);
  assert.deepEqual(unref(t.graph.calls), [`addPassword ${CONNECTION_SECRET_NAME}`, 'removePassword key-4']);
  assert.equal(sm.secretKeyId, 'key-3');
  assert.equal(sm.pendingSecretKeyIds, undefined);
  assert.equal(sm.retiredSecretKeyIds, undefined);

  // Entra won't remove an old one: it stays listed and is tried again next run.
  t.graph.failures.removePassword = [httpError(500, 'busy')];
  await rotateModelSecret(t.ctx);
  assert.deepEqual(sm.retiredSecretKeyIds, ['key-3']);
  t.graph.calls.length = 0;
  await ensureModelConnection(t.ctx);
  assert.deepEqual(t.graph.calls, ['removePassword key-3']);
  assert.equal(sm.retiredSecretKeyIds, undefined);
});

test('connection secret: if Entra may have made the secret before an error, its ref is kept and the next run looks for it', async () => {
  const t = setup();
  await withModel(t);
  await ensureModelConnection(t.ctx);
  const sm = /** @type {any} */ (t.config.semanticModel);
  t.graph.failures.addPassword = [httpError(400, 'Bad request')];
  await assert.rejects(rotateModelSecret(t.ctx), /Bad request/);
  assert.equal(sm.secretAttempts, undefined, 'turned down: nothing was made');
  t.graph.failures.addPassword = [new Error('socket hang up')];
  await assert.rejects(rotateModelSecret(t.ctx), /socket hang up/);
  assert.equal(sm.secretAttempts?.length, 1, 'may have been made: the ref stays');
  // Entra had made it after all.
  t.graph.passwords.push({ keyId: 'key-made', displayName: `${CONNECTION_SECRET_NAME} (ref ${sm.secretAttempts?.[0].ref})` });
  await rotateModelSecret(t.ctx);
  assert.ok(!t.graph.passwords.some((p) => p.keyId === 'key-made'), 'found, then removed once the new one is in use');
  assert.equal(sm.secretAttempts, undefined);
  assert.equal(sm.pendingSecretKeyIds, undefined);
});

test('connection secret: a stopped run that made the connection but not the record: found by name, given a new secret, and the old ones removed', async () => {
  const t = setup();
  await withModel(t);
  const sm = t.config.semanticModel;
  // Stopped after Fabric created the connection with key-1 but before its ID was saved.
  t.fabric.failures.createConnection = [httpError(500, 'Internal')];
  await assert.rejects(ensureModelConnection(t.ctx), /Internal/);
  assert.deepEqual(sm.pendingSecretKeyIds, ['key-1']);
  t.fabric.connections.push({ id: 'conn-made', displayName: connectionName('ws-1') });
  await ensureModelConnection(t.ctx);
  assert.equal(sm.connectionId, 'conn-made');
  assert.equal(sm.secretKeyId, 'key-2');
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), ['key-2']);
  assert.equal(sm.pendingSecretKeyIds, undefined);
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
 * @param {{ tools?: boolean, upFails?: boolean, answers?: any[] }} [o]
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

  const t = setup({ answers: o.answers ?? [] });
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  t.config.fabricApp.enabled = true;
  /** @type {string[]} */
  const runs = [];
  /** @type {import('../src/steps/app.js').RunOptions[]} */
  const upOpts = [];
  /** @type {import('../src/steps/app.js').Runner} */
  const runner = async (command, args, opts) => {
    if (args[1] === 'up') upOpts.push(opts);
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
  return { ...t, dir, runs, upOpts, deploymentsFile, cleanup };
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
    await assert.rejects(deployApp(t.ctx), /deploy tool failed/);
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
    Object.assign(t.config.fabricApp, { itemId: item.id, installerVersion: installerVersion() });
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

test('app: a deploy that finds its app by ID drops a create a stopped run left pending', async () => {
  const t = appSetup();
  try {
    const item = t.fabric.add('AppBackend', 'Analytics Hub', null);
    t.config.fabricApp.itemId = item.id;
    t.config.fabric.pendingItems = { AppBackend: { name: 'Analytics Hub', ref: 'dd44' } };
    await deployApp(t.ctx);
    assert.equal(t.config.fabric.pendingItems, undefined);
    assert.ok(!t.fabric.calls.some((c) => c.startsWith('createItem')));
  } finally {
    t.cleanup();
  }
});

test('app: a source build carries fabric.config.json with the viewer access, then the checkout is left clean', async () => {
  const t = appSetup();
  try {
    t.config.access = { groupId: 'g-1', groupName: 'Analytics Hub Viewers', appShared: true };
    const runner = /** @type {import('../src/steps/app.js').Runner} */ (t.ctx.runner);
    /** @type {any} */
    let built;
    t.ctx.runner = async (command, args, opts) => {
      if (args[1] === 'up') built = JSON.parse(readFileSync(join(t.dir, PREBUILT_STATIC, FABRIC_CONFIG), 'utf8'));
      return runner(command, args, opts);
    };
    await deployApp(t.ctx);
    assert.deepEqual(built.access, { groupId: 'g-1', groupName: 'Analytics Hub Viewers', appShared: true }, 'the build reads who can view it');
    assert.deepEqual(built.semanticModels, { vl: { workspaceId: 'ws-1', itemId: 'model-1' } });
    assert.ok(!existsSync(join(t.dir, PREBUILT_STATIC)), 'a public folder that wasn\'t there is removed again');
    assert.deepEqual(t.config.fabricApp.access, built.access, 'what the app was told is recorded');

    mkdirSync(join(t.dir, PREBUILT_STATIC));
    writeFileSync(join(t.dir, PREBUILT_STATIC, FABRIC_CONFIG), '{"mine":true}');
    await deployApp(t.ctx);
    assert.equal(readFileSync(join(t.dir, PREBUILT_STATIC, FABRIC_CONFIG), 'utf8'), '{"mine":true}', 'a developer\'s own file is put back');
  } finally {
    t.cleanup();
  }
});

test('app: a deployed app is offered a rebuild when who can view it changed, such as the app being shared', async () => {
  const t = appSetup();
  try {
    const item = t.fabric.add('AppBackend', 'Analytics Hub', null);
    Object.assign(t.config.fabricApp, { itemId: item.id, installerVersion: installerVersion() });
    t.config.access = /** @type {import('../src/config.js').AccessConfig} */ ({ groupId: 'g-1', groupName: 'Analytics Hub Viewers' });
    await ensureFabricApp(t.ctx);
    assert.match(t.ui.asked.at(-1) ?? '', /needs rebuilding to show who can view it and how to share it/);
    assert.equal(t.runs.length, 4, 'it rebuilds by default');
    assert.deepEqual(t.config.fabricApp.access, { groupId: 'g-1', groupName: 'Analytics Hub Viewers' });

    t.runs.length = 0;
    await ensureFabricApp(t.ctx);
    assert.match(t.ui.asked.at(-1) ?? '', /is deployed\. Build and deploy it again\?/);
    assert.deepEqual(t.runs, [], 'nothing changed: left alone by default');

    t.config.access = { ...t.config.access, appShared: true };
    await ensureFabricApp(t.ctx);
    assert.match(t.ui.asked.at(-1) ?? '', /show who can view it/);
    const deployed = /** @type {Record<string, unknown> | undefined} */ (t.config.fabricApp.access);
    assert.equal(deployed?.appShared, true);
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
    Object.assign(t.config.fabricApp, { itemId: item.id, name: 'AI in One 2.0', installerVersion: installerVersion() });
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
    Object.assign(t.config.fabricApp, { itemId: item.id, models: ['vl'], installerVersion: installerVersion() });
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
    await assert.rejects(deployApp(t.ctx), /no "app" folder/);
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
        defender: false,
        resourceGraph: false,
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
    await assert.rejects(deployApp(t.ctx), /deploy tool failed/);
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
    await assert.rejects(deployApp(t.ctx), /deploy tool failed/);
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
    Object.assign(t.config.fabricApp, { itemId: item.id, models: ['vl'], installerVersion: installerVersion() });
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

test('app: a prebuilt app is offered a redeploy when the Value page currency changes, and records it', async () => {
  const t = prebuiltSetup();
  try {
    const item = t.fabric.add('AppBackend', 'Analytics Hub', null);
    Object.assign(t.config.fabricApp, { itemId: item.id, models: ['vl'], reporting: { currency: 'USD' }, installerVersion: installerVersion() });
    t.config.reporting = { currency: 'EUR', exchangeRate: 0.92 };
    await ensureFabricApp(t.ctx);
    assert.match(t.ui.asked.join('\n'), /needs redeploying to show the Value page in EUR\. Deploy it again\?/);
    assert.deepEqual(t.config.fabricApp.reporting, { currency: 'EUR', exchangeRate: 0.92 });
    assert.deepEqual(JSON.parse(readFileSync(join(t.dir, PREBUILT_STATIC, FABRIC_CONFIG), 'utf8')).reporting, { currency: 'EUR', exchangeRate: 0.92 });

    t.ui.asked.length = 0;
    await ensureFabricApp(t.ctx);
    assert.match(t.ui.asked.join('\n'), /is deployed\. Deploy it again\?/, 'the same currency needs no redeploy');
  } finally {
    t.cleanup();
  }
});

test('app: an app an earlier installer deployed is redeployed by default, to update it to this version', async () => {
  const t = prebuiltSetup();
  try {
    await deployApp(t.ctx);
    const fa = t.config.fabricApp;
    assert.equal(fa.installerVersion, installerVersion(), 'the deploy records the installer version');

    t.runs.length = 0;
    await ensureFabricApp(t.ctx);
    assert.equal(t.ui.asked.at(-1), 'The app "Analytics Hub" is deployed. Deploy it again?');
    assert.deepEqual(t.runs, [], 'this version deployed it and nothing else changed: left alone by default');

    // Installers up to 0.6.7 recorded no version; later ones record theirs.
    for (const earlier of [undefined, '0.6.7']) {
      if (earlier) fa.installerVersion = earlier;
      else delete fa.installerVersion;
      t.runs.length = 0;
      await ensureFabricApp(t.ctx);
      assert.equal(t.ui.asked.at(-1), 'The app "Analytics Hub" needs redeploying to update it to this version. Deploy it again?');
      assert.equal(t.runs.length, 1, 'it redeploys by default');
      assert.equal(fa.installerVersion, installerVersion());
    }

    fa.installerVersion = '0.6.7';
    t.config.modules.consumption = true;
    Object.assign(t.config.consumption.model, { id: 'cc-1', bound: true });
    await ensureFabricApp(t.ctx);
    assert.equal(t.ui.asked.at(-1), 'The app "Analytics Hub" needs redeploying to update it to this version and add the credit consumption pages. Deploy it again?');
  } finally {
    t.cleanup();
  }
});

test('app: an app a later installer deployed is redeployed by default, to take it back to this version', async () => {
  const t = prebuiltSetup();
  try {
    await deployApp(t.ctx);
    t.config.fabricApp.installerVersion = '99.0.0';
    t.runs.length = 0;
    await ensureFabricApp(t.ctx);
    assert.equal(t.ui.asked.at(-1), 'The app "Analytics Hub" needs redeploying to take it back from 99.0.0 to this version. Deploy it again?');
    assert.equal(t.runs.length, 1, 'it redeploys by default');
    assert.equal(t.config.fabricApp.installerVersion, installerVersion());
  } finally {
    t.cleanup();
  }
});

test("app: answering no keeps the earlier version's record, so the next run offers the rebuild again", async () => {
  const t = appSetup({ answers: [false] });
  try {
    const item = t.fabric.add('AppBackend', 'Analytics Hub', null);
    Object.assign(t.config.fabricApp, { itemId: item.id, installerVersion: '0.6.7' });
    const question = 'The app "Analytics Hub" needs rebuilding to update it to this version. Build and deploy it again?';
    await ensureFabricApp(t.ctx);
    assert.equal(t.ui.asked.at(-1), question);
    assert.deepEqual(t.runs, []);
    assert.match(t.ui.text(), /App Analytics Hub is in place/);
    assert.equal(t.config.fabricApp.installerVersion, '0.6.7');

    await ensureFabricApp(t.ctx);
    assert.equal(t.ui.asked.at(-1), question);
    assert.equal(t.runs.length, 4, 'it rebuilds by default');
    assert.equal(t.config.fabricApp.installerVersion, installerVersion());
  } finally {
    t.cleanup();
  }
});

test('app: laterVersion orders installer releases and their release candidates', () => {
  assert.equal(laterVersion('0.6.8', '0.6.7'), true);
  assert.equal(laterVersion('0.7.0', '0.6.10'), true);
  assert.equal(laterVersion('1.0.0', '0.99.99'), true);
  assert.equal(laterVersion('0.6.8', '0.6.8-rc.2'), true, 'a release comes after its release candidates');
  assert.equal(laterVersion('0.6.8-rc.10', '0.6.8-rc.2'), true);
  assert.equal(laterVersion('0.6.9-rc.1', '0.6.8'), true);
  assert.equal(laterVersion('0.6.8', '0.6.8'), false);
  assert.equal(laterVersion('0.6.8-rc.2', '0.6.8'), false);
  assert.equal(laterVersion('0.6.7', '0.6.8-rc.2'), false);
  assert.equal(laterVersion('dev', '0.6.8'), false, 'any other version is never later');
  assert.equal(laterVersion('0.6.8', ''), false);
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
      defender: false,
      resourceGraph: false,
    },
  });
});

test('app: fabricConfigFile tells the app when Resource Graph is on', () => {
  const t = setup({ answers: [] });
  t.config.dataSources.resourceGraph = 'api';
  assert.equal(fabricConfigFile(t.config, 'ws', ['vl']).modules?.resourceGraph, true);
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

/** Runs fn as if in Azure Cloud Shell. */
async function inCloudShellEnv(fn) {
  const before = process.env.ANALYTICS_HUB_CLOUD_SHELL;
  process.env.ANALYTICS_HUB_CLOUD_SHELL = '1';
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.ANALYTICS_HUB_CLOUD_SHELL;
    else process.env.ANALYTICS_HUB_CLOUD_SHELL = before;
  }
}

test('app: in Azure Cloud Shell, rayfin deploys with the installer sign-in\'s Fabric token instead of opening a browser', async () => {
  const t = appSetup();
  /** @type {string[]} */
  const asked = [];
  t.ctx.getToken = async (r) => { asked.push(r); return `token-for-${r}`; };
  try {
    await inCloudShellEnv(() => deployApp(t.ctx));
    assert.deepEqual(asked, ['fabric']);
    const env = t.upOpts[0].env;
    assert.equal(env?.RAYFIN_TOKEN, 'token-for-fabric');
    assert.equal(env?.RAYFIN_TENANT_ID, 'tenant-1');
    // Windows keeps the key as "Path", so look it up whatever its case.
    const pathKey = Object.keys(env ?? {}).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    assert.equal(env?.[pathKey], process.env.PATH, 'the rest of the environment as it was');
    assert.match(t.ui.text(), /Building and deploying the app\. It uses your installer sign-in\./);
  } finally {
    t.cleanup();
  }
});

test('app: in Azure Cloud Shell, a deploy Fabric turns down says how to finish from Windows', async () => {
  const t = appSetup({ upFails: true });
  t.ctx.getToken = async () => 'token';
  try {
    await inCloudShellEnv(() => assert.rejects(deployApp(t.ctx), /installer sign-in's Fabric token[\s\S]*run deploy-app there/));
  } finally {
    t.cleanup();
  }
});

test('rayfinEnv: in Azure Cloud Shell, and never over a token already set', async () => {
  const ctx = /** @type {any} */ ({ getToken: async () => 'tok', user: { tenantId: 't1', upn: 'me@contoso.com' } });
  assert.equal(await rayfinEnv(ctx, {}, null), undefined);
  assert.equal(await rayfinEnv(ctx, { ACC_CLOUD: 'PROD', RAYFIN_TOKEN: 'mine' }, null), undefined);
  assert.equal(await rayfinEnv({ ...ctx, getToken: undefined }, { ACC_CLOUD: 'PROD' }, null), undefined);
  assert.deepEqual(await rayfinEnv(ctx, { ACC_CLOUD: 'PROD', X: '1' }, null), { ACC_CLOUD: 'PROD', X: '1', RAYFIN_TOKEN: 'tok', RAYFIN_TENANT_ID: 't1' });
});

test('rayfinEnv: when Rayfin is signed in as someone else, up runs as the installer\'s sign-in', async () => {
  const ctx = /** @type {any} */ ({ getToken: async () => 'tok', user: { tenantId: 'T1', upn: 'Me@Contoso.com' } });
  const withToken = { X: '1', RAYFIN_TOKEN: 'tok', RAYFIN_TENANT_ID: 'T1' };
  assert.equal(await rayfinEnv(ctx, { X: '1' }, { tenantId: 't1', userPrincipalName: 'me@contoso.com' }), undefined, 'the same person, whatever the case');
  assert.equal(await rayfinEnv(ctx, { X: '1' }, { tenantId: 't1' }), undefined, 'same tenant, no name saved');
  assert.deepEqual(await rayfinEnv(ctx, { X: '1' }, { tenantId: 'other', userPrincipalName: 'me@contoso.com' }), withToken, 'another tenant');
  assert.deepEqual(await rayfinEnv(ctx, { X: '1' }, { tenantId: 't1', userPrincipalName: 'someone@contoso.com' }), withToken, 'another person');
  assert.deepEqual(await rayfinEnv(ctx, { X: '1' }, { identityType: 'service_principal', tenantId: 't1' }), withToken, 'a service principal');
  assert.equal(await rayfinEnv(ctx, { X: '1', RAYFIN_TOKEN: 'mine' }, { tenantId: 'other' }), undefined, 'a token already set');
  assert.equal(await rayfinEnv({ ...ctx, getToken: undefined }, { X: '1' }, { tenantId: 'other' }), undefined, 'no installer token');
});

test('rayfinSignIn: reads Rayfin\'s auth.json from RAYFIN_CONFIG_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-rayfin-'));
  try {
    assert.equal(rayfinSignIn({ RAYFIN_CONFIG_DIR: dir }), null);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ identityType: 'user', tenantId: 't9', userPrincipalName: 'a@b.com' }));
    assert.deepEqual(rayfinSignIn({ RAYFIN_CONFIG_DIR: dir }), { identityType: 'user', tenantId: 't9', userPrincipalName: 'a@b.com' });
    assert.equal(rayfinSignedInAsOther(rayfinSignIn({ RAYFIN_CONFIG_DIR: dir }), { tenantId: 't1', upn: 'a@b.com' }), true);
    assert.equal(rayfinSignedInAsOther(null, { tenantId: 't1', upn: 'a@b.com' }), false, 'never signed in: Rayfin signs in itself');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app: Rayfin signed in as someone else deploys with the installer sign-in\'s Fabric token', async () => {
  const t = appSetup();
  const dir = mkdtempSync(join(tmpdir(), 'vl-rayfin-'));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ identityType: 'user', tenantId: 'another-tenant', userPrincipalName: 'someone@example.com' }));
  const before = process.env.RAYFIN_CONFIG_DIR;
  process.env.RAYFIN_CONFIG_DIR = dir;
  t.ctx.getToken = async (r) => `token-for-${r}`;
  try {
    await deployApp(t.ctx);
    assert.equal(t.upOpts[0].env?.RAYFIN_TOKEN, 'token-for-fabric');
    assert.equal(t.upOpts[0].env?.RAYFIN_TENANT_ID, 'tenant-1');
    assert.match(t.ui.text(), /Building and deploying the app\. It uses your installer sign-in\./);
  } finally {
    if (before === undefined) delete process.env.RAYFIN_CONFIG_DIR;
    else process.env.RAYFIN_CONFIG_DIR = before;
    rmSync(dir, { recursive: true, force: true });
    t.cleanup();
  }
});