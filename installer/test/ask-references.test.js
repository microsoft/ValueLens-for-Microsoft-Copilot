// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { loadSources } from '../src/sources.js';
import { dataSourceInstructions, daxReferences, visibleSchema } from '../src/transform/data-agent.js';
import { buildModel, loadTemplateModel } from '../src/transform/model.js';

// A tool's `references` stand in for its query when the data agent's instructions name the
// measures and columns behind its figures, so they must be the deployed model's, and cover all
// the query reads.
const sources = loadSources();
const ask = /** @type {import('../src/transform/data-agent.js').Ask} */ (sources.ask);
const bim = buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), {
  server: 's',
  database: 'd',
  modules: emptyConfig().modules,
  resourceGraph: false,
});
const schema = visibleSchema(bim);
const measures = new Set(schema.flatMap((t) => t.measures.map((m) => m.name)));
/** @param {{ table: string, column: string }} c */
const key = (c) => `${c.table}\u0000${c.column}`;
const columns = new Set(schema.flatMap((t) => t.columns.map((c) => key({ table: t.name, column: c.name }))));
const tools = ask.catalogue.tools.filter((t) => t.references);
/** @param {string[] | undefined} refs */
const listed = (refs) => daxReferences((refs ?? []).join(' '));

// What the data agent was told about the summary and the trend before their queries worked some
// figures out themselves and named `references` instead. A change to these changes the agent's
// instructions and signature, so it is published again: change them only for what it should see.
const BEFORE_REFERENCES = {
  bottom_line:
    'Measures: [Expert Equivalent Hours], [AI Tasks], [All Active Users], [Licensed Users (Filter-Aware)], ' +
    '[Active Licensed Users], [% Active Licensed Users], [Active Unlicensed Users], [Habitual Users %, Last Month], ' +
    '[Power Users %, Last Month], [Active Agent Users]. ' +
    "Columns: 'Behavior Value Map'[Behavior], 'Chat + Agent Interactions (Audit Logs)'[Cowork Task Category], " +
    "'Chat + Agent Interactions (Audit Logs)'[AppHost], 'Effort Scenario'[Scenario], " +
    "'Chat + Agent Interactions (Audit Logs)'[WeekStart], 'Calendar'[Date], " +
    "'Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)], 'Chat + Agent Interactions (Audit Logs)'[AgentName], " +
    "'Chat + Agent Interactions (Audit Logs)'[Audit_UserId], 'Chat + Agent Org Data'[Organization].",
  monthly_trend:
    'Measures: [Expert Equivalent Hours], [AI Tasks], [% Active Licensed Users], [Habitual Users (Monthly)], ' +
    '[Power Users (Monthly)], [Inactive Users (Monthly)], [All Active Users]. ' +
    "Columns: 'Calendar'[Date], 'Effort Scenario'[Scenario], 'Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)].",
};

test('references name measures and columns the deployed main model shows, one per entry', () => {
  assert.ok(tools.length > 0, 'the catalogue lists some');
  for (const tool of tools) {
    assert.equal(tool.model, 'vl', `${tool.name}: only the main model's references are checked here`);
    for (const r of tool.references ?? []) {
      const refs = daxReferences(r);
      assert.equal(refs.measures.length + refs.columns.length, 1, `${tool.name}: ${r} is one measure or column`);
      assert.ok(refs.measures.every((m) => measures.has(m)) && refs.columns.every((c) => columns.has(key(c))), `${tool.name}: the model shows ${r}`);
    }
  }
});

test('the data agent names a tool\'s references, in order, in place of what its query reads', () => {
  const lines = dataSourceInstructions(ask, 'vl', schema).split('\n');
  for (const tool of tools) {
    const line = lines.find((l) => l.startsWith(`- ${tool.name}: `));
    assert.ok(line, tool.name);
    const refs = listed(tool.references);
    /** @type {string[]} */
    const parts = [];
    if (refs.measures.length) parts.push(`Measures: ${refs.measures.map((m) => `[${m}]`).join(', ')}.`);
    if (refs.columns.length) parts.push(`Columns: ${refs.columns.map((c) => `'${c.table.replace(/'/g, "''")}'[${c.column}]`).join(', ')}.`);
    assert.ok(line.includes(` ${parts.join(' ')}`), `${tool.name}: ${line}`);
  }
});

test('the data agent is told the same measures and columns for the summary and the trend as before, in the same order', () => {
  const lines = dataSourceInstructions(ask, 'vl', schema).split('\n');
  for (const [name, names] of Object.entries(BEFORE_REFERENCES)) {
    const tool = ask.catalogue.tools.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(lines.find((l) => l.startsWith(`- ${name}: `)), `- ${name}: ${tool.description} ${names}`);
  }
});

test('a query with references reads nothing else the model shows, beyond what the referenced measures are built from', () => {
  /** @type {Map<string, string>} */
  const expressions = new Map();
  for (const t of bim.model.tables) for (const m of t.measures ?? []) expressions.set(m.name, [m.expression].flat().join('\n'));
  for (const tool of tools) {
    const refs = listed(tool.references);
    const usedMeasures = new Set(refs.measures);
    const usedColumns = new Set(refs.columns.map(key));
    for (const m of usedMeasures) {
      const inner = daxReferences(expressions.get(m) ?? '');
      for (const x of inner.measures) if (expressions.has(x)) usedMeasures.add(x);
      for (const c of inner.columns) {
        usedColumns.add(key(c));
        if (expressions.has(c.column)) usedMeasures.add(c.column);
      }
    }
    const read = daxReferences(ask.queries[tool.name]);
    const fix = "add it to the tool's references in app/src/ask/catalogue.json";
    for (const m of read.measures) if (measures.has(m)) assert.ok(usedMeasures.has(m), `${tool.name} reads [${m}]: ${fix}`);
    for (const c of read.columns) if (columns.has(key(c))) assert.ok(usedColumns.has(key(c)), `${tool.name} reads '${c.table}'[${c.column}]: ${fix}`);
  }
});
