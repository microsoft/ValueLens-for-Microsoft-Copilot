import { createContext, useContext } from 'react'
import type { Dataset, Grading, Row, Scenario } from './types'
import type { Lens } from '../metrics/core'

export interface Filters {
  from: string
  to: string
  org: string
  lic: '' | 'L' | 'U'
  tool: '' | 'Copilot' | 'Agents' | 'Cowork'
  agentType: string
  agent: string
  creator: string
}

export const EMPTY_FILTERS: Filters = { from: '', to: '', org: '', lic: '', tool: '', agentType: '', agent: '', creator: '' }

/** The model's editable parameters (Hourly Value, Assumptions table, Effort Scenario, Fit Grading). */
export interface Assumptions {
  hourly: number
  currency: string
  ppupm: number
  penalty: number
  licenceCost: number
  scenario: Scenario
  grading: Grading
}

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  hourly: 50,
  currency: '£',
  ppupm: 30,
  penalty: 1,
  licenceCost: 0,
  scenario: 'Typical',
  grading: 'Balanced',
}

export interface DataState {
  ds: Dataset
  filters: Filters
  setFilter: <K extends keyof Filters>(k: K, v: Filters[K]) => void
  resetFilters: () => void
  /** Rows inside the selected months only. */
  period: Row[]
  /** Period and organisation filters. */
  base: Row[]
  /** Every filter: period, organisation, licence, tool and the agent slicers. */
  rows: Row[]
  lens: Lens
  assumptions: Assumptions
  setAssumption: <K extends keyof Assumptions>(k: K, v: Assumptions[K]) => void
  nameOf: (user: string) => string
  openAgent: (name: string | null) => void
  openAssumptions: () => void
  loadFiles: (files: File[]) => Promise<string[]>
  loadSample: () => Promise<void>
}

export const DataContext = createContext<DataState | null>(null)

export function useData(): DataState {
  const v = useContext(DataContext)
  if (!v) throw new Error('useData must be used inside DataProvider')
  return v
}

export function lensOf(f: Filters): Lens {
  if (f.tool === 'Agents') return 'agent'
  if (f.tool === 'Cowork') return 'cowork'
  if (f.lic === 'L') return 'licensed'
  if (f.lic === 'U') return 'unlicensed'
  return 'overall'
}
