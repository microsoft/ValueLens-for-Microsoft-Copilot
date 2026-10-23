// @ts-check
/**
 * Power Platform environment discovery and the Dataverse Web API calls that give the
 * app registration read access to Copilot Studio transcripts.
 */

export const DISCOVERY_URL = 'https://globaldisco.crm.dynamics.com/api/discovery/v2.0';
/**
 * Created by Copilot Studio in each environment. Its transcript read is at Basic depth, so on its
 * own it reads only the transcripts the reader owns or that are shared with it. Copilot Studio's
 * service user owns them, so for an app registration or managed identity that's usually none.
 */
export const TRANSCRIPT_ROLE = 'Bot Transcript Viewer';
/**
 * The whole of the role the installer creates for the transcript reader, at Organization depth.
 * Agent (bot) read isn't here: nothing the reader runs uses it yet.
 */
export const TRANSCRIPT_READ_PRIVILEGES = Object.freeze(['prvReadconversationtranscript']);
/** The start of the description of a role the installer created, so it never touches a role that only shares the name. */
export const READ_ROLE_MARK = 'Created by the Analytics Hub installer';

const ODATA = { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };
/** Dataverse's privilege depths, in the order of their numbers. Global is Organization in the admin center. */
const DEPTHS = ['Basic', 'Local', 'Deep', 'Global'];

/**
 * A privilege depth by name. Dataverse returns "Global"; some endpoints return 3.
 * @param {unknown} depth
 */
export const depthName = (depth) => (/^\d+$/.test(String(depth)) ? (DEPTHS[Number(depth)] ?? String(depth)) : String(depth));

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

/** @param {string} value  A string for an OData filter, quoted. */
const literal = (value) => `'${value.replace(/'/g, "''")}'`;

/**
 * A collection's rows. An answer without them is an error, so a check that relies on them never passes by accident.
 * @param {any} res @param {string} what
 * @returns {any[]}
 */
const rows = (res, what) => {
  if (!Array.isArray(res?.value)) throw new Error(`Dataverse returned no list of ${what}.`);
  return res.value;
};

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
    /**
     * Whether the environment has any Copilot Studio agents (the bot table has a row).
     * @returns {Promise<boolean>}
     */
    hasAgents: async () => ((await http.get('/bots?$top=1&$select=botid', { headers: ODATA }))?.value?.length ?? 0) > 0,
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
      (await http.get(`/roles?$select=roleid&$filter=${q(`name eq ${literal(name)} and _businessunitid_value eq ${businessUnitId}`)}`, { headers: ODATA }))
        ?.value?.[0]?.roleid,
    /**
     * The roles with this name in a business unit, with their descriptions.
     * @param {string} name
     * @param {string} businessUnitId
     * @returns {Promise<{ roleid: string, description?: string | null }[]>}
     */
    rolesByName: async (name, businessUnitId) =>
      (await http.get(`/roles?$select=roleid,description&$filter=${q(`name eq ${literal(name)} and _businessunitid_value eq ${businessUnitId}`)}`, { headers: ODATA }))
        ?.value ?? [],
    /**
     * A root business unit's role and the copies Dataverse made of it in child business units, whose ParentRootRoleId
     * is the role. See https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/role#BKMK_ParentRootRoleId
     * @param {string} roleId
     * @returns {Promise<{ ids: string[], more: boolean }>}  more: Dataverse has more than this page.
     */
    async roleCopies(roleId) {
      const res = await http.get(`/roles?$select=roleid&$filter=${q(`roleid eq ${roleId} or _parentrootroleid_value eq ${roleId}`)}`, { headers: ODATA });
      return { ids: rows(res, "the role's copies").map((r) => String(r.roleid)), more: !!res['@odata.nextLink'] };
    },
    /**
     * Dataverse's copy of a root business unit's role in a child business unit.
     * @param {string} roleId  The role in the root business unit.
     * @param {string} businessUnitId
     * @returns {Promise<string | undefined>}
     */
    roleCopy: async (roleId, businessUnitId) =>
      (await http.get(`/roles?$select=roleid&$filter=${q(`_parentrootroleid_value eq ${roleId} and _businessunitid_value eq ${businessUnitId}`)}`, { headers: ODATA }))
        ?.value?.[0]?.roleid,
    /**
     * The users and teams that hold a role. See
     * https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/role#BKMK_systemuserroles_association
     * and #BKMK_teamroles_association.
     * @param {string} roleId
     * @returns {Promise<{ users: string[], teams: string[], more: boolean }>}  more: Dataverse has more than these pages.
     */
    async roleHolders(roleId) {
      const users = await http.get(`/roles(${roleId})/systemuserroles_association?$select=systemuserid`, { headers: ODATA });
      const teams = await http.get(`/roles(${roleId})/teamroles_association?$select=teamid`, { headers: ODATA });
      return {
        users: rows(users, "the role's users").map((u) => String(u.systemuserid)),
        teams: rows(teams, "the role's teams").map((t) => String(t.teamid)),
        more: !!(users['@odata.nextLink'] || teams['@odata.nextLink']),
      };
    },
    /**
     * Creates a security role and returns its roleid. Dataverse gives a new role some platform
     * privileges of its own, so the caller sets the exact set afterwards.
     * @param {{ name: string, businessUnitId: string, description: string }} role
     */
    async createRole(role) {
      const res = await http.request('POST', '/roles', {
        headers: { ...ODATA, Prefer: 'return=representation' },
        body: { name: role.name, description: role.description, 'businessunitid@odata.bind': `/businessunits(${role.businessUnitId})` },
        once: true,
      });
      const id = res?.data?.roleid ?? /\(([0-9a-f-]{36})\)\s*$/i.exec(res?.headers?.get('odata-entityid') ?? '')?.[1];
      if (!id) throw new Error('Dataverse created the role but returned no ID.');
      return /** @type {string} */ (id);
    },
    /**
     * Deletes a security role.
     * @param {string} roleId
     */
    deleteRole: (roleId) => http.request('DELETE', `/roles(${roleId})`, { headers: ODATA }),
    /**
     * The privileges with these names.
     * @param {readonly string[]} names
     * @returns {Promise<{ privilegeid: string, name: string, canbeglobal?: boolean }[]>}
     */
    findPrivileges: async (names) =>
      (await http.get(`/privileges?$select=privilegeid,name,canbeglobal&$filter=${q(names.map((n) => `name eq ${literal(n)}`).join(' or '))}`, { headers: ODATA }))
        ?.value ?? [],
    /**
     * A role's privileges, with their depths by name.
     * @param {string} roleId
     * @returns {Promise<{ id: string, name?: string, depth: string }[]>}
     */
    rolePrivileges: async (roleId) =>
      ((await http.get(`/RetrieveRolePrivilegesRole(RoleId=@r)?@r=${roleId}`, { headers: ODATA }))?.RolePrivileges ?? []).map((/** @type {any} */ p) => ({
        id: String(p.PrivilegeId),
        name: p.PrivilegeName || undefined,
        depth: depthName(p.Depth),
      })),
    /**
     * Adds privileges to a role at Organization (Global) depth.
     * @param {string} roleId
     * @param {readonly string[]} privilegeIds
     * @param {string} businessUnitId  The role's business unit.
     */
    addPrivileges: (roleId, privilegeIds, businessUnitId) =>
      http.request('POST', `/roles(${roleId})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, {
        headers: ODATA,
        body: {
          Privileges: privilegeIds.map((id) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.RolePrivilege', Depth: 'Global', PrivilegeId: id, BusinessUnitId: businessUnitId })),
        },
      }),
    /**
     * Takes one privilege off a role.
     * @param {string} roleId
     * @param {string} privilegeId
     */
    removePrivilege: (roleId, privilegeId) =>
      http.request('POST', `/roles(${roleId})/Microsoft.Dynamics.CRM.RemovePrivilegeRole`, {
        headers: ODATA,
        body: { Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: privilegeId } },
      }),
    /**
     * One conversation transcript's ID, if there are any the signed-in user can see.
     * @returns {Promise<string | undefined>}
     */
    firstTranscript: async () =>
      (await http.get('/conversationtranscripts?$top=1&$select=conversationtranscriptid', { headers: ODATA }))?.value?.[0]?.conversationtranscriptid,
    /**
     * A user's access to one row, as Dataverse lists it: "ReadAccess", "ReadAccess, WriteAccess" or "None".
     * @param {string} userId
     * @param {string} target  The row, e.g. `conversationtranscripts(<id>)`.
     * @returns {Promise<string>}
     */
    principalAccess: async (userId, target) =>
      String(
        (await http.get(`/systemusers(${userId})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t=${q(JSON.stringify({ '@odata.id': target }))}`, { headers: ODATA }))
          ?.AccessRights ?? '',
      ),
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
    /**
     * Takes a security role away from a user.
     * @param {string} userId
     * @param {string} roleId
     */
    removeRole: (userId, roleId) => http.request('DELETE', `/systemusers(${userId})/systemuserroles_association(${roleId})/$ref`, { headers: ODATA }),
    /**
     * Deactivates a user. Only an inactive application user can be deleted. If-Match stops the
     * PATCH creating a user that's already gone; Dataverse answers 404 instead.
     * @param {string} userId
     */
    disableUser: (userId) => http.request('PATCH', `/systemusers(${userId})`, { headers: { ...ODATA, 'If-Match': '*' }, body: { isdisabled: true } }),
    /**
     * Activates a user again, for one Dataverse wouldn't delete once it was deactivated.
     * @param {string} userId
     */
    enableUser: (userId) => http.request('PATCH', `/systemusers(${userId})`, { headers: { ...ODATA, 'If-Match': '*' }, body: { isdisabled: false } }),
    /**
     * Deletes a deactivated application user. Some environments refuse this, so callers fall back to the admin center.
     * Dataverse's first delete only soft-deletes a user: it stays, deactivated, with no role, and only a soft-deleted
     * user can be deleted for good. See https://learn.microsoft.com/power-platform/admin/delete-users
     * @param {string} userId
     */
    deleteUser: (userId) => http.request('DELETE', `/systemusers(${userId})`, { headers: ODATA }),
    /**
     * A user, or undefined once it's gone. A soft-deleted user is still here, with DeletedState 1. See
     * https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/systemuser#BKMK_DeletedState
     * @param {string} userId
     * @returns {Promise<{ systemuserid: string, isdisabled?: boolean, deletedstate?: number } | undefined>}
     */
    async getUser(userId) {
      try {
        return await http.get(`/systemusers(${userId})?$select=systemuserid,isdisabled,deletedstate`, { headers: ODATA });
      } catch (err) {
        if (/** @type {any} */ (err).status === 404) return undefined;
        throw err;
      }
    },
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
