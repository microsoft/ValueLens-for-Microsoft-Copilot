// @ts-check
/** Loads the notebooks and pipeline template from a ValueLens checkout. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTEBOOKS, NOTEBOOKS_DIR, SETUP_DIR } from './catalog.js';
import { AGENT_EVALUATOR_TEMPLATE, CONSUMPTION_TEMPLATE, MODEL_TEMPLATE } from './transform/model.js';

/** `1. Fabric`, when the installer runs from inside the repo. */
export const DEFAULT_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PIPELINE_TEMPLATE = join(SETUP_DIR, 'pipelines', 'CopilotAdoptionPipeline.DataPipeline', 'pipeline-content.json');
/** The ValueLens web app, inside `1. Fabric`. */
export const APP_DIR = 'Fabric App';

/**
 * @typedef {object} Sources
 * @property {string} dir
 * @property {Record<import('./catalog.js').NotebookKey, import('./transform/notebook.js').Notebook>} notebooks
 * @property {any} pipeline
 * @property {string} [modelFile]  `ValueLens - Fabric.pbit`, read only when the semantic model is deployed.
 * @property {string} [consumptionModelFile]  `Consumption Central - Fabric.pbit`, for the credit consumption model.
 * @property {string} [agentEvaluatorModelFile]  `Agent Evaluator.pbit`, for the Agent Evaluator model.
 * @property {string} [appDir]  The web app's source, when this checkout has it.
 */

/**
 * @param {string} [dir]  The `1. Fabric` folder of a ValueLens checkout.
 * @returns {Sources}
 */
export function loadSources(dir = DEFAULT_SOURCE_DIR) {
  const root = resolve(dir);
  const pipelineFile = join(root, PIPELINE_TEMPLATE);
  if (!existsSync(pipelineFile)) {
    throw new Error(`No pipeline template at ${pipelineFile}. Point --source at the "1. Fabric" folder of the repo.`);
  }
  /** @type {any} */
  const notebooks = {};
  for (const nb of NOTEBOOKS) {
    const file = join(root, nb.dir ?? NOTEBOOKS_DIR, nb.file);
    if (!existsSync(file)) throw new Error(`Missing notebook ${file}.`);
    notebooks[nb.key] = readJson(file);
  }
  const modelFile = join(root, MODEL_TEMPLATE);
  const consumptionModelFile = join(root, CONSUMPTION_TEMPLATE);
  const agentEvaluatorModelFile = join(root, AGENT_EVALUATOR_TEMPLATE);
  const appDir = resolve(root, APP_DIR);
  return {
    dir: root,
    notebooks,
    pipeline: readJson(pipelineFile),
    modelFile: existsSync(modelFile) ? modelFile : undefined,
    consumptionModelFile: existsSync(consumptionModelFile) ? consumptionModelFile : undefined,
    agentEvaluatorModelFile: existsSync(agentEvaluatorModelFile) ? agentEvaluatorModelFile : undefined,
    appDir: existsSync(join(appDir, 'rayfin', 'rayfin.yml')) ? appDir : undefined,
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
