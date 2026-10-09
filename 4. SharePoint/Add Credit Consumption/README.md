# ➕ Add Credit Consumption — SharePoint

**Optional.** A second, separate Power BI report — **Consumption Central** — covering Copilot
credit consumption and cost across **Cowork / Work IQ**, **Copilot Studio**, **GitHub Copilot** and
**Azure AI Foundry**. ValueLens shows adoption and value; this shows what it costs. Skip it and
nothing in ValueLens changes.

Consumption Central has no SharePoint template. The nearest fit for this path is **Viva Direct**:
Cowork data comes straight from Viva Insights, with no files and no extract task.

### What's here

| Item | Purpose |
|---|---|
| `Consumption Central - Viva Direct.pbit` | The report, connected directly to Viva Insights. |

Want to try it on sample data first? Use the
[Local CSV add-on](../../5.%20Local%20CSV/Add%20Credit%20Consumption/).

---

## 🛠 Setup (~10 min)

1. **Viva Insights → Analysis** → build a query with the Copilot credit metrics → turn on
   **Auto-refresh**. Leave the GitHub Copilot credit metric out; it makes the query fail.
2. **Analysis results** → your query → the **link icon** → copy both identifiers.
3. Open **`Consumption Central - Viva Direct.pbit`**, paste them in, click **Load**:

   | Parameter | Value |
   |---|---|
   | `VivaPartitionId` | Partition identifier |
   | `VivaQueryId` | Query identifier |

4. Publish to your workspace and schedule the refresh for **Tuesday morning**, after Viva's weekend
   refresh.

Build your own query under **Analysis**. Identifiers from the Consumption Dashboard's *Connect data*
dialog point at a multi-table result this template can't read, and fail with
`(500) Internal Server Error`.

### Other products *(optional)*

Set **`DataFolder`** to a folder of Copilot Studio, GitHub or Azure AI exports (file names as in the
[Local CSV add-on](../../5.%20Local%20CSV/Add%20Credit%20Consumption/)). Add
`M365SpendingPolicyMetaData.csv` from the Viva query download to show policy names instead of IDs.

`DataFolder` is a local folder path, so a scheduled refresh in the Power BI service then needs an
on-premises data gateway. Leave it blank for Cowork only.

Copilot Studio figures here come from admin centre exports. To read them daily from the Power
Platform licensing API instead, use the [Fabric](../../1.%20Fabric/installer/README.md#power-automate-flows)
or [Power Automate + Dataverse](../../3.%20Power%20Automate%20+%20Dataverse/Add%20Credit%20Consumption/)
path.

> **Per-person and department views** need Viva Insights **Identification** turned on
> ([how ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot#viva-identification)).
> Cowork totals are correct without it.

---

## 📚 Reference

- [How to read the report ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/INTERPRETING.md)
- [Viva connector reference ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/VIVA-CONNECTOR.md)
- [Where each export comes from ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/DATA-SOURCES.md)

Copied from [microsoft/ConsumptionCentral-for-Microsoft-Copilot ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot)
(MIT) at commit `24b0ca8`. Full documentation and issues live there.
