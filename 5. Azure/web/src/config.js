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
    azureClientId: env.AZURE_CLIENT_ID || '',
    publicDir: env.VALUELENS_PUBLIC_DIR || path.resolve('/app/public'),
    webClientCertPath: env.VALUELENS_WEB_CLIENT_CERT_PATH || ''
  };
}

export function parseSemanticModels(value) {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('VALUELENS_SEMANTIC_MODELS must be a JSON object');
  return parsed;
}

export function isAllowedSemanticModel(semanticModels, workspaceId, itemId) {
  return Object.values(semanticModels).some((model) => {
    const configuredItemId = model?.itemId || model?.datasetId;
    return model?.workspaceId === workspaceId && configuredItemId === itemId;
  });
}
