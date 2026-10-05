// @ts-check
/** In-memory stand-ins for the Fabric and Graph APIs, the UI and the install record. */
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { loadSources } from '../src/sources.js';
import { createUi } from '../src/ui.js';

let sources;
/** Loads the real notebooks and pipeline once. */
export function realSources() {
  sources ??= loadSources();
  return sources;
}

/**
 * A UI that records output. `answers` scripts confirm and select replies in order;
 * when it runs out, the default is taken.
 * @param {{ yes?: boolean, answers?: any[] }} [opts]
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
  };
  return { ui: /** @type {import('../src/ui.js').Ui} */ (/** @type {unknown} */ (ui)), out, asked, text: () => out.join('') };
}

/** A Fabric workspace held in memory. */
export function fakeFabric() {
  let n = 0;
  /** @type {{ id: string, type: string, displayName: string, content?: any }[]} */
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
  /** Errors to throw, in order, the next times a method is called. @type {Record<string, Error[]>} */
  const failures = {};
  /** SQL endpoint states getLakehouse returns, in order; then a ready endpoint. @type {any[]} */
  const sqlStates = [];
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const add = (/** @type {string} */ type, /** @type {string} */ displayName, /** @type {any} */ content) => {
    const item = { id: `${type.toLowerCase()}-${++n}`, type, displayName, content };
    items.push(item);
    return item;
  };
  const find = (/** @type {string} */ id) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`no item ${id}`);
    return item;
  };
  const api = {
    /** @param {string} _ws @param {string} type */
    listItems: async (_ws, type) => items.filter((i) => i.type === type).map(({ id, type: t, displayName }) => ({ id, type: t, displayName })),
    /** @param {string} _ws @param {string} name @param {string} content */
    createNotebook: async (_ws, name, content) => {
      calls.push(`createNotebook ${name}`);
      return { id: add('Notebook', name, content).id };
    },
    /** @param {string} _ws @param {string} id @param {string} content */
    updateNotebook: async (_ws, id, content) => {
      calls.push(`updateNotebook ${find(id).displayName}`);
      find(id).content = content;
      return null;
    },
    /** @param {string} _ws @param {string} name @param {any} def */
    createPipeline: async (_ws, name, def) => {
      calls.push(`createPipeline ${name}`);
      // Fabric may answer 202 with no body; the step then finds the item by name.
      add('DataPipeline', name, def);
      return null;
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updatePipeline: async (_ws, id, def) => {
      calls.push(`updatePipeline ${find(id).displayName}`);
      find(id).content = def;
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
    /** @param {string} _ws @param {string} name */
    createLakehouse: async (_ws, name) => {
      calls.push(`createLakehouse ${name}`);
      return { id: add('Lakehouse', name, null).id };
    },
    /** @param {string} _ws @param {string} type @param {string} name */
    createItem: async (_ws, type, name) => {
      calls.push(`createItem ${type} ${name}`);
      const item = add(type, name, null);
      return { id: item.id, type, displayName: name };
    },
    /** @param {string} _ws @param {string} name @param {any} def */
    createSemanticModel: async (_ws, name, def) => {
      calls.push(`createSemanticModel ${name}`);
      fail('createSemanticModel');
      return { id: add('SemanticModel', name, def).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updateSemanticModel: async (_ws, id, def) => {
      calls.push(`updateSemanticModel ${find(id).displayName}`);
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
    listConnections: async () => connections.map(({ id, displayName }) => ({ id, displayName })),
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
    /** @param {string} _ws @param {string} id @param {any} binding */
    bindConnection: async (_ws, id, binding) => {
      calls.push(`bindConnection ${find(id).displayName} ${binding.id} ${binding.path}`);
      fail('bindConnection');
      return null;
    },
  };
  return { api, items, schedules, calls, jobs, jobList, activityRuns, roles, connections, failures, sqlStates, add };
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
    /** @param {string} _objectId @param {string} keyId */
    removePassword: async (_objectId, keyId) => {
      calls.push(`removePassword ${keyId}`);
      const at = passwords.findIndex((p) => p.keyId === keyId);
      if (at >= 0) passwords.splice(at, 1);
      return null;
    },
  };
  return { api, passwords, calls, failures };
}

/** Power BI refreshes. `states` scripts what each poll of a refresh returns. */
export function fakePowerBi() {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const states = [];
  /** @type {any[]} */
  const history = [];
  /** @type {Record<string, Error[]>} */
  const failures = {};
  /** @type {any[]} */
  let datasources = [{ datasourceType: 'Sql', connectionDetails: { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' } }];
  let n = 0;
  const api = {
    datasources: async () => datasources,
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
  };
  return {
    api,
    calls,
    states,
    history,
    failures,
    /** @param {any[]} d */
    setDatasources: (d) => {
      datasources = d;
    },
  };
}

/**
 * @param {{ ui?: import('../src/ui.js').Ui, fabric?: any, graph?: any, oneLake?: any, arm?: any, keyVault?: any, powerBi?: any, discovery?: any, powerPlatform?: any, dataverse?: (url: string) => any, runner?: import('../src/steps/app.js').Runner, sources?: import('../src/sources.js').Sources, config?: import('../src/config.js').InstallConfig, now?: Date }} [o]
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
