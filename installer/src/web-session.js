// @ts-check
/**
 * Runs installer commands for the browser wizard, one at a time. Signs in once and keeps the
 * sign-in for the next command, the way one terminal run does for its steps.
 */
import { existsSync } from 'node:fs';
import { collectedLabels } from './catalog.js';
import { archiveConfig, loadConfig, secretMode } from './config.js';
import { connect as realConnect, createCtx, runCommand, showPrereqs } from './install.js';
import { bundled, commandLine, installerWindow, launcher, reopenHint, updateHint } from './launch.js';
import { checkPrereqs } from './prereqs.js';
import { PRODUCT } from './product.js';
import { loadSources } from './sources.js';
import { describeSchedule, recordWorkspaceGone, staleRecordMessage } from './steps/fabric.js';
import { isResumeLater } from './steps/identity.js';
import { defaultPaxHost, readState } from './steps/pax/local.js';
import { endedSince } from './steps/pax/flow.js';
import { paxCollectedLabels } from './steps/pax/plan.js';
import { describeFolder } from './steps/pax/site.js';
import { reportUrl, tenantQuery } from './steps/report.js';
import { isPax, TARGETS } from './target.js';
import { routerWanted } from './uploads.js';
import { SETUP_SECTIONS, setupRecovery } from './setup.js';

export const WEB_COMMANDS = ['install', 'update', 'run', 'rerun-failed', 'check', 'refresh', 'status', 'rotate-secret', 'access', 'upload', 'deploy-app', 'uninstall', 'prereqs'];
/** Commands that work before anything is installed. */
const NO_RECORD = ['install', 'prereqs'];
const METHODS = ['browser', 'device-code', 'azure-cli'];

/** @typedef {'browser' | 'device-code' | 'azure-cli'} Method */
/** @typedef {{ command: string, method?: Method, tenant?: string, backfillDays?: number, wait?: boolean, section?: string, retry?: boolean, target?: import('./target.js').Target }} StartRequest */

/**
 * What the home page shows about an install record.
 * @param {import('./config.js').InstallConfig} config
 * @param {Record<string, any>} [local]  On the PAX route, the refresh's state.json on this PC.
 */
export function describeRecord(config, local) {
  if (isPax(config)) return describePaxRecord(config, local);
  const f = config.fabric;
  const sm = config.semanticModel;
  const installed = !!(f.workspaceId && f.lakehouseId);
  return {
    tenantId: config.tenantId,
    target: config.target,
    installed,
    workspace: f.workspaceName ?? f.workspaceId,
    workspaceUrl: f.workspaceId ? `https://app.fabric.microsoft.com/groups/${f.workspaceId}${tenantQuery(config.tenantId)}` : undefined,
    lakehouse: f.lakehouseName,
    schedule: f.scheduleId ? describeSchedule(config.schedule) : undefined,
    data: collectedLabels(config.modules),
    model: sm.id ? sm.name : undefined,
    reportUrl: f.workspaceId && sm.report?.id ? reportUrl(f.workspaceId, sm.report.id, config.tenantId) : undefined,
    secretExpires: config.app.secretExpires?.slice(0, 10),
    firstRun: config.firstRun?.status,
    historyDays: config.history?.days,
    viewers: config.access?.groupId ? config.access.groupName : undefined,
    can: {
      update: installed,
      run: installed && !!f.pipelineId,
      'rerun-failed': installed && !!f.pipelineId,
      check: installed && !!f.notebooks.dataCheck,
      refresh: !!sm.id,
      status: true,
      'rotate-secret': !!(config.app.appId && (secretMode(config) === 'notebook' ? installed : config.keyVault.uri)),
      access: !!sm.id,
      upload: installed && !!f.notebooks.uploadRouter && routerWanted(config.dataSources),
      'deploy-app': false,
      uninstall: !!f.workspaceId,
    },
  };
}

/** The first load's outcome, in the words the Fabric route's pipeline uses. */
const FIRST_RUN_WORDS = Object.freeze({ success: 'Completed', 'no-data': 'FinishedWithNoData', failed: 'Failed' });

/**
 * How the PAX route's first load went. It stays on the record until a refresh succeeds and the
 * installer next looks, so this PC's state.json, written as each refresh ends, has the last word.
 * @param {import('./config.js').FirstRun | undefined} run
 * @param {Record<string, any> | undefined} local
 */
export function paxFirstRun(run, local) {
  if (!run?.startedAt) return local?.lastSuccessUtc ? 'Completed' : undefined;
  const ended = endedSince(local, run.startedAt)?.status ?? run.result;
  return ended ? FIRST_RUN_WORDS[ended] : 'InProgress';
}

/**
 * What the home page shows about a PAX record: the scheduled refresh on this PC, the SharePoint
 * folder it writes to, the report in Power BI and the app.
 * @param {import('./config.js').InstallConfig} config
 * @param {Record<string, any>} [local]
 */
function describePaxRecord(config, local) {
  const pax = config.pax ?? {};
  const task = pax.task;
  const wsId = config.fabric.workspaceId;
  const sm = config.semanticModel;
  const sp = config.sharePoint;
  const app = config.managedApp;
  const installed = !!task?.registeredAt;
  const signedIn = config.powerBi?.credentials === 'set';
  return {
    tenantId: config.tenantId,
    target: config.target,
    installed,
    workspace: config.fabric.workspaceName ?? wsId,
    workspaceUrl: wsId ? `https://app.powerbi.com/groups/${wsId}${tenantQuery(config.tenantId)}` : undefined,
    lakehouse: undefined,
    files: sp ? describeFolder(sp) : undefined,
    filesUrl: sp?.folderUrl,
    schedule: task?.name ? `${task.name}, daily at ${task.at}${task.logonType === 'Interactive' ? ", while you're signed in to this PC" : ''}` : undefined,
    data: paxCollectedLabels(config),
    model: sm.id ? (signedIn ? sm.name : `${sm.name}, not signed in to SharePoint yet`) : undefined,
    reportUrl: wsId && sm.report?.id ? reportUrl(wsId, sm.report.id, config.tenantId) : undefined,
    secretExpires: pax.secretExpires?.slice(0, 10),
    firstRun: paxFirstRun(pax.firstRun, local),
    historyDays: config.history?.days,
    viewers: config.access?.groupId ? config.access.groupName : undefined,
    app: app?.url ? 'Open the app' : app?.skipped ? `Not deployed. ${app.skipped.why}` : pax.deployApp === false ? 'Not deployed' : undefined,
    appUrl: app?.url,
    can: {
      update: installed,
      run: installed,
      'rerun-failed': false,
      check: installed,
      refresh: installed && !!sm.id,
      status: installed,
      'rotate-secret': installed && !!config.app.appId,
      access: !!sm.id,
      // Files sent with upload don't feed this route's report, so the page leaves it to the command line.
      upload: false,
      'deploy-app': installed,
      uninstall: !!(task || pax.credentialTarget || sp || config.app.appId),
    },
  };
}

/**
 * What the home page keeps of a prerequisites check. canAssignDirectoryRoles: Global Administrator or
 * Privileged Role Administrator is active, so the user can assign directory roles themselves.
 * @param {string} upn
 * @param {import('./prereqs.js').Prereq[]} items
 * @param {import('./target.js').Target} [target]  The route it checked.
 */
export const prereqsSnapshot = (upn, items, target = 'fabric') => ({
  at: new Date().toISOString(),
  upn,
  target,
  items,
  canAssignDirectoryRoles: items.some((i) => i.id === 'consent-role' && i.status === 'met'),
});

/** The PAX refresh's state.json on this PC, when there is one and it can be read. @param {import('./steps/pax/local.js').PaxHost} [host] */
function localPaxState(host) {
  try {
    return readState(host ?? defaultPaxHost());
  } catch {
    return undefined;
  }
}

/** @param {any} err */
export function describeError(err) {
  if (/device_code_expired|expired_token|code_expired/i.test(String(err?.message ?? err?.errorCode ?? ''))) {
    return 'The sign-in code expired before it was used. Start again and enter the new code within 15 minutes.';
  }
  return String(err?.message ?? err);
}

/**
 * @param {{
 *   ui: import('./web-ui.js').WebUi,
 *   configFile: string,
 *   sourceDir?: string,
 *   version: string,
 *   tenantId?: string,
 *   method?: Method,
 *   connect?: typeof realConnect,
 *   debug?: (m: string) => void,
 *   paxHost?: import('./steps/pax/local.js').PaxHost,
 * }} o  paxHost: the PC the PAX route's steps run on, when it isn't this one. Tests pass a fake.
 */
export function createSession(o) {
  const connect = o.connect ?? realConnect;
  /** @type {{ api: import('./install.js').Apis, user: import('./install.js').User, method: Method, tenant: string, getToken?: (resource: import('./auth.js').Resource) => Promise<string> } | null} */
  let signedIn = null;
  /** @type {string | null} */
  let running = null;
  /** @type {Promise<void>} */
  let current = Promise.resolve();
  /** The last prerequisites check for this sign-in. @type {ReturnType<typeof prereqsSnapshot> | null} */
  let prereqs = null;
  /** @type {Promise<void>} */
  let checking = Promise.resolve();
  /** A newer installer, once the update check finds one. @type {import('./update-check.js').Update | null} */
  let update = null;
  /** What the record's workspace check found for this sign-in. @type {{ key: string, gone: Awaited<ReturnType<typeof recordWorkspaceGone>>, kept: boolean } | null} */
  let stale = null;

  /**
   * Checks once per sign-in and workspace that the record's workspace is still there.
   * @param {import('./config.js').InstallConfig} config
   */
  async function checkRecord(config) {
    if (!signedIn) return null;
    const key = `${signedIn.user.tenantId}|${config.tenantId}|${config.fabric.workspaceId}`;
    if (stale?.key !== key) {
      const gone = await recordWorkspaceGone({ config, fabric: signedIn.api.fabric, tenantId: signedIn.user.tenantId });
      stale = { key, gone, kept: false };
      o.ui.emit({ type: 'record-checked' });
    }
    return stale.kept ? null : stale.gone;
  }

  /**
   * Checks the prerequisites in the background after a sign-in, without holding up the command.
   * @param {import('./config.js').InstallConfig} config
   * @param {import('./sources.js').Sources} sources
   */
  function checkInBackground(config, sources) {
    if (!signedIn) return;
    const { api, user } = signedIn;
    checking = checkPrereqs({ api, user, config, sources, ...(o.paxHost ? { paxHost: o.paxHost } : {}) })
      .then((items) => {
        if (signedIn?.user !== user) return;
        prereqs = prereqsSnapshot(user.upn, items, config.target);
        o.ui.emit({ type: 'prereqs-ready' });
      })
      .catch((err) => o.debug?.(`Prerequisites check failed: ${describeError(err)}`));
  }

  function state() {
    /** @type {ReturnType<typeof describeRecord> | null} */
    let record = null;
    /** @type {string | undefined} */
    let recordError;
    try {
      const r = loadConfig(o.configFile);
      if (r.existed) record = describeRecord(r.config, isPax(r.config) ? localPaxState(o.paxHost) : undefined);
    } catch (err) {
      recordError = describeError(err);
    }
    return {
      version: o.version,
      exe: bundled(),
      launcher: { command: commandLine(), window: installerWindow(), reopen: reopenHint(), update: update && launcher() === 'pwsh' ? updateHint(update) : null },
      configFile: o.configFile,
      record,
      recordError,
      stale: record && stale && !stale.kept ? stale.gone : null,
      running,
      user: signedIn ? { upn: signedIn.user.upn, displayName: signedIn.user.displayName, tenantId: signedIn.user.tenantId, method: signedIn.method } : null,
      prereqs,
      update,
      defaults: { tenant: o.tenantId ?? record?.tenantId ?? '', method: o.method ?? 'browser' },
    };
  }

  /**
   * @param {StartRequest} req
   * @param {Method} method
   */
  async function execute(req, method) {
    const { ui } = o;
    const command = req.command;
    /** @type {import('./config.js').InstallConfig | undefined} */
    let currentConfig;
    ui.emit({ type: 'command', command, state: 'running' });
    try {
      const { config, existed } = loadConfig(o.configFile);
      currentConfig = config;
      if (!NO_RECORD.includes(command) && !existed) throw new Error(`No install record at ${o.configFile}. Set up ${PRODUCT.name} first.`);
      const sources = loadSources(o.sourceDir);
      const tenant = (req.tenant ?? '').trim() || config.tenantId || '';
      const reuse = signedIn && signedIn.method === method && (!tenant || tenant === signedIn.tenant || tenant === signedIn.user.tenantId);
      if (!reuse || !signedIn) {
        signedIn = null;
        prereqs = null;
        ui.emit({ type: 'signin', state: 'started', method });
        const { api, user, getToken } = await connect({ tenantId: tenant || undefined, method, ui, debug: o.debug });
        signedIn = { api, user, method, tenant, getToken };
        if (command !== 'prereqs') checkInBackground(config, sources);
      }
      ui.emit({ type: 'signin', state: reuse ? 'reused' : 'done', user: { upn: signedIn.user.upn, displayName: signedIn.user.displayName, tenantId: signedIn.user.tenantId } });
      const gone = existed ? await checkRecord(config) : null;
      if (gone && command !== 'prereqs') {
        ui.emit({ type: 'command', command, state: 'failed', stale: true, error: `${staleRecordMessage(gone)} Go back to the home page to start fresh, or keep the record.` });
        return;
      }
      const ctx = createCtx({ ui, config, file: o.configFile, api: signedIn.api, user: signedIn.user, sources, getToken: signedIn.getToken, paxHost: o.paxHost });
      ctx.setupSection = req.section;
      ctx.setupRetry = req.retry;
      let ok = true;
      if (command === 'prereqs') {
        // Prerequisites change nothing, so they can look at either route, and the record isn't saved.
        if (req.target) config.target = req.target;
        const items = await showPrereqs(ctx);
        prereqs = prereqsSnapshot(signedIn.user.upn, items, config.target);
      } else ok = await runCommand(ctx, command, { wait: req.wait !== false, backfillDays: req.backfillDays });
      ui.emit({ type: 'command', command, state: ok ? 'done' : 'failed', ...(ok ? {} : { error: 'It didn\'t finish successfully. The details are above.' }) });
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'ExitPromptError') ui.emit({ type: 'command', command, state: 'cancelled' });
      else if (isResumeLater(err)) {
        ui.warn(/** @type {Error} */ (err).message);
        ui.emit({ type: 'command', command, state: 'cancelled', paused: /** @type {Error} */ (err).message });
      } else ui.emit({ type: 'command', command, state: 'failed', error: describeError(err),
        ...(command === 'install' && currentConfig ? { recovery: setupRecovery(err, currentConfig) } : {}) });
    } finally {
      running = null;
    }
  }

  return {
    state,
    get running() {
      return running;
    },
    /**
     * Records a newer installer and tells the page to show it.
     * @param {import('./update-check.js').Update} u
     */
    setUpdate(u) {
      update = u;
      o.ui.emit({ type: 'update-available' });
    },
    /** Resolves when the command that is running now, and any background prerequisites check, have finished. */
    settled: async () => {
      await current;
      await checking;
    },
    /**
     * Sets the install record aside, as `valuelens-setup.<date>.json`, so the next install starts fresh.
     * @returns {{ ok: true, archived: string | null } | { ok: false, status: number, error: string }}
     */
    startFresh() {
      if (running) return { ok: false, status: 409, error: `"${running}" is still running.` };
      try {
        const archived = existsSync(o.configFile) ? archiveConfig(o.configFile) : null;
        if (existsSync(`${o.configFile}.draft.json`)) archiveConfig(`${o.configFile}.draft.json`);
        stale = null;
        return { ok: true, archived };
      } catch (err) {
        return { ok: false, status: 500, error: `Couldn't set the install record aside: ${describeError(err)}` };
      }
    },
    /** Keeps using the install record even though its workspace looks gone. */
    keepRecord() {
      if (stale) stale.kept = true;
      return { ok: true };
    },
    /**
     * Starts a command and returns straight away; its progress arrives as events.
     * @param {StartRequest} req
     * @returns {{ ok: true } | { ok: false, status: number, error: string }}
     */
    start(req) {
      if (running) return { ok: false, status: 409, error: `"${running}" is still running.` };
      if (!WEB_COMMANDS.includes(req?.command)) return { ok: false, status: 400, error: 'Unknown command.' };
      if (req.section !== undefined && (req.command !== 'install' || !SETUP_SECTIONS.includes(req.section))) return { ok: false, status: 400, error: 'Unknown settings category.' };
      if (req.retry !== undefined && (req.command !== 'install' || typeof req.retry !== 'boolean')) return { ok: false, status: 400, error: 'Retry is only available for setup.' };
      if (req.target !== undefined && (req.command !== 'prereqs' || !TARGETS.includes(req.target))) return { ok: false, status: 400, error: 'The route is "fabric" or "pax", and only the prerequisites check takes one.' };
      const method = req.method ?? o.method ?? 'browser';
      if (!METHODS.includes(method)) return { ok: false, status: 400, error: 'Unknown sign-in method.' };
      if (req.tenant !== undefined && (typeof req.tenant !== 'string' || !/^[A-Za-z0-9.-]{0,253}$/.test(req.tenant.trim()))) {
        return { ok: false, status: 400, error: 'Enter a tenant ID or domain, such as contoso.onmicrosoft.com.' };
      }
      if (req.backfillDays !== undefined && (!Number.isInteger(req.backfillDays) || req.backfillDays < 1 || req.backfillDays > 180)) {
        return { ok: false, status: 400, error: 'Reload from 1 to 180 days.' };
      }
      running = req.command;
      current = execute(req, /** @type {Method} */ (method));
      return { ok: true };
    },
  };
}

/** @typedef {ReturnType<typeof createSession>} Session */
