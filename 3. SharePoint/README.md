# 3. SharePoint — scheduled refresh on Power BI Pro, no Fabric needed

Run **ValueLens** with an **automatic scheduled refresh** on **Power BI Pro** — no Fabric
capacity, no gateway.

A script extracts your data, rolls it up and uploads two CSVs to SharePoint. Power BI refreshes
from there on a timer. Provision once, then it runs hands-off.

```
[Run-PAX-AIBV] -> [Upload-Rollups-SharePoint] -> [ SharePoint PBIT, scheduled ]
```

**Jump to:** [Who it's for](#-who-its-for) · [Prerequisites](#-prerequisites) ·
[Setup](#-setup) · [Dashboard pages](#-dashboard-pages) ·
[Troubleshooting](#-troubleshooting) · [When to move on](#-when-to-move-on)

---

## 👤 Who it's for

You want it **refreshing on its own** on **Power BI Pro**, and you have somewhere to run a
scheduled PowerShell job.

> ### 👋 Want a first look before setting this up?
>
> Use **[4. Local CSV](../4.%20Local%20CSV/)** instead — it includes a **sample dataset** that
> fills the dashboard with no tenant access at all, and it also covers the **manual one-off**
> route for your own data (export → processor → local file paths).
>
> That path produces the **same two rollup CSVs** this one uploads, so nothing is wasted when you
> come back here to automate it.
>
> Need the **same dashboard** with Dataverse as the core transport? Use
> **[2. Power Automate + Dataverse](../2.%20Power%20Automate%20+%20Dataverse/)**. It preserves this
> path as an explicit fallback, but defaults to full raw audit retention + canonical ValueLens processing
> into Dataverse curated tables. This additional preview requires a Python refresh runner and
> Power Automate/Dataverse licensing; a bounded demo interval has been validated end-to-end.

### What's here

| Item | Purpose |
|---|---|
| `ValueLens - SharePoint.pbit` | The dashboard template (refreshes from SharePoint URLs). |
| [`scripts/`](scripts/) | Extract / upload / schedule helpers + the processor. See [`scripts/README.md`](scripts/README.md). |
| [`azure-container/`](azure-container/) | Planned ACA Job for secretless managed-identity scheduling (WIP). |
| [`Add Credit Consumption/`](Add%20Credit%20Consumption/) | *Optional.* The separate Consumption Central report for Copilot credit consumption and cost. |

> Looking for the **local file path** template? It moved to
> [`../4. Local CSV/ValueLens - Local CSV.pbit`](../4.%20Local%20CSV/) along with the sample data.
> This template deliberately accepts SharePoint URLs only.

---

## ✅ Prerequisites

**On the machine that runs the extract:**
- PowerShell 7+ (`pwsh`) — [install guide](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows). Run scripts with `pwsh`, not Windows PowerShell.
- Internet access to GitHub Releases (the script downloads the current extract tool automatically).
- Python 3.10+ (the script bootstraps it internally for the rollup).

**In your tenant:**
- An Entra app registration with these admin-consented **Microsoft Graph Application** permissions:
  `AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`, `Organization.Read.All`, `Sites.Selected`.
  - *Only if you use `-IncludeAgent365Info`* (optional Agent 365 registry): also add
    `CopilotPackages.Read.All` + `Application.Read.All`, and an **Agent 365 licence** in the tenant.
    (`User.Read.All`, already listed, resolves agent creators.)
- A SharePoint document library to hold the two CSVs.
- A Power BI Pro (or Premium / PPU) workspace to publish into.

You'll need the **Tenant ID**, **Client ID**, and **Client Secret** before you start.
The full least-privilege breakdown of every grant is in [`/docs/PERMISSIONS.md`](../docs/PERMISSIONS.md).

<details>
<summary><strong>Authentication</strong> — App registration vs Managed identity</summary>

| | **App registration** | **Managed identity** |
|---|---|---|
| **Best when** | Windows host or CI (Task Scheduler, GitHub Actions) | Hosted in Azure (Container Apps Job) |
| **`-Auth`** | `AppRegistration` (secret **or** certificate) | `ManagedIdentity` |
| **Secret to manage** | Yes — or a certificate to avoid rotation | None |
| **SharePoint write** | `Sites.Selected` (per-library, least privilege) | `Sites.Selected` when you own the upload step; the bundled `Deploy-PAXAcaJob.ps1` needs the broader `Sites.ReadWrite.All` + `Files.ReadWrite.All` — an upstream constraint of that script. |
| **Status here** | ✅ Available now | ⏳ Pending the ACA Job — see [`azure-container/`](azure-container/) |

Both use the **same Graph read permissions**; they differ only in how the identity signs in. Run
**one** option, never both. The rest of this guide uses the app registration via
[`Register-TaskScheduler.ps1`](scripts/Register-TaskScheduler.ps1).
</details>

---

## 🛠 Setup

Scheduled refresh from a SharePoint library: the script extracts + rolls up your data, uploads the
two CSVs to SharePoint, and Power BI refreshes on a schedule. Provision once, then it runs hands-off.

Three helper scripts do the work, in order —
[`Run-PAX-AIBV.ps1`](scripts/Run-PAX-AIBV.ps1) (extract) →
[`Upload-Rollups-SharePoint.ps1`](scripts/Upload-Rollups-SharePoint.ps1) (upload) →
[`Register-TaskScheduler.ps1`](scripts/Register-TaskScheduler.ps1) (schedule).

> **Using your own org data instead of Entra?** Point the extract at your own org/HR file with
> `-UserInfoFile <path|SharePoint-URL|OneLake-path>` — copy the
> [sample template](../4.%20Local%20CSV/scripts/OrgData-Template.csv) (same shape as a Viva Insights org-data file) to
> get started. Only `UserPrincipalName` is required. See step 3 below.

### 1. Grant the app write access to your SharePoint site

[`ProvisionSiteAccess-SP-AppReg.ps1`](scripts/ProvisionSiteAccess-SP-AppReg.ps1):

```powershell
cd scripts
.\ProvisionSiteAccess-SP-AppReg.ps1 `
    -TenantId "<tenant-id>" -SiteHost "<tenant>.sharepoint.com" `
    -AppClientId "<client-id>" -AppDisplayName "<app-name>"
```

Save the **SiteId** and **DriveId** it prints — the upload step needs both.

### 2. Stash the client secret (optional, recommended)

```powershell
cmdkey /generic:PAX-AIBV-<tenant-id> /user:app /pass:<client-secret>
```

The scripts read it from here at runtime.

### 3. Extract — [`Run-PAX-AIBV.ps1`](scripts/Run-PAX-AIBV.ps1)

**Seed once, then append.** The Purview interactions data is a growing time-series, so the pattern is:
a **first back-fill run** to create the file, then **automated short-window append runs** on a schedule.

```powershell
cd scripts
# 1. First run — seed the interactions file with a back-fill (no -AppendFile)
.\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 30

# 2. Subsequent (scheduled) runs — append only the latest window
.\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 2 `
    -AppendFile Purview_CopilotInteraction_Rollup.csv
```

The append de-duplicates on each interaction's stable message identity, so overlapping days
reconcile — nothing dropped or double-counted. **Interactions append; the Users/org
and Agent 365 outputs are snapshots (overwritten each run).**

> **Upgrading from an older run?** If you already have an append file from a previous version, start a
> **fresh** output file and re-run your full date range — earlier versions could under-count on append.
> Nothing is lost: your source data is still queryable, so re-running rebuilds the complete picture.

Produces `.\processed\*_Interactions_*.csv`, `.\processed\*_Users_*.csv`, and `rollup-manifest.json`
(5–15 min for 30 days). Add `-IncludeAgent365Info` for the optional Agent 365 registry: after PAX,
[`Get-Agents365Registry.ps1`](scripts/Get-Agents365Registry.ps1) writes
`.\processed\Agents365Registry.csv` in the same 48-column shape as the Fabric notebook (Entra
Agent ID, publisher, blocked flag and resolved creator included) and records it in the manifest.
With `-Auth AppRegistration` it runs **unattended** on the same app (needs `CopilotPackages.Read.All`
+ `Application.Read.All` + `User.Read.All` and an Agent 365 licence; a missing licence returns
`403`). A registry failure is a warning only; the rollups still upload. Add
`-Agents365Csv <admin-centre Agents export>` as the **CSV fallback** when the API step fails, or use
it on its own (without `-IncludeAgent365Info`) if the tenant has no Agent 365 licence.
`-Agent365Source PAX`
uses PAX's own 28-column catalogue export instead. To supply your own user directory instead of pulling it live from Entra, add
`-UserInfoFile <path|SharePoint-URL|OneLake-path>` (BYOD; `UserPrincipalName` required, other columns
optional/alias-aware). For privacy-restricted tenants, pair it with `-Deidentify` to anonymise user
identities. See [`scripts/README.md`](scripts/README.md) for all parameters.

### 4. Upload — [`Upload-Rollups-SharePoint.ps1`](scripts/Upload-Rollups-SharePoint.ps1)

```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -Manifest .\processed\rollup-manifest.json `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' -FolderPath '/AIBV'
```

Lands as fixed names `copilot_interactions_rollup.csv` + `copilot_users_rollup.csv` (overwrites the previous run),
plus `agents_365.csv` when the manifest lists an Agent 365 registry (or you pass `-Agents365Csv`).

### 5. Schedule — [`Register-TaskScheduler.ps1`](scripts/Register-TaskScheduler.ps1)

Seed the interactions file once manually (the back-fill run above), then register the daily task with
`-AppendFile` so each run appends only the latest window:

```powershell
.\Register-TaskScheduler.ps1 `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' `
    -FolderPath '/AIBV' -Days 2 -AppendFile Purview_CopilotInteraction_Rollup.csv -RunAt '02:00'
```

Add `-IncludeAgent365Info` to refresh the Agent 365 registry on each run (plus `-Agents365Csv <file>`
for the CSV fallback, or on its own without an Agent 365 licence), and
`-RunAsUser DOMAIN\svc_aibv` for a service account. Runs under the app registration; the secret
is **not** stored in the task. (Secretless managed-identity scheduling is WIP — see [`azure-container/`](azure-container/).)

### 6. Connect the template

1. Open **`ValueLens - SharePoint.pbit`** in Power BI Desktop.
2. **Transform data → Edit parameters**:

   | Parameter | Value |
   |---|---|
   | Copilot Interactions File | `https://<tenant>.sharepoint.com/.../copilot_interactions_rollup.csv` |
   | Org Data File | `https://<tenant>.sharepoint.com/.../copilot_users_rollup.csv` |
   | Agent 365 *(optional)* | blank, or `https://<tenant>.sharepoint.com/.../agents_365.csv` |
   | Feedback File *(optional)* | blank, or a SharePoint URL to the admin centre feedback export |

3. **Load** → **Publish** to a Power BI workspace.
4. In Power BI Service: dataset **Settings → Data source credentials** → sign in to SharePoint, **Privacy: None**.
5. **Scheduled refresh** → enable, set to run after your extract (e.g. extract 02:00, refresh 04:00).

> **Using your own org data (BYOD)?** If you ran the extract with `-UserInfoFile`, your directory
> still lands in the same `copilot_users_rollup.csv` — so **this template step is unchanged**: point
> `Org Data File` at that file exactly as above. Nothing else to configure.

---

## 📚 Dashboard pages

<details>
<summary>15 report pages — activation, adoption, habits, agents, tasks, value, model and Cowork fit, readiness &amp; appendices</summary>

| Page | Purpose |
|---|---|
| **◆ Activation** | Licensed vs unlicensed, active vs inactive users, across teams |
| **📡 Adoption** | Adoption and reach, and usage trends by tool |
| **🌱 Habit Formation** | How usage matures into habits over time |
| **🛡 Agent Registry** | Agent catalogue, tenant builds and observed use; registry detail needs the optional **Agent 365** source |
| **🔮 Task Breakdown** | What Copilot, agents and Cowork are used for, by task category |
| **🚀 Estimated Value** | Hours saved and assisted value, by task and function |
| **🧠 Model Fit** | Which AI models handle which tasks, and whether each session's model suits the work (Good match / Lighter model may do / Try stronger) |
| **🧭 Cowork Fit** | How well each Cowork task suits Cowork (Strong fit / Fair fit / Worth a look), why, and who might benefit from coaching. Grading is adjustable: Balanced by default, or Strict / Lenient |
| **🎯 Cowork Readiness** | Where to roll out Cowork next, from observed signals, ranked by organization, then user |
| **🎯 License Readiness** | Where to roll out Copilot licences next, from observed unlicensed use |
| **💬 User Feedback** | User satisfaction and sentiment; needs the optional feedback export |
| **🏅 Leaderboard** | Usage rankings for users, agents and functions |
| **📈 Trend Heatmap** | Weekly trend of a selected metric |
| **📘 Appendix: Glossary** | Definitions, evidence limits and guidance |
| **🧬 Appendix: Signal - Impact Table** | AI tasks performed → human-time estimate → value, with editable assumptions |

A hidden **⚖ License Allocation** page (expansion candidates and dormancy review) is kept for
drill-through. Every template ships this same report; only the data connection differs.
The Tool pills at the top of each page filter on `Agent Filter` (Copilot, Agents, Cowork);
`Environment` is licensing only (Licensed / Unlicensed).

</details>

---

## 🩺 Troubleshooting

<details>
<summary><strong>Common symptoms and fixes</strong></summary>

| Symptom | Fix |
|---|---|
| `python: command not found` | Install Python 3.10+ and retry. |
| `0 records returned` | `AuditLogsQuery.Read.All` consent missing — re-grant in Entra. |
| Masked UPNs (32-char hex) | M365 Admin → Org settings → Reports → untick "Display concealed names". |
| `403 Forbidden` on upload | App lacks per-site write — re-run [`ProvisionSiteAccess-SP-AppReg.ps1`](scripts/ProvisionSiteAccess-SP-AppReg.ps1). |
| `404 Not Found` on upload | `-FolderPath` doesn't exist in SharePoint — create it, or use `/` for the library root. |
| **Agent Registry usage fields blank** (`Active Users`, `Total sessions`, `Exception rate`, `Last Activity Date`) | Expected on the registry path. The catalogue rarely returns usage telemetry; that comes from the Admin Center → **Agents** observability export. The template adds missing columns as typed nulls so refresh still succeeds, and observed use comes from the audit log. See [`../docs/DATA-DICTIONARY.md`](../docs/DATA-DICTIONARY.md#4-agents_365). |
| Agent Registry shows no creator, Entra ID or blocked flag | You are on `-Agent365Source PAX` (28 columns). Use the default canonical export. |
| Refresh hits 1 GB / 2-hour cap | Move to [`../1. Fabric/`](../1.%20Fabric/) for high-volume tenants. |

</details>

---

## ➡️ When to move on

This path tops out where Power BI Pro does — a 1 GB model and a two-hour refresh window.

| Next | Gives you |
|---|---|
| **[1. Fabric](../1.%20Fabric/)** | Lakehouse ingestion at scale, plus the optional feedback and Agent 365 sources |
| **[2. Power Automate + Dataverse](../2.%20Power%20Automate%20+%20Dataverse/)** | Preview: Dataverse as the core transport, with full raw audit retention |

Going the other way, [4. Local CSV](../4.%20Local%20CSV/) is still the fastest way to sanity-check
a change before you schedule it.
