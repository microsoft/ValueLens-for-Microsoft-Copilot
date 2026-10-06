import { isAllowedSemanticModel } from './config.js';
import { userIdFromClaims } from './auth.js';

const QUERY_MAX_BYTES = 100 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES_PER_USER = 200;
const MAX_CONCURRENT_PER_USER = 4;

class UserLimiter {
  constructor(limit = MAX_CONCURRENT_PER_USER) { this.limit = limit; this.active = 0; this.queue = []; }
  run(work) {
    return new Promise((resolve, reject) => { this.queue.push({ work, resolve, reject }); this.pump(); });
  }
  pump() {
    while (this.active < this.limit && this.queue.length) {
      const item = this.queue.shift();
      this.active += 1;
      item.work().then(item.resolve, item.reject).finally(() => { this.active -= 1; this.pump(); });
    }
  }
}

export class QueryService {
  constructor({ config, tokenAcquirer, fetchImpl = fetch, now = () => Date.now() }) {
    this.config = config; this.tokenAcquirer = tokenAcquirer; this.fetch = fetchImpl; this.now = now;
    this.caches = new Map(); this.inflight = new Map(); this.limiters = new Map();
  }
  async execute(body, auth) {
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
    const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    const query = typeof body?.query === 'string' ? body.query : '';
    if (!workspaceId || !itemId || !isAllowedSemanticModel(this.config.semanticModels, workspaceId, itemId)) {
      return jsonError(400, 'SemanticModelNotAllowed', 'The requested semantic model is not configured for this Analytics Hub instance.');
    }
    if (!query.trim() || Buffer.byteLength(query, 'utf8') > QUERY_MAX_BYTES) {
      return jsonError(400, 'InvalidQuery', 'query must be a non-empty string no larger than 100 KB.');
    }
    const userId = userIdFromClaims(auth.claims);
    const cacheKey = `${userId}\u001f${workspaceId}\u001f${itemId}\u001f${query}`;
    const cached = this.getCached(userId, cacheKey);
    if (cached) return cached;
    if (this.inflight.has(cacheKey)) return this.inflight.get(cacheKey);
    const promise = this.getLimiter(userId).run(() => this.callPowerBi(workspaceId, itemId, query, auth))
      .then((result) => { if (result.status >= 200 && result.status < 300) this.setCached(userId, cacheKey, result); return result; })
      .finally(() => this.inflight.delete(cacheKey));
    this.inflight.set(cacheKey, promise);
    return promise;
  }
  getLimiter(userId) { if (!this.limiters.has(userId)) this.limiters.set(userId, new UserLimiter()); return this.limiters.get(userId); }
  getCache(userId) { if (!this.caches.has(userId)) this.caches.set(userId, new Map()); return this.caches.get(userId); }
  getCached(userId, key) {
    const cache = this.getCache(userId); const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, entry); return entry.result;
  }
  setCached(userId, key, result) {
    const cache = this.getCache(userId); cache.set(key, { expiresAt: this.now() + CACHE_TTL_MS, result });
    while (cache.size > MAX_CACHE_ENTRIES_PER_USER) cache.delete(cache.keys().next().value);
  }
  async callPowerBi(workspaceId, itemId, query, auth) {
    const accessToken = await this.tokenAcquirer(auth.token, auth.claims);
    const url = `https://api.powerbi.com/v1.0/myorg/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(itemId)}/executeQueries`;
    const upstream = await this.fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true } })
    });
    const text = await upstream.text();
    const contentType = upstream.headers?.get?.('content-type') || 'application/json';
    const retryAfter = upstream.headers?.get?.('retry-after');
    if (!contentType.toLowerCase().includes('json')) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (retryAfter) headers['Retry-After'] = retryAfter;
      return { status: upstream.status, headers, body: JSON.stringify({ error: { code: `PowerBI_${upstream.status}`, message: text || upstream.statusText || 'Power BI request failed' } }) };
    }
    const headers = { 'Content-Type': contentType };
    if (retryAfter) headers['Retry-After'] = retryAfter;
    return { status: upstream.status, headers, body: text };
  }
}
function jsonError(status, code, message) { return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: { code, message } }) }; }
