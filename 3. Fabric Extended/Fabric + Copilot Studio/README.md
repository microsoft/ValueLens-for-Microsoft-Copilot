# Fabric + Copilot Studio (optional add-on)

*(Formerly "Studio Agent Deepdive".)* An **optional extension** of the standard Fabric dashboard for
tenants running **Copilot Studio agents**. The base
[`../../2. Fabric/ValueLens - Fabric.pbit`](../../2.%20Fabric/ValueLens%20-%20Fabric.pbit)
is the recommended starting point for everyone; add this layer only when you want a deeper view of
**agent transcripts** and the **Agent 365 registry**.

**This folder is self-contained.** Everything you need to stand up the deepdive — including the core
ingesters — lives here. No cross-folder downloads.

## What's here

```
Fabric + Copilot Studio/
├── ValueLens - Fabric (+ Studio Agent Deepdive).pbit   ← the report
├── notebooks/
│   ├── _core/                                          ← core ingesters (mirrored from 2. Fabric — do not edit here)
│   │   ├── Copilot_Audit_Log_Direct_Ingester.ipynb
│   │   ├── Copilot_Licensed_Users_Direct_Ingester.ipynb
│   │   ├── Copilot_Org_Data_Direct_Ingester.ipynb
│   │   ├── Copilot_ProductFeedback_Ingester.ipynb
│   │   ├── Copilot_Cost_Consumption_Ingester.ipynb
│   │   ├── Copilot_Agent365_Registry_Ingester.ipynb
│   │   └── Copilot_Agent365_Lander.ipynb
│   ├── Copilot_Agent_Transcript_Parser.ipynb           ← Copilot Studio-specific
│   └── Copilot_Credit_Consumption_Ingester.ipynb       ← Copilot Studio-specific (PPAC billing)
├── flows/                                              ← Power Automate flows for PPAC credit landing
└── CREDIT-CONSUMPTION-SETUP.md
```

| Notebook | Purpose |
|---|---|
| **`_core/*`** | Standard M365 Copilot ingesters. Byte-identical to those in `2. Fabric/notebooks/` (kept in sync by [`scripts/sync-shared.ps1`](../../scripts/sync-shared.ps1)). |
| `Copilot_Agent_Transcript_Parser.ipynb` | Parses **Copilot Studio agent transcripts** (Dataverse `ConversationTranscript`) into a Lakehouse Delta table for the agent pages. |
| `Copilot_Credit_Consumption_Ingester.ipynb` | Ingests the **Power Platform Admin Center (PPAC) per-agent Copilot Studio message credit** export into the `credit_consumption_*` Lakehouse tables (gated by `Enable_Consumption`). |
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

1. Provision your **Fabric Lakehouse** and Entra app registration — see
   [`../../2. Fabric/README.md`](../../2.%20Fabric/README.md) for the parameters, RBAC roles, and Graph
   permissions the core ingesters need. (You only need to *read* that guide; you'll run the notebooks
   from this folder.)
2. Run the notebooks in **`notebooks/_core/`** in order — audit logs → licensed users → org data →
   product feedback → cost consumption → **Agent 365 registry**. For Agent 365 use
   **`Copilot_Agent365_Registry_Ingester.ipynb`** by default (Graph API app-only). Fall back to
   `Copilot_Agent365_Lander.ipynb` (CSV drop) only if you can't grant the Ingester's app-reg
   permissions. Both target the same `dbo.agents_365` table — pick one, don't run both.
3. Run **`notebooks/Copilot_Agent_Transcript_Parser.ipynb`** to land the Copilot Studio transcript
   tables. Needs Dataverse read on `ConversationTranscript`.
4. *(Optional)* Light up **agent credit consumption** — follow
   [`CREDIT-CONSUMPTION-SETUP.md`](CREDIT-CONSUMPTION-SETUP.md) to land the PPAC export (via the
   [`flows/`](flows/README.md) or manually) and run **`notebooks/Copilot_Credit_Consumption_Ingester.ipynb`**.
5. Open **`ValueLens - Fabric (+ Studio Agent Deepdive).pbit`** in Power BI Desktop, supply the same
   Lakehouse parameters as the base template, and set `Enable_Dataverse = Include` to light up the
   agent pages. Set `Enable_Consumption = Include` if you ran step 4.

## Editing the core notebooks

The `_core/` copies are **mirrors** — do not edit them directly. Edit the source in
[`../../2. Fabric/notebooks/`](../../2.%20Fabric/notebooks/), then run:

```powershell
.\scripts\sync-shared.ps1
```

from the repo root. CI enforces zero drift on every push.

> This add-on is a superset of the base template — it reads the same core tables plus the agent
> tables, so it works only once the core ingesters are producing data.

