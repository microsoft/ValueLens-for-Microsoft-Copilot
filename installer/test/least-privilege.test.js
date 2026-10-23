// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HttpError } from '../src/http.js';
import { ASK_PROVIDERS, AZURE_PROVIDERS, PRIVATE_FEATURE, PRIVATE_PROVIDERS, azurePreflight, azureProviders } from '../src/steps/azure/index.js';
import { LEAST_PRIVILEGE_DOC, TEMPLATE_ROLES, adminGrants, providerCommands, registrationMessage, roleAssignMessage, roleCondition } from '../src/steps/azure/least-privilege.js';
import { AZURE_AI_ROLES } from '../src/steps/consumption.js';
import { fakeArm, fakeCtx, fakeFabric, fakePowerBi, fakeUi } from './fakes.js';

const SUB = '/subscriptions/sub-1';
const RG = `${SUB}/resourceGroups/rg`;
const READ = [{ actions: ['*/read'], notActions: [] }];
/** Contributor, as the permissions API returns it. */
const CONTRIBUTOR = {
  actions: ['*'],
  notActions: [
    'Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action',
    'Microsoft.Blueprint/blueprintAssignments/write', 'Microsoft.Blueprint/blueprintAssignments/delete', 'Microsoft.Compute/galleries/share/action',
    'Microsoft.Purview/consents/write', 'Microsoft.Purview/consents/delete', 'Microsoft.Resources/deploymentStacks/manageDenySetting/action',
    'Microsoft.Subscription/cancel/action', 'Microsoft.Subscription/enable/action',
  ],
};
/** Role Based Access Control Administrator. The permissions API leaves out its condition. */
const RBAC_ADMIN = { actions: ['Microsoft.Authorization/roleAssignments/write', 'Microsoft.Authorization/roleAssignments/delete', '*/read', 'Microsoft.Support/*'], notActions: [] };
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Matches `s` literally inside a RegExp. @param {string} s */
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** @param {string} method @param {string} path */
const forbidden = (method, path) => new HttpError(`${method} ${path} returned 403 AuthorizationFailed`, { status: 403, method, url: `https://management.azure.com${path}`, code: 'AuthorizationFailed' });
/** A deployment ARM turned down. @param {string} code @param {string} message */
const refused = (code, message) => new HttpError(`POST /x returned 400 ${code}: ${message}`, { status: 400, method: 'POST', url: 'https://management.azure.com/x', code, body: { error: { code, message } } });

/**
 * An Azure install about to be checked: into existing resource group rg, unless `existing` is false.
 * @param {{ existing?: boolean, az?: Partial<import('../src/config.js').AzureConfig> }} [o]
 */
async function setup(o = {}) {
  const arm = fakeArm();
  const t = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, powerBi: fakePowerBi().api, fabric: fakeFabric().api, ui: t.ui });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, ...o.az };
  if (o.existing !== false) await arm.api.ensureResourceGroup('sub-1', 'rg', 'uksouth');
  return { arm, ctx, config, text: t.text };
}

/** Collects Azure AI and pay-as-you-go costs, and Foundry from Resource Graph. @param {import('../src/config.js').InstallConfig} config */
function withOutsideSources(config) {
  config.modules.consumption = true;
  Object.assign(config.dataSources, { azureAi: 'api', resourceGraph: 'api' });
  Object.assign(config.consumption, { azureSubscriptionId: 'ai-sub', azureSubscriptionName: 'AI', paygSubscriptions: [{ subscriptionId: 'payg-1', policies: ['Copilot'], access: true }, { subscriptionId: 'payg-2', policies: ['Studio'] }] });
}

test('least privilege: the condition allows exactly the roles the ARM template assigns, to give and to remove', () => {
  const template = readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8');
  const inTemplate = [...new Set((template.match(GUID) ?? []).map((g) => g.toLowerCase()))].sort();
  assert.deepEqual(inTemplate, TEMPLATE_ROLES.map((r) => r.id).sort(), `a role the template assigns goes in TEMPLATE_ROLES and in the condition in ${LEAST_PRIVILEGE_DOC}`);
  const condition = roleCondition();
  for (const r of TEMPLATE_ROLES) assert.equal(condition.split(r.id).length - 1, 2, r.name);
  assert.equal((condition.match(GUID) ?? []).length, TEMPLATE_ROLES.length * 2, 'no other role');
  assert.match(condition, /^\(\(!\(ActionMatches\{'Microsoft\.Authorization\/roleAssignments\/write'\}\)\) OR \(@Request\[Microsoft\.Authorization\/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{[^}]+\}\)\) AND /);
  assert.match(condition, / AND \(\(!\(ActionMatches\{'Microsoft\.Authorization\/roleAssignments\/delete'\}\)\) OR \(@Resource\[Microsoft\.Authorization\/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{[^}]+\}\)\)$/);
});

test('least privilege: the admin page has the same condition, every resource provider and the feature flag', () => {
  const doc = readFileSync(new URL(`../../${LEAST_PRIVILEGE_DOC}`, import.meta.url), 'utf8');
  assert.ok(doc.includes(roleCondition()), `the condition in ${LEAST_PRIVILEGE_DOC} matches roleCondition()`);
  assert.match(doc, /--condition-version "?2\.0"?/);
  const all = azureProviders(/** @type {any} */ ({ publicNetworkAccess: false, ask: { mode: 'create' } }));
  assert.deepEqual([...all].sort(), [...AZURE_PROVIDERS, ...PRIVATE_PROVIDERS, ...ASK_PROVIDERS].sort());
  for (const ns of all) assert.match(doc, new RegExp(`\\b${literal(ns)}\\b`), ns);
  assert.ok(doc.includes(`--namespace ${PRIVATE_FEATURE[0]} --name ${PRIVATE_FEATURE[1]}`), PRIVATE_FEATURE.join('/'));
  for (const r of [...TEMPLATE_ROLES, ...AZURE_AI_ROLES]) assert.ok(doc.includes(r.name), r.name);
});

test('least privilege: registered providers say nothing; ones you can\'t register come with the commands for your admin', async () => {
  const quiet = await setup();
  await azurePreflight(quiet.ctx);
  assert.doesNotMatch(quiet.text(), /resource providers|Couldn't check whether/);

  const denied = await setup();
  denied.arm.failures.ensureProvider = [forbidden('POST', `${SUB}/providers/Microsoft.App/register`), forbidden('POST', `${SUB}/providers/Microsoft.Sql/register`)];
  await azurePreflight(denied.ctx);
  assert.match(denied.text(), /You can't register resource providers in this subscription, and Microsoft\.App and Microsoft\.Sql aren't registered yet\. Registering needs Contributor or Owner on the subscription, so ask your Azure admin to run this once:\n +az provider register --subscription sub-1 --namespace Microsoft\.App --wait\n +az provider register --subscription sub-1 --namespace Microsoft\.Sql --wait\n/);
  assert.doesNotMatch(denied.text(), /namespace Microsoft\.Storage/, 'only the ones not registered');
  assert.match(denied.text(), /Until then, Azure can't create the resources that need them\. See docs\/AZURE-LEAST-PRIVILEGE\.md\./);
  assert.ok(denied.arm.calls.includes('validateDeployment'), 'it carries on, and ARM validate says if the deployment can\'t');

  const unread = await setup();
  unread.arm.failures.ensureProvider = [forbidden('GET', `${SUB}/providers/Microsoft.App`)];
  await azurePreflight(unread.ctx);
  assert.match(unread.text(), /Couldn't check whether Microsoft\.App is registered in this subscription\. If Azure says one isn't, your Azure admin registers it once: see docs\/AZURE-LEAST-PRIVILEGE\.md\./);
  assert.doesNotMatch(unread.text(), /You can't register/);

  const broken = await setup();
  broken.arm.failures.ensureProvider = [new Error('Timed out registering the Microsoft.App resource provider.')];
  await azurePreflight(broken.ctx);
  assert.match(broken.text(), /Couldn't register Microsoft\.App: Timed out registering/, 'other failures are reported as before');
});

test('least privilege: a private install\'s feature flag is registered before its provider, and you wait for it', async () => {
  const t = await setup({ existing: false, az: { publicNetworkAccess: false, powerBi: { capacityId: 'cap-f' } } });
  t.arm.failures.ensureProvider = [
    ...AZURE_PROVIDERS.map(() => /** @type {Error} */ (/** @type {unknown} */ (undefined))),
    forbidden('POST', `${SUB}/providers/Microsoft.Network/register`),
  ];
  t.arm.failures.ensureFeature = [forbidden('POST', `${SUB}/providers/Microsoft.Features/providers/Microsoft.Network/features/AllowBringYourOwnPublicIpAddress/register`)];
  await azurePreflight(t.ctx);
  const text = t.text();
  assert.match(text, /and Microsoft\.Network and Microsoft\.Network\/AllowBringYourOwnPublicIpAddress aren't registered yet/);
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('az '));
  assert.deepEqual(lines, [
    'az feature register --subscription sub-1 --namespace Microsoft.Network --name AllowBringYourOwnPublicIpAddress',
    'az feature show --subscription sub-1 --namespace Microsoft.Network --name AllowBringYourOwnPublicIpAddress --query properties.state -o tsv',
    'az provider register --subscription sub-1 --namespace Microsoft.Network --wait',
  ]);
  assert.match(text, /Run the az feature show line until it says Registered before the az provider register lines\./);
  assert.deepEqual(providerCommands('s', ['Microsoft.App', 'Microsoft.Network/F', 'Microsoft.Network']).filter((c) => c.includes('provider register')), [
    'az provider register --subscription s --namespace Microsoft.App --wait',
    'az provider register --subscription s --namespace Microsoft.Network --wait',
  ], 'a provider is registered once, after its feature');
});

test('least privilege: Contributor and a condition-limited Role Based Access Control Administrator on just the resource group are enough', async () => {
  const t = await setup();
  t.arm.perms[SUB] = READ;
  t.arm.perms[RG] = [CONTRIBUTOR, RBAC_ADMIN];
  await azurePreflight(t.ctx);
  assert.ok(t.arm.calls.includes(`permissions ${RG}`), 'an existing resource group is checked there');
  assert.ok(!t.arm.calls.includes(`permissions ${SUB}`), 'not on the subscription');
  assert.ok(t.arm.calls.includes('whatIfDeployment'));

  const owner = await setup();
  await azurePreflight(owner.ctx);
  assert.ok(owner.arm.calls.includes('whatIfDeployment'), 'Owner still installs as before');
});

test('least privilege: missing rights stop before anything is checked or created, with every way to get them', async () => {
  const read = await setup();
  read.arm.perms[RG] = READ;
  await assert.rejects(azurePreflight(read.ctx), (/** @type {Error} */ err) => {
    assert.match(err.message, /^You can't install into resource group rg: you can't deploy resources or assign roles there\.\n/);
    assert.match(err.message, /\n {2}- Owner\n {2}- Contributor and User Access Administrator\n {2}- Least privilege, on just this resource group: Contributor, and Role Based Access Control Administrator limited to the roles the installer assigns\. Your Azure admin can set it up with docs\/AZURE-LEAST-PRIVILEGE\.md\.\n/);
    assert.match(err.message, /Privileged Identity Management/);
    return true;
  });
  assert.ok(!read.arm.calls.includes('validateDeployment'));

  const contributor = await setup();
  contributor.arm.perms[RG] = [CONTRIBUTOR];
  await assert.rejects(azurePreflight(contributor.ctx), /you can't assign roles there\./);

  const fresh = await setup({ existing: false, az: { resourceGroup: 'rg-new', subscriptionName: 'Production' } });
  fresh.arm.perms[SUB] = READ;
  await assert.rejects(azurePreflight(fresh.ctx), (/** @type {Error} */ err) => {
    assert.match(err.message, /^You can't create resource group rg-new and install into it: you can't create resource groups, deploy resources or assign roles in subscription Production\.\n/);
    assert.match(err.message, /Owner, or Contributor and User Access Administrator, on the subscription/);
    assert.match(err.message, /ask your Azure admin to create the resource group .*docs\/AZURE-LEAST-PRIVILEGE\.md.*pick it as an existing resource group\./);
    return true;
  });
  assert.ok(!fresh.arm.calls.some((c) => c.startsWith('ensureResourceGroup')), 'nothing is created');

  const unreadable = await setup();
  unreadable.arm.failures.permissions = [forbidden('GET', `${RG}/providers/Microsoft.Authorization/permissions`)];
  await azurePreflight(unreadable.ctx);
  assert.ok(unreadable.arm.calls.includes('whatIfDeployment'), 'rights that can\'t be read stop nothing');
});

test('least privilege: ARM errors for an unregistered provider or a role you can\'t assign say what to do', async () => {
  const t = await setup();
  t.arm.failures.validateDeployment = [refused('MissingSubscriptionRegistration', "The subscription is not registered to use namespace 'Microsoft.App'. See https://aka.ms/rps-not-found for how to register subscriptions.")];
  await assert.rejects(azurePreflight(t.ctx), (/** @type {Error} */ err) => {
    assert.equal(err.message, [
      "Azure says Microsoft.App isn't registered in this subscription. Someone with Contributor or Owner on the subscription registers it once:",
      'az provider register --subscription sub-1 --namespace Microsoft.App --wait',
      'Then run the installer again. See docs/AZURE-LEAST-PRIVILEGE.md.',
    ].join('\n'));
    return true;
  });

  const feature = registrationMessage(refused('SubscriptionNotRegisteredForFeature', 'Subscription sub-1 is not registered for feature Microsoft.Network/AllowBringYourOwnPublicIpAddress required to carry out the requested operation.'), 'sub-1', []);
  assert.match(feature, /^Azure says Microsoft\.Network\/AllowBringYourOwnPublicIpAddress isn't registered/);
  assert.match(feature, /\naz feature register --subscription sub-1 --namespace Microsoft\.Network --name AllowBringYourOwnPublicIpAddress\n/);
  assert.match(feature, /\naz provider register --subscription sub-1 --namespace Microsoft\.Network --wait\n/);
  const unnamed = registrationMessage({ message: 'MissingSubscriptionRegistration' }, undefined, ['Microsoft.App']);
  assert.match(unnamed, /^Azure says a resource provider this install uses isn't registered.*\naz provider register --subscription <subscription ID> --namespace Microsoft\.App --wait\n/s);
  assert.equal(registrationMessage(refused('InvalidTemplate', 'Bad template'), 'sub-1', ['Microsoft.App']), '');

  const scope = `${RG}/providers/Microsoft.Storage/storageAccounts/stvlens`;
  const denied = roleAssignMessage(refused('AuthorizationFailed', `The client 'admin@contoso.com' with object id 'user-1' does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write' over scope '${scope}/providers/Microsoft.Authorization/roleAssignments/abc' or the scope is invalid.`));
  assert.match(denied, new RegExp(`^Azure wouldn't let you assign a role on ${literal(scope)}\\.\\n`));
  assert.match(denied, /Owner, User Access Administrator, or Role Based Access Control Administrator with a condition that allows these roles, on the resource group \(docs\/AZURE-LEAST-PRIVILEGE\.md\)/);
  assert.equal(roleAssignMessage(refused('AuthorizationFailed', "does not have authorization to perform action 'Microsoft.Sql/servers/write'")), '', 'only role assignments');

  const failed = await setup();
  failed.arm.failures.validateDeployment = [refused('AuthorizationFailed', `does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write' over scope '${scope}/providers/Microsoft.Authorization/roleAssignments/abc'`)];
  await assert.rejects(azurePreflight(failed.ctx), /Error: Azure wouldn't let you assign a role on \/subscriptions\/sub-1\/resourceGroups\/rg\/providers\/Microsoft\.Storage\/storageAccounts\/stvlens\.\n/);
});

test('least privilege: roles outside the resource group you can\'t give are printed for your Azure admin', async () => {
  const t = await setup();
  withOutsideSources(t.config);
  t.arm.perms['/subscriptions/ai-sub'] = READ;
  t.arm.perms['/subscriptions/payg-2'] = READ;
  t.arm.perms['/providers/Microsoft.Management/managementGroups/tenant-1'] = READ;
  await azurePreflight(t.ctx);
  const text = t.text();
  assert.match(text, /For your Azure admin: the install's managed identity needs these roles outside resource group rg, and you can't give them:\n/);
  assert.match(text, new RegExp(`\\n +${AZURE_AI_ROLES.map((r) => r.name).join(', ')} on subscription AI: Azure AI costs and metrics\\n`));
  assert.match(text, /\n +Cost Management Reader on subscription payg-2: Copilot pay-as-you-go costs\n/);
  assert.doesNotMatch(text, /payg-1/, 'one it already has is left out');
  assert.match(text, /\n +Reader on the tenant root management group: Foundry, from Resource Graph\n/);
  assert.match(text, /\n +az identity list --subscription sub-1 --resource-group rg --query "\[\?starts_with\(name, 'id-vlens-collector-'\)\]\.principalId" -o tsv\n/);
  for (const r of AZURE_AI_ROLES) assert.ok(text.includes(`az role assignment create --assignee-object-id <managed identity principal ID> --assignee-principal-type ServicePrincipal --role "${r.name}" --scope /subscriptions/ai-sub\n`), r.name);
  assert.ok(text.includes('--role "Reader" --scope /providers/Microsoft.Management/managementGroups/tenant-1\n'));
  assert.match(text, /The install finishes without them and leaves those sources out until they're there\./);

  const known = await setup();
  withOutsideSources(known.config);
  /** @type {any} */ (known.config.azure).outputs = { identityPrincipalId: 'mi-1' };
  known.config.resourceGraph = { ...known.config.resourceGraph, managementGroup: 'mg-1' };
  known.arm.perms['/subscriptions/ai-sub'] = READ;
  known.arm.perms['/providers/Microsoft.Management/managementGroups/mg-1'] = READ;
  await azurePreflight(known.ctx);
  assert.ok(known.text().includes('az role assignment create --assignee-object-id mi-1 --assignee-principal-type ServicePrincipal --role "Reader" --scope /providers/Microsoft.Management/managementGroups/mg-1\n'));
  assert.match(known.text(), /Reader on management group mg-1: Foundry, from Resource Graph/);
  assert.doesNotMatch(known.text(), /az identity list/, 'its principal ID is known after the first deploy');
  assert.doesNotMatch(known.text(), /payg-2/, 'you can give that one yourself');
});

test('least privilege: nothing to print when you can give the roles, they\'re there, or it\'s demo data; unread rights are printed', async () => {
  const owner = await setup();
  withOutsideSources(owner.config);
  await azurePreflight(owner.ctx);
  assert.doesNotMatch(owner.text(), /For your Azure admin/);

  const given = await setup();
  withOutsideSources(given.config);
  given.config.consumption.azureAccess = true;
  given.config.consumption.paygSubscriptions = [];
  given.config.resourceGraph = { ...given.config.resourceGraph, azureAccess: true };
  assert.deepEqual(adminGrants(given.config, 'tenant-1'), []);

  const demo = await setup({ az: { sampleData: true } });
  withOutsideSources(demo.config);
  demo.arm.perms['/subscriptions/ai-sub'] = READ;
  await azurePreflight(demo.ctx);
  assert.doesNotMatch(demo.text(), /For your Azure admin/);
  assert.ok(!demo.arm.calls.includes('permissions /subscriptions/ai-sub'));

  const fresh = await setup({ existing: false, az: { resourceGroup: 'rg-new' } });
  withOutsideSources(fresh.config);
  fresh.config.dataSources.resourceGraph = 'skip';
  fresh.arm.failures.permissions = [undefined, forbidden('GET', '/subscriptions/ai-sub/providers/Microsoft.Authorization/permissions')].map((e) => /** @type {Error} */ (e));
  await azurePreflight(fresh.ctx);
  assert.match(fresh.text(), /outside resource group rg-new, and you can't give them \(or the installer couldn't check\):/, 'a new resource group gets them too');
  assert.match(fresh.text(), /--scope \/subscriptions\/ai-sub\n/);
  assert.doesNotMatch(fresh.text(), /Resource Graph/);
});
