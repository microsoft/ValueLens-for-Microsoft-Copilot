// @ts-check
/**
 * Runs installer commands for the browser wizard, one at a time. Signs in once and keeps the
 * sign-in for the next command, the way one terminal run does for its steps.
 */
import { collectedLabels } from './catalog.js';
import { loadConfig } from './config.js';
import { connect as realConnect, createCtx, runCommand } from './install.js';
import { fromExe } from './launch.js';
import { loadSources } from './sources.js';
import { describeSchedule, modelDeployed } from './steps/fabric.js';

export const WEB_COMMANDS = ['install', 'update', 'run', 'check', 'refresh', 'deploy-app', 'status', 'rotate-secret', 'uninstall'];
const METHODS = ['browser', 'device-code', 'azure-cli'];

/** @typedef {'browser' | 'device-code' | 'azure-cli'} Method */
/** @typedef {{ command: string, method?: Method, tenant?: string, backfillDays?: number, wait?: boolean }} StartRequest */

/**
 * What the home page shows about an install record.
 * @param {import('./config.js').InstallConfig} config
 */
export function describeRecord(config) {
  const f = config.fabric;
  const az = config.azure;
  const sm = config.semanticModel;
  const fa = config.fabricApp;
  const azure = config.target === 'azure';
  const installed = azure ? !!(az?.subscriptionId && az.resourceGroup) : !!(f.workspaceId && f.lakehouseId);
  return {
    tenantId: config.tenantId,
    installed,
    workspace: azure ? az?.resourceGroup : f.workspaceName ?? f.workspaceId,
    workspaceUrl: azure ? az?.outputs?.webUrl : f.workspaceId ? `https://app.fabric.microsoft.com/groups/${f.workspaceId}` : undefined,
    lakehouse: azure ? az?.outputs?.sqlDatabaseName : f.lakehouseName,
    schedule: f.scheduleId ? describeSchedule(config.schedule) : undefined,
    data: collectedLabels(config.modules),
    model: sm.id ? sm.name : undefined,
    app: azure && az?.outputs?.webUrl ? { name: 'Analytics Hub', url: az.outputs.webUrl } : fa.itemId ? { name: fa.name ?? 'Analytics Hub', url: fa.url } : undefined,
    secretExpires: (azure ? az?.sqlReader?.secretExpiry : config.app.secretExpires)?.slice(0, 10),
    firstRun: config.firstRun?.status,
    can: {
      update: installed,
      run: installed && (azure || !!f.pipelineId),
      check: !azure && installed && !!f.notebooks.dataCheck,
      refresh: azure ? !!az?.powerBi?.datasetId : !!sm.id,
      'deploy-app': !azure && modelDeployed(config),
      status: true,
      'rotate-secret': azure ? !!az?.sqlReader?.clientId : !!(config.app.appId && config.keyVault.uri),
      uninstall: azure && installed,
    },
  };
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
 * }} o
 */
export function createSession(o) {
  const connect = o.connect ?? realConnect;
  /** @type {{ api: import('./install.js').Apis, user: import('./install.js').User, method: Method, tenant: string } | null} */
  let signedIn = null;
  /** @type {string | null} */
  let running = null;
  /** @type {Promise<void>} */
  let current = Promise.resolve();

  function state() {
    /** @type {ReturnType<typeof describeRecord> | null} */
    let record = null;
    /** @type {string | undefined} */
    let recordError;
    try {
      const r = loadConfig(o.configFile);
      if (r.existed) record = describeRecord(r.config);
    } catch (err) {
      recordError = describeError(err);
    }
    return {
      version: o.version,
      exe: fromExe(),
      configFile: o.configFile,
      record,
      recordError,
      running,
      user: signedIn ? { upn: signedIn.user.upn, displayName: signedIn.user.displayName, tenantId: signedIn.user.tenantId, method: signedIn.method } : null,
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
    ui.emit({ type: 'command', command, state: 'running' });
    try {
      const { config, existed } = loadConfig(o.configFile);
      if (command !== 'install' && !existed) throw new Error(`No install record at ${o.configFile}. Set up Analytics Hub first.`);
      const sources = loadSources(o.sourceDir);
      const tenant = (req.tenant ?? '').trim() || config.tenantId || '';
      const reuse = signedIn && signedIn.method === method && (!tenant || tenant === signedIn.tenant || tenant === signedIn.user.tenantId);
      if (!reuse || !signedIn) {
        signedIn = null;
        ui.emit({ type: 'signin', state: 'started', method });
        const { api, user } = await connect({ tenantId: tenant || undefined, method, ui, debug: o.debug });
        signedIn = { api, user, method, tenant };
      }
      ui.emit({ type: 'signin', state: reuse ? 'reused' : 'done', user: { upn: signedIn.user.upn, displayName: signedIn.user.displayName, tenantId: signedIn.user.tenantId } });
      const ctx = createCtx({ ui, config, file: o.configFile, api: signedIn.api, user: signedIn.user, sources });
      const ok = await runCommand(ctx, command, { wait: req.wait !== false, backfillDays: req.backfillDays });
      ui.emit({ type: 'command', command, state: ok ? 'done' : 'failed', ...(ok ? {} : { error: 'It didn\'t finish successfully. The details are above.' }) });
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'ExitPromptError') ui.emit({ type: 'command', command, state: 'cancelled' });
      else ui.emit({ type: 'command', command, state: 'failed', error: describeError(err) });
    } finally {
      running = null;
    }
  }

  return {
    state,
    get running() {
      return running;
    },
    /** Resolves when the command that is running now has finished. */
    settled: () => current,
    /**
     * Starts a command and returns straight away; its progress arrives as events.
     * @param {StartRequest} req
     * @returns {{ ok: true } | { ok: false, status: number, error: string }}
     */
    start(req) {
      if (running) return { ok: false, status: 409, error: `"${running}" is still running.` };
      if (!WEB_COMMANDS.includes(req?.command)) return { ok: false, status: 400, error: 'Unknown command.' };
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
