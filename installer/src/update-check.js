/**
 * Whether a newer installer is out. The installer asks GitHub once when it starts; offline, behind a
 * proxy or when GitHub is slow, the check gives up quietly and the installer carries on.
 */

export const REPO = 'microsoft/AnalyticsHub-Dashboard';
export const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const LATEST_PAGE = `https://github.com/${REPO}/releases/latest`;
export const TAG_PREFIX = 'installer-v';
/** Set to 1 to skip the check, for example on a computer that can't reach GitHub. */
export const OPT_OUT = 'ANALYTICS_HUB_NO_UPDATE_CHECK';

/** @param {string} v @returns {number[] | null} */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/**
 * The release's version when it's newer than `current`, otherwise null. Pre-release and
 * unparseable versions never count as newer.
 * @param {string} current
 * @param {string} tag  A release tag such as `installer-v0.5.1`.
 */
export function newerVersion(current, tag) {
  if (!String(tag ?? '').startsWith(TAG_PREFIX)) return null;
  const latest = parse(tag.slice(TAG_PREFIX.length));
  const have = parse(String(current ?? '').replace(/[-+].*$/, ''));
  if (!latest || !have) return null;
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== have[i]) return latest[i] > have[i] ? latest.join('.') : null;
  }
  return null;
}

/**
 * @typedef {{ version: string, url: string }} Update
 * @param {{ version: string, fetch?: typeof globalThis.fetch, timeoutMs?: number, env?: Record<string, string | undefined> }} o
 * @returns {Promise<Update | null>}  Never rejects.
 */
export async function checkForUpdate(o) {
  const env = o.env ?? process.env;
  if (env[OPT_OUT] === '1' || env[OPT_OUT] === 'true') return null;
  const fetchFn = o.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  try {
    const res = await fetchFn(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AnalyticsHubInstaller' },
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    if (!res.ok) return null;
    const body = /** @type {any} */ (await res.json());
    if (body?.draft || body?.prerelease) return null;
    const version = newerVersion(o.version, body?.tag_name);
    if (!version) return null;
    const url = typeof body.html_url === 'string' && body.html_url.startsWith(`https://github.com/${REPO}/`) ? body.html_url : LATEST_PAGE;
    return { version, url };
  } catch {
    return null;
  }
}
