// The "No Fabric: PAX + SharePoint" route after its questions: set-up, the commands, status, the
// summary and uninstall. A scheduled task on this PC runs PAX each day and puts the audit rollups
// in a SharePoint folder. The SharePoint report reads them there, from a Power BI Pro workspace,
// and the app goes on as a Copilot managed app when the tenant is ready for it.
import { HttpError } from '../../http.js';
import { commandLine } from '../../launch.js';
import { deployTheApp, removeTheApp } from '../../managed-app/flow.js';
import { PRODUCT } from '../../product.js';
import { c } from '../../ui.js';
import {
  accessCommand, ensureViewerGroup, grantModelAccess, shareReport, workspaceUrl,
} from '../access.js';
import { SECRET_LIFETIME_MONTHS, addMonths, ensureApp, ensureConsent, isResumeLater } from '../identity.js';
import { modelUrl } from '../model.js';
import { nextSteps, stepsLeftTitle } from '../next-steps.js';
import { addTrackedSecret, promoteSecret, removeRetired, settleFailedSecret } from '../secrets.js';
import {
  PAX_RELEASE, RUN_LIMIT_MS, credentialTarget, paxHostOf, paxPaths, readState, refreshConfig, registerTask,
  removeLocal, removeSecret, runRefresh, scriptFailed, secretStored, startTask, storeSecret, taskCurrent,
  taskInfo, unregisterTask, writeRefreshConfig, writeScripts,
} from './local.js';
import { paxAppWanted, paxPreflight } from './plan.js';
import { askCredentials, ensurePaxWorkspace, loadPaxModel, publishPax, SCHEDULE_OFF_WHY, setPaxSchedule } from './publish.js';
import {
  confirmFolderAccess, describeFolder, ensureSiteGrant, removeRetiredGrants, removeSiteGrant,
} from './site.js';
import { paxUpload } from './upload.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {Ctx['config']} Config */
/** @typedef {import('./local.js').PaxHost} PaxHost */
/** @typedef {import('./plan.js').PaxPreflight} PaxPreflight */

/**
 * @typedef {object} PaxOptions
 * @property {boolean} [wait]  Watch the run that `run` starts, and load the model after it. Default true.
 * @property {number} [backfillDays]  `run` reads this many days of history now, on this PC.
 * @property {string[]} [files]  The files `upload` puts in the SharePoint folder.
 * @property {string} [folder]  `upload`'s subfolder of the SharePoint folder.
 *
 * @typedef {'running' | 'busy' | 'success' | 'no-data' | 'failed'} RunStatus
 * @typedef {{ status: RunStatus, error?: string, log?: string, partial?: boolean, message?: string }} RunOutcome
 *   `partial` is a success that stopped to stay inside the task's time limit, with the rest of
 *   the load left to the next run. `message` is what the run said about it.
 */

/** How long set-up and `run` watch a run for a quick failure before leaving it to carry on. */
const WATCH_MS = 3 * 60_000;
const POLL_MS = 15_000;
/** state.json and the task both use this PC's clock. This allows for the gap before a run starts. */
const CLOCK_SLACK_MS = 60_000;
/** Task Scheduler's results for "running now" and "hasn't run yet". */
const TASK_RUNNING = 0x41301;
const TASK_NEVER_RAN = 0x41303;
/** refresh.ps1's exit codes: another refresh holds the lock, and PAX found no audit records. */
const EXIT_BUSY = 2;
const EXIT_NO_DATA = 3;
/** A stored secret with less than this long to run is replaced. */
const RENEW_DAYS = 30;
const DAY_MS = 86_400_000;
/** Commands that need the scheduled refresh to be set up first. */
const NEEDS_INSTALL = new Set(['update', 'run', 'status', 'check', 'refresh', 'rotate-secret']);
/** What a run that stopped part way through a load says, when it left no message of its own. */
const PARTIAL_LOAD = 'The refresh loaded part of the history into SharePoint, and the next scheduled run carries on from there.';

/** @param {unknown} err */
const isGone = (err) => err instanceof HttpError && err.status === 404;

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/** @param {string | null | undefined} iso */
const when = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'never');

/** @param {string | null | undefined} iso */
const day = (iso) => (iso ? iso.slice(0, 10) : '');

/**
 * The record's PAX settings, which the questions fill in.
 * @param {Config} config
 */
function paxOf(config) {
  const pax = config.pax;
  const task = pax?.task;
  if (!pax || !task?.name) {
    throw new Error(`This record has no PAX refresh set up yet. To set it up, run: ${commandLine('install')}`);
  }
  return { pax, task };
}

/**
 * The app registration ensureApp set up.
 * @param {Config} config
 */
function appOf(config) {
  const app = config.app;
  if (!app?.appId || !app.objectId) {
    throw new Error("The app registration isn't set up yet. Run the installer again.");
  }
  return /** @type {typeof app & { appId: string, objectId: string }} */ (app);
}

/**
 * The model the viewer group gets Build on, once it's published.
 * @param {Config} config
 * @returns {{ workspaceId: string, datasetId: string, name: string }[]}
 */
export function paxModels(config) {
  const ws = config.fabric?.workspaceId;
  const sm = config.semanticModel;
  return ws && sm?.id ? [{ workspaceId: ws, datasetId: sm.id, name: sm.name ?? PRODUCT.pax.model }] : [];
}

/** @param {number | undefined} code  The task's last result. */
function taskResult(code) {
  if (code === undefined) return 'result unknown';
  if (code === 0) return 'finished';
  if (code === TASK_RUNNING) return 'running';
  if (code === TASK_NEVER_RAN) return 'not run yet';
  if (code === EXIT_BUSY) return 'skipped: another refresh was running';
  if (code === EXIT_NO_DATA) return 'finished, no audit records';
  return `failed (0x${(code >>> 0).toString(16)})`;
}

/**
 * Puts the app's client secret in Credential Manager on this PC, where the task reads it. A stored
 * secret for this app with more than a month to run is kept. Otherwise the installer makes a new
 * one or, for an app it didn't create, stores the one pasted at the questions.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [o]  Make a new secret even if the stored one is fine.
 */
async function ensureTaskSecret(ctx, { force = false } = {}) {
  const { config, ui } = ctx;
  const { pax } = paxOf(config);
  const app = appOf(config);
  const name = app.displayName ?? PRODUCT.pax.app;
  const host = paxHostOf(ctx);
  const target = credentialTarget(config);
  if (ctx.pendingSecret) {
    await storeSecret(host, target, app.appId, ctx.pendingSecret);
    delete ctx.pendingSecret;
    pax.credentialTarget = target;
    pax.secretSetAt = ctx.now().toISOString();
    delete pax.secretExpires;
    ctx.save();
    await promoteSecret(ctx, pax, app.objectId, undefined);
    ui.ok(`Stored the client secret in Credential Manager as ${c.bold(target)}.`);
    return;
  }
  if (!force) {
    const stored = await secretStored(host, target);
    const expires = pax.secretExpires ? Date.parse(pax.secretExpires) : NaN;
    const lasts = Number.isNaN(expires) || expires - ctx.now().getTime() > RENEW_DAYS * DAY_MS;
    if (stored.exists && stored.userName === app.appId && lasts) {
      pax.credentialTarget = target;
      const until = pax.secretExpires ? `, until ${day(pax.secretExpires)}` : '';
      ui.ok(`The client secret is in Credential Manager as ${c.bold(target)}${until}.`);
      return;
    }
  }
  if (app.existing) {
    throw new Error(
      `The installer didn't create ${name}, so it can't make a client secret for it.\n` +
      `  Make one in Entra ID (App registrations > ${name} > Certificates & secrets), then run: ` +
      commandLine('rotate-secret'),
    );
  }
  const end = addMonths(ctx.now(), SECRET_LIFETIME_MONTHS);
  const made = await addTrackedSecret(ctx, pax, app.objectId, PRODUCT.installer, end);
  try {
    await storeSecret(host, target, app.appId, made.secretText);
  } catch (err) {
    const fate = await settleFailedSecret(ctx, pax, app.objectId, made.keyId, err);
    throw new Error(
      `Couldn't store the client secret in Credential Manager on this PC: ${messageOf(err)}\n  ` +
      (fate === 'removed'
        ? 'The new secret was taken off the app registration again.'
        : 'The new secret stays on the app registration until the installer next runs, which removes it.') +
      '\n  Fix what it says, then run the installer again.',
    );
  }
  pax.credentialTarget = target;
  pax.secretSetAt = ctx.now().toISOString();
  pax.secretExpires = made.endDateTime;
  ctx.save();
  await promoteSecret(ctx, pax, app.objectId, made.keyId);
  ui.ok(`Created a client secret and stored it in Credential Manager as ${c.bold(target)} (expires ${day(made.endDateTime)}).`);
}

/**
 * Replaces the client secret the task uses. For an app the installer created, it makes a new one and
 * removes the old one. For another app, it stores one pasted here.
 * @param {Ctx} ctx
 */
async function rotateSecret(ctx) {
  const app = appOf(ctx.config);
  if (app.existing) {
    ctx.pendingSecret = await ctx.ui.secret(`Paste a new client secret for ${app.displayName ?? PRODUCT.pax.app}`);
  }
  await ensureTaskSecret(ctx, { force: true });
  return true;
}

/**
 * Writes the refresh's scripts and settings on this PC, asks for the app's access to the site and,
 * once consent is in, checks that the app can reach the folder.
 * @param {Ctx} ctx
 * @param {boolean} consented
 * @returns {Promise<boolean>} Whether the app reached the folder.
 */
async function prepareSharePoint(ctx, consented) {
  const { config, ui, sources } = ctx;
  const { pax } = paxOf(config);
  if (!sources.paxScripts) {
    throw new Error(`This copy of the ${PRODUCT.installer} is missing the PAX refresh scripts. Download it again, then run it.`);
  }
  const host = paxHostOf(ctx);
  pax.scriptsHash = writeScripts(host, sources.paxScripts);
  pax.version = PAX_RELEASE.tag;
  pax.workRoot = paxPaths(host).root;
  writeRefreshConfig(host, refreshConfig(config, { configFile: ctx.configFile }));
  ctx.save();
  ui.ok(`Wrote the refresh scripts and settings to ${c.bold(pax.workRoot)} (PAX ${PAX_RELEASE.tag}).`);
  await ensureSiteGrant(ctx);
  await removeRetiredGrants(ctx);
  if (!consented) {
    ui.note(`Checking the folder waits until admin consent is granted. Then run: ${commandLine('check')}`);
    return false;
  }
  return confirmFolderAccess(ctx);
}

/**
 * Registers the daily task, unless it's already there as recorded. Changes the user made to it in
 * Task Scheduler, such as running it whether or not they're signed in, are kept.
 * @param {Ctx} ctx
 */
async function ensureTask(ctx) {
  const { config, ui } = ctx;
  const { task } = paxOf(config);
  const host = paxHostOf(ctx);
  const info = await taskInfo(host, task.name);
  if (taskCurrent(info, host, task, task.at)) {
    ui.ok(`The task ${c.bold(task.name)} is already scheduled, daily at ${task.at}.`);
    return;
  }
  const report = await registerTask(host, {
    name: task.name,
    at: task.at,
    description: `${PRODUCT.name}: runs PAX each day and puts the Copilot audit rollups in SharePoint. Set up by the ${PRODUCT.installer}.`,
  });
  task.registeredAt = ctx.now().toISOString();
  task.logonType = report.logonType;
  ctx.save();
  ui.ok(`Scheduled ${c.bold(task.name)} daily at ${task.at}, as ${report.userId}.`);
  if (report.logonType === 'Interactive') {
    ui.note("It runs only while you're signed in to this PC. To run it when you're signed out too, change it in Task Scheduler: the installer keeps that change.");
  }
}

/**
 * How a run that started at `startedAt` ended, from state.json, or undefined while state.json is
 * older than the run. refresh.ps1 writes state.json as each run ends.
 * @param {Record<string, any> | undefined} state
 * @param {string} startedAt
 * @returns {RunOutcome | undefined}
 */
export function endedSince(state, startedAt) {
  if (!state?.lastRunUtc || Date.parse(state.lastRunUtc) < Date.parse(startedAt) - CLOCK_SLACK_MS) return undefined;
  if (state.lastResult === 'success') {
    if (!state.progress) return { status: 'success' };
    return { status: 'success', partial: true, ...(state.lastMessage ? { message: String(state.lastMessage) } : {}) };
  }
  return {
    status: state.lastResult === 'no-data' ? 'no-data' : 'failed',
    error: state.lastError || state.lastMessage || undefined,
    log: state.lastLog || undefined,
  };
}

/**
 * How the run that started at `startedAt` went, from state.json and the task.
 * @param {PaxHost} host
 * @param {string} taskName
 * @param {string} startedAt
 * @returns {Promise<RunOutcome>}
 */
async function runOutcome(host, taskName, startedAt) {
  const since = Date.parse(startedAt) - CLOCK_SLACK_MS;
  const fromState = () => endedSince(readState(host), startedAt);
  const done = fromState();
  if (done) return done;
  const info = await taskInfo(host, taskName);
  if (!info?.exists) return { status: 'failed', error: `The task ${taskName} isn't on this PC any more.` };
  const ran = info.lastRunTime ? Date.parse(info.lastRunTime) : NaN;
  if (info.state === 'Running' || info.lastTaskResult === TASK_RUNNING || !(ran >= since)) return { status: 'running' };
  // The task has stopped. Look again, in case the run ended between the two looks.
  const late = fromState();
  if (late) return late;
  if (info.lastTaskResult === EXIT_BUSY) return { status: 'busy' };
  return {
    status: 'failed',
    error: `The task stopped (result 0x${((info.lastTaskResult ?? 0) >>> 0).toString(16)}) before the refresh recorded how it went.`,
  };
}

/**
 * Records how the first run went, once it's done. A success clears it, and a failure stays on the
 * record for the next-steps card.
 * @param {Ctx} ctx
 * @returns {Promise<RunStatus | 'none'>} 'none' when there's no first run to watch.
 */
export async function settleFirstRun(ctx) {
  const pax = ctx.config.pax;
  const run = pax?.firstRun;
  if (!pax?.task?.name || !run?.startedAt) return 'none';
  const out = await runOutcome(paxHostOf(ctx), pax.task.name, run.startedAt);
  if (out.status === 'running' || out.status === 'busy') return run.result ?? out.status;
  if (out.status === 'success') {
    delete pax.firstRun;
  } else {
    run.result = out.status;
    run.error = out.error;
    run.log = out.log;
  }
  ctx.save();
  return out.status;
}

/**
 * After a run that worked, loads the model so the report shows the new data, once it's signed in.
 * @param {Ctx} ctx
 * @param {boolean} wait
 */
async function loadAfterRun(ctx, wait) {
  const { config, ui } = ctx;
  if (!config.semanticModel?.id) return true;
  if (config.powerBi?.credentials !== 'set') {
    ui.info("The report shows the data once it's signed in to SharePoint. Run the installer again to do that.");
    return true;
  }
  return (await loadPaxModel(ctx, { wait })).ok;
}

/**
 * Starts the task now and watches it for a few minutes, to catch a quick failure. A long run
 * carries on in the background, and `status` shows how it's going.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, first?: boolean }} o  `first` records it as the first run.
 * @returns {Promise<boolean>} False when it failed.
 */
async function startAndWatch(ctx, { wait = true, first = false }) {
  const { config, ui } = ctx;
  const { pax, task } = paxOf(config);
  const host = paxHostOf(ctx);
  const startedAt = ctx.now().toISOString();
  await startTask(host, task.name);
  if (first) {
    pax.firstRun = { startedAt };
    ctx.save();
  }
  ui.ok(`Started ${c.bold(task.name)}.`);
  if (!wait) {
    ui.info(`It runs in the background. To see how it's going, run: ${commandLine('status')}`);
    return true;
  }
  const progress = ui.progress('Reading the audit log with PAX');
  const until = ctx.now().getTime() + WATCH_MS;
  /** @type {RunOutcome} */
  let out = { status: 'running' };
  try {
    for (;;) {
      out = await runOutcome(host, task.name, startedAt);
      if (out.status !== 'running' || ctx.now().getTime() >= until) break;
      await ctx.sleep(POLL_MS);
    }
  } finally {
    progress.done();
  }
  if (first) await settleFirstRun(ctx);
  switch (out.status) {
    case 'running':
      ui.info(`It's still running, in the background. In a large tenant a first run can take hours. To see how it's going, run: ${commandLine('status')}`);
      return true;
    case 'busy':
      ui.info(`Another refresh was already running on this PC, so this one stopped. To see how it's going, run: ${commandLine('status')}`);
      return true;
    case 'success':
      ui.ok(out.partial ? (out.message ?? PARTIAL_LOAD) : 'The refresh finished, and the rollups are in SharePoint.');
      return loadAfterRun(ctx, wait);
    case 'no-data':
      ui.warn('The refresh finished but found no Copilot audit records. If Copilot is in use, check that auditing is on in Microsoft Purview.');
      return true;
    default:
      ui.fail(`The refresh failed${out.error ? `: ${out.error}` : '.'}`);
      if (out.log) ui.info(`Log: ${out.log}`);
      return false;
  }
}

/**
 * Reads `days` of audit history now, on this PC, and adds it to the rollups. PAX drops the records
 * that are already there, so it can overlap what the task read.
 * @param {Ctx} ctx
 * @param {number} days
 */
async function reloadHistory(ctx, days) {
  const { config, ui } = ctx;
  paxOf(config);
  const host = paxHostOf(ctx);
  const progress = ui.progress(`Reading ${days} days of the audit log with PAX`);
  const r = await runRefresh(host, { days, timeoutMs: RUN_LIMIT_MS }).finally(() => progress.done());
  if (r.code === EXIT_BUSY) {
    ui.warn(`A refresh is already running on this PC. When it's done, run: ${commandLine(`run --backfill-days ${days}`)}`);
    return false;
  }
  if (r.code === EXIT_NO_DATA) {
    ui.warn(`PAX found no Copilot audit records in the last ${days} days.`);
    return true;
  }
  if (r.code !== 0) throw scriptFailed(r, 'The refresh');
  // The rollups keep what they had, so a shorter reload doesn't shorten the history. A reload that
  // stopped part way counts too: the scheduled runs read the rest.
  if (days > (config.history?.days ?? 0)) config.history = { ...config.history, days };
  ctx.save();
  const state = readState(host);
  if (state?.progress) ui.ok(state.lastMessage ? String(state.lastMessage) : PARTIAL_LOAD);
  else ui.ok(`Read ${days} days of the audit log and added them to the rollups in SharePoint.`);
  return loadAfterRun(ctx, true);
}

/**
 * Sets the route up after its questions, or brings it up to date. Each step picks up what's
 * already there, so running it again repairs the set-up.
 * @param {Ctx} ctx
 * @param {PaxPreflight} pre
 * @param {{ wait?: boolean }} [o]
 * @returns {Promise<boolean>} False when a step didn't finish.
 */
export async function paxInstall(ctx, pre, { wait = true } = {}) {
  const { config, ui } = ctx;
  const { task } = paxOf(config);
  const report = !!config.semanticModel?.enabled;
  const viewers = report && !!config.access;
  // Asked once: Power BI has no API to share a report, and the group gets no workspace role instead.
  const share = viewers && config.access?.reportShared !== true;
  const app = paxAppWanted(ctx);
  const reload = ctx.reloadHistoryDays;
  const titles = [
    'App registration', 'Microsoft Graph permissions', 'Client secret', 'SharePoint access', 'Scheduled refresh',
    ...(report ? ['Power BI report'] : []),
    ...(viewers ? ['Viewer access'] : []),
    ...(share ? ['Share the report'] : []),
    ...(app ? ['The app'] : []),
    ...(report ? ['Sign the report in'] : []),
    reload ? 'Reload audit history' : 'First load',
  ];
  let n = 0;
  /** @param {string} title */
  const step = (title) => ui.step(++n, titles.length, title);
  let ok = true;

  step('App registration');
  await ensureApp(ctx);
  step('Microsoft Graph permissions');
  const consented = await ensureConsent(ctx, { canConsent: pre.canConsent });
  step('Client secret');
  await ensureTaskSecret(ctx);
  step('SharePoint access');
  const reachable = await prepareSharePoint(ctx, consented);
  step('Scheduled refresh');
  await ensureTask(ctx);

  if (report) {
    step('Power BI report');
    try {
      await ensurePaxWorkspace(ctx);
      await publishPax(ctx);
    } catch (err) {
      if (isResumeLater(err)) throw err;
      ui.fail(`Couldn't publish the report: ${messageOf(err)}`);
      ok = false;
    }
  }
  const published = !!config.semanticModel?.id;
  if (viewers) {
    step('Viewer access');
    if (!published) ui.warn('Skipped until the report is published.');
    else if (await ensureViewerGroup(ctx)) await grantModelAccess(ctx, paxModels(config));
  }
  if (share) {
    step('Share the report');
    if (!published) ui.warn('Skipped until the report is published.');
    else await shareReport(ctx);
  }
  if (app) {
    step('The app');
    const r = await deployTheApp(ctx, ctx.appDeps ?? {}, { environmentId: ctx.environmentId });
    if (!r.ok) ok = false;
  }
  if (report) {
    step('Sign the report in');
    if (!published) ui.warn('Skipped until the report is published.');
    else if (await askCredentials(ctx)) await setPaxSchedule(ctx);
  }

  if (reload) {
    step('Reload audit history');
    if (!reachable) {
      ui.warn(`Skipped until the app can reach the SharePoint folder. Then run: ${commandLine(`run --backfill-days ${reload}`)}`);
    } else if (!(await reloadHistory(ctx, reload))) ok = false;
  } else {
    step('First load');
    if (!ctx.runFirstLoad) {
      ui.info(`Skipped. The task runs daily at ${task.at}. To run it now: ${commandLine('run')}`);
    } else if (!consented) {
      ui.warn(`Skipped until admin consent is granted. Then run: ${commandLine('run')}`);
    } else if (!reachable) {
      ui.warn(`Skipped until the app can reach the SharePoint folder. Then run: ${commandLine('check')}, then ${commandLine('run')}`);
    } else if (!(await startAndWatch(ctx, { wait, first: true }))) ok = false;
  }

  await settleFirstRun(ctx);
  paxSummary(ctx, { ok });
  return ok;
}

/**
 * What's set up, and what's left to do.
 * @param {Ctx} ctx
 * @param {{ ok: boolean }} o
 */
export function paxSummary(ctx, { ok }) {
  const { config, ui, user } = ctx;
  const pax = config.pax;
  const ws = config.fabric;
  const sm = config.semanticModel;
  ui.heading(ok ? `${PRODUCT.name} is set up` : `${PRODUCT.name} is partly set up`);
  if (!ok) ui.warn("A step above didn't finish. Fix what it says, then run the installer again: it picks up where it stopped.");
  const steps = nextSteps(config, user);
  if (steps.length) ui.nextSteps(stepsLeftTitle(steps), steps);
  if (config.sharePoint) ui.info(`Files:      ${describeFolder(config.sharePoint)}`);
  if (pax?.task?.name) {
    const signedIn = pax.task.logonType === 'Interactive' ? ", while you're signed in" : '';
    ui.info(`Task:       ${pax.task.name}, daily at ${pax.task.at}${signedIn}`);
  }
  if (pax?.credentialTarget) {
    const expires = pax.secretExpires ? `, expires ${day(pax.secretExpires)}` : '';
    ui.info(`Secret:     Credential Manager, ${pax.credentialTarget}${expires}`);
  }
  if (ws?.workspaceId) {
    ui.info(`Workspace:  ${ws.workspaceName ?? PRODUCT.pax.workspace}, ${workspaceUrl(ws.workspaceId, user?.tenantId)}`);
    if (sm?.id) {
      const at = [config.powerBi?.refreshAt ?? []].flat();
      ui.info(`Model:      ${modelUrl(ws.workspaceId, sm.id)}${at.length ? `, refreshes at ${at.join(' and ')}` : ''}`);
    }
  }
  if (config.managedApp?.url) ui.info(`App:        ${config.managedApp.url}`);
  ui.info(`Keep ${c.bold(PRODUCT.recordFile)}. It holds no secrets; re-run the installer with it to change or repair the set-up.`);
}

/**
 * How the refresh is doing: the task, the last run, the secret, the folder and the model.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>} False when the last run failed or something's missing.
 */
export async function paxStatus(ctx) {
  const { config, ui, api } = ctx;
  const { pax, task } = paxOf(config);
  const host = paxHostOf(ctx);
  let ok = true;
  const first = await settleFirstRun(ctx);
  ui.heading('Scheduled refresh');
  const info = await taskInfo(host, task.name);
  if (!info?.exists) {
    ui.warn(`The task ${c.bold(task.name)} isn't on this PC. To set it up again, run: ${commandLine('update')}`);
    ok = false;
  } else {
    ui.info(`Task:         ${task.name}, ${info.state}, daily at ${task.at}`);
    ui.info(`Last started: ${info.lastRunTime ? `${when(info.lastRunTime)}, ${taskResult(info.lastTaskResult)}` : 'never'}`);
    ui.info(`Next run:     ${when(info.nextRunTime)}`);
  }
  const state = readState(host);
  if (!state) {
    ui.info('Last run:     none has finished on this PC yet');
  } else {
    ui.info(`Last run:     ${state.lastResult ?? 'unknown'}, ${when(state.lastRunUtc)}`);
    if (state.lastSuccessUtc) ui.info(`Last success: ${when(state.lastSuccessUtc)}`);
    if (state.coveredThroughUtc) ui.info(`Data up to:   ${when(state.coveredThroughUtc)}`);
    const load = state.progress;
    // A load longer than one window can take more than one run.
    if (load?.days > load?.windowDays) {
      const read = load.throughUtc ? `read up to ${when(load.throughUtc)} so far` : 'none read yet';
      ui.info(`History:      loading ${load.days} days of activity, ${read}. Each run carries on where the last one stopped.`);
    }
    if (state.gapWarning) ui.warn(String(state.gapWarning));
    if (state.lastResult === 'failed') {
      ok = false;
      if (state.lastError) ui.warn(String(state.lastError));
    }
    if (state.lastLog) ui.info(`Log:          ${state.lastLog}`);
  }
  if (first === 'running') ui.info('The first run is still going. In a large tenant it can take hours.');
  if (first === 'failed') ok = false;
  const target = pax.credentialTarget ?? credentialTarget(config);
  const stored = await secretStored(host, target);
  if (!stored.exists) {
    ui.warn(`The client secret isn't in Credential Manager on this PC. To put a new one there, run: ${commandLine('rotate-secret')}`);
    ok = false;
  } else {
    ui.info(`Secret:       ${target}${pax.secretExpires ? `, expires ${day(pax.secretExpires)}` : ''}`);
  }
  if (config.sharePoint) ui.info(`Files:        ${describeFolder(config.sharePoint)}`);
  const ws = config.fabric?.workspaceId;
  const sm = config.semanticModel;
  if (ws && sm?.id) {
    ui.heading('Power BI');
    let gone = false;
    try {
      const [last] = await api.powerBi.refreshes(ws, sm.id, 1);
      ui.info(`Model:        ${last ? `${last.status}, ${when(last.endTime ?? last.startTime)}` : 'not refreshed yet'}`);
      if (last?.status === 'Failed') ok = false;
    } catch (err) {
      if (!isGone(err)) throw err;
      ui.warn(`The model isn't in the workspace any more. To publish it again, run: ${commandLine('update')}`);
      ok = false;
      gone = true;
    }
    if (!gone && config.powerBi?.refreshAt && !(await scheduleStatus(ctx, ws, sm.id))) ok = false;
  }
  if (config.managedApp?.url) ui.info(`App:          ${config.managedApp.url}`);
  return ok;
}

/**
 * Status's line for the model's daily refresh. A schedule that can't be read only warns.
 * @param {Ctx} ctx
 * @param {string} ws
 * @param {string} id
 * @returns {Promise<boolean>}  False when the schedule is off.
 */
async function scheduleStatus(ctx, ws, id) {
  const { ui, api } = ctx;
  /** @type {any} */
  let s;
  try {
    s = await api.powerBi.refreshSchedule(ws, id);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    ui.warn(`Couldn't read the model's refresh schedule: ${messageOf(err).slice(0, 300)}`);
    return true;
  }
  if (s?.enabled === false) {
    ui.warn(`The model's daily refresh is off. ${SCHEDULE_OFF_WHY}`);
    ui.info(`It turns back on after a refresh that works. To refresh now, run: ${commandLine('refresh')}`);
    return false;
  }
  const days = Array.isArray(s?.days) ? s.days : [];
  const times = Array.isArray(s?.times) ? s.times : [];
  const on = days.length && days.length < 7 ? `on ${days.join(', ')}` : 'daily';
  ui.info(`Schedule:     ${on}${times.length ? ` at ${times.join(' and ')}` : ''}${s?.localTimeZoneId ? ` (${s.localTimeZoneId})` : ''}`);
  return true;
}

/**
 * The commands on a PAX record. `install` and `prereqs` are the caller's.
 * @param {Ctx} ctx
 * @param {string} command
 * @param {PaxOptions} [opts]
 * @returns {Promise<boolean>}
 */
export async function paxCommand(ctx, command, opts = {}) {
  const { config } = ctx;
  if (NEEDS_INSTALL.has(command) && !config.pax?.task?.registeredAt) {
    throw new Error(`The PAX refresh isn't set up from ${PRODUCT.recordFile} yet. To set it up, run: ${commandLine('install')}`);
  }
  switch (command) {
    case 'update':
      ctx.ui.heading(`Updating ${PRODUCT.name}`);
      return paxInstall(ctx, await paxPreflight(ctx), { wait: opts.wait });
    case 'run':
      if (opts.backfillDays) return reloadHistory(ctx, opts.backfillDays);
      return startAndWatch(ctx, { wait: opts.wait, first: !readState(paxHostOf(ctx))?.lastSuccessUtc });
    case 'rerun-failed':
      throw new Error(`rerun-failed is for the Fabric route. To run PAX again now, run: ${commandLine('run')}`);
    case 'status':
      return paxStatus(ctx);
    case 'check':
      paxHostOf(ctx);
      return confirmFolderAccess(ctx);
    case 'refresh':
      return (await loadPaxModel(ctx, { wait: opts.wait ?? true })).ok;
    case 'access': {
      await accessCommand(ctx, paxModels(config));
      // The app is shared with the group when it's deployed, so a new group needs it shared again.
      const group = config.access?.groupId;
      const deployed = config.managedApp;
      if (group && deployed?.deployedAt && !(deployed.sharedWith ?? []).includes(group)) {
        ctx.ui.info(`The ${PRODUCT.managedApp.name} app isn't shared with ${config.access?.groupName ?? 'the viewer group'} yet. To share it, run: ${commandLine('deploy-app')}`);
      }
      return true;
    }
    case 'rotate-secret':
      return rotateSecret(ctx);
    case 'deploy-app': {
      if (config.pax) config.pax.deployApp = true;
      const r = await deployTheApp(ctx, ctx.appDeps ?? {}, { force: true, environmentId: ctx.environmentId });
      return r.ok;
    }
    case 'upload':
      return paxUpload(ctx, { files: opts.files ?? [], remoteFolder: opts.folder });
    case 'uninstall':
      return paxUninstall(ctx);
    default:
      throw new Error(`"${command}" isn't a command on the PAX + SharePoint route.`);
  }
}

/**
 * Takes the route off: the task, the app, the site grant, the report and, if asked, the app
 * registration, then the secret and the files on this PC. SharePoint keeps its files.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>} False when something couldn't be removed.
 */
export async function paxUninstall(ctx) {
  const { config, ui, api } = ctx;
  const pax = config.pax;
  const app = config.app;
  const ws = config.fabric;
  const sm = config.semanticModel;
  const host = paxHostOf(ctx);
  ui.heading(`Uninstalling ${PRODUCT.name}`);
  const sure = await ui.confirm(
    "Remove the scheduled refresh and its files from this PC, the app, and the app's access to the SharePoint site?",
    true,
  );
  if (!sure) {
    ui.note('Nothing was removed.');
    return false;
  }
  let ok = true;
  /**
   * @param {string} what
   * @param {() => Promise<unknown>} remove
   * @returns {Promise<boolean>} Whether it's gone.
   */
  const take = async (what, remove) => {
    try {
      await remove();
      ui.ok(`Removed ${what}.`);
      return true;
    } catch (err) {
      if (isGone(err)) {
        ui.ok(`${what[0].toUpperCase()}${what.slice(1)} was already gone.`);
        return true;
      }
      ui.warn(`Couldn't remove ${what}: ${messageOf(err)}`);
      ok = false;
      return false;
    }
  };
  /**
   * @param {string} what
   * @param {() => Promise<unknown>} fn
   */
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      ui.warn(`Couldn't remove ${what}: ${messageOf(err)}`);
      ok = false;
    }
  };

  const taskName = pax?.task?.name;
  if (taskName) {
    await attempt(`the task ${taskName}`, async () => {
      if (await unregisterTask(host, taskName)) ui.ok(`Removed the task ${c.bold(taskName)}.`);
      else ui.ok(`The task ${taskName} wasn't on this PC.`);
    });
  }
  await attempt('the app', async () => {
    if (!(await removeTheApp(ctx, ctx.appDeps ?? {})).ok) ok = false;
  });
  await attempt("the app's access to the SharePoint site", async () => {
    if (!(await removeSiteGrant(ctx))) ok = false;
  });

  const wsId = ws?.workspaceId;
  if (wsId) {
    const wsName = ws.workspaceName ?? PRODUCT.pax.workspace;
    if (ws.createdWorkspace) {
      if (await ui.confirm(`Delete workspace "${wsName}" and everything in it?`, true)) {
        await take(`workspace "${wsName}"`, () => api.powerBi.deleteGroup(wsId));
      } else ui.note(`Left workspace "${wsName}" alone.`);
    } else {
      const reportId = sm?.report?.id;
      if (reportId) await take(`the report ${sm?.report?.name ?? PRODUCT.pax.report}`, () => api.powerBi.deleteReport(wsId, reportId));
      const modelId = sm?.id;
      const modelName = sm?.name ?? PRODUCT.pax.model;
      if (modelId && (await ui.confirm(`Delete the semantic model ${modelName} too?`, true))) {
        await take(`the semantic model ${modelName}`, () => api.powerBi.deleteDataset(wsId, modelId));
      }
    }
  }

  const objectId = app?.objectId;
  let appKept = !!objectId;
  if (objectId && !app?.existing) {
    const appName = app?.displayName ?? PRODUCT.pax.app;
    if (await ui.confirm(`Delete the app registration ${appName} too?`, false)) {
      // A registration that couldn't be deleted keeps working, so its secret still comes off.
      appKept = !(await take(`the app registration ${appName}`, () => api.graph.deleteApplication(objectId)));
    }
  }
  if (appKept && objectId && pax) {
    const keyId = pax.secretKeyId;
    if (keyId) await take('the client secret from the app registration', () => api.graph.removePassword(objectId, keyId));
    await attempt('old client secrets', () => removeRetired(ctx, pax, objectId));
  }

  await attempt('the client secret from Credential Manager', async () => {
    const target = pax?.credentialTarget ?? credentialTarget(config);
    if (await removeSecret(host, target)) ui.ok(`Removed the client secret from Credential Manager (${target}).`);
  });
  const root = paxPaths(host).root;
  await attempt(`the files in ${root}`, async () => {
    if (removeLocal(host)) ui.ok(`Removed ${root}.`);
  });

  ui.heading('Left alone');
  if (config.sharePoint) {
    ui.note(`The files in ${describeFolder(config.sharePoint)}. SharePoint keeps them: delete them there if you don't need them.`);
  }
  ui.note(`The ${PRODUCT.viewerGroup} group, PowerShell 7 and Python, which other things may use.`);
  ui.note(`${PRODUCT.recordFile}. Move it aside before you install again, or the installer picks this set-up up.`);
  return ok;
}
