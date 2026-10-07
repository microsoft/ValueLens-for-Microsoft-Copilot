const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TAG_PREFIX = 'analytics-hub-azure-v';

export class VersionService {
  constructor({ installed, releasesUrl, fetchImpl = fetch, now = () => Date.now() }) {
    this.installed = installed; this.releasesUrl = releasesUrl; this.fetch = fetchImpl; this.now = now; this.cache = null;
  }
  async getVersion() {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.value;
    let value = { installed: this.installed, latest: null, updateAvailable: false, releaseUrl: null };
    try {
      const response = await this.fetch(this.releasesUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'valuelens-web' } });
      if (!response.ok) throw new Error(`Release fetch failed: ${response.status}`);
      const latestRelease = findLatestRelease(await response.json());
      if (latestRelease) value = { installed: this.installed, latest: latestRelease.version, updateAvailable: compareSemver(latestRelease.version, this.installed) > 0, releaseUrl: latestRelease.url };
    } catch { value = { installed: this.installed, latest: null, updateAvailable: false, releaseUrl: null }; }
    this.cache = { expiresAt: this.now() + CACHE_TTL_MS, value };
    return value;
  }
}
export function findLatestRelease(releases) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.draft || release?.prerelease) continue;
    const version = parseReleaseVersion(String(release?.tag_name || ''));
    if (!version) continue;
    const candidate = { version, url: release.html_url || release.url || null };
    if (!best || compareSemver(candidate.version, best.version) > 0) best = candidate;
  }
  return best;
}
export function parseReleaseVersion(tag) {
  const raw = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag.startsWith('v') ? tag.slice(1) : '';
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw) ? raw : null;
}
export function compareSemver(a, b) {
  const pa = String(a).split(/[+-]/, 1)[0].split('.').map(Number);
  const pb = String(b).split(/[+-]/, 1)[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) { const diff = (pa[i] || 0) - (pb[i] || 0); if (diff !== 0) return diff; }
  return 0;
}
