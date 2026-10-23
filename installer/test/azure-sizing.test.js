// @ts-check
// Sizing the Azure path for a large tenant: the Power BI capacity it recommends, and the paid Azure SQL and
// always-on web app it offers. Smaller tenants see no change, --yes never opts into extra spend, and Repair or
// change keeps what an install chose. Expectations come from the constants, so changing the recommended size
// after the Azure speed test stays a one-line change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { azureDeployment, azurePlanReview, capacityUnits, confirmAzurePlan, largeAzureTenant, planAzure, plannedSql } from '../src/steps/azure/index.js';
import { AZURE_LARGE_TENANT_SKU, AZURE_LARGE_TENANT_SQL_VCORES, COPILOT_PLAN, LARGE_TENANT_SEATS } from '../src/seats.js';
import { createUi } from '../src/ui.js';
import { armEvaluator, RUNTIME_FUNCTIONS, validateArmTemplate } from './arm-expressions.js';
import { fakeArm, fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError } from './fakes.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8'));
const SCOPE = { subscriptionId: '11111111-1111-1111-1111-111111111111', resourceGroup: 'rg-analytics-hub' };
const PRE = { subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], canConsent: true, canCreateApps: true, capacities: [], tenantSettings: [] };
const SQL = 'Azure SQL compute';
const WEB = 'Web app';
const CAPACITY = 'Capacity for the Power BI workspace';
const SKU = AZURE_LARGE_TENANT_SKU;
const VCORES = AZURE_LARGE_TENANT_SQL_VCORES;
/** What a tenant up to 10,000 seats deploys, as before large tenants were sized. */
const SMALL = { sqlMinCapacity: '0.5', sqlMaxCapacity: 2, sqlAutoPauseDelayMinutes: 60, sqlUseFreeLimit: true, sqlFreeLimitExhaustionBehavior: 'AutoPause', webMinReplicas: 0 };
const SIZED_UP = { ...SMALL, sqlMaxCapacity: VCORES, sqlFreeLimitExhaustionBehavior: 'BillOverUsage', webMinReplicas: 1 };
const SHARED_WARNING = /on shared capacity, where a semantic model is limited to 1 GB/;
/** An install that has deployed, as Repair or change finds it. */
const DEPLOYED = {
  subscriptionId: 'sub-1', resourceGroup: 'rg-analytics-hub', resourceGroupMode: 'existing', location: 'uksouth', namePrefix: 'vlens', tags: {},
  outputs: { sqlServerFqdn: 'vlens-sql.database.windows.net', sqlDatabaseName: 'valuelens' },
};

/** @param {string} id @param {string} sku */
const cap = (id, sku) => ({ id, displayName: sku, sku, region: 'UK South', state: 'Active' });
/** @param {number} capacity @param {any} properties */
const liveDb = (capacity, properties) => ({ sku: { capacity }, properties: { minCapacity: 0.5, autoPauseDelay: 60, ...properties } });
/** @param {any} r */
const list = (r) => (Array.isArray(r) ? r : Object.values(r ?? {}));

/**
 * A context for planAzure whose selects are recorded and can be answered by question. With `yes`, the sizing
 * questions are answered the way an unattended --yes run answers them.
 * @param {{ answers?: Record<string, any>, yes?: boolean, capacities?: any[], groups?: any[], workspaceCapacities?: Record<string, string>, workspaceUnreadable?: boolean, azure?: any, sqlDatabase?: any }} [o]
 */
function planCtx(o = {}) {
  const arm = fakeArm();
  const fabric = fakeFabric();
  const powerBi = fakePowerBi();
  const u = fakeUi();
  /** @type {Record<string, { choices: any[], def: any }>} */
  const selects = {};
  const select = u.ui.select;
  const unattended = createUi({ yes: true, write: () => {} });
  u.ui.select = async (message, choices, def) => {
    selects[message] = { choices, def };
    if (o.answers && message in o.answers) {
      u.asked.push(message);
      return o.answers[message];
    }
    if (o.yes && (message === SQL || message === WEB)) {
      u.asked.push(message);
      return unattended.select(message, choices, def);
    }
    return select(message, choices, def);
  };
  if (o.capacities) fabric.api.listCapacities = async () => /** @type {any[]} */ (o.capacities);
  if (o.groups) /** @type {any} */ (powerBi.api).groups = async () => o.groups;
  Object.assign(fabric.workspaceCapacities, o.workspaceCapacities ?? {});
  if (o.workspaceUnreadable) fabric.api.getWorkspace = async () => {
    throw httpError(403, 'Forbidden');
  };
  if (o.sqlDatabase) /** @type {any} */ (arm.api).getSqlDatabase = async () => o.sqlDatabase;
  const t = fakeCtx({ ui: u.ui, arm: arm.api, fabric: fabric.api, powerBi: powerBi.api });
  delete t.config.fabric.workspaceId;
  if (o.azure) t.config.azure = structuredClone(o.azure);
  return { ...t, u, selects, az: () => /** @type {import('../src/config.js').AzureConfig} */ (t.config.azure) };
}

/** The sizing an install deploys. @param {import('../src/install.js').Ctx} ctx */
async function sizing(ctx) {
  const p = (await azureDeployment(ctx, { pass: 1 })).properties.parameters;
  return {
    sqlMinCapacity: p.sqlMinCapacity.value, sqlMaxCapacity: p.sqlMaxCapacity.value, sqlAutoPauseDelayMinutes: p.sqlAutoPauseDelayMinutes.value,
    sqlUseFreeLimit: p.sqlUseFreeLimit.value, sqlFreeLimitExhaustionBehavior: p.sqlFreeLimitExhaustionBehavior.value, webMinReplicas: p.webMinReplicas.value,
  };
}

/** @param {import('../src/install.js').Ctx} ctx */
const costLine = (ctx) => String(azurePlanReview(ctx).runsOn.find((r) => r.what === 'Cost')?.where);

test('Azure sizing: a tenant up to 10,000 seats is asked nothing new and deploys what it did before', async () => {
  for (const seats of [undefined, 9_000, LARGE_TENANT_SEATS]) {
    const t = planCtx();
    await planAzure(t.ctx, { ...PRE, seats });
    assert.ok(!t.u.asked.includes(SQL) && !t.u.asked.includes(WEB), `${seats}: no sizing questions`);
    assert.equal(t.az().sqlScaleUp, undefined);
    assert.equal(t.az().webAlwaysOn, undefined);
    assert.equal(t.selects[CAPACITY].def, 'cap-f', 'the first capacity, as before');
    assert.ok(t.selects[CAPACITY].choices.every((c) => c.description === undefined), 'no capacity advice');
    assert.doesNotMatch(t.u.text(), /can be sized up|or larger is recommended/);
    assert.doesNotMatch(t.u.text(), SHARED_WARNING);
    assert.deepEqual(await sizing(t.ctx), SMALL);
    assert.doesNotMatch(costLine(t.ctx), /You chose/);
  }
  const shared = planCtx({ answers: { [CAPACITY]: '' } });
  await planAzure(shared.ctx, { ...PRE, seats: 2_000 });
  assert.doesNotMatch(shared.u.text(), SHARED_WARNING, 'shared capacity is fine for a small tenant');
});

test('Azure sizing: a large tenant is offered paid Azure SQL and an always-on web app, and nothing changes unless it chooses them', async () => {
  for (const yes of [false, true]) {
    const t = planCtx({ yes });
    await planAzure(t.ctx, { ...PRE, seats: 20_000 });
    assert.match(t.u.text(), /For 20,000 Copilot seats, Azure SQL and the web app can be sized up\. Both cost extra, so nothing changes unless you choose it\./);
    const sql = t.selects[SQL];
    assert.deepEqual(sql.choices.map((c) => [c.name, c.value]), [
      ['Keep the free offer, up to 2 vCores (no extra cost)', false],
      [`Scale up to ${VCORES} vCores and carry on past the free allowance (about $30-80 a month)`, true],
    ]);
    assert.match(sql.choices[0].description, /When the month's free allowance runs out, Azure pauses the database until next month, and the jobs stop until then\./);
    assert.match(sql.choices[1].description, /can't switch the database back to pausing\. An indicative list price: check https:\/\/azure\.microsoft\.com\/pricing\/calculator\/\./);
    assert.equal(sql.def, false);
    const web = t.selects[WEB];
    assert.deepEqual(web.choices.map((c) => [c.name, c.value]), [
      ['Scale to zero when idle (no extra cost)', false],
      ['Keep one replica running (about $10-20 a month)', true],
    ]);
    assert.match(web.choices[0].description, /first visit after a quiet spell waits/);
    assert.equal(web.def, false);
    assert.equal(t.az().sqlScaleUp, false, yes ? '--yes never opts into extra spend' : 'the default');
    assert.equal(t.az().webAlwaysOn, false);
    assert.deepEqual(await sizing(t.ctx), SMALL);
    assert.doesNotMatch(costLine(t.ctx), /You chose/);
  }
});

test('Azure sizing: a large tenant that opts in deploys more vCores past the free allowance and one web replica, and the plan shows the cost', async () => {
  const t = planCtx({ answers: { [SQL]: true, [WEB]: true } });
  await planAzure(t.ctx, { ...PRE, seats: 20_000 });
  assert.equal(t.az().sqlScaleUp, true);
  assert.equal(t.az().webAlwaysOn, true);
  assert.deepEqual(await sizing(t.ctx), SIZED_UP);
  assert.match(costLine(t.ctx), / You chose Azure SQL sized up \(about \$30-80\/month\) and one web app replica always running \(about \$10-20\/month\)\.$/);

  const web = planCtx({ answers: { [WEB]: true } });
  await planAzure(web.ctx, { ...PRE, seats: 20_000 });
  assert.deepEqual(await sizing(web.ctx), { ...SMALL, webMinReplicas: 1 });
  assert.match(costLine(web.ctx), / You chose one web app replica always running \(about \$10-20\/month\)\.$/);
});

test('Azure sizing: Repair or change keeps what the install chose, with or without --yes, whatever the seats now', async () => {
  const chosen = { ...DEPLOYED, outputs: {}, sqlScaleUp: true, webAlwaysOn: true };
  for (const yes of [false, true]) {
    const t = planCtx({ yes, azure: chosen });
    await planAzure(t.ctx, { ...PRE, seats: 5_000 }, 'placement');
    assert.equal(t.selects[SQL].def, true);
    assert.equal(t.selects[WEB].def, true);
    assert.equal(t.az().sqlScaleUp, true);
    assert.equal(t.az().webAlwaysOn, true);
    assert.doesNotMatch(t.u.text(), /can be sized up/, 'no longer a large tenant, so no pitch');
    assert.deepEqual(await sizing(t.ctx), SIZED_UP);
  }
  // Repair asks nothing: it deploys from the record.
  assert.deepEqual(await sizing(planCtx({ azure: chosen }).ctx), SIZED_UP);
  assert.deepEqual(await sizing(planCtx({ azure: { ...chosen, sqlScaleUp: false, webAlwaysOn: false } }).ctx), SMALL);
});

test('plannedSql: an existing database keeps its own settings, and carrying on past the free allowance sticks', () => {
  assert.deepEqual(plannedSql({}, {}), { minCapacity: '0.5', maxCapacity: 2, autoPauseDelay: 60, useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' });
  const live = { capacity: 8, minCapacity: 1, autoPauseDelay: 120, useFreeLimit: false };
  const kept = { minCapacity: '1', maxCapacity: 8, autoPauseDelay: 120, useFreeLimit: false, freeLimitExhaustionBehavior: 'AutoPause' };
  assert.deepEqual(plannedSql({}, live), kept);
  assert.deepEqual(plannedSql({ sqlScaleUp: true }, live), kept, 'never scales down a database sized up in the Azure portal');
  assert.equal(plannedSql({}, { useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' }).freeLimitExhaustionBehavior, 'BillOverUsage', 'Azure can\'t switch it back');
  assert.deepEqual(plannedSql({ sqlFreeOffer: false, sqlScaleUp: true }, {}), { minCapacity: '0.5', maxCapacity: VCORES, autoPauseDelay: 60, useFreeLimit: false, freeLimitExhaustionBehavior: 'AutoPause' }, 'no free offer to carry on past');
});

test('Azure sizing: the Azure SQL question starts from the live database', async () => {
  const seats = { ...PRE, seats: 20_000 };
  const big = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(VCORES * 2, { useFreeLimit: false }) });
  await planAzure(big.ctx, seats, 'placement');
  assert.ok(!big.u.asked.includes(SQL));
  assert.match(big.u.text(), new RegExp(`Azure SQL already scales up to ${VCORES * 2} vCores, so it stays as it is\\.`));
  assert.ok(big.u.asked.includes(WEB), 'the web app is still offered');
  assert.equal((await sizing(big.ctx)).sqlMaxCapacity, VCORES * 2);

  const billed = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(VCORES, { useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' }) });
  await planAzure(billed.ctx, seats, 'placement');
  assert.ok(!billed.u.asked.includes(SQL));
  assert.match(billed.u.text(), new RegExp(`Azure SQL already scales up to ${VCORES} vCores and carries on past the free offer's monthly allowance, so it stays as it is\\.`));

  const paid = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(2, { useFreeLimit: false }) });
  await planAzure(paid.ctx, seats, 'placement');
  const offered = paid.selects[SQL].choices;
  assert.deepEqual(offered.map((c) => c.name), ['Keep up to 2 vCores (no extra cost)', `Scale up to ${VCORES} vCores (about $30-80 a month)`]);
  assert.equal(offered[0].description, 'Large loads take longer.');
  assert.doesNotMatch(offered[1].description, /free allowance/);

  const free = planCtx({ azure: DEPLOYED, sqlDatabase: liveDb(VCORES, { useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' }), answers: { [SQL]: true } });
  await planAzure(free.ctx, seats, 'placement');
  assert.deepEqual(free.selects[SQL].choices.map((c) => c.name), [`Keep the free offer, up to ${VCORES} vCores (no extra cost)`, 'Carry on past the free allowance (about $30-80 a month)']);
  const s = await sizing(free.ctx);
  assert.deepEqual([s.sqlMaxCapacity, s.sqlUseFreeLimit, s.sqlFreeLimitExhaustionBehavior], [VCORES, true, 'BillOverUsage']);
});

test('Azure sizing: demo mode on a large tenant asks nothing new and warns about nothing', async () => {
  const t = planCtx({ azure: { sampleData: true }, capacities: [] });
  await planAzure(t.ctx, { ...PRE, seats: 20_000 });
  assert.ok(!t.u.asked.includes(SQL) && !t.u.asked.includes(WEB));
  assert.doesNotMatch(t.u.text(), /can be sized up|or larger is recommended/);
  assert.doesNotMatch(t.u.text(), SHARED_WARNING);
  assert.deepEqual(await sizing(t.ctx), SMALL);
});

test(`Azure sizing: a large tenant is pointed at ${SKU} or larger for the Power BI workspace`, async () => {
  const units = /** @type {number} */ (capacityUnits(SKU));
  const caps = [cap('cap-small', 'F2'), cap('cap-ppu', 'PP3'), cap('cap-rec', SKU), cap('cap-bigger', `F${units * 2}`)];
  const large = planCtx({ capacities: caps });
  await planAzure(large.ctx, { ...PRE, seats: 20_000 });
  assert.match(large.u.text(), new RegExp(`${SKU} or larger is recommended for 20,000 Copilot seats\\.`));
  const offered = large.selects[CAPACITY];
  assert.equal(offered.def, 'cap-rec', 'the first capacity big enough');
  assert.deepEqual(offered.choices.map((c) => [c.value, c.description]), [
    ['cap-small', `Below the recommended ${SKU} for a tenant this size.`],
    ['cap-ppu', undefined],
    ['cap-rec', undefined],
    ['cap-bigger', undefined],
    ['', 'Not recommended for a tenant this size: a semantic model there is limited to 1 GB.'],
  ]);
  assert.equal(large.az().powerBi?.capacityId, 'cap-rec');
  assert.doesNotMatch(large.u.text(), SHARED_WARNING);

  const small = planCtx({ capacities: caps });
  await planAzure(small.ctx, { ...PRE, seats: 2_000 });
  assert.equal(small.selects[CAPACITY].def, 'cap-small', 'smaller tenants keep the first capacity');

  const none = planCtx({ capacities: [cap('cap-small', 'F2'), cap('cap-ppu', 'PP3')] });
  await planAzure(none.ctx, { ...PRE, seats: 20_000 });
  assert.equal(none.selects[CAPACITY].def, 'cap-small', 'nothing big enough: the first, as before');

  const kept = planCtx({ capacities: caps, azure: { powerBi: { capacityId: 'cap-small' } } });
  await planAzure(kept.ctx, { ...PRE, seats: 20_000 });
  assert.equal(kept.selects[CAPACITY].def, 'cap-small', 'Repair or change keeps the capacity chosen');

  const shared = planCtx({ capacities: [] });
  await planAzure(shared.ctx, { ...PRE, seats: 20_000 });
  assert.equal(shared.selects[CAPACITY].def, '');
  assert.match(shared.u.text(), new RegExp(`20,000 Copilot seats are assigned and the Power BI workspace is on shared capacity, where a semantic model is limited to 1 GB\\. In Power BI, choose a Fabric capacity of ${SKU} or larger \\(or its Premium equivalent\\)`));
});

test('Azure sizing: a large tenant is warned when the semantic model would sit on shared capacity', async () => {
  const groups = [{ id: 'grp-1', name: 'Analytics' }];
  /** @param {Parameters<typeof planCtx>[0]} o @param {number} [seats] */
  const warned = async (o, seats = 20_000) => {
    const t = planCtx({ groups, ...o });
    await planAzure(t.ctx, { ...PRE, seats });
    return SHARED_WARNING.test(t.u.text());
  };
  assert.equal(await warned({ answers: { [CAPACITY]: '' } }), true, 'a new workspace with no capacity');
  assert.equal(await warned({ answers: { [CAPACITY]: '', 'Power BI workspace': 'grp-1' } }), true, 'an existing workspace on shared capacity');
  assert.equal(await warned({ answers: { [CAPACITY]: '', 'Power BI workspace': 'grp-1' }, workspaceCapacities: { 'grp-1': 'cap-x' } }), false, 'an existing workspace on its own capacity');
  assert.equal(await warned({ answers: { [CAPACITY]: '', 'Power BI workspace': 'grp-1' }, workspaceUnreadable: true }), false, 'can\'t tell, so no warning');
  assert.equal(await warned({}), false, 'a capacity chosen');
  assert.equal(await warned({ answers: { [CAPACITY]: '' } }, 9_000), false, 'a smaller tenant');
});

test('capacityUnits: F, trial, P, A and EM SKUs in Fabric capacity units, and nothing for a SKU without a known size', () => {
  const table = { F2: 2, F64: 64, f128: 128, FTL64: 64, FTL4: 4, P1: 64, P2: 128, P3: 256, A1: 8, A4: 64, EM1: 8, EM3: 32 };
  for (const [sku, units] of Object.entries(table)) assert.equal(capacityUnits(sku), units, sku);
  for (const sku of ['PP3', 'FT1', 'P0', 'X64', '', undefined]) assert.equal(capacityUnits(sku), undefined, String(sku));
  assert.ok((capacityUnits(SKU) ?? 0) > 0, 'the recommended SKU has a known size');
});

test('largeAzureTenant: more than 10,000 seats, collecting tenant data', () => {
  assert.equal(largeAzureTenant({}, LARGE_TENANT_SEATS), false);
  assert.equal(largeAzureTenant({}, LARGE_TENANT_SEATS + 1), true);
  assert.equal(largeAzureTenant(undefined, 20_000), true);
  assert.equal(largeAzureTenant({ sampleData: true }, 20_000), false);
  assert.equal(largeAzureTenant({}, undefined), false);
});

/** @param {any} [more] */
async function installerParameters(more = {}) {
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: SCOPE.subscriptionId, resourceGroup: SCOPE.resourceGroup, location: 'uksouth', namePrefix: 'vlens', installId: '7d1c0f3e-2a55-4f7b-9a0e-3c1d2b4e5f60', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, ...more };
  return (await azureDeployment(ctx, { pass: 1 })).properties.parameters;
}

/**
 * The Azure SQL database the template creates, evaluated with the parameters the installer sends.
 * @param {Record<string, { value: any }>} params
 */
function sqlDatabase(params) {
  const outer = armEvaluator(TEMPLATE, params, SCOPE);
  const mod = list(TEMPLATE.resources).find((r) => r.name === 'vl-sql');
  // Values only known while deploying, such as the managed identity's object id, get a stand-in.
  const inner = Object.fromEntries(Object.entries(mod.properties.parameters).map(([k, v]) => [k, RUNTIME_FUNCTIONS.test(JSON.stringify(v)) ? { value: 'runtime' } : outer.evalValue(v)]));
  const db = list(mod.properties.template.resources).find((r) => r.type === 'Microsoft.Sql/servers/databases');
  const ev = armEvaluator(mod.properties.template, inner, SCOPE);
  const props = ev.evalValue(db.properties);
  return { capacity: ev.evalValue(db.sku).capacity, minCapacity: props.minCapacity, autoPauseDelay: props.autoPauseDelay, useFreeLimit: props.useFreeLimit, freeLimitExhaustionBehavior: props.freeLimitExhaustionBehavior };
}

test('the template creates the Azure SQL database and web app the installer plans, sized up or not', async () => {
  const declared = TEMPLATE.parameters.sqlFreeLimitExhaustionBehavior;
  assert.deepEqual([declared.defaultValue, declared.allowedValues], ['AutoPause', ['AutoPause', 'BillOverUsage']]);
  const apps = list(TEMPLATE.resources).find((r) => r.name === 'vl-containerapps');

  const small = await installerParameters();
  assert.deepEqual(validateArmTemplate(TEMPLATE, small, SCOPE).errors, []);
  assert.deepEqual(sqlDatabase(small), { capacity: 2, minCapacity: 0.5, autoPauseDelay: 60, useFreeLimit: true, freeLimitExhaustionBehavior: 'AutoPause' });
  assert.deepEqual(armEvaluator(TEMPLATE, small, SCOPE).evalValue(apps.properties.parameters.webMinReplicas), { value: 0 });

  const sized = await installerParameters({ sqlScaleUp: true, webAlwaysOn: true });
  assert.deepEqual(validateArmTemplate(TEMPLATE, sized, SCOPE).errors, []);
  assert.deepEqual(sqlDatabase(sized), { capacity: VCORES, minCapacity: 0.5, autoPauseDelay: 60, useFreeLimit: true, freeLimitExhaustionBehavior: 'BillOverUsage' });
  assert.deepEqual(armEvaluator(TEMPLATE, sized, SCOPE).evalValue(apps.properties.parameters.webMinReplicas), { value: 1 });

  const paid = await installerParameters({ sqlFreeOffer: false, sqlScaleUp: true });
  assert.deepEqual(validateArmTemplate(TEMPLATE, paid, SCOPE).errors, []);
  assert.deepEqual(sqlDatabase(paid), { capacity: VCORES, minCapacity: 0.5, autoPauseDelay: 60, useFreeLimit: false, freeLimitExhaustionBehavior: null });
  for (const p of [small, sized, paid]) assert.ok(declared.allowedValues.includes(p.sqlFreeLimitExhaustionBehavior.value));
});

test('confirmAzurePlan: shows what a large tenant chose to pay for, and drops the warnings that choice answers', async () => {
  const graph = { subscribedSkus: async () => [{ skuPartNumber: 'Microsoft_365_Copilot', consumedUnits: 20_000, servicePlans: [{ servicePlanName: COPILOT_PLAN }] }] };
  /** @param {any} more */
  const plan = async (more) => {
    const u = fakeUi({ answers: [true] });
    const t = fakeCtx({ ui: u.ui, graph, fabric: fakeFabric().api });
    t.config.target = 'azure';
    t.config.azure = { subscriptionId: 'sub-1', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', powerBi: { capacityId: 'cap-f' }, ...more };
    assert.equal(await confirmAzurePlan(t.ctx), true);
    assert.equal(u.asked.at(-1), 'Go ahead?');
    return u.text();
  };
  const declined = await plan({ sqlScaleUp: false, webAlwaysOn: false });
  assert.doesNotMatch(declined, /SQL compute: |Web app: {5}one replica/);
  assert.match(declined, /20,000 Copilot seats are assigned and Azure SQL uses the free offer/);
  assert.doesNotMatch(declined, SHARED_WARNING);

  const chosen = await plan({ sqlScaleUp: true, webAlwaysOn: true });
  assert.match(chosen, new RegExp(`SQL compute: up to ${VCORES} vCores, carrying on past the free offer \\(about \\$30-80 a month\\)`));
  assert.match(chosen, /Web app: {5}one replica always running \(about \$10-20 a month\)/);
  assert.doesNotMatch(chosen, /Azure SQL uses the free offer/);

  assert.match(await plan({ powerBi: {} }), SHARED_WARNING, 'no capacity and a new workspace');
});
