import type { ReactNode } from 'react'
import { DASH, int, pct0, type Fmt } from './format'
import { Empty, Legend } from './primitives'
import { HEAT_RAMP } from './theme'

const fin = (n: number) => (Number.isFinite(n) ? n : 0)

/** Diverging bars per category: left series grows left, right series grows right. Replaces the PBI tornado. */
export function Tornado(props: {
  data: { key: string; left: number; right: number }[]
  left: { name: string; color: string }
  right: { name: string; color: string }
  fmt?: Fmt
  label: string
}) {
  const fmt = props.fmt ?? int
  if (!props.data.length) return <Empty>Nothing to show for these filters.</Empty>
  const max = Math.max(...props.data.flatMap((d) => [fin(d.left), fin(d.right)])) || 1
  return (
    <div className="tornado" aria-label={props.label}>
      <div className="tn-head" aria-hidden="true">
        <span />
        <span>{props.left.name}</span>
        <span>{props.right.name}</span>
      </div>
      <ol>
        {props.data.map((d) => (
          <li key={d.key}>
            <span className="tn-label" title={d.key}>
              {d.key}
            </span>
            <span className="tn-side tn-left">
              <b>{fmt(d.left)}</b>
              <i style={{ width: `${(fin(d.left) / max) * 100}%`, background: props.left.color }} />
            </span>
            <span className="tn-side tn-right">
              <i style={{ width: `${(fin(d.right) / max) * 100}%`, background: props.right.color }} />
              <b>{fmt(d.right)}</b>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** One 100% stacked bar per row. Replaces PBI 100% stacked bar/column charts. */
export function Stack100(props: {
  data: { key: string; values: number[]; hint?: string }[]
  series: { name: string; color: string }[]
  label: string
  onSelect?: (key: string) => void
  selected?: string
}) {
  if (!props.data.length) return <Empty>Nothing to show for these filters.</Empty>
  return (
    <div className="stack100" aria-label={props.label}>
      <ol>
        {props.data.map((d) => {
          const tot = d.values.reduce((a, b) => a + fin(b), 0)
          const desc = props.series.map((s, i) => `${s.name} ${pct0(tot ? fin(d.values[i]) / tot : 0)}`).join(', ')
          const body = (
            <>
              <span className="s1-label" title={d.key}>
                {d.key}
                {d.hint && <small>{d.hint}</small>}
              </span>
              <span className="s1-bar" role="img" aria-label={`${d.key}: ${desc}`}>
                {d.values.map((v, i) =>
                  fin(v) > 0 ? (
                    <span key={i} style={{ flexGrow: fin(v), background: props.series[i].color }} title={`${props.series[i].name}: ${pct0(fin(v) / tot)}`}>
                      {fin(v) / tot >= 0.12 ? pct0(fin(v) / tot) : ''}
                    </span>
                  ) : null,
                )}
              </span>
            </>
          )
          return (
            <li key={d.key} className={props.selected === d.key ? 'sel' : ''}>
              {props.onSelect ? (
                <button type="button" onClick={() => props.onSelect!(d.key)} aria-pressed={props.selected === d.key}>
                  {body}
                </button>
              ) : (
                <div>{body}</div>
              )}
            </li>
          )
        })}
      </ol>
      <Legend items={props.series.map((s) => ({ label: s.name, color: s.color }))} />
    </div>
  )
}

/** Category × period matrix with a sequential colour ramp. Replaces the PBI heatmap matrix. */
export function HeatGrid(props: { rows: string[]; cols: string[]; value: (r: string, c: string) => number; colFmt: (c: string) => string; fmt: Fmt; label: string }) {
  const { rows, cols, value } = props
  if (!rows.length || !cols.length) return <Empty>No activity in this period.</Empty>
  const vals = rows.flatMap((r) => cols.map((c) => value(r, c)))
  const max = Math.max(0, ...vals.filter(Number.isFinite))
  const shade = (v: number) => {
    if (!Number.isFinite(v) || v <= 0 || !max) return { bg: '#ffffff', ink: '#5f716e' }
    const i = Math.min(HEAT_RAMP.length - 1, 1 + Math.floor((v / max) * (HEAT_RAMP.length - 1)))
    return { bg: HEAT_RAMP[i], ink: i >= 4 ? '#ffffff' : '#12201e' }
  }
  return (
    <div className="heat-scroll" tabIndex={0} aria-label={props.label} role="region">
      <table className="heat">
        <thead>
          <tr>
            <th scope="col">Organisation</th>
            {cols.map((c) => (
              <th key={c} scope="col">
                {props.colFmt(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th scope="row" title={r}>
                {r}
              </th>
              {cols.map((c) => {
                const v = value(r, c)
                const s = shade(v)
                return (
                  <td key={c} style={{ background: s.bg, color: s.ink }}>
                    {Number.isFinite(v) && v > 0 ? props.fmt(v) : DASH}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Frequency-weighted term list. Replaces the PBI word cloud. */
export function TermCloud({ terms, label }: { terms: { term: string; count: number }[]; label: string }) {
  if (!terms.length) return <Empty>No comments in this selection.</Empty>
  const max = terms[0].count
  return (
    <ul className="terms" aria-label={label}>
      {terms.map((t) => (
        <li key={t.term} style={{ fontSize: `${12 + Math.round((t.count / max) * 12)}px` }} title={`${t.term}: ${t.count}`}>
          {t.term}
        </li>
      ))}
    </ul>
  )
}

/** Two-line narrative headline, as the PBI card headlines. */
export function Headline({ lines, children }: { lines?: string[]; children?: ReactNode }) {
  return (
    <div className="headline">
      {lines?.[0] && <strong>{lines[0]}</strong>}
      {lines?.slice(1).map((l) => <span key={l}>{l}</span>)}
      {children}
    </div>
  )
}

const VERDICT_PATH: Record<string, string> = {
  G: 'M4 8.5l2.6 2.6L12 5.6',
  C: 'M8 3.5v9M4.5 9L8 12.5 11.5 9',
  S: 'M8 12.5v-9M4.5 7L8 3.5 11.5 7',
  N: 'M4.5 8h7',
}
const VERDICT_FILL: Record<string, string> = { G: '#09b39d', C: '#b11f4b', S: '#f1963a', N: '#c8cdd4' }

/** Model fit verdict icon. */
export function VerdictIcon({ v, label }: { v: 'G' | 'C' | 'S' | 'N'; label: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" role="img" aria-label={label} className="verdict">
      <circle cx="8" cy="8" r="8" fill={VERDICT_FILL[v]} />
      <path d={VERDICT_PATH[v]} stroke="#ffffff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Inline H/M/L mix bar for table cells. */
export function MixBar({ values, colors, label }: { values: number[]; colors: string[]; label: string }) {
  const tot = values.reduce((a, b) => a + fin(b), 0)
  if (!tot) return <span className="mix-empty">{DASH}</span>
  return (
    <span className="mix" role="img" aria-label={label}>
      {values.map((v, i) => (fin(v) > 0 ? <span key={i} style={{ flexGrow: fin(v), background: colors[i] }} /> : null))}
    </span>
  )
}
