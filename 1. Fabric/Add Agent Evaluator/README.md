# ➕ Add Agent Evaluator — Fabric

**Optional.** A separate Power BI report, **Agent Evaluator**, covering how your Copilot Studio
agents perform: sessions, outcomes, topics, knowledge, errors and user feedback. It reads the
conversation transcripts Copilot Studio keeps in Dataverse. ValueLens shows Copilot adoption and
value; this shows how well your agents work. Skip it and nothing in ValueLens changes.

It uses the **same Lakehouse as ValueLens**. Its `agent_*` tables don't overlap with anything
ValueLens reads or writes, and it reuses ValueLens' `copilot_org_data` table for department views.

> **Using the [Fabric installer](../installer/#agent-evaluator)?** Choose *Agent Evaluator*, pick
> your environments, and it sets up access, the notebook, the pipeline step, the semantic model and
> the app's Agent Evaluation pages for you.

### What's here

| Item | Purpose |
|---|---|
| `Agent Evaluator.pbit` | The report, reading the Lakehouse SQL analytics endpoint. |
| [`notebooks/Copilot_Agent_Transcript_Parser.ipynb`](notebooks/) | Pulls transcripts from one or more Dataverse environments and writes the `agent_*` tables. |

### Why Fabric

Dataverse keeps conversation transcripts for about **30 days**. With `WRITE_MODE = 'merge'` each
run adds to the Lakehouse tables, so history builds up past that window, across every environment
you list.

---

## 🛠 Setup

### 1. Give the app registration access

Use the same app registration as ValueLens. In **each** environment you want to read:

1. [Power Platform admin centre](https://admin.powerplatform.microsoft.com) → **Manage** →
   **Environments** → your environment → **Settings** → **Users + permissions** →
   **Application users** → **New app user**.
2. Add the app registration, choose the root business unit, and give it the
   **Bot Transcript Viewer** security role.

The UPN lookup (below) uses Microsoft Graph **User.Read.All** (application), which ValueLens'
org data notebook already needs.

### 2. Import the notebook

Import `Copilot_Agent_Transcript_Parser.ipynb`, attach your Lakehouse, and set the config cell:

| Setting | Value |
|---|---|
| `DATAVERSE_URLS` | Your environment URLs, e.g. `['https://contoso.crm.dynamics.com']` |
| `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` | The app registration. Read the secret from Key Vault with `notebookutils.credentials.getSecret`. |
| `WRITE_MODE` | `'merge'` for scheduled runs, so each run adds to history |
| `RAW_TABLE` | `''`. The report doesn't use the raw table. |
| `LOOKBACK_DAYS` | `7` for a weekly schedule. Use `30` on the first run to load what Dataverse still holds. |

### 3. Open the template

Lakehouse → **Settings** → **SQL analytics endpoint** → copy the connection string. Open
**`Agent Evaluator.pbit`** and fill in:

| Parameter | Value |
|---|---|
| `Source Mode` | `Fabric` |
| `Fabric SQL Endpoint` | The connection string you copied |
| `Lakehouse Name` | Your Lakehouse name |

The report needs ValueLens' `copilot_org_data` table, so run the org data notebook first.

### 4. Publish and schedule

Publish to your workspace. Schedule the notebook, then the report's refresh **after** it succeeds.

---

## What ValueLens changed

The notebook is the upstream parser with three additions. Everything else is unchanged.

- **UPN lookup** (new cell *8c*). Transcripts often name the user only by their Entra object ID,
  and ValueLens' org data is keyed on UPN. The cell looks each ID up in Microsoft Graph and fills
  `user_upn`, so department breakdowns work. If the lookup fails, the run carries on with the IDs
  it has. Set `RESOLVE_UPNS = False` to turn it off.
- **`RESOLVE_UPNS`** setting in the config cell.
- **Fabric kernel** (`synapse_pyspark`) in the notebook metadata, so it opens as PySpark.

The template is unchanged. Its **Credit Consumption** page reads the upstream credit ingester's
tables, which aren't included here, so it stays empty. For Copilot Studio credits, use
[Add Credit Consumption](../Add%20Credit%20Consumption/).

---

Copied from [microsoft/AgentEvaluator-for-Copilot-Studio ↗](https://github.com/microsoft/AgentEvaluator-for-Copilot-Studio)
(MIT) at commit `e37b1ac`. Full documentation and issues live there.
