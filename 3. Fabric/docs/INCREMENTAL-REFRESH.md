# Incremental refresh (Import mode)

The `ValueLens - Fabric.pbit` template ships with **incremental refresh already configured** on the
audit-interactions fact table, so you don't have to set it up. This note explains what it does, what it
needs, and how to change it.

## What's pre-configured

The fact table **`Chat + Agent Interactions (Audit Logs)`** (sourced from `copilot_interactions_parsed`)
carries an Import-mode incremental-refresh policy:

| Setting | Value | Effect |
|---|---|---|
| Archive / rolling window | **12 months** | Only the last 12 months are kept; older rows drop off automatically. |
| Incremental window | **last ~7 days** | Only the most recent days are re-queried on each refresh. |
| Change detection | Rolling window (no polling) | Recent days are re-imported wholesale; older partitions are stored and never re-queried. |

Two auto-managed parameters, **`RangeStart`** and **`RangeEnd`** (DateTime), drive the partition filter
`CreationDate >= RangeStart and CreationDate < RangeEnd`. **Leave them alone** - Power BI sets them per
partition at refresh time. Don't delete, rename, or hard-code them.

## What to expect

- **The first refresh is a full load** of the whole 12-month window - expect it to take a while (tens of
  minutes on a large tenant). This is normal and happens once.
- **Every scheduled refresh after that only appends the last ~7 days**, so it's much faster and stays
  roughly constant no matter how much history has accumulated.
- The ~7-day incremental window overlaps your daily audit pull, so a missed or late run self-heals on the
  next refresh.

## Requirements

- **A Premium, Premium-Per-User (PPU), or Fabric capacity workspace.** Incremental refresh does **not**
  run on a shared / Pro workspace - publish to a capacity-backed workspace.
- **Import storage mode** (the template's default). See *Import + incremental vs Direct Lake* below.
- Valid **data-source credentials** on the dataset (**Settings -> Data source credentials**). If they're
  missing you'll see *"Scheduled refresh is disabled because at least one data source does not have
  credentials"* - sign in to the SQL endpoint, then re-enable scheduled refresh.

## Changing the window

Do this in Power BI Desktop **before** you publish (or re-publish after changing):

1. In **Report** / **Model** view, right-click the **`Chat + Agent Interactions (Audit Logs)`** table ->
   **Incremental refresh**.
2. Adjust **"Archive data starting ... before refresh date"** (the rolling window - e.g. 6, 12, or 24
   months) and **"Incrementally refresh data starting ... before refresh date"** (the re-queried window -
   e.g. 3, 7, or 10 days).
3. **Apply**, then **Publish**. The next refresh in the Service re-partitions to match.

> A shorter rolling window (e.g. 6 months) = a smaller model and a faster first load. A longer incremental
> window = more self-healing overlap but slightly slower refreshes. **12 months / 7 days** is a sensible
> default for most tenants; 6-12 months of look-back covers the majority of adoption reporting.

## Import + incremental vs Direct Lake

Both keep refreshes cheap; pick based on where your data lives:

| | Import + incremental refresh (default) | Direct Lake |
|---|---|---|
| Where it runs | Any SQL endpoint (Fabric, Databricks, Synapse, Azure SQL) | **Fabric only** - reads Delta straight from OneLake |
| Data movement | Imports recent partitions on a schedule | No import - queries the Lakehouse live |
| Best when | Non-Fabric backends, or you want a self-contained dataset | Model + Lakehouse are on the **same Fabric capacity** |
| Setup | Already configured here | Recreate the model as Direct Lake over the Lakehouse |

If your Lakehouse and dataset sit on the same Fabric capacity, Direct Lake is the fastest option (no
import at all). Everywhere else, the shipped **Import + incremental refresh** is the right default.

## Notes

- Incremental refresh applies to the **audit-interactions** fact table (the large, continuously growing
  feed). The current-state snapshot tables (org data, licensed users, credit, Agents 365) are small and
  refresh in full each run - they don't need a policy.
- This is the **Power BI dataset** incremental refresh. It's separate from the **notebook** high-water-mark
  ingest (`MODE=incremental` in the audit ingester), which controls how much data lands in the Lakehouse.
  The two complement each other: the notebook keeps the Lakehouse current, and incremental refresh keeps
  the dataset refresh cheap. See [`INGESTION-STRATEGY.md`](INGESTION-STRATEGY.md).
