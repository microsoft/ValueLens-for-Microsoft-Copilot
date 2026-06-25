# AI Business Value Dashboard — Dataverse template

**A self-contained Power BI template that runs straight off Dataverse + a folder of CSV exports.
No Fabric capacity, no Lakehouse, no notebooks, no Spark.**

Point it at your Dataverse environment, give it a folder of supporting CSVs, and refresh. The
Copilot Studio conversation transcripts are parsed **inside the Power BI model in Power Query (M)**,
so the dashboard does its own crunching — there is nothing else to stand up or run.

```
Dataverse  conversationtranscripts ─(native connector, Web API)─┐
                                                                 ▼
                        Power Query M parser (in the model)
                                                                 ▼
   Agent Sessions · Agent Turns · Agent Errors · Sub-Agent Calls
   Agent Performance · Agent Catalogue · Knowledge Citations
                                                                 ▼
   + org / credit / Agents 365  ─(CSV exports in a folder)─────────► dashboard
```

> **Just want the file?** Open
> **[`AI Business Value Dashboard - Dataverse.pbit`](./AI%20Business%20Value%20Dashboard%20-%20Dataverse.pbit)**
> in Power BI Desktop and fill in the two required parameters below.

---

## What you need

**In your tenant**
- The **Dataverse environment URL** that holds the Copilot Studio transcripts
  (Power Platform Admin Center → Environments → *your env* → **Environment URL**,
  e.g. `https://yourorg.crm.dynamics.com`).
- A sign-in (the person who refreshes the report) with **Read** on the **Conversation
  Transcript** table in that environment — e.g. *System Administrator*, *System Customizer*,
  *Environment Maker*, or a custom least-privilege role. **No app registration / client secret**
  is needed — the report uses the native Dataverse connector with the refresher's own org login.

**A folder of CSV exports** (a SharePoint site, or a local / synced folder), holding the
supporting sources by these **canonical file names**:

| File name | Source export | Used by |
|---|---|---|
| `copilot_org_data.csv` | Entra → Users (manual export) **or** the Graph `/users` → SharePoint landing flow | Org filter on every page |
| `credit_consumption_agent.csv` | Power Platform Admin → Billing → `EntitlementConsumption…PerAgentDetailsReport…` | Credit Consumption |
| `credit_consumption_user.csv` | `EntitlementConsumption…PerUserDetailsReport…` | Credit Consumption |
| `credit_consumption_tenant.csv` | `EntitlementConsumption…TenantDetailsReport…` | Credit Consumption |
| `agents_365.csv` | M365 Admin → Agents → **Export** (optional) | Agents 365 page |

Org data and credit are read straight from the **raw portal exports** — the model normalises the
headers and US-format dates for you, so just drop the files in and rename them to the canonical
names above. Any file that's absent simply loads empty (its page degrades gracefully); only
`copilot_org_data.csv` is needed for the org filter.

### Where the CSV folder can live

**CSV Folder Path** auto-detects what you give it:

| You enter | Connector used | Refresh in the Service |
|---|---|---|
| A **SharePoint site URL** (`https://contoso.sharepoint.com/sites/AICopilot`) | `SharePoint.Files` — finds the canonical file names anywhere in the site | ✅ cloud-to-cloud, **no gateway** (set the source to *Organizational account* / OAuth2) |
| A **local or synced folder** (`C:\AIBV\exports`, or a synced `…\OneDrive - Contoso\exports`) | `File.Contents` | needs an **on-premises data gateway** |
| A **UNC share** (`\\server\share\exports`) | `File.Contents` | needs a gateway |

> Tip: a **SharePoint site URL is the easiest to schedule-refresh** — no gateway. Drop the five
> canonical CSVs into any document library on that site.

> **Org data — keep your existing options.** Org/people data is **not** read from Dataverse; it
> stays a CSV so you keep both acquisition methods: the **manual Entra export**, or an
> **Entra-Graph-API → SharePoint** landing flow. The dashboard just reads the resulting
> `copilot_org_data.csv`.

---

## Connect the template

Open the `.pbit` in Power BI Desktop. It is **pre-set to Dataverse** — you only set these
parameters (no Fabric, Lakehouse, or mode switches to worry about):

| Parameter | Required? | Value |
|---|---|---|
| **Dataverse Url** | **Yes** | your environment URL, e.g. `https://yourorg.crm.dynamics.com` |
| **CSV Folder Path** | **Yes** | a **SharePoint site URL** or a local/synced/UNC folder holding the CSV exports above (the **org/people** file lives here) |
| **Enable_Consumption** | optional | `Include` to load the credit-consumption CSVs / page (else `Exclude`) |
| **Enable_Agent365** | optional | `Include` to load the Agents 365 CSV / page (else `Exclude`) |

Click **Load**. On first refresh you'll get a one-time **Dataverse** sign-in: choose
**Organizational account**, sign in with the org login that can read the Conversation Transcript
table, and (if prompted) set the source privacy level to **Organizational**. The CSV folder, if
local, uses your current Windows credentials; if it's a SharePoint URL, sign in with
**Organizational account** there too. Then enable **Scheduled refresh** in the Service as usual.

---

## How the transcript parser works

The model carries a set of Power Query functions (see
[`model_expressions_reference.tmdl`](./model_expressions_reference.tmdl)) that parse the raw
`conversationtranscripts` JSON into the dashboard's fact tables — entirely in the model, with no
external compute:

| M function | Produces |
|---|---|
| `RawTranscripts()` | one row per transcript: `conversationtranscriptid, content, …` (live from Dataverse) |
| `ParsedBase()` | parses each `content` JSON once into an `activities` list |
| `Parse_Sessions()` | `Agent Sessions` (one row per conversation) |
| `Parse_Turns()` | `Agent Turns` (one row per message, with intent / knowledge / feedback) |
| `Parse_Errors()` | `Agent Errors` |
| `Parse_SubAgents()` | `Agent Sub-Agent Calls` |
| `Parse_Performance()` | `Agent Performance` (per-conversation KPI fact) |

`Agent Catalogue` self-derives from the parsed sessions + sub-agents.

**Notes / limitations**
- **Topics** are classified by the model's generic, customer-agnostic topic logic (DAX) — so topics
  work with no extra services or LLM enrichment.
- **Agent name** for single-agent transcripts is resolved via the Dataverse bot lookup when the
  environment exposes it; where it doesn't, the agent is still resolved from the transcript content.
- Token / plugin telemetry columns are null in this path (not present in the transcript JSON); the
  value model doesn't depend on them.
- Conversation transcripts default to ~30-day retention in Dataverse — the dashboard only sees what
  the environment currently holds.

---

## Verifying the connection

A built-in **`Dataverse Diagnostic`** table returns the live row count of `conversationtranscripts`
and `systemusers`, so you can confirm the connector works and whether the environment actually has
transcripts yet. If `conversationtranscripts = 0` but `systemusers > 0`, the connection is fine —
the environment simply has no Copilot Studio transcripts in scope yet.

---

## How this relates to the other templates

This is one of three deployment templates in the repo, each self-contained — pick the one that
fits your platform:

| Template | Best for | Needs |
|---|---|---|
| [`1. Fabric`](../1.%20Fabric) | large tenants, scheduled Spark ingestion | Fabric capacity + Lakehouse |
| [`2. SharePoint`](../2.%20SharePoint) | flat-file / Power Automate landing | a SharePoint library |
| **`3. Dataverse`** *(this one)* | **simplest footprint** | a Dataverse env + a CSV folder |
