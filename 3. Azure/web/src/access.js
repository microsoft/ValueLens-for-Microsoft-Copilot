import { GRAPH_SCOPES, hasAdminRole, hasUserRole, userIdFromClaims } from './auth.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MEMBERSHIP_TTL_MS = 10 * 60 * 1000;
const PRINCIPAL_FIELDS = 'id,displayName,userPrincipalName,mail';

/**
 * Who may open Analytics Hub (an app role, or the viewer group), and managing that group as the signed-in user.
 * Graph itself only lets group owners and directory admins change members; the checks here keep the UI honest.
 */
export class AccessService {
  constructor({ config, tokenAcquirer, fetchImpl = fetch, now = () => Date.now() }) {
    this.config = config; this.tokenAcquirer = tokenAcquirer; this.fetch = fetchImpl; this.now = now;
    this.memberships = new Map();
  }

  get groupId() { return this.config.access?.groupId || ''; }

  async isViewer(auth) {
    if (hasUserRole(auth.claims)) return true;
    const groupId = this.groupId;
    if (!groupId) return false;
    if (Array.isArray(auth.claims.groups)) return auth.claims.groups.includes(groupId);
    // Over 200 groups, the token names a source instead of listing them: ask Graph about this one group.
    if (!auth.claims._claim_names?.groups && !auth.claims.hasgroups) return false;
    const userId = userIdFromClaims(auth.claims);
    const cached = this.memberships.get(userId);
    if (cached && cached.expiresAt > this.now()) return cached.member;
    const result = await this.graph(auth, 'POST', '/me/checkMemberGroups', { groupIds: [groupId] }).catch(() => null);
    const member = Array.isArray(result?.value) && result.value.includes(groupId);
    this.memberships.set(userId, { member, expiresAt: this.now() + MEMBERSHIP_TTL_MS });
    return member;
  }

  /** The group, and for admins and owners its members and owners. */
  async describe(auth) {
    const access = this.config.access;
    if (!access) return { group: null, canManage: false };
    const group = { id: access.groupId, name: access.groupName || '' };
    const owners = await this.listAll(auth, `/groups/${access.groupId}/owners?$select=${PRINCIPAL_FIELDS}&$top=999`).catch(() => []);
    if (!hasAdminRole(auth.claims) && !(await this.isOwner(auth, owners))) return { group, canManage: false };
    const [info, members] = await Promise.all([
      this.graph(auth, 'GET', `/groups/${access.groupId}?$select=displayName`).catch(() => null),
      this.listAll(auth, `/groups/${access.groupId}/members?$select=${PRINCIPAL_FIELDS}&$top=999`)
    ]);
    return { group: { ...group, name: info?.displayName || group.name }, canManage: true, members: members.map(principal), owners: owners.map(principal) };
  }

  /** Adds a person (email or UPN) or a group (exact name) to the viewer group. */
  async add(auth, name) {
    await this.requireManager(auth);
    const target = await this.resolve(auth, String(name || '').trim());
    if (!target) throw httpError(404, 'PrincipalNotFound', `No person or group called "${name}" was found.`);
    try {
      await this.graph(auth, 'POST', `/groups/${this.groupId}/members/$ref`, { '@odata.id': `${GRAPH}/directoryObjects/${target.id}` });
    } catch (error) {
      if (!(error.statusCode === 400 && /already exist/i.test(error.message))) throw error;
    }
    return principal(target);
  }

  async remove(auth, memberId) {
    await this.requireManager(auth);
    if (!/^[0-9a-f-]{36}$/i.test(memberId)) throw httpError(400, 'InvalidMember', 'Member id must be a directory object id.');
    await this.graph(auth, 'DELETE', `/groups/${this.groupId}/members/${memberId}/$ref`);
  }

  async requireManager(auth) {
    if (!this.groupId) throw httpError(404, 'NoViewerGroup', 'This Analytics Hub has no viewer group. Run the installer "access" command to set one up.');
    if (hasAdminRole(auth.claims) || (await this.isOwner(auth))) return;
    throw httpError(403, 'NotAccessManager', 'Only Analytics Hub admins and owners of the viewer group can change who has access.');
  }

  async isOwner(auth, owners) {
    const list = owners || (await this.listAll(auth, `/groups/${this.groupId}/owners?$select=id&$top=999`).catch(() => []));
    const me = String(auth.claims.oid || '');
    return !!me && list.some((o) => o.id === me);
  }

  async resolve(auth, name) {
    if (!name) return null;
    const quoted = name.replace(/'/g, "''");
    if (name.includes('@')) {
      const user = await this.graph(auth, 'GET', `/users/${encodeURIComponent(name)}?$select=${PRINCIPAL_FIELDS}`).catch((e) => (e.statusCode === 404 ? null : Promise.reject(e)));
      if (user) return { ...user, '@odata.type': '#microsoft.graph.user' };
      const byMail = await this.graph(auth, 'GET', `/users?$select=${PRINCIPAL_FIELDS}&$filter=mail eq '${encodeURIComponent(quoted)}'`);
      return byMail?.value?.[0] ? { ...byMail.value[0], '@odata.type': '#microsoft.graph.user' } : null;
    }
    const groups = await this.graph(auth, 'GET', `/groups?$select=id,displayName,mail&$filter=displayName eq '${encodeURIComponent(quoted)}'`);
    return groups?.value?.[0] ? { ...groups.value[0], '@odata.type': '#microsoft.graph.group' } : null;
  }

  async listAll(auth, path) {
    const items = [];
    let next = `${GRAPH}${path}`;
    while (next && items.length < 5000) {
      const page = await this.graph(auth, 'GET', next);
      items.push(...(page?.value || []));
      next = page?.['@odata.nextLink'] || '';
    }
    return items;
  }

  async graph(auth, method, path, body) {
    const token = await this.tokenAcquirer(auth.token, auth.claims, GRAPH_SCOPES);
    const response = await this.fetch(path.startsWith('https://') ? path : `${GRAPH}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = JSON.parse(text)?.error?.message || text; } catch { /* plain text */ }
      if (response.status === 403) throw httpError(403, 'AccessManageDenied', 'Microsoft Entra did not allow this change. Only owners of the viewer group and directory admins can change its members.');
      throw httpError(response.status, 'GraphError', message || `Graph returned ${response.status}.`);
    }
    return text ? JSON.parse(text) : null;
  }
}

function principal(o) {
  const kind = String(o['@odata.type'] || '').endsWith('group') ? 'group' : 'user';
  return { id: o.id, name: o.displayName || o.userPrincipalName || o.mail || o.id, ...(o.userPrincipalName || o.mail ? { email: o.userPrincipalName || o.mail } : {}), kind };
}

export function httpError(statusCode, code, message) {
  const error = new Error(message); error.statusCode = statusCode; error.code = code; return error;
}
