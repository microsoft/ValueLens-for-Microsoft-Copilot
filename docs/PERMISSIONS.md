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
| Installer-created flows (product feedback, Copilot Studio credits) | The installing person: **Environment Maker** (or System Administrator) in the chosen Power Platform environment. The flow owner: a **Power Automate Premium** licence (HTTP with Microsoft Entra ID is premium). By default the flows write to OneLake as the person signed in to their OneLake connection (resource `https://storage.azure.com`), so that person needs **Contributor** or higher on the workspace, and the Fabric tenant setting **Users can access data stored in OneLake with apps external to Fabric** must be on. No secret or Key Vault. With `--flow-identity app`, the app registration gets **Contributor** from the installer instead, and the flow reads its secret through an **Azure Key Vault** connection: the person who signs in to it needs **Key Vault Secrets User**, and the vault must allow public network access |
| Installer-created Cowork credits Dataflow | The installing person as **Contributor** or **Member** on the workspace. Whoever signs in to the Dataflow needs Viva Insights **Insights Analyst** |
| Upload exports with the installer, Fabric or OneLake File Explorer (to `Files/analytics_hub_uploads`) | The signed-in person as **Contributor** or **Member** on the workspace. No extra API permission. |
| Optional SharePoint/OneDrive folder shortcut into the drop folder | Fabric tenant setting for **OneDrive and SharePoint shortcuts** enabled, and read access to the folder for whoever creates the shortcut. Without it, use the Lakehouse folder. |
| Capacity | Workspace on a Fabric capacity (**F2+** or trial) |
| Connect the Power BI template | Read on the Lakehouse **SQL endpoint** (the template signs in to it once) |
| Installer-published Power BI reports | The installing person as **Contributor** or **Member** on the workspace. No extra API permission. The Tornado chart, Word cloud and Deneb visuals need the tenant setting **Allow visuals created using the Power BI SDK** |

---

## Credit consumption on Azure (path 2)

| What | Role / requirement |
|---|---|
| Copilot Studio flow (the default source) | As on Fabric: **Environment Maker** in the environment, a **Power Automate Premium** licence for the flow owner, and a Power Platform API connection signed in as a **Power Platform Administrator**, **Billing Administrator** or **Global Administrator**. The flow always signs in as the person installing; `--flow-identity app` is Fabric only |
| The flow writes to the `landing` container (public endpoints) | Whoever signs the flow's storage connection in (resource `https://storage.azure.com`) needs **Storage Blob Data Contributor** on the storage account. The installer assigns it to the person installing if they can assign roles |
| The flow writes to a SharePoint folder (private networking) | Whoever signs the flow's SharePoint connection in needs to add files to the folder. The jobs' managed identity needs the Graph app role **Sites.Selected** plus **Read** on that site, granted by a SharePoint or Global administrator (the installer does it, or prints the `Grant-PnPAzureADAppSitePermission` command) |
| Azure AI and pay-as-you-go spend | The jobs' managed identity gets **Reader**, **Cost Management Reader** and **Monitoring Reader** on the Azure AI subscription, and **Cost Management Reader** on each pay-as-you-go subscription. The installer assigns them when the person installing can assign roles there |
| Cowork credits | No automated pull on Azure yet. Drop the Consumption Dashboard's Viva Insights export (**Insights Analyst**) in the `viva` folder |
| Azure Resource Graph (module `resourceGraph`) | The jobs' managed identity gets **Reader** at the management group, or the tenant root group, for Foundry, and needs an Entra role such as **Global Reader** for agents. See [Azure Resource Graph](#azure-resource-graph) |

---

## Ask (paths 1 and 2)

The app's Ask page always lists suggested questions. What answers them needs:

| What | Role / requirement |
|---|---|
| Create, update and publish the **Analytics Hub Ask** data agent (Fabric) | The installing person as **Contributor** or **Member** on the workspace. The workspace on a paid capacity, **F2** or larger or Premium **P1** or larger, not a trial. Tenant settings **Users can create and share data agent items** and **Users can use Copilot and other features powered by Azure OpenAI**, plus **Data sent to Azure OpenAI can be processed outside your capacity's geographic region** for capacities outside the US and EU |
| Ask the data agent questions (Fabric) | Access to the agent (shared with them, or a workspace role) and **Build** or **Read** on the models it reads. The viewer group already has Build |
| Publish the agent to Teams or Microsoft 365 Copilot | Done by hand in Fabric; there's no API for it. Whoever publishes needs to be able to publish the agent from the workspace |
| Create the Ask model (Azure, the default) | **Contributor** on the resource group to create the Azure AI Services account and deployment, and the `Microsoft.CognitiveServices` resource provider registered (the installer registers it). Model quota in the region |
| Let the web app call the model (Azure) | The web app's managed identity gets **Cognitive Services OpenAI User** on the AI Services or Azure OpenAI account. The installer assigns it for an account it creates, and for an existing account if the person installing can assign roles there; otherwise it prints the `az role assignment create` command for an Owner or User Access Administrator |
| Ask questions (Azure) | Nothing beyond viewing. Every query runs as the person asking, with their own access to the models |

---

## Viewing Analytics Hub (paths 1 and 2)

The installer creates one Entra security group, **Analytics Hub Viewers**, with you as its owner (or uses a group you name). Sharing is adding people to it, from the installer's `access` command, **Share** in the app, or [My Groups](https://myaccount.microsoft.com/groups).

| What | Role / requirement |
|---|---|
| Create the viewer group | The installing person can create security groups (users can by default; some tenants turn it off). Otherwise an Entra admin creates one and you pick it with `access` |
| Query the models | The group gets **Build** (ReadExplore) on each model the app reads: `Analytics Hub Model`, and Consumption Central and Agent Evaluator when they're on. The installer grants it as a workspace Admin or Member |
| Open the Power BI models below F64 | Viewers need a **Power BI Pro** (or PPU) licence unless the workspace is on an F64 or larger capacity |
| Open the Fabric app (path 1) | Share the app item with the group once (**Share** on the item). After that, membership is enough |
| Open the Azure web app (path 2) | Membership of the group (the token's `groups` claim, checked with `checkMemberGroups` when a user is in too many groups), or the **AnalyticsHub.User** app role |
| Add and remove viewers in the Azure app | Group **owners** and **AnalyticsHub.Admin**. The web app calls Graph as the signed-in person with the delegated **GroupMember.ReadWrite.All** scope (admin-consented by the installer); Graph still only lets owners and admins change the group |
| Add and remove viewers on Fabric | Group owners, in My Groups |

> **Keep viewers off workspace roles.** Even a workspace Viewer can query the Lakehouse's SQL endpoint, and Admins, Members and Contributors skip [org-scoped access](#org-scoped-access-row-level-security). Share the app and models through the group instead. Organizational apps (preview) can be an optional landing page that bundles the app and the reports.

---

## Org-scoped access (row-level security)

By default everyone in **Analytics Hub Viewers** sees every org. Org-scoped access is **opt-in**: turn it on from the installer's `access` command (**Org-scoped access: who sees which orgs**). Each viewer then sees only the orgs they've been given a **scope** for:

| Scope | Sees |
|---|---|
| **Everyone** (`all`) | Every person, and the tenant-wide pages |
| **Below a person** (`hierarchy`) | That person and everyone who reports to them, at any depth, from the org data's manager chain |
| **An org** (`org`) | Everyone whose department (or country, if you switch) is that value |

A person can have several scopes; they see the union. People without a scope of their own get the default (`*`) scopes, if any. With none, they see nothing, and the app says who to ask instead of showing empty pages.

**How it works.** Scopes are kept outside the models, so redeploys never lose them: `Files/analytics_hub_access/access_scope.csv` in the Lakehouse on Fabric, `access/access_scope.csv` in the landing container on Azure (loaded into `dbo.access_scope`). When it's on, each model gets two hidden tables (**Access Scope** and **Access People**) and two roles:

- **Everyone** filters nothing but the scope table. Its members are the people with an `all` scope.
- **Scoped viewers** has the viewer group as its member and filters the model's org table (and the person-level tables it doesn't reach) to the person's scopes. Tenant-wide tables (Azure and pay-as-you-go spend, agent inventory, Defender, Resource Graph, product feedback) show only to `all`, so those pages drop out of a scoped viewer's sidebar.

A model definition deploy drops role members, so after every deploy the installer runs the **AnalyticsHub_Access_Scope** notebook, which applies the members through the XMLA endpoint, and then checks the result by querying as a seeded viewer.

| What | Role / requirement |
|---|---|
| Turn it on, change scopes | A workspace **Admin** or **Member** running the installer. On Azure also **Storage Blob Data Contributor** on the storage account (the installer assigns it if you can) |
| Apply role members | The tenant setting **Allow XMLA endpoints**, and a Fabric, Premium or Premium Per User capacity with the XMLA endpoint set to **Read Write**. A Pro workspace can't have role members applied, so the installer won't turn it on there |
| Azure | The Power BI workspace on a capacity, as above. The notebook runs in that workspace. Installs with private networking aren't supported yet, because the notebook can't reach the storage account |
| "Below a person" scopes | Manager data in the org data. The installer warns when fewer than half the people have a manager |
| Who skips it | Workspace **Admins, Members and Contributors** see every row whatever their scope. The installer lists them when you turn it on, and the app shows them "Showing: everyone (your workspace role)" |
| Who can give scopes | Analytics Hub admins, from the installer's `access` command. On Azure also from **Share** in the app: see below |

**Upgrades and Repair.**

| Situation | What happens |
|---|---|
| Upgrade or Repair, org-scoped access off (the default) | Nothing changes. The models deploy exactly as before, with no roles and no access tables. On Azure the database gets an empty `access_scope` table. The org data gains an `OrgPath` column, which models without org-scoped access ignore |
| You turn it on | Everyone in the viewer group now, and you, get an `all` scope, so nobody loses anything. The models are redeployed with the roles, the members are applied, the models refresh and the installer checks a seeded person sees everyone |
| Upgrade or Repair with it on | Any model redeploy is followed by applying the members again and checking. The scopes are untouched |
| Someone joins the viewer group later | They see nothing until you give them a scope (or you add a default `*` scope) |
| You turn it off | The models are redeployed without the roles or access tables. The scopes are kept for if you turn it on again |

**Giving scopes from the Share panel (Azure).** With org-scoped access on, **Share** in the Azure app has a **What people see** section:

| Who | What they can do |
|---|---|
| **AnalyticsHub.Admin** | Give anyone **Below a person** or **An org**, optionally with **Can share their org**. See and take back every scope given here, and approve the ones waiting for an admin |
| A leader: someone with a **can share** scope | Give someone **My org**: the people below themselves. Only when that sits inside a scope they were given with can share (an `all` scope, or a **Below a person** scope for themselves or someone above them). They can't pass on can share, and they take back only what they gave |
| Everyone else | Sees "Only an Analytics Hub admin can choose what people see", with who to ask |

- Nobody gives **Everyone** (`all`) from the app. That changes the Everyone role's members, so it stays in the installer's `access` command.
- A delegate also needs to be in the viewer group. The app adds them as the signed-in person, so it only works for owners of the group and directory admins. For anyone else the scope is saved as **Waiting for an admin** and has no effect until an admin approves it in the Share panel, which adds them to the group. No extra Graph permissions are needed.
- The web app writes scopes to `dbo.access_scope` (marked `share`) as its managed identity. The jobs' scheduled load replaces only the installer's scopes from the CSV, so these stay. Remove them in the app, not the CSV.
- After a change the app refreshes the models' **Access Scope** table as the managed identity, so it usually applies within a few minutes. Changes close together share a refresh. When Power BI is busy or won't take another refresh, the change applies at the next scheduled refresh. Org-scoped access needs a capacity, so Pro's 8 refreshes a day don't apply, but these refreshes count towards the capacity's load.
- Taking a scope back doesn't remove the person from the viewer group. Without another scope they fall back to the default (`*`) scopes.

On Fabric, scopes are given only by admins, from the installer. The Share panel says so, and who to ask.

Caveats:
- Scopes other than `all` change at the next scheduled load. **Apply now** in `access` reloads and refreshes straight away; a new `all` scope needs it, since it changes role members.
- Totals on a scoped viewer's pages, licence counts included, are for the people they can see.
- Hiding names from scoped viewers isn't part of this. The app's minimum-group-size rules still apply.

---

## Quick "who do I ask?" summary

- **Just the core dashboard:** one Entra app reg (3 Graph perms, admin-consented) + Contributor on the workspace.
- **+ Feedback:** an admin exports the feedback CSV and lands it, by hand or with the flow. No extra API permission. With the installer, choose **Upload CSV** on its Data sources card, or drop it in `Files/analytics_hub_uploads`.
- **+ Agents 365:** add `CopilotPackages.Read.All` + `Application.Read.All` (+ `User.Read.All`) to the same app reg, and confirm the tenant has an Agent 365 licence.

See the README for what you're deploying for the step-by-step —
[the app](../app/README.md) · [1](../1.%20Fabric/README.md) · [2](../2.%20Azure/README.md) ·
[4](../4.%20SharePoint/README.md) · [5](../5.%20Local%20CSV/README.md).
