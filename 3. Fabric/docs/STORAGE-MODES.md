# Storage modes: Direct Lake vs Import (+ incremental refresh)

How to choose — and **switch between** — the storage mode of the ValueLens semantic model
(e.g. **Value-Powerbi** behind the *M365 Copilot Usage + Agents* report) that reads the Delta
tables produced by the ingester notebooks.

> This note is the **decision + switching** guide. For the mechanics of the incremental-refresh
> policy that already ships in `ValueLens - Fabric.pbit`, see
> [`INCREMENTAL-REFRESH.md`](INCREMENTAL-REFRESH.md). For how data lands in the Lakehouse, see
> [`INGESTION-STRATEGY.md`](INGESTION-STRATEGY.md).

---

## TL;DR

- **On Fabric / Premium / PPU capacity → prefer Direct Lake.** It reads the Lakehouse Delta tables
  in place, so there is **no import refresh and no ~5-hour refresh ceiling**. A large initial pull
  (e.g. 4 months) is a non-event because the data already lives in the Lakehouse.
- **On Pro / shared capacity, or a non-Fabric SQL backend → use Import + incremental refresh**
  (the template default). To load a large history without hitting the 5-hour wall, **bootstrap the
  partitions month-by-month over XMLA** (see below).

---

## The failure this prevents

A full **Import** refresh loads the audit fact table as a **single unpartitioned step**. On a large
initial window (4 months) that one step runs until it hits the hard **~5-hour XMLA limit** and fails:

```
Status:  Failed
Message: An error occurred while processing the semantic model.
Data source error: The XML for Analysis request timed out before it was completed.
                   Timeout value: 17996 sec        (≈ 5 hours)
Details: # 1  Type=Data  Duration 5h 0m 9s  Failed   ← one table step, never finished
```

Repeated failures also cause **scheduled refresh to be auto-disabled**. The two fixes below both
avoid ever asking a single refresh to run longer than ~5 hours.

---

## Decision guide

```
Is the model's workspace on Fabric (F SKU) / Premium (P SKU) / PPU capacity?
│
├─ YES ──► DIRECT LAKE  (no refresh, no 5-hour wall)
│           Keep Delta tables healthy (OPTIMIZE + V-Order) so it stays in
│           Direct Lake mode instead of falling back to DirectQuery.
│
└─ NO (Pro / shared, or non-Fabric SQL backend) ──► IMPORT + INCREMENTAL REFRESH
            Partition by month on CreationDate, then bootstrap month-by-month
            over XMLA so no single refresh exceeds ~5 hours.
```

| | **Direct Lake** | **Import + incremental refresh** |
|---|---|---|
| Capacity required | Fabric / Premium / PPU | Any (incl. Pro) |
| Refresh job | **None** — reads Delta live | Yes, but only newest partition(s) after bootstrap |
| ~5-hour refresh wall | **Not applicable** | Avoided *after* a sliced bootstrap |
| Large initial (4-month) load | **Instant** — data already in Lakehouse | Bootstrap month-by-month via XMLA |
| Where it runs | **Fabric only** (Delta in OneLake) | Any SQL endpoint (Fabric, Synapse, Databricks, Azure SQL) |
| Best when | Model + Lakehouse on same Fabric capacity | Non-Fabric backend, or a self-contained dataset |

---

## Option A — Switch to Direct Lake (recommended on Fabric / Premium)

The ingester already writes Delta tables to the Lakehouse, so there is nothing to import.

1. **Make the Delta tables healthy first** — see *Delta table hygiene* below. Direct Lake speed is
   bound to Delta file layout.
2. **Create / use a Direct Lake semantic model on the Lakehouse:** open the Lakehouse →
   **New semantic model** (or use its default model) and add the audit / usage / agents tables.
3. **Repoint the report** to the Direct Lake model (keep the same table/column names so visuals and
   measures keep working).
4. **Retire the Import model's scheduled refresh** — that's the job hitting the 5-hour wall and
   getting auto-disabled.
5. New data appears on **reframe** after each ingester write; no scheduled refresh needed.

**Per-SKU guardrails.** Direct Lake has capacity limits (max rows per table, memory for column
segments). On a **Trial or smaller F SKU**, a very large *unpruned* fact table can exceed the limit
and **fall back to DirectQuery** — still no 5-hour wall and no failure, just slower. To stay in true
Direct Lake mode: prune unused columns (especially the heavy `AuditData` JSON blob), keep types
tight, and run OPTIMIZE + V-Order.

---

## Option B — Import + incremental refresh (Pro / shared, or non-Fabric backend)

The policy itself is already configured in the template — see
[`INCREMENTAL-REFRESH.md`](INCREMENTAL-REFRESH.md) for `RangeStart`/`RangeEnd`, window sizes, and how
to change them. The piece that isn't covered there is **how to load a large history the first time
without hitting the 5-hour wall**:

### Month-by-month XMLA bootstrap (the key step for a 4-month initial load)

A first full refresh would try to load all 4 months at once and time out. Instead, refresh **one
month partition at a time** via the **XMLA endpoint / Enhanced Refresh API**, so each stays well
under ~5 hours. After the bootstrap, the normal scheduled refresh only touches the current
partition(s) → minutes, not hours.

**Enhanced Refresh REST API — refresh a single month partition:**
```http
POST https://api.powerbi.com/v1.0/myorg/groups/{workspaceId}/datasets/{datasetId}/refreshes
Content-Type: application/json

{
  "type": "full",
  "commitMode": "transactional",
  "objects": [
    { "table": "Chat + Agent Interactions (Audit Logs)", "partition": "2026Q2-04" }
  ],
  "maxParallelism": 2
}
```

**TMSL alternative (SSMS / Tabular Editor against the workspace XMLA endpoint):**
```json
{
  "refresh": {
    "type": "full",
    "objects": [
      { "database": "Value-Powerbi",
        "table": "Chat + Agent Interactions (Audit Logs)",
        "partition": "2026-04" }
    ]
  }
}
```

Repeat per month (e.g. `2026-01`, `2026-02`, `2026-03`, `2026-04`). Partition names depend on your
incremental-refresh granularity — set granularity to **month** so partitions map 1:1 to months.

> Requires a **Premium / PPU / Fabric** workspace (XMLA read-write). On plain Pro you cannot use
> XMLA; keep the history window small enough that the first full refresh finishes under ~5 hours, or
> move to a capacity workspace.

---

## Delta table hygiene (applies to BOTH modes — do it in the ingester)

File layout dictates Direct Lake read speed and Import refresh speed. After each write, compact and
V-Order the Delta tables:

```python
# Fabric / Spark — run after writing each Delta table in the ingester notebooks
spark.sql("OPTIMIZE <table> VORDER")     # compact small files + V-Order
# V-Order is enabled by default in Fabric Spark; OPTIMIZE collapses small-file fragmentation.
```

Recommended:
- **OPTIMIZE + V-Order** every table the model reads.
- **Don't surface** the heavy `AuditData` JSON column in the model unless a visual needs it.
- Keep **types tight** and expose only columns the report uses.

---

## Quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Refresh fails at **5h 0m**, `Timeout value: 17996 sec`, step **# 1 Type=Data** | Single unpartitioned Import of a huge fact table | Direct Lake (capacity) **or** incremental + month-by-month XMLA bootstrap |
| Scheduled refresh **auto-disabled** | Repeated 5-hour failures (or missing credentials) | Fix the mode as above; re-check data-source credentials; re-enable |
| Direct Lake slow / **fell back to DirectQuery** | Small-file fragmentation or per-SKU guardrail exceeded | OPTIMIZE + V-Order, prune columns / `AuditData`, tighten types |
| Ingester throttled: `429 Too Many Requests` on `security/auditLog/queries` | Too many concurrent Graph audit queries during backfill | Lower `MAX_CONCURRENT_QUERIES` (6 → 3/2); rerun (resumable manifest skips finished windows) |

See also: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) ·
[`INCREMENTAL-REFRESH.md`](INCREMENTAL-REFRESH.md) ·
[`INGESTION-STRATEGY.md`](INGESTION-STRATEGY.md)
