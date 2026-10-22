import type { Feedback } from '../data/types'
import { FEEDBACK_EXCLUDED } from '../data/load'

// ---------- Product feedback ----------

export function satisfaction(fb: Feedback[]) {
  const up = fb.filter((f) => f.type === 'Thumbs Up').length
  const down = fb.filter((f) => f.type === 'Thumbs Down').length
  return { total: fb.length, up, down, rate: fb.length ? up / fb.length : 0 }
}

export function themeStats(fb: Feedback[]) {
  return [...groupByF(fb, (f) => f.category)]
    .filter(([c]) => !FEEDBACK_EXCLUDED.includes(c))
    .map(([category, list]) => ({ category, ...satisfaction(list) }))
}

export function groupByF<T>(xs: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of xs) {
    const k = f(x)
    let l = m.get(k)
    if (!l) m.set(k, (l = []))
    l.push(x)
  }
  return m
}

export function themeSummary(fb: Feedback[]): string {
  if (!fb.length) return 'No feedback data in current selection.'
  const s = satisfaction(fb)
  const cats = themeStats(fb)
  const pct0 = (n: number) => `${Math.round(n * 100)}%`
  const f0 = (n: number) => n.toLocaleString('en-GB')
  const neg = cats.filter((c) => c.down > 0).sort((a, b) => b.down - a.down)
  const pos = cats.filter((c) => c.up > 0).sort((a, b) => b.rate - a.rate)
  const overall = `${f0(s.total)} feedback items across ${f0(cats.length)} topics: ${pct0(s.rate)} overall satisfaction.`
  const posLine = pos.length ? `Strongest theme is ${pos[0].category} at ${pct0(pos[0].rate)} satisfaction (${f0(pos[0].total)} items).` : ''
  const negLine = neg.length
    ? `Most negative feedback is in ${neg[0].category} (${f0(neg[0].down)} thumbs down, ${pct0(neg[0].rate)} sat.)${
        neg[1] ? `, followed by ${neg[1].category} (${f0(neg[1].down)} thumbs down).` : '.'
      }`
    : ''
  return [overall, posLine, negLine].filter(Boolean).join(' ')
}

const STOP = new Set(
  'a an and are as at be but by can could do for from has have how i if in is it its me my no not of on or our so that the this to too was we what when which will with would you your please just like get also use using want need copilot'.split(
    ' ',
  ),
)
/** Word cloud terms: comment words (3+ letters, no stop words) by frequency. */
export function terms(fb: Feedback[], limit = 40): { term: string; count: number }[] {
  const c = new Map<string, number>()
  for (const f of fb)
    for (const w of f.comment.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
      if (STOP.has(w)) continue
      c.set(w, (c.get(w) ?? 0) + 1)
    }
  return [...c]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit)
}
