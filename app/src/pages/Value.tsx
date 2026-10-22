import { useMemo, useState } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import { activeUsers, aiTasks, groupBy, isAgent, promptUsers, sessions } from '../metrics/core'
import { activityShare, BEHAVIOURS, eeh, ESTIMATES, executiveHeadline, licenceInvestment, skillsHeadline, topOrg, usersInCategory, valueMeasures, type Behaviour, type Estimate } from '../metrics/value'
import { flat, pivot } from '../metrics/pivot'
import type { Row } from '../data/types'
import { BarList, LineChart } from '../ui/charts'
import { Headline } from '../ui/extra-charts'
import { DataTable, type Column } from '../ui/DataTable'
import { dayLabel, dec1, int, pct } from '../ui/format'
import { Kpi, KpiRow, Panel, Select } from '../ui/primitives'
import { COLOR } from '../ui/theme'
import { labelCol, measureCol, searchText } from './cols'
import { DRAFT_AGENT, useMoney, useValueInputs } from './common'

const P = 'Value'
const PA = 'Activity'

function AssumptionsLine() {
  const { assumptions, openAssumptions } = useData()
  return (
    <p className="section-note">
      Valued at {assumptions.currency}
      {assumptions.hourly} an hour, {assumptions.scenario.toLowerCase()} effort, licence {assumptions.currency}
      {assumptions.ppupm} per user per month.{' '}
      <button type="button" className="link-btn" onClick={openAssumptions}>
        Change assumptions
      </button>
    </p>
  )
}

function SideTables({ rows }: { rows: Row[] }) {
  const d = useMemo(
    () => ({
      orgs: flat(rows, (r) => r.org, { users: (rs) => activeUsers(rs), sessions: (rs) => sessions(rs) }, (rs) => activeUsers(rs) > 0),
      agents: flat(
        rows.filter((r) => r.agent && r.agent !== DRAFT_AGENT),
        (r) => r.agent,
        { users: (rs) => promptUsers(rs, isAgent), sessions: (rs) => sessions(rs, isAgent) },
        (rs) => promptUsers(rs, isAgent) > 0,
      ),
    }),
    [rows],
  )
  return (
    <div className="grid grid-2">
      <Panel title="Organisations" note="Active users and sessions">
        <DataTable label="Users by organisation" columns={[labelCol('Organisation', '46%'), measureCol('users', 'Users', int, COLOR.licensed), measureCol('sessions', 'Sessions', int)]} rows={d.orgs} initialSort={{ key: 'users', desc: true }} pageSize={8} />
      </Panel>
      <Panel title="Agents" note="Agent users and sessions">
        <DataTable label="Users by agent" columns={[labelCol('Agent', '46%'), measureCol('users', 'Users', int, COLOR.agent), measureCol('sessions', 'Sessions', int)]} rows={d.agents} initialSort={{ key: 'users', desc: true }} pageSize={8} search={searchText} />
      </Panel>
    </div>
  )
}

// ---------- Tasks ----------

export function ValueTasks() {
  const { rows, filters } = useData()
  const v = useValueInputs()
  const money = useMoney()
  const d = useMemo(() => {
    const total = aiTasks(rows)
    const m = valueMeasures(rows, v)
    const weekly = [...groupBy(rows, (r) => r.week)]
      .filter(([w]) => w)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([w, rs]) => ({ key: w, values: [valueMeasures(rs, v).value, licenceInvestment(rs, v.ppupm)] }))
    const engage = [...groupBy(rows, (r) => r.engage)]
      .filter(([k]) => k)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, rs]) => ({ key: k, label: k, value: activityShare(rs, total), hint: `Top org: ${topOrg(rs) || '–'}` }))
    const models = [...groupBy(rows, (r) => r.model)]
      .filter(([k]) => k)
      .map(([k, rs]) => ({ key: k, label: k, value: aiTasks(rs), hint: `${int(sessions(rs))} sessions` }))
      .filter((x) => x.value > 0)
    const cats = [...groupBy(rows, (r) => r.taskCat)].filter(([k]) => k).map(([k, rs]) => ({ key: k, label: k, value: activityShare(rs, total) }))
    const withTop = (items: { key: string; value: number }[], key: (r: Row) => string) => {
      const g = groupBy(rows, key)
      return items.map((i) => ({ ...i, label: i.key, hint: `Top org: ${topOrg(g.get(i.key) ?? []) || '–'}` }))
    }
    const table = pivot(
      rows,
      (r) => r.outcome || 'Unclassified',
      (r) => r.taskCat || 'Unclassified',
      (k) => ({ label: k }),
      {
        share: (rs) => activityShare(rs, total),
        eehpw: (rs) => eeh(rs, v.all, v.scenario) / (v.windowWeeks || 1),
        valuepw: (rs) => valueMeasures(rs, v).valuePerWeek,
      },
      (rs) => aiTasks(rs) > 0,
    )
    return {
      m,
      exec: executiveHeadline(rows, v),
      skills: skillsHeadline(rows, { cowork: filters.tool === 'Cowork', agent: filters.tool === 'Agents', lic: filters.lic }),
      weekly,
      engage,
      models,
      cats,
      roles: withTop(usersInCategory(rows, (r) => r.roleAll), (r) => r.roleAll),
      eff: withTop(usersInCategory(rows, (r) => r.eff), (r) => r.eff),
      table,
    }
  }, [rows, v, filters.tool, filters.lic])
  return (
    <>
      <div className="grid grid-2">
        <Headline lines={d.exec} />
        <Headline lines={d.skills} />
      </div>
      <KpiRow>
        <Kpi tone="licensed" label="Expert-equivalent hours" value={int(d.m.hours)} help={gloss('Estimated time saved', P)} />
        <Kpi tone="licensed" label="AI-assisted value" value={money(d.m.value)} help={gloss('Estimated value / ROI', P)} />
        <Kpi tone="licensed" label="Projected annual value" value={money(d.m.annualised)} help={gloss('Estimated value / ROI', P)} />
        <Kpi tone={d.m.roi >= 0 ? 'licensed' : 'unlicensed'} label="Net ROI" value={money(d.m.roi)} sub={`after ${money(d.m.investment)} licences`} help={gloss('No discount factors', P)} />
      </KpiRow>
      <AssumptionsLine />
      <Panel title="AI-assisted value vs licence investment, by week" help={gloss('AI Assisted Value basis', P)}>
        <LineChart
          label="AI-assisted value and licence investment by week"
          data={d.weekly}
          xFmt={dayLabel}
          series={[
            { name: 'AI-assisted value', color: COLOR.licensed, fmt: money },
            { name: 'Licence investment', color: COLOR.unlicensed, fmt: money },
          ]}
        />
      </Panel>
      <div className="grid grid-2">
        <Panel title="How people engage with Copilot" note="Share of AI tasks" help={gloss('How deeply AI engaged', PA)}>
          <BarList label="Share of activity by engagement mode" items={d.engage} color={COLOR.licensed} fmt={pct} keepOrder />
        </Panel>
        <Panel title="Tasks by AI model" note="AI tasks" help={gloss('Model cost tier', 'Model Mix')}>
          <BarList label="AI tasks by model" items={d.models} color={COLOR.neutral} limit={8} />
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Task breakdown" note="Share of AI tasks" help={gloss('Share of activity', PA)}>
          <BarList label="Share of AI tasks by task category" items={d.cats} color={COLOR.licensed} fmt={pct} limit={10} />
        </Panel>
        <Panel title="What new skills are being unlocked?" note="Share of active users reaching each role" help={gloss('Task classification', PA)}>
          <BarList label="Share of users by expertise role" items={d.roles} color={COLOR.agent} fmt={pct} limit={10} />
        </Panel>
      </div>
      <div className="grid grid-1-2">
        <Panel title="What is AI producing?" note="Share of active users" help={gloss('Which breakdown dimension is used', PA)}>
          <BarList label="Share of users by efficiency breakdown" items={d.eff} color={COLOR.cowork} fmt={pct} />
        </Panel>
        <Panel title="Copilot value table" note="Value outcome, then task" help={gloss('Task Category', P)}>
          <DataTable
            label="Value by outcome and task"
            columns={[labelCol('Outcome / task'), measureCol('share', 'Activity share', pct, COLOR.licensed), measureCol('eehpw', 'Hours / week', dec1), measureCol('valuepw', 'Value / week', money)]}
            rows={d.table}
            initialSort={{ key: 'share', desc: true }}
            search={searchText}
            childNoun="outcomes or tasks"
          />
        </Panel>
      </div>
      <SideTables rows={rows} />
    </>
  )
}

// ---------- Estimated value ----------

export function ValueEstimated() {
  const { rows } = useData()
  const v = useValueInputs()
  const money = useMoney()
  const d = useMemo(() => {
    const total = aiTasks(rows)
    const hpw = (rs: Row[]) => eeh(rs, v.all, v.scenario) / (v.windowWeeks || 1)
    return {
      m: valueMeasures(rows, v),
      where: [...groupBy(rows, (r) => r.taskCat)]
        .filter(([k]) => k)
        .map(([k, rs]) => ({ key: k, label: k, value: hpw(rs) }))
        .filter((x) => x.value > 0),
      table: pivot(
        rows,
        (r) => r.taskGroup || 'Unclassified',
        (r) => r.taskCat || 'Unclassified',
        (k) => ({ label: k }),
        { share: (rs) => activityShare(rs, total), eehpw: hpw, valuepw: (rs) => valueMeasures(rs, v).valuePerWeek },
        (rs) => aiTasks(rs) > 0,
      ),
    }
  }, [rows, v])
  return (
    <>
      <KpiRow>
        <Kpi tone="licensed" label="Expert-equivalent hours per week" value={int(d.m.hoursPerWeek)} sub={`${dec1(d.m.hoursPerUser)} hours per user in total`} help={gloss('Estimated time saved', P)} />
        <Kpi tone="licensed" label="AI-assisted value" value={money(d.m.value)} sub={`${money(d.m.valuePerWeek)} per week`} help={gloss('Estimated value / ROI', P)} />
        <Kpi tone="licensed" label="Projected annual value" value={money(d.m.annualised)} help={gloss('Estimated value / ROI', P)} />
      </KpiRow>
      <AssumptionsLine />
      <div className="grid grid-1-2">
        <Panel title="Where is time being saved?" note="Expert-equivalent hours per week" help={gloss('Hours: one consistent basis', P)}>
          <BarList label="Hours saved per week by task category" items={d.where} color={COLOR.licensed} fmt={dec1} limit={12} />
        </Panel>
        <Panel title="Copilot value table" note="Task group, then task" help={gloss('Why some activities count more than once', P)}>
          <DataTable
            label="Value by task group and task"
            columns={[labelCol('Task group / task'), measureCol('share', 'Activity share', pct, COLOR.licensed), measureCol('eehpw', 'Hours / week', dec1), measureCol('valuepw', 'Value / week', money)]}
            rows={d.table}
            initialSort={{ key: 'eehpw', desc: true }}
            search={searchText}
            childNoun="groups or tasks"
          />
        </Panel>
      </div>
      <SideTables rows={rows} />
    </>
  )
}

// ---------- Signal map ----------

export function ValueSignals() {
  const [cat, setCat] = useState('')
  const cats = useMemo(() => [...new Set(ESTIMATES.map((e) => e.category).filter(Boolean))].sort(), [])
  const est = ESTIMATES.filter((e) => !cat || e.category === cat)
  const bcols: Column<Behaviour>[] = [
    { key: 'signal', label: 'Signal', width: '16%', value: (b) => b.signal },
    { key: 'behavior', label: 'Behaviour', width: '18%', value: (b) => b.behavior },
    { key: 'useCase', label: 'Use case', value: (b) => b.useCase },
    { key: 'valueOutcome', label: 'Value outcome', value: (b) => b.valueOutcome },
    { key: 'description', label: 'Description', width: '32%', value: (b) => b.description, render: (b) => <span className="wrap-cell">{b.description}</span> },
  ]
  const ecols: Column<Estimate>[] = [
    { key: 'behavior', label: 'Behaviour', width: '22%', value: (e) => e.behavior, render: (e) => <span className="name-cell"><span>{e.behavior}</span><small>{e.category}</small></span> },
    { key: 'low', label: 'Low (min)', value: (e) => e.low, fmt: int, align: 'right' },
    { key: 'typical', label: 'Typical (min)', value: (e) => e.typical, fmt: int, align: 'right', bar: COLOR.licensed },
    { key: 'high', label: 'High (min)', value: (e) => e.high, fmt: int, align: 'right' },
    { key: 'grain', label: 'Counted', value: (e) => e.grain },
    { key: 'confidence', label: 'Confidence', value: (e) => e.confidence },
    {
      key: 'source',
      label: 'Source',
      value: (e) => e.source,
      render: (e) =>
        e.url ? (
          <a href={e.url} target="_blank" rel="noreferrer">
            {e.source || 'Link'}
          </a>
        ) : (
          e.source || '–'
        ),
    },
  ]
  return (
    <>
      <Panel title="Behaviour value map" note="How each audit signal maps to a behaviour and a value outcome" help={gloss('Signal', 'Appendix: Signal - Impact Table')}>
        <DataTable label="Behaviour value map" columns={bcols} rows={BEHAVIOURS.map((b, i) => ({ id: `${b.behavior}|${i}`, data: b }))} search={(b) => `${b.signal} ${b.behavior} ${b.useCase} ${b.valueOutcome}`} pageSize={10} />
      </Panel>
      <Panel
        title="Human time estimates"
        note="Minutes a person would take, per task or per resource"
        help={gloss('Which task field prices the work', 'Appendix: Signal - Impact Table')}
        actions={<Select label="Category" value={cat} onChange={setCat} options={cats.map((c) => ({ value: c, label: c }))} allLabel="All categories" />}
      >
        <DataTable label="Human time estimates" columns={ecols} rows={est.map((e, i) => ({ id: `${e.behavior}|${i}`, data: e }))} search={(e) => `${e.behavior} ${e.category} ${e.source}`} pageSize={10} />
      </Panel>
    </>
  )
}
