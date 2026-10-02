// @ts-check
/** Microsoft Graph calls for the app registration and the signed-in user's roles. */
import { GRAPH_APP_ID } from '../catalog.js';
import { HttpError } from '../http.js';

/** Directory roles that can grant admin consent for Microsoft Graph application permissions. */
export const CONSENT_ROLES = {
  '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
  'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
};

/** Roles that can create app registrations even when users can't. */
export const APP_ROLES = {
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3': 'Application Administrator',
  '158c047a-c907-4556-b7ef-446551a6b5f7': 'Cloud Application Administrator',
};

/**
 * Maps permission names to Graph app role IDs. A missing required permission is an
 * error; a missing optional one is returned in `missing` so the caller can warn.
 * @param {{ appRoles: { id: string, value: string }[] }} graphSp
 * @param {string[]} permissions
 * @param {string[]} [optional]  Names that may be absent in some tenants (e.g. preview permissions).
 */
export function resolveAppRoles(graphSp, permissions, optional = []) {
  const byValue = new Map(graphSp.appRoles.map((r) => [r.value, r.id]));
  const absent = permissions.filter((p) => !byValue.has(p));
  const fatal = absent.filter((p) => !optional.includes(p));
  if (fatal.length) throw new Error(`Microsoft Graph in this tenant has no application permission named ${fatal.join(', ')}.`);
  const roles = permissions.filter((p) => byValue.has(p)).map((p) => ({ value: p, id: /** @type {string} */ (byValue.get(p)) }));
  return { roles, missing: absent };
}

/**
 * Direct admin-consent link. Entra may show a reply-address error after approval
 * because the app has no redirect URI; the consent still applies.
 * @param {string} tenantId
 * @param {string} appId
 */
export function adminConsentUrl(tenantId, appId) {
  return `https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${appId}`;
}

/**
 * The app's "API permissions" page in the Entra admin center, with the
 * "Grant admin consent" button.
 * @param {string} appId
 */
export function apiPermissionsUrl(appId) {
  return `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${appId}`;
}

/**
 * Entra takes a little while to replicate a new app and service principal, so
 * "not found" style 400/404 answers are retried for up to two minutes.
 * @type {import('../http.js').RequestOptions}
 */
const replicationRetry = {
  maxRetries: 20,
  maxWaitMs: 120_000,
  retryIf: (status, data) => (status === 400 || status === 404) && !/already exists/i.test(JSON.stringify(data ?? '')),
};

/** @param {import('../http.js').HttpClient} http */
export function graphApi(http) {
  /** @param {string} path */
  async function getOrNull(path) {
    try {
      return await http.get(path);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  return {
    me: () => http.get('/me', { query: { $select: 'id,displayName,userPrincipalName' } }),
    organization: async () => (await http.get('/organization', { query: { $select: 'id,displayName' } })).value?.[0],
    /** @returns {Promise<{ roleTemplateId: string, displayName: string }[]>} */
    myDirectoryRoles: () =>
      http.list('/me/transitiveMemberOf/microsoft.graph.directoryRole', { query: { $select: 'roleTemplateId,displayName' } }),
    /** Whether ordinary users may register apps. */
    usersCanRegisterApps: async () => {
      const policy = await http.get('/policies/authorizationPolicy');
      return policy?.defaultUserRolePermissions?.allowedToCreateApps !== false;
    },

    graphServicePrincipal: () =>
      http.get(`/servicePrincipals(appId='${GRAPH_APP_ID}')`, { query: { $select: 'id,appId,appRoles' } }),

    /** @param {string} appId */
    findApplication: (appId) => getOrNull(`/applications(appId='${appId}')`),
    /** @param {string} appId */
    findServicePrincipal: (appId) => getOrNull(`/servicePrincipals(appId='${appId}')`),

    /**
     * @param {string} displayName
     * @param {{ id: string }[]} appRoles
     */
    createApplication: (displayName, appRoles) =>
      http.post('/applications', {
        displayName,
        signInAudience: 'AzureADMyOrg',
        notes: 'Created by the ValueLens installer. Reads Copilot audit, usage report and directory data for ValueLens.',
        requiredResourceAccess: [{ resourceAppId: GRAPH_APP_ID, resourceAccess: appRoles.map((r) => ({ id: r.id, type: 'Role' })) }],
      }),
    /**
     * Adds Graph app roles to the app's required permissions, keeping what is there.
     * @param {any} application
     * @param {{ id: string }[]} appRoles
     */
    async ensureRequiredAccess(application, appRoles) {
      const current = /** @type {any[]} */ (application.requiredResourceAccess ?? []);
      const graph = current.find((r) => r.resourceAppId === GRAPH_APP_ID) ?? { resourceAppId: GRAPH_APP_ID, resourceAccess: [] };
      const have = new Set(graph.resourceAccess.map((/** @type {any} */ a) => a.id));
      const add = appRoles.filter((r) => !have.has(r.id));
      if (!add.length) return false;
      graph.resourceAccess = [...graph.resourceAccess, ...add.map((r) => ({ id: r.id, type: 'Role' }))];
      const others = current.filter((r) => r.resourceAppId !== GRAPH_APP_ID);
      await http.patch(`/applications/${application.id}`, { requiredResourceAccess: [...others, graph] });
      return true;
    },

    /** New apps take a few seconds to replicate, so 400/404 are retried briefly. @param {string} appId */
    createServicePrincipal: (appId) => http.post('/servicePrincipals', { appId }, replicationRetry),

    /**
     * @param {string} applicationObjectId
     * @param {Date} endDateTime
     * @returns {Promise<{ secretText: string, endDateTime: string, keyId: string }>}
     */
    addPassword: (applicationObjectId, endDateTime) =>
      http.post(`/applications/${applicationObjectId}/addPassword`, {
        passwordCredential: { displayName: 'ValueLens installer', endDateTime: endDateTime.toISOString() },
      }),
    /** @param {string} applicationObjectId @param {string} keyId */
    removePassword: (applicationObjectId, keyId) => http.post(`/applications/${applicationObjectId}/removePassword`, { keyId }),

    /** @param {string} servicePrincipalId */
    appRoleAssignments: (servicePrincipalId) => http.list(`/servicePrincipals/${servicePrincipalId}/appRoleAssignments`),

    /**
     * Grants one application permission (admin consent for that role).
     * @param {string} resourceId  Graph's service principal ID.
     * @param {string} principalId  Our app's service principal ID.
     * @param {string} appRoleId
     */
    grantAppRole: (resourceId, principalId, appRoleId) =>
      http.post(`/servicePrincipals/${resourceId}/appRoleAssignedTo`, { principalId, resourceId, appRoleId }, replicationRetry),
  };
}

/** @typedef {ReturnType<typeof graphApi>} GraphApi */
