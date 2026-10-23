import { fabricApi } from '../src/clients/fabric.js';
import { graphApi, mergePreAuthorizedApplications } from '../src/clients/graph.js';
// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GRAPH_APP_ID, MODULES, azureGraphRolesFor } from '../src/catalog.js';
import { HttpError } from '../src/http.js';
import { armApi, armErrors, waitForDeployment } from '../src/clients/azure.js';
import { runCommand } from '../src/install.js';
import { AZURE_TARGET_DESCRIPTION, REQUIRED_ARM_PARAMETERS, TEAMS_CLIENTS, WEB_APP_NAME, armParameterNames, askTarget, azureAgent365On, azureConsumptionOn, azureCron, azureDeployment, azureDropContents, azureGraphRoles, azureModuleChoices, azurePlanReview, azurePreflight, azureProductFeedbackOn, azureRefresh, azureRotateSecret, azureSemanticModels, azureStatus, azureSummary, azureUninstall, azureUpdate, azureWorkdayOn, confirmAzurePlan, consumptionParameters, enabledAzureModuleIds, installAzure, parseDropFolder, planAzure, planAzureAgent365, planAzureDrop, planAzureProductFeedback, planAzureConsumption, planAzureWorkday, policyMessage, publicAccessMessage, regionCapacityMessage, sqlFreeOfferTurnedDown, supportsVnetGateway, whileSqlResumes, isSqlResuming, whatIfSummary } from '../src/steps/azure/index.js';
import { AZURE_AI_ROLES } from '../src/steps/consumption.js';
import { azureFlowTarget, connectionSteps, flowDefinitions, flowsWanted } from '../src/steps/flows.js';
import { RG_DELETE_POLL_MS, RG_DELETE_POLLS } from '../src/steps/azure/index.js';
import { CONNECTORS, connectorsUsed } from '../src/transform/flows.js';
import { ROLES } from '../src/clients/azure.js';
import { buildModel, mParameter } from '../src/transform/model.js';
import { fakeAppCatalog, fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError, readManifest, throttledThenTaken } from './fakes.js';
import { manifestVersion } from '../src/azure/teams.js';
import { CATALOG_SIGN_IN_MS } from '../src/steps/azure/teams-catalog.js';
import { readScopes } from '../src/steps/org-access.js';
import { loadConfig, saveConfig, emptyConfig } from '../src/config.js';
import { createWebUi } from '../src/web-ui.js';
import { createSession } from '../src/web-session.js';

test('Azure target gates modules and mirrors Graph roles', () => {
  const choices = azureModuleChoices({ orgData: true, m365Activity: true, agent365: true, productFeedback: true, consumption: true, agentEvaluator: true });
  assert.equal(choices.find((c) => c.value === 'core')?.disabled, 'Always collected');
  assert.equal(choices.find((c) => c.value === 'm365Activity')?.checked, true);
  for (const c of choices.filter((ch) => !MODULES[ch.value].azure.supported)) assert.equal(c.disabled, 'Coming soon on Azure', c.value);
  assert.equal(choices.find((c) => c.value === 'agent365')?.disabled, false);
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

  /** @type {any} */ (config.azure).powerBi = { workspaceId: 'ws', datasetId: 'vl-1', consumptionDatasetId: 'cc-1' };
  assert.deepEqual(azureSemanticModels(config), { vl: { workspaceId: 'ws', itemId: 'vl-1' }, cc: { workspaceId: 'ws', itemId: 'cc-1' } });
  config.modules.consumption = false;
  assert.deepEqual(azureSemanticModels(config), { vl: { workspaceId: 'ws', itemId: 'vl-1' } }, 'unticked, the kept model is out of the app and the jobs');
  config.modules.consumption = true;

  // Demo mode collects nothing from the tenant.
  /** @type {any} */ (config.azure).sampleData = true;
  assert.equal(azureConsumptionOn(config), false);
  assert.ok(Object.values(consumptionParameters(config)).every((v) => v.value === ''));
  assert.ok(!azureGraphRoles(config).includes('Sites.Selected'));
  assert.deepEqual(Object.keys(azureSemanticModels(config)), ['vl']);
});

test('Azure Studio flow: signed in as the user, it writes to the landing container, or to SharePoint with private networking', () => {
  const { config } = fakeCtx();
  withAzureConsumption(config, { outputs: { storageAccountName: 'vlensst' } });
  config.uploads.flowIdentity = 'app';
  config.dataSources.productFeedback = 'api';
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

test('Azure: unticking credit consumption keeps its model but takes it out of the app, the refreshes and access, as on Fabric; ticking it again reuses it', async () => {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  Object.assign(graph.api, { getGroup: async (/** @type {string} */ id) => ({ id, displayName: 'Analytics Hub Viewers' }) });
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
  /** @type {Map<string, any[]>} */
  const schedules = new Map();
  /** @type {Map<string, Error>} Why a model's schedule can't be changed. */
  const scheduleErrors = new Map();
  const setSchedule = powerBi.api.setRefreshSchedule;
  const listSources = powerBi.api.datasources;
  /** @type {string[]} The models the viewer group's Build was checked on. */
  const built = [];
  /** @type {string[]} The models whose database credential was set. */
  const bound = [];
  Object.assign(powerBi.api, {
    setRefreshSchedule: async (/** @type {string} */ ws, /** @type {string} */ id, /** @type {any} */ body) => {
      const err = scheduleErrors.get(id);
      if (err) throw err;
      schedules.set(id, [...(schedules.get(id) ?? []), body]);
      return setSchedule(ws, id);
    },
    datasources: async (/** @type {string} */ _ws, /** @type {string} */ id) => {
      bound.push(id);
      return listSources();
    },
    datasetUsers: async (/** @type {string} */ _ws, /** @type {string} */ id) => {
      built.push(id);
      return [];
    },
    addDatasetUser: async () => null,
  });
  const env = fakeFlowEnvironment();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui, dataverse: () => env.api });
  withAzureConsumption(config);
  config.access = /** @type {any} */ ({ ...config.access, groupId: 'group-1', groupName: 'Analytics Hub Viewers' });
  ctx.runFirstLoad = false;
  const az = /** @type {any} */ (config.azure);
  const aliases = () => Object.keys(JSON.parse(deployments.at(-1).properties.parameters.semanticModels.value)).sort();

  assert.equal(await installAzure(ctx, { wait: true }), true);
  const cc = az.powerBi.consumptionDatasetId;
  assert.ok(cc);
  assert.deepEqual(aliases(), ['cc', 'vl']);
  assert.equal(schedules.get(cc)?.at(-1).value.enabled, true);
  assert.ok(built.includes(cc));
  assert.ok(bound.includes(cc));

  // Unticked in What to collect, while an update of the model may not have finished.
  config.modules.consumption = false;
  config.consumption.model.reload = { since: '2026-06-01T00:00:00Z', unsettled: true };
  built.length = 0;
  bound.length = 0;
  powerBi.calls.length = 0;
  ui.out.length = 0;
  assert.equal(await installAzure(ctx, { wait: true }), true, 'the kept model waits to be reloaded until it is ticked again');
  assert.doesNotMatch(ui.text(), /Credits: +model /, 'the summary leaves it out');
  assert.deepEqual(aliases(), ['vl'], 'no credit pages in the app, and the jobs stop refreshing it');
  assert.deepEqual(schedules.get(cc)?.at(-1), { value: { enabled: false } }, 'its scheduled refresh is turned off, and nothing else is changed in the same request');
  assert.ok(!built.includes(cc), 'no Build on it for the viewer group');
  assert.deepEqual(bound, [az.powerBi.datasetId], 'its database credential is left as it was');
  assert.ok(!powerBi.calls.some((c) => c.startsWith(`refresh ${cc}`)));
  assert.equal(az.powerBi.consumptionDatasetId, cc, 'the model is kept');
  assert.equal(config.consumption.model.id, cc);
  powerBi.calls.length = 0;
  await azureRefresh(ctx);
  assert.deepEqual(powerBi.calls.filter((c) => c.startsWith('refresh ')), [`refresh ${az.powerBi.datasetId} full`]);

  // Ticked again: the same model is applied again, reloaded, and back in the app and on its schedule.
  config.modules.consumption = true;
  powerBi.calls.length = 0;
  ui.out.length = 0;
  assert.equal(await installAzure(ctx, { wait: true }), true);
  assert.match(ui.text(), new RegExp(`Credits: +model ${cc}`));
  assert.equal(az.powerBi.consumptionDatasetId, cc);
  assert.deepEqual(aliases(), ['cc', 'vl']);
  assert.equal(schedules.get(cc)?.at(-1).value.enabled, true);
  assert.ok(built.includes(cc));
  assert.ok(bound.includes(cc));
  assert.ok(powerBi.calls.includes(`refresh ${cc} full`));
  assert.equal(config.consumption.model.reload, undefined);

  // Unticked again: a model deleted in Power BI since has no schedule to turn off; any other failure only warns.
  config.modules.consumption = false;
  scheduleErrors.set(cc, new HttpError('Not found', { status: 404, method: 'PATCH', url: 'https://x' }));
  assert.equal(await installAzure(ctx, { wait: true }), true);
  assert.doesNotMatch(ui.text(), /Couldn't turn off/);
  scheduleErrors.set(cc, new HttpError('Internal', { status: 500, method: 'PATCH', url: 'https://x' }));
  assert.equal(await installAzure(ctx, { wait: true }), true);
  assert.match(ui.text(), /Couldn't turn off the scheduled refresh of .+Turn it off in the model's settings in Power BI\./);
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

  const u = fakeUi();
  const planned = fakeCtx({ ui: u.ui });
  withAzureConsumption(planned.config, { sampleData: true });
  await planAzureConsumption(planned.ctx, []);
  const ds = planned.config.dataSources;
  assert.deepEqual([ds.studioCredits, ds.coworkCredits, ds.azureAi], ['skip', 'skip', 'skip']);
  assert.match(u.text(), /Demo mode leaves credit consumption out for now\. Once you switch to your tenant's data, the installer deploys the Consumption Central model/);
});

/** The one Power Platform environment the Studio flow can go in. */
const oneEnvironment = { instances: async () => [{ Url: 'https://org1.crm.dynamics.com/', EnvironmentId: 'env-1', FriendlyName: 'Contoso' }] };

test('Azure credit consumption ticked with no source picked yet starts from Studio by the licensing API and Cowork by CSV', async () => {
  for (const advanced of [false, true]) {
    const u = fakeUi();
    const { ctx, config } = fakeCtx({ ui: u.ui, discovery: oneEnvironment });
    withAzureConsumption(config);
    // What a new install has, and what turning credit consumption off or demo mode leaves behind.
    const empty = emptyConfig();
    Object.assign(config, { dataSources: empty.dataSources, consumption: empty.consumption, uploads: empty.uploads });
    ctx.advanced = advanced;
    await planAzureConsumption(ctx, []);
    const ds = config.dataSources;
    assert.deepEqual([ds.studioCredits, ds.coworkCredits], ['api', 'csv'], advanced ? 'the questions default to them' : 'without the advanced questions');
    assert.equal(u.asked.includes('Where should Copilot Studio credits come from?'), advanced);
    assert.equal(config.uploads.flowEnvironment?.url, 'https://org1.crm.dynamics.com', 'the Studio flow gets an environment');
    assert.equal(ds.azureAi, 'skip', 'no subscription to read Azure AI from');
  }
});

test('Azure credit consumption keeps the sources picked before, and Cowork by the Viva Insights Dataflow becomes CSV with a warning', async () => {
  const run = async (/** @type {Partial<import('../src/uploads.js').DataSourceModes>} */ modes, /** @type {string | undefined} */ aiSub = 'ai-sub', /** @type {import('../src/config.js').UploadsConfig} */ uploads = {}) => {
    const u = fakeUi();
    const { ctx, config } = fakeCtx({ ui: u.ui, discovery: oneEnvironment });
    withAzureConsumption(config);
    Object.assign(config.dataSources, modes);
    Object.assign(config.uploads, uploads);
    config.consumption.azureSubscriptionId = aiSub;
    ctx.advanced = false;
    await planAzureConsumption(ctx, []);
    const ds = config.dataSources;
    return { modes: [ds.studioCredits, ds.coworkCredits, ds.azureAi], text: u.text() };
  };
  const dataflow = /Viva Insights Dataflow \(coworkCredits=api\) is Fabric only/;
  const nothing = /all left out, so credit consumption collects nothing, and the next run starts from the recommended sources again/;

  const kept = await run({ studioCredits: 'skip', coworkCredits: 'skip' });
  assert.deepEqual(kept.modes, ['skip', 'skip', 'api'], 'Studio and Cowork left out on purpose, with Azure AI on');
  assert.deepEqual((await run({ studioCredits: 'csv', coworkCredits: 'csv' })).modes, ['csv', 'csv', 'api']);
  assert.doesNotMatch(kept.text, dataflow);
  assert.doesNotMatch(kept.text, nothing);

  // Azure AI left out too: kept for this run, with a warning that the next run starts again.
  const none = await run({ studioCredits: 'skip', coworkCredits: 'skip' }, '');
  assert.deepEqual(none.modes, ['skip', 'skip', 'skip']);
  assert.match(none.text, nothing);

  const viva = await run({ coworkCredits: 'api' });
  assert.deepEqual(viva.modes, ['api', 'csv', 'api']);
  assert.match(viva.text, dataflow);

  const appIdentity = /--flow-identity app is Fabric only for now, so it's ignored: on Azure the Studio flow signs in as you/;
  assert.doesNotMatch(viva.text, appIdentity);
  assert.match((await run({}, 'ai-sub', { flowIdentity: 'app' })).text, appIdentity);
});

test('Azure credit consumption: --data azureAi=skip on a first install keeps Azure AI out, and the subscription question can still turn it on', async () => {
  const run = async (/** @type {any[]} */ answers, /** @type {Partial<import('../src/uploads.js').DataSourceModes>} */ modes = { studioCredits: 'csv', coworkCredits: 'csv', azureAi: 'skip' }) => {
    const arm = fakeArm();
    arm.ai.accounts = [{ id: 'acct-1', name: 'ai-1', location: 'uksouth' }];
    const u = fakeUi({ answers });
    const { ctx, config } = fakeCtx({ ui: u.ui, arm: arm.api, discovery: oneEnvironment });
    withAzureConsumption(config);
    // A first install: no subscription picked for Azure AI yet.
    const empty = emptyConfig();
    Object.assign(config, { consumption: empty.consumption, uploads: empty.uploads });
    Object.assign(config.dataSources, modes);
    ctx.advanced = false;
    await planAzureConsumption(ctx, [{ subscriptionId: 'ai-sub', displayName: 'AI' }]);
    return { modes: [config.dataSources.studioCredits, config.dataSources.coworkCredits, config.dataSources.azureAi], sub: config.consumption.azureSubscriptionId, asked: u.asked };
  };
  const out = await run([]);
  assert.deepEqual(out.modes, ['csv', 'csv', 'skip'], '--yes takes the default, which is to leave it out');
  assert.equal(out.sub, '');
  assert.ok(out.asked.some((q) => q.startsWith('Which subscription\'s Azure OpenAI and AI Foundry costs')), 'still asked');

  const picked = await run(['ai-sub']);
  assert.deepEqual(picked.modes, ['csv', 'csv', 'api']);
  assert.equal(picked.sub, 'ai-sub');

  // Without --data azureAi=skip, a first install still defaults to the subscription with Azure AI.
  assert.deepEqual((await run([], { studioCredits: 'csv', coworkCredits: 'csv', azureAi: 'api' })).modes, ['csv', 'csv', 'api']);
  // A fresh tick (nothing picked yet) does too.
  assert.deepEqual((await run([], { studioCredits: 'skip', coworkCredits: 'skip', azureAi: 'skip' })).modes, ['api', 'csv', 'api']);
});

/** @param {import('../src/config.js').InstallConfig} config @param {Partial<import('../src/config.js').AzureConfig>} [az] */
function withAzureAgent365(config, az = {}) {
  config.target = 'azure';
  config.modules.agent365 = true;
  config.dataSources.agent365 = 'csv';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub', ...az };
}

const DROP_FOLDER = 'https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens';
const AGENT365_FABRIC_ONLY = /On Azure the Agent 365 registry comes from its CSV export: the Agent 365 API is Fabric only for now\./;

test('Agent 365 on Azure: ticking it takes the CSV export, because the Agent 365 API is Fabric only for now', async () => {
  const pre = { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], capacities: [] };
  const choice = azureModuleChoices(fakeCtx().config.modules).find((c) => c.value === 'agent365');
  assert.match(choice?.description ?? '', /^From .+\. On Azure it comes from the CSV export: the Agent 365 API is Fabric only for now\.$/);

  const on = fakeUi({ answers: [['m365Activity', 'agent365'], false] });
  const picked = fakeCtx({ ui: on.ui, arm: fakeArm().api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  picked.config.dataSources.agent365 = 'api';
  await planAzure(picked.ctx, pre, 'data');
  assert.equal(picked.config.modules.agent365, true);
  assert.equal(picked.config.dataSources.agent365, 'csv', 'a Fabric install\'s API choice becomes the export');
  assert.match(on.text(), AGENT365_FABRIC_ONLY);
  assert.ok(enabledAzureModuleIds(picked.config.modules, picked.config.azure).includes('agent365'), 'the jobs collect it');

  const off = fakeUi({ answers: [['m365Activity'], false] });
  const left = fakeCtx({ ui: off.ui, arm: fakeArm().api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  Object.assign(left.config.modules, { agent365: true });
  left.config.dataSources.agent365 = 'csv';
  await planAzure(left.ctx, pre, 'data');
  assert.equal(left.config.modules.agent365, false);
  assert.equal(left.config.dataSources.agent365, 'skip');
  assert.doesNotMatch(off.text(), /Fabric only/);
  assert.ok(!enabledAzureModuleIds(left.config.modules, left.config.azure).includes('agent365'));
});

test('Agent 365 on Azure: the plan says where to drop the export, and demo mode leaves it out', () => {
  const plan = (/** @type {Partial<import('../src/config.js').AzureConfig>} */ az, on = true) => {
    const u = fakeUi();
    const { ctx, config } = fakeCtx({ ui: u.ui });
    withAzureAgent365(config, az);
    config.modules.agent365 = on;
    planAzureAgent365(ctx);
    return { text: u.text(), asked: u.asked, config };
  };
  const before = plan({});
  assert.match(before.text, /Agent 365 registry/);
  assert.match(before.text, /On Azure the Agent 365 registry comes from its CSV export: the Agent 365 API is Fabric only for now\. Export it from Microsoft 365 admin center > Agents > All agents > Export, and drop the CSV in the storage account > landing\/agent365\. Each run loads the newest one\./);
  assert.deepEqual(before.asked, [], 'there is nothing to choose');
  assert.match(plan({ outputs: { storageAccountName: 'vlensst' } }).text, /drop the CSV in vlensst > landing\/agent365\./);
  assert.match(plan({ publicNetworkAccess: false }).text, /drop the CSV in an agent365 folder in the SharePoint folder you choose for the jobs\./);

  const demo = plan({ sampleData: true });
  assert.match(demo.text, /Demo mode doesn't load the Agent 365 sample, so the Agent 365 registry is collected once you switch to your tenant's data\./);
  assert.doesNotMatch(demo.text, /Export it from/);
  assert.equal(azureAgent365On(demo.config), false);
  assert.deepEqual(azureDropContents(demo.config), []);
  assert.equal(plan({}, false).text, '');
});

test('Agent 365 on Azure with private networking: one SharePoint folder for the export and any credit files', async () => {
  const plan = async (/** @type {(config: import('../src/config.js').InstallConfig, az: any) => void} */ setUp, /** @type {any[]} */ answers = [DROP_FOLDER]) => {
    const u = fakeUi({ answers });
    const { ctx, config } = fakeCtx({ ui: u.ui });
    withAzureAgent365(config, { publicNetworkAccess: false });
    setUp(config, config.azure);
    await planAzureDrop(ctx);
    return { u, config, az: /** @type {any} */ (config.azure) };
  };
  const values = (/** @type {import('../src/config.js').InstallConfig} */ config) => Object.fromEntries(Object.entries(consumptionParameters(config)).map(([k, v]) => [k, v.value]));

  const only = await plan(() => {});
  assert.deepEqual(only.u.asked, ['SharePoint folder for the Agent 365 export (the address of a folder in a document library)']);
  assert.match(only.u.text(), /Private networking keeps vlens storage off the internet, so your uploads go to a SharePoint folder the jobs read instead\./);
  assert.equal(only.az.drop.siteId, 'contoso.sharepoint.com:/sites/Analytics');
  assert.equal(only.az.drop.granted, false);
  assert.deepEqual(azureDropContents(only.config), ['the Agent 365 export']);
  assert.ok(azureGraphRoles(only.config).includes('Sites.Selected'), 'the jobs read the folder');
  assert.deepEqual(values(only.config), { azureAiSubscriptionId: '', paygSubscriptionIds: '', dropSiteId: 'contoso.sharepoint.com:/sites/Analytics', dropDriveId: '', dropFolder: 'Shared Documents/ValueLens' });

  const both = await plan((config) => withAzureConsumption(config, { publicNetworkAccess: false }));
  assert.deepEqual(both.u.asked, ['SharePoint folder for credit files and the Agent 365 export (the address of a folder in a document library)']);
  assert.match(both.u.text(), /Private networking keeps vlens storage off the internet, where Power Automate runs, so the flow and your uploads go to a SharePoint folder the jobs read instead\./);
  assert.deepEqual(azureDropContents(both.config), ['credit files', 'the Agent 365 export']);

  const keep = (/** @type {any} */ _c, /** @type {any} */ az) => { az.drop = { ...parseDropFolder(DROP_FOLDER), granted: true }; };
  assert.equal((await plan(keep, [])).az.drop.granted, true, 'the same site keeps its grant');
  assert.equal((await plan(keep, ['https://contoso.sharepoint.com/sites/Finance/Shared Documents/ValueLens'])).az.drop.granted, false, 'another site needs its own');
  await assert.rejects(plan(() => {}, ['https://contoso.sharepoint.com/sites/Analytics']), /That is a site, not a folder/);

  const pub = await plan((_c, az) => { az.publicNetworkAccess = true; az.drop = parseDropFolder(DROP_FOLDER); }, []);
  assert.deepEqual(pub.u.asked, [], 'public storage takes the export in the landing container');
  assert.equal(pub.az.drop, undefined);

  for (const [label, setUp] of /** @type {const} */ ([
    ['Agent 365 off', (/** @type {any} */ c) => { c.modules.agent365 = false; }],
    ['demo mode', (/** @type {any} */ _c, /** @type {any} */ az) => { az.sampleData = true; }],
  ])) {
    const left = await plan((c, az) => { setUp(c, az); az.drop = parseDropFolder(DROP_FOLDER); }, []);
    assert.deepEqual(left.u.asked, [], label);
    assert.equal(left.az.drop.siteId, 'contoso.sharepoint.com:/sites/Analytics', `${label}: the folder is kept for next time`);
    assert.ok(!azureGraphRoles(left.config).includes('Sites.Selected'), label);
    assert.equal(values(left.config).dropSiteId, '', label);
  }
});

test('Azure install with Agent 365: write on the landing container for you, and where to drop the export', async () => {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  withAzureAgent365(config);
  ctx.runFirstLoad = false;

  await installAzure(ctx, { wait: true });
  const role = `assignRole /subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/vlensstabc ${ROLES.storageBlobDataContributor} user-1 User`;
  assert.deepEqual(arm.calls.filter((c) => c.startsWith('assignRole')), [role], 'no Azure roles for the jobs');
  const az = /** @type {any} */ (config.azure);
  assert.equal(az.storageRole, true);
  assert.ok(!graph.calls.some((c) => c.startsWith('grantSiteRead')));
  assert.ok(!az.graphRoles.assigned.includes('Sites.Selected'));
  const out = ui.text();
  assert.match(out, /Agent 365 export/);
  assert.match(out, /Drop the Agent 365 export in vlensstabc > landing\/agent365\. Each run loads the newest one\./);
  assert.match(out, /Agent 365: +drop the export in vlensstabc > landing\/agent365\. Each run loads the newest one\./, 'in the summary');

  const last = deployments.at(-1).properties.parameters;
  assert.ok(last.modules.value.split(',').includes('agent365'));
  assert.equal(last.dropSiteId.value, '');

  await azureStatus(ctx);
  assert.match(ui.text(), /Agent 365 CSV: +vlensstabc > landing\/agent365/);

  // An update reuses the role.
  arm.calls.length = 0;
  await installAzure(ctx, { wait: true });
  assert.ok(!arm.calls.some((c) => c.startsWith('assignRole')));
});

test('Azure install with Agent 365 and private networking: the jobs read the SharePoint folder, which uninstall leaves alone', async () => {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  // Public endpoints keep the fakes simple; the folder is what matters here.
  withAzureAgent365(config, { drop: parseDropFolder(DROP_FOLDER), createdResourceGroup: true });
  ctx.runFirstLoad = false;

  await installAzure(ctx, { wait: true });
  const az = /** @type {any} */ (config.azure);
  assert.ok(graph.calls.some((c) => c.startsWith('grantSiteRead site:contoso.sharepoint.com:/sites/Analytics')));
  assert.equal(az.drop.granted, true);
  assert.ok(az.graphRoles.assigned.includes('Sites.Selected'));
  assert.ok(!arm.calls.some((c) => c.includes('storageAccounts/')), 'no storage role for you when the export goes to SharePoint');
  assert.match(ui.text(), /Drop the Agent 365 export in https:\/\/contoso\.sharepoint\.com\/sites\/Analytics\/Shared Documents\/ValueLens\/agent365\./);
  const last = deployments.at(-1).properties.parameters;
  assert.equal(last.dropSiteId.value, 'contoso.sharepoint.com:/sites/Analytics');
  assert.equal(last.dropFolder.value, 'Shared Documents/ValueLens');

  await azureUninstall(ctx);
  assert.ok(arm.calls.includes('deleteResourceGroup rg'));
  assert.match(ui.text(), /The SharePoint drop folder https:\/\/contoso\.sharepoint\.com\/sites\/Analytics\/Shared Documents\/ValueLens and the files in it are left alone\./);
});

test('Azure install with Agent 365 in demo mode grants nothing for it', async () => {
  const arm = fakeArm();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: fakeAzureGraph().api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  withAzureAgent365(config, { sampleData: true });
  ctx.runFirstLoad = false;
  await installAzure(ctx, { wait: true });
  assert.ok(!arm.calls.some((c) => c.startsWith('assignRole')));
  assert.doesNotMatch(ui.text(), /Agent 365 export/);
});

test('Azure plan with Agent 365: the review lists the access the export needs', async () => {
  const s = teamsCatalogInstall({ answers: [false, true] });
  /** @type {any[]} */
  const plans = [];
  const review = s.ui.ui.review;
  s.ui.ui.review = (plan) => {
    plans.push(plan);
    review(plan);
  };
  const config = s.ctx.config;
  config.modules.agent365 = true;
  config.dataSources.agent365 = 'csv';
  assert.equal(await confirmAzurePlan(s.ctx), true);
  assert.match(s.ui.text(), /Agent 365: +CSV export, in the storage account > landing\/agent365/);
  assert.deepEqual(plans[0].grants.filter((/** @type {any} */ g) => /Agent 365/.test(g.detail ?? '')), [
    { who: 'You', what: 'Storage Blob Data Contributor', where: 'The storage account', detail: 'So you can upload the Agent 365 export to the landing container.' },
  ]);

  s.az().drop = parseDropFolder(DROP_FOLDER);
  const grants = azurePlanReview(s.ctx).grants;
  assert.deepEqual(grants.filter((g) => /Agent 365/.test(g.detail ?? '')), [
    { who: 'Collector managed identity', what: 'Sites.Selected (read)', where: 'https://contoso.sharepoint.com/sites/Analytics', detail: 'Reads the Agent 365 export. Needs a SharePoint or Global administrator.' },
  ]);
  assert.match(grants[0].what, /Sites\.Selected/);
});

/** @param {import('../src/config.js').InstallConfig} config @param {Partial<import('../src/config.js').AzureConfig>} [az] */
function withAzureFeedback(config, az = {}) {
  config.target = 'azure';
  config.modules.productFeedback = true;
  config.dataSources.productFeedback = 'csv';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub', ...az };
}

const FEEDBACK_FABRIC_ONLY = /On Azure product feedback comes from its CSV export: the emailed export flow is Fabric only for now\./;

test('product feedback on Azure: ticking it takes the CSV exports, because the emailed export flow is Fabric only for now', async () => {
  const pre = { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], capacities: [] };
  const choice = azureModuleChoices(fakeCtx().config.modules).find((c) => c.value === 'productFeedback');
  assert.equal(choice?.disabled, false);
  assert.match(choice?.description ?? '', /^From .+\. Shows what people say about Copilot\. On Azure it comes from the CSV export: the emailed export flow is Fabric only for now\.$/);

  const on = fakeUi({ answers: [['m365Activity', 'productFeedback'], false] });
  const picked = fakeCtx({ ui: on.ui, arm: fakeArm().api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  picked.config.dataSources.productFeedback = 'api';
  await planAzure(picked.ctx, pre, 'data');
  assert.equal(picked.config.modules.productFeedback, true);
  assert.equal(picked.config.dataSources.productFeedback, 'csv', 'a Fabric install\'s flow becomes the exports');
  assert.match(on.text(), FEEDBACK_FABRIC_ONLY);
  assert.ok(enabledAzureModuleIds(picked.config.modules, picked.config.azure).includes('productFeedback'), 'the jobs collect it');
  assert.ok(!flowsWanted(picked.config).includes('feedback'), 'no feedback flow on Azure');

  const csv = fakeUi({ answers: [['productFeedback'], false] });
  const kept = fakeCtx({ ui: csv.ui, arm: fakeArm().api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  kept.config.dataSources.productFeedback = 'csv';
  await planAzure(kept.ctx, pre, 'data');
  assert.equal(kept.config.dataSources.productFeedback, 'csv');
  assert.doesNotMatch(csv.text(), FEEDBACK_FABRIC_ONLY, 'nothing to warn about');

  const off = fakeUi({ answers: [['m365Activity'], false] });
  const left = fakeCtx({ ui: off.ui, arm: fakeArm().api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  Object.assign(left.config.modules, { productFeedback: true });
  left.config.dataSources.productFeedback = 'api';
  await planAzure(left.ctx, pre, 'data');
  assert.equal(left.config.modules.productFeedback, false);
  assert.equal(left.config.dataSources.productFeedback, 'skip');
  assert.doesNotMatch(off.text(), /Fabric only/);
  assert.ok(!enabledAzureModuleIds(left.config.modules, left.config.azure).includes('productFeedback'));
});

test('product feedback on Azure: the plan says where to drop the exports, and demo mode leaves it out', () => {
  const plan = (/** @type {Partial<import('../src/config.js').AzureConfig>} */ az, on = true) => {
    const u = fakeUi();
    const { ctx, config } = fakeCtx({ ui: u.ui });
    withAzureFeedback(config, az);
    config.modules.productFeedback = on;
    planAzureProductFeedback(ctx);
    return { text: u.text(), asked: u.asked, config };
  };
  const before = plan({});
  assert.match(before.text, /Product feedback/);
  assert.match(before.text, /On Azure product feedback comes from its CSV export: the emailed export flow is Fabric only for now\. Export it from Microsoft 365 admin center > Health > Product feedback > Export, and drop each CSV in the storage account > landing\/product_feedback\. Each run loads them all and removes duplicates by Feedback Id\./);
  assert.deepEqual(before.asked, [], 'there is nothing to choose');
  assert.equal(azureProductFeedbackOn(before.config), true);
  assert.deepEqual(azureDropContents(before.config), ['product feedback exports']);
  assert.match(plan({ outputs: { storageAccountName: 'vlensst' } }).text, /drop each CSV in vlensst > landing\/product_feedback\./);
  assert.match(plan({ publicNetworkAccess: false }).text, /drop each CSV in a product_feedback folder in the SharePoint folder you choose for the jobs\./);

  const demo = plan({ sampleData: true });
  assert.match(demo.text, /Demo mode doesn't load the product feedback sample, so product feedback is collected once you switch to your tenant's data\./);
  assert.doesNotMatch(demo.text, /Export it from/);
  assert.equal(azureProductFeedbackOn(demo.config), false);
  assert.deepEqual(azureDropContents(demo.config), []);
  assert.equal(plan({}, false).text, '');
});

test('product feedback on Azure with private networking: the exports share the SharePoint folder with the Agent 365 export and credit files', async () => {
  const plan = async (/** @type {(config: import('../src/config.js').InstallConfig, az: any) => void} */ setUp, /** @type {any[]} */ answers = [DROP_FOLDER]) => {
    const u = fakeUi({ answers });
    const { ctx, config } = fakeCtx({ ui: u.ui });
    withAzureFeedback(config, { publicNetworkAccess: false });
    setUp(config, config.azure);
    await planAzureDrop(ctx);
    return { u, config, az: /** @type {any} */ (config.azure) };
  };
  const values = (/** @type {import('../src/config.js').InstallConfig} */ config) => Object.fromEntries(Object.entries(consumptionParameters(config)).map(([k, v]) => [k, v.value]));

  const only = await plan(() => {});
  assert.deepEqual(only.u.asked, ['SharePoint folder for product feedback exports (the address of a folder in a document library)']);
  assert.match(only.u.text(), /Private networking keeps vlens storage off the internet, so your uploads go to a SharePoint folder the jobs read instead\./);
  assert.equal(only.az.drop.siteId, 'contoso.sharepoint.com:/sites/Analytics');
  assert.ok(azureGraphRoles(only.config).includes('Sites.Selected'), 'the jobs read the folder');
  assert.deepEqual(values(only.config), { azureAiSubscriptionId: '', paygSubscriptionIds: '', dropSiteId: 'contoso.sharepoint.com:/sites/Analytics', dropDriveId: '', dropFolder: 'Shared Documents/ValueLens' });

  const exports = await plan((config) => {
    config.modules.agent365 = true;
    config.dataSources.agent365 = 'csv';
  });
  assert.deepEqual(exports.u.asked, ['SharePoint folder for the Agent 365 export and product feedback exports (the address of a folder in a document library)']);

  const all = await plan((config) => {
    withAzureConsumption(config, { publicNetworkAccess: false });
    config.modules.agent365 = true;
    config.dataSources.agent365 = 'csv';
  });
  assert.deepEqual(all.u.asked, ['SharePoint folder for credit files, the Agent 365 export and product feedback exports (the address of a folder in a document library)']);
  assert.match(all.u.text(), /where Power Automate runs, so the flow and your uploads go to a SharePoint folder the jobs read instead\./);
  assert.deepEqual(azureDropContents(all.config), ['credit files', 'the Agent 365 export', 'product feedback exports']);

  const pub = await plan((_c, az) => { az.publicNetworkAccess = true; az.drop = parseDropFolder(DROP_FOLDER); }, []);
  assert.deepEqual(pub.u.asked, [], 'public storage takes the exports in the landing container');
  assert.equal(pub.az.drop, undefined);

  const demo = await plan((_c, az) => { az.sampleData = true; az.drop = parseDropFolder(DROP_FOLDER); }, []);
  assert.deepEqual(demo.u.asked, []);
  assert.equal(demo.az.drop.siteId, 'contoso.sharepoint.com:/sites/Analytics', 'the folder is kept for next time');
  assert.ok(!azureGraphRoles(demo.config).includes('Sites.Selected'));
  assert.equal(values(demo.config).dropSiteId, '');
});

test('Azure install with product feedback: write on the landing container for you, and where to drop the exports', async () => {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  withAzureFeedback(config);
  config.modules.agent365 = true;
  config.dataSources.agent365 = 'csv';
  ctx.runFirstLoad = false;

  await installAzure(ctx, { wait: true });
  const role = `assignRole /subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/vlensstabc ${ROLES.storageBlobDataContributor} user-1 User`;
  assert.deepEqual(arm.calls.filter((c) => c.startsWith('assignRole')), [role], 'one role for both exports, and none for the jobs');
  const az = /** @type {any} */ (config.azure);
  assert.equal(az.storageRole, true);
  assert.ok(!graph.calls.some((c) => c.startsWith('grantSiteRead')));
  assert.ok(!az.graphRoles.assigned.includes('Sites.Selected'));
  const out = ui.text();
  assert.match(out, /Product feedback export/);
  assert.match(out, /Drop product feedback exports in vlensstabc > landing\/product_feedback\. Each run loads them all and removes duplicates by Feedback Id\./);
  assert.match(out, /Feedback: +drop exports in vlensstabc > landing\/product_feedback\. Each run loads them all and removes duplicates by Feedback Id\./, 'in the summary');
  assert.match(out, /Agent 365: +drop the export in vlensstabc > landing\/agent365\./);

  const last = deployments.at(-1).properties.parameters;
  assert.deepEqual(last.modules.value.split(',').filter((/** @type {string} */ m) => m === 'agent365' || m === 'productFeedback'), ['agent365', 'productFeedback']);
  assert.equal(last.dropSiteId.value, '');

  await azureStatus(ctx);
  assert.match(ui.text(), /Feedback CSV: +vlensstabc > landing\/product_feedback/);

  // An update reuses the role.
  arm.calls.length = 0;
  await installAzure(ctx, { wait: true });
  assert.ok(!arm.calls.some((c) => c.startsWith('assignRole')));
});

test('Azure install with product feedback and private networking: one read grant on the SharePoint site, which uninstall leaves alone', async () => {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  // Public endpoints keep the fakes simple; the folder is what matters here.
  withAzureFeedback(config, { drop: parseDropFolder(DROP_FOLDER), createdResourceGroup: true });
  config.modules.agent365 = true;
  config.dataSources.agent365 = 'csv';
  ctx.runFirstLoad = false;

  await installAzure(ctx, { wait: true });
  const az = /** @type {any} */ (config.azure);
  assert.equal(graph.calls.filter((c) => c.startsWith('grantSiteRead')).length, 1, 'one grant covers both exports');
  assert.ok(graph.calls.some((c) => c.startsWith('grantSiteRead site:contoso.sharepoint.com:/sites/Analytics')));
  assert.equal(az.drop.granted, true);
  assert.ok(az.graphRoles.assigned.includes('Sites.Selected'));
  assert.ok(!arm.calls.some((c) => c.includes('storageAccounts/')), 'no storage role for you when the exports go to SharePoint');
  assert.match(ui.text(), /Drop product feedback exports in https:\/\/contoso\.sharepoint\.com\/sites\/Analytics\/Shared Documents\/ValueLens\/product_feedback\. Each run loads them all and removes duplicates by Feedback Id\./);
  const last = deployments.at(-1).properties.parameters;
  assert.equal(last.dropSiteId.value, 'contoso.sharepoint.com:/sites/Analytics');
  assert.equal(last.dropFolder.value, 'Shared Documents/ValueLens');

  await azureUninstall(ctx);
  assert.ok(arm.calls.includes('deleteResourceGroup rg'));
  assert.match(ui.text(), /The SharePoint drop folder https:\/\/contoso\.sharepoint\.com\/sites\/Analytics\/Shared Documents\/ValueLens and the files in it are left alone\./);
});

test('Azure install with product feedback in demo mode grants nothing for it', async () => {
  const arm = fakeArm();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: fakeAzureGraph().api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  withAzureFeedback(config, { sampleData: true });
  ctx.runFirstLoad = false;
  await installAzure(ctx, { wait: true });
  assert.ok(!arm.calls.some((c) => c.startsWith('assignRole')));
  assert.doesNotMatch(ui.text(), /Product feedback export|Drop product feedback|Feedback CSV/);
});

test('Azure plan with product feedback: the review lists the access the exports need', async () => {
  const s = teamsCatalogInstall({ answers: [false, true] });
  /** @type {any[]} */
  const plans = [];
  const review = s.ui.ui.review;
  s.ui.ui.review = (plan) => {
    plans.push(plan);
    review(plan);
  };
  const config = s.ctx.config;
  config.modules.productFeedback = true;
  config.dataSources.productFeedback = 'csv';
  assert.equal(await confirmAzurePlan(s.ctx), true);
  assert.match(s.ui.text(), /Feedback: +CSV exports, in the storage account > landing\/product_feedback/);
  const feedback = (/** @type {{ detail?: string }[]} */ grants) => grants.filter((g) => /product feedback/.test(g.detail ?? ''));
  assert.deepEqual(feedback(plans[0].grants), [
    { who: 'You', what: 'Storage Blob Data Contributor', where: 'The storage account', detail: 'So you can upload product feedback exports to the landing container.' },
  ]);

  config.modules.agent365 = true;
  config.dataSources.agent365 = 'csv';
  assert.deepEqual(feedback(azurePlanReview(s.ctx).grants), [
    { who: 'You', what: 'Storage Blob Data Contributor', where: 'The storage account', detail: 'So you can upload the Agent 365 export and product feedback exports to the landing container.' },
  ]);

  s.az().drop = parseDropFolder(DROP_FOLDER);
  assert.deepEqual(feedback(azurePlanReview(s.ctx).grants), [
    { who: 'Collector managed identity', what: 'Sites.Selected (read)', where: 'https://contoso.sharepoint.com/sites/Analytics', detail: 'Reads the Agent 365 export and the product feedback exports. Needs a SharePoint or Global administrator.' },
  ]);
});

/** @param {import('../src/config.js').InstallConfig} config @param {Partial<import('../src/config.js').AzureConfig>} [az] */
function withAzureWorkday(config, az = {}) {
  config.target = 'azure';
  config.dataSources.workday = 'csv';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub', ...az };
}

const WORKDAY_NOTE = /In Workday, run a report of active workers that includes Primary Work Email and the fields you want \(cost centre, level, location\), then export it to CSV\. Drop the CSV in the storage account > landing\/workday\. Each run loads the newest one\. It adds the Workday columns Entra ID doesn't have to the org data, matched on Primary Work Email\. Where Entra ID already has a column, its values stay, even blank ones, and people only in Workday are left out\./;

test('Workday org data on Azure: asked behind Advanced settings or set with --data, and the plan says where to drop the export', async () => {
  const plan = async (/** @type {{ az?: Partial<import('../src/config.js').AzureConfig>, workday?: 'csv' | 'skip', advanced?: boolean, orgData?: boolean, answers?: any[] }} */ o = {}) => {
    const u = fakeUi({ answers: o.answers ?? [] });
    const { ctx, config } = fakeCtx({ ui: u.ui });
    withAzureWorkday(config, o.az);
    config.dataSources.workday = o.workday ?? 'skip';
    if (o.orgData === false) config.modules.orgData = false;
    if (o.advanced !== undefined) ctx.advanced = o.advanced;
    await planAzureWorkday(ctx);
    return { text: u.text(), asked: u.asked, config };
  };

  const picked = await plan({ answers: ['csv'] });
  assert.deepEqual(picked.asked, ['Workday org data?']);
  assert.equal(picked.config.dataSources.workday, 'csv');
  assert.match(picked.text, WORKDAY_NOTE);
  assert.equal(azureWorkdayOn(picked.config), true);
  assert.deepEqual(azureDropContents(picked.config), ['the Workday export']);

  const declined = await plan({ workday: 'csv', answers: ['skip'] });
  assert.equal(declined.config.dataSources.workday, 'skip');
  assert.doesNotMatch(declined.text, /Drop the CSV/);
  assert.equal(azureWorkdayOn(declined.config), false);
  assert.deepEqual(azureDropContents(declined.config), []);

  const flag = await plan({ workday: 'csv', advanced: false });
  assert.deepEqual(flag.asked, [], 'without Advanced settings, --data workday=csv or the saved choice stands');
  assert.equal(flag.config.dataSources.workday, 'csv');
  assert.match(flag.text, WORKDAY_NOTE);
  assert.equal((await plan({ advanced: false })).text, '');

  assert.match((await plan({ workday: 'csv', advanced: false, az: { outputs: { storageAccountName: 'vlensst' } } })).text, /Drop the CSV in vlensst > landing\/workday\./);
  assert.match((await plan({ workday: 'csv', advanced: false, az: { publicNetworkAccess: false } })).text, /Drop the CSV in a workday folder in the SharePoint folder you choose for the jobs\./);

  const demo = await plan({ workday: 'csv', az: { sampleData: true } });
  assert.deepEqual(demo.asked, []);
  assert.match(demo.text, /Demo mode doesn't load a Workday sample, so Workday org data is collected once you switch to your tenant's data\./);
  assert.equal(demo.config.dataSources.workday, 'csv', 'kept for when you switch');
  assert.equal(azureWorkdayOn(demo.config), false);
  assert.deepEqual(azureDropContents(demo.config), []);
  assert.equal((await plan({ az: { sampleData: true } })).text, '');

  const noOrg = await plan({ workday: 'csv', orgData: false });
  assert.deepEqual(noOrg.asked, [], 'it enriches the org data, so it needs it');
  assert.equal(azureWorkdayOn(noOrg.config), false);
});

test('Workday org data on Azure with private networking: the export shares the SharePoint folder with the other drops', async () => {
  const ask = async (/** @type {(config: import('../src/config.js').InstallConfig) => void} */ setUp) => {
    const u = fakeUi({ answers: [DROP_FOLDER] });
    const { ctx, config } = fakeCtx({ ui: u.ui });
    withAzureWorkday(config, { publicNetworkAccess: false });
    setUp(config);
    await planAzureDrop(ctx);
    return { asked: u.asked, config };
  };
  const only = await ask(() => {});
  assert.deepEqual(only.asked, ['SharePoint folder for the Workday export (the address of a folder in a document library)']);
  assert.ok(azureGraphRoles(only.config).includes('Sites.Selected'), 'the jobs read the folder');

  const all = await ask((config) => {
    withAzureConsumption(config, { publicNetworkAccess: false });
    Object.assign(config.modules, { agent365: true, productFeedback: true });
    Object.assign(config.dataSources, { agent365: 'csv', productFeedback: 'csv' });
  });
  assert.deepEqual(all.asked, ['SharePoint folder for credit files, the Agent 365 export, product feedback exports and the Workday export (the address of a folder in a document library)']);
  assert.deepEqual(azureDropContents(all.config), ['credit files', 'the Agent 365 export', 'product feedback exports', 'the Workday export']);
});

/** An Azure install against fakes that records each deployment's parameters. */
function workdayInstall(/** @type {Partial<import('../src/config.js').AzureConfig>} */ az = {}) {
  const arm = fakeArm();
  /** @type {any[]} */
  const deployments = [];
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    deployments.push(args[3]);
    return deploy(...args);
  };
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  withAzureWorkday(config, az);
  ctx.runFirstLoad = false;
  const params = () => deployments.at(-1).properties.parameters;
  return { arm, graph, ui, ctx, config, params, modules: () => /** @type {string} */ (params().modules.value).split(',') };
}

test('Azure install with Workday org data: write on the landing container for you, the jobs enrich the org data in place, and where to drop the export', async () => {
  const s = workdayInstall();
  await installAzure(s.ctx, { wait: true });
  const role = `assignRole /subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/vlensstabc ${ROLES.storageBlobDataContributor} user-1 User`;
  assert.deepEqual(s.arm.calls.filter((c) => c.startsWith('assignRole')), [role]);
  const az = /** @type {any} */ (s.config.azure);
  assert.equal(az.storageRole, true);
  assert.ok(!s.graph.calls.some((c) => c.startsWith('grantSiteRead')));
  const out = s.ui.text();
  assert.match(out, /Drop the Workday export in vlensstabc > landing\/workday\. Each run loads the newest one\./);
  assert.match(out, /Workday: +drop the export in vlensstabc > landing\/workday\. Each run loads the newest one\./, 'in the summary');

  assert.ok(s.modules().includes('workday'), 'the jobs collect it');
  assert.equal(s.params().workdayOutputTable.value, 'dbo.copilot_org_data', 'into the org data, as on Fabric');
  assert.equal(s.params().workdayAllowBaseOverwrite.value, true);
  assert.equal(s.params().dropSiteId.value, '');

  await azureStatus(s.ctx);
  assert.match(s.ui.text(), /Workday CSV: +vlensstabc > landing\/workday/);

  // Leaving it out stops the jobs collecting it.
  s.config.dataSources.workday = 'skip';
  s.arm.calls.length = 0;
  await installAzure(s.ctx, { wait: true });
  assert.ok(!s.modules().includes('workday'));
  assert.ok(!s.arm.calls.some((c) => c.startsWith('assignRole')));
});

test('Azure install with Workday org data and private networking: a read grant on the SharePoint site, which uninstall leaves alone', async () => {
  // Public endpoints keep the fakes simple; the folder is what matters here.
  const s = workdayInstall({ drop: parseDropFolder(DROP_FOLDER), createdResourceGroup: true });
  await installAzure(s.ctx, { wait: true });
  const az = /** @type {any} */ (s.config.azure);
  assert.equal(s.graph.calls.filter((c) => c.startsWith('grantSiteRead')).length, 1);
  assert.ok(s.graph.calls.some((c) => c.startsWith('grantSiteRead site:contoso.sharepoint.com:/sites/Analytics')));
  assert.equal(az.drop.granted, true);
  assert.ok(az.graphRoles.assigned.includes('Sites.Selected'));
  assert.ok(!s.arm.calls.some((c) => c.includes('storageAccounts/')), 'no storage role for you when the export goes to SharePoint');
  assert.match(s.ui.text(), /Drop the Workday export in https:\/\/contoso\.sharepoint\.com\/sites\/Analytics\/Shared Documents\/ValueLens\/workday\. Each run loads the newest one\./);
  assert.equal(s.params().dropSiteId.value, 'contoso.sharepoint.com:/sites/Analytics');
  assert.equal(s.params().dropFolder.value, 'Shared Documents/ValueLens');

  await azureUninstall(s.ctx);
  assert.ok(s.arm.calls.includes('deleteResourceGroup rg'));
  assert.match(s.ui.text(), /The SharePoint drop folder https:\/\/contoso\.sharepoint\.com\/sites\/Analytics\/Shared Documents\/ValueLens and the files in it are left alone\./);
});

test('Azure install with Workday org data in demo mode grants nothing for it, and the jobs leave it out', async () => {
  const s = workdayInstall({ sampleData: true });
  await installAzure(s.ctx, { wait: true });
  assert.ok(!s.arm.calls.some((c) => c.startsWith('assignRole')));
  assert.ok(!s.modules().includes('workday'));
  assert.doesNotMatch(s.ui.text(), /Workday export|Workday CSV/);
});

test('Azure plan with Workday org data: the review lists the access the export needs', async () => {
  const s = teamsCatalogInstall({ answers: [false, true] });
  /** @type {any[]} */
  const plans = [];
  const review = s.ui.ui.review;
  s.ui.ui.review = (plan) => {
    plans.push(plan);
    review(plan);
  };
  s.ctx.config.dataSources.workday = 'csv';
  assert.equal(await confirmAzurePlan(s.ctx), true);
  assert.match(s.ui.text(), /Workday: +CSV export, in the storage account > landing\/workday/);
  const workday = (/** @type {{ detail?: string }[]} */ grants) => grants.filter((g) => /Workday/.test(g.detail ?? ''));
  assert.deepEqual(workday(plans[0].grants), [
    { who: 'You', what: 'Storage Blob Data Contributor', where: 'The storage account', detail: 'So you can upload the Workday export to the landing container.' },
  ]);

  s.az().drop = parseDropFolder(DROP_FOLDER);
  assert.deepEqual(workday(azurePlanReview(s.ctx).grants), [
    { who: 'Collector managed identity', what: 'Sites.Selected (read)', where: 'https://contoso.sharepoint.com/sites/Analytics', detail: 'Reads the Workday export. Needs a SharePoint or Global administrator.' },
  ]);
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
  await assert.rejects(azurePreflight(ctx), /Azure Policy blocked the deployment.*Public SQL denied.*exemption.*private networking/is);
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

test('policy denials nested in a failed deployment name each policy, assignment and resource', async () => {
  const violation = (/** @type {string} */ definition, /** @type {string} */ assignment) => ({
    type: 'PolicyViolation',
    info: { policyDefinitionDisplayName: definition, policyDefinitionId: `/providers/Microsoft.Authorization/policyDefinitions/${definition.replace(/\W+/g, '-')}`, policyAssignmentDisplayName: assignment, policyAssignmentId: `/providers/Microsoft.Management/managementGroups/corp/providers/Microsoft.Authorization/policyAssignments/${assignment.replace(/\W+/g, '-')}` },
  });
  const deployment = {
    name: 'valuelens',
    properties: {
      provisioningState: 'Failed',
      error: {
        code: 'DeploymentFailed',
        message: 'At least one resource deployment operation failed.',
        details: [{
          code: 'ResourceDeploymentFailure',
          target: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Resources/deployments/vl-network',
          message: 'The resource write operation failed to complete successfully, because it reached terminal provisioning state \'Failed\'.',
          details: [{
            code: 'DeploymentFailed',
            details: [
              { code: 'RequestDisallowedByPolicy', target: 'privatelink.blob.core.windows.net', message: "Resource 'privatelink.blob.core.windows.net' was disallowed by policy.", additionalInfo: [violation('Deny the creation of private DNS', 'Deny-Private-DNS-Zones')] },
              { code: 'RequestDisallowedByPolicy', target: 'vnet-vlens-abc123', message: JSON.stringify({ error: { code: 'RequestDisallowedByPolicy', message: "Resource 'vnet-vlens-abc123' was disallowed by policy. Policy identifiers: '[{\"policyAssignment\":{\"name\":\"Subnets need NSG\",\"id\":\"/a/subnets-nsg\"},\"policyDefinition\":{\"name\":\"Subnets should have an NSG\",\"id\":\"/d/subnets-nsg\"}}]'." } }) },
            ],
          }],
        }],
      },
    },
  };
  const err = await waitForDeployment(async () => deployment, { properties: { provisioningState: 'Running' } }, { sleep: async () => {}, pollMs: 0 }).catch((e) => e);
  assert.match(err.message, /RequestDisallowedByPolicy \(privatelink\.blob\.core\.windows\.net\): Resource 'privatelink\.blob/);
  assert.match(err.message, /RequestDisallowedByPolicy \(vnet-vlens-abc123\)/, 'JSON in a nested message is unpacked');
  assert.equal(armErrors(err.body).filter((e) => e.code === 'RequestDisallowedByPolicy').length, 3);
  const message = policyMessage(err, { publicNetworkAccess: false });
  assert.match(message, /"Deny the creation of private DNS" on privatelink\.blob\.core\.windows\.net \(assignment "Deny-Private-DNS-Zones", \/providers\/Microsoft\.Management\/managementGroups\/corp\//);
  assert.match(message, /"Subnets should have an NSG" on vnet-vlens-abc123 \(assignment "Subnets need NSG", \/a\/subnets-nsg\) \[\/d\/subnets-nsg\]/);
  assert.match(message, /existing private DNS zones or leave DNS to Azure Policy/);
  assert.doesNotMatch(message, /choose advanced options and Private networking\.$/m, 'already private: no advice to choose Private networking');
  assert.match(policyMessage(err, { publicNetworkAccess: true }), /choose advanced options and Private networking/);
  const ingress = { error: { code: 'RequestDisallowedByPolicy', target: 'cae-vlens-abc123-vnet', message: "Resource 'cae-vlens-abc123-vnet' was disallowed by policy." } };
  assert.match(policyMessage(ingress, { publicNetworkAccess: false }), /web app needs public ingress/);
  assert.equal(policyMessage(new Error('other')), '');
});

test('regional SQL capacity errors point at the Azure SQL region choice', async () => {
  const err = await waitForDeployment(async () => ({ properties: { provisioningState: 'Failed', error: { code: 'DeploymentFailed', details: [{ code: 'RegionDoesNotAllowProvisioning', message: "Location 'UK South' is not accepting creation of new Windows Azure SQL Database servers at this time." }] } } }), { properties: { provisioningState: 'Running' } }, { sleep: async () => {}, pollMs: 0 }).catch((e) => e);
  assert.match(regionCapacityMessage(err), /UK South is not accepting new Windows Azure SQL Database servers.*Azure SQL region/);
  assert.equal(regionCapacityMessage(new Error('other')), '');
});

test('a failed deployment shows the failing resource\'s own error from the deployment operations', async () => {
  const rg = '/subscriptions/sub-1/resourcegroups/rg-analytics-hub/providers/Microsoft.Resources/deployments';
  const generic = "The resource write operation failed to complete successfully, because it reached terminal provisioning state 'Failed'.";
  const failed = { provisioningState: 'Failed', error: { code: 'DeploymentFailed', message: 'At least one resource deployment operation failed.', details: [{ code: 'ResourceDeploymentFailure', target: `${rg}/vl-sql`, message: generic }] } };
  const firewall = 'Unable to create or modify firewall rules when public network interface for the server is disabled. To manage server or database level firewall rules, please enable the public network interface.';
  /** @type {Record<string, any[]>} */
  const operations = {
    [`${rg}/valuelens/operations`]: [
      { properties: { provisioningState: 'Succeeded', targetResource: { id: `${rg}/vl-storage`, resourceType: 'Microsoft.Resources/deployments', resourceName: 'vl-storage' } } },
      { properties: { provisioningState: 'Failed', statusMessage: { status: 'Failed', error: { code: 'ResourceDeploymentFailure', message: generic } }, targetResource: { id: `${rg}/vl-sql`, resourceType: 'Microsoft.Resources/deployments', resourceName: 'vl-sql' } } },
    ],
    [`${rg}/vl-sql/operations`]: [
      { properties: { provisioningState: 'Succeeded', targetResource: { resourceType: 'Microsoft.Sql/servers', resourceName: 'sql-vlens-abc123' } } },
      { properties: { provisioningState: 'Failed', statusCode: 'BadRequest', statusMessage: { status: 'Failed', error: { code: 'DenyPublicEndpointEnabled', message: firewall } }, targetResource: { id: '/x/firewallRules/AllowAllWindowsAzureIps', resourceType: 'Microsoft.Sql/servers/firewallRules', resourceName: 'sql-vlens-abc123/AllowAllWindowsAzureIps' } } },
    ],
  };
  /** @type {string[]} */
  const listed = [];
  /** @param {boolean} [opsFail] */
  const http = (opsFail) => /** @type {any} */ ({
    requestLro: async () => ({ name: 'valuelens', properties: { provisioningState: 'Running' } }),
    get: async () => ({ name: 'valuelens', properties: failed }),
    list: async (/** @type {string} */ path) => {
      listed.push(path);
      if (opsFail) throw new HttpError('Forbidden', { status: 403, method: 'GET', url: path, body: {} });
      return operations[path] ?? [];
    },
  });
  const err = await armApi(http(), { sleep: async () => {}, pollMs: 0 }).deployTemplate('sub-1', 'rg-analytics-hub', 'valuelens', {}).catch((e) => e);
  assert.equal(err.message, `ARM deployment valuelens failed: DenyPublicEndpointEnabled on Microsoft.Sql/servers/firewallRules sql-vlens-abc123/AllowAllWindowsAzureIps: ${firewall}`);
  assert.doesNotMatch(err.message, /DeploymentFailed|terminal provisioning state/);
  assert.deepEqual(listed, [`${rg}/valuelens/operations`, `${rg}/vl-sql/operations`], 'follows only the failed module');
  assert.equal(err.operations[0].code, 'DenyPublicEndpointEnabled');
  assert.match(publicAccessMessage(err), /^Azure Policy switched off public network access on the Azure SQL server/, 'explain() sees the operation error');

  const fallback = await armApi(http(true), { sleep: async () => {}, pollMs: 0 }).deployTemplate('sub-1', 'rg-analytics-hub', 'valuelens', {}).catch((e) => e);
  assert.match(fallback.message, /^ARM deployment valuelens failed: DeploymentFailed .*ResourceDeploymentFailure/, 'unreadable operations keep the deployment error');
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
  // Teams, plus Outlook and the Microsoft 365 app for the personal tab, get the tab's sign-in token without a consent prompt.
  assert.deepEqual(graph.applications.find((a) => a.displayName === 'Analytics Hub (Azure)')?.api?.preAuthorizedApplications?.map((a) => a.appId).sort(), [
    '1fec8e78-bce4-4aaf-ab1b-5451cc387264', '5e3ce6c0-2b1f-4285-8d4b-75ee78787346', '4765445b-32c6-49b0-83e6-1d93765276ca', '0ec893e0-5785-4de6-99da-4ed124e5296c',
    'd3590ed6-52b3-4102-aeff-aad2292ab01c', 'bc59ab01-8403-45c6-8796-ac3ef710b3e3', '27922004-5251-4030-b22d-91ecd9a37ea4',
  ].sort());
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

/** An Azure install with no first load, whose model the next run has to replace. @param {{ yesTo?: string[] }} [o] */
async function azureModelChanged(o = {}) {
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi({ yesTo: o.yesTo });
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api, ui: ui.ui });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
  });
  ctx.runFirstLoad = false;
  assert.equal(await installAzure(ctx, { wait: true }), true);
  config.semanticModel.signature = 'from an older version';
  powerBi.calls.length = 0;
  fabric.calls.length = 0;
  return { ctx, config, fabric, powerBi, arm, graph, ui, refreshes: () => powerBi.calls.filter((c) => c.startsWith(`refresh ${config.semanticModel.id}`)) };
}

test('Azure repair or update without a load: a replaced model is refreshed, and a failed refresh is not reported as set up', async () => {
  const t = await azureModelChanged();
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), ['updateSemanticModel Analytics Hub Model']);
  assert.equal(t.refreshes().length, 1);
  assert.match(t.ui.text(), /Analytics Hub Model may show old data or miss new columns until it reloads after its update, so refreshing it now/);

  const failed = await azureModelChanged();
  failed.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal(await installAzure(failed.ctx, { wait: true }), false);
  assert.match(failed.ui.text(), /The models weren't reloaded/);
  assert.match(failed.ui.text(), /set up, but not finished/);

  // The update command passes that on, so the CLI exits non-zero and the page shows it failed.
  const viaUpdate = await azureModelChanged({ yesTo: ['Go ahead?'] });
  viaUpdate.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal(await runCommand(viaUpdate.ctx, 'update', { wait: true }), false);
  assert.equal(viaUpdate.refreshes().length, 1);

  // Nothing replaced, in the next run: no extra refresh.
  const same = await azureModelChanged();
  same.config.semanticModel.signature = undefined;
  await installAzure(same.ctx, { wait: true });
  same.powerBi.calls.length = 0;
  assert.equal(await installAzure(same.ctx, { wait: true }), true);
  assert.equal(same.refreshes().length, 0);
});

test('Azure: a model update Fabric can only make by clearing its data waits for a yes', async () => {
  const reset = () => new HttpError('Requires options', { status: 400, method: 'POST', url: 'https://x', code: 'RequiredOptionsMissing' });
  const declined = await azureModelChanged();
  declined.fabric.failures.updateSemanticModel = [reset()];
  await assert.rejects(installAzure(declined.ctx, { wait: true }), /Analytics Hub Model wasn't changed/);
  assert.equal(declined.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
  assert.match(declined.ui.text(), /reloads it from the Azure SQL database, which isn't changed/);

  const agreed = await azureModelChanged({ yesTo: ["Clear Analytics Hub Model's data and reload it now?"] });
  agreed.fabric.failures.updateSemanticModel = [reset()];
  assert.equal(await installAzure(agreed.ctx, { wait: true }), true);
  assert.ok(agreed.fabric.calls.includes('updateSemanticModel Analytics Hub Model allowPurgeData'));
  assert.equal(agreed.refreshes().length, 1);
});

test("Azure: a history reload that doesn't start leaves setup not finished, and says how to try again", async () => {
  const failed = await azureModelChanged();
  failed.ctx.reloadHistoryDays = 90;
  failed.arm.api.getContainerAppJob = async () => {
    throw new Error('Job not found');
  };
  assert.equal(await installAzure(failed.ctx, { wait: true }), false);
  assert.match(failed.ui.text(), /✗ The history reload didn't start: Job not found/);
  assert.match(failed.ui.text(), /Try again with ".*run --backfill-days 90"\./);
  assert.match(failed.ui.text(), /Analytics Hub is set up, but not finished/);
  assert.equal(failed.config.history.days, 30);

  const started = await azureModelChanged();
  started.ctx.reloadHistoryDays = 90;
  assert.equal(await installAzure(started.ctx, { wait: true }), true);
  assert.match(started.ui.text(), /Started run job \(vlens-run-exec\) with 90 days of audit history/);
  assert.equal(started.config.history.days, 90);
  assert.doesNotMatch(started.ui.text(), /not finished/);
  // One run stops at 4 hours, and the scheduled runs after it carry the reload on: Fabric's "many hours" doesn't fit.
  assert.match(started.ui.text(), /A run stops at 4 hours\. On a large tenant, the scheduled runs after it carry on with the reload until it has all loaded\. Job images older than this installer ignore VALUELENS_AUDIT_BACKFILL_DAYS/);
  assert.doesNotMatch(started.ui.text(), /many hours on a large tenant/);
  const detail = (/** @type {number} */ days) => {
    started.ctx.reloadHistoryDays = days;
    return azurePlanReview(started.ctx).runsOn.find((r) => r.what === 'History reload')?.detail;
  };
  assert.equal(detail(90), 'The run job, once, with VALUELENS_AUDIT_BACKFILL_DAYS=90. A run stops at 4 hours. On a large tenant, the scheduled runs after it carry on with the reload until it has all loaded.');
  assert.equal(detail(30), 'The run job, once, with VALUELENS_AUDIT_BACKFILL_DAYS=30. Usually under an hour.');

  // Repair or change's question, the first place the wording shows, says the same: Azure has no pipeline.
  const asking = fakeUi();
  /** @type {{ message: string, choices: any[] }[]} */
  const selects = [];
  asking.ui.select = async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    selects.push({ message, choices });
    return def;
  };
  const repair = fakeCtx({ ui: asking.ui, arm: fakeArm().api });
  repair.config.target = 'azure';
  repair.config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', outputs: { runJobName: 'vlens-run' }, status: { lastRun: { name: 'vlens-run-exec', status: 'Succeeded' } } };
  repair.config.history.days = 30;
  await planAzure(repair.ctx, { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }] }, 'schedule');
  const reload = selects.find((s) => s.message.startsWith('Load more audit history?'));
  assert.deepEqual(reload?.choices.map((c) => c.description), [
    undefined,
    'Runs the job once with 90 days of history. A run stops at 4 hours. On a large tenant, the scheduled runs after it carry on with the reload until it has all loaded.',
    'Runs the job once with 180 days of history. A run stops at 4 hours. On a large tenant, the scheduled runs after it carry on with the reload until it has all loaded.',
  ]);
});

/** Org-scoped access on, for the next run. @param {Pick<Awaited<ReturnType<typeof azureModelChanged>>, 'config' | 'graph' | 'powerBi'>} t */
function orgAccessOn(t) {
  t.config.access = /** @type {any} */ ({ ...t.config.access, groupId: 'group-1', groupName: 'Analytics Hub Viewers', rls: { enabled: true, orgAttribute: 'department', applied: [] } });
  Object.assign(t.graph.api, { getGroup: async (/** @type {string} */ id) => ({ id, displayName: 'Analytics Hub Viewers' }) });
  Object.assign(t.powerBi.api, { datasetUsers: async () => [], addDatasetUser: async () => null });
}

test("Azure: org-scoped access that fails leaves setup not finished; a job it can't follow only warns", async () => {
  // A Pro workspace can't take roles with members.
  const blocked = await azureModelChanged();
  orgAccessOn(blocked);
  assert.equal(await installAzure(blocked.ctx, { wait: true }), false);
  assert.match(blocked.ui.text(), /✗ The Power BI workspace is on a Pro licence/);
  assert.match(blocked.ui.text(), /Fix that, or turn org-scoped access off from ".*access"\./);
  assert.match(blocked.ui.text(), /Analytics Hub is set up, but not finished/);

  const unfollowed = await azureModelChanged();
  orgAccessOn(unfollowed);
  /** @type {any} */ (unfollowed.config.azure).powerBi.capacityId = 'cap-1';
  unfollowed.ctx.api.dataLake = /** @type {any} */ (() => ({ readText: async () => null, writeFile: async () => {} }));
  unfollowed.fabric.jobs.push({ status: 'Completed' });
  const start = unfollowed.arm.api.startContainerAppJob;
  // Azure starts the job that loads the scopes, but doesn't say which run it is.
  unfollowed.arm.api.startContainerAppJob = async (sub, rg, name, template) => (template?.containers?.[0]?.args?.includes('--steps') ? /** @type {any} */ ({}) : start(sub, rg, name, template));
  assert.equal(await installAzure(unfollowed.ctx, { wait: true }), true);
  const text = unfollowed.ui.text();
  assert.match(text, /! Azure didn't say which run of the run job \(access,refresh\) this is/);
  assert.doesNotMatch(text, /✗/);
  assert.match(text, /Analytics Hub is set up/);
  assert.doesNotMatch(text, /not finished/);
});

/** The record as the next run reads it, saved and read back through the installer's own files. */
function readBack(/** @type {any} */ config) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-azure-reload-'));
  try {
    const file = join(dir, 'valuelens-install.json');
    saveConfig(file, config);
    return loadConfig(file).config;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const interruption of ['a failed refresh', 'a refresh Completed with warnings', 'an error after the model was replaced']) {
  test(`Azure: after ${interruption}, the next run reloads the model before it says set up`, async () => {
    const reset = () => new HttpError('Requires options', { status: 400, method: 'POST', url: 'https://x', code: 'RequiredOptionsMissing' });
    const t = await azureModelChanged({ yesTo: ["Clear Analytics Hub Model's data and reload it now?"] });
    t.fabric.failures.updateSemanticModel = [reset()];
    // The history shows each refresh only as Completed; its details say whether it was clean.
    const refresh = t.powerBi.api.refresh;
    t.powerBi.api.refresh = async (/** @type {any[]} */ ...args) => {
      const id = await /** @type {any} */ (refresh)(...args);
      t.powerBi.history.unshift({ requestId: id, status: 'Completed', startTime: '2026-06-01T12:00:01Z' });
      return id;
    };
    const warned = { status: 'Completed', extendedStatus: 'Completed', messages: [{ type: 'Warning', message: 'A calculated table could not be calculated.' }] };
    if (interruption === 'a failed refresh') {
      t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
      assert.equal(await installAzure(t.ctx, { wait: true }), false);
    } else if (interruption === 'a refresh Completed with warnings') {
      t.powerBi.states.push(warned);
      assert.equal(await installAzure(t.ctx, { wait: true }), false);
      assert.match(t.ui.text(), /The models weren't reloaded/);
    } else {
      const deploy = t.arm.api.deployTemplate;
      let calls = 0;
      t.arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
        if (++calls === 2) throw new Error('Injected deployment failure');
        return /** @type {any} */ (deploy)(...args);
      };
      await assert.rejects(installAzure(t.ctx, { wait: true }), /Injected deployment failure/);
      t.arm.api.deployTemplate = deploy;
    }
    const config = readBack(t.config);
    assert.equal(config.semanticModel.reload?.cleared, true, 'the record says the model is owed a reload');

    const ui = fakeUi();
    const next = fakeCtx({ config, arm: t.arm.api, graph: t.graph.api, fabric: t.fabric.api, powerBi: t.powerBi.api, ui: ui.ui });
    next.ctx.runFirstLoad = false;
    t.powerBi.calls.length = 0;
    t.fabric.calls.length = 0;
    if (interruption === 'a refresh Completed with warnings') {
      // Warned again: still not set up, still owed, however the history reads.
      t.powerBi.states.push(warned);
      assert.equal(await installAzure(next.ctx, { wait: true }), false);
      assert.equal(t.refreshes().length, 1);
      assert.equal(readBack(config).semanticModel.reload?.cleared, true);
      t.powerBi.calls.length = 0;
    }
    assert.equal(await installAzure(next.ctx, { wait: true }), true);
    assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), [], 'the definition is already in place');
    assert.equal(t.refreshes().length, 1, 'reloaded, not reported as set up with no data');
    assert.match(ui.text(), /Analytics Hub Model has no data until it reloads after its update, so refreshing it now/);
    assert.equal(config.semanticModel.reload, undefined);

    // Once reloaded, a further run has nothing owed.
    t.powerBi.calls.length = 0;
    assert.equal(await installAzure(next.ctx, { wait: true }), true);
    assert.equal(t.refreshes().length, 0);
  });
}

test('Azure with a first load, waiting: a replaced model is reloaded before the load starts, not assumed reloaded by it', async () => {
  const t = await azureModelChanged();
  t.ctx.runFirstLoad = true;
  const order = /** @type {string[]} */ ([]);
  const refresh = t.powerBi.api.refresh;
  t.powerBi.api.refresh = async (/** @type {any[]} */ ...args) => { order.push('refresh'); return /** @type {any} */ (refresh)(...args); };
  const start = t.arm.api.startContainerAppJob;
  t.arm.api.startContainerAppJob = async (/** @type {any[]} */ ...args) => { order.push(`start ${args[2]}`); return /** @type {any} */ (start)(...args); };
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const run = t.config.azure?.outputs?.runJobName;
  assert.ok(order.indexOf('refresh') >= 0 && order.indexOf('refresh') < order.indexOf(`start ${run}`), order.join(', '));
  assert.equal(t.config.semanticModel.reload, undefined);
  assert.match(t.ui.text(), /Analytics Hub is set up/);

  const failed = await azureModelChanged();
  failed.ctx.runFirstLoad = true;
  failed.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
  assert.equal(await installAzure(failed.ctx, { wait: true }), false);
  assert.match(failed.ui.text(), /set up, but not finished/);
  assert.ok(failed.config.semanticModel.reload);
});

test('Azure: a job run with no execution name is not counted as finished', async () => {
  const t = await azureModelChanged();
  t.arm.api.startContainerAppJob = async () => /** @type {any} */ ({});
  const { startAndWaitJob } = await import('../src/steps/azure/index.js');
  assert.deepEqual(await startAndWaitJob(t.ctx, 'run', { wait: true, steps: 'access,refresh' }), { ok: false, status: 'Unknown', unfollowed: true, started: true });
  assert.match(t.ui.text(), /Azure didn't say which run of the run job \(access,refresh\) this is, so the installer can't follow it to the end/);
  // Not waiting, it is only started, which is all that is claimed.
  assert.deepEqual(await startAndWaitJob(t.ctx, 'run', { wait: false }), { ok: true, status: 'Running', started: true });
});

/** A run of the run job that's going, as Azure lists it, started `ago` minutes before the fake clock's 12:00. */
const runGoing = (/** @type {string} */ status, /** @type {number} */ ago, name = 'vlens-run-going') => [
  { name, properties: { status, startTime: new Date(Date.parse('2026-06-01T12:00:00Z') - ago * 60_000).toISOString() } },
  { name: 'vlens-run-earlier', properties: { status: 'Succeeded', startTime: '2026-05-31T12:00:00Z', endTime: '2026-05-31T13:00:00Z' } },
];

test("Azure run: doesn't start a second run while one is going, but ignores one going for over a day, and starts when it can't check", async () => {
  const t = await azureModelChanged();
  const az = /** @type {any} */ (t.config.azure);
  const lastRun = { name: 'vlens-run-earlier', status: 'Succeeded', finishedAt: '2026-05-31T13:00:00.000Z' };
  az.status.lastRun = structuredClone(lastRun);
  const starts = () => t.arm.calls.filter((c) => c === 'startJob vlens-run').length;

  for (const status of ['Running', 'Processing']) {
    t.ui.out.length = 0;
    t.arm.jobExecutions['vlens-run'] = runGoing(status, 30);
    const before = starts();
    // As Fabric's run does, the command fails: it didn't do what was asked.
    assert.equal(await runCommand(t.ctx, 'run', { wait: true }), false, status);
    assert.equal(starts(), before, `${status}: no second run`);
    assert.match(t.ui.text(), /! The run job is already running \(vlens-run-going, started 30m 00s ago\), so this didn't start another\./, status);
    assert.match(t.ui.text(), /Check on it with "valuelens-install status"\. Once it has finished, run "valuelens-install run" to start a new run\./, status);
    assert.doesNotMatch(t.ui.text(), /Started run job/, status);
    assert.deepEqual(az.status.lastRun, lastRun, `${status}: the last run is left as it was`);
  }

  // Not waiting, the command doesn't fail, as on Fabric. A run with no start time still counts as going.
  for (const [execution, warning] of /** @type {[any, string][]} */ ([
    [{ name: 'vlens-run-going', properties: { status: 'Running' } }, "! The run job is already running (vlens-run-going), so this didn't start another."],
    [{ properties: { status: 'Running' } }, "! The run job is already running, so this didn't start another."],
  ])) {
    t.ui.out.length = 0;
    t.arm.jobExecutions['vlens-run'] = [execution];
    const before = starts();
    assert.equal(await runCommand(t.ctx, 'run', { wait: false }), true, warning);
    assert.equal(starts(), before, warning);
    assert.ok(t.ui.text().includes(warning), t.ui.text());
    assert.doesNotMatch(t.ui.text(), /started .* ago/);
    assert.match(t.ui.text(), /Once it has finished, run "valuelens-install run" to start a new run\./);
    assert.deepEqual(az.status.lastRun, lastRun);
  }

  // Asked for more history: the days aren't recorded, and the note gives the command again.
  t.ui.out.length = 0;
  t.arm.jobExecutions['vlens-run'] = runGoing('Running', 30);
  const templates = t.arm.jobTemplates.length;
  assert.equal(await runCommand(t.ctx, 'run', { wait: true, backfillDays: 90 }), false);
  assert.equal(t.config.history.days, 30);
  assert.match(t.ui.text(), /Once it has finished, run "valuelens-install run --backfill-days 90" to reload 90 days of audit history\./);
  assert.equal(t.arm.jobTemplates.length, templates, 'nothing was started with the history');

  // Started over a day ago, it's stuck, not running.
  t.arm.jobExecutions['vlens-run'] = runGoing('Running', 25 * 60);
  let before = starts();
  assert.equal(await runCommand(t.ctx, 'run', { wait: true }), true);
  assert.equal(starts(), before + 1, 'a run going for over a day is ignored');
  assert.equal(az.status.lastRun.name, 'vlens-run-exec');

  // Only finished runs.
  t.arm.jobExecutions['vlens-run'] = [{ name: 'vlens-run-done', properties: { status: 'Succeeded', startTime: '2026-06-01T11:00:00Z' } }, { name: 'vlens-run-failed', properties: { status: 'Failed', startTime: '2026-06-01T10:00:00Z' } }];
  before = starts();
  assert.equal(await runCommand(t.ctx, 'run', { wait: true }), true);
  assert.equal(starts(), before + 1);

  // A check that fails starts the run, as before.
  t.arm.jobExecutions['vlens-run'] = runGoing('Running', 30);
  t.arm.failures.listContainerAppJobExecutions = [new HttpError('Internal', { status: 500, method: 'GET', url: 'https://x' })];
  before = starts();
  t.ui.out.length = 0;
  assert.equal(await runCommand(t.ctx, 'run', { wait: true, backfillDays: 90 }), true);
  assert.equal(starts(), before + 1, "a check that fails doesn't stop the run");
  assert.equal(t.config.history.days, 90);
  assert.doesNotMatch(t.ui.text(), /already running/);
});

test("Azure: the migrate job isn't held back by a run that's going", async () => {
  const t = await azureModelChanged();
  const { startAndWaitJob } = await import('../src/steps/azure/index.js');
  t.arm.jobExecutions['vlens-run'] = runGoing('Running', 30);
  t.arm.jobExecutions['vlens-migrate'] = runGoing('Running', 30, 'vlens-migrate-going');
  t.arm.calls.length = 0;
  assert.deepEqual(await startAndWaitJob(t.ctx, 'migrate', { wait: true }), { ok: true, status: 'Succeeded', started: true });
  assert.deepEqual(t.arm.calls.filter((c) => c.includes('Job')), ['startJob vlens-migrate']);
  assert.doesNotMatch(t.ui.text(), /already running/);
});

test('Azure Repair or change during the first load: no second run, and it says when the change loads', async () => {
  const t = await azureModelChanged();
  const az = /** @type {any} */ (t.config.azure);
  // The first load started 53 minutes ago and is still going.
  const firstLoad = { name: 'vlens-run-going', status: 'Running', startedAt: '2026-06-01T11:07:00.000Z' };
  az.status.lastRun = structuredClone(firstLoad);
  t.arm.jobExecutions['vlens-run'] = runGoing('Running', 53);
  t.ctx.runFirstLoad = true;
  t.arm.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(!t.arm.calls.includes('startJob vlens-run'), 'no second run');
  assert.ok(t.arm.calls.includes('listJobExecutions vlens-run'));
  const text = t.ui.text();
  assert.match(text, /! The run job is already running \(vlens-run-going, started 53m 00s ago\), so this didn't start another\./);
  assert.match(text, /Check on it with "valuelens-install status"\. Once it has finished, run "valuelens-install run" to load your changes, or they load on the next scheduled run\./);
  assert.deepEqual(az.status.lastRun, firstLoad, 'the first load is still the last run');
  assert.match(text, /Analytics Hub is set up/);
  assert.doesNotMatch(text, /not finished/);
});

test("Azure: a history reload that can't start while a run is going isn't recorded, and gives the command for later", async () => {
  const t = await azureModelChanged();
  t.ctx.reloadHistoryDays = 90;
  t.arm.jobExecutions['vlens-run'] = runGoing('Processing', 5);
  t.arm.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(!t.arm.calls.includes('startJob vlens-run'));
  assert.equal(t.config.history.days, 30, 'the reload is offered again next time');
  assert.equal(/** @type {any} */ (t.config.azure).status.lastRun, undefined);
  const text = t.ui.text();
  assert.match(text, /! The run job is already running \(vlens-run-going, started 5m 00s ago\), so this didn't start another\./);
  assert.match(text, /Once it has finished, run "valuelens-install run --backfill-days 90" to reload 90 days of audit history\./);
  assert.doesNotMatch(text, /with 90 days of audit history|The history reload didn't start/);
});

test("Azure: org-scoped access waits for a run that's going, rather than starting its job beside it", async () => {
  const t = await azureModelChanged();
  orgAccessOn(t);
  /** @type {any} */ (t.config.azure).powerBi.capacityId = 'cap-1';
  t.ctx.api.dataLake = /** @type {any} */ (() => ({ readText: async () => null, writeFile: async () => {} }));
  t.fabric.jobs.push({ status: 'Completed' });
  t.arm.jobExecutions['vlens-run'] = runGoing('Running', 10);
  t.arm.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(!t.arm.calls.includes('startJob vlens-run'), "the access job isn't started");
  const text = t.ui.text();
  assert.match(text, /! The run job is already running \(vlens-run-going, started 10m 00s ago\), so this didn't start another\./);
  assert.match(text, /Check on it with "valuelens-install status"\. Once it has finished, apply org-scoped access again from "valuelens-install access", or the next scheduled run does\./);
  assert.doesNotMatch(text, /Org-scoped access applied/);
  assert.equal(/** @type {any} */ (t.config.azure).status.lastAccess, undefined);
  assert.deepEqual(t.config.access?.rls?.applied, [], 'still owed, so the next update applies it again');
  assert.match(text, /Analytics Hub is set up/);
  assert.doesNotMatch(text, /not finished/);
});

test('Azure update from the page: a declined reset or a failed reload ends as failed, not done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-reset-'));
  try {
    for (const scenario of ['declined', 'refresh failed']) {
      const t = await azureModelChanged();
      if (scenario === 'declined') t.fabric.failures.updateSemanticModel = [new HttpError('Requires options', { status: 400, method: 'POST', url: 'https://x', code: 'RequiredOptionsMissing' })];
      else t.powerBi.states.push({ status: 'Failed', extendedStatus: 'Failed' });
      const configFile = join(dir, `${scenario.replace(' ', '-')}.json`);
      saveConfig(configFile, t.config);
      const ui = createWebUi({ now: () => 1000 });
      /** @type {string[]} */
      const asked = [];
      ui.subscribe((/** @type {any} */ e) => {
        if (e.type !== 'prompt') return;
        asked.push(e.message);
        setImmediate(() => ui.answer(e.id, e.kind === 'confirm' ? e.message === 'Go ahead?' : e.default));
      });
      const connect = async () => ({ api: t.ctx.api, user: t.ctx.user });
      const s = createSession({ ui, configFile, version: '0.0.0', connect: /** @type {any} */ (connect) });
      s.start({ command: 'update' });
      await s.settled();
      const ended = ui.history().filter((/** @type {any} */ e) => e.type === 'command' && e.state !== 'running');
      assert.deepEqual(ended.map((/** @type {any} */ e) => e.state), ['failed'], scenario);
      if (scenario === 'declined') {
        assert.ok(asked.includes("Clear Analytics Hub Model's data and reload it now?"));
        assert.match(String(ended[0].error), /Analytics Hub Model wasn't changed/);
        assert.doesNotMatch(String(ended[0].error), /--allow-model-reset/, 'the page asks instead');
        assert.equal(t.fabric.calls.filter((c) => c.includes('allowPurgeData')).length, 0);
      } else {
        assert.equal(t.refreshes().length, 1);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQL reader secret: kept tracked while Power BI may hold it, found by its ref after a stop, and removed only once a newer one is in use', async () => {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
  });
  ctx.runFirstLoad = false;
  await installAzure(ctx, { wait: true });
  const r = /** @type {any} */ (config.azure).sqlReader;
  const first = r.secretKeyId;
  const keys = () => graph.passwords.map((p) => p.keyId);
  assert.deepEqual(keys(), [first]);
  assert.match(graph.passwords[0].displayName, /^Power BI SQL credential \(ref [0-9a-f]{12}\)$/);

  // Power BI may have stored it before the error: kept pending, and the one in use stays.
  powerBi.failures.updateDatasource = [new HttpError('Internal', { status: 500, method: 'PATCH', url: 'https://x' })];
  await assert.rejects(azureRotateSecret(ctx), /Internal/);
  const maybe = keys()[1];
  assert.equal(r.secretKeyId, first);
  assert.deepEqual(r.pendingSecretKeyIds, [maybe]);
  assert.equal(r.secretAttempts, undefined);

  // A stopped run: Entra made a secret but the run never saved its key.
  graph.passwords.push({ keyId: 'key-lost', displayName: 'Power BI SQL credential (ref bbbbbbbbbbbb)' }, { keyId: 'key-foreign', displayName: 'Power BI SQL credential' });
  r.secretAttempts = [{ ref: 'bbbbbbbbbbbb', at: '2026-06-01T11:59:00Z' }];

  graph.calls.length = 0;
  await azureRotateSecret(ctx);
  const now = r.secretKeyId;
  assert.ok(![first, maybe, 'key-lost'].includes(now));
  assert.deepEqual(graph.calls.filter((c) => c.startsWith('removePassword')).sort(), [`removePassword ${first}`, `removePassword ${maybe}`, 'removePassword key-lost'].sort(), 'removed only after the new one is bound');
  assert.deepEqual(keys().sort(), [now, 'key-foreign'].sort(), "one without the ref isn't touched");
  for (const f of ['secretAttempts', 'pendingSecretKeyIds', 'retiredSecretKeyIds']) assert.equal(r[f], undefined, f);
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
  // With public endpoints, Power BI isn't given the SQL reader before the migration has made its database user.
  assert.ok(!powerBi.calls.some((c) => c.startsWith('updateDatasource')));
  const r = /** @type {any} */ (config.azure).sqlReader;
  assert.equal(r.secretKeyId, undefined);
  assert.equal(r.pendingSecretKeyIds.length, 1, 'the new secret stays pending until Power BI uses it');
});

/**
 * A first Azure install that records the migration, the models' SQL credentials, refresh schedules and refreshes,
 * and the SQL reader secret put in use and the ones removed, each with the step it ran in. Like Power BI, a public
 * data source won't take the SQL reader's credentials until a migration has made the reader's database user, which
 * it does only once a deployment has named the reader.
 * @param {{ publicNetworkAccess: boolean }} o
 */
async function azureBindRecorder(o) {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  if (o.publicNetworkAccess) powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api, ui: ui.ui });
  Object.assign(config, {
    target: 'azure',
    azure: {
      subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: '12345678-aaaa', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] },
      publicNetworkAccess: o.publicNetworkAccess, workspaceName: 'Analytics Hub', ...(o.publicNetworkAccess ? {} : { powerBi: { capacityId: 'cap-f' } }),
    },
  });
  ctx.runFirstLoad = false;

  /** @type {{ n: number, total: number, title: string }[]} */
  const steps = [];
  const showStep = ui.ui.step;
  ui.ui.step = (n, total, title) => {
    steps.push({ n, total, title });
    return showStep(n, total, title);
  };
  /** @type {string[]} */
  const events = [];
  const record = (/** @type {string} */ event) => events.push(`${event} @ ${steps.at(-1)?.title}`);

  let readerNamed = false;
  let readerUser = false;
  let started = '';
  const deployTemplate = arm.api.deployTemplate;
  arm.api.deployTemplate = async (sub, rg, name, deployment) => {
    readerNamed = !!deployment?.properties?.parameters?.sqlReaderClientId?.value;
    return deployTemplate(sub, rg, name, deployment);
  };
  const startJob = arm.api.startContainerAppJob;
  arm.api.startContainerAppJob = async (sub, rg, name, template) => {
    started = name;
    if (name === 'vlens-migrate') record('migrate');
    return startJob(sub, rg, name, template);
  };
  const execution = arm.api.getContainerAppJobExecution;
  arm.api.getContainerAppJobExecution = async () => {
    const e = await execution();
    if (started === 'vlens-migrate' && e?.properties?.status === 'Succeeded' && readerNamed) readerUser = true;
    return e;
  };
  const updateDatasource = powerBi.api.updateDatasource;
  powerBi.api.updateDatasource = async (gw, ds, body) => {
    if (!readerUser) {
      record('updateDatasource refused');
      const code = 'DM_GWPipeline_Gateway_DataSourceAccessError';
      throw new HttpError(`PATCH /v1.0/myorg/gateways/${gw}/datasources/${ds} returned 400 ${code}`, { status: 400, method: 'PATCH', url: `https://api.powerbi.com/v1.0/myorg/gateways/${gw}/datasources/${ds}`, code, body: { error: { code } } });
    }
    record('updateDatasource');
    return updateDatasource(gw, ds, body);
  };
  const bindToGateway = powerBi.api.bindToGateway;
  powerBi.api.bindToGateway = async (ws, dataset, body) => {
    record('bindToGateway');
    return bindToGateway(ws, dataset, body);
  };
  const setRefreshSchedule = powerBi.api.setRefreshSchedule;
  powerBi.api.setRefreshSchedule = async (ws, dataset) => {
    record('setRefreshSchedule');
    return setRefreshSchedule(ws, dataset);
  };
  const refresh = powerBi.api.refresh;
  powerBi.api.refresh = async (ws, id, body) => {
    record('refresh');
    return refresh(ws, id, body);
  };
  const removePassword = graph.api.removePassword;
  graph.api.removePassword = async (id, keyId) => {
    record(`removePassword ${keyId}`);
    return removePassword(id, keyId);
  };
  const reader = () => /** @type {any} */ (config.azure)?.sqlReader ?? {};
  let inUse = reader().secretKeyId;
  const save = ctx.save;
  ctx.save = () => {
    if (reader().secretKeyId !== inUse) record(`secret ${reader().secretKeyId} in use`);
    inUse = reader().secretKeyId;
    save();
  };
  return {
    arm, graph, fabric, powerBi, ui, ctx, config, steps, events, reader,
    /** The events in order, each once however many models it was for. */
    order: () => events.filter((e, i) => e !== events[i - 1]),
    /** The step titles from the one given. @param {string} title */
    titlesFrom: (title) => steps.map((s) => s.title).slice(steps.findIndex((s) => s.title === title)),
  };
}

test('Azure, public endpoints: a first install gives Power BI the SQL reader once the migration has made its database user', async () => {
  const t = await azureBindRecorder({ publicNetworkAccess: true });
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const key = t.reader().secretKeyId;
  assert.ok(key);
  assert.deepEqual(t.order(), [
    'migrate @ Database migration',
    'updateDatasource @ Power BI credentials',
    'setRefreshSchedule @ Power BI credentials',
    `secret ${key} in use @ Power BI credentials`,
  ]);
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), [key]);
  assert.match(t.ui.text(), /✓ Bound the models? to Azure SQL as Analytics Hub SQL Reader/);
});

test('Azure, private networking: the models are still bound through the gateway at Power BI model, before the migration', async () => {
  const t = await azureBindRecorder({ publicNetworkAccess: false });
  await azurePreflight(t.ctx);
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const key = t.reader().secretKeyId;
  assert.deepEqual(t.order(), [
    'bindToGateway @ Power BI model',
    'setRefreshSchedule @ Power BI model',
    `secret ${key} in use @ Power BI model`,
    'migrate @ Database migration',
  ]);
  assert.equal(t.fabric.connections[0].body.credentialDetails.skipTestConnection, true);
});

test('Azure, public endpoints: Repair keeps the secret Power BI has until it takes the new one, after the migration', async () => {
  const t = await azureBindRecorder({ publicNetworkAccess: true });
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const old = t.reader().secretKeyId;
  // The update replaces the model, which is then owed a reload.
  t.config.semanticModel.signature = 'from an older version';

  // Power BI turns the new credential down: it keeps the one it has, and that secret stays.
  t.powerBi.failures.updateDatasource = [new HttpError('Internal', { status: 500, method: 'PATCH', url: 'https://x' })];
  await assert.rejects(installAzure(t.ctx, { wait: true }), /Internal/);
  assert.equal(t.reader().secretKeyId, old);
  const turnedDown = t.reader().pendingSecretKeyIds;
  assert.equal(turnedDown.length, 1);
  assert.ok(!t.events.some((e) => e.startsWith('removePassword')));
  assert.ok(!t.events.some((e) => e.startsWith('refresh')), 'not reloaded with the old credential');

  t.events.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const now = t.reader().secretKeyId;
  assert.ok(![old, ...turnedDown].includes(now));
  assert.deepEqual(t.order(), [
    'migrate @ Database migration',
    'updateDatasource @ Power BI credentials',
    'setRefreshSchedule @ Power BI credentials',
    `secret ${now} in use @ Power BI credentials`,
    `removePassword ${old} @ Power BI credentials`,
    `removePassword ${turnedDown[0]} @ Power BI credentials`,
    // restoreAzureModels, before the next step.
    'refresh @ Power BI credentials',
  ]);
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), [now]);
});

test('Azure, public endpoints: a re-run finishes an install that stopped before its migration, as 0.6.7 did', async () => {
  const t = await azureBindRecorder({ publicNetworkAccess: true });
  // Where 0.6.7 stopped: the models deployed and the new secret pending, without the final deployment that names
  // the SQL reader, or the migration that makes its database user.
  const deployTemplate = t.arm.api.deployTemplate;
  t.arm.api.deployTemplate = async (sub, rg, name, deployment) => {
    if (deployment?.properties?.parameters?.sqlReaderClientId?.value) throw new Error('Deployment stopped');
    return deployTemplate(sub, rg, name, deployment);
  };
  await assert.rejects(installAzure(t.ctx, { wait: true }), /Deployment stopped/);
  assert.ok(t.config.semanticModel.id);
  assert.equal(t.reader().secretKeyId, undefined);
  const stopped = t.reader().pendingSecretKeyIds;
  assert.equal(stopped.length, 1);
  assert.deepEqual(t.order(), []);

  t.arm.api.deployTemplate = deployTemplate;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  const key = t.reader().secretKeyId;
  assert.deepEqual(t.order(), [
    'migrate @ Database migration',
    'updateDatasource @ Power BI credentials',
    'setRefreshSchedule @ Power BI credentials',
    `secret ${key} in use @ Power BI credentials`,
    `removePassword ${stopped[0]} @ Power BI credentials`,
  ]);
  assert.deepEqual(t.graph.passwords.map((p) => p.keyId), [key]);
});

test('Azure: Power BI credentials is a step only with public endpoints, after the migration and before org-scoped access', async () => {
  /** @param {Awaited<ReturnType<typeof azureBindRecorder>>} t */
  const counted = (t) => t.steps.every((s, i) => s.n === i + 1 && s.total === t.steps.length);

  const pub = await azureBindRecorder({ publicNetworkAccess: true });
  await installAzure(pub.ctx, { wait: true });
  assert.deepEqual(pub.titlesFrom('Power BI model'), ['Power BI model', 'Azure resources (final)', 'Database migration', 'Power BI credentials', 'Teams app']);
  assert.ok(counted(pub));

  const priv = await azureBindRecorder({ publicNetworkAccess: false });
  await azurePreflight(priv.ctx);
  priv.steps.length = 0;
  await installAzure(priv.ctx, { wait: true });
  assert.deepEqual(priv.titlesFrom('Power BI model'), ['Power BI model', 'Azure resources (final)', 'Database migration', 'Teams app']);
  assert.ok(counted(priv));
  assert.deepEqual(priv.steps.map((s) => s.title), pub.steps.map((s) => s.title).filter((s) => s !== 'Power BI credentials'));

  // Org-scoped access may refresh the models, so they have their credentials first.
  const rls = await azureBindRecorder({ publicNetworkAccess: true });
  orgAccessOn(rls);
  await installAzure(rls.ctx, { wait: true });
  assert.deepEqual(rls.titlesFrom('Power BI model'), ['Power BI model', 'Viewer access', 'Azure resources (final)', 'Database migration', 'Power BI credentials', 'Org-scoped access', 'Teams app']);
  assert.ok(counted(rls));
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

test('private networking: a connection a throttled create made anyway is reused, but not one on another gateway', async () => {
  const name = 'Analytics Hub SQL rg 12345678';
  const setup = async (/** @type {(fabric: ReturnType<typeof fakeFabric>) => void} */ before) => {
    const fabric = fakeFabric();
    const powerBi = fakePowerBi();
    const { ctx, config } = fakeCtx({ arm: fakeArm().api, graph: fakeAzureGraph().api, fabric: fabric.api, powerBi: powerBi.api });
    Object.assign(config, {
      target: 'azure',
      azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: '12345678-aaaa', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: false, workspaceName: 'Analytics Hub', powerBi: { capacityId: 'cap-f' } },
    });
    before(fabric);
    await azurePreflight(ctx);
    ctx.runFirstLoad = false;
    return { fabric, powerBi, ctx, az: /** @type {any} */ (config.azure) };
  };

  /** @type {ReturnType<typeof throttledThenTaken> | undefined} */
  let throttled;
  const t = await setup((fabric) => {
    throttled = throttledThenTaken(fabric);
    fabric.api.createConnection = throttled.createConnection;
  });
  await installAzure(t.ctx, { wait: true });
  assert.deepEqual(throttled?.sent, [`POST ${name}`, `POST ${name}`], 'the client sends it again after the 429, and Fabric answers 409');
  assert.equal(t.fabric.connections.length, 1);
  assert.equal(t.az.powerBi.connectionId, 'conn-throttled');
  assert.ok(t.fabric.calls.includes('updateConnection conn-throttled'), 'given the SQL reader secret again');
  assert.ok(t.powerBi.calls.includes(`bindToGateway ${t.az.powerBi.datasetId} ${t.az.powerBi.gatewayId} conn-throttled`));

  const other = await setup((fabric) => {
    fabric.connections.push({ id: 'conn-elsewhere', displayName: name, body: { gatewayId: 'gateway-elsewhere' } });
    fabric.failures.createConnection = [httpError(409, 'DuplicateConnectionName')];
  });
  await assert.rejects(installAzure(other.ctx, { wait: true }), /DuplicateConnectionName/);
  assert.ok(!other.fabric.calls.includes('updateConnection conn-elsewhere'), 'never takes over a connection on another gateway');
  assert.equal(other.az.powerBi.connectionId, undefined);
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
  assert.match(publicAccessMessage(err), /^Azure Policy switched off public network access on the Azure SQL server.*choose Private networking/);
  assert.match(publicAccessMessage(err, { publicNetworkAccess: true, outputs: { sqlServerFqdn: 'x' } }), /networking can't change in place: uninstall and install again with Private networking/);
  assert.equal(publicAccessMessage(err, { publicNetworkAccess: false }), '', 'never suggests Private networking when it is already on');
  assert.equal(publicAccessMessage(new Error('other')), '');
});

test('private networking never calls the storage data plane from this machine', async () => {
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', publicNetworkAccess: false, outputs: { storageAccountName: 'stvlensabc123' } };
  ctx.api.dataLake = () => assert.fail('no data-plane client in private mode');
  await assert.rejects(readScopes(ctx), /stvlensabc123 only accepts traffic from its private endpoints/);
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

const DATA_ZONES = ['privatelink.database.windows.net', 'privatelink.blob.core.windows.net', 'privatelink.dfs.core.windows.net', 'privatelink.table.core.windows.net'];
/** A private DNS zone in resource group rg. @param {string} name @param {Record<string, string>} [tags] */
const dnsZone = (name, tags = {}) => ({ id: `/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Network/privateDnsZones/${name}`, name, type: 'Microsoft.Network/privateDnsZones', location: 'global', tags });

/**
 * An install into resource group rg, which already holds these resources, with private networking and DNS zones created in rg unless `az` says otherwise.
 * @param {any[]} resources @param {Record<string, any>} [az]
 */
async function intoGroupWith(resources, az = {}) {
  const arm = fakeArm();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: fakeAzureGraph().api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: false, workspaceName: 'Analytics Hub', powerBi: { capacityId: 'cap-f' }, ...az };
  await arm.api.ensureResourceGroup('sub-1', 'rg', 'uksouth');
  arm.resources.push(...resources);
  ctx.runFirstLoad = false;
  return { arm, ctx };
}
const deployed = (/** @type {ReturnType<typeof fakeArm>} */ arm) => arm.calls.some((c) => c.startsWith('deployTemplate'));

test('Azure private networking stops before deploying when a private DNS zone it would create is already in the resource group without its tag', async () => {
  // ARM would update the zone in place and tag it as this install's, and uninstall deletes what has the tag.
  const { arm, ctx } = await intoGroupWith([dnsZone('privatelink.blob.core.windows.net')]);
  const err = await azureUpdate(ctx).then(() => assert.fail('it went ahead'), (/** @type {Error} */ e) => e);
  assert.equal(deployed(arm), false, 'nothing is deployed');
  assert.equal(err.message, [
    "Private DNS zone collision: privatelink.blob.core.windows.net already exists in resource group rg without this install's tag. With private networking, this install would update it in place and tag it as its own, so its uninstall would try to delete it and every record in it. Analytics Hub will not modify resources it did not create. To go on, either:",
    '  - Use the zones in this resource group: run the installer again, choose advanced options and Private networking, then "Use existing zones in another resource group", and give /subscriptions/sub-1/resourceGroups/rg as the resource group that holds them. On the setup page, that\'s Networking, then "Use existing zones" with the same resource group ID. Every zone the install uses must then be in it, so first create privatelink.database.windows.net, privatelink.dfs.core.windows.net and privatelink.table.core.windows.net there, for example with az network private-dns zone create -g rg -n <zone name>.',
    '  - Or install into another resource group.',
  ].join('\n'));
});

test('Azure private networking goes ahead over private DNS zones this install created, as a Repair or upgrade does', async () => {
  const { arm, ctx } = await intoGroupWith(DATA_ZONES.map((z) => dnsZone(z, { 'valuelens-install-id': 'install-1' })));
  await azureUpdate(ctx);
  assert.equal(deployed(arm), true);
});

test('Azure private networking stops over private DNS zones another Analytics Hub install created', async () => {
  const theirs = { 'valuelens-install-id': 'install-0' };
  const all = await intoGroupWith(DATA_ZONES.map((z) => dnsZone(z, theirs)));
  const err = await azurePreflight(all.ctx).then(() => assert.fail('it went ahead'), (/** @type {Error} */ e) => e);
  assert.match(err.message, /^Private DNS zone collision: privatelink\.database\.windows\.net, privatelink\.blob\.core\.windows\.net, privatelink\.dfs\.core\.windows\.net and privatelink\.table\.core\.windows\.net already exist in resource group rg without this install's tag\. With private networking, this install would update them in place and tag them as its own, so its uninstall would try to delete them and every record in them\. They belong to another Analytics Hub install, and its uninstall would try to delete them even while this install uses them\. /);
  assert.doesNotMatch(err.message, /first create/, 'every zone the install uses is there already');

  const some = await intoGroupWith([dnsZone('privatelink.database.windows.net', theirs), dnsZone('privatelink.blob.core.windows.net')]);
  await assert.rejects(azurePreflight(some.ctx), /already exist in resource group rg without this install's tag\. .* privatelink\.database\.windows\.net belongs to another Analytics Hub install, and its uninstall would try to delete it even while this install uses it\. .*first create privatelink\.dfs\.core\.windows\.net and privatelink\.table\.core\.windows\.net there/s);
});

test('Azure private DNS zone check: zones the deployment does not create, public networking, and existing or no DNS zones go ahead', async () => {
  const keyVault = await intoGroupWith([dnsZone('privatelink.vaultcore.azure.net'), dnsZone('privatelink.blob.core.windows.net.example.com')]);
  await azurePreflight(keyVault.ctx);
  const untagged = () => DATA_ZONES.map((z) => dnsZone(z));
  await azurePreflight((await intoGroupWith(untagged(), { publicNetworkAccess: true })).ctx);
  // Existing zones in the install's own resource group: the VNet is linked to them, and they're not tagged as this install's.
  await azurePreflight((await intoGroupWith(untagged(), { privateDns: { mode: 'existing', resourceGroupId: '/subscriptions/sub-1/resourceGroups/rg' } })).ctx);
  await azurePreflight((await intoGroupWith(untagged(), { privateDns: { mode: 'none' } })).ctx);
});

test('Azure private DNS zone check: the AI zones count only when the install creates the Ask account', async () => {
  const openAi = () => [dnsZone('privatelink.openai.azure.com')];
  await azurePreflight((await intoGroupWith(openAi())).ctx);
  await azurePreflight((await intoGroupWith(openAi(), { ask: { mode: 'existing', endpoint: 'https://ask.example.com/', deployment: 'chat' } })).ctx);
  await assert.rejects(
    azurePreflight((await intoGroupWith(openAi(), { ask: { mode: 'create' } })).ctx),
    /Private DNS zone collision: privatelink\.openai\.azure\.com already exists in resource group rg without this install's tag\..*first create privatelink\.database\.windows\.net, privatelink\.blob\.core\.windows\.net, privatelink\.dfs\.core\.windows\.net, privatelink\.table\.core\.windows\.net, privatelink\.cognitiveservices\.azure\.com and privatelink\.services\.ai\.azure\.com there/s,
  );
});

/**
 * An Azure install that created its resource group, Power BI workspace and app registrations.
 * @param {{ answers?: any[] }} [o]  answers: the uninstall's prompts, in order.
 */
async function createdAzureInstall(o = {}) {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  powerBi.workspaces.push({ id: 'pbi-ws-1', name: 'Analytics Hub' });
  const ui = fakeUi({ answers: o.answers });
  const { ctx, config, sleeps } = fakeCtx({ ui: ui.ui, arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api });
  config.target = 'azure';
  config.fabric.workspaceId = 'pbi-ws-1';
  config.azure = {
    subscriptionId: 'sub-1',
    resourceGroup: 'rg',
    location: 'uksouth',
    installId: 'install-1',
    createdResourceGroup: true,
    workspaceName: 'Analytics Hub',
    powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true, datasetId: 'ds-1', consumptionDatasetId: 'cc-1', agentEvaluatorDatasetId: 'ae-1', connectionId: 'conn-1' },
    webApp: { clientId: 'web-client', objectId: 'web-obj', created: true },
    sqlReader: { clientId: 'sql-client', objectId: 'sql-obj', created: true },
  };
  await arm.api.ensureResourceGroup('sub-1', 'rg', 'uksouth');
  return { arm, graph, fabric, powerBi, ui, ctx, config, sleeps, az: /** @type {any} */ (config.azure) };
}

const DELETE_WORKSPACE = 'Delete Power BI workspace "Analytics Hub" and everything in it, including the semantic models?';

test('Azure uninstall deletes the Power BI workspace the install created, after asking, and forgets it', async () => {
  const t = await createdAzureInstall();
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(t.ui.asked, [DELETE_WORKSPACE], 'asked before anything is deleted, and defaults to Yes');
  assert.deepEqual(t.powerBi.calls, ['deleteGroup pbi-ws-1']);
  assert.match(t.ui.text(), /Deleted Power BI workspace "Analytics Hub"/);
  for (const key of ['workspaceId', 'createdWorkspace', 'datasetId', 'consumptionDatasetId', 'agentEvaluatorDatasetId']) assert.equal(t.az.powerBi[key], undefined, key);
  assert.equal(t.config.fabric.workspaceId, undefined);
  assert.ok(t.fabric.calls.includes('deleteConnection conn-1'));
  assert.ok(t.arm.calls.includes('deleteResourceGroup rg'));
  assert.deepEqual(t.graph.calls.filter((c) => c.startsWith('deleteApplication')), ['deleteApplication web-obj', 'deleteApplication sql-obj']);

  const kept = await createdAzureInstall({ answers: [false] });
  assert.equal(await runCommand(kept.ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(kept.powerBi.calls, []);
  assert.match(kept.ui.text(), /Left Power BI workspace "Analytics Hub" alone\./);
  assert.equal(kept.az.powerBi.workspaceId, 'pbi-ws-1');
  assert.equal(kept.az.powerBi.createdWorkspace, true);
  assert.ok(kept.arm.calls.includes('deleteResourceGroup rg'), 'everything else still goes');

  const chosen = await createdAzureInstall();
  delete chosen.az.powerBi.createdWorkspace;
  await runCommand(chosen.ctx, 'uninstall', { wait: true });
  assert.deepEqual(chosen.ui.asked, [], 'never offers to delete a workspace the installer didn\'t create');
  assert.deepEqual(chosen.powerBi.calls, []);
  assert.match(chosen.ui.text(), /Left the Power BI workspace you chose alone, because the installer didn't create it\./);
  assert.equal(chosen.az.powerBi.workspaceId, 'pbi-ws-1');

  const gone = await createdAzureInstall();
  gone.powerBi.failures.deleteGroup = [httpError(404)];
  await runCommand(gone.ctx, 'uninstall', { wait: true });
  assert.match(gone.ui.text(), /Power BI workspace "Analytics Hub" was already gone/);
  assert.equal(gone.az.powerBi.workspaceId, undefined);
  assert.equal(gone.config.fabric.workspaceId, undefined);

  const refused = await createdAzureInstall();
  refused.powerBi.failures.deleteGroup = [httpError(500, 'Server error')];
  assert.equal(await runCommand(refused.ctx, 'uninstall', { wait: true }), true);
  assert.match(refused.ui.text(), /Couldn't delete Power BI workspace "Analytics Hub": Server error\. A workspace admin can delete it in Power BI under Workspaces\./);
  assert.equal(refused.az.powerBi.workspaceId, 'pbi-ws-1', 'the record still points at the workspace that is still there');
  assert.equal(refused.config.fabric.workspaceId, 'pbi-ws-1');
  assert.ok(refused.arm.calls.includes('deleteResourceGroup rg'), 'everything else still goes');
});

test('Azure uninstall deletes a workspace only while it has the name the installer gave it', async () => {
  // Before 0.6.8, picking another workspace in Repair or change kept the created flag.
  const picked = await createdAzureInstall();
  picked.az.powerBi.workspaceId = 'theirs';
  picked.config.fabric.workspaceId = 'theirs';
  picked.powerBi.workspaces.push({ id: 'theirs', name: 'Theirs' });
  assert.equal(await runCommand(picked.ctx, 'uninstall', { wait: true }), true);
  assert.deepEqual(picked.ui.asked, [], 'never offers to delete it');
  assert.deepEqual(picked.powerBi.calls, []);
  assert.match(picked.ui.text(), /Left Power BI workspace "Theirs" alone, because the installer created one named "Analytics Hub"\. If you renamed it, delete it in Power BI under Workspaces\./);
  assert.equal(picked.az.powerBi.workspaceId, 'theirs');
  assert.ok(picked.arm.calls.includes('deleteResourceGroup rg'), 'everything else still goes');

  const missing = await createdAzureInstall();
  missing.powerBi.workspaces.length = 0;
  await runCommand(missing.ctx, 'uninstall', { wait: true });
  assert.deepEqual(missing.ui.asked, []);
  assert.deepEqual(missing.powerBi.calls, []);
  assert.match(missing.ui.text(), /Didn't find Power BI workspace "Analytics Hub" among the workspaces you can see, so it's gone or you've lost access to it\./);
  assert.equal(missing.az.powerBi.workspaceId, undefined, 'forgotten, so a new install creates another');
  assert.equal(missing.config.fabric.workspaceId, undefined);

  const unknown = await createdAzureInstall();
  unknown.powerBi.failures.groups = [httpError(500, 'Server error')];
  await runCommand(unknown.ctx, 'uninstall', { wait: true });
  assert.deepEqual(unknown.ui.asked, []);
  assert.deepEqual(unknown.powerBi.calls, []);
  assert.match(unknown.ui.text(), /Couldn't check Power BI workspace "Analytics Hub", so left it alone: Server error\. A workspace admin can delete it in Power BI under Workspaces\./);
  assert.equal(unknown.az.powerBi.workspaceId, 'pbi-ws-1', 'kept, as it may still be there');
});

test('Azure setup only marks a Power BI workspace for uninstall when the installer creates it', async () => {
  /** @param {any[]} answers  the capacity, then the workspace, then a new workspace's name */
  const plan = async (answers) => {
    const powerBi = fakePowerBi();
    /** @type {any} */ (powerBi.api).groups = async () => [{ id: 'pbi-ws-1', name: 'Analytics Hub' }, { id: 'theirs', name: 'Theirs' }];
    const { ctx, config } = fakeCtx({ ui: fakeUi({ answers }).ui, arm: fakeArm().api, fabric: fakeFabric().api, powerBi: powerBi.api });
    config.target = 'azure';
    config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', workspaceName: 'Analytics Hub', powerBi: { workspaceId: 'pbi-ws-1', createdWorkspace: true } };
    await planAzure(ctx, { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }] }, 'powerbi');
    return /** @type {any} */ (config.azure).powerBi;
  };
  assert.equal((await plan(['', 'pbi-ws-1'])).createdWorkspace, true, 'keeping the workspace it created');
  const picked = await plan(['', 'theirs']);
  assert.equal(picked.workspaceId, 'theirs');
  assert.equal(picked.createdWorkspace, undefined, 'one picked from the list is never deleted');
  const fresh = await plan(['', 'new', 'Analytics Hub 2']);
  assert.equal(fresh.workspaceId, undefined);
  assert.equal(fresh.createdWorkspace, undefined, 'set again only once setup creates the new one');
});

test('Azure uninstall waits for the resource group to go, and says it is deleted only once it is', async () => {
  assert.equal((RG_DELETE_POLL_MS * RG_DELETE_POLLS) / 60_000, 45, 'the docs say it waits up to 45 minutes');
  const t = await createdAzureInstall();
  t.arm.groups.rg.deleteStates = ['Deleting', 'Deleting', 'Deleting'];
  assert.equal(await runCommand(t.ctx, 'uninstall', { wait: true }), true);
  const text = t.ui.text();
  const waiting = text.indexOf('Waiting for Azure to delete resource group rg, which can take half an hour.');
  assert.ok(waiting >= 0 && waiting < text.indexOf('Deleted resource group rg'), text);
  assert.deepEqual(t.sleeps, Array(4).fill(RG_DELETE_POLL_MS));
  assert.equal(t.arm.groups.rg, undefined);
  assert.ok(t.graph.calls.includes('deleteApplication web-obj'));

  const lagging = await createdAzureInstall();
  lagging.arm.groups.rg.deleteStates = ['Succeeded', 'Deleting'];
  assert.equal(await runCommand(lagging.ctx, 'uninstall', { wait: true }), true, 'a first read that lags the delete is not a failure');
  assert.match(lagging.ui.text(), /Deleted resource group rg/);

  const slow = await createdAzureInstall();
  slow.arm.groups.rg.deleteStates = Array(RG_DELETE_POLLS + 10).fill('Deleting');
  assert.equal(await runCommand(slow.ctx, 'uninstall', { wait: true }), true);
  assert.equal(slow.sleeps.length, RG_DELETE_POLLS);
  assert.match(slow.ui.text(), /Azure is still deleting resource group rg after 45 minutes\. It carries on without the installer/);
  assert.doesNotMatch(slow.ui.text(), /Deleted resource group rg/);
  assert.ok(slow.graph.calls.includes('deleteApplication sql-obj'), 'app registrations go before the wait');

  const failed = await createdAzureInstall();
  failed.arm.groups.rg.deleteStates = ['Deleting', 'Succeeded'];
  assert.equal(await runCommand(failed.ctx, 'uninstall', { wait: true }), false);
  assert.match(failed.ui.text(), /Azure didn't delete resource group rg: it's Succeeded\. Its activity log in the Azure portal says why\./);
  assert.ok(failed.arm.groups.rg);

  const quick = await createdAzureInstall();
  quick.arm.groups.rg.deleteStates = ['Deleting'];
  assert.equal(await runCommand(quick.ctx, 'uninstall', { wait: false }), true);
  assert.deepEqual(quick.sleeps, []);
  assert.match(quick.ui.text(), /Azure is deleting resource group rg\. That can take half an hour: it's done when the group no longer shows in the Azure portal\./);
  assert.doesNotMatch(quick.ui.text(), /Deleted resource group rg/);
});

test('Azure uninstall copes with a resource group already gone or already being deleted, and stops on a lock', async () => {
  const gone = await createdAzureInstall();
  gone.arm.failures.deleteResourceGroup = [httpError(404)];
  assert.equal(await runCommand(gone.ctx, 'uninstall', { wait: true }), true);
  assert.match(gone.ui.text(), /Resource group rg was already gone/);
  assert.deepEqual(gone.sleeps, []);
  assert.ok(gone.graph.calls.includes('deleteApplication web-obj'));

  const deleting = await createdAzureInstall();
  deleting.arm.failures.deleteResourceGroup = [new HttpError('Conflict', { status: 409, method: 'DELETE', url: 'https://x', body: { error: { code: 'ResourceGroupBeingDeleted' } } })];
  deleting.arm.groups.rg.deleting = true;
  deleting.arm.groups.rg.deleteStates = ['Deleting'];
  assert.equal(await runCommand(deleting.ctx, 'uninstall', { wait: true }), true);
  assert.match(deleting.ui.text(), /Waiting for Azure to delete resource group rg/);
  assert.match(deleting.ui.text(), /Deleted resource group rg/);

  const locked = await createdAzureInstall();
  locked.arm.failures.deleteResourceGroup = [new HttpError('The scope is locked', { status: 409, method: 'DELETE', url: 'https://x', body: { error: { code: 'ScopeLocked' } } })];
  await assert.rejects(runCommand(locked.ctx, 'uninstall', { wait: true }), /The scope is locked/);
  assert.deepEqual(locked.sleeps, []);
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

/** The web app registration's update, with each PATCH body it sends. */
function webAppGraph() {
  /** @type {any[]} */ const patches = [];
  const g = graphApi(/** @type {any} */ ({ patch: async (/** @type {string} */ _p, /** @type {any} */ body) => (patches.push(body), {}) }));
  const o = { fqdn: 'vlens.example.com', clientId: 'client', pbiScopeId: 's-dataset', graphUserReadScopeId: 's-user-read', teamsClientIds: TEAMS_CLIENTS };
  return { patches, update: (/** @type {any} */ app) => g.updateAzureWebApplication(app, o) };
}

test('an upgrade or Repair keeps the web app registration\'s other pre-authorised clients and scopes', async () => {
  const { patches, update } = webAppGraph();
  const [teamsDesktop, teamsWeb] = TEAMS_CLIENTS;
  const other = '11111111-2222-4333-8444-555555555555';
  const extra = { id: 'scope-extra', value: 'Reports.Export', isEnabled: true, type: 'User', adminConsentDisplayName: 'Export reports' };
  // An admin pre-authorised another client, and gave Teams an extra scope as well.
  const app = { id: 'web-obj', appRoles: [{ id: 'role-user' }], api: {
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: [{ id: 'scope-access', value: 'access_as_user', isEnabled: true, type: 'User' }, extra],
    preAuthorizedApplications: [
      { appId: other, delegatedPermissionIds: ['scope-extra', 'scope-access'] },
      { appId: teamsDesktop, delegatedPermissionIds: ['scope-access', 'scope-extra'] },
    ],
  } };

  await update(app);
  const { api } = patches[0];
  assert.equal(api.requestedAccessTokenVersion, 2);
  assert.deepEqual(api.oauth2PermissionScopes.map((/** @type {any} */ s) => s.value), ['access_as_user', 'Reports.Export']);
  assert.deepEqual(api.oauth2PermissionScopes[1], extra);
  assert.deepEqual(api.preAuthorizedApplications.slice(0, 3), [
    { appId: other, delegatedPermissionIds: ['scope-extra', 'scope-access'] },
    { appId: teamsDesktop, delegatedPermissionIds: ['scope-access', 'scope-extra'] },
    { appId: teamsWeb, delegatedPermissionIds: ['scope-access'] },
  ]);
  const clients = api.preAuthorizedApplications.map((/** @type {any} */ c) => c.appId);
  assert.deepEqual(clients, [other, ...TEAMS_CLIENTS], 'each client once, the host clients added after what was there');
  for (const c of api.preAuthorizedApplications) assert.equal(new Set(c.delegatedPermissionIds).size, c.delegatedPermissionIds.length, `${c.appId} lists each permission once`);

  // The next run writes back what is there.
  await update({ ...app, api });
  assert.deepEqual(patches[1].api, api);
});

test('the web app registration gets its access_as_user scope and host clients when it has none', async () => {
  const { patches, update } = webAppGraph();
  await update({ id: 'web-obj' });
  const [scope] = patches[0].api.oauth2PermissionScopes;
  assert.equal(scope.value, 'access_as_user');
  assert.deepEqual(patches[0].api.preAuthorizedApplications, TEAMS_CLIENTS.map((appId) => ({ appId, delegatedPermissionIds: [scope.id] })));
});

test('pre-authorisation lists each client and permission once, and only permissions the app still has', () => {
  const merged = mergePreAuthorizedApplications([
    { appId: 'client-a', delegatedPermissionIds: ['scope-extra', 'scope-extra', 'scope-gone'] },
    { appId: 'CLIENT-A', delegatedPermissionIds: ['scope-access'] },
    { appId: 'client-b', delegatedPermissionIds: ['scope-gone'] },
    { appId: 'client-c', delegatedPermissionIds: [] },
  ], ['client-a', 'client-d', 'client-d'], 'scope-access', [{ id: 'scope-access' }, { id: 'scope-extra' }]);
  assert.deepEqual(merged, [
    { appId: 'client-a', delegatedPermissionIds: ['scope-extra', 'scope-access'] },
    { appId: 'client-d', delegatedPermissionIds: ['scope-access'] },
  ]);
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

test('semantic model updates keep data unless the caller allows Fabric to purge it', async () => {
  /** @type {any[]} */ const sent = [];
  const f = fabricApi(/** @type {any} */ ({ requestLro: async (/** @type {string} */ m, /** @type {string} */ p, /** @type {any} */ o) => (sent.push({ m, p, body: o.body }), null) }));
  const definition = { parts: [{ path: 'model.bim', payload: 'e30=', payloadType: 'InlineBase64' }] };
  await f.updateSemanticModel('ws', 'sm', definition);
  await f.updateSemanticModel('ws', 'sm', definition, { allowPurgeData: false });
  await f.updateSemanticModel('ws', 'sm', definition, { allowPurgeData: true });
  const p = '/workspaces/ws/semanticModels/sm/updateDefinition';
  assert.deepEqual(sent, [
    { m: 'POST', p, body: { definition } },
    { m: 'POST', p, body: { definition } },
    { m: 'POST', p, body: { definition, options: { allowPurgeData: true } } },
  ]);
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

test('the web app registration asks for Graph User.ReadBasic.All with the viewer group, and only then', async () => {
  /** @type {any[]} */ const bodies = [];
  const g = graphApi(/** @type {any} */ ({
    post: async (/** @type {string} */ _p, /** @type {any} */ body) => (bodies.push(body), { id: 'web-obj', appId: 'client' }),
    patch: async (/** @type {string} */ _p, /** @type {any} */ body) => (bodies.push(body), {}),
  }));
  const o = { fqdn: 'vlens.example.com', clientId: 'client', pbiScopeId: 's-dataset', graphUserReadScopeId: 's-user-read', teamsClientIds: TEAMS_CLIENTS };
  const viewers = { ...o, graphGroupScopeId: 's-group-members', graphPeopleScopeId: 's-user-read-basic', groupClaims: true };
  await g.createAzureWebApplication({ displayName: WEB_APP_NAME, ...viewers });
  await g.updateAzureWebApplication({ id: 'web-obj' }, viewers);
  await g.createAzureWebApplication({ displayName: WEB_APP_NAME, ...o });
  await g.updateAzureWebApplication({ id: 'web-obj' }, o);
  const graphScopes = (/** @type {any} */ body) => body.requiredResourceAccess.find((/** @type {any} */ r) => r.resourceAppId === GRAPH_APP_ID).resourceAccess.map((/** @type {any} */ a) => `${a.type} ${a.id}`);
  const withViewers = ['Scope s-user-read', 'Scope s-group-members', 'Scope s-user-read-basic'];
  assert.deepEqual(bodies.map(graphScopes), [withViewers, withViewers, ['Scope s-user-read'], ['Scope s-user-read']]);
});

/** Delegated grants as Graph keeps them, behind the installer's own grantOauth2Permission. */
function grantStore() {
  /** @type {{ id: string, clientId: string, resourceId: string, consentType: string, scope: string }[]} */
  const grants = [];
  /** @type {string[]} */
  const calls = [];
  const { grantOauth2Permission } = graphApi(/** @type {any} */ ({
    list: async (/** @type {string} */ _p, /** @type {any} */ o) => {
      const [, clientId, resourceId] = /clientId eq '([^']*)' and resourceId eq '([^']*)'/.exec(o.query.$filter) ?? [];
      return grants.filter((g) => g.clientId === clientId && g.resourceId === resourceId);
    },
    post: async (/** @type {string} */ _p, /** @type {any} */ body) => {
      calls.push(`post ${body.resourceId} ${body.scope}`);
      const grant = { id: `grant-${grants.length + 1}`, ...body };
      grants.push(grant);
      return grant;
    },
    patch: async (/** @type {string} */ p, /** @type {any} */ body) => {
      calls.push(`patch ${p} ${body.scope}`);
      const grant = grants.find((g) => p === `/oauth2PermissionGrants/${g.id}`);
      if (grant) grant.scope = body.scope;
      return {};
    },
  }));
  /** The delegated scopes granted on a resource's service principal. @param {string} resourceId */
  const scope = (resourceId) => grants.find((g) => g.resourceId === resourceId)?.scope;
  return { grants, calls, grantOauth2Permission, scope };
}

/**
 * An Azure install against fakes, recording the options the web app's registration is created and updated with,
 * and its delegated grants.
 * @param {{ viewers: boolean }} o
 */
async function webAppInstall(o) {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
  });
  if (o.viewers) {
    config.access = /** @type {any} */ ({ ...config.access, groupId: 'group-1', groupName: 'Analytics Hub Viewers' });
    Object.assign(graph.api, { getGroup: async (/** @type {string} */ id) => ({ id, displayName: 'Analytics Hub Viewers' }) });
    Object.assign(powerBi.api, { datasetUsers: async () => [], addDatasetUser: async () => null });
  }
  /** @type {any[]} */
  const registrations = [];
  const store = grantStore();
  const { createAzureWebApplication: create, updateAzureWebApplication: update } = graph.api;
  Object.assign(graph.api, {
    createAzureWebApplication: async (/** @type {any} */ body) => (registrations.push(body), create(body)),
    updateAzureWebApplication: async (/** @type {any} */ app, /** @type {any} */ body) => (registrations.push(body), update(app, body)),
    grantOauth2Permission: store.grantOauth2Permission,
  });
  ctx.runFirstLoad = false;
  assert.equal(await installAzure(ctx, { wait: true }), true);
  return { ctx, ui, registrations, store };
}

test('Azure with the viewer group: the web app gets Graph User.ReadBasic.All, so Share finds people by email and shows their names', async () => {
  const t = await webAppInstall({ viewers: true });
  assert.equal(t.registrations.length, 2, 'created, then brought up to date');
  for (const r of t.registrations) assert.deepEqual([r.graphGroupScopeId, r.graphPeopleScopeId], ['s-group-members', 's-user-read-basic'], 'basic profiles only, not User.Read.All');
  assert.equal(t.store.scope('graph-sp'), 'User.Read GroupMember.ReadWrite.All User.ReadBasic.All');
  assert.equal(t.store.scope('pbi-sp'), 'Dataset.Read.All');
  assert.doesNotMatch(t.ui.text(), /Couldn't grant delegated admin consent/);
  const row = azurePlanReview(t.ctx).grants.find((g) => g.who === WEB_APP_NAME);
  assert.match(row?.what ?? '', /Graph User\.Read, GroupMember\.ReadWrite\.All, User\.ReadBasic\.All;/);
  assert.match(row?.detail ?? '', /User\.ReadBasic\.All lets Share find people by email and show their names/);
});

test("Azure without the viewer group: the web app's Graph permissions are as they were", async () => {
  const t = await webAppInstall({ viewers: false });
  for (const r of t.registrations) assert.deepEqual([r.graphGroupScopeId, r.graphPeopleScopeId], [undefined, undefined]);
  assert.equal(t.store.scope('graph-sp'), 'User.Read');
  const row = azurePlanReview(t.ctx).grants.find((g) => g.who === WEB_APP_NAME);
  assert.doesNotMatch(`${row?.what} ${row?.detail ?? ''}`, /GroupMember|User\.ReadBasic/);
});

test('Azure Update or Repair adds User.ReadBasic.All to the grant an older install has, with no extra step', async () => {
  const t = await webAppInstall({ viewers: true });
  const grant = t.store.grants.find((g) => g.resourceId === 'graph-sp');
  assert.ok(grant);
  // As 0.6.7 left it.
  grant.scope = 'User.Read GroupMember.ReadWrite.All';
  t.store.calls.length = 0;
  t.registrations.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.store.calls, [`patch /oauth2PermissionGrants/${grant.id} User.Read GroupMember.ReadWrite.All User.ReadBasic.All`]);
  assert.deepEqual(t.registrations.map((r) => r.graphPeopleScopeId), ['s-user-read-basic'], 'its registration asks for it too');
});

test('askTarget: the Azure choice says what it runs, in plain words', async () => {
  const t = fakeUi();
  /** @type {any[]} */
  let seen = [];
  const ui = /** @type {any} */ ({ ...t.ui, select: async (/** @type {string} */ _m, /** @type {any[]} */ choices, /** @type {any} */ def) => ((seen = choices), def) });
  const { ctx, config } = fakeCtx({ ui });
  delete config.fabric.workspaceId;
  delete config.target;
  await askTarget(ctx);
  const azure = seen.find((c) => c.value === 'azure');
  assert.equal(azure.description, AZURE_TARGET_DESCRIPTION);
  assert.match(azure.description, /scheduled jobs in Azure Container Apps/);
  assert.doesNotMatch(azure.description, /PaaS/);
});
test('Azure SQL free offer turned down: the new database is created at the usual price instead', async () => {
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
  ctx.runFirstLoad = false;
  const deploy = /** @type {(...a: any[]) => Promise<any>} */ (arm.api.deployTemplate);
  /** @type {boolean[]} */
  const freeAsked = [];
  let failures = 1;
  arm.api.deployTemplate = async (/** @type {any[]} */ ...args) => {
    freeAsked.push(args[3].properties.parameters.sqlUseFreeLimit.value);
    if (failures-- > 0) {
      throw Object.assign(new Error('ARM deployment valuelens failed: InternalServerError on Microsoft.Sql/servers/databases vlens-sql/valuelens: An unexpected error occured while processing the request.'), {
        body: { error: { code: 'DeploymentFailed' } },
        operations: [{ resourceType: 'Microsoft.Sql/servers/databases', resourceName: 'vlens-sql/valuelens', code: 'InternalServerError', message: 'An unexpected error occured while processing the request.' }],
      });
    }
    return deploy(...args);
  };

  await installAzure(ctx, { wait: true });
  assert.deepEqual(freeAsked, [true, false, false], 'retried once without the free offer, and the second pass keeps it off');
  assert.equal(config.azure?.sqlFreeOffer, false, 'remembered, so Repair or change does not ask again');
  assert.match(ui.text(), /Azure turned down the Azure SQL free offer for a new database \(InternalServerError\)/);
});

test('sqlFreeOfferTurnedDown: only for a new database that asked for the free offer', async () => {
  const dbFailed = { operations: [{ resourceType: 'Microsoft.Sql/servers/databases', resourceName: 'vlens-sql/valuelens', code: 'InternalServerError' }] };
  const ctxWith = (/** @type {any} */ azure, /** @type {any} */ db = null) => /** @type {any} */ ({
    config: { azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', ...azure } },
    api: { arm: { getSqlDatabase: async () => db } },
  });
  assert.equal(await sqlFreeOfferTurnedDown(ctxWith({}), dbFailed), 'InternalServerError');
  assert.equal(await sqlFreeOfferTurnedDown(ctxWith({}, { properties: { useFreeLimit: true } }), dbFailed), undefined, 'an existing database is never moved off the free offer');
  assert.equal(await sqlFreeOfferTurnedDown(ctxWith({ sqlFreeOffer: false }), dbFailed), undefined, 'already without the free offer');
  assert.equal(await sqlFreeOfferTurnedDown(ctxWith({}), { operations: [{ resourceType: 'Microsoft.Web/sites', resourceName: 'web', code: 'Conflict' }] }), undefined, 'another resource failed');
  assert.equal(await sqlFreeOfferTurnedDown(ctxWith({}), new Error('BadRequest')), undefined, 'no failed operations');
});

test('Azure install publishes the Teams app to the org catalog once, Repair leaves it, and uninstall removes it', async () => {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  graph.directoryRoles.push({ roleTemplateId: '69091246-20e8-4a56-aa4d-066075b2a7a8', displayName: 'Teams Administrator' });
  const catalog = fakeAppCatalog();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui, appCatalog: catalog.api });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
  });
  ctx.runFirstLoad = false;

  await installAzure(ctx, { wait: true });
  const az = /** @type {any} */ (config.azure);
  const clientId = az.webApp.clientId;
  const version = manifestVersion(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(catalog.calls, ['signIn', `find ${clientId}`, `publish ${clientId} ${version}`], 'the package written to disk is the one published');
  const manifest = readManifest(readFileSync(az.teamsPackage));
  assert.equal(manifest.id, clientId);
  assert.equal(manifest.version, version);
  assert.deepEqual({ ...az.teamsApp, sha256: undefined, publishedAt: undefined }, { id: 'catalog-app-1', externalId: clientId, version, sha256: undefined, publishedAt: undefined });
  assert.ok(!(az.status?.pendingAdminActions ?? []).some((/** @type {string} */ a) => a.startsWith('Publish the Teams app')));
  const out = ui.text();
  assert.ok(out.indexOf('Signed in to publish the Teams app') < out.indexOf('Wrote Teams package'), 'the sign-in comes before the deployment, not at the end');
  assert.match(out, /Teams app: published Analytics Hub \S+ to your org's app catalog/);
  assert.match(out, /Teams: +Analytics Hub \S+ in your org's app catalog, for Teams, Outlook and the Microsoft 365 Copilot app\./);

  // Repair or change, as a new run: the same package, so no sign-in and nothing uploaded.
  delete ctx.teamsCatalog;
  catalog.calls.length = 0;
  await installAzure(ctx, { wait: true });
  assert.deepEqual(catalog.calls, []);
  assert.equal(catalog.apps.length, 1);

  delete ctx.teamsCatalog;
  az.createdResourceGroup = true;
  await runCommand(ctx, 'uninstall', { wait: true });
  assert.deepEqual(catalog.calls, ['signIn', 'remove catalog-app-1']);
  assert.equal(catalog.apps.length, 0);
  assert.equal(az.teamsApp, undefined);
  assert.ok(arm.calls.includes('deleteResourceGroup rg'));
});

/**
 * A new Azure install by a Teams Administrator, with the org's app catalog to publish to.
 * @param {{ answers?: any[] }} [o]  Scripted answers for the UI.
 */
function teamsCatalogInstall(o = {}) {
  const arm = fakeArm();
  const graph = fakeAzureGraph();
  graph.directoryRoles.push({ roleTemplateId: '69091246-20e8-4a56-aa4d-066075b2a7a8', displayName: 'Teams Administrator' });
  const catalog = fakeAppCatalog();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: 'vlens-sql.database.windows.net', database: 'valuelens' } }]);
  const ui = fakeUi({ answers: o.answers });
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui, appCatalog: catalog.api });
  Object.assign(config, {
    target: 'azure',
    azure: { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' },
  });
  ctx.runFirstLoad = false;
  return { ctx, arm, catalog, ui, az: () => /** @type {any} */ (config.azure) };
}

/** The Teams app's pending admin actions. @param {any} az @returns {string[]} */
const teamsPending = (az) => (az.status?.pendingAdminActions ?? []).filter((/** @type {string} */ a) => a.startsWith('Publish the Teams app'));

test('Azure install: a catalog sign-in nobody finishes holds it up for 5 minutes at most, then it carries on and leaves the steps to upload the app', async (t) => {
  const s = teamsCatalogInstall();
  /** @type {AbortSignal | undefined} */
  let signal;
  // A browser sign-in left open: its listener ignores the signal and waits for ever.
  s.catalog.api.signIn = async (o) => {
    s.catalog.calls.push('signIn');
    signal = o?.abortSignal;
    await new Promise(() => {});
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const installing = installAzure(s.ctx, { wait: true });
  for (let i = 0; !signal && i < 1000; i++) await new Promise((r) => setImmediate(r));
  assert.ok(signal, 'signing in');
  t.mock.timers.tick(CATALOG_SIGN_IN_MS - 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(signal?.aborted, false, 'still waiting just before the time is up');
  assert.equal(s.arm.calls.length, 0, 'nothing is created in Azure while the sign-in waits');
  t.mock.timers.tick(1);
  // The rest of the install waits on real timers.
  t.mock.timers.reset();
  assert.equal(signal?.aborted, true, 'given up on');
  assert.equal(await installing, true, 'the install finishes');
  assert.ok(s.arm.calls.includes('ensureResourceGroup rg'));
  assert.deepEqual(s.catalog.calls, ['signIn'], 'no second sign-in at the end');
  const az = s.az();
  assert.equal(az.teamsApp, undefined);
  assert.ok(readFileSync(az.teamsPackage).length > 0, 'the package is there to upload by hand');
  const upload = `upload ${az.teamsPackage} in Teams admin center > Teams apps > Manage apps (https://admin.teams.microsoft.com/policies/manage-apps).`;
  assert.deepEqual(teamsPending(az), [`Publish the Teams app: ${upload}`]);
  const out = s.ui.text();
  assert.match(out, /The installer can't publish the Teams app\. The sign-in to Microsoft Graph Command Line Tools wasn't finished within 5 minutes\. The install carries on/);
  assert.match(out, /Teams app: not published to your org's app catalog\. The sign-in to Microsoft Graph Command Line Tools wasn't finished within 5 minutes\./);
  assert.ok(out.includes(`Teams:      Not published yet. A Teams Administrator needs to ${upload}`), 'in the summary');
  await azureStatus(s.ctx);
  assert.ok(s.ui.text().includes(`Pending admin action: Publish the Teams app: ${upload}`), 'and in status');
});

test('Azure plan: the admin can go ahead without publishing the Teams app, and the install leaves the steps to upload it', async () => {
  const s = teamsCatalogInstall({ answers: [false, true] });
  /** @type {any[]} */
  const plans = [];
  const review = s.ui.ui.review;
  s.ui.ui.review = (plan) => {
    plans.push(plan);
    review(plan);
  };
  assert.equal(await confirmAzurePlan(s.ctx), true, 'going ahead');
  assert.deepEqual(s.ui.asked, ['Publish the Teams app to your org\'s app catalog? It takes one more sign-in. If you say no, the installer prints the steps to upload it by hand.', 'Go ahead?']);
  const row = plans[0].creates.find((/** @type {any} */ r) => r.kind === 'Teams app');
  assert.equal(row?.detail, 'Not published by the installer. You chose to upload it by hand. The installer prints the steps for a Teams Administrator to upload it.');

  assert.equal(await installAzure(s.ctx, { wait: true }), true);
  assert.deepEqual(s.catalog.calls, [], 'no sign-in for it');
  const az = s.az();
  assert.equal(az.teamsApp, undefined);
  assert.equal(teamsPending(az).length, 1);
  const out = s.ui.text();
  assert.doesNotMatch(out, /Signing in once more/);
  assert.match(out, /Teams app: not published to your org's app catalog\. You chose to upload it by hand\./);
  assert.match(out, /Teams: +Not published yet\. A Teams Administrator needs to upload /);
});

test("Azure install: a Teams app the installer can't publish only warns, so the install still ends set up", async () => {
  const refused = teamsCatalogInstall();
  refused.catalog.failures.publish = [new HttpError('POST /v1.0/appCatalogs/teamsApps returned 403', { status: 403, method: 'POST', url: 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps' })];
  const consent = teamsCatalogInstall();
  consent.catalog.failures.signIn = [new Error('AADSTS90094: Admin consent is required for the permissions requested by this application.')];
  for (const [label, s, reason] of /** @type {const} */ ([
    ['Graph refuses the upload', refused, /! Teams app: not published to your org's app catalog\. Microsoft Graph refused it \(403\)\./],
    ['the sign-in needs admin consent', consent, /! Teams app: not published to your org's app catalog\. The app catalog permission, .*, needs admin consent\./],
  ])) {
    assert.equal(await installAzure(s.ctx, { wait: true }), true, `${label}: set up, so the installer exits 0`);
    assert.equal(teamsPending(s.az()).length, 1, `${label}: the upload steps are a pending admin action`);
    const out = s.ui.text();
    assert.match(out, reason, label);
    assert.doesNotMatch(out, /✗/, label);
    assert.match(out, /Analytics Hub is set up/, label);
    assert.doesNotMatch(out, /not finished/, label);
    assert.match(out, /Teams: +Not published yet\. A Teams Administrator needs to upload /, label);
  }
});