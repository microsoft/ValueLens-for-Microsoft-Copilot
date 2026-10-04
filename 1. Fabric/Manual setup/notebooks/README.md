# Fabric notebooks (set up by hand)

The [installer](../../installer/) does all of this for you. Use these steps only if you can't use it.

## Before you start

1. **Register an app** in Entra. Add the Microsoft Graph application permissions listed in
   [PERMISSIONS](../../../docs/PERMISSIONS.md), grant admin consent, and create a client secret.
2. **Store the secret** in an Azure Key Vault. Anyone who runs the notebooks needs the
   *Key Vault Secrets User* role on it.
3. **Create a Lakehouse** in your Fabric workspace with **Lakehouse schemas** turned on.

## Load the data

1. **Import 4 notebooks.** In the workspace, choose **Import** > **Notebook** >
   **From this computer**, and pick:

   | Notebook | Writes |
   |---|---|
   | `Copilot_Audit_Log_Direct_Ingester.ipynb` | `copilot_interactions_parsed` |
   | `Copilot_Licensed_Users_Direct_Ingester.ipynb` | `copilot_licensed_users` |
   | `Copilot_Org_Data_Direct_Ingester.ipynb` | `copilot_org_data` |
   | `Copilot_Audit_Log_Processor.ipynb` | `copilot_interactions_curated` |

2. **Attach the Lakehouse** to each notebook as its default Lakehouse.
3. **Fill in the first cell** of the 3 ingesters: `TENANT_ID`, `CLIENT_ID` and `CLIENT_SECRET`.
   To read the secret from Key Vault, set:

   ```python
   CLIENT_SECRET = notebookutils.credentials.getSecret('https://<vault>.vault.azure.net/', '<secret-name>')
   ```
4. **Run the 3 ingesters.** For the first run, set `MODE = 'backfill'` in the audit ingester. It
   loads 180 days (`BACKFILL_DAYS`). Afterwards, set it back to `'incremental'`.
5. **Run `Copilot_Audit_Log_Processor`** once the ingesters finish.
6. **Open the template** in Power BI Desktop and publish it:
   - [`ValueLens - Fabric.pbit`](../ValueLens%20-%20Fabric.pbit): enter the Lakehouse's **SQL analytics endpoint** and its name.
   - Or [`ValueLens - Fabric OneLake.pbit`](../ValueLens%20-%20Fabric%20OneLake.pbit): enter the workspace ID and the Lakehouse ID.
7. **Schedule it** with the [pipeline](../pipelines/README.md).

To check the data, run `ValueLens_Data_Check`. It changes nothing.

## Optional notebooks

Run these before the processor.

| Notebook | Writes | Before you run it |
|---|---|---|
| `Copilot_Agent365_Registry_Ingester` | `agents_365` | Needs an Agent 365 licence and the extra Graph permissions in [PERMISSIONS](../../../docs/PERMISSIONS.md). Fill in the first cell. |
| `Copilot_Agent365_Lander` | `agents_365` | Use this instead of the registry ingester if you don't have an Agent 365 licence. Export the agent list from the Microsoft 365 admin center to `Files/agent365/agents.csv`. |
| `Copilot_ProductFeedback_Ingester` | `user_feedback` | Export product feedback from the Microsoft 365 admin center (**Health** > **Product feedback**) to `Files/product_feedback/`. |
| `Copilot_M365_Activity_Ingester` | `m365_activity_daily` | Fill in the first cell. Only Analytics Hub reads this table; the templates don't. |
| [Workday org data](workday-org-data/README.md) | `copilot_org_data` | Adds HR columns to the org data. Follow its README. |

## Settings you might change

| Setting | Notebook | Change it to |
|---|---|---|
| `AGENT_IDENTITY_PATTERNS` | Processor | Add your own service accounts. Accounts that match, such as Security Copilot agents, aren't counted as people. |
| `INCLUDE_RAW_PASSTHROUGH` | Processor, registry ingester | `True` to keep the raw payloads. They can hold names, file names and URLs, so review privacy first. Then run the processor once with `WRITE_MODE = 'overwrite'`. |

## People show as IDs

If licensed users show as 32-character IDs, Microsoft 365 reports are concealing names. In the
Microsoft 365 admin center, go to **Settings** > **Org settings** > **Services** > **Reports** and
clear **Display concealed user, group, and site names in all reports**. Then rerun the licensed
users ingester and the processor, and refresh the report.