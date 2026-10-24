// @ts-check
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { emptyConfig, MODEL_NAME } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { commandLine } from '../src/launch.js';
import { PRODUCT } from '../src/product.js';
import { foreignWorkspaceMessage } from '../src/steps/fabric.js';
import { isResumeLater } from '../src/steps/identity.js';
import { modelSettingsUrl, REFRESH_POLL_MS } from '../src/steps/model.js';
import { TASK_AT } from '../src/steps/pax/local.js';
import {
  apiRefusal,
  askCredentials,
  credentialSteps,
  desktopHash,
  desktopSteps,
  ensurePaxWorkspace,
  folderFileUrl,
  historyState,
  loadPaxModel,
  paxEntry,
  paxSignature,
  paxWrites,
  publishPax,
  publishWithDesktop,
  REFRESH_AFTER_HOURS,
  REFRESH_WAIT_MS,
  refreshPaxModel,
  refreshTimes,
  setPaxSchedule,
  workspaceItems,
} from '../src/steps/pax/publish.js';
import { folderConfig, parseSharePointFolder } from '../src/steps/pax/site.js';
import { loadTemplateModel, mParameter, readTemplateModel } from '../src/transform/model.js';
import { buildEntryModel, fillTemplate } from '../src/transform/template.js';
import { fakeCtx, fakeFabric, fakePowerBi, fakeUi, httpError, realSources } from './fakes.js';

/** @typedef {import('../src/config.js').InstallConfig} InstallConfig */
/** @typedef {import('../src/config.js').SharePointConfig} SharePointConfig */

const P = PRODUCT.pax;
const PARAMS = /** @type {Record<string, string>} */ (P.parameters);
const FILES = /** @type {Record<string, string>} */ (P.files);
const OPTIONAL = /** @type {Record<string, string>} */ (P.optionalFiles);
const PAX_TEMPLATE = /** @type {string} */ (realSources().paxModelFile);
const SITE_URL = 'https://contoso.sharepoint.com/sites/Analytics';
const FOLDER = `${SITE_URL}/Shared Documents/ValueLens`;
const FOLDER_URL = `${SITE_URL}/Shared%20Documents/ValueLens`;
const MOVED = `${SITE_URL}/Shared Documents/Copilot Data/Rollups`;
const MOVED_URL = `${SITE_URL}/Shared%20Documents/Copilot%20Data/Rollups`;
const WORKSPACE = 'Copilot reports';
const EMPTY_TABLE = '(columns as list) as table => #table(columns, {"x"})';
const NO_FOLDER = 'The install record has no SharePoint folder yet. Run the installer to choose one.';

const dir = mkdtempSync(join(tmpdir(), 'valuelens-publish-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** @param {string} s */
const plain = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

/**
 * An install record on the PAX route, with its SharePoint folder unless folder is null.
 * @param {{ folder?: string | null, agent365?: boolean }} [o]
 */
function paxConfig(o = {}) {
  const config = emptyConfig();
  config.target = 'pax';
  config.tenantId = 'tenant-1';
  if (o.folder !== null) config.sharePoint = folderConfig(/** @type {any} */ (parseSharePointFolder(o.folder ?? FOLDER)));
  /** @type {any} */ (config).pax = { task: { name: P.task, at: TASK_AT }, ...(o.agent365 === undefined ? {} : { agent365: o.agent365 }) };
  return config;
}

/** @param {InstallConfig} c */
const spOf = (c) => /** @type {SharePointConfig} */ (c.sharePoint);
/** @param {InstallConfig} c @param {string} key */
const writes = (c, key) => paxWrites(c, /** @type {any} */ (key));

/** fakeFabric, with listItems able to fail. */
function fakeFab() {
  const base = fakeFabric();
  const api = {
    ...base.api,
    /** @param {string} ws @param {any} [type] */
    listItems: async (ws, type) => {
      const err = base.failures.listItems?.shift();
      if (err) throw err;
      return base.api.listItems(ws, type);
    },
  };
  return { ...base, api };
}

/** A part of a Fabric item's definition, decoded. @param {any} item @param {string} path */
function partOf(item, path) {
  const part = item?.content?.parts?.find((/** @type {any} */ p) => p.path === path);
  return part ? Buffer.from(part.payload, 'base64').toString('utf8') : undefined;
}
/** @param {any} item */
const itemBim = (item) => JSON.parse(/** @type {string} */ (partOf(item, 'model.bim')));
/** The model a report item is bound to. @param {any} item */
function reportModelId(item) {
  const pbir = partOf(item, 'definition.pbir');
  const conn = pbir ? JSON.parse(pbir)?.datasetReference?.byConnection?.connectionString : undefined;
  return typeof conn === 'string' ? conn.replace(/^.*semanticmodelid=/i, '') : undefined;
}

/**
 * fakePowerBi plus what publish.js also calls (datasets, reports, refreshNow), with refreshes
 * answering scripted polls. Datasets and reports list the Fabric items too, as Power BI would.
 * @param {ReturnType<typeof fakeFab>} fabric
 */
function fakePbi(fabric) {
  const base = fakePowerBi();
  /** @type {{ id: string, name: string }[]} */
  const datasets = [];
  /** @type {{ id: string, name: string, datasetId?: string }[]} */
  const reports = [];
  /** @type {any[][]} What each refreshes call returns, in order; then the history. */
  const polls = [];
  /** @type {string[]} */
  const requestIds = [];
  /** @type {any[]} */
  const schedules = [];
  const fail = (/** @type {string} */ m) => {
    const err = base.failures[m]?.shift();
    if (err) throw err;
  };
  const api = {
    ...base.api,
    createGroup: async (/** @type {string} */ name) => {
      base.calls.push(`createGroup ${name}`);
      fail('createGroup');
      return { id: 'pbi-ws-1', name };
    },
    datasets: async (/** @type {string} */ _ws) => {
      fail('datasets');
      const models = fabric.items.filter((i) => i.type === 'SemanticModel').map((i) => ({ id: i.id, name: i.displayName }));
      return [...models, ...structuredClone(datasets)];
    },
    reports: async (/** @type {string} */ _ws) => {
      fail('reports');
      const made = fabric.items.filter((i) => i.type === 'Report').map((i) => ({ id: i.id, name: i.displayName, datasetId: reportModelId(i) }));
      return [...made, ...structuredClone(reports)];
    },
    setRefreshSchedule: async (/** @type {string} */ ws, /** @type {string} */ id, /** @type {any} */ body) => {
      base.calls.push(`setRefreshSchedule ${ws} ${id}`);
      fail('setRefreshSchedule');
      schedules.push(structuredClone(body));
    },
    refreshNow: async (/** @type {string} */ ws, /** @type {string} */ id) => {
      base.calls.push(`refreshNow ${ws} ${id}`);
      fail('refreshNow');
      return requestIds.length ? requestIds.shift() : 'request-1';
    },
    refreshes: async (/** @type {string} */ ws, /** @type {string} */ id, /** @type {number} */ top) => {
      base.calls.push(`refreshes ${ws} ${id} ${top}`);
      return structuredClone(polls.length ? polls.shift() : base.history);
    },
  };
  return { ...base, api, datasets, reports, polls, requestIds, schedules };
}

/**
 * A PAX install with its folder chosen and its workspace recorded, writing into its own folder.
 * @param {{ yes?: boolean, answers?: any[], folder?: string | null, agent365?: boolean, sources?: any }} [o]
 */
function setup(o = {}) {
  const config = paxConfig(o);
  config.fabric.workspaceId = 'ws-1';
  config.fabric.workspaceName = WORKSPACE;
  const fabric = fakeFab();
  const pbi = fakePbi(fabric);
  const ui = fakeUi({ yes: o.yes, answers: o.answers });
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, powerBi: pbi.api, config, ...(o.sources ? { sources: o.sources } : {}) });
  const home = mkdtempSync(join(dir, 'run-'));
  /** @type {any} */ (made.ctx).configFile = join(home, PRODUCT.recordFile);
  return { ...made, fabric, pbi, ui, home, pbit: join(home, `${P.report}.pbit`), out: () => plain(ui.text()) };
}
/** @typedef {ReturnType<typeof setup>} Setup */

/**
 * Records a model the API published; signed in to SharePoint unless signedIn is false.
 * @param {Setup} t
 * @returns {any} The install record's powerBi section.
 */
function withModel(t, { signedIn = true } = {}) {
  Object.assign(t.config.semanticModel, { id: 'ds-9', name: P.model, enabled: true, reports: true, bound: signedIn });
  const pbi = (/** @type {any} */ (t.config).powerBi ??= {});
  pbi.publishedBy = 'api';
  if (signedIn) pbi.credentials = 'set';
  return pbi;
}

/** @param {Setup} t @param {string} s */
const printed = (t, s) => assert.ok(t.out().includes(s), `expected "${s}" in:\n${t.out()}`);
/** @param {Promise<any>} p @returns {Promise<any>} */
const rejection = (p) => p.then(() => assert.fail('expected it to reject'), (e) => e);

/**
 * Records the values each select offers; before() runs when the first one is asked.
 * @param {Setup} t @param {() => void} [before]
 */
function watchSelects(t, before) {
  /** @type {any[][]} */
  const offered = [];
  const ui = /** @type {any} */ (t.ctx.ui);
  const select = ui.select;
  ui.select = async (/** @type {string} */ message, /** @type {any[]} */ choices, /** @type {any} */ def) => {
    if (!offered.length) before?.();
    offered.push(choices.map((c) => c.value));
    return select(message, choices, def);
  };
  return offered;
}

/**
 * What the user publishes from Power BI Desktop: a model, and its report unless report is null.
 * @param {Setup} t
 * @param {{ dataset?: string, report?: string | null, name?: string }} [o]
 */
function publishFromDesktop(t, { dataset = 'ds-desktop', report = 'rp-desktop', name = P.model } = {}) {
  t.pbi.datasets.push({ id: dataset, name });
  if (report) t.pbi.reports.push({ id: report, name: P.report, datasetId: dataset });
}

// ---- What the route writes, and the parameters ----

test('pax publish: paxWrites writes the optional files only when they are switched on', () => {
  const off = paxConfig();
  const on = paxConfig({ agent365: true });
  for (const key of Object.keys(FILES)) {
    assert.equal(writes(off, key), !(key in OPTIONAL), key);
    assert.equal(writes(on, key), true, key);
  }
  assert.equal(writes(off, 'agents365'), false);
  assert.equal(writes(on, 'agents365'), true);
  assert.equal(writes(paxConfig({ agent365: false }), 'agents365'), false);
  const bare = paxConfig();
  delete (/** @type {any} */ (bare).pax);
  assert.equal(writes(bare, 'agents365'), false, 'no pax section');
  assert.equal(writes(bare, 'interactions'), true);
  assert.equal(writes(bare, 'feedback'), true, 'a key with no optional flag counts as written');
});

test('pax publish: folderFileUrl encodes the file name onto the folder URL', () => {
  const sp = spOf(paxConfig());
  assert.equal(sp.folderUrl, FOLDER_URL);
  assert.equal(folderFileUrl(sp, FILES.interactions), `${FOLDER_URL}/${FILES.interactions}`);
  assert.equal(folderFileUrl(sp, 'Copilot users.csv'), `${FOLDER_URL}/Copilot%20users.csv`);
  assert.equal(folderFileUrl(sp, 'R&D #1 (100%) é.csv'), `${FOLDER_URL}/R%26D%20%231%20(100%25)%20%C3%A9.csv`);
  assert.equal(folderFileUrl(sp, 'a/b.csv'), `${FOLDER_URL}/a%2Fb.csv`, 'a slash is part of the name');
  assert.equal(folderFileUrl({ ...sp, folderUrl: `${FOLDER_URL}/` }, 'x.csv'), `${FOLDER_URL}/x.csv`);
  assert.equal(folderFileUrl({ ...sp, folderUrl: `${FOLDER_URL}//` }, 'x.csv'), `${FOLDER_URL}/x.csv`);
  assert.equal(folderFileUrl(spOf(paxConfig({ folder: MOVED })), 'a b.csv'), `${MOVED_URL}/a%20b.csv`);
  const encoded = `${SITE_URL}/Shared%20Documents/R%26D%20%232`;
  assert.equal(folderFileUrl({ ...sp, folderUrl: encoded }, 'x y.csv'), `${encoded}/x%20y.csv`, 'the folder is not encoded again');
});

test('pax publish: paxEntry fills each parameter with its file URL in the folder, and the site URL', () => {
  const entry = paxEntry(paxConfig(), PAX_TEMPLATE);
  const url = (/** @type {string} */ name) => `${FOLDER_URL}/${encodeURIComponent(name)}`;
  assert.deepEqual(entry, {
    template: PAX_TEMPLATE,
    parameters: {
      [PARAMS.interactions]: url(FILES.interactions),
      [PARAMS.users]: url(FILES.users),
      [PARAMS.site]: SITE_URL,
      [PARAMS.agents365]: '',
      [PARAMS.feedback]: '',
    },
  });
  assert.deepEqual(Object.keys(entry.parameters), Object.values(PARAMS), 'in the order PRODUCT lists them');
  assert.ok(!('expressions' in entry) && !('expressions' in P), 'the route has no expressions to pass');
});

test('pax publish: paxEntry adds the Agent 365 file when the route writes it, and follows a moved folder', () => {
  const on = paxEntry(paxConfig({ agent365: true }), PAX_TEMPLATE).parameters;
  assert.equal(on[PARAMS.agents365], `${FOLDER_URL}/${encodeURIComponent(FILES.agents365)}`);
  assert.equal(on[PARAMS.feedback], '', 'the route writes no feedback file');
  const moved = paxEntry(paxConfig({ folder: MOVED, agent365: true }), PAX_TEMPLATE).parameters;
  for (const key of ['interactions', 'users', 'agents365']) assert.equal(moved[PARAMS[key]], `${MOVED_URL}/${encodeURIComponent(FILES[key])}`, key);
  assert.equal(moved[PARAMS.site], SITE_URL);
});

test('pax publish: paxEntry needs the SharePoint folder and its site', () => {
  assert.throws(() => paxEntry(paxConfig({ folder: null }), PAX_TEMPLATE), { message: NO_FOLDER });
  for (const field of ['folderUrl', 'siteUrl']) {
    const config = paxConfig();
    /** @type {any} */ (config.sharePoint)[field] = '';
    assert.throws(() => paxEntry(config, PAX_TEMPLATE), { message: NO_FOLDER }, field);
  }
});

test('pax publish: paxSignature names the folder, whatever its case', () => {
  const config = paxConfig();
  assert.equal(paxSignature(config), `pax;${FOLDER_URL.toLowerCase()}`);
  const upper = paxConfig();
  spOf(upper).folderUrl = FOLDER_URL.toUpperCase();
  assert.equal(paxSignature(upper), paxSignature(config));
  assert.notEqual(paxSignature(paxConfig({ folder: MOVED })), paxSignature(config));
  assert.equal(paxSignature(paxConfig({ agent365: true })), paxSignature(config), 'the files it writes are not part of it');
  assert.equal(paxSignature(paxConfig({ folder: null })), 'pax;');
});

test('pax publish: desktopHash is stable, and changes with the template, the parameters or the expressions', () => {
  const entry = paxEntry(paxConfig(), PAX_TEMPLATE);
  const hash = desktopHash(entry);
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(desktopHash(paxEntry(paxConfig(), PAX_TEMPLATE)), hash, 'stable');
  assert.equal(desktopHash({ ...entry, expressions: {} }), hash, 'no expressions is the same as none');
  const copy = join(dir, 'copy.pbit');
  copyFileSync(PAX_TEMPLATE, copy);
  assert.equal(desktopHash({ ...entry, template: copy }), hash, 'the same bytes in another place');
  const changed = join(dir, 'changed.pbit');
  writeFileSync(changed, Buffer.concat([readFileSync(PAX_TEMPLATE), Buffer.from([0])]));
  const others = [
    desktopHash(paxEntry(paxConfig({ folder: MOVED }), PAX_TEMPLATE)),
    desktopHash(paxEntry(paxConfig({ agent365: true }), PAX_TEMPLATE)),
    desktopHash({ ...entry, expressions: { EmptyTable: EMPTY_TABLE } }),
    desktopHash({ ...entry, template: changed }),
  ];
  assert.equal(new Set([hash, ...others]).size, 5, 'each change gives its own hash');
});

test('pax publish: workspaceItems lists the Fabric items, or what Power BI lists when Fabric will not', async () => {
  const t = setup();
  t.fabric.add('SemanticModel', 'Sales', null, 'Sales model');
  assert.deepEqual(
    (await workspaceItems(t.ctx, 'ws-1')).map((i) => [i.displayName, /** @type {any} */ (i).description]),
    [['Sales', 'Sales model']],
  );
  t.pbi.datasets.push({ id: 'ds-1', name: 'Budget' });
  t.pbi.reports.push({ id: 'rp-1', name: 'Budget report' });
  const names = async () => (await workspaceItems(t.ctx, 'ws-1')).map((i) => i.displayName);
  t.fabric.failures.listItems = [httpError(403, 'Forbidden')];
  assert.deepEqual(await names(), ['Sales', 'Budget', 'Budget report'], 'datasets, then reports');
  t.fabric.failures.listItems = [httpError(403, 'Forbidden')];
  t.pbi.failures.datasets = [httpError(500, 'Internal error')];
  assert.deepEqual(await names(), ['Budget report']);
  t.fabric.failures.listItems = [httpError(403, 'Forbidden')];
  t.pbi.failures.datasets = [httpError(500, 'Internal error')];
  t.pbi.failures.reports = [httpError(500, 'Internal error')];
  assert.deepEqual(await names(), []);
});

// ---- The workspace ----

const CANNOT_CREATE =
  'You can\'t create Power BI workspaces in this tenant. Ask a Fabric administrator to let you (the tenant setting "Create workspaces"), ' +
  'or ask someone who can to create one and add you as Admin or Member. Then run the installer again and choose it.';
const nameTaken = (/** @type {string} */ name) =>
  `There's already a workspace called "${name}" that you aren't in. Run the installer again and choose another name, or ask its admin to add you and then choose it.`;
const conflict = () =>
  new HttpError('Conflict', { status: 409, method: 'POST', url: 'https://api.powerbi.com/v1.0/myorg/groups', code: 'PowerBIEntityAlreadyExists' });
/** Setup with no workspace recorded yet. @param {Parameters<typeof setup>[0]} [o] */
function unrecorded(o) {
  const t = setup(o);
  delete (/** @type {any} */ (t.config.fabric).workspaceId);
  return t;
}

test('pax publish: ensurePaxWorkspace keeps the recorded workspace, and takes its current name', async () => {
  const t = setup();
  t.config.fabric.workspaceId = 'WS-1';
  t.pbi.workspaces.push({ id: 'ws-5', name: 'Finance' }, { id: 'ws-1', name: 'Copilot analytics' });
  await ensurePaxWorkspace(t.ctx);
  assert.equal(t.config.fabric.workspaceName, 'Copilot analytics');
  assert.equal(t.saves(), 1);
  assert.deepEqual(t.pbi.calls, [], 'nothing created');
  printed(t, '✓ Workspace Copilot analytics is in place');
  await ensurePaxWorkspace(t.ctx);
  assert.equal(t.saves(), 1, 'nothing more to record');
  assert.equal(t.config.fabric.createdWorkspace, undefined);
});

test('pax publish: ensurePaxWorkspace refuses a workspace that holds an Analytics Hub install', async () => {
  /** @type {[string, (t: Setup) => void][]} */
  const cases = [
    ['by name', (t) => t.fabric.add('SemanticModel', 'AnalyticsHub_Model', null)],
    ['by description', (t) => t.fabric.add('Report', 'Usage', null, 'Deployed by the Analytics Hub installer')],
    [
      'through Power BI, when Fabric will not list',
      (t) => {
        t.fabric.failures.listItems = [httpError(403, 'Forbidden')];
        t.pbi.datasets.push({ id: 'ds-1', name: 'AnalyticsHub_Model' });
      },
    ],
  ];
  for (const [label, arrange] of cases) {
    const t = setup();
    t.pbi.workspaces.push({ id: 'ws-1', name: WORKSPACE });
    arrange(t);
    await assert.rejects(ensurePaxWorkspace(t.ctx), { message: foreignWorkspaceMessage(WORKSPACE) }, label);
    assert.doesNotMatch(t.out(), /is in place/, label);
  }
});

test('pax publish: ensurePaxWorkspace trusts a workspace it made, or already published to', async () => {
  for (const mark of ['createdWorkspace', 'model']) {
    const t = setup();
    t.pbi.workspaces.push({ id: 'ws-1', name: WORKSPACE });
    t.fabric.add('SemanticModel', 'AnalyticsHub_Model', null);
    if (mark === 'createdWorkspace') t.config.fabric.createdWorkspace = true;
    else t.config.semanticModel.id = 'ds-9';
    await ensurePaxWorkspace(t.ctx);
    printed(t, `✓ Workspace ${WORKSPACE} is in place`);
  }
});

test('pax publish: ensurePaxWorkspace creates the workspace when none is recorded, and records that it made it', async () => {
  for (const name of [undefined, WORKSPACE]) {
    const t = unrecorded();
    if (name) t.config.fabric.workspaceName = name;
    else delete t.config.fabric.workspaceName;
    t.pbi.workspaces.push({ id: 'ws-5', name: 'Finance' });
    await ensurePaxWorkspace(t.ctx);
    const expected = name ?? P.workspace;
    assert.deepEqual(t.pbi.calls, [`createGroup ${expected}`]);
    assert.equal(t.config.fabric.workspaceId, 'pbi-ws-1');
    assert.equal(t.config.fabric.workspaceName, expected);
    assert.equal(t.config.fabric.createdWorkspace, true);
    assert.equal(t.saves(), 1);
    printed(t, `✓ Created workspace ${expected}`);
  }
});

test('pax publish: ensurePaxWorkspace makes the workspace again when the recorded one is gone, forgetting what was in it', async () => {
  const t = setup();
  const pbi = withModel(t);
  Object.assign(pbi, { refreshAt: '06:00', timeZone: 'GMT Standard Time', desktopPending: 'desktop;0123', desktopFile: join(t.home, 'x.pbit') });
  Object.assign(t.config.semanticModel, { signature: 'pax;x', report: { id: 'rp-1', name: P.report }, reload: { since: '2026-05-01T00:00:00.000Z' } });
  /** @type {any} */ (t.config.fabric).pendingItems = { report: 'x' };
  const access = (/** @type {any} */ (t.config).access ??= {});
  access.reportShared = true;
  t.config.fabric.createdWorkspace = true;
  t.pbi.workspaces.push({ id: 'ws-5', name: 'Finance' });
  await ensurePaxWorkspace(t.ctx);
  printed(t, `! The workspace ${WORKSPACE} is gone, or you're no longer in it, so making a new one.`);
  printed(t, `✓ Created workspace ${WORKSPACE}`);
  assert.deepEqual(t.pbi.calls, [`createGroup ${WORKSPACE}`], 'under the name it had');
  assert.equal(t.saves(), 2);
  const sm = /** @type {any} */ (t.config.semanticModel);
  for (const key of ['id', 'signature', 'report', 'reload']) assert.equal(sm[key], undefined, key);
  assert.equal(sm.bound, false);
  assert.deepEqual(/** @type {any} */ (t.config).powerBi, { timeZone: 'GMT Standard Time' });
  assert.equal(access.reportShared, undefined);
  assert.equal(/** @type {any} */ (t.config.fabric).pendingItems, undefined);
  assert.equal(t.config.fabric.workspaceId, 'pbi-ws-1');
  assert.equal(t.config.fabric.createdWorkspace, true);
});

test('pax publish: ensurePaxWorkspace stops when Power BI will not list the workspaces', async () => {
  const t = setup();
  const err = httpError(500, 'Service unavailable');
  t.pbi.failures.groups = [err];
  await assert.rejects(ensurePaxWorkspace(t.ctx), (e) => e === err);
  assert.equal(t.saves(), 0);
  assert.equal(t.config.fabric.workspaceId, 'ws-1');
});

test('pax publish: ensurePaxWorkspace explains why it could not create the workspace', async () => {
  /** @type {[Error, string][]} */
  const cases = [
    [httpError(401, 'Unauthorized'), CANNOT_CREATE],
    [httpError(403, 'Forbidden'), CANNOT_CREATE],
    [httpError(409, 'A workspace with this name already exists'), nameTaken(WORKSPACE)],
    [conflict(), nameTaken(WORKSPACE)],
    [httpError(400, 'Duplicate workspace name'), nameTaken(WORKSPACE)],
  ];
  for (const [err, message] of cases) {
    const t = unrecorded();
    t.pbi.failures.createGroup = [err];
    await assert.rejects(ensurePaxWorkspace(t.ctx), { message }, err.message);
    assert.equal(t.saves(), 0, err.message);
    assert.equal(t.config.fabric.workspaceId, undefined, err.message);
  }
  const t = unrecorded();
  const err = httpError(500, 'Internal error');
  t.pbi.failures.createGroup = [err];
  await assert.rejects(ensurePaxWorkspace(t.ctx), (e) => e === err, 'anything else stops as it is');
});

test('pax publish: ensurePaxWorkspace takes a same-named workspace the user is already in', async () => {
  const name = WORKSPACE.toUpperCase();
  const t = unrecorded();
  t.pbi.workspaces.push({ id: 'ws-5', name: 'Finance' }, { id: 'ws-7', name });
  t.pbi.failures.createGroup = [conflict()];
  await ensurePaxWorkspace(t.ctx);
  assert.equal(t.config.fabric.workspaceId, 'ws-7');
  assert.equal(t.config.fabric.workspaceName, name, 'under the name it has');
  assert.equal(t.config.fabric.createdWorkspace, undefined, 'not made by this run, so uninstall removes only what it put there');
  assert.equal(t.saves(), 1);
  printed(t, `✓ Workspace ${name} already exists, and you're in it, so using it`);

  const u = unrecorded();
  u.pbi.workspaces.push({ id: 'ws-7', name: WORKSPACE });
  u.pbi.failures.createGroup = [httpError(400, 'Duplicate workspace name')];
  u.fabric.add('SemanticModel', 'AnalyticsHub_Model', null);
  await assert.rejects(ensurePaxWorkspace(u.ctx), { message: foreignWorkspaceMessage(WORKSPACE) }, 'unless an Analytics Hub install is in it');
  assert.equal(u.saves(), 0);
  assert.equal(u.config.fabric.workspaceId, undefined);
});

// ---- API or Desktop ----

test('pax publish: apiRefusal falls back to Desktop only when the service turns the API down', () => {
  const coded = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) =>
    new HttpError(message, { status, method: 'POST', url: 'https://api.fabric.microsoft.com/v1/workspaces/ws-1/items', code });
  /** @type {[unknown, string | undefined][]} */
  const cases = [
    [httpError(403, 'Forbidden'), 'Forbidden'],
    [coded(400, 'FeatureNotAvailable', 'The feature is off'), 'FeatureNotAvailable The feature is off'],
    [httpError(400, 'The workspace has no capacity'), 'The workspace has no capacity'],
    [httpError(400, 'This needs Premium'), 'This needs Premium'],
    [httpError(400, 'You need a license'), 'You need a license'],
    [httpError(400, 'You need a licence'), 'You need a licence'],
    [httpError(400, 'Report creation is not supported here'), 'Report creation is not supported here'],
    [httpError(400, 'Unsupported item type'), 'Unsupported item type'],
    [coded(403, 'InsufficientPrivileges', 'Forbidden'), undefined],
    [coded(403, 'PrincipalTypeNotSupported', 'Forbidden'), undefined],
    [coded(401, 'TokenExpired', 'Unauthorized'), undefined],
    [httpError(401, 'Unauthorized'), undefined],
    [httpError(400, 'The definition is invalid'), undefined],
    [httpError(404, 'Not found'), undefined],
    [httpError(500, 'Internal error'), undefined],
    [new Error('Feature not supported'), undefined],
    [undefined, undefined],
  ];
  for (const [err, why] of cases) assert.equal(apiRefusal(err), why, String(/** @type {any} */ (err)?.message));
  assert.equal(apiRefusal(httpError(403, 'x'.repeat(300))), 'x'.repeat(200), 'cut to 200 characters');
});

test('pax publish: desktopSteps walks through publishing the filled file', () => {
  assert.equal(P.report, P.model, 'Power BI names the model after the .pbix, and the installer looks for it as P.model');
  const file = join(dir, `${P.report}.pbit`);
  assert.deepEqual(desktopSteps(file, WORKSPACE), [
    `Open ${file} in Power BI Desktop, which is free from the Microsoft Store.`,
    'If it shows the parameters, keep the values in them and select Load.',
    'When it asks how to connect to SharePoint, choose Microsoft account (or Organizational account), sign in with your work account, then select Connect.',
    `Once the data has loaded, save it as ${P.report}.pbix. Power BI names the report and its model after the file.`,
    `Select Publish, choose the workspace "${WORKSPACE}", and select Replace if it asks.`,
  ]);
});

test('pax publish: credentialSteps walks through signing the model in to SharePoint', () => {
  const url = modelSettingsUrl('ws-1', 'ds-9');
  assert.deepEqual(credentialSteps(url), [
    `Open the model's settings: ${url}`,
    'Expand Data source credentials, and select Edit credentials beside a source.',
    'Choose OAuth2 and the privacy level None, then select Sign in and sign in with your work account.',
    "Do the same for each source it lists. If a site's address fails the connection test, edit it again and tick Skip test connection.",
  ]);
});

/** The install record's powerBi section, or an empty one. @param {Setup} t @returns {any} */
const pbiOf = (t) => /** @type {any} */ (t.config).powerBi ?? {};
/** @param {Setup} t */
const laterText = (t) => `Publish ${t.pbit} from Power BI Desktop to "${WORKSPACE}", then run the installer again.`;

test('pax publish: publishWithDesktop with --yes writes the filled file and stops until it is published', async () => {
  const t = setup({ yes: true });
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  const err = await rejection(publishWithDesktop(t.ctx, entry));
  assert.ok(isResumeLater(err), String(err));
  assert.equal(err.message, `Stopped until the report is published. ${laterText(t)}`);
  const model = readTemplateModel(readFileSync(t.pbit)).model;
  for (const [name, value] of Object.entries(entry.parameters)) assert.equal(mParameter(model, name), value, name);
  const pbi = pbiOf(t);
  assert.equal(pbi.publishedBy, 'desktop');
  assert.equal(pbi.desktopPending, `desktop;${desktopHash(entry)}`);
  assert.equal(pbi.desktopFile, t.pbit);
  assert.equal(t.saves(), 1);
  printed(t, 'Publish from Power BI Desktop\n');
  printed(t, `    Publish the ${P.report} report from Power BI Desktop. It takes a few minutes.\n`);
  desktopSteps(t.pbit, WORKSPACE).forEach((s, i) => printed(t, `      ${i + 1}. ${s}\n`));
  assert.deepEqual(t.ui.asked, []);
  assert.deepEqual(t.fabric.calls, [], 'no Fabric items');
});

test('pax publish: publishWithDesktop finds what the user published from Desktop', async () => {
  const t = setup({ answers: ['check'] });
  const access = (/** @type {any} */ (t.config).access ??= {});
  access.reportShared = true;
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  const offered = watchSelects(t, () => publishFromDesktop(t));
  await publishWithDesktop(t.ctx, entry);
  assert.deepEqual(offered, [['check', 'stop']]);
  assert.deepEqual(t.ui.asked, ['Published it?']);
  const sm = /** @type {any} */ (t.config.semanticModel);
  assert.equal(sm.id, 'ds-desktop');
  assert.equal(sm.name, P.model);
  assert.equal(sm.signature, `desktop;${desktopHash(entry)}`);
  assert.equal(sm.bound, false, 'not signed in to SharePoint yet');
  assert.deepEqual(sm.report, { id: 'rp-desktop', name: P.report, signature: 'desktop', modelId: 'ds-desktop' });
  assert.equal(access.reportShared, undefined, 'a new report is not shared yet');
  const pbi = pbiOf(t);
  assert.equal(pbi.publishedBy, 'desktop');
  assert.equal(pbi.desktopPending, undefined);
  assert.equal(pbi.desktopFile, undefined);
  assert.equal(t.saves(), 2);
  printed(t, `✓ Found ${P.model} and its report in ${WORKSPACE}`);
});

test('pax publish: publishWithDesktop says what to fix when nothing is published yet, and can stop', async () => {
  const t = setup({ answers: ['check', 'stop'] });
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  const offered = watchSelects(t);
  const err = await rejection(publishWithDesktop(t.ctx, entry));
  assert.ok(isResumeLater(err), String(err));
  assert.deepEqual(offered, [['check', 'stop'], ['check', 'stop']]);
  printed(t, `! There's no model called ${P.model} in ${WORKSPACE} yet. Save the file as ${P.report}.pbix before publishing, so Power BI gives it that name.`);
  assert.equal(pbiOf(t).desktopPending, `desktop;${desktopHash(entry)}`, 'kept for the next run');
  assert.equal(t.config.semanticModel.id, undefined);
});

test('pax publish: publishWithDesktop with --yes picks up the published report on the next run, and keeps it when the folder moves', async () => {
  const t = setup({ yes: true });
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  const signature = `desktop;${desktopHash(entry)}`;
  assert.ok(isResumeLater(await rejection(publishWithDesktop(t.ctx, entry))));
  publishFromDesktop(t);
  await publishWithDesktop(t.ctx, entry);
  printed(t, `✓ Found the ${P.report} report you published from Power BI Desktop`);
  printed(t, `✓ The ${P.report} report is in place`);
  const sm = /** @type {any} */ (t.config.semanticModel);
  assert.equal(sm.id, 'ds-desktop');
  assert.equal(sm.signature, signature);
  assert.equal(sm.report.id, 'rp-desktop');
  assert.equal(pbiOf(t).desktopPending, undefined);
  assert.equal(t.saves(), 2);
  await publishWithDesktop(t.ctx, entry);
  assert.equal(t.saves(), 2, 'nothing to do the third time');

  t.config.sharePoint = folderConfig(/** @type {any} */ (parseSharePointFolder(MOVED)));
  const moved = paxEntry(t.config, PAX_TEMPLATE);
  await publishWithDesktop(t.ctx, moved);
  printed(t, `    There's a new version of the ${P.report} report for you to publish.`);
  printed(t, `! Kept the version of ${P.report} that's there. ${laterText(t)}`);
  assert.equal(pbiOf(t).desktopPending, `desktop;${desktopHash(moved)}`);
  assert.equal(sm.signature, signature, 'the version there is still the old one');
  assert.equal(mParameter(readTemplateModel(readFileSync(t.pbit)).model, PARAMS.interactions), `${MOVED_URL}/${encodeURIComponent(FILES.interactions)}`);
});

test('pax publish: publishWithDesktop can keep the version that is there for now', async () => {
  const t = setup({ answers: ['keep'] });
  const old = paxEntry(t.config, PAX_TEMPLATE);
  Object.assign(t.config.semanticModel, { id: 'ds-desktop', name: P.model, signature: `desktop;${desktopHash(old)}`, report: { id: 'rp-desktop', name: P.report, signature: 'desktop', modelId: 'ds-desktop' } });
  Object.assign((/** @type {any} */ (t.config).powerBi ??= {}), { publishedBy: 'desktop', credentials: 'set' });
  publishFromDesktop(t);
  const offered = watchSelects(t);
  const entry = paxEntry(Object.assign(t.config, { sharePoint: folderConfig(/** @type {any} */ (parseSharePointFolder(MOVED))) }), PAX_TEMPLATE);
  await publishWithDesktop(t.ctx, entry);
  assert.deepEqual(offered, [['check', 'keep', 'stop']]);
  printed(t, `    ${laterText(t)}\n`);
  assert.equal(pbiOf(t).desktopPending, `desktop;${desktopHash(entry)}`);
  assert.equal(pbiOf(t).credentials, 'set');
  assert.equal(t.config.semanticModel.signature, `desktop;${desktopHash(old)}`);
});

test('pax publish: publishWithDesktop takes up the report of a model already in place, and writes nothing', async () => {
  const t = setup({ yes: true });
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  const signature = `desktop;${desktopHash(entry)}`;
  Object.assign(t.config.semanticModel, { id: 'ds-desktop', name: P.model, signature, bound: true });
  Object.assign((/** @type {any} */ (t.config).powerBi ??= {}), { publishedBy: 'desktop', credentials: 'set', refreshAt: '06:00' });
  publishFromDesktop(t, { report: 'rp-9' });
  let called = false;
  await publishWithDesktop(t.ctx, entry, {
    beforeDesktop: async () => {
      called = true;
    },
  });
  assert.equal(called, false, 'nothing for Desktop to do');
  assert.equal(existsSync(t.pbit), false);
  assert.deepEqual(t.config.semanticModel.report, { id: 'rp-9', name: P.report, signature: 'desktop', modelId: 'ds-desktop' });
  assert.equal(pbiOf(t).credentials, 'set', 'the same model keeps its sign-in');
  assert.equal(pbiOf(t).refreshAt, '06:00');
  assert.equal(t.config.semanticModel.bound, true);
  assert.equal(t.saves(), 1);
  printed(t, `✓ The ${P.report} report is in place`);
});

test('pax publish: publishWithDesktop runs beforeDesktop before it writes the file or shows the steps', async () => {
  const t = setup({ yes: true });
  /** @type {any[]} */
  const seen = [];
  const beforeDesktop = async () => {
    seen.push([existsSync(t.pbit), t.out().includes('Publish from Power BI Desktop'), t.saves()]);
  };
  assert.ok(isResumeLater(await rejection(publishWithDesktop(t.ctx, paxEntry(t.config, PAX_TEMPLATE), { beforeDesktop }))));
  assert.deepEqual(seen, [[false, false, 0]]);

  const u = setup({ yes: true });
  const boom = new Error('The PAX files are not in the folder yet');
  const failing = async () => {
    throw boom;
  };
  await assert.rejects(publishWithDesktop(u.ctx, paxEntry(u.config, PAX_TEMPLATE), { beforeDesktop: failing }), (e) => e === boom);
  assert.equal(existsSync(u.pbit), false);
  assert.equal(u.saves(), 0);
  assert.equal(pbiOf(u).desktopPending, undefined);
});

test("pax publish: publishWithDesktop passes an entry's expressions into the file, and leaves the entry alone", async () => {
  const t = setup({ yes: true });
  const entry = { ...paxEntry(t.config, PAX_TEMPLATE), expressions: { EmptyTable: EMPTY_TABLE } };
  const before = structuredClone(entry);
  assert.ok(isResumeLater(await rejection(publishWithDesktop(t.ctx, entry))));
  assert.deepEqual(entry, before);
  const model = /** @type {any} */ (readTemplateModel(readFileSync(t.pbit)).model);
  const expr = model.expressions?.find((/** @type {any} */ e) => e.name === 'EmptyTable');
  assert.equal([expr?.expression].flat().join('\n'), EMPTY_TABLE);
  assert.equal(mParameter(model, PARAMS.site), SITE_URL, 'the parameters too');
  assert.equal(pbiOf(t).desktopPending, `desktop;${desktopHash(entry)}`);
});

test('pax publish: publishWithDesktop does not take a model without its report as published', async () => {
  const t = setup({ answers: ['check', 'stop'] });
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  const offered = watchSelects(t, () => publishFromDesktop(t, { report: null }));
  const err = await rejection(publishWithDesktop(t.ctx, entry));
  assert.ok(isResumeLater(err), String(err));
  assert.equal(offered.length, 2, 'asked again');
  printed(t, `! ${P.model} in ${WORKSPACE} has no report on it yet. Publish the file from Power BI Desktop, which publishes the report with its model.`);
  assert.doesNotMatch(t.out(), /Found .* and its report/);
  assert.equal(t.config.semanticModel.id, undefined);
  assert.equal(t.config.semanticModel.report, undefined);
  assert.equal(pbiOf(t).desktopPending, `desktop;${desktopHash(entry)}`);
});

test('pax publish: publishWithDesktop takes up the report published onto a model the API made without one', async () => {
  const t = setup({ yes: true });
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  withModel(t, { signedIn: false });
  t.pbi.datasets.push({ id: 'ds-9', name: P.model });
  const err = await rejection(publishWithDesktop(t.ctx, entry));
  assert.ok(isResumeLater(err), 'a model without its report is not in place');
  assert.doesNotMatch(t.out(), /new version|Kept the version/);
  // Desktop's Replace keeps the model, and adds the report.
  t.pbi.reports.push({ id: 'rp-desktop', name: P.report, datasetId: 'ds-9' });
  await publishWithDesktop(t.ctx, entry);
  printed(t, `✓ Found the ${P.report} report you published from Power BI Desktop`);
  printed(t, `✓ The ${P.report} report is in place`);
  const sm = /** @type {any} */ (t.config.semanticModel);
  assert.equal(sm.id, 'ds-9');
  assert.equal(sm.signature, `desktop;${desktopHash(entry)}`);
  assert.deepEqual(sm.report, { id: 'rp-desktop', name: P.report, signature: 'desktop', modelId: 'ds-9' });
  assert.equal(pbiOf(t).publishedBy, 'desktop');
  assert.equal(pbiOf(t).desktopPending, undefined);
});

test('pax publish: publishWithDesktop prefers a model with its report to the recorded one without', async () => {
  const t = setup({ yes: true });
  const entry = paxEntry(t.config, PAX_TEMPLATE);
  withModel(t, { signedIn: false });
  t.pbi.datasets.push({ id: 'ds-9', name: P.model });
  assert.ok(isResumeLater(await rejection(publishWithDesktop(t.ctx, entry))));
  publishFromDesktop(t);
  await publishWithDesktop(t.ctx, entry);
  printed(t, `✓ Found the ${P.report} report you published from Power BI Desktop`);
  const sm = /** @type {any} */ (t.config.semanticModel);
  assert.equal(sm.id, 'ds-desktop');
  assert.equal(sm.report.id, 'rp-desktop');
  assert.equal(sm.report.modelId, 'ds-desktop');
});

// ---- publishPax ----

const coded = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) =>
  new HttpError(message, { status, method: 'POST', url: 'https://api.fabric.microsoft.com/v1/workspaces/ws-1/items', code });
/** @param {Setup} t @param {string} type */
const itemOf = (t, type) => t.fabric.items.find((i) => i.type === type);

test('pax publish: publishPax publishes the model and report through the API, filled in for the folder', async () => {
  const t = setup({ agent365: true });
  const access = (/** @type {any} */ (t.config).access ??= {});
  access.reportShared = true;
  await publishPax(t.ctx);
  assert.deepEqual(t.fabric.calls, [`createSemanticModel ${P.model}`, `createReport ${P.report}`]);
  const model = itemOf(t, 'SemanticModel');
  const report = itemOf(t, 'Report');
  const bim = itemBim(model).model;
  for (const [name, value] of Object.entries(paxEntry(t.config, PAX_TEMPLATE).parameters)) assert.equal(mParameter(bim, name), value, name);
  assert.equal(mParameter(bim, PARAMS.agents365), `${FOLDER_URL}/${encodeURIComponent(FILES.agents365)}`);
  const sm = /** @type {any} */ (t.config.semanticModel);
  assert.equal(sm.id, model?.id);
  assert.equal(sm.name, P.model);
  assert.equal(sm.enabled, true);
  assert.equal(sm.reports, true);
  assert.equal(sm.bound, false, 'a new model is not signed in to SharePoint');
  const prefix = `${paxSignature(t.config)};`;
  assert.ok(sm.signature.startsWith(prefix), sm.signature);
  assert.match(sm.signature.slice(prefix.length), /^[0-9a-f]{8,}$/);
  assert.equal(sm.report.id, report?.id);
  assert.equal(sm.report.modelId, sm.id);
  assert.equal(reportModelId(report), sm.id, 'the report is on the model');
  assert.deepEqual(pbiOf(t), { publishedBy: 'api' });
  assert.equal(access.reportShared, undefined);
  assert.equal(Object.keys(/** @type {any} */ (t.config.fabric).pendingItems ?? {}).length, 0);
  assert.equal(existsSync(t.pbit), false, 'no file for Desktop');
  printed(t, `✓ Created semantic model ${P.model}`);
  printed(t, `✓ Published the ${P.report} report, on ${P.model}`);
});

test('pax publish: publishPax leaves an API-published model in place, keeping its sign-in', async () => {
  const t = setup();
  await publishPax(t.ctx);
  Object.assign(pbiOf(t), { credentials: 'set', refreshAt: '06:00' });
  const sm = /** @type {any} */ (t.config.semanticModel);
  const { id, signature } = sm;
  t.fabric.calls.length = 0;
  await publishPax(t.ctx);
  assert.deepEqual(t.fabric.calls, []);
  assert.equal(sm.id, id);
  assert.equal(sm.signature, signature);
  assert.equal(sm.bound, true);
  assert.equal(pbiOf(t).credentials, 'set');
  assert.equal(pbiOf(t).refreshAt, '06:00');
  printed(t, `✓ Semantic model ${P.model} is in place`);
  printed(t, `✓ The ${P.report} report is in place`);
});

test('pax publish: publishPax updates the model in place when the folder moves', async () => {
  const t = setup();
  await publishPax(t.ctx);
  Object.assign(pbiOf(t), { credentials: 'set', refreshAt: '06:00' });
  const sm = /** @type {any} */ (t.config.semanticModel);
  const { id, signature } = sm;
  t.config.sharePoint = folderConfig(/** @type {any} */ (parseSharePointFolder(MOVED)));
  t.fabric.calls.length = 0;
  await publishPax(t.ctx);
  assert.ok(t.fabric.calls.includes(`updateSemanticModel ${P.model}`), t.fabric.calls.join('\n'));
  assert.ok(!t.fabric.calls.some((c) => c.startsWith('create')), t.fabric.calls.join('\n'));
  assert.equal(sm.id, id);
  assert.notEqual(sm.signature, signature);
  assert.ok(sm.signature.startsWith(`${paxSignature(t.config)};`));
  assert.deepEqual(sm.reload, { since: '2026-06-01T12:00:00.000Z' }, 'the new definition owes a refresh');
  assert.equal(pbiOf(t).credentials, 'set', 'taken to keep its sign-in');
  assert.equal(sm.bound, true);
  assert.equal(mParameter(itemBim(itemOf(t, 'SemanticModel')).model, PARAMS.users), `${MOVED_URL}/${encodeURIComponent(FILES.users)}`);
  printed(t, `✓ Updated semantic model ${P.model}`);
});

test('pax publish: publishPax hands over to Desktop when the API is turned down, and stays with Desktop', async () => {
  const t = setup({ yes: true });
  const refused = coded(403, 'FeatureNotAvailable', 'The workspace has no capacity');
  t.fabric.failures.createSemanticModel = [refused];
  const err = await rejection(publishPax(t.ctx));
  assert.ok(isResumeLater(err), String(err));
  printed(t, `! Power BI didn't take the ${P.report} report through its API (FeatureNotAvailable The workspace has no capacity).`);
  assert.equal(t.fabric.items.length, 0);
  assert.ok(existsSync(t.pbit));
  assert.equal(pbiOf(t).publishedBy, 'desktop');
  assert.equal(pbiOf(t).desktopPending, `desktop;${desktopHash(paxEntry(t.config, PAX_TEMPLATE))}`);

  publishFromDesktop(t);
  t.fabric.calls.length = 0;
  await publishPax(t.ctx);
  assert.deepEqual(t.fabric.calls, [], 'the API is not tried again');
  assert.equal(t.config.semanticModel.id, 'ds-desktop');
  assert.equal(t.config.semanticModel.report?.id, 'rp-desktop');
  printed(t, `✓ Found the ${P.report} report you published from Power BI Desktop`);
});

test('pax publish: publishPax hands a refused update over to Desktop, with the new folder in the file', async () => {
  const t = setup({ yes: true });
  await publishPax(t.ctx);
  t.config.sharePoint = folderConfig(/** @type {any} */ (parseSharePointFolder(MOVED)));
  t.fabric.failures.updateSemanticModel = [httpError(403, 'Forbidden')];
  await publishPax(t.ctx);
  printed(t, `! Power BI didn't take the ${P.report} report through its API (Forbidden).`);
  printed(t, `! Kept the version of ${P.report} that's there. ${laterText(t)}`);
  assert.equal(pbiOf(t).publishedBy, 'desktop');
  assert.equal(mParameter(readTemplateModel(readFileSync(t.pbit)).model, PARAMS.interactions), `${MOVED_URL}/${encodeURIComponent(FILES.interactions)}`);
});

test('pax publish: publishPax stops on anything other than the API being turned down', async () => {
  for (const err of [httpError(500, 'Internal error'), coded(403, 'InsufficientPrivileges', 'Forbidden'), new Error('socket hang up')]) {
    const t = setup({ yes: true });
    t.fabric.failures.createSemanticModel = [err];
    await assert.rejects(publishPax(t.ctx), (e) => e === err, err.message);
    assert.equal(existsSync(t.pbit), false, err.message);
    assert.notEqual(pbiOf(t).publishedBy, 'desktop', err.message);
  }
});

test('pax publish: publishPax needs the template and the folder before it records anything', async () => {
  const t = setup({ sources: { ...realSources(), paxModelFile: undefined } });
  await assert.rejects(publishPax(t.ctx), { message: `This checkout has no SharePoint template for the ${P.report} report.` });
  assert.equal(t.saves(), 0);
  const u = setup({ folder: null });
  await assert.rejects(publishPax(u.ctx), { message: NO_FOLDER });
  assert.equal(u.saves(), 0);
  assert.equal(u.config.semanticModel.enabled, undefined);
});

test("pax publish: publishPax names a new model after the route's, unless it was given a name", async () => {
  /** @type {[string, string][]} */
  const cases = [
    [MODEL_NAME, P.model],
    ['', P.model],
    ['Copilot usage', 'Copilot usage'],
  ];
  for (const [given, expected] of cases) {
    const t = setup();
    t.config.semanticModel.name = given;
    await publishPax(t.ctx);
    assert.equal(t.config.semanticModel.name, expected, given);
    assert.equal(t.fabric.calls[0], `createSemanticModel ${expected}`, given);
  }
});

test('pax publish: publishPax does not take a model whose report was refused as published', async () => {
  const t = setup({ yes: true });
  t.fabric.failures.createReport = [httpError(400, 'Report creation is not supported in this workspace')];
  const err = await rejection(publishPax(t.ctx));
  assert.ok(isResumeLater(err), String(err));
  assert.match(err.message, /^Stopped until the report is published\. /);
  printed(t, `! Power BI didn't take the ${P.report} report through its API (Report creation is not supported in this workspace).`);
  assert.doesNotMatch(t.out(), /new version|Kept the version/);
  const sm = /** @type {any} */ (t.config.semanticModel);
  assert.equal(sm.id, itemOf(t, 'SemanticModel')?.id, 'the model the API made is recorded');
  assert.equal(sm.report?.id, undefined, 'no report');
  assert.equal(pbiOf(t).publishedBy, 'desktop');
  assert.ok(pbiOf(t).desktopPending);
});

// ---- Sign-in and schedule ----

test('pax publish: askCredentials asks nothing without a model or a workspace', async () => {
  const t = setup();
  assert.equal(await askCredentials(t.ctx), false);
  const u = setup();
  withModel(u, { signedIn: false });
  delete (/** @type {any} */ (u.config.fabric).workspaceId);
  assert.equal(await askCredentials(u.ctx), false);
  assert.equal(t.out() + u.out(), '');
  assert.equal(t.saves() + u.saves(), 0);
});

test('pax publish: askCredentials says so when the model is signed in', async () => {
  const t = setup();
  withModel(t);
  assert.equal(await askCredentials(t.ctx), true);
  printed(t, `✓ ${P.model} is signed in to SharePoint`);
  assert.deepEqual(t.ui.asked, []);
  assert.equal(t.saves(), 0);
});

test('pax publish: askCredentials with --yes shows the steps and leaves the sign-in for later', async () => {
  const t = setup({ yes: true });
  withModel(t, { signedIn: false });
  assert.equal(await askCredentials(t.ctx), false);
  printed(t, 'Sign the report in to SharePoint\n');
  printed(t, `    ${P.model} reads the files in the SharePoint folder as you. Power BI has no way for the installer to sign it in, so do it once:\n`);
  credentialSteps(modelSettingsUrl('ws-1', 'ds-9')).forEach((s, i) => printed(t, `${i + 1}. ${s}\n`));
  printed(t, `    Until it's signed in, the report has no data. Then run "${commandLine('refresh')}".\n`);
  assert.equal(pbiOf(t).credentials, 'later');
  assert.equal(t.config.semanticModel.bound, false);
  assert.equal(t.saves(), 1);
  assert.deepEqual(t.ui.asked, []);
});

test('pax publish: askCredentials records what the user says', async () => {
  /** @type {[string, boolean][]} */
  const cases = [
    ['set', true],
    ['later', false],
  ];
  for (const [answer, bound] of cases) {
    const t = setup({ answers: [answer] });
    withModel(t, { signedIn: false });
    const offered = watchSelects(t);
    assert.equal(await askCredentials(t.ctx), bound, answer);
    assert.deepEqual(offered, [['set', 'later']]);
    assert.deepEqual(t.ui.asked, ['Signed it in?']);
    assert.equal(pbiOf(t).credentials, answer);
    assert.equal(t.config.semanticModel.bound, bound);
    assert.equal(t.saves(), 1);
  }
});

test('pax publish: refreshTimes are the hours after the PAX task, on the half hour', () => {
  assert.equal(TASK_AT, '02:00');
  assert.deepEqual(REFRESH_AFTER_HOURS, [4, 10]);
  assert.deepEqual(refreshTimes(), ['06:00', '12:00']);
  /** @type {[string, string[]][]} */
  const cases = [
    [TASK_AT, ['06:00', '12:00']],
    ['20:00', ['00:00', '06:00']],
    ['16:00', ['02:00', '20:00']],
    ['23:45', ['04:00', '10:00']],
    ['02:10', ['06:30', '12:30']],
    ['02:30', ['06:30', '12:30']],
    ['x', ['06:00', '12:00']],
  ];
  for (const [at, times] of cases) assert.deepEqual(refreshTimes(at), times, at);
});

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

test('pax publish: setPaxSchedule schedules the daily refresh after the PAX task, in the recorded time zone', async () => {
  const t = setup();
  withModel(t).timeZone = 'GMT Standard Time';
  assert.equal(await setPaxSchedule(t.ctx), true);
  assert.deepEqual(t.pbi.calls, ['setRefreshSchedule ws-1 ds-9']);
  assert.deepEqual(t.pbi.schedules, [
    { value: { enabled: true, days: DAYS, times: ['06:00', '12:00'], localTimeZoneId: 'GMT Standard Time', notifyOption: 'MailOnFailure' } },
  ]);
  assert.equal(pbiOf(t).refreshAt, '06:00');
  assert.equal(pbiOf(t).timeZone, 'GMT Standard Time');
  assert.equal(t.saves(), 1);
  printed(t, `✓ ${P.model} refreshes daily at 06:00 and 12:00 (GMT Standard Time), after the PAX refresh`);
});

test('pax publish: setPaxSchedule follows the task time, in UTC when no time zone is recorded', async () => {
  const t = setup();
  withModel(t);
  /** @type {any} */ (t.config).pax.task.at = '20:00';
  assert.equal(await setPaxSchedule(t.ctx), true);
  assert.equal(t.pbi.schedules[0].value.localTimeZoneId, 'UTC');
  assert.deepEqual(t.pbi.schedules[0].value.times, ['00:00', '06:00']);
  assert.equal(pbiOf(t).refreshAt, '00:00');
  assert.equal(pbiOf(t).timeZone, 'UTC');
});

test('pax publish: setPaxSchedule waits for a signed-in model in a workspace', async () => {
  /** @type {[string, (t: Setup) => void][]} */
  const cases = [
    ['not signed in', (t) => withModel(t, { signedIn: false })],
    ['signed in later', (t) => (withModel(t, { signedIn: false }).credentials = 'later')],
    ['no model', (t) => (withModel(t), delete t.config.semanticModel.id)],
    ['no workspace', (t) => (withModel(t), delete (/** @type {any} */ (t.config.fabric).workspaceId))],
  ];
  for (const [label, arrange] of cases) {
    const t = setup();
    arrange(t);
    assert.equal(await setPaxSchedule(t.ctx), false, label);
    assert.deepEqual(t.pbi.calls, [], label);
    assert.equal(t.saves(), 0, label);
  }
});

test('pax publish: setPaxSchedule explains a schedule Power BI turns down, and stops on anything else', async () => {
  const t = setup();
  withModel(t).refreshAt = '06:00';
  t.pbi.failures.setRefreshSchedule = [httpError(400, `Invalid credentials ${'x'.repeat(400)}`)];
  assert.equal(await setPaxSchedule(t.ctx), false);
  printed(t, `! Power BI wouldn't schedule ${P.model}'s daily refresh: Invalid credentials xxx`);
  assert.ok(t.out().includes('x'.repeat(280)) && !t.out().includes('x'.repeat(281)), 'cut to 300 characters');
  printed(t, "    It usually means the model isn't signed in to SharePoint. Sign it in, then run the installer again.");
  assert.equal(pbiOf(t).refreshAt, undefined);
  assert.equal(t.saves(), 1);

  const u = setup();
  withModel(u).refreshAt = '06:00';
  const err = httpError(500, 'Internal error');
  u.pbi.failures.setRefreshSchedule = [err];
  await assert.rejects(setPaxSchedule(u.ctx), (e) => e === err);
  assert.equal(u.saves(), 0);
  assert.equal(pbiOf(u).refreshAt, '06:00');
});

test('pax publish: historyState reads a refresh, through Unknown to its extended status', () => {
  assert.equal(historyState({ status: 'Completed' }), 'Completed');
  assert.equal(historyState({ status: 'Failed', extendedStatus: 'Failed' }), 'Failed');
  assert.equal(historyState({ status: 'Unknown', extendedStatus: 'InProgress' }), 'InProgress');
  assert.equal(historyState({ status: 'Unknown', extendedStatus: 'NotStarted' }), 'NotStarted');
  assert.equal(historyState({ status: 'Unknown' }), 'Unknown');
  assert.equal(historyState(undefined), undefined);
});

// ---- Refresh ----

const ASKED = '2026-06-01T12:00:00Z';
/** A refresh in the model's history; ours unless more says otherwise. @param {string} status @param {any} [more] */
const run = (status, more = {}) => ({ requestId: 'request-1', startTime: '2026-06-01T12:00:05Z', status, ...more });
/** @param {Setup} t @param {string} prefix */
const callCount = (t, prefix) => t.pbi.calls.filter((c) => c.startsWith(prefix)).length;
const NO_REPORT = 'There is no report yet. Run the installer first.';

test('pax publish: refreshPaxModel starts a refresh and follows it to the end', async () => {
  const t = setup();
  withModel(t);
  /** @type {any} */ (t.config.semanticModel).reload = { since: '2026-05-31T12:00:00.000Z' };
  t.pbi.polls.push([], [run('Unknown', { extendedStatus: 'InProgress' })], [run('Completed')]);
  assert.deepEqual(await refreshPaxModel(t.ctx), { ok: true, status: 'Completed' });
  assert.deepEqual(t.pbi.calls, ['refreshNow ws-1 ds-9', 'refreshes ws-1 ds-9 5', 'refreshes ws-1 ds-9 5', 'refreshes ws-1 ds-9 5']);
  assert.deepEqual(t.sleeps, [REFRESH_POLL_MS, REFRESH_POLL_MS]);
  assert.equal(/** @type {any} */ (t.config.semanticModel).reload, undefined, 'nothing owed any more');
  assert.equal(t.saves(), 1);
  printed(t, `✓ Started a refresh of ${P.model}`);
  assert.match(t.out(), new RegExp(`✓ ${P.model} refreshed in `));
});

test('pax publish: refreshPaxModel finds its refresh by request ID, or else by when it started', async () => {
  const t = setup();
  withModel(t);
  t.pbi.requestIds.push('request-7');
  t.pbi.polls.push([run('Failed', { requestId: 'request-6' }), run('Completed', { requestId: 'request-7' })]);
  assert.deepEqual(await refreshPaxModel(t.ctx), { ok: true, status: 'Completed' });

  const u = setup();
  withModel(u);
  u.pbi.requestIds.push('');
  u.pbi.polls.push([run('Completed', { requestId: 'other', startTime: '2026-06-01T11:58:59Z' })], [run('Completed', { requestId: 'other', startTime: '2026-06-01T11:59:00Z' })]);
  assert.deepEqual(await refreshPaxModel(u.ctx), { ok: true, status: 'Completed' });
  assert.equal(u.sleeps.length, 1, 'one from over a minute before it asked is not its own');
});

test('pax publish: refreshPaxModel shows why a refresh failed', async () => {
  const t = setup();
  withModel(t);
  const why = JSON.stringify({ errorCode: 'ModelRefresh_ShortMessage_ProcessingError', errorDescription: 'y'.repeat(700) });
  t.pbi.polls.push([run('Failed', { serviceExceptionJson: why })]);
  assert.deepEqual(await refreshPaxModel(t.ctx), { ok: false, status: 'Failed' });
  printed(t, '✗ The refresh ended as Failed');
  printed(t, `    ${why.slice(0, 600)}\n`);
  assert.ok(!t.out().includes(why.slice(0, 601)), 'cut to 600 characters');
  assert.equal(t.config.semanticModel.bound, true);
  assert.equal(pbiOf(t).credentials, 'set');
  assert.equal(t.saves(), 0);
});

test('pax publish: refreshPaxModel forgets the sign-in when the refresh could not sign in', async () => {
  const t = setup();
  withModel(t);
  t.pbi.polls.push([run('Failed', { serviceExceptionJson: '{"errorCode":"ModelRefresh_ShortMessage_CredentialsNotSpecified"}' })]);
  assert.deepEqual(await refreshPaxModel(t.ctx), { ok: false, status: 'Failed', credentials: true });
  assert.equal(t.config.semanticModel.bound, false);
  assert.equal(pbiOf(t).credentials, undefined);
  assert.equal(t.saves(), 1);
  printed(t, `✗ ${P.model} couldn't sign in to SharePoint, so it didn't refresh.`);
});

test('pax publish: refreshPaxModel gives up waiting after two hours, on a clock that moves as it sleeps', async () => {
  const t = setup();
  withModel(t);
  let now = Date.parse(ASKED);
  const ctx = /** @type {any} */ (t.ctx);
  ctx.now = () => new Date(now);
  ctx.sleep = async (/** @type {number} */ ms) => {
    t.sleeps.push(ms);
    now += ms;
  };
  t.pbi.history.push(run('Unknown', { extendedStatus: 'InProgress' }));
  assert.deepEqual(await refreshPaxModel(t.ctx), { ok: false, status: 'InProgress' });
  assert.equal(callCount(t, 'refreshes '), REFRESH_WAIT_MS / REFRESH_POLL_MS + 1);
  assert.equal(t.sleeps.length, REFRESH_WAIT_MS / REFRESH_POLL_MS);
  assert.equal(now - Date.parse(ASKED), REFRESH_WAIT_MS);
  printed(t, `! The refresh is still running. Check later with "${commandLine('status')}".`);
  assert.equal(t.saves(), 0);

  const u = setup();
  withModel(u);
  u.pbi.history.push(run('Unknown', { extendedStatus: 'InProgress' }));
  assert.deepEqual(await refreshPaxModel(u.ctx, { timeoutMs: 60_000 }), { ok: false, status: 'InProgress' });
  assert.equal(callCount(u, 'refreshes '), 4);
  assert.equal(u.sleeps.length, 3);
});

test('pax publish: refreshPaxModel calls a refresh it cannot find not started', async () => {
  const t = setup();
  withModel(t);
  t.pbi.requestIds.push('');
  t.pbi.history.push(run('Completed', { requestId: 'old', startTime: '2026-05-31T06:00:00Z' }));
  assert.deepEqual(await refreshPaxModel(t.ctx, { timeoutMs: 40_000 }), { ok: false, status: 'NotStarted' });
  assert.equal(callCount(t, 'refreshes '), 3);
  printed(t, '! The refresh is still running.');
});

test('pax publish: refreshPaxModel does not start a refresh before the model is signed in', async () => {
  const t = setup();
  withModel(t, { signedIn: false });
  assert.deepEqual(await refreshPaxModel(t.ctx), { ok: false, credentials: true });
  assert.deepEqual(t.pbi.calls, []);
  printed(t, `! ${P.model} isn't signed in to SharePoint yet, so it can't refresh. Run the installer again to sign it in.`);
});

test("pax publish: refreshPaxModel stops at Power BI's daily limit, and follows a refresh already running", async () => {
  for (const err of [httpError(429, 'Too many requests'), httpError(400, 'You have exceeded the maximum number of refreshes')]) {
    const t = setup();
    withModel(t);
    t.pbi.failures.refreshNow = [err];
    assert.deepEqual(await refreshPaxModel(t.ctx), { ok: false, limited: true }, err.message);
    printed(t, `! Power BI won't start another refresh of ${P.model} today: a Pro workspace allows 8 a day. Its daily refresh still runs.`);
    assert.deepEqual(t.pbi.calls, ['refreshNow ws-1 ds-9'], err.message);
  }
  for (const err of [httpError(409, 'Conflict'), httpError(400, 'Another refresh is in progress')]) {
    const t = setup();
    withModel(t);
    t.pbi.failures.refreshNow = [err];
    t.pbi.polls.push([run('Completed', { requestId: 'theirs', startTime: '2026-06-01T11:30:00Z' }), run('Failed', { requestId: 'older', startTime: '2026-06-01T06:00:00Z' })]);
    assert.deepEqual(await refreshPaxModel(t.ctx), { ok: true, status: 'Completed' }, err.message);
    printed(t, '    A refresh is already running, so following that one.');
    assert.ok(!t.out().includes('Started a refresh'), err.message);
  }
});

test('pax publish: refreshPaxModel stops on other errors, can skip the wait, and needs a model in a workspace', async () => {
  const t = setup();
  withModel(t);
  const err = httpError(500, 'Internal error');
  t.pbi.failures.refreshNow = [err];
  await assert.rejects(refreshPaxModel(t.ctx), (e) => e === err);

  const u = setup();
  withModel(u);
  assert.deepEqual(await refreshPaxModel(u.ctx, { wait: false }), { ok: true, status: 'Unknown' });
  assert.deepEqual(u.pbi.calls, ['refreshNow ws-1 ds-9']);

  /** @type {((t: Setup) => void)[]} */
  const missing = [(s) => delete s.config.semanticModel.id, (s) => delete (/** @type {any} */ (s.config.fabric).workspaceId)];
  for (const arrange of missing) {
    const s = setup();
    withModel(s);
    arrange(s);
    await assert.rejects(refreshPaxModel(s.ctx), { message: NO_REPORT });
    assert.deepEqual(s.pbi.calls, []);
  }
});

test('pax publish: loadPaxModel refreshes the model and checks it answers queries', async () => {
  const t = setup();
  withModel(t).refreshAt = '06:00';
  t.pbi.history.push(run('Completed'));
  assert.deepEqual(await loadPaxModel(t.ctx), { ok: true, status: 'Completed' });
  assert.deepEqual(t.pbi.calls, ['refreshNow ws-1 ds-9', 'refreshes ws-1 ds-9 5', 'executeQueries ds-9'], 'the daily refresh is scheduled already');
  printed(t, `✓ ${P.model} answers queries (its Calendar has 90 days)`);

  const u = setup();
  withModel(u);
  u.pbi.history.push(run('Completed'));
  u.pbi.answers.push({ results: [{ tables: [{ rows: [{ '[CalendarDays]': 0 }] }] }] });
  assert.deepEqual(await loadPaxModel(u.ctx), { ok: false, status: 'Completed' });
  printed(u, `✗ ${P.model} refreshed, but its Calendar table is empty, so report pages will fail`);
});

test('pax publish: loadPaxModel asks for the sign-in again when the refresh could not sign in', async () => {
  const t = setup({ answers: ['set'] });
  withModel(t);
  t.pbi.requestIds.push('request-1', 'request-2');
  t.pbi.polls.push([run('Failed', { serviceExceptionJson: 'Credentials are missing' })], [run('Completed', { requestId: 'request-2' })]);
  assert.deepEqual(await loadPaxModel(t.ctx), { ok: true, status: 'Completed' });
  assert.equal(callCount(t, 'refreshNow '), 2);
  assert.deepEqual(t.ui.asked, ['Signed it in?']);
  assert.equal(pbiOf(t).credentials, 'set');
  assert.equal(t.config.semanticModel.bound, true);

  const y = setup({ yes: true });
  withModel(y);
  y.pbi.polls.push([run('Failed', { serviceExceptionJson: 'Credentials are missing' })]);
  assert.deepEqual(await loadPaxModel(y.ctx), { ok: false, status: 'Failed', credentials: true });
  assert.deepEqual(y.ui.asked, [], '--yes asks nothing');
  assert.equal(callCount(y, 'refreshNow '), 1);

  const l = setup({ answers: ['later'] });
  withModel(l);
  l.pbi.polls.push([run('Failed', { serviceExceptionJson: 'Credentials are missing' })]);
  assert.deepEqual(await loadPaxModel(l.ctx), { ok: false, status: 'Failed', credentials: true });
  assert.deepEqual(l.ui.asked, ['Signed it in?']);
  assert.equal(callCount(l, 'refreshNow '), 1);
  assert.equal(pbiOf(l).credentials, 'later');
});

test('pax publish: loadPaxModel without waiting does not check the model', async () => {
  const t = setup();
  withModel(t);
  assert.deepEqual(await loadPaxModel(t.ctx, { wait: false }), { ok: true, status: 'Unknown' });
  assert.equal(callCount(t, 'executeQueries '), 0);
});

test('pax publish: loadPaxModel schedules the daily refresh once the model is signed in', async () => {
  const t = setup({ answers: ['set'] });
  withModel(t, { signedIn: false }).credentials = 'later';
  t.pbi.history.push(run('Completed'));
  assert.deepEqual(await loadPaxModel(t.ctx), { ok: true, status: 'Completed' });
  assert.deepEqual(t.ui.asked, ['Signed it in?']);
  assert.deepEqual(t.pbi.calls, ['refreshNow ws-1 ds-9', 'refreshes ws-1 ds-9 5', 'setRefreshSchedule ws-1 ds-9', 'executeQueries ds-9']);
  assert.equal(pbiOf(t).refreshAt, refreshTimes(TASK_AT)[0]);
  printed(t, `✓ ${P.model} refreshes daily at ${refreshTimes(TASK_AT).join(' and ')}`);

  const u = setup();
  withModel(u);
  u.pbi.history.push(run('Completed'));
  await loadPaxModel(u.ctx);
  assert.deepEqual(u.ui.asked, []);
  assert.equal(callCount(u, 'setRefreshSchedule '), 1, 'signed in, but never scheduled');

  // Power BI can turn the schedule off while refreshes fail to sign in.
  const a = setup({ answers: ['set'] });
  withModel(a).refreshAt = '06:00';
  a.pbi.requestIds.push('request-1', 'request-2');
  a.pbi.polls.push([run('Failed', { serviceExceptionJson: 'Credentials are missing' })], [run('Completed', { requestId: 'request-2' })]);
  assert.deepEqual(await loadPaxModel(a.ctx), { ok: true, status: 'Completed' });
  assert.equal(callCount(a, 'setRefreshSchedule '), 1, 'again after a new sign-in');

  for (const [label, made] of /** @type {[string, Setup][]} */ ([
    ['--yes', setup({ yes: true })],
    ['later', setup({ answers: ['later'] })],
  ])) {
    withModel(made, { signedIn: false });
    assert.equal((await loadPaxModel(made.ctx)).credentials, true, label);
    assert.equal(callCount(made, 'setRefreshSchedule '), 0, `${label}: not signed in`);
  }
});

test('pax publish: loadPaxModel goes on when Power BI turns the schedule down', async () => {
  const t = setup();
  withModel(t);
  t.pbi.history.push(run('Completed'));
  t.pbi.failures.setRefreshSchedule = [httpError(400, 'Bad request')];
  assert.deepEqual(await loadPaxModel(t.ctx), { ok: true, status: 'Completed' });
  printed(t, `! Power BI wouldn't schedule ${P.model}'s daily refresh: Bad request`);
  assert.equal(pbiOf(t).refreshAt, undefined);
  assert.equal(callCount(t, 'executeQueries '), 1, 'and still checks the model');
});

// ---- End to end ----

test('pax publish: the SharePoint template filled with paxEntry reads back the folder file URLs and the site URL', () => {
  const pbit = readFileSync(PAX_TEMPLATE);
  const template = loadTemplateModel(PAX_TEMPLATE);
  for (const folder of [FOLDER, MOVED]) {
    for (const agent365 of [false, true]) {
      const config = paxConfig({ folder, agent365 });
      const sp = spOf(config);
      const entry = paxEntry(config, PAX_TEMPLATE);
      /** @type {Record<string, string>} */
      const expected = {
        [PARAMS.interactions]: folderFileUrl(sp, FILES.interactions),
        [PARAMS.users]: folderFileUrl(sp, FILES.users),
        [PARAMS.site]: SITE_URL,
        [PARAMS.agents365]: agent365 ? folderFileUrl(sp, FILES.agents365) : '',
        [PARAMS.feedback]: '',
      };
      const label = `${folder} agent365=${agent365}`;
      const filled = readTemplateModel(fillTemplate(pbit, entry)).model;
      const built = buildEntryModel(template, entry).model;
      for (const [name, value] of Object.entries(expected)) {
        assert.equal(mParameter(filled, name), value, `${label}: ${name} in the file`);
        assert.equal(mParameter(built, name), value, `${label}: ${name} in the model`);
      }
      assert.ok(expected[PARAMS.users].startsWith(`${folder === FOLDER ? FOLDER_URL : MOVED_URL}/`), label);
    }
  }
});
