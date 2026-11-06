// @ts-check
/** Ask on Azure: the Azure OpenAI model the web app's /api/ask answers questions with. */
import { ROLES } from '../../clients/azure.js';
import { HttpError } from '../../http.js';
import { asksAdvanced } from '../advanced.js';

/** @typedef {import('../../install.js').Ctx} Ctx */
/** @typedef {import('../../config.js').AzureAskConfig} AzureAskConfig */

/** The model Ask deploys by default: small, cheap, and good at tool calling. */
export const ASK_MODEL = { name: 'gpt-5-mini', version: '2025-08-07', sku: 'GlobalStandard', capacity: 50 };
/** Below this many thousand tokens a minute, a few people asking at once would hit the limit. */
export const ASK_MIN_CAPACITY = 10;
/** Regions to try, in order, when the install region doesn't offer the model. Global deployments run prompts anywhere anyway. */
export const ASK_FALLBACK_REGIONS = ['swedencentral', 'eastus2', 'eastus', 'westus3', 'francecentral', 'germanywestcentral', 'uksouth', 'australiaeast', 'japaneast'];
export const ASK_SKUS = /** @type {const} */ ({
  GlobalStandard: 'Global: Azure may run prompts in any region',
  DataZoneStandard: 'Data zone: prompts stay in the EU or US data zone of the account\'s region',
});
const param = (/** @type {any} */ value) => ({ value });

/** @param {import('../../config.js').AzureConfig | undefined} az */
export const askMode = (az) => az?.ask?.mode ?? 'off';

/**
 * Whether `location` can host the Ask model with enough free quota.
 * @param {Ctx} ctx @param {string} location @param {string} sku
 * @returns {Promise<{ ok: true, capacity: number, unchecked?: boolean } | { ok: false, reason: string }>}
 */
export async function askModelIn(ctx, location, sku) {
  const { api, config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const sub = /** @type {string} */ (az.subscriptionId);
  const { name, version, capacity } = ASK_MODEL;
  let models;
  try {
    models = await api.arm.listAiModels(sub, location);
  } catch {
    return { ok: true, capacity, unchecked: true };
  }
  const offered = models.some((m) => /^AIServices$/i.test(String(m.kind)) && m.model?.name === name && m.model?.version === version && (m.model?.skus ?? []).some((/** @type {any} */ s) => s.name === sku));
  if (!offered) return { ok: false, reason: `${name} ${version} isn't offered as ${sku} in ${location}` };
  const usages = await api.arm.listAiUsages(sub, location).catch(() => []);
  const usage = usages.find((u) => u.name?.value === `OpenAI.${sku}.${name}`);
  if (!usage) return { ok: true, capacity };
  // On a re-run our own deployment already counts against the quota.
  const ours = az.outputs?.askAccountName && az.ask?.location === location && az.ask?.sku === sku ? (az.ask?.capacity ?? 0) : 0;
  const free = Number(usage.limit ?? 0) - Number(usage.currentValue ?? 0) + ours;
  if (free < ASK_MIN_CAPACITY) return { ok: false, reason: `only ${Math.max(free, 0)}K tokens a minute of ${name} ${sku} quota is free in ${location}` };
  return { ok: true, capacity: Math.min(capacity, free) };
}

/**
 * Plans Ask: create a model in this resource group (the default), use an existing deployment, or leave it off.
 * @param {Ctx} ctx
 */
export async function planAzureAsk(ctx) {
  const { ui, config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const prev = az.ask;
  const advanced = asksAdvanced(ctx);
  /** @type {AzureAskConfig['mode']} */
  let mode = prev?.mode ?? 'create';
  if (advanced) {
    ui.heading('Ask');
    mode = await ui.select('Ask answers questions about the dashboard in plain English, from your data and as the person asking. Which model should it use?', [
      { name: 'Create one for Ask', value: 'create', description: `An Azure AI Services account with ${ASK_MODEL.name}, in this resource group. Billed per token; light use costs a few dollars a month. Only the web app can call it.` },
      { name: 'Use an Azure OpenAI deployment you already have', value: 'existing', description: 'Pick one in this subscription or enter its endpoint. The web app\'s managed identity gets Cognitive Services OpenAI User on it.' },
      { name: 'Leave Ask off', value: 'off', description: 'The Ask page still shows suggested questions, without answers.' },
    ], mode);
  }
  if (mode === 'existing') return pickExistingAsk(ctx, prev);
  if (mode === 'off') {
    if (prev?.mode === 'create' && az.outputs?.askAccountName) ui.note(`Ask is off. The AI Services account ${az.outputs.askAccountName} stays; delete it in the Azure portal if you don't need it.`);
    az.ask = { mode: 'off' };
    return;
  }
  const sku = advanced
    ? await ui.select('Where may Azure process Ask\'s prompts?', Object.entries(ASK_SKUS).map(([value, name]) => ({ name, value })), prev?.sku ?? ASK_MODEL.sku)
    : prev?.sku ?? ASK_MODEL.sku;
  const home = prev?.location ?? /** @type {string} */ (az.location);
  let check = await askModelIn(ctx, home, sku);
  let location = home;
  // A data zone deployment has to stay in its zone, so only global ones move region.
  if (!check.ok && sku === 'GlobalStandard') {
    for (const region of ASK_FALLBACK_REGIONS.filter((r) => r !== home)) {
      const next = await askModelIn(ctx, region, sku);
      if (next.ok) {
        ui.note(`${check.reason}, so the Ask model's account goes in ${region}. It's a global deployment, so prompts may run in any region either way.`);
        check = next;
        location = region;
        break;
      }
    }
  }
  if (!check.ok) {
    ui.warn(`Ask is left off: ${check.reason}. Free some quota or pick another region, or point Ask at an existing deployment, then run the installer again with advanced options.`);
    az.ask = { mode: 'off' };
    return;
  }
  if (check.unchecked) ui.note(`Couldn't check ${ASK_MODEL.name} availability and quota in ${location}; the deployment will tell.`);
  az.ask = { mode: 'create', location, sku, capacity: check.capacity, deployment: prev?.mode === 'create' && prev.deployment ? prev.deployment : ASK_MODEL.name };
}

/**
 * An existing Azure OpenAI or AI Services deployment, picked from this subscription or entered by endpoint.
 * @param {Ctx} ctx @param {AzureAskConfig | undefined} prev
 */
async function pickExistingAsk(ctx, prev) {
  const { ui, api, config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const accounts = (await api.arm.listAiAccounts(/** @type {string} */ (az.subscriptionId)).catch(() => [])).filter((a) => /^(OpenAI|AIServices)$/i.test(String(a.kind)));
  const accountId = await ui.select('Which Azure OpenAI or AI Services account?', [
    ...accounts.map((a) => ({ name: `${a.name} (${a.location})`, value: String(a.id) })),
    { name: 'Another subscription: enter its endpoint', value: '' },
  ], accounts.some((a) => a.id === prev?.accountId) ? prev?.accountId : (accounts[0]?.id ?? ''));
  const account = accounts.find((a) => a.id === accountId);
  let endpoint = account?.properties?.endpoint ?? '';
  if (!account) {
    endpoint = await ui.input('Azure OpenAI endpoint', {
      default: prev?.endpoint ?? '',
      validate: (v) => (/^https:\/\/[a-z0-9.-]+(\/.*)?$/i.test(v.trim()) ? true : 'Use the https:// endpoint from the account\'s Keys and Endpoint page.'),
    });
  }
  const deployments = account ? await api.arm.listAiDeployments(account.id).catch(() => []) : [];
  const deployment = deployments.length
    ? await ui.select('Which model deployment? Pick a chat model that supports tool calling.', deployments.map((d) => ({ name: `${d.name} (${[d.properties?.model?.name, d.properties?.model?.version].filter(Boolean).join(' ') || 'model'})`, value: String(d.name) })), deployments.some((d) => d.name === prev?.deployment) ? prev?.deployment : deployments[0].name)
    : await ui.input('Model deployment name', { default: prev?.deployment ?? '', validate: (v) => (v.trim() ? true : 'Required') });
  az.ask = {
    mode: 'existing',
    endpoint: endpoint.trim(),
    deployment: deployment.trim(),
    ...(account ? { accountId: String(account.id) } : {}),
    ...(prev?.mode === 'existing' && prev.accountId && prev.accountId === account?.id && prev.granted ? { granted: true } : {}),
  };
}

/**
 * The ARM parameters for Ask.
 * @param {import('../../config.js').InstallConfig} config
 */
export function askParameters(config) {
  const ask = config.azure?.ask;
  const mode = askMode(config.azure);
  return {
    askMode: param(mode),
    askEndpoint: param(mode === 'existing' ? ask?.endpoint ?? '' : ''),
    askDeployment: param(mode === 'off' ? '' : ask?.deployment ?? ''),
    askModelName: param(ASK_MODEL.name),
    askModelVersion: param(ASK_MODEL.version),
    askSku: param(ask?.sku ?? ASK_MODEL.sku),
    askCapacity: param(ask?.capacity ?? ASK_MODEL.capacity),
    askLocation: param(mode === 'create' ? ask?.location ?? '' : ''),
  };
}

/** The role assignment that lets the web app call an existing deployment, as a command. @param {string} principalId @param {string} scope */
export const askRoleCommand = (principalId, scope) =>
  `az role assignment create --role "Cognitive Services OpenAI User" --assignee-object-id ${principalId} --assignee-principal-type ServicePrincipal --scope ${scope}`;

/**
 * An existing deployment: gives the web app's managed identity Cognitive Services OpenAI User on its
 * account. Never stops the install; without the role, Ask says it isn't set up yet.
 * @param {Ctx} ctx
 */
export async function ensureAzureAskAccess(ctx) {
  const { ui, api, config } = ctx;
  const az = /** @type {import('../../config.js').AzureConfig} */ (config.azure);
  const ask = az.ask;
  const principalId = az.outputs?.identityPrincipalId;
  if (ask?.mode !== 'existing' || !principalId) return;
  if (!ask.accountId) {
    ui.warn(`Give the web app's managed identity Cognitive Services OpenAI User on the account behind ${ask.endpoint}, or Ask can't answer: ${askRoleCommand(principalId, '<account resource ID>')}`);
    return;
  }
  if (ask.granted) {
    ui.ok('The web app can call the Ask model');
    return;
  }
  try {
    await api.arm.assignRole(ask.accountId, ROLES.cognitiveServicesOpenAiUser, principalId, 'ServicePrincipal');
    ask.granted = true;
    ui.ok(`Gave the web app Cognitive Services OpenAI User on ${ask.accountId.split('/').pop()}`);
  } catch (err) {
    if (!(err instanceof HttpError) || ![401, 403].includes(err.status)) throw err;
    ui.warn(`You can't assign roles on ${ask.accountId.split('/').pop()}. Ask an owner to run: ${askRoleCommand(principalId, ask.accountId)}`);
  }
  ctx.save();
}

/** One line for the confirm screen and the summary. @param {import('../../config.js').AzureConfig | undefined} az */
export function askLine(az) {
  const ask = az?.ask;
  if (askMode(az) === 'create') return `${ASK_MODEL.name} (${ask?.sku ?? ASK_MODEL.sku}, ${ask?.capacity ?? ASK_MODEL.capacity}K tokens/min) in ${ask?.location ?? az?.location}${az?.outputs?.askAccountName ? `, account ${az.outputs.askAccountName}` : ''}`;
  if (askMode(az) === 'existing') return `${ask?.deployment} at ${ask?.endpoint}${ask?.accountId && !ask.granted ? ' (needs Cognitive Services OpenAI User for the web app)' : ''}`;
  return 'Off (the Ask page lists suggested questions only)';
}

/**
 * Plan review grants for Ask. What-if lists the account it creates.
 * @param {import('../../config.js').AzureConfig} az
 * @returns {{ who: string, what: string, where: string, detail?: string }[]}
 */
export function askGrants(az) {
  const ask = az.ask;
  if (askMode(az) === 'create') return [{ who: 'Web app managed identity', what: 'Cognitive Services OpenAI User', where: 'The Ask AI Services account', detail: 'Keys are off, so only the web app can call the model. The data comes from Power BI as the person asking.' }];
  if (askMode(az) === 'existing') return [{ who: 'Web app managed identity', what: 'Cognitive Services OpenAI User', where: ask?.accountId?.split('/').pop() ?? ask?.endpoint ?? 'Your Azure OpenAI account', detail: ask?.accountId ? 'The installer assigns it if you can; otherwise it prints the command.' : 'Assign it yourself; the installer prints the command.' }];
  return [];
}
