// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessCommand } from '../src/steps/access.js';
import { showPrivacyGuide } from '../src/steps/privacy-guide.js';
import { fakeCtx, fakeUi } from './fakes.js';

test('privacy guide is read-only and distinguishes portal RLS from unsupported hashing', () => {
  const ui = fakeUi();
  const { ctx, config } = fakeCtx({ ui: ui.ui });
  const before = JSON.stringify(config);
  ctx.save = () => assert.fail('guide must not save');
  showPrivacyGuide(ctx);
  assert.equal(JSON.stringify(config), before);
  assert.match(ui.text(), /off \(default\)/);
  assert.match(ui.text(), /Power BI portal/);
  assert.match(ui.text(), /unions roles/);
  assert.match(ui.text(), /cannot revoke an Everyone role membership/);
  assert.match(ui.text(), /no scope/);
  assert.match(ui.text(), /No hashing switch is exposed/);
  assert.match(ui.text(), /historical reprocessing/);
  assert.match(ui.text(), /not anonymity/);
});

test('access menu displays the privacy guide without adding viewers or granting model access', async () => {
  const ui = fakeUi({ answers: ['privacy', 'done'] });
  const graph = {
    getGroup: async () => ({ id: 'g-1', displayName: 'Analytics Hub Viewers' }),
    groupMembers: async () => [],
    groupOwners: async () => [],
  };
  const { ctx, config } = fakeCtx({ ui: ui.ui, graph });
  config.access = { groupId: 'g-1', groupName: 'Analytics Hub Viewers' };
  await accessCommand(ctx, []);
  assert.match(ui.text(), /Security and privacy setup/);
  assert.match(ui.text(), /The installer does not assign Power BI roles/);
});
