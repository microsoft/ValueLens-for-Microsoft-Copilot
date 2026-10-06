// @ts-check
/** Microsoft Graph calls for the app registration and the signed-in user's roles. */
import crypto from 'node:crypto';
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

export const POWER_BI_APP_ID = '00000009-0000-0000-c000-000000000000';

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
    servicePrincipalByAppId: (appId) =>
      http.get(`/servicePrincipals(appId='${appId}')`, { query: { $select: 'id,appId,appRoles,oauth2PermissionScopes' } }),

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
        notes: 'Created by the Analytics Hub installer. Reads Copilot audit, usage report and directory data for ValueLens.',
        requiredResourceAccess: appRoles.length ? [{ resourceAppId: GRAPH_APP_ID, resourceAccess: appRoles.map((r) => ({ id: r.id, type: 'Role' })) }] : [],
      }),
    /**
     * Creates the Azure-hosted web application registration.
     * @param {{ displayName: string, fqdn: string, pbiScopeId: string, graphUserReadScopeId: string, teamsClientIds: string[] }} o
     */
    createAzureWebApplication(o) {
      const scopeId = crypto.randomUUID();
      // No identifierUris here: tenant policy needs the URI to contain the app ID, so
      // updateAzureWebApplication sets api://<fqdn>/<appId> once the app ID exists.
      return http.post('/applications', {
        displayName: o.displayName,
        signInAudience: 'AzureADMyOrg',
        spa: { redirectUris: [`https://${o.fqdn}/`, `https://${o.fqdn}/?host=teams&auth=popup`] },
        api: {
          oauth2PermissionScopes: [
            {
              id: scopeId,
              adminConsentDescription: 'Allow users to access Analytics Hub.',
              adminConsentDisplayName: 'Access Analytics Hub',
              isEnabled: true,
              type: 'User',
              userConsentDescription: 'Allow you to access Analytics Hub.',
              userConsentDisplayName: 'Access Analytics Hub',
              value: 'access_as_user',
            },
          ],
          preAuthorizedApplications: o.teamsClientIds.map((appId) => ({ appId, delegatedPermissionIds: [scopeId] })),
        },
        appRoles: [
          { id: crypto.randomUUID(), allowedMemberTypes: ['User'], displayName: 'Analytics Hub User', value: 'AnalyticsHub.User', description: 'Can use Analytics Hub.', isEnabled: true },
          { id: crypto.randomUUID(), allowedMemberTypes: ['User'], displayName: 'Analytics Hub Admin', value: 'AnalyticsHub.Admin', description: 'Can administer Analytics Hub.', isEnabled: true },
        ],
        requiredResourceAccess: [
          { resourceAppId: POWER_BI_APP_ID, resourceAccess: [{ id: o.pbiScopeId, type: 'Scope' }] },
          { resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: o.graphUserReadScopeId, type: 'Scope' }] },
        ],
        notes: 'Created by the Analytics Hub installer for the Azure-hosted web app.',
      });
    },

    /**
     * @param {any} application
     * @param {{ fqdn: string, clientId: string, pbiScopeId: string, graphUserReadScopeId: string, teamsClientIds: string[] }} o
     */
    async updateAzureWebApplication(application, o) {
      const scope = application.api?.oauth2PermissionScopes?.find((s) => s.value === 'access_as_user') ?? { id: crypto.randomUUID() };
      await http.patch(`/applications/${application.id}`, {
        spa: { redirectUris: [`https://${o.fqdn}/`, `https://${o.fqdn}/?host=teams&auth=popup`] },
        identifierUris: [`api://${o.fqdn}/${o.clientId}`],
        api: {
          ...(application.api ?? {}),
          oauth2PermissionScopes: [
            {
              ...scope,
              adminConsentDescription: scope.adminConsentDescription ?? 'Allow users to access Analytics Hub.',
              adminConsentDisplayName: scope.adminConsentDisplayName ?? 'Access Analytics Hub',
              isEnabled: true,
              type: 'User',
              userConsentDescription: scope.userConsentDescription ?? 'Allow you to access Analytics Hub.',
              userConsentDisplayName: scope.userConsentDisplayName ?? 'Access Analytics Hub',
              value: 'access_as_user',
            },
          ],
          preAuthorizedApplications: o.teamsClientIds.map((appId) => ({ appId, delegatedPermissionIds: [scope.id] })),
        },
        appRoles: application.appRoles?.length
          ? application.appRoles
          : [
              { id: crypto.randomUUID(), allowedMemberTypes: ['User'], displayName: 'Analytics Hub User', value: 'AnalyticsHub.User', description: 'Can use Analytics Hub.', isEnabled: true },
              { id: crypto.randomUUID(), allowedMemberTypes: ['User'], displayName: 'Analytics Hub Admin', value: 'AnalyticsHub.Admin', description: 'Can administer Analytics Hub.', isEnabled: true },
            ],
        requiredResourceAccess: [
          { resourceAppId: POWER_BI_APP_ID, resourceAccess: [{ id: o.pbiScopeId, type: 'Scope' }] },
          { resourceAppId: GRAPH_APP_ID, resourceAccess: [{ id: o.graphUserReadScopeId, type: 'Scope' }] },
        ],
      });
      return scope.id;
    },
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

    /** @param {string} applicationObjectId */
    deleteApplication: (applicationObjectId) => http.del(`/applications/${applicationObjectId}`),

    /**
     * @param {string} applicationObjectId
     * @param {{ name: string, issuer: string, subject: string, audiences: string[] }} credential
     */
    addFederatedIdentityCredential: (applicationObjectId, credential) =>
      http.post(`/applications/${applicationObjectId}/federatedIdentityCredentials`, credential, replicationRetry),

    /**
     * @param {string} applicationObjectId
     * @param {Date} endDateTime
     * @param {string} [displayName]
     * @returns {Promise<{ secretText: string, endDateTime: string, keyId: string }>}
     */
    addPassword: (applicationObjectId, endDateTime, displayName = 'Analytics Hub installer') =>
      http.post(`/applications/${applicationObjectId}/addPassword`, {
        passwordCredential: { displayName, endDateTime: endDateTime.toISOString() },
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

    /**
     * Admin consent for a delegated scope for all users. Reuses an existing grant, adding the scope if it's missing.
     * @param {{ clientId: string, resourceId: string, scope: string }} o
     */
    async grantOauth2Permission(o) {
      const existing = /** @type {any[]} */ (await http.list('/oauth2PermissionGrants', { query: { $filter: `clientId eq '${o.clientId}' and resourceId eq '${o.resourceId}'` } }).catch(() => [])).find((g) => g.consentType === 'AllPrincipals');
      if (!existing) return http.post('/oauth2PermissionGrants', { clientId: o.clientId, consentType: 'AllPrincipals', resourceId: o.resourceId, scope: o.scope }, replicationRetry);
      const scopes = String(existing.scope ?? '').split(' ').filter(Boolean);
      if (scopes.includes(o.scope)) return existing;
      return http.patch(`/oauth2PermissionGrants/${existing.id}`, { scope: [...scopes, o.scope].join(' ') });
    },

    /** @param {string} principalId @param {string} resourceId @param {string} appRoleId */
    assignPrincipalToAppRole: (principalId, resourceId, appRoleId) =>
      http.post(`/servicePrincipals/${resourceId}/appRoleAssignedTo`, { principalId, resourceId, appRoleId }, replicationRetry),

    /** Users, groups and apps assigned to this service principal's app roles. @param {string} resourceId */
    appRoleAssignedTo: (resourceId) => http.list(`/servicePrincipals/${resourceId}/appRoleAssignedTo`),
  };
}

/** @typedef {ReturnType<typeof graphApi>} GraphApi */
