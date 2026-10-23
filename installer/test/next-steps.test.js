// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appItemUrl, publicAccess, shareApp, shareAppPending, VIEWER_GROUP_NAME } from '../src/steps/access.js';
import { appDeployedSince, fabricConfigFile } from '../src/steps/app.js';
import { emptyConfig } from '../src/config.js';
import { commandLine } from '../src/launch.js';
import { flowsWanted } from '../src/steps/flows.js';
import { GLOBAL_READER_ROLE_ID, nextSteps, stepsLeftTitle } from '../src/steps/next-steps.js';
import { summary } from '../src/install.js';
import { COWORK_DATAFLOW_ACTIVITY } from '../src/transform/pipeline.js';
import { FEEDBACK_SUBJECT } from '../src/transform/flows.js';
import { fakeCtx, fakeFabric, fakeUi } from './fakes.js';

const USER = { tenantId: 'tenant-1', upn: 'admin@contoso.com' };

/** A Fabric install with a viewer group and a deployed app. */
function installed(answers = /** @type {any[]} */ ([])) {
  const fake = fakeUi({ answers });
  const t = fakeCtx({ ui: fake.ui, fabric: fakeFabric().api });
  t.config.access = { groupId: 'g-1', groupName: VIEWER_GROUP_NAME, contact: 'admin@contoso.com', createdGroup: true };
  Object.assign(t.config.fabricApp, { enabled: true, itemId: 'app-item', name: 'Analytics Hub' });
  t.config.fabric.workspaceName = 'Analytics Hub';
  return { ...t, ...fake };
}

const ids = (/** @type {{ id: string }[]} */ steps) => steps.map((s) => s.id);

test('share: asked once after the app is deployed; "I\'ve shared it" is saved and not asked again', async () => {
  const t = installed([true]);
  assert.equal(shareAppPending(t.config), true);
  await shareApp(t.ctx);
  assert.deepEqual(t.asked, ['Have you shared the app?']);
  assert.equal(t.config.access?.appShared, true);
  assert.equal(t.saves(), 1);
  assert.match(t.text(), /appbackends\/app-item\?ctid=tenant-1/, 'it links straight to the app item');
  assert.match(t.text(), /Choose Share\./);
  assert.match(t.text(), /Enter "Analytics Hub Viewers" and choose Grant/);
  assert.equal(shareAppPending(t.config), false);

  await shareApp(t.ctx);
  assert.equal(t.asked.length, 1, 'not asked again once it is shared');
});

test('share: Later leaves it to the summary, and Repair asks again', async () => {
  const t = installed([false]);
  await shareApp(t.ctx);
  assert.equal(t.config.access?.appShared, undefined);
  assert.equal(t.saves(), 0);
  assert.match(t.text(), /no access/);
  assert.equal(shareAppPending(t.config), true);
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['share-app']);
});

test('share: nothing to share without a viewer group or an app, and never on Azure', async () => {
  const t = installed();
  t.config.access = undefined;
  assert.equal(shareAppPending(t.config), false);
  await shareApp(t.ctx);
  assert.deepEqual(t.asked, []);

  const u = installed();
  u.config.fabricApp.itemId = undefined;
  assert.equal(shareAppPending(u.config), false);
  u.config.fabricApp.itemId = 'app-item';
  u.config.target = 'azure';
  assert.equal(shareAppPending(u.config), false);
});

test('share: the app is told it is shared only once it is', () => {
  const t = installed();
  assert.equal(publicAccess(t.config)?.appShared, undefined);
  assert.equal(fabricConfigFile(t.config, 'ws-1', ['vl']).access?.appShared, undefined);
  /** @type {any} */ (t.config.access).appShared = true;
  assert.equal(publicAccess(t.config)?.appShared, true);
  assert.equal(fabricConfigFile(t.config, 'ws-1', ['vl']).access?.appShared, true);
  assert.equal(appItemUrl(t.config), 'https://app.fabric.microsoft.com/groups/ws-1/appbackends/app-item');
  t.config.target = 'azure';
  assert.equal(publicAccess(t.config)?.appShared, undefined, 'Azure has no app item to share');
});

test('install: the share step comes straight after the app is deployed, before the first load waits', async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  const at = (/** @type {string} */ s) => {
    const i = src.indexOf(s);
    assert.ok(i >= 0, `${s} is in install.js`);
    return i;
  };
  assert.ok(at("step('Analytics Hub app')") < at("step('Share the app')"));
  assert.ok(at("step('Share the app')") < at("step('First load')"));
  assert.match(src, /withShare = .*appShared !== true/, 'not asked again once shared');
});

test('next steps: none left for an install with nothing to do', () => {
  const t = installed();
  /** @type {any} */ (t.config.access).appShared = true;
  assert.deepEqual(nextSteps(t.config, USER), []);
  assert.equal(stepsLeftTitle([]), '0 optional steps');
});

test('next steps: in order, share, flows, Cowork Dataflow, then hand-offs; each says who and why', () => {
  const t = installed();
  const config = t.config;
  config.dataSources.productFeedback = 'api';
  config.dataSources.resourceGraph = 'api';
  config.uploads = { ...config.uploads, flowIds: { feedback: 'flow-1' }, flowEnvironment: { id: 'env-1', name: 'Contoso (default)', url: 'https://org.crm.dynamics.com' } };
  config.modules.consumption = true;
  config.dataSources.coworkCredits = 'api';
  config.consumption.dataflowId = 'df-1';
  assert.ok(flowsWanted(config).includes('feedback'));

  const steps = nextSteps(config, USER);
  assert.deepEqual(ids(steps), ['share-app', 'flows', 'cowork-dataflow', 'entra-role', 'm365-export']);
  for (const s of steps) {
    assert.ok(s.title && s.why && s.who, `${s.id} has a title, why and who`);
    assert.doesNotMatch(JSON.stringify(s), /Rayfin/i);
  }
  assert.equal(stepsLeftTitle(steps), '5 steps left');

  const [share, flows, cowork, role, m365] = steps;
  assert.equal(share.link, 'https://app.fabric.microsoft.com/groups/ws-1/appbackends/app-item?ctid=tenant-1');
  assert.equal(share.steps?.length, 3);
  assert.equal(flows.link, 'https://make.powerautomate.com/environments/env-1/flows');
  assert.match(String(flows.message), /^Hi,/);
  assert.match(String(flows.message), /Contoso \(default\)/);
  assert.equal(cowork.activity, COWORK_DATAFLOW_ACTIVITY, 'its failed refresh is expected until it is signed in');
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
  /** @type {any} */ (t.config.access).appShared = true;
  t.config.dataSources.resourceGraph = 'api';
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['entra-role'], 'not recorded counts as not assigned');

  t.config.app.servicePrincipalId = undefined;
  assert.match(String(nextSteps(t.config, USER)[0].message), /\$\(az ad sp show --id app-1 --query id -o tsv\)/);

  /** @type {any} */ (t.config.resourceGraph) = { ...t.config.resourceGraph, roleAssigned: true };
  assert.deepEqual(nextSteps(t.config, USER), []);

  /** @type {any} */ (t.config.resourceGraph) = { ...t.config.resourceGraph, roleAssigned: undefined, agents: false };
  assert.deepEqual(nextSteps(t.config, USER), [], 'not needed when agents are not read');
});

test('next steps: the product feedback export only with its flow; the Viva query is optional', () => {
  const t = installed();
  /** @type {any} */ (t.config.access).appShared = true;
  t.config.dataSources.productFeedback = 'csv';
  assert.ok(!ids(nextSteps(t.config, USER)).includes('m365-export'));

  t.config.modules.consumption = true;
  t.config.dataSources.coworkCredits = 'csv';
  const steps = nextSteps(t.config, USER);
  assert.deepEqual(ids(steps), ['viva-query']);
  assert.equal(steps[0].optional, true);
  assert.equal(stepsLeftTitle(steps), '1 optional step');
  assert.equal(stepsLeftTitle([{ id: 'a', title: 'A', why: '', who: '' }, ...steps]), '1 step left, and 1 optional');
});

test('summary: what is left comes first, as cards, before the next steps', async () => {
  const t = installed();
  t.config.dataSources.resourceGraph = 'api';
  await summary(t.ctx);
  const text = t.text();
  const left = text.indexOf('2 steps left');
  assert.ok(left >= 0, text);
  assert.ok(left < text.indexOf('Share the app with Analytics Hub Viewers'));
  assert.ok(text.indexOf('Share the app with Analytics Hub Viewers') < text.indexOf('Ask for Global Reader'));
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

/** installed(), after an app step that failed before the app was ever deployed. */
function appFailed(answers = /** @type {any[]} */ ([])) {
  const t = installed(answers);
  Object.assign(t.config.semanticModel, { enabled: true, id: 'sm-1', bound: true });
  t.config.fabricApp.itemId = undefined;
  return t;
}

test('next steps: after the app step failed, the first card says how to deploy the app, then share it', () => {
  const t = appFailed();
  const steps = nextSteps(t.config, USER, { appFailed: true });
  assert.deepEqual(ids(steps), ['deploy-app'], 'no share card: there is no app item to share yet');
  const [deploy] = steps;
  assert.equal(deploy.title, 'Deploy the Analytics Hub app');
  assert.equal(deploy.who, 'You');
  assert.ok(deploy.why);
  assert.doesNotMatch(JSON.stringify(deploy), /Rayfin/i);
  assert.deepEqual(deploy.steps, [
    'Fix the problem the app step shows.',
    `Run "${commandLine('deploy-app')}", or choose Redeploy the app on the installer's home page.`,
    `Share it with "${VIEWER_GROUP_NAME}": run "${commandLine('access')}" and choose Share the app with the group.`,
  ]);
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['deploy-app'], 'an app chosen and never deployed, too');

  /** @type {any} */ (t.config.access).appShared = true;
  assert.equal(nextSteps(t.config, USER, { appFailed: true })[0].steps?.length, 2, 'not asked to share again');
  t.config.access = undefined;
  assert.equal(nextSteps(t.config, USER, { appFailed: true })[0].steps?.length, 2, 'no group to share with');
});

test('next steps: an app from before is deployed again, and the share card still covers sharing', () => {
  const t = appFailed();
  t.config.fabricApp.itemId = 'app-item';
  const steps = nextSteps(t.config, USER, { appFailed: true });
  assert.deepEqual(ids(steps), ['deploy-app', 'share-app']);
  assert.equal(steps[0].title, 'Deploy the Analytics Hub app again');
  assert.match(steps[0].why, /as it was last deployed/);
  assert.equal(steps[0].steps?.length, 2);
  assert.deepEqual(ids(nextSteps(t.config, USER)), ['share-app'], 'no card once it deployed');
});

test('next steps: with the model not connected, the card says to run the installer again, not deploy-app', () => {
  const t = appFailed();
  t.config.semanticModel.bound = false;
  const [deploy] = nextSteps(t.config, USER, { appFailed: true });
  assert.equal(deploy.id, 'deploy-app');
  assert.match(String(deploy.steps?.[1]), /^Run the installer again\. It connects .+ to the Lakehouse, then deploys the app\.$/);
  assert.equal(deploy.steps?.length, 2, 'the installer asks to share the app itself');
});

test('next steps: no deploy card on Azure, without the app, or without the model', () => {
  for (const change of [
    (/** @type {any} */ c) => { c.target = 'azure'; },
    (/** @type {any} */ c) => { c.fabricApp.enabled = false; },
    (/** @type {any} */ c) => { c.semanticModel.id = undefined; },
  ]) {
    const t = appFailed();
    change(t.config);
    assert.ok(!ids(nextSteps(t.config, USER, { appFailed: true })).includes('deploy-app'));
  }
});

test('summary: after the app step failed, the partly set up summary says how to deploy the app and share it', async () => {
  const t = appFailed();
  await summary(t.ctx, { ok: false, appFailed: true });
  const text = t.text();
  assert.match(text, /Analytics Hub is partly set up/);
  assert.ok(text.includes(`Run "${commandLine('deploy-app')}"`), text);
  assert.ok(text.includes('choose Share the app with the group'), text);
  assert.ok(text.indexOf('Deploy the Analytics Hub app') < text.indexOf('Next steps'), 'the card leads');
});

test('summary: an app deployed after its step failed is said so, with no card to deploy it', async () => {
  const t = appFailed();
  Object.assign(t.config.fabricApp, { itemId: 'app-item', deployedAt: '2026-06-01T15:42:10.000Z' });
  await summary(t.ctx, { ok: true, appFailed: false, appLate: '2026-06-01T15:42:10.000Z' });
  const text = t.text();
  assert.match(text, /Analytics Hub is set up/);
  assert.match(text, /The app step above failed, but the app was deployed afterwards \(2026-06-01 15:42 UTC\)\./);
  assert.doesNotMatch(text, /Deploy the Analytics Hub app/);
  assert.match(text, /App: +Analytics Hub/);
});

test('install: the app counts as deployed after its step failed only for a new deployment to the workspace since the step', () => {
  const config = emptyConfig();
  config.fabric.workspaceId = 'ws-1';
  config.fabricApp.enabled = true;
  const step = { since: Date.parse('2026-06-01T12:00:00Z'), workspaceId: 'ws-1', deployedAt: undefined };
  assert.equal(appDeployedSince(config, step), undefined, 'nothing deployed since');
  Object.assign(config.fabricApp, { itemId: 'app-item', deployedAt: '2026-06-01T15:42:10.000Z' });
  assert.equal(appDeployedSince(config, step), '2026-06-01T15:42:10.000Z');
  assert.equal(appDeployedSince(config, { ...step, deployedAt: '2026-06-01T15:42:10.000Z' }), undefined, 'the deployment it already had');
  assert.equal(appDeployedSince(config, { ...step, since: Date.parse('2026-06-01T16:00:00Z') }), undefined, 'from before the step');
  assert.equal(appDeployedSince(config, { ...step, workspaceId: 'ws-2' }), undefined, 'the record has moved to another workspace');
  assert.equal(appDeployedSince(config, { ...step, workspaceId: undefined }), undefined);
  config.fabricApp.deployedAt = 'not a date';
  assert.equal(appDeployedSince(config, step), undefined);
  config.fabricApp.deployedAt = '2026-06-01T15:42:10.000Z';
  config.fabricApp.enabled = false;
  assert.equal(appDeployedSince(config, step), undefined, 'the app is no longer wanted');
});

test("install: a failed app deploy or unproven first load makes the install not ok, unless the app was deployed meanwhile and was the only failure", async () => {
  const src = await readFile(new URL('../src/install.js', import.meta.url), 'utf8');
  assert.match(src, /const since = ctx\.now\(\)\.getTime\(\);\r?\n\s*appDeployed = await tryDeployApp\(ctx\);/);
  assert.match(src, /if \(!appDeployed\) appFailure = \{ since, workspaceId: config\.fabric\.workspaceId, deployedAt: config\.fabricApp\.deployedAt \};/);
  // Saving merges in what deploy-app saved while the first load ran, before the verdict.
  assert.match(src, /if \(appFailure\) \{\r?\n(?:\s*\/\/.*\r?\n)?\s*ctx\.save\(\);\r?\n\s*appLate = appDeployedSince\(config, appFailure\);\r?\n\s*\}/);
  // Not when another step failed too: install-verdict.test.js runs each case.
  assert.match(src, /const appOk = appDeployed \|\| !!appLate;\r?\n\s*ok = reloads\.ok && ok && stepsOk && appOk;\r?\n\s*await summary\(ctx, \{ ok, pending: reloads\.pending, appFailed: !appDeployed && !appLate, appLate \}\)/);
  assert.match(src, /if \(opts\.wait && config\.firstRun\?\.status !== 'Completed'\) ok = false;/);
});
