// @ts-check
/**
 * Agent configuration and Foundry, from Azure Resource Graph: the management group it reads, Reader
 * there for the app registration that runs the load, and the Entra role agents need: Global Reader,
 * given when the person running the installer can, or else the steps for someone who can.
 */
import { ROLES } from '../clients/azure.js';
import { AI_ADMIN_ROLE, GLOBAL_READER_ROLE, POWER_PLATFORM_ADMIN_ROLE } from '../clients/graph.js';
import { normaliseResourceGraph } from '../config.js';
import { HttpError } from '../http.js';
import { canAssignDirectoryRoles } from '../prereqs.js';
import { asksAdvanced } from './advanced.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {{ id: string, name: string, appId?: string }} Principal */

/** Entra roles that let an app see Copilot Studio agents in Resource Graph, by template ID. Any one will do. */
export const AGENT_DIRECTORY_ROLE_IDS = {
  [GLOBAL_READER_ROLE]: 'Global Reader',
  [POWER_PLATFORM_ADMIN_ROLE]: 'Power Platform Administrator',
  [AI_ADMIN_ROLE]: 'AI Administrator',
};
export const AGENT_DIRECTORY_ROLES = Object.values(AGENT_DIRECTORY_ROLE_IDS);
/** The one the installer gives: read only, and the least it can give that covers agents. */
export const AGENT_ROLE = 'Global Reader';
/** Roles and administrators in the Entra admin center. */
export const ENTRA_ROLES_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/RolesManagementMenuBlade/~/AllRoles';

/** @param {import('../config.js').InstallConfig} config */
export const resourceGraphOn = (config) => config.dataSources?.resourceGraph === 'api';

/**
 * A management group ID from what was typed: the ID, or its resource ID. Blank is the tenant root group.
 * @param {string | undefined} raw
 */
export function managementGroupId(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  return /managementGroups\/([^/]+)$/i.exec(s)?.[1] ?? s;
}

/** Up to 90 letters, digits, hyphens, underscores, periods and brackets. @param {string} id */
export const isManagementGroupId = (id) => /^[\w().-]{1,90}$/.test(id);

/**
 * Where Reader is given: the chosen management group, or the tenant root group, whose ID is the tenant ID.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} tenantId
 */
export const resourceGraphScope = (config, tenantId) =>
  `/providers/Microsoft.Management/managementGroups/${config.resourceGraph?.managementGroup || tenantId}`;

/** @param {import('../config.js').InstallConfig} config */
export const scopeName = (config) =>
  config.resourceGraph?.managementGroup ? `management group ${config.resourceGraph.managementGroup}` : 'the tenant root management group';

/** What the load reads, in words. @param {import('../config.js').InstallConfig} config */
export function resourceGraphKinds(config) {
  const rg = config.resourceGraph;
  const kinds = [rg?.agents !== false ? 'agents' : '', rg?.foundry !== false ? 'Foundry' : ''].filter(Boolean);
  return kinds.length ? kinds.join(' and ') : 'nothing';
}

/** @param {string} who @param {string} scope */
export const readerCommand = (who, scope) => `az role assignment create --assignee ${who} --role Reader --scope ${scope}`;

/**
 * The steps for a Global Administrator or Privileged Role Administrator to give the app Global Reader.
 * @param {Principal} who
 * @returns {string[]}
 */
export function directoryRoleHandoff(who) {
  const body = JSON.stringify({ principalId: who.id, roleDefinitionId: GLOBAL_READER_ROLE, directoryScopeId: '/' });
  return [
    `Role:    ${AGENT_ROLE} (Entra)`,
    `App:     ${who.name}${who.appId ? `, application ID ${who.appId}` : ''}, object ID ${who.id}`,
    `Where:   ${ENTRA_ROLES_URL}`,
    `         Open ${AGENT_ROLE} > Add assignments, then select ${who.name}.`,
    'Or in Azure Cloud Shell (Bash):',
    `  az rest --method post --url https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments --body '${body}'`,
  ];
}

/**
 * Asks which management group to read and what to read there. Behind the advanced settings: without
 * them it reads what was saved, or the whole tenant, agents and Foundry.
 * @param {Ctx} ctx
 */
export async function planResourceGraph(ctx) {
  const { ui, config } = ctx;
  if (!resourceGraphOn(config)) return;
  const rg = (config.resourceGraph = normaliseResourceGraph(config.resourceGraph));
  if (!asksAdvanced(ctx)) {
    ctx.save();
    return;
  }
  ui.note('Resource Graph reads agent configuration and Foundry resources across a management group. Leave it blank for the whole tenant.');
  const raw = await ui.input('Management group ID (blank for the whole tenant):', {
    default: rg.managementGroup ?? '',
    validate: (v) => {
      const id = managementGroupId(v);
      return !id || isManagementGroupId(id) ? true : 'Use the management group ID, as the Azure portal shows it under Management groups.';
    },
  });
  const mg = managementGroupId(raw);
  if (mg !== (rg.managementGroup ?? '')) {
    rg.managementGroup = mg;
    delete rg.access;
  }
  const kinds = await ui.checkbox('Read:', [
    { name: 'Copilot Studio agents, their environments and agent flows', value: 'agents', checked: rg.agents },
    { name: 'Foundry resources and projects', value: 'foundry', checked: rg.foundry },
  ]);
  rg.agents = kinds.includes('agents');
  rg.foundry = kinds.includes('foundry');
  if (!rg.agents && !rg.foundry) {
    ui.warn('Nothing to read, so Resource Graph is skipped.');
    config.dataSources.resourceGraph = 'skip';
  }
  ctx.save();
}

/**
 * The roles the plan review lists for the app registration that runs the load.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} tenantId
 * @param {string} who
 * @param {{ canAssign?: boolean }} [o]  Whether the signed-in user can give Entra roles, when known.
 * @returns {import('./plan.js').ReviewGrant[]}
 */
export function resourceGraphGrants(config, tenantId, who, o = {}) {
  if (!resourceGraphOn(config)) return [];
  const rg = config.resourceGraph;
  /** @type {import('./plan.js').ReviewGrant[]} */
  const grants = [];
  if (rg?.foundry !== false && !rg?.access) {
    grants.push({ who, what: 'Reader', where: `Azure ${scopeName(config)} (${resourceGraphScope(config, tenantId)})`, detail: 'So Resource Graph can list Foundry resources and projects.' });
  }
  if (rg?.agents !== false && !rg?.roleAssigned) {
    const why = 'So Resource Graph returns Copilot Studio agents. Skipped when it already has Global Reader, Power Platform Administrator or AI Administrator.';
    grants.push({
      who,
      what: `${AGENT_ROLE} (Entra)`,
      where: 'Your tenant',
      detail:
        o.canAssign === true
          ? why
          : o.canAssign === false
            ? `${why} You can't give it yourself, so you get the steps for a Global Administrator or Privileged Role Administrator. Until then, the load reports agents as not collected.`
            : `${why} Given if you're a Global Administrator or Privileged Role Administrator; otherwise you get the steps for one.`,
    });
  }
  return grants;
}

/**
 * Gives the app registration Reader on the management group so Resource Graph can list Foundry. A
 * role you can't give is reported with the command for someone who can; the load still runs and
 * reports Foundry as not readable.
 * @param {Ctx} ctx
 * @param {Principal} who
 * @returns {Promise<boolean>}  Whether it has Reader, or Foundry is off.
 */
export async function ensureResourceGraphAccess(ctx, who) {
  const { ui, config, api, user } = ctx;
  if (!resourceGraphOn(config)) return false;
  const rg = (config.resourceGraph = normaliseResourceGraph(config.resourceGraph));
  const done = async () => {
    await ensureAgentDirectoryRole(ctx, who);
    return true;
  };
  if (!rg.foundry) return done();
  const where = scopeName(config);
  if (rg.access) {
    ui.ok(`${who.name} can read Foundry resources in ${where}`);
    return done();
  }
  const scope = resourceGraphScope(config, user.tenantId);
  try {
    await api.arm.assignRole(scope, ROLES.reader, who.id, 'ServicePrincipal');
  } catch (err) {
    if (!(err instanceof HttpError) || ![403, 404].includes(err.status)) throw err;
    ui.warn(`You can't assign Azure roles on ${where}, so Foundry can't be read yet.${err.status === 404 ? ' Check the management group ID.' : ''}`);
    ui.info(`An Owner or User Access Administrator there can give ${who.name} Reader with: ${readerCommand(who.appId ?? who.id, scope)}`);
    await ensureAgentDirectoryRole(ctx, who);
    const has = !ui.yes && (await ui.select('Then:', [
      { name: 'Leave Foundry out for now', value: false, description: 'The load reports Foundry as not readable until the role is there. Run the installer again then.' },
      { name: 'It already has access', value: true },
    ], false));
    if (has) {
      rg.access = true;
      ctx.save();
      return true;
    }
    return false;
  }
  rg.access = true;
  ctx.save();
  ui.ok(`Gave ${who.name} Reader on ${where}`);
  ui.note('New Azure roles can take a few minutes to apply. Until then the load reports Foundry as not readable.');
  return done();
}

/**
 * Gives the app Global Reader so Resource Graph returns Copilot Studio agents, when the signed-in
 * user is a Global Administrator or Privileged Role Administrator; otherwise shows the steps for
 * one. Does nothing when it already has a role that covers agents, or agents aren't read.
 * @param {Ctx} ctx
 * @param {Principal} who
 * @returns {Promise<'off' | 'has' | 'assigned' | 'handoff'>}
 */
export async function ensureAgentDirectoryRole(ctx, who) {
  const { ui, config, api } = ctx;
  if (!resourceGraphOn(config) || config.resourceGraph?.agents === false || !who.id) return 'off';
  const rg = config.resourceGraph;
  const has = (/** @type {string} */ role) => {
    rg.roleAssigned = role;
    ctx.save();
    ui.ok(`${who.name} has the ${role} Entra role, so Resource Graph returns Copilot Studio agents`);
    return /** @type {const} */ ('has');
  };
  if (rg.roleAssigned) return has(rg.roleAssigned);
  try {
    /** @type {Record<string, string>} */
    const names = AGENT_DIRECTORY_ROLE_IDS;
    const existing = (await api.graph.directoryRoleAssignments(who.id))
      .filter((a) => (a.directoryScopeId ?? '/') === '/')
      .map((a) => names[String(a.roleDefinitionId).toLowerCase()])
      .find(Boolean);
    if (existing) return has(existing);
  } catch {
    // Can't read role assignments: giving the role, or the steps, still settles it.
  }
  // Unknown is treated as not able to give roles, so the steps are shown.
  if (await canAssignDirectoryRoles(api).catch(() => false)) {
    /** @type {string | undefined} */
    let failed;
    // The usual Graph sign-in first; then, if that's refused, one that asks for role management on its own.
    for (const graph of [api.graph, api.graphRoles]) {
      if (!graph) continue;
      try {
        await graph.assignDirectoryRole(who.id, GLOBAL_READER_ROLE);
      } catch (err) {
        const text = err instanceof HttpError ? JSON.stringify(err.body ?? err.message) : '';
        if (!(err instanceof HttpError && err.status === 400 && /conflicting object|already exist/i.test(text))) {
          failed = /** @type {Error} */ (err).message;
          continue;
        }
      }
      rg.roleAssigned = AGENT_ROLE;
      ctx.save();
      ui.ok(`Gave ${who.name} the ${AGENT_ROLE} Entra role, so Resource Graph returns Copilot Studio agents`);
      ui.note('Entra roles can take a few minutes to apply. Until then the load reports agents as not collected.');
      return 'assigned';
    }
    ui.warn(`Couldn't give ${who.name} the ${AGENT_ROLE} Entra role (${failed}).`);
  }
  ui.warn(`${who.name} needs the ${AGENT_ROLE} Entra role so Resource Graph returns Copilot Studio agents. A Global Administrator or Privileged Role Administrator can give it:`);
  for (const line of directoryRoleHandoff(who)) ui.info(line);
  ui.note('Power Platform Administrator or AI Administrator also works. Until it has one, the load reports agents as "Not collected: permission missing". Run the installer again afterwards and it notices.');
  return 'handoff';
}

/**
 * Gives the app registration Reader for Foundry, and the Entra role for agents.
 * @param {Ctx} ctx
 */
export const ensureAppResourceGraphAccess = (ctx) =>
  ensureResourceGraphAccess(ctx, { id: /** @type {string} */ (ctx.config.app.servicePrincipalId), name: ctx.config.app.displayName ?? 'the app', appId: ctx.config.app.appId });
