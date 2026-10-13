// @ts-check
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultModules, NOTEBOOKS_DIR, notebooksFor } from '../src/catalog.js';
import { LOAD_LABELS, statusConfigJson } from '../src/loads.js';
import { notebookOptions, notebookSettings, pipelineSettings, pipelineSignature } from '../src/steps/fabric.js';
import { rlsOn } from '../src/transform/access.js';
import { prepareNotebook } from '../src/transform/notebook.js';
import { ACCESS_ACTIVITY, buildPipeline, findActivity, REFRESH_ACTIVITY, WORKDAY_ACTIVITY } from '../src/transform/pipeline.js';
import { defaultDataSources } from '../src/uploads.js';
import { fakeCtx, realSources } from './fakes.js';

/** @param {import('../src/config.js').InstallConfig} config @param {boolean} enabled */
const setRls = (config, enabled) => {
  config.access = /** @type {any} */ ({ ...(config.access ?? {}), grantedModels: [], rls: { enabled, applied: {} } });
  return config;
};

const ids = { auditIngester: 'nb-a', licensedUsers: 'nb-b', processor: 'nb-c', orgData: 'nb-d', m365Activity: 'nb-m', refreshModel: 'nb-r', workdayLander: 'nb-w', accessScope: 'nb-acc' };
const modules = { orgData: true, m365Activity: true, agent365: false, productFeedback: false, consumption: false, agentEvaluator: false };

test('access notebook: deployed only with org-scoped access on, and it ships', () => {
  const ds = defaultDataSources();
  assert.ok(!notebooksFor(defaultModules(), { dataSources: ds }).some((n) => n.key === 'accessScope'));
  const nb = notebooksFor(defaultModules(), { dataSources: ds, access: true }).find((n) => n.key === 'accessScope');
  assert.equal(nb?.file, 'AnalyticsHub_Access_Scope.ipynb');
  assert.equal(nb?.credentials, false);
  assert.ok(existsSync(join(import.meta.dirname, '..', '..', NOTEBOOKS_DIR, nb.file)));

  const { config } = fakeCtx();
  assert.equal(rlsOn(config), false, 'off unless turned on');
  assert.equal(notebookOptions(config).access, false);
  assert.equal(notebookOptions(setRls(config, true)).access, true);
});

test('access notebook: the pipeline loads tables only; the installer passes roles when it applies membership', () => {
  const { ctx, config } = fakeCtx();
  setRls(config, true);
  config.fabric.workspaceId = 'ws-1';
  config.fabric.lakehouseId = 'lh-1';
  config.fabric.lakehouseName = 'Lake';
  const nb = /** @type {import('../src/catalog.js').NotebookInfo} */ (notebooksFor(config.modules, notebookOptions(config)).find((n) => n.key === 'accessScope'));
  const settings = notebookSettings(ctx, nb);
  assert.deepEqual(settings.values, { WORKSPACE_ID: 'ws-1', MODE: 'all', ROLES_B64: '', ROLES_FILE: '' });
  assert.equal(settings.tenantId, undefined, 'no app credentials');

  const prepared = prepareNotebook(realSources().notebooks.accessScope, settings);
  const cells = prepared.cells.filter((/** @type {any} */ c) => c.metadata?.tags?.includes('parameters'));
  assert.equal(cells.length, 1, 'one parameters cell');
  const text = /** @type {string[]} */ ([]).concat(cells[0].source).join('');
  assert.match(text, /^MODE += 'all'/m);
  assert.match(text, /^ROLES_B64 += ''/m);
  assert.match(text, /^ROLES_FILE += ''/m);
  assert.match(text, /^WORKSPACE_ID += 'ws-1'/m);
});

test('pipeline: the access step runs after org data and before the model refresh, only when on', () => {
  const sources = realSources();
  const base = { workspaceId: 'ws', notebookIds: ids, modules, semanticModelId: 'model-1' };
  const without = buildPipeline(sources.pipeline, base);
  assert.equal(findActivity(without.properties.activities, ACCESS_ACTIVITY), undefined);

  const doc = buildPipeline(sources.pipeline, { ...base, access: true });
  const step = findActivity(doc.properties.activities, ACCESS_ACTIVITY);
  assert.equal(step.typeProperties.notebookId, 'nb-acc');
  assert.deepEqual(step.dependsOn, [{ activity: 'Conditionally_Run_Org_Data', dependencyConditions: ['Completed'] }]);
  assert.deepEqual(findActivity(doc.properties.activities, 'Conditionally_Run_M365_Activity').dependsOn, [{ activity: ACCESS_ACTIVITY, dependencyConditions: ['Completed'] }]);
  assert.ok(findActivity(doc.properties.activities, REFRESH_ACTIVITY).dependsOn.some((/** @type {any} */ d) => d.activity === ACCESS_ACTIVITY));

  const workday = buildPipeline(sources.pipeline, { ...base, access: true, workday: true });
  assert.deepEqual(findActivity(workday.properties.activities, ACCESS_ACTIVITY).dependsOn, [{ activity: WORKDAY_ACTIVITY, dependencyConditions: ['Completed'] }], 'after the Workday enrichment');

  assert.throws(() => buildPipeline(sources.pipeline, { ...base, notebookIds: { ...ids, accessScope: undefined }, access: true }), /Access Scope notebook/);
  assert.match(LOAD_LABELS[ACCESS_ACTIVITY], /org-scoped access/);
  assert.ok(statusConfigJson().includes(ACCESS_ACTIVITY));
});

test('pipeline: turning org-scoped access on or off changes the signature, so the pipeline is redeployed', () => {
  const { config } = fakeCtx();
  const off = pipelineSignature(config);
  assert.ok(!off.includes('access'));
  setRls(config, true);
  assert.equal(pipelineSignature(config), `${off};access`);
  assert.equal(pipelineSettings(config).access, true);
  setRls(config, false);
  assert.equal(pipelineSignature(config), off);
});
