// @ts-check
/**
 * The Agent Evaluator, from AgentEvaluator-for-Copilot-Studio: the Power Platform environments
 * whose Copilot Studio transcripts the parser notebook reads, the app's access to them, and the
 * Agent Evaluator model, which reads the Lakehouse through the ValueLens model's connection.
 */
import { orgUrl, TRANSCRIPT_ROLE } from '../clients/dataverse.js';
import { semanticModelDefinition } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { buildAgentEvaluatorModel, loadTemplateModel, PBISM } from '../transform/model.js';
import { c } from '../ui.js';
import { agentEvaluatorOn } from './fabric.js';
import { bindModel, deployModel, modelUrl, waitForSqlEndpoint } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').AgentEnvironment} AgentEnvironment */

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
const host = (url) => new URL(url).host;

/**
 * Asks which environments' transcripts to read.
 * @param {Ctx} ctx
 */
export async function planAgentEvaluator(ctx) {
  const { ui, config, api, sources } = ctx;
  const ae = config.agentEvaluator;
  ui.heading('Copilot Studio transcripts');
  if (!config.semanticModel.enabled) {
    ui.note('The transcripts model shares the main semantic model\'s connection, so it is only deployed with it.');
    ui.note('The notebook still loads the transcripts; publish the transcripts report ("Agent Evaluator.pbit") yourself.');
  } else if (!sources.agentEvaluatorModelFile) {
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
    urls = await ui.checkbox('Which environments\' Copilot Studio transcripts should it read?', [
      ...listed.map(({ i, url }) => ({
        name: `${i.FriendlyName ?? i.UniqueName ?? host(url)} (${host(url)})`,
        value: url,
        checked: before.has(url),
        ...(i.IsUserSysAdmin === false ? { description: 'You aren\'t a System Administrator here, so an admin adds the app.' } : {}),
      })),
      ...missing.map((e) => ({ name: `${e.name ?? host(e.url)} (${host(e.url)}, not in your list)`, value: e.url, checked: true })),
    ]);
    const meta = new Map(listed.map(({ i, url }) => [url, i]));
    ae.environments = urls.map((url) => {
      const i = meta.get(url);
      const prev = ae.environments.find((e) => e.url === url);
      return { url, id: i?.EnvironmentId ?? prev?.id, name: i?.FriendlyName ?? prev?.name, ...(prev?.access ? { access: true } : {}) };
    });
    if (!urls.length) ui.warn('No environments chosen, so the transcript notebook isn\'t deployed.');
    return;
  }
  ae.environments = [...new Set(urls)].map((url) => {
    const prev = ae.environments.find((e) => e.url === url);
    return { url, ...(prev?.id ? { id: prev.id } : {}), ...(prev?.name ? { name: prev.name } : {}), ...(prev?.access ? { access: true } : {}) };
  });
  if (!urls.length) ui.warn('No environments chosen, so the transcript notebook isn\'t deployed.');
}

/**
 * Adds the app as an application user with the Bot Transcript Viewer role.
 * @param {import('../clients/dataverse.js').DataverseApi} dv
 * @param {string} appId
 * @returns {Promise<'ok' | 'added' | 'disabled' | 'no-role'>}
 */
export async function grantTranscriptAccess(dv, appId) {
  let user = await dv.findAppUser(appId);
  let added = false;
  if (!user) {
    const bu = await dv.rootBusinessUnit();
    if (!bu) throw new Error('Dataverse returned no root business unit.');
    user = { systemuserid: await dv.createAppUser(appId, bu), _businessunitid_value: bu };
    added = true;
  }
  if (user.isdisabled) return 'disabled';
  const bu = user._businessunitid_value ?? (await dv.rootBusinessUnit());
  const role = bu ? await dv.findRole(TRANSCRIPT_ROLE, bu) : undefined;
  if (!role) return 'no-role';
  const has = (await dv.userRoleIds(user.systemuserid)).some((r) => r.toLowerCase() === role.toLowerCase());
  if (!has) await dv.assignRole(user.systemuserid, role);
  return added || !has ? 'added' : 'ok';
}

/**
 * Gives the app read access to transcripts in each chosen environment, or explains how an admin does.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether the transcript notebook can run.
 */
export async function ensureTranscriptAccess(ctx) {
  const { ui, config, api } = ctx;
  const envs = config.agentEvaluator.environments;
  const app = config.app.displayName ?? 'the app';
  const appId = /** @type {string} */ (config.app.appId);
  if (!envs.length) {
    ui.note('No environments chosen, so the transcript notebook isn\'t deployed.');
    return false;
  }
  for (const env of envs) {
    const where = env.name ?? host(env.url);
    if (env.access) {
      ui.ok(`${app} can read transcripts in ${where}`);
      continue;
    }
    /** @type {Awaited<ReturnType<typeof grantTranscriptAccess>>} */
    let result;
    try {
      result = await grantTranscriptAccess(api.dataverse(env.url), appId);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.status === 401 || err.status === 403) {
        ui.warn(`You can't add ${app} to ${where}, so its transcripts are skipped until someone does.`);
        manualSteps(ctx, env);
        if (!ui.yes) {
          const done = await ui.select('Then:', [
            { name: 'Leave it out for now', value: false, description: 'The notebook picks it up on the first run after the app is added.' },
            { name: 'It already has access', value: true },
          ], false);
          if (done) {
            env.access = true;
            ctx.save();
          }
        }
      } else {
        ui.warn(`Couldn't set up ${app} in ${where} (${err.message}). Its transcripts are skipped for now.`);
      }
      continue;
    }
    if (result === 'disabled') {
      ui.warn(`${app}'s application user in ${where} is disabled, so its transcripts are skipped.`);
      ui.info('Enable it in the Power Platform admin center: the environment > Settings > Users + permissions > Application users.');
      continue;
    }
    if (result === 'no-role') {
      ui.warn(`${where} has no ${TRANSCRIPT_ROLE} role, so Copilot Studio isn't set up there. Its transcripts are skipped.`);
      continue;
    }
    env.access = true;
    ctx.save();
    ui.ok(result === 'added' ? `Gave ${app} the ${TRANSCRIPT_ROLE} role in ${where}` : `${app} can read transcripts in ${where}`);
  }
  const ready = agentEvaluatorOn(config);
  if (!ready) ui.note('The app can\'t read any of the environments yet, so the transcript notebook isn\'t deployed. Run the installer again once it can.');
  return ready;
}

/**
 * @param {Ctx} ctx
 * @param {AgentEnvironment} env
 */
function manualSteps(ctx, env) {
  const { ui, config } = ctx;
  ui.info(`A System Administrator of ${env.name ?? host(env.url)} can add it in the Power Platform admin center:`);
  ui.info('  Manage > Environments > the environment > Settings > Users + permissions > Application users >');
  ui.info(`  New app user. Pick ${config.app.displayName ?? 'the app'} (${config.app.appId}), the root business unit and the ${TRANSCRIPT_ROLE} role.`);
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
    definition: () => semanticModelDefinition(buildAgentEvaluatorModel(loadTemplateModel(file), { server, database }), PBISM),
    force: opts.force,
  });
  if (!m.bound && config.semanticModel.connectionId) await bindModel(ctx, m);
}

/**
 * Which environments are read, and which are waiting for an admin.
 * @param {Ctx} ctx
 */
export function agentEvaluatorSummary(ctx) {
  const { ui, config } = ctx;
  const ae = config.agentEvaluator;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  ui.heading('Copilot Studio transcripts');
  if (!ae.environments.length) {
    ui.info(`Environments: ${c.dim('none chosen')}`);
    return;
  }
  for (const env of ae.environments) {
    const where = `${env.name ?? host(env.url)} ${c.dim(`(${host(env.url)})`)}`;
    ui.info(`  ${env.access ? c.green('✓') : c.yellow('!')} ${where}${env.access ? '' : c.dim(`  waiting for ${config.app.displayName ?? 'the app'} to be added with ${TRANSCRIPT_ROLE}`)}`);
  }
  if (ae.model.id) ui.info(`Model:      ${ae.model.name}  ${c.dim(modelUrl(ws, ae.model.id))}`);
  if (agentEvaluatorOn(config)) ui.note('The agent pages fill after the pipeline\'s first run reads the transcripts.');
}
