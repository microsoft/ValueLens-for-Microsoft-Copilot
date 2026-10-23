// @ts-check
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../src/http.js';
import { ensureAzureTranscriptAccess } from '../src/steps/azure/agent-evaluator.js';
import {
  agentEvaluatorParameters, azureAgentEvaluatorModelDeployed, azureAgentEvaluatorOn, azureAgentEvaluatorReads, azureAgentEvaluatorRefreshes, azurePlanReview, azurePreflight, azureRefresh, azureSemanticModels, azureStatus, azureSummary,
  azureUninstall, azureViewerModels, enabledAzureModuleIds, installAzure,
} from '../src/steps/azure/index.js';
import { MODEL_UPDATE_NOTE, pendingReloads } from '../src/steps/model.js';
import { AZURE_ROLES_FILE, rlsModels } from '../src/steps/org-access.js';
import { buildAgentEvaluatorModel, loadTemplateModel, mParameter } from '../src/transform/model.js';
import { fakeArm, fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeTranscriptEnvironment, fakeUi, httpError, PLATFORM_PRIVILEGES, realSources } from './fakes.js';

const AE_MODEL = 'Analytics Hub Agent Evaluator Model';
const SERVER = 'vlens-sql.database.windows.net';
const DATABASE = 'valuelens';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const ENV = 'https://env.example.com';
const DEV = 'https://dev.example.com';
const OFF = { value: { enabled: false } };
/** The read role the installer creates for install-1 in each environment. */
const READ_ROLE = 'Analytics Hub transcript reader install-';

/**
 * The calls that create the install's read role in the root business unit, check that no one else has it, set its
 * privileges to exactly transcript read at Organization depth, and give it to a user.
 * @param {string} user @param {string} [role]
 */
const readRoleCalls = (user, role = 'read-1') => [
  `createRole ${READ_ROLE} bu-root`,
  `roleCopies ${role}`,
  `roleHolders ${role}`,
  ...PLATFORM_PRIVILEGES.map((p) => `removePrivilege ${role} ${p}`),
  `addPrivileges ${role} prvReadconversationtranscript bu-root`,
  `assignRole ${user} ${role}`,
];

/** What the installer records of a read role it created and gave. @param {string} [role] */
const readRoleRecord = (role = 'read-1') => ({ readRoleId: role, readRoleName: READ_ROLE, createdReadRole: true, assignedReadRoleId: role });

/** What removing a user the installer created takes back: the read role, then Bot Transcript Viewer, then the user. @param {string} [user] @param {string} [role] */
const deleteCalls = (user = 'user-1', role = 'read-1') => [`removeRole ${user} ${role}`, `deleteRole ${role}`, `removeRole ${user} role-btv`, `disableUser ${user}`, `deleteUser ${user}`];

/** The same, and the user read back, which finds it gone. @param {string} [user] @param {string} [role] */
const removalCalls = (user = 'user-1', role = 'read-1') => [...deleteCalls(user, role), `getUser ${user}`];

/** How a System Administrator deletes a soft-deleted application user in Example for good. */
const DELETE_FOR_GOOD =
  'A System Administrator can delete it for good: Power Platform admin center > Manage > Environments > Example > Settings > Users + permissions > Users > ' +
  'Filter > Users not in Microsoft Entra ID and soft deleted in the environment > select it > Delete. Any records it owns must be reassigned first, and ' +
  'Settings > Product > Features > Enable delete disabled users must be on. It can\'t be activated again, so delete it before you tick Example again.';

/**
 * An Azure install with Agent Evaluator ticked and, unless a test says otherwise, one environment chosen. Each
 * environment's Dataverse is a fake, where the jobs' managed identity is added unless a test scripts otherwise. Power BI
 * schedules are recorded by model, and `scheduleErrors` makes setting one fail.
 * @param {{ private?: boolean, environments?: false | import('../src/config.js').AgentEnvironment[], sources?: any, az?: Record<string, any>, answers?: any[], dataverse?: Record<string, ReturnType<typeof fakeTranscriptEnvironment>> }} [o]
 */
async function aeInstall(o = {}) {
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
  /** @type {Map<string, any[]>} */
  const schedules = new Map();
  /** @type {Map<string, Error>} */
  const scheduleErrors = new Map();
  const setSchedule = powerBi.api.setRefreshSchedule;
  Object.assign(powerBi.api, {
    setRefreshSchedule: async (/** @type {string} */ ws, /** @type {string} */ id, /** @type {any} */ body) => {
      await setSchedule(ws, id);
      schedules.set(id, [...(schedules.get(id) ?? []), body]);
      const err = scheduleErrors.get(id);
      if (err) throw err;
    },
  });
  if (!o.private) powerBi.setDatasources([{ datasourceType: 'Sql', gatewayId: 'gw', datasourceId: 'ds', connectionDetails: { server: SERVER, database: DATABASE } }]);
  const ui = fakeUi({ answers: o.answers });
  /** @type {Record<string, ReturnType<typeof fakeTranscriptEnvironment>>} */
  const dv = { ...o.dataverse };
  const dataverse = (/** @type {string} */ url) => (dv[url] ??= fakeTranscriptEnvironment()).api;
  const { ctx, config } = fakeCtx({ arm: arm.api, graph: graph.api, fabric: fabric.api, powerBi: powerBi.api, ui: ui.ui, sources: o.sources, dataverse });
  Object.assign(config, {
    target: 'azure',
    azure: {
      subscriptionId: 'sub-1',
      resourceGroup: 'rg',
      location: 'uksouth',
      namePrefix: 'vlens',
      installId: o.private ? '12345678-aaaa' : 'install-1',
      tags: {},
      deployments: [],
      outputs: {},
      graphRoles: { assigned: [], pending: [] },
      publicNetworkAccess: !o.private,
      workspaceName: 'Analytics Hub',
      ...(o.private ? { powerBi: { capacityId: 'cap-f' } } : {}),
      ...o.az,
    },
  });
  config.modules.agentEvaluator = true;
  if (o.environments !== false) config.agentEvaluator.environments = o.environments ?? [{ url: ENV, id: 'env-1', name: 'Example' }];
  if (o.private) await azurePreflight(ctx);
  ctx.runFirstLoad = false;
  const ok = await installAzure(ctx, { wait: true });
  return { ctx, config, arm, graph, fabric, powerBi, ui, deployments, ok, az: /** @type {any} */ (config.azure), dv, schedules, scheduleErrors };
}

/** The model.bim a fake Fabric holds for a semantic model. @param {ReturnType<typeof fakeFabric>} fabric @param {string} id */
function deployedBim(fabric, id) {
  const item = /** @type {any} */ (fabric.items.find((i) => i.id === id));
  return JSON.parse(Buffer.from(item.content.parts.find((/** @type {any} */ p) => p.path === 'model.bim').payload, 'base64').toString('utf8'));
}

/** The web app's models, from the last deployment. @param {any[]} deployments */
const deployedAliases = (deployments) => Object.keys(JSON.parse(deployments.at(-1).properties.parameters.semanticModels.value)).sort();

/** The jobs' settings from the last deployment: the modules they run, and the environments they read. @param {any[]} deployments */
function jobSettings(deployments) {
  const p = deployments.at(-1).properties.parameters;
  return { modules: String(p.modules.value).split(',').filter(Boolean), environments: JSON.parse(p.dataverseEnvironments.value) };
}

test('Azure Agent Evaluator: its model is deployed with the module on, an environment and tenant data, and used while the module is on', () => {
  const { config } = fakeCtx();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ powerBi: { workspaceId: 'ws', datasetId: 'vl-1', agentEvaluatorDatasetId: 'ae-1' }, outputs: { identityClientId: 'mi-client' } });
  const az = /** @type {any} */ (config.azure);
  const vl = `vl-1 ${config.semanticModel.name}`;
  const ae = `ae-1 ${AE_MODEL}`;
  const gates = () => ({
    on: azureAgentEvaluatorOn(config),
    deployed: azureAgentEvaluatorModelDeployed(config),
    reads: azureAgentEvaluatorReads(config),
    refreshes: azureAgentEvaluatorRefreshes(config),
  });
  const used = () => ({ aliases: Object.keys(azureSemanticModels(config)), viewers: azureViewerModels(config).map((m) => `${m.datasetId} ${m.name}`), rls: rlsModels(config).map((m) => m.datasetId) });
  assert.deepEqual(gates(), { on: false, deployed: false, reads: false, refreshes: false }, 'off by default');
  assert.deepEqual(used(), { aliases: ['vl'], viewers: [vl], rls: ['vl-1'] });

  config.modules.agentEvaluator = true;
  assert.deepEqual(gates(), { on: false, deployed: true, reads: false, refreshes: false }, 'no environment to read, but its model is in use, as on Fabric');
  assert.deepEqual(azureSemanticModels(config), { vl: { workspaceId: 'ws', itemId: 'vl-1' }, ae: { workspaceId: 'ws', itemId: 'ae-1' } });
  assert.deepEqual(used(), { aliases: ['vl', 'ae'], viewers: [vl, ae], rls: ['vl-1', 'ae-1'] }, 'the viewer group gets Build on it, so the app can query it');

  config.agentEvaluator.environments = [{ url: ENV }, { url: DEV }];
  assert.deepEqual(gates(), { on: true, deployed: true, reads: false, refreshes: false }, 'the managed identity reads neither environment yet');
  config.agentEvaluator.environments[1].access = true;
  assert.equal(azureAgentEvaluatorReads(config), false, 'access found for no recorded identity is checked again');
  config.agentEvaluator.environments[1].accessAppId = 'OTHER-MI';
  assert.equal(azureAgentEvaluatorReads(config), false, 'access for another managed identity');
  config.agentEvaluator.environments[1].accessAppId = 'MI-CLIENT';
  assert.deepEqual(gates(), { on: true, deployed: true, reads: true, refreshes: true }, 'one of two environments is enough');

  delete az.powerBi.agentEvaluatorDatasetId;
  assert.deepEqual(gates(), { on: true, deployed: false, reads: true, refreshes: false }, 'the jobs read before the model is deployed');
  assert.deepEqual(used(), { aliases: ['vl'], viewers: [vl], rls: ['vl-1'] });
  az.powerBi.agentEvaluatorDatasetId = 'ae-1';

  az.sampleData = true;
  assert.deepEqual(gates(), { on: false, deployed: false, reads: false, refreshes: false }, 'demo mode publishes no Agent Evaluator tables');
  assert.deepEqual(used(), { aliases: ['vl'], viewers: [vl], rls: ['vl-1'] });
  az.sampleData = false;

  config.modules.agentEvaluator = false;
  assert.deepEqual(gates(), { on: false, deployed: false, reads: false, refreshes: false }, 'unticked');
  assert.deepEqual(used(), { aliases: ['vl'], viewers: [vl], rls: ['vl-1'] });
  assert.equal(az.powerBi.agentEvaluatorDatasetId, 'ae-1', 'the model is kept');
});

test('Azure Agent Evaluator: the jobs\' module follows the tick, and they get the environments once the managed identity can read one', () => {
  const { config } = fakeCtx();
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ outputs: { identityClientId: 'mi-client' } });
  const az = /** @type {import('../src/config.js').AzureConfig} */ (config.azure);
  const listed = () => enabledAzureModuleIds(config.modules, az).includes('agentEvaluator');
  const environments = () => JSON.parse(agentEvaluatorParameters(config).dataverseEnvironments.value);
  assert.equal(listed(), false, 'unticked');
  config.modules.agentEvaluator = true;
  assert.equal(listed(), true, 'ticked with no environment, as Fabric\'s flag is');
  assert.deepEqual(environments(), []);
  config.agentEvaluator.environments = [{ url: ENV, name: 'Example' }, { url: DEV }];
  assert.equal(listed(), true, 'ticked with none readable');
  assert.deepEqual(environments(), [], 'nothing for the jobs to read or refresh yet');
  Object.assign(config.agentEvaluator.environments[1], { access: true, accessAppId: 'mi-client' });
  assert.equal(listed(), true, 'one of two readable');
  assert.deepEqual(environments(), [{ url: ENV, name: 'Example' }, { url: DEV }], 'every chosen environment, readable or not');
  az.sampleData = true;
  assert.equal(listed(), false, 'demo mode');
  assert.deepEqual(environments(), []);
  az.sampleData = false;
  config.modules.agentEvaluator = false;
  assert.equal(listed(), false, 'unticked again');
  assert.deepEqual(environments(), []);
});

test('Azure install with Agent Evaluator: a third model, reading Azure SQL, bound, scheduled and given to the app as ae', async () => {
  const t = await aeInstall();
  assert.equal(t.ok, true);
  const ae = t.config.agentEvaluator.model;
  assert.ok(t.fabric.calls.includes(`createSemanticModel ${AE_MODEL}`));
  assert.ok(ae.id && ae.id !== t.az.powerBi.datasetId);
  assert.equal(t.az.powerBi.agentEvaluatorDatasetId, ae.id);

  const bim = deployedBim(t.fabric, ae.id);
  assert.equal(mParameter(bim.model, 'Fabric SQL Endpoint'), SERVER);
  assert.equal(mParameter(bim.model, 'Lakehouse Name'), DATABASE);
  assert.equal(mParameter(bim.model, 'Source Mode'), 'Fabric');
  assert.ok(bim.model.tables.some((/** @type {any} */ tb) => tb.name === 'Evaluator Status'));
  assert.ok(!bim.model.roles?.length, 'no roles without org-scoped access');

  assert.equal(t.powerBi.calls.filter((c) => c === 'updateDatasource gw ds ServicePrincipal').length, 2, 'the main model and Agent Evaluator are bound');
  assert.ok(t.powerBi.calls.includes(`setRefreshSchedule ${t.az.powerBi.workspaceId} ${ae.id}`));
  assert.equal(t.schedules.get(ae.id)?.at(-1).value.enabled, true, 'scheduled like the main model, since the managed identity can read the environment');
  assert.deepEqual(deployedAliases(t.deployments), ['ae', 'vl'], 'the app can query it, and the jobs refresh it');
  assert.ok(t.ui.text().includes(`Evaluator:  model ${ae.id}`));

  // The jobs' managed identity is added to the environment with Bot Transcript Viewer and the install's read role, which
  // reads every transcript, whoever owns it, and nothing else. What was added is noted for removal.
  const dv = t.dv[ENV];
  assert.deepEqual(dv.calls, ['findAppUser mi-client', 'createAppUser mi-client bu-root', 'findRole Bot Transcript Viewer bu-root', 'assignRole user-1 role-btv', ...readRoleCalls('user-1')]);
  assert.deepEqual(dv.holds('read-1'), ['prvReadconversationtranscript:Global'], 'exactly transcript read, at Organization depth');
  assert.deepEqual(dv.userRoles['user-1'], ['role-btv', 'read-1']);
  const [made] = dv.roles;
  assert.deepEqual([made.name, made.bu], [READ_ROLE, 'bu-root']);
  assert.match(
    made.description ?? '',
    /^Created by the Analytics Hub installer for the Azure install install-1\. It lets the jobs' managed identity (\S+ )?\(client ID mi-client\) read every Copilot Studio conversation transcript in this environment, and nothing else\./,
  );
  const recorded = { url: ENV, appId: 'mi-client', name: 'Example', userId: 'user-1', createdUser: true, roleId: 'role-btv', ...readRoleRecord() };
  assert.deepEqual(t.az.transcriptAccess, [recorded]);
  assert.deepEqual(t.config.agentEvaluator.environments[0], { url: ENV, id: 'env-1', name: 'Example', access: true, readAll: true, accessAppId: 'mi-client' });
  assert.ok(jobSettings(t.deployments).modules.includes('agentEvaluator'), 'the jobs read the transcripts');
  assert.deepEqual(jobSettings(t.deployments).environments, [{ url: ENV, name: 'Example' }]);
  const text = t.ui.text();
  assert.ok(text.includes(`Created the "${READ_ROLE}" role in Example: it reads every Copilot Studio conversation transcript there, and nothing else`));
  assert.ok(text.includes(`Gave the jobs' managed identity the Bot Transcript Viewer and "${READ_ROLE}" roles in Example`));

  // A repair leaves it as it is.
  t.fabric.calls.length = 0;
  dv.calls.length = 0;
  t.ui.out.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(!t.fabric.calls.some((c) => c.startsWith('createSemanticModel') || c.startsWith('updateSemanticModel')));
  assert.equal(t.az.powerBi.agentEvaluatorDatasetId, ae.id);
  assert.deepEqual(dv.calls, [], 'access already found is not asked for again');
  assert.deepEqual(t.az.transcriptAccess, [recorded]);
  assert.ok(t.ui.text().includes('The jobs\' managed identity can read every transcript in Example'));
});

test('Azure install with Agent Evaluator: no model in demo mode, without an environment or without its template', async () => {
  /** @type {[string, Parameters<typeof aeInstall>[0]][]} */
  const cases = [
    ['demo mode', { az: { sampleData: true } }],
    ['no environment', { environments: false }],
  ];
  for (const [label, o] of cases) {
    const t = await aeInstall(o);
    assert.ok(!t.fabric.calls.includes(`createSemanticModel ${AE_MODEL}`), label);
    assert.equal(t.az.powerBi?.agentEvaluatorDatasetId, undefined, label);
    assert.equal(t.config.agentEvaluator.model.id, undefined, label);
    assert.deepEqual(Object.keys(t.dv), [], `${label}: Dataverse isn't touched`);
    assert.equal(jobSettings(t.deployments).modules.includes('agentEvaluator'), label === 'no environment', `${label}: the module follows its tick outside demo mode`);
    assert.deepEqual(jobSettings(t.deployments).environments, [], label);
  }

  const bare = await aeInstall({ sources: { ...realSources(), agentEvaluatorModelFile: undefined } });
  assert.equal(bare.ok, true);
  assert.match(bare.ui.text(), /This checkout has no Agent Evaluator report, so only the jobs collect the transcripts\./);
  assert.equal(bare.az.powerBi.agentEvaluatorDatasetId, undefined);
  assert.deepEqual(deployedAliases(bare.deployments), ['vl']);
});

test('Azure install with Agent Evaluator and private networking: its model is bound through the VNet data gateway too', async () => {
  const t = await aeInstall({ private: true });
  const pbi = t.az.powerBi;
  assert.ok(pbi.agentEvaluatorDatasetId);
  assert.ok(t.powerBi.calls.includes(`bindToGateway ${pbi.datasetId} ${pbi.gatewayId} ${pbi.connectionId}`));
  assert.ok(t.powerBi.calls.includes(`bindToGateway ${pbi.agentEvaluatorDatasetId} ${pbi.gatewayId} ${pbi.connectionId}`));
  assert.ok(!t.powerBi.calls.some((c) => c.startsWith('updateDatasource')), 'no cloud credential binding in private mode');
});

test('Azure plan with Agent Evaluator: its model is listed, as new or updated in place', async () => {
  const t = await aeInstall();
  const row = () => azurePlanReview(t.ctx).creates.find((r) => r.name === AE_MODEL);
  assert.deepEqual(row(), { kind: 'Semantic model', name: AE_MODEL, isNew: false, detail: `Agent Evaluator, reading Azure SQL like the main model. ${MODEL_UPDATE_NOTE}` });
  delete t.az.powerBi.agentEvaluatorDatasetId;
  assert.deepEqual(row(), { kind: 'Semantic model', name: AE_MODEL, isNew: true, detail: 'Agent Evaluator, reading Azure SQL like the main model.' });
  t.ctx.sources = /** @type {any} */ ({ ...realSources(), agentEvaluatorModelFile: undefined });
  assert.equal(row(), undefined, 'not without its template');
  t.ctx.sources = realSources();
  t.config.modules.agentEvaluator = false;
  assert.equal(row(), undefined, 'not with the module off');
});

test('Azure refresh and status cover the Agent Evaluator model', async () => {
  const t = await aeInstall();
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  t.powerBi.calls.length = 0;
  await azureRefresh(t.ctx);
  assert.ok(t.powerBi.calls.includes(`refresh ${t.az.powerBi.datasetId} full`));
  assert.ok(t.powerBi.calls.includes(`refresh ${id} full`));
  assert.ok(t.ui.text().includes(`Started a refresh of ${AE_MODEL}`));
  await azureStatus(t.ctx);
  assert.ok(t.ui.text().includes(`Evaluator:      ${id}`));
});

test('Azure: a replaced Agent Evaluator model is refreshed, and owed a reload until it is', async () => {
  const t = await aeInstall();
  const ae = t.config.agentEvaluator.model;
  ae.signature = 'from an older version';
  t.fabric.calls.length = 0;
  t.powerBi.calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.fabric.calls.filter((c) => c.startsWith('updateSemanticModel')), [`updateSemanticModel ${AE_MODEL}`]);
  assert.equal(t.powerBi.calls.filter((c) => c.startsWith(`refresh ${ae.id} `)).length, 1);
  assert.ok(t.ui.text().includes(`${AE_MODEL} may show old data or miss new columns until it reloads after its update, so refreshing it now`));
  assert.deepEqual(pendingReloads(t.config), [], 'reloaded');

  // Owed a reload, a model kept while its module is off, or in demo mode, waits until it's used again.
  ae.reload = { since: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(pendingReloads(t.config), [ae]);
  t.config.modules.agentEvaluator = false;
  assert.deepEqual(pendingReloads(t.config), []);
  t.config.modules.agentEvaluator = true;
  t.az.sampleData = true;
  assert.deepEqual(pendingReloads(t.config), []);
});

test('Azure install with Agent Evaluator and org-scoped access: its model gets the roles, and the roles file covers it', async () => {
  const t = await aeInstall();
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  t.config.access = /** @type {any} */ ({ ...t.config.access, groupId: 'group-1', groupName: 'Analytics Hub Viewers', rls: { enabled: true, orgAttribute: 'department', applied: [] } });
  Object.assign(t.graph.api, { getGroup: async (/** @type {string} */ gid) => ({ id: gid, displayName: 'Analytics Hub Viewers' }) });
  Object.assign(t.powerBi.api, { datasetUsers: async () => [], addDatasetUser: async () => null });
  t.az.powerBi.capacityId = 'cap-1';
  /** @type {Map<string, string>} */
  const files = new Map();
  t.ctx.api.dataLake = /** @type {any} */ (() => ({
    readText: async (/** @type {string} */ container, /** @type {string} */ path) => files.get(`${container}/${path}`) ?? null,
    writeFile: async (/** @type {string} */ container, /** @type {string} */ path, /** @type {Uint8Array} */ bytes) => {
      files.set(`${container}/${path}`, Buffer.from(bytes).toString('utf8'));
    },
  }));
  t.fabric.jobs.push({ status: 'Completed' });
  t.fabric.calls.length = 0;

  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(t.fabric.calls.includes(`updateSemanticModel ${AE_MODEL}`), 'updated to add the roles');
  assert.ok(deployedBim(t.fabric, id).model.roles?.length, 'with roles');
  const items = JSON.parse(files.get(`landing/${AZURE_ROLES_FILE}`) ?? '[]');
  assert.ok(items.some((/** @type {any} */ i) => i.datasetId === id && i.dataset === AE_MODEL), 'in the roles file');
  assert.deepEqual([...(t.config.access?.rls?.applied ?? [])].sort(), [t.az.powerBi.datasetId, id].sort());
  assert.match(t.ui.text(), new RegExp(`Org-scoped access applied to .*${AE_MODEL}`));
});

/** An environment where whoever runs the installer can't add application users. */
function blockedEnvironment() {
  const env = fakeTranscriptEnvironment();
  env.failures.findAppUser = [httpError(403, 'Forbidden')];
  return env;
}

/** Whether the app, the viewers' Build permission and the org-scoped roles use a model. @param {Awaited<ReturnType<typeof aeInstall>>} t @param {string} id */
const usedBy = (t, id) => ({
  app: deployedAliases(t.deployments).includes('ae'),
  viewers: azureViewerModels(t.config).some((m) => m.datasetId === id),
  rls: rlsModels(t.config).some((m) => m.datasetId === id),
});

test('Azure Agent Evaluator, with no environment the jobs can read: its pages are there, but nothing reads, refreshes or schedules it', async () => {
  const t = await aeInstall({ dataverse: { [ENV]: blockedEnvironment() } });
  assert.equal(t.ok, true);
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  assert.ok(id, 'deployed, for its pages');
  assert.deepEqual(usedBy(t, id), { app: true, viewers: true, rls: true });
  const jobs = jobSettings(t.deployments);
  assert.ok(jobs.modules.includes('agentEvaluator'), 'the module follows its tick, as Fabric\'s flag does');
  assert.deepEqual(jobs.environments, [], 'so the jobs neither read transcripts nor refresh the model');
  assert.deepEqual(t.schedules.get(id), [OFF], 'its schedule is only ever turned off');
  assert.equal(t.az.transcriptAccess, undefined, 'nothing was added');
  assert.equal(t.config.agentEvaluator.environments[0].access, undefined);
  const text = t.ui.text();
  assert.ok(text.includes('You can\'t add the jobs\' managed identity to Example, so its transcripts are skipped until someone does.'));
  assert.ok(text.includes('Search for the managed identity by its client ID, mi-client.'), 'the admin center finds it by client ID');
  assert.ok(text.includes('The jobs\' managed identity can\'t read any of the environments yet, so the jobs don\'t read transcripts.'));

  t.powerBi.calls.length = 0;
  await azureRefresh(t.ctx);
  assert.ok(t.powerBi.calls.includes(`refresh ${t.az.powerBi.datasetId} full`));
  assert.ok(!t.powerBi.calls.includes(`refresh ${id} full`), 'nothing to refresh it from yet');
  t.ui.out.length = 0;
  await azureStatus(t.ctx);
  assert.match(t.ui.text(), /Agents: +0 of 1 environment\(s\) readable/);
});

test('Azure Agent Evaluator, with one of two environments readable: the jobs read, and the model refreshes on its schedule', async () => {
  const t = await aeInstall({ environments: [{ url: ENV, id: 'env-1', name: 'Example' }, { url: DEV, id: 'env-2', name: 'Dev' }], dataverse: { [DEV]: blockedEnvironment() } });
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  assert.deepEqual(usedBy(t, id), { app: true, viewers: true, rls: true });
  assert.equal(t.schedules.get(id)?.at(-1).value.enabled, true);
  const jobs = jobSettings(t.deployments);
  assert.ok(jobs.modules.includes('agentEvaluator'));
  assert.deepEqual(jobs.environments, [{ url: ENV, name: 'Example' }, { url: DEV, name: 'Dev' }], 'so the jobs report the one they can\'t read');
  assert.deepEqual(t.az.transcriptAccess.map((/** @type {any} */ e) => e.url), [ENV]);
  t.powerBi.calls.length = 0;
  await azureRefresh(t.ctx);
  assert.ok(t.powerBi.calls.includes(`refresh ${id} full`));
  t.ui.out.length = 0;
  await azureStatus(t.ctx);
  assert.match(t.ui.text(), /Agents: +1 of 2 environment\(s\) readable/);
});

test('Azure Agent Evaluator, with every environment removed: its pages stay, and what the installer added there goes', async () => {
  const t = await aeInstall();
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  t.config.agentEvaluator.environments = [];
  t.fabric.calls.length = 0;
  t.dv[ENV].calls.length = 0;
  t.ui.out.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.dv[ENV].calls, removalCalls());
  assert.deepEqual(t.dv[ENV].users, []);
  assert.deepEqual(t.dv[ENV].roles, [], 'the role it created is deleted');
  assert.equal(t.az.transcriptAccess, undefined);
  assert.ok(t.ui.text().includes(`Deleted the "${READ_ROLE}" role in Example`));
  assert.ok(t.ui.text().includes('Removed the application user for the jobs\' managed identity (client ID mi-client) from Example'));
  assert.equal(t.az.powerBi.agentEvaluatorDatasetId, id, 'the model is kept');
  assert.ok(!t.fabric.calls.some((c) => /^(create|update|delete)/.test(c) && c.includes(AE_MODEL)));
  assert.deepEqual(usedBy(t, id), { app: true, viewers: true, rls: true }, 'its pages stay while the module is on, as on Fabric');
  const jobs = jobSettings(t.deployments);
  assert.ok(jobs.modules.includes('agentEvaluator'), 'still ticked');
  assert.deepEqual(jobs.environments, []);
  assert.deepEqual(t.schedules.get(id)?.at(-1), OFF);
  t.powerBi.calls.length = 0;
  await azureRefresh(t.ctx);
  assert.ok(!t.powerBi.calls.includes(`refresh ${id} full`));
});

test('Azure Agent Evaluator, unticked or in demo mode: its model is kept but unused, and its schedule is off', async () => {
  for (const label of ['unticked', 'demo mode']) {
    const t = await aeInstall();
    const ae = t.config.agentEvaluator.model;
    const id = t.az.powerBi.agentEvaluatorDatasetId;
    if (label === 'unticked') t.config.modules.agentEvaluator = false;
    else t.az.sampleData = true;
    t.fabric.calls.length = 0;
    t.powerBi.calls.length = 0;
    t.dv[ENV].calls.length = 0;
    t.ui.out.length = 0;
    assert.equal(await installAzure(t.ctx, { wait: true }), true, label);
    assert.deepEqual(usedBy(t, id), { app: false, viewers: false, rls: false }, label);
    assert.equal(t.powerBi.calls.filter((c) => c === 'updateDatasource gw ds ServicePrincipal').length, 1, `${label}: only the main model is bound`);
    assert.deepEqual(t.schedules.get(id)?.at(-1), OFF, label);
    assert.equal(t.az.powerBi.agentEvaluatorDatasetId, id, `${label}: the model is kept`);
    assert.equal(ae.id, id, label);
    assert.ok(!t.fabric.calls.some((c) => /^(create|update|delete)/.test(c) && c.includes(AE_MODEL)), label);
    assert.ok(!jobSettings(t.deployments).modules.includes('agentEvaluator'), label);
    assert.deepEqual(jobSettings(t.deployments).environments, [], label);
    ae.reload = { since: '2026-01-01T00:00:00.000Z' };
    assert.deepEqual(pendingReloads(t.config), [], `${label}: not owed a reload while unused`);
    delete ae.reload;
    t.ui.out.length = 0;
    await azureStatus(t.ctx);
    azureSummary(t.ctx);
    assert.doesNotMatch(t.ui.text(), /Evaluator:|Agents:/, label);
    t.powerBi.calls.length = 0;
    await azureRefresh(t.ctx);
    assert.ok(!t.powerBi.calls.includes(`refresh ${id} full`), label);
    if (label === 'unticked') {
      assert.deepEqual(t.dv[ENV].calls, removalCalls(), 'unticked, what the installer added goes');
      assert.equal(t.az.transcriptAccess, undefined);
    } else {
      assert.deepEqual(t.dv[ENV].calls, [], 'demo mode leaves Dataverse alone');
      assert.equal(t.az.transcriptAccess.length, 1);
    }
  }
});

test('Azure Agent Evaluator in demo mode keeps the managed identity\'s access for when tenant data is back', async () => {
  const t = await aeInstall();
  t.az.sampleData = true;
  t.dv[ENV].calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.ok(t.ui.text().includes('Demo mode reads no transcripts. The jobs\' managed identity (client ID mi-client) keeps its access in 1 environment for when you switch to your tenant\'s data.'));
  t.az.sampleData = false;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.dv[ENV].calls, [], 'nothing to add back');
  assert.ok(jobSettings(t.deployments).modules.includes('agentEvaluator'));
  assert.equal(t.schedules.get(t.az.powerBi.agentEvaluatorDatasetId)?.at(-1).value.enabled, true);
});

test('Azure Agent Evaluator, ticked again: the recorded model is used again, and the managed identity added back', async () => {
  const t = await aeInstall();
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  t.config.modules.agentEvaluator = false;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.schedules.get(id)?.at(-1), OFF);
  t.config.modules.agentEvaluator = true;
  t.fabric.calls.length = 0;
  t.dv[ENV].calls.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.equal(t.az.powerBi.agentEvaluatorDatasetId, id, 'the recorded model');
  assert.ok(!t.fabric.calls.some((c) => c.startsWith('createSemanticModel')), 'nothing new is created');
  assert.deepEqual(usedBy(t, id), { app: true, viewers: true, rls: true });
  assert.equal(t.schedules.get(id)?.at(-1).value.enabled, true);
  assert.ok(jobSettings(t.deployments).modules.includes('agentEvaluator'));
  assert.deepEqual(t.dv[ENV].calls, ['findAppUser mi-client', 'createAppUser mi-client bu-root', 'findRole Bot Transcript Viewer bu-root', 'assignRole user-2 role-btv', ...readRoleCalls('user-2', 'read-2')]);
  assert.deepEqual(t.dv[ENV].holds('read-2'), ['prvReadconversationtranscript:Global']);
});

test('Azure Agent Evaluator: turning its schedule off ignores a model Power BI no longer has, and says how when it fails', async () => {
  const t = await aeInstall();
  const id = t.az.powerBi.agentEvaluatorDatasetId;
  t.config.modules.agentEvaluator = false;
  t.scheduleErrors.set(id, new HttpError('Not found', { status: 404, method: 'PATCH', url: 'https://x' }));
  t.ui.out.length = 0;
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.deepEqual(t.schedules.get(id)?.at(-1), OFF);
  assert.doesNotMatch(t.ui.text(), /Couldn't turn off the scheduled refresh/);
  t.scheduleErrors.set(id, new HttpError('Server error', { status: 500, method: 'PATCH', url: 'https://x' }));
  assert.equal(await installAzure(t.ctx, { wait: true }), true);
  assert.match(t.ui.text(), new RegExp(`Couldn't turn off the scheduled refresh of ${AE_MODEL}: Server error\\. Turn it off in the model's settings in Power BI\\.`));
});

test('Azure transcript access: from a user an admin added, only the roles the installer gave are taken back, and the role it created deleted', async () => {
  const existing = fakeTranscriptEnvironment({ users: [{ systemuserid: 'admin-made', applicationid: 'MI-CLIENT' }] });
  const t = await aeInstall({ dataverse: { [ENV]: existing } });
  assert.deepEqual(existing.calls, ['findAppUser mi-client', 'findRole Bot Transcript Viewer bu-root', 'assignRole admin-made role-btv', ...readRoleCalls('admin-made')]);
  assert.deepEqual(t.az.transcriptAccess, [{ url: ENV, appId: 'mi-client', name: 'Example', userId: 'admin-made', roleId: 'role-btv', ...readRoleRecord() }]);
  existing.calls.length = 0;
  t.config.agentEvaluator.environments = [];
  assert.equal(await ensureAzureTranscriptAccess(t.ctx), false);
  assert.deepEqual(existing.calls, ['removeRole admin-made read-1', 'deleteRole read-1', 'removeRole admin-made role-btv']);
  assert.deepEqual(existing.users.map((u) => u.systemuserid), ['admin-made'], 'the user is left');
  assert.deepEqual(existing.userRoles['admin-made'], []);
  assert.deepEqual(existing.roles, []);
  assert.equal(t.az.transcriptAccess, undefined);
  assert.ok(t.ui.text().includes(`Deleted the "${READ_ROLE}" role in Example`));
  assert.ok(t.ui.text().includes('Took the Bot Transcript Viewer role away from the jobs\' managed identity (client ID mi-client) in Example'));

  // Roles an admin already took away are fine.
  t.config.agentEvaluator.environments = [{ url: ENV, id: 'env-1', name: 'Example' }];
  await ensureAzureTranscriptAccess(t.ctx);
  existing.userRoles['admin-made'] = [];
  existing.calls.length = 0;
  t.ui.out.length = 0;
  t.config.agentEvaluator.environments = [];
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(existing.calls, ['removeRole admin-made read-2', 'deleteRole read-2', 'removeRole admin-made role-btv']);
  assert.ok(t.ui.text().includes('Took the Bot Transcript Viewer role away'));
  assert.doesNotMatch(t.ui.text(), /Couldn't/);
});

test('Azure transcript access: an admin\'s access with the user they added keeps the user, and the read role is still taken back', async () => {
  // An admin added the managed identity with Bot Transcript Viewer before the installer could, so only the read role is
  // the installer's.
  const existing = fakeTranscriptEnvironment({ users: [{ systemuserid: 'admin-made', applicationid: 'mi-client', _businessunitid_value: 'bu-root' }], userRoles: { 'admin-made': ['role-btv'] } });
  const t = await aeInstall({ dataverse: { [ENV]: existing } });
  assert.deepEqual(existing.calls, ['findAppUser mi-client', 'findRole Bot Transcript Viewer bu-root', ...readRoleCalls('admin-made')]);
  assert.deepEqual(t.az.transcriptAccess, [{ url: ENV, appId: 'mi-client', name: 'Example', userId: 'admin-made', ...readRoleRecord() }]);
  assert.ok(t.ui.text().includes(`Gave the jobs' managed identity the "${READ_ROLE}" role in Example`));
  existing.calls.length = 0;
  t.ui.out.length = 0;
  t.config.agentEvaluator.environments = [];
  assert.equal(await ensureAzureTranscriptAccess(t.ctx), false);
  assert.deepEqual(existing.calls, ['removeRole admin-made read-1', 'deleteRole read-1'], 'Bot Transcript Viewer and the user are the admin\'s');
  assert.deepEqual(existing.userRoles['admin-made'], ['role-btv']);
  assert.equal(t.az.transcriptAccess, undefined);
  const text = t.ui.text();
  assert.ok(text.includes(`Deleted the "${READ_ROLE}" role in Example`));
  assert.ok(text.includes('The jobs\' managed identity (client ID mi-client) is still an application user in Example. It was added outside the installer, so the installer leaves it'));
});

test('Azure transcript access: a role with the install\'s name that someone else has is left alone, and Uninstall leaves it', async () => {
  // Made to look like the installer's, and given to another user, before the install.
  const decoy = { roleid: 'decoy-1', name: READ_ROLE, description: 'Created by the Analytics Hub installer for the Azure install install-1.', bu: 'bu-root', privileges: new Map() };
  const env = fakeTranscriptEnvironment({ roles: [decoy], userRoles: { someone: ['decoy-1'] } });
  const t = await aeInstall({ dataverse: { [ENV]: env } });
  assert.deepEqual(env.calls, ['findAppUser mi-client', 'createAppUser mi-client bu-root', 'findRole Bot Transcript Viewer bu-root', 'assignRole user-1 role-btv', 'roleCopies decoy-1', 'roleHolders decoy-1']);
  assert.deepEqual(env.holds('decoy-1'), [], 'not changed');
  assert.deepEqual(env.userRoles['user-1'], ['role-btv'], 'not given');
  assert.deepEqual(t.az.transcriptAccess, [{ url: ENV, appId: 'mi-client', name: 'Example', userId: 'user-1', createdUser: true, roleId: 'role-btv' }], 'nothing noted of the role');
  assert.deepEqual(t.config.agentEvaluator.environments[0], { url: ENV, id: 'env-1', name: 'Example', access: true, accessAppId: 'mi-client' }, 'checked again on the next run');
  assert.ok(
    t.ui.text().includes(
      `A user or team other than the jobs' managed identity has the "${READ_ROLE}" role in Example, so the installer didn't change it or give it to the jobs' managed identity. It reads only the transcripts shared with it there.`,
    ),
  );

  env.calls.length = 0;
  t.config.agentEvaluator.environments = [];
  assert.equal(await ensureAzureTranscriptAccess(t.ctx), false);
  assert.deepEqual(env.calls, ['removeRole user-1 role-btv', 'disableUser user-1', 'deleteUser user-1', 'getUser user-1'], 'only what the installer added');
  assert.deepEqual(env.roles.map((r) => r.roleid), ['decoy-1']);
  assert.deepEqual(env.userRoles.someone, ['decoy-1']);
  assert.equal(t.az.transcriptAccess, undefined);
});

test('Azure transcript access: a user Dataverse won\'t delete is activated again without its role, and the admin center steps printed', async () => {
  const t = await aeInstall();
  const dv = t.dv[ENV];
  dv.failures.deleteUser = [httpError(400, 'The \'Delete\' method does not support entities of type \'systemuser\'')];
  dv.calls.length = 0;
  t.config.agentEvaluator.environments = [];
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(dv.calls, [...deleteCalls(), 'enableUser user-1']);
  assert.deepEqual(dv.users.map((u) => [u.systemuserid, !!u.isdisabled]), [['user-1', false]], 'not left deactivated');
  assert.deepEqual(dv.userRoles['user-1'], []);
  assert.deepEqual(dv.roles, []);
  assert.equal(t.az.transcriptAccess, undefined, 'said once, then dropped');
  const text = t.ui.text();
  assert.ok(text.includes('Dataverse wouldn\'t delete the application user for the jobs\' managed identity (client ID mi-client) in Example (The \'Delete\' method does not support entities of type \'systemuser\'). It has no role now, so it can\'t read transcripts.'));
  assert.ok(text.includes('A System Administrator can delete it: Power Platform admin center > Manage > Environments > Example > Settings > Users + permissions > Application users > the one with client ID mi-client > Deactivate, then Delete.'));

  // Ticked again, the active user gets the roles back, and only the roles are noted as the installer's.
  t.config.agentEvaluator.environments = [{ url: ENV, id: 'env-1', name: 'Example' }];
  dv.calls.length = 0;
  assert.equal(await ensureAzureTranscriptAccess(t.ctx), true);
  assert.deepEqual(dv.calls, ['findAppUser mi-client', 'findRole Bot Transcript Viewer bu-root', 'assignRole user-1 role-btv', ...readRoleCalls('user-1', 'read-2')]);
  assert.deepEqual(t.az.transcriptAccess, [{ url: ENV, appId: 'mi-client', name: 'Example', userId: 'user-1', roleId: 'role-btv', ...readRoleRecord('read-2') }]);
});

test('Azure transcript access: a user Dataverse won\'t delete or activate again is left deactivated, with both ways out', async () => {
  const t = await aeInstall();
  const dv = t.dv[ENV];
  dv.failures.deleteUser = [httpError(400, 'No delete')];
  dv.failures.enableUser = [httpError(500, 'No enable')];
  dv.calls.length = 0;
  t.config.agentEvaluator.environments = [];
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(dv.calls, [...deleteCalls(), 'enableUser user-1']);
  assert.equal(dv.users[0].isdisabled, true);
  assert.equal(t.az.transcriptAccess, undefined);
  const text = t.ui.text();
  assert.ok(text.includes('Dataverse wouldn\'t delete the application user for the jobs\' managed identity (client ID mi-client) in Example (No delete), or activate it again (No enable), so it\'s deactivated.'));
  assert.ok(text.includes('A System Administrator can delete it (Power Platform admin center > Manage > Environments > Example > Settings > Users + permissions > Application users > the one with client ID mi-client > Delete), or activate it (Activate) before you tick Example again.'));
});

test('Azure transcript access: a user Dataverse only soft-deletes is deleted again, and said to be removed once it\'s gone', async () => {
  for (const softDeletes of [0, 1]) {
    const env = fakeTranscriptEnvironment({ softDeletes });
    const t = await aeInstall({ dataverse: { [ENV]: env } });
    env.calls.length = 0;
    t.ui.out.length = 0;
    t.config.agentEvaluator.environments = [];
    assert.equal(await ensureAzureTranscriptAccess(t.ctx), false);
    assert.deepEqual(env.calls, [...removalCalls(), ...(softDeletes ? ['deleteUser user-1', 'getUser user-1'] : [])], `soft deletes: ${softDeletes}`);
    assert.deepEqual(env.users, [], `soft deletes: ${softDeletes}`);
    assert.equal(t.az.transcriptAccess, undefined);
    let text = t.ui.text();
    assert.ok(text.includes('Removed the application user for the jobs\' managed identity (client ID mi-client) from Example'), `soft deletes: ${softDeletes}`);
    assert.doesNotMatch(text, /soft-deleted|Couldn't/, `soft deletes: ${softDeletes}`);

    // Ticked again, a new user is added, rather than the old one found disabled.
    t.config.agentEvaluator.environments = [{ url: ENV, id: 'env-1', name: 'Example' }];
    env.calls.length = 0;
    t.ui.out.length = 0;
    assert.equal(await ensureAzureTranscriptAccess(t.ctx), true);
    assert.deepEqual(env.calls, ['findAppUser mi-client', 'createAppUser mi-client bu-root', 'findRole Bot Transcript Viewer bu-root', 'assignRole user-2 role-btv', ...readRoleCalls('user-2', 'read-2')], `soft deletes: ${softDeletes}`);
    text = t.ui.text();
    assert.doesNotMatch(text, /is disabled|Enable it/, `soft deletes: ${softDeletes}`);
  }
});

test('Azure transcript access: a user still there after a second delete is left deactivated with no role, and how to delete it for good printed', async () => {
  const env = fakeTranscriptEnvironment({ softDeletes: 2 });
  const t = await aeInstall({ dataverse: { [ENV]: env } });
  env.calls.length = 0;
  t.ui.out.length = 0;
  t.config.modules.agentEvaluator = false;
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(env.calls, [...removalCalls(), 'deleteUser user-1', 'getUser user-1'], 'not activated again: a soft-deleted user can\'t be');
  assert.deepEqual(env.users.map((u) => [u.systemuserid, u.isdisabled, u.deletedstate]), [['user-1', true, 1]]);
  assert.deepEqual(env.userRoles['user-1'], []);
  assert.deepEqual(env.roles, []);
  assert.equal(t.az.transcriptAccess, undefined, 'said once, then dropped');
  assert.equal(t.config.agentEvaluator.environments[0].access, undefined, 'it has no access now');
  const text = t.ui.text();
  assert.doesNotMatch(text, /Removed the application user/);
  assert.ok(text.includes('Dataverse only soft-deleted the application user for the jobs\' managed identity (client ID mi-client) in Example (still there after a second delete). It\'s deactivated with no role, so it can\'t sign in or read transcripts.'));
  assert.ok(text.includes(DELETE_FOR_GOOD));
});

test('Azure transcript access: a soft-deleted user Dataverse won\'t delete again is left deactivated, and how to delete it for good printed', async () => {
  const env = fakeTranscriptEnvironment({ softDeletes: 1 });
  const t = await aeInstall({ dataverse: { [ENV]: env } });
  env.failures.deleteUser = [undefined, httpError(400, 'No delete')].map((e) => /** @type {Error} */ (e));
  env.calls.length = 0;
  t.ui.out.length = 0;
  t.config.agentEvaluator.environments = [];
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(env.calls, [...removalCalls(), 'deleteUser user-1'], 'not activated again');
  assert.deepEqual(env.users.map((u) => [u.systemuserid, u.isdisabled, u.deletedstate]), [['user-1', true, 1]]);
  assert.equal(t.az.transcriptAccess, undefined);
  const text = t.ui.text();
  assert.doesNotMatch(text, /Removed the application user|Dataverse wouldn't delete/);
  assert.ok(text.includes('Dataverse only soft-deleted the application user for the jobs\' managed identity (client ID mi-client) in Example (No delete). It\'s deactivated with no role, so it can\'t sign in or read transcripts.'));
  assert.ok(text.includes(DELETE_FOR_GOOD));
});

test('Azure transcript access: a user that can\'t be read back isn\'t said to be removed, and how to delete it for good is printed', async () => {
  for (const second of [false, true]) {
    const env = fakeTranscriptEnvironment({ softDeletes: second ? 1 : 0 });
    const t = await aeInstall({ dataverse: { [ENV]: env } });
    env.failures.getUser = (second ? [undefined, httpError(500, 'Server error')] : [httpError(500, 'Server error')]).map((e) => /** @type {Error} */ (e));
    env.calls.length = 0;
    t.ui.out.length = 0;
    t.config.agentEvaluator.environments = [];
    await ensureAzureTranscriptAccess(t.ctx);
    const label = second ? 'the second read-back' : 'the first read-back';
    assert.deepEqual(env.calls, [...removalCalls(), ...(second ? ['deleteUser user-1', 'getUser user-1'] : [])], label);
    assert.equal(t.az.transcriptAccess, undefined, label);
    const text = t.ui.text();
    assert.doesNotMatch(text, /Removed the application user/, label);
    assert.ok(
      text.includes('Couldn\'t check that the application user for the jobs\' managed identity (client ID mi-client) is gone from Example (Server error). If it\'s still there, it\'s deactivated with no role, so it can\'t sign in or read transcripts.'),
      label,
    );
    assert.ok(text.includes(DELETE_FOR_GOOD), label);
  }
});

test('Azure transcript access: a role Dataverse won\'t take back is printed for an admin, and the environment still counts as read', async () => {
  const t = await aeInstall();
  const dv = t.dv[ENV];
  dv.failures.removeRole = [httpError(403, 'Forbidden')];
  dv.calls.length = 0;
  t.config.modules.agentEvaluator = false;
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(dv.calls, ['removeRole user-1 read-1'], 'nothing else is removed while it keeps the read role');
  assert.deepEqual(dv.holds('read-1'), ['prvReadconversationtranscript:Global'], 'the role is kept while it\'s held');
  assert.equal(t.az.transcriptAccess, undefined, 'said once, then dropped');
  assert.equal(t.config.agentEvaluator.environments[0].access, true, 'it can still read the environment');
  assert.equal(t.config.agentEvaluator.environments[0].readAll, undefined, 'checked again if ticked again');
  let text = t.ui.text();
  assert.ok(text.includes(`Couldn't take the "${READ_ROLE}" role away from the jobs' managed identity (client ID mi-client) in Example (Forbidden), so it can still read every transcript there.`));
  assert.ok(
    text.includes(
      `A System Administrator can: Power Platform admin center > Manage > Environments > Example > Settings > Users + permissions > Application users > the one with client ID mi-client > Edit security roles, clear "${READ_ROLE}" and Bot Transcript Viewer, and Save. Then Deactivate it, and Delete it. ` +
        `Then delete the role: Power Platform admin center > Manage > Environments > Example > Settings > Users + permissions > Security roles > "${READ_ROLE}" > Delete.`,
    ),
  );

  // Bot Transcript Viewer is taken back after the read role, whose assignment an admin may have taken already.
  const u = await aeInstall();
  const udv = u.dv[ENV];
  udv.failures.removeRole = [httpError(404), httpError(403, 'Forbidden')];
  udv.calls.length = 0;
  u.config.modules.agentEvaluator = false;
  await ensureAzureTranscriptAccess(u.ctx);
  assert.deepEqual(udv.calls, ['removeRole user-1 read-1', 'deleteRole read-1', 'removeRole user-1 role-btv'], 'the user isn\'t deactivated while it keeps a role');
  assert.deepEqual(udv.roles, []);
  assert.equal(u.config.agentEvaluator.environments[0].access, true);
  text = u.ui.text();
  assert.ok(text.includes(`Deleted the "${READ_ROLE}" role in Example`));
  assert.ok(text.includes('Couldn\'t take the Bot Transcript Viewer role away from the jobs\' managed identity (client ID mi-client) in Example (Forbidden), so it can still read transcripts there.'));
  assert.ok(text.includes('Edit security roles, clear Bot Transcript Viewer and Save. Then Deactivate it, and Delete it.'));
});

test('Azure transcript access: a role Dataverse won\'t delete is printed for an admin, and the rest is still removed', async () => {
  const t = await aeInstall();
  const dv = t.dv[ENV];
  dv.failures.deleteRole = [httpError(403, 'Forbidden')];
  dv.calls.length = 0;
  t.config.agentEvaluator.environments = [];
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(dv.calls, removalCalls());
  assert.deepEqual(dv.roles.map((r) => r.roleid), ['read-1'], 'left for an admin');
  assert.deepEqual(dv.users, []);
  assert.equal(t.az.transcriptAccess, undefined, 'said once, then dropped');
  const text = t.ui.text();
  assert.ok(text.includes(`Couldn't delete the "${READ_ROLE}" role in Example (Forbidden). The jobs' managed identity (client ID mi-client) doesn't have it now.`));
  assert.ok(text.includes(`A System Administrator can delete it: Power Platform admin center > Manage > Environments > Example > Settings > Users + permissions > Security roles > "${READ_ROLE}" > Delete.`));
  assert.ok(text.includes('Removed the application user for the jobs\' managed identity (client ID mi-client) from Example'));

  // A role already gone is fine.
  const u = await aeInstall();
  u.dv[ENV].failures.deleteRole = [httpError(404)];
  u.config.agentEvaluator.environments = [];
  await ensureAzureTranscriptAccess(u.ctx);
  assert.ok(u.ui.text().includes(`The "${READ_ROLE}" role in Example is already gone`));
  assert.doesNotMatch(u.ui.text(), /Couldn't/);
});

test('Azure transcript access: access an admin gave is left for them to take back, said once', async () => {
  const blocked = blockedEnvironment();
  const t = await aeInstall({ dataverse: { [ENV]: blocked } });
  blocked.failures.findAppUser = [httpError(403, 'Forbidden')];
  const ui = fakeUi({ answers: [true] });
  t.ctx.ui = ui.ui;
  assert.equal(await ensureAzureTranscriptAccess(t.ctx), true, 'It already has access');
  assert.deepEqual(t.az.transcriptAccess, [{ url: ENV, appId: 'mi-client', name: 'Example' }]);
  assert.equal(t.config.agentEvaluator.environments[0].accessAppId, 'mi-client');
  blocked.calls.length = 0;
  t.config.agentEvaluator.environments = [];
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(blocked.calls, [], 'Dataverse isn\'t asked');
  assert.ok(ui.text().includes('The jobs\' managed identity (client ID mi-client) is still an application user in Example. It was added outside the installer, so the installer leaves it; a System Administrator can remove it: Power Platform admin center > Manage > Environments > Example > Settings > Users + permissions > Application users > the one with client ID mi-client > Deactivate, then Delete.'));
  assert.equal(t.az.transcriptAccess, undefined);
  ui.out.length = 0;
  await ensureAzureTranscriptAccess(t.ctx);
  assert.equal(ui.text(), '', 'only once');
});

test('Azure transcript access: a new managed identity replaces the old one\'s access', async () => {
  const t = await aeInstall();
  t.az.outputs.identityClientId = 'mi-new';
  t.dv[ENV].calls.length = 0;
  assert.equal(await ensureAzureTranscriptAccess(t.ctx), true);
  // The old one's roles and user go first, so the role is created again for the new one.
  assert.deepEqual(t.dv[ENV].calls, [
    ...removalCalls(),
    'findAppUser mi-new', 'createAppUser mi-new bu-root', 'findRole Bot Transcript Viewer bu-root', 'assignRole user-2 role-btv', ...readRoleCalls('user-2', 'read-2'),
  ]);
  assert.deepEqual(t.az.transcriptAccess, [{ url: ENV, appId: 'mi-new', name: 'Example', userId: 'user-2', createdUser: true, roleId: 'role-btv', ...readRoleRecord('read-2') }]);
  assert.equal(t.config.agentEvaluator.environments[0].accessAppId, 'mi-new');
  assert.match(t.dv[ENV].roles[0].description ?? '', /\(client ID mi-new\)/);

  // Access an admin gave the old one is checked again for the new one.
  t.config.agentEvaluator.environments[0].accessAppId = 'mi-old';
  t.dv[ENV].calls.length = 0;
  await ensureAzureTranscriptAccess(t.ctx);
  assert.deepEqual(t.dv[ENV].calls, ['findAppUser mi-new', 'findRole Bot Transcript Viewer bu-root'], 'found with its role');
  assert.equal(t.config.agentEvaluator.environments[0].accessAppId, 'mi-new');
});

test('Azure uninstall takes back what the installer added in each environment, before the managed identity goes', async () => {
  const t = await aeInstall({ environments: [{ url: ENV, id: 'env-1', name: 'Example' }, { url: DEV, id: 'env-2', name: 'Dev' }] });
  assert.equal(t.az.transcriptAccess.length, 2);
  t.dv[ENV].calls.length = 0;
  t.dv[DEV].calls.length = 0;
  t.ui.out.length = 0;
  await azureUninstall(t.ctx);
  for (const url of [ENV, DEV]) {
    assert.deepEqual(t.dv[url].calls, removalCalls(), url);
    assert.deepEqual(t.dv[url].roles, [], url);
  }
  assert.equal(t.az.transcriptAccess, undefined);
  const text = t.ui.text();
  assert.ok(text.includes(`Deleted the "${READ_ROLE}" role in Dev`));
  const removed = text.indexOf('Removed the application user for the jobs\' managed identity (client ID mi-client) from Dev');
  assert.ok(removed >= 0);
  assert.ok(removed < text.search(/Deleted (resource group|\d+ tagged)/), 'before the resource group');

  const none = await aeInstall({ environments: false });
  await azureUninstall(none.ctx);
  assert.deepEqual(Object.keys(none.dv), [], 'nothing to take back');
});

test('Azure transcript access: an install from an earlier version, with only Bot Transcript Viewer, gets the read role on Update', async () => {
  const legacy = fakeTranscriptEnvironment({ users: [{ systemuserid: 'user-1', applicationid: 'mi-client', _businessunitid_value: 'bu-root' }], userRoles: { 'user-1': ['role-btv'] }, transcripts: ['tx-1'] });
  const t = await aeInstall({
    environments: [{ url: ENV, id: 'env-1', name: 'Example', access: true, accessAppId: 'mi-client' }],
    az: { transcriptAccess: [{ url: ENV, appId: 'mi-client', name: 'Example', userId: 'user-1', createdUser: true, roleId: 'role-btv' }] },
    dataverse: { [ENV]: legacy },
  });
  assert.equal(t.ok, true);
  assert.deepEqual(legacy.calls, ['findAppUser mi-client', 'findRole Bot Transcript Viewer bu-root', ...readRoleCalls('user-1')]);
  assert.deepEqual(legacy.holds('read-1'), ['prvReadconversationtranscript:Global']);
  assert.deepEqual(legacy.userRoles['user-1'], ['role-btv', 'read-1']);
  assert.deepEqual(t.az.transcriptAccess, [{ url: ENV, appId: 'mi-client', name: 'Example', userId: 'user-1', createdUser: true, roleId: 'role-btv', ...readRoleRecord() }], 'what it added before is kept');
  assert.equal(t.config.agentEvaluator.environments[0].readAll, true);
  const text = t.ui.text();
  assert.ok(text.includes(`Created the "${READ_ROLE}" role in Example: it reads every Copilot Studio conversation transcript there, and nothing else`));
  assert.ok(text.includes(`Gave the jobs' managed identity the "${READ_ROLE}" role in Example`));
  assert.ok(text.includes('Checked one transcript in Example: the jobs\' managed identity can read it'));

  // Uninstalling takes back all of it.
  legacy.calls.length = 0;
  await azureUninstall(t.ctx);
  assert.deepEqual(legacy.calls, removalCalls());
});

test('Azure plan: the read role is listed in each chosen environment, and what the installer removes', async () => {
  const t = await aeInstall({ environments: [{ url: ENV, id: 'env-1', name: 'Example' }, { url: DEV, id: 'env-2', name: 'Dev' }], dataverse: { [DEV]: blockedEnvironment() } });
  const rows = () => azurePlanReview(t.ctx).creates.filter((r) => r.kind.startsWith('Dataverse'));
  const user = 'With the Bot Transcript Viewer role and the transcript reader role, so the jobs read the environment\'s Copilot Studio transcripts. A System Administrator adds it if you can\'t.';
  const role = 'Reads every Copilot Studio conversation transcript there, and nothing else. Created for this install, given to the jobs\' managed identity, and deleted on uninstall.';
  assert.deepEqual(rows(), [
    { kind: 'Dataverse application user', name: 'Jobs\' managed identity in Example', isNew: false, detail: user },
    { kind: 'Dataverse application user', name: 'Jobs\' managed identity in Dev', isNew: true, detail: user },
    { kind: 'Dataverse security role', name: `${READ_ROLE} in Example`, isNew: false, detail: role },
    { kind: 'Dataverse security role', name: `${READ_ROLE} in Dev`, isNew: true, detail: role },
  ]);
  assert.deepEqual(azurePlanReview(t.ctx).grants.filter((g) => g.what.startsWith('Dataverse')), [
    {
      who: 'Collector managed identity',
      what: 'Dataverse application user with the Bot Transcript Viewer role and a role that reads every transcript',
      where: 'Dev',
      detail: 'So the jobs read every Copilot Studio transcript. Needs a System Administrator of each environment.',
    },
  ]);

  // An admin's access that reads every transcript gets no role from the installer.
  Object.assign(t.config.agentEvaluator.environments[1], { access: true, readAll: true, accessAppId: 'mi-client' });
  assert.deepEqual(rows().map((r) => `${r.name} ${r.isNew}`), ['Jobs\' managed identity in Example false', 'Jobs\' managed identity in Dev false', `${READ_ROLE} in Example false`]);
  assert.deepEqual(azurePlanReview(t.ctx).grants.filter((g) => g.what.startsWith('Dataverse')), []);

  // Unticked, what the installer added there is listed for removal.
  t.config.agentEvaluator.environments = [{ url: DEV, id: 'env-2', name: 'Dev' }];
  assert.deepEqual(rows(), [
    { kind: 'Dataverse application user', name: 'Jobs\' managed identity in Dev', isNew: true, detail: user },
    { kind: 'Dataverse security role', name: `${READ_ROLE} in Dev`, isNew: true, detail: role },
    { kind: 'Dataverse application user', name: 'Jobs\' managed identity in Example', isNew: false, detail: 'No longer chosen, so the installer deletes the application user it created.' },
    { kind: 'Dataverse security role', name: `${READ_ROLE} in Example`, isNew: false, detail: 'No longer chosen, so the installer takes it away and deletes the role it created.' },
  ]);
});

test('Azure status shows what the jobs last read in each environment', async () => {
  const t = await aeInstall({ environments: [{ url: ENV, id: 'env-1', name: 'Example' }, { url: DEV, id: 'env-2', name: 'Dev' }], dataverse: { [DEV]: blockedEnvironment() } });
  t.powerBi.answers.push({ results: [{ tables: [{ rows: [
    { 'Evaluator Status[RunAt]': '2026-01-02T03:04:05Z', 'Evaluator Status[Environment]': 'Example', 'Evaluator Status[EnvironmentUrl]': ENV, 'Evaluator Status[Status]': 'Read' },
    { 'Evaluator Status[RunAt]': '2026-01-02T03:04:05Z', 'Evaluator Status[Environment]': 'Dev', 'Evaluator Status[EnvironmentUrl]': DEV, 'Evaluator Status[Status]': 'Skipped', 'Evaluator Status[Reason]': '403 Forbidden' },
  ] }] }] });
  t.ui.out.length = 0;
  await azureStatus(t.ctx);
  const text = t.ui.text();
  assert.match(text, /Agents: +1 of 2 environment\(s\) readable/);
  assert.ok(text.includes('Last read:      2026-01-02T03:04:05Z'));
  assert.ok(text.includes('  Example: Read'));
  assert.match(text, /  Dev: Skipped.*403 Forbidden/);

  t.powerBi.answers.push({ results: [{ tables: [{ rows: [] }] }] });
  t.ui.out.length = 0;
  await azureStatus(t.ctx);
  assert.ok(t.ui.text().includes('The jobs haven\'t read any transcripts yet.'));
});

/** The Agent Evaluator model as deployed on Azure, with org-scoped access so it reads the access tables too. */
const azureEvaluatorModel = () =>
  buildAgentEvaluatorModel(loadTemplateModel(/** @type {string} */ (realSources().agentEvaluatorModelFile)), { server: SERVER, database: DATABASE, access: { orgAttribute: 'department' } }).model;

/** @param {any} e */
const mText = (e) => (Array.isArray(e) ? e.join('\n') : String(e ?? ''));

/** The tables Azure SQL has: the migrations' and the ones the jobs create when they first publish. */
function azureSqlTables() {
  const dir = join(REPO, 'azure', 'sql', 'migrations');
  const tables = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/CREATE TABLE dbo\.(\w+)/g)) tables.add(m[1].toLowerCase());
  }
  for (const m of readFileSync(join(REPO, 'azure', 'jobs', 'valuelens_jobs', 'publish.py'), 'utf8').matchAll(/Target\("(\w+)"/g)) tables.add(m[1].toLowerCase());
  return tables;
}

test('Azure Agent Evaluator model: every table it reads is in Azure SQL, apart from one it has a fallback for', () => {
  const model = azureEvaluatorModel();
  const tables = azureSqlTables();
  const m = [...(model.expressions ?? []).map((e) => mText(e.expression)), ...model.tables.flatMap((tb) => (tb.partitions ?? []).map((p) => mText(p.source?.expression)))].join('\n');
  const reads = new Set([...m.matchAll(/FabricTable\("(\w+)"\)/g)].map((r) => r[1].toLowerCase()));
  for (const t of ['agent_sessions', 'agent_turns', 'agent_errors', 'agent_subagents', 'agent_performance', 'evaluator_status', 'copilot_org_data', 'access_scope', 'access_people']) {
    assert.ok(reads.has(t), `reads ${t}`);
  }
  assert.deepEqual([...reads].filter((t) => !tables.has(t)), ['agent_variables'], 'Agent Variables is the only table Azure SQL lacks');
  assert.match(m, /try FabricTable\("agent_variables"\) otherwise/, 'and it reads as empty without it');
  // Credit consumption: a direct export table is optional, and the Studio tables it falls back to are in Azure SQL.
  assert.match(m, /try FabricTable\("credit_consumption_" & name\) otherwise null/);
  for (const t of ['studio_agent', 'studio_user', 'studio_tenant_daily']) {
    assert.ok(m.includes(`"${t}"`), `reads ${t}`);
    assert.ok(tables.has(t), `${t} is in Azure SQL`);
  }
});

test("Azure Agent Evaluator model: the transcript tables' columns are in Azure SQL, or the template adds them", () => {
  const model = azureEvaluatorModel();
  const sql = readFileSync(join(REPO, 'azure', 'sql', 'migrations', 'V008__agent_evaluator.sql'), 'utf8');
  /** @param {string} table */
  const sqlColumns = (table) => {
    const body = new RegExp(`CREATE TABLE dbo\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1];
    assert.ok(body, `V008 creates ${table}`);
    return new Set(body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--') && !/^(CONSTRAINT|PRIMARY|INDEX)\b/i.test(l)).map((l) => l.replace(/^\[?(\w+)\]?.*$/, '$1').toLowerCase()));
  };
  /** @type {[string, string, string[]][]} The model's table, the Azure SQL table, and the columns its M adds itself. */
  const pairs = [
    ['Agent Sessions', 'agent_sessions', ['Org Join Key']],
    ['Agent Turns', 'agent_turns', ['topic_derived', 'role_inferred', 'role_mismatch']],
    ['Agent Errors', 'agent_errors', []],
    ['Agent Sub-Agent Calls', 'agent_subagents', []],
    ['Agent Performance', 'agent_performance', ['InteractionDate', 'weekstart']],
    ['Evaluator Status', 'evaluator_status', []],
  ];
  for (const [name, table, added] of pairs) {
    const tb = model.tables.find((x) => x.name === name);
    assert.ok(tb, name);
    const columns = new Set(sqlColumns(table));
    const loaded = (tb.columns ?? []).filter((c) => c.type !== 'calculated' && c.sourceColumn).map((c) => /** @type {string} */ (c.sourceColumn));
    assert.ok(loaded.length, name);
    assert.deepEqual(loaded.filter((c) => !columns.has(c.toLowerCase())), added, name);
    const partitions = (tb.partitions ?? []).map((p) => mText(p.source?.expression)).join('\n');
    for (const c of added) assert.ok(partitions.includes(`"${c}"`), `${name}'s M adds ${c}`);
  }
});
