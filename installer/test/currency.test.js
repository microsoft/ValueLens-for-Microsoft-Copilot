// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyDataFlags, parseCli } from '../src/cli.js';
import { emptyConfig, loadConfig } from '../src/config.js';
import { CURRENCIES, currencySymbol, describeReporting, normaliseReporting, toCurrencyCode } from '../src/currency.js';
import { askReportingCurrency } from '../src/steps/plan.js';
import { buildModel, CURRENCY_SYMBOL_MEASURE, loadTemplateModel } from '../src/transform/model.js';
import { fakeCtx, fakeUi, realSources } from './fakes.js';

const template = loadTemplateModel(/** @type {string} */ (realSources().modelFile));
const lake = { server: 's', database: 'd', modules: { orgData: true, m365Activity: false, agent365: false, productFeedback: false } };
/** @param {import('../src/transform/model.js').ModelBim} bim */
const symbolOf = (bim) => bim.model.tables.flatMap((t) => t.measures ?? []).find((m) => m.name === CURRENCY_SYMBOL_MEASURE)?.expression;

test('currency: codes and symbols', () => {
  assert.equal(CURRENCIES[0].code, 'USD');
  assert.equal(toCurrencyCode(' gbp '), 'GBP');
  assert.equal(toCurrencyCode('XYZ'), undefined);
  assert.equal(currencySymbol('GBP'), '£');
  assert.equal(currencySymbol('CHF'), 'CHF');
});

test('currency: a saved choice is cleaned; a rate an older record kept is dropped', () => {
  assert.deepEqual(normaliseReporting({ currency: 'eur', exchangeRate: 0.9 }), { currency: 'EUR' });
  assert.deepEqual(normaliseReporting({ currency: 'USD', exchangeRate: 2 }), { currency: 'USD' });
  assert.deepEqual(normaliseReporting({ currency: 'GBP' }), { currency: 'GBP' });
  assert.equal(normaliseReporting({ currency: 'XYZ' }), undefined);
  assert.equal(normaliseReporting(undefined), undefined);
});

test('currency: the install record keeps the choice and older records have none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vl-currency-'));
  try {
    const file = join(dir, 'valuelens-setup.json');
    writeFileSync(file, JSON.stringify({ product: 'valuelens', version: 1, reporting: { currency: 'gbp', exchangeRate: 0.79 } }));
    assert.deepEqual(loadConfig(file).config.reporting, { currency: 'GBP' });
    writeFileSync(file, JSON.stringify({ product: 'valuelens', version: 1 }));
    assert.equal('reporting' in loadConfig(file).config, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('currency: the prompt defaults to US dollars and asks no rate', async () => {
  const { ui, asked } = fakeUi();
  const { ctx, config } = fakeCtx({ ui });
  await askReportingCurrency(ctx);
  assert.deepEqual(config.reporting, { currency: 'USD' });
  assert.equal(asked.length, 1);
});

test('currency: another currency is one question too', async () => {
  const { ui, asked } = fakeUi({ answers: ['EUR'] });
  const { ctx, config } = fakeCtx({ ui });
  await askReportingCurrency(ctx);
  assert.deepEqual(config.reporting, { currency: 'EUR' });
  assert.equal(asked.length, 1);
});

test('currency: a re-run offers the saved currency', async () => {
  const { ctx, config } = fakeCtx();
  config.reporting = { currency: 'GBP' };
  await askReportingCurrency(ctx);
  assert.deepEqual(config.reporting, { currency: 'GBP' });
});

test('currency: --currency sets it without a question', () => {
  const args = parseCli(['install', '--currency', 'gbp']);
  assert.equal(args.currency, 'GBP');
  const config = emptyConfig();
  applyDataFlags(config, { ...args, dataSources: {} });
  assert.deepEqual(config.reporting, { currency: 'GBP' });

  applyDataFlags(config, { dataSources: {}, currency: 'EUR' });
  assert.deepEqual(config.reporting, { currency: 'EUR' });
  applyDataFlags(config, { dataSources: {}, currency: 'USD' });
  assert.deepEqual(config.reporting, { currency: 'USD' });

  // No flag leaves a saved choice alone.
  config.reporting = { currency: 'GBP' };
  applyDataFlags(config, { ...parseCli(['install']), dataSources: {} });
  assert.deepEqual(config.reporting, { currency: 'GBP' });
  assert.equal(parseCli(['install']).currency, undefined);
});

test('currency: the flags are checked', () => {
  assert.throws(() => parseCli(['install', '--currency', 'XYZ']), /--currency should be one of USD/);
  assert.throws(() => parseCli(['update', '--currency', 'GBP']), /--currency go with install/);
  assert.throws(() => parseCli(['--ui', '--currency', 'GBP']), /under Advanced settings/);
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

test('currency: the plan review says which currency the Estimated Value page uses', () => {
  assert.equal(describeReporting(undefined), 'The Estimated Value page shows money in USD ($).');
  assert.equal(describeReporting({ currency: 'USD' }), 'The Estimated Value page shows money in USD ($).');
  assert.equal(describeReporting({ currency: 'EUR' }), 'The Estimated Value page shows money in EUR (€).');
  assert.equal(describeReporting({ currency: 'CHF' }), 'The Estimated Value page shows money in CHF (CHF).');
});
