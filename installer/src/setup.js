// @ts-check
/** Category editing keeps unapproved choices separate from deployed IDs and checkpoints. */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { archiveConfig, loadConfig, removeFile, saveConfig } from './config.js';
import { armErrors } from './clients/azure.js';
import { plan, preflight, confirmPlan } from './steps/plan.js';
import { askTarget, azurePreflight, azureResourceGraphOn, confirmAzurePlan, deploymentPinned, planAzure, resourcesIn, supportsVnetGateway } from './steps/azure/index.js';
import { checkRegions, regionProblems, sqlProblem, allowedFor, ASK_TYPE } from './steps/azure/regions.js';
import { askModelIn } from './steps/azure/ask.js';
import { isResumeLater } from './steps/identity.js';
import { resourceGraphOn } from './steps/resource-graph.js';
import { checkStaged } from './staging.js';

/** @typedef {import('./install.js').Ctx} Ctx */
/** @typedef {import('./config.js').InstallConfig} InstallConfig */

export const SETUP_SECTIONS = ['data', 'placement', 'networking', 'powerbi', 'access', 'identity', 'sources', 'governance', 'ask', 'schedule'];
const draftFile = (/** @type {string} */ file) => `${file}.draft.json`;
const recordRevision = (/** @type {string} */ file) => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'new';

/** @param {InstallConfig} config */
export function setupCategories(config) {
  const az = config.azure;
  const azure = config.target === 'azure';
  const done = new Set(config.setup?.completed ?? []);
  const entry = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ summary) => ({ id, title, summary, complete: done.has(id) });
  const rg = config.resourceGraph;
  const resourceGraph = (azure ? azureResourceGraphOn(config) : resourceGraphOn(config))
    ? `agents ${rg.agents ? 'on' : 'off'}, Foundry ${rg.foundry ? 'on' : 'off'}`
    : 'off';
  return [
    entry('data', 'Data collection', `${azure && az?.sampleData ? 'Demo data; ' : ''}${Object.entries(config.modules).filter(([, on]) => on).map(([name]) => name).join(', ')}`),
    entry('placement', azure ? 'Azure placement' : 'Fabric placement', azure
      ? `${az?.subscriptionName ?? az?.subscriptionId ?? 'Choose subscription'} / ${az?.resourceGroup ?? 'Choose resource group'}; Azure: ${az?.location ?? 'not set'}; SQL: ${az?.sqlLocation || az?.location || 'not set'}`
      : `${config.fabric.workspaceName ?? 'Choose workspace'}; capacity: ${config.fabric.capacityId ?? 'not set'}`),
    ...(azure ? [entry('networking', 'Networking', `${az?.publicNetworkAccess === false ? 'Private networking' : 'Public endpoints'}; DNS: ${az?.privateDns?.mode ?? 'create'}`)] : []),
    entry('powerbi', 'Power BI', azure ? `Workspace: ${az?.powerBi?.workspaceId ?? az?.workspaceName ?? 'not set'}; capacity: ${az?.powerBi?.capacityId ?? 'shared'}`
      : `Semantic model: ${config.semanticModel.enabled === false ? 'off' : 'on'}; reports: ${config.semanticModel.reports === false ? 'off' : 'on'}; app: ${config.fabricApp.enabled === false ? 'off' : 'on'}`),
    entry('access', 'Viewer access', config.access?.groupName ?? config.access?.groupId ?? 'Choose who can view'),
    ...(!azure ? [entry('identity', 'Identity and secrets', `${config.app.displayName ?? config.app.appId ?? 'App registration'}; ${config.keyVault.mode === 'notebook' ? 'secret in notebooks' : config.keyVault.name ?? 'Key Vault'}`)] : []),
    entry('sources', 'Module connections', 'Credit consumption, data sources and module-specific connections'),
    entry('governance', 'Governance and flows', `Resource Graph: ${resourceGraph}`),
    ...(azure ? [entry('ask', 'Ask / AI', `${az?.ask?.mode ?? 'off'}${az?.ask?.location ? `; ${az.ask.location}` : ''}`)] : []),
    entry('schedule', 'Schedule and loading', `${config.schedule.frequency}, ${config.schedule.time} ${config.schedule.timeZone}; ${config.history.days} days; ${config.reporting?.currency ?? 'USD'}`),
  ];
}

/**
 * Retain error codes through explanatory wrappers; never require the browser to parse error prose.
 * @param {unknown} err
 * @param {InstallConfig} config
 */
export function setupRecovery(err, config) {
  const e = /** @type {{ body?: unknown, cause?: unknown, message?: string, operations?: unknown }} */ (err ?? {});
  const source = e.cause ?? e;
  const cause = /** @type {{ body?: unknown, message?: string, operations?: unknown }} */ (source);
  const errors = armErrors(cause.body ?? source);
  const codes = errors.map((x) => x.code).filter(Boolean).join(', ');
  const text = `${codes} ${e.message ?? ''} ${cause.message ?? ''} ${JSON.stringify(cause.operations ?? [])}`;
  let section;
  let label;
  if (/InsufficientQuota|DeploymentModelNotSupported|ModelNotSupported|ServiceModelDeprecated|SkuNotSupported/i.test(text) && /model|CognitiveServices/i.test(text)) {
    section = config.target === 'azure' ? 'ask' : 'placement';
    label = 'Change Ask / AI settings';
  } else if (/RequestDisallowedByPolicy|DenyPublicEndpointEnabled|public network|private.?dns|networking/i.test(text)) {
    section = config.target === 'azure' ? 'networking' : 'identity';
    label = 'Review policy and networking';
  } else if (/region|location|capacity|quota|SkuNotAvailable|NotAvailableForSubscription|SubscriptionIsOverQuota/i.test(text)) {
    section = 'placement';
    label = /SQL/i.test(text) ? 'Change SQL region' : 'Change region or capacity';
  }
  return { section, label, code: codes || undefined };
}

/** @param {Ctx} ctx */
export function restoreSetupDraft(ctx) {
  const file = draftFile(ctx.file);
  if (!existsSync(file)) return true;
  const { config } = loadConfig(file);
  // An approved draft that a synced folder kept locked last time: the record already has its choices.
  if (config.setup?.approved) {
    removeFile(file);
    return true;
  }
  if (config.tenantId && config.tenantId !== ctx.user.tenantId) throw new Error('The saved setup draft belongs to a different tenant. Sign in to that tenant to resume it.');
  if (config.setup?.baseRevision !== recordRevision(ctx.file)) return false;
  replaceConfig(ctx.config, config);
  ctx.runFirstLoad = config.setup?.runFirstLoad;
  ctx.reloadHistoryDays = config.setup?.reloadHistoryDays;
  return true;
}

/** @param {InstallConfig} target @param {InstallConfig} source */
function replaceConfig(target, source) {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  Object.assign(target, structuredClone(source));
}

/**
 * First-load and history-reload choices apply to one deployment, so they stay out of the install record.
 * @param {NonNullable<InstallConfig['setup']>} setup
 */
function oneOff(setup) {
  delete setup.runFirstLoad;
  delete setup.reloadHistoryDays;
  return setup;
}

/**
 * Detect partial ARM success even when the deployment returned no outputs.
 * No resources are moved, replaced or deleted by editing settings.
 * @param {Ctx} ctx
 * @param {InstallConfig} before
 */
export async function checkSetupChanges(ctx, before) {
  const az = ctx.config.azure;
  const old = before.azure;
  if (ctx.config.target !== 'azure' || !az || !old) return;
  const baseline = old.deploymentConfig;
  if (!baseline && !old.outputs?.sqlServerFqdn && !old.deployments?.length) return;
  const deployed = baseline ?? old;
  const resources = await resourcesIn(ctx.api.arm, deployed.subscriptionId, deployed.resourceGroup);
  const has = (/** @type {RegExp} */ type) => resources.some((r) => r.tags?.['valuelens-install-id'] === old.installId && type.test(r.type ?? ''));
  if (deploymentPinned(old, resources) && (az.subscriptionId !== deployed.subscriptionId || az.resourceGroup !== deployed.resourceGroup || az.namePrefix !== deployed.namePrefix)) {
    throw new Error('Deployment has already been attempted here. Keep the subscription, resource group and name prefix to reuse its resources. Use a separate install record for a new deployment; existing resources are not deleted.');
  }
  if (az.location !== deployed.location && (old.outputs?.storageAccountName || old.outputs?.environmentName || old.outputs?.webName || has(/Microsoft\.(App|Storage|OperationalInsights|ManagedIdentity)\//i))) {
    throw new Error('Resources already exist in the Azure region. They cannot be moved by retrying setup. Keep that region; change only the SQL region if its server has not been created. A new regional deployment needs a separate install record and explicit cleanup of the old resources.');
  }
  if ((az.sqlLocation || az.location) !== (deployed.sqlLocation || deployed.location) && (old.outputs?.sqlServerFqdn || has(/^Microsoft\.Sql\/servers$/i))) {
    throw new Error('The SQL server already exists. Its region cannot change in place. Keep its region or plan a separate deployment and data migration; this installer will not delete it.');
  }
  if (az.publicNetworkAccess !== deployed.publicNetworkAccess && (old.outputs?.environmentName || has(/^Microsoft\.App\/managedEnvironments$/i))) {
    throw new Error('The Container Apps environment already exists. Networking cannot change in place. Keep its networking or use a separate install record; existing resources are not deleted.');
  }
  if (az.ask?.mode === 'create' && (az.ask.location || az.location) !== (old.ask?.location || deployed.location) && has(/^Microsoft\.CognitiveServices\/accounts$/i)) {
    throw new Error('An AI account already exists. Keep its region, use an existing deployment, or turn Ask off. Turning Ask off does not delete the account or stop its other charges.');
  }
  if (old.ask?.mode === 'create' && az.ask?.mode !== 'create' && has(/^Microsoft\.CognitiveServices\/accounts$/i)) {
    ctx.ui.warn('The existing AI account is not deleted when you change Ask. Review its remaining charges in Azure.');
  }
  if (old.powerBi?.workspaceId && az.powerBi?.workspaceId !== old.powerBi.workspaceId) throw new Error('Keep the existing Power BI workspace for this install. A different workspace needs a separate install record.');
}

/** @param {InstallConfig} before @param {InstallConfig} after */
function changedCategories(before, after) {
  const old = setupCategories(before);
  const values = (/** @type {InstallConfig} */ config) => ({
    data: [config.modules, config.dataSources, config.azure?.sampleData],
    placement: [config.azure?.subscriptionId, config.azure?.resourceGroup, config.azure?.location, config.azure?.sqlLocation, config.azure?.namePrefix, config.azure?.tags, config.azure?.sqlScaleUp, config.azure?.webAlwaysOn, config.fabric.capacityId, config.fabric.workspaceName, config.fabric.lakehouseName, config.scale],
    networking: [config.azure?.publicNetworkAccess, config.azure?.privateDns],
    powerbi: [config.azure?.powerBi, config.azure?.workspaceName, config.semanticModel.enabled, config.semanticModel.reports, config.fabricApp.enabled],
    access: config.access,
    identity: [config.app, config.keyVault],
    sources: [config.dataSources, config.consumption, config.agentEvaluator],
    governance: [config.resourceGraph, config.uploads],
    ask: config.azure?.ask,
    schedule: [config.schedule, config.history, config.reporting, config.setup?.runFirstLoad, config.setup?.reloadHistoryDays],
  });
  const previousValues = values(before);
  const nextValues = values(after);
  return setupCategories(after).flatMap((cat) => {
    const previous = old.find((x) => x.id === cat.id);
    if (JSON.stringify(Reflect.get(previousValues, cat.id)) === JSON.stringify(Reflect.get(nextValues, cat.id))) return [];
    return [previous?.summary !== cat.summary
      ? `${cat.title}: ${previous?.summary ?? 'not set'} -> ${cat.summary}`
      : `${cat.title}: settings updated; review the deployment plan before approving.`];
  });
}

/** @param {Ctx} ctx */
async function refreshRegions(ctx) {
  const az = ctx.config.azure;
  if (ctx.config.target !== 'azure' || !az?.subscriptionId || !az.resourceGroup) return;
  const locations = await ctx.api.arm.listLocations(az.subscriptionId);
  const rg = await ctx.api.arm.getResourceGroup(az.subscriptionId, az.resourceGroup);
  ctx.azureRegions = await checkRegions(ctx.api.arm, {
    subscriptionId: az.subscriptionId,
    scope: `/subscriptions/${az.subscriptionId}${rg ? `/resourceGroups/${az.resourceGroup}` : ''}`,
    newResourceGroup: !rg, locations,
  });
}

/**
 * A persistent overview is the navigation root, including after planning/validation errors.
 * Each category uses the same planner as terminal setup, without replaying unrelated answers.
 * @param {Ctx} ctx
 */
export async function reviewSetup(ctx) {
  if (!restoreSetupDraft(ctx)) {
    ctx.ui.heading('Setup draft conflict');
    const choice = await ctx.ui.select('The install record changed after this draft was saved. Keep the newer deployed IDs and archive the older draft?', [
      { name: 'Use the latest install record and archive the older draft', value: 'record' },
      { name: 'Keep both files and stop', value: 'stop' },
    ], 'record');
    if (choice === 'stop') return false;
    try {
      archiveConfig(draftFile(ctx.file));
    } catch (err) {
      // The next checkpoint replaces it with the latest record, so a locked draft can't block setup.
      ctx.ui.warn(`Couldn't archive the older draft (${/** @type {Error} */ (err).message}). It will be replaced by a draft of the latest install record.`);
    }
  }
  await askTarget(ctx);
  const baseRevision = recordRevision(ctx.file);
  const baseline = structuredClone(ctx.config);
  const deployed = ctx.config.target === 'azure' ? !!ctx.config.azure?.deploymentConfig || !!ctx.config.azure?.outputs?.sqlServerFqdn : !!ctx.config.fabric.lakehouseId;
  ctx.config.setup ??= { completed: deployed ? setupCategories(ctx.config).map((cat) => cat.id) : [] };
  // One-off answers: a restored draft carries them for this session; the install record never does.
  oneOff(ctx.config.setup);
  ctx.runFirstLoad ??= ctx.config.target === 'azure' ? !ctx.reloadHistoryDays : ctx.config.firstRun?.status !== 'Completed';
  baseline.setup = { ...(baseline.setup ?? { completed: [] }), runFirstLoad: ctx.runFirstLoad, reloadHistoryDays: ctx.reloadHistoryDays };
  if (ctx.config.app.existing && !ctx.config.keyVault.secretSetAt && !ctx.pendingSecret && ctx.config.target !== 'azure') {
    ctx.config.setup.completed = ctx.config.setup.completed.filter((id) => id !== 'identity');
  }
  let notice = deployed ? 'Existing resources are reused where safe. Placement and networking changes are checked against live resources; editing never deletes them.' : '';
  if (!ctx.pendingUploads?.length && ctx.config.setup.uploads?.length) {
    const missing = [];
    ctx.pendingUploads = [];
    for (const file of ctx.config.setup.uploads) {
      const staged = file.token ? checkStaged(file.token, ctx.config.dataSources) : null;
      if (staged?.ok && existsSync(staged.file.path)) ctx.pendingUploads.push(staged.file);
      else missing.push(file.name);
    }
    if (missing.length) {
      ctx.config.setup.completed = ctx.config.setup.completed.filter((id) => id !== 'data');
      notice = `These selected uploads are no longer available: ${missing.join(', ')}. Open Data collection and select them again before deployment.`;
      ctx.setupRetry = false;
      ctx.setupSection = undefined;
    }
  }
  let selected = ctx.setupSection;
  let retry = ctx.setupRetry;
  const realSave = ctx.save;
  const realUi = ctx.ui;
  let approved = false;
  const checkpoint = () => {
    ctx.config.setup = {
      completed: ctx.config.setup?.completed ?? [], runFirstLoad: ctx.runFirstLoad, reloadHistoryDays: ctx.reloadHistoryDays, baseRevision,
      uploads: (ctx.pendingUploads ?? []).map(({ token, name }) => ({ token, name })),
    };
    saveConfig(draftFile(ctx.file), ctx.config);
  };
  ctx.save = checkpoint;
  ctx.ui = new Proxy(realUi, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function' || !['input', 'select', 'confirm', 'checkbox', 'sources', 'secret', 'form'].includes(String(name))) return value;
      return (...args) => { checkpoint(); return value.apply(target, args); };
    },
  });
  try {
    for (;;) {
      checkpoint();
      ctx.ui.heading('Setup settings');
      const categories = setupCategories(ctx.config);
      const choice = selected ?? (retry ? 'deploy' : await ctx.ui.settings(categories, { notice, changes: changedCategories(baseline, ctx.config) }));
      selected = undefined;
      retry = false;
      notice = '';
      if (choice === 'close') {
        ctx.ui.note('Setup choices are saved as a draft. Open setup again to continue; deployed resources have not been removed.');
        return false;
      }
      if (choice !== 'deploy' && !categories.some((cat) => cat.id === choice)) {
        notice = 'That category is not available for this deployment target.';
        continue;
      }
      const before = structuredClone(ctx.config);
      const answers = { pendingSecret: ctx.pendingSecret, pendingUploads: ctx.pendingUploads, runFirstLoad: ctx.runFirstLoad, reloadHistoryDays: ctx.reloadHistoryDays };
      let planned = false;
      try {
        // Refresh before every edit and retry, never use the rewind API cache for live availability.
        const pre = await preflight(ctx);
        if (choice !== 'deploy') {
          ctx.advanced = true;
          ctx.ui.beginSection();
          if (['networking', 'ask'].includes(choice)) await refreshRegions(ctx);
          if (ctx.config.target === 'azure') await planAzure(ctx, pre, choice);
          else await plan(ctx, pre, choice);
          planned = true;
          await checkSetupChanges(ctx, baseline);
          const completed = new Set(ctx.config.setup?.completed);
          completed.add(choice);
          // Data and networking affect connections and access requirements.
          if ((choice === 'data' && (JSON.stringify(before.modules) !== JSON.stringify(ctx.config.modules) || before.azure?.sampleData !== ctx.config.azure?.sampleData)) ||
              (choice === 'networking' && before.azure?.publicNetworkAccess !== ctx.config.azure?.publicNetworkAccess)) {
            for (const dependent of ['sources', 'access', ...(choice === 'networking' ? ['powerbi'] : ['governance'])]) completed.delete(dependent);
          }
          if (choice === 'powerbi' && before.semanticModel.enabled !== ctx.config.semanticModel.enabled) completed.delete('access');
          if (choice === 'placement' && before.azure?.subscriptionId !== ctx.config.azure?.subscriptionId) {
            for (const dependent of ['networking', 'sources', 'governance', 'ask']) completed.delete(dependent);
          }
          ctx.config.setup = { completed: [...completed] };
          checkpoint();
          continue;
        }
        const missing = categories.filter((cat) => !cat.complete);
        if (missing.length) throw new Error(`Review these categories first: ${missing.map((cat) => cat.title).join(', ')}.`);
        await checkSetupChanges(ctx, baseline);
        if (ctx.config.target === 'azure') {
          await refreshRegions(ctx);
          const az = ctx.config.azure;
          if (az?.powerBi?.capacityId) {
            const capacities = await ctx.api.fabric.listCapacities();
            if (!capacities.some((cap) => cap.id === az.powerBi?.capacityId && cap.state === 'Active' && (az.publicNetworkAccess !== false || supportsVnetGateway(cap)))) {
              throw new Error('Review Power BI: the selected capacity is no longer active, accessible, or suitable for private networking.');
            }
          }
          if (az?.location && ctx.azureRegions) {
            const problems = [...regionProblems(ctx.azureRegions, az.location, { sql: false }), sqlProblem(ctx.azureRegions, az.sqlLocation || az.location)].filter(Boolean);
            if (problems.length) throw new Error(`Review Azure placement: ${problems.join('; ')}.`);
            if (az.ask?.mode === 'create') {
              const region = az.ask.location || az.location;
              const allowed = allowedFor(ctx.azureRegions, ASK_TYPE);
              if (allowed && !allowed.includes(region)) throw new Error(`Review Ask / AI: Azure Policy does not allow the model in ${region}.`);
              const model = await askModelIn(ctx, region, az.ask.sku ?? 'GlobalStandard');
              if (!model.ok) throw new Error(`Review Ask / AI: ${model.reason}.`);
              if (model.unchecked) ctx.ui.warn('Ask model availability could not be checked. Azure will check it during deployment.');
              else if (model.capacity < (az.ask.capacity ?? 50)) throw new Error(`Review Ask / AI: only ${model.capacity}K tokens/min is currently available; reduce the model capacity before retrying.`);
            }
          }
          await azurePreflight(ctx);
        } else if (!pre.capacities.some((cap) => cap.id === ctx.config.fabric.capacityId)) {
          throw new Error('Review Fabric placement: the selected capacity is no longer active or accessible.');
        }
        checkpoint();
        const go = ctx.config.target === 'azure' ? await confirmAzurePlan(ctx) : await confirmPlan(ctx, pre);
        if (!go) continue;
        if (recordRevision(ctx.file) !== baseRevision) throw new Error('The install record changed while you edited this draft. Save and close, then reopen setup to keep the latest deployed IDs and resolve the draft conflict.');
        // Marked first so a draft a synced folder keeps locked is cleaned up next run, not treated as a conflict.
        saveConfig(draftFile(ctx.file), { ...ctx.config, setup: { ...ctx.config.setup, completed: ctx.config.setup?.completed ?? [], approved: true } });
        ctx.config.setup = oneOff({ ...ctx.config.setup, completed: ctx.config.setup?.completed ?? [] });
        realSave();
        approved = true;
        if (!removeFile(draftFile(ctx.file))) ctx.ui.note('The approved setup draft is locked by another program; it will be cleaned up next time.');
        return true;
      } catch (err) {
        if (/** @type {Error} */ (err)?.name === 'ExitPromptError' || isResumeLater(err)) throw err;
        const cancelled = /** @type {Error} */ (err)?.name === 'SettingsCancelled';
        if (cancelled || planned) {
          replaceConfig(ctx.config, before);
          Object.assign(ctx, answers);
        }
        notice = cancelled ? 'Changes cancelled. Your previous choices are unchanged.' : String(/** @type {Error} */ (err)?.message ?? err);
        ctx.ui.warn(notice);
        checkpoint();
      } finally {
        ctx.ui.endSection();
      }
    }
  } finally {
    if (!approved) checkpoint();
    ctx.save = realSave;
    ctx.ui = realUi;
  }
}
