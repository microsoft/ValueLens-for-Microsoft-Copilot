// @ts-check
/**
 * Read-only checks of what the signed-in user has and lacks for an install: roles, licences,
 * capacities, Azure access and environments. Nothing here writes anything, and each check
 * reports "unknown" rather than failing when it can't be read.
 */
import { allowsAction, ROLES } from './clients/azure.js';
import { APP_ROLES, CONSENT_ROLES, FABRIC_ADMIN_ROLE, POWER_PLATFORM_ADMIN_ROLE } from './clients/graph.js';
import { secretMode } from './config.js';
import { canWriteSecrets } from './steps/identity.js';
import { blockedSettings, runsFabric } from './steps/plan.js';

/** @typedef {'met' | 'missing' | 'eligible' | 'unknown'} PrereqStatus */
/**
 * @typedef {object} Prereq
 * @property {string} id
 * @property {string} label
 * @property {PrereqStatus} status
 * @property {string} detail  What was found.
 * @property {string} neededFor
 * @property {string} howTo  How to get it, when it's missing.
 * @property {boolean} [optional]  Only some features need it.
 * @property {{ name: string, status: PrereqStatus, detail?: string }[]} [rows]  Per subscription or environment.
 */

/** Subscriptions and environments checked one by one; more than this would slow the home screen down. */
export const MAX_SUBSCRIPTIONS = 10;
const MAX_ENVIRONMENTS = 20;

/** Power BI Pro and Premium Per User service plans. */
const PRO_PLANS = { BI_AZURE_P2: 'Power BI Pro', BI_AZURE_P3: 'Power BI Premium Per User' };

const AZURE_ROLE_NAMES = {
  [ROLES.owner]: 'Owner',
  [ROLES.contributor]: 'Contributor',
  [ROLES.userAccessAdministrator]: 'User Access Administrator',
};

/** @param {any} err */
const why = (err) => {
  const status = err?.status ? `${err.status} ` : '';
  const msg = String(err?.message ?? err ?? '').split('\n')[0].slice(0, 160);
  return `${status}${msg}`.trim();
};

/** Last segment of an ARM role definition ID. @param {string} [id] */
const roleGuid = (id) => String(id ?? '').split('/').pop()?.toLowerCase() ?? '';

/**
 * What an ARM permission set lets the user do in a subscription.
 * @param {{ actions?: string[], notActions?: string[] }[]} perms
 */
export function azureAccess(perms) {
  return {
    create: allowsAction(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write') && allowsAction(perms, 'Microsoft.Resources/deployments/write'),
    assign: allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write'),
  };
}

/**
 * @param {{ api: import('./install.js').Apis, user: import('./install.js').User, config: import('./config.js').InstallConfig }} ctx
 * @returns {Promise<Prereq[]>}
 */
export async function checkPrereqs(ctx) {
  const { api, user, config } = ctx;
  const azure = config.target === 'azure';

  const roles = api.graph.myDirectoryRoles();
  const eligible = api.graph.myEligibleRoles(user.id);
  const groups = api.graph.myGroupIds().catch(() => /** @type {string[]} */ ([]));
  const subs = api.arm.listSubscriptions().then((s) => s.filter((x) => x.state === 'Enabled'));
  // Unhandled until awaited by a check; these keep a rejected lookup from crashing the process.
  for (const p of [roles, eligible, subs]) p.catch(() => {});

  /**
   * @param {Omit<Prereq, 'status' | 'detail'>} base
   * @param {() => Promise<Pick<Prereq, 'status' | 'detail'> & Partial<Prereq>>} fn
   * @returns {Promise<Prereq>}
   */
  const guard = async (base, fn) => {
    try {
      return { ...base, ...(await fn()) };
    } catch (err) {
      return { ...base, status: 'unknown', detail: `Couldn't check: ${why(err)}` };
    }
  };

  /**
   * An Entra role: active, eligible through PIM ("activate first"), or missing.
   * @param {Omit<Prereq, 'status' | 'detail'>} base
   * @param {Record<string, string>} wanted  Template ID to name.
   */
  const entraRole = (base, wanted) =>
    guard(base, async () => {
      const active = (await roles).filter((r) => wanted[r.roleTemplateId]);
      if (active.length) return { status: 'met', detail: `Active: ${[...new Set(active.map((r) => wanted[r.roleTemplateId]))].join(', ')}` };
      /** @type {{ roleDefinitionId: string }[] | null} */
      let elig = null;
      try {
        elig = (await eligible).filter((r) => wanted[r.roleDefinitionId]);
      } catch {
        // Reading PIM eligibility needs its own permission; without it, only active roles are known.
      }
      if (elig?.length) {
        return { status: 'eligible', detail: `Eligible, activate first: ${[...new Set(elig.map((r) => wanted[r.roleDefinitionId]))].join(', ')}. Activate it in Entra Privileged Identity Management, then check again.` };
      }
      return { status: 'missing', detail: `You don't have ${Object.values(wanted).join(' or ')} active.${elig ? '' : ' Couldn\'t check PIM-eligible roles.'}` };
    });

  /** Owner, or Contributor plus User Access Administrator, per subscription. */
  const azureRbac = guard(
    {
      id: 'azure-rbac',
      label: 'Azure: Owner, or Contributor and User Access Administrator',
      neededFor: azure
        ? 'The Azure target creates its resource group, SQL database, container jobs and role assignments.'
        : 'Creating the Key Vault for the app secret, and the Azure role assignments for credit consumption.',
      howTo: 'Ask a subscription owner for Owner, or for Contributor and User Access Administrator, on the subscription you\'ll use.',
      optional: !azure,
    },
    async () => {
      const list = await subs;
      if (!list.length) {
        return {
          status: 'missing',
          detail: 'No enabled Azure subscription you can see.',
          ...(azure ? {} : { howTo: 'Ask for Contributor (and User Access Administrator for credit consumption) on a subscription. For a quick test only, --secret-in-notebook keeps the app secret in the notebooks instead of Key Vault.' }),
        };
      }
      const first = config.azure?.subscriptionId ?? config.keyVault.subscriptionId;
      const ordered = [...list].sort((a, b) => Number(b.subscriptionId === first) - Number(a.subscriptionId === first));
      const ids = [user.id, ...(await groups)];
      const rows = await Promise.all(ordered.slice(0, MAX_SUBSCRIPTIONS).map(async (s) => {
        const scope = `/subscriptions/${s.subscriptionId}`;
        const name = s.displayName ?? s.subscriptionId;
        try {
          const access = azureAccess(await api.arm.permissions(scope));
          const assigned = await api.arm.myRoleAssignments(scope, ids).catch(() => []);
          const names = [...new Set(assigned.map((a) => AZURE_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)]).filter(Boolean))];
          const has = names.length ? ` (${names.join(', ')})` : '';
          if (access.create && access.assign) return { name, status: /** @type {PrereqStatus} */ ('met'), detail: `Can create resources and assign roles${has}` };
          const elig = await api.arm.myEligibleRoles(scope, ids).catch(() => []);
          const eligNames = [...new Set(elig.map((a) => AZURE_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)]).filter(Boolean))];
          if (eligNames.length) return { name, status: /** @type {PrereqStatus} */ ('eligible'), detail: `Eligible, activate first: ${eligNames.join(', ')}` };
          const lacks = access.create ? 'Can create resources but not assign roles (no User Access Administrator)' : access.assign ? 'Can assign roles but not create resources (no Contributor)' : 'Can\'t create resources or assign roles';
          return { name, status: /** @type {PrereqStatus} */ ('missing'), detail: `${lacks}${has}` };
        } catch (err) {
          return { name, status: /** @type {PrereqStatus} */ ('unknown'), detail: `Couldn't check: ${why(err)}` };
        }
      }));
      const status = /** @type {PrereqStatus} */ (['met', 'eligible', 'missing', 'unknown'].find((st) => rows.some((r) => r.status === st)) ?? 'unknown');
      const met = rows.filter((r) => r.status === 'met').length;
      const more = list.length > MAX_SUBSCRIPTIONS ? ` Checked the first ${MAX_SUBSCRIPTIONS} of ${list.length}.` : '';
      return { status, detail: `${met} of ${rows.length} ${rows.length === 1 ? 'subscription' : 'subscriptions'} give you this.${more}`, rows };
    },
  );

  /** @type {Promise<Prereq>[]} */
  const checks = [
    entraRole(
      {
        id: 'consent-role',
        label: 'Global Administrator or Privileged Role Administrator',
        neededFor: 'Granting admin consent for the app registration\'s Microsoft Graph permissions.',
        howTo: 'If that isn\'t you, carry on: the installer gives you a link for a Global Administrator or Privileged Role Administrator to approve.',
        optional: true,
      },
      CONSENT_ROLES,
    ),
    entraRole(
      {
        id: 'fabric-admin',
        label: 'Fabric Administrator',
        neededFor: 'Reading and switching on the Fabric tenant settings the model, reports and app need.',
        howTo: 'Ask a Global Administrator for the Fabric Administrator role, or ask a Fabric administrator to check the tenant settings for you.',
        optional: true,
      },
      { [FABRIC_ADMIN_ROLE]: 'Fabric Administrator' },
    ),
    entraRole(
      {
        id: 'power-platform-admin',
        label: 'Power Platform Administrator',
        neededFor: 'Adding the app to Power Platform environments for Agent Evaluator and the flows when you aren\'t a System Administrator there.',
        howTo: 'Ask a Global Administrator for the Power Platform Administrator role, or be a System Administrator in each environment you use.',
        optional: true,
      },
      { [POWER_PLATFORM_ADMIN_ROLE]: 'Power Platform Administrator' },
    ),
    guard(
      {
        id: 'register-apps',
        label: 'Register apps in Entra',
        neededFor: 'Creating the app registration that collects the data.',
        howTo: 'Ask for the Application Administrator or Cloud Application Administrator role, use an app registration you already have, or get the admin pack for an admin to register it.',
      },
      async () => {
        if (config.app.appId) return { status: 'met', detail: `Uses the app registration ${config.app.appId}.` };
        const r = await roles;
        const admin = r.find((x) => CONSENT_ROLES[/** @type {keyof typeof CONSENT_ROLES} */ (x.roleTemplateId)] || APP_ROLES[/** @type {keyof typeof APP_ROLES} */ (x.roleTemplateId)]);
        if (admin) return { status: 'met', detail: `Your ${admin.displayName} role allows it.` };
        return (await api.graph.usersCanRegisterApps())
          ? { status: 'met', detail: 'Users in this tenant can register apps.' }
          : { status: 'missing', detail: 'Users in this tenant can\'t register apps, and you have no app admin role.' };
      },
    ),
    guard(
      {
        id: 'power-bi-pro',
        label: 'Power BI Pro or Premium Per User licence',
        neededFor: azure
          ? 'Publishing the semantic model and reports to the Power BI workspace.'
          : 'Publishing and sharing the semantic model, reports and Analytics Hub app.',
        howTo: 'Ask your licence admin to assign you Power BI Pro (included in Microsoft 365 E5) or Premium Per User.',
      },
      async () => {
        const found = (await api.graph.myLicenseDetails())
          .flatMap((l) => l.servicePlans ?? [])
          .filter((p) => p.provisioningStatus === 'Success' && PRO_PLANS[/** @type {keyof typeof PRO_PLANS} */ (p.servicePlanName)])
          .map((p) => PRO_PLANS[/** @type {keyof typeof PRO_PLANS} */ (p.servicePlanName)]);
        return found.length
          ? { status: 'met', detail: [...new Set(found)].join(', ') }
          : { status: 'missing', detail: 'No Power BI Pro or Premium Per User licence is assigned to you.' };
      },
    ),
    ...(azure
      ? []
      : [
          guard(
            {
              id: 'fabric-capacity',
              label: 'Active Fabric capacity',
              neededFor: 'The Analytics Hub workspace, Lakehouse, notebooks and pipeline run on it.',
              howTo: 'Start a Fabric trial, or ask a capacity admin to make you a contributor on an F2 or larger capacity.',
            },
            async () => {
              const caps = (await api.fabric.listCapacities()).filter((cap) => cap.state === 'Active' && runsFabric(cap));
              if (!caps.length) return { status: 'missing', detail: 'No active Fabric capacity (F2 or larger, or a trial) you can assign workspaces to.' };
              const names = caps.slice(0, 3).map((cap) => `${cap.displayName ?? cap.id}${cap.sku ? ` (${cap.sku})` : ''}`);
              return { status: 'met', detail: `${caps.length} available: ${names.join(', ')}${caps.length > 3 ? ', ...' : ''}` };
            },
          ),
        ]),
    azureRbac,
    ...(azure
      ? []
      : [
          guard(
            {
              id: 'key-vault',
              label: 'Key Vault access for the app secret',
              neededFor: 'The app registration\'s client secret is kept in Azure Key Vault, where the notebooks read it.',
              howTo: 'Ask for Contributor on a subscription to create a vault, or Key Vault Secrets User on an existing one (a vault admin then adds the secret). For a quick test only, --secret-in-notebook keeps it in the notebooks.',
            },
            async () => {
              if (secretMode(config) === 'notebook') return { status: 'met', detail: 'The secret is kept in the notebooks (for a quick test only), so no vault is needed.' };
              const kv = config.keyVault;
              if (kv.id) {
                const vault = await api.arm.getVault(kv.id);
                return (await canWriteSecrets(/** @type {any} */ ({ api, user }), vault))
                  ? { status: 'met', detail: `You can write secrets to ${vault.name ?? kv.name}.` }
                  : { status: 'missing', detail: `You can't write secrets to ${vault.name ?? kv.name}. A vault admin can add the secret for you, or give you Key Vault Secrets Officer.` };
              }
              const rbac = await azureRbac;
              if (rbac.rows?.some((r) => /^Can create resources/.test(r.detail ?? ''))) return { status: 'met', detail: 'You can create a new vault in one of your subscriptions.' };
              if (rbac.status === 'unknown') return { status: 'unknown', detail: 'Couldn\'t check your Azure access.' };
              return { status: rbac.status === 'eligible' ? 'eligible' : 'missing', detail: 'You can\'t create a vault in any subscription you can see. You can use an existing vault you can read, or keep the secret in the notebooks for a quick test.' };
            },
          ),
        ]),
    guard(
      {
        id: 'environments',
        label: 'Power Platform environments, System Administrator in each',
        neededFor: 'Agent Evaluator reads Copilot Studio transcripts from Dataverse, and the flows are created in an environment.',
        howTo: 'Ask an environment admin for the System Administrator security role, or a Power Platform Administrator to add the app for you.',
        optional: true,
      },
      async () => {
        const envs = (await api.discovery.instances()).filter((i) => i.Url && (i.State ?? 0) === 0);
        if (!envs.length) return { status: 'missing', detail: 'No Dataverse environments you can see.' };
        const rows = envs.slice(0, MAX_ENVIRONMENTS).map((i) => ({
          name: i.FriendlyName ?? i.UniqueName ?? i.Url,
          status: /** @type {PrereqStatus} */ (i.IsUserSysAdmin === true ? 'met' : i.IsUserSysAdmin === false ? 'missing' : 'unknown'),
          detail: i.IsUserSysAdmin === true ? 'System Administrator' : i.IsUserSysAdmin === false ? 'Not a System Administrator' : 'Couldn\'t tell',
        }));
        const admin = rows.filter((r) => r.status === 'met').length;
        const more = envs.length > MAX_ENVIRONMENTS ? ` Showing the first ${MAX_ENVIRONMENTS} of ${envs.length}.` : '';
        const status = /** @type {PrereqStatus} */ (admin ? 'met' : rows.some((r) => r.status === 'unknown') ? 'unknown' : 'missing');
        return { status, detail: `System Administrator in ${admin} of ${rows.length} ${rows.length === 1 ? 'environment' : 'environments'}.${more}`, rows };
      },
    ),
    guard(
      {
        id: 'tenant-settings',
        label: 'Fabric tenant settings',
        neededFor: 'The model\'s connection, the app\'s queries and the reports\' custom visuals each need a tenant setting on.',
        howTo: 'A Fabric administrator switches them on in the admin portal, under Tenant settings.',
      },
      async () => {
        /** @type {any[]} */
        let list;
        try {
          list = await api.fabric.tenantSettings();
        } catch {
          return { status: 'unknown', detail: 'Couldn\'t check: only a Fabric Administrator can read tenant settings.' };
        }
        const off = blockedSettings(Object.fromEntries(list.map((s) => [s.settingName, s])), { app: !azure, reports: true });
        return off.length
          ? { status: 'missing', detail: `Off: ${off.map((s) => s.title).join('; ')}.` }
          : { status: 'met', detail: 'The settings Analytics Hub needs are on.' };
      },
    ),
  ];
  return Promise.all(checks);
}
