// @ts-check
/**
 * The install record, `valuelens-setup.json`. It holds IDs and choices so a
 * re-run picks up where the last one stopped. It never holds a secret.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normaliseModules } from './catalog.js';
import { normaliseReporting } from './currency.js';
import { PRODUCT } from './product.js';
import { normaliseDataSources } from './uploads.js';

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG_FILE = PRODUCT.recordFile;
/** The Analytics Hub installer's record, which this installer never reads or changes. */
export const AH_CONFIG_FILE = 'valuelens-install.json';
export const AH_RELEASES = 'https://github.com/microsoft/AnalyticsHub-Dashboard/releases';

/**
 * @typedef {object} InstallConfig
 * @property {string} product  Which installer the record belongs to: always PRODUCT.id.
 * @property {number} version
 * @property {'fabric' | 'pax'} [target]  The route: Fabric, or no Fabric (PAX + SharePoint). Fabric when absent.
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
 * @property {{ capacityId?: string, workspaceId?: string, workspaceName?: string, lakehouseId?: string, lakehouseName?: string, notebooks: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookNames?: Partial<Record<import('./catalog.js').NotebookKey, string>>, notebookHashes?: Partial<Record<import('./catalog.js').NotebookKey, string>>, pipelineId?: string, pipelineName?: string, pipelineModules?: string, pipelineVersion?: number, scheduleId?: string, vaultEndpointId?: string,  deployedRouter?: string, secretInNotebooks?: boolean, createdWorkspace?: boolean, pendingItems?: Record<string, { name: string, ref: string, at?: string, operation?: string }> }} fabric  pendingItems: the name and description ref of each item being created, and when, so a run stopped mid-create finds that item again and nothing else. operation: Fabric's URL for the create once it accepted it, to ask how it went.
  * @property {{ jobId?: string, status?: string, startedAt?: string, finishedAt?: string }} [firstRun]
  * @property {SemanticModelConfig} semanticModel
  * @property {AccessConfig} [access]  Who can view ValueLens. Absent until the installer has set it up.
  * @property {ResourceGraphConfig} resourceGraph
  * @property {SharePointConfig} [sharePoint]  The PAX route: the SharePoint folder the refresh writes to and the report reads.
  * @property {PaxConfig} [pax]  The PAX route: the scheduled refresh on this PC.
  * @property {PowerBiConfig} [powerBi]  The PAX route: how the report was published and is refreshed. Its workspace is in `fabric`.
  * @property {ManagedAppConfig} [managedApp]  The PAX route: the app, deployed as a Copilot Managed App and shared with the viewer group.
  * @property {{ completed: string[], runFirstLoad?: boolean, reloadHistoryDays?: number, baseRevision?: string, approved?: boolean, uploads?: { token?: string, name: string }[] }} [setup] Browser setup draft progress; never contains secrets. runFirstLoad and reloadHistoryDays are kept only in the draft, never in the install record.
 */

/**
 * Agent configuration and Foundry from Azure Resource Graph.
 * @typedef {object} ResourceGraphConfig
 * @property {string} [managementGroup]  The management group to read. Empty: the tenant root group.
 * @property {boolean} agents  Read Copilot Studio agents, environments and agent flows.
 * @property {boolean} foundry  Read Foundry resources and projects.
 * @property {boolean} [access]  The app has Reader on the management group.
 * @property {string} [roleAssigned]  The Entra role the installer gave the app so Resource Graph returns agents, e.g. Global Reader.
 */

/**
 * The one Entra group whose members can view ValueLens.
 * @typedef {object} AccessConfig
 * @property {string} [groupId]
 * @property {string} [groupName]
 * @property {boolean} [createdGroup]  The installer created the group, rather than being given one.
 * @property {string} [contact]  Who people ask for access. Defaults to the installer.
 * @property {string} [requestUrl]  Optional link for access requests, e.g. a My Access package or a form.
 * @property {string[]} [grantedModels]  Semantic model IDs the group has Build (ReadExplore) on.
 * @property {boolean} [reportShared]  The user said the report is shared with the group. Power BI has no API to check.
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

/** @param {InstallConfig} config @returns {FlowIdentity} */
export const flowIdentity = (config) => (config.uploads?.flowIdentity === 'app' ? 'app' : 'user');

/**
 * The upload drop folder and the optional extras around it.
 * @typedef {object} UploadsConfig
 * @property {boolean} [folders]  The drop folder and the folders the loads read exist in the Lakehouse.
 * @property {FlowIdentity} [flowIdentity]  Who the flows write to OneLake as. Default user.
 * @property {FlowEnvironment} [flowEnvironment]  The Power Platform environment the flows are created in.
 * @property {Partial<Record<'feedback' | 'agents', string>>} [flowIds]  The flows, once created.
 * @property {Partial<Record<'feedback' | 'agents', string>>} [flowSignatures]  What each created flow was built from.
 * @property {Partial<Record<'feedback' | 'agents', string>>} [flowFiles]  Where a flow was written when it couldn't be created.
 * @property {Record<string, string>} [flowConnections]  The connections the installer made for the flows, by connection reference.
 * @property {Partial<Record<'feedback' | 'agents', string>>} [flowsConnected]  The flow IDs the installer signed in and turned on.
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

// Names for items a new install creates. An existing install keeps the names saved in its record.
export const MODEL_NAME = PRODUCT.fabric.model;
export const REPORT_NAME = PRODUCT.fabric.report;

/**
 * The PAX route's SharePoint folder. The refresh writes its files there and the report reads them.
 * @typedef {object} SharePointConfig
 * @property {string} folderUrl  The folder's address, each part encoded, e.g. https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/ValueLens.
 * @property {string} siteUrl  The site's address, e.g. https://contoso.sharepoint.com/sites/Analytics.
 * @property {string} sitePath  Graph's path form of the site, e.g. contoso.sharepoint.com:/sites/Analytics, or the host for the root site.
 * @property {string} library  The document library's name in the address, e.g. Shared Documents.
 * @property {string} folderPath  The folder in the library, e.g. /ValueLens, or / for the library itself.
 * @property {string} [siteId]  Graph's ID for the site, once the installer could read it.
 * @property {boolean} [granted]  The PAX app can write to the site.
 * @property {string} [grantId]  The site permission the installer added, which uninstall removes.
 * @property {boolean} [pendingAdminGrant]  A SharePoint or Global Administrator still has to give the app write access to the site.
 * @property {RetiredGrant[]} [retiredGrants]  Sites the folder moved away from, where the app may still have access, until it's taken back.
 */

/**
 * A site the app had access to before the folder moved.
 * @typedef {object} RetiredGrant
 * @property {string} siteUrl
 * @property {string} sitePath
 * @property {string} [siteId]
 * @property {string} [grantId]
 */

/**
 * The PAX route's scheduled refresh on this PC.
 * @typedef {object} PaxConfigFields
 * @property {string} [version]  The PAX release the refresh runs, e.g. purview-v1.11.15.
 * @property {string} [workRoot]  The local folder that holds refresh.json, the scripts and the data.
 * @property {string} [credentialTarget]  The Windows Credential Manager entry that holds the app's client secret.
 * @property {string} [secretSetAt]  When the installer last wrote the secret there.
 * @property {string} [secretExpires]
 * @property {PaxTask} [task]  The scheduled task.
 * @property {boolean} [agent365]  Also export the Agent 365 registry.
 * @property {number} [seedDays]  How many days the first refresh asks PAX for.
 * @property {string} [scriptsHash]  What the installed scripts were copied from.
 * @property {FirstRun} [firstRun]  The first refresh, from when the installer starts it until a refresh succeeds.
 * @property {boolean} [deployApp]  Deploy the app. On when absent.
 * @typedef {PaxConfigFields & import('./steps/secrets.js').SecretSlot} PaxConfig
 */

/**
 * The scheduled task that runs the refresh.
 * @typedef {object} PaxTask
 * @property {string} name
 * @property {string} at  When it starts each day, HH:mm on this PC's clock.
 * @property {string} [registeredAt]
 * @property {string} [logonType]  As Task Scheduler last reported it. Interactive: it runs only while the user is signed in.
 */

/**
 * The first refresh, which fills the folder with the last `seedDays` of activity. On a large
 * tenant it takes hours, so the installer starts it and checks on it rather than waiting.
 * @typedef {object} FirstRun
 * @property {string} startedAt
 * @property {string} [finishedAt]
 * @property {'no-data' | 'failed'} [result]  How it ended, when it didn't succeed.
 * @property {string} [error]
 * @property {string} [log]  Its log file on this PC.
 */

/**
 * The PAX route's report in the Power BI service. Its workspace is in `fabric`, and the model and
 * report in `semanticModel`.
 * @typedef {object} PowerBiConfig
 * @property {'api' | 'desktop'} [publishedBy]  The installer published it, or handed the template to Power BI Desktop.
 * @property {string} [desktopPending]  The template handed to Power BI Desktop and not yet found published, by its hash.
 * @property {string} [desktopFile]  Where that template is on this PC.
 * @property {'set' | 'later'} [credentials]  The model has been signed in to SharePoint, or the user chose to do it later.
 * @property {string} [refreshAt]  The model's first daily refresh, HH:mm. Set once the refreshes are scheduled.
 * @property {string} [timeZone]  The schedule's Windows time zone ID.
 */

/**
 * The app, deployed with the `ms` CLI as a Copilot Managed App and shared with the viewer group.
 * @typedef {object} ManagedAppConfig
 * @property {string} [appId]
 * @property {string} [url]  Where people open it.
 * @property {string} [environmentId]  The Power Platform environment it's deployed to, or the one chosen for it.
 * @property {string} [deployedAt]
 * @property {string} [buildHash]  A hash of the build that was deployed.
 * @property {string[]} [sharedWith]  The groups it's shared with.
 * @property {('createApps' | 'externalArtifacts')[]} [missing]  The tenant settings the last attempt found turned off.
 * @property {{ why: string, steps: string[] }} [skipped]  Why the last attempt didn't deploy it, and what to do.
 */

/** @returns {InstallConfig} */
export function emptyConfig() {
  return {
    product: PRODUCT.id,
    version: CONFIG_VERSION,
    target: 'fabric',
    modules: normaliseModules(undefined),
    dataSources: normaliseDataSources(undefined, normaliseModules(undefined)),
    uploads: {},
    history: { days: 30 },
    schedule: { frequency: 'daily', time: '02:00', weekday: 'Sunday', timeZone: 'UTC' },
    app: {},
    keyVault: { secretName: `${PRODUCT.id}-client-secret` },
    fabric: { notebooks: {} },
    semanticModel: { name: MODEL_NAME },
    resourceGraph: { managementGroup: '', agents: true, foundry: true },
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
 * Why a record from another installer is refused, or undefined for one of this installer's.
 * Records from the Analytics Hub installer, and from the installer this repo shipped before
 * Analytics Hub moved to its own repo, have no `product`.
 * @param {any} raw
 * @param {string} file
 */
export function foreignRecord(raw, file) {
  if (raw?.product === PRODUCT.id) return undefined;
  const another = `To set up ${PRODUCT.name} separately, run this installer in another folder or pass --config with a new file name.`;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.product === undefined) {
    return `${file} is an Analytics Hub install record, or one from this repo's earlier installer, so this installer leaves it alone. Manage that install with the Analytics Hub installer (${AH_RELEASES}). ${another}`;
  }
  if (typeof raw?.product === 'string') return `${file} is the install record of another installer ("${raw.product}"), so this installer leaves it alone. ${another}`;
  return `${file} isn't an install record. ${another}`;
}

/**
 * A record as read from disk, with the defaults for anything it doesn't have yet.
 * @param {any} raw
 * @param {string} file
 * @returns {InstallConfig}
 */
function normaliseConfig(raw, file) {
  const foreign = foreignRecord(raw, file);
  if (foreign) throw new Error(foreign);
  if (raw.version !== CONFIG_VERSION) throw new Error(`${file} has version ${raw.version}; this installer reads version ${CONFIG_VERSION}.`);
  const base = emptyConfig();
  /** @type {InstallConfig} */
  const config = {
    ...base,
    ...raw,
    target: raw.target ?? 'fabric',
    modules: normaliseModules(raw.modules),
    dataSources: normaliseDataSources(raw.dataSources, normaliseModules(raw.modules), raw.uploads),
    // feedbackFlow is read once, above: the flow is now its source's api mode.
    uploads: Object.fromEntries(Object.entries(raw.uploads ?? {}).filter(([k]) => k !== 'feedbackFlow')),
    history: { ...base.history, ...(raw.history ?? {}) },
    reporting: normaliseReporting(raw.reporting),
    schedule: { ...base.schedule, ...(raw.schedule ?? {}) },
    app: { ...(raw.app ?? {}) },
    keyVault: { ...base.keyVault, ...(raw.keyVault ?? {}) },
    fabric: { ...base.fabric, ...(raw.fabric ?? {}), notebooks: { ...(raw.fabric?.notebooks ?? {}) } },
    semanticModel: { ...base.semanticModel, ...(raw.semanticModel ?? {}) },
    ...(raw.access
      ? {
          access: {
            ...raw.access,
            grantedModels: [...(raw.access.grantedModels ?? [])],
            ...(raw.access.rls ? { rls: { ...raw.access.rls, applied: Array.isArray(raw.access.rls.applied) ? [...raw.access.rls.applied] : [] } } : {}),
          },
        }
      : {}),
    resourceGraph: normaliseResourceGraph(raw.resourceGraph),
    ...(raw.sharePoint ? { sharePoint: { ...raw.sharePoint } } : {}),
    ...(raw.pax ? { pax: { ...raw.pax, ...(raw.pax.task ? { task: { ...raw.pax.task } } : {}) } } : {}),
    ...(raw.powerBi ? { powerBi: { ...raw.powerBi } } : {}),
    ...(raw.managedApp ? { managedApp: { ...raw.managedApp } } : {}),
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
 * in place, so code holding part of it (a `const fabric = config.fabric`, say) sees them too.
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
 * `valuelens-setup.<yyyyMMdd-HHmmss>.json`, so nothing in it is lost.
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
