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
};

/** @typedef {keyof typeof SCOPES} Resource */

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

/**
 * Caches a token per resource until five minutes before it expires.
 * @param {import('@azure/identity').TokenCredential} credential
 */
export function createTokenProvider(credential) {
  /** @type {Map<Resource, { token: string, expiresOn: number }>} */
  const cache = new Map();
  /** @param {Resource} resource */
  return async function getToken(resource) {
    const hit = cache.get(resource);
    if (hit && hit.expiresOn - Date.now() > 5 * 60_000) return hit.token;
    const t = await credential.getToken(SCOPES[resource]);
    if (!t) throw new Error(`Could not get a token for ${resource}.`);
    cache.set(resource, { token: t.token, expiresOn: t.expiresOnTimestamp });
    return t.token;
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
