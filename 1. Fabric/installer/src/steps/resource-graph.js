// @ts-check
/**
 * Agent configuration and Foundry, from Azure Resource Graph: the management group it reads, Reader
 * there for whoever runs the load, and the Entra role agents need, which is only described.
 */
import { ROLES } from '../clients/azure.js';
import { normaliseResourceGraph } from '../config.js';
import { HttpError } from '../http.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {{ id: string, name: string, appId?: string }} Principal */

/** Entra roles that let an app see Copilot Studio agents in Resource Graph. Any one will do. */
export const AGENT_DIRECTORY_ROLES = ['Global Reader', 'Power Platform Administrator', 'AI Administrator'];

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

/** @param {string} who */
export const directoryRoleStep = (who) =>
  `For agents, ${who} also needs one of these Entra roles: ${AGENT_DIRECTORY_ROLES.join(', ').replace(/, ([^,]*)$/, ' or $1')}. A Privileged Role Administrator assigns it in the Entra admin center under Roles and administrators; the installer doesn't. Without one, Resource Graph returns no agents and the load says so.`;

/**
 * Asks which management group to read and what to read there.
 * @param {Ctx} ctx
 */
export async function planResourceGraph(ctx) {
  const { ui, config } = ctx;
  if (!resourceGraphOn(config)) return;
  const rg = (config.resourceGraph = normaliseResourceGraph(config.resourceGraph));
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
    delete rg.azureAccess;
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
 * The roles the plan review lists for whoever runs the load.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} tenantId
 * @param {string} who
 * @param {'access' | 'azureAccess'} key
 * @returns {import('./plan.js').ReviewGrant[]}
 */
export function resourceGraphGrants(config, tenantId, who, key) {
  if (!resourceGraphOn(config)) return [];
  const rg = config.resourceGraph;
  /** @type {import('./plan.js').ReviewGrant[]} */
  const grants = [];
  if (rg?.foundry !== false && !rg?.[key]) {
    grants.push({ who, what: 'Reader', where: `Azure ${scopeName(config)} (${resourceGraphScope(config, tenantId)})`, detail: 'So Resource Graph can list Foundry resources and projects.' });
  }
  if (rg?.agents !== false) {
    grants.push({ who, what: `One of ${AGENT_DIRECTORY_ROLES.join(', ')} (Entra)`, where: 'Your tenant', detail: 'Not granted by the installer. So Resource Graph returns Copilot Studio agents; without it, the load reports none.' });
  }
  return grants;
}

/**
 * Gives the app, or the Azure jobs' managed identity, Reader on the management group so Resource
 * Graph can list Foundry. A role you can't give is reported with the command for someone who can;
 * the load still runs and reports Foundry as not readable.
 * @param {Ctx} ctx
 * @param {Principal} who
 * @param {'access' | 'azureAccess'} key  Where the record keeps that it's done.
 * @returns {Promise<boolean>}  Whether it has Reader, or Foundry is off.
 */
export async function ensureResourceGraphAccess(ctx, who, key) {
  const { ui, config, api, user } = ctx;
  if (!resourceGraphOn(config)) return false;
  const rg = (config.resourceGraph = normaliseResourceGraph(config.resourceGraph));
  const done = () => {
    if (rg.agents) ui.info(directoryRoleStep(`${who.name} (${who.appId ?? who.id})`));
    return true;
  };
  if (!rg.foundry) return done();
  const where = scopeName(config);
  if (rg[key]) {
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
    if (rg.agents) ui.info(directoryRoleStep(`${who.name} (${who.appId ?? who.id})`));
    const has = !ui.yes && (await ui.select('Then:', [
      { name: 'Leave Foundry out for now', value: false, description: 'The load reports Foundry as not readable until the role is there. Run the installer again then.' },
      { name: 'It already has access', value: true },
    ], false));
    if (has) {
      rg[key] = true;
      ctx.save();
      return true;
    }
    return false;
  }
  rg[key] = true;
  ctx.save();
  ui.ok(`Gave ${who.name} Reader on ${where}`);
  ui.note('New Azure roles can take a few minutes to apply. Until then the load reports Foundry as not readable.');
  return done();
}

/**
 * Gives the app Reader for Foundry on the Fabric path.
 * @param {Ctx} ctx
 */
export const ensureAppResourceGraphAccess = (ctx) =>
  ensureResourceGraphAccess(ctx, { id: /** @type {string} */ (ctx.config.app.servicePrincipalId), name: ctx.config.app.displayName ?? 'the app', appId: ctx.config.app.appId }, 'access');
