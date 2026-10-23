// @ts-check
/**
 * Fills in a Power BI template (.pbit) as it is, for routes that publish the template's own model
 * rather than building one: its Power Query parameters and, when a route needs it, whole shared
 * expressions. Nothing here names a product, so another installer can copy it.
 */
import { decodeText, encodeTextLike, setMParameter } from './model.js';
import { readZipEntry, replaceZipEntries } from './zip.js';

/**
 * @typedef {object} ModelEntry
 * @property {string} template  The .pbit's path.
 * @property {Record<string, string>} parameters  Power Query parameter values, by name. Each must be in the template.
 * @property {Record<string, string>} [expressions]  Shared expressions to replace whole, by name, as M text. Each must be in the template.
 */

/** @typedef {Pick<ModelEntry, 'parameters' | 'expressions'>} EntryValues */

const SCHEMA = 'DataModelSchema';

/**
 * Sets the entry's parameters and expressions on a model, in place. A parameter keeps its
 * `meta [...]` record; an expression keeps its form, one string or a list of lines.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {EntryValues} entry
 */
export function applyEntry(model, entry) {
  for (const [name, value] of Object.entries(entry.parameters)) setMParameter(model, name, value);
  for (const [name, text] of Object.entries(entry.expressions ?? {})) {
    const expr = model.expressions?.find((e) => e.name === name);
    if (!expr) throw new Error(`The model has no "${name}" expression.`);
    expr.expression = Array.isArray(expr.expression) ? text.split(/\r?\n/) : text;
  }
}

/**
 * The model the entry describes, for the semantic model definition API. The template is never modified.
 * @param {import('./model.js').ModelBim} template
 * @param {EntryValues} entry
 * @returns {import('./model.js').ModelBim}
 */
export function buildEntryModel(template, entry) {
  const model = structuredClone(template.model);
  applyEntry(model, entry);
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/**
 * A copy of the template with the entry's values in it, to open in Power BI Desktop. Every other
 * file in it is byte for byte the same, and DataModelSchema keeps its text encoding.
 * @param {Buffer} pbit
 * @param {EntryValues} entry
 * @returns {Buffer}
 */
export function fillTemplate(pbit, entry) {
  const raw = readZipEntry(pbit, SCHEMA);
  const schema = JSON.parse(decodeText(raw));
  if (!schema?.model?.tables) throw new Error('The template has no data model.');
  applyEntry(schema.model, entry);
  return replaceZipEntries(pbit, new Map([[SCHEMA, encodeTextLike(JSON.stringify(schema, null, 2), raw)]]));
}
