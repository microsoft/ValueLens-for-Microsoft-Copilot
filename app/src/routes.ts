import { useEffect, useState } from 'react'

export type TabId = 'adoption' | 'habits' | 'agents' | 'value' | 'fit' | 'readiness' | 'feedback' | 'guide'

/** Filters shown in the filter bar. Anything not listed for a view is cleared when you move to it. */
export type Slicer = 'dates' | 'org' | 'lic' | 'tool' | 'agentType' | 'agent' | 'creator'

export interface ViewDef {
  id: string
  label: string
  intro?: string
  slicers?: Slicer[]
}

export interface TabDef {
  id: TabId
  label: string
  intro: string
  views: ViewDef[]
  slicers: Slicer[]
}

const BASIC: Slicer[] = ['dates', 'org']
const COHORT: Slicer[] = ['dates', 'org', 'lic', 'tool']
const AGENT: Slicer[] = ['dates', 'org', 'lic', 'tool', 'agentType', 'agent', 'creator']

export const TABS: TabDef[] = [
  {
    id: 'adoption',
    label: 'Adoption',
    intro: 'Who is active, how often they come back and where usage is growing.',
    slicers: BASIC,
    views: [
      { id: 'activation', label: 'Activation', intro: 'Active and inactive users across teams.' },
      { id: 'usage', label: 'Usage', intro: 'Sessions, depth and the kinds of work Copilot is used for.' },
      { id: 'heatmap', label: 'Heatmap', intro: 'Week-by-week activity for each organisation.', slicers: COHORT },
      { id: 'leaderboard', label: 'Leaderboard', intro: 'Organisations, people and apps ranked by sessions.' },
    ],
  },
  {
    id: 'habits',
    label: 'Habits',
    intro: 'How many days a month people use Copilot, from inactive to power user.',
    slicers: COHORT,
    views: [],
  },
  {
    id: 'agents',
    label: 'Agents',
    intro: 'The agent registry: what was built, who uses it and where each agent stands.',
    slicers: AGENT,
    views: [],
  },
  {
    id: 'value',
    label: 'Value',
    intro: 'What people use Copilot for and the time and value it is estimated to save.',
    slicers: AGENT,
    views: [
      { id: 'tasks', label: 'Tasks', intro: 'How people engage, which tasks and models they use, and the skills they reach.' },
      { id: 'estimated', label: 'Estimated value', intro: 'Expert-equivalent hours and value, using the assumptions you set.' },
      { id: 'signals', label: 'Signal map', intro: 'The audit signals and human-time estimates behind the value numbers.', slicers: [] },
    ],
  },
  {
    id: 'fit',
    label: 'Fit',
    intro: 'Whether work is going to the right tool and the right model.',
    slicers: BASIC,
    views: [
      { id: 'cowork', label: 'Cowork fit', intro: 'How well each Cowork session suits Cowork, and why.' },
      { id: 'model', label: 'Model fit', intro: 'Whether the model used matches the weight of the work.', slicers: ['dates', 'org', 'lic', 'tool', 'agentType', 'agent'] },
    ],
  },
  {
    id: 'readiness',
    label: 'Readiness',
    intro: 'Who to give a licence or Cowork next, and which seats to review.',
    slicers: BASIC,
    views: [
      { id: 'licence', label: 'Licences', intro: 'Expansion candidates from unlicensed use, and dormant seats to review.' },
      { id: 'cowork', label: 'Cowork', intro: 'People who do not use Cowork yet but work like those who do.' },
    ],
  },
  {
    id: 'feedback',
    label: 'Feedback',
    intro: 'Thumbs up, thumbs down and what people say about Copilot.',
    slicers: ['dates'],
    views: [],
  },
  {
    id: 'guide',
    label: 'Guide',
    intro: 'What each metric means and how this app maps to the Power BI report.',
    slicers: [],
    views: [],
  },
]

export interface Route {
  tab: TabDef
  view: string
  slicers: Slicer[]
}

function parse(hash: string): Route {
  const [t, v] = hash.replace(/^#\/?/, '').split('/')
  const tab = TABS.find((x) => x.id === t) ?? TABS[0]
  const vd = tab.views.find((x) => x.id === v) ?? tab.views[0]
  return { tab, view: vd?.id ?? '', slicers: vd?.slicers ?? tab.slicers }
}

export function useRoute(): [Route, (tab: TabId, view?: string) => void] {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const go = (tab: TabId, view?: string) => {
    location.hash = `/${tab}${view ? `/${view}` : ''}`
  }
  return [route, go]
}
