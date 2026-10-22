import { useMemo, useState } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import { groupByF, satisfaction, terms, themeStats, themeSummary } from '../metrics/feedback'
import { BarList, ColumnChart, Distribution, LineChart } from '../ui/charts'
import { Headline, TermCloud } from '../ui/extra-charts'
import { DataTable, type Column } from '../ui/DataTable'
import { int, monthShort, pct } from '../ui/format'
import { Empty, Kpi, KpiRow, Panel, Select } from '../ui/primitives'
import { COLOR } from '../ui/theme'

const P = 'Feedback'
type Theme = ReturnType<typeof themeStats>[number]

export function Feedback() {
  const { ds, filters } = useData()
  const [emoji, setEmoji] = useState('')
  const inRange = useMemo(() => ds.feedback.filter((f) => (!filters.from || f.month >= filters.from) && (!filters.to || f.month <= filters.to)), [ds.feedback, filters.from, filters.to])
  const emojis = useMemo(() => [...new Set(inRange.map((f) => f.emoji).filter(Boolean))].sort(), [inRange])
  const fb = useMemo(() => (emoji ? inRange.filter((f) => f.emoji === emoji) : inRange), [inRange, emoji])
  const d = useMemo(() => {
    const months = [...groupByF(fb, (f) => f.month)].filter(([m]) => m).sort(([a], [b]) => a.localeCompare(b))
    return {
      s: satisfaction(fb),
      monthly: months.map(([m, l]) => {
        const s = satisfaction(l)
        return { key: m, values: [s.up, s.down] }
      }),
      rate: months.map(([m, l]) => ({ key: m, values: [satisfaction(l).rate] })),
      emoji: [...groupByF(fb, (f) => f.emoji || 'None')]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([e, l], i) => ({ label: e, value: l.length, color: [COLOR.licensed, COLOR.agent, COLOR.cowork, COLOR.unlicensed, COLOR.neutral][i % 5] })),
      surfaces: [...groupByF(fb, (f) => f.surface || f.app || 'Unknown')].map(([k, l]) => {
        const s = satisfaction(l)
        return { key: k, label: k, value: s.rate, hint: `${int(s.total)} items` }
      }),
      themes: themeStats(fb),
      summary: themeSummary(fb),
      words: terms(fb),
    }
  }, [fb])
  if (!ds.feedback.length) return <Empty>No feedback file is loaded. Add a Copilot feedback export to see this view.</Empty>
  const cols: Column<Theme>[] = [
    { key: 'category', label: 'Theme', width: '34%', value: (t) => t.category },
    { key: 'total', label: 'Items', value: (t) => t.total, fmt: int, align: 'right', bar: COLOR.neutral },
    { key: 'up', label: 'Thumbs up', value: (t) => t.up, fmt: int, align: 'right' },
    { key: 'down', label: 'Thumbs down', value: (t) => t.down, fmt: int, align: 'right' },
    { key: 'rate', label: 'Satisfaction', value: (t) => t.rate, fmt: pct, align: 'right' },
  ]
  return (
    <>
      <div className="lens-bar">
        <Select label="Reaction" value={emoji} onChange={setEmoji} options={emojis.map((e) => ({ value: e, label: e }))} allLabel="All reactions" />
      </div>
      <KpiRow>
        <Kpi tone="licensed" label="Satisfaction" value={pct(d.s.rate)} help={gloss('Sentiment', P)} />
        <Kpi label="Feedback items" value={int(d.s.total)} help={gloss('Feedback coverage', P)} />
        <Kpi tone="licensed" label="Thumbs up" value={int(d.s.up)} />
        <Kpi tone="unlicensed" label="Thumbs down" value={int(d.s.down)} />
      </KpiRow>
      <Headline>{d.summary}</Headline>
      <div className="grid grid-2">
        <Panel title="Feedback by month" note="Thumbs up and down">
          <ColumnChart
            label="Feedback by month"
            data={d.monthly}
            xFmt={monthShort}
            stacked
            series={[
              { name: 'Thumbs up', color: COLOR.up, fmt: int },
              { name: 'Thumbs down', color: COLOR.down, fmt: int },
            ]}
          />
        </Panel>
        <Panel title="Satisfaction by month" help={gloss('Sentiment', P)}>
          <LineChart label="Satisfaction by month" data={d.rate} xFmt={monthShort} series={[{ name: 'Satisfaction', color: COLOR.licensed, fmt: pct }]} />
        </Panel>
      </div>
      <div className="grid grid-3">
        <Panel title="Reactions" note="Feedback items">
          {d.emoji.length ? <Distribution label="Feedback by reaction" items={d.emoji} fmt={int} /> : <Empty>No reactions in this selection.</Empty>}
        </Panel>
        <Panel title="Satisfaction by app" note="Share of thumbs up">
          <BarList label="Satisfaction by app" items={d.surfaces} color={COLOR.licensed} fmt={pct} limit={10} />
        </Panel>
        <Panel title="What people mention" note="Most frequent words in comments">
          {d.words.length ? <TermCloud label="Most frequent words in feedback comments" terms={d.words} /> : <Empty>No comments in this selection.</Empty>}
        </Panel>
      </div>
      <Panel title="Feedback themes" note="Satisfaction by topic">
        <DataTable label="Feedback themes" columns={cols} rows={d.themes.map((t) => ({ id: t.category, data: t }))} initialSort={{ key: 'total', desc: true }} />
      </Panel>
    </>
  )
}
