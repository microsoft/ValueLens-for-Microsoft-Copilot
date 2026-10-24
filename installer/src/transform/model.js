// @ts-check
/**
 * Turns the ValueLens Power BI template (.pbit) into a semantic model definition for
 * Fabric: the template's own model, with its source parameters filled in.
 */
import { readFileSync } from 'node:fs';
import { SETUP_DIR } from '../catalog.js';
import { currencySymbol } from '../currency.js';
import { addAccessScope } from './access.js';
import { addDefender } from './defender.js';
import { addLoadLog } from './load-log.js';
import { addM365Activity } from './m365.js';
import { addResourceGraph } from './resource-graph.js';
import { readZipEntry } from './zip.js';

/** The ValueLens report, relative to the source folder. */
export const MODEL_TEMPLATE = `${SETUP_DIR}/ValueLens - Fabric.pbit`;

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
 * Encodes text the way `raw` was, the reverse of decodeText: UTF-16 or UTF-8, with a byte-order
 * mark only when `raw` had one.
 * @param {string} text
 * @param {Buffer} raw
 */
export function encodeTextLike(text, raw) {
  if (raw[0] === 0xff && raw[1] === 0xfe) return Buffer.concat([raw.subarray(0, 2), Buffer.from(text, 'utf16le')]);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return Buffer.concat([raw.subarray(0, 3), Buffer.from(text, 'utf8')]);
  if (raw.length > 1 && raw[0] !== 0 && raw[1] === 0) return Buffer.from(text, 'utf16le');
  return Buffer.from(text, 'utf8');
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
 * @property {boolean} [resourceGraph]  Agent configuration and Foundry come from Azure Resource Graph.
 * @property {string} [currency]  The reporting currency's ISO code. The template's symbol stays when absent.
 * @property {AccessSettings} [access]  Org-scoped access. The model has no roles when absent.
 */

/** @typedef {{ orgAttribute?: string }} AccessSettings */

/** The measure the report and the app read the reporting currency's symbol from. */
export const CURRENCY_SYMBOL_MEASURE = 'Currency Symbol Value';

/**
 * Points the currency symbol measure at the reporting currency.
 * @param {ModelBim['model']} model
 * @param {string} code
 */
export function setCurrencySymbol(model, code) {
  for (const table of model.tables ?? []) {
    const measure = table.measures?.find((m) => m.name === CURRENCY_SYMBOL_MEASURE);
    if (measure) measure.expression = `"${currencySymbol(code).replace(/"/g, '""')}"`;
  }
}

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
  addDefender(model, !!settings.modules.defender);
  addResourceGraph(model, !!settings.resourceGraph);
  addLoadLog(model);
  if (settings.currency) setCurrencySymbol(model, settings.currency);
  if (settings.access) addAccessScope(model, 'valuelens', settings.access);
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/**
 * The path Fabric uses to match the model's data source to a connection.
 * @param {string} server
 * @param {string} database
 */
export const datasourcePath = (server, database) => `${server};${database}`;
