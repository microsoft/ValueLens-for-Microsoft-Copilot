// @ts-check
/**
 * Org-scoped access: opt-in row-level security, added to each model at deploy time when
 * `access.rls.enabled` is set. Without it the models are exactly what they were, with no roles
 * and no access tables.
 *
 * Two roles:
 * - **Everyone** has no filters. Its members are the people with an active `all` scope (and the
 *   Viewers group when the default `*` row is `all`). Power BI combines a person's roles as a
 *   union, so they see exactly what they would without RLS, including activity from people with
 *   no org or licence record.
 * - **Scoped viewers** has the Viewers group as its member and filters each person-level table to
 *   the viewer's scopes, read from the `Access Scope` table: everyone, below a person (by the
 *   manager chain in `Access People`), or an org value.
 *
 * Role members are environment specific, so the definition carries none; the installer applies
 * them over XMLA after every deploy (see `roleDefinitions`).
 */
import { createHash } from 'node:crypto';

export const ACCESS_SCOPE_TABLE = 'Access Scope';
export const ACCESS_PEOPLE_TABLE = 'Access People';
export const SCOPED_ROLE = 'Scoped viewers';
export const EVERYONE_ROLE = 'Everyone';
/** Hidden calculated columns added to the tables the scoped role filters. */
export const PATH_COLUMN = 'Access Path';
export const ORG_VALUE_COLUMN = 'Access Org Value';

/** The org attributes a scope can name, as the installer offers them. */
export const ORG_ATTRIBUTES = /** @type {const} */ (['department', 'country']);
/** @typedef {typeof ORG_ATTRIBUTES[number]} OrgAttribute */
/** @typedef {'valuelens' | 'consumption' | 'agentEvaluator'} AccessModelKind */

/**
 * @typedef {object} AccessInventory
 * @property {{ table: string, key: string, attributes: Record<OrgAttribute, string> }} org  The model's org table: filtered by scope.
 * @property {string[]} viaOrg  Person-level tables the org table's filter reaches through relationships.
 * @property {{ table: string, key: string }[]} direct  Person-level tables the org table doesn't reach, filtered by their own UPN column.
 * @property {string[]} allOnly  Tenant-wide tables, seen only with an `all` scope.
 * @property {string[]} open  Tables with no person data that other tables look up. Filtering one would hide the rows that point at it.
 */

/**
 * Every import table in each model, all modules on. Calculated tables are open: they're static,
 * dates, or built from tables the org table filters. A table that isn't listed is treated as
 * tenant-wide, so a new template table is hidden from scoped viewers until it's classified here.
 * @type {Record<AccessModelKind, AccessInventory>}
 */
export const ACCESS_INVENTORY = {
  valuelens: {
    org: { table: 'Chat + Agent Org Data', key: 'PersonId', attributes: { department: 'Organization', country: 'country' } },
    viaOrg: ['Chat + Agent Interactions (Audit Logs)', 'M365 Activity'],
    direct: [{ table: 'Copilot Licensed', key: 'UPN_Normalized' }],
    allOnly: [
      'ProductFeedback',
      'Defender AI Watchlist',
      'Shadow AI Daily',
      'Shadow AI Totals',
      'Defender AI Installed',
      'Defender Cloud Discovery',
      'Defender AI Agents',
      'Defender Status',
      'Agent Configuration',
      'Power Platform Environments',
      'Agent Flows',
      'Foundry Resources',
      'Resource Graph Status',
      'Load Log',
    ],
    open: ['Agents 365', 'Behavior Value Map', 'Human Time Estimates', 'Effort Scenario'],
  },
  consumption: {
    org: { table: 'Org', key: 'UserPrincipalName', attributes: { department: 'Department', country: 'Country' } },
    viaOrg: ['CoworkBilling', 'CreditsWeekly', 'Credit Consumption (User)', 'GitHub User', 'GitHub Usage'],
    direct: [{ table: 'Org Attribute Source', key: 'UserPrincipalName' }],
    allOnly: [
      'SecurityFilter',
      'Credit Consumption (Tenant)',
      'Credit Consumption (Agent)',
      'AzureAiSpend',
      'AzureAiTokens',
      'AzureSolutionSpend',
      'AzureDeploymentHealth',
      'AzureBillingReconciliation',
      'CopilotPaygSpend',
      'Foundry Resources',
    ],
    open: ['Assumptions', 'Settings', 'SpendingPolicy'],
  },
  agentEvaluator: {
    org: { table: 'Chat + Agent Org Data', key: 'PersonId_Normalized', attributes: { department: 'Organization', country: 'country' } },
    viaOrg: [
      'Agent Sessions',
      'Agent Turns',
      'Agent Errors',
      'Agent Sub-Agent Calls',
      'Agent Performance',
      'Agent Variables',
      'Credit Consumption (User)',
    ],
    direct: [],
    allOnly: ['Credit Consumption (Agent)', 'Credit Consumption (Tenant)', 'Conversation Transcripts (Raw)', 'Dataverse Diagnostic', 'Evaluator Status'],
    open: ['Agent Catalogue', 'Agent Name Map'],
  },
};

/** The M function each model reads its Lakehouse or SQL tables with. */
const ACCESSOR = /** @type {Record<AccessModelKind, string>} */ ({ valuelens: 'FabricTable', consumption: 'GetTable', agentEvaluator: 'FabricTable' });

/** Written by the Access Scope notebook (Fabric) or the jobs' publish step (Azure). */
export const SOURCE_TABLES = /** @type {const} */ ({ scope: 'access_scope', people: 'access_people' });

const SCOPE_COLUMNS = /** @type {const} */ ([
  ['UserPrincipalName', 'string'],
  ['ScopeType', 'string'],
  ['ScopeValue', 'string'],
  ['CanDelegate', 'boolean'],
  ['Status', 'string'],
]);
const PEOPLE_COLUMNS = /** @type {const} */ ([
  ['PersonId', 'string'],
  ['OrgPath', 'string'],
]);

/**
 * A stable GUID for an object the installer adds, so redeploys don't churn lineage.
 * @param {string} key
 */
function stableGuid(key) {
  const h = createHash('sha1').update(`valuelens:access:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** DAX table reference. @param {string} name */
const t = (name) => `'${name.replace(/'/g, "''")}'`;
/** DAX column reference. @param {string} table @param {string} column */
const c = (table, column) => `${t(table)}[${column.replace(/]/g, ']]')}]`;

/**
 * The partition's Power Query: the source table, or an empty one until it exists, so a model
 * with RLS on still refreshes and a missing table means nobody sees anything.
 * @param {string} accessor
 * @param {string} source
 * @param {readonly (readonly [string, string])[]} columns
 */
export function accessPartitionExpression(accessor, source, columns) {
  const types = { string: 'type text', boolean: 'type logical' };
  return [
    'let',
    `    Columns = {${columns.map(([n]) => `"${n}"`).join(', ')}},`,
    `    Raw = try ${accessor}("${source}") otherwise null,`,
    '    Source = if Raw = null then #table(Columns, {}) else Raw,',
    '    Kept = Table.SelectColumns(Source, Columns, MissingField.UseNull),',
    `    Typed = Table.TransformColumnTypes(Kept, {${columns.map(([n, k]) => `{"${n}", ${types[/** @type {'string' | 'boolean'} */ (k)]}}`).join(', ')}})`,
    'in',
    '    Typed',
  ];
}

/**
 * @param {string} name
 * @param {string} description
 * @param {string} accessor
 * @param {string} source
 * @param {readonly (readonly [string, string])[]} columns
 */
function accessTable(name, description, accessor, source, columns) {
  return {
    name,
    description,
    isHidden: true,
    lineageTag: stableGuid(`table:${name}`),
    columns: columns.map(([n, k]) => ({
      name: n,
      dataType: k,
      sourceColumn: n,
      isHidden: true,
      summarizeBy: 'none',
      lineageTag: stableGuid(`column:${name}:${n}`),
    })),
    partitions: [{ name, mode: 'import', source: { type: 'm', expression: accessPartitionExpression(accessor, source, columns) } }],
    annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
  };
}

/**
 * @param {string} table
 * @param {string} name
 * @param {string} expression
 * @param {string} description
 */
const calculatedColumn = (table, name, expression, description) => ({
  type: 'calculated',
  name,
  dataType: 'string',
  isDataTypeInferred: true,
  isHidden: true,
  expression,
  description,
  summarizeBy: 'none',
  lineageTag: stableGuid(`column:${table}:${name}`),
});

/** Path of the person in `table`'s `key` column. @param {string} table @param {string} key */
const pathLookup = (table, key) =>
  `LOOKUPVALUE(${c(ACCESS_PEOPLE_TABLE, 'OrgPath')}, ${c(ACCESS_PEOPLE_TABLE, 'PersonId')}, LOWER(${c(table, key)}), BLANK())`;

/** The viewer's active scope rows: their own, or the `*` default when they have none. */
const RULES = [
  'VAR __me = LOWER(USERPRINCIPALNAME())',
  `VAR __own = FILTER(${t(ACCESS_SCOPE_TABLE)}, ${c(ACCESS_SCOPE_TABLE, 'UserPrincipalName')} = __me && ${c(ACCESS_SCOPE_TABLE, 'Status')} = "active")`,
  'VAR __who = IF(ISEMPTY(__own), "*", __me)',
  `VAR __rules = FILTER(${t(ACCESS_SCOPE_TABLE)}, ${c(ACCESS_SCOPE_TABLE, 'UserPrincipalName')} = __who && ${c(ACCESS_SCOPE_TABLE, 'Status')} = "active")`,
  `VAR __isAll = NOT ISEMPTY(FILTER(__rules, ${c(ACCESS_SCOPE_TABLE, 'ScopeType')} = "all"))`,
];

/** Only an `all` scope sees the table. */
export const allOnlyFilter = () => [...RULES, 'RETURN __isAll'].join('\n');

/**
 * Rows whose person is inside one of the viewer's scopes.
 * @param {string} path  DAX for the row's manager chain.
 * @param {string} orgValue  DAX for the row's org value.
 */
export function scopedFilter(path, orgValue) {
  return [
    ...RULES,
    `VAR __orgs = SELECTCOLUMNS(FILTER(__rules, ${c(ACCESS_SCOPE_TABLE, 'ScopeType')} = "org"), "Value", ${c(ACCESS_SCOPE_TABLE, 'ScopeValue')})`,
    `VAR __roots = SELECTCOLUMNS(FILTER(__rules, ${c(ACCESS_SCOPE_TABLE, 'ScopeType')} = "hierarchy"), "Root", ${c(ACCESS_SCOPE_TABLE, 'ScopeValue')})`,
    `VAR __path = ${path}`,
    `VAR __org = ${orgValue}`,
    'RETURN',
    '    __isAll',
    '        || (NOT ISBLANK(__org) && __org IN __orgs)',
    '        || (NOT ISBLANK(__path) && NOT ISEMPTY(FILTER(__roots, PATHCONTAINS(__path, [Root]))))',
  ].join('\n');
}

/** People see only their own scope rows and the default. */
export const ownScopeFilter = () =>
  `VAR __me = LOWER(USERPRINCIPALNAME())\nRETURN ${c(ACCESS_SCOPE_TABLE, 'UserPrincipalName')} = __me || ${c(ACCESS_SCOPE_TABLE, 'UserPrincipalName')} = "*"`;

/**
 * Adds the access tables, the lookup columns and both roles (without members).
 * @param {import('./model.js').ModelBim['model']} model
 * @param {AccessModelKind} kind
 * @param {{ orgAttribute?: string }} [opts]
 */
export function addAccessScope(model, kind, opts = {}) {
  const inv = ACCESS_INVENTORY[kind];
  const accessor = ACCESSOR[kind];
  if (!model.expressions?.some((e) => e.name === accessor)) throw new Error(`The model template has no "${accessor}" function.`);
  const orgTable = model.tables.find((x) => x.name === inv.org.table);
  if (!orgTable) throw new Error(`The model template has no "${inv.org.table}" table.`);
  const attribute = /** @type {OrgAttribute} */ (ORG_ATTRIBUTES.includes(/** @type {any} */ (opts.orgAttribute)) ? opts.orgAttribute : 'department');
  const orgColumn = inv.org.attributes[attribute];
  if (!orgTable.columns.some((/** @type {any} */ x) => x.name === orgColumn)) throw new Error(`"${inv.org.table}" has no "${orgColumn}" column.`);

  model.tables.push(
    accessTable(
      ACCESS_SCOPE_TABLE,
      'Who sees what under org-scoped access: one row per person and scope. Managed by the installer and the Share panel.',
      accessor,
      SOURCE_TABLES.scope,
      SCOPE_COLUMNS,
    ),
    accessTable(ACCESS_PEOPLE_TABLE, 'Each person\'s manager chain as lower-case UPNs joined by "|", top first.', accessor, SOURCE_TABLES.people, PEOPLE_COLUMNS),
  );

  /** @type {{ name: string, filterExpression: string }[]} */
  const filters = [];
  orgTable.columns.push(calculatedColumn(inv.org.table, PATH_COLUMN, pathLookup(inv.org.table, inv.org.key), 'The person\'s manager chain, for org-scoped access.'));
  filters.push({ name: inv.org.table, filterExpression: scopedFilter(c(inv.org.table, PATH_COLUMN), c(inv.org.table, orgColumn)) });

  for (const d of inv.direct) {
    const table = model.tables.find((x) => x.name === d.table);
    if (!table) continue;
    table.columns.push(
      calculatedColumn(d.table, PATH_COLUMN, pathLookup(d.table, d.key), 'The person\'s manager chain, for org-scoped access.'),
      calculatedColumn(
        d.table,
        ORG_VALUE_COLUMN,
        `LOOKUPVALUE(${c(inv.org.table, orgColumn)}, ${c(inv.org.table, inv.org.key)}, ${c(d.table, d.key)}, BLANK())`,
        'The person\'s org value, for org-scoped access.',
      ),
    );
    filters.push({ name: d.table, filterExpression: scopedFilter(c(d.table, PATH_COLUMN), c(d.table, ORG_VALUE_COLUMN)) });
  }

  const classified = new Set([inv.org.table, ...inv.viaOrg, ...inv.direct.map((d) => d.table), ...inv.open, ACCESS_SCOPE_TABLE, ACCESS_PEOPLE_TABLE]);
  for (const table of model.tables) {
    if (classified.has(table.name) || table.partitions?.[0]?.source?.type === 'calculated') continue;
    filters.push({ name: table.name, filterExpression: allOnlyFilter() });
  }
  filters.push({ name: ACCESS_SCOPE_TABLE, filterExpression: ownScopeFilter() }, { name: ACCESS_PEOPLE_TABLE, filterExpression: allOnlyFilter() });

  model.roles = [
    ...(model.roles ?? []).filter((r) => r.name !== SCOPED_ROLE && r.name !== EVERYONE_ROLE),
    {
      name: EVERYONE_ROLE,
      description: 'Org-scoped access: people who see everything. Members are applied by the installer.',
      modelPermission: 'read',
      tablePermissions: [{ name: ACCESS_SCOPE_TABLE, filterExpression: ownScopeFilter() }],
    },
    {
      name: SCOPED_ROLE,
      description: 'Org-scoped access: Analytics Hub Viewers, filtered to their scopes. Members are applied by the installer.',
      modelPermission: 'read',
      tablePermissions: filters,
    },
  ];
}

/**
 * Org-scoped access is on.
 * @param {{ access?: import('../config.js').AccessConfig }} config
 */
export const rlsOn = (config) => !!config.access?.rls?.enabled;

/**
 * The builders' `access` setting: present only when org-scoped access is on.
 * @param {{ access?: import('../config.js').AccessConfig }} config
 * @returns {import('./model.js').AccessSettings | undefined}
 */
export const rlsSettings = (config) => (config.access?.rls?.enabled ? { orgAttribute: config.access.rls.orgAttribute ?? 'department' } : undefined);

/**
 * The Azure AD member for a group, in the form XMLA takes.
 * @param {string} groupId
 * @param {string} tenantId
 */
export const groupMember = (groupId, tenantId) => ({ memberName: `obj:${groupId}@${tenantId}`, identityProvider: 'AzureAD', memberType: 'group' });
/** @param {string} upn */
export const userMember = (upn) => ({ memberName: upn, identityProvider: 'AzureAD', memberType: 'user' });

/**
 * The roles with their members, for the installer to apply over XMLA after a deploy.
 * @param {import('./model.js').ModelBim['model']} model  A model built with access on.
 * @param {{ groupId: string, tenantId: string, everyone: string[], defaultAll?: boolean }} members
 *   `everyone`: UPNs with an active `all` scope. `defaultAll`: the `*` row is `all`.
 */
export function roleDefinitions(model, members) {
  const roles = model.roles ?? [];
  const everyone = roles.find((r) => r.name === EVERYONE_ROLE);
  const scoped = roles.find((r) => r.name === SCOPED_ROLE);
  if (!everyone || !scoped) throw new Error('The model was built without org-scoped access.');
  const group = groupMember(members.groupId, members.tenantId);
  const users = [...new Set(members.everyone.map((u) => u.trim().toLowerCase()).filter((u) => u && u !== '*'))].sort();
  return [
    { ...everyone, members: [...(members.defaultAll ? [group] : []), ...users.map(userMember)] },
    { ...scoped, members: [group] },
  ];
}
