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
| | Copilot Studio credits and Viva (Copilot Chat) credits from the drop folder; Azure AI spend, tokens and Copilot pay-as-you-go from Azure Resource Manager | consumption |
| | Shadow AI and agent risk from Microsoft Defender (`ThreatHunting.Read.All`, `CloudApp-Discovery.Read.All`) | defender |
| process | Curates interactions with `valuelens_core.curate()` into `curated/copilot_interactions_curated` | core |
| publish | Loads curated and raw tables into Azure SQL, rewriting only the days that changed | per module |
| refresh | Refreshes the configured Power BI semantic models and waits for them to finish | — |

The other commands are:

- `migrate` applies `2. Azure/sql/migrations/V*.sql` and grants the app's reader identity `db_datareader`. The installer runs it on every deploy.
- `process --data-dir <dir>` runs only the processing step, on local files.

Any failure is logged and the job exits with code 1, so Container Apps records the run as failed.

## Credit consumption (module `consumption`)

These collectors port the Fabric notebooks `Ingest_Studio`, `Ingest_Viva_Consumption` (its CSV path)
and `Ingest_Azure_AI`. They write the same tables, with the same columns, so the Consumption Central
model reads `dbo.<table>` in Azure SQL. Each collector fails on its own, and the others still run.

- **studio** (`collect/studio.py`) reads `studio/*.csv` from the drop folder. These are the Power
  Platform admin center exports (`*Tenant*`, `*PerAgent*`/`*Agent*` and `*PerUser*`/`*User*`, where
  the first pattern that matches wins) and the flow's licensing-API files (`StudioApiEntitlement*`,
  `StudioApiAgentDaily*`, `StudioApiUserDaily*`). An export takes precedence over API rows for the
  same month (agent and user) or the same day and environment (tenant).
  - The per-user API rows get UPNs from Graph `$batch` on a best-effort basis: a failure is logged,
    and the user is kept without a UPN.
- **viva** (`collect/viva.py`) reads `viva/PersonServiceCreditsMetrics*.csv`, merging on person,
  service, policy and week. `viva/SpendingPolicyMetadata*.csv` replaces `viva_spending_policy`, but
  only when a file is present.
- **azure_ai** (`collect/azure_ai.py`) runs only when `VALUELENS_AZURE_AI_SUBSCRIPTION` is set. It
  collects the last 90 complete UTC days, in two groups:
  - Strict:
    - `azure_ai_spend` (Cost Management)
    - `azure_ai_tokens` (Azure Monitor)
    - `copilot_payg_spend` (Copilot Studio and Cowork pay-as-you-go, for the AI subscription plus
      `VALUELENS_PAYG_SUBSCRIPTIONS`)
  - Best effort; a failure leaves the table as it was:
    - `azure_deployment_health`
    - `azure_solution_spend`
    - `azure_billing_reconciliation`
  - Without that subscription, pay-as-you-go isn't read either, as in Fabric.
  - The managed identity needs Cost Management Reader and Monitoring Reader (or Reader) on each
    subscription.
  - The block of pure helpers is a verbatim copy of the one in `pull_azure_ai.py` and the notebook,
    and `tests/test_azure_ai_collectors.py` keeps the copies identical.

Files in the drop folder are never moved or deleted. Every run re-reads all of them and merges the
results idempotently into the state kept in `curated/<table>/part-0.parquet`, as Fabric does with
its Delta tables.

The drop folder has the subfolders `studio/` and `viva/`. The Power Automate flow's `flows/`
state is ignored. Where the folder lives depends on the networking mode:

- Public networking uses the storage account's `landing` container (`landing/studio/`,
  `landing/viva/`).
- Private networking uses SharePoint when `VALUELENS_DROP_SITE_ID` is set. The job reads it
  through Microsoft Graph with the managed identity, which needs `Sites.Selected` and a read grant
  on the site.
  - The site is either a Graph site id (`host,guid,guid`) or `host:/sites/Name`. Both are resolved
    with `GET /sites/{value}`.
  - With `VALUELENS_DROP_DRIVE_ID` set, `VALUELENS_DROP_FOLDER` is a path from that drive's root.
  - With it empty, the folder's first segment names the document library (for example
    `Shared Documents/ValueLens`).

| Table | Source | Publish |
|---|---|---|
| `studio_tenant_daily`, `studio_agent_daily`, `studio_user_daily` | studio | by `usage_date` |
| `studio_agent`, `studio_user` | studio | snapshot |
| `viva_credits_weekly` | viva | by `metric_date` |
| `viva_spending_policy` | viva | snapshot |
| `azure_ai_spend`, `azure_ai_tokens`, `copilot_payg_spend`, `azure_deployment_health`, `azure_solution_spend`, `azure_billing_reconciliation` | azure_ai | snapshot |

`2. Azure/sql/migrations/V002__consumption.sql` creates every table up front, so a refresh before
the first collection finds empty tables. A table whose source has never run is skipped at
publish. The consumption tables never trigger the full refresh of the incremental Copilot model.

## Defender (module `defender`)

Optional and off by default. It mirrors `Copilot_Defender_Ingester.ipynb` on Fabric; both run
`valuelens_core.defender`. It reads advanced hunting through Microsoft Graph
`POST /security/runHuntingQuery` and Cloud Discovery through the Graph beta
`security/dataDiscovery/cloudAppDiscovery`, as the managed identity.

- **Each probe fails on its own.** Device activity, installed software, AI agents and Cloud
  Discovery each write a row to `defender_status` (`ok`, `empty`, `forbidden`, `unlicensed` or
  `error`). A probe that didn't answer keeps its last good data, and the run carries on. Only
  storage errors fail the step.
- **The watchlist** is `landing/defender/ai_watchlist.csv`. The first run writes the starting list
  there; edit it to add tools or set their posture. If it can't be read, the run uses the starting
  list and logs a warning.
- **First run** loads 29 days; later runs reload from the day before the last loaded day.

| Table | Publish |
|---|---|
| `defender_shadow_ai_daily`, `defender_shadow_ai_totals_daily` | by `Day` |
| `defender_ai_watchlist`, `defender_ai_installed`, `defender_cloud_discovery_ai`, `defender_ai_agents`, `defender_status` | snapshot |

`2. Azure/sql/migrations/V003__defender.sql` creates them up front, so the model loads empty tables
until the first run.

## Settings

The job reads its settings from environment variables. Bicep sets them.

| Variable | Meaning |
|---|---|
| `AZURE_CLIENT_ID` | The user-assigned managed identity the job runs as |
| `VALUELENS_TENANT_ID` | The customer tenant |
| `VALUELENS_STORAGE_ACCOUNT` | The ADLS Gen2 account (containers `raw`, `curated`, `landing`) |
| `VALUELENS_SQL_SERVER`, `VALUELENS_SQL_DATABASE` | The Azure SQL target. Auth is Entra-only, with an access token. |
| `VALUELENS_MODULES` | A comma list such as `core,orgData,m365Activity,consumption,defender`. The default is `core,orgData`. |
| `VALUELENS_AZURE_AI_SUBSCRIPTION` | consumption: the subscription for Azure OpenAI / AI Foundry costs and metrics. When it is empty, Azure AI and pay-as-you-go are skipped. |
| `VALUELENS_PAYG_SUBSCRIPTIONS` | consumption: other subscriptions, as a comma list, whose Copilot pay-as-you-go costs are read |
| `VALUELENS_DROP_SITE_ID`, `VALUELENS_DROP_DRIVE_ID`, `VALUELENS_DROP_FOLDER` | consumption, private networking: the SharePoint drop folder (see above). When unset, the job reads the `landing` container. |
| `VALUELENS_AUDIT_HISTORY_DAYS` / `VALUELENS_AUDIT_LOOKBACK_DAYS` | The first-run backfill (default 30) and the re-read window on later runs (default 7) |
| `VALUELENS_AUDIT_BACKFILL_DAYS` | A one-off reload of this many days of audit history, even after the first run. The installer sets it on a single execution when **Repair or change** loads more history; don't set it on the job itself, or every run reloads. |
| `VALUELENS_POWERBI_WORKSPACE_ID`, `VALUELENS_SEMANTIC_MODELS` | The Power BI workspace, and a JSON object of the models to refresh |
| `VALUELENS_SQL_READER_NAME`, `VALUELENS_SQL_READER_CLIENT_ID` | The web app's identity, granted read access by `migrate` |
| `VALUELENS_MIGRATIONS_DIR` | Where the migrations are. The image sets this to `/app/sql/migrations`. |
| `VALUELENS_SAMPLE_DATA` | Demo mode, set to `true` to turn it on. Collect loads the synthetic sample bundled at `/app/sample-data` into a temporary store instead of calling the tenant APIs, with its dates moved forward by whole weeks to end last week. Publish then replaces only the interactions, licensed and org tables. With `consumption` on, it also loads the synthetic Consumption Central sample from `/app/sample-data/consumption` (dates unchanged) and publishes the consumption tables. Remove the setting, and the next run republishes the tenant's data. |

## Storage layout

| Path | Contents |
|---|---|
| `raw/copilot_interactions_parsed/` | Flattened audit records, one parquet file per day |
| `raw/_audit_staging/`, `raw/_state/audit.json` | Audit queries that are still running, and the high-water mark |
| `raw/copilot_licensed_users/`, `raw/copilot_org_data/`, `raw/m365_activity_daily/` | Collector snapshots |
| `curated/copilot_interactions_curated/part-0.parquet` | The curated fact. It is written atomically. |
| `curated/studio_*/`, `curated/viva_*/` | consumption: the merged Studio and Viva tables, rewritten atomically each run |
| `raw/azure_ai_*/`, `raw/copilot_payg_spend/`, `raw/azure_deployment_health/`, `raw/azure_solution_spend/`, `raw/azure_billing_reconciliation/` | consumption: Azure AI snapshots |
| `landing/studio/`, `landing/viva/` | consumption: the drop folder in public networking. It is read only. |
| `raw/defender_*/` | defender: one parquet file per day for the two daily tables, a snapshot for the rest |
| `landing/defender/ai_watchlist.csv` | defender: the AI watchlist. The first run writes it; after that it is only read |

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
