// @ts-check
/** In-memory stand-ins for the Fabric and Graph APIs, the UI and the install record. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig } from '../src/config.js';
import { fabricApi } from '../src/clients/fabric.js';
import { createClient, HttpError } from '../src/http.js';
import { loadSources } from '../src/sources.js';
import { createUi } from '../src/ui.js';

/** @typedef {import('../src/clients/fabric.js').ItemRef} ItemRef */

/** Where fake installs keep their record, so files written beside it (the setup draft) stay out of the repo. */
const TEST_RECORD_DIR = mkdtempSync(join(tmpdir(), 'valuelens-installer-test-'));

let sources;
/** Loads the real notebooks and pipeline once. */
export function realSources() {
  sources ??= loadSources();
  return sources;
}

/**
 * A UI that records output. `answers` scripts confirm and select replies in order;
 * when it runs out, the default is taken. `yesTo` names confirms that say yes instead.
 * @param {{ yes?: boolean, answers?: any[], yesTo?: string[] }} [opts]
 */
export function fakeUi(opts = {}) {
  /** @type {string[]} */
  const out = [];
  const answers = [...(opts.answers ?? [])];
  const base = createUi({ yes: opts.yes, write: (s) => out.push(s) });
  /** @type {string[]} */
  const asked = [];
  const ui = {
    ...base,
    /** @param {string} message @param {boolean} def */
    async confirm(message, def) {
      asked.push(message);
      if (opts.yesTo?.includes(message)) return true;
      return answers.length ? answers.shift() : def;
    },
    /** @param {string} message @param {any[]} choices @param {any} def */
    async select(message, choices, def) {
      asked.push(message);
      return answers.length ? answers.shift() : def;
    },
    /** @param {string} message */
    async secret(message) {
      asked.push(message);
      if (!answers.length) throw new Error(`No answer scripted for "${message}"`);
      return answers.shift();
    },
    /** @param {string} message @param {{ default?: string, validate?: (v: string) => true | string }} [o] */
    async input(message, o = {}) {
      asked.push(message);
      const value = answers.length ? answers.shift() : o.default;
      const verdict = o.validate?.(value) ?? true;
      if (verdict !== true) throw new Error(`${message}: ${verdict}`);
      return value;
    },
    /** @param {string} message @param {{ value: any, checked?: boolean }[]} choices */
    async checkbox(message, choices) {
      asked.push(message);
      return answers.length ? answers.shift() : choices.filter((ch) => ch.checked).map((ch) => ch.value);
    },
    /** @param {string} message @param {import('../src/uploads.js').SourceCard[]} cards */
    async sources(message, cards) {
      asked.push(message);
      return answers.length ? answers.shift() : { modes: Object.fromEntries(cards.map((card) => [card.id, card.mode])), files: [] };
    },
  };
  return { ui: /** @type {import('../src/ui.js').Ui} */ (/** @type {unknown} */ (ui)), out, asked, text: () => out.join('') };
}

/**
 * Power Platform connections held in memory. A new one isn't signed in to. With `signsIn`, a
 * connection whose sign-in link was given is signed in to by the next look at it, as if the user
 * clicked it.
 * @param {{ existing?: any[], signsIn?: boolean, noLinks?: boolean, failCreate?: boolean }} [o]
 */
export function fakeConnections(o = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const conns = structuredClone(o.existing ?? []);
  const linked = new Set();
  let n = 0;
  const signIn = (/** @type {string} */ id) => {
    const conn = conns.find((x) => x.name === id);
    if (conn) conn.properties.statuses = [{ status: 'Connected' }];
  };
  const api = {
    /** @param {string} env @param {string} api */
    list: async (env, api) => {
      calls.push(`list ${env} ${api}`);
      return structuredClone(conns);
    },
    /** @param {string} _env @param {string} _api @param {string} id */
    get: async (_env, _api, id) => {
      calls.push(`get ${id}`);
      if (o.signsIn && linked.has(id)) signIn(id);
      return structuredClone(conns.find((x) => x.name === id));
    },
    /** @param {string} env @param {string} api @param {{ displayName: string, parameters: Record<string, string> }} p */
    create: async (env, api, p) => {
      calls.push(`create ${p.displayName}`);
      if (o.failCreate) throw new Error('403 Forbidden');
      const conn = { name: `shared-webcontents-${++n}`, properties: { displayName: p.displayName, apiId: `/providers/Microsoft.PowerApps/apis/${api}`, environment: env, connectionParameters: p.parameters, statuses: [{ status: 'Error', error: { code: 'Unauthenticated' } }], createdBy: { id: 'user-1' } } };
      conns.push(conn);
      return structuredClone(conn);
    },
    /** @param {string} _env @param {string} _api @param {string} id @param {string} redirectUrl */
    consentLink: async (_env, _api, id, redirectUrl) => {
      calls.push(`consentLink ${id} ${redirectUrl}`);
      linked.add(id);
      if (o.noLinks) throw new Error('400 Bad Request');
      return `https://consent.example/${id}`;
    },
    /** @param {string} _env @param {string} _api @param {string} id */
    remove: async (_env, _api, id) => {
      calls.push(`remove ${id}`);
      conns.splice(conns.findIndex((x) => x.name === id), 1);
    },
  };
  return { api, calls, conns, signIn };
}

/** A Fabric workspace held in memory. */
export function fakeFabric() {
  let n = 0;
  /** @type {{ id: string, type: string, displayName: string, content?: any, description?: string }[]} */
  const items = [];
  /** @type {any[]} */
  const schedules = [];
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const jobs = [];
  /** Job instances listJobs returns. @type {any[]} */
  const jobList = [];
  /** Activity runs queryActivityRuns returns, by job id. @type {Record<string, any[]>} */
  const activityRuns = {};
  /** @type {any[]} */
  const roles = [];
  /** @type {{ id: string, displayName: string, body?: any }[]} */
  const connections = [];
  /** @type {Record<string, string>} */
  const workspaceCapacities = {};
  /** Errors to throw, in order, the next times a method is called. @type {Record<string, Error[]>} */
  const failures = {};
  /** SQL endpoint states getLakehouse returns, in order; then a ready endpoint. @type {any[]} */
  const sqlStates = [];
  /** The workspace's Spark settings. @type {{ highConcurrency: Record<string, boolean> }} */
  const spark = { highConcurrency: { notebookInteractiveRunEnabled: true, notebookPipelineRunEnabled: false } };
  /** The workspace's Git connection. @type {{ gitConnectionState: string }} */
  const git = { gitConnectionState: 'NotConnected' };
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  /** Fabric operations creates answered 202 with, and what operationStatus says of them. @type {Record<string, string>} */
  const operations = {};
  const add = (/** @type {string} */ type, /** @type {string} */ displayName, /** @type {any} */ content, /** @type {ItemRef} */ ref = '') => {
    const item = { id: `${type.toLowerCase()}-${++n}`, type, displayName, content, description: typeof ref === 'string' ? ref : ref.text };
    if (typeof ref === 'object' && ref.onAccepted) {
      const url = `https://api.fabric.microsoft.com/v1/operations/op-${n}`;
      operations[url] = 'Succeeded';
      ref.onAccepted(url);
    }
    items.push(item);
    return item;
  };
  const find = (/** @type {string} */ id) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`no item ${id}`);
    return item;
  };
  const api = {
    /** @param {string} url */
    operationStatus: async (url) => {
      calls.push(`operationStatus ${url.split('/').pop()}`);
      fail('operationStatus');
      return operations[url];
    },
    /** @param {string} _ws @param {string} type */
    listItems: async (_ws, type) => items.filter((i) => i.type === type).map(({ id, type: t, displayName, description }) => ({ id, type: t, displayName, description })),
    /** @param {string} _ws @param {string} name @param {string} content @param {ItemRef} [ref] */
    createNotebook: async (_ws, name, content, ref) => {
      calls.push(`createNotebook ${name}`);
      return { id: add('Notebook', name, content, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {string} content */
    updateNotebook: async (_ws, id, content) => {
      calls.push(`updateNotebook ${find(id).displayName}`);
      find(id).content = content;
      return null;
    },
    /** @param {string} _ws @param {string} name @param {any} def @param {ItemRef} [ref] */
    createPipeline: async (_ws, name, def, ref) => {
      calls.push(`createPipeline ${name}`);
      // Fabric may answer 202 with no body; the step then finds the item by name.
      add('DataPipeline', name, def, ref);
      return null;
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updatePipeline: async (_ws, id, def) => {
      calls.push(`updatePipeline ${find(id).displayName}`);
      find(id).content = def;
      return null;
    },
    /** @param {string} _ws @param {string} id */
    getPipelineDefinition: async (_ws, id) => {
      fail('getPipelineDefinition');
      const item = items.find((i) => i.id === id);
      if (!item?.content) throw notFound();
      return structuredClone(item.content);
    },
    getSparkSettings: async () => {
      fail('getSparkSettings');
      return structuredClone(spark);
    },
    /** @param {string} _ws @param {any} body */
    updateSparkSettings: async (_ws, body) => {
      calls.push(`updateSparkSettings ${JSON.stringify(body)}`);
      fail('updateSparkSettings');
      spark.highConcurrency = { ...spark.highConcurrency, ...body.highConcurrency };
      return null;
    },
    listSchedules: async () => schedules.map((s) => structuredClone(s)),
    /** @param {string} _ws @param {string} _id @param {any} body */
    createSchedule: async (_ws, _id, body) => {
      calls.push('createSchedule');
      const s = { id: `schedule-${++n}`, owner: { id: 'u' }, ...structuredClone(body) };
      schedules.push(s);
      return s;
    },
    /** @param {string} _ws @param {string} _id @param {string} sid @param {any} body */
    updateSchedule: async (_ws, _id, sid, body) => {
      calls.push('updateSchedule');
      Object.assign(/** @type {any} */ (schedules.find((s) => s.id === sid)), structuredClone(body));
      return null;
    },
    /** @param {string} ws @param {string} id @param {string} jobType @param {any} data */
    runJob: async (ws, id, jobType, data) => {
      calls.push(`runJob ${jobType}${data ? ` ${JSON.stringify(data)}` : ''}`);
      return `https://api.fabric.microsoft.com/v1/workspaces/${ws}/items/${id}/jobs/instances/job-${++n}`;
    },
    getJob: async () => jobs.shift(),
    listJobs: async () => structuredClone(jobList),
    /** @param {string} _ws @param {string} jobId */
    queryActivityRuns: async (_ws, jobId) => structuredClone(activityRuns[jobId] ?? []),
    /** @param {string} _ws @param {string} id */
    getLakehouse: async (_ws, id) => ({
      id,
      displayName: 'ValueLens',
      properties: { sqlEndpointProperties: sqlStates.length ? sqlStates.shift() : { connectionString: 'abc.datawarehouse.fabric.microsoft.com', provisioningStatus: 'Success' } },
    }),
    /** @param {string} _ws @param {string} id */
    getItem: async (_ws, id) => {
      const item = items.find((i) => i.id === id);
      if (!item) throw notFound();
      return { id, type: item.type, displayName: item.displayName };
    },
    /** @param {string} _ws @param {string} name @param {ItemRef} [ref] */
    createLakehouse: async (_ws, name, ref) => {
      calls.push(`createLakehouse ${name}`);
      return { id: add('Lakehouse', name, null, ref).id };
    },
    /** @param {string} _ws @param {string} name @param {any} def @param {ItemRef} [ref] */
    createSemanticModel: async (_ws, name, def, ref) => {
      calls.push(`createSemanticModel ${name}`);
      fail('createSemanticModel');
      return { id: add('SemanticModel', name, def, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updateSemanticModel: async (_ws, id, def, opts) => {
      calls.push(`updateSemanticModel ${find(id).displayName}${opts?.allowPurgeData ? ' allowPurgeData' : ''}`);
      fail('updateSemanticModel');
      find(id).content = def;
      return null;
    },
    /** @param {string} _ws @param {string} name @param {any} def @param {ItemRef} [ref] */
    createReport: async (_ws, name, def, ref) => {
      calls.push(`createReport ${name}`);
      fail('createReport');
      return { id: add('Report', name, def, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updateReport: async (_ws, id, def) => {
      calls.push(`updateReport ${find(id).displayName}`);
      find(id).content = def;
      return null;
    },
    listRoleAssignments: async () => structuredClone(roles),
    /** @param {string} _ws @param {string} id @param {string} type @param {string} role */
    addRoleAssignment: async (_ws, id, type, role) => {
      calls.push(`addRoleAssignment ${id} ${role}`);
      roles.push({ id, principal: { id, type }, role });
      return null;
    },
    /** @param {string} _ws @param {string} id @param {string} role */
    updateRoleAssignment: async (_ws, id, role) => {
      calls.push(`updateRoleAssignment ${id} ${role}`);
      Object.assign(/** @type {any} */ (roles.find((r) => r.id === id)), { role });
      return null;
    },
    listConnections: async () => connections.map(({ id, displayName, body }) => ({ id, displayName, ...(body?.gatewayId ? { gatewayId: body.gatewayId } : {}) })),
    /** @param {string} id */
    getConnection: async (id) => {
      const conn = connections.find((x) => x.id === id);
      if (!conn) throw notFound();
      return { id, displayName: conn.displayName };
    },
    /** @param {any} body */
    createConnection: async (body) => {
      calls.push(`createConnection ${body.displayName}`);
      fail('createConnection');
      const conn = { id: `connection-${++n}`, displayName: body.displayName, body };
      connections.push(conn);
      return { id: conn.id, displayName: conn.displayName };
    },
    /** @param {string} id @param {any} body */
    updateConnection: async (id, body) => {
      calls.push(`updateConnection ${id}`);
      fail('updateConnection');
      Object.assign(/** @type {any} */ (connections.find((x) => x.id === id)), { body });
      return null;
    },
    /** @param {string} id */
    deleteConnection: async (id) => {
      calls.push(`deleteConnection ${id}`);
      fail('deleteConnection');
      const at = connections.findIndex((x) => x.id === id);
      if (at >= 0) connections.splice(at, 1);
    },
    listCapacities: async () => [{ id: 'cap-f', displayName: 'Trial', sku: 'FTL64', region: 'West US 3', state: 'Active' }, { id: 'cap-ppu', displayName: 'PPU', sku: 'PP3', region: 'West US 3', state: 'Active' }],
    /** @param {string} id */
    getWorkspace: async (id) => ({ id, capacityId: workspaceCapacities[id] }),
    /** @param {string} id @param {string} capacityId */
    assignToCapacity: async (id, capacityId) => {
      calls.push(`assignToCapacity ${id} ${capacityId}`);
      workspaceCapacities[id] = capacityId;
    },
    /** @param {string} _ws @param {string} id @param {any} binding */
    bindConnection: async (_ws, id, binding) => {
      calls.push(`bindConnection ${find(id).displayName} ${binding.id} ${binding.path}`);
      fail('bindConnection');
      return null;
    },
    /** @param {string} _ws */
    getGitConnection: async (_ws) => {
      fail('getGitConnection');
      return { ...git };
    },
  };
  return { api, items, schedules, calls, jobs, jobList, activityRuns, roles, connections, workspaceCapacities, failures, sqlStates, spark, git, add, operations };
}

/**
 * Fabric's createConnection over the real HTTP client, where Fabric makes the connection but answers 429. The
 * client sends it again, and Fabric then says the name is taken.
 * @param {ReturnType<typeof fakeFabric>} fabric  Where the connection is made.
 * @param {any} [listed]  More of what Fabric lists for it, such as its gatewayId.
 */
export function throttledThenTaken(fabric, listed = {}) {
  /** @type {string[]} */
  const sent = [];
  const http = createClient({
    baseUrl: 'https://fabric.invalid/v1',
    getToken: async () => 'offline',
    sleep: async () => {},
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
      const body = JSON.parse(init.body);
      sent.push(`${init.method} ${body.displayName}`);
      if (sent.length === 1) {
        fabric.connections.push({ id: 'conn-throttled', displayName: body.displayName, body: { ...body, ...listed } });
        return new Response(JSON.stringify({ errorCode: 'TooManyRequests', message: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(JSON.stringify({ errorCode: 'DuplicateConnectionName', message: `Connection with name ${body.displayName} already exists.` }), { status: 409 });
    }),
  });
  return { createConnection: fabricApi(http).createConnection, sent };
}

/** @param {number} [status] @param {string} [message] */
export const httpError = (status = 404, message = 'Not found') => new HttpError(message, { status, method: 'GET', url: 'https://x' });
const notFound = () => httpError(404);

/** Microsoft Graph calls for app secrets. */
export function fakeGraph() {
  let n = 0;
  /** @type {{ keyId: string, displayName: string }[]} */
  const passwords = [];
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  const api = {
    /** @param {string} _objectId @param {Date} end @param {string} [displayName] */
    addPassword: async (_objectId, end, displayName = 'Analytics Hub installer') => {
      calls.push(`addPassword ${displayName}`);
      const err = failures.addPassword?.shift();
      if (err) throw err;
      const keyId = `key-${++n}`;
      passwords.push({ keyId, displayName });
      return { keyId, secretText: `secret-${n}`, endDateTime: end.toISOString() };
    },
    /** @param {string} _objectId */
    listPasswords: async (_objectId) => {
      calls.push('listPasswords');
      const err = failures.listPasswords?.shift();
      if (err) throw err;
      return passwords.map((p) => ({ ...p }));
    },
    /** @param {string} _objectId @param {string} keyId */
    removePassword: async (_objectId, keyId) => {
      calls.push(`removePassword ${keyId}`);
      const err = failures.removePassword?.shift();
      if (err) throw err;
      const at = passwords.findIndex((p) => p.keyId === keyId);
      if (at >= 0) passwords.splice(at, 1);
      return null;
    },
  };
  return { api, passwords, calls, failures };
}

/** Azure Resource Manager fake: subscriptions, resource groups, providers, permissions and role assignments. */
export function fakeArm() {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, any>} */
  const groups = {};
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** The signed-in user's ARM permissions by scope. Anything not listed allows everything. @type {Record<string, { actions?: string[], notActions?: string[] }[]>} */
  const perms = {};
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const api = {
    listSubscriptions: async () => [{ subscriptionId: 'sub-1', displayName: 'Sub', state: 'Enabled' }],
    getResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ name) => groups[name] ?? null,
    ensureResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ name, /** @type {string} */ location, /** @type {any} */ tags = {}) => {
      calls.push(`ensureResourceGroup ${name}`);
      groups[name] = { name, location, tags };
      return groups[name];
    },
    ensureProvider: async (/** @type {string} */ _sub, /** @type {string} */ ns) => {
      calls.push(`ensureProvider ${ns}`);
      fail('ensureProvider');
      return false;
    },
    permissions: async (/** @type {string} */ scope) => {
      calls.push(`permissions ${scope}`);
      fail('permissions');
      return perms[scope] ?? [{ actions: ['*'], notActions: [] }];
    },
    assignRole: async (/** @type {string} */ scope, /** @type {string} */ role, /** @type {string} */ principal, /** @type {string} */ type) => {
      calls.push(`assignRole ${scope} ${role} ${principal} ${type}`);
      fail('assignRole');
    },
  };
  return { api, calls, groups, failures, perms };
}

/** Rich Graph fake for Azure app registration work. */
export function fakeAzureGraph() {
  let n = 0;
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const applications = [];
  /** @type {any[]} */
  const servicePrincipals = [];
  /** @type {any[]} */
  const roleAssignments = [];
  /** @type {{ keyId: string, displayName: string }[]} */
  const passwords = [];
  const graphSp = { id: 'graph-sp', appId: '00000003-0000-0000-c000-000000000000', appRoles: [
    { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
    { id: 'r-reports', value: 'Reports.Read.All' },
    { id: 'r-users', value: 'User.Read.All' },
    { id: 'r-settings', value: 'ReportSettings.Read.All' },
    { id: 'r-sites', value: 'Sites.Selected' },
  ], oauth2PermissionScopes: [
    { id: 's-user-read', value: 'User.Read' },
    { id: 's-group-members', value: 'GroupMember.ReadWrite.All' },
    { id: 's-user-read-basic', value: 'User.ReadBasic.All' },
    { id: 's-user-read-all', value: 'User.Read.All' },
  ] };
  /** @type {Error[]} */
  const siteGrantFailures = [];
  /** The signed-in user's directory roles. None unless a test adds some. @type {{ roleTemplateId: string, displayName: string }[]} */
  const directoryRoles = [];
  const pbiSp = { id: 'pbi-sp', appId: '00000009-0000-0000-c000-000000000000', oauth2PermissionScopes: [{ id: 's-dataset', value: 'Dataset.Read.All' }] };
  /** Errors each method throws next, by method. @type {Record<string, Error[]>} */
  const failures = {};
  const api = {
    myDirectoryRoles: async () => structuredClone(directoryRoles),
    servicePrincipalByAppId: async (/** @type {string} */ appId) => (appId === pbiSp.appId ? pbiSp : graphSp),
    graphServicePrincipal: async () => graphSp,
    findApplication: async (/** @type {string} */ appId) => applications.find((a) => a.appId === appId) ?? null,
    findServicePrincipal: async (/** @type {string} */ appId) => servicePrincipals.find((s) => s.appId === appId) ?? null,
    createApplication: async (/** @type {string} */ name) => {
      calls.push(`createApplication ${name}`);
      const app = { id: `app-obj-${++n}`, appId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, displayName: name };
      applications.push(app);
      return app;
    },
    createServicePrincipal: async (/** @type {string} */ appId) => {
      calls.push(`createServicePrincipal ${appId}`);
      const sp = { id: `sp-${appId}`, appId };
      servicePrincipals.push(sp);
      return sp;
    },
    addPassword: async (/** @type {string} */ _id, /** @type {Date} */ end, /** @type {string} */ displayName = 'Analytics Hub installer') => {
      calls.push(`addPassword ${displayName}`);
      const keyId = `key-${++n}`;
      passwords.push({ keyId, displayName });
      return { keyId, secretText: `secret-${n}`, endDateTime: end.toISOString() };
    },
    listPasswords: async (/** @type {string} */ _id) => passwords.map((p) => ({ ...p })),
    removePassword: async (/** @type {string} */ _id, /** @type {string} */ keyId) => {
      calls.push(`removePassword ${keyId}`);
      const at = passwords.findIndex((p) => p.keyId === keyId);
      if (at >= 0) passwords.splice(at, 1);
    },
    assignPrincipalToAppRole: async (/** @type {string} */ principal, /** @type {string} */ resource, /** @type {string} */ role) => {
      calls.push(`assign ${principal} ${role}`);
      roleAssignments.push({ principalId: principal, resourceId: resource, appRoleId: role });
    },
    appRoleAssignedTo: async (/** @type {string} */ resource) => roleAssignments.filter((a) => a.resourceId === resource),
    grantOauth2Permission: async (/** @type {any} */ g) => {
      calls.push(`oauth ${g.scope}`);
    },
    deleteApplication: async (/** @type {string} */ id) => {
      calls.push(`deleteApplication ${id}`);
      const err = failures.deleteApplication?.shift();
      if (err) throw err;
    },
    site: async (/** @type {string} */ id) => ({ id: `site:${id}`, webUrl: `https://${id.replace(':', '')}` }),
    grantSiteRead: async (/** @type {string} */ siteId, /** @type {string} */ appId, /** @type {string} */ name) => {
      calls.push(`grantSiteRead ${siteId} ${appId} ${name}`);
      const err = siteGrantFailures.shift();
      if (err) throw err;
    },
  };
  return { api, calls, applications, servicePrincipals, siteGrantFailures, passwords, directoryRoles, failures };
}

/** Power BI refreshes. `states` scripts what each poll of a refresh returns. */
export function fakePowerBi() {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const states = [];
  /** @type {any[]} */
  const history = [];
  /** @type {any[]} What each executeQueries call returns, in order. */
  const answers = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** @type {{ id: string, name: string }[]} The workspaces groups() lists. */
  const workspaces = [];
  /** @type {any[]} */
  let datasources = [{ datasourceType: 'Sql', connectionDetails: { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' } }];
  let n = 0;
  const api = {
    datasources: async () => datasources,
    groups: async () => {
      const err = failures.groups?.shift();
      if (err) throw err;
      return structuredClone(workspaces);
    },
    createGroup: async (/** @type {string} */ name) => {
      calls.push(`createGroup ${name}`);
      return { id: 'pbi-ws-1', name };
    },
    deleteGroup: async (/** @type {string} */ id) => {
      calls.push(`deleteGroup ${id}`);
      const err = failures.deleteGroup?.shift();
      if (err) throw err;
    },
    addGroupUser: async (/** @type {string} */ ws, /** @type {any} */ body) => {
      calls.push(`addGroupUser ${ws} ${body.identifier}`);
    },
    setRefreshSchedule: async (/** @type {string} */ ws, /** @type {string} */ dataset) => {
      calls.push(`setRefreshSchedule ${ws} ${dataset}`);
    },
    updateDatasource: async (/** @type {string} */ gw, /** @type {string} */ ds, /** @type {any} */ body) => {
      calls.push(`updateDatasource ${gw} ${ds} ${body.credentialDetails.credentialType}`);
      const err = failures.updateDatasource?.shift();
      if (err) throw err;
    },
    /** @param {string} _ws @param {string} id @param {any} body */
    refresh: async (_ws, id, body) => {
      calls.push(`refresh ${id} ${body.type}`);
      const err = failures.refresh?.shift();
      if (err) throw err;
      return `request-${++n}`;
    },
    /** @param {string} _ws @param {string} _id @param {string} requestId */
    getRefresh: async (_ws, _id, requestId) => {
      calls.push(`getRefresh ${requestId}`);
      return states.length ? states.shift() : { status: 'Completed', extendedStatus: 'Completed' };
    },
    refreshes: async () => structuredClone(history),
    /** @param {string} _ws @param {string} id @param {string} _query */
    executeQueries: async (_ws, id, _query) => {
      calls.push(`executeQueries ${id}`);
      const err = failures.executeQueries?.shift();
      if (err) throw err;
      return answers.length ? answers.shift() : { results: [{ tables: [{ rows: [{ '[CalendarDays]': 90 }] }] }] };
    },
  };
  return {
    api,
    calls,
    states,
    history,
    failures,
    answers,
    workspaces,
    /** @param {any[]} d */
    setDatasources: (d) => {
      datasources = d;
    },
  };
}

/**
 * @param {{ ui?: import('../src/ui.js').Ui, fabric?: any, graph?: any, oneLake?: any, arm?: any, keyVault?: any, powerBi?: any, discovery?: any, flow?: any, connections?: any, dataverse?: (url: string) => any, sources?: import('../src/sources.js').Sources, config?: import('../src/config.js').InstallConfig, now?: Date }} [o]
 */
export function fakeCtx(o = {}) {
  const config = o.config ?? emptyConfig();
  config.fabric.workspaceId ??= 'ws-1';
  config.fabric.lakehouseId ??= 'lh-1';
  config.fabric.lakehouseName ??= 'ValueLens';
  config.app.appId ??= 'app-1';
  config.app.objectId ??= 'obj-1';
  config.app.servicePrincipalId ??= 'sp-1';
  config.keyVault.uri ??= 'https://kv-test.vault.azure.net/';
  let saves = 0;
  /** @type {number[]} */
  const sleeps = [];
  const ctx = /** @type {import('../src/install.js').Ctx} */ (
    /** @type {unknown} */ ({
      ui: o.ui ?? fakeUi().ui,
      config,
      file: join(TEST_RECORD_DIR, 'valuelens-install.json'),
      save: () => {
        saves++;
      },
      api: {
        fabric: o.fabric,
        graph: o.graph,
        oneLake: o.oneLake,
        arm: o.arm,
        keyVault: o.keyVault,
        powerBi: o.powerBi,
        discovery: o.discovery,
        dataverse: o.dataverse,
        flow: o.flow,
        connections: o.connections,
      },
      user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
      sources: o.sources ?? realSources(),
      sleep: async (/** @type {number} */ ms) => {
        sleeps.push(ms);
      },
      now: () => o.now ?? new Date('2026-06-01T12:00:00Z'),
    })
  );
  return { ctx, config, sleeps, saves: () => saves };
}
