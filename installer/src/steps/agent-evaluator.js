// @ts-check
/**
 * The Agent Evaluator, from AgentEvaluator-for-Copilot-Studio: the Power Platform environments
 * whose Copilot Studio transcripts the parser notebook reads, the app's access to them, and the
 * Agent Evaluator model, which reads the Lakehouse through the ValueLens model's connection. On
 * Azure, azure/agent-evaluator.js reuses the picker and the access step for the jobs' managed identity.
 *
 * The reader is an application user in each environment with two roles: Bot Transcript Viewer,
 * which Copilot Studio creates but which reads only the transcripts shared with the reader, and a
 * role the installer creates for the install that reads every transcript, and nothing else.
 */
import { orgUrl, READ_ROLE_MARK, TRANSCRIPT_READ_PRIVILEGES, TRANSCRIPT_ROLE } from '../clients/dataverse.js';
import { semanticModelDefinition } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { rlsSettings } from '../transform/access.js';
import { buildAgentEvaluatorModel, loadTemplateModel, PBISM } from '../transform/model.js';
import { c } from '../ui.js';
import { agentEvaluatorOn } from './fabric.js';
import { bindModel, deployModel, modelUrl, waitForSqlEndpoint } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../config.js').AgentEnvironment} AgentEnvironment */
/** @typedef {import('../config.js').FabricTranscriptAccess} FabricTranscriptAccess */
/** @typedef {Pick<FabricTranscriptAccess, 'readRoleId' | 'readRoleName' | 'createdReadRole' | 'assignedReadRoleId'>} ReadRoleRecord */

/**
 * The role the installer creates for a reader in each environment. Each install has its own, so removing one install's
 * role never touches another's.
 * @typedef {object} ReadRole
 * @property {string} name
 * @property {string} description  Starts with READ_ROLE_MARK and holds `key`, which is how the installer knows the role is its own.
 * @property {string} key  The install's ID.
 */

/**
 * Who reads the transcripts: the app on Fabric, or the jobs' managed identity on Azure.
 * @typedef {object} TranscriptReader
 * @property {string} appId  The application (client) ID its application users are made for.
 * @property {string} name  Its name mid-sentence.
 * @property {string} [title]  Its name at the start of a sentence. Defaults to `name`.
 * @property {boolean} [managed]  It's a managed identity, which admins find by its client ID rather than its name.
 * @property {string} [identity]  The managed identity's resource name.
 * @property {ReadRole} readRole  The role that lets it read every transcript.
 * @property {{ leaveOut?: string, none?: string, unread?: string, fill?: string }} [notes]  What to say instead of the Fabric texts.
 * @property {(env: AgentEnvironment, grant?: Omit<TranscriptGrant, 'result'>) => void} [record]  Called once it can read an environment, or was given something there.
 * @property {(config: InstallConfig) => boolean} [reads]  Whether the transcripts are read. Defaults to Fabric's agentEvaluatorOn.
 */

/**
 * What adding a reader to an environment did.
 * @typedef {object} TranscriptGrant
 * @property {'ok' | 'added' | 'disabled' | 'no-role' | 'no-copy' | 'unverified' | 'held'} result  no-copy: the user's business unit has
 *   no copy of the read role yet. unverified: the read role doesn't hold exactly what it should, so it wasn't given.
 *   held: a user or team other than the reader has the read role, or a copy of it, so it wasn't changed or given.
 * @property {string} [userId]  Its application user.
 * @property {boolean} [createdUser]  The application user was created now.
 * @property {string} [roleId]  The Bot Transcript Viewer role, when it was assigned now.
 * @property {boolean} [viewer]  It has the Bot Transcript Viewer role.
 * @property {string} [readRoleId]  The read role, in the root business unit.
 * @property {string} [readRoleName]
 * @property {boolean} [createdReadRole]  The installer created the read role, now or before.
 * @property {string} [assignedReadRoleId]  The read role, or its copy in the user's business unit, that the installer gave the user.
 * @property {boolean} [newReadRole]  The read role was created now.
 * @property {boolean} [fixedReadRole]  The read role was there, and its privileges were set back.
 * @property {boolean} [gaveReadRole]  The read role was given to the user now.
 * @property {string[]} [holds]  unverified: what the read role holds, as privilege:depth.
 * @property {'read' | 'unread'} [sample]  Whether Dataverse shows the reader can read one transcript there.
 */

/**
 * The role the installer creates for a reader, named for the install.
 * @param {string} key  The install's ID.
 * @param {string} install  The install, mid-sentence, before its ID.
 * @param {string} who  The reader, mid-sentence.
 * @returns {ReadRole}
 */
export const readRole = (key, install, who) => ({
  name: `Analytics Hub transcript reader ${key.slice(0, 8)}`.trim(),
  description:
    `${READ_ROLE_MARK} for ${install} ${key}. It lets ${who} read every Copilot Studio conversation transcript in this environment, and nothing else. ` +
    'The installer deletes it on uninstall, or when this environment is no longer chosen.',
  key,
});

/** The installer created this role for the install. @param {{ description?: string | null }} role @param {ReadRole} want */
const ours = (role, want) => !!want.key && !!role.description?.startsWith(READ_ROLE_MARK) && role.description.includes(want.key);

/**
 * The name the manual steps suggest. It isn't the installer's own name for the role, so a role an admin makes this way
 * is never mistaken for the installer's, or changed by it.
 */
const MANUAL_ROLE_NAME = 'Analytics Hub transcript reader';

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
/** Where the admin center lists an environment's application users. @param {string} where */
export const appUsers = (where) => `Power Platform admin center > Manage > Environments > ${where} > Settings > Users + permissions > Application users`;

/** The app's read role on Fabric, named for the workspace. @param {InstallConfig} config */
export function appReadRole(config) {
  const appId = config.app.appId ?? '';
  const ws = config.fabric.workspaceId;
  return readRole(ws ?? appId, ws ? 'the install in Fabric workspace' : 'the install for app', `the app registration ${config.app.displayName ?? appId} (client ID ${appId})`);
}

/** The app, which the transcript notebook signs in as. @param {Ctx} ctx @returns {TranscriptReader} */
const appReader = (ctx) => ({
  appId: /** @type {string} */ (ctx.config.app.appId),
  name: ctx.config.app.displayName ?? 'the app',
  readRole: appReadRole(ctx.config),
  record: (env, grant) => recordFabric(ctx, env, grant),
});

/**
 * The Agent Evaluator model is deployed: the module is on with environments chosen, the ValueLens
 * model (whose connection it shares) is on, and this checkout has the template.
 * @param {Ctx} ctx
 */
export const agentEvaluatorModelWanted = (ctx) =>
  !!(ctx.config.modules.agentEvaluator && ctx.config.agentEvaluator.environments.length && ctx.config.semanticModel.enabled && ctx.sources.agentEvaluatorModelFile);

/** @param {string} v */
function validateUrls(v) {
  for (const part of splitUrls(v)) {
    try {
      if (new URL(part).protocol !== 'https:') return `${part} isn't an https URL.`;
    } catch {
      return `${part} isn't a URL. Use the environment URL, e.g. https://contoso.crm.dynamics.com.`;
    }
  }
  return true;
}

/** @param {string} v */
const splitUrls = (v) => v.split(/[\s,;]+/).filter(Boolean);

/** @param {string} url */
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Environments probed for agents at once, and how long each probe may take. */
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 8000;

/** Discovery doesn't flag the default environment; its name ends "(default)". */
const isDefault = (/** @type {import('../clients/dataverse.js').DataverseInstance} */ i) => /\(default\)\s*$/i.test(i.FriendlyName ?? '');

/**
 * Which environments hold Copilot Studio agents. An environment that can't be read in time, or
 * at all, is left out of the answer rather than guessed.
 * @param {Ctx} ctx
 * @param {string[]} urls
 * @returns {Promise<Map<string, boolean>>}
 */
export async function environmentsWithAgents(ctx, urls) {
  /** @type {Map<string, boolean>} */
  const found = new Map();
  const queue = [...urls];
  const probe = async (/** @type {string} */ url) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, PROBE_TIMEOUT_MS, undefined);
      timer.unref?.();
    });
    try {
      const dv = ctx.api.dataverse(url);
      if (typeof dv?.hasAgents !== 'function') return;
      const has = await Promise.race([dv.hasAgents(), timeout]);
      if (typeof has === 'boolean') found.set(url, has);
    } catch {
      // No access to the bot table yet: the person ticks the environment themselves.
    } finally {
      clearTimeout(timer);
    }
  };
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) await probe(url);
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker));
  return found;
}

/**
 * Asks which environments' transcripts to read.
 * @param {Ctx} ctx
 * @param {{ azure?: boolean }} [opts]  azure: for the Azure jobs, which read the transcripts as their managed identity.
 */
export async function planAgentEvaluator(ctx, opts = {}) {
  const { ui, config, api, sources } = ctx;
  const ae = config.agentEvaluator;
  const none = opts.azure ? 'No environments chosen, so the jobs don\'t read transcripts.' : 'No environments chosen, so the transcript notebook isn\'t deployed.';
  /** The access an environment had, kept while it stays chosen. @param {AgentEnvironment | undefined} prev */
  const kept = (prev) =>
    prev?.access
      ? { access: true, ...(prev.readAll ? { readAll: true } : {}), ...(opts.azure && prev.accessAppId ? { accessAppId: prev.accessAppId } : {}) }
      : {};
  ui.heading('Copilot Studio transcripts');
  // The Azure install says so itself if this checkout has no Agent Evaluator report.
  if (!opts.azure && !config.semanticModel.enabled) {
    ui.note('The transcripts model shares the main semantic model\'s connection, so it is only deployed with it.');
    ui.note('The notebook still loads the transcripts; publish the transcripts report ("Agent Evaluator.pbit") yourself.');
  } else if (!opts.azure && !sources.agentEvaluatorModelFile) {
    ui.note('This checkout has no transcripts report ("Agent Evaluator.pbit"), so only the notebook is deployed.');
  }

  /** @type {import('../clients/dataverse.js').DataverseInstance[] | undefined} */
  let found;
  try {
    found = (await api.discovery.instances()).filter((i) => i.Url && (i.State ?? 0) === 0);
  } catch (err) {
    ui.warn(`Couldn't list your Power Platform environments (${/** @type {Error} */ (err).message}).`);
  }

  /** @type {string[]} */
  let urls;
  if (!found?.length) {
    if (found) ui.note('You aren\'t a member of any Power Platform environment.');
    const answer = await ui.input('Environment URLs to read, separated by commas. Leave blank to skip.', {
      default: ae.environments.map((e) => e.url).join(', '),
      validate: validateUrls,
    });
    urls = splitUrls(answer).map(orgUrl);
  } else {
    const before = new Set(ae.environments.map((e) => e.url));
    const listed = found
      .map((i) => ({ i, url: orgUrl(i.Url) }))
      .sort((a, b) => (a.i.FriendlyName ?? a.url).localeCompare(b.i.FriendlyName ?? b.url));
    const listedUrls = new Set(listed.map((l) => l.url));
    const missing = ae.environments.filter((e) => !listedUrls.has(e.url));
    /** @type {Set<string>} */
    let ticked = before;
    if (!before.size) {
      // First time: tick the environments that hold agents, or else the default one, and say which.
      const agents = await environmentsWithAgents(ctx, listed.map((l) => l.url));
      const withAgents = listed.filter((l) => agents.get(l.url)).map((l) => l.url);
      const fallback = listed.filter((l) => isDefault(l.i)).map((l) => l.url);
      ticked = new Set(withAgents.length ? withAgents : fallback);
      if (withAgents.length) ui.note(`Ticked the ${withAgents.length === 1 ? 'environment that has' : `${withAgents.length} environments that have`} Copilot Studio agents.`);
      else if (listed.length > 1) {
        ui.note(
          fallback.length
            ? 'Couldn\'t tell which environments have Copilot Studio agents, so only the default environment is ticked. Tick every environment that holds your agents.'
            : 'Couldn\'t tell which environments have Copilot Studio agents. Tick every environment that holds your agents.',
        );
      }
    }
    ui.note('Only environments you\'re a member of are listed. To add one later, run the installer again and choose Repair or change.');
    urls = await ui.checkbox('Read the environments that hold your Copilot Studio agents', [
      ...listed.map(({ i, url }) => ({
        name: `${i.FriendlyName ?? i.UniqueName ?? host(url)} (${host(url)})`,
        value: url,
        checked: ticked.has(url),
        ...(i.IsUserSysAdmin === false ? { description: opts.azure ? 'You aren\'t a System Administrator here, so an admin adds the jobs\' managed identity.' : 'You aren\'t a System Administrator here, so an admin adds the app.' } : {}),
      })),
      ...missing.map((e) => ({ name: `${e.name ?? host(e.url)} (${host(e.url)}, not in your list)`, value: e.url, checked: true })),
    ]);
    const meta = new Map(listed.map(({ i, url }) => [url, i]));
    ae.environments = urls.map((url) => {
      const i = meta.get(url);
      const prev = ae.environments.find((e) => e.url === url);
      return { url, id: i?.EnvironmentId ?? prev?.id, name: i?.FriendlyName ?? prev?.name, ...kept(prev) };
    });
    if (!urls.length) ui.warn(none);
    return;
  }
  ae.environments = [...new Set(urls)].map((url) => {
    const prev = ae.environments.find((e) => e.url === url);
    return { url, ...(prev?.id ? { id: prev.id } : {}), ...(prev?.name ? { name: prev.name } : {}), ...kept(prev) };
  });
  if (!urls.length) ui.warn(none);
}

/**
 * Whether a user or team other than the reader has the role, or a copy Dataverse made of it in a child business unit.
 * More than a page of copies or holders counts as someone else.
 * @param {import('../clients/dataverse.js').DataverseApi} dv
 * @param {string} roleId  The role in the root business unit.
 * @param {string} userId  The reader's application user.
 * @returns {Promise<boolean>}
 */
async function othersHold(dv, roleId, userId) {
  const copies = await dv.roleCopies(roleId);
  if (copies.more) return true;
  for (const id of [roleId, ...copies.ids.filter((id) => !sameId(id, roleId))]) {
    const holders = await dv.roleHolders(id);
    if (holders.more || holders.teams.length || holders.users.some((u) => !sameId(u, userId))) return true;
  }
  return false;
}

/**
 * Adds the app as an application user with the Bot Transcript Viewer role and the install's read role.
 * @param {import('../clients/dataverse.js').DataverseApi} dv
 * @param {string} appId
 * @param {ReadRole} role
 * @returns {Promise<TranscriptGrant['result']>}
 */
export async function grantTranscriptAccess(dv, appId, role) {
  return (await addTranscriptReader(dv, appId, role)).result;
}

/**
 * Adds an application user for `appId` with the Bot Transcript Viewer role and the install's read role, and says what
 * it added, so that only that is removed later. The read role is created in the root business unit when it isn't
 * there, and its privileges are set to exactly ConversationTranscript read at Organization depth, then read back: a new
 * role comes with platform privileges of its own, and a run stopped part way leaves them. A role that only shares the
 * name is never changed, only given when it already holds exactly that. Transcript read is added to the installer's
 * role only while no user or team other than the reader has the role or a copy of it; otherwise the role is left as it
 * is, not given, and not noted as the installer's. When a step fails after something was found or added, the error
 * carries the grant so far as `grant`.
 * @param {import('../clients/dataverse.js').DataverseApi} dv
 * @param {string} appId
 * @param {ReadRole} role
 * @returns {Promise<TranscriptGrant>}
 */
export async function addTranscriptReader(dv, appId, role) {
  /** @type {Omit<TranscriptGrant, 'result'>} */
  const made = {};
  /** @type {string | undefined} */
  let root;
  const rootUnit = async () => {
    root ??= await dv.rootBusinessUnit();
    if (!root) throw new Error('Dataverse returned no root business unit.');
    return root;
  };
  try {
    let user = await dv.findAppUser(appId);
    if (!user) {
      const top = await rootUnit();
      user = { systemuserid: await dv.createAppUser(appId, top), _businessunitid_value: top };
      made.createdUser = true;
    }
    const userId = user.systemuserid;
    made.userId = userId;
    if (user.isdisabled) return { result: 'disabled', ...made };
    const bu = user._businessunitid_value ?? (root ??= await dv.rootBusinessUnit());
    const viewer = bu ? await dv.findRole(TRANSCRIPT_ROLE, bu) : undefined;
    if (!bu || !viewer) return { result: 'no-role', ...made };
    const held = new Set((await dv.userRoleIds(userId)).map((r) => r.toLowerCase()));
    if (!held.has(viewer.toLowerCase())) {
      await dv.assignRole(userId, viewer);
      made.roleId = viewer;
    }
    made.viewer = true;

    const top = await rootUnit();
    const named = await dv.rolesByName(role.name, top);
    const mine = named.find((r) => ours(r, role));
    const existing = (mine ?? named[0])?.roleid;
    const readRoleId = existing ?? (await dv.createRole({ name: role.name, businessUnitId: top, description: role.description }));
    if (!existing) made.newReadRole = true;
    const owned = !!mine || !!made.newReadRole;
    const claim = () => {
      made.readRoleId = readRoleId;
      made.readRoleName = role.name;
      if (owned) made.createdReadRole = true;
    };
    // A role created now is noted at once, so it's deleted even if a later step fails. One found by its description is
    // noted only once the installer may change it.
    if (!owned || made.newReadRole) claim();

    const found = await dv.findPrivileges(TRANSCRIPT_READ_PRIVILEGES);
    /** The privileges the role holds, by lower-case ID, to their IDs as Dataverse gave them. @type {Map<string, string>} */
    const want = new Map();
    for (const name of TRANSCRIPT_READ_PRIVILEGES) {
      const p = found.find((f) => f.name?.toLowerCase() === name.toLowerCase());
      if (!p) throw new Error(`Dataverse has no ${name} privilege.`);
      want.set(p.privilegeid.toLowerCase(), p.privilegeid);
    }
    const right = (/** @type {{ id: string, depth: string }} */ p) => want.has(p.id.toLowerCase()) && p.depth === 'Global';
    if (owned) {
      const before = await dv.rolePrivileges(readRoleId);
      const kept = new Set(before.filter(right).map((p) => p.id.toLowerCase()));
      const missing = [...want].filter(([key]) => !kept.has(key)).map(([, id]) => id);
      // Transcript read would reach whoever else has the role, so then it's left as it is. Taking privileges off needs no check.
      if (missing.length && (await othersHold(dv, readRoleId, userId))) return { result: 'held', ...made };
      claim();
      // Off first, then on: a privilege at the wrong depth is taken off and added again at Organization depth.
      for (const p of before.filter((p) => !right(p))) await dv.removePrivilege(readRoleId, p.id);
      if (missing.length) await dv.addPrivileges(readRoleId, missing, top);
      if (!made.newReadRole && (missing.length || before.some((p) => !right(p)))) made.fixedReadRole = true;
    }
    const now = await dv.rolePrivileges(readRoleId);
    const exact = now.length === want.size && now.every(right) && new Set(now.map((p) => p.id.toLowerCase())).size === want.size;
    if (!exact) return { result: 'unverified', ...made, holds: now.map((p) => `${p.name ?? p.id}:${p.depth}`).sort() };

    // Dataverse copies a root business unit's roles into each child unit, and a user holds the copy in its own unit.
    // The copy is found by the role it was made from, so a role that only shares the name there is never given.
    const copy = bu.toLowerCase() === top.toLowerCase() ? readRoleId : await dv.roleCopy(readRoleId, bu);
    if (!copy) return { result: 'no-copy', ...made };
    if (!held.has(copy.toLowerCase())) {
      await dv.assignRole(userId, copy);
      made.gaveReadRole = true;
      made.assignedReadRoleId = copy;
    } else if (owned) made.assignedReadRoleId = copy;

    /** @type {TranscriptGrant['sample']} */
    let sample;
    try {
      const id = await dv.firstTranscript();
      if (id) sample = /\bReadAccess\b/.test(await dv.principalAccess(userId, `conversationtranscripts(${id})`)) ? 'read' : 'unread';
    } catch {
      // Only a check: you may not read transcripts yourself, or may not ask about another user's access.
    }
    const added = made.createdUser || made.roleId || made.newReadRole || made.gaveReadRole;
    return { result: added ? 'added' : 'ok', ...made, ...(sample ? { sample } : {}) };
  } catch (err) {
    // Once the user was created, or holds Bot Transcript Viewer, the caller records what's there.
    if (err instanceof Error && (made.createdUser || made.viewer)) Object.assign(err, { grant: { ...made } });
    throw err;
  }
}

/**
 * Gives the app read access to transcripts in each chosen environment, or explains how an admin does.
 * @param {Ctx} ctx
 * @param {TranscriptReader} [reader]  Who reads them. Defaults to the app.
 * @returns {Promise<boolean>}  Whether the transcripts are read: on Fabric, whether the transcript notebook can run.
 */
export async function ensureTranscriptAccess(ctx, reader = appReader(ctx)) {
  const { ui, config, api } = ctx;
  const envs = config.agentEvaluator.environments;
  const app = reader.name;
  const App = reader.title ?? reader.name;
  if (!envs.length) {
    ui.note(reader.notes?.none ?? 'No environments chosen, so the transcript notebook isn\'t deployed.');
    return false;
  }
  for (const env of envs) {
    const where = env.name ?? host(env.url);
    if (env.access && env.readAll) {
      ui.ok(`${App} can read every transcript in ${where}`);
      reader.record?.(env);
      continue;
    }
    /** @type {TranscriptGrant} */
    let grant;
    try {
      grant = await addTranscriptReader(api.dataverse(env.url), reader.appId, reader.readRole);
    } catch (err) {
      const made = /** @type {{ grant?: TranscriptGrant }} */ (err)?.grant;
      // With Bot Transcript Viewer it reads the transcripts shared with it, as before this role.
      if (made?.viewer) env.access = true;
      if ((made || env.access) && reader.record) {
        reader.record(env, made);
        ctx.save();
      }
      const viewer = !!env.access;
      if (!(err instanceof HttpError)) {
        if (!viewer) throw err;
        ui.warn(`Couldn't give ${app} a role that reads every transcript in ${where} (${message(err)}), so it reads only the transcripts shared with it there for now.`);
        continue;
      }
      if (err.status === 401 || err.status === 403) {
        if (viewer) {
          ui.warn(`You can't give ${app} a role that reads every transcript in ${where}, so it reads only the transcripts shared with it there until someone does.`);
          manualSteps(ctx, env, reader, { roleOnly: true });
        } else {
          ui.warn(`You can't add ${app} to ${where}, so its transcripts are skipped until someone does.`);
          manualSteps(ctx, env, reader);
        }
        if (!ui.yes) {
          const done = await ui.select(
            'Then:',
            viewer
              ? [
                  { name: 'Carry on for now', value: false, description: 'It reads only the transcripts shared with it until it has the role.' },
                  { name: 'It already reads every transcript', value: true },
                ]
              : [
                  { name: 'Leave it out for now', value: false, description: reader.notes?.leaveOut ?? 'The notebook picks it up on the first run after the app is added.' },
                  { name: 'It already has access', value: true },
                ],
            false,
          );
          if (done) {
            env.access = true;
            env.readAll = true;
            reader.record?.(env);
            ctx.save();
          }
        }
      } else if (viewer) {
        ui.warn(`Couldn't give ${app} a role that reads every transcript in ${where} (${err.message}), so it reads only the transcripts shared with it there for now.`);
      } else {
        ui.warn(`Couldn't set up ${app} in ${where} (${err.message}). Its transcripts are skipped for now.`);
      }
      continue;
    }
    if (grant.result === 'disabled' || grant.result === 'no-role') {
      if (reader.record) {
        reader.record(env, grant);
        ctx.save();
      }
      if (grant.result === 'disabled') {
        ui.warn(`${App}'s application user in ${where} is disabled, so its transcripts are skipped.`);
        ui.info('Enable it in the Power Platform admin center: the environment > Settings > Users + permissions > Application users.');
      } else {
        ui.warn(`${where} has no ${TRANSCRIPT_ROLE} role, so Copilot Studio isn't set up there. Its transcripts are skipped.`);
      }
      continue;
    }
    env.access = true;
    if (grant.result === 'ok' || grant.result === 'added') env.readAll = true;
    else delete env.readAll;
    reader.record?.(env, grant);
    ctx.save();
    const role = `"${grant.readRoleName ?? reader.readRole.name}"`;
    const settled = grant.result !== 'unverified' && grant.result !== 'held';
    if (grant.newReadRole && settled) ui.ok(`Created the ${role} role in ${where}: it reads every Copilot Studio conversation transcript there, and nothing else`);
    else if (grant.fixedReadRole && settled) ui.ok(`Set the ${role} role in ${where} to read only Copilot Studio conversation transcripts`);
    const gave = [...(grant.roleId ? [TRANSCRIPT_ROLE] : []), ...(grant.gaveReadRole ? [role] : [])];
    if (gave.length) ui.ok(`Gave ${app} the ${gave.join(' and ')} role${gave.length > 1 ? 's' : ''} in ${where}`);
    else if (env.readAll) ui.ok(`${App} can read every transcript in ${where}`);
    if (grant.result === 'no-copy') {
      ui.warn(`${where} has no copy of the ${role} role in the business unit of ${app}'s application user yet, so it reads only the transcripts shared with it there. Run the installer again in a few minutes.`);
    } else if (grant.result === 'unverified') {
      ui.warn(
        `The ${role} role in ${where} should hold only ConversationTranscript read at Organization depth, but holds ${grant.holds?.join(', ') || 'no privileges'}, ` +
          `so the installer didn't give it to ${app}. It reads only the transcripts shared with it there.`,
      );
      ui.info(
        grant.createdReadRole
          ? 'Run the installer again. If this persists, a System Administrator can delete the role, and the installer creates it again.'
          : 'The installer didn\'t create that role, so it leaves it alone. Rename or delete it, then run the installer again.',
      );
    } else if (grant.result === 'held') {
      ui.warn(`A user or team other than ${app} has the ${role} role in ${where}, so the installer didn't change it or give it to ${app}. It reads only the transcripts shared with it there.`);
      ui.info(
        'Transcript read on the role would reach them too. A System Administrator can see who has it in the Power Platform admin center, under Manage > Environments > the environment > ' +
          'Settings > Users + permissions > Security roles: select the role, then More actions (...) > Members. Remove them from it, or delete the role, then run the installer again.',
      );
    }
    if (grant.sample === 'read') ui.ok(`Checked one transcript in ${where}: ${app} can read it`);
    else if (grant.sample === 'unread') {
      ui.warn(
        `Dataverse shows ${app} can't read a transcript in ${where} yet. Role changes can take a few minutes. ` +
          'If the next run still finds no transcripts there, check its security roles in the Power Platform admin center.',
      );
    }
  }
  const ready = reader.reads ? reader.reads(config) : agentEvaluatorOn(config);
  if (!ready) ui.note(reader.notes?.unread ?? 'The app can\'t read any of the environments yet, so the transcript notebook isn\'t deployed. Run the installer again once it can.');
  return ready;
}

/**
 * How a System Administrator adds the reader by hand, or gives it only the read role.
 * @param {Ctx} ctx
 * @param {AgentEnvironment} env
 * @param {TranscriptReader} reader
 * @param {{ roleOnly?: boolean }} [opts]  roleOnly: it's an application user with Bot Transcript Viewer already.
 */
function manualSteps(ctx, env, reader, opts = {}) {
  const { ui } = ctx;
  ui.info(
    `A System Administrator of ${env.name ?? host(env.url)} can ${opts.roleOnly ? 'give it the role' : 'add it'} in the Power Platform admin center, ` +
      'under Manage > Environments > the environment > Settings > Users + permissions:',
  );
  ui.info(
    `  Security roles > + New role. Name it, for example "${MANUAL_ROLE_NAME}", keep the root business unit, turn off Include App Opener privileges for running Model-Driven apps, and Save. ` +
      'Then set the ConversationTranscript table\'s Read to Organization, and Save.',
  );
  if (opts.roleOnly) {
    ui.info(`  Application users > ${reader.managed ? `the one with client ID ${reader.appId}` : `${reader.name} (${reader.appId})`} > Edit security roles. Tick the new role, and Save.`);
    return;
  }
  if (reader.managed) {
    // The admin center finds a managed identity by its application (client) ID, not its name.
    ui.info(`  Application users > New app user > + Add an app. Search for the managed identity by its client ID, ${reader.appId}${reader.identity ? `, not by its name (${reader.identity})` : ''}.`);
    ui.info(`  Then pick the root business unit, and the ${TRANSCRIPT_ROLE} role and the new role, and Create.`);
    return;
  }
  ui.info(`  Application users > New app user. Pick ${reader.name} (${reader.appId}), the root business unit, and the ${TRANSCRIPT_ROLE} role and the new role.`);
}

/**
 * What a record keeps of the read role after a grant. A grant that didn't reach the role keeps what was recorded. Only
 * the grant says whether the installer created the role, and the assignment is kept while it's the same role.
 * @param {ReadRoleRecord | undefined} prev
 * @param {Omit<TranscriptGrant, 'result'>} [grant]
 * @returns {ReadRoleRecord}
 */
export function readRoleRecord(prev, grant = {}) {
  if (!grant.readRoleId) {
    return {
      ...(prev?.readRoleId ? { readRoleId: prev.readRoleId } : {}),
      ...(prev?.readRoleName ? { readRoleName: prev.readRoleName } : {}),
      ...(prev?.createdReadRole ? { createdReadRole: true } : {}),
      ...(prev?.assignedReadRoleId ? { assignedReadRoleId: prev.assignedReadRoleId } : {}),
    };
  }
  const assigned = grant.assignedReadRoleId ?? (sameId(prev?.readRoleId, grant.readRoleId) ? prev?.assignedReadRoleId : undefined);
  return {
    readRoleId: grant.readRoleId,
    ...(grant.readRoleName ? { readRoleName: grant.readRoleName } : {}),
    ...(grant.createdReadRole ? { createdReadRole: true } : {}),
    ...(assigned ? { assignedReadRoleId: assigned } : {}),
  };
}

/**
 * Takes the read role away from the reader, if the installer gave it, then deletes the role, if the installer created
 * it. A role or assignment it didn't add is left. Never throws: what it can't remove is printed for a System Administrator.
 * @param {Ctx} ctx
 * @param {ReadRoleRecord & { url: string, name?: string, userId?: string }} entry
 * @param {{ who: string, user: string, also?: string[], after?: string }} opts  who: the reader, mid-sentence. user: where
 *   the admin center lists its application user. also: other roles an admin clears with it. after: what an admin does next.
 * @returns {Promise<boolean>}  Whether the reader doesn't have the role now.
 */
export async function removeReadRole(ctx, entry, opts) {
  const { ui, api } = ctx;
  const id = entry.readRoleId;
  if (!id || (!entry.createdReadRole && !entry.assignedReadRoleId)) return true;
  const where = entry.name ?? host(entry.url);
  const role = `"${entry.readRoleName ?? 'transcript reader'}"`;
  const deleteSteps = `Power Platform admin center > Manage > Environments > ${where} > Settings > Users + permissions > Security roles > ${role} > Delete`;
  /** @type {import('../clients/dataverse.js').DataverseApi} */
  let dv;
  try {
    dv = api.dataverse(entry.url);
    if (entry.userId && entry.assignedReadRoleId) {
      await dv.removeRole(entry.userId, entry.assignedReadRoleId).catch((err) => {
        if (!gone(err)) throw err;
      });
    }
  } catch (err) {
    ui.warn(`Couldn't take the ${role} role away from ${opts.who} in ${where} (${message(err)}), so it can still read every transcript there.`);
    ui.info(
      `A System Administrator can: ${opts.user} > Edit security roles, clear ${[role, ...(opts.also ?? [])].join(' and ')}, and Save.${opts.after ?? ''}` +
        `${entry.createdReadRole ? ` Then delete the role: ${deleteSteps}.` : ''}`,
    );
    return false;
  }
  if (!entry.createdReadRole) {
    ui.ok(`Took the ${role} role away from ${opts.who} in ${where}`);
    return true;
  }
  try {
    await dv.deleteRole(id);
    ui.ok(`Deleted the ${role} role in ${where}`);
  } catch (err) {
    if (gone(err)) ui.ok(`The ${role} role in ${where} is already gone`);
    else {
      ui.warn(`Couldn't delete the ${role} role in ${where} (${message(err)}). ${cap(opts.who)} doesn't have it now.`);
      ui.info(`A System Administrator can delete it: ${deleteSteps}.`);
    }
  }
  return true;
}

/**
 * Notes what the installer gave the app in an environment on Fabric, so that unticking the environment or the module, or
 * uninstalling, removes only that. Only the read role is noted: the app user and Bot Transcript Viewer stay, as before.
 * @param {Ctx} ctx @param {AgentEnvironment} env @param {Omit<TranscriptGrant, 'result'>} [grant]
 */
function recordFabric(ctx, env, grant) {
  if (!grant) return;
  const f = ctx.config.fabric;
  const appId = /** @type {string} */ (ctx.config.app.appId);
  const list = f.transcriptAccess ?? [];
  const prev = list.find((t) => sameUrl(t.url, env.url) && sameId(t.appId, appId));
  const name = env.name ?? prev?.name;
  const userId = grant.userId ?? prev?.userId;
  /** @type {FabricTranscriptAccess} */
  const entry = { url: env.url, appId, ...(name ? { name } : {}), ...(userId ? { userId } : {}), ...readRoleRecord(prev, grant) };
  const keep = !!(entry.createdReadRole || entry.assignedReadRoleId);
  if (prev && keep) list[list.indexOf(prev)] = entry;
  else if (prev) list.splice(list.indexOf(prev), 1);
  else if (keep) list.push(entry);
  if (list.length) f.transcriptAccess = list;
  else delete f.transcriptAccess;
}

/**
 * The app still wants its read role in an environment: the module is on and the environment chosen, for this app.
 * @param {InstallConfig} config @param {FabricTranscriptAccess} t
 */
export const fabricReadRoleWanted = (config, t) =>
  !!config.modules.agentEvaluator && sameId(t.appId, config.app.appId) && config.agentEvaluator.environments.some((e) => sameUrl(e.url, t.url));

/**
 * The review's rows for the app's read role on Fabric: one in each chosen environment, and those the installer removes.
 * @param {InstallConfig} config
 * @returns {{ kind: string, name: string, isNew: boolean, detail?: string }[]}
 */
export function fabricReadRoleReview(config) {
  const recorded = config.fabric.transcriptAccess ?? [];
  // Until the workspace is created, the role's name isn't known.
  const role = config.fabric.workspaceId ? appReadRole(config).name : 'Transcript reader role';
  /** The role recorded for an environment, which the installer created or gave. @param {string} url */
  const recordedRole = (url) => recorded.find((t) => sameUrl(t.url, url) && sameId(t.appId, config.app.appId) && t.readRoleId);
  const envs = config.modules.agentEvaluator ? config.agentEvaluator.environments : [];
  return [
    // Not where an admin gave the app a role that reads every transcript: the installer neither adds nor removes that.
    ...envs.filter((e) => !(e.access && e.readAll) || recordedRole(e.url)).map((e) => ({
      kind: 'Dataverse security role',
      name: `${recordedRole(e.url)?.readRoleName ?? role} in ${e.name ?? host(e.url)}`,
      isNew: !(e.access && e.readAll),
      detail: 'Reads every Copilot Studio conversation transcript there, and nothing else. Created for this install, given to the app, and deleted on uninstall.',
    })),
    ...recorded.filter((t) => !fabricReadRoleWanted(config, t)).map((t) => ({
      kind: 'Dataverse security role',
      name: `${t.readRoleName ?? role} in ${t.name ?? host(t.url)}`,
      isNew: false,
      detail: t.createdReadRole
        ? 'No longer chosen, so the installer takes it away and deletes the role it created.'
        : 'No longer chosen, so the installer takes it away. It didn\'t create the role, so it leaves it.',
    })),
  ];
}

/**
 * On Fabric, takes the read role away from the app, and deletes the roles the installer created, in each environment
 * `keep` rejects: by default, all of them. Each is tried once, and what's left is printed for a System Administrator.
 * Never throws.
 * @param {Ctx} ctx
 * @param {(t: FabricTranscriptAccess) => boolean} [keep]
 */
export async function removeFabricReadRoles(ctx, keep = () => false) {
  const { config } = ctx;
  for (const t of (config.fabric.transcriptAccess ?? []).filter((e) => !keep(e))) {
    const where = t.name ?? host(t.url);
    const app = sameId(t.appId, config.app.appId) ? config.app.displayName : undefined;
    await removeReadRole(ctx, t, {
      who: `the app registration${app ? ` ${app}` : ''} (client ID ${t.appId})`,
      user: `${appUsers(where)} > ${app ? `${app} (${t.appId})` : `the one with client ID ${t.appId}`}`,
    });
    for (const env of config.agentEvaluator.environments) if (sameUrl(env.url, t.url)) delete env.readAll;
    const left = (config.fabric.transcriptAccess ?? []).filter((e) => e !== t);
    if (left.length) config.fabric.transcriptAccess = left;
    else delete config.fabric.transcriptAccess;
    ctx.save();
  }
}

/**
 * Creates the Agent Evaluator model, or updates it when the Lakehouse changed or `force` is set,
 * and connects it through the ValueLens model's connection.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureAgentEvaluatorModel(ctx, opts = {}) {
  const { config, sources } = ctx;
  const m = config.agentEvaluator.model;
  const file = sources.agentEvaluatorModelFile;
  if (!file) throw new Error('This checkout has no "Agent Evaluator.pbit" to build the transcripts model from.');
  const { server, database } = await waitForSqlEndpoint(ctx);
  await deployModel(ctx, m, {
    signature: `${server.toLowerCase()};${database}`,
    definition: () => semanticModelDefinition(buildAgentEvaluatorModel(loadTemplateModel(file), { server, database, access: rlsSettings(ctx.config) }), PBISM),
    force: opts.force,
  });
  if (!m.bound && config.semanticModel.connectionId) await bindModel(ctx, m);
}

/**
 * Which environments are read, and which are waiting for an admin.
 * @param {Ctx} ctx
 * @param {TranscriptReader} [reader]  Who reads them. Defaults to the app.
 */
export function agentEvaluatorSummary(ctx, reader = appReader(ctx)) {
  const { ui, config } = ctx;
  const ae = config.agentEvaluator;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  ui.heading('Copilot Studio transcripts');
  if (!ae.environments.length) {
    ui.info(`Environments: ${c.dim('none chosen')}`);
    return;
  }
  const who = reader.managed ? `${reader.name} (client ID ${reader.appId})` : reader.name;
  for (const env of ae.environments) {
    const where = `${env.name ?? host(env.url)} ${c.dim(`(${host(env.url)})`)}`;
    const ready = env.access && env.readAll;
    const waiting = env.access
      ? `waiting for ${who} to be given a role that reads every transcript`
      : `waiting for ${who} to be added with ${TRANSCRIPT_ROLE} and a role that reads every transcript`;
    ui.info(`  ${ready ? c.green('✓') : c.yellow('!')} ${where}${ready ? '' : c.dim(`  ${waiting}`)}`);
  }
  // The Azure summary lists its models itself.
  if (ae.model.id && config.target !== 'azure') ui.info(`Model:      ${ae.model.name}  ${c.dim(modelUrl(ws, ae.model.id))}`);
  if (reader.reads ? reader.reads(config) : agentEvaluatorOn(config)) ui.note(reader.notes?.fill ?? 'The agent pages fill after the pipeline\'s first run reads the transcripts.');
}
