# Workday org data — optional add-on

**Edge case. Skip this folder unless you have a Workday (or comparable HRIS) worker extract.**

The core path gets its org dimension from `Copilot_Org_Data_Direct_Ingester`, which pulls Entra via
Microsoft Graph. That's sufficient on its own. This add-on exists for tenants that also have an HRIS
extract carrying attributes Entra simply doesn't hold.

| | Entra (`/users`) | Workday extract |
|---|---|---|
| Manager chain, `displayName`, AAD object id | ✅ | ❌ |
| Job family, persona, worker type, compensation grade | ❌ | ✅ |

Neither source is complete. Both key on the same identity — **work email** — which is what the model
already joins on (`PersonId_Normalized`). So the default `MODE = 'enrich'` overlays Workday onto the
Entra snapshot rather than replacing it.

## Contents

| Path | |
|---|---|
| `Copilot_Org_Data_Workday_Lander.ipynb` | The notebook |
| `samples/org_workday/workday_org_sample.csv` | Synthetic 5-row extract for smoke-testing |
| `samples/README.md` | What the sample covers and how to run it |

## Setup

1. Drop your Workday export at `Files/org_workday/` in the Lakehouse — a single CSV, or several with
   identical headers.
2. Attach the notebook to your Lakehouse.
3. Review the config cell (see below), then **Run all**.

### Run order — matters on every run, not just first install

```
Copilot_Org_Data_Direct_Ingester   ->   this notebook   ->   refresh semantic model
```

The Graph ingester writes `copilot_org_data` with `mode('overwrite')`, so **it drops the Workday
columns every time it runs.** If you schedule the ingester, schedule this immediately after it. This
is the single most likely operational mistake with this add-on.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `MODE` | `enrich` | `enrich` overlays onto the Entra snapshot. `standalone` treats Workday as the only org source and emits the hierarchy columns blank. |
| `ORGANIZATION_SOURCE` | `Job_Family_Group` | **Set this deliberately** — it drives the dashboard's main `Organization` dimension, so it reshapes every org breakdown in the report. `Persona` may suit your narrative better. |
| `ATTRIBUTE_PRECEDENCE` | `workday` | Who wins where both systems supply `Organization` / `JobTitle` / `country` / `officeLocation`. |
| `INCLUDE_UNMATCHED_WORKDAY` | `False` | Whether workers present in Workday but absent from Entra are added as new rows. |
| `MIN_WORKDAY_MATCH_RATE` | `0.5` | Minimum share of Workday rows that must match an Entra identity before the run is allowed to proceed. |

## Expected columns

`primaryWorkEmail` is the **only required column**. Everything else is optional and loads blank if
absent. Header matching ignores case, spaces, underscores and punctuation, so `Job Family Group`,
`job_family_group` and `JobFamilyGroup` all resolve.

| Workday column | Becomes |
|---|---|
| `primaryWorkEmail` | `PersonId` / join key |
| `Job_Profile` | `JobTitle` |
| `Job_Family_Group` | `Organization` *(via `ORGANIZATION_SOURCE`)* + `Function` |
| `sub_Country` | `officeLocation` + `Location` |
| `country` | `country` |
| `On_Leave` | kept, plus derived `IsOnLeave` |
| `Job_Family`, `Persona`, `Compensation_Grade`, `Worker_Type`, `Worker_SubType` | kept as-is |

**Any column not listed is kept as-is — nothing is dropped.** The PBIT's org query preserves every
source column, so these arrive in the model as slicer-ready fields with no report edit. `Function`
and `Location` are already model-declared columns, so they populate existing visuals directly.

## What it refuses to do

The notebook stops rather than shipping a quietly-wrong org dimension:

| Condition | Why it matters |
|---|---|
| Fewer than `MIN_WORKDAY_MATCH_RATE` of rows match Entra | Catches the wrong export, wrong tenant, or an email-domain mismatch between Workday and Entra |
| Duplicate work email with conflicting attributes | Picking a winner arbitrarily would be silent data corruption (exact duplicates collapse fine) |
| Blank work email, or no email column at all | An unusable identity |
| `ORGANIZATION_SOURCE` names a column the export lacks | Would blank the main org dimension |
| A join that would fan out `PersonId` | Would double-count people in every org measure |

A **missing** export is *not* an error — it leaves any existing snapshot untouched, so a failed
hand-off never blanks the dashboard.

## Notes

- Re-running is idempotent: Workday-only columns are dropped from the baseline before the join,
  whether or not the Graph ingester refreshed in between.
- Overlay columns **coalesce** rather than replace, so a worker missing from the Workday file keeps
  their Entra value instead of going blank.
- The write stages through a temp table, because `OUTPUT_TABLE` and `BASE_TABLE` are normally the
  same Delta table and Spark cannot overwrite a table still in its own read plan.
- `OrgData_Source` on each row records which path produced it (`workday:enrich` /
  `workday:standalone`).

## Related

- [`../../README.md`](../../README.md) — core notebooks and run order
- [`../../../docs/DATA-DICTIONARY.md`](../../../docs/DATA-DICTIONARY.md) — `copilot_org_data` schema
