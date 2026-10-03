# ➕ Add Credit Consumption — Power Automate + Dataverse

**Optional.** A second, separate Power BI report — **Consumption Central** — covering Copilot
credit consumption and cost across **Cowork / Work IQ**, **Copilot Studio**, **GitHub Copilot** and
**Azure AI Foundry**. ValueLens shows adoption and value; this shows what it costs. Skip it and
nothing in ValueLens changes.

Power Automate pulls the data on a schedule into Dataverse, and the report reads those tables. You
can use the **same environment as ValueLens**: these tables use the `cc_` prefix, and ValueLens
uses `poc_`.

### What's here

| Item | Purpose |
|---|---|
| `Consumption Central - Power Automate + Dataverse.pbit` | The report, reading Dataverse over the TDS endpoint. |
| [`scripts/Deploy-DataverseSchema.py`](scripts/Deploy-DataverseSchema.py) | Creates the Dataverse tables from [`dataverse-schema.json`](dataverse-schema.json). |
| `flows/ConsumptionCentral-Dataverse.zip` | Eight flows (daily + backfill) for Studio, Azure AI and GitHub. |
| [`PERMISSIONS.md`](PERMISSIONS.md) | App registration, roles and Key Vault setup. |

**Needs:** a Dataverse environment where you're System Administrator, Power BI Desktop and
Python 3.9+.

---

## 🛠 Setup (an afternoon)

### 1. Create the tables

```
cd "2. Power Automate + Dataverse/Add Credit Consumption/scripts"
python Deploy-DataverseSchema.py --environment https://your-org.crm.dynamics.com
```

That's a dry run: it lists the 12 tables and 173 columns and changes nothing. Set a token in
`DATAVERSE_TOKEN` and add `--execute` to create them. Re-running skips anything that already exists.

### 2. Import the flows

[make.powerautomate.com](https://make.powerautomate.com) → **My flows** → **Import** →
**Import Package (Legacy)** → upload `flows/ConsumptionCentral-Dataverse.zip`. Sign in as an admin.

For the **HTTP with Microsoft Entra ID** connection, set both *Base Resource URL* and
*Microsoft Entra ID resource URI* to `https://api.powerplatform.com`.

> The two **Copilot Studio** flows sign in as the flow owner, who must be a Global, Power Platform
> or Billing Administrator. If they return `403`, check the owner first.

### 3. Fill in and run

In each **daily** flow, set `TenantId`, `ClientId` and `DataverseUrl` in the `Initialise_` actions.
The client secret comes from Key Vault (`consumption-central-client-secret`); see
[PERMISSIONS.md](PERMISSIONS.md).

Run each **Backfill** flow once, one at a time; each loads 180 days and takes 10–30 minutes. Then
turn on the four daily flows.

### 4. Open the template

Open **`Consumption Central - Power Automate + Dataverse.pbit`** and fill in:

| Parameter | Value |
|---|---|
| `DataverseServer` | `your-org.crm.dynamics.com,5558` |
| `DataverseDatabase` | `your-org` |
| `DataversePrefix` | `cc_` |

Publish and schedule the refresh. If sign-in fails, turn on the **TDS endpoint** (Power Platform
admin centre → **Settings** → **Features**).

---

## What the flows don't fill

Flows fill `studio_tenant_daily`, `studio_agent`, `azure_ai_spend` and `github_ai_usage`. The other
eight tables the script creates (Cowork credits, Studio per-user, GitHub seat map, spending policies
and four Azure detail tables) have no API. Import them by hand with **Data → Import** in
[make.powerapps.com](https://make.powerapps.com); the files in the
[Local CSV sample data](../../4.%20Local%20CSV/Add%20Credit%20Consumption/sample-data/) show the
columns.

**Cowork / Work IQ** goes into `viva_credits_weekly`: import `PersonServiceCreditsMetrics.csv` from
the [Viva Insights export ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/DATA-SOURCES.md#files-and-columns)
and map `Session count`, `Spending policy limit`, `Total Copilot Credits used` and `User limit` by
hand. An import adds rows rather than replacing them, so delete the old rows before loading a newer
export. Org columns aren't carried on this path; for Cowork by org, add the
[Viva Direct report](../../3.%20SharePoint/Add%20Credit%20Consumption/) alongside.

---

## 📚 Reference

- [How to read the report ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/INTERPRETING.md)
- [Where each export comes from ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/DATA-SOURCES.md)
- [Flow sources and build scripts ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/tree/main/2.%20Power%20Automate%20%2B%20Dataverse)

Copied from [microsoft/ConsumptionCentral-for-Microsoft-Copilot ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot)
(MIT) at commit `24b0ca8`, plus the [Dataverse Cowork table ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/pull/39). Full documentation and
issues live there.
