// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { notebooksFor, STUDIO_LANDING, VIVA_LANDING } from '../src/catalog.js';
import { ROLES } from '../src/clients/azure.js';
import { CONFIG_VERSION, CONSUMPTION_MODEL_NAME, emptyConfig, loadConfig } from '../src/config.js';
import { refresh } from '../src/install.js';
import { appModels } from '../src/steps/app.js';
import { consumptionSummary, ensureAzureAiAccess, ensureConsumptionModel, ensureLandingFolders, planConsumption } from '../src/steps/consumption.js';
import { azureAiOn, consumptionModelDeployed, notebookSettings, pipelineSignature } from '../src/steps/fabric.js';
import { ensureModelConnection, ensureSemanticModel } from '../src/steps/model.js';
import { prepareNotebook, cellText } from '../src/transform/notebook.js';
import { buildPipeline, CONSUMPTION_REFRESH_ACTIVITY, findActivity, REFRESH_ACTIVITY } from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

const SUB = '9c2a9418-0000-0000-0000-000000000000';

/** Resource Manager: role assignments and AI accounts per subscription. */
function fakeArm() {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** @type {Record<string, number>} */
  const aiAccounts = {};
  const api = {
    /** @param {string} scope @param {string} roleId @param {string} principalId @param {string} type */
    assignRole: async (scope, roleId, principalId, type) => {
      calls.push(`assignRole ${scope} ${roleId} ${principalId} ${type}`);
      const err = failures.assignRole?.shift();
      if (err) throw err;
      return true;
    },
    /** @param {string} sub */
    listAiAccounts: async (sub) => {
      calls.push(`listAiAccounts ${sub}`);
      if (!(sub in aiAccounts)) throw httpError(403, 'Forbidden');
      return Array.from({ length: aiAccounts[sub] }, (_, i) => ({ id: `ai-${i}` }));
    },
  };
  return { api, calls, failures, aiAccounts };
}

/** OneLake folders. */
function fakeOneLake() {
  /** @type {string[]} */
  const dirs = [];
  /** @type {Error[]} */
  const failures = [];
  const api = {
    /** @param {string} _ws @param {string} _lh @param {string} path */
    createDirectory: async (_ws, _lh, path) => {
      const err = failures.shift();
      if (err) throw err;
      if (dirs.includes(path)) return false;
      dirs.push(path);
      return true;
    },
    readJson: async () => null,
  };
  return { api, dirs, failures };
}

/** @param {{ answers?: any[], yes?: boolean }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const powerBi = fakePowerBi();
  const arm = fakeArm();
  const oneLake = fakeOneLake();
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  const config = emptyConfig();
  config.semanticModel.enabled = true;
  config.modules.consumption = true;
  config.app.displayName = 'ValueLens Data Collector';
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, graph: graph.api, powerBi: powerBi.api, arm: arm.api, oneLake: oneLake.api, config });
  return { ...made, fabric, graph, powerBi, arm, oneLake, ui };
}

const ids = {
  auditIngester: 'nb-audit',
  licensedUsers: 'nb-users',
  processor: 'nb-processor',
  orgData: 'nb-org',
  refreshModel: 'nb-refresh',
  azureAi: 'nb-azure',
  studioConsumption: 'nb-studio',
  vivaConsumption: 'nb-viva',
};
const modules = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: true, agentEvaluator: false };
/** @param {any} doc */
const names = (doc) => doc.properties.activities.map((/** @type {any} */ a) => a.name);

test('pipeline: consumption loads run alongside the audit load, then refresh their own model', () => {
  const doc = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules, semanticModelId: 'model-1', azureAi: true, consumptionModelId: 'cc-1' });
  const all = names(doc);
  for (const n of ['Run_Consumption_Azure_AI', 'Run_Consumption_Studio', 'Run_Consumption_Viva', REFRESH_ACTIVITY, CONSUMPTION_REFRESH_ACTIVITY]) assert.ok(all.includes(n), n);
  assert.ok(!all.includes('Conditionally_Run_Credit_Consumption'), 'the archived branch stays out');
  assert.equal(doc.properties.parameters.EnableConsumption, undefined);

  const azure = findActivity(doc.properties.activities, 'Run_Consumption_Azure_AI');
  assert.deepEqual(azure.dependsOn, []);
  assert.equal(azure.typeProperties.notebookId, 'nb-azure');
  assert.equal(azure.policy.retry, 2, 'new Azure roles take a while to apply');
  assert.equal(findActivity(doc.properties.activities, 'Run_Consumption_Studio').policy.retry, 1);

  const ccRefresh = findActivity(doc.properties.activities, CONSUMPTION_REFRESH_ACTIVITY);
  assert.deepEqual(ccRefresh.dependsOn, [
    { activity: 'Run_Consumption_Azure_AI', dependencyConditions: ['Succeeded'] },
    { activity: 'Run_Consumption_Studio', dependencyConditions: ['Succeeded'] },
    { activity: 'Run_Consumption_Viva', dependencyConditions: ['Succeeded'] },
    { activity: 'Conditionally_Run_Org_Data', dependencyConditions: ['Completed'] },
  ]);
  assert.equal(ccRefresh.typeProperties.notebookId, 'nb-refresh');
  assert.equal(ccRefresh.typeProperties.parameters.SEMANTIC_MODEL_ID.value, 'cc-1');
  assert.equal(ccRefresh.typeProperties.parameters.WRITE_MODE.value, 'merge');
  assert.equal(findActivity(doc.properties.activities, REFRESH_ACTIVITY).typeProperties.parameters.SEMANTIC_MODEL_ID.value, 'model-1');
});

test('pipeline: without Azure access or a Consumption model, those steps are left out', () => {
  const noAzure = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules, semanticModelId: 'model-1', consumptionModelId: 'cc-1' });
  assert.ok(!names(noAzure).includes('Run_Consumption_Azure_AI'));
  assert.deepEqual(
    findActivity(noAzure.properties.activities, CONSUMPTION_REFRESH_ACTIVITY).dependsOn.map((/** @type {any} */ d) => d.activity),
    ['Run_Consumption_Studio', 'Run_Consumption_Viva', 'Conditionally_Run_Org_Data'],
  );

  const noModel = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules });
  assert.ok(names(noModel).includes('Run_Consumption_Studio'));
  assert.ok(!names(noModel).includes(CONSUMPTION_REFRESH_ACTIVITY));

  const off = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules: { ...modules, consumption: false, agentEvaluator: false }, azureAi: true, consumptionModelId: 'cc-1' });
  assert.ok(!names(off).some((/** @type {string} */ n) => n.includes('Consumption')));

  const { studioConsumption, ...missing } = ids;
  assert.throws(() => buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: missing, modules }), /Consumption Studio notebook/);
});

test('notebooks and signature: Azure AI only with access; existing installs keep their signature', () => {
  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1', bound: true });
  assert.equal(pipelineSignature(config), 'core,orgData,m365Activity;model=model-1', 'no consumption parts without consumption');

  config.modules.consumption = true;
  assert.deepEqual(notebooksFor(config.modules, { semanticModel: true }).filter((n) => n.module === 'consumption').map((n) => n.key), ['studioConsumption', 'vivaConsumption']);
  assert.ok(notebooksFor(config.modules, { azureAi: true }).some((n) => n.key === 'azureAi'));

  config.consumption.azureSubscriptionId = SUB;
  assert.equal(azureAiOn(config), false, 'not until the app has the roles');
  config.consumption.azureAccess = true;
  Object.assign(config.consumption.model, { id: 'cc-1', bound: true });
  assert.equal(azureAiOn(config), true);
  assert.equal(consumptionModelDeployed(config), true);
  assert.equal(pipelineSignature(config), 'core,orgData,m365Activity,consumption;model=model-1;azureAi;consumption=cc-1');

  config.semanticModel.enabled = false;
  assert.equal(consumptionModelDeployed(config), false, 'it shares the ValueLens connection');
});

test('Azure AI notebook: subscription, tenant, app and Key Vault secret are filled in', () => {
  const t = setup();
  Object.assign(t.config.consumption, { azureSubscriptionId: SUB, azureAccess: true });
  const info = /** @type {any} */ (notebooksFor(t.config.modules, { azureAi: true }).find((n) => n.key === 'azureAi'));
  const nb = prepareNotebook(realSources().notebooks.azureAi, notebookSettings(t.ctx, info));
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, new RegExp(`^SUBSCRIPTION_ID = '${SUB}'`, 'm'));
  assert.match(all, /^TENANT_ID = 'tenant-1'/m);
  assert.match(all, /^CLIENT_ID = 'app-1'/m);
  assert.match(all, /^KEY_VAULT_URL = 'https:\/\/kv-test\.vault\.azure\.net\/'/m);
  assert.match(all, /^CLIENT_SECRET_NAME = 'valuelens-client-secret'/m);
  assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, 'lh-1');
});

test('plan: picks the subscription with AI resources; "leave out" is remembered; a change resets access', async () => {
  const subs = [
    { subscriptionId: 'sub-a', displayName: 'Dev' },
    { subscriptionId: SUB, displayName: 'AI' },
  ];
  const t = setup();
  t.arm.aiAccounts['sub-a'] = 0;
  t.arm.aiAccounts[SUB] = 4;
  await planConsumption(t.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(t.config.consumption.azureSubscriptionId, SUB);
  assert.equal(t.config.consumption.azureSubscriptionName, 'AI');

  t.config.consumption.azureAccess = true;
  await planConsumption(t.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(t.config.consumption.azureAccess, true, 'same answer keeps access');

  const left = setup({ answers: [''] });
  left.arm.aiAccounts[SUB] = 4;
  await planConsumption(left.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(left.config.consumption.azureSubscriptionId, '');
  const again = setup();
  again.config.consumption = left.config.consumption;
  again.arm.aiAccounts[SUB] = 4;
  await planConsumption(again.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(again.config.consumption.azureSubscriptionId, '', 'the default is what was chosen before');

  const moved = setup({ answers: ['sub-a'] });
  Object.assign(moved.config.consumption, { azureSubscriptionId: SUB, azureAccess: true });
  await planConsumption(moved.ctx, /** @type {any} */ ({ subscriptions: subs }));
  assert.equal(moved.config.consumption.azureAccess, false);

  const many = setup();
  await planConsumption(many.ctx, /** @type {any} */ ({ subscriptions: Array.from({ length: 30 }, (_, i) => ({ subscriptionId: `s-${i}`, displayName: `S${i}` })) }));
  assert.deepEqual(many.arm.calls, [], 'too many subscriptions to search');
  assert.equal(many.config.consumption.azureSubscriptionId, '');
});

test('Azure access: the app gets three read roles once; without rights the user can leave Azure AI out', async () => {
  const t = setup();
  t.config.consumption.azureSubscriptionId = SUB;
  assert.equal(await ensureAzureAiAccess(t.ctx), true);
  assert.deepEqual(t.arm.calls, [ROLES.reader, ROLES.costManagementReader, ROLES.monitoringReader].map((r) => `assignRole /subscriptions/${SUB} ${r} sp-1 ServicePrincipal`));
  assert.equal(t.config.consumption.azureAccess, true);
  assert.equal(await ensureAzureAiAccess(t.ctx), true);
  assert.equal(t.arm.calls.length, 3, 'nothing to do on a re-run');

  const denied = setup();
  denied.config.consumption.azureSubscriptionId = SUB;
  denied.arm.failures.assignRole = [httpError(403, 'AuthorizationFailed')];
  assert.equal(await ensureAzureAiAccess(denied.ctx), false);
  assert.equal(denied.config.consumption.azureAccess, undefined);
  assert.match(denied.ui.text(), /Reader, Cost Management Reader, Monitoring Reader/);
  assert.match(denied.ui.text(), /app-1/);

  const granted = setup({ answers: [true] });
  granted.config.consumption.azureSubscriptionId = SUB;
  granted.arm.failures.assignRole = [httpError(403, 'AuthorizationFailed')];
  assert.equal(await ensureAzureAiAccess(granted.ctx), true);
  assert.equal(granted.config.consumption.azureAccess, true);

  const broken = setup();
  broken.config.consumption.azureSubscriptionId = SUB;
  broken.arm.failures.assignRole = [httpError(500, 'Boom')];
  await assert.rejects(ensureAzureAiAccess(broken.ctx), /Boom/);

  const none = setup();
  assert.equal(await ensureAzureAiAccess(none.ctx), false);
  assert.deepEqual(none.arm.calls, []);
});

test('landing folders: both made, existing ones left alone, a failure only warns', async () => {
  const t = setup();
  await ensureLandingFolders(t.ctx);
  assert.deepEqual(t.oneLake.dirs, [STUDIO_LANDING, VIVA_LANDING]);
  assert.equal(t.config.consumption.landing, true);
  await ensureLandingFolders(t.ctx);
  assert.equal(t.oneLake.dirs.length, 2);

  const failed = setup();
  failed.oneLake.failures.push(httpError(403, 'Forbidden'));
  await ensureLandingFolders(failed.ctx);
  assert.equal(failed.config.consumption.landing, undefined);
  assert.match(failed.ui.text(), /New subfolder/);
});

/** @param {ReturnType<typeof setup>} t */
async function withConnection(t) {
  await ensureSemanticModel(t.ctx);
  await ensureModelConnection(t.ctx);
  t.fabric.calls.length = 0;
}

test('Consumption model: built from its template, bound through the ValueLens connection, updated only when needed', async () => {
  const t = setup();
  await withConnection(t);
  await ensureConsumptionModel(t.ctx);
  const cm = t.config.consumption.model;
  const item = /** @type {any} */ (t.fabric.items.find((i) => i.displayName === CONSUMPTION_MODEL_NAME));
  assert.ok(item);
  assert.equal(cm.id, item.id);
  const bim = JSON.parse(Buffer.from(item.content.parts.find((/** @type {any} */ p) => p.path === 'model.bim').payload, 'base64').toString('utf8'));
  const param = (/** @type {string} */ n) => String(bim.model.expressions.find((/** @type {any} */ e) => e.name === n).expression);
  assert.ok(param('FabricSQLEndpoint').startsWith('"abc.datawarehouse.fabric.microsoft.com" meta ['));
  assert.ok(param('LakehouseName').startsWith('"ValueLens" meta ['));
  const conn = t.config.semanticModel.connectionId;
  assert.deepEqual(t.fabric.calls, [`createSemanticModel ${CONSUMPTION_MODEL_NAME}`, `bindConnection ${CONSUMPTION_MODEL_NAME} ${conn} abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
  assert.equal(cm.bound, true);

  t.fabric.calls.length = 0;
  await ensureConsumptionModel(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'nothing to do on a re-run');

  await ensureConsumptionModel(t.ctx, { force: true });
  assert.deepEqual(t.fabric.calls, [`updateSemanticModel ${CONSUMPTION_MODEL_NAME}`, `bindConnection ${CONSUMPTION_MODEL_NAME} ${conn} abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
});

test('Consumption model: a new ValueLens connection means binding it again', async () => {
  const t = setup();
  await withConnection(t);
  await ensureConsumptionModel(t.ctx);
  t.fabric.connections.length = 0;
  await ensureModelConnection(t.ctx);
  assert.equal(t.config.consumption.model.bound, false);
  t.fabric.calls.length = 0;
  await ensureConsumptionModel(t.ctx);
  assert.deepEqual(t.fabric.calls, [`bindConnection ${CONSUMPTION_MODEL_NAME} ${t.config.semanticModel.connectionId} abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
});

test('refresh: both models when the Consumption model is deployed', async () => {
  const t = setup();
  Object.assign(t.config.semanticModel, { id: 'model-1', bound: true });
  await refresh(t.ctx, { wait: false });
  assert.deepEqual(t.powerBi.calls, ['refresh model-1 full']);

  Object.assign(t.config.consumption.model, { id: 'cc-1', bound: true });
  t.powerBi.calls.length = 0;
  const result = await refresh(t.ctx, { wait: true });
  assert.deepEqual(t.powerBi.calls.filter((c) => c.startsWith('refresh ')), ['refresh model-1 full', 'refresh cc-1 full']);
  assert.equal(result.ok, true);
});

test('summary: Azure AI status and the Studio and Cowork upload steps', () => {
  const t = setup();
  Object.assign(t.config.consumption, { azureSubscriptionId: SUB, azureSubscriptionName: 'AI' });
  Object.assign(t.config.consumption.model, { id: 'cc-1', bound: true });
  consumptionSummary(t.ctx);
  const text = t.ui.text();
  assert.match(text, /left out until ValueLens Data Collector has Reader, Cost Management Reader, Monitoring Reader on AI/);
  assert.match(text, /datasets\/cc-1/);
  assert.match(text, new RegExp(STUDIO_LANDING));
  assert.match(text, /Dataflow Gen2/);
  assert.match(text, /viva_credits_weekly/);
});

test('app: built with the cc alias when the Consumption model is deployed', () => {
  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1', bound: true });
  assert.deepEqual(appModels(config), ['vl']);
  config.modules.consumption = true;
  Object.assign(config.consumption.model, { id: 'cc-1', bound: true });
  assert.deepEqual(appModels(config), ['vl', 'cc']);
});

test('install record: older records gain the consumption defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-cfg-'));
  try {
    const file = join(dir, 'valuelens-install.json');
    writeFileSync(file, JSON.stringify({ version: CONFIG_VERSION, modules: { orgData: true } }));
    const { config } = loadConfig(file);
    assert.equal(config.modules.consumption, false);
    assert.equal(config.consumption.model.name, CONSUMPTION_MODEL_NAME);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
