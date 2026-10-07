// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NOTEBOOKS, NOTEBOOKS_DIR } from '../src/catalog.js';
import {
  cellText,
  DATA_CHECK_FILE,
  findAssignmentCell,
  prepareNotebook,
  pyString,
  serialiseNotebook,
  setAssignment,
  toSourceLines,
} from '../src/transform/notebook.js';

const here = dirname(fileURLToPath(import.meta.url));
/** @param {string} file @param {string} [dir]  Folder under `1. Fabric`. */
const load = (file, dir = NOTEBOOKS_DIR) => JSON.parse(readFileSync(join(here, '..', '..', dir, file), 'utf8'));

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = { vaultUri: 'https://vl-kv-test.vault.azure.net/', secretName: 'valuelens-client-secret' };
const LAKEHOUSE = { id: '99999999-0000-0000-0000-000000000001', name: 'ValueLens', workspaceId: '88888888-0000-0000-0000-000000000002' };

test('setAssignment keeps the comment column', () => {
  const src = "TENANT_ID     = '<your-tenant-guid>'                  # Entra -> Overview\nOTHER = 1\n";
  const out = setAssignment(src, 'TENANT_ID', pyString(TENANT));
  const line = out.split('\n')[0];
  assert.equal(line, `TENANT_ID     = '${TENANT}'  # Entra -> Overview`);
  assert.ok(out.endsWith('OTHER = 1\n'));
});

test('setAssignment pads to the original comment column when the value is shorter', () => {
  const out = setAssignment("MODE          = 'incremental'   # load mode\n", 'MODE', "'x'");
  assert.equal(out, "MODE          = 'x'             # load mode\n");
});

test('setAssignment ignores commented-out lines and replaces a comment when asked', () => {
  const src = "# CLIENT_SECRET = getSecret('a', 'b')\nCLIENT_SECRET = '<value>'  # old\n";
  const out = setAssignment(src, 'CLIENT_SECRET', 'secret()', { comment: 'new', before: 'import x' });
  assert.equal(out, "# CLIENT_SECRET = getSecret('a', 'b')\nimport x\nCLIENT_SECRET = secret()  # new\n");
});

test('setAssignment handles values without comments and fails loudly when missing', () => {
  assert.equal(setAssignment('BACKFILL_DAYS = 180\n', 'BACKFILL_DAYS', '30'), 'BACKFILL_DAYS = 30\n');
  assert.throws(() => setAssignment('X = 1', 'TENANT_ID', "'t'"), /TENANT_ID/);
});

test('pyString escapes quotes and backslashes', () => {
  assert.equal(pyString("a'b\\c"), "'a\\'b\\\\c'");
});

test('toSourceLines matches Jupyter line storage', () => {
  assert.deepEqual(toSourceLines('a\nb\n'), ['a\n', 'b\n']);
  assert.deepEqual(toSourceLines('a\nb'), ['a\n', 'b']);
  assert.deepEqual(toSourceLines(''), []);
});

for (const info of NOTEBOOKS.filter((n) => n.credentials)) {
  test(`${info.file}: credentials come from Key Vault`, () => {
    const source = load(info.file, info.dir);
    const before = JSON.stringify(source);
    const nb = prepareNotebook(source, { tenantId: TENANT, clientId: CLIENT, secret: SECRET, lakehouse: LAKEHOUSE });
    assert.equal(JSON.stringify(source), before, 'source notebook must not change');

    const all = nb.cells.map(cellText).join('\n');
    assert.match(all, new RegExp(`^TENANT_ID\\s*=\\s*'${TENANT}'`, 'm'));
    assert.match(all, new RegExp(`^CLIENT_ID\\s*=\\s*'${CLIENT}'`, 'm'));
    assert.match(
      all,
      /^import notebookutils\nCLIENT_SECRET\s*=\s*notebookutils\.credentials\.getSecret\('https:\/\/vl-kv-test\.vault\.azure\.net\/', 'valuelens-client-secret'\)/m,
    );
    assert.doesNotMatch(all, /^CLIENT_SECRET\s*=\s*'/m, 'no literal secret left');
    assert.doesNotMatch(all, /^(TENANT_ID|CLIENT_ID)\s*=\s*'</m, 'no placeholder left');
    assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, LAKEHOUSE.id);
    assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse_workspace_id, LAKEHOUSE.workspaceId);
  });
}

for (const info of NOTEBOOKS.filter((n) => n.parameters.length)) {
  test(`${info.file}: one cell is tagged parameters`, () => {
    const nb = prepareNotebook(load(info.file, info.dir), { parameters: info.parameters });
    const tagged = nb.cells.filter((cell) => cell.metadata?.tags?.includes('parameters'));
    assert.equal(tagged.length, 1);
    for (const p of info.parameters) assert.match(cellText(tagged[0]), new RegExp(`^${p}\\s*=`, 'm'));
  });
}

test('every notebook in the catalogue exists and parses', () => {
  for (const info of NOTEBOOKS) {
    const nb = load(info.file, info.dir);
    assert.ok(Array.isArray(nb.cells) && nb.cells.length > 0, info.file);
  }
});

test('notebooks without credentials have none to fill in', () => {
  for (const info of NOTEBOOKS.filter((n) => !n.credentials)) {
    assert.equal(findAssignmentCell(load(info.file, info.dir), 'CLIENT_SECRET'), -1, info.file);
  }
});

test('data check gets a summary cell that saves JSON to the Lakehouse', () => {
  const nb = prepareNotebook(load('ValueLens_Data_Check.ipynb'), { dataCheckSummary: true, lakehouse: LAKEHOUSE });
  const last = cellText(nb.cells[nb.cells.length - 1]);
  assert.ok(last.includes(`'/lakehouse/default/${DATA_CHECK_FILE}'`));
  assert.match(last, /notebookutils\.notebook\.exit\(_json\.dumps\(_summary\)\)/);
  assert.ok(last.includes("_summary['identity'] = globals().get('overlap_summary')"));
  assert.ok(last.includes("_summary['auditExcluded'] = globals().get('audit_excluded')"));
  assert.ok(last.includes("_tables['m365'] = _resolve('m365_activity_daily')"));
  assert.match(last, /_pick\(_df, \['ActivityDate'\]\)/);
  const earlier = nb.cells.slice(0, -1).map(cellText).join('\n');
  for (const name of ['def _resolve', 'def _pick', 'DATE_NAMES', 'resolved =', 'overlap_summary = {', 'audit_excluded = None']) assert.ok(earlier.includes(name), name);
});

test('serialiseNotebook round-trips', () => {
  const nb = prepareNotebook(load('Copilot_Org_Data_Direct_Ingester.ipynb'), { tenantId: TENANT, clientId: CLIENT, secret: SECRET });
  assert.deepEqual(JSON.parse(serialiseNotebook(nb)), nb);
});

test('credentials must be given together', () => {
  assert.throws(() => prepareNotebook(load('Copilot_Org_Data_Direct_Ingester.ipynb'), { tenantId: TENANT }), /together/);
});

const consumption = (/** @type {string} */ key) => /** @type {import('../src/catalog.js').NotebookInfo} */ (NOTEBOOKS.find((n) => n.key === key));

test('Viva consumption: reads the Dataflow table and CSVs, and ends quietly with neither', () => {
  const info = consumption('vivaConsumption');
  assert.equal(info.patches, undefined);
  const nb = prepareNotebook(load(info.file, info.dir), { lakehouse: LAKEHOUSE });
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, /DATAFLOW_TABLE = "viva_credits_dataflow"/);
  assert.match(all, /spark\.catalog\.tableExists\(DATAFLOW_TABLE\)/);
  assert.match(all, /if not notebookutils\.fs\.exists\(LANDING\):\n\s+return \[\]/);
  assert.match(all, /notebookutils\.notebook\.exit\(f'No Viva consumption in \{LANDING\} or \{DATAFLOW_TABLE\}/);
  assert.match(all, /pol_files = landed\('spendingpolicymetadata'\)\nif pol_files:/);
  assert.doesNotMatch(all, /raise ValueError\(f'No PersonServiceCreditsMetrics/);
  assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, LAKEHOUSE.id);
});

test('Studio consumption: licensing API files fill studio_agent_daily and never replace an export', () => {
  const info = consumption('studioConsumption');
  const nb = prepareNotebook(load(info.file, info.dir), { lakehouse: LAKEHOUSE });
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, /PAT_API_AGENT = \("StudioApiAgentDaily\*\.csv",\)/);
  assert.match(all, /PAT_API_ENTITLEMENT = \("StudioApiEntitlement\*\.csv",\)/);
  assert.match(all, /TBL_AGENT_DAILY = "studio_agent_daily"/);
  assert.match(all, /api_raw = read\(\*PAT_API_AGENT, api=True\)\nif api_raw is None:\n\s+print\("no licensing API files - skipping"\)/);
  // Environment names come from the entitlement snapshot when the resources call has none.
  assert.match(all, /rows\.join\(names, "environment_id", "left"\)/);
  // Months and days an export covers keep the export's figures.
  assert.match(all, /an export covers this month, so the API figures aren't used/);
  assert.match(all, /tenant_api\.join\(exported, \["usage_date", "environment_id"\], "left_anti"\)/);
  assert.match(all, /no entitlement snapshot - treating every credit as prepaid/);
});

test('a patch that no longer matches exactly once is an error', () => {
  const info = consumption('vivaConsumption');
  assert.throws(() => prepareNotebook(load(info.file, info.dir), { patches: [{ find: 'no such text', replace: '' }] }), /found it 0 times/);
  assert.throws(() => prepareNotebook(load(info.file, info.dir), { patches: [{ find: 'LANDING', replace: '' }] }), /LANDING/);
});

test('Azure AI: the subscription, app and Key Vault secret are filled in', () => {
  const info = consumption('azureAi');
  const nb = prepareNotebook(load(info.file, info.dir), {
    values: { SUBSCRIPTION_ID: TENANT, TENANT_ID: TENANT, CLIENT_ID: CLIENT, KEY_VAULT_URL: SECRET.vaultUri, CLIENT_SECRET_NAME: SECRET.secretName },
  });
  const all = nb.cells.map(cellText).join('\n');
  assert.match(all, new RegExp(`^SUBSCRIPTION_ID = '${TENANT}'`, 'm'));
  assert.match(all, new RegExp(`^CLIENT_ID = '${CLIENT}'`, 'm'));
  assert.match(all, /^KEY_VAULT_URL = 'https:\/\/vl-kv-test\.vault\.azure\.net\/'/m);
  assert.match(all, /^CLIENT_SECRET_NAME = 'valuelens-client-secret'/m);
  assert.match(all, /notebookutils\.credentials\.getSecret\(KEY_VAULT_URL, CLIENT_SECRET_NAME\)/);
});
