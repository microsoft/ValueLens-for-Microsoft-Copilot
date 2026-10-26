// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUPPORT_FILES, REMOVED, SECRET_KEY, createRedactor, attachRunLog, diagnosticsFile, summariseLog,
  collectSupportBundle, createSupportBundle, supportFileName, csvRowCounts,
} from '../src/support.js';
import { listZip, readZipEntry } from '../src/transform/zip.js';
import { parseCli } from '../src/cli.js';
import { fakeUi } from './fakes.js';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJ1cG4iOiJhZGFAZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJlLXZhbHVl';
const CLIENT_SECRET = 'abc8Q~abcdefghijklmnopqrstuvwxyz0123456';
const SAS = 'https://acct.blob.core.windows.net/c?sv=2024-01-01&sig=SuperSecretSig%3D&se=2026';
const CONN = 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=QUJDREVGR0hJSktMTU5PUA==;EndpointSuffix=core.windows.net';
const TENANT = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = new Date(Date.UTC(2026, 9, 27, 8, 5, 9));

/** Every secret shape the tests plant, none of which may reach the zip. */
const SECRETS = [JWT, CLIENT_SECRET, 'SuperSecretSig', 'QUJDREVGR0hJSktMTU5PUA==', 'hunter2', 'plain-client-secret-value', 'Bearer abc.def'];
const PEOPLE = ['ada.lovelace@example.com', 'Ada Lovelace', 'grace@example.org', 'Grace Hopper'];

function tmp() {
  return mkdtempSync(join(tmpdir(), 'vl-support-'));
}

function fabricRecord() {
  return {
    target: 'fabric',
    tenantId: TENANT,
    adminEmail: 'ada.lovelace@example.com',
    signedInUser: 'Ada Lovelace',
    owner: 'Grace Hopper',
    app: { clientId: '99999999-8888-7777-6666-555555555555', clientSecret: 'plain-client-secret-value', displayName: 'ValueLens collector' },
    keyVault: { name: 'kv-valuelens', secretName: 'vl-secret' },
    fabric: { workspaceId: WORKSPACE, lakehouseId: 'bbbbbbbb-0000-0000-0000-000000000001', pipelineId: 'cccccccc-0000-0000-0000-000000000002', pipelineName: 'VL pipeline', notebooks: { collect: 'dddddddd-0000-0000-0000-000000000003' }, notebookNames: { collect: 'VL collect' } },
    semanticModel: { id: 'eeeeeeee-0000-0000-0000-000000000004', displayName: 'ValueLens model' },
    storage: { connectionString: CONN, url: SAS },
    notes: `Owner Grace Hopper (grace@example.org) shared ${JWT} and Bearer abc.def and password=hunter2 and ${CLIENT_SECRET}`,
  };
}

/** A Fabric API that answers the support file's few questions. */
function fakeApi() {
  return {
    fabric: {
      listJobs: async (/** @type {string} */ _ws, /** @type {string} */ id) => id.startsWith('cccc')
        ? [
          { id: 'job-old', status: 'Completed', startTimeUtc: '2026-10-25T00:00:00Z', endTimeUtc: '2026-10-25T00:10:00Z' },
          { id: 'job-new', status: 'Failed', startTimeUtc: '2026-10-26T00:00:00Z', endTimeUtc: '2026-10-26T00:10:00Z', failureReason: { message: `Request timed out for grace@example.org with ${JWT}`, errorCode: 'Timeout' } },
        ]
        : [{ id: 'nb-1', status: 'Failed', startTimeUtc: '2026-10-26T00:01:00Z', failureReason: { message: 'HTTP 429 Too Many Requests' } }],
      queryActivityRuns: async () => [{ activityName: 'Collect', status: 'Failed', error: { message: '401 Unauthorized', errorCode: '2011' } }],
    },
    powerBi: { refreshes: async () => [{ status: 'Failed', refreshType: 'Scheduled', serviceExceptionJson: '{"errorCode":"ModelRefreshFailed"}' }] },
    oneLake: { readJson: async () => ({ tables: { licensed: { rows: 120 }, audit: { rows: 0 }, org: { rows: 300 } } }) },
  };
}

/** @param {{ name: string, text: string }[]} files */
const all = (files) => files.map((f) => f.text).join('\n');
/** @param {{ name: string, text: string }[]} files @param {string} name */
const json = (files, name) => JSON.parse(/** @type {any} */ (files.find((f) => f.name === name)).text);

test('the redactor removes secret keys but keeps keyVault and GUIDs', () => {
  const r = createRedactor({ salt: Buffer.alloc(16, 1) });
  const out = /** @type {any} */ (r.value({ clientSecret: 'x', accessToken: 'y', password: 'z', sasUrl: 'u', connectionString: 'c', authorization: 'a', apiKey: 'k', keyVault: { name: 'kv-1' }, tenantId: TENANT, signature: 's' }));
  for (const k of ['clientSecret', 'accessToken', 'password', 'sasUrl', 'connectionString', 'authorization', 'apiKey', 'signature']) assert.equal(out[k], REMOVED, k);
  assert.deepEqual(out.keyVault, { name: 'kv-1' });
  assert.equal(out.tenantId, TENANT);
  assert.ok(!SECRET_KEY.test('keyVault'));
  assert.ok(r.counts.secrets >= 8);
});

test('the redactor removes credential-shaped values wherever they appear', () => {
  const r = createRedactor();
  const out = r.text(`token ${JWT}; Authorization: Bearer abc.def; ${SAS}; ${CONN}; Server=x;password=hunter2; secret ${CLIENT_SECRET}`);
  for (const s of SECRETS.filter((x) => x !== 'plain-client-secret-value')) assert.ok(!out.includes(s), `leaked ${s}`);
  assert.ok(out.includes(REMOVED));
  assert.ok(out.includes('AccountName=acct'), 'keeps the parts that are not secret');
});

test('the redactor hashes people the same way throughout one file, and differently in another', () => {
  const r = createRedactor();
  const a = r.text('ada.lovelace@example.com');
  assert.match(a, /^user-[0-9a-f]{10}$/);
  assert.equal(r.text('  ADA.Lovelace@Example.com'), `  ${a}`, 'lowercased and trimmed before hashing');
  const v = /** @type {any} */ (r.value({ upn: 'ada.lovelace@example.com', displayName: 'Ada Lovelace', app: { displayName: 'ValueLens collector' } }));
  assert.equal(v.upn, a);
  assert.match(v.displayName, /^user-[0-9a-f]{10}$/);
  assert.equal(v.app.displayName, 'ValueLens collector', 'a thing\'s name is kept');
  assert.equal(r.text('Ran by Ada Lovelace today'), `Ran by ${v.displayName} today`, 'learned names are hashed in free text');
  assert.notEqual(createRedactor().text('ada.lovelace@example.com'), a, 'a fresh salt per file');
});

test('the support file holds the eight files in order, with no secret, email or name', async () => {
  const dir = tmp();
  try {
    const configFile = join(dir, 'valuelens-setup.json');
    writeFileSync(configFile, JSON.stringify(fabricRecord()));
    const ui = fakeUi().ui;
    const log = attachRunLog(ui, diagnosticsFile(configFile), { now: () => NOW });
    log.begin('install');
    log.signedIn({ upn: 'ada.lovelace@example.com', displayName: 'Ada Lovelace' });
    ui.step(1, 2, 'Sign in');
    ui.ok('Signed in as Ada Lovelace (ada.lovelace@example.com)');
    ui.step(2, 2, 'Load data');
    ui.fail(`Graph said 403 Forbidden with ${JWT}`);
    log.end(false, new Error('The load failed: request timed out'));

    const out = await createSupportBundle({ configFile, version: '1.2.3', now: NOW, live: { api: fakeApi(), user: { upn: 'ada.lovelace@example.com', displayName: 'Ada Lovelace' }, prereqs: [{ id: 'fabric', ok: true, detail: 'Grace Hopper is a Fabric admin' }] }, outDir: dir });
    assert.equal(out.fileName, 'valuelens-support-20261027-080509.zip');
    assert.match(out.fileName, /^valuelens-support-\d{8}-\d{6}\.zip$/);
    assert.ok(existsSync(out.path));

    const zip = readFileSync(out.path);
    assert.deepEqual([...listZip(zip).keys()], [...SUPPORT_FILES]);
    const text = SUPPORT_FILES.map((n) => readZipEntry(zip, n).toString('utf8')).join('\n');
    for (const s of [...SECRETS, ...PEOPLE]) assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `leaked ${s}`);
    assert.ok(text.includes(TENANT) && text.includes(WORKSPACE), 'GUIDs are kept');

    const manifest = json(out.files, 'manifest.json');
    assert.equal(manifest.product, 'valuelens');
    assert.equal(manifest.installerVersion, '1.2.3');
    assert.equal(manifest.route, 'fabric');
    assert.equal(manifest.createdAt, NOW.toISOString());
    assert.deepEqual(manifest.files.map((/** @type {any} */ f) => f.name), [...SUPPORT_FILES].filter((n) => n !== 'manifest.json'));
    assert.ok(manifest.redaction.rules.length >= 4);
    assert.ok(manifest.redaction.counts.secrets > 0 && manifest.redaction.counts.emails > 0 && manifest.redaction.counts.names > 0);

    const settings = json(out.files, 'settings.json');
    assert.equal(settings.app.clientSecret, REMOVED);
    assert.equal(settings.storage.connectionString, REMOVED);
    assert.equal(settings.keyVault.name, 'kv-valuelens');

    const last = json(out.files, 'last-run.json');
    assert.equal(last.command, 'install');
    assert.equal(last.ok, false);
    assert.deepEqual(last.failedStep, { n: 2, title: 'Load data' });
    assert.match(last.error, /request timed out/);
    assert.ok(last.steps.some((/** @type {any} */ s) => s.lines.some((/** @type {any} */ l) => l.level === 'fail')));

    assert.deepEqual(json(out.files, 'row-counts.json'), { licensed: 120, audit: 0, org: 300 });
    const runs = json(out.files, 'runs.json');
    assert.equal(runs.pipeline.runs[0].status, 'Failed');
    assert.match(runs.pipeline.runs[0].error, /timed out/);
    assert.equal(runs.pipeline.latestActivities[0].error, '401 Unauthorized');
    assert.equal(json(out.files, 'prereqs.json').live, true);

    const logs = json(out.files, 'logs-summary.json');
    assert.equal(logs['installer-last-run'].http403, 1);
    assert.ok(logs['fabric-run-errors'].http429 >= 1 && logs['fabric-run-errors'].http401 >= 1 && logs['fabric-run-errors'].timeouts >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a sign-in, live pieces say notCollected and nothing is left out', async () => {
  const dir = tmp();
  try {
    const configFile = join(dir, 'valuelens-setup.json');
    writeFileSync(configFile, JSON.stringify(fabricRecord()));
    const files = await collectSupportBundle({ configFile, version: '1.2.3', now: NOW });
    assert.deepEqual(files.map((f) => f.name), [...SUPPORT_FILES]);
    assert.match(json(files, 'row-counts.json').notCollected, /Not signed in/);
    assert.match(json(files, 'runs.json').notCollected, /Not signed in/);
    assert.ok(json(files, 'last-run.json').notCollected);
    assert.ok(json(files, 'prereqs.json').notCollected);
    assert.equal(json(files, 'manifest.json').signedIn, false);
    for (const s of [...SECRETS, ...PEOPLE]) assert.ok(!all(files).toLowerCase().includes(s.toLowerCase()), `leaked ${s}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no install record at all, every file is still there', async () => {
  const dir = tmp();
  try {
    const files = await collectSupportBundle({ configFile: join(dir, 'missing.json'), version: '1.2.3', now: NOW });
    assert.deepEqual(files.map((f) => f.name), [...SUPPORT_FILES]);
    assert.match(json(files, 'settings.json').notCollected, /No install record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the PAX route counts CSV rows and summarises the refresh logs, without any row', async () => {
  const dir = tmp();
  try {
    const root = join(dir, 'pax');
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'data', 'audit'), { recursive: true });
    writeFileSync(join(root, 'data', 'licensed.csv'), 'Upn,Licensed\nada.lovelace@example.com,true\ngrace@example.org,true\n');
    writeFileSync(join(root, 'data', 'audit', 'events.csv'), 'Upn,Event\n');
    writeFileSync(join(root, 'state.json'), JSON.stringify({ lastSuccess: '2026-10-26T00:00:00Z', lastError: 'Throttled for grace@example.org' }));
    writeFileSync(join(root, 'logs', 'refresh-1.log'), [
      '==> Window 1 of 3',
      'WARN HTTP 429 Too Many Requests, retrying',
      '==> Window 2 of 3',
      'ERROR 401 Unauthorized for ada.lovelace@example.com',
      'The operation timed out',
      '==> Window 3 of 3',
      '403 Forbidden',
    ].join('\n'));
    const configFile = join(dir, 'valuelens-setup.json');
    writeFileSync(configFile, JSON.stringify({ target: 'pax', adminEmail: 'ada.lovelace@example.com', pax: { firstRun: { ok: true } } }));
    const files = await collectSupportBundle({ configFile, version: '1.2.3', now: NOW, paxHost: { root } });
    assert.equal(json(files, 'manifest.json').route, 'pax');
    assert.deepEqual(json(files, 'row-counts.json'), { 'audit/events.csv': 0, 'licensed.csv': 2 });
    const log = json(files, 'logs-summary.json')['refresh-1.log'];
    assert.equal(log.windows, 3);
    assert.equal(log.http429, 1);
    assert.equal(log.http401, 1);
    assert.equal(log.http403, 1);
    assert.equal(log.timeouts, 1);
    assert.match(log.firstError, /^ERROR 401 Unauthorized for user-[0-9a-f]{10}$/);
    for (const s of PEOPLE) assert.ok(!all(files).includes(s), `leaked ${s}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('csvRowCounts counts lines, with or without a trailing newline', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.csv'), 'h\n1\n2');
    writeFileSync(join(dir, 'b.csv'), 'h\n');
    writeFileSync(join(dir, 'c.txt'), 'ignored');
    assert.deepEqual(csvRowCounts(dir), { 'a.csv': 2, 'b.csv': 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summariseLog redacts the first error it quotes', () => {
  const s = summariseLog(`ok\nfailed: ${JWT}\n`, createRedactor());
  assert.equal(s.firstError, `failed: ${REMOVED}`);
});

test('a successful run has no failed step', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'd.json');
    const ui = fakeUi().ui;
    const log = attachRunLog(ui, file);
    log.begin('check');
    ui.step(1, 1, 'Check');
    ui.ok('Fine');
    log.end(true);
    const d = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(d.lastRun.ok, true);
    assert.equal(d.lastRun.failedStep, null);
    assert.equal(d.lastRun.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file name is UTC', () => {
  assert.equal(supportFileName(new Date('2026-01-02T23:59:58Z')), 'valuelens-support-20260102-235958.zip');
});

test('--support-bundle runs on its own and defaults --out to this folder', () => {
  const a = parseCli(['--support-bundle']);
  assert.equal(a.supportBundle, true);
  assert.equal(a.outDir, '.');
  assert.equal(a.signInForSupport, false);
  assert.equal(parseCli(['--support-bundle', '--out', 'x', '--use-az']).outDir, 'x');
  assert.equal(parseCli(['--support-bundle', '--use-az']).signInForSupport, true);
  assert.throws(() => parseCli(['install', '--support-bundle']), /runs on its own/);
  assert.throws(() => parseCli(['--support-bundle', '--ui']), /Create a support file/);
});
