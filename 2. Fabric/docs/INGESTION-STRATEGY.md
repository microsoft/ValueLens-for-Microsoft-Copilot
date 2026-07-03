# Ingestion: merge strategies, scalability & versioning

Guidance for running the Fabric path in production — how to load each source (overwrite vs
append vs merge), what to expect on scale, and how to pin a stable build.

---

## 1. Recommended load strategy per source

Each ingester supports `WRITE_MODE` = `overwrite` | `append` | `merge`. Pick per source:

| Source / table | Recommended | Why |
|---|---|---|
| **Conversation transcripts** → `agent_sessions/turns/errors/subagents/catalogue/performance` (`Copilot_Agent_Transcript_Parser`) | **`merge`** for incremental day-by-day; **`overwrite`** for a one-shot full reload | Each fact table has a stable natural key, so `merge` upserts slices with **no duplicates and no gaps**. Keys: sessions=`conversation_id`, turns=`turn_id`, errors=`conversation_id+error_timestamp_utc+error_code`, subagents=`conversation_id+invocation_timestamp_utc+connected_agent_schema+plan_step_id`, performance=`ConversationTranscriptId`, catalogue=`agent_schema`. In multi-environment runs the environment is auto-added to the key so the same conversation id from two envs can't collide. |
| **Audit log** → `Copilot_Interactions_Parsed` (`Copilot_Audit_Log_Direct_Ingester`) | **`append`** day-by-day (the notebook windows the range and streams pages); **`overwrite`** for a fresh snapshot | Audit records are immutable events keyed by `RecordId`. Append each day's slice. If you need exactly-once on re-runs, dedupe on `RecordId` downstream (or switch to a keyed merge). |
| **Org / people** (`Copilot_Org_Data_Direct_Ingester` or the Graph→SharePoint flow) | **`overwrite`** | It's a current-state snapshot of users, not an event stream — replace it each refresh. |
| **Licensed users** (`Copilot_Licensed_Users_Direct_Ingester`) | **`overwrite`** | Current-state snapshot. |
| **Credit consumption** (agent / user / tenant) | **`overwrite`** per billing export | The portal exports are point-in-time totals for the period. Overwrite with the latest export; the `Billing Period` measure states the window covered. (If you instead accumulate daily slices, use `append` and slice by `Usage_Date`.) |
| **Agents 365 registry** | **`overwrite`** | Current-state registry snapshot. |

> **Rule of thumb:** *event streams* (transcripts, audit) → **merge/append**; *current-state snapshots*
> (org, licensed users, credit, agents registry) → **overwrite**.

### Backfilling 2026 day-by-day
For "all data since 1 Jan 2026", loop the date window in the **ingester**, not the dashboard:
- **Audit:** set `LOOKBACK_DAYS` per run and schedule daily with `WRITE_MODE='append'`; the notebook
  already chunks each run into `CHUNK_HOURS` windows and **retries transient 5xx/429** (see §3).
- **Transcripts:** run with `LOOKBACK_DAYS = N` and `WRITE_MODE='merge'`; re-running an overlapping
  window is safe (upsert, no dupes). For the very first full load use `LOOKBACK_DAYS = 0` (all rows).

---

## 2. Scalability — keep Power Query thin

**Direction: heavy transforms belong in the notebooks (Spark), not Power Query.** The Fabric path is
designed so the PBIT reads **already-shaped Delta tables** and does only light typing/measures. If a
refresh is taking minutes, check:

1. **You're on the Fabric path, not the Dataverse path.** The **Dataverse** companion template parses
   transcript JSON *inside* Power Query (M) by design — that's fine for small tenants but **not** meant
   for scale. For large tenants use **`2. Fabric`**, where the Spark notebook does the parsing and PQ
   stays thin.
2. **Storage mode.** For large models prefer **Direct Lake** (or Import with incremental refresh) over
   re-importing everything each run.
3. **No per-row M expansion.** Avoid `Table.AddColumn` with record/JSON parsing in the PBIT on the
   Fabric path — that work should already be done in the notebook.

**Already moved to notebooks:** transcript JSON parsing, audit `AuditData` flatten, agent identity
resolution, topic-ready shaping. **Still in PQ (intentionally light):** header normalisation + typing
for the CSV sources (org/credit/Agents 365), and the value-model DAX.

> If you see PQ doing real transformation on a large feed, that's the signal to push it into the
> corresponding ingester notebook and have the PBIT read the resulting Delta table.

---

## 3. Resiliency (already in the build)

- **Audit ingester** now uses a shared `requests.Session` with `urllib3` **Retry**
  (`429/500/502/503/504`, exponential backoff, honours `Retry-After`) plus an outer retry loop, so
  transient **504 Gateway Timeouts** during poll/fetch no longer abort the run. The lookback is split
  into `CHUNK_HOURS` windows with a generous, configurable `MAX_WAIT_MIN_PER_QUERY`, and records are
  streamed to Lakehouse Files (bounded driver memory).
- **Transcript parser** writes the heavy raw `content` landing in **`RAW_TABLE_CHUNK_ROWS` (2000)**
  chunks to stay under `spark.rpc.message.maxSize`; on very large tenants set **`RAW_TABLE = ''`** to
  skip the optional raw landing entirely (the `agent_*` tables are what the PBIT needs).
- **Credit (Tenant) dates** parse US-format `Usage_Date` with explicit `"en-US"` culture, so they no
  longer fail on non-US machine/region locales.

---

## 4. Production: stable build & upgrade path

**Pin a known-good commit.** Build your automation against a specific Git **tag/commit SHA** of this
repo rather than tracking `main`, so an upstream change can't break a running pipeline. Suggested flow:

1. Validate a commit in a non-prod workspace (run all ingesters + refresh the PBIT).
2. Tag it (e.g. `v2026.07-fabric`) and point production at that tag.
3. To upgrade: diff the new tag's `2. Fabric/notebooks/` and `CHANGELOG`, test in non-prod, then move
   the tag.

**What's stable now:** the Fabric ingesters + `2. Fabric` PBIT have been validated end-to-end
(transcripts → six `agent_*` Delta tables; audit → `Copilot_Interactions_Parsed`; credit/org CSVs).
The output **Delta table contracts** (table + column names) are the integration surface — changes to
them will be called out so you can upgrade without surprises. Config-cell **parameters** are additive
where possible.

**Compatibility tips for your automation:**
- Drive notebooks via parameters (the CONFIG cell is tagged as the pipeline `parameters` cell) — don't
  fork the notebook body, so upgrades are a definition swap.
- Keep secrets in **Key Vault** (`notebookutils.credentials.getSecret`), not in the CONFIG cell.
- Treat the `agent_*` / `Copilot_Interactions_Parsed` schemas as the contract; build dependencies on
  those, not on intermediate tables like `conversationtranscripts_raw`.
