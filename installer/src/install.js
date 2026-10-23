// @ts-check
/**
 * Wires the clients together and runs each command.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_CATALOG_SCOPE, checkTokens, createCredential, createTokenProvider, decodeJwt, GRAPH_CLI_APP_ID } from './auth.js';
import { notebooksFor, permissionsFor } from './catalog.js';
import { armApi, keyVaultApi } from './clients/azure.js';
import { connectionsApi, POWERAPPS_URL } from './clients/connections.js';
import { dataverseApi, dataverseScope, DISCOVERY_URL, discoveryApi, orgUrl } from './clients/dataverse.js';
import { FLOW_URL, flowApi } from './clients/flow.js';
import { fabricApi, scheduleBody } from './clients/fabric.js';
import { appCatalogApi, CONSENT_ROLES, graphApi } from './clients/graph.js';
import { dataLakeApi, dataLakeUrl, ONELAKE_URL, oneLakeApi } from './clients/onelake.js';
import { powerBiApi } from './clients/powerbi.js';
import { POWER_PLATFORM_URL, powerPlatformApi } from './clients/powerplatform.js';
import { saveConfig, secretMode } from './config.js';
import { createClient, defaultSleep } from './http.js';
import { commandLine } from './launch.js';
import { ensureConsent, ensureApp, ensureKeyVault, newSecret, notebookSecretDays } from './steps/identity.js';
import {
  agentEvaluatorModelWanted, agentEvaluatorSummary, ensureAgentEvaluatorModel, ensureTranscriptAccess, fabricReadRoleWanted, removeFabricReadRoles,
} from './steps/agent-evaluator.js';
import { appDeployedSince, deployApp, ensureAppName, ensureFabricApp } from './steps/app.js';
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
import { ensureModelConnection, ensureSemanticModel, modelUrl, pendingReloads, refreshModel, rotateModelSecret, settleReloads, verifyModel } from './steps/model.js';
import { confirmPlan, plan, preflight } from './steps/plan.js';
import { checkPrereqs } from './prereqs.js';
import { ensureReports, reportsOn, reportsSummary } from './steps/report.js';
import { dataAgentSummary, dataAgentWanted, ensureDataAgent } from './steps/data-agent.js';
import { azureUploadError, dataSourcesSummary, ensureUploads, uploadCommand } from './steps/data-sources.js';
import { ensureFlows, FLOW_FILES, flowDefinitions, flowsSummary, flowsWanted, offerStudioRun } from './steps/flows.js';
import { ensureAppResourceGraphAccess, resourceGraphOn } from './steps/resource-graph.js';
import { routerWanted } from './uploads.js';
import { checkData, chooseLoad, coworkSkipForFirstLoad, runDataCheck, runPipeline, status, TERMINAL } from './steps/run.js';
import { loadCoworkNow, rerunFailed } from './steps/rerun.js';
import { prepareNotebook, serialiseNotebook } from './transform/notebook.js';
import { rlsOn, rlsSettings } from './transform/access.js';
import { buildAgentEvaluatorModel, buildConsumptionModel, buildModel, loadTemplateModel } from './transform/model.js';
import { buildPipeline } from './transform/pipeline.js';
import { c } from './ui.js';
import { fabricUninstall } from './steps/fabric-uninstall.js';
import { askTarget, azureRefresh, azureRotateSecret, azureRun, azureStatus, azureUninstall, azureUpdate, azureViewerModels, confirmAzurePlan, installAzure, planAzure } from './steps/azure/index.js';
import { accessCommand, ensureViewerGroup, grantModelAccess, myGroupsUrl, shareApp } from './steps/access.js';
import { nextSteps, stepsLeftTitle } from './steps/next-steps.js';
import { ensureOrgAccess, verifyOrgAccess } from './steps/org-access.js';
import { reviewSetup } from './setup.js';

/**
 * @typedef {object} Apis
 * @property {import('./clients/fabric.js').FabricApi} fabric
 * @property {import('./clients/graph.js').GraphApi} graph
 * @property {import('./clients/graph.js').GraphApi} [graphRoles]  Graph with the role management scope, asked for only when it's used.
 * @property {import('./clients/graph.js').AppCatalogApi} [appCatalog]  The org's Teams app catalog, through a second sign-in asked for only when the Azure path publishes the Teams app.
 * @property {import('./clients/azure.js').ArmApi} arm
 * @property {import('./clients/azure.js').KeyVaultApi} keyVault
 * @property {import('./clients/onelake.js').OneLakeApi} oneLake
 * @property {import('./clients/powerbi.js').PowerBiApi} powerBi
 * @property {import('./clients/dataverse.js').DiscoveryApi} discovery
 * @property {import('./clients/powerplatform.js').PowerPlatformApi} powerPlatform
 * @property {import('./clients/flow.js').FlowApi} flow
 * @property {import('./clients/connections.js').ConnectionsApi} [connections]  Power Platform connections, for signing the flows in.
 * @property {(url: string) => import('./clients/dataverse.js').DataverseApi} dataverse  A Dataverse environment, by org URL.
 * @property {(account: string) => import('./clients/onelake.js').DataLakeApi} dataLake  An Azure storage account's files, by account name.
 *
 * @typedef {{ id: string, upn: string, tenantId: string, displayName?: string }} User
 *
 * @typedef {object} Ctx
 * @property {import('./ui.js').Ui} ui
 * @property {import('./config.js').InstallConfig} config
 * @property {string} file
 * @property {() => void} save  Writes the install record.
 * @property {Apis} api
 * @property {User} user
 * @property {import('./sources.js').Sources} sources
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => Date} now
 * @property {string} [pendingSecret]  A secret the user pasted, held in memory until it is in Key Vault or the notebooks.
 * @property {boolean} [secretInNotebook]  --no-key-vault (or --secret-in-notebook): keep the secret in the notebooks instead of Key Vault.
 * @property {boolean} [useKeyVault]  --key-vault: keep the secret in Key Vault, not the notebooks (the default for a new Fabric install).
 * @property {boolean} [allowModelReset]  --allow-model-reset: when Fabric can't update a model and keep its data, clear it and reload it without asking. --yes alone never does.
 * @property {Apis} [liveApi]  While the plan's answers can be rewound, the clients without the cache, for checks the user repeats.
 * @property {boolean} [runFirstLoad]
 * @property {boolean} [advanced]  The plan's "Change the advanced settings?" answer. With false, those settings keep their saved value or default.
 * @property {number} [reloadHistoryDays]  Repair or change: reload this many days of audit history after setup.
 * @property {import('./steps/azure/regions.js').RegionCheck} [azureRegions]  Azure: what the region preflight found, for placing the Ask model.
 * @property {{ sp: any, roles: { id: string, value: string }[] }} [graphRoles]
 * @property {import('./steps/azure/teams-catalog.js').CatalogAccess} [teamsCatalog]  Azure: whether this run can publish the Teams app to the org's app catalog, and why not.
 * @property {import('./steps/app.js').Runner} [runner]  Runs the app's build tools; tests replace it.
 * @property {import('./staging.js').PendingUpload[]} [pendingUploads]  Exports to upload to the drop folder during the install.
 * @property {string[]} [csvFiles]  Exports named with --csv.
 * @property {string} [configFile]  The install record's path.
 * @property {(resource: import('./auth.js').Resource) => Promise<string>} [getToken]  The signed-in user's tokens, for tools the installer runs.
 * @property {string} [setupSection] Open this settings category directly after a failure.
 * @property {boolean} [setupRetry] Revalidate saved choices without reopening every question.
 */

/**
 * Signs in once and builds a client for each API.
 * @param {{ tenantId?: string, method?: 'browser' | 'device-code' | 'azure-cli', ui: import('./ui.js').Ui, debug?: (m: string) => void, checkTokens?: boolean }} opts
 *   checkTokens: get a token for every API first, so a sign-in that can't reach one fails before anything changes.
 * @returns {Promise<{ api: Apis, user: User, getToken: (resource: import('./auth.js').Resource) => Promise<string> }>}
 */
export async function connect(opts) {
  const credential = createCredential({ tenantId: opts.tenantId, method: opts.method, print: (m) => opts.ui.line(m) });
  const getToken = createTokenProvider(credential, { debug: opts.debug });
  /**
   * @param {string} baseUrl
   * @param {import('./auth.js').Resource} resource
   */
  const client = (baseUrl, resource) => createClient({ baseUrl, getToken: () => getToken(resource), debug: opts.debug });
  /** @type {Apis} */
  const api = {
    fabric: fabricApi(client('https://api.fabric.microsoft.com/v1', 'fabric')),
    graph: graphApi(client('https://graph.microsoft.com/v1.0', 'graph')),
    // The Azure CLI sign-in only hands out .default tokens, so it can't ask for this scope.
    ...(opts.method === 'azure-cli' ? {} : { graphRoles: graphApi(client('https://graph.microsoft.com/v1.0', 'graphRoles')) }),
    arm: armApi(client('https://management.azure.com', 'arm')),
    keyVault: keyVaultApi(client('https://vault.azure.net', 'keyVault')),
    oneLake: oneLakeApi(client(ONELAKE_URL, 'storage')),
    powerBi: powerBiApi(client('https://api.powerbi.com/v1.0/myorg', 'powerbi')),
    discovery: discoveryApi(client(DISCOVERY_URL, 'discovery')),
    powerPlatform: powerPlatformApi(client(POWER_PLATFORM_URL, 'powerPlatform')),
    flow: flowApi(client(FLOW_URL, 'flow')),
    connections: connectionsApi(client(POWERAPPS_URL, 'powerApps')),
    dataverse: (url) => dataverseApi(client(`${orgUrl(url)}/api/data/v9.2`, dataverseScope(url)), url),
    dataLake: (account) => dataLakeApi(client(dataLakeUrl(account), 'storage')),
  };
  if (opts.checkTokens) await checkTokens(getToken);
  const claims = decodeJwt(await getToken('graph'));
  if (opts.method !== 'azure-cli') {
    // The app the installer signs in with can't ask for the app catalog scope, so publishing the
    // Teams app signs in once more with Microsoft Graph Command Line Tools, the first time it's used.
    const catalogToken = createTokenProvider(
      createCredential({ tenantId: opts.tenantId || claims.tid, method: opts.method, clientId: GRAPH_CLI_APP_ID, print: (m) => opts.ui.line(m) }),
      { debug: opts.debug },
    );
    /** @param {{ abortSignal?: AbortSignal }} [o] */
    const token = (o) => catalogToken(APP_CATALOG_SCOPE, o);
    api.appCatalog = appCatalogApi(createClient({ baseUrl: 'https://graph.microsoft.com/v1.0', getToken: token, debug: opts.debug }), token);
  }
  const me = await api.graph.me();
  return { api, user: { id: me.id, upn: me.userPrincipalName, displayName: me.displayName, tenantId: claims.tid }, getToken };
}

/**
 * @param {{ ui: import('./ui.js').Ui, config: import('./config.js').InstallConfig, file: string, api: Apis, user: User, sources: import('./sources.js').Sources, sleep?: (ms: number) => Promise<void>, now?: () => Date, getToken?: (resource: import('./auth.js').Resource) => Promise<string> }} o
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
    file: o.file,
    save: () => saveConfig(o.file, o.config),
    api: o.api,
    user: o.user,
    sources: o.sources,
    sleep: o.sleep ?? defaultSleep,
    now: o.now ?? (() => new Date()),
    configFile: o.file,
    ...(o.getToken ? { getToken: o.getToken } : {}),
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
  const { pendingSecret, runFirstLoad, reloadHistoryDays, pendingUploads } = ctx;
  const real = ctx.api;
  ctx.api = memoApi(real);
  ctx.liveApi = real;
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
        ctx.reloadHistoryDays = reloadHistoryDays;
        ctx.pendingUploads = pendingUploads;
      }
    }
  } finally {
    ctx.api = real;
    delete ctx.liveApi;
    ui.end();
  }
}

/**
 * Full set-up, or a repair when the install record already has IDs.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 * @returns {Promise<boolean>} false when a step failed and the install carried on, or the first load or model refresh it
 *   waited for didn't leave a working model. An app deployed meanwhile, by deploy-app, makes up for its own step only
 *   when that was the only failure.
 */
export async function install(ctx, opts) {
  const { ui, config } = ctx;
  let go;
  /** @type {import('./steps/plan.js').Preflight | undefined} */
  let pre;
  if (ui.web) {
    go = await reviewSetup(ctx);
    if (go && config.target !== 'azure') pre = await preflight(ctx);
  }
  else {
    const wasAzure = config.target === 'azure';
    await askTarget(ctx);
    // The CLI stops --csv on an Azure install before signing in, but a new install only chooses its target here.
    if (config.target === 'azure' && ctx.csvFiles?.length) throw azureUploadError(config, '--csv', !wasAzure);
    pre = await preflight(ctx);
    const checked = pre;
    go = await rewindable(ctx, async () => {
      if (config.target === 'azure') await planAzure(ctx, checked);
      else await plan(ctx, checked);
      ctx.save();
      return config.target === 'azure' ? confirmAzurePlan(ctx) : confirmPlan(ctx, checked);
    });
  }
  if (!go) {
    ui.warn('Stopped before changing anything. Your answers are saved for next time.');
    return true;
  }

  if (config.target === 'azure') return installAzure(ctx, opts);

  const sm = config.semanticModel;
  const withModel = !!sm.enabled;
  const withApp = withModel && !!config.fabricApp.enabled;
  const withConsumption = !!config.modules.consumption;
  // Unticked, the step still takes away the read roles the installer gave the app.
  const withAgentEvaluator = !!config.modules.agentEvaluator || !!config.fabric.transcriptAccess?.length;
  const withUploads = routerWanted(config.dataSources) || !!ctx.pendingUploads?.length || flowsWanted(config).length > 0;
  const withResourceGraph = resourceGraphOn(config);
  const withReports = reportsOn(config);
  const withDataAgent = dataAgentWanted(ctx);
  const withAccess = withModel && !!config.access;
  // Once, straight after the app is deployed and before the long first load.
  const withShare = withApp && withAccess && config.access?.appShared !== true;
  const titles = [
    'Key Vault',
    'App registration',
    'Microsoft Graph permissions',
    'Workspace and Lakehouse',
    ...(withModel ? ['Semantic model'] : []),
    ...(withConsumption ? ['Credit consumption'] : []),
    ...(withAgentEvaluator ? ['Copilot Studio transcripts'] : []),
    ...(withResourceGraph ? ['Resource Graph access'] : []),
    ...(withReports ? ['Power BI reports'] : []),
    ...(withDataAgent ? ['Ask data agent'] : []),
    ...(withUploads ? ['Data uploads'] : []),
    'Notebooks, pipeline and schedule',
    ...(withAccess ? ['Viewer access'] : []),
    ...(withApp ? ['Analytics Hub app'] : []),
    ...(withShare ? ['Share the app'] : []),
    ...(ctx.runFirstLoad ? ['First load'] : ctx.reloadHistoryDays ? ['Reload audit history'] : withModel ? ['Model refresh'] : []),
  ];
  let n = 0;
  const step = (/** @type {string} */ title) => ui.step(++n, titles.length, title);

  step('Key Vault');
  await ensureKeyVault(ctx);
  step('App registration');
  await ensureApp(ctx);
  step('Microsoft Graph permissions');
  const consented = await ensureConsent(ctx, /** @type {import('./steps/plan.js').Preflight} */ (pre));
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
  if (withResourceGraph) {
    step('Resource Graph access');
    await ensureAppResourceGraphAccess(ctx);
  }
  // A step that fails and lets the install carry on leaves it partly set up. One that only warns doesn't.
  let stepsOk = true;
  if (withReports) {
    step('Power BI reports');
    stepsOk = (await ensureReports(ctx)) && stepsOk;
  }
  if (withDataAgent) {
    step('Ask data agent');
    stepsOk = (await ensureDataAgent(ctx)) && stepsOk;
  }
  if (withUploads) {
    step('Data uploads');
    stepsOk = (await ensureUploads(ctx)) && stepsOk;
    await ensureFlows(ctx);
  }
  step('Notebooks, pipeline and schedule');
  // With no Key Vault, each install or repair gives the notebooks a new client secret.
  await ensureNotebooks(ctx, { rotate: true });
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx);
  await ensureSchedule(ctx);
  // Before the first load or refresh, so the models open to viewers as soon as they have data.
  if ((await ensureOrgAccess(ctx, { refresh: false })) === false) stepsOk = false;
  if (withAccess) {
    step('Viewer access');
    if (await ensureViewerGroup(ctx)) await grantModelAccess(ctx, fabricViewerModels(config));
  }
  let appDeployed = true;
  /** @type {{ since: number, workspaceId?: string, deployedAt?: string } | undefined} */
  let appFailure;
  if (withApp) {
    step('Analytics Hub app');
    const since = ctx.now().getTime();
    appDeployed = await tryDeployApp(ctx);
    if (!appDeployed) appFailure = { since, workspaceId: config.fabric.workspaceId, deployedAt: config.fabricApp.deployedAt };
  }
  if (withShare) {
    step('Share the app');
    await shareApp(ctx);
  }

  // A Studio flow that's on but hasn't loaded its six months yet: run it now, before the pipeline.
  if (withUploads) await offerStudioRun(ctx, { pipelineNext: !!(ctx.runFirstLoad || ctx.reloadHistoryDays) && consented && vaultReachable, quietWhenOff: true });

  let ok = true;
  // The pipeline refreshes the models as its last step. When it can't, a model owed a reload is refreshed on its own.
  /** @type {import('./steps/model.js').LoadState} */
  let load = 'none';
  if (ctx.runFirstLoad) {
    step('First load');
    if (!consented) {
      ui.warn(`Skipped until admin consent is granted. Then run: ${commandLine(`run --backfill-days ${config.history.days}`)}`);
    } else if (!vaultReachable) {
      ui.warn(`Skipped until the private endpoint to ${config.keyVault.name} is approved. Then run: ${commandLine(`run --backfill-days ${config.history.days}`)}`);
    } else {
      if (modelDeployed(config)) ui.note(`The pipeline refreshes ${joinNames(deployedModels(config).map((m) => m.name))} as its last step.`);
      const skipCowork = await coworkSkipForFirstLoad(ctx);
      const result = await runPipeline(ctx, { backfillDays: config.history.days, wait: opts.wait, first: true, skipCowork });
      load = loadState(result);
      if (result.status === 'Completed') {
        // A run completes even when a load in it failed.
        if (result.counted?.length) stepsOk = false;
        if ((await runDataCheck(ctx)) === false) stepsOk = false;
        if (modelDeployed(config)) ok = (await verifyModel(ctx)).ok;
      }
      if (opts.wait && config.firstRun?.status !== 'Completed') ok = false;
    }
  } else if (ctx.reloadHistoryDays) {
    step('Reload audit history');
    const days = ctx.reloadHistoryDays;
    const later = commandLine(`run --backfill-days ${days}`);
    if (!consented) {
      ui.warn(`Skipped until admin consent is granted. Then run: ${later}`);
    } else if (!vaultReachable) {
      ui.warn(`Skipped until the private endpoint to ${config.keyVault.name} is approved. Then run: ${later}`);
    } else {
      if (modelDeployed(config)) ui.note(`The pipeline refreshes ${joinNames(deployedModels(config).map((m) => m.name))} as its last step.`);
      const result = await runPipeline(ctx, { backfillDays: days, wait: opts.wait });
      load = loadState(result);
      if (result.started) {
        config.history.days = days;
        ctx.save();
      }
      if (result.status === 'Completed') {
        if (result.counted?.length) stepsOk = false;
        if ((await runDataCheck(ctx)) === false) stepsOk = false;
        if (modelDeployed(config)) ok = (await verifyModel(ctx)).ok;
      } else if (opts.wait) ok = false;
    }
  } else if (withModel) {
    step('Model refresh');
    ok = await restoreModels(ctx, { wait: opts.wait });
    load = 'refreshed';
  }
  const reloads = await settleReloads(ctx, { wait: opts.wait, load, reachable: fabricReachable(config) });
  if (!reloads.ok) notFinished(ctx, 'install');
  /** @type {string | undefined} */
  let appLate;
  if (appFailure) {
    // The step says to run deploy-app, which people do while the first load runs: saving merges its record in.
    ctx.save();
    appLate = appDeployedSince(config, appFailure);
  }
  // A late app makes up for its own step, so only when nothing else failed.
  const appOk = appDeployed || !!appLate;
  ok = reloads.ok && ok && stepsOk && appOk;
  await summary(ctx, { ok, pending: reloads.pending, appFailed: !appDeployed && !appLate, appLate });
  return ok;
}

/**
 * How far a pipeline run got with reloading the models it refreshes as its last step.
 * @param {import('./steps/run.js').RunResult} result
 * @returns {import('./steps/model.js').LoadState}
 */
export function loadState(result) {
  if (result.status === 'Completed') return 'done';
  // Failed, cancelled and the like: it won't refresh them.
  if (TERMINAL.has(/** @type {string} */ (result.status))) return 'none';
  // Started and not waited for, or another run is going: either refreshes them when it finishes.
  return 'running';
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
 * Access to the chosen environments' transcripts, and the Agent Evaluator model. First, the read role the installer
 * gave the app is taken away where it's no longer wanted: environments no longer chosen, or every one when the module
 * is unticked.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
async function agentEvaluatorSteps(ctx, opts = {}) {
  await removeFabricReadRoles(ctx, (t) => fabricReadRoleWanted(ctx.config, t));
  if (!ctx.config.modules.agentEvaluator) return;
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
 * The models the viewer group needs Build on: each one deployed, bound to its connection or not yet.
 * @param {import('./config.js').InstallConfig} config
 * @returns {import('./steps/access.js').ModelRef[]}
 */
export function fabricViewerModels(config) {
  const ws = config.fabric.workspaceId;
  if (!ws || !config.semanticModel.enabled) return [];
  return [config.semanticModel, config.modules.consumption && config.consumption.model, config.modules.agentEvaluator && config.agentEvaluator.model]
    .filter((m) => m && m.id)
    .map((m) => ({ workspaceId: ws, datasetId: /** @type {string} */ (/** @type {any} */ (m).id), name: /** @type {any} */ (m).name }));
}

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
 * Refreshes the models and, when it waits, checks ValueLens answers queries. Not waiting, it's
 * enough that the refreshes started; a model owed a reload is settled after (see settleReloads).
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 * @returns {Promise<boolean>}
 */
async function restoreModels(ctx, opts) {
  const refreshed = await refreshModels(ctx, { wait: opts.wait });
  if (!refreshed.ok) return !opts.wait;
  return opts.wait ? (await verifyModel(ctx)).ok : true;
}

/**
 * Whether a refresh can reach a Fabric model: deployed and reading the Lakehouse.
 * @param {import('./config.js').InstallConfig} config
 */
function fabricReachable(config) {
  const ids = new Set(deployedModels(config).map((m) => m.id));
  return (/** @type {import('./config.js').ModelConfig} */ m) => ids.has(m.id);
}

/**
 * The app is the last thing before the data load, so a failure here shouldn't stop that.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<boolean>} Whether the app deployed.
 */
async function tryDeployApp(ctx, opts = {}) {
  try {
    await (opts.force ? deployApp(ctx) : ensureFabricApp(ctx));
    return true;
  } catch (err) {
    ctx.ui.fail(`The app wasn't deployed: ${/** @type {Error} */ (err).message}`);
    ctx.ui.info(`Fix the problem, then run "${commandLine('deploy-app')}".`);
    return false;
  }
}

/**
 * Pushes the notebooks and pipeline from this checkout over the deployed ones.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} [opts]
 */
export async function update(ctx, opts = {}) {
  const { ui, config } = ctx;
  if (config.target === 'azure') return azureUpdate(ctx);
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
  if (config.modules.agentEvaluator || config.fabric.transcriptAccess?.length) await agentEvaluatorSteps(ctx, { force: true });
  if (resourceGraphOn(config)) await ensureAppResourceGraphAccess(ctx);
  // As in install: a step that fails and lets the update carry on leaves it unfinished.
  let stepsOk = true;
  if (reportsOn(config)) stepsOk = (await ensureReports(ctx)) && stepsOk;
  stepsOk = (await ensureDataAgent(ctx)) && stepsOk;
  if (routerWanted(config.dataSources)) stepsOk = (await ensureUploads(ctx)) && stepsOk;
  await ensureFlows(ctx);
  await ensureNotebooks(ctx, { force: true });
  await ensureSparkSettings(ctx);
  await ensurePipeline(ctx, { force: true });
  await ensureSchedule(ctx);
  if ((await ensureOrgAccess(ctx, { refresh: false })) === false) stepsOk = false;
  if (sm.enabled && config.fabricApp.enabled) {
    if (await ui.confirm('Rebuild and redeploy the Analytics Hub app too?', true)) stepsOk = (await tryDeployApp(ctx, { force: true })) && stepsOk;
    else await ensureAppName(ctx);
  }
  return finishUpdate(ctx, { ...opts, failed: !stepsOk });
}

/**
 * The end of a Fabric update: refreshes the models so they load their data with the new
 * definitions. "Up to date" only once every model owed a reload has finished reloading and no step
 * failed; not waiting, the refreshes started is success, but said as such.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, failed?: boolean }} [opts]  failed: a step before this failed, and the update carried on.
 * @returns {Promise<boolean>}
 */
export async function finishUpdate(ctx, opts = {}) {
  const { ui, config } = ctx;
  const wait = opts.wait ?? true;
  let ok = true;
  if (modelDeployed(config)) {
    ui.note('The models refresh now, to load their data with the new definitions.');
    const refreshed = await refreshModels(ctx, { wait });
    if (!refreshed.ok) ok = false;
    else if (wait && !(await verifyModel(ctx)).ok) return false;
    else if (wait) await verifyOrgAccess(ctx);
  }
  const reloads = await settleReloads(ctx, { wait, load: modelDeployed(config) ? 'refreshed' : 'none', reachable: fabricReachable(config) });
  if (!ok || !reloads.ok) {
    notFinished(ctx, 'update');
    return false;
  }
  if (opts.failed) {
    ui.fail(`The update isn't finished: a step above failed. Fix what it says, then run "${commandLine('update')}" again.`);
    if (reloads.pending.length) ui.warn(reloadingNote(reloads.pending));
    return false;
  }
  if (reloads.pending.length) {
    ui.ok(`Updated. ${reloadingNote(reloads.pending)}`);
    return true;
  }
  ui.ok('Up to date. The next scheduled run uses the new versions.');
  return true;
}

/** @param {string[]} names */
function reloadingNote(names) {
  return `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} still reloading: reports on ${names.length === 1 ? 'it' : 'them'} can show no data or miss new columns until that finishes. Check with "${commandLine('status')}".`;
}

/** @param {Ctx} ctx @param {'install' | 'update'} what */
function notFinished(ctx, what) {
  const cleared = pendingReloads(ctx.config).filter((m) => m.reload?.cleared).map((m) => m.name);
  if (cleared.length) ctx.ui.warn(`${joinNames(cleared)} ${cleared.length === 1 ? 'has' : 'have'} no data until a refresh finishes.`);
  ctx.ui.fail(`The ${what} isn't finished: the models weren't reloaded. Fix the problem above, then run "${commandLine('refresh')}", or "${commandLine(what)}" again.`);
}

/**
 * Starts the pipeline: the first load until one has loaded the history, then the usual run.
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number, wait: boolean }} opts
 */
export async function run(ctx, opts) {
  if (ctx.config.target === 'azure') return azureRun(ctx, opts);
  await offerStudioRun(ctx, { pipelineNext: true });
  const load = await chooseLoad(ctx, opts);
  const result = await runPipeline(ctx, { ...load, skipCowork: !!load.first && (await coworkSkipForFirstLoad(ctx)) });
  // Asking for more history than the record has: later repairs offer more than this.
  if (result.started && opts.backfillDays && (load.first || opts.backfillDays > ctx.config.history.days)) {
    ctx.config.history.days = opts.backfillDays;
    ctx.save();
  }
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
  if (ctx.config.target === 'azure') return azureRefresh(ctx);
  if (!ctx.config.semanticModel.id) throw new Error('There is no semantic model yet. Run the installer and choose to deploy it.');
  if (deployedModels(ctx.config).length < 2) return refreshModel(ctx, opts);
  return refreshModels(ctx, opts);
}

/**
 * Prints what the signed-in user has and lacks for an install. Changes nothing.
 * @param {Ctx} ctx
 */
export async function showPrereqs(ctx) {
  ctx.ui.heading('Prerequisites');
  ctx.ui.ok(`Signed in as ${ctx.user.upn} (tenant ${ctx.user.tenantId})`);
  const items = await checkPrereqs(ctx);
  ctx.ui.prereqs(items);
  return items;
}

/**
 * Runs one command against a signed-in context.
 * @param {Ctx} ctx
 * @param {string} command
 * @param {{ wait: boolean, backfillDays?: number, files?: string[], run?: boolean }} opts
 * @returns {Promise<boolean>} false when a run, refresh or resource group delete it waited for didn't succeed.
 */
export async function runCommand(ctx, command, opts) {
  switch (command) {
    case 'install':
      return install(ctx, opts);
    case 'update':
      return (await update(ctx, opts)) !== false;
    case 'run': {
      const result = await run(ctx, opts);
      return !opts.wait || !!result.ok;
    }
    case 'rerun-failed':
      return !(await rerunFailed(ctx)).failed.length;
    case 'load-cowork':
      return !(await loadCoworkNow(ctx)).failed.length;
    case 'check': {
      const checked = !!(await checkData(ctx));
      if (ctx.config.target === 'azure' || !modelDeployed(ctx.config)) return checked;
      return (await verifyModel(ctx)).ok && checked;
    }
    case 'refresh': {
      const result = await refresh(ctx, opts);
      return !opts.wait || result.ok;
    }
    case 'deploy-app':
      await deployAppNow(ctx);
      return true;
    case 'status':
      if (ctx.config.target === 'azure') await azureStatus(ctx);
      else await status(ctx);
      return true;
    case 'rotate-secret':
      if (ctx.config.target === 'azure') await azureRotateSecret(ctx);
      else await rotateSecret(ctx);
      return true;
    case 'uninstall':
      if (ctx.config.target === 'azure') return azureUninstall(ctx, { wait: opts.wait });
      await fabricUninstall(ctx);
      return true;
    case 'upload':
      return uploadCommand(ctx, { files: opts.files ?? [], run: opts.run, wait: opts.wait }, (c2, o) => run(c2, o));
    case 'prereqs':
      await showPrereqs(ctx);
      return true;
    case 'access': {
      const azure = ctx.config.target === 'azure';
      const before = ctx.config.access?.groupId;
      // Turning org-scoped access on or off runs an update; one that didn't finish fails the command.
      let finished = true;
      await accessCommand(ctx, azure ? azureViewerModels(ctx.config) : fabricViewerModels(ctx.config), async (c2) => {
        const ok = await update(c2);
        if (ok === false) finished = false;
        return ok;
      });
      const after = ctx.config.access?.groupId;
      if (after && after !== before) {
        ctx.ui.note(azure
          ? `Run "${commandLine('install')}" so the web app lets the group in and shows who to ask for access.`
          : `Run "${commandLine('deploy-app')}" so the app shows who to ask for access and links to the group.`);
      }
      return finished;
    }
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
  const mode = secretMode(config);
  if (!config.app.appId || (mode === 'notebook' ? !config.fabric.workspaceId : !config.keyVault.uri)) throw new Error('Nothing is installed yet. Run the installer first.');
  const sm = config.semanticModel;
  ui.heading('New client secret');
  ui.info(`App: ${config.app.displayName ?? config.app.appId}`);
  if (mode === 'notebook') ui.info('Secret: in the notebooks (no Key Vault)');
  else ui.info(`Key Vault: ${config.keyVault.name}, secret ${config.keyVault.secretName}`);
  if (sm.connectionId) ui.info(`Connection: ${sm.connectionName}, used by ${sm.name}`);
  if (mode === 'notebook') {
    ui.note(
      config.app.existing
        ? 'You paste the new secret, and the notebooks are rewritten with it. Then delete the old one from the app\'s Certificates & secrets page.'
        : `A new secret, valid for ${notebookSecretDays(config)} days, is written into the notebooks, then the old one is removed from the app, so copies of it in run snapshots, exports or Git stop working.`,
    );
    if (!(await ui.confirm(`Create a new secret and rewrite the notebooks${sm.connectionId ? ', and replace the connection\'s' : ''}?`, true))) return;
    await ensureNotebooks(ctx, { force: true });
    if (sm.connectionId) await rotateModelSecret(ctx);
    ui.note('Anyone with a role in the workspace can read the secret in the notebooks. Key Vault avoids that: run the installer again and choose Use Key Vault instead.');
    return;
  }
  if (mode === 'keyvault-admin') {
    if (!(await ui.confirm(`Show the steps for a vault admin to replace the secret in ${config.keyVault.name}${sm.connectionId ? ', and replace the connection\'s' : ''}?`, true))) return;
  } else {
    ui.note('The notebooks\' old secret keeps working until it expires. Delete it from the app\'s Certificates & secrets page once a run has succeeded.');
    if (!(await ui.confirm(`Create new secrets and replace the one in Key Vault${sm.connectionId ? ' and the connection\'s' : ''}?`, true))) return;
  }
  await newSecret(ctx);
  if (sm.connectionId) await rotateModelSecret(ctx);
}

/**
 * Prints where everything is and what to do next.
 * @param {Ctx} ctx
 * @param {{ ok?: boolean, pending?: string[], appFailed?: boolean, appLate?: string }} [opts]  ok false when a step above failed, so the heading doesn't say it is all set up;
 *   pending: models still reloading after their update; appFailed: the app step failed, so a card says how to deploy it;
 *   appLate: when the app was deployed after its step failed, by deploy-app or Redeploy run meanwhile.
 */
export async function summary(ctx, opts = {}) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const lhId = /** @type {string} */ (f.lakehouseId);
  const lakehouse = await api.fabric.getLakehouse(ws, lhId).catch(() => null);
  const sql = lakehouse?.properties?.sqlEndpointProperties;

  if (opts.ok === false) {
    ui.heading('Analytics Hub is partly set up');
    ui.warn('A step above didn\'t finish. Fix what it says, then run the installer again: it picks up where it stopped.');
    if (opts.pending?.length) ui.warn(reloadingNote(opts.pending));
  } else if (opts.pending?.length) {
    ui.heading('Analytics Hub is set up, still reloading');
    ui.warn(reloadingNote(opts.pending));
  } else {
    ui.heading('Analytics Hub is set up');
  }
  if (opts.appLate) ui.ok(`The app step above failed, but the app was deployed afterwards (${new Date(opts.appLate).toISOString().slice(0, 16).replace('T', ' ')} UTC).`);
  const left = nextSteps(config, ctx.user, { appFailed: opts.appFailed });
  if (left.length) ui.nextSteps(stepsLeftTitle(left), left);
  ui.info(`Workspace:  ${f.workspaceName}  ${c.dim(`https://app.fabric.microsoft.com/groups/${ws}`)}`);
  ui.info(`Lakehouse:  ${f.lakehouseName}`);
  ui.info(`Pipeline:   ${f.pipelineName ?? PIPELINE_NAME}, ${describeSchedule(config.schedule)}`);
  const mode = secretMode(config);
  const expires = config.app.secretExpires ? `, expires ${config.app.secretExpires.slice(0, 10)}` : '';
  const expiresOn = config.app.secretExpires ? ` on ${config.app.secretExpires.slice(0, 10)}` : '';
  if (mode === 'notebook') ui.info(`Secret:     in the notebooks${expires}  ${c.dim('No Key Vault: anyone with a role in the workspace can read it. Each install, repair or update replaces it.')}`);
  else ui.info(`Secret:     ${config.keyVault.name} / ${config.keyVault.secretName}${expires}${mode === 'keyvault-admin' ? c.dim('  Added by a vault admin.') : ''}`);
  if (config.keyVault.private) ui.info(`            ${c.dim('Private vault, reached through a managed private endpoint. Spark sessions take a few minutes longer to start.')}`);

  const sm = config.semanticModel;
  const fa = config.fabricApp;
  if (sm.enabled && sm.id) {
    ui.info(`Model:      ${sm.name}  ${c.dim(modelUrl(ws, sm.id))}`);
    if (sm.connectionName) ui.info(`            ${c.dim(`Reads the Lakehouse through "${sm.connectionName}"${sm.secretExpires ? `, whose secret expires ${sm.secretExpires.slice(0, 10)}` : ''}.`)}`);
    if (fa.enabled && fa.itemId) ui.info(`App:        ${fa.name}  ${c.dim(fa.url ?? '')}`);
    reportsSummary(ctx);
    dataAgentSummary(ctx);

    const group = config.access?.groupId ? config.access : undefined;
    ui.heading('Next steps');
    if (group) {
      // Sharing the app item itself is asked before the first load, and is a card above until it's done.
      ui.info(`1. Give people access by adding them to "${group.groupName}": run "${commandLine('access')}", use Share in the app,`);
      ui.info(`   or open ${myGroupsUrl(/** @type {string} */ (group.groupId))}. The group already has Build on the models. Keep viewers off workspace roles.`);
      if (reportsOn(config)) ui.info(`   Share the reports with "${group.groupName}" once: open them in the workspace, choose Share, and add the group.`);
    } else {
      const shared = [...(reportsOn(config) ? ['reports'] : []), ...(fa.enabled ? ['app'] : [])].join(' and ') || 'reports you publish';
      ui.info(`1. Share the ${shared}: open ${shared === 'app' ? 'it' : 'them'} in the workspace, choose Share, and add people or a group.`);
      ui.info(`   They also need Build on ${sm.name} (its Manage permissions page), or Viewer on the workspace.`);
    }
    if (secretMode(config) === 'notebook') {
      ui.info('2. Scheduled runs refresh the model as you, the schedule\'s owner. Anyone with a role in the workspace can');
      ui.info(`   read the client secret in the notebooks. Repair or run "${commandLine('rotate-secret')}" before it expires${expiresOn}.`);
    } else {
      ui.info('2. Scheduled runs read the Key Vault secret as you, the schedule\'s owner, and refresh the model');
      ui.info('   as you. Anyone who takes over the pipeline needs "get" on the secret and Contributor on the workspace.');
    }
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
  ui.note('   See "Refresh Power BI from the pipeline" in fabric/pipelines/README.md.');
  if (secretMode(config) === 'notebook') {
    ui.info('3. Anyone with a role in the workspace can read the client secret in the notebooks. Repair or run');
    ui.info(`   "${commandLine('rotate-secret')}" before it expires${expiresOn}.`);
  } else {
    ui.info('3. Scheduled runs read the Key Vault secret as you, the schedule\'s owner. Anyone who edits the');
    ui.info('   pipeline or takes over the schedule needs "get" on the secret first.');
  }
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
  for (const nb of notebooksFor(config.modules, { semanticModel: withModel, azureAi: withAzureAi, dataverse: withTranscripts, access: rlsOn(ctx.config), dataSources: config.dataSources })) {
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
    resourceGraph: config.dataSources.resourceGraph === 'api',
    access: rlsOn(ctx.config),
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
      resourceGraph: config.dataSources.resourceGraph === 'api',
      access: rlsSettings(ctx.config),
    });
    writeFileSync(join(out, 'model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
  }
  if (withConsumptionModel) {
    const bim = buildConsumptionModel(loadTemplateModel(/** @type {string} */ (sources.consumptionModelFile)), {
      server: sm.server ?? 'your-endpoint.datawarehouse.fabric.microsoft.com',
      database: /** @type {string} */ (ctx.config.fabric.lakehouseName),
      resourceGraph: config.dataSources.resourceGraph === 'api',
      access: rlsSettings(ctx.config),
    });
    writeFileSync(join(out, 'consumption-model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
  }
  if (withAgentEvaluatorModel) {
    const bim = buildAgentEvaluatorModel(loadTemplateModel(/** @type {string} */ (sources.agentEvaluatorModelFile)), {
      server: sm.server ?? 'your-endpoint.datawarehouse.fabric.microsoft.com',
      database: /** @type {string} */ (ctx.config.fabric.lakehouseName),
      access: rlsSettings(ctx.config),
    });
    writeFileSync(join(out, 'agent-evaluator-model.bim'), `${JSON.stringify(bim, null, 2)}\n`, 'utf8');
  }

  const models = [withModel ? 'model.bim' : '', withConsumptionModel ? 'consumption-model.bim' : '', withAgentEvaluatorModel ? 'agent-evaluator-model.bim' : ''].filter(Boolean);
  ui.heading('Preview written');
  ui.info(out);
  ui.note(`Notebooks, pipeline-content.json, schedule.json${models.map((m) => `, ${m}`).join('')} and graph-permissions.txt, with placeholder IDs where none are known yet.`);
}
