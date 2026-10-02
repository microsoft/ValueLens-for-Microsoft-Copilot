// @ts-check
/**
 * Turns the ValueLens Power BI template (.pbit) into a semantic model definition for
 * Fabric: the template's own model, with its source parameters filled in.
 */
import { readFileSync } from 'node:fs';
import { readZipEntry } from './zip.js';

export const MODEL_TEMPLATE = 'ValueLens - Fabric.pbit';
/** The credit consumption report from Consumption Central, relative to `3. Fabric`. */
export const CONSUMPTION_TEMPLATE = 'Add Credit Consumption/Consumption Central - Fabric.pbit';

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
 * @typedef {{ compatibilityLevel: number, model: { expressions?: { name: string, expression: string | string[] }[], tables: any[], annotations?: { name: string, value: string }[], [k: string]: any } }} ModelBim
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
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/**
 * The path Fabric uses to match the model's data source to a connection.
 * @param {string} server
 * @param {string} database
 */
export const datasourcePath = (server, database) => `${server};${database}`;
