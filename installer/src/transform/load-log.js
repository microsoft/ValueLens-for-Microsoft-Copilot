// @ts-check
/**
 * How the loads went, as model tables: the pipeline's dbo.load_log in the ValueLens model, and
 * which Dataverse environments the transcript parser read in the Agent Evaluator model. The app
 * reads them to say why a page is empty. Before the first load, or on a target without the table,
 * they're there but empty, so queries against them never fail.
 */
import { addTable, cols, valueLensExpression } from './resource-graph.js';

export const LOAD_LOG_TABLE = 'Load Log';
export const EVALUATOR_STATUS_TABLE = 'Evaluator Status';

/** Written by Record_Load_Status, one row per load per pipeline run. */
export const LOAD_LOG = {
  name: LOAD_LOG_TABLE,
  source: 'load_log',
  description: 'One row per load per pipeline run: whether it succeeded, loaded with a warning, failed or was skipped, and why, in plain words.',
  columns: cols(`run_id activity source activity_type status reason_kind reason attempts:count
    started_at:datetime ended_at:datetime logged_at:datetime error_code`),
};

/** Written by Copilot_Agent_Transcript_Parser. Each run replaces the last. */
export const EVALUATOR_STATUS = {
  name: EVALUATOR_STATUS_TABLE,
  source: 'evaluator_status',
  description: 'One row per Dataverse environment the transcript parser read on its last run: how many days back, and how many transcripts it found.',
  columns: cols('RunAt:datetime Environment EnvironmentUrl LookbackDays:count Transcripts:count Status Reason'),
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

/** @param {import('./model.js').ModelBim['model']} model */
export const addEvaluatorStatus = (model) => add(model, EVALUATOR_STATUS);
