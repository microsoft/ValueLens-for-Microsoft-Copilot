import behaviors from '../data/behaviors.json'
import estimates from '../data/estimates.json'
import type { Row, Scenario } from '../data/types'
import { activeUsers, aiTasks, bankers, countDistinct, distinct, groupBy, isCowork, isL, mean, notCowork, ratio } from './core'

export interface Estimate {
  behavior: string
  baseline: number
  confidence: string
  source: string
  url: string
  category: string
  valueOutcome: string
  coworkCategory: string
  low: number
  typical: number
  high: number
  grain: string
}
export interface Behaviour {
  signal: string
  behavior: string
  useCase: string
  valueOutcome: string
  description: string
}

export const ESTIMATES = estimates as Estimate[]
export const BEHAVIOURS = behaviors as Behaviour[]

/** Human Time Estimates by behaviour; MAX over duplicates, as CALCULATE(MAX(...)) does. */
const HTE = new Map<string, Estimate>()
for (const e of ESTIMATES) {
  const prev = HTE.get(e.behavior)
  HTE.set(
    e.behavior,
    prev
      ? { ...e, low: Math.max(prev.low, e.low), typical: Math.max(prev.typical, e.typical), high: Math.max(prev.high, e.high), grain: prev.grain > e.grain ? prev.grain : e.grain }
      : e,
  )
}
const BVM = new Set(BEHAVIOURS.map((b) => b.behavior))

export const minutesFor = (e: Pick<Estimate, 'low' | 'typical' | 'high'>, s: Scenario) =>
  s === 'Conservative' ? e.low : s === 'Optimistic' ? e.high : e.typical

/** Mean resources per prompt for each behaviour across all data (the REMOVEFILTERS in the HEH measure). */
const meanResCache = new WeakMap<Row[], Map<string, number>>()
function meanRes(all: Row[]): Map<string, number> {
  let m = meanResCache.get(all)
  if (m) return m
  m = new Map()
  for (const [b, rs] of groupBy(
    all.filter((r) => r.prompt && BVM.has(r.beh)),
    (r) => r.beh,
  ))
    m.set(b, ratio(rs.length, countDistinct(rs, (r) => r.msg)))
  meanResCache.set(all, m)
  return m
}

/** Human Equivalent Hours (Behaviour Basis). */
export function heh(rs: Row[], all: Row[], scenario: Scenario): number {
  const mr = meanRes(all)
  let h = 0
  for (const [b, list] of groupBy(
    rs.filter((r) => r.prompt && BVM.has(r.beh)),
    (r) => r.beh,
  )) {
    const e = HTE.get(b)
    if (!e) continue
    const msgs = countDistinct(list, (r) => r.msg)
    const m = mr.get(b) ?? 0
    const units = e.grain === 'Per Resource' && m > 0 ? list.length / m : msgs
    h += (minutesFor(e, scenario) * units) / 60
  }
  return h
}

const COWORK_BAND: Record<string, [number, number, number]> = {
  'Analysis & Research': [30, 67, 92],
  'Document & content creation': [12, 24, 42],
  'Email workflows': [3, 7, 12],
  'Meeting workflows': [12, 31, 43],
  'Communication workflows': [2, 4, 11],
  'Specialized workflows': [10, 25, 40],
  'Write or debug code': [30, 56, 96],
  'General assistance / Other': [2, 5, 8],
}
const COWORK_CHAIN: Record<string, number> = {
  'Analysis & Research': 5,
  'Email workflows': 4,
  'Communication workflows': 4,
  'Meeting workflows': 3,
  'Write or debug code': 6,
}

/** Cowork Hours (Task Category Basis): one run per chain of reads, per thread and category. */
export function coworkHours(rs: Row[], scenario: Scenario): number {
  let h = 0
  const idx = scenario === 'Conservative' ? 0 : scenario === 'Optimistic' ? 2 : 1
  for (const [k, list] of groupBy(
    rs.filter(isCowork),
    (r) => `${r.thread}\u0001${r.coworkCat}`,
  )) {
    const cat = k.split('\u0001')[1]
    const band = COWORK_BAND[cat]
    if (!band) continue
    const chain = COWORK_CHAIN[cat] ?? 0
    let runs = 1
    if (chain > 0) {
      const reads = list.filter((r) => {
        const t = r.resType.trim().toLowerCase()
        return t.length > 0 && t !== 'message'
      }).length
      runs = Math.max(1, bankers(reads / chain))
    }
    h += (runs * band[idx]) / 60
  }
  return h
}

/** Expert Equivalent Hours: behaviour basis on non-Cowork rows plus Cowork hours. */
export const eeh = (rs: Row[], all: Row[], s: Scenario) => heh(rs.filter(notCowork), all, s) + coworkHours(rs, s)

export interface ValueInputs {
  all: Row[]
  scenario: Scenario
  hourly: number
  penalty: number
  ppupm: number
  /** Distinct weeks in the selected dates across all rows (EEH per week denominator). */
  windowWeeks: number
}

export function valueMeasures(rs: Row[], v: ValueInputs) {
  const hours = eeh(rs, v.all, v.scenario)
  const weeksInView = countDistinct(rs, (r) => r.week)
  const value = hours * v.hourly * v.penalty
  const investment = licenceInvestment(rs, v.ppupm)
  return {
    hours,
    hoursPerWeek: ratio(hours, v.windowWeeks) || 0,
    hoursPerUser: ratio(hours, countDistinct(rs, (r) => r.user)) || 0,
    value,
    valuePerWeek: ratio(value, weeksInView) || 0,
    annualised: (value * 52) / Math.max(weeksInView, 1),
    investment,
    roi: value - investment,
  }
}

/** Copilot License Investment: PPUPM × licensed users, summed over months. */
export function licenceInvestment(rs: Row[], ppupm: number): number {
  let t = 0
  for (const list of groupBy(rs, (r) => r.month).values()) t += ppupm * countDistinct(list.filter(isL), (r) => r.user)
  return t
}

/** Top Value Outcome (by EEH), falling back to the Cowork task category when only Cowork rows are in view. */
export function topOutcome(rs: Row[], all: Row[], s: Scenario): string {
  const hasNonCowork = rs.some(notCowork)
  const key = hasNonCowork ? (r: Row) => r.outcome : (r: Row) => r.coworkCat
  let best = ''
  let max = -Infinity
  for (const [k, list] of groupBy(rs, key)) {
    if (!k) continue
    const h = eeh(list, all, s)
    if (h > max) {
      max = h
      best = k
    }
  }
  return best
}

/** Work Created - Per Week: "4 - Producing" rows per week of the window. */
export const workPerWeek = (rs: Row[], windowWeeks: number) => ratio(rs.filter((r) => r.mode === '4 - Producing').length, windowWeeks) || 0

export const expertiseRoles = (rs: Row[]) => countDistinct(rs, (r) => (r.prompt ? r.roleAll : ''))
export const expertiseUsers = (rs: Row[]) => countDistinct(rs, (r) => (r.prompt && r.roleAll ? r.user : ''))
export function avgSkills(rs: Row[]): number {
  const per = new Map<string, Set<string>>()
  for (const r of rs) {
    if (!r.prompt || !r.user) continue
    let s = per.get(r.user)
    if (!s) per.set(r.user, (s = new Set()))
    if (r.taskCat) s.add(r.taskCat)
  }
  return mean([...per.values()].map((s) => s.size)) || 0
}

export function executiveHeadline(rs: Row[], v: ValueInputs): [string, string] {
  const hpw = valueMeasures(rs, v).hoursPerWeek
  const insight =
    hpw === 0
      ? 'No measurable AI productivity in this view'
      : hpw >= 5000
        ? 'AI is delivering material weekly productivity across the org'
        : hpw >= 1000
          ? 'AI is delivering steady weekly productivity'
          : 'AI productivity is at an early, exploratory stage'
  const f = (n: number) => Math.round(n).toLocaleString('en-GB')
  return [
    insight,
    `${f(aiTasks(rs))} AI tasks · ${f(hpw)} expert equivalent hours per week · ${f(workPerWeek(rs, v.windowWeeks))} work items created · ${f(expertiseRoles(rs))} specialist roles unlocked`,
  ]
}

export function skillsHeadline(rs: Row[], cohort: { cowork: boolean; agent: boolean; lic: '' | 'L' | 'U' }): [string, string] {
  const avg = avgSkills(rs)
  const roles = expertiseRoles(rs)
  const users = expertiseUsers(rs)
  const { cowork, agent, lic } = cohort
  const who = cowork
    ? 'Cowork users'
    : agent && lic === 'L'
      ? 'Licensed agent users'
      : agent && lic === 'U'
        ? 'Unlicensed agent users'
        : agent
          ? 'Agent users'
          : lic === 'L'
            ? 'Licensed Copilot users'
            : lic === 'U'
              ? 'Unlicensed Copilot users'
              : 'Copilot & agent users'
  const insight =
    avg === 0 && users === 0
      ? 'have not yet tapped AI-augmented skills in this view'
      : avg >= 5 && users >= 50
        ? 'tap a broad set of AI skills and routinely reach specialist expertise'
        : avg >= 5
          ? 'tap a broad set of AI-augmented skills'
          : users >= 50
            ? `regularly reach specialist AI expertise${agent ? ' via agents' : ''}`
            : avg >= 3
              ? 'are reaching beyond a few core skills'
              : users >= 10
                ? `are starting to access specialist${agent ? ' agent' : ''} expertise`
                : 'use a small set of core AI skills — room to broaden'
  return [`${who} ${insight}`, `${avg.toFixed(1)} avg skill types per user · ${roles} specialist roles tapped by ${users.toLocaleString('en-GB')} users`]
}

/** Activity Share: prompt rows in the group ÷ prompt rows in the whole selection. */
export const activityShare = (group: Row[], total: number) => ratio(aiTasks(group), total)

/** % of Users in Stage: prompt users in the category ÷ prompt users ignoring the category. */
export function usersInCategory(rs: Row[], key: (r: Row) => string) {
  const total = countDistinct(rs, (r) => (r.prompt ? r.user : ''))
  return [...groupBy(rs, key)]
    .filter(([k]) => k)
    .map(([k, list]) => ({ key: k, value: ratio(countDistinct(list, (r) => (r.prompt ? r.user : '')), total) }))
}

/** Stage Top Org: the organisation with the most distinct users in the group. */
export function topOrg(rs: Row[]): string {
  let best = ''
  let max = 0
  for (const [o, list] of groupBy(rs, (r) => r.org)) {
    const n = distinct(list, (r) => r.user).size
    if (n > max) {
      max = n
      best = o
    }
  }
  return best
}

export const coworkUsers = (rs: Row[]) => activeUsers(rs, isCowork)
