// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAdvanced, asksAdvanced } from '../src/steps/advanced.js';
import { planAzure } from '../src/steps/azure/index.js';
import { capacityLabel, defaultsToNoVault, plan } from '../src/steps/plan.js';
import { planResourceGraph } from '../src/steps/resource-graph.js';
import { fakeArm, fakeCtx, fakeFabric, fakePowerBi, fakeUi } from './fakes.js';

const PRE = /** @type {any} */ ({
  subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }],
  canConsent: true,
  canCreateApps: true,
  capacities: [{ id: 'cap-1', displayName: 'F64', sku: 'F64', region: 'UK South', state: 'Active' }],
  tenantSettings: [],
});

/** The questions behind Advanced settings, which a default install doesn't ask. */
const ADVANCED_QUESTIONS = [
  'Deploy the semantic model?',
  'Who can view Analytics Hub?',
  'Who should people ask for access? (email)',
  'How much audit history should the first load pull?',
  'How many people are in the tenant?',
  'Lakehouse name',
  'How often should the pipeline run?',
  'Run the first load as soon as setup finishes?',
  'Which currency should the Value page report in?',
];

test('advanced: one question, No by default, and asked about outside the plan', async () => {
  const { ui, asked, text } = fakeUi();
  const { ctx } = fakeCtx({ ui });
  assert.equal(asksAdvanced(ctx), true, 'commands with no Advanced question still ask');
  await askAdvanced(ctx, 'the schedule');
  assert.deepEqual(asked, ['Change the advanced settings?']);
  assert.match(text(), /Choose Yes to change the schedule/);
  assert.equal(ctx.advanced, false);
  assert.equal(asksAdvanced(ctx), false);

  const yes = fakeCtx({ ui: fakeUi({ answers: [true] }).ui });
  await askAdvanced(yes.ctx, 'x');
  assert.equal(asksAdvanced(yes.ctx), true);

  const quiet = fakeCtx({ ui: fakeUi({ yes: true }).ui });
  await askAdvanced(quiet.ctx, 'x');
  assert.equal(quiet.ctx.advanced, false, '--yes takes the defaults');
});

test('advanced: a Fabric plan with No asks only the essentials and keeps the defaults', async () => {
  const { ui, asked } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api });
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE);
  assert.ok(asked.includes('Change the advanced settings?'));
  assert.ok(asked.includes('Which capacity should run it?'));
  for (const q of ADVANCED_QUESTIONS) assert.ok(!asked.some((a) => a.startsWith(q)), `didn't ask "${q}"`);
  assert.equal(config.reporting, undefined, 'the Value page stays in US dollars');
  assert.equal(config.history.days, 30);
  assert.equal(config.scale, 'large', 'from the F64');
  assert.equal(config.fabric.lakehouseName, 'Analytics_Hub', 'a new install suggests the new name');
  assert.equal(config.schedule.frequency, 'daily');
  assert.equal(ctx.runFirstLoad, true);
  assert.equal(config.access?.groupName, 'Analytics Hub Viewers');
});

test('plan: a new install suggests Analytics Hub names and says what capacity size suits', async () => {
  const t = fakeUi();
  const fabric = fakeFabric().api;
  const { ctx, config } = fakeCtx({ ui: t.ui, fabric: { ...fabric, listWorkspaces: async () => [{ id: 'ws-x', type: 'Workspace', displayName: 'Other' }] } });
    delete config.fabric.workspaceId;
    delete config.fabric.workspaceName;
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE);
  assert.equal(config.fabric.workspaceName, 'Analytics Hub');
  assert.equal(config.fabric.lakehouseName, 'Analytics_Hub');
  assert.match(t.text(), /F64 or larger is recommended for more than 10,000 people; small or trial capacities work but loads are slower\./);
});

test('plan: an existing record keeps its names', async () => {
  const { ui } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api });
  delete config.fabric.lakehouseId;
  config.fabric.lakehouseName = 'ValueLens';
  await plan(ctx, PRE);
  assert.equal(config.fabric.lakehouseName, 'ValueLens');
});

test('plan: a new Fabric install keeps the secret in the notebooks by default; Key Vault is a choice', async () => {
  const fresh = (/** @type {any} */ u, /** @type {any} */ extra = {}) => {
    const t = fakeCtx({ ui: u.ui, fabric: fakeFabric().api, arm: fakeArm().api, ...extra });
    t.config.keyVault = { secretName: 'valuelens-client-secret' };
    return t;
  };
  const u = fakeUi();
  const t = fresh(u);
  assert.equal(defaultsToNoVault(t.ctx), true);
  await plan(t.ctx, PRE);
  assert.equal(t.config.keyVault.mode, 'notebook');
  assert.ok(u.asked.includes('Where should the app\'s client secret go?'));
  assert.ok(u.asked.includes('Keep the client secret in the notebooks, with no Key Vault?'));
  assert.ok(!u.asked.includes('Azure subscription'));
  assert.match(u.text(), /Anyone with a role in the workspace, Viewer included/);

  const quiet = fresh(fakeUi({ yes: true }));
  await plan(quiet.ctx, PRE);
  assert.equal(quiet.config.keyVault.mode, 'notebook', '--yes takes the default');

  const v = fakeUi();
  const select = v.ui.select;
  v.ui.select = /** @type {any} */ (async (/** @type {string} */ m, /** @type {any[]} */ ch, /** @type {any} */ d) => (m === 'Where should the app\'s client secret go?' ? (v.asked.push(m), 'keyvault') : select(m, ch, d)));
  const kv = fresh(v);
  await plan(kv.ctx, PRE).catch(() => {});
  assert.ok(v.asked.includes('Azure subscription'), 'Key Vault goes to the vault questions');
  assert.notEqual(kv.config.keyVault.mode, 'notebook');

  // --key-vault, flows that read the secret from the vault, or a vault already chosen skip the default.
  const flagged = fresh(fakeUi());
  flagged.ctx.useKeyVault = true;
  assert.equal(defaultsToNoVault(flagged.ctx), false);
  const flows = fresh(fakeUi());
  flows.config.uploads.flowIdentity = 'app';
  assert.equal(defaultsToNoVault(flows.ctx), false);
  const chosen = fresh(fakeUi());
  chosen.config.keyVault.name = 'kv-test';
  assert.equal(defaultsToNoVault(chosen.ctx), false);
  const azure = fresh(fakeUi());
  azure.config.target = 'azure';
  assert.equal(defaultsToNoVault(azure.ctx), false);
});

test('capacityLabel: the SKU and region when Fabric gives them', () => {
  assert.equal(capacityLabel({ id: 'c', displayName: 'Prod', sku: 'F64', region: 'UK South' }), 'Prod (F64, UK South)');
  assert.equal(capacityLabel({ id: 'c', displayName: 'Trial', sku: 'FT1' }), 'Trial (FT1)');
  assert.equal(capacityLabel({ id: 'c', displayName: 'Bare' }), 'Bare');
});

test('advanced: a Fabric plan with Yes asks the settings behind it, currency last', async () => {
  const { ui, asked } = fakeUi({ yesTo: ['Change the advanced settings?'] });
  const { ctx, config } = fakeCtx({ ui, fabric: fakeFabric().api });
  delete config.fabric.lakehouseId;
  delete config.fabric.lakehouseName;
  await plan(ctx, PRE);
  for (const q of ADVANCED_QUESTIONS) assert.ok(asked.some((a) => a.startsWith(q)), `asked "${q}"`);
  assert.ok(asked.at(-1)?.startsWith('Which currency'));
  assert.deepEqual(config.reporting, { currency: 'USD' });
});

test('advanced: Resource Graph reads the saved scope, or the whole tenant, without asking', async () => {
  const { ui, asked } = fakeUi();
  const { ctx, config } = fakeCtx({ ui });
  config.dataSources.resourceGraph = 'api';
  ctx.advanced = false;
  await planResourceGraph(ctx);
  assert.deepEqual(asked, []);
  assert.deepEqual(config.resourceGraph, { managementGroup: '', agents: true, foundry: true });

  config.resourceGraph = { managementGroup: 'mg-1', agents: true, foundry: false };
  await planResourceGraph(ctx);
  assert.deepEqual(config.resourceGraph, { managementGroup: 'mg-1', agents: true, foundry: false });
});

/** The Azure questions behind Advanced settings. */
const AZURE_ADVANCED = [
  'Which data should the dashboard show?',
  'Azure SQL region',
  'Name prefix',
  'Extra tags (key=value, comma-separated)',
  'Networking',
  'Who can view Analytics Hub?',
  'How much audit history should the first load pull?',
  'How often should the job run?',
  'Run the first load as soon as setup finishes?',
  'Which currency should the Value page report in?',
  'Workday org data?',
];

/** @param {{ ui: import('../src/ui.js').Ui }} u */
function azureCtx(u) {
  const t = fakeCtx({ ui: u.ui, arm: fakeArm().api, fabric: fakeFabric().api, powerBi: fakePowerBi().api });
  delete t.config.fabric.workspaceId;
  return t;
}

test('advanced: an Azure plan with No asks only the essentials and keeps the defaults', async () => {
  const u = fakeUi();
  const { ctx, config } = azureCtx(u);
  await planAzure(ctx, PRE);
  assert.ok(u.asked.includes('Change the advanced settings?'));
  assert.ok(u.asked.includes('Azure subscription'));
  assert.ok(u.asked.includes('Azure region'));
  for (const q of AZURE_ADVANCED) assert.ok(!u.asked.includes(q), `didn't ask "${q}"`);
  const az = /** @type {import('../src/config.js').AzureConfig} */ (config.azure);
  assert.equal(az.sampleData, false);
  assert.equal(az.namePrefix, 'vlens');
  assert.deepEqual(az.tags, {});
  assert.equal(az.publicNetworkAccess, true);
  assert.equal(az.sqlLocation, undefined);
  assert.equal(config.schedule.timeZone, 'UTC');
  assert.equal(config.reporting, undefined);
  assert.equal(ctx.runFirstLoad, true);
});

test('advanced: an Azure plan with Yes asks the settings behind it', async () => {
  const u = fakeUi({ yesTo: ['Change the advanced settings?'] });
  const { ctx } = azureCtx(u);
  await planAzure(ctx, PRE);
  for (const q of AZURE_ADVANCED) assert.ok(u.asked.includes(q), `asked "${q}"`);
});
