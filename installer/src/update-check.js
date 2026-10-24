/**
 * Whether a newer installer is out. The installer asks GitHub once when it starts; offline, behind a
 * proxy or when GitHub is slow, the check gives up quietly and the installer carries on.
 *
 * It lists the repo's releases rather than asking for GitHub's "Latest": the repo's dashboard
 * releases take "Latest", so it often isn't an installer release at all.
 */
import { PRODUCT } from './product.js';

export const REPO = PRODUCT.repo;
export const TAG_PREFIX = PRODUCT.tagPrefix;
/** The repo's 100 newest releases. The newest installer release is among them. */
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
/** The installer's releases on GitHub, for people. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases?q=${TAG_PREFIX}`;
/** Set to 1 to skip the check, for example on a computer that can't reach GitHub. */
export const OPT_OUT = PRODUCT.env.noUpdateCheck;

/** @param {string} v @returns {number[] | null} */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** Above 0 when version `a` is newer than `b`. @param {number[]} a @param {number[]} b */
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The release's version when it's newer than `current`, otherwise null. Pre-release and
 * unparseable versions never count as newer.
 * @param {string} current
 * @param {string} tag  A release tag such as `valuelens-installer-v0.5.1`.
 */
export function newerVersion(current, tag) {
  if (!String(tag ?? '').startsWith(TAG_PREFIX)) return null;
  const latest = parse(tag.slice(TAG_PREFIX.length));
  const have = parse(String(current ?? '').replace(/[-+].*$/, ''));
  if (!latest || !have) return null;
  return compare(latest, have) > 0 ? latest.join('.') : null;
}

/**
 * The newest published installer release in GitHub's list of releases: not a draft or pre-release,
 * and tagged `valuelens-installer-v<x.y.z>`. The repo's dashboard releases and its earlier
 * `installer-v` releases, which were Analytics Hub's, don't count.
 * @param {unknown} releases  The body of GET /repos/{owner}/{repo}/releases.
 * @returns {{ version: string, tag: string } | null}
 */
export function newestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  /** @type {{ v: number[], tag: string } | null} */
  let best = null;
  for (const r of releases) {
    const tag = r?.tag_name;
    if (r?.draft || r?.prerelease || typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) continue;
    const v = parse(tag.slice(TAG_PREFIX.length));
    if (v && (!best || compare(v, best.v) > 0)) best = { v, tag };
  }
  return best && { version: best.v.join('.'), tag: best.tag };
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
    const res = await fetchFn(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': PRODUCT.userAgent },
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    if (!res.ok) return null;
    const newest = newestRelease(await res.json());
    const version = newest && newerVersion(o.version, newest.tag);
    if (!newest || !version) return null;
    return { version, url: `https://github.com/${REPO}/releases/tag/${newest.tag}` };
  } catch {
    return null;
  }
}
