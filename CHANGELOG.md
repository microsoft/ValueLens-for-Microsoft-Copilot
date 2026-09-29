# Changelog

Notable, reviewed changes to the ValueLens templates, notebooks and helper scripts.

This file starts here. Everything before the first entry below lives in `git log` and the
pull-request history — this repo shipped for a while before anyone thought to write the
changes down in one place, and back-filling that accurately from commit messages would be a
worse record than pointing you at the commits themselves.

Deployment instructions do **not** live here. They live in the path READMEs:
[1. Local CSV](1.%20Local%20CSV/README.md) ·
[2. SharePoint](2.%20SharePoint/README.md) ·
[3. Fabric](3.%20Fabric/README.md) ·
[4. Power Automate + Dataverse](4.%20Power%20Automate%20+%20Dataverse/README.md).

---

## 2026-09-29 — optional Add Credit Consumption add-on

Each path folder now has an optional `Add Credit Consumption/` folder holding
**Consumption Central**, a separate Power BI report for Copilot credit consumption and cost
across Cowork / Work IQ, Copilot Studio, GitHub Copilot and Azure AI Foundry. The ValueLens
templates are unchanged and don't read it.

- **1. Local CSV** — the Local CSV template, `pull_azure_ai.py` and the shared synthetic sample
  data.
- **2. SharePoint** — the Viva Direct template, which reads Cowork data straight from Viva
  Insights. Consumption Central has no SharePoint template.
- **3. Fabric** — the Fabric template, seven ingestion notebooks, `seed_sample_data.py` and the
  data dictionary. It can share the ValueLens Lakehouse; no table names overlap.
- **4. Power Automate + Dataverse** — the Dataverse template, flow package, schema deploy script
  and permissions. Tables use the `cc_` prefix, so they sit beside ValueLens's `poc_` tables.

Copied from `microsoft/ConsumptionCentral-for-Microsoft-Copilot` at commit `24b0ca8`, with the
fixes from microsoft/ConsumptionCentral-for-Microsoft-Copilot#39: the example addresses in the
`SecurityFilter` table now use the fictional `contoso-health.com` domain, and the Dataverse path
gets a table for Cowork / Work IQ. Links to the full documentation point at that repository.

---

## 2026-09-29 — fuller sample data

The Local CSV sample now fills every page, so a first look shows what each page does on a
real estate rather than a thin version of it. Before this, about a third of the report's
visuals came up empty or thin on the sample.

- **Bigger, longer, deeper.** 13,337 interaction rows (3,716 sessions) across three full months,
  170 people in 14 organisations with a management hierarchy, a 104-agent registry and 1,215
  feedback rows over 15 months.
- **Every page populated.** All four habit bands, dormant and never-used licences, all eight
  Cowork work shapes, Model Fit's Over-specified and Under-specified sessions, every Agent
  Registry lifecycle state, and 11 feedback types.
- **Still synthetic by construction.** `Build-SampleData.py` generates every value from a fixed
  seed. Its proportions were tuned against aggregate counts from real deployments; no rows or
  values were copied. People are invented `first.last@contoso-demo.com` names.
- **New generator options.** `--end`, `--months`, `--users` and `--unlicensed-agent-share`, and
  a coverage report after each run. `--days` is gone; use `--months`.

---

## 2026-09-29 — gentler, adjustable fit grading

Feedback on Cowork Fit was that it read as too critical (about half of graded Cowork sessions
came out Low fit) and that the rule behind it was hard to see. The grades are now plainer, the
default is less strict, and you can choose how strict it is. All five templates carry the change.

- **New labels.** High / Medium / Low fit are now **Strong fit**, **Fair fit** and **Worth a
  look**. On Model Fit, "Try cheaper" is now **Lighter model may do**; Good match and Try
  stronger are unchanged. Measure names are unchanged, so custom visuals built on them keep
  working.
- **Grading setting.** `Assumptions[Fit Grading]` is a calculated column set to `"Balanced"`. To
  change it, select the column in Power BI Desktop and edit its formula to `"Strict"` or
  `"Lenient"`.
  - **Strict** reproduces the previous grade exactly.
  - **Balanced** (default) grades two kinds of session Fair fit instead of Worth a look:
    Cowork sessions that read messages (inbox and channel work, which Cowork logs as message
    reads, previously graded as plain chat) and work done in a single app.
  - **Lenient** also grades multi-turn chats Fair fit.
- **Coaching flag.** The Cowork Fit people table has a ⚑ column. It marks anyone with at least
  five graded Cowork sessions of which half or more are Worth a look; organisation and total
  rows show how many people are flagged. It is a coaching prompt, not a ranking.
- **Clearer notices.** The "how to read" notes on Model Fit and Cowork Fit name the grading
  setting in use and say what a flag means.
- **Task categories.** Estimated Value and Task Breakdown note that their task categories are
  rule-based, so they won't match the AI-inferred categories in Copilot Analytics.
- **Glossary.** The fit rows use the new wording, and a new row explains the grading setting.

---

## 2026-09-28 — sample product feedback

- New `1. Local CSV/sample-data/product_feedback_sample.csv` (172 rows): a fabricated
  Microsoft 365 admin centre product-feedback export, so the User Feedback page fills in from
  the sample data like every other page. `Build-SampleData.py` generates it from its own
  random stream, so the other three sample files are unchanged. It uses the same 21-column
  export shape the Fabric `Copilot_ProductFeedback_Ingester` reads.
- `.gitignore`: the sample-data exception now matches `1. Local CSV/sample-data/`. It was
  anchored to a root `sample-data/` folder that doesn't exist, so new sample files were ignored.

---

## 2026-09-28 — one lean report across all five templates

The Local CSV, SharePoint, Fabric, Fabric OneLake and Power Automate + Dataverse templates had
drifted apart (different page sets and models). They now ship the same report and the same 198
measures; only the data-source layer differs. Each `.pbit`
is about 1.2 MB (previously 4.7–10.5 MB) because it no longer carries pending query edits
(`UnappliedChanges`). Setup steps are unchanged except where noted in the path READMEs.

### Report

- 15 visible pages: Activation, Adoption, Habit Formation, Agent Registry, Task Breakdown,
  Estimated Value, Model Fit, Cowork Fit, Cowork Readiness, License Readiness, User Feedback,
  Leaderboard, Trend Heatmap, and the Glossary and Signal – Impact appendices. License Allocation
  ships hidden.
- **Model Fit** (new) grades every session High, Medium or Low fit for the model it used, across
  every tool, with ranked model usage and fit by tool.
- **Cowork Fit** (new) shows what share of each Cowork task is High, Medium or Low fit, why, and
  which people drive it.
- **Cowork Readiness** ranks where to roll out Cowork next by organization, then user, the
  same way License Readiness does.
- **User Feedback** reads the optional product-feedback export, now on every template.
- Removed: the Key Concepts introduction page (the Glossary covers it) and, from the SharePoint
  template, the Credit Meter page.
- Money values share one display symbol, the `Currency Symbol Value` measure in `Assumptions`
  (default `£`). It changes the symbol only; there is no FX conversion.

### Model

- Lean pass: tables, measures, relationships and source columns that nothing reads were removed,
  and duplicate measures were folded into one survivor each.
- `Environment` is now the licensing dimension only (Licensed / Unlicensed). Cowork is flagged in
  `Agent Filter`, as the Fabric notebook already did, so a Licensed filter no longer drops licensed
  Cowork work. The Local CSV processor (`Purview_CopilotInteraction_Processor_v4.0.0.py`) and the
  sample data follow the same rule.
- `Top Value Outcome` ranks Cowork task categories when the filter context is Cowork only, so the
  Adoption page's Cowork card no longer shows the generic chat outcome.

### Agents 365: API first, CSV fallback

- **Fabric:** the pipeline runs `Copilot_Agent365_Registry_Ingester` (Graph API) and, only if it
  fails, `Copilot_Agent365_Lander` (admin-centre CSV). See the
  [pipelines README](3.%20Fabric/pipelines/README.md) for the migration steps.
- **Other paths:** [`Get-Agents365Registry.ps1`](2.%20SharePoint/scripts/Get-Agents365Registry.ps1)
  writes the same 48-column registry as the Fabric notebook. `Run-PAX-AIBV.ps1
  -IncludeAgent365Info` runs it after PAX; add `-Agents365Csv` to fall back to the admin-centre
  export, or use `-Agents365Csv` alone in tenants without an Agent 365 licence.
- **Fabric templates:** `Enable_Agent365` and `Enable_ProductFeedback` default to `Include`, and a
  table that hasn't been landed yet loads empty instead of failing the refresh.

### Retired and archived

- No template reads cost consumption any more: the `copilot_cost_consumption`, `Credit Budget` and
  `Credit Unit Cost` tables and the `Cost Consumption File` parameter left the SharePoint and
  Dataverse templates.
  `Copilot_Cost_Consumption_Ingester` moved to
  [`3. Fabric/archive/notebooks/`](3.%20Fabric/archive/notebooks/); seven shared notebooks remain.
- Power Automate + Dataverse: the `SharePoint Agents` table and the `Include SharePoint agent
  inventory` parameter were dropped (no page used them), and `Use SharePoint CSV fallback` now
  defaults to `false`. The template is built from the same project as the other four, so its old
  builder moved to [`archive/scripts/`](4.%20Power%20Automate%20+%20Dataverse/archive/README.md).

### Tests

- `tests/test_core_templates.py` now checks all five templates: identical report and measures,
  every report field reference resolves, neutral parameter defaults, no machine-bound parts or
  local paths, page inventory, bookmark targets and the optional Fabric tables' empty-load guard.
- The Dataverse, glossary and schema-hash tests were updated for the new templates, and CI now
  runs the full suite with no deselected tests.

### What was and wasn't validated

Every template was built from one project and passed structural, PBIR-schema and field-reference
checks. The report was refreshed in Power BI Desktop against a Fabric Lakehouse, and against
synthetic data for the Local CSV, SharePoint and Dataverse builds. The Agent 365 fallback logic
was exercised with a test harness and fixture data, not a live tenant.

This does **not** validate Power BI Service refresh, tenant Graph permissions or a production
Agent 365 run. Validate those in your own deployment before switching production over.

---

## 2026-09-15 — reviewed Fabric notebook set

These notes describe what changed in the notebooks under
[`3. Fabric/notebooks/`](3.%20Fabric/notebooks/). The guidance you need in order to *run* them
is in the [Fabric README](3.%20Fabric/README.md) and
[`INGESTION-STRATEGY.md`](3.%20Fabric/docs/INGESTION-STRATEGY.md).

### Audit ingester — `Copilot_Audit_Log_Direct_Ingester`

- Stable parsed-row keys now include **`Id`**, **`Source_RecordKey`**, **`Source_MessageKey`**
  and **`Source_ResourceKey`**.
- `MODE` must be **`backfill`** or **`incremental`**.
- **Backfill** writes the parsed table with **`WRITE_MODE='overwrite'`**.
- **Incremental** re-queries the trailing **`LOOKBACK_DAYS = 7`** and writes with
  **merge-by-`Id`** semantics.
- Parsed output still derives `InteractionDate`, `WeekStart` and `MonthStart` from `CreationDate`.
- Legacy parsed tables missing the stable key columns now fail clearly and require a deliberate
  fresh backfill before incremental resumes. The upgrade procedure is operational guidance and
  lives in the [Fabric README](3.%20Fabric/README.md#-setup) and
  [`INGESTION-STRATEGY.md`](3.%20Fabric/docs/INGESTION-STRATEGY.md).

### Audit processor — `Copilot_Audit_Log_Processor`

- Curated output now uses **`MERGE_KEYS = ["Id"]`**.
- First curated rebuild: **`WRITE_MODE="overwrite"`**.
- Ongoing runs after the parsed-table key upgrade: **`WRITE_MODE="merge"`**.
- Merge is rejected if the source keys are missing or blank, or if the existing curated table is
  missing the merge key — rather than silently producing an ambiguous curated table.

### Snapshot-safety guards

Each snapshot source now validates before it replaces anything:

- **Licensed users:** rejects empty, malformed and conflicting duplicate rows.
- **Org data:** rejects malformed `/users` pages, conflicting duplicate identities and manager cycles.
- **Agent 365 registry:** rejects rows without `Title ID` and conflicting duplicate registry rows.
- **Product feedback:** `WRITE_MODE='append'` is explicitly rejected; missing files preserve the
  existing snapshot unless you deliberately allow an empty first placeholder.
- Feedback discovers exports using OneLake file metadata, not a notebook-local filesystem mount.
  Agent 365 aliases are projected without duplicate case-insensitive column names.

### What was and wasn't validated

The updated transformation and Delta-write paths were exercised in Fabric Spark using synthetic
inputs: audit replay/reordering, late-event insertion, processor overwrite/merge, and
licence/org/Agent 365/feedback snapshot safeguards. Local regressions also cover
extraction/checkpoint helpers and packaged model contracts.

This does **not** validate tenant Graph permissions, source retention/completeness, a production
backfill, or scheduled Power BI refresh. Validate those in your own deployment before switching
production over.

### Data check scope

`ValueLens_Data_Check.ipynb` is a **read-only diagnostic**. It shows stored flags, distinct counts
and identity overlap. It does **not** independently classify licences or prove historical parity
by itself.
