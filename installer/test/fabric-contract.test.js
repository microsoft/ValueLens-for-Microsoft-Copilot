// @ts-check
/**
 * The contract between the Fabric template and the notebooks the installer deploys from `1. Fabric/Manual setup`.
 * Every Lakehouse table the built model reads must have a deployed notebook that writes it, and every column the
 * model takes from that table must be named in one of its writers, unless the template makes the column itself.
 * The column check is textual, like the M365 one in m365.test.js: it catches a column dropped or renamed throughout
 * a notebook, not one the notebook still mentions under its old name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTEBOOKS } from '../src/catalog.js';
import { notebookSettings } from '../src/steps/fabric.js';
import { AUDIT_TABLE, buildModel, loadTemplateModel } from '../src/transform/model.js';
import { prepareNotebook } from '../src/transform/notebook.js';
import { fakeCtx, realSources } from './fakes.js';

/** @typedef {import('../src/catalog.js').NotebookKey} NotebookKey */

/**
 * The deployed notebooks that write each Lakehouse table the model reads. When the template reads a new table, add
 * its writers here. A table with several writers (an API and a CSV route, say) needs each column named in one of them.
 * @type {Record<string, NotebookKey[]>}
 */
const WRITERS = {
  copilot_interactions_curated: ['processor'],
  copilot_licensed_users: ['licensedUsers'],
  copilot_org_data: ['orgData', 'workdayLander'],
  agents_365: ['agent365Lander', 'agent365Registry'],
  user_feedback: ['productFeedback'],
  m365_activity_daily: ['m365Activity'],
  defender_ai_watchlist: ['defender'],
  defender_shadow_ai_daily: ['defender'],
  defender_shadow_ai_totals_daily: ['defender'],
  defender_ai_installed: ['defender'],
  defender_cloud_discovery_ai: ['defender'],
  defender_ai_agents: ['defender'],
  defender_status: ['defender'],
  arg_agent_config: ['resourceGraph'],
  arg_environments: ['resourceGraph'],
  arg_agent_flows: ['resourceGraph'],
  arg_foundry_resources: ['resourceGraph'],
  arg_status: ['resourceGraph'],
  load_log: ['loadStatus'],
  access_scope: ['accessScope'],
  access_people: ['accessScope'],
};

const sources = realSources();
/** The model with every module, Resource Graph and org-scoped access on, so it reads every table it can. */
const model = buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), {
  server: 'abc.datawarehouse.fabric.microsoft.com',
  database: 'ValueLens',
  modules: /** @type {any} */ ({ orgData: true, m365Activity: true, agent365: true, productFeedback: true, defender: true }),
  resourceGraph: true,
  access: { orgAttribute: 'department' },
}).model;

const text = (/** @type {string | string[] | undefined} */ v) => (Array.isArray(v) ? v.join('\n') : (v ?? ''));
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each table's M, with the incremental-refresh source the service builds its partitions from. */
const tableQueries = new Map(
  model.tables.map((t) => [
    /** @type {string} */ (t.name),
    [...(t.partitions ?? []).map((/** @type {any} */ p) => text(p.source?.expression)), text(t.refreshPolicy?.sourceExpression)].join('\n'),
  ]),
);
/** Every query in the model: the tables' and the shared ones, such as FabricTable itself. */
const allQueries = new Map([...tableQueries, ...(model.expressions ?? []).map((e) => /** @type {[string, string]} */ ([`expression ${e.name}`, text(e.expression)]))]);

/** The Lakehouse tables a query reads through the template's FabricTable function, which ignores case. */
const reads = (/** @type {string} */ m) => [...new Set([...m.matchAll(/\bFabricTable\(\s*"([^"]+)"\s*\)/g)].map((x) => x[1].toLowerCase()))];

/** @type {Map<NotebookKey, string>} */
const deployed = new Map();
/** The code cells of a notebook as the installer deploys it, with its settings filled in. */
function codeOf(/** @type {NotebookKey} */ key) {
  let code = deployed.get(key);
  if (code === undefined) {
    const nb = NOTEBOOKS.find((n) => n.key === key);
    if (!nb) throw new Error(`${key} isn't a notebook the installer deploys.`);
    const { ctx } = fakeCtx();
    const prepared = prepareNotebook(sources.notebooks[key], notebookSettings(ctx, nb));
    code = prepared.cells
      .filter((/** @type {any} */ c) => c.cell_type === 'code')
      .map((/** @type {any} */ c) => [].concat(c.source).join(''))
      .join('\n');
    deployed.set(key, code);
  }
  return code;
}

/** The arguments of each `fn(...)` call in `m`, found by matching brackets outside M's strings. */
function callArgs(/** @type {string} */ m, /** @type {string} */ fn) {
  /** @type {string[]} */
  const out = [];
  for (let at = m.indexOf(`${fn}(`); at >= 0; at = m.indexOf(`${fn}(`, at + 1)) {
    const start = at + fn.length + 1;
    let depth = 1;
    let inString = false;
    let i = start;
    for (; i < m.length && depth > 0; i++) {
      if (m[i] === '"') inString = !inString;
      else if (!inString && m[i] === '(') depth++;
      else if (!inString && m[i] === ')') depth--;
    }
    out.push(m.slice(start, i - 1));
  }
  return out;
}

/** What each column the template renames is called in the Lakehouse: new name to old. */
function renamesIn(/** @type {string} */ m) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const args of callArgs(m, 'Table.RenameColumns')) {
    for (const [, from, to] of args.matchAll(/\{\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\}/g)) out.set(to, from);
  }
  return out;
}

/** Whether the template makes the column itself, with Table.AddColumn or its addNull helper, rather than reading it. */
const madeInTemplate = (/** @type {string} */ m, /** @type {string} */ column) =>
  new RegExp(`\\b(?:Table\\.AddColumn|addNull)\\(\\s*[^,()]+,\\s*"${esc(column)}"`).test(m);

/**
 * Problems with the tables the queries read: one no notebook is known to write, or a writer that no longer names
 * it or writes no Delta table.
 * @param {Map<string, string>} queries
 * @param {(key: NotebookKey) => string} code
 */
function tableProblems(queries, code) {
  /** @type {string[]} */
  const problems = [];
  const read = new Set([...queries.values()].flatMap(reads));
  for (const table of read) {
    const writers = WRITERS[table];
    if (!writers) {
      problems.push(`${table}: no notebook is known to write it; add its writers to WRITERS`);
      continue;
    }
    for (const key of writers) {
      if (!NOTEBOOKS.some((nb) => nb.key === key)) {
        problems.push(`${table}: ${key} isn't a notebook the installer deploys`);
        continue;
      }
      const c = code(key);
      if (!new RegExp(`(['"])(?:dbo\\.)?${esc(table)}\\1`, 'i').test(c)) problems.push(`${table}: ${key} no longer names it`);
      if (!/\.saveAsTable\(/.test(c)) problems.push(`${table}: ${key} writes no Delta table`);
    }
  }
  for (const table of Object.keys(WRITERS)) if (!read.has(table)) problems.push(`${table}: the model no longer reads it; remove it from WRITERS`);
  return problems;
}

/**
 * The Lakehouse names of the columns a table takes from the Lakehouse that none of its writers names. A column the
 * template makes is left out; for one it renames, a writer must name the old name.
 * @param {any} table  A model table.
 * @param {string} m  Its M.
 * @param {(key: NotebookKey) => string} code
 */
function columnProblems(table, m, code) {
  const written = [...new Set(reads(m).flatMap((t) => WRITERS[t] ?? []))].map(code).join('\n');
  const renames = renamesIn(m);
  /** @type {string[]} */
  const missing = [];
  for (const c of table.columns ?? []) {
    if ((c.type ?? 'data') !== 'data' || !c.sourceColumn || madeInTemplate(m, c.sourceColumn)) continue;
    const name = renames.get(c.sourceColumn) ?? c.sourceColumn;
    if (!new RegExp(`(['"])${esc(name)}\\1`).test(written)) missing.push(name);
  }
  return missing;
}

test('the model reads the Lakehouse only through FabricTable, and names each table it reads', () => {
  const fabricTable = text(model.expressions?.find((e) => e.name === 'FabricTable')?.expression);
  assert.match(fabricTable, /Sql\.Database\(#"Fabric SQL Endpoint", #"Lakehouse Name"\)/);
  assert.match(fabricTable, /\[Schema\] = "dbo"/, 'it reads dbo, where the notebooks write');
  for (const [name, m] of allQueries) {
    if (name === 'expression FabricTable') continue;
    assert.doesNotMatch(m, /Sql\.Database\(|Lakehouse\.Contents\(/, `${name} reads the Lakehouse through FabricTable`);
    const mentions = (m.match(/\bFabricTable\b/g) ?? []).length;
    const named = (m.match(/\bFabricTable\(\s*"[^"]+"\s*\)/g) ?? []).length;
    assert.equal(mentions, named, `${name} calls FabricTable with each table's name, so this test sees what it reads`);
  }
  assert.ok(reads(/** @type {string} */ (tableQueries.get(AUDIT_TABLE))).includes('copilot_interactions_curated'));
});

test('each Lakehouse table the model reads is written by a notebook the installer deploys', () => {
  assert.deepEqual(tableProblems(allQueries, codeOf), []);
});

test('each column the model takes from the Lakehouse is named in a notebook that writes it', () => {
  /** @type {Record<string, string[]>} */
  const missing = {};
  for (const t of model.tables) {
    const m = /** @type {string} */ (tableQueries.get(t.name));
    if (!reads(m).length) continue;
    const gone = columnProblems(t, m, codeOf);
    if (gone.length) missing[t.name] = gone;
  }
  assert.deepEqual(
    missing,
    {},
    'The template reads these columns, but no notebook that writes their table names them. Rename them in the template too or, if the template makes one, teach madeInTemplate how.',
  );
});

test('the checks catch a table or column a notebook stops writing, and a table nothing writes', () => {
  /** The deployed code, with `from` replaced in one notebook. */
  const changed = (/** @type {NotebookKey} */ target, /** @type {[string, string][]} */ edits) => (/** @type {NotebookKey} */ key) =>
    key === target ? edits.reduce((c, [from, to]) => c.replaceAll(from, to), codeOf(key)) : codeOf(key);

  assert.deepEqual(tableProblems(allQueries, changed('processor', [['copilot_interactions_curated', 'copilot_interactions_v2']])), [
    'copilot_interactions_curated: processor no longer names it',
  ]);

  const audit = model.tables.find((t) => t.name === AUDIT_TABLE);
  const column = audit.columns.find((/** @type {any} */ c) => (c.type ?? 'data') === 'data' && c.sourceColumn)?.sourceColumn;
  assert.ok(column, 'the audit table has data columns');
  const renamed = changed('processor', [
    [`'${column}'`, `'${column}_v2'`],
    [`"${column}"`, `"${column}_v2"`],
  ]);
  assert.deepEqual(columnProblems(audit, /** @type {string} */ (tableQueries.get(AUDIT_TABLE)), renamed), [column]);

  const extra = new Map([...allQueries, ['New', 'let Source = FabricTable("new_table") in Source']]);
  assert.deepEqual(tableProblems(extra, codeOf), ['new_table: no notebook is known to write it; add its writers to WRITERS']);
});

test('a column the template makes is left out, and one it renames is checked by its Lakehouse name', () => {
  const m = [
    'let',
    '    A = FabricTable("t"),',
    '    B = Table.RenameColumns(A, {{"Old Name", "New"}, {"Gone", "Kept (renamed)"}}, MissingField.Ignore),',
    '    C = Table.AddColumn(#"B", "Made", each 1),',
    '    D = addNull(C, "Blank"),',
    '    E = Table.SelectColumns(D, {"Plain", "Listed"})',
    'in',
    '    E',
  ].join('\n');
  const columns = ['New', 'Kept (renamed)', 'Made', 'Blank', 'Plain', 'Listed'].map((n) => ({ name: n, sourceColumn: n }));
  const table = { columns: [...columns, { name: 'Calc', type: 'calculated', expression: '1' }] };
  assert.deepEqual(columnProblems(table, m, () => ''), ['Old Name', 'Gone', 'Plain', 'Listed'], 'nothing writes t, so every column it reads is missing');
  assert.deepEqual(
    [...renamesIn(m)],
    [
      ['New', 'Old Name'],
      ['Kept (renamed)', 'Gone'],
    ],
    'only pairs inside Table.RenameColumns are renames, not a two-column list',
  );
});
