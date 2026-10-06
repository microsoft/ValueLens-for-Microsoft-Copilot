// @ts-check
/**
 * The Data sources screen, the drop folder every CSV export goes to, and the `upload` command.
 * Each source arrives through its API, as an uploaded export, or not at all. Uploaded exports
 * go to one Lakehouse folder; the pipeline's first step recognises each by its headers and moves
 * it to the folder its load reads. A skipped source leaves its table empty and its page dormant.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandLine } from '../launch.js';
import { inspectFile, releaseStaged } from '../staging.js';
import { c } from '../ui.js';
import {
  dataSource,
  DATA_SOURCES,
  MODE_LABELS,
  modulesFromSources,
  routedSources,
  routerWanted,
  SHAREPOINT_SUBDIR,
  sourceCards,
  UPLOAD_DIR,
  UPLOAD_FOLDERS,
  uploadName,
} from '../uploads.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../staging.js').PendingUpload} PendingUpload */

/** The flow written beside the install record when the product feedback email flow is chosen. */
export const FEEDBACK_FLOW_FILE = 'analytics-hub-feedback-flow.json';
const FLOW_IMPORT = 'https://make.powerautomate.com/';
const FILE_EXPLORER = 'https://learn.microsoft.com/fabric/onelake/onelake-file-explorer';
const SHORTCUTS = 'https://learn.microsoft.com/fabric/onelake/create-onedrive-sharepoint-shortcut';

/**
 * Exports named on the command line, checked against the chosen sources.
 * @param {string[]} paths
 * @param {import('../uploads.js').DataSourceModes} modes
 * @param {string} [flag] How the files were named, for the error.
 * @returns {PendingUpload[]}
 */
export function checkCsvFiles(paths, modes, flag = '--csv') {
  return paths.map((p) => {
    const r = inspectFile(p, modes);
    if (!r.ok) throw new Error(`${flag}: ${r.error}`);
    return r.file;
  });
}

/**
 * The Data sources screen. Sets the sources and the modules they switch on, and keeps any
 * exports picked to upload.
 * @param {Ctx} ctx
 */
export async function planDataSources(ctx) {
  const { ui, config } = ctx;
  ui.heading('Data sources');
  const picked = await ui.sources(
    'Choose how each source arrives. The API is read on every run; for an export, the card says where to download it. Skipped sources leave their page empty until you turn them on.',
    sourceCards(config.dataSources),
  );
  config.dataSources = picked.modes;
  config.modules = modulesFromSources(picked.modes);
  const fromCli = checkCsvFiles(ctx.csvFiles ?? [], picked.modes);
  ctx.pendingUploads = [...fromCli, ...picked.files];

  if (config.dataSources.productFeedback === 'csv' && ctx.sources.feedbackFlowFile) {
    config.uploads.feedbackFlow = await ui.confirm(
      'Also write a Power Automate flow that saves product feedback exports emailed to you into the drop folder? It needs Power Automate premium (the HTTP action) and someone to import it.',
      config.uploads.feedbackFlow ?? false,
    );
  } else if (config.dataSources.productFeedback !== 'csv') config.uploads.feedbackFlow = false;
}

/**
 * Makes the drop folder and the folders the loads read, then uploads the exports picked.
 * @param {Ctx} ctx
 */
export async function ensureUploads(ctx) {
  const pending = ctx.pendingUploads ?? [];
  if (routerWanted(ctx.config.dataSources) || pending.length) await ensureDropFolders(ctx);
  await uploadFiles(ctx, pending);
  ctx.pendingUploads = [];
  if (ctx.config.uploads.feedbackFlow) writeFeedbackFlow(ctx);
}

/**
 * The drop folder, and the folders the loads read. The pipeline makes any that are missing too.
 * @param {Ctx} ctx
 */
async function ensureDropFolders(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  try {
    for (const path of UPLOAD_FOLDERS) await api.oneLake.createDirectory(/** @type {string} */ (f.workspaceId), /** @type {string} */ (f.lakehouseId), path);
    if (!config.uploads.folders) {
      config.uploads.folders = true;
      ctx.save();
    }
    ui.ok(`Drop folder: ${f.lakehouseName} > ${UPLOAD_DIR}`);
  } catch (err) {
    ui.warn(`Couldn't make ${UPLOAD_DIR} in ${f.lakehouseName} (${/** @type {Error} */ (err).message}).`);
    ui.info('The pipeline makes it on its first run, or make it yourself: in the Lakehouse, choose the ... next to Files, then New subfolder.');
  }
}

/**
 * Uploads exports to the drop folder. A file that fails is reported, and the rest still go.
 * @param {Ctx} ctx
 * @param {PendingUpload[]} files
 * @returns {Promise<number>} How many were uploaded.
 */
export async function uploadFiles(ctx, files) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  let done = 0;
  for (const file of files) {
    const target = `${UPLOAD_DIR}/${uploadName(file.name, ctx.now())}`;
    try {
      const bytes = new Uint8Array(readFileSync(file.path));
      await api.oneLake.writeFile(/** @type {string} */ (f.workspaceId), /** @type {string} */ (f.lakehouseId), target, bytes);
      ui.ok(`Uploaded ${file.name} (${dataSource(file.source).label})`);
      done += 1;
    } catch (err) {
      ui.fail(`Couldn't upload ${file.name}: ${/** @type {Error} */ (err).message}`);
      ui.info(`Put it in ${f.lakehouseName} > ${UPLOAD_DIR} yourself, or run "${commandLine('upload <file>')}" again.`);
    } finally {
      releaseStaged(file.token);
    }
  }
  return done;
}

/**
 * The product feedback email flow, filled in with this install's workspace, Lakehouse and app,
 * and the drop folder. The client secret stays a placeholder: it never leaves Key Vault.
 * @param {any} template
 * @param {{ workspaceName: string, lakehouseName: string, tenantId: string, clientId: string }} o
 */
export function feedbackFlow(template, o) {
  const flow = structuredClone(template);
  const p = flow.definition.parameters;
  p.OneLakeWorkspace.defaultValue = o.workspaceName;
  p.OneLakeLakehouse.defaultValue = o.lakehouseName;
  p.TargetFolder.defaultValue = UPLOAD_DIR;
  p.TargetFolder.metadata = { description: 'The Analytics Hub drop folder. The pipeline recognises each export there and loads it.' };
  p.TenantId.defaultValue = o.tenantId;
  p.ClientId.defaultValue = o.clientId;
  flow.$comment = `Written by the Analytics Hub installer. Saves product feedback CSVs emailed to you into ${UPLOAD_DIR}; the pipeline loads them on its next run. Import it in Power Automate (My flows > Import), connect Office 365 Outlook, and set ClientSecret to a secret of the app registration, which needs Contributor on the workspace.`;
  return flow;
}

/** @param {Ctx} ctx */
function writeFeedbackFlow(ctx) {
  const { ui, config, sources } = ctx;
  if (!sources.feedbackFlowFile) return;
  const file = join(ctx.configFile ? dirname(ctx.configFile) : process.cwd(), FEEDBACK_FLOW_FILE);
  try {
    const flow = feedbackFlow(JSON.parse(readFileSync(sources.feedbackFlowFile, 'utf8')), {
      workspaceName: config.fabric.workspaceName ?? '',
      lakehouseName: config.fabric.lakehouseName ?? '',
      tenantId: config.tenantId ?? '',
      clientId: config.app.appId ?? '',
    });
    writeFileSync(file, `${JSON.stringify(flow, null, 2)}\n`);
    config.uploads.flowFile = file;
    ctx.save();
    ui.ok(`Product feedback email flow: ${file}`);
  } catch (err) {
    ui.warn(`Couldn't write the product feedback email flow (${/** @type {Error} */ (err).message}).`);
  }
}

/**
 * How each source arrives, where the exports go, and how to keep them up to date.
 * @param {Ctx} ctx
 */
export function dataSourcesSummary(ctx) {
  const { ui, config } = ctx;
  const ds = config.dataSources;
  const lakehouse = config.fabric.lakehouseName;
  ui.heading('Data sources');
  for (const s of DATA_SOURCES) {
    const mode = ds[s.id];
    const dormant = mode === 'skip' && s.page ? c.dim(`  ${s.page} page stays empty`) : '';
    ui.info(`${s.label}: ${MODE_LABELS[mode]}${dormant}`);
    if (mode === 'csv' && s.export) ui.note(`  ${s.export.where} ${s.export.url}`);
  }
  if (!routedSources(ds).length) return;

  ui.info(c.bold('Adding exports'));
  ui.info(`Drop each export in ${lakehouse} > ${UPLOAD_DIR}, as downloaded: no renaming, no subfolders.`);
  ui.info('The next run recognises it by its columns, loads it, and moves it to _processed.');
  ui.info('Ways to add one:');
  ui.info(`  - OneLake File Explorer, which shows the folder in Windows Explorer  ${c.dim(FILE_EXPLORER)}`);
  ui.info('  - In Fabric: open the Lakehouse, choose the ... next to the folder, then Upload > Upload files');
  ui.info(`  - "${commandLine('upload <file.csv> --run')}" uploads and loads it now`);
  ui.note(`  A file the run doesn't recognise goes to ${UPLOAD_DIR}/_unrecognised.`);
  ui.info(c.bold('A SharePoint or OneDrive folder instead') + c.dim('  (optional)'));
  ui.info(`  In the Lakehouse, open ${UPLOAD_DIR}, choose New shortcut > OneDrive (SharePoint), pick your folder,`);
  ui.info(`  and name the shortcut "${SHAREPOINT_SUBDIR.split('/').pop()}". Exports dropped there are loaded once each and left in place.`);
  ui.note(`  Shortcuts need the tenant setting for OneDrive and SharePoint shortcuts; without it, use ${UPLOAD_DIR}.  ${SHORTCUTS}`);
  if (config.uploads.feedbackFlow && config.uploads.flowFile) {
    ui.info(c.bold('Product feedback by email'));
    ui.info(`  1. Import it into Power Automate (${FLOW_IMPORT}), as the flows README describes.`);
    ui.info(`     The flow: ${config.uploads.flowFile}`);
    ui.info('  2. Connect Office 365 Outlook, and set ClientSecret to a secret of the app registration.');
    ui.info(`     The app needs Contributor on ${config.fabric.workspaceName ?? 'the workspace'} to write to the Lakehouse.`);
    ui.info('  3. Schedule the product feedback export to be emailed with the subject "Copilot Product Feedback".');
  }
}

/**
 * Uploads exports to an existing install, then runs the pipeline if asked.
 * @param {Ctx} ctx
 * @param {{ files: string[], run?: boolean, wait?: boolean }} opts
 * @param {(ctx: Ctx, o: { wait: boolean }) => Promise<{ ok?: boolean }>} runNow
 * @returns {Promise<boolean>}
 */
export async function uploadCommand(ctx, opts, runNow) {
  const { ui, config } = ctx;
  const f = config.fabric;
  if (!f.workspaceId || !f.lakehouseId) throw new Error('Nothing is installed yet. Run the installer first.');
  const modes = config.dataSources;
  if (!f.notebooks.uploadRouter || !routerWanted(modes)) {
    throw new Error(`This install doesn't load exports. Run the installer again ("${commandLine('install')}") and set a source to Upload CSV on the Data sources screen.`);
  }
  ui.heading('Upload exports');
  ui.note(`To ${f.lakehouseName} > ${UPLOAD_DIR}. Sources that take an export: ${routedSources(modes).map((id) => dataSource(id).label).join(', ')}.`);
  /** @type {PendingUpload[]} */
  let files;
  if (opts.files.length) files = checkCsvFiles(opts.files, modes, 'upload');
  else {
    const picked = await ui.sources('Choose the exports to upload.', sourceCards(modes).filter((card) => card.uploadable && modes[card.id] !== 'skip'), { lockModes: true });
    files = picked.files;
  }
  if (!files.length) {
    ui.warn('No exports to upload.');
    return true;
  }
  await ensureDropFolders(ctx);
  const sent = await uploadFiles(ctx, files);
  if (!sent) return false;
  const go = opts.run ?? (await ui.confirm('Run the pipeline now to load them? Otherwise the next scheduled run does.', false));
  if (!go) {
    ui.ok('They load on the next scheduled run.');
    return true;
  }
  const result = await runNow(ctx, { wait: opts.wait ?? true });
  return !(opts.wait ?? true) || !!result.ok;
}
