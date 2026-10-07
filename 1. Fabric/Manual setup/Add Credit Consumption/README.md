# ➕ Add Credit Consumption — Fabric

**Optional.** A second, separate Power BI report — **Consumption Central** — covering Copilot
credit consumption and cost across **Cowork / Work IQ**, **Copilot Studio**, **GitHub Copilot** and
**Azure AI Foundry**. ValueLens shows adoption and value; this shows what it costs. Skip it and
nothing in ValueLens changes.

You can use the **same Lakehouse as ValueLens**. Its table names and `Files/landing/` folders don't
overlap with anything ValueLens reads or writes. Load only the products you have; the other pages
stay empty.

> **Using the [Fabric installer](../../installer/#credit-consumption)?** Choose *Credit consumption*
> and it sets up the Azure AI, Copilot Studio and Cowork notebooks, the upload folders, the
> semantic model and the app's Consumption pages for you. You still land the Cowork data
> ([step 1](#viva-dataflow)) and the Copilot Studio exports yourself; the installer prints how.

### What's here

| Item | Purpose |
|---|---|
| `Consumption Central - Fabric.pbit` | The report, reading the Lakehouse SQL analytics endpoint. |
| [`../notebooks/credit-consumption/`](../notebooks/credit-consumption/) | One ingestion notebook per product. Import only the ones you need. |
| [`seed_sample_data.py`](seed_sample_data.py) | Loads the synthetic sample into your Lakehouse. It writes Consumption Central tables only. |
| [`DATA-DICTIONARY.md`](DATA-DICTIONARY.md) | Every table and column the report expects. |

---

## 🛠 Setup

<a id="viva-dataflow"></a>

### 1. Land Cowork data with a Dataflow

The [installer](../../installer/README.md#credit-consumption) does this for you when you choose
**Connected (Dataflow)**. By hand:

1. Viva Insights → **Analysis** → build a query with the Copilot credit metrics → turn on
   **Auto-refresh** → **Analysis results** → **link icon** → copy the **Partition** and **Query**
   identifiers.
2. Fabric workspace → **New** → **Dataflow Gen2** → **Get data** → **Viva Insights**. Paste both
   identifiers and leave *Query Name* blank. Under **Advanced options** set **Schema Type = Pivoted** and
   **Data Granularity = Row-level data**.
3. Set the destination to your Lakehouse, table **`viva_credits_dataflow`**, replacing its data
   each refresh. Keep the person identifiers and employee attributes; department views are built
   from them. Schedule it for **Tuesday morning**, after Viva's weekend refresh, and run
   `Ingest_Viva_Consumption` after it. The notebook merges the Dataflow's rows into
   `viva_credits_weekly`, so history builds up past Viva's six-month window.

A Dataflow you set up earlier that writes straight to `viva_credits_weekly` still works, as long
as you don't also run `Ingest_Viva_Consumption`.

[Microsoft's guide ↗](https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/export-query-data-microsoft-fabric)

### 2. Import the notebooks for your other products

Set the workspace and Lakehouse at the top of each notebook, then run it.

| Notebook | Reads | Writes |
|---|---|---|
| `Ingest_Studio` | Power Platform admin centre exports in `Files/landing/studio/`, and the optional licensing API flow's files there | `studio_*` |
| `Ingest_GitHub_API` | GitHub REST API *(preferred: runs unattended)* | `github_*` |
| `Ingest_GitHub` | The emailed AI usage report in `Files/landing/github/` | `github_*` |
| `Ingest_Azure_AI` | Azure Cost Management and Monitor ([setup ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/ADVANCED-SETUP.md#azure-ingestion-in-fabric)) | `azure_ai_spend`, `azure_ai_tokens`, and `copilot_payg_spend` for Copilot Studio and Cowork pay-as-you-go billed in Azure |
| `Ingest_CommercialTerms` | Your negotiated rates *(optional; the [Fabric App](../../Fabric%20App/README.md#settings-in-the-app) can also take them)* | `commercial_terms` |
| `Ingest_Org` | Viva attributes, optionally overridden by files in `Files/landing/org/` | `org_attributes` |
| `Ingest_Viva_Consumption` | The Dataflow's `viva_credits_dataflow` table, and Viva CSV exports in `Files/landing/viva/`. For weeks both cover, the Dataflow wins | `viva_credits_weekly`, `viva_spending_policy` |

### 3. Open the template

Lakehouse → **Settings** → **SQL analytics endpoint** → copy the connection string. Open
**`Consumption Central - Fabric.pbit`** and fill in:

| Parameter | Value |
|---|---|
| `FabricSQLEndpoint` | The connection string you copied |
| `LakehouseName` | Your Lakehouse name |

### 4. Publish and schedule

Publish to your workspace. Schedule the report's refresh **after** ingestion succeeds. A Power BI
refresh does not run the notebooks.

---

## 🧪 Try it with sample data first

```
pip install pandas deltalake requests
az login --tenant <your-tenant>
python seed_sample_data.py --workspace <workspace-guid> --lakehouse <lakehouse-guid>
```

Both GUIDs are in the Fabric portal URL when the Lakehouse is open. The script reads the CSVs from
[`../../../5. Local CSV/Add Credit Consumption/sample-data/`](../../../5.%20Local%20CSV/Add%20Credit%20Consumption/sample-data/).
It writes to the `dbo` schema; add `--schema=` if your Lakehouse was created without schemas.

> **Per-person and department views** need Viva Insights **Identification** turned on
> ([how ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot#viva-identification)).
> Cowork totals are correct without it.

---

## 📚 Reference

- [How to read the report ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/INTERPRETING.md)
- [Where each export comes from ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/DATA-SOURCES.md)
- [Advanced setup: Azure auth, scheduling ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/ADVANCED-SETUP.md)

The upstream `Ingest_Studio_Consumption` notebook isn't included. It needs a delegated sign-in, so it
can't run on a Fabric schedule. Instead, the installer can create a Power Automate flow,
`Analytics Hub - Copilot Studio credits`, that calls the same Power Platform licensing API each day
as an admin and saves `StudioApiAgentDaily_*.csv` and `StudioApiEntitlement_*.csv` for
`Ingest_Studio`. See the [installer's flows](../../installer/README.md#power-automate-flows-optional).

Copied from [microsoft/ConsumptionCentral-for-Microsoft-Copilot ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot)
(MIT) at commit `24b0ca8`. Full documentation and issues live there.
