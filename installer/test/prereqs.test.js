// @ts-check
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { armApi, ROLES } from '../src/clients/azure.js';
import { FABRIC_ADMIN_ROLE, graphApi, POWER_PLATFORM_ADMIN_ROLE } from '../src/clients/graph.js';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { canAssignDirectoryRoles, checkPrereqs } from '../src/prereqs.js';
import { PRODUCT } from '../src/product.js';
import { fakePaxHost } from './pax-fakes.js';

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
  });
}

const run = async (/** @type {any} */ over, config = emptyConfig()) => {
  const items = await checkPrereqs({ api: fakeApis(over), user: USER, config });
  return Object.fromEntries(items.map((i) => [i.id, i]));
};

test('checkPrereqs: a well-equipped admin meets everything; each item says what it is for and how to get it', async () => {
  const items = await checkPrereqs({ api: fakeApis(), user: USER, config: emptyConfig() });
  assert.deepEqual(items.map((i) => i.id), ['consent-role', 'fabric-admin', 'register-apps', 'power-bi-pro', 'copilot-licences', 'power-automate-premium', 'fabric-capacity', 'azure-rbac', 'key-vault', 'tenant-settings']);
  for (const i of items) {
    assert.ok(i.neededFor && i.howTo && i.label, i.id);
  }
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['consent-role'].status, 'met');
  assert.match(byId['consent-role'].detail, /Active: Global Administrator/);
  assert.equal(byId['fabric-admin'].status, 'met');
  assert.equal(byId['register-apps'].status, 'met');
  assert.equal(byId['power-bi-pro'].status, 'met');
  assert.equal(byId['fabric-capacity'].status, 'met');
  assert.equal(byId['azure-rbac'].status, 'met');
  assert.match(byId['azure-rbac'].rows?.[0].detail ?? '', /Can create resources and assign roles \(Owner\)/);
  assert.equal(byId['key-vault'].status, 'met');
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

test('checkPrereqs: the install\'s subscription is checked first; no Azure at all is optional', async () => {
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
});

test('checkPrereqs: an active P SKU runs Fabric and an Embedded one doesn\'t; a failing check is "couldn\'t check"', async () => {
  const r = await run({
    capacities: [{ id: 'p1', displayName: 'Premium', sku: 'P1', state: 'Active' }, { id: 'f2', displayName: 'Paused', sku: 'F2', state: 'Paused' }],
  });
  assert.equal(r['fabric-capacity'].status, 'met', 'a P SKU runs Fabric');

  const noCap = await run({ capacities: [{ id: 'a1', displayName: 'Embedded', sku: 'A1', state: 'Active' }] });
  assert.equal(noCap['fabric-capacity'].status, 'missing');

  const api = fakeApis();
  api.fabric.listCapacities = async () => { throw new HttpError('503 Service Unavailable', { method: 'GET', url: 'x', status: 503 }); };
  const items = await checkPrereqs({ api, user: USER, config: emptyConfig() });
  const cap = items.find((i) => i.id === 'fabric-capacity');
  assert.equal(cap?.status, 'unknown');
  assert.match(cap?.detail ?? '', /^Couldn't check: 503/);
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
  assert.match(none['power-automate-premium'].neededFor, /the product feedback export and the agent inventory/);
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

/** A record on the PAX route that hasn't started yet. */
function paxConfig() {
  const config = emptyConfig();
  config.target = 'pax';
  return config;
}

/**
 * The PAX route's checks, on a fake PC. Azure and Fabric capacities throw if asked: the route uses neither.
 * @param {{ over?: any, config?: import('../src/config.js').InstallConfig, host?: Parameters<typeof fakePaxHost>[0], sources?: any }} [o]
 */
async function runPax(o = {}) {
  const pc = fakePaxHost(o.host);
  try {
    const api = fakeApis(o.over);
    const refuse = (/** @type {string} */ what) => () => {
      throw new Error(`The PAX route asked for ${what}.`);
    };
    api.arm = new Proxy({}, { get: (_, name) => refuse(`arm.${String(name)}`) });
    api.graph.myGroupIds = refuse('graph.myGroupIds');
    api.fabric.listCapacities = refuse('fabric.listCapacities');
    const items = await checkPrereqs({ api, user: USER, config: o.config ?? paxConfig(), sources: o.sources, paxHost: pc.host });
    return { items, byId: Object.fromEntries(items.map((i) => [i.id, i])), keys: pc.keys() };
  } finally {
    rmSync(pc.base, { recursive: true, force: true });
  }
}

test('checkPrereqs on the PAX route: this PC, the site and the app instead of capacity and Azure', async () => {
  const { items, byId, keys } = await runPax();
  assert.deepEqual(items.map((i) => i.id), ['consent-role', 'fabric-admin', 'register-apps', 'power-bi-pro', 'copilot-licences', 'this-pc', 'site-admin', 'managed-app', 'tenant-settings']);
  for (const i of items) assert.ok(i.neededFor && i.howTo && i.label, i.id);
  for (const gone of ['power-automate-premium', 'fabric-capacity', 'azure-rbac', 'key-vault', 'defender-licence', 'resource-graph']) assert.ok(!byId[gone], gone);

  assert.equal(byId['this-pc'].status, 'met');
  assert.equal(byId['this-pc'].detail, 'PowerShell 7.4.6 (execution policy RemoteSigned) and Python 3.12.4.');
  assert.match(byId['this-pc'].neededFor, /The PC has to be on when the task runs \(02:00 by default\)/);
  assert.deepEqual([...new Set(keys)], ['pwsh', 'python'], 'it only looks: nothing is written, registered or started');

  assert.equal(byId['site-admin'].status, 'met');
  assert.equal(byId['site-admin'].detail, 'Active: Global Administrator');
  assert.equal(byId['site-admin'].optional, true, 'the installer shows the commands for an admin, and waits');

  assert.match(byId['power-bi-pro'].neededFor, /everyone who opens the report needs Power BI Pro too/);
  assert.equal(byId['tenant-settings'].label, 'Power BI tenant settings');
  assert.equal(byId['tenant-settings'].status, 'unknown');
});

test('checkPrereqs on the PAX route: what this PC lacks, and how to fix it without bypassing the policy', async () => {
  const linux = await runPax({ host: { platform: 'linux' } });
  assert.equal(linux.byId['this-pc'].status, 'missing');
  assert.match(linux.byId['this-pc'].detail, /needs a Windows PC/);
  assert.equal(linux.byId['this-pc'].howTo, 'Run the installer on the Windows PC that will run the task.');
  assert.deepEqual(linux.keys, [], 'nothing is probed on a PC that can\'t run the task');

  const cloud = await runPax({ host: { platform: 'linux', cloudShell: true } });
  assert.match(cloud.byId['this-pc'].detail, /can't be set up from Azure Cloud Shell/);

  const none = await runPax({ host: { pwsh: null, python: null } });
  assert.equal(none.byId['this-pc'].status, 'missing');
  assert.equal(none.byId['this-pc'].detail, "PowerShell 7 isn't installed. Python isn't installed.");
  assert.match(none.byId['this-pc'].howTo, /winget/i);

  const old = await runPax({ host: { pwsh: { version: '7.1.3' }, python: { python: '3.9.7' } } });
  assert.equal(old.byId['this-pc'].detail, 'PowerShell 7.1.3 is too old. Python 3.9.7 is too old.');

  for (const policy of ['AllSigned', 'Restricted']) {
    const locked = await runPax({ host: { pwsh: { policy } } });
    assert.equal(locked.byId['this-pc'].status, 'missing', policy);
    assert.match(locked.byId['this-pc'].detail, new RegExp(`execution policy is ${policy}, so the refresh scripts can't run`));
    assert.match(locked.byId['this-pc'].howTo, /doesn't change or bypass the policy/);
    assert.match(locked.byId['this-pc'].howTo, /Set-ExecutionPolicy -Scope CurrentUser RemoteSigned/);
    assert.doesNotMatch(locked.byId['this-pc'].howTo, /-ExecutionPolicy Bypass/);
  }
  const constrained = await runPax({ host: { pwsh: { languageMode: 'ConstrainedLanguage' } } });
  assert.match(constrained.byId['this-pc'].detail, /PowerShell runs in ConstrainedLanguage mode on this PC/);
});

test('checkPrereqs on the PAX route: the app\'s row, unless the app is turned off', async () => {
  const { byId } = await runPax();
  assert.equal(byId['managed-app'].status, 'missing');
  assert.equal(byId['managed-app'].detail, 'This copy of the installer has no build of the app.');
  assert.ok(byId['managed-app'].howTo.includes(PRODUCT.exe), 'the exe carries the build');
  assert.equal(byId['managed-app'].optional, true, 'without it, setup finishes at the report');
  assert.match(byId['managed-app'].neededFor, /Without it, setup finishes at the report\./);
  assert.match(byId['managed-app'].label, new RegExp(`^The ${PRODUCT.managedApp.name} app`));
  assert.doesNotMatch(JSON.stringify(byId['managed-app']), /App Edition/i);

  const config = paxConfig();
  config.pax = { deployApp: false };
  const off = await runPax({ config });
  assert.ok(!off.byId['managed-app']);
  assert.deepEqual(off.items.map((i) => i.id).slice(-3), ['this-pc', 'site-admin', 'tenant-settings']);

  const ppAdmin = await runPax({ over: { roles: [{ roleTemplateId: POWER_PLATFORM_ADMIN_ROLE, displayName: 'Power Platform Administrator' }] } });
  assert.equal(ppAdmin.byId['site-admin'].status, 'missing', 'a Power Platform admin can\'t grant a site');
});

test('checkPrereqs on the PAX route: only the report\'s tenant settings count, since the model signs in as you', async () => {
  const settings = (/** @type {Record<string, boolean>} */ on) => async () => Object.entries(on).map(([settingName, enabled]) => ({ settingName, enabled }));
  const spOff = settings({ ServicePrincipalAccessPermissionAPIs: false, CustomVisualsTenant: true });
  const pax = await runPax({ over: { tenantSettings: spOff } });
  assert.equal(pax.byId['tenant-settings'].status, 'met');
  assert.equal(pax.byId['tenant-settings'].detail, `The settings ${PRODUCT.name} needs are on.`);
  const fabric = await run({ tenantSettings: spOff });
  assert.equal(fabric['tenant-settings'].status, 'missing', 'the Fabric model signs in as the app');
  assert.match(fabric['tenant-settings'].detail, /Service principals can call Fabric public APIs/);

  const visualsOff = await runPax({ over: { tenantSettings: settings({ ServicePrincipalAccessPermissionAPIs: true, CustomVisualsTenant: false }) } });
  assert.equal(visualsOff.byId['tenant-settings'].status, 'missing');
  assert.equal(visualsOff.byId['tenant-settings'].detail, 'Off: Allow visuals created using the Power BI SDK.');
});
