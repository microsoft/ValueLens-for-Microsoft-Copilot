// @ts-check
/**
 * Wires the clients together and runs each command.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCredential, createTokenProvider, decodeJwt } from './auth.js';
import { notebooksFor, permissionsFor } from './catalog.js';
import { armApi, keyVaultApi } from './clients/azure.js';
import { dataverseApi, dataverseScope, DISCOVERY_URL, discoveryApi, orgUrl } from './clients/dataverse.js';
import { fabricApi, scheduleBody } from './clients/fabric.js';
import { CONSENT_ROLES, graphApi } from './clients/graph.js';
import { ONELAKE_URL, oneLakeApi } from './clients/onelake.js';
import { powerBiApi } from './clients/powerbi.js';
import { POWER_PLATFORM_URL, powerPlatformApi } from './clients/powerplatform.js';
import { saveConfig } from './config.js';
import { createClient, defaultSleep } from './http.js';
import { commandLine } from './launch.js';
import { ensureConsent, ensureApp, ensureKeyVault, newSecret } from './steps/identity.js';
import { agentEvaluatorModelWanted, agentEvaluatorSummary, ensureAgentEvaluatorModel, ensureTranscriptAccess } from './steps/agent-evaluator.js';
import { deployApp, ensureAppName, ensureFabricApp } from './steps/app.js';
import { COWORK_DATAFLOW_NAME, consumptionModelWanted, consumptionSummary, ensureAzureAiAccess, ensureConsumptionModel, ensureCoworkDataflow, ensureLandingFolders } from './steps/consumption.js';
import { coworkDataflowDefinition, isVivaId } from './transform/dataflow.js';
import {
  agentEvaluatorModelDeployed,
  consumptionModelDeployed,
  describeSchedule,
  ensureLakehouse,
  ensureNotebooks,
  ensurePipeline,
  ensureSparkSettings,
  ensureSchedule,
  ensureVaultEndpoint,
  ensureWorkspace,
  modelDeployed,
  notebookSettings,
  PIPELINE_NAME,
} from './steps/fabric.js';
import { ensureModelConnection, ensureSemanticModel, modelUrl, refreshModel, rotateModelSecret } from './steps/model.js';
import { confirmPlan, plan, preflight } from './steps/plan.js';
import { dataSourcesSummary, ensureUploads, uploadCommand } from './steps/data-sources.js';
import { ensureFlows, FLOW_FILES, flowDefinitions, flowsSummary, flowsWanted } from './steps/flows.js';
import { routerWanted } from './uploads.js';
import { checkData, chooseLoad, runDataCheck, runPipeline, status } from './steps/run.js';
import { rerunFailed } from './steps/rerun.js';
import { prepareNotebook, serialiseNotebook } from './transform/notebook.js';
import { buildAgentEvaluatorModel, buildConsumptionModel, buildModel, loadTemplateModel } from './transform/model.js';
import { buildPipeline } from './transform/pipeline.js';
import { c } from './ui.js';

/**
 * @typedef {object} Apis
 * @property {import('./clients/fabric.js').FabricApi} fabric
 * @property {import('./clients/graph.js').GraphApi} graph
 * @property {import('./clients/azure.js').ArmApi} arm
 * @property {import('./clients/azure.js').KeyVaultApi} keyVault
 * @property {import('./clients/onelake.js').OneLakeApi} oneLake
 * @property {import('./clients/powerbi.js').PowerBiApi} powerBi
 * @property {import('./clients/dataverse.js').DiscoveryApi} discovery
 * @property {import('./clients/powerplatform.js').PowerPlatformApi} powerPlatform
 * @property {(url: string) => import('./clients/dataverse.js').DataverseApi} dataverse  A Dataverse environment, by org URL.
 *
 * @typedef {{ id: string, upn: string, tenantId: string, displayName?: string }} User
 *
 * @typedef {object} Ctx
 * @property {import('./ui.js').Ui} ui
 * @property {import('./config.js').InstallConfig} config
 * @property {() => void} save  Writes the install record.
 * @property {Apis} api
 * @property {User} user
 * @property {import('./sources.js').Sources} sources
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => Date} now
 * @property {string} [pendingSecret]  A secret the user pasted, held in memory until it is in Key Vault.
 * @property {boolean} [runFirstLoad]
 * @property {{ sp: any, roles: { id: string, value: string }[] }} [graphRoles]
 * @property {import('./steps/app.js').Runner} [runner]  Runs the app's build tools; tests replace it.
 * @property {import('./staging.js').PendingUpload[]} [pendingUploads]  Exports to upload to the drop folder during the install.
 * @property {string[]} [csvFiles]  Exports named with --csv.
 * @property {string} [configFile]  The install record's path.
 */

/**
 * Signs in once and builds a client for each API.
 * @param {{ tenantId?: string, method?: 'browser' | 'device-code' | 'azure-cli', ui: import('./ui.js').Ui, debug?: (m: string) => void }} opts
 * @returns {Promise<{ api: Apis, user: User }>}
 */
export async function connect(opts) {
  const credential = createCredential({ tenantId: opts.tenantId, method: opts.method, print: (m) => opts.ui.line(m) });
  const getToken = createTokenProvider(credential);
  /**
   * @param {string} baseUrl
   * @param {import('./auth.js').Resource} resource
   */
  const client = (baseUrl, resource) => createClient({ baseUrl, getToken: () => getToken(resource), debug: opts.debug });
  /** @type {Apis} */
  const api = {
    fabric: fabricApi(client('https://api.fabric.microsoft.com/v1', 'fabric')),
    graph: graphApi(client('https://graph.microsoft.com/v1.0', 'graph')),
    arm: armApi(client('https://management.azure.com', 'arm')),
    keyVault: keyVaultApi(client('https://vault.azure.net', 'keyVault')),
    oneLake: oneLakeApi(client(ONELAKE_URL, 'storage')),
    powerBi: powerBiApi(client('https://api.powerbi.com/v1.0/myorg', 'powerbi')),
    discovery: discoveryApi(client(DISCOVERY_URL, 'discovery')),
    powerPlatform: powerPlatformApi(client(POWER_PLATFORM_URL, 'powerPlatform')),
    dataverse: (url) => dataverseApi(client(`${orgUrl(url)}/api/data/v9.2`, dataverseScope(url)), url),
  };
  const claims = decodeJwt(await getToken('graph'));
  const me = await api.graph.me();
  return { api, user: { id: me.id, upn: me.userPrincipalName, displayName: me.displayName, tenantId: claims.tid } };
}

/**
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, file: string, api: Apis, user: User, sources: import('./sources.js').Sources, sleep?: (ms: number) => Promise<void>, now?: () => Date }} o
 * @returns {Ctx}
 */
export function createCtx(o) {
  if (o.config.tenantId && o.user.tenantId && o.config.tenantId !== o.user.tenantId) {
    throw new Error(`The install record is for tenant ${o.config.tenantId}, but you signed in to ${o.user.tenantId}. Use --tenant ${o.config.tenantId}.`);
  }
  o.config.tenantId = o.user.tenantId;
  return {
    ui: o.ui,
    config: o.config,
    save: () => saveConfig(o.file, o.config),
    api: o.api,
    user: o.user,
    sources: o.sources,
    sleep: o.sleep ?? defaultSleep,
    now: o.now ?? (() => new Date()),
    configFile: o.file,
  };
}

/** @param {Ctx} ctx */
async function canConsent(ctx) {
  const roles = await ctx.api.graph.myDirectoryRoles().catch(() => []);
  return roles.some((r) => r.roleTemplateId in CONSENT_ROLES);
}

/**
 * The same clients, except that a call made again with the same arguments gets the first call's
 * answer. Going back runs the plan's questions again from the start: this keeps that quick, and
 * keeps the lists the same as the first time. A call that fails isn't kept.
 * @param {Apis} api
 * @returns {Apis}
 */
export function memoApi(api) {
  /** @type {Map<string, Promise<unknown>>} */
  const seen = new Map();
  const copy = (/** @type {unknown} */ v) => {
    try {
      return structuredClone(v);
    } catch {
      return v;
    }
  };
  /** @param {string} client @param {string} name @param {unknown[]} args */
  const keyOf = (client, name, args) => {
    if (args.some((a) => typeof a === 'function')) return undefined;
    try {
      return `${client}.${name}(${JSON.stringify(args)})`;
    } catch {
      return undefined;
    }
  };
  /** @param {string} client @param {object} target */
  const wrap = (client, target) =>
    new Proxy(target, {
      get(t, name, receiver) {
        const fn = Reflect.get(t, name, receiver);
        if (typeof fn !== 'function' || typeof name !== 'string') return fn;
        return (/** @type {unknown[]} */ ...args) => {
          const key = keyOf(client, name, args);
          if (key === undefined) return fn.apply(t, args);
          let p = seen.get(key);
          if (!p) {
            const result = fn.apply(t, args);
            if (!result || typeof result.then !== 'function') return result;
            const mine = Promise.resolve(result);
            seen.set(key, mine);
            mine.catch(() => {
              if (seen.get(key) === mine) seen.delete(key);
            });
            p = mine;
          }
          return p.then(copy);
        };
      },
    });
  return /** @type {Apis} */ (Object.fromEntries(Object.entries(api).map(([client, v]) => [client, v && typeof v === 'object' ? wrap(client, v) : v])));
}

/**
 * Runs the questions in `fn`, and runs them again from the start each time the user goes back.
 * The web UI gives the earlier answers again by itself, so it stops at the question before the
 * one the user was on. The config and the answers kept on `ctx` are put back first, and the API
 * calls are reused. The terminal can't go back, so there `fn` just runs.
 * @template T
 * @param {Ctx} ctx
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function rewindable(ctx, fn) {
  const ui = /** @type {{ begin?: () => void, end?: () => void }} */ (/** @type {unknown} */ (ctx.ui));
  if (!ui.begin || !ui.end) return fn();
  // save() writes this object, so it's put back in place rather than replaced.
  const config = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (ctx.config));
  const snapshot = structuredClone(config);
  const { pendingSecret, runFirstLoad, pendingUploads } = ctx;
  const real = ctx.api;
  ctx.api = memoApi(real);
  ui.begin();
  try {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (/** @type {Error | undefined} */ (err)?.name !== 'GoBack') throw err;
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, structuredClone(snapshot));
        ctx.pendingSecret = pendingSecret;
        ctx.runFirstLoad = runFirstLoad;
        ctx.pendingUploads = pendingUploads;
      }
    }
  } finally {
    ctx.api = real;
    ui.end();
  }
}

/**
 * Full set-up, or a repair when the install record already has IDs.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
export async function install(ctx, opts) {
  const { ui, config } = ctx;
  const pre = await preflight(ctx);
  const go = await rewindable(ctx, async () => {
    await plan(ctx, pre);
    ctx.save();
    return confirmPlan(ctx, pre);
  });
  if (!go) {
    ui.warn('Stopped before changing anything. Your answers are saved for next time.');
    return;
  }

  const sm = config.semanticModel;
  const withModel = !!sm.enabled;
  const withApp = withModel && !!config.fabricApp.enabled;
  const withConsumption = !!config.modules.consumption;
  const withAgentEvaluator = !!config.modules.agentEvaluator;
  const withUploads = routerWanted(config.dataSources) || !!ctx.pendingUploads?.length || flowsWanted(config).length > 0;
  const titles = [
    'Key Vault',
    'App registration',
    'Microsoft Graph permissions',
    'Workspace and Lakehouse',
    ...(withModel ? ['Semantic model'] : []),
    ...(withConsumption ? ['Credit consumption'] : []),
    ...(withAgentEvaluator ? ['Copilot Studio transcripts'] : []),
    ...(withUploads ? ['Data uploads'] : []),
    'Notebooks, pipeline and schedule',
    ...(withApp ? ['Analytics Hub app'] : []),
    ...(ctx.runFirstLoad ? ['First load'] : withModel ? ['Model refresh'] : []),
  ];
  let n = 0;
  const step = (/** @type {string} */ title) => ui.step(++n, titles.length, title);

  step('Key Vault');
  await ensureKeyVault(ctx);
  step('App registration');
  await ensureApp(ctx);
  step('Microsoft Graph permissions');
  const consented = await ensureConsent(ctx, pre);
  step('Workspace and Lakehouse');
  await ensureWorkspace(ctx);
  await ensureLakehouse(ctx);
  const vaultReachable = await ensureVaultEndpoint(ctx);
  if (withModel) {
    step('Semantic model');
    await ensureSemanticModel(ctx);
    await ensureModelConnection(ctx);
  }
  if (withConsumption) {
    step('Credit consumption');
    await consumptionSteps(ctx);
  }
  if (withAgentEvaluator) {
    step('Copilot Studio transcripts');
    await agentEvaluatorSteps(ctx);
  }
  if (withUploads) {
    step('Data uploads');
    await ensureUploads(ctx);
    await ensureFlows(ctx);
  }
  step('Notebooks, pipeline and schedule');
  await ensureNotebooks(ctx);
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx);
  await ensureSchedule(ctx);
  if (withApp) {
    step('Analytics Hub app');
    await tryDeployApp(ctx);
  }

  if (ctx.runFirstLoad) {
    step('First load');
    if (!consented) {
      ui.warn(`Skipped until admin consent is granted. Then run: ${commandLine(`run --backfill-days ${config.history.days}`)}`);
    } else if (!vaultReachable) {
      ui.warn(`Skipped until the private endpoint to ${config.keyVault.name} is approved. Then run: ${commandLine(`run --backfill-days ${config.history.days}`)}`);
    } else {
      if (modelDeployed(config)) ui.note(`The pipeline refreshes ${joinNames(deployedModels(config).map((m) => m.name))} as its last step.`);
      const result = await runPipeline(ctx, { backfillDays: config.history.days, wait: opts.wait, first: true });
      if (result.status === 'Completed') await runDataCheck(ctx);
    }
  } else if (withModel) {
    step('Model refresh');
    await refreshModels(ctx, { wait: opts.wait });
  }
  await summary(ctx);
}

/**
 * Azure AI access, the upload folders and the Consumption model.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
async function consumptionSteps(ctx, opts = {}) {
  await ensureAzureAiAccess(ctx);
  await ensureLandingFolders(ctx);
  await ensureCoworkDataflow(ctx);
  if (consumptionModelWanted(ctx)) await ensureConsumptionModel(ctx, opts);
}

/**
 * Access to the chosen environments' transcripts, and the Agent Evaluator model.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
async function agentEvaluatorSteps(ctx, opts = {}) {
  await ensureTranscriptAccess(ctx);
  if (agentEvaluatorModelWanted(ctx)) await ensureAgentEvaluatorModel(ctx, opts);
}

/**
 * The deployed models that read the Lakehouse, ValueLens's first.
 * @param {import('./config.js').InstallConfig} config
 * @returns {{ name: string, id?: string }[]}
 */
function deployedModels(config) {
  if (!modelDeployed(config)) return [];
  return [
    config.semanticModel,
    ...(consumptionModelDeployed(config) ? [config.consumption.model] : []),
    ...(agentEvaluatorModelDeployed(config) ? [config.agentEvaluator.model] : []),
  ];
}

/** @param {string[]} names */
const joinNames = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Refreshes the ValueLens model and the other deployed models that share its connection.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} opts
 */
async function refreshModels(ctx, opts) {
  const { ui, config } = ctx;
  /** @type {{ ok: boolean, status?: string }} */
  let result = { ok: false };
  if (modelDeployed(config)) result = await refreshModel(ctx, opts);
  else ui.warn(`Skipped: ${config.semanticModel.name} isn't connected to the Lakehouse yet.`);
  for (const model of deployedModels(config).slice(1)) {
    const other = await refreshModel(ctx, { ...opts, model: /** @type {import('./config.js').ModelConfig} */ (model) });
    result = { ...result, ok: result.ok && other.ok };
  }
  return result;
}

/**
 * The app is the last thing before the data load, so a failure here shouldn't stop that.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
async function tryDeployApp(ctx, opts = {}) {
  try {
    await (opts.force ? deployApp(ctx) : ensureFabricApp(ctx));
  } catch (err) {
    ctx.ui.fail(`The app wasn't deployed: ${/** @type {Error} */ (err).message}`);
    ctx.ui.info(`Fix the problem, then run "${commandLine('deploy-app')}".`);
  }
}

/**
 * Pushes the notebooks and pipeline from this checkout over the deployed ones.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} [opts]
 */
export async function update(ctx, opts = {}) {
  const { ui, config } = ctx;
  if (!config.fabric.workspaceId || !config.fabric.lakehouseId) throw new Error('Nothing is installed yet. Run the installer first.');
  const sm = config.semanticModel;
  ui.heading('Updating Analytics Hub');
  ui.note(`From ${ctx.sources.dir}`);
  await ensureKeyVault(ctx);
  await ensureApp(ctx);
  await ensureConsent(ctx, { canConsent: await canConsent(ctx) });
  await ensureWorkspace(ctx);
  await ensureLakehouse(ctx);
  await ensureVaultEndpoint(ctx);
  if (sm.enabled) {
    await ensureSemanticModel(ctx, { force: true });
    await ensureModelConnection(ctx);
  }
  if (config.modules.consumption) await consumptionSteps(ctx, { force: true });
  if (config.modules.agentEvaluator) await agentEvaluatorSteps(ctx, { force: true });
  if (routerWanted(config.dataSources)) await ensureUploads(ctx);
  await ensureFlows(ctx);
  await ensureNotebooks(ctx, { force: true });
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx, { force: true });
  await ensureSchedule(ctx);
  if (sm.enabled && config.fabricApp.enabled) {
    if (await ui.confirm('Rebuild and redeploy the Analytics Hub app too?', true)) await tryDeployApp(ctx, { force: true });
    else await ensureAppName(ctx);
  }
  if (modelDeployed(config)) {
    ui.note('Updating a model clears its data, so it refreshes now.');
    await refreshModels(ctx, { wait: opts.wait ?? true });
  }
  ui.ok('Up to date. The next scheduled run uses the new versions.');
}

/**
 * Starts the pipeline: the first load until one has loaded the history, then the usual run.
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number, wait: boolean }} opts
 */
export async function run(ctx, opts) {
  const result = await runPipeline(ctx, await chooseLoad(ctx, opts));
  if (result.status === 'Completed') await runDataCheck(ctx);
  return result;
}

export { status };

/**
 * Refreshes the semantic models now.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
export async function refresh(ctx, opts) {
  if (!ctx.config.semanticModel.id) throw new Error('There is no semantic model yet. Run the installer and choose to deploy it.');
  if (deployedModels(ctx.config).length < 2) return refreshModel(ctx, opts);
  return refreshModels(ctx, opts);
}

/**
 * Runs one command against a signed-in context.
 * @param {Ctx} ctx
 * @param {string} command
 * @param {{ wait: boolean, backfillDays?: number, files?: string[], run?: boolean }} opts
 * @returns {Promise<boolean>} false when a run or refresh it waited for didn't succeed.
 */
export async function runCommand(ctx, command, opts) {
  switch (command) {
    case 'install':
      await install(ctx, opts);
      return true;
    case 'update':
      await update(ctx, opts);
      return true;
    case 'run': {
      const result = await run(ctx, opts);
      return !opts.wait || !!result.ok;
    }
    case 'rerun-failed':
      return !(await rerunFailed(ctx)).failed.length;
    case 'check':
      return !!(await checkData(ctx));
    case 'refresh': {
      const result = await refresh(ctx, opts);
      return !opts.wait || result.ok;
    }
    case 'deploy-app':
      await deployAppNow(ctx);
      return true;
    case 'status':
      await status(ctx);
      return true;
    case 'rotate-secret':
      await rotateSecret(ctx);
      return true;
    case 'upload':
      return uploadCommand(ctx, { files: opts.files ?? [], run: opts.run, wait: opts.wait }, (c2, o) => run(c2, o));
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}

/**
 * Builds and deploys the Analytics Hub app on its own.
 * @param {Ctx} ctx
 */
export async function deployAppNow(ctx) {
  const { config, ui } = ctx;
  if (!modelDeployed(config)) throw new Error('The app needs the semantic model. Run the installer and choose "Semantic model and the Analytics Hub app".');
  ui.heading('Deploying the Analytics Hub app');
  await deployApp(ctx);
  if (config.fabricApp.url) ui.info(config.fabricApp.url);
}

/** @param {Ctx} ctx */
export async function rotateSecret(ctx) {
  const { ui, config } = ctx;
  if (!config.app.appId || !config.keyVault.uri) throw new Error('Nothing is installed yet. Run the installer first.');
  const sm = config.semanticModel;
  ui.heading('New client secret');
  ui.info(`App: ${config.app.displayName ?? config.app.appId}`);
  ui.info(`Key Vault: ${config.keyVault.name}, secret ${config.keyVault.secretName}`);
  if (sm.connectionId) ui.info(`Connection: ${sm.connectionName}, used by ${sm.name}`);
  ui.note('The notebooks\' old secret keeps working until it expires. Delete it from the app\'s Certificates & secrets page once a run has succeeded.');
  if (!(await ui.confirm(`Create new secrets and replace the one in Key Vault${sm.connectionId ? ' and the connection\'s' : ''}?`, true))) return;
  await newSecret(ctx);
  if (sm.connectionId) await rotateModelSecret(ctx);
}

/**
 * Prints where everything is and what to do next.
 * @param {Ctx} ctx
 */
export async function summary(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const lhId = /** @type {string} */ (f.lakehouseId);
  const lakehouse = await api.fabric.getLakehouse(ws, lhId).catch(() => null);
  const sql = lakehouse?.properties?.sqlEndpointProperties;

  ui.heading('Analytics Hub is set up');
  ui.info(`Workspace:  ${f.workspaceName}  ${c.dim(`https://app.fabric.microsoft.com/groups/${ws}`)}`);
  ui.info(`Lakehouse:  ${f.lakehouseName}`);
  ui.info(`Pipeline:   ${f.pipelineName ?? PIPELINE_NAME}, ${describeSchedule(config.schedule)}`);
  ui.info(`Secret:     ${config.keyVault.name} / ${config.keyVault.secretName}${config.app.secretExpires ? `, expires ${config.app.secretExpires.slice(0, 10)}` : ''}`);
  if (config.keyVault.private) ui.info(`            ${c.dim('Private vault, reached through a managed private endpoint. Spark sessions take a few minutes longer to start.')}`);

  const sm = config.semanticModel;
  const fa = config.fabricApp;
  if (sm.enabled && sm.id) {
    ui.info(`Model:      ${sm.name}  ${c.dim(modelUrl(ws, sm.id))}`);
    if (sm.connectionName) ui.info(`            ${c.dim(`Reads the Lakehouse through "${sm.connectionName}"${sm.secretExpires ? `, whose secret expires ${sm.secretExpires.slice(0, 10)}` : ''}.`)}`);
    if (fa.enabled && fa.itemId) ui.info(`App:        ${fa.name}  ${c.dim(fa.url ?? '')}`);

    ui.heading('Next steps');
    ui.info('1. Share the app: open it in the workspace, choose Share, and add people or a group.');
    ui.info(`   They also need Build on ${sm.name} (its Manage permissions page), or Viewer on the workspace.`);
    ui.info('2. Scheduled runs read the Key Vault secret as you, the schedule\'s owner, and refresh the model');
    ui.info('   as you. Anyone who takes over the pipeline needs "get" on the secret and Contributor on the workspace.');
    ui.info(`3. Keep ${c.bold('valuelens-install.json')}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
    if (config.modules.consumption) consumptionSummary(ctx);
    if (config.modules.agentEvaluator) agentEvaluatorSummary(ctx);
    dataSourcesSummary(ctx);
    flowsSummary(ctx);
    return;
  }

  ui.heading('Connect Power BI');
  ui.info(c.bold('ValueLens - Fabric.pbit'));
  ui.info(`  Fabric SQL Endpoint:  ${sql?.connectionString ?? c.dim('still provisioning; copy it from the Lakehouse\'s SQL analytics endpoint settings')}`);
  ui.info(`  Lakehouse Name:       ${f.lakehouseName}`);
  ui.info(c.bold('ValueLens - Fabric OneLake.pbit'));
  ui.info(`  Fabric Workspace ID:  ${ws.toLowerCase()}`);
  ui.info(`  Lakehouse ID:         ${lhId.toLowerCase()}`);

  ui.heading('Next steps');
  ui.info('1. Open a template in Power BI Desktop with the values above, then publish it to this workspace.');
  ui.info('2. Add a semantic model refresh to the end of the pipeline so the report updates after each load,');
  ui.info('   or re-run the installer and let it deploy the semantic model, which adds one for you.');
  ui.note('   See "Refresh Power BI from the pipeline" in 1. Fabric/Manual setup/pipelines/README.md.');
  ui.info('3. Scheduled runs read the Key Vault secret as you, the schedule\'s owner. Anyone who edits the');
  ui.info('   pipeline or takes over the schedule needs "get" on the secret first.');
  ui.info(`4. Keep ${c.bold('valuelens-install.json')}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
  if (config.modules.consumption) consumptionSummary(ctx);
  if (config.modules.agentEvaluator) agentEvaluatorSummary(ctx);
  dataSourcesSummary(ctx);
  flowsSummary(ctx);
}

/**
 * Writes what the installer would deploy, with placeholder IDs where none are known. No sign-in.
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, sources: import('./sources.js').Sources, outDir: string, now?: Date }} o
 */
export function preview(o) {
  const { ui, config, sources } = o;
  const out = resolve(o.outDir);
  const fake = (/** @type {number} */ n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const f = config.fabric;
  const sm = config.semanticModel;
  const withModel = sm.enabled !== false && !!sources.modelFile;
  const cc = config.consumption;
  const withConsumptionModel = withModel && !!config.modules.consumption && !!sources.consumptionModelFile;
  const withAzureAi = !!config.modules.consumption && !!cc.azureSubscriptionId;
  const ae = config.agentEvaluator;
  const withTranscripts = !!config.modules.agentEvaluator && ae.environments.length > 0;
  const withAgentEvaluatorModel = withModel && withTranscripts && !!sources.agentEvaluatorModelFile;
  const withDataflow = !!config.modules.consumption && config.dataSources.coworkCredits === 'api' && isVivaId(cc.vivaPartition) && isVivaId(cc.vivaQuery);
  /** @type {Ctx} */
  const ctx = /** @type {any} */ ({
    config: {
      ...config,
      app: { ...config.app, appId: config.app.appId ?? fake(1) },
      keyVault: { ...config.keyVault, uri: config.keyVault.uri ?? `https://${config.keyVault.name ?? 'your-vault'}.vault.azure.net/` },
      fabric: {
        ...f,
        workspaceId: f.workspaceId ?? fake(2),
        lakehouseId: f.lakehouseId ?? fake(3),
        lakehouseName: f.lakehouseName ?? 'ValueLens',
        notebooks: { ...f.notebooks },
      },
      semanticModel: withModel ? { ...sm, id: sm.id ?? fake(4), bound: true } : { ...sm, enabled: false },
      consumption: { ...cc, model: { ...cc.model, id: cc.model.id ?? fake(5), bound: true } },
      agentEvaluator: { ...ae, model: { ...ae.model, id: ae.model.id ?? fake(6), bound: true } },
    },
    user: { tenantId: config.tenantId ?? fake(0) },
  });

  mkdirSync(join(out, 'notebooks'), { recursive: true });
  let n = 10;
  for (const nb of notebooksFor(config.modules, { semanticModel: withModel, azureAi: withAzureAi, dataverse: withTranscripts, dataSources: config.dataSources })) {
    const prepared = prepareNotebook(sources.notebooks[nb.key], notebookSettings(ctx, nb));
    writeFileSync(join(out, 'notebooks', `${nb.displayName}.ipynb`), serialiseNotebook(prepared), 'utf8');
    ctx.config.fabric.notebooks[nb.key] = ctx.config.fabric.notebooks[nb.key] ?? fake(n++);
  }
  const pipeline = buildPipeline(sources.pipeline, {
    workspaceId: /** @type {string} */ (ctx.config.fabric.workspaceId),
    notebookIds: ctx.config.fabric.notebooks,
    modules: config.modules,
    backfillDays: config.history.days,
    semanticModelId: withModel ? ctx.config.semanticModel.id : undefined,
    azureAi: withAzureAi,
    consumptionModelId: withConsumptionModel ? ctx.config.consumption.model.id : undefined,
    agentTranscripts: withTranscripts,
    agentEvaluatorModelId: withAgentEvaluatorModel ? ctx.config.agentEvaluator.model.id : undefined,
    coworkDataflowId: withDataflow ? cc.dataflowId ?? fake(7) : undefined,
  });
  writeFileSync(join(out, 'pipeline-content.json'), `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
  if (withDataflow) {
    const df = coworkDataflowDefinition(cc.dataflowName ?? COWORK_DATAFLOW_NAME, {
      partitionId: /** @type {string} */ (cc.vivaPartition),
      queryId: /** @type {string} */ (cc.vivaQuery),
      workspaceId: /** @type {string} */ (ctx.config.fabric.workspaceId),
      lakehouseId: /** @type {string} */ (ctx.config.fabric.lakehouseId ?? fake(3)),
    });
    mkdirSync(join(out, 'dataflow'), { recursive: true });
    for (const p of df.parts) writeFileSync(join(out, 'dataflow', p.path), Buffer.from(p.payload, 'base64'));
  }
  const flows = flowsWanted(config);
  if (flows.length) {
    const defs = flowDefinitions({ ...ctx.config, app: { ...ctx.config.app, appId: ctx.config.app.appId ?? fake(8) } }, config.tenantId ?? fake(9));
    mkdirSync(join(out, 'flows'), { recursive: true });
    for (const kind of flows) writeFileSync(join(out, 'flows', FLOW_FILES[kind]), `${JSON.stringify(defs[kind].definition, null, 2)}\n`, 'utf8');
  }
  writeFileSync(join(out, 'schedule.json'), `${JSON.stringify(scheduleBody(config.schedule, o.now), null, 2)}\n`, 'utf8');
  writeFileSync(
    join(out, 'graph-permissions.txt'),
    `Microsoft Graph application permissions for the app registration:\n${permissionsFor(config.modules, config.dataSources).map((p) => `  ${p}\n`).join('')}`,
    'utf8',
  );
  if (withModel) {
    const bim = buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), {
      server: sm.server ?? 'your-endpoint.datawarehouse.fabric.microsoft.com',
      database: /** @type {string} */ (ctx.config.fabric.lakehouseName),
      modules: config.modules,
    });
    writeFileSync(join(out, 'model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
  }
  if (withConsumptionModel) {
    const bim = buildConsumptionModel(loadTemplateModel(/** @type {string} */ (sources.consumptionModelFile)), {
      server: sm.server ?? 'your-endpoint.datawarehouse.fabric.microsoft.com',
      database: /** @type {string} */ (ctx.config.fabric.lakehouseName),
    });
    writeFileSync(join(out, 'consumption-model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
  }
  if (withAgentEvaluatorModel) {
    const bim = buildAgentEvaluatorModel(loadTemplateModel(/** @type {string} */ (sources.agentEvaluatorModelFile)), {
      server: sm.server ?? 'your-endpoint.datawarehouse.fabric.microsoft.com',
      database: /** @type {string} */ (ctx.config.fabric.lakehouseName),
    });
    writeFileSync(join(out, 'agent-evaluator-model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
  }

  const models = [withModel ? 'model.bim' : '', withConsumptionModel ? 'consumption-model.bim' : '', withAgentEvaluatorModel ? 'agent-evaluator-model.bim' : ''].filter(Boolean);
  ui.heading('Preview written');
  ui.info(out);
  ui.note(`Notebooks, pipeline-content.json, schedule.json${models.map((m) => `, ${m}`).join('')} and graph-permissions.txt, with placeholder IDs where none are known yet.`);
}
