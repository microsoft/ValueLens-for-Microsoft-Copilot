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
    version: env.VALUELENS_VERSION || '0.0.0',
    releasesUrl: env.VALUELENS_RELEASES_URL || 'https://api.github.com/repos/microsoft/ValueLens-for-Microsoft-Copilot/releases?per_page=20',
    settingsWriters: (env.VALUELENS_SETTINGS_WRITERS || 'admin').toLowerCase(),
    reporting: parseReporting(env.VALUELENS_CURRENCY, env.VALUELENS_EXCHANGE_RATE),
    azureClientId: env.AZURE_CLIENT_ID || '',
    publicDir: env.VALUELENS_PUBLIC_DIR || path.resolve('/app/public'),
    webClientCertPath: env.VALUELENS_WEB_CLIENT_CERT_PATH || ''
  };
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

export function isAllowedSemanticModel(semanticModels, workspaceId, itemId) {
  return Object.values(semanticModels).some((model) => {
    const configuredItemId = model?.itemId || model?.datasetId;
    return model?.workspaceId === workspaceId && configuredItemId === itemId;
  });
}
