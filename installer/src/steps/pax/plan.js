// @ts-check
/**
 * The PAX + SharePoint route's checks and questions: the tenant, then this PC, then every question
 * up front so the rest of the install can run unattended. The Fabric route's are in ../plan.js,
 * whose helpers this reuses so both routes ask alike.
 */
import { APP_ROLES, CONSENT_ROLES } from '../../clients/graph.js';
import { MODEL_NAME } from '../../config.js';
import { ADMIN_STEPS, LINKS } from '../../managed-app/errors.js';
import { APP_NAME, dataHint, NOT_READY_NAMES, THE_APP } from '../../managed-app/flow.js';
import { PRODUCT } from '../../product.js';
import { copilotSeats, seatCount } from '../../seats.js';
import { appName, PAX_AGENT365_PERMISSIONS, paxHostProblem, requiredPermissions } from '../../target.js';
import { c } from '../../ui.js';
import { accessReview, planAccess, VIEWER_GROUP_NAME } from '../access.js';
import { askAdvanced, asksAdvanced } from '../advanced.js';
import { foreignInstall, foreignWorkspaceMessage } from '../fabric.js';
import { askAppId, askMoreHistory, blockedSettings, HISTORY_CHOICES, keepAwake, planAdminPack, PRICING, reloadLine, uniqueName, validateTime } from '../plan.js';
import { checkHost, paxHostOf, PAX_RELEASE, secretStored, SEED_DAYS, TASK_AT, userInfoMode } from './local.js';
import { refreshTimes, workspaceItems } from './publish.js';
import { describeFolder, folderConfig, folderValidator, parseSharePointFolder, SITE_ADMIN } from './site.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {import('../../config.js').InstallConfig} InstallConfig */
/** @typedef {import('../plan.js').PlanReview} PlanReview */
/** @typedef {import('../plan.js').ReviewItem} ReviewItem */
/** @typedef {import('../plan.js').ReviewGrant} ReviewGrant */
/** @typedef {import('../plan.js').ReviewRun} ReviewRun */
/** @typedef {import('../plan.js').ReviewCost} ReviewCost */
/** @typedef {import('./local.js').PaxHost} PaxHost */
/** @typedef {import('./local.js').HostCheck} HostCheck */

/**
 * The Fabric route's preflight, with no capacities or subscriptions, and this PC.
 * @typedef {import('../plan.js').Preflight & { host: PaxHost, secretOnPc: boolean }} PaxPreflight
 */

/** Where the refresh keeps PAX, its scripts and its local copies of the files, in words. */
const LOCAL_FOLDER = `%LOCALAPPDATA%\\${PRODUCT.home}\\${PRODUCT.pax.folder}`;

/**
 * What the refresh collects, one label each.
 * @param {InstallConfig} config
 */
export const paxCollectedLabels = (config) =>
  userInfoMode() ? ['users and their departments, as the org file'] : ['Copilot interactions', 'users', ...(config.pax?.agent365 ? ['Agent 365'] : [])];

/**
 * What the refresh collects, in words.
 * @param {InstallConfig} config
 */
export const paxCollected = (config) => paxCollectedLabels(config).join(', ');

/**
 * Whether this install deploys the app: on unless switched off, and only from a copy of the
 * installer that carries the app's build.
 * @param {Ctx} ctx
 */
export const paxAppWanted = (ctx) => ctx.config.pax?.deployApp !== false && !!ctx.sources.appDist;

/** The task, as recorded or as a new install makes it. @param {InstallConfig} config */
const taskOf = (config) => config.pax?.task ?? { name: PRODUCT.pax.task, at: TASK_AT };

/**
 * Checks the tenant, then this PC. Stops, saying what to install or change, when this PC can't run
 * the scheduled refresh.
 * @param {Ctx} ctx
 * @returns {Promise<PaxPreflight>}
 */
export async function paxPreflight(ctx) {
  const { ui, api, user, config } = ctx;
  const host = paxHostOf(ctx);
  // install asks for the route on a host that can run it; update and repair reach here from the record.
  const hostProblem = paxHostProblem(host);
  if (hostProblem) throw new Error(hostProblem);
  // Checking this PC runs PowerShell a few times, so it starts now and is read after the tenant.
  const pcCheck = checkHost(host).then(
    (check) => ({ check }),
    (/** @type {unknown} */ error) => ({ error }),
  );

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
  if (!config.app.appId && canCreateApps === false) {
    ui.warn(`Users in this tenant can't register apps and you have no app admin role. Choose "Use an app registration I already have", or get an admin pack for an admin to register ${PRODUCT.pax.app}.`);
  }

  const seats = await copilotSeats(api);
  if (seats) ui.ok(`${seatCount(seats)} Microsoft 365 Copilot ${seats === 1 ? 'seat' : 'seats'} assigned`);

  /** @type {import('../plan.js').Preflight['tenantSettings']} */
  let tenantSettings;
  try {
    tenantSettings = Object.fromEntries((await api.fabric.tenantSettings()).map((s) => [s.settingName, s]));
  } catch {
    // Only Fabric administrators can read them.
  }
  // The model signs in to SharePoint as you, not as the app, so only the report's settings count here.
  if (ctx.sources.paxModelFile) {
    for (const s of blockedSettings(tenantSettings, { reports: true }).filter((s) => s.reports)) ui.warn(`The tenant setting "${s.title}" looks off. ${s.effect}`);
  }

  ui.heading('Checking this PC');
  const done = await pcCheck;
  if ('error' in done) throw done.error;
  const { pwsh, python, problems } = done.check;
  if (pwsh && !problems.some((p) => p.part === 'pwsh')) ui.ok(`PowerShell ${pwsh.version} (execution policy ${pwsh.policy})`);
  if (python) ui.ok(`Python ${python.version} (${python.command})`);
  for (const p of problems) {
    ui.fail(p.title);
    ui.info(p.fix);
  }
  if (problems.length) {
    throw new Error(
      `This PC can't run the scheduled refresh yet. Missing: ${problems.map((p) => p.title).join('; ')}. Fix ${problems.length === 1 ? 'it' : 'them'}, then run the installer again.`,
    );
  }
  if (pwsh?.timeZone) (config.powerBi ??= {}).timeZone ??= pwsh.timeZone;

  // An app you brought needs its secret on this PC. One the installer made gets a new one.
  const target = config.pax?.credentialTarget;
  const secretOnPc = target ? (await secretStored(host, target).catch(() => ({ exists: false }))).exists : false;

  return { capacities: [], subscriptions: [], roles: roles.map((r) => r.displayName), canConsent, canCreateApps, tenantSettings, seats, host, secretOnPc };
}

/**
 * Picks the Power BI workspace for the report: one you're in that holds no Analytics Hub install,
 * or a new one, which the install creates.
 * @param {Ctx} ctx
 * @param {boolean} askName  Whether to ask a new workspace's name.
 */
async function chooseWorkspace(ctx, askName) {
  const { ui, config, api } = ctx;
  const f = config.fabric;
  if (f.workspaceId) {
    ui.ok(`Workspace: ${f.workspaceName ?? f.workspaceId}`);
    return;
  }
  /** @type {{ id: string, name: string }[]} */
  let workspaces = [];
  try {
    workspaces = (await api.powerBi.groups()).map((g) => ({ id: String(g.id), name: String(g.name ?? g.id) }));
  } catch {
    // None listed: a new one.
  }
  /** @type {Set<string>} */
  const refused = new Set();
  for (;;) {
    const offered = workspaces.filter((w) => !refused.has(w.id));
    const choice = await ui.select(
      'Power BI workspace for the report',
      [{ name: 'Create a new workspace', value: '' }, ...offered.map((w) => ({ name: `Use "${w.name}"`, value: w.id }))],
      '',
    );
    const picked = workspaces.find((w) => w.id === choice);
    if (picked && foreignInstall(await workspaceItems(ctx, picked.id))) {
      refused.add(picked.id);
      ui.warn(foreignWorkspaceMessage(picked.name));
      continue;
    }
    if (picked) {
      f.workspaceId = picked.id;
      f.workspaceName = picked.name;
      delete f.createdWorkspace;
      return;
    }
    const taken = new Set(workspaces.map((w) => w.name.toLowerCase()));
    const suggested = f.workspaceName && !taken.has(f.workspaceName.toLowerCase()) ? f.workspaceName : uniqueName(PRODUCT.pax.workspace, taken);
    f.workspaceName = askName
      ? (
        await ui.input('New workspace name', {
          default: suggested,
          validate: (v) => (!v.trim() ? 'Required' : taken.has(v.trim().toLowerCase()) ? 'A workspace with that name exists.' : true),
        })
      ).trim()
      : suggested;
    return;
  }
}

/**
 * The PAX route's questions. With a section, only that one, for Repair or change.
 * @param {Ctx} ctx
 * @param {PaxPreflight} pre
 * @param {string} [section]  data, placement, access, identity or schedule.
 */
export async function paxPlan(ctx, pre, section) {
  const { ui, config, sources } = ctx;
  const pax = (config.pax ??= {});
  const sm = config.semanticModel;
  const advanced = () => !!section || asksAdvanced(ctx);
  const editing = (/** @type {string} */ id) => !section || section === id;
  const report = !!sources.paxModelFile;

  if (editing('data')) {
    ui.heading('What it collects');
    if (userInfoMode()) {
      ui.info(
        `The org file, ${PRODUCT.pax.files.users}: your users and their departments, from Entra ID. PAX (the Portable Audit eXporter) reads them on this PC each day, and each run replaces the file whole. The report reads the rest through its own connectors.`,
      );
      if (!section) await askAdvanced(ctx, 'who can view, the new workspace\'s name and when the refresh runs');
    } else {
      ui.info(`Copilot interactions, from the Purview audit log, and users, from Entra ID. PAX (the Portable Audit eXporter) reads them on this PC each day.`);
      if (!section) await askAdvanced(ctx, 'the Agent 365 file, who can view, the new workspace\'s name, the first load\'s history and when the refresh runs');
      if (advanced()) {
        ui.note(`The Agent 365 file lists your tenant's agents. It needs two more Microsoft Graph permissions: ${PAX_AGENT365_PERMISSIONS.join(' and ')}.`);
        pax.agent365 = await ui.confirm('Also collect the Agent 365 file?', !!pax.agent365);
      }
    }
  }

  if (editing('placement')) {
    ui.heading('Where the files go');
    if (ui.yes && !config.sharePoint?.folderUrl) {
      throw new Error('A new setup needs the SharePoint folder. Add "sharePoint": { "folderUrl": "<the folder\'s address>" } to the install record, or run without --yes.');
    }
    ui.info('The refresh keeps its CSV files in a folder in a SharePoint document library, where the report and the app read them.');
    const answer = await ui.input('SharePoint folder address', { default: config.sharePoint?.folderUrl, validate: folderValidator });
    config.sharePoint = folderConfig(parseSharePointFolder(answer), config.sharePoint);
    ui.ok(`Files: ${describeFolder(config.sharePoint)}`);

    sm.enabled = report;
    if (report) {
      sm.reports = true;
      if (!sm.id && (!sm.name || sm.name === MODEL_NAME)) sm.name = PRODUCT.pax.model;
      await chooseWorkspace(ctx, advanced());
    } else {
      ui.note('This copy of the installer has no SharePoint Power BI template, so it won\'t publish the report.');
    }

    ui.heading('The app');
    if (!sources.appDist) {
      ui.note(`This copy of the installer has no build of the app, so it won't deploy ${THE_APP}.`);
    } else {
      ui.info(`${APP_NAME} is also a Copilot managed app, shared with the viewer group.`);
      ui.note(`Each person who opens it needs Power Apps Premium or Copilot Credits: ${ADMIN_STEPS.licences.link}`);
      ui.note(dataHint(config));
      ui.note(
        `If the tenant isn't ready for managed apps (${NOT_READY_NAMES.createApps} or ${NOT_READY_NAMES.externalArtifacts} turned off), setup finishes at the report and says what a Power Platform admin turns on.`,
      );
      pax.deployApp = await ui.confirm(`Deploy ${THE_APP}?`, pax.deployApp !== false);
    }
  }

  if (editing('access')) {
    if (sm.enabled || paxAppWanted(ctx)) await planAccess(ctx);
  }

  if (editing('identity')) {
    ui.heading('App registration');
    let askSecret = false;
    let packWanted = false;
    if (config.app.appId) {
      ui.ok(`Using ${config.app.displayName ?? 'app'} (${config.app.appId})`);
      askSecret = !!config.app.existing && !pre.secretOnPc && !ctx.pendingSecret;
    } else {
      const blocked = pre.canCreateApps === false || !pre.canConsent || !!config.app.adminPack;
      const mode = await ui.select(
        'The scheduled refresh signs in to Microsoft Graph and SharePoint as an app.',
        [
          { name: `Create "${appName(config)}" (recommended)`, value: 'new', description: 'Application permissions only, with access to the one SharePoint site.' },
          { name: 'Use an app registration I already have', value: 'existing', description: 'You enter its client ID and a client secret.' },
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
    if (packWanted) askSecret = await planAdminPack(ctx, pre);
    if (askSecret) {
      if (ui.yes) throw new Error('The app registration\'s client secret isn\'t on this PC. Run the installer without --yes to enter it.');
      ctx.pendingSecret = await ui.secret('Client secret value (not the secret ID). It goes to Windows Credential Manager on this PC, for your account only.');
    }
  }

  if (editing('schedule')) {
    const task = (pax.task ??= { name: PRODUCT.pax.task, at: TASK_AT });
    const started = !!(task.registeredAt || pax.firstRun);
    if (userInfoMode()) {
      // Each run replaces the org file whole, so there's no history to load or reload.
      delete ctx.reloadHistoryDays;
    } else if (!started) {
      delete ctx.reloadHistoryDays;
      pax.seedDays = advanced() ? await ui.select('How much audit history should the first load pull?', HISTORY_CHOICES, pax.seedDays ?? SEED_DAYS) : pax.seedDays ?? SEED_DAYS;
      config.history = { ...config.history, days: pax.seedDays };
    } else {
      await askMoreHistory(
        ctx,
        (days) => `PAX reads ${days} days of the audit log in one run on this PC, straight after setup, and adds what the files are missing. It takes hours on a large tenant. The daily runs carry on after it.`,
      );
    }
    if (section && ui.web) {
      const values = await ui.form('Schedule', [{ id: 'runAt', label: 'Time the refresh starts (this PC\'s time, 24-hour)', default: task.at, validate: validateTime }]);
      if (!values) throw Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' });
      task.at = values.runAt;
    } else if (advanced()) {
      ui.heading('Schedule');
      task.at = await ui.input('When should the refresh run each day? (this PC\'s time, 24-hour)', { default: task.at, validate: validateTime });
    }
    ui.note(`The refresh runs daily at ${task.at} on this PC, as you. If the PC is off or you're signed out then, it runs when you next sign in.`);
    ctx.runFirstLoad = started ? false : !advanced() || (await ui.confirm('Run the first load as soon as setup finishes?', true));
  }
}

/**
 * What the plan creates, who it gives access to what, and where it runs.
 * @param {Ctx} ctx
 * @param {Pick<PaxPreflight, 'canConsent'>} [pre]
 * @returns {PlanReview}
 */
export function paxPlanReview(ctx, pre) {
  const { config, user } = ctx;
  const pax = config.pax ?? {};
  const sp = config.sharePoint;
  const sm = config.semanticModel;
  const f = config.fabric;
  const task = taskOf(config);
  const app = paxAppWanted(ctx);
  const name = config.app.appId ? config.app.displayName ?? config.app.appId : appName(config);
  const workspace = f.workspaceName ?? f.workspaceId ?? PRODUCT.pax.workspace;
  const model = sm.name && sm.name !== MODEL_NAME ? sm.name : PRODUCT.pax.model;
  const access = accessReview(config, `Semantic model ${model} in workspace ${workspace}`);
  const group = config.access ? `${config.access.groupName ?? VIEWER_GROUP_NAME} (group)` : undefined;
  const userInfo = userInfoMode();
  const orgFile = PRODUCT.pax.files.users;

  /** @type {ReviewItem[]} */
  const creates = [
    {
      kind: 'App registration',
      name,
      isNew: !config.app.appId,
      detail:
        config.app.adminPack && !config.app.appId
          ? 'An admin registers it from the admin pack and sends you its client ID.'
          : config.app.existing
            ? 'One you already have.'
            : 'Single tenant, with application permissions only.',
    },
    {
      kind: 'Client secret',
      name: `${name} refresh secret`,
      isNew: !pax.secretSetAt,
      detail: config.app.existing
        ? 'The one you enter, kept in Windows Credential Manager on this PC, for your account only.'
        : 'Kept in Windows Credential Manager on this PC, for your account only. Repair replaces it before it expires.',
    },
    { kind: 'PAX', name: `PAX ${PAX_RELEASE.tag}`, isNew: pax.version !== PAX_RELEASE.tag, detail: `The refresh downloads it from GitHub into ${LOCAL_FOLDER} and checks its SHA-256 before running it.` },
    {
      kind: 'Scheduled task',
      name: task.name,
      isNew: !task.registeredAt,
      detail: userInfo
        ? `Daily at ${task.at} on this PC, as you. Runs PAX for the user directory, then replaces ${orgFile} in the SharePoint folder.`
        : `Daily at ${task.at} on this PC, as you. Runs PAX, then uploads its files to the SharePoint folder.`,
    },
    {
      kind: 'SharePoint folder',
      name: sp ? describeFolder(sp) : 'not chosen',
      isNew: false,
      detail: userInfo
        ? `Yours. Made if it's missing. The refresh keeps the org file, ${orgFile}, at its top, and replaces it whole each run.`
        : 'Yours. Made if it\'s missing. The refresh keeps its CSV files here.',
    },
  ];
  if (sm.enabled) {
    creates.push(
      { kind: 'Workspace', name: workspace, isNew: !f.workspaceId, detail: 'In Power BI. It needs no capacity: Power BI Pro is enough.' },
      {
        kind: 'Semantic model',
        name: model,
        isNew: !sm.id,
        detail: `Reads the files in the SharePoint folder. Refreshes daily at ${refreshTimes(task.at).join(' and ')}, once you've signed it in to SharePoint.`,
      },
      { kind: 'Report', name: sm.report?.name ?? PRODUCT.pax.report, isNew: !sm.report?.id },
    );
  }
  creates.push(...access.creates);
  if (app) {
    creates.push({
      kind: 'Managed app',
      name: APP_NAME,
      isNew: !config.managedApp?.appId,
      detail: 'A Copilot managed app, shared with the viewer group. If the tenant isn\'t ready for managed apps, setup finishes at the report and says what to turn on.',
    });
  }

  /** @type {ReviewGrant[]} */
  const grants = [
    {
      who: `${name} (app)`,
      what: requiredPermissions(config).join(', '),
      where: 'Microsoft Graph',
      detail: pre?.canConsent === false ? 'Application permissions. A Global Administrator or Privileged Role Administrator approves them from a link the installer gives you.' : 'Application permissions, with admin consent.',
    },
    {
      who: `${name} (app)`,
      what: 'Write (Sites.Selected)',
      where: `SharePoint site ${sp?.siteUrl ?? 'not chosen'}`,
      detail: sp?.granted ? 'This site only.' : `This site only. ${SITE_ADMIN} gives it; if that isn't you, the installer shows the commands to send them.`,
    },
  ];
  if (sm.enabled) grants.push(...access.grants);
  if (app && group) grants.push({ who: group, what: 'Can open the app', where: THE_APP, detail: 'Shared with the group when the app is deployed. Members also need read access to the SharePoint folder.' });

  /** @type {ReviewRun[]} */
  const runsOn = [
    {
      what: 'PAX and the upload',
      where: `This PC, daily at ${task.at}, as ${user.upn}`,
      detail: 'While you\'re signed in. A run missed while the PC was off or you were signed out runs when you next sign in.',
    },
  ];
  if (sm.enabled) runsOn.push({ what: 'Semantic model and report', where: `Power BI workspace ${workspace}` });
  if (app) runsOn.push({ what: THE_APP, where: 'Copilot managed apps, in a Power Platform environment', detail: 'Your developer environment, unless you pass --environment-id.' });
  if (ctx.runFirstLoad) {
    runsOn.push(
      userInfo
        ? { what: 'First load', where: 'The org file, straight after setup', detail: 'One PAX run on this PC.' }
        : { what: 'First load', where: `${pax.seedDays ?? SEED_DAYS} days of audit history, straight after setup`, detail: 'One PAX run on this PC. It takes hours on a large tenant.' },
    );
  }
  if (ctx.reloadHistoryDays) runsOn.push({ what: 'History reload', where: reloadLine(ctx.reloadHistoryDays), detail: 'One PAX run on this PC that adds what the files are missing.' });

  /** @type {ReviewCost[]} */
  const costs = [];
  if (sm.enabled) {
    costs.push({ what: 'Power BI Pro', detail: 'For you, to publish the report, and for each viewer unless the workspace is on a paid F64 or larger Fabric capacity, or a Power BI Premium capacity.', url: PRICING.powerBiPro });
  }
  if (app) costs.push({ what: 'Power Apps Premium or Copilot Credits', detail: 'For each person who opens the app.', url: LINKS.licensing });
  return { creates, grants, runsOn, costs };
}

/**
 * Prints the plan and asks to go ahead.
 * @param {Ctx} ctx
 * @param {Pick<PaxPreflight, 'canConsent'>} [pre]
 */
export async function confirmPaxPlan(ctx, pre) {
  const { ui, config } = ctx;
  const sm = config.semanticModel;
  const f = config.fabric;
  const task = taskOf(config);
  const isNew = c.dim('(new)');
  ui.heading('Ready to set up');
  ui.info(`Data:        ${paxCollected(config)}`);
  ui.info(`Files:       ${config.sharePoint ? describeFolder(config.sharePoint) : 'not chosen'}`);
  ui.info(`Refresh:     daily at ${task.at} on this PC ${c.dim(`(${task.name})`)}`);
  ui.info(`Entra app:   ${config.app.appId ? config.app.appId : `${appName(config)} ${isNew}`}`);
  if (sm.enabled) {
    ui.info(`Power BI:    ${sm.name ?? PRODUCT.pax.model} in ${f.workspaceName ?? f.workspaceId ?? PRODUCT.pax.workspace} ${f.workspaceId ? '' : c.dim('(new workspace)')}`.trimEnd());
  }
  ui.info(`App:         ${paxAppWanted(ctx) ? `${APP_NAME} ${config.managedApp?.appId ? '' : isNew}`.trimEnd() : c.dim('not deployed')}`);
  if (ctx.runFirstLoad) ui.info(`First load:  ${userInfoMode() ? 'the org file' : `${config.pax?.seedDays ?? SEED_DAYS} days of history`}, straight after setup`);
  if (ctx.reloadHistoryDays) ui.info(`History:     ${reloadLine(ctx.reloadHistoryDays)}`);
  ui.review(paxPlanReview(ctx, pre));
  ui.note(keepAwake());
  if (ctx.runFirstLoad) ui.note('The first load runs in the scheduled task, so leave this PC on and signed in until it finishes.');
  return ui.confirm('Go ahead?', true);
}
