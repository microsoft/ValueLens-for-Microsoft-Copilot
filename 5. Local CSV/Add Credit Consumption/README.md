# ➕ Add Credit Consumption — Local CSV

**Optional.** A second, separate Power BI report — **Consumption Central** — covering Copilot
credit consumption and cost across **Cowork / Work IQ**, **Copilot Studio**, **GitHub Copilot** and
**Azure AI Foundry**. ValueLens shows adoption and value; this shows what it costs. Skip it and
nothing in ValueLens changes.

No product is required. Load what you have; the other pages stay empty.

### What's here

| Item | Purpose |
|---|---|
| `Consumption Central - Local CSV.pbit` | The report. One parameter that matters: `DataFolder`. |
| [`sample-data/`](sample-data/) | Synthetic dataset for all four products. Every path's add-on uses it. |
| [`pull_azure_ai.py`](pull_azure_ai.py) | *Optional.* Writes the Azure AI Foundry CSVs into your folder, including deployment health, solution spend and billing reconciliation. |

---

## 🛠 Setup

### A — Sample data (~2 min)

Open **`Consumption Central - Local CSV.pbit`**, set **`DataFolder`** to the full path of
[`sample-data/`](sample-data/), click **Load**.

### B — Your own data (~10 min)

1. **Make a folder**, for example `C:\Consumption Central\Data`.
2. **Put your exports in it.** File names don't have to match exactly.

   | Product | Where to get it |
   |---|---|
   | Cowork / Work IQ | Viva Insights → **Analysis** → build a query with the Copilot credit metrics → download CSV |
   | Copilot Studio | Power Platform admin centre → **Licensing** → **Copilot Studio** |
   | GitHub Copilot | GitHub → **Billing** → AI usage report |
   | Azure AI Foundry | Azure Cost Analysis export, or `python pull_azure_ai.py "<your folder>"` |

3. **Open the template**, paste the folder path into `DataFolder`, click **Load**.

Copilot Studio figures here come from admin centre exports. To read them daily from the Power
Platform licensing API instead, use the [Fabric](../../1.%20Fabric/installer/README.md#power-automate-flows)
or [Power Automate + Dataverse](../../3.%20Power%20Automate%20+%20Dataverse/Add%20Credit%20Consumption/)
path.

Everything else has a default. List price is **$0.01 per credit**; change `CreditRate` only if your
agreement differs ([rates ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/COMMERCIAL-TERMS.md)).

> **Per-person and department views** need Viva Insights **Identification** turned on
> ([how ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot#viva-identification)).
> Cowork totals are correct without it.

---

## 📚 Reference

- [How to read the report ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/INTERPRETING.md)
- [Where each export comes from ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/DATA-SOURCES.md)
- [Every measure explained ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/MEASURES.md)

Copied from [microsoft/ConsumptionCentral-for-Microsoft-Copilot ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot)
(MIT) at commit `24b0ca8`. Full documentation and issues live there.
