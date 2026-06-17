# Fabric / Lakehouse deployment (recommended)

The recommended path. Notebooks pull your Copilot data from Microsoft Graph and write Delta tables
straight into a Lakehouse. The Power BI template is a thin client over the Lakehouse SQL endpoint, so
all the heavy JSON parsing happens in Spark and the dataset stays small and fast.

> **Not only Fabric.** The same notebooks and template also run on **Azure Databricks**, **Synapse
> Spark**, **Azure SQL**, or a **Fabric Warehouse** with no real changes. See
> [Works beyond Fabric](#works-beyond-fabric).

## What's here

| Item | Purpose |
|---|---|
| `AI Business Value Dashboard - Fabric.pbit` | The Power BI template (thin client over a Lakehouse SQL endpoint). |
| `notebooks/Copilot_Audit_Log_Direct_Ingester.ipynb` | **Core.** Graph audit-log API -> `dbo.copilot_interactions_parsed`. |
| `notebooks/Copilot_Licensed_Users_Direct_Ingester.ipynb` | **Core.** Graph M365 active-user report -> `dbo.copilot_licensed_users`. |
| `notebooks/Copilot_Org_Data_Direct_Ingester.ipynb` | **Core.** Graph `/users` (+ manager) -> `dbo.copilot_org_data`. |
| `notebooks/` (the rest) | *Optional* sources: agent transcripts, credit/billing consumption, product feedback, Agents 365. See [Optional sources](#optional-sources). |
| `pipelines/`, `flows/`, `docs/` | Optional: a Fabric pipeline to run the core notebooks on a schedule, Power Automate flows for export-only sources, and reference docs. |

## Quick start

### 1. Create a Lakehouse

In a Fabric workspace on a capacity (F2+ or trial): **+ New -> Lakehouse**, name it (e.g.
`CopilotAdoptionLake`). Note its **SQL endpoint** from Lakehouse settings -
`<workspace-guid>.datawarehouse.fabric.microsoft.com`.

### 2. Register an Entra app

Create an app registration with these **Microsoft Graph application** permissions (admin consent
required), then note the **Tenant ID**, **Client ID**, and a **Client secret value**:

| Permission | Used by |
|---|---|
| `AuditLogsQuery.Read.All` | Audit log notebook |
| `Reports.Read.All` | Licensed users notebook |
| `User.Read.All` | Org data notebook |

### 3. Run the three core notebooks

For each core notebook (audit logs, licensed users, org data): **+ New -> Import notebook**, attach it
to your Lakehouse and pin it as default, then paste your three values into the `# === CONFIG ===`
cell and run.

| Notebook | Cadence | Output table |
|---|---|---|
| `Copilot_Audit_Log_Direct_Ingester.ipynb` | Daily (Graph caps audit queries to a 7-day window) | `dbo.copilot_interactions_parsed` |
| `Copilot_Licensed_Users_Direct_Ingester.ipynb` | Weekly / monthly | `dbo.copilot_licensed_users` |
| `Copilot_Org_Data_Direct_Ingester.ipynb` | Weekly | `dbo.copilot_org_data` |

Use each notebook's **Schedule** button, or wire all three into a single Fabric pipeline (see
`pipelines/`).

> For production, read the secret from Key Vault instead of a literal - each CONFIG cell has a
> commented `notebookutils.credentials.getSecret(...)` example.

### 4. Connect the template

Open `AI Business Value Dashboard - Fabric.pbit` in Power BI Desktop and supply the parameters:

| Parameter | Required? | Value |
|---|---|---|
| **Fabric SQL Endpoint** | Yes | `<workspace-guid>.datawarehouse.fabric.microsoft.com` |
| **Lakehouse Name** | Yes | Your Lakehouse name (e.g. `CopilotAdoptionLake`) |
| `Enable_Dataverse` | Optional | `Include` to load agent tables, else `Exclude` |
| `Enable_ProductFeedback` | Optional | `Include` to load `user_feedback`, else `Exclude` |
| `Enable_Agent365` | Optional | `Include` to load `agents_365`, else `Exclude` |
| `Enable_Consumption` | Optional | `Include` to load the 3 billing tables, else `Exclude` |

Click **Load**, then **Publish** - ideally to a workspace on the **same Fabric capacity** so Direct
Lake works without cross-capacity overhead.

### 5. Schedule the refresh

In the Service: dataset **Settings -> Data source credentials** -> sign in to the SQL endpoint, then
enable **Scheduled refresh** on a cadence that matches your notebook schedule.

## Optional sources

Leave every `Enable_*` toggle on `Exclude` and the core dashboard still works - optional tables simply
load empty. To switch one on, set its toggle to `Include` and run the matching notebook:

| Page(s) | Toggle | Notebook |
|---|---|---|
| Agent transcripts (Copilot Studio) | `Enable_Dataverse` | `Copilot_Agent_Transcript_Parser.ipynb` |
| Credit / billing consumption | `Enable_Consumption` | `Copilot_Credit_Consumption_Ingester.ipynb` ([setup guide](CREDIT-CONSUMPTION-SETUP.md)) |
| Product feedback | `Enable_ProductFeedback` | `Copilot_ProductFeedback_Ingester.ipynb` |
| Agents 365 | `Enable_Agent365` | `Copilot_Agent365_Lander.ipynb` (supported export lander) |

Credit consumption and product feedback are **export-only** in Microsoft's portals (no API) - the
`flows/` folder has Power Automate flows that auto-land those exports for you. Full detail in
[`docs/OPTIONAL-SOURCES.md`](docs/OPTIONAL-SOURCES.md).

## Works beyond Fabric

The two core artifacts are deliberately portable:

- **The notebooks** are plain Python + PySpark - they call Graph with `requests` and write Delta with
  `df.write.saveAsTable(...)`. They run unchanged on any Spark engine (Fabric, Databricks, Synapse).
- **The template** uses the `Sql.Database()` connector, which works against any SQL endpoint exposing
  those tables - Fabric Lakehouse or Warehouse, Databricks SQL Warehouse, Synapse SQL pool, Azure SQL.

To retarget, change just two things: point the notebooks' `OUTPUT_TABLE` at your database, and set the
template's two parameters (**Fabric SQL Endpoint** = your host, **Lakehouse Name** = your database).
The template only needs the three tables - `copilot_interactions_parsed`, `copilot_licensed_users`,
`copilot_org_data` - to exist in that one database with their expected schema. Already producing parsed
CSVs upstream? The [`../2. SharePoint/`](../2.%20SharePoint/) path consumes them with no Spark step.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401`/`403` from Graph | Confirm the three **application** permissions are admin-consented; regenerate the client secret if expired. The audit notebook needs `AuditLogsQuery.Read.All` specifically (it calls `/security/auditLog/queries`). |
| Audit query never finishes | Purview processes it asynchronously; the notebook polls with backoff. If it times out, narrow `LOOKBACK_DAYS` in the CONFIG cell. |
| `Login failed` / `cannot open database` (Power BI) | The SQL endpoint host or database name is wrong - recheck the Lakehouse settings page. |
| `the key didn't match any rows` | A notebook ran against the wrong Lakehouse - pin your Lakehouse as default and re-run. |
| All users show "Unlicensed" | The licensed-users notebook hasn't run yet, or its report period is too narrow (`REPORT_PERIOD = 'D30'`). |
| Refresh slow (over a minute) | Dataset is in Import mode - put the workspace on a Fabric capacity and convert to **Direct Lake**. |

## Reference

- **Table schemas:** [`docs/DATA-DICTIONARY.md`](docs/DATA-DICTIONARY.md)
- **Optional sources in depth:** [`docs/OPTIONAL-SOURCES.md`](docs/OPTIONAL-SOURCES.md)
- **Credit consumption, step by step:** [`CREDIT-CONSUMPTION-SETUP.md`](CREDIT-CONSUMPTION-SETUP.md)
- **Audit-log JSON schema:** [Microsoft Learn - CopilotInteraction](https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema)
