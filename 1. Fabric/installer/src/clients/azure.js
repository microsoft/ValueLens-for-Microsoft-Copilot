// @ts-check
/** Azure Resource Manager and Key Vault calls for storing the client secret. */
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';

export const KEY_VAULT_API = '2023-07-01';
const RESOURCES_API = '2021-04-01';
const SUBSCRIPTIONS_API = '2022-12-01';
const AUTHORIZATION_API = '2022-04-01';
const DEPLOYMENTS_API = '2022-09-01';
const CONTAINER_APPS_API = '2024-03-01';
const RESOURCE_GRAPH_API = '2022-10-01';

export const ROLES = {
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7',
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6',
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7',
  costManagementReader: '72fafb9e-0641-4937-9268-a91bfd8191a3',
  monitoringReader: '43d0d8ad-25c7-4714-9337-8ba259a9fe05',
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
  owner: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
  userAccessAdministrator: '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9',
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

/**
 * Polls an ARM deployment until it finishes. The deployment PUT answers 200/201 while it is still
 * running, so the generic 202 long-running-operation handling doesn't wait for it.
 * @param {() => Promise<any>} get  Reads the deployment.
 * @param {any} first  The PUT response.
 * @param {{ sleep?: (ms: number) => Promise<void>, pollMs?: number, timeoutMs?: number }} [opts]
 */
export async function waitForDeployment(get, first, opts = {}) {
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
  let d = first;
  for (;;) {
    const state = String(d?.properties?.provisioningState ?? 'Succeeded');
    if (state === 'Succeeded') return d;
    if (state === 'Failed' || state === 'Canceled') {
      const e = d?.properties?.error;
      const detail = (e?.details ?? []).map((/** @type {any} */ x) => `${x.code}: ${x.message}`).join('; ');
      const err = new Error(`ARM deployment ${d?.name ?? ''} ${state.toLowerCase()}: ${e?.code ?? ''} ${e?.message ?? ''}${detail ? ` (${detail})` : ''}`.trim());
      /** @type {any} */ (err).body = { error: e };
      throw err;
    }
    if (Date.now() > deadline) throw new Error(`ARM deployment ${d?.name ?? ''} is still ${state} after the timeout.`);
    await sleep(opts.pollMs ?? 10_000);
    d = await get();
  }
}

/** @param {import('../http.js').HttpClient} http @param {{ sleep?: (ms: number) => Promise<void>, pollMs?: number }} [opts] */
export function armApi(http, opts = {}) {
  return {
    listSubscriptions: () => http.list('/subscriptions', { query: { 'api-version': SUBSCRIPTIONS_API } }),

    /** @param {string} subscriptionId */
    listLocations: (subscriptionId) => http.list(`/subscriptions/${subscriptionId}/locations`, { query: { 'api-version': SUBSCRIPTIONS_API } }),

    /** @param {string} subscriptionId */
    listResourceGroups: (subscriptionId) => http.list(`/subscriptions/${subscriptionId}/resourcegroups`, { query: { 'api-version': RESOURCES_API } }),

    /** @param {string} subscriptionId @param {string} name */
    getResourceGroup: async (subscriptionId, name) => {
      try {
        return await http.get(`/subscriptions/${subscriptionId}/resourcegroups/${name}`, { query: { 'api-version': RESOURCES_API } });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },

    /**
     * Whether this subscription may create Azure SQL servers in a region. Restricted regions
     * come back with status "Visible" and a reason; ARM would only fail mid-deploy.
     * @param {string} subscriptionId @param {string} location
     * @returns {Promise<{ status?: string, reason?: string }>}
     */
    sqlCapability: (subscriptionId, location) =>
      http.get(`/subscriptions/${subscriptionId}/providers/Microsoft.Sql/locations/${location}/capabilities`, { query: { 'api-version': '2023-08-01-preview', include: 'supportedEditions' } }),

    /** @param {string} scope  e.g. /subscriptions/{id} */
    permissions: (scope) => http.list(`${scope}/providers/Microsoft.Authorization/permissions`, { query: { 'api-version': AUTHORIZATION_API } }),

    /**
     * Role assignments at or above `scope` for these principals (the user and their groups).
     * The assignedTo filter is re-checked here: only rows whose principalId is one of `principalIds` are kept.
     * @param {string} scope
     * @param {string[]} principalIds  The user's ID first.
     * @returns {Promise<{ properties: { roleDefinitionId: string, principalId: string, scope?: string } }[]>}
     */
    myRoleAssignments: async (scope, principalIds) => {
      const ids = new Set(principalIds);
      const rows = await http.list(`${scope}/providers/Microsoft.Authorization/roleAssignments`, {
        query: { 'api-version': AUTHORIZATION_API, $filter: `assignedTo('${principalIds[0]}')` },
      });
      return rows.filter((r) => ids.has(r.properties?.principalId));
    },

    /**
     * Azure roles at `scope` the user could activate through PIM, kept only for these principals.
     * @param {string} scope
     * @param {string[]} principalIds
     * @returns {Promise<{ properties: { roleDefinitionId: string, principalId: string } }[]>}
     */
    myEligibleRoles: async (scope, principalIds) => {
      const ids = new Set(principalIds);
      const rows = await http.list(`${scope}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances`, {
        query: { 'api-version': '2020-10-01', $filter: 'asTarget()' },
      });
      return rows.filter((r) => ids.has(r.properties?.principalId));
    },

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

    /**
     * Registers a subscription feature flag, then re-registers its provider so the change takes effect.
     * @param {string} subscriptionId @param {string} namespace @param {string} name
     */
    async ensureFeature(subscriptionId, namespace, name) {
      const path = `/subscriptions/${subscriptionId}/providers/Microsoft.Features/providers/${namespace}/features/${name}`;
      const q = { query: { 'api-version': '2021-07-01' } };
      const f = await http.get(path, q);
      if (f.properties?.state === 'Registered') return false;
      await http.post(`${path}/register`, undefined, q);
      for (let i = 0; i < 60; i++) {
        const s = await http.get(path, q);
        if (s.properties?.state === 'Registered') {
          await http.post(`/subscriptions/${subscriptionId}/providers/${namespace}/register`, undefined, { query: { 'api-version': RESOURCES_API } });
          return true;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error(`Timed out registering the ${namespace}/${name} feature.`);
    },

    /** @param {string} subscriptionId @param {string} name @param {string} location */
    ensureResourceGroup: (subscriptionId, name, location, tags = {}) =>
      http.put(`/subscriptions/${subscriptionId}/resourcegroups/${name}`, { location, tags: { app: 'ValueLens', ...tags } }, { query: { 'api-version': RESOURCES_API } }),

    /** @param {string} subscriptionId @param {string} resourceGroup */
    listResources: (subscriptionId, resourceGroup) =>
      http.list(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/resources`, { query: { 'api-version': RESOURCES_API } }),

    /** @param {string} id */
    deleteResource: (id) => http.del(id, { query: { 'api-version': RESOURCES_API } }),

    /** @param {string} subscriptionId @param {string} resourceGroup */
    deleteResourceGroup: (subscriptionId, resourceGroup) =>
      http.del(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}`, { query: { 'api-version': RESOURCES_API } }),

    /**
     * Validates an ARM template deployment at resource-group scope.
     * @param {string} subscriptionId @param {string} resourceGroup @param {string} name @param {any} deployment
     */
    validateDeployment: (subscriptionId, resourceGroup, name, deployment) =>
      http.post(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${name}/validate`, deployment, {
        query: { 'api-version': DEPLOYMENTS_API },
      }),

    /**
     * Runs ARM what-if for an incremental deployment.
     * @param {string} subscriptionId @param {string} resourceGroup @param {string} name @param {any} deployment
     */
    whatIfDeployment: (subscriptionId, resourceGroup, name, deployment) =>
      http.requestLro('POST', `/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${name}/whatIf`, {
        query: { 'api-version': DEPLOYMENTS_API },
        body: deployment,
        lroResult: true,
      }),

    /**
     * Creates or updates an ARM template deployment.
     * @param {string} subscriptionId @param {string} resourceGroup @param {string} name @param {any} deployment
     */
    deployTemplate: async (subscriptionId, resourceGroup, name, deployment) => {
      const path = `/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${name}`;
      const first = await http.requestLro('PUT', path, { query: { 'api-version': DEPLOYMENTS_API }, body: deployment, lroResult: true });
      return waitForDeployment(() => http.get(path, { query: { 'api-version': DEPLOYMENTS_API } }), first, opts);
    },

    /** @param {string} subscriptionId @param {string} resourceGroup @param {string} serverName @param {string} databaseName */
    async getSqlDatabase(subscriptionId, resourceGroup, serverName, databaseName) {
      try {
        return await http.get(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.Sql/servers/${serverName}/databases/${databaseName}`, {
          query: { 'api-version': '2023-08-01' },
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },

    /** @param {string} subscriptionId @param {string} resourceGroup @param {string} name */
    getContainerAppJob: (subscriptionId, resourceGroup, name) =>
      http.get(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.App/jobs/${name}`, {
        query: { 'api-version': CONTAINER_APPS_API },
      }),

    /**
     * Starts one execution of a job. With a template, this execution runs those containers instead
     * of the job's own: Container Apps doesn't merge them.
     * @param {string} subscriptionId @param {string} resourceGroup @param {string} name
     * @param {{ containers: any[], initContainers?: any[] }} [template]
     */
    startContainerAppJob: (subscriptionId, resourceGroup, name, template) =>
      http.post(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.App/jobs/${name}/start`, template, {
        query: { 'api-version': CONTAINER_APPS_API },
      }),

    /** @param {string} subscriptionId @param {string} resourceGroup @param {string} name @param {string} executionName */
    getContainerAppJobExecution: (subscriptionId, resourceGroup, name, executionName) =>
      http.get(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.App/jobs/${name}/executions/${executionName}`, {
        query: { 'api-version': CONTAINER_APPS_API },
      }),

    /** @param {string} subscriptionId @param {string} resourceGroup @param {string} name */
    listContainerAppJobExecutions: (subscriptionId, resourceGroup, name) =>
      http.list(`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/Microsoft.App/jobs/${name}/executions`, {
        query: { 'api-version': CONTAINER_APPS_API },
      }),

    /** @param {string} subscriptionId */
    listVaults: (subscriptionId) =>
      http.list(`/subscriptions/${subscriptionId}/providers/Microsoft.KeyVault/vaults`, { query: { 'api-version': KEY_VAULT_API } }),

    /** Azure OpenAI, AI Foundry and other AI services accounts. @param {string} subscriptionId */
    listAiAccounts: (subscriptionId) =>
      http.list(`/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts`, { query: { 'api-version': '2023-05-01' }, maxRetries: 1 }),

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
    /**
     * A secret's content type, or null if there is no such secret. Resource Manager never returns the value.
     * @param {string} vaultId
     * @param {string} name
     * @returns {Promise<{ contentType?: string } | null>}
     */
    async secretInfo(vaultId, name) {
      try {
        const res = await http.get(`${vaultId}/secrets/${name}`, { query: { 'api-version': KEY_VAULT_API } });
        return { contentType: res?.properties?.contentType };
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
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

    /**
     * Gives a user secret permissions on an access-policy vault: get/list/set unless told otherwise.
     * @param {string} vaultId @param {string} tenantId @param {string} objectId @param {string[]} [secrets]
     */
    addAccessPolicy: (vaultId, tenantId, objectId, secrets = ['get', 'list', 'set']) =>
      http.put(
        `${vaultId}/accessPolicies/add`,
        { properties: { accessPolicies: [{ tenantId, objectId, permissions: { secrets } }] } },
        { query: { 'api-version': KEY_VAULT_API } },
      ),

    /**
     * Assigns a role at `scope`, a subscription or below, or a management group. Returns false if it was already there.
     * @param {string} scope
     * @param {string} roleId
     * @param {string} principalId
     * @param {'User' | 'ServicePrincipal' | 'Group'} principalType
     */
    async assignRole(scope, roleId, principalId, principalType) {
      const definitions = /^\/subscriptions\//i.test(scope) ? `/subscriptions/${scope.split('/')[2]}` : scope;
      try {
        await http.put(
          `${scope}/providers/Microsoft.Authorization/roleAssignments/${randomUUID()}`,
          {
            properties: {
              roleDefinitionId: `${definitions}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
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

    /**
     * Runs a Resource Graph query as the signed-in user, across a management group or everything they can see.
     * @param {string} query
     * @param {string} [managementGroup]
     * @returns {Promise<{ totalRecords?: number, data?: any[] }>}
     */
    resourceGraph: (query, managementGroup) =>
      http.post(
        '/providers/Microsoft.ResourceGraph/resources',
        { query, ...(managementGroup ? { managementGroups: [managementGroup] } : {}), options: { resultFormat: 'objectArray' } },
        { query: { 'api-version': RESOURCE_GRAPH_API } },
      ),
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
    /**
     * A secret's content type, or null if there is no such secret. The value in the reply is dropped.
     * @param {string} vaultUri
     * @param {string} name
     * @returns {Promise<{ contentType?: string } | null>}
     */
    async secretInfo(vaultUri, name) {
      try {
        const res = await http.get(`${vaultUri.replace(/\/$/, '')}/secrets/${name}`, { query: { 'api-version': '7.4' } });
        return { contentType: res?.contentType };
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

/** @typedef {ReturnType<typeof keyVaultApi>} KeyVaultApi */
