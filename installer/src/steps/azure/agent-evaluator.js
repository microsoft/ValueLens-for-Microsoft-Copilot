// @ts-check
/**
 * The Agent Evaluator on Azure. The jobs' managed identity reads Copilot Studio transcripts from each chosen Dataverse
 * environment as an application user with two roles: Bot Transcript Viewer, and a role the installer creates for the
 * install that reads every transcript, and nothing else. This module decides when the Agent Evaluator model is deployed,
 * used and refreshed, adds the managed identity to the environments, and removes what it added when an environment or
 * the module is unticked, or on uninstall. The picker and the access step are Fabric's (../agent-evaluator.js), with the
 * managed identity as the reader.
 */
import { TRANSCRIPT_ROLE } from '../../clients/dataverse.js';
import { HttpError } from '../../http.js';
import { EVALUATOR_STATUS_TABLE } from '../../transform/load-log.js';
import { c } from '../../ui.js';
import { agentEvaluatorSummary, appUsers, ensureTranscriptAccess, planAgentEvaluator, readRole, readRoleRecord, removeReadRole } from '../agent-evaluator.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {import('../../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../../config.js').AgentEnvironment} AgentEnvironment */
/** @typedef {import('../../config.js').AzureTranscriptAccess} AzureTranscriptAccess */

const param = (/** @type {any} */ value) => ({ value });
const last = (/** @type {string} */ path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
/** @param {string} url */
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/** @param {string | undefined} a @param {string | undefined} b */
const sameId = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** @param {string} a @param {string} b */
const sameUrl = (a, b) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
/** @param {string} s */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** @param {unknown} err */
const gone = (err) => err instanceof HttpError && err.status === 404;
/** @param {unknown} err */
const message = (err) => (err instanceof Error ? err.message : String(err));

/**
 * The Agent Evaluator model is deployed: the module is on with environments chosen, and the jobs read tenant data
 * (demo mode publishes no Agent Evaluator tables). It gates deploying the model and adding the jobs' managed identity
 * to the environments. A model already deployed stays in use on azureAgentEvaluatorModelDeployed.
 * @param {InstallConfig} config
 */
export const azureAgentEvaluatorOn = (config) => !!config.modules.agentEvaluator && config.agentEvaluator.environments.length > 0 && config.azure?.sampleData !== true;

/**
 * The Agent Evaluator model is in use: the module is on, the jobs read tenant data, and the model is deployed. Like
 * Fabric's agentEvaluatorModelDeployed, it doesn't check the environments, so the pages stay while the module is on,
 * empty until the jobs read transcripts. It gates the app's alias, viewer and org-scoped access, the model's database
 * credential, status and the summary, and pendingReloads checks the same. Unticked, or in demo mode, the model and its
 * ID are kept with its scheduled refresh off, so ticking it again reuses them.
 * @param {InstallConfig} config
 */
export const azureAgentEvaluatorModelDeployed = (config) => !!config.modules.agentEvaluator && config.azure?.sampleData !== true && !!config.azure?.powerBi?.agentEvaluatorDatasetId;

/**
 * The jobs' managed identity can read an environment: it was found there, or added, as itself. With Bot Transcript
 * Viewer alone it reads only the transcripts shared with it, so the jobs read it then too, and find what they can.
 * @param {AgentEnvironment} env @param {string | undefined} appId
 */
const readable = (env, appId) => !!env.access && sameId(env.accessAppId, appId);

/**
 * The jobs' managed identity can read every transcript in an environment: it also holds the install's read role there.
 * @param {AgentEnvironment} env @param {string | undefined} appId
 */
const readsAll = (env, appId) => readable(env, appId) && !!env.readAll;

/**
 * The jobs read transcripts: the module is on and the managed identity can read some chosen environment. Only then does
 * VALUELENS_DATAVERSE_ENVIRONMENTS list the environments.
 * @param {InstallConfig} config
 */
export const azureAgentEvaluatorReads = (config) => azureAgentEvaluatorOn(config) && config.agentEvaluator.environments.some((e) => readable(e, config.azure?.outputs?.identityClientId));

/**
 * The Agent Evaluator model refreshes: it's in use and the jobs read transcripts, as Fabric's refresh also needs
 * agentEvaluatorOn. It decides the installer's refresh and the Power BI schedule. The jobs skip the model on the same
 * condition, since they refresh it only while VALUELENS_DATAVERSE_ENVIRONMENTS lists environments
 * (azure/jobs/valuelens_jobs/refresh.py).
 * @param {InstallConfig} config
 */
export const azureAgentEvaluatorRefreshes = (config) => azureAgentEvaluatorModelDeployed(config) && azureAgentEvaluatorReads(config);

/**
 * The environments the jobs read, as VALUELENS_DATAVERSE_ENVIRONMENTS. None are listed until the managed identity can
 * read one of them, so the jobs neither collect transcripts nor refresh the model before then, though agentEvaluator is
 * in VALUELENS_MODULES while the module is ticked. From then on every chosen environment is listed, readable or not, so
 * the jobs report each one's status and pick up access an admin adds later.
 * @param {InstallConfig} config
 */
export const agentEvaluatorParameters = (config) => ({
  dataverseEnvironments: param(JSON.stringify((azureAgentEvaluatorReads(config) ? config.agentEvaluator.environments : []).map((e) => ({ url: e.url, ...(e.name ? { name: e.name } : {}) })))),
});

/**
 * Asks which environments' transcripts the jobs read. Demo mode reads none; the environments and any access are kept for
 * when you switch to your tenant's data.
 * @param {Ctx} ctx
 */
export async function planAzureAgentEvaluator(ctx) {
  const { ui, config } = ctx;
  if (!config.modules.agentEvaluator) return;
  if (config.azure?.sampleData === true) {
    ui.heading('Copilot Studio transcripts');
    ui.note('Demo mode has no Agent Evaluator sample, so no transcripts are read. Pick your tenant\'s data to read them.');
    return;
  }
  await planAgentEvaluator(ctx, { azure: true });
}

/** The jobs' managed identity's resource name, once the deployment returned it. @param {InstallConfig} config */
const identityName = (config) => (config.azure?.outputs?.identityId ? last(String(config.azure.outputs.identityId)) : undefined);

/**
 * The jobs' managed identity by name and client ID, which is how the admin center finds it.
 * @param {InstallConfig} config @param {string | undefined} appId
 */
function whoIs(config, appId) {
  const name = sameId(appId, config.azure?.outputs?.identityClientId) ? identityName(config) : undefined;
  return `the jobs' managed identity${name ? ` ${name}` : ''} (client ID ${appId})`;
}

/**
 * The role the installer creates in each environment for the jobs' managed identity, named for the install so it's
 * never another install's. A new managed identity gets it created again, once the old one's is deleted.
 * @param {InstallConfig} config
 */
const azureReadRole = (config) => {
  const appId = config.azure?.outputs?.identityClientId;
  return readRole(config.azure?.installId ?? appId ?? '', 'the Azure install', whoIs(config, appId));
};

/**
 * An entry is still wanted: its environment is chosen with the module on, for the managed identity in use. Demo mode
 * doesn't change that, so switching to it removes nothing.
 * @param {InstallConfig} config @param {AzureTranscriptAccess} entry
 */
function wanted(config, entry) {
  const appId = config.azure?.outputs?.identityClientId;
  return !!config.modules.agentEvaluator && (!appId || sameId(entry.appId, appId)) && config.agentEvaluator.environments.some((e) => sameUrl(e.url, entry.url));
}

/**
 * Notes that the jobs' managed identity can read an environment, as which client ID, and what the installer added
 * there, so that unticking the environment or uninstalling removes only that.
 * @param {Ctx} ctx @param {AgentEnvironment} env @param {Omit<import('../agent-evaluator.js').TranscriptGrant, 'result'>} [grant]
 */
function record(ctx, env, grant = {}) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const appId = /** @type {string} */ (az.outputs?.identityClientId);
  if (env.access) env.accessAppId = appId;
  if (!env.access && !grant.createdUser && !grant.roleId && !grant.readRoleId) return;
  const list = (az.transcriptAccess ??= []);
  const prev = list.find((t) => sameUrl(t.url, env.url) && sameId(t.appId, appId));
  const userId = grant.userId ?? prev?.userId;
  const roleId = grant.roleId ?? prev?.roleId;
  /** @type {AzureTranscriptAccess} */
  const entry = {
    url: env.url,
    appId,
    ...(env.name ?? prev?.name ? { name: env.name ?? prev?.name } : {}),
    ...(userId ? { userId } : {}),
    ...(prev?.createdUser || grant.createdUser ? { createdUser: true } : {}),
    ...(roleId ? { roleId } : {}),
    ...readRoleRecord(prev, grant),
  };
  // Replaced, not merged: a grant that found a role the installer didn't create clears createdReadRole.
  if (prev) list[list.indexOf(prev)] = entry;
  else list.push(entry);
}

/**
 * The jobs' managed identity, as the reader of the transcripts.
 * @param {Ctx} ctx
 * @returns {import('../agent-evaluator.js').TranscriptReader}
 */
function transcriptReader(ctx) {
  const { config } = ctx;
  const identity = identityName(config);
  return {
    appId: /** @type {string} */ (config.azure?.outputs?.identityClientId),
    name: 'the jobs\' managed identity',
    title: 'The jobs\' managed identity',
    managed: true,
    ...(identity ? { identity } : {}),
    readRole: azureReadRole(config),
    notes: {
      none: 'No environments chosen, so the jobs don\'t read transcripts.',
      leaveOut: 'Run the installer again once it\'s added, so it\'s checked and the jobs read the environment.',
      unread: 'The jobs\' managed identity can\'t read any of the environments yet, so the jobs don\'t read transcripts. Run the installer again once an admin adds it.',
      fill: 'The agent pages fill after the jobs\' next run reads the transcripts.',
    },
    record: (env, grant) => record(ctx, env, grant),
    reads: azureAgentEvaluatorReads,
  };
}

/**
 * How a System Administrator deletes a soft-deleted application user for good. See
 * https://learn.microsoft.com/power-platform/admin/delete-users#permanently-delete-users-in-power-platform
 * @param {string} where
 */
const deleteForGood = (where) =>
  `A System Administrator can delete it for good: Power Platform admin center > Manage > Environments > ${where} > Settings > Users + permissions > Users > ` +
  'Filter > Users not in Microsoft Entra ID and soft deleted in the environment > select it > Delete. Any records it owns must be reassigned first, and ' +
  `Settings > Product > Features > Enable delete disabled users must be on. It can't be activated again, so delete it before you tick ${where} again.`;

/**
 * Removes what the installer added for the jobs' managed identity in one environment: the read role it gave, and the
 * role itself if it created it, then the Bot Transcript Viewer role it assigned, then the application user it created,
 * which Dataverse deletes only once it's deactivated. Dataverse's first delete only soft-deletes the user, which stays,
 * deactivated with no role, so it's read back and deleted again, and said to be removed only once it's gone. What it
 * can't remove, or an admin added, is printed once for a System Administrator. Never throws.
 * @param {Ctx} ctx @param {AzureTranscriptAccess} entry
 * @returns {Promise<boolean>}  Whether the managed identity lost the access the installer gave it there.
 */
async function removeTranscriptAccess(ctx, entry) {
  const { ui, api, config } = ctx;
  const where = entry.name ?? host(entry.url);
  const who = whoIs(config, entry.appId);
  const user = `${appUsers(where)} > the one with client ID ${entry.appId}`;
  const ownsUser = !!entry.userId && (!!entry.roleId || !!entry.createdUser);
  const read = await removeReadRole(ctx, entry, {
    who,
    user,
    also: ownsUser && entry.roleId ? [TRANSCRIPT_ROLE] : [],
    after: ownsUser && entry.createdUser ? ' Then Deactivate it, and Delete it.' : '',
  });
  if (!read) return false;
  if (!ownsUser) {
    ui.note(`${cap(who)} is still an application user in ${where}. It was added outside the installer, so the installer leaves it; a System Administrator can remove it: ${user} > Deactivate, then Delete.`);
    return false;
  }
  const userId = /** @type {string} */ (entry.userId);
  try {
    const dv = api.dataverse(entry.url);
    if (entry.roleId) {
      try {
        await dv.removeRole(userId, entry.roleId);
      } catch (err) {
        if (!gone(err)) {
          ui.warn(`Couldn't take the ${TRANSCRIPT_ROLE} role away from ${who} in ${where} (${message(err)}), so it can still read transcripts there.`);
          ui.info(`A System Administrator can: ${user} > Edit security roles, clear ${TRANSCRIPT_ROLE} and Save.${entry.createdUser ? ' Then Deactivate it, and Delete it.' : ''}`);
          return false;
        }
      }
      if (!entry.createdUser) {
        ui.ok(`Took the ${TRANSCRIPT_ROLE} role away from ${who} in ${where}`);
        return true;
      }
    }
    try {
      await dv.disableUser(userId);
    } catch (err) {
      if (gone(err)) {
        ui.ok(`The application user for ${who} in ${where} is already gone`);
        return true;
      }
      ui.warn(`Dataverse wouldn't deactivate the application user for ${who} in ${where} (${message(err)}). It has no role now, so it can't read transcripts.`);
      ui.info(`A System Administrator can delete it: ${user} > Deactivate, then Delete.`);
      return true;
    }
    try {
      await dv.deleteUser(userId);
    } catch (err) {
      if (!gone(err)) {
        // Some environments won't delete an application user. Don't leave one the installer deactivated.
        try {
          await dv.enableUser(userId);
        } catch (again) {
          ui.warn(`Dataverse wouldn't delete the application user for ${who} in ${where} (${message(err)}), or activate it again (${message(again)}), so it's deactivated.`);
          ui.info(`A System Administrator can delete it (${user} > Delete), or activate it (Activate) before you tick ${where} again.`);
          return true;
        }
        ui.warn(`Dataverse wouldn't delete the application user for ${who} in ${where} (${message(err)}). It has no role now, so it can't read transcripts.`);
        ui.info(`A System Administrator can delete it: ${user} > Deactivate, then Delete.`);
        return true;
      }
    }
    // Dataverse's first delete only soft-deletes the user: it's still there, deactivated with no role, so it's deleted
    // again. A soft-deleted user can't be activated again, so unlike above, it's left deactivated if it stays.
    /** @type {string | undefined} */
    let why;
    try {
      if (await dv.getUser(userId)) {
        try {
          await dv.deleteUser(userId);
        } catch (err) {
          if (!gone(err)) why = message(err);
        }
        if (!why && (await dv.getUser(userId))) why = 'still there after a second delete';
      }
    } catch (err) {
      ui.warn(`Couldn't check that the application user for ${who} is gone from ${where} (${message(err)}). If it's still there, it's deactivated with no role, so it can't sign in or read transcripts.`);
      ui.info(deleteForGood(where));
      return true;
    }
    if (why) {
      ui.warn(`Dataverse only soft-deleted the application user for ${who} in ${where} (${why}). It's deactivated with no role, so it can't sign in or read transcripts.`);
      ui.info(deleteForGood(where));
      return true;
    }
    ui.ok(`Removed the application user for ${who} from ${where}`);
    return true;
  } catch (err) {
    ui.warn(`Couldn't remove what the installer added for ${who} in ${where} (${message(err)}).`);
    ui.info(`A System Administrator can: ${user} > Edit security roles, clear ${TRANSCRIPT_ROLE} and Save.${entry.createdUser ? ' Then Deactivate it, and Delete it.' : ''}`);
    return false;
  }
}

/**
 * Removes the entries `keep` rejects, one at a time, saving after each.
 * @param {Ctx} ctx @param {(entry: AzureTranscriptAccess) => boolean} keep
 */
async function removeEntries(ctx, keep) {
  const { config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  for (const entry of (az.transcriptAccess ?? []).filter((t) => !keep(t))) {
    const removed = await removeTranscriptAccess(ctx, entry);
    for (const env of config.agentEvaluator.environments) {
      if (!sameUrl(env.url, entry.url) || !sameId(env.accessAppId, entry.appId)) continue;
      // Checked again if the environment is ticked again, whatever was left.
      delete env.readAll;
      if (!removed) continue;
      delete env.access;
      delete env.accessAppId;
    }
    az.transcriptAccess = (az.transcriptAccess ?? []).filter((t) => t !== entry);
    if (!az.transcriptAccess.length) delete az.transcriptAccess;
    ctx.save();
  }
}

/**
 * The install needs the transcript step: to add the managed identity, or to remove what it added.
 * @param {InstallConfig} config
 */
export const azureTranscriptStepWanted = (config) => azureAgentEvaluatorOn(config) || (config.azure?.transcriptAccess?.length ?? 0) > 0;

/**
 * Removes what the installer added in environments no longer chosen, then gives the jobs' managed identity read access
 * to transcripts in each chosen one, or explains how an admin does. Demo mode only removes, and says what it keeps.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether the jobs read transcripts.
 */
export async function ensureAzureTranscriptAccess(ctx) {
  const { ui, config } = ctx;
  const appId = config.azure?.outputs?.identityClientId;
  await removeEntries(ctx, (t) => wanted(config, t));
  // Access found for another managed identity, before the resources were recreated, is checked again.
  if (appId) {
    for (const env of config.agentEvaluator.environments) {
      if (!env.access || sameId(env.accessAppId, appId)) continue;
      delete env.access;
      delete env.accessAppId;
      delete env.readAll;
    }
  }
  ctx.save();
  if (!azureAgentEvaluatorOn(config)) {
    const kept = config.azure?.transcriptAccess?.length ?? 0;
    if (kept && config.azure?.sampleData === true) {
      ui.note(`Demo mode reads no transcripts. ${cap(whoIs(config, appId))} keeps its access in ${kept} environment${kept === 1 ? '' : 's'} for when you switch to your tenant's data.`);
    }
    return false;
  }
  if (!appId) throw new Error('The deployment returned no client ID for the jobs\' managed identity.');
  return ensureTranscriptAccess(ctx, transcriptReader(ctx));
}

/**
 * Removes what the installer added for the jobs' managed identity in every environment, and prints what's left for a
 * System Administrator. Uninstall runs it before the resource group, and the identity, go.
 * @param {Ctx} ctx
 */
export async function removeAzureTranscriptAccess(ctx) {
  if (!ctx.config.azure?.transcriptAccess?.length) return;
  await removeEntries(ctx, () => false);
}

/**
 * What the plan adds and grants for the transcripts: the managed identity's application user and the install's read
 * role in each chosen environment, and the ones it removes.
 * @param {InstallConfig} config
 */
export function transcriptAccessReview(config) {
  const appId = config.azure?.outputs?.identityClientId;
  const envs = azureAgentEvaluatorOn(config) ? config.agentEvaluator.environments : [];
  const recorded = config.azure?.transcriptAccess ?? [];
  const name = (/** @type {string} */ where) => `Jobs' managed identity in ${where}`;
  const role = config.azure?.installId ? azureReadRole(config).name : 'Transcript reader role';
  /** The role recorded for an environment, which the installer created or gave. @param {string} url */
  const recordedRole = (url) => recorded.find((t) => sameUrl(t.url, url) && t.readRoleId);
  const removed = recorded.filter((t) => !wanted(config, t));
  const creates = [
    ...envs.map((e) => ({
      kind: 'Dataverse application user',
      name: name(e.name ?? host(e.url)),
      isNew: !readable(e, appId),
      detail: `With the ${TRANSCRIPT_ROLE} role and the transcript reader role, so the jobs read the environment's Copilot Studio transcripts. A System Administrator adds it if you can't.`,
    })),
    // Not where an admin gave it a role that reads every transcript: the installer neither adds nor removes that.
    ...envs.filter((e) => !readsAll(e, appId) || recordedRole(e.url)).map((e) => ({
      kind: 'Dataverse security role',
      name: `${recordedRole(e.url)?.readRoleName ?? role} in ${e.name ?? host(e.url)}`,
      isNew: !readsAll(e, appId),
      detail: 'Reads every Copilot Studio conversation transcript there, and nothing else. Created for this install, given to the jobs\' managed identity, and deleted on uninstall.',
    })),
    ...removed.map((t) => ({
      kind: 'Dataverse application user',
      name: name(t.name ?? host(t.url)),
      isNew: false,
      detail: t.createdUser
        ? 'No longer chosen, so the installer deletes the application user it created.'
        : t.roleId
          ? `No longer chosen, so the installer takes away the ${TRANSCRIPT_ROLE} role it gave.`
          : 'No longer chosen. An admin added it, so the installer leaves it and says how to remove it.',
    })),
    ...removed.filter((t) => t.readRoleId && (t.createdReadRole || t.assignedReadRoleId)).map((t) => ({
      kind: 'Dataverse security role',
      name: `${t.readRoleName ?? role} in ${t.name ?? host(t.url)}`,
      isNew: false,
      detail: t.createdReadRole
        ? 'No longer chosen, so the installer takes it away and deletes the role it created.'
        : 'No longer chosen, so the installer takes it away. It didn\'t create the role, so it leaves it.',
    })),
  ];
  const waiting = envs.filter((e) => !readsAll(e, appId));
  const grants = waiting.length
    ? [
        {
          who: 'Collector managed identity',
          what: `Dataverse application user with the ${TRANSCRIPT_ROLE} role and a role that reads every transcript`,
          where: waiting.map((e) => e.name ?? host(e.url)).join(', '),
          detail: 'So the jobs read every Copilot Studio transcript. Needs a System Administrator of each environment.',
        },
      ]
    : [];
  return { creates, grants };
}

/**
 * The confirm screen's line for the environments the jobs read.
 * @param {Ctx} ctx
 */
export function azureAgentEvaluatorConfirmLine(ctx) {
  const { ui, config } = ctx;
  if (!config.modules.agentEvaluator || config.azure?.sampleData === true) return;
  const envs = config.agentEvaluator.environments;
  if (!envs.length) return ui.info(`Agents:      ${c.dim('no environments chosen')}`);
  const appId = config.azure?.outputs?.identityClientId;
  const waiting = envs.some((e) => !readsAll(e, appId));
  ui.info(
    `Agents:      ${envs.map((e) => e.name ?? host(e.url)).join(', ')}` +
      `${waiting ? c.dim(`  (the jobs' managed identity is added to each with the ${TRANSCRIPT_ROLE} role and a role that reads every transcript)`) : ''}`,
  );
}

/**
 * Which environments the jobs' managed identity can read, and what the jobs' last read found there.
 * @param {Ctx} ctx
 */
export async function azureTranscriptStatus(ctx) {
  const { ui, config, api } = ctx;
  if (!config.modules.agentEvaluator || config.azure?.sampleData === true) return;
  const envs = config.agentEvaluator.environments;
  const appId = config.azure?.outputs?.identityClientId;
  if (!envs.length) return ui.info(`Agents:         ${c.dim('no environments chosen')}`);
  const read = envs.filter((e) => readsAll(e, appId)).length;
  ui.info(
    `Agents:         ${read} of ${envs.length} environment(s) readable` +
      `${read < envs.length ? c.dim(' (the rest are waiting for an admin to add the jobs\' managed identity, or give it the role that reads every transcript)') : ''}`,
  );
  for (const env of envs) ui.info(`  ${readsAll(env, appId) ? c.green('✓') : c.yellow('!')} ${env.name ?? host(env.url)} ${c.dim(`(${host(env.url)})`)}`);
  const pbi = config.azure?.powerBi;
  if (!azureAgentEvaluatorModelDeployed(config) || !pbi?.workspaceId) return;
  /** @type {Record<string, any>[] | undefined} */
  let rows;
  try {
    const res = await api.powerBi.executeQueries(pbi.workspaceId, /** @type {string} */ (pbi.agentEvaluatorDatasetId), `EVALUATE '${EVALUATOR_STATUS_TABLE}'`);
    rows = res?.results?.[0]?.tables?.[0]?.rows ?? [];
  } catch {
    return;
  }
  /** A column of a query row, whose keys are 'Table[Column]'. @param {Record<string, any>} row @param {string} name */
  const cell = (row, name) => Object.entries(row).find(([k]) => k.endsWith(`[${name}]`))?.[1];
  if (!rows?.length) return ui.note('The jobs haven\'t read any transcripts yet.');
  ui.info(`Last read:      ${cell(rows[0], 'RunAt') ?? 'unknown'}`);
  for (const row of rows) {
    const reason = cell(row, 'Reason');
    ui.info(`  ${cell(row, 'Environment') ?? cell(row, 'EnvironmentUrl') ?? '?'}: ${cell(row, 'Status') ?? '?'}${reason ? c.dim(` (${reason})`) : ''}`);
  }
}

/**
 * The summary's transcript section: which environments are read, and which wait for an admin.
 * @param {Ctx} ctx
 */
export function azureAgentEvaluatorSummary(ctx) {
  const { config } = ctx;
  if (!config.modules.agentEvaluator || config.azure?.sampleData === true) return;
  agentEvaluatorSummary(ctx, transcriptReader(ctx));
}
