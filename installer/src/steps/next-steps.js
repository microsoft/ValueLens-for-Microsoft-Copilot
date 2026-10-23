// @ts-check
/**
 * What's left once the installer finishes, as cards for the Done page and the terminal summary:
 * the steps the user does, then hand-offs, each with a message to copy and send to the admin who does it.
 * One list, in the order it should be done, so new steps only need adding here.
 */
import { PRODUCT } from '../product.js';
import { FEEDBACK_SUBJECT } from '../transform/flows.js';
import { connectionSteps, FLOW_NAMES, flowsWanted } from './flows.js';
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
 * The cards, in the order to do them: sign in to the flows, then hand-offs to other admins. Empty
 * when nothing is left.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string, upn?: string }} [user]
 * @returns {NextStep[]}
 */
export function nextSteps(config, user = {}) {
  return [
    flowsStep(config, user),
    entraRoleStep(config, user),
    m365ExportStep(config, user),
  ].filter(/** @returns {s is NextStep} */ (s) => !!s);
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
