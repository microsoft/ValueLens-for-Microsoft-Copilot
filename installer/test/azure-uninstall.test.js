// @ts-check
// Uninstall from a resource group the installer didn't create: it deletes only what it tagged there.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient, HttpError } from '../src/http.js';
import { apiVersionResolver, armApi, DEPLOYED_API_VERSIONS, pickApiVersion, resourceIdParts } from '../src/clients/azure.js';
import { azureUninstall, IN_USE_WAIT_MS, RESOURCE_DELETE_WAIT_MS } from '../src/steps/azure/index.js';
import { runCommand } from '../src/install.js';
import { loadConfig } from '../src/config.js';
import { ARM_API_VERSIONS, fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError } from './fakes.js';

const RG_ID = '/subscriptions/sub-1/resourceGroups/rg-shared';
const TAG = { 'valuelens-install-id': 'install-1' };
const armId = (/** @type {string} */ type, /** @type {string} */ name) => `${RG_ID}/providers/${type}/${name}`;
const VNET = armId('Microsoft.Network/virtualNetworks', 'vnet-vlens-abc');
const SQL_ZONE = armId('Microsoft.Network/privateDnsZones', 'privatelink.database.windows.net');
const BLOB_ZONE = armId('Microsoft.Network/privateDnsZones', 'privatelink.blob.core.windows.net');
const ID = {
  web: armId('Microsoft.App/containerApps', 'vlens-web'),
  run: armId('Microsoft.App/jobs', 'vlens-run'),
  migrate: armId('Microsoft.App/jobs', 'vlens-migrate'),
  env: armId('Microsoft.App/managedEnvironments', 'cae-vlens-abc'),
  sql: armId('Microsoft.Sql/servers', 'vlens-sql-abc'),
  db: `${armId('Microsoft.Sql/servers', 'vlens-sql-abc')}/databases/valuelens`,
  storage: armId('Microsoft.Storage/storageAccounts', 'vlensstabc'),
  ai: armId('Microsoft.CognitiveServices/accounts', 'vlens-ai-abc'),
  logs: armId('Microsoft.OperationalInsights/workspaces', 'vlens-logs-abc'),
  identity: armId('Microsoft.ManagedIdentity/userAssignedIdentities', 'vlens-id-abc'),
  vnet: VNET,
  nsg: armId('Microsoft.Network/networkSecurityGroups', 'nsg-vlens-abc'),
  sqlEndpoint: armId('Microsoft.Network/privateEndpoints', 'pe-vlens-sql'),
  blobEndpoint: armId('Microsoft.Network/privateEndpoints', 'pe-vlens-blob'),
  sqlZone: SQL_ZONE,
  blobZone: BLOB_ZONE,
  sqlLink: `${SQL_ZONE}/virtualNetworkLinks/vnet-vlens-abc`,
  blobLink: `${BLOB_ZONE}/virtualNetworkLinks/vnet-vlens-abc`,
  theirs: armId('Microsoft.Storage/storageAccounts', 'theirs'),
};
const PUBLIC_ORDER = [ID.web, ID.run, ID.migrate, ID.env, ID.sql, ID.storage, ID.ai, ID.logs, ID.identity];
const PRIVATE_ORDER = [ID.web, ID.run, ID.migrate, ID.env, ID.sqlEndpoint, ID.blobEndpoint, ID.sqlLink, ID.blobLink, ID.sqlZone, ID.blobZone, ID.vnet, ID.nsg, ID.sql, ID.storage, ID.ai, ID.logs, ID.identity];

/** A resource as ARM lists it. @param {string} id @param {any} [properties] @param {Record<string, string>} [tags] */
function resource(id, properties = {}, tags = TAG) {
  const { type, name } = resourceIdParts(id);
  return { id, name, type, location: 'uksouth', tags, properties };
}

const subnet = (/** @type {string} */ name) => `${VNET}/subnets/${name}`;

/**
 * An Azure install into resource group rg-shared, which was there before it, and what it tagged there,
 * listed in no useful order. Private networking adds the VNet, its NSG, the private endpoints and DNS zones,
 * and the Power BI VNet data gateway.
 * @param {{ private?: boolean }} [o]
 */
function existingGroupInstall(o = {}) {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const ui = fakeUi();
  const { ctx, config, sleeps } = fakeCtx({ ui: ui.ui, arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: fakePowerBi().api });
  config.target = 'azure';
  config.azure = {
    subscriptionId: 'sub-1',
    resourceGroup: 'rg-shared',
    resourceGroupMode: 'existing',
    createdResourceGroup: false,
    location: 'uksouth',
    namePrefix: 'vlens',
    installId: 'install-1',
    publicNetworkAccess: !o.private,
    powerBi: { connectionId: 'conn-1', ...(o.private ? { gatewayId: 'gw-1', createdGateway: true } : {}) },
    webApp: { clientId: 'web-client', objectId: 'web-obj', created: true },
    sqlReader: { clientId: 'sql-client', objectId: 'sql-obj', created: true },
  };
  arm.resources.push(
    resource(ID.identity),
    resource(ID.db),
    resource(ID.sql),
    resource(ID.theirs, {}, {}),
    resource(ID.logs),
    resource(ID.env, o.private ? { vnetConfiguration: { infrastructureSubnetId: subnet('snet-apps') } } : {}),
    resource(ID.storage),
    resource(ID.web, { environmentId: ID.env }),
    resource(ID.ai),
    resource(ID.run, { environmentId: ID.env }),
    resource(ID.migrate, { environmentId: ID.env }),
  );
  if (o.private) {
    arm.resources.push(
      resource(ID.nsg),
      resource(ID.vnet, { subnets: ['snet-apps', 'snet-pe', 'snet-powerbi-gateway'].map((s) => ({ id: subnet(s), name: s, properties: { networkSecurityGroup: { id: ID.nsg } } })) }),
      resource(ID.sqlZone),
      resource(ID.sqlLink, { virtualNetwork: { id: ID.vnet } }),
      resource(ID.sqlEndpoint, { subnet: { id: subnet('snet-pe') } }),
      resource(ID.blobZone),
      resource(ID.blobLink, { virtualNetwork: { id: ID.vnet } }),
      resource(ID.blobEndpoint, { subnet: { id: subnet('snet-pe') } }),
    );
  }
  return { arm, graph, fabric, ui, ctx, config, sleeps, az: /** @type {any} */ (config.azure) };
}

/** What uninstall asked Azure to delete, in the order it first asked. @param {ReturnType<typeof fakeArm>} arm */
const deleted = (arm) => [...new Set(arm.calls.filter((c) => c.startsWith('deleteResource ')).map((c) => c.slice('deleteResource '.length)))];
const remaining = (/** @type {ReturnType<typeof fakeArm>} */ arm) => arm.resources.map((r) => r.id).sort();
const count = (/** @type {string[]} */ calls, /** @type {string} */ call) => calls.filter((c) => c === call).length;
const sum = (/** @type {number[]} */ ms) => ms.reduce((a, b) => a + b, 0);
const appDeletes = (/** @type {ReturnType<typeof fakeAzureGraph>} */ graph) => graph.calls.filter((c) => c.startsWith('deleteApplication'));

test('ARM refuses an api-version the resource type does not offer, as the fake now does: 2021-04-01 only works for Storage', async () => {
  const { arm } = existingGroupInstall();
  for (const r of arm.resources.filter((x) => x.tags['valuelens-install-id'])) {
    if (r.type === 'Microsoft.Storage/storageAccounts') continue;
    await assert.rejects(arm.api.deleteResource(r.id, '2021-04-01'), (err) => err instanceof HttpError && err.status === 400 && err.code === 'NoRegisteredProviderFound', r.type);
  }
  assert.deepEqual(await arm.api.deleteResource(ID.storage, '2021-04-01'), { status: 200 });
  for (const [key, version] of Object.entries(DEPLOYED_API_VERSIONS)) {
    const types = Object.keys(ARM_API_VERSIONS).filter((t) => t === key || t.startsWith(`${key}/`));
    for (const t of types.filter((type) => !Object.keys(DEPLOYED_API_VERSIONS).some((k) => k !== key && k.length > key.length && (type === k || type.startsWith(`${k}/`))))) {
      assert.ok(ARM_API_VERSIONS[t].includes(version), `the fake offers ${t} the version azure/infra deploys it with, ${version}`);
    }
  }
});

test('pickApiVersion takes the newest that is not a preview, else the newest', () => {
  assert.equal(pickApiVersion(['2023-05-01', '2025-02-02-preview', '2024-03-01']), '2024-03-01');
  assert.equal(pickApiVersion(['2024-01-01-beta', '2023-01-01', '2024-06-01-alpha']), '2023-01-01');
  assert.equal(pickApiVersion(['2022-05-01-preview', '2023-08-01-preview']), '2023-08-01-preview');
  assert.equal(pickApiVersion([]), undefined);
  assert.equal(pickApiVersion(undefined), undefined);
});

test('apiVersionResolver prefers the deployed version while its provider offers it, reads each provider once and falls back when it cannot', async () => {
  /** @type {string[]} */
  const read = [];
  /** @type {Record<string, any>} */
  const providers = {
    'Microsoft.App': {
      resourceTypes: [
        { resourceType: 'jobs', apiVersions: ['2025-01-01', '2024-03-01', '2023-05-01'] },
        { resourceType: 'managedEnvironments', apiVersions: ['2025-01-01', '2025-10-02-preview'] },
      ],
    },
    'Microsoft.Insights': { resourceTypes: [{ resourceType: 'components', apiVersions: ['2015-05-01', '2020-02-02', '2022-04-01-preview'] }] },
  };
  const versionFor = apiVersionResolver(async (namespace) => {
    read.push(namespace);
    if (namespace === 'Microsoft.Sql') throw httpError(403, 'AuthorizationFailed');
    return providers[namespace] ?? { resourceTypes: [] };
  });
  assert.equal(await versionFor('Microsoft.App/jobs'), '2024-03-01', 'the deployed version, which the provider still offers');
  assert.equal(await versionFor('Microsoft.App/managedEnvironments'), '2025-01-01', 'else the newest that is not a preview');
  assert.equal(await versionFor('microsoft.app/containerApps'), '2024-03-01', 'a type the provider does not list: the deployed version');
  assert.equal(await versionFor('Microsoft.Sql/servers/databases'), '2023-08-01-preview', 'a provider it cannot read: the deployed version');
  assert.equal(await versionFor('Microsoft.Sql/servers'), '2023-08-01-preview');
  assert.equal(await versionFor('Microsoft.Network/privateDnsZones/virtualNetworkLinks'), '2024-06-01');
  assert.equal(await versionFor('Microsoft.Network/privateDnsZones'), '2024-06-01');
  assert.equal(await versionFor('Microsoft.Network/virtualNetworks'), '2024-05-01');
  assert.equal(await versionFor('Microsoft.Insights/components'), '2020-02-02', 'a type azure/infra does not deploy: the newest the provider offers');
  assert.equal(await versionFor('Microsoft.Example/things'), '2021-04-01', 'nothing known at all: the generic resources version');
  assert.deepEqual(read, ['Microsoft.App', 'Microsoft.Sql', 'Microsoft.Network', 'Microsoft.Insights', 'Microsoft.Example'], 'each provider is read once, whatever its case');
});

test('resourceIdParts gives the full type, the name and a child resource\'s parent', () => {
  assert.deepEqual(resourceIdParts(ID.run), { type: 'Microsoft.App/jobs', name: 'vlens-run', parent: undefined });
  assert.deepEqual(resourceIdParts(`${ID.run}/`), { type: 'Microsoft.App/jobs', name: 'vlens-run', parent: undefined });
  assert.deepEqual(resourceIdParts(ID.db), { type: 'Microsoft.Sql/servers/databases', name: 'valuelens', parent: ID.sql });
  assert.deepEqual(resourceIdParts(ID.sqlLink), { type: 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', name: 'vnet-vlens-abc', parent: ID.sqlZone });
  for (const bad of [RG_ID, `${RG_ID}/providers/Microsoft.App`, `${RG_ID}/providers/Microsoft.App/jobs`, `${ID.run}/executions`, 'vlens-run']) {
    assert.throws(() => resourceIdParts(bad), /Not a resource ID/, bad);
  }
});

test('armApi deleteResource sends the api-version it is given and reports a 202 with its Retry-After; getResource is null once the resource has gone', async () => {
  /** @type {{ method: string, url: string }[]} */
  const calls = [];
  /** @type {(() => Response)[]} */
  const answers = [
    () => new Response(null, { status: 202, headers: { 'Retry-After': '15', Location: 'https://management.azure.com/operations/1' } }),
    () => new Response(null, { status: 200 }),
    () => Response.json({ id: ID.run, properties: { provisioningState: 'Deleting' } }),
    () => Response.json({ error: { code: 'ResourceNotFound', message: `The Resource '${ID.run}' was not found.` } }, { status: 404 }),
    () => Response.json({ error: { code: 'AuthorizationFailed', message: 'No access.' } }, { status: 403 }),
    () => Response.json({ error: { code: 'NoRegisteredProviderFound', message: "No registered resource provider found for API version '2021-04-01'." } }, { status: 400 }),
    () => Response.json({ error: { code: 'ResourceNotFound', message: 'Not found.' } }, { status: 404 }),
  ];
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ method: init.method, url: String(url) });
        const next = answers.shift();
        if (!next) throw new Error(`Unexpected request: ${init.method} ${url}`);
        return next();
      }
    )
  );
  const api = armApi(createClient({ baseUrl: 'https://management.azure.com', getToken: async () => 'tok', fetchImpl, sleep: async () => {} }));
  assert.deepEqual(await api.deleteResource(ID.run, '2024-03-01'), { status: 202, retryAfterMs: 15_000 });
  assert.deepEqual(calls[0], { method: 'DELETE', url: `https://management.azure.com${ID.run}?api-version=2024-03-01` });
  assert.deepEqual(await api.deleteResource(ID.storage, '2023-05-01'), { status: 200, retryAfterMs: undefined });
  assert.equal((await api.getResource(ID.run, '2024-03-01'))?.properties?.provisioningState, 'Deleting');
  assert.deepEqual(calls[2], { method: 'GET', url: `https://management.azure.com${ID.run}?api-version=2024-03-01` });
  assert.equal(await api.getResource(ID.run, '2024-03-01'), null);
  await assert.rejects(api.getResource(ID.run, '2024-03-01'), (err) => err instanceof HttpError && err.status === 403);
  await assert.rejects(api.deleteResource(ID.env, '2021-04-01'), (err) => err instanceof HttpError && err.status === 400 && err.code === 'NoRegisteredProviderFound');
  await assert.rejects(api.deleteResource(ID.db, '2023-08-01-preview'), (err) => err instanceof HttpError && err.status === 404, 'a delete that finds nothing throws 404, which uninstall reads as already gone');
  assert.equal(answers.length, 0);
});

test('uninstall from a resource group it did not create deletes what it tagged, each with a version its provider offers and before what it depends on, and leaves the rest', async () => {
  const t = existingGroupInstall();
  /** @type {Record<string, string>} */
  const versions = {};
  const del = t.arm.api.deleteResource;
  t.arm.api.deleteResource = async (id, apiVersion) => {
    versions[resourceIdParts(id).type] = apiVersion;
    return del(id, apiVersion);
  };
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(deleted(t.arm), PUBLIC_ORDER);
  assert.equal(count(t.arm.calls, `deleteResource ${ID.db}`), 0, 'the database goes with its server');
  assert.ok(!t.arm.calls.some((c) => c.startsWith('deleteResourceGroup')), 'never the group');
  assert.deepEqual(remaining(t.arm), [ID.theirs], 'and nothing it did not tag');
  assert.deepEqual(versions, {
    'Microsoft.App/containerApps': '2024-03-01',
    'Microsoft.App/jobs': '2024-03-01',
    'Microsoft.App/managedEnvironments': '2024-03-01',
    'Microsoft.Sql/servers': '2023-08-01-preview',
    'Microsoft.Storage/storageAccounts': '2023-05-01',
    'Microsoft.CognitiveServices/accounts': '2024-10-01',
    'Microsoft.OperationalInsights/workspaces': '2023-09-01',
    'Microsoft.ManagedIdentity/userAssignedIdentities': '2023-01-31',
  });
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('delete')), ['deleteConnection conn-1']);
  assert.deepEqual(appDeletes(t.graph), ['deleteApplication web-obj', 'deleteApplication sql-obj']);
  assert.deepEqual(t.sleeps, [], 'nothing to wait for when Azure deletes each at once');
  const text = t.ui.text();
  assert.match(text, /Deleted vlens-web \(Microsoft\.App\/containerApps\)/);
  assert.match(text, /Deleted vlens-id-abc \(Microsoft\.ManagedIdentity\/userAssignedIdentities\)/);
  assert.match(text, /Deleted 10 tagged Azure resources and left everything else alone/);
  assert.doesNotMatch(text, /Couldn't|isn't all gone/);
});

test('uninstall uses the newest version the provider offers when it no longer offers the deployed one, and the deployed one when it cannot read the provider', async () => {
  const newer = existingGroupInstall();
  const offered = ['2025-01-01', '2025-10-02-preview'];
  newer.arm.regions.providers['Microsoft.App'] = { namespace: 'Microsoft.App', resourceTypes: ['containerApps', 'jobs', 'managedEnvironments'].map((resourceType) => ({ resourceType, apiVersions: offered })) };
  assert.equal(await azureUninstall(newer.ctx), true);
  assert.deepEqual(remaining(newer.arm), [ID.theirs]);

  const locked = existingGroupInstall();
  locked.arm.api.getProvider = async () => {
    throw httpError(403, 'AuthorizationFailed');
  };
  assert.equal(await azureUninstall(locked.ctx), true, 'someone with rights only in the group still uninstalls');
  assert.deepEqual(remaining(locked.arm), [ID.theirs]);
});

test('uninstall waits for each delete Azure accepts with a 202, at its Retry-After, before deleting what it depended on', async () => {
  const t = existingGroupInstall();
  t.arm.deleteStates[ID.run] = ['Deleting'];
  t.arm.deleteStates[ID.env] = ['Deleting', 'Deleting', 'Deleting'];
  assert.equal(await azureUninstall(t.ctx), true);
  assert.deepEqual(t.sleeps, [15_000, 15_000, 15_000, 15_000, 15_000, 15_000]);
  assert.equal(count(t.arm.calls, `getResource ${ID.env}`), 4);
  const calls = t.arm.calls;
  assert.ok(calls.indexOf(`deleteResource ${ID.env}`) > calls.lastIndexOf(`getResource ${ID.run}`), 'the job had gone before the environment was deleted');
  assert.ok(calls.indexOf(`deleteResource ${ID.sql}`) > calls.lastIndexOf(`getResource ${ID.env}`));
  assert.deepEqual(remaining(t.arm), [ID.theirs]);
});

test('a delete Azure has not finished after RESOURCE_DELETE_WAIT_MS is reported as left, and uninstall fails', async () => {
  const t = existingGroupInstall();
  t.arm.deleteStates[ID.storage] = Array(500).fill('Deleting');
  assert.equal(await azureUninstall(t.ctx), false);
  assert.equal(sum(t.sleeps), RESOURCE_DELETE_WAIT_MS);
  assert.deepEqual(deleted(t.arm), PUBLIC_ORDER, 'the rest still goes');
  assert.match(t.ui.text(), /Couldn't delete vlensstabc \(Microsoft\.Storage\/storageAccounts\): Azure hadn't finished deleting it after 20 minutes \(Deleting\)/);
  assert.match(t.ui.text(), /Still there: vlensstabc \(Microsoft\.Storage\/storageAccounts\)\./);
  assert.deepEqual(appDeletes(t.graph), ['deleteApplication web-obj', 'deleteApplication sql-obj']);
});

test('a Container Apps environment Azure says still has apps is asked again, whether it answers 409 or 400', async () => {
  const conflict = existingGroupInstall();
  conflict.arm.inUse[ID.env] = 2;
  assert.equal(await azureUninstall(conflict.ctx), true);
  assert.deepEqual(conflict.sleeps, [15_000, 30_000]);
  assert.equal(count(conflict.arm.calls, `deleteResource ${ID.env}`), 3);
  assert.deepEqual(remaining(conflict.arm), [ID.theirs]);

  const bad = existingGroupInstall();
  const del = bad.arm.api.deleteResource;
  let refused = 0;
  bad.arm.api.deleteResource = async (id, apiVersion) => {
    if (id === ID.env && !refused++) {
      const message = "Managed environment 'cae-vlens-abc' cannot be deleted because it still contains 1 ContainerApps.";
      throw new HttpError(`DELETE ${id} returned 400 ManagedEnvironmentHasContainerApps: ${message}`, { status: 400, method: 'DELETE', url: `https://management.azure.com${id}`, code: 'ManagedEnvironmentHasContainerApps', body: { error: { code: 'ManagedEnvironmentHasContainerApps', message } } });
    }
    return del(id, apiVersion);
  };
  assert.equal(await azureUninstall(bad.ctx), true);
  assert.deepEqual(bad.sleeps, [15_000]);
  assert.deepEqual(remaining(bad.arm), [ID.theirs]);
});

test('a SQL database goes with its server, and one still listed after its server has gone was already gone', async () => {
  const t = existingGroupInstall();
  const server = t.arm.resources.findIndex((r) => r.id === ID.sql);
  t.arm.resources.splice(server, 1);
  const db = t.arm.resources.splice(t.arm.resources.findIndex((r) => r.id === ID.db), 1)[0];
  const list = t.arm.api.listResources;
  // ARM's list can lag a delete.
  t.arm.api.listResources = async () => [...(await list()), db];
  assert.equal(await azureUninstall(t.ctx), true);
  assert.equal(count(t.arm.calls, `deleteResource ${ID.db}`), 1);
  assert.match(t.ui.text(), /valuelens \(Microsoft\.Sql\/servers\/databases\) was already gone/);
  assert.doesNotMatch(t.ui.text(), /Couldn't/);
});

test('private networking: uninstall deletes in dependency order and asks again while a subnet is still in use', async () => {
  const t = existingGroupInstall({ private: true });
  t.arm.inUse[ID.vnet] = 4;
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(deleted(t.arm), PRIVATE_ORDER);
  assert.deepEqual(t.sleeps, [15_000, 30_000, 60_000, 60_000]);
  assert.equal(count(t.arm.calls, `deleteResource ${ID.vnet}`), 5);
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('delete')), ['deleteConnection conn-1', 'deleteGateway gw-1']);
  assert.deepEqual(remaining(t.arm), [ID.theirs]);
  assert.match(t.ui.text(), /Deleted 18 tagged Azure resources and left everything else alone/);
});

test('an environment that stays in use is reported as left after IN_USE_WAIT_MS, and what depends on it is not waited for', async () => {
  const t = existingGroupInstall({ private: true });
  // Someone else's app in the environment.
  const theirApp = armId('Microsoft.App/containerApps', 'their-app');
  t.arm.resources.push(resource(theirApp, { environmentId: ID.env }, {}));
  assert.equal(await azureUninstall(t.ctx), false);
  assert.ok(sum(t.sleeps) >= IN_USE_WAIT_MS && sum(t.sleeps) < IN_USE_WAIT_MS + 60_000, `waited ${sum(t.sleeps)} ms`);
  assert.equal(count(t.arm.calls, `deleteResource ${ID.vnet}`), 1, 'the VNet the environment uses fails at once');
  assert.equal(count(t.arm.calls, `deleteResource ${ID.nsg}`), 1);
  assert.deepEqual(remaining(t.arm), [ID.env, ID.vnet, ID.nsg, ID.theirs, theirApp].sort());
  const text = t.ui.text();
  assert.match(text, /Couldn't delete cae-vlens-abc \(Microsoft\.App\/managedEnvironments\): Conflict: Cannot delete cae-vlens-abc because it still contains ContainerApps or Jobs\./);
  assert.match(text, /Couldn't delete vnet-vlens-abc \(Microsoft\.Network\/virtualNetworks\): InUseSubnetCannotBeDeleted: /);
  assert.match(text, /Analytics Hub isn't all gone from resource group rg-shared\. Still there: cae-vlens-abc \(Microsoft\.App\/managedEnvironments\), vnet-vlens-abc \(Microsoft\.Network\/virtualNetworks\), nsg-vlens-abc \(Microsoft\.Network\/networkSecurityGroups\)\./);
  assert.deepEqual(appDeletes(t.graph), ['deleteApplication web-obj', 'deleteApplication sql-obj']);
});

test('while the Power BI gateway is left, its VNet is not waited for, but the environment still is', async () => {
  const t = existingGroupInstall({ private: true });
  t.fabric.failures.deleteGateway = [httpError(403, 'Forbidden')];
  t.arm.inUse[ID.env] = 1;
  t.arm.inUse[ID.vnet] = 99;
  assert.equal(await azureUninstall(t.ctx), false);
  assert.deepEqual(t.sleeps, [15_000]);
  assert.equal(count(t.arm.calls, `deleteResource ${ID.vnet}`), 1);
  const text = t.ui.text();
  assert.match(text, /Couldn't delete Power BI gateway gw-1: Forbidden/);
  assert.match(text, /Still there: vnet-vlens-abc \(Microsoft\.Network\/virtualNetworks\), nsg-vlens-abc \(Microsoft\.Network\/networkSecurityGroups\)\./);
});

test('a failure part-way still deletes the rest and the app registrations, keeps the record, and uninstalling again finishes the job', async () => {
  const t = existingGroupInstall({ private: true });
  t.arm.locks.add(ID.sql);
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), false);
  assert.deepEqual(deleted(t.arm), PRIVATE_ORDER, 'it carries on past the SQL server');
  assert.equal(count(t.arm.calls, `deleteResource ${ID.sql}`), 1, 'a lock is not waited on');
  assert.deepEqual(t.sleeps, []);
  assert.deepEqual(remaining(t.arm), [ID.sql, ID.db, ID.theirs].sort());
  assert.deepEqual(appDeletes(t.graph), ['deleteApplication web-obj', 'deleteApplication sql-obj']);
  const first = t.ui.text();
  assert.match(first, /Couldn't delete vlens-sql-abc \(Microsoft\.Sql\/servers\): ScopeLocked: /);
  assert.match(first, /Still there: vlens-sql-abc \(Microsoft\.Sql\/servers\)\. Run ".*uninstall" again to finish, or delete them in the Azure portal in that order: they have the tag valuelens-install-id = install-1\./);
  assert.equal(t.az.subscriptionId, 'sub-1');
  assert.equal(t.az.resourceGroup, 'rg-shared');
  assert.equal(t.az.installId, 'install-1');

  // The lock has gone. The connection, the gateway and the app registrations went the first time.
  t.arm.locks.delete(ID.sql);
  t.fabric.failures.deleteConnection = [httpError(404)];
  t.fabric.failures.deleteGateway = [httpError(404)];
  t.graph.failures.deleteApplication = [httpError(404), httpError(404)];
  const from = t.ui.out.length;
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(remaining(t.arm), [ID.theirs]);
  const again = t.ui.out.slice(from).join('');
  assert.match(again, /The Power BI gateway connection was already gone/);
  assert.match(again, /The Power BI VNet data gateway was already gone/);
  assert.match(again, /Deleted vlens-sql-abc \(Microsoft\.Sql\/servers\)/);
  assert.match(again, /Deleted 2 tagged Azure resources and left everything else alone/);
  assert.doesNotMatch(again, /Couldn't|isn't all gone/);
});

test('when the resource group cannot be listed, the app registrations still go and uninstall fails; when the group has gone, it succeeds', async () => {
  const t = existingGroupInstall();
  t.arm.failures.listResources = [httpError(403, 'AuthorizationFailed')];
  assert.equal(await azureUninstall(t.ctx), false);
  assert.match(t.ui.text(), /Couldn't list the resources in resource group rg-shared: /);
  assert.match(t.ui.text(), /Couldn't see what's left of Analytics Hub in resource group rg-shared\./);
  assert.deepEqual(appDeletes(t.graph), ['deleteApplication web-obj', 'deleteApplication sql-obj']);
  assert.deepEqual(deleted(t.arm), []);

  const gone = existingGroupInstall();
  gone.arm.failures.listResources = [httpError(404, 'ResourceGroupNotFound')];
  assert.equal(await azureUninstall(gone.ctx), true);
  assert.match(gone.ui.text(), /Resource group rg-shared was already gone/);
});

test('a record with no install ID leaves everything in a resource group it did not create alone, untagged resources too, and says why', async () => {
  const t = existingGroupInstall();
  // Saved with an existing group chosen, before the install got as far as deploying anything.
  t.config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg-shared', resourceGroupMode: 'existing' };
  const noTags = /** @type {any} */ (resource(armId('Microsoft.Storage/storageAccounts', 'theirstoo')));
  delete noTags.tags;
  t.arm.resources.push(noTags, resource(armId('Microsoft.ManagedIdentity/userAssignedIdentities', 'their-id'), {}, {}));
  const before = remaining(t.arm);
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(t.arm.calls.filter((c) => c.startsWith('deleteResource') || c.startsWith('getResource')), [], 'nothing deleted or waited for');
  assert.deepEqual(remaining(t.arm), before, 'everything is still there');
  assert.deepEqual(appDeletes(t.graph), []);
  const text = t.ui.text();
  assert.match(text, /Left everything in resource group rg-shared alone: this install record has no install ID, and the installer saves one before it deploys anything, so this install deployed nothing there\./);
  assert.doesNotMatch(text, /Couldn't|isn't all gone|Deleted/);
});

test('a resource group the installer created is still deleted whole', async () => {
  const t = existingGroupInstall();
  t.az.createdResourceGroup = true;
  await t.arm.api.ensureResourceGroup('sub-1', 'rg-shared', 'uksouth');
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), true);
  assert.ok(t.arm.calls.includes('deleteResourceGroup rg-shared'));
  assert.ok(!t.arm.calls.some((c) => c.startsWith('deleteResource ') || c.startsWith('getResource ')), 'no resource-by-resource deletes');
  assert.match(t.ui.text(), /Deleted resource group rg-shared/);
  assert.deepEqual(appDeletes(t.graph), ['deleteApplication web-obj', 'deleteApplication sql-obj']);
});

test('uninstall reads an install record that the 0.6.8-rc.2 installer wrote for a resource group that was already there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'valuelens-rc2-record-'));
  try {
    const file = join(dir, 'valuelens-install.json');
    const outputs = { environmentName: 'cae-vlens-abc', webName: 'vlens-web', runJobName: 'vlens-run', migrateJobName: 'vlens-migrate', sqlServerFqdn: 'vlens-sql-abc.database.windows.net', sqlDatabaseName: 'valuelens', storageAccountName: 'vlensstabc', identityClientId: 'mi-client', identityPrincipalId: 'mi-sp' };
    const record = {
      version: 1,
      target: 'azure',
      azure: {
        tenantId: 'tenant-1',
        subscriptionId: 'sub-1',
        subscriptionName: 'Sub',
        resourceGroup: 'rg-shared',
        resourceGroupMode: 'existing',
        createdResourceGroup: false,
        location: 'uksouth',
        namePrefix: 'vlens',
        installId: 'install-1',
        tags: {},
        publicNetworkAccess: true,
        workspaceMode: 'new',
        workspaceName: 'Analytics Hub',
        imageTag: '0.6.8-rc.2',
        deploymentConfig: { subscriptionId: 'sub-1', resourceGroup: 'rg-shared', namePrefix: 'vlens', location: 'uksouth', publicNetworkAccess: true },
        deployments: [{ at: '2026-10-20T15:00:00.000Z', name: 'valuelens', outputs }],
        outputs,
        webApp: { clientId: 'web-client', objectId: 'web-obj', servicePrincipalId: 'web-sp', created: true, appIdUri: 'api://web-client' },
        sqlReader: { clientId: 'sql-client', objectId: 'sql-obj', servicePrincipalId: 'sql-sp', created: true, secretKeyId: 'key-1', secretExpiry: '2027-04-20T15:00:00.000Z' },
        powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, capacityId: 'cap-f', datasetId: 'ds-1', connectionId: 'conn-1' },
        graphRoles: { assigned: ['AuditLogsQuery.Read.All', 'Reports.Read.All', 'User.Read.All'], pending: [] },
      },
    };
    writeFileSync(file, JSON.stringify(record, null, 2));
    const { config, existed } = loadConfig(file);
    assert.equal(existed, true);
    const az = /** @type {any} */ (config.azure);
    for (const key of ['subscriptionId', 'resourceGroup', 'resourceGroupMode', 'createdResourceGroup', 'installId']) assert.deepEqual(az[key], /** @type {any} */ (record.azure)[key], key);

    const t = existingGroupInstall();
    const powerBi = fakePowerBi();
    powerBi.workspaces.push({ id: 'pbi-ws-1', name: 'Analytics Hub' });
    const { ctx } = fakeCtx({ ui: t.ui.ui, arm: t.arm.api, graph: t.graph.api, fabric: t.fabric.api, powerBi: powerBi.api, config });
    assert.equal(await runCommand(ctx, 'uninstall', { wait: true }), true);
    assert.deepEqual(deleted(t.arm), PUBLIC_ORDER);
    assert.deepEqual(remaining(t.arm), [ID.theirs]);
    assert.deepEqual(powerBi.calls, ['deleteGroup pbi-ws-1']);
    assert.deepEqual(appDeletes(t.graph), ['deleteApplication web-obj', 'deleteApplication sql-obj']);
    assert.equal(az.resourceGroup, 'rg-shared', 'the record keeps where the install was');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
