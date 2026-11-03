import { buildDataset } from '../../app/src/data/load'
import type { AgentInfo, Dataset, Row, Scenario } from '../../app/src/data/types'
import * as C from '../../app/src/metrics/core'
import * as P from '../../app/src/metrics/people'
import * as V from '../../app/src/metrics/value'
import * as F from '../../app/src/metrics/fit'
import * as A from '../../app/src/metrics/agents'
import * as H from '../../app/src/metrics/heatmap'

type Value = number | string | null
type Field = { name: string; label: string; table: string; kind: string; role: string; aggregate?: number | null }
type Predicate = Field & { operation: string; values: Value[] }
type Visual = { type: string; fields: Field[]; predicates?: Predicate[]; sorts?: { name: string; direction: string }[] }
type State = { from: number; to: number; team: number; license: number; tool: number; agent: number; hourly?: number; scenario?: Scenario; heatMetric?: H.HeatMetric; dimensions?: Record<string, string>; [key: string]: unknown }
type Context = { rows: Row[]; selected: Row[]; team?: string; user?: string; agent?: AgentInfo; stage?: string; month?: string; dormancy?: string; feedback?: Dataset['feedback']; dimension?: string; category?: string; shape?: string }
type Payload = { fixture: { sourceRecords: Record<string, Record<string, string>[]>; months: string[]; teams: string[]; agents: string[] }; report: { glossary: Record<string, string>[]; estimates: Record<string, string>[]; measures: Record<string, { expression: string }> } }

const div = (a: number, b: number, alternate = NaN) => b ? a / b : alternate
const normalize = (value: Value): Value => typeof value === 'number' && !Number.isFinite(value) ? null : value
const maximum = (values: string[]) => values.filter(Boolean).sort().at(-1) || ''
const pct = (value: number) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unavailable'
const datasets = new WeakMap<Payload, Dataset>()
const factDimensions: Record<string, (row: Row) => string> = {
  Organization: r => r.org, Audit_UserId: r => r.user, PersonId: r => r.user,
  AgentName: r => r.agent, AppHost: r => r.host, AppHost_Norm: r => r.host,
  Behavior_Enriched_Full: r => r.beh, Behavior_Plausible: r => r.plausible,
  Behavior_Category: r => r.behCat, Value_Outcome: r => r.outcome,
  'Task Breakdown Category': r => r.taskCat, 'Task Breakdown Group': r => r.taskGroup,
  'Cowork Task Category': r => r.coworkCat, 'Task Engagement Mode': r => r.engage,
  Efficiency_Breakdown: r => r.eff, 'Expertise Role (All Cohorts)': r => r.roleAll,
  AI_Model: r => r.model, 'Model Cost Tier': r => r.tier,
  'Agent Filter (Normalized)': r => r.tool, 'Agent Filter': r => r.tool,
  Environment: r => r.env, 'License Status': r => r.lic === 'L' ? 'M365 Copilot Licensed' : 'Unlicensed',
  WeekStart: r => r.week, 'Week Start': r => r.week, MonthStart: r => r.month,
  'Year-Month': r => r.month.slice(0, 7), Date: r => r.date,
  'Session Turn Band': r => r.t.band, Agent_Type: r => r.agentType,
  'Work Weight Grade': r => F.gradeOf(r, 'Balanced'),
  'Work Shape': r => F.shapeOf(r, 'Balanced')[0],
}

export function create(payload: Payload, state: State) {
  const raw = payload.fixture.sourceRecords
  let dataset = datasets.get(payload)
  if (!dataset) {
    dataset = buildDataset(raw.interactions, raw.users, raw.agents, raw.feedback, 'sample', 'Synthetic report fixture')
    datasets.set(payload, dataset)
  }
  const ds = dataset
  const stages = [...P.STAGES]
  const registry = new Map(ds.agents.map(a => [a.name, a]))
  const allAgentRows = C.groupBy(ds.rows, r => r.link)
  const lastSeen = A.lastSeenByName(ds.rows)
  const agentColumns = new Map(ds.agents.map(a => {
    const observedUsers = C.promptUsers(allAgentRows.get(a.titleId) || [], C.isAgent)
    return [a, {
      'Agent name': a.name, 'Agent Type Label': a.typeLabel, 'Agent type': a.typeLabel,
      'Agent creator': a.creator, Creator: a.creator, 'Agent Features': a.features, 'Title ID': a.titleId,
      'Agent Lifecycle': A.lifecycle(a, observedUsers),
      'Agent Usage Review': A.usageReview(a, observedUsers, lastSeen.get(a.name) || '', ds.maxCreation),
    } as Record<string, Value>] as const
  }))
  const agentsByName = new Map<string, AgentInfo[]>()
  for (const agent of ds.agents) agentsByName.set(agent.name, [...(agentsByName.get(agent.name) || []), agent])
  const primary = new Map([...agentsByName].map(([name, list]) => [name,
    [...list].sort((a, b) => (b.totalUsers || 0) - (a.totalUsers || 0) || a.titleId.localeCompare(b.titleId))[0],
  ]))
  const metrics = new Map<string, (c: Context) => Value>()
  const register = (name: string, fn: (c: Context) => Value) => metrics.set(name.toLowerCase(), fn)
  const from = () => `${payload.fixture.months[state.from]}-01`
  const to = () => {
    const [y, m] = payload.fixture.months[state.to].split('-').map(Number)
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  }
  const org = () => state.team < 0 ? '' : payload.fixture.teams[state.team]
  const selectedAgent = () => state.agent <= 0 ? '' : payload.fixture.agents[state.agent]
  const scenario = () => state.scenario || 'Typical'
  function dimensionValue(row: Row, field: Field): string {
    if (field.table === 'Agents 365') {
      const a = registry.get(row.agent)
      return String(a ? agentColumn(field.name, a) ?? '' : '')
    }
    const getter = factDimensions[field.name]
    if (!getter) throw new Error(`No source-backed dimension: ${field.table}[${field.name}]`)
    return getter(row)
  }
  function selectedRows() {
    return ds.rows.filter(r => r.date >= from() && r.date <= to()
      && (!org() || r.org === org())
      && (state.license < 0 || r.lic === (state.license === 0 ? 'L' : 'U'))
      && (state.tool < 0 || r.tool === ['Copilot', 'Agents', 'Cowork'][state.tool])
      && (state.agent < 0 || (state.agent === 0 ? !r.agent : r.agent === selectedAgent()))
      && Object.entries(state.dimensions || {}).every(([key, value]) => {
        const [table, name] = key.split('|')
        return table === 'ProductFeedback' || table.includes('Glossary') || table === 'Human Time Estimates' || !value || dimensionValue(r, { table, name, label: name, kind: 'column', role: 'Category' }) === value
      }))
  }
  const people = (c: Context) => [...ds.people.values()].filter(p =>
    (!org() || p.org === org()) && (!c.team || p.org === c.team) && (!c.user || p.id === c.user))
  const inventory = (c: Context) => P.activation(c.rows, people(c))
  const agents = (c: Context) => ds.agents.filter(a => (!selectedAgent() || a.name === selectedAgent()) && (!c.agent || a === c.agent)
    && Object.entries(state.dimensions || {}).every(([key, value]) => !key.startsWith('Agents 365|') || !value || agentColumn(key.split('|')[1], a) === value))
  const valueInputs = () => ({
    all: ds.rows, scenario: scenario(), hourly: state.hourly ?? 50, penalty: 1, ppupm: 30,
    windowWeeks: C.countDistinct(ds.rows.filter(r => r.date >= from() && r.date <= to()), r => r.week),
  })
  const value = (c: Context) => V.valueMeasures(c.rows, valueInputs())
  const withRows = (c: Context, rows: Row[]): Context => ({ ...c, rows })
  const evaluate = (name: string, c: Context): Value => {
    const fn = metrics.get(name.toLowerCase())
    if (!fn) throw new Error(`No source-backed implementation for measure: ${name}`)
    return normalize(fn(c))
  }
  const n = (name: string, c: Context) => Number(evaluate(name, c) ?? NaN)
  const observed = (c: Context) => C.sessions(c.rows)
  const promptCount = (c: Context) => C.aiTasks(c.rows)
  const stageStats = (c: Context, month?: string) => {
    const m = month || c.month || P.lastFullMonth(ds, from(), `${payload.fixture.months[state.to]}-01`)
    const rs = c.rows.filter(r => r.month === m)
    return P.stageCounts(rs, people(c).filter(p => p.hasLicense).length,
      P.inactiveMeasured(state.tool === 1 ? 'Agents' : state.tool === 2 ? 'Cowork' : '', state.license === 1 ? 'U' : ''))
  }
  const model = (c: Context) => F.modelStats(c.rows, 'Balanced')
  const cowork = (c: Context) => F.coworkFitKpis(c.rows, 'Balanced')
  const who = (c: Context) => F.whoStats(c.rows, 'Balanced')
  const readiness = (c: Context) => P.coworkReadinessKpis(c.rows, ds.rows)
  const dense = (values: number[], v: number) => Number.isFinite(v) ? 1 + new Set(values.filter(x => Number.isFinite(x) && x > v)).size : NaN

  register('AI Tasks', promptCount)
  register('All Active Users', c => C.activeUsers(c.rows))
  register('Active Licensed Users', c => C.activeUsers(c.rows, C.isL))
  register('Active Unlicensed Users', c => C.activeUsers(c.rows, C.isU))
  register('Active Agent Users', c => C.promptUsers(c.rows, C.isAgent))
  register('Cowork Users', c => C.activeUsers(c.rows, C.isCowork))
  register('Total Users (Filter-Aware)', c => people(c).length)
  register('Licensed Users (Filter-Aware)', c => inventory(c).licensed)
  register('Unlicensed Users (Filter-Aware)', c => inventory(c).unlicensed)
  register('Total Licensed Users', c => people(c).filter(p => p.hasLicense).length)
  register('Active Licensed Users (Verified Inventory)', c => inventory(c).usable ? inventory(c).activeL : null)
  register('Active Unlicensed Users (Verified Inventory)', c => inventory(c).usable ? inventory(c).activeU : null)
  register('Inactive Users (Filter-Aware)', c => Math.max(0, people(c).length - C.activeUsers(c.rows)))
  register('Inactive Licensed Users (Filter-Aware)', c => inventory(c).activeL <= inventory(c).licensed ? inventory(c).licensed - inventory(c).activeL : null)
  register('Inactive Unlicensed Users (Filter-Aware)', c => inventory(c).activeU <= inventory(c).unlicensed ? inventory(c).unlicensed - inventory(c).activeU : null)
  register('Using Copilot / Not Using Agents', c => Math.max(0, C.activeUsers(c.rows) - C.promptUsers(c.rows, C.isAgent)))
  for (const [name, top, bottom] of [
    ['% Active Licensed Users', 'Active Licensed Users', 'Licensed Users (Filter-Aware)'],
    ['% Active Unlicensed Users', 'Active Unlicensed Users', 'Unlicensed Users (Filter-Aware)'],
    ['% Active Users (of Total)', 'All Active Users', 'Total Users (Filter-Aware)'],
    ['% Inactive Users (of Total)', 'Inactive Users (Filter-Aware)', 'Total Users (Filter-Aware)'],
    ['% Active Users Using Agents', 'Active Agent Users', 'All Active Users'],
    ['Unlicensed Share of Active Users', 'Active Unlicensed Users', 'All Active Users'],
  ]) register(name, c => div(n(top, c), n(bottom, c), 0))
  register('% of Users by Activity', c => c.dimension === 'Total Active'
    ? div(C.activeUsers(c.rows), people(c).length, 0)
    : c.dimension === 'Total Inactive' ? div(n('Inactive Users (Filter-Aware)', c), people(c).length, 0) : 1)
  for (const [name, lens] of [['Overall', 'overall'], ['Licensed', 'licensed'], ['Unlicensed', 'unlicensed'], ['Agents', 'agent']] as const)
    register(`Activation ${name} Headline`, c => P.activationHeadline(inventory(c), lens))
  for (const [prefix, lens] of [['', 'overall'], ['Licensed ', 'licensed'], ['Unlicensed ', 'unlicensed'], ['Agent ', 'agent'], ['Cowork ', 'cowork']] as const) {
    register(`Observed ${prefix}Sessions`, c => C.sessions(c.rows, C.LENS_PRED[lens]))
    register(`Observed ${prefix}Sessions per User`, c => C.sessionsPerUser(c.rows, lens))
    register(`Observed ${prefix}Sessions per User per Week`, c => C.sessionsPerUserPerWeek(c.rows, lens))
  }
  register('Agent AI Tasks', c => C.aiTasks(c.rows, C.isAgent))
  register('Unlicensed AI Tasks', c => C.aiTasks(c.rows, C.isU))
  register('Cowork AI Tasks', c => C.aiTasks(c.rows, C.isCowork))
  register('Agent Return Rate', c => C.returnRate(c.rows, C.isAgent))
  register('Expert Equivalent Hours', c => value(c).hours)
  register('Expert Equivalent Hours Per Week', c => value(c).hoursPerWeek)
  register('Cowork Expert Equivalent Hours Per Week', c => value(withRows(c, c.rows.filter(C.isCowork))).hoursPerWeek)
  register('AI Assisted Value', c => value(c).value)
  register('AI Assisted Value Per Week', c => value(c).valuePerWeek)
  register('Projected Annualised Value', c => value(c).annualised)
  register('Copilot License Investment', c => value(c).investment)
  register('Net ROI', c => value(c).roi)
  register('Cowork Hours (Task Category Basis)', c => V.coworkHours(c.rows, scenario()))
  register('Top Value Outcome', c => V.topOutcome(c.rows, ds.rows, scenario()))
  register('Cowork Top Value Outcome', c => V.topOutcome(c.rows.filter(C.isCowork), ds.rows, scenario()))
  register('Executive Headline', c => V.executiveHeadline(c.rows, valueInputs()).join('\n'))
  register('Skills Headline', c => V.skillsHeadline(c.rows, { cowork: state.tool === 2, agent: state.tool === 1, lic: state.license === 0 ? 'L' : state.license === 1 ? 'U' : '' }).join('\n'))
  register('Activity Share', c => div(promptCount(c), C.aiTasks(c.selected), 0))
  register('Usage Mode Share', c => div(promptCount(c), C.aiTasks(c.selected), 0))
  register('% of Users in Stage', c => div(C.promptUsers(c.rows), C.promptUsers(c.selected), 0))
  register('Stage Top Org', c => V.topOrg(c.rows))
  for (const stage of stages) {
    const label = P.STAGE_LABEL[stage]
    register(`${label} Users, Last Month`, c => stageStats(c)[stage])
    register(`${label} Users %, Last Month`, c => div(stageStats(c)[stage], stageStats(c).base, 0))
  }
  register('Stage Users, Last Month', c => c.stage ? stageStats(c)[c.stage as P.Stage] : null)
  register('Stage Users (Monthly)', c => c.stage ? stageStats(c, c.month)[c.stage as P.Stage] : null)
  register('User Active Days, Last Month', c => C.countDistinct(c.rows.filter(r => r.month === P.lastFullMonth(ds, from(), `${payload.fixture.months[state.to]}-01`)), r => r.date))
  register('User Stage, Last Month', c => P.stageOf(n('User Active Days, Last Month', c)))
  register('Agent Registry Records', c => agents(c).length)
  register('Agents Built In Tenant', c => A.builtInTenant(agents(c)))
  register('Agents With Observed Activity', c => agents(c).filter(a => C.sessions(A.agentRows(c.rows, a), C.isAgent) > 0).length)
  register('Agent Registry Freshness', c => A.registryFreshness(agents(c)))
  register('Agent Last Observed Activity', c => A.agentStats(c.rows).lastObserved)
  register('Agent Orgs', c => A.agentStats(c.rows).orgs)
  register('Agent Description (Selected)', c => c.agent?.description || registry.get(selectedAgent())?.description || 'Select one registry agent to see its supplied description.')
  register('Agent Audit Linkage Note', c => A.linkageNote(n('Agents With Observed Activity', c), ds.agents.length))
  register('Most Popular Agent Creator (Shared - Agent Builder)', c => A.mostPopularCreator(c.rows, ds.agents))
  register('Most Versatile Agent', c => A.mostVersatile(c.rows))
  for (const key of ['Sessions', 'Well-matched Sessions', 'Over-specified Sessions', 'Under-specified Sessions', 'Not Judged Sessions'] as const) {
    const prop = { Sessions: 'sessions', 'Well-matched Sessions': 'well', 'Over-specified Sessions': 'over', 'Under-specified Sessions': 'under', 'Not Judged Sessions': 'notJudged' }[key] as keyof F.ModelStats
    register(`Model: ${key}`, c => Number(model(c)[prop]))
  }
  for (const [name, prop] of [['Judged Share', 'judged'], ['Well-matched Share', 'well'], ['Over-specified Share', 'over'], ['Under-specified Share', 'under']] as const)
    register(`Model: ${name}`, c => div(model(c)[prop], name === 'Judged Share' ? model(c).sessions : model(c).judged))
  register('Model: Logged Session Share', c => F.loggedShare(c.rows))
  register('Model: Usage Share', c => div(model(c).sessions, F.modelStats(c.selected, 'Balanced').sessions))
  register('Model: Verdict Icon', c => F.VERDICT_LABEL[model(c).verdict])
  register('Model: Main Model', c => F.mainModel(c.rows))
  register('Model: Main Reason', c => F.mainReason(c.rows, 'Balanced'))
  register('Model: Coverage Notice', c => F.coverageNotice(c.rows, 'Balanced'))
  register('Usage Efficiency: Consumption Sessions', c => cowork(c).sessions)
  register('Usage Efficiency: Consumption Tasks', c => cowork(c).tasks)
  register('Usage Efficiency: Active Days Per User', c => cowork(c).daysPerUser)
  register('Usage Efficiency: Graded Tasks', c => cowork(c).graded)
  register('Usage Efficiency: High Fit Share', c => cowork(c).high)
  register('Usage Efficiency: Low Fit Share', c => cowork(c).low)
  register('Usage Efficiency: Task Grade Share', c => F.cwSessions(c.rows) ? div(cowork(c).graded, F.cwGraded(c.selected.filter(r =>
    (c.category === undefined || r.coworkCat === c.category) && (c.shape === undefined || F.shapeOf(r, 'Balanced')[0] === c.shape)), 'Balanced')) : null)
  register('Usage Efficiency: Share Of Work', c => !F.cwSessions(c.rows) ? null : div(cowork(c).graded, c.category !== undefined
    ? [...C.groupBy(c.selected, r => r.coworkCat).values()].reduce((s, rs) => s + F.cwGraded(rs, 'Balanced'), 0)
    : F.cwGraded(c.selected, 'Balanced')))
  register('Usage Efficiency: Fit Icon', c => {
    const k = cowork(c)
    return k.graded ? `Strong ${pct(k.high)} / Fair ${pct(1 - k.high - k.low)} / Worth a look ${pct(k.low)}` : null
  })
  register('Usage Efficiency: Fit Rule Notice', c => F.fitRuleNotice(c.rows, 'Balanced').text)
  register('Usage Efficiency: Fit Basis', c => {
    const grouped = C.groupBy(c.rows.filter(C.isCowork), r => F.basisOf(r, 'Balanced'))
    const counts = [...grouped].map(([label, rs]) => ({ label, count: F.cwSessions(rs) })).sort((a, b) => b.count - a.count || b.label.localeCompare(a.label))
    return counts.length ? `${counts[0].label} (${pct(div(counts[0].count, counts.reduce((s, x) => s + x.count, 0)))})` : null
  })
  for (const [name, prop] of [['Evidence Files', 'm'], ['Evidence Kinds', 'b']] as const)
    register(`Usage Efficiency: ${name}`, c => C.median([...C.groupBy(c.rows.filter(C.isCowork), r => r.thread).values()].map(rs => rs[0].t[prop])))
  register('Usage Efficiency: Alternative Tool', c => F.whyRows(c.rows, c.selected, 'Balanced').map(x => x.alt).find(Boolean) || null)
  for (const [name, prop] of [['Who Graded Sessions', 'graded'], ['Who High Share', 'high'], ['Who Medium Share', 'medium'], ['Who Low Share', 'low'], ['Who People', 'people']] as const)
    register(`Usage Efficiency: ${name}`, c => name === 'Who People' && c.user ? null : who(c)?.[prop] ?? null)
  register('Usage Efficiency: Who Flag', c => who(c)?.flagged ? `Flag ${who(c)?.flagged}` : null)
  register('Usage Efficiency: Who Mix', c => who(c) ? `Strong ${pct(who(c)!.high)} / Fair ${pct(who(c)!.medium)} / Worth a look ${pct(who(c)!.low)}` : null)
  register('Cowork Fit: Eligible Users', c => readiness(c).eligible)
  register('Cowork Fit: Session Depth', c => readiness(c).depth)
  register('Cowork Fit: Surfaces Per Active Day', c => readiness(c).surfaces)
  register('Cowork Fit: Agent User Share', c => readiness(c).agentShare)
  register('Cowork Readiness: Surfaces Per Day', c => P.surfacesPerDay(c.rows))
  register('Cowork Readiness: Prompts Per Session', c => C.promptsPerSession(c.rows, C.notCowork))
  register('Cowork Readiness Rank (Dynamic)', c => {
    const all = P.readinessUsers(c.selected)
    const local = all.filter(x => (!c.user || x.user === c.user) && (!c.team || x.org === c.team))
    if (!local.length) return null
    if (c.user) return dense(all.filter(x => !c.team || x.org === c.team).map(x => x.score), local[0].score)
    const grouped = new Map<string, number[]>()
    for (const x of all) grouped.set(x.org, [...(grouped.get(x.org) || []), x.score])
    return dense([...grouped.values()].map(xs => Math.round(C.mean(xs))), Math.round(C.mean(local.map(x => x.score))))
  })
  register('Median Unlicensed Sessions Per User Per Week', c => P.medianUnlicensedSessionsPW(c.rows))
  register('Average Active Days Per User Per Week (Unlicensed Chat)', c => P.avgUnlicensedDaysPW(c.rows))
  register('License Priority Score (User)', c => P.groupPriority([...P.unlicensedCandidates(c.rows).values()]).score)
  register('License Priority Rank (Dynamic)', c => {
    const candidates = P.unlicensedCandidates(c.selected)
    const localScore = n('License Priority Score (User)', c)
    if (c.user) return dense([...candidates.values()].filter(x => !c.team || ds.people.get(x.id)?.org === c.team).map(x => x.score), localScore)
    return dense([...C.groupBy(c.selected, r => r.org).values()].map(rs => P.groupPriority([...P.unlicensedCandidates(rs).values()]).score), localScore)
  })
  register('Licensed Seats by Dormancy (Verified)', c => inventory(c).usable ? P.dormancy(ds, people(c)).counts.get(c.dormancy || '') ?? people(c).filter(p => p.hasLicense).length : null)
  register('Licensed Inactive 30d+', c => inventory(c).usable ? P.dormancy(ds, people(c)).inactive30 : null)
  register('Avg Days Since Last Active', c => inventory(c).usable ? P.dormancy(ds, people(c)).avgDays : null)
  register('License Evidence Notice', c => P.evidenceNotice(ds, inventory(c).usable))
  register('Reclaim Cost Notice', c => P.reclaimNotice(inventory(c).usable, 0, '£'))
  register('Total Feedback', c => (c.feedback || selectedFeedback()).length)
  register('Thumbs Up Count', c => (c.feedback || selectedFeedback()).filter(x => x.type === 'Thumbs Up').length)
  register('Thumbs Down Count', c => (c.feedback || selectedFeedback()).filter(x => x.type === 'Thumbs Down').length)
  register('Satisfaction Rate', c => div(n('Thumbs Up Count', c), n('Total Feedback', c), 0))
  register('📊 Feedback Theme Summary', c => {
    const fs = c.feedback || selectedFeedback()
    const groups = new Map<string, Dataset['feedback']>()
    for (const f of fs) if (!['🧪 Testing', '❓ Uncategorized'].includes(f.category)) groups.set(f.category, [...(groups.get(f.category) || []), f])
    const items = [...groups].map(([name, list]) => ({ name, count: list.length, up: list.filter(x => x.type === 'Thumbs Up').length, down: list.filter(x => x.type === 'Thumbs Down').length }))
    const best = items.filter(x => x.up).sort((a, b) => b.up / b.count - a.up / a.count || b.name.localeCompare(a.name))[0]
    const worst = items.filter(x => x.down).sort((a, b) => b.down - a.down || b.name.localeCompare(a.name))[0]
    return fs.length ? `${fs.length} feedback items across ${items.length} topics: ${pct(n('Satisfaction Rate', c))} overall satisfaction. ${best ? `Strongest theme is ${best.name} at ${pct(best.up / best.count)} satisfaction (${best.count} items).` : ''} ${worst ? `Most negative feedback is in ${worst.name} (${worst.down} thumbs down).` : ''}` : 'No feedback data in current selection.'
  })
  register('Heatmap Headline', c => {
    return H.heatHeadline([...C.groupBy(c.rows, r => r.org)].map(([org, rs]) => ({ org, value: H.heatValue(rs, state.heatMetric || 'users', ds.rows, scenario()) })), state.heatMetric || 'users')
  })
  register('Average Active Days Per User (Chat + Agents)', c => H.heatValue(c.rows, 'days', ds.rows, scenario()))
  register('Efficiency - Hours Per User Per Week', c => {
    const weeks = [...new Set(ds.rows.filter(r => r.date >= from() && r.date <= to()).map(r => r.week))]
    return C.mean(weeks.map(w => {
      const rs = c.rows.filter(r => r.week === w)
      return div(V.eeh(rs, ds.rows, scenario()), new Set(rs.map(r => r.user)).size, 0)
    }))
  })
  register('Page Description (Selected)', () => {
    const page = state.dimensions?.['📖 Metric Glossary|Page']
    const descriptions = new Set(payload.report.glossary.filter(x => !page || x.page === page).map(x => x.pageDescription))
    return descriptions.size === 1 ? [...descriptions][0] : 'Definitions for the current preview. Select a page at the right, or browse all metrics below.'
  })

  function selectedFeedback() {
    return ds.feedback.filter(f => f.date >= from() && f.date <= to()
      && Object.entries(state.dimensions || {}).every(([key, value]) => !key.startsWith('ProductFeedback|') || !value || feedbackColumn(key.split('|')[1], f) === value))
  }
  function agentColumn(name: string, a: AgentInfo): Value {
    const cols = agentColumns.get(a)!
    if (!(name in cols)) throw new Error(`No registry column: ${name}`)
    return cols[name]
  }
  function feedbackColumn(name: string, f: Dataset['feedback'][number]): string {
    const cols: Record<string, string> = { FeedbackEmoji: f.emoji, 'Surface / Agent': f.surface, MonthStart: f.month, Comment: f.comment, 'Date Submitted Date': f.date }
    if (!(name in cols)) throw new Error(`No feedback column: ${name}`)
    return cols[name]
  }
  function context(rows = selectedRows()): Context { return { rows, selected: rows } }
  function measure(name: string, rows?: Row[]) { return evaluate(name, context(rows)) }
  function fieldValue(field: Field, c: Context): Value {
    if (field.kind === 'measure') return evaluate(field.name, c)
    if (field.aggregate != null) {
      const values = field.table === 'Agents 365' ? agents(c).map(a => agentColumn(field.name, a))
        : field.table === 'ProductFeedback' ? (c.feedback || selectedFeedback()).map(f => feedbackColumn(field.name, f))
        : c.rows.map(r => dimensionValue(r, field))
      const present = values.filter(v => v != null && v !== '')
      if (field.aggregate === 2) return new Set(present).size
      if (field.aggregate === 1) return C.mean(present.map(Number))
      if (field.aggregate === 3) return present.sort((a, b) => String(a).localeCompare(String(b)))[0] ?? null
      if (field.aggregate === 4) return present.sort((a, b) => String(b).localeCompare(String(a)))[0] ?? null
      throw new Error(`Unsupported source aggregation ${field.aggregate}: ${field.name}`)
    }
    if (field.name === 'Active Agents') return agents(c).filter(a => C.sessions(A.agentRows(c.rows, a), C.isAgent)).length
    if (field.name === 'Agent Creators') return A.activeCreators(c.rows, agents(c))
    if (field.name === 'User Count') return C.promptUsers(c.rows)
    if (field.name === 'Count of Comment') return c.feedback?.length || selectedFeedback().length
    if (field.name === '# Active Users') return C.activeUsers(c.rows)
    if (field.table === 'Agents 365' && c.agent) return agentColumn(field.name, c.agent)
    if (field.name === 'Agent type') return agents(c).length === 1 ? agents(c)[0].typeLabel : 'Multiple types'
    if (field.name === 'Agent Creator') return A.mostPopularCreator(c.rows, agents(c))
    const getter = factDimensions[field.name]
    if (getter) return maximum(c.rows.map(getter))
    throw new Error(`No source-backed field binding for ${field.table}[${field.name}]`)
  }
  function visualData(visual: Visual) {
    const predicates = visual.predicates || []
    function passes(p: Predicate, value: Value | boolean): boolean {
      if (p.operation === 'in' || p.operation === 'notIn') {
        const found = p.values.some(v => v == null ? value == null || value === '' : v === value)
        return p.operation === 'in' ? found : !found
      }
      if (p.operation === 'contains' || p.operation === 'notContains') {
        const found = String(value).includes(String(p.values[0]))
        return p.operation === 'contains' ? found : !found
      }
      const n = Number(value), target = Number(p.values[0])
      return p.operation === 'compare1' ? n > target : p.operation === 'compare2' ? n >= target : p.operation === 'compare3' ? n < target : p.operation === 'compare4' ? n <= target : n === target
    }
    const selected = selectedRows().filter(r => predicates.filter(p => p.kind !== 'measure' && p.aggregate == null).every(p => p.name === 'Is Primary Agent'
      ? primary.get(r.agent)?.titleId === r.link
      : passes(p, dimensionValue(r, p))))
    const base = context(selected)
    const fields = visual.fields
    const measureFields = fields.filter(f => f.kind === 'measure' || f.aggregate != null)
    const isCard = ['cardvisual', 'card', 'kpicard'].includes(visual.type.toLowerCase())
    if (isCard) return { columns: fields.map(f => f.label || f.name), data: [fields.map(f => normalize(fieldValue(f, base)))], fields }
    const dims = fields.filter(f => !measureFields.includes(f))
    if (!dims.length) return { columns: measureFields.map(f => f.label || f.name), data: [measureFields.map(f => fieldValue(f, base))], fields }
    if (dims[0].table.includes('Glossary')) {
      const entries = payload.report.glossary.filter(x => Object.entries(state.dimensions || {}).every(([key, value]) => !key.includes('Glossary|') || !value || x[key.split('|')[1].toLowerCase()] === value))
      return { columns: fields.map(f => f.label || f.name), data: entries.map(x => fields.map(f => x[f.name.toLowerCase()] || x[f.name] || '')), fields }
    }
    if (dims[0].table === 'Behavior Value Map' || dims[0].table === 'Human Time Estimates') {
      const map: Record<string, string> = { Signal: 'signal', Behavior: 'behavior', 'Use Case': 'useCase', Description: 'description', 'Value Outcome': 'valueOutcome', 'Human Baseline (min)': 'baseline', 'Primary Source': 'source' }
      const entries = V.BEHAVIOURS.filter(b => !state.dimensions?.['Human Time Estimates|Category'] || V.ESTIMATES.some(e => e.behavior === b.behavior && e.category === state.dimensions?.['Human Time Estimates|Category']))
      return { columns: fields.map(f => f.label || f.name), data: entries.map(b => fields.map(f => (b as unknown as Record<string, Value>)[map[f.name]] ?? (V.ESTIMATES.find(e => e.behavior === b.behavior) as unknown as Record<string, Value>)?.[map[f.name]] ?? '')), fields }
    }
    if (dims.some(f => f.table === 'Agents 365')) {
      const rows = agents(base).map(a => {
        const c = { ...base, agent: a, rows: A.agentRows(selected, a) }
        return [...dims.map(f => fieldValue(f, c)), ...measureFields.map(f => fieldValue(f, c))]
      })
      if (dims.length === 1 && dims[0].name === 'Agent Lifecycle') {
        const counts = new Map<string, number>()
        rows.forEach(r => counts.set(String(r[0]), (counts.get(String(r[0])) || 0) + 1))
        return { columns: [...dims, ...measureFields].map(f => f.label || f.name), data: [...counts], fields: [...dims, ...measureFields] }
      }
      return { columns: [...dims, ...measureFields].map(f => f.label || f.name), data: rows, fields: [...dims, ...measureFields] }
    }
    if (dims.some(f => f.name === 'Dormancy Bucket')) {
      return { columns: ['Dormancy Bucket', ...measureFields.map(f => f.label || f.name)], data: [...P.DORMANCY].map(dormancy => [dormancy, ...measureFields.map(f => fieldValue(f, { ...base, dormancy }))]), fields: [...dims, ...measureFields] }
    }
    if (dims.some(f => f.table === 'Activity (Legend)')) {
      return { columns: ['Activity', ...measureFields.map(f => f.label || f.name)], data: ['Total Active', 'Total Inactive'].map(dimension => [dimension, ...measureFields.map(f => fieldValue(f, { ...base, dimension }))]), fields: [...dims, ...measureFields] }
    }
    if (dims.some(f => f.table === 'ProductFeedback')) {
      const groups = new Map<string, { labels: string[]; feedback: Dataset['feedback'] }>()
      for (const f of selectedFeedback()) {
        const labels = dims.map(d => feedbackColumn(d.name, f))
        const key = JSON.stringify(labels)
        const entry = groups.get(key) || { labels, feedback: [] }
        entry.feedback.push(f)
        groups.set(key, entry)
      }
      return { columns: [...dims, ...measureFields].map(f => f.label || f.name), data: [...groups.values()].map(g => [...g.labels, ...measureFields.map(f => fieldValue(f, { ...base, feedback: g.feedback }))]), fields: [...dims, ...measureFields] }
    }
    const groupDimensions = dims.filter(f => f.name !== 'Stage Top Org')
    const groups = new Map<string, { labels: string[]; rows: Row[]; c: Partial<Context> }>()
    const stageDimension = dims.some(f => f.name === 'Stage')
    for (const row of selected) {
      const labels = groupDimensions.map(f => f.name === 'Stage' ? '' : dimensionValue(row, f))
      const key = JSON.stringify(labels)
      const entry = groups.get(key) || { labels, rows: [], c: {} }
      entry.rows.push(row)
      groupDimensions.forEach((f, index) => {
        if (f.name === 'Organization') entry.c.team = labels[index]
        if (['Audit_UserId', 'PersonId'].includes(f.name)) entry.c.user = labels[index]
        if (f.name === 'AgentName') entry.c.agent = registry.get(labels[index])
        if (['Year-Month', 'MonthStart'].includes(f.name)) entry.c.month = `${labels[index].slice(0, 7)}-01`
        if (f.name === 'Cowork Task Category') entry.c.category = labels[index]
        if (f.name === 'Work Shape') entry.c.shape = labels[index]
      })
      groups.set(key, entry)
    }
    // Roster-backed activation categories include teams with no activity.
    if (groupDimensions.length === 1 && groupDimensions[0].name === 'Organization'
      && measureFields.some(f => ['Inactive Licensed Users (Filter-Aware)', 'Inactive Unlicensed Users (Filter-Aware)', 'Inactive Users (Filter-Aware)'].includes(f.name))) {
      for (const p of people(base)) if (!groups.has(JSON.stringify([p.org]))) groups.set(JSON.stringify([p.org]), { labels: [p.org], rows: [], c: { team: p.org } })
    }
    const data: Value[][] = []
    for (const group of groups.values()) {
      for (const stage of stageDimension ? stages : ['']) {
        const c = { ...base, ...group.c, rows: group.rows, ...(stage ? { stage } : {}) }
        const labels = group.labels.map((label, index) => groupDimensions[index].name === 'Stage' ? stage : label)
        if (!predicates.filter(p => p.kind === 'measure' || p.aggregate != null).every(p => passes(p, fieldValue(p, c)))) continue
        const values = measureFields.map(f => visual.type === 'heatmap' ? H.heatValue(c.rows, state.heatMetric || 'users', ds.rows, scenario()) : fieldValue(f, c))
        if (values.length && values.filter((_, i) => measureFields[i].role !== 'Tooltips').every(v => v == null || v === '')) continue
        data.push([...labels, ...values])
      }
    }
    const ordered = [...groupDimensions, ...measureFields]
    const time = groupDimensions.some(f => ['WeekStart', 'Week Start', 'MonthStart', 'Year-Month'].includes(f.name))
    data.sort((a, b) => time ? String(a[0]).localeCompare(String(b[0])) : typeof a[dims.length] === 'number' && typeof b[dims.length] === 'number' ? Number(b[dims.length]) - Number(a[dims.length]) : String(a[0]).localeCompare(String(b[0])))
    return { columns: ordered.map(f => f.label || f.name), data, fields: ordered }
  }
  function filterOptions(field: Field): string[] {
    if (field.table.includes('Glossary')) return [...new Set(payload.report.glossary.map(x => x[field.name.toLowerCase()]))].filter(Boolean).sort()
    if (field.table === 'Human Time Estimates' && field.name === 'Category') return [...new Set(V.ESTIMATES.map(e => e.category))].sort()
    if (field.table === 'Agents 365') return [...new Set(ds.agents.map(a => String(agentColumn(field.name, a) || '')))].filter(Boolean).sort()
    if (field.table === 'ProductFeedback') return [...new Set(ds.feedback.map(f => feedbackColumn(field.name, f)))].filter(Boolean).sort()
    return [...new Set(ds.rows.map(r => dimensionValue(r, field)))].filter(Boolean).sort()
  }
  function canFilter(field: Field): boolean {
    return field.table === 'Agents 365' || field.table === 'ProductFeedback' || field.name in factDimensions
  }
  function sortedVisualData(visual: Visual) {
    const result = visualData(visual)
    if (visual.sorts?.length) result.data.sort((a, b) => {
      for (const sort of visual.sorts || []) {
        const index = result.fields.findIndex(f => f.name === sort.name)
        if (index < 0) continue
        const comparison = typeof a[index] === 'number' && typeof b[index] === 'number'
          ? Number(a[index]) - Number(b[index]) : String(a[index] ?? '').localeCompare(String(b[index] ?? ''))
        if (comparison) return sort.direction === 'Descending' ? -comparison : comparison
      }
      return 0
    })
    return result
  }
  return { ds, selectedRows, measure, visualData: sortedVisualData, filterOptions, canFilter, supported: (name: string) => metrics.has(name.toLowerCase()) }
}
