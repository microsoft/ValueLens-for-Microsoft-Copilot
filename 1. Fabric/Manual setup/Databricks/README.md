# Databricks route

This route adapts the ValueLens notebook set to Databricks and Unity Catalog while keeping
the existing table names and report-facing schemas. It contains 16 notebooks: the 15 notebooks
in the manual Fabric folder and the optional Workday org-data lander. The separate
Consumption Central and Agent Evaluator notebook sets are not included. Managed App integration
is a later phase.

**Power BI template status:** a Databricks-connected `.pbit` is not included. The existing report
source is a `.pbit`, and the supported modeling path available in this worktree requires PBIP
source or a modeling MCP. Neither is available, so the existing report has not been rewritten
or relabeled as a Databricks template. See [Power BI connection guidance](#power-bi-connection-guidance).

No Databricks workspace, compute, credentials, or live Power BI refresh was used to validate
this route. The offline checks do not replace a workspace run.

## Prerequisites

- A Unity Catalog-enabled Databricks workspace and a supported Databricks Runtime **13.3 LTS
  or later**, using a **standard** or **dedicated** access mode cluster.
- A catalog, schema, and Unity Catalog volume. Notebook defaults are `main`, `dbo`, and
  `valuelens`; pass different values through the `catalog`, `schema`, and `volume` widgets.
- Permission to create and modify tables in the schema, and read/write access to the volume.
- An Entra application with the Microsoft Graph permissions for the feeds you run. Store its
  client secret in a Databricks secret scope; do not put it in notebook source or job JSON.
- For Power BI refresh, a Power BI service principal with the required tenant setting and
  workspace access. This refresh identity is separate from the Databricks SQL connector
  credentials used by the semantic model.

Create the schema and volume using your approved catalog and names, for example:

```sql
CREATE SCHEMA IF NOT EXISTS main.dbo;
CREATE VOLUME IF NOT EXISTS main.dbo.valuelens;
```

Keep `valuelens_databricks_runtime.py` alongside the notebooks in the Databricks workspace
folder or Repo. The notebooks import it to select the catalog/schema, map route-relative files,
read the secret, and report Workflow task status.

## Notebook coverage

| Notebook | Role or output |
|---|---|
| `Copilot_Audit_Log_Direct_Ingester` | Core audit ingestion to `copilot_interactions_parsed`; retains incremental, backfill, retry, split, resume, and older-row behavior. |
| `Copilot_Licensed_Users_Direct_Ingester` | Core licensed-user dimension, `copilot_licensed_users`. |
| `Copilot_Org_Data_Direct_Ingester` | Core org dimension, `copilot_org_data`. |
| `Copilot_Audit_Log_Processor` | Core processing to `copilot_interactions_curated`; retains the merge/overwrite and incremental month behavior. |
| `ValueLens_Data_Check` | Read-only checks of the core tables. |
| `ValueLens_Refresh_Model` | Refreshes the Power BI semantic model through the Power BI REST API. |
| `AnalyticsHub_Load_Status` | Writes source/task outcomes to `load_log`; configure as the final Workflow task. |
| `AnalyticsHub_Upload_Router` | Optional CSV routing to `analytics_hub_upload_log`; run before the ingesters that consume routed files. |
| `Copilot_Agent365_Registry_Ingester` | Optional API feed to `agents_365`. |
| `Copilot_Agent365_Lander` | Alternative CSV feed to `agents_365`; use instead of the registry ingester. |
| `Copilot_Resource_Graph_Ingester` | Optional Azure Resource Graph tables, including `arg_status`; run after the Agent 365 feed if linking agents. |
| `Copilot_Defender_Ingester` | Optional Defender tables, including `defender_status`. |
| `Copilot_M365_Activity_Ingester` | Optional `m365_activity_daily` feed. |
| `Copilot_ProductFeedback_Ingester` | Optional `user_feedback` feed. |
| `AnalyticsHub_Access_Scope` | Optional org-scoped access tables, including `access_scope` and `access_people`. |
| `Copilot_Org_Data_Workday_Lander` | Optional Workday export that adds HR columns to `copilot_org_data`. |

Optional input files are read from the configured volume root:

| Input | Volume-relative path |
|---|---|
| Agent 365 CSV | `Files/agent365/agents.csv` |
| Defender watchlist | `Files/defender/ai_watchlist.csv` |
| Product feedback exports | `Files/product_feedback/` |
| Resource Graph inventory fallback | `Files/arg_inventory/` |
| Routed exports | `Files/analytics_hub_uploads/` |
| Access-scope mapping | `Files/analytics_hub_access/access_scope.csv` |
| Workday export | `Files/org_workday/` |

For example, `Files/agent365/agents.csv` maps to
`/Volumes/main/dbo/valuelens/agent365/agents.csv`. Direct `abfss://` paths and Fabric Lakehouse
mounts are not used by this route.

## Parameters and secrets

The shared runtime initializes `catalog=main`, `schema=dbo`, and `volume=valuelens` if those
widgets are not supplied. For each Workflow notebook task, set:

| Parameter | Value |
|---|---|
| `catalog`, `schema`, `volume` | Your Unity Catalog names. |
| `tenant_id`, `client_id` | The Entra tenant and application IDs for tasks that call Microsoft Graph or Power BI. |
| `pbi_workspace_id`, `pbi_semantic_model_id` | Power BI workspace and semantic model GUIDs; used only by the refresh task. |
| `secret_scope`, `client_secret_key` | Databricks secret-scope name and secret key; the default key is `client-secret`. |
| `job_run_id` | `{{job.run_id}}` |
| `task_key` | `{{task.name}}` |
| `task_execution_count` | `{{task.execution_count}}` |

Create the secret in a Databricks secret scope and grant access only to the identities that run
these jobs. `CLIENT_SECRET` is read at runtime with `dbutils.secrets.get`. Do not place secret
values in notebook widgets, Git, Power BI files, or job definitions.

## Databricks Workflows

Use the status activity names below as the Workflow `task_key` values. Run the upload router
before any feed it routes; run the core ingesters before the audit processor; run the Agent 365
feed before Resource Graph when agent linking is needed; run Workday before the processor; then
refresh the model. Configure `Record_Load_Status` with an **All done** dependency on the tasks it
summarizes so it records failures as well as successes.

| Workflow task key | Notebook |
|---|---|
| `Run_Audit_Log_Ingester` | `Copilot_Audit_Log_Direct_Ingester` |
| `Run_Licensed_Users_Ingester` | `Copilot_Licensed_Users_Direct_Ingester` |
| `Run_Org_Data_Ingester` | `Copilot_Org_Data_Direct_Ingester` |
| `Run_Agent365_Registry_Ingester` | `Copilot_Agent365_Registry_Ingester` |
| `Run_Agent365_Lander` | `Copilot_Agent365_Lander` |
| `Run_Resource_Graph_Ingester` | `Copilot_Resource_Graph_Ingester` |
| `Run_Defender_Ingester` | `Copilot_Defender_Ingester` |
| `Run_M365_Activity_Ingester` | `Copilot_M365_Activity_Ingester` |
| `Run_ProductFeedback_Ingester` | `Copilot_ProductFeedback_Ingester` |
| `Run_Access_Scope` | `AnalyticsHub_Access_Scope` |
| `Run_Upload_Router` | `AnalyticsHub_Upload_Router` |
| `Run_Org_Data_Workday` | `Copilot_Org_Data_Workday_Lander` |
| `Run_Audit_Log_Processor` | `Copilot_Audit_Log_Processor` |
| `Refresh_Semantic_Model` | `ValueLens_Refresh_Model` |
| `Record_Load_Status` | `AnalyticsHub_Load_Status` |

For the final task's `task_states_json` parameter, pass a JSON object whose values are dynamic
references to the corresponding Workflow results, for example:

```json
{
  "Run_Audit_Log_Ingester": "{{tasks.Run_Audit_Log_Ingester.result_state}}",
  "Run_Licensed_Users_Ingester": "{{tasks.Run_Licensed_Users_Ingester.result_state}}",
  "Run_Org_Data_Ingester": "{{tasks.Run_Org_Data_Ingester.result_state}}",
  "Run_Audit_Log_Processor": "{{tasks.Run_Audit_Log_Processor.result_state}}",
  "Refresh_Semantic_Model": "{{tasks.Refresh_Semantic_Model.result_state}}",
  "Run_Agent365_CSV_Fallback": "{{tasks.Run_Agent365_Lander.result_state}}"
}
```

Add a reference for each optional task in your Workflow. The `Run_Agent365_CSV_Fallback` alias
lets the load-status logic treat a successful CSV lander as coverage for a failed registry API
load. The notebooks publish start/success status, attempt count, and timing through task values;
the Workflow run remains the authoritative source for detailed task errors.

## Power BI connection guidance

The adapted report template is **blocked**, not included. The existing report file is a `.pbit`;
the supported authoring route available here requires a PBIP project or a Power BI modeling MCP.
Neither is available in this worktree. No existing report pages, measures, relationships, or
visuals have been changed, and the Fabric `.pbit` is not a Databricks template.

When a supported report-authoring source is available, the intended route is to preserve Import
mode and the report model while replacing its source with the Microsoft Databricks connector.
Parameterize the Databricks **Server Hostname**, SQL Warehouse **HTTP Path**, catalog, and schema;
do not embed tokens or passwords. Configure the connector's data-source credentials in Power BI
Desktop and Power BI Service. The `ValueLens_Refresh_Model` notebook separately uses a
service-principal client secret from a Databricks secret scope to request a Power BI REST refresh.
That REST identity does not configure the model's Databricks source credentials.

## References

- [Unity Catalog volumes](https://learn.microsoft.com/en-us/azure/databricks/volumes/)
- [Databricks Jobs dynamic value references](https://learn.microsoft.com/en-us/azure/databricks/jobs/dynamic-value-references)
- [Databricks connector for Power Query and Power BI](https://learn.microsoft.com/en-us/power-query/connectors/databricks)
- [Refresh a semantic model in a group](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/refresh-dataset-in-group)
