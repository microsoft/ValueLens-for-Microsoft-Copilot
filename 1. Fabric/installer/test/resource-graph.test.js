// @ts-check
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultModules, NOTEBOOKS_DIR, notebooksFor } from '../src/catalog.js';
import { applyDataFlags, parseCli } from '../src/cli.js';
import { armApi, ROLES } from '../src/clients/azure.js';
import { emptyConfig, normaliseResourceGraph } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { LOAD_LABELS, statusConfigJson } from '../src/loads.js';
import { argParameters, armParameterNames, azureDeployment, installAzure, parseDropFolder, REQUIRED_ARM_PARAMETERS } from '../src/steps/azure/index.js';
import { notebookSettings } from '../src/steps/fabric.js';
import { flowDefinitions, flowsWanted } from '../src/steps/flows.js';
import { ensureAppResourceGraphAccess, managementGroupId, resourceGraphGrants, resourceGraphScope } from '../src/steps/resource-graph.js';
import { AGENT_INVENTORY_DIR, AGENT_INVENTORY_FLOW_NAME, CONNECTORS, connectorsUsed, PPAPI } from '../src/transform/flows.js';
import { buildConsumptionModel, buildModel, loadTemplateModel } from '../src/transform/model.js';
import { buildPipeline, findActivity, LANE_ORDER, REFRESH_ACTIVITY, RESOURCE_GRAPH_ACTIVITY } from '../src/transform/pipeline.js';
import { AGENT_CONFIG_TABLE, ARG_TABLES, ENVIRONMENTS_TABLE, FOUNDRY_TABLE } from '../src/transform/resource-graph.js';
import { DATA_SOURCES, dataSource, defaultDataSources, normaliseDataSources, parseDataFlags, routedSources, routerWanted, UPLOADABLE_SOURCES } from '../src/uploads.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';

const MG_ROOT = '/providers/Microsoft.Management/managementGroups/tenant-1';

/** @param {import('../src/config.js').InstallConfig} config */
const turnOn = (config) => {
  config.dataSources.resourceGraph = 'api';
  return config;
};

test('data source: Resource Graph is off by default, API or skip only, and never routed as a CSV', () => {
  const s = dataSource('resourceGraph');
  assert.deepEqual(s.modes, ['api', 'skip']);
  assert.equal(s.page, 'Governance');
  assert.equal(defaultDataSources().resourceGraph, 'skip');
  assert.ok(!UPLOADABLE_SOURCES.includes('resourceGraph'));
  const ds = { ...defaultDataSources(), resourceGraph: /** @type {const} */ ('api') };
  assert.ok(!routedSources(ds).includes('resourceGraph'));
  assert.equal(routerWanted({ ...ds, ...Object.fromEntries(UPLOADABLE_SOURCES.map((id) => [id, 'skip'])) }), false);
  assert.equal(normaliseDataSources({ resourceGraph: 'api' }, defaultModules()).resourceGraph, 'api');
  assert.equal(normaliseDataSources({}, defaultModules()).resourceGraph, 'skip', 'saved installs from before keep it off');
  assert.deepEqual(parseDataFlags(['resourceGraph=api']), { resourceGraph: 'api' });
  assert.throws(() => parseDataFlags(['resourceGraph=csv']));
  assert.ok(DATA_SOURCES.some((d) => d.id === 'resourceGraph'));
});

test('config: Resource Graph reads agents and Foundry across the tenant unless told otherwise', () => {
  assert.deepEqual(normaliseResourceGraph(undefined), { managementGroup: '', agents: true, foundry: true });
  assert.deepEqual(normaliseResourceGraph(/** @type {any} */ ({ managementGroup: ' mg-1 ', foundry: false, access: true })), { managementGroup: 'mg-1', agents: true, foundry: false, access: true });
  assert.deepEqual(emptyConfig().resourceGraph, { managementGroup: '', agents: true, foundry: true });
  assert.equal(managementGroupId('/providers/Microsoft.Management/managementGroups/mg-1/'), 'mg-1');
});

test('CLI: --data resourceGraph=api with a management group and what to leave out', () => {
  const args = parseCli(['--data', 'resourceGraph=api', '--arg-management-group', '/providers/Microsoft.Management/managementGroups/mg-1', '--no-arg-foundry']);
  assert.equal(args.argManagementGroup, 'mg-1');
  assert.equal(args.argAgents, undefined);
  assert.equal(args.argFoundry, false);
  const config = emptyConfig();
  /** @type {any} */ (config.resourceGraph).access = true;
  applyDataFlags(config, args);
  assert.equal(config.dataSources.resourceGraph, 'api');
  assert.deepEqual(config.resourceGraph, { managementGroup: 'mg-1', agents: true, foundry: false }, 'a new group needs Reader again');
  assert.throws(() => parseCli(['--arg-management-group', 'bad group!']), /--arg-management-group should be a management group ID/);
  assert.throws(() => parseCli(['--no-arg-agents', '--no-arg-foundry']), /nothing to read/);
  assert.throws(() => parseCli(['run', '--arg-management-group', 'mg-1']), /install/);
});

test('catalog and notebook: deployed only when on, with the management group and what to read', () => {
  const modules = defaultModules();
  assert.ok(!notebooksFor(modules, { dataSources: defaultDataSources() }).some((n) => n.key === 'resourceGraph'));
  const nb = notebooksFor(modules, { dataSources: { ...defaultDataSources(), resourceGraph: 'api' } }).find((n) => n.key === 'resourceGraph');
  assert.equal(nb?.file, 'Copilot_Resource_Graph_Ingester.ipynb');
  assert.equal(nb?.credentials, true);
  assert.ok(existsSync(join(import.meta.dirname, '..', '..', NOTEBOOKS_DIR, nb.file)), 'the notebook ships');

  const { ctx, config } = fakeCtx();
  turnOn(config);
  config.resourceGraph = { managementGroup: 'mg-1', agents: true, foundry: false };
  const s = notebookSettings(ctx, nb);
  assert.deepEqual(s.values, { MANAGEMENT_GROUP: 'mg-1' });
  assert.deepEqual(s.expressions, { INCLUDE_AGENTS: 'True', INCLUDE_FOUNDRY: 'False' });
  assert.equal(s.clientId, 'app-1');
  assert.equal(s.tenantId, 'tenant-1');
});

test('pipeline: the Resource Graph step runs in lane 2 after Agent 365, and the model refresh waits for it', () => {
  const sources = realSources();
  const ids = { auditIngester: 'nb-a', licensedUsers: 'nb-b', processor: 'nb-c', orgData: 'nb-d', refreshModel: 'nb-r', resourceGraph: 'nb-rg' };
  const modules = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false };
  const doc = buildPipeline(sources.pipeline, { workspaceId: 'ws', notebookIds: ids, modules, semanticModelId: 'model-1', resourceGraph: true });
  const step = findActivity(doc.properties.activities, RESOURCE_GRAPH_ACTIVITY);
  assert.equal(step.typeProperties.notebookId, 'nb-rg');
  assert.deepEqual(step.dependsOn, [{ activity: 'Run_Licensed_Users_Ingester', dependencyConditions: ['Completed'] }]);
  assert.deepEqual(findActivity(doc.properties.activities, 'Conditionally_Run_Org_Data').dependsOn, [{ activity: RESOURCE_GRAPH_ACTIVITY, dependencyConditions: ['Completed'] }]);
  assert.ok(LANE_ORDER.indexOf(RESOURCE_GRAPH_ACTIVITY) > LANE_ORDER.indexOf('Conditionally_Run_Agent365'));
  assert.ok(findActivity(doc.properties.activities, REFRESH_ACTIVITY).dependsOn.some((/** @type {any} */ d) => d.activity === RESOURCE_GRAPH_ACTIVITY));

  const without = buildPipeline(sources.pipeline, { workspaceId: 'ws', notebookIds: ids, modules, semanticModelId: 'model-1' });
  assert.equal(findActivity(without.properties.activities, RESOURCE_GRAPH_ACTIVITY), undefined);
  assert.throws(() => buildPipeline(sources.pipeline, { workspaceId: 'ws', notebookIds: { ...ids, resourceGraph: undefined }, modules, resourceGraph: true }), /Resource Graph Ingester/);

  assert.match(LOAD_LABELS[RESOURCE_GRAPH_ACTIVITY], /Resource Graph/);
  assert.ok(statusConfigJson().includes(RESOURCE_GRAPH_ACTIVITY), 'load status names it in plain words');
});

test('Fabric access: Reader for the app on the tenant root group, or the chosen one; a refusal is reported, not fatal', async () => {
  const arm = fakeArm();
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, ui: ui.ui });
  turnOn(config);
  assert.equal(await ensureAppResourceGraphAccess(ctx), true);
  assert.ok(arm.calls.includes(`assignRole ${MG_ROOT} ${ROLES.reader} sp-1 ServicePrincipal`));
  assert.equal(config.resourceGraph?.access, true);
  assert.match(ui.text(), /Global Reader, Power Platform Administrator or AI Administrator/, 'the Entra role is described, not assigned');

  arm.calls.length = 0;
  assert.equal(await ensureAppResourceGraphAccess(ctx), true);
  assert.ok(!arm.calls.length, 'a repair keeps the role');

  const denied = fakeArm();
  denied.failures.assignRole = [new HttpError('403 Forbidden', { method: 'PUT', url: 'x', status: 403 })];
  const dui = fakeUi({ yes: true });
  const d = fakeCtx({ arm: denied.api, ui: dui.ui });
  turnOn(d.config);
  d.config.resourceGraph = { managementGroup: 'mg-1', agents: true, foundry: true };
  assert.equal(await ensureAppResourceGraphAccess(d.ctx), false);
  assert.ok(denied.calls.includes(`assignRole /providers/Microsoft.Management/managementGroups/mg-1 ${ROLES.reader} sp-1 ServicePrincipal`));
  assert.match(dui.text(), /az role assignment create --assignee app-1 --role Reader --scope \/providers\/Microsoft\.Management\/managementGroups\/mg-1/);
  assert.equal(d.config.resourceGraph?.access, undefined);

  const told = fakeArm();
  told.failures.assignRole = [new HttpError('403 Forbidden', { method: 'PUT', url: 'x', status: 403 })];
  const t = fakeCtx({ arm: told.api, ui: fakeUi({ answers: [true] }).ui });
  turnOn(t.config);
  assert.equal(await ensureAppResourceGraphAccess(t.ctx), true, '"It already has access"');
  assert.equal(t.config.resourceGraph?.access, true);

  const off = fakeArm();
  const o = fakeCtx({ arm: off.api });
  turnOn(o.config).resourceGraph = { managementGroup: '', agents: true, foundry: false };
  await ensureAppResourceGraphAccess(o.ctx);
  assert.ok(!off.calls.length, 'no Reader without Foundry');
  assert.deepEqual(resourceGraphGrants(o.config, 'tenant-1', 'App', 'access').map((g) => g.what), ['One of Global Reader, Power Platform Administrator, AI Administrator (Entra)']);
  assert.equal(resourceGraphGrants(emptyConfig(), 'tenant-1', 'App', 'access').length, 0);
  assert.equal(resourceGraphScope(emptyConfig(), 'tenant-1'), MG_ROOT);
});

test('ARM: a role at a management group is defined at that group', async () => {
  /** @type {any[]} */
  const puts = [];
  const arm = armApi(/** @type {any} */ ({ put: async (/** @type {string} */ path, /** @type {any} */ body) => puts.push([path, body]) }));
  await arm.assignRole(MG_ROOT, ROLES.reader, 'sp-1', 'ServicePrincipal');
  assert.match(puts[0][0], /^\/providers\/Microsoft\.Management\/managementGroups\/tenant-1\/providers\/Microsoft\.Authorization\/roleAssignments\//);
  assert.equal(puts[0][1].properties.roleDefinitionId, `${MG_ROOT}/providers/Microsoft.Authorization/roleDefinitions/${ROLES.reader}`);
  await arm.assignRole('/subscriptions/s/resourceGroups/rg', ROLES.reader, 'sp-1', 'ServicePrincipal');
  assert.equal(puts[1][1].properties.roleDefinitionId, `/subscriptions/s/providers/Microsoft.Authorization/roleDefinitions/${ROLES.reader}`);
});

test('agent inventory flow: pages the Power Platform inventory as the signed-in owner and saves one JSON file', () => {
  const { config } = fakeCtx();
  config.uploads.flowEnvironment = { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' };
  assert.ok(!flowsWanted(config).includes('agents'));
  turnOn(config);
  assert.ok(flowsWanted(config).includes('agents'));
  config.resourceGraph = { managementGroup: '', agents: false, foundry: true };
  assert.ok(!flowsWanted(config).includes('agents'), 'not without agents');
  config.resourceGraph.agents = true;

  const f = flowDefinitions(config, 'tenant-1').agents;
  assert.equal(f.name, AGENT_INVENTORY_FLOW_NAME);
  assert.match(f.description, /delegated sign-ins only/);
  const d = f.definition;
  assert.deepEqual(d.triggers.Daily.recurrence.schedule, { hours: [(Number(config.schedule.time.split(':')[0]) + 23) % 24], minutes: [Number(config.schedule.time.split(':')[1])] });
  assert.equal(d.actions.Each_page.type, 'Until');
  assert.equal(d.actions.Each_page.limit.count, 100);
  const get = d.actions.Each_page.actions.Get_inventory.inputs;
  assert.equal(get.host.connectionName, CONNECTORS.entra.name);
  assert.equal(get.parameters['request/method'], 'POST');
  assert.equal(get.parameters['request/url'], `${PPAPI}/resourcequery/resources/query?api-version=2024-10-01`);
  assert.deepEqual(get.parameters['request/body'], {
    TableName: 'PowerPlatformResources',
    Clauses: [{ $type: 'where', FieldName: 'type', Operator: 'in~', Values: ["'microsoft.copilotstudio/agents'", "'microsoft.powerplatform/environments'", "'microsoft.powerautomate/agentflows'"] }],
    Options: { Top: 1000, Skip: 0, SkipToken: "@{variables('SkipToken')}" },
  });
  const next = d.actions.Each_page.actions.Next_page.inputs.value;
  for (const k of ['skipToken', '$skipToken', 'SkipToken']) assert.ok(next.includes(`?['${k}']`), k);

  const text = JSON.stringify(d);
  assert.ok(text.includes(`/${AGENT_INVENTORY_DIR}/`), 'Fabric: Files/arg_inventory in the Lakehouse');
  assert.match(text, /onelake/);
  assert.match(text, /_agent_inventory\.json/);
  assert.match(text, /"Content-Type":"application\/json"/);
  assert.deepEqual(connectorsUsed(d), [CONNECTORS.entra.name, CONNECTORS.storage.name].sort());
  assert.doesNotMatch(JSON.stringify(flowDefinitions(config, 'tenant-1').studio.definition), /application\/json/, 'the CSV flows are unchanged');
});

test('agent inventory flow on Azure: the landing container, or the SharePoint drop folder; none when unreachable', () => {
  const { config } = fakeCtx();
  turnOn(config);
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'i', tags: {}, deployments: [], outputs: { storageAccountName: 'vlensst' }, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true };
  config.uploads.flowEnvironment = { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' };
  assert.deepEqual(flowsWanted(config), ['agents']);
  const pub = flowDefinitions(config, 'tenant-1').agents;
  assert.match(JSON.stringify(pub.definition), /https:\/\/vlensst\.dfs\.core\.windows\.net\/landing\/arg_inventory\//);
  assert.match(pub.description, /landing\/arg_inventory/);

  config.azure = { ...config.azure, publicNetworkAccess: false };
  assert.deepEqual(flowsWanted(config), [], 'private networking without a drop folder');
  config.azure.drop = parseDropFolder('https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens');
  assert.deepEqual(flowsWanted(config), ['agents']);
  const priv = flowDefinitions(config, 'tenant-1').agents.definition;
  assert.deepEqual(connectorsUsed(priv), [CONNECTORS.entra.name, CONNECTORS.sharePoint.name].sort());
  assert.match(JSON.stringify(priv), /"folderPath":"\/Shared Documents\/ValueLens\/arg_inventory"/);

  config.azure.sampleData = true;
  assert.deepEqual(flowsWanted(config), [], 'demo mode reads nothing from the tenant');
});

test('Azure deployment: Resource Graph joins the modules with its management group and what to read', async () => {
  for (const p of ['argManagementGroup', 'argAgents', 'argFoundry']) {
    assert.ok(REQUIRED_ARM_PARAMETERS.includes(p));
    assert.ok(armParameterNames().includes(p));
  }
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'id', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  const value = async () => Object.fromEntries(Object.entries((await azureDeployment(ctx, { pass: 1 })).properties.parameters).map(([k, v]) => [k, /** @type {any} */ (v).value]));
  const off = await value();
  assert.ok(!off.modules.split(',').includes('resourceGraph'));
  assert.deepEqual([off.argManagementGroup, off.argAgents, off.argFoundry], ['', true, true]);

  turnOn(config).resourceGraph = { managementGroup: 'mg-1', agents: false, foundry: true };
  const on = await value();
  assert.ok(on.modules.split(',').includes('resourceGraph'));
  assert.deepEqual([on.argManagementGroup, on.argAgents, on.argFoundry], ['mg-1', false, true]);
  assert.deepEqual(Object.keys(argParameters(config)), ['argManagementGroup', 'argAgents', 'argFoundry']);

  /** @type {any} */ (config.azure).sampleData = true;
  assert.ok(!(await value()).modules.split(',').includes('resourceGraph'), 'demo mode reads nothing from the tenant');
});

test('Azure install with Resource Graph: Reader for the jobs on the tenant root group, landing write for you, and the inventory flow', async () => {
  const arm = fakeArm();
  const powerBi = fakePowerBi();
  powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds' }]);
  /** @type {Map<string, any>} */
  const flows = new Map();
  const env = {
    createFlow: async (/** @type {any} */ f) => {
      flows.set(`flow-${flows.size + 1}`, { workflowid: `flow-${flows.size + 1}`, name: f.name, statecode: 0, clientdata: f.clientdata });
      return `flow-${flows.size}`;
    },
    getFlow: async (/** @type {string} */ id) => flows.get(id),
    updateFlow: async () => {},
    turnOffFlow: async () => {},
    deleteFlow: async () => {},
  };
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: fakeAzureGraph().api, fabric: fakeFabric().api, powerBi: powerBi.api, ui: ui.ui, dataverse: () => env });
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'install-1', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, workspaceName: 'Analytics Hub' };
  turnOn(config);
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };
  ctx.runFirstLoad = false;

  await installAzure(ctx, { wait: true });
  assert.ok(arm.calls.includes(`assignRole ${MG_ROOT} ${ROLES.reader} mi-sp ServicePrincipal`));
  assert.equal(config.resourceGraph?.azureAccess, true);
  assert.ok(arm.calls.some((c) => c.startsWith('assignRole') && c.includes(`${ROLES.storageBlobDataContributor} user-1 User`)));
  assert.equal(flows.size, 1);
  assert.equal([...flows.values()][0].name, AGENT_INVENTORY_FLOW_NAME);
  assert.match([...flows.values()][0].clientdata, /landing\/arg_inventory/);
  assert.match(ui.text(), /Global Reader, Power Platform Administrator or AI Administrator/);
});

test('models: the Resource Graph tables are always there, read from the Lakehouse only when on', () => {
  const sources = realSources();
  const template = loadTemplateModel(/** @type {string} */ (sources.modelFile));
  const settings = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens', modules: { ...defaultModules(), agent365: true } };
  const on = buildModel(template, { ...settings, resourceGraph: true }).model;
  for (const t of ARG_TABLES) {
    const table = on.tables.find((x) => x.name === t.name);
    assert.ok(table, t.name);
    assert.deepEqual(table.columns.map((/** @type {any} */ c) => c.name), t.columns.map((c) => c.name));
    assert.match(table.partitions[0].source.expression.join('\n'), new RegExp(`try FabricTable\\("${t.source}"\\) otherwise EmptyTable\\(Columns\\)`));
  }
  const config = on.tables.find((x) => x.name === AGENT_CONFIG_TABLE);
  const type = (/** @type {string} */ n) => config.columns.find((/** @type {any} */ c) => c.name === n).dataType;
  assert.deepEqual([type('SnapshotDate'), type('NoSignIn'), type('ConnectorCount'), type('Authentication')], ['dateTime', 'boolean', 'int64', 'string']);
  const rels = on.relationships.filter((/** @type {any} */ r) => r.fromTable === AGENT_CONFIG_TABLE).map((/** @type {any} */ r) => `${r.fromColumn}>${r.toTable}[${r.toColumn}]`);
  assert.deepEqual(rels, ['TitleId>Agents 365[Title ID]', `EnvironmentId>${ENVIRONMENTS_TABLE}[EnvironmentId]`]);

  const off = buildModel(template, settings).model;
  const offTable = off.tables.find((x) => x.name === AGENT_CONFIG_TABLE);
  assert.ok(offTable);
  assert.doesNotMatch(offTable.partitions[0].source.expression.join('\n'), /FabricTable/);
  assert.match(offTable.partitions[0].source.expression.join('\n'), /#table\(Columns, \{\}\)/);
  assert.equal(JSON.stringify(buildModel(template, { ...settings, resourceGraph: true }).model.tables.map((t) => t.lineageTag)), JSON.stringify(on.tables.map((t) => t.lineageTag)), 'stable lineage');

  const cc = loadTemplateModel(/** @type {string} */ (sources.consumptionModelFile));
  const ccOn = buildConsumptionModel(cc, { server: 's', database: 'd', resourceGraph: true }).model;
  const foundry = ccOn.tables.find((x) => x.name === FOUNDRY_TABLE);
  assert.match(foundry.partitions[0].source.expression.join('\n'), /GetTable\("arg_foundry_resources"\)/);
  assert.ok(!ccOn.relationships?.some((/** @type {any} */ r) => r.fromTable === FOUNDRY_TABLE || r.toTable === FOUNDRY_TABLE));
  const ccOff = buildConsumptionModel(cc, { server: 's', database: 'd' }).model;
  assert.doesNotMatch(ccOff.tables.find((x) => x.name === FOUNDRY_TABLE).partitions[0].source.expression.join('\n'), /GetTable/);
});
