// @ts-check
/**
 * The Defender (shadow AI and agent risk) tables and measures. The installer adds them to the
 * ValueLens model at deploy time on Fabric and Azure, so the template stays as it is. When the
 * module is off, or before the first load, the tables are there but empty, so queries never fail.
 * Column lists mirror `shared/python/valuelens_core/defender.py` (COLUMNS); a test keeps them in step.
 */
import { createHash } from 'node:crypto';

/** @typedef {'string' | 'date' | 'long' | 'timestamp'} DefenderColumnType */
/** @typedef {{ name: string, source: string, description: string, columns: [string, DefenderColumnType][] }} DefenderTable */

export const DEFENDER_TABLES = /** @type {Record<string, DefenderTable>} */ ({
  watchlist: {
    name: 'Defender AI Watchlist',
    source: 'defender_ai_watchlist',
    description: 'The AI tools Defender looks for, with the posture an admin set for each. Edit Files/defender/ai_watchlist.csv to change it.',
    columns: [['Tool', 'string'], ['Category', 'string'], ['Vendor', 'string'], ['Posture', 'string'], ['ProcessNames', 'string'], ['Domains', 'string'], ['InstallPrefixes', 'string']],
  },
  daily: {
    name: 'Shadow AI Daily',
    source: 'defender_shadow_ai_daily',
    description: 'Devices and people that ran or reached each watched AI tool. Window 1d is one day; 7d and 30d are distinct counts over the window ending on Day.',
    columns: [['Day', 'date'], ['Window', 'string'], ['Layer', 'string'], ['Tool', 'string'], ['Devices', 'long'], ['Users', 'long'], ['Events', 'long'], ['LoadedAt', 'timestamp']],
  },
  totals: {
    name: 'Shadow AI Totals',
    source: 'defender_shadow_ai_totals_daily',
    description: 'Distinct devices and people that used any AI tool not marked Sanctioned. Layer Any combines Ran and Network.',
    columns: [['Day', 'date'], ['Window', 'string'], ['Layer', 'string'], ['Devices', 'long'], ['Users', 'long'], ['Events', 'long'], ['LoadedAt', 'timestamp']],
  },
  installed: {
    name: 'Defender AI Installed',
    source: 'defender_ai_installed',
    description: 'Devices with each watched AI tool installed, from Defender Vulnerability Management.',
    columns: [['SnapshotDate', 'date'], ['Tool', 'string'], ['Devices', 'long'], ['SoftwareNames', 'string'], ['LoadedAt', 'timestamp']],
  },
  cloud: {
    name: 'Defender Cloud Discovery',
    source: 'defender_cloud_discovery_ai',
    description: 'Generative AI apps seen in Defender for Cloud Apps Cloud Discovery over the last 30 days.',
    columns: [['SnapshotDate', 'date'], ['StreamId', 'string'], ['StreamName', 'string'], ['AppId', 'string'], ['AppName', 'string'], ['Category', 'string'], ['RiskScore', 'long'], ['Users', 'long'], ['Devices', 'long'], ['IpAddresses', 'long'], ['Transactions', 'long'], ['UploadBytes', 'long'], ['DownloadBytes', 'long'], ['LastSeen', 'timestamp'], ['Tags', 'string'], ['Posture', 'string'], ['WatchlistTool', 'string'], ['LoadedAt', 'timestamp']],
  },
  agents: {
    name: 'Defender AI Agents',
    source: 'defender_ai_agents',
    description: 'AI agents from Defender advanced hunting, with whether each needs people to sign in.',
    columns: [['SnapshotDate', 'date'], ['AgentId', 'string'], ['AgentName', 'string'], ['Platform', 'string'], ['SourceTable', 'string'], ['EntraAgentId', 'string'], ['BotId', 'string'], ['AppId', 'string'], ['AuthenticationType', 'string'], ['SignInRequired', 'string'], ['UsesWebKnowledge', 'string'], ['PublishedStatus', 'string'], ['LifecycleStatus', 'string'], ['Availability', 'string'], ['LoadedAt', 'timestamp']],
  },
  status: {
    name: 'Defender Status',
    source: 'defender_status',
    description: 'One row per Defender probe on the last run: ok, empty, forbidden, unlicensed or error.',
    columns: [['RunAt', 'timestamp'], ['Probe', 'string'], ['Status', 'string'], ['Source', 'string'], ['Rows', 'long'], ['Message', 'string']],
  },
});

const T = Object.fromEntries(Object.entries(DEFENDER_TABLES).map(([k, t]) => [k, `'${t.name}'`]));

/** Relationships from the Defender tables, so date filters reach the activity and posture reaches each tool. */
export const DEFENDER_RELATIONSHIPS = [
  { from: 'daily', fromColumn: 'Day', toTable: 'Calendar', toColumn: 'Date' },
  { from: 'totals', fromColumn: 'Day', toTable: 'Calendar', toColumn: 'Date' },
  { from: 'daily', fromColumn: 'Tool', toTable: DEFENDER_TABLES.watchlist.name, toColumn: 'Tool' },
  { from: 'installed', fromColumn: 'Tool', toTable: DEFENDER_TABLES.watchlist.name, toColumn: 'Tool' },
];

/** The table the measures live on. */
export const DEFENDER_MEASURE_TABLE = DEFENDER_TABLES.totals.name;

const lastWindow = (/** @type {string} */ table, /** @type {string} */ window) =>
  `CALCULATE(MAX(${table}[Day]), REMOVEFILTERS(${table}), ${table}[Window] = "${window}")`;

const toolsFound = (/** @type {string} */ window) => [
  `VAR LastDay = ${lastWindow(T.daily, window)}`,
  `VAR Sanctioned = CALCULATETABLE(VALUES(${T.watchlist}[Tool]), REMOVEFILTERS(${T.watchlist}), ${T.watchlist}[Posture] = "Sanctioned")`,
  `VAR Seen = CALCULATETABLE(DISTINCT(${T.daily}[Tool]), REMOVEFILTERS(${T.daily}), ${T.daily}[Window] = "${window}", ${T.daily}[Day] = LastDay, ${T.daily}[Devices] > 0)`,
  ...(window === '30d'
    ? [
        `VAR LastInstall = CALCULATE(MAX(${T.installed}[SnapshotDate]), REMOVEFILTERS(${T.installed}))`,
        `VAR Installed = CALCULATETABLE(DISTINCT(${T.installed}[Tool]), REMOVEFILTERS(${T.installed}), ${T.installed}[SnapshotDate] = LastInstall, ${T.installed}[Devices] > 0)`,
        `VAR Cloud = SELECTCOLUMNS(FILTER(ALL(${T.cloud}[WatchlistTool]), ${T.cloud}[WatchlistTool] <> ""), "Tool", ${T.cloud}[WatchlistTool])`,
        'VAR Found = EXCEPT(DISTINCT(UNION(Seen, Installed, Cloud)), Sanctioned)',
      ]
    : ['VAR Found = EXCEPT(Seen, Sanctioned)']),
  'RETURN COUNTROWS(Found) + 0',
];

const totalsMeasure = (/** @type {string} */ column) => [
  `VAR LastDay = ${lastWindow(T.totals, '30d')}`,
  `RETURN CALCULATE(SUM(${T.totals}[${column}]), REMOVEFILTERS(${T.totals}), ${T.totals}[Window] = "30d", ${T.totals}[Layer] = "Any", ${T.totals}[Day] = LastDay) + 0`,
];

/** @type {{ name: string, expression: string[], formatString?: string, description: string }[]} */
export const DEFENDER_MEASURES = [
  {
    name: 'AI Tools Watched',
    expression: [`COUNTROWS(FILTER(ALL(${T.watchlist}), ${T.watchlist}[Posture] <> "Sanctioned")) + 0`],
    formatString: '#,0',
    description: 'AI tools on the Defender watchlist that are not marked Sanctioned.',
  },
  {
    name: 'Unsanctioned AI Tools',
    expression: [`COUNTROWS(FILTER(ALL(${T.watchlist}), ${T.watchlist}[Posture] = "Unsanctioned")) + 0`],
    formatString: '#,0',
    description: 'AI tools an admin marked Unsanctioned on the watchlist. Not reviewed tools are not counted.',
  },
  {
    name: 'Shadow AI Tools Found',
    expression: toolsFound('30d'),
    formatString: '#,0',
    description: 'Watched AI tools not marked Sanctioned that Defender saw run, reached, installed or in Cloud Discovery in the last 30 days.',
  },
  {
    name: 'Shadow AI Tools This Week',
    expression: toolsFound('7d'),
    formatString: '#,0',
    description: 'Watched AI tools not marked Sanctioned that ran or were reached on a device in the last 7 days.',
  },
  {
    name: 'Shadow AI Devices',
    expression: totalsMeasure('Devices'),
    formatString: '#,0',
    description: 'Distinct devices that ran or reached an AI tool not marked Sanctioned in the last 30 days. A floor, not a census.',
  },
  {
    name: 'Shadow AI Users',
    expression: totalsMeasure('Users'),
    formatString: '#,0',
    description: 'Distinct people who ran or reached an AI tool not marked Sanctioned in the last 30 days. A floor, not a census.',
  },
  {
    name: 'Shadow AI Users (Cloud Discovery)',
    expression: [
      `VAR LastSnapshot = CALCULATE(MAX(${T.cloud}[SnapshotDate]), REMOVEFILTERS(${T.cloud}))`,
      `RETURN CALCULATE(MAX(${T.cloud}[Users]), REMOVEFILTERS(${T.cloud}), ${T.cloud}[SnapshotDate] = LastSnapshot, ${T.cloud}[Posture] <> "Sanctioned") + 0`,
    ],
    formatString: '#,0',
    description: 'People on the busiest generative AI app not marked Sanctioned in Cloud Discovery. Users are counted per app, so this is a floor.',
  },
  {
    name: 'Shadow AI Status',
    expression: [
      `VAR Probes = CALCULATE(COUNTROWS(${T.status}), REMOVEFILTERS(${T.status}))`,
      `VAR Working = CALCULATE(COUNTROWS(${T.status}), REMOVEFILTERS(${T.status}), ${T.status}[Status] IN { "ok", "empty" })`,
      'RETURN SWITCH(TRUE(),',
      '    Probes = 0, "Not connected",',
      '    Working = 0, "Connected, no access",',
      '    FORMAT([Shadow AI Tools Found], "0") & " of " & FORMAT([AI Tools Watched], "0") & " watched tools found")',
    ],
    description: 'Not connected, Connected with no access to any probe, or how many watched tools were found.',
  },
];

/**
 * A stable GUID for an object the installer adds, so redeploys don't churn lineage.
 * @param {string} key
 */
export function stableGuid(key) {
  const h = createHash('sha1').update(`valuelens:defender:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const M_TYPES = /** @type {Record<DefenderColumnType, string>} */ ({ string: 'type text', date: 'type date', long: 'Int64.Type', timestamp: 'type datetime' });

/**
 * The partition's Power Query. Off, or before the first load, it yields an empty typed table.
 * @param {DefenderTable} table
 * @param {boolean} on
 */
export function defenderPartitionExpression(table, on) {
  const names = `{${table.columns.map(([c]) => `"${c}"`).join(', ')}}`;
  const types = table.columns.map(([c, t]) => `{"${c}", ${M_TYPES[t]}}`).join(', ');
  return [
    'let',
    `    Columns = ${names},`,
    on ? `    Source = try FabricTable("${table.source}") otherwise EmptyTable(Columns),` : '    Source = EmptyTable(Columns),',
    '    Kept = Table.SelectColumns(Source, Columns, MissingField.UseNull),',
    `    Typed = Table.TransformColumnTypes(Kept, {${types}})`,
    'in',
    '    Typed',
  ];
}

/** @param {string} table @param {[string, DefenderColumnType]} c */
function column(table, [name, type]) {
  const base = { name, sourceColumn: name, lineageTag: stableGuid(`column:${table}:${name}`) };
  /** @type {{ name: string, value: string }[]} */
  const annotations = [{ name: 'SummarizationSetBy', value: 'Automatic' }];
  if (type === 'date' || type === 'timestamp') {
    annotations.push({ name: 'UnderlyingDateTimeDataType', value: type === 'date' ? 'Date' : 'DateTime' });
    return { ...base, dataType: 'dateTime', formatString: type === 'date' ? 'Long Date' : 'General Date', summarizeBy: 'none', annotations };
  }
  if (type === 'string') return { ...base, dataType: 'string', summarizeBy: 'none', annotations };
  return { ...base, dataType: 'int64', formatString: '#,0', summarizeBy: 'sum', annotations };
}

/**
 * Adds the Defender tables, their relationships and measures. Tables the template already has are left alone.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {boolean} on
 */
export function addDefender(model, on) {
  for (const [key, t] of Object.entries(DEFENDER_TABLES)) {
    if (model.tables.some((x) => x.name === t.name)) continue;
    model.tables.push({
      name: t.name,
      description: t.description,
      lineageTag: stableGuid(`table:${key}`),
      columns: t.columns.map((c) => column(key, c)),
      partitions: [{ name: t.name, mode: 'import', source: { type: 'm', expression: defenderPartitionExpression(t, on) } }],
      annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
    });
  }
  const tables = new Set(model.tables.map((t) => t.name));
  model.relationships = model.relationships ?? [];
  for (const r of DEFENDER_RELATIONSHIPS) {
    const fromTable = DEFENDER_TABLES[r.from].name;
    const name = stableGuid(`relationship:${r.from}:${r.fromColumn}:${r.toTable}`);
    if (!tables.has(r.toTable) || model.relationships.some((x) => x.name === name)) continue;
    model.relationships.push({ name, fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn });
  }
  const home = model.tables.find((t) => t.name === DEFENDER_MEASURE_TABLE);
  const existing = new Set(model.tables.flatMap((t) => (t.measures ?? []).map((/** @type {{ name: string }} */ m) => m.name)));
  home.measures = home.measures ?? [];
  for (const m of DEFENDER_MEASURES) {
    if (existing.has(m.name)) continue;
    home.measures.push({
      name: m.name,
      expression: m.expression,
      ...(m.formatString ? { formatString: m.formatString } : {}),
      description: m.description,
      lineageTag: stableGuid(`measure:${m.name}`),
    });
  }
}
