import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, request, authHeader } from './helpers.js';
import { MemorySettingsStore } from '../src/server.js';
import { VersionService } from '../src/version.js';

const testDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-scratch');

test('app.config.json and health expose expected public shape', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const config = await request(baseUrl, '/app.config.json');
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await config.json(), { host: 'azure', tenantId: 'tenant-id', clientId: '11111111-1111-4111-8111-111111111111', apiScope: 'api://example.contoso.com/11111111-1111-4111-8111-111111111111/access_as_user', semanticModels: { default: { workspaceId: 'workspace-1', itemId: 'dataset-1' } }, version: '0.1.0' });
    assert.deepEqual(await (await request(baseUrl, '/api/health')).json(), { status: 'ok', version: '0.1.0' });
  } finally { server.close(); }
});

test('auth returns 401 for missing or invalid tokens and 403 for missing roles', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    assert.equal((await request(baseUrl, '/api/version')).status, 401);
    assert.equal((await request(baseUrl, '/api/version', { headers: authHeader('bad') })).status, 401);
    assert.equal((await request(baseUrl, '/api/version', { headers: authHeader('norole') })).status, 403);
  } finally { server.close(); }
});

test('query rejects non-allow-listed models', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await request(baseUrl, '/api/query', { method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'other', itemId: 'dataset-1', query: 'EVALUATE ROW("x", 1)' }) });
    assert.equal(response.status, 400);
  } finally { server.close(); }
});

test('query forwards executeQueries verbatim, caches and coalesces identical requests', async () => {
  const calls = []; let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const fetchImpl = async (url, init) => { calls.push({ url, init }); await fetchPromise; return new Response('{"results":[{"tables":[]}]}', { status: 207, headers: { 'Content-Type': 'application/json' } }); };
  const { server, baseUrl } = await startTestServer({ fetchImpl, tokenAcquirer: async () => 'obo-token' });
  try {
    const init = { method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace-1', itemId: 'dataset-1', query: 'EVALUATE ROW("x", 1)' }) };
    const first = request(baseUrl, '/api/query', init); const second = request(baseUrl, '/api/query', init);
    await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(calls.length, 1); resolveFetch();
    const r1 = await first; const r2 = await second;
    assert.equal(r1.status, 207); assert.equal(await r1.text(), '{"results":[{"tables":[]}]}'); assert.equal(await r2.text(), '{"results":[{"tables":[]}]}');
    assert.equal(calls[0].url, 'https://api.powerbi.com/v1.0/myorg/groups/workspace-1/datasets/dataset-1/executeQueries');
    assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers.Authorization, 'Bearer obo-token');
    assert.deepEqual(JSON.parse(calls[0].init.body), { queries: [{ query: 'EVALUATE ROW("x", 1)' }], serializerSettings: { includeNulls: true } });
    assert.equal((await request(baseUrl, '/api/query', init)).status, 207); assert.equal(calls.length, 1);
  } finally { server.close(); }
});

test('query passes through 429 and Retry-After', async () => {
  const fetchImpl = async () => new Response('{"error":{"code":"TooManyRequests"}}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '12' } });
  const { server, baseUrl } = await startTestServer({ fetchImpl });
  try {
    const response = await request(baseUrl, '/api/query', { method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace-1', itemId: 'dataset-1', query: 'EVALUATE ROW("x", 1)' }) });
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '12'); assert.equal(await response.text(), '{"error":{"code":"TooManyRequests"}}');
  } finally { server.close(); }
});

test('settings CRUD uses store, enforces admin-only writes and sets audit fields', async () => {
  const { server, baseUrl } = await startTestServer({ settingsStore: new MemorySettingsStore() });
  try {
    assert.equal((await request(baseUrl, '/api/settings/CommercialTerms/foo', { method: 'PUT', headers: { ...authHeader(), 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status, 403);
    const put = await request(baseUrl, '/api/settings/CommercialTerms/foo', { method: 'PUT', headers: { ...authHeader('admin'), 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    const row = await put.json(); assert.equal(put.status, 200); assert.equal(row.id, 'foo'); assert.equal(row.updatedBy, 'admin@example.com'); assert.match(row.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual((await (await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader() })).json()).map((r) => r.id), ['foo']);
    assert.equal((await request(baseUrl, '/api/settings/CommercialTerms/foo', { method: 'DELETE', headers: authHeader('admin') })).status, 204);
    assert.deepEqual(await (await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader() })).json(), []);
  } finally { server.close(); }
});

test('settings keep monthly budgets on the commercial terms row as sent', async () => {
  const { server, baseUrl } = await startTestServer({ settingsStore: new MemorySettingsStore() });
  const id = '00000000-0000-0000-0000-000000000001';
  try {
    const terms = { id, creditRate: 0.01, budgetCowork: 5000, budgetStudio: 2500.5, budgetAzure: null };
    const put = await request(baseUrl, `/api/settings/CommercialTerms/${id}`, { method: 'PUT', headers: { ...authHeader('admin'), 'Content-Type': 'application/json' }, body: JSON.stringify(terms) });
    assert.equal(put.status, 200);
    const [row] = await (await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader() })).json();
    assert.deepEqual({ creditRate: row.creditRate, budgetCowork: row.budgetCowork, budgetStudio: row.budgetStudio, budgetAzure: row.budgetAzure }, { creditRate: 0.01, budgetCowork: 5000, budgetStudio: 2500.5, budgetAzure: null });
  } finally { server.close(); }
});

test('settings entity whitelist returns 404', async () => {
  const { server, baseUrl } = await startTestServer();
  try { assert.equal((await request(baseUrl, '/api/settings/Other', { headers: authHeader() })).status, 404); } finally { server.close(); }
});

test('version selects highest stable Azure or generic semver tag', async () => {
  const service = new VersionService({ installed: '0.1.0', releasesUrl: 'https://example.test/releases', fetchImpl: async () => new Response(JSON.stringify([{ tag_name: 'analytics-hub-azure-v0.2.0', draft: false, prerelease: false, html_url: 'https://example.test/0.2.0' }, { tag_name: 'v0.3.0', draft: false, prerelease: true }, { tag_name: 'other-v9.0.0', draft: false, prerelease: false }]), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
  assert.deepEqual(await service.getVersion(), { installed: '0.1.0', latest: '0.2.0', updateAvailable: true, releaseUrl: 'https://example.test/0.2.0' });
});

test('SPA fallback and security headers include Teams frame ancestors', async () => {
  await fs.rm(testDir, { recursive: true, force: true }); await fs.mkdir(path.join(testDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(testDir, 'index.html'), '<html>app</html>'); await fs.writeFile(path.join(testDir, 'assets', 'app.js'), 'console.log("x");');
  const { server, baseUrl } = await startTestServer({ publicDir: testDir });
  try {
    const response = await request(baseUrl, '/dashboard', { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '<html>app</html>'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors[^;]*teams\.microsoft\.com/); assert.equal(response.headers.get('x-frame-options'), null);
    assert.equal((await request(baseUrl, '/assets/app.js')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
  } finally { server.close(); await fs.rm(testDir, { recursive: true, force: true }); }
});
