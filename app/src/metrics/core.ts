import type { Row } from '../data/types'

export type Pred = (r: Row) => boolean

export const all: Pred = () => true
export const isL: Pred = (r) => r.lic === 'L'
export const isU: Pred = (r) => r.lic === 'U'
export const isAgent: Pred = (r) => r.tool === 'Agents'
export const isCowork: Pred = (r) => r.cowork
export const notCowork: Pred = (r) => !r.cowork
export const and =
  (...ps: Pred[]): Pred =>
  (r) =>
    ps.every((p) => p(r))

export function countDistinct(rows: Row[], f: (r: Row) => string): number {
  const s = new Set<string>()
  for (const r of rows) {
    const v = f(r)
    if (v !== '') s.add(v)
  }
  return s.size
}

export function distinct(rows: Row[], f: (r: Row) => string): Set<string> {
  const s = new Set<string>()
  for (const r of rows) {
    const v = f(r)
    if (v !== '') s.add(v)
  }
  return s
}

export function groupBy<K extends string>(rows: Row[], f: (r: Row) => K): Map<K, Row[]> {
  const m = new Map<K, Row[]>()
  for (const r of rows) {
    const k = f(r)
    const a = m.get(k)
    if (a) a.push(r)
    else m.set(k, [r])
  }
  return m
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
export const mean = (xs: number[]) => {
  const v = xs.filter(Number.isFinite)
  return v.length ? sum(v) / v.length : NaN
}
export function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return NaN
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
export const ratio = (a: number, b: number) => (b ? a / b : NaN)
/** Round half to even, as the Cowork run count in the model does. */
export const bankers = (n: number) => {
  const f = Math.floor(n)
  const d = n - f
  if (Math.abs(d - 0.5) > 1e-9) return Math.round(n)
  return f % 2 === 0 ? f : f + 1
}

// ---------- The population lens (which "variant" of a page the PBI bookmarks show) ----------

export type Lens = 'overall' | 'licensed' | 'unlicensed' | 'agent' | 'cowork'
export const LENS_PRED: Record<Lens, Pred> = {
  overall: all,
  licensed: isL,
  unlicensed: isU,
  agent: isAgent,
  cowork: isCowork,
}
export const LENS_LABEL: Record<Lens, string> = {
  overall: 'All users',
  licensed: 'Licensed',
  unlicensed: 'Unlicensed',
  agent: 'Agent users',
  cowork: 'Cowork users',
}

// ---------- Base measures (Chat + Agent Interactions) ----------

/** All Active Users: distinct users with a prompt or Cowork row. */
export const activeUsers = (rs: Row[], p: Pred = all) => countDistinct(rs, (r) => (r.usage && p(r) ? r.user : ''))
export const activeUserSet = (rs: Row[], p: Pred = all) => distinct(rs, (r) => (r.usage && p(r) ? r.user : ''))
/** Users with at least one prompt row (Active Agent Users uses this with the Agents predicate). */
export const promptUsers = (rs: Row[], p: Pred = all) => countDistinct(rs, (r) => (r.prompt && p(r) ? r.user : ''))
/** Active users for a lens: agent users are prompt users, everyone else usage users. */
export const lensUsers = (rs: Row[], lens: Lens) => (lens === 'agent' ? promptUsers(rs, isAgent) : activeUsers(rs, LENS_PRED[lens]))
/** AI Tasks: prompt rows. */
export const aiTasks = (rs: Row[], p: Pred = all) => {
  let n = 0
  for (const r of rs) if (r.prompt && p(r)) n++
  return n
}
/** AI Prompts: distinct prompt messages. */
export const aiPrompts = (rs: Row[], p: Pred = all) => countDistinct(rs, (r) => (r.prompt && p(r) ? r.msg : ''))

const sKey = (r: Row) => `${r.user}|${r.host}|${r.thread}`
/** Observed Sessions: one conversation per user and app. */
export const sessions = (rs: Row[], p: Pred = all) => countDistinct(rs, (r) => (r.observed && p(r) ? sKey(r) : ''))
export const sessionPrompts = (rs: Row[], p: Pred = all) => countDistinct(rs, (r) => (r.observed && p(r) ? `${sKey(r)}|${r.msg}` : ''))
export const promptsPerSession = (rs: Row[], p: Pred = all) => ratio(sessionPrompts(rs, p), sessions(rs, p))
export const sessionsPerUser = (rs: Row[], lens: Lens = 'overall') => ratio(sessions(rs, LENS_PRED[lens]), lensUsers(rs, lens))

/** Sessions per user per week: weekly sessions ÷ weekly active users, averaged over the lens's active weeks. */
export function sessionsPerUserPerWeek(rs: Row[], lens: Lens = 'overall'): number {
  const p = LENS_PRED[lens]
  const g = groupBy(
    rs.filter((r) => p(r)),
    (r) => r.week,
  )
  return mean([...g.values()].map((w) => ratio(sessions(w), lensUsers(w, lens))))
}

/** Share of users with 2+ observed sessions, among users with any. */
export function returnRate(rs: Row[], p: Pred = all): number {
  const per = new Map<string, Set<string>>()
  for (const r of rs) {
    if (!r.observed || !p(r)) continue
    let s = per.get(r.user)
    if (!s) per.set(r.user, (s = new Set()))
    s.add(sKey(r))
  }
  if (!per.size) return NaN
  let repeat = 0
  for (const s of per.values()) if (s.size >= 2) repeat++
  return repeat / per.size
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export function series(rs: Row[], key: (r: Row) => string, fs: ((rs: Row[]) => number)[]) {
  const g = groupBy(rs, key)
  return [...g.keys()]
    .filter(Boolean)
    .sort()
    .map((k) => ({ key: k, values: fs.map((f) => f(g.get(k)!)) }))
}

/** Dense descending rank: 1 + number of distinct higher values. */
export function denseRank(values: number[]): (v: number) => number {
  const uniq = [...new Set(values.filter(Number.isFinite))].sort((a, b) => b - a)
  return (v) => (Number.isFinite(v) ? uniq.indexOf(v) + 1 : NaN)
}
