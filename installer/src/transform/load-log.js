// @ts-check
/**
 * How the loads went, as a model table: the pipeline's dbo.load_log in the ValueLens model, which
 * says why a page is empty. Before the first load it's there but empty, so queries against it
 * never fail.
 */
import { addTable, cols, valueLensExpression } from './resource-graph.js';

export const LOAD_LOG_TABLE = 'Load Log';

/** Written by Record_Load_Status, one row per load per pipeline run. */
export const LOAD_LOG = {
  name: LOAD_LOG_TABLE,
  source: 'load_log',
  description: 'One row per load per pipeline run: whether it succeeded, loaded with a warning, failed or was skipped, and why, in plain words.',
  columns: cols(`run_id activity source activity_type status reason_kind reason attempts:count
    started_at:datetime ended_at:datetime logged_at:datetime error_code`),
};

/**
 * @param {import('./model.js').ModelBim['model']} model
 * @param {typeof LOAD_LOG} t
 */
function add(model, t) {
  if (model.tables.some((x) => x.name === t.name)) return;
  if (!model.expressions?.some((e) => e.name === 'FabricTable')) throw new Error('The model template has no "FabricTable" function.');
  addTable(model, t, valueLensExpression(t, true), 'From the Lakehouse.');
}

/** @param {import('./model.js').ModelBim['model']} model */
export const addLoadLog = (model) => add(model, LOAD_LOG);
