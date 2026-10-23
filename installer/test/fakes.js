// @ts-check
/** In-memory stand-ins for the Fabric and Graph APIs, the UI and the install record. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig } from '../src/config.js';
import { TRANSCRIPT_ROLE } from '../src/clients/dataverse.js';
import { fabricApi } from '../src/clients/fabric.js';
import { createClient, HttpError } from '../src/http.js';
import { loadSources } from '../src/sources.js';
import { createUi } from '../src/ui.js';

/** @typedef {import('../src/clients/fabric.js').ItemRef} ItemRef */

/** Where fake installs keep their record, so files written beside it (the Teams package) stay out of the repo. */
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
  /** @type {any[]} */
  const gateways = [];
  /** @type {Record<string, string>} */
  const workspaceCapacities = {};
  /** Errors to throw, in order, the next times a method is called. @type {Record<string, Error[]>} */
  const failures = {};
  /** SQL endpoint states getLakehouse returns, in order; then a ready endpoint. @type {any[]} */
  const sqlStates = [];
  /** The workspace's Spark settings. @type {{ highConcurrency: Record<string, boolean> }} */
  const spark = { highConcurrency: { notebookInteractiveRunEnabled: true, notebookPipelineRunEnabled: false } };
  /** The connections the Cowork Dataflow's definition lists, one list per call; the last repeats. None by default. @type {any[][]} */
  const dataflowConnections = [];
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
    /** @param {string} _ws @param {string} name @param {string} [_description] @param {ItemRef} [ref] */
    createDataflow: async (_ws, name, _description, ref) => {
      calls.push(`createDataflow ${name}`);
      fail('createDataflow');
      return { id: add('Dataflow', name, null, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updateDataflow: async (_ws, id, def) => {
      calls.push(`updateDataflow ${find(id).displayName}`);
      fail('updateDataflow');
      find(id).content = def;
      return null;
    },
    /** @param {string} _ws @param {string} id */
    getDataflowDefinition: async (_ws, id) => {
      calls.push(`getDataflowDefinition ${id}`);
      fail('getDataflowDefinition');
      const connections = dataflowConnections.length > 1 ? dataflowConnections.shift() : (dataflowConnections[0] ?? []);
      return { 'queryMetadata.json': JSON.stringify({ name: items.find((i) => i.id === id)?.displayName, connections }), 'mashup.pq': 'section Section1;' };
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
    /** @param {string} _ws @param {string} id @param {string} name */
    renameItem: async (_ws, id, name) => {
      calls.push(`renameItem ${find(id).displayName} -> ${name}`);
      find(id).displayName = name;
      return null;
    },
    /** @param {string} _ws @param {string} name @param {ItemRef} [ref] */
    createLakehouse: async (_ws, name, ref) => {
      calls.push(`createLakehouse ${name}`);
      return { id: add('Lakehouse', name, null, ref).id };
    },
    /** @param {string} _ws @param {string} type @param {string} name @param {ItemRef} [ref] */
    createItem: async (_ws, type, name, ref) => {
      calls.push(`createItem ${type} ${name}`);
      const item = add(type, name, null, ref);
      return { id: item.id, type, displayName: name };
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
    /** @param {string} _ws @param {string} name @param {any} def @param {ItemRef} [ref] */
    createDataAgent: async (_ws, name, def, ref) => {
      calls.push(`createDataAgent ${name}`);
      fail('createDataAgent');
      return { id: add('DataAgent', name, def, ref).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updateDataAgent: async (_ws, id, def) => {
      calls.push(`updateDataAgent ${find(id).displayName}`);
      fail('updateDataAgent');
      find(id).content = def;
      return null;
    },
    /** @param {string} _ws @param {string} id */
    publishDataAgent: async (_ws, id) => {
      calls.push(`publishDataAgent ${find(id).displayName}`);
      fail('publishDataAgent');
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
    listGateways: async () => structuredClone(gateways),
    /** @param {any} body */
    createGateway: async (body) => {
      calls.push(`createGateway ${body.displayName} ${body.virtualNetworkAzureResource.virtualNetworkName}/${body.virtualNetworkAzureResource.subnetName}`);
      fail('createGateway');
      const g = { id: `gateway-${++n}`, ...body };
      gateways.push(g);
      return g;
    },
    /** @param {string} id */
    deleteGateway: async (id) => {
      calls.push(`deleteGateway ${id}`);
      fail('deleteGateway');
      const at = gateways.findIndex((g) => g.id === id);
      if (at >= 0) gateways.splice(at, 1);
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
  return { api, items, schedules, calls, jobs, jobList, activityRuns, roles, connections, gateways, workspaceCapacities, failures, sqlStates, spark, dataflowConnections, git, add, operations };
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

/**
 * The api-versions the fake ARM accepts for each type the Azure install tags, by lower-case type: a few of
 * each provider's, as ARM accepts only a version the provider offers for the type. Of these, only Storage
 * offers 2021-04-01, the version uninstall once sent for every type. Other types accept any version.
 * @type {Record<string, string[]>}
 */
export const ARM_API_VERSIONS = (() => {
  const app = ['2022-03-01', '2022-10-01', '2023-05-01', '2024-03-01', '2025-01-01', '2025-02-02-preview'];
  const sql = ['2014-04-01', '2021-11-01', '2022-05-01-preview', '2023-08-01-preview', '2023-08-01'];
  const network = ['2023-09-01', '2024-01-01', '2024-05-01', '2024-07-01'];
  const dns = ['2018-09-01', '2020-06-01', '2024-06-01'];
  return {
    'microsoft.app/containerapps': app,
    'microsoft.app/jobs': app,
    'microsoft.app/managedenvironments': app,
    'microsoft.sql/servers': sql,
    'microsoft.sql/servers/databases': sql,
    'microsoft.storage/storageaccounts': ['2021-04-01', '2023-01-01', '2023-05-01', '2024-01-01'],
    'microsoft.operationalinsights/workspaces': ['2020-08-01', '2022-10-01', '2023-09-01', '2025-02-01'],
    'microsoft.managedidentity/userassignedidentities': ['2018-11-30', '2023-01-31', '2024-11-30'],
    'microsoft.cognitiveservices/accounts': ['2023-05-01', '2024-10-01', '2025-06-01'],
    'microsoft.network/virtualnetworks': network,
    'microsoft.network/networksecuritygroups': network,
    'microsoft.network/privateendpoints': network,
    'microsoft.network/privatednszones': dns,
    'microsoft.network/privatednszones/virtualnetworklinks': dns,
  };
})();

/** A resource ID's type, name and parent ID, worked out here rather than with the code under test. @param {string} id */
function armParts(id) {
  const at = id.toLowerCase().lastIndexOf('/providers/');
  if (at < 0) return { type: '', name: id, parent: undefined };
  const s = id.slice(at + '/providers/'.length).split('/');
  return { type: [s[0], ...s.filter((_, i) => i % 2 === 1)].join('/'), name: s[s.length - 1], parent: s.length > 3 ? id.split('/').slice(0, -2).join('/') : undefined };
}

/**
 * An error as http.js throws it for an ARM call.
 * @param {number} status @param {string} code @param {string} message @param {string} method @param {string} id @param {string | undefined} apiVersion
 */
function armError(status, code, message, method, id, apiVersion) {
  return new HttpError(`${method} ${id} returned ${status} ${code}: ${message}`, {
    status,
    method,
    url: `https://management.azure.com${id}?api-version=${apiVersion}`,
    code,
    body: { error: { code, message } },
  });
}

/** Azure Resource Manager fake for the Azure installer path. */
export function fakeArm() {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const resources = [];
  /** @type {Record<string, any>} */
  const groups = {};
  /** @type {Set<string>} */
  const restrictedSqlRegions = new Set();
  /** @type {any[]} */
  const executions = [];
  /** What listing each job's executions returns, by job name. Separate from `executions`, which polling takes in turn. @type {Record<string, any[]>} */
  const jobExecutions = {};
  /** @type {any[]} */
  const jobTemplates = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** The signed-in user's ARM permissions by scope. Anything not listed allows everything. @type {Record<string, { actions?: string[], notActions?: string[] }[]>} */
  const perms = {};
  const offered = (/** @type {string} */ name = 'gpt-5-mini', /** @type {string} */ version = '2025-08-07') => ({ kind: 'AIServices', model: { name, version, skus: [{ name: 'GlobalStandard' }, { name: 'DataZoneStandard' }] } });
  /** Azure AI: models and quota by region ('*' = any), accounts, and deployments by account ID. */
  const ai = {
    /** @type {Record<string, any[]>} */ models: { '*': [offered()] },
    /** @type {Record<string, any[]>} */ usages: { '*': [{ name: { value: 'OpenAI.GlobalStandard.gpt-5-mini' }, currentValue: 0, limit: 1000 }] },
    /** @type {any[]} */ accounts: [],
    /** @type {Record<string, any[]>} */ deployments: {},
    offered,
  };
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  /** Regions, providers, Storage SKUs and Azure Policy, for the region preflight. Nothing restricted by default. */
  const regions = {
    /** @type {any[]} */ locations: [{ name: 'uksouth', displayName: 'UK South' }],
    /** @type {Record<string, any>} */ providers: {},
    /** @type {any[]} */ storageSkus: [],
    /** @type {any[]} */ assignments: [],
    /** @type {any[]} */ custom: [],
    /** @type {Record<string, any>} */ builtIn: {},
  };
  /** What each read of a resource reports while Azure deletes it, by ID. A resource given some is deleted with a 202, and goes after those reads. @type {Record<string, string[]>} */
  const deleteStates = {};
  /** How many more deletes of a resource, by ID, Azure refuses as in use, as it does a subnet for a while after what used it has gone. @type {Record<string, number>} */
  const inUse = {};
  /** Resources with a delete lock, by ID. @type {Set<string>} */
  const locks = new Set();
  /** @type {Set<string>} */
  const deleting = new Set();
  const same = (/** @type {string | undefined} */ a, /** @type {string} */ b) => !!a && a.toLowerCase() === b.toLowerCase();
  const under = (/** @type {string | undefined} */ child, /** @type {string} */ id) => !!child && child.toLowerCase().startsWith(`${id.toLowerCase()}/`);
  const find = (/** @type {string} */ id) => resources.findIndex((r) => same(String(r.id), id));
  /** Removes a resource and its children, in place: tests hold `resources`. @param {string} id */
  const remove = (id) => {
    for (let i = resources.length - 1; i >= 0; i--) if (same(String(resources[i].id), id) || under(String(resources[i].id), id)) resources.splice(i, 1);
  };
  const remains = (/** @type {string} */ type, /** @type {(r: any) => boolean} */ match) => resources.some((r) => armParts(String(r.id)).type.toLowerCase() === type && match(r));
  /** Whether something that's still there stops Azure deleting a resource. @param {string} id */
  const blocked = (id) => {
    switch (armParts(id).type.toLowerCase()) {
      case 'microsoft.app/managedenvironments':
        return ['microsoft.app/containerapps', 'microsoft.app/jobs'].some((t) => remains(t, (r) => same(r.properties?.environmentId ?? r.properties?.managedEnvironmentId, id)));
      case 'microsoft.network/virtualnetworks':
        return remains('microsoft.network/privateendpoints', (r) => under(r.properties?.subnet?.id, id)) || remains('microsoft.app/managedenvironments', (r) => under(r.properties?.vnetConfiguration?.infrastructureSubnetId, id));
      case 'microsoft.network/networksecuritygroups':
        return remains('microsoft.network/virtualnetworks', (r) => (r.properties?.subnets ?? []).some((/** @type {any} */ s) => same(s.properties?.networkSecurityGroup?.id, id)));
      case 'microsoft.network/privatednszones':
        return resources.some((r) => under(String(r.id), id));
      default:
        return false;
    }
  };
  /** @param {string} id @param {string} apiVersion */
  const inUseError = (id, apiVersion) => {
    const { type, name } = armParts(id);
    switch (type.toLowerCase()) {
      case 'microsoft.network/virtualnetworks':
        return armError(400, 'InUseSubnetCannotBeDeleted', `Subnet snet-apps is in use by ${id}/subnets/snet-apps/serviceAssociationLinks/legionservicelink and cannot be deleted. In order to delete the subnet, delete all the resources within the subnet. See aka.ms/deletesubnet.`, 'DELETE', id, apiVersion);
      case 'microsoft.network/networksecuritygroups':
        return armError(400, 'InUseNetworkSecurityGroupCannotBeDeleted', `Network security group ${id} cannot be deleted because it is in use by the following resources: (${id.replace(/networkSecurityGroups\/.*/i, 'virtualNetworks/vnet/subnets/snet-apps')}).`, 'DELETE', id, apiVersion);
      case 'microsoft.network/privatednszones':
        return armError(409, 'CannotDeleteResource', 'Can not delete resource before nested resources are deleted.', 'DELETE', id, apiVersion);
      default:
        return armError(409, 'Conflict', `Cannot delete ${name} because it still contains ContainerApps or Jobs.`, 'DELETE', id, apiVersion);
    }
  };
  /** ARM's 400 for an api-version the type's provider doesn't offer. @param {string} method @param {string} id @param {string} apiVersion */
  const checkApiVersion = (method, id, apiVersion) => {
    const { type } = armParts(id);
    const [ns, ...rest] = type.split('/');
    const provider = Object.entries(regions.providers).find(([k]) => same(k, ns))?.[1];
    const listed = provider?.resourceTypes?.find((/** @type {any} */ t) => same(t.resourceType, rest.join('/')))?.apiVersions;
    /** @type {string[] | undefined} */
    const offered = listed ?? ARM_API_VERSIONS[type.toLowerCase()];
    if (!offered || offered.some((v) => same(v, String(apiVersion)))) return;
    throw armError(400, 'NoRegisteredProviderFound', `No registered resource provider found for location 'uksouth' and API version '${apiVersion}' for type '${rest.join('/')}'. The supported api-versions are '${offered.join(', ')}'. The supported locations are 'uksouth'.`, method, id, apiVersion);
  };
  const api = {
    listSubscriptions: async () => [{ subscriptionId: 'sub-1', displayName: 'Sub', state: 'Enabled' }],
    listLocations: async () => regions.locations,
    getProvider: async (/** @type {string} */ _sub, /** @type {string} */ ns) => regions.providers[ns] ?? { namespace: ns, resourceTypes: [] },
    storageSkus: async () => regions.storageSkus,
    listPolicyAssignments: async (/** @type {string} */ scope) => {
      calls.push(`listPolicyAssignments ${scope}`);
      fail('listPolicyAssignments');
      return regions.assignments;
    },
    listCustomPolicies: async (/** @type {string} */ _sub, /** @type {string} */ kind) => regions.custom.filter((d) => d.id.includes(`/${kind}/`)),
    getPolicy: async (/** @type {string} */ id) => {
      calls.push(`getPolicy ${id}`);
      const found = regions.builtIn[id] ?? regions.custom.find((d) => d.id === id);
      if (!found) throw httpError(403, 'AuthorizationFailed');
      return found;
    },
    sqlCapability: async (/** @type {string} */ _sub, /** @type {string} */ location) => {
      calls.push(`sqlCapability ${location}`);
      return restrictedSqlRegions.has(location) ? { status: 'Visible', reason: 'Subscriptions are restricted from provisioning in this region.' } : { status: 'Available' };
    },
    listResourceGroups: async () => Object.values(groups),
    getResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ name) => {
      const g = groups[name];
      if (g?.deleting) {
        const state = g.deleteStates?.shift();
        if (state === undefined) delete groups[name];
        else g.properties = { provisioningState: state };
      }
      return groups[name] ?? null;
    },
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
    ensureFeature: async (/** @type {string} */ _sub, /** @type {string} */ ns, /** @type {string} */ name) => {
      calls.push(`ensureFeature ${ns}/${name}`);
      fail('ensureFeature');
      return false;
    },
    permissions: async (/** @type {string} */ scope) => {
      calls.push(`permissions ${scope}`);
      fail('permissions');
      return perms[scope] ?? [{ actions: ['*'], notActions: [] }];
    },
    validateDeployment: async () => {
      calls.push('validateDeployment');
      fail('validateDeployment');
      return {};
    },
    whatIfDeployment: async () => {
      calls.push('whatIfDeployment');
      return { properties: { changes: [{ changeType: 'Create', resourceType: 'Microsoft.App/jobs', resourceId: '/x/run' }] } };
    },
    listResources: async () => {
      fail('listResources');
      return resources;
    },
    deployTemplate: async (/** @type {string} */ _sub, /** @type {string} */ _rg, /** @type {string} */ name, /** @type {any} */ deployment) => {
      calls.push(`deployTemplate ${name}`);
      const priv = deployment?.properties?.parameters?.publicNetworkAccess?.value === 'Disabled';
      return {
        name,
        properties: {
          outputs: {
            ...(priv ? { vnetName: { value: 'vnet-vlens-abc' }, gatewaySubnetName: { value: 'snet-powerbi-gateway' }, environmentName: { value: 'cae-vlens-abc-vnet' } } : {}),
            identityPrincipalId: { value: 'mi-sp' },
            identityClientId: { value: 'mi-client' },
            sqlServerFqdn: { value: 'vlens-sql.database.windows.net' },
            sqlDatabaseName: { value: 'valuelens' },
            runJobName: { value: 'vlens-run' },
            migrateJobName: { value: 'vlens-migrate' },
            webFqdn: { value: 'vlens.example.com' },
            webUrl: { value: 'https://vlens.example.com' },
            webName: { value: 'vlens-web' },
            storageAccountName: { value: 'vlensstabc' },
          },
        },
      };
    },
    assignRole: async (/** @type {string} */ scope, /** @type {string} */ role, /** @type {string} */ principal, /** @type {string} */ type) => {
      calls.push(`assignRole ${scope} ${role} ${principal} ${type}`);
      fail('assignRole');
    },
    listAiAccounts: async () => {
      fail('listAiAccounts');
      return ai.accounts;
    },
    listAiModels: async (/** @type {string} */ _sub, /** @type {string} */ location) => {
      calls.push(`listAiModels ${location}`);
      fail('listAiModels');
      return ai.models[location] ?? ai.models['*'] ?? [];
    },
    listAiUsages: async (/** @type {string} */ _sub, /** @type {string} */ location) => ai.usages[location] ?? ai.usages['*'] ?? [],
    listAiDeployments: async (/** @type {string} */ accountId) => ai.deployments[accountId] ?? [],
    getSqlDatabase: async () => null,
    startContainerAppJob: async (/** @type {string} */ _sub, /** @type {string} */ _rg, /** @type {string} */ name, /** @type {any} */ template) => {
      calls.push(`startJob ${name}`);
      if (template) jobTemplates.push(template);
      return { name: `${name}-exec` };
    },
    getContainerAppJob: async (/** @type {string} */ _sub, /** @type {string} */ _rg, /** @type {string} */ name) => ({
      name,
      properties: { template: { containers: [{ name: 'jobs', image: 'img:1', command: ['python'], env: [{ name: 'VALUELENS_AUDIT_HISTORY_DAYS', value: '30' }, { name: 'VALUELENS_AUDIT_BACKFILL_DAYS', value: '7' }] }] } },
    }),
    getContainerAppJobExecution: async () => executions.shift() ?? { properties: { status: 'Succeeded' } },
    listContainerAppJobExecutions: async (/** @type {string} */ _sub, /** @type {string} */ _rg, /** @type {string} */ name) => {
      calls.push(`listJobExecutions ${name}`);
      fail('listContainerAppJobExecutions');
      return jobExecutions[name] ?? [];
    },
    deleteResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ rg) => {
      calls.push(`deleteResourceGroup ${rg}`);
      fail('deleteResourceGroup');
      // A group given deleteStates (what each read reports while Azure deletes it) goes only after those reads.
      if (groups[rg]?.deleteStates?.length) groups[rg].deleting = true;
      else delete groups[rg];
    },
    /** @param {string} id @param {string} apiVersion */
    deleteResource: async (id, apiVersion) => {
      calls.push(`deleteResource ${id}`);
      fail('deleteResource');
      checkApiVersion('DELETE', id, apiVersion);
      if (locks.has(id)) throw armError(409, 'ScopeLocked', `The scope '${id}' cannot perform delete operation because following scope(s) are locked: '${id}'. Please remove the lock and try again.`, 'DELETE', id, apiVersion);
      if (find(id) < 0) {
        const { parent } = armParts(id);
        if (parent && find(parent) < 0) throw armError(404, 'ParentResourceNotFound', `Can not perform requested operation on nested resource. Parent resource '${armParts(parent).name}' not found.`, 'DELETE', id, apiVersion);
        return { status: 204 };
      }
      if (deleting.has(id)) return { status: 202, retryAfterMs: 15_000 };
      if (inUse[id] > 0) {
        inUse[id]--;
        throw inUseError(id, apiVersion);
      }
      if (blocked(id)) throw inUseError(id, apiVersion);
      if (deleteStates[id]?.length) {
        deleting.add(id);
        return { status: 202, retryAfterMs: 15_000 };
      }
      remove(id);
      return { status: 200 };
    },
    /** @param {string} id @param {string} apiVersion */
    getResource: async (id, apiVersion) => {
      calls.push(`getResource ${id}`);
      fail('getResource');
      checkApiVersion('GET', id, apiVersion);
      const at = find(id);
      if (at < 0) return null;
      if (!deleting.has(id)) return structuredClone(resources[at]);
      const state = deleteStates[id]?.shift();
      if (state === undefined) {
        deleting.delete(id);
        remove(id);
        return null;
      }
      return { ...structuredClone(resources[at]), properties: { ...resources[at].properties, provisioningState: state } };
    },
  };
  return { api, calls, resources, groups, executions, jobExecutions, jobTemplates, failures, restrictedSqlRegions, ai, regions, perms, deleteStates, inUse, locks };
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
    createAzureWebApplication: async (/** @type {any} */ body) => {
      calls.push(`createAzureWebApplication ${body.displayName}`);
      const app = { id: `app-obj-${++n}`, appId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, displayName: body.displayName, api: { oauth2PermissionScopes: [{ id: 'scope-access', value: 'access_as_user' }] }, appRoles: [] };
      applications.push(app);
      return app;
    },
    updateAzureWebApplication: async (/** @type {any} */ app, /** @type {any} */ body) => {
      calls.push(`updateAzureWebApplication ${body.fqdn}`);
      app.identifierUris = [`api://${body.fqdn}/${body.clientId}`];
      app.spa = { redirectUris: [`https://${body.fqdn}/`, `https://${body.fqdn}/?host=teams&auth=popup`] };
      app.api = { oauth2PermissionScopes: [{ id: 'scope-access', value: 'access_as_user' }], preAuthorizedApplications: body.teamsClientIds.map((id) => ({ appId: id })) };
      app.appRoles = [{ id: 'role-user', value: 'AnalyticsHub.User' }, { id: 'role-admin', value: 'AnalyticsHub.Admin' }];
      return 'scope-access';
    },
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
    addFederatedIdentityCredential: async (/** @type {string} */ id, /** @type {any} */ fic) => {
      calls.push(`fic ${id} ${fic.subject}`);
      return fic;
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

/**
 * A package's manifest ID and version: from manifest.json in a stored zip, as the installer builds it,
 * or from the bytes as JSON.
 * @param {Uint8Array} zip
 * @returns {{ id: string, version: string }}
 */
export function readManifest(zip) {
  const buf = Buffer.from(zip);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return JSON.parse(buf.toString('utf8'));
  for (let at = 0; at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50; ) {
    const size = buf.readUInt32LE(at + 18);
    const nameEnd = at + 30 + buf.readUInt16LE(at + 26);
    const start = nameEnd + buf.readUInt16LE(at + 28);
    if (buf.toString('utf8', at + 30, nameEnd) === 'manifest.json') return JSON.parse(buf.toString('utf8', start, start + size));
    at = start + size;
  }
  throw new Error('The package has no manifest.json.');
}

/**
 * The org's Teams app catalog. What's published or updated is listed straight away, as published.
 * `failures` scripts errors for each method, in order. `manifest` reads a package's manifest ID and
 * version (readManifest by default).
 * @param {{ apps?: import('../src/clients/graph.js').TeamsCatalogApp[], manifest?: (zip: Uint8Array) => { id: string, version: string } }} [o]
 */
export function fakeAppCatalog(o = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {import('../src/clients/graph.js').TeamsCatalogApp[]} */
  const apps = structuredClone(o.apps ?? []);
  /** @type {Record<string, Error[]>} */
  const failures = {};
  const manifest = o.manifest ?? readManifest;
  let n = 0;
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const notFound = (/** @type {string} */ method, /** @type {string} */ id) => new HttpError(`${method} /appCatalogs/teamsApps/${id} returned 404 NotFound`, { status: 404, method, url: `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${id}`, code: 'NotFound' });
  const api = {
    signIn: async () => {
      calls.push('signIn');
      fail('signIn');
    },
    /** @param {string} externalId */
    find: async (externalId) => {
      calls.push(`find ${externalId}`);
      fail('find');
      return structuredClone(apps.filter((a) => a.externalId === externalId && a.distributionMethod === 'organization'));
    },
    /** @param {Uint8Array} zip */
    publish: async (zip) => {
      const m = manifest(zip);
      calls.push(`publish ${m.id} ${m.version}`);
      fail('publish');
      const app = { id: `catalog-app-${++n}`, externalId: m.id, displayName: 'Analytics Hub', distributionMethod: 'organization', appDefinitions: [{ version: m.version, publishingState: 'published' }] };
      apps.push(app);
      return { id: app.id, externalId: app.externalId, displayName: app.displayName, distributionMethod: app.distributionMethod };
    },
    /** @param {string} id @param {Uint8Array} zip */
    update: async (id, zip) => {
      const m = manifest(zip);
      calls.push(`update ${id} ${m.version}`);
      fail('update');
      const app = apps.find((a) => a.id === id);
      if (!app) throw notFound('POST', id);
      app.appDefinitions = [{ version: m.version, publishingState: 'published' }];
    },
    /** @param {string} id */
    remove: async (id) => {
      calls.push(`remove ${id}`);
      fail('remove');
      const at = apps.findIndex((a) => a.id === id);
      if (at < 0) throw notFound('DELETE', id);
      apps.splice(at, 1);
    },
  };
  return { api: /** @type {import('../src/clients/graph.js').AppCatalogApi} */ (api), calls, apps, failures };
}

/**
 * The privileges Dataverse gives a new security role on its own, each at Organization depth, as a live test found.
 * Bot Transcript Viewer holds the same ones.
 */
export const PLATFORM_PRIVILEGES = Object.freeze([
  'prvReadSdkMessage',
  'prvReadSdkMessageProcessingStep',
  'prvReadSdkMessageProcessingStepImage',
  'prvReadPluginType',
  'prvReadPluginAssembly',
  'prvReadSharePointDocument',
  'prvReadSharePointData',
  'prvWriteSharePointData',
  'prvCreateSharePointData',
]);

/**
 * A security role in a fake environment.
 * @typedef {object} FakeRole
 * @property {string} roleid
 * @property {string} name
 * @property {string} [description]
 * @property {string} bu  Its business unit.
 * @property {string} [parent]  The role in the root business unit it's a copy of.
 * @property {Map<string, string>} privileges  Privilege ID to depth. A copy shares its parent's.
 */

/**
 * One Dataverse environment's security roles, privileges and role assignments, and its conversation transcripts. Like
 * Dataverse, a role created in the root business unit comes with PLATFORM_PRIVILEGES at Organization depth, and has a
 * copy in each child business unit in `units` unless `copies` is false; deleting a role deletes its copies and takes
 * them from their users and teams; and a role or assignment that isn't there answers 404. Bot Transcript Viewer is
 * `viewer` in every business unit, or missing when that's null. `teamRoles` are the roles teams hold. A user can read the
 * transcripts once one of its roles holds ConversationTranscript read at Organization depth. Changes, and the lookups
 * of a role's copies and holders, are logged, with privileges by name.
 * @param {{ calls: string[], fail: (method: string) => void, userRoles: Record<string, string[]>, teamRoles?: Record<string, string[]>, root: string | null, viewer: string | null, units?: string[], copies?: boolean, roles?: FakeRole[], transcripts?: string[] }} o
 */
export function fakeRoleStore(o) {
  const { calls, fail, userRoles } = o;
  const teamRoles = o.teamRoles ?? {};
  /** Privilege names, by ID. @type {Map<string, string>} */
  const privileges = new Map([
    ['priv-transcript', 'prvReadconversationtranscript'],
    ['priv-bot', 'prvReadbot'],
    ...PLATFORM_PRIVILEGES.map((name, i) => /** @type {[string, string]} */ ([`priv-${i + 1}`, name])),
  ]);
  const label = (/** @type {string} */ id) => privileges.get(id) ?? id;
  const same = (/** @type {string | undefined} */ a, /** @type {string | undefined} */ b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  /** @type {FakeRole[]} */
  const roles = o.roles ?? [];
  let n = 0;
  const find = (/** @type {string} */ id) => {
    const role = roles.find((r) => r.roleid.toLowerCase() === id.toLowerCase());
    if (!role) throw httpError(404);
    return role;
  };
  const api = {
    /** @param {string} name @param {string} businessUnitId */
    findRole: async (name, businessUnitId) => {
      calls.push(`findRole ${name} ${businessUnitId}`);
      fail('findRole');
      if (name === TRANSCRIPT_ROLE) return o.viewer ?? undefined;
      return roles.find((r) => r.name === name && r.bu === businessUnitId)?.roleid;
    },
    /** @param {string} name @param {string} businessUnitId */
    rolesByName: async (name, businessUnitId) => {
      fail('rolesByName');
      return roles.filter((r) => r.name === name && r.bu === businessUnitId).map((r) => ({ roleid: r.roleid, description: r.description ?? null }));
    },
    /** @param {string} roleId */
    roleCopies: async (roleId) => {
      calls.push(`roleCopies ${roleId}`);
      fail('roleCopies');
      return { ids: roles.filter((r) => same(r.roleid, roleId) || same(r.parent, roleId)).map((r) => r.roleid), more: false };
    },
    /** @param {string} roleId @param {string} businessUnitId */
    roleCopy: async (roleId, businessUnitId) => {
      calls.push(`roleCopy ${roleId} ${businessUnitId}`);
      fail('roleCopy');
      return roles.find((r) => same(r.parent, roleId) && same(r.bu, businessUnitId))?.roleid;
    },
    /** @param {string} roleId */
    roleHolders: async (roleId) => {
      calls.push(`roleHolders ${roleId}`);
      fail('roleHolders');
      const has = (/** @type {string[]} */ ids) => ids.some((id) => same(id, roleId));
      return { users: Object.keys(userRoles).filter((u) => has(userRoles[u])), teams: Object.keys(teamRoles).filter((t) => has(teamRoles[t])), more: false };
    },
    /** @param {{ name: string, businessUnitId: string, description: string }} role */
    createRole: async (role) => {
      calls.push(`createRole ${role.name} ${role.businessUnitId}`);
      fail('createRole');
      const made = { roleid: `read-${++n}`, name: role.name, description: role.description, bu: role.businessUnitId, privileges: new Map(PLATFORM_PRIVILEGES.map((_, i) => [`priv-${i + 1}`, 'Global'])) };
      roles.push(made);
      if (role.businessUnitId === o.root && o.copies !== false) {
        for (const unit of o.units ?? []) roles.push({ ...made, roleid: `${made.roleid}-${unit}`, bu: unit, parent: made.roleid });
      }
      return made.roleid;
    },
    /** @param {string} roleId */
    deleteRole: async (roleId) => {
      calls.push(`deleteRole ${roleId}`);
      fail('deleteRole');
      const role = find(roleId);
      const gone = new Set(roles.filter((r) => r === role || r.parent === role.roleid).map((r) => r.roleid));
      roles.splice(0, roles.length, ...roles.filter((r) => !gone.has(r.roleid)));
      for (const user of Object.keys(userRoles)) userRoles[user] = userRoles[user].filter((r) => !gone.has(r));
      for (const team of Object.keys(teamRoles)) teamRoles[team] = teamRoles[team].filter((r) => !gone.has(r));
      return null;
    },
    /** @param {readonly string[]} names */
    findPrivileges: async (names) => {
      fail('findPrivileges');
      return [...privileges].filter(([, name]) => names.includes(name)).map(([privilegeid, name]) => ({ privilegeid, name, canbeglobal: true }));
    },
    /** @param {string} roleId */
    rolePrivileges: async (roleId) => {
      fail('rolePrivileges');
      return [...find(roleId).privileges].map(([id, depth]) => ({ id, name: privileges.get(id), depth }));
    },
    /** @param {string} roleId @param {readonly string[]} ids @param {string} businessUnitId */
    addPrivileges: async (roleId, ids, businessUnitId) => {
      calls.push(`addPrivileges ${roleId} ${ids.map(label).join(' ')} ${businessUnitId}`);
      fail('addPrivileges');
      const role = find(roleId);
      for (const id of ids) role.privileges.set(id, 'Global');
      return null;
    },
    /** @param {string} roleId @param {string} privilegeId */
    removePrivilege: async (roleId, privilegeId) => {
      calls.push(`removePrivilege ${roleId} ${label(privilegeId)}`);
      fail('removePrivilege');
      find(roleId).privileges.delete(privilegeId);
      return null;
    },
    firstTranscript: async () => {
      fail('firstTranscript');
      return o.transcripts?.[0];
    },
    /** @param {string} userId @param {string} target */
    principalAccess: async (userId, target) => {
      fail('principalAccess');
      if (!o.transcripts?.some((id) => target === `conversationtranscripts(${id})`)) throw httpError(404);
      const reads = (userRoles[userId] ?? []).some((id) => roles.find((r) => r.roleid === id)?.privileges.get('priv-transcript') === 'Global');
      return reads ? 'ReadAccess' : 'None';
    },
    /** @param {string} userId */
    userRoleIds: async (userId) => [...(userRoles[userId] ?? [])],
    /** @param {string} userId @param {string} roleId */
    assignRole: async (userId, roleId) => {
      calls.push(`assignRole ${userId} ${roleId}`);
      fail('assignRole');
      (userRoles[userId] ??= []).push(roleId);
      return null;
    },
    /** @param {string} userId @param {string} roleId */
    removeRole: async (userId, roleId) => {
      calls.push(`removeRole ${userId} ${roleId}`);
      fail('removeRole');
      if (!userRoles[userId]?.includes(roleId)) throw httpError(404);
      userRoles[userId] = userRoles[userId].filter((r) => r !== roleId);
      return null;
    },
  };
  /** What a role holds, as privilege name:depth, sorted. @param {string} roleId */
  const holds = (roleId) => [...find(roleId).privileges].map(([id, depth]) => `${label(id)}:${depth}`).sort();
  return { api, roles, holds };
}

/**
 * One Dataverse environment's application users and their roles, for the transcript reader. `failures` scripts an
 * error for each call of a method, in order. Like Dataverse, it deletes only a deactivated user, and answers 404 for a
 * user or role assignment that isn't there. `softDeletes` is how many deletes of a user only soft-delete it, as
 * Dataverse's first one does: the user stays, deactivated, with no role and deletedstate 1. Its roles are a
 * fakeRoleStore's.
 * @param {{ bu?: string | null, role?: string | null, users?: { systemuserid: string, applicationid: string, isdisabled?: boolean, deletedstate?: number, _businessunitid_value?: string }[], userRoles?: Record<string, string[]>, teamRoles?: Record<string, string[]>, units?: string[], copies?: boolean, roles?: FakeRole[], transcripts?: string[], softDeletes?: number }} [o]
 */
export function fakeTranscriptEnvironment(o = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  const users = structuredClone(o.users ?? []);
  /** @type {Record<string, string[]>} */
  const userRoles = structuredClone(o.userRoles ?? {});
  /** @type {Record<string, string[]>} */
  const teamRoles = structuredClone(o.teamRoles ?? {});
  /** Deletes so far, by user. @type {Record<string, number>} */
  const deletes = {};
  const bu = o.bu === undefined ? 'bu-root' : o.bu;
  const role = o.role === undefined ? 'role-btv' : o.role;
  let n = 0;
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const find = (/** @type {string} */ userId) => {
    const user = users.find((u) => u.systemuserid === userId);
    if (!user) throw httpError(404);
    return user;
  };
  const store = fakeRoleStore({ calls, fail, userRoles, teamRoles, root: bu, viewer: role, units: o.units, copies: o.copies, roles: structuredClone(o.roles ?? []), transcripts: o.transcripts });
  const api = {
    ...store.api,
    /** @param {string} appId */
    findAppUser: async (appId) => {
      calls.push(`findAppUser ${appId}`);
      fail('findAppUser');
      return users.find((u) => u.applicationid.toLowerCase() === appId.toLowerCase());
    },
    rootBusinessUnit: async () => bu ?? undefined,
    /** @param {string} appId @param {string} businessUnitId */
    createAppUser: async (appId, businessUnitId) => {
      calls.push(`createAppUser ${appId} ${businessUnitId}`);
      fail('createAppUser');
      const user = { systemuserid: `user-${++n}`, applicationid: appId, _businessunitid_value: businessUnitId };
      users.push(user);
      return user.systemuserid;
    },
    /** @param {string} userId */
    disableUser: async (userId) => {
      calls.push(`disableUser ${userId}`);
      fail('disableUser');
      find(userId).isdisabled = true;
      return null;
    },
    /** @param {string} userId */
    enableUser: async (userId) => {
      calls.push(`enableUser ${userId}`);
      fail('enableUser');
      find(userId).isdisabled = false;
      return null;
    },
    /** @param {string} userId */
    deleteUser: async (userId) => {
      calls.push(`deleteUser ${userId}`);
      fail('deleteUser');
      const user = find(userId);
      if (!user.isdisabled) throw httpError(400, 'Only an inactive application user can be deleted.');
      deletes[userId] = (deletes[userId] ?? 0) + 1;
      if (deletes[userId] <= (o.softDeletes ?? 0)) {
        user.deletedstate = 1;
        userRoles[userId] = [];
        return null;
      }
      users.splice(users.indexOf(user), 1);
      delete userRoles[userId];
      return null;
    },
    /** @param {string} userId */
    getUser: async (userId) => {
      calls.push(`getUser ${userId}`);
      fail('getUser');
      return users.find((u) => u.systemuserid === userId);
    },
  };
  return { api, calls, failures, users, userRoles, teamRoles, roles: store.roles, holds: store.holds };
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
    bindToGateway: async (/** @type {string} */ _ws, /** @type {string} */ dataset, /** @type {any} */ body) => {
      calls.push(`bindToGateway ${dataset} ${body.gatewayObjectId} ${body.datasourceObjectIds.join(',')}`);
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
 * @param {{ ui?: import('../src/ui.js').Ui, fabric?: any, graph?: any, oneLake?: any, arm?: any, keyVault?: any, powerBi?: any, discovery?: any, powerPlatform?: any, flow?: any, connections?: any, appCatalog?: any, dataverse?: (url: string) => any, dataLake?: (account: string) => any, runner?: import('../src/steps/app.js').Runner, sources?: import('../src/sources.js').Sources, config?: import('../src/config.js').InstallConfig, now?: Date }} [o]
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
        // No billing policies unless a test adds some.
        powerPlatform: o.powerPlatform ?? { billingPolicies: async () => [] },
        dataverse: o.dataverse,
        dataLake: o.dataLake,
        flow: o.flow,
        connections: o.connections,
        appCatalog: o.appCatalog,
      },
      user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
      sources: o.sources ?? realSources(),
      runner: o.runner,
      sleep: async (/** @type {number} */ ms) => {
        sleeps.push(ms);
      },
      now: () => o.now ?? new Date('2026-06-01T12:00:00Z'),
    })
  );
  return { ctx, config, sleeps, saves: () => saves };
}
