// @ts-check
/**
 * Who can view Analytics Hub: one Entra security group, on both targets. Its members get Build on the
 * semantic models the app queries; on Azure the web app also lets them in by that group. Sharing is
 * then adding people to the group, from the installer, the app's Share panel or My Groups.
 */
import { HttpError } from '../http.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {{ workspaceId: string, datasetId: string, name: string }} ModelRef */

export const VIEWER_GROUP_NAME = 'Analytics Hub Viewers';
const GROUP_DESCRIPTION = 'People who can view Analytics Hub. Add members to share it.';

/** Where a group's owners add and remove members themselves. @param {string} groupId */
export const myGroupsUrl = (groupId) => `https://myaccount.microsoft.com/groups/${groupId}`;

const isEmail = (/** @type {string} */ v) => (/^[^\s@]+@[^\s@]+$/.test(v.trim()) ? true : 'Enter an email address');
const isLinkOrEmpty = (/** @type {string} */ v) => (!v.trim() || /^https:\/\/\S+$/i.test(v.trim()) ? true : 'Enter an https:// link, or leave it empty');

/**
 * The plan's questions: which group, who to ask for access, and an optional request link.
 * @param {Ctx} ctx
 */
export async function planAccess(ctx) {
  const { ui, config, user, api } = ctx;
  const access = { ...(config.access ?? {}) };
  ui.heading('Who can view');
  const mode = await ui.select(
    'Who can view Analytics Hub?',
    [
      { name: `A new group, "${VIEWER_GROUP_NAME}" (recommended)`, value: 'new', description: 'Created with you as owner. Share by adding people to it.' },
      { name: 'A group I already have', value: 'existing', description: 'A security group, by name or object ID. Its members can view.' },
    ],
    access.groupId && !access.createdGroup ? 'existing' : 'new',
  );
  if (mode === 'new') {
    if (!access.createdGroup) delete access.groupId;
    access.groupName = access.createdGroup ? access.groupName ?? VIEWER_GROUP_NAME : VIEWER_GROUP_NAME;
  } else {
    for (;;) {
      const name = (await ui.input('Group name or object ID', { default: access.createdGroup ? undefined : access.groupName ?? access.groupId })).trim();
      const found = await api.graph.resolvePrincipal(name).catch(() => null);
      if (found?.kind === 'group') {
        Object.assign(access, { groupId: found.id, groupName: found.displayName, createdGroup: false });
        ui.ok(`Viewers: ${found.displayName}`);
        break;
      }
      ui.warn(`No group called "${name}". Check the name, or paste its object ID from Entra.`);
    }
  }
  access.contact = (await ui.input('Who should people ask for access? (email)', { default: access.contact ?? user.upn, validate: isEmail })).trim();
  access.requestUrl = (await ui.input('A link for requesting access, e.g. a My Access package (optional; empty emails the contact)', { default: access.requestUrl ?? '', validate: isLinkOrEmpty })).trim() || undefined;
  config.access = access;
}

/**
 * Plan review rows: the group the access step creates and the Build grant it gives.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} where  The models, e.g. "Semantic models in workspace X".
 */
export function accessReview(config, where) {
  const a = config.access;
  if (!a) return { creates: [], grants: [] };
  const name = a.groupName ?? VIEWER_GROUP_NAME;
  return {
    creates: [{ kind: 'Entra group', name, isNew: !a.groupId, detail: 'Who can view Analytics Hub. You are its owner; share by adding people to it.' }],
    grants: [{ who: `${name} (group)`, what: 'Build (ReadExplore)', where, detail: 'So its members can view the app and reports.' }],
  };
}

/**
 * Finds the viewer group, or creates it with the installer as owner. Null when it can't be created.
 * @param {Ctx} ctx
 * @returns {Promise<{ id: string, displayName: string } | null>}
 */
export async function ensureViewerGroup(ctx) {
  const { ui, config, api, user } = ctx;
  const a = config.access;
  if (!a) return null;
  if (a.groupId) {
    const group = await api.graph.getGroup(a.groupId);
    if (group) {
      a.groupName = group.displayName;
      ui.ok(`Viewer group: ${group.displayName}`);
      return group;
    }
    ui.warn(`The viewer group ${a.groupName ?? a.groupId} is gone.${a.createdGroup ? ' Creating it again.' : ''}`);
    delete a.groupId;
    a.grantedModels = [];
    if (!a.createdGroup) {
      ctx.save();
      ui.info(`Run "access" to choose another group.`);
      return null;
    }
  }
  const name = a.groupName ?? VIEWER_GROUP_NAME;
  const found = await api.graph.findGroupByName(name);
  if (found) {
    Object.assign(a, { groupId: found.id, groupName: found.displayName });
    ctx.save();
    ui.ok(`Viewer group: ${found.displayName}`);
    return found;
  }
  try {
    const group = await api.graph.createSecurityGroup({ displayName: name, description: GROUP_DESCRIPTION, ownerId: user.id });
    Object.assign(a, { groupId: group.id, groupName: group.displayName, createdGroup: true });
    ctx.save();
    ui.ok(`Created the group "${group.displayName}", with you as owner`);
    return group;
  } catch (err) {
    if (!(err instanceof HttpError) || (err.status !== 403 && err.status !== 401)) throw err;
    ui.warn(`You can't create groups in this tenant, so there's no viewer group yet.`);
    ui.info('Ask an Entra admin for a security group, then run "access" to use it.');
    return null;
  }
}

/**
 * Gives the viewer group Build (ReadExplore) on each model, so its members can query them.
 * A grant that fails is reported and doesn't stop the install.
 * @param {Ctx} ctx
 * @param {ModelRef[]} models
 */
export async function grantModelAccess(ctx, models) {
  const { ui, config, api } = ctx;
  const a = config.access;
  if (!a?.groupId) return;
  const granted = new Set(a.grantedModels ?? []);
  for (const m of models) {
    try {
      const users = await api.powerBi.datasetUsers(m.workspaceId, m.datasetId).catch(() => []);
      const has = users.some((u) => String(u.identifier).toLowerCase() === a.groupId?.toLowerCase() && /Explore/i.test(u.datasetUserAccessRight ?? ''));
      if (!has) await api.powerBi.addDatasetUser(m.workspaceId, m.datasetId, { identifier: a.groupId, principalType: 'Group', datasetUserAccessRight: 'ReadExplore' });
      granted.add(m.datasetId);
      ui.ok(`${a.groupName} can build on ${m.name}`);
    } catch (err) {
      ui.warn(`Couldn't give ${a.groupName} Build on ${m.name}: ${/** @type {Error} */ (err).message}`);
      ui.info('Share the model with the group from its Manage permissions page, with "Allow recipients to build content" ticked.');
    }
  }
  a.grantedModels = [...granted];
  ctx.save();
}

/**
 * What the app is told about access: the group and who to ask. Undefined without a group.
 * @param {import('../config.js').InstallConfig} config
 * @returns {Record<string, string> | undefined}
 */
export function publicAccess(config) {
  const a = config.access;
  if (!a?.groupId) return undefined;
  /** @type {Record<string, string>} */
  const out = { groupId: a.groupId };
  for (const k of /** @type {const} */ (['groupName', 'contact', 'requestUrl'])) if (a[k]) out[k] = /** @type {string} */ (a[k]);
  return out;
}

/**
 * Summary lines: who can view and how to share.
 * @param {import('../config.js').InstallConfig} config
 */
export function accessSummaryLines(config) {
  const a = config.access;
  if (!a?.groupId) return [];
  return [
    `Viewers: members of "${a.groupName}". To share, add people to it: run "access", use Share in the app, or open ${myGroupsUrl(a.groupId)}.`,
    `People without access are asked to contact ${a.contact ?? 'you'}${a.requestUrl ? ` or request it at ${a.requestUrl}` : ''}.`,
  ];
}

/**
 * The `access` command: shows the viewer group and adds viewers or owners to it.
 * @param {Ctx} ctx
 * @param {ModelRef[]} models  The models the group should have Build on.
 */
export async function accessCommand(ctx, models) {
  const { ui, config, api } = ctx;
  if (!config.access?.groupId) await planAccess(ctx);
  ctx.save();
  ui.heading('Viewer access');
  const group = await ensureViewerGroup(ctx);
  if (!group) return;
  for (;;) {
    const [members, owners] = await Promise.all([api.graph.groupMembers(group.id).catch(() => []), api.graph.groupOwners(group.id).catch(() => [])]);
    ui.info(`${members.length} ${members.length === 1 ? 'member' : 'members'}; owners: ${owners.map((o) => o.userPrincipalName ?? o.displayName).join(', ') || 'none'}`);
    ui.note(`Owners can also manage it at ${myGroupsUrl(group.id)}`);
    const action = await ui.select(
      'What next?',
      [
        { name: 'Add viewers', value: 'members', description: 'People or groups, by email or group name.' },
        { name: 'Add an owner', value: 'owner', description: 'Owners can add and remove viewers themselves.' },
        { name: 'Give the group Build on the models again', value: 'grants', description: 'Repairs access to the models the app queries.' },
        { name: 'Done', value: 'done' },
      ],
      'done',
    );
    if (action === 'done') return;
    if (action === 'grants') {
      await grantModelAccess(ctx, models);
      continue;
    }
    const names = (await ui.input(action === 'owner' ? 'Owner email' : 'Emails or group names, separated by commas')).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      const p = await api.graph.resolvePrincipal(name).catch(() => null);
      if (!p || (action === 'owner' && p.kind !== 'user')) {
        ui.warn(`No ${action === 'owner' ? 'user' : 'user or group'} called "${name}"`);
        continue;
      }
      const added = action === 'owner' ? await api.graph.addGroupOwner(group.id, p.id) : await api.graph.addGroupMember(group.id, p.id);
      ui.ok(`${p.displayName} ${added ? 'added' : 'was already there'}`);
    }
  }
}
