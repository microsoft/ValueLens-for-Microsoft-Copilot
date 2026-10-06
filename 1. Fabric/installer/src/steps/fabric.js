// @ts-check
/**
 * Workspace, Lakehouse, notebooks, pipeline and schedule. Re-runs reuse what the
 * install record points at; `update` pushes fresh notebook and pipeline content.
 */
import { createHash } from 'node:crypto';
import { enabledModules, notebooksFor } from '../catalog.js';
import { routedSources, routerSignaturesJson, routerWanted } from '../uploads.js';
import { parseResourceId } from '../clients/azure.js';
import { scheduleBody } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { MARKER, prepareNotebook, pyString, serialiseNotebook } from '../transform/notebook.js';
import { buildPipeline, PIPELINE_CHANGE, PIPELINE_VERSION } from '../transform/pipeline.js';

/** @typedef {import('../install.js').Ctx} Ctx */

export const PIPELINE_NAME = 'AnalyticsHub_Pipeline';

/** @param {unknown} err */
const isNotFound = (err) => err instanceof HttpError && (err.status === 404 || err.code === 'ItemNotFound' || err.code === 'WorkspaceNotFound');

/**
 * @param {any[]} items
 * @param {string} name
 */
export const byName = (items, name) => items.find((i) => String(i.displayName).toLowerCase() === name.toLowerCase());

/**
 * `name`, or the first free `name_2`, `name_3`… (a space instead of `_` when the name has spaces).
 * The installer never takes over an item it didn't create, so a clash gets a new name.
 * @param {string} name
 * @param {Iterable<string>} taken  Display names already in the workspace.
 */
export function freeName(name, taken) {
  const used = new Set([...taken].map((t) => String(t).toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const sep = /\s/.test(name) ? ' ' : '_';
  for (let n = 2; ; n++) {
    const candidate = `${name}${sep}${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** @param {any[]} items */
export const displayNames = (items) => items.map((i) => String(i.displayName));

/**
 * Says why an item has a different name from usual.
 * @param {Ctx} ctx
 * @param {string} wanted
 * @param {string} name
 */
export function noteRenamed(ctx, wanted, name) {
  if (name !== wanted) ctx.ui.note(`"${wanted}" is already in the workspace and isn't from this install, so it's left as it is. Analytics Hub's is called "${name}".`);
}

/**
 * A create can answer 201 with the item, or 202 and a result. If neither carries an ID, look it up by name.
 * @param {Ctx} ctx
 * @param {any} created
 * @param {string} type
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function createdId(ctx, created, type, name) {
  if (created?.id) return created.id;
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  const found = byName(await ctx.api.fabric.listItems(ws, type), name);
  if (!found) throw new Error(`Fabric reported that ${name} was created, but it isn't in the workspace.`);
  return found.id;
}

/** @param {Ctx} ctx */
export async function ensureWorkspace(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (f.workspaceId) {
    /** @type {any} */
    let ws;
    try {
      ws = await api.fabric.getWorkspace(f.workspaceId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      throw new Error(`Workspace ${f.workspaceName ?? f.workspaceId} no longer exists, or you can't see it. Remove "workspaceId" from the install record to create a new one.`);
    }
    f.workspaceName = ws.displayName;
    if (!ws.capacityId) {
      await api.fabric.assignToCapacity(ws.id, /** @type {string} */ (f.capacityId));
      ui.ok(`Workspace "${ws.displayName}", now on your Fabric capacity`);
    } else {
      if (f.capacityId && ws.capacityId.toLowerCase() !== f.capacityId.toLowerCase()) {
        ui.note(`"${ws.displayName}" is already on another capacity, so it stays there.`);
      }
      f.capacityId = ws.capacityId;
      ui.ok(`Workspace "${ws.displayName}"`);
    }
  } else {
    if (!f.workspaceName || !f.capacityId) throw new Error('Workspace settings are incomplete. Run the installer without --yes to choose them.');
    const ws = await api.fabric.createWorkspace(f.workspaceName, f.capacityId);
    f.workspaceId = ws.id;
    ui.ok(`Created workspace "${ws.displayName}"`);
  }
  ctx.save();
}

/** @param {Ctx} ctx */
export async function ensureLakehouse(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  if (f.lakehouseId) {
    try {
      const lh = await api.fabric.getLakehouse(ws, f.lakehouseId);
      f.lakehouseName = lh.displayName;
      ui.ok(`Lakehouse "${lh.displayName}"`);
      ctx.save();
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
      ui.warn('The Lakehouse in the install record is gone. Setting it up again.');
      delete f.lakehouseId;
    }
  }
  const wanted = f.lakehouseName ?? 'ValueLens';
  const name = freeName(wanted, displayNames(await api.fabric.listItems(ws, 'Lakehouse')));
  noteRenamed(ctx, wanted, name);
  const created = await api.fabric.createLakehouse(ws, name);
  f.lakehouseId = await createdId(ctx, created, 'Lakehouse', name);
  f.lakehouseName = name;
  ui.ok(`Created Lakehouse "${name}"`);
  ctx.save();
}

export const ENDPOINT_POLL_MS = 15_000;
const ENDPOINT_MAX_POLLS = 80;

/** Fabric allows up to 64 characters. @param {string} vaultName */
export const endpointName = (vaultName) => `valuelens-${vaultName}`.slice(0, 64);

/**
 * Shown to whoever approves the request on the vault. It carries the workspace ID so
 * the installer can tell its own request from others.
 * @param {string} workspaceId
 */
export const endpointRequest = (workspaceId) => `Analytics Hub: Fabric workspace ${workspaceId} reads the app secret.`;

/**
 * Whether a private endpoint connection on the vault comes from this workspace. Fabric names
 * the endpoint "<workspace ID>.<endpoint name>", and the description carries the workspace ID.
 * The endpoint name alone is the same for every workspace that reads the vault.
 * @param {any} conn
 * @param {string} workspaceId
 */
export const fromWorkspace = (conn, workspaceId) =>
  [conn.name, conn.properties?.privateEndpoint?.id, conn.properties?.privateLinkServiceConnectionState?.description].some((s) =>
    String(s ?? '').toLowerCase().includes(workspaceId.toLowerCase()),
  );

/** @param {string | undefined} a @param {string | undefined} b */
const sameResource = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Polls a managed private endpoint until `done`, for up to 20 minutes.
 * @param {Ctx} ctx
 * @param {any} endpoint
 * @param {(e: any) => boolean} done
 * @param {string} waiting  e.g. "Fabric is provisioning the private endpoint"
 */
async function pollEndpoint(ctx, endpoint, done, waiting) {
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  let e = endpoint;
  for (let i = 0; !done(e); i++) {
    if (i === ENDPOINT_MAX_POLLS) throw new Error(`${waiting} for more than 20 minutes. Run the installer again later to carry on.`);
    if (i === 0) ctx.ui.info(`${waiting}. This usually takes a few minutes.`);
    await ctx.sleep(ENDPOINT_POLL_MS);
    e = await ctx.api.fabric.getPrivateEndpoint(ws, e.id);
  }
  return e;
}

/**
 * Approves the workspace's request on the vault. Returns true once the vault shows it
 * approved, false if the request hasn't arrived or the user may not approve it.
 * @param {Ctx} ctx
 */
async function approveOnVault(ctx) {
  const { ui, api, config } = ctx;
  const kv = config.keyVault;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  for (let i = 0; i < 8; i++) {
    const mine = (await api.arm.listPrivateEndpointConnections(/** @type {string} */ (kv.id))).filter((conn) => fromWorkspace(conn, ws));
    if (mine.some((conn) => conn.properties?.privateLinkServiceConnectionState?.status === 'Approved')) return true;
    const pending = mine.filter((conn) => conn.properties?.privateLinkServiceConnectionState?.status === 'Pending');
    if (pending.length) {
      try {
        for (const conn of pending) await api.arm.approvePrivateEndpointConnection(conn.id, `Approved by the Analytics Hub installer for Fabric workspace ${ws}.`);
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return false;
        throw err;
      }
      ui.ok(`Approved the workspace's private endpoint on ${kv.name}`);
      return true;
    }
    await ctx.sleep(ENDPOINT_POLL_MS);
  }
  return false;
}

/**
 * Fabric can only read a vault that blocks public access through a managed private
 * endpoint. Creates one from the workspace, approves it on the vault, and waits until
 * notebooks can use it. Returns false if it isn't approved yet.
 * @param {Ctx} ctx
 */
export async function ensureVaultEndpoint(ctx) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  const f = config.fabric;
  if (!kv.private) return true;
  const ws = /** @type {string} */ (f.workspaceId);
  const vaultId = /** @type {string} */ (kv.id);

  let endpoint = (await api.fabric.listPrivateEndpoints(ws)).find((e) => sameResource(e.targetPrivateLinkResourceId, vaultId));
  if (!endpoint) {
    const { subscriptionId } = parseResourceId(vaultId);
    if (await api.arm.ensureProvider(subscriptionId, 'Microsoft.Network')) ui.ok('Registered the Microsoft.Network resource provider');
    try {
      endpoint = await api.fabric.createPrivateEndpoint(ws, {
        name: endpointName(/** @type {string} */ (kv.name)),
        targetPrivateLinkResourceId: vaultId,
        targetSubresourceType: 'vault',
        requestMessage: endpointRequest(ws),
      });
    } catch (err) {
      throw new Error(
        `Fabric couldn't create a managed private endpoint to ${kv.name} (${/** @type {Error} */ (err).message}). ` +
          'They need an F or trial capacity in a region where Fabric Data Engineering runs.',
      );
    }
    ui.ok(`Created a managed private endpoint from the workspace to ${kv.name}`);
  }
  f.vaultEndpointId = endpoint.id;
  ctx.save();

  endpoint = await pollEndpoint(ctx, endpoint, (e) => !['Provisioning', 'Updating'].includes(e.provisioningState), 'Fabric is provisioning the private endpoint');
  if (endpoint.provisioningState === 'Failed') {
    throw new Error(`The managed private endpoint to ${kv.name} failed to provision. Delete it under the workspace's Network security settings, then run the installer again.`);
  }

  for (;;) {
    const status = endpoint.connectionState?.status;
    if (status === 'Approved') {
      ui.ok(`The workspace reaches ${kv.name} through a managed private endpoint`);
      return true;
    }
    if (status === 'Rejected' || status === 'Disconnected') {
      throw new Error(`The private endpoint to ${kv.name} was ${status.toLowerCase()}. Delete it under the workspace's Network security settings, then run the installer again.`);
    }
    if (await approveOnVault(ctx)) {
      endpoint = await pollEndpoint(ctx, endpoint, (e) => e.connectionState?.status !== 'Pending', 'Waiting for Fabric to see the approval');
      continue;
    }
    ui.warn(`The workspace's private endpoint request is waiting for approval on ${kv.name}.`);
    ui.info('Someone who manages the vault can approve it under Networking, Private endpoint connections:');
    ui.info(`https://portal.azure.com/#@${ctx.user.tenantId}/resource${vaultId}/networking`);
    if (ui.yes) {
      ui.warn('Carrying on. Data loads will fail until it is approved.');
      return false;
    }
    const next = await ui.select(
      'Once it is approved:',
      [
        { name: 'Check again', value: 'check' },
        { name: 'Carry on without it (skip the first load for now)', value: 'skip' },
      ],
      'check',
    );
    if (next === 'skip') return false;
    endpoint = await api.fabric.getPrivateEndpoint(ws, endpoint.id);
  }
}

/**
 * What the installer changes in one notebook.
 * @param {Ctx} ctx
 * @param {import('../catalog.js').NotebookInfo} nb
 * @returns {import('../transform/notebook.js').NotebookSettings}
 */
export function notebookSettings(ctx, nb) {
  const { config, user } = ctx;
  const f = config.fabric;
  /** @type {Record<string, string> | undefined} */
  let values = nb.values;
  if (nb.key === 'refreshModel') values = { WORKSPACE_ID: /** @type {string} */ (f.workspaceId), SEMANTIC_MODEL_ID: /** @type {string} */ (config.semanticModel.id) };
  if (nb.key === 'azureAi') {
    values = {
      SUBSCRIPTION_ID: /** @type {string} */ (config.consumption.azureSubscriptionId),
      TENANT_ID: user.tenantId,
      CLIENT_ID: /** @type {string} */ (config.app.appId),
      KEY_VAULT_URL: /** @type {string} */ (config.keyVault.uri),
      CLIENT_SECRET_NAME: config.keyVault.secretName,
    };
  }
  // Merge upserts each run's window, so environments and days accumulate without duplicates.
  if (nb.key === 'agentTranscripts') values = { SOURCE_MODE: 'dataverse', WRITE_MODE: 'merge', RAW_TABLE: '' };
  if (nb.key === 'uploadRouter') values = routerValues(config);
  return {
    ...(nb.credentials
      ? {
          tenantId: user.tenantId,
          clientId: config.app.appId,
          secret: { vaultUri: /** @type {string} */ (config.keyVault.uri), secretName: config.keyVault.secretName },
        }
      : {}),
    parameters: nb.parameters,
    ...(values ? { values } : {}),
    ...(nb.expressions ? { expressions: nb.expressions } : {}),
    patches:
      nb.key === 'agentTranscripts'
        ? [...(nb.patches ?? []), environmentsPatch(config.agentEvaluator.environments)]
        : nb.key === 'azureAi' && paygReadable(config).length
          ? [...(nb.patches ?? []), paygPatch(paygReadable(config))]
          : nb.patches,
    lakehouse: {
      id: /** @type {string} */ (f.lakehouseId),
      name: /** @type {string} */ (f.lakehouseName),
      workspaceId: /** @type {string} */ (f.workspaceId),
    },
    dataCheckSummary: nb.key === 'dataCheck',
  };
}

/** The transcript parser's environment list, as it ships. */
export const ENVIRONMENTS_FIND = "DATAVERSE_URLS = [\n    # 'https://org1.crm.dynamics.com',\n    # 'https://org2.crm.dynamics.com',\n]";

/**
 * What the upload router accepts: the sources that aren't skipped, and their header signatures.
 * @param {import('../config.js').InstallConfig} config
 */
export const routerValues = (config) => ({
  ENABLED_SOURCES: routedSources(config.dataSources).join(','),
  SIGNATURES_JSON: routerSignaturesJson(config.dataSources),
});

/**
 * What the deployed router was built from. A change means it has to be updated.
 * @param {import('../config.js').InstallConfig} config
 */
export const routerSignature = (config) => createHash('sha256').update(routerSignaturesJson(config.dataSources)).digest('hex').slice(0, 16);

/**
 * Notebook options that follow the chosen sources.
 * @param {import('../config.js').InstallConfig} config
 */
export const notebookOptions = (config) => ({
  semanticModel: modelDeployed(config),
  azureAi: azureAiOn(config),
  dataverse: agentEvaluatorOn(config),
  dataSources: config.dataSources,
});

/** The Azure AI notebook's extra pay-as-you-go subscriptions, as it ships. */
export const PAYG_FIND = 'PAYG_SUBSCRIPTION_IDS = []';

/**
 * The other subscriptions whose Copilot pay-as-you-go the app can read.
 * @param {import('../config.js').InstallConfig} config
 */
export const paygReadable = (config) => (config.consumption?.paygSubscriptions ?? []).filter((p) => p.access);

/**
 * The pay-as-you-go subscriptions in the Azure AI notebook, as stored with the deployed notebook.
 * @param {import('../config.js').InstallConfig} config
 */
export const paygIds = (config) => paygReadable(config).map((p) => p.subscriptionId).join(',');

/**
 * @param {import('../config.js').PaygSubscription[]} subs
 * @returns {import('../catalog.js').NotebookPatch}
 */
export function paygPatch(subs) {
  const lines = subs.map((s) => `    ${pyString(s.subscriptionId)},${s.name ? `  # ${s.name.replace(/[\r\n]+/g, ' ')}` : ''}`);
  return { find: PAYG_FIND, replace: ['PAYG_SUBSCRIPTION_IDS = [  # ' + MARKER, ...lines, ']'].join('\n') };
}

/**
 * Lists every chosen environment, including those still waiting for access: the parser skips
 * those, then reads them once an admin adds the app.
 * @param {import('../config.js').AgentEnvironment[]} environments
 * @returns {import('../catalog.js').NotebookPatch}
 */
export function environmentsPatch(environments) {
  const lines = environments.map((e) => `    ${pyString(e.url)},${e.name ? `  # ${e.name.replace(/[\r\n]+/g, ' ')}` : ''}`);
  return { find: ENVIRONMENTS_FIND, replace: ['DATAVERSE_URLS = [  # ' + MARKER, ...lines, ']'].join('\n') };
}

/**
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]  `force` pushes fresh content to notebooks that already exist.
 */
export async function ensureNotebooks(ctx, opts = {}) {
  const { ui, config, api, sources } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const items = await api.fabric.listItems(ws, 'Notebook');
  const ids = new Set(items.map((i) => i.id));

  for (const nb of notebooksFor(config.modules, notebookOptions(config))) {
    const content = serialiseNotebook(prepareNotebook(sources.notebooks[nb.key], notebookSettings(ctx, nb)));
    const urls = nb.key === 'agentTranscripts' ? environmentUrls(config) : undefined;
    const payg = nb.key === 'azureAi' ? paygIds(config) : undefined;
    const routed = nb.key === 'uploadRouter' ? routerSignature(config) : undefined;
    f.notebookNames ??= {};
    let id = f.notebooks[nb.key];
    // Older records saved only the ID: keep the name the notebook already has.
    const current = id ? items.find((i) => i.id === id)?.displayName : undefined;
    if (current && !f.notebookNames[nb.key]) f.notebookNames[nb.key] = current;
    const label = f.notebookNames[nb.key] ?? nb.displayName;
    if (id && !ids.has(id)) {
      ui.warn(`${label} was deleted. Deploying it again.`);
      id = undefined;
      // The pipeline calls notebooks by ID, so it has to be rewritten for the new one.
      delete f.pipelineModules;
    }
    if (!id) {
      const name = freeName(label, displayNames(items));
      noteRenamed(ctx, label, name);
      const created = await api.fabric.createNotebook(ws, name, content);
      id = await createdId(ctx, created, 'Notebook', name);
      items.push({ id, displayName: name });
      f.notebookNames[nb.key] = name;
      ui.ok(`Created ${name}`);
    } else if (
      opts.force ||
      (urls !== undefined && urls !== config.agentEvaluator.deployedUrls) ||
      (payg !== undefined && payg !== (config.consumption.deployedPayg ?? '')) ||
      (routed !== undefined && routed !== f.deployedRouter)
    ) {
      await api.fabric.updateNotebook(ws, id, content);
      ui.ok(`Updated ${label}`);
    } else {
      ui.ok(`${label} is in place`);
    }
    f.notebooks[nb.key] = id;
    if (urls !== undefined) config.agentEvaluator.deployedUrls = urls;
    if (payg !== undefined) config.consumption.deployedPayg = payg;
    if (routed !== undefined) f.deployedRouter = routed;
    ctx.save();
  }
}

/**
 * The environments the transcript notebook reads, as stored with the deployed notebook.
 * @param {import('../config.js').InstallConfig} config
 */
export const environmentUrls = (config) => config.agentEvaluator.environments.map((e) => e.url).join(',');

/**
 * What the pipeline definition is built from. A change means the deployed pipeline is out of date.
 * @param {import('../config.js').InstallConfig} config
 */
export function pipelineSignature(config) {
  const parts = [enabledModules(config.modules).join(',')];
  if (modelDeployed(config)) parts.push(`model=${config.semanticModel.id}`);
  if (azureAiOn(config)) parts.push('azureAi');
  if (consumptionModelDeployed(config)) parts.push(`consumption=${config.consumption.model.id}`);
  if (agentEvaluatorOn(config)) parts.push('agentEvaluator');
  if (agentEvaluatorModelDeployed(config)) parts.push(`ae=${config.agentEvaluator.model.id}`);
  if (routerWanted(config.dataSources)) parts.push('router');
  if (workdayOn(config)) parts.push('workday');
  if (agent365Csv(config)) parts.push('agent365=csv');
  if (coworkDataflowOn(config)) parts.push(`cowork=${config.consumption.dataflowId}`);
  return parts.join(';');
}

/**
 * Cowork credits come from the Viva Insights Dataflow, so the pipeline refreshes it before the Viva load.
 * @param {import('../config.js').InstallConfig} config
 */
export const coworkDataflowOn = (config) => !!(config.modules.consumption && config.dataSources?.coworkCredits === 'api' && config.consumption?.dataflowId);

/**
 * Workday org data is uploaded, so its lander runs after the Entra ID load.
 * @param {import('../config.js').InstallConfig} config
 */
export const workdayOn = (config) => config.dataSources?.workday === 'csv';

/**
 * Agent 365 comes from its admin center export rather than the registry API.
 * @param {import('../config.js').InstallConfig} config
 */
export const agent365Csv = (config) => !!(config.modules.agent365 && config.dataSources?.agent365 === 'csv');

/**
 * The semantic model is switched on, exists and reads the Lakehouse, so the pipeline can refresh it.
 * @param {import('../config.js').InstallConfig} config
 */
export const modelDeployed = (config) => !!(config.semanticModel?.enabled && config.semanticModel.id && config.semanticModel.bound);

/**
 * Credit consumption is on, and the app can read Azure AI costs in the chosen subscription.
 * @param {import('../config.js').InstallConfig} config
 */
export const azureAiOn = (config) => !!(config.modules.consumption && config.consumption?.azureSubscriptionId && config.consumption.azureAccess);

/**
 * The consumption model exists and reads the Lakehouse. It is refreshed by the same notebook as the ValueLens model.
 * @param {import('../config.js').InstallConfig} config
 */
export const consumptionModelDeployed = (config) => !!(config.modules.consumption && modelDeployed(config) && config.consumption?.model?.id && config.consumption.model.bound);

/**
 * The transcript notebook is deployed: the Agent Evaluator is on and the app can read at least one
 * environment. The parser stops when it can reach none of them.
 * @param {import('../config.js').InstallConfig} config
 */
export const agentEvaluatorOn = (config) => !!(config.modules.agentEvaluator && config.agentEvaluator?.environments.some((e) => e.access));

/**
 * The Agent Evaluator model exists and reads the Lakehouse. The pipeline refreshes it after the transcripts load.
 * @param {import('../config.js').InstallConfig} config
 */
export const agentEvaluatorModelDeployed = (config) =>
  !!(config.modules.agentEvaluator && modelDeployed(config) && config.agentEvaluator?.model?.id && config.agentEvaluator.model.bound);

/**
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
export async function ensurePipeline(ctx, opts = {}) {
  const { ui, config, api, sources } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const definition = buildPipeline(sources.pipeline, {
    workspaceId: ws,
    notebookIds: f.notebooks,
    modules: config.modules,
    backfillDays: config.history.days,
    semanticModelId: modelDeployed(config) ? config.semanticModel.id : undefined,
    azureAi: azureAiOn(config),
    consumptionModelId: consumptionModelDeployed(config) ? config.consumption.model.id : undefined,
    agentTranscripts: agentEvaluatorOn(config),
    agentEvaluatorModelId: agentEvaluatorOn(config) && agentEvaluatorModelDeployed(config) ? config.agentEvaluator.model.id : undefined,
    uploadRouter: routerWanted(config.dataSources),
    workday: workdayOn(config),
    agent365Csv: agent365Csv(config),
    coworkDataflowId: coworkDataflowOn(config) ? config.consumption.dataflowId : undefined,
  });
  const signature = pipelineSignature(config);
  const items = await api.fabric.listItems(ws, 'DataPipeline');

  const current = f.pipelineId ? items.find((i) => i.id === f.pipelineId) : undefined;
  if (current && !f.pipelineName) f.pipelineName = current.displayName;
  if (f.pipelineId && !current) {
    ui.warn(`${f.pipelineName ?? PIPELINE_NAME} was deleted. Creating it again.`);
    delete f.pipelineId;
    delete f.scheduleId;
  }

  if (!f.pipelineId) {
    const wanted = f.pipelineName ?? PIPELINE_NAME;
    const name = freeName(wanted, displayNames(items));
    noteRenamed(ctx, wanted, name);
    const created = await api.fabric.createPipeline(ws, name, definition);
    f.pipelineId = await createdId(ctx, created, 'DataPipeline', name);
    ui.ok(`Created pipeline ${name}`);
    f.pipelineName = name;
  } else if (opts.force || f.pipelineModules !== signature || f.pipelineVersion !== PIPELINE_VERSION) {
    if (f.pipelineVersion !== PIPELINE_VERSION) ui.note(PIPELINE_CHANGE);
    ui.note('This replaces the pipeline definition, including any activities you added to it yourself.');
    if (await ui.confirm(`Update ${f.pipelineName ?? PIPELINE_NAME}?`, true)) {
      await api.fabric.updatePipeline(ws, f.pipelineId, definition);
      ui.ok(`Updated pipeline ${f.pipelineName ?? PIPELINE_NAME}`);
    } else {
      ui.warn('Left the pipeline as it was. New or removed modules won\'t run until it is updated.');
      return;
    }
  } else {
    ui.ok(`Pipeline ${f.pipelineName ?? PIPELINE_NAME} is in place`);
  }
  f.pipelineModules = signature;
  f.pipelineVersion = PIPELINE_VERSION;
  ctx.save();
}

/**
 * @param {any} existing  A schedule from the API.
 * @param {ReturnType<typeof scheduleBody>} wanted
 */
export function sameSchedule(existing, wanted) {
  const a = existing?.configuration ?? {};
  const b = wanted.configuration;
  const list = (/** @type {any} */ v) => JSON.stringify([...(v ?? [])].sort());
  return (
    existing?.enabled === true &&
    a.type === b.type &&
    a.localTimeZoneId === b.localTimeZoneId &&
    list(a.times) === list(b.times) &&
    (b.type !== 'Weekly' || list(a.weekdays) === list(b.weekdays))
  );
}

/** @param {import('../config.js').InstallConfig['schedule']} s */
export function describeSchedule(s) {
  return `${s.frequency === 'weekly' ? `every ${s.weekday}` : 'daily'} at ${s.time} ${s.timeZone}`;
}

/** @param {Ctx} ctx */
export async function ensureSchedule(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  const pipelineId = /** @type {string} */ (f.pipelineId);
  const wanted = scheduleBody(config.schedule, ctx.now());
  const schedules = await api.fabric.listSchedules(ws, pipelineId);
  const mine = schedules.find((s) => s.id === f.scheduleId);

  if (mine) {
    if (sameSchedule(mine, wanted)) {
      ui.ok(`Schedule: ${describeSchedule(config.schedule)}`);
      return;
    }
    await api.fabric.updateSchedule(ws, pipelineId, mine.id, wanted);
    ui.ok(`Updated the schedule: ${describeSchedule(config.schedule)}`);
    return;
  }
  if (schedules.length) {
    f.scheduleId = schedules[0].id;
    ctx.save();
    ui.note('The pipeline already has a schedule, so it was left as it is.');
    return;
  }
  const created = await api.fabric.createSchedule(ws, pipelineId, wanted);
  f.scheduleId = created?.id;
  ctx.save();
  ui.ok(`Scheduled ${describeSchedule(config.schedule)}`);
}
