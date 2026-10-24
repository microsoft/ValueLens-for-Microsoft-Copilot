// @ts-check
/** Loads the notebooks, pipeline template and report templates, and the PAX route's scripts, from a ValueLens checkout. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTEBOOKS, NOTEBOOKS_DIR, SETUP_DIR } from './catalog.js';
import { MODEL_TEMPLATE } from './transform/model.js';

/** The source folder: the repo root when the installer runs from a checkout, `f` in the exe. */
export const DEFAULT_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PIPELINE_TEMPLATE = join(SETUP_DIR, 'pipelines', 'CopilotAdoptionPipeline.DataPipeline', 'pipeline-content.json');

/** The PAX route's report, which reads the CSV files in the SharePoint folder. */
export const PAX_MODEL_TEMPLATE = '4. SharePoint/ValueLens - SharePoint.pbit';
/** The PAX route's scripts, which the scheduled refresh runs. */
export const PAX_SCRIPTS_DIR = '4. SharePoint/scripts';
export const PAX_SCRIPTS = Object.freeze(['Run-PAX-AIBV.ps1', 'Get-Agents365Registry.ps1', 'Upload-Rollups-SharePoint.ps1']);

/**
 * The app's build, which the PAX route deploys as a Copilot Managed App. The exe ships it; in a
 * checkout, `npm ci`, `node scripts/prepare-sample.mjs` (the sample it opens with isn't committed)
 * then `npm run build` in `app` makes it.
 */
export const APP_DIST = 'app/dist';

/**
 * @typedef {object} Sources
 * @property {string} dir
 * @property {Record<import('./catalog.js').NotebookKey, import('./transform/notebook.js').Notebook>} notebooks
 * @property {any} pipeline
 * @property {string} [modelFile]  `ValueLens - Fabric.pbit`, read only when the semantic model is deployed.
 * @property {string} [paxModelFile]  `ValueLens - SharePoint.pbit`, the PAX route's report.
 * @property {string[]} [paxScripts]  The PAX scripts' paths, when the checkout has all of them.
 * @property {string} [appDist]  The app's build, when there is one.
 */

/**
 * @param {string} [dir]  The root of a ValueLens checkout.
 * @returns {Sources}
 */
export function loadSources(dir = DEFAULT_SOURCE_DIR) {
  const root = resolve(dir);
  const pipelineFile = join(root, PIPELINE_TEMPLATE);
  if (!existsSync(pipelineFile)) {
    throw new Error(`No pipeline template at ${pipelineFile}. Point --source at the root of the repo.`);
  }
  /** @type {any} */
  const notebooks = {};
  for (const nb of NOTEBOOKS) {
    const file = join(root, nb.dir ?? NOTEBOOKS_DIR, nb.file);
    if (!existsSync(file)) throw new Error(`Missing notebook ${file}.`);
    notebooks[nb.key] = readJson(file);
  }
  const modelFile = join(root, MODEL_TEMPLATE);
  const paxModelFile = join(root, PAX_MODEL_TEMPLATE);
  const paxScripts = PAX_SCRIPTS.map((s) => join(root, PAX_SCRIPTS_DIR, s));
  const appDist = join(root, APP_DIST);
  return {
    dir: root,
    notebooks,
    pipeline: readJson(pipelineFile),
    modelFile: existsSync(modelFile) ? modelFile : undefined,
    ...(existsSync(paxModelFile) ? { paxModelFile } : {}),
    ...(paxScripts.every((s) => existsSync(s)) ? { paxScripts } : {}),
    ...(existsSync(join(appDist, 'index.html')) ? { appDist } : {}),
  };
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}
