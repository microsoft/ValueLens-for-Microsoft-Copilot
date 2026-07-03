# Fabric + Copilot Studio (optional add-on)

*(Formerly "Studio Agent Deepdive".)* An **optional extension** of the standard Fabric dashboard for
tenants running **Copilot Studio agents**. The base
[`../../2. Fabric/AI Business Value Dashboard - Fabric.pbit`](../../2.%20Fabric/AI%20Business%20Value%20Dashboard%20-%20Fabric.pbit)
is the recommended starting point for everyone; add this layer only when you want a deeper view of
**agent transcripts** and the **Agent 365 registry**.

Everything Copilot-Studio-specific lives here so the base path stays clean.

## What's here

| Item | Purpose |
|---|---|
| `AI Business Value Dashboard - Fabric (+ Studio Agent Deepdive).pbit` | The base dashboard **plus** the Copilot Studio agent pages (transcript analysis, agent registry detail). |
| `notebooks/Copilot_Agent_Transcript_Parser.ipynb` | Parses **Copilot Studio agent transcripts** (Dataverse `ConversationTranscript`) into a Lakehouse Delta table for the agent pages. |
| `notebooks/Copilot_Agent365_Registry_Ingester_PREVIEW.ipynb` | Earlier **delegated/interactive PREVIEW** of the Agent 365 registry ingester. For scheduled, app-only runs prefer the GA notebook in the base path: [`../../2. Fabric/notebooks/Copilot_Agent365_Registry_Ingester.ipynb`](../../2.%20Fabric/notebooks/Copilot_Agent365_Registry_Ingester.ipynb). |
| `notebooks/Copilot_Credit_Consumption_Ingester.ipynb` | Ingests the **Power Platform Admin Center (PPAC) per-agent Copilot Studio message credit** export into the `credit_consumption_*` Lakehouse tables (gated by `Enable_Consumption`). |
| `flows/` | Power Automate flows that auto-land the PPAC credit export into OneLake (email or SharePoint trigger). See [`flows/README.md`](flows/README.md). |
| `CREDIT-CONSUMPTION-SETUP.md` | Step-by-step guide for the PPAC credit export, the landing flows and the ingester. |

## When to use it

Use the **base** template if you only need Microsoft 365 Copilot value (audit logs, licensing, org
data, feedback, Agent 365 export). Add this deepdive when your tenant also runs **Copilot Studio
agents** and you want:

- agent-level transcript analysis (topics, resolution, containment),
- the richer Agent 365 capability/permission detail, and
- per-agent **Copilot Studio message credit** consumption (PPAC billing).

## Setup

1. Stand up the base path first — follow [`../../2. Fabric/README.md`](../../2.%20Fabric/README.md) (Lakehouse, Entra app, core
   notebooks, connect the base template).
2. Run `notebooks/Copilot_Agent_Transcript_Parser.ipynb` to land the agent transcript table. It needs
   Dataverse read on `ConversationTranscript` — see the **Copilot Studio agent transcripts** export
   steps in [`../../2. Fabric/README.md`](../../2.%20Fabric/README.md).
3. Optionally run the Agent 365 registry ingester (prefer the GA notebook in the base path).
4. Optionally light up **agent credit consumption** — follow
   [`CREDIT-CONSUMPTION-SETUP.md`](CREDIT-CONSUMPTION-SETUP.md) to land the Power Platform Admin Center
   export (via the [`flows/`](flows/README.md) or manually) and run
   `notebooks/Copilot_Credit_Consumption_Ingester.ipynb`, then set `Enable_Consumption = Include`.
5. Open **`AI Business Value Dashboard - Fabric (+ Studio Agent Deepdive).pbit`** in Power BI Desktop,
   supply the same Lakehouse parameters as the base template, and set `Enable_Dataverse = Include` to
   light up the agent pages.

> **Transitional note:** the base *No Studio* template still ships the **Credits Consumed** page and the
> `Enable_Consumption` parameter for now — leave it `Exclude` there. The PPAC notebook, flows and setup
> guide have moved here; the base page will be retired in a later cleanup.

> This add-on is a superset of the base template — it reads the same core tables plus the agent
> tables, so it works only once the base path is producing data.
