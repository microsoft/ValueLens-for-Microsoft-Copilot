import { useEffect, useState } from 'react'
import { useData, type Filters } from './data/store'
import { AdoptionActivation, AdoptionHeatmap, AdoptionLeaderboard, AdoptionUsage } from './pages/Adoption'
import { Agents } from './pages/Agents'
import { Feedback } from './pages/Feedback'
import { FitCowork, FitModel } from './pages/Fit'
import { Guide } from './pages/Guide'
import { Habits } from './pages/Habits'
import { ReadinessCowork, ReadinessLicence } from './pages/Readiness'
import { ValueEstimated, ValueSignals, ValueTasks } from './pages/Value'
import { TABS, useRoute, type Route, type Slicer } from './routes'
import { DataSourceDialog } from './ui/DataSourceDialog'
import { dateLabel, monthLabel } from './ui/format'
import { Segmented, Select } from './ui/primitives'

const SLICER_KEYS: Record<Slicer, (keyof Filters)[]> = {
  dates: ['from', 'to'],
  org: ['org'],
  lic: ['lic'],
  tool: ['tool'],
  agentType: ['agentType'],
  agent: ['agent'],
  creator: ['creator'],
}
const ALL_KEYS = Object.values(SLICER_KEYS).flat()

function Page({ route }: { route: Route }) {
  const { tab, view } = route
  switch (tab.id) {
    case 'adoption':
      if (view === 'usage') return <AdoptionUsage />
      if (view === 'heatmap') return <AdoptionHeatmap />
      if (view === 'leaderboard') return <AdoptionLeaderboard />
      return <AdoptionActivation />
    case 'habits':
      return <Habits />
    case 'agents':
      return <Agents />
    case 'value':
      if (view === 'estimated') return <ValueEstimated />
      if (view === 'signals') return <ValueSignals />
      return <ValueTasks />
    case 'fit':
      return view === 'model' ? <FitModel /> : <FitCowork />
    case 'readiness':
      return view === 'cowork' ? <ReadinessCowork /> : <ReadinessLicence />
    case 'feedback':
      return <Feedback />
    default:
      return <Guide />
  }
}

const opts = (xs: Iterable<string>) => [...new Set(xs)].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }))

function FilterBar({ route }: { route: Route }) {
  const { ds, filters, setFilter, resetFilters } = useData()
  const on = new Set(route.slicers)
  if (!on.size) return null
  const months = ds.months.map((m) => ({ value: m, label: monthLabel(m) }))
  const anySet = ALL_KEYS.some((k) => filters[k])
  return (
    <div className="filters" role="group" aria-label="Filters">
      {on.has('dates') && (
        <>
          <Select label="From" value={filters.from} onChange={(v) => setFilter('from', v)} options={months} allLabel="Start" />
          <Select label="To" value={filters.to} onChange={(v) => setFilter('to', v)} options={months} allLabel="Latest" />
        </>
      )}
      {on.has('org') && <Select label="Organisation" value={filters.org} onChange={(v) => setFilter('org', v)} options={ds.orgs.map((o) => ({ value: o, label: o }))} allLabel="All" />}
      {on.has('lic') && (
        <Select
          label="Licence"
          value={filters.lic}
          onChange={(v) => setFilter('lic', v as Filters['lic'])}
          options={[
            { value: 'L', label: 'Licensed' },
            { value: 'U', label: 'Unlicensed' },
          ]}
          allLabel="All"
        />
      )}
      {on.has('tool') && (
        <Select
          label="Tool"
          value={filters.tool}
          onChange={(v) => setFilter('tool', v as Filters['tool'])}
          options={[
            { value: 'Copilot', label: 'Copilot Chat' },
            { value: 'Agents', label: 'Agents' },
            { value: 'Cowork', label: 'Cowork' },
          ]}
          allLabel="All"
        />
      )}
      {on.has('agentType') && <Select label="Agent type" value={filters.agentType} onChange={(v) => setFilter('agentType', v)} options={opts(ds.agents.map((a) => a.typeLabel))} allLabel="All" />}
      {on.has('agent') && <Select label="Agent" value={filters.agent} onChange={(v) => setFilter('agent', v)} options={opts(ds.rows.map((r) => r.agent))} allLabel="All" />}
      {on.has('creator') && <Select label="Creator" value={filters.creator} onChange={(v) => setFilter('creator', v)} options={opts(ds.agents.map((a) => a.creator))} allLabel="All" />}
      {anySet && (
        <button type="button" className="link-btn reset" onClick={resetFilters}>
          Clear filters
        </button>
      )}
    </div>
  )
}

export default function App() {
  const { ds, filters, setFilter, openAssumptions, assumptions } = useData()
  const [route, go] = useRoute()
  const [sourceOpen, setSourceOpen] = useState(false)

  // A filter only applies where its slicer is shown, so hidden ones are cleared on navigation.
  useEffect(() => {
    const keep = new Set(route.slicers.flatMap((s) => SLICER_KEYS[s]))
    for (const k of ALL_KEYS) if (!keep.has(k) && filters[k]) setFilter(k, '' as never)
  }, [route, filters, setFilter])

  const view = route.tab.views.find((v) => v.id === route.view)
  return (
    <div className="shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="band">
        <div className="band-inner">
          <div className="band-top">
            <div className="brand">
              <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                <rect width="28" height="28" rx="7" fill="#ffffff" fillOpacity="0.1" />
                <circle cx="12.5" cy="12.5" r="6" stroke="#7fe0cf" strokeWidth="2.6" fill="none" />
                <path d="M17 17l4.5 4.5" stroke="#7fe0cf" strokeWidth="2.8" strokeLinecap="round" />
              </svg>
              <div>
                <h1>ValueLens</h1>
                <p>Copilot value and adoption</p>
              </div>
            </div>
            <div className="band-actions">
              <button type="button" className="assume-chip" onClick={openAssumptions}>
                Assumptions · {assumptions.currency}
                {assumptions.hourly}/h, {assumptions.scenario.toLowerCase()}
              </button>
              <button type="button" className="source-chip" onClick={() => setSourceOpen(true)}>
                {ds.source === 'sample' && <span className="tag">Sample data</span>}
                <span className="source-dates">
                  {dateLabel(ds.minDate)} – {dateLabel(ds.maxDate)}
                </span>
                <span className="source-action">Change data</span>
              </button>
            </div>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#/${t.id}`} aria-current={t.id === route.tab.id ? 'page' : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <div className="toolbar">
        <div className="toolbar-inner">
          <div className="page-head">
            <h2>
              {route.tab.label}
              {view && route.tab.views.length > 1 && <span className="crumb"> · {view.label}</span>}
            </h2>
            <p>{view?.intro ?? route.tab.intro}</p>
          </div>
          {route.tab.views.length > 1 && <Segmented label={`${route.tab.label} views`} value={route.view} options={route.tab.views} onChange={(v) => go(route.tab.id, v)} />}
        </div>
        <FilterBar route={route} />
      </div>
      <main id="main" className="main" tabIndex={-1}>
        <Page route={route} />
      </main>
      <footer className="foot">ValueLens. Everything is calculated in your browser and never leaves it.</footer>
      <DataSourceDialog open={sourceOpen} onClose={() => setSourceOpen(false)} />
    </div>
  )
}
