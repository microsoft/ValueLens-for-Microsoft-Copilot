// @ts-check
/** The PAX route's work on this PC, against a fake PC: pwsh, Python, the scripts, refresh.json, the secret, the task and the refresh. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../src/config.js';
import { commandLine } from '../src/launch.js';
import { PRODUCT } from '../src/product.js';
import {
  atLeast,
  checkFolder,
  checkHost,
  credentialTarget,
  defaultPaxHost,
  errorText,
  findPwsh,
  findPython,
  lastJson,
  MIN_PWSH,
  MIN_PYTHON,
  PAX_RELEASE,
  paxHostOf,
  paxPaths,
  PWSH_INSTALL,
  PWSH_PROBE,
  PYTHON_CANDIDATES,
  PYTHON_INSTALL,
  readState,
  refreshConfig,
  registerTask,
  removeLocal,
  removeSecret,
  RUN_LIMIT_MS,
  runRefresh,
  runScript,
  RUNNER_DIR,
  RUNNER_SCRIPTS,
  scriptFailed,
  scriptFiles,
  scriptsHash,
  secretStored,
  SEED_DAYS,
  startTask,
  storeSecret,
  TASK_AT,
  taskCurrent,
  taskInfo,
  unregisterTask,
  uploadToFolder,
  writeRefreshConfig,
  writeScripts,
} from '../src/steps/pax/local.js';
import { failed, fakePaxHost, missing, printed } from './pax-fakes.js';

/** @typedef {import('../src/steps/pax/local.js').RunOptions} RunOptions */
/** @typedef {import('../src/steps/pax/local.js').TaskReport} TaskReport */
/** @typedef {import('node:test').TestContext} TestContext */

const NOW = '2026-06-01T12:00:00.000Z';
const TENANT = '11111111-2222-4333-8444-555555555555';
const APP_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'Fake~Secret.Value_0123456789';
const DESCRIPTION = 'Runs PAX each morning and saves the Copilot usage files to SharePoint.';
const TARGET = `${PRODUCT.pax.credentialPrefix}${TENANT}`;
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TASK_PS1 = join(RUNNER_DIR, 'task.ps1');
const SCRIPT_NAMES = ['PAX_Purview.ps1', 'Run-PAX-AIBV.ps1', 'credential.ps1', 'refresh.ps1', 'task.ps1'];
const POLICY_FIX =
  "The scripts aren't signed, and the installer doesn't change or bypass the policy. To let your account run local scripts, run this in PowerShell 7: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned. If Group Policy sets the policy, ask your IT admin.";
const PYTHON_FIX = `PAX needs Python 3.10 or later to build its files. Without it PAX tries to install Python itself, which a scheduled task can't finish. Install it for your account with: ${PYTHON_INSTALL}`;

/**
 * A fake PC with a fixed clock, whose temp folder goes when the test ends.
 * @param {TestContext} t
 * @param {Parameters<typeof fakePaxHost>[0]} [o]
 */
function pc(t, o = {}) {
  const f = fakePaxHost({ now: () => new Date(NOW), ...o });
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  return f;
}

/** @param {TestContext} t */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'valuelens-pax-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A PAX install record for a folder on contoso.com's Analytics site. */
function paxConfig() {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = TENANT;
  config.app.appId = APP_ID;
  config.sharePoint = {
    folderUrl: 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/Copilot',
    siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
    sitePath: 'contoso.sharepoint.com:/sites/Analytics',
    library: 'Shared Documents',
    folderPath: '/Copilot',
  };
  return config;
}

/** Stand-ins for the checkout's two PAX scripts. @param {TestContext} t */
function paxScripts(t) {
  const dir = tempDir(t);
  const files = [join(dir, 'Run-PAX-AIBV.ps1'), join(dir, 'PAX_Purview.ps1')];
  writeFileSync(files[0], "Write-Output 'runs PAX'\n");
  writeFileSync(files[1], "Write-Output 'PAX'\n");
  return files;
}

/** Records the options each call to the fake PC gets. @param {ReturnType<typeof fakePaxHost>} f */
function spyOptions(f) {
  /** @type {(RunOptions | undefined)[]} */
  const options = [];
  const run = f.host.run;
  f.host.run = (file, args, o) => {
    options.push(o);
    return run(file, args, o);
  };
  return options;
}

/** Every .js and .ps1 file under a folder. @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.(js|ps1)$/i.test(e.name) ? [join(dir, e.name)] : [],
  );
}

/** A task the fake PC registered, and the install record's note of it. @param {TestContext} t */
async function registered(t) {
  const f = pc(t);
  const report = await registerTask(f.host, { name: PRODUCT.pax.task, at: TASK_AT, description: DESCRIPTION });
  return { f, report, recorded: { name: PRODUCT.pax.task, at: TASK_AT } };
}

test('pax local: atLeast compares the major and minor version as numbers', () => {
  assert.equal(atLeast('7.4.6', MIN_PWSH), true);
  assert.equal(atLeast('7.2.0', MIN_PWSH), true);
  assert.equal(atLeast('7.2', MIN_PWSH), true);
  assert.equal(atLeast('7.10.1', MIN_PWSH), true);
  assert.equal(atLeast('8.0.0', MIN_PWSH), true);
  assert.equal(atLeast('7.1.5', MIN_PWSH), false);
  assert.equal(atLeast('6.9.9', MIN_PWSH), false);
  assert.equal(atLeast('5.1.22621.4391', MIN_PWSH), false);
  assert.equal(atLeast(' 3.12.0rc1 ', MIN_PYTHON), true);
  assert.equal(atLeast('3.10.0', MIN_PYTHON), true);
  assert.equal(atLeast('3.9.13', MIN_PYTHON), false);
  assert.equal(atLeast('2.7.18', MIN_PYTHON), false);
  // Not a version.
  assert.equal(atLeast('7', MIN_PWSH), false);
  assert.equal(atLeast('v7.4.6', MIN_PWSH), false);
  assert.equal(atLeast('', MIN_PWSH), false);
  assert.equal(atLeast(/** @type {any} */ (undefined), MIN_PWSH), false);
  assert.equal(atLeast(/** @type {any} */ (null), MIN_PWSH), false);
});

test('pax local: lastJson takes the last JSON object a script printed', () => {
  assert.deepEqual(lastJson('{"a":1}'), { a: 1 });
  assert.deepEqual(lastJson('\uFEFF{"ok":true}\r\n'), { ok: true });
  assert.deepEqual(lastJson('\x1b[0m\uFEFF{"ok":true}'), { ok: true });
  assert.deepEqual(lastJson('\x1b[33mWARNING: slow\x1b[0m\r\n\x1b[0m{"ok":true,"siteId":"s"}\x1b[0m\r\n\r\n'), { ok: true, siteId: 's' });
  // Noise around it, and the last object wins.
  assert.deepEqual(lastJson('Starting...\n{"step":1}\nMore noise\n  {"step":2}  \nDone.\n'), { step: 2 });
  // Arrays, null, broken and multi-line JSON are passed over.
  assert.deepEqual(lastJson('{"first":true}\n[{"a":1}]\nnull\n{"broken":\n'), { first: true });
  assert.deepEqual(lastJson('{"a":1}\n{not json}\n'), { a: 1 });
  assert.equal(lastJson('{\n  "a": 1\n}\n'), undefined);
  assert.equal(lastJson('[{"a":1}]'), undefined);
  assert.equal(lastJson('no json here'), undefined);
  assert.equal(lastJson(''), undefined);
  assert.equal(lastJson(/** @type {any} */ (undefined)), undefined);
});

test("pax local: errorText takes the runner's last ERROR: line", () => {
  assert.equal(errorText('Working...\nERROR: The secret is missing.\n'), 'The secret is missing.');
  // The last one with a message wins; a BOM, colour codes and padding go.
  assert.equal(errorText('\uFEFFERROR: first\r\n  \x1b[31mERROR:   second  \x1b[0m\r\nERROR:\r\nsome trailing noise\r\n'), 'second');
  // Over a pwsh error block.
  assert.equal(errorText('ERROR: from the runner\n     | ~~~~\n     | from pwsh\n'), 'from the runner');
});

test("pax local: errorText reads pwsh's error block under the ~~~ line", () => {
  const block = [
    'Exception: C:\\scripts\\refresh.ps1:212',
    'Line |',
    ' 212 |      throw "Couldn\'t reach the folder"',
    '     |      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    "     | Couldn't reach the SharePoint folder: the app",
    '     | has no access to the site.',
    '',
  ].join('\r\n');
  assert.equal(errorText(block), "Couldn't reach the SharePoint folder: the app has no access to the site.");
  // As pwsh colours it.
  const coloured = '\x1b[31;1mWrite-Error: \x1b[0m\n\x1b[36;1mLine |\x1b[0m\n\x1b[36;1m     | \x1b[31;1m ~~~~~~~~~\x1b[0m\n\x1b[36;1m     | \x1b[31;1mThe folder is gone.\x1b[0m\n';
  assert.equal(errorText(coloured), 'The folder is gone.');
  // An empty block falls back to the one before it.
  assert.equal(errorText(['     | ~~~~', '     | First problem.', '', '     | ~~~~', '     |', ''].join('\n')), 'First problem.');
});

test('pax local: errorText falls back to the last line', () => {
  assert.equal(errorText('Something went wrong\nAt line 5\n\n  \n'), 'At line 5');
  assert.equal(errorText('\x1b[31m  only line  \x1b[0m'), 'only line');
  assert.equal(errorText('\n \r\n'), '');
  assert.equal(errorText(''), '');
  assert.equal(errorText(/** @type {any} */ (undefined)), '');
});

test('pax local: scriptFailed says what failed and why', () => {
  assert.equal(scriptFailed(missing, 'Saving the secret').message, `Saving the secret failed: PowerShell 7 (pwsh) isn't installed. Install it with: ${PWSH_INSTALL}`);
  assert.equal(
    scriptFailed({ code: null, stdout: 'half', stderr: 'ERROR: late', timedOut: true }, 'Checking the folder').message,
    "Checking the folder didn't finish in time, so the installer stopped it.",
  );
  assert.equal(scriptFailed(failed('The task is gone.', 4), 'Starting the task').message, 'Starting the task failed (exit code 4): The task is gone.');
  // The runner's ERROR: line first, from either stream; else stderr, then stdout.
  assert.equal(scriptFailed({ code: 1, stdout: 'ERROR: from stdout\n', stderr: '' }, 'X').message, 'X failed (exit code 1): from stdout');
  assert.equal(scriptFailed({ code: 1, stdout: 'ERROR: from stdout\n', stderr: 'a warning on stderr\n' }, 'X').message, 'X failed (exit code 1): from stdout');
  assert.equal(scriptFailed({ code: 1, stdout: 'progress\n', stderr: 'ERROR: from stderr\nnoise\n' }, 'X').message, 'X failed (exit code 1): from stderr');
  assert.equal(scriptFailed({ code: 1, stdout: 'progress\n', stderr: 'from stderr\n' }, 'X').message, 'X failed (exit code 1): from stderr');
  // Nothing said, no exit code, or exit 0 without the JSON.
  assert.equal(scriptFailed({ code: 1, stdout: '', stderr: '' }, 'X').message, 'X failed (exit code 1).');
  assert.equal(scriptFailed({ code: null, stdout: '', stderr: 'spawn EPERM' }, 'X').message, 'X failed: spawn EPERM');
  assert.equal(scriptFailed({ code: 0, stdout: 'not json\n', stderr: '' }, 'X').message, 'X failed (exit code 0): not json');
});

test('pax local: the pwsh probe is one line, has no double quotes and only reads the policy', () => {
  assert.doesNotMatch(PWSH_PROBE, /["\r\n]/);
  for (const field of ['path', 'version', 'policy', 'languageMode', 'timeZone']) assert.match(PWSH_PROBE, new RegExp(`\\b${field} = `));
  assert.match(PWSH_PROBE, /\bGet-ExecutionPolicy\b/);
  assert.doesNotMatch(PWSH_PROBE, /Set-ExecutionPolicy|(^|\s)-ExecutionPolicy\b/i);
  assert.match(PWSH_PROBE, /\| ConvertTo-Json -Compress/);
});

test('pax local: findPwsh tries the candidates in order and skips missing ones', async (t) => {
  const f = pc(t);
  const options = spyOptions(f);
  f.host.pwshCandidates = ['pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'];
  f.answer.pwsh = [missing];
  assert.deepEqual(await findPwsh(f.host), {
    pwsh: { path: process.execPath, version: '7.4.6', policy: 'RemoteSigned', languageMode: 'FullLanguage', timeZone: 'GMT Standard Time' },
  });
  assert.deepEqual(
    f.calls.map((c) => c.file),
    ['pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
  );
  for (const c of f.calls) assert.deepEqual(c.args, ['-NoProfile', '-NonInteractive', '-Command', PWSH_PROBE]);
  assert.deepEqual(options, [{ timeoutMs: 60_000 }, { timeoutMs: 60_000 }]);
  // Finding isn't choosing: checkHost does that.
  assert.equal(f.host.pwsh, undefined);
});

test('pax local: findPwsh stops at the first pwsh that answers', async (t) => {
  const f = pc(t);
  f.host.pwshCandidates = ['pwsh', 'second-pwsh'];
  assert.equal((await findPwsh(f.host)).pwsh?.version, '7.4.6');
  assert.deepEqual(
    f.calls.map((c) => c.file),
    ['pwsh'],
  );
});

test('pax local: findPwsh passes over a pwsh too old for PAX, and returns it only when none is newer', async (t) => {
  const old = { path: 'C:\\old\\pwsh.exe', version: '7.1.3', policy: 'RemoteSigned', languageMode: 'FullLanguage' };
  const f = pc(t);
  f.host.pwshCandidates = ['pwsh', 'second-pwsh'];
  f.answer.pwsh = [printed(old), printed({ ...old, path: 'C:\\new\\pwsh.exe', version: '7.4.6' })];
  assert.deepEqual(await findPwsh(f.host), { pwsh: { ...old, path: 'C:\\new\\pwsh.exe', version: '7.4.6' } });
  assert.equal(f.calls.length, 2);

  const only = pc(t);
  only.host.pwshCandidates = ['pwsh', 'second-pwsh'];
  only.answer.pwsh = [printed(old), missing];
  assert.deepEqual(await findPwsh(only.host), { pwsh: old });
  assert.equal(only.calls.length, 2);
});

test("pax local: findPwsh keeps the first failure when no pwsh answers", async (t) => {
  const f = pc(t);
  f.host.pwshCandidates = ['pwsh', 'second-pwsh', 'third-pwsh'];
  f.answer.pwsh = [failed('Access is denied.'), { code: 0, stdout: 'garbage\n', stderr: '' }, missing];
  assert.deepEqual(await findPwsh(f.host), { error: 'Checking pwsh failed (exit code 1): Access is denied.' });
  assert.equal(f.calls.length, 3);

  const none = pc(t, { pwsh: null });
  none.host.pwshCandidates = ['pwsh', 'second-pwsh'];
  assert.deepEqual(await findPwsh(none.host), {});
  assert.equal(none.calls.length, 2);
});

test('pax local: findPwsh needs exit 0 and a version, and fills in what the probe left out', async (t) => {
  const f = pc(t);
  f.host.pwshCandidates = ['pwsh-preview'];
  f.answer.pwsh = [printed({ path: '', version: '7.5.0', policy: null, languageMode: 'FullLanguage', timeZone: '' })];
  assert.deepEqual(await findPwsh(f.host), { pwsh: { path: 'pwsh-preview', version: '7.5.0', policy: '', languageMode: 'FullLanguage' } });

  f.host.pwshCandidates = ['a-pwsh', 'b-pwsh'];
  f.answer.pwsh = [printed({ path: 'x', version: 7.4 }), { code: 1, stdout: '{"path":"x","version":"7.4.6"}\n', stderr: '' }];
  const r = await findPwsh(f.host);
  assert.equal(r.pwsh, undefined);
  assert.match(r.error ?? '', /^Checking a-pwsh failed \(exit code 0\)/);
});

test('pax local: findPython tries the commands in PAX order', async (t) => {
  const f = pc(t, { python: null });
  const options = spyOptions(f);
  assert.deepEqual(await findPython(f.host), {});
  assert.deepEqual(
    f.calls.map((c) => [c.file, ...c.args]),
    PYTHON_CANDIDATES.map((c) => [...c, '--version']),
  );
  assert.equal(options.length, PYTHON_CANDIDATES.length);
  assert.ok(options.every((o) => o?.timeoutMs === 30_000));
  assert.deepEqual(PYTHON_CANDIDATES[0], ['python']);
  assert.deepEqual(PYTHON_CANDIDATES.at(-1), ['python3']);
});

test('pax local: findPython takes the first Python 3.10 or later', async (t) => {
  const f = pc(t, { python: { python: '3.9.13', 'py -3.12': '3.12.4', 'py -3.11': '3.11.9', python3: '3.13.1' } });
  assert.deepEqual(await findPython(f.host), { python: { command: 'py -3.12', version: '3.12.4' } });
  assert.deepEqual(
    f.calls.map((c) => [c.file, ...c.args].join(' ')),
    ['python --version', 'py -3.13 --version', 'py -3.12 --version'],
  );
});

test('pax local: findPython reports the first older Python when none is new enough', async (t) => {
  const f = pc(t, { python: { python: '3.9.13', python3: '3.8.10' } });
  assert.deepEqual(await findPython(f.host), { older: { command: 'python', version: '3.9.13' } });
  assert.equal(f.calls.length, PYTHON_CANDIDATES.length);
});

test("pax local: findPython passes over the Store placeholder and output it can't read", async (t) => {
  const f = pc(t, { python: { python3: '3.11.2' } });
  f.answer.python = [
    { code: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store.\n' },
    { code: 0, stdout: 'not a version\n', stderr: '' },
    // Older Pythons print the version on stderr.
    { code: 0, stdout: '', stderr: 'Python 3.10.11\n' },
  ];
  assert.deepEqual(await findPython(f.host), { python: { command: 'py -3.12', version: '3.10.11' } });
});

test('pax local: checkHost passes a ready PC and runs the scripts with the pwsh it found', async (t) => {
  const f = pc(t);
  assert.deepEqual(await checkHost(f.host), {
    pwsh: { path: process.execPath, version: '7.4.6', policy: 'RemoteSigned', languageMode: 'FullLanguage', timeZone: 'GMT Standard Time' },
    python: { command: 'python', version: '3.12.4' },
    problems: [],
  });
  assert.equal(f.host.pwsh, process.execPath);
  await taskInfo(f.host, PRODUCT.pax.task);
  assert.equal(f.calls.at(-1)?.file, process.execPath);
});

test("pax local: checkHost says to install PowerShell 7 when there's none", async (t) => {
  const f = pc(t, { pwsh: null });
  const check = await checkHost(f.host);
  assert.equal(check.pwsh, undefined);
  assert.deepEqual(check.problems, [
    { part: 'pwsh', title: "PowerShell 7 isn't installed", fix: `PAX and the refresh need PowerShell 7.2 or later. Install it with: ${PWSH_INSTALL}` },
  ]);
  assert.equal(f.host.pwsh, undefined);
  assert.deepEqual(check.python, { command: 'python', version: '3.12.4' });

  // A pwsh that fails the probe: what it said goes in the fix.
  const broken = pc(t);
  broken.answer.pwsh = [failed('The term is not recognized.')];
  assert.deepEqual((await checkHost(broken.host)).problems, [
    {
      part: 'pwsh',
      title: "PowerShell 7 isn't installed",
      fix: `PAX and the refresh need PowerShell 7.2 or later. Install it with: ${PWSH_INSTALL}. (Checking pwsh failed (exit code 1): The term is not recognized.)`,
    },
  ]);
});

test('pax local: checkHost refuses PowerShell 7.1 and goes no further with it', async (t) => {
  const f = pc(t, { pwsh: { version: '7.1.5', policy: 'AllSigned', languageMode: 'ConstrainedLanguage' } });
  const check = await checkHost(f.host);
  assert.deepEqual(check.problems, [{ part: 'pwsh', title: 'PowerShell 7.1.5 is too old', fix: `PAX needs PowerShell 7.2 or later. Update it with: ${PWSH_INSTALL}` }]);
  assert.equal(check.pwsh?.version, '7.1.5');
  assert.equal(f.host.pwsh, undefined);
});

test("pax local: checkHost explains an AllSigned or Restricted policy, and doesn't change or get round it", async (t) => {
  for (const policy of ['AllSigned', 'Restricted', 'restricted']) {
    const f = pc(t, { pwsh: { policy } });
    const check = await checkHost(f.host);
    assert.deepEqual(check.problems, [{ part: 'pwsh', title: `PowerShell's execution policy is ${policy}, so the refresh scripts can't run`, fix: POLICY_FIX }], policy);
    assert.match(check.problems[0].fix, /the installer doesn't change or bypass the policy/);
    assert.match(check.problems[0].fix, /Set-ExecutionPolicy -Scope CurrentUser RemoteSigned/);
    // It found pwsh, and ran nothing that changes the policy or runs around it.
    assert.equal(f.host.pwsh, process.execPath);
    for (const c of f.calls) {
      assert.ok(!c.args.some((a) => /^-(ExecutionPolicy|ep|ex|exec)$/i.test(a) || /Set-ExecutionPolicy/i.test(a)), c.args.join(' '));
    }
  }
  for (const policy of ['RemoteSigned', 'Unrestricted']) {
    assert.deepEqual((await checkHost(pc(t, { pwsh: { policy } }).host)).problems, [], policy);
  }
});

test('pax local: checkHost stops at constrained language mode', async (t) => {
  const f = pc(t, { pwsh: { languageMode: 'ConstrainedLanguage' } });
  const check = await checkHost(f.host);
  assert.equal(check.problems.length, 1);
  const [problem] = check.problems;
  assert.equal(problem.part, 'pwsh');
  assert.equal(problem.title, 'PowerShell runs in ConstrainedLanguage mode on this PC');
  assert.ok(problem.fix.includes(paxPaths(f.host).scripts), problem.fix);
  assert.match(problem.fix, /Ask your IT admin/);

  const both = await checkHost(pc(t, { pwsh: { policy: 'AllSigned', languageMode: 'ConstrainedLanguage' } }).host);
  assert.deepEqual(
    both.problems.map((p) => p.title),
    ["PowerShell's execution policy is AllSigned, so the refresh scripts can't run", 'PowerShell runs in ConstrainedLanguage mode on this PC'],
  );
});

test('pax local: checkHost asks for Python 3.10 or later', async (t) => {
  const old = await checkHost(pc(t, { python: { python: '3.9.13' } }).host);
  assert.equal(old.python, undefined);
  assert.deepEqual(old.problems, [{ part: 'python', title: 'Python 3.9.13 is too old', fix: PYTHON_FIX }]);

  const none = await checkHost(pc(t, { python: null }).host);
  assert.deepEqual(none.problems, [{ part: 'python', title: "Python isn't installed", fix: PYTHON_FIX }]);

  const bare = await checkHost(pc(t, { pwsh: null, python: null }).host);
  assert.deepEqual(
    bare.problems.map((p) => p.part),
    ['pwsh', 'python'],
  );
});

test('pax local: credentialTarget is the product prefix and the tenant', () => {
  const config = paxConfig();
  assert.equal(credentialTarget(config), `${PRODUCT.pax.credentialPrefix}${TENANT}`);
  assert.ok(credentialTarget(config).startsWith(PRODUCT.pax.credentialPrefix));
  delete config.tenantId;
  assert.throws(() => credentialTarget(config), { message: 'The install record has no tenant yet.' });
  config.tenantId = '';
  assert.throws(() => credentialTarget(config), { message: 'The install record has no tenant yet.' });
});

test("pax local: scriptFiles lists the runner's and the PAX scripts, sorted by name", (t) => {
  const pax = paxScripts(t);
  const files = scriptFiles(pax);
  assert.deepEqual(
    files.map((f) => f.name),
    SCRIPT_NAMES,
  );
  for (const name of RUNNER_SCRIPTS) assert.deepEqual(files.find((f) => f.name === name)?.body, readFileSync(join(RUNNER_DIR, name)), name);
  assert.equal(files.find((f) => f.name === 'PAX_Purview.ps1')?.body.toString(), "Write-Output 'PAX'\n");
  assert.ok(files.every((f) => Buffer.isBuffer(f.body)));
  assert.deepEqual(
    scriptFiles([]).map((f) => f.name),
    ['credential.ps1', 'refresh.ps1', 'task.ps1'],
  );
});

test('pax local: scriptFiles refuses two scripts with the same name', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'a'));
  mkdirSync(join(dir, 'b'));
  writeFileSync(join(dir, 'a', 'PAX.ps1'), 'a');
  writeFileSync(join(dir, 'b', 'pax.PS1'), 'b');
  assert.throws(() => scriptFiles([join(dir, 'a', 'PAX.ps1'), join(dir, 'b', 'pax.PS1')]), { message: 'Two of the refresh scripts have the same name.' });
  // Nor can a PAX script take a runner script's name.
  writeFileSync(join(dir, 'Refresh.ps1'), 'x');
  assert.throws(() => scriptFiles([join(dir, 'Refresh.ps1')]), { message: 'Two of the refresh scripts have the same name.' });
  assert.throws(() => scriptFiles([join(dir, 'missing.ps1')]), { code: 'ENOENT' });
});

test('pax local: scriptsHash is short, stable, and changes with any name or byte', () => {
  const files = [
    { name: 'a.ps1', body: Buffer.from('one') },
    { name: 'b.ps1', body: Buffer.from('two') },
  ];
  const hash = scriptsHash(files);
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(scriptsHash(files.map((f) => ({ name: f.name, body: Buffer.from(f.body) }))), hash);
  assert.notEqual(scriptsHash([files[0], { name: 'b.ps1', body: Buffer.from('two!') }]), hash);
  assert.notEqual(scriptsHash([files[0], { name: 'c.ps1', body: Buffer.from('two') }]), hash);
  // Where a name ends and a body starts counts.
  assert.notEqual(scriptsHash([{ name: 'ab', body: Buffer.from('c') }]), scriptsHash([{ name: 'a', body: Buffer.from('bc') }]));
  assert.notEqual(scriptsHash([]), hash);
});

test('pax local: writeScripts copies every script into the scripts folder', (t) => {
  const f = pc(t);
  const pax = paxScripts(t);
  const { scripts } = paxPaths(f.host);
  const hash = writeScripts(f.host, pax);
  assert.deepEqual(readdirSync(scripts).sort(), SCRIPT_NAMES);
  for (const name of RUNNER_SCRIPTS) assert.deepEqual(readFileSync(join(scripts, name)), readFileSync(join(RUNNER_DIR, name)), name);
  assert.equal(readFileSync(join(scripts, 'Run-PAX-AIBV.ps1'), 'utf8'), "Write-Output 'runs PAX'\n");
  assert.equal(hash, scriptsHash(scriptFiles(pax)));
  // Again: the same hash, and no temporary files left behind.
  assert.equal(writeScripts(f.host, pax), hash);
  assert.deepEqual(readdirSync(scripts).sort(), SCRIPT_NAMES);
  // A changed PAX script is copied and changes the hash.
  writeFileSync(pax[1], "Write-Output 'PAX 2'\n");
  assert.notEqual(writeScripts(f.host, pax), hash);
  assert.equal(readFileSync(join(scripts, 'PAX_Purview.ps1'), 'utf8'), "Write-Output 'PAX 2'\n");
});

test('pax local: writeScripts writes nothing when two scripts share a name', (t) => {
  const f = pc(t);
  const dir = tempDir(t);
  writeFileSync(join(dir, 'Task.ps1'), 'x');
  assert.throws(() => writeScripts(f.host, [join(dir, 'Task.ps1')]), { message: 'Two of the refresh scripts have the same name.' });
  assert.deepEqual(readdirSync(paxPaths(f.host).scripts), []);
});

test("pax local: writeScripts' copies don't carry a download's mark of the web", { skip: process.platform !== 'win32' }, (t) => {
  const f = pc(t);
  const pax = paxScripts(t);
  try {
    writeFileSync(`${pax[0]}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  } catch {
    t.skip('This file system has no alternate data streams.');
    return;
  }
  assert.equal(existsSync(`${pax[0]}:Zone.Identifier`), true);
  writeScripts(f.host, pax);
  const copy = join(paxPaths(f.host).scripts, 'Run-PAX-AIBV.ps1');
  assert.equal(readFileSync(copy, 'utf8'), "Write-Output 'runs PAX'\n");
  assert.equal(existsSync(`${copy}:Zone.Identifier`), false);
});

test('pax local: refreshConfig fills refresh.json from the install record and product.js', () => {
  const cfg = refreshConfig(paxConfig());
  assert.deepEqual(cfg, {
    schema: 1,
    product: PRODUCT.name,
    tenantId: TENANT,
    clientId: APP_ID,
    credentialTarget: TARGET,
    siteId: 'contoso.sharepoint.com:/sites/Analytics',
    library: 'Shared Documents',
    folderPath: '/Copilot',
    paxReleaseTag: PAX_RELEASE.tag,
    paxSha256: PAX_RELEASE.sha256,
    files: { ...PRODUCT.pax.files },
    seedDays: SEED_DAYS,
    agent365: false,
    repairHint: `To fix it, run the ${PRODUCT.installer}'s repair: ${commandLine('install')}`,
  });
  assert.match(cfg.paxReleaseTag, /^purview-v\d+\.\d+\.\d+$/);
  assert.match(cfg.paxSha256, /^[0-9a-f]{64}$/);
  // A copy: refresh.json can't change product.js.
  assert.notEqual(cfg.files, PRODUCT.pax.files);
  assert.ok(!Object.isFrozen(cfg.files));
});

test("pax local: refreshConfig prefers Graph's site ID and takes the record's PAX settings", () => {
  const config = paxConfig();
  assert.ok(config.sharePoint);
  config.sharePoint.siteId = 'contoso.sharepoint.com,site-guid,web-guid';
  config.pax = { seedDays: 90, agent365: true };
  const file = join(tmpdir(), 'records', 'contoso setup.json');
  const cfg = refreshConfig(config, { configFile: file });
  assert.equal(cfg.siteId, 'contoso.sharepoint.com,site-guid,web-guid');
  assert.equal(cfg.seedDays, 90);
  assert.equal(cfg.agent365, true);
  assert.equal(cfg.repairHint, `To fix it, run the ${PRODUCT.installer}'s repair: ${commandLine(`install --config "${file}"`)}`);
});

test('pax local: refreshConfig needs the folder, the app and the tenant', () => {
  const noFolder = paxConfig();
  delete noFolder.sharePoint;
  assert.throws(() => refreshConfig(noFolder), { message: 'The install record has no SharePoint folder yet.' });
  const noApp = paxConfig();
  delete noApp.app.appId;
  assert.throws(() => refreshConfig(noApp), { message: 'The install record has no app registration yet.' });
  const noTenant = paxConfig();
  delete noTenant.tenantId;
  assert.throws(() => refreshConfig(noTenant), { message: 'The install record has no tenant yet.' });
});

test('pax local: writeRefreshConfig writes refresh.json in the refresh folder', (t) => {
  const f = pc(t);
  const cfg = refreshConfig(paxConfig());
  const file = writeRefreshConfig(f.host, cfg);
  assert.equal(file, paxPaths(f.host).config);
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(cfg, null, 2)}\n`);
  assert.deepEqual(readdirSync(f.host.root), ['refresh.json']);
});

test("pax local: writeRefreshConfig keeps an admin's settings, and the drive while the site and library stay", (t) => {
  const f = pc(t);
  const cfg = refreshConfig(paxConfig());
  mkdirSync(f.host.root, { recursive: true });
  const old = { ...cfg, maxDays: 7, deidentify: true, driveId: 'drive-1', seedDays: 5, folderPath: '/Old' };
  writeFileSync(paxPaths(f.host).config, `\uFEFF${JSON.stringify(old, null, 2)}\n`);
  writeRefreshConfig(f.host, cfg);
  assert.deepEqual(JSON.parse(readFileSync(paxPaths(f.host).config, 'utf8')), { ...cfg, maxDays: 7, deidentify: true, driveId: 'drive-1' });
  assert.deepEqual(readdirSync(f.host.root), ['refresh.json']);
});

test('pax local: writeRefreshConfig drops the drive when the site or the library changes', (t) => {
  const f = pc(t);
  const cfg = refreshConfig(paxConfig());
  mkdirSync(f.host.root, { recursive: true });
  /** @param {Record<string, unknown>} before */
  const rewrite = (before) => {
    writeFileSync(paxPaths(f.host).config, JSON.stringify(before));
    writeRefreshConfig(f.host, cfg);
    return JSON.parse(readFileSync(paxPaths(f.host).config, 'utf8'));
  };
  const movedSite = rewrite({ ...cfg, siteId: 'contoso.sharepoint.com:/sites/Old', driveId: 'drive-old', maxDays: 7 });
  assert.equal('driveId' in movedSite, false);
  assert.equal(movedSite.siteId, cfg.siteId);
  assert.equal(movedSite.maxDays, 7);
  const movedLibrary = rewrite({ ...cfg, library: 'Documents', driveId: 'drive-old', maxDays: 7 });
  assert.equal('driveId' in movedLibrary, false);
  assert.equal(movedLibrary.library, 'Shared Documents');
  assert.equal(movedLibrary.maxDays, 7);
});

test("pax local: writeRefreshConfig replaces a refresh.json it can't read", (t) => {
  const f = pc(t);
  const cfg = refreshConfig(paxConfig());
  mkdirSync(f.host.root, { recursive: true });
  for (const body of ['{ not json', '[1, 2]', 'null', '']) {
    writeFileSync(paxPaths(f.host).config, body);
    writeRefreshConfig(f.host, cfg);
    assert.deepEqual(JSON.parse(readFileSync(paxPaths(f.host).config, 'utf8')), cfg, body);
  }
});

test('pax local: readState reads state.json, or gives undefined', (t) => {
  const f = pc(t);
  assert.equal(readState(f.host), undefined);
  f.writeState({ lastResult: 'success', lastRunUtc: NOW });
  assert.deepEqual(readState(f.host), { lastResult: 'success', lastRunUtc: NOW });
  writeFileSync(paxPaths(f.host).state, '\uFEFF{"lastResult":"failed"}');
  assert.deepEqual(readState(f.host), { lastResult: 'failed' });
  for (const body of ['{"lastResult":', '["success"]', 'null', '']) {
    writeFileSync(paxPaths(f.host).state, body);
    assert.equal(readState(f.host), undefined, body);
  }
});

test('pax local: storeSecret gives the secret to credential.ps1 on standard input only', async (t) => {
  const f = pc(t);
  const options = spyOptions(f);
  await storeSecret(f.host, TARGET, APP_ID, SECRET);
  assert.deepEqual(f.keys(), ['credential Write']);
  const [call] = f.calls;
  assert.equal(call.file, 'pwsh');
  assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-File', join(RUNNER_DIR, 'credential.ps1'), '-Action', 'Write', '-Target', TARGET, '-UserName', APP_ID]);
  assert.equal(call.input, SECRET);
  assert.deepEqual(options, [{ timeoutMs: 120_000, input: SECRET }]);
  assert.deepEqual(f.credentials[TARGET], { userName: APP_ID, secret: SECRET, lastWrittenUtc: NOW });

  // With the pwsh checkHost found, and through the rest of the secret's life.
  f.host.pwsh = process.execPath;
  await storeSecret(f.host, TARGET, APP_ID, SECRET);
  await secretStored(f.host, TARGET);
  await removeSecret(f.host, TARGET);
  assert.equal(f.calls[1].file, process.execPath);
  for (const c of f.calls) assert.ok(!c.args.some((a) => a.includes(SECRET)), `The secret is on the command line of ${c.key}.`);
  assert.deepEqual(
    f.calls.filter((c) => c.input !== undefined).map((c) => c.key),
    ['credential Write', 'credential Write'],
  );
});

test('pax local: storeSecret fails unless Credential Manager says it saved the secret', async (t) => {
  const f = pc(t);
  const what = 'Saving the client secret in Windows Credential Manager';
  f.answer['credential Write'] = [
    printed({ target: TARGET, written: false }),
    failed('Access is denied.'),
    missing,
    { code: 0, stdout: 'Saved.\n', stderr: '' },
  ];
  await assert.rejects(storeSecret(f.host, TARGET, APP_ID, SECRET), { message: `Windows Credential Manager didn't confirm it saved ${TARGET}.` });
  await assert.rejects(storeSecret(f.host, TARGET, APP_ID, SECRET), { message: `${what} failed (exit code 1): Access is denied.` });
  await assert.rejects(storeSecret(f.host, TARGET, APP_ID, SECRET), { message: `${what} failed: PowerShell 7 (pwsh) isn't installed. Install it with: ${PWSH_INSTALL}` });
  await assert.rejects(storeSecret(f.host, TARGET, APP_ID, SECRET), { message: `${what} failed (exit code 0): Saved.` });
  assert.deepEqual(f.credentials, {});
});

test('pax local: secretStored says whether the secret is there, and never what it is', async (t) => {
  const f = pc(t);
  assert.deepEqual(await secretStored(f.host, TARGET), { exists: false });
  await storeSecret(f.host, TARGET, APP_ID, SECRET);
  assert.deepEqual(await secretStored(f.host, TARGET), { exists: true, userName: APP_ID, lastWrittenUtc: NOW });
  assert.deepEqual(f.calls[2].args.slice(4), ['-Action', 'Test', '-Target', TARGET]);
  // Only exists: true counts, and nothing else the script prints comes back.
  f.answer['credential Test'] = [printed({ target: TARGET, exists: 'yes', secret: SECRET, password: SECRET })];
  assert.deepEqual(await secretStored(f.host, TARGET), { exists: false });
  f.answer['credential Test'] = [failed('Credential Manager is locked.')];
  await assert.rejects(secretStored(f.host, TARGET), { message: 'Checking Windows Credential Manager failed (exit code 1): Credential Manager is locked.' });
});

test('pax local: removeSecret deletes the secret and says whether there was one', async (t) => {
  const f = pc(t);
  assert.equal(await removeSecret(f.host, TARGET), false);
  await storeSecret(f.host, TARGET, APP_ID, SECRET);
  assert.equal(await removeSecret(f.host, TARGET), true);
  assert.equal(f.credentials[TARGET], undefined);
  assert.deepEqual(f.calls.at(-1)?.args.slice(4), ['-Action', 'Delete', '-Target', TARGET]);
  f.answer['credential Delete'] = [failed('Element not found.')];
  await assert.rejects(removeSecret(f.host, TARGET), { message: 'Removing the client secret from Windows Credential Manager failed (exit code 1): Element not found.' });
});

test('pax local: registerTask registers refresh.ps1 with refresh.json, the time and the description', async (t) => {
  const f = pc(t);
  const options = spyOptions(f);
  const { scripts, config } = paxPaths(f.host);
  const report = await registerTask(f.host, { name: PRODUCT.pax.task, at: TASK_AT, description: DESCRIPTION });
  assert.deepEqual(f.calls[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    TASK_PS1,
    '-Action',
    'Register',
    '-TaskName',
    PRODUCT.pax.task,
    '-ScriptPath',
    join(scripts, 'refresh.ps1'),
    '-ConfigPath',
    config,
    '-At',
    TASK_AT,
    '-Description',
    DESCRIPTION,
  ]);
  assert.deepEqual(options, [{ timeoutMs: 120_000 }]);
  assert.equal(report.exists, true);
  assert.equal(report.taskName, PRODUCT.pax.task);
  assert.equal(report.runLevel, 'Limited');
  assert.deepEqual(f.tasks[PRODUCT.pax.task], report);
});

test("pax local: registerTask fails when Task Scheduler doesn't show the task", async (t) => {
  const f = pc(t);
  const task = { name: PRODUCT.pax.task, at: TASK_AT, description: DESCRIPTION };
  f.answer['task Register'] = [printed({ taskName: PRODUCT.pax.task, exists: false }), failed('Access is denied.')];
  await assert.rejects(registerTask(f.host, task), { message: `Task Scheduler doesn't show ${PRODUCT.pax.task} after registering it.` });
  await assert.rejects(registerTask(f.host, task), { message: 'Registering the scheduled task failed (exit code 1): Access is denied.' });
});

test('pax local: taskInfo, startTask and unregisterTask', async (t) => {
  const f = pc(t);
  const name = PRODUCT.pax.task;
  assert.deepEqual(await taskInfo(f.host, name), { taskName: name, exists: false });
  await assert.rejects(startTask(f.host, name), { message: `Starting the scheduled task failed (exit code 1): The task ${name} isn't registered.` });
  assert.equal(await unregisterTask(f.host, name), false);

  await registerTask(f.host, { name, at: TASK_AT, description: DESCRIPTION });
  const info = await taskInfo(f.host, name);
  assert.equal(info.exists, true);
  assert.equal(info.neverRan, true);
  const started = await startTask(f.host, name);
  assert.equal(started.neverRan, false);
  assert.equal(started.lastRunTime, NOW);
  assert.equal(readState(f.host)?.lastResult, 'success');
  assert.equal(await unregisterTask(f.host, name), true);
  assert.equal(f.tasks[name], undefined);
  assert.deepEqual(
    f.calls.map((c) => c.args.slice(4, 8)),
    ['Info', 'Start', 'Unregister', 'Register', 'Info', 'Start', 'Unregister'].map((action) => ['-Action', action, '-TaskName', name]),
  );

  f.answer['task Info'] = [failed('The Task Scheduler service is not available.')];
  await assert.rejects(taskInfo(f.host, name), { message: 'Reading the scheduled task failed (exit code 1): The Task Scheduler service is not available.' });
  f.answer['task Unregister'] = [{ code: null, stdout: '', stderr: '', timedOut: true }];
  await assert.rejects(unregisterTask(f.host, name), { message: "Removing the scheduled task didn't finish in time, so the installer stopped it." });
});

test('pax local: taskCurrent keeps a task that runs this refresh', async (t) => {
  const { f, report, recorded } = await registered(t);
  assert.equal(taskCurrent(report, f.host, recorded, TASK_AT), true);
  // Running now, other casing, a trailing slash, or a sign-in type the user changed: still this task.
  assert.equal(taskCurrent({ ...report, state: 'Running' }, f.host, recorded, TASK_AT), true);
  assert.equal(taskCurrent({ ...report, arguments: report.arguments?.toUpperCase() }, f.host, recorded, TASK_AT), true);
  assert.equal(taskCurrent({ ...report, workingDirectory: `${report.workingDirectory}\\` }, f.host, recorded, TASK_AT), true);
  assert.equal(taskCurrent({ ...report, workingDirectory: `${report.workingDirectory}/` }, f.host, recorded, TASK_AT), true);
  assert.equal(taskCurrent({ ...report, workingDirectory: report.workingDirectory?.toUpperCase() }, f.host, recorded, TASK_AT), true);
  assert.equal(taskCurrent({ ...report, logonType: 'Password' }, f.host, recorded, TASK_AT), true);
});

test('pax local: taskCurrent replaces a task that does something else', async (t) => {
  const { f, report, recorded } = await registered(t);
  const { scripts, config } = paxPaths(f.host);
  const other = join(f.base, 'other');
  /** @param {TaskReport} info */
  const current = (info) => taskCurrent(info, f.host, recorded, TASK_AT);
  assert.equal(current({ taskName: PRODUCT.pax.task, exists: false }), false);
  assert.equal(current({ ...report, state: 'Disabled' }), false);
  // Another start time.
  assert.equal(taskCurrent(report, f.host, recorded, '03:30'), false);
  assert.equal(taskCurrent(report, f.host, { ...recorded, at: '03:30' }, TASK_AT), false);
  assert.equal(taskCurrent(report, f.host, undefined, TASK_AT), false);
  // Another script or refresh.json.
  assert.equal(current({ ...report, arguments: `-NoProfile -File "${join(other, 'refresh.ps1')}" -Config "${config}"` }), false);
  assert.equal(current({ ...report, arguments: `-NoProfile -File "${join(scripts, 'refresh.ps1')}" -Config "${join(other, 'refresh.json')}"` }), false);
  assert.equal(current({ ...report, arguments: `-NoProfile -File "${join(scripts, 'refresh.ps1.old')}" -Config "${config}"` }), false);
  assert.equal(current({ ...report, arguments: undefined }), false);
  // Another working folder.
  assert.equal(current({ ...report, workingDirectory: other }), false);
  assert.equal(current({ ...report, workingDirectory: null }), false);
  // A pwsh.exe that has gone.
  assert.equal(current({ ...report, execute: join(f.base, 'no-such-pwsh.exe') }), false);
  assert.equal(current({ ...report, execute: undefined }), false);
  assert.equal(current({ ...report, execute: '' }), false);
});

test('pax local: checkFolder runs the check as the app and reads its answer', async (t) => {
  const f = pc(t);
  const options = spyOptions(f);
  assert.deepEqual(await checkFolder(f.host), { ok: true, siteId: 'contoso.sharepoint.com,site-guid,web-guid', driveId: 'drive-1', folder: PRODUCT.name });
  assert.deepEqual(f.calls[0].args.slice(3), [join(RUNNER_DIR, 'refresh.ps1'), '-Config', paxPaths(f.host).config, '-Check']);
  assert.deepEqual(options, [{ timeoutMs: 180_000 }]);
});

test("pax local: checkFolder passes on a refusal with Graph's status", async (t) => {
  const f = pc(t);
  f.answer['refresh check'] = [
    { code: 1, stdout: 'Checking...\n{"ok":false,"error":"Access denied.","status":403}\n', stderr: 'ERROR: Access denied.\n' },
    printed({ ok: false, error: 'Not found.', status: '404', siteId: '', extra: 'x' }),
  ];
  assert.deepEqual(await checkFolder(f.host), { ok: false, error: 'Access denied.', status: 403 });
  assert.deepEqual(await checkFolder(f.host), { ok: false, error: 'Not found.' });
});

test('pax local: checkFolder turns a script that crashed into a failed check', async (t) => {
  const f = pc(t);
  const parserError = ['ParserError: C:\\scripts\\refresh.ps1:10', 'Line |', '  10 |  if (', '     |      ~', "     | Missing condition in if statement after 'if ('.", ''].join('\n');
  f.answer['refresh check'] = [{ code: 1, stdout: '', stderr: parserError }, missing, { code: null, stdout: '', stderr: '', timedOut: true }, printed({ ok: 'true' })];
  const what = 'Checking the SharePoint folder';
  assert.deepEqual(await checkFolder(f.host), { ok: false, error: `${what} failed (exit code 1): Missing condition in if statement after 'if ('.` });
  assert.deepEqual(await checkFolder(f.host), { ok: false, error: `${what} failed: PowerShell 7 (pwsh) isn't installed. Install it with: ${PWSH_INSTALL}` });
  assert.deepEqual(await checkFolder(f.host), { ok: false, error: `${what} didn't finish in time, so the installer stopped it.` });
  assert.deepEqual(await checkFolder(f.host), { ok: false, error: `${what} failed (exit code 0): {"ok":"true"}` });
});

test('pax local: uploadToFolder uploads one file, under another name or in a subfolder when asked', async (t) => {
  const f = pc(t);
  const options = spyOptions(f);
  const { config } = paxPaths(f.host);
  const file = join(f.base, 'Copilot report.csv');
  await uploadToFolder(f.host, file);
  await uploadToFolder(f.host, file, { remoteName: 'renamed.csv', remoteFolder: 'Archive/2026' });
  assert.deepEqual(f.uploads, [{ file }, { file, remoteName: 'renamed.csv', remoteFolder: 'Archive/2026' }]);
  assert.deepEqual(f.calls[0].args.slice(4), ['-Config', config, '-Upload', file]);
  assert.deepEqual(f.calls[1].args.slice(4), ['-Config', config, '-Upload', file, '-RemoteName', 'renamed.csv', '-RemoteFolder', 'Archive/2026']);
  assert.deepEqual(options, [{ timeoutMs: 30 * 60_000 }, { timeoutMs: 30 * 60_000 }]);
  f.answer['refresh upload'] = [failed('The folder is read-only.')];
  await assert.rejects(uploadToFolder(f.host, file), { message: 'Uploading Copilot report.csv failed (exit code 1): The folder is read-only.' });
});

test('pax local: runRefresh runs the refresh in this window, with -Days when asked', async (t) => {
  const f = pc(t);
  const options = spyOptions(f);
  const { config } = paxPaths(f.host);
  assert.equal((await runRefresh(f.host, { days: 7 })).code, 0);
  await runRefresh(f.host);
  await runRefresh(f.host, { days: 180, timeoutMs: 5_000 });
  assert.deepEqual(
    f.calls.map((c) => c.args.slice(4)),
    [['-Config', config, '-Days', '7'], ['-Config', config], ['-Config', config, '-Days', '180']],
  );
  assert.deepEqual(options, [{ timeoutMs: RUN_LIMIT_MS }, { timeoutMs: RUN_LIMIT_MS }, { timeoutMs: 5_000 }]);
  assert.deepEqual(f.refreshes, [{ days: 7 }, {}, { days: 180 }]);
  assert.equal(readState(f.host)?.lastResult, 'success');
});

test('pax local: runRefresh refuses days refresh.ps1 would refuse, without running it', async (t) => {
  const f = pc(t);
  for (const days of [0, -1, 181, 1.5, Number.NaN]) {
    await assert.rejects(runRefresh(f.host, { days }), { name: 'RangeError', message: `A refresh reads from 1 to 180 days, not ${days}.` });
  }
  assert.deepEqual(f.calls, []);
});

test("pax local: runRefresh hands back the refresh's result rather than throwing", async (t) => {
  const f = pc(t, { run: 'busy' });
  const busy = await runRefresh(f.host);
  assert.equal(busy.code, 2);
  assert.equal(errorText(busy.stderr), 'Another refresh is running.');
  f.setRun('no-data');
  assert.equal((await runRefresh(f.host)).code, 3);
  assert.equal(readState(f.host)?.lastResult, 'no-data');
  f.setRun('failed');
  assert.equal((await runRefresh(f.host)).code, 1);
  assert.equal(readState(f.host)?.lastError, 'PAX could not sign in.');
  f.answer['refresh run'] = [missing];
  assert.equal((await runRefresh(f.host)).missing, true);
});

test('pax local: removeLocal deletes the refresh folder and nothing above it', (t) => {
  const f = pc(t);
  assert.equal(removeLocal(f.host), false);
  writeScripts(f.host, paxScripts(t));
  writeRefreshConfig(f.host, refreshConfig(paxConfig()));
  f.writeState({ lastResult: 'success' });
  assert.equal(removeLocal(f.host), true);
  assert.equal(existsSync(f.host.root), false);
  assert.equal(existsSync(dirname(f.host.root)), true);
  assert.equal(removeLocal(f.host), false);
});

test("pax local: removeLocal won't delete a folder that isn't the refresh's", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'keep.txt'), 'x');
  const host = { ...pc(t).host, root: dir };
  assert.throws(() => removeLocal(host), { message: `Won't delete ${dir}: it isn't the refresh's folder.` });
  assert.equal(existsSync(join(dir, 'keep.txt')), true);
});

test('pax local: runScript runs the installed copy, else the one that ships with the installer', async (t) => {
  const f = pc(t);
  const { scripts } = paxPaths(f.host);
  const args = ['-Action', 'Info', '-TaskName', PRODUCT.pax.task];
  await runScript(f.host, 'task.ps1', args);
  writeScripts(f.host, paxScripts(t));
  await runScript(f.host, 'task.ps1', args);
  // An installed script that has gone.
  rmSync(join(scripts, 'credential.ps1'));
  await runScript(f.host, 'credential.ps1', ['-Action', 'Test', '-Target', TARGET]);
  // A PAX script doesn't ship with the installer, so there's nothing to fall back to.
  rmSync(join(scripts, 'Run-PAX-AIBV.ps1'));
  await runScript(f.host, 'Run-PAX-AIBV.ps1', []);
  assert.deepEqual(
    f.calls.map((c) => c.args[3]),
    [TASK_PS1, join(scripts, 'task.ps1'), join(RUNNER_DIR, 'credential.ps1'), join(scripts, 'Run-PAX-AIBV.ps1')],
  );
  for (const c of f.calls) {
    assert.equal(c.file, 'pwsh');
    assert.deepEqual(c.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File']);
  }
  assert.deepEqual(f.calls[0].args.slice(4), args);
});

test('pax local: paxPaths and the default PC', () => {
  const env = { LOCALAPPDATA: join(tmpdir(), 'Local'), ProgramFiles: join(tmpdir(), 'Program Files') };
  const host = defaultPaxHost(env);
  const root = join(env.LOCALAPPDATA, PRODUCT.home, PRODUCT.pax.folder);
  assert.equal(host.root, root);
  assert.deepEqual(host.pwshCandidates, ['pwsh', join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')]);
  assert.equal(host.platform, process.platform);
  assert.equal(host.cloudShell, false);
  assert.equal(host.pwsh, undefined);
  assert.equal(typeof host.run, 'function');
  assert.deepEqual(paxPaths(host), {
    root,
    scripts: join(root, 'scripts'),
    config: join(root, 'refresh.json'),
    state: join(root, 'state.json'),
    logs: join(root, 'logs'),
    data: join(root, 'data'),
  });
  // Without the variables: the user's AppData and Program Files.
  const bare = defaultPaxHost({});
  assert.equal(bare.root, join(homedir(), 'AppData', 'Local', PRODUCT.home, PRODUCT.pax.folder));
  assert.equal(bare.pwshCandidates[1], join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'));
  assert.equal(defaultPaxHost({ [PRODUCT.env.cloudShell]: '1' }).cloudShell, true);
});

test('pax local: paxHostOf makes the PC once per context', (t) => {
  const f = pc(t);
  assert.equal(paxHostOf({ paxHost: f.host }), f.host);
  /** @type {{ paxHost?: import('../src/steps/pax/local.js').PaxHost }} */
  const ctx = {};
  const made = paxHostOf(ctx);
  assert.equal(ctx.paxHost, made);
  assert.equal(paxHostOf(ctx), made);
  assert.equal(made.root, defaultPaxHost().root);
});

test('pax local: task.ps1 registers the task with limited rights and the run limit the installer waits for', () => {
  const body = readFileSync(TASK_PS1, 'utf8');
  assert.match(body, /New-ScheduledTaskPrincipal [^\r\n]*-RunLevel Limited\b/);
  assert.doesNotMatch(body, /-RunLevel\s+Highest/i);
  const hours = /-ExecutionTimeLimit \(New-TimeSpan -Hours (\d+)\)/.exec(body);
  assert.ok(hours, "task.ps1 doesn't limit how long a run takes");
  assert.equal(Number(hours[1]) * 60 * 60_000, RUN_LIMIT_MS);
});

test("pax local: the refresh's own time budget stops a long load well inside the task's run limit", () => {
  const body = readFileSync(join(RUNNER_DIR, 'refresh.ps1'), 'utf8');
  const budget = /^\s*runHours\s*=\s*(\d+)\s*$/m.exec(body);
  assert.ok(budget, "refresh.ps1 has no default runHours");
  // The budget is checked before each window, so a window that starts just inside it needs room to finish.
  assert.ok(Number(budget[1]) * 60 * 60_000 <= RUN_LIMIT_MS - 2 * 60 * 60_000, `runHours ${budget[1]}`);
  // The installer leaves the window size and the budget to refresh.ps1's defaults, so an admin's own values in refresh.json survive a repair.
  const cfg = refreshConfig(paxConfig());
  assert.ok(!('windowDays' in cfg) && !('runHours' in cfg));
});

test("pax local: the task's name and start time pass task.ps1's checks", () => {
  const body = readFileSync(TASK_PS1, 'utf8');
  const at = /\[ValidatePattern\('([^']+)'\)\] \[string\]\$At = '([^']+)'/.exec(body);
  assert.ok(at, "task.ps1's -At has no pattern");
  assert.match(TASK_AT, new RegExp(at[1]));
  assert.equal(at[2], TASK_AT);
  assert.doesNotMatch(PRODUCT.pax.task, /[\\/]/);
  assert.equal(PRODUCT.pax.task, PRODUCT.pax.task.trim());
});

test("pax local: nothing in the installer bypasses or sets PowerShell's execution policy", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.includes(join(SRC, 'steps', 'pax', 'local.js')));
  assert.ok(files.includes(TASK_PS1));
  // Built from parts, so this file doesn't spell out what it looks for.
  const spelled = new RegExp(`Execution${'Policy'}[\\s"':=]+${'By'}pass`, 'i');
  const short = new RegExp(`(^|[\\s"'])-(ep|ex|exec)[\\s:]+['"]?${'by'}pass\\b`, 'im');
  const sets = /^\s*Set-ExecutionPolicy\b/im;
  const offenders = files.filter((file) => {
    const body = readFileSync(file, 'utf8');
    return spelled.test(body) || short.test(body) || (file.endsWith('.ps1') && sets.test(body));
  });
  assert.deepEqual(offenders, []);
});

test("pax local: local.js and the runner scripts take the product's names from product.js", () => {
  const name = new RegExp(PRODUCT.name, 'i');
  for (const file of [join(SRC, 'steps', 'pax', 'local.js'), ...RUNNER_SCRIPTS.map((s) => join(RUNNER_DIR, s))]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), name, file);
  }
});
