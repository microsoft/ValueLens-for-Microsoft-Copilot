// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { PRODUCT } from '../src/product.js';
import { decodeText, mParameter, readTemplateModel } from '../src/transform/model.js';
import { applyEntry, buildEntryModel, fillTemplate, syncUnapplied } from '../src/transform/template.js';
import { crc32, listZip, readZipEntry, replaceZipEntries } from '../src/transform/zip.js';
import { realSources } from './fakes.js';

/**
 * A zip as Power BI Desktop writes one: CRCs and sizes in the headers, version 20. `streamed`
 * puts them in a data descriptor after each entry's data instead (flag bit 3), as zips written
 * to a stream do.
 * @param {Record<string, { data: Buffer, deflate?: boolean }>} files
 * @param {{ streamed?: boolean, comment?: string }} [o]
 */
function zipOf(files, o = {}) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  const flags = 0x0800 | (o.streamed ? 0x0008 : 0);
  for (const [name, { data, deflate }] of Object.entries(files)) {
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(0x6c21, 10);
    local.writeUInt16LE(0x5a56, 12);
    if (!o.streamed) {
      local.writeUInt32LE(crc32(data), 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(nameBuf.length, 26);
    /** @type {Buffer[]} */
    const descriptor = [];
    if (o.streamed) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc32(data), 4);
      d.writeUInt32LE(body.length, 8);
      d.writeUInt32LE(data.length, 12);
      descriptor.push(d);
    }
    locals.push(local, nameBuf, body, ...descriptor);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt16LE(0x6c21, 12);
    dir.writeUInt16LE(0x5a56, 14);
    dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + body.length + descriptor.reduce((n, d) => n + d.length, 0);
  }
  const dirBuf = Buffer.concat(central);
  const comment = Buffer.from(o.comment ?? '');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, dirBuf, end, comment]);
}

/**
 * Every entry's local header agrees with its central directory record, has no data descriptor,
 * and its data has the size and CRC the directory says.
 * @param {Buffer} zip
 */
function assertConsistent(zip) {
  for (const e of listZip(zip).values()) {
    const at = e.offset;
    assert.equal(zip.readUInt32LE(at), 0x04034b50, `${e.name}: local header`);
    assert.equal(zip.readUInt16LE(at + 6) & 0x0008, 0, `${e.name}: no data descriptor`);
    assert.equal(zip.readUInt16LE(at + 8), e.method, `${e.name}: method`);
    assert.equal(zip.readUInt32LE(at + 14), e.crc, `${e.name}: CRC`);
    assert.equal(zip.readUInt32LE(at + 18), e.compressedSize, `${e.name}: compressed size`);
    assert.equal(zip.readUInt32LE(at + 22), e.size, `${e.name}: size`);
    const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
    assert.equal(zip.toString('utf8', at + 30, at + 30 + zip.readUInt16LE(at + 26)), e.name);
    const raw = zip.subarray(start, start + e.compressedSize);
    const data = e.method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, e.size, `${e.name}: inflated size`);
    assert.equal(crc32(data), e.crc, `${e.name}: CRC of the data`);
  }
}

test('crc32: the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('zip: a copy with nothing replaced is byte for byte the same', () => {
  const zip = zipOf({ 'a.txt': { data: Buffer.from('plain') }, 'b/c.json': { data: Buffer.from('{"x":1}'.repeat(50)), deflate: true } }, { comment: 'kept' });
  assert.ok(replaceZipEntries(zip, new Map()).equals(zip));
});

test('zip: replacing an entry deflates it and leaves the others and the comment alone', () => {
  const zip = zipOf(
    { 'a.txt': { data: Buffer.from('plain') }, 'b/c.json': { data: Buffer.from('{"x":1}'.repeat(50)), deflate: true }, 'd.bin': { data: Buffer.from([1, 2, 3]) } },
    { comment: 'a zip comment' },
  );
  const next = Buffer.from('replaced '.repeat(40));
  const copy = replaceZipEntries(zip, new Map([['a.txt', next]]));
  assert.deepEqual([...listZip(copy).keys()], ['a.txt', 'b/c.json', 'd.bin']);
  assert.deepEqual(readZipEntry(copy, 'a.txt'), next);
  assert.equal(listZip(copy).get('a.txt')?.method, 8);
  assert.deepEqual(readZipEntry(copy, 'b/c.json'), readZipEntry(zip, 'b/c.json'));
  assert.deepEqual(readZipEntry(copy, 'd.bin'), Buffer.from([1, 2, 3]));
  assert.equal(listZip(copy).get('d.bin')?.method, 0);
  assert.equal(copy.subarray(copy.length - 'a zip comment'.length).toString(), 'a zip comment');
  // The date and time are kept.
  assert.equal(copy.readUInt16LE(10), 0x6c21);
  assertConsistent(copy);
});

test('zip: data descriptors are folded into the headers', () => {
  const zip = zipOf({ 'x.json': { data: Buffer.from('{"streamed":true}'), deflate: true }, 'y.txt': { data: Buffer.from('also') } }, { streamed: true });
  const copy = replaceZipEntries(zip, new Map());
  assert.ok(copy.length < zip.length);
  assert.equal(readZipEntry(copy, 'x.json').toString(), '{"streamed":true}');
  assert.equal(readZipEntry(copy, 'y.txt').toString(), 'also');
  // The UTF-8 name flag stays.
  assert.equal(copy.readUInt16LE(6), 0x0800);
  assertConsistent(copy);
});

test('zip: replacing an entry that is not there fails, and so does a file that is not a zip', () => {
  const zip = zipOf({ 'a.txt': { data: Buffer.from('plain') } });
  assert.throws(() => replaceZipEntries(zip, new Map([['nope', Buffer.from('x')]])), /has no nope/);
  assert.throws(() => replaceZipEntries(Buffer.alloc(40), new Map()), /Not a zip file/);
});

const PAX_TEMPLATE = /** @type {string} */ (realSources().paxModelFile);

test('zip: the SharePoint template copies unchanged, entry for entry', () => {
  const pbit = readFileSync(PAX_TEMPLATE);
  const copy = replaceZipEntries(pbit, new Map());
  const before = listZip(pbit);
  assert.deepEqual([...listZip(copy).keys()], [...before.keys()]);
  for (const name of before.keys()) assert.deepEqual(readZipEntry(copy, name), readZipEntry(pbit, name), name);
  assertConsistent(copy);
});

/** @returns {import('../src/transform/model.js').ModelBim} */
const smallModel = () => ({
  compatibilityLevel: 1567,
  model: {
    tables: [],
    expressions: [
      { name: 'Folder', expression: 'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]' },
      { name: 'Lines', expression: ['let', '    Source = Folder.Files("C:\\x")', 'in', '    Source'] },
      { name: 'One', expression: 'Folder.Files("C:\\x")' },
    ],
  },
});

test('template: parameters are set and keep their meta record; expressions keep their form', () => {
  const model = smallModel().model;
  applyEntry(model, {
    parameters: { Folder: 'https://contoso.sharepoint.com/sites/A/Shared Documents/"x"' },
    expressions: { Lines: 'let\r\n    Source = SharePoint.Files("https://contoso.sharepoint.com/sites/A")\r\nin\r\n    Source', One: 'SharePoint.Files("s")' },
  });
  assert.equal(mParameter(model, 'Folder'), 'https://contoso.sharepoint.com/sites/A/Shared Documents/"x"');
  assert.match(String(model.expressions?.[0].expression), / meta \[IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true\]$/);
  assert.deepEqual(model.expressions?.[1].expression, ['let', '    Source = SharePoint.Files("https://contoso.sharepoint.com/sites/A")', 'in', '    Source']);
  assert.equal(model.expressions?.[2].expression, 'SharePoint.Files("s")');
});

test('template: a parameter or expression the model does not have fails', () => {
  assert.throws(() => applyEntry(smallModel().model, { parameters: { Nope: 'x' } }), /no "Nope" parameter/);
  assert.throws(() => applyEntry(smallModel().model, { parameters: { One: 'x' } }), /"One" is not a parameter/);
  assert.throws(() => applyEntry(smallModel().model, { parameters: {}, expressions: { Nope: 'x' } }), /no "Nope" expression/);
});

test('template: buildEntryModel leaves the template alone', () => {
  const template = smallModel();
  const before = structuredClone(template);
  const built = buildEntryModel(template, { parameters: { Folder: 'f' }, expressions: { One: 'two' } });
  assert.deepEqual(template, before);
  assert.equal(built.compatibilityLevel, 1567);
  assert.equal(mParameter(built.model, 'Folder'), 'f');
  assert.equal(built.model.expressions?.[2].expression, 'two');
});

test('template: fillTemplate sets the SharePoint template parameters and changes nothing else', () => {
  const pbit = readFileSync(PAX_TEMPLATE);
  const values = {
    'Copilot Interactions File': 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/ValueLens/copilot_interactions_rollup.csv',
    'Org Data File': 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/ValueLens/copilot_users_rollup.csv',
    'SharePoint Site URL': 'https://contoso.sharepoint.com/sites/Analytics',
    'Agent 365': '',
    'Feedback File': '',
  };
  const filled = fillTemplate(pbit, { parameters: values });
  const model = readTemplateModel(filled).model;
  for (const [name, value] of Object.entries(values)) assert.equal(mParameter(model, name), value, name);
  assert.equal(mParameter(readTemplateModel(pbit).model, 'SharePoint Site URL'), undefined, 'the original is untouched');

  // DataModelSchema keeps its encoding: the same first bytes, so no byte-order mark is added or lost.
  const [raw, rawFilled] = [readZipEntry(pbit, 'DataModelSchema'), readZipEntry(filled, 'DataModelSchema')];
  assert.deepEqual(rawFilled.subarray(0, 2), raw.subarray(0, 2));
  assert.equal(JSON.parse(decodeText(rawFilled)).model.tables.length, JSON.parse(decodeText(raw)).model.tables.length);

  const before = listZip(pbit);
  assert.deepEqual([...listZip(filled).keys()], [...before.keys()]);
  for (const name of before.keys()) if (name !== 'DataModelSchema') assert.deepEqual(readZipEntry(filled, name), readZipEntry(pbit, name), name);
  assertConsistent(filled);
});

/** UTF-16 with a byte-order mark, as Power BI Desktop writes a template's text parts. @param {string} text */
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const PARAMETER_META = ' meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]';

/**
 * A template with smallModel's model and, unless queries is null, an UnappliedChanges that holds them.
 * @param {any[] | null} queries
 * @param {{ pretty?: boolean, utf8?: boolean }} [o]
 */
function unappliedPbit(queries, o = {}) {
  /** @type {Record<string, { data: Buffer, deflate?: boolean }>} */
  const files = { Version: { data: utf16('1.28') }, DataModelSchema: { data: utf16(JSON.stringify(smallModel(), null, 2)), deflate: true } };
  if (queries) {
    const text = JSON.stringify({ queries, firstLoad: false }, null, o.pretty ? 2 : undefined);
    files.UnappliedChanges = { data: o.utf8 ? Buffer.from(text, 'utf8') : utf16(text), deflate: true };
  }
  return zipOf(files);
}

test("template: fillTemplate brings UnappliedChanges in line with the entry's queries, each in its own form", () => {
  const other = { name: 'Other', text: 'let\n    x = 1\nin\n    x', loadEnabled: true };
  const pbit = unappliedPbit([
    { name: 'Folder', text: `null${PARAMETER_META}`, loadEnabled: false },
    { name: 'Lines', text: ['let', '    Source = Folder.Files("C:\\x")', 'in', '    Source'] },
    { name: 'One', text: 'let\r\n    Source = Folder.Files("C:\\x")\r\nin\r\n    Source' },
    other,
  ]);
  const folder = 'https://contoso.sharepoint.com/sites/A/Shared%20Documents/X';
  const filled = fillTemplate(pbit, {
    parameters: { Folder: folder },
    expressions: { Lines: 'let\r\n    Source = SharePoint.Files("s")\r\nin\r\n    Source', One: 'let\n    Source = SharePoint.Files("s")\nin\n    Source' },
  });
  const raw = readZipEntry(filled, 'UnappliedChanges');
  assert.deepEqual(raw.subarray(0, 2), Buffer.from([0xff, 0xfe]), 'still UTF-16 with its byte-order mark');
  const text = decodeText(raw);
  assert.ok(!text.includes('\n'), 'still on one line');
  const doc = JSON.parse(text);
  assert.deepEqual(doc.queries[0], { name: 'Folder', text: `"${folder}"${PARAMETER_META}`, loadEnabled: false });
  assert.deepEqual(doc.queries[1].text, ['let', '    Source = SharePoint.Files("s")', 'in', '    Source'], 'a list of lines stays one');
  assert.equal(doc.queries[2].text, 'let\r\n    Source = SharePoint.Files("s")\r\nin\r\n    Source', 'the copy keeps its line breaks');
  assert.deepEqual(doc.queries[3], other, "a query the entry doesn't set is untouched");
  assert.equal(doc.firstLoad, false);
  assert.equal(mParameter(readTemplateModel(filled).model, 'Folder'), folder);
  assert.deepEqual(readZipEntry(filled, 'Version'), readZipEntry(pbit, 'Version'));
  assertConsistent(filled);
});

test('template: an UnappliedChanges written over several lines, in UTF-8, stays that way', () => {
  const pbit = unappliedPbit([{ name: 'Folder', text: `null${PARAMETER_META}` }], { pretty: true, utf8: true });
  const raw = readZipEntry(fillTemplate(pbit, { parameters: { Folder: 'f' } }), 'UnappliedChanges');
  assert.equal(raw.toString('utf8'), JSON.stringify({ queries: [{ name: 'Folder', text: `"f"${PARAMETER_META}` }], firstLoad: false }, null, 2));
});

test("template: fillTemplate leaves UnappliedChanges byte for byte alone when there's nothing to change, and adds none", () => {
  const entry = { parameters: { Folder: 'f' } };
  const cases = [
    unappliedPbit([{ name: 'Other', text: 'x' }]),
    unappliedPbit([{ name: 'Folder', text: `"f"${PARAMETER_META}` }], { pretty: true }),
    unappliedPbit([]),
    zipOf({ DataModelSchema: { data: utf16(JSON.stringify(smallModel())) }, UnappliedChanges: { data: Buffer.from('not JSON') } }),
    zipOf({ DataModelSchema: { data: utf16(JSON.stringify(smallModel())) }, UnappliedChanges: { data: Buffer.from('{"tables":[]}') } }),
  ];
  for (const [i, pbit] of cases.entries()) {
    const filled = fillTemplate(pbit, entry);
    assert.equal(mParameter(readTemplateModel(filled).model, 'Folder'), 'f', `case ${i}`);
    assert.deepEqual(readZipEntry(filled, 'UnappliedChanges'), readZipEntry(pbit, 'UnappliedChanges'), `case ${i}`);
  }
  const without = fillTemplate(unappliedPbit(null), entry);
  assert.deepEqual([...listZip(without).keys()], ['Version', 'DataModelSchema']);
});

test("template: syncUnapplied changes only the entry's queries that the model has", () => {
  const model = smallModel().model;
  applyEntry(model, { parameters: { Folder: 'f' } });
  const doc = { queries: [{ name: 'Lines', text: 'old' }, { name: 'Nope', text: 'old' }, { text: 'no name' }, null] };
  const before = structuredClone(doc);
  assert.equal(syncUnapplied(doc, model, { parameters: { Folder: 'f' }, expressions: { Nope: 'x' } }), false);
  assert.deepEqual(doc, before);
  assert.equal(syncUnapplied({ queries: [{ name: 'Folder', text: 'old' }] }, model, { parameters: { Folder: 'f' } }), true);
  for (const bad of [undefined, null, {}, { queries: 'x' }]) assert.equal(syncUnapplied(bad, model, { parameters: { Folder: 'f' } }), false);
});

test("template: the SharePoint template has no UnappliedChanges, so a fill changes only its model", () => {
  assert.ok(!listZip(readFileSync(PAX_TEMPLATE)).has('UnappliedChanges'));
});

/** @param {string} type */
const typedMeta = (type) => ` meta [IsParameterQuery=true, Type="${type}", IsParameterQueryRequired=true]`;

/** Parameters of each type, as Power BI Desktop writes them. @returns {import('../src/transform/model.js').ModelBim} */
const typedModel = () => ({
  compatibilityLevel: 1567,
  model: {
    tables: [],
    expressions: [
      { name: 'Weeks', expression: `4${typedMeta('Number')}` },
      { name: 'Since', expression: `#date(2026, 9, 1)${typedMeta('Date')}` },
      { name: 'On', expression: `true${typedMeta('Logical')}` },
      { name: 'Id', expression: `""${typedMeta('Text')}` },
      { name: 'Anything', expression: `"x"${typedMeta('Any')}` },
      { name: 'Untyped', expression: '"x" meta [IsParameterQuery=true, IsParameterQueryRequired=true]' },
      // A suggested value that mentions a type comes before the parameter's own.
      { name: 'Picked', expression: '"a" meta [IsParameterQuery=true, List={"Type=""Number""", "b"}, DefaultValue="a", Type="Text", IsParameterQueryRequired=true]' },
      { name: 'When', expression: `#datetime(2026, 9, 1, 0, 0, 0)${typedMeta('DateTime')}` },
    ],
  },
});

/**
 * The parameter's value as written, before its meta record.
 * @param {import('../src/transform/model.js').ModelBim['model']} model
 * @param {string} name
 */
const literal = (model, name) => String(model.expressions?.find((e) => e.name === name)?.expression).split(' meta [')[0];

test('template: each parameter is written as the type it declares, and keeps its meta record', () => {
  /** @type {[string, import('../src/transform/template.js').ParameterValue | null, string][]} */
  const cases = [
    ['Weeks', 6, '6'],
    ['Weeks', '8', '8'],
    ['Weeks', ' 2.50 ', '2.5'],
    ['Weeks', '1e3', '1000'],
    ['Weeks', -1.5, '-1.5'],
    ['Weeks', 0.025, '0.025'],
    ['Since', '2026-10-01', '#date(2026, 10, 1)'],
    ['Since', '2028-02-29', '#date(2028, 2, 29)'],
    ['On', false, 'false'],
    ['On', 'true', 'true'],
    ['Id', 'p-1', '"p-1"'],
    ['Id', 'say "hi"', '"say ""hi"""'],
    ['Id', '', '""'],
    ['Id', null, '""'],
    ['Id', 5, '"5"'],
    ['Anything', 5, '"5"'],
    ['Untyped', 'y', '"y"'],
    ['Picked', 'b', '"b"'],
  ];
  for (const [name, value, want] of cases) {
    const model = typedModel().model;
    const before = String(model.expressions?.find((e) => e.name === name)?.expression);
    applyEntry(model, { parameters: { [name]: /** @type {any} */ (value) } });
    const after = String(model.expressions?.find((e) => e.name === name)?.expression);
    assert.equal(literal(model, name), want, `${name} = ${JSON.stringify(value)}`);
    assert.equal(after.slice(after.indexOf(' meta [')), before.slice(before.indexOf(' meta [')), `${name}: the meta record is kept`);
  }
});

test("template: a value that doesn't fit its parameter's type fails, and so does a type the installer can't write", () => {
  /** @type {[string, unknown, string][]} */
  const cases = [
    ['Weeks', 'abc', 'not "abc"'],
    ['Weeks', '', 'not ""'],
    ['Weeks', '1,5', 'not "1,5"'],
    ['Weeks', null, 'not null'],
    ['Weeks', NaN, 'not NaN'],
    ['Weeks', Infinity, 'not Infinity'],
    ['Weeks', true, 'not true'],
  ];
  for (const [name, value, shown] of cases) {
    assert.throws(() => applyEntry(typedModel().model, { parameters: { [name]: /** @type {any} */ (value) } }), {
      message: `"Weeks" is a Number parameter, so its value must be a number, ${shown}.`,
    });
  }
  for (const value of ['2026-02-30', '2026-9-1', '2026-09-01T00:00:00', '01/09/2026', '', 20260901, null]) {
    assert.throws(() => applyEntry(typedModel().model, { parameters: { Since: /** @type {any} */ (value) } }), /^Error: "Since" is a Date parameter, so its value must be a date written yyyy-mm-dd, not /, String(value));
  }
  for (const value of ['yes', 'True', 1, '']) {
    assert.throws(() => applyEntry(typedModel().model, { parameters: { On: /** @type {any} */ (value) } }), /^Error: "On" is a Logical parameter, so its value must be true or false, not /, String(value));
  }
  assert.throws(() => applyEntry(typedModel().model, { parameters: { When: '2026-09-01' } }), { message: `"When" is a DateTime parameter, which the installer can't set.` });
  assert.throws(() => applyEntry(typedModel().model, { parameters: { Nope: 1 } }), { message: 'The model has no "Nope" parameter.' });
});

test("template: fillTemplate writes typed values to the model and to UnappliedChanges' copies", () => {
  const queries = [
    { name: 'Weeks', text: `4${typedMeta('Number')}`, loadEnabled: false },
    { name: 'Since', text: [`#date(2026, 9, 1)${typedMeta('Date')}`] },
    { name: 'Id', text: `""${typedMeta('Text')}` },
  ];
  const pbit = zipOf({
    DataModelSchema: { data: utf16(JSON.stringify(typedModel(), null, 2)), deflate: true },
    UnappliedChanges: { data: utf16(JSON.stringify({ queries, firstLoad: false })), deflate: true },
  });
  const filled = fillTemplate(pbit, { parameters: { Weeks: 6, Since: '2026-10-01', Id: 'p-1' } });
  const model = readTemplateModel(filled).model;
  assert.deepEqual(['Weeks', 'Since', 'Id'].map((name) => literal(model, name)), ['6', '#date(2026, 10, 1)', '"p-1"']);
  const doc = JSON.parse(decodeText(readZipEntry(filled, 'UnappliedChanges')));
  assert.deepEqual(doc.queries, [
    { name: 'Weeks', text: `6${typedMeta('Number')}`, loadEnabled: false },
    { name: 'Since', text: [`#date(2026, 10, 1)${typedMeta('Date')}`] },
    { name: 'Id', text: `"p-1"${typedMeta('Text')}` },
  ]);
  assertConsistent(filled);
});

test('template: every SharePoint template parameter the installer sets is text, so each is quoted as before', () => {
  const model = readTemplateModel(readFileSync(PAX_TEMPLATE)).model;
  const names = Object.values(/** @type {Record<string, string>} */ (PRODUCT.pax.parameters));
  assert.ok(names.length > 0);
  for (const name of names) {
    const expr = model.expressions?.find((e) => e.name === name);
    const text = Array.isArray(expr?.expression) ? expr.expression.join('\n') : String(expr?.expression);
    assert.match(text, / meta \[[^\]]*\bType="Text"/, name);
  }
});
