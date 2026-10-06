// @ts-check
/**
 * The install record, `valuelens-install.json`. It holds IDs and choices so a
 * re-run picks up where the last one stopped. It never holds a secret.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normaliseModules } from './catalog.js';

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG_FILE = 'valuelens-install.json';

/**
 * @typedef {object} InstallConfig
 * @property {number} version
 * @property {'fabric' | 'azure'} [target]
 * @property {string} [tenantId]
 * @property {import('./catalog.js').ModuleChoice} modules
 * @property {{ days: number }} history
 * @property {{ frequency: 'daily' | 'weekly', time: string, weekday: string, timeZone: string }} schedule
 * @property {{ appId?: string, objectId?: string, servicePrincipalId?: string, displayName?: string, secretExpires?: string, existing?: boolean }} app
 * @property {{ subscriptionId?: string, resourceGroup?: string, name?: string, id?: string, uri?: string, location?: string, secretName: string, existing?: boolean, rbac?: boolean, private?: boolean, secretSetAt?: string }} keyVault
 * @property {{ capacityId?: string, workspaceId?: string, workspaceName?: string, lakehouseId?: string, lakehouseName?: string, notebooks: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookNames?: Partial<Record<import('./catalog.js').NotebookKey, string>>, pipelineId?: string, pipelineName?: string, pipelineModules?: string, scheduleId?: string, vaultEndpointId?: string }} fabric
 * @property {{ jobId?: string, status?: string, startedAt?: string, finishedAt?: string }} [firstRun]
 * @property {SemanticModelConfig} semanticModel
 * @property {FabricAppConfig} fabricApp
 * @property {AzureConfig} [azure]
 * @property {ConsumptionConfig} consumption
 * @property {AgentEvaluatorConfig} agentEvaluator
 */

/**
 * A semantic model the installer deploys and refreshes.
 * @typedef {object} ModelConfig
 * @property {string} [id]
 * @property {string} name
 * @property {string} [signature]  What the deployed definition was built from.
 * @property {boolean} [bound]  Reads the Lakehouse through the installer's connection.
 */

/**
 * The credit consumption module: Azure AI access, landing folders and the Consumption model.
 * @typedef {object} ConsumptionConfig
 * @property {string} [azureSubscriptionId]  Where the Azure AI resources are. Empty when Azure AI was left out.
 * @property {string} [azureSubscriptionName]
 * @property {boolean} [azureAccess]  The app has the Azure roles the notebook needs there.
 * @property {PaygSubscription[]} [paygSubscriptions]  Other subscriptions that billing policies charge Copilot pay-as-you-go to.
 * @property {string} [deployedPayg]  The pay-as-you-go subscriptions in the deployed Azure AI notebook, comma-separated.
 * @property {boolean} [landing]  The landing folders exist.
 * @property {ModelConfig} model
 */

/**
 * An Azure subscription that Power Platform billing policies charge Copilot Studio and Cowork pay-as-you-go to.
 * @typedef {object} PaygSubscription
 * @property {string} subscriptionId
 * @property {string} [name]
 * @property {string[]} policies  The billing policies' names.
 * @property {boolean} [access]  The app has Cost Management Reader there.
 */

/**
 * A Power Platform environment whose Copilot Studio transcripts the Agent Evaluator reads.
 * @typedef {object} AgentEnvironment
 * @property {string} url  The Dataverse org URL, without a trailing slash.
 * @property {string} [id]  The Power Platform environment ID.
 * @property {string} [name]
 * @property {boolean} [access]  The app is an application user there with the Bot Transcript Viewer role.
 */

/**
 * The Agent Evaluator module: the environments to read and the Agent Evaluator model.
 * @typedef {object} AgentEvaluatorConfig
 * @property {AgentEnvironment[]} environments
 * @property {string} [deployedUrls]  The environment URLs the deployed transcript notebook lists.
 * @property {ModelConfig} model
 */

/**
 * The semantic model built from `ValueLens - Fabric.pbit`, and the connection it reads the Lakehouse through.
 * @typedef {object} SemanticModelConfig
 * @property {boolean} [enabled]
 * @property {string} [id]
 * @property {string} name
 * @property {string} [server]  SQL analytics endpoint the model points at.
 * @property {string} [database]
 * @property {string} [signature]  What the deployed definition was built from.
 * @property {string} [connectionId]
 * @property {string} [connectionName]
 * @property {string} [secretKeyId]  The app secret that only the connection holds.
 * @property {string} [secretExpires]
 * @property {boolean} [bound]
 */

/**
 * The ValueLens web app (Fabric App item) from `1. Fabric/Fabric App`.
 * @typedef {object} FabricAppConfig
 * @property {boolean} [enabled]
 * @property {string} [itemId]
 * @property {string} [name]
 * @property {string} [url]
 * @property {string} [profile]
 * @property {string[]} [models]  Model aliases the app was built with. Older records mean just "vl".
 * @property {string} [deployedAt]
 * @property {{ deployments: any, env?: string }} [rayfin]  Rayfin's `.deployments.json` and `.env` for the prebuilt app, which each installer version unpacks afresh.
 */

/**
 * Azure target state. It holds choices and created resource IDs, but never secrets.
 * @typedef {object} AzureConfig
 * @property {string} [tenantId]
 * @property {string} [subscriptionId]
 * @property {string} [subscriptionName]
 * @property {string} [resourceGroup]
 * @property {boolean} [createdResourceGroup]
 * @property {string} [location]
 * @property {string} [sqlLocation] Region for Azure SQL when it differs from location (regional SQL capacity).
 * @property {string} [namePrefix]
 * @property {string} [installId]
 * @property {Record<string, string>} [tags]
 * @property {'new' | 'existing'} [resourceGroupMode]
 * @property {boolean} [publicNetworkAccess]
 * @property {'new' | 'existing'} [workspaceMode]
 * @property {string} [workspaceName]
 * @property {string} [imageTag]
 * @property {{ registry?: string, registryResourceId?: string, tag?: string }} [images] Optional image source override:
 *   a private registry (e.g. `myacr.azurecr.io/valuelens`), its ARM resource ID for AcrPull, and a pinned tag.
 * @property {any[]} [deployments]
 * @property {Record<string, any>} [outputs]
 * @property {{ clientId?: string, objectId?: string, servicePrincipalId?: string, created?: boolean, appIdUri?: string }} [webApp]
 * @property {{ clientId?: string, objectId?: string, servicePrincipalId?: string, secretKeyId?: string, secretExpiry?: string, created?: boolean }} [sqlReader]
 * @property {{ workspaceId?: string, createdWorkspace?: boolean, datasetId?: string, capacityId?: string, gatewayId?: string, createdGateway?: boolean, connectionId?: string }} [powerBi]
 *   `capacityId` hosts the workspace (semantic model definition APIs need a Fabric/Premium capacity) and, in private
 *   networking mode, the VNet data gateway `gatewayId` whose SQL connection `connectionId` the model is bound to.
 * @property {{ assigned: string[], pending: string[] }} [graphRoles]
 * @property {string} [teamsPackage]
 * @property {{ whatIf?: any[], pendingAdminActions?: string[], lastRun?: any, lastMigrate?: any }} [status]
 */

export const MODEL_NAME = 'ValueLens Model';
export const CONSUMPTION_MODEL_NAME = 'ValueLens Consumption Model';
export const AGENT_EVALUATOR_MODEL_NAME = 'ValueLens Agent Evaluator Model';

/** @returns {InstallConfig} */
export function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    target: 'fabric',
    modules: normaliseModules(undefined),
    history: { days: 90 },
    schedule: { frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'UTC' },
    app: {},
    keyVault: { secretName: 'valuelens-client-secret' },
    fabric: { notebooks: {} },
    semanticModel: { name: MODEL_NAME },
    fabricApp: {},
    azure: { tags: {}, deployments: [], outputs: {}, graphRoles: { assigned: [], pending: [] }, publicNetworkAccess: true, namePrefix: 'vlens' },
    consumption: { model: { name: CONSUMPTION_MODEL_NAME } },
    agentEvaluator: { environments: [], model: { name: AGENT_EVALUATOR_MODEL_NAME } },
  };
}

/**
 * @param {string} file
 * @returns {{ config: InstallConfig, existed: boolean }}
 */
export function loadConfig(file) {
  if (!existsSync(file)) return { config: emptyConfig(), existed: false };
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  if (raw.version !== CONFIG_VERSION) throw new Error(`${file} has version ${raw.version}; this installer reads version ${CONFIG_VERSION}.`);
  const base = emptyConfig();
  /** @type {InstallConfig} */
  const config = {
    ...base,
    ...raw,
    target: raw.target ?? 'fabric',
    modules: normaliseModules(raw.modules),
    history: { ...base.history, ...(raw.history ?? {}) },
    schedule: { ...base.schedule, ...(raw.schedule ?? {}) },
    app: { ...(raw.app ?? {}) },
    keyVault: { ...base.keyVault, ...(raw.keyVault ?? {}) },
    fabric: { ...base.fabric, ...(raw.fabric ?? {}), notebooks: { ...(raw.fabric?.notebooks ?? {}) } },
    semanticModel: { ...base.semanticModel, ...(raw.semanticModel ?? {}) },
    fabricApp: { ...(raw.fabricApp ?? {}) },
    azure: {
      ...base.azure,
      ...(raw.azure ?? {}),
      tags: { ...(raw.azure?.tags ?? {}) },
      deployments: [...(raw.azure?.deployments ?? [])],
      outputs: { ...(raw.azure?.outputs ?? {}) },
      ...(raw.azure?.webApp ? { webApp: { ...raw.azure.webApp } } : {}),
      ...(raw.azure?.sqlReader ? { sqlReader: { ...raw.azure.sqlReader } } : {}),
      ...(raw.azure?.powerBi ? { powerBi: { ...raw.azure.powerBi } } : {}),
      graphRoles: { assigned: [...(raw.azure?.graphRoles?.assigned ?? [])], pending: [...(raw.azure?.graphRoles?.pending ?? [])] },
      ...(raw.azure?.status ? { status: { ...raw.azure.status } } : {}),
    },
    consumption: { ...(raw.consumption ?? {}), model: { ...base.consumption.model, ...(raw.consumption?.model ?? {}) } },
    agentEvaluator: {
      ...(raw.agentEvaluator ?? {}),
      environments: [...(raw.agentEvaluator?.environments ?? [])],
      model: { ...base.agentEvaluator.model, ...(raw.agentEvaluator?.model ?? {}) },
    },
  };
  assertNoSecrets(config);
  return { config, existed: true };
}

/**
 * Writes atomically so an interrupted run never leaves a half-written file.
 * @param {string} file
 * @param {InstallConfig} config
 */
export function saveConfig(file, config) {
  assertNoSecrets(config);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** @param {unknown} config */
function assertNoSecrets(config) {
  const text = JSON.stringify(config);
  if (/"(secret|secretText|clientSecret|password)"\s*:/i.test(text)) {
    throw new Error('Refusing to keep a secret in the install record.');
  }
}
