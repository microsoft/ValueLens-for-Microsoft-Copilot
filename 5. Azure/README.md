# 5. Azure (preview scaffold)

Analytics Hub running in **your own Azure subscription**, without Microsoft Fabric. It has the
same data, the same ValueLens Model and measures, and the same app pages as `1. Fabric`.
The design and the roadmap are in [`docs/plans/AZURE-HOSTED-PLAN.md`](../docs/plans/AZURE-HOSTED-PLAN.md).

> **Status: Phase 0 / early MVP.** The infrastructure templates and the DuckDB processor are in place
> and tested. Collection, SQL publish, the web API and the installer's Azure target are not built yet.
> Don't deploy this for customers yet.

## What's here

| Folder | Contents | Status |
|---|---|---|
| `infra/` | Bicep: a user-assigned managed identity, ADLS Gen2 (shared keys off), Log Analytics, Azure SQL serverless (Entra-only), a Container Apps environment, a scheduled run job, a manual migrate job and the web app. Every resource is tagged `valuelens-install-id` | Builds and lints cleanly |
| `jobs/` | The `valuelens-jobs` image: `python -m valuelens_jobs run --steps collect,process,publish,refresh` | `process` works; the other steps are stubs that fail loudly |
| `sql/migrations/` | Versioned `V###__*.sql` scripts and a `schema_version` table | `V001` creates the curated fact |
| `web/` | The Node service that serves the app's `dist` plus `/api/query`, `/api/settings`, `/api/version` and `/api/health` | Design only |
| `teams/` | The Teams tab manifest template (SSO) | Design only |

The processing logic lives in [`shared/python/valuelens_core`](../shared/python/valuelens_core). It's a DuckDB
port of `Copilot_Audit_Log_Processor`, held to the Fabric notebook row for row by
`tests/test_valuelens_core_parity.py`. **The notebook is still the source of truth**: change both together,
then run `python tests/valuelens_golden.py --regenerate` (this needs pyspark and Java) and `--check`.

## Try the processor locally

```powershell
pip install duckdb
$env:PYTHONPATH = "shared\python;5. Azure\jobs"
# raw\copilot_interactions_parsed\*.parquet (and optionally copilot_licensed_users, agents_365)
python -m valuelens_jobs process --data-dir .\data
# -> data\curated\copilot_interactions_curated\part-0.parquet
```

Or run it on single files: `python -m valuelens_core --interactions in.csv --out curated.parquet`.

## Validate the templates

```powershell
az bicep build --file "5. Azure/infra/main.bicep" --stdout > $null
az deployment group what-if -g <rg> --template-file "5. Azure/infra/main.bicep" --parameters "5. Azure/infra/main.bicepparam"
```

The installer will run the same what-if for its plan screen, then deploy in incremental mode. It passes the
live SQL capacity values back in, so scale changes you make survive updates.

## After deployment (installer steps, not ARM)

ARM can't do these, so the installer will:
- Grant the managed identity its Graph app roles (`AuditLogsQuery.Read.All`, `Reports.Read.All`,
  `User.Read.All` and module extras).
- Run the migrate job, which creates the database users.
- Create the web app registration with a federated credential, and the Power BI workspace, model and refresh.
