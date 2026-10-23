// @ts-check
/**
 * The Fabric data agent's definition: which semantic models it reads, the tables, columns and
 * measures it may use, and its instructions. The instructions come from the app's Ask catalogue
 * (app/src/ask/catalogue.json), so the agent, the Ask page and the Azure /api/ask share one list
 * of questions and one set of named queries.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ASK_CATALOGUE = 'app/src/ask/catalogue.json';
export const QUERIES_DIR = 'app/src/queries';
/** Fabric's limit for the agent's instructions, and for each data source's. */
export const INSTRUCTIONS_LIMIT = 15000;
/** Fabric's limit for a data source's description. */
export const DESCRIPTION_LIMIT = 800;

/**
 * @typedef {'vl' | 'cc' | 'ae'} ModelAlias
 * @typedef {{ name: string, page: string, model: ModelAlias, query: string, filters: string[], people?: string[], references?: string[], description: string }} AskTool
 * @typedef {{ minPeople: number, pages: { destination: string, questions: string[] }[], tools: AskTool[] }} AskCatalogue
 * @typedef {{ catalogue: AskCatalogue, queries: Record<string, string> }} Ask
 */

/**
 * The catalogue and the query files it names, relative to the source folder.
 * @param {AskCatalogue} catalogue
 */
export const askFiles = (catalogue) => [ASK_CATALOGUE, ...catalogue.tools.map((t) => `${QUERIES_DIR}/${t.query}`)];

/**
 * The Ask catalogue and its queries' DAX, keyed by tool name. Undefined when the source folder
 * has no catalogue.
 * @param {string} root
 * @returns {Ask | undefined}
 */
export function loadAsk(root) {
  const file = join(root, ASK_CATALOGUE);
  if (!existsSync(file)) return undefined;
  /** @type {AskCatalogue} */
  const catalogue = JSON.parse(readFileSync(file, 'utf8'));
  /** @type {Record<string, string>} */
  const queries = {};
  for (const tool of catalogue.tools) {
    const path = join(root, QUERIES_DIR, tool.query);
    if (!existsSync(path)) throw new Error(`The Ask catalogue names ${tool.query}, which isn't in ${QUERIES_DIR}.`);
    queries[tool.name] = readFileSync(path, 'utf8');
  }
  return { catalogue, queries };
}

/**
 * DAX with its comments and string literals blanked, so names inside them aren't read as references.
 * @param {string} dax
 */
export function daxCode(dax) {
  return dax
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(\/\/|--)[^\n]*/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * The measures and columns a query refers to: a bare `[Name]` is a measure, `'Table'[Name]` or
 * `Table[Name]` a column. Names of a query's own output columns look like measures too, so the
 * caller keeps only the ones the model has.
 * @param {string} dax
 * @returns {{ measures: string[], columns: { table: string, column: string }[] }}
 */
export function daxReferences(dax) {
  const code = daxCode(dax);
  /** @type {Set<string>} */
  const measures = new Set();
  /** @type {Map<string, { table: string, column: string }>} */
  const columns = new Map();
  const ref = /(?:'((?:[^']|'')+)'|([A-Za-z_][\w]*))?\[([^\]]+)\]/g;
  for (const m of code.matchAll(ref)) {
    const table = m[1]?.replace(/''/g, "'") ?? m[2];
    if (table) columns.set(`${table}\u0000${m[3]}`, { table, column: m[3] });
    else measures.add(m[3]);
  }
  return { measures: [...measures], columns: [...columns.values()] };
}

/** @param {string} name */
const quoteTable = (name) => `'${name.replace(/'/g, "''")}'`;

/**
 * A model's visible tables, columns and measures. Hidden objects are the model's plumbing.
 * @param {any} bim  `model.bim`'s content, or its `model`.
 * @returns {{ name: string, description?: string, columns: { name: string, dataType?: string, description?: string }[], measures: { name: string, description?: string }[] }[]}
 */
export function visibleSchema(bim) {
  const model = bim?.model ?? bim;
  return (model?.tables ?? [])
    .filter((/** @type {any} */ t) => !t.isHidden && !t.isPrivate)
    .map((/** @type {any} */ t) => ({
      name: t.name,
      description: text(t.description),
      columns: (t.columns ?? [])
        .filter((/** @type {any} */ c) => !c.isHidden && c.type !== 'rowNumber')
        .map((/** @type {any} */ c) => ({ name: c.name, dataType: c.dataType, description: text(c.description) })),
      measures: (t.measures ?? [])
        .filter((/** @type {any} */ m) => !m.isHidden)
        .map((/** @type {any} */ m) => ({ name: m.name, description: text(m.description) })),
    }))
    .filter((/** @type {any} */ t) => t.columns.length || t.measures.length);
}

/** @param {unknown} value */
function text(value) {
  const s = Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : '';
  return s.trim() || undefined;
}

/**
 * A stable ID for an element, so the same model gives the same definition.
 * @param {string[]} path
 */
export function elementId(path) {
  const h = createHash('sha1').update(path.join('\u0000')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The datasource elements: every visible table, with its columns and measures, selected.
 * @param {string} modelName
 * @param {ReturnType<typeof visibleSchema>} schema
 */
export function schemaElements(modelName, schema) {
  return schema.map((t) => ({
    id: elementId([modelName, t.name]),
    is_selected: true,
    display_name: t.name,
    type: 'semantic_model.table',
    ...(t.description ? { description: t.description } : {}),
    children: [
      ...t.columns.map((c) => ({
        id: elementId([modelName, t.name, c.name]),
        is_selected: true,
        display_name: c.name,
        type: 'semantic_model.column',
        ...(c.dataType ? { data_type: c.dataType } : {}),
        ...(c.description ? { description: c.description } : {}),
      })),
      ...t.measures.map((m) => ({
        id: elementId([modelName, t.name, '[measure]', m.name]),
        is_selected: true,
        display_name: m.name,
        type: 'semantic_model.measure',
        ...(m.description ? { description: m.description } : {}),
      })),
    ],
  }));
}

/** What each model holds, for its data source description. */
export const MODEL_DESCRIPTIONS = /** @type {Record<ModelAlias, string>} */ ({
  vl: 'Microsoft 365 Copilot and agent usage, licences, readiness, value, efficiency, feedback and governance, from the Analytics Hub Lakehouse.',
  cc: 'Copilot credit consumption: Copilot Studio, Cowork and pay-as-you-go credits, budgets and chargeback.',
  ae: 'Copilot Studio agent quality: conversation outcomes, topic health and evaluations from the agents\u2019 transcripts.',
});

/** The questions' pages, as the app labels them. */
const PAGE_LABELS = /** @type {Record<string, string>} */ ({
  executive: 'Executive summary',
  adoption: 'Adoption',
  leaderboards: 'Leaderboards',
  'work-patterns': 'Work patterns',
  'agent-evaluation': 'Agent evaluation',
  governance: 'Governance',
  readiness: 'Readiness',
  consumption: 'Consumption',
  value: 'Value',
  efficiency: 'Efficiency',
  feedback: 'Feedback',
  appendix: 'Appendix',
});

/**
 * The agent's instructions, for every data source.
 * @param {AskCatalogue} catalogue
 * @param {string[]} modelNames  The data sources' names.
 */
export function agentInstructions(catalogue, modelNames) {
  const rules = [
    'You are Analytics Hub Ask. You answer business leaders\u2019 questions about Microsoft 365 Copilot and agents: adoption, licences, credit consumption, value, efficiency, governance and agent quality.',
    `Answer only from these semantic models: ${modelNames.join(', ')}. Don\u2019t use general knowledge for any figure.`,
    '',
    'Rules:',
    '- Every number in an answer must come from a query you ran. Never estimate, round up a gap, or fill in a missing value.',
    '- Say which period each figure covers and the last date the data has (the latest ActivityDate in the audit log table).',
    '- If a query returns no rows, or a source has no data, say so plainly and name the source. Don\u2019t guess what it would have shown.',
    '- Describe differences as comparisons, never as causes. Don\u2019t say one thing caused, drove, led to or resulted in another.',
    '- Don\u2019t forecast. The only projection allowed is the budget runway the consumption model already calculates.',
    `- Never show a group of fewer than ${catalogue.minPeople} people. Leave out any organisation, department or other group whose people count is under ${catalogue.minPeople}, and say small groups are left out.`,
    '- Use the measures each data source\u2019s instructions name, rather than writing your own calculation: they are the definitions the Analytics Hub pages use, so your answer matches what people see there.',
    '- For what a metric means, read the Metric Glossary table.',
    '- Keep answers short: figures first, then one or two sentences. When asked, show the DAX you ran.',
    '',
    'Questions people ask, by Analytics Hub page:',
    ...catalogue.pages.map((p) => `- ${PAGE_LABELS[p.destination] ?? p.destination}: ${p.questions.join(' | ')}`),
  ];
  return fit(rules.join('\n'), INSTRUCTIONS_LIMIT);
}

/**
 * A data source's instructions: how each figure the Analytics Hub pages show is worked out on it.
 * @param {Ask} ask
 * @param {ModelAlias} alias
 * @param {ReturnType<typeof visibleSchema>} schema
 */
export function dataSourceInstructions(ask, alias, schema) {
  const measures = new Set(schema.flatMap((t) => t.measures.map((m) => m.name)));
  const columns = new Set(schema.flatMap((t) => t.columns.map((c) => `${t.name}\u0000${c.name}`)));
  const lines = [MODEL_DESCRIPTIONS[alias], ''];
  if (alias === 'vl') {
    lines.push(
      "Filter dates on 'Calendar'[Date] and organisations on 'Chat + Agent Org Data'[Organization], as the Analytics Hub pages do.",
      '',
    );
  }
  lines.push('How the Analytics Hub pages work out each figure. Use the same measures and columns:');
  for (const tool of ask.catalogue.tools.filter((t) => t.model === alias)) {
    // A query that works some figures out itself, for speed, lists the model's measures and
    // columns behind them as `references`, so the agent is pointed at those, not the query's own working.
    const refs = daxReferences(tool.references?.join(' ') ?? ask.queries[tool.name] ?? '');
    const ms = refs.measures.filter((m) => measures.has(m));
    const cs = refs.columns.filter((c) => columns.has(`${c.table}\u0000${c.column}`));
    const parts = [`- ${tool.name}: ${tool.description}`];
    if (ms.length) parts.push(`Measures: ${ms.map((m) => `[${m}]`).join(', ')}.`);
    if (cs.length) parts.push(`Columns: ${cs.map((c) => `${quoteTable(c.table)}[${c.column}]`).join(', ')}.`);
    if (tool.people?.length) parts.push(`People per row: ${tool.people.join(' + ')}; leave out rows under ${ask.catalogue.minPeople}.`);
    lines.push(parts.join(' '));
  }
  return fit(lines.join('\n'), INSTRUCTIONS_LIMIT);
}

/**
 * Text cut at the last whole line within `limit`.
 * @param {string} s @param {number} limit
 */
export function fit(s, limit) {
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const nl = cut.lastIndexOf('\n');
  return nl > 0 ? cut.slice(0, nl) : cut;
}

/**
 * @typedef {object} AgentSource
 * @property {ModelAlias} alias
 * @property {string} id  The semantic model's ID.
 * @property {string} name  Its name in the workspace.
 * @property {any} bim  The deployed model, to list its tables.
 */

/** @param {string} text */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
/** @param {string} path @param {any} value */
const part = (path, value) => ({ path, payload: b64(JSON.stringify(value, null, 2)), payloadType: 'InlineBase64' });

/**
 * A folder name for a data source, from the model's name.
 * @param {string} name
 */
export const sourceFolder = (name) => `semantic_model-${name.replace(/[\\/:*?"<>|]/g, '_')}`;

/**
 * The data agent's definition, over the deployed models.
 * @param {Ask} ask
 * @param {string} workspaceId
 * @param {AgentSource[]} sources
 */
export function dataAgentDefinition(ask, workspaceId, sources) {
  const parts = [
    part('Files/Config/data_agent.json', { $schema: '2.1.0' }),
    part('Files/Config/draft/stage_config.json', {
      $schema: '1.0.0',
      aiInstructions: agentInstructions(ask.catalogue, sources.map((s) => s.name)),
    }),
  ];
  for (const s of sources) {
    const schema = visibleSchema(s.bim);
    parts.push(
      part(`Files/Config/draft/${sourceFolder(s.name)}/datasource.json`, {
        $schema: '1.0.0',
        artifactId: s.id,
        workspaceId,
        displayName: s.name,
        type: 'semantic_model',
        userDescription: fit(MODEL_DESCRIPTIONS[s.alias], DESCRIPTION_LIMIT),
        dataSourceInstructions: dataSourceInstructions(ask, s.alias, schema),
        elements: schemaElements(s.name, schema),
      }),
    );
  }
  return { parts };
}

/**
 * What a definition was built from, to tell when the agent needs updating.
 * @param {{ parts: { path: string, payload: string }[] }} definition
 */
export const dataAgentSignature = (definition) =>
  createHash('sha256')
    .update(definition.parts.map((p) => `${p.path}\u0000${p.payload}`).join('\u0001'))
    .digest('hex')
    .slice(0, 16);
