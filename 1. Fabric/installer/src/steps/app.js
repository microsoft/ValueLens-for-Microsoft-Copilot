// @ts-check
/**
 * Builds the ValueLens web app (`1. Fabric/Fabric App`) against the customer's semantic model and
 * deploys it to their workspace as a Fabric App item, using the app's own Rayfin tooling. The
 * installer download ships the app already built instead; that copy only needs deploying.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../http.js';
import { agentEvaluatorModelDeployed, consumptionModelDeployed, createdId, displayNames, freeName, noteRenamed } from './fabric.js';

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
/** Marks an app folder the installer download ships already built. It deploys as it is. */
export const PREBUILT_MARKER = 'prebuilt.json';
/** A prebuilt app's static hosting folder, where `rayfin up` also writes `rayfin.config.json`. */
export const PREBUILT_STATIC = 'public';
/** The file a prebuilt app reads its semantic models from. */
export const FABRIC_CONFIG = 'fabric.config.json';

/** @param {string} dir */
export const isPrebuilt = (dir) => existsSync(join(dir, PREBUILT_MARKER));

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
 * The deployment rayfin recorded for a workspace: the active one when it is there, as rayfin
 * just wrote it.
 * @param {any} deployments  Parsed `rayfin/.deployments.json`.
 * @param {string} workspaceId
 */
export function findDeployment(deployments, workspaceId) {
  const all = Object.entries(deployments?.deployments ?? {});
  const inWorkspace = (/** @type {any} */ d) => String(d?.fabricWorkspaceId).toLowerCase() === workspaceId.toLowerCase();
  const hit = all.find(([key, d]) => key === deployments?.active && inWorkspace(d)) ?? all.find(([, d]) => inWorkspace(d));
  return hit ? { key: hit[0], ...(/** @type {any} */ (hit[1])) } : undefined;
}

/**
 * Rayfin's registry key for a workspace name (its `sanitizeWorkspaceName`).
 * @param {string} name
 */
export const deploymentKey = (name) =>
  name
    .slice(0, 200)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The app's project id (rayfin's default item name) and display name, from `rayfin.yml`.
 * @param {string | undefined} dir
 */
export function appIdentity(dir) {
  const rayfinYml = dir ? readText(join(dir, 'rayfin', 'rayfin.yml')) : null;
  return { id: yamlValue(rayfinYml, 'id') ?? 'valuelens', name: yamlValue(rayfinYml, 'name') ?? 'Analytics Hub' };
}

/**
 * An app in the workspace that rayfin would take over: one named like the project or the app.
 * @param {any[]} apps  AppBackend items.
 * @param {{ id: string, name: string }} identity
 */
export const clashingApp = (apps, identity) =>
  apps.find((a) => [identity.id, identity.name].some((n) => n.toLowerCase() === String(a.displayName).toLowerCase()));

/**
 * Points rayfin at this install's app item before `rayfin up`. Rayfin reuses any app item named
 * like the project, so when nothing is recorded this creates the install's own item under a free
 * name and records it first. A deploy that fails part way then still leaves it recorded.
 * @param {Ctx} ctx
 * @param {string} dir
 * @param {string} ws
 */
async function claimAppItem(ctx, dir, ws) {
  const { ui, config, api } = ctx;
  const fa = config.fabricApp;
  const file = join(dir, 'rayfin', '.deployments.json');
  const registry = readJson(file) ?? {};
  registry.deployments ??= {};
  const save = () => {
    mkdirSync(join(dir, 'rayfin'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  };
  /** @param {string} id */
  const exists = (id) => api.fabric.getItem(ws, id).then(
    () => true,
    (err) => (err instanceof HttpError && err.status === 404 ? false : Promise.reject(err)),
  );
  /** @param {string} id */
  const record = (id) => {
    const key = deploymentKey(config.fabric.workspaceName ?? '') || ws;
    registry.deployments[key] = { fabricItemId: id, fabricWorkspaceId: ws, fabricTenantId: ctx.user.tenantId };
    registry.active = key;
    save();
  };

  const recorded = findDeployment(registry, ws);
  if (fa.itemId && (await exists(fa.itemId))) {
    if (recorded?.fabricItemId !== fa.itemId) record(fa.itemId);
    return;
  }
  if (recorded?.fabricItemId) {
    if (await exists(recorded.fabricItemId)) return;
    delete registry.deployments[recorded.key];
    if (registry.active === recorded.key) delete registry.active;
    save();
  }

  const identity = appIdentity(dir);
  const apps = await api.fabric.listItems(ws, 'AppBackend');
  const name = freeName(identity.name, displayNames(apps));
  const created = await api.fabric.createItem(ws, 'AppBackend', name);
  record(await createdId(ctx, created, 'AppBackend', name));
  const clash = clashingApp(apps, identity);
  if (clash) noteRenamed(ctx, clash.displayName, name);
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
      // A prebuilt app reads its models when it loads, so it only needs deploying.
      const prebuilt = !!ctx.sources.appDir && isPrebuilt(ctx.sources.appDir);
      const again = prebuilt ? 'Deploy it again?' : 'Build and deploy it again?';
      const question = changed
        ? `The app "${item.displayName}" needs ${prebuilt ? 'redeploying' : 'rebuilding'} to ${pagesChange(fa.models ?? [APP_ALIAS], appModels(config))}. ${again}`
        : `The app "${item.displayName}" is deployed. ${again}`;
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

  const models = appModels(config);
  const { record, profile } = isPrebuilt(dir) ? await deployPrebuilt(ctx, dir, ws, models) : await buildAndDeploy(ctx, dir, ws, models);

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

/**
 * Builds the app from source with the customer's models and deploys it.
 * @param {Ctx} ctx
 * @param {string} dir
 * @param {string} ws
 * @param {string[]} models
 */
async function buildAndDeploy(ctx, dir, ws, models) {
  const { ui, config } = ctx;
  const fa = config.fabricApp;
  const modelId = /** @type {string} */ (config.semanticModel.id);
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

  try {
    await data('use', profile, '-o', GENERATED);
    ui.info('Building and deploying the app. Rayfin may open a browser for you to sign in.');
    return { record: await rayfinUp(ctx, dir, ws), profile };
  } finally {
    if (restore) {
      if (before.profile && before.profile !== profile) await data('use', before.profile, '-o', GENERATED).catch(() => {});
      const now = readJson(deploymentsFile);
      if (now) writeFileSync(deploymentsFile, `${JSON.stringify({ ...now, active: before.deployments.active }, null, 2)}\n`, 'utf8');
      if (before.env !== null) writeFileSync(envFile, before.env, 'utf8');
      ui.note(`Put this checkout back on the "${before.deployments.active}" deployment and the "${before.profile}" profile.`);
    }
  }
}

/**
 * Deploys the app the installer download ships already built. It reads its models from a
 * `fabric.config.json` deployed next to it. Each installer version unpacks a fresh copy, so
 * what Rayfin records about the deployment lives in the install record between runs: without
 * it, Rayfin would create a second app rather than update the first.
 * @param {Ctx} ctx
 * @param {string} dir
 * @param {string} ws
 * @param {string[]} models
 */
async function deployPrebuilt(ctx, dir, ws, models) {
  const { ui, config } = ctx;
  const fa = config.fabricApp;
  if (!existsSync(join(dir, RAYFIN_CLI))) throw new Error(`The app in ${dir} is missing its deploy tools. Download the installer again.`);

  writeFileSync(join(dir, PREBUILT_STATIC, FABRIC_CONFIG), `${JSON.stringify(fabricConfigFile(config, ws, models), null, 2)}\n`, 'utf8');
  const deploymentsFile = join(dir, 'rayfin', '.deployments.json');
  const envFile = join(dir, 'rayfin', '.env');
  writeOrRemove(deploymentsFile, fa.rayfin?.deployments ? `${JSON.stringify(fa.rayfin.deployments, null, 2)}\n` : null);
  writeOrRemove(envFile, fa.rayfin?.env ?? null);

  ui.info('Deploying the app. Rayfin may open a browser for you to sign in.');
  try {
    return { record: await rayfinUp(ctx, dir, ws), profile: undefined };
  } finally {
    // Kept even when the deploy fails part way, so the next run updates any item it created.
    const deployments = readJson(deploymentsFile);
    if (deployments) {
      const env = readText(envFile);
      fa.rayfin = { deployments, ...(env ? { env } : {}) };
      ctx.save();
    }
  }
}

/**
 * The `fabric.config.json` a prebuilt app reads its semantic models from.
 * @param {import('../config.js').InstallConfig} config
 * @param {string} ws
 * @param {string[]} models
 */
export function fabricConfigFile(config, ws, models) {
  /** @type {Record<string, string | undefined>} */
  const ids = {
    [APP_ALIAS]: config.semanticModel.id,
    [CONSUMPTION_ALIAS]: config.consumption.model.id,
    [EVALUATOR_ALIAS]: config.agentEvaluator.model.id,
  };
  /** @type {{ semanticModels: Record<string, { workspaceId: string, itemId: string | undefined }>, modules?: Record<string, boolean> }} */
  const body = { semanticModels: Object.fromEntries(models.map((alias) => [alias, { workspaceId: ws, itemId: ids[alias] }])) };
  if (config.modules) {
    body.modules = Object.fromEntries(
      ['m365Activity', 'agent365', 'productFeedback', 'consumption', 'agentEvaluator', 'defender'].map((id) => [id, Boolean(config.modules[id])]),
    );
  }
  return body;
}

/**
 * Runs `rayfin up` in the app folder and returns the deployment it recorded for the workspace.
 * @param {Ctx} ctx
 * @param {string} dir
 * @param {string} ws
 */
async function rayfinUp(ctx, dir, ws) {
  const run = ctx.runner ?? defaultRunner;
  await claimAppItem(ctx, dir, ws);
  const res = await run(process.execPath, [join(dir, RAYFIN_CLI), 'up', '--tenant', ctx.user.tenantId, '--workspace-id', ws, '--yes'], { cwd: dir, inherit: true });
  if (res.code) throw new Error('"rayfin up" failed. Its output is above.');
  const record = findDeployment(readJson(join(dir, 'rayfin', '.deployments.json')), ws);
  if (!record?.fabricItemId) throw new Error('The app deployed, but Rayfin didn\'t record the item it created.');
  return record;
}

/**
 * @param {string} file
 * @param {string | null} text  `null` removes the file.
 */
function writeOrRemove(file, text) {
  if (text !== null) writeFileSync(file, text, 'utf8');
  else rmSync(file, { force: true });
}
