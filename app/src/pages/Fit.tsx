import { useMemo, useState } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import { GRADINGS, type Grading, type Row } from '../data/types'
import { countDistinct, groupBy } from '../metrics/core'
import {
  attributionCoverage,
  coverageNotice,
  coworkFitKpis,
  fitRuleNotice,
  GRADE_SHORT,
  GRADES,
  gradeShareByCategory,
  loggedShare,
  mainModel,
  mainReason,
  modelStats,
  VERDICT_LABEL,
  whoStats,
  whyRows,
  type ModelStats,
  type WhoStats,
  type WhyRow,
} from '../metrics/fit'
import { coworkHours } from '../metrics/value'
import { BarList } from '../ui/charts'
import { MixBar, Stack100, VerdictIcon } from '../ui/extra-charts'
import { DataTable, type Column, type TableRow } from '../ui/DataTable'
import { dec1, int, pct } from '../ui/format'
import { Kpi, KpiRow, Panel, Segmented } from '../ui/primitives'
import { COLOR, GRADE_COLOR, MODEL_COLOR } from '../ui/theme'
import { usePersonLabel } from './cols'
import { text } from './common'

const P = 'Usage Efficiency'
const PM = 'Model Mix'

function GradingPicker() {
  const { assumptions, setAssumption } = useData()
  return (
    <div className="lens-bar">
      <span className="lens-label">Grading</span>
      <Segmented<Grading> label="Grading" value={assumptions.grading} options={GRADINGS.map((g) => ({ id: g, label: g }))} onChange={(g) => setAssumption('grading', g)} />
    </div>
  )
}

interface WhoRec {
  label: string
  sub?: string
  s: WhoStats
}

// ---------- Cowork fit ----------

export function FitCowork() {
  const { base, assumptions } = useData()
  const person = usePersonLabel()
  const g = assumptions.grading
  const [cat, setCat] = useState('')
  const d = useMemo(() => {
    const share = gradeShareByCategory(base, g)
    const catRows = cat ? base.filter((r) => r.coworkCat === cat) : base
    const who: TableRow<WhoRec>[] = []
    for (const [org, ors] of groupBy(base, (r) => r.org)) {
      const s = org ? whoStats(ors, g) : null
      if (!s) continue
      const children: TableRow<WhoRec>[] = []
      for (const [u, urs] of groupBy(ors, (r) => r.user)) {
        const us = u ? whoStats(urs, g) : null
        if (us) children.push({ id: `${org}::${u}`, data: { ...person(u), s: us } })
      }
      who.push({ id: org, data: { label: org, s }, children })
    }
    return {
      k: coworkFitKpis(base, g),
      hours: coworkHours(base, assumptions.scenario),
      share: share.map((x) => ({ key: x.key, values: x.values, hint: `${int(x.graded)} graded sessions` })),
      why: whyRows(catRows, base, g, cat),
      who,
      rule: fitRuleNotice(base, g),
    }
  }, [base, g, cat, assumptions.scenario, person])
  const gseries = GRADES.map((gr, i) => ({ name: gr, color: GRADE_COLOR[i] }))
  const whyCols: Column<WhyRow>[] = [
    {
      key: 'shape',
      label: 'Grade / work shape',
      width: '24%',
      value: (w) => w.sort,
      render: (w) => (
        <span className="name-cell">
          <span>{w.shape}</span>
          <small className="tag-dot">
            <i style={{ background: GRADE_COLOR[GRADES.indexOf(w.grade)] }} aria-hidden="true" />
            {GRADE_SHORT[w.grade]}
          </small>
        </span>
      ),
    },
    { key: 'sessions', label: 'Sessions', value: (w) => w.sessions, fmt: int, align: 'right', bar: COLOR.cowork },
    { key: 'share', label: 'Share of work', value: (w) => w.share, fmt: pct, align: 'right', help: gloss('Work weight', P) },
    { key: 'basis', label: 'What decided it', value: (w) => w.basis, render: (w) => <span className="wrap-cell">{text(w.basis)}</span>, help: gloss('What counts as material', P) },
    { key: 'alt', label: 'Alternative tool', value: (w) => w.alt, render: (w) => text(w.alt), help: gloss('Best-fit app', P) },
    { key: 'files', label: 'Files (median)', value: (w) => w.files, fmt: dec1, align: 'right' },
    { key: 'kinds', label: 'Kinds (median)', value: (w) => w.kinds, fmt: dec1, align: 'right' },
  ]
  const whoCols: Column<WhoRec>[] = [
    {
      key: 'label',
      label: 'Organisation / person',
      width: '28%',
      value: (r) => r.label,
      render: (r) => (
        <span className="name-cell">
          <span>{r.label}</span>
          {r.sub && <small>{r.sub}</small>}
        </span>
      ),
    },
    { key: 'people', label: 'People', value: (r) => r.s.people, fmt: int, align: 'right' },
    { key: 'graded', label: 'Graded sessions', value: (r) => r.s.graded, fmt: int, align: 'right' },
    {
      key: 'mix',
      label: 'Mix',
      value: (r) => r.s.high,
      render: (r) => <MixBar values={[r.s.high, r.s.medium, r.s.low]} colors={GRADE_COLOR} label={`Strong ${pct(r.s.high)}, fair ${pct(r.s.medium)}, worth a look ${pct(r.s.low)}`} />,
    },
    { key: 'high', label: 'Strong', value: (r) => r.s.high, fmt: pct, align: 'right' },
    { key: 'medium', label: 'Fair', value: (r) => r.s.medium, fmt: pct, align: 'right' },
    { key: 'low', label: 'Worth a look', value: (r) => r.s.low, fmt: pct, align: 'right' },
    { key: 'flagged', label: 'Flagged', value: (r) => r.s.flagged, fmt: int, align: 'right', help: 'People with 5+ graded sessions where at least half are "Worth a look".' },
  ]
  return (
    <>
      <GradingPicker />
      <KpiRow>
        <Kpi tone="cowork" label="Cowork sessions" value={int(d.k.sessions)} help={gloss('Sessions we could assess', P)} />
        <Kpi tone="cowork" label="Cowork tasks" value={int(d.k.tasks)} help={gloss('Consumption tasks', P)} />
        <Kpi tone="cowork" label="Active days per user" value={dec1(d.k.daysPerUser)} />
        <Kpi tone="cowork" label="Cowork hours" value={int(d.hours)} sub={`${assumptions.scenario.toLowerCase()} effort`} help={gloss('Estimated time saved', 'Value')} />
        <Kpi tone="cowork" label="Strong fit share" value={pct(d.k.high)} sub={`of ${int(d.k.graded)} graded`} />
        <Kpi tone="cowork" label="Worth a look share" value={pct(d.k.low)} sub={`${int(d.k.unclassified)} unclassified`} />
      </KpiRow>
      <div className="grid grid-1-2">
        <Panel title="What · how well each task fits Cowork" note={cat ? `Showing ${cat}. Select it again to clear` : 'Select a task to focus the table'} help={gloss('Why the fit test is scoped to Cowork', P)}>
          <Stack100 label="Cowork fit by task category" data={d.share} series={gseries} onSelect={(k) => setCat((c) => (c === k ? '' : k))} selected={cat} />
        </Panel>
        <Panel title="Why · what decided the grade" note={cat || 'All Cowork tasks'} help={gloss('Why work weight is a floor, not a verdict', P)}>
          <DataTable label="What decided the grade" columns={whyCols} rows={d.why.map((w) => ({ id: w.id, data: w }))} initialSort={{ key: 'shape' }} />
        </Panel>
      </div>
      <Panel title="Who · where the mix sits" note="Organisations and people with 5 or more graded sessions">
        <DataTable label="Fit mix by organisation and person" columns={whoCols} rows={d.who} initialSort={{ key: 'graded', desc: true }} search={(r) => `${r.label} ${r.sub ?? ''}`} childNoun="organisations or people" />
      </Panel>
      <Panel title="How the grade is decided" note={`${g} grading`}>
        <dl className="defs compact">
          {d.rule.rules.map(([label, body]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{body}</dd>
            </div>
          ))}
        </dl>
        {d.rule.text && <p className="panel-foot">{d.rule.text}</p>}
      </Panel>
    </>
  )
}

// ---------- Model fit ----------

type ModelView = 'group' | 'org' | 'person'
interface ModelRec {
  label: string
  sub?: string
  s: ModelStats
  model: string
  reason: string
}

export function FitModel() {
  const { rows, assumptions } = useData()
  const person = usePersonLabel()
  const g = assumptions.grading
  const [view, setView] = useState<ModelView>('group')
  const d = useMemo(() => {
    const key: Record<ModelView, (r: Row) => string> = { group: (r) => r.taskGroup || 'Unclassified', org: (r) => r.org, person: (r) => r.user }
    const table = [...groupBy(rows, key[view])]
      .filter(([k]) => k)
      .map(([k, rs]) => {
        const lab = view === 'person' ? person(k) : { label: k }
        return { id: k, data: { ...lab, s: modelStats(rs, g), model: mainModel(rs), reason: mainReason(rs, g) } }
      })
      .filter((x) => x.data.s.sessions > 0)
    const total = countDistinct(rows, (r) => r.thread)
    const models = [...groupBy(rows, (r) => r.model)]
      .filter(([k]) => k)
      .map(([k, rs]) => {
        const tiers = [...groupBy(rs, (r) => r.t.tier)].sort((a, b) => b[1].length - a[1].length)
        const n = countDistinct(rs, (r) => r.thread)
        return { key: k, label: k, value: n, hint: `${tiers[0]?.[0] || 'Unknown tier'} · ${pct(n / total)}` }
      })
    const tools = (['Copilot', 'Agents', 'Cowork'] as const)
      .map((t) => {
        const s = modelStats(
          rows.filter((r) => r.tool === t),
          g,
        )
        return { key: t === 'Copilot' ? 'Copilot Chat' : t, values: [s.well, s.over, s.under, s.notJudged], hint: `${int(s.sessions)} sessions` }
      })
      .filter((x) => x.values.some((v) => v > 0))
    return { s: modelStats(rows, g), logged: loggedShare(rows), coverage: attributionCoverage(rows), notice: coverageNotice(rows, g), table, models, tools }
  }, [rows, g, view, person])
  const { s } = d
  const share = (n: number, of: number) => (of ? n / of : NaN)
  const cols: Column<ModelRec>[] = [
    {
      key: 'label',
      label: view === 'group' ? 'Task group' : view === 'org' ? 'Organisation' : 'Person',
      width: '26%',
      value: (r) => r.label,
      render: (r) => (
        <span className="verdict-cell">
          <VerdictIcon v={r.s.verdict} label={VERDICT_LABEL[r.s.verdict]} />
          <span className="name-cell">
            <span>{r.label}</span>
            <small>{VERDICT_LABEL[r.s.verdict]}</small>
          </span>
        </span>
      ),
    },
    { key: 'model', label: 'Main model', value: (r) => r.model, render: (r) => text(r.model) },
    { key: 'reason', label: 'Main reason', value: (r) => r.reason, render: (r) => <span className="wrap-cell">{text(r.reason)}</span> },
    { key: 'sessions', label: 'Sessions', value: (r) => r.s.sessions, fmt: int, align: 'right', bar: COLOR.neutral },
    { key: 'judged', label: 'Judged', value: (r) => share(r.s.judged, r.s.sessions), fmt: pct, align: 'right' },
    { key: 'well', label: 'Good match', value: (r) => share(r.s.well, r.s.judged), fmt: pct, align: 'right', help: gloss('Good match', PM) },
    { key: 'over', label: 'Lighter would do', value: (r) => share(r.s.over, r.s.judged), fmt: pct, align: 'right', help: gloss('Lighter model may do', PM) },
    { key: 'under', label: 'Could use stronger', value: (r) => share(r.s.under, r.s.judged), fmt: pct, align: 'right', help: gloss('Could have used (model)', PM) },
  ]
  return (
    <>
      <GradingPicker />
      <KpiRow>
        <Kpi label="Sessions" value={int(s.sessions)} sub={`${int(s.judged)} judged`} help={gloss('Depth signal', PM)} />
        <Kpi label="Model logged" value={pct(d.logged)} sub={`${pct(d.coverage)} of prompts attributed`} help={gloss('Attribution coverage', PM)} />
        <Kpi tone="licensed" label="Good match" value={pct(share(s.well, s.judged))} help={gloss('Good match', PM)} />
        <Kpi tone="unlicensed" label="Lighter model would do" value={pct(share(s.over, s.judged))} help={gloss('Lighter model may do', PM)} />
        <Kpi tone="agent" label="Could use a stronger model" value={pct(share(s.under, s.judged))} help={gloss('Could have used (model)', PM)} />
      </KpiRow>
      <div className="grid grid-1-2">
        <div className="stack">
          <Panel title="Model usage" note="Sessions per model, with its cost tier and share" help={gloss('Model cost tier', PM)}>
            <BarList label="Sessions per model" items={d.models} color={COLOR.neutral} limit={10} />
          </Panel>
          <Panel title="Model match by tool" note="Share of sessions">
            <Stack100
              label="Model match by tool"
              data={d.tools}
              series={[
                { name: 'Good match', color: MODEL_COLOR.well },
                { name: 'Lighter would do', color: MODEL_COLOR.over },
                { name: 'Could use stronger', color: MODEL_COLOR.under },
                { name: 'Not judged', color: MODEL_COLOR.not },
              ]}
            />
          </Panel>
        </div>
        <Panel
          title="Where the model fits the work"
          actions={
            <Segmented<ModelView>
              label="Group by"
              value={view}
              options={[
                { id: 'group', label: 'Task group' },
                { id: 'org', label: 'Organisation' },
                { id: 'person', label: 'Person' },
              ]}
              onChange={setView}
            />
          }
          help={gloss('Why tiers are not compared', PM)}
        >
          <DataTable label="Model fit" columns={cols} rows={d.table} initialSort={{ key: 'sessions', desc: true }} search={(r) => `${r.label} ${r.sub ?? ''} ${r.model}`} />
          <p className="panel-foot">{d.notice}</p>
        </Panel>
      </div>
    </>
  )
}
