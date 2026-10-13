// @ts-check
/**
 * One sign-in, tokens for every API the installer calls.
 */
import { AzureCliCredential, DeviceCodeCredential, InteractiveBrowserCredential } from '@azure/identity';

export const SCOPES = {
  graph: 'https://graph.microsoft.com/.default',
  fabric: 'https://api.fabric.microsoft.com/.default',
  arm: 'https://management.azure.com/.default',
  keyVault: 'https://vault.azure.net/.default',
  storage: 'https://storage.azure.com/.default',
  powerbi: 'https://analysis.windows.net/powerbi/api/.default',
  discovery: 'https://globaldisco.crm.dynamics.com/.default',
  powerPlatform: 'https://api.powerplatform.com/.default',
  flow: 'https://service.flow.microsoft.com/.default',
};

/**
 * A named API, or the scope of one found at run time, such as a Dataverse environment.
 * @typedef {keyof typeof SCOPES | `https://${string}/.default`} Resource
 */

/**
 * @typedef {object} AuthOptions
 * @property {string} [tenantId]  Omit to use the account's home tenant.
 * @property {'browser' | 'device-code' | 'azure-cli'} [method]
 * @property {(message: string) => void} [print]
 */

/**
 * @param {AuthOptions} opts
 * @returns {import('@azure/identity').TokenCredential}
 */
export function createCredential(opts) {
  const tenantId = opts.tenantId || undefined;
  switch (opts.method ?? 'browser') {
    case 'azure-cli':
      return new AzureCliCredential({ tenantId });
    case 'device-code':
      return new DeviceCodeCredential({
        tenantId,
        userPromptCallback: (info) => (opts.print ?? console.log)(info.message),
      });
    default:
      return new InteractiveBrowserCredential({ tenantId });
  }
}

/** Errors that mean the network blipped, not that the sign-in or request is wrong. */
const NETWORK_ERROR = /getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|NameResolutionError|Failed to resolve '|ConnectionError|Connection aborted|Max retries exceeded|Read timed out|network is unreachable|fetch failed/i;

/**
 * Whether an error is a transient network or DNS failure worth trying again.
 * @param {unknown} err
 */
export function isTransientNetworkError(err) {
  /** @type {any} */
  let e = err;
  for (let depth = 0; e && depth < 4; depth++, e = e.cause) {
    if (NETWORK_ERROR.test(`${e.code ?? ''} ${e.message ?? (typeof e === 'string' ? e : '')}`)) return true;
  }
  return false;
}

/** How many times a token is tried when the network blips, and the first wait; each wait doubles. */
export const TOKEN_ATTEMPTS = 6;
export const TOKEN_RETRY_MS = 2_000;

/**
 * Caches a token per resource until five minutes before it expires. Tries again, with backoff,
 * when the network or DNS blips.
 * @param {import('@azure/identity').TokenCredential} credential
 * @param {{ sleep?: (ms: number) => Promise<void>, debug?: (msg: string) => void }} [opts]
 */
export function createTokenProvider(credential, opts = {}) {
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  /** @type {Map<Resource, { token: string, expiresOn: number }>} */
  const cache = new Map();
  /** @param {Resource} resource */
  return async function getToken(resource) {
    const hit = cache.get(resource);
    if (hit && hit.expiresOn - Date.now() > 5 * 60_000) return hit.token;
    const scope = resource in SCOPES ? SCOPES[/** @type {keyof typeof SCOPES} */ (resource)] : resource;
    for (let attempt = 1; ; attempt++) {
      try {
        const t = await credential.getToken(scope);
        if (!t) throw new Error(`Could not get a token for ${resource}.`);
        cache.set(resource, { token: t.token, expiresOn: t.expiresOnTimestamp });
        return t.token;
      } catch (err) {
        if (attempt >= TOKEN_ATTEMPTS || !isTransientNetworkError(err)) throw err;
        const wait = Math.min(TOKEN_RETRY_MS * 2 ** (attempt - 1), 30_000);
        opts.debug?.(`Network error getting a token for ${resource}; trying again in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  };
}

/**
 * Reads claims from a JWT without verifying it (we only need tid/oid/upn for display and routing).
 * @param {string} token
 * @returns {Record<string, any>}
 */
export function decodeJwt(token) {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}
