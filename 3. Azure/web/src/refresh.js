import { ManagedIdentityCredential } from '@azure/identity';
import { POWER_BI_SCOPES } from './auth.js';

const BASE = 'https://api.powerbi.com/v1.0/myorg';
/** Only the scope table changes: the roles read it at query time, so nothing else needs reloading. */
const BODY = { type: 'full', commitMode: 'transactional', applyRefreshPolicy: false, retryCount: 1, objects: [{ table: 'Access Scope' }] };
const MIN_GAP_MS = 2 * 60 * 1000;
const MAX_RETRIES = 5;

/**
 * Refreshes the access table in each model after a scope change, as the web app's managed identity
 * (a Member of the Power BI workspace). Changes close together share a refresh: at most one waits
 * per model, and while Power BI is busy it tries again a few times before leaving the change to the
 * next scheduled refresh.
 *
 * `request()` answers `started`, `queued` (a refresh will start shortly) or `unavailable` (Power BI
 * didn't take one, so the change applies at the next scheduled refresh).
 */
export class AccessRefresher {
  constructor({ models, getToken, fetchImpl = fetch, now = () => Date.now(), setTimer = setTimeout, minGapMs = MIN_GAP_MS, maxRetries = MAX_RETRIES }) {
    this.models = uniqueModels(models); this.getToken = getToken; this.fetch = fetchImpl; this.now = now;
    this.setTimer = setTimer; this.minGapMs = minGapMs; this.maxRetries = maxRetries;
    this.state = new Map(); this.last = null;
  }

  async request() {
    if (!this.models.length) return this.remember('unavailable');
    const results = await Promise.all(this.models.map((m) => this.requestOne(m)));
    const status = results.includes('unavailable') ? 'unavailable' : results.includes('queued') ? 'queued' : 'started';
    return this.remember(status);
  }

  remember(status) { this.last = { status, at: new Date(this.now()).toISOString() }; return this.last; }

  stateOf(m) {
    const key = `${m.workspaceId}/${m.itemId}`;
    if (!this.state.has(key)) this.state.set(key, { startedAt: -Infinity, timer: null, retries: 0 });
    return this.state.get(key);
  }

  async requestOne(m) {
    const s = this.stateOf(m);
    if (s.timer) return 'queued';
    const wait = s.startedAt + this.minGapMs - this.now();
    if (wait > 0) { this.later(m, wait); return 'queued'; }
    return this.start(m);
  }

  later(m, ms) {
    const s = this.stateOf(m);
    s.timer = this.setTimer(() => {
      s.timer = null;
      this.start(m).then((status) => { if (status !== 'queued') this.remember(status); }, () => {});
    }, ms);
    s.timer?.unref?.();
  }

  async start(m) {
    const s = this.stateOf(m);
    let response, text = '';
    try {
      const token = await this.getToken(POWER_BI_SCOPES);
      response = await this.fetch(`${BASE}/groups/${encodeURIComponent(m.workspaceId)}/datasets/${encodeURIComponent(m.itemId)}/refreshes`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY)
      });
      text = await response.text().catch(() => '');
    } catch (error) {
      console.warn(`Access refresh of ${m.itemId} failed: ${error?.message || error}`);
      return 'unavailable';
    }
    if (response.status === 202 || response.ok) { s.startedAt = this.now(); s.retries = 0; return 'started'; }
    const busy = response.status === 409 || response.status === 429 || /in progress|already (running|executing)/i.test(text);
    if (busy && s.retries < this.maxRetries) { s.retries += 1; this.later(m, this.minGapMs); return 'queued'; }
    console.warn(`Access refresh of ${m.itemId} returned ${response.status}: ${text.slice(0, 300)}`);
    s.retries = 0;
    return 'unavailable';
  }
}

/** The managed identity's tokens, for the refresh. */
export function managedIdentityTokens(config) {
  const credential = new ManagedIdentityCredential(config.azureClientId || undefined);
  return async (scopes) => {
    const token = await credential.getToken(scopes);
    if (!token?.token) throw new Error('Managed identity token acquisition failed');
    return token.token;
  };
}

function uniqueModels(models) {
  const seen = new Map();
  for (const m of Object.values(models || {})) {
    const itemId = m?.itemId || m?.datasetId;
    if (m?.workspaceId && itemId) seen.set(`${m.workspaceId}/${itemId}`, { workspaceId: m.workspaceId, itemId });
  }
  return [...seen.values()];
}
