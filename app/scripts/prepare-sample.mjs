// Builds the bundled synthetic sample from the Local CSV variant's sample-data folder.
// Usage: node scripts/prepare-sample.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const src = path.join(root, '5. Local CSV', 'sample-data')
const out = path.resolve(here, '..', 'public', 'sample')
fs.mkdirSync(out, { recursive: true })

const sources = {
  interactions: 'copilot_interactions_sample.csv',
  users: 'copilot_users_sample.csv',
  agents: 'agents_365_sample.csv',
  feedback: 'product_feedback_sample.csv',
}

// Only the columns the app reads, so the bundle stays small.
const keep = {
  interactions: [
    'CreationDate', 'Audit_UserId', 'AppHost', 'Message_Id', 'Message_isPrompt', 'AgentId', 'AgentName', 'ThreadId',
    'AccessedResource_Type', 'AccessedResource_Action', 'Behavior_Enriched_Full', 'Behavior_Category', 'Value_Outcome',
    'WeekStart', 'InteractionDate', 'MonthStart', 'Usage_Mode', 'Expertise_Role', 'Efficiency_Breakdown',
    'License Status', 'Environment', 'AI_Model', 'Behavior_Plausible', 'Is_Agent_Activity', 'Agent Filter',
    'Agent_Type', 'Agent_TitleID', 'Agent_EntraId',
  ],
  users: ['PersonId', 'displayName', 'Organization', 'JobTitle', 'country', 'Has license'],
  agents: [
    'Agent name', 'Title ID', 'Entra Agent ID', 'Agent creator', 'Publisher', 'Agent creator source', 'Agent type (A365)',
    'Agent description', 'Created in', 'Supported in', 'Last updated', 'Status', 'Is Blocked',
    'Can read OneDrive files', 'Can read Sharepoint sites and files', 'Can read OneDrive and Sharepoint items',
    'Can extend to Graph connector', 'Can generate images using user prompt', 'Can use code interpreter',
    'Contains uploaded files',
  ],
  feedback: [
    'Feedback Id', 'Comment', 'Date Submitted UTC', 'Feedback Type', 'App', 'User Id', 'AI Context Prompt',
    'Additional Metadata',
  ],
}

for (const [kind, file] of Object.entries(sources)) {
  const text = fs.readFileSync(path.join(src, file), 'utf8').replace(/^\uFEFF/, '')
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() })
  const cols = keep[kind].filter((c) => parsed.meta.fields.includes(c))
  const rows = parsed.data.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? ''])))
  fs.writeFileSync(path.join(out, `${kind}.csv`), Papa.unparse(rows, { columns: cols }) + '\n')
  console.log(`${kind}: ${rows.length} rows, ${cols.length} columns`)
}
