import { useMemo } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import { aiTasks, groupBy, isAgent, promptUsers, returnRate, sessions } from '../metrics/core'
import { builtInTenant, estate, LIFECYCLE, linkageNote, registryFreshness, type EstateRow } from '../metrics/agents'
import { BarList } from '../ui/charts'
import { DataTable, type Column } from '../ui/DataTable'
import { dateLabel, int, pct } from '../ui/format'
import { Empty, Kpi, KpiRow, Panel } from '../ui/primitives'
import { COLOR, LIFECYCLE_COLOR } from '../ui/theme'
import { text } from './common'

const P = 'Agent Health'

export function Agents() {
  const { ds, rows, filters, openAgent } = useData()
  const d = useMemo(() => {
    const agents = ds.agents.filter(
      (a) => (!filters.agentType || a.typeLabel === filters.agentType) && (!filters.agent || a.name === filters.agent) && (!filters.creator || a.creator === filters.creator),
    )
    const est = estate(ds, rows, agents)
    const observed = est.filter((e) => e.sessions > 0).length
    const life = LIFECYCLE.map((l) => ({ key: l, label: l, value: est.filter((e) => e.lifecycle === l).length, color: LIFECYCLE_COLOR[l] }))
    const types = [...groupBy(rows.filter(isAgent), (r) => r.agentType || 'Unclassified')].map(([k, rs]) => ({
      key: k,
      label: k,
      value: promptUsers(rs, isAgent),
      hint: `${int(aiTasks(rs))} tasks`,
    }))
    const reviewCount = new Map<string, number>()
    for (const e of est) reviewCount.set(e.review, (reviewCount.get(e.review) ?? 0) + 1)
    const reviews = [...reviewCount].map(([k, n]) => ({ key: k, label: k, value: n }))
    return {
      agents,
      est,
      observed,
      life,
      types,
      reviews,
      sessions: sessions(rows, isAgent),
      ret: returnRate(rows, isAgent),
      fresh: registryFreshness(agents),
      tenant: builtInTenant(agents),
    }
  }, [ds, rows, filters])
  const cols: Column<EstateRow>[] = [
    {
      key: 'name',
      label: 'Agent',
      width: '26%',
      value: (e) => e.agent.name,
      render: (e) => (
        <span className="name-cell">
          <span>{e.agent.name}</span>
          <small>{[e.agent.typeLabel, e.agent.creator].filter(Boolean).join(' · ')}</small>
        </span>
      ),
    },
    { key: 'users', label: 'Users', value: (e) => e.users, fmt: int, align: 'right', bar: COLOR.agent },
    { key: 'orgs', label: 'Orgs', value: (e) => e.orgs, fmt: int, align: 'right', help: gloss('Orgs reached', P) },
    { key: 'sessions', label: 'Sessions', value: (e) => e.sessions, fmt: int, align: 'right' },
    { key: 'ret', label: 'Return rate', value: (e) => e.returnRate, fmt: pct, align: 'right', help: gloss('Return rate', P) },
    { key: 'last', label: 'Last observed', value: (e) => e.lastObserved, render: (e) => (e.lastObserved ? dateLabel(e.lastObserved.slice(0, 10)) : '–'), help: gloss('Last observed activity', P) },
    { key: 'features', label: 'Features', value: (e) => e.agent.features, render: (e) => <span className="clip">{text(e.agent.features)}</span> },
    {
      key: 'lifecycle',
      label: 'Lifecycle',
      value: (e) => e.lifecycle,
      render: (e) => (
        <span className="tag-dot">
          <i style={{ background: LIFECYCLE_COLOR[e.lifecycle] ?? COLOR.inactive }} aria-hidden="true" />
          {e.lifecycle}
        </span>
      ),
    },
    { key: 'review', label: 'Usage review', value: (e) => e.review, help: gloss('Review queue', P) },
  ]
  return (
    <>
      {!ds.agents.length && <Empty>No Agent 365 registry is loaded. Add it to see registry records, lifecycle and usage review.</Empty>}
      <KpiRow>
        <Kpi tone="agent" label="Registry records" value={int(d.agents.length)} help={gloss('Registry records', P)} />
        <Kpi tone="agent" label="Built in your tenant" value={int(d.tenant)} help={gloss('Owner coverage', P)} />
        <Kpi tone="agent" label="With observed activity" value={int(d.observed)} sub={`of ${int(d.est.length)} linked`} help={gloss('Observed in audit', P)} />
        <Kpi tone="agent" label="Observed agent sessions" value={int(d.sessions)} help={gloss('Audit linkage', P)} />
        <Kpi tone="agent" label="Return rate" value={pct(d.ret)} help={gloss('Return rate', P)} />
        <Kpi label="Registry updated" value={d.fresh ? dateLabel(d.fresh.slice(0, 10)) : '–'} help={gloss('Registry snapshot', P)} />
      </KpiRow>
      <Panel title="Agent estate" note="Select an agent for its details" help={gloss('Review queue', P)}>
        <DataTable
          label="Agent estate"
          columns={cols}
          rows={d.est.map((e) => ({ id: e.id, data: e }))}
          initialSort={{ key: 'users', desc: true }}
          onRowClick={(e) => openAgent(e.agent.name)}
          search={(e) => `${e.agent.name} ${e.agent.creator} ${e.agent.typeLabel} ${e.lifecycle} ${e.review}`}
        />
        <p className="panel-foot">{linkageNote(d.observed, d.agents.length)}</p>
      </Panel>
      <div className="grid grid-3">
        <Panel title="Lifecycle" note="Registry records" help={gloss('Unknown evidence', P)}>
          <BarList label="Agents by lifecycle" items={d.life} color={COLOR.agent} keepOrder />
        </Panel>
        <Panel title="Usage review" note="Registry records">
          <BarList label="Agents by usage review" items={d.reviews} color={COLOR.agent} />
        </Panel>
        <Panel title="Active users by agent type" note="With AI tasks" help={gloss('A365 telemetry coverage', P)}>
          <BarList label="Active users by agent type" items={d.types} color={COLOR.agent} />
        </Panel>
      </div>
    </>
  )
}
