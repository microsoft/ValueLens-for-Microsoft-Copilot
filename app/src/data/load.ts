import Papa from 'papaparse'
import embeddedSample from 'virtual:embedded-sample'
import estimates from './estimates.json'
import type { AgentInfo, Dataset, Feedback, Lic, Person, Row, Thread, Tool } from './types'
import { FRONTIER, NOT_ATTRIBUTED, UNKNOWN_ORG, WORKHORSE } from './types'
import { checkCounts, type FileKind, type RowCounts } from './loadCheck'

type Rec = Record<string, string>

export function parseCsv(text: string): { headers: string[]; rows: Rec[] } {
  const res = Papa.parse<Rec>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })
  return { headers: res.meta.fields ?? [], rows: res.data }
}

const USER_KEYS = ['PersonId', 'User Principal Name', 'userPrincipalName', 'UserPrincipalName', 'UPN']
const LIC_KEYS = ['Has license', 'Has License', 'HasLicense', 'Has Copilot License', 'Has Copilot license', 'HasCopilotLicense']

export function detectKind(headers: string[]): FileKind | null {
  const h = new Set(headers)
  if (h.has('ThreadId') && (h.has('Audit_UserId') || h.has('Message_isPrompt'))) return 'interactions'
  if (h.has('Agent name')) return 'agents'
  if (h.has('Feedback Type') || h.has('Feedback Id')) return 'feedback'
  if (USER_KEYS.some((k) => h.has(k)) && (h.has('Organization') || LIC_KEYS.some((k) => h.has(k)))) return 'users'
  return null
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

export function toIsoDate(v: string | undefined): string {
  if (!v) return ''
  const s = v.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (us) return `${us[3]}-${pad(+us[1])}-${pad(+us[2])}`
  const t = Date.parse(s)
  return Number.isNaN(t) ? '' : iso(new Date(t))
}

export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow)
  return iso(d)
}

export const monthOf = (date: string) => `${date.slice(0, 7)}-01`
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)

const yes = (v: string | undefined) => ['YES', 'TRUE', 'Y', '1'].includes((v ?? '').trim().toUpperCase())
const low = (v: string | undefined) => (v ?? '').trim().toLowerCase()
const pick = (r: Rec, keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined) return r[k]
  return undefined
}

// ---------- Users (Chat + Agent Org Data / Copilot Licensed) ----------

export function buildPeople(recs: Rec[]): Map<string, Person> {
  const map = new Map<string, Person>()
  for (const r of recs) {
    const id = low(pick(r, USER_KEYS))
    if (!id || map.has(id)) continue
    map.set(id, {
      id,
      name: (r['displayName'] || r['DisplayName'] || id).trim(),
      org: (r['Organization'] ?? '').trim() || UNKNOWN_ORG,
      title: (r['JobTitle'] ?? '').trim(),
      country: (r['country'] ?? r['Country'] ?? '').trim(),
      hasLicense: yes(pick(r, LIC_KEYS)),
    })
  }
  return map
}

// ---------- Agents 365 registry ----------

const flag = (v: string | undefined) => ['yes', 'true', '1'].includes(low(v))
const evidence = (v: string | undefined) => ['yes', 'no', 'true', 'false', '1', '0'].includes(low(v))

function typeLabel(type: string, createdIn: string): string {
  const t = low(type)
  const c = low(createdIn)
  if (t === 'firstparty') return 'Microsoft'
  if (t === 'thirdparty') return 'Marketplace'
  if (t === 'lob') return 'Line of business'
  if (t === 'shared' && c.includes('agent builder')) return 'Maker: Agent Builder'
  if (t === 'shared' && c.includes('copilot studio')) return 'Maker: Copilot Studio'
  if (t === 'shared' && c.includes('sharepoint')) return 'Maker: SharePoint'
  if (t === 'shared' && c.includes('foundry')) return 'Maker: Foundry'
  if (t === 'shared') return 'Maker-built'
  if (t === '') return 'Not stated'
  return type
}

function features(r: Rec): string {
  const s = low(r['Supported in'])
  const platforms = [
    s.includes('copilot') && '🤖 in Copilot',
    s.includes('teams') && '💬 in Teams',
    s.includes('outlook') && '📧 in Outlook',
    s.includes('office') && '📄 in Office',
  ].filter(Boolean)
  const both = flag(r['Can read OneDrive and Sharepoint items'])
  const caps = [
    (flag(r['Can read Sharepoint sites and files']) || both) && '📁 SharePoint',
    (flag(r['Can read OneDrive files']) || both) && '☁️ OneDrive',
    flag(r['Can extend to Graph connector']) && '🔌 Graph',
    flag(r['Contains uploaded files']) && '📎 Files',
    flag(r['Can generate images using user prompt']) && '🎨 Images',
    flag(r['Can use code interpreter']) && '🧮 Code',
  ].filter(Boolean)
  const combined = [platforms.join(' '), caps.join(' ')].filter(Boolean).join(' | ')
  if (combined) return combined
  const cols = [
    'Can read OneDrive files',
    'Can read Sharepoint sites and files',
    'Can read OneDrive and Sharepoint items',
    'Can extend to Graph connector',
    'Contains uploaded files',
    'Can generate images using user prompt',
    'Can use code interpreter',
  ]
  return cols.some((c) => evidence(r[c])) ? 'No affirmative capability flags reported' : 'Unknown / insufficient capability evidence'
}

export function buildAgents(recs: Rec[]): AgentInfo[] {
  return recs
    .filter((r) => (r['Agent name'] ?? '').trim())
    .map((r) => {
      const type = (r['Agent type (A365)'] ?? '').trim()
      const createdIn = (r['Created in'] ?? '').trim()
      const publisher = (r['Publisher'] ?? '').trim()
      return {
        name: r['Agent name'].trim(),
        titleId: (r['Title ID'] ?? '').trim(),
        entraId: (r['Entra Agent ID'] ?? '').trim(),
        creator: publisher || (r['Agent creator'] ?? '').trim(),
        creatorSource: (r['Agent creator source'] ?? '').trim(),
        typeA365: type,
        typeLabel: typeLabel(type, createdIn),
        typeCombined: type === 'Shared' && createdIn.includes('Agent Builder') ? 'Agent Builder' : type,
        description: (r['Agent description'] ?? '').trim(),
        createdIn,
        supportedIn: (r['Supported in'] ?? '').trim(),
        lastUpdated: toIsoDate(r['Last updated']),
        status: (r['Status'] ?? '').trim(),
        blocked: ['true', 'yes', '1'].includes(low(r['Is Blocked'])),
        features: features(r),
        tenant: !['', 'not available'].includes(low(createdIn)),
        totalUsers: 'Total Users' in r ? Number((r['Total Users'] ?? '').replace(/,/g, '')) || 0 : null,
      }
    })
}

// ---------- Product feedback ----------

function meta(json: string, key: string): string {
  const needle = `"${key}":"`
  const i = json.indexOf(needle)
  if (i < 0) return ''
  const rest = json.slice(i + needle.length)
  const end = rest.indexOf('"')
  return end > 0 ? rest.slice(0, end) : ''
}

const FEEDBACK_RULES: [string, string[]][] = [
  ['🏖️ Leave & Time Off', ['leave', 'time off', 'vacation', '请假']],
  ['💚 Wellness & Benefits', ['wellness', 'wellbeing', 'benefits', 'health']],
  ['🔧 Troubleshooting', ['troubleshoot', 'diagnostic', 'not working', "won't turn on", 'cache', 'setup', 'freezing']],
  ['🎫 Support & Tickets', ['ticket', 'incident', 'support', 'contact']],
  ['📧 Outlook & Email', ['outlook', 'out of office', 'email']],
  ['💬 Teams & Remote Work', ['teams', 'remote', 'hybrid']],
  ['💻 Devices & Hardware', ['device', 'laptop', 'tablet', 'mobile', 'pc', 'camera', 'windows', 'provision']],
  ['📱 Apps & Productivity', ['excel', 'power platform', 'copilot', 'coda', 'onedrive', 'sharepoint']],
  ['📋 Projects & Search', ['project', 'updates', 'workspace']],
  ['✨ Prompt Crafting', ['prompt', 'generate']],
  ['🔒 Security & Access', ['security', 'password', 'mfa', 'permission', 'access denied', 'authentication', 'locked out']],
  ['📚 Training & Onboarding', ['training', 'onboarding', 'how do i', 'how to', 'tutorial', 'learn']],
  ['🎯 AI Accuracy', ['hallucin', 'incorrect', 'inaccurate', 'wrong answer', 'made up', 'fabricat', 'misleading']],
  ['⚡ Performance & Errors', ['slow', 'loading', 'timeout', 'lag', 'performance', 'error', 'crash']],
  ['🌐 Network & Connectivity', ['network', 'vpn', 'wifi', 'internet', 'connectivity', 'bandwidth']],
  ['📊 Data & Reporting', ['report', 'dashboard', 'analytics', 'power bi', 'chart', 'data']],
  ['🧪 Testing', ['test', 'dislike']],
]
export const FEEDBACK_EXCLUDED = ['🧪 Testing', '❓ Uncategorized']

export function feedbackCategory(prompt: string, comment: string): string {
  const p = prompt.toLowerCase()
  const c = comment.toLowerCase()
  const all = `${p} ${c}`
  for (const [cat, words] of FEEDBACK_RULES) if (words.some((w) => all.includes(w))) return cat
  if (!p && c.length <= 5) return '❓ Uncategorized'
  if (all.length <= 10) return '❓ Uncategorized'
  return '📝 General'
}

export function buildFeedback(recs: Rec[]): Feedback[] {
  return recs.map((r, i) => {
    let raw = (r['Additional Metadata'] ?? '').trim()
    if (raw.startsWith('"')) raw = raw.replace(/^"+|"+$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const ess = meta(raw, 'essAgentId')
    const aiName = raw.includes('aiAgents') ? meta(raw, 'Name') : ''
    const copilotType = meta(raw, 'copilotType')
    const agent = aiName || ess || (copilotType === 'custom' ? 'Custom Agent' : '')
    const app = (r['App'] ?? '').trim()
    const type = (r['Feedback Type'] ?? '').trim()
    const date = toIsoDate(r['Date Submitted UTC'] ?? r['Date Submitted Date'])
    const prompt = (r['AI Context Prompt'] ?? '').trim()
    const comment = (r['Comment'] ?? '').trim()
    return {
      id: (r['Feedback Id'] ?? '').trim() || String(i),
      comment,
      date,
      month: date ? monthOf(date) : '',
      type,
      emoji: type === 'Thumbs Up' ? '👍' : type === 'Thumbs Down' ? '👎' : type === 'Smile' ? '😊' : type,
      app,
      surface: agent || app || 'Unknown',
      category: feedbackCategory(prompt, comment),
      prompt,
    }
  })
}

// ---------- Interaction enrichment (the PBI calculated columns) ----------

const MATERIAL = new Set(
  'docx doc xlsx xlsm xls csv pptx ppt pdf txt md html htm json xml py zip png jpg jpeg gif mp4 loop aspx sitepagemodern onepart page eml msg emailmessage teamsmessage event file external report'.split(' '),
)
const has = (s: string, parts: string[]) => parts.some((p) => s.includes(p))
const hasKey = (k: string, parts: string[]) => parts.some((p) => k.includes(`|${p}|`))

function surfaces(blob: string): string[] {
  const k = `|${blob}|`
  const out: string[] = []
  if (has(blob, ['spreadsheetml', 'ms-excel', 'text/csv']) || hasKey(k, ['xlsx', 'xlsm', 'xls', 'csv'])) out.push('Excel')
  if (has(blob, ['wordprocessingml', 'msword']) || hasKey(k, ['docx', 'doc'])) out.push('Word')
  if (has(blob, ['presentationml', 'ms-powerpoint']) || hasKey(k, ['pptx', 'ppt'])) out.push('PowerPoint')
  if (has(blob, ['rfc822', 'ms-outlook']) || hasKey(k, ['emailmessage', 'eml', 'msg', 'event'])) out.push('Outlook')
  if (blob.includes('application/pdf') || k.includes('|pdf|')) out.push('PDF')
  if (k.includes('|teamsmessage|')) out.push('Teams')
  return out
}

function buildArtifact(blob: string): boolean {
  const k = `|${blob}|`
  return (
    has(blob, ['application/zip', 'application/gzip', 'octet-stream', 'text/html', 'application/json', 'application/xml']) ||
    hasKey(k, ['zip', 'gz', 'html', 'htm', 'json', 'xml', 'py', 'ps1', 'js', 'ts', 'ipynb', 'sh'])
  )
}

function tierSort(model: string): number {
  if (!model || model.includes('no model logged')) return 8
  if (model.includes('OPUS') || model.includes('GPT-6')) return 0
  if (model.includes('SONNET') || model.includes('Claude') || model.includes('GPT-5') || model.includes('GPT-4')) return 1
  return 9
}
const tierName = (s: number) => (s === 0 ? FRONTIER : s === 1 ? WORKHORSE : s === 8 ? NOT_ATTRIBUTED : 'Unclassified')

function coworkCategory(t: string): string {
  if (has(t, ['rfc822', 'ms-outlook'])) return 'Email workflows'
  if (has(t, ['spreadsheetml', 'text/csv', 'application/json', 'application/xml', 'application/pdf', 'application/zip', 'application/gzip']))
    return 'Analysis & Research'
  if (has(t, ['wordprocessingml', 'presentationml', 'ms-powerpoint', 'text/markdown', 'text/html', 'image/'])) return 'Document & content creation'
  if (t.includes('message')) return 'Communication workflows'
  return 'General assistance / Other'
}

function coworkEngagement(t: string): string {
  if (t.includes('text/markdown')) return '4 - Producing'
  if (has(t, ['officedocument', 'application/', 'image/', 'text/csv', 'text/html', 'text/plain', 'rfc822', 'ms-outlook', 'ms-powerpoint'])) return '3 - Consuming'
  if (t.includes('message')) return '2 - Finding'
  return '1 - Asking'
}

const COWORK_GROUP: Record<string, string> = {
  'Email workflows': 'Email',
  'Analysis & Research': 'Data & Analysis',
  'Document & content creation': 'Document Creation',
  'Communication workflows': 'Collaboration & Workflows',
}

const ACTIVE_ACTIONS = ['send', 'draft', 'create', 'post', 'invoke', 'write', 'patch', 'execute']
function coworkRole(type: string, action: string): string {
  const t = type.trim().toLowerCase()
  const a = action.trim().toLowerCase()
  const active = ACTIVE_ACTIONS.some((x) => a.includes(x))
  if (['message/rfc822', 'application/vnd.ms-outlook'].includes(t)) return active ? 'Communications Specialist' : 'Executive Assistant'
  if (t === 'message') return 'Collaboration Lead'
  if (
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'text/csv',
    ].includes(t)
  )
    return 'Spreadsheet Specialist'
  if (t === 'application/pdf') return 'Researcher'
  if (['application/json', 'application/xml', 'text/xml', 'text/html', 'text/plain'].includes(t)) return 'Software Engineer'
  if (['image/png', 'image/jpeg', 'image/gif'].includes(t)) return 'Visual Designer'
  if (['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/rtf'].includes(t))
    return !active && a === 'read' ? 'Knowledge Navigator' : 'Content Writer'
  if (['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'].includes(t))
    return !active && a === 'read' ? 'Knowledge Navigator' : 'Presentation Designer'
  return ''
}

const HTE_CATEGORY = new Map(estimates.map((e) => [e.behavior, e.category]))

/** Fit Rule Step (tables: Fit Rule Step). mode 0 = Strict, 1 = Balanced, 2 = Lenient. */
function fitStep(t: Thread, reads: number, mode: 0 | 1 | 2): number {
  const strict = mode === 0
  const lenient = mode === 2
  const { m, b, surf, build, band } = t
  if (surf >= 2) return 1
  if (build) return 2
  if ((m >= 3 && b >= 2) || m > 5) return 3
  if (m === 0 && reads > 0 && !strict) return 8
  if (m === 0 && lenient && band !== '1 turn' && band !== 'Not recorded') return 9
  if (m === 0) return 4
  if (b >= 2 || m >= 3) return 5
  if (surf === 1 && !strict) return 10
  if (surf === 1) return 6
  return 7
}

function licOf(v: string | undefined): Lic {
  const s = (v ?? '').trim()
  if (s === 'M365 Copilot Licensed') return 'L'
  if (s === 'Unlicensed') return 'U'
  return ''
}

export function buildDataset(
  interactions: Rec[],
  users: Rec[],
  agentRecs: Rec[],
  feedbackRecs: Rec[],
  source: Dataset['source'],
  label: string,
): Dataset {
  const people = buildPeople(users)
  const agents = buildAgents(agentRecs)
  const entraToTitle = new Map<string, string>()
  const titles = new Set<string>()
  const nameToTitle = new Map<string, string>()
  for (const a of agents) {
    if (a.entraId && a.titleId && !entraToTitle.has(a.entraId)) entraToTitle.set(a.entraId, a.titleId)
    if (a.titleId) titles.add(a.titleId)
    const n = a.name.toLowerCase()
    if (n && a.titleId && !nameToTitle.has(n)) nameToTitle.set(n, a.titleId)
  }

  // First pass: per-row basics, plus per-thread and per-message groupings.
  type Base = Omit<Row, 't' | 'fit' | 'coworkCat' | 'taskCat' | 'taskGroup' | 'engage' | 'material' | 'tier'> & { tierSort: number }
  const base: Base[] = []
  const threadRows = new Map<string, Base[]>()
  const msgTypes = new Map<string, Set<string>>()
  for (const r of interactions) {
    const user = low(r['Audit_UserId'])
    const creation = toIsoDate(r['CreationDate']) || toIsoDate(r['InteractionDate'])
    const date = toIsoDate(r['InteractionDate']) || creation
    const rawHost = (r['AppHost'] ?? '').trim()
    const cowork = rawHost.toLowerCase().includes('cowork')
    const agentId = (r['AgentId'] ?? '').trim()
    const tool: Tool = cowork ? 'Cowork' : yes(r['Is_Agent_Activity']) || agentId ? 'Agents' : 'Copilot'
    const prompt = ['TRUE', '1'].includes((r['Message_isPrompt'] ?? '').trim().toUpperCase())
    const thread = (r['ThreadId'] ?? '').trim()
    const msg = (r['Message_Id'] ?? '').trim()
    const agent = (r['AgentName'] ?? '').trim()
    const entra = (r['Agent_EntraId'] ?? '').trim()
    const direct = (r['Agent_TitleID'] ?? '').trim()
    const link = entraToTitle.get(entra) ?? (titles.has(direct) ? direct : '') ?? ''
    const model = (r['AI_Model'] ?? '').trim()
    const resType = (r['AccessedResource_Type'] ?? '').trim()
    const row: Base = {
      user,
      date,
      creation,
      week: toIsoDate(r['WeekStart']) || (date ? mondayOf(date) : ''),
      month: toIsoDate(r['MonthStart']) || (date ? monthOf(date) : ''),
      host: rawHost === 'Microsoft Teams' ? 'Teams' : rawHost,
      thread,
      msg,
      prompt,
      observed: prompt && !!user && !!msg && !!thread,
      usage: prompt || cowork,
      cowork,
      tool,
      lic: licOf(r['License Status']),
      env: (r['Environment'] ?? '').trim(),
      org: people.get(user)?.org ?? UNKNOWN_ORG,
      agentId,
      agent,
      agentType: (r['Agent_Type'] ?? '').trim(),
      link: link || nameToTitle.get(agent.toLowerCase()) || '',
      beh: (r['Behavior_Enriched_Full'] ?? '').trim(),
      behCat: (r['Behavior_Category'] ?? '').trim(),
      outcome: (r['Value_Outcome'] ?? '').trim(),
      mode: (r['Usage_Mode'] ?? '').trim(),
      role: (r['Expertise_Role'] ?? '').trim(),
      eff: (r['Efficiency_Breakdown'] ?? '').trim(),
      model,
      plausible: (r['Behavior_Plausible'] ?? '').trim(),
      resType,
      resAction: (r['AccessedResource_Action'] ?? '').trim(),
      roleAll: '',
      tierSort: tierSort(model),
    }
    row.roleAll = cowork ? coworkRole(resType, row.resAction) : row.role
    base.push(row)
    let list = threadRows.get(thread)
    if (!list) threadRows.set(thread, (list = []))
    list.push(row)
    let types = msgTypes.get(msg)
    if (!types) msgTypes.set(msg, (types = new Set()))
    types.add(resType.toLowerCase())
  }

  const isMaterial = (r: Base) => {
    const t = r.resType.toLowerCase()
    return r.tool === 'Cowork' ? t.length > 0 && t !== 'message' : MATERIAL.has(t)
  }

  const threads = new Map<string, Thread>()
  for (const [id, list] of threadRows) {
    const n = list.length
    const band = !id ? 'Not recorded' : n === 1 ? '1 turn' : n <= 3 ? '2-3 turns' : n <= 6 ? '4-6 turns' : '7+ turns'
    const bandSort = !id ? 9 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4
    const matTypes = new Set<string>()
    let m = 0
    let messages = 0
    let tier = 99
    const blobTypes = new Set<string>()
    for (const r of list) {
      if (isMaterial(r)) {
        m++
        matTypes.add(r.resType)
      }
      if (r.resType.toLowerCase() === 'message') messages++
      blobTypes.add(r.resType.toLowerCase())
      if (r.tierSort < tier) tier = r.tierSort
    }
    const blob = [...blobTypes].join('|')
    const surf = surfaces(blob)
    threads.set(id, {
      id,
      rows: n,
      band,
      bandSort,
      m,
      b: matTypes.size,
      messages,
      surf: surf.length,
      list: surf.join(', '),
      build: buildArtifact(blob),
      tier: tier === 0 ? FRONTIER : tier === 1 ? WORKHORSE : NOT_ATTRIBUTED,
    })
  }

  const rows: Row[] = []
  let maxDate = ''
  let minDate = '9999-12-31'
  let maxCreation = ''
  for (const b of base) {
    const t = threads.get(b.thread)!
    const types = [...(msgTypes.get(b.msg) ?? [])].join('|')
    const coworkCat = b.cowork ? coworkCategory(types) : ''
    const reads = b.tool === 'Cowork' ? t.messages : 0
    const { tierSort: ts, ...rest } = b
    rows.push({
      ...rest,
      coworkCat,
      taskCat: b.cowork ? coworkCat : b.beh,
      taskGroup: b.cowork ? (COWORK_GROUP[coworkCat] ?? 'General Chat & Q&A') : (HTE_CATEGORY.get(b.beh) ?? ''),
      engage: b.cowork ? coworkEngagement(types) : b.mode,
      material: isMaterial(b),
      tier: tierName(ts),
      t,
      fit: [fitStep(t, reads, 0), fitStep(t, reads, 1), fitStep(t, reads, 2)],
    })
    if (b.date && b.date > maxDate) maxDate = b.date
    if (b.date && b.date < minDate) minDate = b.date
    if (b.creation > maxCreation) maxCreation = b.creation
  }
  const months = [...new Set(rows.map((r) => r.month).filter(Boolean))].sort()
  const orgs = [...new Set([...rows.map((r) => r.org), ...[...people.values()].map((p) => p.org)])].sort()
  return {
    rows,
    people,
    agents,
    feedback: buildFeedback(feedbackRecs),
    maxDate,
    minDate: minDate === '9999-12-31' ? '' : minDate,
    maxCreation,
    months,
    orgs,
    hasUsers: people.size > 0,
    source,
    label,
  }
}

async function gunzipBase64(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

async function sampleText(f: string): Promise<string> {
  if (embeddedSample) return gunzipBase64(embeddedSample[f])
  const res = await fetch(`${import.meta.env.BASE_URL}sample/${f}.csv`)
  if (!res.ok) throw new Error(`Could not load sample ${f}.csv (${res.status})`)
  return res.text()
}

export async function loadSample(): Promise<Dataset> {
  const get = async (f: string) => parseCsv(await sampleText(f)).rows
  const [i, u, a, f] = await Promise.all([get('interactions'), get('users'), get('agents'), get('feedback')])
  return buildDataset(i, u, a, f, 'sample', 'Synthetic sample · Contoso')
}

export async function loadFiles(files: File[]): Promise<{ dataset: Dataset; counts: RowCounts }> {
  const parts: Partial<Record<FileKind, Rec[]>> = {}
  const counts: RowCounts = {}
  for (const f of files) {
    const { headers, rows } = parseCsv(await f.text())
    const kind = detectKind(headers)
    if (kind) {
      parts[kind] = rows
      counts[kind] = rows.length
    }
  }
  checkCounts(counts)
  const label = files.map((f) => f.name).join(', ')
  return {
    dataset: buildDataset(parts.interactions!, parts.users ?? [], parts.agents ?? [], parts.feedback ?? [], 'upload', label),
    counts,
  }
}
