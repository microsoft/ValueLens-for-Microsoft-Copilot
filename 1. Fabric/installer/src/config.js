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
 * @property {string} [tenantId]
 * @property {import('./catalog.js').ModuleChoice} modules
 * @property {{ days: number }} history
 * @property {{ frequency: 'daily' | 'weekly', time: string, weekday: string, timeZone: string }} schedule
 * @property {{ appId?: string, objectId?: string, servicePrincipalId?: string, displayName?: string, secretExpires?: string, existing?: boolean }} app
 * @property {{ subscriptionId?: string, resourceGroup?: string, name?: string, id?: string, uri?: string, location?: string, secretName: string, existing?: boolean, rbac?: boolean, private?: boolean, secretSetAt?: string }} keyVault
 * @property {{ capacityId?: string, workspaceId?: string, workspaceName?: string, lakehouseId?: string, lakehouseName?: string, notebooks: Partial<Record<import('./catalog.js').NotebookKey, string>>, pipelineId?: string, pipelineName?: string, pipelineModules?: string, scheduleId?: string, vaultEndpointId?: string }} fabric
 * @property {{ jobId?: string, status?: string, startedAt?: string, finishedAt?: string }} [firstRun]
 * @property {SemanticModelConfig} semanticModel
 * @property {FabricAppConfig} fabricApp
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
 * @property {boolean} [landing]  The landing folders exist.
 * @property {ModelConfig} model
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
 */

export const MODEL_NAME = 'ValueLens Model';
export const CONSUMPTION_MODEL_NAME = 'ValueLens Consumption Model';
export const AGENT_EVALUATOR_MODEL_NAME = 'ValueLens Agent Evaluator Model';

/** @returns {InstallConfig} */
export function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    modules: normaliseModules(undefined),
    history: { days: 90 },
    schedule: { frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'UTC' },
    app: {},
    keyVault: { secretName: 'valuelens-client-secret' },
    fabric: { notebooks: {} },
    semanticModel: { name: MODEL_NAME },
    fabricApp: {},
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
    modules: normaliseModules(raw.modules),
    history: { ...base.history, ...(raw.history ?? {}) },
    schedule: { ...base.schedule, ...(raw.schedule ?? {}) },
    app: { ...(raw.app ?? {}) },
    keyVault: { ...base.keyVault, ...(raw.keyVault ?? {}) },
    fabric: { ...base.fabric, ...(raw.fabric ?? {}), notebooks: { ...(raw.fabric?.notebooks ?? {}) } },
    semanticModel: { ...base.semanticModel, ...(raw.semanticModel ?? {}) },
    fabricApp: { ...(raw.fabricApp ?? {}) },
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
