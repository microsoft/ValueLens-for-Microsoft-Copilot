// @ts-check
/**
 * A stand-in for the PC the PAX route runs on: PowerShell 7, Python, Windows Credential Manager,
 * Task Scheduler and the refresh script. Nothing runs: each call answers with the JSON the runner
 * scripts print. The refresh's folder is in a new temp folder.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { commandLine } from '../src/launch.js';
import { PRODUCT } from '../src/product.js';
import { paxPaths, PWSH_PROBE } from '../src/steps/pax/local.js';

/**
 * @typedef {import('../src/steps/pax/local.js').RunResult} RunResult
 * @typedef {import('../src/steps/pax/local.js').PaxHost} PaxHost
 *
 * One call to the fake PC. `key` names what was called: `pwsh` (the probe), `python`,
 * `credential <Action>`, `task <Action>`, `refresh check`, `refresh upload` or `refresh run`.
 * @typedef {{ key: string, file: string, args: string[], input?: string }} PaxCall
 *
 * @typedef {'success' | 'no-data' | 'failed' | 'running' | 'busy' | 'partial' | 'held' | 'held-upn'} FakeRun
 *   `partial` is a success that stopped part way through a long load, leaving the rest to the
 *   next run, as refresh.ps1 does to stay inside the task's time limit. `held` is a user
 *   directory with under half the rows of the last one, which refresh.ps1 holds back from
 *   SharePoint unless it runs with -AcceptDrop. `held-upn` has no UPN column, which -AcceptDrop
 *   doesn't publish.
 */

/** What refresh.ps1 says when it stops part way through a load. */
export const PARTIAL_MESSAGE = "This run loaded activity up to 2026-05-14, then stopped to stay inside the task's time limit. SharePoint has everything loaded so far, and the next scheduled run carries on from there.";

const ORG = PRODUCT.pax.files.users;
/** Where refresh.ps1 puts a user directory it held back. */
export const HELD_FILE = `C:\\Users\\admin\\${PRODUCT.home}\\${PRODUCT.pax.folder}\\data\\held-back-20260601-120000-${ORG}`;
const KEPT = `SharePoint's ${ORG} stays as it was, and PAX's file is now ${HELD_FILE}.`;

/** What refresh.ps1 says when it holds back a drop, with the hint refresh.json gives it. */
export const HELD_MESSAGE = `Held back: the user directory PAX read this run has 4 rows, under half of the 20 rows in the ${ORG} this PC last published. ${KEPT} If the drop is genuine, run: ${commandLine('run --accept-drop')}`;

/** What refresh.ps1 says when it holds back a user directory with no UPN column. */
export const HELD_UPN_MESSAGE = `Held back: the user directory PAX read this run has no UPN column, such as userPrincipalName. It has 3 columns and 20 rows. ${KEPT}`;

/** What refresh.ps1 -AcceptDrop says when it publishes a drop. */
export const ACCEPTED_MESSAGE = `SharePoint's ${ORG} holds the user directory as this run read it. This run accepted the drop to 4 rows from the 20 rows this PC last published.`;

/** A script that printed one line of JSON and exited 0. @param {any} json @returns {RunResult} */
export const printed = (json) => ({ code: 0, stdout: `${JSON.stringify(json)}\n`, stderr: '' });

/** A script that failed the way the runner scripts do. @param {string} message @param {number} [code] @returns {RunResult} */
export const failed = (message, code = 1) => ({ code, stdout: '', stderr: `ERROR: ${message}\n` });

/** A program that isn't installed. @type {RunResult} */
export const missing = Object.freeze({ code: null, stdout: '', stderr: 'spawn ENOENT', missing: true });

/** @param {string[]} args @param {string} name */
const argOf = (args, name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const TASK_NEVER_RAN = 0x41303;
const EXIT_BUSY = 2;
const EXIT_NO_DATA = 3;

/**
 * A fake PC. By default it has PowerShell 7.4 (RemoteSigned, full language mode) and Python 3.12,
 * the SharePoint folder check passes, and a started task or a refresh run finishes at once with
 * `run`'s result. `answer` replaces a call's next result: push a RunResult, or a function of the
 * call, under the call's key.
 *
 * A test that leaves a run `running` needs a clock that moves, or paxInstall watches it forever.
 *
 * @param {{
 *   platform?: string,
 *   cloudShell?: boolean,
 *   pwsh?: { version?: string, policy?: string, languageMode?: string, timeZone?: string } | null,
 *   python?: Record<string, string> | null,
 *   folderCheck?: Record<string, any>,
 *   logonType?: string,
 *   run?: FakeRun,
 *   now?: () => Date,
 * }} [o]
 *   `python` maps a command PAX tries (python, py -3.12, python3…) to the version it reports.
 */
export function fakePaxHost(o = {}) {
  const base = mkdtempSync(join(tmpdir(), 'valuelens-pax-test-'));
  const root = join(base, PRODUCT.home, PRODUCT.pax.folder);
  const now = o.now ?? (() => new Date());
  /** A file that exists, as a registered task's pwsh.exe must. */
  const pwshPath = process.execPath;
  const pythons = o.python === null ? {} : (o.python ?? { python: '3.12.4' });
  /** @type {PaxCall[]} */
  const calls = [];
  /** Secrets in Credential Manager, by target. @type {Record<string, { userName: string, secret: string, lastWrittenUtc: string }>} */
  const credentials = {};
  /** Scheduled tasks, by name, as task.ps1 reports them. @type {Record<string, Record<string, any>>} */
  const tasks = {};
  /** Files uploaded with refresh.ps1 -Upload. @type {{ file: string, remoteName?: string, remoteFolder?: string }[]} */
  const uploads = [];
  /** Each refresh.ps1 run in this window, with its -Days and -AcceptDrop. @type {{ days?: number, acceptDrop?: true }[]} */
  const refreshes = [];
  /** @type {Record<string, (RunResult | ((call: PaxCall) => RunResult))[]>} */
  const answer = {};
  const state = { run: /** @type {FakeRun} */ (o.run ?? 'success') };

  /**
   * Writes state.json as refresh.ps1 does when a run ends.
   * @param {Record<string, any>} s
   */
  const writeState = (s) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(paxPaths(host).state, `${JSON.stringify(s, null, 2)}\n`);
  };

  /**
   * Ends a run with `result`: state.json says how it went and the task is ready again.
   * @param {FakeRun} result
   * @param {string} [taskName]
   * @param {number} [days]  The load's -Days, for a partial run. Default 90.
   * @param {boolean} [acceptDrop]  The run had -AcceptDrop, which publishes a `held` drop.
   */
  const finishRun = (result, taskName, days = 90, acceptDrop = false) => {
    const at = now().toISOString();
    const task = taskName ? tasks[taskName] : undefined;
    if (result === 'running') {
      if (task) Object.assign(task, { state: 'Running', lastRunTime: at, lastTaskResult: 0x41301, neverRan: false });
      return;
    }
    if (result === 'busy') {
      if (task) Object.assign(task, { state: 'Ready', lastRunTime: at, lastTaskResult: EXIT_BUSY, neverRan: false });
      return;
    }
    const accepted = result === 'held' && acceptDrop;
    const held = !accepted && (result === 'held' || result === 'held-upn');
    const heldMessage = result === 'held' ? HELD_MESSAGE : HELD_UPN_MESSAGE;
    const worked = result === 'success' || result === 'partial' || accepted;
    const partial = result === 'partial';
    const from = now().getTime() - days * 86_400_000;
    writeState({
      lastRunUtc: at,
      lastResult: worked ? 'success' : held ? 'failed' : result,
      lastError: result === 'failed' ? 'PAX could not sign in.' : held ? heldMessage : null,
      lastMessage: result === 'no-data' ? 'PAX found no Copilot activity.' : partial ? PARTIAL_MESSAGE : accepted ? ACCEPTED_MESSAGE : held ? heldMessage : null,
      ...(worked ? { lastSuccessUtc: at } : {}),
      ...(held ? { heldBack: { check: result === 'held' ? 'drop' : 'upn', rows: result === 'held' ? 4 : 20, columns: 3, lastRows: 20, file: HELD_FILE } } : {}),
      ...(partial
        ? {
            progress: {
              fromUtc: new Date(from).toISOString(),
              days,
              seed: false,
              windowDays: 7,
              throughUtc: new Date(from + 14 * 86_400_000).toISOString(),
              pending: null,
            },
          }
        : {}),
      lastLog: join(root, 'logs', 'refresh.log'),
    });
    if (task) Object.assign(task, { state: 'Ready', lastRunTime: at, lastTaskResult: worked || result === 'no-data' ? 0 : 1, neverRan: false });
  };

  /** @param {PaxCall} call @returns {RunResult} */
  const respond = (call) => {
    const { key, args } = call;
    if (key === 'pwsh') {
      if (o.pwsh === null) return missing;
      return printed({
        path: pwshPath,
        version: o.pwsh?.version ?? '7.4.6',
        policy: o.pwsh?.policy ?? 'RemoteSigned',
        languageMode: o.pwsh?.languageMode ?? 'FullLanguage',
        timeZone: o.pwsh?.timeZone ?? 'GMT Standard Time',
      });
    }
    if (key === 'python') {
      const version = pythons[[call.file, ...args.slice(0, -1)].join(' ')];
      return version ? { code: 0, stdout: `Python ${version}\n`, stderr: '' } : missing;
    }
    const target = argOf(args, '-Target') ?? '';
    const name = argOf(args, '-TaskName') ?? '';
    switch (key) {
      case 'credential Write':
        credentials[target] = { userName: argOf(args, '-UserName') ?? '', secret: call.input ?? '', lastWrittenUtc: now().toISOString() };
        return printed({ target, written: true });
      case 'credential Test': {
        const cred = credentials[target];
        return printed({ target, exists: !!cred, ...(cred ? { userName: cred.userName, lastWrittenUtc: cred.lastWrittenUtc } : {}) });
      }
      case 'credential Delete': {
        const had = !!credentials[target];
        delete credentials[target];
        return printed({ target, deleted: had });
      }
      case 'task Register': {
        const script = argOf(args, '-ScriptPath') ?? '';
        const config = argOf(args, '-ConfigPath') ?? '';
        tasks[name] = {
          taskName: name,
          exists: true,
          state: 'Ready',
          lastRunTime: null,
          lastTaskResult: TASK_NEVER_RAN,
          neverRan: true,
          nextRunTime: null,
          userId: 'PC\\admin',
          logonType: o.logonType ?? 'Interactive',
          runLevel: 'Limited',
          execute: pwshPath,
          arguments: `-NoProfile -NonInteractive -WindowStyle Hidden -File "${script}" -Config "${config}"`,
          workingDirectory: dirname(config),
          at: argOf(args, '-At'),
          description: argOf(args, '-Description'),
        };
        return printed(tasks[name]);
      }
      case 'task Info':
        return printed(tasks[name] ?? { taskName: name, exists: false });
      case 'task Start': {
        if (!tasks[name]) return failed(`The task ${name} isn't registered.`);
        finishRun(state.run, name);
        return printed(tasks[name]);
      }
      case 'task Unregister': {
        const had = !!tasks[name];
        delete tasks[name];
        return printed({ taskName: name, removed: had });
      }
      case 'refresh check':
        return printed(o.folderCheck ?? { ok: true, siteId: 'contoso.sharepoint.com,site-guid,web-guid', driveId: 'drive-1', folder: PRODUCT.name });
      case 'refresh upload':
        uploads.push({ file: argOf(args, '-Upload') ?? '', ...(argOf(args, '-RemoteName') ? { remoteName: argOf(args, '-RemoteName') } : {}), ...(argOf(args, '-RemoteFolder') ? { remoteFolder: argOf(args, '-RemoteFolder') } : {}) });
        return { code: 0, stdout: 'Uploaded.\n', stderr: '' };
      case 'refresh run': {
        const days = argOf(args, '-Days');
        const acceptDrop = args.includes('-AcceptDrop');
        refreshes.push({ ...(days ? { days: Number(days) } : {}), ...(acceptDrop ? { acceptDrop: /** @type {const} */ (true) } : {}) });
        if (state.run === 'busy') return failed('Another refresh is running.', EXIT_BUSY);
        finishRun(state.run === 'running' ? 'success' : state.run, undefined, days ? Number(days) : undefined, acceptDrop);
        if (state.run === 'no-data') return { code: EXIT_NO_DATA, stdout: 'PAX found no Copilot activity.\n', stderr: '' };
        if (state.run === 'failed') return failed('PAX could not sign in.');
        if (state.run === 'held-upn' || (state.run === 'held' && !acceptDrop)) return failed(state.run === 'held' ? HELD_MESSAGE : HELD_UPN_MESSAGE);
        return { code: 0, stdout: 'Done.\n', stderr: '' };
      }
      default:
        return failed(`The fake PC doesn't know ${key}.`);
    }
  };

  /** @type {PaxHost} */
  const host = {
    platform: o.platform ?? 'win32',
    cloudShell: o.cloudShell ?? false,
    root,
    pwshCandidates: ['pwsh'],
    run: async (file, args, opts = {}) => {
      const at = args.indexOf('-File');
      const script = at >= 0 ? basename(args[at + 1]).replace(/\.ps1$/i, '') : undefined;
      const action = argOf(args, '-Action');
      const key = args.includes(PWSH_PROBE)
        ? 'pwsh'
        : args.at(-1) === '--version'
          ? 'python'
          : script === 'refresh'
            ? args.includes('-Check')
              ? 'refresh check'
              : args.includes('-Upload')
                ? 'refresh upload'
                : 'refresh run'
            : `${script ?? file}${action ? ` ${action}` : ''}`;
      /** @type {PaxCall} */
      const call = { key, file, args: [...args], ...(opts.input !== undefined ? { input: opts.input } : {}) };
      calls.push(call);
      const queued = answer[key]?.shift();
      if (queued) return typeof queued === 'function' ? queued(call) : queued;
      return respond(call);
    },
  };

  return {
    host,
    base,
    calls,
    /** The keys of the calls so far, in order. */
    keys: () => calls.map((c) => c.key),
    credentials,
    tasks,
    uploads,
    refreshes,
    answer,
    writeState,
    finishRun,
    /** What a started task or a refresh run does from now on. @param {FakeRun} result */
    setRun: (result) => {
      state.run = result;
    },
  };
}
