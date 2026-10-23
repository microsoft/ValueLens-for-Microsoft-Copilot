// @ts-check
// The Power BI capacity on Azure. Repair, with or without --yes, offers where the workspace is: its saved capacity;
// else, looked up, the active capacity it's on, or None (shared capacity, Pro) on shared capacity; else None if that
// was the choice. So it no longer moves a shared-capacity install's workspace onto the first active capacity. Records
// from before 0.6.8 didn't save None: one with a workspace and no capacity chose it. A new install still suggests the
// first active capacity, and private networking never offers None.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installAzure, planAzure } from '../src/steps/azure/index.js';
import { createUi } from '../src/ui.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi } from './fakes.js';

const CAPACITY = 'Capacity for the Power BI workspace';
const NONE = '';
const PRE = { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], canConsent: true, canCreateApps: true, capacities: [], tenantSettings: [] };
const SHARED_WARNING = /on shared capacity, where a semantic model is limited to 1 GB/;
/** An Azure install's record before Power BI is chosen. */
const BASE = {
  subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: '12345678-aaaa', tags: {},
  deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub',
};
/** What 0.6.7 and 0.6.8-rc.2 recorded for an install on shared capacity: its workspace, and no capacity. */
const LEGACY_SHARED = [
  { workspaceId: 'pbi-ws-1', createdWorkspace: true, datasetId: 'ds-1' },
  { workspaceId: 'pbi-ws-1' },
];
const HOW = [{ how: 'every default' }, { how: '--yes', yes: true }, { how: 'web setup', section: 'powerbi' }];

/** @param {string} id @param {string} sku */
const cap = (id, sku) => ({ id, displayName: sku, sku, region: 'UK South', state: 'Active' });

/**
 * An Azure install whose capacity question is recorded. `plan` plans as install and Repair do (or, with a section, as
 * the web setup does) and answers that question with `answer`; with `yes`, the way a --yes run does; otherwise with its
 * default, as Enter does.
 * @param {{ powerBi?: any, azure?: any, capacities?: any[] }} [o]
 */
function planCtx(o = {}) {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  powerBi.workspaces.push({ id: 'pbi-ws-1', name: 'Analytics Hub' });
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  if (o.capacities) fabric.api.listCapacities = async () => /** @type {any[]} */ (o.capacities);
  const u = fakeUi();
  /** @type {{ answer?: string, yes?: boolean }} */
  let how = {};
  /** @type {{ message: string, values: any[], def: any }[]} */
  const questions = [];
  const select = u.ui.select;
  const unattended = createUi({ yes: true, write: () => {} });
  u.ui.select = async (message, choices, def) => {
    if (!message.startsWith(CAPACITY)) return select(message, choices, def);
    questions.push({ message, values: choices.map((c) => c.value), def });
    if (how.answer !== undefined) {
      u.asked.push(message);
      return /** @type {any} */ (how.answer);
    }
    if (!how.yes) return select(message, choices, def);
    u.asked.push(message);
    return unattended.select(message, choices, def);
  };
  const t = fakeCtx({ ui: u.ui, arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api });
  delete t.config.fabric.workspaceId;
  t.config.target = 'azure';
  t.config.azure = structuredClone({ ...BASE, ...o.azure, ...(o.powerBi ? { powerBi: o.powerBi } : {}) });
  return {
    ...t, fabric, u,
    pbi: () => /** @type {any} */ (t.config.azure).powerBi,
    /** @param {{ answer?: string, yes?: boolean, section?: string, seats?: number }} [p] */
    async plan(p = {}) {
      how = p;
      const before = questions.length;
      await planAzure(t.ctx, { ...PRE, seats: p.seats }, p.section);
      assert.equal(questions.length, before + 1, 'the capacity question is asked once');
      return questions[before];
    },
    async deploy() {
      t.ctx.runFirstLoad = false;
      // Viewer access has its own tests; this is about the capacity.
      delete t.config.access;
      return installAzure(t.ctx, { wait: true });
    },
  };
}

test('Azure capacity: a Repair after None (shared capacity, Pro) offers None again, with or without --yes', async () => {
  const t = planCtx();
  const first = await t.plan({ answer: NONE });
  assert.equal(first.message, CAPACITY);
  assert.deepEqual(first.values, ['cap-f', 'cap-ppu', NONE]);
  assert.equal(first.def, 'cap-f', 'a new install suggests the first active capacity');
  assert.equal(t.pbi().capacityId, undefined);
  // Before setup created the workspace, then after.
  for (const created of [false, true]) {
    if (created) Object.assign(t.pbi(), { workspaceId: 'pbi-ws-1', createdWorkspace: true });
    for (const yes of [false, true]) {
      const what = `${created ? 'workspace created' : 'no workspace yet'}, ${yes ? '--yes' : 'every default'}`;
      assert.equal((await t.plan({ yes })).def, NONE, what);
      assert.equal(t.pbi().capacityId, undefined, what);
      assert.equal(t.pbi().sharedCapacity, true, what);
    }
  }

  // None was chosen on a capacity, and the workspace put on shared capacity by hand: None doesn't move it.
  const moved = planCtx({ powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-ppu' } });
  await moved.plan({ answer: NONE });
  for (const yes of [false, true]) {
    assert.equal((await moved.plan({ yes })).def, NONE, `moved off a capacity, ${yes ? '--yes' : 'every default'}`);
    assert.equal(moved.pbi().capacityId, undefined);
  }
});

test('Azure capacity: a 0.6.7 or 0.6.8-rc.2 install with a workspace and no capacity recorded is offered None', async () => {
  for (const powerBi of LEGACY_SHARED) {
    for (const p of HOW) {
      const what = `${JSON.stringify(powerBi)}, ${p.how}`;
      const t = planCtx({ powerBi });
      assert.equal((await t.plan(p)).def, NONE, what);
      assert.equal(t.pbi().capacityId, undefined, what);
      assert.equal(t.pbi().sharedCapacity, true, `${what}: recorded`);
      assert.equal(t.pbi().workspaceId, 'pbi-ws-1', what);
    }
  }
});

test('Azure capacity: a Repair keeps the capacity chosen, with or without --yes', async () => {
  for (const yes of [false, true]) {
    const t = planCtx({ powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-ppu' } });
    assert.equal((await t.plan({ yes })).def, 'cap-ppu');
    assert.equal(t.pbi().capacityId, 'cap-ppu');
    assert.equal(t.pbi().sharedCapacity, undefined);
  }
  for (const powerBi of [{ workspaceId: 'pbi-ws-1', createdWorkspace: true, sharedCapacity: true }, ...LEGACY_SHARED]) {
    const t = planCtx({ powerBi });
    await t.plan({ answer: 'cap-ppu' });
    assert.equal(t.pbi().capacityId, 'cap-ppu');
    assert.equal(t.pbi().sharedCapacity, undefined, `${JSON.stringify(powerBi)}: None is no longer the choice`);
    for (const yes of [false, true]) {
      assert.equal((await t.plan({ yes })).def, 'cap-ppu', `${JSON.stringify(powerBi)}, then a capacity, ${yes ? '--yes' : 'every default'}`);
      assert.equal(t.pbi().capacityId, 'cap-ppu');
    }
  }
  // A paused capacity can't be offered, and the workspace is still on it.
  const paused = planCtx({ powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-paused' } });
  paused.fabric.workspaceCapacities['pbi-ws-1'] = 'cap-paused';
  assert.equal((await paused.plan()).def, 'cap-f', 'a capacity that is paused: the first active one, as before');
});

test('Azure capacity: a new install still suggests the first active capacity, with or without --yes', async () => {
  for (const powerBi of [undefined, {}]) {
    for (const p of HOW) {
      const what = `${JSON.stringify(powerBi)}, ${p.how}`;
      const t = planCtx({ powerBi });
      const q = await t.plan(p);
      assert.deepEqual(q.values, ['cap-f', 'cap-ppu', NONE], what);
      assert.equal(q.def, 'cap-f', what);
      assert.equal(t.pbi().capacityId, 'cap-f', what);
      assert.equal(t.pbi().sharedCapacity, undefined, what);
    }
  }
});

test('Azure capacity: private networking never offers None, even to an install that was on shared capacity', async () => {
  const capacities = [cap('cap-f', 'F64'), cap('cap-g', 'F2'), cap('cap-ppu', 'PP3')];
  for (const powerBi of [undefined, { sharedCapacity: true }, { workspaceId: 'pbi-ws-1', createdWorkspace: true, sharedCapacity: true }, ...LEGACY_SHARED]) {
    for (const p of HOW) {
      const what = `${JSON.stringify(powerBi)}, ${p.how}`;
      const t = planCtx({ capacities, powerBi, azure: { publicNetworkAccess: false, privateDns: { mode: 'create' } } });
      const q = await t.plan(p);
      assert.equal(q.message, `${CAPACITY} and VNet data gateway`, what);
      assert.deepEqual(q.values, ['cap-f', 'cap-g'], `${what}: no None`);
      assert.equal(q.def, 'cap-f', what);
      assert.equal(t.pbi().capacityId, 'cap-f', what);
      assert.equal(t.pbi().sharedCapacity, undefined, what);
    }
  }
});

test('Azure capacity: a large tenant that chose None is offered it again, and still warned', async () => {
  for (const powerBi of [{ workspaceId: 'pbi-ws-1', createdWorkspace: true, sharedCapacity: true }, ...LEGACY_SHARED]) {
    for (const yes of [false, true]) {
      const what = `${JSON.stringify(powerBi)}, ${yes ? '--yes' : 'every default'}`;
      const t = planCtx({ powerBi });
      assert.equal((await t.plan({ yes, seats: 20_000 })).def, NONE, what);
      assert.equal(t.pbi().capacityId, undefined, what);
      assert.match(t.u.text(), SHARED_WARNING, what);
    }
  }
});

test('Azure capacity: a --yes Repair leaves a shared-capacity workspace where it is', async () => {
  const t = planCtx();
  await t.plan({ answer: NONE });
  assert.equal(await t.deploy(), true);
  assert.equal(t.pbi().workspaceId, 'pbi-ws-1');
  assert.equal(t.pbi().createdWorkspace, true, 'the installer created it, so it would move it');
  const assigned = () => t.fabric.calls.filter((c) => c.startsWith('assignToCapacity'));
  assert.deepEqual(assigned(), []);
  for (const recordedBefore068 of [false, true]) {
    if (recordedBefore068) delete t.pbi().sharedCapacity;
    const what = recordedBefore068 ? 'a record from before 0.6.8' : 'None recorded';
    const q = await t.plan({ yes: true });
    assert.equal(await t.deploy(), true, what);
    assert.deepEqual(assigned(), [], `${what}: not moved onto a capacity`);
    assert.equal(t.fabric.workspaceCapacities['pbi-ws-1'], undefined, what);
    assert.equal(q.def, NONE, what);
  }
});

test('Azure capacity: with no saved capacity to offer, a Repair offers where the workspace is', async () => {
  const paused = [{ ...cap('cap-f', 'FTL64'), state: 'Paused' }, { ...cap('cap-ppu', 'PP3'), state: 'Paused' }];
  for (const p of HOW) {
    // A Repair while every capacity was paused could only offer None, and took it.
    const t = planCtx({ powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-ppu' } });
    t.fabric.workspaceCapacities['pbi-ws-1'] = 'cap-ppu';
    const listCapacities = t.fabric.api.listCapacities;
    t.fabric.api.listCapacities = async () => paused;
    assert.deepEqual((await t.plan(p)).values, [NONE], p.how);
    assert.equal(t.pbi().capacityId, undefined, p.how);
    // Running again, the capacity the workspace is on, not the first one or None.
    t.fabric.api.listCapacities = listCapacities;
    const q = await t.plan(p);
    if (!p.section) {
      assert.equal(await t.deploy(), true, p.how);
      assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('assignToCapacity')), [], `${p.how}: not moved`);
    }
    assert.equal(q.def, 'cap-ppu', p.how);
    assert.equal(t.pbi().capacityId, 'cap-ppu', p.how);
    assert.equal(t.pbi().sharedCapacity, undefined, p.how);
  }

  // None was chosen while the workspace was on a capacity, which None doesn't move it off, or it was put on one by
  // hand. Its ID can come back in another case.
  const byHand = planCtx({ powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, sharedCapacity: true } });
  byHand.fabric.workspaceCapacities['pbi-ws-1'] = 'CAP-PPU';
  assert.equal((await byHand.plan({ yes: true })).def, 'cap-ppu', 'on a capacity');
  assert.equal(byHand.pbi().sharedCapacity, undefined, 'on a capacity');
  // A record from before 0.6.8 whose workspace is on a capacity, and a saved capacity that's gone.
  for (const powerBi of [...LEGACY_SHARED, { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-gone' }]) {
    const t = planCtx({ powerBi });
    t.fabric.workspaceCapacities['pbi-ws-1'] = 'cap-ppu';
    assert.equal((await t.plan({ yes: true })).def, 'cap-ppu', JSON.stringify(powerBi));
  }
  // A saved capacity that's gone, and the workspace on shared capacity now: it stays there.
  for (const p of HOW) {
    const what = `capacity gone, ${p.how}`;
    const t = planCtx({ powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-gone' } });
    const q = await t.plan(p);
    if (!p.section) {
      assert.equal(await t.deploy(), true, what);
      assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('assignToCapacity')), [], `${what}: not moved`);
    }
    assert.equal(q.def, NONE, what);
    assert.equal(t.pbi().capacityId, undefined, what);
    assert.equal(t.pbi().sharedCapacity, true, what);
  }
  // When the workspace can't be looked up, the record decides.
  const unreadable = [
    { powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, sharedCapacity: true }, def: NONE },
    ...LEGACY_SHARED.map((powerBi) => ({ powerBi, def: NONE })),
    { powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-gone' }, def: 'cap-f' },
  ];
  for (const { powerBi, def } of unreadable) {
    const t = planCtx({ powerBi });
    t.fabric.api.getWorkspace = async () => { throw new Error('Power BI is unavailable'); };
    assert.equal((await t.plan({ yes: true })).def, def, `${JSON.stringify(powerBi)}, not looked up`);
  }
});
