# Fabric Notebooks — the *No Studio* template

Each notebook writes one Delta table the semantic model reads via the `FabricTable(...)`
helper. They sit **flat** in this folder — import the ones for the sources you have.
The model gates every partition behind an `Enable_*` parameter, so the template opens
cleanly even before you've run the optional ingesters.

Tiers below match what the base (*No Studio*) dashboard actually needs:

- **Required** — the dashboard's backbone. Run these four.
- **Recommended** — Agent 365 governance. Run the registry ingester if you can.
- **Optional** — Cowork / Work IQ credit consumption (Microsoft Admin Center export).

## Required — run these four

| Notebook | Output table | Feeds |
|---|---|---|
| `Copilot_Audit_Log_Direct_Ingester` | `copilot_interactions_parsed` | Chat + Agent interactions (Purview usage backbone) |
| `Copilot_Licensed_Users_Direct_Ingester` | `copilot_licensed_users` | Licence readiness |
| `Copilot_Org_Data_Direct_Ingester` | `copilot_org_data` | Org / department dimension |
| `Copilot_ProductFeedback_Ingester` | `user_feedback` | User Feedback page |

## Recommended — Agent 365 governance

Pick **one** of these two — they both feed the **Agents 365** page. Prefer the registry
ingester; fall back to the lander only if you can't get app-only permissions.

| Notebook | Output table | When to use |
|---|---|---|
| `Copilot_Agent365_Registry_Ingester` | `agents_365` | **Default.** GA, **app-only** ingester (`CopilotPackages.Read.All` + `Application.Read.All`). Runs headless on a schedule and writes the full capability / permission detail. Gated by `Enable_Agent365`. |
| `Copilot_Agent365_Lander` | `agents_365` | **Fallback.** CSV lander — use only when the Ingester's app-reg permissions aren't available in the tenant, or for one-off / evaluation runs. The two write to the **same** `dbo.agents_365` table, so pick one — don't run both. |

## Optional — Cowork / Work IQ credit consumption (MAC)

| Notebook | Output table | Feeds |
|---|---|---|
| `Copilot_Cost_Consumption_Ingester` | `copilot_cost_consumption` | 🪙 **Cowork / Consumption** page |

Lands the **Microsoft Admin Center → Cowork / Work IQ** credit-consumption export into
`Files/cost_consumption/`. This is the **standard** consumption view across every template.
Gated by `Enable_CostConsumption`. See [`../flows/COST-CONSUMPTION.md`](../flows/COST-CONSUMPTION.md)
for the automated landing flow.

---

## Not in this folder

- **Power Platform Admin Center (PPAC) credit consumption** and the **Copilot Studio**
  transcript / registry notebooks now live with the fuller template in
  [`../../3. Fabric Extended/Fabric + Copilot Studio/`](../../3.%20Fabric%20Extended/Fabric%20+%20Copilot%20Studio/README.md).
  Add them only if you deploy that *Fabric + Copilot Studio* build.
- The **M365 work-behaviour** ingester (AI vs Manual Work, preview) has moved to
  [`../../3. Fabric Extended/Fabric + M365/`](../../3.%20Fabric%20Extended/Fabric%20+%20M365/README.md).

---

**Note:** all model partitions are gated by an `Enable_*` parameter and fall back to
an empty table when their source isn't present, so the template opens cleanly even if
you haven't run its optional notebooks yet.
