// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { CURRENCIES, currencySymbol, describeReporting, normaliseReporting, parseRate, toCurrencyCode } from '../src/currency.js';
import { fabricConfigFile } from '../src/steps/app.js';
import { azureDeployment } from '../src/steps/azure/index.js';
import { askReportingCurrency } from '../src/steps/plan.js';
import { buildModel, CURRENCY_SYMBOL_MEASURE, loadTemplateModel } from '../src/transform/model.js';
import { fakeCtx, fakeUi, realSources } from './fakes.js';

const template = loadTemplateModel(/** @type {string} */ (realSources().modelFile));
const lake = { server: 's', database: 'd', modules: { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false } };
/** @param {import('../src/transform/model.js').ModelBim} bim */
const symbolOf = (bim) => bim.model.tables.flatMap((t) => t.measures ?? []).find((m) => m.name === CURRENCY_SYMBOL_MEASURE)?.expression;

test('currency: codes, symbols and typed rates', () => {
  assert.equal(CURRENCIES[0].code, 'USD');
  assert.equal(toCurrencyCode(' gbp '), 'GBP');
  assert.equal(toCurrencyCode('XYZ'), undefined);
  assert.equal(currencySymbol('GBP'), '£');
  assert.equal(currencySymbol('CHF'), 'CHF');
  assert.equal(parseRate(''), undefined);
  assert.equal(parseRate(' 0.79 '), 0.79);
  assert.match(String(parseRate('0')), /above 0/);
  assert.match(String(parseRate('abc')), /above 0/);
  assert.match(String(parseRate('200000')), /up to/);
});

test('currency: a saved choice is cleaned; USD never keeps a rate', () => {
  assert.deepEqual(normaliseReporting({ currency: 'eur', exchangeRate: 0.9 }), { currency: 'EUR', exchangeRate: 0.9 });
  assert.deepEqual(normaliseReporting({ currency: 'USD', exchangeRate: 2 }), { currency: 'USD' });
  assert.deepEqual(normaliseReporting({ currency: 'GBP', exchangeRate: -1 }), { currency: 'GBP' });
  assert.equal(normaliseReporting({ currency: 'XYZ' }), undefined);
  assert.equal(normaliseReporting(undefined), undefined);
});

test('currency: the install record keeps the choice and older records have none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-currency-'));
  try {
    const file = join(dir, 'valuelens-install.json');
    writeFileSync(file, JSON.stringify({ version: 1, reporting: { currency: 'gbp', exchangeRate: 0.79 } }));
    assert.deepEqual(loadConfig(file).config.reporting, { currency: 'GBP', exchangeRate: 0.79 });
    writeFileSync(file, JSON.stringify({ version: 1 }));
    assert.equal('reporting' in loadConfig(file).config, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('currency: the prompt defaults to US dollars and asks no rate for them', async () => {
  const { ui, asked } = fakeUi();
  const { ctx, config } = fakeCtx({ ui });
  await askReportingCurrency(ctx);
  assert.deepEqual(config.reporting, { currency: 'USD' });
  assert.equal(asked.length, 1);
});

test('currency: another currency takes an optional rate', async () => {
  const typed = fakeCtx({ ui: fakeUi({ answers: ['EUR', '0.92'] }).ui });
  await askReportingCurrency(typed.ctx);
  assert.deepEqual(typed.config.reporting, { currency: 'EUR', exchangeRate: 0.92 });

  const blank = fakeCtx({ ui: fakeUi({ answers: ['GBP', ''] }).ui });
  await askReportingCurrency(blank.ctx);
  assert.deepEqual(blank.config.reporting, { currency: 'GBP' });

  const bad = fakeCtx({ ui: fakeUi({ answers: ['GBP', '-3'] }).ui });
  await assert.rejects(askReportingCurrency(bad.ctx), /above 0/);
});

test('currency: a re-run offers the saved currency and rate', async () => {
  const { ctx, config } = fakeCtx();
  config.reporting = { currency: 'GBP', exchangeRate: 0.79 };
  await askReportingCurrency(ctx);
  assert.deepEqual(config.reporting, { currency: 'GBP', exchangeRate: 0.79 });
});

test('currency: the model shows the reporting currency symbol; the template keeps its own', () => {
  const before = symbolOf(template);
  assert.ok(before, 'the template has a currency symbol measure');
  assert.equal(symbolOf(buildModel(template, lake)), before);
  assert.equal(symbolOf(buildModel(template, { ...lake, currency: 'USD' })), '"$"');
  assert.equal(symbolOf(buildModel(template, { ...lake, currency: 'GBP' })), '"£"');
  assert.equal(symbolOf(buildModel(template, { ...lake, currency: 'CHF' })), '"CHF"');
  assert.equal(symbolOf(template), before);
});

test('currency: the Fabric app config carries the choice', () => {
  const { config } = fakeCtx();
  config.semanticModel.id = 'm';
  assert.equal('reporting' in fabricConfigFile(config, 'ws', ['vl']), false);
  config.reporting = { currency: 'EUR', exchangeRate: 0.92 };
  assert.deepEqual(fabricConfigFile(config, 'ws', ['vl']).reporting, { currency: 'EUR', exchangeRate: 0.92 });
});

test('currency: the Azure deployment passes the choice to the web app', async () => {
  const { ctx, config } = fakeCtx();
  config.target = 'azure';
  config.azure = { subscriptionId: 'sub', resourceGroup: 'rg', location: 'uksouth', namePrefix: 'vlens', installId: 'id', tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] } };
  let params = (await azureDeployment(ctx, { pass: 1 })).properties.parameters;
  assert.equal(params.reportingCurrency.value, 'USD');
  assert.equal(params.exchangeRate.value, '');
  config.reporting = { currency: 'GBP', exchangeRate: 0.79 };
  params = (await azureDeployment(ctx, { pass: 1 })).properties.parameters;
  assert.equal(params.reportingCurrency.value, 'GBP');
  assert.equal(params.exchangeRate.value, '0.79');
});

test('currency: the plan review says which currency the Value page uses', () => {
  assert.equal(describeReporting(undefined), 'The Value page reports in US dollars.');
  assert.equal(describeReporting({ currency: 'USD' }), 'The Value page reports in US dollars.');
  assert.equal(describeReporting({ currency: 'EUR', exchangeRate: 0.92 }), 'The Value page reports in EUR, at 0.92 to $1.');
  assert.match(describeReporting({ currency: 'GBP' }), /GBP; set its rate under Prices/);
});
