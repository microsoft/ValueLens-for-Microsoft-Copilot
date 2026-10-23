// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ROLES } from '../src/clients/azure.js';
import { HttpError } from '../src/http.js';
import { ASK_MODEL, askGrants, askLine, askModelIn, askParameters, ensureAzureAskAccess, planAzureAsk } from '../src/steps/azure/ask.js';
import { askModelMessage, azureDeployment, newResourceGroupResources } from '../src/steps/azure/index.js';
import { validateArmTemplate } from './arm-expressions.js';
import { fakeArm, fakeCtx, fakeUi } from './fakes.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8'));
const SCOPE = { subscriptionId: '11111111-1111-1111-1111-111111111111', resourceGroup: 'rg-analytics-hub' };

/** @param {{ answers?: any[], advanced?: boolean, az?: any }} [o] */
function azureCtx(o = {}) {
  const arm = fakeArm();
  const ui = fakeUi({ answers: o.answers });
  const { ctx, config } = fakeCtx({ arm: arm.api, ui: ui.ui });
  ctx.advanced = o.advanced ?? false;
  config.target = 'azure';
  config.azure = { subscriptionId: SCOPE.subscriptionId, resourceGroup: SCOPE.resourceGroup, location: 'uksouth', namePrefix: 'vlens', installId: '7d1c0f3e-2a55-4f7b-9a0e-3c1d2b4e5f60', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, ...(o.az ?? {}) };
  return { arm, ui, ctx, config, az: /** @type {import('../src/config.js').AzureConfig} */ (config.azure) };
}

test('Ask creates a model in the install region by default, without asking', async () => {
  const { ctx, ui, az } = azureCtx();
  await planAzureAsk(ctx);
  assert.deepEqual(az.ask, { mode: 'create', location: 'uksouth', sku: 'GlobalStandard', capacity: ASK_MODEL.capacity, deployment: ASK_MODEL.name });
  assert.deepEqual(ui.asked, []);
  assert.match(askLine(az), /gpt-5-mini \(GlobalStandard, 50K tokens\/min\) in uksouth/);
  assert.ok(newResourceGroupResources(az).some((r) => r.resourceType === 'Microsoft.CognitiveServices/accounts'));
  assert.equal(askGrants(az)[0].what, 'Cognitive Services OpenAI User');
});

test('Ask moves a global deployment to another region when the install region lacks the model or quota', async () => {
  const { ctx, arm, ui, az } = azureCtx();
  arm.ai.models = { uksouth: [arm.ai.offered('gpt-4o', '2024-11-20')], '*': [arm.ai.offered()] };
  await planAzureAsk(ctx);
  assert.equal(az.ask?.location, 'swedencentral');
  assert.match(ui.text(), /isn't offered as GlobalStandard in uksouth, so the Ask model's account goes in swedencentral/);

  const quota = azureCtx();
  quota.arm.ai.usages = { '*': [{ name: { value: 'OpenAI.GlobalStandard.gpt-5-mini' }, currentValue: 995, limit: 1000 }], eastus2: [{ name: { value: 'OpenAI.GlobalStandard.gpt-5-mini' }, currentValue: 970, limit: 1000 }] };
  await planAzureAsk(quota.ctx);
  assert.equal(quota.az.ask?.location, 'eastus2');
  assert.equal(quota.az.ask?.capacity, 30, 'takes what quota is free, up to the default');
});

test('Ask is left off, with a reason, when no region can host it; a data zone deployment never moves', async () => {
  const none = azureCtx();
  none.arm.ai.models = {};
  await planAzureAsk(none.ctx);
  assert.deepEqual(none.az.ask, { mode: 'off' });
  assert.match(none.ui.text(), /Ask is left off: gpt-5-mini 2025-08-07 isn't offered as GlobalStandard in uksouth/);

  const zone = azureCtx({ advanced: true, answers: ['create', 'DataZoneStandard'] });
  zone.arm.ai.models = { uksouth: [] , '*': [zone.arm.ai.offered()] };
  await planAzureAsk(zone.ctx);
  assert.deepEqual(zone.az.ask, { mode: 'off' });
  assert.ok(!zone.arm.calls.includes('listAiModels swedencentral'));
});

test('Ask on a re-run counts its own deployment as free quota', async () => {
  const { ctx, arm, az } = azureCtx({ az: { outputs: { askAccountName: 'ai-vlens-abc' }, ask: { mode: 'create', location: 'uksouth', sku: 'GlobalStandard', capacity: 50, deployment: 'gpt-5-mini' } } });
  arm.ai.usages = { '*': [{ name: { value: 'OpenAI.GlobalStandard.gpt-5-mini' }, currentValue: 1000, limit: 1000 }] };
  assert.deepEqual(await askModelIn(ctx, 'uksouth', 'GlobalStandard'), { ok: true, capacity: 50 });
  await planAzureAsk(ctx);
  assert.equal(az.ask?.location, 'uksouth');
});

test('Ask carries on when it cannot read model availability', async () => {
  const { ctx, arm, ui, az } = azureCtx();
  arm.failures.listAiModels = [new HttpError('Forbidden', { status: 403, method: 'GET', url: 'https://x' })];
  await planAzureAsk(ctx);
  assert.equal(az.ask?.mode, 'create');
  assert.match(ui.text(), /Couldn't check gpt-5-mini availability/);
});

test('Ask with an existing deployment: picked from the subscription, then the web app gets the role', async () => {
  const accountId = '/subscriptions/s/resourceGroups/ai/providers/Microsoft.CognitiveServices/accounts/team-openai';
  const { ctx, arm, az } = azureCtx({ advanced: true, answers: ['existing', accountId, 'chat'] });
  arm.ai.accounts = [{ id: accountId, name: 'team-openai', location: 'eastus2', kind: 'OpenAI', properties: { endpoint: 'https://team-openai.openai.azure.com/' } }, { id: 'x', name: 'speech', kind: 'SpeechServices' }];
  arm.ai.deployments[accountId] = [{ name: 'chat', properties: { model: { name: 'gpt-4.1-mini', version: '2025-04-14' } } }];
  await planAzureAsk(ctx);
  assert.deepEqual(az.ask, { mode: 'existing', endpoint: 'https://team-openai.openai.azure.com/', deployment: 'chat', accountId });
  const params = askParameters(ctx.config);
  assert.equal(params.askMode.value, 'existing');
  assert.equal(params.askEndpoint.value, 'https://team-openai.openai.azure.com/');
  assert.equal(params.askDeployment.value, 'chat');
  assert.equal(params.askLocation.value, '');

  az.outputs = { identityPrincipalId: 'mi-sp' };
  await ensureAzureAskAccess(ctx);
  assert.ok(arm.calls.includes(`assignRole ${accountId} ${ROLES.cognitiveServicesOpenAiUser} mi-sp ServicePrincipal`));
  assert.equal(az.ask?.granted, true);
  await ensureAzureAskAccess(ctx);
  assert.equal(arm.calls.filter((c) => c.startsWith('assignRole')).length, 1, 'the role is assigned once');
});

test('Ask with an existing deployment: an endpoint by hand, or no rights to assign the role, prints the command', async () => {
  const typed = azureCtx({ advanced: true, answers: ['existing', '', 'https://other.openai.azure.com/', 'gpt-5-mini'] });
  await planAzureAsk(typed.ctx);
  assert.deepEqual(typed.az.ask, { mode: 'existing', endpoint: 'https://other.openai.azure.com/', deployment: 'gpt-5-mini' });
  typed.az.outputs = { identityPrincipalId: 'mi-sp' };
  await ensureAzureAskAccess(typed.ctx);
  assert.match(typed.ui.text(), /az role assignment create --role "Cognitive Services OpenAI User" --assignee-object-id mi-sp/);
  assert.ok(!typed.arm.calls.some((c) => c.startsWith('assignRole')));

  const accountId = '/subscriptions/s/resourceGroups/ai/providers/Microsoft.CognitiveServices/accounts/locked';
  const denied = azureCtx({ az: { outputs: { identityPrincipalId: 'mi-sp' }, ask: { mode: 'existing', endpoint: 'https://locked.openai.azure.com/', deployment: 'chat', accountId } } });
  denied.arm.failures.assignRole = [new HttpError('Forbidden', { status: 403, method: 'PUT', url: 'https://x' })];
  await ensureAzureAskAccess(denied.ctx);
  assert.equal(denied.az.ask?.granted, undefined);
  assert.match(denied.ui.text(), new RegExp(`Ask an owner to run: az role assignment create .*--scope ${accountId}`));
});

test('Ask off, and installs from before Ask, deploy nothing for it', async () => {
  const { ctx, az } = azureCtx({ advanced: true, answers: ['off'] });
  await planAzureAsk(ctx);
  assert.deepEqual(az.ask, { mode: 'off' });
  assert.deepEqual(askGrants(az), []);
  const old = azureCtx();
  const params = (await azureDeployment(old.ctx, { pass: 1 })).properties.parameters;
  assert.equal(params.askMode.value, 'off', 'no surprise resources on update');
  assert.equal(params.askEndpoint.value, '');
  assert.match(askLine(old.az), /^Off/);
});

test('the template validates with Ask created, existing or off, and wires the web app to it', async () => {
  for (const ask of [{ mode: 'create', location: 'swedencentral', sku: 'GlobalStandard', capacity: 30, deployment: 'gpt-5-mini' }, { mode: 'existing', endpoint: 'https://team.openai.azure.com/', deployment: 'chat' }, { mode: 'off' }]) {
    const { ctx } = azureCtx({ az: { ask } });
    const params = (await azureDeployment(ctx, { pass: 2 })).properties.parameters;
    const result = validateArmTemplate(TEMPLATE, params, SCOPE);
    assert.deepEqual(result.errors, [], ask.mode);
    const module = result.resources.find((r) => r.name === 'vl-ask');
    assert.equal(module?.deployed, ask.mode === 'create', ask.mode);
  }
  const web = JSON.stringify(TEMPLATE);
  assert.match(web, /VALUELENS_ASK_ENDPOINT/);
  assert.match(web, /VALUELENS_ASK_DEPLOYMENT/);
});

test('an ARM failure deploying the Ask model points at the Ask choice', () => {
  const err = new HttpError('Deployment failed', { status: 400, method: 'PUT', url: 'https://x', body: { error: { code: 'InsufficientQuota', message: 'This operation require 50 new capacity in quota Tokens Per Minute (thousands) - gpt-5-mini GlobalStandard, which is bigger than the current available capacity 0. The current quota usage is 1000 and the quota limit is 1000 for model deployment.' } } });
  assert.match(askModelMessage(err), /point Ask at an existing deployment or leave it off/);
  assert.equal(askModelMessage(new HttpError('Nope', { status: 400, method: 'PUT', url: 'https://x', body: { error: { code: 'InvalidTemplate' } } })), '');
});
