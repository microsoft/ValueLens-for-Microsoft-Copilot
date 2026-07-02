# + Studio Agent Deepdive (optional add-on)

An **optional extension** of the base Fabric dashboard for tenants running **Copilot Studio agents**.
The base [`../AI Business Value Dashboard - Fabric.pbit`](../AI%20Business%20Value%20Dashboard%20-%20Fabric.pbit)
is the recommended starting point for everyone; add this layer only when you want a deeper view of
**agent transcripts** and the **Agent 365 registry**.

Everything Copilot-Studio-specific lives here so the base path stays clean.

## What's here

| Item | Purpose |
|---|---|
| `AI Business Value Dashboard - Fabric (+ Studio Agent Deepdive).pbit` | The base dashboard **plus** the Copilot Studio agent pages (transcript analysis, agent registry detail). |
| `notebooks/Copilot_Agent_Transcript_Parser.ipynb` | Parses **Copilot Studio agent transcripts** (Dataverse `ConversationTranscript`) into a Lakehouse Delta table for the agent pages. |
| `notebooks/Copilot_Agent365_Registry_Ingester_PREVIEW.ipynb` | Earlier **delegated/interactive PREVIEW** of the Agent 365 registry ingester. For scheduled, app-only runs prefer the GA notebook in the base path: [`../notebooks/Copilot_Agent365_Registry_Ingester.ipynb`](../notebooks/Copilot_Agent365_Registry_Ingester.ipynb). |

## When to use it

Use the **base** template if you only need Microsoft 365 Copilot value (audit logs, licensing, org
data, feedback, Agent 365 export). Add this deepdive when your tenant also runs **Copilot Studio
agents** and you want:

- agent-level transcript analysis (topics, resolution, containment), and
- the richer Agent 365 capability/permission detail.

## Setup

1. Stand up the base path first — follow [`../README.md`](../README.md) (Lakehouse, Entra app, core
   notebooks, connect the base template).
2. Run `notebooks/Copilot_Agent_Transcript_Parser.ipynb` to land the agent transcript table. It needs
   Dataverse read on `ConversationTranscript` — see the **Copilot Studio agent transcripts** export
   steps in [`../README.md`](../README.md).
3. Optionally run the Agent 365 registry ingester (prefer the GA notebook in the base path).
4. Open **`AI Business Value Dashboard - Fabric (+ Studio Agent Deepdive).pbit`** in Power BI Desktop,
   supply the same Lakehouse parameters as the base template, and set `Enable_Dataverse = Include` to
   light up the agent pages.

> This add-on is a superset of the base template — it reads the same core tables plus the agent
> tables, so it works only once the base path is producing data.
