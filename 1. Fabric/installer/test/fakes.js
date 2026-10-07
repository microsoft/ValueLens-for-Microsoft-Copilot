// @ts-check
/** In-memory stand-ins for the Fabric and Graph APIs, the UI and the install record. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { loadSources } from '../src/sources.js';
import { createUi } from '../src/ui.js';

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
    /** @param {string} message @param {import('../src/uploads.js').SourceCard[]} cards */
    async sources(message, cards) {
      asked.push(message);
      return answers.length ? answers.shift() : { modes: Object.fromEntries(cards.map((card) => [card.id, card.mode])), files: [] };
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
    /** @param {string} _ws @param {string} name */
    createDataflow: async (_ws, name) => {
      calls.push(`createDataflow ${name}`);
      fail('createDataflow');
      return { id: add('Dataflow', name, null).id };
    },
    /** @param {string} _ws @param {string} id @param {any} def */
    updateDataflow: async (_ws, id, def) => {
      calls.push(`updateDataflow ${find(id).displayName}`);
      fail('updateDataflow');
      find(id).content = def;
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
    /** @param {string} _ws @param {string} name @param {any} def */
    createReport: async (_ws, name, def) => {
      calls.push(`createReport ${name}`);
      fail('createReport');
      return { id: add('Report', name, def).id };
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
    /** @param {string} id */
    deleteConnection: async (id) => {
      calls.push(`deleteConnection ${id}`);
      connections.splice(connections.findIndex((x) => x.id === id), 1);
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
      gateways.splice(gateways.findIndex((g) => g.id === id), 1);
    },
    /** @param {string} _ws @param {string} id @param {any} binding */
    bindConnection: async (_ws, id, binding) => {
      calls.push(`bindConnection ${find(id).displayName} ${binding.id} ${binding.path}`);
      fail('bindConnection');
      return null;
    },
  };
  return { api, items, schedules, calls, jobs, jobList, activityRuns, roles, connections, gateways, workspaceCapacities, failures, sqlStates, spark, add };
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
  /** @type {Record<string, Error[]>} */
  const failures = {};
  const fail = (/** @type {string} */ method) => {
    const err = failures[method]?.shift();
    if (err) throw err;
  };
  const api = {
    listSubscriptions: async () => [{ subscriptionId: 'sub-1', displayName: 'Sub', state: 'Enabled' }],
    listLocations: async () => [{ name: 'uksouth', displayName: 'UK South' }],
    sqlCapability: async (/** @type {string} */ _sub, /** @type {string} */ location) => {
      calls.push(`sqlCapability ${location}`);
      return restrictedSqlRegions.has(location) ? { status: 'Visible', reason: 'Subscriptions are restricted from provisioning in this region.' } : { status: 'Available' };
    },
    listResourceGroups: async () => Object.values(groups),
    getResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ name) => groups[name] ?? null,
    ensureResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ name, /** @type {string} */ location, /** @type {any} */ tags = {}) => {
      calls.push(`ensureResourceGroup ${name}`);
      groups[name] = { name, location, tags };
      return groups[name];
    },
    ensureProvider: async (/** @type {string} */ _sub, /** @type {string} */ ns) => {
      calls.push(`ensureProvider ${ns}`);
      return false;
    },
    ensureFeature: async (/** @type {string} */ _sub, /** @type {string} */ ns, /** @type {string} */ name) => {
      calls.push(`ensureFeature ${ns}/${name}`);
      return false;
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
    listResources: async () => resources,
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
          },
        },
      };
    },
    getSqlDatabase: async () => null,
    startContainerAppJob: async (/** @type {string} */ _sub, /** @type {string} */ _rg, /** @type {string} */ name) => {
      calls.push(`startJob ${name}`);
      return { name: `${name}-exec` };
    },
    getContainerAppJobExecution: async () => executions.shift() ?? { properties: { status: 'Succeeded' } },
    listContainerAppJobExecutions: async () => executions,
    deleteResourceGroup: async (/** @type {string} */ _sub, /** @type {string} */ rg) => {
      calls.push(`deleteResourceGroup ${rg}`);
      delete groups[rg];
    },
    deleteResource: async (/** @type {string} */ id) => {
      calls.push(`deleteResource ${id}`);
    },
  };
  return { api, calls, resources, groups, executions, failures, restrictedSqlRegions };
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
  const graphSp = { id: 'graph-sp', appId: '00000003-0000-0000-c000-000000000000', appRoles: [
    { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
    { id: 'r-reports', value: 'Reports.Read.All' },
    { id: 'r-users', value: 'User.Read.All' },
    { id: 'r-settings', value: 'ReportSettings.Read.All' },
  ], oauth2PermissionScopes: [{ id: 's-user-read', value: 'User.Read' }] };
  const pbiSp = { id: 'pbi-sp', appId: '00000009-0000-0000-c000-000000000000', oauth2PermissionScopes: [{ id: 's-dataset', value: 'Dataset.Read.All' }] };
  const api = {
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
    addPassword: async (/** @type {string} */ _id, /** @type {Date} */ end) => ({ keyId: `key-${++n}`, secretText: `secret-${n}`, endDateTime: end.toISOString() }),
    removePassword: async (/** @type {string} */ _id, /** @type {string} */ keyId) => {
      calls.push(`removePassword ${keyId}`);
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
    },
  };
  return { api, calls, applications, servicePrincipals };
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
    groups: async () => [],
    createGroup: async (/** @type {string} */ name) => {
      calls.push(`createGroup ${name}`);
      return { id: 'pbi-ws-1', name };
    },
    addGroupUser: async (/** @type {string} */ ws, /** @type {any} */ body) => {
      calls.push(`addGroupUser ${ws} ${body.identifier}`);
    },
    setRefreshSchedule: async (/** @type {string} */ ws, /** @type {string} */ dataset) => {
      calls.push(`setRefreshSchedule ${ws} ${dataset}`);
    },
    updateDatasource: async (/** @type {string} */ gw, /** @type {string} */ ds, /** @type {any} */ body) => {
      calls.push(`updateDatasource ${gw} ${ds} ${body.credentialDetails.credentialType}`);
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
