// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataverseApi, depthName } from '../src/clients/dataverse.js';
import { HttpError } from '../src/http.js';

/**
 * A Dataverse Web API client whose requests are recorded.
 * @param {Record<string, any>} [answers]  What a GET returns, by path; a request's response, by "METHOD path".
 */
function recorded(answers = {}) {
  /** @type {{ method: string, path: string, opts: any }[]} */
  const requests = [];
  const http = {
    request: async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ opts) => (
      requests.push({ method, path, opts }), answers[`${method} ${path}`] ?? { status: 204, headers: new Headers(), data: null }
    ),
    get: async (/** @type {string} */ path, /** @type {any} */ opts) => (requests.push({ method: 'GET', path, opts }), answers[path]),
  };
  return { dv: dataverseApi(/** @type {any} */ (http), 'https://env.example.com/'), requests };
}

test('Dataverse: taking a role back, and deactivating, activating and deleting an application user', async () => {
  const { dv, requests } = recorded();
  await dv.removeRole('user-1', 'role-1');
  await dv.disableUser('user-1');
  await dv.enableUser('user-1');
  await dv.deleteUser('user-1');
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
    'DELETE /systemusers(user-1)/systemuserroles_association(role-1)/$ref',
    'PATCH /systemusers(user-1)',
    'PATCH /systemusers(user-1)',
    'DELETE /systemusers(user-1)',
  ]);
  assert.deepEqual(requests.map((r) => r.opts.body), [undefined, { isdisabled: true }, { isdisabled: false }, undefined]);
  // A PATCH without If-Match would create a user that's already gone, rather than answer 404.
  assert.deepEqual(requests.map((r) => r.opts.headers['If-Match']), [undefined, '*', '*', undefined]);
  for (const r of requests) assert.equal(r.opts.headers['OData-Version'], '4.0');
});

test('Dataverse: reading an application user back, which a soft delete leaves, and a 404 once it\'s gone', async () => {
  const PATH = '/systemusers(user-1)?$select=systemuserid,isdisabled,deletedstate';
  const softDeleted = { systemuserid: 'user-1', isdisabled: true, deletedstate: 1 };
  const { dv, requests } = recorded({ [PATH]: softDeleted });
  assert.deepEqual(await dv.getUser('user-1'), softDeleted);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [`GET ${PATH}`]);
  assert.equal(requests[0].opts.headers['OData-Version'], '4.0');
  for (const status of [404, 500]) {
    const http = {
      get: async () => {
        throw new HttpError(`HTTP ${status}`, { status, method: 'GET', url: `https://env.example.com/api/data/v9.2${PATH}` });
      },
    };
    const read = dataverseApi(/** @type {any} */ (http), 'https://env.example.com/').getUser('user-1');
    if (status === 404) assert.equal(await read, undefined, 'gone');
    else await assert.rejects(read, /HTTP 500/);
  }
});

test('Dataverse: creating a security role, setting its privileges, reading them back and deleting it', async () => {
  const ROLE = '11111111-2222-3333-4444-555555555555';
  const { dv, requests } = recorded({
    'POST /roles': { status: 201, headers: new Headers(), data: { roleid: ROLE } },
    [`/RetrieveRolePrivilegesRole(RoleId=@r)?@r=${ROLE}`]: {
      RolePrivileges: [
        { Depth: 'Global', PrivilegeId: 'p-1', BusinessUnitId: 'bu-root', PrivilegeName: 'prvReadconversationtranscript' },
        { Depth: 3, PrivilegeId: 'p-2', BusinessUnitId: 'bu-root', PrivilegeName: 'prvReadSdkMessage' },
        { Depth: 'Basic', PrivilegeId: 'p-3', BusinessUnitId: 'bu-root' },
      ],
    },
  });
  assert.equal(await dv.createRole({ name: "Reader's role", businessUnitId: 'bu-root', description: 'Made here.' }), ROLE);
  await dv.addPrivileges(ROLE, ['p-1'], 'bu-root');
  await dv.removePrivilege(ROLE, 'p-2');
  assert.deepEqual(await dv.rolePrivileges(ROLE), [
    { id: 'p-1', name: 'prvReadconversationtranscript', depth: 'Global' },
    { id: 'p-2', name: 'prvReadSdkMessage', depth: 'Global' },
    { id: 'p-3', name: undefined, depth: 'Basic' },
  ]);
  await dv.deleteRole(ROLE);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
    'POST /roles',
    `POST /roles(${ROLE})/Microsoft.Dynamics.CRM.AddPrivilegesRole`,
    `POST /roles(${ROLE})/Microsoft.Dynamics.CRM.RemovePrivilegeRole`,
    `GET /RetrieveRolePrivilegesRole(RoleId=@r)?@r=${ROLE}`,
    `DELETE /roles(${ROLE})`,
  ]);
  const [create, add, remove] = requests;
  assert.deepEqual(create.opts.body, { name: "Reader's role", description: 'Made here.', 'businessunitid@odata.bind': '/businessunits(bu-root)' });
  assert.equal(create.opts.headers.Prefer, 'return=representation');
  // Sent again after a lost answer, it could make a second role with the same name.
  assert.equal(create.opts.once, true);
  assert.deepEqual(add.opts.body, {
    Privileges: [{ '@odata.type': 'Microsoft.Dynamics.CRM.RolePrivilege', Depth: 'Global', PrivilegeId: 'p-1', BusinessUnitId: 'bu-root' }],
  });
  // RemovePrivilegeRole takes the privilege as an entity reference: a bare PrivilegeId is a 400.
  assert.deepEqual(remove.opts.body, { Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: 'p-2' } });
  for (const r of requests) assert.equal(r.opts.headers['OData-Version'], '4.0');
});

test("Dataverse: a created role's ID from the entity header, or an error when there's none", async () => {
  const ROLE = '11111111-2222-3333-4444-555555555555';
  const headers = new Headers({ 'OData-EntityId': `https://env.example.com/api/data/v9.2/roles(${ROLE})` });
  const { dv } = recorded({ 'POST /roles': { status: 204, headers, data: null } });
  assert.equal(await dv.createRole({ name: 'R', businessUnitId: 'bu', description: 'D' }), ROLE);
  const none = recorded({ 'POST /roles': { status: 204, headers: new Headers(), data: null } });
  await assert.rejects(none.dv.createRole({ name: 'R', businessUnitId: 'bu', description: 'D' }), /created the role but returned no ID/);
});

test("Dataverse: roles and privileges by name, a sample transcript, and a user's access to it", async () => {
  const { dv, requests } = recorded({
    [`/roles?$select=roleid,description&$filter=${encodeURIComponent("name eq 'It''s mine' and _businessunitid_value eq bu-root")}`]: { value: [{ roleid: 'r-1', description: 'x' }] },
    [`/privileges?$select=privilegeid,name,canbeglobal&$filter=${encodeURIComponent("name eq 'prvReadconversationtranscript' or name eq 'prvReadbot'")}`]: {
      value: [{ privilegeid: 'p-1', name: 'prvReadconversationtranscript', canbeglobal: true }],
    },
    '/conversationtranscripts?$top=1&$select=conversationtranscriptid': { value: [{ conversationtranscriptid: 't-1' }] },
    [`/systemusers(user-1)/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t=${encodeURIComponent('{"@odata.id":"conversationtranscripts(t-1)"}')}`]: {
      AccessRights: 'ReadAccess',
    },
  });
  assert.deepEqual(await dv.rolesByName("It's mine", 'bu-root'), [{ roleid: 'r-1', description: 'x' }]);
  assert.deepEqual(await dv.rolesByName('Nothing', 'bu-root'), []);
  assert.deepEqual(await dv.findPrivileges(['prvReadconversationtranscript', 'prvReadbot']), [
    { privilegeid: 'p-1', name: 'prvReadconversationtranscript', canbeglobal: true },
  ]);
  assert.equal(await dv.firstTranscript(), 't-1');
  assert.equal(await dv.principalAccess('user-1', 'conversationtranscripts(t-1)'), 'ReadAccess');
  assert.equal(requests.length, 5);
  for (const r of requests) assert.equal(r.opts.headers['OData-Version'], '4.0');
});

test("Dataverse: a role's copies in child business units, its copy in one, and the users and teams that hold a role", async () => {
  const roles = (/** @type {string} */ filter) => `/roles?$select=roleid&$filter=${encodeURIComponent(filter)}`;
  const NEXT = 'https://env.example.com/api/data/v9.2/next';
  const { dv, requests } = recorded({
    [roles('roleid eq r-1 or _parentrootroleid_value eq r-1')]: { value: [{ roleid: 'r-1' }, { roleid: 'r-1-child' }] },
    [roles('_parentrootroleid_value eq r-1 and _businessunitid_value eq bu-child')]: { value: [{ roleid: 'r-1-child' }] },
    [roles('_parentrootroleid_value eq r-1 and _businessunitid_value eq bu-other')]: { value: [] },
    '/roles(r-1)/systemuserroles_association?$select=systemuserid': { value: [{ systemuserid: 'u-1' }] },
    '/roles(r-1)/teamroles_association?$select=teamid': { value: [{ teamid: 't-1' }] },
    [roles('roleid eq r-2 or _parentrootroleid_value eq r-2')]: { value: [{ roleid: 'r-2' }], '@odata.nextLink': NEXT },
    '/roles(r-2)/systemuserroles_association?$select=systemuserid': { value: [] },
    '/roles(r-2)/teamroles_association?$select=teamid': { value: [{ teamid: 't-1' }], '@odata.nextLink': NEXT },
    '/roles(r-3)/systemuserroles_association?$select=systemuserid': { value: [] },
  });
  assert.deepEqual(await dv.roleCopies('r-1'), { ids: ['r-1', 'r-1-child'], more: false });
  assert.equal(await dv.roleCopy('r-1', 'bu-child'), 'r-1-child');
  assert.equal(await dv.roleCopy('r-1', 'bu-other'), undefined);
  assert.deepEqual(await dv.roleHolders('r-1'), { users: ['u-1'], teams: ['t-1'], more: false });
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
    `GET ${roles('roleid eq r-1 or _parentrootroleid_value eq r-1')}`,
    `GET ${roles('_parentrootroleid_value eq r-1 and _businessunitid_value eq bu-child')}`,
    `GET ${roles('_parentrootroleid_value eq r-1 and _businessunitid_value eq bu-other')}`,
    'GET /roles(r-1)/systemuserroles_association?$select=systemuserid',
    'GET /roles(r-1)/teamroles_association?$select=teamid',
  ]);
  for (const r of requests) assert.equal(r.opts.headers['OData-Version'], '4.0');

  // More than a page says so, and an answer without a list is an error rather than no one.
  assert.equal((await dv.roleCopies('r-2')).more, true);
  assert.deepEqual(await dv.roleHolders('r-2'), { users: [], teams: ['t-1'], more: true });
  await assert.rejects(dv.roleCopies('r-3'), /^Error: Dataverse returned no list of the role's copies\.$/);
  await assert.rejects(dv.roleHolders('r-3'), /^Error: Dataverse returned no list of the role's teams\.$/);
});

test('Dataverse: privilege depths by name', () => {
  assert.deepEqual([0, 1, 2, 3, '3', 'Global', 'Basic'].map(depthName), ['Basic', 'Local', 'Deep', 'Global', 'Global', 'Global', 'Basic']);
});