// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifestVersion, writeTeamsPackage } from '../src/azure/teams.js';
import { appCatalogApi } from '../src/clients/graph.js';
import { createClient, HttpError } from '../src/http.js';
import { azureSummary } from '../src/steps/azure/index.js';
import { catalogErrorReason, CATALOG_SIGN_IN_MS, askToPublishTeamsApp, checkCatalogAccess, MANAGE_APPS_URL, publishTeamsApp, removeTeamsApp, signInForTeamsApp, TEAMS_APP_PENDING, teamsAppPlanRow } from '../src/steps/azure/teams-catalog.js';
import { fakeAppCatalog, fakeCtx, fakeUi, readManifest } from './fakes.js';

/** @typedef {import('../src/config.js').AzureConfig} AzureConfig */

const CLIENT_ID = '00000000-0000-4000-8000-000000000001';
const OLD_CLIENT_ID = '00000000-0000-4000-8000-000000000009';
const TEAMS_ADMIN = { roleTemplateId: '69091246-20e8-4a56-aa4d-066075b2a7a8', displayName: 'Teams Administrator' };
const GLOBAL_ADMIN = { roleTemplateId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' };
const GLOBAL_READER = { roleTemplateId: 'f2ef992c-3afb-46b9-b7cf-a126ee74c451', displayName: 'Global Reader' };
const PATH = '/installs/AnalyticsHub-Teams.zip';
const WHERE = `Teams admin center > Teams apps > Manage apps (${MANAGE_APPS_URL})`;
const UPLOAD_PENDING = `${TEAMS_APP_PENDING}: upload ${PATH} in ${WHERE}.`;
const NOW = '2026-06-01T12:00:00.000Z';
const PUBLISH_QUESTION = 'Publish the Teams app to your org\'s app catalog? It takes one more sign-in. If you say no, the installer prints the steps to upload it by hand.';

/**
 * A package as writeTeamsPackage returns it. The fake catalog reads its bytes as the manifest; `build`
 * changes the bytes but not the version.
 * @param {string} version @param {{ id?: string, build?: number }} [o]
 */
const pkg = (version, o = {}) => ({ path: PATH, version, zip: new TextEncoder().encode(JSON.stringify({ id: o.id ?? CLIENT_ID, version, build: o.build ?? 1 })) });
/** @param {{ zip: Uint8Array }} p */
const sha = (p) => createHash('sha256').update(p.zip).digest('hex');

/**
 * An app in the org's catalog.
 * @param {string} id @param {string} version @param {{ externalId?: string, state?: string }} [o]
 * @returns {import('../src/clients/graph.js').TeamsCatalogApp}
 */
const catalogApp = (id, version, o = {}) => ({ id, externalId: o.externalId ?? CLIENT_ID, displayName: 'Analytics Hub', distributionMethod: 'organization', appDefinitions: [{ version, publishingState: o.state ?? 'published' }] });

/** The install record's Teams app. @param {string} id @param {string} [version] @param {string} [externalId] */
const record = (id, version = '0.6.7', externalId = CLIENT_ID) => ({ id, externalId, version, sha256: 'recorded', publishedAt: '2026-05-01T00:00:00.000Z' });

/** @param {number} status @param {string} [message] */
const graphError = (status, message = `POST /v1.0/appCatalogs/teamsApps returned ${status}`) => new HttpError(message, { status, method: 'POST', url: 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps' });

/**
 * A run on the Azure path. A Teams Administrator is signed in unless `roles` says otherwise; `catalog: false`
 * is a sign-in with the Azure CLI, which has no app catalog client. `answers` scripts the admin's replies.
 * @param {{ roles?: { roleTemplateId: string, displayName: string }[] | Error, apps?: import('../src/clients/graph.js').TeamsCatalogApp[], catalog?: boolean, teamsApp?: AzureConfig['teamsApp'], pending?: string[], answers?: any[] }} [o]
 */
function setup(o = {}) {
  const ui = fakeUi({ answers: o.answers });
  const catalog = fakeAppCatalog({ apps: o.apps });
  /** @type {string[]} */
  const graphCalls = [];
  const graph = {
    myDirectoryRoles: async () => {
      graphCalls.push('myDirectoryRoles');
      if (o.roles instanceof Error) throw o.roles;
      return o.roles ?? [TEAMS_ADMIN];
    },
  };
  const { ctx, config, saves } = fakeCtx({ ui: ui.ui, graph, appCatalog: o.catalog === false ? undefined : catalog.api });
  config.target = 'azure';
  /** @type {AzureConfig} */
  const az = { resourceGroup: 'rg', location: 'uksouth', webApp: { clientId: CLIENT_ID }, teamsPackage: PATH, teamsApp: o.teamsApp, status: { pendingAdminActions: [...(o.pending ?? [])] } };
  config.azure = az;
  return {
    ctx,
    az,
    ui,
    catalog,
    graphCalls,
    saves,
    /** The next run of the installer, which checks access and signs in afresh. */
    rerun() {
      delete ctx.teamsCatalog;
      catalog.calls.length = 0;
      graphCalls.length = 0;
    },
  };
}

test('a first run publishes the Teams app to the org catalog and records it', async () => {
  const t = setup();
  const p = pkg('0.6.7');
  await publishTeamsApp(t.ctx, p);
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, `publish ${CLIENT_ID} 0.6.7`]);
  assert.deepEqual(t.az.teamsApp, { id: 'catalog-app-1', externalId: CLIENT_ID, version: '0.6.7', sha256: sha(p), publishedAt: NOW });
  assert.deepEqual(t.az.status?.pendingAdminActions, []);
  assert.ok(t.saves() > 0);
  const out = t.ui.text();
  assert.match(out, /Teams app: published Analytics Hub 0\.6\.7 to your org's app catalog/);
  assert.match(out, /people find it in Teams under Apps > Built for your org, and in the Outlook and Microsoft 365 Copilot app stores/);
  assert.match(out, /To pin it in Teams for Analytics Hub Viewers, a Teams Administrator adds it to an app setup policy and assigns that policy to the group\./);
  assert.doesNotMatch(out, /not published/);
});

test('a re-run with the same package signs in for nothing and uploads nothing', async () => {
  const t = setup();
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  t.rerun();
  await signInForTeamsApp(t.ctx, '0.6.7');
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, []);
  assert.deepEqual(t.graphCalls, [], 'no role lookup either');
  assert.match(t.ui.text(), /Teams app: up to date in your org's app catalog \(version 0\.6\.7\)/);
  assert.equal(t.catalog.apps.length, 1);
});

test('an upgrade updates the app already in the catalog, never adding a second one', async () => {
  const t = setup();
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  t.rerun();
  const next = pkg('0.6.8');
  await publishTeamsApp(t.ctx, next);
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, 'update catalog-app-1 0.6.8']);
  assert.equal(t.catalog.apps.length, 1);
  assert.equal(t.catalog.apps[0].appDefinitions?.[0].version, '0.6.8');
  assert.deepEqual(t.az.teamsApp, { id: 'catalog-app-1', externalId: CLIENT_ID, version: '0.6.8', sha256: sha(next), publishedAt: NOW });
  assert.match(t.ui.text(), /Teams app: updated Analytics Hub to 0\.6\.8 in your org's app catalog/);
});

test('an app uploaded by hand from an earlier version is updated, not duplicated', async () => {
  const t = setup({ apps: [catalogApp('uploaded-by-hand', '0.6.6')] });
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, 'update uploaded-by-hand 0.6.7']);
  assert.equal(t.catalog.apps.length, 1);
  assert.equal(t.az.teamsApp?.id, 'uploaded-by-hand');
});

test('this version, uploaded by hand, is adopted without uploading it again', async () => {
  const t = setup({ apps: [catalogApp('uploaded-by-hand', '0.6.7')] });
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`]);
  assert.equal(t.az.teamsApp?.id, 'uploaded-by-hand');
  assert.match(t.ui.text(), /Teams app: Analytics Hub 0\.6\.7 is already in your org's app catalog/);
  t.rerun();
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, [], 'the next run has nothing to do');
});

test('a changed package at the same version is sent as an update', async () => {
  const t = setup();
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  t.rerun();
  const changed = pkg('0.6.7', { build: 2 });
  await publishTeamsApp(t.ctx, changed);
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, 'update catalog-app-1 0.6.7']);
  assert.equal(t.az.teamsApp?.sha256, sha(changed));
});

for (const c of [
  { status: 400, message: 'POST /v1.0/appCatalogs/teamsApps/catalog-app-1/appDefinitions returned 400 BadRequest: The version must be higher.', reason: /Teams app: not published to your org's app catalog\. Teams kept Analytics Hub 0\.6\.7 and didn't take this package as an update at the same version \(POST .* returned 400 BadRequest: The version must be higher\.\)\./ },
  { status: 409, message: 'POST /v1.0/appCatalogs/teamsApps/catalog-app-1/appDefinitions returned 409 Conflict', reason: /Teams app: not published to your org's app catalog\. Teams kept Analytics Hub 0\.6\.7 and didn't take this package as an update at the same version \(POST .* returned 409 Conflict\)\./ },
  { status: 403, message: 'POST /v1.0/appCatalogs/teamsApps/catalog-app-1/appDefinitions returned 403 Forbidden', reason: /Teams app: not published to your org's app catalog\. Microsoft Graph refused it \(403\)\./ },
]) {
  test(`when Teams turns down a same-version update (${c.status}), it keeps what Teams has, leaves the steps, and the next run tries again`, async () => {
    const t = setup();
    const first = pkg('0.6.7');
    await publishTeamsApp(t.ctx, first);
    t.rerun();
    t.catalog.failures.update = [graphError(c.status, c.message)];
    const changed = pkg('0.6.7', { build: 2 });
    await publishTeamsApp(t.ctx, changed);
    assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, 'update catalog-app-1 0.6.7']);
    const out = t.ui.text();
    assert.match(out, c.reason);
    assert.match(out, /2\. Selects Analytics Hub, then Upload file on its page, and chooses \/installs\/AnalyticsHub-Teams\.zip/);
    assert.equal(t.az.teamsApp?.sha256, sha(first), 'the record keeps the package Teams took');
    assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);

    t.rerun();
    assert.match(teamsAppPlanRow(t.ctx, '0.6.7').detail, /^Update to version 0\.6\.7\. You sign in once more/, 'the plan says it tries again');
    await signInForTeamsApp(t.ctx, '0.6.7');
    await publishTeamsApp(t.ctx, changed);
    assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, 'update catalog-app-1 0.6.7'], 'the next run sends the update again');
    assert.equal(t.az.teamsApp?.sha256, sha(changed));
    assert.deepEqual(t.az.status?.pendingAdminActions, []);
  });
}

test('a newer version in the catalog is left alone', async () => {
  const t = setup({ apps: [catalogApp('uploaded-by-hand', '0.6.10')], pending: [UPLOAD_PENDING] });
  await publishTeamsApp(t.ctx, pkg('0.6.9'));
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`], '0.6.10 is newer than 0.6.9');
  assert.equal(t.az.teamsApp, undefined);
  assert.deepEqual(t.az.status?.pendingAdminActions, []);
  assert.match(t.ui.text(), /your org's app catalog has Analytics Hub 0\.6\.10, newer than this installer's 0\.6\.9, so the installer left it alone/);
});

test('an app waiting for approval gets the steps to approve it', async () => {
  const t = setup({ apps: [catalogApp('submitted', '0.6.7', { state: 'submitted' })] });
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`]);
  assert.equal(t.az.teamsApp, undefined);
  const out = t.ui.text();
  assert.match(out, /Teams app: not published to your org's app catalog\. Analytics Hub is in the catalog waiting for approval, so the installer can't update it\./);
  assert.match(out, /To approve it, a Teams Administrator or Global Administrator:/);
  assert.match(out, /1\. Opens Teams admin center > Teams apps > Manage apps: https:\/\/admin\.teams\.microsoft\.com\/policies\/manage-apps/);
  assert.match(out, /2\. Selects Analytics Hub, which is waiting for approval, then Publish in its Publishing status box\./);
  assert.match(out, /Then run the installer again and choose Repair or change, to bring it up to date\./);
  assert.deepEqual(t.az.status?.pendingAdminActions, [`${TEAMS_APP_PENDING}: approve Analytics Hub in ${WHERE}, then run the installer again.`]);
});

test('when Teams has the app but Graph does not list it, the steps update that app', async () => {
  const t = setup();
  t.catalog.failures.publish = [graphError(409, 'POST /v1.0/appCatalogs/teamsApps returned 409 Conflict')];
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  const out = t.ui.text();
  assert.match(out, /Teams says Analytics Hub is in the catalog already, but Microsoft Graph didn't list it\. It may be waiting for approval\./);
  assert.match(out, /2\. Selects Analytics Hub, then Upload file on its page, and chooses \/installs\/AnalyticsHub-Teams\.zip/);
  assert.equal(t.az.teamsApp, undefined);
  assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
});

test('without a Teams or Global Administrator role, it prints the upload steps and never signs in', async () => {
  const t = setup({ roles: [GLOBAL_READER] });
  t.ctx.teamsCatalog = await checkCatalogAccess(t.ctx);
  assert.equal(t.ctx.teamsCatalog.canTry, false);
  assert.equal(teamsAppPlanRow(t.ctx, '0.6.7').detail, 'Not published by the installer. Changing your org\'s app catalog takes the Teams Administrator or Global Administrator role, active, and you have neither. The installer prints the steps for a Teams Administrator to upload it.');
  await signInForTeamsApp(t.ctx, '0.6.7');
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, []);
  assert.deepEqual(t.graphCalls, ['myDirectoryRoles']);
  const out = t.ui.text();
  assert.doesNotMatch(out, /Signing in once more/);
  assert.match(out, /Teams app: not published to your org's app catalog\. .* you have neither\. If you can activate one in Privileged Identity Management, do that, then run the installer again and choose Repair or change\./);
  assert.match(out, /To publish it, a Teams Administrator or Global Administrator:/);
  assert.match(out, /2\. If Analytics Hub is listed, selects it, then Upload file on its page\. If not, selects Upload new app, then Upload\. Either way, chooses \/installs\/AnalyticsHub-Teams\.zip/);
  assert.match(out, /To pin it in Teams for Analytics Hub Viewers/);
  assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
});

test('checkCatalogAccess names the role that publishes, and tries anyway when roles can\'t be read', async () => {
  assert.deepEqual(await checkCatalogAccess(setup({ roles: [GLOBAL_READER, GLOBAL_ADMIN] }).ctx), { canTry: true, role: 'Global Administrator' });
  assert.deepEqual(await checkCatalogAccess(setup({ roles: [TEAMS_ADMIN] }).ctx), { canTry: true, role: 'Teams Administrator' });
  assert.deepEqual(await checkCatalogAccess(setup({ roles: graphError(403) }).ctx), { canTry: true });
  const cli = setup({ catalog: false });
  const access = await checkCatalogAccess(cli.ctx);
  assert.equal(access.canTry, false);
  assert.match(String(access.reason), /You signed in with the Azure CLI/);
  assert.deepEqual(cli.graphCalls, [], 'no role lookup');
});

test('signed in with the Azure CLI, it prints the steps without trying', async () => {
  const t = setup({ catalog: false });
  await signInForTeamsApp(t.ctx, '0.6.7');
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.graphCalls, []);
  const out = t.ui.text();
  assert.doesNotMatch(out, /Signing in once more/);
  assert.match(out, /Teams app: not published to your org's app catalog\. You signed in with the Azure CLI, which can't ask for the permission to change your org's app catalog\. Next time, sign in with the browser or a code instead, and the installer publishes it for you\./);
  assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
});

test('the sign-in comes once, before the install, and publishing reuses it', async () => {
  const t = setup();
  await signInForTeamsApp(t.ctx, '0.6.7');
  assert.deepEqual(t.catalog.calls, ['signIn']);
  assert.match(t.ui.text(), /Signing in once more, as Microsoft Graph Command Line Tools, to publish the Teams app to your org's app catalog\./);
  assert.match(t.ui.text(), /Signed in to publish the Teams app/);
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, `publish ${CLIENT_ID} 0.6.7`]);
  assert.deepEqual(t.graphCalls, ['myDirectoryRoles']);
});

test('a sign-in that needs admin consent is asked for once, and the install carries on with the steps', async () => {
  const t = setup();
  t.catalog.failures.signIn = [new Error('AADSTS90094: Admin consent is required for the permissions requested by this application.')];
  await signInForTeamsApp(t.ctx, '0.6.7');
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, ['signIn']);
  const out = t.ui.text();
  const consent = 'The app catalog permission, "Read and write to all app catalogs" \\(AppCatalog\\.ReadWrite\\.All\\), needs admin consent\\. A Global Administrator, Privileged Role Administrator, Cloud Application Administrator or Application Administrator can give it at sign-in\\.';
  assert.match(out, new RegExp(`The installer can't publish the Teams app\\. ${consent} The install carries on, and the steps to upload it by hand come at the end\\.`));
  assert.match(out, new RegExp(`Teams app: not published to your org's app catalog\\. ${consent}`));
  assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
});

test('a declined sign-in leaves the steps to upload it, and the install carries on', async () => {
  const t = setup();
  t.catalog.failures.signIn = [new Error('AADSTS65004: User declined to consent to access the app.')];
  await signInForTeamsApp(t.ctx, '0.6.7');
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, ['signIn']);
  assert.match(t.ui.text(), /Teams app: not published to your org's app catalog\. The app catalog permission, .*, was declined at sign-in\./);
  assert.equal(t.az.teamsApp, undefined);
  assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
});

/** @type {{ label: string, wait: (signal?: AbortSignal) => Promise<unknown> }[]} */
const unfinished = [
  // The browser sign-in's listener ignores the signal and waits for ever.
  { label: 'a browser sign-in left open', wait: () => new Promise(() => {}) },
  { label: 'a code sign-in nobody enters', wait: (signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('AbortError: The operation was aborted.')))) },
];
for (const c of unfinished) {
  test(`${c.label} is given up on after 5 minutes, and the install carries on with the steps`, async (tt) => {
    tt.mock.timers.enable({ apis: ['setTimeout'] });
    const t = setup();
    /** @type {AbortSignal | undefined} */
    let signal;
    t.catalog.api.signIn = async (o) => {
      t.catalog.calls.push('signIn');
      signal = o?.abortSignal;
      await c.wait(signal);
    };
    const signingIn = signInForTeamsApp(t.ctx, '0.6.7');
    while (!signal) await new Promise((r) => setImmediate(r));
    assert.equal(CATALOG_SIGN_IN_MS, 5 * 60_000);
    tt.mock.timers.tick(CATALOG_SIGN_IN_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(signal?.aborted, false, 'still waiting just before the time is up');
    tt.mock.timers.tick(1);
    await signingIn;
    assert.equal(signal?.aborted, true);
    let out = t.ui.text();
    assert.match(out, /Signing in once more, as Microsoft Graph Command Line Tools, to publish the Teams app to your org's app catalog\. If the sign-in isn't finished within 5 minutes, the install carries on without it\./);
    assert.match(out, /The installer can't publish the Teams app\. The sign-in to Microsoft Graph Command Line Tools wasn't finished within 5 minutes\. The install carries on, and the steps to upload it by hand come at the end\./);

    await publishTeamsApp(t.ctx, pkg('0.6.7'));
    assert.deepEqual(t.catalog.calls, ['signIn'], 'not asked again');
    out = t.ui.text();
    assert.match(out, /Teams app: not published to your org's app catalog\. The sign-in to Microsoft Graph Command Line Tools wasn't finished within 5 minutes\./);
    assert.match(out, /2\. If Analytics Hub is listed, selects it, then Upload file on its page\. If not, selects Upload new app, then Upload\. Either way, chooses \/installs\/AnalyticsHub-Teams\.zip/);
    assert.equal(t.az.teamsApp, undefined);
    assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
  });
}

test('with the plan, the admin can choose to upload the Teams app by hand: no sign-in, and the steps at the end', async () => {
  const t = setup({ answers: [false] });
  await askToPublishTeamsApp(t.ctx, '0.6.7');
  assert.deepEqual(t.ui.asked, [PUBLISH_QUESTION]);
  assert.equal(t.ctx.teamsCatalog?.skip, true);
  assert.deepEqual(teamsAppPlanRow(t.ctx, '0.6.7'), { kind: 'Teams app', name: 'Analytics Hub in your org\'s app catalog', isNew: false, detail: 'Not published by the installer. You chose to upload it by hand. The installer prints the steps for a Teams Administrator to upload it.' });
  await signInForTeamsApp(t.ctx, '0.6.7');
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, [], 'no sign-in');
  const out = t.ui.text();
  assert.doesNotMatch(out, /Signing in once more/);
  assert.match(out, /Teams app: not published to your org's app catalog\. You chose to upload it by hand\. To have the installer publish it, run the installer again, choose Repair or change, and say yes to publishing it\./);
  assert.match(out, /2\. If Analytics Hub is listed, selects it, then Upload file on its page\. If not, selects Upload new app, then Upload\. Either way, chooses \/installs\/AnalyticsHub-Teams\.zip/);
  assert.equal(t.az.teamsApp, undefined);
  assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
});

test('the plan asks about publishing the Teams app only when this run would sign in for it, and yes is the default', async () => {
  const yes = setup();
  await askToPublishTeamsApp(yes.ctx, '0.6.7');
  assert.deepEqual(yes.ui.asked, [PUBLISH_QUESTION]);
  assert.equal(yes.ctx.teamsCatalog?.skip, false);
  assert.match(teamsAppPlanRow(yes.ctx, '0.6.7').detail, /^Publish version 0\.6\.7/);

  const back = setup({ answers: [false] });
  await askToPublishTeamsApp(back.ctx, '0.6.7');
  await askToPublishTeamsApp(back.ctx, '0.6.7');
  assert.equal(back.ui.asked.length, 2, 'asked again when the plan is shown again');
  assert.equal(back.ctx.teamsCatalog?.skip, true, 'with the last answer as the default');

  for (const quiet of [setup({ teamsApp: record('app-1', '0.6.7') }), setup({ roles: [GLOBAL_READER] }), setup({ catalog: false })]) {
    await askToPublishTeamsApp(quiet.ctx, '0.6.7');
    assert.deepEqual(quiet.ui.asked, [], 'up to date, no role, or no way to ask for the permission');
    assert.deepEqual(quiet.catalog.calls, []);
  }
});

for (const c of [
  { label: 'a 403', err: graphError(403, 'GET /v1.0/appCatalogs/teamsApps returned 403 Forbidden'), reason: /Microsoft Graph refused it \(403\)\. Changing your org's app catalog takes the Teams Administrator or Global Administrator role, active, and consent to "Read and write to all app catalogs"/ },
  { label: 'a dropped connection', err: new Error('GET https://graph.microsoft.com/v1.0/appCatalogs/teamsApps failed: fetch failed'), reason: /The network connection dropped\./ },
]) {
  test(`${c.label} from Microsoft Graph doesn't fail the install`, async () => {
    const t = setup();
    t.catalog.failures.find = [c.err];
    await publishTeamsApp(t.ctx, pkg('0.6.7'));
    const out = t.ui.text();
    assert.match(out, c.reason);
    assert.match(out, /1\. Opens Teams admin center > Teams apps > Manage apps/);
    assert.match(out, /2\. If Analytics Hub is listed, selects it/);
    assert.equal(t.az.teamsApp, undefined);
    assert.deepEqual(t.az.status?.pendingAdminActions, [UPLOAD_PENDING]);
  });
}

test('publishing clears the Teams app\'s pending action and keeps the others', async () => {
  const other = 'Grant delegated consent to the web app.';
  const t = setup({ pending: [other, UPLOAD_PENDING] });
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.az.status?.pendingAdminActions, [other]);
  const failed = setup({ catalog: false, pending: [other, `${TEAMS_APP_PENDING}: approve Analytics Hub in ${WHERE}, then run the installer again.`] });
  await publishTeamsApp(failed.ctx, pkg('0.6.7'));
  assert.deepEqual(failed.az.status?.pendingAdminActions, [other, UPLOAD_PENDING], 'a failed run replaces the Teams action rather than adding another');
});

test('after the app registration changes, it publishes the new app and removes the old one', async () => {
  const t = setup({ apps: [catalogApp('old-app', '0.6.7', { externalId: OLD_CLIENT_ID })], teamsApp: record('old-app', '0.6.7', OLD_CLIENT_ID) });
  await signInForTeamsApp(t.ctx, '0.6.7');
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.deepEqual(t.catalog.calls, ['signIn', `find ${CLIENT_ID}`, `publish ${CLIENT_ID} 0.6.7`, 'remove old-app']);
  assert.deepEqual(t.catalog.apps.map((a) => a.externalId), [CLIENT_ID]);
  assert.equal(t.az.teamsApp?.externalId, CLIENT_ID);
  assert.match(t.ui.text(), /Teams app: removed the one published for an earlier app registration/);
});

test('when the old app can\'t be removed, it says which one to delete', async () => {
  const t = setup({ apps: [catalogApp('old-app', '0.6.7', { externalId: OLD_CLIENT_ID })], teamsApp: record('old-app', '0.6.7', OLD_CLIENT_ID) });
  t.catalog.failures.remove = [graphError(403)];
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.equal(t.az.teamsApp?.externalId, CLIENT_ID);
  assert.match(t.ui.text(), new RegExp(`couldn't remove the Analytics Hub published for an earlier app registration \\(App ID ${OLD_CLIENT_ID}\\)\\. Microsoft Graph refused it \\(403\\)\\..* Delete it in https://admin\\.teams\\.microsoft\\.com/policies/manage-apps`));
});

test('with an earlier registration\'s app in the catalog, the manual steps say which app is which', async () => {
  const t = setup({ catalog: false, teamsApp: record('old-app', '0.6.6', OLD_CLIENT_ID) });
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  const out = t.ui.text();
  assert.match(out, new RegExp(`2\\. Deletes the Analytics Hub with App ID ${OLD_CLIENT_ID}, which was published for an earlier app registration\\.`));
  assert.match(out, new RegExp(`3\\. If the Analytics Hub with App ID ${CLIENT_ID} is listed, selects it, then Upload file on its page\\. If not, selects Upload new app, then Upload\\.`));
  assert.equal(t.az.teamsApp?.externalId, OLD_CLIENT_ID, 'kept, so a later run removes it');
});

test('uninstall removes the app the installer published', async () => {
  const t = setup();
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  t.rerun();
  await removeTeamsApp(t.ctx);
  assert.deepEqual(t.catalog.calls, ['signIn', 'remove catalog-app-1']);
  assert.equal(t.catalog.apps.length, 0);
  assert.equal(t.az.teamsApp, undefined);
  assert.match(t.ui.text(), /Teams app: removed Analytics Hub from your org's app catalog/);
});

test('uninstall removes a hand upload the installer took on, too', async () => {
  const t = setup({ apps: [catalogApp('uploaded-by-hand', '0.6.7')] });
  await publishTeamsApp(t.ctx, pkg('0.6.7'));
  assert.equal(t.az.teamsApp?.id, 'uploaded-by-hand');
  t.rerun();
  await removeTeamsApp(t.ctx);
  assert.deepEqual(t.catalog.calls, ['signIn', 'remove uploaded-by-hand']);
  assert.equal(t.catalog.apps.length, 0);
  assert.equal(t.az.teamsApp, undefined);
  assert.match(t.ui.text(), /Teams app: removed Analytics Hub from your org's app catalog/);
});

test('uninstall carries on when the app is gone already', async () => {
  const t = setup({ teamsApp: record('deleted-by-hand') });
  await removeTeamsApp(t.ctx);
  assert.deepEqual(t.catalog.calls, ['signIn', 'remove deleted-by-hand']);
  assert.equal(t.az.teamsApp, undefined);
});

test('uninstall soon after publishing keeps the record when Microsoft Graph doesn\'t find the app yet', async () => {
  const t = setup({ teamsApp: { ...record('just-published'), publishedAt: '2026-06-01T11:40:00.000Z' } });
  await removeTeamsApp(t.ctx);
  assert.deepEqual(t.catalog.calls, ['signIn', 'remove just-published']);
  assert.equal(t.az.teamsApp?.id, 'just-published', 'kept, so the installer can still find the app');
  const out = t.ui.text();
  assert.match(out, /Teams app: not removed from your org's app catalog\. Microsoft Graph didn't find Analytics Hub, which the installer published or updated 20 minutes ago\. Graph can take half an hour or more to find a new app, so it may still be there\./);
  assert.match(out, /Delete it in Teams admin center > Teams apps > Manage apps \(https:\/\/admin\.teams\.microsoft\.com\/policies\/manage-apps\): select Analytics Hub, then Delete\./);
  assert.doesNotMatch(out, /removed Analytics Hub/);

  const hours = setup({ teamsApp: { ...record('published-this-morning'), publishedAt: '2026-06-01T07:00:00.000Z' } });
  await removeTeamsApp(hours.ctx);
  assert.match(hours.ui.text(), /which the installer published or updated 5 hours ago\./);
  assert.equal(hours.az.teamsApp?.id, 'published-this-morning');

  const old = setup({ teamsApp: { ...record('published-two-days-ago'), publishedAt: '2026-05-30T12:00:00.000Z' } });
  await removeTeamsApp(old.ctx);
  assert.equal(old.az.teamsApp, undefined, 'after a day, not found means gone');
  assert.match(old.ui.text(), /Teams app: removed Analytics Hub from your org's app catalog/);
});

test('when uninstall can\'t remove the app, it keeps the record and prints the steps', async () => {
  const t = setup({ apps: [catalogApp('app-1', '0.6.7')], teamsApp: record('app-1') });
  t.catalog.failures.remove = [graphError(403)];
  await removeTeamsApp(t.ctx);
  assert.equal(t.az.teamsApp?.id, 'app-1');
  const out = t.ui.text();
  assert.match(out, /Teams app: not removed from your org's app catalog\. Microsoft Graph refused it \(403\)/);
  assert.match(out, /Delete it in Teams admin center > Teams apps > Manage apps \(https:\/\/admin\.teams\.microsoft\.com\/policies\/manage-apps\): select Analytics Hub, then Delete\./);

  const cli = setup({ catalog: false, teamsApp: record('app-1') });
  await removeTeamsApp(cli.ctx);
  assert.match(cli.ui.text(), /Teams app: not removed from your org's app catalog\. You signed in with the Azure CLI/);
  assert.equal(cli.az.teamsApp?.id, 'app-1');
});

test('uninstall leaves alone an app the installer never looked after, such as a hand upload it didn\'t take on', async () => {
  const t = setup({ apps: [catalogApp('uploaded-by-hand', '0.6.7')] });
  await removeTeamsApp(t.ctx);
  assert.deepEqual(t.catalog.calls, []);
  assert.deepEqual(t.graphCalls, []);
  assert.equal(t.catalog.apps.length, 1);
  assert.match(t.ui.text(), /If Analytics Hub was uploaded to your org's Teams app catalog by hand, a Teams Administrator deletes it there\. Delete it in Teams admin center/);

  const none = setup();
  delete none.az.teamsPackage;
  await removeTeamsApp(none.ctx);
  assert.equal(none.ui.text(), '', 'nothing to say without a package');
});

test('catalogErrorReason says what went wrong in words an admin can act on', () => {
  assert.match(catalogErrorReason(new Error('AADSTS65004: User declined to consent to access the app.')), /^The app catalog permission, .*, was declined at sign-in\.$/);
  assert.match(catalogErrorReason(new Error('AADSTS90095: Admin consent is required.')), /needs admin consent/);
  assert.match(catalogErrorReason(new Error('AADSTS65001: The user or administrator has not consented.')), /^Microsoft Graph Command Line Tools hasn't been given/);
  assert.match(catalogErrorReason(new Error('AADSTS50105: The signed in user is not assigned to a role.')), /only lets assigned users sign in/);
  assert.match(catalogErrorReason(new Error('AADSTS53003: Access has been blocked by Conditional Access policies.')), /Conditional Access policy blocked/);
  assert.match(catalogErrorReason(new Error('AADSTS7000112: Application is disabled.')), /turned off in your tenant/);
  assert.match(catalogErrorReason(new Error('AADSTS700016: Application not found in the directory.')), /isn't available in your tenant/);
  const inBody = new HttpError('POST /v1.0/appCatalogs/teamsApps returned 401', { status: 401, method: 'POST', url: 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps', body: { error: { message: 'AADSTS65004: declined' } } });
  assert.match(catalogErrorReason(inBody), /was declined at sign-in/);
  assert.match(catalogErrorReason(graphError(401)), /^Microsoft Graph refused it \(401\)\./);
  assert.equal(catalogErrorReason(graphError(400, 'POST /v1.0/appCatalogs/teamsApps returned 400 BadRequest: The manifest is not valid.\nTrace ID: 123')), 'Teams didn\'t accept the package: POST /v1.0/appCatalogs/teamsApps returned 400 BadRequest: The manifest is not valid.');
  assert.equal(catalogErrorReason(new Error('read ECONNRESET')), 'The network connection dropped.');
  assert.equal(catalogErrorReason(graphError(500, 'POST /v1.0/appCatalogs/teamsApps returned 500 InternalServerError')), 'POST /v1.0/appCatalogs/teamsApps returned 500 InternalServerError');
  assert.equal(catalogErrorReason(undefined), 'Something went wrong.');
});

test('the plan says what this run does with the Teams app', () => {
  const t = setup();
  t.ctx.teamsCatalog = { canTry: true, role: 'Teams Administrator' };
  const signIn = 'You sign in once more for this, to Microsoft Graph Command Line Tools.';
  assert.deepEqual(teamsAppPlanRow(t.ctx, '0.6.7'), { kind: 'Teams app', name: 'Analytics Hub in your org\'s app catalog', isNew: true, detail: `Publish version 0.6.7, or update the app if it's there already. ${signIn}` });
  t.az.teamsApp = record('app-1', '0.6.6');
  assert.deepEqual(teamsAppPlanRow(t.ctx, '0.6.7'), { kind: 'Teams app', name: 'Analytics Hub in your org\'s app catalog', isNew: false, detail: `Update to version 0.6.7. ${signIn}` });
  t.az.teamsApp = record('app-1', '0.6.7');
  assert.equal(teamsAppPlanRow(t.ctx, '0.6.7').detail, 'Already published (version 0.6.7).');
  delete t.az.teamsApp;
  t.ctx.teamsCatalog = { canTry: false, reason: 'No role.' };
  assert.deepEqual(teamsAppPlanRow(t.ctx, '0.6.7'), { kind: 'Teams app', name: 'Analytics Hub in your org\'s app catalog', isNew: false, detail: 'Not published by the installer. No role. The installer prints the steps for a Teams Administrator to upload it.' });
});

test('the summary says where to find the Teams app, or what an admin still has to do', async () => {
  const published = setup();
  await publishTeamsApp(published.ctx, pkg('0.6.7'));
  await azureSummary(published.ctx);
  assert.match(published.ui.text(), /Teams: +Analytics Hub 0\.6\.7 in your org's app catalog, for Teams, Outlook and the Microsoft 365 Copilot app\./);

  const manual = setup({ catalog: false });
  await publishTeamsApp(manual.ctx, pkg('0.6.7'));
  await azureSummary(manual.ctx);
  assert.match(manual.ui.text(), /Teams: +Not published yet\. A Teams Administrator needs to upload \/installs\/AnalyticsHub-Teams\.zip in Teams admin center > Teams apps > Manage apps \(https:\/\/admin\.teams\.microsoft\.com\/policies\/manage-apps\)\./);

  const packageOnly = setup();
  await azureSummary(packageOnly.ctx);
  assert.match(packageOnly.ui.text(), /Teams: +\/installs\/AnalyticsHub-Teams\.zip/);
});

/**
 * Microsoft Graph behind a scripted fetch.
 * @param {Array<() => { status?: number, body?: any }>} script
 */
function graphHttp(script) {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body?: any }[]} */
  const calls = [];
  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        const step = script.shift();
        if (!step) throw new Error(`Unexpected request: ${init.method} ${url}`);
        const r = step();
        return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    )
  );
  const http = createClient({ baseUrl: 'https://graph.microsoft.com/v1.0', getToken: async () => 'token', fetchImpl, sleep: async () => {} });
  return { http, calls };
}

test('appCatalogApi finds the org\'s own app by its manifest ID, with its versions', async () => {
  const g = graphHttp([() => ({ body: { value: [{ id: 'ours', distributionMethod: 'organization' }, { id: 'store-app', distributionMethod: 'store' }] } })]);
  const apps = await appCatalogApi(g.http).find("it's");
  assert.deepEqual(apps.map((a) => a.id), ['ours']);
  const url = new URL(g.calls[0].url);
  assert.equal(url.pathname, '/v1.0/appCatalogs/teamsApps');
  assert.equal(url.searchParams.get('$filter'), "distributionMethod eq 'organization' and externalId eq 'it''s'");
  assert.equal(url.searchParams.get('$expand'), 'appDefinitions');
});

test('appCatalogApi uploads the package as application/zip, and never twice', async () => {
  const zip = new Uint8Array([0x50, 0x4b, 3, 4]);
  const g = graphHttp([() => ({ status: 201, body: { id: 'new-app' } }), () => ({ status: 503 })]);
  const api = appCatalogApi(g.http);
  assert.deepEqual(await api.publish(zip), { id: 'new-app' });
  assert.equal(g.calls[0].method, 'POST');
  assert.equal(g.calls[0].url, 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps');
  assert.equal(g.calls[0].headers['Content-Type'], 'application/zip');
  assert.equal(g.calls[0].body, zip);
  await assert.rejects(api.publish(zip), (err) => err instanceof HttpError && err.status === 503);
  assert.equal(g.calls.length, 2, 'a 503 is not retried: a second upload could add a second app');
});

test('appCatalogApi updates and deletes an app by its catalog ID, and signs in on request', async () => {
  const g = graphHttp([() => ({ status: 201, body: {} }), () => ({ status: 204 })]);
  let signIns = 0;
  const api = appCatalogApi(g.http, async () => {
    signIns++;
  });
  await api.signIn();
  assert.equal(signIns, 1);
  await api.update('a/b', new Uint8Array([1]));
  await api.remove('a/b');
  assert.deepEqual(g.calls.map((c) => `${c.method} ${c.url}`), ['POST https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/a%2Fb/appDefinitions', 'DELETE https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/a%2Fb']);
  assert.equal(g.calls[0].headers['Content-Type'], 'application/zip');
});

test('the package carries the installer version without a pre-release tag, and returns its bytes', async () => {
  assert.equal(manifestVersion('0.6.7'), '0.6.7');
  assert.equal(manifestVersion('0.6.7-beta.1'), '0.6.7');
  assert.equal(manifestVersion('0.6.7+build.5'), '0.6.7');
  const dir = mkdtempSync(join(tmpdir(), 'teams-package-'));
  try {
    const outFile = join(dir, 'AnalyticsHub-Teams.zip');
    const r = await writeTeamsPackage({ clientId: CLIENT_ID, fqdn: 'vlens.example.com', appIdUri: `api://vlens.example.com/${CLIENT_ID}`, version: '0.6.7-rc.1', outFile });
    assert.equal(r.skipped, false);
    if (r.skipped) return;
    assert.equal(r.path, outFile);
    assert.equal(r.version, '0.6.7');
    assert.deepEqual(readFileSync(outFile), Buffer.from(r.zip));
    const manifest = readManifest(r.zip);
    assert.equal(manifest.id, CLIENT_ID);
    assert.equal(manifest.version, '0.6.7');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
