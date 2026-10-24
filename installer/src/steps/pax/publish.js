// @ts-check
/**
 * The PAX route's report in the Power BI service. The SharePoint template's model and report go
 * to a Power BI workspace through the item API or, where the service turns that down, through
 * Power BI Desktop. The model is then signed in to SharePoint once, by hand, and refreshes daily
 * after the PAX refresh has written the files.
 *
 * Nothing here names a product: every name comes from product.js, so another installer can copy it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { semanticModelDefinition } from '../../clients/fabric.js';
import { MODEL_NAME } from '../../config.js';
import { HttpError } from '../../http.js';
import { commandLine } from '../../launch.js';
import { PRODUCT } from '../../product.js';
import { loadTemplateModel, PBISM } from '../../transform/model.js';
import { buildEntryModel, fillTemplate } from '../../transform/template.js';
import { formatDuration } from '../../ui.js';
import { foreignInstall, foreignWorkspaceMessage, freeName, noteRenamed } from '../fabric.js';
import { ResumeLater } from '../identity.js';
import { TASK_AT } from './local.js';
import { deployModel, modelSettingsUrl, REFRESH_FINAL, REFRESH_POLL_MS, verifyModel } from '../model.js';
import { deployReport } from '../report.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {import('../../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../../config.js').PowerBiConfig} PowerBiConfig */
/** @typedef {import('../../transform/template.js').ModelEntry} ModelEntry */

/**
 * What this module reads from PRODUCT.pax. The last three are optional hooks for a product whose
 * template needs them. ValueLens's has none.
 * @typedef {object} PaxProduct
 * @property {Record<string, string>} files
 * @property {Record<string, string>} parameters
 * @property {(config: InstallConfig) => Record<string, unknown>} [values]  More template values from the install record. Numbers and true or false keep their type, null is blank, and anything else becomes text. Each is written as the type its parameter declares. A site, folder or file value of the same name wins.
 * @property {Record<string, string | { file: string }>} [expressions]  Whole queries to replace: M text, or a UTF-8 file beside the template.
 * @property {string} [privacyLevel]  The privacy level for the model's SharePoint sign-in. None by default.
 */
const PAX = /** @type {PaxProduct} */ (/** @type {unknown} */ (PRODUCT.pax));

/**
 * How many hours after the PAX refresh starts Power BI refreshes the model: once when a daily run
 * has usually finished, and again later in case a long one hadn't.
 */
export const REFRESH_AFTER_HOURS = Object.freeze([4, 10]);
const EVERY_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** How long a refresh the installer waits for may take. */
export const REFRESH_WAIT_MS = 2 * 3_600_000;

/** @param {unknown} err @param {number} status */
const isStatus = (err, status) => err instanceof HttpError && err.status === status;
/** @param {unknown} err */
const errorText = (err) => `${err instanceof HttpError ? (err.code ?? '') : ''} ${/** @type {Error} */ (err)?.message ?? err}`.trim();
/** @param {unknown} s */
const lower = (s) => String(s ?? '').toLowerCase();

/** @param {InstallConfig} config */
const powerBiOf = (config) => /** @type {PowerBiConfig} */ ((config.powerBi ??= {}));

/** Where files for the user go: beside the install record. @param {Ctx} ctx */
const outDir = (ctx) => (ctx.configFile ? dirname(ctx.configFile) : process.cwd());

/**
 * Whether the refresh writes one of the files in PRODUCT.pax.files. It writes each of them,
 * except one in PRODUCT.pax.optionalFiles while its switch in the record's `pax` is off.
 * @param {InstallConfig} config
 * @param {string} key
 */
export function paxWrites(config, key) {
  const flag = /** @type {Record<string, string>} */ (PRODUCT.pax.optionalFiles)[key];
  return !flag || !!(/** @type {Record<string, unknown>} */ (config.pax ?? {}))[flag];
}

/**
 * A file's address in the SharePoint folder.
 * @param {import('../../config.js').SharePointConfig} sp
 * @param {string} name
 */
export const folderFileUrl = (sp, name) => `${sp.folderUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;

/**
 * The template's values for this install: `site` takes the site's address, `folder` the folder's,
 * and each file parameter the file's full address in the folder. A file the refresh doesn't write
 * is left blank, so its table loads empty. A product's `values` hook adds values from the install
 * record, and its `expressions` replace whole queries, so desktopHash covers both.
 * @param {InstallConfig} config
 * @param {string} template  The .pbit's path.
 * @param {PaxProduct} [pax]  PRODUCT.pax, or a stand-in for tests.
 * @returns {ModelEntry}
 */
export function paxEntry(config, template, pax = PAX) {
  const sp = config.sharePoint;
  if (!sp?.folderUrl || !sp.siteUrl) throw new Error('The install record has no SharePoint folder yet. Run the installer to choose one.');
  const files = pax.files;
  /** @type {ModelEntry['parameters']} */
  const parameters = {};
  for (const [name, value] of Object.entries(pax.values?.(config) ?? {})) {
    parameters[name] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value ?? '');
  }
  for (const [key, name] of Object.entries(pax.parameters)) {
    if (key === 'site') parameters[name] = sp.siteUrl;
    else if (key === 'folder') parameters[name] = sp.folderUrl;
    else parameters[name] = files[key] && paxWrites(config, key) ? folderFileUrl(sp, files[key]) : '';
  }
  /** @type {Record<string, string>} */
  const expressions = {};
  for (const [name, value] of Object.entries(pax.expressions ?? {})) {
    expressions[name] = typeof value === 'string' ? value : readFileSync(join(dirname(template), value.file), 'utf8').replace(/^\uFEFF/, '');
  }
  return { template, parameters, ...(Object.keys(expressions).length ? { expressions } : {}) };
}

/** What the deployed model was built from, besides its definition. @param {InstallConfig} config */
export const paxSignature = (config) => `pax;${lower(config.sharePoint?.folderUrl)}`;

/**
 * A short hash of what goes to Power BI Desktop: the template and this install's values in it.
 * @param {ModelEntry} entry
 */
export function desktopHash(entry) {
  return createHash('sha256')
    .update(readFileSync(entry.template))
    .update('\0')
    .update(JSON.stringify({ parameters: entry.parameters, expressions: entry.expressions ?? {} }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Forgets the model and its report, such as ones deleted outside the installer, and what was set
 * up on them: the SharePoint sign-in, the schedule, the share with the viewer group and its Build.
 * The next install publishes them again.
 * @param {InstallConfig} config
 */
export function forgetModel(config) {
  const sm = config.semanticModel;
  const id = sm.id;
  delete sm.id;
  delete sm.signature;
  delete sm.report;
  delete sm.reload;
  sm.bound = false;
  const pbi = powerBiOf(config);
  delete pbi.credentials;
  delete pbi.refreshAt;
  delete pbi.desktopPending;
  delete pbi.desktopFile;
  delete pbi.desktopName;
  const access = config.access;
  if (!access) return;
  delete access.reportShared;
  if (!id) return;
  if (access.grantedModels) access.grantedModels = access.grantedModels.filter((m) => m !== id);
  if (access.retiredGroups) {
    access.retiredGroups = access.retiredGroups.map((g) => ({ ...g, datasets: g.datasets.filter((m) => m !== id) })).filter((g) => g.datasets.length);
    if (!access.retiredGroups.length) delete access.retiredGroups;
  }
}

/**
 * Forgets a workspace that's gone, and everything that was in it.
 * @param {InstallConfig} config
 */
function forgetWorkspace(config) {
  const f = config.fabric;
  delete f.workspaceId;
  delete f.createdWorkspace;
  delete f.pendingItems;
  forgetModel(config);
  delete powerBiOf(config).publishedBy;
}

/**
 * Whether Power BI says the model isn't there: deleted outside the installer.
 * @param {unknown} err
 */
const modelGone = (err) => isStatus(err, 404);

/**
 * Forgets a model Power BI says is gone, and says how to publish it again.
 * @param {Ctx} ctx
 * @param {string} name
 */
function forgetGoneModel(ctx, name) {
  forgetModel(ctx.config);
  ctx.save();
  ctx.ui.warn(`${name} isn't in the workspace any more. To publish it again, run: ${commandLine('update')}`);
}

/**
 * A workspace's items, by display name. Not every Pro workspace answers the Fabric item API, so
 * this falls back to its Power BI datasets and reports.
 * @param {Ctx} ctx
 * @param {string} workspaceId
 * @returns {Promise<{ displayName: string }[]>}
 */
export async function workspaceItems(ctx, workspaceId) {
  const { api } = ctx;
  try {
    return await api.fabric.listItems(workspaceId);
  } catch {
    return [...(await api.powerBi.datasets(workspaceId).catch(() => [])), ...(await api.powerBi.reports(workspaceId).catch(() => []))].map((i) => ({ displayName: i.name }));
  }
}

/**
 * Stops before the report goes into a workspace that holds an Analytics Hub install, which already
 * has it. A workspace this install made, or already published to, is its own.
 * @param {Ctx} ctx
 */
async function refuseForeignWorkspace(ctx) {
  const { config } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || f.createdWorkspace || config.semanticModel.id) return;
  if (foreignInstall(await workspaceItems(ctx, f.workspaceId))) throw new Error(foreignWorkspaceMessage(f.workspaceName ?? f.workspaceId));
}

/**
 * The Power BI workspace the report goes to: the one chosen in the plan, or a new one. It needs
 * no capacity, so Power BI Pro is enough. A saved one that's gone is made again. When a new one's
 * name is taken by a workspace the user is in, that one is used, unless an Analytics Hub install
 * is in it.
 * @param {Ctx} ctx
 */
export async function ensurePaxWorkspace(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (f.workspaceId) {
    const id = lower(f.workspaceId);
    const found = (await api.powerBi.groups()).find((g) => lower(g.id) === id);
    if (found) {
      if (found.name && found.name !== f.workspaceName) {
        f.workspaceName = String(found.name);
        ctx.save();
      }
      await refuseForeignWorkspace(ctx);
      ui.ok(`Workspace ${f.workspaceName ?? f.workspaceId} is in place`);
      return;
    }
    ui.warn(`The workspace ${f.workspaceName ?? f.workspaceId} is gone, or you're no longer in it, so making a new one.`);
    forgetWorkspace(config);
    ctx.save();
  }
  const name = f.workspaceName ?? PRODUCT.pax.workspace;
  /** @type {any} */
  let made;
  try {
    made = await api.powerBi.createGroup(name);
  } catch (err) {
    if (isStatus(err, 401) || isStatus(err, 403)) {
      throw new Error(
        'You can\'t create Power BI workspaces in this tenant. Ask a Fabric administrator to let you (the tenant setting "Create workspaces"), ' +
          'or ask someone who can to create one and add you as Admin or Member. Then run the installer again and choose it.',
      );
    }
    if (/AlreadyExists|already exists|duplicate/i.test(errorText(err))) {
      // Such as one a run made but stopped before recording.
      const mine = (await api.powerBi.groups()).find((g) => lower(g.name) === lower(name));
      if (!mine) {
        throw new Error(`There's already a workspace called "${name}" that you aren't in. Run the installer again and choose another name, or ask its admin to add you and then choose it.`);
      }
      if (foreignInstall(await workspaceItems(ctx, String(mine.id)))) throw new Error(foreignWorkspaceMessage(String(mine.name ?? name)));
      f.workspaceId = String(mine.id);
      f.workspaceName = String(mine.name ?? name);
      delete f.createdWorkspace;
      ctx.save();
      ui.ok(`Workspace ${f.workspaceName} already exists, and you're in it, so using it`);
      return;
    }
    throw err;
  }
  f.workspaceId = String(made.id);
  f.workspaceName = String(made.name ?? name);
  f.createdWorkspace = true;
  ctx.save();
  ui.ok(`Created workspace ${f.workspaceName}`);
}

/**
 * Why the service turned down publishing through the item API, when Power BI Desktop can still
 * publish there: a workspace without a capacity, or the API turned off for the tenant. Undefined
 * for anything else, which stops the install.
 * @param {unknown} err
 */
export function apiRefusal(err) {
  if (!(err instanceof HttpError)) return undefined;
  const text = errorText(err);
  if (/InsufficientPrivileges|PrincipalTypeNotSupported|TokenExpired/i.test(text)) return undefined;
  if (err.status === 403 || /FeatureNotAvailable|capacity|Premium|licen[cs]e|not supported|Unsupported/i.test(text)) return text.slice(0, 200);
  return undefined;
}

/**
 * Publishes the model and report through the item API, or updates them when the template or the
 * folder changed. A new model has no SharePoint sign-in yet; one updated in place is taken to keep
 * the one it had, and its next refresh shows otherwise.
 * @param {Ctx} ctx
 * @param {ModelEntry} entry
 */
async function publishByApi(ctx, entry) {
  const { config } = ctx;
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  const before = sm.id;
  await deployModel(ctx, sm, {
    signature: paxSignature(config),
    definition: () => semanticModelDefinition(buildEntryModel(loadTemplateModel(entry.template), entry), PBISM),
  });
  if (sm.id !== before) {
    delete pbi.credentials;
    delete pbi.refreshAt;
  }
  sm.bound = pbi.credentials === 'set';
  pbi.publishedBy = 'api';
  ctx.save();
  // The report from the same template, not reportsWanted's, which is the Fabric route's.
  await deployReport(ctx, { model: sm, file: entry.template, name: PRODUCT.pax.report });
}

/**
 * The workspace's models and reports, and which of them are this install's: the model by its
 * recorded ID or, while a template waits in Power BI Desktop, by the name the installer gave it,
 * and the report on it. A model with a report comes before one without, such as one the item API
 * made before it turned the report down. A model the installer didn't publish is never taken
 * over, even when it has the same name.
 * @param {Ctx} ctx
 * @param {string} ws
 * @returns {Promise<{ found?: { dataset: any, report?: any }, datasets: any[], reports: any[] }>}
 */
async function findPublished(ctx, ws) {
  const { api, config } = ctx;
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  const datasets = await api.powerBi.datasets(ws);
  const reports = await api.powerBi.reports(ws);
  const name = pbi.desktopPending ? pbi.desktopName : undefined;
  const models = [
    ...datasets.filter((d) => sm.id && d.id === sm.id),
    ...datasets.filter((d) => name && d.id !== sm.id && lower(d.name) === lower(name)),
  ];
  for (const dataset of models) {
    const own = reports.filter((r) => r.datasetId === dataset.id);
    const report = (sm.report?.id && own.find((r) => r.id === sm.report?.id)) || own.find((r) => lower(r.name) === lower(name ?? PRODUCT.pax.report)) || own[0];
    if (report) return { found: { dataset, report }, datasets, reports };
  }
  return { found: models.length ? { dataset: models[0] } : undefined, datasets, reports };
}

/**
 * Records what Power BI Desktop published.
 * @param {Ctx} ctx
 * @param {{ dataset: any, report?: any }} found
 * @param {string} signature
 */
function adoptPublished(ctx, found, signature) {
  const { config } = ctx;
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  if (sm.id !== found.dataset.id) {
    delete pbi.credentials;
    delete pbi.refreshAt;
  }
  sm.id = String(found.dataset.id);
  sm.name = String(found.dataset.name ?? sm.name);
  sm.signature = signature;
  sm.bound = pbi.credentials === 'set';
  if (found.report) {
    if (sm.report?.id !== found.report.id && config.access) delete config.access.reportShared;
    sm.report = { id: String(found.report.id), name: String(found.report.name ?? PRODUCT.pax.report), signature: 'desktop', modelId: sm.id };
  }
  pbi.publishedBy = 'desktop';
  delete pbi.desktopPending;
  delete pbi.desktopFile;
  delete pbi.desktopName;
  ctx.save();
}

/**
 * The steps to publish the filled-in template from Power BI Desktop.
 * @param {string} file
 * @param {string} workspace
 * @param {string} [name]  What to save it as, which Power BI names the model and report after.
 * @param {boolean} [replace]  It replaces the install's own model of that name.
 */
export function desktopSteps(file, workspace, name = PRODUCT.pax.report, replace = false) {
  return [
    `Open ${file} in Power BI Desktop, which is free from the Microsoft Store.`,
    'If it shows the parameters, keep the values in them and select Load.',
    'When it asks how to connect to SharePoint, choose Microsoft account (or Organizational account), sign in with your work account, then select Connect.',
    `Once the data has loaded, save it as ${name}.pbix. Power BI names the report and its model after the file.`,
    replace ? `Select Publish, choose the workspace "${workspace}", and select Replace when it asks. That updates this install's ${name}.` : `Select Publish and choose the workspace "${workspace}".`,
  ];
}

/**
 * Hands the template, filled in for this install, to Power BI Desktop, then finds what the user
 * published. Desktop names the model after the file, so the file's name is the install's own
 * model's, which Desktop replaces, or a name nothing in the workspace has: Desktop never replaces
 * a model the installer didn't publish. An install published that way stays with Desktop: when
 * the template or the folder changes, it's published again the same way, and until then the
 * version already there can stay.
 * @param {Ctx} ctx
 * @param {ModelEntry} entry
 * @param {{ beforeDesktop?: () => Promise<void> }} [o]  Runs before the steps are shown, such as waiting for the files Desktop loads.
 */
export async function publishWithDesktop(ctx, entry, o = {}) {
  const { ui, config } = ctx;
  const f = config.fabric;
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  const ws = /** @type {string} */ (f.workspaceId);
  const workspace = f.workspaceName ?? ws;
  const signature = `desktop;${desktopHash(entry)}`;

  let { found, datasets, reports } = await findPublished(ctx, ws);
  // Published since a run that stopped to wait for it: a new model, or a report the record lacks.
  if (found?.report && pbi.desktopPending && (found.dataset.id !== sm.id || found.report.id !== sm.report?.id)) {
    adoptPublished(ctx, found, pbi.desktopPending);
    ui.ok(`Found the ${found.report.name ?? PRODUCT.pax.report} report you published from Power BI Desktop`);
  }
  if (sm.id && !datasets.some((d) => d.id === sm.id)) {
    ui.warn(`${sm.name} isn't in ${workspace} any more, so it's published again.`);
    forgetModel(config);
    ctx.save();
    found = undefined;
  }
  if (found?.report && sm.id === found.dataset.id && sm.signature === signature) {
    if (sm.report?.id !== found.report.id) adoptPublished(ctx, found, signature);
    ui.ok(`The ${sm.report?.name ?? PRODUCT.pax.report} report is in place`);
    return;
  }
  // Not a model without its report, such as one the item API made before turning the report down.
  const current = !!(found?.report && sm.id === found.dataset.id);
  const own = sm.id ? datasets.find((d) => d.id === sm.id) : undefined;
  const name = own?.name ? String(own.name) : freeName(PRODUCT.pax.report, [...datasets, ...reports].map((i) => String(i.name ?? '')));

  await o.beforeDesktop?.();
  const file = join(outDir(ctx), `${PRODUCT.pax.report}.pbit`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fillTemplate(readFileSync(entry.template), entry));
  pbi.publishedBy = 'desktop';
  pbi.desktopPending = signature;
  pbi.desktopFile = file;
  pbi.desktopName = name;
  ctx.save();

  ui.heading('Publish from Power BI Desktop');
  ui.info(current ? `There's a new version of the ${name} report for you to publish.` : `Publish the ${name} report from Power BI Desktop. It takes a few minutes.`);
  if (!own) noteRenamed(ctx, PRODUCT.pax.report, name);
  desktopSteps(file, workspace, name, !!own).forEach((s, i) => ui.info(`  ${i + 1}. ${s}`));
  const later = `Publish ${file} from Power BI Desktop to "${workspace}" as ${name}, then run the installer again.`;
  if (ui.yes) {
    if (current) {
      ui.warn(`Kept the version of ${name} that's there. ${later}`);
      return;
    }
    throw new ResumeLater(`Stopped until the report is published. ${later}`);
  }
  for (;;) {
    const next = await ui.select(
      'Published it?',
      [
        { name: 'I\'ve published it', value: 'check' },
        ...(current ? [{ name: 'Keep the version that\'s there for now', value: 'keep', description: 'Run the installer again to publish the new one.' }] : []),
        { name: 'Stop and resume later', value: 'stop', description: 'Your answers are saved. Run the installer again once it\'s published.' },
      ],
      'check',
    );
    if (next === 'keep') {
      ui.note(later);
      return;
    }
    if (next === 'stop') throw new ResumeLater(`Stopped until the report is published. ${later}`);
    found = (await findPublished(ctx, ws)).found;
    if (found?.report) {
      adoptPublished(ctx, found, signature);
      ui.ok(`Found ${sm.name} and its report in ${workspace}`);
      return;
    }
    ui.warn(
      found
        ? `${name} in ${workspace} has no report on it yet. Publish the file from Power BI Desktop, which publishes the report with its model.`
        : `There's no model called ${name} in ${workspace} yet. Save the file as ${name}.pbix before publishing, so Power BI gives it that name.`,
    );
  }
}

/**
 * Publishes the SharePoint template's model and report, or updates them when the template or the
 * folder changed. Where the service turns the item API down, the template goes to Power BI
 * Desktop instead, and an install published that way stays with Desktop.
 * @param {Ctx} ctx
 * @param {{ beforeDesktop?: () => Promise<void> }} [o]
 */
export async function publishPax(ctx, o = {}) {
  const { ui, config, sources } = ctx;
  const template = sources.paxModelFile;
  if (!template) throw new Error(`This checkout has no SharePoint template for the ${PRODUCT.pax.report} report.`);
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  const entry = paxEntry(config, template);
  sm.enabled = true;
  sm.reports = true;
  if (!sm.id && (!sm.name || sm.name === MODEL_NAME)) sm.name = PRODUCT.pax.model;
  ctx.save();
  if (pbi.publishedBy === 'desktop') return publishWithDesktop(ctx, entry, o);
  try {
    await publishByApi(ctx, entry);
  } catch (err) {
    const why = apiRefusal(err);
    if (!why) throw err;
    ui.warn(`Power BI didn't take the ${PRODUCT.pax.report} report through its API (${why}).`);
    await publishWithDesktop(ctx, entry, o);
  }
}

/**
 * How to sign the model in to SharePoint, on its settings page.
 * @param {string} url
 * @param {string} [privacyLevel]  PRODUCT.pax.privacyLevel, None by default.
 */
export function credentialSteps(url, privacyLevel = PAX.privacyLevel ?? 'None') {
  return [
    `Open the model's settings: ${url}`,
    'Expand Data source credentials, and select Edit credentials beside a source.',
    `Choose OAuth2 and the privacy level ${privacyLevel}, then select Sign in and sign in with your work account.`,
    'Do the same for each source it lists. If a site\'s address fails the connection test, edit it again and tick Skip test connection.',
  ];
}

/**
 * Asks the user to sign the model in to SharePoint, which Power BI has no API for. Until then it
 * can't refresh. Later, or an unattended run, leaves it for the Done page.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether it's signed in.
 */
export async function askCredentials(ctx) {
  const { ui, config } = ctx;
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  const ws = config.fabric.workspaceId;
  if (!sm.id || !ws) return false;
  if (pbi.credentials === 'set' && sm.bound) {
    ui.ok(`${sm.name} is signed in to SharePoint`);
    return true;
  }
  ui.heading('Sign the report in to SharePoint');
  ui.info(`${sm.name} reads the files in the SharePoint folder as you. Power BI has no way for the installer to sign it in, so do it once:`);
  credentialSteps(modelSettingsUrl(ws, sm.id)).forEach((s, i) => ui.info(`  ${i + 1}. ${s}`));
  if (ui.yes) {
    pbi.credentials = 'later';
    sm.bound = false;
    ctx.save();
    ui.note(`Until it's signed in, the report has no data. Then run "${commandLine('refresh')}".`);
    return false;
  }
  const answer = await ui.select(
    'Signed it in?',
    [
      { name: 'I\'ve signed it in', value: 'set' },
      { name: 'Later', value: 'later', description: 'The report has no data until it\'s signed in. The steps are on the Done page.' },
    ],
    'set',
  );
  pbi.credentials = answer === 'set' ? 'set' : 'later';
  sm.bound = answer === 'set';
  ctx.save();
  return sm.bound;
}

/**
 * When Power BI refreshes the model each day, in this PC's time zone: some hours after the PAX
 * refresh starts, on the hour or half hour as Power BI requires.
 * @param {string} [taskAt]  When the PAX refresh starts, HH:mm.
 * @returns {string[]}  HH:mm, earliest first.
 */
export function refreshTimes(taskAt = TASK_AT) {
  const [h, m] = String(taskAt).split(':').map(Number);
  const start = (Number.isInteger(h) ? h : 2) * 60 + (Number.isInteger(m) ? m : 0);
  const times = REFRESH_AFTER_HOURS.map((after) => {
    const at = (Math.ceil((start + after * 60) / 30) * 30) % (24 * 60);
    return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
  });
  return [...new Set(times)].sort();
}

/**
 * Schedules the model's daily refreshes, after the PAX refresh. It needs the SharePoint sign-in
 * first, so without it this leaves the schedule for a later run.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}
 */
export async function setPaxSchedule(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  const ws = config.fabric.workspaceId;
  if (!sm.id || !ws || pbi.credentials !== 'set') return false;
  const times = refreshTimes(config.pax?.task?.at);
  const timeZone = pbi.timeZone ?? 'UTC';
  try {
    await api.powerBi.setRefreshSchedule(ws, sm.id, { value: { enabled: true, days: EVERY_DAY, times, localTimeZoneId: timeZone, notifyOption: 'MailOnFailure' } });
  } catch (err) {
    if (modelGone(err)) {
      forgetGoneModel(ctx, sm.name);
      return false;
    }
    if (!isStatus(err, 400)) throw err;
    ui.warn(`Power BI wouldn't schedule ${sm.name}'s daily refresh: ${errorText(err).slice(0, 300)}`);
    ui.info('It usually means the model isn\'t signed in to SharePoint. Sign it in, then run the installer again.');
    delete pbi.refreshAt;
    ctx.save();
    return false;
  }
  pbi.refreshAt = times[0];
  pbi.timeZone = timeZone;
  ctx.save();
  ui.ok(`${sm.name} refreshes daily at ${times.join(' and ')} (${timeZone}), after the PAX refresh`);
  return true;
}

/** When Power BI turns a model's daily refresh off by itself. */
export const SCHEDULE_OFF_WHY =
  'Power BI turns it off after four failed refreshes in a row or an error that needs a fix, such as an expired sign-in, and pauses it when no one has opened the report for two months.';

/**
 * Turns the model's daily refresh back on when Power BI has turned it off. It runs after a refresh
 * that worked, so a schedule that would only fail again stays off. Reading the schedule can fail
 * without failing the refresh.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}  Whether it turned the schedule back on.
 */
export async function resumePaxSchedule(ctx) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const ws = config.fabric.workspaceId;
  if (!sm.id || !ws || powerBiOf(config).credentials !== 'set') return false;
  /** @type {any} */
  let schedule;
  try {
    schedule = await api.powerBi.refreshSchedule(ws, sm.id);
  } catch (err) {
    if (modelGone(err)) {
      forgetGoneModel(ctx, sm.name);
      return false;
    }
    if (!(err instanceof HttpError)) throw err;
    ui.warn(`Couldn't read ${sm.name}'s refresh schedule, so couldn't check it's on: ${errorText(err).slice(0, 300)}`);
    return false;
  }
  if (schedule?.enabled !== false) return false;
  ui.info(`Power BI had turned ${sm.name}'s daily refresh off. ${SCHEDULE_OFF_WHY} This refresh worked, so the installer turns it back on.`);
  return setPaxSchedule(ctx);
}

/**
 * A refresh's state from Power BI's history: `Unknown` while it runs, so its extended status then.
 * @param {any} r
 */
export const historyState = (r) => (r?.status === 'Unknown' ? (r?.extendedStatus ?? 'Unknown') : r?.status);

/** @param {any} r */
const refreshError = (r) => String(r?.serviceExceptionJson ?? '').slice(0, 600);

/**
 * @typedef {object} PaxRefreshResult
 * @property {boolean} ok
 * @property {string} [status]  `Unknown` when it didn't wait.
 * @property {boolean} [credentials]  It needs signing in to SharePoint again.
 * @property {boolean} [limited]  Power BI won't start another refresh today.
 * @property {boolean} [gone]  The model was deleted outside the installer, so the record forgot it.
 */

/**
 * Refreshes the model now, or follows a refresh already running, and waits for it unless `wait`
 * is false. A Pro workspace allows 8 refreshes a day, scheduled ones included. A failure to sign
 * in to SharePoint marks the model as needing its sign-in again, and a model that's been deleted
 * is forgotten, so the next update publishes it again.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<PaxRefreshResult>}
 */
export async function refreshPaxModel(ctx, opts = {}) {
  const { ui, config, api } = ctx;
  const sm = config.semanticModel;
  const pbi = powerBiOf(config);
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  if (!sm.id || !ws) throw new Error('There is no report yet. Run the installer first.');
  if (!sm.bound) {
    ui.warn(`${sm.name} isn't signed in to SharePoint yet, so it can't refresh. Run the installer again to sign it in.`);
    return { ok: false, credentials: true };
  }
  const asked = ctx.now().getTime();
  /** @type {string | undefined} */
  let requestId;
  let following = false;
  try {
    requestId = await api.powerBi.refreshNow(ws, sm.id);
    ui.ok(`Started a refresh of ${sm.name}`);
  } catch (err) {
    if (modelGone(err)) {
      forgetGoneModel(ctx, sm.name);
      return { ok: false, gone: true };
    }
    const text = errorText(err);
    if (isStatus(err, 429) || /maximum number|limit|exceeded/i.test(text)) {
      ui.warn(`Power BI won't start another refresh of ${sm.name} today: a Pro workspace allows 8 a day. Its daily refresh still runs.`);
      return { ok: false, limited: true };
    }
    if (!(isStatus(err, 409) || /in progress|already running/i.test(text))) throw err;
    following = true;
    ui.note('A refresh is already running, so following that one.');
  }
  if (opts.wait === false) return { ok: true, status: 'Unknown' };

  const progress = ui.progress('Refresh');
  const tries = Math.ceil((opts.timeoutMs ?? REFRESH_WAIT_MS) / REFRESH_POLL_MS);
  /** @type {any} */
  let r;
  let took = 0;
  let gone = false;
  try {
    for (let i = 0; i <= tries; i++) {
      /** @type {any[]} */
      let history;
      try {
        history = await api.powerBi.refreshes(ws, /** @type {string} */ (sm.id), 5);
      } catch (err) {
        if (!modelGone(err)) throw err;
        gone = true;
        break;
      }
      r =
        (requestId && history.find((h) => h.requestId === requestId)) ||
        history.find((h) => Date.parse(h.startTime) >= asked - 60_000) ||
        (following ? history[0] : undefined);
      const state = r ? historyState(r) : 'NotStarted';
      progress.update(state);
      if (REFRESH_FINAL.has(state) || i === tries) break;
      await ctx.sleep(REFRESH_POLL_MS);
    }
  } finally {
    took = progress.done();
  }
  if (gone) {
    forgetGoneModel(ctx, sm.name);
    return { ok: false, gone: true };
  }
  const state = r ? historyState(r) : 'NotStarted';
  if (state === 'Completed') {
    delete sm.reload;
    ctx.save();
    ui.ok(`${sm.name} refreshed in ${formatDuration(took)}`);
    return { ok: true, status: state };
  }
  if (!REFRESH_FINAL.has(state)) {
    ui.warn(`The refresh is still running. Check later with "${commandLine('status')}".`);
    return { ok: false, status: state };
  }
  const error = refreshError(r);
  if (/credential/i.test(error)) {
    sm.bound = false;
    delete pbi.credentials;
    ctx.save();
    ui.fail(`${sm.name} couldn't sign in to SharePoint, so it didn't refresh.`);
    return { ok: false, status: state, credentials: true };
  }
  ui.fail(`The refresh ended as ${state}`);
  if (error) ui.info(error);
  return { ok: false, status: state };
}

/**
 * Refreshes the model and checks it answers queries. A refresh that fails to sign in to
 * SharePoint asks for the sign-in again, once. Once it's signed in, it schedules the daily
 * refresh: again after a new sign-in, or after a refresh that worked when Power BI has turned the
 * schedule off.
 * @param {Ctx} ctx
 * @param {{ wait?: boolean }} [opts]
 * @returns {Promise<PaxRefreshResult>}
 */
export async function loadPaxModel(ctx, opts = {}) {
  const pbi = powerBiOf(ctx.config);
  let r = await refreshPaxModel(ctx, opts);
  if (r.gone) return r;
  let signedIn = false;
  if (r.credentials && !ctx.ui.yes) {
    signedIn = await askCredentials(ctx);
    if (signedIn) r = await refreshPaxModel(ctx, opts);
    if (r.gone) return r;
  }
  if (!r.credentials && (signedIn || !pbi.refreshAt)) await setPaxSchedule(ctx);
  else if (r.ok && r.status === 'Completed' && pbi.refreshAt) await resumePaxSchedule(ctx);
  if (r.ok && r.status === 'Completed') {
    const check = await verifyModel(ctx);
    if (!check.ok) return { ...r, ok: false };
  }
  return r;
}
