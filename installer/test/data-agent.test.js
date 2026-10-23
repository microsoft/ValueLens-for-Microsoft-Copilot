// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyConfig } from '../src/config.js';
import { fabricConfigFile } from '../src/steps/app.js';
import {
  agentSources,
  blockedDataAgentSettings,
  dataAgentUrl,
  dataAgentWanted,
  deployDataAgent,
  ensureDataAgent,
  planDataAgent,
  runsDataAgent,
} from '../src/steps/data-agent.js';
import { planReview, reserveNames } from '../src/steps/plan.js';
import {
  agentInstructions,
  dataAgentDefinition,
  dataAgentSignature,
  dataSourceInstructions,
  daxReferences,
  DESCRIPTION_LIMIT,
  elementId,
  fit,
  INSTRUCTIONS_LIMIT,
  loadAsk,
  schemaElements,
  sourceFolder,
  visibleSchema,
} from '../src/transform/data-agent.js';
import { buildModel, loadTemplateModel } from '../src/transform/model.js';
import { fakeCtx, fakeFabric, fakeUi, httpError, realSources } from './fakes.js';

const ask = /** @type {import('../src/transform/data-agent.js').Ask} */ (realSources().ask);

/** @param {any} def @param {string} path */
const partJson = (def, path) => {
  const p = def.parts.find((/** @type {any} */ x) => x.path === path);
  assert.ok(p, `${path} is in the definition`);
  return JSON.parse(Buffer.from(p.payload, 'base64').toString('utf8'));
};

/** @param {{ answers?: any[], config?: any }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const ui = fakeUi({ answers: o.answers });
  const config = o.config ?? emptyConfig();
  config.semanticModel.enabled = true;
  config.semanticModel.server = 'endpoint.datawarehouse.fabric.microsoft.com';
  config.semanticModel.database = 'ValueLens';
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, config });
  const model = fabric.add('SemanticModel', 'Analytics Hub Model', null);
  config.semanticModel.id = model.id;
  return { ...made, fabric, ui, model };
}

test('the checkout ships the Ask catalogue, with every query it names', () => {
  assert.ok(ask, 'loadSources reads the catalogue');
  assert.ok(ask.catalogue.tools.length > 10);
  for (const t of ask.catalogue.tools) assert.match(ask.queries[t.name], /EVALUATE/i, t.name);
  assert.equal(loadAsk('C:\\nowhere-at-all'), undefined, 'a source folder without the catalogue has no Ask');
});

test('daxReferences: bare names are measures, table-qualified ones columns; comments and strings are ignored', () => {
  const refs = daxReferences(`
    // [Commented]
    /* 'Gone'[Away] */
    EVALUATE SUMMARIZECOLUMNS('Chat + Agent Org Data'[Organization], Calendar[Date], "Label [x]", [Active Users], "n", [Active Users])
  `);
  assert.deepEqual(refs.measures, ['Active Users']);
  assert.deepEqual(refs.columns, [
    { table: 'Chat + Agent Org Data', column: 'Organization' },
    { table: 'Calendar', column: 'Date' },
  ]);
  assert.deepEqual(daxReferences("EVALUATE ROW(\"a\", 'It''s'[Col])").columns, [{ table: "It's", column: 'Col' }]);
});

test('visibleSchema leaves out hidden tables, columns, measures and row numbers', () => {
  const schema = visibleSchema({
    model: {
      tables: [
        { name: 'Hidden', isHidden: true, columns: [{ name: 'A' }] },
        {
          name: 'Facts',
          description: ['Line one', 'line two'],
          columns: [{ name: 'RowNumber-1', type: 'rowNumber' }, { name: 'Key', isHidden: true }, { name: 'Date', dataType: 'dateTime' }],
          measures: [{ name: 'Total', description: 'All of it' }, { name: 'Helper', isHidden: true }],
        },
        { name: 'Empty', columns: [{ name: 'X', isHidden: true }] },
      ],
    },
  });
  assert.deepEqual(schema, [
    {
      name: 'Facts',
      description: 'Line one\nline two',
      columns: [{ name: 'Date', dataType: 'dateTime', description: undefined }],
      measures: [{ name: 'Total', description: 'All of it' }],
    },
  ]);
});

test('elementId is a stable, version-5-shaped UUID per path', () => {
  const id = elementId(['Model', 'Table']);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, elementId(['Model', 'Table']));
  assert.notEqual(id, elementId(['Model', 'Table', 'Column']));
});

test('schemaElements: tables with their columns and measures as children, all selected', () => {
  const els = schemaElements('M', [{ name: 'T', columns: [{ name: 'C', dataType: 'string' }], measures: [{ name: 'X', description: 'd' }] }]);
  assert.equal(els.length, 1);
  assert.equal(els[0].type, 'semantic_model.table');
  assert.equal(els[0].is_selected, true);
  assert.deepEqual(
    els[0].children.map((c) => [c.type, c.display_name]),
    [
      ['semantic_model.column', 'C'],
      ['semantic_model.measure', 'X'],
    ],
  );
  assert.equal(/** @type {any} */ (els[0].children[0]).data_type, 'string');
  assert.equal(els[0].children[1].description, 'd');
});

test('fit cuts at the last whole line within the limit', () => {
  assert.equal(fit('abc', 10), 'abc');
  assert.equal(fit('one\ntwo\nthree', 9), 'one\ntwo');
});

test('agentInstructions carry the guardrails and every suggested question, within Fabric\'s limit', () => {
  const s = agentInstructions(ask.catalogue, ['Analytics Hub Model']);
  assert.ok(s.length <= INSTRUCTIONS_LIMIT, `${s.length} characters`);
  assert.match(s, /must come from a query/);
  assert.match(s, new RegExp(`fewer than ${ask.catalogue.minPeople} people`));
  assert.match(s, /comparisons, never as causes/);
  assert.match(s, /Don\u2019t forecast/);
  assert.match(s, /no data, say so/);
  for (const q of ask.catalogue.pages.flatMap((p) => p.questions)) assert.ok(s.includes(q), q);
});

test('the main model\'s instructions name only measures and columns the deployed model has', () => {
  const bim = buildModel(loadTemplateModel(/** @type {string} */ (realSources().modelFile)), {
    server: 's',
    database: 'd',
    modules: emptyConfig().modules,
    resourceGraph: false,
  });
  const schema = visibleSchema(bim);
  const measures = new Set(schema.flatMap((t) => t.measures.map((m) => m.name)));
  const s = dataSourceInstructions(ask, 'vl', schema);
  assert.ok(s.length <= INSTRUCTIONS_LIMIT, `${s.length} characters`);
  assert.match(s, /'Calendar'\[Date\]/);
  const named = [...s.matchAll(/Measures: ([^\n]*?)\.(?: Columns| People|$)/gm)].flatMap((m) => [...m[1].matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]));
  assert.ok(named.length > 5, 'the main model\'s queries use its measures');
  for (const m of named) assert.ok(measures.has(m), `[${m}] is a measure of the model`);
  for (const t of ask.catalogue.tools.filter((x) => x.model === 'vl')) assert.ok(s.includes(`- ${t.name}: `), t.name);
});

test('dataAgentDefinition: the agent config, its instructions and one data source per model', () => {
  const t = setup();
  const sources = agentSources(t.ctx);
  assert.deepEqual(sources.map((s) => s.alias), ['vl']);
  const def = dataAgentDefinition(ask, 'ws-1', sources);
  assert.deepEqual(
    def.parts.map((p) => p.path),
    ['Files/Config/data_agent.json', 'Files/Config/draft/stage_config.json', 'Files/Config/draft/semantic_model-Analytics Hub Model/datasource.json'],
  );
  assert.ok(def.parts.every((p) => p.payloadType === 'InlineBase64'));
  assert.equal(partJson(def, 'Files/Config/data_agent.json').$schema, '2.1.0');
  assert.match(partJson(def, 'Files/Config/draft/stage_config.json').aiInstructions, /Analytics Hub Ask/);
  const ds = partJson(def, `Files/Config/draft/${sourceFolder('Analytics Hub Model')}/datasource.json`);
  assert.equal(ds.type, 'semantic_model');
  assert.equal(ds.artifactId, t.model.id);
  assert.equal(ds.workspaceId, 'ws-1');
  assert.ok(ds.userDescription.length <= DESCRIPTION_LIMIT);
  assert.ok(ds.elements.some((/** @type {any} */ e) => e.display_name === 'Calendar'));

  assert.equal(dataAgentSignature(def), dataAgentSignature(dataAgentDefinition(ask, 'ws-1', agentSources(t.ctx))), 'the same models give the same signature');
  assert.notEqual(dataAgentSignature(def), dataAgentSignature(dataAgentDefinition(ask, 'ws-2', sources)));
  assert.equal(sourceFolder('a/b:c'), 'semantic_model-a_b_c');
});

test('agentSources adds the consumption and Agent Evaluator models once they are deployed', () => {
  const t = setup();
  t.config.modules.consumption = true;
  t.config.modules.agentEvaluator = true;
  t.config.agentEvaluator.environments = [{ url: 'https://org.crm.dynamics.com', access: true }];
  assert.deepEqual(agentSources(t.ctx).map((s) => s.alias), ['vl']);
  t.config.consumption.model.id = 'cc-1';
  t.config.agentEvaluator.model.id = 'ae-1';
  assert.deepEqual(agentSources(t.ctx).map((s) => [s.alias, s.id]), [
    ['vl', t.model.id],
    ['cc', 'cc-1'],
    ['ae', 'ae-1'],
  ]);
});

test('runsDataAgent: paid F and P capacities, not trials or embedded', () => {
  for (const sku of ['F2', 'F64', 'P1', 'f8']) assert.equal(runsDataAgent({ sku }), true, sku);
  for (const sku of ['FT1', 'A1', 'EM1', 'PP3', undefined]) assert.equal(runsDataAgent({ sku }), false, String(sku));
});

test('dataAgentWanted: Fabric installs with the model and the catalogue, unless switched off or on a trial', () => {
  const t = setup();
  assert.equal(dataAgentWanted(t.ctx), true, 'on by default');
  t.config.dataAgent.capacityOk = false;
  assert.equal(dataAgentWanted(t.ctx), false);
  t.config.dataAgent.capacityOk = true;
  t.config.dataAgent.enabled = false;
  assert.equal(dataAgentWanted(t.ctx), false);
  t.config.dataAgent.enabled = undefined;
  t.config.semanticModel.enabled = false;
  assert.equal(dataAgentWanted(t.ctx), false);
  t.config.semanticModel.enabled = true;
  t.config.target = 'azure';
  assert.equal(dataAgentWanted(t.ctx), false);
  t.config.target = 'fabric';
  t.ctx.sources = { ...t.ctx.sources, ask: undefined };
  assert.equal(dataAgentWanted(t.ctx), false);
});

test('planDataAgent: a trial capacity skips it with a note; advanced mode asks; off tenant settings warn', async () => {
  const pre = /** @type {any} */ ({ capacities: [], subscriptions: [], roles: [], canConsent: true, canCreateApps: true });
  const trial = setup();
  await planDataAgent(trial.ctx, pre, { sku: 'FT1', displayName: 'Trial' }, false);
  assert.equal(trial.config.dataAgent.capacityOk, false);
  assert.match(trial.ui.text(), /paid Fabric capacity/);

  const asked = setup({ answers: [false] });
  await planDataAgent(asked.ctx, pre, { sku: 'F64' }, true);
  assert.equal(asked.config.dataAgent.capacityOk, true);
  assert.equal(asked.config.dataAgent.enabled, false);
  assert.equal(dataAgentWanted(asked.ctx), false);

  const warned = setup();
  const settings = {
    A: { settingName: 'A', title: 'Users can create and share Data agent item types (preview)', enabled: false },
    B: { settingName: 'B', title: 'Users can use Copilot and other features powered by Azure OpenAI', enabled: true },
    C: { settingName: 'C', title: 'Data sent to Azure OpenAI can be processed outside your capacity\'s geographic region', enabled: false, delegateToCapacity: true },
  };
  assert.deepEqual(blockedDataAgentSettings(settings).map((s) => s.label), ['Users can create and share data agent items']);
  await planDataAgent(warned.ctx, { ...pre, tenantSettings: settings }, { sku: 'F2' }, false);
  assert.equal(warned.config.dataAgent.enabled, undefined, 'the default is left unset');
  assert.match(warned.ui.text(), /data agent items/);
});

test('deployDataAgent creates and publishes it, then leaves it alone until something changes', async () => {
  const t = setup();
  await deployDataAgent(t.ctx);
  const da = t.config.dataAgent;
  assert.ok(da.id);
  assert.equal(da.name, 'Analytics Hub Ask');
  assert.ok(da.signature);
  assert.equal(da.publishedSignature, da.signature);
  assert.deepEqual(t.fabric.calls.filter((c) => /DataAgent/.test(c)), ['createDataAgent Analytics Hub Ask', 'publishDataAgent Analytics Hub Ask']);

  t.fabric.calls.length = 0;
  await deployDataAgent(t.ctx);
  assert.deepEqual(t.fabric.calls.filter((c) => /DataAgent/.test(c)), []);
  assert.match(t.ui.text(), /is in place/);

  t.config.consumption.model.id = 'cc-1';
  t.config.modules.consumption = true;
  await deployDataAgent(t.ctx);
  assert.deepEqual(t.fabric.calls.filter((c) => /DataAgent/.test(c)), ['updateDataAgent Analytics Hub Ask', 'publishDataAgent Analytics Hub Ask']);
});

test('deployDataAgent creates it again when it was deleted, and never takes over an item it didn\'t create', async () => {
  const t = setup();
  t.fabric.add('DataAgent', 'Analytics Hub Ask', null);
  t.config.dataAgent.id = 'gone';
  t.config.dataAgent.publishedSignature = 'old';
  await deployDataAgent(t.ctx);
  assert.match(t.ui.text(), /was deleted/);
  assert.equal(t.config.dataAgent.name, 'Analytics Hub Ask 2');
  assert.notEqual(t.config.dataAgent.id, 'gone');
  assert.equal(t.config.dataAgent.publishedSignature, t.config.dataAgent.signature);
});

test('deployDataAgent publishes again when only the publish failed last time', async () => {
  const t = setup();
  t.fabric.failures.publishDataAgent = [httpError(403, 'Forbidden')];
  await ensureDataAgent(t.ctx);
  assert.ok(t.config.dataAgent.id, 'the agent is kept');
  assert.equal(t.config.dataAgent.publishedSignature, undefined);
  t.fabric.calls.length = 0;
  await ensureDataAgent(t.ctx);
  assert.deepEqual(t.fabric.calls.filter((c) => /DataAgent/.test(c)), ['publishDataAgent Analytics Hub Ask']);
});

test('ensureDataAgent: a failure is reported and the install carries on; nothing happens when it isn\'t wanted', async () => {
  const t = setup();
  t.fabric.failures.createDataAgent = [httpError(400, 'Data agents are not enabled for this tenant')];
  assert.equal(await ensureDataAgent(t.ctx), false);
  assert.match(t.ui.text(), /wasn't set up: .*not enabled/);
  assert.match(t.ui.text(), /update/);
  assert.equal(t.config.dataAgent.id, undefined);

  const off = setup();
  off.config.dataAgent.enabled = false;
  assert.equal(await ensureDataAgent(off.ctx), true);
  assert.deepEqual(off.fabric.calls.filter((c) => /DataAgent/.test(c)), []);

  const noModel = setup();
  delete noModel.config.semanticModel.id;
  await deployDataAgent(noModel.ctx);
  assert.match(noModel.ui.text(), /isn't deployed/);
});

test('the plan reserves a free name and lists the data agent', async () => {
  const t = setup();
  t.fabric.add('DataAgent', 'Analytics Hub Ask', null);
  await reserveNames(t.ctx);
  assert.equal(t.config.dataAgent.name, 'Analytics Hub Ask 2');
  const review = planReview(t.ctx);
  const item = review.creates.find((c) => c.kind === 'Data agent');
  assert.ok(item);
  assert.equal(item.name, 'Analytics Hub Ask 2');
  assert.equal(item.isNew, true);

  t.config.dataAgent.capacityOk = false;
  assert.ok(!planReview(t.ctx).creates.some((c) => c.kind === 'Data agent'));
});

test('the app\'s fabric.config.json points the Ask page at the data agent', () => {
  const config = emptyConfig();
  config.semanticModel.id = 'sm-1';
  assert.equal(fabricConfigFile(config, 'ws-1', ['vl']).ask, undefined);
  config.dataAgent.id = 'da-1';
  assert.deepEqual(fabricConfigFile(config, 'ws-1', ['vl']).ask, { workspaceId: 'ws-1', itemId: 'da-1' });
  config.dataAgent.capacityOk = false;
  assert.equal(fabricConfigFile(config, 'ws-1', ['vl']).ask, undefined);
  assert.equal(dataAgentUrl('w', 'i'), 'https://app.fabric.microsoft.com/groups/w/dataagents/i');
});
