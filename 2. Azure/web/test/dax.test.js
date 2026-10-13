import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyDaxFilters, dateBetween, daxString, treatAs, DATE_COLUMN, ORG_COLUMN } from '../src/dax.js';

const squash = (text) => text.replace(/\s+/g, ' ').trim();
const filter = `TREATAS({"HR"}, 'Org'[Organization])`;

test('applyDaxFilters wraps EVALUATE bodies as the app does', () => {
  assert.equal(applyDaxFilters('EVALUATE ROW("A", 1)', []), 'EVALUATE ROW("A", 1)');
  assert.equal(squash(applyDaxFilters('EVALUATE ROW("A", [Users])', [filter])), squash(`EVALUATE CALCULATETABLE( ROW("A", [Users]) , ${filter} )`));
  const query = ['DEFINE', "    MEASURE 'T'[M] = CALCULATE([Users], 'T'[Flag] = \"EVALUATE\")", 'EVALUATE', "SUMMARIZECOLUMNS('T'[Week], \"M\", [M])", "ORDER BY 'T'[Week]"].join('\n');
  const result = applyDaxFilters(query, [filter]);
  assert.ok(result.startsWith(query.slice(0, query.indexOf('EVALUATE\n'))));
  assert.ok(squash(result).includes(squash(`EVALUATE CALCULATETABLE( SUMMARIZECOLUMNS('T'[Week], "M", [M]) , ${filter} ) ORDER BY 'T'[Week]`)));
  assert.equal(applyDaxFilters('EVALUATE ROW("A", 1)\nEVALUATE ROW("B", 2)\nORDER BY [B]', [filter]).match(/CALCULATETABLE\(/g).length, 2);
  const tricky = ['// EVALUATE in a line comment', '/* EVALUATE */', 'EVALUATE', 'FILTER(', "    ADDCOLUMNS(VALUES('Order By'[Evaluate]), \"Label\", \"ORDER BY \"\"q\"\"\"),", '    [Start At] > 0 // trailing comment', ')'].join('\n');
  const wrapped = applyDaxFilters(tricky, [filter]);
  assert.equal(wrapped.match(/CALCULATETABLE\(/g).length, 1);
  assert.match(wrapped, /trailing comment\n\)\n,\n {4}TREATAS/);
  assert.equal(squash(applyDaxFilters('evaluate ROW("A", 1) order by [A]', ['F'])), squash('evaluate CALCULATETABLE( ROW("A", 1) , F ) order by [A]'));
});

test('filter expressions match the app', async () => {
  assert.equal(daxString('Say "hi"'), '"Say ""hi"""');
  assert.equal(treatAs("'T'[C]", ['A', 'B']), `TREATAS({"A", "B"}, 'T'[C])`);
  assert.equal(treatAs("'T'[N]", [50]), "TREATAS({50}, 'T'[N])");
  assert.equal(dateBetween("'Calendar'[Date]", '2026-05-08', '2026-07-06'), "FILTER(ALL('Calendar'[Date]), 'Calendar'[Date] >= DATE(2026, 5, 8) && 'Calendar'[Date] <= DATE(2026, 7, 6))");
  const filters = await readFile(new URL('../../../1. Fabric/Fabric App/src/lib/filters.ts', import.meta.url), 'utf8');
  const org = await readFile(new URL('../../../1. Fabric/Fabric App/src/lib/org-attribute.ts', import.meta.url), 'utf8');
  assert.ok(filters.includes(`date: "${DATE_COLUMN}"`), 'the date filter column');
  assert.ok(org.includes('ORG_TABLE = "Chat + Agent Org Data"') && org.includes('DEFAULT_ORG_ATTRIBUTE = "Organization"') && ORG_COLUMN === "'Chat + Agent Org Data'[Organization]", 'the org filter column');
});
