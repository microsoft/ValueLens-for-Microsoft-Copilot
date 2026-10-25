import { useMemo, useState } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import { activePair, activation, activationHeadline, roster } from '../metrics/people'
import { aiTasks, countDistinct, groupBy, isAgent, isCowork, isU, LENS_LABEL, LENS_PRED, lensUsers, returnRate, sessions, sessionsPerUser, sessionsPerUserPerWeek, type Lens } from '../metrics/core'
import { activeCreators, leader, mostPopularCreator, mostVersatile } from '../metrics/agents'
import { topOutcome, valueMeasures } from '../metrics/value'
import { HEAT_LABEL, heatHeadline, heatValue, type HeatMetric } from '../metrics/heatmap'
import { pivot } from '../metrics/pivot'
import type { Row } from '../data/types'
import { BarList, Distribution, LineChart } from '../ui/charts'
import { HeatGrid, Headline, Tornado } from '../ui/extra-charts'
import { DataTable, type Column } from '../ui/DataTable'
import { dateLabel, dayLabel, dec1, dec2, int, pct } from '../ui/format'
import { Empty, Kpi, KpiRow, Panel, Segmented } from '../ui/primitives'
import { COLOR } from '../ui/theme'
import { labelCol, measureCol, searchText, usePersonLabel } from './cols'
import { DRAFT_AGENT, text, useValueInputs } from './common'

type ActLens = Exclude<Lens, 'cowork'>
const ACT_LENSES: { id: ActLens; label: string }[] = [
  { id: 'overall', label: 'All users' },
  { id: 'licensed', label: 'Licensed' },
  { id: 'unlicensed', label: 'Unlicensed' },
  { id: 'agent', label: 'Agent users' },
]
const ALL_LENSES: { id: Lens; label: string }[] = [...ACT_LENSES, { id: 'cowork', label: 'Cowork' }]
const LENS_COLOR: Record<Lens, string> = {
  overall: COLOR.neutral,
  licensed: COLOR.licensed,
  unlicensed: COLOR.unlicensed,
  agent: COLOR.agent,
  cowork: COLOR.cowork,
}
const LENS_TONE: Record<Lens, 'neutral' | 'licensed' | 'unlicensed' | 'agent' | 'cowork'> = {
  overall: 'neutral',
  licensed: 'licensed',
  unlicensed: 'unlicensed',
  agent: 'agent',
  cowork: 'cowork',
}

function LensPicker<T extends string>(props: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="lens-bar">
      <span className="lens-label">Show</span>
      <Segmented label="Population" value={props.value} options={props.options} onChange={props.onChange} />
    </div>
  )
}

// ---------- Activation ----------

export function AdoptionActivation() {
  const { ds, base, filters } = useData()
  const [lens, setLens] = useState<ActLens>('overall')
  const d = useMemo(() => {
    const a = activation(base, roster(ds, filters.org))
    const byOrg = [...groupBy(base, (r) => r.org)].filter(([o]) => o)
    const orgs = new Set([...byOrg.map(([o]) => o), ...[...ds.people.values()].map((p) => p.org).filter(Boolean)])
    const rowsByOrg = new Map(byOrg)
    const tornado = [...orgs]
      .filter((o) => !filters.org || o === filters.org)
      .map((o) => {
        const p = activePair(activation(rowsByOrg.get(o) ?? [], roster(ds, o)), lens)
        return { key: o, left: p.inactive, right: p.active }
      })
      .filter((x) => (Number.isFinite(x.left) ? x.left : 0) + (Number.isFinite(x.right) ? x.right : 0) > 0)
      .sort((x, y) => (y.right || 0) + (y.left || 0) - ((x.right || 0) + (x.left || 0)))
    return { a, pair: activePair(a, lens), tornado }
  }, [base, ds, filters.org, lens])
  const { a, pair } = d
  const P = 'Activation'
  const kpis: [string, number, string, 'neutral' | 'licensed' | 'unlicensed' | 'agent'][] =
    lens === 'licensed'
      ? [
          ['Licensed users', a.licensed, int(a.licensed), 'licensed'],
          ['Active licensed users', pair.active, int(pair.active), 'licensed'],
          ['% active licensed', pair.active / a.licensed, pct(pair.active / a.licensed), 'licensed'],
        ]
      : lens === 'unlicensed'
        ? [
            ['Unlicensed users', a.unlicensed, int(a.unlicensed), 'unlicensed'],
            ['Active unlicensed users', pair.active, int(pair.active), 'unlicensed'],
            ['% active unlicensed', pair.active / a.unlicensed, pct(pair.active / a.unlicensed), 'unlicensed'],
          ]
        : lens === 'agent'
          ? [
              ['All active users', a.active, int(a.active), 'agent'],
              ['Active agent users', a.agentUsers, int(a.agentUsers), 'agent'],
              ['% of active users using agents', a.agentUsers / a.active, pct(a.agentUsers / a.active), 'agent'],
            ]
          : [
              ['Total users', a.total, int(a.total), 'neutral'],
              ['% active', a.active / a.total, pct(a.active / a.total), 'neutral'],
              ['% inactive', 1 - a.active / a.total, pct(a.total ? 1 - a.active / a.total : NaN), 'neutral'],
            ]
  return (
    <>
      <LensPicker value={lens} options={ACT_LENSES} onChange={setLens} />
      <Headline lines={[activationHeadline(a, lens)]} />
      {!ds.hasUsers && lens !== 'agent' ? (
        <Empty>No organisation and licences file is loaded. Add it to see total users, licensed users and % active.</Empty>
      ) : (
        <KpiRow>
          {kpis.map(([label, , value, tone]) => (
            <Kpi key={label} label={label} value={value} tone={tone} help={gloss(label.startsWith('%') ? 'Licensed utilisation' : 'Active users', P)} />
          ))}
          <Kpi label={pair.inactiveLabel} value={int(pair.inactive)} help={gloss('Inactive licensed users', P)} />
        </KpiRow>
      )}
      <div className="grid grid-2-1">
        <Panel title="Active and inactive users by organisation" note={`${pair.inactiveLabel} on the left, ${pair.activeLabel.toLowerCase()} on the right`} help={gloss('Active users', P)}>
          <Tornado
            label="Active and inactive users by organisation"
            data={d.tornado}
            left={{ name: pair.inactiveLabel, color: COLOR.inactive }}
            right={{ name: pair.activeLabel, color: LENS_COLOR[lens] }}
          />
        </Panel>
        <Panel title="Active vs inactive" note={LENS_LABEL[lens]}>
          <Distribution
            label="Active and inactive users"
            items={[
              { label: pair.activeLabel, value: pair.active, color: LENS_COLOR[lens] },
              { label: pair.inactiveLabel, value: pair.inactive, color: COLOR.inactive },
            ]}
          />
          {!a.usable && lens !== 'overall' && lens !== 'agent' && (
            <p className="panel-foot">The licence list does not reconcile with the active licensed users in the audit, so licensed and unlicensed totals are hidden.</p>
          )}
        </Panel>
      </div>
    </>
  )
}

// ---------- Usage ----------

const behaviourKey: Record<Lens, (r: Row) => string> = {
  overall: (r) => r.beh,
  licensed: (r) => r.beh,
  unlicensed: (r) => r.plausible,
  cowork: (r) => r.coworkCat,
  agent: (r) => r.agent,
}
const behaviourTitle: Record<Lens, string> = {
  overall: 'Activity by behaviour',
  licensed: 'Activity by behaviour',
  unlicensed: 'Activity by plausible behaviour',
  cowork: 'Cowork activity by task category',
  agent: 'Agent tasks by agent',
}

export function AdoptionUsage() {
  const { ds, base, assumptions, openAgent } = useData()
  const v = useValueInputs()
  const [lens, setLens] = useState<Lens>('overall')
  const P = 'Adoption'
  const d = useMemo(() => {
    const p = LENS_PRED[lens]
    const lr = base.filter(p)
    const key = behaviourKey[lens]
    const beh = [...groupBy(lr, key)]
      .filter(([k, rs]) => k && (lens !== 'agent' || countDistinct(rs, (r) => (r.prompt ? r.user : '')) >= 2))
      .map(([k, rs]) => ({ key: k, label: k, value: aiTasks(rs) }))
      .filter((x) => x.value > 0)
    const bands = [...groupBy(lr.filter((r) => r.observed && r.t.band), (r) => r.t.band)]
      .map(([k, rs]) => ({ key: k, label: k, value: sessions(rs), sort: rs[0].t.bandSort }))
      .sort((x, y) => x.sort - y.sort)
    const orgs = [...groupBy(base, (r) => r.org)]
      .filter(([o]) => o)
      .map(([o, rs]) => ({ key: o, label: o, value: sessionsPerUser(rs, lens), hint: `${int(lensUsers(rs, lens))} users` }))
    const weekly = [...groupBy(base, (r) => r.week)]
      .filter(([w]) => w)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([w, rs]) => ({ key: w, values: (['licensed', 'unlicensed', 'agent', 'cowork'] as Lens[]).map((l) => sessionsPerUser(rs, l)) }))
    const agentRows = base.filter(isAgent)
    return {
      top: topOutcome(lr, ds.rows, assumptions.scenario),
      users: lensUsers(base, lens),
      spupw: sessionsPerUserPerWeek(base, lens),
      sessions: sessions(base, p),
      eehpw: valueMeasures(lr, v).hoursPerWeek,
      beh,
      bands,
      orgs,
      weekly,
      agents: {
        distinct: countDistinct(agentRows, (r) => (r.prompt ? r.agent : '')),
        users: lensUsers(base, 'agent'),
        creators: activeCreators(base, ds.agents),
        spupw: sessionsPerUserPerWeek(base, 'agent'),
        ret: returnRate(base, isAgent),
        creator: mostPopularCreator(base, ds.agents),
      },
    }
  }, [base, ds, lens, assumptions.scenario, v])
  return (
    <>
      <LensPicker value={lens} options={ALL_LENSES} onChange={setLens} />
      <KpiRow>
        <Kpi tone={LENS_TONE[lens]} label={lens === 'cowork' ? 'Top Cowork task' : 'Top value outcome'} value={text(d.top)} help={gloss('Task classification', 'Activity')} wide />
        <Kpi tone={LENS_TONE[lens]} label="Active users" value={int(d.users)} sub={LENS_LABEL[lens]} help={gloss('Sessions / active user', P)} />
        <Kpi tone={LENS_TONE[lens]} label="Sessions per user per week" value={dec1(d.spupw)} help={gloss('Sessions / user / week', P)} />
        <Kpi tone={LENS_TONE[lens]} label="Observed sessions" value={int(d.sessions)} help={gloss('Tasks and sessions', P)} />
        <Kpi tone={LENS_TONE[lens]} label="Expert-equivalent hours per week" value={int(d.eehpw)} help={gloss('Estimated time saved', 'Value')} />
      </KpiRow>
      {lens === 'agent' && (
        <KpiRow>
          <Kpi tone="agent" label="Agents used" value={int(d.agents.distinct)} />
          <Kpi tone="agent" label="Agent users" value={int(d.agents.users)} />
          <Kpi tone="agent" label="Active creators" value={int(d.agents.creators)} />
          <Kpi tone="agent" label="Agent sessions per user per week" value={dec1(d.agents.spupw)} />
          <Kpi tone="agent" label="Return rate" value={pct(d.agents.ret)} help={gloss('Return rate', 'Agent Health')} />
          <Kpi tone="agent" label="Most popular creator" value={text(d.agents.creator)} wide />
        </KpiRow>
      )}
      <Panel title="Sessions per active user, by week" note="Each population on the same scale" help={gloss('Sessions / active user', P)}>
        <LineChart
          label="Sessions per active user by week"
          data={d.weekly}
          xFmt={dayLabel}
          series={[
            { name: 'Licensed', color: COLOR.licensed, fmt: dec2 },
            { name: 'Unlicensed', color: COLOR.unlicensed, fmt: dec2 },
            { name: 'Agents', color: COLOR.agent, fmt: dec2 },
            { name: 'Cowork', color: COLOR.cowork, fmt: dec2 },
          ]}
        />
      </Panel>
      <div className="grid grid-2">
        <Panel title={behaviourTitle[lens]} note={lens === 'agent' ? 'AI tasks; agents with 2+ users. Select one for details' : 'AI tasks'} help={gloss('Task volume', 'Activity')}>
          <BarList label={behaviourTitle[lens]} items={d.beh} color={LENS_COLOR[lens]} limit={10} onSelect={lens === 'agent' ? (k) => openAgent(k) : undefined} />
        </Panel>
        <Panel title="Sessions per user by organisation" note={LENS_LABEL[lens]} help={gloss('Sessions / active user', P)}>
          <BarList label="Sessions per user by organisation" items={d.orgs} color={LENS_COLOR[lens]} fmt={dec2} limit={10} />
        </Panel>
      </div>
      <Panel title="Sessions by conversation depth" note="Prompts per session" help={gloss('Conversation depth', P)}>
        <BarList label="Sessions by conversation depth" items={d.bands} color={LENS_COLOR[lens]} keepOrder />
      </Panel>
    </>
  )
}

// ---------- Heatmap ----------

const HEAT_METRICS: HeatMetric[] = ['users', 'days', 'hours', 'sessions']

export function AdoptionHeatmap() {
  const { ds, rows, assumptions } = useData()
  const [m, setM] = useState<HeatMetric>('users')
  const d = useMemo(() => {
    const cells = new Map<string, number>()
    const weeks = [...new Set(rows.map((r) => r.week).filter(Boolean))].sort()
    const byOrg = [...groupBy(rows, (r) => r.org)].filter(([o]) => o)
    const totals: { org: string; value: number }[] = []
    for (const [o, ors] of byOrg) {
      let any = false
      for (const [w, wrs] of groupBy(ors, (r) => r.week)) {
        const v = heatValue(wrs, m, ds.rows, assumptions.scenario)
        cells.set(`${o}|${w}`, v)
        if (v > 0) any = true
      }
      if (any) totals.push({ org: o, value: heatValue(ors, m, ds.rows, assumptions.scenario) })
    }
    totals.sort((a, b) => b.value - a.value)
    return { cells, weeks, orgs: totals.map((t) => t.org), headline: heatHeadline(totals, m) }
  }, [rows, ds, m, assumptions.scenario])
  const fmt = m === 'days' ? dec1 : int
  return (
    <>
      <div className="lens-bar">
        <span className="lens-label">Measure</span>
        <Segmented label="Heatmap measure" value={m} options={HEAT_METRICS.map((id) => ({ id, label: HEAT_LABEL[id] }))} onChange={setM} />
      </div>
      <Headline lines={[d.headline]} />
      <Panel title={`${HEAT_LABEL[m]} by organisation and week`} note="Darker cells mean more activity" help={gloss('Heatmap shading', 'Heatmap')}>
        <HeatGrid label={`${HEAT_LABEL[m]} by organisation and week`} rows={d.orgs} cols={d.weeks} value={(r, c) => d.cells.get(`${r}|${c}`) ?? NaN} colFmt={dayLabel} fmt={fmt} />
        <p className="panel-foot">{gloss('Selected metric', 'Heatmap')}</p>
      </Panel>
    </>
  )
}

// ---------- Leaderboard ----------

interface AgentLead {
  label: string
  creator: string
  users: number
  sessions: number
  perUser: number
  ret: number
}

const LEAD_NOTE: Record<Lens, string> = {
  overall: 'Every active user. Security Copilot is excluded, as in the report.',
  licensed: 'Users with an M365 Copilot licence.',
  unlicensed: 'Users of Copilot Chat without a licence. Security Copilot is excluded.',
  cowork: 'Cowork sessions only, grouped by task.',
  agent: 'Agent sessions only. Draft first-party agents are excluded.',
}

export function AdoptionLeaderboard() {
  const { ds, base, filters } = useData()
  const person = usePersonLabel()
  const [lens, setLens] = useState<Lens>('overall')
  const P = 'Leaderboard'
  const d = useMemo(() => {
    const p = LENS_PRED[lens]
    const scoped = lens === 'overall' || lens === 'unlicensed' ? base.filter((r) => r.host !== 'Security Copilot') : base
    const lr = scoped.filter(p)
    const measures = {
      users: (rs: Row[]) => lensUsers(rs, lens),
      sessions: (rs: Row[]) => sessions(rs, p),
      spupw: (rs: Row[]) => sessionsPerUserPerWeek(rs, lens),
    }
    const orgTable = pivot(lr, (r) => r.org, (r) => r.user, person, measures, (rs) => sessions(rs, p) > 0)
    const taskMeasures = { tasks: (rs: Row[]) => aiTasks(rs), sessions: (rs: Row[]) => sessions(rs), users: (rs: Row[]) => lensUsers(rs, lens) }
    const right =
      lens === 'cowork'
        ? pivot(lr, (r) => r.taskGroup || 'Unclassified', (r) => r.taskCat || 'Unclassified', (k) => ({ label: k }), taskMeasures, (rs) => aiTasks(rs) > 0)
        : lens === 'agent'
          ? null
          : pivot(lr, (r) => r.host || 'Unknown app', (r) => r.beh || 'Unclassified', (k) => ({ label: k }), taskMeasures, (rs) => aiTasks(rs) > 0)
    const byAgent = new Map(ds.agents.map((a) => [a.name, a.creator]))
    const agents = [...groupBy(lr.filter((r) => r.agent && r.agent !== DRAFT_AGENT), (r) => r.agent)].map(([k, rs]) => {
      const l = leader(rs, 'agent')
      return { id: k, data: { label: k, creator: byAgent.get(k) ?? '', users: l.users, sessions: l.sessions, perUser: l.perUser, ret: returnRate(rs, isAgent) } }
    })
    const lead = leader(base, lens)
    const a = activation(base, roster(ds, filters.org))
    return {
      lead,
      spupw: sessionsPerUserPerWeek(base, lens),
      pctActive: a.activeL / a.licensed,
      unlicTasks: aiTasks(base, isU),
      coworkTasks: aiTasks(base, isCowork),
      agentTasks: aiTasks(base, isAgent),
      agentReturn: returnRate(base, isAgent),
      versatile: mostVersatile(base),
      creator: mostPopularCreator(base, ds.agents),
      orgTable,
      right,
      agents,
    }
  }, [base, ds, filters.org, lens, person])
  const tone = LENS_TONE[lens]
  const color = LENS_COLOR[lens]
  const agentCols: Column<AgentLead>[] = [
    { key: 'label', label: 'Agent', width: '30%', value: (r) => r.label, render: (r) => <span className="name-cell"><span>{r.label}</span>{r.creator && <small>{r.creator}</small>}</span> },
    { key: 'users', label: 'Users', value: (r) => r.users, fmt: int, bar: COLOR.agent, align: 'right' },
    { key: 'sessions', label: 'Sessions', value: (r) => r.sessions, fmt: int, align: 'right' },
    { key: 'perUser', label: 'Sessions per user', value: (r) => r.perUser, fmt: dec1, align: 'right' },
    { key: 'ret', label: 'Return rate', value: (r) => r.ret, fmt: pct, align: 'right', help: gloss('Return rate', 'Agent Health') },
  ]
  return (
    <>
      <LensPicker value={lens} options={ALL_LENSES} onChange={setLens} />
      <KpiRow>
        <Kpi tone={tone} label="Active users" value={int(d.lead.users)} help={gloss('Absolute activity', P)} />
        {lens === 'agent' && <Kpi tone={tone} label="Agent tasks" value={int(d.agentTasks)} />}
        <Kpi tone={tone} label="Sessions" value={int(d.lead.sessions)} help={gloss('Absolute activity', P)} />
        <Kpi tone={tone} label="Sessions per user" value={dec1(d.lead.perUser)} help={gloss('Per-user intensity', P)} />
        {lens === 'agent' ? (
          <>
            <Kpi tone={tone} label="Return rate" value={pct(d.agentReturn)} help={gloss('Return rate', 'Agent Health')} />
            <Kpi tone={tone} label="Most versatile agent" value={text(d.versatile)} wide />
            <Kpi tone={tone} label="Most popular creator" value={text(d.creator)} wide />
          </>
        ) : (
          <Kpi tone={tone} label="Sessions per user per week" value={dec1(d.spupw)} help={gloss('Per-user intensity', P)} />
        )}
        {lens === 'licensed' && <Kpi tone={tone} label="% of licensed users active" value={pct(d.pctActive)} />}
        {lens === 'unlicensed' && <Kpi tone={tone} label="Unlicensed tasks" value={int(d.unlicTasks)} />}
        {lens === 'cowork' && <Kpi tone={tone} label="Cowork tasks" value={int(d.coworkTasks)} />}
      </KpiRow>
      <p className="section-note">{LEAD_NOTE[lens]}</p>
      <div className="grid grid-2">
        <Panel title="Organisations and people" note="Expand an organisation to see its people" help={gloss('Cohort bookmarks', P)}>
          <DataTable
            label="Organisation leaderboard"
            columns={[labelCol('Organisation / person'), measureCol('users', 'Users', int, color), measureCol('sessions', 'Sessions', int), measureCol('spupw', 'Sessions / user / week', dec1)]}
            rows={d.orgTable}
            initialSort={{ key: 'sessions', desc: true }}
            search={searchText}
            childNoun="organisations or people"
          />
        </Panel>
        {d.right ? (
          <Panel title={lens === 'cowork' ? 'Cowork tasks' : 'Apps and behaviours'} note={lens === 'cowork' ? 'Task group, then task' : 'App, then behaviour'}>
            <DataTable
              label={lens === 'cowork' ? 'Cowork task leaderboard' : 'App leaderboard'}
              columns={[labelCol(lens === 'cowork' ? 'Task group / task' : 'App / behaviour'), measureCol('tasks', 'AI tasks', int, color), measureCol('sessions', 'Sessions', int), measureCol('users', 'Users', int)]}
              rows={d.right}
              initialSort={{ key: 'tasks', desc: true }}
              search={searchText}
              childNoun="rows"
            />
          </Panel>
        ) : (
          <Panel title="Agent leaderboard" note="Agent, with its creator">
            <DataTable label="Agent leaderboard" columns={agentCols} rows={d.agents} initialSort={{ key: 'users', desc: true }} search={(r) => `${r.label} ${r.creator}`} />
          </Panel>
        )}
      </div>
      <p className="section-note">Data to {dateLabel(ds.maxDate)}.</p>
    </>
  )
}
