// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCESS_INVENTORY,
  ACCESS_PEOPLE_TABLE,
  ACCESS_SCOPE_TABLE,
  allOnlyFilter,
  EVERYONE_ROLE,
  ORG_VALUE_COLUMN,
  PATH_COLUMN,
  rlsSettings,
  roleDefinitions,
  SCOPED_ROLE,
  scopedFilter,
} from '../src/transform/access.js';
import { buildAgentEvaluatorModel, buildConsumptionModel, buildModel, loadTemplateModel } from '../src/transform/model.js';
import { realSources } from './fakes.js';

const sources = realSources();
const lake = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' };
const allModules = { orgData: true, m365Activity: true, agent365: true, productFeedback: true, defender: true, consumption: true, agentEvaluator: true };

/** @type {Record<keyof typeof ACCESS_INVENTORY, (access?: { orgAttribute?: string }) => import('../src/transform/model.js').ModelBim>} */
const build = {
  valuelens: (access) =>
    buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { ...lake, modules: /** @type {any} */ (allModules), resourceGraph: true, access }),
  consumption: (access) => buildConsumptionModel(loadTemplateModel(/** @type {string} */ (sources.consumptionModelFile)), { ...lake, resourceGraph: true, access }),
  agentEvaluator: (access) => buildAgentEvaluatorModel(loadTemplateModel(/** @type {string} */ (sources.agentEvaluatorModelFile)), { ...lake, access }),
};
const kinds = /** @type {(keyof typeof ACCESS_INVENTORY)[]} */ (Object.keys(ACCESS_INVENTORY));

test('rlsSettings: only when org-scoped access is on, department by default', () => {
  assert.equal(rlsSettings({}), undefined);
  assert.equal(rlsSettings({ access: { groupId: 'g' } }), undefined);
  assert.equal(rlsSettings({ access: { rls: { enabled: false } } }), undefined);
  assert.deepEqual(rlsSettings({ access: { rls: { enabled: true } } }), { orgAttribute: 'department' });
  assert.deepEqual(rlsSettings({ access: { rls: { enabled: true, orgAttribute: 'country' } } }), { orgAttribute: 'country' });
});

for (const kind of kinds) {
  test(`${kind}: without org-scoped access the model is unchanged`, () => {
    const off = build[kind]();
    assert.ok(!off.model.roles?.length, 'no roles');
    assert.ok(!off.model.tables.some((t) => t.name === ACCESS_SCOPE_TABLE || t.name === ACCESS_PEOPLE_TABLE));
    assert.ok(!off.model.tables.some((t) => t.columns?.some((/** @type {any} */ c) => c.name === PATH_COLUMN)));
  });

  test(`${kind}: every import table is classified, and the inventory names only real tables`, () => {
    const off = build[kind]();
    const inv = ACCESS_INVENTORY[kind];
    const listed = [inv.org.table, ...inv.viaOrg, ...inv.direct.map((d) => d.table), ...inv.allOnly, ...inv.open];
    assert.equal(new Set(listed).size, listed.length, 'each table is listed once');
    const imported = off.model.tables.filter((t) => t.partitions?.[0]?.source?.type !== 'calculated').map((t) => t.name);
    assert.deepEqual(imported.filter((n) => !listed.includes(n)), [], 'unclassified tables');
    assert.deepEqual(listed.filter((n) => !imported.includes(n)), [], 'inventory names a table the model lacks');
    for (const d of inv.direct) {
      assert.ok(off.model.tables.find((t) => t.name === d.table)?.columns.some((/** @type {any} */ c) => c.name === d.key), `${d.table}[${d.key}]`);
    }
  });

  test(`${kind}: tables reached through the org table really are, and filtered tables don't hide rows that point at them`, () => {
    const off = build[kind]();
    const inv = ACCESS_INVENTORY[kind];
    const rels = (off.model.relationships ?? []).filter((r) => r.isActive !== false);
    const reached = new Set([inv.org.table]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rels) {
        if (reached.has(r.toTable) && !reached.has(r.fromTable)) {
          reached.add(r.fromTable);
          grew = true;
        }
        if (r.crossFilteringBehavior === 'bothDirections' && reached.has(r.fromTable) && !reached.has(r.toTable)) {
          reached.add(r.toTable);
          grew = true;
        }
      }
    }
    for (const name of inv.viaOrg) assert.ok(reached.has(name), `${name} is reached from ${inv.org.table}`);
    // A filtered table on the one side of a relationship hides the many side's unmatched rows, so the
    // many side must be filtered at least as tightly. Copilot Licensed is the known exception.
    const filtered = new Set([...inv.allOnly, ...inv.direct.map((d) => d.table)]);
    const visible = new Set([...inv.viaOrg, inv.org.table, ...inv.open]);
    const leaks = rels.filter((r) => filtered.has(r.toTable) && visible.has(r.fromTable) && !(kind === 'valuelens' && r.toTable === 'Copilot Licensed'));
    assert.deepEqual(leaks.map((r) => `${r.fromTable} -> ${r.toTable}`), []);
  });

  test(`${kind}: with org-scoped access, two roles cover every table and nothing else changes`, () => {
    const off = build[kind]();
    const on = build[kind]({ orgAttribute: 'department' });
    const inv = ACCESS_INVENTORY[kind];
    assert.deepEqual(
      on.model.roles?.map((r) => [r.name, r.modelPermission, r.members]),
      [
        [EVERYONE_ROLE, 'read', undefined],
        [SCOPED_ROLE, 'read', undefined],
      ],
    );
    const everyone = /** @type {any} */ (on.model.roles?.[0]);
    assert.deepEqual(
      everyone.tablePermissions.map((/** @type {any} */ p) => p.name),
      [ACCESS_SCOPE_TABLE],
    );
    const scoped = /** @type {any} */ (on.model.roles?.[1]);
    /** @type {Map<string, string>} */
    const byTable = new Map(scoped.tablePermissions.map((/** @type {any} */ p) => [p.name, p.filterExpression]));
    for (const name of [...inv.viaOrg, ...inv.open]) assert.ok(!byTable.has(name), `${name} is filtered through the org table, or open`);
    for (const name of inv.allOnly) assert.equal(byTable.get(name), allOnlyFilter(), name);
    assert.ok(byTable.get(inv.org.table)?.includes(`'${inv.org.table}'[${inv.org.attributes.department}]`));
    for (const d of inv.direct) assert.ok(byTable.get(d.table)?.includes(`[${ORG_VALUE_COLUMN}]`));
    assert.equal(byTable.get(ACCESS_PEOPLE_TABLE), allOnlyFilter());
    assert.ok(byTable.get(ACCESS_SCOPE_TABLE)?.includes('"*"'));
    for (const t of on.model.tables.filter((x) => x.partitions?.[0]?.source?.type === 'calculated')) assert.ok(!byTable.has(t.name), `${t.name} (calculated) is open`);

    // The access tables are hidden and fall back to empty; the template's own tables are untouched.
    for (const name of [ACCESS_SCOPE_TABLE, ACCESS_PEOPLE_TABLE]) {
      const table = on.model.tables.find((t) => t.name === name);
      assert.equal(table?.isHidden, true);
      const m = table?.partitions[0].source.expression.join('\n');
      assert.match(m, /Raw = try \w+\("access_(scope|people)"\) otherwise null/);
      assert.match(m, /#table\(Columns, \{\}\)/);
    }
    const strip = (/** @type {any} */ m) => {
      const copy = structuredClone(m);
      delete copy.roles;
      copy.tables = copy.tables
        .filter((/** @type {any} */ t) => t.name !== ACCESS_SCOPE_TABLE && t.name !== ACCESS_PEOPLE_TABLE)
        .map((/** @type {any} */ t) => ({ ...t, columns: t.columns.filter((/** @type {any} */ c) => c.name !== PATH_COLUMN && c.name !== ORG_VALUE_COLUMN) }));
      return copy;
    };
    assert.deepEqual(strip(on.model), off.model);
  });
}

test('the org attribute picks each model\'s own column', () => {
  for (const kind of kinds) {
    const on = build[kind]({ orgAttribute: 'country' });
    const inv = ACCESS_INVENTORY[kind];
    const scoped = /** @type {any} */ (on.model.roles?.find((r) => r.name === SCOPED_ROLE));
    const filter = scoped.tablePermissions.find((/** @type {any} */ p) => p.name === inv.org.table).filterExpression;
    assert.ok(filter.includes(`VAR __org = '${inv.org.table}'[${inv.org.attributes.country}]`), kind);
  }
});

test('the scoped filter: own rows, else the default; all, org values or below a person', () => {
  assert.equal(
    scopedFilter("'Org'[Access Path]", "'Org'[Department]"),
    [
      'VAR __me = LOWER(USERPRINCIPALNAME())',
      `VAR __own = FILTER('Access Scope', 'Access Scope'[UserPrincipalName] = __me && 'Access Scope'[Status] = "active")`,
      'VAR __who = IF(ISEMPTY(__own), "*", __me)',
      `VAR __rules = FILTER('Access Scope', 'Access Scope'[UserPrincipalName] = __who && 'Access Scope'[Status] = "active")`,
      `VAR __isAll = NOT ISEMPTY(FILTER(__rules, 'Access Scope'[ScopeType] = "all"))`,
      `VAR __orgs = SELECTCOLUMNS(FILTER(__rules, 'Access Scope'[ScopeType] = "org"), "Value", 'Access Scope'[ScopeValue])`,
      `VAR __roots = SELECTCOLUMNS(FILTER(__rules, 'Access Scope'[ScopeType] = "hierarchy"), "Root", 'Access Scope'[ScopeValue])`,
      "VAR __path = 'Org'[Access Path]",
      "VAR __org = 'Org'[Department]",
      'RETURN',
      '    __isAll',
      '        || (NOT ISBLANK(__org) && __org IN __orgs)',
      '        || (NOT ISBLANK(__path) && NOT ISEMPTY(FILTER(__roots, PATHCONTAINS(__path, [Root]))))',
    ].join('\n'),
  );
});

test('the lookup columns read the access tables by lower-case UPN', () => {
  const on = build.valuelens({});
  const org = on.model.tables.find((t) => t.name === ACCESS_INVENTORY.valuelens.org.table);
  assert.equal(
    org?.columns.find((/** @type {any} */ c) => c.name === PATH_COLUMN).expression,
    "LOOKUPVALUE('Access People'[OrgPath], 'Access People'[PersonId], LOWER('Chat + Agent Org Data'[PersonId]), BLANK())",
  );
  const licensed = on.model.tables.find((t) => t.name === 'Copilot Licensed');
  assert.equal(
    licensed?.columns.find((/** @type {any} */ c) => c.name === ORG_VALUE_COLUMN).expression,
    "LOOKUPVALUE('Chat + Agent Org Data'[Organization], 'Chat + Agent Org Data'[PersonId], 'Copilot Licensed'[UPN_Normalized], BLANK())",
  );
});

test('roleDefinitions: Viewers in the scoped role; everyone-scope people (and Viewers, when that is the default) in Everyone', () => {
  const on = build.consumption({});
  const roles = roleDefinitions(on.model, { groupId: 'g1', tenantId: 't1', everyone: ['B@x.com', 'a@x.com', 'a@x.com', '*', ''] });
  assert.deepEqual(
    roles.map((r) => [r.name, r.members]),
    [
      [
        EVERYONE_ROLE,
        [
          { memberName: 'a@x.com', identityProvider: 'AzureAD', memberType: 'user' },
          { memberName: 'b@x.com', identityProvider: 'AzureAD', memberType: 'user' },
        ],
      ],
      [SCOPED_ROLE, [{ memberName: 'obj:g1@t1', identityProvider: 'AzureAD', memberType: 'group' }]],
    ],
  );
  const open = roleDefinitions(on.model, { groupId: 'g1', tenantId: 't1', everyone: [], defaultAll: true });
  assert.deepEqual(open[0].members, [{ memberName: 'obj:g1@t1', identityProvider: 'AzureAD', memberType: 'group' }]);
  assert.ok(open[1].tablePermissions.length > 1, 'the scoped role keeps its filters');
  assert.throws(() => roleDefinitions(build.consumption().model, { groupId: 'g', tenantId: 't', everyone: [] }), /without org-scoped access/);
});
