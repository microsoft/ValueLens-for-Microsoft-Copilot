// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shareReport, shareReportPending, VIEWER_GROUP_NAME } from '../src/steps/access.js';
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
  t.config.fabric.workspaceName = 'ValueLens';
  return { ...t, ...fake };
}

/** The same, with the report published on the model, as deployReport records it. */
function published(answers = /** @type {any[]} */ ([])) {
  const t = installed(answers);
  Object.assign(t.config.semanticModel, { enabled: true, reports: true, id: 'sm-1', report: { id: 'rep-1', name: 'ValueLens', modelId: 'sm-1', signature: 'sig-1' } });
  return t;
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

test("share the report: asked once, with the clicks; once it's shared it isn't asked again", async () => {
  const t = published([true]);
  assert.equal(shareReportPending(t.config), true);
  await shareReport(t.ctx);
  assert.deepEqual(t.asked, ['Have you shared the report?']);
  assert.equal(t.config.access?.reportShared, true);
  assert.equal(t.saves(), 1);
  const text = t.text();
  assert.match(text, /1\. Open the ValueLens workspace \(https:\/\/app\.fabric\.microsoft\.com\/groups\/ws-1\?ctid=tenant-1\) and choose … \(More options\) next to the ValueLens report\./);
  assert.match(text, /2\. Choose Manage permissions, then Add user\./);
  assert.match(text, /3\. Enter "ValueLens Viewers" and choose Grant\./);
  assert.match(text, /Keep them off workspace roles: a role lets them read the notebooks/);
  assert.match(text, /The report is shared with "ValueLens Viewers"/);
  assert.equal(shareReportPending(t.config), false);
  assert.deepEqual(nextSteps(t.config, USER), []);

  await shareReport(t.ctx);
  assert.equal(t.asked.length, 1, 'not asked again');
  assert.equal(t.saves(), 1);
});

test('share the report: Later leaves a card, first in the list, until it is shared', async () => {
  const t = published([false]);
  await shareReport(t.ctx);
  assert.equal(t.config.access?.reportShared, undefined);
  assert.equal(t.saves(), 0);
  assert.match(t.text(), /Until it's shared, people in the group can't open the report/);

  t.config.dataSources.resourceGraph = 'api';
  const steps = nextSteps(t.config, USER);
  assert.deepEqual(ids(steps), ['share-report', 'entra-role']);
  const [card] = steps;
  assert.equal(card.title, 'Share the report with ValueLens Viewers');
  assert.equal(card.who, 'You');
  assert.ok(!card.optional, 'viewers can\'t open the report without it');
  assert.equal(card.link, 'https://app.fabric.microsoft.com/groups/ws-1?ctid=tenant-1');
  assert.equal(card.linkText, 'Open the workspace');
  assert.equal(card.steps?.length, 3);
  assert.match(String(card.steps?.[2]), /^Enter "ValueLens Viewers" and choose Grant\.$/);
  assert.match(card.why, /myaccount\.microsoft\.com\/groups\/g-1/);
  assert.match(card.why, /not by giving them a workspace role/);
  assert.equal(stepsLeftTitle(steps), '2 steps left');

  /** @type {any} */ (t.config.access).reportShared = true;
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['entra-role']);
});

test('share the report: nothing to ask without a group or a published report', async () => {
  const noGroup = published();
  delete noGroup.config.access?.groupId;
  await shareReport(noGroup.ctx);
  assert.deepEqual(noGroup.asked, []);
  assert.match(noGroup.text(), /There's no viewer group yet, so there's nothing to share/);
  assert.deepEqual(nextSteps(noGroup.config, USER), []);

  const unpublished = installed();
  Object.assign(unpublished.config.semanticModel, { enabled: true, reports: true, id: 'sm-1' });
  await shareReport(unpublished.ctx);
  assert.deepEqual(unpublished.asked, []);
  assert.match(unpublished.text(), /The report isn't published, so there's nothing to share yet/);
  assert.deepEqual(nextSteps(unpublished.config, USER), []);

  const off = published();
  off.config.semanticModel.reports = false;
  assert.equal(shareReportPending(off.config), false, 'reports turned off');
  assert.deepEqual(nextSteps(off.config, USER), []);
});

test('install: the report is shared after the group gets Build and before the first load, until it is', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  const at = (/** @type {string} */ s) => {
    const i = src.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  assert.ok(at("step('Viewer access')") < at("step('Share the report')"));
  assert.ok(at("step('Share the report')") < at("step('First load')"));
  assert.match(src, /const withShare = withReports && withAccess && config\.access\?\.reportShared !== true;/);
  assert.match(src, /\.\.\.\(withShare \? \['Share the report'\] : \[\]\)/);
});

test('summary: viewers get the group and the report, never a workspace role', async () => {
  const t = published([false]);
  await summary(t.ctx);
  const text = t.text();
  assert.ok(text.indexOf('Share the report with ValueLens Viewers') < text.indexOf('Next steps'), 'the card leads');
  assert.match(text, /1\. Give people access by adding them to "ValueLens Viewers"/);
  assert.match(text, /The group already has Build on the model\./);
  assert.match(text, /Keep viewers off workspace roles: a role lets them read the notebooks/);
  assert.doesNotMatch(text, /Viewer on the workspace|choose Share|Share each report you publish/);

  const shared = published();
  /** @type {any} */ (shared.config.access).reportShared = true;
  await summary(shared.ctx);
  assert.doesNotMatch(shared.text(), /Share the report with/);

  const noGroup = published();
  delete noGroup.config.access;
  await summary(noGroup.ctx);
  assert.match(noGroup.text(), /1\. Share the report: choose … \(More options\) next to it in the workspace, then Manage permissions > Add user\. Add people or a group and choose Grant\./);
  assert.match(noGroup.text(), /Keep viewers off workspace roles/);
  assert.doesNotMatch(noGroup.text(), /Viewer on the workspace|choose Share/);
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
  assert.match(t.text(), /ValueLens is set up/);
  const p = installed();
  await summary(p.ctx, { ok: false });
  assert.match(p.text(), /ValueLens is partly set up/);
  assert.doesNotMatch(p.text(), /ValueLens is set up/);
  assert.match(p.text(), /run the installer again/);
});

test('install: a failed step or an unproven first load makes the install not ok', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  // install-verdict.test.js runs each case.
  assert.match(src, /ok = reloads\.ok && ok && stepsOk;\r?\n\s*await summary\(ctx, \{ ok, pending: reloads\.pending \}\)/);
  assert.match(src, /if \(opts\.wait && config\.firstRun\?\.status !== 'Completed'\) ok = false;/);
});
