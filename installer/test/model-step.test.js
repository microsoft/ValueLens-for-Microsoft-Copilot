// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
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
  config.app.displayName = 'ValueLens (Fabric)';
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, graph: graph.api, powerBi: powerBi.api, config });
  return { ...made, fabric, graph, powerBi, ui };
}

test('semantic model: created from the template, left alone on re-run, updated when modules change', async () => {
  const t = setup();
  await ensureSemanticModel(t.ctx);
  const item = t.fabric.items.find((i) => i.type === 'SemanticModel');
  assert.ok(item);
  assert.equal(item.displayName, 'ValueLens Model');
  assert.deepEqual(item.content.parts.map((/** @type {any} */ p) => p.path), ['model.bim', 'definition.pbism']);
  const bim = modelBim(item);
  assert.ok(bim.model.expressions.find((/** @type {any} */ e) => e.name === 'Fabric SQL Endpoint').expression.startsWith('"abc.datawarehouse.fabric.microsoft.com"'));
  assert.equal(t.config.semanticModel.id, item.id);
  assert.equal(t.config.semanticModel.bound, false);
  assert.equal(t.config.semanticModel.server, 'abc.datawarehouse.fabric.microsoft.com');

  t.config.semanticModel.bound = true;
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createSemanticModel ValueLens Model']);
  assert.equal(t.config.semanticModel.bound, true);

  t.config.modules.agent365 = !t.config.modules.agent365;
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateSemanticModel ValueLens Model']);
  assert.equal(t.config.semanticModel.bound, false, 'an update needs the connection bound again');

  await ensureSemanticModel(t.ctx, { force: true });
  assert.equal(t.fabric.calls.length, 3);
});

test('semantic model: waits for the SQL endpoint; a same-name model that is not ours is left alone', async () => {
  const t = setup();
  t.fabric.sqlStates.push({ provisioningStatus: 'InProgress' }, { connectionString: null });
  const existing = t.fabric.add('SemanticModel', 'ValueLens Model', 'theirs');
  await ensureSemanticModel(t.ctx);
  assert.equal(t.sleeps.length, 2);
  assert.deepEqual(t.ui.asked, [], 'never asks to replace it');
  assert.notEqual(t.config.semanticModel.id, existing.id);
  assert.equal(t.config.semanticModel.name, 'ValueLens Model 2');
  assert.deepEqual(t.fabric.calls, ['createSemanticModel ValueLens Model 2']);
  assert.equal(existing.content, 'theirs');
  assert.match(t.ui.text(), /"ValueLens Model" is already in the workspace/);

  const failed = setup();
  failed.fabric.sqlStates.push({ provisioningStatus: 'Failed' });
  await assert.rejects(ensureSemanticModel(failed.ctx), /failed to provision/);
});

test('semantic model: a deleted model is deployed again', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'gone', bound: true, signature: 'x' });
  await ensureSemanticModel(t.ctx);
  assert.notEqual(t.config.semanticModel.id, 'gone');
  assert.deepEqual(t.fabric.calls, ['createSemanticModel ValueLens Model']);
  assert.match(t.ui.text(), /was deleted/);
});

test('semantic model: a re-run redeploys a model whose definition changed, such as one from an older installer', async () => {
  const t = setup();
  await ensureSemanticModel(t.ctx);
  const sm = t.config.semanticModel;
  assert.match(String(sm.signature), /;[0-9a-f]{16}$/, 'the signature carries the definition hash');
  sm.bound = true;

  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createSemanticModel ValueLens Model'], 'the same definition is left in place');

  sm.signature = String(sm.signature).replace(/;[0-9a-f]{16}$/, '');
  await ensureSemanticModel(t.ctx);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateSemanticModel ValueLens Model'], 'a record without the hash (0.3.3) is updated');
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
  assert.deepEqual(t.fabric.calls, ['addRoleAssignment sp-1 Viewer', `createConnection ${name}`, `bindConnection ValueLens Model ${sm.connectionId} abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
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
  assert.deepEqual(t.fabric.calls, ['addRoleAssignment sp-1 Viewer', 'updateConnection conn-throttled', `bindConnection ValueLens Model conn-throttled abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
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
  assert.match(t.ui.text(), /Couldn't query ValueLens Model to check it \(Boom\)/);

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

test('tenant settings: only a setting that is off and not delegated is flagged', () => {
  const settings = {
    ServicePrincipalAccessPermissionAPIs: { enabled: false },
    CustomVisualsTenant: { enabled: false, delegateToCapacity: true },
  };
  assert.deepEqual(blockedSettings(settings, { reports: false }).map((s) => s.name), ['ServicePrincipalAccessPermissionAPIs']);
  assert.deepEqual(blockedSettings(settings, { reports: true }).map((s) => s.name), ['ServicePrincipalAccessPermissionAPIs']);
  assert.deepEqual(blockedSettings(undefined, { reports: true }), []);
});
