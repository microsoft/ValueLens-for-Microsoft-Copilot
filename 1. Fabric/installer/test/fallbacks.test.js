// @ts-check
/**
 * Installs where the user lacks rights: a vault admin adds the secret, the secret goes in the
 * notebooks, a vault in a resource group the user only has Contributor on, and an app
 * registration an admin makes for them.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GRAPH_APP_ID } from '../src/catalog.js';
import { parseCli } from '../src/cli.js';
import { secretMode } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { rotateSecret } from '../src/install.js';
import { ensureNotebooks } from '../src/steps/fabric.js';
import { flowsSkipped, flowsWanted } from '../src/steps/flows.js';
import {
  ADMIN_PACK_FILE,
  canWriteSecrets,
  checkExistingApp,
  ensureKeyVault,
  ensureSecret,
  handoffCommands,
  isResumeLater,
  newSecret,
  reportAppCheck,
  ResumeLater,
  secretHandoff,
  writeAdminPack,
} from '../src/steps/identity.js';
import { askAppId, confirmPlan, planAdminPack, planKeyVault, planReview } from '../src/steps/plan.js';
import { fakeCtx, fakeFabric, fakeGraph, fakeUi, httpError } from './fakes.js';

const VAULT_ID = '/subscriptions/sub-1/resourceGroups/rg-valuelens/providers/Microsoft.KeyVault/vaults/kv-test';
const OTHER_ID = '/subscriptions/sub-1/resourceGroups/rg-valuelens/providers/Microsoft.KeyVault/vaults/kv-mine';
const SUB = '/subscriptions/sub-1';
const APP_GUID = '11111111-2222-3333-4444-555555555555';
const READ_ONLY = [{ actions: ['*/read'] }];
const SECRETS_OFFICER = [{ actions: [], dataActions: ['Microsoft.KeyVault/vaults/secrets/*'] }];
const RG_CONTRIBUTOR = [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] }];
const PRE = /** @type {any} */ ({ subscriptions: [{ subscriptionId: 'sub-1', displayName: 'Sub' }], canConsent: false, capacities: [] });

/** @param {{ rbac?: boolean, policies?: any[], id?: string, name?: string }} [o] */
const vault = (o = {}) => ({
  id: o.id ?? VAULT_ID,
  name: o.name ?? 'kv-test',
  location: 'uksouth',
  properties: { vaultUri: 'https://kv-test.vault.azure.net/', enableRbacAuthorization: o.rbac ?? true, accessPolicies: o.policies ?? [] },
});

/**
 * Resource Manager calls for vault work.
 * @param {{ vaults?: any[], perms?: Record<string, any[]>, groups?: string[], assignFails?: boolean, policyFails?: boolean, providerFails?: boolean, groupFails?: boolean, createError?: Error }} [o]
 */
function vaultArm(o = {}) {
  /** @type {string[]} */
  const calls = [];
  const groups = new Set(o.groups ?? []);
  const api = {
    listVaults: async () => o.vaults ?? [],
    getVault: async (/** @type {string} */ id) => (o.vaults ?? []).find((v) => v.id === id),
    permissions: async (/** @type {string} */ scope) => o.perms?.[scope] ?? [],
    getResourceGroup: async (/** @type {string} */ _s, /** @type {string} */ name) => (groups.has(name) ? { name } : null),
    checkVaultName: async () => ({ nameAvailable: true }),
    ensureProvider: async () => {
      calls.push('ensureProvider');
      if (o.providerFails) throw httpError(403, 'Forbidden');
      return false;
    },
    ensureResourceGroup: async (/** @type {string} */ _s, /** @type {string} */ name) => {
      calls.push(`ensureResourceGroup ${name}`);
      if (o.groupFails) throw httpError(403, 'Forbidden');
      return { name };
    },
    createVault: async (/** @type {any} */ v) => {
      calls.push(`createVault ${v.resourceGroup}/${v.name}`);
      if (o.createError) throw o.createError;
      return vault({ rbac: v.rbac, name: v.name, id: `${SUB}/resourceGroups/${v.resourceGroup}/providers/Microsoft.KeyVault/vaults/${v.name}` });
    },
    assignRole: async (/** @type {string} */ _scope, /** @type {string} */ role) => {
      calls.push(`assignRole ${role}`);
      if (o.assignFails) throw httpError(403, 'Forbidden');
      return true;
    },
    addAccessPolicy: async (/** @type {string} */ _id, /** @type {string} */ _t, /** @type {string} */ _o, /** @type {string[]} */ secrets = ['get', 'list', 'set']) => {
      calls.push(`addAccessPolicy ${secrets.join(',')}`);
      if (o.policyFails) throw httpError(403, 'Forbidden');
    },
  };
  return { api, calls };
}

/**
 * Graph calls for checking an app the user brought.
 * @param {{ application?: any, sp?: any, assigned?: string[][] }} [o]  `assigned` is what each check sees, in turn.
 */
function appGraph(o = {}) {
  const assigned = [...(o.assigned ?? [[]])];
  const graphSp = {
    id: 'graph-sp',
    appRoles: [
      { id: 'r-audit', value: 'AuditLogsQuery.Read.All' },
      { id: 'r-reports', value: 'Reports.Read.All' },
      { id: 'r-users', value: 'User.Read.All' },
    ],
  };
  const api = {
    graphServicePrincipal: async () => graphSp,
    findApplication: async () => o.application ?? null,
    findServicePrincipal: async () => o.sp ?? null,
    appRoleAssignments: async () => (assigned.length > 1 ? assigned.shift() ?? [] : assigned[0]).map((appRoleId) => ({ resourceId: 'graph-sp', appRoleId })),
  };
  return { api };
}

const THEIR_APP = {
  id: 'their-obj',
  displayName: 'Their app',
  requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: ['r-audit', 'r-reports', 'r-users'].map((id) => ({ id, type: 'Role' })) }],
};

/** An install using an existing vault the user can't write to, with a vault admin adding the secret. */
function adminCtx(o = {}) {
  const made = fakeCtx(o);
  Object.assign(made.config.keyVault, { existing: true, id: VAULT_ID, name: 'kv-test', mode: 'keyvault-admin', rbac: true });
  delete made.config.keyVault.uri;
  return made;
}

test('secret modes: Key Vault is the default; ResumeLater is told apart from failures', () => {
  const { config } = fakeCtx();
  assert.equal(secretMode(config), 'keyvault');
  config.keyVault.mode = 'notebook';
  assert.equal(secretMode(config), 'notebook');
  assert.equal(isResumeLater(new ResumeLater('later')), true);
  assert.equal(isResumeLater(new Error('boom')), false);
  assert.equal(isResumeLater(undefined), false);
});

test('vault admin: the commands create the secret in the vault and never hold its value', () => {
  const { config } = adminCtx();
  const [only, ...rest] = handoffCommands(config, { userId: 'user-1' });
  assert.deepEqual(rest, []);
  assert.match(only, /^az keyvault secret set --vault-name kv-test --name valuelens-client-secret /);
  assert.match(only, /--value "\$\(az ad app credential reset --id app-1 --append /);
  assert.doesNotMatch(only, /secret-\d|s3cret/);

  config.keyVault.handoff = { grantRead: true };
  const rbac = handoffCommands(config, { userId: 'user-1' });
  assert.equal(rbac.length, 2);
  assert.equal(rbac[0], `az role assignment create --role "Key Vault Secrets User" --assignee-object-id user-1 --assignee-principal-type User --scope ${VAULT_ID}`);
  config.keyVault.rbac = false;
  assert.equal(handoffCommands(config, { userId: 'user-1' })[0], 'az keyvault set-policy --name kv-test --object-id user-1 --secret-permissions get list');
  assert.equal(handoffCommands(config).length, 1, 'no reader line without a user');
});

test('vault admin: can the user write secrets, or give themselves the right to', async () => {
  const check = async (/** @type {any} */ v, /** @type {any[] | null} */ perms) => {
    const { ctx } = fakeCtx({ arm: { permissions: async () => (perms === null ? Promise.reject(new Error('no')) : perms) } });
    return canWriteSecrets(ctx, v);
  };
  assert.equal(await check(vault(), SECRETS_OFFICER), true);
  assert.equal(await check(vault(), READ_ONLY), false);
  assert.equal(await check(vault(), [{ actions: ['Microsoft.Authorization/roleAssignments/write'] }]), true);
  assert.equal(await check(vault({ rbac: false, policies: [{ objectId: 'user-1', permissions: { secrets: ['Get', 'Set'] } }] }), READ_ONLY), true);
  assert.equal(await check(vault({ rbac: false, policies: [{ objectId: 'user-1', permissions: { secrets: ['get'] } }] }), READ_ONLY), false);
  assert.equal(await check(vault({ rbac: false }), [{ actions: ['Microsoft.KeyVault/vaults/accessPolicies/write'] }]), true);
  assert.equal(await check(vault(), null), true, 'unknown rights fall through to the usual path');
});

test('vault admin: the user gets read access when they can, or the admin is asked for it', async () => {
  const rbac = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY } });
  const ui = fakeUi();
  const t = adminCtx({ arm: rbac.api, ui: ui.ui });
  await ensureKeyVault(t.ctx);
  assert.deepEqual(rbac.calls, ['assignRole 4633458b-17de-408a-b874-0445c86b69e6']);
  assert.equal(t.config.keyVault.uri, 'https://kv-test.vault.azure.net/');
  assert.equal(t.config.keyVault.handoff?.grantRead, undefined);
  assert.match(ui.text(), /Gave you Key Vault Secrets User/);

  const reader = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: [{ actions: [], dataActions: ['Microsoft.KeyVault/vaults/secrets/getSecret/action'] }] } });
  const has = adminCtx({ arm: reader.api });
  await ensureKeyVault(has.ctx);
  assert.deepEqual(reader.calls, [], 'already a reader');

  const denied = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY }, assignFails: true });
  const deniedUi = fakeUi();
  const d = adminCtx({ arm: denied.api, ui: deniedUi.ui });
  await ensureKeyVault(d.ctx);
  assert.equal(d.config.keyVault.handoff?.grantRead, true);
  assert.match(deniedUi.text(), /can't give yourself read access to kv-test/);

  const policy = vaultArm({ vaults: [vault({ rbac: false })] });
  const p = adminCtx({ arm: policy.api });
  await ensureKeyVault(p.ctx);
  assert.deepEqual(policy.calls, ['addAccessPolicy get,list'], 'read only: no set');

  const policyDenied = vaultArm({ vaults: [vault({ rbac: false })], policyFails: true });
  const pd = adminCtx({ arm: policyDenied.api });
  await ensureKeyVault(pd.ctx);
  assert.equal(pd.config.keyVault.handoff?.grantRead, true);
});

test('vault admin: the default path still stops when the user can\'t write secrets', async () => {
  const arm = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY }, assignFails: true });
  const t = adminCtx({ arm: arm.api });
  delete t.config.keyVault.mode;
  await assert.rejects(ensureKeyVault(t.ctx), /You can't write secrets to kv-test/);

  const policy = vaultArm({ vaults: [vault({ rbac: false })] });
  const p = adminCtx({ arm: policy.api });
  delete p.config.keyVault.mode;
  await ensureKeyVault(p.ctx);
  assert.deepEqual(policy.calls, ['addAccessPolicy get,list,set']);
});

test('vault admin: the handoff shows the steps, can make the admin an owner, and stops to resume later', async () => {
  /** @type {string[]} */
  const owners = [];
  const graph = {
    getUser: async (/** @type {string} */ upn) => (upn === 'kv.admin@example.com' ? { id: 'admin-1', displayName: 'Vault Admin', userPrincipalName: upn } : null),
    addOwner: async (/** @type {string} */ app, /** @type {string} */ user) => {
      owners.push(`${app} ${user}`);
    },
  };
  const ui = fakeUi({ answers: ['kv.admin@example.com', 'stop'] });
  const t = adminCtx({ graph, ui: ui.ui });
  t.config.keyVault.uri = 'https://kv-test.vault.azure.net/';
  await assert.rejects(secretHandoff(t.ctx), (err) => isResumeLater(err));
  assert.deepEqual(owners, ['obj-1 admin-1']);
  assert.equal(t.config.keyVault.handoff?.adminEmail, 'kv.admin@example.com');
  assert.equal(t.config.keyVault.handoff?.shownAt, '2026-06-01T12:00:00.000Z');
  assert.equal(t.config.keyVault.secretSetAt, undefined);
  const text = ui.text();
  assert.match(text, /Vault: {3}kv-test/);
  assert.match(text, /Secret: {2}valuelens-client-secret/);
  assert.match(text, /az keyvault secret set --vault-name kv-test/);
  assert.match(text, /Certificates & secrets > New client secret/);

  // Run again: the secret is there now.
  const again = fakeUi({ answers: ['', 'go'] });
  t.ctx.ui = again.ui;
  assert.equal(await secretHandoff(t.ctx), true);
  assert.equal(t.config.keyVault.secretSetAt, '2026-06-01T12:00:00.000Z');
  assert.equal(t.config.keyVault.handoff?.confirmedAt, '2026-06-01T12:00:00.000Z');
  assert.match(again.text(), /The vault admin has added the secret valuelens-client-secret/);

  const quiet = fakeUi({ yes: true });
  const unattended = adminCtx({ ui: quiet.ui });
  assert.equal(await secretHandoff(unattended.ctx), false);
  assert.deepEqual(quiet.asked, []);
  assert.match(quiet.text(), /Carrying on\. Data loads fail until the secret is in kv-test/);
  assert.equal(unattended.config.keyVault.secretSetAt, undefined);
});

test('vault admin: a name that holds another app\'s secret in a shared vault isn\'t handed over', async () => {
  const keyVault = {
    secretInfo: async (/** @type {string} */ _uri, /** @type {string} */ name) =>
      name === 'valuelens-client-secret' ? { contentType: 'Client secret for another-app' } : null,
  };
  const ui = fakeUi({ answers: ['', 'go'] });
  const t = adminCtx({ keyVault, ui: ui.ui });
  assert.equal(await secretHandoff(t.ctx), true);
  assert.equal(t.config.keyVault.secretName, 'valuelens-client-secret-2');
  assert.match(ui.text(), /--name valuelens-client-secret-2 /);

  // Without read access yet, the admin is told to check the name.
  const blind = fakeUi({ answers: ['', 'go'] });
  const b = adminCtx({ keyVault: { secretInfo: async () => Promise.reject(httpError(403, 'Forbidden')) }, ui: blind.ui });
  assert.equal(await secretHandoff(b.ctx), true);
  assert.equal(b.config.keyVault.secretName, 'valuelens-client-secret');
  assert.match(blind.text(), /Couldn't check whether kv-test already has a secret called valuelens-client-secret/);
});

test('vault admin: an unknown email or an existing owner doesn\'t stop the handoff', async () => {
  const graph = {
    getUser: async (/** @type {string} */ upn) => (upn === 'owner@example.com' ? { id: 'admin-1', userPrincipalName: upn } : null),
    addOwner: async () => {
      throw new HttpError('One or more added object references already exist', { status: 400, method: 'POST', url: 'https://x' });
    },
  };
  const ui = fakeUi({ answers: ['nobody@example.com', 'go'] });
  const t = adminCtx({ graph, ui: ui.ui });
  assert.equal(await secretHandoff(t.ctx), true);
  assert.match(ui.text(), /No user nobody@example\.com in this tenant/);

  const owner = adminCtx({ graph, ui: fakeUi({ answers: ['owner@example.com', 'go'] }).ui });
  assert.equal(await secretHandoff(owner.ctx), true);
  assert.equal(owner.config.keyVault.handoff?.adminEmail, 'owner@example.com');

  const theirs = fakeUi({ answers: ['go'] });
  const brought = adminCtx({ ui: theirs.ui });
  brought.config.app.existing = true;
  assert.equal(await secretHandoff(brought.ctx), true);
  assert.deepEqual(theirs.asked, ['Has the admin added the secret?'], 'no owner question for an app the user brought');
});

test('vault admin: ensureSecret and new secrets hand over instead of writing', async () => {
  /** @type {string[]} */
  const calls = [];
  const graph = { addPassword: async () => calls.push('addPassword') };
  const keyVault = { setSecret: async () => calls.push('setSecret'), secretExists: async () => calls.push('secretExists') };

  const done = fakeUi();
  const t = adminCtx({ graph, keyVault, ui: done.ui });
  t.config.keyVault.secretSetAt = '2026-05-01T00:00:00Z';
  t.config.keyVault.handoff = { grantRead: true };
  t.ctx.pendingSecret = 'never-used';
  await ensureSecret(t.ctx);
  assert.equal(t.ctx.pendingSecret, undefined);
  assert.deepEqual(done.asked, []);
  assert.match(done.text(), /You still need read access to kv-test/);
  assert.match(done.text(), /az role assignment create --role "Key Vault Secrets User"/);

  const rotate = fakeUi({ answers: ['', 'go'] });
  const r = adminCtx({ graph, keyVault, ui: rotate.ui });
  r.config.app.secretExpires = '2026-07-01T00:00:00Z';
  await newSecret(r.ctx);
  assert.match(rotate.text(), /A vault admin needs to replace the client secret in kv-test/);
  assert.match(rotate.text(), /delete the old one/);
  assert.equal(r.config.app.secretExpires, undefined);
  assert.deepEqual(calls, [], 'the installer never makes or writes the secret');
});

test('vault admin: rotate-secret shows the steps and can stop to resume later', async () => {
  const ui = fakeUi({ answers: [true, '', 'stop'] });
  const t = adminCtx({ ui: ui.ui });
  t.config.keyVault.uri = 'https://kv-test.vault.azure.net/';
  await assert.rejects(rotateSecret(t.ctx), (err) => isResumeLater(err));
  assert.match(ui.asked[0], /Show the steps for a vault admin to replace the secret in kv-test/);
});

test('notebook mode: the secret is written into the notebooks and nowhere else', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const ui = fakeUi();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: ui.ui });
  t.config.keyVault = { secretName: 'valuelens-client-secret', mode: 'notebook' };

  await ensureNotebooks(t.ctx);
  const holding = fabric.items.filter((i) => String(i.content).includes('secret-1'));
  assert.ok(holding.length >= 1, 'the notebooks that sign in hold the secret');
  for (const item of holding) assert.match(String(item.content), /stored in the notebook \(not recommended\)/);
  assert.equal(t.config.app.secretKeyId, 'key-1');
  assert.equal(t.config.app.secretExpires, '2027-06-01T12:00:00.000Z');
  assert.ok(t.config.keyVault.secretSetAt);
  assert.equal(t.ctx.pendingSecret, undefined);
  assert.doesNotMatch(ui.text(), /secret-1/);
  assert.doesNotMatch(JSON.stringify(t.config), /secret-1/);

  fabric.calls.length = 0;
  graph.calls.length = 0;
  await ensureNotebooks(t.ctx);
  assert.deepEqual(graph.calls, [], 'a re-run makes no new secret');
  assert.deepEqual(fabric.calls, []);

  // Rotating: a new secret goes into every notebook, then the old one is removed from the app.
  const rotate = fakeUi({ answers: [true] });
  t.ctx.ui = rotate.ui;
  await rotateSecret(t.ctx);
  assert.deepEqual(graph.calls, ['addPassword Analytics Hub installer', 'removePassword key-1']);
  assert.equal(t.config.app.secretKeyId, 'key-2');
  assert.ok(fabric.items.every((i) => !String(i.content).includes('secret-1')));
  assert.equal(fabric.items.filter((i) => String(i.content).includes('secret-2')).length, holding.length);
  assert.match(rotate.text(), /still plain text in the notebooks\. Rotate it often/);
  assert.doesNotMatch(rotate.text(), /secret-2/);
});

test('notebook mode: a rotation that stops part-way removes the old secret on the next run', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'valuelens-client-secret', mode: 'notebook' };
  await ensureNotebooks(t.ctx);
  assert.equal(t.config.fabric.secretInNotebooks, true);

  const update = fabric.api.updateNotebook;
  let secretWrites = 0;
  fabric.api.updateNotebook = async (/** @type {string} */ ws, /** @type {string} */ id, /** @type {string} */ content) => {
    if (String(content).includes('secret-2') && ++secretWrites === 2) throw new Error('Fabric is busy');
    return update(ws, id, content);
  };
  graph.calls.length = 0;
  await assert.rejects(ensureNotebooks(t.ctx, { force: true }), /Fabric is busy/);
  assert.deepEqual(graph.calls, ['addPassword Analytics Hub installer'], 'the old secret stays while notebooks still use it');
  assert.equal(t.config.app.secretKeyId, 'key-2');
  assert.deepEqual(t.config.app.retiredSecretKeyIds, ['key-1']);

  fabric.api.updateNotebook = update;
  graph.calls.length = 0;
  await ensureNotebooks(t.ctx, { force: true });
  assert.deepEqual(graph.calls, ['addPassword Analytics Hub installer', 'removePassword key-1', 'removePassword key-2']);
  assert.equal(t.config.app.secretKeyId, 'key-3');
  assert.equal(t.config.app.retiredSecretKeyIds, undefined);
  assert.doesNotMatch(JSON.stringify(t.config), /secret-\d/);
});

test('notebook mode: moving to Key Vault rewrites the notebooks and removes the secret they held', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: fakeUi().ui });
  t.config.keyVault = { secretName: 'valuelens-client-secret', mode: 'notebook' };
  await ensureNotebooks(t.ctx);
  const holding = fabric.items.filter((i) => String(i.content).includes('secret-1')).map((i) => i.displayName);

  // As after "Use Key Vault instead" and the vault steps.
  Object.assign(t.config.keyVault, { uri: 'https://kv-test.vault.azure.net/', name: 'kv-test' });
  delete t.config.keyVault.mode;
  fabric.calls.length = 0;
  graph.calls.length = 0;
  await ensureNotebooks(t.ctx);
  assert.deepEqual(fabric.calls.sort(), holding.map((n) => `updateNotebook ${n}`).sort(), 'only the notebooks that read the secret are rewritten');
  assert.ok(fabric.items.every((i) => !String(i.content).includes('secret-1')));
  assert.ok(fabric.items.filter((i) => holding.includes(i.displayName)).every((i) => String(i.content).includes('https://kv-test.vault.azure.net/')));
  assert.deepEqual(graph.calls, ['removePassword key-1']);
  assert.equal(t.config.app.secretKeyId, undefined);
  assert.equal(t.config.fabric.secretInNotebooks, undefined);

  fabric.calls.length = 0;
  await ensureNotebooks(t.ctx);
  assert.deepEqual(fabric.calls, [], 'the default Key Vault path leaves the notebooks alone');
});

test('notebook mode: an app the user brought gets its pasted secret; no vault needed', async () => {
  const fabric = fakeFabric();
  const graph = fakeGraph();
  const ui = fakeUi({ answers: ['pasted-value'] });
  const t = fakeCtx({ fabric: fabric.api, graph: graph.api, ui: ui.ui });
  t.config.keyVault = { secretName: 'valuelens-client-secret', mode: 'notebook' };
  t.config.app.existing = true;

  await ensureKeyVault(t.ctx);
  await ensureSecret(t.ctx);
  await ensureNotebooks(t.ctx);
  assert.ok(fabric.items.some((i) => String(i.content).includes('pasted-value')));
  assert.deepEqual(graph.calls, []);
  assert.equal(t.config.keyVault.uri, undefined);
  assert.ok(t.config.keyVault.secretSetAt);
  assert.doesNotMatch(ui.text(), /pasted-value/);
  assert.doesNotMatch(JSON.stringify(t.config), /pasted-value/);
});

test('notebook mode: Power Automate flows are left out, since they read the secret from Key Vault', () => {
  const { config } = fakeCtx();
  config.uploads.feedbackFlow = true;
  config.dataSources.productFeedback = 'csv';
  assert.deepEqual(flowsWanted(config), ['feedback']);
  assert.deepEqual(flowsSkipped(config), []);
  config.keyVault.mode = 'notebook';
  assert.deepEqual(flowsWanted(config), []);
  assert.equal(flowsSkipped(config).length, 1);
});

test('notebook mode: --secret-in-notebook goes with a Fabric install only', () => {
  assert.equal(parseCli(['install', '--secret-in-notebook']).secretInNotebook, true);
  assert.equal(parseCli(['install']).secretInNotebook, false);
  assert.throws(() => parseCli(['update', '--secret-in-notebook']), /--secret-in-notebook goes with install/);
  assert.throws(() => parseCli(['install', '--target', 'azure', '--secret-in-notebook']), /Fabric target only/);
});

test('planning: a vault the user can\'t write to offers the vault admin first', async () => {
  const arm = vaultArm({ vaults: [vault()], perms: { [VAULT_ID]: READ_ONLY } });
  const ui = fakeUi({ answers: ['sub-1', VAULT_ID] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.equal(t.config.keyVault.mode, 'keyvault-admin');
  assert.equal(t.config.keyVault.existing, true);
  assert.equal(t.config.keyVault.name, 'kv-test');
  assert.equal(t.config.keyVault.resourceGroup, 'rg-valuelens');
  assert.match(ui.text(), /You can't write secrets to kv-test: that needs Key Vault Secrets Officer/);
  assert.ok(ui.asked.includes('How should the client secret get there?'));

  // A vault they can write to keeps the usual path.
  const mine = vaultArm({ vaults: [vault(), vault({ id: OTHER_ID, name: 'kv-mine' })], perms: { [OTHER_ID]: SECRETS_OFFICER } });
  const u = fakeUi({ answers: ['sub-1', OTHER_ID] });
  const m = fakeCtx({ arm: mine.api, ui: u.ui });
  m.config.keyVault.mode = 'keyvault-admin';
  m.config.keyVault.handoff = { shownAt: 'x' };
  await planKeyVault(m.ctx, PRE, 'uksouth');
  assert.equal(secretMode(m.config), 'keyvault');
  assert.equal(m.config.keyVault.handoff, undefined);
  assert.ok(!u.asked.includes('How should the client secret get there?'));
});

test('planning: the notebook option warns and needs a yes, which defaults to no', async () => {
  const arm = vaultArm({ vaults: [vault({ id: OTHER_ID, name: 'kv-mine' })], perms: { [OTHER_ID]: SECRETS_OFFICER } });
  const ui = fakeUi({ answers: ['sub-1', 'notebook'] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  Object.assign(t.config.keyVault, { existing: true, id: OTHER_ID });
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.equal(secretMode(t.config), 'keyvault', 'declined by default, then the vault it had');
  assert.equal(t.config.keyVault.name, 'kv-mine');
  const text = ui.text();
  assert.match(text, /plain text in the notebook code/);
  assert.match(text, /Anyone with access to the workspace can read it/);
  assert.match(text, /run snapshots, exports, Git sync and deployment pipelines/);

  const yes = fakeUi({ answers: ['sub-1', 'notebook', true] });
  const y = fakeCtx({ arm: arm.api, ui: yes.ui });
  y.config.keyVault.handoff = { shownAt: 'x' };
  await planKeyVault(y.ctx, PRE, 'uksouth');
  assert.equal(y.config.keyVault.mode, 'notebook');
  assert.equal(y.config.keyVault.handoff, undefined);
  assert.ok(!yes.asked.includes('Secret name'), 'no vault, so no secret name');
});

test('planning: with no subscription, only the notebook option is left; --yes needs the flag', async () => {
  const none = /** @type {any} */ ({ ...PRE, subscriptions: [] });
  const quiet = fakeUi({ yes: true });
  const t = fakeCtx({ ui: quiet.ui });
  await assert.rejects(planKeyVault(t.ctx, none, 'uksouth'), /needs an Azure subscription/);
  assert.match(quiet.text(), /add --secret-in-notebook/);

  const flagged = fakeCtx({ ui: fakeUi({ yes: true }).ui });
  flagged.ctx.secretInNotebook = true;
  await planKeyVault(flagged.ctx, none, 'uksouth');
  assert.equal(flagged.config.keyVault.mode, 'notebook');

  const asked = fakeUi({ answers: [true] });
  const i = fakeCtx({ ui: asked.ui });
  await planKeyVault(i.ctx, none, 'uksouth');
  assert.equal(i.config.keyVault.mode, 'notebook');
});

test('planning: Contributor on a resource group is enough for a new vault', async () => {
  const arm = vaultArm({ groups: ['rg-mine'], perms: { [SUB]: READ_ONLY, [`${SUB}/resourceGroups/rg-mine`]: RG_CONTRIBUTOR } });
  const ui = fakeUi({ answers: ['sub-1', '', 'rg-missing', 'rg-mine'] });
  const t = fakeCtx({ arm: arm.api, ui: ui.ui });
  await planKeyVault(t.ctx, PRE, 'uksouth');
  assert.equal(t.config.keyVault.resourceGroup, 'rg-mine');
  assert.equal(t.config.keyVault.existing, false);
  assert.equal(t.config.keyVault.rbac, false, 'no role assignments, so access policies');
  assert.match(ui.text(), /no resource group called rg-missing that you can see, and you can't create one/);
});

test('new vault: Contributor on just the resource group creates it there', async () => {
  const kv = (/** @type {any} */ arm) => {
    const t = fakeCtx({ arm, ui: fakeUi().ui });
    t.config.keyVault = { secretName: 'valuelens-client-secret', subscriptionId: 'sub-1', resourceGroup: 'rg-mine', name: 'kv-new', location: 'uksouth', rbac: false, existing: false };
    return t;
  };
  const ok = vaultArm({ groups: ['rg-mine'], providerFails: true });
  const ui = fakeUi();
  const t = kv(ok.api);
  t.ctx.ui = ui.ui;
  await ensureKeyVault(t.ctx);
  assert.deepEqual(ok.calls, ['ensureProvider', 'createVault rg-mine/kv-new'], 'no resource group write for one that exists');
  assert.match(ui.text(), /can't check resource providers in this subscription/);
  assert.equal(t.config.keyVault.uri, 'https://kv-test.vault.azure.net/');

  const noGroup = vaultArm({ groupFails: true });
  await assert.rejects(ensureKeyVault(kv(noGroup.api).ctx), /give the name of an existing resource group you can write to/);

  const unregistered = vaultArm({
    groups: ['rg-mine'],
    createError: new HttpError('conflict', { status: 409, method: 'PUT', url: 'https://x', body: { error: { code: 'MissingSubscriptionRegistration' } } }),
  });
  await assert.rejects(ensureKeyVault(kv(unregistered.api).ctx), /isn't registered for Microsoft\.KeyVault/);
});

test('app check: an app the user brought is checked for its service principal, permissions and consent', async () => {
  const missing = appGraph({ application: { ...THEIR_APP, requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: 'r-audit', type: 'Role' }] }] } });
  const t = fakeCtx({ graph: missing.api });
  const check = await checkExistingApp(t.ctx);
  assert.deepEqual(check, {
    found: true,
    displayName: 'Their app',
    servicePrincipal: false,
    undeclared: ['Reports.Read.All', 'User.Read.All'],
    unconsented: ['AuditLogsQuery.Read.All', 'Reports.Read.All', 'User.Read.All'],
  });
  const ui = fakeUi();
  t.ctx.ui = ui.ui;
  assert.equal(reportAppCheck(t.ctx, check), false);
  assert.match(ui.text(), /Its service principal \(enterprise application\)\. If you own the app, choose "Carry on anyway" and the installer creates it\./);
  assert.match(ui.text(), /These Graph application permissions on its API permissions page: Reports\.Read\.All, User\.Read\.All/);
  assert.match(ui.text(), /Admin consent for: AuditLogsQuery\.Read\.All/);
  assert.match(ui.text(), /CallAnAPI\/appId\/app-1/);

  const consentOnly = fakeUi();
  t.ctx.ui = consentOnly.ui;
  assert.equal(reportAppCheck(t.ctx, { ...check, servicePrincipal: true, undeclared: [] }), false);
  assert.match(consentOnly.text(), /login\.microsoftonline\.com\/tenant-1\/adminconsent\?client_id=app-1/);
  assert.equal(reportAppCheck(t.ctx, { ...check, servicePrincipal: true, undeclared: [] }, { canConsent: true }), true, 'an admin grants consent during the install');

  const none = fakeCtx({ graph: appGraph().api, ui: fakeUi().ui });
  const absent = await checkExistingApp(none.ctx);
  assert.equal(absent.found, false);
  assert.equal(reportAppCheck(none.ctx, absent), false);
});

test('app check: the user can check again once an admin has fixed it, or carry on', async () => {
  const graph = appGraph({ application: THEIR_APP, sp: { id: 'their-sp' }, assigned: [['r-audit'], ['r-audit', 'r-reports', 'r-users']] });
  const ui = fakeUi({ answers: [APP_GUID, 'again'] });
  const t = fakeCtx({ graph: graph.api, ui: ui.ui });
  await askAppId(t.ctx, { canConsent: false });
  assert.equal(t.config.app.appId, APP_GUID);
  assert.equal(t.config.app.displayName, 'Their app');
  assert.match(ui.text(), /Their app isn't ready yet/);
  assert.match(ui.text(), /Their app has everything Analytics Hub needs/);

  const stuck = appGraph({ application: THEIR_APP, sp: { id: 'their-sp' } });
  const go = fakeUi({ answers: [APP_GUID, 'go'] });
  const g = fakeCtx({ graph: stuck.api, ui: go.ui });
  await askAppId(g.ctx, { canConsent: false });
  assert.match(go.text(), /Carrying on with the app as it is/);

  const quiet = fakeUi({ yes: true, answers: [APP_GUID] });
  const q = fakeCtx({ graph: stuck.api, ui: quiet.ui });
  await askAppId(q.ctx, { canConsent: false });
  assert.match(quiet.text(), /Carrying on\. Data the missing permissions cover/);

  const gone = fakeCtx({ graph: appGraph().api, ui: fakeUi({ yes: true, answers: [APP_GUID] }).ui });
  await assert.rejects(askAppId(gone.ctx, { canConsent: false }), /No app registration with ID 11111111/);

  await assert.rejects(askAppId(fakeCtx({ graph: stuck.api, ui: fakeUi({ answers: ['not-a-guid'] }).ui }).ctx, { canConsent: false }), /Paste the GUID/);
});

test('admin pack: a script and portal steps for every permission, with the secret going where the install keeps it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-pack-'));
  try {
    const t = fakeCtx();
    t.ctx.configFile = join(dir, 'valuelens-install.json');
    const file = writeAdminPack(t.ctx);
    assert.equal(file, join(dir, ADMIN_PACK_FILE));
    const body = readFileSync(file, 'utf8');
    assert.match(body, /az ad app create --display-name "Analytics Hub Data Collector"/);
    assert.match(body, /for P in AuditLogsQuery\.Read\.All Reports\.Read\.All User\.Read\.All; do/);
    assert.match(body, /az ad app permission admin-consent --id "\$APP_ID"/);
    assert.match(body, /Grant admin consent/);
    assert.match(body, /az ad app credential reset --id "\$APP_ID"/);
    assert.match(body, /through a secure channel/);
    assert.doesNotMatch(body, /az keyvault/);

    Object.assign(t.config.keyVault, { mode: 'keyvault-admin', name: 'kv-test' });
    const vaulted = readFileSync(writeAdminPack(t.ctx), 'utf8');
    assert.match(vaulted, /az keyvault secret set --vault-name kv-test --name valuelens-client-secret/);
    assert.match(vaulted, /if \[ -n "\$CT" \] && \[ "\$CT" != "Client secret for \$APP_ID" \]; then/, 'another app\'s secret with that name is left alone');
    assert.match(vaulted, /They don't need the secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin pack: the install stops until the admin sends the client ID, then checks it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-pack-'));
  try {
    const quiet = fakeUi({ yes: true });
    const q = fakeCtx({ ui: quiet.ui });
    q.ctx.configFile = join(dir, 'valuelens-install.json');
    delete q.config.app.appId;
    await assert.rejects(planAdminPack(q.ctx, { canConsent: false }), (err) => isResumeLater(err));
    assert.equal(q.config.app.adminPack, join(dir, ADMIN_PACK_FILE));
    assert.ok(existsSync(join(dir, ADMIN_PACK_FILE)));
    assert.match(quiet.text(), /An admin needs to register the app/);

    const stop = fakeCtx({ ui: fakeUi({ answers: ['stop'] }).ui });
    stop.ctx.configFile = q.ctx.configFile;
    await assert.rejects(planAdminPack(stop.ctx, { canConsent: false }), (err) => isResumeLater(err));

    const graph = appGraph({ application: THEIR_APP, sp: { id: 'their-sp' }, assigned: [['r-audit', 'r-reports', 'r-users']] });
    const vaulted = fakeCtx({ graph: graph.api, ui: fakeUi({ answers: ['go', APP_GUID] }).ui });
    vaulted.ctx.configFile = q.ctx.configFile;
    Object.assign(vaulted.config.keyVault, { mode: 'keyvault-admin', name: 'kv-test' });
    assert.equal(await planAdminPack(vaulted.ctx, { canConsent: false }), false, 'the admin\'s script put the secret in the vault');
    assert.equal(vaulted.config.app.appId, APP_GUID);
    assert.equal(vaulted.config.keyVault.secretSetAt, '2026-06-01T12:00:00.000Z');

    const pasted = fakeCtx({ graph: graph.api, ui: fakeUi({ answers: ['go', APP_GUID] }).ui });
    pasted.ctx.configFile = q.ctx.configFile;
    assert.equal(await planAdminPack(pasted.ctx, { canConsent: false }), true, 'the user pastes the secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review: each secret mode says where the secret is and what the user needs', async () => {
  const t = fakeCtx();
  Object.assign(t.config.keyVault, { existing: true, name: 'kv-test' });
  delete t.config.keyVault.uri;
  const usual = planReview(t.ctx);
  assert.match(String(usual.grants.find((g) => g.where === 'Key Vault kv-test')?.what), /Key Vault Secrets Officer/);
  assert.ok(usual.runsOn.some((r) => r.what === 'Key Vault'));

  t.config.keyVault.mode = 'keyvault-admin';
  const admin = planReview(t.ctx);
  assert.match(String(admin.grants.find((g) => g.where === 'Key Vault kv-test')?.what), /^Key Vault Secrets User/);
  assert.match(String(admin.creates.find((i) => i.kind === 'Key Vault')?.detail), /A vault admin adds it/);

  t.config.keyVault.mode = 'notebook';
  const inline = planReview(t.ctx);
  assert.equal(inline.creates.find((i) => i.kind === 'Key Vault'), undefined);
  assert.match(String(inline.creates.find((i) => i.kind === 'Client secret')?.detail), /Plain text that anyone with access to the workspace can read/);
  assert.equal(inline.grants.find((g) => String(g.where).startsWith('Key Vault')), undefined);
  assert.equal(inline.runsOn.find((r) => r.what === 'Key Vault'), undefined);

  const ui = fakeUi({ answers: [true] });
  t.ctx.ui = ui.ui;
  await confirmPlan(t.ctx);
  assert.match(ui.text(), /Secret: {6}in the notebooks/);
});
