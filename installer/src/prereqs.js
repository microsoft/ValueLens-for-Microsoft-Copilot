// @ts-check
/**
 * Read-only checks of what the signed-in user has and lacks for an install: roles, licences,
 * capacities and Azure access, or on the PAX route this PC, the SharePoint site and the app.
 * Nothing here writes anything, and each check reports "unknown" rather than failing when it
 * can't be read.
 */
import { allowsAction, ROLES } from './clients/azure.js';
import { APP_ROLES, CONSENT_ROLES, FABRIC_ADMIN_ROLE, POWER_PLATFORM_ADMIN_ROLE, SITE_ADMIN_ROLES } from './clients/graph.js';
import { secretMode } from './config.js';
import { CLI_PACKAGE_DIR } from './managed-app/cli.js';
import { NOT_READY_NAMES, THE_APP, whyNot } from './managed-app/flow.js';
import { PRODUCT } from './product.js';
import { copilotLicences } from './seats.js';
import { canWriteSecrets } from './steps/identity.js';
import { checkHost, paxHostOf, TASK_AT } from './steps/pax/local.js';
import { blockedSettings, runsFabric } from './steps/plan.js';
import { isPax, paxHostProblem } from './target.js';

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

/** Subscriptions checked one by one; more than this would slow the home screen down. */
export const MAX_SUBSCRIPTIONS = 10;

/** Power BI Pro and Premium Per User service plans. */
const PRO_PLANS = { BI_AZURE_P2: 'Power BI Pro', BI_AZURE_P3: 'Power BI Premium Per User' };

/** Service plans that give Defender advanced hunting over devices, or Cloud Discovery. */
export const DEFENDER_PLANS = { WINDEFATP: 'Defender for Endpoint P2', MTP: 'Microsoft Defender XDR', ADALLOM_S_STANDALONE: 'Defender for Cloud Apps' };

/**
 * Service plans that let a user run flows with premium connectors, such as "HTTP with Microsoft Entra ID".
 * Names from Microsoft Learn's "Product names and service plan identifiers for licensing".
 */
export const PREMIUM_FLOW_PLANS = {
  POWER_AUTOMATE_ATTENDED_RPA: 'Power Automate Premium',
  POWER_AUTOMATE_ATTENDED_RPA_GCC: 'Power Automate Premium',
  FLOW_PER_USER: 'Power Automate per user',
  FLOW_PER_USER_GCC: 'Power Automate per user',
  FLOW_P2: 'Power Automate Plan 2',
  FLOW_P1_GOV: 'Power Automate Plan 1',
};

export { COPILOT_PLAN } from './seats.js';

const PIM_URL = 'https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles';

/**
 * Whether the signed-in user has Global Administrator or Privileged Role Administrator active, so they
 * can assign directory roles (and grant admin consent) themselves.
 * @param {import('./install.js').Apis} api
 */
export async function canAssignDirectoryRoles(api) {
  return (await api.graph.myDirectoryRoles()).some((r) => Object.hasOwn(CONSENT_ROLES, r.roleTemplateId));
}

const AZURE_ROLE_NAMES = {
  [ROLES.owner]: 'Owner',
  [ROLES.contributor]: 'Contributor',
  [ROLES.userAccessAdministrator]: 'User Access Administrator',
  [ROLES.rbacAdministrator]: 'Role Based Access Control Administrator',
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
 * The checks for the record's route. With no route chosen yet, the Fabric route's.
 * @param {{
 *   api: import('./install.js').Apis,
 *   user: import('./install.js').User,
 *   config: import('./config.js').InstallConfig,
 *   sources?: import('./sources.js').Sources,
 *   paxHost?: import('./steps/pax/local.js').PaxHost,
 * }} ctx  sources and paxHost: what the PAX route's checks read.
 * @returns {Promise<Prereq[]>}
 */
export async function checkPrereqs(ctx) {
  const { api, user, config } = ctx;
  const pax = isPax(config);

  const roles = api.graph.myDirectoryRoles();
  const eligible = api.graph.myEligibleRoles(user.id);
  // The PAX route uses no Azure, so it reads no subscriptions.
  const groups = pax ? Promise.resolve(/** @type {string[]} */ ([])) : api.graph.myGroupIds().catch(() => /** @type {string[]} */ ([]));
  const subs = pax ? Promise.resolve([]) : api.arm.listSubscriptions().then((s) => s.filter((x) => x.state === 'Enabled'));
  // Unhandled until awaited by a check; these keep a rejected lookup from crashing the process.
  for (const p of [roles, eligible, subs]) p.catch(() => {});
  /** @type {ReturnType<typeof api.graph.myLicenseDetails> | undefined} */
  let licenceList;
  const licences = () => (licenceList ??= api.graph.myLicenseDetails());
  /** @type {ReturnType<typeof api.graph.subscribedSkus> | undefined} */
  let skuList;
  const skus = () => (skuList ??= api.graph.subscribedSkus());
  /** Service plans assigned to the signed-in user and provisioned, by name. */
  const myPlans = async () => (await licences()).flatMap((l) => l.servicePlans ?? []).filter((p) => p.provisioningStatus === 'Success').map((p) => p.servicePlanName);

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
   * An Entra role: active, one the user can activate through PIM, or missing.
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
        return { status: 'eligible', detail: `Not active yet: ${[...new Set(elig.map((r) => wanted[r.roleDefinitionId]))].join(', ')}. You can activate this role in Entra (Privileged Identity Management): ${PIM_URL} Then check again.` };
      }
      return { status: 'missing', detail: `You don't have ${Object.values(wanted).join(' or ')} active.${elig ? '' : ' Couldn\'t check for roles you could activate yourself.'}` };
    });

  /** @type {Promise<Prereq> | undefined} */
  let rbacCheck;
  /** Owner, or Contributor plus User Access Administrator, per subscription. Only the Fabric route checks it. */
  const azureRbac = () => (rbacCheck ??= guard(
    {
      id: 'azure-rbac',
      label: 'Azure: Owner, or Contributor and User Access Administrator',
      neededFor: 'Creating the Key Vault for the app secret. With Contributor alone, the vault uses access policies rather than Azure RBAC.',
      howTo: "Ask a subscription owner for Owner, or for Contributor and User Access Administrator, on the subscription you'll use.",
      optional: true,
    },
    async () => {
      const ids = [user.id, ...(await groups)];
      const list = await subs;
      if (!list.length) {
        return {
          status: 'missing',
          detail: 'No enabled Azure subscription you can see.',
          howTo: 'Ask for Contributor on a subscription. Without one, choose no Key Vault (--no-key-vault): the app secret goes in the notebooks, where anyone with a role in the workspace can read it.',
        };
      }
      const first = config.keyVault.subscriptionId;
      const ordered = [...list].sort((a, b) => Number(b.subscriptionId === first) - Number(a.subscriptionId === first));
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
          if (eligNames.length) return { name, status: /** @type {PrereqStatus} */ ('eligible'), detail: `Not active yet: ${eligNames.join(', ')}. You can activate it in Privileged Identity Management.` };
          const lacks = access.create ? 'Can create resources but not assign roles (no User Access Administrator)' : access.assign ? 'Can assign roles but not create resources (no Contributor)' : 'Can\'t create resources or assign roles';
          return { name, status: /** @type {PrereqStatus} */ ('missing'), detail: `${lacks}${has}` };
        } catch (err) {
          return { name, status: /** @type {PrereqStatus} */ ('unknown'), detail: `Couldn't check: ${why(err)}` };
        }
      }));
      const status = /** @type {PrereqStatus} */ (['met', 'eligible', 'missing', 'unknown'].find((st) => rows.some((r) => r.status === st)) ?? 'unknown');
      const met = rows.filter((r) => r.status === 'met').length;
      const more = list.length > MAX_SUBSCRIPTIONS ? ` Checked the first ${MAX_SUBSCRIPTIONS} of ${list.length}.` : '';
      const detail = `${met} of ${rows.length} ${rows.length === 1 ? 'subscription' : 'subscriptions'} give you this.${more}`;
      return { status, detail, rows };
    },
  ));
  /** A check only the Fabric route makes. @param {() => Promise<Prereq>} check */
  const fabricOnly = (check) => (pax ? [] : [check()]);

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
        label: 'Fabric administrator — only needed if the tenant settings below are off',
        neededFor: 'Reading and switching on the Fabric tenant settings the model and report need. If they are already on, you don\'t need this role.',
        howTo: 'Ask a Fabric administrator to check the tenant settings below and turn on any that are off, or ask a Global Administrator for the Fabric Administrator role.',
        optional: true,
      },
      { [FABRIC_ADMIN_ROLE]: 'Fabric Administrator' },
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
        neededFor: pax
          ? 'Publishing and sharing the semantic model and report. In a workspace without a capacity, everyone who opens the report needs Power BI Pro too.'
          : 'Publishing and sharing the semantic model and report.',
        howTo: 'Ask your licence admin to assign you Power BI Pro (included in Microsoft 365 E5) or Premium Per User.',
      },
      async () => {
        const found = (await myPlans())
          .map((name) => PRO_PLANS[/** @type {keyof typeof PRO_PLANS} */ (name)])
          .filter(Boolean);
        return found.length
          ? { status: 'met', detail: [...new Set(found)].join(', ') }
          : { status: 'missing', detail: 'No Power BI Pro or Premium Per User licence is assigned to you.' };
      },
    ),
    guard(
      {
        id: 'copilot-licences',
        label: 'Microsoft 365 Copilot licences in the tenant',
        neededFor: 'The Copilot usage and licence pages. Without Microsoft 365 Copilot licences assigned, only Copilot Chat usage shows.',
        howTo: 'Nothing to do for the install: once Microsoft 365 Copilot licences are assigned, their usage shows after the next load.',
        optional: true,
      },
      async () => {
        const licences = copilotLicences(await skus());
        const names = licences.names.join(', ');
        const { assigned } = licences;
        if (assigned) return { status: 'met', detail: `${assigned} assigned (${names}).` };
        return licences.found
          ? { status: 'missing', detail: `The tenant has ${names}, but none are assigned yet.` }
          : { status: 'missing', detail: 'No Microsoft 365 Copilot licences found in this tenant.' };
      },
    ),
    ...fabricOnly(() => guard(
      {
        id: 'power-automate-premium',
        label: 'Power Automate Premium licence',
        neededFor: 'Only the Power Automate flows: the product feedback export and the agent inventory. Whoever signs in to the flow\'s connections needs it, because the flows use premium connectors.',
        howTo: 'Ask your licence admin for Power Automate Premium for whoever will sign in to the flows. Without it, upload the CSV exports instead.',
        optional: true,
      },
      async () => {
        const found = (await myPlans())
          .map((name) => PREMIUM_FLOW_PLANS[/** @type {keyof typeof PREMIUM_FLOW_PLANS} */ (name)])
          .filter(Boolean);
        return found.length
          ? { status: 'met', detail: [...new Set(found)].join(', ') }
          : { status: 'missing', detail: 'No Power Automate Premium (or per user) licence is assigned to you. Someone else who has one can sign in to the flows.' };
      },
    )),
    ...fabricOnly(() => guard(
      {
        id: 'fabric-capacity',
        label: 'Active Fabric capacity',
        neededFor: `The ${PRODUCT.name} workspace, Lakehouse, notebooks and pipeline run on it.`,
        howTo: 'Start a Fabric trial, or ask a capacity admin to make you a contributor on an F2 or larger capacity.',
      },
      async () => {
        const caps = (await api.fabric.listCapacities()).filter((cap) => cap.state === 'Active' && runsFabric(cap));
        if (!caps.length) return { status: 'missing', detail: 'No active Fabric capacity (F2 or larger, or a trial) you can assign workspaces to.' };
        const names = caps.slice(0, 3).map((cap) => `${cap.displayName ?? cap.id}${cap.sku ? ` (${cap.sku})` : ''}`);
        return { status: 'met', detail: `${caps.length} available: ${names.join(', ')}${caps.length > 3 ? ', ...' : ''}` };
      },
    )),
    ...fabricOnly(azureRbac),
    ...fabricOnly(() => guard(
      {
        id: 'key-vault',
        label: 'Key Vault access for the app secret',
        neededFor: 'Keeping the app registration\'s client secret in Azure Key Vault (--key-vault), where the notebooks read it. Optional: by default on Fabric, the secret goes in the notebooks instead.',
        howTo: 'Ask for Contributor on a subscription to create a vault, or Key Vault Secrets User on an existing one (a vault admin then adds the secret). Or keep the default, no Key Vault (--no-key-vault): anyone with a role in the workspace can then read the secret.',
        optional: true,
      },
      async () => {
        if (secretMode(config) === 'notebook') return { status: 'met', detail: 'No Key Vault: the secret is kept in the notebooks, so no vault is needed.' };
        const kv = config.keyVault;
        if (kv.id) {
          const vault = await api.arm.getVault(kv.id);
          return (await canWriteSecrets(/** @type {any} */ ({ api, user }), vault))
            ? { status: 'met', detail: `You can write secrets to ${vault.name ?? kv.name}.` }
            : { status: 'missing', detail: `You can't write secrets to ${vault.name ?? kv.name}. A vault admin can add the secret for you, or give you Key Vault Secrets Officer.` };
        }
        const rbac = await azureRbac();
        if (rbac.rows?.some((r) => /^Can create resources/.test(r.detail ?? ''))) return { status: 'met', detail: 'You can create a new vault in one of your subscriptions.' };
        if (rbac.status === 'unknown') return { status: 'unknown', detail: 'Couldn\'t check your Azure access.' };
        return { status: rbac.status === 'eligible' ? 'eligible' : 'missing', detail: 'You can\'t create a vault in any subscription you can see. You can use an existing vault you can read, or choose no Key Vault and keep the secret in the notebooks.' };
      },
    )),
    ...(!pax && config.modules.defender
      ? [
          guard(
            {
              id: 'defender-licence',
              label: 'Microsoft Defender for Endpoint P2 or Defender for Cloud Apps',
              neededFor: 'The Defender source: shadow AI on devices needs Defender for Endpoint P2, Cloud Discovery needs Defender for Cloud Apps.',
              howTo: 'Carry on without it: probes the tenant isn\'t licensed for are skipped, and the Shadow AI section says which.',
              optional: true,
            },
            async () => {
              const found = (await skus())
                .filter((s) => (s.capabilityStatus ?? 'Enabled') === 'Enabled')
                .flatMap((s) => s.servicePlans ?? [])
                .map((p) => DEFENDER_PLANS[/** @type {keyof typeof DEFENDER_PLANS} */ (p.servicePlanName)])
                .filter(Boolean);
              return found.length
                ? { status: 'met', detail: [...new Set(found)].join(', ') }
                : { status: 'missing', detail: 'No Defender for Endpoint P2, Defender XDR or Defender for Cloud Apps plan found in this tenant.' };
            },
          ),
        ]
      : []),
    ...(pax ? paxPrereqs({ config, sources: ctx.sources, host: paxHostOf(ctx), roles }, guard, entraRole) : []),
    guard(
      {
        id: 'tenant-settings',
        label: pax ? 'Power BI tenant settings' : 'Fabric tenant settings',
        // The PAX model signs in to SharePoint as you, not as the app, so only the report's settings count there.
        neededFor: pax ? 'The report\'s custom visuals need a tenant setting on.' : 'The model\'s connection and the report\'s custom visuals each need a tenant setting on.',
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
        const off = blockedSettings(Object.fromEntries(list.map((s) => [s.settingName, s])), { reports: true }).filter((s) => !pax || s.reports);
        return off.length
          ? { status: 'missing', detail: `Off: ${off.map((s) => s.title).join('; ')}.` }
          : { status: 'met', detail: `The settings ${PRODUCT.name} needs are on.` };
      },
    ),
    ...(!pax && config.dataSources?.resourceGraph === 'api' ? [resourceGraphPrereq(api, config, guard)] : []),
  ];
  return Promise.all(checks);
}

/** @typedef {(base: Omit<Prereq, 'status' | 'detail'>, fn: () => Promise<Pick<Prereq, 'status' | 'detail'> & Partial<Prereq>>) => Promise<Prereq>} Guard */

/**
 * The PAX route's own checks: this PC, the SharePoint site's grant and the app.
 * @param {{
 *   config: import('./config.js').InstallConfig,
 *   sources: import('./sources.js').Sources | undefined,
 *   host: import('./steps/pax/local.js').PaxHost,
 *   roles: Promise<{ roleTemplateId: string }[]>,
 * }} o
 * @param {Guard} guard
 * @param {(base: Omit<Prereq, 'status' | 'detail'>, wanted: Record<string, string>) => Promise<Prereq>} entraRole
 * @returns {Promise<Prereq>[]}
 */
function paxPrereqs({ config, sources, host, roles }, guard, entraRole) {
  const thisPc = guard(
    {
      id: 'this-pc',
      label: 'This PC: Windows, PowerShell 7.2 or later and Python 3.10 or later',
      neededFor: `The daily task that runs PAX on this PC and saves the files to the SharePoint folder. The PC has to be on when the task runs (${TASK_AT} by default), so one that stays on suits it better than a laptop.`,
      howTo: 'Install what\'s missing, then check again.',
    },
    async () => {
      const wrongPc = paxHostProblem(host);
      if (wrongPc) return { status: 'missing', detail: wrongPc, howTo: 'Run the installer on the Windows PC that will run the task.' };
      const { pwsh, python, problems } = await checkHost(host);
      if (problems.length) return { status: 'missing', detail: problems.map((p) => p.title).join('. ') + '.', howTo: problems.map((p) => p.fix).join(' ') };
      return { status: 'met', detail: `PowerShell ${pwsh?.version} (execution policy ${pwsh?.policy}) and Python ${python?.version}.` };
    },
  );
  const siteAdmin = entraRole(
    {
      id: 'site-admin',
      label: 'SharePoint Administrator or Global Administrator',
      neededFor: 'Giving the app write access to the SharePoint site that holds the files, and to no other site (Sites.Selected).',
      howTo: 'If that isn\'t you, carry on: the installer shows the commands for one of them to run, and waits. The admin pack has them too.',
      optional: true,
    },
    SITE_ADMIN_ROLES,
  );
  if (config.pax?.deployApp === false) return [thisPc, siteAdmin];
  const app = guard(
    {
      id: 'managed-app',
      label: `The ${PRODUCT.managedApp.name} app: Copilot managed apps`,
      neededFor: `Deploying ${THE_APP} and sharing it with the viewer group. Without it, setup finishes at the report.`,
      howTo: `Ask a Power Platform admin to allow ${NOT_READY_NAMES.createApps} and ${NOT_READY_NAMES.externalArtifacts}, in the Power Platform admin center under Copilot > Settings > Managed apps. Each person who opens the app needs Power Apps Premium or Copilot Credits.`,
      optional: true,
    },
    async () => {
      const blocked = whyNot({ distDir: sources?.appDist, cliDir: CLI_PACKAGE_DIR, nodeVersion: process.version });
      if (blocked) return { status: 'missing', detail: blocked.why, howTo: blocked.steps.join(' ') };
      const ppAdmin = (await roles).some((r) => r.roleTemplateId === POWER_PLATFORM_ADMIN_ROLE);
      return {
        status: 'unknown',
        detail: `This copy of the installer can deploy it. Whether the tenant allows it shows when it deploys, because ${NOT_READY_NAMES.createApps} and ${NOT_READY_NAMES.externalArtifacts} are off until a Power Platform admin turns them on.${ppAdmin ? ' You\'re a Power Platform Administrator, so you can turn them on.' : ''}`,
      };
    },
  );
  return [thisPc, siteAdmin, app];
}

const ARG_PROBES = {
  agents: { name: 'Copilot Studio agents', query: "PowerPlatformResources | where type =~ 'microsoft.copilotstudio/agents' | take 1" },
  foundry: { name: 'Foundry resources', query: "resources | where type in~ ('microsoft.cognitiveservices/accounts','microsoft.cognitiveservices/accounts/projects') | take 1" },
};

/**
 * What you can see in Resource Graph. The load runs as the app registration, which needs the same
 * roles, so this is a guide rather than proof.
 * @param {import('./install.js').Apis} api
 * @param {import('./config.js').InstallConfig} config
 * @param {(base: Omit<Prereq, 'status' | 'detail'>, fn: () => Promise<Pick<Prereq, 'status' | 'detail'> & Partial<Prereq>>) => Promise<Prereq>} guard
 */
function resourceGraphPrereq(api, config, guard) {
  const rg = config.resourceGraph;
  return guard(
    {
      id: 'resource-graph',
      label: 'Azure Resource Graph: agents and Foundry',
      neededFor: 'Agent configuration and Foundry resources. This checks what you can see; whoever runs the load needs the same.',
      howTo: 'For agents: Global Reader, Power Platform Administrator or AI Administrator in Entra. For Foundry: Reader on the management group, or the tenant root group.',
      optional: true,
    },
    async () => {
      const probes = [...(rg?.agents !== false ? [ARG_PROBES.agents] : []), ...(rg?.foundry !== false ? [ARG_PROBES.foundry] : [])];
      const rows = await Promise.all(
        probes.map(async (p) => {
          try {
            const found = (await api.arm.resourceGraph(p.query, rg?.managementGroup || undefined))?.data?.length ?? 0;
            return found
              ? { name: p.name, status: /** @type {PrereqStatus} */ ('met'), detail: 'You can see them.' }
              : { name: p.name, status: /** @type {PrereqStatus} */ ('unknown'), detail: 'None you can see: there may be none, or you lack the role.' };
          } catch (err) {
            const refused = [401, 403].includes(/** @type {any} */ (err)?.status);
            return { name: p.name, status: /** @type {PrereqStatus} */ (refused ? 'missing' : 'unknown'), detail: refused ? 'Refused: you lack the role.' : `Couldn't check: ${why(err)}` };
          }
        }),
      );
      const status = /** @type {PrereqStatus} */ (['missing', 'unknown', 'met'].find((st) => rows.some((r) => r.status === st)) ?? 'unknown');
      return { status, detail: rows.map((r) => `${r.name}: ${r.detail}`).join(' '), rows };
    },
  );
}
