// @ts-check
/**
 * Region preflight on the Azure path: the regions Azure Policy allows where everything the installer
 * deploys is offered to this subscription, so a restricted region is never offered rather than failing
 * the deployment.
 */
import { armLocation } from '../../clients/azure.js';

/** Built-in "Allowed locations" policies, by definition name, and whether they cover only resource groups. */
export const ALLOWED_LOCATIONS = /** @type {Record<string, boolean>} */ ({
  'e56962a6-4747-49cd-b67b-bf8b01975c4c': false,
  'e765b5de-1225-4ba3-bd56-1ac6695af988': true,
});
const RG_TYPE = 'Microsoft.Resources/subscriptions/resourceGroups';
/** The policy alias for Azure SQL's public network access. */
export const SQL_PUBLIC_ACCESS = 'Microsoft.Sql/servers/publicNetworkAccess';
/**
 * Built-in policies that keep Azure SQL's public network access off, by definition name, with their
 * default effect: "Public network access on Azure SQL Database should be disabled" (Audit, Deny) and
 * "Configure Azure SQL Server to disable public network access" (Modify).
 */
export const SQL_PRIVATE_BUILT_INS = /** @type {Record<string, string>} */ ({
  '1b8ca024-1d5c-4dec-8995-b1a932b41780': 'Audit',
  '28b0b1e5-17ba-4963-a7a4-5a1ab4400a0b': 'Modify',
});

/** What a first deployment puts in the install region, by resource type. */
export const REGION_TYPES = {
  'Microsoft.ManagedIdentity/userAssignedIdentities': 'managed identities',
  'Microsoft.OperationalInsights/workspaces': 'Log Analytics',
  'Microsoft.Storage/storageAccounts': 'Storage',
  'Microsoft.App/managedEnvironments': 'Container Apps environments',
  'Microsoft.App/jobs': 'Container Apps jobs',
  'Microsoft.App/containerApps': 'Container Apps',
};
export const SQL_TYPE = 'Microsoft.Sql/servers';
export const ASK_TYPE = 'Microsoft.CognitiveServices/accounts';

/**
 * @typedef {{ assignment: string, locations: string[], resourceGroups: boolean, types?: string[] }} LocationRule
 * @typedef {object} RegionCheck
 * @property {{ name: string, displayName: string }[]} regions  The subscription's physical regions.
 * @property {LocationRule[]} rules  Allowed-locations rules assigned here or above.
 * @property {string[]} unread  Assignments whose rules couldn't be read.
 * @property {boolean} policyUnreadable  The policy assignments couldn't be listed.
 * @property {boolean} newResourceGroup  The resource group is created in the install region.
 * @property {Record<string, string>} missing  By region: what the install region needs that isn't offered there.
 * @property {Record<string, string>} sql  By region: why Azure SQL can't go there.
 * @property {string[]} [sqlPrivate]  Assignments that keep Azure SQL's public network access off (deny or modify).
 */

const PARAM = /^\[parameters\('([^']+)'\)\]$/i;
/** A policy value: a literal, or "[parameters('x')]" from `params`, else the definition's default. @param {any} value @param {any} params @param {any} defaults */
const resolve = (value, params, defaults) => {
  const m = typeof value === 'string' ? PARAM.exec(value) : null;
  return m ? params?.[m[1]]?.value ?? defaults?.[m[1]]?.defaultValue : value;
};
const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => String(a).toLowerCase() === String(b).toLowerCase();
const short = (/** @type {string[]} */ list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

/**
 * The locations a custom policy allows, when it denies a `location` that isn't in a list: the rule's
 * `if`, or one of its top-level allOf conditions, is `location notIn [...]` or `not location in [...]`.
 * @param {any} definition  The policy definition.
 * @param {Record<string, { value?: any }> | undefined} params  The assignment's values for its parameters.
 * @returns {Omit<LocationRule, 'assignment'> | null}
 */
export function locationRule(definition, params) {
  const p = definition?.properties ?? {};
  const rule = p.policyRule;
  if (!same(resolve(rule?.then?.effect, params, p.parameters), 'deny')) return null;
  const conditions = Array.isArray(rule?.if?.allOf) ? rule.if.allOf : [rule?.if];
  /** @type {unknown} */
  let list;
  /** @type {string[] | undefined} */
  let types;
  for (const c of conditions) {
    if (same(c?.field, 'location') && c.notIn !== undefined) list = resolve(c.notIn, params, p.parameters);
    else if (same(c?.not?.field, 'location') && c.not.in !== undefined) list = resolve(c.not.in, params, p.parameters);
    else if (same(c?.field, 'type') && (c.equals ?? c.in) !== undefined) types = [resolve(c.equals ?? c.in, params, p.parameters)].flat().map(String);
  }
  if (!Array.isArray(list)) return null;
  const resourceGroups = !!types?.length && types.every((t) => same(t, RG_TYPE));
  return { locations: list.map((l) => armLocation(String(l))), resourceGroups, ...(types && !resourceGroups ? { types } : {}) };
}

/**
 * Whether a custom policy keeps Azure SQL's public network access off: a deny whose condition reads
 * the publicNetworkAccess alias, or a modify or append that sets it to Disabled.
 * @param {any} definition  The policy definition.
 * @param {Record<string, { value?: any }> | undefined} params  The assignment's values for its parameters.
 */
export function forcesSqlPrivate(definition, params) {
  const p = definition?.properties ?? {};
  const rule = p.policyRule;
  const effect = String(resolve(rule?.then?.effect, params, p.parameters) ?? '').toLowerCase();
  const sets = (/** @type {any} */ op) => same(op?.field, SQL_PUBLIC_ACCESS) && same(resolve(op?.value, params, p.parameters), 'Disabled');
  if (effect === 'deny') return JSON.stringify(rule?.if ?? {}).toLowerCase().includes(SQL_PUBLIC_ACCESS.toLowerCase());
  if (effect === 'modify') return (rule?.then?.details?.operations ?? []).some((/** @type {any} */ op) => !same(op?.operation, 'remove') && sets(op));
  if (effect === 'append') return [rule?.then?.details ?? []].flat().some(sets);
  return false;
}

/**
 * The allowed-locations rules Azure Policy enforces at `scope`: assignments there and above it, of
 * the built-in Allowed locations policies or simple custom ones, directly or in an initiative. Also
 * the assignments that keep Azure SQL's public network access off (`sqlPrivate`).
 * Best effort: a definition it can't read is reported in `unread`; exemptions aren't read.
 * @param {any} arm  The ARM client.
 * @param {string} subscriptionId
 * @param {string} scope  The subscription, or the resource group when it exists.
 * @returns {Promise<{ rules: LocationRule[], unread: string[], sqlPrivate: string[] } | null>}  null when the assignments can't be read.
 */
export async function allowedLocationRules(arm, subscriptionId, scope) {
  /** @type {any[]} */
  let assignments;
  try {
    assignments = await arm.listPolicyAssignments(scope);
  } catch {
    return null;
  }
  const target = scope.toLowerCase();
  const live = assignments.filter((a) => a.properties?.enforcementMode !== 'DoNotEnforce' && !(a.properties?.notScopes ?? []).some((/** @type {string} */ s) => target === s.toLowerCase() || target.startsWith(`${s.toLowerCase()}/`)));
  /** @type {Promise<any[]> | undefined} */
  let custom;
  /** @type {Map<string, Promise<any>>} */
  const cache = new Map();
  const lookup = (/** @type {string} */ id) => {
    const key = id.toLowerCase();
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        if (!/^\/providers\//i.test(id)) {
          custom ??= Promise.all(['policyDefinitions', 'policySetDefinitions'].map((kind) => arm.listCustomPolicies(subscriptionId, kind).catch(() => []))).then((lists) => lists.flat());
          const found = (await custom).find((d) => same(d.id, id));
          if (found) return found;
        }
        return arm.getPolicy(id).catch(() => null);
      })());
    }
    return /** @type {Promise<any>} */ (cache.get(key));
  };
  /** @type {LocationRule[]} */
  const rules = [];
  const unread = new Set();
  /** @type {Set<string>} */
  const sqlPrivate = new Set();
  /** @param {string} id @param {Record<string, { value?: any }> | undefined} params @param {string} name */
  const add = async (id, params, name) => {
    const builtIn = /^\/providers\/Microsoft\.Authorization\/policyDefinitions\/([^/]+)$/i.exec(id);
    if (builtIn) {
      const sqlDefault = SQL_PRIVATE_BUILT_INS[builtIn[1].toLowerCase()];
      if (sqlDefault && /^(deny|modify)$/i.test(String(params?.effect?.value ?? sqlDefault))) sqlPrivate.add(name);
      const resourceGroups = ALLOWED_LOCATIONS[builtIn[1].toLowerCase()];
      if (resourceGroups === undefined) return;
      const list = params?.listOfAllowedLocations?.value;
      if (Array.isArray(list)) rules.push({ assignment: name, locations: list.map((l) => armLocation(String(l))), resourceGroups });
      else unread.add(name);
      return;
    }
    const definition = await lookup(id);
    if (!definition) {
      unread.add(name);
      return;
    }
    const rule = locationRule(definition, params);
    if (rule) rules.push({ assignment: name, ...rule });
    if (forcesSqlPrivate(definition, params)) sqlPrivate.add(name);
  };
  await Promise.all(live.map(async (a) => {
    const p = a.properties ?? {};
    const name = String(p.displayName || a.name);
    const id = String(p.policyDefinitionId ?? '');
    if (!/\/policySetDefinitions\//i.test(id)) return add(id, p.parameters, name);
    const set = await lookup(id);
    if (!set) {
      unread.add(name);
      return;
    }
    await Promise.all((set.properties?.policyDefinitions ?? []).map((/** @type {any} */ ref) => {
      const params = Object.fromEntries(Object.entries(ref.parameters ?? {}).map(([k, v]) => [k, { value: resolve(/** @type {any} */ (v)?.value, p.parameters, set.properties?.parameters) }]));
      return add(String(ref.policyDefinitionId ?? ''), params, name);
    }));
  }));
  return { rules, unread: [...unread], sqlPrivate: [...sqlPrivate] };
}

/**
 * Runs `fn` over `items`, `n` at a time.
 * @template T @param {T[]} items @param {number} n @param {(item: T) => Promise<void>} fn
 */
async function each(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(/** @type {T} */ (queue.shift()));
  }));
}

/**
 * Which of the subscription's regions can take a first deployment: what Azure Policy allows, where each
 * resource type is offered, Standard_LRS storage, and whether this subscription may create Azure SQL servers.
 * Anything it can't read counts as allowed; the deployment has the last word.
 * @param {any} arm  The ARM client.
 * @param {{ subscriptionId: string, scope: string, newResourceGroup: boolean, locations: { name: string, displayName?: string, metadata?: { regionType?: string } }[] }} o
 * @returns {Promise<RegionCheck>}
 */
export async function checkRegions(arm, o) {
  const regions = o.locations.filter((l) => l.metadata?.regionType !== 'Logical').map((l) => ({ name: l.name, displayName: l.displayName ?? l.name }));
  const types = [...Object.keys(REGION_TYPES), SQL_TYPE];
  const namespaces = [...new Set(types.map((t) => t.split('/')[0]))];
  const [policy, providers, skus] = await Promise.all([
    allowedLocationRules(arm, o.subscriptionId, o.scope),
    Promise.all(namespaces.map((ns) => arm.getProvider(o.subscriptionId, ns).catch(() => null))),
    arm.storageSkus(o.subscriptionId).catch(() => []),
  ]);
  /** @type {Record<string, Set<string>>} */
  const offeredIn = {};
  for (const t of types) {
    const [ns, ...rest] = t.split('/');
    const rt = providers[namespaces.indexOf(ns)]?.resourceTypes?.find((/** @type {any} */ r) => same(r.resourceType, rest.join('/')));
    if (rt?.locations?.length) offeredIn[t] = new Set(rt.locations.map((/** @type {string} */ l) => armLocation(l)));
  }
  const storageBlocked = new Set(
    (/** @type {any[]} */ (skus))
      .filter((s) => s.name === 'Standard_LRS' && same(s.kind, 'StorageV2'))
      .flatMap((s) => (s.restrictions ?? []).filter((/** @type {any} */ r) => r.type === 'Location' && /NotAvailableForSubscription/i.test(String(r.reasonCode))).flatMap((/** @type {any} */ r) => r.values ?? []))
      .map((/** @type {string} */ l) => armLocation(l)),
  );
  /** @type {RegionCheck} */
  const check = { regions, rules: policy?.rules ?? [], unread: policy?.unread ?? [], policyUnreadable: !policy, newResourceGroup: o.newResourceGroup, missing: {}, sql: {}, sqlPrivate: policy?.sqlPrivate ?? [] };
  for (const r of regions) {
    const gaps = Object.entries(REGION_TYPES).filter(([t]) => offeredIn[t] && !offeredIn[t].has(r.name)).map(([, label]) => label);
    if (storageBlocked.has(r.name)) gaps.push('Standard_LRS storage for this subscription');
    if (gaps.length) check.missing[r.name] = `${gaps.join(', ')} not offered`;
    if (offeredIn[SQL_TYPE] && !offeredIn[SQL_TYPE].has(r.name)) check.sql[r.name] = 'Azure SQL not offered';
  }
  // Azure SQL turns subscriptions away region by region, and only says so in its capabilities.
  await each(regions.filter((r) => !check.sql[r.name] && !policyBlock(check, r.name, [SQL_TYPE])), 8, async (r) => {
    const cap = await arm.sqlCapability(o.subscriptionId, r.name).catch(() => null);
    if (cap && !/^(Available|Default)$/i.test(String(cap.status))) check.sql[r.name] = `Azure SQL ${cap.reason ? `restricted: ${String(cap.reason).replace(/\.$/, '')}` : 'not available to this subscription'}`;
  });
  return check;
}

/**
 * The policy assignments that keep these resource types out of `region`, or ''.
 * @param {RegionCheck} check @param {string} region @param {string[]} types @param {boolean} [resourceGroup]  The resource group goes there too.
 */
export function policyBlock(check, region, types, resourceGroup = false) {
  const applies = (/** @type {LocationRule} */ r) => (r.resourceGroups ? resourceGroup : !r.types || r.types.some((t) => types.some((u) => same(t, u))));
  return [...new Set(check.rules.filter((r) => applies(r) && !r.locations.includes(region)).map((r) => r.assignment))].join(', ');
}

/** Why Azure SQL can't go in `region`, or ''. @param {RegionCheck} check @param {string} region */
export function sqlProblem(check, region) {
  const blocked = policyBlock(check, region, [SQL_TYPE]);
  return blocked ? `Azure Policy (${blocked})` : check.sql[region] ?? '';
}

/**
 * Why `region` can't be the install region; empty when it can.
 * @param {RegionCheck} check @param {string} region @param {{ sql: boolean }} o  Azure SQL goes there too.
 */
export function regionProblems(check, region, o) {
  const blocked = policyBlock(check, region, [...Object.keys(REGION_TYPES), ...(o.sql ? [SQL_TYPE] : [])], check.newResourceGroup);
  return [
    ...(blocked ? [`Azure Policy (${blocked})`] : []),
    ...(check.missing[region] ? [check.missing[region]] : []),
    ...(o.sql && check.sql[region] ? [check.sql[region]] : []),
  ];
}

/**
 * Where Azure Policy lets a resource type go, or null when it doesn't restrict it.
 * @param {RegionCheck | undefined} check @param {string} type
 */
export function allowedFor(check, type) {
  const rules = (check?.rules ?? []).filter((r) => !r.resourceGroups && (!r.types || r.types.some((t) => same(t, type))));
  return rules.length ? rules.map((r) => r.locations).reduce((a, b) => a.filter((l) => b.includes(l))) : null;
}

/**
 * Why regions are missing from the list: the allowed-locations rules, and the regions they allow
 * that something isn't offered in.
 * @param {RegionCheck} check @param {string[]} offered @param {{ sql: boolean }} o
 */
export function regionNotes(check, offered, o) {
  const lines = [];
  if (check.policyUnreadable) lines.push('Couldn\'t read Azure Policy here, so regions aren\'t filtered by allowed locations; Azure checks them when it deploys.');
  for (const r of check.rules) {
    if (r.resourceGroups && !check.newResourceGroup) continue;
    const line = `Azure Policy "${r.assignment}" allows ${r.resourceGroups ? 'resource groups in ' : ''}${short(r.locations) || 'no regions'}.`;
    if (!lines.includes(line)) lines.push(line);
  }
  if (check.unread.length) lines.push(`Couldn't read Azure Policy ${check.unread.map((n) => `"${n}"`).join(', ')}; Azure checks ${check.unread.length > 1 ? 'them' : 'it'} when it deploys.`);
  /** @type {Map<string, string[]>} */
  const why = new Map();
  for (const r of check.regions) {
    const problems = regionProblems(check, r.name, o);
    if (offered.includes(r.name) || problems.some((p) => p.startsWith('Azure Policy'))) continue;
    const key = problems.join('; ');
    if (key) why.set(key, [...(why.get(key) ?? []), r.name]);
  }
  for (const [reason, names] of why) lines.push(`Not offered: ${short(names)} (${reason}).`);
  return lines;
}

/** The stop message when no region passes. @param {RegionCheck} check @param {{ sql: boolean }} o */
export function noRegionMessage(check, o) {
  return [
    'No Azure region in this subscription passes Azure Policy and has everything Analytics Hub deploys, so the installer stopped before deploying anything.',
    ...regionNotes(check, [], o),
    'Ask an Azure administrator to allow a region where these are offered (for example uksouth, swedencentral or eastus2), or run the installer again and pick another subscription.',
  ].join(' ');
}
