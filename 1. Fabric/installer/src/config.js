// @ts-check
/**
 * The install record, `valuelens-install.json`. It holds IDs and choices so a
 * re-run picks up where the last one stopped. It never holds a secret.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normaliseModules } from './catalog.js';
import { normaliseDataSources } from './uploads.js';

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG_FILE = 'valuelens-install.json';

/**
 * @typedef {object} InstallConfig
 * @property {number} version
 * @property {'fabric' | 'azure'} [target]
 * @property {string} [tenantId]
 * @property {import('./catalog.js').ModuleChoice} modules  Follows `dataSources`.
 * @property {import('./uploads.js').DataSourceModes} dataSources  How each source arrives: API, uploaded CSV, or skipped.
 * @property {UploadsConfig} uploads
 * @property {{ days: number }} history
 * @property {import('./transform/pipeline.js').TenantScale} [scale]  How the loads are sized. Standard when absent.
 * @property {{ frequency: 'daily' | 'weekly', time: string, weekday: string, timeZone: string }} schedule
 * @property {{ appId?: string, objectId?: string, servicePrincipalId?: string, displayName?: string, secretExpires?: string, secretKeyId?: string, retiredSecretKeyIds?: string[], existing?: boolean, adminPack?: string }} app
 * @property {{ subscriptionId?: string, resourceGroup?: string, name?: string, id?: string, uri?: string, location?: string, secretName: string, existing?: boolean, rbac?: boolean, private?: boolean, secretSetAt?: string, mode?: SecretMode, handoff?: SecretHandoff }} keyVault
 * @property {{ capacityId?: string, workspaceId?: string, workspaceName?: string, lakehouseId?: string, lakehouseName?: string, notebooks: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookNames?: Partial<Record<import('./catalog.js').NotebookKey, string>>, pipelineId?: string, pipelineName?: string, pipelineModules?: string, pipelineVersion?: number, scheduleId?: string, vaultEndpointId?: string, deployedRouter?: string, secretInNotebooks?: boolean }} fabric
 * @property {{ jobId?: string, status?: string, startedAt?: string, finishedAt?: string }} [firstRun]
 * @property {SemanticModelConfig} semanticModel
 * @property {FabricAppConfig} fabricApp
 * @property {AzureConfig} [azure]
 * @property {ConsumptionConfig} consumption
 * @property {AgentEvaluatorConfig} agentEvaluator
 */

/**
 * Where the app's client secret lives and who puts it there.
 * - `keyvault`: the installer writes it to Key Vault (the default when absent).
 * - `keyvault-admin`: a vault admin writes it to Key Vault; the user only needs read access.
 * - `notebook`: the installer writes it into the notebooks as plain text. Not recommended.
 * @typedef {'keyvault' | 'keyvault-admin' | 'notebook'} SecretMode
 */

/**
 * The vault admin handoff. It never holds the secret value.
 * @typedef {object} SecretHandoff
 * @property {string} [shownAt]  When the admin steps were last shown.
 * @property {string} [adminEmail]  The admin who was added as an owner of the app, if any.
 * @property {string} [confirmedAt]  When the user said the admin had added the secret.
 * @property {boolean} [grantRead]  The user couldn't give themselves read access, so the admin is asked to.
 */

/** @param {InstallConfig} config @returns {SecretMode} */
export const secretMode = (config) => config.keyVault?.mode ?? 'keyvault';

/**
 * The upload drop folder and the optional extras around it.
 * @typedef {object} UploadsConfig
 * @property {boolean} [folders]  The drop folder and the folders the loads read exist in the Lakehouse.
 * @property {boolean} [feedbackFlow]  Create the product feedback email flow in Power Automate.
 * @property {boolean} [studioFlow]  Create the flow that saves Copilot Studio credits from the licensing API each day.
 * @property {FlowEnvironment} [flowEnvironment]  The Power Platform environment the flows are created in.
 * @property {Partial<Record<'feedback' | 'studio', string>>} [flowIds]  The flows, once created.
 * @property {Partial<Record<'feedback' | 'studio', string>>} [flowSignatures]  What each created flow was built from.
 * @property {Partial<Record<'feedback' | 'studio', string>>} [flowFiles]  Where a flow was written when it couldn't be created.
 */

/**
 * A Power Platform environment to create flows in.
 * @typedef {object} FlowEnvironment
 * @property {string} url  The Dataverse org URL, without a trailing slash.
 * @property {string} [id]  The Power Platform environment ID.
 * @property {string} [name]
 */

/**
 * A semantic model the installer deploys and refreshes.
 * @typedef {object} ModelConfig
 * @property {string} [id]
 * @property {string} name
 * @property {string} [signature]  What the deployed definition was built from.
 * @property {boolean} [bound]  Reads the Lakehouse through the installer's connection.
 * @property {ReportConfig} [report]  The report published on the model.
 */

/**
 * A Power BI report published from a template and bound to one of the installer's models.
 * @typedef {object} ReportConfig
 * @property {string} [id]
 * @property {string} name
 * @property {string} [signature]  A hash of the template's report files when it was published.
 * @property {string} [modelId]  The model it reads.
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
 * @property {string} [vivaPartition]  The Viva Insights partition the Cowork credits Dataflow reads.
 * @property {string} [vivaQuery]  The Viva Insights query it reads.
 * @property {string} [dataflowId]  The Cowork credits Dataflow.
 * @property {string} [dataflowName]
 * @property {string} [dataflowSignature]  What the deployed Dataflow definition was built from.
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
 * @property {boolean} [reports]  Publish the Power BI reports on the models. Records from before the choice was offered leave it unset, meaning no.
 * @property {ReportConfig} [report]  The ValueLens report.
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
 * @property {boolean} [sampleData] Demo mode: the run job publishes the bundled synthetic sample instead of tenant data.
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

// Names for items a new install creates. An existing install keeps the names saved in its record.
export const MODEL_NAME = 'Analytics Hub Model';
export const CONSUMPTION_MODEL_NAME = 'Analytics Hub Consumption Model';
export const AGENT_EVALUATOR_MODEL_NAME = 'Analytics Hub Agent Evaluator Model';
export const REPORT_NAME = 'ValueLens';
export const CONSUMPTION_REPORT_NAME = 'Consumption Central';
export const AGENT_EVALUATOR_REPORT_NAME = 'Agent Evaluator';

/** @returns {InstallConfig} */
export function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    target: 'fabric',
    modules: normaliseModules(undefined),
    dataSources: normaliseDataSources(undefined, normaliseModules(undefined)),
    uploads: {},
    history: { days: 30 },
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
    dataSources: normaliseDataSources(raw.dataSources, normaliseModules(raw.modules), raw.consumption),
    uploads: { ...(raw.uploads ?? {}) },
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
