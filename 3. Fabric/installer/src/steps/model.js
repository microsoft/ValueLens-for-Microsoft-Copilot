// @ts-check
/**
 * The ValueLens semantic model: deployed from the Power BI template, connected to the
 * Lakehouse through a cloud connection that signs in as the app registration, and refreshed.
 */
import { enabledModules, MODEL_MODULES } from '../catalog.js';
import { servicePrincipalCredentials, semanticModelDefinition, sqlConnectionBody } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { buildModel, datasourcePath, loadTemplateModel, PBISM } from '../transform/model.js';
import { formatDuration } from '../ui.js';
import { byName, createdId } from './fabric.js';
import { addMonths, SECRET_LIFETIME_MONTHS } from './identity.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/** Name of the app secret that only the model's connection holds. */
export const CONNECTION_SECRET_NAME = 'ValueLens semantic model connection';

/** @param {string} workspaceId */
export const connectionName = (workspaceId) => `ValueLens SQL ${workspaceId.slice(0, 8)}`;

/** @param {string} workspaceId @param {string} modelId */
export const modelSettingsUrl = (workspaceId, modelId) => `https://app.powerbi.com/groups/${workspaceId}/settings/datasets/${modelId}`;

/** @param {string} workspaceId @param {string} modelId */
export const modelUrl = (workspaceId, modelId) => `https://app.powerbi.com/groups/${workspaceId}/datasets/${modelId}/details`;

export const ENDPOINT_POLL_MS = 15_000;
export const CONNECTION_RETRY_MS = 30_000;
const CONNECTION_ATTEMPTS = 10;
export const REFRESH_POLL_MS = 20_000;

/** Refresh states after which Power BI does no more work. */
export const REFRESH_FINAL = new Set(['Completed', 'Failed', 'Cancelled', 'Disabled', 'TimedOut']);

/**
 * The model's Lakehouse SQL analytics endpoint. A new Lakehouse takes a minute or two to get one.
 * @param {Ctx} ctx
 * @returns {Promise<{ server: string, database: string }>}
 */
export async function waitForSqlEndpoint(ctx) {
  const f = ctx.config.fabric;
  const ws = /** @type {string} */ (f.workspaceId);
  for (let i = 0; ; i++) {
    const lh = await ctx.api.fabric.getLakehouse(ws, /** @type {string} */ (f.lakehouseId));
    const sql = lh?.properties?.sqlEndpointProperties;
    if (sql?.connectionString && (!sql.provisioningStatus || sql.provisioningStatus === 'Success')) {
      return { server: sql.connectionString, database: lh.displayName };
    }
    if (sql?.provisioningStatus === 'Failed') throw new Error(`The Lakehouse's SQL analytics endpoint failed to provision. Open ${lh.displayName} in Fabric to retry it.`);
    if (i === 40) throw new Error('The Lakehouse\'s SQL analytics endpoint wasn\'t ready after 10 minutes. Run the installer again later.');
    if (i === 0) ctx.ui.info('Waiting for the Lakehouse\'s SQL analytics endpoint.');
    await ctx.sleep(ENDPOINT_POLL_MS);
  }
}

/**
 * What the model definition is built from.
 * @param {string} server
 * @param {string} database
 * @param {import('../catalog.js').ModuleChoice} modules
 */
export const modelSignature = (server, database, modules) =>
  `${server.toLowerCase()};${database};${enabledModules(modules).filter((m) => /** @type {readonly string[]} */ (MODEL_MODULES).includes(m)).join(',')}`;

/**
 * Creates a semantic model item, or updates it when its inputs changed or `force` is set.
 * An update clears the model's data and its connection binding.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 * @param {{ signature: string, definition: () => any, force?: boolean }} o
 */
export async function deployModel(ctx, m, o) {
  const { ui, api } = ctx;
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  const items = await api.fabric.listItems(ws, 'SemanticModel');

  if (m.id && !items.some((i) => i.id === m.id)) {
    ui.warn(`${m.name} was deleted. Deploying it again.`);
    delete m.id;
  }
  if (!m.id) {
    const same = byName(items, m.name);
    if (same) {
      const replace = await ui.confirm(`A semantic model called ${m.name} is already in the workspace. Replace it with the ValueLens version?`, true);
      if (!replace) throw new Error(`Stopped: ${m.name} already exists. Rename or remove it, or choose another workspace.`);
      await api.fabric.updateSemanticModel(ws, same.id, o.definition());
      m.id = same.id;
      ui.ok(`Updated semantic model ${m.name}`);
    } else {
      const created = await api.fabric.createSemanticModel(ws, m.name, o.definition());
      m.id = await createdId(ctx, created, 'SemanticModel', m.name);
      ui.ok(`Created semantic model ${m.name}`);
    }
    m.bound = false;
  } else if (o.force || m.signature !== o.signature) {
    await api.fabric.updateSemanticModel(ws, m.id, o.definition());
    m.bound = false;
    ui.ok(`Updated semantic model ${m.name}`);
  } else {
    ui.ok(`Semantic model ${m.name} is in place`);
  }
  m.signature = o.signature;
  ctx.save();
}

/**
 * Creates the semantic model, or updates it when its inputs changed or `force` is set.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureSemanticModel(ctx, opts = {}) {
  const { config, sources } = ctx;
  const sm = config.semanticModel;
  if (!sources.modelFile) throw new Error('This checkout has no "ValueLens - Fabric.pbit" to build the semantic model from.');

  const { server, database } = await waitForSqlEndpoint(ctx);
  await deployModel(ctx, sm, {
    signature: modelSignature(server, database, config.modules),
    definition: () => semanticModelDefinition(buildModel(loadTemplateModel(/** @type {string} */ (sources.modelFile)), { server, database, modules: config.modules }), PBISM),
    force: opts.force,
  });
  Object.assign(sm, { server, database });
  ctx.save();
}

/** @param {unknown} err */
const status = (err) => (err instanceof HttpError ? err.status : 0);

/**
 * A secret for the connection: a new one on the app, or one the user pastes when they can't add one.
 * @param {Ctx} ctx
 * @returns {Promise<{ value: string, keyId?: string, expires?: string }>}
 */
async function connectionSecret(ctx) {
  const { ui, config, api } = ctx;
  const app = config.app;
  try {
    const cred = await api.graph.addPassword(/** @type {string} */ (app.objectId), addMonths(ctx.now(), SECRET_LIFETIME_MONTHS), CONNECTION_SECRET_NAME);
    return { value: cred.secretText, keyId: cred.keyId, expires: cred.endDateTime };
  } catch (err) {
    if (status(err) !== 403) throw err;
  }
  ui.warn(`You can't add a client secret to ${app.displayName ?? app.appId}, and the model's connection needs one.`);
  return { value: await ui.secret(`A client secret for ${app.displayName ?? app.appId}. It is kept only in the Fabric connection.`) };
}

/** @param {Ctx} ctx @param {string} clientSecret */
const credentialsFor = (ctx, clientSecret) => ({
  tenantId: ctx.user.tenantId,
  clientId: /** @type {string} */ (ctx.config.app.appId),
  clientSecret,
});

/**
 * Gives the app's service principal Viewer on the workspace, so it can read the Lakehouse.
 * @param {Ctx} ctx
 */
async function ensureViewer(ctx) {
  const { ui, config, api } = ctx;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const spId = /** @type {string} */ (config.app.servicePrincipalId);
  const roles = await api.fabric.listRoleAssignments(ws);
  if (roles.some((r) => String(r.principal?.id ?? r.id).toLowerCase() === spId.toLowerCase())) return;
  await api.fabric.addRoleAssignment(ws, spId, 'ServicePrincipal', 'Viewer');
  ui.ok(`Gave ${config.app.displayName ?? 'the app'} Viewer on the workspace, so the model can read the Lakehouse`);
}

/**
 * Creates the connection. Fabric tests it first, and a new secret or role takes a few minutes to work.
 * @param {Ctx} ctx
 * @param {any} body
 */
async function createConnection(ctx, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.api.fabric.createConnection(body);
    } catch (err) {
      const s = status(err);
      if (s === 409 || s === 404 || s < 400 || s >= 500 || attempt === CONNECTION_ATTEMPTS) throw err;
      if (attempt === 1) ctx.ui.info('Waiting for the new secret and workspace access to take effect.');
      await ctx.sleep(CONNECTION_RETRY_MS);
    }
  }
}

/**
 * Makes sure the model reads the Lakehouse through a connection that signs in as the app.
 * @param {Ctx} ctx
 */
export async function ensureModelConnection(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  await ensureViewer(ctx);

  /** @type {any} */
  let conn = sm.connectionId ? await api.fabric.getConnection(sm.connectionId).catch((err) => (status(err) === 404 ? null : Promise.reject(err))) : null;
  if (sm.connectionId && !conn) {
    ui.warn(`The connection ${sm.connectionName ?? sm.connectionId} was deleted. Creating it again.`);
    delete sm.connectionId;
    sm.bound = false;
  }
  if (!conn) {
    const name = connectionName(ws);
    const secret = await connectionSecret(ctx);
    const credentials = credentialsFor(ctx, secret.value);
    try {
      const existing = (await api.fabric.listConnections()).find((c) => c.displayName === name);
      if (existing) {
        await api.fabric.updateConnection(existing.id, { connectivityType: 'ShareableCloud', credentialDetails: servicePrincipalCredentials(credentials) });
        conn = existing;
        ui.ok(`Updated the connection "${name}" to sign in as ${config.app.displayName ?? 'the app'}`);
      } else {
        const body = sqlConnectionBody({ displayName: name, server: /** @type {string} */ (sm.server), database: /** @type {string} */ (sm.database), ...credentials });
        conn = await createConnection(ctx, body);
        ui.ok(`Created the connection "${name}", signed in as ${config.app.displayName ?? 'the app'}`);
      }
    } catch (err) {
      if (secret.keyId) await api.graph.removePassword(/** @type {string} */ (config.app.objectId), secret.keyId).catch(() => {});
      throw new Error(`Fabric couldn't set up the model's connection: ${/** @type {Error} */ (err).message}`);
    }
    const oldKey = sm.secretKeyId;
    Object.assign(sm, { connectionId: conn.id, connectionName: name, secretKeyId: secret.keyId, secretExpires: secret.expires, bound: false });
    if (config.consumption?.model) config.consumption.model.bound = false;
    ctx.save();
    if (oldKey && oldKey !== secret.keyId) await api.graph.removePassword(/** @type {string} */ (config.app.objectId), oldKey).catch(() => {});
  }

  if (!sm.bound) await bindModel(ctx, sm);
}

/**
 * Points a model's SQL data source at the installer's connection.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 */
export async function bindModel(ctx, m) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const id = /** @type {string} */ (m.id);
  const sources = await api.powerBi.datasources(ws, id).catch(() => []);
  const sql = sources.find((d) => String(d.datasourceType).toLowerCase() === 'sql')?.connectionDetails;
  const path = sql?.server && sql?.database ? datasourcePath(sql.server, sql.database) : datasourcePath(/** @type {string} */ (sm.server), /** @type {string} */ (sm.database));
  for (;;) {
    try {
      await api.fabric.bindConnection(ws, id, { id: /** @type {string} */ (sm.connectionId), type: 'SQL', path });
      m.bound = true;
      ctx.save();
      ui.ok(`${m.name} reads the Lakehouse through "${sm.connectionName}"`);
      return true;
    } catch (err) {
      ui.warn(`Couldn't connect ${m.name} to "${sm.connectionName}" (${/** @type {Error} */ (err).message}).`);
      ui.info(`Choose it under "Gateway and cloud connections" in the model's settings: ${modelSettingsUrl(ws, id)}`);
      if (ui.yes) return false;
      const next = await ui.select(
        'Then:',
        [
          { name: 'Try again', value: 'retry' },
          { name: 'I\'ve connected it myself', value: 'done' },
          { name: 'Skip for now (the model won\'t refresh)', value: 'skip' },
        ],
        'retry',
      );
      if (next === 'skip') return false;
      if (next === 'done') {
        m.bound = true;
        ctx.save();
        return true;
      }
    }
  }
}

/**
 * Starts a refresh, or follows one that is already running.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} m
 * @returns {Promise<string>}
 */
async function startRefresh(ctx, m) {
  const { api, config } = ctx;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  const id = /** @type {string} */ (m.id);
  try {
    return await api.powerBi.refresh(ws, id, { type: 'full', commitMode: 'transactional', applyRefreshPolicy: true, retryCount: 1 });
  } catch (err) {
    const busy = status(err) === 409 || /in progress/i.test(/** @type {Error} */ (err).message);
    if (!busy) throw err;
    const running = (await api.powerBi.refreshes(ws, id, 1))[0];
    if (!running?.requestId) throw err;
    ctx.ui.note('A refresh is already running, so following that one.');
    return running.requestId;
  }
}

/**
 * Refreshes a model, the ValueLens one unless `model` says otherwise.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, timeoutMs?: number, model?: import('../config.js').ModelConfig }} [opts]
 * @returns {Promise<{ ok: boolean, status?: string }>}
 */
export async function refreshModel(ctx, opts = {}) {
  const { ui, config, api } = ctx;
  const sm = opts.model ?? config.semanticModel;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  if (!sm.id) throw new Error('There is no semantic model yet. Run the installer first.');
  if (!sm.bound) {
    ui.warn(`${sm.name} isn't connected to the Lakehouse yet, so it can't refresh. Run the installer again to connect it.`);
    return { ok: false };
  }
  const requestId = await startRefresh(ctx, sm);
  ui.ok(`Started a refresh of ${sm.name}`);
  if (opts.wait === false) return { ok: true, status: 'Unknown' };

  const progress = ui.progress('Refresh');
  const deadline = Date.now() + (opts.timeoutMs ?? 2 * 3_600_000);
  /** @type {any} */
  let r;
  let took = 0;
  try {
    for (;;) {
      r = await api.powerBi.getRefresh(ws, sm.id, requestId).catch((err) => (status(err) === 404 ? null : Promise.reject(err)));
      const state = r?.extendedStatus ?? r?.status ?? 'NotStarted';
      progress.update(state);
      if (REFRESH_FINAL.has(state) || Date.now() > deadline) break;
      await ctx.sleep(REFRESH_POLL_MS);
    }
  } finally {
    took = progress.done();
  }
  const state = r?.extendedStatus ?? r?.status;
  if (state === 'Completed') {
    ui.ok(`${sm.name} refreshed in ${formatDuration(took)}`);
    return { ok: true, status: state };
  }
  if (REFRESH_FINAL.has(state)) {
    ui.fail(`The refresh ended as ${state}`);
    for (const m of (r?.messages ?? []).slice(0, 3)) ui.info(String(m.message ?? m).slice(0, 600));
    if (r?.serviceExceptionJson) ui.info(String(r.serviceExceptionJson).slice(0, 600));
    return { ok: false, status: state };
  }
  ui.warn('The refresh is still running. Check later with "valuelens-install status".');
  return { ok: false, status: state };
}

/**
 * Last few refreshes, newest first.
 * @param {Ctx} ctx
 * @param {import('../config.js').ModelConfig} [m]
 */
export async function modelRefreshes(ctx, m = ctx.config.semanticModel) {
  if (!m.id) return [];
  return ctx.api.powerBi.refreshes(/** @type {string} */ (ctx.config.fabric.workspaceId), m.id, 3);
}

/**
 * Gives the connection a new secret and removes the old one from the app.
 * @param {Ctx} ctx
 */
export async function rotateModelSecret(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const objectId = /** @type {string} */ (config.app.objectId);
  if (!sm.connectionId) return;
  const secret = await connectionSecret(ctx);
  try {
    await api.fabric.updateConnection(sm.connectionId, {
      connectivityType: 'ShareableCloud',
      credentialDetails: servicePrincipalCredentials(credentialsFor(ctx, secret.value)),
    });
  } catch (err) {
    if (secret.keyId) await api.graph.removePassword(objectId, secret.keyId).catch(() => {});
    throw new Error(`Fabric couldn't update the model's connection: ${/** @type {Error} */ (err).message}`);
  }
  const oldKey = sm.secretKeyId;
  Object.assign(sm, { secretKeyId: secret.keyId, secretExpires: secret.expires });
  ctx.save();
  ui.ok(`Gave "${sm.connectionName}" a new secret${secret.expires ? ` (expires ${secret.expires.slice(0, 10)})` : ''}`);
  if (oldKey && oldKey !== secret.keyId) {
    const removed = await api.graph.removePassword(objectId, oldKey).then(() => true, () => false);
    if (removed) ui.ok('Removed the connection\'s old secret from the app');
  }
}
