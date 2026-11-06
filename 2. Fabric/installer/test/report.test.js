// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { applyPowerBiChoice, blockedSettings, planReview, powerBiChoice, reserveNames } from '../src/steps/plan.js';
import { deployReport, ensureReports, reportsOn, reportsWanted, reportUrl } from '../src/steps/report.js';
import { PBIR_SCHEMA, pbir, readTemplateReport, reportDefinition, reportSignature } from '../src/transform/report.js';
import { fakeCtx, fakeFabric, fakeUi, httpError, realSources } from './fakes.js';

/** @param {any} item @param {string} path */
const part = (item, path) => item.content.parts.find((/** @type {any} */ p) => p.path === path);
/** @param {any} item @param {string} path */
const partJson = (item, path) => JSON.parse(Buffer.from(part(item, path).payload, 'base64').toString('utf8'));

/** @param {{ answers?: any[], config?: any, modules?: Partial<import('../src/catalog.js').ModuleChoice> }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const ui = fakeUi({ answers: o.answers });
  const config = o.config ?? emptyConfig();
  Object.assign(config.modules, o.modules);
  config.semanticModel.enabled = true;
  config.semanticModel.reports = true;
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, config });
  const model = fabric.add('SemanticModel', 'Analytics Hub Model', null);
  config.semanticModel.id = model.id;
  return { ...made, fabric, ui, model };
}

for (const key of /** @type {const} */ (['modelFile', 'consumptionModelFile', 'agentEvaluatorModelFile'])) {
  test(`the ${key} template's report is PBIR, without Desktop's copy of the AppSource visuals`, () => {
    const file = realSources()[key];
    assert.ok(file, `the checkout has ${key}`);
    const parts = readTemplateReport(readFileSync(file));
    const paths = parts.map((p) => p.path);
    assert.ok(paths.includes('definition/report.json'));
    assert.ok(paths.includes('definition/version.json'));
    assert.ok(paths.some((p) => p.startsWith('definition/pages/')));
    assert.ok(paths.every((p) => p.startsWith('definition/') || p.startsWith('StaticResources/')), paths.join(', '));
    assert.deepEqual(paths, [...paths].sort(), 'sorted, so the signature is stable');
    for (const p of parts.filter((x) => x.path.endsWith('.json'))) JSON.parse(p.data.toString('utf8'));
  });
}

test('reportDefinition binds the report to the model by id, and the signature ignores the model', () => {
  const parts = readTemplateReport(readFileSync(/** @type {string} */ (realSources().modelFile)));
  const def = reportDefinition(parts, 'model-9');
  assert.equal(def.parts[0].path, 'definition.pbir');
  assert.deepEqual(JSON.parse(Buffer.from(def.parts[0].payload, 'base64').toString('utf8')), pbir('model-9'));
  assert.equal(pbir('x').$schema, PBIR_SCHEMA);
  assert.equal(pbir('x').datasetReference.byConnection.connectionString, 'semanticmodelid=x');
  assert.ok(def.parts.every((p) => p.payloadType === 'InlineBase64'));
  assert.equal(def.parts.length, parts.length + 1);

  const sig = reportSignature(parts);
  assert.equal(sig, reportSignature(parts.map((p) => ({ ...p }))));
  const changed = parts.map((p) => (p.path === 'definition/report.json' ? { ...p, data: Buffer.concat([p.data, Buffer.from(' ')]) } : p));
  assert.notEqual(reportSignature(changed), sig);
});

test('a template without a PBIR report is an error', () => {
  assert.throws(() => readTemplateReport(readFileSync(/** @type {string} */ (realSources().modelFile)).subarray(0, 0)), /zip|central directory|file/i);
});

test('reportsWanted: off unless chosen with the model; the module reports come with their models', () => {
  const t = setup();
  assert.deepEqual(reportsWanted(t.ctx).map((w) => w.name), ['ValueLens']);

  t.config.modules.consumption = true;
  t.config.modules.agentEvaluator = true;
  t.config.agentEvaluator.environments = [{ url: 'https://org.crm.dynamics.com' }];
  assert.deepEqual(reportsWanted(t.ctx).map((w) => w.name), ['ValueLens', 'Consumption Central', 'Agent Evaluator']);
  assert.equal(reportsWanted(t.ctx)[1].model, t.config.consumption.model);

  t.config.semanticModel.reports = undefined;
  assert.equal(reportsOn(t.config), false, 'records from before the choice publish nothing');
  assert.deepEqual(reportsWanted(t.ctx), []);
  t.config.semanticModel.reports = true;
  t.config.semanticModel.enabled = false;
  assert.deepEqual(reportsWanted(t.ctx), []);
});

test('deployReport: publishes on the model, then leaves it alone', async () => {
  const t = setup();
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const item = t.fabric.items.find((i) => i.type === 'Report');
  assert.ok(item);
  assert.equal(item.displayName, 'ValueLens');
  assert.equal(partJson(item, 'definition.pbir').datasetReference.byConnection.connectionString, `semanticmodelid=${t.model.id}`);
  assert.ok(part(item, 'definition/report.json'));
  const r = t.config.semanticModel.report;
  assert.equal(r?.id, item.id);
  assert.equal(r?.modelId, t.model.id);
  assert.ok(r?.signature);
  assert.equal(t.saves(), 1);

  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls, ['createReport ValueLens']);
  assert.match(t.ui.text(), /The ValueLens report is in place/);
  assert.equal(reportUrl('ws-1', 'r-1'), 'https://app.powerbi.com/groups/ws-1/reports/r-1');
});

test('deployReport: a same-name report that is not ours is left alone', async () => {
  const t = setup();
  const theirs = t.fabric.add('Report', 'ValueLens', 'theirs');
  await deployReport(t.ctx, reportsWanted(t.ctx)[0]);
  assert.equal(theirs.content, 'theirs');
  assert.equal(t.config.semanticModel.report?.name, 'ValueLens_2');
  assert.deepEqual(t.fabric.calls, ['createReport ValueLens_2']);
});

test('deployReport: a new template asks before replacing edits; no keeps them', async () => {
  const t = setup({ answers: [false, true] });
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const r = /** @type {import('../src/config.js').ReportConfig} */ (t.config.semanticModel.report);
  const published = r.signature;

  r.signature = 'older';
  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls, ['createReport ValueLens']);
  assert.equal(r.signature, 'older', 'still out of date, so the next update asks again');
  assert.match(t.ui.text(), /Save a copy/);
  assert.match(t.ui.asked.join('\n'), /new version of the ValueLens report/);

  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateReport ValueLens']);
  assert.equal(r.signature, published);
});

test('deployReport: a redeployed model is picked up without asking; a deleted report is published again', async () => {
  const t = setup();
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const r = /** @type {import('../src/config.js').ReportConfig} */ (t.config.semanticModel.report);

  const model = t.fabric.add('SemanticModel', 'Analytics Hub Model 2', null);
  t.config.semanticModel.id = model.id;
  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateReport ValueLens']);
  assert.equal(r.modelId, model.id);
  const item = t.fabric.items.find((i) => i.id === r.id);
  assert.equal(partJson(item, 'definition.pbir').datasetReference.byConnection.connectionString, `semanticmodelid=${model.id}`);
  assert.equal(t.ui.asked.length, 0);

  t.fabric.items.splice(t.fabric.items.indexOf(/** @type {any} */ (item)), 1);
  await deployReport(t.ctx, w);
  assert.match(t.ui.text(), /The ValueLens report was deleted/);
  assert.deepEqual(t.fabric.calls.slice(2), ['createReport ValueLens']);
  assert.notEqual(r.id, item?.id);
});

test('ensureReports: one failure is reported and the rest still publish', async () => {
  const t = setup({ modules: { consumption: true } });
  const cm = t.fabric.add('SemanticModel', 'Analytics Hub Consumption Model', null);
  t.config.consumption.model.id = cm.id;
  t.fabric.failures.createReport = [httpError(400, 'The definition is not valid.')];
  await ensureReports(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createReport ValueLens', 'createReport Consumption Central']);
  assert.match(t.ui.text(), /The ValueLens report wasn't published: .*not valid/);
  assert.match(t.ui.text(), /then run ".*update"/);
  assert.ok(t.config.consumption.model.report?.id);
  assert.equal(t.config.semanticModel.report?.id, undefined);
});

test('ensureReports: a model that is not deployed is skipped', async () => {
  const t = setup({ modules: { consumption: true } });
  await ensureReports(t.ctx);
  assert.deepEqual(t.fabric.calls, ['createReport ValueLens']);
  assert.match(t.ui.text(), /Skipped the Consumption Central report/);
});

test('plan: report names are reserved and listed for review', async () => {
  const t = setup();
  t.fabric.add('Report', 'ValueLens', null);
  await reserveNames(t.ctx);
  assert.equal(t.config.semanticModel.report?.name, 'ValueLens_2');
  const review = planReview(t.ctx);
  assert.deepEqual(
    review.creates.filter((i) => i.kind === 'Report').map((i) => [i.name, i.isNew]),
    [['ValueLens_2', true]],
  );
  assert.match(review.runsOn[0].what, /reports/);
});

test('blockedSettings: the Power BI SDK visuals setting matters only with the reports', () => {
  const settings = { CustomVisualsTenant: { enabled: false }, AppBackendTenant: { enabled: false } };
  assert.deepEqual(blockedSettings(settings, { app: false }), []);
  assert.deepEqual(blockedSettings(settings, { app: false, reports: true }).map((s) => s.name), ['CustomVisualsTenant']);
  assert.deepEqual(blockedSettings({ CustomVisualsTenant: { enabled: false, delegateToCapacity: true } }, { app: true, reports: true }), []);
});

test('the Power BI choice: reports are offered by default, even to older installs, and each choice sets the record', () => {
  const config = emptyConfig();
  assert.equal(powerBiChoice(config, true), 'all');
  assert.equal(powerBiChoice(config, false), 'reports');
  config.semanticModel.enabled = true;
  config.fabricApp.enabled = true;
  assert.equal(powerBiChoice(config, true), 'all', 'an install from before the choice gets the reports offered');
  config.semanticModel.reports = false;
  assert.equal(powerBiChoice(config, true), 'both');
  config.fabricApp.enabled = false;
  assert.equal(powerBiChoice(config, true), 'model');
  config.semanticModel.enabled = false;
  assert.equal(powerBiChoice(config, true), 'none');

  for (const [choice, model, reports, app] of /** @type {const} */ ([
    ['all', true, true, true],
    ['reports', true, true, false],
    ['both', true, false, true],
    ['model', true, false, false],
    ['none', false, false, false],
  ])) {
    applyPowerBiChoice(config, choice);
    assert.deepEqual([config.semanticModel.enabled, config.semanticModel.reports, config.fabricApp.enabled], [model, reports, app], choice);
    assert.equal(powerBiChoice(config, true), choice);
  }
});