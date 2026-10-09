// @ts-check
/**
 * Agent configuration and Foundry resources from Azure Resource Graph. The installer adds these
 * tables to the ValueLens and Consumption models at deploy time, so the templates stay as they are.
 * When the source is off, or before the first load, the tables are there but empty, so queries
 * against them never fail.
 */
import { createHash } from 'node:crypto';

/** @typedef {'date' | 'text' | 'count' | 'flag'} ArgColumnKind */
/** @typedef {{ name: string, source: string, description: string, columns: { name: string, kind: ArgColumnKind }[] }} ArgTable */

/** @param {string} spec  Space-separated names; a suffix of `:date`, `:flag` or `:count` sets the kind. */
const cols = (spec) =>
  spec.split(/\s+/).filter(Boolean).map((s) => {
    const [name, kind = 'text'] = s.split(':');
    return { name, kind: /** @type {ArgColumnKind} */ (kind) };
  });

export const AGENT_CONFIG_TABLE = 'Agent Configuration';
export const ENVIRONMENTS_TABLE = 'Power Platform Environments';
export const AGENT_FLOWS_TABLE = 'Agent Flows';
export const FOUNDRY_TABLE = 'Foundry Resources';
export const ARG_STATUS_TABLE = 'Resource Graph Status';

/** Written by Copilot_Resource_Graph_Ingester, or by the Azure jobs. Each load replaces the last. */
export const ARG_TABLES = /** @type {ArgTable[]} */ ([
  {
    name: AGENT_CONFIG_TABLE,
    source: 'arg_agent_config',
    description: 'One row per Copilot Studio agent: authentication, connectors, sharing, model and channels.',
    columns: cols(`SnapshotDate:date AgentResourceId BotId AgentName EntraAgentId EntraAppId TitleId MatchedOn EnvironmentId
      Authentication NoSignIn:flag IsQuarantined:flag IsManaged:flag WebSearchEnabled:flag ConnectorCount:count McpConnectorCount:count
      KnowledgeConnectorCount:count ConnectedAgentCount:count Connectors SharedUsers:count SharedGroups:count SharedEntireTenant:flag
      Orchestration Model Channels OwnerId CreatedIn LastPublishedAt Source`),
  },
  {
    name: ENVIRONMENTS_TABLE,
    source: 'arg_environments',
    description: 'One row per Power Platform environment.',
    columns: cols('SnapshotDate:date EnvironmentId EnvironmentName EnvironmentType IsDefault:flag IsManaged:flag Region Source'),
  },
  {
    name: AGENT_FLOWS_TABLE,
    source: 'arg_agent_flows',
    description: 'One row per agent flow.',
    columns: cols('SnapshotDate:date FlowId FlowName EnvironmentId OwnerId ConnectorCount:count Trigger CreatedAt LastModifiedAt Source'),
  },
  {
    name: FOUNDRY_TABLE,
    source: 'arg_foundry_resources',
    description: 'One row per Azure AI Foundry resource or project, with its network and sign-in settings.',
    columns: cols(`SnapshotDate:date ResourceId ResourceName ResourceType Kind Location SubscriptionId ResourceGroup Sku
      PublicNetworkAccess PublicNetwork:flag DisableLocalAuth:flag IsProject:flag AccountId`),
  },
  {
    name: ARG_STATUS_TABLE,
    source: 'arg_status',
    description: 'What each Resource Graph probe returned on the last load, in plain words.',
    columns: cols('SnapshotDate:date Probe Status Rows:count Source Detail'),
  },
]);

/** Relationships from the agent configuration table. Ones to a table the template lacks are left out. */
export const ARG_RELATIONSHIPS = [
  { fromTable: AGENT_CONFIG_TABLE, fromColumn: 'TitleId', toTable: 'Agents 365', toColumn: 'Title ID' },
  { fromTable: AGENT_CONFIG_TABLE, fromColumn: 'EnvironmentId', toTable: ENVIRONMENTS_TABLE, toColumn: 'EnvironmentId' },
];

/**
 * A stable GUID for an object the installer adds, so redeploys don't churn lineage.
 * @param {string} key
 */
export function stableGuid(key) {
  const h = createHash('sha1').update(`valuelens:arg:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const M_TYPES = /** @type {Record<ArgColumnKind, string>} */ ({ date: 'type date', text: 'type text', count: 'Int64.Type', flag: 'type logical' });

/**
 * The partition's Power Query. `source` is the M that reads the Lakehouse table; without it the table is empty.
 * @param {ArgTable} t
 * @param {string[] | null} source
 */
function partitionExpression(t, source) {
  const names = `{${t.columns.map((c) => `"${c.name}"`).join(', ')}}`;
  const types = t.columns.map((c) => `{"${c.name}", ${M_TYPES[c.kind]}}`).join(', ');
  return [
    'let',
    `    Columns = ${names},`,
    ...(source ?? ['    Source = #table(Columns, {}),']),
    '    Kept = Table.SelectColumns(Source, Columns, MissingField.UseNull),',
    `    Typed = Table.TransformColumnTypes(Kept, {${types}})`,
    'in',
    '    Typed',
  ];
}

/**
 * For the ValueLens model, which reads tables with FabricTable.
 * @param {ArgTable} t
 * @param {boolean} on
 */
export const valueLensExpression = (t, on) =>
  partitionExpression(t, on ? [`    Source = try FabricTable("${t.source}") otherwise EmptyTable(Columns),`] : null);

/**
 * For the Consumption model, which reads tables with GetTable.
 * @param {ArgTable} t
 * @param {boolean} on
 */
export const consumptionExpression = (t, on) =>
  partitionExpression(t, on ? [`    Raw = GetTable("${t.source}"),`, '    Source = if Raw = null then #table(Columns, {}) else Raw,'] : null);

/**
 * @param {string} table
 * @param {{ name: string, kind: ArgColumnKind }} c
 */
function column(table, c) {
  const base = { name: c.name, sourceColumn: c.name, lineageTag: stableGuid(`column:${table}:${c.name}`) };
  /** @type {{ name: string, value: string }[]} */
  const annotations = [{ name: 'SummarizationSetBy', value: 'Automatic' }];
  if (c.kind === 'date') {
    annotations.push({ name: 'UnderlyingDateTimeDataType', value: 'Date' });
    return { ...base, dataType: 'dateTime', formatString: 'Long Date', summarizeBy: 'none', annotations };
  }
  if (c.kind === 'flag') return { ...base, dataType: 'boolean', formatString: '"TRUE";"TRUE";"FALSE"', summarizeBy: 'none', annotations };
  if (c.kind === 'count') return { ...base, dataType: 'int64', formatString: '#,0', summarizeBy: 'sum', annotations };
  return { ...base, dataType: 'string', summarizeBy: 'none', annotations };
}

/**
 * @param {import('./model.js').ModelBim['model']} model
 * @param {ArgTable} t
 * @param {string[]} expression
 */
function addTable(model, t, expression) {
  model.tables.push({
    name: t.name,
    description: `${t.description} From Azure Resource Graph.`,
    lineageTag: stableGuid(`table:${t.name}`),
    columns: t.columns.map((c) => column(t.name, c)),
    partitions: [{ name: t.name, mode: 'import', source: { type: 'm', expression } }],
    annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
  });
}

/**
 * Adds the Resource Graph tables and their relationships to the ValueLens model. Tables the
 * template already has are left alone.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {boolean} on
 */
export function addResourceGraph(model, on) {
  const added = new Set();
  for (const t of ARG_TABLES) {
    if (model.tables.some((x) => x.name === t.name)) continue;
    addTable(model, t, valueLensExpression(t, on));
    added.add(t.name);
  }
  const tables = new Set(model.tables.map((t) => t.name));
  model.relationships = model.relationships ?? [];
  for (const r of ARG_RELATIONSHIPS) {
    if (!added.has(r.fromTable) || !tables.has(r.toTable)) continue;
    model.relationships.push({
      name: stableGuid(`relationship:${r.fromTable}:${r.fromColumn}:${r.toTable}`),
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
    });
  }
}

/**
 * Adds the Foundry resources table to the Consumption model, with no relationships. A template
 * that already has it is left alone.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {boolean} on
 */
export function addFoundryResources(model, on) {
  const t = /** @type {ArgTable} */ (ARG_TABLES.find((x) => x.name === FOUNDRY_TABLE));
  if (model.tables.some((x) => x.name === t.name)) return;
  if (on && !model.expressions?.some((e) => e.name === 'GetTable')) throw new Error('The credit consumption model template has no "GetTable" function.');
  addTable(model, t, consumptionExpression(t, on));
}
