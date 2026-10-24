#!/usr/bin/env node
// @ts-check
/**
 * Builds ValueLensInstaller.exe: one file a customer downloads and double-clicks. It holds
 * Node.js, the installer, the templates it deploys, the app already built and the Copilot managed
 * apps CLI that deploys it, and unpacks them under %LOCALAPPDATA%\ValueLens the first time it runs.
 *
 * Next to it go the same payload as ValueLensInstaller.zip, and install.ps1, which downloads that
 * zip, checks it and runs it from PowerShell, for organisations that block downloaded exes.
 *
 * Usage: npm run build:exe -- [--out <dir>] [--keep] [--release] [--repo <owner/name>]
 *   --out <dir>   Where to write the exe (default ./dist-exe)
 *   --repo <name> The repo whose releases install.ps1 downloads from (default $GITHUB_REPOSITORY,
 *                 then microsoft/ValueLens-for-Microsoft-Copilot)
 *   --keep        Keep the working folder, to look at what went into the payload
 *   --release     Fail rather than warn when something a published download needs is missing
 *
 * Needs Windows, the app's and the installer's dependencies (npm ci in each), and the .NET
 * Framework C# compiler that ships with Windows. The exe ships the Node.js that builds it, and the
 * managed apps CLI needs Node.js 24.11 or later.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  APP_SAMPLE_DATA, APP_SAMPLE_FILES, EXE_NAME, MANAGED_CLI_DIR, SOURCE_ROOT, fileVersion, installerFile, leakedIds, localIds, msalRuntimeArch,
  payloadId, prunable, sourceFiles, tooLong,
} from './payload.js';
import { SCRIPT_NAME, ZIP_NAME, installScript } from './script.js';
import { sha256File, sha256Line } from './signing.js';
import { MIN_NODE, nodeOk } from '../src/managed-app/cli.js';
import { PRODUCT } from '../src/product.js';
import { APP_DIST } from '../src/sources.js';
import { REPO as GITHUB_REPO } from '../src/update-check.js';

const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(INSTALLER, '..');
const APP = join(SOURCE, dirname(APP_DIST));
const LAUNCHER = join(INSTALLER, 'packaging', 'launcher');

const { values: opts } = parseArgs({
  options: { out: { type: 'string' }, keep: { type: 'boolean' }, release: { type: 'boolean' }, repo: { type: 'string', default: process.env.GITHUB_REPOSITORY || GITHUB_REPO } },
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
// The exe ships the Node.js that builds it, so it must be one the installer runs on.
const engines = /^>=(\d+)\.(\d+)/.exec(String(readJson(join(INSTALLER, 'package.json')).engines?.node ?? ''));
if (!engines) throw new Error('The installer\'s package.json has no "engines.node" of the form ">=major.minor".');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < Number(engines[1]) || (nodeMajor === Number(engines[1]) && nodeMinor < Number(engines[2]))) {
  throw new Error(`Build with Node.js ${engines[1]}.${engines[2]} or later; the exe ships the Node.js that builds it. This is ${process.versions.node}.`);
}
if (!nodeOk(process.version, MIN_NODE)) {
  warn(`Build with Node.js ${MIN_NODE} or later: the exe ships the Node.js that builds it, and the managed apps CLI that deploys the app needs ${MIN_NODE}. This is ${process.versions.node}, so the exe's app step would stop.`);
}
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const TAR = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe');
for (const tool of [CSC, TAR]) if (!existsSync(tool)) throw new Error(`Can't find ${tool}.`);
if (!existsSync(join(INSTALLER, 'node_modules'))) throw new Error(`Run "npm ci" in ${INSTALLER} first.`);
const withApp = existsSync(join(APP, 'node_modules'));
if (!withApp) warn(`Run "npm ci" in ${APP} first. Without it the exe has no app, and its app step stops.`);

const version = String(readJson(join(INSTALLER, 'package.json')).version);
const commit = git(['rev-parse', 'HEAD']).trim();
const outDir = resolve(opts.out ?? join(INSTALLER, 'dist-exe'));
const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'vlx-'));
const appWork = join(work, dirname(APP_DIST));
const appModules = join(appWork, 'node_modules');
const stage = join(work, 'stage');
const stagedInstaller = join(stage, SOURCE_ROOT, 'installer');
const stagedCli = join(stagedInstaller, MANAGED_CLI_DIR);
let linked = false;

try {
  if (withApp) {
    step(`Building the app (installer ${version}, ${commit.slice(0, 7)})`);
    // A copy of the committed app, so none of this checkout's settings reach the build. Its
    // sample script reads the sample data from two folders above itself.
    for (const f of tracked(APP)) put(join(appWork, f.rel), f.read());
    for (const f of tracked(join(SOURCE, APP_SAMPLE_DATA))) put(join(work, APP_SAMPLE_DATA, f.rel), f.read());
    symlinkSync(join(APP, 'node_modules'), appModules, 'junction');
    linked = true;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^VITE_|^PROJECT_ROOT$/i.test(k)));
    run(process.execPath, [join('scripts', 'prepare-sample.mjs')], { cwd: appWork, env });
    run(process.execPath, [join(appModules, 'vite', 'bin', 'vite.js'), 'build'], { cwd: appWork, env: { ...env, NODE_ENV: 'production' } });
    unlinkSync(appModules);
    linked = false;
    cpSync(join(appWork, 'dist'), join(stage, SOURCE_ROOT, APP_DIST), { recursive: true });
  }

  step(`Staging the installer ${version} (${commit.slice(0, 7)})`);
  for (const f of tracked(INSTALLER)) if (installerFile(f.rel)) put(join(stagedInstaller, f.rel), f.read());
  run('npm ci --omit=dev --no-audit --no-fund', [], { cwd: stagedInstaller, shell: true });

  step('Staging the managed apps CLI, which deploys the app');
  // Its only install script checks esbuild's binary, which npm has installed for this PC.
  run('npm ci --omit=dev --no-audit --no-fund --ignore-scripts', [], { cwd: stagedCli, shell: true });

  step('Staging the notebooks, pipeline and templates');
  for (const rel of sourceFiles()) {
    const from = join(SOURCE, rel);
    if (!existsSync(from)) throw new Error(`Missing ${from}.`);
    put(join(stage, SOURCE_ROOT, rel), readFileSync(from));
  }
  const { loadSources } = await import(pathToFileURL(join(stagedInstaller, 'src', 'sources.js')).href);
  const sources = loadSources();
  if (resolve(sources.dir) !== resolve(stage, SOURCE_ROOT)) throw new Error(`The staged installer reads its templates from ${sources.dir}.`);
  if (!sources.modelFile) throw new Error('The staged installer can\'t find its modelFile.');
  if (withApp) {
    if (!sources.appDist) throw new Error('The staged installer can\'t find the app\'s build.');
    const missing = APP_SAMPLE_FILES.filter((f) => !existsSync(join(sources.appDist, f)));
    if (missing.length) throw new Error(`The app's build has no ${missing.join(', ')}, which it opens with.`);
  }
  const cli = await import(pathToFileURL(join(stagedInstaller, 'src', 'managed-app', 'cli.js')).href);
  if (resolve(cli.CLI_PACKAGE_DIR) !== resolve(stagedCli)) throw new Error(`The staged installer runs the managed apps CLI from ${cli.CLI_PACKAGE_DIR}.`);
  if (cli.installedVersion() !== cli.pinnedVersion()) {
    throw new Error(`npm installed managed apps CLI ${cli.installedVersion() ?? '(none)'}, where ${MANAGED_CLI_DIR}/package.json pins ${cli.pinnedVersion()}. Update its package-lock.json.`);
  }

  step('Adding Node.js and the licences');
  put(join(stage, 'node', 'node.exe'), readFileSync(process.execPath));
  const nodeLicense = join(dirname(process.execPath), 'LICENSE');
  if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(stage, 'node', 'LICENSE'));
  else {
    warn(`No LICENSE next to ${process.execPath}; pointing to Node.js's licence online instead.`);
    put(join(stage, 'node', 'LICENSE'), `Node.js ${process.version} is licensed under the MIT License, with the third-party licences listed at\nhttps://github.com/nodejs/node/blob/${process.version}/LICENSE\n`);
  }
  copyFileSync(join(SOURCE, 'LICENSE'), join(stage, 'LICENSE.txt'));

  step('Leaving out source maps, and sign-in binaries for other platforms');
  let pruned = 0;
  const emptied = new Set();
  for (const rel of walk(stage)) {
    if (!prunable(rel)) continue;
    rmSync(join(stage, rel));
    emptied.add(dirname(join(stage, rel)));
    pruned++;
  }
  // The zip would otherwise carry the folders those files leave empty.
  for (const dir of emptied) {
    for (let d = dir; d.length > stage.length && existsSync(d) && !readdirSync(d).length; d = dirname(d)) rmdirSync(d);
  }
  process.stdout.write(`  ${pruned} files left out\n`);
  // Prove the CLI still starts, and its sign-in broker still loads for this PC's architecture.
  run(process.execPath, [cli.cliBin(), '--version'], { cwd: stagedCli });
  const brokers = walk(stagedCli)
    .filter((rel) => /(^|\/)node_modules\/@azure\/msal-node-runtime\/package\.json$/.test(rel))
    .map((rel) => join(stagedCli, dirname(rel), 'dist', 'windows', msalRuntimeArch(), 'msal-node-runtime.node'));
  for (const addon of brokers) run(process.execPath, ['-e', `require(${JSON.stringify(addon)})`], { cwd: stagedCli });

  step('Checking the payload');
  const files = walk(stage);
  const long = tooLong(files);
  if (long.length) throw new Error(`These paths are too long to unpack and run safely (see MAX_PAYLOAD_PATH in payload.js):\n  ${long.join('\n  ')}`);
  // IDs already in the repo, such as Microsoft Graph's, are public.
  const committed = git(['grep', '-I', '-h', '-o', '-i', '-E', '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'HEAD', '--', ':/']).split('\n');
  // Install records here, this installer's or the Analytics Hub installer's, hold this computer's IDs.
  const own = readdirSync(INSTALLER).filter((f) => /^valuelens-(setup|install).*\.json$/i.test(f)).map((f) => readIf(join(INSTALLER, f)));
  const ids = localIds(own, committed.map((l) => l.replace(/^HEAD:/, '').trim()));
  for (const rel of files) {
    if (/^node\/|\/node_modules\//.test(rel)) continue;
    const leaked = leakedIds(readFileSync(join(stage, rel), 'latin1'), ids);
    if (leaked.length) throw new Error(`${rel} holds IDs from this computer's own settings: ${leaked.join(', ')}.`);
  }
  process.stdout.write(`  ${files.length} files, none from this computer's settings\n`);

  step('Packing');
  const zip = join(work, 'payload.zip');
  run(TAR, ['-a', '-c', '-f', zip, '-C', stage, 'node', SOURCE_ROOT, 'LICENSE.txt']);
  const zipHash = createHash('sha256').update(readFileSync(zip)).digest('hex');
  const id = payloadId(version, zipHash);
  writeFileSync(join(work, 'payload-id.txt'), id, 'utf8');
  for (const f of ['Launcher.cs', 'app.manifest']) copyFileSync(join(LAUNCHER, f), join(work, f));
  writeFileSync(join(work, 'AssemblyInfo.cs'), [
    'using System.Reflection;',
    `[assembly: AssemblyTitle("${PRODUCT.name} installer")]`,
    `[assembly: AssemblyDescription("Sets up ${PRODUCT.name} for Microsoft Copilot, on Microsoft Fabric or with PAX and SharePoint.")]`,
    `[assembly: AssemblyProduct("${PRODUCT.name} for Microsoft Copilot")]`,
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
  const hash = sha256File(exe);
  writeFileSync(`${exe}.sha256`, sha256Line(hash), 'utf8');
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
  process.stdout.write(`\n✓ ${exe}\n  ${mb(readFileSync(exe).length)}, payload ${id}\n  sha256 ${hash}\n`);

  // The same payload for install.ps1, which unpacks it to the same folder the exe would.
  const zipOut = join(outDir, ZIP_NAME);
  copyFileSync(zip, zipOut);
  writeFileSync(`${zipOut}.sha256`, sha256Line(zipHash, ZIP_NAME), 'utf8');
  const zipSize = readFileSync(zip).length;
  // In Azure Cloud Shell, install.ps1 gets this commit's source from the repo instead, and Node.js this version if Cloud Shell's is too old.
  const script = installScript(readFileSync(join(LAUNCHER, SCRIPT_NAME), 'utf8'), {
    version, sha256: zipHash, id, repo: opts.repo, sizeMb: zipSize / 1024 / 1024, commit, nodeVersion: process.versions.node,
  });
  writeFileSync(join(outDir, SCRIPT_NAME), script, 'ascii');
  process.stdout.write(`✓ ${zipOut}\n  ${mb(zipSize)}, sha256 ${zipHash}\n✓ ${join(outDir, SCRIPT_NAME)}, downloading from ${opts.repo}\n`);
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
