// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPipeline, findActivity, firstRunParameters } from '../src/transform/pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(
  readFileSync(join(here, '..', '..', 'pipelines', 'CopilotAdoptionPipeline.DataPipeline', 'pipeline-content.json'), 'utf8'),
);

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
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false } });
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
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, agent365: true, productFeedback: true, consumption: false, agentEvaluator: false } });
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
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: false, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false } });
  assert.deepEqual(names(doc), ['Run_Audit_Log_Ingester', 'Run_Licensed_Users_Ingester', 'Run_Audit_Log_Processor']);
  assert.equal(doc.properties.parameters.EnableOrgDataPull, undefined);
});

test('IDs are substituted everywhere and the template is untouched', () => {
  const before = JSON.stringify(template);
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, agent365: true, productFeedback: true, consumption: false, agentEvaluator: false } });
  assert.equal(JSON.stringify(template), before);
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /REPLACE_WITH_/);
  assert.equal(findActivity(doc.properties.activities, 'Run_Audit_Log_Ingester').typeProperties.notebookId, ids.auditIngester);
  assert.equal(findActivity(doc.properties.activities, 'Run_Org_Data_Ingester').typeProperties.workspaceId, WS);
});

test('a missing notebook ID for an enabled module is an error', () => {
  const { agent365Lander, ...rest } = ids;
  assert.throws(
    () => buildPipeline(template, { workspaceId: WS, notebookIds: rest, modules: { orgData: true, agent365: true, productFeedback: false, consumption: false, agentEvaluator: false } }),
    /REPLACE_WITH_AGENT365_LANDER_NOTEBOOK_ID/,
  );
});

test('audit and processor notebooks take their mode from pipeline parameters', () => {
  const doc = buildPipeline(template, { workspaceId: WS, notebookIds: ids, modules: { orgData: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false }, backfillDays: 90 });
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
