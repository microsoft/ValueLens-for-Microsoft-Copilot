# Roles & permissions — one-page reference

Everything you need to grant to stand up the Fabric dashboard, least-privilege.
Three kinds of permission are involved:

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

---

## Optional sources (opt-in)

| Source | API? | Automated-pull permission | Manual-export role |
|---|---|---|---|
| **Agent transcripts** (Dataverse) | ✅ Dataverse Web API | App reg added as an **Application User** in the Dataverse environment, with a security role granting **Read** on the **Conversation Transcript** table (System Customizer, or a custom read-only role). Auth is client-credentials to `{env}/.default` — **no Graph permission needed**. | System Administrator / System Customizer / Environment Maker |
| **Credit consumption** (Power Platform) | ❌ export-only | None — there is no API. The CSVs are landed by the Power Automate flow (see below), then the ingester notebook reads them. | Global Administrator or Billing Administrator |
| **Product feedback** (M365 Health) | ❌ export-only | None — there is no API. Landed by the Power Automate flow, then ingested. | Global Administrator or Reports Reader |
| **Agents 365** | export/lander | Lander notebook reads an exported registry CSV. | Global Administrator or Reports Reader (with **AI Admin** in a Frontier-enrolled tenant) |

For the two **export-only** sources, the only "permission" to automate is the flow's **OneLake write**
right (next section) — the data itself must be exported by an admin (or a scheduled portal export) first.

---

## Fabric workspace & capacity (to run anything)

| What | Role / requirement |
|---|---|
| Run the notebooks / pipeline, write Delta to the Lakehouse | **Contributor** or **Member** on the Fabric workspace |
| Land export-only files via the Power Automate flows | The flow's identity (app reg or workspace identity) as **Member/Contributor** on the workspace; tenant setting **“Service principals can use Fabric APIs”** enabled |
| Capacity | Workspace on a Fabric capacity (**F2+** or trial) |
| Connect the Power BI template | Read on the Lakehouse **SQL endpoint** (the template signs in to it once) |

---

## Quick "who do I ask?" summary

- **Just the core dashboard:** one Entra app reg (3 Graph perms, admin-consented) + Contributor on the workspace.
- **+ Agent transcripts:** also add that app reg as a Dataverse **Application User** with read on Conversation Transcript.
- **+ Credit / Feedback:** an admin exports the CSVs (or schedules a portal export); the flow lands them — no extra API permission.
- **+ Agents 365:** an admin with Reports Reader (+ AI Admin) exports the registry.

See [`README.md`](../README.md) for the step-by-step, and [`OPTIONAL-SOURCES.md`](OPTIONAL-SOURCES.md)
for how absent sources stay green.
