// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultModules, MODULES, NOTEBOOKS_DIR, notebooksFor, OPTIONAL_MODULES, permissionsFor } from '../src/catalog.js';
import { realSources } from './fakes.js';
import { M365_COLUMNS, M365_RELATIONSHIPS, M365_SOURCE_TABLE, M365_TABLE, stableGuid } from '../src/transform/m365.js';
import { buildModel, loadTemplateModel } from '../src/transform/model.js';
import { buildPipeline, findActivity, REFRESH_ACTIVITY } from '../src/transform/pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const NOTEBOOK = join(here, '..', '..', NOTEBOOKS_DIR, 'Copilot_M365_Activity_Ingester.ipynb');

const WS = 'f0000000-0000-0000-0000-000000000000';
const ids = {
  auditIngester: 'nb-a',
  licensedUsers: 'nb-b',
  processor: 'nb-c',
  orgData: 'nb-d',
  m365Activity: 'nb-m',
  refreshModel: 'nb-r',
};
const on = { orgData: true, m365Activity: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false };
const off = { ...on, m365Activity: false };
const sources = realSources();
const template = loadTemplateModel(/** @type {string} */ (sources.modelFile));
const lake = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' };

test('catalog: on by default, after org data, deploys its notebook with credentials and needs no new permission', () => {
  assert.equal(defaultModules().m365Activity, true);
  assert.equal(OPTIONAL_MODULES[1], 'm365Activity');
  assert.deepEqual(MODULES.m365Activity.permissions, ['Reports.Read.All']);
  assert.deepEqual(permissionsFor(on), permissionsFor(off));
  const nb = notebooksFor(on).find((n) => n.key === 'm365Activity');
  assert.equal(nb?.file, 'Copilot_M365_Activity_Ingester.ipynb');
  assert.equal(nb?.credentials, true);
  assert.equal(nb?.placeholder, 'REPLACE_WITH_M365_ACTIVITY_NOTEBOOK_ID');
  assert.ok(!notebooksFor(off).some((n) => n.key === 'm365Activity'));
});

test('pipeline: the M365 branch runs in parallel when on and is removed when off', () => {
  const doc = buildPipeline(sources.pipeline, { workspaceId: WS, notebookIds: ids, modules: on });
  const branch = findActivity(doc.properties.activities, 'Conditionally_Run_M365_Activity');
  assert.deepEqual(branch.dependsOn, []);
  assert.equal(findActivity(doc.properties.activities, 'Run_M365_Activity_Ingester').typeProperties.notebookId, 'nb-m');
  assert.equal(doc.properties.parameters.EnableM365Activity.defaultValue, true);

  const without = buildPipeline(sources.pipeline, { workspaceId: WS, notebookIds: ids, modules: off });
  assert.equal(findActivity(without.properties.activities, 'Conditionally_Run_M365_Activity'), undefined);
  assert.equal(without.properties.parameters.EnableM365Activity, undefined);

  const { m365Activity, ...rest } = ids;
  assert.throws(() => buildPipeline(sources.pipeline, { workspaceId: WS, notebookIds: rest, modules: on }), /REPLACE_WITH_M365_ACTIVITY_NOTEBOOK_ID/);
});

test('pipeline: the model refresh waits for the M365 load, whether or not it succeeded', () => {
  const doc = buildPipeline(sources.pipeline, { workspaceId: WS, notebookIds: ids, modules: on, semanticModelId: 'model-1' });
  const refresh = findActivity(doc.properties.activities, REFRESH_ACTIVITY);
  assert.deepEqual(refresh.dependsOn, [
    { activity: 'Run_Audit_Log_Processor', dependencyConditions: ['Succeeded'] },
    { activity: 'Conditionally_Run_Org_Data', dependencyConditions: ['Completed'] },
    { activity: 'Conditionally_Run_M365_Activity', dependencyConditions: ['Completed'] },
  ]);
});

test('model: the table reads the Lakehouse when on, is empty when off, and the template is untouched', () => {
  const before = JSON.stringify(template);
  const bim = buildModel(template, { ...lake, modules: on });
  assert.equal(JSON.stringify(template), before);
  const table = bim.model.tables.find((t) => t.name === M365_TABLE);
  assert.ok(table);
  const expr = table.partitions[0].source.expression.join('\n');
  assert.match(expr, new RegExp(`try FabricTable\\("${M365_SOURCE_TABLE}"\\) otherwise EmptyTable\\(Columns\\)`));
  assert.deepEqual(table.columns.map((/** @type {any} */ c) => c.name), M365_COLUMNS.map((c) => c.name));
  for (const c of M365_COLUMNS) assert.match(expr, new RegExp(`\\{"${c.name}", `), `${c.name} is typed`);

  const empty = buildModel(template, { ...lake, modules: off }).model.tables.find((t) => t.name === M365_TABLE);
  const offExpr = empty.partitions[0].source.expression.join('\n');
  assert.doesNotMatch(offExpr, /FabricTable/);
  assert.match(offExpr, /Source = EmptyTable\(Columns\)/);
});

test('model: relationships point at real columns, lineage is stable and unique', () => {
  const model = buildModel(template, { ...lake, modules: on }).model;
  const rels = model.relationships.filter((/** @type {any} */ r) => r.fromTable === M365_TABLE);
  assert.equal(rels.length, M365_RELATIONSHIPS.length);
  for (const r of rels) {
    const to = model.tables.find((t) => t.name === r.toTable);
    assert.ok(to?.columns.some((/** @type {any} */ c) => c.name === r.toColumn), `${r.toTable}[${r.toColumn}] exists`);
    assert.ok(M365_COLUMNS.some((c) => c.name === r.fromColumn));
  }
  const again = buildModel(template, { ...lake, modules: on }).model;
  assert.deepEqual(again.relationships, model.relationships);
  const table = model.tables.find((t) => t.name === M365_TABLE);
  const tags = [table.lineageTag, ...table.columns.map((/** @type {any} */ c) => c.lineageTag), ...rels.map((/** @type {any} */ r) => r.name)];
  assert.equal(new Set(tags).size, tags.length);
  assert.match(stableGuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);

  const twice = buildModel({ compatibilityLevel: 1600, model }, { ...lake, modules: on }).model;
  assert.equal(twice.tables.filter((t) => t.name === M365_TABLE).length, 1, 'a model that has the table already is left alone');
});

test('model columns are all written by the notebook', () => {
  const nb = JSON.parse(readFileSync(NOTEBOOK, 'utf8'));
  const source = nb.cells.map((/** @type {any} */ c) => [].concat(c.source).join('')).join('\n');
  assert.match(source, new RegExp(`OUTPUT_TABLE\\s*=\\s*'dbo\\.${M365_SOURCE_TABLE}'`));
  for (const c of M365_COLUMNS) assert.ok(source.includes(`'${c.name}'`), `the notebook writes ${c.name}`);
});
