// @ts-check
/**
 * Creating the viewer group as an Entra admin and as a user who isn't one. Entra makes a user who isn't an admin an
 * owner of a security group they create, and Graph refuses a request that names them as owner too, with 400 "Request
 * contains a property with duplicate values". It doesn't make an admin an owner, so their request still names them.
 * These run the real Graph client against a fake Graph that behaves that way.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphApi } from '../src/clients/graph.js';
import { createClient, HttpError } from '../src/http.js';
import { accessCommand, accessReview, ensureViewerGroup, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { installAzure } from '../src/steps/azure/index.js';
import { orgAccessCommand } from '../src/steps/org-access.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi } from './fakes.js';

/** The signed-in user, as fakeCtx has them. */
const ME = { id: 'user-1', upn: 'admin@contoso.com' };
const OWNER = `https://graph.microsoft.com/v1.0/users/${ME.id}`;

/** The group the installer asks Graph for, without its owner. */
const GROUP = {
  displayName: VIEWER_GROUP_NAME,
  description: 'People who can view Analytics Hub. Add members to share it.',
  mailEnabled: false,
  mailNickname: 'analytics-hub-viewers',
  securityEnabled: true,
};

/** Graph's answer when a user who isn't an admin names themselves as an owner of the group they create. */
const DUPLICATE = {
  error: {
    code: 'Request_BadRequest',
    message: 'Request contains a property with duplicate values.',
    innerError: { date: '2026-06-01T12:00:00', 'request-id': 'req-1', 'client-request-id': 'req-1' },
  },
};

const who = (/** @type {boolean} */ admin) => (admin ? 'an Entra admin' : "a user who isn't an Entra admin");

/**
 * Microsoft Graph's groups as the signed-in user sees them, behind a fake fetch, with the real Graph client on top.
 * Like Entra, it makes a user who isn't an admin an owner of a security group they create, and refuses a create that
 * names them as owner too. It makes an admin an owner only when the create names them.
 * @param {{ admin: boolean, failCreate?: { status: number, body: any } }} o  `failCreate`: every create gets this answer.
 */
function tenant(o) {
  /** @type {Map<string, { id: string, displayName: string, owners: string[], members: string[] }>} */
  const groups = new Map();
  /** The body of each create Graph was sent. @type {any[]} */
  const creates = [];
  const reply = (/** @type {number} */ status, /** @type {any} */ body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const user = (/** @type {string} */ id) => ({ '@odata.type': '#microsoft.graph.user', id, userPrincipalName: id === ME.id ? ME.upn : `${id}@contoso.com` });
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ input, /** @type {any} */ init) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/v1\.0/, '');
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path === '/groups') {
          const name = /^displayName eq '(.*)'$/.exec(url.searchParams.get('$filter') ?? '')?.[1]?.replace(/''/g, "'");
          return reply(200, { value: [...groups.values()].filter((g) => g.displayName === name).map((g) => ({ id: g.id, displayName: g.displayName, securityEnabled: true })) });
        }
        if (method === 'POST' && path === '/groups') {
          const body = JSON.parse(init.body);
          creates.push(body);
          if (o.failCreate) return reply(o.failCreate.status, o.failCreate.body);
          const named = (body['owners@odata.bind'] ?? []).map((/** @type {string} */ ref) => ref.split('/').pop());
          if (!o.admin && named.includes(ME.id)) return reply(400, DUPLICATE);
          const g = { id: `g-${groups.size + 1}`, displayName: body.displayName, owners: o.admin ? named : [...new Set([...named, ME.id])], members: [] };
          groups.set(g.id, g);
          return reply(201, { id: g.id, displayName: g.displayName, securityEnabled: true });
        }
        const [, id, part] = /^\/groups\/([^/]+)(?:\/(owners|members|transitiveMembers))?$/.exec(path) ?? [];
        if (method === 'GET' && id) {
          const g = groups.get(decodeURIComponent(id));
          if (!g) return reply(404, { error: { code: 'Request_ResourceNotFound', message: `Resource '${id}' does not exist.` } });
          if (!part) return reply(200, { id: g.id, displayName: g.displayName, securityEnabled: true });
          return reply(200, { value: (part === 'owners' ? g.owners : g.members).map(user) });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
    )
  );
  const graph = graphApi(createClient({ baseUrl: 'https://graph.microsoft.com/v1.0', getToken: async () => 'token', fetchImpl, sleep: async () => {} }));
  return { graph, groups, creates };
}

test('an Entra admin keeps "A new group": one create, naming them as owner, as before', async () => {
  const t = tenant({ admin: true });
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ graph: t.graph, ui });
  config.access = { groupName: VIEWER_GROUP_NAME, contact: ME.upn };

  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');

  assert.deepEqual(t.creates, [{ ...GROUP, 'owners@odata.bind': [OWNER] }]);
  assert.deepEqual(t.groups.get('g-1')?.owners, [ME.id]);
  assert.equal(config.access.groupId, 'g-1');
  assert.equal(config.access.createdGroup, true);
  assert.match(text(), /Created the group "Analytics Hub Viewers", with you as owner/);
});

test(`${who(false)} keeps "A new group": Graph's duplicate-values 400 is sent again without naming them, and they own the group`, async () => {
  const t = tenant({ admin: false });
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ graph: t.graph, ui });
  config.access = { groupName: VIEWER_GROUP_NAME, contact: ME.upn };

  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');

  assert.deepEqual(t.creates, [{ ...GROUP, 'owners@odata.bind': [OWNER] }, GROUP], 'the same group, leaving out the owner Entra adds');
  assert.equal(t.groups.size, 1);
  assert.deepEqual(t.groups.get('g-1')?.owners, [ME.id]);
  assert.equal(config.access.groupId, 'g-1');
  assert.equal(config.access.createdGroup, true);
  assert.match(text(), /Created the group "Analytics Hub Viewers", with you as owner/);
  assert.doesNotMatch(text(), /duplicate values|Couldn't create/);

  assert.equal((await ensureViewerGroup(ctx))?.id, 'g-1');
  assert.equal(t.creates.length, 2, 'reused, not created again');
});

test('another failure to create the group is not sent again, and warns with what to do instead of stopping', async () => {
  const invalid = { error: { code: 'Request_BadRequest', message: "Invalid value specified for property 'mailNickname' of resource 'Group'." } };
  const t = tenant({ admin: false, failCreate: { status: 400, body: invalid } });
  await assert.rejects(
    t.graph.createSecurityGroup({ displayName: VIEWER_GROUP_NAME, description: GROUP.description, ownerId: ME.id }),
    (/** @type {any} */ err) => err instanceof HttpError && err.status === 400 && /mailNickname/.test(err.message),
  );
  assert.equal(t.creates.length, 1, 'only the duplicate-values 400 is sent again');

  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ graph: t.graph, ui });
  config.access = { groupName: VIEWER_GROUP_NAME };
  assert.equal(await ensureViewerGroup(ctx), null);
  assert.equal(config.access.groupId, undefined);
  assert.match(text(), /Couldn't create the group "Analytics Hub Viewers", so there's no viewer group yet: .*mailNickname/);
  assert.match(text(), /Run "access" and choose "A group I already have" to use a security group you own, or ask an Entra admin for one/);
});

test('a create that fails without an answer from Graph still stops', async () => {
  const graph = {
    findGroupByName: async () => null,
    createSecurityGroup: async () => {
      throw new Error('POST https://graph.microsoft.com/v1.0/groups failed: fetch failed');
    },
  };
  const { ctx, config } = fakeCtx({ graph });
  config.access = { groupName: VIEWER_GROUP_NAME };
  await assert.rejects(ensureViewerGroup(ctx), /fetch failed/);
});

/**
 * An Azure setup against fakes, as azure.test.js's webAppInstall runs one, with the viewer group still to create:
 * the user kept "A new group".
 * @param {{ admin: boolean }} o
 */
async function azureSetup(o) {
  const t = tenant(o);
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const { getGroup, findGroupByName, createSecurityGroup, groupMembers, groupOwners, groupUsers } = t.graph;
  Object.assign(graph.api, { getGroup, findGroupByName, createSecurityGroup, groupMembers, groupOwners, groupUsers });
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  /** @type {string[]} */
  const grants = [];
  Object.assign(powerBi.api, {
    datasetUsers: async () => [],
    addDatasetUser: async (/** @type {string} */ _ws, /** @type {string} */ ds, /** @type {any} */ body) => {
      grants.push(`${ds} ${body.identifier}`);
      return null;
    },
  });
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
    access: { groupName: VIEWER_GROUP_NAME, contact: ME.upn },
  });
  ctx.runFirstLoad = false;
  const ok = await installAzure(ctx, { wait: true });
  return { ok, t, config, grants, text: ui.text };
}

for (const admin of [true, false]) {
  test(`Azure setup, as ${who(admin)}: the viewer group is created with them as owner, and setup carries on`, async () => {
    const s = await azureSetup({ admin });
    assert.equal(s.ok, true);
    assert.equal(s.t.creates.length, admin ? 1 : 2);
    assert.deepEqual([...s.t.groups.values()].map((g) => g.owners), [[ME.id]]);
    assert.equal(s.config.access?.groupId, 'g-1');
    assert.equal(s.config.access?.createdGroup, true);
    assert.ok(s.grants.length && s.grants.every((g) => g.endsWith(' g-1')), 'the group gets Build on the models');
    assert.match(s.text(), /Created the group "Analytics Hub Viewers", with you as owner/);
  });

  test(`access, as ${who(admin)}: keeping "A new group" creates it with them as owner, then shows it`, async () => {
    const t = tenant({ admin });
    const { ui, text, asked } = fakeUi();
    const { ctx, config } = fakeCtx({ graph: t.graph, ui });

    await accessCommand(ctx, [], undefined);

    assert.equal(asked[0], 'Who can view Analytics Hub?', 'kept the default, "A new group"');
    assert.equal(t.creates.length, admin ? 1 : 2);
    assert.deepEqual(t.groups.get('g-1')?.owners, [ME.id]);
    assert.equal(config.access?.groupId, 'g-1');
    assert.equal(config.access?.createdGroup, true);
    assert.match(text(), /Created the group "Analytics Hub Viewers", with you as owner/);
    assert.match(text(), /0 members; owners: admin@contoso\.com/);
    assert.ok(asked.includes('What next?'), 'carries on to the menu');
  });

  test(`turning on org-scoped access, as ${who(admin)}: the viewer group is created with them as owner, and it carries on`, async () => {
    const t = tenant({ admin });
    /** @type {Map<string, string>} */
    const lake = new Map();
    const oneLake = {
      readText: async (/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path) => lake.get(path) ?? null,
      writeFile: async (/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path, /** @type {Uint8Array} */ bytes) => {
        lake.set(path, new TextDecoder().decode(bytes));
      },
    };
    const ui = fakeUi();
    ui.ui.confirm = async () => true;
    const { ctx, config } = fakeCtx({ fabric: fakeFabric().api, oneLake, powerBi: fakePowerBi().api, graph: t.graph, ui: ui.ui });
    config.semanticModel.enabled = true;
    config.semanticModel.id = 'ds-vl';
    config.semanticModel.bound = true;
    config.access = { groupName: VIEWER_GROUP_NAME, contact: ME.upn };
    let redeployed = 0;

    await orgAccessCommand(ctx, async () => {
      redeployed++;
    });

    assert.equal(t.creates.length, admin ? 1 : 2);
    assert.deepEqual(t.groups.get('g-1')?.owners, [ME.id]);
    assert.equal(config.access?.groupId, 'g-1');
    assert.match(ui.text(), /Created the group "Analytics Hub Viewers", with you as owner/);
    assert.equal(config.access?.rls?.enabled, true);
    assert.equal(redeployed, 1);
  });
}

test('the plan says you own the viewer group only when the installer creates it', () => {
  const { config } = fakeCtx();
  const detail = () => accessReview(config, 'Semantic models in workspace X').creates[0].detail;
  config.access = { groupName: VIEWER_GROUP_NAME };
  assert.match(detail(), /You are its owner/);
  config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, createdGroup: true };
  assert.match(detail(), /You are its owner/);
  config.access = { groupId: 'g-9', groupName: 'Copilot Leads', createdGroup: false };
  assert.doesNotMatch(detail(), /You are its owner/);
  assert.match(detail(), /Its owners share it by adding people to it/);
});
