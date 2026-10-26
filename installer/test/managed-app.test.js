// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../src/config.js';
import { commandLine } from '../src/launch.js';
import {
  CLI_PACKAGE,
  CLI_PACKAGE_DIR,
  cliBin,
  COMMAND_TIMEOUT_MS,
  createCli,
  DEPLOY_TIMEOUT_MS,
  installedVersion,
  MIN_NODE,
  nodeOk,
  parseJson,
  pinnedVersion,
} from '../src/managed-app/cli.js';
import { ADMIN_STEPS, CLI_APP_ID, deployAgain, deployElsewhere, explain, LINKS, notReady } from '../src/managed-app/errors.js';
import { APP_NAME, appDirOf, buildHash, dataHint, deployTheApp, NOT_READY_NAMES, removeTheApp, THE_APP, whyNot } from '../src/managed-app/flow.js';
import {
  APP_CONFIG,
  authStatus,
  BUILD_PATH,
  createApp,
  deleteApp,
  deployApp,
  isGuid,
  login,
  playUrl,
  readAppConfig,
  shareApp,
  stripBom,
  switchAccount,
  verifyShare,
} from '../src/managed-app/steps.js';
import { PRODUCT } from '../src/product.js';
import { nextSteps } from '../src/steps/next-steps.js';
import { fakeCtx, fakeUi } from './fakes.js';
import { fakePaxHost } from './pax-fakes.js';

/** @typedef {import('../src/managed-app/cli.js').CliResult} CliResult */
/** @typedef {import('../src/managed-app/cli.js').RunCli} RunCli */
/** @typedef {import('../src/managed-app/cli.js').RunOptions} RunOptions */
/** @typedef {import('../src/managed-app/errors.js').Failure} Failure */
/** @typedef {import('../src/config.js').ManagedAppConfig} ManagedAppConfig */
/** @typedef {{ args: string[], options?: RunOptions }} Call */

const USER = 'admin@contoso.com';
const OTHER_USER = 'megan@contoso.com';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_APP_ID = '66666666-7777-4888-9999-000000000000';
const DEV_ENV = 'contoso-dev-environment';
const OTHER_ENV = 'contoso-old-environment';
const PROD_ENV = 'contoso-prod-environment';
const GROUP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEW_GROUP = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GROUP_NAME = `${PRODUCT.name} viewers`;
const PLAY_URL = `https://apps.contoso.com/play/${APP_ID}`;
const FOLDER_URL = `https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/${PRODUCT.name}`;
const SHAREPOINT = {
  folderUrl: FOLDER_URL,
  siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
  sitePath: 'contoso.sharepoint.com:/sites/Analytics',
  library: 'Shared Documents',
  folderPath: `/${PRODUCT.name}`,
};
const PINNED = pinnedVersion();
const NODE_OK = `v${MIN_NODE}`;
const DEPLOYED_AT = '2026-06-01T12:00:00.000Z';
/** A built app. */
const BUILD = { 'index.html': '<html></html>', 'assets/app.js': 'x' };
/** Never created: createCli only joins paths onto it. */
const CLI_DIR = join(tmpdir(), 'valuelens-app-test-cli');

/** @type {string[]} */
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'valuelens-app-test-'));
  temps.push(dir);
  return dir;
};

/**
 * @param {string} dir
 * @param {Record<string, string>} [files]
 */
function writeFiles(dir, files = BUILD) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/**
 * A package that pins the CLI, with the CLI installed in it, or not with installed: null.
 * @param {string} dir
 * @param {{ pinned?: string, installed?: string | null }} [o]
 */
function writeCliPackage(dir, { pinned = PINNED, installed = pinned } = {}) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { [CLI_PACKAGE]: pinned } }));
  if (installed !== null) {
    const pkg = join(dir, 'node_modules', '@microsoft', 'managed-apps-cli');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: CLI_PACKAGE, version: installed }));
    writeFileSync(join(pkg, 'dist', 'Bin.js'), '// A stand-in. Tests never run it.\n');
  }
  return dir;
}

/**
 * What the CLI gives back when a command worked.
 * @param {Record<string, any>} [data]
 * @returns {CliResult}
 */
const passed = (data = {}) => {
  const json = { success: true, ...data };
  return { ok: true, exitCode: 0, data: json, stdout: JSON.stringify(json), stderr: '' };
};

/**
 * What it gives back when one failed.
 * @param {string} error
 * @param {Partial<CliResult>} [more]
 * @returns {CliResult}
 */
const failedWith = (error, more = {}) => ({
  ok: false,
  exitCode: 1,
  data: { success: false, errorMessage: error },
  error,
  stdout: '',
  stderr: '',
  ...more,
});

/**
 * A run that gives back the scripted results in order and records each call.
 * @param {...CliResult} results
 */
function scripted(...results) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {RunCli} */
  const run = async (args, options) => {
    calls.push(options === undefined ? { args } : { args, options });
    const next = results.shift();
    if (!next) throw new Error(`Nothing scripted for ${args.join(' ')}`);
    return next;
  };
  return { run, calls };
}

/** A child's stdout or stderr. */
function fakeStream() {
  /** @type {string[]} */
  const encodings = [];
  return Object.assign(new EventEmitter(), {
    encodings,
    setEncoding: (/** @type {string} */ encoding) => {
      encodings.push(encoding);
    },
  });
}

/** @param {boolean} piped */
function fakeChild(piped) {
  /** @type {string[]} */
  const kills = [];
  return Object.assign(new EventEmitter(), {
    stdout: piped ? fakeStream() : null,
    stderr: piped ? fakeStream() : null,
    kills,
    kill: () => {
      kills.push('kill');
      return true;
    },
  });
}

/** @typedef {ReturnType<typeof fakeChild>} FakeChild */
/** @typedef {{ file: string, args: string[], options: any }} SpawnCall */

/**
 * A spawn that records its calls and hands back fake children. `script` plays each child once the
 * CLI code has attached its listeners.
 * @param {(child: FakeChild, call: SpawnCall) => void} [script]
 */
function fakeSpawn(script) {
  /** @type {SpawnCall[]} */
  const calls = [];
  /** @type {FakeChild[]} */
  const children = [];
  const spawn = (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ options) => {
    const call = { file, args, options };
    calls.push(call);
    const child = fakeChild(options?.stdio !== 'inherit');
    children.push(child);
    if (script) queueMicrotask(() => script(child, call));
    return child;
  };
  return { spawn: /** @type {any} */ (spawn), calls, children };
}

/**
 * Plays a CLI that prints, then exits.
 * @param {{ stdout?: string, stderr?: string, code?: number | null }} o
 */
const exits =
  ({ stdout = '', stderr = '', code = 0 }) =>
  (/** @type {FakeChild} */ child) => {
    if (stdout) child.stdout?.emit('data', stdout);
    if (stderr) child.stderr?.emit('data', stderr);
    child.emit('close', code);
  };

/**
 * Runs a command through createCli, with a fake spawn playing `o`.
 * @param {{ stdout?: string, stderr?: string, code?: number | null }} o
 * @param {string[]} [args]
 */
const cliSays = (o, args = ['app', 'deploy']) => createCli({ cliDir: CLI_DIR, spawn: fakeSpawn(exits(o)).spawn, timeoutMs: 0 }).run(args);

const plain = (/** @type {string} */ s) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** @param {string} text @param {string} part */
const has = (text, part) => assert.ok(text.includes(part), `Expected to find:\n  ${part}\nin:\n${text}`);

/** @param {string} text @param {string} part */
const lacks = (text, part) => assert.ok(!text.includes(part), `Expected not to find:\n  ${part}\nin:\n${text}`);

/**
 * @template T
 * @param {T} result
 * @returns {Extract<T, { ok: false }>}
 */
function mustFail(result) {
  assert.equal(/** @type {any} */ (result).ok, false, `Expected a failure: ${JSON.stringify(result)}`);
  return /** @type {any} */ (result);
}

/** @typedef {CliResult | ((call: Call) => CliResult)} Answer */

/**
 * A fake managed apps CLI, behind the `run` the flow takes. It keeps what the real one would: who's
 * signed in, the app folder's ms.config.json, and who the app is shared with. `queue` replaces a
 * command's next results.
 * @param {{ account?: string, accounts?: string[], loginAs?: string, deployUri?: string, url?: string, newAppId?: string, events?: string[] }} [o]
 */
function fakeMs(o = {}) {
  const state = {
    /** @type {string | undefined} */
    account: o.account,
    accounts: o.accounts ?? (o.account ? [o.account] : []),
    loginAs: o.loginAs ?? USER,
    deployUri: o.deployUri,
    url: o.url,
    newAppId: o.newAppId ?? APP_ID,
    /** @type {string[]} */
    shared: [],
    /** @type {string | undefined} */
    deployed: undefined,
    /** @type {string[]} */
    deleted: [],
  };
  const events = o.events ?? [];
  /** @type {(Call & { key: string })[]} */
  const calls = [];
  /** @type {Record<string, Answer[]>} */
  const queued = {};
  const keyOf = (/** @type {string[]} */ args) =>
    args[0] === 'app' && args[1] === 'share' && args[2] === 'list' ? 'app share list' : `${args[0]} ${args[1]}`;
  const flag = (/** @type {string[]} */ args, /** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

  /** @type {Record<string, (call: Call) => CliResult>} */
  const commands = {
    'auth status': () => {
      if (!state.account && !state.accounts.length) return failedWith('Not signed in. Run ms auth login.', { exitCode: 3 });
      return passed({
        signedIn: !!state.account,
        ...(state.account ? { activeAccount: { username: state.account } } : {}),
        accounts: state.accounts.map((username) => ({ username })),
      });
    },
    'auth switch': ({ args }) => {
      const want = String(flag(args, '--account')).toLowerCase();
      const found = state.accounts.find((a) => a.toLowerCase() === want);
      if (!found) return failedWith(`The CLI has no account ${want}.`);
      state.account = found;
      return passed({ activeAccount: { username: found } });
    },
    'auth login': () => {
      state.account = state.loginAs;
      if (!state.accounts.includes(state.loginAs)) state.accounts.push(state.loginAs);
      return { ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '' };
    },
    'app init': ({ args, options }) => {
      const dir = String(options?.cwd);
      if (existsSync(join(dir, APP_CONFIG))) return failedWith('ms.config.json already exists in this folder.');
      const environmentId = flag(args, '--environment-id') ?? DEV_ENV;
      const config = {
        appId: state.newAppId,
        environmentId,
        appDisplayName: flag(args, '--display-name'),
        buildType: flag(args, '--build-type'),
        buildPath: flag(args, '--build-path'),
      };
      writeFileSync(join(dir, APP_CONFIG), JSON.stringify(config, null, 2));
      return passed({ appId: state.newAppId, environmentId });
    },
    'app deploy': ({ options }) => {
      const dir = String(options?.cwd);
      if (!readAppConfig(dir)) return failedWith('There is no ms.config.json here.');
      state.deployed = buildHash(join(dir, 'dist'));
      return passed(state.deployUri ? { appPlayUri: state.deployUri } : {});
    },
    'app share': ({ args }) => {
      for (const principal of args[2].split(',')) if (!state.shared.includes(principal)) state.shared.push(principal);
      return passed({ partialFailure: false, warnings: [] });
    },
    'app share list': () => passed({ results: [{ value: state.shared.map((principalObjectId) => ({ principalObjectId, access: 'play' })) }] }),
    'app play': () => (state.url ? passed({ url: state.url }) : failedWith('The app has no link yet.')),
    'app delete': ({ args }) => {
      state.deleted.push(String(flag(args, '--app')));
      return passed({ existed: true });
    },
  };

  /** @type {RunCli} */
  const run = async (args, options) => {
    const key = keyOf(args);
    /** @type {Call} */
    const call = options === undefined ? { args } : { args, options };
    calls.push({ key, ...call });
    events.push(key);
    const next = queued[key]?.shift();
    if (next) return typeof next === 'function' ? next(call) : next;
    const command = commands[key];
    if (!command) throw new Error(`The fake CLI has no command ${key}`);
    return command(call);
  };
  return {
    run,
    state,
    calls,
    keys: () => calls.map((c) => c.key),
    /** Replaces a command's next results. @param {string} key @param {...Answer} answers */
    queue: (key, ...answers) => {
      (queued[key] ??= []).push(...answers);
    },
    /** The last call of a command. @param {string} key */
    call: (key) => {
      const found = calls.filter((c) => c.key === key).at(-1);
      assert.ok(found, `Expected a call to ${key}, got: ${calls.map((c) => c.key).join(', ')}`);
      return found;
    },
    /** What the fake answers by default, for a queued answer that also does it. @param {string} key @param {Call} call */
    answer: (key, call) => commands[key](call),
  };
}

/**
 * A PAX install about to run its app step, on a fake PC with a fake CLI signed in as the user.
 * null for group, groupName or folderUrl: none.
 * @param {{
 *   record?: ManagedAppConfig,
 *   group?: string | null,
 *   groupName?: string | null,
 *   folderUrl?: string | null,
 *   yes?: boolean,
 *   answers?: any[],
 *   ms?: Parameters<typeof fakeMs>[0],
 *   installed?: string | null,
 *   nodeVersion?: string,
 *   appConfig?: Record<string, any>,
 *   environmentId?: string,
 * }} [o]
 */
function setup(o = {}) {
  /** @type {string[]} */
  const events = [];
  const ms = fakeMs({ account: USER, deployUri: PLAY_URL, ...o.ms, events });
  const distDir = writeFiles(temp());
  const cliDir = writeCliPackage(temp(), o.installed === undefined ? {} : { installed: o.installed });
  const pc = fakePaxHost();
  temps.push(pc.base);
  const { ui, out, asked, text } = fakeUi({ yes: o.yes, answers: o.answers });
  const { ctx, config } = fakeCtx({ ui, sources: /** @type {any} */ ({ appDist: distDir }) });
  config.target = 'pax';
  if (o.group !== null) config.access = { groupId: o.group ?? GROUP, ...(o.groupName === null ? {} : { groupName: o.groupName ?? GROUP_NAME }) };
  if (o.folderUrl !== null) config.sharePoint = { ...SHAREPOINT, ...(o.folderUrl ? { folderUrl: o.folderUrl } : {}) };
  if (o.record) config.managedApp = structuredClone(o.record);
  // The fake PC, so the app's folder is in a temp folder, never in the real %LOCALAPPDATA%.
  ctx.paxHost = pc.host;
  if (o.environmentId) ctx.environmentId = o.environmentId;
  /** @type {(ManagedAppConfig | undefined)[]} */
  const saved = [];
  ctx.save = () => {
    events.push('save');
    saved.push(structuredClone(config.managedApp));
  };
  const appDir = appDirOf(ctx);
  if (o.appConfig) writeFiles(appDir, { [APP_CONFIG]: JSON.stringify(o.appConfig) });
  return {
    ctx,
    config,
    ms,
    deps: { run: ms.run, nodeVersion: o.nodeVersion ?? NODE_OK, distDir, cliDir },
    appDir,
    distDir,
    cliDir,
    events,
    saved,
    asked,
    said: () => plain(text()),
    reset: () => {
      events.length = 0;
      saved.length = 0;
      out.length = 0;
      ms.calls.length = 0;
    },
  };
}

/**
 * An install whose app is deployed and shared, ready for its next run.
 * @param {Parameters<typeof setup>[0]} [o]
 */
async function deployedApp(o = {}) {
  const s = setup(o);
  const result = await deployTheApp(s.ctx, s.deps);
  assert.equal(result.state, 'deployed', s.said());
  s.reset();
  return s;
}

/**
 * The record once the app is deployed to the developer environment and shared with the group.
 * @param {string} distDir
 * @param {ManagedAppConfig} [more]
 * @returns {ManagedAppConfig}
 */
const deployedRecord = (distDir, more = {}) => ({
  appId: APP_ID,
  environmentId: DEV_ENV,
  buildHash: buildHash(distDir),
  deployedAt: DEPLOYED_AT,
  url: PLAY_URL,
  sharedWith: [GROUP],
  ...more,
});

/** What a first deploy of a new app runs, and when it saves. */
const NEW_APP = ['auth status', 'app init', 'save', 'app deploy', 'save', 'app share', 'app share list', 'save'];

test('managed app: the CLI runs as node and its pinned Bin.js, off screen with the JSON flags', async () => {
  process.env.VALUELENS_APP_TEST = 'from this process';
  process.env.VALUELENS_APP_TEST_KEPT = 'kept';
  try {
    const json = { success: true, appId: APP_ID };
    const fake = fakeSpawn(exits({ stdout: JSON.stringify(json) }));
    const cli = createCli({
      cliDir: CLI_DIR,
      env: { VALUELENS_APP_TEST: 'from the caller', VALUELENS_APP_TEST_NEW: 'added' },
      spawn: fake.spawn,
      node: 'C:\\contoso\\node.exe',
      timeoutMs: 0,
    });
    assert.equal(cli.bin, cliBin(CLI_DIR));
    const result = await cli.run(['app', 'init', '--repo', 'none'], { cwd: 'C:\\contoso\\app' });

    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.equal(call.file, 'C:\\contoso\\node.exe');
    assert.deepEqual(call.args, [cliBin(CLI_DIR), 'app', 'init', '--repo', 'none', '--non-interactive', '--json', '--no-color']);
    assert.equal(call.options.cwd, 'C:\\contoso\\app');
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(call.options.windowsHide, true);
    // The caller's env is added to this process's, and wins.
    assert.equal(call.options.env.VALUELENS_APP_TEST, 'from the caller');
    assert.equal(call.options.env.VALUELENS_APP_TEST_NEW, 'added');
    assert.equal(call.options.env.VALUELENS_APP_TEST_KEPT, 'kept');
    assert.equal(process.env.VALUELENS_APP_TEST, 'from this process');
    assert.deepEqual(fake.children[0].stdout?.encodings, ['utf8']);
    assert.deepEqual(fake.children[0].stderr?.encodings, ['utf8']);
    assert.deepEqual(result, { ok: true, exitCode: 0, data: json, stdout: JSON.stringify(json), stderr: '' });
  } finally {
    delete process.env.VALUELENS_APP_TEST;
    delete process.env.VALUELENS_APP_TEST_KEPT;
  }
});

test('managed app: the CLI output is collected across chunks, and its JSON can be on stderr', async () => {
  const fake = fakeSpawn((child) => {
    child.stdout?.emit('data', 'Packing the app');
    child.stdout?.emit('data', '...\n');
    child.stderr?.emit('data', 'warning: slow\n{"success":true,');
    child.stderr?.emit('data', `"appId":"${APP_ID}"}\n`);
    child.emit('close', 0);
  });
  const result = await createCli({ cliDir: CLI_DIR, spawn: fake.spawn, timeoutMs: 0 }).run(['app', 'deploy']);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'Packing the app...\n');
  assert.equal(result.stderr, `warning: slow\n{"success":true,"appId":"${APP_ID}"}\n`);
  assert.deepEqual(result.data, { success: true, appId: APP_ID });
  assert.equal('error' in result, false);
});

test('managed app: JSON that says success: false is a failure, even with exit code 0', async () => {
  const json = { success: false, errorMessage: '  Environment was not found.  ', errorData: { serverErrorCode: 'EnvironmentNotFound' } };
  const result = await cliSays({ stdout: JSON.stringify(json), code: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, 'Environment was not found.');
  assert.deepEqual(result.errorData, { serverErrorCode: 'EnvironmentNotFound' });
  assert.deepEqual(result.data, json);
});

test('managed app: without an error message, a failure is the last five lines of stderr', async () => {
  const stderr = ['one', '', '  two  ', 'three', 'four', 'five', 'six', ''].join('\r\n');
  const result = await cliSays({ stderr, code: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.ok('data' in result);
  assert.equal(result.data, undefined);
  assert.equal(result.error, ['two', 'three', 'four', 'five', 'six'].join('\n'));
  assert.equal('errorData' in result, false);

  // A blank errorMessage doesn't count.
  const blank = await cliSays({ stdout: JSON.stringify({ success: false, errorMessage: '   ' }), stderr: 'The real reason\n', code: 1 });
  assert.equal(blank.error, 'The real reason');
});

test('managed app: a CLI that stops without saying why gives its exit code', async () => {
  assert.deepEqual(await cliSays({ code: 7 }), { ok: false, exitCode: 7, data: undefined, error: 'The CLI stopped with exit code 7.', stdout: '', stderr: '' });
  const killed = await cliSays({ code: null });
  assert.equal(killed.ok, false);
  assert.equal(killed.error, 'The CLI stopped.');
  assert.deepEqual(await cliSays({ code: 0 }), { ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '' });
  // A non-zero exit fails even when the JSON says success.
  const odd = await cliSays({ stdout: JSON.stringify({ success: true }), code: 1 });
  assert.equal(odd.ok, false);
  assert.equal(odd.error, 'The CLI stopped with exit code 1.');
});

test("managed app: a CLI that can't start is a failure, not a crash", async () => {
  const throwing = /** @type {any} */ (
    () => {
      throw new Error('spawn EACCES');
    }
  );
  assert.deepEqual(await createCli({ cliDir: CLI_DIR, spawn: throwing, timeoutMs: 0 }).run(['auth', 'status']), {
    ok: false,
    exitCode: null,
    data: undefined,
    error: "Couldn't start the managed apps CLI: spawn EACCES",
    stdout: '',
    stderr: '',
  });

  // A missing program: 'error', then the 'close' that follows it. The first one counts.
  const fake = fakeSpawn((child) => {
    child.emit('error', Object.assign(new Error('spawn C:\\contoso\\node.exe ENOENT'), { code: 'ENOENT' }));
    child.emit('close', -4058);
  });
  const missing = await createCli({ cliDir: CLI_DIR, spawn: fake.spawn, node: 'C:\\contoso\\node.exe', timeoutMs: 0 }).run(['auth', 'status']);
  assert.deepEqual(missing, {
    ok: false,
    exitCode: null,
    data: undefined,
    error: "Couldn't start the managed apps CLI: spawn C:\\contoso\\node.exe ENOENT",
    stdout: '',
    stderr: '',
  });
});

test('managed app: on screen, the CLI gets the terminal and no JSON flags', async () => {
  const fake = fakeSpawn((child) => child.emit('close', 0));
  const result = await createCli({ cliDir: CLI_DIR, spawn: fake.spawn, timeoutMs: 0 }).run(['auth', 'login', '--account', USER], { onScreen: true });
  const [call] = fake.calls;
  assert.equal(call.file, process.execPath);
  assert.deepEqual(call.args, [cliBin(CLI_DIR), 'auth', 'login', '--account', USER]);
  assert.equal(call.options.stdio, 'inherit');
  assert.equal(call.options.windowsHide, false);
  assert.equal(call.options.cwd, undefined);
  assert.deepEqual(result, { ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '' });

  const failing = fakeSpawn((child) => child.emit('close', 1));
  const no = await createCli({ cliDir: CLI_DIR, spawn: failing.spawn, timeoutMs: 0 }).run(['auth', 'login'], { onScreen: true });
  assert.equal(no.ok, false);
  assert.equal(no.error, 'The CLI stopped with exit code 1.');
});

test('managed app: a CLI that runs too long is stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeSpawn((child) => child.stdout?.emit('data', 'Waiting for the service...\n'));
  const pending = createCli({ cliDir: CLI_DIR, spawn: fake.spawn }).run(['auth', 'status']);
  await Promise.resolve();
  const [child] = fake.children;
  t.mock.timers.tick(COMMAND_TIMEOUT_MS - 1);
  assert.equal(child.kills.length, 0);
  t.mock.timers.tick(1);
  assert.equal(child.kills.length, 1);
  child.stderr?.emit('data', 'Stopping\n');
  child.emit('close', null);
  assert.deepEqual(await pending, {
    ok: false,
    exitCode: null,
    data: undefined,
    error: "It didn't finish within 5 minutes, so it was stopped.",
    stdout: 'Waiting for the service...\n',
    stderr: 'Stopping\n',
    timedOut: true,
  });
});

test('managed app: a deploy gets 30 minutes, and a run can set its own limit or none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeSpawn();
  const cli = createCli({ cliDir: CLI_DIR, spawn: fake.spawn });

  const deploying = deployApp(cli.run, { appDir: 'C:\\contoso\\app' });
  const [deploy] = fake.children;
  t.mock.timers.tick(COMMAND_TIMEOUT_MS);
  assert.equal(deploy.kills.length, 0);
  t.mock.timers.tick(DEPLOY_TIMEOUT_MS - COMMAND_TIMEOUT_MS);
  assert.equal(deploy.kills.length, 1);
  deploy.emit('close', 1);
  const late = mustFail(await deploying);
  assert.equal(late.result?.timedOut, true);
  assert.equal(late.problem.message, "It didn't finish within 30 minutes, so it was stopped.");
  assert.equal(late.problem.what, `It took too long, so it was stopped. Run ${deployAgain()}: it picks up where it stopped.`);

  const quick = cli.run(['auth', 'status'], { timeoutMs: 60_000 });
  t.mock.timers.tick(60_000);
  assert.equal(fake.children[1].kills.length, 1);
  fake.children[1].emit('close', 1);
  const stopped = await quick;
  assert.equal(stopped.timedOut, true);
  assert.equal(stopped.error, "It didn't finish within 1 minute, so it was stopped.");

  // A limit of 0 never stops it.
  const patient = createCli({ cliDir: CLI_DIR, spawn: fake.spawn, timeoutMs: 0 }).run(['auth', 'status']);
  t.mock.timers.tick(DEPLOY_TIMEOUT_MS * 10);
  assert.equal(fake.children[2].kills.length, 0);
  fake.children[2].emit('close', 0);
  assert.equal((await patient).ok, true);

  // Under a minute, it says seconds.
  const brief = cli.run(['auth', 'status'], { timeoutMs: 30_000 });
  t.mock.timers.tick(30_000);
  fake.children[3].emit('close', 1);
  assert.equal((await brief).error, "It didn't finish within 30 seconds, so it was stopped.");
});

test('managed app: a run that finishes in time clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeSpawn(exits({ stdout: '{"success":true}' }));
  const result = await createCli({ cliDir: CLI_DIR, spawn: fake.spawn }).run(['auth', 'status']);
  assert.equal(result.ok, true);
  t.mock.timers.tick(DEPLOY_TIMEOUT_MS);
  assert.equal(fake.children[0].kills.length, 0);
});

test('managed app: the CLI output keeps its last million characters, where the JSON is', async () => {
  const json = JSON.stringify({ success: true, appId: APP_ID });
  const fake = fakeSpawn((child) => {
    child.stdout?.emit('data', `${'x'.repeat(1_000_000)}\n`);
    child.stdout?.emit('data', json);
    child.emit('close', 0);
  });
  const result = await createCli({ cliDir: CLI_DIR, spawn: fake.spawn, timeoutMs: 0 }).run(['app', 'deploy']);
  assert.equal(result.stdout.length, 1_000_000);
  assert.ok(result.stdout.endsWith(`x\n${json}`));
  assert.equal(result.data?.appId, APP_ID);
});

test('managed app: by default the CLI is the one pinned beside the installer', () => {
  const installer = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(CLI_PACKAGE_DIR, join(installer, 'managed-cli'));
  assert.equal(CLI_PACKAGE, '@microsoft/managed-apps-cli');
  assert.equal(cliBin(), join(installer, 'managed-cli', 'node_modules', '@microsoft', 'managed-apps-cli', 'dist', 'Bin.js'));
  assert.equal(createCli().bin, cliBin());
  assert.equal(COMMAND_TIMEOUT_MS, 5 * 60_000);
  assert.equal(DEPLOY_TIMEOUT_MS, 30 * 60_000);
});

test('managed app: the pinned CLI, its lock file and MIN_NODE agree', () => {
  const pinned = pinnedVersion();
  assert.match(pinned, /^\d+\.\d+\.\d+$/, 'The CLI is pinned to an exact version');
  const lock = JSON.parse(readFileSync(join(CLI_PACKAGE_DIR, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies[CLI_PACKAGE], pinned);
  const locked = lock.packages[`node_modules/${CLI_PACKAGE}`];
  assert.equal(locked.version, pinned);
  assert.equal(locked.engines.node, `>=${MIN_NODE}`);
  assert.equal(join(CLI_PACKAGE_DIR, 'node_modules', ...CLI_PACKAGE.split('/'), ...locked.bin.ms.split('/')), cliBin());
});

test('managed app: the pinned and installed CLI versions come from package.json files', () => {
  const dir = writeCliPackage(temp(), { pinned: '1.2.3', installed: '1.2.0' });
  assert.equal(pinnedVersion(dir), '1.2.3');
  assert.equal(installedVersion(dir), '1.2.0');
  assert.equal(installedVersion(writeCliPackage(temp(), { pinned: '1.2.3', installed: null })), undefined);
  const empty = temp();
  assert.equal(installedVersion(empty), undefined);
  assert.throws(() => pinnedVersion(empty), { code: 'ENOENT' });
  writeFiles(empty, { 'node_modules/@microsoft/managed-apps-cli/package.json': '{ not json' });
  assert.equal(installedVersion(empty), undefined);
});

test("managed app: nodeOk compares a Node.js version with the CLI's minimum", () => {
  assert.equal(MIN_NODE, '24.11.0');
  /** @type {[string, boolean][]} */
  const cases = [
    ['v24.11.0', true],
    ['24.11.0', true],
    ['v24.11.1', true],
    ['v24.12.0', true],
    ['v25.0.0', true],
    ['v100.0.0', true],
    ['v24.11', true],
    ['v24.10.99', false],
    ['v23.99.99', false],
    ['v22.20.0', false],
    ['v2.11.0', false],
    ['v24', false],
  ];
  for (const [version, ok] of cases) assert.equal(nodeOk(version), ok, version);
  assert.equal(nodeOk('v20.12.0', '20.12.0'), true);
  assert.equal(nodeOk('v20.11.9', 'v20.12.0'), false);
});

test('managed app: parseJson takes the JSON object out of noisy output', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('  \r\n{"a":1}\r\n  '), { a: 1 });
  // Pretty JSON after progress lines, with CRLF line ends, and a line after it.
  assert.deepEqual(parseJson('Packing app...\r\nUploading {50%}\r\n{\r\n  "success": true,\r\n  "nested": { "b": [1, 2] }\r\n}\r\nDone.'), {
    success: true,
    nested: { b: [1, 2] },
  });
  // JSON on one line among others: the last one.
  assert.deepEqual(parseJson('{"first":true}\nnoise\n{"last":true}\ntrailing'), { last: true });
  // JSON that runs on to the end without a closing brace on its own line.
  assert.deepEqual(parseJson('noise\n{"a":\n1}'), { a: 1 });
  for (const text of [undefined, '', '   ', '[1,2]', 'null', '"text"', '42', 'Error: {not json}', '{ broken', 'a\n{ "a": 1']) {
    assert.equal(parseJson(text), undefined, String(text));
  }
});

test('managed app: authStatus reads who the CLI is signed in as', async () => {
  const status = scripted(
    passed({ signedIn: true, activeAccount: { username: USER }, accounts: [{ username: USER }, { username: OTHER_USER }, { name: 'no username' }, null] }),
  );
  assert.deepEqual(await authStatus(status.run), { ok: true, signedIn: true, account: USER, accounts: [USER, OTHER_USER] });
  assert.deepEqual(status.calls, [{ args: ['auth', 'status'] }]);

  // Signed in needs an active account, and an active account alone isn't signed in.
  assert.deepEqual(await authStatus(scripted(passed({ signedIn: true })).run), { ok: true, signedIn: false, accounts: [] });
  assert.deepEqual(await authStatus(scripted(passed({ signedIn: false, activeAccount: { username: USER }, accounts: 'none' })).run), {
    ok: true,
    signedIn: false,
    account: USER,
    accounts: [],
  });
  assert.deepEqual(await authStatus(scripted({ ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '' }).run), {
    ok: true,
    signedIn: false,
    accounts: [],
  });
  // A CLI that's never been signed in exits 3.
  assert.deepEqual(await authStatus(scripted(failedWith('Not signed in.', { exitCode: 3 })).run), { ok: true, signedIn: false, accounts: [] });
});

test('managed app: a failed authStatus says who fixes it', async () => {
  const result = failedWith('getaddrinfo ENOTFOUND api.contoso.com', { exitCode: 5 });
  const status = mustFail(await authStatus(scripted(result).run));
  assert.deepEqual(status, { ok: false, problem: explain('auth', result), result });
  has(status.problem.what, "It couldn't reach Microsoft");
});

test('managed app: switchAccount and login run the auth commands, login on screen', async () => {
  const switching = scripted(passed());
  assert.deepEqual(await switchAccount(switching.run, OTHER_USER), { ok: true });
  assert.deepEqual(switching.calls, [{ args: ['auth', 'switch', '--account', OTHER_USER] }]);
  const refused = failedWith(`The CLI has no account ${OTHER_USER}.`);
  assert.deepEqual(await switchAccount(scripted(refused).run, OTHER_USER), { ok: false, problem: explain('auth', refused), result: refused });

  const signing = scripted(passed(), passed());
  assert.deepEqual(await login(signing.run, { account: USER }), { ok: true });
  assert.deepEqual(await login(signing.run, {}), { ok: true });
  assert.deepEqual(signing.calls, [
    { args: ['auth', 'login', '--account', USER], options: { onScreen: true } },
    { args: ['auth', 'login'], options: { onScreen: true } },
  ]);
  const blocked = failedWith('AADSTS53003: Access has been blocked by Conditional Access policies.');
  assert.deepEqual(await login(scripted(blocked).run, { account: USER }), { ok: false, problem: explain('login', blocked), result: blocked });
});

test('managed app: createApp makes the folder an app that deploys the build in ./dist', async () => {
  const appDir = temp();
  const making = scripted(passed({ appId: APP_ID, environmentId: PROD_ENV }));
  const made = await createApp(making.run, {
    appDir,
    displayName: PRODUCT.managedApp.name,
    description: PRODUCT.managedApp.description,
    environmentId: PROD_ENV,
  });
  assert.deepEqual(made, { ok: true, appId: APP_ID, environmentId: PROD_ENV });
  assert.deepEqual(making.calls, [
    {
      args: [
        'app', 'init', '--repo', 'none', '--display-name', PRODUCT.managedApp.name, '--description', PRODUCT.managedApp.description,
        '--build-type', 'none', '--build-path', './dist', '--environment-id', PROD_ENV,
      ],
      options: { cwd: appDir },
    },
  ]);
  assert.equal(BUILD_PATH, './dist');

  // Without a description or an environment, the CLI uses your developer environment.
  const bare = scripted(passed({ appId: APP_ID, environmentId: DEV_ENV }));
  assert.deepEqual(await createApp(bare.run, { appDir, displayName: 'Contoso app' }), { ok: true, appId: APP_ID, environmentId: DEV_ENV });
  assert.deepEqual(bare.calls[0].args, ['app', 'init', '--repo', 'none', '--display-name', 'Contoso app', '--build-type', 'none', '--build-path', './dist']);
});

test("managed app: createApp falls back to ms.config.json, then to the environment it asked for", async () => {
  const appDir = writeFiles(temp(), { [APP_CONFIG]: `\uFEFF${JSON.stringify({ appId: APP_ID, environmentId: DEV_ENV })}` });
  assert.deepEqual(await createApp(scripted(passed()).run, { appDir, displayName: APP_NAME }), { ok: true, appId: APP_ID, environmentId: DEV_ENV });
  // What the CLI printed beats the file.
  assert.deepEqual(await createApp(scripted(passed({ environmentId: PROD_ENV })).run, { appDir, displayName: APP_NAME }), {
    ok: true,
    appId: APP_ID,
    environmentId: PROD_ENV,
  });
  assert.deepEqual(await createApp(scripted(passed({ appId: APP_ID })).run, { appDir: temp(), displayName: APP_NAME, environmentId: PROD_ENV }), {
    ok: true,
    appId: APP_ID,
    environmentId: PROD_ENV,
  });
});

test("managed app: createApp says when the app was made but its ID wasn't saved", async () => {
  const appDir = temp();
  const lost = "The app was made, but its ID wasn't saved. Delete it at managedapps.cloud.microsoft, then run it again.";
  for (const data of [{}, { appId: 'not-a-guid', environmentId: DEV_ENV }, { appId: APP_ID }, { appId: APP_ID, environmentId: '' }]) {
    const result = passed(data);
    assert.deepEqual(await createApp(scripted(result).run, { appDir, displayName: APP_NAME }), { ok: false, problem: { who: 'you', what: lost }, result });
  }
  const refused = failedWith('ms.config.json already exists in this folder.');
  const no = mustFail(await createApp(scripted(refused).run, { appDir, displayName: APP_NAME }));
  assert.deepEqual(no, { ok: false, problem: explain('init', refused), result: refused });
  assert.equal(no.problem.what, `The app's folder already has an app. Run ${deployAgain()} to update that app.`);
});

test('managed app: deployApp deploys from the app folder and reads its link and warnings', async () => {
  const deploying = scripted(passed({ appPlayUri: PLAY_URL, warnings: ['Large bundle', { message: 'Slow upload' }, { code: 42 }, '', null, '  '] }));
  assert.deepEqual(await deployApp(deploying.run, { appDir: 'C:\\contoso\\app' }), {
    ok: true,
    playUrl: PLAY_URL,
    warnings: ['Large bundle', 'Slow upload', '{"code":42}'],
  });
  assert.deepEqual(deploying.calls, [{ args: ['app', 'deploy'], options: { cwd: 'C:\\contoso\\app', timeoutMs: DEPLOY_TIMEOUT_MS } }]);
  assert.deepEqual(await deployApp(scripted(passed({ appPlayUri: 42, warnings: 'not a list' })).run, { appDir: 'x' }), { ok: true, warnings: [] });
  const broken = failedWith('Upload failed: 503 Service Unavailable');
  assert.deepEqual(await deployApp(scripted(broken).run, { appDir: 'x' }), { ok: false, problem: explain('deploy', broken), result: broken });
});

test('managed app: shareApp shares for play, and reads what the CLI rejected', async () => {
  const sharing = scripted(
    passed({
      partialFailure: true,
      warnings: [{ input: NEW_GROUP, reason: 'Not found in the directory' }, { reason: 'Some entries were skipped' }, 'Plain warning'],
    }),
  );
  assert.deepEqual(await shareApp(sharing.run, { appDir: 'C:\\contoso\\app', principals: [GROUP, NEW_GROUP] }), {
    ok: true,
    partial: true,
    rejected: [NEW_GROUP],
    warnings: [`${NEW_GROUP}: Not found in the directory`, 'Some entries were skipped', 'Plain warning'],
  });
  assert.deepEqual(sharing.calls, [{ args: ['app', 'share', `${GROUP},${NEW_GROUP}`, '--access', 'play'], options: { cwd: 'C:\\contoso\\app' } }]);
  assert.deepEqual(await shareApp(scripted(passed()).run, { appDir: 'x', principals: [GROUP] }), { ok: true, partial: false, rejected: [], warnings: [] });
  // A warning with nothing to say isn't passed on as an empty line.
  assert.deepEqual(await shareApp(scripted(passed({ warnings: [{}, null, '  ', { input: GROUP }] })).run, { appDir: 'x', principals: [GROUP] }), {
    ok: true,
    partial: false,
    rejected: [GROUP],
    warnings: [GROUP],
  });
  const rejected = failedWith('The sharing request was rejected.');
  assert.deepEqual(await shareApp(scripted(rejected).run, { appDir: 'x', principals: [GROUP] }), {
    ok: false,
    problem: explain('share', rejected),
    result: rejected,
  });
});

test('managed app: verifyShare finds the object IDs the app is not shared with yet', async () => {
  const listing = scripted(passed({ results: [{ value: [{ principalObjectId: GROUP.toUpperCase() }, { principalObjectId: 42 }] }, { value: 'none' }, null] }));
  assert.deepEqual(await verifyShare(listing.run, { appDir: 'C:\\contoso\\app', ids: [GROUP, NEW_GROUP, 'viewers@contoso.com'] }), {
    ok: true,
    missing: [NEW_GROUP],
  });
  assert.deepEqual(listing.calls, [{ args: ['app', 'share', 'list', '--access', 'play'], options: { cwd: 'C:\\contoso\\app' } }]);
  // With no object ID to check, it doesn't ask.
  const none = scripted();
  assert.deepEqual(await verifyShare(none.run, { appDir: 'x', ids: ['viewers@contoso.com'] }), { ok: true, missing: [] });
  assert.equal(none.calls.length, 0);
  assert.deepEqual(await verifyShare(scripted(passed()).run, { appDir: 'x', ids: [GROUP] }), { ok: true, missing: [GROUP] });
  const broken = failedWith('The service is temporarily unavailable.');
  assert.deepEqual(await verifyShare(scripted(broken).run, { appDir: 'x', ids: [GROUP] }), { ok: false, problem: explain('share', broken), result: broken });
});

test("managed app: playUrl asks for the app's link without opening a browser", async () => {
  const asking = scripted(passed({ url: PLAY_URL }));
  assert.deepEqual(await playUrl(asking.run, { appDir: 'C:\\contoso\\app' }), { ok: true, url: PLAY_URL });
  assert.deepEqual(asking.calls, [{ args: ['app', 'play', '--no-browser'], options: { cwd: 'C:\\contoso\\app' } }]);
  const noUrl = passed({ url: 42 });
  assert.deepEqual(await playUrl(scripted(noUrl).run, { appDir: 'x' }), { ok: false, problem: explain('play', noUrl), result: noUrl });
});

test("managed app: deleteApp deletes the app by ID, and one that's gone is fine", async () => {
  const deleting = scripted(passed({ existed: true }), passed({ existed: false }), passed());
  assert.deepEqual(await deleteApp(deleting.run, { appId: APP_ID, environmentId: DEV_ENV, cwd: 'C:\\contoso\\app' }), { ok: true, existed: true });
  assert.deepEqual(await deleteApp(deleting.run, { appId: APP_ID }), { ok: true, existed: false });
  assert.deepEqual(await deleteApp(deleting.run, { appId: APP_ID }), { ok: true, existed: true });
  assert.deepEqual(deleting.calls, [
    { args: ['app', 'delete', '--force', '--app', APP_ID, '--environment-id', DEV_ENV], options: { cwd: 'C:\\contoso\\app' } },
    { args: ['app', 'delete', '--force', '--app', APP_ID], options: { cwd: undefined } },
    { args: ['app', 'delete', '--force', '--app', APP_ID], options: { cwd: undefined } },
  ]);
  // Exit 6 is not found.
  assert.deepEqual(await deleteApp(scripted(failedWith('App not found.', { exitCode: 6 })).run, { appId: APP_ID }), { ok: true, existed: false });
  const broken = failedWith('Forbidden');
  assert.deepEqual(await deleteApp(scripted(broken).run, { appId: APP_ID }), { ok: false, problem: explain('delete', broken), result: broken });
});

test("managed app: readAppConfig reads the app folder's ms.config.json", () => {
  const config = { appId: APP_ID, environmentId: DEV_ENV, appDisplayName: APP_NAME, buildPath: BUILD_PATH };
  const dir = writeFiles(temp(), { [APP_CONFIG]: `\uFEFF${JSON.stringify(config)}` });
  assert.deepEqual(readAppConfig(dir), { appId: APP_ID, environmentId: DEV_ENV, displayName: APP_NAME, config });
  // An app ID makes it an app, without a usable environment: the CLI won't make another app there.
  for (const other of [{ environmentId: '', appDisplayName: 7 }, {}, { environmentId: 7 }]) {
    const written = { appId: APP_ID, ...other };
    assert.deepEqual(readAppConfig(writeFiles(temp(), { [APP_CONFIG]: JSON.stringify(written) })), { appId: APP_ID, config: written });
  }
  for (const text of [
    JSON.stringify({ appId: '', environmentId: DEV_ENV }),
    JSON.stringify({ appId: 42, environmentId: DEV_ENV }),
    '{ not json',
    'null',
  ]) {
    assert.equal(readAppConfig(writeFiles(temp(), { [APP_CONFIG]: text })), undefined, text);
  }
  assert.equal(readAppConfig(temp()), undefined);
  assert.equal(readAppConfig(join(temp(), 'missing')), undefined);
});

test('managed app: isGuid and stripBom', () => {
  assert.equal(isGuid(APP_ID), true);
  assert.equal(isGuid(APP_ID.toUpperCase()), true);
  for (const value of [`{${APP_ID}}`, `${APP_ID} `, APP_ID.slice(1), 'not-a-guid', 42, undefined, null]) assert.equal(isGuid(value), false, String(value));
  assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
  assert.equal(stripBom(''), '');
  assert.equal(stripBom('\uFEFF\uFEFFx'), '\uFEFFx');
  assert.equal(APP_CONFIG, 'ms.config.json');
});

test('managed app: notReady finds the tenant settings a failure says are turned off', () => {
  /** @type {[Failure, string[]][]} */
  const cases = [
    [{ error: "You don't have permission to create an app in this environment." }, ['createApps']],
    [{ error: 'Ask your admin to grant you the required permission.' }, ['createApps']],
    [{ error: 'The user does not hold the required privilege.' }, ['createApps']],
    [{ data: { errorCode: 'EnvironmentPermissionDenied' } }, ['createApps']],
    [{ errorData: { errorCode: 'InsufficientPrivilege' } }, ['createApps']],
    [{ error: 'Deploying external artifacts is turned off for this environment.' }, ['externalArtifacts']],
    [{ errorData: { serverErrorCode: 'AllowExternalArtifactDeployment' } }, ['externalArtifacts']],
    [{ errorData: { serverErrorCode: 'CodeAppOperationNotAllowedInEnvironment' } }, ['externalArtifacts']],
    [{ errorData: { serverMessage: 'ExternalArtifactDeploymentDisabled: ask your admin.' } }, ['externalArtifacts']],
    [{ error: 'Request failed.', errorData: { serverErrorCode: 'InsufficientPrivilege', serverMessage: 'External artifacts are off.' } }, ['createApps', 'externalArtifacts']],
    [{ error: 'Upload failed: 500 Internal Server Error' }, []],
    [{ exitCode: 1 }, []],
    [{ data: { errorCode: 42 }, errorData: 'InsufficientPrivilege, as text' }, []],
    [{}, []],
  ];
  for (const [result, off] of cases) assert.deepEqual(notReady(result), off, JSON.stringify(result));
});

test("managed app: a tenant that isn't ready is found in the CLI's JSON error details", async () => {
  const json = {
    success: false,
    errorMessage: 'Deployment failed.',
    errorData: { serverErrorCode: 'ExternalArtifactDeploymentDisabled', serverMessage: '  Code apps are turned off here.  ', stderrTail: 'trace line\n' },
  };
  const result = await cliSays({ stdout: `Uploading...\n${JSON.stringify(json)}`, code: 1 });
  assert.deepEqual(notReady(result), ['externalArtifacts']);
  assert.deepEqual(explain('deploy', result), {
    ...ADMIN_STEPS.externalArtifacts,
    message: 'Deployment failed.',
    details: 'Code apps are turned off here.\ntrace line',
  });
});

test('managed app: Conditional Access is for an Entra admin, whatever else the failure says', () => {
  const error = 'AADSTS53003: Access has been blocked by Conditional Access policies. No permission to create an app.';
  const problem = explain('auth', { exitCode: 3, timedOut: true, error });
  assert.equal(problem.who, 'Entra admin');
  has(problem.what, CLI_APP_ID);
  assert.equal(problem.link, undefined);
  assert.equal(problem.message, error);
});

test('managed app: a timeout or an expired sign-in says to run deploy-app again', () => {
  assert.deepEqual(explain('deploy', { timedOut: true, exitCode: 3, error: "It didn't finish within 30 minutes, so it was stopped." }), {
    who: 'you',
    what: `It took too long, so it was stopped. Run ${deployAgain()}: it picks up where it stopped.`,
    message: "It didn't finish within 30 minutes, so it was stopped.",
  });
  const signIn = `Your sign-in didn't work or has expired. Run ${deployAgain()}, and sign in when it asks.`;
  for (const result of [{ exitCode: 3 }, { error: 'Your sign-in session has expired.' }, { error: 'Not signed in.' }, { error: 'Run ms auth login first.' }]) {
    assert.equal(explain('deploy', result).what, signIn, JSON.stringify(result));
  }
  // Exit 3 comes before the admin settings.
  assert.equal(explain('init', { exitCode: 3, error: 'No permission to create an app.' }).what, signIn);
});

test('managed app: settings an admin turned off are explained with the admin step', () => {
  assert.deepEqual(explain('init', { error: "You don't have permission to create an app here." }), {
    ...ADMIN_STEPS.createApps,
    message: "You don't have permission to create an app here.",
  });
  assert.deepEqual(explain('deploy', { errorData: { serverErrorCode: 'CodeAppOperationNotAllowedInEnvironment' } }), { ...ADMIN_STEPS.externalArtifacts });
  // With both off, app creation comes first.
  assert.equal(explain('init', { error: 'InsufficientPrivilege, and external artifacts are off.' }).what, ADMIN_STEPS.createApps.what);
  assert.equal(ADMIN_STEPS.createApps.who, 'Power Platform admin');
  assert.equal(ADMIN_STEPS.externalArtifacts.who, 'Power Platform admin');
  assert.equal(ADMIN_STEPS.licences.who, 'Microsoft 365 admin');
  assert.equal(ADMIN_STEPS.createApps.link, LINKS.cliSetting);
  assert.equal(ADMIN_STEPS.externalArtifacts.link, LINKS.cliSetting);
  assert.equal(ADMIN_STEPS.licences.link, LINKS.licensing);
});

test('managed app: environment problems point to deploy-app --environment-id', () => {
  for (const error of [
    'Failed to resolve a developer environment for this user.',
    'Unable to resolve a developer environment.',
    'Could not provision a developer environment.',
  ]) {
    const problem = explain('init', { error });
    assert.equal(problem.who, 'you');
    has(problem.what, "Your developer environment couldn't be found or made.");
    has(problem.what, deployAgain());
    has(problem.what, deployElsewhere());
  }
  /** @type {Failure[]} */
  const missing = [
    { error: `Environment ${PROD_ENV} was not found.` },
    { error: 'The environment contoso-prod not found' },
    { error: 'Could not reach environment contoso-prod.' },
    { error: 'Request failed.', data: { errorCode: 'EnvironmentNotFound' } },
    { error: 'Request failed.', errorData: { errorCode: 'EnvironmentUnreachable' } },
    { error: 'Request failed.', errorData: { serverErrorCode: 'EnvironmentNotFound' } },
  ];
  for (const result of missing) {
    const problem = explain('init', result);
    has(problem.what, "That environment wasn't found, or didn't answer.");
    has(problem.what, deployElsewhere());
    // Repair or change has no environment question, so it isn't offered as a way to pick one.
    lacks(problem.what, 'Repair or change');
  }
});

test("managed app: an app folder that already has an app isn't a name that's taken", () => {
  assert.deepEqual(explain('init', { error: 'ms.config.json already exists in this folder.' }), {
    who: 'you',
    what: `The app's folder already has an app. Run ${deployAgain()} to update that app.`,
    message: 'ms.config.json already exists in this folder.',
  });
  assert.deepEqual(explain('init', { error: `An app named ${APP_NAME} already exists.` }), {
    who: 'you',
    what: 'An app with that name already exists in the environment. Rename or delete the other one at managedapps.cloud.microsoft, then run it again.',
    link: LINKS.portal,
    message: `An app named ${APP_NAME} already exists.`,
  });
});

test('managed app: a sharing policy is for an admin, and a rejected share is for you', () => {
  const policy = explain('share', { error: 'Sharing is blocked by an environment or tenant policy.' });
  assert.equal(policy.who, 'Power Platform admin');
  assert.equal(policy.link, LINKS.share);
  has(policy.what, deployElsewhere());
  for (const error of ['The sharing request was rejected.', 'The sharing limit of 100 has been reached.']) {
    assert.deepEqual(explain('share', { error }), {
      who: 'you',
      what: 'Check the viewer group is in your organisation, then share the app with it at managedapps.cloud.microsoft.',
      link: LINKS.share,
      message: error,
    });
  }
});

test('managed app: network trouble and a busy service say to try again', () => {
  const network = `It couldn't reach Microsoft. Check your connection or proxy, then run ${deployAgain()}.`;
  /** @type {Failure[]} */
  const offline = [
    { exitCode: 5 },
    { error: 'getaddrinfo ENOTFOUND api.contoso.com' },
    { error: 'read ECONNRESET' },
    { error: 'connect ETIMEDOUT 10.0.0.1:443' },
    { error: 'getaddrinfo EAI_AGAIN api.contoso.com' },
    { error: 'A network error occurred.' },
    { error: 'Could not reach the service.' },
  ];
  for (const result of offline) assert.equal(explain('deploy', result).what, network, JSON.stringify(result));
  const busy = `The service is busy. Wait a few minutes, then run ${deployAgain()}.`;
  for (const error of ['The service is temporarily unavailable.', 'Too many requests', 'HTTP 429', 'Request failed with status 503']) {
    assert.equal(explain('deploy', { error }).what, busy, error);
  }
});

test("managed app: an error it doesn't recognise says to run it again, then open an issue", () => {
  const problem = explain('deploy', {
    exitCode: 1,
    error: '  Something odd happened.\n  ',
    errorData: { serverMessage: '  The server said no.  ', stderrTail: '\n', stdoutTail: ' last line ', other: 'not shown' },
  });
  assert.deepEqual(problem, {
    who: 'you',
    what: `Run ${deployAgain()}. If it fails the same way, open an issue with the message above.`,
    link: LINKS.issues,
    message: 'Something odd happened.',
    details: 'The server said no.\nlast line',
  });
  assert.equal(LINKS.issues, `https://github.com/${PRODUCT.repo}/issues`);
  // No message, and errorData that isn't an object: neither is shown.
  const bare = explain('deploy', { exitCode: 1, error: '   ', errorData: 'text' });
  assert.equal('message' in bare, false);
  assert.equal('details' in bare, false);
});

test('managed app: deploy-app is how to run the app step again, as the installer was started', () => {
  assert.equal(deployAgain(), commandLine('deploy-app'));
  assert.equal(deployElsewhere(), commandLine('deploy-app --environment-id <environment ID>'));
  has(deployAgain(), 'deploy-app');
});

test("managed app: whyNot says why the app can't be deployed from here, the build first", () => {
  const distDir = writeFiles(temp());
  const cliDir = writeCliPackage(temp());
  const noCli = writeCliPackage(temp(), { installed: null });
  const then = `Then run: ${deployAgain()}`;
  assert.equal(whyNot({ distDir, cliDir, nodeVersion: NODE_OK }), undefined);
  assert.equal(whyNot({ distDir, cliDir, nodeVersion: 'v26.1.0' }), undefined);

  // No build: no folder, a folder that isn't there, or one without index.html. It's said before the rest.
  for (const dir of [undefined, join(temp(), 'missing'), writeFiles(temp(), { 'assets/app.js': 'x' })]) {
    const blocked = whyNot({ distDir: dir, cliDir: noCli, nodeVersion: 'v20.0.0' });
    assert.ok(blocked, String(dir));
    assert.equal(blocked.why, 'This copy of the installer has no build of the app.');
    has(blocked.steps[0], `Use ${PRODUCT.exe}, which carries it.`);
    has(blocked.steps[0], 'npm ci');
    has(blocked.steps[0], 'npm run build');
    assert.equal(blocked.steps[1], then);
    assert.equal(blocked.steps.length, 2);
  }

  // Node.js too old, said before the CLI.
  assert.deepEqual(whyNot({ distDir, cliDir: noCli, nodeVersion: 'v24.10.9' }), {
    why: `The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is 24.10.9.`,
    steps: [`Use ${PRODUCT.exe}, which carries a new enough Node.js, or install it from ${LINKS.node}.`, then],
  });

  const install = 'npm ci --ignore-scripts --omit=dev --prefix installer/managed-cli';
  const missing = whyNot({ distDir, cliDir: noCli, nodeVersion: NODE_OK });
  assert.ok(missing);
  assert.equal(missing.why, "The managed apps CLI isn't installed here.");
  has(missing.steps[0], PRODUCT.exe);
  has(missing.steps[0], install);
  assert.equal(missing.steps[1], then);
  const other = whyNot({ distDir, cliDir: writeCliPackage(temp(), { installed: '0.0.1' }), nodeVersion: NODE_OK });
  assert.ok(other);
  assert.equal(other.why, `The managed apps CLI here is 0.0.1, and the installer needs ${PINNED}.`);
  has(other.steps[0], install);
});

test('managed app: removing the app needs no build, but still needs the CLI and its Node.js', () => {
  const cliDir = writeCliPackage(temp());
  assert.equal(whyNot({ distDir: undefined, cliDir, nodeVersion: NODE_OK, needBuild: false }), undefined);
  assert.equal(
    whyNot({ distDir: undefined, cliDir, nodeVersion: 'v22.12.0', needBuild: false })?.why,
    `The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is 22.12.0.`,
  );
  assert.equal(
    whyNot({ distDir: undefined, cliDir: writeCliPackage(temp(), { installed: null }), nodeVersion: NODE_OK, needBuild: false })?.why,
    "The managed apps CLI isn't installed here.",
  );
});

test("managed app: whyNot needs the CLI's Bin.js, and a copy without the CLI's pin is a reason, not a crash", () => {
  const distDir = writeFiles(temp());
  assert.equal(whyNot({ distDir, cliDir: temp(), nodeVersion: NODE_OK })?.why, "The managed apps CLI isn't installed here.");
  const noBin = writeCliPackage(temp());
  rmSync(cliBin(noBin));
  assert.equal(whyNot({ distDir, cliDir: noBin, nodeVersion: NODE_OK })?.why, "The managed apps CLI isn't installed here.");
});

test("managed app: buildHash is a build's paths and contents, wherever the build is", () => {
  const dir = writeFiles(temp());
  const known = createHash('sha256').update('assets/app.js\0x\0index.html\0<html></html>\0').digest('hex');
  assert.equal(buildHash(dir), known);
  assert.equal(buildHash(dir), known, 'stable');
  assert.equal(buildHash(writeFiles(temp())), known, 'the same build in another folder');

  // An empty folder isn't part of the build.
  mkdirSync(join(dir, 'empty'));
  assert.equal(buildHash(dir), known);

  const hashes = new Set([known]);
  for (const files of /** @type {Record<string, string>[]} */ ([
    { 'index.html': '<html></html>', 'assets/app.js': 'y' },
    { ...BUILD, 'assets/app.css': '' },
    { 'index.html': '<html></html>', 'assets/main.js': 'x' },
    { 'index.html': '<html></html>', 'app.js': 'x' },
    { 'index.html': '<html></html>' },
  ])) {
    const hash = buildHash(writeFiles(temp(), files));
    assert.equal(hashes.has(hash), false, JSON.stringify(files));
    hashes.add(hash);
  }

  // A file that changes in place changes it.
  writeFileSync(join(dir, 'index.html'), '<html><body></body></html>');
  assert.notEqual(buildHash(dir), known);
});

test("managed app: dataHint says viewers pick the data from the SharePoint folder, and need access to it", () => {
  assert.equal(
    dataHint(emptyConfig()),
    "In the app, viewers choose Change data and pick the CSV files from the SharePoint folder, so they need read access to it. The installer doesn't give that.",
  );
  const config = emptyConfig();
  config.sharePoint = { ...SHAREPOINT };
  assert.equal(
    dataHint(config),
    `In the app, viewers choose Change data and pick the CSV files from the SharePoint folder ${FOLDER_URL}, so they need read access to it. The installer doesn't give that.`,
  );
});

test("managed app: the app's folder is beside the PAX refresh's, and its names come from product.js", () => {
  const pc = fakePaxHost();
  temps.push(pc.base);
  const { ctx } = fakeCtx();
  ctx.paxHost = pc.host;
  assert.equal(appDirOf(ctx), join(pc.base, PRODUCT.home, PRODUCT.managedApp.folder));
  assert.equal(dirname(appDirOf(ctx)), dirname(pc.host.root));
  assert.equal(APP_NAME, PRODUCT.managedApp.name);
  assert.equal(THE_APP, `the ${PRODUCT.managedApp.name} app`);
  assert.deepEqual(Object.keys(NOT_READY_NAMES).sort(), ['createApps', 'externalArtifacts']);
  for (const key of /** @type {const} */ (['createApps', 'externalArtifacts'])) assert.ok(ADMIN_STEPS[key], key);
});

test('managed app: what the app step says calls it "the app", never "App Edition"', () => {
  for (const name of ['cli.js', 'errors.js', 'flow.js', 'steps.js']) {
    const text = readFileSync(fileURLToPath(new URL(`../src/managed-app/${name}`, import.meta.url)), 'utf8');
    assert.equal(/App Edition/i.test(text), false, name);
  }
});

test('managed app: the first run makes the app, deploys the build and shares it with the viewer group', async () => {
  const s = setup();
  const result = await deployTheApp(s.ctx, s.deps);
  assert.deepEqual(result, { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, NEW_APP);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
  const hash = buildHash(s.distDir);
  // Saved once the app exists, once it's deployed, and once it's shared.
  assert.deepEqual(s.saved, [
    { appId: APP_ID, environmentId: DEV_ENV },
    { appId: APP_ID, environmentId: DEV_ENV, buildHash: hash, deployedAt: DEPLOYED_AT, url: PLAY_URL },
    deployedRecord(s.distDir),
  ]);

  const init = s.ms.call('app init');
  assert.deepEqual(init.args, [
    'app', 'init', '--repo', 'none', '--display-name', PRODUCT.managedApp.name, '--description', PRODUCT.managedApp.description,
    '--build-type', 'none', '--build-path', BUILD_PATH,
  ]);
  assert.deepEqual(init.options, { cwd: s.appDir });
  assert.deepEqual(s.ms.call('app deploy').options, { cwd: s.appDir, timeoutMs: DEPLOY_TIMEOUT_MS });
  assert.deepEqual(s.ms.call('app share').args, ['app', 'share', GROUP, '--access', 'play']);
  assert.deepEqual(s.ms.call('app share list').options, { cwd: s.appDir });

  // The app's folder holds its settings and a copy of the build, which is what was deployed.
  assert.equal(readAppConfig(s.appDir)?.appId, APP_ID);
  assert.equal(buildHash(join(s.appDir, 'dist')), hash);
  assert.equal(s.ms.state.deployed, hash);
  assert.deepEqual(s.ms.state.shared, [GROUP]);

  const said = s.said();
  has(said, `  ✓ Made the app ${PRODUCT.managedApp.name} in environment ${DEV_ENV}\n`);
  has(said, `    Deploying ${THE_APP}. It takes a few minutes.\n`);
  has(said, `  ✓ The ${PRODUCT.managedApp.name} app is live: ${PLAY_URL}\n`);
  has(said, `  ✓ Shared the app with ${GROUP_NAME}\n`);
  // The first deploy says what viewers need.
  has(said, `    Each person who opens it needs Power Apps Premium or Copilot Credits: ${LINKS.licensing}\n`);
  has(said, `    ${dataHint(s.config)}\n`);
  has(said, FOLDER_URL);
  lacks(said, '  ! ');
  lacks(said, '  ✗ ');
  assert.deepEqual(s.asked, []);
});

test('managed app: a build already deployed and shared is up to date, and the CLI is not run', async () => {
  const s = await deployedApp();
  const record = s.config.managedApp;
  assert.ok(record);
  record.missing = ['createApps'];
  record.skipped = { why: 'The last attempt to deploy it failed.', steps: [] };
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'up-to-date', url: PLAY_URL });
  assert.deepEqual(s.events, ['save']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
  assert.equal(s.said(), `  ✓ The ${APP_NAME} app is up to date: ${PLAY_URL}\n`);

  delete record.url;
  s.reset();
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'up-to-date' });
  assert.equal(s.said(), `  ✓ The ${APP_NAME} app is up to date\n`);
});

test('managed app: a new viewer group gets the app shared with it, without deploying it again', async () => {
  const s = await deployedApp();
  s.config.access = { groupId: NEW_GROUP, groupName: 'Contoso analysts' };
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app share', 'app share list', 'save']);
  assert.deepEqual(s.ms.call('app share').args, ['app', 'share', NEW_GROUP, '--access', 'play']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir, { sharedWith: [NEW_GROUP] }));
  const said = s.said();
  has(said, '  ✓ Shared the app with Contoso analysts\n');
  // The group it had before keeps the app: the installer says so, and where to stop that.
  has(said, `  ! The app is still shared with the group it had before (${GROUP}). If its members shouldn't open it, stop sharing it at ${LINKS.portal}.\n`);
  lacks(said, 'Deploying');
  lacks(said, 'Power Apps Premium');
});

test('managed app: force deploys the same build again, to the same app', async () => {
  const s = await deployedApp();
  s.ctx.now = () => new Date('2026-06-02T08:30:00Z');
  assert.deepEqual(await deployTheApp(s.ctx, s.deps, { force: true }), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app deploy', 'save', 'app share', 'app share list', 'save']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir, { deployedAt: '2026-06-02T08:30:00.000Z' }));
  const said = s.said();
  has(said, `  ✓ The ${APP_NAME} app is live: ${PLAY_URL}\n`);
  lacks(said, 'Made the app');
  lacks(said, 'Power Apps Premium');
});

test("managed app: a changed build is deployed again, replacing the copy in the app's folder", async () => {
  const s = await deployedApp();
  writeFiles(s.appDir, { 'dist/stale.js': 'left over' });
  writeFiles(s.distDir, { 'assets/app.js': 'y' });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app deploy', 'save', 'app share', 'app share list', 'save']);
  const hash = buildHash(s.distDir);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
  assert.equal(s.config.managedApp?.buildHash, hash);
  assert.equal(buildHash(join(s.appDir, 'dist')), hash);
  assert.equal(existsSync(join(s.appDir, 'dist', 'stale.js')), false);
  assert.equal(s.ms.state.deployed, hash);
  assert.equal(readAppConfig(s.appDir)?.appId, APP_ID);
});

test('managed app: --environment-id is for a new app, so an app already deployed stays where it is', async () => {
  const s = await deployedApp();
  const warning = `  ! The app is already in environment ${DEV_ENV}. --environment-id is for a new app only, so it stays there.\n`;
  assert.equal((await deployTheApp(s.ctx, s.deps, { environmentId: PROD_ENV })).state, 'up-to-date');
  has(s.said(), warning);
  assert.deepEqual(s.events, ['save']);
  assert.equal(s.config.managedApp?.environmentId, DEV_ENV);

  // The same environment in other case isn't another one.
  s.reset();
  await deployTheApp(s.ctx, s.deps, { environmentId: DEV_ENV.toUpperCase() });
  lacks(s.said(), '  ! ');

  // --environment-id can reach the step on ctx as well, and is checked the same way.
  s.reset();
  s.ctx.environmentId = OTHER_ENV;
  await deployTheApp(s.ctx, s.deps);
  has(s.said(), warning);
});

test('managed app: a new app goes to --environment-id, passed in or on ctx, then the one recorded for it', async () => {
  /** @type {{ o: Parameters<typeof setup>[0], opts: { environmentId?: string }, env: string }[]} */
  const cases = [
    { o: { environmentId: OTHER_ENV, record: { environmentId: DEV_ENV } }, opts: { environmentId: PROD_ENV }, env: PROD_ENV },
    { o: { environmentId: OTHER_ENV, record: { environmentId: DEV_ENV } }, opts: {}, env: OTHER_ENV },
    { o: { record: { environmentId: PROD_ENV } }, opts: {}, env: PROD_ENV },
  ];
  for (const { o, opts, env } of cases) {
    const s = setup(o);
    assert.deepEqual(await deployTheApp(s.ctx, s.deps, opts), { ok: true, state: 'deployed', url: PLAY_URL });
    assert.deepEqual(s.ms.call('app init').args.slice(-2), ['--environment-id', env]);
    assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir, { environmentId: env }));
    has(s.said(), `  ✓ Made the app ${APP_NAME} in environment ${env}\n`);
    lacks(s.said(), '  ! ');
  }
});

test("managed app: the app in this PC's folder is the one deployed, even when the record names another", async () => {
  const old = {
    appId: OTHER_APP_ID,
    environmentId: OTHER_ENV,
    buildHash: 'old',
    deployedAt: '2026-05-01T00:00:00.000Z',
    url: 'https://apps.contoso.com/play/old',
    sharedWith: [GROUP],
  };
  const s = setup({ record: old, appConfig: { appId: APP_ID, environmentId: PROD_ENV } });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'save', 'app deploy', 'save', 'app share', 'app share list', 'save']);
  // What the record said about the other app is forgotten when it switches.
  assert.deepEqual(s.saved[0], { appId: APP_ID, environmentId: PROD_ENV });
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir, { environmentId: PROD_ENV }));
  const said = s.said();
  has(said, `  ! This PC's app settings are for app ${APP_ID}, not ${OTHER_APP_ID} as recorded, so ${APP_ID} is deployed.\n`);
  lacks(said, 'Made the app');
  has(said, 'Power Apps Premium');
});

test('managed app: an app folder from an earlier install is used when there is no record of it', async () => {
  const s = setup({ appConfig: { appId: APP_ID, environmentId: DEV_ENV } });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'save', 'app deploy', 'save', 'app share', 'app share list', 'save']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
  lacks(s.said(), '  ! ');
});

test("managed app: an app folder whose ms.config.json names no environment is still that app, and isn't made again", async () => {
  const s = setup({ appConfig: { appId: APP_ID }, record: { appId: APP_ID, environmentId: OTHER_ENV }, environmentId: PROD_ENV });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.equal(s.ms.calls.some((c) => c.key === 'app init'), false);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir, { environmentId: OTHER_ENV }));
  // The record says where that app is, so --environment-id is still said to be for a new app.
  has(s.said(), `  ! The app is already in environment ${OTHER_ENV}. --environment-id is for a new app only, so it stays there.\n`);
  lacks(s.said(), 'undefined');

  const other = setup({ appConfig: { appId: APP_ID }, record: { appId: OTHER_APP_ID, environmentId: OTHER_ENV }, environmentId: PROD_ENV });
  assert.deepEqual(await deployTheApp(other.ctx, other.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.equal(other.ms.calls.some((c) => c.key === 'app init'), false);
  // The environment recorded was the other app's, so it isn't kept, and nothing is said about where this one is.
  const expected = deployedRecord(other.distDir);
  delete expected.environmentId;
  assert.deepEqual(other.config.managedApp, expected);
  lacks(other.said(), 'is already in environment');
  lacks(other.said(), 'undefined');
});

test("managed app: without the app's folder on this PC, a new app is made and the old one is named for deleting", async () => {
  const s = setup({ record: deployedRecord(writeFiles(temp()), { appId: OTHER_APP_ID, environmentId: OTHER_ENV }) });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, NEW_APP);
  assert.deepEqual(s.ms.call('app init').args.slice(-2), ['--environment-id', OTHER_ENV]);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir, { environmentId: OTHER_ENV }));
  const said = s.said();
  has(said, `  ! This PC doesn't have the settings for the app deployed before (${OTHER_APP_ID}), so a new app is made. Delete the old one at ${LINKS.portal}.\n`);
  has(said, 'Power Apps Premium');
});

test("managed app: a tenant that won't let the CLI make apps finishes at the report, naming the setting", async () => {
  const s = setup();
  s.ms.queue('app init', failedWith("You don't have permission to create an app in this environment."));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'not-ready' });
  assert.deepEqual(s.events, ['auth status', 'app init', 'save']);
  assert.deepEqual(s.config.managedApp, { missing: ['createApps'] });
  const said = s.said();
  has(said, `  ! The ${APP_NAME} app can't be deployed until a Power Platform admin turns on ${NOT_READY_NAMES.createApps}. The report works without it.\n`);
  has(said, `    The summary has a message to send them. Then run: ${deployAgain()}\n`);
  lacks(said, '  ✗ ');
  lacks(said, 'Power Apps Premium');
});

test('managed app: external artifacts turned off is found at deploy, and a later run deploys once it is on', async () => {
  const s = setup();
  s.ms.queue('app deploy', failedWith('Deployment failed.', { errorData: { serverErrorCode: 'CodeAppOperationNotAllowedInEnvironment' } }));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'not-ready' });
  assert.deepEqual(s.events, ['auth status', 'app init', 'save', 'app deploy', 'save']);
  assert.deepEqual(s.config.managedApp, { appId: APP_ID, environmentId: DEV_ENV, missing: ['externalArtifacts'] });
  has(s.said(), `turns on ${NOT_READY_NAMES.externalArtifacts}. The report works without it.\n`);

  // Once an admin turns it on, the next run deploys the app it made, and forgets what was missing.
  s.reset();
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app deploy', 'save', 'app share', 'app share list', 'save']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
  has(s.said(), 'Power Apps Premium');
});

test('managed app: with both settings off, both are named', async () => {
  const s = setup();
  s.ms.queue(
    'app init',
    failedWith('Request failed.', { errorData: { serverErrorCode: 'InsufficientPrivilege', serverMessage: 'External artifacts are turned off.' } }),
  );
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'not-ready' });
  assert.deepEqual(s.config.managedApp?.missing, ['createApps', 'externalArtifacts']);
  has(s.said(), `turns on ${NOT_READY_NAMES.createApps} and ${NOT_READY_NAMES.externalArtifacts}. The report works without it.`);
});

test('managed app: a tenant turned off after a deploy keeps the live link, and the new build waits for the next run', async () => {
  const s = await deployedApp();
  const record = s.config.managedApp;
  assert.ok(record);
  const was = structuredClone(record);
  record.skipped = { why: 'An earlier reason.', steps: [] };
  writeFiles(s.distDir, { 'index.html': '<html>v2</html>' });
  s.ms.queue('app deploy', failedWith('External artifacts are turned off for this environment.'));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'not-ready', url: PLAY_URL });
  // The record still says which build is live.
  assert.deepEqual(s.config.managedApp, { ...was, missing: ['externalArtifacts'] });

  s.reset();
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
});

test('managed app: a deploy that fails says so, keeps what to do in the record, and fails the step', async () => {
  const s = setup({ record: { missing: ['createApps'] } });
  s.ms.queue(
    'app deploy',
    failedWith('Upload failed: 500 Internal Server Error\nRequest ID: 1234', { errorData: { serverMessage: 'Something broke on our side.' } }),
  );
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  assert.deepEqual(s.events, ['auth status', 'app init', 'save', 'app deploy', 'save']);
  const what = `Run ${deployAgain()}. If it fails the same way, open an issue with the message above.`;
  // Only the first line of what the CLI said is kept, and what was missing before is forgotten.
  assert.deepEqual(s.config.managedApp, {
    appId: APP_ID,
    environmentId: DEV_ENV,
    skipped: { why: 'The last attempt to deploy it failed: Upload failed: 500 Internal Server Error', steps: [what, `More: ${LINKS.issues}`] },
  });
  const said = s.said();
  has(said, `  ✗ The ${APP_NAME} app: Upload failed: 500 Internal Server Error\nRequest ID: 1234\n`);
  has(said, '    Something broke on our side.\n');
  has(said, `    ${what}\n`);
  has(said, `    ${LINKS.issues}\n`);
  lacks(said, 'Who fixes it');
  lacks(said, 'is live');
});

test('managed app: an app name that is taken is for you to fix, with where to do it', async () => {
  const s = setup();
  s.ms.queue('app init', failedWith(`An app named ${APP_NAME} already exists in this environment.`));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  const what = 'An app with that name already exists in the environment. Rename or delete the other one at managedapps.cloud.microsoft, then run it again.';
  assert.deepEqual(s.config.managedApp, {
    skipped: {
      why: `The last attempt to deploy it failed: An app named ${APP_NAME} already exists in this environment.`,
      steps: [what, `More: ${LINKS.portal}`, `Then run: ${deployAgain()}`],
    },
  });
  has(s.said(), `    ${LINKS.portal}\n`);

  // A long message is cut to 300 characters in the record.
  const long = setup();
  long.ms.queue('app init', failedWith('x'.repeat(400)));
  await deployTheApp(long.ctx, long.deps);
  assert.equal(long.config.managedApp?.skipped?.why, `The last attempt to deploy it failed: ${'x'.repeat(300)}`);
});

test("managed app: an app made without its ID saved fails, and says to delete it", async () => {
  const s = setup();
  s.ms.queue('app init', passed({}));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  const lost = "The app was made, but its ID wasn't saved. Delete it at managedapps.cloud.microsoft, then run it again.";
  assert.deepEqual(s.config.managedApp, { skipped: { why: 'The last attempt to deploy it failed.', steps: [lost, `Then run: ${deployAgain()}`] } });
  has(s.said(), `  ✗ The ${APP_NAME} app: ${lost}\n`);
  assert.equal(s.ms.calls.some((c) => c.key === 'app deploy'), false);
});

test('managed app: Conditional Access blocking the CLI is for an Entra admin, and fails the step', async () => {
  const s = setup();
  const error = 'AADSTS53003: Access has been blocked by Conditional Access policies.';
  s.ms.queue('auth status', failedWith(error));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  assert.deepEqual(s.events, ['auth status', 'save']);
  const skipped = s.config.managedApp?.skipped;
  assert.ok(skipped);
  assert.equal(skipped.why, `The last attempt to deploy it failed: ${error}`);
  has(skipped.steps[0], 'Entra admin');
  has(skipped.steps[0], CLI_APP_ID);
  assert.equal(skipped.steps.at(-1), `Then run: ${deployAgain()}`);
  has(s.said(), `  ✗ The ${APP_NAME} app: ${error}\n`);
  has(s.said(), CLI_APP_ID);
});

test('managed app: who fixes a failure is named with the right article', async () => {
  const error = 'AADSTS53003: Access has been blocked by Conditional Access policies.';
  const s = setup();
  s.ms.queue('auth status', failedWith(error));
  await deployTheApp(s.ctx, s.deps);
  has(s.said(), '    Who fixes it: an Entra admin.\n');
  has(String(s.config.managedApp?.skipped?.steps[0]), 'Ask an Entra admin: ');

  const sharing = setup();
  sharing.ms.queue('app share', failedWith(error));
  await deployTheApp(sharing.ctx, sharing.deps);
  has(String(sharing.config.managedApp?.skipped?.steps[0]), 'Ask an Entra admin: ');

  const admin = setup();
  admin.ms.queue('app share', failedWith('Sharing is blocked by an environment or tenant policy.'));
  await deployTheApp(admin.ctx, admin.deps);
  has(String(admin.config.managedApp?.skipped?.steps[0]), 'Ask a Power Platform admin: ');
});

test('managed app: a share the CLI refused leaves the app live, says what to do, and fails the step', async () => {
  const s = setup();
  s.ms.queue('app share', failedWith('The sharing request was rejected.'));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed', url: PLAY_URL });
  assert.deepEqual(s.events, [...NEW_APP.slice(0, 5), 'app share', 'save']);
  const what = 'Check the viewer group is in your organisation, then share the app with it at managedapps.cloud.microsoft.';
  const live = deployedRecord(s.distDir);
  delete live.sharedWith;
  assert.deepEqual(s.config.managedApp, {
    ...live,
    skipped: { why: `The app is live, but it isn't shared with ${GROUP_NAME}, so nobody else can open it.`, steps: [what, `Then run: ${deployAgain()}`] },
  });
  const said = s.said();
  has(said, `  ! Couldn't share the app with ${GROUP_NAME}: The sharing request was rejected.\n`);
  has(said, `    ${what}\n`);
  // It's still the first deploy, so what viewers need is said.
  has(said, 'Power Apps Premium');

  // The next run shares it, without deploying again.
  s.reset();
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app share', 'app share list', 'save']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
});

test('managed app: a policy that blocks sharing is for a Power Platform admin', async () => {
  const s = setup();
  const error = 'Sharing is blocked by an environment or tenant policy.';
  s.ms.queue('app share', failedWith(error));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed', url: PLAY_URL });
  const { what } = explain('share', { error });
  // Its advice already says how to run the step again.
  assert.deepEqual(s.config.managedApp?.skipped?.steps, [`Ask a Power Platform admin: ${what}`]);
  has(s.said(), `    ${what}\n`);
});

test("managed app: a share that hasn't shown up yet isn't a failure; it says where to check, and the next run shares it again", async () => {
  const s = setup();
  const lag = `  ! Shared the app with ${GROUP_NAME}, but couldn't see it in the app's sharing yet. It can take a few minutes. Check it at ${LINKS.portal}.\n`;
  // The CLI says yes, but the app's sharing doesn't list the group.
  s.ms.queue('app share', passed({ partialFailure: false, warnings: [] }));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.equal(s.config.managedApp?.skipped, undefined, 'no card on the Done page');
  assert.equal(s.config.managedApp?.sharedWith, undefined, 'not recorded');
  assert.deepEqual(nextSteps(s.config).filter((c) => c.id.startsWith('app-')), []);
  has(s.said(), lag);
  lacks(s.said(), '✗');

  // A list that fails is the same.
  s.reset();
  s.ms.queue('app share list', failedWith('The service is temporarily unavailable.'));
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app share', 'app share list', 'save'], 'shared again, not deployed again');
  assert.equal(s.config.managedApp?.sharedWith, undefined);
  has(s.said(), lag);

  s.reset();
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app share', 'app share list', 'save']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
});

test("managed app: the CLI's warnings on a deploy or a share are passed on", async () => {
  const s = setup();
  s.ms.queue('app deploy', (call) => {
    s.ms.answer('app deploy', call);
    return passed({ appPlayUri: PLAY_URL, warnings: ['The bundle is large.'] });
  });
  s.ms.queue('app share', (call) => {
    s.ms.answer('app share', call);
    return passed({ partialFailure: false, warnings: ['Some members of the group have no licence.'] });
  });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  const said = s.said();
  has(said, '  ! The bundle is large.\n');
  has(said, '  ! Some members of the group have no licence.\n');
  has(said, `  ✓ Shared the app with ${GROUP_NAME}\n`);
});

test('managed app: with no viewer group, the app is deployed and not shared', async () => {
  const s = setup({ group: null });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app init', 'save', 'app deploy', 'save', 'save']);
  const record = deployedRecord(s.distDir);
  delete record.sharedWith;
  assert.deepEqual(s.config.managedApp, record);
  lacks(s.said(), 'Shared the app');
  assert.equal(s.ms.state.shared.length, 0);

  s.reset();
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'up-to-date');
  assert.equal(s.ms.calls.length, 0);
});

test("managed app: a viewer group without a name is called the viewer group", async () => {
  const s = setup({ groupName: null });
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  has(s.said(), '  ✓ Shared the app with the viewer group\n');
});

test("managed app: the app's link is asked for when the deploy doesn't give it, and it's live without one", async () => {
  const s = setup({ ms: { deployUri: undefined, url: PLAY_URL } });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, ['auth status', 'app init', 'save', 'app deploy', 'app play', 'save', 'app share', 'app share list', 'save']);
  assert.deepEqual(s.ms.call('app play').args, ['app', 'play', '--no-browser']);
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));

  const none = setup({ ms: { deployUri: undefined } });
  assert.deepEqual(await deployTheApp(none.ctx, none.deps), { ok: true, state: 'deployed' });
  const record = deployedRecord(none.distDir);
  delete record.url;
  assert.deepEqual(none.config.managedApp, record);
  has(none.said(), `  ✓ The ${APP_NAME} app is live\n`);
});

test("managed app: the build is the sources' appDist unless deps name one, and deps can name the app's folder", async () => {
  const s = setup();
  const appDir = join(temp(), 'app');
  const { run, nodeVersion, cliDir } = s.deps;
  assert.equal((await deployTheApp(s.ctx, { run, nodeVersion, cliDir, appDir })).state, 'deployed');
  assert.deepEqual(s.ms.call('app init').options, { cwd: appDir });
  assert.equal(buildHash(join(appDir, 'dist')), buildHash(s.distDir));
  assert.equal(readAppConfig(appDir)?.appId, APP_ID);
  assert.equal(existsSync(s.appDir), false);
});

test('managed app: without a build, the CLI, or a new enough Node.js, the app is skipped with what to do, unless it has nothing to do', async () => {
  const noBuild = setup();
  assert.deepEqual(await deployTheApp(noBuild.ctx, { ...noBuild.deps, distDir: join(temp(), 'none') }), { ok: true, state: 'skipped' });
  assert.deepEqual(noBuild.events, ['save']);
  assert.equal(noBuild.ms.calls.length, 0);
  assert.equal(noBuild.config.managedApp?.skipped?.why, 'This copy of the installer has no build of the app.');
  has(noBuild.said(), `  ! Skipped ${THE_APP}: This copy of the installer has no build of the app.\n`);
  has(noBuild.said(), `    Then run: ${deployAgain()}\n`);

  // What was missing before is replaced by why it's skipped.
  const noCli = setup({ installed: null, record: { missing: ['createApps'] } });
  assert.deepEqual(await deployTheApp(noCli.ctx, noCli.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(noCli.config.managedApp, { skipped: whyNot({ distDir: noCli.distDir, cliDir: noCli.cliDir, nodeVersion: NODE_OK }) });
  has(noCli.said(), `  ! Skipped ${THE_APP}: The managed apps CLI isn't installed here.\n`);
  assert.equal(noCli.ms.calls.length, 0);

  // An app with nothing to do needs no CLI, so an older Node.js, or no CLI, leaves it alone.
  const s = await deployedApp();
  const live = deployedRecord(s.distDir);
  const old = 'v22.11.0';
  assert.deepEqual(await deployTheApp(s.ctx, { ...s.deps, nodeVersion: old }), { ok: true, state: 'up-to-date', url: PLAY_URL });
  assert.deepEqual(await deployTheApp(s.ctx, { ...s.deps, cliDir: writeCliPackage(temp(), { installed: null }) }), { ok: true, state: 'up-to-date', url: PLAY_URL });
  assert.deepEqual(s.config.managedApp, live);
  has(s.said(), `  ✓ The ${APP_NAME} app is up to date: ${PLAY_URL}\n`);
  assert.equal(s.ms.calls.length, 0);

  // A new build is skipped, and the app that's live keeps its link.
  writeFiles(s.distDir, { 'assets/app-2.js': 'console.log("v2");' });
  assert.deepEqual(await deployTheApp(s.ctx, { ...s.deps, nodeVersion: old }), { ok: true, state: 'skipped', url: PLAY_URL });
  assert.deepEqual(s.config.managedApp, { ...live, skipped: whyNot({ distDir: s.distDir, cliDir: s.cliDir, nodeVersion: old }) });
  assert.equal(s.ms.calls.length, 0);
});

test('managed app: the CLI is used as the person running the installer, switching to them when it knows them', async () => {
  const upper = setup({ ms: { account: USER.toUpperCase() } });
  assert.equal((await deployTheApp(upper.ctx, upper.deps)).state, 'deployed');
  assert.deepEqual(upper.events, NEW_APP);

  const s = setup({ ms: { account: OTHER_USER, accounts: [OTHER_USER, USER] } });
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  assert.deepEqual(s.events.slice(0, 4), ['auth status', 'auth switch', 'auth status', 'app init']);
  assert.deepEqual(s.ms.call('auth switch').args, ['auth', 'switch', '--account', USER]);
  assert.equal(s.ms.state.account, USER);
  assert.deepEqual(s.asked, []);

  // Switching needs no browser, so it works with --yes.
  const yes = setup({ yes: true, ms: { account: undefined, accounts: [USER] } });
  assert.equal((await deployTheApp(yes.ctx, yes.deps)).state, 'deployed');
  assert.deepEqual(yes.events.slice(0, 4), ['auth status', 'auth switch', 'auth status', 'app init']);
});

test('managed app: a CLI that is not signed in opens a browser to sign in as the person running the installer', async () => {
  const s = setup({ ms: { account: undefined } });
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  assert.deepEqual(s.events.slice(0, 4), ['auth status', 'auth login', 'auth status', 'app init']);
  const signing = s.ms.call('auth login');
  assert.deepEqual(signing.args, ['auth', 'login', '--account', USER]);
  assert.deepEqual(signing.options, { onScreen: true });
  has(s.said(), `    Sign in to the managed apps CLI as ${USER}. A browser opens.\n`);
  assert.deepEqual(s.asked, []);
});

test("managed app: with --yes, a CLI that isn't signed in skips the app, as it won't open a browser", async () => {
  const s = setup({ yes: true, ms: { account: undefined } });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(s.events, ['auth status', 'save']);
  assert.deepEqual(s.config.managedApp, {
    skipped: {
      why: `The managed apps CLI isn't signed in as ${USER}, and --yes doesn't open a browser.`,
      steps: [`Run ${deployAgain()} without --yes, and sign in when it asks.`],
    },
  });
  has(s.said(), `  ! Skipped ${THE_APP}: The managed apps CLI isn't signed in as ${USER}, and --yes doesn't open a browser.\n`);
  has(s.said(), `    Run ${deployAgain()} without --yes, and sign in when it asks.\n`);
});

test('managed app: a browser sign-in as someone else is used only if you say so', async () => {
  const question = `The CLI signed in as ${OTHER_USER}, not ${USER}. Deploy the app as ${OTHER_USER}?`;
  const yes = setup({ ms: { account: undefined, loginAs: OTHER_USER }, answers: [true] });
  assert.equal((await deployTheApp(yes.ctx, yes.deps)).state, 'deployed');
  assert.deepEqual(yes.asked, [question]);
  assert.deepEqual(yes.events.slice(0, 4), ['auth status', 'auth login', 'auth status', 'app init']);

  const no = setup({ ms: { account: undefined, loginAs: OTHER_USER } });
  assert.deepEqual(await deployTheApp(no.ctx, no.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(no.asked, [question]);
  assert.deepEqual(no.events, ['auth status', 'auth login', 'auth status', 'save']);
  assert.deepEqual(no.config.managedApp?.skipped, {
    why: `The managed apps CLI signed in as ${OTHER_USER}, not ${USER}.`,
    steps: [`Run ${deployAgain()}, and sign in as ${USER} when it asks.`],
  });
});

test("managed app: a sign-in that didn't happen skips the app, and one that failed fails it", async () => {
  const s = setup({ ms: { account: undefined } });
  s.ms.queue('auth login', { ok: true, exitCode: 0, data: undefined, stdout: '', stderr: '' });
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'skipped' });
  assert.deepEqual(s.asked, []);
  assert.deepEqual(s.config.managedApp?.skipped, {
    why: "The managed apps CLI didn't sign in.",
    steps: [`Run ${deployAgain()}, and sign in as ${USER} when it asks.`],
  });

  const cancelled = setup({ ms: { account: undefined } });
  cancelled.ms.queue('auth login', failedWith('The browser sign-in was cancelled.'));
  assert.deepEqual(await deployTheApp(cancelled.ctx, cancelled.deps), { ok: false, state: 'failed' });
  assert.deepEqual(cancelled.events, ['auth status', 'auth login', 'save']);
  has(cancelled.said(), `  ✗ The ${APP_NAME} app: The browser sign-in was cancelled.\n`);

  const offline = setup();
  offline.ms.queue('auth status', failedWith('getaddrinfo ENOTFOUND login.microsoftonline.com', { exitCode: 5 }));
  assert.deepEqual(await deployTheApp(offline.ctx, offline.deps), { ok: false, state: 'failed' });
  assert.deepEqual(offline.events, ['auth status', 'save']);
  has(String(offline.config.managedApp?.skipped?.steps[0]), "It couldn't reach Microsoft.");
});

test("managed app: when the installer doesn't know who you are, the CLI's own account is used", async () => {
  const s = setup({ ms: { account: OTHER_USER } });
  s.ctx.user = /** @type {any} */ ({ ...s.ctx.user, upn: undefined });
  assert.equal((await deployTheApp(s.ctx, s.deps)).state, 'deployed');
  assert.deepEqual(s.events, NEW_APP);

  const out = setup({ ms: { account: undefined, loginAs: OTHER_USER } });
  out.ctx.user = /** @type {any} */ (undefined);
  assert.equal((await deployTheApp(out.ctx, out.deps)).state, 'deployed');
  assert.deepEqual(out.ms.call('auth login').args, ['auth', 'login']);
  has(out.said(), '    Sign in to the managed apps CLI. A browser opens.\n');
  assert.deepEqual(out.asked, []);
});

test('managed app: a sign-in that expires during a step signs in again and carries on', async () => {
  const expired = failedWith('Your sign-in session has expired.', { exitCode: 3 });
  const s = setup();
  s.ms.queue('app deploy', expired);
  s.ms.queue('app share', expired);
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: true, state: 'deployed', url: PLAY_URL });
  assert.deepEqual(s.events, [
    'auth status', 'app init', 'save',
    'app deploy', 'auth login', 'app deploy', 'save',
    'app share', 'auth login', 'app share', 'app share list', 'save',
  ]);
  assert.deepEqual(s.ms.call('auth login').args, ['auth', 'login', '--account', USER]);
  has(s.said(), "    The managed apps CLI's sign-in expired. Sign in again; a browser opens.\n");
  assert.deepEqual(s.config.managedApp, deployedRecord(s.distDir));
});

test('managed app: with --yes, or when signing in again fails, an expired sign-in fails the step', async () => {
  const expired = failedWith('Your sign-in session has expired.', { exitCode: 3 });
  const what = `Your sign-in didn't work or has expired. Run ${deployAgain()}, and sign in when it asks.`;
  const s = setup({ yes: true });
  s.ms.queue('app deploy', expired);
  assert.deepEqual(await deployTheApp(s.ctx, s.deps), { ok: false, state: 'failed' });
  assert.deepEqual(s.events, ['auth status', 'app init', 'save', 'app deploy', 'save']);
  assert.deepEqual(s.config.managedApp?.skipped?.steps, [what]);
  lacks(s.said(), 'Sign in again');

  const failing = setup();
  failing.ms.queue('app init', expired);
  failing.ms.queue('auth login', failedWith('The browser sign-in was cancelled.'));
  assert.deepEqual(await deployTheApp(failing.ctx, failing.deps), { ok: false, state: 'failed' });
  assert.deepEqual(failing.events, ['auth status', 'app init', 'auth login', 'save']);
  // What's said is the step's failure, not the sign-in's.
  assert.equal(failing.config.managedApp?.skipped?.why, 'The last attempt to deploy it failed: Your sign-in session has expired.');
  assert.deepEqual(failing.config.managedApp?.skipped?.steps, [what]);
});

test('managed app: removing it deletes the app with the CLI, then its folder and its record', async () => {
  const s = await deployedApp();
  assert.ok(existsSync(join(s.appDir, APP_CONFIG)));
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: true });
  assert.deepEqual(s.events, ['auth status', 'app delete', 'save']);
  const deleting = s.ms.call('app delete');
  assert.deepEqual(deleting.args, ['app', 'delete', '--force', '--app', APP_ID, '--environment-id', DEV_ENV]);
  assert.deepEqual(deleting.options, { cwd: s.appDir });
  assert.deepEqual(s.ms.state.deleted, [APP_ID]);
  assert.equal(existsSync(s.appDir), false);
  assert.equal('managedApp' in s.config, false);
  assert.deepEqual(s.saved, [undefined]);
  assert.equal(s.said(), `  ✓ Deleted ${THE_APP}\n`);
});

test("managed app: an app that's already gone is forgotten", async () => {
  for (const answer of [failedWith('The app was not found.', { exitCode: 6 }), passed({ existed: false })]) {
    const s = await deployedApp();
    s.ms.queue('app delete', answer);
    assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: false });
    assert.deepEqual(s.events, ['auth status', 'app delete', 'save']);
    assert.equal('managedApp' in s.config, false);
    assert.equal(existsSync(s.appDir), false);
    assert.equal(s.said(), `  ✓ The ${APP_NAME} app was already gone\n`);
  }
});

test('managed app: with nothing deployed, removing it only tidies up, and needs no CLI', async () => {
  const s = setup({ installed: null });
  writeFiles(s.appDir, { 'dist/index.html': '<html></html>' });
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: false });
  assert.deepEqual(s.events, ['save']);
  assert.equal(s.ms.calls.length, 0);
  assert.equal(existsSync(s.appDir), false);
  assert.equal(s.said(), '');

  // A tenant that wasn't ready: no app was made.
  const notMade = setup({ record: { missing: ['createApps'] } });
  assert.deepEqual(await removeTheApp(notMade.ctx, notMade.deps), { ok: true, removed: false });
  assert.deepEqual(notMade.events, ['save']);
  assert.equal('managedApp' in notMade.config, false);
  assert.equal(notMade.ms.calls.length, 0);
});

test("managed app: when the CLI can't delete the app, the record keeps it and says where to delete it", async () => {
  const s = await deployedApp();
  const before = structuredClone(s.config.managedApp);
  s.ms.queue('app delete', failedWith('You do not have permission to delete this app.'));
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: false, removed: false });
  assert.deepEqual(s.events, ['auth status', 'app delete']);
  assert.deepEqual(s.config.managedApp, before);
  assert.ok(existsSync(join(s.appDir, APP_CONFIG)));
  assert.equal(
    s.said(),
    `  ! The ${APP_NAME} app (${APP_ID}) is still there: You do not have permission to delete this app. Delete it at ${LINKS.portal}.\n`,
  );
});

test('managed app: without the CLI or a new enough Node.js, removing it leaves the app and says why', async () => {
  const s = await deployedApp();
  const before = structuredClone(s.config.managedApp);
  const noCli = writeCliPackage(temp(), { installed: null });
  assert.deepEqual(await removeTheApp(s.ctx, { ...s.deps, cliDir: noCli }), { ok: false, removed: false });
  assert.deepEqual(s.events, []);
  assert.equal(s.said(), `  ! The ${APP_NAME} app (${APP_ID}) is still there: The managed apps CLI isn't installed here. Delete it at ${LINKS.portal}.\n`);

  s.reset();
  assert.deepEqual(await removeTheApp(s.ctx, { ...s.deps, nodeVersion: 'v20.0.0' }), { ok: false, removed: false });
  assert.deepEqual(s.events, []);
  has(s.said(), `is still there: The managed apps CLI needs Node.js ${MIN_NODE} or later, and this is 20.0.0. Delete it at ${LINKS.portal}.\n`);
  assert.equal(s.ms.calls.length, 0);
  assert.deepEqual(s.config.managedApp, before);
  assert.ok(existsSync(s.appDir));
});

test("managed app: removing it works without the app's folder, an environment, or a build", async () => {
  const s = await deployedApp();
  const record = s.config.managedApp;
  assert.ok(record);
  delete record.environmentId;
  rmSync(s.appDir, { recursive: true });
  rmSync(s.distDir, { recursive: true });
  assert.deepEqual(await removeTheApp(s.ctx, { run: s.deps.run, nodeVersion: NODE_OK, cliDir: s.cliDir }), { ok: true, removed: true });
  const deleting = s.ms.call('app delete');
  assert.deepEqual(deleting.args, ['app', 'delete', '--force', '--app', APP_ID]);
  assert.deepEqual(deleting.options, { cwd: undefined });
  assert.equal('managedApp' in s.config, false);
});

test('managed app: removing it signs the CLI in as you, and with --yes never opens a browser', async () => {
  const switching = await deployedApp();
  switching.ms.state.account = OTHER_USER;
  switching.ms.state.accounts.push(OTHER_USER);
  assert.deepEqual(await removeTheApp(switching.ctx, switching.deps), { ok: true, removed: true });
  assert.deepEqual(switching.events, ['auth status', 'auth switch', 'auth status', 'app delete', 'save']);

  const browser = await deployedApp();
  browser.ms.state.account = undefined;
  browser.ms.state.accounts.length = 0;
  assert.deepEqual(await removeTheApp(browser.ctx, browser.deps), { ok: true, removed: true });
  assert.deepEqual(browser.events, ['auth status', 'auth login', 'auth status', 'app delete', 'save']);

  const declined = await deployedApp();
  declined.ms.state.account = undefined;
  declined.ms.state.accounts.length = 0;
  declined.ms.state.loginAs = OTHER_USER;
  assert.deepEqual(await removeTheApp(declined.ctx, declined.deps), { ok: false, removed: false });
  assert.equal(declined.asked.length, 1);
  assert.equal(declined.ms.state.deleted.length, 0);
  has(declined.said(), `is still there: The managed apps CLI signed in as ${OTHER_USER}, not ${USER}. Delete it at ${LINKS.portal}.\n`);

  const yes = await deployedApp({ yes: true });
  yes.ms.state.account = undefined;
  yes.ms.state.accounts.length = 0;
  const before = structuredClone(yes.config.managedApp);
  assert.deepEqual(await removeTheApp(yes.ctx, yes.deps), { ok: false, removed: false });
  assert.deepEqual(yes.events, ['auth status']);
  assert.deepEqual(yes.config.managedApp, before);
  assert.equal(
    yes.said(),
    `  ! The ${APP_NAME} app (${APP_ID}) is still there: The managed apps CLI isn't signed in as ${USER}, and --yes doesn't open a browser. Delete it at ${LINKS.portal}.\n`,
  );
});

test("managed app: when the CLI can't sign in, removing it keeps the record and the folder", async () => {
  const s = await deployedApp();
  const before = structuredClone(s.config.managedApp);
  s.ms.queue('auth status', failedWith('getaddrinfo ENOTFOUND login.microsoftonline.com', { exitCode: 5 }));
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: false, removed: false });
  assert.deepEqual(s.events, ['auth status']);
  assert.deepEqual(s.config.managedApp, before);
  assert.ok(existsSync(join(s.appDir, APP_CONFIG)));
  has(s.said(), `  ! The ${APP_NAME} app (${APP_ID}) is still there: `);
  has(s.said(), ` Delete it at ${LINKS.portal}.\n`);
});

test("managed app: when removing it fails, it says why in the CLI's words, and not to deploy the app again", async () => {
  const offline = await deployedApp();
  offline.ms.queue('auth status', failedWith('getaddrinfo ENOTFOUND login.microsoftonline.com', { exitCode: 5 }));
  const cancelled = await deployedApp();
  cancelled.ms.state.account = undefined;
  cancelled.ms.state.accounts.length = 0;
  cancelled.ms.queue('auth login', failedWith('The browser sign-in was cancelled.'));
  const silent = await deployedApp();
  silent.ms.queue('app delete', { ok: false, exitCode: 1, data: undefined, stdout: '', stderr: '' });
  let said = '';
  for (const s of [offline, cancelled, silent]) {
    assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: false, removed: false });
    said += s.said();
  }
  lacks(said, deployAgain());
  const still = `  ! The ${APP_NAME} app (${APP_ID}) is still there: `;
  const portal = ` Delete it at ${LINKS.portal}.\n`;
  assert.equal(offline.said(), `${still}The managed apps CLI couldn't sign in: getaddrinfo ENOTFOUND login.microsoftonline.com.${portal}`);
  has(cancelled.said(), `${still}The managed apps CLI couldn't sign in: The browser sign-in was cancelled.${portal}`);
  assert.equal(silent.said(), `${still}The managed apps CLI couldn't delete it, and didn't say why.${portal}`);
});

test('managed app: removing it as someone else asks about removing it, not deploying it', async () => {
  const s = await deployedApp({ answers: [true] });
  s.ms.state.account = undefined;
  s.ms.state.accounts.length = 0;
  s.ms.state.loginAs = OTHER_USER;
  assert.deepEqual(await removeTheApp(s.ctx, s.deps), { ok: true, removed: true });
  assert.deepEqual(s.events, ['auth status', 'auth login', 'auth status', 'app delete', 'save']);
  assert.equal(s.asked.length, 1);
  lacks(s.asked[0], 'Deploy');
  has(s.asked[0], `Delete the app as ${OTHER_USER}?`);
});
