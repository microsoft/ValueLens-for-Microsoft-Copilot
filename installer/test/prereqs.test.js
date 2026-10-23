// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armApi, ROLES } from '../src/clients/azure.js';
import { FABRIC_ADMIN_ROLE, graphApi } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { canAssignDirectoryRoles, checkPrereqs } from '../src/prereqs.js';

const GA = '62e90394-69f5-4237-9190-012177145e10';
const USER = /** @type {any} */ ({ id: 'user-1', upn: 'admin@contoso.com', tenantId: 't-1' });
const ALL = [{ actions: ['*'], notActions: [] }];
const READ = [{ actions: ['*/read'], notActions: [] }];
const CREATE = [{ actions: ['Microsoft.Resources/*'], notActions: [] }];
const assignment = (/** @type {string} */ role, principalId = USER.id) => ({ properties: { roleDefinitionId: `/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/${role}`, principalId } });

/**
 * Read-only APIs with everything a user could have, to take away test by test.
 * @param {any} [over]
 */
function fakeApis(over = {}) {
  /** @type {Record<string, any[]>} */
  const perms = { '/subscriptions/sub-1': ALL, ...(over.perms ?? {}) };
  return /** @type {any} */ ({
    graph: {
      myDirectoryRoles: async () => over.roles ?? [{ roleTemplateId: GA, displayName: 'Global Administrator' }, { roleTemplateId: FABRIC_ADMIN_ROLE, displayName: 'Fabric Administrator' }],
      myEligibleRoles: over.eligible ?? (async () => []),
      myGroupIds: async () => ['group-1'],
      myLicenseDetails: async () => over.licences ?? [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }] }],
      subscribedSkus: over.skusFn ?? (async () => over.skus ?? []),
      usersCanRegisterApps: async () => over.usersCanRegister ?? true,
    },
    arm: {
      listSubscriptions: async () => over.subs ?? [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }],
      permissions: async (/** @type {string} */ scope) => perms[scope] ?? READ,
      myRoleAssignments: async (/** @type {string} */ scope) => over.assigned?.[scope] ?? [assignment(ROLES.owner)],
      myEligibleRoles: async (/** @type {string} */ scope) => over.armEligible?.[scope] ?? [],
      getVault: async () => ({ name: 'kv' }),
      resourceGraph: over.resourceGraph ?? (async () => ({ data: [{ id: 'x' }] })),
    },
    fabric: {
      listCapacities: async () => over.capacities ?? [{ id: 'cap-1', displayName: 'F64', sku: 'F64', state: 'Active' }],
      tenantSettings: over.tenantSettings ?? (async () => { throw new HttpError('401 Unauthorized', { method: 'GET', url: 'https://api.fabric.microsoft.com/v1/admin/tenantsettings', status: 401 }); }),
    },
    discovery: {
      instances: async () => over.envs ?? [{ Url: 'https://org1.crm.dynamics.com', FriendlyName: 'Default', State: 0, IsUserSysAdmin: true }],
    },
  });
}

const run = async (/** @type {any} */ over, config = emptyConfig()) => {
  const items = await checkPrereqs({ api: fakeApis(over), user: USER, config });
  return Object.fromEntries(items.map((i) => [i.id, i]));
};

test('checkPrereqs: a well-equipped admin meets everything; each item says what it is for and how to get it', async () => {
  const items = await checkPrereqs({ api: fakeApis(), user: USER, config: emptyConfig() });
  assert.deepEqual(items.map((i) => i.id), ['consent-role', 'fabric-admin', 'power-platform-admin', 'register-apps', 'power-bi-pro', 'copilot-licences', 'power-automate-premium', 'fabric-capacity', 'azure-rbac', 'key-vault', 'environments', 'viva-analyst', 'tenant-settings']);
  for (const i of items) {
    assert.ok(i.neededFor && i.howTo && i.label, i.id);
  }
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['consent-role'].status, 'met');
  assert.match(byId['consent-role'].detail, /Active: Global Administrator/);
  assert.equal(byId['fabric-admin'].status, 'met');
  assert.equal(byId['power-platform-admin'].status, 'missing');
  assert.equal(byId['register-apps'].status, 'met');
  assert.equal(byId['power-bi-pro'].status, 'met');
  assert.equal(byId['fabric-capacity'].status, 'met');
  assert.equal(byId['azure-rbac'].status, 'met');
  assert.match(byId['azure-rbac'].rows?.[0].detail ?? '', /Can create resources and assign roles \(Owner\)/);
  assert.equal(byId['key-vault'].status, 'met');
  assert.equal(byId.environments.status, 'met');
  assert.equal(byId['tenant-settings'].status, 'unknown', 'a 401 on tenant settings is "couldn\'t check", not missing');
  assert.match(byId['tenant-settings'].detail, /only a Fabric Administrator can read/);
});

test('checkPrereqs: only active roles count; one you can activate in PIM says so, with a link', async () => {
  const eligible = await run({ roles: [], eligible: async () => [{ roleDefinitionId: GA, principalId: USER.id }] });
  assert.equal(eligible['consent-role'].status, 'eligible');
  assert.match(eligible['consent-role'].detail, /Not active yet: Global Administrator\. You can activate this role in Entra \(Privileged Identity Management\): https:\/\/entra\.microsoft\.com\//);
  assert.doesNotMatch(eligible['consent-role'].detail, /PIM-eligible|Eligible/);

  const none = await run({ roles: [], eligible: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } });
  assert.equal(none['consent-role'].status, 'missing');
  assert.match(none['consent-role'].detail, /Couldn't check for roles you could activate yourself/);
  assert.match(none['consent-role'].howTo, /link for a Global Administrator/);
  assert.equal(none['register-apps'].status, 'met', 'users can register apps');

  const locked = await run({ roles: [], usersCanRegister: false });
  assert.equal(locked['register-apps'].status, 'missing');
});

test('checkPrereqs: Power BI Pro only counts once provisioned', async () => {
  const none = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'PendingActivation' }, { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' }] }] });
  assert.equal(none['power-bi-pro'].status, 'missing');
  const ppu = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P3', provisioningStatus: 'Success' }] }] });
  assert.equal(ppu['power-bi-pro'].status, 'met');
  assert.match(ppu['power-bi-pro'].detail, /Premium Per User/);
});

test('checkPrereqs: Azure access per subscription: Contributor alone is missing, Contributor and UAA is met, eligible Owner says activate first', async () => {
  const subs = [
    { subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' },
    { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' },
    { subscriptionId: 'sub-c', displayName: 'C', state: 'Enabled' },
    { subscriptionId: 'sub-off', displayName: 'Off', state: 'Disabled' },
  ];
  const r = await run({
    subs,
    perms: { '/subscriptions/sub-a': CREATE, '/subscriptions/sub-b': ALL, '/subscriptions/sub-c': READ },
    assigned: {
      '/subscriptions/sub-a': [assignment(ROLES.contributor)],
      '/subscriptions/sub-b': [assignment(ROLES.contributor), assignment(ROLES.userAccessAdministrator, 'group-1')],
      '/subscriptions/sub-c': [],
    },
    armEligible: { '/subscriptions/sub-c': [assignment(ROLES.owner)] },
  });
  const rows = Object.fromEntries((r['azure-rbac'].rows ?? []).map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['A', 'B', 'C'], 'disabled subscriptions are skipped');
  assert.equal(rows.A.status, 'missing');
  assert.match(rows.A.detail ?? '', /not assign roles \(no User Access Administrator\) \(Contributor\)/);
  assert.equal(rows.B.status, 'met');
  assert.match(rows.B.detail ?? '', /Contributor, User Access Administrator/, 'a role held through a group counts');
  assert.equal(rows.C.status, 'eligible');
  assert.match(rows.C.detail ?? '', /Not active yet: Owner\. You can activate it/);
  assert.equal(r['azure-rbac'].status, 'met');
  assert.match(r['azure-rbac'].detail, /1 of 3 subscriptions/);
});

test('checkPrereqs: the install\'s subscription is checked first; no Azure at all is optional for Fabric and required for Azure', async () => {
  const config = emptyConfig();
  config.keyVault.subscriptionId = 'sub-b';
  const r = await run({ subs: [{ subscriptionId: 'sub-a', displayName: 'A', state: 'Enabled' }, { subscriptionId: 'sub-b', displayName: 'B', state: 'Enabled' }] }, config);
  assert.equal(r['azure-rbac'].rows?.[0].name, 'B');

  const none = await run({ subs: [] });
  assert.equal(none['azure-rbac'].status, 'missing');
  assert.equal(none['azure-rbac'].optional, true);
  assert.match(none['azure-rbac'].howTo, /--no-key-vault/);
  assert.equal(none['key-vault'].status, 'missing');
  assert.equal(none['key-vault'].optional, true, 'no Key Vault is a choice on Fabric');

  const azure = emptyConfig();
  azure.target = 'azure';
  const az = await run({ subs: [] }, azure);
  assert.equal(az['azure-rbac'].optional, false);
  assert.equal(az['fabric-capacity'], undefined, 'the Azure target needs no Fabric capacity');
  assert.equal(az['key-vault'], undefined);
  assert.equal(az['teams-admin'].status, 'met', 'Global Administrator publishes the Teams app');
  assert.equal(az['teams-admin'].optional, true);
  assert.equal(none['teams-admin'], undefined, 'only the Azure target has a Teams app');
  const noTeams = await run({ roles: [] }, azure);
  assert.equal(noTeams['teams-admin'].status, 'missing');
  assert.match(noTeams['teams-admin'].howTo, /prints the steps for a Teams Administrator/);
  const teamsAdmin = await run({ roles: [{ roleTemplateId: '69091246-20e8-4a56-aa4d-066075b2a7a8', displayName: 'Teams Administrator' }] }, azure);
  assert.match(teamsAdmin['teams-admin'].detail, /Active: Teams Administrator/);
});

const CONTRIBUTOR = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action'] }];
const RBAC_ADMIN = [{ actions: ['Microsoft.Authorization/roleAssignments/write', 'Microsoft.Authorization/roleAssignments/delete', '*/read', 'Microsoft.Support/*'], notActions: [] }];
const RG = '/subscriptions/sub-1/resourceGroups/rg-x';

/** An Azure install into resource group rg-x in sub-1. @param {'existing' | 'new'} [mode] */
function azureInto(mode = 'existing') {
  const config = emptyConfig();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ subscriptionId: 'sub-1', resourceGroup: 'rg-x', resourceGroupMode: mode });
  return config;
}

test('checkPrereqs: an existing resource group is checked there, so least privilege on just that group is enough', async () => {
  const lp = await run({
    perms: { '/subscriptions/sub-1': READ, [RG]: [...CONTRIBUTOR, ...RBAC_ADMIN] },
    assigned: { '/subscriptions/sub-1': [], [RG]: [assignment(ROLES.contributor), assignment(ROLES.rbacAdministrator)] },
  }, azureInto());
  const rbac = lp['azure-rbac'];
  assert.equal(rbac.status, 'met', 'the resource group decides, not the subscription');
  assert.match(rbac.detail, /^Resource group rg-x: enough to install there\. Subscription-wide, 0 of 1 subscription give you this\./);
  assert.deepEqual(rbac.rows?.map((r) => [r.name, r.status]), [['Resource group rg-x', 'met'], ['Production', 'missing']]);
  assert.equal(rbac.rows?.[0].detail, 'Can deploy and assign roles in this resource group (Contributor, Role Based Access Control Administrator)');
  assert.match(rbac.howTo, /least privilege.*docs\/AZURE-LEAST-PRIVILEGE\.md/);

  const subs = [{ subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' }, { subscriptionId: 'sub-2', displayName: 'Other', state: 'Enabled' }];
  const noAssign = await run({ subs, perms: { '/subscriptions/sub-1': READ, '/subscriptions/sub-2': ALL, [RG]: CONTRIBUTOR }, assigned: { [RG]: [assignment(ROLES.contributor)] } }, azureInto());
  assert.equal(noAssign['azure-rbac'].status, 'missing', 'Owner on another subscription doesn\'t help an install into rg-x');
  assert.match(noAssign['azure-rbac'].detail, /^Resource group rg-x: not enough to install there\. Subscription-wide, 1 of 2 subscriptions give you this\./);
  assert.equal(noAssign['azure-rbac'].rows?.[0].detail, 'Can deploy here but not assign roles (no Role Based Access Control Administrator or User Access Administrator) (Contributor)');

  const assignOnly = await run({ perms: { '/subscriptions/sub-1': READ, [RG]: RBAC_ADMIN }, assigned: { [RG]: [assignment(ROLES.rbacAdministrator)] } }, azureInto());
  assert.equal(assignOnly['azure-rbac'].rows?.[0].detail, 'Can assign roles here but not deploy (no Contributor) (Role Based Access Control Administrator)');

  const readOnly = await run({ perms: { '/subscriptions/sub-1': READ, [RG]: READ }, assigned: { [RG]: [] } }, azureInto());
  assert.equal(readOnly['azure-rbac'].status, 'missing');
  assert.equal(readOnly['azure-rbac'].rows?.[0].detail, 'Can\'t deploy or assign roles in this resource group');

  const eligible = await run({
    perms: { '/subscriptions/sub-1': READ, [RG]: CONTRIBUTOR },
    assigned: { [RG]: [assignment(ROLES.contributor)] },
    armEligible: { [RG]: [assignment(ROLES.rbacAdministrator)] },
  }, azureInto());
  assert.equal(eligible['azure-rbac'].status, 'eligible');
  assert.match(eligible['azure-rbac'].detail, /^Resource group rg-x: activate your role first\./);
  assert.equal(eligible['azure-rbac'].rows?.[0].detail, 'Not active yet: Role Based Access Control Administrator. You can activate it in Privileged Identity Management.');
});

test('checkPrereqs: a resource group that can\'t be checked leaves it to the subscriptions; no resource group row for a new group or on Fabric', async () => {
  const forbidden = () => new HttpError('403 Forbidden', { method: 'GET', url: 'x', status: 403 });
  const byId = (/** @type {import('../src/prereqs.js').Prereq[]} */ items) => Object.fromEntries(items.map((i) => [i.id, i]));

  const unreadable = fakeApis();
  unreadable.arm.permissions = async (/** @type {string} */ scope) => {
    if (scope === RG) throw forbidden();
    return ALL;
  };
  const r = byId(await checkPrereqs({ api: unreadable, user: USER, config: azureInto() }));
  assert.equal(r['azure-rbac'].status, 'met', 'Owner on the subscription still decides');
  assert.match(r['azure-rbac'].detail, /^Resource group rg-x: couldn't check\. Subscription-wide, 1 of 1 subscription give you this\./);
  assert.equal(r['azure-rbac'].rows?.[0].status, 'unknown');
  assert.match(r['azure-rbac'].rows?.[0].detail ?? '', /^Couldn't check: 403/);

  const hidden = await run({ subs: [], perms: { [RG]: [...CONTRIBUTOR, ...RBAC_ADMIN] } }, azureInto());
  assert.equal(hidden['azure-rbac'].status, 'met', 'rights on just the group, with no subscription you can list');
  assert.equal(hidden['azure-rbac'].detail, 'Resource group rg-x: enough to install there.');
  assert.deepEqual(hidden['azure-rbac'].rows?.map((row) => row.name), ['Resource group rg-x']);

  const unlisted = fakeApis({ perms: { [RG]: [...CONTRIBUTOR, ...RBAC_ADMIN] } });
  unlisted.arm.listSubscriptions = async () => { throw forbidden(); };
  const u = byId(await checkPrereqs({ api: unlisted, user: USER, config: azureInto() }));
  assert.equal(u['azure-rbac'].status, 'met', 'a subscription list that fails doesn\'t hide the resource group');

  const fresh = await run({}, azureInto('new'));
  assert.ok(!fresh['azure-rbac'].rows?.some((row) => row.name.startsWith('Resource group')), 'a new group needs the subscription');
  assert.doesNotMatch(fresh['azure-rbac'].detail, /Resource group/);

  const fabric = azureInto();
  fabric.target = 'fabric';
  const fab = await run({}, fabric);
  assert.ok(!fab['azure-rbac'].rows?.some((row) => row.name.startsWith('Resource group')), 'Fabric doesn\'t deploy into a resource group');
  assert.doesNotMatch(fab['azure-rbac'].howTo, /LEAST-PRIVILEGE/);
});

test('checkPrereqs: System Administrator per environment; a failing check is "couldn\'t check"', async () => {
  const r = await run({
    envs: [
      { Url: 'https://a.crm.dynamics.com', FriendlyName: 'Dev', State: 0, IsUserSysAdmin: false },
      { Url: 'https://b.crm.dynamics.com', FriendlyName: 'Prod', State: 0, IsUserSysAdmin: false },
    ],
    capacities: [{ id: 'p1', displayName: 'Premium', sku: 'P1', state: 'Active' }, { id: 'f2', displayName: 'Paused', sku: 'F2', state: 'Paused' }],
  });
  assert.equal(r.environments.status, 'missing');
  assert.deepEqual(r.environments.rows?.map((x) => x.status), ['missing', 'missing']);
  assert.equal(r['fabric-capacity'].status, 'met', 'a P SKU runs Fabric');

  const noCap = await run({ capacities: [{ id: 'a1', displayName: 'Embedded', sku: 'A1', state: 'Active' }] });
  assert.equal(noCap['fabric-capacity'].status, 'missing');

  const api = fakeApis();
  api.discovery.instances = async () => { throw new HttpError('503 Service Unavailable', { method: 'GET', url: 'x', status: 503 }); };
  const items = await checkPrereqs({ api, user: USER, config: emptyConfig() });
  const env = items.find((i) => i.id === 'environments');
  assert.equal(env?.status, 'unknown');
  assert.match(env?.detail ?? '', /^Couldn't check: 503/);
});

test('checkPrereqs: with Resource Graph on, it says what you can see of agents and Foundry; a refusal is missing, none is unknown', async () => {
  const config = emptyConfig();
  config.dataSources.resourceGraph = 'api';
  config.resourceGraph = { managementGroup: 'mg-1', agents: true, foundry: true };
  /** @type {any[]} */
  const asked = [];
  const seen = await run({ resourceGraph: async (/** @type {string} */ q, /** @type {string} */ mg) => (asked.push([q, mg]), { data: [{ id: 'x' }] }) }, config);
  assert.equal(seen['resource-graph'].status, 'met');
  assert.equal(seen['resource-graph'].optional, true);
  assert.deepEqual(asked.map((a) => a[1]), ['mg-1', 'mg-1']);
  assert.match(asked[0][0], /PowerPlatformResources \| where type =~ 'microsoft\.copilotstudio\/agents'/);
  assert.match(asked[1][0], /microsoft\.cognitiveservices\/accounts\/projects/);

  const refused = await run({ resourceGraph: async (/** @type {string} */ q) => {
    if (q.startsWith('PowerPlatformResources')) throw new HttpError('403 Forbidden', { method: 'POST', url: 'x', status: 403 });
    return { data: [] };
  } }, config);
  assert.equal(refused['resource-graph'].status, 'missing');
  assert.deepEqual(refused['resource-graph'].rows?.map((r) => r.status), ['missing', 'unknown']);
  assert.match(refused['resource-graph'].detail, /Copilot Studio agents: Refused/);

  assert.equal((await run({}))['resource-graph'], undefined, 'not checked when the source is off');
});

test('graph and ARM lookups keep only rows for the signed-in user\'s principals, whatever the filter returned', async () => {
  /** @type {any[]} */
  const queries = [];
  const http = /** @type {any} */ ({
    list: async (/** @type {string} */ path, /** @type {any} */ o) => {
      queries.push([path, o.query]);
      if (path.includes('roleEligibilityScheduleInstances') && path.startsWith('/roleManagement')) {
        return [{ roleDefinitionId: GA, principalId: USER.id }, { roleDefinitionId: GA, principalId: 'someone-else' }];
      }
      return [assignment(ROLES.owner), assignment(ROLES.owner, 'someone-else'), assignment(ROLES.contributor, 'group-1')];
    },
  });
  const graph = graphApi(http);
  assert.deepEqual((await graph.myEligibleRoles(USER.id)).map((r) => r.principalId), [USER.id]);
  assert.match(queries[0][1].$filter, /principalId eq 'user-1'/);

  const arm = armApi(http);
  const ids = [USER.id, 'group-1'];
  assert.deepEqual((await arm.myRoleAssignments('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[1][1].$filter, "assignedTo('user-1')");
  assert.deepEqual((await arm.myEligibleRoles('/subscriptions/s', ids)).map((r) => r.properties.principalId), [USER.id, 'group-1']);
  assert.equal(queries[2][1].$filter, 'asTarget()');
});

test('checkPrereqs: the Defender licence check only shows when Defender is picked, and is optional', async () => {
  assert.equal((await run({}))['defender-licence'], undefined);
  const config = emptyConfig();
  config.modules.defender = true;
  const none = await run({}, config);
  assert.equal(none['defender-licence'].status, 'missing');
  assert.equal(none['defender-licence'].optional, true);
  assert.match(none['defender-licence'].howTo, /skipped/);
  const p2 = await run({ skus: [{ capabilityStatus: 'Enabled', servicePlans: [{ servicePlanName: 'WINDEFATP' }, { servicePlanName: 'ADALLOM_S_STANDALONE' }] }] }, config);
  assert.equal(p2['defender-licence'].status, 'met');
  assert.match(p2['defender-licence'].detail, /Defender for Endpoint P2, Defender for Cloud Apps/);
  const lapsed = await run({ skus: [{ capabilityStatus: 'Suspended', servicePlans: [{ servicePlanName: 'WINDEFATP' }] }] }, config);
  assert.equal(lapsed['defender-licence'].status, 'missing');
  const unreadable = await run({ skusFn: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } }, config);
  assert.equal(unreadable['defender-licence'].status, 'unknown');
});

test('checkPrereqs: Fabric administrator says plainly it is only needed when the tenant settings are off', async () => {
  const r = await run({ roles: [], eligible: async () => [{ roleDefinitionId: FABRIC_ADMIN_ROLE, principalId: USER.id }] });
  assert.match(r['fabric-admin'].label, /only needed if the tenant settings below are off/);
  assert.equal(r['fabric-admin'].status, 'eligible');
  assert.match(r['fabric-admin'].detail, /You can activate this role in Entra \(Privileged Identity Management\)/);
  for (const i of Object.values(r)) assert.doesNotMatch(`${i.label} ${i.detail} ${i.howTo}`, /PIM-eligible/, i.id);
});

test('checkPrereqs: Power Automate Premium is optional, needed only for the flows, and read from your own licences', async () => {
  const none = await run({});
  assert.equal(none['power-automate-premium'].status, 'missing');
  assert.equal(none['power-automate-premium'].optional, true);
  assert.match(none['power-automate-premium'].neededFor, /Copilot Studio credits/);
  assert.match(none['power-automate-premium'].neededFor, /signs in to the flow/);
  const premium = await run({ licences: [{ servicePlans: [{ servicePlanName: 'BI_AZURE_P2', provisioningStatus: 'Success' }, { servicePlanName: 'POWER_AUTOMATE_ATTENDED_RPA', provisioningStatus: 'Success' }] }] });
  assert.equal(premium['power-automate-premium'].status, 'met');
  assert.equal(premium['power-bi-pro'].status, 'met', 'one licence read serves both rows');
  assert.match(premium['power-automate-premium'].detail, /Power Automate Premium/);
  const perUser = await run({ licences: [{ servicePlans: [{ servicePlanName: 'FLOW_PER_USER', provisioningStatus: 'Success' }] }] });
  assert.equal(perUser['power-automate-premium'].status, 'met');
  const seeded = await run({ licences: [{ servicePlans: [{ servicePlanName: 'FLOW_O365_P3', provisioningStatus: 'Success' }, { servicePlanName: 'FLOW_PER_USER', provisioningStatus: 'PendingActivation' }] }] });
  assert.equal(seeded['power-automate-premium'].status, 'missing', 'the Microsoft 365 flow plan has no premium connectors');
});

test('checkPrereqs: Viva Insights analyst can\'t be read, so it is optional and "couldn\'t check", and says it can wait', async () => {
  const r = await run({});
  assert.equal(r['viva-analyst'].status, 'unknown');
  assert.equal(r['viva-analyst'].optional, true);
  assert.match(r['viva-analyst'].detail, /^Couldn't check/);
  assert.match(r['viva-analyst'].neededFor, /Insights Analyst role creates the query/);
  assert.match(r['viva-analyst'].neededFor, /add it later/);
});

test('checkPrereqs: Microsoft 365 Copilot licences in the tenant are met once any are assigned', async () => {
  const copilot = (/** @type {number} */ consumedUnits, sku = 'Microsoft_365_Copilot') => ({ skuPartNumber: sku, capabilityStatus: 'Enabled', consumedUnits, prepaidUnits: { enabled: 100 }, servicePlans: [{ servicePlanName: 'M365_COPILOT_APPS' }] });
  const none = await run({ skus: [{ skuPartNumber: 'SPE_E5', consumedUnits: 50, servicePlans: [{ servicePlanName: 'EXCHANGE_S_ENTERPRISE' }] }] });
  assert.equal(none['copilot-licences'].status, 'missing');
  assert.match(none['copilot-licences'].detail, /No Microsoft 365 Copilot licences/);
  const bought = await run({ skus: [copilot(0)] });
  assert.equal(bought['copilot-licences'].status, 'missing');
  assert.match(bought['copilot-licences'].detail, /Microsoft_365_Copilot, but none are assigned/);
  const used = await run({ skus: [copilot(30), copilot(5, 'Microsoft_365_Copilot_EDU')] });
  assert.equal(used['copilot-licences'].status, 'met');
  assert.match(used['copilot-licences'].detail, /35 assigned \(Microsoft_365_Copilot, Microsoft_365_Copilot_EDU\)/);
  const unreadable = await run({ skusFn: async () => { throw new HttpError('403', { method: 'GET', url: 'x', status: 403 }); } });
  assert.equal(unreadable['copilot-licences'].status, 'unknown');
});

test('canAssignDirectoryRoles: true only with Global Administrator or Privileged Role Administrator active', async () => {
  assert.equal(await canAssignDirectoryRoles(fakeApis()), true);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [{ roleTemplateId: 'e8611ab8-c189-46e8-94e1-60213ab1f814', displayName: 'Privileged Role Administrator' }] })), true);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [{ roleTemplateId: FABRIC_ADMIN_ROLE, displayName: 'Fabric Administrator' }] })), false);
  assert.equal(await canAssignDirectoryRoles(fakeApis({ roles: [] })), false);
});
