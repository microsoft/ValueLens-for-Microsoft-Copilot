// @ts-check
/**
 * Power Platform connections, as the signed-in user: list, create, get a sign-in link for, and
 * delete the connections a flow uses. This is the API make.powerautomate.com calls when you add a
 * connection. Its token is for https://service.powerapps.com/.
 */
import { randomUUID } from 'node:crypto';

export const POWERAPPS_URL = 'https://api.powerapps.com';
const VERSION = '2016-11-01';

/**
 * @typedef {object} Connection
 * @property {string} name  The connection's ID, e.g. shared-webcontents-<guid>.
 * @property {{
 *   displayName?: string,
 *   apiId?: string,
 *   statuses?: { status?: string, error?: { code?: string, message?: string } }[],
 *   connectionParameters?: Record<string, any>,
 *   createdBy?: { id?: string, email?: string, userPrincipalName?: string },
 *   createdTime?: string,
 * }} [properties]
 */

/**
 * Whether a connection is signed in to. A new one is "Error" (Unauthenticated) until someone does.
 * @param {Connection | undefined} c
 */
export const isConnected = (c) => (c?.properties?.statuses ?? []).some((s) => s.status === 'Connected');

/** @param {import('../http.js').HttpClient} http  A client whose base URL is POWERAPPS_URL. */
export function connectionsApi(http) {
  const base = (/** @type {string} */ api) => `/providers/Microsoft.PowerApps/apis/${encodeURIComponent(api)}/connections`;
  const query = (/** @type {string} */ env) => ({ 'api-version': VERSION, $filter: `environment eq '${env}'` });
  return {
    /**
     * The connections to a connector in an environment that the signed-in user can see.
     * @param {string} env  The environment's ID, e.g. Default-<tenant>.
     * @param {string} api  The connector, e.g. shared_webcontents.
     * @returns {Promise<Connection[]>}
     */
    list: (env, api) => http.list(base(api), { query: query(env) }),
    /**
     * @param {string} env
     * @param {string} api
     * @param {string} id
     * @returns {Promise<Connection>}
     */
    get: (env, api, id) => http.get(`${base(api)}/${encodeURIComponent(id)}`, { query: query(env) }),
    /**
     * Creates a connection, not yet signed in to.
     * @param {string} env
     * @param {string} api
     * @param {{ displayName: string, parameters: Record<string, string> }} o  The connector's connection parameters.
     * @returns {Promise<Connection>}
     */
    create: (env, api, o) => {
      const id = `${api.replace(/^shared_/, 'shared-').replace(/_/g, '-')}-${randomUUID()}`;
      return http.put(`${base(api)}/${id}`, {
        properties: {
          environment: { id: `/providers/Microsoft.PowerApps/environments/${env}`, name: env },
          displayName: o.displayName,
          connectionParameters: o.parameters,
        },
      }, { query: query(env) });
    },
    /**
     * A link that signs in to the connection. Power Platform returns to `redirectUrl` afterwards.
     * @param {string} env
     * @param {string} api
     * @param {string} id
     * @param {string} redirectUrl
     * @returns {Promise<string | undefined>}
     */
    consentLink: async (env, api, id, redirectUrl) => {
      const res = await http.post(`${base(api)}/${encodeURIComponent(id)}/getConsentLink`, { redirectUrl }, { query: query(env) });
      return typeof res?.consentLink === 'string' ? res.consentLink : undefined;
    },
    /**
     * @param {string} env
     * @param {string} api
     * @param {string} id
     */
    remove: (env, api, id) => http.del(`${base(api)}/${encodeURIComponent(id)}`, { query: query(env) }),
  };
}

/** @typedef {ReturnType<typeof connectionsApi>} ConnectionsApi */
