// @ts-check
/** Loads the notebooks, pipeline template and report template from a ValueLens checkout. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTEBOOKS, NOTEBOOKS_DIR, SETUP_DIR } from './catalog.js';
import { MODEL_TEMPLATE } from './transform/model.js';

/** The source folder: the repo root when the installer runs from a checkout, `f` in the exe. */
export const DEFAULT_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PIPELINE_TEMPLATE = join(SETUP_DIR, 'pipelines', 'CopilotAdoptionPipeline.DataPipeline', 'pipeline-content.json');

/**
 * @typedef {object} Sources
 * @property {string} dir
 * @property {Record<import('./catalog.js').NotebookKey, import('./transform/notebook.js').Notebook>} notebooks
 * @property {any} pipeline
 * @property {string} [modelFile]  `ValueLens - Fabric.pbit`, read only when the semantic model is deployed.
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
  return {
    dir: root,
    notebooks,
    pipeline: readJson(pipelineFile),
    modelFile: existsSync(modelFile) ? modelFile : undefined,
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
