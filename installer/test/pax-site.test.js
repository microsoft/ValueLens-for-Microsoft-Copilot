// @ts-check
/** The PAX route's SharePoint folder: the addresses people paste, the app's access to the site, and the check as the app. */
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { PRODUCT } from '../src/product.js';
import { paxPaths } from '../src/steps/pax/local.js';
import {
  confirmFolderAccess,
  describeFolder,
  ensureSiteGrant,
  EXAMPLE_FOLDER,
  folderConfig,
  folderValidator,
  parseSharePointFolder,
  pnpGrantCommand,
  recordFolderCheck,
  removeRetiredGrants,
  removeSiteGrant,
  sameSite,
  showSiteGrant,
  SITE_ADMIN,
  siteGrantCommands,
  siteRemovalCommands,
} from '../src/steps/pax/site.js';
import { appName } from '../src/target.js';
import { fakeAzureGraph, fakeCtx, fakeUi, httpError } from './fakes.js';
import { failed, fakePaxHost, printed } from './pax-fakes.js';

/** @typedef {import('node:test').TestContext} TestContext */

const NOW = '2026-06-01T12:00:00.000Z';
const TENANT = '11111111-2222-4333-8444-555555555555';
const APP_ID = '0a1b2c3d-0000-4000-8000-00000000abcd';
const OTHER_APP = '0a1b2c3d-0000-4000-8000-00000000ffff';
const SITE_URL = 'https://contoso.sharepoint.com/sites/Analytics';
const SITE_PATH = 'contoso.sharepoint.com:/sites/Analytics';
const SITE_ID = 'contoso.sharepoint.com,aaaaaaaa-0000-4000-8000-000000000001,bbbbbbbb-0000-4000-8000-000000000001';
const OLD_URL = 'https://contoso.sharepoint.com/sites/Finance';
const OLD_PATH = 'contoso.sharepoint.com:/sites/Finance';
const OLD_ID = 'contoso.sharepoint.com,aaaaaaaa-0000-4000-8000-000000000002,bbbbbbbb-0000-4000-8000-000000000002';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SIGN_IN_FAILED = "Couldn't sign in to Microsoft Graph as the app: AADSTS7000215: Invalid client secret provided.";
const NO_ADMIN = `Couldn't take back the app's access to`;

/** @param {string} why */
const notAFolder = (why) =>
  `${why} Open the folder in its document library, then copy the address from the browser's address bar, like ${EXAMPLE_FOLDER}.`;

/**
 * What parseSharePointFolder gives for a folder on the Analytics site.
 * @param {string} folderUrl @param {string} library @param {string} folderPath
 */
const analytics = (folderUrl, library, folderPath) => ({ folderUrl, siteUrl: SITE_URL, sitePath: SITE_PATH, library, folderPath });

const COPILOT = analytics(`${SITE_URL}/Shared%20Documents/Copilot`, 'Shared Documents', '/Copilot');
const FINANCE = { folderUrl: `${OLD_URL}/Shared%20Documents/Copilot`, siteUrl: OLD_URL, sitePath: OLD_PATH, library: 'Shared Documents', folderPath: '/Copilot' };

/** What the UI printed, without colour. @param {{ text: () => string }} out */
const plain = (out) => out.text().replace(/\x1b\[[0-9;]*m/g, '');

/** A PAX install record for the Copilot folder on the Analytics site. */
function paxConfig() {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = TENANT;
  config.app.appId = APP_ID;
  config.sharePoint = { ...COPILOT };
  return config;
}

/**
 * fakeAzureGraph with the site calls site.js makes: a site by its path, and the app permissions on
 * it, kept by Graph's site ID. `failures[name]` makes the next call to a method throw.
 */
function siteGraph() {
  const g = fakeAzureGraph();
  /** @type {Record<string, string>} */
  const sites = { [SITE_PATH.toLowerCase()]: SITE_ID, [OLD_PATH.toLowerCase()]: OLD_ID };
  /** @type {Record<string, any[]>} */
  const permissions = { [SITE_ID]: [], [OLD_ID]: [] };
  let n = 0;
  /** @param {string} name @param {string[]} args */
  const called = (name, args) => {
    g.calls.push([name, ...args].join(' '));
    const err = g.failures[name]?.shift();
    if (err) throw err;
  };
  /** @param {string} siteId @param {string} id */
  const find = (siteId, id) => {
    const p = permissions[siteId]?.find((x) => x.id === id);
    if (!p) throw httpError(404, 'Item not found');
    return p;
  };
  const api = Object.assign(g.api, {
    site: async (/** @type {string} */ path) => {
      called('site', [path]);
      const id = sites[path.toLowerCase()];
      if (!id) throw httpError(404, 'Requested site could not be found');
      return { id, webUrl: `https://${path.replace(':', '')}` };
    },
    sitePermissions: async (/** @type {string} */ siteId) => {
      called('sitePermissions', [siteId]);
      if (!permissions[siteId]) throw httpError(404, 'Requested site could not be found');
      // The list says who each permission is for. Its roles come from sitePermission.
      return structuredClone(permissions[siteId]).map((p) => Object.assign(p, { roles: undefined }));
    },
    sitePermission: async (/** @type {string} */ siteId, /** @type {string} */ id) => {
      called('sitePermission', [siteId, id]);
      return structuredClone(find(siteId, id));
    },
    updateSitePermission: async (/** @type {string} */ siteId, /** @type {string} */ id, /** @type {string} */ role) => {
      called('updateSitePermission', [siteId, id, role]);
      const p = find(siteId, id);
      p.roles = [role];
      return structuredClone(p);
    },
    grantSitePermission: async (/** @type {string} */ siteId, /** @type {string} */ appId, /** @type {string} */ displayName, /** @type {string} */ role) => {
      called('grantSitePermission', [siteId, appId, displayName, role]);
      const p = { id: `perm-${++n}`, roles: [role], grantedToIdentitiesV2: [{ application: { id: appId, displayName } }] };
      (permissions[siteId] ??= []).push(p);
      return structuredClone(p);
    },
    deleteSitePermission: async (/** @type {string} */ siteId, /** @type {string} */ id) => {
      called('deleteSitePermission', [siteId, id]);
      find(siteId, id);
      permissions[siteId] = permissions[siteId].filter((p) => p.id !== id);
    },
  });
  return { ...g, api, permissions };
}

/** A permission on a site. @param {string} id @param {string} appId @param {string[]} roles */
const permission = (id, appId, roles) => ({ id, roles, grantedToIdentitiesV2: [{ application: { id: appId, displayName: 'An app' } }] });

/**
 * A PAX install's context: a fake Graph, a fake UI and a fake PC to check the folder from.
 * @param {TestContext} t
 * @param {{ ui?: Parameters<typeof fakeUi>[0], folderCheck?: Record<string, any> }} [o]
 */
function paxCtx(t, o = {}) {
  const graph = siteGraph();
  const pc = fakePaxHost({ now: () => new Date(NOW), ...(o.folderCheck ? { folderCheck: o.folderCheck } : {}) });
  t.after(() => rmSync(pc.base, { recursive: true, force: true }));
  const out = fakeUi(o.ui);
  const config = paxConfig();
  const { ctx, sleeps, saves } = fakeCtx({ config, graph: graph.api, ui: out.ui, sources: /** @type {any} */ ({}) });
  ctx.paxHost = pc.host;
  const sp = /** @type {NonNullable<typeof config.sharePoint>} */ (config.sharePoint);
  return { ctx, config, sp, graph, pc, out, sleeps, saves, checks: () => pc.calls.filter((c) => c.key === 'refresh check').length };
}

test('pax site: parseSharePointFolder reads a folder address in the forms people paste', () => {
  const forms = [
    `${SITE_URL}/Shared Documents/Copilot`,
    `${SITE_URL}/Shared%20Documents/Copilot`,
    `${SITE_URL}/Shared%20Documents/Copilot/`,
    `${SITE_URL}/Shared%20Documents/Copilot//`,
    `${SITE_URL}/Shared%20Documents/Copilot?web=1`,
    `${SITE_URL}/Shared%20Documents/Copilot?csf=1&web=1&e=AbC123`,
    `${SITE_URL}/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FAnalytics%2FShared%20Documents%2FCopilot&viewid=0b1c2d3e`,
    `${SITE_URL}/Shared Documents/Forms/AllItems.aspx?id=/sites/Analytics/Shared Documents/Copilot`,
    `${SITE_URL}/Shared%20Documents/Forms/AllItems.aspx?RootFolder=%2Fsites%2FAnalytics%2FShared%20Documents%2FCopilot&FolderCTID=0x0120`,
    'https://contoso.sharepoint.com/:f:/r/sites/Analytics/Shared%20Documents/Copilot?csf=1&web=1&e=AbC123',
    'contoso.sharepoint.com/sites/Analytics/Shared%20Documents/Copilot',
    'https://Contoso.SharePoint.com/sites/Analytics/Shared%20Documents/Copilot',
    `  "${SITE_URL}/Shared%20Documents/Copilot"  `,
    `'${SITE_URL}/Shared%20Documents/Copilot'`,
    `<${SITE_URL}/Shared%20Documents/Copilot>`,
  ];
  for (const text of forms) assert.deepEqual(parseSharePointFolder(text), COPILOT, text);
});

test('pax site: parseSharePointFolder keeps spaces and other characters in names, and encodes them in the address', () => {
  const spaced = analytics(`${SITE_URL}/Shared%20Documents/Copilot%20Reports/2026%20Q1`, 'Shared Documents', '/Copilot Reports/2026 Q1');
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared Documents/Copilot Reports/2026 Q1`), spaced);
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/Copilot%20Reports/2026%20Q1/`), spaced);
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/R%26D`), analytics(`${SITE_URL}/Shared%20Documents/R%26D`, 'Shared Documents', '/R&D'));
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared Documents/Données`), analytics(`${SITE_URL}/Shared%20Documents/Donn%C3%A9es`, 'Shared Documents', '/Données'));
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/100%25%20Done`), analytics(`${SITE_URL}/Shared%20Documents/100%25%20Done`, 'Shared Documents', '/100% Done'));
  assert.equal(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/Reports.2026`).folderPath, '/Reports.2026');
  // The browser's address bar turns a backslash into a slash, and so does the parser.
  assert.equal(parseSharePointFolder(`${SITE_URL}/Shared Documents/Copilot\\Reports`).folderPath, '/Copilot/Reports');
});

test("pax site: parseSharePointFolder reads a % typed into a folder name, which the browser doesn't escape", () => {
  assert.equal(parseSharePointFolder(`${SITE_URL}/Shared Documents/100% Done`).folderPath, '/100% Done');
  assert.equal(parseSharePointFolder(`${SITE_URL}/Shared Documents/100%/Données`).folderPath, '/100%/Données');
  assert.equal(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/50%-60%25`).folderPath, '/50%-60%');
});

test('pax site: parseSharePointFolder reads a library root, a team site and the root site', () => {
  const library = analytics(`${SITE_URL}/Shared%20Documents`, 'Shared Documents', '/');
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared%20Documents`), library);
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/`), library);
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/Forms/AllItems.aspx`), library);
  assert.deepEqual(parseSharePointFolder(`${SITE_URL}/Shared%20Documents/forms/allitems.aspx?viewid=0b1c2d3e`), library);
  assert.deepEqual(parseSharePointFolder('https://contoso.sharepoint.com/teams/Finance/Documents/Copilot'), {
    folderUrl: 'https://contoso.sharepoint.com/teams/Finance/Documents/Copilot',
    siteUrl: 'https://contoso.sharepoint.com/teams/Finance',
    sitePath: 'contoso.sharepoint.com:/teams/Finance',
    library: 'Documents',
    folderPath: '/Copilot',
  });
  assert.deepEqual(parseSharePointFolder('https://contoso.sharepoint.com/Shared%20Documents/Copilot/'), {
    folderUrl: 'https://contoso.sharepoint.com/Shared%20Documents/Copilot',
    siteUrl: 'https://contoso.sharepoint.com',
    sitePath: 'contoso.sharepoint.com',
    library: 'Shared Documents',
    folderPath: '/Copilot',
  });
  assert.deepEqual(parseSharePointFolder('https://contoso.sharepoint.com/sites/Copilot%20Analytics/Shared%20Documents'), {
    folderUrl: 'https://contoso.sharepoint.com/sites/Copilot%20Analytics/Shared%20Documents',
    siteUrl: 'https://contoso.sharepoint.com/sites/Copilot%20Analytics',
    sitePath: 'contoso.sharepoint.com:/sites/Copilot%20Analytics',
    library: 'Shared Documents',
    folderPath: '/',
  });
});

test("pax site: parseSharePointFolder says what's wrong with anything that isn't a SharePoint folder", () => {
  const empty = `Paste the folder's address, like ${EXAMPLE_FOLDER}.`;
  const host = 'Use a folder on SharePoint Online, at https://<tenant>.sharepoint.com.';
  const fileLink = "That's a link to a file. Paste the address of the folder it's in.";
  const sharing = "That's a sharing link. Open it, then copy the folder's address from the browser's address bar.";
  const file = "That's a file. Paste the address of the folder it's in.";
  /** @param {string} name */
  const untidy = (name) => `"${name}" can't be a folder's name: SharePoint doesn't allow spaces at the start or end, or a full stop at the end. Check the address.`;
  /** @type {[string, string][]} */
  const cases = [
    ['', empty],
    ['   ""  ', empty],
    ['Copilot reports', notAFolder("That isn't a web address.")],
    ['12345', notAFolder("That isn't a web address.")],
    [
      'https://contoso-my.sharepoint.com/personal/megan_contoso_com/Documents/Copilot',
      "That's a OneDrive folder. Use a folder in a SharePoint site's document library, so the refresh doesn't depend on one person's OneDrive.",
    ],
    ['https://contoso.example.com/sites/Analytics/Shared%20Documents/Copilot', host],
    ['https://contoso.sharepoint.com.example.com/sites/Analytics/Shared%20Documents/Copilot', host],
    ['https://contoso.sharepoint.de/sites/Analytics/Shared%20Documents/Copilot', host],
    ['C:\\Users\\megan\\Documents\\Copilot', host],
    ['http://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/Copilot', "Use the folder's https:// address."],
    ['ftp://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/Copilot', "Use the folder's https:// address."],
    ['https://contoso.sharepoint.com/:x:/r/sites/Analytics/Shared%20Documents/usage.xlsx?d=w123&csf=1', fileLink],
    ['https://contoso.sharepoint.com/:w:/r/sites/Analytics/Shared%20Documents/notes.docx', fileLink],
    ['https://contoso.sharepoint.com/:f:/s/Analytics/EabcDEF123', sharing],
    ['https://contoso.sharepoint.com/:f:/g/personal/megan_contoso_com/EabcDEF123', sharing],
    [`${SITE_URL}/_layouts/15/viewlsts.aspx`, notAFolder("That's a SharePoint page, not a folder.")],
    [`${SITE_URL}/_api/web`, notAFolder("That's a SharePoint page, not a folder.")],
    [`${SITE_URL}/SitePages/Home.aspx`, notAFolder("That's a page, not a folder.")],
    [`${SITE_URL}/Lists/Tasks/AllItems.aspx`, notAFolder("That's a page, not a folder.")],
    [SITE_URL, notAFolder("That's a site, not a folder.")],
    [`${SITE_URL}/`, notAFolder("That's a site, not a folder.")],
    ['https://contoso.sharepoint.com/sites/', notAFolder("That isn't a site or a folder.")],
    ['https://contoso.sharepoint.com', notAFolder("That's the tenant's root site, not a folder.")],
    ['https://contoso.sharepoint.com/', notAFolder("That's the tenant's root site, not a folder.")],
    [`${SITE_URL}/Lists/Tasks`, "That's a list, not a document library. Use a folder in a document library, such as Documents."],
    [`${SITE_URL}/Shared%20Documents/Copilot/usage.csv`, file],
    [`${SITE_URL}/Shared%20Documents/Copilot/Usage.XLSX`, file],
    [`${SITE_URL}/Shared%20Documents/Copilot.pbix`, file],
    [`${SITE_URL}/Shared%20Documents/Q1:Q2`, `"Q1:Q2" can't be part of a SharePoint folder's address. Check the address.`],
    [`${SITE_URL}/Shared%20Documents/a%2Ab`, `"a*b" can't be part of a SharePoint folder's address. Check the address.`],
    [`${SITE_URL}/Shared%20Documents/a%7Cb`, `"a|b" can't be part of a SharePoint folder's address. Check the address.`],
    // Names the scheduled refresh refuses (refresh.ps1's Test-FileName).
    [`${SITE_URL}/Shared%20Documents/Old.`, untidy('Old.')],
    [`${SITE_URL}/Shared%20Documents/Old./2026`, untidy('Old.')],
    [`${SITE_URL}/Shared%20Documents/%20Reports`, untidy(' Reports')],
    [`${SITE_URL}/Shared%20Documents/Reports%20/2026`, untidy('Reports ')],
    [
      `${SITE_URL}/Shared%20Documents/Forms/AllItems.aspx?id=/sites/Analytics/Shared%20Documents/../Copilot`,
      `".." can't be part of a SharePoint folder's address. Check the address.`,
    ],
  ];
  for (const [text, message] of cases) {
    assert.throws(() => parseSharePointFolder(text), { message }, text);
    assert.equal(folderValidator(text), message, text);
  }
  assert.equal(folderValidator(`${SITE_URL}/Shared Documents/Copilot`), true);
});

test('pax site: describeFolder and sameSite', () => {
  assert.equal(describeFolder(COPILOT), `Shared Documents/Copilot on ${SITE_URL}`);
  assert.equal(describeFolder({ ...COPILOT, folderPath: '/' }), `Shared Documents on ${SITE_URL}`);
  assert.equal(describeFolder(parseSharePointFolder(`${SITE_URL}/Shared Documents/Copilot Reports/2026`)), `Shared Documents/Copilot Reports/2026 on ${SITE_URL}`);
  assert.equal(sameSite(COPILOT, parseSharePointFolder(`${SITE_URL}/Documents/Other`)), true);
  assert.equal(sameSite(COPILOT, { ...COPILOT, sitePath: SITE_PATH.toUpperCase() }), true);
  assert.equal(sameSite(COPILOT, FINANCE), false);
  assert.equal(sameSite(COPILOT, { ...COPILOT, sitePath: 'contoso.sharepoint.com' }), false);
});

test("pax site: folderConfig keeps the app's access to the site when the folder stays on it", () => {
  const moved = parseSharePointFolder(`${SITE_URL}/Documents/Copilot`);
  const previous = { ...COPILOT, siteId: SITE_ID, granted: true, grantId: 'perm-1' };
  const before = structuredClone(previous);
  assert.deepEqual(folderConfig(moved, previous), { ...moved, siteId: SITE_ID, granted: true, grantId: 'perm-1' });
  assert.deepEqual(previous, before);
  assert.deepEqual(folderConfig(moved, { ...COPILOT, siteId: SITE_ID, pendingAdminGrant: true }), { ...moved, siteId: SITE_ID, pendingAdminGrant: true });
  assert.deepEqual(folderConfig(COPILOT), COPILOT);
});

test("pax site: folderConfig drops the old site's details, and lists the app's access to it to take back", () => {
  assert.deepEqual(folderConfig(FINANCE, { ...COPILOT, siteId: SITE_ID, granted: true, grantId: 'perm-1' }), {
    ...FINANCE,
    retiredGrants: [{ siteUrl: SITE_URL, sitePath: SITE_PATH, siteId: SITE_ID, grantId: 'perm-1' }],
  });
  // An administrator gave the access, so there's no grant ID.
  assert.deepEqual(folderConfig(FINANCE, { ...COPILOT, granted: true }), { ...FINANCE, retiredGrants: [{ siteUrl: SITE_URL, sitePath: SITE_PATH }] });
  // The app never had the old site.
  assert.deepEqual(folderConfig(FINANCE, { ...COPILOT, siteId: SITE_ID, pendingAdminGrant: true }), FINANCE);
  // Moving back to a site leaves it off the list; the others stay.
  const hr = { siteUrl: 'https://contoso.sharepoint.com/sites/HR', sitePath: 'contoso.sharepoint.com:/sites/HR' };
  const back = folderConfig(COPILOT, { ...FINANCE, granted: true, retiredGrants: [{ siteUrl: SITE_URL, sitePath: SITE_PATH, grantId: 'perm-1' }, hr] });
  assert.deepEqual(back, { ...COPILOT, retiredGrants: [hr, { siteUrl: OLD_URL, sitePath: OLD_PATH }] });
});

test('pax site: ensureSiteGrant does nothing once the app has the site, and needs the folder and the app', async (t) => {
  const s = paxCtx(t);
  s.sp.granted = true;
  assert.equal(await ensureSiteGrant(s.ctx), true);
  assert.deepEqual(s.graph.calls, []);
  assert.equal(s.saves(), 0);

  const noApp = paxCtx(t);
  delete noApp.config.app.appId;
  await assert.rejects(ensureSiteGrant(noApp.ctx), { message: 'The install record has no app registration yet.' });
  const noFolder = paxCtx(t);
  delete noFolder.config.sharePoint;
  await assert.rejects(ensureSiteGrant(noFolder.ctx), { message: 'The install record has no SharePoint folder yet.' });
});

test('pax site: ensureSiteGrant gives the app write access to the site and no other', async (t) => {
  const s = paxCtx(t);
  s.sp.pendingAdminGrant = true;
  s.graph.permissions[SITE_ID].push(permission('perm-other', OTHER_APP, ['write']));
  const label = appName(s.config);
  assert.equal(label, PRODUCT.pax.app);
  assert.equal(await ensureSiteGrant(s.ctx), true);
  assert.deepEqual(s.graph.calls, [`site ${SITE_PATH}`, `sitePermissions ${SITE_ID}`, `grantSitePermission ${SITE_ID} ${APP_ID} ${label} write`]);
  assert.deepEqual(s.sp, { ...COPILOT, siteId: SITE_ID, grantId: 'perm-1', granted: true });
  assert.equal(s.saves(), 2);
  assert.ok(plain(s.out).includes(`✓ Gave ${label} write access to ${SITE_URL}, and to no other site`), plain(s.out));

  const named = paxCtx(t);
  named.config.app.displayName = 'Copilot usage (Contoso)';
  named.sp.siteId = SITE_ID;
  assert.equal(await ensureSiteGrant(named.ctx), true);
  assert.deepEqual(named.graph.calls, [`sitePermissions ${SITE_ID}`, `grantSitePermission ${SITE_ID} ${APP_ID} Copilot usage (Contoso) write`]);
});

test('pax site: ensureSiteGrant keeps write access the app has, and raises read to write', async (t) => {
  for (const role of ['write', 'Owner', 'fullcontrol', 'Manage']) {
    const s = paxCtx(t);
    s.sp.siteId = SITE_ID;
    s.graph.permissions[SITE_ID].push(permission('perm-other', OTHER_APP, ['read']));
    // Graph's older field, with the client ID in capitals.
    s.graph.permissions[SITE_ID].push({ id: 'perm-mine', roles: [role], grantedToIdentities: [{ application: { id: APP_ID.toUpperCase() } }] });
    assert.equal(await ensureSiteGrant(s.ctx), true, role);
    assert.deepEqual(s.graph.calls, [`sitePermissions ${SITE_ID}`, `sitePermission ${SITE_ID} perm-mine`], role);
    assert.ok(plain(s.out).includes(`✓ ${appName(s.config)} can already write to ${SITE_URL}`), role);
    assert.deepEqual(s.sp, { ...COPILOT, siteId: SITE_ID, granted: true }, role);
  }

  const s = paxCtx(t);
  s.sp.siteId = SITE_ID;
  s.graph.permissions[SITE_ID].push(permission('perm-mine', APP_ID, ['read']));
  assert.equal(await ensureSiteGrant(s.ctx), true);
  assert.deepEqual(s.graph.calls, [`sitePermissions ${SITE_ID}`, `sitePermission ${SITE_ID} perm-mine`, `updateSitePermission ${SITE_ID} perm-mine write`]);
  assert.deepEqual(s.graph.permissions[SITE_ID][0].roles, ['write']);
  assert.ok(plain(s.out).includes(`✓ Changed ${appName(s.config)}'s access to ${SITE_URL} from read to write`));
  assert.equal(s.sp.granted, true);
});

test("pax site: ensureSiteGrant leaves the site to an administrator when the sign-in can't give it", async (t) => {
  const s = paxCtx(t);
  s.graph.failures.grantSitePermission = [httpError(403, 'Access denied')];
  assert.equal(await ensureSiteGrant(s.ctx), false);
  assert.deepEqual(s.sp, { ...COPILOT, siteId: SITE_ID, pendingAdminGrant: true });
  assert.equal(s.saves(), 2);
  assert.ok(!plain(s.out).includes("Couldn't find"));

  const missing = paxCtx(t);
  missing.graph.failures.site = [httpError(404, 'Requested site could not be found')];
  assert.equal(await ensureSiteGrant(missing.ctx), false);
  assert.deepEqual(missing.sp, { ...COPILOT, pendingAdminGrant: true });
  assert.ok(
    plain(missing.out).includes(`! Couldn't find ${SITE_URL} with your sign-in. If the address is wrong, change it when you run the install again.`),
    plain(missing.out),
  );

  const broken = paxCtx(t);
  broken.graph.failures.sitePermissions = [new Error('socket hang up')];
  await assert.rejects(ensureSiteGrant(broken.ctx), { message: 'socket hang up' });
  assert.equal(broken.sp.pendingAdminGrant, undefined);
});

test("pax site: recordFolderCheck notes the app's access, and Graph's site ID", (t) => {
  const s = paxCtx(t);
  s.sp.pendingAdminGrant = true;
  recordFolderCheck(s.ctx, { ok: true, siteId: SITE_ID, driveId: 'drive-1' });
  assert.deepEqual(s.sp, { ...COPILOT, siteId: SITE_ID, granted: true });
  recordFolderCheck(s.ctx, { ok: true, siteId: SITE_PATH });
  recordFolderCheck(s.ctx, { ok: true });
  assert.equal(s.sp.siteId, SITE_ID);
  assert.equal(s.saves(), 3);
});

test('pax site: confirmFolderAccess checks the folder as the app on the PC', async (t) => {
  const s = paxCtx(t);
  assert.equal(await confirmFolderAccess(s.ctx), true);
  const check = s.pc.calls.find((c) => c.key === 'refresh check');
  assert.ok(check);
  assert.equal(check.args[check.args.indexOf('-Config') + 1], paxPaths(s.pc.host).config);
  assert.equal(s.checks(), 1);
  assert.deepEqual(s.sleeps, []);
  assert.deepEqual(s.sp, { ...COPILOT, siteId: 'contoso.sharepoint.com,site-guid,web-guid', granted: true });
  assert.ok(plain(s.out).includes(`✓ The app can write to Shared Documents/Copilot on ${SITE_URL}`), plain(s.out));

  const none = paxCtx(t);
  delete none.ctx.paxHost;
  await assert.rejects(confirmFolderAccess(none.ctx), { message: 'confirmFolderAccess needs the PC the refresh runs on.' });
});

test("pax site: confirmFolderAccess shows an administrator's steps when the app can't reach the site", async (t) => {
  const s = paxCtx(t, { ui: { yes: true }, folderCheck: { ok: false, status: 403, error: 'Access denied' } });
  assert.equal(await confirmFolderAccess(s.ctx), false);
  assert.equal(s.checks(), 1);
  assert.deepEqual(s.sleeps, []);
  assert.equal(s.sp.granted, false);
  assert.equal(s.sp.pendingAdminGrant, true);
  assert.ok(s.saves() >= 1);
  const text = plain(s.out);
  const label = appName(s.config);
  assert.ok(text.includes(`! ${SITE_ADMIN} needs to give "${label}" write access to ${SITE_URL}. The app can then write to that site and no other (Sites.Selected).`), text);
  for (const line of siteGrantCommands(s.config)) assert.ok(text.includes(line), line);
  assert.ok(text.includes(`Or, with PnP PowerShell: ${pnpGrantCommand(s.config)}`));
  assert.ok(text.includes("! Carrying on without it. The refresh can't save its files until it's done."));

  const skip = paxCtx(t, { ui: { answers: ['skip'] }, folderCheck: { ok: false, status: 401, error: 'Unauthorized' } });
  assert.equal(await confirmFolderAccess(skip.ctx), false);
  assert.equal(skip.checks(), 1);
  assert.equal(skip.sp.pendingAdminGrant, true);
});

test('pax site: confirmFolderAccess checks again once an administrator has given the site', async (t) => {
  const s = paxCtx(t, { ui: { answers: ['check'] } });
  s.pc.answer['refresh check'] = [printed({ ok: false, status: 403, error: 'Access denied' })];
  assert.equal(await confirmFolderAccess(s.ctx), true);
  assert.equal(s.checks(), 2);
  assert.deepEqual(s.sleeps, []);
  assert.equal(s.sp.granted, true);
  assert.equal(s.sp.pendingAdminGrant, undefined);
  assert.ok(plain(s.out).includes(SITE_ADMIN));
});

test('pax site: confirmFolderAccess waits for a new grant or a new secret to reach every server', async (t) => {
  // The app had the site already, so a refusal is the grant still settling.
  const s = paxCtx(t);
  s.sp.granted = true;
  s.pc.answer['refresh check'] = [printed({ ok: false, status: 403, error: 'Access denied' }), printed({ ok: false, status: 403, error: 'Access denied' })];
  assert.equal(await confirmFolderAccess(s.ctx), true);
  assert.equal(s.checks(), 3);
  assert.deepEqual(s.sleeps, [15_000, 15_000]);
  assert.ok(!plain(s.out).includes(SITE_ADMIN));

  const secret = paxCtx(t);
  secret.pc.answer['refresh check'] = [printed({ ok: false, error: SIGN_IN_FAILED })];
  assert.equal(await confirmFolderAccess(secret.ctx), true);
  assert.deepEqual(secret.sleeps, [15_000]);

  // It gives up after nine tries, with the sign-in's error.
  const never = paxCtx(t);
  never.pc.answer['refresh check'] = Array.from({ length: 9 }, () => printed({ ok: false, error: SIGN_IN_FAILED }));
  await assert.rejects(confirmFolderAccess(never.ctx), { message: SIGN_IN_FAILED });
  assert.equal(never.checks(), 9);
  assert.deepEqual(never.sleeps, Array(8).fill(15_000));
});

test('pax site: confirmFolderAccess throws when the folder itself is wrong or the check crashed', async (t) => {
  const s = paxCtx(t, { folderCheck: { ok: false, status: 404, error: "The library Shared Documents isn't on the site." } });
  await assert.rejects(confirmFolderAccess(s.ctx), { message: "The library Shared Documents isn't on the site." });
  assert.equal(s.checks(), 1);
  assert.deepEqual(s.sleeps, []);
  assert.equal(s.sp.pendingAdminGrant, undefined);

  const bare = paxCtx(t, { folderCheck: { ok: false } });
  await assert.rejects(confirmFolderAccess(bare.ctx), { message: 'Checking the SharePoint folder failed.' });

  const crashed = paxCtx(t);
  crashed.pc.answer['refresh check'] = [failed('Graph is down.')];
  await assert.rejects(confirmFolderAccess(crashed.ctx), { message: /Graph is down\./ });
  assert.equal(crashed.checks(), 1);
});

test('pax site: siteGrantCommands and pnpGrantCommand give the app the site and no other', () => {
  const config = paxConfig();
  const label = appName(config);
  assert.deepEqual(siteGrantCommands(config), [
    'Install-Module Microsoft.Graph.Authentication -Scope CurrentUser',
    `Connect-MgGraph -TenantId '${TENANT}' -Scopes Sites.FullControl.All`,
    `$site = Invoke-MgGraphRequest -Method GET -Uri '${GRAPH}/sites/${SITE_PATH}'`,
    `$body = @{ roles = @('write'); grantedToIdentities = @(@{ application = @{ id = '${APP_ID}'; displayName = '${label}' } }) } | ConvertTo-Json -Depth 5`,
    `Invoke-MgGraphRequest -Method POST -Uri "${GRAPH}/sites/$($site.id)/permissions" -Body $body -ContentType 'application/json'`,
  ]);
  assert.equal(pnpGrantCommand(config), `Grant-PnPAzureADAppSitePermission -AppId '${APP_ID}' -DisplayName '${label}' -Site '${SITE_URL}' -Permissions Write`);

  // Steps written before the app exists name it with a variable. A quote in a name is doubled.
  delete config.app.appId;
  delete config.tenantId;
  config.app.displayName = "Megan's Copilot usage";
  const lines = siteGrantCommands(config, '$appId');
  assert.equal(lines[1], 'Connect-MgGraph -Scopes Sites.FullControl.All');
  assert.equal(lines[3], `$body = @{ roles = @('write'); grantedToIdentities = @(@{ application = @{ id = $appId; displayName = 'Megan''s Copilot usage' } }) } | ConvertTo-Json -Depth 5`);
  assert.equal(pnpGrantCommand(config, '$appId'), `Grant-PnPAzureADAppSitePermission -AppId $appId -DisplayName 'Megan''s Copilot usage' -Site '${SITE_URL}' -Permissions Write`);
  assert.throws(() => siteGrantCommands(config), { message: 'The install record has no app registration yet.' });
  delete config.sharePoint;
  assert.throws(() => siteGrantCommands(config, '$appId'), { message: 'The install record has no SharePoint folder yet.' });
  for (const line of [...lines, pnpGrantCommand(paxConfig())]) assert.doesNotMatch(line, /ExecutionPolicy/i);
});

test("pax site: siteRemovalCommands take back the app's access to one site", () => {
  const config = paxConfig();
  assert.deepEqual(siteRemovalCommands(config, { sitePath: OLD_PATH }), [
    `Connect-MgGraph -TenantId '${TENANT}' -Scopes Sites.FullControl.All`,
    `$site = Invoke-MgGraphRequest -Method GET -Uri '${GRAPH}/sites/${OLD_PATH}'`,
    `$grants = (Invoke-MgGraphRequest -Method GET -Uri "${GRAPH}/sites/$($site.id)/permissions").value`,
    `$grants | Where-Object { $_.grantedToIdentitiesV2.application.id -contains '${APP_ID}' } | ForEach-Object { Invoke-MgGraphRequest -Method DELETE -Uri "${GRAPH}/sites/$($site.id)/permissions/$($_.id)" }`,
  ]);
  delete config.app.appId;
  assert.throws(() => siteRemovalCommands(config, { sitePath: OLD_PATH }), { message: 'The install record has no app registration yet.' });
});

test("pax site: showSiteGrant shows an administrator's steps in order", (t) => {
  const s = paxCtx(t);
  showSiteGrant(s.ctx);
  const text = plain(s.out);
  const parts = [
    `! ${SITE_ADMIN} needs to give "${appName(s.config)}" write access to ${SITE_URL}. The app can then write to that site and no other (Sites.Selected).`,
    'They can run this in PowerShell 7:',
    ...siteGrantCommands(s.config),
    `Or, with PnP PowerShell: ${pnpGrantCommand(s.config)}`,
  ];
  let at = -1;
  for (const part of parts) {
    const next = text.indexOf(part, at + 1);
    assert.ok(next > at, `${part}\n---\n${text}`);
    at = next;
  }
  assert.deepEqual(s.graph.calls, []);
});

test("pax site: removeRetiredGrants takes back the app's access to sites the folder left", async (t) => {
  const s = paxCtx(t);
  s.graph.permissions[OLD_ID].push(permission('perm-old', APP_ID, ['write']), permission('perm-old-2', APP_ID, ['read']), permission('perm-other', OTHER_APP, ['write']));
  s.graph.permissions[SITE_ID].push(permission('perm-kept', APP_ID, ['write']));
  s.sp.retiredGrants = [{ siteUrl: OLD_URL, sitePath: OLD_PATH }];
  assert.equal(await removeRetiredGrants(s.ctx), true);
  assert.deepEqual(s.graph.calls, [`site ${OLD_PATH}`, `sitePermissions ${OLD_ID}`, `deleteSitePermission ${OLD_ID} perm-old`, `deleteSitePermission ${OLD_ID} perm-old-2`]);
  assert.deepEqual(s.graph.permissions[OLD_ID].map((p) => p.id), ['perm-other']);
  assert.deepEqual(s.graph.permissions[SITE_ID].map((p) => p.id), ['perm-kept']);
  assert.equal(s.sp.retiredGrants, undefined);
  assert.equal(s.saves(), 1);
  assert.ok(plain(s.out).includes(`✓ Took back the app's access to ${OLD_URL}, where the folder was before`));

  // With the grant's ID, only that grant goes; one already gone counts as taken back.
  const byId = paxCtx(t);
  byId.graph.permissions[OLD_ID].push(permission('perm-old', APP_ID, ['write']));
  byId.sp.retiredGrants = [
    { siteUrl: OLD_URL, sitePath: OLD_PATH, siteId: OLD_ID, grantId: 'perm-old' },
    { siteUrl: 'https://contoso.sharepoint.com/sites/HR', sitePath: 'contoso.sharepoint.com:/sites/HR', siteId: OLD_ID, grantId: 'perm-gone' },
  ];
  assert.equal(await removeRetiredGrants(byId.ctx), true);
  assert.deepEqual(byId.graph.calls, [`deleteSitePermission ${OLD_ID} perm-old`, `deleteSitePermission ${OLD_ID} perm-gone`]);
  assert.equal(byId.sp.retiredGrants, undefined);
});

test("pax site: removeRetiredGrants keeps what it can't take back, for an administrator", async (t) => {
  const retired = { siteUrl: OLD_URL, sitePath: OLD_PATH, siteId: OLD_ID, grantId: 'perm-old' };
  const s = paxCtx(t);
  s.graph.permissions[OLD_ID].push(permission('perm-old', APP_ID, ['write']));
  s.graph.failures.deleteSitePermission = [httpError(403, 'Access denied')];
  s.sp.retiredGrants = [{ ...retired }];
  assert.equal(await removeRetiredGrants(s.ctx), false);
  assert.deepEqual(s.sp.retiredGrants, [retired]);
  assert.equal(s.saves(), 1);
  const text = plain(s.out);
  assert.ok(text.includes(`! The app can still write to ${OLD_URL}, where the folder was before. ${SITE_ADMIN} can take that back: it's on the list of steps left.`), text);
  assert.ok(!text.includes('Connect-MgGraph'));

  const uninstall = paxCtx(t);
  uninstall.graph.failures.deleteSitePermission = [httpError(403, 'Access denied')];
  uninstall.sp.retiredGrants = [{ ...retired }];
  assert.equal(await removeRetiredGrants(uninstall.ctx, { uninstall: true }), false);
  const shown = plain(uninstall.out);
  assert.ok(shown.includes(`! ${NO_ADMIN} ${OLD_URL}. It does nothing once the app is deleted, but a SharePoint Administrator or Global Administrator can remove it with:`), shown);
  for (const line of siteRemovalCommands(uninstall.config, retired)) assert.ok(shown.includes(line), line);

  const broken = paxCtx(t);
  broken.graph.failures.deleteSitePermission = [new Error('socket hang up')];
  broken.sp.retiredGrants = [{ ...retired }];
  await assert.rejects(removeRetiredGrants(broken.ctx), { message: 'socket hang up' });
});

test('pax site: removeRetiredGrants does nothing with nothing to take back, or no app', async (t) => {
  const s = paxCtx(t);
  assert.equal(await removeRetiredGrants(s.ctx), true);
  const noApp = paxCtx(t);
  noApp.sp.retiredGrants = [{ siteUrl: OLD_URL, sitePath: OLD_PATH }];
  delete noApp.config.app.appId;
  assert.equal(await removeRetiredGrants(noApp.ctx), true);
  assert.deepEqual(noApp.sp.retiredGrants, [{ siteUrl: OLD_URL, sitePath: OLD_PATH }]);
  for (const c of [s, noApp]) {
    assert.deepEqual(c.graph.calls, []);
    assert.equal(c.saves(), 0);
  }
});

test("pax site: removeSiteGrant takes back the app's access to the folder's site and the old ones", async (t) => {
  const s = paxCtx(t);
  s.graph.permissions[SITE_ID].push(permission('perm-1', APP_ID, ['write']));
  s.graph.permissions[OLD_ID].push(permission('perm-old', APP_ID, ['write']));
  Object.assign(s.sp, { siteId: SITE_ID, granted: true, grantId: 'perm-1', retiredGrants: [{ siteUrl: OLD_URL, sitePath: OLD_PATH, siteId: OLD_ID }] });
  assert.equal(await removeSiteGrant(s.ctx), true);
  assert.deepEqual(s.graph.calls, [`deleteSitePermission ${SITE_ID} perm-1`, `sitePermissions ${OLD_ID}`, `deleteSitePermission ${OLD_ID} perm-old`]);
  assert.deepEqual(s.sp, { ...COPILOT, siteId: SITE_ID, granted: false });
  const text = plain(s.out);
  assert.ok(text.includes(`✓ Took back the app's access to ${SITE_URL}\n`), text);
  assert.ok(text.includes(`✓ Took back the app's access to ${OLD_URL}, where the folder was before`), text);

  // An administrator gave it: no grant ID, and the site by its path.
  const admin = paxCtx(t);
  admin.graph.permissions[SITE_ID].push(permission('perm-admin', APP_ID, ['write']), permission('perm-other', OTHER_APP, ['write']));
  admin.sp.granted = true;
  assert.equal(await removeSiteGrant(admin.ctx), true);
  assert.deepEqual(admin.graph.calls, [`site ${SITE_PATH}`, `sitePermissions ${SITE_ID}`, `deleteSitePermission ${SITE_ID} perm-admin`]);
  assert.deepEqual(admin.graph.permissions[SITE_ID].map((p) => p.id), ['perm-other']);
});

test("pax site: removeSiteGrant shows an administrator's commands for what it can't take back", async (t) => {
  const s = paxCtx(t);
  Object.assign(s.sp, { siteId: SITE_ID, granted: true, grantId: 'perm-1' });
  s.graph.failures.deleteSitePermission = [httpError(403, 'Access denied')];
  assert.equal(await removeSiteGrant(s.ctx), false);
  assert.equal(s.sp.granted, true);
  assert.equal(s.sp.grantId, 'perm-1');
  const text = plain(s.out);
  assert.ok(text.includes(`! ${NO_ADMIN} ${SITE_URL}. It does nothing once the app is deleted, but a SharePoint Administrator or Global Administrator can remove it with:`), text);
  for (const line of siteRemovalCommands(s.config, s.sp)) assert.ok(text.includes(line), line);

  // The folder's site is done, but an old one is left.
  const old = paxCtx(t);
  old.sp.retiredGrants = [{ siteUrl: OLD_URL, sitePath: OLD_PATH, siteId: OLD_ID, grantId: 'perm-old' }];
  old.graph.permissions[OLD_ID].push(permission('perm-old', APP_ID, ['write']));
  old.graph.failures.deleteSitePermission = [httpError(403, 'Access denied')];
  assert.equal(await removeSiteGrant(old.ctx), false);
});

test('pax site: removeSiteGrant does nothing without the folder, the app, or any access', async (t) => {
  const s = paxCtx(t);
  delete s.config.sharePoint;
  assert.equal(await removeSiteGrant(s.ctx), true);
  const noApp = paxCtx(t);
  noApp.sp.granted = true;
  delete noApp.config.app.appId;
  assert.equal(await removeSiteGrant(noApp.ctx), true);
  const never = paxCtx(t);
  never.sp.pendingAdminGrant = true;
  assert.equal(await removeSiteGrant(never.ctx), true);
  for (const c of [s, noApp, never]) assert.deepEqual(c.graph.calls, []);
});

test('pax site: site.js takes the product name from product.js, for other products to copy it', () => {
  const source = readFileSync(new URL('../src/steps/pax/site.js', import.meta.url), 'utf8');
  const named = source.split(/\r?\n/).flatMap((line, i) => (new RegExp(PRODUCT.name, 'i').test(line) ? [`site.js:${i + 1}: ${line.trim()}`] : []));
  assert.deepEqual(named, []);
});
