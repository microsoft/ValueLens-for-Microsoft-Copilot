# SharePoint deployment

Run the AI Business Value Dashboard with scheduled refresh, no Fabric capacity,
no gateway. Three steps: extract, upload, connect.

```
[Run-PAX-AIBV.ps1]  →  [Upload-Rollups-SharePoint.ps1]  →  [PBIT]
   extract + classify        push to SharePoint              dashboard refresh
```

---

## What you need

**On the machine that runs the extract:**

- PowerShell 7+ (`pwsh`)
- Python 3.10+
- `git`

**In your tenant:**

- An Entra app registration with these **Microsoft Graph Application**
  permissions (admin-consented):
  - `AuditLogsQuery.Read.All`
  - `Reports.Read.All`
  - `User.Read.All`
  - `Organization.Read.All`
  - `Sites.Selected`
- A SharePoint document library to hold the two CSVs the dashboard refreshes
  from.
- Power BI Pro (or Premium / PPU) workspace to publish into.

You'll need the **Tenant ID**, **Client ID**, and **Client Secret** of the
app registration before you start.

---

## Authentication

There are **two ways** to authenticate. Pick by **where the job runs**.

| | **Option A — App registration** | **Option B — Managed identity** |
|---|---|---|
| **Best when** | You run the job on a Windows host or CI (Task Scheduler, GitHub Actions) | You host the job in Azure (Container Apps Job) |
| **`-Auth`** | `AppRegistration` (client secret **or** certificate) | `ManagedIdentity` |
| **Secret to manage** | Yes — or use a certificate to avoid rotation | None |
| **SharePoint write permission** | `Sites.Selected` (per-library, least privilege) | `Sites.ReadWrite.All` + `Files.ReadWrite.All` |
| **Status in this repo** | ✅ Available now | ⏳ Pending the ACA Job — see [`azure-container/`](./azure-container/) |

Both options use the **same Graph read permissions** (listed under *What you need*);
they differ only in **how the identity signs in** and the **SharePoint write scope**.
You run **one** of them, never both.

- **Option A** is what the rest of this guide uses. The scheduling helper
  ([`Register-TaskScheduler.ps1`](./scripts/Register-TaskScheduler.ps1)) runs the
  extract and upload under the app registration.
- **Option B** runs PAX as an Azure Container Apps Job with no secret to rotate.
  The earlier schema blocker is resolved (PAX **v1.11.5+** produces the AIBV
  rollup natively via `-Dashboard AIBV`); what remains is committing and testing
  the ACA Job. See [`azure-container/`](./azure-container/).

---

## Setup (one time)

### 1. Grant the app write access to your SharePoint site

```powershell
cd scripts
.\ProvisionSiteAccess-SP-AppReg.ps1 `
    -TenantId       "<tenant-id>" `
    -SiteHost       "<tenant>.sharepoint.com" `
    -AppClientId    "<client-id>" `
    -AppDisplayName "<app-name>"
```

Save the **SiteId** and **DriveId** it prints — you'll need both.

### 2. Stash the client secret (optional but recommended)

```powershell
cmdkey /generic:PAX-AIBV-<tenant-id> /user:app /pass:<client-secret>
```

The scripts will read it from here at runtime so you never have to pass it
on the command line.

---

## Daily refresh

### Extract

```powershell
cd scripts
.\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 30
```

Produces `.\processed\*_Interactions_*.csv`, `.\processed\*_Users_*.csv`,
and `rollup-manifest.json`. A 30-day extract typically takes 5–15 minutes.

### Upload

```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -Manifest    .\processed\rollup-manifest.json `
    -TenantId    <tenant-id> `
    -ClientId    <client-id> `
    -SiteId      '<host>,<siteguid>,<webguid>' `
    -DriveId     'b!...' `
    -FolderPath  '/AIBV'
```

Files land in SharePoint as `copilot_interactions_rollup.csv` and
`copilot_users_rollup.csv`. They overwrite the previous run.

### Schedule it

To make the above two commands run daily, use the Task Scheduler helper:

```powershell
.\Register-TaskScheduler.ps1 `
    -TenantId   <tenant-id> `
    -ClientId   <client-id> `
    -SiteId     '<host>,<siteguid>,<webguid>' `
    -DriveId    'b!...' `
    -FolderPath '/AIBV' `
    -RunAt      '02:00'
```

Pass `-RunAsUser DOMAIN\svc_aibv` to run under a service account.

> This runs under the **app registration** (see [Authentication](#authentication)).
> A secretless, managed-identity schedule via Azure Container Apps is **planned but
> still WIP** — see [`azure-container/`](./azure-container/).

---

## Connect the template

1. Open **`AI Business Value Dashboard - SharePoint.pbit`** in Power BI Desktop.
2. **Transform data → Edit parameters** → set:

   | Parameter | Value |
   |---|---|
   | Copilot Interactions File | `https://<tenant>.sharepoint.com/.../copilot_interactions_rollup.csv` |
   | Org Data File | `https://<tenant>.sharepoint.com/.../copilot_users_rollup.csv` |
   | Agent 365 *(optional)* | blank, or a SharePoint URL to your Agents 365 export |

3. **Load** → **Publish** to a Power BI workspace.
4. In Power BI Service: dataset **Settings → Data source credentials** → sign
   in to SharePoint, set **Privacy: None**.
5. **Scheduled refresh** → enable, set to run after your extract (e.g. extract
   at 02:00, refresh at 04:00).

---

## What's in this folder

| Item | Purpose |
|---|---|
| `AI Business Value Dashboard - SharePoint.pbit` | The dashboard template. |
| `scripts/Run-PAX-AIBV.ps1` | Extract + classify. Produces the two rollup CSVs. |
| `scripts/Upload-Rollups-SharePoint.ps1` | Push the two CSVs to SharePoint. |
| `scripts/Register-TaskScheduler.ps1` | Run the above two daily as a Windows Scheduled Task. |
| `scripts/ProvisionSiteAccess-SP-AppReg.ps1` | One-time `Sites.Selected` grant. |
| `scripts/Get-Agents365Registry.ps1` | Optional Agents 365 export. |
| `scripts/Purview_CopilotInteraction_Processor_v4.0.0.py` | Called by `Run-PAX-AIBV.ps1` — you don't run this directly. |
| `azure-container/` | Planned ACA Job for secretless **managed-identity** scheduling (WIP — see [Authentication](#authentication)). |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `git: command not found` / `python: command not found` | Install git / Python 3.10+ and retry. |
| `0 records returned` | `AuditLogsQuery.Read.All` consent missing — re-grant in Entra. |
| Masked UPNs (32-char hex) | M365 Admin → Org settings → Reports → untick "Display concealed names". |
| `403 Forbidden` on upload | App lacks per-site write permission — re-run `ProvisionSiteAccess-SP-AppReg.ps1`. |
| `404 Not Found` on upload | The `-FolderPath` doesn't exist in SharePoint. Create it, or use `/` for the library root. |
| Refresh hits 1 GB / 2-hour cap | Move to [`../1. Fabric/`](../1.%20Fabric/) for high-volume tenants. |
