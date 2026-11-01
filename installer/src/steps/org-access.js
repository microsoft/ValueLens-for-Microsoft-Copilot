// @ts-check
/**
 * Org-scoped access: opt-in row-level security on the semantic model. Who sees what lives in a
 * scope list (a CSV the installer writes in the Lakehouse), never in the model, so it survives
 * redeploys. The model gets two roles when it's on; their members are applied over XMLA by the
 * Access Scope notebook after every deploy, because a definition deploy drops role members.
 */
import { notebookJobParameters } from '../clients/fabric.js';
import { commandLine } from '../launch.js';
import { ACCESS_INVENTORY, ACCESS_PEOPLE_TABLE, ORG_ATTRIBUTES, rlsOn, roleDefinitions } from '../transform/access.js';
import { ensureViewerGroup } from './access.js';
import { deployedRoles, refreshModel } from './model.js';
import { BUSY_RETRIES, BUSY_WAIT_MS, capacityBusy, waitForJob } from './run.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../transform/access.js').AccessModelKind} AccessModelKind */

/**
 * One row of the scope list, as the notebook and the jobs read it.
 * @typedef {object} ScopeRow
 * @property {string} UserPrincipalName  Lower case; `*` is anyone without rows of their own.
 * @property {'all' | 'hierarchy' | 'org'} ScopeType
 * @property {string} ScopeValue  The root person's UPN for `hierarchy`, the org value for `org`, empty for `all`.
 * @property {boolean} CanDelegate
 * @property {string} GrantedBy
 * @property {'seed' | 'installer'} GrantedVia
 * @property {'active' | 'pending_group'} Status
 * @property {string} Note
 * @property {string} CreatedAt
 */

/**
 * A model with org-scoped access, and where it lives.
 * @typedef {{ kind: AccessModelKind, workspaceId: string, datasetId: string, name: string, model?: import('../config.js').ModelConfig }} RlsModel
 */

export const SCOPE_COLUMNS = /** @type {const} */ (['UserPrincipalName', 'ScopeType', 'ScopeValue', 'CanDelegate', 'GrantedBy', 'GrantedVia', 'Status', 'Note', 'CreatedAt']);
const SCOPE_TYPES = ['all', 'hierarchy', 'org'];
const MANAGED_VIA = ['seed', 'installer'];
const STATUSES = ['active', 'pending_group'];

/** Where the files go, in the Lakehouse. */
export const FABRIC_SCOPE_FILE = 'Files/analytics_hub_access/access_scope.csv';
export const FABRIC_ROLES_FILE = 'Files/analytics_hub_access/roles.json';

/** Below this share of people with a manager, "below a person" scopes miss most people. */
export const LOW_MANAGER_COVERAGE = 0.5;

const ATTRIBUTE_LABELS = { department: 'department', country: 'country' };

/**
 * Splits CSV text into records: quoted fields may hold commas, quotes and line breaks.
 * @param {string} text
 * @returns {string[][]}
 */
function csvRecords(text) {
  /** @type {string[][]} */
  const out = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/**
 * Reads the scope list, with the same rules as the notebook's and the jobs' `parse_scope_csv`.
 * @param {string | null | undefined} text
 * @returns {ScopeRow[]}
 */
export function parseScopeCsv(text) {
  const records = csvRecords((text ?? '').replace(/^\uFEFF/, ''));
  if (!records.length) return [];
  const header = records[0].map((h) => h.trim());
  const missing = ['UserPrincipalName', 'ScopeType'].filter((col) => !header.includes(col));
  if (missing.length) throw new Error(`access_scope.csv is missing column(s): ${missing.join(', ')}`);
  /** @type {ScopeRow[]} */
  const out = [];
  const seen = new Set();
  records.slice(1).forEach((record, i) => {
    const line = i + 2;
    /** @type {Record<string, string>} */
    const row = Object.fromEntries(header.map((h, j) => [h, (record[j] ?? '').trim()]));
    const upn = (row.UserPrincipalName ?? '').toLowerCase();
    const kind = (row.ScopeType ?? '').toLowerCase();
    if (!upn && !kind) return;
    if (!upn || (upn !== '*' && !upn.includes('@'))) throw new Error(`access_scope.csv line ${line}: UserPrincipalName must be a UPN or *.`);
    if (!SCOPE_TYPES.includes(kind)) throw new Error(`access_scope.csv line ${line}: ScopeType must be one of ${SCOPE_TYPES.join(', ')}.`);
    let value = row.ScopeValue ?? '';
    if (kind === 'all') value = '';
    else if (kind === 'hierarchy') {
      value = value.toLowerCase();
      if (!value.includes('@')) throw new Error(`access_scope.csv line ${line}: a hierarchy scope needs the root person's UPN.`);
    } else if (!value) throw new Error(`access_scope.csv line ${line}: an org scope needs a value.`);
    const via = (row.GrantedVia ?? '').toLowerCase() || 'installer';
    if (!MANAGED_VIA.includes(via)) throw new Error(`access_scope.csv line ${line}: GrantedVia must be seed or installer.`);
    const status = (row.Status ?? '').toLowerCase() || 'active';
    if (!STATUSES.includes(status)) throw new Error(`access_scope.csv line ${line}: Status must be active or pending_group.`);
    const key = scopeKey({ UserPrincipalName: upn, ScopeType: /** @type {ScopeRow['ScopeType']} */ (kind), ScopeValue: value });
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      UserPrincipalName: upn,
      ScopeType: /** @type {ScopeRow['ScopeType']} */ (kind),
      ScopeValue: value,
      CanDelegate: ['true', '1', 'yes'].includes((row.CanDelegate ?? '').toLowerCase()),
      GrantedBy: (row.GrantedBy ?? '').toLowerCase(),
      GrantedVia: /** @type {ScopeRow['GrantedVia']} */ (via),
      Status: /** @type {ScopeRow['Status']} */ (status),
      Note: row.Note ?? '',
      CreatedAt: row.CreatedAt ?? '',
    });
  });
  return out;
}

/** @param {string} v */
const csvField = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The scope list as CSV.
 * @param {ScopeRow[]} rows
 */
export function scopeCsv(rows) {
  const lines = [SCOPE_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(SCOPE_COLUMNS.map((col) => csvField(col === 'CanDelegate' ? (r.CanDelegate ? 'true' : 'false') : String(r[col] ?? ''))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** @param {Pick<ScopeRow, 'UserPrincipalName' | 'ScopeType' | 'ScopeValue'>} r */
export const scopeKey = (r) => `${r.UserPrincipalName}|${r.ScopeType}|${r.ScopeValue}`;

/**
 * An `all` row for each person, for turning org-scoped access on without anyone losing what they see.
 * @param {string[]} upns
 * @param {{ grantedBy: string, now: Date }} o
 * @returns {ScopeRow[]}
 */
export function seedRows(upns, o) {
  const unique = [...new Set(upns.map((u) => u.trim().toLowerCase()).filter((u) => u.includes('@')))].sort();
  return unique.map((upn) => newRow({ upn, type: 'all', value: '' }, { grantedBy: o.grantedBy, now: o.now, via: 'seed' }));
}

/**
 * @param {{ upn: string, type: ScopeRow['ScopeType'], value: string, canDelegate?: boolean, note?: string }} s
 * @param {{ grantedBy: string, now: Date, via?: ScopeRow['GrantedVia'] }} o
 * @returns {ScopeRow}
 */
export function newRow(s, o) {
  return {
    UserPrincipalName: s.upn.trim().toLowerCase(),
    ScopeType: s.type,
    ScopeValue: s.type === 'all' ? '' : s.type === 'hierarchy' ? s.value.trim().toLowerCase() : s.value.trim(),
    CanDelegate: !!s.canDelegate,
    GrantedBy: o.grantedBy.toLowerCase(),
    GrantedVia: o.via ?? 'installer',
    Status: 'active',
    Note: s.note ?? '',
    CreatedAt: o.now.toISOString().slice(0, 19),
  };
}

/**
 * Adds a row, replacing one with the same person, type and value.
 * @param {ScopeRow[]} rows
 * @param {ScopeRow} row
 */
export function addScope(rows, row) {
  const key = scopeKey(row);
  return [...rows.filter((r) => scopeKey(r) !== key), row];
}

/**
 * @param {ScopeRow[]} rows
 * @param {string} key  From `scopeKey`.
 */
export const removeScope = (rows, key) => rows.filter((r) => scopeKey(r) !== key);

/**
 * People with an active `all` scope: the Everyone role's members.
 * @param {ScopeRow[]} rows
 */
export const everyoneUpns = (rows) => [...new Set(rows.filter((r) => r.ScopeType === 'all' && r.Status === 'active' && r.UserPrincipalName !== '*').map((r) => r.UserPrincipalName))].sort();

/**
 * Whether anyone without rows of their own sees everything.
 * @param {ScopeRow[]} rows
 */
export const defaultAll = (rows) => rows.some((r) => r.UserPrincipalName === '*' && r.ScopeType === 'all' && r.Status === 'active');

/**
 * One row in words.
 * @param {ScopeRow} r
 * @param {import('../transform/access.js').OrgAttribute} [attribute]
 */
export function describeScope(r, attribute = 'department') {
  const who = r.UserPrincipalName === '*' ? 'Anyone without a scope' : r.UserPrincipalName;
  const what =
    r.ScopeType === 'all' ? 'everyone' : r.ScopeType === 'hierarchy' ? `${r.ScopeValue} and everyone below them` : `${ATTRIBUTE_LABELS[attribute]} "${r.ScopeValue}"`;
  const extras = [r.CanDelegate ? 'can share' : '', r.Status === 'pending_group' ? 'waiting for an admin' : ''].filter(Boolean);
  return `${who}: ${what}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

/**
 * The models org-scoped access covers on this install: the ValueLens model, once it's deployed.
 * @param {import('../config.js').InstallConfig} config
 * @returns {RlsModel[]}
 */
export function rlsModels(config) {
  const ws = config.fabric.workspaceId;
  const m = config.semanticModel;
  if (!ws || !m.enabled || !m.id) return [];
  return [{ kind: 'valuelens', workspaceId: ws, datasetId: m.id, name: m.name, model: m }];
}

/**
 * Reads and writes the scope list and the roles file.
 * @param {Ctx} ctx
 */
function store(ctx) {
  const { config, api } = ctx;
  const encode = (/** @type {string} */ s) => new TextEncoder().encode(s);
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const lh = config.fabric.lakehouseId;
  if (!ws || !lh) throw new Error(`Nothing is installed yet. Run "${commandLine('install')}" first.`);
  return {
    where: `${config.fabric.lakehouseName ?? 'the Lakehouse'}/${FABRIC_SCOPE_FILE}`,
    readScope: () => api.oneLake.readText(ws, lh, FABRIC_SCOPE_FILE),
    readRoles: () => api.oneLake.readText(ws, lh, FABRIC_ROLES_FILE),
    writeScope: (/** @type {string} */ text) => api.oneLake.writeFile(ws, lh, FABRIC_SCOPE_FILE, encode(text)),
    writeRoles: (/** @type {string} */ text) => api.oneLake.writeFile(ws, lh, FABRIC_ROLES_FILE, encode(text)),
    rolesPath: FABRIC_ROLES_FILE,
  };
}

/**
 * The scope list; empty when there isn't one yet.
 * @param {Ctx} ctx
 */
export async function readScopes(ctx) {
  return parseScopeCsv(await store(ctx).readScope());
}

/**
 * Writes the scope list.
 * @param {Ctx} ctx
 * @param {ScopeRow[]} rows
 */
export async function writeScopes(ctx, rows) {
  await store(ctx).writeScope(scopeCsv(rows));
}

/**
 * Why org-scoped access can't be turned on here. Empty when it can.
 * @param {Ctx} ctx
 */
export function rlsBlockers(ctx) {
  /** @type {string[]} */
  const out = [];
  if (!rlsModels(ctx.config).length) out.push(`No semantic model is deployed yet. Run "${commandLine('install')}" with the semantic model first.`);
  return out;
}

/**
 * Lists the people and groups with a workspace role other than Viewer. They see every row whatever
 * their scope, because row-level security only applies to viewers.
 * @param {Ctx} ctx
 */
async function showBypass(ctx) {
  const { ui, api } = ctx;
  const ws = rlsModels(ctx.config)[0]?.workspaceId;
  if (!ws) return;
  const assignments = await api.fabric.listRoleAssignments(ws).catch(() => null);
  if (!assignments) {
    ui.note('Couldn\'t list the workspace roles. Anyone with Admin, Member or Contributor on the workspace sees every row.');
    return;
  }
  const bypass = assignments.filter((/** @type {any} */ a) => a.role && a.role !== 'Viewer');
  if (!bypass.length) return;
  ui.info('These have a workspace role, so they see every row whatever their scope:');
  for (const a of bypass) ui.info(`  ${a.principal?.displayName ?? a.principal?.id} (${String(a.principal?.type ?? '').toLowerCase() || 'principal'}, ${a.role})`);
}

/**
 * The roles each model should have, members included, for the notebook.
 * @param {Ctx} ctx
 * @param {ScopeRow[]} rows
 * @returns {Promise<{ items: { dataset: string, datasetId: string, role: any }[], missing: RlsModel[] }>}
 */
export async function roleItems(ctx, rows) {
  const { config, user } = ctx;
  const groupId = config.access?.groupId;
  if (!groupId) throw new Error('There is no viewer group. Run "access" to choose one.');
  /** @type {{ dataset: string, datasetId: string, role: any }[]} */
  let stored = [];
  /** @type {{ dataset: string, datasetId: string, role: any }[]} */
  const items = [];
  /** @type {RlsModel[]} */
  const missing = [];
  let read = false;
  for (const m of rlsModels(config)) {
    let roles = deployedRoles(ctx).get(m.datasetId);
    if (!roles) {
      // Not deployed in this run: the roles applied last time, without their members.
      if (!read) {
        read = true;
        const text = await store(ctx).readRoles().catch(() => null);
        try {
          stored = text ? JSON.parse(text) : [];
        } catch {
          stored = [];
        }
      }
      roles = stored.filter((i) => i.datasetId === m.datasetId).map(({ role }) => {
        const { members, ...rest } = role;
        return rest;
      });
    }
    if (!roles?.length) {
      missing.push(m);
      continue;
    }
    const defs = roleDefinitions(/** @type {any} */ ({ roles }), { groupId, tenantId: user.tenantId, everyone: everyoneUpns(rows), defaultAll: defaultAll(rows) });
    for (const role of defs) items.push({ dataset: m.name, datasetId: m.datasetId, role });
  }
  return { items, missing };
}

/**
 * Runs the Access Scope notebook, trying again while the capacity is busy.
 * @param {Ctx} ctx
 * @param {string} workspaceId
 * @param {string} notebookId
 * @param {Record<string, string>} params
 */
async function runAccessNotebook(ctx, workspaceId, notebookId, params) {
  const { ui, api } = ctx;
  /** @type {any} */
  let job;
  for (let attempt = 0; ; attempt++) {
    const url = await api.fabric.runJob(workspaceId, notebookId, 'RunNotebook', { parameters: notebookJobParameters(params) });
    job = await waitForJob(ctx, url, 'Org-scoped access', { pollMs: 15_000, timeoutMs: 20 * 60_000 });
    if (job?.status !== 'Failed' || !capacityBusy(job.failureReason) || attempt >= BUSY_RETRIES) break;
    ui.warn(`Org-scoped access: the capacity is busy. Trying again in ${BUSY_WAIT_MS / 60_000} minutes.`);
    await ctx.sleep(BUSY_WAIT_MS);
  }
  if (job?.status === 'Completed') return true;
  ui.fail(`The roles weren't applied: ${job?.failureReason?.message ?? `the notebook ended as ${job?.status ?? 'unknown'}`}`);
  ui.info('Check that the tenant setting "Allow XMLA endpoints" is on and the workspace capacity\'s XMLA endpoint is Read Write. Then try again from "access".');
  return false;
}

/**
 * Lands the scope list, applies the model's role members and, when asked, refreshes the model.
 * The install carries on whatever happens, and the model stays closed to scoped viewers until it's
 * applied.
 * @param {Ctx} ctx
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<boolean | null>} true when applied; false when it failed, saying how to try again; null when it only
 *   warned: no model can take its roles yet.
 */
export async function applyOrgAccess(ctx, opts = {}) {
  const { ui, config } = ctx;
  const rls = /** @type {import('../config.js').RlsConfig} */ (config.access?.rls);
  const blockers = rlsBlockers(ctx);
  if (blockers.length) {
    for (const b of blockers) ui.fail(b);
    ui.info(`Fix ${blockers.length === 1 ? 'that' : 'those'}, or turn org-scoped access off from "${commandLine('access')}".`);
    return false;
  }
  const rows = await readScopes(ctx);
  const { items, missing } = await roleItems(ctx, rows);
  for (const m of missing) ui.warn(`${m.name} wasn't deployed with org-scoped access by this installer. Run "${commandLine('update')}" to redeploy it.`);
  if (!items.length) return null;

  const s = store(ctx);
  await s.writeScope(scopeCsv(rows));
  await s.writeRoles(JSON.stringify(items, null, 2));

  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const id = config.fabric.notebooks.accessScope;
  if (!id) {
    ui.fail(`The Access Scope notebook isn't deployed. Run "${commandLine('update')}".`);
    return false;
  }
  const ok = await runAccessNotebook(ctx, ws, id, { MODE: 'all', ROLES_B64: '', ROLES_FILE: s.rolesPath, WORKSPACE_ID: ws });
  if (ok && opts.refresh !== false) {
    for (const m of rlsModels(config)) if (m.model) await refreshModel(ctx, { model: m.model, wait: false });
  }
  if (!ok) return false;
  rls.applied = [...new Set(items.map((i) => i.datasetId))];
  ctx.save();
  ui.ok(`Org-scoped access applied to ${[...new Set(items.map((i) => i.dataset))].join(', ')}`);
  return true;
}

/**
 * Whether org-scoped access is on and a deployed model still needs its role members applied, so
 * ensureOrgAccess applies them (and refreshes, when asked).
 * @param {import('../config.js').InstallConfig} config
 */
export function orgAccessPending(config) {
  if (!rlsOn(config)) return false;
  const applied = new Set(config.access?.rls?.applied ?? []);
  const models = rlsModels(config);
  return !(models.length && models.every((m) => applied.has(m.datasetId)));
}

/**
 * After a deploy: applies role members to any model that was redeployed since they were last
 * applied. Nothing to do when org-scoped access is off.
 * @param {Ctx} ctx
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<boolean | null>} As applyOrgAccess: false when it failed; null when it only warned.
 */
export async function ensureOrgAccess(ctx, opts = {}) {
  const { ui, config } = ctx;
  if (!rlsOn(config)) return true;
  if (!orgAccessPending(config)) {
    ui.ok('Org-scoped access is in place');
    return true;
  }
  try {
    return await applyOrgAccess(ctx, opts);
  } catch (err) {
    ui.fail(`Org-scoped access wasn't applied: ${/** @type {Error} */ (err).message}`);
    ui.info(`Until it is, people outside the workspace see nothing. Try again from "${commandLine('access')}".`);
    return false;
  }
}

/** @param {any} res */
const firstRow = (res) => res?.results?.[0]?.tables?.[0]?.rows?.[0];

/**
 * Checks org-scoped access with test queries: how many people have a manager chain, and whether a
 * person with an `all` scope sees everyone. Reports what it finds; never fails the install.
 * @param {Ctx} ctx
 */
export async function verifyOrgAccess(ctx) {
  const { ui, config, api, user } = ctx;
  if (!rlsOn(config)) return;
  const rows = await readScopes(ctx).catch(() => []);
  const probe = everyoneUpns(rows).find((u) => u !== user.upn.toLowerCase());
  for (const m of rlsModels(config)) {
    const org = ACCESS_INVENTORY[m.kind].org.table.replace(/'/g, "''");
    const query = `EVALUATE ROW("People", COUNTROWS('${org}'), "Paths", COUNTROWS('${ACCESS_PEOPLE_TABLE}'), "Managed", COUNTROWS(FILTER('${ACCESS_PEOPLE_TABLE}', CONTAINSSTRING('${ACCESS_PEOPLE_TABLE}'[OrgPath], "|"))))`;
    /** @type {any} */
    let mine;
    try {
      mine = firstRow(await api.powerBi.executeQueries(m.workspaceId, m.datasetId, query));
    } catch (err) {
      ui.note(`Couldn't query ${m.name} to check org-scoped access (${/** @type {Error} */ (err).message}).`);
      continue;
    }
    const people = Number(mine?.['[People]'] ?? 0);
    const paths = Number(mine?.['[Paths]'] ?? 0);
    const managed = Number(mine?.['[Managed]'] ?? 0);
    if (!people) {
      ui.note(`${m.name} has no org data yet, so org-scoped access can be checked after the next load.`);
      continue;
    }
    if (paths && managed / paths < LOW_MANAGER_COVERAGE) {
      ui.warn(`${m.name}: only ${managed} of ${paths} people have a manager in the org data, so "below a person" scopes miss the rest. Org value scopes still work.`);
    }
    if (!probe) continue;
    const seen = await api.powerBi
      .executeQueries(m.workspaceId, m.datasetId, `EVALUATE ROW("People", COUNTROWS('${org}'))`, { impersonatedUserName: probe })
      .then((res) => Number(firstRow(res)?.['[People]'] ?? 0))
      .catch(() => null);
    if (seen === null) ui.note(`Couldn't query ${m.name} as ${probe} to check what they see.`);
    else if (seen >= people) ui.ok(`${m.name}: ${probe} sees all ${people.toLocaleString('en-GB')} people`);
    else ui.warn(`${m.name}: ${probe} has an "everyone" scope but sees ${seen.toLocaleString('en-GB')} of ${people.toLocaleString('en-GB')} people. The roles may not have applied: try "Apply now" from "access".`);
  }
}

const isEmail = (/** @type {string} */ v) => (/^[^\s@]+@[^\s@]+$/.test(v.trim()) ? true : 'Enter an email address');

/**
 * Asks for a person and returns their UPN, or null when there's no such user.
 * @param {Ctx} ctx
 * @param {string} message
 * @param {{ allowDefault?: boolean, default?: string }} [o]
 */
async function askPerson(ctx, message, o = {}) {
  const { ui, api } = ctx;
  const answer = (await ui.input(message, { default: o.default, validate: (v) => (o.allowDefault && v.trim() === '*' ? true : isEmail(v)) })).trim();
  if (answer === '*') return { upn: '*', id: undefined };
  const p = await api.graph.resolvePrincipal(answer).catch(() => null);
  if (!p || p.kind !== 'user') {
    ui.warn(`No user called "${answer}"`);
    return null;
  }
  return { upn: p.displayName.toLowerCase(), id: p.id };
}

/**
 * Asks for a new scope and adds it to the list. Returns the new list, or null when nothing changed.
 * @param {Ctx} ctx
 * @param {ScopeRow[]} rows
 */
async function addFlow(ctx, rows) {
  const { ui, config, api, user } = ctx;
  const attribute = config.access?.rls?.orgAttribute ?? 'department';
  const person = await askPerson(ctx, 'Who? (email, or * for anyone without a scope of their own)', { allowDefault: true });
  if (!person) return null;
  const type = /** @type {ScopeRow['ScopeType']} */ (
    await ui.select(
      'What should they see?',
      [
        { name: 'Everyone', value: 'all', description: 'Every org, and the tenant-wide pages (spend, agents, security).' },
        { name: 'Everyone below a person', value: 'hierarchy', description: 'That person and their reports, all the way down the manager chain.' },
        { name: `One ${ATTRIBUTE_LABELS[attribute]}`, value: 'org', description: `Everyone whose ${ATTRIBUTE_LABELS[attribute]} in the org data matches.` },
      ],
      'hierarchy',
    )
  );
  let value = '';
  if (type === 'hierarchy') {
    const root = await askPerson(ctx, 'Below whom? (email)', person.upn === '*' ? {} : { default: person.upn });
    if (!root) return null;
    value = root.upn;
  } else if (type === 'org') {
    value = (await ui.input(`Which ${ATTRIBUTE_LABELS[attribute]}? (as it appears in the org data)`, { validate: (v) => (v.trim() ? true : 'Enter a value') })).trim();
  }
  const row = newRow({ upn: person.upn, type, value }, { grantedBy: user.upn, now: ctx.now() });
  const groupId = config.access?.groupId;
  if (person.id && groupId) {
    // A scope is no use without the group: it's what lets them open the report and query the model.
    const added = await api.graph.addGroupMember(groupId, person.id).catch(() => null);
    if (added) ui.ok(`Added ${person.upn} to ${config.access?.groupName ?? 'the viewer group'}`);
    else if (added === null) ui.warn(`Couldn't add ${person.upn} to ${config.access?.groupName ?? 'the viewer group'}. Add them, or they can't open the report.`);
  }
  ui.ok(describeScope(row, attribute));
  return addScope(rows, row);
}

/**
 * Turns org-scoped access on: seeds an `everyone` scope for the current viewers, then redeploys.
 * @param {Ctx} ctx
 * @param {(ctx: Ctx) => Promise<unknown>} redeploy  The `update` command.
 */
async function turnOn(ctx, redeploy) {
  const { ui, config, api, user } = ctx;
  ui.heading('Org-scoped access');
  ui.info('Each viewer then sees only the orgs you give them: everyone, everyone below a person, or one department or country.');
  ui.info('Pages for tenant-wide data (spend, agents, security) show only to people who see everyone.');
  ui.info('People in the viewer group now keep seeing everything. Anyone added later sees nothing until you give them a scope.');
  const blockers = rlsBlockers(ctx);
  if (blockers.length) {
    for (const b of blockers) ui.fail(b);
    return false;
  }
  await showBypass(ctx);
  ui.note('It needs the tenant setting "Allow XMLA endpoints" and a capacity whose XMLA endpoint is Read Write.');
  const group = await ensureViewerGroup(ctx);
  if (!group) return false;
  const existing = await readScopes(ctx);
  /** @type {ScopeRow[]} */
  let rows = existing;
  if (!existing.length) {
    const members = await api.graph.groupUsers(group.id).catch(() => null);
    if (!members) ui.warn(`Couldn't list the members of ${group.displayName}, so only you keep seeing everything.`);
    rows = seedRows([...(members ?? []).map((m) => m.userPrincipalName ?? ''), user.upn], { grantedBy: user.upn, now: ctx.now() });
    ui.info(`${rows.length} ${rows.length === 1 ? 'person keeps' : 'people keep'} seeing everything.`);
  } else ui.info(`Using the ${existing.length} scope${existing.length === 1 ? '' : 's'} saved from before.`);
  if (!(await ui.confirm('Turn on org-scoped access? The models are redeployed and refreshed.', false))) return false;
  await writeScopes(ctx, rows);
  const a = /** @type {import('../config.js').AccessConfig} */ (config.access);
  a.rls = { enabled: true, orgAttribute: a.rls?.orgAttribute ?? 'department', applied: [] };
  ctx.save();
  await redeploy(ctx);
  return true;
}

/**
 * The org-scoped access menu: turn it on, or manage the scopes when it's on.
 * @param {Ctx} ctx
 * @param {(ctx: Ctx) => Promise<unknown>} redeploy  The `update` command, to redeploy the models.
 */
export async function orgAccessCommand(ctx, redeploy) {
  const { ui, config } = ctx;
  if (!rlsOn(config)) {
    await turnOn(ctx, redeploy);
    return;
  }
  const rls = /** @type {import('../config.js').RlsConfig} */ (config.access?.rls);
  let rows = await readScopes(ctx);
  let changed = false;
  for (;;) {
    const attribute = rls.orgAttribute ?? 'department';
    ui.heading('Org-scoped access');
    ui.note(`Scopes are kept in ${store(ctx).where}. Org scopes match the ${ATTRIBUTE_LABELS[attribute]}.`);
    for (const r of rows.slice(0, 40)) ui.info(describeScope(r, attribute));
    if (rows.length > 40) ui.info(`...and ${rows.length - 40} more`);
    if (!rows.length) ui.info('Nobody has a scope, so viewers see nothing.');
    const action = await ui.select(
      'What next?',
      [
        { name: 'Give someone a scope', value: 'add' },
        ...(rows.length ? [{ name: 'Remove a scope', value: 'remove' }] : []),
        { name: changed ? 'Apply the changes now' : 'Apply now', value: 'apply', description: 'Reloads the scopes, re-applies the roles and refreshes the models. Takes a few minutes.' },
        { name: `Match org scopes on ${attribute === 'department' ? 'country' : 'department'} instead`, value: 'attribute', description: 'Redeploys the models.' },
        { name: 'Turn off org-scoped access', value: 'off', description: 'Everyone in the viewer group sees everything again. The scopes are kept.' },
        { name: 'Done', value: 'done' },
      ],
      changed ? 'apply' : 'done',
    );
    if (action === 'done') {
      if (changed) ui.warn('The changes are saved but not applied yet. They take effect when you apply them, or for scopes other than "everyone", at the next scheduled load.');
      return;
    }
    if (action === 'add') {
      const next = await addFlow(ctx, rows);
      if (next) {
        rows = next;
        await writeScopes(ctx, rows);
        changed = true;
      }
    } else if (action === 'remove') {
      const key = await ui.select('Which one?', [...rows.map((r) => ({ name: describeScope(r, attribute), value: scopeKey(r) })), { name: 'None', value: '' }], '');
      if (key) {
        rows = removeScope(rows, key);
        await writeScopes(ctx, rows);
        changed = true;
      }
    } else if (action === 'apply') {
      if (await applyOrgAccess(ctx, { refresh: true })) {
        changed = false;
        await verifyOrgAccess(ctx);
      }
    } else if (action === 'attribute') {
      const next = /** @type {typeof ORG_ATTRIBUTES[number]} */ (attribute === 'department' ? 'country' : 'department');
      if (rows.some((r) => r.ScopeType === 'org')) ui.warn(`Org scopes keep their values, so check they're ${ATTRIBUTE_LABELS[next]} names.`);
      if (!(await ui.confirm(`Match org scopes on ${next}? The models are redeployed and refreshed.`, true))) continue;
      Object.assign(rls, { orgAttribute: next, applied: [] });
      ctx.save();
      await redeploy(ctx);
      changed = false;
    } else if (action === 'off') {
      if (!(await ui.confirm('Turn off org-scoped access? Everyone in the viewer group sees everything again. The models are redeployed and refreshed.', false))) continue;
      Object.assign(rls, { enabled: false, applied: [] });
      ctx.save();
      await redeploy(ctx);
      ui.ok('Org-scoped access is off. The scopes are kept for if you turn it on again.');
      return;
    }
  }
}
