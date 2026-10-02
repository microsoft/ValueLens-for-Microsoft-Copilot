// @ts-check
/**
 * Workspace, Lakehouse, notebooks, pipeline and schedule. Re-runs reuse what the
 * install record points at; `update` pushes fresh notebook and pipeline content.
 */
import { enabledModules, notebooksFor } from '../catalog.js';
import { scheduleBody } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { prepareNotebook, serialiseNotebook } from '../transform/notebook.js';
import { buildPipeline } from '../transform/pipeline.js';

/** @typedef {import('../install.js').Ctx} Ctx */

export const PIPELINE_NAME = 'ValueLens_Pipeline';

/** @param {unknown} err */
const isNotFound = (err) => err instanceof HttpError && (err.status === 404 || err.code === 'ItemNotFound' || err.code === 'WorkspaceNotFound');

/**
 * @param {any[]} items
 * @param {string} name
 */
const byName = (items, name) => items.find((i) => String(i.displayName).toLowerCase() === name.toLowerCase());

/**
 * A create can answer 201 with the item, or 202 and a result. If neither carries an ID, look it up by name.
 * @param {Ctx} ctx
 * @param {any} created
 * @param {string} type
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createdId(ctx, created, type, name) {
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
  const name = /** @type {string} */ (f.lakehouseName);
  const existing = byName(await api.fabric.listItems(ws, 'Lakehouse'), name);
  if (existing) {
    f.lakehouseId = existing.id;
    f.lakehouseName = existing.displayName;
    ui.ok(`Using the existing Lakehouse "${existing.displayName}"`);
  } else {
    const created = await api.fabric.createLakehouse(ws, name);
    f.lakehouseId = await createdId(ctx, created, 'Lakehouse', name);
    ui.ok(`Created Lakehouse "${name}"`);
  }
  ctx.save();
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
  return {
    ...(nb.credentials
      ? {
          tenantId: user.tenantId,
          clientId: config.app.appId,
          secret: { vaultUri: /** @type {string} */ (config.keyVault.uri), secretName: config.keyVault.secretName },
        }
      : {}),
    parameters: nb.parameters,
    lakehouse: {
      id: /** @type {string} */ (f.lakehouseId),
      name: /** @type {string} */ (f.lakehouseName),
      workspaceId: /** @type {string} */ (f.workspaceId),
    },
    dataCheckSummary: nb.key === 'dataCheck',
  };
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

  for (const nb of notebooksFor(config.modules)) {
    const content = serialiseNotebook(prepareNotebook(sources.notebooks[nb.key], notebookSettings(ctx, nb)));
    let id = f.notebooks[nb.key];
    if (id && !ids.has(id)) {
      ui.warn(`${nb.displayName} was deleted. Deploying it again.`);
      id = undefined;
    }
    if (!id) {
      const same = byName(items, nb.displayName);
      if (same) {
        const replace = await ui.confirm(`A notebook called ${nb.displayName} is already in the workspace. Replace it with the ValueLens version?`, true);
        if (!replace) throw new Error(`Stopped: ${nb.displayName} already exists. Rename or remove it, or choose another workspace.`);
        await api.fabric.updateNotebook(ws, same.id, content);
        id = same.id;
        ui.ok(`Updated ${nb.displayName}`);
      } else {
        const created = await api.fabric.createNotebook(ws, nb.displayName, content);
        id = await createdId(ctx, created, 'Notebook', nb.displayName);
        ui.ok(`Created ${nb.displayName}`);
      }
    } else if (opts.force) {
      await api.fabric.updateNotebook(ws, id, content);
      ui.ok(`Updated ${nb.displayName}`);
    } else {
      ui.ok(`${nb.displayName} is in place`);
    }
    f.notebooks[nb.key] = id;
    ctx.save();
  }
}

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
  });
  const signature = enabledModules(config.modules).join(',');
  const items = await api.fabric.listItems(ws, 'DataPipeline');

  if (f.pipelineId && !items.some((i) => i.id === f.pipelineId)) {
    ui.warn(`${f.pipelineName ?? PIPELINE_NAME} was deleted. Creating it again.`);
    delete f.pipelineId;
    delete f.scheduleId;
  }

  if (!f.pipelineId) {
    const name = f.pipelineName ?? PIPELINE_NAME;
    const same = byName(items, name);
    if (same) {
      const replace = await ui.confirm(`A pipeline called ${name} is already in the workspace. Replace it with the ValueLens version?`, true);
      if (!replace) throw new Error(`Stopped: ${name} already exists. Rename or remove it, or choose another workspace.`);
      await api.fabric.updatePipeline(ws, same.id, definition);
      f.pipelineId = same.id;
      ui.ok(`Updated pipeline ${name}`);
    } else {
      const created = await api.fabric.createPipeline(ws, name, definition);
      f.pipelineId = await createdId(ctx, created, 'DataPipeline', name);
      ui.ok(`Created pipeline ${name}`);
    }
    f.pipelineName = name;
  } else if (opts.force || f.pipelineModules !== signature) {
    ui.note('This replaces the pipeline definition, including any activities you added to it (such as a semantic model refresh).');
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
