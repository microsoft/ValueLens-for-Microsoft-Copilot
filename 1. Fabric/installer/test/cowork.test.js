// @ts-check
/** Cowork credits from Viva Insights: the Dataflow, the questions, the pipeline step and the flags. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDataFlags, parseCli } from '../src/cli.js';
import { emptyConfig } from '../src/config.js';
import { COWORK_DATAFLOW_NAME, ensureCoworkDataflow, planCowork } from '../src/steps/consumption.js';
import { coworkDataflowOn } from '../src/steps/fabric.js';
import { COWORK_DATAFLOW_TABLE, coworkDataflowDefinition, coworkMashup, coworkQueryMetadata, isVivaId } from '../src/transform/dataflow.js';
import { buildPipeline, COWORK_DATAFLOW_ACTIVITY, findActivity } from '../src/transform/pipeline.js';
import { UPLOAD_DIR } from '../src/uploads.js';
import { fakeCtx, fakeFabric, fakeUi, httpError, realSources } from './fakes.js';

const PARTITION = '11111111-2222-3333-4444-555555555555';
const QUERY = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const OTHER_QUERY = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

/** @param {{ answers?: any[] }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const ui = fakeUi({ answers: o.answers });
  const config = emptyConfig();
  config.modules.consumption = true;
  config.dataSources.coworkCredits = 'api';
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, config });
  return { ...made, fabric, ui };
}

/** @param {any} def @param {string} path */
const part = (def, path) => Buffer.from(def.parts.find((/** @type {any} */ p) => p.path === path).payload, 'base64').toString('utf8');

test('dataflow: reads the Viva query into a text staging table in the Lakehouse', () => {
  const mashup = coworkMashup({ partitionId: ` ${PARTITION} `, queryId: QUERY, workspaceId: 'ws-1', lakehouseId: 'lh-1' });
  assert.match(mashup, new RegExp(`VivaInsights\\.Data\\("${PARTITION}", "", "${QUERY}"`));
  assert.match(mashup, /workspaceId = "ws-1"/);
  assert.match(mashup, /lakehouseId = "lh-1"/);
  assert.match(mashup, new RegExp(`Id = "${COWORK_DATAFLOW_TABLE}", ItemKind = "Table"`));
  assert.match(mashup, /type text/);
  assert.throws(() => coworkMashup({ partitionId: 'nope', queryId: QUERY, workspaceId: 'ws-1', lakehouseId: 'lh-1' }), /partition id should be a GUID/);

  const meta = coworkQueryMetadata('Cowork');
  assert.equal(meta.name, 'Cowork');
  for (const q of Object.values(meta.queriesMetadata)) assert.equal(q.loadEnabled, false, 'no staging');

  const def = coworkDataflowDefinition('Cowork', { partitionId: PARTITION, queryId: QUERY, workspaceId: 'ws-1', lakehouseId: 'lh-1' });
  assert.deepEqual(def.parts.map((p) => p.path), ['queryMetadata.json', 'mashup.pq', '.platform']);
  assert.match(part(def, 'mashup.pq'), /VivaInsights\.Data/);
  assert.equal(JSON.parse(part(def, '.platform')).metadata.type, 'Dataflow');
  const again = coworkDataflowDefinition('Cowork', { partitionId: PARTITION, queryId: QUERY, workspaceId: 'ws-1', lakehouseId: 'lh-1' });
  assert.deepEqual(again, def, 'the same query gives the same definition');

  assert.equal(isVivaId(PARTITION.toUpperCase()), true);
  assert.equal(isVivaId('1234'), false);
  assert.equal(isVivaId(undefined), false);
});

test('planCowork: asks for the partition and query; a blank partition falls back to the CSV export', async () => {
  const t = setup({ answers: [PARTITION, QUERY] });
  await planCowork(t.ctx);
  assert.equal(t.config.consumption.vivaPartition, PARTITION);
  assert.equal(t.config.consumption.vivaQuery, QUERY);
  assert.equal(t.config.dataSources.coworkCredits, 'api');

  const blank = setup({ answers: [''] });
  await planCowork(blank.ctx);
  assert.equal(blank.config.dataSources.coworkCredits, 'csv');
  assert.match(blank.ui.text(), new RegExp(UPLOAD_DIR));

  const csv = setup();
  csv.config.dataSources.coworkCredits = 'csv';
  await planCowork(csv.ctx);
  assert.deepEqual(csv.ui.asked, [], 'nothing to ask when the export is uploaded');

  const typo = setup({ answers: ['not-a-guid'] });
  await assert.rejects(planCowork(typo.ctx), /looks like 00000000/);
});

test('ensureCoworkDataflow: created once, left alone on re-run, redefined when the query changes, recreated when deleted', async () => {
  const t = setup();
  Object.assign(t.config.consumption, { vivaPartition: PARTITION, vivaQuery: QUERY });
  await ensureCoworkDataflow(t.ctx);
  assert.deepEqual(t.fabric.calls, [`createDataflow ${COWORK_DATAFLOW_NAME}`, `updateDataflow ${COWORK_DATAFLOW_NAME}`]);
  assert.ok(t.config.consumption.dataflowId);
  assert.equal(t.config.consumption.dataflowName, COWORK_DATAFLOW_NAME);
  assert.ok(coworkDataflowOn(t.config));
  assert.match(t.ui.text(), /Home > Manage connections,[\s\S]*sign in to Viva Insights[\s\S]*wait until it says the Dataflow is published/);

  t.fabric.calls.length = 0;
  await ensureCoworkDataflow(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'a re-run keeps the sign-ins the user added');

  t.config.consumption.vivaQuery = OTHER_QUERY;
  await ensureCoworkDataflow(t.ctx);
  assert.deepEqual(t.fabric.calls, [`updateDataflow ${COWORK_DATAFLOW_NAME}`]);
  const content = t.fabric.items.find((i) => i.type === 'Dataflow')?.content;
  assert.match(part(content, 'mashup.pq'), new RegExp(OTHER_QUERY));

  t.fabric.items.splice(t.fabric.items.findIndex((i) => i.type === 'Dataflow'), 1);
  t.fabric.calls.length = 0;
  await ensureCoworkDataflow(t.ctx);
  assert.deepEqual(t.fabric.calls, [`createDataflow ${COWORK_DATAFLOW_NAME}`, `updateDataflow ${COWORK_DATAFLOW_NAME}`]);
  assert.match(t.ui.text(), /was deleted\. Creating it again/);

  const theirs = setup();
  Object.assign(theirs.config.consumption, { vivaPartition: PARTITION, vivaQuery: QUERY });
  theirs.fabric.add('Dataflow', COWORK_DATAFLOW_NAME, 'theirs');
  await ensureCoworkDataflow(theirs.ctx);
  assert.equal(theirs.config.consumption.dataflowName, `${COWORK_DATAFLOW_NAME}_2`);
  assert.equal(theirs.fabric.items.find((i) => i.content === 'theirs')?.displayName, COWORK_DATAFLOW_NAME, 'one not ours is left alone');
});

test('ensureCoworkDataflow: without IDs, or when it cannot be made, Cowork credits come from the export', async () => {
  const none = setup();
  await ensureCoworkDataflow(none.ctx);
  assert.equal(none.config.dataSources.coworkCredits, 'csv');
  assert.deepEqual(none.fabric.calls, []);
  assert.match(none.ui.text(), /needs the Viva Insights partition and query IDs/);

  const denied = setup();
  Object.assign(denied.config.consumption, { vivaPartition: PARTITION, vivaQuery: QUERY });
  denied.fabric.failures.createDataflow = [httpError(403, 'Dataflows are turned off')];
  await ensureCoworkDataflow(denied.ctx);
  assert.equal(denied.config.dataSources.coworkCredits, 'csv');
  assert.match(denied.ui.text(), /Couldn't set up the Cowork credits Dataflow/);
  assert.equal(coworkDataflowOn(denied.config), false);

  const later = setup();
  Object.assign(later.config.consumption, { vivaPartition: PARTITION, vivaQuery: QUERY });
  await ensureCoworkDataflow(later.ctx);
  later.config.consumption.vivaQuery = OTHER_QUERY;
  later.fabric.failures.updateDataflow = [httpError(500, 'Busy')];
  await ensureCoworkDataflow(later.ctx);
  assert.equal(later.config.dataSources.coworkCredits, 'api', 'a working Dataflow is kept');
  assert.match(later.ui.text(), /still reads the last query it was given/);

  const skipped = setup();
  skipped.config.dataSources.coworkCredits = 'skip';
  await ensureCoworkDataflow(skipped.ctx);
  assert.deepEqual(skipped.fabric.calls, []);
});

test('pipeline: the Dataflow is refreshed between the Studio and Viva loads, only when there is one', () => {
  const ids = { auditIngester: 'a', licensedUsers: 'b', processor: 'c', orgData: 'd', refreshModel: 'e', studioConsumption: 'f', vivaConsumption: 'g' };
  const modules = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: true, agentEvaluator: false };
  const doc = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules, coworkDataflowId: 'df-1' });
  const step = findActivity(doc.properties.activities, COWORK_DATAFLOW_ACTIVITY);
  assert.equal(step.type, 'RefreshDataflow');
  assert.deepEqual(step.typeProperties, { workspaceId: 'ws-1', dataflowId: 'df-1', notifyOption: 'NoNotification', dataflowType: 'DataflowFabric' });
  assert.equal(step.policy.retry, 0);
  assert.deepEqual(step.dependsOn, [{ activity: 'Run_Consumption_Studio', dependencyConditions: ['Completed'] }]);
  assert.deepEqual(findActivity(doc.properties.activities, 'Run_Consumption_Viva').dependsOn, [{ activity: COWORK_DATAFLOW_ACTIVITY, dependencyConditions: ['Completed'] }]);

  const without = buildPipeline(realSources().pipeline, { workspaceId: 'ws-1', notebookIds: ids, modules });
  assert.ok(!without.properties.activities.some((/** @type {any} */ a) => a.name === COWORK_DATAFLOW_ACTIVITY));
});

test('flags: --studio-flow, --flow-environment and the Viva IDs go with install and fill the record', () => {
  const args = parseCli(['--data', 'studioCredits=csv', '--studio-flow', '--flow-environment', 'https://contoso.crm.dynamics.com/', '--viva-partition', PARTITION, '--viva-query', ` ${QUERY} `]);
  assert.equal(args.studioFlow, true);
  assert.equal(args.flowEnvironment, 'https://contoso.crm.dynamics.com');
  assert.equal(args.vivaQuery, QUERY);
  assert.throws(() => parseCli(['--viva-query', 'abc']), /--viva-query should be a GUID/);
  assert.throws(() => parseCli(['--flow-environment', 'not a url']), /--flow-environment should be the environment URL/);
  assert.throws(() => parseCli(['run', '--studio-flow']), /--studio-flow go with install/);
  assert.throws(() => parseCli(['--ui', '--viva-partition', PARTITION]), /Data sources page/);

  const config = emptyConfig();
  applyDataFlags(config, args);
  assert.equal(config.dataSources.studioCredits, 'csv');
  assert.equal(config.uploads.studioFlow, true);
  assert.deepEqual(config.uploads.flowEnvironment, { url: 'https://contoso.crm.dynamics.com' });
  assert.equal(config.consumption.vivaPartition, PARTITION);
  assert.equal(config.consumption.vivaQuery, QUERY);

  config.uploads.flowEnvironment = { url: 'https://contoso.crm.dynamics.com', id: 'env-1' };
  applyDataFlags(config, { dataSources: {}, flowEnvironment: 'https://contoso.crm.dynamics.com' });
  assert.equal(config.uploads.flowEnvironment.id, 'env-1', 'the same environment keeps what was found for it');
});
