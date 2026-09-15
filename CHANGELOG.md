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
