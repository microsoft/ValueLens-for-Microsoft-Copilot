import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkForUpdate, LATEST_API, LATEST_PAGE, newerVersion, OPT_OUT } from '../src/update-check.js';

/** @param {any} body @param {{ ok?: boolean }} [o] */
const fakeFetch = (body, o = {}) => {
  /** @type {string[]} */
  const calls = [];
  const fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    calls.push(url);
    return { ok: o.ok ?? true, json: async () => body };
  });
  return { fetch, calls };
};

test('update check: only a newer installer-v release counts', () => {
  assert.equal(newerVersion('0.5.0', 'installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('0.5.0', 'installer-v0.6.0'), '0.6.0');
  assert.equal(newerVersion('0.5.0', 'installer-v1.0.0'), '1.0.0');
  assert.equal(newerVersion('0.5.0', 'installer-v0.5.0'), null);
  assert.equal(newerVersion('0.5.1', 'installer-v0.5.0'), null);
  assert.equal(newerVersion('0.10.0', 'installer-v0.9.9'), null);
  assert.equal(newerVersion('0.5.0', 'v0.6.0'), null);
  assert.equal(newerVersion('0.5.0', 'analytics-hub-azure-v0.6.0'), null);
  assert.equal(newerVersion('0.5.0', 'installer-v0.6.0-rc.1'), null);
  assert.equal(newerVersion('0.5.0-dev', 'installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('', 'installer-v0.5.1'), null);
});

test('update check: asks the new repo and links to its release', async () => {
  const { fetch, calls } = fakeFetch({ tag_name: 'installer-v0.6.0', html_url: 'https://github.com/microsoft/AnalyticsHub-Dashboard/releases/tag/installer-v0.6.0' });
  const u = await checkForUpdate({ version: '0.5.0', fetch, env: {} });
  assert.deepEqual(calls, [LATEST_API]);
  assert.match(LATEST_API, /api\.github\.com\/repos\/microsoft\/AnalyticsHub-Dashboard\/releases\/latest$/);
  assert.deepEqual(u, { version: '0.6.0', url: 'https://github.com/microsoft/AnalyticsHub-Dashboard/releases/tag/installer-v0.6.0' });
});

test('update check: a link elsewhere falls back to the releases page', async () => {
  const { fetch } = fakeFetch({ tag_name: 'installer-v0.6.0', html_url: 'https://example.com/x' });
  assert.deepEqual(await checkForUpdate({ version: '0.5.0', fetch, env: {} }), { version: '0.6.0', url: LATEST_PAGE });
});

test('update check: quiet when up to date, offline, failing or opted out', async () => {
  assert.equal(await checkForUpdate({ version: '0.6.0', fetch: fakeFetch({ tag_name: 'installer-v0.6.0' }).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch({ tag_name: 'installer-v0.6.0', prerelease: true }).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch({}, { ok: false }).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch(null).fetch, env: {} }), null);
  const offline = /** @type {any} */ (async () => { throw new TypeError('fetch failed'); });
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: offline, env: {} }), null);
  const optedOut = fakeFetch({ tag_name: 'installer-v0.6.0' });
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: optedOut.fetch, env: { [OPT_OUT]: '1' } }), null);
  assert.deepEqual(optedOut.calls, []);
});

test('update check: gives up when GitHub is slow', async () => {
  const slow = /** @type {any} */ ((/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: slow, timeoutMs: 50, env: {} }), null);
  assert.ok(Date.now() - started < 2000);
});
