// @ts-check
/**
 * Power Platform environment discovery and the Dataverse Web API calls that manage the
 * installer's Power Automate flows.
 */

export const DISCOVERY_URL = 'https://globaldisco.crm.dynamics.com/api/discovery/v2.0';
const ODATA = { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };

/**
 * An environment the signed-in user is a member of.
 * @typedef {object} DataverseInstance
 * @property {string} Id
 * @property {string} [EnvironmentId]
 * @property {string} [FriendlyName]
 * @property {string} [UniqueName]
 * @property {string} Url
 * @property {number} [State]  0 when enabled.
 * @property {string} [Region]
 * @property {boolean} [IsUserSysAdmin]
 */

/**
 * The Dataverse org URL with no trailing slash or path.
 * @param {string} url
 */
export const orgUrl = (url) => new URL(url.trim()).origin;

/** @param {string} url */
export const dataverseScope = (url) => /** @type {`https://${string}/.default`} */ (`${orgUrl(url)}/.default`);

/** @param {import('../http.js').HttpClient} http */
export function discoveryApi(http) {
  return {
    /** @returns {Promise<DataverseInstance[]>} */
    instances: async () => (await http.get('/Instances'))?.value ?? [],
  };
}

/** @typedef {ReturnType<typeof discoveryApi>} DiscoveryApi */

/**
 * @param {import('../http.js').HttpClient} http  Based at `{org}/api/data/v9.2`.
 * @param {string} url  The environment's org URL.
 */
export function dataverseApi(http, url) {
  return {
    url: orgUrl(url),
    /**
     * Creates a cloud flow, turned off, owned by the signed-in user. Returns its workflowid.
     * @param {{ name: string, description: string, clientdata: string }} flow
     */
    async createFlow(flow) {
      const res = await http.request('POST', '/workflows', {
        headers: { ...ODATA, Prefer: 'return=representation' },
        body: { category: 5, type: 1, primaryentity: 'none', name: flow.name, description: flow.description, clientdata: flow.clientdata },
      });
      const id = res.data?.workflowid ?? /\(([0-9a-f-]{36})\)\s*$/i.exec(res.headers.get('odata-entityid') ?? '')?.[1];
      if (!id) throw new Error('Dataverse created the flow but returned no ID.');
      return /** @type {string} */ (id);
    },
    /**
     * @param {string} id
     * @returns {Promise<{ workflowid: string, name: string, statecode: number, workflowidunique?: string, clientdata?: string } | undefined>}
     */
    async getFlow(id) {
      try {
        return await http.get(`/workflows(${id})?$select=workflowid,name,statecode,workflowidunique,clientdata`, { headers: ODATA });
      } catch (err) {
        if (/** @type {any} */ (err).status === 404) return undefined;
        throw err;
      }
    },
    /**
     * Replaces a flow's definition and connection references.
     * @param {string} id
     * @param {string} clientdata
     */
    updateFlow: (id, clientdata) => http.request('PATCH', `/workflows(${id})`, { headers: ODATA, body: { clientdata } }),
    /**
     * Turns a flow off, so it doesn't run before its new connections are signed in to.
     * @param {string} id
     */
    turnOffFlow: (id) => http.request('PATCH', `/workflows(${id})`, { headers: ODATA, body: { statecode: 0, statuscode: 1 } }),
    /**
     * Deletes a flow. Dataverse won't delete one that's on, so turn it off first.
     * @param {string} id
     */
    deleteFlow: (id) => http.request('DELETE', `/workflows(${id})`, { headers: ODATA }),
  };
}

/** @typedef {ReturnType<typeof dataverseApi>} DataverseApi */
