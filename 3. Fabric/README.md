# 3. Fabric — Lakehouse ingestion at scale, on your own capacity

Run **ValueLens** on **Fabric**: PySpark notebooks pull straight from Graph into a Lakehouse, a
processor builds the curated fact table, and a Power BI template imports it. No scripts to
schedule on a box somewhere, no 1 GB file cap, and the optional feedback and Agent 365 sources
plug into the same model.

This path ships **two Import-mode Power BI templates** over the same Lakehouse outputs:

- **`ValueLens - Fabric.pbit`** → imports through the **SQL analytics endpoint**
- **`ValueLens - Fabric OneLake.pbit`** → imports the same Delta tables through **OneLake**

Both are **Import**, not Direct Lake.

![Fabric architecture](ValueLens_Fabric_Architecture.png)

**Assets:** [`ValueLens_Fabric_Architecture.excalidraw`](ValueLens_Fabric_Architecture.excalidraw) ·
[`ValueLens_Fabric_Architecture.svg`](ValueLens_Fabric_Architecture.svg) ·
[`ValueLens_Fabric_Architecture.png`](ValueLens_Fabric_Architecture.png)

**Jump to:** [Prerequisites](#-prerequisites) · [Setup](#-setup) ·
[Dashboard pages](#-dashboard-pages) · [Troubleshooting](#-troubleshooting) ·
[Related paths & reference](#-related-paths--reference)

---

## 👤 Who it's for

You have **Fabric capacity** (or Premium / PPU), you want the dashboard refreshing itself at
tenant scale, and you're comfortable running notebooks in a workspace. If you don't have capacity,
[2. SharePoint](../2.%20SharePoint/) gets you scheduled refresh on Power BI Pro instead. If you
just want to see the thing working first, start at [1. Local CSV](../1.%20Local%20CSV/).

### What's here

| Item | Purpose |
|---|---|
| `ValueLens - Fabric.pbit` | Import template using the Lakehouse SQL analytics endpoint. |
| `ValueLens - Fabric OneLake.pbit` | Import template using the OneLake Tables endpoint over HTTPS/443. |
| `notebooks/` | Core ingesters, `Copilot_Audit_Log_Processor`, and optional-source ingesters. |
| `notebooks/optional/` | Edge-case add-ons outside the core path, each self-contained with its own README. |
| `pipelines/` | Fabric pipeline JSON for the reviewed **core** orchestration plus opt-in branches. |
| `docs/` | Fabric-specific reference notes, including the read-only SQL checker pack. Cross-path references (data dictionary, permissions) live in [`/docs`](../docs/). |
| `archive/extended/` | Archived Fabric + Copilot Studio reference, not a recommended active deployment; core notebook mirrors remain synchronized. |
| `archive/flows/` | Archived cost-consumption landing flows and guides, not active setup. |

---

## ✅ Prerequisites

**In Fabric:**
- A workspace on **Fabric capacity** (F2+ or trial), and **Contributor** or **Member** on it.
- A **Lakehouse** in that workspace — note its SQL analytics endpoint, or its workspace/Lakehouse
  GUIDs if you're using the OneLake template.

**In your tenant:**
- One **Entra app registration** with admin-consented **Microsoft Graph application**
  permissions: `AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`.
  Optional sources need more — the full least-privilege breakdown is in
  [`/docs/PERMISSIONS.md`](../docs/PERMISSIONS.md).
- Put the client secret in **Azure Key Vault**, not in a notebook.

**On your machine:**
- **Power BI Desktop**, to configure and publish the template.

---

## 🛠 Setup

### Quick start

1. **Create a Lakehouse** and note the SQL analytics endpoint.
2. **Register an Entra app** for the required Graph permissions — see [`/docs/PERMISSIONS.md`](../docs/PERMISSIONS.md).
3. **Import and run the core notebooks** from [`notebooks/README.md`](notebooks/README.md).
4. **Run the processor** after audit + licensed-user ingestion.
5. **Open one template** (`SQL analytics endpoint` or `OneLake`) and load data.
6. **Publish the configured report/model, then add a success-gated semantic model refresh and schedule the pipeline** — see [`pipelines/README.md`](pipelines/README.md#refresh-power-bi-from-the-pipeline).

### Connect and refresh

| Template | Required connection parameters |
|---|---|
| SQL | **Fabric SQL Endpoint** (copy the Lakehouse SQL connection server) and **Lakehouse Name** |
| OneLake | **Fabric Workspace ID** and **Lakehouse ID** (lowercase GUIDs from the Lakehouse URL, without surrounding spaces) |

Set **RangeStart** (inclusive) and **RangeEnd** (exclusive) to cover the required history.
Keep **Enable_ProductFeedback** and **Enable_Agent365** set to `Exclude` until their
tables are ready; use `Include` when enabling them. Sign in with an Organizational
Account that can read the source, then load in Desktop.

After publishing, configure the corresponding data-source credentials in Power BI
Service. For OneLake use Organizational Account/OAuth2 at the **Tables-root URL**.
Preserve the packaged [`FabricTable` helper](../scripts/onelake/FabricTable.pq):
its single `AzureStorage.DataLake` source outside the table function supports Service
refresh. Do not replace it with dynamic per-table URL fallbacks.

Run **Refresh now** to check saved credentials, then follow the
[pipeline refresh setup](pipelines/README.md#refresh-power-bi-from-the-pipeline) to add a native refresh
activity after all model-source branches succeed. The supplied JSON has no refresh activity.
Alternatively, use a later fixed Service refresh schedule; it is **not success-gated**.

### Run order (reviewed)

#### Core path

```text
Graph audit ----------------------> Copilot_Audit_Log_Direct_Ingester ----> copilot_interactions_parsed --+
Graph licensed users -------------> Copilot_Licensed_Users_Direct_Ingester -> copilot_licensed_users -----+--> Copilot_Audit_Log_Processor -> copilot_interactions_curated
Graph org users ------------------> Copilot_Org_Data_Direct_Ingester ------> copilot_org_data -------------> semantic model only

After successful notebook / pipeline completion:
Power BI semantic model refresh (add native pipeline activity; not included in shipped JSON)
```

#### Optional reviewed branches

```text
Graph Agent 365 registry ---------> Copilot_Agent365_Registry_Ingester ----> agents_365 -----------+
Files/agent365/agents.csv -------> Copilot_Agent365_Lander --------------- > agents_365 -----------+--> processor + model
Files/product_feedback/*.csv ----> Copilot_ProductFeedback_Ingester -------> user_feedback --------> model
```

- **Licence data feeds both the processor and the model.**
- **Org data feeds the model only.**
- **`agents_365` can come from either the registry ingester or the CSV lander, never both.**
- The **shipped pipeline JSON currently wires `EnableAgent365` to the CSV lander**, not the registry ingester.
- **Add Power BI refresh after all model-source branches succeed** using the [native activity](pipelines/README.md#refresh-power-bi-from-the-pipeline); this repo does **not** ship it inside the pipeline JSON.

### Backfill vs incremental

The audit ingester's `MODE` must be **`backfill`** or **`incremental`**. Backfill **overwrites**
the parsed table; incremental re-queries the trailing **7 days** (`LOOKBACK_DAYS`) and merges by
stable row key. The processor's first curated rebuild uses `WRITE_MODE="overwrite"`; ongoing runs
use `"merge"` on `Id`.

> ⚠️ **Upgrading a parsed table from an older build?** It won't have the stable key columns, so
> incremental fails on purpose and you need a deliberate fresh backfill. Start that upgrade with a
> **new, unused staging directory and a separate output table** to validate coverage. Reusing
> staging can resume previously completed windows instead of fetching them afresh. Backfilling to
> the same output table replaces existing parsed data — pause overlapping runs and rerun the
> processor afterward. Full guidance: [`docs/INGESTION-STRATEGY.md`](docs/INGESTION-STRATEGY.md).

> **Validation boundary.** The reviewed notebook set was exercised in Fabric Spark with synthetic
> inputs plus local regressions. That does **not** validate your tenant's Graph permissions, your
> audit retention or completeness, a production-scale backfill, or scheduled Power BI refresh.
> Validate those in your own deployment before switching production over.

What changed in the reviewed notebook set — write modes, stable keys, snapshot-safety guards — is
recorded in [`CHANGELOG.md`](../CHANGELOG.md).

### Optional sources

| Source | Notebook | Notes |
|---|---|---|
| Agents 365 registry | `notebooks/Copilot_Agent365_Registry_Ingester.ipynb` | Preferred unattended path when Graph permissions are available. |
| Agents 365 CSV fallback | `notebooks/Copilot_Agent365_Lander.ipynb` | Manual/export fallback. The shipped pipeline invokes this branch. |
| Product feedback | `notebooks/Copilot_ProductFeedback_Ingester.ipynb` | Reads landed files from `Files/product_feedback/`; safe overwrite snapshot only. |
| Cowork / Work IQ consumption | `notebooks/Copilot_Cost_Consumption_Ingester.ipynb` | Optional export-only source; landing flows and guides are [archived reference](archive/flows/COST-CONSUMPTION.md), not active setup. |
| Workday / HRIS org attributes | [`notebooks/optional/workday-org-data/`](notebooks/optional/workday-org-data/README.md) | Edge case. Enriches `copilot_org_data` in place with job family / persona / worker type, joining on work email. Must run **after** `Copilot_Org_Data_Direct_Ingester`, which overwrites that table. |

The former [Copilot Studio add-on](archive/extended/Fabric%20+%20Copilot%20Studio/README.md)
for transcripts and PPAC credit detail is archived reference, not a recommended active deployment.

### Checker pack (read-only T-SQL)

Use the reviewed checker pack when you want a quick parity / sanity read without editing notebooks:

- [`docs/checker/ValueLens-Fabric-Quick-TSQL-Checks.sql`](docs/checker/ValueLens-Fabric-Quick-TSQL-Checks.sql)
- [`docs/checker/ValueLens-Fabric-Quick-TSQL-Checks.docx`](docs/checker/ValueLens-Fabric-Quick-TSQL-Checks.docx)

Scope:

- **Read-only T-SQL**
- Run in the **Lakehouse SQL analytics endpoint**
- **Not** a Spark SQL notebook
- Reviewed against the current local notebook/model contracts
- **Not live-tested** against your tenant or endpoint

The four queries intentionally use:

- `COUNT_BIG(*)`
- Monday-based weekly grouping
- `CreationDate`-derived week checks for parsed vs curated parity
- separate definitions for **prompt rows**, **distinct prompt messages**, **sessions** (`ThreadId`) and **users**

---

## 📚 Dashboard pages

<details>
<summary>13 report pages — shared by the SQL and OneLake templates, with optional Agent 365 and feedback signals</summary>

Both shipped Import templates contain the same pages:

| Page | Purpose / source |
|---|---|
| **📘 Key Concepts** | Methodology and key-concept explainers |
| **◆ Activation** | Licensed vs unlicensed, active vs inactive users |
| **🎯 Readiness** | Upgrade-priority signals |
| **📡 Adoption** | User counts, coverage and reach |
| **🌱 Power Users** | Usage maturity and behaviour-stage progression |
| **🔮 Activity** | Copilot and agent usage, tasks and behaviour mix |
| **🚀 Value** | Hours saved, assisted value and business case; feedback-bound visuals need the optional feedback source |
| **🛡 Agent Health** | Agent inventory / telemetry; Agent 365 enrichment is **optional**, gated by `Enable_Agent365` |
| **💬 Feedback** | Product-feedback analysis — **optional**, requires `user_feedback` and `Enable_ProductFeedback = Include` |
| **📈 Heatmap** | Activity across the reporting period |
| **🏅 Leaderboard** | Top users, agents and functions |
| **📘 Appendix: Glossary** | Metric definitions and research sources |
| **🧬 Appendix: Signal - Impact Table** | Trace signals through to their value impact |

Core pages use audit interactions, licences and org data. Leave optional toggles at
`Exclude` until their tables are ready. A registry-only `agents_365` export supplies
inventory, **not** observability telemetry; unavailable health fields remain blank.
See the [source contract](../docs/DATA-DICTIONARY.md#optional-tables).

**Consumption boundary:** the optional Cowork / Work IQ ingester and the
[documented consumption contract](../docs/DATA-DICTIONARY.md#6-copilot_cost_consumption--copilot-credit-usage-mac-cost-management-export)
exist, but the shipped Fabric templates currently contain **no Consumption page,
cost-consumption model table or `Enable_CostConsumption` parameter**. Ingesting that
source alone does not add a report page. The dictionary's broader cross-template
claim is not a guarantee of packaged report support. PPAC credit detail and Studio
transcript pages remain archived, not part of this active build.

</details>

---

## 🩺 Troubleshooting

Start with [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md). The fastest triage path is:

1. Confirm the **three core tables** exist and have rows.
2. Keep optional `Enable_*` toggles off until their source tables are ready.
3. Re-run the **processor** after any parsed-table backfill or licensed-user snapshot change.
4. Refresh the semantic model **after** notebook completion, not on an unrelated fixed timer.

`ValueLens_Data_Check.ipynb` is a **read-only diagnostic** — it shows stored flags, distinct counts
and identity overlap. It does not independently classify licences or prove historical parity by itself.

---

## ➡️ Related paths & reference

| Path | When you'd go there instead |
|---|---|
| [1. Local CSV](../1.%20Local%20CSV/) | You want a two-minute look before committing capacity to this. |
| [2. SharePoint](../2.%20SharePoint/) | No Fabric capacity — scheduled refresh on Power BI Pro. |
| [4. Power Automate + Dataverse](../4.%20Power%20Automate%20+%20Dataverse/) | Preview: Dataverse as the core transport for the same dashboard. |

Reference:

- [`notebooks/README.md`](notebooks/README.md)
- [`pipelines/README.md`](pipelines/README.md)
- [`/docs/PERMISSIONS.md`](../docs/PERMISSIONS.md)
- [`/docs/DATA-DICTIONARY.md`](../docs/DATA-DICTIONARY.md)
- [`docs/INGESTION-STRATEGY.md`](docs/INGESTION-STRATEGY.md)
- [`docs/STORAGE-MODES.md`](docs/STORAGE-MODES.md)
- [`docs/INCREMENTAL-REFRESH.md`](docs/INCREMENTAL-REFRESH.md)
- [`docs/OPTIONAL-SOURCES.md`](docs/OPTIONAL-SOURCES.md)
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- [`CHANGELOG.md`](../CHANGELOG.md) — what changed in the reviewed notebook set
- [Archived cost-consumption setup reference](archive/flows/COST-CONSUMPTION-SETUP.md)
- [Archived Fabric + Copilot Studio reference](archive/extended/Fabric%20+%20Copilot%20Studio/README.md)
