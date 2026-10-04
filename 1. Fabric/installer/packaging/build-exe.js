#!/usr/bin/env node
// @ts-check
/**
 * Builds AnalyticsHubInstaller.exe: one file a customer downloads and double-clicks. It holds
 * Node.js, the installer, the templates it deploys and the app already built, and unpacks them
 * under %LOCALAPPDATA%\AnalyticsHub the first time it runs.
 *
 * Usage: npm run build:exe -- [--out <dir>] [--keep] [--release]
 *   --out <dir>   Where to write the exe (default ./dist-exe)
 *   --keep        Keep the working folder, to look at what went into the payload
 *   --release     Fail rather than warn when something a published download needs is missing
 *
 * Needs Windows, the app's and the installer's dependencies (npm ci in each), and the
 * .NET Framework C# compiler that ships with Windows.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_DIR } from '../src/sources.js';
import { FABRIC_CONFIG, PREBUILT_MARKER, PREBUILT_STATIC, nodeVersionOk } from '../src/steps/app.js';
import {
  EMPTY_GENERATED, EXE_NAME, SOURCE_ROOT, appFile, appPackageJson, fileVersion, installerFile, leakedIds, localIds, payloadId, prebuiltRayfinYml,
  prunable, sourceFiles, tooLong,
} from './payload.js';

const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FABRIC = resolve(INSTALLER, '..');
const APP = join(FABRIC, APP_DIR);
const LAUNCHER = join(INSTALLER, 'packaging', 'launcher');

const { values: opts } = parseArgs({
  options: { out: { type: 'string' }, keep: { type: 'boolean' }, release: { type: 'boolean' } },
});

/** @param {string} m */
const step = (m) => process.stdout.write(`\n▸ ${m}\n`);
/** @param {string} m */
const warn = (m) => {
  if (opts.release) throw new Error(m);
  process.stdout.write(`  ! ${m}\n`);
};

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean }} [o]
 */
function run(cmd, args, o = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...o });
  if (res.error) throw res.error;
  if (res.status) throw new Error(`${[cmd, ...args].join(' ')} failed with exit code ${res.status}.`);
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
const git = (args, cwd = INSTALLER) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const REPO = resolve(git(['rev-parse', '--show-toplevel']).trim());

/**
 * The files under a folder that git tracks or would commit, relative to it. Files marked
 * skip-worktree hold a developer's own settings, so the build takes them as committed.
 * @param {string} dir
 * @returns {{ rel: string, read: () => Buffer }[]}
 */
function tracked(dir) {
  const prefix = relative(REPO, dir).replaceAll('\\', '/');
  /** @param {string} out */
  const lines = (out) => out.split('\0').filter(Boolean);
  const files = [
    ...lines(git(['ls-files', '-v', '-z', '--', prefix], REPO)).map((line) => ({ tag: line[0], path: line.slice(2) })),
    ...lines(git(['ls-files', '-z', '--others', '--exclude-standard', '--', prefix], REPO)).map((path) => ({ tag: '?', path })),
  ]
    .filter(({ tag, path }) => tag === 'S' || existsSync(join(REPO, path)))
    .map(({ tag, path }) => ({
      rel: path.slice(prefix.length + 1),
      read: tag === 'S'
        ? () => execFileSync('git', ['show', `HEAD:${path}`], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 })
        : () => readFileSync(join(REPO, path)),
    }));
  if (!files.length) throw new Error(`git lists no files under ${dir}.`);
  return files;
}

/**
 * @param {string} file
 * @param {string | Buffer} body
 */
function put(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/**
 * Every file under a folder, relative to it, with forward slashes.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll('\\', '/'));
}

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** @param {string} file */
const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

if (process.platform !== 'win32') throw new Error('The exe builds on Windows only.');
if (!nodeVersionOk()) throw new Error(`Build with Node.js 22.13 or later; the exe ships the Node.js that builds it. This is ${process.versions.node}.`);
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const TAR = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe');
for (const tool of [CSC, TAR]) if (!existsSync(tool)) throw new Error(`Can't find ${tool}.`);
for (const dir of [APP, INSTALLER]) {
  if (!existsSync(join(dir, 'node_modules'))) throw new Error(`Run "npm ci" in ${dir} first.`);
}

const version = String(readJson(join(INSTALLER, 'package.json')).version);
const commit = git(['rev-parse', 'HEAD']).trim();
const outDir = resolve(opts.out ?? join(INSTALLER, 'dist-exe'));
const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'ahx-'));
const appWork = join(work, 'app');
const appModules = join(appWork, 'node_modules');
const stage = join(work, 'stage');
const stagedApp = join(stage, SOURCE_ROOT, APP_DIR);
const stagedInstaller = join(stage, SOURCE_ROOT, 'installer');
let linked = false;

try {
  step(`Building the app (installer ${version}, ${commit.slice(0, 7)})`);
  // A copy of the committed app, so none of this checkout's settings reach the build.
  for (const f of tracked(APP)) put(join(appWork, f.rel), f.read());
  put(join(appWork, 'src', 'fabric.generated.ts'), EMPTY_GENERATED);
  symlinkSync(join(APP, 'node_modules'), appModules, 'junction');
  linked = true;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^VITE_|^PROJECT_ROOT$/i.test(k)));
  run(process.execPath, [join(appModules, 'vite', 'bin', 'vite.js'), 'build'], { cwd: appWork, env: { ...env, NODE_ENV: 'production' } });
  unlinkSync(appModules);
  linked = false;

  step('Staging the app with the tools that deploy it');
  cpSync(join(appWork, 'dist'), join(stagedApp, PREBUILT_STATIC), { recursive: true });
  for (const f of tracked(APP)) {
    if (appFile(f.rel)) put(join(stagedApp, f.rel), f.read());
    if (f.rel === 'rayfin/rayfin.yml') put(join(stagedApp, f.rel), prebuiltRayfinYml(f.read().toString('utf8')));
  }
  const lock = readJson(join(APP, 'package-lock.json')).packages;
  /** @param {string} name */
  const locked = (name) => {
    const v = lock[`node_modules/${name}`]?.version;
    if (!v) throw new Error(`${name} isn't in the app's package-lock.json.`);
    return String(v);
  };
  const rayfin = locked('@microsoft/rayfin-cli');
  if (locked('@microsoft/rayfin-core') !== rayfin) throw new Error('The app\'s rayfin-cli and rayfin-core versions differ.');
  put(join(stagedApp, 'package.json'), `${JSON.stringify(appPackageJson({ rayfin, vite: locked('vite'), version }), null, 2)}\n`);
  run('npm install --omit=dev --no-package-lock --no-audit --no-fund', [], { cwd: stagedApp, shell: true });
  put(join(stagedApp, PREBUILT_MARKER), `${JSON.stringify({ version, commit, builtAt: new Date().toISOString() }, null, 2)}\n`);
  // Rayfin compiles the data schema on every deploy; prove it compiles here.
  const tsc = createRequire(join(stagedApp, 'node_modules', '@microsoft', 'rayfin-cli', 'package.json')).resolve('typescript/lib/tsc.js');
  run(process.execPath, [tsc, '-p', join('rayfin', 'tsconfig.json')], { cwd: stagedApp });
  rmSync(join(stagedApp, 'rayfin', '.temp'), { recursive: true, force: true });

  step('Staging the installer');
  for (const f of tracked(INSTALLER)) if (installerFile(f.rel)) put(join(stagedInstaller, f.rel), f.read());
  run('npm ci --omit=dev --no-audit --no-fund', [], { cwd: stagedInstaller, shell: true });

  step('Staging the notebooks, pipeline and templates');
  for (const rel of sourceFiles()) {
    const from = join(FABRIC, rel);
    if (!existsSync(from)) throw new Error(`Missing ${from}.`);
    put(join(stage, SOURCE_ROOT, rel), readFileSync(from));
  }
  const { loadSources } = await import(pathToFileURL(join(stagedInstaller, 'src', 'sources.js')).href);
  const sources = loadSources();
  if (resolve(sources.dir) !== resolve(stage, SOURCE_ROOT)) throw new Error(`The staged installer reads its templates from ${sources.dir}.`);
  for (const key of ['modelFile', 'consumptionModelFile', 'agentEvaluatorModelFile', 'appDir']) {
    if (!sources[key]) throw new Error(`The staged installer can't find its ${key}.`);
  }
  if (!existsSync(join(sources.appDir, PREBUILT_MARKER))) throw new Error('The staged app isn\'t marked prebuilt.');

  step('Adding Node.js and the licences');
  put(join(stage, 'node', 'node.exe'), readFileSync(process.execPath));
  const nodeLicense = join(dirname(process.execPath), 'LICENSE');
  if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(stage, 'node', 'LICENSE'));
  else {
    warn(`No LICENSE next to ${process.execPath}; pointing to Node.js's licence online instead.`);
    put(join(stage, 'node', 'LICENSE'), `Node.js ${process.version} is licensed under the MIT License, with the third-party licences listed at\nhttps://github.com/nodejs/node/blob/${process.version}/LICENSE\n`);
  }
  copyFileSync(join(FABRIC, '..', 'LICENSE'), join(stage, 'LICENSE.txt'));

  step('Leaving out source maps');
  let pruned = 0;
  for (const rel of walk(stage)) {
    if (!prunable(rel)) continue;
    rmSync(join(stage, rel));
    pruned++;
  }
  process.stdout.write(`  ${pruned} files left out\n`);

  step('Checking the payload');
  const files = walk(stage);
  const long = tooLong(files);
  if (long.length) throw new Error(`These paths are too long to unpack and run safely (see MAX_PAYLOAD_PATH in payload.js):\n  ${long.join('\n  ')}`);
  // IDs already in the repo, such as Microsoft Graph's, are public.
  const committed = git(['grep', '-I', '-h', '-o', '-i', '-E', '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'HEAD', '--', ':/']).split('\n');
  const own = [
    ...['.env', '.env.local', '.env.production', '.env.production.local', 'fabric.yaml', 'src/fabric.generated.ts', 'rayfin/rayfin.yml', 'rayfin/.env', 'rayfin/.deployments.json']
      .map((f) => readIf(join(APP, f))),
    ...readdirSync(INSTALLER).filter((f) => /^valuelens-install.*\.json$/i.test(f)).map((f) => readIf(join(INSTALLER, f))),
  ];
  const ids = localIds(own, committed.map((l) => l.replace(/^HEAD:/, '').trim()));
  for (const rel of files) {
    if (/^node\/|\/node_modules\//.test(rel)) continue;
    const leaked = leakedIds(readFileSync(join(stage, rel), 'latin1'), ids);
    if (leaked.length) throw new Error(`${rel} holds IDs from this computer's own settings: ${leaked.join(', ')}.`);
  }
  if (files.some((f) => f.endsWith(`/${FABRIC_CONFIG}`))) throw new Error(`The payload holds a ${FABRIC_CONFIG}; the installer writes it at deploy time.`);
  process.stdout.write(`  ${files.length} files, none from this computer's settings\n`);

  step('Packing');
  const zip = join(work, 'payload.zip');
  run(TAR, ['-a', '-c', '-f', zip, '-C', stage, 'node', SOURCE_ROOT, 'LICENSE.txt']);
  const id = payloadId(version, createHash('sha256').update(readFileSync(zip)).digest('hex'));
  writeFileSync(join(work, 'payload-id.txt'), id, 'utf8');
  for (const f of ['Launcher.cs', 'app.manifest']) copyFileSync(join(LAUNCHER, f), join(work, f));
  writeFileSync(join(work, 'AssemblyInfo.cs'), [
    'using System.Reflection;',
    '[assembly: AssemblyTitle("Analytics Hub installer")]',
    '[assembly: AssemblyDescription("Sets up Analytics Hub for Microsoft Copilot in Microsoft Fabric.")]',
    '[assembly: AssemblyProduct("ValueLens Analytics Hub")]',
    '[assembly: AssemblyCompany("Microsoft Corporation")]',
    '[assembly: AssemblyCopyright("Copyright (c) Microsoft Corporation. MIT License.")]',
    `[assembly: AssemblyVersion("${fileVersion(version)}")]`,
    `[assembly: AssemblyFileVersion("${fileVersion(version)}")]`,
    `[assembly: AssemblyInformationalVersion("${version}+${commit.slice(0, 7)}")]`,
    '',
  ].join('\r\n'), 'utf8');
  mkdirSync(outDir, { recursive: true });
  const exe = join(outDir, EXE_NAME);
  run(CSC, [
    '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${exe}`, '/win32manifest:app.manifest',
    '/reference:System.IO.Compression.dll',
    '/resource:payload.zip,payload.zip', '/resource:payload-id.txt,payload-id.txt',
    'Launcher.cs', 'AssemblyInfo.cs',
  ], { cwd: work });
  const hash = createHash('sha256').update(readFileSync(exe)).digest('hex');
  writeFileSync(`${exe}.sha256`, `${hash}  ${EXE_NAME}\n`, 'utf8');
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
  process.stdout.write(`\n✓ ${exe}\n  ${mb(readFileSync(exe).length)}, payload ${id}\n  sha256 ${hash}\n`);
} finally {
  if (linked) {
    try {
      unlinkSync(appModules);
      linked = false;
    } catch (err) {
      process.stderr.write(`Couldn't unlink ${appModules}: ${/** @type {Error} */ (err).message}\n`);
    }
  }
  // Never remove the working folder while it links to the app's node_modules.
  if (opts.keep || linked) process.stdout.write(`\nWorking folder: ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}
