import { useData } from '../data/store'
import { GRADINGS, SCENARIOS, type Grading, type Scenario } from '../data/types'
import { Sheet } from './Sheet'

const CURRENCIES = ['£', '$', '€', '¥', 'A$', 'C$', 'CHF ', 'kr ', '₹']

/** The report's editable parameters: Hourly Value, Assumptions (PPUPM, licence cost, penalty), Effort Scenario and Fit Grading. */
export function AssumptionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { assumptions: a, setAssumption } = useData()
  const num = (v: string, min = 0) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(min, n) : min
  }
  return (
    <Sheet open={open} onClose={onClose} title="Assumptions">
      <form className="assume" onSubmit={(e) => e.preventDefault()}>
        <p>These values drive the estimated value, ROI and licence measures. Change them to match your organisation; they apply straight away and are not saved.</p>
        <div className="field">
          <label htmlFor="as-hourly">Hourly value of time</label>
          <input id="as-hourly" type="number" min={0} step={1} value={a.hourly} onChange={(e) => setAssumption('hourly', num(e.target.value))} />
          <small>Loaded cost of one hour of an employee's time.</small>
        </div>
        <div className="field field-set">
          <label htmlFor="as-currency">Currency symbol</label>
          <select id="as-currency" value={a.currency} onChange={(e) => setAssumption('currency', e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c.trim()}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="as-ppupm">Price per user per month</label>
          <input id="as-ppupm" type="number" min={0} step={0.5} value={a.ppupm} onChange={(e) => setAssumption('ppupm', num(e.target.value))} />
          <small>Copilot licence price used for investment and ROI.</small>
        </div>
        <div className="field">
          <label htmlFor="as-cost">Licence cost for reclaim</label>
          <input id="as-cost" type="number" min={0} step={0.5} value={a.licenceCost} onChange={(e) => setAssumption('licenceCost', num(e.target.value))} />
          <small>Monthly cost per licence used on the Licence view. Leave at 0 to hide the cost line.</small>
        </div>
        <div className="field">
          <label htmlFor="as-penalty">Time-saved penalty</label>
          <input id="as-penalty" type="number" min={0} max={1} step={0.05} value={a.penalty} onChange={(e) => setAssumption('penalty', Math.min(1, num(e.target.value)))} />
          <small>Multiplier from 0 to 1 applied to the estimated value to be cautious. 1 means no penalty.</small>
        </div>
        <div className="field field-set">
          <label htmlFor="as-scenario">Effort scenario</label>
          <select id="as-scenario" value={a.scenario} onChange={(e) => setAssumption('scenario', e.target.value as Scenario)}>
            {SCENARIOS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <small>Which minutes-saved estimate to use for each behaviour and Cowork task.</small>
        </div>
        <div className="field field-set">
          <label htmlFor="as-grading">Work weight grading</label>
          <select id="as-grading" value={a.grading} onChange={(e) => setAssumption('grading', e.target.value as Grading)}>
            {GRADINGS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <small>How strictly Cowork sessions are graded on the Fit tab.</small>
        </div>
      </form>
    </Sheet>
  )
}
