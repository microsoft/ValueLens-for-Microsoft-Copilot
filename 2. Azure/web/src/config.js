import path from 'node:path';

export function loadConfig(env = process.env) {
  const semanticModels = parseSemanticModels(env.VALUELENS_SEMANTIC_MODELS);
  return {
    port: Number.parseInt(env.PORT || '8080', 10),
    tenantId: env.VALUELENS_TENANT_ID || '',
    webClientId: env.VALUELENS_WEB_CLIENT_ID || '',
    appIdUri: env.VALUELENS_APP_ID_URI || '',
    storageAccount: env.VALUELENS_STORAGE_ACCOUNT || '',
    semanticModels,
    access: parseAccess(env.VALUELENS_ACCESS),
    version: env.VALUELENS_VERSION || '0.0.0',
    releasesUrl: env.VALUELENS_RELEASES_URL || 'https://api.github.com/repos/microsoft/ValueLens-for-Microsoft-Copilot/releases?per_page=20',
    settingsWriters: (env.VALUELENS_SETTINGS_WRITERS || 'admin').toLowerCase(),
    reporting: parseReporting(env.VALUELENS_CURRENCY, env.VALUELENS_EXCHANGE_RATE),
    azureClientId: env.AZURE_CLIENT_ID || '',
    sqlServer: env.VALUELENS_SQL_SERVER || '',
    sqlDatabase: env.VALUELENS_SQL_DATABASE || '',
    publicDir: env.VALUELENS_PUBLIC_DIR || path.resolve('/app/public'),
    webClientCertPath: env.VALUELENS_WEB_CLIENT_CERT_PATH || '',
    ask: parseAsk(env.VALUELENS_ASK_ENDPOINT, env.VALUELENS_ASK_DEPLOYMENT),
    askDir: env.VALUELENS_ASK_DIR || ''
  };
}

/** Ask's Azure OpenAI endpoint and deployment; null, so Ask is off, unless both are set and the endpoint is https. */
export function parseAsk(endpoint, deployment) {
  const url = String(endpoint || '').trim();
  const name = String(deployment || '').trim();
  if (!name || !/^https:\/\/[^\s/]+/i.test(url)) return null;
  return { endpoint: url.replace(/\/+$/, ''), deployment: name };
}

/**
 * The reporting currency chosen at install, and its rate per US dollar. It
 * is only the default: a currency saved in the app's settings wins.
 */
export function parseReporting(currency, exchangeRate) {
  const code = String(currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return undefined;
  const rate = Number.parseFloat(String(exchangeRate ?? ''));
  return code !== 'USD' && Number.isFinite(rate) && rate > 0 ? { currency: code, exchangeRate: rate } : { currency: code };
}

export function parseSemanticModels(value) {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('VALUELENS_SEMANTIC_MODELS must be a JSON object');
  // The SPA queries the alias `vl`; early installs wrote `valueLensModel`.
  if (!parsed.vl && parsed.valueLensModel) {
    const { valueLensModel, ...rest } = parsed;
    return { vl: valueLensModel, ...rest };
  }
  return parsed;
}

/**
 * The viewer group and who to ask for access, written by the installer; null when there is no group.
 * `rlsOrgAttribute` is there only when org-scoped access (row-level security) is on.
 */
export function parseAccess(value) {
  if (!value) return null;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('VALUELENS_ACCESS must be a JSON object');
  if (typeof parsed.groupId !== 'string' || !parsed.groupId) return null;
  const pick = (key) => (typeof parsed[key] === 'string' && parsed[key] ? { [key]: parsed[key] } : {});
  return { groupId: parsed.groupId, ...pick('groupName'), ...pick('contact'), ...(/^https:\/\//i.test(parsed.requestUrl || '') ? { requestUrl: parsed.requestUrl } : {}), ...pick('rlsOrgAttribute') };
}

export function isAllowedSemanticModel(semanticModels, workspaceId, itemId) {
  return Object.values(semanticModels).some((model) => {
    const configuredItemId = model?.itemId || model?.datasetId;
    return model?.workspaceId === workspaceId && configuredItemId === itemId;
  });
}
