// @ts-check
/**
 * Fills in a Power BI template (.pbit) as it is, for routes that publish the template's own model
 * rather than building one: its Power Query parameters and, when a route needs it, whole shared
 * expressions. Nothing here names a product, so another installer can copy it.
 */
import { decodeText, encodeTextLike, mString } from './model.js';
import { listZip, readZipEntry, replaceZipEntries } from './zip.js';

/** @typedef {string | number | boolean} ParameterValue */

/**
 * @typedef {object} ModelEntry
 * @property {string} template  The .pbit's path.
 * @property {Record<string, ParameterValue>} parameters  Power Query parameter values, by name. Each must be in the template, and is written as the type it declares: see mLiteral.
 * @property {Record<string, string>} [expressions]  Shared expressions to replace whole, by name, as M text. Each must be in the template.
 */

/** @typedef {Pick<ModelEntry, 'parameters' | 'expressions'>} EntryValues */

const SCHEMA = 'DataModelSchema';
/** Power BI Desktop's copy of each query's M, which some templates keep beside the model. */
const UNAPPLIED = 'UnappliedChanges';

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A parameter's value as an M literal of the type the parameter declares:
 * - Number: a finite number, or text that is one, written bare.
 * - Date: `yyyy-mm-dd`, written as `#date(y, m, d)`.
 * - Logical: true or false.
 * - Text, Any, or no type: quoted text. Null is blank.
 * A value that doesn't fit throws, and so does any other type, so a wrong value fails in a desk
 * test rather than in the service's refresh.
 * @param {string} name  The parameter's name, for the error.
 * @param {string | undefined} type  The Type in the parameter's meta record.
 * @param {ParameterValue | null | undefined} value
 */
export function mLiteral(name, type, value) {
  const wrong = (/** @type {string} */ want) => new Error(`"${name}" is a ${type} parameter, so its value must be ${want}, not ${typeof value === 'string' ? JSON.stringify(value) : String(value)}.`);
  const text = typeof value === 'string' ? value.trim() : undefined;
  switch (type ?? 'Any') {
    case 'Text':
    case 'Any':
      return mString(String(value ?? ''));
    case 'Number': {
      const n = typeof value === 'number' ? value : text !== undefined && NUMBER.test(text) ? Number(text) : NaN;
      if (!Number.isFinite(n)) throw wrong('a number');
      return String(n);
    }
    case 'Date': {
      const m = text === undefined ? null : DATE.exec(text);
      const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
      const day = new Date(Date.UTC(y, mo - 1, d));
      if (!m || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw wrong('a date written yyyy-mm-dd');
      return `#date(${y}, ${mo}, ${d})`;
    }
    case 'Logical': {
      const b = typeof value === 'boolean' ? value : text === 'true' ? true : text === 'false' ? false : undefined;
      if (b === undefined) throw wrong('true or false');
      return String(b);
    }
    default:
      throw new Error(`"${name}" is a ${type} parameter, which the installer can't set.`);
  }
}

/**
 * The Type a parameter's meta record declares, if it declares one. Text in the record, such as a
 * list of suggested values, is skipped.
 * @param {string} meta  The record, from ` meta [`.
 */
function metaType(meta) {
  for (const m of meta.matchAll(/"(?:[^"]|"")*"|\bType\s*=\s*"((?:[^"]|"")*)"/g)) if (m[1] !== undefined) return m[1].replace(/""/g, '"');
  return undefined;
}

/**
 * Sets a Power Query parameter's value as the type it declares, and keeps its `meta [...]` record.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {string} name
 * @param {ParameterValue | null | undefined} value
 */
export function setEntryParameter(model, name, value) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) throw new Error(`The model has no "${name}" parameter.`);
  const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
  const at = text.indexOf(' meta [');
  if (at < 0) throw new Error(`"${name}" is not a parameter.`);
  const meta = text.slice(at);
  expr.expression = `${mLiteral(name, metaType(meta), value)}${meta}`;
}

/**
 * Sets the entry's parameters and expressions on a model, in place. A parameter keeps its
 * `meta [...]` record and is written as the type it declares; an expression keeps its form, one
 * string or a list of lines.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {EntryValues} entry
 */
export function applyEntry(model, entry) {
  for (const [name, value] of Object.entries(entry.parameters)) setEntryParameter(model, name, value);
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
 * Brings a template's UnappliedChanges in line with its model for the queries the entry sets.
 * Otherwise Power BI Desktop can open the template with changes pending, and applying them would
 * put back the template's own values. Each query keeps its form, one string or a list of lines,
 * and none is added.
 * @param {any} doc  UnappliedChanges, parsed. Changed in place.
 * @param {import('./model.js').ModelBim['model']} model  The model, with the entry applied.
 * @param {EntryValues} entry
 * @returns {boolean}  Whether anything changed.
 */
export function syncUnapplied(doc, model, entry) {
  if (!Array.isArray(doc?.queries)) return false;
  const names = new Set([...Object.keys(entry.parameters), ...Object.keys(entry.expressions ?? {})]);
  let changed = false;
  for (const q of doc.queries) {
    if (typeof q?.name !== 'string' || !names.has(q.name)) continue;
    const expr = model.expressions?.find((e) => e.name === q.name);
    if (!expr) continue;
    const lines = Array.isArray(expr.expression) ? expr.expression : String(expr.expression).split(/\r?\n/);
    const text = Array.isArray(q.text) ? lines : lines.join(/\r\n/.test(String(q.text ?? '')) ? '\r\n' : '\n');
    if (JSON.stringify(text) === JSON.stringify(q.text)) continue;
    q.text = text;
    changed = true;
  }
  return changed;
}

/**
 * A copy of the template with the entry's values in it, to open in Power BI Desktop. Every other
 * file in it is byte for byte the same, and DataModelSchema keeps its text encoding. So does
 * UnappliedChanges, which changes only when the template has one that holds the entry's queries.
 * @param {Buffer} pbit
 * @param {EntryValues} entry
 * @returns {Buffer}
 */
export function fillTemplate(pbit, entry) {
  const raw = readZipEntry(pbit, SCHEMA);
  const schema = JSON.parse(decodeText(raw));
  if (!schema?.model?.tables) throw new Error('The template has no data model.');
  applyEntry(schema.model, entry);
  const replace = new Map([[SCHEMA, encodeTextLike(JSON.stringify(schema, null, 2), raw)]]);
  if (listZip(pbit).has(UNAPPLIED)) {
    const before = readZipEntry(pbit, UNAPPLIED);
    const text = decodeText(before);
    /** @type {any} */
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = undefined;
    }
    if (doc && syncUnapplied(doc, schema.model, entry)) replace.set(UNAPPLIED, encodeTextLike(JSON.stringify(doc, null, /\n/.test(text) ? 2 : undefined), before));
  }
  return replaceZipEntries(pbit, replace);
}
