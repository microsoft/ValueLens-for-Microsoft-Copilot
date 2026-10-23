import { useMemo } from 'react'
import { useData } from '../data/store'
import { isAgent, promptUsers, series } from '../metrics/core'
import { agentStats, lastSeenByName, lifecycle, usageReview } from '../metrics/agents'
import { LineChart } from './charts'
import { DASH, dateLabel, dayLabel, int, pct } from './format'
import { Sheet } from './Sheet'
import { COLOR } from './theme'

/** Agent detail: the PBI "Agent Details" cards that react to a selected agent. */
export function AgentDrawer({ name, onClose }: { name: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!name} onClose={onClose} title={name ?? ''} side>
      {name && <AgentDetail name={name} />}
    </Sheet>
  )
}

function AgentDetail({ name }: { name: string }) {
  const { ds, base } = useData()
  const reg = useMemo(() => ds.agents.find((a) => a.name === name) ?? null, [ds, name])
  const d = useMemo(() => {
    const own = (r: (typeof base)[number]) => isAgent(r) && (reg?.titleId ? r.link === reg.titleId : r.agent === name)
    const rs = base.filter(own)
    const all = ds.rows.filter(own)
    const allUsers = promptUsers(all, isAgent)
    return {
      st: agentStats(rs),
      weekly: series(rs, (r) => r.week, [(l) => promptUsers(l, isAgent)]),
      allUsers,
      lastSeen: lastSeenByName(ds.rows).get(name) ?? '',
    }
  }, [base, ds, name, reg])
  return (
    <div className="detail">
      {reg ? (
        <>
          <p className="detail-type">
            {reg.typeLabel || reg.typeCombined || 'Agent'}
            <span className="review-tag">{lifecycle(reg, d.allUsers)}</span>
            <span className="review-tag">{usageReview(reg, d.allUsers, d.lastSeen, ds.maxCreation)}</span>
          </p>
          {reg.description && <p className="detail-desc">{reg.description}</p>}
        </>
      ) : (
        <p className="detail-desc">This agent isn't in the agent registry export, so only usage is shown.</p>
      )}
      <h3>In the selected period</h3>
      <dl className="stat-grid">
        <div>
          <dt>Users</dt>
          <dd>{int(d.st.users)}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{int(d.st.sessions)}</dd>
        </div>
        <div>
          <dt>Return rate</dt>
          <dd>{pct(d.st.returnRate)}</dd>
        </div>
      </dl>
      {d.weekly.length > 1 && (
        <LineChart label={`Weekly users of ${name}`} data={d.weekly} series={[{ name: 'Users', color: COLOR.agent, fmt: int }]} xFmt={dayLabel} height={140} area />
      )}
      <h3>Details</h3>
      <dl className="kv">
        <dt>Organisations</dt>
        <dd>{int(d.st.orgs)}</dd>
        <dt>Last observed</dt>
        <dd>{d.lastSeen ? dateLabel(d.lastSeen) : 'Not seen in the audit data'}</dd>
        {reg && (
          <>
            <dt>Total users</dt>
            <dd>
              {int(reg.totalUsers ?? d.allUsers)}
              {reg.totalUsers === null && <small> observed in the audit data</small>}
            </dd>
            <dt>Creator</dt>
            <dd>{reg.creator || DASH}</dd>
            <dt>Built in</dt>
            <dd>{reg.createdIn || DASH}</dd>
            <dt>Works in</dt>
            <dd>{reg.supportedIn || DASH}</dd>
            <dt>Status</dt>
            <dd>{reg.blocked ? 'Blocked by admin' : reg.status || DASH}</dd>
            <dt>Features</dt>
            <dd>{reg.features || DASH}</dd>
            <dt>Registry updated</dt>
            <dd>{reg.lastUpdated ? dateLabel(reg.lastUpdated) : DASH}</dd>
          </>
        )}
      </dl>
    </div>
  )
}
