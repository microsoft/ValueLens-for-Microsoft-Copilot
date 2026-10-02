// @ts-check
/** Loads the notebooks and pipeline template from a ValueLens checkout. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTEBOOKS } from './catalog.js';

/** `3. Fabric`, when the installer runs from inside the repo. */
export const DEFAULT_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PIPELINE_TEMPLATE = join('pipelines', 'CopilotAdoptionPipeline.DataPipeline', 'pipeline-content.json');

/**
 * @typedef {object} Sources
 * @property {string} dir
 * @property {Record<import('./catalog.js').NotebookKey, import('./transform/notebook.js').Notebook>} notebooks
 * @property {any} pipeline
 */

/**
 * @param {string} [dir]  The `3. Fabric` folder of a ValueLens checkout.
 * @returns {Sources}
 */
export function loadSources(dir = DEFAULT_SOURCE_DIR) {
  const root = resolve(dir);
  const pipelineFile = join(root, PIPELINE_TEMPLATE);
  if (!existsSync(pipelineFile)) {
    throw new Error(`No ValueLens pipeline template at ${pipelineFile}. Point --source at the "3. Fabric" folder of the repo.`);
  }
  /** @type {any} */
  const notebooks = {};
  for (const nb of NOTEBOOKS) {
    const file = join(root, 'notebooks', nb.file);
    if (!existsSync(file)) throw new Error(`Missing notebook ${file}.`);
    notebooks[nb.key] = readJson(file);
  }
  return { dir: root, notebooks, pipeline: readJson(pipelineFile) };
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}
