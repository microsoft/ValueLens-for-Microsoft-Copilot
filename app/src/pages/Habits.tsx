import { useMemo } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import { groupBy } from '../metrics/core'
import { inactiveMeasured, lastFullMonth, roster, STAGE_LABEL, STAGES, stageCounts, userStages, type Stage, type UserStage } from '../metrics/people'
import { ColumnChart, Distribution } from '../ui/charts'
import { Stack100 } from '../ui/extra-charts'
import { DataTable, type Column } from '../ui/DataTable'
import { DASH, int, monthLabel, pct } from '../ui/format'
import { Empty, Kpi, KpiRow, Panel } from '../ui/primitives'
import { STAGE_COLOR } from '../ui/theme'
import { usePersonLabel } from './cols'

const P = 'Power Users'
const fin = (n: number) => (Number.isFinite(n) ? n : 0)
const DAYS: Record<Stage, string> = {
  '0 - Inactive': '0 days',
  '1 - Beginner': '1–5 days',
  '2 - Developing': '6–10 days',
  '3 - Habitual': '11–15 days',
  '4 - Power': '16+ days',
}

export function Habits() {
  const { ds, rows, filters } = useData()
  const person = usePersonLabel()
  const d = useMemo(() => {
    const month = lastFullMonth(ds, filters.from, filters.to)
    const measured = inactiveMeasured(filters.tool, filters.lic)
    const licensed = roster(ds, filters.org).filter((p) => p.hasLicense).length
    const monthRows = rows.filter((r) => r.month === month)
    const counts = stageCounts(monthRows, licensed, measured)
    const byMonth = [...groupBy(rows, (r) => r.month)]
      .filter(([m]) => m)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, rs]) => {
        const c = stageCounts(rs, licensed, measured)
        return { key: m, values: STAGES.map((s) => fin(c[s])) }
      })
    const byOrg = [...groupBy(monthRows, (r) => r.org)]
      .filter(([o]) => o)
      .map(([o, rs]) => {
        const c = stageCounts(rs, roster(ds, o).filter((p) => p.hasLicense).length, measured)
        return { key: o, values: STAGES.map((s) => fin(c[s])), hint: `${int(c.base)} users`, base: c.base }
      })
      .sort((a, b) => b.base - a.base)
    const users = userStages(monthRows, rows).map((u) => ({ id: u.id, data: u }))
    return { month, measured, counts, byMonth, byOrg, users }
  }, [ds, rows, filters])
  if (!d.month) return <Empty>Habits use the last complete month in the selection. Pick a range that includes a full month.</Empty>
  const series = STAGES.map((s, i) => ({ name: STAGE_LABEL[s], color: STAGE_COLOR[i] }))
  const cols: Column<UserStage>[] = [
    {
      key: 'user',
      label: 'Person',
      width: '34%',
      value: (u) => person(u.user).label,
      render: (u) => {
        const p = person(u.user)
        return (
          <span className="name-cell">
            <span>{p.label}</span>
            <small>{u.org || p.sub}</small>
          </span>
        )
      },
    },
    { key: 'stage', label: 'Stage', value: (u) => u.stage, render: (u) => STAGE_LABEL[u.stage] },
    { key: 'days', label: 'Active days', value: (u) => u.days, fmt: int, align: 'right', bar: STAGE_COLOR[3] },
    { key: 'agentSessions', label: 'Agent sessions', value: (u) => u.agentSessions, fmt: int, align: 'right' },
  ]
  return (
    <>
      <p className="section-note">
        Stages for <b>{monthLabel(d.month)}</b>, the last complete month in your selection.
      </p>
      <KpiRow>
        {STAGES.map((s) => (
          <Kpi
            key={s}
            label={STAGE_LABEL[s]}
            value={Number.isFinite(d.counts[s]) ? int(d.counts[s]) : DASH}
            sub={Number.isFinite(d.counts[s]) ? `${pct(d.counts[s] / d.counts.base)} · ${DAYS[s]}` : 'Not measured for this filter'}
            help={s === '0 - Inactive' ? gloss('Usage stages under Cowork', P) : gloss('Usage stages', P)}
          />
        ))}
      </KpiRow>
      <div className="grid grid-2-1">
        <Panel title="Users by stage, by month" note="Active days in each month" help={gloss('Usage frequency', P)}>
          <ColumnChart label="Users by stage by month" data={d.byMonth} series={series} xFmt={monthLabel} stacked />
        </Panel>
        <Panel title="Stage distribution" note={monthLabel(d.month)}>
          <Distribution label="Stage distribution" items={STAGES.map((s, i) => ({ label: STAGE_LABEL[s], value: fin(d.counts[s]), color: STAGE_COLOR[i] }))} />
          <dl className="defs compact">
            {STAGES.map((s) => (
              <div key={s}>
                <dt>{STAGE_LABEL[s]}</dt>
                <dd>{s === '0 - Inactive' ? 'Licensed, no activity in the month' : `${DAYS[s]} active in the month`}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
      <div className="grid grid-2">
        <Panel title="Maturity by organisation" note="Share of each organisation's users in each stage">
          <Stack100 label="Maturity by organisation" data={d.byOrg} series={series} />
        </Panel>
        <Panel title="People and their stage" note={monthLabel(d.month)}>
          <DataTable label="People by usage stage" columns={cols} rows={d.users} initialSort={{ key: 'days', desc: true }} search={(u) => `${person(u.user).label} ${u.org}`} />
        </Panel>
      </div>
    </>
  )
}
