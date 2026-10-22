import estimates from '../data/estimates.json'
import { FRONTIER, GRADINGS, NOT_ATTRIBUTED, WORKHORSE, type Grading, type Row } from '../data/types'
import { aiPrompts, countDistinct, groupBy, median, ratio } from './core'

export type Grade = 'Strong fit' | 'Fair fit' | 'Worth a look' | 'Unclassified'
export const GRADES: Grade[] = ['Strong fit', 'Fair fit', 'Worth a look']
export const GRADE_SHORT: Record<Grade, string> = { 'Strong fit': 'Strong', 'Fair fit': 'Fair', 'Worth a look': 'Worth a look', Unclassified: 'Unclassified' }

const stepOf = (r: Row, g: Grading) => r.fit[GRADINGS.indexOf(g)]

/** Work Weight Grade from the Fit Rule Step. */
export function gradeOf(r: Row, g: Grading): Grade {
  const s = stepOf(r, g)
  if (s >= 1 && s <= 3) return 'Strong fit'
  if (s === 5 || s === 8 || s === 9 || s === 10) return 'Fair fit'
  if (s === 4 || s === 6) return 'Worth a look'
  return 'Unclassified'
}

const SHAPES: Record<number, [string, number]> = {
  1: ['Cross-app chain', 1],
  2: ['Builds an artifact', 2],
  3: ['Multi-source synthesis', 3],
  5: ['Moderate sourcing', 4],
  10: ['Single-app task', 5],
  6: ['Single-app task', 5],
  8: ['Read messages', 6],
  9: ['Longer chat', 7],
  4: ['Chat only', 8],
}
/** Work Shape and its sort order. */
export function shapeOf(r: Row, g: Grading): [string, number] {
  return SHAPES[stepOf(r, g)] ?? ['Not enough detail', 9]
}

/** Fit Basis: the evidence sentence behind a grade. */
export function basisOf(r: Row, g: Grading): string {
  switch (stepOf(r, g)) {
    case 1:
      return `Spans ${r.t.list}`
    case 2:
      return 'Built or packaged an artifact'
    case 3:
      return 'Multi-source synthesis'
    case 4:
      return 'Chat only - nothing attached'
    case 5:
      return 'Mixed or repeated sources'
    case 6:
      return `${r.t.list} Copilot could have done it`
    case 8:
      return 'Read messages - nothing attached'
    case 9:
      return 'Longer chat - nothing attached'
    case 10:
      return `Worked in one app (${r.t.list})`
    default:
      return 'Insufficient evidence'
  }
}

// ---------- Cowork Fit (Usage Efficiency measures) ----------

const cw = (rs: Row[]) => rs.filter((r) => r.tool === 'Cowork')
/** Consumption Sessions: distinct Cowork threads. */
export const cwSessions = (rs: Row[]) => countDistinct(cw(rs), (r) => r.thread)
export const cwSessionsWhere = (rs: Row[], g: Grading, grades: Grade[]) => countDistinct(cw(rs), (r) => (grades.includes(gradeOf(r, g)) ? r.thread : ''))
export const cwGraded = (rs: Row[], g: Grading) => cwSessionsWhere(rs, g, GRADES)

export interface CoworkFitKpis {
  sessions: number
  tasks: number
  daysPerUser: number
  high: number
  low: number
  graded: number
  unclassified: number
}

export function coworkFitKpis(rs: Row[], g: Grading): CoworkFitKpis {
  const c = cw(rs)
  const users = groupBy(
    c.filter((r) => r.user),
    (r) => r.user,
  )
  let days = 0
  for (const list of users.values()) days += countDistinct(list, (r) => r.date)
  const graded = cwGraded(rs, g)
  return {
    sessions: cwSessions(rs),
    tasks: aiPrompts(c),
    daysPerUser: users.size ? days / users.size : NaN,
    high: ratio(cwSessionsWhere(rs, g, ['Strong fit']), graded),
    low: ratio(cwSessionsWhere(rs, g, ['Worth a look']), graded),
    graded,
    unclassified: cwSessionsWhere(rs, g, ['Unclassified']),
  }
}

/** WHAT: grade share within each Cowork task category. */
export function gradeShareByCategory(rs: Row[], g: Grading) {
  return [...groupBy(cw(rs), (r) => r.coworkCat)]
    .filter(([k]) => k)
    .map(([cat, list]) => {
      const graded = cwGraded(list, g)
      return {
        key: cat,
        graded,
        values: GRADES.map((gr) => ratio(cwSessionsWhere(list, g, [gr]), graded) || 0),
      }
    })
    .filter((d) => d.graded > 0)
    .sort((a, b) => b.graded - a.graded)
}

const HTE_BY_COWORK = new Map<string, Set<string>>()
const HTE_ALL = new Set<string>()
for (const e of estimates as { behavior: string; coworkCategory: string }[]) {
  let s = HTE_BY_COWORK.get(e.coworkCategory)
  if (!s) HTE_BY_COWORK.set(e.coworkCategory, (s = new Set()))
  s.add(e.behavior)
  HTE_ALL.add(e.behavior)
}

export interface WhyRow {
  id: string
  grade: Grade
  shape: string
  sort: number
  mix: [number, number, number]
  sessions: number
  basis: string
  alt: string
  share: number
  files: number
  kinds: number
}

const compactCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : n.toLocaleString('en-GB'))

/**
 * WHY: grade → shape rows with the Fit Basis, alternative tool and evidence medians.
 * `scope` is the selection with the Cowork-irrelevant filters lifted, used by Alternative Tool;
 * `cat` is the Cowork task category picked in the WHAT chart, if any.
 */
export function whyRows(rs: Row[], scope: Row[], g: Grading, cat = ''): WhyRow[] {
  const c = cw(rs)
  const total = cwGraded(rs, g)
  const out: WhyRow[] = []
  const behs = cat ? (HTE_BY_COWORK.get(cat) ?? new Set<string>()) : HTE_ALL
  const altPrompts = aiPrompts(scope, (r) => r.tool === 'Copilot' && behs.has(r.behCat))
  for (const [grade, gl] of groupBy(c, (r) => gradeOf(r, g))) {
    if (grade === 'Unclassified') continue
    for (const [shape, list] of groupBy(gl, (r) => shapeOf(r, g)[0])) {
      const sessions = countDistinct(list, (r) => r.thread)
      const bases = groupBy(list, (r) => basisOf(r, g))
      let top = ''
      let topN = 0
      let n = 0
      for (const [b, bl] of bases) {
        const k = countDistinct(bl, (r) => r.thread)
        n += k
        if (k > topN) {
          topN = k
          top = b
        }
      }
      const thr = groupBy(list, (r) => r.thread)
      const low = grade === 'Worth a look' ? sessions : 0
      const alt = low ? altPrompts : 0
      const h = grade === 'Strong fit' ? sessions : 0
      const m = grade === 'Fair fit' ? sessions : 0
      out.push({
        id: `${grade}|${shape}`,
        grade,
        shape,
        sort: shapeOf(list[0], g)[1],
        mix: [h, m, low],
        sessions,
        basis: n ? `${top} (${Math.round((topN / n) * 100)}%)` : '',
        alt: alt ? `Copilot Chat (${compactCount(alt)} similar)` : '',
        share: ratio(sessions, total),
        files: median([...thr.values()].map((l) => l[0].t.m)),
        kinds: median([...thr.values()].map((l) => l[0].t.b)),
      })
    }
  }
  return out.sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade) || a.sort - b.sort)
}

export interface WhoStats {
  graded: number
  high: number
  medium: number
  low: number
  people: number
  flagged: number
}

/** WHO: graded Cowork sessions for a group of rows (5+ to show), with the share mix and flags. */
export function whoStats(rs: Row[], g: Grading): WhoStats | null {
  const graded = cwGraded(rs, g)
  if (graded < 5) return null
  let people = 0
  let flagged = 0
  for (const list of groupBy(cw(rs), (r) => r.user).values()) {
    const n = cwGraded(list, g)
    if (n >= 5) {
      people++
      if (cwSessionsWhere(list, g, ['Worth a look']) / n >= 0.5) flagged++
    }
  }
  return {
    graded,
    high: cwSessionsWhere(rs, g, ['Strong fit']) / graded,
    medium: cwSessionsWhere(rs, g, ['Fair fit']) / graded,
    low: cwSessionsWhere(rs, g, ['Worth a look']) / graded,
    people,
    flagged,
  }
}

const FAIR: Record<Grading, string> = {
  Strict: 'some sources',
  Balanced: 'some sources, messages read or one app',
  Lenient: 'some sources, messages read, one app or a longer chat',
}
const WORTH: Record<Grading, string> = {
  Strict: 'chat only or one app',
  Balanced: 'chat with nothing read or attached',
  Lenient: 'a one-turn chat with nothing read or attached',
}

export function fitRuleNotice(rs: Row[], g: Grading): { rules: [string, string][]; text: string } {
  const graded = cwGraded(rs, g)
  const un = cwSessionsWhere(rs, g, ['Unclassified'])
  const rules: [string, string][] = [
    ['Strong', 'spans apps, builds a file or uses many sources'],
    ['Fair', FAIR[g]],
    ['Worth a look', WORTH[g]],
  ]
  if (!graded) return { rules, text: 'Nothing in this selection carries enough detail to assess.' }
  return {
    rules,
    text: `We see what a session touched, not prompts or answer quality: a flag is a coaching prompt, not a verdict. ${graded.toLocaleString('en-GB')} graded${
      un ? `; ${un.toLocaleString('en-GB')} too light to grade` : ''
    }. Grading: ${g} (Assumptions).`,
  }
}

// ---------- Model Fit ----------

export interface ModelStats {
  sessions: number
  judged: number
  over: number
  under: number
  well: number
  notJudged: number
  verdict: 'G' | 'C' | 'S' | 'N'
}

const threads = (rs: Row[], p: (r: Row) => boolean) => countDistinct(rs, (r) => (p(r) ? r.thread : ''))

export function modelStats(rs: Row[], g: Grading): ModelStats {
  const sessions = threads(rs, () => true)
  const judgedP = (r: Row) => (r.t.tier === FRONTIER || r.t.tier === WORKHORSE) && gradeOf(r, g) !== 'Unclassified'
  const judged = threads(rs, judgedP)
  const over = threads(rs, (r) => r.t.tier === FRONTIER && gradeOf(r, g) === 'Worth a look')
  const under = threads(rs, (r) => r.t.tier === WORKHORSE && gradeOf(r, g) === 'Strong fit')
  const well = judged ? judged - over - under : 0
  const verdict = judged < 5 ? 'N' : well >= over && well >= under ? 'G' : over >= under ? 'C' : 'S'
  return { sessions, judged, over, under, well, notJudged: Math.max(0, sessions - judged), verdict }
}

export const VERDICT_LABEL: Record<ModelStats['verdict'], string> = {
  G: 'Good match',
  C: 'Lighter model may do',
  S: 'Try stronger',
  N: 'Too few judged',
}

export function loggedShare(rs: Row[]) {
  const s = threads(rs, () => true)
  return ratio(
    threads(rs, (r) => r.t.tier !== NOT_ATTRIBUTED),
    s,
  )
}
export const attributionCoverage = (rs: Row[]) => ratio(aiPrompts(rs, (r) => r.tier !== NOT_ATTRIBUTED), aiPrompts(rs))

/** Model: Main Model: the most-used logged model, with its share of model-named sessions. */
export function mainModel(rs: Row[]): string {
  const counts = [...groupBy(rs, (r) => r.model)]
    .filter(([m]) => m && !m.startsWith('Embedded'))
    .map(([m, list]) => [m, countDistinct(list, (r) => r.thread)] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const tot = counts.reduce((a, [, n]) => a + n, 0)
  if (!tot) return ''
  const [nm, n] = counts[0]
  const cut = nm.indexOf(' (')
  return `${cut > 0 ? nm.slice(0, cut) : nm} · ${Math.round((n / tot) * 100)}%`
}

/** Model: Main Reason: the work shape behind most mismatches. */
export function mainReason(rs: Row[], g: Grading): string {
  const counts = [...groupBy(rs, (r) => shapeOf(r, g)[0])]
    .map(([s, list]) => {
      const m = modelStats(list, g)
      return [s, m.over + m.under] as const
    })
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const tot = counts.reduce((a, [, n]) => a + n, 0)
  return tot ? `${counts[0][0]} · ${Math.round((counts[0][1] / tot) * 100)}%` : ''
}

export function coverageNotice(rs: Row[], g: Grading): string {
  const s = threads(rs, () => true)
  if (!s) return 'No activity in this selection.'
  const ls = loggedShare(rs)
  if (!ls) return 'No session here carries a model name, so model fit cannot be judged.'
  const pct = (n: number) => `${Math.round((n || 0) * 100)}%`
  return `Verdict = the most common of the three (grey = under 5 judged). Same fit grade as Cowork Fit (${g} grading, set in Assumptions); a session is judged only when its model is logged and it has a grade. Model logged on ${pct(ls)} of sessions (${pct(
    attributionCoverage(rs),
  )} of prompts). A prompt to test, not a quality score.`
}
