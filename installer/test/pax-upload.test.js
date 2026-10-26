// @ts-check
/** Uploading files to the PAX route's SharePoint folder, through a fake PC. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { PRODUCT } from '../src/product.js';
import { paxPaths, refreshConfig } from '../src/steps/pax/local.js';
import { describeFolder } from '../src/steps/pax/site.js';
import { paxUpload, remoteFolderPath, splitPaths } from '../src/steps/pax/upload.js';
import { fakeCtx, fakeUi } from './fakes.js';
import { failed, fakePaxHost } from './pax-fakes.js';

/** @typedef {import('node:test').TestContext} TestContext */

const NOW = '2026-06-01T12:00:00.000Z';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Analytics';
const WHERE = `Shared Documents/Copilot on ${SITE_URL}`;
const NOT_SET_UP = `${PRODUCT.name} isn't set up on this PC yet, so there's no SharePoint folder to upload to. Run install first.`;

/** What the UI printed, without colour. @param {{ text: () => string }} out */
const plain = (out) => out.text().replace(/\x1b\[[0-9;]*m/g, '');

/** A PAX install record for the Copilot folder on contoso.com's Analytics site. */
function paxConfig() {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = '11111111-2222-4333-8444-555555555555';
  config.app.appId = '0a1b2c3d-0000-4000-8000-00000000abcd';
  config.sharePoint = {
    folderUrl: `${SITE_URL}/Shared%20Documents/Copilot`,
    siteUrl: SITE_URL,
    sitePath: 'contoso.sharepoint.com:/sites/Analytics',
    library: 'Shared Documents',
    folderPath: '/Copilot',
  };
  return config;
}

/**
 * A PAX install on a fake PC, with a folder of files to upload.
 * @param {TestContext} t
 * @param {Parameters<typeof fakeUi>[0]} [ui]
 */
function setup(t, ui) {
  const pc = fakePaxHost({ now: () => new Date(NOW) });
  t.after(() => rmSync(pc.base, { recursive: true, force: true }));
  const dir = mkdtempSync(join(tmpdir(), 'valuelens-pax-upload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = fakeUi(ui);
  const config = paxConfig();
  const { ctx } = fakeCtx({ config, ui: out.ui, sources: /** @type {any} */ ({}) });
  ctx.paxHost = pc.host;
  /** Writes a file to upload. @param {string} name */
  const file = (name) => {
    const path = join(dir, name);
    writeFileSync(path, 'Date,Users\n2026-06-01,1\n');
    return path;
  };
  const refreshJson = paxPaths(pc.host).config;
  return { ctx, config, pc, out, dir, file, refreshJson };
}

test('pax upload: remoteFolderPath tidies a subfolder path', () => {
  /** @type {[string, string][]} */
  const cases = [
    ['', ''],
    ['   ', ''],
    ['/', ''],
    ['Archive', 'Archive'],
    ['Archive/2026', 'Archive/2026'],
    ['\\Archive\\2026\\', 'Archive/2026'],
    [' Archive / 2026 Q1 /', 'Archive/2026 Q1'],
    ['Archive//2026', 'Archive/2026'],
    ['Données/R&D', 'Données/R&D'],
    ['Reports.2026', 'Reports.2026'],
    // SharePoint allows # and %, and refresh.ps1 escapes them.
    ['50% done', '50% done'],
    ['Archive/#1', 'Archive/#1'],
  ];
  for (const [text, path] of cases) assert.equal(remoteFolderPath(text), path, text);
});

test("pax upload: remoteFolderPath refuses a path outside the folder, or a name SharePoint doesn't allow", () => {
  for (const text of ['.', '..', 'Archive/../..', './Archive', 'Archive\\..']) {
    assert.throws(() => remoteFolderPath(text), { message: `"${text}" isn't a subfolder of the SharePoint folder.` }, text);
  }
  /** @type {[string, string][]} */
  const cases = [
    ['Q1:Q2', 'Q1:Q2'],
    ['Archive/a*b', 'a*b'],
    ['a?b', 'a?b'],
    ['a"b', 'a"b'],
    ['a<b', 'a<b'],
    ['a>b', 'a>b'],
    ['a|b', 'a|b'],
    ['Archive/a\u0001b', 'a\u0001b'],
    ['Archive/Old.', 'Old.'],
    ['Archive/Old. /2026', 'Old.'],
  ];
  for (const [text, part] of cases) assert.throws(() => remoteFolderPath(text), { message: `"${part}" isn't a name SharePoint allows for a folder.` }, text);
});

test('pax upload: splitPaths splits on semicolons, with or without quotes', () => {
  const usage = 'C:\\Reports\\usage.csv';
  const users = 'C:\\Reports\\users.csv';
  assert.deepEqual(splitPaths(''), []);
  assert.deepEqual(splitPaths(' ; ;; '), []);
  assert.deepEqual(splitPaths('""'), []);
  assert.deepEqual(splitPaths(usage), [usage]);
  assert.deepEqual(splitPaths(`${usage};${users}`), [usage, users]);
  assert.deepEqual(splitPaths(` ${usage} ;  ${users} ;`), [usage, users]);
  assert.deepEqual(splitPaths(`"${usage}";"${users}"`), [usage, users]);
  assert.deepEqual(splitPaths(' "C:\\Copilot Reports\\usage 2026.csv" ; C:\\Reports\\users.csv'), ['C:\\Copilot Reports\\usage 2026.csv', users]);
  assert.deepEqual(splitPaths(`" ${usage} "`), [usage]);
  assert.deepEqual(splitPaths('/home/megan/usage.csv;/home/megan/users.csv'), ['/home/megan/usage.csv', '/home/megan/users.csv']);
  // Only semicolons separate paths: commas and spaces belong to the names.
  assert.deepEqual(splitPaths('C:\\Reports\\usage, final.csv'), ['C:\\Reports\\usage, final.csv']);
  assert.deepEqual(splitPaths(`${usage} ${users}`), [`${usage} ${users}`]);
  // A quote that isn't closed stays.
  assert.deepEqual(splitPaths(`"${usage}`), [`"${usage}`]);
});

test('pax upload: paxUpload needs an install on this PC', async (t) => {
  const s = setup(t);
  delete s.config.sharePoint;
  await assert.rejects(paxUpload(s.ctx, { files: [s.file('usage.csv')] }), { message: NOT_SET_UP });
  const noApp = setup(t);
  delete noApp.config.app.appId;
  await assert.rejects(paxUpload(noApp.ctx, { files: [noApp.file('usage.csv')] }), { message: NOT_SET_UP });
  for (const c of [s, noApp]) {
    assert.deepEqual(c.pc.calls, []);
    assert.equal(existsSync(c.refreshJson), false);
  }
});

test('pax upload: paxUpload uploads each file to the folder as the app', async (t) => {
  const s = setup(t);
  const usage = s.file('usage.csv');
  const users = s.file('Copilot users 2026.csv');
  assert.equal(describeFolder(/** @type {NonNullable<typeof s.config.sharePoint>} */ (s.config.sharePoint)), WHERE);
  assert.equal(await paxUpload(s.ctx, { files: [usage, users] }), true);
  assert.deepEqual(s.pc.uploads, [{ file: usage }, { file: users }]);
  for (const c of s.pc.calls.filter((c) => c.key === 'refresh upload')) assert.equal(c.args[c.args.indexOf('-Config') + 1], s.refreshJson);
  const text = plain(s.out);
  assert.ok(text.includes(`✓ Uploaded usage.csv to ${WHERE}\n`), text);
  assert.ok(text.includes(`✓ Uploaded Copilot users 2026.csv to ${WHERE}\n`), text);
  // A record copied from another PC has no refresh.json yet, so it writes one as install would.
  assert.deepEqual(JSON.parse(readFileSync(s.refreshJson, 'utf8')), JSON.parse(JSON.stringify(refreshConfig(s.config, {}))));
});

test('pax upload: paxUpload keeps the refresh.json there is, and names the record it came from', async (t) => {
  const s = setup(t);
  mkdirSync(dirname(s.refreshJson), { recursive: true });
  writeFileSync(s.refreshJson, '{"maxDays":30}\n');
  assert.equal(await paxUpload(s.ctx, { files: [s.file('usage.csv')] }), true);
  assert.equal(readFileSync(s.refreshJson, 'utf8'), '{"maxDays":30}\n');

  const other = setup(t);
  other.ctx.configFile = join(other.dir, 'contoso-setup.json');
  assert.equal(await paxUpload(other.ctx, { files: [other.file('usage.csv')] }), true);
  assert.deepEqual(JSON.parse(readFileSync(other.refreshJson, 'utf8')), JSON.parse(JSON.stringify(refreshConfig(other.config, { configFile: other.ctx.configFile }))));
});

test('pax upload: paxUpload puts the files in a subfolder when asked', async (t) => {
  const s = setup(t);
  const usage = s.file('usage.csv');
  assert.equal(await paxUpload(s.ctx, { files: [usage], remoteFolder: '\\Archive\\2026 Q1\\' }), true);
  assert.deepEqual(s.pc.uploads, [{ file: usage, remoteFolder: 'Archive/2026 Q1' }]);
  assert.ok(plain(s.out).includes(`✓ Uploaded usage.csv to ${WHERE}, in Archive/2026 Q1\n`), plain(s.out));

  const top = setup(t);
  const file = top.file('usage.csv');
  assert.equal(await paxUpload(top.ctx, { files: [file], remoteFolder: '/' }), true);
  assert.deepEqual(top.pc.uploads, [{ file }]);
  assert.ok(!plain(top.out).includes(', in '));

  const bad = setup(t);
  await assert.rejects(paxUpload(bad.ctx, { files: [bad.file('usage.csv')], remoteFolder: '../Other' }), { message: `"../Other" isn't a subfolder of the SharePoint folder.` });
  await assert.rejects(paxUpload(bad.ctx, { files: [bad.file('usage.csv')], remoteFolder: 'Q1:Q2' }), { message: `"Q1:Q2" isn't a name SharePoint allows for a folder.` });
  assert.deepEqual(bad.pc.calls, []);
  assert.equal(existsSync(bad.refreshJson), false);
});

test("pax upload: paxUpload reports a file that isn't there, and carries on with the rest", async (t) => {
  const s = setup(t);
  const usage = s.file('usage.csv');
  const gone = join(s.dir, 'missing.csv');
  assert.equal(await paxUpload(s.ctx, { files: [gone, s.dir, usage] }), false);
  assert.deepEqual(s.pc.uploads, [{ file: usage }]);
  const text = plain(s.out);
  assert.ok(text.includes(`✗ ${gone}: no such file`), text);
  assert.ok(text.includes(`✗ ${s.dir}: no such file`), text);
  assert.ok(text.includes(`✓ Uploaded usage.csv to ${WHERE}`), text);
});

test('pax upload: paxUpload reports an upload that failed, and carries on with the rest', async (t) => {
  const s = setup(t);
  const usage = s.file('usage.csv');
  const users = s.file('users.csv');
  s.pc.answer['refresh upload'] = [failed("The app can't write to the folder (403).")];
  assert.equal(await paxUpload(s.ctx, { files: [usage, users] }), false);
  assert.deepEqual(s.pc.uploads, [{ file: users }]);
  const text = plain(s.out);
  assert.match(text, /✗ .*The app can't write to the folder \(403\)\./);
  assert.ok(!text.includes('Uploaded usage.csv'), text);
  assert.ok(text.includes(`✓ Uploaded users.csv to ${WHERE}`), text);
});

test('pax upload: paxUpload finds a path relative to the current folder', async (t) => {
  const s = setup(t);
  const usage = s.file('usage.csv');
  assert.equal(await paxUpload(s.ctx, { files: [relative(process.cwd(), usage)] }), true);
  assert.deepEqual(s.pc.uploads, [{ file: usage }]);
});

test('pax upload: paxUpload asks for the files when none are named', async (t) => {
  const probe = setup(t);
  const usage = probe.file('usage.csv');
  const spaced = probe.file('Copilot users 2026.csv');
  const s = setup(t, { answers: [` "${spaced}" ; ${usage} ;`] });
  assert.equal(await paxUpload(s.ctx, { files: [] }), true);
  assert.deepEqual(s.pc.uploads, [{ file: spaced }, { file: usage }]);
  assert.deepEqual(s.out.asked, [`Which files go in ${WHERE}? Give the full path of each on this PC, separated by semicolons.`]);
  assert.ok(plain(s.out).includes('\nUpload files'), plain(s.out));
});

test('pax upload: paxUpload needs at least one file at the prompt, and names in a run without prompts', async (t) => {
  const s = setup(t, { answers: [' ; '] });
  await assert.rejects(paxUpload(s.ctx, { files: [] }), { message: /Give at least one file\.$/ });
  assert.deepEqual(s.pc.calls, []);

  const yes = setup(t, { yes: true });
  await assert.rejects(paxUpload(yes.ctx, { files: [] }), { message: 'Name the files to upload.' });
  assert.deepEqual(yes.out.asked, []);
  assert.deepEqual(yes.pc.calls, []);
});

test('pax upload: paxUpload checks the subfolder before it asks for the files, and names it in the question', async (t) => {
  const bad = setup(t, { answers: ['C:\\Reports\\usage.csv'] });
  await assert.rejects(paxUpload(bad.ctx, { files: [], remoteFolder: 'Q1:Q2' }), { message: `"Q1:Q2" isn't a name SharePoint allows for a folder.` });
  assert.deepEqual(bad.out.asked, []);
  assert.deepEqual(bad.pc.calls, []);

  const probe = setup(t);
  const usage = probe.file('usage.csv');
  const s = setup(t, { answers: [usage] });
  assert.equal(await paxUpload(s.ctx, { files: [], remoteFolder: 'Archive' }), true);
  assert.deepEqual(s.out.asked, [`Which files go in ${WHERE}, in Archive? Give the full path of each on this PC, separated by semicolons.`]);
  assert.deepEqual(s.pc.uploads, [{ file: usage, remoteFolder: 'Archive' }]);
});

test('pax upload: upload.js takes the product name from product.js, for other products to copy it', () => {
  const source = readFileSync(new URL('../src/steps/pax/upload.js', import.meta.url), 'utf8');
  const named = source.split(/\r?\n/).flatMap((line, i) => (new RegExp(PRODUCT.name, 'i').test(line) ? [`upload.js:${i + 1}: ${line.trim()}`] : []));
  assert.deepEqual(named, []);
});
