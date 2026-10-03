// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { notebooksFor } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { modelDeployed, notebookSettings, pipelineSignature } from '../src/steps/fabric.js';
import { prepareNotebook } from '../src/transform/notebook.js';
import { AUDIT_TABLE, buildModel, datasourcePath, decodeText, loadTemplateModel, mParameter, mString, readTemplateModel, setMParameter } from '../src/transform/model.js';
import { buildPipeline, findActivity, REFRESH_ACTIVITY } from '../src/transform/pipeline.js';
import { listZip, readZipEntry } from '../src/transform/zip.js';
import { fakeCtx, realSources } from './fakes.js';

/**
 * A minimal zip with one stored and one deflated entry per file.
 * @param {Record<string, { data: Buffer, deflate?: boolean }>} files
 */
function makeZip(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const [name, { data, deflate }] of Object.entries(files)) {
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

const MODEL_FILE = /** @type {string} */ (realSources().modelFile);
const template = loadTemplateModel(MODEL_FILE);
const settings = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'ValueLens', modules: { orgData: true, agent365: false, productFeedback: true, consumption: false, agentEvaluator: false } };

test('zip: stored and deflated entries read back; a missing entry or non-zip fails', () => {
  const text = Buffer.from('hello '.repeat(200));
  const zip = makeZip({ 'a.txt': { data: Buffer.from('plain') }, 'b/c.json': { data: text, deflate: true } });
  assert.deepEqual([...listZip(zip).keys()], ['a.txt', 'b/c.json']);
  assert.equal(readZipEntry(zip, 'a.txt').toString(), 'plain');
  assert.equal(readZipEntry(zip, 'b/c.json').toString(), text.toString());
  assert.throws(() => readZipEntry(zip, 'nope'), /has no nope/);
  assert.throws(() => listZip(Buffer.alloc(40)), /Not a zip file/);
});

test('decodeText handles UTF-16 and UTF-8, with or without a byte-order mark', () => {
  const s = '{"model":"é"}';
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])), s);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])), s);
  assert.equal(decodeText(Buffer.from(s, 'utf16le')), s);
  assert.equal(decodeText(Buffer.from(s, 'utf8')), s);
});

test('readTemplateModel takes the model from DataModelSchema and drops its name', () => {
  const schema = { name: 'abc-123', compatibilityLevel: 1600, model: { tables: [{ name: 'T' }] } };
  const pbit = makeZip({ DataModelSchema: { data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(schema), 'utf16le')]), deflate: true } });
  const bim = readTemplateModel(pbit);
  assert.deepEqual(bim, { compatibilityLevel: 1600, model: { tables: [{ name: 'T' }] } });
  assert.throws(() => readTemplateModel(makeZip({ DataModelSchema: { data: Buffer.from('{"model":{}}') } })), /no data model/);
});

test('the real template: source parameters filled, optional pages switched, template untouched', () => {
  const before = JSON.stringify(template);
  const bim = buildModel(template, settings);
  assert.equal(JSON.stringify(template), before);
  assert.equal(mParameter(bim.model, 'Fabric SQL Endpoint'), settings.server);
  assert.equal(mParameter(bim.model, 'Lakehouse Name'), 'ValueLens');
  assert.equal(mParameter(bim.model, 'Enable_ProductFeedback'), 'Include');
  assert.equal(mParameter(bim.model, 'Enable_Agent365'), 'Exclude');
  const endpoint = bim.model.expressions?.find((e) => e.name === 'Fabric SQL Endpoint');
  assert.match(String(endpoint?.expression), /^"abc\.datawarehouse\.fabric\.microsoft\.com" meta \[IsParameterQuery=true/);
  assert.equal(/** @type {any} */ (bim).name, undefined);
  assert.ok(bim.compatibilityLevel >= 1600);
  assert.ok(bim.model.tables.find((t) => t.name === AUDIT_TABLE)?.refreshPolicy, 'the audit table keeps its incremental refresh policy');
});

test('M parameters: quotes are escaped; a missing or non-parameter query fails', () => {
  assert.equal(mString('a "b"'), '"a ""b"""');
  const model = { tables: [], expressions: [{ name: 'P', expression: 'null meta [IsParameterQuery=true]' }, { name: 'Q', expression: 'let x = 1 in x' }] };
  setMParameter(model, 'P', 'say "hi"');
  assert.equal(mParameter(model, 'P'), 'say "hi"');
  assert.throws(() => setMParameter(model, 'Missing', 'x'), /no "Missing" parameter/);
  assert.throws(() => setMParameter(model, 'Q', 'x'), /not a parameter/);
  assert.equal(datasourcePath('s.example', 'db'), 's.example;db');
});

const WS = 'f0000000-0000-0000-0000-000000000000';
const pipelineTemplate = realSources().pipeline;
const ids = {
  auditIngester: 'nb-a',
  licensedUsers: 'nb-b',
  processor: 'nb-c',
  orgData: 'nb-d',
  productFeedback: 'nb-e',
  refreshModel: 'nb-r',
};

test('pipeline: with a model, the refresh runs last, after the processor and the optional loads', () => {
  const doc = buildPipeline(pipelineTemplate, { workspaceId: WS, notebookIds: ids, modules: settings.modules, semanticModelId: 'model-1' });
  const acts = doc.properties.activities;
  assert.equal(acts.at(-1).name, REFRESH_ACTIVITY);
  const refresh = findActivity(acts, REFRESH_ACTIVITY);
  assert.deepEqual(refresh.dependsOn, [
    { activity: 'Run_Audit_Log_Processor', dependencyConditions: ['Succeeded'] },
    { activity: 'Conditionally_Run_Org_Data', dependencyConditions: ['Completed'] },
    { activity: 'Conditionally_Run_Product_Feedback', dependencyConditions: ['Completed'] },
  ]);
  assert.equal(refresh.typeProperties.notebookId, 'nb-r');
  assert.equal(refresh.typeProperties.parameters.SEMANTIC_MODEL_ID.value, 'model-1');
  assert.equal(refresh.typeProperties.parameters.WORKSPACE_ID.value, WS);
  assert.equal(refresh.typeProperties.parameters.WRITE_MODE.value.value, '@pipeline().parameters.ProcessorWriteMode');
  assert.match(doc.properties.description, /then refreshes the semantic model/);
});

test('pipeline: no model, no refresh; a model without the notebook is an error', () => {
  const doc = buildPipeline(pipelineTemplate, { workspaceId: WS, notebookIds: ids, modules: settings.modules });
  assert.equal(findActivity(doc.properties.activities, REFRESH_ACTIVITY), undefined);
  assert.doesNotMatch(doc.properties.description, /semantic model/);
  const { refreshModel, ...rest } = ids;
  assert.throws(() => buildPipeline(pipelineTemplate, { workspaceId: WS, notebookIds: rest, modules: settings.modules, semanticModelId: 'm' }), /refresh notebook/);
});

test('the refresh notebook is deployed only with a connected model, with its IDs filled in', () => {
  const modules = { orgData: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false };
  assert.ok(!notebooksFor(modules).some((nb) => nb.key === 'refreshModel'));
  const nb = notebooksFor(modules, { semanticModel: true }).find((n) => n.key === 'refreshModel');
  assert.ok(nb);

  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-9' });
  assert.equal(modelDeployed(config), false, 'not connected yet');
  const unbound = pipelineSignature(config);
  config.semanticModel.bound = true;
  assert.equal(modelDeployed(config), true);
  assert.notEqual(pipelineSignature(config), unbound, 'connecting the model changes the pipeline');
  assert.match(pipelineSignature(config), /;model=model-9$/);

  const { ctx } = fakeCtx({ config });
  const text = JSON.stringify(prepareNotebook(realSources().notebooks.refreshModel, notebookSettings(ctx, nb)));
  assert.match(text, /WORKSPACE_ID = 'ws-1'/);
  assert.match(text, /SEMANTIC_MODEL_ID = 'model-9'/);
});

test('the refresh notebook reloads the audit table in full after a rebuild', () => {
  const nb = JSON.parse(readFileSync(new URL('../../notebooks/ValueLens_Refresh_Model.ipynb', import.meta.url), 'utf8'));
  const code = nb.cells.map((/** @type {any} */ c) => [].concat(c.source).join('')).join('\n');
  assert.match(code, /applyRefreshPolicy/);
  assert.match(code, /overwrite/);
  assert.match(code, /notebookutils/);
});
