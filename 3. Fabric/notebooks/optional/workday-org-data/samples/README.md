# Sample — Workday org extract

`workday_org_sample.csv` is a **synthetic** five-row Workday worker extract with the header shape
`Copilot_Org_Data_Workday_Lander.ipynb` expects. No real people, no real tenant.

Use it to smoke-test the lander before pointing it at a production export:

1. Upload it to your Lakehouse at `Files/org_workday/`.
2. Open `Copilot_Org_Data_Workday_Lander.ipynb`, set `MODE = 'standalone'` and
   `ALLOW_EMPTY_SNAPSHOT = False`, then Run all.
3. Confirm the run reports 5 rows and an `Organization` split across
   `Customer` / `Business Strategy & Delivery` / `Risk` / `Technology`.

> Point `OUTPUT_TABLE` at a scratch table (for example `dbo.copilot_org_data_sample`) for the smoke
> test so you don't overwrite a real snapshot. `MODE = 'enrich'` will refuse these rows against a
> real tenant anyway — none of the `@contoso.com` identities match, so the
> `MIN_WORKDAY_MATCH_RATE` guard trips, which is the guard working as intended.

The row set deliberately covers the cases the notebook has to handle:

| Row | Covers |
|---|---|
| `avery.diaz` | the ordinary case |
| `blake.nkemi` | a contingent worker (`Worker_Type` / `Worker_SubType` split) |
| `casey.obrien` | `On_Leave = 1` → `IsOnLeave = TRUE`, and `accountEnabled = False` in standalone mode |
| `dana.whitfield` | a **quoted** `Job_Profile` containing a comma — proves the CSV parser options are right |
| `elliot.marsh` | a second worker in the same `Job_Family_Group`, so the `Organization` grouping is non-trivial |
