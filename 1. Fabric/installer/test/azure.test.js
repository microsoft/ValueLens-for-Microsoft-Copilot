import { fabricApi } from '../src/clients/fabric.js';
import { graphApi } from '../src/clients/graph.js';
// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MODULES, azureGraphRolesFor } from '../src/catalog.js';
import { HttpError } from '../src/http.js';
import { waitForDeployment } from '../src/clients/azure.js';
import { runCommand } from '../src/install.js';
import { REQUIRED_ARM_PARAMETERS, armParameterNames, azureConsumptionOn, azureCron, azureDeployment, azureGraphRoles, azureModuleChoices, azurePlanReview, azurePreflight, azureRotateSecret, azureSemanticModels, consumptionParameters, installAzure, parseDropFolder, policyMessage, publicAccessMessage, regionCapacityMessage, supportsVnetGateway, whileSqlResumes, isSqlResuming, whatIfSummary } from '../src/steps/azure/index.js';
import { AZURE_AI_ROLES } from '../src/steps/consumption.js';
import { azureFlowTarget, connectionSteps, flowDefinitions, flowsWanted } from '../src/steps/flows.js';
import { CONNECTORS, connectorsUsed } from '../src/transform/flows.js';
import { ROLES } from '../src/clients/azure.js';
import { buildModel, mParameter } from '../src/transform/model.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi } from './fakes.js';

test('Azure target gates modules and mirrors Graph roles', () => {
  const choices = azureModuleChoices({ orgData: true, m365Activity: true, agent365: true, productFeedback: true, consumption: true, agentEvaluator: true });
  assert.equal(choices.find((c) => c.value === 'core')?.disabled, 'Always collected');
  assert.equal(choices.find((c) => c.value === 'm365Activity')?.checked, true);
  assert.equal(choices.find((c) => c.value === 'agent365')?.disabled, 'Coming soon on Azure');
  assert.deepEqual(azureGraphRolesFor({ orgData: true, m365Activity: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false }), [
    'AuditLogsQuery.Read.All',
    'ReportSettings.Read.All',
    'Reports.Read.All',
    'User.Read.All',
  ]);
  assert.equal(MODULES.consumption.azure.supported, true);
});

test('parseDropFolder: a folder address or its AllItems link gives the site, the Graph site ID and the path in the library', () => {
  const want = {
    folderUrl: 'https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens',
    siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
    sitePath: '/Shared Documents/ValueLens',
    siteId: 'contoso.sharepoint.com:/sites/Analytics',
    driveId: '',
    drivePath: 'Shared Documents/ValueLens',
  };
  assert.deepEqual(parseDropFolder('https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/ValueLens/'), want);
  assert.deepEqual(parseDropFolder(' https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens '), want);
  assert.deepEqual(parseDropFolder('https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FAnalytics%2FShared%20Documents%2FValueLens&viewid=abc'), want);
  assert.equal(parseDropFolder('https://contoso.sharepoint.com/teams/Ops/Documents/Credits').siteId, 'contoso.sharepoint.com:/teams/Ops');
  const root = parseDropFolder('https://contoso.sharepoint.com/Shared Documents/Credits');
  assert.equal(root.siteId, 'contoso.sharepoint.com');
  assert.equal(root.siteUrl, 'https://contoso.sharepoint.com');
  assert.equal(root.drivePath, 'Shared Documents/Credits');
  assert.throws(() => parseDropFolder('not a url'), /https:\/\/ address/);
  assert.throws(() => parseDropFolder('http://contoso.sharepoint.com/sites/A/Docs'), /SharePoint Online/);
  assert.throws(() => parseDropFolder('https://example.com/sites/A/Docs'), /SharePoint Online/);
  assert.throws(() => parseDropFolder('https://contoso.sharepoint.com/sites/Analytics'), /site, not a folder/);
});

/** @param {import('../src/config.js').InstallConfig} config @param {Partial<import('../src/config.js').AzureConfig>} [az] */
function withAzureConsumption(config, az = {}) {
  config.target = 'azure';
  config.modules.consumption = true;
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub', ...az };
  Object.assign(config.dataSources, { studioCredits: 'api', coworkCredits: 'csv', azureAi: 'api' });
  Object.assign(config.consumption, { azureSubscriptionId: 'ai-sub', azureSubscriptionName: 'AI', paygSubscriptions: [{ subscriptionId: 'payg-1', access: true }, { subscriptionId: 'payg-2' }] });
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };
}

test('credit consumption on Azure: the job reads only what it was given access to, and the app gets the cc model', () => {
  const { config } = fakeCtx();
  withAzureConsumption(config);
  assert.equal(azureConsumptionOn(config), true);
  const off = Object.fromEntries(Object.entries(consumptionParameters(config)).map(([k, v]) => [k, v.value]));
  assert.deepEqual(off, { azureAiSubscriptionId: '', paygSubscriptionIds: 'payg-1', dropSiteId: '', dropDriveId: '', dropFolder: '' }, 'no Azure AI until its roles are in');
  config.consumption.azureAccess = true;
  config.azure = { ...config.azure, drop: parseDropFolder('https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens') };
  const on = Object.fromEntries(Object.entries(consumptionParameters(config)).map(([k, v]) => [k, v.value]));
  assert.deepEqual(on, { azureAiSubscriptionId: 'ai-sub', paygSubscriptionIds: 'payg-1', dropSiteId: 'contoso.sharepoint.com:/sites/Analytics', dropDriveId: '', dropFolder: 'Shared Documents/ValueLens' });
  assert.ok(azureGraphRoles(config).includes('Sites.Selected'));

  assert.deepEqual(azureSemanticModels({ powerBi: { workspaceId: 'ws', datasetId: 'vl-1', consumptionDatasetId: 'cc-1' } }), { vl: { workspaceId: 'ws', itemId: 'vl-1' }, cc: { workspaceId: 'ws', itemId: 'cc-1' } });

  // Demo mode collects nothing from the tenant.
  /** @type {any} */ (config.azure).sampleData = true;
  assert.equal(azureConsumptionOn(config), false);
  assert.ok(Object.values(consumptionParameters(config)).every((v) => v.value === ''));
  assert.ok(!azureGraphRoles(config).includes('Sites.Selected'));
});

test('Azure Studio flow: signed in as the user, it writes to the landing container, or to SharePoint with private networking', () => {
  const { config } = fakeCtx();
  withAzureConsumption(config, { outputs: { storageAccountName: 'vlensst' } });
  config.uploads.flowIdentity = 'app';
  config.uploads.feedbackFlow = true;
  config.dataSources.productFeedback = 'csv';
  assert.deepEqual(flowsWanted(config), ['studio'], 'no feedback flow on Azure, and the app identity is Fabric only');
  assert.equal(azureFlowTarget(config.azure).identity, 'user');
  const pub = flowDefinitions(config, 'tenant-1').studio;
  assert.deepEqual(connectorsUsed(pub.definition), [CONNECTORS.entra.name, CONNECTORS.storage.name].sort());
  const text = JSON.stringify(pub.definition);
  assert.match(text, /https:\/\/vlensst\.dfs\.core\.windows\.net\/landing\/studio\//);
  assert.match(text, /https:\/\/vlensst\.dfs\.core\.windows\.net\/landing\/flows\//, 'the backfill marker stays out of the folder the jobs read');
  assert.doesNotMatch(text, /keyvault|onelake/i);
  assert.match(pub.description, /vlensst > landing\/studio/);
  assert.match(connectionSteps(config, 'studio')[1], /for Azure Storage: Base Resource URL https:\/\/vlensst\.dfs\.core\.windows\.net, .*Storage Blob Data Contributor on vlensst/);

  config.azure = { ...config.azure, publicNetworkAccess: false, drop: parseDropFolder('https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens') };
  const priv = flowDefinitions(config, 'tenant-1').studio;
  assert.deepEqual(connectorsUsed(priv.definition), [CONNECTORS.entra.name, CONNECTORS.sharePoint.name].sort());
  const ptext = JSON.stringify(priv.definition);
  assert.match(ptext, /"dataset":"https:\/\/contoso\.sharepoint\.com\/sites\/Analytics"/);
  assert.match(ptext, /"folderPath":"\/Shared Documents\/ValueLens\/studio"/);
  assert.match(ptext, /"path":"\/Shared Documents\/ValueLens\/flows\//);
  assert.doesNotMatch(ptext, /dfs\.core\.windows\.net/);
  assert.match(priv.description, /ValueLens\/studio/);
  assert.match(connectionSteps(config, 'studio')[1], /^SharePoint: .*https:\/\/contoso\.sharepoint\.com\/sites\/Analytics\/Shared Documents\/ValueLens/);
});

/** A Dataverse environment that keeps the flows it creates. */
function fakeFlowEnvironment() {
  /** @type {Map<string, any>} */
  const flows = new Map();
  let n = 0;
  return {
    flows,
    api: {
      createFlow: async (/** @type {any} */ f) => {
        const id = `flow-${++n}`;
        flows.set(id, { workflowid: id, name: f.name, statecode: 0, clientdata: f.clientdata });
        return id;
      },
      getFlow: async (/** @type {string} */ id) => flows.get(id),
      updateFlow: async (/** @type {string} */ id, /** @type {string} */ clientdata) => {
        flows.get(id).clientdata = clientdata;
      },
      turnOffFlow: async () => {},
      deleteFlow: async (/** @type {string} */ id) => {
        flows.delete(id);
      },
    },
  };
}

test('Azure install with credit consumption: roles for the jobs, landing write for the user, the cc model and the Studio flow', async () => {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const env = fakeFlowEnvironment();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api, ui: ui.ui, dataverse: () => env.api });
  withAzureConsumption(config);
  ctx.runFirstLoad = false;

  await installAzure(ctx, { wait: true });
  for (const r of AZURE_AI_ROLES) assert.ok(arm.calls.includes(`assignRole /subscriptions/ai-sub ${r.id} mi-sp ServicePrincipal`), r.name);
  assert.ok(arm.calls.includes(`assignRole /subscriptions/payg-2 ${ROLES.costManagementReader} mi-sp ServicePrincipal`));
  assert.ok(arm.calls.includes(`assignRole /subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/vlensstabc ${ROLES.storageBlobDataContributor} user-1 User`));
  const az = /** @type {any} */ (config.azure);
  assert.equal(az.storageRole, true);
  assert.ok(!graph.calls.some((c) => c.startsWith('grantSiteRead')));
  assert.ok(!az.graphRoles.assigned.includes('Sites.Selected'));

  const last = deployments.at(-1).properties.parameters;
  assert.equal(last.azureAiSubscriptionId.value, 'ai-sub');
  assert.equal(last.paygSubscriptionIds.value, 'payg-1,payg-2');
  assert.equal(last.dropSiteId.value, '');
  assert.deepEqual(Object.keys(JSON.parse(last.semanticModels.value)).sort(), ['cc', 'vl']);

  assert.equal(az.powerBi.consumptionDatasetId, config.consumption.model.id);
  assert.ok(az.powerBi.consumptionDatasetId && az.powerBi.consumptionDatasetId !== az.powerBi.datasetId);
  assert.equal(powerBi.calls.filter((c) => c === 'updateDatasource gw ds ServicePrincipal').length, 2, 'both models are bound');
  assert.ok(powerBi.calls.includes(`setRefreshSchedule ${az.powerBi.workspaceId} ${az.powerBi.consumptionDatasetId}`));

  assert.equal(env.flows.size, 1);
  assert.match(env.flows.get('flow-1').clientdata, /vlensstabc\.dfs\.core\.windows\.net\/landing\/studio/);
  assert.match(ui.text(), /Power Automate flows/);
  assert.match(ui.text(), /for Azure Storage/);

  // A repair reuses the role and the flow.
  arm.calls.length = 0;
  await installAzure(ctx, { wait: true });
  assert.ok(!arm.calls.some((c) => c.startsWith('assignRole')));
  assert.equal(env.flows.size, 1);
});

test('Azure install with credit consumption: a SharePoint drop folder gets a site grant for the jobs, or an admin action', async () => {
  const drop = parseDropFolder('https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens');
  const run = async (/** @type {boolean} */ fail) => {
    const arm = fakeArm();
    const graph = fakeAzureGraph();
    if (fail) graph.siteGrantFailures.push(new Error('Forbidden'));
    const powerBi = fakePowerBi();
    powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
    const env = fakeFlowEnvironment();
    const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: fakeUi().ui, dataverse: () => env.api });
    withAzureConsumption(config, { drop: { ...drop } });
    ctx.runFirstLoad = false;
    await installAzure(ctx, { wait: true });
    return { arm, graph, env, az: /** @type {any} */ (config.azure) };
  };
  const ok = await run(false);
  assert.ok(ok.graph.calls.some((c) => c.startsWith('grantSiteRead site:contoso.sharepoint.com:/sites/Analytics')));
  assert.equal(ok.az.drop.granted, true);
  assert.ok(ok.az.graphRoles.assigned.includes('Sites.Selected'));
  assert.ok(!ok.arm.calls.some((c) => c.includes('storageAccounts/')), 'no storage role for the user when files go to SharePoint');
  assert.match(ok.env.flows.get('flow-1').clientdata, /shared_sharepointonline/);

  const denied = await run(true);
  assert.ok(!denied.az.drop.granted);
  assert.ok(denied.az.status.pendingAdminActions.some((/** @type {string} */ a) => /^Grant-PnPAzureADAppSitePermission -AppId \S+ .* -Site https:\/\/contoso\.sharepoint\.com\/sites\/Analytics -Permissions Read$/.test(a)));
});

test('Azure install with credit consumption in demo mode leaves it all out', async () => {
  const arm = fakeArm();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
  const env = fakeFlowEnvironment();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: fakeAzureGraph().api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: fakeUi().ui, dataverse: () => env.api });
  withAzureConsumption(config, { sampleData: true });
  ctx.runFirstLoad = false;
  await installAzure(ctx, { wait: true });
  assert.ok(!arm.calls.some((c) => c.startsWith('assignRole')));
  assert.equal(config.azure?.powerBi?.consumptionDatasetId, undefined);
  assert.equal(env.flows.size, 0);
});

test('Azure preflight surfaces policy denial and what-if plan grouping', async () => {
  const arm = fakeArm();
  arm.failures.validateDeployment = [
    new HttpError('denied', {
      status: 400,
      method: 'POST',
      url: 'https://management.azure.com/x',
      body: { error: { code: 'RequestDisallowedByPolicy', message: 'Denied by policy assignment Public SQL denied.' } },
    }),
  ];
  const { ctx, config } = fakeCtx({ arm: arm.api, powerBi: fakePowerBi().api });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  await arm.api.ensureResourceGroup('sub-1', 'rg', 'uksouth');
  await assert.rejects(azurePreflight(ctx), /Azure Policy blocked the deployment.*Public SQL denied.*exemption.*private networking/i);
  assert.match(policyMessage(arm.failures.validateDeployment?.[0] ?? { error: { code: 'RequestDisallowedByPolicy' } }), /Policy/);
  assert.deepEqual(whatIfSummary([{ changeType: 'Create', resourceType: 'A', resourceId: '/x/a' }, { changeType: 'Modify', resourceType: 'A', name: 'b' }]).A, {
    create: ['a'],
    modify: ['b'],
    nochange: [],
    delete: [],
  });
});

test('Azure preflight plans a new resource group without calling ARM validate', async () => {
  const arm = fakeArm();
  const { ctx, config } = fakeCtx({ arm: arm.api, powerBi: fakePowerBi().api });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg-new', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  await azurePreflight(ctx);
  assert.equal(arm.calls.includes('validateDeployment'), false);
  assert.equal(arm.calls.includes('whatIfDeployment'), false);
  assert.equal(arm.calls.some((c) => c.startsWith('ensureResourceGroup')), false, 'nothing is created before the plan is approved');
  const grouped = whatIfSummary(config.azure.status?.whatIf ?? []);
  assert.deepEqual(grouped['Microsoft.Resources/resourceGroups'].create, ['rg-new']);
  assert.ok(grouped['Microsoft.Sql/servers'].create.length);
});

test('Azure preflight stops before deploying when the SQL region is restricted', async () => {
  const arm = fakeArm();
  arm.restrictedSqlRegions.add('uksouth');
  const { ctx, config } = fakeCtx({ arm: arm.api, powerBi: fakePowerBi().api });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg-new', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  await assert.rejects(azurePreflight(ctx), /can't create Azure SQL servers in uksouth.*Azure SQL region/);
  config.azure.sqlLocation = 'ukwest';
  await azurePreflight(ctx);
  assert.ok(arm.calls.includes('sqlCapability ukwest'));
  assert.equal((await azureDeployment(ctx, { pass: 1 })).properties.parameters.sqlLocation.value, 'ukwest');
});

test('ARM deployments are polled until they finish and failures carry the ARM error', async () => {
  const states = ['Running', 'Succeeded'];
  const done = await waitForDeployment(async () => ({ name: 'valuelens', properties: { provisioningState: states.shift(), outputs: { webFqdn: { value: 'x' } } } }), { properties: { provisioningState: 'Accepted' } }, { sleep: async () => {}, pollMs: 0 });
  assert.equal(done.properties.outputs.webFqdn.value, 'x');
  await assert.rejects(
    waitForDeployment(async () => ({ name: 'valuelens', properties: { provisioningState: 'Failed', error: { code: 'DeploymentFailed', details: [{ code: 'RequestDisallowedByPolicy', message: 'Denied' }] } } }), { properties: { provisioningState: 'Running' } }, { sleep: async () => {}, pollMs: 0 }),
    (/** @type {any} */ err) => /RequestDisallowedByPolicy: Denied/.test(err.message) && !!policyMessage(err.body),
  );
});

test('regional SQL capacity errors point at the Azure SQL region choice', async () => {
  const err = await waitForDeployment(async () => ({ properties: { provisioningState: 'Failed', error: { code: 'DeploymentFailed', details: [{ code: 'RegionDoesNotAllowProvisioning', message: "Location 'UK South' is not accepting creation of new Windows Azure SQL Database servers at this time." }] } } }), { properties: { provisioningState: 'Running' } }, { sleep: async () => {}, pollMs: 0 }).catch((e) => e);
  assert.match(regionCapacityMessage(err), /UK South is not accepting new Windows Azure SQL Database servers.*Azure SQL region/);
  assert.equal(regionCapacityMessage(new Error('other')), '');
});

test('Azure ARM parameters stay in sync with the committed template', async () => {
  assert.equal(REQUIRED_ARM_PARAMETERS.every((p) => armParameterNames().includes(p)), true);
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'id', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  const body = await azureDeployment(ctx, { pass: 1 });
  assert.deepEqual(Object.keys(body.properties.parameters).sort(), REQUIRED_ARM_PARAMETERS.slice().sort());
  assert.equal(body.properties.parameters.imageRegistry.value, 'ghcr.io/microsoft');
  assert.equal(body.properties.parameters.imageTag.value, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(body.properties.parameters.imageRegistryResourceId.value, '');
  assert.equal(body.properties.parameters.sampleData.value, false, 'tenant data unless demo mode is chosen');
  config.azure.sampleData = true;
  assert.equal((await azureDeployment(ctx, { pass: 1 })).properties.parameters.sampleData.value, true);
  config.azure.sampleData = false;
  config.azure.images = { registry: 'myacr.azurecr.io/valuelens', registryResourceId: '/subscriptions/s/resourceGroups/r/providers/Microsoft.ContainerRegistry/registries/myacr', tag: 'dev-1' };
  const pinned = (await azureDeployment(ctx, { pass: 1 })).properties.parameters;
  assert.equal(pinned.imageRegistry.value, 'myacr.azurecr.io/valuelens');
  assert.equal(pinned.imageTag.value, 'dev-1');
  assert.match(pinned.imageRegistryResourceId.value, /registries\/myacr$/);
  config.azure.powerBi = { workspaceId: 'ws-1', datasetId: 'ds-1' };
  const models = JSON.parse((await azureDeployment(ctx, { pass: 1 })).properties.parameters.semanticModels.value);
  assert.deepEqual(models, { vl: { workspaceId: 'ws-1', itemId: 'ds-1' } }, 'the app queries the model through the `vl` alias');
  const armTypes = JSON.parse(readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8')).parameters;
  const jsonType = (/** @type {any} */ v) => (Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : typeof v === 'boolean' ? 'bool' : typeof v === 'object' ? 'object' : 'string');
  for (const [name, { value }] of Object.entries(pinned)) {
    const want = String(armTypes[name].type).toLowerCase().replace('secure', '');
    assert.equal(jsonType(value), want, `${name} is ${jsonType(value)} but the template expects ${want}`);
  }
  assert.equal(azureCron({ frequency: 'weekly', time: '03:15', weekday: 'Monday' }), '15 3 * * 1');
});

test('Azure apply is idempotent enough against fakes and records key outputs', async () => {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api, ui: ui.ui });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
  });
  ctx.runFirstLoad = true;

  await installAzure(ctx, { wait: true });
  assert.deepEqual(arm.calls.filter((c) => c.startsWith('deployTemplate')), ['deployTemplate valuelens', 'deployTemplate valuelens']);
  assert.ok(graph.applications.find((a) => a.displayName === 'Analytics Hub (Azure)')?.identifierUris?.[0].includes('vlens.example.com'));
  assert.ok(graph.calls.includes('fic app-obj-1 mi-sp'));
  assert.ok(graph.applications.find((a) => a.displayName === 'Analytics Hub (Azure)')?.api?.preAuthorizedApplications?.some((a) => a.appId === '1fec8e78-bce4-4aaf-ab1b-5451cc387264'));
  assert.ok(powerBi.calls.some((c) => c === 'updateDatasource gw ds ServicePrincipal'));
  assert.ok(arm.calls.includes('startJob vlens-migrate'));
  assert.ok(arm.calls.includes('startJob vlens-run'));
  assert.equal(config.azure?.powerBi?.datasetId, config.semanticModel.id);
  assert.equal(config.azure?.webApp?.appIdUri, 'api://vlens.example.com/00000000-0000-4000-8000-000000000001');
  assert.ok(config.azure?.graphRoles?.assigned.includes('Reports.Read.All'));
  const webSp = `sp-${config.azure?.webApp?.clientId}`;
  assert.equal(graph.calls.filter((c) => c === 'assign user-1 role-admin').length, 1, 'the installer gets the Admin app role');

  const webAppsBefore = graph.applications.filter((a) => a.displayName === 'Analytics Hub (Azure)').length;
  await installAzure(ctx, { wait: true });
  assert.equal(graph.applications.filter((a) => a.displayName === 'Analytics Hub (Azure)').length, webAppsBefore, 'web app is reused');
  assert.equal(graph.calls.filter((c) => c === 'assign user-1 role-admin').length, 1, 'the role is not assigned twice');
  assert.equal(config.azure?.webApp?.servicePrincipalId, webSp);
});

test('a failed migration stops the install before the first load', async () => {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: fakeUi().ui });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
  });
  ctx.runFirstLoad = true;
  arm.executions.push({ properties: { status: 'Failed' } });

  await assert.rejects(installAzure(ctx, { wait: true }), /migration job did not succeed \(Failed\).*az containerapp job logs show/);
  assert.ok(arm.calls.includes('startJob vlens-migrate'));
  assert.ok(!arm.calls.includes('startJob vlens-run'), 'first load is not started');
  assert.equal(config.azure?.status?.lastMigrate?.status, 'Failed');
});

test('private networking deploys a VNet, binds the model through a VNet data gateway, rotates and uninstalls it', async () => {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: '12345678-aaaa', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: false, workspaceName: 'Analytics Hub', powerBi: { capacityId: 'cap-f' } },
  });
  await azurePreflight(ctx);
  assert.ok(arm.calls.includes('ensureProvider Microsoft.PowerPlatform'));
  assert.ok(arm.calls.includes('ensureProvider Microsoft.Network'));
  assert.ok(arm.calls.includes('ensureFeature Microsoft.Network/AllowBringYourOwnPublicIpAddress'));
  assert.ok(config.azure?.status?.whatIf?.some((c) => c.resourceType === 'Microsoft.Network/privateEndpoints'));

  ctx.runFirstLoad = false;
  await installAzure(ctx, { wait: true });
  const az = /** @type {any} */ (config.azure);
  assert.ok(fabric.calls.includes('assignToCapacity pbi-ws-1 cap-f'));
  assert.ok(fabric.calls.includes('createGateway Analytics Hub rg 12345678 vnet-vlens-abc/snet-powerbi-gateway'));
  assert.ok(fabric.calls.includes('createConnection Analytics Hub SQL rg 12345678'));
  assert.equal(fabric.connections[0].body.credentialDetails.credentials.credentialType, 'ServicePrincipal');
  assert.equal(fabric.connections[0].body.credentialDetails.skipTestConnection, true, 'the reader user only exists after the migrate job');
  assert.equal(fabric.connections[0].body.connectionDetails.parameters[0].value, 'vlens-sql.database.windows.net');
  assert.ok(powerBi.calls.includes(`bindToGateway ${az.powerBi.datasetId} ${az.powerBi.gatewayId} ${az.powerBi.connectionId}`));
  assert.ok(!powerBi.calls.some((c) => c.startsWith('updateDatasource')), 'no cloud credential binding in private mode');
  assert.equal(az.powerBi.createdGateway, true);

  // Re-run: reuse the gateway and connection, refresh the secret on the connection.
  const firstKey = az.sqlReader.secretKeyId;
  await installAzure(ctx, { wait: true });
  assert.ok(graph.calls.includes(`removePassword ${firstKey}`), 'the previous SQL reader secret is removed once the new one is bound');
  assert.ok(!graph.calls.includes(`removePassword ${az.sqlReader.secretKeyId}`));
  assert.equal(fabric.gateways.length, 1);
  assert.equal(fabric.connections.length, 1);
  assert.ok(fabric.calls.includes(`updateConnection ${az.powerBi.connectionId}`));

  fabric.calls.length = 0;
  await azureRotateSecret(ctx);
  assert.ok(fabric.calls.includes(`updateConnection ${az.powerBi.connectionId}`));

  az.createdResourceGroup = true;
  await runCommand(ctx, 'uninstall', { wait: true });
  assert.ok(fabric.calls.includes(`deleteConnection ${az.powerBi.connectionId}`));
  assert.ok(fabric.calls.includes(`deleteGateway ${az.powerBi.gatewayId}`));
  assert.ok(arm.calls.includes('deleteResourceGroup rg'));
});

test('private networking only offers capacities that can host a VNet data gateway, and explains forced-off public access', () => {
  assert.equal(supportsVnetGateway({ sku: 'FTL64' }), true);
  assert.equal(supportsVnetGateway({ sku: 'F2' }), true);
  assert.equal(supportsVnetGateway({ sku: 'P1' }), true);
  assert.equal(supportsVnetGateway({ sku: 'A4' }), true);
  assert.equal(supportsVnetGateway({ sku: 'PP3' }), false);
  assert.equal(supportsVnetGateway({ sku: 'A1' }), false);
  assert.equal(supportsVnetGateway({ sku: 'EM1' }), false);
  const err = new HttpError('Conflict', { status: 400, method: 'PUT', url: 'https://x', body: { error: { code: 'DenyPublicEndpointEnabled', message: 'Unable to create or modify firewall rules when public network interface for the server is disabled.' } } });
  assert.match(publicAccessMessage(err), /choose Private networking/);
  assert.equal(publicAccessMessage(new Error('other')), '');
});

test('switching an existing install between public and private networking is refused', async () => {
  const { ctx, config } = fakeCtx({ arm: fakeArm().api, fabric: fakeFabric().api });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'i', publicNetworkAccess: false, powerBi: { capacityId: 'cap-f' }, outputs: { environmentName: 'cae-vlens-abc', sqlServerFqdn: 'x' } };
  await assert.rejects(azurePreflight(ctx), /uninstall and install again/);
});
test('Azure never-touch collision and uninstall scope', async () => {
  const arm = fakeArm();
  arm.resources.push({ id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/vlensbad', name: 'vlensbad', type: 'Microsoft.Storage/storageAccounts', tags: {} });
  const { ctx, config } = fakeCtx({ arm: arm.api, powerBi: fakePowerBi().api });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  await arm.api.ensureResourceGroup('sub-1', 'rg', 'uksouth');
  await assert.rejects(azurePreflight(ctx), /without this install's tag/);

  arm.resources[0].tags = { 'valuelens-install-id': 'install-1' };
  await runCommand(ctx, 'uninstall', { wait: true });
  assert.ok(arm.calls.some((c) => c.startsWith('deleteResource /subscriptions')));
  config.azure.createdResourceGroup = true;
  await runCommand(ctx, 'uninstall', { wait: true });
  assert.ok(arm.calls.includes('deleteResourceGroup rg'));
});

test('Azure model uses SQL output values as the existing source parameters', () => {
  const template = {
    compatibilityLevel: 1601,
    model: {
      expressions: [
        { name: 'Fabric SQL Endpoint', expression: '"old" meta [IsParameterQuery=true]' },
        { name: 'Lakehouse Name', expression: '"lh" meta [IsParameterQuery=true]' },
        { name: 'Enable_Agent365', expression: '"Include" meta [IsParameterQuery=true]' },
        { name: 'Enable_ProductFeedback', expression: '"Include" meta [IsParameterQuery=true]' },
        { name: 'FabricTable', expression: '(t as text) => let Source = Sql.Database(#"Fabric SQL Endpoint", #"Lakehouse Name"), Tbl = Source{[Schema = "lakehouse", Item = t]}[Data] in Tbl' },
      ],
      tables: [{ name: 'T', partitions: [{ source: { type: 'm', expression: 'let Source = Sql.Database(#"Fabric SQL Endpoint", #"Lakehouse Name"), T = Source{[Schema = "x", Item = "copilot_org_data"]}[Data] in T' } }] }],
    },
  };
  const bim = buildModel(template, { server: 'sql.database.windows.net', database: 'db', modules: { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false } });
  const text = JSON.stringify(bim);
  assert.equal(mParameter(bim.model, 'Fabric SQL Endpoint'), 'sql.database.windows.net');
  assert.equal(mParameter(bim.model, 'Lakehouse Name'), 'db');
  assert.equal(mParameter(bim.model, 'Enable_Agent365'), 'Exclude');
  assert.equal(mParameter(bim.model, 'Enable_ProductFeedback'), 'Exclude');
  assert.match(text, /Sql\.Database\(#\\"Fabric SQL Endpoint\\", #\\"Lakehouse Name\\"\)/);
});

test('an app registration with no Graph roles is created without an empty permission entry', async () => {
  /** @type {any[]} */ const posts = [];
  const g = graphApi(/** @type {any} */ ({ post: async (/** @type {string} */ _p, /** @type {any} */ body) => (posts.push(body), { id: 'a' }) }));
  await g.createApplication('Analytics Hub SQL reader', []);
  await g.createApplication('Analytics Hub', [{ id: 'r1' }]);
  assert.deepEqual(posts[0].requiredResourceAccess, []);
  assert.equal(posts[1].requiredResourceAccess[0].resourceAccess[0].id, 'r1');
});

test('workspace capacity assignment polls the workspace instead of a missing operation', async () => {
  let gets = 0;
  const f = fabricApi(/** @type {any} */ ({
    post: async () => '',
    get: async () => (++gets < 2 ? { capacityId: 'CAP-F', capacityAssignmentProgress: 'InProgress' } : { capacityId: 'CAP-F', capacityAssignmentProgress: 'Completed' }),
  }));
  await f.assignToCapacity('ws', 'cap-f');
  assert.equal(gets, 2);
});

test('Power BI connection calls retry while serverless Azure SQL resumes from auto-pause', async () => {
  const resuming = new Error("Database 'valuelens' on server 'x' is not currently available. (40613)");
  let n = 0;
  const notes = [];
  const r = await whileSqlResumes({ note: (s) => notes.push(s) }, async () => { if (++n < 3) throw resuming; return 'ok'; }, { delayMs: 1 });
  assert.equal(r, 'ok');
  assert.equal(notes.length, 1);
  await assert.rejects(whileSqlResumes({ note: () => {} }, async () => { throw new Error('Login failed'); }, { delayMs: 1 }), /Login failed/);
  assert.equal(isSqlResuming(resuming), true);
});

test('delegated consent reuses an existing grant on re-runs', async () => {
  /** @type {string[]} */ const calls = [];
  /** @type {any[]} */ let grants = [];
  const g = graphApi(/** @type {any} */ ({
    list: async () => grants,
    post: async (/** @type {string} */ p, /** @type {any} */ b) => (calls.push(`post ${b.scope}`), grants = [{ id: 'g1', consentType: 'AllPrincipals', ...b }], grants[0]),
    patch: async (/** @type {string} */ p, /** @type {any} */ b) => (calls.push(`patch ${p} ${b.scope}`), {}),
  }));
  await g.grantOauth2Permission({ clientId: 'c', resourceId: 'r', scope: 'Dataset.Read.All' });
  await g.grantOauth2Permission({ clientId: 'c', resourceId: 'r', scope: 'Dataset.Read.All' });
  await g.grantOauth2Permission({ clientId: 'c', resourceId: 'r', scope: 'User.Read' });
  assert.deepEqual(calls, ['post Dataset.Read.All', 'patch /oauth2PermissionGrants/g1 Dataset.Read.All User.Read']);
});
