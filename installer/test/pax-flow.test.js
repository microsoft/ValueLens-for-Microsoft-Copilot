// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { declaredGraphRoles } from '../src/clients/graph.js';
import { commandLine } from '../src/launch.js';
import { THE_APP } from '../src/managed-app/flow.js';
import { PRODUCT } from '../src/product.js';
import { shareReportPending } from '../src/steps/access.js';
import { endedSince, paxCommand, paxInstall, paxModels, paxStatus, paxSummary, paxUninstall, settleFirstRun } from '../src/steps/pax/flow.js';
import { RUNNER_DIR, TASK_AT, credentialTarget, paxPaths, readState, registerTask, startTask } from '../src/steps/pax/local.js';
import { paxPlan, paxPreflight } from '../src/steps/pax/plan.js';
import { refreshTimes, SCHEDULE_OFF_WHY } from '../src/steps/pax/publish.js';
import { fakeAzureGraph, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';
import { HELD_FILE, HELD_MESSAGE, HELD_UPN_MESSAGE, PARTIAL_MESSAGE, failed, fakePaxHost } from './pax-fakes.js';

const FOLDER = 'https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Analytics';
const SITE_ID = 'contoso.sharepoint.com,11111111-aaaa-4aaa-8aaa-111111111111,22222222-bbbb-4bbb-8bbb-222222222222';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const APP_ID = '44444444-4444-4444-8444-444444444444';
const APP_URL = 'https://apps.contoso.example/play/valuelens';
const START = Date.parse('2026-06-01T12:00:00Z');
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const GLOBAL_ADMIN = { roleTemplateId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' };
const ME = { id: 'user-1', displayName: 'Admin', userPrincipalName: 'admin@contoso.com' };
const TARGET = 'PAX-ValueLens-tenant-1';

const Q = {
  advanced: 'Change the advanced settings?',
  folder: 'SharePoint folder address',
  workspace: 'Power BI workspace for the report',
  deploy: `Deploy ${THE_APP}?`,
  appReg: 'The scheduled refresh signs in to Microsoft Graph and SharePoint as an app.',
  signIn: 'Signed it in?',
  shared: 'Have you shared the report?',
  siteLoop: 'Once they have done it:',
  removeAll: "Remove the scheduled refresh and its files from this PC, the app, and the app's access to the SharePoint site?",
  deleteAppReg: `Delete the app registration ${PRODUCT.pax.app} too?`,
};

/** @type {string[]} */
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'valuelens-flow-'));
  temps.push(dir);
  return dir;
};

/**
 * fakeUi, with answers by question too: a question named in `by` gets that answer (a list is
 * taken in turn, and its last answer repeats). Other questions take `answers` in turn, then the defaults.
 * @param {{ yes?: boolean, answers?: any[], by?: Record<string, any> }} [o]
 */
function byUi(o = {}) {
  const f = fakeUi({ yes: o.yes, answers: o.answers });
  /** @type {Record<string, any>} */
  const by = { ...o.by };
  const ui = /** @type {any} */ (f.ui);
  const has = (/** @type {string} */ message) => Object.prototype.hasOwnProperty.call(by, message);
  const take = (/** @type {string} */ message) => {
    f.asked.push(message);
    const value = by[message];
    return Array.isArray(value) ? (value.length > 1 ? value.shift() : value[0]) : value;
  };
  const { confirm, select, input } = ui;
  /** @type {Record<string, (...args: any[]) => any>} */
  const asks = {
    confirm: async (message, def) => (has(message) ? take(message) : confirm(message, def)),
    select: async (message, choices, def) => (has(message) ? take(message) : select(message, choices, def)),
    input: async (message, opts = {}) => {
      if (!has(message)) return input(message, opts);
      const value = take(message);
      const verdict = opts.validate?.(value) ?? true;
      if (verdict !== true) throw new Error(`${message}: ${verdict}`);
      return value;
    },
  };
  Object.assign(ui, asks);
  return { ...f, by };
}

/** fakeAzureGraph, plus what the PAX route calls: Graph's roles, the viewer group and site permissions. */
function graphFake() {
  const base = fakeAzureGraph();
  const { calls, failures } = base;
  const g = /** @type {any} */ (base.api);
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const roles = ['AuditLogsQuery.Read.All', 'Reports.Read.All', 'User.Read.All', 'ReportSettings.Read.All', 'Sites.Selected', 'Organization.Read.All', 'Application.Read.All', 'CopilotPackages.Read.All'];
  const graphSp = {
    id: 'graph-sp',
    appId: GRAPH_APP_ID,
    appRoles: roles.map((value, i) => ({ id: `r-${i + 1}`, value })),
    oauth2PermissionScopes: [{ id: 's-user-read', value: 'User.Read' }],
  };
  const roleName = (/** @type {string} */ id) => graphSp.appRoles.find((r) => r.id === id)?.value ?? id;
  /** @type {{ id: string, principalId: string, resourceId: string, appRoleId: string }[]} */
  const assigned = [];
  /** @type {any[]} */
  const perms = [];
  /** @type {{ id: string, displayName: string, securityEnabled: boolean }[]} */
  const groups = [];
  let p = 0;
  let n = 0;
  const byAppId = g.servicePrincipalByAppId;
  const createApplication = g.createApplication;
  const assign = (/** @type {string} */ principalId, /** @type {string} */ resourceId, /** @type {string} */ appRoleId) => {
    const assignment = { id: `assignment-${++n}`, principalId, resourceId, appRoleId };
    assigned.push(assignment);
    return { ...assignment };
  };
  /** Sets the Graph app roles an app lists on its API permissions page, as Graph keeps them. @param {any} application @param {string[]} ids */
  const declare = (application, ids) => {
    application.requiredResourceAccess = ids.length ? [{ resourceAppId: GRAPH_APP_ID, resourceAccess: ids.map((id) => ({ id, type: 'Role' })) }] : [];
  };
  /** @type {Record<string, (...args: any[]) => any>} */
  const more = {
    graphServicePrincipal: async () => graphSp,
    servicePrincipalByAppId: async (appId) => (appId === GRAPH_APP_ID ? graphSp : byAppId(appId)),
    createApplication: async (name, appRoles) => {
      const application = await createApplication(name);
      declare(application, appRoles.map((/** @type {{ id: string }} */ r) => r.id));
      return application;
    },
    grantAppRole: async (resourceId, principalId, appRoleId) => {
      calls.push(`grantAppRole ${roleName(appRoleId)}`);
      fail('grantAppRole');
      return assign(principalId, resourceId, appRoleId);
    },
    assignPrincipalToAppRole: async (principalId, resourceId, appRoleId) => {
      calls.push(`grantAppRole ${roleName(appRoleId)}`);
      return assign(principalId, resourceId, appRoleId);
    },
    revokeAppRole: async (resourceId, assignmentId) => {
      const at = assigned.findIndex((a) => a.id === assignmentId && a.resourceId === resourceId);
      calls.push(`revokeAppRole ${at < 0 ? assignmentId : roleName(assigned[at].appRoleId)}`);
      fail('revokeAppRole');
      if (at < 0) throw httpError(404);
      assigned.splice(at, 1);
    },
    appRoleAssignments: async (spId) => assigned.filter((a) => a.principalId === spId).map((a) => ({ ...a })),
    appRoleAssignedTo: async (resourceId) => assigned.filter((a) => a.resourceId === resourceId).map((a) => ({ ...a })),
    usersCanRegisterApps: async () => true,
    ensureRequiredAccess: async (application, appRoles) => {
      const have = declaredGraphRoles(application);
      const add = appRoles.filter((/** @type {{ id: string }} */ r) => !have.has(r.id));
      if (!add.length) return false;
      calls.push(`ensureRequiredAccess ${add.map((/** @type {{ id: string }} */ r) => roleName(r.id)).join(', ')}`);
      declare(application, [...have, ...add.map((/** @type {{ id: string }} */ r) => r.id)]);
      return true;
    },
    removeRequiredAccess: async (application, appRoles) => {
      calls.push(`removeRequiredAccess ${appRoles.map((/** @type {{ id: string }} */ r) => roleName(r.id)).join(', ')}`);
      fail('removeRequiredAccess');
      const drop = new Set(appRoles.map((/** @type {{ id: string }} */ r) => r.id));
      declare(application, [...declaredGraphRoles(application)].filter((id) => !drop.has(id)));
      return true;
    },
    addOwner: async (appObjectId, userId) => {
      calls.push(`addOwner ${appObjectId} ${userId}`);
    },
    me: async () => ({ ...ME }),
    getUser: async (upn) => (String(upn).toLowerCase() === ME.userPrincipalName ? { ...ME } : null),
    subscribedSkus: async () => [],
    myLicenseDetails: async () => [],
    myGroupIds: async () => [],
    myEligibleRoles: async () => [],
    directoryRoleAssignments: async () => [],
    verifiedDomains: async () => ['contoso.com'],
    site: async (id) => {
      calls.push(`site ${id}`);
      fail('site');
      return { id: SITE_ID, webUrl: SITE_URL, displayName: 'Analytics' };
    },
    grantSitePermission: async (siteId, appId, displayName, role) => {
      calls.push(`grantSitePermission ${siteId} ${appId} ${role}`);
      fail('grantSitePermission');
      const identity = [{ application: { id: appId, displayName } }];
      const perm = { id: `perm-${++p}`, roles: [role], grantedToIdentitiesV2: identity, grantedToIdentities: identity };
      perms.push(perm);
      return structuredClone(perm);
    },
    // Like Graph, the list leaves out each app's roles.
    sitePermissions: async () => {
      fail('sitePermissions');
      return perms.map((perm) => {
        const copy = structuredClone(perm);
        delete copy.roles;
        return copy;
      });
    },
    sitePermission: async (_siteId, id) => {
      const perm = perms.find((x) => x.id === id);
      if (!perm) throw httpError(404);
      return structuredClone(perm);
    },
    updateSitePermission: async (siteId, id, role) => {
      calls.push(`updateSitePermission ${siteId} ${id} ${role}`);
      const perm = perms.find((x) => x.id === id);
      if (!perm) throw httpError(404);
      perm.roles = [role];
      return structuredClone(perm);
    },
    deleteSitePermission: async (siteId, id) => {
      calls.push(`deleteSitePermission ${siteId} ${id}`);
      fail('deleteSitePermission');
      const at = perms.findIndex((x) => x.id === id);
      if (at < 0) throw httpError(404);
      perms.splice(at, 1);
    },
    getGroup: async (id) => groups.find((x) => x.id === id) ?? null,
    findGroupByName: async (name) => groups.find((x) => x.displayName === name) ?? null,
    createSecurityGroup: async (o) => {
      const name = typeof o === 'string' ? o : o.displayName;
      calls.push(`createSecurityGroup ${name}`);
      fail('createSecurityGroup');
      const group = { id: GROUP_ID, displayName: name, securityEnabled: true };
      groups.push(group);
      return { ...group };
    },
    groupMembers: async () => [],
    groupUsers: async () => [],
    groupOwners: async () => [{ ...ME }],
    addGroupMember: async (groupId, memberId) => {
      calls.push(`addGroupMember ${groupId} ${memberId}`);
      return true;
    },
    addGroupOwner: async (groupId, ownerId) => {
      calls.push(`addGroupOwner ${groupId} ${ownerId}`);
      return true;
    },
    resolvePrincipal: async (name) => {
      if (String(name).toLowerCase() === ME.userPrincipalName) return { id: ME.id, displayName: ME.userPrincipalName, kind: 'user' };
      const group = groups.find((x) => x.id === name || x.displayName === name);
      return group ? { id: group.id, displayName: group.displayName, kind: 'group' } : null;
    },
  };
  Object.assign(g, more);
  return { ...base, api: g, assigned, perms, groups, graphSp };
}

/** fakePowerBi, plus the workspace, model, report and permission calls the PAX route makes. */
function pbiFake() {
  const base = fakePowerBi();
  const { calls, failures, workspaces, history } = base;
  const p = /** @type {any} */ (base.api);
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  /** @type {any[]} Who has access to the model. */
  const users = [];
  /** @type {Record<string, any>[]} How each model load ends, in turn. Completed when none is scripted. */
  const loads = [];
  const refreshes = p.refreshes;
  let r = 0;
  /** @type {Record<string, (...args: any[]) => any>} */
  const more = {
    createGroup: async (name) => {
      calls.push(`createGroup ${name}`);
      fail('createGroup');
      const ws = { id: 'pbi-ws-1', name };
      workspaces.push(ws);
      return { ...ws };
    },
    deleteGroup: async (id) => {
      calls.push(`deleteGroup ${id}`);
      fail('deleteGroup');
      const at = workspaces.findIndex((w) => w.id === id);
      if (at >= 0) workspaces.splice(at, 1);
    },
    datasets: async () => [],
    reports: async () => [],
    deleteReport: async (ws, id) => {
      calls.push(`deleteReport ${ws} ${id}`);
      fail('deleteReport');
    },
    deleteDataset: async (ws, id) => {
      calls.push(`deleteDataset ${ws} ${id}`);
      fail('deleteDataset');
    },
    refreshNow: async (ws, id) => {
      calls.push(`refreshNow ${ws} ${id}`);
      fail('refreshNow');
      const requestId = `request-${++r}`;
      const at = new Date(START).toISOString();
      history.unshift({ requestId, id: r, refreshType: 'ViaApi', startTime: at, endTime: at, status: 'Completed', ...loads.shift() });
      return requestId;
    },
    refreshes: async (...args) => {
      fail('refreshes');
      return refreshes(...args);
    },
    datasetUsers: async () => {
      fail('datasetUsers');
      return structuredClone(users);
    },
    addDatasetUser: async (ws, ds, body) => {
      calls.push(`addDatasetUser ${ws} ${ds} ${body.identifier} ${body.principalType} ${body.datasetUserAccessRight}`);
      fail('addDatasetUser');
      users.push({ ...body });
    },
  };
  Object.assign(p, more);
  return { ...base, api: p, users, loads };
}

/**
 * The managed apps CLI, faked: it records each call's arguments and answers as the real one does.
 * With `notReady`, the tenant hasn't turned on making apps with the CLI.
 * @param {{ notReady?: boolean }} [o]
 */
function fakeAppCli(o = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {string[]} */
  const shared = [];
  const ok = (/** @type {any} */ data) => ({ ok: true, exitCode: 0, data, stdout: `${JSON.stringify(data)}\n`, stderr: '' });
  const no = (/** @type {string} */ error) => ({ ok: false, exitCode: 1, error, stdout: '', stderr: error });
  /** @param {string[]} args @param {{ cwd?: string }} [opts] */
  const run = async (args, opts = {}) => {
    calls.push([...args]);
    const [group, verb, what] = args;
    if (group === 'auth' && verb === 'status') {
      return ok({ signedIn: true, activeAccount: { username: ME.userPrincipalName }, accounts: [{ username: ME.userPrincipalName }] });
    }
    if (group !== 'app') return no(`The fake CLI doesn't know ${args.join(' ')}`);
    switch (verb) {
      case 'init': {
        if (o.notReady) return no('You do not have permission to create an app in this environment.');
        const made = { appId: APP_ID, environmentId: 'env-1' };
        const dir = opts.cwd ?? tempDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'ms.config.json'), JSON.stringify(made));
        return ok(made);
      }
      case 'deploy':
        return ok({ appPlayUri: APP_URL, warnings: [] });
      case 'share':
        if (what === 'list') return ok({ results: [{ value: shared.map((id) => ({ principalObjectId: id })) }] });
        shared.push(...String(what).split(','));
        return ok({ warnings: [] });
      case 'play':
        return ok({ url: APP_URL });
      case 'delete':
        return ok({ existed: true });
      default:
        return no(`The fake CLI doesn't know ${args.join(' ')}`);
    }
  };
  return { run, calls, shared, verbs: () => calls.map((a) => a.slice(0, 2).join(' ')) };
}

/** What deployTheApp needs, with a fake CLI: a build of the app, the pinned CLI and a folder for the app. @param {any} run */
function appDeps(run) {
  const root = tempDir();
  const distDir = join(root, 'dist');
  mkdirSync(distDir);
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>ValueLens</title>');
  const cliDir = join(root, 'cli');
  const pkg = join(cliDir, 'node_modules', '@microsoft', 'managed-apps-cli');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ dependencies: { '@microsoft/managed-apps-cli': '1.0.0' } }));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@microsoft/managed-apps-cli', version: '1.0.0' }));
  // A stand-in for the CLI's entry point: the installer checks it's there, and the fake run never runs it.
  writeFileSync(join(pkg, 'dist', 'Bin.js'), '');
  return { run, nodeVersion: 'v24.11.0', distDir, cliDir, appDir: join(root, 'app') };
}

/** fakeCtx fills in a Fabric install's IDs, which a new PAX install doesn't have. @param {any} config */
function forgetFabric(config) {
  for (const key of ['workspaceId', 'lakehouseId', 'lakehouseName']) delete config.fabric[key];
  for (const key of ['appId', 'objectId', 'servicePrincipalId']) delete config.app[key];
  delete config.keyVault.uri;
}

/**
 * A tenant and PC ready for a new PAX install, planned as a user taking the defaults would. The
 * clock moves on with each sleep, so watching a run always ends.
 * @param {{ app?: boolean, notReady?: boolean, host?: any, by?: Record<string, any>, workspaces?: { id: string, name: string }[] }} [o]
 */
async function paxSetup(o = {}) {
  const graph = graphFake();
  graph.directoryRoles.push(GLOBAL_ADMIN);
  const pbi = pbiFake();
  pbi.workspaces.push(...(o.workspaces ?? []));
  const fabric = fakeFabric();
  const cli = fakeAppCli({ notReady: o.notReady });
  const deps = appDeps(cli.run);
  const sources = o.app ? { ...realSources(), appDist: deps.distDir } : realSources();
  const ui = byUi({
    by: { [Q.advanced]: false, [Q.folder]: FOLDER, [Q.workspace]: '', [Q.appReg]: 'new', [Q.signIn]: 'later', [Q.shared]: true, [Q.siteLoop]: 'skip', ...o.by },
  });
  const { ctx, config, sleeps, saves } = fakeCtx({ ui: ui.ui, graph: graph.api, powerBi: pbi.api, fabric: fabric.api, sources });
  forgetFabric(config);
  const c = /** @type {any} */ (config);
  c.target = 'pax';
  c.tenantId = 'tenant-1';
  let t = START;
  const x = /** @type {any} */ (ctx);
  x.now = () => new Date(t);
  x.sleep = async (/** @type {number} */ ms) => {
    sleeps.push(ms);
    t += ms;
  };
  const pax = fakePaxHost({ now: () => new Date(t), folderCheck: { ok: true, siteId: SITE_ID, driveId: 'drive-1', folder: PRODUCT.name }, ...o.host });
  if (pax.base) temps.push(pax.base);
  x.paxHost = pax.host;
  x.appDeps = deps;
  const pre = await paxPreflight(ctx);
  await paxPlan(ctx, pre);
  return { ctx, config: c, ui, graph, pbi, fabric, pax, cli, deps, pre, sleeps, saves, tick: (/** @type {number} */ ms) => (t += ms) };
}

/**
 * A new install, done. The output so far is cleared, so a test sees only what it does next.
 * @param {Parameters<typeof paxSetup>[0]} [o]
 */
async function installed(o) {
  const s = await paxSetup(o);
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  s.ui.out.length = 0;
  s.ui.asked.length = 0;
  s.graph.calls.length = 0;
  s.pbi.calls.length = 0;
  s.pax.calls.length = 0;
  s.cli.calls.length = 0;
  return { ...s, installText: text };
}

test('pax flow: the model to give access to, once it is published', { timeout: 10_000 }, () => {
  const config = /** @type {any} */ ({ fabric: {}, semanticModel: { enabled: true } });
  assert.deepEqual(paxModels(config), []);
  config.fabric.workspaceId = 'pbi-ws-1';
  assert.deepEqual(paxModels(config), [], 'not published yet');
  config.semanticModel.id = 'model-1';
  assert.deepEqual(paxModels(config), [{ workspaceId: 'pbi-ws-1', datasetId: 'model-1', name: PRODUCT.pax.model }]);
  config.semanticModel.name = 'Copilot usage';
  assert.deepEqual(paxModels(config), [{ workspaceId: 'pbi-ws-1', datasetId: 'model-1', name: 'Copilot usage' }]);
  delete config.fabric.workspaceId;
  assert.deepEqual(paxModels(config), [], 'no workspace');
});

test('pax flow: how a run ended, from state.json', { timeout: 10_000 }, () => {
  const startedAt = new Date(START).toISOString();
  const at = (/** @type {number} */ seconds) => new Date(START + seconds * 1000).toISOString();
  assert.equal(endedSince(undefined, startedAt), undefined);
  assert.equal(endedSince({}, startedAt), undefined, 'no run yet');
  assert.equal(endedSince({ lastRunUtc: at(-61), lastResult: 'success' }, startedAt), undefined, 'an earlier run');
  assert.deepEqual(endedSince({ lastRunUtc: at(-59), lastResult: 'success' }, startedAt), { status: 'success' }, 'within the clock slack');
  assert.deepEqual(endedSince({ lastRunUtc: at(30), lastResult: 'success', lastError: null, lastLog: 'C:\\x.log' }, startedAt), { status: 'success' });

  const failedRun = endedSince({ lastRunUtc: at(30), lastResult: 'failed', lastError: 'PAX could not sign in.', lastMessage: 'other', lastLog: 'C:\\logs\\refresh.log' }, startedAt);
  assert.equal(failedRun?.status, 'failed');
  assert.equal(failedRun?.error, 'PAX could not sign in.');
  assert.equal(failedRun?.log, 'C:\\logs\\refresh.log');

  const noData = endedSince({ lastRunUtc: at(30), lastResult: 'no-data', lastError: null, lastMessage: 'PAX found no Copilot activity.' }, startedAt);
  assert.equal(noData?.status, 'no-data');
  assert.equal(noData?.error, 'PAX found no Copilot activity.');
  assert.equal(noData?.log, undefined);

  assert.equal(endedSince({ lastRunUtc: at(30), lastResult: 'something new' }, startedAt)?.status, 'failed', 'an unknown result is a failure');

  // refresh.ps1 keeps a load's progress when it stops part way through it, to stay inside the task's time limit.
  const progress = { fromUtc: at(-90 * 86_400), days: 90, seed: false, windowDays: 7, throughUtc: at(-76 * 86_400), pending: null };
  assert.deepEqual(
    endedSince({ lastRunUtc: at(30), lastResult: 'success', lastMessage: 'Loaded up to 2026-03-17.', progress }, startedAt),
    { status: 'success', partial: true, message: 'Loaded up to 2026-03-17.' },
  );
  assert.deepEqual(endedSince({ lastRunUtc: at(30), lastResult: 'success', lastMessage: null, progress }, startedAt), { status: 'success', partial: true });
  assert.equal(endedSince({ lastRunUtc: at(30), lastResult: 'failed', lastError: 'PAX stopped.', progress }, startedAt)?.status, 'failed', 'a failed window is still a failure');

  // A user directory that failed a check before its upload, so SharePoint kept the last good copy.
  const heldBack = { check: 'drop', rows: 4, columns: 3, lastRows: 20, file: HELD_FILE };
  assert.deepEqual(
    endedSince({ lastRunUtc: at(30), lastResult: 'failed', lastError: HELD_MESSAGE, lastMessage: HELD_MESSAGE, heldBack, lastLog: 'C:\\x.log' }, startedAt),
    { status: 'failed', error: HELD_MESSAGE, log: 'C:\\x.log', heldBack: 'drop' },
  );
  assert.deepEqual(
    endedSince({ lastRunUtc: at(30), lastResult: 'failed', lastError: 'PAX stopped.', heldBack: null }, startedAt),
    { status: 'failed', error: 'PAX stopped.', log: undefined },
    'a run that failed for another reason',
  );
  assert.deepEqual(endedSince({ lastRunUtc: at(30), lastResult: 'success', heldBack }, startedAt), { status: 'success' }, 'only a failed run was held back');
  assert.equal(endedSince({ lastRunUtc: at(-61), lastResult: 'failed', heldBack }, startedAt), undefined, 'an earlier run that was held back');
});

/**
 * A first run that started at START and did `run`, before settleFirstRun looks at it.
 * @param {'success' | 'no-data' | 'failed' | 'running' | 'busy'} run
 */
async function firstRun(run) {
  const s = await paxSetup({ host: { run } });
  await registerTask(s.pax.host, { name: PRODUCT.pax.task, at: TASK_AT, description: 'Test task' });
  await startTask(s.pax.host, PRODUCT.pax.task);
  s.config.pax.firstRun = { startedAt: new Date(START).toISOString() };
  return s;
}

test('pax flow: settling the first run does nothing without one', { timeout: 10_000 }, async () => {
  const s = await paxSetup();
  delete s.config.pax.firstRun;
  assert.equal(await settleFirstRun(s.ctx), 'none');
  s.config.pax.firstRun = { startedAt: new Date(START).toISOString() };
  delete s.config.pax.task;
  assert.equal(await settleFirstRun(s.ctx), 'none', 'no task');
  assert.equal(s.saves(), 0);
});

test('pax flow: a first run that worked is cleared from the record', { timeout: 10_000 }, async () => {
  const s = await firstRun('success');
  assert.equal(await settleFirstRun(s.ctx), 'success');
  assert.equal(s.config.pax.firstRun, undefined);
  assert.ok(s.saves() > 0);
});

test('pax flow: a first run that failed stays on the record, with its error and log', { timeout: 10_000 }, async () => {
  const s = await firstRun('failed');
  assert.equal(await settleFirstRun(s.ctx), 'failed');
  assert.equal(s.config.pax.firstRun.result, 'failed');
  assert.equal(s.config.pax.firstRun.error, 'PAX could not sign in.');
  assert.equal(s.config.pax.firstRun.log, join(s.pax.host.root, 'logs', 'refresh.log'));
  assert.ok(s.saves() > 0);
});

test('pax flow: a first run that found no data stays on the record', { timeout: 10_000 }, async () => {
  const s = await firstRun('no-data');
  assert.equal(await settleFirstRun(s.ctx), 'no-data');
  assert.equal(s.config.pax.firstRun.result, 'no-data');
  assert.equal(s.config.pax.firstRun.error, 'PAX found no Copilot activity.');
});

test('pax flow: a first run still running, or held up by another, is kept to look at later', { timeout: 10_000 }, async () => {
  for (const run of /** @type {const} */ (['running', 'busy'])) {
    const s = await firstRun(run);
    const startedAt = s.config.pax.firstRun.startedAt;
    assert.equal(await settleFirstRun(s.ctx), run);
    assert.deepEqual(s.config.pax.firstRun, { startedAt }, run);
    assert.equal(s.saves(), 0, run);
  }
});

/** Whether any call to the fake PC passed an execution-policy bypass. @param {{ args: string[] }[]} calls */
const bypassed = (calls) => calls.some((call) => call.args.some((arg) => /^-ExecutionPolicy$/i.test(arg) || /^Bypass$/i.test(arg)));

test('pax flow: a new install sets up the refresh, the report and the app', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ app: true, by: { [Q.signIn]: 'set' } });
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  const { config, graph, pbi, pax, cli, fabric } = s;
  const host = pax.host;

  // The app registration and its Graph permissions.
  assert.ok(graph.calls.includes(`createApplication ${PRODUCT.pax.app}`), graph.calls.join('\n'));
  const app = graph.applications.find((a) => a.displayName === PRODUCT.pax.app);
  assert.ok(app);
  assert.ok(text.includes(`Created app registration "${PRODUCT.pax.app}" (${app.appId})`), text);
  for (const role of ['AuditLogsQuery.Read.All', 'User.Read.All', 'Sites.Selected', 'Organization.Read.All']) {
    assert.ok(graph.calls.includes(`grantAppRole ${role}`), `${role}: ${graph.calls.join('\n')}`);
  }

  // The client secret goes to Credential Manager on stdin, and nowhere else.
  assert.equal(credentialTarget(config), TARGET);
  const stored = pax.credentials[TARGET];
  assert.ok(stored, JSON.stringify(pax.credentials));
  assert.equal(stored.userName, app.appId);
  assert.match(stored.secret, /^secret-\d+$/);
  const writes = pax.calls.filter((call) => call.key === 'credential Write');
  assert.equal(writes.length, 1);
  assert.ok(String(writes[0].input).includes(stored.secret));
  assert.ok(pax.calls.every((call) => !call.args.join(' ').includes(stored.secret)), 'never on a command line');
  assert.ok(!JSON.stringify(config).includes(stored.secret), 'never in the record');
  assert.ok(!text.includes(stored.secret), 'never on screen');
  assert.ok(text.includes(`stored it in Credential Manager as ${TARGET}`), text);

  // Write access to the folder's site, and only that site.
  assert.ok(graph.calls.includes(`grantSitePermission ${SITE_ID} ${app.appId} write`), graph.calls.join('\n'));
  assert.equal(graph.perms.length, 1);
  assert.ok(text.includes(`write access to ${SITE_URL}, and to no other site`), text);

  // The scripts, refresh.json and the daily task.
  const paths = paxPaths(host);
  assert.ok(existsSync(join(paths.scripts, 'refresh.ps1')));
  assert.ok(existsSync(paths.config));
  const settings = readFileSync(paths.config, 'utf8');
  assert.doesNotThrow(() => JSON.parse(settings));
  assert.ok(!settings.includes(stored.secret), 'no secret in refresh.json');
  assert.ok(text.includes(`Wrote the refresh scripts and settings to ${host.root}`), text);
  const task = pax.tasks[PRODUCT.pax.task];
  assert.ok(task, Object.keys(pax.tasks).join(', '));
  assert.equal(task.at, TASK_AT);
  assert.equal(task.runLevel, 'Limited');
  assert.equal(config.pax.task.name, PRODUCT.pax.task);
  assert.ok(config.pax.task.registeredAt);
  assert.ok(text.includes(`Scheduled ${PRODUCT.pax.task} daily at ${TASK_AT}, as PC\\admin.`), text);
  assert.ok(!bypassed(pax.calls), 'no execution-policy bypass');

  // The report, in a new workspace.
  assert.ok(pbi.calls.some((call) => call.startsWith(`createGroup ${PRODUCT.pax.workspace}`)), pbi.calls.join('\n'));
  assert.equal(config.fabric.workspaceId, 'pbi-ws-1');
  assert.equal(config.fabric.createdWorkspace, true);
  assert.ok(fabric.calls.some((call) => call.startsWith('createSemanticModel')), fabric.calls.join('\n'));
  const model = config.semanticModel.id;
  assert.ok(model);
  assert.ok(config.semanticModel.report?.id, JSON.stringify(config.semanticModel));

  // The viewer group can build on the model, and has no workspace role.
  assert.ok(graph.calls.includes(`createSecurityGroup ${PRODUCT.viewerGroup}`), graph.calls.join('\n'));
  assert.equal(config.access.groupId, GROUP_ID);
  assert.ok(pbi.calls.includes(`addDatasetUser pbi-ws-1 ${model} ${GROUP_ID} Group ReadExplore`), pbi.calls.join('\n'));
  assert.ok(!pbi.calls.some((call) => call.startsWith('addGroupUser') && call.includes(GROUP_ID)), 'no workspace role for the viewers');
  assert.ok(text.includes(`${PRODUCT.viewerGroup} can build on`), text);

  // Asked once to share the report by hand.
  assert.equal(s.ui.asked.filter((m) => m === Q.shared).length, 1);
  assert.equal(config.access.reportShared, true);
  assert.equal(shareReportPending(config), false);

  // The app, shared with the viewers.
  assert.ok(cli.verbs().includes('app init') && cli.verbs().includes('app deploy'), cli.verbs().join('\n'));
  assert.deepEqual(cli.shared, [GROUP_ID]);
  assert.equal(config.managedApp.appId, APP_ID);
  assert.equal(config.managedApp.url, APP_URL);
  assert.deepEqual(config.managedApp.sharedWith, [GROUP_ID]);
  assert.ok(text.includes(`is live: ${APP_URL}`), text);

  // Signed in, scheduled, run once, then the model loaded.
  assert.ok(pbi.calls.includes(`setRefreshSchedule pbi-ws-1 ${model}`), pbi.calls.join('\n'));
  assert.ok(pax.keys().includes('task Start'));
  assert.ok(text.includes(`Started ${PRODUCT.pax.task}.`), text);
  assert.ok(text.includes('The refresh finished, and the rollups are in SharePoint.'), text);
  assert.equal(config.pax.firstRun, undefined, 'the first run worked');
  assert.ok(pbi.calls.includes(`refreshNow pbi-ws-1 ${model}`), pbi.calls.join('\n'));

  // The summary.
  assert.ok(text.includes(`${PRODUCT.name} is set up`), text);
  assert.ok(text.includes(`Task:       ${PRODUCT.pax.task}, daily at ${TASK_AT}`), text);
  assert.ok(text.includes(`Secret:     Credential Manager, ${TARGET}`), text);
  assert.ok(text.includes(`App:        ${APP_URL}`), text);
  assert.doesNotMatch(text, /App Edition/i);
  assert.ok(s.saves() > 0);
});

test('pax flow: when the tenant isn\'t ready for the app, the install finishes at the report', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ app: true, notReady: true });
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.ok(s.config.semanticModel.id, 'the report is published');
  assert.match(text, /can't be deployed until a Power Platform admin turns on app creation with the managed apps CLI/);
  assert.ok(text.includes('The report works without it.'), text);
  assert.deepEqual(s.config.managedApp?.missing, ['createApps']);
  assert.equal(s.config.managedApp?.url, undefined);
  assert.ok(!s.cli.verbs().includes('app deploy'), s.cli.verbs().join('\n'));
  assert.ok(text.includes(`${PRODUCT.name} is set up`), text);
  assert.ok(text.includes('Ask for managed apps to be turned on'), text);
  assert.doesNotMatch(text, /App Edition/i);
});

test('pax flow: running the install again repairs it without making anything twice', { timeout: 10_000 }, async () => {
  const s = await installed({ app: true });
  const ctx = /** @type {any} */ (s.ctx);
  delete ctx.runFirstLoad;
  const pre = await paxPreflight(s.ctx);
  await paxPlan(s.ctx, pre);
  const ok = await paxInstall(s.ctx, pre);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  const { graph, pbi, pax, cli, config } = s;
  assert.ok(!graph.calls.some((c) => c.startsWith('createApplication')), graph.calls.join('\n'));
  assert.ok(!graph.calls.some((c) => c.startsWith('addPassword')), 'the secret is still good');
  assert.ok(!pax.keys().includes('credential Write'));
  assert.ok(text.includes(`The client secret is in Credential Manager as ${TARGET}, until`), text);
  assert.ok(!pax.keys().includes('task Register'), `the task is current: ${pax.keys().join(', ')}`);
  assert.ok(text.includes(`The task ${PRODUCT.pax.task} is already scheduled, daily at ${TASK_AT}.`), text);
  assert.ok(!graph.calls.some((c) => c.startsWith('grantSitePermission')), graph.calls.join('\n'));
  assert.equal(graph.perms.length, 1);
  assert.ok(!pbi.calls.some((c) => c.startsWith('createGroup')), pbi.calls.join('\n'));
  assert.ok(!graph.calls.some((c) => c.startsWith('createSecurityGroup')));
  assert.ok(!pbi.calls.some((c) => c.startsWith('addDatasetUser')), 'the viewers can already build on the model');
  assert.ok(!s.ui.asked.includes(Q.shared), 'the report was shared');
  assert.ok(!cli.verbs().includes('app init') && !cli.verbs().includes('app deploy'), cli.verbs().join('\n'));
  assert.ok(text.includes(`is up to date: ${APP_URL}`), text);
  assert.equal(config.managedApp.appId, APP_ID);
  assert.ok(text.includes(`${PRODUCT.name} is set up`), text);
});

test('pax flow: switching the Agent 365 file off takes back its permissions and their consent', { timeout: 10_000 }, async () => {
  const s = await installed();
  const ctx = /** @type {any} */ (s.ctx);
  const { graph, config } = s;
  const AGENT365 = 'Application.Read.All, CopilotPackages.Read.All';
  const name = (/** @type {string} */ id) => graph.graphSp.appRoles.find((r) => r.id === id)?.value ?? id;
  const consented = () => graph.assigned.filter((a) => a.principalId === config.app.servicePrincipalId).map((a) => name(a.appRoleId)).sort();
  const declared = async () => [...declaredGraphRoles(await graph.api.findApplication(config.app.appId))].map(name).sort();
  const base = ['AuditLogsQuery.Read.All', 'Organization.Read.All', 'Sites.Selected', 'User.Read.All'];
  const all = [...base, 'Application.Read.All', 'CopilotPackages.Read.All'].sort();
  assert.deepEqual(await declared(), base);
  assert.deepEqual(consented(), base);

  /** Runs the install again, as a new run of the installer would. @param {boolean} agent365 */
  const rerun = async (agent365) => {
    s.ui.out.length = 0;
    s.ui.asked.length = 0;
    graph.calls.length = 0;
    delete ctx.runFirstLoad;
    delete ctx.graphRoles;
    config.pax.agent365 = agent365;
    const pre = await paxPreflight(s.ctx);
    await paxPlan(s.ctx, pre);
    const ok = await paxInstall(s.ctx, pre);
    const text = plain(s.ui.text());
    assert.equal(ok, true, text);
    return text;
  };

  let text = await rerun(true);
  assert.ok(graph.calls.includes(`ensureRequiredAccess ${AGENT365}`), graph.calls.join('\n'));
  assert.ok(graph.calls.includes('grantAppRole Application.Read.All') && graph.calls.includes('grantAppRole CopilotPackages.Read.All'), graph.calls.join('\n'));
  assert.ok(!graph.calls.some((c) => c.startsWith('removeRequiredAccess') || c.startsWith('revokeAppRole')), graph.calls.join('\n'));
  assert.deepEqual(await declared(), all);
  assert.deepEqual(consented(), all);

  // Off, signed in as someone who can't consent: the API permissions come off, and the consent stays with a link.
  graph.directoryRoles.length = 0;
  text = await rerun(false);
  assert.ok(graph.calls.includes(`removeRequiredAccess ${AGENT365}`), graph.calls.join('\n'));
  assert.ok(text.includes(`Took ${AGENT365} off its API permissions, as ${PRODUCT.name} no longer uses them`), text);
  assert.ok(!graph.calls.some((c) => c.startsWith('revokeAppRole')), graph.calls.join('\n'));
  assert.ok(text.includes(`${PRODUCT.pax.app} still has admin consent for ${AGENT365}, which ${PRODUCT.name} no longer uses.`), text);
  assert.ok(text.includes(`CallAnAPI/appId/${config.app.appId}`), text);
  assert.deepEqual(await declared(), base);
  assert.deepEqual(consented(), all);

  // Again, as someone who can: the consent is taken back, and nothing else changes.
  graph.directoryRoles.push(GLOBAL_ADMIN);
  text = await rerun(false);
  assert.ok(!graph.calls.some((c) => c.startsWith('removeRequiredAccess') || c.startsWith('ensureRequiredAccess')), graph.calls.join('\n'));
  assert.deepEqual(graph.calls.filter((c) => c.startsWith('revokeAppRole')), ['revokeAppRole Application.Read.All', 'revokeAppRole CopilotPackages.Read.All']);
  assert.ok(text.includes(`Took back admin consent for ${AGENT365}, as ${PRODUCT.name} no longer uses them`), text);
  assert.ok(!text.includes('still has admin consent'), text);
  assert.deepEqual(await declared(), base);
  assert.deepEqual(consented(), base);
  assert.ok(!graph.calls.some((c) => c.startsWith('grantAppRole')), 'the roles it uses keep their consent');

  // A run with nothing to take back says nothing about it.
  text = await rerun(false);
  assert.ok(!graph.calls.some((c) => c.startsWith('revokeAppRole') || c.startsWith('removeRequiredAccess')), graph.calls.join('\n'));
  assert.ok(!text.includes('no longer uses'), text);

  // On again, then off by someone who can consent but can't edit the app: the consent still goes.
  await rerun(true);
  assert.deepEqual(await declared(), all);
  assert.deepEqual(consented(), all);
  graph.failures.removeRequiredAccess = [httpError(403, 'Forbidden')];
  text = await rerun(false);
  assert.ok(text.includes(`You can't edit ${PRODUCT.pax.app}'s API permissions, so it still lists ${AGENT365}, which ${PRODUCT.name} no longer uses. An admin can remove them.`), text);
  assert.ok(text.includes(`Took back admin consent for ${AGENT365}`), text);
  assert.deepEqual(await declared(), all);
  assert.deepEqual(consented(), base);
});

test('pax flow: sharing the report later leaves a card, and the next run asks again', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ by: { [Q.shared]: false } });
  assert.equal(await paxInstall(s.ctx, s.pre), true);
  const text = plain(s.ui.text());
  assert.equal(s.ui.asked.filter((m) => m === Q.shared).length, 1);
  assert.equal(shareReportPending(s.config), true);
  const summary = text.slice(text.lastIndexOf(`${PRODUCT.name} is set up`));
  assert.match(summary, /share/i, summary);

  s.ui.out.length = 0;
  s.ui.asked.length = 0;
  s.ui.by[Q.shared] = true;
  delete /** @type {any} */ (s.ctx).runFirstLoad;
  const pre = await paxPreflight(s.ctx);
  await paxPlan(s.ctx, pre);
  assert.equal(await paxInstall(s.ctx, pre), true);
  assert.equal(s.ui.asked.filter((m) => m === Q.shared).length, 1, 'asked again');
  assert.equal(shareReportPending(s.config), false);
  assert.ok(!s.pbi.calls.some((c) => c.startsWith('addGroupUser')), 'still no workspace role for the viewers');
});

test('pax flow: a report that can\'t be published leaves the install partly set up', { timeout: 10_000 }, async () => {
  const s = await paxSetup();
  s.pbi.failures.createGroup = [httpError(500, 'Power BI is down')];
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, false, text);
  assert.ok(text.includes("Couldn't publish the report:"), text);
  assert.ok(text.includes('Skipped until the report is published.'), text);
  assert.ok(!s.graph.calls.some((c) => c.startsWith('createSecurityGroup')), 'no viewer access without a report');
  assert.ok(s.pax.tasks[PRODUCT.pax.task], 'the refresh is still set up');
  assert.ok(text.includes(`${PRODUCT.name} is partly set up`), text);
});

test('pax flow: a first run that fails is reported with its log', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ host: { run: 'failed' } });
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, false, text);
  assert.ok(text.includes('The refresh failed: PAX could not sign in.'), text);
  assert.ok(text.includes(`Log: ${join(s.pax.host.root, 'logs', 'refresh.log')}`), text);
  assert.equal(s.config.pax.firstRun?.result, 'failed');
  assert.equal(s.config.pax.firstRun?.error, 'PAX could not sign in.');
  assert.ok(text.includes(`${PRODUCT.name} is partly set up`), text);
});

test('pax flow: a first run whose user directory fails a check warns with the check and the counts, and is left to fix', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ host: { run: 'held-upn' } });
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, false, text);
  assert.ok(text.includes(`! ${HELD_UPN_MESSAGE}`), text);
  assert.ok(!text.includes('The refresh failed'), text);
  assert.ok(text.includes(`Log: ${join(s.pax.host.root, 'logs', 'refresh.log')}`), text);
  assert.equal(s.config.pax.firstRun?.result, 'failed');
  assert.equal(s.config.pax.firstRun?.error, HELD_UPN_MESSAGE, 'the next-steps card says which check it failed');
  assert.ok(!s.pbi.calls.some((c) => c.startsWith('refreshNow')), 'nothing new reached SharePoint');
  assert.ok(text.includes(`${PRODUCT.name} is partly set up`), text);
});

test('pax flow: a first run that takes a while is left to run in the background', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ host: { run: 'running' } });
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.match(text, /still running, in the background/);
  assert.ok(s.sleeps.length > 0, 'it watched for a while');
  assert.ok(s.config.pax.firstRun?.startedAt);
  assert.equal(s.config.pax.firstRun?.result, undefined);
  assert.ok(text.includes(`${PRODUCT.name} is set up`), text);
});

test('pax flow: without waiting, the first run is started and left to run', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ host: { run: 'running' } });
  const ok = await paxInstall(s.ctx, s.pre, { wait: false });
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.ok(s.pax.keys().includes('task Start'));
  assert.ok(text.includes(`Started ${PRODUCT.pax.task}.`), text);
  assert.ok(s.config.pax.firstRun?.startedAt);
});

test('pax flow: status shows the task, the last run, the secret, the model and the app', { timeout: 10_000 }, async () => {
  const s = await installed({ app: true, by: { [Q.signIn]: 'set' } });
  const ok = await paxStatus(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.ok(text.includes(`Task:         ${PRODUCT.pax.task}, Ready, daily at ${TASK_AT}`), text);
  assert.match(text, /Last run: +success, /);
  assert.ok(text.includes(`Secret:       ${TARGET}, expires `), text);
  assert.ok(text.includes('Files:        '), text);
  assert.match(text, /^Power BI$/m);
  assert.match(text, /Model: +Completed, /);
  assert.ok(text.includes(`Schedule:     daily at ${refreshTimes(TASK_AT).join(' and ')} (${s.config.powerBi.timeZone ?? 'UTC'})`), text);
  assert.ok(text.includes(`App:          ${APP_URL}`), text);
});

test('pax flow: status says when the daily refresh is off, and a refresh that works turns it back on', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  s.pbi.schedule.enabled = false;
  let text = '';
  const look = async () => {
    s.ui.out.length = 0;
    const ok = await paxStatus(s.ctx);
    text = plain(s.ui.text());
    return ok;
  };
  assert.equal(await look(), false, text);
  assert.ok(text.includes(`! The model's daily refresh is off. ${SCHEDULE_OFF_WHY}`), text);
  assert.ok(text.includes(`    It turns back on after a refresh that works. To refresh now, run: ${commandLine('refresh')}`), text);
  assert.ok(!text.includes('Schedule:'), text);

  s.ui.out.length = 0;
  assert.equal(await paxCommand(s.ctx, 'refresh'), true, plain(s.ui.text()));
  assert.ok(plain(s.ui.text()).includes("daily refresh off. "), plain(s.ui.text()));
  assert.equal(s.pbi.schedule.enabled, true);
  assert.equal(await look(), true, text);
  assert.ok(text.includes('Schedule:     daily at '), text);

  s.pbi.failures.refreshSchedule = [httpError(500, 'Internal error')];
  assert.equal(await look(), true, text);
  assert.ok(text.includes("! Couldn't read the model's refresh schedule: Internal error"), text);

  // Before the model is signed in, there's no schedule to look at.
  const later = await installed();
  later.pbi.schedule.enabled = false;
  assert.equal(await paxStatus(later.ctx), true, plain(later.ui.text()));
  assert.ok(!later.pbi.calls.some((c) => c.startsWith('refreshSchedule ')), later.pbi.calls.join('\n'));
});

test('pax flow: status says when the task or the secret has gone from this PC', { timeout: 10_000 }, async () => {
  const s = await installed();
  delete s.pax.tasks[PRODUCT.pax.task];
  delete s.pax.credentials[TARGET];
  const ok = await paxStatus(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, false, text);
  assert.ok(text.includes(`The task ${PRODUCT.pax.task} isn't on this PC. To set it up again, run: ${commandLine('update')}`), text);
  assert.ok(text.includes(`The client secret isn't in Credential Manager on this PC. To put a new one there, run: ${commandLine('rotate-secret')}`), text);
});

test('pax flow: status reports a failed run and a model that has gone', { timeout: 10_000 }, async () => {
  const s = await installed();
  s.pax.finishRun('failed');
  s.pbi.failures.refreshes = [httpError(404)];
  const ok = await paxStatus(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, false, text);
  assert.match(text, /Last run: +failed, /);
  assert.ok(text.includes('! PAX could not sign in.'), text);
  assert.ok(text.includes(`The model isn't in the workspace any more. To publish it again, run: ${commandLine('update')}`), text);
});

test('pax flow: status says when the last run held the user directory back, with the check and the counts', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  s.pax.finishRun('held');
  const ok = await paxStatus(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, false, text);
  assert.match(text, /^ +Last run: +held back, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
  assert.doesNotMatch(text, /Last run: +failed/);
  assert.ok(text.includes(`! ${HELD_MESSAGE}`), text);
  assert.ok(HELD_MESSAGE.endsWith(`If the drop is genuine, run: ${commandLine('run --accept-drop')}`), 'it says how to publish a genuine drop');

  // A run that failed for another reason isn't held back.
  s.ui.out.length = 0;
  s.pax.finishRun('failed');
  assert.equal(await paxStatus(s.ctx), false);
  assert.match(plain(s.ui.text()), /Last run: +failed, /);
});

test('pax flow: the summary says when the set-up is partly done', { timeout: 10_000 }, async () => {
  const s = await installed();
  paxSummary(s.ctx, { ok: false });
  const text = plain(s.ui.text());
  assert.ok(text.includes(`${PRODUCT.name} is partly set up`), text);
  assert.ok(text.includes("A step above didn't finish."), text);
  assert.ok(text.includes(`Task:       ${PRODUCT.pax.task}, daily at ${TASK_AT}`), text);
  assert.ok(text.includes(`Keep ${PRODUCT.recordFile}`), text);
});

test('pax flow: the summary links the report, and opens each link in the install\'s tenant', { timeout: 10_000 }, async () => {
  const s = await installed();
  s.config.fabric.workspaceId = 'ws-1';
  s.config.semanticModel.id = 'ds-9';
  s.config.semanticModel.report = { id: 'rep-1', name: PRODUCT.pax.report };
  s.config.tenantId = 'tenant-1';
  s.ctx.user = { ...(s.ctx.user ?? {}), tenantId: 'tenant-1' };
  paxSummary(s.ctx, { ok: true });
  const text = plain(s.ui.text());
  assert.match(text, /Workspace: .*\/groups\/ws-1\?ctid=tenant-1/, text);
  assert.match(text, /Model: +https:\/\/app\.powerbi\.com\/groups\/ws-1\/datasets\/ds-9\/details\?ctid=tenant-1/, text);
  assert.match(text, /Report: +https:\/\/app\.powerbi\.com\/groups\/ws-1\/reports\/rep-1\?ctid=tenant-1/, text);
});

test('pax flow: the summary says the app shows sample data until the CSVs are picked, and which account to open it with', { timeout: 10_000 }, async () => {
  const s = await installed();
  s.config.managedApp = { ...(s.config.managedApp ?? {}), url: 'https://apps.example/play/app-1' };
  s.ctx.user = { ...(s.ctx.user ?? {}), upn: 'admin@example.test' };
  paxSummary(s.ctx, { ok: true });
  const text = plain(s.ui.text());
  assert.match(text, /App: +https:\/\/apps\.example\/play\/app-1/, text);
  assert.match(text, /sample data, labelled Sample data, until you choose Change data and pick the CSV files from the SharePoint folder https:\/\//, text);
  assert.match(text, /Open the app signed in as admin@example\.test/, text);
});

test('pax flow: commands that need the refresh set up say how to set it up', { timeout: 10_000 }, async () => {
  const s = await paxSetup();
  const before = { pc: s.pax.calls.length, graph: s.graph.calls.length, pbi: s.pbi.calls.length };
  const message = `The PAX refresh isn't set up from ${PRODUCT.recordFile} yet. To set it up, run: ${commandLine('install')}`;
  for (const command of ['update', 'run', 'status', 'check', 'refresh', 'rotate-secret']) {
    await assert.rejects(paxCommand(s.ctx, command), { message }, command);
  }
  await assert.rejects(paxCommand(s.ctx, 'rerun-failed'), { message: `rerun-failed is for the Fabric route. To run PAX again now, run: ${commandLine('run')}` });
  await assert.rejects(paxCommand(s.ctx, 'nonsense'), { message: '"nonsense" isn\'t a command on the PAX + SharePoint route.' });
  assert.deepEqual({ pc: s.pax.calls.length, graph: s.graph.calls.length, pbi: s.pbi.calls.length }, before, 'nothing ran');
  assert.ok(!plain(s.ui.text()).includes(`Updating ${PRODUCT.name}`), 'update stopped before its heading');
});

test('pax flow: update says what it is doing before it checks anything', { timeout: 10_000 }, async () => {
  const s = await installed();
  delete /** @type {any} */ (s.ctx).runFirstLoad;
  const ok = await paxCommand(s.ctx, 'update');
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  const heading = text.indexOf(`Updating ${PRODUCT.name}`);
  assert.ok(heading >= 0, text);
  assert.ok(text.indexOf('Checking your tenant') > heading, text);
  assert.ok(text.indexOf('Checking this PC') > heading, text);
  assert.ok(!s.graph.calls.some((c) => c.startsWith('createApplication')), s.graph.calls.join('\n'));
  assert.ok(text.includes(`${PRODUCT.name} is set up`), text);
});

test('pax flow: access points to deploy-app when the app isn\'t shared with the viewer group', { timeout: 10_000 }, async () => {
  const s = await installed({ app: true });
  const hint = `The ${PRODUCT.managedApp.name} app isn't shared with ${PRODUCT.viewerGroup} yet. To share it, run: ${commandLine('deploy-app')}`;
  assert.equal(await paxCommand(s.ctx, 'access'), true);
  assert.ok(!plain(s.ui.text()).includes(hint), 'shared already');

  s.config.managedApp.sharedWith = ['55555555-5555-4555-8555-555555555555'];
  s.ui.out.length = 0;
  assert.equal(await paxCommand(s.ctx, 'access'), true);
  assert.ok(plain(s.ui.text()).includes(hint), s.ui.text());

  delete s.config.managedApp.deployedAt;
  s.ui.out.length = 0;
  assert.equal(await paxCommand(s.ctx, 'access'), true);
  assert.ok(!plain(s.ui.text()).includes(hint), 'not deployed');
});

test('pax flow: deploy-app deploys the app and shares it with the viewers', { timeout: 10_000 }, async () => {
  const s = await installed();
  assert.equal(s.config.managedApp, undefined, 'no build of the app at install');
  assert.equal(await paxCommand(s.ctx, 'deploy-app'), true, plain(s.ui.text()));
  assert.ok(s.cli.verbs().includes('app deploy'), s.cli.verbs().join('\n'));
  assert.equal(s.config.pax.deployApp, true);
  assert.equal(s.config.managedApp.url, APP_URL);
  assert.deepEqual(s.cli.shared, [GROUP_ID]);
});

test('pax flow: run --backfill-days reads that much history, and a shorter one never shortens it', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  assert.equal(s.config.history.days, 30, 'the first load\'s history');
  assert.equal(await paxCommand(s.ctx, 'run', { backfillDays: 90 }), true, plain(s.ui.text()));
  assert.deepEqual(s.pax.refreshes, [{ days: 90 }]);
  assert.equal(s.config.history.days, 90);
  const text = plain(s.ui.text());
  assert.ok(text.includes('Read 90 days of the audit log and added them to the rollups in SharePoint.'), text);
  assert.ok(!s.pax.keys().includes('task Start'), 'read on this PC, not by the task');
  assert.ok(s.pbi.calls.some((c) => c.startsWith('refreshNow pbi-ws-1 ')), 'the model loads the new rollups');
  assert.ok(s.saves() > 0);

  assert.equal(await paxCommand(s.ctx, 'run', { backfillDays: 10 }), true);
  assert.deepEqual(s.pax.refreshes.at(-1), { days: 10 });
  assert.equal(s.config.history.days, 90, 'the rollups keep the longer history');
  assert.ok(!bypassed(s.pax.calls), 'no execution-policy bypass');
});

test('pax flow: run --backfill-days when a refresh is running, finds nothing or fails', { timeout: 10_000 }, async () => {
  const s = await installed();
  s.pax.setRun('busy');
  assert.equal(await paxCommand(s.ctx, 'run', { backfillDays: 60 }), false);
  let text = plain(s.ui.text());
  assert.ok(text.includes(`A refresh is already running on this PC. When it's done, run: ${commandLine('run --backfill-days 60')}`), text);
  assert.equal(s.config.history.days, 30);

  s.ui.out.length = 0;
  s.pax.setRun('no-data');
  assert.equal(await paxCommand(s.ctx, 'run', { backfillDays: 60 }), true);
  text = plain(s.ui.text());
  assert.ok(text.includes('PAX found no Copilot audit records in the last 60 days.'), text);
  assert.equal(s.config.history.days, 30, 'nothing read, so no longer history');

  s.pax.setRun('failed');
  await assert.rejects(paxCommand(s.ctx, 'run', { backfillDays: 60 }), /^Error: The refresh failed \(exit code 1\): .*PAX could not sign in\./);
  assert.equal(s.config.history.days, 30);
  assert.deepEqual(s.pax.refreshes, [{ days: 60 }, { days: 60 }, { days: 60 }]);
});

test('pax flow: a reload that stops part way says so, and status shows how far the load has got', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  const status = async () => {
    s.ui.out.length = 0;
    assert.equal(await paxStatus(s.ctx), true, plain(s.ui.text()));
    return plain(s.ui.text());
  };
  assert.doesNotMatch(await status(), /History:/, 'no load carries on');

  s.ui.out.length = 0;
  s.pax.setRun('partial');
  assert.equal(await paxCommand(s.ctx, 'run', { backfillDays: 120 }), true, plain(s.ui.text()));
  const text = plain(s.ui.text());
  assert.ok(text.includes(PARTIAL_MESSAGE), text);
  assert.ok(!text.includes('Read 120 days of the audit log'), text);
  assert.equal(s.config.history.days, 120, 'the scheduled runs read the rest');
  assert.ok(s.pbi.calls.some((c) => c.startsWith('refreshNow pbi-ws-1 ')), 'the model loads what was read');

  assert.match(
    await status(),
    /^ +History: +loading 120 days of activity, read up to \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC so far\. Each run carries on where the last one stopped\.$/m,
  );
  const state = /** @type {any} */ (readState(s.pax.host));
  delete state.progress.throughUtc;
  s.pax.writeState(state);
  assert.match(await status(), /^ +History: +loading 120 days of activity, none read yet\./m);
  assert.doesNotMatch(await status(), /Window:/, 'no window is part way');
  state.progress.pending = { from: state.progress.fromUtc, to: state.progress.fromUtc, days: 7, first: false, early: true, index: 2, count: 5 };
  s.pax.writeState(state);
  assert.match(await status(), /^ +Window: +2 of 5 \(7 days\), where the last run stopped$/m);
  state.progress.pending = { ...state.progress.pending, index: 1, count: 1 };
  s.pax.writeState(state);
  assert.doesNotMatch(await status(), /Window:/, 'a run with one window has no window count');
  delete state.progress.pending;
  state.progress.windowDays = 120;
  s.pax.writeState(state);
  assert.doesNotMatch(await status(), /History:/, 'a one-window load finishes in one run');
});

test('pax flow: install records the Copilot seats, and a small tenant gets a few large audit searches', { timeout: 10_000 }, async () => {
  const s = await paxSetup({ by: { [Q.signIn]: 'set' } });
  s.pre.seats = 40;
  assert.equal(await paxInstall(s.ctx, s.pre), true, plain(s.ui.text()));
  assert.equal(s.config.pax.seats, 40);
  const refresh = JSON.parse(readFileSync(paxPaths(s.pax.host).config, 'utf8'));
  assert.equal(refresh.partitionHours, 72);
  assert.equal(refresh.maxSearches, 5);
  // A repair whose seat count can't be read keeps the last one.
  s.pre.seats = undefined;
  assert.equal(await paxInstall(s.ctx, s.pre), true, plain(s.ui.text()));
  assert.equal(s.config.pax.seats, 40);
});

test('pax flow: status warns while a history load reads its days without the day before', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  const status = async () => {
    s.ui.out.length = 0;
    assert.equal(await paxStatus(s.ctx), true, plain(s.ui.text()));
    return plain(s.ui.text());
  };
  s.pax.setRun('partial');
  assert.equal(await paxCommand(s.ctx, 'run', { backfillDays: 120 }), true, plain(s.ui.text()));
  assert.doesNotMatch(await status(), /without the day before/);
  const state = /** @type {any} */ (readState(s.pax.host));
  state.progress.noOverlap = true;
  s.pax.writeState(state);
  const text = await status();
  assert.ok(text.includes(
    "! The history load reads its days without the day before, because a run that read one day with the day before didn't finish inside the task's time limit. So each day can miss the activity between midnight UTC and midnight in this PC's time zone.",
  ), text);
  assert.match(text, /^ +History: +loading 120 days of activity/m, 'the load still shows how far it has got');
});

test('pax flow: a run that stops part way through a long load says the next run carries on', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  rmSync(paxPaths(s.pax.host).state);
  s.pax.setRun('partial');
  assert.equal(await paxCommand(s.ctx, 'run'), true, plain(s.ui.text()));
  const text = plain(s.ui.text());
  assert.ok(text.includes(PARTIAL_MESSAGE), text);
  assert.ok(!text.includes('The refresh finished, and the rollups are in SharePoint.'), text);
  assert.equal(s.config.pax.firstRun, undefined, 'it worked, as far as it went');
  assert.ok(s.pbi.calls.some((c) => c.startsWith('refreshNow pbi-ws-1 ')), 'the model loads what was read');
});

test('pax flow: run starts the task, as a first run until one has worked', { timeout: 10_000 }, async () => {
  const s = await installed();
  assert.equal(await paxCommand(s.ctx, 'run'), true, plain(s.ui.text()));
  assert.deepEqual(s.pax.keys().filter((k) => k.startsWith('task')).slice(0, 1), ['task Start']);
  assert.equal(s.pax.refreshes.length, 0, 'the task runs it, not this command');
  assert.equal(s.config.pax.firstRun, undefined, 'a run worked before');
  assert.ok(plain(s.ui.text()).includes('The refresh finished, and the rollups are in SharePoint.'));

  rmSync(paxPaths(s.pax.host).state);
  s.pax.setRun('running');
  s.ui.out.length = 0;
  assert.equal(await paxCommand(s.ctx, 'run', { wait: false }), true);
  const text = plain(s.ui.text());
  assert.ok(text.includes(`It runs in the background. To see how it's going, run: ${commandLine('status')}`), text);
  assert.ok(s.config.pax.firstRun?.startedAt, 'no run has worked on this PC, so it is the first');
});

test('pax flow: a run that holds the user directory back warns with the check and the counts, and leaves the model as it was', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  s.pax.setRun('held');
  assert.equal(await paxCommand(s.ctx, 'run'), false, plain(s.ui.text()));
  const text = plain(s.ui.text());
  assert.ok(text.includes(`! ${HELD_MESSAGE}`), text);
  assert.ok(!text.includes('The refresh failed'), text);
  assert.ok(text.includes(`Log: ${join(s.pax.host.root, 'logs', 'refresh.log')}`), text);
  assert.ok(s.pax.keys().includes('task Start'), s.pax.keys().join(', '));
  assert.deepEqual(s.pax.refreshes, [], 'the task ran it');
  assert.ok(!s.pbi.calls.some((c) => c.startsWith('refreshNow')), 'SharePoint kept the last file, so the model has nothing new to load');
});

test('pax flow: a run asked to accept a drop refuses, since this refresh reads the audit log, and runs nothing', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.signIn]: 'set' } });
  await assert.rejects(paxCommand(s.ctx, 'run', { acceptDrop: true }), {
    message: `--accept-drop is for a refresh that reads only the user directory, and this one reads the audit log. To run it now, run: ${commandLine('run')}`,
  });
  assert.deepEqual(s.pax.refreshes, []);
  assert.ok(!s.pax.keys().includes('task Start'), s.pax.keys().join(', '));
  assert.ok(!s.pbi.calls.some((c) => c.startsWith('refreshNow')));
});

test('pax flow: an install asked to reload history reads it on this PC instead of starting the task', { timeout: 10_000 }, async () => {
  const s = await paxSetup();
  /** @type {any} */ (s.ctx).reloadHistoryDays = 120;
  const ok = await paxInstall(s.ctx, s.pre);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.match(text, /Reload audit history/);
  assert.doesNotMatch(text, /First load/);
  assert.deepEqual(s.pax.refreshes, [{ days: 120 }]);
  assert.ok(!s.pax.keys().includes('task Start'));
  assert.equal(s.config.history.days, 120);
});

test('pax flow: uninstall takes the route off and says what it left alone', { timeout: 10_000 }, async () => {
  const s = await installed({ app: true });
  const { config, graph, pbi, pax, cli } = s;
  const keyId = config.pax.secretKeyId;
  const wsName = config.fabric.workspaceName;
  const root = pax.host.root;
  assert.ok(keyId && wsName && existsSync(root));
  const ok = await paxUninstall(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.equal(s.ui.asked[0], Q.removeAll);

  assert.equal(pax.tasks[PRODUCT.pax.task], undefined);
  assert.ok(text.includes(`Removed the task ${PRODUCT.pax.task}.`), text);
  assert.ok(cli.verbs().includes('app delete'), cli.verbs().join('\n'));
  assert.equal(config.managedApp, undefined);
  assert.ok(graph.calls.includes(`deleteSitePermission ${SITE_ID} perm-1`), graph.calls.join('\n'));
  assert.equal(graph.perms.length, 0);
  assert.ok(text.includes(`Took back the app's access to ${SITE_URL}`), text);

  // The installer made the workspace, so it goes, with the report and the model in it.
  assert.ok(s.ui.asked.includes(`Delete workspace "${wsName}" and everything in it?`), s.ui.asked.join('\n'));
  assert.ok(pbi.calls.includes('deleteGroup pbi-ws-1'), pbi.calls.join('\n'));
  assert.ok(!pbi.calls.some((c) => c.startsWith('deleteReport') || c.startsWith('deleteDataset')));
  assert.ok(text.includes(`Removed workspace "${wsName}".`), text);

  // The app registration stays unless asked, without its secret.
  assert.ok(s.ui.asked.includes(Q.deleteAppReg));
  assert.ok(!graph.calls.some((c) => c.startsWith('deleteApplication')), 'kept by default');
  assert.ok(graph.calls.includes(`removePassword ${keyId}`), graph.calls.join('\n'));
  assert.ok(text.includes('Removed the client secret from the app registration.'), text);

  assert.equal(pax.credentials[TARGET], undefined);
  assert.ok(text.includes(`Removed the client secret from Credential Manager (${TARGET}).`), text);
  assert.equal(existsSync(root), false);
  assert.ok(text.includes(`Removed ${root}.`), text);
  const left = text.slice(text.indexOf('Left alone'));
  assert.ok(text.includes('Left alone'), text);
  assert.ok(left.includes(`The ${PRODUCT.viewerGroup} group, PowerShell 7 and Python, which other things may use.`), left);
  assert.ok(left.includes(PRODUCT.recordFile), left);
  assert.ok(left.includes('SharePoint keeps them'), left);
  assert.ok(!bypassed(pax.calls), 'no execution-policy bypass');
  assert.doesNotMatch(text, /App Edition/i);
});

test('pax flow: uninstall removes nothing when the answer is no', { timeout: 10_000 }, async () => {
  const s = await installed();
  s.ui.by[Q.removeAll] = false;
  assert.equal(await paxUninstall(s.ctx), false);
  assert.ok(plain(s.ui.text()).includes('Nothing was removed.'));
  assert.ok(s.pax.tasks[PRODUCT.pax.task]);
  assert.ok(s.pax.credentials[TARGET]);
  assert.ok(existsSync(s.pax.host.root));
  assert.deepEqual([s.graph.calls, s.pbi.calls, s.pax.calls.length], [[], [], 0]);
});

test('pax flow: uninstall from a workspace it didn\'t make removes the report, then the model if asked', { timeout: 10_000 }, async () => {
  const s = await installed({ workspaces: [{ id: 'ws-team', name: 'Team reports' }], by: { [Q.workspace]: 'ws-team' } });
  const { config, pbi } = s;
  assert.equal(config.fabric.workspaceId, 'ws-team');
  assert.ok(!config.fabric.createdWorkspace);
  const model = config.semanticModel.id;
  const report = config.semanticModel.report?.id;
  assert.ok(model && report);
  const ok = await paxUninstall(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.ok(!pbi.calls.some((c) => c.startsWith('deleteGroup')), 'the workspace stays');
  const reportAt = pbi.calls.indexOf(`deleteReport ws-team ${report}`);
  const modelAt = pbi.calls.indexOf(`deleteDataset ws-team ${model}`);
  assert.ok(reportAt >= 0 && modelAt > reportAt, pbi.calls.join('\n'));
  assert.ok(s.ui.asked.includes(`Delete the semantic model ${config.semanticModel.name ?? PRODUCT.pax.model} too?`), s.ui.asked.join('\n'));
  assert.ok(!s.ui.asked.some((m) => m.startsWith('Delete workspace')));

  // Saying no keeps the model.
  const t = await installed({ workspaces: [{ id: 'ws-team', name: 'Team reports' }], by: { [Q.workspace]: 'ws-team' } });
  t.ui.by[`Delete the semantic model ${t.config.semanticModel.name ?? PRODUCT.pax.model} too?`] = false;
  assert.equal(await paxUninstall(t.ctx), true);
  assert.ok(t.pbi.calls.some((c) => c.startsWith('deleteReport ws-team ')));
  assert.ok(!t.pbi.calls.some((c) => c.startsWith('deleteDataset')), t.pbi.calls.join('\n'));
});

test('pax flow: uninstall deletes the app registration when asked', { timeout: 10_000 }, async () => {
  const s = await installed({ by: { [Q.deleteAppReg]: true } });
  const objectId = s.config.app.objectId;
  const ok = await paxUninstall(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.ok(s.graph.calls.includes(`deleteApplication ${objectId}`), s.graph.calls.join('\n'));
  assert.ok(text.includes(`Removed the app registration ${PRODUCT.pax.app}.`), text);
  assert.ok(!s.graph.calls.some((c) => c.startsWith('removePassword')), 'its secrets go with it');
  assert.equal(s.pax.credentials[TARGET], undefined);
});

test('pax flow: uninstall carries on past a removal that fails, and says so', { timeout: 10_000 }, async () => {
  const s = await installed();
  const wsName = s.config.fabric.workspaceName;
  s.pax.answer['task Unregister'] = [failed('Access is denied.')];
  s.pbi.failures.deleteGroup = [httpError(500, 'Power BI is down')];
  const ok = await paxUninstall(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, false, text);
  assert.ok(text.includes(`Couldn't remove the task ${PRODUCT.pax.task}:`), text);
  assert.ok(text.includes(`Couldn't remove workspace "${wsName}":`), text);
  // The rest still happened.
  assert.ok(s.graph.calls.includes(`deleteSitePermission ${SITE_ID} perm-1`), s.graph.calls.join('\n'));
  assert.ok(s.graph.calls.includes(`removePassword ${s.config.pax.secretKeyId}`), s.graph.calls.join('\n'));
  assert.equal(s.pax.credentials[TARGET], undefined);
  assert.equal(existsSync(s.pax.host.root), false);
  assert.ok(text.includes('Left alone'), text);
});

test('pax flow: uninstall counts what was already gone as removed', { timeout: 10_000 }, async () => {
  const s = await installed();
  const wsName = s.config.fabric.workspaceName;
  delete s.pax.tasks[PRODUCT.pax.task];
  s.graph.failures.deleteSitePermission = [httpError(404)];
  s.pbi.failures.deleteGroup = [httpError(404)];
  delete s.pax.credentials[TARGET];
  const ok = await paxUninstall(s.ctx);
  const text = plain(s.ui.text());
  assert.equal(ok, true, text);
  assert.ok(text.includes(`The task ${PRODUCT.pax.task} wasn't on this PC.`), text);
  assert.ok(text.includes(`Took back the app's access to ${SITE_URL}`), text);
  assert.ok(text.includes(`Workspace "${wsName}" was already gone.`), text);
  assert.ok(!text.includes('Removed the client secret from Credential Manager'), text);
});

test(
  'pax flow: uninstall returns false when the app\'s access to the site can\'t be taken back',
  { timeout: 10_000 },
  async () => {
    const s = await installed();
    s.graph.failures.deleteSitePermission = [httpError(403, 'Forbidden')];
    const ok = await paxUninstall(s.ctx);
    const text = plain(s.ui.text());
    assert.ok(text.includes(`Couldn't take back the app's access to ${SITE_URL}.`), text);
    assert.equal(ok, false, 'the grant is still there');
  },
);

test(
  'pax flow: when the app registration can\'t be deleted, its client secret still comes off it',
  { timeout: 10_000 },
  async () => {
    const s = await installed({ by: { [Q.deleteAppReg]: true } });
    const keyId = s.config.pax.secretKeyId;
    s.graph.failures.deleteApplication = [httpError(500, 'Graph is down')];
    const ok = await paxUninstall(s.ctx);
    const text = plain(s.ui.text());
    assert.equal(ok, false, text);
    assert.ok(text.includes(`Couldn't remove the app registration ${PRODUCT.pax.app}:`), text);
    assert.ok(s.graph.calls.includes(`removePassword ${keyId}`), s.graph.calls.join('\n'));
  },
);

test('pax flow: the refresh scripts never bypass or loosen the execution policy', { timeout: 10_000 }, () => {
  const scripts = readdirSync(RUNNER_DIR).filter((f) => f.endsWith('.ps1'));
  for (const name of ['credential.ps1', 'refresh.ps1', 'task.ps1']) assert.ok(scripts.includes(name), scripts.join(', '));
  for (const name of scripts) {
    const text = readFileSync(join(RUNNER_DIR, name), 'utf8');
    assert.doesNotMatch(text, /(?<![\w-])-ExecutionPolicy\b/i, name);
    assert.doesNotMatch(text, /(?<![\w-])-ep\s+bypass\b/i, name);
    assert.doesNotMatch(text, /Set-ExecutionPolicy\b[^\n]*\b(Bypass|Unrestricted)\b/i, name);
  }
});
