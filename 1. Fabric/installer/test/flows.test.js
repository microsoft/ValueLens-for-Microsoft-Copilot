// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HttpError } from '../src/http.js';
import { ensureFlows, FLOW_FILES, flowDefinitions, flowsSkipped, flowsSummary, flowsWanted, offerStudioRun, planFlows, STUDIO_RUN_POLL_MS } from '../src/steps/flows.js';
import { run } from '../src/install.js';
import { ensureWorkspaceRole } from '../src/steps/model.js';
import {
  BACKFILL_MARKER,
  connectionReferencesOf,
  isBound,
  CONNECTORS,
  connectorsUsed,
  FEEDBACK_FLOW_NAME,
  feedbackFlowDefinition,
  FLOW_STATE_DIR,
  flowClientData,
  flowFile,
  hourBefore,
  newConnections,
  oneLakeEndpoint,
  STUDIO_BACKFILL_DAYS,
  STUDIO_FLOW_DAYS,
  STUDIO_FLOW_NAME,
  studioFlowDefinition,
} from '../src/transform/flows.js';
import { detectSource, UPLOAD_DIR } from '../src/uploads.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const ENDPOINT = oneLakeEndpoint('ws-guid', 'lh-guid');
/** @type {import('../src/transform/flows.js').FlowTarget} */
const USER = { endpoint: ENDPOINT };
/** @type {import('../src/transform/flows.js').FlowTarget} */
const APP = { identity: 'app', endpoint: ENDPOINT, tenantId: 't-1', clientId: 'c-1', secretName: 'my-secret' };
const SCHEDULE = { time: '02:00', timeZone: 'GMT Standard Time' };
const tmp = mkdtempSync(join(tmpdir(), 'ah-flows-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Every action in a definition, nested ones included. @param {any} actions @returns {[string, any][]} */
function allActions(actions) {
  return Object.entries(actions ?? {}).flatMap(([name, a]) => [[name, a], ...allActions(a.actions), ...allActions(a.else?.actions)]);
}

/**
 * What Power Automate checks on save: names are unique across the definition, and an action only
 * runs after a sibling in the same scope.
 * @param {any} def
 */
function assertWellFormed(def) {
  const names = allActions(def.actions).map(([n]) => n);
  assert.equal(new Set(names).size, names.length, `action names are unique: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  /** @param {any} actions */
  const walk = (actions) => {
    for (const [name, a] of Object.entries(actions ?? {})) {
      for (const dep of Object.keys(a.runAfter ?? {})) assert.ok(dep in actions, `${name} runs after ${dep}, a sibling`);
      walk(a.actions);
      walk(a.else?.actions);
    }
  };
  walk(def.actions);
}

const kindOf = (/** @type {string[]} */ headers) => {
  const d = detectSource(headers);
  return d.ok ? d.kind.kind : d.reason;
};

test('hourBefore: an hour before the pipeline, wrapping past midnight', () => {
  assert.deepEqual(hourBefore('02:30'), { hours: [1], minutes: [30] });
  assert.deepEqual(hourBefore('00:15'), { hours: [23], minutes: [15] });
});

test('feedbackFlowDefinition: as a user, creates then writes the file in OneLake, with no Key Vault and no secret', () => {
  const def = feedbackFlowDefinition(USER);
  assertWellFormed(def);
  const actions = Object.fromEntries(allActions(def.actions));
  assert.equal(actions.Get_client_secret, undefined);
  assert.deepEqual(actions.For_each_attachment.runAfter, {});
  assert.equal(actions.Save_to_drop_folder.type, 'Scope');
  const create = actions.Save_to_drop_folder_create.inputs;
  const write = actions.Save_to_drop_folder_write.inputs;
  assert.equal(create.host.connectionName, CONNECTORS.storage.name);
  assert.equal(create.host.apiId, '/providers/Microsoft.PowerApps/apis/shared_webcontents');
  assert.equal(create.parameters['request/method'], 'PUT');
  assert.equal(create.parameters['request/url'], `https://onelake.dfs.fabric.microsoft.com/ws-guid/lh-guid/${UPLOAD_DIR}/@{outputs('Save_to_drop_folder_path')}?resource=file`);
  assert.equal(write.parameters['request/method'], 'PATCH');
  assert.match(write.parameters['request/url'], /\?action=append&position=0&flush=true$/);
  assert.equal(write.parameters['request/body'], "@base64ToString(items('For_each_attachment')?['contentBytes'])");
  assert.ok(write.parameters['request/headers']['x-ms-version']);
  assert.deepEqual(actions.Save_to_drop_folder_write.runAfter, { Save_to_drop_folder_create: ['Succeeded'] });
  assert.deepEqual(actions.Save_to_drop_folder_write.runtimeConfiguration.secureData.properties, ['inputs']);
  assert.match(actions.Save_to_drop_folder_path.inputs, /utcNow/, 'the name is worked out once, so both calls hit the same file');
  assert.deepEqual(connectorsUsed(def), [CONNECTORS.outlook.name, CONNECTORS.storage.name].sort());
  assert.ok(!/keyvault|ClientSecret|secret/i.test(JSON.stringify(def)));
});

test('feedbackFlowDefinition: as the app, writes a block blob with the secret from Key Vault', () => {
  const def = feedbackFlowDefinition(APP);
  assertWellFormed(def);
  const actions = Object.fromEntries(allActions(def.actions));
  const put = actions.Save_to_drop_folder;
  assert.equal(put.type, 'Http');
  assert.ok(put.inputs.uri.startsWith(`https://onelake.blob.fabric.microsoft.com/ws-guid/lh-guid/${UPLOAD_DIR}/`));
  assert.equal(put.inputs.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(put.inputs.authentication.secret, "@body('Get_client_secret')?['value']");
  assert.equal(put.inputs.authentication.clientId, 'c-1');
  assert.equal(actions.Get_client_secret.inputs.parameters.secretName, 'my-secret');
  assert.deepEqual(actions.Get_client_secret.runtimeConfiguration.secureData.properties, ['inputs', 'outputs'], 'the secret stays out of run history');
  assert.deepEqual(connectorsUsed(def), [CONNECTORS.keyVault.name, CONNECTORS.outlook.name].sort());
});

test('studioFlowDefinition: as a user, two HTTP connections, no Key Vault, and CSVs the router recognises', () => {
  const def = studioFlowDefinition(USER, SCHEDULE);
  assertWellFormed(def);
  assert.deepEqual(def.triggers.Daily.recurrence.schedule, { hours: [1], minutes: [0] });
  assert.equal(def.triggers.Daily.recurrence.timeZone, 'GMT Standard Time');
  const actions = Object.fromEntries(allActions(def.actions));
  assert.deepEqual(connectorsUsed(def), [CONNECTORS.entra.name, CONNECTORS.storage.name].sort());
  assert.ok(!/keyvault|Get_client_secret/i.test(JSON.stringify(def)));

  const url = actions.Get_agent_credits.inputs.parameters['request/url'];
  assert.match(url, /^https:\/\/api\.powerplatform\.com\/licensing\/entitlements\/MCSMessages\/resources\?api-version=2024-10-01&fromDate=@\{variables\('Day'\)\}&toDate=@\{variables\('Day'\)\}/);
  assert.match(url, /continuationtoken=/);
  assert.equal(actions.Get_agent_credits.inputs.host.connectionName, CONNECTORS.entra.name);
  assert.equal(actions.Any_agent_credits.type, 'If');
  assert.equal(actions.Save_agent_credits.type, 'Scope');
  assert.equal(actions.Save_agent_credits_create.inputs.host.connectionName, CONNECTORS.storage.name);
  assert.deepEqual(actions.Get_allocations.runAfter, { Get_entitlement: ['Succeeded'] });

  assert.equal(kindOf(Object.keys(actions.Rows.inputs.select)), 'studioAgentDaily');
  assert.equal(kindOf(Object.keys(actions.User_page_rows.inputs.select)), 'studioUserDaily');
  assert.equal(kindOf(Object.keys(actions.Entitlement_rows.inputs.variables[0].value[0])), 'studioEntitlement');
});

test('studioFlowDefinition: environment names come from the environments call', () => {
  const actions = Object.fromEntries(allActions(studioFlowDefinition(USER, SCHEDULE).actions));
  assert.match(actions.Get_environments.inputs.parameters['request/url'], /\/environmentmanagement\/environments\?/);
  assert.match(actions.Rows.inputs.select['Environment Name'], /variables\('EnvNames'\)/);
  assert.equal(actions.Set_env_names.inputs.name, 'EnvNames');
  assert.deepEqual(actions.Check_backfill.runAfter, { Set_env_names: ['Succeeded', 'Failed', 'Skipped', 'TimedOut'] }, 'no environment names never stops the run');
});

test('studioFlowDefinition: the first run reads about six months, then marks it done', () => {
  const actions = Object.fromEntries(allActions(studioFlowDefinition(USER, SCHEDULE).actions));
  const marker = `${ENDPOINT}/${FLOW_STATE_DIR}/${BACKFILL_MARKER}`;
  assert.equal(actions.Check_backfill.inputs.parameters['request/method'], 'GET');
  assert.equal(actions.Check_backfill.inputs.parameters['request/url'], marker);
  const days = actions.Days.inputs.variables[0].value;
  assert.match(days, new RegExp(`, ${STUDIO_FLOW_DAYS}, ${STUDIO_BACKFILL_DAYS}\\)$`));
  assert.match(days, /401, 403/, 'a refused read is a sign-in problem, not a first run');
  assert.equal(actions.For_each_day.foreach, "@range(1, variables('Days'))");
  assert.deepEqual(actions.Mark_backfill_done.runAfter, { Any_agent_credits: ['Succeeded'] });
  assert.deepEqual(actions.Mark_backfill_done.expression, { greater: ["@variables('Days')", STUDIO_FLOW_DAYS] });
  assert.equal(actions.Save_backfill_marker.inputs.parameters['request/url'], `${marker}?resource=file`);
  assert.ok(!FLOW_STATE_DIR.startsWith(UPLOAD_DIR), 'the marker is outside the drop folder the router reads');
});

test('studioFlowDefinition: credits by user are best effort and never stop the entitlement', () => {
  const actions = Object.fromEntries(allActions(studioFlowDefinition(USER, SCHEDULE).actions));
  assert.equal(actions.Per_user_credits.type, 'Scope');
  assert.deepEqual(actions.Per_user_credits.runAfter, { Mark_backfill_done: ['Succeeded', 'Failed', 'Skipped', 'TimedOut'] });
  assert.deepEqual(actions.Get_entitlement.runAfter, { Per_user_credits: ['Succeeded', 'Failed', 'Skipped', 'TimedOut'] });
  assert.match(actions.Check_users.inputs.parameters['request/url'], /\/licensing\/entitlements\/MCSMessages\/users\?/);
  const url = actions.Get_user_credits.inputs.parameters['request/url'];
  assert.match(url, /\/MCSMessages\/users\?api-version=2024-10-01&fromDate=@\{variables\('UserDay'\)\}/);
  assert.match(url, /if\(empty\(variables\('UserToken'\)\), '', concat\('&continuationToken='/, 'the token is only sent when there is one');
  assert.match(actions.With_user.inputs.where, /userId/);
  assert.match(actions.Save_user_credits_path.inputs, /^StudioApiUserDaily_/);
  // The entitlement is saved last, so the run's result is the entitlement's.
  assert.equal(Object.keys(studioFlowDefinition(USER, SCHEDULE).actions).at(-1), 'Save_entitlement');
});

test('studioFlowDefinition: as the app, Key Vault and the Power Platform API, writing block blobs', () => {
  const def = studioFlowDefinition(APP, SCHEDULE);
  assertWellFormed(def);
  const actions = Object.fromEntries(allActions(def.actions));
  assert.deepEqual(connectorsUsed(def), [CONNECTORS.entra.name, CONNECTORS.keyVault.name].sort());
  assert.equal(actions.Save_agent_credits.type, 'Http');
  assert.equal(actions.Save_entitlement.type, 'Http');
  assert.equal(actions.Check_backfill.inputs.uri, `https://onelake.blob.fabric.microsoft.com/ws-guid/lh-guid/${FLOW_STATE_DIR}/${BACKFILL_MARKER}`);
  assert.deepEqual(actions.Get_environments.runAfter, { Get_client_secret: ['Succeeded'] });
  for (const [name, a] of allActions(def.actions)) if (a.type === 'Http') assert.ok(a.runtimeConfiguration?.secureData, `${name} hides its inputs`);
});

test('the writer takes any DFS endpoint: an ADLS Gen2 container works too', () => {
  const endpoint = 'https://acct.dfs.core.windows.net/landing';
  const user = Object.fromEntries(allActions(studioFlowDefinition({ endpoint, dropDir: 'uploads' }, SCHEDULE).actions));
  assert.equal(user.Save_entitlement_create.inputs.parameters['request/url'], `${endpoint}/uploads/@{outputs('Save_entitlement_path')}?resource=file`);
  const app = Object.fromEntries(allActions(studioFlowDefinition({ ...APP, endpoint, dropDir: 'uploads' }, SCHEDULE).actions));
  assert.ok(app.Save_entitlement.inputs.uri.startsWith('https://acct.blob.core.windows.net/landing/uploads/StudioApiEntitlement_'));
});

test('flowClientData and flowFile: a reference per connection, and an update keeps the sign-ins it can', () => {
  const def = studioFlowDefinition(USER, SCHEDULE);
  const data = JSON.parse(flowClientData(def));
  const refs = data.properties.connectionReferences;
  assert.deepEqual(Object.keys(refs).sort(), connectorsUsed(def));
  assert.equal(refs.shared_webcontents.api.name, 'shared_webcontents');
  assert.equal(refs.shared_webcontents_storage.api.name, 'shared_webcontents', 'two connections to the one connector');
  assert.deepEqual(refs.shared_webcontents_storage.connection, {});
  assert.deepEqual(data.properties.definition, def);
  const file = flowFile('X', def, 'note');
  assert.deepEqual(file.connectors.sort(), [CONNECTORS.entra.label, CONNECTORS.storage.label].sort());

  // An install that wrote as the app: Key Vault and the Power Platform API are signed in to.
  const signedIn = {
    shared_keyvault: { runtimeSource: 'embedded', connection: { name: 'kv-conn' }, api: { name: 'shared_keyvault' } },
    shared_webcontents: { runtimeSource: 'embedded', connection: { name: 'pp-conn' }, api: { name: 'shared_webcontents' } },
  };
  const updated = connectionReferencesOf(flowClientData(def, signedIn));
  assert.deepEqual(updated.shared_webcontents.connection, { name: 'pp-conn' });
  assert.deepEqual(updated.shared_webcontents_storage.connection, {});
  assert.equal(updated.shared_keyvault, undefined, 'the Key Vault reference goes');
  assert.deepEqual(newConnections(def, signedIn), [CONNECTORS.storage.name]);
  assert.deepEqual(newConnections(def, updated), [CONNECTORS.storage.name]);
  assert.deepEqual(connectionReferencesOf('not json'), {});
});

test("flowsWanted: each source's Power Automate mode brings its flow; Upload CSV has none", () => {
  const { config } = fakeCtx();
  assert.deepEqual(flowsWanted(config), []);
  config.dataSources.productFeedback = 'csv';
  config.dataSources.studioCredits = 'csv';
  assert.deepEqual(flowsWanted(config), [], 'Upload CSV has no flow');
  config.dataSources.productFeedback = 'api';
  assert.deepEqual(flowsWanted(config), ['feedback']);
  config.dataSources.studioCredits = 'api';
  assert.deepEqual(flowsWanted(config), ['feedback', 'studio']);

  // The secret in the notebooks no longer rules the flows out: they sign in themselves.
  config.keyVault.mode = 'notebook';
  assert.deepEqual(flowsWanted(config), ['feedback', 'studio']);
  assert.deepEqual(flowsSkipped(config), []);
  config.uploads.flowIdentity = 'app';
  assert.deepEqual(flowsWanted(config), []);
  assert.deepEqual(flowsSkipped(config), [FEEDBACK_FLOW_NAME, STUDIO_FLOW_NAME]);
});

test('flowDefinitions: the user identity by default, the app on request', () => {
  const { config } = fakeCtx();
  const user = flowDefinitions(config, 'tenant-1').studio.definition;
  assert.deepEqual(connectorsUsed(user), [CONNECTORS.entra.name, CONNECTORS.storage.name].sort());
  assert.match(JSON.stringify(user), /onelake\.dfs\.fabric\.microsoft\.com\/ws-1\/lh-1\//);
  config.uploads.flowIdentity = 'app';
  const app = flowDefinitions(config, 'tenant-1').studio.definition;
  assert.deepEqual(connectorsUsed(app), [CONNECTORS.entra.name, CONNECTORS.keyVault.name].sort());
  assert.match(JSON.stringify(app), /"clientId":"app-1"/);
});

test('planFlows: no follow-up about the feedback flow, just the environment from the list', async () => {
  const { ui, asked } = fakeUi({ answers: ['https://org2.crm.dynamics.com'] });
  const discovery = {
    instances: async () => [
      { Id: '1', Url: 'https://org1.crm.dynamics.com/', FriendlyName: 'Default', EnvironmentId: 'env-1' },
      { Id: '2', Url: 'https://org2.crm.dynamics.com/', FriendlyName: 'Ops', EnvironmentId: 'env-2' },
    ],
  };
  const { ctx, config } = fakeCtx({ ui, discovery });
  config.dataSources.productFeedback = 'api';
  config.dataSources.studioCredits = 'api';
  await planFlows(ctx);
  assert.equal(asked.length, 1);
  assert.deepEqual(config.uploads.flowEnvironment, { url: 'https://org2.crm.dynamics.com', id: 'env-2', name: 'Ops' });

  // No flow mode, no questions.
  const quiet = fakeUi();
  const { ctx: ctx2, config: config2 } = fakeCtx({ ui: quiet.ui });
  config2.dataSources.productFeedback = 'csv';
  await planFlows(ctx2);
  assert.equal(quiet.asked.length, 0);
});

/** A Dataverse environment with flows held in memory. */
function fakeDataverse(fail = false) {
  /** @type {Map<string, any>} */
  const flows = new Map();
  const calls = /** @type {string[]} */ ([]);
  let n = 0;
  return {
    flows,
    calls,
    api: {
      async createFlow(/** @type {any} */ f) {
        calls.push(`createFlow ${f.name}`);
        if (fail) throw new HttpError('403 No privilege', { method: 'POST', url: 'https://org/api/data/v9.2/workflows', status: 403 });
        const id = `flow-${++n}`;
        flows.set(id, { workflowid: id, name: f.name, statecode: 0, clientdata: f.clientdata });
        return id;
      },
      async getFlow(/** @type {string} */ id) {
        return flows.get(id);
      },
      async updateFlow(/** @type {string} */ id, /** @type {string} */ clientdata) {
        calls.push(`updateFlow ${flows.get(id).name}`);
        const refs = Object.values(connectionReferencesOf(clientdata));
        if (refs.some((r) => !isBound(r))) {
          throw new HttpError(`PATCH https://org/api/data/v9.2/workflows(${id}) returned 400 0x80060467 FlowMissingConnection: The flow is missing a connection for api '${refs.find((r) => !isBound(r)).api.name}'.`, { method: 'PATCH', url: `https://org/api/data/v9.2/workflows(${id})`, status: 400, code: '0x80060467' });
        }
        flows.get(id).clientdata = clientdata;
      },
      async turnOffFlow(/** @type {string} */ id) {
        calls.push(`turnOffFlow ${flows.get(id).name}`);
        flows.get(id).statecode = 0;
      },
      async deleteFlow(/** @type {string} */ id) {
        calls.push(`deleteFlow ${flows.get(id).name}`);
        if (flows.get(id).statecode === 1) throw new HttpError('400 Cannot delete an active workflow definition', { method: 'DELETE', url: 'https://org/api/data/v9.2/workflows', status: 400 });
        flows.delete(id);
      },
    },
  };
}

/** Signs in to every connection of a flow held in `dv`, and turns it on. @param {ReturnType<typeof fakeDataverse>} dv @param {string} id */
function signIn(dv, id) {
  const flow = dv.flows.get(id);
  const data = JSON.parse(flow.clientdata);
  for (const [name, ref] of Object.entries(data.properties.connectionReferences)) ref.connection = { name: `${name}-conn` };
  flow.clientdata = JSON.stringify(data);
  flow.statecode = 1;
}

test('ensureFlows: as a user, grants nothing, creates each flow once, and updates it keeping its sign-ins', async () => {
  const fabric = fakeFabric();
  const dv = fakeDataverse();
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fabric.api, dataverse: () => dv.api });
  config.dataSources.productFeedback = 'api';
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };

  await ensureFlows(ctx);
  assert.deepEqual(fabric.calls, [], 'the person who signs in brings their own workspace role');
  assert.deepEqual(dv.calls, [`createFlow ${FEEDBACK_FLOW_NAME}`, `createFlow ${STUDIO_FLOW_NAME}`]);
  assert.deepEqual(config.uploads.flowIds, { feedback: 'flow-1', studio: 'flow-2' });
  assert.ok(JSON.parse(dv.flows.get('flow-2').clientdata).properties.definition.triggers.Daily);

  await ensureFlows(ctx);
  assert.equal(dv.calls.length, 2, 'a repair with nothing changed leaves the flows, and their sign-ins, alone');

  signIn(dv, 'flow-2');
  config.schedule.time = '05:00';
  await ensureFlows(ctx);
  assert.deepEqual(dv.calls.slice(2), [`updateFlow ${STUDIO_FLOW_NAME}`], 'no new connection: left on');
  const refs = connectionReferencesOf(dv.flows.get('flow-2').clientdata);
  assert.deepEqual(refs.shared_webcontents_storage.connection, { name: 'shared_webcontents_storage-conn' });
  assert.equal(dv.flows.get('flow-2').statecode, 1);

  dv.flows.delete('flow-1');
  await ensureFlows(ctx);
  assert.match(text(), /was deleted\. Creating it again/);
  assert.equal(config.uploads.flowIds.feedback, 'flow-3');
});

test('ensureFlows: a repair moves an app flow to the user identity, turning it off until OneLake is signed in to', async () => {
  const fabric = fakeFabric();
  fabric.roles.push({ id: 'ra-1', principal: { id: 'sp-1', type: 'ServicePrincipal' }, role: 'Viewer' });
  const dv = fakeDataverse();
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fabric.api, dataverse: () => dv.api });
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowIdentity: 'app', flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };
  await ensureFlows(ctx);
  assert.ok(fabric.calls.includes('updateRoleAssignment ra-1 Contributor'), 'the app identity gets Contributor');
  signIn(dv, 'flow-1');

  delete config.uploads.flowIdentity;
  await ensureFlows(ctx);
  assert.deepEqual(dv.calls.slice(1), [
    `turnOffFlow ${STUDIO_FLOW_NAME}`, `updateFlow ${STUDIO_FLOW_NAME}`, `deleteFlow ${STUDIO_FLOW_NAME}`, `createFlow ${STUDIO_FLOW_NAME}`,
  ], 'turned off, then replaced when Dataverse turns down an update with a connection still to sign in to');
  assert.equal(config.uploads.flowIds?.studio, 'flow-2');
  const refs = connectionReferencesOf(dv.flows.get('flow-2').clientdata);
  assert.ok(refs.shared_webcontents && !isBound(refs.shared_webcontents));
  assert.equal(refs.shared_keyvault, undefined);
  assert.equal(dv.flows.get('flow-2').statecode, 0);
  assert.match(text(), /so Analytics Hub - Copilot Studio credits was replaced\. Sign in to all its connections again .*HTTP with Microsoft Entra ID \(preauthorized\), for OneLake.*Then turn it on\./);
});

test('ensureFlows: a changed flow with nothing signed in to yet is replaced, not patched (FlowMissingConnection)', async () => {
  const dv = fakeDataverse();
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api, dataverse: () => dv.api });
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };
  await ensureFlows(ctx);
  assert.equal(dv.flows.get('flow-1').statecode, 0, 'created off, and never signed in to');

  config.schedule.time = '05:00';
  await ensureFlows(ctx);
  assert.deepEqual(dv.calls.slice(1), [`deleteFlow ${STUDIO_FLOW_NAME}`, `createFlow ${STUDIO_FLOW_NAME}`]);
  assert.equal(config.uploads.flowIds?.studio, 'flow-2');
  assert.equal(dv.flows.size, 1);
  assert.match(text(), /Replaced the flow Analytics Hub - Copilot Studio credits with the new version/);
  assert.doesNotMatch(text(), /Couldn't create the flow/);
});

test('ensureFlows: sign-ins made in the designer are kept, whatever their shape, and the flow stays on', async () => {
  const dv = fakeDataverse();
  const { ui } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api, dataverse: () => dv.api });
  config.dataSources.studioCredits = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };
  await ensureFlows(ctx);
  const flow = dv.flows.get('flow-1');
  const data = JSON.parse(flow.clientdata);
  const refs = data.properties.connectionReferences;
  const names = Object.keys(refs);
  assert.ok(names.length >= 2);
  // As the designer saves them: one by connectionName with api.id only, the rest by a solution reference.
  const [first, ...rest] = names;
  const api = refs[first].api.name;
  refs[first] = { runtimeSource: 'embedded', connection: { connectionName: 'shared-conn-1', source: 'Invoker', id: `/providers/Microsoft.PowerApps/apis/${api}/connections/shared-conn-1` }, api: { id: `/providers/Microsoft.PowerApps/apis/${api}` } };
  for (const n of rest) refs[n].connection = { connectionReferenceLogicalName: `cr_${n}` };
  flow.clientdata = JSON.stringify(data);
  flow.statecode = 1;

  config.schedule.time = '05:00';
  await ensureFlows(ctx);
  assert.deepEqual(dv.calls.slice(1), [`updateFlow ${STUDIO_FLOW_NAME}`]);
  const after = connectionReferencesOf(dv.flows.get('flow-1').clientdata);
  assert.equal(after[first].connection.connectionName, 'shared-conn-1');
  for (const n of rest) assert.equal(after[n].connection.connectionReferenceLogicalName, `cr_${n}`);
  assert.equal(dv.flows.get('flow-1').statecode, 1);
});

test('isBound: the designer\'s shapes count, the installer\'s empty connection doesn\'t', () => {
  assert.equal(isBound({ connection: {} }), false);
  assert.equal(isBound({ connection: { connectionName: '' } }), false);
  assert.equal(isBound(undefined), false);
  assert.equal(isBound({ connection: { connectionName: 'shared-x' } }), true);
  assert.equal(isBound({ connection: { connectionReferenceLogicalName: 'cr_x' } }), true);
  assert.equal(isBound({ connection: { name: 'x-conn' } }), true);
});

test('ensureFlows: when the flow can\'t be created, it is written to a file to import', async () => {
  const fabric = fakeFabric();
  const dv = fakeDataverse(true);
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fabric.api, dataverse: () => dv.api });
  ctx.configFile = join(tmp, 'valuelens-install.json');
  config.dataSources.productFeedback = 'api';
  config.uploads = { flowEnvironment: { url: 'https://org1.crm.dynamics.com' } };

  await ensureFlows(ctx);
  const file = join(tmp, FLOW_FILES.feedback);
  assert.equal(config.uploads.flowFiles?.feedback, file);
  assert.ok(existsSync(file));
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.name, FEEDBACK_FLOW_NAME);
  assert.ok(written.definition.triggers.When_a_new_email_arrives_V3);
  assert.match(written.$comment, /for OneLake/);
  assert.match(text(), /Couldn't create the flow .*No privilege/);

  flowsSummary(ctx);
  assert.match(text(), new RegExp(`to import: .*${FLOW_FILES.feedback}`));
});

test('flowsSummary: short numbered steps for each connection; the private vault note only for the app identity', () => {
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ ui });
  config.dataSources.studioCredits = 'api';
  config.fabric.workspaceName = 'Analytics';
  config.keyVault.name = 'kv-private';
  config.keyVault.private = true;
  config.uploads = { flowIds: { studio: 'flow-1' }, flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };
  flowsSummary(ctx);
  const out = text();
  assert.match(out, /1\. Open it: https:\/\/make\.powerautomate\.com\/environments\/env-1\/flows/);
  assert.match(out, /2\. HTTP with Microsoft Entra ID \(preauthorized\), for the Power Platform API: Base Resource URL and Resource URI https:\/\/api\.powerplatform\.com\. Sign in as a Power Platform, Billing or Global administrator\./);
  assert.match(out, /3\. .*for OneLake: Base Resource URL https:\/\/onelake\.dfs\.fabric\.microsoft\.com, Resource URI https:\/\/storage\.azure\.com\. Sign in as someone with Contributor or higher on Analytics\./);
  assert.match(out, /4\. Save, then turn it on\./);
  assert.match(out, /5\. To load about six months now rather than at its first daily run, click Run\. Or use ".*run", which offers to run it before the pipeline\./);
  assert.match(out, /co-owner/);
  assert.doesNotMatch(out, /Key Vault|kv-private|trusted service|gateway/i);

  const app = fakeUi();
  const { ctx: ctx2, config: config2 } = fakeCtx({ ui: app.ui });
  config2.dataSources.studioCredits = 'api';
  config2.keyVault.name = 'kv-private';
  config2.keyVault.private = true;
  config2.uploads = { flowIdentity: 'app', flowIds: { studio: 'flow-1' }, flowEnvironment: { url: 'https://org1.crm.dynamics.com' } };
  flowsSummary(ctx2);
  assert.match(app.text(), /3\. Azure Key Vault: vault kv-private\./);
  assert.match(app.text(), /kv-private blocks public network access, which the Key Vault connector needs\. Run install --flow-identity user/);
  assert.doesNotMatch(app.text(), /trusted service|gateway|exempt/i);
});

test('ensureWorkspaceRole: never lowers a role, adds one when there is none', async () => {
  const fabric = fakeFabric();
  fabric.roles.push({ id: 'ra-1', principal: { id: 'sp-1', type: 'ServicePrincipal' }, role: 'Member' });
  const { ctx } = fakeCtx({ fabric: fabric.api });
  await ensureWorkspaceRole(ctx, 'Contributor');
  assert.deepEqual(fabric.calls, []);
  fabric.roles.length = 0;
  await ensureWorkspaceRole(ctx, 'Viewer');
  assert.deepEqual(fabric.calls, ['addRoleAssignment sp-1 Viewer']);
});

/**
 * Power Automate held in memory: one flow, its runs (newest first) and what each trigger does.
 * `after` scripts the new run's status on each look after a trigger.
 * @param {{ state?: string, runs?: any[], after?: string[], trigger?: () => Promise<any> }} [o]
 */
function fakeFlowApi(o = {}) {
  /** @type {string[]} */
  const calls = [];
  const runs = [...(o.runs ?? [])];
  const after = [...(o.after ?? ['Running', 'Succeeded'])];
  let triggered = false;
  const api = {
    /** @param {string} env @param {string} id */
    getFlow: async (env, id) => {
      calls.push(`getFlow ${env} ${id}`);
      return { name: id, properties: { state: o.state ?? 'Started' } };
    },
    listRuns: async () => {
      calls.push('listRuns');
      if (triggered && after.length > 0) runs[0].properties.status = after.length > 1 ? after.shift() : after[0];
      return runs.map((r) => ({ ...r, properties: { ...r.properties } }));
    },
    /** @param {string} env @param {string} id @param {string} trigger */
    runTrigger: async (env, id, trigger) => {
      calls.push(`runTrigger ${env} ${id} ${trigger}`);
      if (o.trigger) return o.trigger();
      triggered = true;
      runs.unshift({ name: 'run-new', properties: { status: 'Running' } });
      return undefined;
    },
  };
  return { api, calls };
}

/** A Fabric install with the Studio flow created in env-1. @param {Parameters<typeof fakeCtx>[0] & { marker?: boolean }} [o] */
function studioCtx(o = {}) {
  const { marker, ...rest } = o;
  /** @type {string[]} */
  const looked = [];
  const made = fakeCtx({
    oneLake: {
      /** @param {string} ws @param {string} lh @param {string} path */
      exists: async (ws, lh, path) => {
        looked.push(`${ws}/${lh}/${path}`);
        return !!marker;
      },
    },
    ...rest,
  });
  made.config.dataSources.studioCredits = 'api';
  made.config.uploads = { flowIds: { studio: 'flow-1' }, flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };
  return { ...made, looked };
}

test('offerStudioRun: a flow that is off gets the steps to run it, or nothing when the summary covers it', async () => {
  const ui = fakeUi();
  const flow = fakeFlowApi({ state: 'Stopped' });
  const { ctx } = studioCtx({ ui: ui.ui, flow: flow.api });
  assert.equal(await offerStudioRun(ctx), 'off');
  assert.match(ui.text(), new RegExp(`${STUDIO_FLOW_NAME} is off\\. To load about six months of Copilot Studio credits now:`));
  assert.match(ui.text(), /1\. Open https:\/\/make\.powerautomate\.com\/environments\/env-1\/flows/);
  assert.match(ui.text(), /2\. If it is off, sign in to its connections, save, and turn it on\./);
  assert.match(ui.text(), /3\. Click Run\./);
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(flow.calls, ['getFlow env-1 flow-1']);

  const quiet = fakeUi();
  const { ctx: ctx2 } = studioCtx({ ui: quiet.ui, flow: fakeFlowApi({ state: 'Suspended' }).api });
  assert.equal(await offerStudioRun(ctx2, { quietWhenOff: true }), 'off');
  assert.equal(quiet.text(), '');
});

test('offerStudioRun: nothing to offer once the backfill marker is in OneLake, or with no Studio flow', async () => {
  const ui = fakeUi();
  const flow = fakeFlowApi();
  const { ctx, looked } = studioCtx({ ui: ui.ui, flow: flow.api, marker: true });
  assert.equal(await offerStudioRun(ctx, { pipelineNext: true }), 'done');
  assert.deepEqual(looked, [`ws-1/lh-1/${FLOW_STATE_DIR}/${BACKFILL_MARKER}`]);
  assert.deepEqual(ui.asked, []);
  assert.ok(!flow.calls.some((x) => x.startsWith('runTrigger')));

  const none = fakeFlowApi();
  const { ctx: ctx2, config } = fakeCtx({ flow: none.api });
  config.dataSources.studioCredits = 'csv';
  assert.equal(await offerStudioRun(ctx2), 'skipped');
  const { ctx: ctx3, config: c3 } = studioCtx({ flow: none.api });
  c3.uploads.flowFiles = { studio: 'x.json' };
  assert.equal(await offerStudioRun(ctx3), 'skipped');
  assert.deepEqual(none.calls, []);
});

test('offerStudioRun: runs the Daily trigger as the signed-in user and waits for it before the pipeline', async () => {
  const ui = fakeUi();
  const flow = fakeFlowApi({ runs: [{ name: 'run-old', properties: { status: 'Failed' } }], after: ['Running', 'Running', 'Succeeded'] });
  const { ctx, sleeps } = studioCtx({ ui: ui.ui, flow: flow.api });
  assert.equal(await offerStudioRun(ctx, { pipelineNext: true }), 'ran');
  assert.equal(ui.asked.length, 1);
  assert.match(ui.asked[0], new RegExp(`${STUDIO_FLOW_NAME} hasn't loaded its first six months of Copilot Studio credits yet\\. Run it now\\?`));
  assert.ok(flow.calls.includes('runTrigger env-1 flow-1 Daily'));
  assert.ok(sleeps.length >= 1 && sleeps.every((ms) => ms === STUDIO_RUN_POLL_MS));
  assert.match(ui.text(), new RegExp(`Started ${STUDIO_FLOW_NAME}`));
  assert.match(ui.text(), new RegExp(`${STUDIO_FLOW_NAME} loaded its first six months`));

  // Without a pipeline to follow, the default is to start it and carry on.
  const quick = fakeFlowApi();
  const { ctx: ctx2, sleeps: s2 } = studioCtx({ flow: quick.api });
  assert.equal(await offerStudioRun(ctx2), 'started');
  assert.ok(quick.calls.includes('runTrigger env-1 flow-1 Daily'));
  assert.deepEqual(s2, []);

  // "Not now" runs nothing.
  const no = fakeFlowApi();
  const { ctx: ctx3 } = studioCtx({ ui: fakeUi({ answers: ['no'] }).ui, flow: no.api });
  assert.equal(await offerStudioRun(ctx3, { pipelineNext: true }), 'skipped');
  assert.ok(!no.calls.some((x) => x.startsWith('runTrigger')));
});

test('offerStudioRun: a run that fails is reported, and one already running can be waited for', async () => {
  const ui = fakeUi();
  const flow = fakeFlowApi({ after: ['Failed'] });
  const { ctx } = studioCtx({ ui: ui.ui, flow: flow.api });
  assert.equal(await offerStudioRun(ctx, { pipelineNext: true }), 'failed');
  assert.match(ui.text(), new RegExp(`${STUDIO_FLOW_NAME} failed\\. Open its run history in Power Automate`));

  const busy = fakeUi();
  const running = fakeFlowApi({ runs: [{ name: 'run-1', properties: { status: 'Running' } }] });
  let looks = 0;
  const list = running.api.listRuns;
  running.api.listRuns = async () => {
    const runs = await list();
    if (++looks >= 3) runs[0].properties.status = 'Succeeded';
    return runs;
  };
  const { ctx: ctx2 } = studioCtx({ ui: busy.ui, flow: running.api });
  assert.equal(await offerStudioRun(ctx2, { pipelineNext: true }), 'ran');
  assert.match(busy.asked[0], /is running now\. Wait for it before starting the pipeline\?/);
  assert.ok(!running.calls.some((x) => x.startsWith('runTrigger')));
});

test('offerStudioRun: a trigger Power Automate turns down ends in the steps, never an error', async () => {
  const ui = fakeUi();
  const flow = fakeFlowApi({
    trigger: async () => {
      throw new HttpError('CannotRunUnpublishedSolutionFlow: The flow is not published.', { method: 'POST', url: 'x', status: 409 });
    },
  });
  const { ctx } = studioCtx({ ui: ui.ui, flow: flow.api });
  assert.equal(await offerStudioRun(ctx, { pipelineNext: true }), 'failed');
  assert.match(ui.text(), new RegExp(`${STUDIO_FLOW_NAME} can't run until it is turned on\\.`));
  assert.match(ui.text(), /To load about six months of Copilot Studio credits now:/);
  assert.match(ui.text(), /3\. Click Run\./);

  const other = fakeUi();
  const broken = fakeFlowApi();
  broken.api.getFlow = async () => {
    throw new HttpError('Forbidden', { method: 'GET', url: 'x', status: 403 });
  };
  const { ctx: ctx2 } = studioCtx({ ui: other.ui, flow: broken.api });
  assert.equal(await offerStudioRun(ctx2), 'failed');
  assert.match(other.text(), new RegExp(`Couldn't run ${STUDIO_FLOW_NAME} \\(Forbidden\\)`));
});

test('offerStudioRun: --yes never runs it; an older record finds its environment ID; Azure goes by run history', async () => {
  const yes = fakeUi({ yes: true });
  const flow = fakeFlowApi();
  const { ctx } = studioCtx({ ui: yes.ui, flow: flow.api });
  assert.equal(await offerStudioRun(ctx, { pipelineNext: true }), 'skipped');
  assert.ok(!flow.calls.some((x) => x.startsWith('runTrigger')));
  assert.match(yes.text(), /hasn't loaded its first six months yet\. Run it in Power Automate, or run this without --yes/);

  const older = fakeFlowApi();
  const { ctx: ctx2, config: c2, saves } = studioCtx({
    flow: older.api,
    marker: true,
    discovery: { instances: async () => [{ Url: 'https://org1.crm.dynamics.com/', EnvironmentId: 'env-found' }] },
  });
  delete c2.uploads.flowEnvironment?.id;
  assert.equal(await offerStudioRun(ctx2), 'done');
  assert.equal(c2.uploads.flowEnvironment?.id, 'env-found');
  assert.equal(older.calls[0], 'getFlow env-found flow-1');
  assert.ok(saves() >= 1);

  const az = fakeFlowApi({ runs: [{ name: 'run-1', properties: { status: 'Succeeded' } }] });
  const { ctx: ctx3, config: c3, looked } = studioCtx({ flow: az.api });
  c3.target = 'azure';
  assert.equal(await offerStudioRun(ctx3, { pipelineNext: true }), 'done');
  assert.deepEqual(looked, [], 'no OneLake on Azure');

  const fresh = fakeFlowApi();
  const { ctx: ctx4, config: c4 } = studioCtx({ flow: fresh.api });
  c4.target = 'azure';
  assert.equal(await offerStudioRun(ctx4, { pipelineNext: true }), 'ran');
  assert.ok(fresh.calls.includes('runTrigger env-1 flow-1 Daily'));
});

test('run: offers the Studio flow first, so the pipeline it starts picks up its files', async () => {
  const fabric = fakeFabric();
  /** @type {string[]} */
  const order = [];
  const flow = fakeFlowApi();
  const trigger = flow.api.runTrigger;
  flow.api.runTrigger = async (env, id, t) => {
    order.push('flow');
    return trigger(env, id, t);
  };
  const api = /** @type {any} */ (fabric.api);
  const runJob = api.runJob;
  api.runJob = async (/** @type {any[]} */ ...args) => {
    order.push('pipeline');
    return runJob.apply(api, args);
  };
  const { ctx, config } = studioCtx({ fabric: fabric.api, flow: flow.api });
  config.fabric.pipelineId = 'pipe-1';
  config.firstRun = { status: 'Completed' };
  await run(ctx, { wait: false });
  assert.deepEqual(order, ['flow', 'pipeline']);
});