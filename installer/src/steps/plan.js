// @ts-check
/**
 * Checks the tenant, then asks every question up front so the rest of the
 * install can run unattended.
 */
import { randomBytes } from 'node:crypto';
import { rlsOn } from '../transform/access.js';
import { collectedLabels, ESSENTIAL_MODULES, MODULES, notebooksFor, OPTIONAL_MODULES, permissionsFor } from '../catalog.js';
import { allowsAction, armLocation, validateVaultName } from '../clients/azure.js';
import { TRANSCRIPT_ROLE } from '../clients/dataverse.js';
import { APP_ROLES, CONSENT_ROLES } from '../clients/graph.js';
import { HttpError } from '../http.js';
import { commandLine, inCloudShell } from '../launch.js';
import { c } from '../ui.js';
import { CURRENCIES, DEFAULT_CURRENCY, describeReporting, parseRate } from '../currency.js';
import { AGENT_EVALUATOR_MODEL_NAME, CONSUMPTION_MODEL_NAME, DATA_AGENT_NAME, flowIdentity, MODEL_NAME, secretMode } from '../config.js';
import { MIN_NODE, nodeVersionOk } from './app.js';
import { agentEvaluatorModelWanted, fabricReadRoleReview, planAgentEvaluator } from './agent-evaluator.js';
import { AZURE_AI_ROLES, consumptionModelWanted, COWORK_DATAFLOW_NAME, planConsumption, planCowork } from './consumption.js';
import { FLOW_NAMES, flowsSkipped, flowsWanted, planFlows } from './flows.js';
import { adminPack, canWriteSecrets, checkExistingApp, MAX_SECRET_DAYS, NOTEBOOK_SECRET_DAYS, notebookSecretDays, reportAppCheck, ResumeLater, writeAdminPack } from './identity.js';
import { planResourceGraph, resourceGraphGrants, resourceGraphKinds, resourceGraphOn, scopeName } from './resource-graph.js';
import { askAdvanced, asksAdvanced } from './advanced.js';
import { describeSchedule, displayNames, freeName, modelKey, PIPELINE_NAME, stoppedRunItem } from './fabric.js';
import { connectionName, MODEL_UPDATE_NOTE } from './model.js';
import { reportsWanted } from './report.js';
import { DATA_AGENT_TYPE, dataAgentWanted, planDataAgent } from './data-agent.js';
import { planDataSources } from './data-sources.js';
import { accessReview, planAccess } from './access.js';
import { DATA_SOURCES, modulesFromSources, routerWanted, UPLOAD_DIR } from '../uploads.js';
import { BIG_CAPACITY_SEATS, copilotSeats, LARGE_TENANT_SEATS, seatCount } from '../seats.js';

/** @typedef {import('../install.js').Ctx} Ctx */

export const APP_NAME = 'Analytics Hub Data Collector';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string} v */
export const isGuid = (v) => GUID.test(v.trim());

/** Fabric item names for a Lakehouse: letter first, then letters, digits, underscores. @param {string} v */
export function validateLakehouseName(v) {
  if (v.length > 123) return 'Use 123 characters or fewer.';
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? true : 'Start with a letter, then use only letters, numbers and underscores. That\'s a Fabric rule for Lakehouse names.';
}

/**
 * The name to give the Lakehouse. Fabric won't take spaces or hyphens, so they become underscores.
 * @param {string} v
 */
export const lakehouseNameFrom = (v) => v.trim().replace(/[\s-]+/g, '_');

/**
 * A valid Lakehouse name that no Lakehouse in the workspace has: the install only writes to one it creates.
 * @param {string[]} taken  Lakehouse names already in the workspace.
 */
export const validateNewLakehouseName = (taken) => (/** @type {string} */ v) => {
  const name = lakehouseNameFrom(v);
  const ok = validateLakehouseName(name);
  if (ok !== true) return ok;
  return taken.some((t) => t.toLowerCase() === name.toLowerCase())
    ? `There's already a Lakehouse called ${name} here. Analytics Hub only writes to a Lakehouse it creates, so choose another name.`
    : true;
};

/** @param {string} v */
export function validateTime(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? true : 'Use 24-hour HH:MM, e.g. 02:00.';
}

/** @param {Ctx} ctx */
export async function editSchedule(ctx) {
  const schedule = ctx.config.schedule;
  const values = await ctx.ui.form('Schedule', [
    { id: 'frequency', label: 'Frequency', default: schedule.frequency, choices: [{ name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }] },
    { id: 'weekday', label: 'Day (weekly schedules only)', default: schedule.weekday, choices: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ name: d, value: d })) },
    { id: 'time', label: `Time (${schedule.timeZone}, 24-hour)`, default: schedule.time, validate: validateTime },
  ]);
  if (!values) throw Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' });
  schedule.frequency = /** @type {'daily' | 'weekly'} */ (values.frequency);
  schedule.weekday = values.weekday;
  schedule.time = values.time;
}

/**
 * Premium Per User (PP), Embedded (A) and EM capacities can't host Fabric items.
 * @param {{ sku?: string }} capacity
 */
export const runsFabric = (capacity) => !/^(PP|A|EM)\d/i.test(String(capacity.sku ?? ''));

/**
 * F64 and up, or a Premium P capacity: what a large tenant usually runs on, so the tenant size starts at large.
 * A trial capacity (FTL<n>) counts as the F<n> it matches; a trial SKU without a size, such as FT1, doesn't.
 * @param {{ sku?: string }} capacity
 */
export function largeCapacity(capacity) {
  const m = /^(P|F|FTL)(\d+)$/i.exec(String(capacity.sku ?? ''));
  return !!m && (m[1].toUpperCase() === 'P' || Number(m[2]) >= 64);
}

/**
 * @typedef {object} Preflight
 * @property {any[]} capacities  Active capacities the user can use.
 * @property {any[]} subscriptions  Enabled Azure subscriptions.
 * @property {string[]} roles  Directory role names.
 * @property {boolean} canConsent
 * @property {boolean | undefined} canCreateApps  undefined when the policy can't be read.
 * @property {Record<string, { enabled?: boolean, delegateToCapacity?: boolean }>} [tenantSettings]  Only for Fabric administrators.
 * @property {number} [seats]  Assigned Microsoft 365 Copilot seats; undefined when they can't be read.
 */

/**
 * The tenant size a new install, or one with no size saved, starts at: large on F64 or larger, or
 * with more than 10,000 Copilot seats assigned.
 * @param {{ sku?: string } | undefined} capacity
 * @param {number} [seats]
 * @returns {'standard' | 'large'}
 */
export const defaultScale = (capacity, seats) => ((capacity && largeCapacity(capacity)) || (seats ?? 0) > LARGE_TENANT_SEATS ? 'large' : 'standard');

/**
 * What to tell someone whose tenant size or capacity looks too small for the seats assigned. Says
 * which step changes it, and how to carry on when policy rules the change out.
 * @param {{ seats?: number, capacity?: { sku?: string, displayName?: string }, scale?: 'standard' | 'large' }} opts
 * @returns {string[]}
 */
export function sizingWarnings({ seats, capacity, scale }) {
  if (!seats) return [];
  /** @type {string[]} */
  const out = [];
  const n = seatCount(seats);
  if (seats >= BIG_CAPACITY_SEATS && capacity && !largeCapacity(capacity)) {
    out.push(
      `${n} Copilot seats are assigned and the capacity ${capacity.displayName ?? ''} is ${capacity.sku ?? 'an unknown size'}, below F64. ` +
        'In Fabric placement, choose an F64 or larger capacity, or ask your capacity admin for one. If your organisation\'s policy keeps you on this capacity, setup still works, but loads take longer and may hit their time limits.',
    );
  }
  if (seats > LARGE_TENANT_SEATS && scale === 'standard') {
    out.push(
      `${n} Copilot seats are assigned, but the tenant size is "Up to 10,000". In Fabric placement (in the terminal, under the advanced settings), choose "More than 10,000" so the pipeline reads the audit log in smaller windows and gives its slow steps longer.`,
    );
  }
  return out.map((s) => s.replace(/ {2,}/g, ' '));
}

/**
 * Tenant settings the semantic model, the reports and the app rely on, and what breaks without them.
 * @type {{ name: string, title: string, effect: string, app?: boolean, reports?: boolean }[]}
 */
export const POWER_BI_SETTINGS = [
  {
    name: 'ServicePrincipalAccessPermissionAPIs',
    title: 'Service principals can call Fabric public APIs',
    effect: 'The model\'s connection signs in as the app registration, so the model can\'t refresh without it.',
  },
  {
    name: 'DatasetExecuteQueries',
    title: 'Semantic Model Execute Queries REST API',
    effect: 'The Analytics Hub app queries the model through it.',
    app: true,
  },
  {
    name: 'AppBackendTenant',
    title: 'Fabric App items',
    effect: 'The Analytics Hub app is a Fabric App item.',
    app: true,
  },
  {
    name: 'CustomVisualsTenant',
    title: 'Allow visuals created using the Power BI SDK',
    effect: 'The reports\' Tornado chart, Word cloud and Deneb visuals stay blank without it.',
    reports: true,
  },
];

/**
 * Settings that look switched off. A setting delegated to capacity admins may still be on there.
 * @param {Preflight['tenantSettings']} settings
 * @param {{ app: boolean, reports?: boolean }} opts
 */
export function blockedSettings(settings, opts) {
  if (!settings) return [];
  return POWER_BI_SETTINGS.filter(
    (s) => (opts.app || !s.app) && (opts.reports || !s.reports) && settings[s.name]?.enabled === false && !settings[s.name]?.delegateToCapacity,
  );
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<Preflight>}
 */
export async function preflight(ctx) {
  const { ui, api, user } = ctx;
  ui.heading('Checking your tenant');
  ui.ok(`Signed in as ${user.upn} (tenant ${user.tenantId})`);

  const roles = await api.graph.myDirectoryRoles().catch(() => []);
  const roleIds = new Set(roles.map((r) => r.roleTemplateId));
  const canConsent = Object.keys(CONSENT_ROLES).some((id) => roleIds.has(id));
  const appAdmin = Object.keys(APP_ROLES).some((id) => roleIds.has(id));
  /** @type {boolean | undefined} */
  let canCreateApps = canConsent || appAdmin ? true : undefined;
  if (canCreateApps === undefined) canCreateApps = await api.graph.usersCanRegisterApps().catch(() => undefined);

  if (canConsent) ui.ok(`You can grant admin consent (${roles.filter((r) => CONSENT_ROLES[/** @type {keyof typeof CONSENT_ROLES} */ (r.roleTemplateId)]).map((r) => r.displayName).join(', ')})`);
  else ui.warn('You can\'t grant admin consent for Microsoft Graph. The installer will give you a link for a Global Administrator or Privileged Role Administrator to approve.');
  if (!ctx.config.app.appId && canCreateApps === false) {
    ui.warn('Users in this tenant can\'t register apps and you have no app admin role. Choose "Use an app registration I already have", or get an admin pack for an admin to register it.');
  }

  const capacities = ctx.config.target === 'azure' ? [] : (await api.fabric.listCapacities()).filter((cap) => cap.state === 'Active' && runsFabric(cap));
  if (ctx.config.target !== 'azure') {
    if (!capacities.length) {
      ui.fail('No active Fabric capacity you can use.');
      throw new Error('Start a Fabric trial, or ask a capacity admin to make you a contributor on an F2 or larger capacity, then run the installer again.');
    }
    ui.ok(`${capacities.length} active Fabric ${capacities.length === 1 ? 'capacity' : 'capacities'}`);
  }

  /** @type {any[]} */
  let subscriptions = [];
  try {
    subscriptions = (await api.arm.listSubscriptions()).filter((s) => s.state === 'Enabled');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }
  if (!subscriptions.length && !ctx.config.keyVault.uri && secretMode(ctx.config) !== 'notebook') {
    if (ctx.config.target === 'azure') {
      ui.fail('No Azure subscription you can use.');
      throw new Error('Analytics Hub on Azure needs an Azure subscription in this tenant. Ask for Contributor on one, then run the installer again.');
    }
    if (ctx.useKeyVault) {
      ui.fail('No Azure subscription you can use, so no Key Vault.');
      throw new Error('--key-vault needs an Azure subscription in this tenant. Ask for Contributor on one, or leave out --key-vault to keep the client secret in the notebooks.');
    }
    // A Fabric install doesn't need one: the client secret can go in the notebooks instead of Key Vault.
    ui.info('No Azure subscription you can use, so no Key Vault: the client secret goes in the notebooks.');
    if (ui.yes && !ctx.secretInNotebook && !defaultsToNoVault(ctx)) {
      throw new Error(
        'With no Azure subscription there\'s no Key Vault for the app secret. Add --no-key-vault to keep it in the notebooks, where anyone with a role in the workspace can read it, or ask for Contributor on a subscription.',
      );
    }
  }
  if (subscriptions.length) ui.ok(`${subscriptions.length} Azure ${subscriptions.length === 1 ? 'subscription' : 'subscriptions'} for Key Vault`);

  const seats = await copilotSeats(api);
  if (seats) ui.ok(`${seatCount(seats)} Microsoft 365 Copilot ${seats === 1 ? 'seat' : 'seats'} assigned`);

  /** @type {Preflight['tenantSettings']} */
  let tenantSettings;
  try {
    tenantSettings = Object.fromEntries((await api.fabric.tenantSettings()).map((s) => [s.settingName, s]));
  } catch {
    // Only Fabric administrators can read them.
  }

  return { capacities, subscriptions, roles: roles.map((r) => r.displayName), canConsent, canCreateApps, tenantSettings, seats };
}

/**
 * The Power BI choice to offer first. The reports and the app are on unless switched off, so
 * re-running an older install offers the reports too.
 * @param {import('../config.js').InstallConfig} config
 * @param {boolean} canApp
 * @returns {'all' | 'reports' | 'both' | 'model' | 'none'}
 */
export function powerBiChoice(config, canApp) {
  if (config.semanticModel.enabled === false) return 'none';
  const reports = config.semanticModel.reports !== false;
  if (canApp && config.fabricApp.enabled !== false) return reports ? 'all' : 'both';
  return reports ? 'reports' : 'model';
}

/**
 * @param {import('../config.js').InstallConfig} config
 * @param {string} choice
 */
export function applyPowerBiChoice(config, choice) {
  config.semanticModel.enabled = choice !== 'none';
  config.semanticModel.reports = choice === 'all' || choice === 'reports';
  config.fabricApp.enabled = choice === 'all' || choice === 'both';
}

/**
 * The semantic model, and the app on top of it.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 */
async function planPowerBi(ctx, pre) {
  const { ui, config, sources } = ctx;
  const sm = config.semanticModel;
  const fa = config.fabricApp;
  ui.heading('Power BI');
  if (!sources.modelFile) {
    sm.enabled = false;
    fa.enabled = false;
    ui.note('This checkout has no "ValueLens - Fabric.pbit", so the installer won\'t deploy a semantic model.');
    return;
  }
  const canApp = !!sources.appDir;
  const choice = !asksAdvanced(ctx)
    ? powerBiChoice(config, canApp)
    : await ui.select(
    'Deploy the semantic model?',
    [
      ...(canApp ? [{ name: 'Semantic model, Power BI reports and the Analytics Hub app (recommended)', value: 'all', description: 'The ValueLens reports and a web app in the workspace, built on the model.' }] : []),
      { name: `Semantic model and Power BI reports${canApp ? '' : ' (recommended)'}`, value: 'reports', description: 'The ValueLens reports, published to the workspace and ready to share.' },
      ...(canApp ? [{ name: 'Semantic model and the Analytics Hub app', value: 'both', description: 'A web app in the workspace, built on the model, without the reports.' }] : []),
      { name: 'Semantic model only', value: 'model', description: 'Build your own reports on it in Power BI.' },
      { name: 'Neither', value: 'none', description: 'You publish "ValueLens - Fabric.pbit" yourself.' },
    ],
    powerBiChoice(config, canApp),
  );
  applyPowerBiChoice(config, choice);
  if (fa.enabled && !nodeVersionOk()) {
    fa.enabled = false;
    ui.warn(`Building the app needs Node.js ${MIN_NODE.join('.')} or later; this is ${process.versions.node}. Deploying the semantic model only.`);
    ui.note(`Install a newer Node.js, then run "${commandLine('deploy-app')}".`);
  }
  if (!sm.enabled) return;
  for (const s of blockedSettings(pre.tenantSettings, { app: !!fa.enabled, reports: !!sm.reports })) {
    ui.warn(`The tenant setting "${s.title}" is off. ${s.effect}`);
    ui.note('A Fabric administrator can switch it on in the admin portal, under Tenant settings.');
  }
}

/**
 * The "What to collect" tick boxes: the essentials ticked and locked, then the extras.
 * @param {import('../catalog.js').ModuleChoice} modules
 */
export function collectChoices(modules) {
  const box = (/** @type {import('../catalog.js').ModuleId} */ id) => ({ name: MODULES[id].label, value: id, description: MODULES[id].description });
  return [
    ...ESSENTIAL_MODULES.map((id) => ({ ...box(id), checked: true, disabled: 'Always collected' })),
    ...OPTIONAL_MODULES.map((id) => ({ ...box(id), checked: modules[id] })),
  ];
}

/** The audit history the first load can pull, and how long each takes. */
export const HISTORY_CHOICES = [
  { name: '30 days (quickest; you can load more later)', value: 30 },
  { name: '90 days (a few hours; longer on a large tenant)', value: 90 },
  { name: '180 days (the most the audit log keeps by default; many hours)', value: 180 },
];

/**
 * What reloading `days` days of history runs, on Fabric: the pipeline, once.
 * @param {number} days
 */
const pipelineReloadChoice = (days) =>
  days > 30
    ? `Runs the pipeline once with ${days} days of history: a few hours, and many hours on a large tenant. The scheduled runs carry on after it.`
    : `Runs the pipeline once with ${days} days of history, usually in under an hour.`;

/**
 * Repair or change, once the history has loaded: offers to reload more of it after setup. Only
 * more than is loaded is offered. The answer goes on `ctx.reloadHistoryDays`; the install record
 * keeps the old number until the reload has started.
 * @param {Ctx} ctx
 * @param {(days: number) => string} [describe]  Each reload choice's description. Azure, which has no pipeline, passes its own.
 */
export async function askMoreHistory(ctx, describe = pipelineReloadChoice) {
  const { ui, config } = ctx;
  delete ctx.reloadHistoryDays;
  const current = config.history.days;
  const more = HISTORY_CHOICES.filter((ch) => ch.value > current);
  if (!more.length) {
    ui.ok(`Audit history: ${current} days loaded, the most the installer loads`);
    return;
  }
  const days = await ui.select(
    `Load more audit history? ${current} days are loaded now.`,
    [
      { name: `Keep ${current} days (the usual runs carry on from here)`, value: 0 },
      ...more.map((ch) => ({
        name: `Reload ${ch.value} days after setup`,
        value: ch.value,
        description: describe(ch.value),
      })),
    ],
    0,
  );
  if (days) ctx.reloadHistoryDays = days;
}

/**
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} [section]
 */
export async function plan(ctx, pre, section) {
  const { ui, config, api } = ctx;
  const advanced = () => !!section || asksAdvanced(ctx);
  const editing = (/** @type {string} */ id) => !section || section === id;

  if (editing('data')) {
    await planDataSources(ctx);
    if (!section) await askAdvanced(
      ctx,
      'the model and app, who can view, audit history, tenant size, the Lakehouse name, the new Key Vault\'s details, the schedule, the first load, the Value page currency and where Resource Graph reads',
    );
  }
  if (editing('governance')) {
    await planResourceGraph(ctx);
    await planFlows(ctx);
  }

  if (editing('powerbi')) {
    await planPowerBi(ctx, pre);
  }
  if (editing('access')) {
    if (config.semanticModel.enabled) await planAccess(ctx);
  }
  if (editing('sources')) {
    if (config.modules.consumption) {
      await planConsumption(ctx, pre);
      await planCowork(ctx);
    }
    config.modules = modulesFromSources(config.dataSources);
    if (config.modules.agentEvaluator) await planAgentEvaluator(ctx);
  }

  if (editing('schedule')) {
    if (config.firstRun?.status !== 'Completed') {
      delete ctx.reloadHistoryDays;
      if (advanced()) config.history.days = await ui.select('How much audit history should the first load pull?', HISTORY_CHOICES, config.history.days);
    } else {
      await askMoreHistory(ctx);
    }
  }

  const currentCapacity = () => pre.capacities.find((cap) => cap.id === config.fabric.capacityId);
  if (editing('placement')) {
    ui.heading('Fabric');
    ui.note(CAPACITY_HINT);
    const capacityChoices = pre.capacities.map((cap) => ({ name: capacityLabel(cap), value: cap.id }));
    config.fabric.capacityId = await ui.select(
      'Which capacity should run it?',
      capacityChoices,
      pre.capacities.some((cap) => cap.id === config.fabric.capacityId) ? config.fabric.capacityId : pre.capacities[0].id,
    );
    const capacity = pre.capacities.find((cap) => cap.id === config.fabric.capacityId);
    await planDataAgent(ctx, pre, capacity, advanced());
    const scale = config.scale ?? defaultScale(capacity, pre.seats);
    config.scale = !advanced()
      ? scale
      : await ui.select(
        'How many people are in the tenant?',
        [
          { name: 'Up to 10,000', value: 'standard' },
          { name: 'More than 10,000 (smaller audit windows, longer time limits; best on F64 or larger)', value: 'large' },
        ],
        scale,
      );
    for (const w of sizingWarnings({ seats: pre.seats, capacity, scale: config.scale })) ui.warn(w);
    if (config.fabric.workspaceId) {
      ui.ok(`Workspace: ${config.fabric.workspaceName ?? config.fabric.workspaceId}`);
    } else {
      const workspaces = (await api.fabric.listWorkspaces()).filter((w) => w.type === 'Workspace');
      const choice = await ui.select(
        'Workspace',
        [{ name: 'Create a new workspace', value: '' }, ...workspaces.map((w) => ({ name: `Use "${w.displayName}"`, value: w.id }))],
        '',
      );
      if (choice) {
        config.fabric.workspaceId = choice;
        config.fabric.workspaceName = workspaces.find((w) => w.id === choice)?.displayName;
      } else {
        const taken = new Set(workspaces.map((w) => w.displayName.toLowerCase()));
        config.fabric.workspaceName = await ui.input('New workspace name', {
          default: config.fabric.workspaceName ?? uniqueName(DEFAULT_WORKSPACE_NAME, taken),
          validate: (v) => (!v.trim() ? 'Required' : taken.has(v.trim().toLowerCase()) ? 'A workspace with that name exists.' : true),
        });
      }
    }
    if (!config.fabric.lakehouseId) {
      const ws = config.fabric.workspaceId;
      const lakehouses = ws ? await api.fabric.listItems(ws, 'Lakehouse') : [];
      const resumed = stoppedRunItem(config.fabric, 'Lakehouse', lakehouses);
      const taken = displayNames(lakehouses);
      if (resumed) config.fabric.lakehouseName = String(resumed.displayName);
      else {
        const suggested = freeName(config.fabric.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME, taken);
        const typed = advanced() ? await ui.input('Lakehouse name', { default: suggested, validate: validateNewLakehouseName(taken) }) : suggested;
        config.fabric.lakehouseName = lakehouseNameFrom(typed);
        if (config.fabric.lakehouseName !== typed.trim()) ui.note(`Fabric doesn't allow spaces or hyphens in Lakehouse names, so it'll be called ${config.fabric.lakehouseName}.`);
      }
    }
    await reserveNames(ctx);
  }

  if (editing('identity')) {
    const capacity = currentCapacity();
    ui.heading('App registration');
    /** Ask for the secret of an app the user brought, once the Key Vault section says where it goes. */
    let askSecret = false;
    let packWanted = false;
    if (config.app.appId) {
      ui.ok(`Using ${config.app.displayName ?? 'app'} (${config.app.appId})`);
      askSecret = !!section && !!config.app.existing && !config.keyVault.secretSetAt && !ctx.pendingSecret;
    } else {
      const blocked = pre.canCreateApps === false || !pre.canConsent || !!config.app.adminPack;
      const mode = await ui.select(
        'The notebooks sign in to Microsoft Graph as an app.',
        [
          { name: `Create "${APP_NAME}" (recommended)`, value: 'new' },
          { name: 'Use an app registration I already have', value: 'existing' },
          ...(blocked
            ? [{ name: 'An admin will register the app for me', value: 'admin', description: 'You get an admin pack: a Cloud Shell script and portal steps for an admin, who sends you back the client ID.' }]
            : []),
        ],
        config.app.adminPack || (pre.canCreateApps === false && !ui.yes) ? 'admin' : 'new',
      );
      if (mode === 'existing') {
        config.app.existing = true;
        await askAppId(ctx, pre);
        askSecret = true;
      } else if (mode === 'admin') {
        config.app.existing = true;
        packWanted = true;
      } else {
        config.app.existing = false;
      }
    }

    ui.heading('Key Vault for the app secret');
    if (config.keyVault.uri) {
      ui.ok(`Using ${config.keyVault.name} (${config.keyVault.uri})`);
    } else if (secretMode(config) === 'notebook' && !ctx.secretInNotebook && !ui.yes) {
      const keep = await ui.select(
        'Last time you chose no Key Vault: the client secret is in the notebooks.',
        [
          { name: 'Keep it in the notebooks', value: 'keep', description: 'No Key Vault. Anyone with a role in the workspace can read it.' },
          { name: 'Use Key Vault instead', value: 'vault', description: 'The notebooks read it from the vault at run time, so workspace roles don\'t expose it.' },
        ],
        'keep',
      );
      if (keep === 'vault') {
        delete config.keyVault.mode;
        // The secret was in the notebooks, not a vault: the new vault needs one written.
        delete config.keyVault.secretSetAt;
        delete config.keyVault.handoff;
        await planKeyVault(ctx, pre, capacity ? armLocation(capacity.region) : 'westeurope');
      }
    } else if (secretMode(config) === 'notebook') {
      ui.info('No Key Vault: the client secret is in the notebooks, where anyone with a role in the workspace can read it.');
    } else if (defaultsToNoVault(ctx)) {
      await chooseSecretHome(ctx, pre, capacity ? armLocation(capacity.region) : 'westeurope');
    } else {
      await planKeyVault(ctx, pre, capacity ? armLocation(capacity.region) : 'westeurope');
    }
    if (secretMode(config) === 'notebook' && !config.app.existing && advanced()) {
      const days = await ui.input(`Days before the client secret expires (1 to ${MAX_SECRET_DAYS}). Each install, repair or update replaces it.`, {
        default: String(notebookSecretDays(config)),
        validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= MAX_SECRET_DAYS ? true : `A whole number from 1 to ${MAX_SECRET_DAYS}.`),
      });
      if (Number(days) === NOTEBOOK_SECRET_DAYS) delete config.app.secretDays;
      else config.app.secretDays = Number(days);
    }
    const skipped = flowsSkipped(config);
    if (skipped.length) ui.note(`${skipped.join(' and ')} won't be set up: --flow-identity app reads the client secret from Key Vault. Run install --flow-identity user to have them sign in to OneLake instead.`);

    if (packWanted) askSecret = await planAdminPack(ctx, pre);
    if (askSecret && secretMode(config) !== 'keyvault-admin') {
      ctx.pendingSecret = await ui.secret(
        secretMode(config) === 'notebook'
          ? 'Client secret value (not the secret ID). It is written into the notebooks.'
          : 'Client secret value (not the secret ID). It goes straight to Key Vault.',
      );
    }
  }

  if (editing('schedule')) {
    if (section && ui.web) await editSchedule(ctx);
    else if (advanced()) {
      ui.heading('Schedule');
      const freq = await ui.select(
        'How often should the pipeline run?',
        [
          { name: 'Daily (recommended)', value: 'daily' },
          { name: 'Weekly', value: 'weekly' },
        ],
        config.schedule.frequency,
      );
      config.schedule.frequency = /** @type {'daily' | 'weekly'} */ (freq);
      if (freq === 'weekly') {
        config.schedule.weekday = await ui.select(
          'Which day?',
          ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ name: d, value: d })),
          config.schedule.weekday,
        );
      }
      config.schedule.time = await ui.input(`Time (${config.schedule.timeZone}, 24-hour)`, { default: config.schedule.time, validate: validateTime });
    }

    ctx.runFirstLoad = config.firstRun?.status === 'Completed' ? false : !advanced() || (await ui.confirm('Run the first load as soon as setup finishes?', true));

    if (advanced()) await askReportingCurrency(ctx);
  }
}

/**
 * The currency the Value page reports value and cost in, and optionally its rate to the US
 * dollar. It is the app's default until someone saves another under Prices in the app. Only asked
 * under the advanced settings; otherwise the saved choice, --currency, or US dollars.
 * @param {Ctx} ctx
 */
export async function askReportingCurrency(ctx) {
  const { ui, config } = ctx;
  ui.heading('Value page');
  const saved = config.reporting;
  const currency = await ui.select(
    'Which currency should the Value page report in?',
    CURRENCIES.map((cur) => ({
      name: `${cur.code} · ${cur.name}`,
      value: cur.code,
      ...(cur.code === DEFAULT_CURRENCY ? { description: 'Licences and credits are billed in US dollars, so no exchange rate is needed.' } : {}),
    })),
    saved?.currency ?? DEFAULT_CURRENCY,
  );
  if (currency === 'USD') {
    config.reporting = { currency };
    return;
  }
  const typed = await ui.input(`How many ${currency} to 1 US dollar? Leave blank to set it later under Prices in the app.`, {
    default: saved?.currency === currency && saved.exchangeRate ? String(saved.exchangeRate) : '',
    validate: (v) => {
      const rate = parseRate(v);
      return typeof rate === 'string' ? rate : true;
    },
  });
  const rate = parseRate(typed);
  config.reporting = typeof rate === 'number' ? { currency, exchangeRate: rate } : { currency };
}

/**
 * Where the client secret goes: a new vault, one the user has, or no vault (the notebooks).
 * A vault the user can't write secrets to can still be used: a vault admin adds the secret.
 * No vault is recommended when the user can't create a vault or write to the one they chose.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} location
 */
export async function planKeyVault(ctx, pre, location) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  if (ctx.secretInNotebook && (await confirmNotebookMode(ctx))) return;
  if (!pre.subscriptions.length) {
    ui.info('With no Azure subscription, there\'s nowhere to create a Key Vault for the client secret.');
    if (await confirmNotebookMode(ctx)) return;
    throw new Error('Key Vault needs an Azure subscription in this tenant. Ask for Contributor on one, or run the installer again and choose no Key Vault.');
  }
  kv.subscriptionId = await ui.select(
    'Azure subscription',
    pre.subscriptions.map((s) => ({ name: `${s.displayName} (${s.subscriptionId})`, value: s.subscriptionId })),
    pre.subscriptions.some((s) => s.subscriptionId === kv.subscriptionId) ? kv.subscriptionId : pre.subscriptions[0].subscriptionId,
  );
  const subscriptionId = /** @type {string} */ (kv.subscriptionId);

  const vaults = await api.arm.listVaults(subscriptionId).catch(() => []);
  let askGroup = asksAdvanced(ctx);
  for (;;) {
    const choice = await ui.select(
      'Vault',
      [
        { name: 'Create a new Key Vault', value: '' },
        ...vaults.map((v) => ({ name: `Use "${v.name}" (${v.location})`, value: v.id })),
        { name: NO_VAULT_NAME, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
      ],
      kv.existing && vaults.some((v) => v.id === kv.id) ? /** @type {string} */ (kv.id) : '',
    );
    if (choice === NOTEBOOK) {
      if (await confirmNotebookMode(ctx)) return;
      continue;
    }
    delete kv.mode;
    if (choice) {
      const v = vaults.find((x) => x.id === choice);
      kv.existing = true;
      kv.id = v.id;
      kv.name = v.name;
      kv.resourceGroup = v.id.split('/')[4];
      kv.location = v.location;
      if (!(await canWriteSecrets(ctx, v))) {
        ui.warn(
          `You can't write secrets to ${v.name}: that needs Key Vault Secrets Officer${v.properties?.enableRbacAuthorization ? '' : ' or an access policy with secret set'}, and you can't give it to yourself.`,
        );
        const how = await ui.select(
          'How should the client secret get there?',
          [
            { name: `${NO_VAULT_NAME} (recommended)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
            { name: 'A vault admin will add the secret for me', value: 'keyvault-admin', description: 'You get the exact steps to send them. You only need to read the secret.' },
            { name: 'Pick another vault', value: 'other' },
          ],
          // With --yes, no vault takes --no-key-vault, so the vault admin is the answer that needs no flag.
          ui.yes ? 'keyvault-admin' : NOTEBOOK,
        );
        if (how === 'other') continue;
        if (how === NOTEBOOK) {
          if (await confirmNotebookMode(ctx)) return;
          continue;
        }
        kv.mode = 'keyvault-admin';
        ui.note('Once the app registration exists, the installer shows the steps to send the vault admin, then carries on when you say the secret is there.');
      }
    } else {
      kv.existing = false;
      await askResourceGroup(ctx, subscriptionId, askGroup);
      // Contributor on just the resource group is enough for the vault, so roles are checked where it goes.
      const group = await api.arm.getResourceGroup(subscriptionId, /** @type {string} */ (kv.resourceGroup)).catch(() => null);
      const scope = group ? `/subscriptions/${subscriptionId}/resourceGroups/${kv.resourceGroup}` : `/subscriptions/${subscriptionId}`;
      const perms = await api.arm.permissions(scope).catch(() => null);
      // Unknown permissions aren't a no: the vault step reports a real failure.
      if (perms && !allowsAction(perms, 'Microsoft.KeyVault/vaults/write')) {
        ui.warn(`You can't create a Key Vault in ${group ? kv.resourceGroup : 'this subscription'}: that needs Contributor there.`);
        const how = await ui.select(
          'Where should the client secret go?',
          [
            { name: `${NO_VAULT_NAME} (recommended)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
            { name: 'Pick a vault or resource group', value: 'other' },
          ],
          NOTEBOOK,
        );
        if (how === NOTEBOOK && (await confirmNotebookMode(ctx))) return;
        if (ui.yes) throw new Error(`You can't create a Key Vault in ${group ? kv.resourceGroup : 'this subscription'}. Add --no-key-vault to keep the client secret in the notebooks, or ask for Contributor there.`);
        askGroup = true;
        continue;
      }
      kv.location = asksAdvanced(ctx) ? await ui.input('Azure region', { default: kv.location ?? location }) : kv.location ?? location;
      const suggested = kv.name ?? `valuelens-${randomBytes(3).toString('hex')}`;
      kv.name = asksAdvanced(ctx) ? await ui.input('Vault name (globally unique)', { default: suggested, validate: validateVaultName }) : suggested;
      const available = await api.arm.checkVaultName(subscriptionId, kv.name);
      if (!available.nameAvailable) throw new Error(`Key Vault name "${kv.name}" is taken: ${available.message ?? 'choose another'}.`);
      kv.rbac = !!perms && allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write');
      if (!kv.rbac) ui.note('You can\'t assign Azure roles here, so the vault will use access policies instead of Azure RBAC.');
    }
    if (kv.mode !== 'keyvault-admin') delete kv.handoff;
    break;
  }
  if (asksAdvanced(ctx)) kv.secretName = await ui.input('Secret name', { default: kv.secretName, validate: (v) => (/^[0-9a-zA-Z-]{1,127}$/.test(v) ? true : 'Letters, digits and hyphens only.') });
}

const NOTEBOOK = 'notebook';
const NO_VAULT_NAME = 'No Key Vault: keep the secret in the notebooks';
const NO_VAULT_DESCRIPTION = 'Nothing in Azure. Anyone with a role in the workspace can read the secret; Key Vault avoids that.';

/**
 * Whether the secret's home is still open and no Key Vault is the default: a new Fabric install
 * that hasn't picked a vault, without --key-vault or flows that read the secret from the vault.
 * @param {Ctx} ctx
 */
export function defaultsToNoVault(ctx) {
  const { config } = ctx;
  const kv = config.keyVault;
  if (config.target === 'azure' || ctx.useKeyVault || flowIdentity(config) === 'app') return false;
  return !kv.uri && !kv.mode && !kv.name && !kv.id && !kv.subscriptionId;
}

/**
 * A new install: no Key Vault by default, or Key Vault.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} location
 */
async function chooseSecretHome(ctx, pre, location) {
  const { ui } = ctx;
  const where = ctx.secretInNotebook
    ? NOTEBOOK
    : await ui.select(
        'Where should the app\'s client secret go?',
        [
          { name: `${NO_VAULT_NAME} (default)`, value: NOTEBOOK, description: NO_VAULT_DESCRIPTION },
          { name: 'Azure Key Vault', value: 'keyvault', description: 'Needs an Azure subscription where you can create or use a vault. The notebooks read the secret at run time, so workspace roles don\'t expose it.' },
        ],
        NOTEBOOK,
      );
  if (where === NOTEBOOK && (await confirmNotebookMode(ctx, true))) return;
  await planKeyVault(ctx, pre, location);
}

/**
 * The resource group for a new vault. Someone with Contributor on a resource group but not the
 * subscription can't create groups, so they're asked for one that exists.
 * @param {Ctx} ctx
 * @param {string} subscriptionId
 * @param {boolean} [askFirst]  Ask even when the saved or default group would do.
 */
async function askResourceGroup(ctx, subscriptionId, askFirst = asksAdvanced(ctx)) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  for (let ask = askFirst; ; ask = true) {
    const name = kv.resourceGroup ?? 'rg-valuelens';
    kv.resourceGroup = (ask ? await ui.input('Resource group (created if missing)', { default: name }) : name).trim();
    if (await api.arm.getResourceGroup(subscriptionId, kv.resourceGroup).catch(() => null)) return;
    const perms = await api.arm.permissions(`/subscriptions/${subscriptionId}`).catch(() => null);
    if (!perms || allowsAction(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write')) return;
    ui.warn(`There's no resource group called ${kv.resourceGroup} that you can see, and you can't create one in this subscription. Give the name of one you have Contributor on.`);
    if (ui.yes) return;
  }
}

/**
 * Shows what no Key Vault means, then asks. Returns true when the user agrees.
 * With --yes, --no-key-vault (or --secret-in-notebook) is the agreement, or no Key Vault being the default.
 * @param {Ctx} ctx
 * @param {boolean} [byDefault]  No Key Vault is the default here, so --yes takes it.
 */
async function confirmNotebookMode(ctx, byDefault = false) {
  const { ui, config } = ctx;
  ui.warn('No Key Vault: the client secret is written into the notebooks as plain text.');
  ui.info('  - Anyone with a role in the workspace, Viewer included, or anyone a notebook is shared with, can read it');
  ui.info('    and use it to read your tenant\'s data through Microsoft Graph.');
  ui.info('  - It is copied into notebook run snapshots, exports and deployment pipelines. The installer won\'t write it');
  ui.info('    into a workspace that is connected to Git.');
  ui.info(`  - It lasts ${notebookSecretDays(config)} days. Each install, repair or update replaces it and removes the old one.`);
  ui.info('Key Vault avoids this: the notebooks read the secret from the vault at run time, so a workspace role doesn\'t expose it.');
  const ok = ui.yes ? !!ctx.secretInNotebook || byDefault : await ui.confirm('Keep the client secret in the notebooks, with no Key Vault?', true);
  if (ui.yes && !ok) ui.note('With --yes, add --no-key-vault to choose this.');
  if (!ok) return false;
  config.keyVault.mode = 'notebook';
  delete config.keyVault.handoff;
  return true;
}

/**
 * Asks for the client ID of an app the user brought, and checks it has what the install needs
 * before anything is created.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'canConsent'>} pre
 */
export async function askAppId(ctx, pre) {
  const { ui, config } = ctx;
  for (;;) {
    config.app.appId = (
      await ui.input('Application (client) ID', { default: config.app.appId, validate: (v) => (isGuid(v) ? true : 'Paste the GUID from the app\'s Overview page.') })
    ).trim();
    for (;;) {
      const check = await checkExistingApp(ctx, ctx.liveApi ?? ctx.api);
      if (check.displayName) config.app.displayName = check.displayName;
      if (reportAppCheck(ctx, check, pre)) return;
      if (ui.yes) {
        if (!check.found) throw new Error(`No app registration with ID ${config.app.appId} in this tenant.`);
        ui.warn('Carrying on. Data the missing permissions cover won\'t load until an admin fixes them.');
        return;
      }
      const next = await ui.select(
        'What next?',
        [
          { name: 'Check again', value: 'again', description: 'Once an admin has fixed it.' },
          { name: 'Enter a different client ID', value: 'other' },
          ...(check.found ? [{ name: 'Carry on anyway', value: 'go', description: 'Data the missing permissions cover won\'t load until they\'re fixed.' }] : []),
        ],
        'again',
      );
      if (next === 'go') {
        ui.warn('Carrying on with the app as it is.');
        return;
      }
      if (next === 'other') break;
    }
  }
}

/**
 * Writes the admin pack for someone who can't register apps or grant consent, then waits for
 * the client ID. Returns true when the user still needs to paste the secret.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'canConsent'>} pre
 */
export async function planAdminPack(ctx, pre) {
  const { ui, config } = ctx;
  const kv = config.keyVault;
  const file = writeAdminPack(ctx);
  config.app.adminPack = file;
  ui.heading('Admin pack');
  ui.warn('An admin needs to register the app. Send them this file:');
  ui.info(file);
  ui.info('Or they can run this in Azure Cloud Shell (Bash):');
  for (const line of adminPack(ctx).script) ui.info(`  ${line}`);
  ctx.save();
  if (ui.yes) throw new ResumeLater('Stopped until an admin has registered the app. Once they send you its client ID, run the installer again without --yes.');
  const next = await ui.select(
    'Has the admin sent you the client ID?',
    [
      { name: 'Yes, enter it now', value: 'go' },
      { name: 'Stop and resume later', value: 'stop', description: 'Your answers are saved. Run the installer again once you have it.' },
    ],
    'go',
  );
  if (next === 'stop') throw new ResumeLater(`Stopped until an admin has registered the app. Send them ${file}, then run the installer again.`);
  await askAppId(ctx, pre);
  if (secretMode(config) === 'keyvault-admin' && kv.name) {
    if (await ui.confirm(`Did the admin's script also put the client secret in ${kv.name}?`, true)) {
      kv.handoff = { ...kv.handoff, confirmedAt: ctx.now().toISOString() };
      kv.secretSetAt = kv.handoff.confirmedAt;
    }
    return false;
  }
  return true;
}

/**
 * @param {string} base
 * @param {Set<string>} taken  Lower-case names.
 */
export function uniqueName(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Names a new install suggests. Existing installs keep the names in their record. */
export const DEFAULT_WORKSPACE_NAME = 'Analytics Hub';
/** Fabric Lakehouse names can't have spaces. */
export const DEFAULT_LAKEHOUSE_NAME = 'Analytics_Hub';

export const CAPACITY_HINT = 'F64 or larger is recommended for more than 10,000 people; small or trial capacities work but loads are slower.';

/**
 * A capacity as a choice: its name, then the SKU and region when Fabric gives them.
 * @param {{ displayName?: string, id: string, sku?: string, region?: string }} cap
 */
export function capacityLabel(cap) {
  const about = [cap.sku, cap.region].filter(Boolean).join(', ');
  return `${cap.displayName ?? cap.id}${about ? ` (${about})` : ''}`;
}

/**
 * The name to start from: the default when `name` is the default or a numbered copy of it,
 * otherwise `name`, which someone chose.
 * @param {string | undefined} name
 * @param {string} base
 */
const startFrom = (name, base) => (!name || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ _]\\d+$`, 'i').test(name) ? base : name);

/**
 * Picks names for the Fabric items the install will create that no item already in the
 * workspace has, so the install never touches anything it didn't create.
 * @param {Ctx} ctx
 */
export async function reserveNames(ctx) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  const sm = config.semanticModel;
  const cc = config.consumption;
  const ae = config.agentEvaluator;
  const ws = f.workspaceId;
  const list = async (/** @type {string} */ type) => (ws ? /** @type {any[]} */ (await api.fabric.listItems(ws, type)) : []);
  const [notebookItems, pipelineItems, modelItems, reportItems, agentItems] = await Promise.all([
    list('Notebook'),
    list('DataPipeline'),
    list('SemanticModel'),
    list('Report'),
    dataAgentWanted(ctx) ? list(DATA_AGENT_TYPE) : [],
  ]);
  const [notebookNames, pipelineNames, modelNames, reportNames, agentNames] = [notebookItems, pipelineItems, modelItems, reportItems, agentItems].map(displayNames);
  /** @type {string[]} */
  const renamed = [];
  /**
   * Keeps the name of an item a run that stopped part-way created, so it's used again, not renamed.
   * @param {string} key @param {any[]} items @param {string} wanted @param {string[]} taken
   */
  const pick = (key, items, wanted, taken) => {
    const resumed = stoppedRunItem(f, key, items);
    if (resumed) return String(resumed.displayName);
    const name = freeName(wanted, taken);
    if (name !== wanted) renamed.push(wanted);
    taken.push(name);
    return name;
  };

  const notebooks = notebooksFor(config.modules, {
    semanticModel: !!sm.enabled,
    azureAi: !!config.modules.consumption && !!cc.azureSubscriptionId,
    dataverse: !!config.modules.agentEvaluator && ae.environments.length > 0,
    access: rlsOn(config),
    dataSources: config.dataSources,
  });
  f.notebookNames ??= {};
  for (const nb of notebooks) {
    if (!f.notebooks[nb.key]) f.notebookNames[nb.key] = pick(`Notebook:${nb.key}`, notebookItems, startFrom(f.notebookNames[nb.key], nb.displayName), notebookNames);
  }
  if (!f.pipelineId) f.pipelineName = pick('DataPipeline', pipelineItems, startFrom(f.pipelineName, PIPELINE_NAME), pipelineNames);
  /** @param {import('../config.js').ModelConfig} m @param {string} base */
  const model = (m, base) => pick(`SemanticModel:${modelKey(config, m)}`, modelItems, startFrom(m.name, base), modelNames);
  if (sm.enabled && !sm.id) sm.name = model(sm, MODEL_NAME);
  if (sm.enabled && consumptionModelWanted(ctx) && !cc.model.id) cc.model.name = model(cc.model, CONSUMPTION_MODEL_NAME);
  if (sm.enabled && agentEvaluatorModelWanted(ctx) && !ae.model.id) ae.model.name = model(ae.model, AGENT_EVALUATOR_MODEL_NAME);
  for (const w of reportsWanted(ctx)) {
    if (!w.model.report?.id) w.model.report = { ...w.model.report, name: pick(`Report:${modelKey(config, w.model)}`, reportItems, startFrom(w.model.report?.name, w.name), reportNames) };
  }
  const da = config.dataAgent;
  if (dataAgentWanted(ctx) && !da.id) da.name = pick('DataAgent', agentItems, startFrom(da.name, DATA_AGENT_NAME), agentNames);

  if (renamed.length) {
    ui.note(
      `The workspace already has ${renamed.map((n) => `"${n}"`).join(', ')}, not from this install. They're left as they are; Analytics Hub's own items get the names shown in the plan.`,
    );
  }
}

/**
 * @typedef {{ kind: string, name: string, detail?: string, isNew: boolean }} ReviewItem
 * @typedef {{ who: string, what: string, where: string, detail?: string }} ReviewGrant
 * @typedef {{ what: string, where: string, detail?: string }} ReviewRun
 * @typedef {{ what: string, detail?: string, url: string }} ReviewCost
 * @typedef {{ creates: ReviewItem[], grants: ReviewGrant[], runsOn: ReviewRun[], costs?: ReviewCost[] }} PlanReview
 */

export const PRICING = {
  fabric: 'https://azure.microsoft.com/pricing/details/microsoft-fabric/',
  powerAutomate: 'https://www.microsoft.com/power-platform/products/power-automate/pricing',
  keyVault: 'https://azure.microsoft.com/pricing/details/key-vault/',
  azure: 'https://azure.microsoft.com/pricing/calculator/',
};

/**
 * What the install adds to the bill, each with where its prices are. No prices here: they change
 * and differ by region and agreement.
 * @param {import('../config.js').InstallConfig} config
 * @returns {ReviewCost[]}
 */
export function planCosts(config) {
  const azure = config.target === 'azure';
  /** @type {ReviewCost[]} */
  const costs = [];
  if (!azure) costs.push({ what: 'Fabric capacity', detail: 'Runs the notebooks, pipeline and reports. Billed by capacity size; a trial capacity is free while it lasts.', url: PRICING.fabric });
  if (flowsWanted(config).length) costs.push({ what: 'Power Automate Premium', detail: 'A licence for whoever signs in to the flows.', url: PRICING.powerAutomate });
  if (azure) costs.push({ what: 'Azure resources', detail: 'Azure SQL, the Container Apps jobs, the web app and storage, billed to your Azure subscription.', url: PRICING.azure });
  else if (secretMode(config) !== 'notebook') costs.push({ what: 'Azure Key Vault', detail: 'Holds the app\'s client secret. Billed to your Azure subscription.', url: PRICING.keyVault });
  return costs;
}

/**
 * What the plan creates, who it gives access to what, and where it runs: the record a
 * reviewer reads before saying go ahead.
 * @param {Ctx} ctx
 * @param {Pick<Preflight, 'capacities' | 'subscriptions' | 'canConsent'>} [pre]
 * @returns {PlanReview}
 */
export function planReview(ctx, pre) {
  const { config, user } = ctx;
  const f = config.fabric;
  const kv = config.keyVault;
  const sm = config.semanticModel;
  const fa = config.fabricApp;
  const cc = config.consumption;
  const ae = config.agentEvaluator;
  const appName = config.app.appId ? config.app.displayName ?? config.app.appId : APP_NAME;
  const withAzureAi = !!config.modules.consumption && !!cc.azureSubscriptionId;
  const withTranscripts = !!config.modules.agentEvaluator && ae.environments.length > 0;
  const notebooks = notebooksFor(config.modules, { semanticModel: !!sm.enabled, azureAi: withAzureAi, dataverse: withTranscripts, access: rlsOn(config), dataSources: config.dataSources });

  const mode = secretMode(config);
  /** @type {ReviewItem[]} */
  const creates = [
    {
      kind: 'App registration',
      name: appName,
      isNew: !config.app.appId,
      detail:
        config.app.adminPack && !config.app.appId
          ? 'An admin registers it from the admin pack and sends you its client ID.'
          : mode === 'notebook'
            ? config.app.existing
              ? 'Yours. A client secret you paste is written into the notebooks; no Key Vault.'
              : `Its client secret is written into the notebooks, lasts ${notebookSecretDays(config)} days and is replaced on each install, repair or update. No Key Vault.`
            : mode === 'keyvault-admin'
              ? `${config.app.existing ? 'Yours. ' : ''}A vault admin adds its client secret to Key Vault.`
              : config.app.existing
                ? 'Yours. A client secret you paste goes straight to Key Vault.'
                : 'Signs in to Microsoft Graph for the notebooks, with a client secret kept in Key Vault.',
    },
    mode === 'notebook'
      ? {
          kind: 'Client secret',
          name: 'In the notebooks (no Key Vault)',
          // Every install, repair or update writes a fresh secret.
          isNew: true,
          detail: 'Anyone with a role in the workspace, Viewer included, can read it; also in run snapshots, exports and deployment pipelines. Key Vault avoids that.',
        }
      : {
          kind: 'Key Vault',
          name: kv.name ?? 'Not chosen',
          isNew: !kv.existing && !kv.uri,
          detail: [
            kv.existing || kv.uri ? undefined : `In resource group ${kv.resourceGroup}, ${kv.location}, using ${kv.rbac ? 'Azure RBAC' : 'access policies'}.`,
            `Holds the secret "${kv.secretName}".`,
            mode === 'keyvault-admin' ? 'A vault admin adds it; you get their steps.' : undefined,
          ]
            .filter(Boolean)
            .join(' '),
        },
    { kind: 'Workspace', name: f.workspaceName ?? f.workspaceId ?? 'Not chosen', isNew: !f.workspaceId },
    { kind: 'Lakehouse', name: f.lakehouseName ?? DEFAULT_LAKEHOUSE_NAME, isNew: !f.lakehouseId },
    {
      kind: 'Notebooks',
      name: `${notebooks.length} notebooks`,
      isNew: notebooks.some((nb) => !f.notebooks[nb.key]),
      detail: notebooks.map((nb) => f.notebookNames?.[nb.key] ?? nb.displayName).join(', '),
    },
    { kind: 'Pipeline', name: f.pipelineName ?? PIPELINE_NAME, isNew: !f.pipelineId, detail: `Runs the notebooks ${describeSchedule(config.schedule)}.` },
  ];
  if (routerWanted(config.dataSources)) {
    const n = ctx.pendingUploads?.length ?? 0;
    creates.push({
      kind: 'Folder',
      name: UPLOAD_DIR,
      isNew: !config.uploads.folders,
      detail: `Drop exports here; each run loads them.${n ? ` ${n} file${n === 1 ? '' : 's'} uploaded now.` : ''}`,
    });
  }
  if (config.modules.consumption && config.dataSources.coworkCredits === 'api') {
    creates.push({ kind: 'Dataflow Gen2', name: cc.dataflowName ?? COWORK_DATAFLOW_NAME, isNew: !cc.dataflowId, detail: 'Reads Cowork credits from your Viva Insights query before each Viva load.' });
  }
  const env = config.uploads.flowEnvironment;
  for (const kind of flowsWanted(config)) {
    creates.push({
      kind: 'Power Automate flow',
      name: FLOW_NAMES[kind],
      isNew: !config.uploads.flowIds?.[kind],
      detail: env ? `In ${env.name ?? env.url}, turned off. The installer helps you sign in to its connections, then turns it on.` : 'Written to a file to import.',
    });
  }
  if (sm.enabled) {
    const modelItem = (/** @type {{ name: string, id?: string }} */ m) => ({ kind: 'Semantic model', name: m.name, isNew: !m.id, ...(m.id ? { detail: MODEL_UPDATE_NOTE } : {}) });
    creates.push(modelItem(sm));
    if (consumptionModelWanted(ctx)) creates.push(modelItem(cc.model));
    if (agentEvaluatorModelWanted(ctx)) creates.push(modelItem(ae.model));
    creates.push({
      kind: 'Connection',
      name: sm.connectionName ?? (f.workspaceId ? connectionName(f.workspaceId) : 'Analytics Hub SQL connection'),
      isNew: !sm.connectionId,
      detail: 'Lets the models read the Lakehouse, with a second client secret that only the connection holds.',
    });
    if (fa.enabled) creates.push({ kind: 'Fabric app', name: fa.name ?? 'Analytics Hub', isNew: !fa.itemId, detail: `A web app in the workspace, built on the semantic model. ${describeReporting(config.reporting)}` });
    for (const w of reportsWanted(ctx)) {
      creates.push({ kind: 'Report', name: w.model.report?.name ?? w.name, isNew: !w.model.report?.id, detail: `From its Power BI template, reading ${w.model.name}.` });
    }
    if (dataAgentWanted(ctx)) {
      creates.push({
        kind: 'Data agent',
        name: config.dataAgent.name,
        isNew: !config.dataAgent.id,
        detail: 'Answers questions in plain language from the semantic models, for the app\'s Ask page. Published to Microsoft 365 Copilot by hand.',
      });
    }
  }
  const access = sm.enabled ? accessReview(config, `Semantic models in workspace ${f.workspaceName ?? f.workspaceId}`) : { creates: [], grants: [] };
  creates.push(...fabricReadRoleReview(config));
  creates.push(...access.creates);

  const appWho = `${appName} (app)`;
  /** @type {ReviewGrant[]} */
  const grants = [
    {
      who: appWho,
      what: `Microsoft Graph application permissions: ${permissionsFor(config.modules, config.dataSources).join(', ')}`,
      where: 'Your tenant, through admin consent',
      detail: pre && !pre.canConsent ? 'You can\'t grant it yourself. You get a link for a Global Administrator or Privileged Role Administrator to approve.' : undefined,
    },
  ];
  if (!kv.uri && mode === 'keyvault-admin') {
    grants.push({
      who: `${user.upn} (you)`,
      what: kv.rbac === false ? 'An access policy with secret get and list' : 'Key Vault Secrets User, or an access policy with secret get and list if the vault doesn\'t use Azure RBAC',
      where: `Key Vault ${kv.name}`,
      detail: 'Read only, so scheduled runs can read the secret. Only when you don\'t have it already; if you can\'t give it to yourself, the vault admin\'s steps include it.',
    });
  } else if (!kv.uri && mode === 'keyvault') {
    grants.push({
      who: `${user.upn} (you)`,
      what: kv.existing
        ? 'Key Vault Secrets Officer, or an access policy with secret get, list and set if the vault doesn\'t use Azure RBAC'
        : kv.rbac === false
          ? 'An access policy with secret get, list and set'
          : 'Key Vault Secrets Officer, so you can write the secret',
      where: `Key Vault ${kv.name}`,
      detail: kv.existing ? 'Only when you don\'t have it already.' : undefined,
    });
  }
  if (sm.enabled) grants.push({ who: appWho, what: 'Viewer', where: `Workspace ${f.workspaceName ?? f.workspaceId}`, detail: 'So the semantic models can read the Lakehouse.' });
  grants.push(...access.grants);
  const flows = flowsWanted(config);
  if (flows.length && flowIdentity(config) === 'app') {
    grants.push({ who: appWho, what: 'Contributor', where: `Workspace ${f.workspaceName ?? f.workspaceId}`, detail: 'So the Power Automate flows can save files to the drop folder.' });
  } else if (flows.length) {
    grants.push({
      who: 'Whoever signs in to the flows\' OneLake connection',
      what: 'Contributor or higher',
      where: `Workspace ${f.workspaceName ?? f.workspaceId}`,
      detail: 'Not granted by the installer. You have it already; give it to anyone else who signs in.',
    });
  }
  if (withAzureAi && !cc.azureAccess) {
    grants.push({ who: appWho, what: AZURE_AI_ROLES.map((r) => r.name).join(', '), where: `Azure subscription ${cc.azureSubscriptionName ?? cc.azureSubscriptionId}`, detail: 'So the notebook can read Azure AI usage and cost.' });
  }
  grants.push(...resourceGraphGrants(config, user.tenantId, appWho, 'access', { canAssign: pre?.canConsent }));
  const waiting = ae.environments.filter((e) => !e.access || !e.readAll);
  if (config.modules.agentEvaluator && waiting.length) {
    grants.push({
      who: appWho,
      what: `Application user with the ${TRANSCRIPT_ROLE} role and a role that reads every transcript`,
      where: waiting.map((e) => e.name ?? new URL(e.url).host).join(', '),
      detail: 'So the notebook can read every Copilot Studio transcript from Dataverse.',
    });
  }

  const capacity = pre?.capacities.find((cap) => cap.id === f.capacityId);
  const subscription = pre?.subscriptions.find((s) => s.subscriptionId === kv.subscriptionId);
  /** @type {ReviewRun[]} */
  const runsOn = [
    {
      what: sm.enabled ? `Notebooks, pipeline, semantic models${reportsWanted(ctx).length ? ', reports' : ''}${fa.enabled ? ' and the app' : ''}` : 'Notebooks and pipeline',
      where: capacity ? `Fabric capacity ${capacity.displayName} (${capacity.sku}, ${capacity.region})` : `Fabric capacity ${f.capacityId ?? 'not chosen'}`,
    },
    ...(mode === 'notebook' ? [] : [{ what: 'Key Vault', where: `Azure subscription ${subscription?.displayName ?? kv.subscriptionId ?? 'already chosen'}`, detail: 'Standard tier.' }]),
    {
      what: 'Scheduled runs',
      where: `${describeSchedule(config.schedule)}, as ${user.upn}`,
      detail: mode === 'notebook' ? 'The schedule\'s owner refreshes the models; the secret is in the notebooks.' : 'The schedule\'s owner reads the secret and refreshes the models.',
    },
  ];
  if (ctx.runFirstLoad) runsOn.push({ what: 'First load', where: `${config.history.days} days of audit history, straight after setup` });
  if (ctx.reloadHistoryDays) runsOn.push({ what: 'History reload', where: reloadLine(ctx.reloadHistoryDays), detail: reloadDetail(ctx.reloadHistoryDays) });
  return { creates, grants, runsOn, costs: planCosts(config) };
}

/** @param {number} days */
export const reloadLine = (days) => `Reload ${days} days of history after setup`;

/**
 * How long a reload takes.
 * @param {number} days
 */
export const reloadDetail = (days) =>
  days > 30 ? 'One pipeline run: a few hours, and many hours on a large tenant. The scheduled runs carry on after it.' : 'One pipeline run, usually under an hour.';

/**
 * Prints the plan and asks to go ahead.
 * @param {Ctx} ctx
 * @param {Preflight} [pre]
 */
export async function confirmPlan(ctx, pre) {
  const { ui, config } = ctx;
  const mods = collectedLabels(config.modules);
  ui.heading('Ready to set up');
  ui.info(`Data:        ${mods.join(', ')}`);
  const exports = DATA_SOURCES.filter((s) => config.dataSources[s.id] === 'csv').map((s) => s.label);
  if (exports.length) ui.info(`Exports:     ${exports.join(', ')} ${c.dim(`(dropped in ${UPLOAD_DIR})`)}`);
  const uploads = ctx.pendingUploads ?? [];
  if (uploads.length) ui.info(`Uploading:   ${uploads.map((u) => u.name).join(', ')}`);
  ui.info(`Workspace:   ${config.fabric.workspaceName ?? config.fabric.workspaceId} ${config.fabric.workspaceId ? '' : c.dim('(new)')}`);
  ui.info(`Lakehouse:   ${config.fabric.lakehouseName}`);
  ui.info(`App:         ${config.app.appId ? config.app.appId : `${APP_NAME} ${c.dim('(new)')}`}`);
  const kvMode = secretMode(config);
  if (kvMode === 'notebook') ui.info(`Secret:      in the notebooks ${c.dim(`(no Key Vault: anyone with a role in the workspace can read it; lasts ${notebookSecretDays(config)} days)`)}`);
  else if (kvMode === 'keyvault-admin') ui.info(`Key Vault:   ${config.keyVault.name} ${c.dim('(a vault admin adds the secret)')}`);
  else ui.info(`Key Vault:   ${config.keyVault.name} ${config.keyVault.existing || config.keyVault.uri ? '' : c.dim(`(new, ${config.keyVault.rbac ? 'Azure RBAC' : 'access policies'})`)}`);
  ui.info(`Schedule:    ${config.schedule.frequency === 'weekly' ? `${config.schedule.weekday}s` : 'Daily'} at ${config.schedule.time} ${config.schedule.timeZone}`);
  const seats = pre?.seats ? c.dim(` (${seatCount(pre.seats)} Copilot seats assigned)`) : '';
  ui.info(`Tenant size: ${config.scale === 'large' ? 'large (more than 10,000 people)' : 'standard (up to 10,000 people)'}${seats}`);
  const capacity = pre?.capacities.find((cap) => cap.id === config.fabric.capacityId);
  for (const w of sizingWarnings({ seats: pre?.seats, capacity, scale: config.scale })) ui.warn(w);
  if (config.semanticModel.enabled) {
    const cm = config.consumption.model;
    const consumption = consumptionModelWanted(ctx) ? `, ${cm.name} ${cm.id ? '' : c.dim('(new)')}`.trimEnd() : '';
    const am = config.agentEvaluator.model;
    const evaluator = agentEvaluatorModelWanted(ctx) ? `, ${am.name} ${am.id ? '' : c.dim('(new)')}`.trimEnd() : '';
    const app = config.fabricApp.enabled ? `, and the Analytics Hub app ${config.fabricApp.itemId ? '' : c.dim('(new)')}` : '';
    ui.info(`Power BI:    ${config.semanticModel.name} ${config.semanticModel.id ? '' : c.dim('(new)')}`.trimEnd() + consumption + evaluator + app.trimEnd());
    const reports = reportsWanted(ctx).map((w) => `${w.model.report?.name ?? w.name} ${w.model.report?.id ? '' : c.dim('(new)')}`.trimEnd());
    if (reports.length) ui.info(`Reports:     ${reports.join(', ')}`);
    if (dataAgentWanted(ctx)) ui.info(`Ask:         ${config.dataAgent.name} ${config.dataAgent.id ? '' : c.dim('(new data agent)')}`.trimEnd());
  }
  if (config.modules.consumption) {
    const cc = config.consumption;
    ui.info(`Azure AI:    ${cc.azureSubscriptionId ? `${cc.azureSubscriptionName ?? cc.azureSubscriptionId}${cc.azureAccess ? '' : c.dim(' (the app gets Reader, Cost Management Reader and Monitoring Reader)')}` : c.dim('left out')}`);
  }
  if (config.modules.agentEvaluator) {
    const envs = config.agentEvaluator.environments;
    const names = envs.map((e) => e.name ?? new URL(e.url).host).join(', ');
    const waiting = envs.some((e) => !e.access || !e.readAll) ? c.dim(' (the app is added to each with the Bot Transcript Viewer role and a role that reads every transcript)') : '';
    ui.info(`Agents:      ${envs.length ? `${names}${waiting}` : c.dim('no environments chosen')}`);
  }
  if (resourceGraphOn(config)) ui.info(`Governance:  ${resourceGraphKinds(config)} from Azure Resource Graph, in ${scopeName(config)}`);
  if (ctx.runFirstLoad) ui.info(`First load:  ${config.history.days} days of history, straight after setup`);
  if (ctx.reloadHistoryDays) ui.info(`History:     ${reloadLine(ctx.reloadHistoryDays)} ${c.dim(`(${reloadDetail(ctx.reloadHistoryDays)})`)}`);
  ui.review(planReview(ctx, pre));
  ui.note(keepAwake());
  return ui.confirm('Go ahead?', true);
}

/** Said before Go ahead: a PC that sleeps stops the setup part way. */
export const KEEP_AWAKE = 'Keep this PC plugged in and awake until setup finishes.';
/** The same in Azure Cloud Shell, where closing the tab ends the session. */
export const KEEP_CLOUD_SHELL_OPEN = 'Keep this Cloud Shell tab open until setup finishes.';
/** @param {NodeJS.ProcessEnv} [env] */
export const keepAwake = (env = process.env) => (inCloudShell(env) ? KEEP_CLOUD_SHELL_OPEN : KEEP_AWAKE);
