// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { realSources } from './fakes.js';
import { EVALUATOR_STATUS, EVALUATOR_STATUS_TABLE, LOAD_LOG, LOAD_LOG_TABLE } from '../src/transform/load-log.js';
import { buildAgentEvaluatorModel, buildModel, loadTemplateModel } from '../src/transform/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const sources = realSources();
const lake = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' };
const modules = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false };

/** @param {any} table */
const partition = (table) => [table.partitions[0].source.expression].flat().join('\n');

test('the ValueLens model reads dbo.load_log, falling back to an empty table', () => {
  const model = buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { ...lake, modules }).model;
  const table = model.tables.find((t) => t.name === LOAD_LOG_TABLE);
  assert.ok(table, 'the Load Log table is added whatever the sources');
  assert.match(partition(table), /try FabricTable\("load_log"\) otherwise EmptyTable\(Columns\)/);
  assert.deepEqual(table.columns.map((c) => c.name), LOAD_LOG.columns.map((c) => c.name));
  assert.equal(table.columns.find((c) => c.name === 'logged_at')?.formatString, 'General Date');
  assert.match(partition(table), /\{"logged_at", type datetime\}/);
});

test('the Load Log columns are ones the Record_Load_Status notebook writes', () => {
  const nb = JSON.parse(readFileSync(join(here, '..', '..', 'fabric', 'notebooks', 'AnalyticsHub_Load_Status.ipynb'), 'utf8'));
  const code = nb.cells.map((/** @type {any} */ c) => [c.source].flat().join('')).join('\n');
  for (const c of LOAD_LOG.columns) assert.match(code, new RegExp(`StructField\\('${c.name}'`), c.name);
});

test('the Agent Evaluator model reads dbo.evaluator_status, and the parser writes its columns', () => {
  const model = buildAgentEvaluatorModel(loadTemplateModel(/** @type {string} */ (sources.agentEvaluatorModelFile)), lake).model;
  const table = model.tables.find((t) => t.name === EVALUATOR_STATUS_TABLE);
  assert.ok(table);
  assert.match(partition(table), /try FabricTable\("evaluator_status"\) otherwise EmptyTable\(Columns\)/);
  const nb = JSON.parse(readFileSync(join(here, '..', '..', 'fabric', 'notebooks', 'agent-evaluator', 'Copilot_Agent_Transcript_Parser.ipynb'), 'utf8'));
  const code = nb.cells.map((/** @type {any} */ c) => [c.source].flat().join('')).join('\n');
  for (const c of EVALUATOR_STATUS.columns) assert.ok(code.includes(`'${c.name}'`), c.name);
});

test('a template that already has the table is left alone', () => {
  const template = loadTemplateModel(/** @type {string} */ (sources.modelFile));
  const once = buildModel(template, { ...lake, modules });
  const twice = buildModel({ compatibilityLevel: 1600, model: once.model }, { ...lake, modules }).model;
  assert.equal(twice.tables.filter((t) => t.name === LOAD_LOG_TABLE).length, 1);
});
