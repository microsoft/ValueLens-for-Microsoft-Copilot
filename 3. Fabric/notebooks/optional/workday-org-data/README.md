# Workday org data — optional add-on

**Edge case. Skip this folder unless you have a Workday (or comparable HRIS) worker extract.**

The core path gets its org dimension from `Copilot_Org_Data_Direct_Ingester`, which pulls Entra via
Microsoft Graph. This optional notebook can add HRIS attributes to that snapshot, or produce the
org dimension from a worker extract when no Entra snapshot is available.

| | Entra (`/users`) | Workday extract |
|---|---|---|
| Manager chain, `displayName`, AAD object id | ✅ | ❌ |
| Job family, persona, worker type, compensation grade | ❌ | ✅ |

Both sources must identify the same person by **work email**, represented by `PersonId` (with
`PersonId_Normalized` available for normalized matching). A Workday employee number or Entra object GUID is not interchangeable with
email: map it explicitly upstream if the export does not carry work email.

The default `MODE = 'auto'` enriches an existing valid baseline and uses standalone mode only when
`BASE_TABLE` is absent. An existing table with an invalid schema is an error, not permission to
replace it with Workday data.

**Enrichment is additive-only.** All existing baseline columns, values (including nulls/blanks),
types, identities, hierarchy and people remain unchanged. Only columns absent from the baseline
are added from Workday. Column comparisons account for case and output-name sanitization.
Workday-only people are not added in enrich mode.

**Migration from the earlier lander:** Workday no longer overrides or fills existing Entra HR
fields, even where Entra values are blank. The old precedence/overlay settings are not the way to
configure this version. Review the configuration cell when importing the updated notebook.

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
3. Review the config cell (see below). For a first run, set `OUTPUT_TABLE` to a separate preview
   table, for example `dbo.copilot_org_data_workday_preview`, then **Run all**.
4. Check the preview and identity match counts. To publish deliberately, set `OUTPUT_TABLE` to
   `dbo.copilot_org_data` and set `ALLOW_BASE_OVERWRITE = True` when it is also the baseline.
   Rerun, then refresh the semantic model.

### Run order — matters on every run, not just first install

```
Copilot_Org_Data_Direct_Ingester   ->   this notebook   ->   refresh semantic model
```

Use a fresh Graph baseline on each enrichment cycle, or keep the Graph baseline and enriched output
in separate tables. Previously added Workday columns already exist in an enriched baseline, so
additive mode preserves them rather than refreshing their values.

With no Entra source, set `MODE = 'standalone'` for recurring refreshes and run this notebook
directly before the model refresh. `auto` tests for table existence, not whether a table really
came from Entra; after the first standalone write to the baseline name, it would see that table
on the next run.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `MODE` | `auto` | Existing valid baseline: additive enrichment. Absent baseline: standalone. Use explicit `enrich` or `standalone` for a fixed scheduled path. |
| `BASE_TABLE` | `dbo.copilot_org_data` | Existing org baseline. Enrich requires `PersonId` containing work email. |
| `OUTPUT_TABLE` | `dbo.copilot_org_data_workday_preview` | Safe preview default. Change deliberately to `dbo.copilot_org_data` to publish to the model. |
| `ALLOW_BASE_OVERWRITE` | `False` | Must be explicitly enabled when output and baseline identify the same table. |
| `WORKDAY_EMAIL_COLUMN` | `primaryWorkEmail` | Explicit source email header; case and punctuation are ignored when locating it. Set this for differently named email fields. |
| `INCLUDE_UNMATCHED_WORKDAY` | `False` | Additive enrichment preserves the baseline population; enabling this is rejected. Standalone uses the Workday population. |
| `MIN_WORKDAY_MATCH_RATE` | `0.5` | Minimum share of Workday rows that must match an Entra identity before the run is allowed to proceed. |

## Expected columns

`WORKDAY_EMAIL_COLUMN` identifies the **only required source field**.
Other attributes are optional. Original source fields are retained where their output names are
not already present in the baseline. Standalone mode also supplies canonical mappings and
nullable fields needed by the model. Additive enrichment does not reinterpret missing Entra
attributes from differently named Workday fields.

| Workday column | Becomes |
|---|---|
| `primaryWorkEmail` | `PersonId` / join key |
| `Job_Profile` | Retained; standalone also supplies `JobTitle` where absent |
| `Job_Family_Group` | Retained; standalone also supplies `Organization` + `Function` where absent |
| `sub_Country` | Retained; standalone also supplies `officeLocation` + `Location` where absent |
| `country` | `country` |
| `On_Leave` | Retained; standalone also supplies derived `IsOnLeave` where absent |
| `Job_Family`, `Persona`, `Compensation_Grade`, `Worker_Type`, `Worker_SubType` | kept as-is |

Additional fields such as `Persona` are retained too, subject to baseline precedence and column-name
validation. Existing columns win even if all their values are blank; ambiguous new output names
are rejected rather than silently combined.

The notebook lands a user-level org dimension; it does not create new Power BI relationships.
The PBIT's existing org query and `Audit_UserId` to `PersonId` relationships connect matching people
after refresh. A file identity with no matching interaction identity cannot be attributed automatically.
Additional fields can be selected for visuals after reviewing the refreshed model schema.
Without Entra, unavailable manager/hierarchy fields remain blank; no hierarchy is invented.

## What it refuses to do

The notebook stops rather than shipping a quietly-wrong org dimension:

| Condition | Why it matters |
|---|---|
| Fewer than `MIN_WORKDAY_MATCH_RATE` of rows match Entra | Catches the wrong export, wrong tenant, or an email-domain mismatch between Workday and Entra |
| Duplicate work email with conflicting attributes | Picking a winner arbitrarily would be silent data corruption (exact duplicates collapse fine) |
| Blank work email, or no email column at all | An unusable identity |
| Existing baseline lacks `PersonId` | It is not a valid baseline; auto must not silently replace it |
| Ambiguous output names or reserved internal names | Prevents hidden column replacement or Spark ambiguity |
| A join that would fan out `PersonId` | Would double-count people in every org measure |

A **missing** export is *not* an error — it leaves any existing snapshot untouched, so a failed
hand-off never blanks the dashboard.

## Notes

- Enrich never drops baseline columns to make room for Workday, and never coalesces Workday values
  into existing baseline attributes.
- A rerun against the same enriched baseline preserves its existing values. To refresh the added
  Workday attributes, refresh the Graph baseline first or use separate input/output tables.
- The write stages through a temp table, because `OUTPUT_TABLE` and `BASE_TABLE` are normally the
  same Delta table and Spark cannot overwrite a table still in its own read plan.
- Existing baseline metadata is also preserved. Source metadata added by this notebook is not a
  claim that every field in an enriched row originated in Workday.

## Related

- [`../../README.md`](../../README.md) — core notebooks and run order
- [`../../../../docs/DATA-DICTIONARY.md`](../../../../docs/DATA-DICTIONARY.md) — `copilot_org_data` schema
