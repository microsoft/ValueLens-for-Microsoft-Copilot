import type { AgentInfo, Dataset, Row } from '../data/types'
import { dayDiff } from '../data/load'
import { activeUsers, countDistinct, groupBy, isAgent, LENS_PRED, promptUsers, returnRate, sessions, sessionsPerUser, type Lens } from './core'

// ---------- Agent registry (Agents 365) ----------

export const LIFECYCLE = ['Blocked by admin', 'In use', 'Deployed, not yet used', 'Tenant-built, no owner', 'Tenant-built, not deployed', 'Catalogue listing'] as const

export interface AgentStats {
  users: number
  orgs: number
  sessions: number
  returnRate: number
  lastObserved: string
}

/** Agent rows linked to one registry record (relationship on Title ID). */
export function agentRows(rows: Row[], a: AgentInfo): Row[] {
  return a.titleId ? rows.filter((r) => r.link === a.titleId) : []
}

export function agentStats(list: Row[]): AgentStats {
  const ag = list.filter(isAgent)
  let last = ''
  for (const r of list) if (r.prompt && r.agentId && r.creation > last) last = r.creation
  const s = sessions(list, isAgent)
  return {
    users: promptUsers(list, isAgent),
    orgs: s ? countDistinct(ag, (r) => (r.org ? r.org : '')) : NaN,
    sessions: s,
    returnRate: returnRate(list, isAgent),
    lastObserved: last,
  }
}

export function lifecycle(a: AgentInfo, observedUsers: number): string {
  const users = a.totalUsers ?? observedUsers
  const status = a.status.trim().toLowerCase()
  if (a.blocked) return LIFECYCLE[0]
  if (users > 0) return LIFECYCLE[1]
  if (status && status !== 'acquiredfornone') return LIFECYCLE[2]
  if (a.tenant && a.creatorSource.trim().toLowerCase() !== 'ownerid') return LIFECYCLE[3]
  if (a.tenant) return LIFECYCLE[4]
  return LIFECYCLE[5]
}

/** Agent Usage Review: last seen by name across all audit rows, idle days against the audit max. */
export function usageReview(a: AgentInfo, observedUsers: number, lastSeen: string, auditMax: string): string {
  const users = a.totalUsers ?? observedUsers
  if (users === 0 || !lastSeen) return 'No usage recorded'
  const idle = auditMax ? dayDiff(lastSeen, auditMax) : 0
  if (idle > 90) return 'Dormant (90+ days)'
  if (idle > 30) return 'Cooling (30+ days)'
  if (users >= 50) return 'High impact'
  if (users >= 15) return 'Established'
  if (users >= 5) return 'Growing'
  return 'Pilot'
}

const lastSeenCache = new WeakMap<Row[], Map<string, string>>()
/** Max CreationDate per AgentName over the whole dataset (ignores filters). */
export function lastSeenByName(allRows: Row[]): Map<string, string> {
  let m = lastSeenCache.get(allRows)
  if (!m) {
    m = new Map()
    for (const r of allRows) if (r.agent && r.creation > (m.get(r.agent) ?? '')) m.set(r.agent, r.creation)
    lastSeenCache.set(allRows, m)
  }
  return m
}

export interface EstateRow extends AgentStats {
  id: string
  agent: AgentInfo
  lifecycle: string
  review: string
}

export function estate(ds: Dataset, rows: Row[], agents: AgentInfo[]): EstateRow[] {
  const seen = lastSeenByName(ds.rows)
  const byLink = groupBy(rows, (r) => r.link)
  return agents
    .filter((a) => a.titleId)
    .map((a, i) => {
      const st = agentStats(byLink.get(a.titleId) ?? [])
      const allUsers = promptUsers(
        ds.rows.filter((r) => r.link === a.titleId),
        isAgent,
      )
      return {
        id: `${a.titleId}|${i}`,
        agent: a,
        ...st,
        lifecycle: lifecycle(a, allUsers),
        review: usageReview(a, allUsers, seen.get(a.name) ?? '', ds.maxCreation),
      }
    })
}

export function registryFreshness(agents: AgentInfo[]): string {
  let m = ''
  for (const a of agents) if (a.lastUpdated > m) m = a.lastUpdated
  return m
}

export const builtInTenant = (agents: AgentInfo[]) => agents.filter((a) => a.tenant).length

export function linkageNote(observed: number, registry: number): string {
  return `${observed.toLocaleString('en-GB')} of ${registry.toLocaleString('en-GB')} listed agents have a session matched from audit logs. No match = no evidence of use in these dates, not proof of disuse.`
}

/** Most Versatile Agent: the AgentName(s) with the most distinct prompt users. */
export function mostVersatile(rs: Row[]): string {
  const counts = [...groupBy(rs, (r) => r.agent)]
    .filter(([n]) => n)
    .map(([n, l]) => [n, countDistinct(l, (r) => (r.prompt && r.agentId ? r.user : ''))] as const)
  const max = Math.max(0, ...counts.map(([, n]) => n))
  return max ? counts.filter(([, n]) => n === max).map(([n]) => n).join(', ') : ''
}

/** Most Popular Agent Creator (Shared - Agent Builder): creators ranked by distinct prompt users of their agents. */
export function mostPopularCreator(rs: Row[], agents: AgentInfo[]): string {
  const creatorOf = new Map<string, string>()
  for (const a of agents) if (a.typeCombined === 'Agent Builder' && a.creator && a.titleId) creatorOf.set(a.titleId, a.creator)
  const users = new Map<string, Set<string>>()
  for (const r of rs) {
    if (!r.prompt || !r.agentId || !r.user) continue
    const c = creatorOf.get(r.link)
    if (!c) continue
    let s = users.get(c)
    if (!s) users.set(c, (s = new Set()))
    s.add(r.user)
  }
  const max = Math.max(0, ...[...users.values()].map((s) => s.size))
  return max ? [...users].filter(([, s]) => s.size === max).map(([c]) => c).sort().join(', ') : ''
}

/** Distinct registry creators behind the agents in use. */
export function activeCreators(rs: Row[], agents: AgentInfo[]): number {
  const creatorOf = new Map(agents.filter((a) => a.titleId && a.creator).map((a) => [a.titleId, a.creator]))
  return countDistinct(rs, (r) => (r.prompt && r.agentId ? (creatorOf.get(r.link) ?? '') : ''))
}

// ---------- Leaderboard helpers ----------

export interface LeaderStats {
  users: number
  sessions: number
  perUser: number
}
export function leader(rs: Row[], lens: Lens): LeaderStats {
  const p = LENS_PRED[lens]
  const users = lens === 'agent' ? promptUsers(rs, isAgent) : activeUsers(rs, p)
  return { users, sessions: sessions(rs, p), perUser: sessionsPerUser(rs, lens) }
}
