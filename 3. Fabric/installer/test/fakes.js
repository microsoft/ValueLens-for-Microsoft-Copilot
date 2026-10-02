// @ts-check
/** In-memory stand-ins for the Fabric and Graph APIs, the UI and the install record. */
import { emptyConfig } from '../src/config.js';
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
    listJobs: async () => [],
  };
  return { api, items, schedules, calls, jobs, add };
}

/**
 * @param {{ ui?: import('../src/ui.js').Ui, fabric?: any, graph?: any, oneLake?: any, arm?: any, keyVault?: any, config?: import('../src/config.js').InstallConfig, now?: Date }} [o]
 */
export function fakeCtx(o = {}) {
  const config = o.config ?? emptyConfig();
  config.fabric.workspaceId ??= 'ws-1';
  config.fabric.lakehouseId ??= 'lh-1';
  config.fabric.lakehouseName ??= 'ValueLens';
  config.app.appId ??= 'app-1';
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
      api: { fabric: o.fabric, graph: o.graph, oneLake: o.oneLake, arm: o.arm, keyVault: o.keyVault },
      user: { id: 'user-1', upn: 'admin@contoso.com', tenantId: 'tenant-1' },
      sources: realSources(),
      sleep: async (/** @type {number} */ ms) => {
        sleeps.push(ms);
      },
      now: () => o.now ?? new Date('2026-06-01T12:00:00Z'),
    })
  );
  return { ctx, config, sleeps, saves: () => saves };
}
