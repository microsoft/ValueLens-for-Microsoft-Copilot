// @ts-check
/**
 * Key Vault, the app registration and its secret, and admin consent.
 * Each step checks what is already there, so a re-run only does what is missing.
 */
import { permissionsFor } from '../catalog.js';
import { allowsAction, isPrivateVault, networkBlocked, ROLES } from '../clients/azure.js';
import { adminConsentUrl, apiPermissionsUrl, resolveAppRoles } from '../clients/graph.js';
import { HttpError } from '../http.js';
import { APP_NAME } from './plan.js';

/** @typedef {import('../install.js').Ctx} Ctx */

export const SECRET_LIFETIME_MONTHS = 12;

/** Preview permissions that some tenants don't have yet. Their module falls back gracefully. */
export const OPTIONAL_PERMISSIONS = ['CopilotPackages.Read.All'];

/** @param {unknown} err @param {number} status */
const isStatus = (err, status) => err instanceof HttpError && err.status === status;

/** @param {unknown} err */
const isNetworkBlock = (err) => err instanceof HttpError && err.status === 403 && networkBlocked(err.body ?? err.message);

/**
 * @param {Date} from
 * @param {number} months
 */
export function addMonths(from, months) {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Graph's service principal and the app roles ValueLens needs, looked up once per run.
 * @param {Ctx} ctx
 */
export async function graphRoles(ctx) {
  if (!ctx.graphRoles) {
    const sp = await ctx.api.graph.graphServicePrincipal();
    const { roles, missing } = resolveAppRoles(sp, permissionsFor(ctx.config.modules), OPTIONAL_PERMISSIONS);
    for (const m of missing) {
      ctx.ui.warn(`Microsoft Graph in this tenant has no ${m} permission yet. The Agent 365 registry will fall back to its CSV export.`);
    }
    ctx.graphRoles = { sp, roles };
  }
  return ctx.graphRoles;
}

/**
 * Creates or adopts the vault and makes sure the signed-in user can write secrets to it.
 * @param {Ctx} ctx
 */
export async function ensureKeyVault(ctx) {
  const { ui, config, api, user } = ctx;
  const kv = config.keyVault;
  if (kv.uri && kv.id) {
    const vault = await api.arm.getVault(kv.id).catch(() => null);
    if (vault) setPrivate(ctx, isPrivateVault(vault));
    ctx.save();
    ui.ok(`Key Vault ${kv.name} is ready`);
    return;
  }

  if (kv.existing) {
    if (!kv.id) throw new Error('The install record names an existing Key Vault but not its resource ID.');
    const vault = await api.arm.getVault(kv.id);
    kv.uri = vault.properties.vaultUri;
    kv.rbac = vault.properties.enableRbacAuthorization === true;
    kv.location = vault.location;
    setPrivate(ctx, isPrivateVault(vault));
    await grantSecretAccess(ctx, vault);
    ctx.save();
    ui.ok(`Using Key Vault ${kv.name}`);
    return;
  }

  const { subscriptionId, resourceGroup, name, location } = kv;
  if (!subscriptionId || !resourceGroup || !name || !location) {
    throw new Error('Key Vault settings are incomplete. Run the installer without --yes to choose them.');
  }
  if (await api.arm.ensureProvider(subscriptionId, 'Microsoft.KeyVault')) ui.ok('Registered the Microsoft.KeyVault resource provider');
  await api.arm.ensureResourceGroup(subscriptionId, resourceGroup, location);
  const vault = await api.arm.createVault({
    subscriptionId,
    resourceGroup,
    name,
    location,
    tenantId: user.tenantId,
    rbac: !!kv.rbac,
    accessPolicyObjectId: user.id,
  });
  kv.id = vault.id;
  kv.uri = vault.properties.vaultUri;
  kv.rbac = vault.properties.enableRbacAuthorization === true;
  ctx.save();
  ui.ok(`Created Key Vault ${name} in ${resourceGroup}`);
  setPrivate(ctx, isPrivateVault(vault));
  if (kv.rbac) {
    await api.arm.assignRole(/** @type {string} */ (kv.id), ROLES.keyVaultSecretsOfficer, user.id, 'User');
    ui.ok('Gave you Key Vault Secrets Officer on it');
  }
}

/**
 * Records whether the vault blocks public network access. A private vault gets its secret
 * through Resource Manager, and the workspace reaches it through a managed private endpoint.
 * @param {Ctx} ctx
 * @param {boolean} isPrivate
 */
function setPrivate(ctx, isPrivate) {
  const kv = ctx.config.keyVault;
  if (isPrivate && !kv.private) {
    ctx.ui.info(
      `${kv.name} blocks public network access (often set by Azure Policy). The installer saves the secret ` +
        'through Azure Resource Manager and connects the workspace to the vault with a managed private endpoint.',
    );
  }
  kv.private = isPrivate;
  ctx.save();
}

/**
 * @param {Ctx} ctx
 * @param {any} vault
 */
async function grantSecretAccess(ctx, vault) {
  const { ui, api, user } = ctx;
  if (vault.properties.enableRbacAuthorization) {
    try {
      const added = await api.arm.assignRole(vault.id, ROLES.keyVaultSecretsOfficer, user.id, 'User');
      if (added) ui.ok('Gave you Key Vault Secrets Officer on it');
      return;
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
    }
    const perms = await api.arm.permissions(vault.id).catch(() => []);
    if (allowsAction(perms, 'Microsoft.KeyVault/vaults/secrets/setSecret/action', 'dataActions')) return;
    throw new Error(`You can't write secrets to ${vault.name}. Ask its owner for the Key Vault Secrets Officer role, or let the installer create a new vault.`);
  }

  const policies = /** @type {any[]} */ (vault.properties.accessPolicies ?? []);
  const mine = policies.find((p) => p.objectId === user.id);
  const secrets = new Set((mine?.permissions?.secrets ?? []).map((/** @type {string} */ s) => s.toLowerCase()));
  if (['get', 'set'].every((s) => secrets.has(s) || secrets.has('all'))) return;
  try {
    await api.arm.addAccessPolicy(vault.id, user.tenantId, user.id);
    ui.ok('Added an access policy for you (secret get, list, set)');
  } catch (err) {
    if (!isStatus(err, 403)) throw err;
    throw new Error(`You can't change access policies on ${vault.name}. Ask its owner to give you secret get and set, or let the installer create a new vault.`);
  }
}

/**
 * Creates or adopts the app registration and its service principal, and puts a client secret in Key Vault.
 * @param {Ctx} ctx
 */
export async function ensureApp(ctx) {
  const { ui, config, api } = ctx;
  const app = config.app;
  const { roles } = await graphRoles(ctx);

  if (app.appId) {
    const application = await api.graph.findApplication(app.appId);
    if (!application) {
      throw new Error(
        app.existing
          ? `No app registration with ID ${app.appId} in this tenant.`
          : `The app registration ${app.appId} in the install record no longer exists. Delete the "app" section of the install record to create a new one.`,
      );
    }
    app.objectId = application.id;
    app.displayName = application.displayName;
    try {
      if (await api.graph.ensureRequiredAccess(application, roles)) ui.ok('Added the ValueLens permissions to its API permissions');
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
      ui.warn(`You can't edit ${application.displayName}'s API permissions. An admin must add these Graph application permissions: ${roles.map((r) => r.value).join(', ')}.`);
    }
    ui.ok(`Using app registration "${application.displayName}" (${app.appId})`);
  } else {
    /** @type {any} */
    let application;
    try {
      application = await api.graph.createApplication(APP_NAME, roles);
    } catch (err) {
      if (!isStatus(err, 403)) throw err;
      throw new Error(
        'You can\'t create app registrations in this tenant. Ask an admin to create one with the permissions in docs/PERMISSIONS.md, ' +
          'then run the installer again and choose "Use an app registration I already have".',
      );
    }
    app.appId = application.appId;
    app.objectId = application.id;
    app.displayName = application.displayName;
    app.existing = false;
    ctx.save();
    ui.ok(`Created app registration "${APP_NAME}" (${app.appId})`);
  }

  if (!app.servicePrincipalId) {
    const appId = /** @type {string} */ (app.appId);
    let sp = await api.graph.findServicePrincipal(appId);
    if (!sp) {
      sp = await api.graph.createServicePrincipal(appId);
      ui.ok('Created its service principal');
    }
    app.servicePrincipalId = sp.id;
  }
  ctx.save();

  await ensureSecret(ctx);
}

/** @param {Ctx} ctx */
async function ensureSecret(ctx) {
  const { ui, config } = ctx;
  const { app, keyVault: kv } = config;

  if (!ctx.pendingSecret && kv.secretSetAt) {
    if (await secretExists(ctx)) {
      ui.ok(`Client secret is in Key Vault as ${kv.secretName}`);
      return;
    }
    ui.warn(`Key Vault has no secret called ${kv.secretName} any more.`);
  }

  if (app.existing && !ctx.pendingSecret) {
    ctx.pendingSecret = await ui.secret(`Client secret value for ${app.displayName ?? app.appId}. It goes straight to Key Vault.`);
  }
  if (ctx.pendingSecret) {
    await writeSecret(ctx, ctx.pendingSecret, { contentType: `Client secret for ${app.appId}` });
    delete ctx.pendingSecret;
    kv.secretSetAt = ctx.now().toISOString();
    ctx.save();
    ui.ok(`Saved the client secret to Key Vault as ${kv.secretName}`);
    return;
  }
  await newSecret(ctx);
}

/**
 * Tries the vault's own endpoint first. If the vault turns out to block public access,
 * remembers that and goes through Resource Manager instead.
 * @template T
 * @param {Ctx} ctx
 * @param {(uri: string) => Promise<T>} direct
 * @param {(vaultId: string) => Promise<T>} viaArm
 * @returns {Promise<T>}
 */
async function onVault(ctx, direct, viaArm) {
  const kv = ctx.config.keyVault;
  if (!kv.private) {
    try {
      return await direct(/** @type {string} */ (kv.uri));
    } catch (err) {
      if (!isNetworkBlock(err)) throw err;
      setPrivate(ctx, true);
    }
  }
  if (!kv.id) throw new Error(`${kv.name} blocks public network access and the install record has no resource ID for it.`);
  return viaArm(kv.id);
}

/** @param {Ctx} ctx */
const secretExists = (ctx) =>
  onVault(
    ctx,
    (uri) => ctx.api.keyVault.secretExists(uri, ctx.config.keyVault.secretName),
    (id) => ctx.api.arm.secretExists(id, ctx.config.keyVault.secretName),
  );

/**
 * @param {Ctx} ctx
 * @param {string} value
 * @param {{ expires?: Date, contentType?: string }} o
 */
const writeSecret = (ctx, value, o) =>
  onVault(
    ctx,
    (uri) => ctx.api.keyVault.setSecret(uri, ctx.config.keyVault.secretName, value, o),
    (id) => ctx.api.arm.setSecret(id, ctx.config.keyVault.secretName, value, o),
  );

/**
 * Makes sure a new secret will have somewhere to go before it is created. Waits out a
 * new role assignment; a private vault needs write access through Resource Manager.
 * @param {Ctx} ctx
 */
async function checkSecretAccess(ctx) {
  const { api, config } = ctx;
  const kv = config.keyVault;
  await onVault(
    ctx,
    (uri) => api.keyVault.waitForAccess(uri, kv.secretName),
    async (id) => {
      const perms = await api.arm.permissions(id).catch(() => null);
      if (perms && !allowsAction(perms, 'Microsoft.KeyVault/vaults/secrets/write')) {
        throw new Error(
          `${kv.name} blocks public network access, so the installer saves the secret through Azure Resource Manager. ` +
            'That needs Contributor or Key Vault Contributor on the vault. Ask its owner, then run the installer again.',
        );
      }
    },
  );
}

/**
 * Adds a client secret to the app and writes it straight to Key Vault. It is never printed or saved elsewhere.
 * @param {Ctx} ctx
 */
export async function newSecret(ctx) {
  const { ui, config, api } = ctx;
  const { app, keyVault: kv } = config;
  if (!app.objectId) {
    const application = app.appId ? await api.graph.findApplication(app.appId) : null;
    if (!application) throw new Error('No app registration to add a secret to.');
    app.objectId = application.id;
  }
  const objectId = /** @type {string} */ (app.objectId);
  await checkSecretAccess(ctx);
  const credential = await api.graph.addPassword(objectId, addMonths(ctx.now(), SECRET_LIFETIME_MONTHS));
  try {
    await writeSecret(ctx, credential.secretText, {
      expires: new Date(credential.endDateTime),
      contentType: `Client secret for ${app.appId}`,
    });
  } catch (err) {
    const removed = await api.graph.removePassword(objectId, credential.keyId).then(
      () => true,
      () => false,
    );
    throw new Error(
      `The app's new client secret couldn't be saved to Key Vault (${/** @type {Error} */ (err).message}). ` +
        (removed
          ? 'It has been removed from the app again, and was never shown or stored anywhere else.'
          : `It was not shown or stored anywhere else. Delete the unused one (key ${credential.keyId}) from the app's Certificates & secrets page.`),
    );
  }
  app.secretExpires = credential.endDateTime;
  kv.secretSetAt = ctx.now().toISOString();
  ctx.save();
  ui.ok(`Created a client secret and saved it to Key Vault as ${kv.secretName} (expires ${credential.endDateTime.slice(0, 10)})`);
}

/**
 * Grants the Graph application permissions, or hands the user a link for an admin.
 * Returns true when every permission is consented.
 * @param {Ctx} ctx
 * @param {{ canConsent: boolean }} who
 */
export async function ensureConsent(ctx, who) {
  const { ui, config, api } = ctx;
  const app = config.app;
  const spId = /** @type {string} */ (app.servicePrincipalId);
  const appId = /** @type {string} */ (app.appId);
  const { sp: graphSp, roles } = await graphRoles(ctx);

  const missing = async () => {
    const assigned = await api.graph.appRoleAssignments(spId);
    const have = new Set(assigned.filter((a) => a.resourceId === graphSp.id).map((a) => a.appRoleId));
    return roles.filter((r) => !have.has(r.id));
  };

  let todo = await missing();
  if (!todo.length) {
    ui.ok(`Admin consent is in place (${roles.map((r) => r.value).join(', ')})`);
    return true;
  }

  if (who.canConsent) {
    for (const role of todo) await api.graph.grantAppRole(graphSp.id, spId, role.id);
    ui.ok(`Granted admin consent: ${todo.map((r) => r.value).join(', ')}`);
    return true;
  }

  ui.warn(`A Global Administrator or Privileged Role Administrator needs to approve: ${todo.map((r) => r.value).join(', ')}`);
  ui.info(`Send them this page and ask them to select "Grant admin consent":`);
  ui.info(apiPermissionsUrl(appId));
  ui.note(`Or the direct consent link: ${adminConsentUrl(ctx.user.tenantId, appId)}`);
  if (ui.yes) {
    ui.warn('Carrying on without consent. Data loads will fail until it is granted.');
    return false;
  }
  for (;;) {
    const next = await ui.select(
      'Once they have approved it:',
      [
        { name: 'Check again', value: 'check' },
        { name: 'Carry on without it (skip the first load for now)', value: 'skip' },
      ],
      'check',
    );
    if (next === 'skip') return false;
    todo = await missing();
    if (!todo.length) {
      ui.ok('Admin consent is in place');
      return true;
    }
    ui.warn(`Still waiting for: ${todo.map((r) => r.value).join(', ')}`);
  }
}
