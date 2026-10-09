// @ts-check
/**
 * Checks the tenant, then asks every question up front so the rest of the
 * install can run unattended.
 */
import { randomBytes } from 'node:crypto';
import { collectedLabels, ESSENTIAL_MODULES, MODULES, notebooksFor, OPTIONAL_MODULES, permissionsFor } from '../catalog.js';
import { allowsAction, armLocation, validateVaultName } from '../clients/azure.js';
import { TRANSCRIPT_ROLE } from '../clients/dataverse.js';
import { APP_ROLES, CONSENT_ROLES } from '../clients/graph.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { c } from '../ui.js';
import { AGENT_EVALUATOR_MODEL_NAME, CONSUMPTION_MODEL_NAME, flowIdentity, MODEL_NAME, secretMode } from '../config.js';
import { MIN_NODE, nodeVersionOk } from './app.js';
import { agentEvaluatorModelWanted, planAgentEvaluator } from './agent-evaluator.js';
import { AZURE_AI_ROLES, consumptionModelWanted, COWORK_DATAFLOW_NAME, planConsumption, planCowork } from './consumption.js';
import { flowsSkipped, flowsWanted } from './flows.js';
import { adminPack, canWriteSecrets, checkExistingApp, reportAppCheck, ResumeLater, writeAdminPack } from './identity.js';
import { FEEDBACK_FLOW_NAME, STUDIO_FLOW_NAME } from '../transform/flows.js';
import { describeSchedule, displayNames, freeName, PIPELINE_NAME } from './fabric.js';
import { connectionName } from './model.js';
import { reportsWanted } from './report.js';
import { planDataSources } from './data-sources.js';
import { DATA_SOURCES, modulesFromSources, routerWanted, UPLOAD_DIR } from '../uploads.js';

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

/**
 * Premium Per User (PP), Embedded (A) and EM capacities can't host Fabric items.
 * @param {{ sku?: string }} capacity
 */
export const runsFabric = (capacity) => !/^(PP|A|EM)\d/i.test(String(capacity.sku ?? ''));

/**
 * F64 and up, or a Premium P capacity: what a large tenant usually runs on, so the tenant size starts at large.
 * @param {{ sku?: string }} capacity
 */
export function largeCapacity(capacity) {
  const m = /^([FP])(\d+)$/i.exec(String(capacity.sku ?? ''));
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
 */

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
    ui.fail('No Azure subscription you can use.');
    // Without one, a Fabric install can still keep the secret in the notebooks, for a quick test.
    if (ctx.config.target === 'azure' || (ui.yes && !ctx.secretInNotebook)) {
      throw new Error(
        'The installer keeps the app secret in Azure Key Vault, which needs an Azure subscription in this tenant. Ask for Contributor on one, then run the installer again.' +
          (ctx.config.target === 'azure' ? '' : ' For a quick test only, --secret-in-notebook stores it in the notebooks instead.'),
      );
    }
  }
  if (subscriptions.length) ui.ok(`${subscriptions.length} Azure ${subscriptions.length === 1 ? 'subscription' : 'subscriptions'} for Key Vault`);

  /** @type {Preflight['tenantSettings']} */
  let tenantSettings;
  try {
    tenantSettings = Object.fromEntries((await api.fabric.tenantSettings()).map((s) => [s.settingName, s]));
  } catch {
    // Only Fabric administrators can read them.
  }

  return { capacities, subscriptions, roles: roles.map((r) => r.displayName), canConsent, canCreateApps, tenantSettings };
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
  const choice = await ui.select(
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

/**
 * @param {Ctx} ctx
 * @param {Preflight} pre
 */
export async function plan(ctx, pre) {
  const { ui, config, api } = ctx;

  await planDataSources(ctx);

  await planPowerBi(ctx, pre);
  if (config.modules.consumption) {
    await planConsumption(ctx, pre);
    await planCowork(ctx);
  }
  config.modules = modulesFromSources(config.dataSources);
  if (config.modules.agentEvaluator) await planAgentEvaluator(ctx);

  if (config.firstRun?.status !== 'Completed') {
    config.history.days = await ui.select(
      'How much audit history should the first load pull?',
      [
        { name: '30 days (quickest; you can load more later)', value: 30 },
        { name: '90 days (a few hours; longer on a large tenant)', value: 90 },
        { name: '180 days (the most the audit log keeps by default; many hours)', value: 180 },
      ],
      config.history.days,
    );
  }

  ui.heading('Fabric');
  const capacityChoices = pre.capacities.map((cap) => ({ name: `${cap.displayName} (${cap.sku}, ${cap.region})`, value: cap.id }));
  config.fabric.capacityId = await ui.select(
    'Which capacity should run it?',
    capacityChoices,
    pre.capacities.some((cap) => cap.id === config.fabric.capacityId) ? config.fabric.capacityId : pre.capacities[0].id,
  );
  const capacity = pre.capacities.find((cap) => cap.id === config.fabric.capacityId);
  config.scale = await ui.select(
    'How many people are in the tenant?',
    [
      { name: 'Up to 10,000', value: 'standard' },
      { name: 'More than 10,000 (smaller audit windows, longer time limits; best on F64 or larger)', value: 'large' },
    ],
    config.scale ?? (capacity && largeCapacity(capacity) ? 'large' : 'standard'),
  );
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
        default: config.fabric.workspaceName ?? uniqueName('ValueLens', taken),
        validate: (v) => (!v.trim() ? 'Required' : taken.has(v.trim().toLowerCase()) ? 'A workspace with that name exists.' : true),
      });
    }
  }
  if (!config.fabric.lakehouseId) {
    const ws = config.fabric.workspaceId;
    const taken = ws ? displayNames(await api.fabric.listItems(ws, 'Lakehouse')) : [];
    const typed = await ui.input('Lakehouse name', { default: freeName(config.fabric.lakehouseName ?? 'ValueLens', taken), validate: validateNewLakehouseName(taken) });
    config.fabric.lakehouseName = lakehouseNameFrom(typed);
    if (config.fabric.lakehouseName !== typed.trim()) ui.note(`Fabric doesn't allow spaces or hyphens in Lakehouse names, so it'll be called ${config.fabric.lakehouseName}.`);
  }
  await reserveNames(ctx);

  ui.heading('App registration');
  /** Ask for the secret of an app the user brought, once the Key Vault section says where it goes. */
  let askSecret = false;
  let packWanted = false;
  if (config.app.appId) {
    ui.ok(`Using ${config.app.displayName ?? 'app'} (${config.app.appId})`);
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
      'Last time you chose to store the client secret in the notebooks.',
      [
        { name: 'Keep it in the notebooks (not recommended)', value: 'keep' },
        { name: 'Use Key Vault instead', value: 'vault' },
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
    ui.warn('The client secret is stored in the notebooks (not recommended).');
  } else {
    await planKeyVault(ctx, pre, capacity ? armLocation(capacity.region) : 'westeurope');
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

  ctx.runFirstLoad = config.firstRun?.status === 'Completed' ? false : await ui.confirm('Run the first load as soon as setup finishes?', true);
}

/**
 * Where the client secret goes: a new vault, one the user has, or (for a quick test) the notebooks.
 * A vault the user can't write secrets to can still be used: a vault admin adds the secret.
 * @param {Ctx} ctx
 * @param {Preflight} pre
 * @param {string} location
 */
export async function planKeyVault(ctx, pre, location) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  if (ctx.secretInNotebook && (await confirmNotebookMode(ctx))) return;
  if (!pre.subscriptions.length) {
    ui.warn('With no Azure subscription, there\'s nowhere to create a Key Vault for the client secret.');
    if (await confirmNotebookMode(ctx)) return;
    throw new Error('The installer keeps the app secret in Azure Key Vault, which needs an Azure subscription in this tenant. Ask for Contributor on one, then run the installer again.');
  }
  kv.subscriptionId = await ui.select(
    'Azure subscription',
    pre.subscriptions.map((s) => ({ name: `${s.displayName} (${s.subscriptionId})`, value: s.subscriptionId })),
    pre.subscriptions.some((s) => s.subscriptionId === kv.subscriptionId) ? kv.subscriptionId : pre.subscriptions[0].subscriptionId,
  );
  const subscriptionId = /** @type {string} */ (kv.subscriptionId);

  const vaults = await api.arm.listVaults(subscriptionId).catch(() => []);
  for (;;) {
    const choice = await ui.select(
      'Vault',
      [
        { name: 'Create a new Key Vault', value: '' },
        ...vaults.map((v) => ({ name: `Use "${v.name}" (${v.location})`, value: v.id })),
        { name: 'Store the secret in the notebook (not recommended)', value: NOTEBOOK, description: 'No Key Vault. For quick tests only: anyone with access to the workspace can read it.' },
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
            { name: 'A vault admin will add the secret for me (recommended)', value: 'keyvault-admin', description: 'You get the exact steps to send them. You only need to read the secret.' },
            { name: 'Pick another vault', value: 'other' },
            { name: 'Store the secret in the notebook (not recommended)', value: NOTEBOOK, description: 'For quick tests only.' },
          ],
          'keyvault-admin',
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
      await askResourceGroup(ctx, subscriptionId);
      kv.location = await ui.input('Azure region', { default: kv.location ?? location });
      kv.name = await ui.input('Vault name (globally unique)', {
        default: kv.name ?? `valuelens-${randomBytes(3).toString('hex')}`,
        validate: validateVaultName,
      });
      const available = await api.arm.checkVaultName(subscriptionId, kv.name);
      if (!available.nameAvailable) throw new Error(`Key Vault name "${kv.name}" is taken: ${available.message ?? 'choose another'}.`);
      // Contributor on just the resource group is enough for the vault, so roles are checked where it goes.
      const group = await api.arm.getResourceGroup(subscriptionId, /** @type {string} */ (kv.resourceGroup)).catch(() => null);
      const scope = group ? `/subscriptions/${subscriptionId}/resourceGroups/${kv.resourceGroup}` : `/subscriptions/${subscriptionId}`;
      const perms = await api.arm.permissions(scope).catch(() => []);
      kv.rbac = allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write');
      if (!kv.rbac) ui.note('You can\'t assign Azure roles here, so the vault will use access policies instead of Azure RBAC.');
    }
    if (kv.mode !== 'keyvault-admin') delete kv.handoff;
    break;
  }
  kv.secretName = await ui.input('Secret name', { default: kv.secretName, validate: (v) => (/^[0-9a-zA-Z-]{1,127}$/.test(v) ? true : 'Letters, digits and hyphens only.') });
}

const NOTEBOOK = 'notebook';

/**
 * The resource group for a new vault. Someone with Contributor on a resource group but not the
 * subscription can't create groups, so they're asked for one that exists.
 * @param {Ctx} ctx
 * @param {string} subscriptionId
 */
async function askResourceGroup(ctx, subscriptionId) {
  const { ui, config, api } = ctx;
  const kv = config.keyVault;
  for (;;) {
    kv.resourceGroup = (await ui.input('Resource group (created if missing)', { default: kv.resourceGroup ?? 'rg-valuelens' })).trim();
    if (await api.arm.getResourceGroup(subscriptionId, kv.resourceGroup).catch(() => null)) return;
    const perms = await api.arm.permissions(`/subscriptions/${subscriptionId}`).catch(() => null);
    if (!perms || allowsAction(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write')) return;
    ui.warn(`There's no resource group called ${kv.resourceGroup} that you can see, and you can't create one in this subscription. Give the name of one you have Contributor on.`);
    if (ui.yes) return;
  }
}

/**
 * Asks before keeping the client secret in the notebooks. Returns true when the user agrees.
 * With --yes, --secret-in-notebook is the agreement.
 * @param {Ctx} ctx
 */
async function confirmNotebookMode(ctx) {
  const { ui, config } = ctx;
  ui.warn('Storing the client secret in the notebooks is for quick tests only.');
  ui.info('  - It is plain text in the notebook code.');
  ui.info('  - Anyone with access to the workspace can read it, and use it to read your tenant\'s data through Microsoft Graph.');
  ui.info('  - It is copied into notebook run snapshots, exports, Git sync and deployment pipelines.');
  ui.info('  - Power Automate flows aren\'t set up, because they read the secret from Key Vault.');
  ui.info('Use Key Vault for anything you keep. If you can\'t write to a vault, a vault admin can add the secret for you.');
  const ok = ui.yes ? !!ctx.secretInNotebook : await ui.confirm('Store the client secret in plain text in the notebooks?', false);
  if (ui.yes && !ok) ui.note('With --yes, add --secret-in-notebook to choose this.');
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
  const list = async (/** @type {string} */ type) => (ws ? displayNames(await api.fabric.listItems(ws, type)) : []);
  const [notebookNames, pipelineNames, modelNames, reportNames] = await Promise.all([list('Notebook'), list('DataPipeline'), list('SemanticModel'), list('Report')]);
  /** @type {string[]} */
  const renamed = [];
  /** @param {string} wanted @param {string[]} taken */
  const pick = (wanted, taken) => {
    const name = freeName(wanted, taken);
    if (name !== wanted) renamed.push(wanted);
    taken.push(name);
    return name;
  };

  const notebooks = notebooksFor(config.modules, {
    semanticModel: !!sm.enabled,
    azureAi: !!config.modules.consumption && !!cc.azureSubscriptionId,
    dataverse: !!config.modules.agentEvaluator && ae.environments.length > 0,
    dataSources: config.dataSources,
  });
  f.notebookNames ??= {};
  for (const nb of notebooks) {
    if (!f.notebooks[nb.key]) f.notebookNames[nb.key] = pick(startFrom(f.notebookNames[nb.key], nb.displayName), notebookNames);
  }
  if (!f.pipelineId) f.pipelineName = pick(startFrom(f.pipelineName, PIPELINE_NAME), pipelineNames);
  if (sm.enabled && !sm.id) sm.name = pick(startFrom(sm.name, MODEL_NAME), modelNames);
  if (sm.enabled && consumptionModelWanted(ctx) && !cc.model.id) cc.model.name = pick(startFrom(cc.model.name, CONSUMPTION_MODEL_NAME), modelNames);
  if (sm.enabled && agentEvaluatorModelWanted(ctx) && !ae.model.id) ae.model.name = pick(startFrom(ae.model.name, AGENT_EVALUATOR_MODEL_NAME), modelNames);
  for (const w of reportsWanted(ctx)) {
    if (!w.model.report?.id) w.model.report = { ...w.model.report, name: pick(startFrom(w.model.report?.name, w.name), reportNames) };
  }

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
 * @typedef {{ creates: ReviewItem[], grants: ReviewGrant[], runsOn: ReviewRun[] }} PlanReview
 */

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
  const notebooks = notebooksFor(config.modules, { semanticModel: !!sm.enabled, azureAi: withAzureAi, dataverse: withTranscripts, dataSources: config.dataSources });

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
            ? `${config.app.existing ? 'Yours. ' : ''}Its client secret is written into the notebooks in plain text.`
            : mode === 'keyvault-admin'
              ? `${config.app.existing ? 'Yours. ' : ''}A vault admin adds its client secret to Key Vault.`
              : config.app.existing
                ? 'Yours. A client secret you paste goes straight to Key Vault.'
                : 'Signs in to Microsoft Graph for the notebooks, with a client secret kept in Key Vault.',
    },
    mode === 'notebook'
      ? {
          kind: 'Client secret',
          name: 'In the notebooks (not recommended)',
          isNew: false,
          detail: 'No Key Vault. Plain text that anyone with access to the workspace can read; also in run snapshots, exports, Git sync and deployment pipelines.',
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
    { kind: 'Lakehouse', name: f.lakehouseName ?? 'ValueLens', isNew: !f.lakehouseId },
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
      name: kind === 'feedback' ? FEEDBACK_FLOW_NAME : STUDIO_FLOW_NAME,
      isNew: !config.uploads.flowIds?.[kind],
      detail: env ? `In ${env.name ?? env.url}, turned off until you sign in to its connections.` : 'Written to a file to import.',
    });
  }
  if (sm.enabled) {
    creates.push({ kind: 'Semantic model', name: sm.name, isNew: !sm.id });
    if (consumptionModelWanted(ctx)) creates.push({ kind: 'Semantic model', name: cc.model.name, isNew: !cc.model.id });
    if (agentEvaluatorModelWanted(ctx)) creates.push({ kind: 'Semantic model', name: ae.model.name, isNew: !ae.model.id });
    creates.push({
      kind: 'Connection',
      name: sm.connectionName ?? (f.workspaceId ? connectionName(f.workspaceId) : 'Analytics Hub SQL connection'),
      isNew: !sm.connectionId,
      detail: 'Lets the models read the Lakehouse, with a second client secret that only the connection holds.',
    });
    if (fa.enabled) creates.push({ kind: 'Fabric app', name: fa.name ?? 'Analytics Hub', isNew: !fa.itemId, detail: 'A web app in the workspace, built on the semantic model.' });
    for (const w of reportsWanted(ctx)) {
      creates.push({ kind: 'Report', name: w.model.report?.name ?? w.name, isNew: !w.model.report?.id, detail: `From its Power BI template, reading ${w.model.name}.` });
    }
  }

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
  const waiting = ae.environments.filter((e) => !e.access);
  if (config.modules.agentEvaluator && waiting.length) {
    grants.push({
      who: appWho,
      what: `Application user with the ${TRANSCRIPT_ROLE} role`,
      where: waiting.map((e) => e.name ?? new URL(e.url).host).join(', '),
      detail: 'So the notebook can read Copilot Studio transcripts from Dataverse.',
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
  return { creates, grants, runsOn };
}

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
  if (kvMode === 'notebook') ui.info(`Secret:      in the notebooks ${c.dim('(not recommended: plain text, for quick tests only)')}`);
  else if (kvMode === 'keyvault-admin') ui.info(`Key Vault:   ${config.keyVault.name} ${c.dim('(a vault admin adds the secret)')}`);
  else ui.info(`Key Vault:   ${config.keyVault.name} ${config.keyVault.existing || config.keyVault.uri ? '' : c.dim(`(new, ${config.keyVault.rbac ? 'Azure RBAC' : 'access policies'})`)}`);
  ui.info(`Schedule:    ${config.schedule.frequency === 'weekly' ? `${config.schedule.weekday}s` : 'Daily'} at ${config.schedule.time} ${config.schedule.timeZone}`);
  ui.info(`Tenant size: ${config.scale === 'large' ? 'large (more than 10,000 people)' : 'standard (up to 10,000 people)'}`);
  if (config.semanticModel.enabled) {
    const cm = config.consumption.model;
    const consumption = consumptionModelWanted(ctx) ? `, ${cm.name} ${cm.id ? '' : c.dim('(new)')}`.trimEnd() : '';
    const am = config.agentEvaluator.model;
    const evaluator = agentEvaluatorModelWanted(ctx) ? `, ${am.name} ${am.id ? '' : c.dim('(new)')}`.trimEnd() : '';
    const app = config.fabricApp.enabled ? `, and the Analytics Hub app ${config.fabricApp.itemId ? '' : c.dim('(new)')}` : '';
    ui.info(`Power BI:    ${config.semanticModel.name} ${config.semanticModel.id ? '' : c.dim('(new)')}`.trimEnd() + consumption + evaluator + app.trimEnd());
    const reports = reportsWanted(ctx).map((w) => `${w.model.report?.name ?? w.name} ${w.model.report?.id ? '' : c.dim('(new)')}`.trimEnd());
    if (reports.length) ui.info(`Reports:     ${reports.join(', ')}`);
  }
  if (config.modules.consumption) {
    const cc = config.consumption;
    ui.info(`Azure AI:    ${cc.azureSubscriptionId ? `${cc.azureSubscriptionName ?? cc.azureSubscriptionId}${cc.azureAccess ? '' : c.dim(' (the app gets Reader, Cost Management Reader and Monitoring Reader)')}` : c.dim('left out')}`);
  }
  if (config.modules.agentEvaluator) {
    const envs = config.agentEvaluator.environments;
    const names = envs.map((e) => e.name ?? new URL(e.url).host).join(', ');
    const waiting = envs.some((e) => !e.access) ? c.dim(' (the app is added to each with the Bot Transcript Viewer role)') : '';
    ui.info(`Agents:      ${envs.length ? `${names}${waiting}` : c.dim('no environments chosen')}`);
  }
  if (ctx.runFirstLoad) ui.info(`First load:  ${config.history.days} days of history, straight after setup`);
  ui.review(planReview(ctx, pre));
  return ui.confirm('Go ahead?', true);
}
