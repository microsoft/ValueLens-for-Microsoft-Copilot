import { useMemo } from 'react'
import { useData } from '../data/store'
import { countDistinct } from '../metrics/core'
import type { ValueInputs } from '../metrics/value'
import { DASH, type Fmt } from '../ui/format'

/** Inputs for every value measure: the assumptions plus the number of weeks in the selected dates. */
export function useValueInputs(): ValueInputs {
  const { ds, period, assumptions } = useData()
  return useMemo(
    () => ({
      all: ds.rows,
      scenario: assumptions.scenario,
      hourly: assumptions.hourly,
      penalty: assumptions.penalty,
      ppupm: assumptions.ppupm,
      windowWeeks: countDistinct(period, (r) => r.week),
    }),
    [ds, period, assumptions],
  )
}

const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Currency formatter; large values are shortened to k and m. */
export function useMoney(): Fmt {
  const { assumptions } = useData()
  const c = assumptions.currency
  return useMemo<Fmt>(
    () => (n) => {
      if (!Number.isFinite(n)) return DASH
      const sign = n < 0 ? '−' : ''
      const a = Math.abs(n)
      if (a >= 1e6) return `${sign}${c}${nf1.format(a / 1e6)}m`
      if (a >= 1e4) return `${sign}${c}${nf1.format(a / 1e3)}k`
      return `${sign}${c}${nf0.format(a)}`
    },
    [c],
  )
}

export const text = (s: string) => s || DASH

/** Rows the PBI hides with a "not 'Draft as 1P Agent'" filter. */
export const DRAFT_AGENT = 'Draft as 1P Agent'
