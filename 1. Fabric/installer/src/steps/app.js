// @ts-check
/**
 * Builds the ValueLens web app (`1. Fabric/Fabric App`) against the customer's semantic model and
 * deploys it to their workspace as a Fabric App item, using the app's own Rayfin tooling.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../http.js';
import { agentEvaluatorModelDeployed, consumptionModelDeployed } from './fabric.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/** The model alias the app's ValueLens pages query. */
export const APP_ALIAS = 'vl';
/** The alias the app's credit consumption pages query (`consumptionConnection` in the app). */
export const CONSUMPTION_ALIAS = 'cc';
/** The alias the app's agent evaluation pages query (`evaluatorConnection` in the app). */
export const EVALUATOR_ALIAS = 'ae';
export const RAYFIN_CLI = join('node_modules', '@microsoft', 'rayfin-cli', 'scripts', 'main');
export const DATA_CLI = join('node_modules', '@microsoft', 'fabric-app-data-cli', 'dist', 'cli.js');
export const GENERATED = 'src/fabric.generated.ts';
/** Rayfin's minimum. */
export const MIN_NODE = /** @type {const} */ ([22, 13]);
/** Names the app shipped under before, so a redeploy renames an item that still carries one. */
export const FORMER_APP_NAMES = ['AI in One 2.0'];

/**
 * @typedef {{ cwd: string, inherit?: boolean, shell?: boolean }} RunOptions
 * @typedef {(command: string, args: string[], opts: RunOptions) => Promise<{ code: number, output: string }>} Runner
 */

/** @type {Runner} */
export function defaultRunner(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, shell: !!opts.shell, stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** @param {string} workspaceId */
export const profileName = (workspaceId) => `valuelens-${workspaceId.slice(0, 8).toLowerCase()}`;

/** @param {string} [version] */
export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** @param {string} file */
const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/** @param {string} file */
function readJson(file) {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A top-level `key: value` from a simple YAML file.
 * @param {string | null} text
 * @param {string} key
 */
export function yamlValue(text, key) {
  const m = text ? new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text) : null;
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : undefined;
}

/**
 * The deployment rayfin recorded for a workspace.
 * @param {any} deployments  Parsed `rayfin/.deployments.json`.
 * @param {string} workspaceId
 */
export function findDeployment(deployments, workspaceId) {
  const all = Object.entries(deployments?.deployments ?? {});
  const hit = all.find(([, d]) => String(/** @type {any} */ (d).fabricWorkspaceId).toLowerCase() === workspaceId.toLowerCase());
  return hit ? { key: hit[0], ...(/** @type {any} */ (hit[1])) } : undefined;
}

/**
 * The model aliases the app is built with. Pages for a missing alias stay hidden.
 * @param {import('../config.js').InstallConfig} config
 */
export const appModels = (config) => [
  APP_ALIAS,
  ...(consumptionModelDeployed(config) ? [CONSUMPTION_ALIAS] : []),
  ...(agentEvaluatorModelDeployed(config) ? [EVALUATOR_ALIAS] : []),
];

/** Pages each optional alias adds to the app. */
const ALIAS_PAGES = { [CONSUMPTION_ALIAS]: 'credit consumption', [EVALUATOR_ALIAS]: 'agent evaluation' };

/**
 * Gives the app item the name in `rayfin.yml` when it still has Rayfin's default (the app id) or
 * a name the app shipped under before. A name the customer chose is left alone.
 * @param {Ctx} ctx
 * @param {string} ws
 * @param {string} itemId
 * @param {string} current
 * @returns {Promise<string>} The item's name afterwards.
 */
async function nameApp(ctx, ws, itemId, current) {
  const dir = ctx.sources.appDir;
  const rayfinYml = dir ? readText(join(dir, 'rayfin', 'rayfin.yml')) : null;
  const wanted = yamlValue(rayfinYml, 'name');
  if (!wanted || current === wanted || ![yamlValue(rayfinYml, 'id'), ...FORMER_APP_NAMES].includes(current)) return current;
  try {
    await ctx.api.fabric.renameItem(ws, itemId, wanted);
  } catch (err) {
    ctx.ui.warn(`Couldn't rename the app "${current}" to "${wanted}": ${err instanceof Error ? err.message : err}`);
    return current;
  }
  if (current !== yamlValue(rayfinYml, 'id')) ctx.ui.ok(`Renamed the app "${current}" to "${wanted}"`);
  return wanted;
}

/**
 * Why the app needs rebuilding, e.g. "add the credit consumption pages".
 * @param {string[]} before
 * @param {string[]} after
 */
export function pagesChange(before, after) {
  const added = after.filter((a) => !before.includes(a)).map((a) => ALIAS_PAGES[/** @type {keyof typeof ALIAS_PAGES} */ (a)]).filter(Boolean);
  const removed = before.filter((a) => !after.includes(a)).map((a) => ALIAS_PAGES[/** @type {keyof typeof ALIAS_PAGES} */ (a)]).filter(Boolean);
  const pages = (/** @type {string[]} */ p) => `the ${p.join(' and ')} pages`;
  return [added.length ? `add ${pages(added)}` : '', removed.length ? `remove ${pages(removed)}` : ''].filter(Boolean).join(' and ') || 'match its models';
}

/**
 * Deploys the app unless it is already there with the same models.
 * @param {Ctx} ctx
 */
export async function ensureFabricApp(ctx) {
  const { ui, config, api } = ctx;
  const fa = config.fabricApp;
  if (fa.itemId) {
    const ws = /** @type {string} */ (config.fabric.workspaceId);
    const item = await api.fabric.getItem(ws, fa.itemId).catch((err) => (err instanceof HttpError && err.status === 404 ? null : Promise.reject(err)));
    if (item) {
      const changed = (fa.models ?? [APP_ALIAS]).join(',') !== appModels(config).join(',');
      const question = changed
        ? `The app "${item.displayName}" needs rebuilding to ${pagesChange(fa.models ?? [APP_ALIAS], appModels(config))}. Build and deploy it again?`
        : `The app "${item.displayName}" is deployed. Build and deploy it again?`;
      if (!(await ui.confirm(question, changed))) {
        const name = await keepAppName(ctx, ws, item);
        ui.ok(`App ${name} is in place`);
        return;
      }
    } else {
      ui.warn(`The app ${fa.name ?? fa.itemId} was deleted. Deploying it again.`);
      delete fa.itemId;
    }
  }
  await deployApp(ctx);
}

/**
 * Renames a deployed app that still has an old name, without rebuilding it.
 * @param {Ctx} ctx
 */
export async function ensureAppName(ctx) {
  const { config, api } = ctx;
  const ws = config.fabric.workspaceId;
  if (!config.fabricApp.itemId || !ws) return;
  const item = await api.fabric.getItem(ws, config.fabricApp.itemId).catch(() => null);
  if (item) await keepAppName(ctx, ws, item);
}

/**
 * @param {Ctx} ctx
 * @param {string} ws
 * @param {{ id: string, displayName: string }} item
 * @returns {Promise<string>}
 */
async function keepAppName(ctx, ws, item) {
  const fa = ctx.config.fabricApp;
  const name = await nameApp(ctx, ws, item.id, item.displayName);
  if (name !== fa.name) {
    fa.name = name;
    ctx.save();
  }
  return name;
}

/**
 * Deploys the app. Leaves a developer's checkout pointing where it pointed before when it
 * was already set up for another workspace.
 * @param {Ctx} ctx
 */
export async function deployApp(ctx) {
  const { ui, config, api, sources } = ctx;
  const fa = config.fabricApp;
  const dir = sources.appDir;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const modelId = config.semanticModel.id;
  if (!dir) throw new Error('This checkout has no "1. Fabric/Fabric App" folder to deploy.');
  if (!modelId) throw new Error('The app needs the semantic model. Deploy it first.');
  if (!nodeVersionOk()) throw new Error(`Building the app needs Node.js ${MIN_NODE.join('.')} or later; this is ${process.versions.node}.`);
  const run = ctx.runner ?? defaultRunner;

  if (!existsSync(join(dir, RAYFIN_CLI)) || !existsSync(join(dir, DATA_CLI))) {
    ui.info('Installing the app\'s build tools (npm ci). This takes a few minutes the first time.');
    const res = await run('npm ci --no-audit --no-fund', [], { cwd: dir, shell: true, inherit: true });
    if (res.code) throw new Error(`"npm ci" failed in ${dir}.`);
  }

  /** @param {string[]} args */
  const data = async (...args) => {
    const res = await run(process.execPath, [join(dir, DATA_CLI), ...args], { cwd: dir });
    if (res.code) throw new Error(`fabric-app-data ${args[0]} failed: ${res.output.trim().slice(-800)}`);
  };

  const yamlFile = join(dir, 'fabric.yaml');
  const deploymentsFile = join(dir, 'rayfin', '.deployments.json');
  const envFile = join(dir, 'rayfin', '.env');
  const before = { profile: yamlValue(readText(yamlFile), 'activeProfile'), deployments: readJson(deploymentsFile), env: readText(envFile) };
  const previous = before.deployments?.deployments?.[before.deployments?.active];
  const restore = !!previous && String(previous.fabricWorkspaceId).toLowerCase() !== ws.toLowerCase();

  const profile = profileName(ws);
  const models = appModels(config);
  await data('add', 'semanticModel', APP_ALIAS, '--workspace', ws, '--item', modelId, '--profile', profile);
  for (const [alias, id] of /** @type {const} */ ([
    [CONSUMPTION_ALIAS, config.consumption.model.id],
    [EVALUATOR_ALIAS, config.agentEvaluator.model.id],
  ])) {
    if (models.includes(alias)) {
      await data('add', 'semanticModel', alias, '--workspace', ws, '--item', /** @type {string} */ (id), '--profile', profile);
    } else if (fa.models?.includes(alias)) {
      await data('remove', alias, '--profile', profile).catch(() => {});
    }
  }

  /** @type {any} */
  let record;
  try {
    await data('use', profile, '-o', GENERATED);
    ui.info('Building and deploying the app. Rayfin may open a browser for you to sign in.');
    const res = await run(process.execPath, [join(dir, RAYFIN_CLI), 'up', '--tenant', ctx.user.tenantId, '--workspace-id', ws, '--yes'], { cwd: dir, inherit: true });
    if (res.code) throw new Error('"rayfin up" failed. Its output is above.');
    record = findDeployment(readJson(deploymentsFile), ws);
    if (!record?.fabricItemId) throw new Error('The app deployed, but Rayfin didn\'t record the item it created.');
  } finally {
    if (restore) {
      if (before.profile && before.profile !== profile) await data('use', before.profile, '-o', GENERATED).catch(() => {});
      const now = readJson(deploymentsFile);
      if (now) writeFileSync(deploymentsFile, `${JSON.stringify({ ...now, active: before.deployments.active }, null, 2)}\n`, 'utf8');
      if (before.env !== null) writeFileSync(envFile, before.env, 'utf8');
      ui.note(`Put this checkout back on the "${before.deployments.active}" deployment and the "${before.profile}" profile.`);
    }
  }

  const item = await api.fabric.getItem(ws, record.fabricItemId).catch(() => null);
  const name = item ? await nameApp(ctx, ws, record.fabricItemId, item.displayName) : yamlValue(readText(join(dir, 'rayfin', 'rayfin.yml')), 'name');
  Object.assign(fa, {
    enabled: true,
    itemId: record.fabricItemId,
    name,
    url: record.fabricDeepLink ?? record.hostingUrl,
    profile,
    models,
    deployedAt: record.deployedAt ?? ctx.now().toISOString(),
  });
  ctx.save();
  ui.ok(`Deployed the app "${name}"`);
}
