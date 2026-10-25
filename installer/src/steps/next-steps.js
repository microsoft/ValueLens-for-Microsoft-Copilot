// @ts-check
/**
 * What's left once the installer finishes, as cards for the Done page and the terminal summary:
 * the steps the user does, then hand-offs, each with a message to copy and send to the admin who does it.
 * One list, in the order it should be done, so new steps only need adding here.
 */
import { commandLine } from '../launch.js';
import { ADMIN_STEPS, deployAgain, LINKS } from '../managed-app/errors.js';
import { PRODUCT } from '../product.js';
import { appName, isPax } from '../target.js';
import { FEEDBACK_SUBJECT } from '../transform/flows.js';
import { myGroupsUrl, PRO_VIEWERS, shareReportPending, shareReportSteps, VIEWER_GROUP_NAME, viewerReport, workspaceUrl } from './access.js';
import { connectionSteps, FLOW_NAMES, flowsWanted } from './flows.js';
import { modelSettingsUrl } from './model.js';
import { SEED_DAYS } from './pax/local.js';
import { credentialSteps, desktopSteps } from './pax/publish.js';
import { pnpGrantCommand, SITE_ADMIN, siteGrantCommands, siteRemovalCommands } from './pax/site.js';
import { APP_NAME } from './plan.js';
import { AGENT_DIRECTORY_ROLES, resourceGraphOn } from './resource-graph.js';

/**
 * @typedef {object} NextStep
 * @property {string} id  Stable, e.g. "flows".
 * @property {string} title
 * @property {string} why  Why it matters, in a sentence or two.
 * @property {string} who  Who does it, e.g. "You" or "A Microsoft 365 admin".
 * @property {string} [link]
 * @property {string} [linkText]
 * @property {string[]} [steps]  One whole step each, to show numbered.
 * @property {string} [message]  For a hand-off: a message to copy and send to whoever does it.
 * @property {string} [activity]  The pipeline activity that fails until it's done. That failure is expected.
 * @property {boolean} [optional]
 */

/** The Entra role template ID of Global Reader, the same in every tenant. */
export const GLOBAL_READER_ROLE_ID = 'f2ef992c-3afb-46b9-b7cf-a126ee74c451';
export const ENTRA_ROLES_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/RolesManagementMenuBlade/~/AllRoles';
export const M365_ADMIN_URL = 'https://admin.microsoft.com/';
export const AUDIT_URL = 'https://learn.microsoft.com/purview/audit-log-enable-disable';
export const DESKTOP_URL = 'https://learn.microsoft.com/power-bi/fundamentals/desktop-get-the-desktop';
const MAKER = 'https://make.powerautomate.com/';

/**
 * A message to someone else: a greeting, the ask, the details, and a sign-off.
 * @param {string[]} body
 * @param {string | undefined} from
 */
const letter = (body, from) => ['Hi,', '', ...body, '', 'Thanks', ...(from ? [from] : [])].join('\n');

/** @param {string[]} steps */
const numbered = (steps) => steps.map((s, i) => `${i + 1}. ${s}`);

/**
 * The cards, in the order to do them, for the install's route. Fabric: share the report, sign in to
 * the flows, then hand-offs to other admins. PAX + SharePoint: the site, the first refresh, the
 * report, the app, then the scheduled task. Empty when nothing is left.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string, upn?: string }} [user]
 * @returns {NextStep[]}
 */
export function nextSteps(config, user = {}) {
  const steps = isPax(config)
    ? [
        siteGrantStep(config, user),
        firstRefreshStep(config),
        desktopPublishStep(config),
        modelCredentialsStep(config, user),
        shareReportStep(config, user),
        appSettingsStep(config, user),
        appSkippedStep(config),
        taskLogonStep(config),
        retiredGrantsStep(config, user),
      ]
    : [shareReportStep(config, user), flowsStep(config, user), entraRoleStep(config, user), m365ExportStep(config, user)];
  return steps.filter(/** @returns {s is NextStep} */ (s) => !!s);
}

/**
 * "2 steps left", "1 step left, and 1 optional".
 * @param {NextStep[]} steps
 */
export function stepsLeftTitle(steps) {
  const needed = steps.filter((s) => !s.optional).length;
  const optional = steps.length - needed;
  if (!needed) return `${optional} optional ${optional === 1 ? 'step' : 'steps'}`;
  return `${needed} ${needed === 1 ? 'step' : 'steps'} left${optional ? `, and ${optional} optional` : ''}`;
}

/** The app registration's name, as the record has it. @param {import('../config.js').InstallConfig} config */
const appLabel = (config) => config.app?.displayName ?? appName(config);

/**
 * The PAX route: the app's write access to the folder's site, which only a SharePoint Administrator
 * or Global Administrator can give (Sites.Selected). Until then the refresh has nowhere to write.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function siteGrantStep(config, user) {
  const sp = config.sharePoint;
  const appId = config.app?.appId;
  if (!sp?.pendingAdminGrant || !appId) return null;
  const app = appLabel(config);
  return {
    id: 'site-grant',
    title: 'Ask for the app\'s access to the SharePoint site',
    why: `The daily refresh signs in as "${app}", which can write only to sites an administrator gives it (Sites.Selected). Until it has ${sp.siteUrl}, no files reach the folder and the report has no data. Once it's given, run ${commandLine('run')}.`,
    who: SITE_ADMIN,
    steps: [
      'Open PowerShell 7 and run the commands in the message. They give the app write access to this one site, and no other.',
      'Or, with PnP PowerShell, run the command at the end of the message.',
    ],
    message: letter(
      [
        `Could you give our app "${app}" write access to one SharePoint site? It refreshes the ${PRODUCT.name} report's Copilot usage data into a folder there each day. It has the Sites.Selected permission, so it can write only to the sites it's given.`,
        '',
        `App: ${app}`,
        `Application (client) ID: ${appId}`,
        `Site: ${sp.siteUrl}`,
        '',
        'In PowerShell 7, as a SharePoint Administrator or Global Administrator:',
        ...siteGrantCommands(config),
        '',
        'Or, with PnP PowerShell:',
        pnpGrantCommand(config),
      ],
      user.upn,
    ),
  };
}

/**
 * The PAX route: the first refresh, while it runs, and how it ended when it didn't succeed. It's
 * cleared once a refresh succeeds.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function firstRefreshStep(config) {
  const first = config.pax?.firstRun;
  if (!first) return null;
  const days = config.pax?.seedDays ?? SEED_DAYS;
  const run = commandLine('run');
  const status = commandLine('status');
  if (first.result === 'failed') {
    return {
      id: 'first-refresh',
      title: 'Fix the first refresh',
      why: `The first refresh failed${first.error ? `: ${first.error}` : '.'} Until one succeeds, the folder has no files and the report has no data.`,
      who: 'You',
      steps: [
        first.log ? `Read its log: ${first.log}` : `Read its log, in the logs folder under ${config.pax?.workRoot ?? 'the refresh\'s folder'}.`,
        'Fix what it says. If an administrator has to, send them the error.',
        `Run ${run} to start it again, then ${status} to see how it went.`,
      ],
    };
  }
  if (first.result === 'no-data') {
    return {
      id: 'first-refresh',
      title: 'Check Copilot activity is audited',
      why: `The first refresh found no Copilot activity in the last ${days} days, so the report is empty. Either nobody used Copilot then, or auditing is off. Each daily refresh looks again.`,
      who: 'You, or a Microsoft Purview administrator',
      link: AUDIT_URL,
      linkText: 'Turn auditing on or off',
      steps: [
        'In the Microsoft Purview portal, open Audit. If it offers to start recording user and admin activity, auditing is off: turn it on. New activity is then audited from that point.',
        'Check that people have Microsoft 365 Copilot licences and have used Copilot.',
        `Run ${run} to look again now, or wait for the daily refresh.`,
      ],
      optional: true,
    };
  }
  const refreshAt = config.powerBi?.refreshAt;
  const signedIn = config.pax?.task?.logonType === 'Password';
  return {
    id: 'first-refresh',
    title: 'Wait for the first refresh to finish',
    why: `It reads the last ${days} days of Copilot activity from the audit log, which can take hours on a large tenant. The report has no data until it finishes.`,
    who: 'You',
    steps: [
      `Check on it with ${status}. Leave this PC on${signedIn ? '' : ', and stay signed in,'} until it finishes.`,
      refreshAt
        ? `Once it has finished, the report loads the data at its daily refresh at ${refreshAt}. To load it sooner, run ${commandLine('refresh')}.`
        : `Once it has finished, run ${commandLine('refresh')} to load the data into the report.`,
    ],
  };
}

/**
 * The PAX route: the filled-in template handed to Power BI Desktop, until the installer finds it published.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function desktopPublishStep(config) {
  const pbi = config.powerBi;
  if (!pbi?.desktopPending || !pbi.desktopFile) return null;
  const workspace = config.fabric?.workspaceName ?? config.fabric?.workspaceId ?? PRODUCT.pax.workspace;
  return {
    id: 'desktop-publish',
    title: 'Publish the report from Power BI Desktop',
    why: 'Power BI didn\'t take the report through its API, so publish it once from Desktop. The installer then finds it and finishes setting it up.',
    who: 'You',
    link: DESKTOP_URL,
    linkText: 'Get Power BI Desktop',
    steps: [...desktopSteps(pbi.desktopFile, workspace, pbi.desktopName, !!config.semanticModel?.id), 'Run the installer again. It finds the report you published and carries on.'],
  };
}

/**
 * The PAX route: signing the model in to SharePoint, which Power BI has no API for. Until then the
 * report can't refresh. Not while the report waits to be published from Desktop, which signs it in.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string }} user
 * @returns {NextStep | null}
 */
function modelCredentialsStep(config, user) {
  const sm = config.semanticModel;
  const ws = config.fabric?.workspaceId;
  if (!sm?.id || !ws || sm.bound || config.powerBi?.desktopPending) return null;
  const url = modelSettingsUrl(ws, sm.id, user.tenantId ?? config.tenantId);
  return {
    id: 'model-credentials',
    title: `Sign ${sm.name} in to SharePoint`,
    why: 'The report reads the files in the SharePoint folder as whoever signs its model in. Power BI has no way for the installer to do it, and until it\'s done the report can\'t refresh.',
    who: 'You',
    link: url,
    linkText: 'Open the model\'s settings',
    steps: [...credentialSteps(url), `Then run ${commandLine('refresh')}. It asks whether the model is signed in, loads the data and schedules the daily refresh.`],
  };
}

/**
 * Sharing the report with the viewer group, until the user says it's done. Power BI has no API for it,
 * and the group gets no workspace role instead, which would let its members read the notebooks.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string }} user
 * @returns {NextStep | null}
 */
function shareReportStep(config, user) {
  const report = viewerReport(config);
  if (!report || !shareReportPending(config)) return null;
  const a = /** @type {import('../config.js').AccessConfig} */ (config.access);
  const group = a.groupName ?? VIEWER_GROUP_NAME;
  const groupUrl = myGroupsUrl(/** @type {string} */ (a.groupId));
  return {
    id: 'share-report',
    title: `Share the report with ${group}`,
    why: isPax(config)
      ? `Once only. Until it's shared, people in the group can't open the report. After that, give people access by adding them to the group (${groupUrl}). They need no workspace role. ${PRO_VIEWERS}`
      : `Once only. Until it's shared, people in the group can't open the report. After that, give people access by adding them to the group (${groupUrl}), not by giving them a workspace role.`,
    who: 'You',
    link: workspaceUrl(report.workspaceId, user.tenantId),
    linkText: 'Open the workspace',
    steps: shareReportSteps(config, user.tenantId),
  };
}

/**
 * The flows the installer made or wrote out, which someone signs in to and turns on.
 * Doubles as the hand-off to a Power Platform admin.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function flowsStep(config, user) {
  const up = config.uploads;
  const kinds = flowsWanted(config).filter((k) => up?.flowIds?.[k] || up?.flowFiles?.[k]);
  if (!kinds.length) return null;
  const env = up.flowEnvironment;
  const link = env?.id ? `${MAKER}environments/${env.id}/flows` : MAKER;
  const where = env?.name ?? env?.url ?? 'the Power Automate environment';
  /** @type {string[]} */
  const steps = [];
  /** @type {string[]} */
  const details = [];
  for (const kind of kinds) {
    const name = FLOW_NAMES[kind];
    const file = up.flowFiles?.[kind];
    const open = file ? `Import ${name} from ${file} into ${where}` : `Open ${name} in ${where}`;
    const signIns = connectionSteps(config, kind);
    steps.push(`${open}, sign in to its connections, save it and turn it on.`);
    details.push(`${name}${file ? ` (to import: ${file})` : ''}:`, ...numbered([open + '.', ...signIns, 'Save, then turn it on.']).map((s) => `  ${s}`), '');
  }
  const one = kinds.length === 1;
  return {
    id: 'flows',
    title: `Sign in to the Power Automate ${one ? 'flow' : 'flows'}`,
    why: `${one ? 'It stays' : 'They stay'} off until ${one ? 'its' : 'their'} connections are signed in, so ${one ? 'its data doesn\'t' : 'their data doesn\'t'} load.`,
    who: 'You, or a Power Platform administrator',
    link,
    linkText: 'Open Power Automate',
    steps,
    message: letter(
      [
        `Could you sign in to the connections of the ${PRODUCT.name} ${one ? 'flow' : 'flows'} in Power Automate and turn ${one ? 'it' : 'them'} on? ${one ? 'It is' : 'They are'} in ${where}: ${link}`,
        '',
        ...details,
        'Signing in with a dedicated admin account and adding a co-owner keeps the flows running if people move on.',
      ],
      user.upn,
    ),
  };
}

/**
 * The Entra role the data collector app needs to see Copilot Studio agents in Resource Graph. Only a
 * Privileged Role Administrator can assign it. Shown until the install record says it's assigned.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function entraRoleStep(config, user) {
  if (!resourceGraphOn(config) || config.resourceGraph?.agents === false) return null;
  if (/** @type {{ roleAssigned?: boolean } | undefined} */ (config.resourceGraph)?.roleAssigned === true) return null;
  const app = config.app?.displayName ?? APP_NAME;
  const appId = config.app?.appId;
  const spId = config.app?.servicePrincipalId;
  const principal = spId ?? (appId ? `$(az ad sp show --id ${appId} --query id -o tsv)` : undefined);
  const roles = AGENT_DIRECTORY_ROLES.join(', ').replace(/, ([^,]*)$/, ' or $1');
  const steps = [
    'In the Microsoft Entra admin center, open Roles & admins and choose Global Reader.',
    `Choose Add assignments, search for "${app}" and select it.`,
    'Choose Add. With Privileged Identity Management, make it an active, permanent assignment.',
  ];
  const command = principal
    ? `az rest --method POST --url https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments --body '{"principalId":"${principal}","roleDefinitionId":"${GLOBAL_READER_ROLE_ID}","directoryScopeId":"/"}'`
    : undefined;
  return {
    id: 'entra-role',
    title: `Ask for Global Reader for "${app}"`,
    why: `Without one of ${roles}, Azure Resource Graph returns no Copilot Studio agents to the data collector, and the load says so. Global Reader is read-only. The installer can't assign Entra roles.`,
    who: 'A Privileged Role Administrator',
    link: ENTRA_ROLES_URL,
    linkText: 'Roles & admins in Entra',
    steps,
    message: letter(
      [
        `Could you give the app "${app}" the Global Reader role in Microsoft Entra? ${PRODUCT.name} uses it to read Copilot Studio agents from Azure Resource Graph, which returns none until the app has one of ${roles}. Global Reader is read-only.`,
        '',
        `App: ${app}`,
        ...(appId ? [`Application (client) ID: ${appId}`] : []),
        ...(spId ? [`Object ID (enterprise application): ${spId}`] : []),
        '',
        ...numbered(steps),
        `Roles & admins: ${ENTRA_ROLES_URL}`,
        ...(command ? ['', 'Or in Azure Cloud Shell (Bash):', command] : []),
      ],
      user.upn,
    ),
  };
}

/**
 * The emailed product feedback export the feedback flow saves. Only a Microsoft 365 admin can schedule it.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function m365ExportStep(config, user) {
  if (!flowsWanted(config).includes('feedback')) return null;
  const mailbox = user.upn ?? 'the mailbox the flow reads';
  const steps = [
    'In the Microsoft 365 admin center, open Health > Product feedback.',
    `Choose Export and schedule it to be emailed to ${mailbox}, with the subject "${FEEDBACK_SUBJECT}".`,
  ];
  return {
    id: 'm365-export',
    title: 'Ask for the product feedback export',
    why: `The ${FLOW_NAMES.feedback} flow saves the export when it arrives by email. Without it, product feedback has no data. If the flow's Outlook connection signs in as another mailbox, use that one.`,
    who: 'A Microsoft 365 admin',
    link: M365_ADMIN_URL,
    linkText: 'Microsoft 365 admin center',
    steps,
    message: letter(
      [
        `Could you schedule the Microsoft 365 product feedback export for ${PRODUCT.name}? A flow saves it when it arrives by email.`,
        '',
        ...numbered(steps),
        `The subject must be exactly "${FEEDBACK_SUBJECT}", so the flow picks it up.`,
      ],
      user.upn,
    ),
  };
}

/**
 * Whether the record has the app on: the PAX route's app step, unless it was turned off.
 * @param {import('../config.js').InstallConfig} config
 */
const appWanted = (config) => isPax(config) && config.pax?.deployApp !== false;

/**
 * The tenant settings for managed apps that the app step found turned off. The report works without
 * them; the app waits for a Power Platform admin.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function appSettingsStep(config, user) {
  const missing = appWanted(config) ? (config.managedApp?.missing ?? []) : [];
  if (!missing.length) return null;
  const steps = missing.map((key) => ADMIN_STEPS[key].what);
  const name = PRODUCT.managedApp.name;
  return {
    id: 'app-settings',
    title: 'Ask for managed apps to be turned on',
    why: `The ${name} app can't be deployed until these settings are on. The report works without it. Once they're on, run ${deployAgain()}.`,
    who: 'A Power Platform admin',
    link: LINKS.cliSetting,
    linkText: 'Managed apps settings',
    steps,
    message: letter(
      [
        `Could you turn on managed apps for me in the Power Platform admin center? I'm deploying the ${name} app, a Copilot managed app that shows our Copilot usage, and the environment doesn't allow it yet.`,
        '',
        ...numbered(steps),
        '',
        `How: ${LINKS.cliSetting}`,
      ],
      user.upn,
    ),
  };
}

/**
 * The app step, when it was skipped or failed: why, and what to do.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function appSkippedStep(config) {
  const skipped = appWanted(config) ? config.managedApp?.skipped : undefined;
  if (!skipped) return null;
  return {
    id: 'app-skipped',
    title: `Finish the ${PRODUCT.managedApp.name} app`,
    why: skipped.why,
    who: 'You',
    steps: skipped.steps,
  };
}

/** Opening the scheduled task's properties in Task Scheduler. @param {string} name */
const openTask = (name) => ['Open Task Scheduler and select Task Scheduler Library.', `Right-click "${name}" and choose Properties.`];

/**
 * The PAX route: how the scheduled task signs in. Registered, it runs only while the user is signed
 * in; Task Scheduler can run it signed out with the password stored. Without a stored password (S4U)
 * it can't read the client secret from Credential Manager, so every refresh fails.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function taskLogonStep(config) {
  const task = config.pax?.task;
  if (!task) return null;
  const who = 'You, or an administrator of this PC';
  if (task.logonType === 'Interactive') {
    return {
      id: 'task-logon',
      title: 'Keep the refresh running while you\'re signed out',
      why: `"${task.name}" runs only while you're signed in to this PC. If you aren't at ${task.at}, it runs once you next sign in. To have it run while nobody is signed in, change one setting. It still reads the client secret from your Credential Manager.`,
      who,
      steps: [
        ...openTask(task.name),
        'On the General tab, choose "Run whether user is logged on or not". Leave "Do not store password" unticked: the task needs your password to read the client secret.',
        'Select OK, and enter your Windows password when it asks. If Windows says the account needs the "Log on as a batch job" right, an administrator of this PC can give it.',
      ],
      optional: true,
    };
  }
  if (task.logonType === 'S4U') {
    return {
      id: 'task-logon',
      title: 'Store the password for the scheduled task',
      why: `"${task.name}" is set to run without a stored password, so it can't read the client secret from Credential Manager, and each refresh fails.`,
      who,
      steps: [...openTask(task.name), 'On the General tab, untick "Do not store password". Select OK, and enter your Windows password when it asks.'],
    };
  }
  return null;
}

/**
 * The PAX route: sites the folder moved away from, where the app can still write, until a
 * SharePoint Administrator or Global Administrator takes it back.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function retiredGrantsStep(config, user) {
  const grants = config.sharePoint?.retiredGrants ?? [];
  const appId = config.app?.appId;
  if (!grants.length || !appId) return null;
  const app = appLabel(config);
  const one = grants.length === 1;
  const sites = grants.map((g) => g.siteUrl).join(', ').replace(/, ([^,]*)$/, ' and $1');
  return {
    id: 'retired-grants',
    title: `Ask for the app's access to the old ${one ? 'site' : 'sites'} to be taken back`,
    why: `The folder moved, but "${app}" can still write to ${sites}, where it was before. Your account couldn't take that back.`,
    who: SITE_ADMIN,
    steps: [`Run the commands in the message in PowerShell 7, signed in as ${SITE_ADMIN.replace(/^A /, 'a ')}.`],
    message: letter(
      [
        `Could you take back our app "${app}"'s write access to ${one ? 'a SharePoint site' : 'some SharePoint sites'} it no longer uses? The ${PRODUCT.name} folder it writes to has moved to another site.`,
        '',
        `App: ${app}`,
        `Application (client) ID: ${appId}`,
        ...grants.flatMap((g) => ['', `Site: ${g.siteUrl}`, 'In PowerShell 7:', ...siteRemovalCommands(config, g)]),
      ],
      user.upn,
    ),
    optional: true,
  };
}
