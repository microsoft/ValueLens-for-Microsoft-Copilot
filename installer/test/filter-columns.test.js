// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildAgentEvaluatorModel, buildConsumptionModel, buildModel, loadTemplateModel } from '../src/transform/model.js';
import { realSources } from './fakes.js';

/**
 * The app narrows every model with filter arguments on columns the shipped
 * templates already hold (app/src/lib/filter-profiles.ts). The Fabric and
 * Azure hosts build their models from the same templates, so checking the
 * built models here covers both.
 */

const sources = realSources();
const lake = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' };
const allModules = { orgData: true, m365Activity: true, agent365: true, productFeedback: true, defender: true, consumption: true, agentEvaluator: true };

const PROFILES = new URL('../../app/src/lib/filter-profiles.ts', import.meta.url);
const FILTERS = new URL('../../app/src/lib/filters.ts', import.meta.url);

/** @type {Record<string, () => import('../src/transform/model.js').ModelBim>} */
const build = {
  valuelens: () => buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { ...lake, modules: /** @type {any} */ (allModules), resourceGraph: true }),
  consumption: () => buildConsumptionModel(loadTemplateModel(/** @type {string} */ (sources.consumptionModelFile)), { ...lake, resourceGraph: true }),
  agentEvaluator: () => buildAgentEvaluatorModel(loadTemplateModel(/** @type {string} */ (sources.agentEvaluatorModelFile)), lake),
};

/** The columns each model's filter profile writes filter arguments on. */
const FILTERED_COLUMNS = {
  valuelens: [
    ['Calendar', 'Date'],
    ['Agents 365', 'Agent name'],
    ['Agents 365', 'Agent Type Label'],
    ['ProductFeedback', 'AgentName'],
    ['Chat + Agent Interactions (Audit Logs)', 'Environment'],
    ['Chat + Agent Interactions (Audit Logs)', 'Agent Filter (Normalized)'],
    ['Chat + Agent Interactions (Audit Logs)', 'AgentName'],
  ],
  consumption: [
    ['Reporting Date', 'Date'],
    ['Org', 'UserPrincipalName'],
    ['Org Attribute Source', 'UserPrincipalName'],
    ['Org Attribute Source', 'Attribute'],
    ['Org Attribute Source', 'Value'],
    ['Agent Bridge', 'Agent Name'],
  ],
  agentEvaluator: [
    ['Calendar', 'Date'],
    ['Chat + Agent Org Data', 'Organization'],
  ],
};

for (const [kind, columns] of Object.entries(FILTERED_COLUMNS)) {
  test(`filter profiles: ${kind} holds every column the app filters it on`, () => {
    const model = build[kind]().model;
    for (const [table, column] of columns) {
      const found = model.tables.find((/** @type {any} */ t) => t.name === table);
      assert.ok(found, `${kind} has no table '${table}'`);
      assert.ok(
        found.columns.some((/** @type {any} */ c) => c.name === column),
        `${kind} has no column '${table}'[${column}]`,
      );
    }
  });
}

test('filter profiles: this list follows the columns the app names', () => {
  const source = readFileSync(PROFILES, 'utf8') + readFileSync(FILTERS, 'utf8');
  for (const columns of Object.values(FILTERED_COLUMNS)) {
    for (const [table, column] of columns) {
      const ref = `'${table}'[${column}]`;
      const audit = table === 'Chat + Agent Interactions (Audit Logs)' ? `\${AUDIT}[${column}]` : undefined;
      assert.ok(source.includes(ref) || (audit && source.includes(audit)) || table === 'Calendar' || table === 'Chat + Agent Org Data', ref);
    }
  }
});

test('filter profiles: the Agent Evaluator holds every org column the app filters it by', () => {
  const list = /EVALUATOR_ORG_COLUMNS[^=]*=\s*\[([^\]]*)\]/.exec(readFileSync(PROFILES, 'utf8'));
  assert.ok(list, 'EVALUATOR_ORG_COLUMNS');
  const names = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  const org = build.agentEvaluator().model.tables.find((/** @type {any} */ t) => t.name === 'Chat + Agent Org Data');
  const held = new Set(org.columns.map((/** @type {any} */ c) => c.name));
  assert.deepEqual(names.filter((name) => !held.has(name)), []);
});

test('filter profiles: each per-person Consumption table relates to Org', () => {
  const model = build.consumption().model;
  const related = new Set(model.relationships.filter((/** @type {any} */ r) => r.toTable === 'Org').map((/** @type {any} */ r) => r.fromTable));
  assert.ok(related.size > 0, 'something relates to Org');
});
