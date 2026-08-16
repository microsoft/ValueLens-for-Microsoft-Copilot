# 2. SharePoint — scheduled refresh on Power BI Pro

Run **ValueLens** with an **automatic scheduled refresh** on **Power BI Pro** — no Fabric
capacity, no gateway.

A script extracts your data, rolls it up and uploads two CSVs to SharePoint. Power BI refreshes
from there on a timer. Provision once, then it runs hands-off.

```
[Run-PAX-AIBV] -> [Upload-Rollups-SharePoint] -> [ SharePoint PBIT, scheduled ]
```

> ### 👋 Want a first look before setting this up?
>
> Use **[1. Local CSV](../1.%20Local%20CSV/)** instead — it includes a **sample dataset** that
> fills the dashboard with no tenant access at all, and it also covers the **manual one-off**
> route for your own data (export → processor → local file paths).
>
> That path produces the **same two rollup CSVs** this one uploads, so nothing is wasted when you
> come back here to automate it.

---

## 📚 Dashboard pages

<details>
<summary>13 report pages — activation, adoption, value, maturity, governance &amp; appendices</summary>

| Page | Purpose |
|---|---|
| **◆ Activation** | Activation across teams — licensed vs unlicensed, active vs inactive |
| **🎯 Readiness** | Ranks unlicensed / low-adoption users by upgrade‑priority score |
| **📡 Adoption** | User counts, coverage %, licensed vs unlicensed reach |
| **🪙 Consumption** | Copilot &amp; agent consumption — credits / messages over time |
| **🔮 Activity** | Copilot and agent usage, tasks and behaviour mix |
| **🚀 Value** | Hours saved, dollar‑equivalent assisted value, and the business case |
| **🌱 Maturity** | Progression: Asking → Finding → Consuming → Producing → Delegating |
| **🛡 Agent Health** | Agent resolution, abandonment, escalation and response time |
| **📈 Heatmap** | Activity heatmap across the reporting period |
| **🏅 Leaderboard** | Top users, agents, and functions |
| **📘 Appendix: Glossary** | Metric definitions and research sources |
| **🧬 Appendix: Signal Table** | Trace raw signals through to value (audit trail) |
| **📘 Appendix: Key Concepts** | Methodology and key‑concept explainers |

</details>

---

## Setup

Scheduled refresh from a SharePoint library: the script extracts + rolls up your data, uploads the
two CSVs to SharePoint, and Power BI refreshes on a schedule. Provision once, then it runs hands-off.

Three helper scripts do the work, in order —
[`Run-PAX-AIBV.ps1`](scripts/Run-PAX-AIBV.ps1) (extract) →
[`Upload-Rollups-SharePoint.ps1`](scripts/Upload-Rollups-SharePoint.ps1) (upload) →
[`Register-TaskScheduler.ps1`](scripts/Register-TaskScheduler.ps1) (schedule).

> **Using your own org data instead of Entra?** Point the extract at your own org/HR file with
> `-UserInfoFile <path|SharePoint-URL|OneLake-path>` — copy the
> [sample template](../1.%20Local%20CSV/scripts/OrgData-Template.csv) (same shape as a Viva Insights org-data file) to
> get started. Only `UserPrincipalName` is required. See the **Daily refresh** step below.

Provision once, then extract + upload on a cadence.

<details>
<summary><strong>Prerequisites</strong></summary>

**On the machine that runs the extract:**
- PowerShell 7+ (`pwsh`) — [install guide](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows). Run scripts with `pwsh`, not Windows PowerShell.
- Internet access to GitHub Releases (the script downloads the current extract tool automatically).
- Python 3.10+ (the script bootstraps it internally for the rollup).

**In your tenant:**
- An Entra app registration with these admin-consented **Microsoft Graph Application** permissions:
  `AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`, `Organization.Read.All`, `Sites.Selected`.
  - *Only if you use `-IncludeAgent365Info`* (optional Agent 365 catalogue): also add
    `CopilotPackages.Read.All` + `Application.Read.All`, and an **Agent 365 licence** in the tenant.
- A SharePoint document library to hold the two CSVs.
- A Power BI Pro (or Premium / PPU) workspace to publish into.

You'll need the **Tenant ID**, **Client ID**, and **Client Secret** before you start.
</details>

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

<details>
<summary><strong>One-time setup</strong></summary>

**1. Grant the app write access to your SharePoint site** — [`ProvisionSiteAccess-SP-AppReg.ps1`](scripts/ProvisionSiteAccess-SP-AppReg.ps1)
```powershell
cd scripts
.\ProvisionSiteAccess-SP-AppReg.ps1 `
    -TenantId "<tenant-id>" -SiteHost "<tenant>.sharepoint.com" `
    -AppClientId "<client-id>" -AppDisplayName "<app-name>"
```
Save the **SiteId** and **DriveId** it prints — the upload step needs both.

**2. Stash the client secret** (optional, recommended)
```powershell
cmdkey /generic:PAX-AIBV-<tenant-id> /user:app /pass:<client-secret>
```
The scripts read it from here at runtime.
</details>

<details>
<summary><strong>Daily refresh</strong> — extract → upload → schedule</summary>

### Extract — [`Run-PAX-AIBV.ps1`](scripts/Run-PAX-AIBV.ps1)

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
(5–15 min for 30 days). Add `-IncludeAgent365Info` for the optional Agents 365 output — this runs
**app-only/unattended** under your `-Auth` mode (needs
`CopilotPackages.Read.All` + `Application.Read.All` and an Agent 365 licence; a missing licence
returns `403`). To supply your own user directory instead of pulling it live from Entra, add
`-UserInfoFile <path|SharePoint-URL|OneLake-path>` (BYOD; `UserPrincipalName` required, other columns
optional/alias-aware). For privacy-restricted tenants, pair it with `-Deidentify` to anonymise user
identities. See [`scripts/README.md`](scripts/README.md) for all parameters.

### Upload — [`Upload-Rollups-SharePoint.ps1`](scripts/Upload-Rollups-SharePoint.ps1)
```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -Manifest .\processed\rollup-manifest.json `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' -FolderPath '/AIBV'
```
Lands as fixed names `copilot_interactions_rollup.csv` + `copilot_users_rollup.csv` (overwrites the previous run).

### Schedule — [`Register-TaskScheduler.ps1`](scripts/Register-TaskScheduler.ps1)
Seed the interactions file once manually (the back-fill run above), then register the daily task with
`-AppendFile` so each run appends only the latest window:
```powershell
.\Register-TaskScheduler.ps1 `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' `
    -FolderPath '/AIBV' -Days 2 -AppendFile Purview_CopilotInteraction_Rollup.csv -RunAt '02:00'
```
Add `-RunAsUser DOMAIN\svc_aibv` for a service account. Runs under the app registration; the secret
is **not** stored in the task. (Secretless managed-identity scheduling is WIP — see [`azure-container/`](azure-container/).)
</details>

<details>
<summary><strong>Connect the template</strong> (SharePoint refresh)</summary>

1. Open **`ValueLens - SharePoint.pbit`** in Power BI Desktop.
2. **Transform data → Edit parameters**:

   | Parameter | Value |
   |---|---|
   | Copilot Interactions File | `https://<tenant>.sharepoint.com/.../copilot_interactions_rollup.csv` |
   | Org Data File | `https://<tenant>.sharepoint.com/.../copilot_users_rollup.csv` |
   | Agent 365 *(optional)* | blank, or a SharePoint URL to your Agents 365 export |

3. **Load** → **Publish** to a Power BI workspace.
4. In Power BI Service: dataset **Settings → Data source credentials** → sign in to SharePoint, **Privacy: None**.
5. **Scheduled refresh** → enable, set to run after your extract (e.g. extract 02:00, refresh 04:00).

> **Using your own org data (BYOD)?** If you ran the extract with `-UserInfoFile`, your directory
> still lands in the same `copilot_users_rollup.csv` — so **this template step is unchanged**: point
> `Org Data File` at that file exactly as above. Nothing else to configure.
</details>

---

## What's in this folder

| Item | Purpose |
|---|---|
| `ValueLens - SharePoint.pbit` | The dashboard template (refreshes from SharePoint URLs). |
| [`scripts/`](scripts/) | Extract / upload / schedule helpers + the processor. See [`scripts/README.md`](scripts/README.md). |
| [`azure-container/`](azure-container/) | Planned ACA Job for secretless managed-identity scheduling (WIP). |

> Looking for the **local file path** template? It moved to
> [`../1. Local CSV/ValueLens - Local CSV.pbit`](../1.%20Local%20CSV/) along with the sample data.
> This template deliberately accepts SharePoint URLs only.

---

<details>
<summary><strong>Troubleshooting</strong></summary>

| Symptom | Fix |
|---|---|
| `python: command not found` | Install Python 3.10+ and retry. |
| `0 records returned` | `AuditLogsQuery.Read.All` consent missing — re-grant in Entra. |
| Masked UPNs (32-char hex) | M365 Admin → Org settings → Reports → untick "Display concealed names". |
| `403 Forbidden` on upload | App lacks per-site write — re-run [`ProvisionSiteAccess-SP-AppReg.ps1`](scripts/ProvisionSiteAccess-SP-AppReg.ps1). |
| `404 Not Found` on upload | `-FolderPath` doesn't exist in SharePoint — create it, or use `/` for the library root. |
| **Agent Health visuals blank** (`Users shared`, `Active Users`, `Total sessions`, `Exception rate`, `Last Activity Date`) | Expected on the PAX / registry path. `-IncludeAgent365Info` exports the **28-column registry catalogue**, which does not carry usage telemetry — those come from the Admin Center → **Agents** observability export. The template adds the missing columns as typed nulls so refresh still succeeds; land the Admin Center export to populate them. See [`../3. Fabric/docs/DATA-DICTIONARY.md`](../3.%20Fabric/docs/DATA-DICTIONARY.md#4-agents_365). |
| Refresh hits 1 GB / 2-hour cap | Move to [`../3. Fabric/`](../3.%20Fabric/) for high-volume tenants. |
</details>
