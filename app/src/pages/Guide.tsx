import { useMemo, useState } from 'react'
import { GLOSSARY } from '../data/glossary'
import { Panel } from '../ui/primitives'

const NOTES: { title: string; body: string }[] = [
  {
    title: 'Same numbers, simpler layout',
    body: 'Every measure, chart and table in the ValueLens Power BI report is here, calculated with the same rules. The report pages are grouped into seven data tabs plus this Guide, and tabs with several pages have views you switch between.',
  },
  {
    title: 'Where each report page went',
    body: 'Adoption holds Activation, Adoption, Trend Heatmap and Leaderboard. Habits is Habit Formation. Agents is Agent Registry. Value holds Task Breakdown, Estimated Value and the Signal - Impact Table appendix. Fit holds Cowork Fit and Model Fit. Readiness holds License Readiness and License Allocation (as Licences) and Cowork Readiness. Feedback is User Feedback, and the Glossary appendix is in this Guide.',
  },
  {
    title: 'Charts that changed shape',
    body: 'Treemaps, donuts and pies are shown as ranked bars or a single proportion bar, and the activation chart is a two-sided bar. The values are unchanged.',
  },
  {
    title: 'Assumptions',
    body: 'Hourly rate, currency, licence price, effort scenario, Cowork grading and licence cost come from the Assumptions panel. They replace the report’s parameter tables and apply everywhere straight away.',
  },
  {
    title: 'Agent lifecycle without user counts',
    body: 'When the agent registry export has no Total Users column, lifecycle and usage review fall back to users observed in the audit log.',
  },
  {
    title: 'Not included',
    body: 'Report bookmarks and the page navigator are replaced by tabs. Everything they showed is on a tab.',
  },
  {
    title: 'Privacy',
    body: 'Your files are read and calculated in your browser. Nothing is uploaded. Behaviour charts on the agent lens hide agents with fewer than two users.',
  },
]

export function Guide() {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const hits = GLOSSARY.filter((g) => !s || `${g.metric} ${g.description} ${g.page}`.toLowerCase().includes(s))
    const map = new Map<string, typeof hits>()
    for (const h of [...hits].sort((a, b) => a.pageOrder - b.pageOrder || a.metricOrder - b.metricOrder)) map.set(h.page, [...(map.get(h.page) ?? []), h])
    return [...map]
  }, [q])
  return (
    <div className="grid grid-1-2">
      <Panel title="About this app">
        <dl className="defs">
          {NOTES.map((n) => (
            <div key={n.title}>
              <dt>{n.title}</dt>
              <dd>{n.body}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel
        title="Metric glossary"
        note="Definitions from the Power BI report"
        actions={<input className="search" type="search" placeholder="Search metrics" aria-label="Search metrics" value={q} onChange={(e) => setQ(e.target.value)} />}
      >
        {groups.length === 0 && <p className="empty">No metrics match “{q}”.</p>}
        {groups.map(([page, items]) => (
          <section key={page} className="gloss-group">
            <h4>{page}</h4>
            {items[0]?.pageDescription && <p className="section-note">{items[0].pageDescription}</p>}
            <dl className="defs">
              {items.map((g) => (
                <div key={g.metric}>
                  <dt>{g.metric}</dt>
                  <dd>{g.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </Panel>
    </div>
  )
}
