# Fabric notebooks

Each notebook writes one Delta table the semantic model imports through either the
SQL analytics endpoint or OneLake. The model gates optional partitions behind
`Enable_*` parameters, so the templates still open when optional tables are absent.

This README focuses on the **current reviewed notebook behaviour** in the base
(*No Studio*) Fabric path.

## Required — run these

**Step 1 — ingesters.** Each pulls from Graph and writes one Delta table:

| Notebook | Output table | Feeds |
|---|---|---|
| `Copilot_Audit_Log_Direct_Ingester` | `copilot_interactions_parsed` | Chat + Agent interactions (Purview usage backbone) |
| `Copilot_Licensed_Users_Direct_Ingester` | `copilot_licensed_users` | Licence readiness |
| `Copilot_Org_Data_Direct_Ingester` | `copilot_org_data` | Org / department dimension |

**Step 2 — process the audit-log fact table.** Run **`Copilot_Audit_Log_Processor`** **after** the Step 1 ingesters, immediately before the model refresh:

| Notebook | Reads | Output table |
|---|---|---|
| `Copilot_Audit_Log_Processor` | `copilot_interactions_parsed` (+ `copilot_licensed_users`, `agents_365`) | `copilot_interactions_curated` |

> **This is a transform, not an ingester.** It does the JSON parse / explode /
> date / licence / agent-map work once in Spark, then writes
> `copilot_interactions_curated`. First rebuild: `WRITE_MODE = "overwrite"`.
> Ongoing runs after the parsed-table key upgrade: `"merge"`.

## Recommended — HRIS org attributes

| Notebook | Reads | Output table |
|---|---|---|
| `Copilot_Org_Data_Workday_Lander` | `Files/org_workday/` + `copilot_org_data` | `copilot_org_data` |

Entra carries the **manager hierarchy**; a Workday worker extract carries the **HR attributes**
(job family, persona, worker type, compensation grade) that make org analysis useful. Neither is
complete on its own, so this notebook joins them on work email — the same identity the model already
keys on (`PersonId_Normalized`).

**Run it in Step 3, after `Copilot_Org_Data_Direct_Ingester` and before the model refresh.** The
Graph ingester writes `copilot_org_data` with `mode('overwrite')`, so refreshing the Entra baseline
drops the Workday columns until this notebook runs again. Order matters every time, not just on
first install.

Default `MODE = 'enrich'` overlays Workday onto the Entra snapshot and keeps `managerUPN`,
`displayName`, `OrgLevel`, `HierarchyPath`, `IsManager` and `DirectReports`. `MODE = 'standalone'`
is for tenants where Workday is the only org source; it writes a schema-compatible table with those
hierarchy columns blank.

`ORGANIZATION_SOURCE` (default `Job_Family_Group`) decides which Workday column drives the
dashboard's main **Organization** dimension — it reshapes every org breakdown in the report, so set
it deliberately. `ATTRIBUTE_PRECEDENCE` (default `workday`) decides who wins where both systems
supply `Organization` / `JobTitle` / `country` / `officeLocation`.

The notebook refuses rather than shipping a quietly-wrong org dimension: fewer than
`MIN_WORKDAY_MATCH_RATE` (default 50%) of Workday rows matching an Entra identity, a duplicate work
email with conflicting attributes, a blank work email, or a join that would fan out `PersonId` all
stop the run. A **missing** export is not an error — it leaves the existing snapshot untouched.

See [`samples/README.md`](./samples/README.md) for a synthetic extract to smoke-test against.

## Reviewed behaviour

### Audit ingester (`Copilot_Audit_Log_Direct_Ingester`)

- `MODE` must be **`backfill`** or **`incremental`**.
- Stable parsed-row keys are:
  - `Id`
  - `Source_RecordKey`
  - `Source_MessageKey`
  - `Source_ResourceKey`
- **Backfill**:
  - uses `start_date = end_date - BACKFILL_DAYS`
  - writes with **overwrite**
- **Incremental**:
  - validates the existing parsed table has the stable key columns
  - re-queries the trailing **`LOOKBACK_DAYS = 7`**
  - writes with merge-safe semantics
  - still derives `InteractionDate`, `WeekStart` and `MonthStart` from `CreationDate`
  - drops duplicate fact rows by `Id`
- If an older parsed table is missing the stable keys, incremental now fails clearly and
  requires a deliberate fresh backfill before incremental resumes.

### Audit processor (`Copilot_Audit_Log_Processor`)

- Default reviewed settings:
  - `WRITE_MODE = "overwrite"`
  - `MERGE_KEYS = ["Id"]`
- `WRITE_MODE="merge"` is accepted only when:
  - the source contains non-blank merge keys
  - the target, if present, already has the merge key columns
- If those conditions are not met, the notebook refuses the merge rather than silently
  producing an ambiguous curated table.

### E7 licensing update

`Copilot_Licensed_Users_Direct_Ingester` now recognizes the reviewed Microsoft 365 E7
exact tokens. Keep any deliberate custom override lists deliberate — defaults are not
silently merged into an override. After changing the licensed-user snapshot, rerun the
processor, then refresh Power BI. `ValueLens_Data_Check` shows stored flags only; it
does not independently classify licences or verify service plans.

The canonical notebooks here are synchronized to `3. Fabric/archive/extended/_shared/notebooks`
and `3. Fabric/archive/extended/Fabric + Copilot Studio/notebooks/_core` using
[`scripts/sync-shared.ps1`](../../scripts/sync-shared.ps1). These archived reference
mirrors remain maintained, not frozen. The processor is inherited, not mirrored.

## Recommended — Agent 365 governance

Both notebooks feed the **Agents 365** page and write the **same** `dbo.agents_365` table, so
**pick exactly ONE — never run both.** Decision rule:

- **`Copilot_Agent365_Registry_Ingester` — the default.** Use it whenever the tenant has an
  **Agent 365 licence** and you can grant the app-only Graph permissions. It pulls the registry live
  and runs unattended on a schedule — no upload step.
- **`Copilot_Agent365_Lander` — manual fallback only.** Use it *only* when you can't grant those
  permissions (or for a one-off / evaluation), by hand-dropping the admin-center CSV export at
  `Files/agent365/agents.csv`. **The Ingester replaces this Lander** the moment the API / licence
  becomes available on the tenant.

| Notebook | Output table | When to use |
|---|---|---|
| `Copilot_Agent365_Registry_Ingester` | `agents_365` | **Default notebook.** GA, app-only ingester (`CopilotPackages.Read.All` + `Application.Read.All`). Rejects missing `Title ID` rows and conflicting duplicates before overwrite. |
| `Copilot_Agent365_Lander` | `agents_365` | **Fallback notebook.** CSV lander for `Files/agent365/agents.csv`. The shipped pipeline JSON currently uses this branch when `EnableAgent365 = true`. |

## Optional — product feedback &amp; Cowork / Work IQ credit consumption

| Notebook | Output table | Feeds | Gated by |
|---|---|---|---|
| `Copilot_ProductFeedback_Ingester` | `user_feedback` | 💬 **Feedback** page | `Enable_ProductFeedback` |
| `Copilot_Cost_Consumption_Ingester` | `copilot_cost_consumption` | 🪙 **Credit Meter** page | `Enable_CostConsumption` |

**Product feedback** reads the Microsoft Admin Center → Health → Product feedback (OCV)
export from `Files/product_feedback/`. It is a snapshot source: `append` is rejected,
and a missing export preserves the existing snapshot unless you deliberately allow an
empty first placeholder.

**Cowork / Work IQ** lands the **Microsoft 365 Admin Center** credit-consumption export
into `Files/cost_consumption/`. See
[the archived cost-consumption guide](../archive/flows/COST-CONSUMPTION.md) for historical
landing-flow reference, not recommended active setup. The core ingester remains available here.

---

## Not in this folder

- **Power Platform Admin Center (PPAC) credit consumption** and the **Copilot Studio**
  transcript / registry notebooks are retained with the
  [archived Fabric + Copilot Studio template](../archive/extended/Fabric%20+%20Copilot%20Studio/README.md).
  They are archived reference, not a recommended active deployment.

---

## Diagnostic notebook

Run `ValueLens_Data_Check.ipynb` only as a **read-only diagnostic**:

- licensed-user flag values and qualifying UPN counts
- parsed / curated date coverage
- identity overlap checks

It does not mutate source tables and does not prove report parity by itself.

An empty audit table, audit rows with no usable user identifiers, or no qualifying
licensed UPNs means **identity overlap cannot yet be assessed**, not an identity
mismatch or a passed validation. Check the source activity, ingestion window,
ingester/processor outputs, and licensed-user snapshot first. A completed audit
query can still yield no parsed prompts: the ingester intentionally retains only
messages whose `isPrompt` value is true. Only investigate identity formats or
tenant/environment selection as possible mismatch causes when both user sets are
nonempty.

Audit staging and checkpoints use `notebookutils.fs` for Lakehouse `Files/` and
ABFSS paths rather than relying on the local Lakehouse mount. Pages are published
from partial files only after pagination completes; manifests are read in full.
Completed windows with missing staged files are fetched again. Do not run
concurrent notebook instances against the same staging directory.

**Note:** all model partitions are gated by an `Enable_*` parameter and fall back to an
empty table when their source isn't present, so the template opens cleanly even if you
haven't run optional notebooks yet.
