# Fabric pipeline (set up by hand)

The [installer](../../installer/) creates this pipeline for you. Use these steps only if you set up
Fabric by hand, after the [notebooks](../notebooks/README.md).

## Set it up

1. **Import the 4 notebooks** into your workspace, if you haven't already:
   - `Copilot_Audit_Log_Direct_Ingester.ipynb`
   - `Copilot_Licensed_Users_Direct_Ingester.ipynb`
   - `Copilot_Org_Data_Direct_Ingester.ipynb`
   - `Copilot_Audit_Log_Processor.ipynb`
2. **Copy the IDs.** Open each notebook. Its URL holds the workspace ID and the notebook ID:
   ```text
   https://app.fabric.microsoft.com/groups/<WORKSPACE_ID>/synapsenotebooks/<NOTEBOOK_ID>?experience=...
   ```
   You need 5 GUIDs total: 1 workspace and 4 notebooks.
3. **Create the pipeline.** In the workspace, choose **+ New** > **Data pipeline**. Open the JSON
   view and paste
   [`CopilotAdoptionPipeline.DataPipeline/pipeline-content.json`](CopilotAdoptionPipeline.DataPipeline/pipeline-content.json).
   Replace:
   - `REPLACE_WITH_WORKSPACE_ID` with the workspace ID
   - `REPLACE_WITH_AUDIT_LOG_NOTEBOOK_ID` with the audit ingester's ID
   - `REPLACE_WITH_LICENSED_USERS_NOTEBOOK_ID` with the licensed users ingester's ID
   - `REPLACE_WITH_ORG_DATA_NOTEBOOK_ID` with the org data ingester's ID
   - `REPLACE_WITH_AUDIT_LOG_PROCESSOR_NOTEBOOK_ID` with the processor's ID

   Leave the other placeholders unless you turn on an [optional source](#optional-sources). Save.
4. **Run it once.** Choose **Run**. The audit ingester takes 5 to 15 minutes; the processor runs
   after it.
5. **Schedule it.** Choose **Schedule**, for example weekly on Sunday at 02:00.
6. **Refresh the semantic model only after pipeline success.** Follow the steps below.

## Refresh Power BI from the pipeline

The pipeline loads the Lakehouse only. To refresh a published model after each run:

1. Publish the report, and set its data source credentials in the semantic model's settings.
2. In the pipeline, add **Activities** > **Semantic model refresh**. Pick a Power BI connection,
   the workspace and the semantic model.
3. Add **On success** dependencies from `Run_Audit_Log_Processor` and from each other branch you
   use (org data, Microsoft 365 activity, product feedback). Don't add one from
   `Conditionally_Run_Agent365`.
4. Leave **Wait on completion** on. Save and run once.

Don't also schedule a refresh in the Power BI service.

## Optional sources

Each one is off by default. To turn one on, set its parameter to `true` and replace its notebook
placeholder. Import the notebook first.

| Parameter | Notebook | Placeholder | Before it runs |
|---|---|---|---|
| `EnableOrgDataPull` (on by default) | `Copilot_Org_Data_Direct_Ingester` | `REPLACE_WITH_ORG_DATA_NOTEBOOK_ID` | Nothing. Set it to `false` if you load org data yourself. |
| `EnableM365Activity` | `Copilot_M365_Activity_Ingester` | `REPLACE_WITH_M365_ACTIVITY_NOTEBOOK_ID` | Turn off concealed names in the Microsoft 365 admin center (**Settings** > **Org settings** > **Services** > **Reports**). |
| `EnableAgent365` | `Copilot_Agent365_Registry_Ingester` | `REPLACE_WITH_AGENT365_REGISTRY_NOTEBOOK_ID` | Needs an Agent 365 licence and the [extra Graph permissions](../../../docs/PERMISSIONS.md). |
| `EnableAgent365` | `Copilot_Agent365_Lander` | `REPLACE_WITH_AGENT365_LANDER_NOTEBOOK_ID` | Runs only if the registry ingester fails. Put the admin center export at `Files/agent365/agents.csv`. |
| `EnableProductFeedback` | `Copilot_ProductFeedback_Ingester` | `REPLACE_WITH_PRODUCT_FEEDBACK_NOTEBOOK_ID` | Put the export in `Files/product_feedback/`, by hand or with the [flow](../flows/). |
| `EnableDataverse` | `Copilot_Agent_Transcript_Parser`, from [Add Agent Evaluator](../Add%20Agent%20Evaluator/) | `REPLACE_WITH_TRANSCRIPT_PARSER_NOTEBOOK_ID` | Add the app registration as an application user in Dataverse. |
| `EnableConsumption` | Retired | `REPLACE_WITH_CREDIT_CONSUMPTION_NOTEBOOK_ID` | Leave it `false`. Use [Add Credit Consumption](../Add%20Credit%20Consumption/) instead. |

## If a run fails

Open **Monitor** > **Pipeline runs**, select the failed activity and read the notebook's log. If
the audit or licensed users ingester failed, the processor is skipped: don't refresh the model
until a run succeeds. When the Agent 365 CSV fallback takes over, the registry activity shows
*Failed* but the run succeeds. That is expected.

To update the pipeline to a newer version, paste the new JSON, replace the placeholders again, and
re-add your refresh step.