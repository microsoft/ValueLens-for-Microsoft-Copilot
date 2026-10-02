// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NOTEBOOKS } from '../src/catalog.js';
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
const notebooksDir = join(here, '..', '..', 'notebooks');
/** @param {string} file */
const load = (file) => JSON.parse(readFileSync(join(notebooksDir, file), 'utf8'));

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
    const source = load(info.file);
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
    const nb = prepareNotebook(load(info.file), { parameters: info.parameters });
    const tagged = nb.cells.filter((cell) => cell.metadata?.tags?.includes('parameters'));
    assert.equal(tagged.length, 1);
    for (const p of info.parameters) assert.match(cellText(tagged[0]), new RegExp(`^${p}\\s*=`, 'm'));
  });
}

test('every notebook in the catalogue exists and parses', () => {
  for (const info of NOTEBOOKS) {
    const nb = load(info.file);
    assert.ok(Array.isArray(nb.cells) && nb.cells.length > 0, info.file);
  }
});

test('notebooks without credentials have none to fill in', () => {
  for (const info of NOTEBOOKS.filter((n) => !n.credentials)) {
    assert.equal(findAssignmentCell(load(info.file), 'CLIENT_SECRET'), -1, info.file);
  }
});

test('data check gets a summary cell that saves JSON to the Lakehouse', () => {
  const nb = prepareNotebook(load('ValueLens_Data_Check.ipynb'), { dataCheckSummary: true, lakehouse: LAKEHOUSE });
  const last = cellText(nb.cells[nb.cells.length - 1]);
  assert.ok(last.includes(`'/lakehouse/default/${DATA_CHECK_FILE}'`));
  assert.match(last, /notebookutils\.notebook\.exit\(_json\.dumps\(_summary\)\)/);
  const earlier = nb.cells.slice(0, -1).map(cellText).join('\n');
  for (const name of ['def _resolve', 'def _pick', 'DATE_NAMES', 'resolved =']) assert.ok(earlier.includes(name), name);
});

test('serialiseNotebook round-trips', () => {
  const nb = prepareNotebook(load('Copilot_Org_Data_Direct_Ingester.ipynb'), { tenantId: TENANT, clientId: CLIENT, secret: SECRET });
  assert.deepEqual(JSON.parse(serialiseNotebook(nb)), nb);
});

test('credentials must be given together', () => {
  assert.throws(() => prepareNotebook(load('Copilot_Org_Data_Direct_Ingester.ipynb'), { tenantId: TENANT }), /together/);
});
