# Dataverse deployment

Run the AI Business Value Dashboard **straight off Dataverse** + a couple of CSV file paths —
no Fabric capacity, no Lakehouse, no notebooks, no Spark. The Copilot Studio conversation transcripts
are parsed **inside the Power BI model (Power Query M)**, so there's nothing else to stand up.

```
Dataverse conversationtranscripts ─(native connector)─┐
                                                       ▼
                       Power Query M parser (in the model)
                                                       ▼
   Agent Sessions · Turns · Errors · Sub-Agent Calls · Performance · Catalogue
                                                       ▼
   + org / Agents 365 ─(direct CSV file paths)────────────────► dashboard
```

> **Just want to run it?** Open **[`AI Business Value Dashboard - Dataverse.pbit`](./AI%20Business%20Value%20Dashboard%20-%20Dataverse.pbit)**
> in Power BI Desktop, set the three parameters below, and **Load**.

---

## Connect the template

The `.pbit` is **pre-set to Dataverse** — you only set three parameters:

| Parameter | Required? | Value |
|---|---|---|
| **Dataverse Url** | **Yes** | your environment URL, e.g. `https://yourorg.crm.dynamics.com` |
| **Org Data CSV** | **Yes** | full file path (SharePoint URL or local/synced/UNC) to `copilot_org_data.csv` |
| **Agent 365 CSV** | optional | full file path to `agents_365.csv` — **leave blank to skip** |

On first refresh you'll get a one-time **Dataverse** sign-in: choose **Organizational account**, sign
in with an org login that can **read the Conversation Transcript table**, and set the source privacy
level to **Organizational** if prompted. Then enable **Scheduled refresh** in the Service as usual.

> **No app registration / client secret** — the report uses the native Dataverse connector with the
> refresher's own org login.

---

<details>
<summary><strong>What you need</strong> — environment, permissions & CSVs</summary>

**In your tenant**
- The **Dataverse environment URL** holding the Copilot Studio transcripts (Power Platform Admin
  Center → Environments → *your env* → **Environment URL**).
- A refresher sign-in with **Read** on the **Conversation Transcript** table — e.g. *System
  Administrator*, *System Customizer*, *Environment Maker*, or a least-privilege custom role.

**Supporting CSVs** (each pointed to by its own full-path parameter):

| File | Source export | Parameter | Required? |
|---|---|---|---|
| `copilot_org_data.csv` | Entra → Users (manual export) **or** a Graph `/users` → SharePoint landing flow | **Org Data CSV** | **Yes** (org filter on every page) |
| `agents_365.csv` | M365 Admin → Agents → **Export** | **Agent 365 CSV** | optional |

Org data is read from the **raw portal export** — the model normalises headers and US-format dates
for you. Leave the Agents 365 path blank and that table loads empty (visuals degrade gracefully).

> **Org data stays a CSV (not Dataverse)** so you keep both acquisition methods — a manual Entra
> export, or an Entra-Graph → SharePoint landing flow.
</details>

<details>
<summary><strong>How the file paths work</strong> — connectors & gateway</summary>

Each CSV parameter takes a **full file path**, auto-detected:

| You enter | Connector | Refresh in the Service |
|---|---|---|
| A **SharePoint file URL** (`https://contoso.sharepoint.com/.../copilot_org_data.csv`) | `Web.Contents` | ✅ cloud-to-cloud, **no gateway** (source = *Organizational account* / OAuth2) |
| A **local / synced file** (`C:\AIBV\copilot_org_data.csv`) | `File.Contents` | needs an **on-premises data gateway** |
| A **UNC path** (`\\server\share\copilot_org_data.csv`) | `File.Contents` | needs a gateway |

> A **SharePoint file URL is easiest to schedule-refresh** — no gateway. Pointing at the exact file
> (not a folder) means the report won't silently miss a renamed export.
</details>

<details>
<summary><strong>How the transcript parser works</strong></summary>

The model carries Power Query functions (see
[`model_expressions_reference.tmdl`](./model_expressions_reference.tmdl)) that parse the raw
`conversationtranscripts` JSON into fact tables — entirely in the model, no external compute:

| M function | Produces |
|---|---|
| `RawTranscripts()` | one row per transcript (live from Dataverse) |
| `ParsedBase()` | parses each `content` JSON once into an `activities` list |
| `Parse_Sessions()` | `Agent Sessions` (one row per conversation) |
| `Parse_Turns()` | `Agent Turns` (per message, with intent / knowledge / feedback) |
| `Parse_Errors()` | `Agent Errors` |
| `Parse_SubAgents()` | `Agent Sub-Agent Calls` |
| `Parse_Performance()` | `Agent Performance` (per-conversation KPI fact) |

`Agent Catalogue` self-derives from the parsed sessions + sub-agents.

**Notes / limitations**
- **Topics** are classified by generic, customer-agnostic DAX — no extra services or LLM enrichment.
- **Agent name** resolves via the Dataverse bot lookup where exposed, else from transcript content.
- Token / plugin telemetry columns are null in this path (not in the transcript JSON); the value
  model doesn't depend on them.
- Conversation transcripts default to ~30-day retention in Dataverse — the dashboard sees only what
  the environment currently holds.
</details>

<details>
<summary><strong>Verifying the connection</strong></summary>

A built-in **`Dataverse Diagnostic`** table returns the live row count of `conversationtranscripts`
and `systemusers`. If `conversationtranscripts = 0` but `systemusers > 0`, the connection is fine —
the environment simply has no Copilot Studio transcripts in scope yet.
</details>

---

> **Credit / Cost consumption is not part of this template.** This Dataverse build is deliberately
> scoped to **Copilot Studio** analytics (transcripts + org + optional Agents 365). For the billing /
> credit-consumption pages, use the **Fabric** or **SharePoint** template.

## How this relates to the other templates

| Template | Best for | Needs |
|---|---|---|
| [`1. Fabric`](../1.%20Fabric) | large tenants, scheduled Spark ingestion | Fabric capacity + Lakehouse |
| [`2. SharePoint`](../2.%20SharePoint) | flat-file / Power Automate landing | a SharePoint library |
| **`3. Dataverse`** *(this one)* | **simplest footprint** | a Dataverse env + a CSV folder |
