// @ts-check
// Regression tests for the compiled Azure template (src/azure/main.arm.json). The CI arm-drift job
// only proves the JSON matches the Bicep source, and the installer tests only check parameter names
// and types; neither evaluates the template, so 0.3.1 shipped a template ARM rejects for every
// default install ("array index '2' is out of bounds" from split('')[2] in a dependsOn). These tests
// evaluate what ARM evaluates at validation time, with the parameters the installer really sends.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { azureDeployment, declaredDnsZones } from '../src/steps/azure/index.js';
import { armEvaluator, RUNTIME_FUNCTIONS, validateArmTemplate } from './arm-expressions.js';
import { fakeCtx } from './fakes.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('../src/azure/main.arm.json', import.meta.url), 'utf8'));
const SCOPE = { subscriptionId: '11111111-1111-1111-1111-111111111111', resourceGroup: 'rg-analytics-hub' };

/** @param {(az: any, config: any) => void} [tweak] @param {1 | 2} [pass] */
async function installerParameters(tweak, pass = 1) {
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: SCOPE.subscriptionId, resourceGroup: SCOPE.resourceGroup, location: 'uksouth', namePrefix: 'vlens', installId: '7d1c0f3e-2a55-4f7b-9a0e-3c1d2b4e5f60', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  tweak?.(config.azure, config);
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
  assert.equal(byName(result, /^vl-dnslinks-/)?.deployed, false, 'the default creates its own private DNS zones');
});

test('private networking with Ask and existing private DNS zones links the VNet in the zones resource group', async () => {
  const resourceGroupId = '/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-hub-dns';
  const params = await installerParameters((az) => Object.assign(az, { publicNetworkAccess: false, ask: { mode: 'create' }, privateDns: { mode: 'existing', resourceGroupId } }));
  assert.equal(params.privateDnsZoneMode.value, 'existing');
  assert.equal(params.privateDnsZonesResourceGroupId.value, resourceGroupId);
  const result = validateArmTemplate(TEMPLATE, params, SCOPE);
  assert.deepEqual(result.errors, []);
  const links = byName(result, /^vl-dnslinks-/);
  assert.equal(links?.deployed, true);
  assert.equal(links.subscriptionId, '33333333-3333-3333-3333-333333333333');
  assert.equal(links.resourceGroup, 'rg-hub-dns');
  assert.equal(byName(result, /^vl-ask$/)?.deployed, true);
});

test('private networking can leave private DNS to Azure Policy', async () => {
  const params = await installerParameters((az) => Object.assign(az, { publicNetworkAccess: false, privateDns: { mode: 'none', resourceGroupId: '/subscriptions/x/resourceGroups/ignored' } }));
  assert.equal(params.privateDnsZoneMode.value, 'none');
  assert.equal(params.privateDnsZonesResourceGroupId.value, '');
  const result = validateArmTemplate(TEMPLATE, params, SCOPE);
  assert.deepEqual(result.errors, []);
  assert.equal(byName(result, /^vl-dnslinks-/)?.deployed, false);
});

test('the private network module locks down every subnet and follows the DNS zone mode', () => {
  const network = TEMPLATE.resources.find((/** @type {any} */ r) => r.name === 'vl-network').properties.template;
  const vnet = Object.values(network.resources).find((/** @type {any} */ r) => r.type === 'Microsoft.Network/virtualNetworks');
  assert.ok(vnet.properties.subnets.every((/** @type {any} */ s) => s.properties.networkSecurityGroup), 'policies often require an NSG on every subnet');
  const ofType = (/** @type {string} */ t) => Object.values(network.resources).find((/** @type {any} */ r) => r.type === t);
  assert.match(ofType('Microsoft.Network/privateDnsZones').condition, /'create'/);
  assert.match(ofType('Microsoft.Network/privateEndpoints/privateDnsZoneGroups').condition, /'none'/);
});

test('the installer knows which private DNS zones each deployment creates in its own resource group', async () => {
  // The preflight stops when one of them is already there without this install's tag, so this list must match the template.
  /** @type {{ module: string, resource: any }[]} */
  const declared = [];
  const walk = (/** @type {any} */ template, /** @type {string} */ module) => {
    for (const r of Object.values(template.resources ?? {})) {
      if (/^Microsoft\.Network\/privateDnsZones$/i.test(r.type)) declared.push({ module, resource: r });
      if (r.properties?.template) walk(r.properties.template, r.name);
    }
  };
  walk(TEMPLATE, 'main');
  assert.deepEqual(declared.map((d) => d.module), ['vl-network'], 'only the network module creates private DNS zones');
  const zones = declared[0].resource;
  assert.equal(zones.name, "[variables('zoneNames')[copyIndex()]]");
  assert.equal(zones.copy.count, "[length(variables('zoneNames'))]");
  const mod = TEMPLATE.resources.find((/** @type {any} */ r) => r.name === 'vl-network');
  const dnsGroup = `/subscriptions/${SCOPE.subscriptionId}/resourceGroups/${SCOPE.resourceGroup}`;
  /** @type {Record<string, (az: any) => void>} */
  const cases = {
    'private networking': (az) => (az.publicNetworkAccess = false),
    'private networking with Ask': (az) => Object.assign(az, { publicNetworkAccess: false, ask: { mode: 'create' } }),
    'private networking with an existing Ask deployment': (az) => Object.assign(az, { publicNetworkAccess: false, ask: { mode: 'existing', endpoint: 'https://ask.example.com/', deployment: 'chat' } }),
    'existing private DNS zones': (az) => Object.assign(az, { publicNetworkAccess: false, ask: { mode: 'create' }, privateDns: { mode: 'existing', resourceGroupId: dnsGroup } }),
    'private DNS left to Azure Policy': (az) => Object.assign(az, { publicNetworkAccess: false, ask: { mode: 'create' }, privateDns: { mode: 'none' } }),
    'public networking': (az) => (az.ask = { mode: 'create' }),
  };
  const seen = new Set();
  for (const [name, tweak] of Object.entries(cases)) {
    const params = await installerParameters(tweak);
    const outer = armEvaluator(TEMPLATE, params, SCOPE);
    // Values only known while deploying, such as the Ask account's id, get a stand-in.
    const inner = Object.fromEntries(
      Object.entries(mod.properties.parameters).map(([k, v]) => {
        try {
          return [k, outer.evalValue(v)];
        } catch {
          return [k, { value: `${dnsGroup}/providers/Microsoft.Resources/deployments/runtime-${k}` }];
        }
      }),
    );
    const ev = armEvaluator(mod.properties.template, inner, SCOPE);
    const created = outer.evalValue(mod.condition) && ev.evalValue(zones.condition) ? ev.variable('zoneNames') : [];
    assert.deepEqual(declaredDnsZones(params), created, name);
    seen.add(created.length);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 4, 7], 'the cases cover no zones, the four data zones, and those plus the three AI zones');
});

test('no SQL firewall rule deploys when public access is off (private, or forced off by Azure Policy)', async () => {
  // A server whose public access is off rejects firewall rules with DenyPublicEndpointEnabled, which
  // a tester hit when a Modify policy switched it off at create time.
  /** @type {{ module: string, rule: any, passes: any }[]} */
  const rules = [];
  const walk = (/** @type {any} */ template, /** @type {string} */ module, /** @type {any} */ passes) => {
    for (const r of Object.values(template.resources ?? {})) {
      if (/^Microsoft\.Sql\/servers\/firewallRules$/i.test(r.type)) rules.push({ module, rule: r, passes });
      if (r.properties?.template) walk(r.properties.template, r.name, r.properties.parameters);
    }
  };
  walk(TEMPLATE, 'main', {});
  assert.deepEqual(rules.map((r) => r.module), ['vl-sql'], 'the only firewall rule is AllowAllWindowsAzureIps in the SQL module');
  assert.equal(rules[0].rule.condition, "[equals(parameters('publicNetworkAccess'), 'Enabled')]");
  assert.equal(rules[0].passes.publicNetworkAccess.value, "[parameters('publicNetworkAccess')]");
  assert.equal((await installerParameters((az) => (az.publicNetworkAccess = false))).publicNetworkAccess.value, 'Disabled');
  assert.equal((await installerParameters()).publicNetworkAccess.value, 'Enabled');
});

/**
 * The env of each Container Apps container (run, migrate and web), evaluated with the parameters the installer sends.
 * @param {Record<string, { value: any }>} params
 */
function containerEnv(params) {
  const outer = armEvaluator(TEMPLATE, params, SCOPE);
  const mod = TEMPLATE.resources.find((/** @type {any} */ r) => r.name === 'vl-containerapps');
  // Values only known while deploying, such as the managed identity's client id, get a stand-in.
  const inner = Object.fromEntries(Object.entries(mod.properties.parameters).map(([k, v]) => [k, RUNTIME_FUNCTIONS.test(JSON.stringify(v)) ? { value: 'runtime' } : outer.evalValue(v)]));
  const ev = armEvaluator(mod.properties.template, inner, SCOPE);
  /** @type {Record<string, Record<string, unknown>>} */
  const env = {};
  for (const r of Object.values(mod.properties.template.resources)) {
    for (const c of r.properties?.template?.containers ?? []) env[c.name] = Object.fromEntries(ev.evalValue(c.env).map((/** @type {any} */ e) => [e.name, e.value]));
  }
  return env;
}

test('the web app gets the modules the installer turns on (VALUELENS_MODULES), as both jobs do', async () => {
  // The web app serves them to the app as `modules`, so it skips the checks for modules that are off.
  const byDefault = await installerParameters();
  assert.equal(byDefault.modules.value, 'core,orgData,m365Activity');
  const allOn = (/** @type {any} */ az, /** @type {any} */ config) => {
    Object.assign(config.modules, { agent365: true, productFeedback: true, consumption: true, defender: true });
    config.dataSources.resourceGraph = 'api';
  };
  const full = await installerParameters(allOn);
  assert.equal(full.modules.value, 'core,orgData,m365Activity,agent365,productFeedback,consumption,defender,resourceGraph');
  // Sample data deploys no Consumption model and reads nothing from Resource Graph.
  const sample = await installerParameters((az, config) => {
    allOn(az, config);
    az.sampleData = true;
  });
  assert.equal(sample.modules.value, 'core,orgData,m365Activity,agent365,productFeedback,defender');
  for (const params of [byDefault, full, sample]) {
    const env = containerEnv(params);
    assert.deepEqual(Object.keys(env).sort(), ['migrate', 'run', 'web']);
    for (const [name, vars] of Object.entries(env)) assert.equal(vars.VALUELENS_MODULES, params.modules.value, `${name}: ${params.modules.value}`);
  }
});

test('only the run job caps DuckDB, at 5 of its 8 GiB (VALUELENS_DUCKDB_MEMORY_LIMIT)', async () => {
  // At DuckDB's default of 80%, `process` committed up to 7.46 GiB of the 8 at 20,000 seats (azure/DESIGN.md, risks).
  const env = containerEnv(await installerParameters());
  assert.equal(env.run.VALUELENS_DUCKDB_MEMORY_LIMIT, '5GiB');
  assert.equal(env.migrate.VALUELENS_DUCKDB_MEMORY_LIMIT, undefined);
  assert.equal(env.web.VALUELENS_DUCKDB_MEMORY_LIMIT, undefined);
  const mod = TEMPLATE.resources.find((/** @type {any} */ r) => r.name === 'vl-containerapps');
  const containers = Object.values(mod.properties.template.resources).flatMap((/** @type {any} */ r) => r.properties?.template?.containers ?? []);
  assert.equal(containers.find((c) => c.name === 'run')?.resources?.memory, '8Gi', 'change the cap with the memory');
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
