// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HttpError } from '../src/http.js';
import { ensureFlows, FLOW_FILES, flowDefinitions, flowsSkipped, flowsSummary, flowsWanted, planFlows } from '../src/steps/flows.js';
import { ensureWorkspaceRole } from '../src/steps/model.js';
import {
  BACKFILL_MARKER,
  connectionReferencesOf,
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

test('flowsWanted: the Studio api mode brings its flow; the feedback flow is asked for', () => {
  const { config } = fakeCtx();
  config.uploads.feedbackFlow = true;
  assert.deepEqual(flowsWanted(config), []);
  config.dataSources.productFeedback = 'csv';
  config.dataSources.studioCredits = 'csv';
  assert.deepEqual(flowsWanted(config), ['feedback'], 'Upload CSV only has no flow');
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

test('planFlows: asks about the feedback flow only, then picks the environment from the list', async () => {
  const { ui, asked } = fakeUi({ answers: [true, 'https://org2.crm.dynamics.com'] });
  const discovery = {
    instances: async () => [
      { Id: '1', Url: 'https://org1.crm.dynamics.com/', FriendlyName: 'Default', EnvironmentId: 'env-1' },
      { Id: '2', Url: 'https://org2.crm.dynamics.com/', FriendlyName: 'Ops', EnvironmentId: 'env-2' },
    ],
  };
  const { ctx, config } = fakeCtx({ ui, discovery });
  config.dataSources.productFeedback = 'csv';
  config.dataSources.studioCredits = 'api';
  await planFlows(ctx);
  assert.equal(asked.length, 2);
  assert.equal(config.uploads.feedbackFlow, true);
  assert.deepEqual(config.uploads.flowEnvironment, { url: 'https://org2.crm.dynamics.com', id: 'env-2', name: 'Ops' });

  // Skipped sources switch their flows off and ask nothing.
  const quiet = fakeUi();
  const { ctx: ctx2, config: config2 } = fakeCtx({ ui: quiet.ui });
  config2.uploads.feedbackFlow = true;
  await planFlows(ctx2);
  assert.equal(config2.uploads.feedbackFlow, false);
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
        flows.get(id).clientdata = clientdata;
      },
      async turnOffFlow(/** @type {string} */ id) {
        calls.push(`turnOffFlow ${flows.get(id).name}`);
        flows.get(id).statecode = 0;
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
  config.dataSources.productFeedback = 'csv';
  config.dataSources.studioCredits = 'api';
  config.uploads = { feedbackFlow: true, flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };

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
  assert.deepEqual(dv.calls.slice(1), [`turnOffFlow ${STUDIO_FLOW_NAME}`, `updateFlow ${STUDIO_FLOW_NAME}`]);
  const refs = connectionReferencesOf(dv.flows.get('flow-1').clientdata);
  assert.deepEqual(refs.shared_webcontents.connection, { name: 'shared_webcontents-conn' }, 'the Power Platform API sign-in is kept');
  assert.equal(refs.shared_keyvault, undefined);
  assert.match(text(), /turned it off\. Sign in to: HTTP with Microsoft Entra ID \(preauthorized\), for OneLake\. Then turn it on\./);
});

test('ensureFlows: when the flow can\'t be created, it is written to a file to import', async () => {
  const fabric = fakeFabric();
  const dv = fakeDataverse(true);
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fabric.api, dataverse: () => dv.api });
  ctx.configFile = join(tmp, 'valuelens-install.json');
  config.dataSources.productFeedback = 'csv';
  config.uploads = { feedbackFlow: true, flowEnvironment: { url: 'https://org1.crm.dynamics.com' } };

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
  assert.match(out, /about six months/);
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
