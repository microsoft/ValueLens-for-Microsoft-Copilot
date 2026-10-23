// @ts-check
/**
 * The install record, `valuelens-install.json`. It holds IDs and choices so a
 * re-run picks up where the last one stopped. It never holds a secret.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normaliseModules } from './catalog.js';
import { normaliseReporting } from './currency.js';
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
 * @property {import('./currency.js').ReportingConfig} [reporting]  The currency the Value page reports in until one is saved in the app. Asked for when absent.
 * @property {{ frequency: 'daily' | 'weekly', time: string, weekday: string, timeZone: string }} schedule
 * @property {{ appId?: string, objectId?: string, servicePrincipalId?: string, displayName?: string, secretExpires?: string, secretKeyId?: string, retiredSecretKeyIds?: string[], pendingSecretKeyIds?: string[], secretAttempts?: { ref: string, at: string }[], existing?: boolean, adminPack?: string, secretDays?: number }} app  pendingSecretKeyIds: notebook secrets created by a run that hadn't finished writing them. secretAttempts: notebook secrets asked of Entra whose key ID isn't saved yet; the ref is in the secret's name. secretDays: how long a secret kept in the notebooks lasts (--secret-days). 90 when absent.
 * @property {{ subscriptionId?: string, resourceGroup?: string, name?: string, id?: string, uri?: string, location?: string, secretName: string, existing?: boolean, rbac?: boolean, private?: boolean, secretSetAt?: string, mode?: SecretMode, handoff?: SecretHandoff } & import('./steps/secrets.js').SecretSlot} keyVault  The secret* fields track the app secrets made for the vault (see steps/secrets.js); previousSecretKeyIds are replaced ones left on the app until they expire.
 * @property {{ capacityId?: string, workspaceId?: string, workspaceName?: string, lakehouseId?: string, lakehouseName?: string, notebooks: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookNames?: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookHashes?: Partial<Record<import('./catalog.js').NotebookKey, string>>, pipelineId?: string, pipelineName?: string, pipelineModules?: string, pipelineVersion?: number, scheduleId?: string, vaultEndpointId?: string, deployedRouter?: string, secretInNotebooks?: boolean, createdWorkspace?: boolean, pendingItems?: Record<string, { name: string, ref: string, at?: string, operation?: string }>, transcriptAccess?: FabricTranscriptAccess[] }} fabric  pendingItems: the name and description ref of each item being created, and when, so a run stopped mid-create finds that item again and nothing else. operation: Fabric's URL for the create once it accepted it, to ask how it went. transcriptAccess: each Dataverse environment where the installer gave the app the role that reads every transcript.
 * @property {{ jobId?: string, status?: string, startedAt?: string, finishedAt?: string, coworkSkipped?: boolean }} [firstRun]  coworkSkipped: the first load left out the Cowork Dataflow, which wasn't signed in yet.
 * @property {SemanticModelConfig} semanticModel
 * @property {FabricAppConfig} fabricApp
 * @property {AzureConfig} [azure]
 * @property {AccessConfig} [access]  Who can view Analytics Hub. Absent until the installer has set it up.
 * @property {ConsumptionConfig} consumption
 * @property {AgentEvaluatorConfig} agentEvaluator
 * @property {ResourceGraphConfig} resourceGraph
 * @property {DataAgentConfig} dataAgent
 * @property {{ completed: string[], runFirstLoad?: boolean, reloadHistoryDays?: number, baseRevision?: string, approved?: boolean, uploads?: { token?: string, name: string }[] }} [setup] Browser setup draft progress; never contains secrets. runFirstLoad and reloadHistoryDays are kept only in the draft, never in the install record.
 */

/**
 * Agent configuration and Foundry from Azure Resource Graph.
 * @typedef {object} ResourceGraphConfig
 * @property {string} [managementGroup]  The management group to read. Empty: the tenant root group.
 * @property {boolean} agents  Read Copilot Studio agents, environments and agent flows.
 * @property {boolean} foundry  Read Foundry resources and projects.
 * @property {boolean} [access]  The app has Reader on the management group.
 * @property {boolean} [azureAccess]  The jobs' managed identity has Reader on the management group.
 * @property {string} [roleAssigned]  The Entra role the installer gave the app so Resource Graph returns agents, e.g. Global Reader.
 * @property {string} [azureRoleAssigned]  The same, for the jobs' managed identity.
 */

/**
 * The one Entra group whose members can view Analytics Hub, on either target.
 * @typedef {object} AccessConfig
 * @property {string} [groupId]
 * @property {string} [groupName]
 * @property {boolean} [createdGroup]  The installer created the group, rather than being given one.
 * @property {string} [contact]  Who people ask for access. Defaults to the installer.
 * @property {string} [requestUrl]  Optional link for access requests, e.g. a My Access package or a form.
 * @property {string[]} [grantedModels]  Semantic model IDs the group has Build (ReadExplore) on.
 * @property {boolean} [appShared]  The user said the Fabric app item is shared with the group. Fabric has no API to check.
 * @property {RlsConfig} [rls]  Org-scoped access (row-level security). Off when absent.
 */

/**
 * Org-scoped access. Opt-in: with it off the models have no roles, as before.
 * @typedef {object} RlsConfig
 * @property {boolean} enabled
 * @property {'department' | 'country'} [orgAttribute]  What an org scope matches. Defaults to department.
 * @property {string[]} [applied]  Models whose role members were applied since they were last deployed. A deploy drops members.
 */

/**
 * Where the app's client secret lives and who puts it there.
 * - `keyvault`: the installer writes it to Key Vault (the default when absent).
 * - `keyvault-admin`: a vault admin writes it to Key Vault; the user only needs read access.
 * - `notebook`: no Key Vault. The installer writes it into the notebooks as plain text, where anyone
 *   with a role in the workspace can read it. It lasts 90 days by default and every install, repair
 *   or update replaces it.
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
 * Who the Power Automate flows write to OneLake as.
 *  - user: a person signs in to an HTTP with Microsoft Entra ID connection. No secret, no Key Vault.
 *  - app: the app registration, with its secret read from Key Vault by the Key Vault connector.
 * @typedef {'user' | 'app'} FlowIdentity
 */

/**
 * Who the flows write as. Azure installs always use the user: the managed identity has no secret
 * for a flow to sign in with.
 * @param {InstallConfig} config @returns {FlowIdentity}
 */
export const flowIdentity = (config) => (config.target !== 'azure' && config.uploads?.flowIdentity === 'app' ? 'app' : 'user');

/**
 * The upload drop folder and the optional extras around it.
 * @typedef {object} UploadsConfig
 * @property {boolean} [folders]  The drop folder and the folders the loads read exist in the Lakehouse.
 * @property {FlowIdentity} [flowIdentity]  Who the flows write to OneLake as. Default user.
 * @property {FlowEnvironment} [flowEnvironment]  The Power Platform environment the flows are created in.
 * @property {Partial<Record<'feedback' | 'studio' | 'agents', string>>} [flowIds]  The flows, once created.
 * @property {Partial<Record<'feedback' | 'studio' | 'agents', string>>} [flowSignatures]  What each created flow was built from.
 * @property {Partial<Record<'feedback' | 'studio' | 'agents', string>>} [flowFiles]  Where a flow was written when it couldn't be created.
 * @property {Record<string, string>} [flowConnections]  The connections the installer made for the flows, by connection reference.
 * @property {Partial<Record<'feedback' | 'studio' | 'agents', string>>} [flowsConnected]  The flow IDs the installer signed in and turned on.
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
 * @property {ModelReload} [reload]  Owed a reload: its definition was, or may have been, replaced and no refresh has finished since.
 * @property {ReportConfig} [report]  The report published on the model.
 */

/**
 * Recorded before a request that can change a model's definition; taken back only once the
 * installer's own whole-model refresh, requested after the change settled, finishes cleanly.
 * @typedef {object} ModelReload
 * @property {string} since  When the change last settled, or, while `unsettled`, when the request was made.
 * @property {boolean} [cleared]  Fabric was allowed to clear its data, so it shows nothing until then.
 * @property {boolean} [unsettled]  The request may or may not have changed the model; the next run applies it again before reloading.
 * @property {string} [ours]  The whole-model refresh the installer requested after the change settled, which can be its reload. Cleared when it ends badly.
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
 * @property {boolean} [access]  The app is an application user there with the Bot Transcript Viewer role. On Azure, the jobs' managed identity is.
 *   That role alone reads only the transcripts shared with it, so the transcripts are read in full only with `readAll`.
 * @property {boolean} [readAll]  It also holds the role the installer creates there to read every transcript, or you said it reads them all.
 *   Absent on installs from before that role, so Update or Repair gives it.
 * @property {string} [accessAppId]  Azure only: the client ID that `access` was found for, so that a new managed identity is checked again.
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
 * @property {{ ref: string, at: string }[]} [secretAttempts]  Connection secrets asked of Entra, key ID not saved yet (see steps/secrets.js).
 * @property {string[]} [pendingSecretKeyIds]  Connection secrets made but not yet confirmed in use.
 * @property {string[]} [retiredSecretKeyIds]  Replaced connection secrets still to remove from the app.
 * @property {boolean} [bound]
 * @property {ModelReload} [reload]  Owed a reload: its definition was, or may have been, replaced and no refresh has finished since.
 * @property {boolean} [reports]  Publish the Power BI reports on the models. Records from before the choice was offered leave it unset, meaning no.
 * @property {ReportConfig} [report]  The ValueLens report.
 */

/**
 * The Fabric data agent behind the app's Ask page.
 * @typedef {object} DataAgentConfig
 * @property {boolean} [enabled]  Create it. Unset means yes, on a capacity that runs data agents.
 * @property {string} [id]
 * @property {string} name
 * @property {boolean} [capacityOk]  The workspace's capacity runs data agents (paid F or P), as of the last plan.
 * @property {string} [signature]  What the deployed definition was built from.
 * @property {string} [publishedSignature]  The definition last published.
 */

/**
 * The ValueLens web app (Fabric App item) from `app`.
 * @typedef {object} FabricAppConfig
 * @property {boolean} [enabled]
 * @property {string} [itemId]
 * @property {string} [name]
 * @property {string} [url]
 * @property {string} [profile]
 * @property {string[]} [models]  Model aliases the app was built with. Older records mean just "vl".
 * @property {string} [deployedAt]
 * @property {string} [installerVersion]  The installer version that last deployed the app, so another version offers to
 *   deploy it again. Records from before 0.6.8 have none.
 * @property {import('./currency.js').ReportingConfig} [reporting]  The Value page currency a prebuilt app was deployed with.
 * @property {Record<string, string | boolean>} [access]  The viewer access the app was deployed with, so a change offers a redeploy.
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
 * @property {boolean} [sqlFreeOffer] false once Azure turned down the Azure SQL free offer for a new database, which then uses the usual serverless price. Unset = ask for it.
 * @property {boolean} [sqlScaleUp] A large tenant chose to pay for Azure SQL beyond the free offer: more vCores, and carrying on past the free allowance. Unset = no.
 * @property {boolean} [webAlwaysOn] A large tenant chose to pay to keep one web app replica running, so the first visit doesn't wait. Unset = no.
 * @property {string} [namePrefix]
 * @property {string} [installId]
 * @property {Record<string, string>} [tags]
 * @property {'new' | 'existing'} [resourceGroupMode]
 * @property {boolean} [publicNetworkAccess]
 * @property {{ mode: 'create' | 'existing' | 'none', resourceGroupId?: string }} [privateDns] Private networking: create the privatelink DNS zones, use existing ones (in resourceGroupId), or leave DNS to Azure Policy. Unset = create.
 * @property {boolean} [sampleData] Demo mode: the run job publishes the bundled synthetic sample instead of tenant data.
 * @property {'new' | 'existing'} [workspaceMode]
 * @property {string} [workspaceName]
 * @property {string} [imageTag]
 * @property {{ registry?: string, registryResourceId?: string, tag?: string }} [images] Optional image source override:
 *   a private registry (e.g. `myacr.azurecr.io/valuelens`), its ARM resource ID for AcrPull, and a pinned tag.
 * @property {any[]} [deployments]
 * @property {{ subscriptionId?: string, resourceGroup?: string, namePrefix?: string, location?: string, sqlLocation?: string, publicNetworkAccess?: boolean }} [deploymentConfig] Placement recorded once its resource group exists, before the first ARM attempt, including attempts that return no outputs.
 * @property {Record<string, any>} [outputs]
 * @property {{ clientId?: string, objectId?: string, servicePrincipalId?: string, created?: boolean, appIdUri?: string }} [webApp]
 * @property {{ clientId?: string, objectId?: string, servicePrincipalId?: string, secretKeyId?: string, secretExpiry?: string, created?: boolean, secretAttempts?: { ref: string, at: string }[], pendingSecretKeyIds?: string[], retiredSecretKeyIds?: string[] }} [sqlReader]  The secret* fields track its app secrets (see steps/secrets.js).
 * @property {{ workspaceId?: string, createdWorkspace?: boolean, datasetId?: string, consumptionDatasetId?: string, agentEvaluatorDatasetId?: string, capacityId?: string, sharedCapacity?: boolean, gatewayId?: string, createdGateway?: boolean, connectionId?: string, accessNotebookId?: string }} [powerBi]
 *   `capacityId` hosts the workspace (semantic model definition APIs need a Fabric/Premium capacity) and, in private
 *   networking mode, the VNet data gateway `gatewayId` whose SQL connection `connectionId` the model is bound to.
 *   `sharedCapacity` records that None (shared capacity, Pro) was chosen instead, so Repair offers it again. Records
 *   from before 0.6.8 don't have it: one with a `workspaceId` and no `capacityId` chose None.
 *   `consumptionDatasetId` is the Consumption model, deployed with credit consumption.
 *   `agentEvaluatorDatasetId` is the Agent Evaluator model, deployed with Agent Evaluator.
 * @property {AzureDrop} [drop] Private networking with credit consumption or a CSV export (Agent 365, product feedback, Workday): the SharePoint folder the Studio flow and CSV uploads land in.
 * @property {boolean} [storageRole] The installer gave the signed-in user Storage Blob Data Contributor on the landing container, for the Studio flow and CSV uploads.
 * @property {{ assigned: string[], pending: string[] }} [graphRoles]
 * @property {string} [teamsPackage]
 * @property {{ id: string, externalId: string, version: string, sha256: string, publishedAt: string }} [teamsApp]  The Teams app the installer
 *   published to the org's app catalog: its catalog ID, the manifest's ID (the web app's client ID), and the package's version and hash.
 * @property {AzureAskConfig} [ask] The model the web app's Ask answers with. Absent on installs from before Ask, which leaves it off.
 * @property {AzureTranscriptAccess[]} [transcriptAccess] Each Dataverse environment where the jobs' managed identity was
 *   found or given access, and what the installer added there, so that unticking the environment or uninstalling removes only that.
 * @property {{ whatIf?: any[], pendingAdminActions?: string[], lastRun?: any, lastMigrate?: any, lastAccess?: any }} [status]
 */

/**
 * Ask on Azure: an Azure OpenAI model the installer creates, one that already exists, or none.
 * @typedef {object} AzureAskConfig
 * @property {'create' | 'existing' | 'off'} mode
 * @property {string} [location] create: region of the AI Services account.
 * @property {string} [sku] create: GlobalStandard or DataZoneStandard.
 * @property {number} [capacity] create: thousands of tokens a minute.
 * @property {string} [deployment] The model deployment's name.
 * @property {string} [endpoint] existing: the account's endpoint.
 * @property {string} [accountId] existing: the account's ARM resource ID, when it was picked from a list.
 * @property {boolean} [granted] existing: the web app's managed identity has Cognitive Services OpenAI User on it.
 */

/**
 * One Dataverse environment where the Azure jobs' managed identity was found or given access to transcripts, and what
 * the installer added there. With neither `createdUser` nor `roleId`, an admin added it, so the installer leaves it.
 * @typedef {object} AzureTranscriptAccess
 * @property {string} url  The environment's Dataverse org URL.
 * @property {string} appId  The managed identity's client ID.
 * @property {string} [name]  The environment's name, for messages once it's no longer chosen.
 * @property {string} [userId]  Its application user (systemuserid). Absent when an admin said it already has access.
 * @property {boolean} [createdUser]  The installer created the application user, so it deletes it again.
 * @property {string} [roleId]  The Bot Transcript Viewer role the installer assigned, so it removes it again.
 * @property {string} [readRoleId]  The role that reads every transcript, in the environment's root business unit.
 * @property {string} [readRoleName]
 * @property {boolean} [createdReadRole]  The installer created that role, so it deletes it again. One that only shares its name is left.
 * @property {string} [assignedReadRoleId]  The copy of it, in the reader's business unit, that the installer gave the reader, so it takes it away again.
 */

/**
 * One Dataverse environment where the installer gave the Fabric app the role that reads every transcript, so that
 * unticking the environment, the module or uninstalling removes only that. The app's application user and its Bot
 * Transcript Viewer role stay, as they always have on Fabric.
 * @typedef {object} FabricTranscriptAccess
 * @property {string} url  The environment's Dataverse org URL.
 * @property {string} appId  The app's client ID.
 * @property {string} [name]  The environment's name, for messages once it's no longer chosen.
 * @property {string} [userId]  The app's application user there.
 * @property {string} [readRoleId]  The role, in the environment's root business unit.
 * @property {string} [readRoleName]
 * @property {boolean} [createdReadRole]  The installer created the role, so it deletes it again.
 * @property {string} [assignedReadRoleId]  The copy of it, in the app user's business unit, that the installer gave the app.
 */

/**
 * A SharePoint folder the Azure jobs read landing files from, for installs whose storage takes no public traffic.
 * @typedef {object} AzureDrop
 * @property {string} folderUrl  The folder as the user gave it, e.g. https://contoso.sharepoint.com/sites/Analytics/Shared Documents/ValueLens.
 * @property {string} [siteUrl]  The site, for the flow's SharePoint connector.
 * @property {string} [sitePath]  The folder's path under the site, e.g. /Shared Documents/ValueLens, for the flow.
 * @property {string} [siteId]  For the jobs: a Graph site ID, or the path form contoso.sharepoint.com:/sites/Analytics.
 * @property {string} [driveId]  Graph drive ID. Empty when drivePath starts with the library's name.
 * @property {string} [drivePath]  The folder for the jobs: under the drive's root, or library/folder when driveId is empty.
 * @property {boolean} [granted]  The managed identity has read on the site (Sites.Selected).
 */

// Names for items a new install creates. An existing install keeps the names saved in its record.
export const MODEL_NAME = 'Analytics Hub Model';
export const CONSUMPTION_MODEL_NAME = 'Analytics Hub Consumption Model';
export const AGENT_EVALUATOR_MODEL_NAME = 'Analytics Hub Agent Evaluator Model';
export const REPORT_NAME = 'ValueLens';
export const CONSUMPTION_REPORT_NAME = 'Consumption Central';
export const AGENT_EVALUATOR_REPORT_NAME = 'Agent Evaluator';
export const DATA_AGENT_NAME = 'Analytics Hub Ask';

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
    resourceGraph: { managementGroup: '', agents: true, foundry: true },
    dataAgent: { name: DATA_AGENT_NAME },
  };
}

/**
 * @param {string} file
 * @returns {{ config: InstallConfig, existed: boolean }}
 */
export function loadConfig(file) {
  if (!existsSync(file)) {
    const config = emptyConfig();
    remember(config, file, null, JSON.stringify(config));
    return { config, existed: false };
  }
  /** @type {string} */
  let text;
  /** @type {any} */
  let raw;
  try {
    text = readFileSync(file, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  const config = normaliseConfig(raw, file);
  remember(config, file, text, JSON.stringify(config));
  return { config, existed: true };
}

/**
 * A record as read from disk, with the defaults for anything it doesn't have yet.
 * @param {any} raw
 * @param {string} file
 * @returns {InstallConfig}
 */
function normaliseConfig(raw, file) {
  if (raw.version !== CONFIG_VERSION) throw new Error(`${file} has version ${raw.version}; this installer reads version ${CONFIG_VERSION}.`);
  const base = emptyConfig();
  /** @type {InstallConfig} */
  const config = {
    ...base,
    ...raw,
    target: raw.target ?? 'fabric',
    modules: normaliseModules(raw.modules),
    dataSources: normaliseDataSources(raw.dataSources, normaliseModules(raw.modules), raw.consumption, raw.uploads),
    // studioFlow and feedbackFlow are read once, above: each flow is now its source's api mode.
    uploads: Object.fromEntries(Object.entries(raw.uploads ?? {}).filter(([k]) => k !== 'studioFlow' && k !== 'feedbackFlow')),
    history: { ...base.history, ...(raw.history ?? {}) },
    reporting: normaliseReporting(raw.reporting),
    schedule: { ...base.schedule, ...(raw.schedule ?? {}) },
    app: { ...(raw.app ?? {}) },
    keyVault: { ...base.keyVault, ...(raw.keyVault ?? {}) },
    fabric: { ...base.fabric, ...(raw.fabric ?? {}), notebooks: { ...(raw.fabric?.notebooks ?? {}) } },
    semanticModel: { ...base.semanticModel, ...(raw.semanticModel ?? {}) },
    fabricApp: { ...(raw.fabricApp ?? {}) },
    ...(raw.access
      ? {
          access: {
            ...raw.access,
            grantedModels: [...(raw.access.grantedModels ?? [])],
            ...(raw.access.rls ? { rls: { ...raw.access.rls, applied: Array.isArray(raw.access.rls.applied) ? [...raw.access.rls.applied] : [] } } : {}),
          },
        }
      : {}),
    azure: {
      ...base.azure,
      ...(raw.azure ?? {}),
      tags: { ...(raw.azure?.tags ?? {}) },
      deployments: [...(raw.azure?.deployments ?? [])],
      outputs: { ...(raw.azure?.outputs ?? {}) },
      ...(raw.azure?.webApp ? { webApp: { ...raw.azure.webApp } } : {}),
      ...(raw.azure?.sqlReader ? { sqlReader: { ...raw.azure.sqlReader } } : {}),
      ...(raw.azure?.powerBi ? { powerBi: { ...raw.azure.powerBi } } : {}),
      ...(raw.azure?.drop ? { drop: { ...raw.azure.drop } } : {}),
      graphRoles: { assigned: [...(raw.azure?.graphRoles?.assigned ?? [])], pending: [...(raw.azure?.graphRoles?.pending ?? [])] },
      ...(raw.azure?.status ? { status: { ...raw.azure.status } } : {}),
    },
    consumption: { ...(raw.consumption ?? {}), model: { ...base.consumption.model, ...(raw.consumption?.model ?? {}) } },
    agentEvaluator: {
      ...(raw.agentEvaluator ?? {}),
      environments: [...(raw.agentEvaluator?.environments ?? [])],
      model: { ...base.agentEvaluator.model, ...(raw.agentEvaluator?.model ?? {}) },
    },
    resourceGraph: normaliseResourceGraph(raw.resourceGraph),
    dataAgent: { ...base.dataAgent, ...(raw.dataAgent ?? {}) },
  };
  if (!config.reporting) delete config.reporting;
  assertNoSecrets(config);
  return config;
}

/**
 * For each record loadConfig returned, by file: the text it last read or wrote there (null when there was
 * no file), and the record as it stood then. Another command can write the record meanwhile, such as
 * deploy-app while an install waits hours for its first load; saveConfig merges what it changed.
 * @type {WeakMap<object, Map<string, { read: string | null, base: string }>>}
 */
const lastSeen = new WeakMap();

/** @param {object} config @param {string} file @param {string | null} read @param {string} base */
function remember(config, file, read, base) {
  let files = lastSeen.get(config);
  if (!files) lastSeen.set(config, (files = new Map()));
  files.set(resolve(file), { read, base });
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A three-way merge, field by field: each side keeps what only it changed since `base`. When both changed
 * the same field to different values, `ours` wins, as the later save. A field one side removed and the
 * other left alone stays removed. Lists are merged whole.
 * @param {any} base
 * @param {any} ours
 * @param {any} theirs
 * @returns {any}
 */
function mergeRecord(base, ours, theirs) {
  if (isDeepStrictEqual(ours, base)) return theirs;
  if (isDeepStrictEqual(theirs, base) || isDeepStrictEqual(ours, theirs)) return ours;
  if (!isRecord(ours) || !isRecord(theirs)) return ours;
  const was = isRecord(base) ? base : {};
  /** @type {Record<string, any>} */
  const merged = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = mergeRecord(was[key], ours[key], theirs[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Brings the record in memory up to date with what was saved, changing only the fields the merge changed,
 * in place, so code holding part of it (a `const app = config.fabricApp`, say) sees them too.
 * @param {Record<string, any>} live
 * @param {Record<string, any>} ours  What `live` held, as JSON.
 * @param {Record<string, any>} merged
 */
function adopt(live, ours, merged) {
  for (const key of Object.keys(ours)) if (!Object.hasOwn(merged, key)) delete live[key];
  for (const [key, value] of Object.entries(merged)) {
    if (isDeepStrictEqual(value, ours[key])) continue;
    const held = live[key];
    if (isRecord(value) && isRecord(ours[key]) && isRecord(held)) adopt(held, ours[key], value);
    else if (Array.isArray(value) && Array.isArray(held)) held.splice(0, held.length, ...value);
    else live[key] = value;
  }
}

/**
 * What to save when another command has written the record since `config` last read or wrote it: both
 * sets of changes, merged. Undefined when nobody else has written it, or what's there can't be read as a
 * record, so the save writes `config` as it is.
 * @param {string} file
 * @param {InstallConfig} config
 * @param {{ read: string | null, base: string }} last
 * @param {(ms: number) => void} wait
 * @returns {{ ours: Record<string, any>, merged: Record<string, any> } | undefined}
 */
function mergeTheirs(file, config, last, wait) {
  for (let attempt = 1; ; attempt++) {
    /** @type {any} */
    let theirs;
    try {
      const disk = readFileSync(file, 'utf8');
      if (disk === last.read) return undefined;
      theirs = JSON.parse(disk);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return undefined;
      // Half-written or held open: the other command may be writing it in place (see saveConfig). Give it
      // a moment; if it still can't be read, this command's own changes are saved rather than lost.
      if (attempt >= 3) return undefined;
      wait(100 * attempt);
      continue;
    }
    try {
      theirs = JSON.parse(JSON.stringify(normaliseConfig(theirs, file)));
    } catch {
      return undefined;
    }
    const ours = JSON.parse(JSON.stringify(config));
    return { ours, merged: mergeRecord(JSON.parse(last.base), ours, theirs) };
  }
}

/**
 * Fills the gaps in a saved Resource Graph choice: both kinds on, the tenant root group.
 * @param {any} raw
 * @returns {ResourceGraphConfig}
 */
export function normaliseResourceGraph(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    ...r,
    managementGroup: typeof r.managementGroup === 'string' ? r.managementGroup.trim() : '',
    agents: r.agents !== false,
    foundry: r.foundry !== false,
  };
}

/** Errors Windows gives while a sync client, indexer or antivirus briefly holds the file open. */
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes atomically so an interrupted run never leaves a half-written file.
 * In a OneDrive-synced folder the rename can fail for a moment while the file
 * is being synced, so it's retried. If it still fails, the record is written
 * in place so the run's progress isn't lost. Either way it is read back, so a
 * step is only counted as done once its record is really on disk.
 * For a record from loadConfig, another command may have saved the same file
 * since this one last read or wrote it (deploy-app while an install waits on
 * its first load): their changes are merged in, field by field, and the record
 * in memory gets them too.
 * @param {string} file
 * @param {InstallConfig} config
 * @param {{ rename?: (from: string, to: string) => void, wait?: (ms: number) => void, tries?: number, read?: (file: string) => string }} [io]
 */
export function saveConfig(file, config, io = {}) {
  assertNoSecrets(config);
  const { rename = renameSync, wait = pause, tries = 8, read = (/** @type {string} */ f) => readFileSync(f, 'utf8') } = io;
  const last = lastSeen.get(config)?.get(resolve(file));
  const merge = last ? mergeTheirs(file, config, last, wait) : undefined;
  if (merge) assertNoSecrets(merge.merged);
  const text = `${JSON.stringify(merge ? merge.merged : config, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  let renamed = false;
  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, file);
      renamed = true;
      break;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
      if (!LOCKED.has(code)) throw err;
      if (attempt >= tries) break;
      wait(Math.min(100 * attempt, 500));
    }
  }
  if (!renamed) {
    writeFileSync(file, text, 'utf8');
    try {
      unlinkSync(tmp);
    } catch {
      // A leftover .tmp is harmless; the next save overwrites it.
    }
  }
  if (read(file) !== text) {
    throw new Error(`The install record ${file} didn't save: it reads back different from what was written. Check the folder isn't read-only or full, then run the installer again.`);
  }
  if (!last) return;
  if (merge) adopt(config, merge.ours, merge.merged);
  remember(config, file, text, text);
}

/**
 * Sets an install record aside so the next install starts fresh. It's renamed beside itself, as
 * `valuelens-install.<yyyyMMdd-HHmmss>.json`, so nothing in it is lost.
 * A synced folder can hold the file for a moment, so the rename is retried like saveConfig's.
 * @param {string} file
 * @param {Date} [now]
 * @param {{ rename?: (from: string, to: string) => void, wait?: (ms: number) => void, tries?: number }} [io]
 * @returns {string} where the record went
 */
export function archiveConfig(file, now = new Date(), io = {}) {
  const { rename = renameSync, wait = pause, tries = 8 } = io;
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const base = file.replace(/\.json$/i, '');
  let to = `${base}.${stamp}.json`;
  for (let i = 2; existsSync(to); i++) to = `${base}.${stamp}-${i}.json`;
  retryLocked(() => rename(file, to), wait, tries);
  return to;
}

/**
 * Deletes a file, retrying while a sync client, indexer or antivirus holds it.
 * @param {string} file
 * @param {{ unlink?: (file: string) => void, wait?: (ms: number) => void, tries?: number }} [io]
 * @returns {boolean} false if it is still locked; the caller can leave it for the next run
 */
export function removeFile(file, io = {}) {
  const { unlink = unlinkSync, wait = pause, tries = 8 } = io;
  try {
    retryLocked(() => unlink(file), wait, tries);
    return true;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
    if (code === 'ENOENT') return true;
    if (LOCKED.has(code)) return false;
    throw err;
  }
}

/** @param {() => void} fn @param {(ms: number) => void} wait @param {number} tries */
function retryLocked(fn, wait, tries) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
      if (!LOCKED.has(code) || attempt >= tries) throw err;
      wait(Math.min(100 * attempt, 500));
    }
  }
}

/** @param {unknown} config */
function assertNoSecrets(config) {
  const text = JSON.stringify(config);
  if (/"(secret|secretText|clientSecret|password)"\s*:/i.test(text)) {
    throw new Error('Refusing to keep a secret in the install record.');
  }
}
