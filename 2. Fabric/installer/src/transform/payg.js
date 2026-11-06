// @ts-check
/**
 * Copilot pay-as-you-go as billed in Azure. The installer adds this table to the Consumption
 * model at deploy time, so the template stays as it is. Before the first load, or when Azure AI
 * is left out, the table is there but empty, so queries against it never fail.
 */
import { createHash } from 'node:crypto';

export const PAYG_TABLE = 'CopilotPaygSpend';
/** Written by the Azure AI notebook. */
export const PAYG_SOURCE_TABLE = 'copilot_payg_spend';

/** @typedef {'date' | 'text' | 'hidden' | 'cost' | 'quantity'} PaygColumnKind */

/** Columns the model keeps, in order. */
export const PAYG_COLUMNS = /** @type {{ name: string, kind: PaygColumnKind, description?: string }[]} */ ([
  { name: 'UsageDate', kind: 'date' },
  { name: 'SubscriptionId', kind: 'text', description: 'The Azure subscription a Power Platform billing policy charges.' },
  { name: 'Meter', kind: 'text' },
  { name: 'ServiceTag', kind: 'text', description: 'The serviceName tag Azure puts on the charge: cowork for Cowork, empty for Copilot Studio.' },
  { name: 'Product', kind: 'text', description: 'Copilot Studio or Cowork, from ServiceTag. Any other tag value is kept as it is.' },
  { name: 'Cost', kind: 'cost', description: 'Billed cost in Currency. No currency conversion is done.' },
  {
    name: 'UsageQuantity',
    kind: 'quantity',
    description: 'Credits on the Pay As You Go Copilot Credit meter. Other meters have their own units, so this is not summed by default.',
  },
  { name: 'Currency', kind: 'hidden' },
]);

/** So the model's Date table filters it. */
const RELATIONSHIP = { fromColumn: 'UsageDate', toTable: 'Date', toColumn: 'Date' };

/**
 * A stable GUID for an object the installer adds, so redeploys don't churn lineage.
 * @param {string} key
 */
function stableGuid(key) {
  const h = createHash('sha1').update(`valuelens:payg:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const M_TYPES = /** @type {Record<PaygColumnKind, string>} */ ({ date: 'type date', text: 'type text', hidden: 'type text', cost: 'type number', quantity: 'type number' });

/** The partition's Power Query. Before the first load it yields an empty typed table. */
export function paygPartitionExpression() {
  const names = `{${PAYG_COLUMNS.map((c) => `"${c.name}"`).join(', ')}}`;
  const types = PAYG_COLUMNS.map((c) => `{"${c.name}", ${M_TYPES[c.kind]}}`).join(', ');
  return [
    'let',
    `    Columns = ${names},`,
    `    Raw = GetTable("${PAYG_SOURCE_TABLE}"),`,
    '    Source = if Raw = null then #table(Columns, {}) else Raw,',
    '    Kept = Table.SelectColumns(Source, Columns, MissingField.UseNull),',
    `    Typed = Table.TransformColumnTypes(Kept, {${types}})`,
    'in',
    '    Typed',
  ];
}

/** @param {{ name: string, kind: PaygColumnKind, description?: string }} c */
function column(c) {
  const base = {
    name: c.name,
    sourceColumn: c.name,
    lineageTag: stableGuid(`column:${c.name}`),
    ...(c.description ? { description: c.description } : {}),
  };
  if (c.kind === 'date') {
    return { ...base, dataType: 'dateTime', formatString: 'yyyy-mm-dd', summarizeBy: 'none', annotations: [{ name: 'UnderlyingDateTimeDataType', value: 'Date' }] };
  }
  if (c.kind === 'cost') return { ...base, dataType: 'double', formatString: '#,0.00', summarizeBy: 'sum' };
  if (c.kind === 'quantity') return { ...base, dataType: 'double', formatString: '#,0', summarizeBy: 'none' };
  return { ...base, dataType: 'string', summarizeBy: 'none', ...(c.kind === 'hidden' ? { isHidden: true } : {}) };
}

/**
 * Adds the table and its Date relationship. A template that already has the table is left alone.
 * @param {import('./model.js').ModelBim['model']} model
 */
export function addCopilotPaygSpend(model) {
  if (model.tables.some((t) => t.name === PAYG_TABLE)) return;
  if (!model.expressions?.some((e) => e.name === 'GetTable')) throw new Error('The credit consumption model template has no "GetTable" function.');
  model.tables.push({
    name: PAYG_TABLE,
    description:
      'Copilot Studio and Cowork pay-as-you-go as billed in Azure: one row per day, subscription, meter and product. ' +
      'Loaded by the Azure AI notebook from the subscriptions Power Platform billing policies charge.',
    lineageTag: stableGuid('table'),
    columns: PAYG_COLUMNS.map(column),
    partitions: [{ name: PAYG_TABLE, mode: 'import', source: { type: 'm', expression: paygPartitionExpression() } }],
    annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
  });
  if (!model.tables.some((t) => t.name === RELATIONSHIP.toTable)) return;
  model.relationships = model.relationships ?? [];
  model.relationships.push({
    name: stableGuid(`relationship:${RELATIONSHIP.fromColumn}:${RELATIONSHIP.toTable}`),
    fromTable: PAYG_TABLE,
    fromColumn: RELATIONSHIP.fromColumn,
    toTable: RELATIONSHIP.toTable,
    toColumn: RELATIONSHIP.toColumn,
  });
}
