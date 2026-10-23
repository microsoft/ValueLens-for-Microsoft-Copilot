// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { azureSizingWarnings } from '../src/steps/azure/index.js';
import { defaultScale, plan, sizingWarnings } from '../src/steps/plan.js';
import { AZURE_LARGE_TENANT_SKU, AZURE_LARGE_TENANT_SQL_VCORES, BIG_CAPACITY_SEATS, COPILOT_PLAN, copilotLicences, copilotSeats, LARGE_TENANT_SEATS, seatCount } from '../src/seats.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

/** @param {string} skuPartNumber @param {number} consumedUnits @param {string} [servicePlanName] */
const sku = (skuPartNumber, consumedUnits, servicePlanName = COPILOT_PLAN) => ({ skuPartNumber, consumedUnits, servicePlans: [{ servicePlanName }] });

test('seats: assigned Copilot seats are summed across every Copilot SKU and nothing else', () => {
  const found = copilotLicences([sku('Microsoft_365_Copilot', 25_000), sku('M365_Copilot_EDU', 1_500), sku('ENTERPRISEPACK', 90_000, 'EXCHANGE_S_ENTERPRISE')]);
  assert.deepEqual(found, { names: ['Microsoft_365_Copilot', 'M365_Copilot_EDU'], assigned: 26_500, found: true });
  assert.deepEqual(copilotLicences([]), { names: [], assigned: 0, found: false });
  assert.equal(seatCount(40_000), '40,000');
});

test('seats: a tenant whose licences can\'t be read falls back to sizing by capacity', async () => {
  const api = /** @type {any} */ ({ graph: { subscribedSkus: async () => [sku('Microsoft_365_Copilot', 32_000)] } });
  assert.equal(await copilotSeats(api), 32_000);
  assert.equal(await copilotSeats(/** @type {any} */ ({ graph: { subscribedSkus: async () => { throw new Error('403'); } } })), undefined);
  assert.equal(await copilotSeats(/** @type {any} */ ({ graph: {} })), undefined);
});

test('tenant size: more than 10,000 seats or an F64 starts a new install as large', () => {
  assert.equal(defaultScale({ sku: 'F64' }, undefined), 'large');
  assert.equal(defaultScale({ sku: 'F8' }, LARGE_TENANT_SEATS + 1), 'large');
  assert.equal(defaultScale({ sku: 'F8' }, LARGE_TENANT_SEATS), 'standard');
  assert.equal(defaultScale({ sku: 'F8' }, undefined), 'standard', 'unreadable seats fall back to the capacity');
  assert.equal(defaultScale(undefined, 40_000), 'large');
});

test('tenant size: a trial capacity counts as the F size it matches, even with few seats', () => {
  assert.equal(defaultScale({ sku: 'FTL64' }, 24), 'large');
  assert.equal(defaultScale({ sku: 'FTL4' }, 24), 'standard');
  assert.equal(defaultScale({ sku: 'FT1' }, 24), 'standard', 'a trial SKU without a size isn\'t assumed to be F64');

  assert.deepEqual(sizingWarnings({ seats: 40_000, capacity: { sku: 'FTL64' }, scale: 'large' }), []);
  const [small] = sizingWarnings({ seats: 40_000, capacity: { sku: 'FTL4', displayName: 'Trial' }, scale: 'large' });
  assert.match(small, /the capacity Trial is FTL4, below F64/);
});

test('tenant size: warnings name the step to change and allow for policy', () => {
  assert.deepEqual(sizingWarnings({ seats: undefined, capacity: { sku: 'F2' }, scale: 'standard' }), []);
  assert.deepEqual(sizingWarnings({ seats: 5_000, capacity: { sku: 'F2' }, scale: 'standard' }), []);
  assert.deepEqual(sizingWarnings({ seats: 40_000, capacity: { sku: 'F64' }, scale: 'large' }), []);

  const [small] = sizingWarnings({ seats: BIG_CAPACITY_SEATS, capacity: { sku: 'F32', displayName: 'Shared' }, scale: 'large' });
  assert.match(small, /30,000 Copilot seats are assigned and the capacity Shared is F32, below F64/);
  assert.match(small, /In Fabric placement, choose an F64 or larger capacity/);
  assert.match(small, /policy keeps you on this capacity, setup still works/);
  assert.deepEqual(sizingWarnings({ seats: BIG_CAPACITY_SEATS - 1, capacity: { sku: 'F32' }, scale: 'large' }), [], 'below 30,000 an F32 is fine');

  const both = sizingWarnings({ seats: 40_000, capacity: { sku: 'F8' }, scale: 'standard' });
  assert.equal(both.length, 2);
  assert.match(both[1], /tenant size is "Up to 10,000". In Fabric placement .*choose "More than 10,000"/);
  for (const w of both) assert.doesNotMatch(w, / {2}/);
});

test('plan: a new install with 40,000 seats on an F8 is sized large and warned about the capacity', async () => {
  const t = fakeUi();
  const { ctx, config } = fakeCtx({ ui: t.ui, fabric: fakeFabric().api });
  delete config.scale;
  const pre = /** @type {any} */ ({
    subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
    canConsent: true,
    canCreateApps: true,
    capacities: [{ id: 'cap-1', displayName: 'Small', sku: 'F8', region: 'UK South', state: 'Active' }],
    tenantSettings: [],
    seats: 40_000,
  });
  await plan(ctx, pre);
  assert.equal(config.scale, 'large');
  assert.match(t.text(), /40,000 Copilot seats are assigned and the capacity Small is F8, below F64/);
  assert.doesNotMatch(t.text(), /tenant size is "Up to 10,000"/);
});

test('plan: an existing install keeps the size it saved, and is told to change it when the seats outgrow it', async () => {
  const t = fakeUi();
  const { ctx, config } = fakeCtx({ ui: t.ui, fabric: fakeFabric().api });
  config.scale = 'standard';
  const pre = /** @type {any} */ ({
    subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
    canConsent: true,
    canCreateApps: true,
    capacities: [{ id: 'cap-1', displayName: 'Big', sku: 'F64', region: 'UK South', state: 'Active' }],
    tenantSettings: [],
    seats: 12_000,
  });
  await plan(ctx, pre);
  assert.equal(config.scale, 'standard', 'never changed behind the admin\'s back');
  assert.match(t.text(), /12,000 Copilot seats are assigned, but the tenant size is "Up to 10,000"/);
});

test('azure sizing: a large tenant is warned about the SQL free limit, vCores, job size and shared Power BI', () => {
  const base = { seats: 40_000, sqlFreeLimit: true, sqlMaxVcores: 2, powerBiCapacityId: undefined };
  const all = azureSizingWarnings(base);
  assert.equal(all.length, 4);
  assert.match(all[0], /free offer.*Azure placement, choose to carry on past the free allowance \(about \$30-80 a month\).*Compute \+ storage.*continue using it for additional charges.*policy keeps the free limit/);
  const vcores = AZURE_LARGE_TENANT_SQL_VCORES;
  assert.match(all[1], new RegExp(`scales up to 2 vCores.*Azure placement, choose to scale it up to ${vcores} vCores.*max vCores to ${vcores} or more`));
  assert.match(all[2], /4 vCPU and 8 GiB and up to 4 hours.*the next run carries on reading the audit log from where it stopped.*Schedule and loading, start with 30 days/);
  assert.match(all[3], new RegExp(`shared capacity.*1 GB.*In Power BI, choose a Fabric capacity of ${AZURE_LARGE_TENANT_SKU} or larger \\(or its Premium equivalent\\)`));

  assert.deepEqual(azureSizingWarnings({ ...base, sqlFreeLimit: false, sqlMaxVcores: 8, powerBiCapacityId: 'cap-1', seats: 20_000 }), []);
  assert.equal(azureSizingWarnings({ ...base, seats: 20_000 }).length, 2, 'from 10,000 seats: the free limit and shared capacity only');
  assert.deepEqual(azureSizingWarnings({ ...base, seats: 9_000 }), []);
  assert.deepEqual(azureSizingWarnings({ ...base, sampleData: true }), [], 'demo data is small');
  assert.deepEqual(azureSizingWarnings({ ...base, seats: undefined }), []);
  assert.equal(azureSizingWarnings({ ...base, seats: 20_000, sharedCapacity: false }).length, 1, 'an existing workspace on its own capacity is not shared');
  assert.equal(azureSizingWarnings({ ...base, seats: 20_000, powerBiCapacityId: 'cap-1', sharedCapacity: true }).length, 2);
});
