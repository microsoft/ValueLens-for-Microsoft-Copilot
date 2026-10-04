// @ts-check
/**
 * Turns the ValueLens Power BI template (.pbit) into a semantic model definition for
 * Fabric: the template's own model, with its source parameters filled in.
 */
import { readFileSync } from 'node:fs';
import { addM365Activity } from './m365.js';
import { addCopilotPaygSpend } from './payg.js';
import { readZipEntry } from './zip.js';

export const MODEL_TEMPLATE = 'ValueLens - Fabric.pbit';
/** The credit consumption report from Consumption Central, relative to `1. Fabric`. */
export const CONSUMPTION_TEMPLATE = 'Add Credit Consumption/Consumption Central - Fabric.pbit';
/** The Agent Evaluator report, vendored from microsoft/AgentEvaluator-for-Copilot-Studio. */
export const AGENT_EVALUATOR_TEMPLATE = 'Add Agent Evaluator/Agent Evaluator.pbit';

/** The table that has an incremental refresh policy. */
export const AUDIT_TABLE = 'Chat + Agent Interactions (Audit Logs)';

/**
 * `definition.pbism` for a model defined by model.bim.
 * See https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition
 */
export const PBISM = {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
  version: '4.0',
  settings: {},
};

/**
 * @typedef {{ compatibilityLevel: number, model: { expressions?: { name: string, expression: string | string[], description?: string | string[] }[], tables: any[], annotations?: { name: string, value: string }[], [k: string]: any } }} ModelBim
 */

/**
 * A .pbit's DataModelSchema is usually UTF-16 with a byte-order mark.
 * @param {Buffer} raw
 */
export function decodeText(raw) {
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString('utf8');
  if (raw.length > 1 && raw[0] !== 0 && raw[1] === 0) return raw.toString('utf16le');
  return raw.toString('utf8');
}

/**
 * Reads the model from a Power BI template.
 * @param {Buffer} pbit
 * @returns {ModelBim}
 */
export function readTemplateModel(pbit) {
  const schema = JSON.parse(decodeText(readZipEntry(pbit, 'DataModelSchema')));
  if (!schema?.model?.tables) throw new Error('The template has no data model.');
  return { compatibilityLevel: schema.compatibilityLevel, model: schema.model };
}

/** @param {string} file */
export const loadTemplateModel = (file) => readTemplateModel(readFileSync(file));

/**
 * Power Query text literal.
 * @param {string} value
 */
export const mString = (value) => `"${String(value).replace(/"/g, '""')}"`;

/**
 * Sets a Power Query parameter's value and keeps its `meta [...]` record.
 * @param {ModelBim['model']} model
 * @param {string} name
 * @param {string} value
 */
export function setMParameter(model, name, value) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) throw new Error(`The model has no "${name}" parameter.`);
  const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
  const at = text.indexOf(' meta [');
  if (at < 0) throw new Error(`"${name}" is not a parameter.`);
  expr.expression = `${mString(value)}${text.slice(at)}`;
}

/**
 * @param {ModelBim['model']} model
 * @param {string} name
 */
export function mParameter(model, name) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) return undefined;
  const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
  const m = /^"((?:[^"]|"")*)" meta \[/.exec(text);
  return m ? m[1].replace(/""/g, '"') : undefined;
}

/**
 * @typedef {object} ModelSettings
 * @property {string} server  The Lakehouse's SQL analytics endpoint.
 * @property {string} database  The Lakehouse name.
 * @property {import('../catalog.js').ModuleChoice} modules
 */

/** Optional pages, switched by a model parameter. */
const SWITCHES = /** @type {const} */ ([
  ['Enable_ProductFeedback', 'productFeedback'],
  ['Enable_Agent365', 'agent365'],
]);

/**
 * The model to deploy. The template is never modified.
 * @param {ModelBim} template
 * @param {ModelSettings} settings
 * @returns {ModelBim}
 */
export function buildModel(template, settings) {
  const model = structuredClone(template.model);
  setMParameter(model, 'Fabric SQL Endpoint', settings.server);
  setMParameter(model, 'Lakehouse Name', settings.database);
  for (const [parameter, module] of SWITCHES) {
    if (model.expressions?.some((e) => e.name === parameter)) setMParameter(model, parameter, settings.modules[module] ? 'Include' : 'Exclude');
  }
  addM365Activity(model, !!settings.modules.m365Activity);
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/**
 * The credit consumption model. Every table in it is optional, so it deploys and
 * refreshes before any consumption data has landed.
 * @param {ModelBim} template
 * @param {{ server: string, database: string }} settings
 * @returns {ModelBim}
 */
export function buildConsumptionModel(template, settings) {
  const model = structuredClone(template.model);
  setMParameter(model, 'FabricSQLEndpoint', settings.server);
  setMParameter(model, 'LakehouseName', settings.database);
  addCopilotPaygSpend(model);
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/** Agent Evaluator functions that read Dataverse, SharePoint or local CSVs. Fabric mode never calls them. */
export const AGENT_EVALUATOR_OFFLINE_FUNCTIONS = /** @type {const} */ (['CsvBinary', 'CsvFromPath', 'DataverseEntity']);
/** The Agent Evaluator table that probes Dataverse directly. */
export const AGENT_EVALUATOR_DIAGNOSTIC_TABLE = 'Dataverse Diagnostic';

/**
 * The Agent Evaluator model, reading the parser's tables from the Lakehouse. The report also
 * reads Dataverse or CSV files directly; those paths are switched off and stubbed so the service
 * only ever sees the Lakehouse as a data source.
 * @param {ModelBim} template
 * @param {{ server: string, database: string }} settings
 * @returns {ModelBim}
 */
export function buildAgentEvaluatorModel(template, settings) {
  const model = structuredClone(template.model);
  setMParameter(model, 'Fabric SQL Endpoint', settings.server);
  setMParameter(model, 'Lakehouse Name', settings.database);
  setMParameter(model, 'Source Mode', 'Fabric');
  for (const name of AGENT_EVALUATOR_OFFLINE_FUNCTIONS) {
    const expr = model.expressions?.find((e) => e.name === name);
    if (!expr) throw new Error(`The transcripts model template has no "${name}" function.`);
    const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
    const at = text.indexOf('=>');
    if (at < 0) throw new Error(`"${name}" is not a function.`);
    expr.expression = `${text.slice(0, at)}=> error "Not used: the ValueLens installer reads Agent Evaluator data from the Lakehouse."`;
    expr.description = 'Not used: the ValueLens installer reads Agent Evaluator data from the Lakehouse.';
  }
  // The service can't bind a Sql.Database whose arguments are worked out inside an if/error, so
  // read the parameters directly, as the ValueLens model does.
  const fabricTable = model.expressions?.find((e) => e.name === 'FabricTable');
  const fabricText = fabricTable && (Array.isArray(fabricTable.expression) ? fabricTable.expression.join('\n') : String(fabricTable.expression));
  const direct = fabricText?.replace(/^([ \t]*)FabEndpoint = [^\n]*\n[ \t]*FabLakehouse = [^\n]*\n[ \t]*Db = [^\n]*Sql\.Database\(FabEndpoint, FabLakehouse\),/m, '$1Db = Sql.Database(#"Fabric SQL Endpoint", #"Lakehouse Name"),');
  if (!fabricTable || !direct || direct === fabricText) throw new Error('The transcripts model template\'s "FabricTable" function has changed shape.');
  fabricTable.expression = direct;
  completeAgentEvaluatorFallbacks(model);
  const diagnostic = model.tables.find((t) => t.name === AGENT_EVALUATOR_DIAGNOSTIC_TABLE);
  for (const p of diagnostic?.partitions ?? []) {
    const text = Array.isArray(p.source.expression) ? p.source.expression.join('\n') : String(p.source.expression);
    const empty = /Empty = (#table\(\{[^}]*\}, \{\}\))/.exec(text);
    if (!empty) throw new Error(`The "${AGENT_EVALUATOR_DIAGNOSTIC_TABLE}" table has changed shape.`);
    p.source.expression = empty[1];
  }
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/** M steps that keep the Lakehouse table's columns as they are, apart from adding some. */
const PASS_THROUGH_STEPS = new Set(['AddColumn', 'ColumnNames', 'HasColumns', 'TransformColumnTypes', 'TransformColumns']);

/**
 * Until the parser first runs, a table falls back to an empty one. Some of those lack columns the
 * model declares, which fails the refresh, so add them. Tables that select, rename or build their
 * columns are left alone: their declared columns don't come straight from the Lakehouse.
 * @param {ModelBim['model']} model
 */
function completeAgentEvaluatorFallbacks(model) {
  for (const table of model.tables) {
    for (const p of table.partitions ?? []) {
      if (p.source?.type !== 'm') continue;
      const text = Array.isArray(p.source.expression) ? p.source.expression.join('\n') : String(p.source.expression);
      const fallback = /(FabricTable\("[^"]+"\)\s*otherwise\s*EmptyTable\(\{)([^}]*)(\}\))/g;
      const hits = [...text.matchAll(fallback)];
      if (hits.length !== 1) continue;
      const steps = [...text.matchAll(/Table\.(\w+)\(/g)].map((m) => m[1]);
      if (steps.some((s) => !PASS_THROUGH_STEPS.has(s))) continue;
      const listed = new Set([...hits[0][2].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
      const added = new Set([...text.matchAll(/Table\.AddColumn\([^,]+,\s*"([^"]+)"/g)].map((m) => m[1]));
      const missing = table.columns
        .filter((c) => c.type !== 'calculated' && c.type !== 'rowNumber')
        .map((c) => c.sourceColumn ?? c.name)
        .filter((c) => !listed.has(c) && !added.has(c));
      if (!missing.length) continue;
      const extra = missing.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
      p.source.expression = text.replace(fallback, (_, open, cols, close) => `${open}${cols.trim() ? `${cols}, ` : ''}${extra}${close}`);
    }
  }
}

/**
 * The path Fabric uses to match the model's data source to a connection.
 * @param {string} server
 * @param {string} database
 */
export const datasourcePath = (server, database) => `${server};${database}`;
