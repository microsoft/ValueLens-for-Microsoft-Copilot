// @ts-check
/**
 * The Microsoft 365 activity table. The installer adds it to the ValueLens model at deploy
 * time, so the template stays as it is. When the module is off the table is still there,
 * just empty, so queries against it never fail.
 */
import { createHash } from 'node:crypto';

export const M365_TABLE = 'M365 Activity';
/** Written by Copilot_M365_Activity_Ingester. */
export const M365_SOURCE_TABLE = 'm365_activity_daily';

const COUNTS = [
  'TeamsChatMessages', 'TeamsPrivateChatMessages', 'TeamsCalls', 'TeamsMeetings', 'TeamsMeetingsOrganized',
  'TeamsMeetingsAttended', 'TeamsPostMessages', 'TeamsReplyMessages', 'TeamsAudioSeconds', 'TeamsVideoSeconds',
  'TeamsScreenShareSeconds', 'EmailSent', 'EmailReceived', 'EmailRead', 'EmailMeetingsCreated', 'EmailMeetingsInteracted',
  'SharePointFilesViewedOrEdited', 'SharePointFilesSynced', 'SharePointFilesSharedInternally', 'SharePointFilesSharedExternally',
  'SharePointPagesVisited', 'OneDriveFilesViewedOrEdited', 'OneDriveFilesSynced', 'OneDriveFilesSharedInternally',
  'OneDriveFilesSharedExternally', 'VivaEngagePosts', 'VivaEngageReads', 'VivaEngageLikes',
];
const FLAGS = [
  'AppOutlook', 'AppWord', 'AppExcel', 'AppPowerPoint', 'AppOneNote', 'AppTeams',
  'PlatformWindows', 'PlatformMac', 'PlatformMobile', 'PlatformWeb',
  'TeamsActive', 'EmailActive', 'SharePointActive', 'OneDriveActive', 'VivaEngageActive', 'AppsActive', 'WorkloadsActive',
];

/** @typedef {'date' | 'text' | 'count' | 'flag'} M365ColumnKind */

/** Columns the model keeps, in order. */
export const M365_COLUMNS = /** @type {{ name: string, kind: M365ColumnKind }[]} */ ([
  { name: 'ActivityDate', kind: 'date' },
  { name: 'WeekStart', kind: 'date' },
  { name: 'UPN_Normalized', kind: 'text' },
  ...COUNTS.map((name) => ({ name, kind: 'count' })),
  ...FLAGS.map((name) => ({ name, kind: 'flag' })),
]);

/** Relationships from the activity table, so date and organization filters reach it. */
export const M365_RELATIONSHIPS = [
  { fromColumn: 'ActivityDate', toTable: 'Calendar', toColumn: 'Date' },
  { fromColumn: 'UPN_Normalized', toTable: 'Chat + Agent Org Data', toColumn: 'PersonId' },
  { fromColumn: 'UPN_Normalized', toTable: 'Copilot Licensed', toColumn: 'UPN_Normalized' },
];

/**
 * A stable GUID for an object the installer adds, so redeploys don't churn lineage.
 * @param {string} key
 */
export function stableGuid(key) {
  const h = createHash('sha1').update(`valuelens:m365:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const M_TYPES = /** @type {Record<M365ColumnKind, string>} */ ({ date: 'type date', text: 'type text', count: 'Int64.Type', flag: 'Int64.Type' });

/**
 * The partition's Power Query. Off, or before the first load, it yields an empty typed table.
 * @param {boolean} on
 */
export function m365PartitionExpression(on) {
  const names = `{${M365_COLUMNS.map((c) => `"${c.name}"`).join(', ')}}`;
  const types = M365_COLUMNS.map((c) => `{"${c.name}", ${M_TYPES[c.kind]}}`).join(', ');
  return [
    'let',
    `    Columns = ${names},`,
    on
      ? `    Source = try FabricTable("${M365_SOURCE_TABLE}") otherwise EmptyTable(Columns),`
      : '    Source = EmptyTable(Columns),',
    '    Kept = Table.SelectColumns(Source, Columns, MissingField.UseNull),',
    `    Typed = Table.TransformColumnTypes(Kept, {${types}})`,
    'in',
    '    Typed',
  ];
}

/** @param {{ name: string, kind: M365ColumnKind }} c */
function column(c) {
  const base = { name: c.name, sourceColumn: c.name, lineageTag: stableGuid(`column:${c.name}`) };
  /** @type {{ name: string, value: string }[]} */
  const annotations = [{ name: 'SummarizationSetBy', value: 'Automatic' }];
  if (c.kind === 'date') {
    annotations.push({ name: 'UnderlyingDateTimeDataType', value: 'Date' });
    return { ...base, dataType: 'dateTime', formatString: 'Long Date', summarizeBy: 'none', annotations };
  }
  if (c.kind === 'text') return { ...base, dataType: 'string', summarizeBy: 'none', annotations };
  return { ...base, dataType: 'int64', formatString: c.kind === 'count' ? '#,0' : '0', summarizeBy: 'sum', annotations };
}

/**
 * Adds the table and its relationships. A template that already has the table is left alone.
 * @param {import('./model.js').ModelBim['model']} model
 * @param {boolean} on
 */
export function addM365Activity(model, on) {
  if (model.tables.some((t) => t.name === M365_TABLE)) return;
  model.tables.push({
    name: M365_TABLE,
    description: 'One row per person per day from the Microsoft 365 usage reports. Loaded by Copilot_M365_Activity_Ingester.',
    lineageTag: stableGuid('table'),
    columns: M365_COLUMNS.map(column),
    partitions: [{ name: M365_TABLE, mode: 'import', source: { type: 'm', expression: m365PartitionExpression(on) } }],
    annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
  });
  const tables = new Set(model.tables.map((t) => t.name));
  model.relationships = model.relationships ?? [];
  for (const r of M365_RELATIONSHIPS) {
    if (!tables.has(r.toTable)) continue;
    model.relationships.push({
      name: stableGuid(`relationship:${r.fromColumn}:${r.toTable}`),
      fromTable: M365_TABLE,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
    });
  }
}
