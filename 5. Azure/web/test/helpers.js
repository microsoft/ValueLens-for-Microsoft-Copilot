import { once } from 'node:events';
import { createServer, MemorySettingsStore } from '../src/server.js';

export function testConfig(overrides = {}) {
  return {
    tenantId: 'tenant-id', webClientId: '11111111-1111-4111-8111-111111111111',
    appIdUri: 'api://example.contoso.com/11111111-1111-4111-8111-111111111111', storageAccount: 'storage',
    semanticModels: { default: { workspaceId: 'workspace-1', itemId: 'dataset-1' } },
    version: '0.1.0', releasesUrl: 'https://example.test/releases', settingsWriters: 'admin', azureClientId: 'mi-client-id', publicDir: '', ...overrides
  };
}
export async function startTestServer(options = {}) {
  const server = createServer({
    config: testConfig(options.config), settingsStore: options.settingsStore || new MemorySettingsStore(),
    verifyToken: options.verifyToken || fakeVerifyToken, tokenAcquirer: options.tokenAcquirer || (async () => 'powerbi-token'),
    fetchImpl: options.fetchImpl || (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    publicDir: options.publicDir || testConfig().publicDir, now: options.now
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
export async function request(baseUrl, path, init = {}) { return fetch(`${baseUrl}${path}`, init); }
export function authHeader(token = 'user') { return { Authorization: `Bearer ${token}` }; }
export async function fakeVerifyToken(token) {
  if (token === 'bad') throw new Error('bad token');
  if (token === 'norole') return { scp: 'access_as_user', oid: 'user-1', preferred_username: 'user@example.com', roles: [] };
  if (token === 'admin') return { scp: 'access_as_user', oid: 'admin-1', preferred_username: 'admin@example.com', roles: ['AnalyticsHub.Admin'] };
  return { scp: 'access_as_user', oid: 'user-1', preferred_username: 'user@example.com', roles: ['AnalyticsHub.User'] };
}
