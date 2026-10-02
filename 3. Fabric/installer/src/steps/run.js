// @ts-check
/** Runs the pipeline and the data check, and reports on them. */
import { DATA_CHECK_FILE } from '../transform/notebook.js';
import { firstRunParameters } from '../transform/pipeline.js';
import { formatDuration } from '../ui.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/** Job states after which Fabric does no more work. */
export const TERMINAL = new Set(['Completed', 'Failed', 'Cancelled', 'Deduped', 'Duplicate', 'NotFound', 'OwnerUserMissing', 'DeadLettered']);

export const POLL_MS = 30_000;

/** Fabric sends job times without a zone; they are UTC. @param {string | null | undefined} t */
export function utc(t) {
  if (!t) return undefined;
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
}

/** @param {string} url */
export const jobIdFrom = (url) => /** @type {string} */ (new URL(url, 'https://x').pathname.split('/').filter(Boolean).pop());

/**
 * Polls a job until it ends or `timeoutMs` passes. Returns the last job instance seen.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} label
 * @param {{ pollMs?: number, timeoutMs?: number }} [opts]
 */
export async function waitForJob(ctx, url, label, opts = {}) {
  const progress = ctx.ui.progress(label);
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3_600_000);
  /** @type {any} */
  let job;
  try {
    for (;;) {
      job = await ctx.api.fabric.getJob(url);
      progress.update(job?.status ?? 'Unknown');
      if (TERMINAL.has(job?.status)) break;
      if (Date.now() > deadline) break;
      await ctx.sleep(opts.pollMs ?? POLL_MS);
    }
  } finally {
    progress.done();
  }
  return job;
}

/**
 * @param {Ctx} ctx
 * @param {any} job
 * @param {string} what
 */
function reportJob(ctx, job, what) {
  const { ui } = ctx;
  const start = utc(job?.startTimeUtc);
  const end = utc(job?.endTimeUtc);
  const took = start && end ? ` in ${formatDuration(end.getTime() - start.getTime())}` : '';
  switch (job?.status) {
    case 'Completed':
      ui.ok(`${what} finished${took}`);
      return true;
    case 'Failed':
      ui.fail(`${what} failed${took}`);
      if (job.failureReason?.message) ui.info(String(job.failureReason.message).slice(0, 1200));
      return false;
    default:
      if (TERMINAL.has(job?.status)) ui.warn(`${what} ended with status ${job.status}`);
      else ui.warn(`${what} is still running (${job?.status ?? 'unknown'}). Check later with "valuelens-install status".`);
      return false;
  }
}

/**
 * Starts the pipeline. With `backfillDays` it reloads that much audit history and rebuilds the curated table.
 * @param {Ctx} ctx
 * @param {{ backfillDays?: number, wait?: boolean, first?: boolean }} opts
 */
export async function runPipeline(ctx, opts) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) throw new Error('There is no pipeline yet. Run the installer first.');
  const parameters = opts.backfillDays ? firstRunParameters(opts.backfillDays) : undefined;
  const url = await api.fabric.runJob(f.workspaceId, f.pipelineId, 'Pipeline', parameters ? { parameters } : undefined);
  const jobId = jobIdFrom(url);
  if (opts.first) {
    config.firstRun = { jobId, status: 'NotStarted', startedAt: ctx.now().toISOString() };
    ctx.save();
  }
  ui.ok(opts.backfillDays ? `Started the pipeline with ${opts.backfillDays} days of audit history` : 'Started the pipeline');
  if (!opts.wait) {
    ui.note('It runs in Fabric. Check on it with "valuelens-install status".');
    return { jobId, status: 'NotStarted' };
  }
  ui.note('The first load usually takes 10 to 40 minutes. You can press Ctrl+C; the run carries on in Fabric.');
  const job = await waitForJob(ctx, url, 'Pipeline');
  const ok = reportJob(ctx, job, 'Pipeline');
  if (opts.first) {
    config.firstRun = { ...config.firstRun, status: job?.status, finishedAt: TERMINAL.has(job?.status) ? ctx.now().toISOString() : undefined };
    ctx.save();
  }
  return { jobId, status: job?.status, ok };
}

/**
 * Runs ValueLens_Data_Check and reads back the summary it leaves in the Lakehouse.
 * @param {Ctx} ctx
 */
export async function runDataCheck(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const notebookId = f.notebooks.dataCheck;
  if (!f.workspaceId || !f.lakehouseId || !notebookId) {
    ui.warn('The data check notebook isn\'t deployed.');
    return null;
  }
  const url = await api.fabric.runJob(f.workspaceId, notebookId, 'RunNotebook');
  const job = await waitForJob(ctx, url, 'Data check', { pollMs: 15_000, timeoutMs: 45 * 60_000 });
  if (!reportJob(ctx, job, 'Data check')) return null;
  const summary = await api.oneLake.readJson(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE).catch(() => null);
  if (!summary) {
    ui.note('Open ValueLens_Data_Check in Fabric to see its results.');
    return null;
  }
  printDataCheck(ctx, summary);
  return summary;
}

const TABLE_LABELS = /** @type {const} */ ({
  licensed: 'Licensed users',
  audit: 'Copilot interactions',
  org: 'Org data',
  agents: 'Agents',
});

/**
 * @param {Ctx} ctx
 * @param {any} summary
 */
export function printDataCheck(ctx, summary) {
  const { ui } = ctx;
  const tables = summary?.tables ?? {};
  for (const [key, label] of Object.entries(TABLE_LABELS)) {
    const t = tables[key];
    if (!t) {
      if (key === 'licensed' || key === 'audit') ui.warn(`${label}: no table yet`);
      else ui.note(`${label}: not loaded`);
      continue;
    }
    const rows = Number(t.rows ?? 0).toLocaleString('en-GB');
    const range = t.from && t.to ? `, ${String(t.from).slice(0, 10)} to ${String(t.to).slice(0, 10)}` : '';
    (t.rows ? ui.ok : ui.warn)(`${label}: ${rows} rows${range}`);
  }
}

/**
 * @param {Ctx} ctx
 */
export async function status(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.pipelineId) {
    ui.warn('Nothing is installed yet.');
    return;
  }
  ui.heading('ValueLens');
  ui.info(`Workspace: ${f.workspaceName ?? f.workspaceId}`);
  ui.info(`Lakehouse: ${f.lakehouseName ?? f.lakehouseId}`);
  ui.info(`Pipeline:  ${f.pipelineName ?? f.pipelineId}`);
  if (config.app.secretExpires) {
    const days = Math.floor((Date.parse(config.app.secretExpires) - ctx.now().getTime()) / 86_400_000);
    const msg = `Client secret expires ${config.app.secretExpires.slice(0, 10)} (${days} days)`;
    if (days < 30) ui.warn(`${msg}. Run "valuelens-install rotate-secret".`);
    else ui.info(msg);
  }

  ui.heading('Recent runs');
  const jobs = (await api.fabric.listJobs(f.workspaceId, f.pipelineId))
    .sort((a, b) => String(b.startTimeUtc ?? '').localeCompare(String(a.startTimeUtc ?? '')))
    .slice(0, 5);
  if (!jobs.length) ui.note('No runs yet.');
  for (const job of jobs) {
    const start = utc(job.startTimeUtc);
    const end = utc(job.endTimeUtc);
    const when = start ? start.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not started';
    const took = start && end ? `, ${formatDuration(end.getTime() - start.getTime())}` : '';
    const line = `${when}  ${job.status}${took}  ${job.invokeType ?? ''}`.trimEnd();
    if (job.status === 'Completed') ui.ok(line);
    else if (job.status === 'Failed') {
      ui.fail(line);
      if (job.failureReason?.message) ui.note(String(job.failureReason.message).slice(0, 400));
    } else ui.info(line);
  }

  if (config.firstRun?.jobId && !TERMINAL.has(config.firstRun.status ?? '')) {
    const job = jobs.find((j) => j.id === config.firstRun?.jobId);
    if (job && TERMINAL.has(job.status)) {
      config.firstRun = { ...config.firstRun, status: job.status, finishedAt: utc(job.endTimeUtc)?.toISOString() };
      ctx.save();
    }
  }

  if (f.lakehouseId) {
    const summary = await api.oneLake.readJson(f.workspaceId, f.lakehouseId, DATA_CHECK_FILE).catch(() => null);
    if (summary) {
      ui.heading(`Last data check${summary.checkedAt ? ` (${String(summary.checkedAt).slice(0, 16).replace('T', ' ')} UTC)` : ''}`);
      printDataCheck(ctx, summary);
    }
  }
}
