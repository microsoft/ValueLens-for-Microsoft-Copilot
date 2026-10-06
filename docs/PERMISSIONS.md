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
reports** is off (Microsoft 365 admin center → Settings → Org settings → Services → Reports).

---

## Optional sources (opt-in)

| Source | API? | Automated-pull permission | Manual-export role |
|---|---|---|---|
| **Product feedback** (OCV / M365 Health) | ❌ export-only | None — there is no API. Landed by the Power Automate flow, then ingested. | Global Administrator or Reports Reader |
| **Copilot Studio credits** | ✅ Power Platform licensing API (optional installer flow) | The flow's **HTTP with Microsoft Entra ID** connection signs in as a **Power Platform Administrator**, **Billing Administrator** or **Global Administrator** (audience `https://api.powerplatform.com`). Per-user figures are export-only. | Power Platform Administrator, for the PPAC Licensing exports |
| **Cowork credits** | ✅ Viva Insights query via Dataflow Gen2 | The person who signs in to the Dataflow needs the Viva Insights **Insights Analyst** role, and the query on Auto-refresh. | Insights Analyst, for the Consumption Dashboard export |
| **Agents 365** | ✅ Graph | `CopilotPackages.Read.All` + `Application.Read.All` (+ `User.Read.All` to resolve creators), admin-consented, **and an Agent 365 licence** in the tenant (else `403`). Used by `Copilot_Agent365_Registry_Ingester` (Fabric) and `Get-Agents365Registry.ps1` (every other path). | Global Administrator or Reports Reader (with **AI Admin** in a Frontier-enrolled tenant), for the CSV fallback via the admin centre |

For the **export-only** source, the only "permission" to automate landing is the automation's **OneLake write**
right (next section) — the data itself must be exported by an admin (or a scheduled portal export) first.

> **Add-ons.** [Agent Evaluator](../1.%20Fabric/Manual%20setup/Add%20Agent%20Evaluator/README.md) needs the app
> registration as a Dataverse **application user**.
> [Credit consumption](../1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/README.md) lists its own roles.

---

## Fabric workspace & capacity (path 1 only)

| What | Role / requirement |
|---|---|
| Run the notebooks / pipeline, write Delta to the Lakehouse | **Contributor** or **Member** on the Fabric workspace |
| Let the pipeline's notebooks share one Spark session (the installer turns this on) | **Admin** on the Fabric workspace, to change the workspace Spark setting *High concurrency for pipeline running multiple notebooks*. Without it the installer warns and carries on, and each notebook starts its own session |
| Record each run's load status in `dbo.load_log` | Nothing extra. The `AnalyticsHub_Load_Status` notebook reads the run it belongs to through the Fabric API, as the person the pipeline runs as (**Contributor** or **Member**) |
| Land export-only files via the Power Automate flows | The flow's identity (app reg or workspace identity) as **Member/Contributor** on the workspace; tenant setting **“Service principals can use Fabric APIs”** enabled |
| Installer-created flows (product feedback, Copilot Studio credits) | The installing person: **Environment Maker** (or System Administrator) in the chosen Power Platform environment. The flow owner: a **Power Automate Premium** licence (HTTP with Microsoft Entra ID is premium). The app registration gets **Contributor** on the workspace from the installer, and the flow reads its secret through an **Azure Key Vault** connection, so the person who signs in to it needs **Key Vault Secrets User** on the vault |
| Installer-created Cowork credits Dataflow | The installing person as **Contributor** or **Member** on the workspace. Whoever signs in to the Dataflow needs Viva Insights **Insights Analyst** |
| Upload exports with the installer, Fabric or OneLake File Explorer (to `Files/analytics_hub_uploads`) | The signed-in person as **Contributor** or **Member** on the workspace. No extra API permission. |
| Optional SharePoint/OneDrive folder shortcut into the drop folder | Fabric tenant setting for **OneDrive and SharePoint shortcuts** enabled, and read access to the folder for whoever creates the shortcut. Without it, use the Lakehouse folder. |
| Capacity | Workspace on a Fabric capacity (**F2+** or trial) |
| Connect the Power BI template | Read on the Lakehouse **SQL endpoint** (the template signs in to it once) |

---

## Quick "who do I ask?" summary

- **Just the core dashboard:** one Entra app reg (3 Graph perms, admin-consented) + Contributor on the workspace.
- **+ Feedback:** an admin exports the feedback CSV and lands it, by hand or with the flow. No extra API permission. With the installer, choose **Upload CSV** on its Data sources card, or drop it in `Files/analytics_hub_uploads`.
- **+ Agents 365:** add `CopilotPackages.Read.All` + `Application.Read.All` (+ `User.Read.All`) to the same app reg, and confirm the tenant has an Agent 365 licence.

See the path README you're following for the step-by-step —
[1](../1.%20Fabric/README.md) · [2](../2.%20Power%20Automate%20+%20Dataverse/README.md) ·
[3](../3.%20SharePoint/README.md) · [4](../4.%20Local%20CSV/README.md).
