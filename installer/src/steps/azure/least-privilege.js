// @ts-check
/**
 * Least-privilege Azure installs. An Azure admin creates the resource group, registers the resource
 * providers, and gives the person installing Contributor and a condition-limited Role Based Access
 * Control Administrator on just that group. These checks say what's missing before anything is created,
 * and print the commands for the admin for what the installer can't do itself.
 */
import { allowsAction, ROLES } from '../../clients/azure.js';
import { normaliseResourceGraph } from '../../config.js';
import { HttpError } from '../../http.js';
import { AZURE_AI_ROLES } from '../consumption.js';
import { resourceGraphOn, resourceGraphScope, scopeName } from '../resource-graph.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {{ scope: string, where: string, role: string, why: string }} AdminGrant */

export const LEAST_PRIVILEGE_DOC = 'docs/AZURE-LEAST-PRIVILEGE.md';

/**
 * The roles the ARM template assigns, and so all a condition-limited Role Based Access Control
 * Administrator has to allow. The installer also gives you Storage Blob Data Contributor in the group.
 */
export const TEMPLATE_ROLES = [
  { id: ROLES.storageBlobDataContributor, name: 'Storage Blob Data Contributor' },
  { id: ROLES.storageTableDataContributor, name: 'Storage Table Data Contributor' },
  { id: ROLES.cognitiveServicesOpenAiUser, name: 'Cognitive Services OpenAI User' },
  { id: ROLES.acrPull, name: 'AcrPull' },
];

const CREATE_GROUP = 'Microsoft.Resources/subscriptions/resourceGroups/write';
const DEPLOY = 'Microsoft.Resources/deployments/write';
const ASSIGN = 'Microsoft.Authorization/roleAssignments/write';

/**
 * The condition on Role Based Access Control Administrator: it can assign and remove only the
 * template's roles. Principal types aren't limited, because you get one of them yourself.
 */
export function roleCondition() {
  const ids = TEMPLATE_ROLES.map((r) => r.id).join(', ');
  return `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${ids}})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${ids}}))`;
}

/** "a, b or c", or "a, b and c". @param {string[]} items @param {'or' | 'and'} [word] */
const inWords = (items, word = 'or') => (items.length > 1 ? `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}` : items[0] ?? '');

/** An error's text, wherever ARM put it: the response body, a failed deployment's error, or the message. @param {any} err */
function textOf(err) {
  const body = err instanceof HttpError ? err.body : err?.body ?? err;
  let text = '';
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  } catch {
    // A body that can't be serialised still leaves the message.
  }
  return `${text} ${err?.message ?? ''}`;
}

/**
 * The az commands that register resource providers and feature flags, for someone with Contributor or
 * Owner on the subscription. A feature is "Namespace/Name"; its provider is registered after it.
 * @param {string} subscriptionId
 * @param {string[]} items  Provider namespaces, and features as "Namespace/Name".
 */
export function providerCommands(subscriptionId, items) {
  const features = items.filter((i) => i.includes('/')).map((i) => /** @type {[string, string]} */ (i.split('/')));
  const namespaces = [...new Set([...items.filter((i) => !i.includes('/')), ...features.map(([ns]) => ns)])];
  return [
    ...features.flatMap(([ns, name]) => [
      `az feature register --subscription ${subscriptionId} --namespace ${ns} --name ${name}`,
      `az feature show --subscription ${subscriptionId} --namespace ${ns} --name ${name} --query properties.state -o tsv`,
    ]),
    ...namespaces.map((ns) => `az provider register --subscription ${subscriptionId} --namespace ${ns} --wait`),
  ];
}

/**
 * Says which resource providers you couldn't register or check, with the commands for your Azure admin.
 * Registering is subscription-wide, so a least-privilege install relies on the admin having done it.
 * @param {Ctx} ctx
 * @param {{ unregistered: string[], unread: string[] }} found  Not registered and you can't register them; couldn't be read.
 */
export function reportProviders(ctx, found) {
  const { ui } = ctx;
  const sub = ctx.config.azure?.subscriptionId ?? '<subscription ID>';
  if (found.unregistered.length) {
    ui.warn(`You can't register resource providers in this subscription, and ${inWords(found.unregistered, 'and')} ${found.unregistered.length === 1 ? 'isn\'t' : 'aren\'t'} registered yet. Registering needs Contributor or Owner on the subscription, so ask your Azure admin to run this once:`);
    for (const line of providerCommands(sub, found.unregistered)) ui.info(line);
    if (found.unregistered.some((i) => i.includes('/'))) ui.note('Run the az feature show line until it says Registered before the az provider register lines.');
    ui.note(`Until then, Azure can't create the resources that need ${found.unregistered.length === 1 ? 'it' : 'them'}. See ${LEAST_PRIVILEGE_DOC}.`);
  }
  if (found.unread.length) {
    ui.note(`Couldn't check whether ${inWords(found.unread, 'and')} ${found.unread.length === 1 ? 'is' : 'are'} registered in this subscription. If Azure says one isn't, your Azure admin registers it once: see ${LEAST_PRIVILEGE_DOC}.`);
  }
}

/**
 * A deployment that failed because a resource provider or feature isn't registered in the subscription,
 * explained with the commands to register it.
 * @param {any} err
 * @param {string | undefined} subscriptionId
 * @param {string[]} items  What the install uses, for when the error doesn't name it.
 */
export function registrationMessage(err, subscriptionId, items) {
  const text = textOf(err);
  if (!/MissingSubscriptionRegistration|SubscriptionNotRegisteredForFeature|not registered to use namespace|not registered for (the )?feature/i.test(text)) return '';
  const features = [...text.matchAll(/feature \\?['"]?([\w.]+)\/([\w.]+)/gi)].map((m) => `${m[1]}/${m[2]}`);
  const namespaces = [...text.matchAll(/namespace \\?['"]([\w.]+)\\?['"]/gi)].map((m) => m[1]);
  const named = [...new Set([...features, ...namespaces])];
  const what = named.length ? `${inWords(named, 'and')} ${named.length === 1 ? 'isn\'t' : 'aren\'t'}` : 'a resource provider this install uses isn\'t';
  return [
    `Azure says ${what} registered in this subscription. Someone with Contributor or Owner on the subscription registers ${named.length === 1 ? 'it' : 'them'} once:`,
    ...providerCommands(subscriptionId ?? '<subscription ID>', named.length ? named : items),
    `Then run the installer again. See ${LEAST_PRIVILEGE_DOC}.`,
  ].join('\n');
}

/**
 * A deployment that failed because you can't assign one of the template's roles, explained with the
 * ways to get the right, including least privilege.
 * @param {any} err
 */
export function roleAssignMessage(err) {
  const text = textOf(err);
  if (!/AuthorizationFailed/i.test(text) || !/Microsoft\.Authorization\/roleAssignments\/(write|delete)/i.test(text)) return '';
  const scope = /over scope \\?['"]([^'"\\]+)/i.exec(text)?.[1]?.replace(/\/providers\/Microsoft\.Authorization\/roleAssignments\/[^/]*$/i, '');
  return [
    `Azure wouldn't let you assign a role${scope ? ` on ${scope}` : ''}.`,
    'The deployment gives its managed identity Storage Blob Data Contributor and Storage Table Data Contributor on its storage account, Cognitive Services OpenAI User on an Ask model it creates, and AcrPull on a private registry.',
    `Assigning them needs Owner, User Access Administrator, or Role Based Access Control Administrator with a condition that allows these roles, on the resource group (${LEAST_PRIVILEGE_DOC}). A private registry in another resource group needs it there too.`,
    'If you\'ve just been given or activated a role, wait a few minutes and run the installer again.',
  ].join('\n');
}

/**
 * Stops before anything is created when you can't install here, with what's missing and the ways to get
 * it, least privilege included. An existing resource group is checked there, so roles on just that group
 * count; a new one needs the subscription. Rights that can't be read stop nothing.
 * @param {Ctx} ctx
 * @param {boolean} rgExists
 */
export async function checkDeployRights(ctx, rgExists) {
  const az = /** @type {import('../../config.js').AzureConfig} */ (ctx.config.azure);
  const sub = `/subscriptions/${az.subscriptionId}`;
  /** @type {{ actions?: string[], notActions?: string[] }[]} */
  let perms;
  try {
    perms = await ctx.api.arm.permissions(rgExists ? `${sub}/resourceGroups/${az.resourceGroup}` : sub);
  } catch {
    return;
  }
  const lacks = [
    ...(rgExists || allowsAction(perms, CREATE_GROUP) ? [] : ['create resource groups']),
    ...(allowsAction(perms, DEPLOY) ? [] : ['deploy resources']),
    ...(allowsAction(perms, ASSIGN) ? [] : ['assign roles']),
  ];
  if (!lacks.length) return;
  const pim = 'If you have a role you can activate in Privileged Identity Management, activate it, wait a few minutes, then run the installer again.';
  if (rgExists) {
    throw new Error([
      `You can't install into resource group ${az.resourceGroup}: you can't ${inWords(lacks)} there.`,
      'Any one of these is enough, on the resource group or its subscription:',
      '  - Owner',
      '  - Contributor and User Access Administrator',
      `  - Least privilege, on just this resource group: Contributor, and Role Based Access Control Administrator limited to the roles the installer assigns. Your Azure admin can set it up with ${LEAST_PRIVILEGE_DOC}.`,
      pim,
    ].join('\n'));
  }
  throw new Error([
    `You can't create resource group ${az.resourceGroup} and install into it: you can't ${inWords(lacks)} in subscription ${az.subscriptionName ?? az.subscriptionId}.`,
    'Ask for Owner, or Contributor and User Access Administrator, on the subscription.',
    `Or, for least privilege, ask your Azure admin to create the resource group and give you access to just that group (${LEAST_PRIVILEGE_DOC}). Then run the installer again and pick it as an existing resource group.`,
    pim,
  ].join('\n'));
}

/**
 * Roles the install's managed identity needs outside its resource group, where a least-privilege
 * installer can't give them: Azure AI and pay-as-you-go costs, and Reader for Resource Graph. Only
 * those still to give, and only when the jobs read tenant data.
 * @param {import('../../config.js').InstallConfig} config
 * @param {string} tenantId
 * @returns {AdminGrant[]}
 */
export function adminGrants(config, tenantId) {
  if (config.azure?.sampleData === true) return [];
  /** @type {AdminGrant[]} */
  const grants = [];
  const cc = config.consumption;
  if (config.modules.consumption && config.dataSources.azureAi === 'api' && cc.azureSubscriptionId) {
    const where = `subscription ${cc.azureSubscriptionName ?? cc.azureSubscriptionId}`;
    if (!cc.azureAccess) for (const r of AZURE_AI_ROLES) grants.push({ scope: `/subscriptions/${cc.azureSubscriptionId}`, where, role: r.name, why: 'Azure AI costs and metrics' });
    for (const p of cc.paygSubscriptions ?? []) {
      if (!p.access) grants.push({ scope: `/subscriptions/${p.subscriptionId}`, where: `subscription ${p.name ?? p.subscriptionId}`, role: 'Cost Management Reader', why: 'Copilot pay-as-you-go costs' });
    }
  }
  const rg = normaliseResourceGraph(config.resourceGraph);
  if (resourceGraphOn(config) && rg.foundry && !rg.azureAccess) grants.push({ scope: resourceGraphScope(config, tenantId), where: scopeName(config), role: 'Reader', why: 'Foundry, from Resource Graph' });
  return grants;
}

/**
 * Whether you can assign roles at a scope: null when it can't be read.
 * @param {import('../../install.js').Apis} api @param {string} scope
 */
async function canAssign(api, scope) {
  try {
    return allowsAction(await api.arm.permissions(scope), ASSIGN);
  } catch {
    return null;
  }
}

/**
 * For your Azure admin: the roles outside the resource group you can't give, as commands. The install
 * still finishes without them, and leaves those sources out until they're there.
 * @param {Ctx} ctx
 */
export async function printAdminGrants(ctx) {
  const { ui, api, config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const grants = adminGrants(config, ctx.user?.tenantId ?? '');
  if (!grants.length) return;
  /** @type {Map<string, boolean | null>} */
  const can = new Map();
  for (const scope of new Set(grants.map((g) => g.scope))) can.set(scope, await canAssign(api, scope));
  const needed = grants.filter((g) => can.get(g.scope) !== true);
  if (!needed.length) return;
  const unchecked = needed.some((g) => can.get(g.scope) === null);
  ui.warn(`For your Azure admin: the install's managed identity needs these roles outside resource group ${az.resourceGroup}, and you can't give them${unchecked ? ' (or the installer couldn\'t check)' : ''}:`);
  /** @type {Map<string, AdminGrant[]>} */
  const byScope = new Map();
  for (const g of needed) byScope.set(g.scope, [...(byScope.get(g.scope) ?? []), g]);
  for (const list of byScope.values()) ui.info(`${list.map((g) => g.role).join(', ')} on ${list[0].where}: ${list[0].why}`);
  const principal = az.outputs?.identityPrincipalId;
  ui.info('An Owner or User Access Administrator on each can run:');
  if (!principal) {
    ui.info('# The managed identity exists once the install has deployed. Its principal ID:');
    ui.info(`az identity list --subscription ${az.subscriptionId} --resource-group ${az.resourceGroup} --query "[?starts_with(name, 'id-${az.namePrefix ?? 'vlens'}-collector-')].principalId" -o tsv`);
  }
  for (const g of needed) ui.info(`az role assignment create --assignee-object-id ${principal ?? '<managed identity principal ID>'} --assignee-principal-type ServicePrincipal --role "${g.role}" --scope ${g.scope}`);
  ui.note(`The install finishes without them and leaves those sources out until they're there. When the installer asks, leave them out for now; once they're there, run it again and say they are. See ${LEAST_PRIVILEGE_DOC}.`);
}
