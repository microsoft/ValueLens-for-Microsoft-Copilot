// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKFILL_ENV, jobTemplateWith } from '../src/steps/azure/index.js';
import { askMoreHistory, HISTORY_CHOICES, reloadDetail, reloadLine } from '../src/steps/plan.js';
import { fakeArm, fakeCtx, fakeUi } from './fakes.js';

/** A ui that records each select's choices and answers with `answer`, or the default. @param {any} [answer] */
function selectUi(answer) {
  const fake = fakeUi();
  /** @type {{ message: string, choices: any[] }[]} */
  const selects = [];
  fake.ui.select = async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    selects.push({ message, choices });
    return answer === undefined ? def : answer;
  };
  return { ...fake, selects };
}

test('askMoreHistory: offers only more than is loaded, and leaves the record alone until the reload starts', async () => {
  const s = selectUi(90);
  const { ctx, config } = fakeCtx({ ui: s.ui });
  config.history.days = 30;
  await askMoreHistory(ctx);
  assert.equal(s.selects.length, 1);
  assert.match(s.selects[0].message, /Load more audit history\? 30 days are loaded now/);
  assert.deepEqual(s.selects[0].choices.map((c) => c.value), [0, 90, 180]);
  assert.match(s.selects[0].choices[2].description, /many hours on a large tenant/);
  assert.equal(ctx.reloadHistoryDays, 90);
  assert.equal(config.history.days, 30, 'saved only once the reload has started');

  const keep = selectUi();
  const k = fakeCtx({ ui: keep.ui });
  k.config.history.days = 90;
  k.ctx.reloadHistoryDays = 180;
  await askMoreHistory(k.ctx);
  assert.deepEqual(keep.selects[0].choices.map((c) => c.value), [0, 180]);
  assert.equal(k.ctx.reloadHistoryDays, undefined, 'Keep is the default, and clears an earlier answer');

  const most = selectUi();
  const m = fakeCtx({ ui: most.ui });
  m.config.history.days = 180;
  await askMoreHistory(m.ctx);
  assert.equal(most.selects.length, 0, 'nothing more to offer at 180 days');
  assert.match(most.text(), /180 days loaded, the most the installer loads/);
});

test('reloadLine and reloadDetail describe the reload for the plan summary', () => {
  assert.deepEqual(HISTORY_CHOICES.map((c) => c.value), [30, 90, 180]);
  assert.match(reloadLine(90), /90 days/);
  assert.ok(reloadDetail(180).length > 0);
});

test('jobTemplateWith: one execution with the backfill setting, replacing any old one and keeping the rest', async () => {
  const arm = fakeArm();
  const job = await arm.api.getContainerAppJob('sub-1', 'rg', 'vlens-run');
  const template = jobTemplateWith(job, [{ name: BACKFILL_ENV, value: '90' }]);
  assert.ok(template);
  const [ct] = template.containers;
  assert.equal(ct.image, 'img:1');
  assert.deepEqual(ct.command, ['python']);
  assert.deepEqual(ct.env, [{ name: 'VALUELENS_AUDIT_HISTORY_DAYS', value: '30' }, { name: BACKFILL_ENV, value: '90' }]);
  assert.equal(jobTemplateWith({ properties: { template: { containers: [] } } }, []), undefined);
  assert.equal(BACKFILL_ENV, 'VALUELENS_AUDIT_BACKFILL_DAYS');
});
