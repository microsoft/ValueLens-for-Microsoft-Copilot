// @ts-check
/**
 * Power Platform environment discovery and the Dataverse Web API calls that give the
 * app registration read access to Copilot Studio transcripts.
 */

export const DISCOVERY_URL = 'https://globaldisco.crm.dynamics.com/api/discovery/v2.0';
/** Created by Copilot Studio in each environment. Reads conversation transcripts. */
export const TRANSCRIPT_ROLE = 'Bot Transcript Viewer';

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

/** @param {string} value */
const q = (value) => encodeURIComponent(value);

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
  const base = `${orgUrl(url)}/api/data/v9.2`;
  return {
    url: orgUrl(url),
    /**
     * The app's application user, if it has one here.
     * @param {string} appId
     * @returns {Promise<{ systemuserid: string, isdisabled?: boolean, _businessunitid_value?: string } | undefined>}
     */
    findAppUser: async (appId) =>
      (await http.get(`/systemusers?$select=systemuserid,isdisabled,_businessunitid_value&$filter=${q(`applicationid eq ${appId}`)}`, { headers: ODATA }))?.value?.[0],
    /** @returns {Promise<string | undefined>} */
    rootBusinessUnit: async () =>
      (await http.get(`/businessunits?$select=businessunitid&$filter=${q('_parentbusinessunitid_value eq null')}`, { headers: ODATA }))?.value?.[0]?.businessunitid,
    /**
     * Adds the app as an application user and returns its systemuserid.
     * @param {string} appId
     * @param {string} businessUnitId
     */
    async createAppUser(appId, businessUnitId) {
      const res = await http.request('POST', '/systemusers', {
        headers: { ...ODATA, Prefer: 'return=representation' },
        body: { applicationid: appId, 'businessunitid@odata.bind': `/businessunits(${businessUnitId})` },
      });
      const id = res.data?.systemuserid ?? /\(([0-9a-f-]{36})\)\s*$/i.exec(res.headers.get('odata-entityid') ?? '')?.[1];
      if (!id) throw new Error('Dataverse added the application user but returned no ID.');
      return /** @type {string} */ (id);
    },
    /**
     * @param {string} name
     * @param {string} businessUnitId
     * @returns {Promise<string | undefined>}
     */
    findRole: async (name, businessUnitId) =>
      (await http.get(`/roles?$select=roleid&$filter=${q(`name eq '${name.replace(/'/g, "''")}' and _businessunitid_value eq ${businessUnitId}`)}`, { headers: ODATA }))
        ?.value?.[0]?.roleid,
    /**
     * @param {string} userId
     * @returns {Promise<string[]>}
     */
    userRoleIds: async (userId) =>
      ((await http.get(`/systemusers(${userId})/systemuserroles_association?$select=roleid`, { headers: ODATA }))?.value ?? []).map(
        (/** @type {any} */ r) => String(r.roleid),
      ),
    /**
     * @param {string} userId
     * @param {string} roleId
     */
    assignRole: (userId, roleId) =>
      http.request('POST', `/systemusers(${userId})/systemuserroles_association/$ref`, { headers: ODATA, body: { '@odata.id': `${base}/roles(${roleId})` } }),
  };
}

/** @typedef {ReturnType<typeof dataverseApi>} DataverseApi */
