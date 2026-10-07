// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PIPELINE_TEMPLATE } from '../src/sources.js';
import {
  AGENT_EVALUATOR_REFRESH_ACTIVITY,
  applyRetries,
  buildPipeline,
  chainLanes,
  CONSUMPTION_REFRESH_ACTIVITY,
  findActivity,
  firstRunParameters,
  REFRESH_ACTIVITY,
  RETRY_INTERVAL_SECONDS,
  retryPolicy,
} from '../src/transform/pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(join(here, '..', '..', PIPELINE_TEMPLATE), 'utf8'));

const WS = 'f0000000-0000-0000-0000-000000000000';
const ids = {
  auditIngester: '00000000-0000-0000-0000-00000000000a',
  licensedUsers: '00000000-0000-0000-0000-00000000000b',
  processor: '00000000-0000-0000-0000-00000000000c',
  orgData: '00000000-0000-0000-0000-00000000000d',
  agent365Registry: '00000000-0000-0000-0000-00000000000e',
  agent365Lander: '00000000-0000-0000-0000-00000000000f',
  productFeedback: '00000000-0000-0000-0000-000000000010',
};

/** @param {any} doc */
const names = (doc) => doc.properties.activities.map((/** @type {any} */ a) => a.name);

test('core + org data: archived and unused branches are pruned', () => {
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false } });
  assert.deepEqual(names(doc), ['Run_Audit_Log_Ingester', 'Run_Licensed_Users_Ingester', 'Run_Audit_Log_Processor', 'Conditionally_Run_Org_Data']);
  const processor = findActivity(doc.properties.activities, 'Run_Audit_Log_Processor');
  assert.deepEqual(
    processor.dependsOn.map((/** @type {any} */ d) => d.activity),
    ['Run_Audit_Log_Ingester', 'Run_Licensed_Users_Ingester'],
  );
  assert.deepEqual(Object.keys(doc.properties.parameters).sort(), ['AuditMode', 'BackfillDays', 'EnableOrgDataPull', 'ProcessorWriteMode']);
  assert.equal(doc.properties.parameters.EnableOrgDataPull.defaultValue, true);
});

test('all modules: branches kept, switches on, fallback dependency kept', () => {
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, m365Activity: false, agent365: true, productFeedback: true, consumption: false, agentEvaluator: false } });
  assert.ok(names(doc).includes('Conditionally_Run_Agent365'));
  assert.ok(names(doc).includes('Run_Agent365_CSV_Fallback'));
  assert.ok(names(doc).includes('Conditionally_Run_Product_Feedback'));
  assert.ok(!names(doc).includes('Conditionally_Run_Dataverse_Transcripts'));
  assert.ok(!names(doc).includes('Conditionally_Run_Credit_Consumption'));
  assert.equal(doc.properties.parameters.EnableAgent365.defaultValue, true);
  assert.equal(doc.properties.parameters.EnableProductFeedback.defaultValue, true);
  assert.equal(doc.properties.parameters.EnableDataverse, undefined);
  const processor = findActivity(doc.properties.activities, 'Run_Audit_Log_Processor');
  assert.ok(processor.dependsOn.some((/** @type {any} */ d) => d.activity === 'Run_Agent365_CSV_Fallback'));
  assert.equal(findActivity(doc.properties.activities, 'Run_Agent365_Registry_Ingester').typeProperties.notebookId, ids.agent365Registry);
});

test('core only: org data branch removed too', () => {
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: false, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false } });
  assert.deepEqual(names(doc), ['Run_Audit_Log_Ingester', 'Run_Licensed_Users_Ingester', 'Run_Audit_Log_Processor']);
  assert.equal(doc.properties.parameters.EnableOrgDataPull, undefined);
});

test('IDs are substituted everywhere and the template is untouched', () => {
  const before = JSON.stringify(template);
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, m365Activity: false, agent365: true, productFeedback: true, consumption: false, agentEvaluator: false } });
  assert.equal(JSON.stringify(template), before);
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /REPLACE_WITH_/);
  assert.equal(findActivity(doc.properties.activities, 'Run_Audit_Log_Ingester').typeProperties.notebookId, ids.auditIngester);
  assert.equal(findActivity(doc.properties.activities, 'Run_Org_Data_Ingester').typeProperties.workspaceId, WS);
});

test('a missing notebook ID for an enabled module is an error', () => {
  const { agent365Lander, ...rest } = ids;
  assert.throws(
    () => buildPipeline(template, { workspaceId: WS, notebookIds: rest, modules: { orgData: true, m365Activity: false, agent365: true, productFeedback: false, consumption: false, agentEvaluator: false } }),
    /REPLACE_WITH_AGENT365_LANDER_NOTEBOOK_ID/,
  );
});

test('audit and processor notebooks take their mode from pipeline parameters', () => {
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, m365Activity: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false }, backfillDays: 90 });
  const audit = findActivity(doc.properties.activities, 'Run_Audit_Log_Ingester');
  assert.equal(audit.typeProperties.parameters.MODE.value.value, '@pipeline().parameters.AuditMode');
  assert.equal(audit.typeProperties.parameters.BACKFILL_DAYS.value.value, '@pipeline().parameters.BackfillDays');
  const processor = findActivity(doc.properties.activities, 'Run_Audit_Log_Processor');
  assert.equal(processor.typeProperties.parameters.WRITE_MODE.value.value, '@pipeline().parameters.ProcessorWriteMode');
  assert.equal(doc.properties.parameters.AuditMode.defaultValue, 'incremental');
  assert.equal(doc.properties.parameters.ProcessorWriteMode.defaultValue, 'merge');
  assert.equal(doc.properties.parameters.BackfillDays.defaultValue, 90);
});

test('first run backfills and rebuilds', () => {
  assert.deepEqual(firstRunParameters(30), { AuditMode: 'backfill', BackfillDays: 30, ProcessorWriteMode: 'overwrite' });
});

const allModules = { orgData: true, m365Activity: true, agent365: true, productFeedback: true, consumption: true, agentEvaluator: true };
const allIds = {
  ...ids,
  m365Activity: '00000000-0000-0000-0000-000000000011',
  refreshModel: '00000000-0000-0000-0000-000000000012',
  azureAi: '00000000-0000-0000-0000-000000000013',
  studioConsumption: '00000000-0000-0000-0000-000000000014',
  vivaConsumption: '00000000-0000-0000-0000-000000000015',
  agentTranscripts: '00000000-0000-0000-0000-000000000016',
};
const everything = () =>
  buildPipeline(template, {
    workspaceId: WS,
    notebookIds: allIds,
    modules: allModules,
    semanticModelId: 'model-1',
    azureAi: true,
    consumptionModelId: 'cc-1',
    agentTranscripts: true,
    agentEvaluatorModelId: 'ae-1',
  });

/** Each top-level activity's dependencies, as "activity:conditions". @param {any} doc @returns {Record<string, string[]>} */
const deps = (doc) =>
  Object.fromEntries(
    doc.properties.activities.map((/** @type {any} */ a) => [a.name, a.dependsOn.map((/** @type {any} */ d) => `${d.activity}:${d.dependencyConditions.join('|')}`)]),
  );

test('lanes: the audit log loads in lane 1 while the other loads run one after another in lane 2', () => {
  const doc = everything();
  assert.deepEqual(deps(doc), {
    Run_Audit_Log_Ingester: [],
    Run_Licensed_Users_Ingester: [],
    Run_Audit_Log_Processor: ['Run_Audit_Log_Ingester:Succeeded', 'Run_Licensed_Users_Ingester:Succeeded', 'Run_Agent365_CSV_Fallback:Succeeded|Skipped'],
    Conditionally_Run_Agent365: ['Run_Licensed_Users_Ingester:Completed'],
    Run_Agent365_CSV_Fallback: ['Conditionally_Run_Agent365:Failed'],
    Conditionally_Run_Org_Data: ['Run_Agent365_CSV_Fallback:Completed|Skipped'],
    Conditionally_Run_M365_Activity: ['Conditionally_Run_Org_Data:Completed'],
    Conditionally_Run_Product_Feedback: ['Conditionally_Run_M365_Activity:Completed'],
    Run_Consumption_Azure_AI: ['Conditionally_Run_Product_Feedback:Completed'],
    Run_Consumption_Studio: ['Run_Consumption_Azure_AI:Completed'],
    Run_Consumption_Viva: ['Run_Consumption_Studio:Completed'],
    Run_Agent_Evaluator_Transcripts: [`${CONSUMPTION_REFRESH_ACTIVITY}:Completed|Skipped`],
    [REFRESH_ACTIVITY]: [
      'Run_Audit_Log_Processor:Succeeded',
      'Conditionally_Run_Org_Data:Completed',
      'Conditionally_Run_M365_Activity:Completed',
      'Conditionally_Run_Product_Feedback:Completed',
    ],
    [CONSUMPTION_REFRESH_ACTIVITY]: ['Run_Consumption_Azure_AI:Succeeded', 'Run_Consumption_Studio:Succeeded', 'Run_Consumption_Viva:Succeeded', 'Conditionally_Run_Org_Data:Completed'],
    [AGENT_EVALUATOR_REFRESH_ACTIVITY]: ['Run_Agent_Evaluator_Transcripts:Succeeded', 'Conditionally_Run_Org_Data:Completed'],
  });
  assert.match(doc.properties.description, /two lanes/);
  assert.match(doc.properties.description, /retries up to 3 times, 5 minutes apart/);
});

test('lanes: a load that is switched off is skipped over', () => {
  /** @param {Partial<typeof allModules>} on */
  const build = (on) => deps(buildPipeline(template, { workspaceId: WS, notebookIds: allIds, modules: { ...allModules, consumption: false, agentEvaluator: false, ...on } }));

  const noAgents = build({ agent365: false });
  assert.deepEqual(noAgents.Conditionally_Run_Org_Data, ['Run_Licensed_Users_Ingester:Completed']);
  assert.deepEqual(noAgents.Run_Audit_Log_Processor, ['Run_Audit_Log_Ingester:Succeeded', 'Run_Licensed_Users_Ingester:Succeeded']);

  assert.deepEqual(build({ orgData: false }).Conditionally_Run_M365_Activity, ['Run_Agent365_CSV_Fallback:Completed|Skipped']);
  assert.deepEqual(build({ orgData: false, m365Activity: false, agent365: false }).Conditionally_Run_Product_Feedback, ['Run_Licensed_Users_Ingester:Completed']);
  assert.deepEqual(build({ orgData: false, m365Activity: false, agent365: false, productFeedback: false }), {
    Run_Audit_Log_Ingester: [],
    Run_Licensed_Users_Ingester: [],
    Run_Audit_Log_Processor: ['Run_Audit_Log_Ingester:Succeeded', 'Run_Licensed_Users_Ingester:Succeeded'],
  });
});

/**
 * Three top-level activities none of which waits, even indirectly, for another, so all three could run at once.
 * @param {any} doc
 * @returns {string[] | undefined}
 */
function threeAtOnce(doc) {
  /** @type {Map<string, string[]>} */
  const parents = new Map(doc.properties.activities.map((/** @type {any} */ a) => [a.name, a.dependsOn.map((/** @type {any} */ d) => d.activity)]));
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  /** @param {string} name @returns {Set<string>} */
  const upstream = (name) => {
    if (!seen.has(name)) seen.set(name, new Set((parents.get(name) ?? []).flatMap((p) => [p, ...upstream(p)])));
    return /** @type {Set<string>} */ (seen.get(name));
  };
  const apart = (/** @type {string} */ a, /** @type {string} */ b) => !upstream(a).has(b) && !upstream(b).has(a);
  const names = [...parents.keys()];
  for (const [i, a] of names.entries()) {
    for (const [j, b] of names.entries()) {
      if (j <= i || !apart(a, b)) continue;
      const c = names.slice(j + 1).find((n) => apart(a, n) && apart(b, n));
      if (c) return [a, b, c];
    }
  }
  return undefined;
}

test('lanes: no more than two notebooks run at once, whichever modules are on', () => {
  const keys = Object.keys(allModules);
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const modules = /** @type {typeof allModules} */ (Object.fromEntries(keys.map((k, i) => [k, !!(mask & (1 << i))])));
    for (const models of [true, false]) {
      const doc = buildPipeline(template, {
        workspaceId: WS,
        notebookIds: allIds,
        modules,
        azureAi: true,
        agentTranscripts: true,
        ...(models ? { semanticModelId: 'model-1', consumptionModelId: 'cc-1', agentEvaluatorModelId: 'ae-1' } : {}),
      });
      assert.equal(threeAtOnce(doc), undefined, JSON.stringify({ modules, models }));
    }
  }
  assert.equal(threeAtOnce(template), undefined, 'the Manual setup template');
});

test('retries: every load retries 5 minutes apart; the Agent 365 load and the refreshes keep their own', () => {
  const doc = everything();
  const policy = (/** @type {string} */ name) => {
    const { retry, retryIntervalInSeconds } = findActivity(doc.properties.activities, name).policy;
    return `${retry}/${retryIntervalInSeconds}`;
  };
  assert.equal(policy('Run_Audit_Log_Ingester'), '2/300');
  assert.equal(policy('Run_Licensed_Users_Ingester'), '3/300');
  assert.equal(policy('Run_Org_Data_Ingester'), '3/300', 'inside its IfCondition');
  assert.equal(policy('Run_M365_Activity_Ingester'), '2/300');
  assert.equal(policy('Run_ProductFeedback_Ingester'), '3/300');
  assert.equal(policy('Run_Agent365_CSV_Fallback'), '3/300');
  assert.equal(policy('Run_Agent365_Registry_Ingester'), '1/60', 'its fallback covers a failure');
  assert.equal(policy('Run_Consumption_Azure_AI'), '2/300');
  assert.equal(policy('Run_Consumption_Viva'), '3/300');
  assert.equal(policy('Run_Agent_Evaluator_Transcripts'), '2/300');
  for (const name of [REFRESH_ACTIVITY, CONSUMPTION_REFRESH_ACTIVITY, AGENT_EVALUATOR_REFRESH_ACTIVITY]) assert.equal(policy(name), '0/60', name);
  assert.equal(findActivity(doc.properties.activities, 'Run_Audit_Log_Ingester').policy.timeout, '0.02:00:00', 'the timeout is kept');
});

test('retryPolicy: a load that can run for an hour or more retries twice, a shorter one three times', () => {
  const retries = (/** @type {string | undefined} */ timeout) => retryPolicy(timeout).retry;
  assert.equal(retries('0.00:15:00'), 3);
  assert.equal(retries('0.00:59:59'), 3);
  assert.equal(retries('00:30:00'), 3);
  assert.equal(retries('0.01:00:00'), 2);
  assert.equal(retries('1.00:00:00'), 2);
  assert.equal(retries(undefined), 2, 'an unknown timeout counts as long');
  assert.equal(retryPolicy('0.00:15:00').retryIntervalInSeconds, RETRY_INTERVAL_SECONDS);
});

test('the Manual setup template is already in lanes, with the retries the installer applies', () => {
  const activities = structuredClone(template.properties.activities);
  applyRetries(activities);
  chainLanes(activities);
  assert.deepEqual(activities, template.properties.activities);
  assert.match(template.properties.description, /two lanes/);
});
