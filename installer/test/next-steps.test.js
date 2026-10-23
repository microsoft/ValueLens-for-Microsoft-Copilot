// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { flowsWanted } from '../src/steps/flows.js';
import { GLOBAL_READER_ROLE_ID, nextSteps, stepsLeftTitle } from '../src/steps/next-steps.js';
import { summary } from '../src/install.js';
import { FEEDBACK_SUBJECT } from '../src/transform/flows.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const USER = { tenantId: 'tenant-1', upn: 'admin@contoso.com' };

/** A Fabric install with a viewer group. */
function installed(answers = /** @type {any[]} */ ([])) {
  const fake = fakeUi({ answers });
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api });
  t.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', createdGroup: true };
  t.config.fabric.workspaceName = 'Analytics Hub';
  return { ...t, ...fake };
}

const ids = (/** @type {{ id: string }[]} */ steps) => steps.map((s) => s.id);

test('next steps: none left for an install with nothing to do', () => {
  const t = installed();
  assert.deepEqual(nextSteps(t.config, USER), []);
  assert.equal(stepsLeftTitle([]), '0 optional steps');
});

test('next steps: in order, flows, then hand-offs; each says who and why', () => {
  const t = installed();
  const config = t.config;
  config.dataSources.productFeedback = 'api';
  config.dataSources.resourceGraph = 'api';
  config.uploads = { ...config.uploads, flowIds: { feedback: 'flow-1' }, flowEnvironment: { id: 'env-1', name: 'Contoso (default)', url: 'https://org.crm.dynamics.com' } };
  assert.ok(flowsWanted(config).includes('feedback'));

  const steps = nextSteps(config, USER);
  assert.deepEqual(ids(steps), ['flows', 'entra-role', 'm365-export']);
  for (const s of steps) {
    assert.ok(s.title && s.why && s.who, `${s.id} has a title, why and who`);
    assert.doesNotMatch(JSON.stringify(s), /Rayfin/i);
  }
  assert.equal(stepsLeftTitle(steps), '3 steps left');

  const [flows, role, m365] = steps;
  assert.equal(flows.link, 'https://make.powerautomate.com/environments/env-1/flows');
  assert.match(String(flows.message), /^Hi,/);
  assert.match(String(flows.message), /Contoso \(default\)/);
  assert.equal(role.who, 'A Privileged Role Administrator');
  assert.match(String(role.message), /Application \(client\) ID: app-1/);
  assert.match(String(role.message), /Object ID \(enterprise application\): sp-1/);
  assert.match(String(role.message), new RegExp(`"principalId":"sp-1","roleDefinitionId":"${GLOBAL_READER_ROLE_ID}"`));
  assert.match(String(role.message), /admin@contoso\.com$/, 'signed by the person running the installer');
  assert.equal(m365.who, 'A Microsoft 365 admin');
  assert.ok(m365.message?.includes(FEEDBACK_SUBJECT));
  assert.match(String(m365.message), /emailed to admin@contoso\.com/);
});

test('next steps: the Global Reader hand-off shows until the role is recorded as assigned', () => {
  const t = installed();
  t.config.dataSources.resourceGraph = 'api';
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['entra-role'], 'not recorded counts as not assigned');

  t.config.app.servicePrincipalId = undefined;
  assert.match(String(nextSteps(t.config, USER)[0].message), /\$\(az ad sp show --id app-1 --query id -o tsv\)/);

  /** @type {any} */ (t.config.resourceGraph) = { ...t.config.resourceGraph, roleAssigned: true };
  assert.deepEqual(nextSteps(t.config, USER), []);

  /** @type {any} */ (t.config.resourceGraph) = { ...t.config.resourceGraph, roleAssigned: undefined, agents: false };
  assert.deepEqual(nextSteps(t.config, USER), [], 'not needed when agents are not read');
});

test('next steps: the product feedback export only with its flow; optional steps are counted apart', () => {
  const t = installed();
  t.config.dataSources.productFeedback = 'csv';
  assert.ok(!ids(nextSteps(t.config, USER)).includes('m365-export'));

  const steps = [{ id: 'b', title: 'B', why: '', who: '', optional: true }];
  assert.equal(stepsLeftTitle(steps), '1 optional step');
  assert.equal(stepsLeftTitle([{ id: 'a', title: 'A', why: '', who: '' }, ...steps]), '1 step left, and 1 optional');
});

test('summary: what is left comes first, as cards, before the next steps', async () => {
  const t = installed();
  t.config.dataSources.resourceGraph = 'api';
  t.config.dataSources.productFeedback = 'api';
  t.config.uploads = { ...t.config.uploads, flowIds: { feedback: 'flow-1' } };
  await summary(t.ctx);
  const text = t.text();
  const left = text.indexOf('3 steps left');
  assert.ok(left >= 0, text);
  assert.ok(left < text.indexOf('Sign in to the Power Automate flow'));
  assert.ok(text.indexOf('Sign in to the Power Automate flow') < text.indexOf('Ask for Global Reader'));
  assert.ok(text.indexOf('Ask for Global Reader') < text.indexOf('Ask for the product feedback export'));
  const next = text.indexOf('Next steps');
  if (next >= 0) assert.ok(left < next, 'the cards lead');
  assert.match(text, /Copy and send:/);
});

test("summary: after a failed step it says the setup is partly done, not set up", async () => {
  const t = installed();
  await summary(t.ctx);
  assert.match(t.text(), /Analytics Hub is set up/);
  const p = installed();
  await summary(p.ctx, { ok: false });
  assert.match(p.text(), /Analytics Hub is partly set up/);
  assert.doesNotMatch(p.text(), /Analytics Hub is set up/);
  assert.match(p.text(), /run the installer again/);
});

test('install: a failed step or an unproven first load makes the install not ok', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  // install-verdict.test.js runs each case.
  assert.match(src, /ok = reloads\.ok && ok && stepsOk;\r?\n\s*await summary\(ctx, \{ ok, pending: reloads\.pending \}\)/);
  assert.match(src, /if \(opts\.wait && config\.firstRun\?\.status !== 'Completed'\) ok = false;/);
});
