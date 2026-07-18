# Ingestion: load strategy, scale & versioning

Guidance for running the Fabric path in production — how to load each source (overwrite vs
append), what to expect at scale, and how to pin a stable build.

This is the base **No-Studio** build: three core sources — **audit logs**, **licensed users**, and
**org data**. Optional add-ons (Cowork / Work IQ consumption, product feedback, Agents 365) follow the
same rules; Copilot Studio agent-transcript analytics and PPAC message-credit tables live in the
separate [Fabric + Copilot Studio](../../3.%20Fabric%20Extended/Fabric%20+%20Copilot%20Studio/) build.

---

## 1. Load strategy per source

Each ingester supports `WRITE_MODE` = `overwrite` | `append` | `merge`. For the core sources:

| Source / table | Recommended | Why |
|---|---|---|
| **Audit log** → `copilot_interactions_parsed` (`Copilot_Audit_Log_Direct_Ingester`) | **`append`** day-by-day; **`overwrite`** for a fresh snapshot | Audit records are immutable events keyed by `RecordId`. Append each day's slice. For exactly-once on re-runs, dedupe on `RecordId` downstream. |
| **Licensed users** → `copilot_licensed_users` (`Copilot_Licensed_Users_Direct_Ingester`) | **`overwrite`** | Current-state snapshot of who's licensed — replace it each run. |
| **Org / people** → `copilot_org_data` (`Copilot_Org_Data_Direct_Ingester`) | **`overwrite`** | Current-state snapshot of users — replace it each run. |

> **Rule of thumb:** the audit log is an *event stream* → **append**; the snapshot sources (licensed
> users, org, and the optional Agents 365 / consumption / feedback exports) → **overwrite**.

### Backfilling history
For "all data since 1 Jan 2026", loop the date window in the **audit ingester**, not the dashboard:
set `LOOKBACK_DAYS` per run and schedule daily with `WRITE_MODE='append'`. The notebook already chunks
each run into `CHUNK_HOURS` windows and **retries transient 5xx/429** (see §3), so a long backfill
survives Purview throttling. (Graph caps each audit query to a rolling 7-day window, so history is
built up day-by-day rather than in one shot.)

---

## 2. Keep Power Query thin

The Fabric path is built so the PBIT reads **already-shaped Delta tables** and does only light typing
and measures — the heavy parsing (audit `AuditData` flatten, agent-identity resolution) happens in the
Spark notebooks. If a refresh is taking minutes:

1. **Prefer incremental refresh or Direct Lake** over re-importing everything each run — see
   [`INCREMENTAL-REFRESH.md`](INCREMENTAL-REFRESH.md).
2. **No per-row M expansion.** Don't add record/JSON parsing in the PBIT on the Fabric path — that work
   belongs in the ingester notebook, so the table you connect to is already flat.

> If you see Power Query doing real transformation on a large feed, push it into the ingester notebook
> and have the PBIT read the resulting Delta table.

---

## 3. Resiliency (already in the build)

- **Audit ingester** uses a shared `requests.Session` with `urllib3` **Retry** (`429/500/502/503/504`,
  exponential backoff, honours `Retry-After`) plus an outer retry loop, so transient **504 Gateway
  Timeouts** during poll/fetch no longer abort the run. The lookback is split into `CHUNK_HOURS`
  windows with a configurable `MAX_WAIT_MIN_PER_QUERY`, and records stream to Lakehouse Files (bounded
  driver memory).
- **Consumption dates** parse US-format `Usage_Date` with explicit `"en-US"` culture, so they don't
  fail on non-US machine/region locales.

---

## 4. Production: stable build & upgrade path

**Pin a known-good commit.** Build your automation against a specific Git **tag / commit SHA** of this
repo rather than tracking `main`, so an upstream change can't break a running pipeline:

1. Validate a commit in a non-prod workspace (run the ingesters + refresh the PBIT).
2. Tag it (e.g. `v2026.07-fabric`) and point production at that tag.
3. To upgrade: diff the new tag's `2. Fabric/notebooks/`, test in non-prod, then move the tag.

**Compatibility tips:**
- Drive notebooks via the CONFIG cell (tagged as the pipeline `parameters` cell) — don't fork the
  notebook body, so upgrades are a definition swap.
- Keep secrets in **Key Vault** (`notebookutils.credentials.getSecret`), not in the CONFIG cell.
- Treat the Delta **table + column names** (`copilot_interactions_parsed`, `copilot_licensed_users`,
  `copilot_org_data`) as the integration contract; build dependencies on those, not on intermediate
  tables. Contract changes are called out so you can upgrade without surprises.
