// @ts-check
// Regression tests for the compiled Azure template (src/azure/main.arm.json). The CI arm-drift job
// only proves the JSON matches the Bicep source, and the installer tests only check parameter names
// and types; neither evaluates the template, so 0.3.1 shipped a template ARM rejects for every
// default install ("array index '2' is out of bounds" from split('')[2] in a dependsOn). These tests
// evaluate what ARM evaluates at validation time, with the parameters the installer really sends.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { azureDeployment } from '../src/steps/azure/index.js';
import { validateArmTemplate } from './arm-expressions.js';
import { fakeCtx } from './fakes.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8'));
const SCOPE = { subscriptionId: '11111111-1111-1111-1111-111111111111', resourceGroup: 'rg-analytics-hub' };

/** @param {(az: any) => void} [tweak] @param {1 | 2} [pass] */
async function installerParameters(tweak, pass = 1) {
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: SCOPE.subscriptionId, resourceGroup: SCOPE.resourceGroup, location: 'uksouth', namePrefix: 'vlens', installId: '7d1c0f3e-2a55-4f7b-9a0e-3c1d2b4e5f60', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  tweak?.(config.azure);
  return (await azureDeployment(ctx, { pass })).properties.parameters;
}

const byName = (/** @type {ReturnType<typeof validateArmTemplate>} */ r, /** @type {RegExp} */ re) => r.resources.find((x) => re.test(String(x.name)));

test('the default Azure install (public ghcr.io images) passes template validation', async () => {
  for (const pass of /** @type {const} */ ([1, 2])) {
    const params = await installerParameters(undefined, pass);
    assert.equal(params.imageRegistryResourceId.value, '', 'default installs use no private registry');
    const result = validateArmTemplate(TEMPLATE, params, SCOPE);
    assert.deepEqual(result.errors, [], `pass ${pass}`);
    assert.equal(byName(result, /^vl-acrpull-/)?.deployed, false, 'no AcrPull role assignment without a private registry');
    const apps = byName(result, /^vl-containerapps$/);
    assert.ok(apps?.deployed);
    assert.ok(apps.dependsOn.every((id) => id.startsWith(`/subscriptions/${SCOPE.subscriptionId}/resourceGroups/${SCOPE.resourceGroup}/`)), apps.dependsOn.join('\n'));
  }
});

test('a private registry install deploys AcrPull into the registry resource group', async () => {
  const registryResourceId = '/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-images/providers/Microsoft.ContainerRegistry/registries/myacr';
  const params = await installerParameters((az) => (az.images = { registry: 'myacr.azurecr.io/valuelens', registryResourceId, tag: 'dev-1' }));
  const result = validateArmTemplate(TEMPLATE, params, SCOPE);
  assert.deepEqual(result.errors, []);
  const acr = byName(result, /^vl-acrpull-/);
  assert.equal(acr?.deployed, true);
  assert.equal(acr.subscriptionId, '22222222-2222-2222-2222-222222222222');
  assert.equal(acr.resourceGroup, 'rg-images');
  assert.ok(byName(result, /^vl-containerapps$/)?.dependsOn.some((id) => id.startsWith('/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-images/providers/Microsoft.Resources/deployments/vl-acrpull-')));
});

test('private networking, demo mode and a separate SQL region pass template validation', async () => {
  const params = await installerParameters((az) => Object.assign(az, { publicNetworkAccess: false, sampleData: true, sqlLocation: 'ukwest' }));
  const result = validateArmTemplate(TEMPLATE, params, SCOPE);
  assert.deepEqual(result.errors, []);
  assert.equal(byName(result, /^vl-network$/)?.deployed, true);
});

test('the template validates with only its required parameters (Deploy to Azure / az CLI)', () => {
  const required = Object.entries(TEMPLATE.parameters).filter(([, d]) => !('defaultValue' in d)).map(([n]) => n);
  assert.deepEqual(required.sort(), ['imageTag', 'installId']);
  const result = validateArmTemplate(TEMPLATE, { installId: { value: 'x' }, imageTag: { value: '1.0.0' } }, SCOPE);
  assert.deepEqual(result.errors, []);
});

test('the template check catches the 0.3.1 out-of-bounds dependsOn', () => {
  // The shape 0.3.1 shipped: an optional module scoped by indexing an empty resource id.
  const broken = {
    parameters: { registryId: { type: 'string', defaultValue: '' } },
    resources: [
      { type: 'Microsoft.Resources/deployments', name: 'acr', condition: "[not(empty(parameters('registryId')))]", subscriptionId: "[split(parameters('registryId'), '/')[2]]", resourceGroup: "[split(parameters('registryId'), '/')[4]]" },
      { type: 'Microsoft.Resources/deployments', name: 'apps', dependsOn: ["[extensionResourceId(format('/subscriptions/{0}/resourceGroups/{1}', split(parameters('registryId'), '/')[2], split(parameters('registryId'), '/')[4]), 'Microsoft.Resources/deployments', 'acr')]"] },
    ],
  };
  const { errors } = validateArmTemplate(broken, {}, SCOPE);
  assert.ok(errors.some((e) => /apps.*dependsOn.*array index '2' is out of bounds/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /acr.*subscriptionId.*out of bounds/.test(e)), 'scope fields are checked even when the condition is false');
});
