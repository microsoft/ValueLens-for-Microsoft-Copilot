# valuelens-jobs

The Azure-hosted Analytics Hub's data jobs: one container image, run on a schedule as an Azure
Container Apps job (`infra/modules/containerapps.bicep`). It replaces the Fabric notebooks and
pipeline. The processing logic is the shared DuckDB core in `shared/python/valuelens_core`, kept
in step with the Fabric notebooks by the golden tests in `tests/`. No Spark or JVM is needed.

## Steps

`python -m valuelens_jobs run --steps collect,process,publish,refresh` runs these steps in order.

| Step | What it does | Module |
|---|---|---|
| collect | Licensed users (`Reports.Read.All`), then Copilot interactions from the Purview audit log (`AuditLogsQuery.Read.All`) | core |
| | Org data from `/users` (`User.Read.All`) | orgData |
| | Microsoft 365 daily activity reports (`Reports.Read.All`) | m365Activity |
| process | Curates interactions with `valuelens_core.curate()` into `curated/copilot_interactions_curated` | core |
| publish | Loads curated and raw tables into Azure SQL, rewriting only the days that changed | per module |
| refresh | Refreshes the configured Power BI semantic models and waits for them to finish | — |

The other commands are:

- `migrate` applies `2. Azure/sql/migrations/V*.sql` and grants the app's reader identity `db_datareader`. The installer runs it on every deploy.
- `process --data-dir <dir>` runs only the processing step, on local files.

Any failure is logged and the job exits with code 1, so Container Apps records the run as failed.

The job has no credit consumption (Consumption Central) collector yet. Azure AI spend, deployment
health, solution spend and billing reconciliation come from the Fabric notebook `Ingest_Azure_AI`,
or from the Local CSV script `5. Local CSV/Add Credit Consumption/pull_azure_ai.py`.

## Settings

The job reads its settings from environment variables. Bicep sets them.

| Variable | Meaning |
|---|---|
| `AZURE_CLIENT_ID` | The user-assigned managed identity the job runs as |
| `VALUELENS_TENANT_ID` | The customer tenant |
| `VALUELENS_STORAGE_ACCOUNT` | The ADLS Gen2 account (containers `raw`, `curated`, `landing`) |
| `VALUELENS_SQL_SERVER`, `VALUELENS_SQL_DATABASE` | The Azure SQL target. Auth is Entra-only, with an access token. |
| `VALUELENS_MODULES` | A comma list such as `core,orgData,m365Activity`. The default is `core,orgData`. |
| `VALUELENS_AUDIT_HISTORY_DAYS` / `VALUELENS_AUDIT_LOOKBACK_DAYS` | The first-run backfill (default 30) and the re-read window on later runs (default 7) |
| `VALUELENS_POWERBI_WORKSPACE_ID`, `VALUELENS_SEMANTIC_MODELS` | The Power BI workspace, and a JSON object of the models to refresh |
| `VALUELENS_SQL_READER_NAME`, `VALUELENS_SQL_READER_CLIENT_ID` | The web app's identity, granted read access by `migrate` |
| `VALUELENS_MIGRATIONS_DIR` | Where the migrations are. The image sets this to `/app/sql/migrations`. |
| `VALUELENS_SAMPLE_DATA` | Demo mode, set to `true` to turn it on. Collect loads the synthetic sample bundled at `/app/sample-data` into a temporary store instead of calling the tenant APIs, with its dates moved forward by whole weeks to end last week. Publish then replaces only the interactions, licensed and org tables. Remove the setting, and the next run republishes the tenant's data. |

## Storage layout

| Path | Contents |
|---|---|
| `raw/copilot_interactions_parsed/` | Flattened audit records, one parquet file per day |
| `raw/_audit_staging/`, `raw/_state/audit.json` | Audit queries that are still running, and the high-water mark |
| `raw/copilot_licensed_users/`, `raw/copilot_org_data/`, `raw/m365_activity_daily/` | Collector snapshots |
| `curated/copilot_interactions_curated/part-0.parquet` | The curated fact. It is written atomically. |

The SQL tables have the same names as the Fabric Lakehouse tables, so the ValueLens Model only
changes its connection parameters.

## Running locally

```powershell
pip install -r "2. Azure/jobs/requirements.txt" -e shared/python
$env:PYTHONPATH = "2. Azure/jobs"
# Offline: a folder holding raw/copilot_interactions_parsed, raw/copilot_licensed_users, raw/agents_365
python -m valuelens_jobs process --data-dir .\data
python -m pytest tests/test_azure_jobs.py -q
```

To build the image, run `docker build` from the repo root, so that the shared core and the migrations are in the build context:

```powershell
docker build -f "2. Azure/jobs/Dockerfile" -t valuelens-jobs:dev .
```

The `azure-images` workflow builds the image on pull requests. On `installer-v*` tags it publishes `ghcr.io/microsoft/valuelens-jobs:<installer version>`.

## Pitfalls

- **Concealed names in Microsoft 365 reports.** When the tenant hides user names in reports, the reports return hashes, which can't be joined to users. The m365 collector stops and says so. Turn off *Display concealed user, group, and site names in all reports* in Microsoft 365 admin center under Settings > Org settings > Reports.
- **Power BI API access for service principals.** Refresh needs the Fabric tenant setting *Service principals can call Fabric public APIs* to be enabled for a security group that contains the job's identity. That identity also needs to be a Member of the workspace.
- **Azure SQL serverless auto-pause.** The first connection after a pause can fail with error 40613. The job retries for about four and a half minutes.
- **Private networking login timeouts.** Behind a private endpoint, SQL's default Redirect policy can hang at login (`HYT00 Login timeout expired`), even though DNS and port 1433 work. The template sets the Proxy policy in private mode; check `az sql server conn-policy show` if you see this.
- **Hierarchical namespace.** The storage account is ADLS Gen2, so blob listings include directory placeholders (`hdi_isfolder`). The store skips them; deleting one fails with `DirectoryIsNotEmpty`.
- **Failed audit query windows.** Purview sometimes ends an audit query as `failed` or `cancelled` on large tenants. The audit collector works like the Fabric notebook: it sends the window again as a new query with a growing wait (`WINDOW_RETRIES`, default 3), then splits it in half down to `MIN_CHUNK_HOURS` (1h). After a failure or an HTTP 429, it runs fewer queries at once (`MAX_CONCURRENT_QUERIES`, default 5). Windows that finished are merged. While any window is still failing, the high-water mark doesn't move, the job exits with code 1 and lists the failed windows, and the next run queries only those again.
- **Audit Search throttling.** Graph allows only a few audit queries at a time per tenant, so a first load over a long look-back sees many 429s and can take an hour or more. Windows that still fail are kept as failed in the manifest and the next run picks them up.
- **Reading job logs.** `az containerapp job logs show -g <rg> -n <job> --execution <name> --container <migrate|run>` reads the console directly and works while Log Analytics ingestion is still catching up.
