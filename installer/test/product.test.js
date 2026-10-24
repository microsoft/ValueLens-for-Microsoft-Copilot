// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../src/product.js';
import { SESSION_TAG } from '../src/transform/pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The one value `re`'s capture group finds in `src`.
 * @param {string} src
 * @param {RegExp} re
 */
function only(src, re) {
  const found = [...src.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))].map((m) => m[1]);
  assert.equal(found.length, 1, `${re} matches once`);
  return found[0];
}

/** @param {string} dir @returns {string[]} */
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test('product: the names are this installer\'s own, and fit where they go', () => {
  for (const o of [PRODUCT, PRODUCT.cloudShell, PRODUCT.env, PRODUCT.fabric, PRODUCT.pax, PRODUCT.flows]) assert.ok(Object.isFrozen(o));
  assert.match(PRODUCT.id, /^[a-z][a-z0-9]*$/);
  assert.equal(PRODUCT.command, `${PRODUCT.id}-installer`);
  assert.equal(PRODUCT.recordFile, `${PRODUCT.id}-setup.json`);
  assert.equal(PRODUCT.tagPrefix, `${PRODUCT.command}-v`);
  assert.equal(PRODUCT.exe, `${PRODUCT.name}Installer.exe`);
  assert.equal(PRODUCT.zip, `${PRODUCT.name}Installer.zip`);
  assert.equal(PRODUCT.userAgent, `${PRODUCT.name}Installer`);
  assert.equal(PRODUCT.shim, `${PRODUCT.id}.cmd`);
  assert.equal(PRODUCT.installer, `${PRODUCT.name} installer`);
  assert.equal(PRODUCT.marker, `Set by the ${PRODUCT.installer}`);
  assert.equal(PRODUCT.docs, `https://github.com/${PRODUCT.repo}/blob/main/docs/INSTALL.md`);
  // The Analytics Hub installer owns these, and this repo's own releases up to installer-v0.4.2 used bare tags.
  assert.notEqual(PRODUCT.command, 'valuelens-install');
  assert.notEqual(PRODUCT.recordFile, 'valuelens-install.json');
  assert.ok(!PRODUCT.tagPrefix.startsWith('installer-v'));
  for (const name of Object.values(PRODUCT.env)) assert.match(name, new RegExp(`^${PRODUCT.id.toUpperCase()}_[A-Z_]+$`));
  // Fabric takes letters, digits and underscores in Lakehouse names and session tags.
  assert.match(PRODUCT.fabric.lakehouse, /^[A-Za-z]\w*$/);
  assert.match(SESSION_TAG, /^\w+$/);
  assert.ok(PRODUCT.fabric.pipeline.startsWith(PRODUCT.fabric.notebookPrefix));
  // Task Scheduler, Credential Manager and Entra mail nickname rules.
  assert.doesNotMatch(PRODUCT.pax.task, /[\\/:*?"<>|]/);
  assert.match(PRODUCT.pax.credentialPrefix, /^PAX-\w+-$/);
  assert.match(PRODUCT.viewerGroupNickname, /^[a-z0-9-]+$/);
});

test('product: the page, the launcher, install.ps1, the signing pipeline and package.json keep the same names', () => {
  const app = read('src/web/app.js');
  assert.equal(only(app, /^const PRODUCT_NAME = '([^']*)';$/m), PRODUCT.name);
  assert.equal(only(app, /^const PRODUCT_ID = '([^']*)';$/m), PRODUCT.id);
  assert.equal(only(app, /^const PRODUCT_COMMAND = '([^']*)';$/m), PRODUCT.command);
  assert.equal(only(read('src/web/index.html'), /<title>([^<]*)<\/title>/), PRODUCT.installer);

  const cs = read('packaging/launcher/Launcher.cs');
  const constant = (/** @type {string} */ name) => only(cs, new RegExp(`private const string ${name} = "([^"]*)";`));
  assert.equal(constant('HomeFolder'), PRODUCT.home);
  assert.equal(constant('WorkFolder'), PRODUCT.workFolder);
  assert.equal(constant('Title'), PRODUCT.installer);
  assert.equal(constant('Script'), `${PRODUCT.command}.js`);
  assert.equal(constant('ExeEnv'), PRODUCT.env.exe);
  assert.equal(constant('Docs'), PRODUCT.docs);
  assert.equal(only(read('packaging/launcher/app.manifest'), /<assemblyIdentity [^>]*name="([^"]*)"/), PRODUCT.userAgent);

  const ps1 = read('packaging/launcher/install.ps1');
  const env = PRODUCT.env;
  assert.deepEqual(
    [...new Set(ps1.match(new RegExp(`\\b${PRODUCT.id.toUpperCase()}_[A-Z_]+\\b`, 'g')))].sort(),
    [env.cloudShell, env.installedNode, env.launcher, env.proxy, env.zip].sort(),
  );
  for (const want of [
    `Join-Path $HOME '${PRODUCT.cloudShell.home}'`,
    `Join-Path $VlHome '${PRODUCT.cloudShell.shim}'`,
    `Join-Path $HOME '${PRODUCT.cloudShell.work}'`,
    `Join-Path $env:LOCALAPPDATA '${PRODUCT.home}'`,
    `Join-Path $VlHome '${PRODUCT.shim}'`,
    `Join-Path $Docs '${PRODUCT.workFolder}'`,
    `$PaxName = '${PRODUCT.pax.folder}'`,
    `installer/bin/${PRODUCT.command}.js`,
    `installer\\bin\\${PRODUCT.command}.js`,
  ]) assert.ok(ps1.includes(want), want);
  assert.deepEqual(new Set(ps1.match(/[\w-]*installer-v/g)), new Set([PRODUCT.tagPrefix]));
  assert.deepEqual(new Set(ps1.match(/\w+Installer\.(exe|zip)/g)), new Set([PRODUCT.zip]));

  const yml = read('packaging/sign-installer.azure-pipelines.yml');
  assert.ok(yml.includes(`-notmatch '^${PRODUCT.tagPrefix}\\d+\\.\\d+\\.\\d+'`), 'checks the tag');
  assert.ok(yml.includes(`-replace '^${PRODUCT.tagPrefix}', ''`), 'takes the version from the tag');
  assert.deepEqual(new Set(yml.match(/[\w-]*installer-v/g)), new Set([PRODUCT.tagPrefix]));
  assert.deepEqual(new Set(yml.match(/\w+Installer\.(exe|zip)/g)), new Set([PRODUCT.exe, PRODUCT.zip]));

  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const bin = { [PRODUCT.command]: `bin/${PRODUCT.command}.js` };
  assert.equal(pkg.name, PRODUCT.command);
  assert.deepEqual(pkg.bin, bin);
  assert.ok(existsSync(join(ROOT, bin[PRODUCT.command])));
  assert.equal(pkg.scripts.start, `node ${bin[PRODUCT.command]}`);
  assert.equal(lock.name, PRODUCT.command);
  assert.equal(lock.packages[''].name, PRODUCT.command);
  assert.deepEqual(lock.packages[''].bin, bin);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

/** Analytics Hub's names: its product, environment variables, shim variables, command, record and release tags. */
const AH_NAMES = [/analytics[ _-]?hub/i, /\bAH_[A-Z_]+\b/, /\bAhHome\b/, /\bvaluelens-install(?!er)/, /(?<![\w-])installer-v/];

/** Lines that may still name Analytics Hub: what this installer shares with it, and what it says about its installs. */
const MAY_NAME_AH = [
  /Files\/analytics_hub_(uploads|access)\b/, // folders the notebooks it shares with Analytics Hub read
  /\bdbo\.analytics_hub_upload_log\b/, // the table its upload router writes
  /'AnalyticsHub_\w+\.ipynb'/, // the source files of notebooks this installer deploys as ValueLens_*
  /\/\^AnalyticsHub_\/i\.test\(/, // recognising an Analytics Hub install
  /\bAnalytics Hub install(er|s)?\b/, // refusing one
  /\bAH_(CONFIG_FILE|RELEASES)\b/,
  /^valuelens-install\*\.json$/, // .gitignore keeps its records out of the repo
];

test('product: no Analytics Hub names are left in the installer, except what it shares with Analytics Hub or says about it', () => {
  const files = ['package.json', '.gitignore', ...['src', 'packaging', 'bin'].flatMap((d) => walk(join(ROOT, d)).map((f) => relative(ROOT, f)))];
  assert.ok(files.length > 40, 'scanned the installer');
  /** @type {string[]} */
  const left = [];
  for (const file of files) {
    const hashComments = /\.(ps1|yml)$|\.gitignore$/.test(file);
    read(file).split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (/^(\/\/|\/?\*)/.test(line) || (hashComments && line.startsWith('#'))) return;
      if (AH_NAMES.some((re) => re.test(line)) && !MAY_NAME_AH.some((re) => re.test(line))) left.push(`${file.replace(/\\/g, '/')}:${i + 1}: ${line}`);
    });
  }
  assert.deepEqual(left, []);
});
