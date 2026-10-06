// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { notebooksFor } from '../src/catalog.js';
import { applyDataFlags, parseCli } from '../src/cli.js';
import { emptyConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { checkStaged, clearStaged, inspectFile, sizeOk, stageUpload } from '../src/staging.js';
import { checkCsvFiles, ensureUploads, feedbackFlow, planDataSources, uploadCommand, uploadFiles } from '../src/steps/data-sources.js';
import { buildPipeline, UPLOAD_ROUTER_ACTIVITY } from '../src/transform/pipeline.js';
import {
  DATA_SOURCES,
  decodeStart,
  defaultDataSources,
  detectSource,
  MAX_UPLOAD_BYTES,
  modulesFromSources,
  normaliseDataSources,
  parseCsvHeader,
  parseDataFlags,
  parseModes,
  routedSources,
  routerSignaturesJson,
  routerWanted,
  sourceCards,
  UPLOAD_DIR,
  UPLOAD_KINDS,
  uploadName,
} from '../src/uploads.js';
import { createWebUi } from '../src/web-ui.js';
import { describeRecord, WEB_COMMANDS } from '../src/web-session.js';
import { fakeCtx, fakeUi } from './fakes.js';

/** Header rows as each export has them (made-up values, never a real tenant's). */
const HEADERS = {
  productFeedback: 'Feedback Id,Date submitted (UTC),Feedback type,App,Feedback,Email',
  agent365: 'Agent name,Title ID,Publisher type,Availability,Created by',
  studioTenant: 'Billing plan id,Environment id,Capacity type,Prepaid consumed quantity,Usage date',
  studioAgent: 'Agent id,Agent name,Billed credit,Non billed credit,Channel',
  studioUser: 'User id,User email,Credits used,Billable credit used',
  vivaCredits: 'ServiceId,ServiceName,SpendingPolicyId,MetricDate,TotalCopilotCreditsUsed',
  vivaPolicy: 'SpendingPolicyId,Name,PlanLimit,UserLimit,IncludedServices',
  workday: 'Primary Work Email,Cost Center,Level',
};

const tmp = mkdtempSync(join(tmpdir(), 'ah-uploads-test-'));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearStaged();
});

/** @param {string} name @param {string} text */
function csvFile(name, text) {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}

/** Every uploadable source set to Upload CSV. */
function allCsv() {
  const ds = defaultDataSources();
  for (const s of DATA_SOURCES) if (s.modes.includes('csv')) ds[s.id] = 'csv';
  return ds;
}

test('detectSource: each export is recognised by its headers', () => {
  for (const [kind, line] of Object.entries(HEADERS)) {
    const d = detectSource(parseCsvHeader(line));
    assert.ok(d.ok, `${kind}: ${!d.ok && d.reason}`);
    assert.equal(d.kind.kind, kind);
  }
  assert.equal(UPLOAD_KINDS.length, Object.keys(HEADERS).length, 'every kind has a sample here');
});

test('detectSource: no header, an unknown file, a tie and a skipped source are refused', () => {
  const none = detectSource([]);
  assert.ok(!none.ok && /no header/.test(none.reason));
  const other = detectSource(['Name', 'Colour']);
  assert.ok(!other.ok && /doesn't look like any export/.test(other.reason));
  const both = detectSource(parseCsvHeader(`${HEADERS.productFeedback},Primary Work Email`));
  assert.ok(both.ok, 'the kind matching more groups wins');
  assert.equal(both.source, 'productFeedback');
  const tie = detectSource(parseCsvHeader(`${HEADERS.vivaPolicy},ServiceId,ServiceName,MetricDate,TotalCopilotCreditsUsed`));
  assert.ok(!tie.ok && /more than one export/.test(tie.reason));
  const skipped = detectSource(parseCsvHeader(HEADERS.productFeedback), ['workday']);
  assert.ok(!skipped.ok && /Product feedback export, but that source is set to Skip/.test(skipped.reason));
});

test('parseCsvHeader: a BOM, quotes, embedded commas, semicolons and tabs', () => {
  assert.deepEqual(parseCsvHeader('\uFEFF"Feedback Id","Say ""hi"", then",X\r\n1,2,3'), ['Feedback Id', 'Say "hi", then', 'X']);
  assert.deepEqual(parseCsvHeader('a;b;c\n1;2;3'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvHeader('a\tb\n'), ['a', 'b']);
  assert.deepEqual(parseCsvHeader(''), []);
});

test('decodeStart: UTF-8 and UTF-16 saves from Excel', () => {
  const text = 'Primary Work Email,Level\n';
  assert.equal(decodeStart(new TextEncoder().encode(text)), text);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(decodeStart(new Uint8Array(le)), text);
  const be = Buffer.from(text, 'utf16le').swap16();
  assert.equal(decodeStart(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))), text);
});

test('uploadName: stamped, cleaned and kept a .csv', () => {
  const now = new Date('2026-06-01T12:34:56.789Z');
  assert.equal(uploadName('C:\\Users\\me\\Feedback export (1).csv', now), '20260601T123456Z_Feedback_export_1_.csv');
  assert.equal(uploadName('../.hidden', now), '20260601T123456Z_hidden.csv');
  assert.equal(uploadName('', now), '20260601T123456Z_upload.csv');
});

test('parseDataFlags: comma-separated or repeated; unknown sources and modes are errors', () => {
  assert.deepEqual(parseDataFlags(['productFeedback=csv,agent365=api', 'workday=CSV']), { productFeedback: 'csv', agent365: 'api', workday: 'csv' });
  assert.throws(() => parseDataFlags(['nope=csv']), /unknown source "nope"/);
  assert.throws(() => parseDataFlags(['productFeedback=api']), /productFeedback can be csv or skip, not "api"/);
  assert.throws(() => parseDataFlags(['core=skip']), /core can be api/);
});

test('normaliseDataSources: an old record is read from its modules; locked sources stay on', () => {
  const legacy = normaliseDataSources(undefined, { orgData: true, m365Activity: true, agent365: false, productFeedback: true, consumption: true, agentEvaluator: false }, {});
  assert.equal(legacy.m365Activity, 'api');
  assert.equal(legacy.agent365, 'skip');
  assert.equal(legacy.productFeedback, 'csv');
  assert.equal(legacy.studioCredits, 'csv');
  assert.equal(legacy.azureAi, 'skip', 'no subscription, so no Azure costs');
  const none = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false };
  assert.equal(normaliseDataSources(undefined, { ...none, consumption: true }, { azureSubscriptionId: 'sub' }).azureAi, 'api');

  const saved = normaliseDataSources({ core: 'skip', productFeedback: 'api', workday: 'csv' }, none);
  assert.equal(saved.core, 'api');
  assert.equal(saved.productFeedback, 'skip', 'a mode the source lacks falls back to its default');
  assert.equal(saved.workday, 'csv');
});

test('modulesFromSources, routedSources and routerWanted', () => {
  const ds = defaultDataSources();
  assert.equal(routerWanted(ds), false, 'nothing arrives as a CSV by default');
  assert.deepEqual(modulesFromSources(ds), { orgData: true, m365Activity: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false });
  ds.productFeedback = 'csv';
  ds.agent365 = 'api';
  assert.deepEqual(routedSources(ds), ['productFeedback', 'agent365'], 'Agent 365 on the API still takes its export');
  assert.equal(routerWanted(ds), true);
  ds.azureAi = 'api';
  assert.equal(modulesFromSources(ds).consumption, true);
  assert.deepEqual(JSON.parse(routerSignaturesJson(ds)).map((/** @type {any} */ k) => k.kind), ['productFeedback', 'agent365']);
  assert.equal(JSON.parse(routerSignaturesJson()).length, UPLOAD_KINDS.length);
});

test('sourceCards and parseModes: locked sources fixed, modes checked', () => {
  const ds = defaultDataSources();
  const cards = sourceCards(ds);
  assert.equal(cards.length, DATA_SOURCES.length);
  const fb = cards.find((card) => card.id === 'productFeedback');
  assert.ok(fb?.uploadable && fb.export && /Health > Product feedback/.test(fb.export.where));
  assert.equal(cards.find((card) => card.id === 'core')?.locked, true);
  assert.equal(cards.find((card) => card.id === 'm365Activity')?.uploadable, false);

  const ok = parseModes({ productFeedback: 'csv', core: 'api' }, ds);
  assert.ok('modes' in ok && ok.modes.productFeedback === 'csv');
  assert.match(String(/** @type {any} */ (parseModes({ core: 'skip' }, ds)).error), /can't be changed/);
  assert.match(String(/** @type {any} */ (parseModes({ productFeedback: 'api' }, ds)).error), /Upload CSV or Skip/);
  assert.match(String(/** @type {any} */ (parseModes(null, ds)).error), /Choose how/);
});

test('staging: a file on disk or from the page is recognised against the chosen sources', () => {
  const modes = allCsv();
  const good = inspectFile(csvFile('feedback.csv', `${HEADERS.productFeedback}\n1,2,3,4,5,6\n`), modes);
  assert.ok(good.ok && good.file.source === 'productFeedback' && good.file.kind === 'productFeedback');
  assert.ok(inspectFile(`"${join(tmp, 'feedback.csv')}"`, modes).ok, 'quotes from a pasted path are dropped');
  assert.match(String(/** @type {any} */ (inspectFile(join(tmp, 'missing.csv'), modes)).error), /no file/);
  assert.match(String(/** @type {any} */ (inspectFile(tmp, modes)).error), /is a folder/);
  assert.match(String(/** @type {any} */ (inspectFile(csvFile('x.txt', HEADERS.workday), modes)).error), /isn't a .csv/);
  assert.match(String(/** @type {any} */ (inspectFile(csvFile('empty.csv', ''), modes)).error), /empty/);
  const skip = defaultDataSources();
  assert.match(String(/** @type {any} */ (inspectFile(join(tmp, 'feedback.csv'), skip)).error), /set to Skip/);
  assert.throws(() => checkCsvFiles([join(tmp, 'feedback.csv')], skip), /^Error: --csv: feedback.csv: /);

  assert.equal(sizeOk(1), true);
  assert.match(String(sizeOk(MAX_UPLOAD_BYTES + 1)), /OneLake File Explorer/);

  const staged = stageUpload('..\\dir\\Agents.csv', new TextEncoder().encode(`${HEADERS.agent365}\nA,1,x,y,z\n`));
  assert.equal(staged.name, 'Agents.csv');
  assert.equal(staged.source, 'agent365');
  const back = checkStaged(staged.token, modes);
  assert.ok(back.ok && back.file.token === staged.token);
  assert.equal(readFileSync(back.file.path, 'utf8').split('\n')[0], HEADERS.agent365);
  assert.match(String(/** @type {any} */ (checkStaged('nope', modes)).error), /no longer here/);
  const odd = stageUpload('odd.csv', new TextEncoder().encode('Name,Colour\n'));
  assert.match(String(odd.error), /doesn't look like any export/);
});

/** A Lakehouse whose files are kept in memory. */
function fakeOneLake(fail = /** @type {RegExp | undefined} */ (undefined)) {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** @type {string[]} */
  const dirs = [];
  return {
    files,
    dirs,
    async createDirectory(/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path) {
      dirs.push(path);
      return true;
    },
    async writeFile(/** @type {string} */ _ws, /** @type {string} */ _lh, /** @type {string} */ path, /** @type {Uint8Array} */ data) {
      if (fail?.test(path)) throw new Error('403 Forbidden');
      files.set(path, data);
    },
  };
}

test('uploadFiles: each export goes to the drop folder; one that fails is reported and the rest still go', async () => {
  const oneLake = fakeOneLake(/broken/);
  const { ui, text } = fakeUi();
  const { ctx } = fakeCtx({ ui, oneLake });
  const modes = allCsv();
  const files = checkCsvFiles([csvFile('broken.csv', HEADERS.workday), csvFile('feedback.csv', HEADERS.productFeedback)], modes);
  assert.equal(await uploadFiles(ctx, files), 1);
  assert.deepEqual([...oneLake.files.keys()], [`${UPLOAD_DIR}/20260601T120000Z_feedback.csv`]);
  assert.match(text(), /Couldn't upload broken.csv: 403 Forbidden/);
  assert.match(text(), /Uploaded feedback.csv \(Product feedback\)/);
});

test('planDataSources sets the modules and keeps the exports; ensureUploads makes the folders and uploads them', async () => {
  const oneLake = fakeOneLake();
  const modes = { ...defaultDataSources(), productFeedback: 'csv', agentEvaluator: 'api' };
  const { ui } = fakeUi({ answers: [{ modes, files: [] }, true] });
  const { ctx, config } = fakeCtx({ ui, oneLake });
  ctx.csvFiles = [csvFile('fb.csv', HEADERS.productFeedback)];
  await planDataSources(ctx);
  assert.equal(config.dataSources.productFeedback, 'csv');
  assert.equal(config.modules.productFeedback, true);
  assert.equal(config.modules.agentEvaluator, true);
  assert.equal(config.modules.agent365, false);
  assert.equal(config.uploads.feedbackFlow, true, 'the email flow question was asked and answered');
  assert.equal(ctx.pendingUploads?.length, 1);

  config.uploads.feedbackFlow = false;
  await ensureUploads(ctx);
  assert.ok(oneLake.dirs.includes(UPLOAD_DIR));
  assert.equal(oneLake.files.size, 1);
  assert.deepEqual(ctx.pendingUploads, []);
});

test('planDataSources: skipping product feedback turns off the email flow; an export for a skipped source is an error', async () => {
  const { ui } = fakeUi();
  const { ctx, config } = fakeCtx({ ui });
  config.uploads.feedbackFlow = true;
  await planDataSources(ctx);
  assert.equal(config.uploads.feedbackFlow, false);
  assert.equal(routerWanted(config.dataSources), false);

  const { ctx: ctx2 } = fakeCtx({ ui: fakeUi().ui });
  ctx2.csvFiles = [csvFile('wd.csv', HEADERS.workday)];
  await assert.rejects(planDataSources(ctx2), /--csv: wd.csv: .*set to Skip/);
});

test('feedbackFlow: the template is filled with the install and the drop folder; the secret stays out', () => {
  const template = JSON.parse(readFileSync(new URL('../../Manual setup/flows/Copilot_ProductFeedback_Email_to_OneLake.json', import.meta.url), 'utf8'));
  const flow = feedbackFlow(template, { workspaceName: 'WS', lakehouseName: 'LH', tenantId: 't', clientId: 'c' });
  const p = flow.definition.parameters;
  assert.deepEqual([p.OneLakeWorkspace.defaultValue, p.OneLakeLakehouse.defaultValue, p.TargetFolder.defaultValue, p.TenantId.defaultValue, p.ClientId.defaultValue], ['WS', 'LH', UPLOAD_DIR, 't', 'c']);
  assert.equal(p.ClientSecret.defaultValue, template.definition.parameters.ClientSecret.defaultValue);
  assert.notEqual(template.definition.parameters.TargetFolder.defaultValue, UPLOAD_DIR, 'the template itself is untouched');
});

test('uploadCommand: needs an install that loads exports; uploads, then runs when asked', async () => {
  const oneLake = fakeOneLake();
  const { ui } = fakeUi();
  const { ctx, config } = fakeCtx({ ui, oneLake });
  const runs = [];
  const runNow = async (/** @type {any} */ _c, /** @type {{ wait: boolean }} */ o) => {
    runs.push(o);
    return { ok: true };
  };
  await assert.rejects(uploadCommand(ctx, { files: [] }, runNow), /doesn't load exports/);
  config.dataSources.workday = 'csv';
  config.fabric.notebooks.uploadRouter = 'nb-router';
  await assert.rejects(uploadCommand(ctx, { files: [csvFile('fb2.csv', HEADERS.productFeedback)] }, runNow), /^Error: upload: fb2.csv: .*set to Skip/);
  assert.equal(await uploadCommand(ctx, { files: [csvFile('wd2.csv', HEADERS.workday)], run: true }, runNow), true);
  assert.equal(oneLake.files.size, 1);
  assert.deepEqual(runs, [{ wait: true }]);

  const bare = fakeCtx();
  bare.config.fabric.workspaceId = undefined;
  await assert.rejects(uploadCommand(bare.ctx, { files: [] }, runNow), /Nothing is installed/);
});

test('cli: upload takes files; --run, --data and --csv go where they belong', () => {
  const up = parseCli(['upload', 'a.csv', 'b.csv', '--run']);
  assert.deepEqual([up.command, up.files, up.run], ['upload', ['a.csv', 'b.csv'], true]);
  const install = parseCli(['--data', 'productFeedback=csv', '--csv', 'fb.csv', '--feedback-flow']);
  assert.deepEqual([install.dataSources, install.csvFiles, install.feedbackFlow], [{ productFeedback: 'csv' }, ['fb.csv'], true]);
  assert.throws(() => parseCli(['run', '--run']), /--run goes with upload/);
  assert.throws(() => parseCli(['upload', '--csv', 'x.csv']), /go with install/);
  assert.throws(() => parseCli(['--ui', '--data', 'workday=csv']), /Data sources page/);
  assert.throws(() => parseCli(['status', 'extra']), /Unexpected argument/);

  const config = emptyConfig();
  applyDataFlags(config, { dataSources: { productFeedback: 'csv', agent365: 'csv' }, feedbackFlow: true });
  assert.equal(config.dataSources.productFeedback, 'csv');
  assert.equal(config.modules.agent365, true);
  assert.equal(config.uploads.feedbackFlow, true);
});

test('web ui: the Data sources answer checks its modes and staged files', async () => {
  const ui = createWebUi();
  const cards = sourceCards(defaultDataSources());
  const asked = ui.sources('Choose', cards);
  const prompt = ui.history().find((e) => e.type === 'prompt');
  assert.equal(prompt?.kind, 'sources');
  assert.equal(prompt?.cards.length, cards.length);
  assert.match(String(ui.answer(prompt?.id, { modes: { core: 'skip' } }).error), /can't be changed/);
  assert.match(String(ui.answer(prompt?.id, { modes: {}, uploads: 'x' }).error), /uploads list/);
  assert.match(String(ui.answer(prompt?.id, { modes: {}, uploads: ['gone'] }).error), /no longer here/);
  const fb = stageUpload('fb.csv', new TextEncoder().encode(HEADERS.productFeedback));
  assert.match(String(ui.answer(prompt?.id, { modes: {}, uploads: [fb.token] }).error), /set to Skip/);
  assert.deepEqual(ui.answer(prompt?.id, { modes: { productFeedback: 'csv' }, uploads: [fb.token] }), { ok: true });
  const r = await asked;
  assert.equal(r.modes.productFeedback, 'csv');
  assert.equal(r.files[0].token, fb.token);
  assert.equal(ui.history().at(-1)?.display, '1 changed, 1 file to upload');

  const locked = ui.sources('Upload', cards.filter((card) => card.id === 'productFeedback').map((card) => ({ ...card, mode: /** @type {const} */ ('csv') })), { lockModes: true });
  const p2 = ui.history().filter((e) => e.type === 'prompt').at(-1);
  assert.match(String(ui.answer(p2?.id, { uploads: [] }).error), /at least one/);
  assert.deepEqual(ui.answer(p2?.id, { modes: { productFeedback: 'skip' }, uploads: [fb.token] }), { ok: true }, 'modes are ignored when locked');
  assert.equal((await locked).modes.productFeedback, 'csv');
});

test('web session: Upload exports is offered once an install loads exports', () => {
  assert.ok(WEB_COMMANDS.includes('upload'));
  const config = emptyConfig();
  config.fabric.workspaceId = 'ws-1';
  config.fabric.lakehouseId = 'lh-1';
  assert.equal(describeRecord(config).can.upload, false);
  config.dataSources.productFeedback = 'csv';
  assert.equal(describeRecord(config).can.upload, false, 'not until the router is deployed');
  config.fabric.notebooks.uploadRouter = 'nb-router';
  assert.equal(describeRecord(config).can.upload, true);
  config.dataSources.productFeedback = 'skip';
  assert.equal(describeRecord(config).can.upload, false);
});

test('catalog and pipeline: the router is deployed and runs first in lane 2 only when a source takes a CSV', async () => {
  const modules = { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false };
  const ds = defaultDataSources();
  assert.ok(!notebooksFor(modules, { dataSources: ds }).some((nb) => nb.key === 'uploadRouter'));
  ds.workday = 'csv';
  assert.ok(notebooksFor(modules, { dataSources: ds }).some((nb) => nb.key === 'uploadRouter'));

  const { PIPELINE_TEMPLATE } = await import('../src/sources.js');
  const template = JSON.parse(readFileSync(new URL(`../../${PIPELINE_TEMPLATE}`, import.meta.url), 'utf8'));
  const notebookIds = { auditIngester: 'a', licensedUsers: 'b', processor: 'c', dataCheck: 'd', orgData: 'e', uploadRouter: 'r' };
  const base = { workspaceId: 'ws', modules, notebookIds };
  const without = buildPipeline(template, base);
  assert.ok(!JSON.stringify(without).includes(UPLOAD_ROUTER_ACTIVITY));
  const withRouter = buildPipeline(template, { ...base, uploadRouter: true });
  const router = withRouter.properties.activities.find((/** @type {any} */ a) => a.name === UPLOAD_ROUTER_ACTIVITY);
  assert.ok(router, 'the router step is there');
  assert.equal(router.typeProperties.notebookId, 'r');
  assert.match(withRouter.properties.description, /analytics_hub_uploads/);
});

/**
 * @param {number} port
 * @param {{ path: string, headers?: Record<string, string>, body?: Uint8Array | string }} o
 * @returns {Promise<{ status: number, body: any }>}
 */
function post(port, o) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: o.path, headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

test('server: /api/upload stages a CSV for a signed-in page from the same origin', async () => {
  const ui = createWebUi();
  const server = await startServer({ ui, session: /** @type {any} */ ({ running: null, state: () => ({ installed: false }), start: () => ({ ok: true }) }), token: 'tok' });
  try {
    const port = server.port;
    const auth = { Cookie: `valuelens_${port}=tok`, Origin: `http://127.0.0.1:${port}` };
    const body = new TextEncoder().encode(`${HEADERS.productFeedback}\n1,2,3,4,5,6\n`);
    const file = { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent('My feedback.csv') };

    assert.equal((await post(port, { path: '/api/upload', headers: { ...file, Origin: auth.Origin }, body })).status, 401);
    assert.equal((await post(port, { path: '/api/upload', headers: { ...file, Cookie: auth.Cookie, Origin: 'http://evil.example' }, body })).status, 403);
    assert.equal((await post(port, { path: '/api/upload', headers: { ...auth, 'Content-Type': 'text/csv', 'x-file-name': 'a.csv' }, body })).status, 415);
    assert.equal((await post(port, { path: '/api/upload', headers: { ...auth, ...file, 'x-file-name': 'a.xlsx' }, body })).status, 422);
    assert.equal((await post(port, { path: '/api/upload', headers: { ...auth, ...file }, body: '' })).status, 422);

    const ok = await post(port, { path: '/api/upload', headers: { ...auth, ...file }, body });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.name, ok.body.source, ok.body.label], ['My feedback.csv', 'productFeedback', 'Product feedback']);
    assert.match(ok.body.token, /^[0-9a-f]{24}$/);
  } finally {
    await server.close();
  }
});
