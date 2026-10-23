// @ts-check
// The org app catalog checks a Teams package's manifest against Microsoft's manifest schema, and turns down one
// that fails: POST /v1.0/appCatalogs/teamsApps returns 400 BadRequest. fixtures/ keeps a copy of that schema, so
// the tests make no network calls. When the template's manifestVersion changes, save that version's schema there.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeTeamsPackage } from '../src/azure/teams.js';
import { readManifest } from './fakes.js';

const CLIENT_ID = '00000000-0000-4000-8000-000000000001';
const FQDN = 'vlens-web.wittyfield-0a1b2c3d.uksouth.azurecontainerapps.io';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** The manifest in the package this installer builds, as the Azure step builds it. @returns {Promise<any>} */
async function builtManifest() {
  const dir = mkdtempSync(join(tmpdir(), 'teams-manifest-'));
  try {
    const r = await writeTeamsPackage({ clientId: CLIENT_ID, fqdn: FQDN, appIdUri: `api://${FQDN}/${CLIENT_ID}`, version: VERSION, outFile: join(dir, 'AnalyticsHub-Teams.zip') });
    if (r.skipped) throw new Error(r.reason);
    return readManifest(r.zip);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Microsoft's schema for the manifest's version, from fixtures/. @param {any} manifest */
function schemaFor(manifest) {
  const url = `https://developer.microsoft.com/en-us/json-schemas/teams/v${manifest.manifestVersion}/MicrosoftTeams.schema.json`;
  const file = new URL(`./fixtures/MicrosoftTeams.v${manifest.manifestVersion}.schema.json`, import.meta.url);
  assert.equal(manifest.$schema, url);
  assert.ok(existsSync(file), `Save ${url} as installer/test/fixtures/MicrosoftTeams.v${manifest.manifestVersion}.schema.json.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @type {Record<string, (v: any) => boolean>} */
const IS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};
/** @type {Record<string, RegExp>} An absolute URI: a scheme, then no spaces. */
const FORMATS = { uri: /^[a-z][a-z\d+.-]*:\S*$/i };
/** The same JSON whatever the key order, for enum, const and uniqueItems. @param {any} v */
const canonical = (v) => JSON.stringify(v, (_, x) => (IS.object(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * What's wrong with `value` under JSON schema `root`, one line per problem at its JSON pointer. It knows the
 * draft-04 keywords Microsoft's manifest schema uses, so it needs no dependency. Any other keyword it reaches
 * is a problem too, so a schema it doesn't fully understand can't pass by mistake.
 * @param {any} root @param {any} value @returns {string[]}
 */
function validate(root, value) {
  /** @type {string[]} */
  const problems = [];
  /** @param {any} s @param {any} v @param {string} at @returns {void} */
  const check = (s, v, at) => {
    if (s.$ref) return check(s.$ref.replace(/^#\//, '').split('/').reduce((/** @type {any} */ node, /** @type {string} */ key) => node[key], root), v, at);
    const fail = (/** @type {string} */ problem, where = at) => problems.push(`${where || '/'}: ${problem}`);
    for (const [k, r] of Object.entries(s)) {
      switch (k) {
        case '$schema': case 'title': case 'description': case 'default': case 'definitions': break;
        case 'type': if (![r].flat().some((t) => IS[t](v))) fail(`should be ${[r].flat().join(' or ')}`); break;
        case 'enum': if (!r.some((/** @type {any} */ e) => canonical(e) === canonical(v))) fail(`should be one of ${JSON.stringify(r)}`); break;
        case 'const': if (canonical(r) !== canonical(v)) fail(`should be ${JSON.stringify(r)}`); break;
        case 'pattern': if (IS.string(v) && !new RegExp(r, 'u').test(v)) fail(`String "${v}" does not match regex pattern "${r}"`); break;
        case 'maxLength': if (IS.string(v) && [...v].length > r) fail(`should be at most ${r} characters`); break;
        case 'format': if (!FORMATS[r]) fail(`the schema's format "${r}" isn't supported here`); else if (IS.string(v) && !FORMATS[r].test(v)) fail(`should be a ${r}`); break;
        case 'maximum': if (IS.number(v) && v > r) fail(`should be at most ${r}`); break;
        case 'items': if (IS.array(v)) v.forEach((/** @type {any} */ x, /** @type {number} */ i) => check(r, x, `${at}/${i}`)); break;
        case 'minItems': if (IS.array(v) && v.length < r) fail(`should have at least ${r} items`); break;
        case 'maxItems': if (IS.array(v) && v.length > r) fail(`should have at most ${r} items`); break;
        case 'uniqueItems': if (r && IS.array(v) && new Set(v.map(canonical)).size < v.length) fail('should have no duplicate items'); break;
        case 'required': if (IS.object(v)) for (const p of r) if (!Object.hasOwn(v, p)) fail('is required', `${at}/${p}`); break;
        case 'minProperties': if (IS.object(v) && Object.keys(v).length < r) fail(`should have at least ${r} properties`); break;
        case 'properties': if (IS.object(v)) for (const [p, sub] of Object.entries(r)) if (Object.hasOwn(v, p)) check(sub, v[p], `${at}/${p}`); break;
        case 'additionalProperties':
          if (IS.object(v)) for (const p of Object.keys(v).filter((p) => !Object.hasOwn(s.properties ?? {}, p))) {
            if (r === false) fail('is not allowed', `${at}/${p}`);
            else check(r, v[p], `${at}/${p}`);
          }
          break;
        case 'dependencies': if (IS.object(v)) for (const [p, d] of Object.entries(r)) if (Object.hasOwn(v, p)) check(Array.isArray(d) ? { required: d } : d, v, at); break;
        default: fail(`the schema's "${k}" keyword isn't supported here: add it to validate()`);
      }
    }
  };
  check(root, value, '');
  return problems;
}

test('the Teams package passes the manifest schema the org app catalog checks', async () => {
  const manifest = await builtManifest();
  assert.deepEqual(validate(schemaFor(manifest), manifest), []);
});

test('the schema check fails a manifest the app catalog turns down', async () => {
  const manifest = await builtManifest();
  const schema = schemaFor(manifest);
  // The catalog's answer to 0.6.7's first package: "Schema validation failed at 'accentColor'".
  assert.deepEqual(validate(schema, { ...manifest, accentColor: '6264A7' }), ['/accentColor: String "6264A7" does not match regex pattern "^#[0-9a-fA-F]{6}$"']);
  const { icons, ...noIcons } = manifest;
  const tab = manifest.staticTabs[0];
  const broken = { ...noIcons, manifestVersion: '1.16', id: 'analytics-hub', name: { short: 'A'.repeat(31) }, staticTabs: [tab, tab, { ...tab, entityId: 'x', scopes: ['everyone'] }], validDomains: FQDN, extra: true };
  assert.deepEqual(validate(schema, broken).sort(), [
    '/extra: is not allowed',
    '/icons: is required',
    '/id: String "analytics-hub" does not match regex pattern "^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$"',
    '/manifestVersion: should be "1.17"',
    '/name/full: is required',
    '/name/short: should be at most 30 characters',
    '/staticTabs/2/scopes/0: should be one of ["team","personal","groupChat"]',
    '/staticTabs: should have no duplicate items',
    '/validDomains: should be array',
  ].sort());
});
