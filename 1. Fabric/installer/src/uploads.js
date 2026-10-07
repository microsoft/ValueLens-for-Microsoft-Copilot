// @ts-check
/**
 * The data sources Analytics Hub reads, how each one arrives (an API, a CSV the admin exports, or
 * not at all), and how an uploaded CSV is recognised from its headers. The upload router notebook
 * gets the same signatures, so the installer and the scheduled pipeline always agree.
 */

/** The one drop folder. The installer, the email flow, OneLake File Explorer and Fabric uploads all write here. */
export const UPLOAD_DIR = 'Files/analytics_hub_uploads';
/** Where an optional OneLake shortcut to a SharePoint "Analytics Hub uploads" folder goes. Read-only: files there are never moved. */
export const SHAREPOINT_SUBDIR = `${UPLOAD_DIR}/sharepoint`;
export const UPLOAD_LOG_TABLE = 'dbo.analytics_hub_upload_log';
export const FEEDBACK_DIR = 'Files/product_feedback';
export const AGENT365_DIR = 'Files/agent365';
export const WORKDAY_DIR = 'Files/org_workday';
/** Folders the router writes to, made by the installer so a first run never trips over a missing one. */
export const UPLOAD_FOLDERS = [UPLOAD_DIR, FEEDBACK_DIR, AGENT365_DIR, WORKDAY_DIR];
/** Largest file the installer uploads. Bigger exports go through OneLake File Explorer or the Lakehouse. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** @typedef {'api' | 'csv' | 'skip'} SourceMode */
/** @typedef {'core' | 'orgData' | 'workday' | 'm365Activity' | 'agent365' | 'productFeedback' | 'studioCredits' | 'coworkCredits' | 'azureAi' | 'agentEvaluator'} DataSourceId */
/** @typedef {Record<DataSourceId, SourceMode>} DataSourceModes */

/**
 * @typedef {object} DataSourceInfo
 * @property {DataSourceId} id
 * @property {string} label
 * @property {string} description
 * @property {SourceMode[]} modes  In order of preference: the API first when there is one.
 * @property {SourceMode} defaultMode
 * @property {boolean} [locked]  The dashboard is built on it, so it can't be skipped.
 * @property {{ where: string, url: string, files: string }} [export]  Where the admin downloads the CSV.
 * @property {string} [page]  The dashboard page that stays dormant when it is skipped.
 * @property {Partial<Record<SourceMode, string>>} [modeLabels]  Overrides MODE_LABELS, e.g. "Connected (Dataflow)".
 * @property {Partial<Record<SourceMode, string>>} [hints]  What the mode does, shown under the card.
 */

/** @type {DataSourceInfo[]} */
export const DATA_SOURCES = [
  {
    id: 'core',
    label: 'Copilot usage and licences',
    description: 'The Microsoft 365 audit log and your Copilot licences. The dashboard is built on it.',
    modes: ['api'],
    defaultMode: 'api',
    locked: true,
  },
  {
    id: 'orgData',
    label: 'Org data (Microsoft Entra ID)',
    description: 'Department, job title, manager and location for each person.',
    modes: ['api'],
    defaultMode: 'api',
    locked: true,
  },
  {
    id: 'workday',
    label: 'Workday org data',
    description: 'Adds or overrides org fields from a Workday report, matched on Primary Work Email.',
    modes: ['csv', 'skip'],
    defaultMode: 'skip',
    export: {
      where: 'Workday: run a report of active workers that includes Primary Work Email and the fields you want (cost centre, level, location), then export it to CSV.',
      url: 'https://doc.workday.com/',
      files: 'One CSV. Each upload replaces the last.',
    },
  },
  {
    id: 'm365Activity',
    label: 'Microsoft 365 activity',
    description: 'Teams, Outlook, SharePoint, OneDrive, Viva Engage and Office app usage reports.',
    modes: ['api', 'skip'],
    defaultMode: 'api',
    page: 'M365 activity',
  },
  {
    id: 'agent365',
    label: 'Agent 365 registry',
    description: 'The agents in your tenant and who made them. The API needs an Agent 365 licence; the export doesn\'t.',
    modes: ['api', 'csv', 'skip'],
    defaultMode: 'skip',
    page: 'Agents',
    export: {
      where: 'Microsoft 365 admin center > Agents > All agents > Export.',
      url: 'https://admin.microsoft.com/',
      files: 'One CSV. Each upload replaces the last.',
    },
  },
  {
    id: 'productFeedback',
    label: 'Product feedback',
    description: 'What people say about Copilot. There is no API for it.',
    modes: ['csv', 'skip'],
    defaultMode: 'skip',
    page: 'User Feedback',
    export: {
      where: 'Microsoft 365 admin center > Health > Product feedback > Export.',
      url: 'https://admin.microsoft.com/',
      files: 'One CSV per export. Uploads add up; duplicates are removed by Feedback Id.',
    },
  },
  {
    id: 'studioCredits',
    label: 'Copilot Studio credits',
    description: 'Copilot Studio credits by environment, agent and user. A Power Automate flow can keep the environment and agent figures up to date.',
    modes: ['csv', 'skip'],
    defaultMode: 'skip',
    page: 'Consumption Central',
    hints: { csv: 'Upload the exports, and optionally let a daily Power Automate flow read the Power Platform licensing API for you. Per-user figures are export only.' },
    export: {
      where: 'Power Platform admin center > Licensing > Products > Copilot Studio. Download the Summary, Environments and Agents exports (EntitlementConsumption*_MCSMessages*.csv).',
      url: 'https://admin.powerplatform.microsoft.com/',
      files: 'Up to three CSVs a month. A new file replaces the last one of the same kind.',
    },
  },
  {
    id: 'coworkCredits',
    label: 'Copilot Cowork credits',
    description: 'Cowork credits by person, from Viva Insights.',
    modes: ['api', 'csv', 'skip'],
    defaultMode: 'skip',
    page: 'Consumption Central',
    modeLabels: { api: 'Connected (Dataflow)' },
    hints: {
      api: 'The installer creates a Dataflow Gen2 that reads your Viva Insights Copilot consumption query on every run. You give the partition and query IDs, then sign in to the Dataflow once.',
    },
    export: {
      where: 'Viva Insights > Copilot Consumption Dashboard > Export (PersonServiceCreditsMetrics and SpendingPolicyMetadata CSVs).',
      url: 'https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric',
      files: 'Credits add up and are de-duplicated; a new policy file replaces the last.',
    },
  },
  {
    id: 'azureAi',
    label: 'Azure AI costs',
    description: 'Azure OpenAI and AI Foundry costs, and Copilot pay-as-you-go billed to Azure.',
    modes: ['api', 'skip'],
    defaultMode: 'skip',
    page: 'Consumption Central',
  },
  {
    id: 'agentEvaluator',
    label: 'Agent Evaluator',
    description: 'Copilot Studio conversation transcripts from Dataverse: how conversations end and where agents fall short.',
    modes: ['api', 'skip'],
    defaultMode: 'skip',
    page: 'Agent Evaluator',
  },
];

export const DATA_SOURCE_IDS = /** @type {DataSourceId[]} */ (DATA_SOURCES.map((s) => s.id));
export const MODE_LABELS = /** @type {Record<SourceMode, string>} */ ({ api: 'Connected (API)', csv: 'Upload CSV', skip: 'Skip' });

/** @param {DataSourceId} id */
export const dataSource = (id) => /** @type {DataSourceInfo} */ (DATA_SOURCES.find((s) => s.id === id));

/**
 * What a mode is called on this source's card.
 * @param {DataSourceInfo | DataSourceId} source
 * @param {SourceMode} mode
 */
export function modeLabel(source, mode) {
  const s = typeof source === 'string' ? dataSource(source) : source;
  return s?.modeLabels?.[mode] ?? MODE_LABELS[mode];
}

/**
 * How a recognised file is stored for its ingester.
 *  - append: kept alongside earlier uploads (the ingester unions and de-duplicates them)
 *  - replace: overwrites the one file the ingester reads
 *  - replaceKind: earlier files of the same kind are moved to `_loaded/` first
 * @typedef {'append' | 'replace' | 'replaceKind'} UploadPolicy
 */

/**
 * @typedef {object} UploadKind
 * @property {string} kind
 * @property {DataSourceId} source
 * @property {string[][]} groups  Each group is a set of normalised header names; one from every group must be present.
 * @property {string} dir  Where the router puts it.
 * @property {string} name  File name. `{stamp}` becomes the upload time.
 * @property {UploadPolicy} policy
 */

/** @type {UploadKind[]} */
export const UPLOAD_KINDS = [
  {
    kind: 'productFeedback',
    source: 'productFeedback',
    groups: [['feedbackid'], ['datesubmittedutc'], ['feedbacktype']],
    dir: FEEDBACK_DIR,
    name: 'feedback_{stamp}.csv',
    policy: 'append',
  },
  {
    kind: 'agent365',
    source: 'agent365',
    groups: [
      ['agentname', 'name', 'displayname'],
      ['titleid', 'packageid', 'agentcreatorid', 'creatorid', 'agenttypea365', 'publishertype', 'supportedin', 'availability'],
    ],
    dir: AGENT365_DIR,
    name: 'agents.csv',
    policy: 'replace',
  },
  {
    kind: 'studioTenant',
    source: 'studioCredits',
    groups: [['billingplanid'], ['environmentid'], ['capacitytype'], ['prepaidconsumedquantity'], ['usagedate']],
    dir: 'Files/landing/studio',
    name: 'EntitlementConsumptionTenantDetailsReport_MCSMessages_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'studioAgent',
    source: 'studioCredits',
    groups: [['agentid'], ['agentname'], ['billedcredit'], ['nonbilledcredit'], ['channel']],
    dir: 'Files/landing/studio',
    name: 'EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'studioUser',
    source: 'studioCredits',
    groups: [['userid'], ['useremail'], ['creditsused'], ['billablecreditused']],
    dir: 'Files/landing/studio',
    name: 'EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages_{stamp}.csv',
    policy: 'replaceKind',
  },
  // Written each day by the Analytics Hub Copilot Studio credits flow from the licensing API. Each
  // file restates the last ten days, so only the newest is kept; the notebook merges by day.
  {
    kind: 'studioAgentDaily',
    source: 'studioCredits',
    groups: [['usagedate'], ['agentid'], ['agentname'], ['billedcredit'], ['nonbilledcredit'], ['channel']],
    dir: 'Files/landing/studio',
    name: 'StudioApiAgentDaily_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'studioEntitlement',
    source: 'studioCredits',
    groups: [['snapshotdate'], ['environmentid'], ['environmentallocated'], ['tenantprepaidconsumed'], ['tenantpaygconsumed']],
    dir: 'Files/landing/studio',
    name: 'StudioApiEntitlement_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'vivaCredits',
    source: 'coworkCredits',
    groups: [['serviceid'], ['servicename'], ['spendingpolicyid'], ['metricdate'], ['totalcopilotcreditsused']],
    dir: 'Files/landing/viva',
    name: 'PersonServiceCreditsMetrics_{stamp}.csv',
    policy: 'append',
  },
  {
    kind: 'vivaPolicy',
    source: 'coworkCredits',
    groups: [['spendingpolicyid'], ['name'], ['planlimit'], ['userlimit'], ['includedservices']],
    dir: 'Files/landing/viva',
    name: 'SpendingPolicyMetadata_{stamp}.csv',
    policy: 'replaceKind',
  },
  {
    kind: 'workday',
    source: 'workday',
    groups: [['primaryworkemail']],
    dir: WORKDAY_DIR,
    name: 'workday.csv',
    policy: 'replace',
  },
];

/** Sources a CSV can be uploaded for. */
export const UPLOADABLE_SOURCES = /** @type {DataSourceId[]} */ ([...new Set(UPLOAD_KINDS.map((k) => k.source))]);

/**
 * Header name as the router compares it: lower case, letters and digits only.
 * @param {string} name
 */
export const normHeader = (name) => String(name).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The first record of a CSV: quoted fields, embedded commas and quotes, a BOM and CRLF all handled.
 * @param {string} text
 * @returns {string[]}
 */
export function parseCsvHeader(text) {
  const s = text.replace(/^\uFEFF/, '');
  const end = s.search(/[\r\n]/);
  const line1 = end === -1 ? s : s.slice(0, end);
  const delimiter = [',', ';', '\t'].map((d) => [d, line1.split(d).length]).sort((a, b) => Number(b[1]) - Number(a[1]))[0][0];
  /** @type {string[]} */
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      fields.push(field.trim());
      field = '';
    } else if (ch === '\r' || ch === '\n') break;
    else field += ch;
  }
  fields.push(field.trim());
  return fields.length === 1 && fields[0] === '' ? [] : fields;
}

/**
 * Text of the start of a file, decoded from UTF-8 or, for some Excel saves, UTF-16.
 * @param {Uint8Array} bytes
 */
export function decodeStart(bytes) {
  const head = bytes.subarray(0, 64 * 1024);
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(head.subarray(2));
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(head.subarray(2));
  return new TextDecoder('utf-8').decode(head);
}

/**
 * @typedef {{ ok: true, kind: UploadKind, source: DataSourceId, headers: string[] }
 *   | { ok: false, reason: string, headers: string[] }} Detection
 */

/**
 * Which source a CSV is from, by its headers. The kind matching the most groups wins; a tie is ambiguous.
 * @param {string[]} headers
 * @param {Iterable<DataSourceId>} [enabled]  Sources being collected. Others are recognised but refused.
 * @returns {Detection}
 */
export function detectSource(headers, enabled) {
  const have = new Set(headers.map(normHeader));
  if (!have.size) return { ok: false, reason: 'The file has no header row.', headers };
  const scored = UPLOAD_KINDS
    .filter((k) => k.groups.every((g) => g.some((h) => have.has(h))))
    .map((k) => ({ k, score: k.groups.length }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { ok: false, reason: `It doesn't look like any export Analytics Hub reads. ${expectedHint()}`, headers };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { ok: false, reason: `It matches more than one export (${scored.filter((s) => s.score === scored[0].score).map((s) => s.k.kind).join(', ')}).`, headers };
  }
  const kind = scored[0].k;
  const on = enabled ? new Set(enabled) : undefined;
  if (on && !on.has(kind.source)) {
    return { ok: false, reason: `It's a ${dataSource(kind.source).label} export, but that source is set to Skip.`, headers };
  }
  return { ok: true, kind, source: kind.source, headers };
}

function expectedHint() {
  return 'Expected one of: product feedback, Agent 365 agents, Copilot Studio credits (including the Analytics Hub flow\'s files), Cowork credits or a Workday report.';
}

/**
 * Reads a CSV's header and recognises it.
 * @param {Uint8Array} bytes
 * @param {Iterable<DataSourceId>} [enabled]
 */
export function detectFile(bytes, enabled) {
  return detectSource(parseCsvHeader(decodeStart(bytes)), enabled);
}

/** @returns {DataSourceModes} */
export function defaultDataSources() {
  return /** @type {DataSourceModes} */ (Object.fromEntries(DATA_SOURCES.map((s) => [s.id, s.defaultMode])));
}

/**
 * Fills the gaps in a saved choice. A record from before the Data sources screen is read from its modules.
 * @param {Partial<Record<string, string>> | undefined} saved
 * @param {import('./catalog.js').ModuleChoice} modules
 * @param {{ azureSubscriptionId?: string }} [consumption]
 * @returns {DataSourceModes}
 */
export function normaliseDataSources(saved, modules, consumption = {}) {
  /** @type {Partial<DataSourceModes>} */
  const legacy = saved
    ? {}
    : {
        m365Activity: modules.m365Activity ? 'api' : 'skip',
        agent365: modules.agent365 ? 'api' : 'skip',
        productFeedback: modules.productFeedback ? 'csv' : 'skip',
        studioCredits: modules.consumption ? 'csv' : 'skip',
        coworkCredits: modules.consumption ? 'csv' : 'skip',
        azureAi: modules.consumption && consumption.azureSubscriptionId ? 'api' : 'skip',
        agentEvaluator: modules.agentEvaluator ? 'api' : 'skip',
      };
  const out = { ...defaultDataSources(), ...legacy };
  for (const s of DATA_SOURCES) {
    const v = /** @type {SourceMode | undefined} */ (saved?.[s.id]);
    if (v && s.modes.includes(v)) out[s.id] = v;
    if (s.locked) out[s.id] = s.modes[0];
  }
  return out;
}

/**
 * The modules the chosen sources switch on.
 * @param {DataSourceModes} ds
 * @returns {import('./catalog.js').ModuleChoice}
 */
export function modulesFromSources(ds) {
  const on = (/** @type {DataSourceId} */ id) => ds[id] !== 'skip';
  return {
    orgData: true,
    m365Activity: on('m365Activity'),
    agent365: on('agent365'),
    productFeedback: on('productFeedback'),
    consumption: on('studioCredits') || on('coworkCredits') || on('azureAi'),
    agentEvaluator: on('agentEvaluator'),
  };
}

/**
 * Sources the router accepts a CSV for: uploadable and not skipped. Agent 365 on the API still
 * accepts its export, which the CSV fallback reads when the registry can't be reached.
 * @param {DataSourceModes} ds
 * @returns {DataSourceId[]}
 */
export const routedSources = (ds) => UPLOADABLE_SOURCES.filter((id) => ds[id] !== 'skip');

/** The router is deployed when any source arrives as a CSV. */
export const routerWanted = (/** @type {DataSourceModes} */ ds) => routedSources(ds).length > 0;

/**
 * The signatures the router notebook reads, as one line of JSON.
 * @param {DataSourceModes} [ds]  When given, only the kinds of routed sources.
 */
export function routerSignaturesJson(ds) {
  const on = ds ? new Set(routedSources(ds)) : undefined;
  return JSON.stringify(
    UPLOAD_KINDS.filter((k) => !on || on.has(k.source)).map((k) => ({ kind: k.kind, source: k.source, groups: k.groups, dir: k.dir, name: k.name, policy: k.policy })),
  );
}

/**
 * @typedef {object} SourceCard  One card on the Data sources screen.
 * @property {DataSourceId} id
 * @property {string} label
 * @property {string} description
 * @property {{ value: SourceMode, label: string, hint?: string }[]} modes
 * @property {SourceMode} mode
 * @property {boolean} locked
 * @property {boolean} uploadable  A CSV can be uploaded for it.
 * @property {string} [page]
 * @property {{ where: string, url: string, files: string }} [export]
 */

/**
 * The Data sources screen's cards, each set to its current mode.
 * @param {DataSourceModes} ds
 * @returns {SourceCard[]}
 */
export function sourceCards(ds) {
  return DATA_SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    modes: s.modes.map((m) => ({ value: m, label: modeLabel(s, m), ...(s.hints?.[m] ? { hint: s.hints[m] } : {}) })),
    mode: s.modes.includes(ds[s.id]) ? ds[s.id] : s.defaultMode,
    locked: !!s.locked,
    uploadable: UPLOADABLE_SOURCES.includes(s.id),
    ...(s.page ? { page: s.page } : {}),
    ...(s.export ? { export: s.export } : {}),
  }));
}

/**
 * Checks the modes a Data sources answer gives: every source has one of its own, locked ones unchanged.
 * @param {unknown} raw
 * @param {DataSourceModes} current
 * @returns {{ modes: DataSourceModes } | { error: string }}
 */
export function parseModes(raw, current) {
  if (!raw || typeof raw !== 'object') return { error: 'Choose how each source arrives.' };
  const given = /** @type {Record<string, unknown>} */ (raw);
  const modes = /** @type {DataSourceModes} */ ({ ...current });
  for (const s of DATA_SOURCES) {
    const v = given[s.id];
    if (v === undefined) continue;
    if (s.locked && v !== current[s.id]) return { error: `${s.label} can't be changed.` };
    if (!s.modes.includes(/** @type {SourceMode} */ (v))) return { error: `${s.label} can be ${s.modes.map((m) => modeLabel(s, m)).join(' or ')}.` };
    modes[s.id] = /** @type {SourceMode} */ (v);
  }
  return { modes };
}

/**
 * One line per source for a summary: "Product feedback: Upload CSV".
 * @param {DataSourceModes} ds
 */
export const describeSources = (ds) => DATA_SOURCES.filter((s) => !s.locked).map((s) => `${s.label}: ${modeLabel(s, ds[s.id])}`);

/**
 * A name for an upload that won't collide with an earlier one: a UTC stamp, then the original
 * name with anything OneLake or Spark dislikes replaced.
 * @param {string} original
 * @param {Date} [now]
 */
export function uploadName(original, now = new Date()) {
  const base = original.split(/[\\/]/).pop() ?? 'upload.csv';
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'upload.csv';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}_${/\.csv$/i.test(clean) ? clean : `${clean}.csv`}`;
}

/**
 * Parses `--data` flags: `source=mode`, comma-separated or repeated.
 * @param {string[]} values
 * @returns {Partial<DataSourceModes>}
 */
export function parseDataFlags(values) {
  /** @type {Partial<DataSourceModes>} */
  const out = {};
  for (const part of values.flatMap((v) => v.split(','))) {
    const [rawId, rawMode] = part.split('=').map((x) => x?.trim());
    const s = DATA_SOURCES.find((d) => d.id.toLowerCase() === (rawId ?? '').toLowerCase());
    if (!s) throw new Error(`--data: unknown source "${rawId}". Use one of ${DATA_SOURCE_IDS.join(', ')}.`);
    const mode = /** @type {SourceMode} */ ((rawMode ?? '').toLowerCase());
    if (!s.modes.includes(mode)) throw new Error(`--data: ${s.id} can be ${s.modes.join(' or ')}, not "${rawMode ?? ''}".`);
    out[s.id] = mode;
  }
  return out;
}
