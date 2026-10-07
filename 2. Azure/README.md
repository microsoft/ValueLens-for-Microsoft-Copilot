# 2. Azure (preview)

Analytics Hub running in **your own Azure subscription**, without Microsoft Fabric. It has the
same data, the same ValueLens Model and measures, and the same app pages as `1. Fabric`.
The design and the roadmap are in [`docs/plans/AZURE-HOSTED-PLAN.md`](../docs/plans/AZURE-HOSTED-PLAN.md).

> **Status: preview (Phase 1 MVP).** The installer deploys it end to end: Azure SQL, the Container Apps
> jobs, the Power BI model, the web app and a Teams package. It collects Copilot interactions, licences and
> org data, and Microsoft 365 activity. The other modules are coming. Try it in a demo or test tenant first.

## Install it

1. [Download the installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe)
   (0.3.0 or later) and open it, or run `npx valuelens-install --ui` from `1. Fabric/installer` after
   `npm install` (see [Without the exe](../1.%20Fabric/installer/README.md#without-the-exe)).
2. Pick **Your Azure subscription**, tick the data to collect, and choose which data the dashboard shows:
   - **Your tenant's data** collects from the audit log and Microsoft Graph.
   - **Demo mode (sample data)** publishes a synthetic sample instead, with its dates moved forward to end
     last week. It's handy for a demo or to try Analytics Hub before the Graph permissions are granted. Run
     the installer again, choose **Repair or change** and pick your tenant's data to switch; the next run
     replaces the sample.
3. Review the plan and approve it. The installer prints the web app's URL and writes `AnalyticsHub-Teams.zip`.

What you need, networking, regions and the commands are in the installer's
[Azure target section](../1.%20Fabric/installer/README.md#azure-target-preview). The images come from
`ghcr.io/microsoft/valuelens-jobs` and `valuelens-web`, tagged with the installer's version.

## What's here

| Folder | Contents |
|---|---|
| `infra/` | Bicep: a user-assigned managed identity, ADLS Gen2 (shared keys off), Log Analytics, Azure SQL serverless (Entra-only), a Container Apps environment, a scheduled run job, a manual migrate job, the web app and optional private networking. Every resource is tagged `valuelens-install-id`. The installer ships it compiled as `src/azure/main.arm.json` |
| `jobs/` | The `valuelens-jobs` image: `python -m valuelens_jobs run --steps collect,process,publish,refresh` |
| `sql/migrations/` | Versioned `V###__*.sql` scripts and a `schema_version` table, applied by the migrate job |
| `web/` | The `valuelens-web` image: the Node service that serves the app's `dist` plus `/api/query`, `/api/settings`, `/api/version` and `/api/health` |
| `teams/` | The Teams tab manifest template (SSO) |

The processing logic lives in [`shared/python/valuelens_core`](../shared/python/valuelens_core). It's a DuckDB
port of `Copilot_Audit_Log_Processor`, held to the Fabric notebook row for row by
`tests/test_valuelens_core_parity.py`. **The notebook is still the source of truth**: change both together,
then run `python tests/valuelens_golden.py --regenerate` (this needs pyspark and Java) and `--check`.

## Try the processor locally

```powershell
pip install duckdb
$env:PYTHONPATH = "shared\python;2. Azure\jobs"
# raw\copilot_interactions_parsed\*.parquet (and optionally copilot_licensed_users, agents_365)
python -m valuelens_jobs process --data-dir .\data
# -> data\curated\copilot_interactions_curated\part-0.parquet
```

Or run it on single files: `python -m valuelens_core --interactions in.csv --out curated.parquet`.

## Validate the templates

```powershell
az bicep build --file "2. Azure/infra/main.bicep" --stdout > $null
az deployment group what-if -g <rg> --template-file "2. Azure/infra/main.bicep" --parameters "2. Azure/infra/main.bicepparam"
```

The installer runs the same what-if for its plan screen, then deploys in incremental mode. It passes the
live SQL capacity values back in, so scale changes you make survive updates.

## After deployment (installer steps, not ARM)

ARM can't do these, so the installer:
- Grant the managed identity its Graph app roles (`AuditLogsQuery.Read.All`, `Reports.Read.All`,
  `User.Read.All` and module extras).
- Run the migrate job, which creates the database users.
- Create the web app registration with a federated credential, and the Power BI workspace, model and refresh.
