import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { applySecurityHeaders, readJsonBody, sendJson } from './http-utils.js';
import { createJwtVerifier, createOboTokenAcquirer, hasAccessScope, hasAdminRole, parseBearerToken, userNameFromClaims } from './auth.js';
import { QueryService } from './query.js';
import { AccessService, httpError } from './access.js';
import { MemorySettingsStore, TableSettingsStore, validateEntity, validateSettingsRow } from './settings.js';
import { VersionService } from './version.js';
import { createStaticHandler } from './static.js';

export function createServer(deps = {}) {
  const config = deps.config || loadConfig();
  const verifyToken = deps.verifyToken || createJwtVerifier(config);
  const tokenAcquirer = deps.tokenAcquirer || createOboTokenAcquirer(config);
  const settingsStore = deps.settingsStore || new TableSettingsStore(config);
  const queryService = new QueryService({ config, tokenAcquirer, fetchImpl: deps.fetchImpl || fetch, now: deps.now });
  const accessService = new AccessService({ config, tokenAcquirer, fetchImpl: deps.fetchImpl || fetch, now: deps.now });
  const auth = (req, write = false) => requireAuth(req, verifyToken, write, config, accessService);
  const versionService = new VersionService({ installed: config.version, releasesUrl: config.releasesUrl, fetchImpl: deps.fetchImpl || fetch, now: deps.now });
  const staticHandler = createStaticHandler(deps.publicDir || config.publicDir);

  return http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/app.config.json') {
        res.setHeader('Cache-Control', 'no-store');
        return sendJson(res, 200, { host: 'azure', tenantId: config.tenantId, clientId: config.webClientId, apiScope: `${config.appIdUri}/access_as_user`, semanticModels: config.semanticModels, reporting: config.reporting, version: config.version, ...(config.access ? { access: publicAccess(config.access) } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { status: 'ok', version: config.version });
      if (url.pathname === '/api/query' && req.method === 'POST') {
        const result = await queryService.execute(await readJsonBody(req, 128 * 1024), await auth(req));
        for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
        res.statusCode = result.status;
        return res.end(result.body);
      }
      const settingsMatch = /^\/api\/settings\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (settingsMatch) {
        const [, entity, encodedId] = settingsMatch;
        if (!validateEntity(entity)) return sendJson(res, 404, { error: { code: 'NotFound', message: 'Unknown settings entity.' } });
        if (req.method === 'GET' && !encodedId) { await auth(req); return sendJson(res, 200, await settingsStore.list(entity)); }
        if ((req.method === 'PUT' || req.method === 'DELETE') && encodedId) {
          const caller = await auth(req, true);
          const id = decodeURIComponent(encodedId);
          if (req.method === 'DELETE') { await settingsStore.delete(entity, id); res.statusCode = 204; return res.end(); }
          const body = await readJsonBody(req, 20 * 1024);
          validateSettingsRow(body);
          const row = { ...body, id, updatedBy: userNameFromClaims(caller.claims), updatedAt: new Date().toISOString() };
          return sendJson(res, 200, await settingsStore.upsert(entity, id, row));
        }
        return sendJson(res, 405, { error: { code: 'MethodNotAllowed', message: 'Method not allowed.' } });
      }
      if (url.pathname === '/api/version' && req.method === 'GET') { await auth(req); return sendJson(res, 200, await versionService.getVersion()); }
      if (url.pathname === '/api/access' && req.method === 'GET') return sendJson(res, 200, await accessService.describe(await auth(req)));
      if (url.pathname === '/api/access/members' && req.method === 'POST') {
        const caller = await auth(req);
        const body = await readJsonBody(req, 4 * 1024);
        return sendJson(res, 201, await accessService.add(caller, body?.name));
      }
      const memberMatch = /^\/api\/access\/members\/([^/]+)$/.exec(url.pathname);
      if (memberMatch && req.method === 'DELETE') { await accessService.remove(await auth(req), decodeURIComponent(memberMatch[1])); res.statusCode = 204; return res.end(); }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: { code: 'NotFound', message: 'API route not found.' } });
      if (await staticHandler(req, res, url.pathname)) return;
      return sendJson(res, 404, { error: { code: 'NotFound', message: 'Not found.' } });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) console.error(`${req.method} ${req.url} failed:`, error);
      else if (status === 401 || status === 403) console.warn(`${req.method} ${req.url} ${status}: ${error.message}`);
      return sendJson(res, status, { error: { code: error.code || (status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'ServerError'), message: status === 500 ? 'Internal server error.' : error.message } });
    }
  });
}

async function requireAuth(req, verifyToken, write, config, accessService) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) { const e = new Error('Missing bearer token.'); e.statusCode = 401; throw e; }
  let claims;
  try { claims = await verifyToken(token); } catch { const e = new Error('Invalid bearer token.'); e.statusCode = 401; throw e; }
  if (!hasAccessScope(claims)) { const e = new Error('Token is missing the access_as_user scope.'); e.statusCode = 401; throw e; }
  const caller = { token, claims };
  if (!(await accessService.isViewer(caller))) throw httpError(403, 'NotAViewer', 'You are not in the Analytics Hub viewer group and have no Analytics Hub role.');
  if (write && config.settingsWriters !== 'all' && !hasAdminRole(claims)) throw httpError(403, 'Forbidden', 'Settings writes require AnalyticsHub.Admin.');
  return caller;
}

/** The parts of the access config the app shows: never more than the installer wrote. */
function publicAccess(access) {
  const { groupId, groupName, contact, requestUrl } = access;
  return { groupId, ...(groupName ? { groupName } : {}), ...(contact ? { contact } : {}), ...(requestUrl ? { requestUrl } : {}) };
}

export function start() {
  const config = loadConfig();
  const server = createServer({ config });
  server.listen(config.port, () => console.log(`valuelens-web listening on ${config.port}`));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) start();
export { MemorySettingsStore };
