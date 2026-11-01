import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

/**
 * A definition behind an "i" button. Hover or focus shows it; a click or tap pins it open
 * until a second click, a tap elsewhere, Escape or moving focus away.
 */
export function InfoTip({ text, label }: { text?: string; label: string }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const id = useId()
  useEffect(() => {
    if (!pinned) return
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setPinned(false)
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [pinned])
  if (!text) return null
  const close = () => {
    setPinned(false)
    setOpen(false)
  }
  return (
    <span ref={root} className="info" onMouseEnter={() => setOpen(true)} onMouseLeave={() => !pinned && setOpen(false)}>
      <button
        type="button"
        className="info-btn"
        aria-label={`About ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={() => {
          if (pinned) close()
          else {
            setPinned(true)
            setOpen(true)
          }
        }}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        i
      </button>
      {open && (
        <span role="tooltip" id={id} className="info-pop">
          {text}
        </span>
      )}
    </span>
  )
}

export function Panel(props: {
  title: string
  note?: string
  help?: string
  actions?: ReactNode
  children: ReactNode
  span?: 1 | 2 | 3
  className?: string
}) {
  return (
    <section className={`panel span-${props.span ?? 1} ${props.className ?? ''}`} aria-label={props.title}>
      <header className="panel-head">
        <div>
          <h3>
            {props.title}
            <InfoTip text={props.help} label={props.title} />
          </h3>
          {props.note && <p className="panel-note">{props.note}</p>}
        </div>
        {props.actions}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}

export interface KpiProps {
  label: string
  value: string
  sub?: ReactNode
  help?: string
  tone?: 'licensed' | 'unlicensed' | 'agent' | 'cowork' | 'neutral'
  trend?: number
  wide?: boolean
  /** A category colour for the dot, when the KPI stands for one series of a chart nearby. */
  dot?: string
}

export function Kpi({ label, value, sub, help, tone = 'neutral', trend, wide, dot }: KpiProps) {
  const dir = trend === undefined || !Number.isFinite(trend) ? '' : trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'
  return (
    <div className={`kpi tone-${tone} ${wide ? 'kpi-wide' : ''}`} style={dot ? ({ '--kpi-dot': dot } as CSSProperties) : undefined}>
      <div className="kpi-label">
        <span>{label}</span>
        <InfoTip text={help} label={label} />
      </div>
      <div className={`kpi-value ${dir ? `trend-${dir}` : ''} ${value.length > 18 ? 'kpi-value-text' : ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

export const KpiRow = ({ children }: { children: ReactNode }) => <div className="kpi-row">{children}</div>
export const Grid = ({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) => (
  <div className={`grid grid-${cols}`}>{children}</div>
)

export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
  /** Id of the tabpanel these tabs control, when there is one. */
  controls?: string
}) {
  const list = useRef<HTMLDivElement>(null)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = props.options.length
    const at = props.options.findIndex((o) => o.id === props.value)
    const to =
      e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to < 0) return
    e.preventDefault()
    props.onChange(props.options[to].id)
    list.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[to]?.focus()
  }
  return (
    <div ref={list} className="segmented" role="tablist" aria-label={props.label} onKeyDown={onKey}>
      {props.options.map((o) => {
        const on = props.value === o.id
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={props.controls}
            tabIndex={on ? 0 : -1}
            className={on ? 'on' : ''}
            onClick={() => props.onChange(o.id)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Select(props: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  allLabel?: string
}) {
  const id = useId()
  return (
    <label className={`field ${props.value ? 'field-set' : ''}`} htmlFor={id}>
      <span>{props.label}</span>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.allLabel !== undefined && <option value="">{props.allLabel}</option>}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className="swatch" style={{ background: i.color }} />
          {i.label}
          {i.value && <b>{i.value}</b>}
        </li>
      ))}
    </ul>
  )
}
