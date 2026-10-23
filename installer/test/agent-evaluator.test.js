// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODULES, notebooksFor, OPTIONAL_MODULES } from '../src/catalog.js';
import { TRANSCRIPT_ROLE } from '../src/clients/dataverse.js';
import { AGENT_EVALUATOR_MODEL_NAME, CONFIG_VERSION, emptyConfig, loadConfig } from '../src/config.js';
import {
  addTranscriptReader,
  agentEvaluatorSummary,
  appReadRole,
  ensureAgentEvaluatorModel,
  ensureTranscriptAccess,
  environmentsWithAgents,
  fabricReadRoleReview,
  fabricReadRoleWanted,
  grantTranscriptAccess,
  planAgentEvaluator,
  readRole,
  removeFabricReadRoles,
} from '../src/steps/agent-evaluator.js';
import { appModels, pagesChange } from '../src/steps/app.js';
import { agentEvaluatorModelDeployed, agentEvaluatorOn, ensureNotebooks, ENVIRONMENTS_FIND, notebookSettings, pipelineSignature } from '../src/steps/fabric.js';
import { ensureModelConnection, ensureSemanticModel } from '../src/steps/model.js';
import { buildAgentEvaluatorModel, loadTemplateModel } from '../src/transform/model.js';
import { cellText, findAssignmentCell, MARKER, prepareNotebook } from '../src/transform/notebook.js';
import { AGENT_EVALUATOR_ACTIVITY, AGENT_EVALUATOR_REFRESH_ACTIVITY, buildPipeline, findActivity, TRANSCRIPT_BACKFILL_DAYS, TRANSCRIPT_LOOKBACK_DAYS } from '../src/transform/pipeline.js';
import { fakeCtx, fakeFabric, fakeGraph, fakePowerBi, fakeRoleStore, fakeUi, httpError, PLATFORM_PRIVILEGES, realSources } from './fakes.js';

const PROD = 'https://contoso.crm.dynamics.com';
const DEV = 'https://contoso-dev.crm4.dynamics.com';

/**
 * One Dataverse environment: its application users, business units and roles. Its roles are a fakeRoleStore's, with Bot
 * Transcript Viewer as ROLE-1.
 * @param {{ bu?: string | null, role?: string | null, units?: string[], copies?: boolean, roles?: import('./fakes.js').FakeRole[], transcripts?: string[], teamRoles?: Record<string, string[]> }} [o]
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
  const teamRoles = o.teamRoles ?? {};
  const bu = o.bu === undefined ? 'bu-root' : o.bu;
  const role = o.role === undefined ? 'ROLE-1' : o.role;
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const store = fakeRoleStore({ calls, fail, userRoles, teamRoles, root: bu, viewer: role, units: o.units, copies: o.copies, roles: o.roles, transcripts: o.transcripts });
  const api = {
    ...store.api,
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
  };
  return { api, calls, failures, users, userRoles, teamRoles, roles: store.roles, holds: store.holds };
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

/**
 * Records the names of the choices each select offers.
 * @param {ReturnType<typeof fakeUi>} ui
 */
function offers(ui) {
  /** @type {string[][]} */
  const offered = [];
  const ux = /** @type {any} */ (ui.ui);
  const select = ux.select;
  ux.select = async (/** @type {string} */ message, /** @type {{ name: string }[]} */ choices, /** @type {any} */ def) => {
    offered.push(choices.map((ch) => ch.name));
    return select(message, choices, def);
  };
  return offered;
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
const modules = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: true };
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

test('pipeline: transcripts run at the end of lane 2, then refresh their own model', () => {
  const doc = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules, semanticModelId: 'model-1', agentTranscripts: true, agentEvaluatorModelId: 'ae-1' });
  const run = findActivity(doc.properties.activities, AGENT_EVALUATOR_ACTIVITY);
  assert.deepEqual(run.dependsOn, [{ activity: 'Conditionally_Run_Org_Data', dependencyConditions: ['Completed'] }]);
  assert.equal(run.typeProperties.notebookId, 'nb-ae');
  assert.equal(run.policy.retry, 2);
  const days = run.typeProperties.parameters.LOOKBACK_DAYS;
  assert.equal(days.type, 'int');
  assert.equal(days.value.type, 'Expression');
  // A backfill, such as the first run, reads at least 180 days; a scheduled run reads the last 14.
  assert.equal(TRANSCRIPT_BACKFILL_DAYS, 180);
  assert.equal(
    days.value.value,
    `@if(equals(pipeline().parameters.AuditMode, 'backfill'), max(pipeline().parameters.BackfillDays, ${TRANSCRIPT_BACKFILL_DAYS}), ${TRANSCRIPT_LOOKBACK_DAYS})`,
  );

  const refresh = findActivity(doc.properties.activities, AGENT_EVALUATOR_REFRESH_ACTIVITY);
  assert.deepEqual(refresh.dependsOn, [
    { activity: AGENT_EVALUATOR_ACTIVITY, dependencyConditions: ['Succeeded'] },
    { activity: 'Conditionally_Run_Org_Data', dependencyConditions: ['Completed'] },
  ]);
  assert.equal(refresh.typeProperties.parameters.SEMANTIC_MODEL_ID.value, 'ae-1');
  assert.equal(refresh.typeProperties.parameters.WRITE_MODE.value, 'merge');
  assert.match(doc.properties.description, /reads Copilot Studio transcripts at the end of lane 2, then refreshes its model/);

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
  assert.equal(pipelineSignature(config), 'core,orgData,m365Activity,agentEvaluator;model=model-1;agentEvaluator;ae=ae-1');
  config.modules.agentEvaluator = false;
  assert.equal(agentEvaluatorOn(config), false);
  assert.equal(pipelineSignature(config), 'core,orgData,m365Activity;model=model-1');
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

test('plan: the first time, the environments with agents are ticked, or else the default one', async () => {
  const QA = 'https://contoso-qa.crm.dynamics.com';
  const instances = [instance(PROD, 'Contoso (default)'), instance(DEV, 'Contoso Dev'), instance(QA, 'Contoso QA')];
  const pick = async (/** @type {Record<string, boolean | Error>} */ agents) => {
    const t = setup({ instances });
    /** @type {any[]} */
    let choices = [];
    /** @type {string} */
    let message = '';
    t.ui.ui.checkbox = /** @type {any} */ (async (/** @type {string} */ m, /** @type {any[]} */ c) => {
      message = m;
      choices = c;
      return c.filter((ch) => ch.checked).map((ch) => ch.value);
    });
    const base = t.ctx.api.dataverse;
    t.ctx.api.dataverse = (/** @type {string} */ url) => ({
      ...base(url),
      hasAgents: async () => {
        const v = agents[url];
        if (v instanceof Error) throw v;
        return v ?? false;
      },
    });
    await planAgentEvaluator(t.ctx);
    return { t, message, ticked: choices.filter((ch) => ch.checked).map((ch) => ch.value) };
  };

  const found = await pick({ [DEV]: true, [QA]: true, [PROD]: false });
  assert.equal(found.message, 'Read the environments that hold your Copilot Studio agents');
  assert.deepEqual(found.ticked, [DEV, QA]);
  assert.match(found.t.ui.text(), /Ticked the 2 environments that have Copilot Studio agents/);
  assert.deepEqual(found.t.config.agentEvaluator.environments.map((e) => e.url), [DEV, QA]);

  const unknown = await pick({ [DEV]: httpError(403, 'Forbidden'), [QA]: httpError(403, 'Forbidden') });
  assert.deepEqual(unknown.ticked, [PROD]);
  assert.match(unknown.t.ui.text(), /only the default environment is ticked\. Tick every environment that holds your agents/);
  assert.match(unknown.t.ui.text(), /Repair or change/);
});

test('plan: an environment that answers slowly or not at all is left unticked', async () => {
  const t = setup();
  const calls = /** @type {string[]} */ ([]);
  t.ctx.api.dataverse = (/** @type {string} */ url) => /** @type {any} */ ({
    hasAgents: async () => {
      calls.push(url);
      if (url.includes('broken')) throw new Error('boom');
      return url.includes('yes');
    },
  });
  const urls = ['https://yes1.crm.dynamics.com', 'https://no.crm.dynamics.com', 'https://broken.crm.dynamics.com', 'https://yes2.crm.dynamics.com', 'https://yes3.crm.dynamics.com'];
  const found = await environmentsWithAgents(t.ctx, urls);
  assert.deepEqual([...calls].sort(), [...urls].sort(), 'each environment is probed once');
  assert.deepEqual(Object.fromEntries(found), {
    'https://yes1.crm.dynamics.com': true,
    'https://no.crm.dynamics.com': false,
    'https://yes2.crm.dynamics.com': true,
    'https://yes3.crm.dynamics.com': true,
  });
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

test('access: the app is added with Bot Transcript Viewer and a role that reads every transcript, once', async () => {
  const role = readRole('ws-1', 'the install in Fabric workspace', 'the app');
  assert.equal(role.name, 'Analytics Hub transcript reader ws-1');
  const env = fakeEnvironment();
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (env.api), 'app-1', role), 'added');
  assert.deepEqual(env.calls, [
    'findAppUser',
    'createAppUser app-1 bu-root',
    `findRole ${TRANSCRIPT_ROLE} bu-root`,
    'assignRole user-1 ROLE-1',
    `createRole ${role.name} bu-root`,
    'roleCopies read-1',
    'roleHolders read-1',
    ...PLATFORM_PRIVILEGES.map((p) => `removePrivilege read-1 ${p}`),
    'addPrivileges read-1 prvReadconversationtranscript bu-root',
    'assignRole user-1 read-1',
  ]);
  assert.deepEqual(env.holds('read-1'), ['prvReadconversationtranscript:Global'], 'transcript read at Organization depth, and nothing else');
  assert.match(String(env.roles[0].description), /^Created by the Analytics Hub installer for the install in Fabric workspace ws-1\. /);
  env.calls.length = 0;
  env.userRoles['user-1'] = ['role-1', 'READ-1'];
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (env.api), 'app-1', role), 'ok', 'role IDs compare without case');
  assert.deepEqual(env.calls, ['findAppUser', `findRole ${TRANSCRIPT_ROLE} bu-root`], 'nothing is created, changed or given again');

  const existing = fakeEnvironment();
  existing.users.push({ systemuserid: 'u-9', applicationid: 'app-1', _businessunitid_value: 'bu-root' });
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (existing.api), 'app-1', role), 'added');
  assert.deepEqual(existing.calls.filter((c) => c.startsWith('assignRole')), ['assignRole u-9 ROLE-1', 'assignRole u-9 read-1']);

  const disabled = fakeEnvironment();
  disabled.users.push({ systemuserid: 'u-1', applicationid: 'app-1', isdisabled: true });
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (disabled.api), 'app-1', role), 'disabled');

  const noStudio = fakeEnvironment({ role: null });
  assert.equal(await grantTranscriptAccess(/** @type {any} */ (noStudio.api), 'app-1', role), 'no-role');
  assert.ok(!noStudio.calls.some((c) => c.startsWith('createRole')), 'no role is created where Copilot Studio isn\'t set up');

  const noBu = fakeEnvironment({ bu: null });
  await assert.rejects(grantTranscriptAccess(/** @type {any} */ (noBu.api), 'app-1', role), /root business unit/);
});

test('access: the read role ends holding exactly transcript read, after a run stopped part way or an admin changed it', async () => {
  const role = readRole('ws-1', 'the install in Fabric workspace', 'the app');
  const env = fakeEnvironment();
  env.failures.removePrivilege = [httpError(500, 'Boom')];
  await assert.rejects(addTranscriptReader(/** @type {any} */ (env.api), 'app-1', role), (/** @type {any} */ err) => {
    assert.match(err.message, /Boom/);
    assert.deepEqual(err.grant, { createdUser: true, userId: 'user-1', roleId: 'ROLE-1', viewer: true, newReadRole: true, readRoleId: 'read-1', readRoleName: role.name, createdReadRole: true });
    return true;
  });
  assert.equal(env.holds('read-1').length, PLATFORM_PRIVILEGES.length, 'the new role still holds what Dataverse gave it');
  assert.deepEqual(env.userRoles['user-1'], ['ROLE-1'], 'and isn\'t given');
  env.calls.length = 0;
  const again = await addTranscriptReader(/** @type {any} */ (env.api), 'app-1', role);
  assert.equal(again.result, 'added');
  assert.equal(again.fixedReadRole, true);
  assert.equal(again.newReadRole, undefined, 'the same role, found by its description');
  assert.deepEqual(env.calls, [
    'findAppUser',
    `findRole ${TRANSCRIPT_ROLE} bu-root`,
    'roleCopies read-1',
    'roleHolders read-1',
    ...PLATFORM_PRIVILEGES.map((p) => `removePrivilege read-1 ${p}`),
    'addPrivileges read-1 prvReadconversationtranscript bu-root',
    'assignRole user-1 read-1',
  ]);
  assert.deepEqual(env.holds('read-1'), ['prvReadconversationtranscript:Global']);

  const stopped = fakeEnvironment();
  stopped.failures.addPrivileges = [httpError(500, 'Boom')];
  await assert.rejects(addTranscriptReader(/** @type {any} */ (stopped.api), 'app-1', role), /Boom/);
  assert.deepEqual(stopped.holds('read-1'), [], 'the platform privileges came off, and transcript read wasn\'t added');
  assert.equal((await addTranscriptReader(/** @type {any} */ (stopped.api), 'app-1', role)).result, 'added');
  assert.deepEqual(stopped.holds('read-1'), ['prvReadconversationtranscript:Global']);

  // An admin changed the installer's role: transcript read down to Business Unit, and agent read added.
  const changed = fakeEnvironment({
    roles: [{ roleid: 'read-7', name: role.name, description: role.description, bu: 'bu-root', privileges: new Map([['priv-transcript', 'Local'], ['priv-bot', 'Global']]) }],
  });
  changed.users.push({ systemuserid: 'u-1', applicationid: 'app-1', _businessunitid_value: 'bu-root' });
  changed.userRoles['u-1'] = ['ROLE-1', 'read-7'];
  const fixed = await addTranscriptReader(/** @type {any} */ (changed.api), 'app-1', role);
  assert.equal(fixed.result, 'ok', 'nothing new was given');
  assert.equal(fixed.fixedReadRole, true);
  assert.deepEqual(changed.calls.slice(2), [
    'roleCopies read-7',
    'roleHolders read-7',
    'removePrivilege read-7 prvReadconversationtranscript',
    'removePrivilege read-7 prvReadbot',
    'addPrivileges read-7 prvReadconversationtranscript bu-root',
  ], 'only the reader has it, so it\'s fixed');
  assert.deepEqual(changed.holds('read-7'), ['prvReadconversationtranscript:Global']);
});

test('access: a role the installer didn\'t create is never changed, and given only when it holds exactly transcript read', async () => {
  const role = readRole('ws-1', 'the install in Fabric workspace', 'the app');
  /** @param {[string, string][]} privileges */
  const theirs = (privileges) => [{ roleid: 'theirs-1', name: role.name, description: 'Made by an admin', bu: 'bu-root', privileges: new Map(privileges) }];

  const wide = fakeEnvironment({ roles: theirs([['priv-transcript', 'Global'], ['priv-bot', 'Global']]) });
  const grant = await addTranscriptReader(/** @type {any} */ (wide.api), 'app-1', role);
  assert.equal(grant.result, 'unverified');
  assert.deepEqual(grant.holds, ['prvReadbot:Global', 'prvReadconversationtranscript:Global']);
  assert.equal(grant.createdReadRole, undefined);
  assert.ok(!wide.calls.some((c) => /^(createRole|removePrivilege|addPrivileges|deleteRole)/.test(c)), 'nothing is created or changed');
  assert.deepEqual(wide.userRoles['user-1'], ['ROLE-1'], 'and it isn\'t given');

  // Another install whose ID starts with the same 8 characters has a role of the same name, but it isn't this install's.
  const mine = readRole('0000aaaa-1111-2222-3333-444455556666', 'the install in Fabric workspace', 'the app');
  const another = readRole('0000aaaa-9999-8888-7777-666655554444', 'the install in Fabric workspace', 'the app');
  assert.equal(mine.name, another.name);
  const shared = fakeEnvironment({ roles: [{ roleid: 'theirs-1', name: another.name, description: another.description, bu: 'bu-root', privileges: new Map([['priv-transcript', 'Basic']]) }] });
  assert.equal((await addTranscriptReader(/** @type {any} */ (shared.api), 'app-1', mine)).result, 'unverified', 'another install\'s role is left alone');
  assert.deepEqual(shared.holds('theirs-1'), ['prvReadconversationtranscript:Basic']);
  assert.ok(!shared.calls.some((c) => /^(createRole|removePrivilege|addPrivileges|deleteRole)/.test(c)));

  const exact = fakeEnvironment({ roles: theirs([['priv-transcript', 'Global']]) });
  const given = await addTranscriptReader(/** @type {any} */ (exact.api), 'app-1', role);
  assert.equal(given.result, 'added');
  assert.deepEqual({ readRoleId: given.readRoleId, createdReadRole: given.createdReadRole, assignedReadRoleId: given.assignedReadRoleId }, { readRoleId: 'theirs-1', createdReadRole: undefined, assignedReadRoleId: 'theirs-1' });
  assert.ok(!exact.calls.some((c) => /^(createRole|removePrivilege|addPrivileges)/.test(c)));
});

test('access: in a child business unit, the user is given the role\'s copy there', async () => {
  const role = readRole('ws-1', 'the install in Fabric workspace', 'the app');
  const env = fakeEnvironment({ units: ['bu-child'] });
  env.users.push({ systemuserid: 'u-1', applicationid: 'app-1', _businessunitid_value: 'bu-child' });
  const grant = await addTranscriptReader(/** @type {any} */ (env.api), 'app-1', role);
  assert.equal(grant.result, 'added');
  assert.deepEqual({ readRoleId: grant.readRoleId, assignedReadRoleId: grant.assignedReadRoleId }, { readRoleId: 'read-1', assignedReadRoleId: 'read-1-bu-child' });
  assert.deepEqual(env.calls.slice(-2), ['roleCopy read-1 bu-child', 'assignRole u-1 read-1-bu-child']);
  assert.deepEqual(env.holds('read-1-bu-child'), ['prvReadconversationtranscript:Global'], 'the copy holds what the role holds');

  const early = fakeEnvironment({ units: ['bu-child'], copies: false });
  early.users.push({ systemuserid: 'u-1', applicationid: 'app-1', _businessunitid_value: 'bu-child' });
  const waiting = await addTranscriptReader(/** @type {any} */ (early.api), 'app-1', role);
  assert.equal(waiting.result, 'no-copy');
  assert.equal(waiting.assignedReadRoleId, undefined);
  assert.equal(waiting.createdReadRole, true, 'the role is still the installer\'s to delete');
});

test('access: in a child business unit, a role that only shares the name there is never given', async () => {
  const role = readRole('ws-1', 'the install in Fabric workspace', 'the app');
  // Listed before the copy, so a lookup by name and business unit would find it first.
  const env = fakeEnvironment({
    units: ['bu-child'],
    roles: [{ roleid: 'lookalike', name: role.name, description: role.description, bu: 'bu-child', privileges: new Map([['priv-bot', 'Global']]) }],
  });
  env.users.push({ systemuserid: 'u-1', applicationid: 'app-1', _businessunitid_value: 'bu-child' });
  const grant = await addTranscriptReader(/** @type {any} */ (env.api), 'app-1', role);
  assert.deepEqual([grant.result, grant.assignedReadRoleId], ['added', 'read-1-bu-child']);
  assert.deepEqual(env.userRoles['u-1'], ['ROLE-1', 'read-1-bu-child'], 'the copy of the role whose privileges were read back');
  assert.ok(!env.calls.some((c) => c.includes('lookalike')), 'the lookalike isn\'t changed or given');
  assert.deepEqual(env.holds('lookalike'), ['prvReadbot:Global']);
});

test('access: the install\'s role isn\'t changed or given while a user or team other than the reader has it, or a copy of it', async () => {
  const role = readRole('ws-1', 'the install in Fabric workspace', 'the app');
  /**
   * A role with the install's name and description, which anyone who can create roles could make.
   * @param {Partial<import('./fakes.js').FakeRole>} [o]
   * @returns {import('./fakes.js').FakeRole}
   */
  const decoy = (o = {}) => ({ roleid: 'decoy-1', name: role.name, description: role.description, bu: 'bu-root', privileges: new Map(), ...o });
  /** @param {string} label @param {ReturnType<typeof fakeEnvironment>} env */
  const leftAlone = async (label, env) => {
    const grant = await addTranscriptReader(/** @type {any} */ (env.api), 'app-1', role);
    assert.equal(grant.result, 'held', label);
    assert.deepEqual([grant.readRoleId, grant.createdReadRole, grant.assignedReadRoleId], [undefined, undefined, undefined], `${label}: nothing is noted for Uninstall`);
    assert.ok(!env.calls.some((c) => /^(createRole|removePrivilege|addPrivileges|deleteRole)/.test(c)), `${label}: nothing is created or changed`);
    assert.deepEqual(env.holds('decoy-1'), [], `${label}: no privilege is added`);
    assert.deepEqual(env.userRoles['user-1'], ['ROLE-1'], `${label}: only Bot Transcript Viewer is given`);
  };

  const user = fakeEnvironment({ roles: [decoy()] });
  user.userRoles.someone = ['decoy-1'];
  await leftAlone('a user', user);
  assert.deepEqual(user.calls.slice(-2), ['roleCopies decoy-1', 'roleHolders decoy-1']);

  await leftAlone('a team', fakeEnvironment({ roles: [decoy()], teamRoles: { 'team-1': ['decoy-1'] } }));

  // A user in a child business unit holds Dataverse's copy there, not the role.
  const root = decoy();
  const child = fakeEnvironment({ units: ['bu-child'], roles: [root, { ...root, roleid: 'decoy-1-bu-child', bu: 'bu-child', parent: 'decoy-1' }] });
  child.userRoles.someone = ['decoy-1-bu-child'];
  await leftAlone('a copy\'s user', child);
  assert.deepEqual(child.calls.slice(-3), ['roleCopies decoy-1', 'roleHolders decoy-1', 'roleHolders decoy-1-bu-child']);

  // More copies or holders than a page counts as someone else.
  const copies = fakeEnvironment({ roles: [decoy()] });
  const listCopies = copies.api.roleCopies;
  copies.api.roleCopies = async (/** @type {string} */ id) => ({ ...(await listCopies(id)), more: true });
  await leftAlone('more copies than a page', copies);
  const holders = fakeEnvironment({ roles: [decoy()] });
  const listHolders = holders.api.roleHolders;
  holders.api.roleHolders = async (/** @type {string} */ id) => ({ ...(await listHolders(id)), more: true });
  await leftAlone('more holders than a page', holders);

  // A check that fails can't tell, so nothing is added, given or noted.
  for (const method of ['roleCopies', 'roleHolders']) {
    const failing = fakeEnvironment({ roles: [decoy()] });
    failing.failures[method] = [httpError(500, 'Boom')];
    await assert.rejects(addTranscriptReader(/** @type {any} */ (failing.api), 'app-1', role), (/** @type {any} */ err) => {
      assert.deepEqual(err.grant, { createdUser: true, userId: 'user-1', roleId: 'ROLE-1', viewer: true }, method);
      return true;
    });
    assert.ok(!failing.calls.some((c) => /^(removePrivilege|addPrivileges)/.test(c)), method);
    assert.deepEqual(failing.holds('decoy-1'), [], method);
    assert.deepEqual(failing.userRoles['user-1'], ['ROLE-1'], method);
  }

  // One that already holds exactly transcript read at Organization depth gives no one anything new, so it isn't checked.
  const reads = fakeEnvironment({ roles: [decoy({ privileges: new Map([['priv-transcript', 'Global']]) })] });
  reads.userRoles.someone = ['decoy-1'];
  assert.equal((await addTranscriptReader(/** @type {any} */ (reads.api), 'app-1', role)).result, 'added');
  assert.ok(!reads.calls.some((c) => c.startsWith('roleHolders')));
});

test('access: Dataverse is asked whether the reader can read one transcript', async () => {
  const role = readRole('ws-1', 'the install in Fabric workspace', 'the app');
  const env = fakeEnvironment({ transcripts: ['tx-1'] });
  assert.equal((await addTranscriptReader(/** @type {any} */ (env.api), 'app-1', role)).sample, 'read');

  const late = fakeEnvironment({ transcripts: ['tx-1'] });
  late.api.principalAccess = async () => 'None';
  assert.equal((await addTranscriptReader(/** @type {any} */ (late.api), 'app-1', role)).sample, 'unread');

  const denied = fakeEnvironment({ transcripts: ['tx-1'] });
  denied.failures.principalAccess = [httpError(403, 'Forbidden')];
  const grant = await addTranscriptReader(/** @type {any} */ (denied.api), 'app-1', role);
  assert.deepEqual([grant.result, grant.sample], ['added', undefined], 'only a check');

  const empty = fakeEnvironment();
  assert.equal((await addTranscriptReader(/** @type {any} */ (empty.api), 'app-1', role)).sample, undefined, 'no transcripts to check');
});

test('access: each environment is set up; without rights the steps are shown and the rest carry on', async () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso' }, { url: DEV, name: 'Dev' }, { url: 'https://ok.crm.dynamics.com', access: true, readAll: true }];
  t.envs[DEV] = fakeEnvironment();
  t.envs[DEV].failures.findAppUser = [httpError(403, 'Forbidden')];
  assert.equal(await ensureTranscriptAccess(t.ctx), true);
  assert.deepEqual(t.config.agentEvaluator.environments.map((e) => !!e.access), [true, false, true]);
  assert.deepEqual(t.config.agentEvaluator.environments.map((e) => !!e.readAll), [true, false, true]);
  const text = t.ui.text();
  const role = appReadRole(t.config).name;
  assert.match(text, new RegExp(`Created the "${role}" role in Contoso: it reads every Copilot Studio conversation transcript there, and nothing else`));
  assert.match(text, new RegExp(`Gave ValueLens Data Collector the ${TRANSCRIPT_ROLE} and "${role}" roles in Contoso`));
  assert.match(text, /can't add ValueLens Data Collector to Dev/);
  assert.match(text, /New app user\. Pick ValueLens Data Collector \(app-1\), the root business unit, and the Bot Transcript Viewer role and the new role\./);
  assert.match(text, /Security roles > \+ New role\. Name it, for example "Analytics Hub transcript reader", keep the root business unit, turn off Include App Opener privileges for running Model-Driven apps, and Save\. Then set the ConversationTranscript table's Read to Organization, and Save\./);
  assert.equal(t.envs['https://ok.crm.dynamics.com'], undefined, 'environments the app reads all of are left alone');
  assert.deepEqual(t.config.fabric.transcriptAccess, [{ url: PROD, appId: 'app-1', name: 'Contoso', userId: 'user-1', readRoleId: 'read-1', readRoleName: role, createdReadRole: true, assignedReadRoleId: 'read-1' }]);

  const told = setup({ answers: [true] });
  told.config.agentEvaluator.environments = [{ url: DEV }];
  told.envs[DEV] = fakeEnvironment();
  told.envs[DEV].failures.findAppUser = [httpError(401, 'Unauthorized')];
  assert.equal(await ensureTranscriptAccess(told.ctx), true, 'the user says an admin already added it');
  assert.equal(told.config.agentEvaluator.environments[0].access, true);
  assert.equal(told.config.agentEvaluator.environments[0].readAll, true);
  assert.equal(told.config.fabric.transcriptAccess, undefined, 'nothing the installer added');

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

test('access: an install from before the read role gets it on Update or Repair', async () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso', access: true }];
  const env = (t.envs[PROD] = fakeEnvironment({ transcripts: ['tx-1'] }));
  env.users.push({ systemuserid: 'u-1', applicationid: 'app-1', _businessunitid_value: 'bu-root' });
  env.userRoles['u-1'] = ['ROLE-1'];
  assert.equal(await ensureTranscriptAccess(t.ctx), true);
  const role = appReadRole(t.config).name;
  assert.deepEqual(env.calls.filter((c) => c.startsWith('assignRole')), ['assignRole u-1 read-1'], 'Bot Transcript Viewer is kept, not given again');
  assert.deepEqual(env.holds('read-1'), ['prvReadconversationtranscript:Global']);
  assert.deepEqual(t.config.agentEvaluator.environments, [{ url: PROD, name: 'Contoso', access: true, readAll: true }]);
  const text = t.ui.text();
  assert.match(text, new RegExp(`Gave ValueLens Data Collector the "${role}" role in Contoso`));
  assert.match(text, /Checked one transcript in Contoso: ValueLens Data Collector can read it/);

  env.calls.length = 0;
  t.ui.out.length = 0;
  assert.equal(await ensureTranscriptAccess(t.ctx), true);
  assert.deepEqual(env.calls, [], 'the next run leaves it alone');
  assert.match(t.ui.text(), /ValueLens Data Collector can read every transcript in Contoso/);
});

test('access: without the rights to create the role, an app that has Bot Transcript Viewer keeps reading what\'s shared with it', async () => {
  for (const method of ['rolesByName', 'createRole']) {
    const t = setup({ answers: [false] });
    const offered = offers(t.ui);
    t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso', access: true }];
    const env = (t.envs[PROD] = fakeEnvironment());
    env.users.push({ systemuserid: 'u-1', applicationid: 'app-1', _businessunitid_value: 'bu-root' });
    env.userRoles['u-1'] = ['ROLE-1'];
    env.failures[method] = [httpError(403, 'Forbidden')];
    assert.equal(await ensureTranscriptAccess(t.ctx), true, `${method}: it still reads what's shared with it`);
    assert.deepEqual(t.config.agentEvaluator.environments, [{ url: PROD, name: 'Contoso', access: true }], `${method}: it gets the role on a later run`);
    assert.equal(t.config.fabric.transcriptAccess, undefined);
    const text = t.ui.text();
    assert.match(text, /You can't give ValueLens Data Collector a role that reads every transcript in Contoso, so it reads only the transcripts shared with it there until someone does\./);
    assert.match(text, /A System Administrator of Contoso can give it the role in the Power Platform admin center/);
    assert.match(text, /Application users > ValueLens Data Collector \(app-1\) > Edit security roles\. Tick the new role, and Save\./);
    assert.doesNotMatch(text, /New app user/);
    assert.deepEqual(offered, [['Carry on for now', 'It already reads every transcript']]);
  }

  const fresh = setup({ answers: [true] });
  fresh.config.agentEvaluator.environments = [{ url: DEV, name: 'Dev' }];
  const env = (fresh.envs[DEV] = fakeEnvironment());
  env.failures.createRole = [httpError(403, 'Forbidden')];
  assert.equal(await ensureTranscriptAccess(fresh.ctx), true);
  assert.deepEqual(env.userRoles['user-1'], ['ROLE-1'], 'Bot Transcript Viewer was given before the role failed');
  assert.deepEqual(fresh.config.agentEvaluator.environments, [{ url: DEV, name: 'Dev', access: true, readAll: true }], 'the user says an admin gave it the role');
});

test('access: the read role is only given when it holds exactly transcript read', async () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso' }];
  const role = appReadRole(t.config);
  const env = (t.envs[PROD] = fakeEnvironment({ roles: [{ roleid: 'theirs-1', name: role.name, description: 'Made by an admin', bu: 'bu-root', privileges: new Map([['priv-transcript', 'Global'], ['priv-bot', 'Global']]) }] }));
  assert.equal(await ensureTranscriptAccess(t.ctx), true, 'it reads what\'s shared with it');
  assert.deepEqual(t.config.agentEvaluator.environments, [{ url: PROD, name: 'Contoso', access: true }]);
  assert.deepEqual(env.userRoles['user-1'], ['ROLE-1']);
  const text = t.ui.text();
  assert.match(
    text,
    new RegExp(`The "${role.name}" role in Contoso should hold only ConversationTranscript read at Organization depth, but holds prvReadbot:Global, prvReadconversationtranscript:Global, so the installer didn't give it to ValueLens Data Collector\\. It reads only the transcripts shared with it there\\.`),
  );
  assert.match(text, /The installer didn't create that role, so it leaves it alone\. Rename or delete it, then run the installer again\./);
  assert.match(text, new RegExp(`Gave ValueLens Data Collector the ${TRANSCRIPT_ROLE} role in Contoso`));
  assert.deepEqual(t.config.fabric.transcriptAccess, undefined, 'nothing to remove: the role isn\'t the installer\'s, and it wasn\'t given');

  const child = setup();
  child.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso' }];
  const unit = (child.envs[PROD] = fakeEnvironment({ units: ['bu-child'], copies: false }));
  unit.users.push({ systemuserid: 'u-1', applicationid: 'app-1', _businessunitid_value: 'bu-child' });
  assert.equal(await ensureTranscriptAccess(child.ctx), true);
  assert.deepEqual(child.config.agentEvaluator.environments, [{ url: PROD, name: 'Contoso', access: true }]);
  assert.match(child.ui.text(), new RegExp(`Contoso has no copy of the "${role.name}" role in the business unit of ValueLens Data Collector's application user yet, so it reads only the transcripts shared with it there\\. Run the installer again in a few minutes\\.`));
  assert.deepEqual(child.config.fabric.transcriptAccess, [{ url: PROD, appId: 'app-1', name: 'Contoso', userId: 'u-1', readRoleId: 'read-1', readRoleName: role.name, createdReadRole: true }], 'the role is deleted on uninstall');

  const unread = setup();
  unread.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso' }];
  (unread.envs[PROD] = fakeEnvironment({ transcripts: ['tx-1'] })).api.principalAccess = async () => 'None';
  await ensureTranscriptAccess(unread.ctx);
  assert.match(unread.ui.text(), /Dataverse shows ValueLens Data Collector can't read a transcript in Contoso yet\. Role changes can take a few minutes\. If the next run still finds no transcripts there, check its security roles in the Power Platform admin center\./);
});

test('access: the install\'s role that a user or team other than the app has is left alone, with what an admin does', async () => {
  /** @type {[string, (env: ReturnType<typeof fakeEnvironment>) => void][]} */
  const holders = [
    ['a user', (env) => void (env.userRoles.someone = ['decoy-1'])],
    ['a team', (env) => void (env.teamRoles['team-1'] = ['decoy-1'])],
  ];
  for (const [who, hold] of holders) {
    const t = setup();
    t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso' }];
    const role = appReadRole(t.config);
    const env = (t.envs[PROD] = fakeEnvironment({ roles: [{ roleid: 'decoy-1', name: role.name, description: role.description, bu: 'bu-root', privileges: new Map() }] }));
    hold(env);
    assert.equal(await ensureTranscriptAccess(t.ctx), true, `${who}: it reads what's shared with it`);
    assert.deepEqual(t.config.agentEvaluator.environments, [{ url: PROD, name: 'Contoso', access: true }], `${who}: checked again on the next run`);
    assert.deepEqual(env.holds('decoy-1'), [], who);
    assert.deepEqual(env.userRoles['user-1'], ['ROLE-1'], who);
    assert.equal(t.config.fabric.transcriptAccess, undefined, `${who}: nothing for Uninstall to remove`);
    const text = t.ui.text();
    assert.ok(
      text.includes(
        `A user or team other than ValueLens Data Collector has the "${role.name}" role in Contoso, so the installer didn't change it or give it to ValueLens Data Collector. It reads only the transcripts shared with it there.`,
      ),
      who,
    );
    assert.ok(
      text.includes(
        'Transcript read on the role would reach them too. A System Administrator can see who has it in the Power Platform admin center, under Manage > Environments > the environment > ' +
          'Settings > Users + permissions > Security roles: select the role, then More actions (...) > Members. Remove them from it, or delete the role, then run the installer again.',
      ),
      who,
    );
    assert.ok(text.includes(`Gave ValueLens Data Collector the ${TRANSCRIPT_ROLE} role in Contoso`), who);
    assert.doesNotMatch(text, /Created the|Set the/, who);
    env.calls.length = 0;
    await removeFabricReadRoles(t.ctx);
    assert.deepEqual(env.calls, [], `${who}: Uninstall leaves the role`);

    // Once they no longer have it, the next run sets the role and gives it.
    env.userRoles.someone = [];
    env.teamRoles['team-1'] = [];
    t.ui.out.length = 0;
    assert.equal(await ensureTranscriptAccess(t.ctx), true);
    assert.deepEqual(env.holds('decoy-1'), ['prvReadconversationtranscript:Global'], who);
    assert.deepEqual(env.userRoles['user-1'], ['ROLE-1', 'decoy-1'], who);
    assert.match(t.ui.text(), new RegExp(`Set the "${role.name}" role in Contoso to read only Copilot Studio conversation transcripts`), who);
  }
});

test('access: unticking an environment or the module, or uninstalling, removes only the role the installer added', async () => {
  const t = setup();
  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso' }, { url: DEV, name: 'Dev' }];
  await ensureTranscriptAccess(t.ctx);
  const role = appReadRole(t.config).name;
  assert.equal(t.config.fabric.transcriptAccess?.length, 2);
  const prod = t.envs[PROD];
  const dev = t.envs[DEV];

  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso', access: true, readAll: true }];
  assert.deepEqual(fabricReadRoleReview(t.config), [
    {
      kind: 'Dataverse security role',
      name: `${role} in Contoso`,
      isNew: false,
      detail: 'Reads every Copilot Studio conversation transcript there, and nothing else. Created for this install, given to the app, and deleted on uninstall.',
    },
    { kind: 'Dataverse security role', name: `${role} in Dev`, isNew: false, detail: 'No longer chosen, so the installer takes it away and deletes the role it created.' },
  ]);
  dev.calls.length = 0;
  t.ui.out.length = 0;
  await removeFabricReadRoles(t.ctx, (e) => e.url === PROD);
  assert.deepEqual(dev.calls, ['removeRole user-1 read-1', 'deleteRole read-1']);
  assert.deepEqual(dev.userRoles['user-1'], ['ROLE-1'], 'Bot Transcript Viewer and the app user stay, as before');
  assert.deepEqual(dev.roles, []);
  assert.deepEqual(t.config.fabric.transcriptAccess?.map((e) => e.url), [PROD]);
  assert.match(t.ui.text(), new RegExp(`Deleted the "${role}" role in Dev`));

  // The module is unticked: the role goes in every environment.
  t.config.modules.agentEvaluator = false;
  assert.deepEqual(fabricReadRoleReview(t.config).map((r) => r.name), [`${role} in Contoso`]);
  await removeFabricReadRoles(t.ctx, (e) => fabricReadRoleWanted(t.config, e));
  assert.deepEqual(prod.calls.slice(-2), ['removeRole user-1 read-1', 'deleteRole read-1']);
  assert.equal(t.config.fabric.transcriptAccess, undefined);
  assert.deepEqual(t.config.agentEvaluator.environments, [{ url: PROD, name: 'Contoso', access: true }], 'so it gets the role again when ticked');
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
  assert.equal(text.split('Sql.Database(').length - 1, 1);
  assert.match(expr('FabricTable'), /Db = Sql\.Database\(#"Fabric SQL Endpoint", #"Lakehouse Name"\),/, 'a source the service can bind');
});

test('model: before the parser first runs, the empty fallbacks have the columns the model declares', () => {
  const file = /** @type {string} */ (realSources().agentEvaluatorModelFile);
  const template = loadTemplateModel(file);
  const bim = buildAgentEvaluatorModel(template, { server: 's', database: 'd' });
  /** @param {any} model @param {string} name */
  const fallback = (model, name) => {
    const p = model.tables.find((/** @type {any} */ t) => t.name === name).partitions[0];
    const text = Array.isArray(p.source.expression) ? p.source.expression.join('\n') : String(p.source.expression);
    const cols = /FabricTable\("[^"]+"\)\s*otherwise\s*EmptyTable\(\{([^}]*)\}\)/.exec(text)?.[1] ?? '';
    return [...cols.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  const perf = fallback(bim.model, 'Agent Performance');
  const perfText = [bim.model.tables.find((/** @type {any} */ t) => t.name === 'Agent Performance').partitions[0].source.expression].flat().join('\n');
  assert.match(perfText, /Table\.RemoveColumns\(PromotedHeaders, \{[^}]*"AllVariables"[^}]*\}, MissingField\.Ignore\)/, 'drops columns nothing reads');
  for (const c of ['ConversationTranscriptId', 'SessionOutcomeExplicit', 'TotalTokenCount', 'ErrorCategory']) assert.ok(perf.includes(c), c);
  assert.ok(!perf.includes('InteractionDate'), 'columns the query adds itself stay out');
  assert.equal(new Set(perf).size, perf.length);
  const sessions = fallback(bim.model, 'Agent Sessions');
  for (const c of ['session_outcome_explicit', 'is_returning_user']) assert.ok(sessions.includes(c), c);
  assert.ok(!sessions.includes('user_upn'));
  for (const t of ['Agent Catalogue', 'Agent Name Map', 'Agent Errors']) assert.deepEqual(fallback(bim.model, t), fallback(template.model, t), `${t} unchanged`);
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
  t.config.agentEvaluator.environments = [{ url: PROD, name: 'Contoso', access: true, readAll: true }, { url: DEV }, { url: 'https://contoso-test.crm.dynamics.com', access: true }];
  Object.assign(t.config.agentEvaluator.model, { id: 'ae-1', bound: true });
  agentEvaluatorSummary(t.ctx);
  const text = t.ui.text();
  assert.match(text, /Contoso/);
  assert.doesNotMatch(text, /Contoso .*waiting/);
  assert.match(text, /contoso-dev\.crm4\.dynamics\.com.*waiting for ValueLens Data Collector to be added with Bot Transcript Viewer and a role that reads every transcript/);
  assert.match(text, /contoso-test\.crm\.dynamics\.com.*waiting for ValueLens Data Collector to be given a role that reads every transcript/);
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
