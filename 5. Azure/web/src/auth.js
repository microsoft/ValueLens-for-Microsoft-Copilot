import { readFile } from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ManagedIdentityCredential } from '@azure/identity';
import { ConfidentialClientApplication } from '@azure/msal-node';

const USER_ROLE = 'AnalyticsHub.User';
const ADMIN_ROLE = 'AnalyticsHub.Admin';

export function parseBearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || '');
  return match?.[1] || null;
}

export function createJwtVerifier(config) {
  const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`));
  const issuers = [`https://login.microsoftonline.com/${config.tenantId}/v2.0`, `https://sts.windows.net/${config.tenantId}/`];
  const audiences = [config.appIdUri, config.webClientId].filter(Boolean);
  return async function verifyToken(token) {
    const { payload } = await jwtVerify(token, jwks, { issuer: issuers, audience: audiences });
    return payload;
  };
}

export function hasAccessScope(claims) { return String(claims.scp || '').split(/\s+/).includes('access_as_user'); }
export function getRoles(claims) { return (Array.isArray(claims.roles) ? claims.roles : []).map(String); }
export function hasUserRole(claims) { const roles = getRoles(claims); return roles.includes(USER_ROLE) || roles.includes(ADMIN_ROLE); }
export function hasAdminRole(claims) { return getRoles(claims).includes(ADMIN_ROLE); }
export function userIdFromClaims(claims) { return String(claims.oid || claims.sub || claims.preferred_username || claims.upn || 'unknown'); }
export function userNameFromClaims(claims) { return String(claims.preferred_username || claims.upn || claims.name || userIdFromClaims(claims)); }

export function createOboTokenAcquirer(config) {
  const authority = `https://login.microsoftonline.com/${config.tenantId}`;
  const credential = config.azureClientId ? new ManagedIdentityCredential(config.azureClientId) : null;
  let certConfigPromise = null;
  async function getClientAssertion() {
    if (!credential) throw new Error('AZURE_CLIENT_ID is required for managed identity OBO');
    const token = await credential.getToken('api://AzureADTokenExchange/.default');
    if (!token?.token) throw new Error('Managed identity token acquisition failed');
    return token.token;
  }
  async function getCertificateConfig() {
    if (!config.webClientCertPath) return null;
    certConfigPromise ||= readFile(config.webClientCertPath, 'utf8').then((pem) => {
      const certMatch = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem);
      if (!certMatch) throw new Error('VALUELENS_WEB_CLIENT_CERT_PATH must contain a PEM certificate');
      const cert = new X509Certificate(certMatch[0]);
      return {
        privateKey: pem,
        thumbprintSha256: createHash('sha256').update(cert.raw).digest('hex').toUpperCase()
      };
    });
    return certConfigPromise;
  }
  return async function acquirePowerBiToken(userJwt) {
    const cert = await getCertificateConfig();
    const cca = new ConfidentialClientApplication({
      auth: cert
        ? { clientId: config.webClientId, authority, clientCertificate: cert }
        : { clientId: config.webClientId, authority, clientAssertion: getClientAssertion }
    });
    const result = await cca.acquireTokenOnBehalfOf({ oboAssertion: userJwt, scopes: ['https://analysis.windows.net/powerbi/api/.default'] });
    if (!result?.accessToken) throw new Error('Power BI OBO token acquisition failed');
    return result.accessToken;
  };
}
export { USER_ROLE, ADMIN_ROLE };
