# Data dictionary

The nine Delta tables Consumption Central reads, and what each column means. A tenth,
[`copilot_payg_spend`](#copilot_payg_spend), is read only by the model the Fabric installer deploys.

If you build your own pipeline instead of using the notebooks, match this and the template works
unchanged. The tables are deliberately close to the source exports — renamed to `snake_case` and
typed, but not reshaped — so you can compare a table against the CSV it came from without a
translation step.

**Every table is optional.** A missing table is a supported state: the pages for that product come
up empty and every other page is unaffected. A customer with GitHub Copilot but no Copilot Studio
loads the same template and simply sees no Studio pages populated. Nothing needs commenting out.

Every table also carries **`_loaded_at`** (timestamp), written by the ingester. Not used by the
report; useful when a number looks wrong and you need to know when it arrived.

---

## `viva_credits_weekly`

Cowork and Work IQ credit consumption. **One row per person × service × policy × week.** Absent it,
the Cowork pages are empty and the rest of the report is unaffected. `Ingest_Viva_Consumption`
fills it from the Viva Insights Dataflow's staging table, `viva_credits_dataflow` (every column
text, replaced each refresh), and from CSV exports. For weeks both cover, the Dataflow's rows win.

| Column | Type | Notes |
|---|---|---|
| `person_id` | string | **Join key.** The real UPN on an identified export, the hashed ID on a de-identified one. |
| `user_principal_name` | string | Identified exports only; null otherwise |
| `entra_id` | string | Identified exports only |
| `people_historical_id` | string | De-identified exports only; joins to the person map |
| `service_id` | string | |
| `service_name` | string | `Cowork` or `Work IQ API`. Treat as an open list — Microsoft is adding services. |
| `spending_policy_id` | string | All-zero GUID = usage recorded outside any policy window |
| `metric_date` | date | Week start |
| `session_count` | int | |
| `spending_policy_limit` | long | The policy's monthly pool, carried inline on every row |
| `credits_used` | double | |
| `user_limit` | long | Per-person cap, where the policy sets one |

**Merge key:** `person_id`, `service_id`, `spending_policy_id`, `metric_date`.

All four are needed. A person can hold rows under two policies in the same week — their own, and the
all-zero GUID for usage outside a policy window — and dropping the policy from the key would collapse
those into one and lose credits.

---

## `viva_spending_policy`

Policy names and limits. One row per policy. Optional: without it, policies show as GUIDs but
pricing is unaffected, because the limits already travel inline on the metrics rows.

| Column | Type | Notes |
|---|---|---|
| `spending_policy_id` | string | |
| `name` | string | `(Unassigned)` for the all-zero GUID row, which has no name in the export |
| `plan_limit` | long | Monthly credit budget for the whole policy |
| `user_limit` | long | Optional per-person cap within it |
| `included_services` | string | e.g. `Cowork;WorkIQ` |

**Load:** full replace. Small and slow-moving.

---

## `studio_tenant_daily`

Copilot Studio consumption. One row per environment × billing plan × capacity type × day. **The only
Studio table with a real date**, and so the only one Consumption Central plots over time.

| Column | Type | Notes |
|---|---|---|
| `billing_plan_id` | string | All-zero GUID where no plan applies |
| `billing_plan_name` | string | Often blank |
| `environment_id` | string | |
| `environment_name` | string | |
| `capacity_type` | string | e.g. `MCSMessages` |
| `source_file` | string | Which export the row came from — matters when several environments are exported separately |
| `entitled_quantity` | double | Prepaid entitlement |
| `prepaid_consumed` | double | Drawn from prepaid capacity |
| `payg_consumed` | double | Billed pay-as-you-go |
| `usage_date` | date | Parsed from PPAC's `M/d/yyyy H:mm` |

**Merge key:** `usage_date`, `environment_id`, `billing_plan_id`, `capacity_type`.

Rows from the licensing API flow have `source_file = 'ppac-api'` and the all-zero
`billing_plan_id`. They fill only the days and environments no export covers. They split each
day's credits by the tenant-wide prepaid share from the latest entitlement snapshot (all prepaid
without one), and `entitled_quantity` is the environment's allocation.

---

## `studio_agent_daily`

Per-agent consumption by day, from the optional `Analytics Hub - Copilot Studio credits` flow,
which calls the Power Platform licensing API. Empty without the flow. Only environments with
Copilot Studio credits allocated appear, and there are no per-user figures.

| Column | Type | Notes |
|---|---|---|
| `usage_date` | date | |
| `agent_id` | string | |
| `agent_name` | string | |
| `environment_id` | string | |
| `environment_name` | string | From the entitlement snapshot when the call has none |
| `billable_feature` | string | |
| `channel` | string | |
| `billed_credit` | double | |
| `non_billed_credit` | double | |
| `users` | double | Distinct users on the day, where the API gives it |
| `llm_model`, `tool_used`, `knowledge_sources` | string | Comma-separated, sorted |
| `source_file` | string | Always `ppac-api` |

**Merge key:** `usage_date`, `agent_id`, `billable_feature`, `channel`, `environment_id`. Each
file restates the last ten days, so those days are replaced.

For months no export covers, `studio_agent` also gets a `ppac-api` row per agent, summed from
this table. An export for the month replaces them.

---

## `studio_agent`

Per-agent consumption. **The export carries no date** — it is a month-to-date aggregate — so the
ingester stamps `snapshot_month` and merges on it.

| Column | Type | Notes |
|---|---|---|
| `snapshot_month` | date | Added by the ingester. First of the month the export represents. |
| `agent_name` | string | |
| `agent_id` | string | |
| `product` | string | e.g. `Copilot Studio` |
| `billable_feature` | string | From `AI Feature/Billable Feature` |
| `billed_credit` | double | Chargeable |
| `non_billed_credit` | double | Absorbed by entitlement |
| `channel` | string | e.g. `M365 Copilot` |
| `knowledge_sources` | string | |
| `tool_used` | string | |
| `llm_model` | string | |
| `scenario_name` | string | |
| `environment_id` | string | |
| `environment_name` | string | |
| `source_file` | string | Which export this came from — lineage, useful when several environments export separately |

**Merge key:** `snapshot_month`, `agent_id`, `billable_feature`, `channel`, `environment_id`.

An agent appears once per feature per channel per environment, so all of those belong in the key.

> **`agent_name` and `environment_name` are frequently blank.** Power Automate flows have no agent
> name in PPAC — in the sample dataset 419 of 448 rows are blank. `agent_id` is always populated, so
> nothing is lost, but the agent and environment slicers list only named agents. Those rows still
> count in every total.

> **Read these as cumulative, not incremental.** Two snapshots in the same month show growth to date,
> not new consumption. Consumption Central therefore treats them as period totals and never plots them on a
> time axis — which is also why the Studio forecast extends a daily run rate rather than fitting a
> curve.
>
> **The template reads the LATEST `snapshot_month` only.** Once you have run the ingester twice, an
> agent has a row per snapshot; summing them would multiply that agent's credits by the number of
> months loaded, and each of those rows is already a month-to-date total. The history is kept
> because it is worth having, not because the report adds it up.

---

## `studio_user`

Per-user consumption. Same no-date caveat as `studio_agent`.

| Column | Type | Notes |
|---|---|---|
| `snapshot_month` | date | Added by the ingester |
| `user_id` | string | |
| `user_email` | string | Lowercased. **Joins to `org_attributes.user_principal_name`.** |
| `agent_id` | string | |
| `agent_name` | string | |
| `billable_credit_used` | double | |
| `credits_used` | double | |
| `m365_copilot_licensed` | boolean | Parsed from the export's text |
| `source_file` | string | Lineage |

**Merge key:** `snapshot_month`, `user_id`, `agent_id`.

> **This will not add up to the tenant total, and that is correct.** Agent and environment
> consumption carries no user, so the per-user total is always smaller. Consumption Central computes the gap
> and states it on the page rather than hiding it.

---

## `github_ai_usage`

GitHub Copilot AI credit consumption. Person × day, further split by SKU and model.

| Column | Type | Notes |
|---|---|---|
| `usage_date` | date | UTC |
| `username` | string | GitHub login, lowercased |
| `product` | string | e.g. `copilot` |
| `sku` | string | e.g. `coding_agent_ai_credit` |
| `model` | string | e.g. `claude-sonnet-4` |
| `quantity` | double | |
| `unit_type` | string | e.g. `ai-credits` |
| `applied_cost_per_quantity` | double | $0.01 per credit at publication |
| `gross_amount` | double | Before the included allowance |
| `discount_amount` | double | Absorbed by the allowance |
| `net_amount` | double | **What you actually pay** |
| `total_monthly_quota` | double | CSV only — absent from the API |
| `organization` | string | |
| `repository` | string | CSV only — absent from the AI-credit API |
| `cost_center_name` | string | Where cost centres are configured |

**Merge key:** `usage_date`, `username`, `sku`, `model`, `repository` (CSV) or
`usage_date`, `username`, `sku`, `model` (API — no repository).

> **Code completions never appear here.** They are unlimited on every paid plan and are not billed,
> so a highly active developer can consume zero credits. This table is spend, not activity.

---

## `github_user_map`

GitHub seats. One row per developer. Needed for seat cost, which is usually the larger half of the
GitHub bill.

| Column | Type | Notes |
|---|---|---|
| `username` | string | GitHub login, lowercased. Joins to `github_ai_usage`. |
| `user_principal_name` | string | **Joins to `org_attributes`.** GitHub does not know this — see below. |
| `display_name` | string | |
| `plan` | string | Must read exactly `Copilot Business` or `Copilot Enterprise` |
| `included_credits` | long | Per-seat monthly allowance |

**Load:** full replace. Current state — someone who moved plan should appear once, on the current one.

> **`plan` must match exactly.** The seat-price measure keys on the string, so an unexpected spelling
> silently prices everyone as Business. Both ingesters warn if they see anything else.
>
> **`user_principal_name` is not something GitHub holds.** If your enterprise uses SAML SSO,
> `GET /enterprises/{e}/consumed-licenses` returns `saml_name_id`, which is usually the UPN — the API
> notebook does this automatically. Otherwise maintain a mapping table. Do not guess from the email
> pattern: it is wrong often enough to misattribute cost to the wrong department, which is worse than
> having no department at all.

---

## `org_attributes`

Department, cost centre and so on. One row per person. Optional, but it is what turns consumption
into chargeback.

| Column | Type | Standard Entra? |
|---|---|---|
| `user_principal_name` | string | ✅ **Join key**, lowercased and trimmed |
| `display_name` | string | ✅ |
| `department` | string | ✅ |
| `job_title` | string | ✅ |
| `job_family` | string | ❌ Extension attribute |
| `city` | string | ✅ |
| `country` | string | ✅ |
| `cost_center` | string | ❌ Extension attribute |
| `manager` | string | ⚠️ Standard property, but not in the classic bulk download |
| `business_unit` | string | ❌ Extension attribute |

**Load:** full replace. Current state, not history — someone who changed department should appear
once, in their new one.

> **Any of these may be absent** and the ingester creates them empty rather than failing. One missing
> attribute costs you that one breakdown and nothing else.
>
> **The join is case- and whitespace-sensitive**, so UPNs are lowercased and trimmed on both sides.
> The Org ingester ends with a match-rate check for exactly this reason — empty department
> breakdowns are nearly always a UPN mismatch rather than a modelling problem.
>
> **On a de-identified Viva export the match rate will be 0%**, and that is expected: hashed person
> IDs cannot match real UPNs. Department breakdowns need an identified export.

---

## `commercial_terms`

**Optional, and unlike the others it holds no consumption data at all.** One row, one column per
commercial figure. Where a column is present its value overrides the matching template parameter;
where it is absent, or the table does not exist, the parameter is used. So a customer with a
pipeline gets their real numbers without anyone retyping them, and a customer without one is
unaffected.

The reason to bother: **Azure Cost Management knows the rate you actually pay.** Divide cost by
quantity on the Copilot credit meter and you have the negotiated rate rather than the $0.01 list
price. See [COMMERCIAL-TERMS.md](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/COMMERCIAL-TERMS.md).

| Column | Type | Notes |
| --- | --- | --- |
| `credit_rate` | double | Cost per pay-as-you-go credit. Overrides `CreditRate`. |
| `prepaid_credit_rate` | double | Effective cost per pre-purchased credit. Overrides `PrepaidCreditRate`. |
| `prepaid_credit_balance` | double | Credits bought up front. Overrides `PrepaidCreditBalance`. |
| `github_business_seat` | double | Monthly price per Copilot Business seat. Overrides `GitHubBusinessSeatPrice`. |
| `github_enterprise_seat` | double | Monthly price per Copilot Enterprise seat. Overrides `GitHubEnterpriseSeatPrice`. |

Every column is optional; supply only the ones you know. A one-row table with just `credit_rate` is
a perfectly good use of this.

> **More than one row and only the first is read.** This is a settings table, not a history — if you
> want to keep old rates, keep them somewhere else. Re-pricing history against a rate that changed
> mid-period is a bigger question than this template answers.

---

## `copilot_payg_spend`

**Copilot pay-as-you-go as Azure billed it.** Written by `Ingest_Azure_AI`. Power Platform billing
policies charge Copilot Studio and Cowork credits beyond prepaid capacity to an Azure subscription;
this is what Cost Management recorded there, a day at a time. The template doesn't read it. The
[Fabric installer](../../installer/README.md#credit-consumption) adds it to `Analytics Hub Consumption Model`
(`ValueLens Consumption Model` on earlier installs) as `CopilotPaygSpend`, and the Analytics Hub's
Consumption pages compare it with the exports.

Grain: day × subscription × meter × `ServiceTag` × currency.

| Column | Type | Notes |
| --- | --- | --- |
| `UsageDate` | date | The day Azure billed. Billing can lag usage by a day or more. |
| `SubscriptionId` | string | The subscription a billing policy charges. |
| `Meter` | string | Usually `Pay As You Go Copilot Credit`. Other Copilot Studio meters are kept too. |
| `ServiceTag` | string | The `serviceName` tag Azure puts on the charge: `cowork` for Cowork, empty for Copilot Studio. |
| `Product` | string | `Copilot Studio` or `Cowork`, from `ServiceTag`. Any other tag value is kept as it is. |
| `Cost` | double | Billed cost in `Currency`. No currency conversion. |
| `UsageQuantity` | double | Credits on the credit meter. Other meters have their own units, so don't sum across meters. |
| `Currency` | string | The billing currency. |

It has no per-policy or per-environment detail: Cost Management doesn't split these charges that
way.

---

## How they relate

```
org_attributes ──────┬── user_principal_name ──── viva_credits_weekly.person_id
                     │                            (identified exports only)
                     ├── user_principal_name ──── github_user_map.user_principal_name
                     │                                   └── username ── github_ai_usage
                     └── user_principal_name ──── studio_user.user_email

viva_credits_weekly ── spending_policy_id ─────── viva_spending_policy

studio_tenant_daily ── environment_id ─────────── studio_agent.environment_id
studio_agent ───────── agent_id ───────────────── studio_user.agent_id
```

The three products share **no key with each other** — a GitHub login, a Viva person ID and a Studio
user ID are unrelated. They meet only through `org_attributes`, and only when every source carries a
matching UPN. That is why the combined page normalises to a monthly run rate per product rather than
attempting a single per-person total across all three, and why it says so on its face.
