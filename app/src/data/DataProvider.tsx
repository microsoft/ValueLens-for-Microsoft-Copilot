import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DataContext, DEFAULT_ASSUMPTIONS, EMPTY_FILTERS, lensOf, type Assumptions, type DataState, type Filters } from './store'
import type { AgentInfo, Dataset } from './types'
import { loadFiles as readFiles, loadSample as readSample } from './load'
import { AgentDrawer } from '../ui/AgentDrawer'
import { AssumptionsSheet } from '../ui/AssumptionsSheet'

export function DataProvider({ children }: { children: ReactNode }) {
  const [ds, setDs] = useState<Dataset | null>(null)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS)
  const [agent, setAgent] = useState<string | null>(null)
  const [assumptionsOpen, setAssumptionsOpen] = useState(false)

  const loadSample = useCallback(async () => {
    setError('')
    try {
      setDs(await readSample())
      setFilters(EMPTY_FILTERS)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadFiles = useCallback(async (files: File[]) => {
    const { dataset, found } = await readFiles(files)
    setDs(dataset)
    setFilters(EMPTY_FILTERS)
    return found
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    void loadSample()
  }, [loadSample])

  const byTitle = useMemo(() => {
    const m = new Map<string, AgentInfo>()
    for (const a of ds?.agents ?? []) if (a.titleId && !m.has(a.titleId)) m.set(a.titleId, a)
    return m
  }, [ds])

  const period = useMemo(() => {
    if (!ds) return []
    const { from, to } = filters
    if (!from && !to) return ds.rows
    return ds.rows.filter((r) => (!from || r.month >= from) && (!to || r.month <= to))
  }, [ds, filters])

  const base = useMemo(() => (filters.org ? period.filter((r) => r.org === filters.org) : period), [period, filters])

  const rows = useMemo(() => {
    const { lic, tool, agentType, agent: name, creator } = filters
    if (!lic && !tool && !agentType && !name && !creator) return base
    return base.filter((r) => {
      if (lic && r.lic !== lic) return false
      if (tool && r.tool !== tool) return false
      if (name && r.agent !== name) return false
      if (agentType || creator) {
        const a = byTitle.get(r.link)
        if (!a) return false
        if (agentType && a.typeLabel !== agentType) return false
        if (creator && a.creator !== creator) return false
      }
      return true
    })
  }, [base, filters, byTitle])

  const setFilter = useCallback(<K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v })), [])
  const resetFilters = useCallback(() => setFilters(EMPTY_FILTERS), [])
  const setAssumption = useCallback(<K extends keyof Assumptions>(k: K, v: Assumptions[K]) => setAssumptions((a) => ({ ...a, [k]: v })), [])
  const nameOf = useCallback((user: string) => ds?.people.get(user)?.name ?? user, [ds])
  const openAssumptions = useCallback(() => setAssumptionsOpen(true), [])

  const value = useMemo<DataState | null>(
    () =>
      ds && {
        ds,
        filters,
        setFilter,
        resetFilters,
        period,
        base,
        rows,
        lens: lensOf(filters),
        assumptions,
        setAssumption,
        nameOf,
        openAgent: setAgent,
        openAssumptions,
        loadFiles,
        loadSample,
      },
    [ds, filters, setFilter, resetFilters, period, base, rows, assumptions, setAssumption, nameOf, openAssumptions, loadFiles, loadSample],
  )

  if (!value)
    return (
      <div className="boot" role="status">
        {error ? (
          <>
            <h1>Couldn't load the sample data</h1>
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => void loadSample()}>
              Try again
            </button>
          </>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <p>Loading Copilot usage…</p>
          </>
        )}
      </div>
    )

  return (
    <DataContext.Provider value={value}>
      {children}
      <AgentDrawer name={agent} onClose={() => setAgent(null)} />
      <AssumptionsSheet open={assumptionsOpen} onClose={() => setAssumptionsOpen(false)} />
    </DataContext.Provider>
  )
}
