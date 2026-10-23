import type { Dataset, Person, Row } from '../data/types'
import { activeUsers, activeUserSet, all, countDistinct, groupBy, isAgent, isL, isU, mean, median, promptUsers, ratio, sessions, type Lens, type Pred } from './core'
import { dayDiff } from '../data/load'

// ---------- Roster (Chat + Agent Org Data and Copilot Licensed) ----------

export function roster(ds: Dataset, org: string): Person[] {
  const out: Person[] = []
  for (const p of ds.people.values()) if (!org || p.org === org) out.push(p)
  return out
}

export interface Activation {
  total: number
  licensed: number
  unlicensed: number
  usable: boolean
  active: number
  activeL: number
  activeU: number
  agentUsers: number
  agentSessions: number
}

/** Activation measures for a set of rows against a roster slice. */
export function activation(rs: Row[], people: Person[]): Activation {
  const total = people.length
  const licensed = people.filter((p) => p.hasLicense).length
  const activeL = activeUsers(rs, isL)
  const usable = licensed > 0 && activeL <= licensed
  return {
    total,
    licensed,
    unlicensed: usable && licensed <= total ? total - licensed : NaN,
    usable,
    active: activeUsers(rs),
    activeL,
    activeU: activeUsers(rs, isU),
    agentUsers: promptUsers(rs, isAgent),
    agentSessions: sessions(rs, isAgent),
  }
}

/** Active vs inactive pair for one lens, as the tornado and donuts show it. */
export function activePair(a: Activation, lens: Exclude<Lens, 'cowork'>): { active: number; inactive: number; activeLabel: string; inactiveLabel: string } {
  switch (lens) {
    case 'licensed':
      return {
        active: a.usable ? a.activeL : NaN,
        inactive: a.activeL <= a.licensed ? a.licensed - a.activeL : NaN,
        activeLabel: 'Active licensed',
        inactiveLabel: 'Inactive licensed',
      }
    case 'unlicensed':
      return {
        active: a.usable ? a.activeU : NaN,
        inactive: Number.isFinite(a.unlicensed) && a.activeU <= a.unlicensed ? a.unlicensed - a.activeU : NaN,
        activeLabel: 'Active unlicensed',
        inactiveLabel: 'Inactive unlicensed',
      }
    case 'agent':
      return { active: a.agentUsers, inactive: Math.max(0, a.active - a.agentUsers), activeLabel: 'Using agents', inactiveLabel: 'Copilot only' }
    default:
      return { active: a.active, inactive: Math.max(0, a.total - a.active), activeLabel: 'Active', inactiveLabel: 'Inactive' }
  }
}

const n0 = (n: number) => Math.round(n).toLocaleString('en-GB')
const p1 = (n: number) => `${(n * 100).toFixed(1)}%`

export function activationHeadline(a: Activation, lens: Exclude<Lens, 'cowork'>): string {
  switch (lens) {
    case 'licensed':
      return a.usable
        ? `${n0(a.activeL)} of ${n0(a.licensed)} matched license holders active (${p1(a.activeL / a.licensed)}).`
        : `${n0(a.activeL)} licensed users observed. License inventory does not reconcile; utilization is unavailable.`
    case 'unlicensed':
      return `${n0(a.activeU)} unlicensed users observed.${
        Number.isFinite(a.unlicensed) && a.unlicensed > 0
          ? ` ${p1(a.activeU / a.unlicensed)} of the matched unlicensed population.`
          : ' Population share unavailable: license inventory does not reconcile.'
      } Usage alone does not establish a need for a paid license.`
    case 'agent':
      return `${n0(a.agentUsers)} users with observed agent activity | ${n0(a.agentSessions)} sessions in this selection. Cowork activity is shown separately.`
    default:
      return `${n0(a.active)} active users${a.total ? ` of ${n0(a.total)} roster users` : ''} | ${n0(a.activeL)} licensed, ${n0(a.activeU)} unlicensed observed in audit.`
  }
}

// ---------- Habit formation ----------

export const STAGES = ['0 - Inactive', '1 - Beginner', '2 - Developing', '3 - Habitual', '4 - Power'] as const
export type Stage = (typeof STAGES)[number]
export const STAGE_LABEL: Record<Stage, string> = {
  '0 - Inactive': 'Inactive',
  '1 - Beginner': 'Beginner',
  '2 - Developing': 'Developing',
  '3 - Habitual': 'Habitual',
  '4 - Power': 'Power',
}

export const stageOf = (days: number): Stage =>
  days === 0 ? '0 - Inactive' : days <= 5 ? '1 - Beginner' : days <= 10 ? '2 - Developing' : days <= 15 ? '3 - Habitual' : '4 - Power'

const endOfMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)
}
const addMonths = (m: string, k: number) => {
  const [y, mo] = m.split('-').map(Number)
  const d = new Date(Date.UTC(y, mo - 1 + k, 1))
  return d.toISOString().slice(0, 10)
}

/** Last Full Month Start: the last complete calendar month, clipped to the selected dates. */
export function lastFullMonth(ds: Dataset, from: string, to: string): string {
  if (!ds.maxDate) return ''
  const m = `${ds.maxDate.slice(0, 7)}-01`
  const lastFull = ds.maxDate === endOfMonth(m) ? m : addMonths(m, -1)
  const selFirst = from || ds.minDate
  const selMonth = to || m
  if (selFirst > endOfMonth(lastFull)) return ''
  return selMonth < lastFull ? selMonth : lastFull
}

/** Inactive (licensed) users are only measured outside the agent, Cowork and unlicensed slices. */
export const inactiveMeasured = (tool: string, lic: string) => tool !== 'Agents' && tool !== 'Cowork' && lic !== 'U'

/** Stage counts for one month of rows; inactive = licensed roster in scope − active licensed. */
export function stageCounts(monthRows: Row[], licensedInScope: number, measured: boolean): Record<Stage, number> & { base: number } {
  const days = new Map<string, Set<string>>()
  for (const r of monthRows) {
    if (!r.user || !r.date) continue
    let s = days.get(r.user)
    if (!s) days.set(r.user, (s = new Set()))
    s.add(r.date)
  }
  const c: Record<Stage, number> = { '0 - Inactive': NaN, '1 - Beginner': 0, '2 - Developing': 0, '3 - Habitual': 0, '4 - Power': 0 }
  for (const s of days.values()) c[stageOf(s.size)]++
  if (measured) c['0 - Inactive'] = Math.max(0, licensedInScope - activeUsers(monthRows, isL))
  const active = days.size
  return { ...c, base: (Number.isFinite(c['0 - Inactive']) ? c['0 - Inactive'] : 0) + active }
}

export interface UserStage {
  id: string
  user: string
  org: string
  stage: Stage
  days: number
  agentSessions: number
}

export function userStages(monthRows: Row[], allRowsForUsers: Row[]): UserStage[] {
  const byUser = groupBy(monthRows, (r) => r.user)
  const users = new Set(allRowsForUsers.map((r) => r.user).filter(Boolean))
  const out: UserStage[] = []
  for (const u of users) {
    const list = byUser.get(u) ?? []
    const days = countDistinct(list, (r) => r.date)
    out.push({ id: u, user: u, org: list[0]?.org ?? allRowsForUsers.find((r) => r.user === u)?.org ?? '', stage: stageOf(days), days, agentSessions: sessions(list, isAgent) })
  }
  return out
}

// ---------- License prioritisation ----------

export interface UnlicensedStats {
  tasksPW: number
  daysPW: number
  sessionsPW: number
}

/** Per-user unlicensed rates: tasks, active days and sessions per active week. */
export function unlicensedUser(list: Row[]): UnlicensedStats | null {
  const u = list.filter((r) => r.prompt && r.lic === 'U')
  if (!u.length) return null
  const weeks = countDistinct(u, (r) => r.week)
  const sWeeks = countDistinct(
    list.filter((r) => r.lic === 'U'),
    (r) => r.week,
  )
  return {
    tasksPW: ratio(u.length, weeks) || 0,
    daysPW: ratio(
      countDistinct(u, (r) => r.date),
      weeks,
    ) || 0,
    sessionsPW: ratio(sessions(list, isU), sWeeks) || 0,
  }
}

export function priorityScore(tasksPW: number, daysPW: number): number {
  if (!(tasksPW > 0) || !(daysPW > 0)) return NaN
  return Math.round(60 * Math.min(tasksPW / 30, 1) + 40 * Math.min(daysPW / 5, 1))
}

export interface Candidate {
  id: string
  stats: UnlicensedStats
  score: number
}

/** Unlicensed candidates for a set of rows, keyed by user. */
export function unlicensedCandidates(rs: Row[]): Map<string, Candidate> {
  const out = new Map<string, Candidate>()
  for (const [u, list] of groupBy(rs, (r) => r.user)) {
    if (!u) continue
    const s = unlicensedUser(list)
    if (s) out.set(u, { id: u, stats: s, score: priorityScore(s.tasksPW, s.daysPW) })
  }
  return out
}

/** Group-level score: the measure takes medians over the group's users before scoring. */
export function groupPriority(cands: Candidate[]) {
  const tasks = median(cands.map((c) => c.stats.tasksPW))
  const days = median(cands.map((c) => c.stats.daysPW))
  return {
    score: priorityScore(tasks, days),
    medianSessionsPW: median(cands.map((c) => c.stats.sessionsPW)),
    avgDaysPW: mean(cands.map((c) => c.stats.daysPW)),
  }
}

export const medianUnlicensedSessionsPW = (rs: Row[]) => median([...unlicensedCandidates(rs).values()].map((c) => c.stats.sessionsPW))
export const unlicensedShare = (rs: Row[]) => ratio(activeUsers(rs, isU), activeUsers(rs))

/** Average Active Days Per User Per Week (Unlicensed Chat). */
export const avgUnlicensedDaysPW = (rs: Row[]) => mean([...unlicensedCandidates(rs).values()].map((c) => c.stats.daysPW))

// ---------- Dormancy (Copilot Licensed) ----------

export const DORMANCY = ['Active (<30 days)', 'Inactive 30-89 days', 'Inactive 90-179 days', 'Inactive 180+ days', 'Never active'] as const

export function dormancy(ds: Dataset, people: Person[]) {
  const last = new Map<string, string>()
  for (const r of ds.rows) if (r.user && r.date && (last.get(r.user) ?? '') < r.date) last.set(r.user, r.date)
  const span = ds.minDate && ds.maxDate ? dayDiff(ds.minDate, ds.maxDate) : 0
  const counts = new Map<string, number>(DORMANCY.map((b) => [b, 0]))
  const days: number[] = []
  let inactive30 = 0
  for (const p of people) {
    if (!p.hasLicense) continue
    const l = last.get(p.id)
    const d = l ? Math.max(0, dayDiff(l, ds.maxDate)) : span
    const b = !l ? 'Never active' : d < 30 ? 'Active (<30 days)' : d < 90 ? 'Inactive 30-89 days' : d < 180 ? 'Inactive 90-179 days' : 'Inactive 180+ days'
    counts.set(b, (counts.get(b) ?? 0) + 1)
    days.push(d)
    if (d >= 30) inactive30++
  }
  return { counts, inactive30, avgDays: mean(days), span }
}

const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

export function evidenceNotice(ds: Dataset, usable: boolean): string {
  if (!usable)
    return 'License inventory does not reconcile to the organizational roster and observed licensed users. Dormancy and reclaim estimates are unavailable until identity/license mapping is corrected.'
  if (!ds.minDate) return 'No audit activity is loaded, so dormancy cannot be assessed.'
  const span = dayDiff(ds.minDate, ds.maxDate)
  return `Dormancy is measured against the audit window (${longDate(ds.minDate)} to ${longDate(ds.maxDate)}, ${span} days), not against today. ${
    span < 90
      ? `The window is shorter than 90 days, so a never-active seat reads as roughly ${span} days dormant and the 90d+ and 180d+ cuts cannot be evidenced. Treat 30d+ as 'no activity in the loaded window', not as a confirmed reclaim list.`
      : `Thresholds longer than ${span} days cannot be distinguished from a never-active seat.`
  }`
}

export function reclaimNotice(usable: boolean, cost: number, currency: string): string {
  if (!usable) return 'Reclaim value is unavailable until license inventory reconciles - see the dormancy evidence note.'
  return cost > 0
    ? `Costed at ${currency}${Math.round(cost).toLocaleString('en-GB')} per licence per month (Monthly Licence Cost assumption).`
    : 'Not costed: the Monthly Licence Cost assumption is 0, so the reclaimable value reads as zero. Set it in Assumptions to price the dormant seats.'
}

// ---------- Cowork readiness ----------

const coworkUsersCache = new WeakMap<Row[], Set<string>>()
/** Users with any Cowork row in the whole dataset (REMOVEFILTERS(F)). */
export function allCoworkUsers(allRows: Row[]): Set<string> {
  let s = coworkUsersCache.get(allRows)
  if (!s) {
    s = new Set(allRows.filter((r) => r.cowork && r.user).map((r) => r.user))
    coworkUsersCache.set(allRows, s)
  }
  return s
}

/** Cowork Readiness: Surfaces Per Day: distinct user-day-app ÷ distinct user-day, non-Cowork prompts. */
export function surfacesPerDay(rs: Row[]): number {
  const uda = new Set<string>()
  const ud = new Set<string>()
  for (const r of rs) {
    if (!r.prompt || r.cowork || !r.date || !r.host.trim()) continue
    uda.add(`${r.user}|${r.date}|${r.host}`)
    ud.add(`${r.user}|${r.date}`)
  }
  return ratio(uda.size, ud.size)
}

const sessionPromptRatio = (rs: Row[], p: Pred = all) => {
  const s = new Set<string>()
  const sp = new Set<string>()
  for (const r of rs) {
    if (!r.observed || !p(r)) continue
    const k = `${r.user}|${r.host}|${r.thread}`
    s.add(k)
    sp.add(`${k}|${r.msg}`)
  }
  return ratio(sp.size, s.size)
}

export function coworkReadinessKpis(rs: Row[], allRows: Row[]) {
  const cu = allCoworkUsers(allRows)
  const eligible = new Set<string>()
  for (const r of rs) if (r.prompt && r.user && !cu.has(r.user)) eligible.add(r.user)
  const el = rs.filter((r) => eligible.has(r.user))
  const perDay = groupBy(
    el.filter((r) => r.prompt && !r.cowork && r.date),
    (r) => `${r.user}|${r.date}`,
  )
  return {
    eligible: eligible.size,
    depth: sessionPromptRatio(el),
    surfaces: mean([...perDay.values()].map((l) => countDistinct(l, (r) => r.host))),
    agentShare: ratio(promptUsers(el, isAgent), eligible.size),
  }
}

export interface ReadinessUser {
  user: string
  org: string
  b: number
  d: number
  a: 0 | 1
  score: number
}

/** Users with no Cowork sessions, scored on breadth (45), depth (35) and agent use (20). */
export function readinessUsers(rs: Row[]): ReadinessUser[] {
  const out: Omit<ReadinessUser, 'score'>[] = []
  for (const [u, list] of groupBy(rs, (r) => r.user)) {
    if (!u) continue
    if (sessions(list, (r) => r.cowork) > 0) continue
    const b = surfacesPerDay(list)
    const d = sessionPromptRatio(list, (r) => !r.cowork)
    if (!Number.isFinite(b) || !Number.isFinite(d)) continue
    out.push({ user: u, org: list[0].org, b, d, a: sessions(list, isAgent) > 0 ? 1 : 0 })
  }
  const maxB = Math.max(0, ...out.map((x) => x.b))
  const maxD = Math.max(0, ...out.map((x) => x.d))
  return out.map((x) => ({
    ...x,
    score: Math.round(45 * Math.min(ratio(x.b, maxB) || 0, 1) + 35 * Math.min(ratio(x.d, maxD) || 0, 1) + 20 * x.a),
  }))
}

/** Eligible users in a group (active prompt users who have never used Cowork). */
export function eligibleUsers(rs: Row[], allRows: Row[]): number {
  const cu = allCoworkUsers(allRows)
  return countDistinct(rs, (r) => (r.prompt && r.user && !cu.has(r.user) ? r.user : ''))
}

export const activeSet = activeUserSet
