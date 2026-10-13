import { hasAdminRole } from './auth.js';
import { httpError } from './access.js';

const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,127}\.[^\s@]{1,60}$/;
const NOTE_MAX = 400;
const VALUE_MAX = 256;
const REFRESH_MESSAGES = {
  started: 'Power BI is updating who sees what. It usually takes a few minutes.',
  queued: 'Power BI will update who sees what in a few minutes.',
  unavailable: 'Power BI couldn\'t update access right now. The change applies at the next scheduled refresh.'
};

/**
 * Scoped delegation from the Share panel, when org-scoped access (row-level security) is on.
 *
 * - Admins (AnalyticsHub.Admin) can give anyone the people below a person, or an org, and let them share.
 * - Leaders (an active scope with "can share") can give "my org": the people below themselves, when
 *   that sits inside a scope they were given. They can't pass on "can share", and they take back only
 *   what they gave.
 * - Nobody gives "everyone" here: that changes the Everyone role's members, so it's the installer's job.
 *
 * Scopes are written straight away. The delegate also needs to be in the viewer group; when the
 * caller can't add them (only group owners and directory admins can), the scope waits for an admin,
 * who approves it with one click.
 */
export class DelegationService {
  constructor({ config, store, accessService, refresher, now = () => Date.now() }) {
    this.config = config; this.store = store; this.access = accessService; this.refresher = refresher; this.now = now;
  }

  get enabled() { return !!(this.store && this.config.access?.groupId && this.config.access?.rlsOrgAttribute); }

  async describe(auth) {
    if (!this.enabled) return { enabled: false };
    const me = await this.whoAmI(auth);
    const share = (await this.store.list()).filter((r) => r.GrantedVia === 'share');
    const delegations = me.isAdmin ? share : share.filter((r) => r.GrantedBy === me.upn);
    return {
      enabled: true,
      orgAttribute: this.config.access.rlsOrgAttribute,
      me: { upn: me.upn, isAdmin: me.isAdmin, canDelegate: me.isAdmin || me.canGiveMyOrg, scopes: me.scopes.map(scopeView) },
      delegations: delegations.filter((r) => r.Status === 'active' || !me.isAdmin).map(rowView),
      pending: me.isAdmin ? share.filter((r) => r.Status !== 'active').map(rowView) : [],
      ...(this.refresher?.last ? { refresh: { ...this.refresher.last, message: REFRESH_MESSAGES[this.refresher.last.status] } } : {})
    };
  }

  async add(auth, body) {
    this.requireEnabled();
    const me = await this.whoAmI(auth);
    if (!me.isAdmin && !me.canGiveMyOrg) throw httpError(403, 'CannotDelegate', 'Only Analytics Hub admins, and leaders who were allowed to share, can choose what people see.');
    const upn = String(body?.upn || '').trim().toLowerCase();
    if (!EMAIL.test(upn)) throw httpError(400, 'InvalidPerson', 'Enter the person\'s work email.');
    const type = String(body?.scope?.type || '').trim().toLowerCase();
    let value = String(body?.scope?.value ?? '').trim();
    const note = String(body?.note || '').trim();
    if (note.length > NOTE_MAX) throw httpError(400, 'InvalidNote', `Keep the note under ${NOTE_MAX} characters.`);
    if (type === 'all') throw httpError(400, 'InvalidScope', 'Everyone can only be given with the installer "access" command.');
    if (type !== 'hierarchy' && type !== 'org') throw httpError(400, 'InvalidScope', 'Choose the people below a person, or an org.');
    if (!me.isAdmin) {
      if (body?.canDelegate) throw httpError(403, 'CannotDelegate', 'Only Analytics Hub admins can let someone share.');
      if (upn === me.upn) throw httpError(400, 'InvalidPerson', 'You can\'t give yourself a scope.');
      if (type !== 'hierarchy' || (value && value.toLowerCase() !== me.upn)) throw httpError(403, 'CannotDelegate', 'You can share your own org: the people below you.');
      value = me.upn;
    } else if (type === 'hierarchy') {
      value = value.toLowerCase();
      if (!EMAIL.test(value)) throw httpError(400, 'InvalidScope', 'Enter the work email of the person at the top of the org.');
    } else if (!value || value.length > VALUE_MAX) {
      throw httpError(400, 'InvalidScope', 'Enter the org name, as it appears in your org data.');
    }
    const key = { UserPrincipalName: upn, ScopeType: type, ScopeValue: value };
    if (await this.store.get(key)) throw httpError(409, 'ScopeExists', 'They already have this scope.');

    const status = await this.joinViewers(auth, upn);
    const row = {
      ...key, CanDelegate: !!(me.isAdmin && body?.canDelegate), GrantedBy: me.upn, GrantedVia: 'share', Status: status,
      Note: note, CreatedAt: new Date(this.now()).toISOString().slice(0, 19)
    };
    await this.store.insert(row);
    return { delegation: rowView(row), ...(status === 'active' ? await this.refresh() : {}) };
  }

  async remove(auth, id) {
    this.requireEnabled();
    const me = await this.whoAmI(auth);
    const row = await this.store.get(parseId(id));
    if (!row) throw httpError(404, 'ScopeNotFound', 'That scope has already gone.');
    if (row.GrantedVia !== 'share') throw httpError(403, 'InstallerScope', 'This scope was set with the installer. Change it with the installer "access" command.');
    if (!me.isAdmin && row.GrantedBy !== me.upn) throw httpError(403, 'NotYourDelegation', 'You can only take back scopes you gave.');
    await this.store.delete(row);
    return row.Status === 'active' ? await this.refresh() : {};
  }

  async approve(auth, id) {
    this.requireEnabled();
    if (!hasAdminRole(auth.claims)) throw httpError(403, 'NotAdmin', 'Only Analytics Hub admins can approve scopes.');
    const row = await this.store.get(parseId(id));
    if (!row) throw httpError(404, 'ScopeNotFound', 'That scope has already gone.');
    if (row.Status === 'active') throw httpError(409, 'AlreadyActive', 'This scope is already active.');
    if ((await this.joinViewers(auth, row.UserPrincipalName)) !== 'active') {
      throw httpError(403, 'AccessManageDenied', 'Microsoft Entra didn\'t let you add them to the viewer group. Only owners of the group and directory admins can change its members.');
    }
    await this.store.setStatus(row, 'active');
    return { delegation: rowView({ ...row, Status: 'active' }), ...(await this.refresh()) };
  }

  requireEnabled() {
    if (!this.enabled) throw httpError(404, 'DelegationOff', 'Org-scoped access isn\'t turned on for this Analytics Hub.');
  }

  async whoAmI(auth) {
    const upn = String(auth.claims.upn || auth.claims.preferred_username || '').toLowerCase();
    const isAdmin = hasAdminRole(auth.claims);
    const scopes = upn ? (await this.store.list()).filter((r) => r.UserPrincipalName === upn && r.Status === 'active') : [];
    return { upn, isAdmin, scopes, canGiveMyOrg: !!upn && (await this.ownsMyOrg(upn, scopes)) };
  }

  /** "My org" fits inside a scope they may share: everyone, or the people below someone above them. */
  async ownsMyOrg(upn, scopes) {
    const sharable = scopes.filter((r) => r.CanDelegate);
    if (sharable.some((r) => r.ScopeType === 'all')) return true;
    const roots = sharable.filter((r) => r.ScopeType === 'hierarchy').map((r) => r.ScopeValue.toLowerCase());
    if (!roots.length) return false;
    const path = (await this.store.orgPath(upn)) || upn;
    const chain = path.split('|').map((p) => p.trim());
    return roots.some((root) => chain.includes(root));
  }

  /** 'active' once they're in the viewer group; 'pending_group' when the caller can't put them there. */
  async joinViewers(auth, upn) {
    let person;
    try {
      person = await this.access.resolve(auth, upn);
    } catch (error) {
      if (error.statusCode === 403) return 'pending_group';
      throw error;
    }
    if (!person) throw httpError(404, 'PrincipalNotFound', `No one with the email ${upn} was found.`);
    const groupId = this.config.access.groupId;
    try {
      await this.access.graph(auth, 'POST', `/groups/${groupId}/members/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${person.id}` });
      return 'active';
    } catch (error) {
      if (error.statusCode === 400 && /already exist/i.test(error.message)) return 'active';
      if (error.statusCode !== 403) throw error;
    }
    return (await this.isViewer(auth, groupId, person.id)) ? 'active' : 'pending_group';
  }

  /** Already in the viewer group (directly or through another group), so nobody needs to add them. */
  async isViewer(auth, groupId, personId) {
    const found = await this.access.graph(auth, 'POST', `/directoryObjects/${encodeURIComponent(personId)}/checkMemberGroups`, { groupIds: [groupId] }).catch(() => null);
    return Array.isArray(found?.value) && found.value.includes(groupId);
  }

  async refresh() {
    if (!this.refresher) return { refresh: { status: 'unavailable', message: REFRESH_MESSAGES.unavailable } };
    const result = await this.refresher.request().catch(() => ({ status: 'unavailable' }));
    return { refresh: { status: result.status, message: REFRESH_MESSAGES[result.status] } };
  }
}

export function delegationId(row) {
  return Buffer.from(JSON.stringify([row.UserPrincipalName, row.ScopeType, row.ScopeValue]), 'utf8').toString('base64url');
}

function parseId(id) {
  try {
    const [upn, type, value] = JSON.parse(Buffer.from(String(id || ''), 'base64url').toString('utf8'));
    if ([upn, type, value].every((v) => typeof v === 'string')) return { UserPrincipalName: upn, ScopeType: type, ScopeValue: value };
  } catch { /* fall through */ }
  throw httpError(400, 'InvalidDelegation', 'That isn\'t a scope id.');
}

const scopeView = (r) => ({ type: r.ScopeType, value: r.ScopeValue, canDelegate: r.CanDelegate });

function rowView(r) {
  return {
    id: delegationId(r), upn: r.UserPrincipalName, scope: { type: r.ScopeType, value: r.ScopeValue }, canDelegate: r.CanDelegate,
    grantedBy: r.GrantedBy, status: r.Status === 'active' ? 'active' : 'pending_group', note: r.Note, createdAt: r.CreatedAt
  };
}
