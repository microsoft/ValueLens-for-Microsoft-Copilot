// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODULES, notebooksFor, OPTIONAL_MODULES } from '../src/catalog.js';
import { TRANSCRIPT_ROLE } from '../src/clients/dataverse.js';
import { AGENT_EVALUATOR_MODEL_NAME, CONFIG_VERSION, emptyConfig, loadConfig } from '../src/config.js';
import { agentEvaluatorSummary, ensureAgentEvaluatorModel, ensureTranscriptAccess, grantTranscriptAccess, planAgentEvaluator } from '../src/steps/agent-evaluator.js';
import { appModels, pagesChange } from '../src/steps/app.js';
import { agentEvaluatorModelDeployed, agentEvaluatorOn, ensureNotebooks, ENVIRONMENTS_FIND, notebookSettings, pipelineSignature } from '../src/steps/fabric.js';
import { ensureModelConnection, ensureSemanticModel } from '../src/steps/model.js';
import { buildAgentEvaluatorModel, loadTemplateModel } from '../src/transform/model.js';
import { cellText, findAssignmentCell, MARKER, prepareNotebook } from '../src/transform/notebook.js';
import { AGENT_EVALUATOR_ACTIVITY, AGENT_EVALUATOR_REFRESH_ACTIVITY, buildPipeline, findActivity, TRANSCRIPT_LOOKBACK_DAYS } from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

const PROD = 'https://contoso.crm.dynamics.com';
const DEV = 'https://contoso-dev.crm4.dynamics.com';

/**
 * One Dataverse environment: its application users, business units and roles.
 * @param {{ bu?: string | null, role?: string | null }} [o]
 */
function fakeEnvironment(o = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** @type {{ systemuserid: string, applicationid: string, isdisabled?: boolean, _businessunitid_value?: string }[]} */
  const users = [];
  /** @type {Record<string, string[]>} */
  const userRoles = {};
  const bu = o.bu === undefined ? 'bu-root' : o.bu;
  const role = o.role === undefined ? 'ROLE-1' : o.role;
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const api = {
    /** @param {string} appId */
    findAppUser: async (appId) => {
      calls.push('findAppUser');
      fail('findAppUser');
      return users.find((u) => u.applicationid === appId);
    },
    rootBusinessUnit: async () => bu ?? undefined,
    /** @param {string} appId @param {string} businessUnitId */
    createAppUser: async (appId, businessUnitId) => {
      calls.push(`createAppUser ${appId} ${businessUnitId}`);
      fail('createAppUser');
      const user = { systemuserid: `user-${users.length + 1}`, applicationid: appId, _businessunitid_value: businessUnitId };
      users.push(user);
      return user.systemuserid;
    },
    /** @param {string} name @param {string} businessUnitId */
    findRole: async (name, businessUnitId) => {
      calls.push(`findRole ${name} ${businessUnitId}`);
      return role ?? undefined;
    },
    /** @param {string} userId */
    userRoleIds: async (userId) => [...(userRoles[userId] ?? [])],
    /** @param {string} userId @param {string} roleId */
    assignRole: async (userId, roleId) => {
      calls.push(`assignRole ${userId} ${roleId}`);
      (userRoles[userId] ??= []).push(roleId);
      return null;
    },
  };
  return { api, calls, failures, users, userRoles };
}

/** @param {{ answers?: any[], yes?: boolean, instances?: any[] | Error }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const powerBi = fakePowerBi();
  const ui = fakeUi({ answers: o.answers, yes: o.yes });
  /** @type {Record<string, ReturnType<typeof fakeEnvironment>>} */
  const envs = {};
  /** @type {string[]} */
  const discoveryCalls = [];
  const discovery = {
    instances: async () => {
      discoveryCalls.push('instances');
      if (o.instances instanceof Error) throw o.instances;
      return o.instances ?? [];
    },
  };
  const dataverse = (/** @type {string} */ url) => (envs[url] ??= fakeEnvironment()).api;
  const config = emptyConfig();
  config.semanticModel.enabled = true;
  config.modules.agentEvaluator = true;
  config.app.displayName = 'ValueLens Data Collector';
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, graph: graph.api, powerBi: powerBi.api, discovery, dataverse, config });
  return { ...made, fabric, graph, powerBi, ui, envs, discoveryCalls };
}

const instance = (/** @type {string} */ url, /** @type {string} */ name, /** @type {any} */ extra = {}) => ({
  Id: `id-${name}`,
  EnvironmentId: `env-${name}`,
  FriendlyName: name,
  UniqueName: name.toLowerCase(),
  Url: `${url}/`,
  State: 0,
  IsUserSysAdmin: true,
  ...extra,
});

const ids = {
  auditIngester: 'nb-audit',
  licensedUsers: 'nb-users',
  processor: 'nb-processor',
  orgData: 'nb-org',
  refreshModel: 'nb-refresh',
  agentTranscripts: 'nb-ae',
};
const modules = { orgData: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: true };
/** @param {any} doc */
const names = (doc) => doc.properties.activities.map((/** @type {any} */ a) => a.name);

test('catalog: the Agent Evaluator is optional, off by default, and its notebook needs a readable environment', () => {
  assert.ok(OPTIONAL_MODULES.includes('agentEvaluator'));
  assert.equal(MODULES.agentEvaluator.defaultOn, false);
  assert.equal(emptyConfig().modules.agentEvaluator, false);
  const keys = (/** @type {any} */ opts) => notebooksFor(modules, opts).map((n) => n.key);
  assert.ok(!keys({}).includes('agentTranscripts'));
  assert.ok(keys({ dataverse: true }).includes('agentTranscripts'));
  assert.ok(!notebooksFor({ ...modules, agentEvaluator: false }, { dataverse: true }).some((n) => n.key === 'agentTranscripts'));
});

test('transcript notebook: Dataverse, merge, every chosen environment, the app\'s credentials and the UPN lookup', () => {
  const t = setup();
  t.config.agentEvaluator.environments = [
    { url: PROD, name: 'Contoso', access: true },
    { url: DEV, name: "Dev\nO'Neil" },
  ];
  const info = /** @type {any} */ (notebooksFor(t.config.modules, { dataverse: true }).find((n) => n.key === 'agentTranscripts'));
  const source = realSources().notebooks.agentTranscripts;
  assert.equal(source.cells.map(cellText).filter((/** @type {string} */ s) => s.includes(ENVIRONMENTS_FIND)).length, 1, 'the shipped environment list is still there');
  const nb = prepareNotebook(source, notebookSettings(t.ctx, info));
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, /^SOURCE_MODE\s*= 'dataverse'/m);
  assert.match(all, /^WRITE_MODE\s*= 'merge'/m);
  assert.match(all, /^RAW_TABLE\s*= ''/m);
  assert.match(all, /^TENANT_ID\s*= 'tenant-1'/m);
  assert.match(all, /^CLIENT_ID\s*= 'app-1'/m);
  assert.match(all, /getSecret\('https:\/\/kv-test\.vault\.azure\.net\/'/);
  assert.ok(all.includes(`DATAVERSE_URLS = [  # ${MARKER}\n    '${PROD}',  # Contoso\n    '${DEV}',  # Dev O'Neil\n]`), 'both environments, the one still waiting for access included');
  const params = findAssignmentCell(nb, 'LOOKBACK_DAYS');
  assert.ok(/** @type {any} */ (nb.cells[params]).metadata.tags.includes('parameters'));
  assert.ok(nb.cells.some((/** @type {any} */ c) => c.id === 'valuelens-upn-code'));
  assert.match(all, /^RESOLVE_UPNS\s*= True/m);
  assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, 'lh-1');
});

test('pipeline: transcripts run alongside the audit load, then refresh their own model', () => {
  const doc = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules, semanticModelId: 'model-1', agentTranscripts: true, agentEvaluatorModelId: 'ae-1' });
  const run = findActivity(doc.properties.activities, AGENT_EVALUATOR_ACTIVITY);
  assert.deepEqual(run.dependsOn, []);
  assert.equal(run.typeProperties.notebookId, 'nb-ae');
  assert.equal(run.policy.retry, 1);
  const days = run.typeProperties.parameters.LOOKBACK_DAYS;
  assert.equal(days.type, 'int');
  assert.equal(days.value.type, 'Expression');
  assert.match(days.value.value, new RegExp(`BackfillDays, ${TRANSCRIPT_LOOKBACK_DAYS}\\)$`));

  const refresh = findActivity(doc.properties.activities, AGENT_EVALUATOR_REFRESH_ACTIVITY);
  assert.deepEqual(refresh.dependsOn, [
    { activity: AGENT_EVALUATOR_ACTIVITY, dependencyConditions: ['Succeeded'] },
    { activity: 'Conditionally_Run_Org_Data', dependencyConditions: ['Completed'] },
  ]);
  assert.equal(refresh.typeProperties.parameters.SEMANTIC_MODEL_ID.value, 'ae-1');
  assert.equal(refresh.typeProperties.parameters.WRITE_MODE.value, 'merge');
  assert.match(doc.properties.description, /Agent Evaluator reads Copilot Studio transcripts alongside and refreshes its model/);

  const noModel = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules, agentTranscripts: true });
  assert.ok(names(noModel).includes(AGENT_EVALUATOR_ACTIVITY));
  assert.ok(!names(noModel).includes(AGENT_EVALUATOR_REFRESH_ACTIVITY));

  const { agentTranscripts, ...rest } = ids;
  const waiting = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: rest, modules, agentEvaluatorModelId: 'ae-1' });
  assert.ok(!names(waiting).some((/** @type {string} */ n) => n.includes('Agent_Evaluator')), 'no readable environment yet');
  assert.throws(() => buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: rest, modules, agentTranscripts: true }), /transcript notebook/);
});

test('switches: on once an environment is readable; the model only counts once bound', () => {
  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1', bound: true });
  config.modules.agentEvaluator = true;
  config.agentEvaluator.environments = [{ url: PROD }];
  assert.equal(agentEvaluatorOn(config), false);
  config.agentEvaluator.environments[0].access = true;
  assert.equal(agentEvaluatorOn(config), true);
  Object.assign(config.agentEvaluator.model, { id: 'ae-1' });
  assert.equal(agentEvaluatorModelDeployed(config), false);
  config.agentEvaluator.model.bound = true;
  assert.equal(agentEvaluatorModelDeployed(config), true);
  assert.equal(pipelineSignature(config), 'core,orgData,agentEvaluator;model=model-1;agentEvaluator;ae=ae-1');
  config.modules.agentEvaluator = false;
  assert.equal(agentEvaluatorOn(config), false);
  assert.equal(pipelineSignature(config), 'core,orgData;model=model-1');
});

test('plan: lists enabled environments by name, keeps earlier choices and access, and flags non-admins', async () => {
  const t = setup({
    instances: [
      instance(PROD, 'Contoso'),
      instance(DEV, 'Contoso Dev', { IsUserSysAdmin: false }),
      instance('https://old.crm.dynamics.com', 'Disabled', { State: 1 }),
    ],
  });
  t.config.agentEvaluator.environments = [
    { url: PROD, access: true },
    { url: 'https://gone.crm.dynamics.com', name: 'Gone' },
  ];
  /** @type {any[]} */
  let choices = [];
  t.ui.ui.checkbox = /** @type {any} */ (async (/** @type {string} */ _m, /** @type {any[]} */ c) => {
    choices = c;
    return c.filter((ch) => ch.checked).map((ch) => ch.value);
  });
  await planAgentEvaluator(t.ctx);
  assert.deepEqual(choices.map((ch) => [ch.name, ch.checked]), [
    ['Contoso (contoso.crm.dynamics.com)', true],
    ['Contoso Dev (contoso-dev.crm4.dynamics.com)', false],
    ['Gone (gone.crm.dynamics.com, not in your list)', true],
  ]);
  assert.match(choices[1].description, /admin adds the app/);
  assert.deepEqual(t.config.agentEvaluator.environments, [
    { url: PROD, id: 'env-Contoso', name: 'Contoso', access: true },
    { url: 'https://gone.crm.dynamics.com', id: undefined, name: 'Gone' },
  ]);

  const picked = setup({ instances: [instance(PROD, 'Contoso'), instance(DEV, 'Contoso Dev')], answers: [[DEV]] });
  picked.config.agentEvaluator.environments = [{ url: PROD, access: true }];
  await planAgentEvaluator(picked.ctx);
  assert.deepEqual(picked.config.agentEvaluator.environments, [{ url: DEV, id: 'env-Contoso Dev', name: 'Contoso Dev' }]);

  const none = setup({ instances: [instance(PROD, 'Contoso')], answers: [[]] });
  await planAgentEvaluator(none.ctx);
  assert.deepEqual(none.config.agentEvaluator.environments, []);
  assert.match(none.ui.text(), /No environments chosen/);
});

test('plan: without discovery, environment URLs are typed in and checked', async () => {
  const t = setup({ instances: httpError(401, 'Unauthorized'), answers: [`${PROD}/main.aspx, ${DEV}`] });
  await planAgentEvaluator(t.ctx);
  assert.match(t.ui.text(), /Couldn't list your Power Platform environments \(Unauthorized\)/);
  assert.deepEqual(t.config.agentEvaluator.environments, [{ url: PROD }, { url: DEV }]);

  const again = setup({ instances: [], yes: true });
  again.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso', access: true }];
  await planAgentEvaluator(again.ctx);
  assert.deepEqual(again.config.agentEvaluator.environments, [{ url: PROD, name: 'Contoso', access: true }], 'the default is what was chosen before');

  const bad = setup({ answers: ['http://contoso.crm.dynamics.com'] });
  await assert.rejects(planAgentEvaluator(bad.ctx), /isn't an https URL/);
});

test('access: the app is added with the Bot Transcript Viewer role once', async () => {
  const env = fakeEnvironment();
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (env.api), 'app-1'), 'added');
  assert.deepEqual(env.calls, ['findAppUser', 'createAppUser app-1 bu-root', `findRole ${TRANSCRIPT_ROLE} bu-root`, 'assignRole user-1 ROLE-1']);
  env.calls.length = 0;
  env.userRoles['user-1'] = ['role-1'];
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (env.api), 'app-1'), 'ok', 'role IDs compare without case');
  assert.ok(!env.calls.some((c) => c.startsWith('assignRole')));

  const existing = fakeEnvironment();
  existing.users.push({ systemuserid: 'u-9', applicationid: 'app-1', _businessunitid_value: 'bu-root' });
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (existing.api), 'app-1'), 'added');
  assert.deepEqual(existing.calls.slice(-1), ['assignRole u-9 ROLE-1']);

  const disabled = fakeEnvironment();
  disabled.users.push({ systemuserid: 'u-1', applicationid: 'app-1', isdisabled: true });
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (disabled.api), 'app-1'), 'disabled');

  const noStudio = fakeEnvironment({ role: null });
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (noStudio.api), 'app-1'), 'no-role');

  const noBu = fakeEnvironment({ bu: null });
  await assert.rejects(grantTranscriptAccess(/** @type {any} */ (noBu.api), 'app-1'), /root business unit/);
});

test('access: each environment is set up; without rights the steps are shown and the rest carry on', async () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso' }, { url: DEV, name: 'Dev' }, { url: 'https://ok.crm.dynamics.com', access: true }];
  t.envs[DEV] = fakeEnvironment();
  t.envs[DEV].failures.findAppUser = [httpError(403, 'Forbidden')];
  assert.equal(await ensureTranscriptAccess(t.ctx), true);
  assert.deepEqual(t.config.agentEvaluator.environments.map((e) => !!e.access), [true, false, true]);
  const text = t.ui.text();
  assert.match(text, new RegExp(`Gave ValueLens Data Collector the ${TRANSCRIPT_ROLE} role in Contoso`));
  assert.match(text, /can't add ValueLens Data Collector to Dev/);
  assert.match(text, /New app user\. Pick ValueLens Data Collector \(app-1\)/);
  assert.equal(t.envs['https://ok.crm.dynamics.com'], undefined, 'environments with access are left alone');

  const told = setup({ answers: [true] });
  told.config.agentEvaluator.environments = [{ url: DEV }];
  told.envs[DEV] = fakeEnvironment();
  told.envs[DEV].failures.findAppUser = [httpError(401, 'Unauthorized')];
  assert.equal(await ensureTranscriptAccess(told.ctx), true, 'the user says an admin already added it');
  assert.equal(told.config.agentEvaluator.environments[0].access, true);

  const unattended = setup({ yes: true });
  unattended.config.agentEvaluator.environments = [{ url: DEV }];
  unattended.envs[DEV] = fakeEnvironment();
  unattended.envs[DEV].failures.findAppUser = [httpError(403, 'Forbidden')];
  assert.equal(await ensureTranscriptAccess(unattended.ctx), false);
  assert.match(unattended.ui.text(), /isn't deployed\. Run the installer again once it can/);

  const flaky = setup();
  flaky.config.agentEvaluator.environments = [{ url: DEV }];
  flaky.envs[DEV] = fakeEnvironment();
  flaky.envs[DEV].failures.findAppUser = [httpError(500, 'Boom')];
  assert.equal(await ensureTranscriptAccess(flaky.ctx), false);
  assert.match(flaky.ui.text(), /Couldn't set up ValueLens Data Collector in .* \(Boom\)/);

  const broken = setup();
  broken.config.agentEvaluator.environments = [{ url: DEV }];
  broken.envs[DEV] = fakeEnvironment();
  broken.envs[DEV].failures.findAppUser = [new TypeError('bug')];
  await assert.rejects(ensureTranscriptAccess(broken.ctx), /bug/);

  const noStudio = setup();
  noStudio.config.agentEvaluator.environments = [{ url: DEV }];
  noStudio.envs[DEV] = fakeEnvironment({ role: null });
  assert.equal(await ensureTranscriptAccess(noStudio.ctx), false);
  assert.match(noStudio.ui.text(), /has no Bot Transcript Viewer role/);
});

test('notebooks: the transcript notebook is pushed again when the environments change', async () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, access: true }];
  await ensureNotebooks(t.ctx);
  assert.ok(t.fabric.calls.includes('createNotebook AgentEval_Transcript_Parser'));
  assert.equal(t.config.agentEvaluator.deployedUrls, PROD);
  const item = /** @type {any} */ (t.fabric.items.find((i) => i.displayName === 'AgentEval_Transcript_Parser'));
  assert.equal(t.config.fabric.notebooks.agentTranscripts, item.id);

  t.fabric.calls.length = 0;
  await ensureNotebooks(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'nothing to do on a re-run');

  t.config.agentEvaluator.environments.push({ url: DEV });
  await ensureNotebooks(t.ctx);
  assert.deepEqual(t.fabric.calls, ['updateNotebook AgentEval_Transcript_Parser']);
  assert.equal(t.config.agentEvaluator.deployedUrls, `${PROD},${DEV}`);

  const waiting = setup();
  waiting.config.agentEvaluator.environments = [{ url: PROD }];
  await ensureNotebooks(waiting.ctx);
  assert.ok(!waiting.fabric.calls.some((c) => c.includes('AgentEval')), 'not until an environment is readable');
});

test('model: Fabric mode, offline sources stubbed, so only the Lakehouse is read', () => {
  const file = /** @type {string} */ (realSources().agentEvaluatorModelFile);
  assert.ok(file, 'the checkout has the Agent Evaluator template');
  const bim = buildAgentEvaluatorModel(loadTemplateModel(file), { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' });
  const expr = (/** @type {string} */ n) => {
    const e = /** @type {any} */ (bim.model.expressions?.find((x) => x.name === n));
    return Array.isArray(e.expression) ? e.expression.join('\n') : String(e.expression);
  };
  assert.ok(expr('Source Mode').startsWith('"Fabric" meta ['));
  assert.ok(expr('Fabric SQL Endpoint').startsWith('"abc.datawarehouse.fabric.microsoft.com" meta ['));
  assert.ok(expr('Lakehouse Name').startsWith('"ValueLens" meta ['));
  const text = JSON.stringify(bim.model);
  for (const fn of ['CommonDataService.Database', 'File.Contents', 'Folder.Files', 'SharePoint.Files', 'Web.Contents']) assert.ok(!text.includes(fn), fn);
  assert.ok(text.includes('Sql.Database'));
});

/** @param {ReturnType<typeof setup>} t */
async function withConnection(t) {
  await ensureSemanticModel(t.ctx);
  await ensureModelConnection(t.ctx);
  t.fabric.calls.length = 0;
}

test('model: deployed and bound through the ValueLens connection; a new connection means binding again', async () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, access: true }];
  await withConnection(t);
  await ensureAgentEvaluatorModel(t.ctx);
  const am = t.config.agentEvaluator.model;
  const conn = t.config.semanticModel.connectionId;
  assert.deepEqual(t.fabric.calls, [`createSemanticModel ${AGENT_EVALUATOR_MODEL_NAME}`, `bindConnection ${AGENT_EVALUATOR_MODEL_NAME} ${conn} abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
  assert.equal(am.bound, true);

  t.fabric.calls.length = 0;
  await ensureAgentEvaluatorModel(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'nothing to do on a re-run');

  t.fabric.connections.length = 0;
  await ensureModelConnection(t.ctx);
  assert.equal(am.bound, false);
  t.fabric.calls.length = 0;
  await ensureAgentEvaluatorModel(t.ctx);
  assert.deepEqual(t.fabric.calls, [`bindConnection ${AGENT_EVALUATOR_MODEL_NAME} ${t.config.semanticModel.connectionId} abc.datawarehouse.fabric.microsoft.com;ValueLens`]);
});

test('app: built with the ae alias once the Agent Evaluator model is bound', () => {
  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-1', bound: true });
  config.modules.agentEvaluator = true;
  Object.assign(config.agentEvaluator.model, { id: 'ae-1', bound: true });
  assert.deepEqual(appModels(config), ['vl', 'ae']);
  config.modules.consumption = true;
  Object.assign(config.consumption.model, { id: 'cc-1', bound: true });
  assert.deepEqual(appModels(config), ['vl', 'cc', 'ae']);

  assert.equal(pagesChange(['vl'], ['vl', 'cc', 'ae']), 'add the credit consumption and agent evaluation pages');
  assert.equal(pagesChange(['vl', 'cc'], ['vl', 'ae']), 'add the agent evaluation pages and remove the credit consumption pages');
  assert.equal(pagesChange(['vl', 'ae'], ['vl']), 'remove the agent evaluation pages');
});

test('summary: readable environments, those waiting for an admin, and the model', () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso', access: true }, { url: DEV }];
  Object.assign(t.config.agentEvaluator.model, { id: 'ae-1', bound: true });
  agentEvaluatorSummary(t.ctx);
  const text = t.ui.text();
  assert.match(text, /Contoso/);
  assert.match(text, /contoso-dev\.crm4\.dynamics\.com.*waiting for ValueLens Data Collector to be added with Bot Transcript Viewer/);
  assert.match(text, /datasets\/ae-1/);
  assert.match(text, /fill after the pipeline's first run/);
});

test('install record: older records gain the Agent Evaluator defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-cfg-'));
  try {
    const file = join(dir, 'valuelens-install.json');
    writeFileSync(file, JSON.stringify({ version: CONFIG_VERSION, modules: { orgData: true } }));
    const { config } = loadConfig(file);
    assert.equal(config.modules.agentEvaluator, false);
    assert.deepEqual(config.agentEvaluator.environments, []);
    assert.equal(config.agentEvaluator.model.name, AGENT_EVALUATOR_MODEL_NAME);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
