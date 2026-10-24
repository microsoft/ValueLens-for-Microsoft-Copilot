// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { accessCommand, accessReview, ensureViewerGroup, grantModelAccess, myGroupsUrl, NEW_GROUP_ATTEMPTS, NEW_GROUP_RETRY_MS, planAccess, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { fabricViewerModels } from '../src/install.js';
import { HttpError } from '../src/http.js';
import { fakeCtx, fakeUi, httpError } from './fakes.js';

/** A directory with a few groups and users, recording what was changed. */
function directory() {
  /** @type {Map<string, { id: string, displayName: string, members: string[], owners: string[] }>} */
  const groups = new Map();
  const users = new Map([['ana@contoso.com', { id: 'u-ana', displayName: 'Ana' }], ['ben@contoso.com', { id: 'u-ben', displayName: 'Ben' }]]);
  /** @type {string[]} */
  const calls = [];
  /** @type {Error | undefined} */
  let createError;
  const graph = {
    verifiedDomains: async () => ['contoso.com', 'contoso.onmicrosoft.com'],
    getGroup: async (/** @type {string} */ id) => groups.get(id) ?? null,
    findGroupByName: async (/** @type {string} */ name) => [...groups.values()].find((g) => g.displayName === name) ?? null,
    /** @param {{ displayName: string, ownerId: string }} o */
    createSecurityGroup: async (o) => {
      calls.push(`create ${o.displayName} owner=${o.ownerId}`);
      if (createError) throw createError;
      const g = { id: `g-${groups.size + 1}`, displayName: o.displayName, members: [], owners: [o.ownerId] };
      groups.set(g.id, g);
      return g;
    },
    groupMembers: async (/** @type {string} */ id) => (groups.get(id)?.members ?? []).map((m) => ({ id: m })),
    groupOwners: async (/** @type {string} */ id) => (groups.get(id)?.owners ?? []).map((m) => ({ id: m, userPrincipalName: m })),
    addGroupMember: async (/** @type {string} */ id, /** @type {string} */ member) => {
      const g = /** @type {any} */ (groups.get(id));
      if (g.members.includes(member)) return false;
      g.members.push(member);
      calls.push(`member ${member}`);
      return true;
    },
    addGroupOwner: async (/** @type {string} */ id, /** @type {string} */ owner) => {
      /** @type {any} */ (groups.get(id)).owners.push(owner);
      calls.push(`owner ${owner}`);
      return true;
    },
    resolvePrincipal: async (/** @type {string} */ name) => {
      const u = users.get(name.toLowerCase());
      if (u) return { ...u, kind: 'user' };
      const g = groups.get(name) ?? [...groups.values()].find((x) => x.displayName === name);
      return g ? { id: g.id, displayName: g.displayName, kind: 'group' } : null;
    },
  };
  return { graph, groups, calls, failCreate: (/** @type {Error} */ e) => (createError = e) };
}

function datasets() {
  /** @type {Record<string, any[]>} */
  const users = {};
  /** @type {string[]} */
  const calls = [];
  /** @type {Set<string>} */
  const denied = new Set();
  /** How many more times each model rejects a group Power BI hasn't seen yet. @type {Record<string, number>} */
  const unseen = {};
  /** Models whose users Power BI won't list. @type {Set<string>} */
  const unreadable = new Set();
  /** What taking a group's access away throws, by "<model> <group>". @type {Record<string, Error>} */
  const removeErrors = {};
  const powerBi = {
    datasetUsers: async (/** @type {string} */ _ws, /** @type {string} */ ds) => {
      if (unreadable.has(ds)) throw new HttpError('Forbidden', { status: 403, method: 'GET', url: 'https://x' });
      return users[ds] ?? [];
    },
    addDatasetUser: async (/** @type {string} */ ws, /** @type {string} */ ds, /** @type {any} */ body) => {
      if (denied.has(ds)) throw new HttpError('Forbidden', { status: 403, method: 'POST', url: 'https://x' });
      if (unseen[ds] > 0) {
        unseen[ds]--;
        throw new HttpError('InvalidRequest: Parameter identifier is missing or invalid', { status: 400, method: 'POST', url: 'https://x' });
      }
      calls.push(`${ws}/${ds} ${body.identifier} ${body.principalType} ${body.datasetUserAccessRight}`);
      (users[ds] ??= []).push(body);
    },
    updateDatasetUser: async (/** @type {string} */ ws, /** @type {string} */ ds, /** @type {any} */ body) => {
      const err = removeErrors[`${ds} ${body.identifier}`];
      if (err) throw err;
      calls.push(`${ws}/${ds} ${body.identifier} ${body.principalType} ${body.datasetUserAccessRight}`);
      users[ds] = (users[ds] ?? []).filter((u) => String(u.identifier).toLowerCase() !== String(body.identifier).toLowerCase());
      if (body.datasetUserAccessRight !== 'None') users[ds].push(body);
    },
  };
  return { powerBi, users, calls, denied, unseen, unreadable, removeErrors };
}

/** A group's Build on a model, as Power BI lists it. @param {string} id */
const build = (id) => ({ identifier: id, principalType: 'Group', datasetUserAccessRight: 'ReadExplore' });

const MODELS = [{ workspaceId: 'ws-1', datasetId: 'ds-vl', name: 'ValueLens' }, { workspaceId: 'ws-1', datasetId: 'ds-cc', name: 'Credits' }];

test('access: the plan asks for a new group by default, with you as the contact', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  await planAccess(ctx);
  assert.deepEqual(ctx.config.access, { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', requestUrl: undefined });
  const review = accessReview(ctx.config, 'Workspace X');
  assert.equal(review.creates[0].name, VIEWER_GROUP_NAME);
  assert.equal(review.creates[0].isNew, true);
  assert.equal(review.grants[0].what, 'Build (ReadExplore)');
});

test('access: without Advanced settings, a new viewer group with you as contact, no questions', async () => {
  const { ui, asked } = fakeUi();
  const { ctx } = fakeCtx({ graph: directory().graph, ui });
  ctx.advanced = false;
  await planAccess(ctx);
  assert.deepEqual(ctx.config.access, { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' });
  assert.deepEqual(asked, []);

  // A re-run keeps the group, contact and link it had.
  const saved = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, contact: 'leads@contoso.com', requestUrl: 'https://myaccess.microsoft.com/x' };
  const again = fakeCtx({ graph: directory().graph, ui });
  again.ctx.advanced = false;
  again.config.access = { ...saved };
  await planAccess(again.ctx);
  assert.deepEqual(again.config.access, saved);
  assert.deepEqual(asked, []);
});

test('access: a contact from outside the tenant, e.g. a record from another tenant, goes back to you', async () => {
  const quiet = fakeUi();
  const moved = fakeCtx({ graph: directory().graph, ui: quiet.ui });
  moved.ctx.advanced = false;
  moved.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'someone@fabrikam.com' };
  await planAccess(moved.ctx);
  assert.equal(moved.config.access?.contact, 'admin@contoso.com');
  assert.match(quiet.text(), /someone@fabrikam\.com, isn't on one of this tenant's domains, so it's now admin@contoso\.com/);

  const sub = fakeCtx({ graph: directory().graph, ui: fakeUi().ui });
  sub.ctx.advanced = false;
  sub.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'help@it.contoso.com' };
  await planAccess(sub.ctx);
  assert.equal(sub.config.access?.contact, 'help@it.contoso.com', 'a subdomain of a verified domain is kept');

  const blind = fakeCtx({ graph: { ...directory().graph, verifiedDomains: async () => { throw new Error('Forbidden'); } }, ui: fakeUi().ui });
  blind.ctx.advanced = false;
  blind.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'someone@fabrikam.com' };
  await planAccess(blind.ctx);
  assert.equal(blind.config.access?.contact, 'someone@fabrikam.com', 'kept when the domains can\'t be read');

  const t = fakeUi({ answers: ['new'] });
  const asked = fakeCtx({ graph: directory().graph, ui: t.ui });
  asked.config.access = { contact: 'someone@fabrikam.com' };
  await planAccess(asked.ctx);
  assert.equal(asked.config.access?.contact, 'admin@contoso.com', 'the question starts from you');
  assert.match(t.text(), /People without access are asked to email admin@contoso\.com\. Add a link, e.g\. a request form, to offer that too\./);
  assert.ok(t.asked.includes('Link where people can request access (optional)'));
});

test('access: an existing group is found by name, asking again until it exists', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  const { ui, text } = fakeUi({ answers: ['existing', 'Nope', 'Copilot Leads', 'leads@contoso.com', 'https://myaccess.microsoft.com/@contoso.com#/access-packages/1'] });
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, ui });
  await planAccess(ctx);
  assert.match(text(), /No group called "Nope"/);
  assert.equal(ctx.config.access?.groupId, 'g-9');
  assert.equal(ctx.config.access?.createdGroup, false);
  assert.equal(ctx.config.access?.contact, 'leads@contoso.com');
  assert.match(String(ctx.config.access?.requestUrl), /^https:\/\/myaccess/);
  assert.equal(accessReview(ctx.config, 'X').creates[0].isNew, false);
});

test('access: the request link must be https', async () => {
  const { ui } = fakeUi({ answers: ['new', 'admin@contoso.com', 'http://insecure'] });
  await assert.rejects(planAccess(fakeCtx({ graph: directory().graph, ui }).ctx), /https:\/\//);
});

test('access: the viewer group is created once, with the installer as owner, then reused', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  ctx.config.access = { groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com' };
  const first = await ensureViewerGroup(ctx);
  assert.equal(first?.id, 'g-1');
  assert.deepEqual(dir.calls, [`create ${VIEWER_GROUP_NAME} owner=user-1`]);
  assert.equal(ctx.config.access.createdGroup, true);
  await ensureViewerGroup(ctx);
  assert.equal(dir.calls.length, 1);
});

test('access: a created group that was deleted is created again; a chosen one is not', async () => {
  const dir = directory();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph });
  ctx.config.access = { groupId: 'gone', groupName: VIEWER_GROUP_NAME, createdGroup: true, grantedModels: ['ds-vl'] };
  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');
  assert.deepEqual(ctx.config.access.grantedModels, []);

  const { ui, text } = fakeUi();
  const { ctx: other } = fakeCtx({ graph: dir.graph, ui });
  other.config.access = { groupId: 'gone', groupName: 'Copilot Leads', createdGroup: false };
  assert.equal(await ensureViewerGroup(other), null);
  assert.equal(other.config.access.groupId, undefined);
  assert.match(text(), /Copilot Leads is gone/);
});

test('access: without permission to create groups, setup carries on and says what to do', async () => {
  const dir = directory();
  dir.failCreate(new HttpError('Forbidden', { status: 403, method: 'POST', url: 'https://x' }));
  const { ui, text } = fakeUi();
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, ui });
  ctx.config.access = { groupName: VIEWER_GROUP_NAME };
  assert.equal(await ensureViewerGroup(ctx), null);
  assert.match(text(), /can't create groups/);
  assert.match(text(), /run "access"/);
});

test('access: the group gets Build on each model once, and a failed grant only warns', async () => {
  const pbi = datasets();
  pbi.users['ds-cc'] = [{ identifier: 'G-1', principalType: 'Group', datasetUserAccessRight: 'ReadExplore' }];
  const { ui, text } = fakeUi();
  const { ctx: ctx } = fakeCtx({ powerBi: pbi.powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-1 Group ReadExplore']);
  assert.deepEqual(ctx.config.access.grantedModels, ['ds-vl', 'ds-cc']);

  pbi.denied.add('ds-x');
  await grantModelAccess(ctx, [{ workspaceId: 'ws-1', datasetId: 'ds-x', name: 'Other' }]);
  assert.match(text(), /Couldn't give ValueLens Viewers Build on Other/);
  assert.ok(!ctx.config.access.grantedModels?.includes('ds-x'));
});

test('access: a group Power BI does not know yet is retried, then reported if it never appears', async () => {
  const pbi = datasets();
  pbi.unseen['ds-vl'] = 2;
  const { ui, text } = fakeUi();
  const { ctx: ctx, sleeps } = fakeCtx({ powerBi: pbi.powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-1 Group ReadExplore', 'ws-1/ds-cc g-1 Group ReadExplore']);
  assert.deepEqual(sleeps, [NEW_GROUP_RETRY_MS, NEW_GROUP_RETRY_MS]);
  assert.match(text(), /Waiting for Power BI to see the group/);
  assert.doesNotMatch(text(), /Couldn't give/);

  pbi.unseen['ds-y'] = NEW_GROUP_ATTEMPTS;
  await grantModelAccess(ctx, [{ workspaceId: 'ws-1', datasetId: 'ds-y', name: 'Other' }]);
  assert.match(text(), /Couldn't give ValueLens Viewers Build on Other/);
  assert.equal(sleeps.length, 2 + NEW_GROUP_ATTEMPTS - 1);
});

test('access: the command adds viewers and owners, and skips names it cannot find', async () => {
  const dir = directory();
  dir.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, members: ['u-ana'], owners: ['user-1'] });
  const { ui, text } = fakeUi({ answers: ['members', 'ana@contoso.com, ben@contoso.com; nobody@contoso.com', 'owner', 'ben@contoso.com', 'done'] });
  const { ctx: ctx } = fakeCtx({ graph: dir.graph, powerBi: datasets().powerBi, ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await accessCommand(ctx, MODELS);
  assert.deepEqual(dir.calls, ['member u-ben', 'owner u-ben']);
  assert.match(text(), /Ana was already there/);
  assert.match(text(), /No user or group called "nobody@contoso.com"/);
  assert.match(text(), new RegExp(myGroupsUrl('g-1').replace(/[/.]/g, '\\$&')));
});

test('access: the viewer group gets Build on the deployed ValueLens model', () => {
  const { ctx: ctx } = fakeCtx();
  const config = ctx.config;
  config.semanticModel.enabled = true;
  config.semanticModel.id = 'ds-vl';
  assert.deepEqual(fabricViewerModels(config).map((m) => `${m.workspaceId}/${m.datasetId}`), ['ws-1/ds-vl']);
});

/** The report published on the model, as deployReport records it. @param {import('../src/config.js').InstallConfig} config */
function publish(config) {
  Object.assign(config.semanticModel, { enabled: true, reports: true, id: 'ds-vl', report: { id: 'rep-1', name: 'ValueLens', modelId: 'ds-vl', signature: 'sig-1' } });
}

test('access: another viewer group, or a lost one, is asked about sharing the report again', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  dir.groups.set('g-8', { id: 'g-8', displayName: 'Copilot Pilots', members: [], owners: [] });
  const chosen = () => ({ groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, contact: 'leads@contoso.com', reportShared: true });
  /** @param {any[]} answers @param {import('../src/config.js').AccessConfig} access */
  const plan = async (answers, access) => {
    const t = fakeCtx({ graph: dir.graph, ui: fakeUi({ answers }).ui });
    t.config.access = access;
    await planAccess(t.ctx);
    return t.config.access;
  };

  const same = await plan(['existing', 'Copilot Leads', 'leads@contoso.com', ''], chosen());
  assert.equal(same?.groupId, 'g-9');
  assert.equal(same?.reportShared, true, 'the same group keeps it');

  const other = await plan(['existing', 'Copilot Pilots', 'leads@contoso.com', ''], chosen());
  assert.equal(other?.groupId, 'g-8');
  assert.equal(other?.reportShared, undefined);

  const fresh = await plan(['new', 'leads@contoso.com', ''], chosen());
  assert.equal(fresh?.groupId, undefined, 'a new group is created at install');
  assert.equal(fresh?.reportShared, undefined);

  const kept = await plan(['new', 'admin@contoso.com', ''], { groupId: 'g-9', groupName: VIEWER_GROUP_NAME, createdGroup: true, reportShared: true });
  assert.equal(kept?.groupId, 'g-9', 'the group the installer made is kept');
  assert.equal(kept?.reportShared, true);

  const { ctx: gone } = fakeCtx({ graph: dir.graph });
  gone.config.access = { groupId: 'gone', groupName: VIEWER_GROUP_NAME, createdGroup: true, reportShared: true };
  assert.equal((await ensureViewerGroup(gone))?.id, 'g-3');
  assert.equal(gone.config.access.reportShared, undefined, 'a group made again has nothing shared with it');
});

/** @typedef {import('../src/config.js').AccessConfig} AccessConfig */

test('access: choosing another viewer group takes away the Build the installer gave the old one', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  dir.groups.set('g-8', { id: 'g-8', displayName: 'Copilot Pilots', members: [], owners: [] });
  const pbi = datasets();
  pbi.users['ds-vl'] = [build('g-9')];
  pbi.users['ds-cc'] = [build('G-9')];
  const { ui, text } = fakeUi({ answers: ['existing', 'Copilot Pilots', 'leads@contoso.com', ''] });
  const { ctx } = fakeCtx({ graph: dir.graph, powerBi: pbi.powerBi, ui });
  const before = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false, contact: 'leads@contoso.com', grantedModels: ['ds-vl', 'ds-cc'], reportShared: true };
  const record = (ctx.config.access = structuredClone(before));
  await planAccess(ctx);
  assert.deepEqual(record, before, 'the plan works on a copy, so the record is unchanged until it finishes');
  const a = /** @type {AccessConfig} */ (ctx.config.access);
  assert.deepEqual(
    { groupId: a.groupId, grantedModels: a.grantedModels, retiredGroups: a.retiredGroups, reportShared: a.reportShared },
    { groupId: 'g-8', grantedModels: [], retiredGroups: [{ groupId: 'g-9', groupName: 'Copilot Leads', datasets: ['ds-vl', 'ds-cc'] }], reportShared: undefined },
  );
  const review = () => accessReview(ctx.config, 'Workspace X').grants.map((g) => `${g.who}: ${g.what}`);
  assert.deepEqual(review(), ['Copilot Pilots (group): Build (ReadExplore)', 'Copilot Leads (group): Build removed']);

  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-8 Group ReadExplore', 'ws-1/ds-cc g-8 Group ReadExplore', 'ws-1/ds-vl g-9 Group None', 'ws-1/ds-cc g-9 Group None']);
  assert.match(text(), /✓ Copilot Leads no longer has Build on ValueLens\n/);
  assert.match(text(), /✓ Copilot Leads no longer has Build on Credits\n/);
  assert.deepEqual(a.grantedModels, ['ds-vl', 'ds-cc']);
  assert.equal(a.retiredGroups, undefined);
  assert.deepEqual(review(), ['Copilot Pilots (group): Build (ReadExplore)']);
});

test('access: a group chosen again keeps its Build, and so does one the new-group step will find by name', async () => {
  const dir = directory();
  dir.groups.set('g-9', { id: 'g-9', displayName: 'Copilot Leads', members: [], owners: [] });
  /** @param {any[]} answers @param {AccessConfig} access */
  const plan = async (answers, access) => {
    const t = fakeCtx({ graph: dir.graph, ui: fakeUi({ answers }).ui });
    t.config.access = access;
    await planAccess(t.ctx);
    return /** @type {AccessConfig} */ (t.config.access);
  };

  const back = await plan(['existing', 'Copilot Leads', 'leads@contoso.com', ''], {
    groupId: 'g-8',
    groupName: 'Copilot Pilots',
    grantedModels: [],
    retiredGroups: [{ groupId: 'G-9', groupName: 'Copilot Leads', datasets: ['ds-vl'] }],
  });
  assert.equal(back.groupId, 'g-9');
  assert.equal(back.retiredGroups, undefined, 'and the group it left had no Build from the installer');

  const named = await plan(['new', 'admin@contoso.com', ''], { groupId: 'g-7', groupName: VIEWER_GROUP_NAME.toUpperCase(), createdGroup: false, grantedModels: ['ds-vl'] });
  assert.equal(named.groupId, undefined, 'the install looks the group up by name');
  assert.equal(named.retiredGroups, undefined);
  assert.deepEqual(named.grantedModels, ['ds-vl']);

  // A group still listed from an earlier switch, as when the install stopped before taking its Build away.
  const again = await plan(['existing', 'Copilot Leads', 'leads@contoso.com', ''], {
    groupId: 'g-1',
    groupName: VIEWER_GROUP_NAME,
    createdGroup: true,
    grantedModels: ['ds-cc'],
    retiredGroups: [{ groupId: 'g-1', datasets: ['ds-vl'] }, { groupId: 'g-2', datasets: ['ds-x'] }],
  });
  assert.deepEqual(again.retiredGroups, [{ groupId: 'g-2', datasets: ['ds-x'] }, { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, datasets: ['ds-vl', 'ds-cc'] }]);
});

test('access: taking Build from old viewer groups skips what is already gone, and keeps what failed for next time', async () => {
  const dir = directory();
  dir.groups.set('g-5', { id: 'g-5', displayName: 'Old D', members: [], owners: [] });
  const pbi = datasets();
  pbi.users['ds-vl'] = [build('g-1'), build('g-2'), build('g-4')];
  pbi.users['ds-cc'] = [build('g-1'), build('g-5'), build('g-6')];
  pbi.removeErrors['ds-vl g-4'] = httpError(404);
  pbi.removeErrors['ds-cc g-5'] = httpError(500, 'Server error');
  pbi.removeErrors['ds-cc g-6'] = httpError(400, 'Bad request');
  const { ui, text } = fakeUi();
  const { ctx } = fakeCtx({ graph: dir.graph, powerBi: pbi.powerBi, ui });
  /** @type {AccessConfig} */
  const a = {
    groupId: 'g-1',
    groupName: VIEWER_GROUP_NAME,
    retiredGroups: [
      { groupId: 'G-1', datasets: ['ds-vl'] }, // the viewer group again, as the new-group step found it by name
      { groupId: 'g-2', groupName: 'Old A', datasets: ['ds-vl', 'ds-gone'] },
      { groupId: 'g-3', groupName: 'Old B', datasets: ['ds-cc'] }, // someone took it off already
      { groupId: 'g-4', datasets: ['ds-vl'] },
      { groupId: 'g-5', groupName: 'Old D', datasets: ['ds-cc'] },
      { groupId: 'g-6', groupName: 'Deleted', datasets: ['ds-cc'] },
    ],
  };
  ctx.config.access = a;
  assert.deepEqual(
    accessReview(ctx.config, 'X').grants.map((g) => g.who),
    [`${VIEWER_GROUP_NAME} (group)`, 'Old A (group)', 'Old B (group)', 'g-4 (group)', 'Old D (group)', 'Deleted (group)'],
  );
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-vl g-2 Group None']);
  assert.match(text(), /✓ Old A no longer has Build on ValueLens\n/);
  assert.match(text(), /! Couldn't take away Old D's Build on Credits: Server error\n/);
  assert.match(text(), /Remove Old D from the model's Manage permissions page, or the installer tries again next time\./);
  assert.doesNotMatch(text(), /Old B|g-4|Deleted|G-1/);
  assert.deepEqual(a.retiredGroups, [{ groupId: 'g-5', groupName: 'Old D', datasets: ['ds-cc'] }]);
  assert.ok(pbi.users['ds-vl'].some((u) => u.identifier === 'g-1'), 'the viewer group keeps its Build');

  // Next time it works, though Power BI won't list the model's users.
  delete pbi.removeErrors['ds-cc g-5'];
  pbi.unreadable.add('ds-cc');
  pbi.calls.length = 0;
  await grantModelAccess(ctx, MODELS);
  assert.deepEqual(pbi.calls, ['ws-1/ds-cc g-1 Group ReadExplore', 'ws-1/ds-cc g-5 Group None']);
  assert.equal(a.retiredGroups, undefined);

  // With no model deployed, nothing is taken away or forgotten.
  a.retiredGroups = [{ groupId: 'g-7', datasets: ['ds-vl'] }];
  pbi.calls.length = 0;
  await grantModelAccess(ctx, []);
  assert.deepEqual(pbi.calls, []);
  assert.deepEqual(a.retiredGroups, [{ groupId: 'g-7', datasets: ['ds-vl'] }]);
});

test('access: the menu offers to share the report until it is shared', async () => {
  const dir = directory();
  dir.groups.set('g-1', { id: 'g-1', displayName: VIEWER_GROUP_NAME, members: [], owners: ['user-1'] });
  const t = fakeUi({ answers: ['share', true, 'done'] });
  /** @type {string[][]} */
  const menus = [];
  const select = t.ui.select;
  t.ui.select = /** @type {any} */ (
    async (/** @type {string} */ message, /** @type {{ name: string, value: any }[]} */ choices, /** @type {any} */ def) => {
      if (message === 'What next?') menus.push(choices.map((ch) => String(ch.value)));
      return select(message, choices, def);
    }
  );
  const { ctx, saves } = fakeCtx({ graph: dir.graph, powerBi: datasets().powerBi, ui: t.ui });
  ctx.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  publish(ctx.config);
  await accessCommand(ctx, MODELS);
  assert.deepEqual(t.asked, ['What next?', 'Have you shared the report?', 'What next?']);
  assert.ok(menus[0].includes('share'));
  assert.ok(!menus[1].includes('share'), 'not offered once shared');
  assert.equal(ctx.config.access.reportShared, true);
  assert.ok(saves() >= 2);

  const unpublished = fakeUi({ answers: ['done'] });
  /** @type {string[]} */
  let offered = [];
  const pick = unpublished.ui.select;
  unpublished.ui.select = /** @type {any} */ (
    async (/** @type {string} */ message, /** @type {{ name: string, value: any }[]} */ choices, /** @type {any} */ def) => {
      offered = choices.map((ch) => String(ch.value));
      return pick(message, choices, def);
    }
  );
  const { ctx: none } = fakeCtx({ graph: dir.graph, powerBi: datasets().powerBi, ui: unpublished.ui });
  none.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME };
  await accessCommand(none, MODELS);
  assert.ok(!offered.includes('share'), 'nothing to share before the report is published');
});

test('access: the viewer group never gets a workspace role; only the app\'s service principal does', () => {
  // Workspace Viewers can read notebook code, and with no Key Vault the notebooks hold the app's client secret.
  const src = new URL('../src/', import.meta.url);
  /** @type {string[]} */
  const callers = [];
  for (const rel of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith('.js')) continue;
    const text = readFileSync(new URL(rel.replaceAll('\\', '/'), src), 'utf8');
    for (const m of text.matchAll(/\.(?:add|update)RoleAssignment\(([^)]*)\)/g)) callers.push(`${rel.replaceAll('\\', '/')}: ${m[1]}`);
  }
  assert.deepEqual(callers, ['steps/model.js: ws, mine.id, role', "steps/model.js: ws, spId, 'ServicePrincipal', role"]);
});
