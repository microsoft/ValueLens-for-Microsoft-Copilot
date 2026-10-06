// @ts-check
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HttpError } from '../src/http.js';
import { ensureFlows, FLOW_FILES, flowsSummary, flowsWanted, planFlows } from '../src/steps/flows.js';
import { ensureWorkspaceRole } from '../src/steps/model.js';
import {
  CONNECTORS,
  connectorsUsed,
  FEEDBACK_FLOW_NAME,
  feedbackFlowDefinition,
  flowClientData,
  flowFile,
  hourBefore,
  STUDIO_FLOW_DAYS,
  STUDIO_FLOW_NAME,
  studioFlowDefinition,
} from '../src/transform/flows.js';
import { detectSource, UPLOAD_DIR } from '../src/uploads.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const TARGET = { tenantId: 't-1', clientId: 'c-1', secretName: 'my-secret', workspaceId: 'ws-guid', lakehouseId: 'lh-guid' };
const tmp = mkdtempSync(join(tmpdir(), 'ah-flows-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Every action in a definition, nested ones included. @param {any} actions @returns {[string, any][]} */
function allActions(actions) {
  return Object.entries(actions ?? {}).flatMap(([name, a]) => [[name, a], ...allActions(a.actions), ...allActions(a.else?.actions)]);
}

test('hourBefore: an hour before the pipeline, wrapping past midnight', () => {
  assert.deepEqual(hourBefore('02:30'), { hours: [1], minutes: [30] });
  assert.deepEqual(hourBefore('00:15'), { hours: [23], minutes: [15] });
});

test('feedbackFlowDefinition: saves feedback CSV attachments to the drop folder as the app, with the secret from Key Vault', () => {
  const def = feedbackFlowDefinition(TARGET);
  const actions = Object.fromEntries(allActions(def.actions));
  const put = actions.Save_to_drop_folder;
  assert.equal(put.type, 'Http');
  assert.equal(put.inputs.method, 'PUT');
  assert.ok(put.inputs.uri.startsWith(`https://onelake.blob.fabric.microsoft.com/ws-guid/lh-guid/${UPLOAD_DIR}/`));
  assert.equal(put.inputs.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(put.inputs.authentication.secret, "@body('Get_client_secret')?['value']");
  assert.equal(put.inputs.authentication.clientId, 'c-1');
  assert.equal(actions.Get_client_secret.inputs.parameters.secretName, 'my-secret');
  assert.deepEqual(actions.Get_client_secret.runtimeConfiguration.secureData.properties, ['inputs', 'outputs'], 'the secret stays out of run history');
  assert.deepEqual(connectorsUsed(def), [CONNECTORS.keyVault.name, CONNECTORS.outlook.name].sort());
  assert.ok(!JSON.stringify(def).includes('ClientSecret'), 'no secret parameter to fill in by hand');
});

test('studioFlowDefinition: one day per licensing call, CSVs the router recognises, and no snapshot without the entitlement', () => {
  const def = studioFlowDefinition(TARGET, { time: '02:00', timeZone: 'GMT Standard Time' });
  assert.deepEqual(def.triggers.Daily.recurrence.schedule, { hours: [1], minutes: [0] });
  assert.equal(def.triggers.Daily.recurrence.timeZone, 'GMT Standard Time');
  const actions = Object.fromEntries(allActions(def.actions));
  assert.equal(actions.For_each_day.foreach, `@range(1, ${STUDIO_FLOW_DAYS})`);
  const url = actions.Get_agent_credits.inputs.parameters['request/url'];
  assert.match(url, /^https:\/\/api\.powerplatform\.com\/licensing\/entitlements\/MCSMessages\/resources\?api-version=2024-10-01&fromDate=@\{variables\('Day'\)\}&toDate=@\{variables\('Day'\)\}/);
  assert.match(url, /continuationtoken=/);
  // The agent file is only saved when there are rows; the PUT sits inside the If.
  assert.equal(actions.Any_agent_credits.type, 'If');
  assert.equal(actions.Any_agent_credits.actions.Save_agent_credits.type, 'Http');
  assert.deepEqual(actions.Get_allocations.runAfter, { Get_entitlement: ['Succeeded'] });
  for (const [name, a] of allActions(def.actions)) {
    for (const dep of Object.keys(a.runAfter ?? {})) assert.ok(dep in actions, `${name} runs after ${dep}, which exists`);
    if (a.type === 'Http') assert.ok(a.runtimeConfiguration?.secureData, `${name} hides its inputs`);
  }

  const kindOf = (/** @type {string[]} */ headers) => {
    const d = detectSource(headers);
    return d.ok ? d.kind.kind : d.reason;
  };
  assert.equal(kindOf(Object.keys(actions.Rows.inputs.select)), 'studioAgentDaily');
  assert.equal(kindOf(Object.keys(actions.Entitlement_rows.inputs.variables[0].value[0])), 'studioEntitlement');
  assert.deepEqual(connectorsUsed(def), [CONNECTORS.keyVault.name, CONNECTORS.entra.name].sort());
});

test('flowClientData and flowFile: unbound connection references for each connector used', () => {
  const def = studioFlowDefinition(TARGET, { time: '06:00', timeZone: 'UTC' });
  const data = JSON.parse(flowClientData(def));
  assert.deepEqual(Object.keys(data.properties.connectionReferences).sort(), connectorsUsed(def));
  assert.equal(data.properties.connectionReferences.shared_keyvault.api.name, 'shared_keyvault');
  assert.deepEqual(data.properties.definition, def);
  const file = flowFile('X', def, 'note');
  assert.deepEqual(file.connectors.sort(), [CONNECTORS.keyVault.label, CONNECTORS.entra.label].sort());
});

test('flowsWanted: only for a source that takes exports', () => {
  const { config } = fakeCtx();
  config.uploads.feedbackFlow = true;
  config.uploads.studioFlow = true;
  assert.deepEqual(flowsWanted(config), []);
  config.dataSources.productFeedback = 'csv';
  config.dataSources.studioCredits = 'csv';
  assert.deepEqual(flowsWanted(config), ['feedback', 'studio']);
});

test('planFlows: asks for each flow, then picks the environment from the list', async () => {
  const { ui, asked } = fakeUi({ answers: [true, true, 'https://org2.crm.dynamics.com'] });
  const discovery = {
    instances: async () => [
      { Id: '1', Url: 'https://org1.crm.dynamics.com/', FriendlyName: 'Default', EnvironmentId: 'env-1' },
      { Id: '2', Url: 'https://org2.crm.dynamics.com/', FriendlyName: 'Ops', EnvironmentId: 'env-2' },
    ],
  };
  const { ctx, config } = fakeCtx({ ui, discovery });
  config.dataSources.productFeedback = 'csv';
  config.dataSources.studioCredits = 'csv';
  await planFlows(ctx);
  assert.equal(asked.length, 3);
  assert.deepEqual(config.uploads.flowEnvironment, { url: 'https://org2.crm.dynamics.com', id: 'env-2', name: 'Ops' });

  // Skipped sources switch their flows off and ask nothing.
  const quiet = fakeUi();
  const { ctx: ctx2, config: config2 } = fakeCtx({ ui: quiet.ui });
  config2.uploads.studioFlow = true;
  await planFlows(ctx2);
  assert.equal(config2.uploads.studioFlow, false);
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
    },
  };
}

test('ensureFlows: raises the app to Contributor, creates each flow once, updates it when the definition changes', async () => {
  const fabric = fakeFabric();
  fabric.roles.push({ id: 'ra-1', principal: { id: 'sp-1', type: 'ServicePrincipal' }, role: 'Viewer' });
  const dv = fakeDataverse();
  const { ui, text } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fabric.api, dataverse: () => dv.api });
  config.dataSources.productFeedback = 'csv';
  config.dataSources.studioCredits = 'csv';
  config.uploads = { feedbackFlow: true, studioFlow: true, flowEnvironment: { url: 'https://org1.crm.dynamics.com', id: 'env-1', name: 'Default' } };

  await ensureFlows(ctx);
  assert.ok(fabric.calls.includes('updateRoleAssignment ra-1 Contributor'));
  assert.deepEqual(dv.calls, [`createFlow ${FEEDBACK_FLOW_NAME}`, `createFlow ${STUDIO_FLOW_NAME}`]);
  assert.deepEqual(config.uploads.flowIds, { feedback: 'flow-1', studio: 'flow-2' });
  const clientdata = JSON.parse(dv.flows.get('flow-2').clientdata);
  assert.ok(clientdata.properties.definition.triggers.Daily);

  await ensureFlows(ctx);
  assert.equal(dv.calls.length, 2, 'a repair with nothing changed leaves the flows, and their sign-ins, alone');

  config.schedule.time = '05:00';
  await ensureFlows(ctx);
  assert.deepEqual(dv.calls.slice(2), [`updateFlow ${STUDIO_FLOW_NAME}`]);

  dv.flows.delete('flow-1');
  await ensureFlows(ctx);
  assert.match(text(), /was deleted\. Creating it again/);
  assert.equal(config.uploads.flowIds.feedback, 'flow-3');

  flowsSummary(ctx);
  assert.match(text(), /make\.powerautomate\.com\/environments\/env-1\/flows/);
  assert.match(text(), /Power Platform, Billing or Global administrator/);
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
  assert.ok(fabric.calls.includes('addRoleAssignment sp-1 Contributor'));
  const file = join(tmp, FLOW_FILES.feedback);
  assert.equal(config.uploads.flowFiles?.feedback, file);
  assert.ok(existsSync(file));
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.name, FEEDBACK_FLOW_NAME);
  assert.ok(written.definition.triggers.When_a_new_email_arrives_V3);
  assert.match(text(), /Couldn't create the flow .*No privilege/);

  flowsSummary(ctx);
  assert.match(text(), new RegExp(`to import: .*${FLOW_FILES.feedback}`));
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
