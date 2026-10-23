// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../src/install.js';
import { ENDPOINT_POLL_MS, fabricUninstall } from '../src/steps/fabric-uninstall.js';
import { describeRecord } from '../src/web-session.js';
import { fakeCtx, fakeUi, httpError } from './fakes.js';

/**
 * A workspace with managed private endpoints that take a poll or two to go after they're deleted.
 * @param {{ endpoints?: string[], polls?: number, deleteFails?: Record<string, Error>, workspaceGone?: boolean, connectionFails?: Error }} [o]
 */
function fakeWorkspace(o = {}) {
  /** @type {string[]} */
  const calls = [];
  let live = (o.endpoints ?? []).map((id) => ({ id, name: `mpe-${id}` }));
  const deleted = new Set();
  let polls = 0;
  const api = {
    listPrivateEndpoints: async (/** @type {string} */ ws) => {
      calls.push(`list ${ws}`);
      if (deleted.size && ++polls > (o.polls ?? 1)) live = live.filter((e) => !deleted.has(e.id));
      return live;
    },
    deletePrivateEndpoint: async (/** @type {string} */ ws, /** @type {string} */ id) => {
      calls.push(`deleteEndpoint ${ws} ${id}`);
      const err = o.deleteFails?.[id];
      if (!err || /** @type {any} */ (err).status === 404) deleted.add(id);
      if (err) throw err;
      return null;
    },
    deleteWorkspace: async (/** @type {string} */ ws) => {
      calls.push(`deleteWorkspace ${ws}`);
      if (live.length) throw httpError(400, 'WorkspaceHasManagedPrivateEndpoints');
      if (o.workspaceGone) throw httpError(404);
      return null;
    },
    deleteConnection: async (/** @type {string} */ id) => {
      calls.push(`deleteConnection ${id}`);
      if (o.connectionFails) throw o.connectionFails;
      return null;
    },
  };
  return { api, calls };
}

test('uninstall on Fabric: the managed private endpoints are deleted and gone before the workspace', async () => {
  const fabric = fakeWorkspace({ endpoints: ['a', 'b'], polls: 2 });
  const ui = fakeUi();
  const { ctx, config, sleeps } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.createdWorkspace = true;
  config.fabric.workspaceName = 'Analytics Hub';
  assert.equal(await runCommand(ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(fabric.calls, ['list ws-1', 'deleteEndpoint ws-1 a', 'deleteEndpoint ws-1 b', 'list ws-1', 'list ws-1', 'list ws-1', 'deleteWorkspace ws-1']);
  assert.deepEqual(sleeps, [ENDPOINT_POLL_MS, ENDPOINT_POLL_MS]);
  assert.match(ui.text(), /Deleted 2 managed private endpoints \(mpe-a, mpe-b\)/);
  assert.match(ui.text(), /Deleted workspace "Analytics Hub"/);
  assert.match(ui.text(), /Left alone: the app registration/);
});

test('uninstall on Fabric: an endpoint or workspace already gone is fine; other errors stop it', async () => {
  const fabric = fakeWorkspace({ endpoints: ['a', 'b'], deleteFails: { a: httpError(404) }, workspaceGone: true });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.createdWorkspace = true;
  assert.equal(await fabricUninstall(ctx), true);
  assert.ok(fabric.calls.includes('deleteWorkspace ws-1'));
  assert.match(ui.text(), /was already gone/);

  const broken = fakeWorkspace({ endpoints: ['a'], deleteFails: { a: httpError(403, 'Forbidden') } });
  const b = fakeCtx({ fabric: broken.api });
  b.config.fabric.createdWorkspace = true;
  await assert.rejects(fabricUninstall(b.ctx), /Forbidden/);
  assert.ok(!broken.calls.includes('deleteWorkspace ws-1'), 'the workspace is left while its endpoints remain');

  const stuck = fakeWorkspace({ endpoints: ['a'], polls: 1000 });
  const s = fakeCtx({ fabric: stuck.api });
  s.config.fabric.createdWorkspace = true;
  await assert.rejects(fabricUninstall(s.ctx), /still deleting/);
  assert.ok(!stuck.calls.includes('deleteWorkspace ws-1'));
});

test('uninstall on Fabric: asks first, and by default keeps a workspace the installer didn\'t create', async () => {
  const fabric = fakeWorkspace();
  const ui = fakeUi({ yes: true });
  const { ctx } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  assert.equal(await fabricUninstall(ctx), false);
  assert.deepEqual(fabric.calls, []);
  assert.match(ui.text(), /Left workspace/);

  const no = fakeWorkspace();
  const n = fakeCtx({ fabric: no.api, ui: fakeUi({ answers: [false] }).ui });
  n.config.fabric.createdWorkspace = true;
  assert.equal(await fabricUninstall(n.ctx), false);
  assert.deepEqual(no.calls, []);

  const none = fakeCtx();
  delete none.config.fabric.workspaceId;
  await assert.rejects(fabricUninstall(none.ctx), /Nothing is installed/);
});

test('uninstall on Fabric: the model\'s SQL connection goes after the workspace; a failure only warns', async () => {
  const fabric = fakeWorkspace();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ fabric: fabric.api, ui: ui.ui });
  config.fabric.createdWorkspace = true;
  config.semanticModel.connectionId = 'conn-1';
  config.semanticModel.connectionName = 'Analytics Hub SQL ws-1';
  config.keyVault.mode = 'notebook';
  assert.equal(await fabricUninstall(ctx), true);
  assert.deepEqual(fabric.calls.slice(-2), ['deleteWorkspace ws-1', 'deleteConnection conn-1']);
  assert.match(ui.text(), /Deleted the connection "Analytics Hub SQL ws-1"/);
  assert.doesNotMatch(ui.text(), /Key Vault/);

  const gone = fakeWorkspace({ connectionFails: httpError(404) });
  const g = fakeUi();
  const gc = fakeCtx({ fabric: gone.api, ui: g.ui });
  gc.config.fabric.createdWorkspace = true;
  gc.config.semanticModel.connectionId = 'conn-1';
  assert.equal(await fabricUninstall(gc.ctx), true);
  assert.match(g.text(), /was already gone/);

  const denied = fakeWorkspace({ connectionFails: httpError(403, 'Forbidden') });
  const d = fakeUi();
  const dc = fakeCtx({ fabric: denied.api, ui: d.ui });
  dc.config.fabric.createdWorkspace = true;
  dc.config.semanticModel.connectionId = 'conn-1';
  assert.equal(await fabricUninstall(dc.ctx), true);
  assert.match(d.text(), /Couldn't delete the connection "conn-1"/);
  assert.match(d.text(), /Key Vault and its secret/);

  const none = fakeWorkspace();
  const nc = fakeCtx({ fabric: none.api });
  nc.config.fabric.createdWorkspace = true;
  delete nc.config.semanticModel.connectionId;
  await fabricUninstall(nc.ctx);
  assert.ok(!none.calls.some((c) => c.startsWith('deleteConnection')));
});

test('web: uninstall is offered for a Fabric install too', () => {
  const { config } = fakeCtx();
  assert.equal(describeRecord(config).can.uninstall, true);
  delete config.fabric.workspaceId;
  assert.equal(describeRecord(config).can.uninstall, false);
});
