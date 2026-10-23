import { useMemo } from 'react'
import { useData } from '../data/store'
import { gloss } from '../data/glossary'
import { activeUsers, denseRank, groupBy, isU, mean, sessionsPerUserPerWeek } from '../metrics/core'
import {
  activation,
  allCoworkUsers,
  avgUnlicensedDaysPW,
  coworkReadinessKpis,
  DORMANCY,
  dormancy,
  eligibleUsers,
  evidenceNotice,
  groupPriority,
  medianUnlicensedSessionsPW,
  readinessUsers,
  reclaimNotice,
  roster,
  surfacesPerDay,
  unlicensedCandidates,
  unlicensedShare,
} from '../metrics/people'
import { BarList, Scatter } from '../ui/charts'
import { DataTable, type Column, type TableRow } from '../ui/DataTable'
import { groupByF } from '../metrics/feedback'
import { dec1, dec2, int, pct } from '../ui/format'
import { Kpi, KpiRow, Panel } from '../ui/primitives'
import { COLOR, DORMANCY_COLOR } from '../ui/theme'
import { usePersonLabel } from './cols'
import { useMoney } from './common'

const P = 'License Prioritisation'
const PR = 'License & Cowork Readiness'

interface RankRec {
  label: string
  sub?: string
  rank: number
  score: number
  a: number
  b: number
  c: number
}

const rankCol = (help: string): Column<RankRec> => ({ key: 'rank', label: 'Rank', value: (r) => r.rank, fmt: int, align: 'right', width: '8%', help })
const nameCol = (label: string): Column<RankRec> => ({
  key: 'label',
  label,
  width: '30%',
  value: (r) => r.label,
  render: (r) => (
    <span className="name-cell">
      <span>{r.label}</span>
      {r.sub && <small>{r.sub}</small>}
    </span>
  ),
})

// ---------- Licence readiness ----------

export function ReadinessLicence() {
  const { ds, base, filters, assumptions } = useData()
  const person = usePersonLabel()
  const money = useMoney()
  const d = useMemo(() => {
    const people = roster(ds, filters.org)
    const usable = activation(base, people).usable
    const cands = unlicensedCandidates(base)
    const byOrg = [...groupBy(base, (r) => r.org)].filter(([o]) => o)
    const orgs = byOrg
      .map(([org, rs]) => {
        const list = [...unlicensedCandidates(rs).values()]
        return { org, rs, list, g: groupPriority(list) }
      })
      .filter((o) => o.list.length > 0)
    const orgRank = denseRank(orgs.map((o) => o.g.score).filter(Number.isFinite))
    const table: TableRow<RankRec>[] = orgs.map((o) => {
      const scores = o.list.map((c) => c.score).filter(Number.isFinite)
      const userRank = denseRank(scores)
      return {
        id: o.org,
        data: { label: o.org, rank: Number.isFinite(o.g.score) ? orgRank(o.g.score) : NaN, score: o.g.score, a: o.g.medianSessionsPW, b: o.g.avgDaysPW, c: o.list.length },
        children: o.list.map((c) => ({
          id: `${o.org}::${c.id}`,
          data: { ...person(c.id), rank: Number.isFinite(c.score) ? userRank(c.score) : NaN, score: c.score, a: c.stats.sessionsPW, b: c.stats.daysPW, c: c.stats.tasksPW },
        })),
      }
    })
    const scatter = orgs.map((o) => ({
      key: o.org,
      label: o.org,
      x: o.g.avgDaysPW,
      y: sessionsPerUserPerWeek(o.rs, 'unlicensed'),
      size: activeUsers(o.rs, isU),
    }))
    const dm = dormancy(ds, people)
    return {
      usable,
      activeU: activeUsers(base, isU),
      share: unlicensedShare(base),
      medianS: medianUnlicensedSessionsPW(base),
      spuw: sessionsPerUserPerWeek(base, 'unlicensed'),
      avgDays: avgUnlicensedDaysPW(base),
      cands: cands.size,
      table,
      scatter,
      licensed: people.filter((p) => p.hasLicense).length,
      dm,
      dorm: DORMANCY.map((b, i) => ({ key: b, label: b, value: dm.counts.get(b) ?? 0, color: DORMANCY_COLOR[i] })),
      evidence: evidenceNotice(ds, usable),
      reclaim: reclaimNotice(usable, assumptions.licenceCost, assumptions.currency),
    }
  }, [ds, base, filters.org, person, assumptions.licenceCost, assumptions.currency])
  const n = (v: number) => (d.usable ? v : NaN)
  const cols: Column<RankRec>[] = [
    nameCol('Organisation / person'),
    rankCol('Rank 1 = strongest licence candidate, recalculated against the current selection.'),
    { key: 'score', label: 'Priority score', value: (r) => r.score, fmt: int, align: 'right', bar: COLOR.unlicensed, help: gloss('Review priority', P) },
    { key: 'a', label: 'Sessions / week', value: (r) => r.a, fmt: dec1, align: 'right', help: 'Median unlicensed sessions per user per active week.' },
    { key: 'b', label: 'Active days / week', value: (r) => r.b, fmt: dec1, align: 'right', help: gloss('Active days', P) },
    { key: 'c', label: 'Users · tasks / week', value: (r) => r.c, fmt: dec1, align: 'right', help: 'Organisation rows: unlicensed users scored. Person rows: unlicensed task events per active week.' },
  ]
  return (
    <>
      <h3 className="section-title">Who to licence next</h3>
      <KpiRow>
        <Kpi tone="unlicensed" label="Active unlicensed users" value={int(d.activeU)} sub={`${int(d.cands)} scored`} help={gloss('Unlicensed sessions', P)} />
        <Kpi tone="unlicensed" label="Unlicensed share of active users" value={pct(d.share)} help={gloss('License readiness', PR)} />
        <Kpi tone="unlicensed" label="Median sessions per week" value={dec1(d.medianS)} sub="per unlicensed user" />
        <Kpi tone="unlicensed" label="Sessions per user per week" value={dec1(d.spuw)} sub={`${dec1(d.avgDays)} active days per week`} />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="Licence candidates by priority" note="Organisations, then people" help={gloss('Review priority', P)}>
          <DataTable label="Licence candidates by priority" columns={cols} rows={d.table} initialSort={{ key: 'rank' }} search={(r) => `${r.label} ${r.sub ?? ''}`} childNoun="organisations or people" />
          <p className="panel-foot">
            Priority score weights median unlicensed task events per week (60%) and median active days per week (40%), capped at 30 events and 5 days. Only users with unlicensed activity in the selection are scored, so a blank score means no
            evidence, not a low score. Rank is recalculated against whatever is selected. Task events count prompt rows, not verified completed outcomes.
          </p>
        </Panel>
        <Panel title="Where unlicensed demand sits" note="Bubble size = active unlicensed users">
          <Scatter
            label="Unlicensed demand by organisation"
            points={d.scatter}
            color={COLOR.unlicensed}
            xLabel="Active days per user per week"
            yLabel="Sessions per user per week"
            sizeLabel="Active unlicensed users"
            xFmt={dec1}
            yFmt={dec1}
          />
        </Panel>
      </div>
      <h3 className="section-title">Licences to reclaim</h3>
      <KpiRow>
        <Kpi tone="licensed" label="Total licensed users" value={int(d.licensed)} />
        <Kpi tone="licensed" label="Licensed, inactive 30+ days" value={int(n(d.dm.inactive30))} />
        <Kpi tone="licensed" label="Average days since active" value={dec1(n(d.dm.avgDays))} />
        <Kpi tone="licensed" label="Reclaimable value per month" value={money(n(d.dm.inactive30 * assumptions.licenceCost))} sub={assumptions.licenceCost > 0 ? undefined : 'Set a licence cost in Assumptions'} />
      </KpiRow>
      <Panel title="Licensed seats by dormancy" note="Days since last active, against the audit window">
        {d.usable ? <BarList label="Licensed seats by dormancy" items={d.dorm} color={COLOR.licensed} keepOrder /> : null}
        <p className="panel-foot">{d.evidence}</p>
        <p className="panel-foot">{d.reclaim}</p>
      </Panel>
    </>
  )
}

// ---------- Cowork readiness ----------

export function ReadinessCowork() {
  const { ds, base } = useData()
  const person = usePersonLabel()
  const d = useMemo(() => {
    const cw = allCoworkUsers(ds.rows)
    const users = readinessUsers(base).filter((u) => !cw.has(u.user))
    const rank = denseRank(users.map((u) => u.score))
    const byOrg = groupByF(users, (u) => u.org)
    const orgRows = [...groupBy(base, (r) => r.org)]
      .filter(([o]) => o)
      .map(([org, rs]) => ({ org, rs, eligible: eligibleUsers(rs, ds.rows), users: byOrg.get(org) ?? [] }))
      .filter((o) => o.eligible > 0 && o.users.length > 0)
    const orgScore = (o: (typeof orgRows)[number]) => Math.round(mean(o.users.map((u) => u.score)))
    const orgRank = denseRank(orgRows.map(orgScore))
    const table: TableRow<RankRec>[] = orgRows.map((o) => {
      const k = coworkReadinessKpis(o.rs, ds.rows)
      const s = orgScore(o)
      return {
        id: o.org,
        data: { label: o.org, rank: orgRank(s), score: s, a: k.surfaces, b: k.depth, c: k.agentShare },
        children: o.users.map((u) => ({ id: `${o.org}::${u.user}`, data: { ...person(u.user), rank: rank(u.score), score: u.score, a: u.b, b: u.d, c: u.a } })),
      }
    })
    const scatter = orgRows.map((o) => {
      const el = o.rs.filter((r) => !cw.has(r.user))
      return { key: o.org, label: o.org, x: surfacesPerDay(el), y: coworkReadinessKpis(o.rs, ds.rows).depth, size: o.eligible }
    })
    return { k: coworkReadinessKpis(base, ds.rows), table, scatter }
  }, [ds, base, person])
  const cols: Column<RankRec>[] = [
    nameCol('Organisation / person'),
    rankCol('Rank 1 = strongest Cowork candidate, recalculated against the current selection.'),
    { key: 'score', label: 'Readiness score', value: (r) => r.score, fmt: int, align: 'right', bar: COLOR.cowork, help: gloss('Cowork readiness', PR) },
    { key: 'a', label: 'Apps per day', value: (r) => r.a, fmt: dec2, align: 'right', help: 'Cross-app breadth: distinct apps used per active day, outside Cowork.' },
    { key: 'b', label: 'Prompts per session', value: (r) => r.b, fmt: dec2, align: 'right', help: 'Session depth, outside Cowork.' },
    { key: 'c', label: 'Agent use', value: (r) => r.c, fmt: pct, align: 'right', help: 'Organisation rows: share of eligible users with an agent session. Person rows: 100% if they have used an agent.' },
  ]
  return (
    <>
      <KpiRow>
        <Kpi tone="cowork" label="Eligible users" value={int(d.k.eligible)} sub="Active, never used Cowork" help={gloss('Cowork readiness', PR)} />
        <Kpi tone="cowork" label="Prompts per session" value={dec2(d.k.depth)} />
        <Kpi tone="cowork" label="Apps per active day" value={dec2(d.k.surfaces)} />
        <Kpi tone="cowork" label="Using agents" value={pct(d.k.agentShare)} sub="of eligible users" />
      </KpiRow>
      <div className="grid grid-2">
        <Panel title="Cowork candidates by readiness" note="Organisations, then people">
          <DataTable label="Cowork candidates by readiness" columns={cols} rows={d.table} initialSort={{ key: 'rank' }} search={(r) => `${r.label} ${r.sub ?? ''}`} childNoun="organisations or people" />
          <p className="panel-foot">
            Rank 1 = strongest Cowork candidate. Cowork readiness score = cross-app breadth (45%) + session depth (35%) + existing agent use (20%), each scaled to the highest value in the current selection. Existing Cowork users are
            excluded, so organisations where everyone already uses Cowork have no candidates left and are not listed.
          </p>
        </Panel>
        <Panel title="Cowork readiness map" note="Top right = readiest">
          <Scatter label="Cowork readiness by organisation" points={d.scatter} color={COLOR.cowork} xLabel="Apps per active day" yLabel="Prompts per session" sizeLabel="Eligible users" xFmt={dec2} yFmt={dec2} />
          <p className="panel-foot">
            Top right = users already working across several apps each day (right) and holding longer, multi-prompt sessions (up). Bubble size = eligible candidate users. Breadth and depth are 80% of the score; each is scaled to the
            highest value in the current selection, not an external benchmark.
          </p>
        </Panel>
      </div>
    </>
  )
}
