export type Tool = 'Copilot' | 'Agents' | 'Cowork'
/** License Status on the audit row: L = M365 Copilot Licensed, U = Unlicensed, '' = anything else. */
export type Lic = 'L' | 'U' | ''
export type Grading = 'Strict' | 'Balanced' | 'Lenient'
export const GRADINGS: Grading[] = ['Strict', 'Balanced', 'Lenient']
export type Scenario = 'Conservative' | 'Typical' | 'Optimistic'
export const SCENARIOS: Scenario[] = ['Conservative', 'Typical', 'Optimistic']

export const UNKNOWN_ORG = '(Blank)'
export const FRONTIER = 'Frontier (premium cost)'
export const WORKHORSE = 'Workhorse (mid cost)'
export const NOT_ATTRIBUTED = 'Not attributed'

/** Facts shared by every row of one ThreadId (the DAX ALLEXCEPT(F, F[ThreadId]) calc columns). */
export interface Thread {
  id: string
  rows: number
  band: string
  bandSort: number
  /** Session Material Refs */
  m: number
  /** Session Material Types */
  b: number
  /** rows whose resource type is "message" (Session Message Reads for Cowork rows) */
  messages: number
  surf: number
  list: string
  build: boolean
  /** Session Model Tier */
  tier: string
}

export interface Row {
  user: string
  date: string
  creation: string
  week: string
  month: string
  host: string
  thread: string
  msg: string
  prompt: boolean
  observed: boolean
  usage: boolean
  cowork: boolean
  tool: Tool
  lic: Lic
  env: string
  org: string
  agentId: string
  agent: string
  agentType: string
  /** Title ID of the matching registry agent (Agent_LinkID) */
  link: string
  beh: string
  behCat: string
  outcome: string
  mode: string
  role: string
  eff: string
  model: string
  plausible: string
  resType: string
  resAction: string
  coworkCat: string
  taskCat: string
  taskGroup: string
  engage: string
  roleAll: string
  material: boolean
  tier: string
  t: Thread
  /** Fit Rule Step for each grading mode, indexed like GRADINGS */
  fit: [number, number, number]
}

export interface Person {
  id: string
  name: string
  org: string
  title: string
  country: string
  hasLicense: boolean
}

export interface AgentInfo {
  name: string
  titleId: string
  entraId: string
  creator: string
  creatorSource: string
  typeA365: string
  typeLabel: string
  /** Agent Type Combined: "Agent Builder" for shared agents built in Agent Builder */
  typeCombined: string
  description: string
  createdIn: string
  supportedIn: string
  lastUpdated: string
  status: string
  blocked: boolean
  features: string
  tenant: boolean
  /** Registry "Total Users"; null when the export has no such column (observed users are used instead). */
  totalUsers: number | null
}

export interface Feedback {
  id: string
  comment: string
  date: string
  month: string
  type: string
  emoji: string
  app: string
  surface: string
  category: string
  prompt: string
}

export interface Dataset {
  rows: Row[]
  people: Map<string, Person>
  agents: AgentInfo[]
  feedback: Feedback[]
  maxDate: string
  minDate: string
  /** latest CreationDate (ISO date), used for agent idle days */
  maxCreation: string
  months: string[]
  orgs: string[]
  hasUsers: boolean
  source: 'sample' | 'upload'
  label: string
}
