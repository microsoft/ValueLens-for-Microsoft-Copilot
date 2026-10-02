// @ts-check
/**
 * Wires the clients together and runs each command.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCredential, createTokenProvider, decodeJwt } from './auth.js';
import { notebooksFor, permissionsFor } from './catalog.js';
import { armApi, keyVaultApi } from './clients/azure.js';
import { fabricApi, scheduleBody } from './clients/fabric.js';
import { CONSENT_ROLES, graphApi } from './clients/graph.js';
import { ONELAKE_URL, oneLakeApi } from './clients/onelake.js';
import { powerBiApi } from './clients/powerbi.js';
import { saveConfig } from './config.js';
import { createClient, defaultSleep } from './http.js';
import { ensureConsent, ensureApp, ensureKeyVault, newSecret } from './steps/identity.js';
import { deployApp, ensureFabricApp } from './steps/app.js';
import { describeSchedule, ensureLakehouse, ensureNotebooks, ensurePipeline, ensureSchedule, ensureVaultEndpoint, ensureWorkspace, modelDeployed, notebookSettings, PIPELINE_NAME } from './steps/fabric.js';
import { ensureModelConnection, ensureSemanticModel, modelUrl, refreshModel, rotateModelSecret } from './steps/model.js';
import { confirmPlan, plan, preflight } from './steps/plan.js';
import { runDataCheck, runPipeline, status } from './steps/run.js';
import { prepareNotebook, serialiseNotebook } from './transform/notebook.js';
import { buildModel, loadTemplateModel } from './transform/model.js';
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
  };
}

/** @param {Ctx} ctx */
async function canConsent(ctx) {
  const roles = await ctx.api.graph.myDirectoryRoles().catch(() => []);
  return roles.some((r) => r.roleTemplateId in CONSENT_ROLES);
}

/**
 * Full set-up, or a repair when the install record already has IDs.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
export async function install(ctx, opts) {
  const { ui, config } = ctx;
  const pre = await preflight(ctx);
  await plan(ctx, pre);
  ctx.save();
  if (!(await confirmPlan(ctx))) {
    ui.warn('Stopped before changing anything. Your answers are saved for next time.');
    return;
  }

  const sm = config.semanticModel;
  const withModel = !!sm.enabled;
  const withApp = withModel && !!config.fabricApp.enabled;
  const titles = [
    'Key Vault',
    'App registration',
    'Microsoft Graph permissions',
    'Workspace and Lakehouse',
    ...(withModel ? ['Semantic model'] : []),
    'Notebooks, pipeline and schedule',
    ...(withApp ? ['ValueLens app'] : []),
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
  step('Notebooks, pipeline and schedule');
  await ensureNotebooks(ctx);
  await ensurePipeline(ctx);
  await ensureSchedule(ctx);
  if (withApp) {
    step('ValueLens app');
    await tryDeployApp(ctx);
  }

  if (ctx.runFirstLoad) {
    step('First load');
    if (!consented) {
      ui.warn(`Skipped until admin consent is granted. Then run: valuelens-install run --backfill-days ${config.history.days}`);
    } else if (!vaultReachable) {
      ui.warn(`Skipped until the private endpoint to ${config.keyVault.name} is approved. Then run: valuelens-install run --backfill-days ${config.history.days}`);
    } else {
      if (modelDeployed(config)) ui.note(`The pipeline refreshes ${sm.name} as its last step.`);
      const result = await runPipeline(ctx, { backfillDays: config.history.days, wait: opts.wait, first: true });
      if (result.ok) await runDataCheck(ctx);
    }
  } else if (withModel) {
    step('Model refresh');
    if (modelDeployed(config)) await refreshModel(ctx, { wait: opts.wait });
    else ui.warn(`Skipped: ${sm.name} isn't connected to the Lakehouse yet.`);
  }
  await summary(ctx);
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
    ctx.ui.info('Fix the problem, then run "valuelens-install deploy-app".');
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
  ui.heading('Updating ValueLens');
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
  await ensureNotebooks(ctx, { force: true });
  await ensurePipeline(ctx, { force: true });
  await ensureSchedule(ctx);
  if (sm.enabled && config.fabricApp.enabled && (await ui.confirm('Rebuild and redeploy the ValueLens app too?', true))) await tryDeployApp(ctx, { force: true });
  if (modelDeployed(config)) {
    ui.note('Updating the model clears its data, so it refreshes now.');
    await refreshModel(ctx, { wait: opts.wait ?? true });
  }
  ui.ok('Up to date. The next scheduled run uses the new versions.');
}

/**
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number, wait: boolean }} opts
 */
export async function run(ctx, opts) {
  const result = await runPipeline(ctx, opts);
  if (result.ok) await runDataCheck(ctx);
  return result;
}

export { status };

/**
 * Refreshes the semantic model now.
 * @param {Ctx} ctx
 * @param {{ wait: boolean }} opts
 */
export async function refresh(ctx, opts) {
  if (!ctx.config.semanticModel.id) throw new Error('There is no semantic model yet. Run the installer and choose to deploy it.');
  return refreshModel(ctx, opts);
}

/**
 * Builds and deploys the ValueLens app on its own.
 * @param {Ctx} ctx
 */
export async function deployAppNow(ctx) {
  const { config, ui } = ctx;
  if (!modelDeployed(config)) throw new Error('The app needs the semantic model. Run the installer and choose "Semantic model and the ValueLens app".');
  ui.heading('Deploying the ValueLens app');
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

  ui.heading('ValueLens is set up');
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
  ui.note('   See "Refresh Power BI from the pipeline" in 3. Fabric/pipelines/README.md.');
  ui.info('3. Scheduled runs read the Key Vault secret as you, the schedule\'s owner. Anyone who edits the');
  ui.info('   pipeline or takes over the schedule needs "get" on the secret first.');
  ui.info(`4. Keep ${c.bold('valuelens-install.json')}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
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
    },
    user: { tenantId: config.tenantId ?? fake(0) },
  });

  mkdirSync(join(out, 'notebooks'), { recursive: true });
  let n = 10;
  for (const nb of notebooksFor(config.modules, { semanticModel: withModel })) {
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
  });
  writeFileSync(join(out, 'pipeline-content.json'), `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');
  writeFileSync(join(out, 'schedule.json'), `${JSON.stringify(scheduleBody(config.schedule, o.now), null, 2)}\n`, 'utf8');
  writeFileSync(
    join(out, 'graph-permissions.txt'),
    `Microsoft Graph application permissions for the app registration:\n${permissionsFor(config.modules).map((p) => `  ${p}\n`).join('')}`,
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

  ui.heading('Preview written');
  ui.info(out);
  ui.note(`Notebooks, pipeline-content.json, schedule.json${withModel ? ', model.bim' : ''} and graph-permissions.txt, with placeholder IDs where none are known yet.`);
}
