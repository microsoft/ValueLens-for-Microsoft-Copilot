import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedSemanticModel, loadConfig, parseReporting, parseSemanticModels } from '../src/config.js';

test('legacy valueLensModel key is served as the vl alias the app queries', () => {
  const ref = { workspaceId: 'ws', itemId: 'ds' };
  assert.deepEqual(parseSemanticModels(JSON.stringify({ valueLensModel: ref })), { vl: ref });
  assert.deepEqual(parseSemanticModels(JSON.stringify({ vl: ref, cc: ref })), { vl: ref, cc: ref });
  assert.deepEqual(parseSemanticModels(''), {});
});

test('the Consumption Central model (cc) is queryable alongside vl, and nothing else is', () => {
  const models = parseSemanticModels(JSON.stringify({ vl: { workspaceId: 'ws', itemId: 'vl-1' }, cc: { workspaceId: 'ws', itemId: 'cc-1' } }));
  assert.equal(isAllowedSemanticModel(models, 'ws', 'vl-1'), true);
  assert.equal(isAllowedSemanticModel(models, 'ws', 'cc-1'), true);
  assert.equal(isAllowedSemanticModel(models, 'ws', 'other'), false);
  assert.equal(isAllowedSemanticModel(models, 'other-ws', 'cc-1'), false);
});

test('the installer\'s reporting currency is read with its rate, and a rate for US dollars is dropped', () => {
  assert.deepEqual(parseReporting('eur', '0.92'), { currency: 'EUR', exchangeRate: 0.92 });
  assert.deepEqual(parseReporting('GBP', ''), { currency: 'GBP' });
  assert.deepEqual(parseReporting('GBP', '-1'), { currency: 'GBP' });
  assert.deepEqual(parseReporting('USD', '0.8'), { currency: 'USD' });
  assert.equal(parseReporting('', '0.8'), undefined);
  assert.equal(parseReporting('pounds', undefined), undefined);
  assert.deepEqual(loadConfig({ VALUELENS_CURRENCY: 'JPY', VALUELENS_EXCHANGE_RATE: '150' }).reporting, { currency: 'JPY', exchangeRate: 150 });
  assert.equal(loadConfig({}).reporting, undefined);
});
