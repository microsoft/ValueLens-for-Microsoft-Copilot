import test from 'node:test';
import assert from 'node:assert/strict';
import { authHeader, fakeVerifyToken, request, startTestServer } from './helpers.js';
import { MemoryScopeStore, SqlScopeStore } from '../src/scope-store.js';
import { AccessRefresher } from '../src/refresh.js';
import { delegationId } from '../src/delegations.js';
import { loadConfig, parseAccess } from '../src/config.js';

const ACCESS = { groupId: 'group-1', groupName: 'Analytics Hub viewers', rlsOrgAttribute: 'department' };
const PEOPLE = {
  leader: 'leader@example.com', outsider: 'outsider@example.com', orglead: 'orglead@example.com', owner: 'owner@example.com'
};

async function verifyToken(token) {
  if (PEOPLE[token]) return { scp: 'access_as_user', oid: `${token}-1`, preferred_username: PEOPLE[token], groups: ['group-1'] };
  return fakeVerifyToken(token);
}

function seedStore() {
  return new MemoryScopeStore({
    rows: [
      { UserPrincipalName: '*', ScopeType: 'hierarchy', ScopeValue: '', CanDelegate: false, GrantedVia: 'installer', Status: 'active' },
      { UserPrincipalName: 'leader@example.com', ScopeType: 'hierarchy', ScopeValue: 'boss@example.com', CanDelegate: true, GrantedVia: 'installer', Status: 'active' },
      { UserPrincipalName: 'owner@example.com', ScopeType: 'all', ScopeValue: '', CanDelegate: true, GrantedVia: 'installer', Status: 'active' },
      { UserPrincipalName: 'outsider@example.com', ScopeType: 'hierarchy', ScopeValue: 'other@example.com', CanDelegate: true, GrantedVia: 'installer', Status: 'active' },
      { UserPrincipalName: 'orglead@example.com', ScopeType: 'org', ScopeValue: 'Sales', CanDelegate: true, GrantedVia: 'installer', Status: 'active' },
      { UserPrincipalName: 'viewer@example.com', ScopeType: 'hierarchy', ScopeValue: 'viewer@example.com', CanDelegate: false, GrantedVia: 'installer', Status: 'active' }
    ],
    paths: {
      'leader@example.com': 'ceo@example.com|boss@example.com|leader@example.com',
      'outsider@example.com': 'ceo@example.com|boss@example.com|outsider@example.com',
      'orglead@example.com': 'ceo@example.com|orglead@example.com'
    }
  });
}

/** Graph and Power BI as the tests need them. Only admins and the group owner can add members. */
function fakeCloud({ refreshStatus = 202 } = {}) {
  const calls = [];
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); const { hostname, pathname } = new URL(u); const caller = String(init.headers?.Authorization || '').replace('Bearer graph-', '');
    calls.push({ url: u, hostname, method: init.method || 'GET', caller, body: init.body ? JSON.parse(init.body) : undefined });
    if (hostname === 'api.powerbi.com') return json(refreshStatus, refreshStatus === 202 ? undefined : { error: { code: 'x', message: refreshStatus === 409 ? 'A refresh is in progress' : 'nope' } });
    const user = /\/users\/([^?]+)\?/.exec(u);
    if (user) {
      const upn = decodeURIComponent(user[1]);
      return upn.startsWith('ghost') ? json(404, { error: { message: 'not found' } }) : json(200, { id: `id-${upn}`, userPrincipalName: upn, displayName: upn });
    }
    if (pathname.endsWith('/groups/group-1/members/$ref')) return caller === 'admin' || caller === 'owner' ? json(204) : json(403, { error: { message: 'Insufficient privileges' } });
    if (pathname.endsWith('/checkMemberGroups')) return json(200, { value: pathname.includes('already') ? ['group-1'] : [] });
    return json(404, { error: { message: `unexpected ${u}` } });
  };
  return { calls, fetchImpl };
}

async function setup({ access = ACCESS, store = seedStore(), cloud = fakeCloud() } = {}) {
  const { server, baseUrl } = await startTestServer({
    config: { access }, verifyToken, scopeStore: store, fetchImpl: cloud.fetchImpl,
    tokenAcquirer: async (token) => `graph-${token}`, setTimer: () => ({ unref() {} })
  });
  const call = async (token, method, path, body) => {
    const res = await request(baseUrl, path, { method, headers: { ...authHeader(token), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, call, store, cloud };
}

const refreshes = (cloud) => cloud.calls.filter((c) => c.hostname === 'api.powerbi.com');

test('delegation is off without org-scoped access', async () => {
  const { server, call } = await setup({ access: { groupId: 'group-1' } });
  try {
    assert.deepEqual((await call('admin', 'GET', '/api/delegations')).body, { enabled: false });
    const add = await call('admin', 'POST', '/api/delegations', { upn: 'a@example.com', scope: { type: 'org', value: 'Sales' } });
    assert.equal(add.status, 404);
    assert.equal(add.body.error.code, 'DelegationOff');
  } finally { server.close(); }
});

test('delegation is off without the database', async () => {
  const { server, call } = await setup({ store: null });
  try { assert.deepEqual((await call('admin', 'GET', '/api/delegations')).body, { enabled: false }); } finally { server.close(); }
});

test('who can delegate: admins, and leaders whose org sits inside a scope they can share', async () => {
  const { server, call } = await setup();
  try {
    const admin = (await call('admin', 'GET', '/api/delegations')).body;
    assert.equal(admin.enabled, true);
    assert.equal(admin.orgAttribute, 'department');
    assert.deepEqual([admin.me.isAdmin, admin.me.canDelegate], [true, true]);
    const leader = (await call('leader', 'GET', '/api/delegations')).body;
    assert.deepEqual([leader.me.isAdmin, leader.me.canDelegate], [false, true]);
    assert.deepEqual(leader.me.scopes, [{ type: 'hierarchy', value: 'boss@example.com', canDelegate: true }]);
    assert.equal((await call('owner', 'GET', '/api/delegations')).body.me.canDelegate, true, 'an everyone scope with can share');
    assert.equal((await call('outsider', 'GET', '/api/delegations')).body.me.canDelegate, false, 'their scope is someone else\'s org');
    assert.equal((await call('orglead', 'GET', '/api/delegations')).body.me.canDelegate, false, 'org scopes do not cover their reports');
    const viewer = (await call('group', 'GET', '/api/delegations')).body;
    assert.equal(viewer.me.canDelegate, false);
    assert.deepEqual([viewer.delegations, viewer.pending], [[], []]);
  } finally { server.close(); }
});

test('a leader shares their org; it waits for an admin when they cannot add to the viewer group', async () => {
  const cloud = fakeCloud();
  const { server, call, store } = await setup({ cloud });
  try {
    const add = await call('leader', 'POST', '/api/delegations', { upn: 'Report@Example.com', scope: { type: 'hierarchy' }, note: 'Covering while I am out' });
    assert.equal(add.status, 201);
    assert.equal(add.body.delegation.status, 'pending_group');
    assert.deepEqual(add.body.delegation.scope, { type: 'hierarchy', value: 'leader@example.com' });
    assert.equal(add.body.refresh, undefined, 'nothing to refresh until it is active');
    const row = await store.get({ UserPrincipalName: 'report@example.com', ScopeType: 'hierarchy', ScopeValue: 'leader@example.com' });
    assert.deepEqual([row.GrantedBy, row.GrantedVia, row.Status, row.CanDelegate, row.Note], ['leader@example.com', 'share', 'pending_group', false, 'Covering while I am out']);
    assert.equal(refreshes(cloud).length, 0);

    const mine = (await call('leader', 'GET', '/api/delegations')).body;
    assert.deepEqual(mine.delegations.map((d) => [d.upn, d.status]), [['report@example.com', 'pending_group']]);
    const admin = (await call('admin', 'GET', '/api/delegations')).body;
    assert.deepEqual(admin.pending.map((d) => d.upn), ['report@example.com']);
    assert.deepEqual(admin.delegations, []);

    const approved = await call('admin', 'POST', `/api/delegations/${add.body.delegation.id}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.delegation.status, 'active');
    assert.equal(approved.body.refresh.status, 'started');
    assert.equal((await store.get(row)).Status, 'active');
    const [refresh] = refreshes(cloud);
    assert.match(refresh.url, /groups\/workspace-1\/datasets\/dataset-1\/refreshes$/);
    assert.deepEqual(refresh.body.objects, [{ table: 'Access Scope' }]);
    assert.equal((await call('admin', 'POST', `/api/delegations/${add.body.delegation.id}/approve`)).status, 409);
  } finally { server.close(); }
});

test('someone already in the viewer group is active straight away', async () => {
  const { server, call } = await setup();
  try {
    const add = await call('leader', 'POST', '/api/delegations', { upn: 'already@example.com', scope: { type: 'hierarchy', value: 'leader@example.com' } });
    assert.equal(add.body.delegation.status, 'active');
    assert.equal(add.body.refresh.status, 'started');
  } finally { server.close(); }
});

test('a group owner with can share adds people to the viewer group themselves', async () => {
  const cloud = fakeCloud();
  const { server, call } = await setup({ cloud });
  try {
    const add = await call('owner', 'POST', '/api/delegations', { upn: 'new@example.com', scope: { type: 'hierarchy' } });
    assert.equal(add.body.delegation.status, 'active');
    assert.ok(cloud.calls.some((c) => c.url.endsWith('/members/$ref') && c.caller === 'owner' && c.body['@odata.id'].endsWith('/id-new@example.com')));
  } finally { server.close(); }
});

test('leaders can only share their own org, without passing on can share', async () => {
  const { server, call } = await setup();
  try {
    const cases = [
      [{ upn: 'r@example.com', scope: { type: 'all' } }, 400, 'InvalidScope'],
      [{ upn: 'r@example.com', scope: { type: 'org', value: 'Sales' } }, 403, 'CannotDelegate'],
      [{ upn: 'r@example.com', scope: { type: 'hierarchy', value: 'boss@example.com' } }, 403, 'CannotDelegate'],
      [{ upn: 'r@example.com', scope: { type: 'hierarchy' }, canDelegate: true }, 403, 'CannotDelegate'],
      [{ upn: 'leader@example.com', scope: { type: 'hierarchy' } }, 400, 'InvalidPerson'],
      [{ upn: 'not-an-email', scope: { type: 'hierarchy' } }, 400, 'InvalidPerson'],
      [{ upn: 'r@example.com', scope: { type: 'hierarchy' }, note: 'x'.repeat(401) }, 400, 'InvalidNote']
    ];
    for (const [body, status, code] of cases) {
      const res = await call('leader', 'POST', '/api/delegations', body);
      assert.deepEqual([res.status, res.body.error.code], [status, code], JSON.stringify(body));
    }
    const outsider = await call('outsider', 'POST', '/api/delegations', { upn: 'r@example.com', scope: { type: 'hierarchy' } });
    assert.equal(outsider.status, 403);
    assert.equal((await call('group', 'POST', '/api/delegations', { upn: 'r@example.com', scope: { type: 'hierarchy' } })).status, 403);
  } finally { server.close(); }
});

test('admins give an org or the people below anyone, and can let them share', async () => {
  const { server, call, store } = await setup();
  try {
    const org = await call('admin', 'POST', '/api/delegations', { upn: 'hr@example.com', scope: { type: 'org', value: 'Human Resources' }, canDelegate: true });
    assert.equal(org.status, 201);
    assert.deepEqual([org.body.delegation.status, org.body.delegation.canDelegate], ['active', true]);
    const below = await call('admin', 'POST', '/api/delegations', { upn: 'hr@example.com', scope: { type: 'hierarchy', value: 'Boss@Example.com' } });
    assert.deepEqual(below.body.delegation.scope, { type: 'hierarchy', value: 'boss@example.com' });
    assert.equal((await call('admin', 'POST', '/api/delegations', { upn: 'hr@example.com', scope: { type: 'org', value: 'Human Resources' } })).status, 409);
    assert.equal((await call('admin', 'POST', '/api/delegations', { upn: 'hr@example.com', scope: { type: 'hierarchy', value: 'nobody' } })).status, 400);
    assert.equal((await call('admin', 'POST', '/api/delegations', { upn: 'ghost@example.com', scope: { type: 'org', value: 'Sales' } })).status, 404);
    assert.equal((await store.list()).filter((r) => r.GrantedVia === 'share').length, 2);
    const listed = (await call('admin', 'GET', '/api/delegations')).body.delegations;
    assert.equal(listed.length, 2);
    assert.ok(listed.every((d) => d.grantedBy === 'admin@example.com'));
  } finally { server.close(); }
});

test('taking scopes back: leaders their own, admins any shared one, nobody the installer\'s', async () => {
  const { server, call, store } = await setup();
  try {
    const byAdmin = (await call('admin', 'POST', '/api/delegations', { upn: 'a@example.com', scope: { type: 'org', value: 'Sales' } })).body.delegation;
    const byLeader = (await call('leader', 'POST', '/api/delegations', { upn: 'already@example.com', scope: { type: 'hierarchy' } })).body.delegation;
    assert.equal((await call('leader', 'DELETE', `/api/delegations/${byAdmin.id}`)).body.error.code, 'NotYourDelegation');
    const installer = delegationId({ UserPrincipalName: 'leader@example.com', ScopeType: 'hierarchy', ScopeValue: 'boss@example.com' });
    assert.equal((await call('admin', 'DELETE', `/api/delegations/${installer}`)).body.error.code, 'InstallerScope');
    const removed = await call('leader', 'DELETE', `/api/delegations/${byLeader.id}`);
    assert.equal(removed.status, 200);
    assert.ok(removed.body.refresh);
    assert.equal((await call('admin', 'DELETE', `/api/delegations/${byAdmin.id}`)).status, 200);
    assert.equal((await call('admin', 'DELETE', `/api/delegations/${byAdmin.id}`)).status, 404);
    assert.equal((await call('admin', 'DELETE', '/api/delegations/not-an-id')).status, 400);
    assert.equal((await store.list()).filter((r) => r.GrantedVia === 'share').length, 0);
  } finally { server.close(); }
});

test('only admins approve', async () => {
  const { server, call } = await setup();
  try {
    const pending = (await call('leader', 'POST', '/api/delegations', { upn: 'r@example.com', scope: { type: 'hierarchy' } })).body.delegation;
    assert.equal((await call('leader', 'POST', `/api/delegations/${pending.id}/approve`)).status, 403);
    assert.equal((await call('owner', 'POST', `/api/delegations/${pending.id}/approve`)).status, 403);
  } finally { server.close(); }
});

test('the refresher shares one refresh between changes close together', async () => {
  let time = 0; const timers = []; const posts = [];
  let status = 202;
  const refresher = new AccessRefresher({
    models: { vl: { workspaceId: 'w', itemId: 'd' }, other: { workspaceId: 'w', itemId: 'd' } },
    getToken: async () => 'app-token', now: () => time, minGapMs: 1000, maxRetries: 2,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    fetchImpl: async (url, init) => { posts.push(JSON.parse(init.body)); return new Response(status === 409 ? 'A refresh is in progress' : status === 202 ? null : 'Refresh limit reached', { status }); }
  });
  assert.equal((await refresher.request()).status, 'started');
  assert.equal(posts.length, 1, 'the same model listed twice refreshes once');
  time = 500;
  assert.equal((await refresher.request()).status, 'queued');
  assert.equal((await refresher.request()).status, 'queued');
  assert.equal(timers.length, 1, 'only one waits');
  assert.equal(timers[0].ms, 500);
  time = 1500; status = 409;
  timers.shift().fn(); await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 2);
  assert.equal(timers.length, 1, 'busy: tries again later');
  time = 2500; status = 400;
  timers.shift().fn(); await new Promise((r) => setImmediate(r));
  assert.equal(refresher.last.status, 'unavailable');
  assert.equal(timers.length, 0);
});

test('the refresher says when Power BI will not take a refresh', async () => {
  const refresher = new AccessRefresher({ models: { vl: { workspaceId: 'w', itemId: 'd' } }, getToken: async () => 't', fetchImpl: async () => new Response('limit', { status: 400 }) });
  assert.equal((await refresher.request()).status, 'unavailable');
  assert.equal((await new AccessRefresher({ models: {}, getToken: async () => 't' }).request()).status, 'unavailable');
});

test('config: the org attribute and the database', () => {
  assert.equal(parseAccess(JSON.stringify({ groupId: 'g', rlsOrgAttribute: 'department' })).rlsOrgAttribute, 'department');
  assert.equal(parseAccess(JSON.stringify({ groupId: 'g' })).rlsOrgAttribute, undefined);
  const config = loadConfig({ VALUELENS_SQL_SERVER: 'sql.example.net', VALUELENS_SQL_DATABASE: 'valuelens' });
  assert.deepEqual([config.sqlServer, config.sqlDatabase], ['sql.example.net', 'valuelens']);
});

test('the SQL store keys rows by person and scope, and explains missing tables', async () => {
  const seen = [];
  let fail = null;
  class ConnectionPool {
    constructor(options) { seen.push({ options }); }
    async connect() {}
    on() {}
    request() {
      const inputs = {};
      return {
        input: (name, value) => { inputs[name] = value; },
        query: async (text) => {
          seen.push({ text, inputs });
          if (fail) { const e = new Error('x'); e.number = fail; throw e; }
          if (text.includes('access_people')) return { recordset: [{ OrgPath: 'CEO@example.com|Leader@example.com' }] };
          return { recordset: [{ UserPrincipalName: 'A@example.com', ScopeType: 'HIERARCHY', ScopeValue: 'b@example.com', CanDelegate: true, GrantedBy: null, GrantedVia: 'share', Status: 'active', Note: null, CreatedAt: new Date('2025-01-02T03:04:05Z') }] };
        }
      };
    }
  }
  const store = new SqlScopeStore({ server: 'sql.example.net', database: 'db', sqlModule: { ConnectionPool }, credential: {} });
  const [row] = await store.list();
  assert.deepEqual([row.UserPrincipalName, row.ScopeType, row.CanDelegate, row.CreatedAt], ['a@example.com', 'hierarchy', true, '2025-01-02T03:04:05']);
  assert.equal(seen[0].options.authentication.type, 'token-credential');
  assert.equal(await store.orgPath('leader@example.com'), 'ceo@example.com|leader@example.com');
  await store.insert({ ...row, Note: 'hi' });
  const insert = seen.find((s) => s.text?.startsWith('INSERT'));
  assert.deepEqual([insert.inputs.upn, insert.inputs.type, insert.inputs.value, insert.inputs.canDelegate, insert.inputs.grantedVia], ['a@example.com', 'hierarchy', 'b@example.com', 1, 'share']);
  assert.equal(insert.inputs.createdAt.toISOString(), '2025-01-02T03:04:05.000Z');
  fail = 2627; await assert.rejects(store.insert(row), (e) => e.statusCode === 409);
  fail = 208; await assert.rejects(store.list(), (e) => e.statusCode === 503 && e.code === 'AccessTablesMissing');
});