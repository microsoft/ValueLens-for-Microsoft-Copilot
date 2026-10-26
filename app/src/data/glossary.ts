import raw from './glossary.json'

export interface GlossaryEntry {
  page: string
  pageDescription: string
  metric: string
  description: string
  pageOrder: number
  metricOrder: number
}

/**
 * The glossary is generated from the Power BI model, so it keeps that report's wording. The app
 * shows it in plain UK English: report jargon swapped for everyday words, and UK spellings.
 */
const PLAIN: [RegExp, string][] = [
  [/The same field parameter controls the matrix and headline, including the Sessions option\./g, 'One measure picker drives both the heatmap and its headline, Sessions included.'],
  [/Results depend on coverage and valid denominators\./g, 'Results depend on how complete the data is.'],
  [/an invalid denominator/g, 'nothing to divide by'],
  [/\b([Oo])rganization/g, '$1rganisation'],
  [/\b([Bb])ehavior(?!_)/g, '$1ehaviour'],
  [/\b([Ll])abor\b/g, '$1abour'],
  [/\b([Ll])icense(?!d)/g, '$1icence'],
  [/\b([Ss])ummariz/g, '$1ummaris'],
  [/\b([Aa])nalyz/g, '$1nalys'],
  [/\b([Pp])rioritiz/g, '$1rioritis'],
]
export const plain = (s: string) => PLAIN.reduce((t, [re, to]) => t.replace(re, to), s)

export const GLOSSARY = (raw as GlossaryEntry[]).map((g) => ({ ...g, description: plain(g.description), pageDescription: plain(g.pageDescription) }))

/** Looks up a metric description, preferring a match on the given PBI page. */
export function gloss(metric: string, page?: string): string | undefined {
  const m = metric.toLowerCase()
  const hits = GLOSSARY.filter((g) => g.metric.toLowerCase() === m)
  return (page ? hits.find((g) => g.page.toLowerCase().includes(page.toLowerCase())) : undefined)?.description ?? hits[0]?.description
}
