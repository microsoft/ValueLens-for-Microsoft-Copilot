// @ts-check
/** Azure Resource Manager and Key Vault calls for storing the client secret. */
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';

export const KEY_VAULT_API = '2023-07-01';
const RESOURCES_API = '2021-04-01';
const SUBSCRIPTIONS_API = '2022-12-01';
const AUTHORIZATION_API = '2022-04-01';

export const ROLES = {
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7',
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6',
};

/**
 * Whether an ARM permission set allows `action` (wildcards as in role definitions).
 * @param {{ actions?: string[], notActions?: string[], dataActions?: string[], notDataActions?: string[] }[]} permissions
 * @param {string} action
 * @param {'actions' | 'dataActions'} [kind]
 */
export function allowsAction(permissions, action, kind = 'actions') {
  const match = (/** @type {string} */ pattern) =>
    new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`, 'i').test(action);
  const not = kind === 'actions' ? 'notActions' : 'notDataActions';
  return permissions.some((p) => (p[kind] ?? []).some(match) && !(p[not] ?? []).some(match));
}

/**
 * Whether a vault blocks public traffic, so Fabric can only reach it through a
 * managed private endpoint. Azure Policy often forces this on new vaults.
 * @param {any} vault  ARM vault resource.
 */
export function isPrivateVault(vault) {
  const p = vault?.properties ?? {};
  return p.publicNetworkAccess === 'Disabled' || p.networkAcls?.defaultAction === 'Deny';
}

const NETWORK_BLOCK = /ForbiddenByConnection|ForbiddenByFirewall|public network access is disabled|not authorized by firewall|client address is not authorized/i;

/**
 * Key Vault answers 403 both for a missing role and for a network block. Only the
 * first is worth waiting on.
 * @param {unknown} body  The error response body.
 */
export const networkBlocked = (body) => NETWORK_BLOCK.test(typeof body === 'string' ? body : JSON.stringify(body ?? ''));

/** @type {(status: number, data: any) => boolean} */
const awaitingRole = (status, data) => status === 403 && !networkBlocked(data);

/**
 * Key Vault names: 3-24 characters, letters, digits and hyphens, starting with a
 * letter, ending with a letter or digit, no double hyphens.
 * @param {string} name
 * @returns {true | string}
 */
export function validateVaultName(name) {
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(name)) return 'Use 3-24 letters, digits or hyphens, starting with a letter.';
  if (name.includes('--')) return 'No double hyphens.';
  return true;
}

/** "UK South" or "uksouth" -> "uksouth". @param {string} region */
export function armLocation(region) {
  return region.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** @param {string} id  ARM resource ID. */
export function parseResourceId(id) {
  const m = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/([^/]+\/[^/]+)\/([^/]+)$/i.exec(id);
  if (!m) throw new Error(`Not a resource ID: ${id}`);
  return { subscriptionId: m[1], resourceGroup: m[2], type: m[3], name: m[4] };
}

/** @param {import('../http.js').HttpClient} http */
export function armApi(http) {
  return {
    listSubscriptions: () => http.list('/subscriptions', { query: { 'api-version': SUBSCRIPTIONS_API } }),

    /** @param {string} scope  e.g. /subscriptions/{id} */
    permissions: (scope) => http.list(`${scope}/providers/Microsoft.Authorization/permissions`, { query: { 'api-version': AUTHORIZATION_API } }),

    /**
     * Registers a resource provider in the subscription. Returns true if it had to.
     * @param {string} subscriptionId
     * @param {string} namespace  e.g. Microsoft.KeyVault
     */
    async ensureProvider(subscriptionId, namespace) {
      const path = `/subscriptions/${subscriptionId}/providers/${namespace}`;
      const p = await http.get(path, { query: { 'api-version': RESOURCES_API } });
      if (p.registrationState === 'Registered') return false;
      await http.post(`${path}/register`, undefined, { query: { 'api-version': RESOURCES_API } });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await http.get(path, { query: { 'api-version': RESOURCES_API } });
        if (s.registrationState === 'Registered') return true;
      }
      throw new Error(`Timed out registering the ${namespace} resource provider.`);
    },

    /** @param {string} subscriptionId @param {string} name @param {string} location */
    ensureResourceGroup: (subscriptionId, name, location) =>
      http.put(`/subscriptions/${subscriptionId}/resourcegroups/${name}`, { location, tags: { app: 'ValueLens' } }, { query: { 'api-version': RESOURCES_API } }),

    /** @param {string} subscriptionId */
    listVaults: (subscriptionId) =>
      http.list(`/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/vaults`, { query: { 'api-version': KEY_VAULT_API } }),

    /** @param {string} subscriptionId @param {string} name @returns {Promise<{ nameAvailable: boolean, message?: string }>} */
    checkVaultName: (subscriptionId, name) =>
      http.post(
        `/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/checkNameAvailability`,
        { name, type: 'Microsoft.KeyVault/vaults' },
        { query: { 'api-version': KEY_VAULT_API } },
      ),

    /**
     * Creates a vault. With RBAC off, `accessPolicyObjectId` gets secret get/list/set.
     * @param {{ subscriptionId: string, resourceGroup: string, name: string, location: string, tenantId: string, rbac: boolean, accessPolicyObjectId?: string }} v
     */
    async createVault(v) {
      const id = `/subscriptions/${v.subscriptionId}/resourceGroups/${v.resourceGroup}/providers/Microsoft.KeyVault/vaults/${v.name}`;
      /** @type {Record<string, any>} */
      const properties = {
        tenantId: v.tenantId,
        sku: { family: 'A', name: 'standard' },
        enableRbacAuthorization: v.rbac,
        enableSoftDelete: true,
        softDeleteRetentionInDays: 90,
        accessPolicies: v.rbac
          ? []
          : [{ tenantId: v.tenantId, objectId: v.accessPolicyObjectId, permissions: { secrets: ['get', 'list', 'set'] } }],
      };
      await http.put(id, { location: v.location, tags: { app: 'ValueLens' }, properties }, { query: { 'api-version': KEY_VAULT_API } });
      for (let i = 0; i < 60; i++) {
        const vault = await http.get(id, { query: { 'api-version': KEY_VAULT_API } });
        const state = vault.properties?.provisioningState;
        if (state === 'Succeeded' || state === undefined) return vault;
        if (state === 'Failed') throw new Error(`Key Vault ${v.name} failed to provision.`);
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error(`Timed out waiting for Key Vault ${v.name}.`);
    },

    /** @param {string} vaultId */
    getVault: (vaultId) => http.get(vaultId, { query: { 'api-version': KEY_VAULT_API } }),

    /**
     * Writes a secret through Resource Manager rather than the vault's own endpoint, so it
     * works when the vault blocks public access. Needs Microsoft.KeyVault/vaults/secrets/write
     * (e.g. Contributor on the vault), not a data-plane role.
     * @param {string} vaultId
     * @param {string} name
     * @param {string} value
     * @param {{ expires?: Date, contentType?: string }} [o]
     */
    setSecret: (vaultId, name, value, o = {}) =>
      http.put(
        `${vaultId}/secrets/${name}`,
        {
          properties: {
            value,
            contentType: o.contentType,
            attributes: o.expires ? { exp: Math.floor(o.expires.getTime() / 1000) } : undefined,
          },
          tags: { app: 'ValueLens' },
        },
        { query: { 'api-version': KEY_VAULT_API } },
      ),
    /** Reads a secret's metadata (never its value) through Resource Manager. @param {string} vaultId @param {string} name */
    async secretExists(vaultId, name) {
      try {
        await http.get(`${vaultId}/secrets/${name}`, { query: { 'api-version': KEY_VAULT_API } });
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false;
        throw err;
      }
    },

    /** @param {string} vaultId @returns {Promise<any[]>} */
    listPrivateEndpointConnections: (vaultId) => http.list(`${vaultId}/privateEndpointConnections`, { query: { 'api-version': KEY_VAULT_API } }),
    /** @param {string} connectionId  Full resource ID of the connection. @param {string} description */
    approvePrivateEndpointConnection: (connectionId, description) =>
      http.put(
        connectionId,
        { properties: { privateLinkServiceConnectionState: { status: 'Approved', description } } },
        { query: { 'api-version': KEY_VAULT_API } },
      ),

    /** Gives a user secret get/list/set on an access-policy vault. @param {string} vaultId @param {string} tenantId @param {string} objectId */
    addAccessPolicy: (vaultId, tenantId, objectId) =>
      http.put(
        `${vaultId}/accessPolicies/add`,
        { properties: { accessPolicies: [{ tenantId, objectId, permissions: { secrets: ['get', 'list', 'set'] } }] } },
        { query: { 'api-version': KEY_VAULT_API } },
      ),

    /**
     * Assigns a role at `scope`. Returns false if it was already there.
     * @param {string} scope
     * @param {string} roleId
     * @param {string} principalId
     * @param {'User' | 'ServicePrincipal' | 'Group'} principalType
     */
    async assignRole(scope, roleId, principalId, principalType) {
      const subscriptionId = scope.split('/')[2];
      try {
        await http.put(
          `${scope}/providers/Microsoft.Authorization/roleAssignments/${randomUUID()}`,
          {
            properties: {
              roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
              principalId,
              principalType,
            },
          },
          { query: { 'api-version': AUTHORIZATION_API } },
        );
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 409 && err.code === 'RoleAssignmentExists') return false;
        throw err;
      }
    },
  };
}

/** @typedef {ReturnType<typeof armApi>} ArmApi */

/**
 * Key Vault data plane. The first call after a new role assignment can take a few
 * minutes to be allowed, so a 403 for a missing role is retried for up to ten minutes.
 * A 403 for a network block fails at once.
 * @param {import('../http.js').HttpClient} http  A client with an absolute-URL base.
 */
export function keyVaultApi(http) {
  const waitForRole = { retryIf: awaitingRole, maxRetries: 40, maxWaitMs: 10 * 60_000 };
  return {
    /**
     * Returns once the signed-in user can use the vault's secrets. Call it before making
     * a secret that has nowhere else to go.
     * @param {string} vaultUri
     * @param {string} name
     */
    async waitForAccess(vaultUri, name) {
      try {
        await http.get(`${vaultUri.replace(/\/$/, '')}/secrets/${name}`, { query: { 'api-version': '7.4' }, ...waitForRole });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return;
        throw err;
      }
    },
    /**
     * @param {string} vaultUri  e.g. https://name.vault.azure.net/
     * @param {string} name
     * @param {string} value
     * @param {{ expires?: Date, contentType?: string }} [o]
     */
    setSecret: (vaultUri, name, value, o = {}) =>
      http.put(
        `${vaultUri.replace(/\/$/, '')}/secrets/${name}`,
        {
          value,
          contentType: o.contentType,
          attributes: o.expires ? { exp: Math.floor(o.expires.getTime() / 1000) } : undefined,
          tags: { app: 'ValueLens' },
        },
        { query: { 'api-version': '7.4' }, ...waitForRole },
      ),
    /** @param {string} vaultUri @param {string} name */
    async secretExists(vaultUri, name) {
      try {
        await http.get(`${vaultUri.replace(/\/$/, '')}/secrets/${name}`, { query: { 'api-version': '7.4' } });
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false;
        throw err;
      }
    },
  };
}

/** @typedef {ReturnType<typeof keyVaultApi>} KeyVaultApi */
