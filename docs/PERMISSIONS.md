# Roles & permissions — one-page reference

Everything you need to grant to stand up ValueLens, least-privilege. The **core source grants
are the same on every path**. Paths 1 and 2 (Fabric and Azure) are Analytics Hub, which has
[its own reference](https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/docs/PERMISSIONS.md) for the rest. Three kinds of permission are involved:

- **App permission / role** — what an automated (unattended) pull needs.
- **Export role** — the admin-portal role a person needs to download the data by hand.

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
| **Copilot Studio credits** | ✅ Power Platform licensing API (installer flow, the default) | The flow's Power Platform API connection (**HTTP with Microsoft Entra ID**, resource `https://api.powerplatform.com`) signs in as a **Power Platform Administrator**, **Billing Administrator** or **Global Administrator**. Per-user figures come from an undocumented route, best effort. | Power Platform Administrator, for the optional PPAC Licensing exports |
| **Cowork credits** | ✅ Viva Insights query via Dataflow Gen2 | The person who signs in to the Dataflow needs the Viva Insights **Insights Analyst** role, and the query on Auto-refresh. | Insights Analyst, for the Consumption Dashboard export |
| **Agents 365** | ✅ Graph | `CopilotPackages.Read.All` + `Application.Read.All` (+ `User.Read.All` to resolve creators and, on Fabric, check whether each owner's account is still active), admin-consented, **and an Agent 365 licence** in the tenant (else `403`). Used by `Copilot_Agent365_Registry_Ingester` (Fabric) and `Get-Agents365Registry.ps1` (every other path). | Global Administrator or Reports Reader (with **AI Admin** in a Frontier-enrolled tenant), for the CSV fallback via the admin centre |

| **Defender** (shadow AI and agent risk) | ? Graph | `ThreatHunting.Read.All` for advanced hunting (`POST /security/runHuntingQuery`: devices, installed software and AI agents), and `CloudApp-Discovery.Read.All` for Cloud Discovery, admin-consented. **Licences:** Defender for Endpoint P2 (or Microsoft Defender XDR) for the device and agent probes, Defender for Cloud Apps for Cloud Discovery. A probe without its permission or licence is skipped and logged in `defender_status`; the rest of the load carries on. Used by `Copilot_Defender_Ingester` (Fabric) and the `defender` module of the Azure jobs. | None: there is no export |

For the **export-only** source, the only "permission" to automate landing is the automation's **OneLake write**
right (next section) — the data itself must be exported by an admin (or a scheduled portal export) first.

### Azure Resource Graph

Optional: agent configuration (sign-in, quarantine, connectors, web search, sharing) and Foundry accounts and
projects. Used by `Copilot_Resource_Graph_Ingester` (Fabric, as the app registration) and the Azure jobs
(module `resourceGraph`, as the managed identity). Each part is best effort: a refused probe is recorded in
`arg_status`, and the dashboard shows why that part is empty.

| Part | Needs | Notes |
|---|---|---|
| Foundry accounts and projects (`resources`) | Azure **Reader** at a management group, or the tenant root group to see every subscription | Resource Graph returns only what the identity can read. The installer assigns it when the person installing can assign roles there, or prints the `az role assignment create` command |
| Copilot Studio agents, environments and agent flows (`PowerPlatformResources`) | An Entra role that can read the Power Platform inventory: **Global Reader**, **Power Platform Administrator** or **AI Administrator** | A directory role, so the installer only prints the step. Microsoft doesn't document app-only access to this table, so it may be refused or come back empty |
| Fallback: the **Analytics Hub - Agent inventory** flow | The flow's Power Platform API connection (**HTTP with Microsoft Entra ID**, resource `https://api.powerplatform.com`) signed in as one of the roles above. Same flow licence and environment roles as the Copilot Studio credits flow | The Power Platform inventory API takes delegated sign-ins only. The flow writes the inventory as JSON to `arg_inventory/` in the drop folder each day, and the notebook or job reads the newest file when Resource Graph doesn't return agents |

No per-project agent sweep: Foundry is read at account and project level only.

> **Add-ons.** [Agent Evaluator](https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/fabric/Add%20Agent%20Evaluator/README.md) needs the app
> registration as a Dataverse **application user**.
> [Credit consumption](https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/fabric/Add%20Credit%20Consumption/README.md) lists its own roles.

---

## Fabric and Azure (paths 1 and 2)

Paths 1 and 2 are Analytics Hub, which moved to
[microsoft/AnalyticsHub-Dashboard](https://github.com/microsoft/AnalyticsHub-Dashboard). Its
[permissions reference](https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/docs/PERMISSIONS.md) covers the Fabric workspace and capacity, credit
consumption on Azure and who can view the app. The core and optional source grants above are the same.

---

## Quick "who do I ask?" summary

- **Just the core dashboard:** one Entra app reg (3 Graph perms, admin-consented), or the export roles to download the core files by hand.
- **+ Feedback:** an admin exports the feedback CSV and lands it where your path reads it. No extra API permission.
- **+ Agents 365:** add `CopilotPackages.Read.All` + `Application.Read.All` (+ `User.Read.All`) to the same app reg, and confirm the tenant has an Agent 365 licence.

See the path README you're following for the step-by-step —
[1](https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/fabric/README.md) · [2](https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/azure/README.md) ·
[3](../3.%20Power%20Automate%20+%20Dataverse/README.md) · [4](../4.%20SharePoint/README.md) ·
[5](../5.%20Local%20CSV/README.md).
