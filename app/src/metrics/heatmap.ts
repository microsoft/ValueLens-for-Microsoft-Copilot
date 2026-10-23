import type { Row, Scenario } from '../data/types'
import { activeUsers, countDistinct, groupBy, mean, ratio, sessionsPerUser } from './core'
import { eeh } from './value'

// ---------- Heatmap ----------

export type HeatMetric = 'users' | 'days' | 'hours' | 'sessions'
export const HEAT_LABEL: Record<HeatMetric, string> = {
  users: 'Active Users',
  days: 'Active Days / User',
  hours: 'Modeled Hours / User',
  sessions: 'Sessions / User',
}

export function heatValue(rs: Row[], m: HeatMetric, all: Row[], s: Scenario): number {
  switch (m) {
    case 'users':
      return activeUsers(rs)
    case 'days': {
      const per = groupBy(
        rs.filter((r) => r.user),
        (r) => r.user,
      )
      return mean([...per.values()].map((l) => countDistinct(l, (r) => (r.prompt ? r.date : ''))))
    }
    case 'hours':
      return ratio(eeh(rs, all, s), countDistinct(rs, (r) => r.user)) || 0
    default:
      return sessionsPerUser(rs)
  }
}

export function heatHeadline(byOrg: { org: string; value: number }[], m: HeatMetric): string {
  const active = byOrg.filter((o) => o.value > 0)
  if (!active.length) return 'No activity in the current selection.'
  const lead = [...active].sort((a, b) => b.value - a.value || a.org.localeCompare(b.org))[0]
  const v = m === 'users' ? Math.round(lead.value).toLocaleString('en-GB') : lead.value.toFixed(1)
  return `${HEAT_LABEL[m]}: ${lead.org} leads at ${v} across ${active.length.toLocaleString('en-GB')} active teams.`
}
