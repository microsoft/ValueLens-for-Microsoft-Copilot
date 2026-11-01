import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkForUpdate, newerVersion, newestRelease, OPT_OUT, RELEASES_API, RELEASES_PAGE } from '../src/update-check.js';

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

/** @param {string} tag @param {{ draft?: boolean, prerelease?: boolean, name?: string }} [o] */
const release = (tag, o = {}) => ({ tag_name: tag, name: o.name ?? tag, draft: !!o.draft, prerelease: !!o.prerelease, html_url: `https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/tag/${tag}` });

/** The repo's releases, newest first as GitHub lists them: dashboard releases take "Latest". */
const RELEASES = [
  release('analytics-hub-azure-v0.5.1', { name: 'Analytics Hub has moved' }),
  release('valuelens-installer-v0.12.0', { prerelease: true }),
  release('valuelens-installer-v0.13.0-rc.1', { prerelease: true }),
  release('valuelens-installer-v0.11.0', { draft: true }),
  release('valuelens-installer-v0.2.0'),
  release('analytics-hub-azure-v0.5.0', { name: 'Analytics Hub has moved' }),
  release('valuelens-installer-v0.10.0'),
  release('valuelens-installer-v0.9.1'),
  release('installer-v0.4.2', { name: 'Analytics Hub installer 0.4.2' }),
  release('installer-v12.0.0'),
];

test('update check: only a newer valuelens-installer-v release counts', () => {
  assert.equal(newerVersion('0.5.0', 'valuelens-installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('0.5.0', 'valuelens-installer-v0.6.0'), '0.6.0');
  assert.equal(newerVersion('0.5.0', 'valuelens-installer-v1.0.0'), '1.0.0');
  assert.equal(newerVersion('0.5.0', 'valuelens-installer-v0.5.0'), null);
  assert.equal(newerVersion('0.5.1', 'valuelens-installer-v0.5.0'), null);
  assert.equal(newerVersion('0.10.0', 'valuelens-installer-v0.9.9'), null);
  assert.equal(newerVersion('0.5.0', 'v0.6.0'), null);
  assert.equal(newerVersion('0.5.0', 'analytics-hub-azure-v0.6.0'), null);
  assert.equal(newerVersion('0.0.1', 'installer-v0.4.2'), null, "this repo's earlier installer, now Analytics Hub's");
  assert.equal(newerVersion('0.5.0', 'valuelens-installer-v0.6.0-rc.1'), null);
  assert.equal(newerVersion('0.5.0-dev', 'valuelens-installer-v0.5.1'), '0.5.1');
  assert.equal(newerVersion('', 'valuelens-installer-v0.5.1'), null);
});

test("update check: the newest installer release is found among the repo's other releases", () => {
  assert.deepEqual(newestRelease(RELEASES), { version: '0.10.0', tag: 'valuelens-installer-v0.10.0' }, 'by version, not list order, and not 0.9.1 > 0.10.0 as text');
  assert.deepEqual(newestRelease([...RELEASES].reverse()), { version: '0.10.0', tag: 'valuelens-installer-v0.10.0' });
  const others = RELEASES.filter((r) => r.draft || r.prerelease || !r.tag_name.startsWith('valuelens-installer-v'));
  assert.equal(others.length, 7);
  assert.equal(newestRelease(others), null, 'drafts, pre-releases, dashboard releases and installer-v tags never count');
  assert.equal(newestRelease([release('analytics-hub-azure-v0.5.1', { name: 'Analytics Hub has moved' })]), null, 'what releases/latest returns today');
  assert.equal(newestRelease([]), null);
  for (const odd of [null, {}, 'x', { message: 'API rate limit exceeded' }, [null, 1, 'x', { tag_name: 7 }, { tag_name: 'valuelens-installer-vX' }]]) {
    assert.equal(newestRelease(odd), null, JSON.stringify(odd));
  }
});

test("update check: lists the repo's releases rather than asking for GitHub's Latest, and links to the release", async () => {
  const { fetch, calls } = fakeFetch(RELEASES);
  const u = await checkForUpdate({ version: '0.9.1', fetch, env: {} });
  assert.deepEqual(calls, [RELEASES_API]);
  assert.equal(RELEASES_API, 'https://api.github.com/repos/microsoft/ValueLens-for-Microsoft-Copilot/releases?per_page=100');
  assert.doesNotMatch(RELEASES_API, /latest/);
  assert.deepEqual(u, { version: '0.10.0', url: 'https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/tag/valuelens-installer-v0.10.0' });
});

test("update check: a release's own link is never used", async () => {
  const { fetch } = fakeFetch([{ ...release('valuelens-installer-v0.6.0'), html_url: 'https://example.com/x' }]);
  assert.deepEqual(await checkForUpdate({ version: '0.5.0', fetch, env: {} }), { version: '0.6.0', url: 'https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/tag/valuelens-installer-v0.6.0' });
});

test("update check: the releases page for people lists the installer's releases", () => {
  assert.equal(RELEASES_PAGE, 'https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=valuelens-installer-v');
});

test('update check: quiet when up to date, offline, failing or opted out', async () => {
  assert.equal(await checkForUpdate({ version: '0.10.0', fetch: fakeFetch(RELEASES).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.11.0', fetch: fakeFetch(RELEASES).fetch, env: {} }), null, 'not the draft or the pre-releases above it');
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch([release('valuelens-installer-v0.6.0', { prerelease: true })]).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch([release('analytics-hub-azure-v0.6.0')]).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch([], { ok: false }).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch(null).fetch, env: {} }), null);
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: fakeFetch({ tag_name: 'valuelens-installer-v0.6.0' }).fetch, env: {} }), null, 'one release, as releases/latest returns, is not a list');
  const badJson = /** @type {any} */ (async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: badJson, env: {} }), null);
  const offline = /** @type {any} */ (async () => { throw new TypeError('fetch failed'); });
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: offline, env: {} }), null);
  for (const value of ['1', 'true']) {
    const optedOut = fakeFetch(RELEASES);
    assert.equal(await checkForUpdate({ version: '0.5.0', fetch: optedOut.fetch, env: { [OPT_OUT]: value } }), null);
    assert.deepEqual(optedOut.calls, []);
  }
});

test('update check: gives up when GitHub is slow', async () => {
  const slow = /** @type {any} */ ((/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  assert.equal(await checkForUpdate({ version: '0.5.0', fetch: slow, timeoutMs: 50, env: {} }), null);
  assert.ok(Date.now() - started < 2000);
});
