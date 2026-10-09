import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { applySecurityHeaders, readJsonBody, sendJson } from './http-utils.js';
import { createJwtVerifier, createOboTokenAcquirer, hasAccessScope, hasAdminRole, hasUserRole, parseBearerToken, userNameFromClaims } from './auth.js';
import { QueryService } from './query.js';
import { MemorySettingsStore, TableSettingsStore, validateEntity, validateSettingsRow } from './settings.js';
import { VersionService } from './version.js';
import { createStaticHandler } from './static.js';

export function createServer(deps = {}) {
  const config = deps.config || loadConfig();
  const verifyToken = deps.verifyToken || createJwtVerifier(config);
  const tokenAcquirer = deps.tokenAcquirer || createOboTokenAcquirer(config);
  const settingsStore = deps.settingsStore || new TableSettingsStore(config);
  const queryService = new QueryService({ config, tokenAcquirer, fetchImpl: deps.fetchImpl || fetch, now: deps.now });
  const versionService = new VersionService({ installed: config.version, releasesUrl: config.releasesUrl, fetchImpl: deps.fetchImpl || fetch, now: deps.now });
  const staticHandler = createStaticHandler(deps.publicDir || config.publicDir);

  return http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/app.config.json') {
        res.setHeader('Cache-Control', 'no-store');
        return sendJson(res, 200, { host: 'azure', tenantId: config.tenantId, clientId: config.webClientId, apiScope: `${config.appIdUri}/access_as_user`, semanticModels: config.semanticModels, reporting: config.reporting, version: config.version });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { status: 'ok', version: config.version });
      if (url.pathname === '/api/query' && req.method === 'POST') {
        const auth = await requireAuth(req, verifyToken, false, config);
        const result = await queryService.execute(await readJsonBody(req, 128 * 1024), auth);
        for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
        res.statusCode = result.status;
        return res.end(result.body);
      }
      const settingsMatch = /^\/api\/settings\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (settingsMatch) {
        const [, entity, encodedId] = settingsMatch;
        if (!validateEntity(entity)) return sendJson(res, 404, { error: { code: 'NotFound', message: 'Unknown settings entity.' } });
        if (req.method === 'GET' && !encodedId) { await requireAuth(req, verifyToken, false, config); return sendJson(res, 200, await settingsStore.list(entity)); }
        if ((req.method === 'PUT' || req.method === 'DELETE') && encodedId) {
          const auth = await requireAuth(req, verifyToken, true, config);
          const id = decodeURIComponent(encodedId);
          if (req.method === 'DELETE') { await settingsStore.delete(entity, id); res.statusCode = 204; return res.end(); }
          const body = await readJsonBody(req, 20 * 1024);
          validateSettingsRow(body);
          const row = { ...body, id, updatedBy: userNameFromClaims(auth.claims), updatedAt: new Date().toISOString() };
          return sendJson(res, 200, await settingsStore.upsert(entity, id, row));
        }
        return sendJson(res, 405, { error: { code: 'MethodNotAllowed', message: 'Method not allowed.' } });
      }
      if (url.pathname === '/api/version' && req.method === 'GET') { await requireAuth(req, verifyToken, false, config); return sendJson(res, 200, await versionService.getVersion()); }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: { code: 'NotFound', message: 'API route not found.' } });
      if (await staticHandler(req, res, url.pathname)) return;
      return sendJson(res, 404, { error: { code: 'NotFound', message: 'Not found.' } });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error(`${req.method} ${req.url} failed:`, error);
      else if (status === 401 || status === 403) console.warn(`${req.method} ${req.url} ${status}: ${error.message}`);
      return sendJson(res, status, { error: { code: status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'ServerError', message: status === 500 ? 'Internal server error.' : error.message } });
    }
  });
}

async function requireAuth(req, verifyToken, write, config) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) { const e = new Error('Missing bearer token.'); e.statusCode = 401; throw e; }
  let claims;
  try { claims = await verifyToken(token); } catch { const e = new Error('Invalid bearer token.'); e.statusCode = 401; throw e; }
  if (!hasAccessScope(claims)) { const e = new Error('Token is missing the access_as_user scope.'); e.statusCode = 401; throw e; }
  if (!hasUserRole(claims)) { const e = new Error('Token is missing the Analytics Hub role.'); e.statusCode = 403; throw e; }
  if (write && config.settingsWriters !== 'all' && !hasAdminRole(claims)) { const e = new Error('Settings writes require AnalyticsHub.Admin.'); e.statusCode = 403; throw e; }
  return { token, claims };
}

export function start() {
  const config = loadConfig();
  const server = createServer({ config });
  server.listen(config.port, () => console.log(`valuelens-web listening on ${config.port}`));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) start();
export { MemorySettingsStore };
