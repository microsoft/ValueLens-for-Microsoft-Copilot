// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVERYONE_ROLE, SCOPED_ROLE } from '../src/transform/access.js';
import { buildModel, loadTemplateModel } from '../src/transform/model.js';
import { deployedRoles, deployModel, definitionRoles } from '../src/steps/model.js';
import {
  addScope,
  applyOrgAccess,
  AZURE_ROLES_FILE,
  AZURE_SCOPE_FILE,
  defaultAll,
  describeScope,
  ensureOrgAccess,
  everyoneUpns,
  FABRIC_ROLES_FILE,
  FABRIC_SCOPE_FILE,
  newRow,
  orgAccessCommand,
  parseScopeCsv,
  removeScope,
  rlsBlockers,
  rlsModels,
  scopeCsv,
  scopeKey,
  seedRows,
} from '../src/steps/org-access.js';
import { fakeArm, fakeCtx, fakeFabric, fakePowerBi, fakeUi, realSources } from './fakes.js';

const now = new Date('2026-06-01T12:00:00Z');
const by = { grantedBy: 'Admin@Contoso.com', now };
const lake = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens' };

/** The two roles, as a model built with org-scoped access has them. */
function builtRoles() {
  const bim = buildModel(loadTemplateModel(/** @type {string} */ (realSources().modelFile)), { ...lake, modules: /** @type {any} */ ({ orgData: true, m365Activity: true }), access: { orgAttribute: 'department' } });
  return /** @type {any[]} */ (bim.model.roles);
}

/** Files kept in memory, as OneLake or a storage container would. */
function files() {
  /** @type {Map<string, string>} */
  const map = new Map();
  /** @type {string[]} */
  const writes = [];
  const read = async (/** @type {string} */ path) => map.get(path) ?? null;
  const write = async (/** @type {string} */ path, /** @type {Uint8Array} */ bytes) => {
    writes.push(path);
    map.set(path, new TextDecoder().decode(bytes));
  };
  return { map, writes, read, write };
}

/** A viewer group with a few members, and what was added to it. */
function viewerGraph(members = ['Ana@contoso.com', 'ben@contoso.com']) {
  /** @type {string[]} */
  const added = [];
  const graph = {
    getGroup: async (/** @type {string} */ id) => (id === 'g-1' ? { id: 'g-1', displayName: 'Analytics Hub Viewers' } : null),
    groupUsers: async () => members.map((m, i) => ({ id: `u-${i}`, userPrincipalName: m })),
    addGroupMember: async (/** @type {string} */ _g, /** @type {string} */ id) => {
      added.push(id);
      return true;
    },
    resolvePrincipal: async (/** @type {string} */ name) => (name.includes('@') ? { id: `u-${name}`, displayName: name, kind: 'user' } : null),
  };
  return { graph, added };
}

/**
 * A Fabric install with the ValueLens model deployed and org-scoped access on.
 * @param {{ answers?: any[], yesTo?: string[], rls?: boolean, graph?: any }} [o]
 */
function fabricInstall(o = {}) {
  const fabric = fakeFabric();
  const lakeFiles = files();
  const oneLake = {
    readText: async (/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path) => lakeFiles.read(path),
    writeFile: async (/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path, /** @type {Uint8Array} */ bytes) => lakeFiles.write(path, bytes),
  };
  const powerBi = fakePowerBi();
  const ui = fakeUi({ answers: o.answers, yesTo: o.yesTo });
  const { ctx, config } = fakeCtx({ fabric: fabric.api, oneLake, powerBi: powerBi.api, graph: o.graph ?? viewerGraph().graph, ui: ui.ui });
  config.semanticModel.enabled = true;
  config.semanticModel.id = 'ds-vl';
  config.semanticModel.bound = true;
  config.fabric.notebooks.accessScope = 'nb-access';
  config.access = /** @type {any} */ ({ ...config.access, groupId: 'g-1', groupName: 'Analytics Hub Viewers', ...(o.rls === false ? {} : { rls: { enabled: true, orgAttribute: 'department', applied: [] } }) });
  return { ctx, config, fabric, lakeFiles, powerBi, ui };
}

const notebookRuns = (/** @type {string[]} */ calls) =>
  calls.filter((c) => c.startsWith('runJob RunNotebook ')).map((c) => JSON.parse(c.slice('runJob RunNotebook '.length)).parameters);

test('scope list: written and read back the same, quoted values included', () => {
  const rows = [
    ...seedRows(['Ana@Contoso.com', 'ana@contoso.com', 'ben@contoso.com', 'not-a-upn'], by),
    newRow({ upn: 'Cara@contoso.com', type: 'hierarchy', value: 'Dan@Contoso.com', canDelegate: true }, by),
    newRow({ upn: '*', type: 'org', value: 'Sales, "EMEA"', note: 'line one\nline two' }, by),
  ];
  assert.deepEqual(rows.map((r) => r.UserPrincipalName), ['ana@contoso.com', 'ben@contoso.com', 'cara@contoso.com', '*']);
  assert.equal(rows[0].GrantedVia, 'seed');
  assert.equal(rows[0].GrantedBy, 'admin@contoso.com');
  assert.equal(rows[2].ScopeValue, 'dan@contoso.com');
  assert.equal(rows[0].CreatedAt, '2026-06-01T12:00:00');
  assert.deepEqual(parseScopeCsv(scopeCsv(rows)), rows);
  const plain = rows.slice(0, 3);
  assert.deepEqual(parseScopeCsv(`\uFEFF${scopeCsv(plain).replace(/\n/g, '\r\n')}\r\n\r\n`), plain);
  assert.deepEqual(parseScopeCsv(null), []);
  assert.deepEqual(parseScopeCsv(''), []);
});

test('scope list: the same rules as the notebook and the jobs', () => {
  const head = 'UserPrincipalName,ScopeType,ScopeValue\n';
  assert.throws(() => parseScopeCsv(`${head}ana,all,\n`), /line 2: UserPrincipalName must be a UPN or \*/);
  assert.throws(() => parseScopeCsv(`${head}ana@contoso.com,team,\n`), /ScopeType must be one of all, hierarchy, org/);
  assert.throws(() => parseScopeCsv(`${head}ana@contoso.com,hierarchy,Sales\n`), /needs the root person's UPN/);
  assert.throws(() => parseScopeCsv(`${head}ana@contoso.com,org,\n`), /an org scope needs a value/);
  assert.throws(() => parseScopeCsv('UserPrincipalName,ScopeType,ScopeValue,GrantedVia\nana@contoso.com,all,,share\n'), /GrantedVia must be seed or installer/);
  const rows = parseScopeCsv(`${head}ANA@contoso.com,ALL,ignored\nana@contoso.com,all,\n,,\nben@contoso.com,hierarchy,Cara@Contoso.com\n`);
  assert.deepEqual(rows.map(scopeKey), ['ana@contoso.com|all|', 'ben@contoso.com|hierarchy|cara@contoso.com']);
  assert.deepEqual(rows.map((r) => [r.GrantedVia, r.Status, r.CanDelegate]), [['installer', 'active', false], ['installer', 'active', false]]);
});

test('scope list: add replaces the same scope, remove drops one; who sees everything', () => {
  let rows = seedRows(['ana@contoso.com', 'ben@contoso.com'], by);
  rows = addScope(rows, newRow({ upn: 'ana@contoso.com', type: 'all', value: '', note: 'again' }, by));
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.UserPrincipalName === 'ana@contoso.com')?.Note, 'again');
  rows = addScope(rows, newRow({ upn: 'cara@contoso.com', type: 'org', value: 'Sales' }, by));
  rows = addScope(rows, { ...newRow({ upn: 'dan@contoso.com', type: 'all', value: '' }, by), Status: 'pending_group' });
  assert.deepEqual(everyoneUpns(rows), ['ana@contoso.com', 'ben@contoso.com']);
  assert.equal(defaultAll(rows), false);
  rows = addScope(rows, newRow({ upn: '*', type: 'all', value: '' }, by));
  assert.equal(defaultAll(rows), true);
  assert.deepEqual(everyoneUpns(rows), ['ana@contoso.com', 'ben@contoso.com']);
  rows = removeScope(rows, 'ben@contoso.com|all|');
  assert.deepEqual(everyoneUpns(rows), ['ana@contoso.com']);
});

test('describeScope: in words', () => {
  assert.equal(describeScope(newRow({ upn: 'ana@contoso.com', type: 'all', value: '' }, by)), 'ana@contoso.com: everyone');
  assert.equal(describeScope(newRow({ upn: 'ana@contoso.com', type: 'hierarchy', value: 'ben@contoso.com', canDelegate: true }, by)), 'ana@contoso.com: ben@contoso.com and everyone below them (can share)');
  assert.equal(describeScope({ ...newRow({ upn: '*', type: 'org', value: 'France' }, by), Status: 'pending_group' }, 'country'), 'Anyone without a scope: country "France" (waiting for an admin)');
});

test('rlsModels: the deployed models on each target; Agent Evaluator only on Fabric', () => {
  const { config } = fakeCtx();
  config.semanticModel.enabled = true;
  config.semanticModel.id = 'ds-vl';
  config.modules.consumption = true;
  config.consumption.model.id = 'ds-cc';
  config.modules.agentEvaluator = true;
  assert.deepEqual(rlsModels(config).map((m) => [m.kind, m.datasetId]), [['valuelens', 'ds-vl'], ['consumption', 'ds-cc']]);
  config.agentEvaluator.model.id = 'ds-ae';
  assert.deepEqual(rlsModels(config).map((m) => m.kind), ['valuelens', 'consumption', 'agentEvaluator']);
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ powerBi: { workspaceId: 'pbi-ws', datasetId: 'az-vl', consumptionDatasetId: 'az-cc' } });
  assert.deepEqual(rlsModels(config).map((m) => [m.kind, m.workspaceId, m.datasetId]), [['valuelens', 'pbi-ws', 'az-vl'], ['consumption', 'pbi-ws', 'az-cc']]);
});

test('rlsBlockers: no model, a Pro workspace or private networking', () => {
  const { ctx, config } = fakeCtx();
  assert.match(rlsBlockers(ctx).join('\n'), /No semantic model is deployed yet/);
  config.target = 'azure';
  config.azure = /** @type {any} */ ({ powerBi: { workspaceId: 'pbi-ws', datasetId: 'az-vl' }, publicNetworkAccess: false });
  const blockers = rlsBlockers(ctx).join('\n');
  assert.match(blockers, /private networking/);
  assert.match(blockers, /Pro licence/);
  config.azure = /** @type {any} */ ({ powerBi: { workspaceId: 'pbi-ws', datasetId: 'az-vl', capacityId: 'cap-1' } });
  assert.deepEqual(rlsBlockers(ctx), []);
});

test('apply on Fabric: lands the list, applies the roles with members, then records them', async () => {
  const { ctx, config, fabric, lakeFiles, powerBi } = fabricInstall();
  lakeFiles.map.set(FABRIC_SCOPE_FILE, scopeCsv([...seedRows(['ana@contoso.com'], by), newRow({ upn: 'ben@contoso.com', type: 'org', value: 'Sales' }, by)]));
  deployedRoles(ctx).set('ds-vl', builtRoles());
  fabric.jobs.push({ status: 'Completed' });

  assert.equal(await applyOrgAccess(ctx, { refresh: false }), true);

  const [params] = notebookRuns(fabric.calls);
  assert.equal(params.MODE.value, 'all');
  assert.equal(params.ROLES_FILE.value, FABRIC_ROLES_FILE);
  const roles = JSON.parse(/** @type {string} */ (lakeFiles.map.get(FABRIC_ROLES_FILE)));
  assert.deepEqual(roles.map((/** @type {any} */ i) => [i.dataset, i.datasetId, i.role.name]), [[config.semanticModel.name, 'ds-vl', EVERYONE_ROLE], [config.semanticModel.name, 'ds-vl', SCOPED_ROLE]]);
  assert.deepEqual(roles[0].role.members.map((/** @type {any} */ m) => m.memberName), ['ana@contoso.com']);
  assert.deepEqual(roles[1].role.members, [{ memberName: 'obj:g-1@tenant-1', identityProvider: 'AzureAD', memberType: 'group' }]);
  assert.deepEqual(config.access?.rls?.applied, ['ds-vl']);
  assert.deepEqual(powerBi.calls, [], 'refresh: false leaves the refresh to the caller');
});

test('apply on Fabric: a model not deployed this run takes its roles from the last roles file, with members from the list now', async () => {
  const { ctx, config, fabric, lakeFiles, powerBi } = fabricInstall();
  const old = builtRoles().map((role) => ({ dataset: 'ValueLens', datasetId: 'ds-vl', role: { ...role, members: [{ memberName: 'gone@contoso.com' }] } }));
  lakeFiles.map.set(FABRIC_ROLES_FILE, JSON.stringify(old));
  lakeFiles.map.set(FABRIC_SCOPE_FILE, scopeCsv(seedRows(['ben@contoso.com'], by)));
  fabric.jobs.push({ status: 'Completed' });

  assert.equal(await applyOrgAccess(ctx), true);

  const roles = JSON.parse(/** @type {string} */ (lakeFiles.map.get(FABRIC_ROLES_FILE)));
  assert.deepEqual(roles[0].role.members.map((/** @type {any} */ m) => m.memberName), ['ben@contoso.com']);
  assert.deepEqual(config.access?.rls?.applied, ['ds-vl']);
  assert.ok(powerBi.calls.some((c) => c.startsWith('refresh ds-vl')), 'refreshes the model');
});

test('apply on Fabric: a failed notebook leaves the models unapplied and says why', async () => {
  const { ctx, config, fabric, lakeFiles, ui } = fabricInstall();
  lakeFiles.map.set(FABRIC_SCOPE_FILE, scopeCsv(seedRows(['ana@contoso.com'], by)));
  deployedRoles(ctx).set('ds-vl', builtRoles());
  fabric.jobs.push({ status: 'Failed', failureReason: { message: 'XMLA endpoint is read only' } });

  assert.equal(await ensureOrgAccess(ctx, { refresh: false }), false);
  assert.deepEqual(config.access?.rls?.applied, []);
  assert.match(ui.text(), /XMLA endpoint is read only/);
  assert.match(ui.text(), /Allow XMLA endpoints/);
});

test('ensureOrgAccess: nothing to do when off, or when every model has its members', async () => {
  const off = fabricInstall({ rls: false });
  assert.equal(await ensureOrgAccess(off.ctx), true);
  assert.deepEqual(off.fabric.calls, []);

  const on = fabricInstall();
  /** @type {any} */ (on.config.access).rls.applied = ['ds-vl'];
  assert.equal(await ensureOrgAccess(on.ctx), true);
  assert.deepEqual(notebookRuns(on.fabric.calls), []);
  assert.match(on.ui.text(), /Org-scoped access is in place/);
});

test('deployModel: a redeploy drops the model from applied, and records its roles for this run', async () => {
  const { ctx, config, fabric } = fabricInstall();
  const item = fabric.add('SemanticModel', 'ValueLens', null);
  config.semanticModel.id = item.id;
  /** @type {any} */ (config.access).rls.applied = [item.id, 'ds-other'];
  const bim = { model: { tables: [], roles: builtRoles() } };
  const definition = { parts: [{ path: 'model.bim', payload: Buffer.from(JSON.stringify(bim)).toString('base64') }] };
  assert.deepEqual(definitionRoles(definition).map((r) => r.name), [EVERYONE_ROLE, SCOPED_ROLE]);
  assert.deepEqual(definitionRoles({ parts: [{ path: 'model.bim', payload: Buffer.from('{"model":{}}').toString('base64') }] }), []);

  await deployModel(ctx, config.semanticModel, { signature: 'sig', definition: () => definition, force: true });

  assert.deepEqual(config.access?.rls?.applied, ['ds-other']);
  assert.deepEqual(deployedRoles(ctx).get(item.id)?.map((r) => r.name), [EVERYONE_ROLE, SCOPED_ROLE]);
});

test('turning it on: seeds everyone for the current viewers and you, then redeploys', async () => {
  const { graph } = viewerGraph(['Ana@contoso.com', 'ben@contoso.com']);
  const { ctx, config, lakeFiles, fabric } = fabricInstall({ rls: false, graph, yesTo: ['Turn on org-scoped access? The models are redeployed and refreshed.'] });
  fabric.roles.push({ id: 'r-1', principal: { id: 'p-1', displayName: 'Workspace Owner', type: 'User' }, role: 'Admin' });
  let redeployed = 0;

  await orgAccessCommand(ctx, async () => {
    redeployed++;
    assert.equal(config.access?.rls?.enabled, true, 'on before the redeploy, so the models get the roles');
  });

  assert.equal(redeployed, 1);
  assert.deepEqual(config.access?.rls, { enabled: true, orgAttribute: 'department', applied: [] });
  const rows = parseScopeCsv(lakeFiles.map.get(FABRIC_SCOPE_FILE));
  assert.deepEqual(rows.map((r) => [r.UserPrincipalName, r.ScopeType, r.GrantedVia]), [
    ['admin@contoso.com', 'all', 'seed'],
    ['ana@contoso.com', 'all', 'seed'],
    ['ben@contoso.com', 'all', 'seed'],
  ]);
});

test('turning it on: saying no changes nothing; scopes saved before are reused', async () => {
  const declined = fabricInstall({ rls: false });
  await orgAccessCommand(declined.ctx, async () => assert.fail('no redeploy'));
  assert.equal(declined.config.access?.rls, undefined);
  assert.equal(declined.lakeFiles.writes.length, 0);

  const again = fabricInstall({ rls: false, yesTo: ['Turn on org-scoped access? The models are redeployed and refreshed.'] });
  again.lakeFiles.map.set(FABRIC_SCOPE_FILE, scopeCsv([newRow({ upn: 'cara@contoso.com', type: 'org', value: 'Sales' }, by)]));
  await orgAccessCommand(again.ctx, async () => {});
  assert.deepEqual(parseScopeCsv(again.lakeFiles.map.get(FABRIC_SCOPE_FILE)).map(scopeKey), ['cara@contoso.com|org|Sales']);
  assert.match(again.ui.text(), /Using the 1 scope saved from before/);
});

test('the menu: give someone a scope adds them to the group; turning it off keeps the scopes', async () => {
  const { graph, added } = viewerGraph();
  const { ctx, config, lakeFiles } = fabricInstall({
    graph,
    // add → who → what → below whom; then off → confirm.
    answers: ['add', 'Dan@contoso.com', 'hierarchy', 'eve@contoso.com', 'off', true],
  });
  lakeFiles.map.set(FABRIC_SCOPE_FILE, scopeCsv(seedRows(['ana@contoso.com'], by)));
  /** @type {any} */ (config.access).rls.applied = ['ds-vl'];
  let redeployed = 0;

  await orgAccessCommand(ctx, async () => {
    redeployed++;
  });

  assert.deepEqual(added, ['u-Dan@contoso.com']);
  assert.deepEqual(parseScopeCsv(lakeFiles.map.get(FABRIC_SCOPE_FILE)).map(scopeKey), ['ana@contoso.com|all|', 'dan@contoso.com|hierarchy|eve@contoso.com']);
  assert.equal(redeployed, 1);
  assert.deepEqual(config.access?.rls, { enabled: false, orgAttribute: 'department', applied: [] });
});

test('apply on Azure: writes to the landing container, applies roles in the Power BI workspace, then runs only access and refresh', async () => {
  const fabric = fakeFabric();
  const arm = fakeArm();
  const store = files();
  /** @type {string[]} */
  const accounts = [];
  const dataLake = (/** @type {string} */ account) => {
    accounts.push(account);
    return {
      readText: async (/** @type {string} */ container, /** @type {string} */ path) => store.read(`${container}/${path}`),
      writeFile: async (/** @type {string} */ container, /** @type {string} */ path, /** @type {Uint8Array} */ bytes) => store.write(`${container}/${path}`, bytes),
    };
  };
  const { ctx, config } = fakeCtx({ fabric: fabric.api, arm: arm.api, dataLake, powerBi: fakePowerBi().api });
  config.target = 'azure';
  config.azure = /** @type {any} */ ({
    subscriptionId: 'sub-1',
    resourceGroup: 'rg-vl',
    outputs: { storageAccountName: 'vlensstabc', runJobName: 'vlens-run', migrateJobName: 'vlens-migrate' },
    powerBi: { workspaceId: 'pbi-ws', datasetId: 'az-vl', capacityId: 'cap-1' },
  });
  config.fabric.workspaceId = 'pbi-ws';
  config.access = /** @type {any} */ ({ ...config.access, groupId: 'g-1', rls: { enabled: true, orgAttribute: 'department', applied: [] } });
  store.map.set(`landing/${AZURE_SCOPE_FILE}`, scopeCsv(seedRows(['ana@contoso.com'], by)));
  deployedRoles(ctx).set('az-vl', builtRoles());
  fabric.jobs.push({ status: 'Completed' });

  assert.equal(await applyOrgAccess(ctx), true);

  assert.ok(accounts.every((a) => a === 'vlensstabc'));
  assert.ok(arm.calls.some((c) => c.startsWith('assignRole /subscriptions/sub-1/resourceGroups/rg-vl/providers/Microsoft.Storage/storageAccounts/vlensstabc')));
  assert.ok(store.map.has(`landing/${AZURE_ROLES_FILE}`));
  assert.ok(fabric.calls.includes('createNotebook AnalyticsHub_Access_Scope'));
  assert.equal(config.azure?.powerBi?.accessNotebookId, 'notebook-1');
  const [params] = notebookRuns(fabric.calls);
  assert.equal(params.MODE.value, 'membership');
  assert.equal(params.ROLES_FILE.value, 'abfss://landing@vlensstabc.dfs.core.windows.net/access/roles.json');
  assert.equal(params.WORKSPACE_ID.value, 'pbi-ws');
  assert.ok(arm.calls.includes('startJob vlens-run'));
  assert.deepEqual(arm.jobTemplates[0].containers[0].args, ['run', '--steps', 'access,refresh']);
  assert.deepEqual(config.access?.rls?.applied, ['az-vl']);
  assert.ok(config.azure?.status?.lastAccess);
});
