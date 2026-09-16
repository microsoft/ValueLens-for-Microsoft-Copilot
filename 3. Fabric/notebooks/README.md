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

## Optional — HRIS / Workday org attributes

| Add-on | Output table |
|---|---|
| [`optional/workday-org-data/`](./optional/workday-org-data/README.md) | `copilot_org_data` *(enriched in place)* |

An optional source, kept out of the core path. `Copilot_Org_Data_Workday_Lander` adds Workday/HRIS
columns absent from the existing org snapshot, joining on work email. Existing Entra values,
including blanks, identities, hierarchy and population are preserved. It also supports a standalone
user-level org table when no Entra snapshot exists; unavailable hierarchy fields stay blank.

The default `auto` mode checks whether the baseline table exists, failing if an existing baseline
has an invalid schema. For enrichment, use a fresh Graph baseline each cycle (or separate baseline
and output tables), then run the lander before model refresh. Without Entra, use explicit
`standalone` mode for recurring refreshes. Full setup and migration notes in the add-on's
[README](./optional/workday-org-data/README.md).

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

**Optional raw passthrough** is disabled by default (`INCLUDE_RAW_PASSTHROUGH = False`).
Enable it to retain `AppIdentity_Raw`, `AccessedResources_Raw`, `AISystemPlugin_Raw`,
and the original `Audit_UserId_Normalized` when present. Existing canonical parsing,
resource explosion, licence/agent joins, behaviour enrichment and join-helper cleanup
are unchanged. Raw resource arrays are repeated on each exploded resource row; plugin
arrays retain **all** elements even though canonical plugin fields use only the first.

Strings are retained exactly, including invalid JSON, whitespace and empty values;
missing payload columns become typed nulls. Complex raw values are JSON-serialized with
null members retained (the canonical resource/plugin parser still requires string inputs).
Unknown or case-variant keys stay inside the raw JSON, **not new inferred columns**:
there is no sample limit, schema inference, or automatic overwrite of canonical values
such as `AccessedResource_SensitivityLabelId`. Inspect/project approved keys explicitly
from these payloads in your own downstream transformation. A case-insensitive collision
with a reserved `_Raw` output name fails before writing, rather than replacing source data.
The opt-in pre-write guard checks source-column presence (including actual raw aliases);
it does not prove value equality for columns deliberately transformed by the processor.

This deliberately differs from the supplied sampled-inference patch: it retains complete
payloads without changing the canonical schema based on the first 2,000 records or promoting
the internal identity join helper. For example, inspect approved resource keys with Spark SQL:

```sql
SELECT from_json(
    AccessedResources_Raw,
    'array<struct<Type:string,SensitivityLabelId:string>>'
) AS ApprovedResourceFields
FROM dbo.copilot_interactions_curated
LIMIT 20;
```

This returns an array, not one value for the current exploded resource row. Do not explode
it again and sum interaction metrics without accounting for the repeated source arrays.

**Privacy and deployment:** raw payloads can contain identities, file names, URLs and
additional sensitive metadata. Both shipped Fabric template fact queries pass through
the entire curated table; they do not select a fixed list of columns. Review access,
retention, model exposure and refresh behaviour before enabling. This flag is not a
redaction boundary for arbitrary columns already in the parsed table. After either
flag change, use a deliberate `WRITE_MODE = "overwrite"` rebuild to align the persisted
schema, then return to merge only with valid unique curated-row keys. Turning the flag
off during merge does **not** remove existing raw columns or historical raw values.
An overwrite does not purge Delta history or downstream copies; apply your retention
policy separately. `Audit_UserId_Normalized` is retained as supplied, not recomputed;
the internal `_NormUPN` is never promoted into another identity field.

**Reproducible regression:** run the portable checks with
`python -m unittest discover -s tests -p "test_audit*.py"` from the repo root.
For real Spark/Delta coverage, generate an isolated notebook:

```powershell
python tests\fabric_audit_passthrough.py --output C:\scratch\audit-verification.ipynb
# Optional read-only subset of the attached test lakehouse's parsed table:
python tests\fabric_audit_passthrough.py --output C:\scratch\audit-live-verification.ipynb --live-source dbo.copilot_interactions_parsed
```

Import it into a **test** lakehouse and Run all. The generator embeds verbatim baseline
(`5d20fb9`, override with `--baseline-ref`) and current processor cells; fetch the baseline
commit first if using a shallow checkout. It runs full processing plus isolated Delta
writes for original/OFF/ON, compares every canonical column's type and complete row
multiset, checks raw retention, and exercises unique-key merge/flag transitions.
It uses uniquely named scratch views/tables, removes those tables, and leaves an aggregate
report plus diagnostic stdout under `Files/vl_audit_pt_<run-id>/`. Keep diagnostic stdout
private. It never writes production tables. `RUN_OPTIMIZE=False` is a test override;
VORDER compaction, scheduled ingestion, production-scale performance, Power BI refresh,
relationships and visuals are outside this regression. An empty live source is explicitly
reported as **not live-validated**, not a passing end-to-end test.

### E7 licensing update

`Copilot_Licensed_Users_Direct_Ingester` now recognizes the reviewed Microsoft 365 E7
exact tokens. Keep any deliberate custom override lists deliberate — defaults are not
silently merged into an override. After changing the licensed-user snapshot, rerun the
processor, then refresh Power BI. `ValueLens_Data_Check` shows stored flags only; it
does not independently classify licences or verify service plans.

The canonical notebooks here are synchronized to
`3. Fabric/archive/extended/Fabric + Copilot Studio/notebooks/_core` using
[`scripts/sync-shared.ps1`](../../scripts/sync-shared.ps1). These archived reference
mirrors remain maintained, not frozen. The redundant `_shared/notebooks` copy is no longer
generated. The processor is inherited, not mirrored.

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
| `Copilot_Agent365_Registry_Ingester` | `agents_365` | **Default notebook.** GA, app-only ingester (`CopilotPackages.Read.All` + `Application.Read.All` + `User.Read.All`). Rejects missing `Title ID` rows and conflicting duplicates before overwrite. Resolves **`Agent creator UPN`** via a 3-tier chain and can optionally pass the raw API payload through. |
| `Copilot_Agent365_Lander` | `agents_365` | **Fallback notebook.** CSV lander for `Files/agent365/agents.csv`. The shipped pipeline JSON currently uses this branch when `EnableAgent365 = true`. |

### Raw API passthrough (`INCLUDE_RAW_PASSTHROUGH`) — registry ingester

Set in the first configuration cell of `Copilot_Agent365_Registry_Ingester`; it ships `False`.

```python
INCLUDE_RAW_PASSTHROUGH = True
```

`False` writes the shaped columns only: the canonical Admin Center schema plus the handful of
API-only fields the model declares. Fields the model does not declare are **dropped**. `True`
additionally carries **every** field the API returned under its raw API name, with nested
objects and arrays JSON-serialised.

Measured against a real tenant of 469 agents, the difference is **48 columns → 80 columns**.
Only six fields are reachable *exclusively* through the flag — `appId`, `assetId`, `requestType`,
`requestStatus`, `manifestId`, `governanceMetadata` — and all six were empty in that tenant.
Everything else the flag adds is a raw duplicate of a column you already have.

**`Agent creator UPN` is not one of them.** It is a canonical column produced by the 3-tier
resolver and is present either way; you do not need the flag to join agents to org data.

Turn it on when you are deliberately exploring the payload or chasing a field the model does not
yet map. Consider before leaving it on permanently:

- **Identity exposure.** `allowedUsersAndGroups`, `acquireUsersAndGroups` and
  `sharedWithUsersAndGroups` carry user and group identifiers into the Delta table, and the
  PBIT's `Agents 365` query is purely additive — it has no `Table.SelectColumns`, so every extra
  column lands in the semantic model and in every report author's field list. Treat this as a
  privacy review item, not a display preference.
- **Payload bulk.** `elementDetails` is the full agent definition as JSON on every row.
- **Zero versus blank.** Shaped numeric columns render a genuine `0` as blank (`str(x or '')`),
  while the raw copy keeps `"0"`. Counts of "populated" rows therefore differ between the two for
  the same underlying data — in that 469-agent tenant, `Active Users` read 2 populated against
  `activeUsers` at 465, purely because 463 agents have zero usage. Neither is wrong; do not read
  the gap as data loss.

Where a raw key collides case-insensitively with a canonical column (`version` vs `Version`,
`categories` vs `Categories`), the canonical column wins and the raw value is kept as `<key>_raw`
only when it genuinely differs. Spark resolves names case-insensitively, so without this the write
would fail with `AMBIGUOUS_REFERENCE`.

Switching the flag rewrites the table with a new schema, so run it against a scratch table first
and confirm your report still refreshes before changing the value feeding `dbo.agents_365`.

### Long runs and Graph token expiry

The snapshot issues one Graph call per package, so on a large tenant the run can last longer
than the lifetime of a single app-only token (commonly ~60 minutes). The notebook therefore
caches its token against the `expires_in` the token endpoint returns, renews it a few minutes
early, and retries any call once with a freshly minted token if Graph rejects it with `401`.
No manual re-authentication or re-run is needed.

Because of that retry, a `401` that still reaches you is **not** an expiry problem — it means
the app registration genuinely lacks admin-consented `CopilotPackages.Read.All`,
`Application.Read.All` and `User.Read.All`. A `403` on the catalog means the tenant has no
Agent 365 licence.

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
