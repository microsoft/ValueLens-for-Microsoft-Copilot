// @ts-check
/**
 * The PAX route's work on this PC: checking for PowerShell 7 and, for the audit log, Python,
 * copying the refresh scripts and writing refresh.json under %LOCALAPPDATA%, keeping the app's
 * client secret in Windows Credential Manager, and the scheduled task that runs the refresh each day.
 *
 * Every script runs with `pwsh -NoProfile -NonInteractive -File`. Nothing here changes or
 * bypasses PowerShell's execution policy: when the policy won't run local unsigned scripts, the
 * installer stops and says how to change it.
 *
 * Names come only from product.js, so another product's installer can reuse this module.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandLine, inCloudShell } from '../../launch.js';
import { PRODUCT } from '../../product.js';

/** @typedef {import('../../config.js').InstallConfig} InstallConfig */

/**
 * The PAX release the refresh runs, and the SHA-256 of its script, which Run-PAX-AIBV.ps1 checks
 * before running it. Moving to a newer PAX is a change to the installer.
 */
export const PAX_RELEASE = Object.freeze({ tag: 'purview-v1.11.15', sha256: '13a8d41a70c462650207e452eb0ccab274729eb65b0d640bc0a52d6a40ad46c9' });

/** PAX supports PowerShell 7.2 or later on a PC. */
export const MIN_PWSH = Object.freeze([7, 2]);
/** PAX's -Rollup builds its files with Python 3.10 or later. */
export const MIN_PYTHON = Object.freeze([3, 10]);
/** When the scheduled refresh starts each day, in this PC's time. */
export const TASK_AT = '02:00';
/** How many days of activity the first refresh asks PAX for. */
export const SEED_DAYS = 30;

/**
 * Whether the refresh reads only the user directory (PAX -OnlyUserInfo) into one file that each
 * run replaces whole, rather than the audit log. Then there's no history to load or reload, no
 * Agent 365 file, and no need for Python.
 * @param {{ mode?: string }} [pax]  PRODUCT.pax, or a stand-in.
 */
export const userInfoMode = (pax = PRODUCT.pax) => pax.mode === 'userInfo';
/**
 * The longest a refresh may run, as task.ps1 sets it. refresh.ps1 reads a long load in windows and
 * stops between them before its own runHours budget runs out, so the next run carries on.
 */
export const RUN_LIMIT_MS = 12 * 60 * 60_000;

export const PWSH_INSTALL = 'winget install --id Microsoft.PowerShell --source winget';
export const PYTHON_INSTALL = 'winget install --id Python.Python.3.13 --scope user';

/** The scripts that ship with the installer. The PAX scripts come from the checkout. */
export const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), 'runner');
export const RUNNER_SCRIPTS = Object.freeze(['refresh.ps1', 'credential.ps1', 'task.ps1']);

/**
 * The commands PAX tries, in its order, when it looks for Python 3.10 or later. It runs the
 * first that is new enough.
 */
export const PYTHON_CANDIDATES = Object.freeze([['python'], ['py', '-3.13'], ['py', '-3.12'], ['py', '-3.11'], ['py', '-3.10'], ['python3']]);

/**
 * @typedef {object} RunResult
 * @property {number | null} code  The exit code, or null when the program didn't start or was stopped.
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} [missing]  There's no such program.
 * @property {boolean} [timedOut]  It didn't finish in time and was stopped.
 *
 * @typedef {object} RunOptions
 * @property {string} [input]  Written to the program's standard input, which is then closed.
 * @property {number} [timeoutMs]
 *
 * This PC, as the PAX route's local steps see it. Tests pass a fake.
 * @typedef {object} PaxHost
 * @property {NodeJS.Platform | string} platform
 * @property {boolean} cloudShell
 * @property {string} root  The folder that holds the scripts, refresh.json, state.json and the data.
 * @property {string[]} pwshCandidates  Where to look for PowerShell 7, in order.
 * @property {(file: string, args: string[], o?: RunOptions) => Promise<RunResult>} run
 * @property {string} [pwsh]  The pwsh.exe checkHost found.
 *
 * @typedef {object} PwshInfo
 * @property {string} path
 * @property {string} version
 * @property {string} policy  The effective execution policy.
 * @property {string} languageMode
 * @property {string} [timeZone]  This PC's Windows time zone ID.
 *
 * @typedef {object} PythonInfo
 * @property {string} command  How PAX will run it, e.g. `py -3.12`.
 * @property {string} version
 *
 * @typedef {{ part: 'pwsh' | 'python', title: string, fix: string }} HostProblem
 *
 * @typedef {object} HostCheck
 * @property {PwshInfo} [pwsh]
 * @property {PythonInfo} [python]
 * @property {HostProblem[]} problems  Anything that stops the refresh running here. Empty when it can.
 */

/**
 * Runs a program without a shell and collects what it prints.
 * @param {string} file
 * @param {string[]} args
 * @param {RunOptions} [o]
 * @returns {Promise<RunResult>}
 */
export function runProgram(file, args, o = {}) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let done = false;
    let timedOut = false;
    /** @param {RunResult} r */
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    if (o.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, o.timeoutMs);
    }
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    // A program that exits without reading its input closes the pipe under the write.
    child.stdin?.on('error', () => {});
    child.on('error', (e) => finish({ code: null, stdout: '', stderr: e.message, ...(/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? { missing: true } : {}) }));
    child.on('close', (code) =>
      finish({
        code: timedOut ? null : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ...(timedOut ? { timedOut: true } : {}),
      }),
    );
    child.stdin?.end(o.input ?? '');
  });
}

/**
 * This PC: the refresh's folder under %LOCALAPPDATA%, and PowerShell 7 on the PATH or where its
 * installer puts it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PaxHost}
 */
export function defaultPaxHost(env = process.env) {
  const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  return {
    platform: process.platform,
    cloudShell: inCloudShell(env),
    root: join(localAppData, PRODUCT.home, PRODUCT.pax.folder),
    pwshCandidates: ['pwsh', join(programFiles, 'PowerShell', '7', 'pwsh.exe')],
    run: runProgram,
  };
}

/**
 * The PC the context runs on, made once.
 * @param {{ paxHost?: PaxHost }} ctx
 * @returns {PaxHost}
 */
export const paxHostOf = (ctx) => (ctx.paxHost ??= defaultPaxHost());

/**
 * The refresh's files on this PC.
 * @param {PaxHost} host
 */
export function paxPaths(host) {
  const root = host.root;
  return {
    root,
    scripts: join(root, 'scripts'),
    config: join(root, 'refresh.json'),
    state: join(root, 'state.json'),
    logs: join(root, 'logs'),
    data: join(root, 'data'),
  };
}

/**
 * Whether a version is at least the minimum, by major and minor.
 * @param {string} version  e.g. 7.4.6 or 3.12.0rc1
 * @param {readonly number[]} min
 */
export function atLeast(version, min) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/** @param {string} s */
const stripBom = (s) => s.replace(/^\uFEFF/, '');
/** @param {string} s */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

/**
 * The last line of a script's output that is a JSON object. The runner scripts print one, last.
 * @param {string} text
 * @returns {Record<string, any> | undefined}
 */
export function lastJson(text) {
  const lines = stripBom(stripAnsi(String(text ?? ''))).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Not JSON: keep looking.
    }
  }
  return undefined;
}

/**
 * The runner's last `ERROR:` line, without the prefix, or ''.
 * @param {string} text
 */
const runnerError = (text) => {
  const lines = stripBom(stripAnsi(String(text ?? ''))).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^ERROR:\s*(.*)$/.exec(lines[i].trim());
    if (m?.[1]) return m[1].trim();
  }
  return '';
};

/**
 * The message in what a script printed when it failed: the runner's `ERROR:` line, or pwsh's
 * message under the ~~~ line of an unhandled error, else the last line.
 * @param {string} text
 */
export function errorText(text) {
  const runner = runnerError(text);
  if (runner) return runner;
  const lines = stripBom(stripAnsi(String(text ?? ''))).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^\s*\|\s*~+\s*$/.test(lines[i])) continue;
    /** @type {string[]} */
    const message = [];
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^\s*\|\s?(.*)$/.exec(lines[j]);
      if (!m) break;
      message.push(m[1].trim());
    }
    const text = message.join(' ').trim();
    if (text) return text;
  }
  return lines.filter((l) => l.trim()).pop()?.trim() ?? '';
}

/**
 * An error for a script or program that failed, with what it said. The runner's own `ERROR:` line
 * comes first, from either stream, ahead of anything else on stderr.
 * @param {RunResult} r
 * @param {string} what  What the installer was doing, e.g. "Registering the scheduled task".
 */
export function scriptFailed(r, what) {
  if (r.missing) return new Error(`${what} failed: PowerShell 7 (pwsh) isn't installed. Install it with: ${PWSH_INSTALL}`);
  if (r.timedOut) return new Error(`${what} didn't finish in time, so the installer stopped it.`);
  const detail = runnerError(r.stdout) || runnerError(r.stderr) || errorText(r.stderr) || errorText(r.stdout);
  return new Error(`${what} failed${r.code === null ? '' : ` (exit code ${r.code})`}${detail ? `: ${detail}` : '.'}`);
}

/**
 * One line of PowerShell that reports pwsh's path, version, execution policy, language mode and
 * the PC's time zone. Casts rather than method calls, so it also answers in constrained language
 * mode. No double quotes, which Windows command lines would have to escape.
 */
export const PWSH_PROBE = [
  '@{',
  'path = [string](Get-Process -Id $PID).Path;',
  'version = [string]$PSVersionTable.PSVersion;',
  'policy = [string](Get-ExecutionPolicy);',
  'languageMode = [string]$ExecutionContext.SessionState.LanguageMode;',
  'timeZone = [string](Get-TimeZone).Id',
  '} | ConvertTo-Json -Compress -EscapeHandling EscapeNonAscii',
].join(' ');

/**
 * Finds PowerShell 7: the first candidate that answers the probe and is new enough, else the
 * first that answers, which checkHost reports as too old.
 * @param {PaxHost} host
 * @returns {Promise<{ pwsh?: PwshInfo, error?: string }>}
 */
export async function findPwsh(host) {
  /** @type {string | undefined} */
  let error;
  /** @type {PwshInfo | undefined} */
  let older;
  for (const candidate of host.pwshCandidates) {
    const r = await host.run(candidate, ['-NoProfile', '-NonInteractive', '-Command', PWSH_PROBE], { timeoutMs: 60_000 });
    if (r.missing) continue;
    const info = lastJson(r.stdout);
    if (r.code === 0 && typeof info?.version === 'string') {
      /** @type {PwshInfo} */
      const pwsh = {
        path: String(info.path || candidate),
        version: info.version,
        policy: String(info.policy ?? ''),
        languageMode: String(info.languageMode ?? ''),
        ...(info.timeZone ? { timeZone: String(info.timeZone) } : {}),
      };
      if (atLeast(pwsh.version, MIN_PWSH)) return { pwsh };
      older ??= pwsh;
      continue;
    }
    error ??= scriptFailed(r, `Checking ${candidate}`).message;
  }
  if (older) return { pwsh: older };
  return error ? { error } : {};
}

/**
 * Finds Python the way PAX does: the first of its candidates that is 3.10 or later. Microsoft
 * Store's python.exe placeholder fails when Python isn't installed, so it's passed over.
 * @param {PaxHost} host
 * @returns {Promise<{ python?: PythonInfo, older?: PythonInfo }>}
 */
export async function findPython(host) {
  /** @type {PythonInfo | undefined} */
  let older;
  for (const [file, ...args] of PYTHON_CANDIDATES) {
    const r = await host.run(file, [...args, '--version'], { timeoutMs: 30_000 });
    if (r.missing || r.code !== 0) continue;
    const m = /Python (\d+\.\d+(?:\.\d+)?)/.exec(`${r.stdout}\n${r.stderr}`);
    if (!m) continue;
    const found = { command: [file, ...args].join(' '), version: m[1] };
    if (atLeast(found.version, MIN_PYTHON)) return { python: found };
    older ??= found;
  }
  return older ? { older } : {};
}

/**
 * Checks this PC can run the scheduled refresh: PowerShell 7.2 or later in full language mode,
 * an execution policy that runs local scripts, and, to read the audit log, Python 3.10 or later
 * where PAX looks for it. Remembers the pwsh it found, which runs the scripts from then on.
 * @param {PaxHost} host
 * @param {{ python?: boolean }} [o]  python: whether to look for Python. Only PAX's audit rollup needs it.
 * @returns {Promise<HostCheck>}
 */
export async function checkHost(host, { python: wantPython = !userInfoMode() } = {}) {
  /** @type {HostProblem[]} */
  const problems = [];
  const { pwsh, error } = await findPwsh(host);
  if (!pwsh) {
    problems.push({
      part: 'pwsh',
      title: "PowerShell 7 isn't installed",
      fix: `PAX and the refresh need PowerShell 7.2 or later. Install it with: ${PWSH_INSTALL}${error ? `. (${error})` : ''}`,
    });
  } else if (!atLeast(pwsh.version, MIN_PWSH)) {
    problems.push({ part: 'pwsh', title: `PowerShell ${pwsh.version} is too old`, fix: `PAX needs PowerShell 7.2 or later. Update it with: ${PWSH_INSTALL}` });
  } else {
    host.pwsh = pwsh.path;
    if (/^(AllSigned|Restricted)$/i.test(pwsh.policy)) {
      problems.push({
        part: 'pwsh',
        title: `PowerShell's execution policy is ${pwsh.policy}, so the refresh scripts can't run`,
        fix: "The scripts aren't signed, and the installer doesn't change or bypass the policy. To let your account run local scripts, run this in PowerShell 7: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned. If Group Policy sets the policy, ask your IT admin.",
      });
    }
    if (pwsh.languageMode && pwsh.languageMode !== 'FullLanguage') {
      problems.push({
        part: 'pwsh',
        title: `PowerShell runs in ${pwsh.languageMode} mode on this PC`,
        fix: `An application control policy (such as App Control for Business or AppLocker) limits PowerShell here, so the refresh can't keep its secret in Credential Manager. Ask your IT admin to allow the scripts in ${paxPaths(host).scripts}, or set up the refresh on another PC.`,
      });
    }
  }
  const { python, older } = wantPython ? await findPython(host) : {};
  if (wantPython && !python) {
    problems.push({
      part: 'python',
      title: older ? `Python ${older.version} is too old` : "Python isn't installed",
      fix: `PAX needs Python 3.10 or later to build its files. Without it PAX tries to install Python itself, which a scheduled task can't finish. Install it for your account with: ${PYTHON_INSTALL}`,
    });
  }
  return { ...(pwsh ? { pwsh } : {}), ...(python ? { python } : {}), problems };
}

/**
 * The Windows Credential Manager entry that holds the app's client secret.
 * @param {InstallConfig} config
 */
export function credentialTarget(config) {
  if (!config.tenantId) throw new Error('The install record has no tenant yet.');
  return `${PRODUCT.pax.credentialPrefix}${config.tenantId}`;
}

/**
 * The scripts the refresh runs, sorted by name: the runner's and the checkout's PAX scripts.
 * @param {string[]} paxScripts  The PAX scripts' paths in the checkout.
 * @returns {{ name: string, body: Buffer }[]}
 */
export function scriptFiles(paxScripts) {
  const files = [...RUNNER_SCRIPTS.map((s) => join(RUNNER_DIR, s)), ...paxScripts].map((file) => ({ name: basename(file), body: readFileSync(file) }));
  const names = new Set(files.map((f) => f.name.toLowerCase()));
  if (names.size !== files.length) throw new Error('Two of the refresh scripts have the same name.');
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * A short hash of the scripts, saved in the install record so a repair knows when they changed.
 * @param {{ name: string, body: Buffer }[]} files
 */
export function scriptsHash(files) {
  const hash = createHash('sha256');
  for (const f of files) hash.update(`${f.name}\0`).update(f.body).update('\0');
  return hash.digest('hex').slice(0, 16);
}

/**
 * Writes a file through a temporary one, so a reader never sees half of it.
 * @param {string} file
 * @param {string | Buffer} body
 */
function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/**
 * Copies the refresh scripts into the scripts folder. Each is written as a new file, so none
 * carries a download's mark of the web, which the RemoteSigned policy would refuse to run.
 * @param {PaxHost} host
 * @param {string[]} paxScripts  The PAX scripts' paths in the checkout.
 * @returns {string}  scriptsHash of what was written.
 */
export function writeScripts(host, paxScripts) {
  const { scripts } = paxPaths(host);
  mkdirSync(scripts, { recursive: true });
  const files = scriptFiles(paxScripts);
  for (const f of files) writeAtomic(join(scripts, f.name), f.body);
  return scriptsHash(files);
}

/**
 * refresh.json for the scheduled refresh. Product names come from product.js; the rest from
 * the install record.
 * @param {InstallConfig} config
 * @param {{ configFile?: string }} [o]  The install record's path, for the commands in error messages.
 */
export function refreshConfig(config, o = {}) {
  const sp = config.sharePoint;
  if (!sp) throw new Error('The install record has no SharePoint folder yet.');
  if (!config.app.appId) throw new Error('The install record has no app registration yet.');
  const command = (/** @type {string} */ args) => commandLine(o.configFile ? `${args} --config "${o.configFile}"` : args);
  const userInfo = userInfoMode();
  return {
    schema: 1,
    mode: userInfo ? 'userInfo' : 'audit',
    product: PRODUCT.name,
    tenantId: config.tenantId,
    clientId: config.app.appId,
    credentialTarget: credentialTarget(config),
    siteId: sp.siteId ?? sp.sitePath,
    library: sp.library,
    folderPath: sp.folderPath,
    paxReleaseTag: PAX_RELEASE.tag,
    paxSha256: PAX_RELEASE.sha256,
    files: { ...PRODUCT.pax.files },
    ...(userInfo ? {} : { seedDays: config.pax?.seedDays ?? SEED_DAYS }),
    agent365: !userInfo && !!config.pax?.agent365,
    repairHint: `To fix it, run the ${PRODUCT.installer}'s repair: ${command('install')}`,
    // A user directory held back for a drop: the command that publishes it, once.
    ...(userInfo ? { acceptDropHint: `If the drop is genuine, run: ${command('run --accept-drop')}` } : {}),
  };
}

/**
 * Reads a JSON file, or undefined when it's missing or isn't JSON.
 * @param {string} file
 * @returns {Record<string, any> | undefined}
 */
function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(stripBom(readFileSync(file, 'utf8')));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes refresh.json. Settings the installer doesn't set, such as maxDays or deidentify that an
 * admin added, are kept. A driveId is kept only while the site and library are unchanged.
 * @param {PaxHost} host
 * @param {ReturnType<typeof refreshConfig>} cfg
 */
export function writeRefreshConfig(host, cfg) {
  const { root, config: file } = paxPaths(host);
  mkdirSync(root, { recursive: true });
  const existing = readJson(file) ?? {};
  /** @type {Record<string, unknown>} */
  const merged = { ...existing, ...cfg };
  if (existing.siteId !== cfg.siteId || existing.library !== cfg.library) delete merged.driveId;
  writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}

/**
 * The last refresh's result, from state.json, or undefined before the first.
 * @param {PaxHost} host
 * @returns {Record<string, any> | undefined}
 */
export const readState = (host) => readJson(paxPaths(host).state);

/**
 * Runs one of the installed scripts with pwsh. When an installer script is gone, the copy that
 * ships with the installer runs, so uninstall can still remove the task and the secret.
 * @param {PaxHost} host
 * @param {string} name
 * @param {string[]} args
 * @param {RunOptions} [o]
 */
export function runScript(host, name, args, o = {}) {
  const installed = join(paxPaths(host).scripts, name);
  const file = !existsSync(installed) && RUNNER_SCRIPTS.includes(name) ? join(RUNNER_DIR, name) : installed;
  return host.run(host.pwsh ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File', file, ...args], o);
}

/**
 * Runs a script that prints one line of JSON, and returns it.
 * @param {PaxHost} host
 * @param {string} name
 * @param {string[]} args
 * @param {string} what
 * @param {RunOptions} [o]
 */
async function scriptJson(host, name, args, what, o = {}) {
  const r = await runScript(host, name, args, { timeoutMs: 120_000, ...o });
  const json = r.code === 0 ? lastJson(r.stdout) : undefined;
  if (!json) throw scriptFailed(r, what);
  return json;
}

/**
 * Saves the app's client secret in Windows Credential Manager, for this Windows account. It goes
 * to the script on standard input, never on a command line.
 * @param {PaxHost} host
 * @param {string} target
 * @param {string} clientId  Saved as the credential's user name.
 * @param {string} secret
 */
export async function storeSecret(host, target, clientId, secret) {
  const json = await scriptJson(host, 'credential.ps1', ['-Action', 'Write', '-Target', target, '-UserName', clientId], 'Saving the client secret in Windows Credential Manager', { input: secret });
  if (json.written !== true) throw new Error(`Windows Credential Manager didn't confirm it saved ${target}.`);
}

/**
 * Whether Credential Manager holds the secret, and when it was written. Never the secret.
 * @param {PaxHost} host
 * @param {string} target
 * @returns {Promise<{ exists: boolean, userName?: string, lastWrittenUtc?: string }>}
 */
export async function secretStored(host, target) {
  const json = await scriptJson(host, 'credential.ps1', ['-Action', 'Test', '-Target', target], 'Checking Windows Credential Manager');
  return { exists: json.exists === true, ...(json.userName ? { userName: String(json.userName) } : {}), ...(json.lastWrittenUtc ? { lastWrittenUtc: String(json.lastWrittenUtc) } : {}) };
}

/**
 * Removes the secret from Credential Manager. Nothing to remove is fine.
 * @param {PaxHost} host
 * @param {string} target
 * @returns {Promise<boolean>}  Whether there was one.
 */
export async function removeSecret(host, target) {
  const json = await scriptJson(host, 'credential.ps1', ['-Action', 'Delete', '-Target', target], 'Removing the client secret from Windows Credential Manager');
  return json.deleted === true;
}

/**
 * @typedef {object} TaskReport
 * @property {string} taskName
 * @property {boolean} exists
 * @property {string} [state]  Ready, Running or Disabled.
 * @property {string | null} [lastRunTime]
 * @property {number} [lastTaskResult]
 * @property {boolean} [neverRan]
 * @property {string | null} [nextRunTime]
 * @property {string} [userId]
 * @property {string} [logonType]  Interactive, Password or S4U.
 * @property {string} [runLevel]
 * @property {string} [execute]
 * @property {string} [arguments]
 * @property {string | null} [workingDirectory]
 */

/**
 * Registers the daily task, or replaces it with the same name. It runs as this Windows account,
 * while it's signed in, with limited rights, and needs no administrator to register.
 * @param {PaxHost} host
 * @param {{ name: string, at: string, description: string }} task
 * @returns {Promise<TaskReport>}
 */
export async function registerTask(host, task) {
  const { scripts, config } = paxPaths(host);
  const report = /** @type {TaskReport} */ (
    await scriptJson(
      host,
      'task.ps1',
      ['-Action', 'Register', '-TaskName', task.name, '-ScriptPath', join(scripts, 'refresh.ps1'), '-ConfigPath', config, '-At', task.at, '-Description', task.description],
      'Registering the scheduled task',
    )
  );
  if (!report.exists) throw new Error(`Task Scheduler doesn't show ${task.name} after registering it.`);
  return report;
}

/**
 * The scheduled task as Task Scheduler sees it.
 * @param {PaxHost} host
 * @param {string} name
 * @returns {Promise<TaskReport>}
 */
export async function taskInfo(host, name) {
  return /** @type {TaskReport} */ (await scriptJson(host, 'task.ps1', ['-Action', 'Info', '-TaskName', name], 'Reading the scheduled task'));
}

/**
 * Whether the registered task already does what this install wants: it's enabled, starts at the
 * time recorded, and runs this PC's refresh.ps1 with its refresh.json, from that file's folder,
 * with a pwsh.exe that's still there. Repair keeps a task that does, so a change the user made in
 * Task Scheduler, such as running it while signed out, stays.
 * @param {TaskReport} info
 * @param {PaxHost} host
 * @param {import('../../config.js').PaxTask | undefined} recorded
 * @param {string} at  When it should start, HH:mm.
 */
export function taskCurrent(info, host, recorded, at) {
  if (!info.exists || info.state === 'Disabled' || recorded?.at !== at) return false;
  const { scripts, config } = paxPaths(host);
  const args = (info.arguments ?? '').toLowerCase();
  if (![join(scripts, 'refresh.ps1'), config].every((path) => args.includes(`"${path.toLowerCase()}"`))) return false;
  if ((info.workingDirectory ?? '').replace(/[\\/]+$/, '').toLowerCase() !== dirname(config).toLowerCase()) return false;
  return !!info.execute && existsSync(info.execute);
}

/**
 * Starts the scheduled task now. It runs in the background; state.json says how it went.
 * @param {PaxHost} host
 * @param {string} name
 * @returns {Promise<TaskReport>}
 */
export async function startTask(host, name) {
  return /** @type {TaskReport} */ (await scriptJson(host, 'task.ps1', ['-Action', 'Start', '-TaskName', name], 'Starting the scheduled task'));
}

/**
 * Removes the scheduled task. Nothing to remove is fine.
 * @param {PaxHost} host
 * @param {string} name
 * @returns {Promise<boolean>}  Whether there was one.
 */
export async function unregisterTask(host, name) {
  const json = await scriptJson(host, 'task.ps1', ['-Action', 'Unregister', '-TaskName', name], 'Removing the scheduled task');
  return json.removed === true;
}

/**
 * @typedef {object} FolderCheck
 * @property {boolean} ok
 * @property {string} [siteId]
 * @property {string} [driveId]
 * @property {string} [folder]
 * @property {string} [error]
 * @property {number} [status]  Graph's HTTP status, when Graph refused.
 */

/**
 * Signs in as the app with the saved secret, as the task will, and checks it can reach the
 * SharePoint folder. Creates the folder when it's missing.
 * @param {PaxHost} host
 * @returns {Promise<FolderCheck>}
 */
export async function checkFolder(host) {
  const r = await runScript(host, 'refresh.ps1', ['-Config', paxPaths(host).config, '-Check'], { timeoutMs: 180_000 });
  const json = lastJson(r.stdout);
  if (json && typeof json.ok === 'boolean') {
    return {
      ok: json.ok,
      ...(json.siteId ? { siteId: String(json.siteId) } : {}),
      ...(json.driveId ? { driveId: String(json.driveId) } : {}),
      ...(json.folder ? { folder: String(json.folder) } : {}),
      ...(json.error ? { error: String(json.error) } : {}),
      ...(typeof json.status === 'number' ? { status: json.status } : {}),
    };
  }
  return { ok: false, error: scriptFailed(r, 'Checking the SharePoint folder').message };
}

/**
 * Uploads one file to the SharePoint folder, or a subfolder of it, as the app.
 * @param {PaxHost} host
 * @param {string} file
 * @param {{ remoteName?: string, remoteFolder?: string }} [o]
 */
export async function uploadToFolder(host, file, o = {}) {
  const args = ['-Config', paxPaths(host).config, '-Upload', file];
  if (o.remoteName) args.push('-RemoteName', o.remoteName);
  if (o.remoteFolder) args.push('-RemoteFolder', o.remoteFolder);
  const r = await runScript(host, 'refresh.ps1', args, { timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw scriptFailed(r, `Uploading ${basename(file)}`);
}

/**
 * Runs the refresh now in this window, rather than through the task, such as to fill a gap with
 * -Days, or to publish an org file after a genuine drop with -AcceptDrop. Like the task, it's
 * stopped after 12 hours.
 * @param {PaxHost} host
 * @param {{ days?: number, acceptDrop?: boolean, timeoutMs?: number }} [o]
 * @returns {Promise<RunResult>}
 */
export function runRefresh(host, o = {}) {
  const args = ['-Config', paxPaths(host).config];
  if (o.days !== undefined) {
    // refresh.ps1 takes -Days from 1 to 180, as far back as Purview's records go.
    if (!Number.isInteger(o.days) || o.days < 1 || o.days > 180) return Promise.reject(new RangeError(`A refresh reads from 1 to 180 days, not ${o.days}.`));
    args.push('-Days', String(o.days));
  }
  if (o.acceptDrop) args.push('-AcceptDrop');
  return runScript(host, 'refresh.ps1', args, { timeoutMs: o.timeoutMs ?? RUN_LIMIT_MS });
}

/**
 * Deletes the refresh's folder on this PC: the scripts, refresh.json, the logs and the local
 * copies of the files. SharePoint keeps its copies.
 * @param {PaxHost} host
 * @returns {boolean}  Whether there was one.
 */
export function removeLocal(host) {
  const { root } = paxPaths(host);
  if (basename(root) !== PRODUCT.pax.folder) throw new Error(`Won't delete ${root}: it isn't the refresh's folder.`);
  if (!existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  return true;
}
