# Roles & permissions — one-page reference

Everything you need to grant to stand up ValueLens, least-privilege. The **core source grants
are the same on every path** — only the last section (Fabric workspace & capacity) is
Fabric-specific. Three kinds of permission are involved:

- **App permission / role** — what an automated (unattended) pull needs.
- **Export role** — the admin-portal role a person needs to download the data by hand.
- **Fabric workspace role** — needed to run the notebooks/pipeline and write to the Lakehouse.

> Optional sources are opt-in. Skip any you don't use — the dashboard still works (those pages load empty).

---

## Core sources (required)

Pulled automatically by the 3 core notebooks via one **Entra app registration** with these
**Microsoft Graph application** permissions (admin consent required):

| Source | Graph application permission | Manual-export role (if pulling by hand) |
|---|---|---|
| Audit logs (`copilot_interactions_parsed`) | `AuditLogsQuery.Read.All` | Audit Reader or Compliance Administrator |
| Licensed users (`copilot_licensed_users`) | `Reports.Read.All` | Global Reader or Reports Reader |
| Org data (`copilot_org_data`) | `User.Read.All` | Global Reader or User Administrator |

One app registration covers all three. Put the client secret in **Azure Key Vault**, not in a notebook.

The optional **Microsoft 365 activity** notebook (Fabric path, `m365_activity_daily`) reads the
Microsoft 365 usage reports with the same `Reports.Read.All`, so it needs no extra permission.
Its activity only matches people if **Display concealed user, group, and site names in all
reports** is off (Microsoft 365 admin center → Settings → Org settings → Reports).

---

## Optional sources (opt-in)

| Source | API? | Automated-pull permission | Manual-export role |
|---|---|---|---|
| **Cost consumption** (M365 Admin Center → Copilot → Cost management) | ❌ export-only | Not read by the current templates (the Credit Meter page was retired). The Fabric ingester is archived in [`1. Fabric/archive/notebooks/`](../1.%20Fabric/archive/notebooks/). | Global Administrator or Billing Administrator |
| **Product feedback** (OCV / M365 Health) | ❌ export-only | None — there is no API. Landed by the Power Automate flow, then ingested. | Global Administrator or Reports Reader |
| **Agents 365** | ✅ Graph | `CopilotPackages.Read.All` + `Application.Read.All` (+ `User.Read.All` to resolve creators), admin-consented, **and an Agent 365 licence** in the tenant (else `403`). Used by `Copilot_Agent365_Registry_Ingester` (Fabric) and `Get-Agents365Registry.ps1` (every other path). | Global Administrator or Reports Reader (with **AI Admin** in a Frontier-enrolled tenant), for the CSV fallback via the admin centre |

For the two **export-only** sources, the only "permission" to automate landing is the automation's **OneLake write**
right (next section) — the data itself must be exported by an admin (or a scheduled portal export) first.

The four `COST-CONSUMPTION` guides and cost flow JSON in [archive/flows](../1.%20Fabric/archive/flows/) are
**archived reference**, not recommended active deployment instructions. The cost ingester remains,
but no current template reads its table.

> **Studio add-ons.** Copilot Studio agent-transcript (Dataverse) analytics and PPAC per-agent /
> per-user message-credit consumption need extra grants (a Dataverse **Application User** with read on
> the **Conversation Transcript** table; Power Platform admin export). Those are covered in the archived
> [Fabric + Copilot Studio](../1.%20Fabric/archive/extended/Fabric%20+%20Copilot%20Studio/) build,
> kept as reference rather than a recommended active deployment.

---

## Fabric workspace & capacity (path 1 only)

| What | Role / requirement |
|---|---|
| Run the notebooks / pipeline, write Delta to the Lakehouse | **Contributor** or **Member** on the Fabric workspace |
| Land export-only files via the Power Automate flows | The flow's identity (app reg or workspace identity) as **Member/Contributor** on the workspace; tenant setting **“Service principals can use Fabric APIs”** enabled |
| Capacity | Workspace on a Fabric capacity (**F2+** or trial) |
| Connect the Power BI template | Read on the Lakehouse **SQL endpoint** (the template signs in to it once) |

---

## Quick "who do I ask?" summary

- **Just the core dashboard:** one Entra app reg (3 Graph perms, admin-consented) + Contributor on the workspace.
- **+ Cost / Feedback:** an admin exports the feedback CSV (or schedules a portal export) and lands it via its flow — no extra API permission. Cost consumption is no longer read by the templates.
- **+ Agents 365:** add `CopilotPackages.Read.All` + `Application.Read.All` (+ `User.Read.All`) to the same app reg, and confirm the tenant has an Agent 365 licence.

See the path README you're following for the step-by-step —
[1](../1.%20Fabric/README.md) · [2](../2.%20Power%20Automate%20+%20Dataverse/README.md) ·
[3](../3.%20SharePoint/README.md) · [4](../4.%20Local%20CSV/README.md) — and
[`OPTIONAL-SOURCES.md`](../1.%20Fabric/docs/OPTIONAL-SOURCES.md)
for how absent sources stay green on the Fabric path.
