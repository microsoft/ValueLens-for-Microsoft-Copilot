// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultModules, MODULES, notebooksFor, OPTIONAL_MODULES, permissionsFor, azureGraphRolesFor } from '../src/catalog.js';
import { resolveAppRoles } from '../src/clients/graph.js';
import { OPTIONAL_PERMISSIONS } from '../src/steps/identity.js';
import { AZURE_SUPPORTED_MODULES, enabledAzureModuleIds } from '../src/steps/azure/index.js';
import { defaultDataSources, DATA_SOURCES, modulesFromSources } from '../src/uploads.js';
import { addDefender, DEFENDER_MEASURE_TABLE, DEFENDER_MEASURES, DEFENDER_RELATIONSHIPS, DEFENDER_TABLES, stableGuid } from '../src/transform/defender.js';
import { buildModel, loadTemplateModel } from '../src/transform/model.js';
import { buildPipeline, findActivity, REFRESH_ACTIVITY } from '../src/transform/pipeline.js';
import { realSources } from './fakes.js';

const WS = 'f0000000-0000-0000-0000-000000000000';
const ids = { auditIngester: 'nb-a', licensedUsers: 'nb-b', processor: 'nb-c', orgData: 'nb-d', defender: 'nb-x', refreshModel: 'nb-r' };
const on = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false, defender: true };
const off = { ...on, defender: false };
const sources = realSources();
const template = loadTemplateModel(/** @type {string} */ (sources.modelFile));
const lake = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' };

test('defender catalog: off by default, optional, on Azure, and adds its Graph permissions only when picked', () => {
  assert.equal(defaultModules().defender, false);
  assert.ok(OPTIONAL_MODULES.includes('defender'));
  assert.equal(MODULES.defender.azure.supported, true);
  assert.deepEqual(MODULES.defender.permissions, ['ThreatHunting.Read.All', 'CloudApp-Discovery.Read.All']);
  assert.ok(permissionsFor(on).includes('ThreatHunting.Read.All'));
  assert.ok(!permissionsFor(off).includes('ThreatHunting.Read.All'));
  assert.ok(azureGraphRolesFor(on).includes('ThreatHunting.Read.All'));
  assert.ok(!azureGraphRolesFor(off).includes('CloudApp-Discovery.Read.All'));
  const nb = notebooksFor(on).find((n) => n.key === 'defender');
  assert.equal(nb?.file, 'Copilot_Defender_Ingester.ipynb');
  assert.equal(nb?.placeholder, 'REPLACE_WITH_DEFENDER_NOTEBOOK_ID');
  assert.ok(!notebooksFor(off).some((n) => n.key === 'defender'));
});

test('defender data source: api or skip, skip by default, and drives the module', () => {
  const source = DATA_SOURCES.find((s) => s.id === 'defender');
  assert.deepEqual(source?.modes, ['api', 'skip']);
  const ds = defaultDataSources();
  assert.equal(ds.defender, 'skip');
  assert.equal(modulesFromSources(ds).defender, false);
  assert.equal(modulesFromSources({ ...ds, defender: 'api' }).defender, true);
});

test('defender on Azure: a supported module, passed to the jobs only when ticked', () => {
  assert.ok(AZURE_SUPPORTED_MODULES.includes('defender'));
  assert.ok(enabledAzureModuleIds(on, {}).includes('defender'));
  assert.ok(!enabledAzureModuleIds(off, {}).includes('defender'));
});

test('defender permissions are optional: a tenant without them warns instead of failing', () => {
  for (const p of MODULES.defender.permissions) assert.ok(OPTIONAL_PERMISSIONS.includes(p), p);
  const sp = { appRoles: [{ id: 'r1', value: 'AuditLog.Read.All' }, { id: 'r2', value: 'ThreatHunting.Read.All' }] };
  const { roles, missing } = resolveAppRoles(sp, ['AuditLog.Read.All', ...MODULES.defender.permissions], OPTIONAL_PERMISSIONS);
  assert.deepEqual(roles.map((r) => r.value), ['AuditLog.Read.All', 'ThreatHunting.Read.All']);
  assert.deepEqual(missing, ['CloudApp-Discovery.Read.All']);
});

test('defender pipeline: runs after product feedback when on, before Dataverse, and the refresh waits for it', () => {
  const doc = buildPipeline(sources.pipeline, { workspaceId: WS, notebookIds: ids, modules: on, semanticModelId: 'model-1' });
  const branch = findActivity(doc.properties.activities, 'Conditionally_Run_Defender');
  assert.ok(branch);
  assert.equal(findActivity(doc.properties.activities, 'Run_Defender_Ingester').typeProperties.notebookId, 'nb-x');
  assert.equal(doc.properties.parameters.EnableDefender.defaultValue, true);
  const refresh = findActivity(doc.properties.activities, REFRESH_ACTIVITY);
  assert.ok(refresh.dependsOn.some((/** @type {any} */ d) => d.activity === 'Conditionally_Run_Defender' && d.dependencyConditions[0] === 'Completed'));

  const without = buildPipeline(sources.pipeline, { workspaceId: WS, notebookIds: ids, modules: off });
  assert.equal(findActivity(without.properties.activities, 'Conditionally_Run_Defender'), undefined);
  assert.equal(without.properties.parameters.EnableDefender, undefined);

  const { defender, ...rest } = ids;
  assert.throws(() => buildPipeline(sources.pipeline, { workspaceId: WS, notebookIds: rest, modules: on }), /REPLACE_WITH_DEFENDER_NOTEBOOK_ID/);
});

test('defender model: every table reads the Lakehouse when on, is empty when off, and the template is untouched', () => {
  const before = JSON.stringify(template);
  const model = buildModel(template, { ...lake, modules: on }).model;
  assert.equal(JSON.stringify(template), before);
  for (const t of Object.values(DEFENDER_TABLES)) {
    const table = model.tables.find((x) => x.name === t.name);
    assert.ok(table, t.name);
    const expr = table.partitions[0].source.expression.join('\n');
    assert.match(expr, new RegExp(`try FabricTable\\("${t.source}"\\) otherwise EmptyTable\\(Columns\\)`));
    assert.deepEqual(table.columns.map((/** @type {any} */ c) => c.name), t.columns.map(([c]) => c));
  }
  const offModel = buildModel(template, { ...lake, modules: off }).model;
  for (const t of Object.values(DEFENDER_TABLES)) {
    const expr = offModel.tables.find((x) => x.name === t.name).partitions[0].source.expression.join('\n');
    assert.doesNotMatch(expr, /FabricTable/);
  }
});

test('defender model: relationships point at real columns, measures are added once, lineage is unique', () => {
  const model = buildModel(template, { ...lake, modules: on }).model;
  const names = new Set(Object.values(DEFENDER_TABLES).map((t) => t.name));
  const rels = model.relationships.filter((/** @type {any} */ r) => names.has(r.fromTable));
  assert.equal(rels.length, DEFENDER_RELATIONSHIPS.length);
  for (const r of rels) {
    const to = model.tables.find((t) => t.name === r.toTable);
    const from = model.tables.find((t) => t.name === r.fromTable);
    assert.ok(to?.columns.some((/** @type {any} */ c) => c.name === r.toColumn), `${r.toTable}[${r.toColumn}]`);
    assert.ok(from?.columns.some((/** @type {any} */ c) => c.name === r.fromColumn), `${r.fromTable}[${r.fromColumn}]`);
  }
  const home = model.tables.find((t) => t.name === DEFENDER_MEASURE_TABLE);
  assert.deepEqual(home.measures.map((/** @type {any} */ m) => m.name), DEFENDER_MEASURES.map((m) => m.name));
  const all = model.tables.flatMap((t) => (t.measures ?? []).map((/** @type {any} */ m) => m.name));
  assert.equal(new Set(all).size, all.length, 'no measure name clashes with the template');
  for (const m of DEFENDER_MEASURES) {
    for (const ref of m.expression.join('\n').matchAll(/'([^']+)'\[(\w+)\]/g)) {
      const table = model.tables.find((t) => t.name === ref[1]);
      assert.ok(table?.columns.some((/** @type {any} */ c) => c.name === ref[2]), `${m.name}: ${ref[0]}`);
    }
  }
  const tags = model.tables.filter((t) => names.has(t.name)).flatMap((t) => [t.lineageTag, ...t.columns.map((/** @type {any} */ c) => c.lineageTag), ...(t.measures ?? []).map((/** @type {any} */ m) => m.lineageTag)]);
  assert.equal(new Set(tags).size, tags.length);
  assert.match(stableGuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);

  const twice = structuredClone(model);
  addDefender(twice, true);
  assert.deepEqual(twice, model, 'a model that has the tables already is left alone');
});
