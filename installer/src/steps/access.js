// @ts-check
/**
 * Who can view Analytics Hub: one Entra security group, on both targets. Its members get Build on the
 * semantic models the app queries; on Azure the web app also lets them in by that group. Sharing is
 * then adding people to the group, from the installer, the app's Share panel or My Groups.
 */
import { HttpError } from '../http.js';
import { rlsOn, rlsSettings } from '../transform/access.js';
import { asksAdvanced } from './advanced.js';
import { orgAccessCommand } from './org-access.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {{ workspaceId: string, datasetId: string, name: string }} ModelRef */

export const VIEWER_GROUP_NAME = 'Analytics Hub Viewers';
const GROUP_DESCRIPTION = 'People who can view Analytics Hub. Add members to share it.';

/** Where a group's owners add and remove members themselves. @param {string} groupId */
export const myGroupsUrl = (groupId) => `https://myaccount.microsoft.com/groups/${groupId}`;

const isEmail = (/** @type {string} */ v) => (/^[^\s@]+@[^\s@]+$/.test(v.trim()) ? true : 'Enter an email address');
const isLinkOrEmpty = (/** @type {string} */ v) => (!v.trim() || /^https:\/\/\S+$/i.test(v.trim()) ? true : 'Enter an https:// link, or leave it empty');

/**
 * The saved access contact, or undefined when its domain isn't one of the tenant's verified domains,
 * e.g. a record carried over from another tenant. Kept when the domains can't be read.
 * @param {Ctx} ctx
 * @param {string | undefined} contact
 */
export async function contactInTenant(ctx, contact) {
  if (!contact || contact.toLowerCase() === ctx.user.upn.toLowerCase()) return contact;
  const domain = contact.split('@').pop()?.trim().toLowerCase() ?? '';
  const domains = await Promise.resolve()
    .then(() => ctx.api.graph.verifiedDomains())
    .catch(() => /** @type {string[]} */ ([]));
  if (!domains.length || domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return contact;
  ctx.ui.note(`The saved access contact, ${contact}, isn't on one of this tenant's domains, so it's now ${ctx.user.upn}.`);
  return undefined;
}

/**
 * The plan's questions: which group, who to ask for access, and an optional request link.
 * @param {Ctx} ctx
 */
export async function planAccess(ctx) {
  const { ui, config, user, api } = ctx;
  const access = { ...(config.access ?? {}) };
  access.contact = await contactInTenant(ctx, access.contact);
  if (!asksAdvanced(ctx)) {
    // The saved group, or a new "Analytics Hub Viewers"; Manage access changes it later.
    if (!access.groupId) access.groupName = access.createdGroup ? access.groupName ?? VIEWER_GROUP_NAME : VIEWER_GROUP_NAME;
    access.contact ??= user.upn;
    config.access = access;
    return;
  }
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
    if (!access.createdGroup) {
      delete access.groupId;
      delete access.appShared;
    }
    access.groupName = access.createdGroup ? access.groupName ?? VIEWER_GROUP_NAME : VIEWER_GROUP_NAME;
  } else {
    for (;;) {
      const name = (await ui.input('Group name or object ID', { default: access.createdGroup ? undefined : access.groupName ?? access.groupId })).trim();
      const found = await api.graph.resolvePrincipal(name).catch(() => null);
      if (found?.kind === 'group') {
        if (found.id !== access.groupId) delete access.appShared;
        Object.assign(access, { groupId: found.id, groupName: found.displayName, createdGroup: false });
        ui.ok(`Viewers: ${found.displayName}`);
        break;
      }
      ui.warn(`No group called "${name}". Check the name, or paste its object ID from Entra.`);
    }
  }
  access.contact = (await ui.input('Who should people ask for access? (email)', { default: access.contact ?? user.upn, validate: isEmail })).trim();
  ui.note(`People without access are asked to email ${access.contact}. Add a link, e.g. a request form, to offer that too.`);
  access.requestUrl = (await ui.input('Link where people can request access (optional)', { default: access.requestUrl ?? '', validate: isLinkOrEmpty })).trim() || undefined;
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
  // You may not own a group you picked. You own one the installer creates.
  const owners = a.groupId && !a.createdGroup ? 'Its owners share it by adding people to it.' : 'You are its owner; share by adding people to it.';
  return {
    creates: [{ kind: 'Entra group', name, isNew: !a.groupId, detail: `Who can view Analytics Hub. ${owners}` }],
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
    delete a.appShared;
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
    if (!(err instanceof HttpError)) throw err;
    if (err.status === 403 || err.status === 401) {
      ui.warn(`You can't create groups in this tenant, so there's no viewer group yet.`);
      ui.info('Ask an Entra admin for a security group, then run "access" to use it.');
    } else {
      ui.warn(`Couldn't create the group "${name}", so there's no viewer group yet: ${err.message}`);
      ui.info('Run "access" and choose "A group I already have" to use a security group you own, or ask an Entra admin for one.');
    }
    return null;
  }
}

/** A new group takes a minute or two to reach Power BI, which until then rejects it as an invalid identifier. */
export const NEW_GROUP_ATTEMPTS = 8;
export const NEW_GROUP_RETRY_MS = 15_000;

/**
 * Adds the group to a model, waiting while Power BI doesn't know the group yet.
 * @param {Ctx} ctx
 * @param {ModelRef} m
 * @param {string} groupId
 */
async function addGroupToModel(ctx, m, groupId) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.api.powerBi.addDatasetUser(m.workspaceId, m.datasetId, { identifier: groupId, principalType: 'Group', datasetUserAccessRight: 'ReadExplore' });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400 || attempt === NEW_GROUP_ATTEMPTS) throw err;
      if (attempt === 1) ctx.ui.info('Waiting for Power BI to see the group. A new group takes a minute or two.');
      await ctx.sleep(NEW_GROUP_RETRY_MS);
    }
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
      if (!has) await addGroupToModel(ctx, m, a.groupId);
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
 * With org-scoped access on, also the org attribute, which turns on scoped delegation in the Share panel.
 * On Fabric, `appShared` says the app item has been shared with the group, so its members can open it.
 * @param {import('../config.js').InstallConfig} config
 * @returns {Record<string, string | boolean> | undefined}
 */
export function publicAccess(config) {
  const a = config.access;
  if (!a?.groupId) return undefined;
  /** @type {Record<string, string | boolean>} */
  const out = { groupId: a.groupId };
  for (const k of /** @type {const} */ (['groupName', 'contact', 'requestUrl'])) if (a[k]) out[k] = /** @type {string} */ (a[k]);
  const rls = rlsSettings(config);
  if (rls?.orgAttribute) out.rlsOrgAttribute = rls.orgAttribute;
  if (config.target !== 'azure' && a.appShared === true) out.appShared = true;
  return out;
}

/**
 * The app item in Fabric, where its Share button is. The deploy's own link when the item isn't known.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} [tenantId]
 * @returns {string | undefined}
 */
export function appItemUrl(config, tenantId) {
  const ws = config.fabric?.workspaceId;
  const id = config.fabricApp?.itemId;
  if (!ws || !id) return config.fabricApp?.url;
  return `https://app.fabric.microsoft.com/groups/${ws}/appbackends/${id}${tenantId ? `?ctid=${tenantId}` : ''}`;
}

/**
 * The clicks that share the app item with the viewer group, one whole step each.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} [tenantId]
 */
export function shareAppSteps(config, tenantId) {
  const group = config.access?.groupName ?? VIEWER_GROUP_NAME;
  const url = appItemUrl(config, tenantId);
  const app = config.fabricApp?.name ?? 'the app';
  return [
    `Open ${app} in Fabric${url ? ` (${url})` : ''}, or in ${config.fabric?.workspaceName ?? 'the workspace'} choose … (More options) next to it.`,
    'Choose Share.',
    `Enter "${group}" and choose Grant.`,
  ];
}

/**
 * The app item still needs sharing with the viewer group: there is a group and an app, and nobody has said it's done.
 * @param {import('../config.js').InstallConfig} config
 */
export const shareAppPending = (config) =>
  config.target !== 'azure' && !!config.access?.groupId && !!config.fabricApp?.itemId && config.access.appShared !== true;

/**
 * Asks the user to share the app item with the viewer group, once. Fabric has no API for it, so it's
 * a few clicks in the portal. Asked straight after the app is deployed and before the first load,
 * which can take hours, so viewers can open the app while the history loads. Not asked again once done.
 * @param {Ctx} ctx
 */
export async function shareApp(ctx) {
  const { ui, config, user } = ctx;
  const a = config.access;
  if (a?.appShared === true) return;
  if (!shareAppPending(config)) {
    ui.warn(a?.groupId
      ? "There's no app yet, so there's nothing to share. The summary at the end says how to deploy it and share it."
      : "There's no viewer group yet, so there's nothing to share. The summary at the end says what to do.");
    return;
  }
  const group = a?.groupName ?? VIEWER_GROUP_NAME;
  ui.info(`Members of "${group}" can open the app once it's shared with the group. Fabric has no API for this, so do it now while the history loads:`);
  shareAppSteps(config, user.tenantId).forEach((s, i) => ui.info(`  ${i + 1}. ${s}`));
  ui.note('After that, give people access by adding them to the group.');
  const done = await ui.select(
    'Have you shared the app?',
    [
      { name: 'I\'ve shared it', value: true, description: `Members of "${group}" can open the app.` },
      { name: 'Later', value: false, description: 'The summary at the end reminds you, and Repair asks again.' },
    ],
    false,
  );
  if (!done) {
    ui.note('Until it\'s shared, people in the group get "no access" when they open the app.');
    return;
  }
  /** @type {import('../config.js').AccessConfig} */ (a).appShared = true;
  ctx.save();
  ui.ok(`The app is shared with "${group}"`);
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
 * @param {(ctx: Ctx) => Promise<unknown>} [redeploy]  The `update` command, for turning org-scoped access on or off.
 */
export async function accessCommand(ctx, models, redeploy) {
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
        ...(shareAppPending(config) ? [{ name: 'Share the app with the group', value: 'share', description: 'Once, in Fabric, so members can open the app.' }] : []),
        { name: 'Give the group Build on the models again', value: 'grants', description: 'Repairs access to the models the app queries.' },
        ...(redeploy
          ? [{ name: rlsOn(config) ? 'Org-scoped access: who sees which orgs' : 'Turn on org-scoped access', value: 'orgs', description: 'Row-level security: each viewer sees only the orgs you give them.' }]
          : []),
        { name: 'Done', value: 'done' },
      ],
      'done',
    );
    if (action === 'done') return;
    if (action === 'orgs' && redeploy) {
      await orgAccessCommand(ctx, redeploy);
      continue;
    }
    if (action === 'share') {
      await shareApp(ctx);
      continue;
    }
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
