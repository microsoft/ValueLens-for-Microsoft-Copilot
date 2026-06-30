# SharePoint deployment

Run the AI Business Value Dashboard on **Power BI Pro** — no Fabric capacity, no gateway.
Pick how you get the data in:

| Option | Best for | What you do |
|---|---|---|
| **A — Manual (first run)** ⭐ | A **quick first look** to see how the numbers land, or a one-off refresh. | Export two CSVs by hand → run one [processor script](#option-a--manual-first-run) → connect the **(Local CSV)** template. No app registration, no scheduling. |
| **B — Automated (PAX)** | An **ongoing**, scheduled refresh. | [Microsoft PAX](https://github.com/microsoft/PAX) extracts + rolls up automatically → upload to SharePoint → the template refreshes on a schedule. |

```
Option A (manual):    [export 2 CSVs] -> [Processor .py] -> [ (Local CSV) PBIT ]
Option B (automated): [Run-PAX-AIBV] -> [Upload-Rollups-SharePoint] -> [ SharePoint PBIT, scheduled ]
```

Both produce the **same two rollup CSVs** the dashboard reads
(`copilot_interactions_rollup.csv` + `copilot_users_rollup.csv`). Start with **A**, move to **B** when you want it hands-off.

---

## Option A — Manual (first run)

> The fastest way to see real numbers. You supply two exports; the processor turns them into the
> two rollup CSVs the template reads. Nothing is uploaded and no app registration is needed.

**You need:** any shell, **Python 3.9+**, and read access to the two admin exports below.

**1. Export the two source files**

| Export | Where | Becomes |
|---|---|---|
| Raw **Copilot interactions** (audit log CSV) | Microsoft **Purview** -> Audit -> search `CopilotInteraction` -> Export | `--purview` input |
| **Users + licensing** (Entra users CSV with each user's Copilot licence flag) | Microsoft **Entra** / M365 Admin Center -> Users -> Export | `--entra` input |

**2. Run the processor** ([`scripts/Purview_CopilotInteraction_Processor_v4.0.0.py`](./scripts/Purview_CopilotInteraction_Processor_v4.0.0.py))

```bash
python "scripts/Purview_CopilotInteraction_Processor_v4.0.0.py" \
    --purview  "<raw_copilot_interactions.csv>" \
    --entra    "<entra_users_with_licensing.csv>" \
    --profile  aibv
```

It writes the two rollup CSVs next to your inputs (`*_Interactions_*.csv`, `*_Users_*.csv`).
Run with `--help` for all options (`--out-dir`, `--with-aggregates`, …). Full column expectations
are in [`../1. Fabric/docs/DATA-DICTIONARY.md`](../1.%20Fabric/docs/DATA-DICTIONARY.md).

**3. Connect the template**

Open **`AI Business Value Dashboard - SharePoint (Local CSV).pbit`**, and when prompted point the two
parameters at the rollup CSVs from step 2:

| Parameter | Value |
|---|---|
| Copilot Interactions File | local path to `*_Interactions_*.csv` |
| Org Data File | local path to `*_Users_*.csv` |
| Agent 365 *(optional)* | blank, or a local Agents 365 CSV |

**Load** — done. To refresh, re-export, re-run the processor, and **Refresh** in Desktop.

> Want this on a schedule instead? Upload the same two CSVs to SharePoint (see **Option B → Daily
> refresh → Upload** below) and use the standard `…- SharePoint.pbit` template.

---

## Option B — Automated (PAX)

Scheduled refresh from a SharePoint library. Three scripts: provision once, then extract + upload
on a cadence.

<details>
<summary><strong>Prerequisites</strong></summary>

**On the machine that runs the extract:**
- PowerShell 7+ (`pwsh`) — [install guide](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows). Run scripts with `pwsh`, not Windows PowerShell.
- Internet access to GitHub Releases (the wrapper downloads the current PAX release).
- Python 3.10+ (PAX bootstraps it internally for the rollup).

**In your tenant:**
- An Entra app registration with these admin-consented **Microsoft Graph Application** permissions:
  `AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`, `Organization.Read.All`, `Sites.Selected`.
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
| **SharePoint write** | `Sites.Selected` (per-library, least privilege) | `Sites.Selected` when you own the upload step; PAX's bundled `Deploy-PAXAcaJob.ps1` needs the broader `Sites.ReadWrite.All` + `Files.ReadWrite.All` — an upstream PAX constraint. |
| **Status here** | ✅ Available now | ⏳ Pending the ACA Job — see [`azure-container/`](./azure-container/) |

Both use the **same Graph read permissions**; they differ only in how the identity signs in. Run
**one** option, never both. The rest of this guide uses the app registration via
[`Register-TaskScheduler.ps1`](./scripts/Register-TaskScheduler.ps1).
</details>

<details>
<summary><strong>One-time setup</strong></summary>

**1. Grant the app write access to your SharePoint site** — [`ProvisionSiteAccess-SP-AppReg.ps1`](./scripts/ProvisionSiteAccess-SP-AppReg.ps1)
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

### Extract — [`Run-PAX-AIBV.ps1`](./scripts/Run-PAX-AIBV.ps1)
```powershell
cd scripts
.\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 30
```
Produces `.\processed\*_Interactions_*.csv`, `.\processed\*_Users_*.csv`, and `rollup-manifest.json`
(5–15 min for 30 days). Add `-IncludeAgent365Info` for the optional Agents 365 output. See
[`scripts/README.md`](./scripts/README.md) for all parameters.

### Upload — [`Upload-Rollups-SharePoint.ps1`](./scripts/Upload-Rollups-SharePoint.ps1)
```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -Manifest .\processed\rollup-manifest.json `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' -FolderPath '/AIBV'
```
Lands as fixed names `copilot_interactions_rollup.csv` + `copilot_users_rollup.csv` (overwrites the previous run).

### Schedule — [`Register-TaskScheduler.ps1`](./scripts/Register-TaskScheduler.ps1)
```powershell
.\Register-TaskScheduler.ps1 `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' `
    -FolderPath '/AIBV' -RunAt '02:00'
```
Add `-RunAsUser DOMAIN\svc_aibv` for a service account. Runs under the app registration; the secret
is **not** stored in the task. (Secretless managed-identity scheduling is WIP — see [`azure-container/`](./azure-container/).)
</details>

<details>
<summary><strong>Connect the template</strong> (SharePoint refresh)</summary>

1. Open **`AI Business Value Dashboard - SharePoint.pbit`** in Power BI Desktop.
2. **Transform data → Edit parameters**:

   | Parameter | Value |
   |---|---|
   | Copilot Interactions File | `https://<tenant>.sharepoint.com/.../copilot_interactions_rollup.csv` |
   | Org Data File | `https://<tenant>.sharepoint.com/.../copilot_users_rollup.csv` |
   | Agent 365 *(optional)* | blank, or a SharePoint URL to your Agents 365 export |

3. **Load** → **Publish** to a Power BI workspace.
4. In Power BI Service: dataset **Settings → Data source credentials** → sign in to SharePoint, **Privacy: None**.
5. **Scheduled refresh** → enable, set to run after your extract (e.g. extract 02:00, refresh 04:00).
</details>

---

## What's in this folder

| Item | Purpose |
|---|---|
| `AI Business Value Dashboard - SharePoint.pbit` | The dashboard template (refreshes from SharePoint URLs). |
| `AI Business Value Dashboard - SharePoint (Local CSV).pbit` | Same dashboard, parameters take **local** CSV paths — used by **Option A**. |
| [`scripts/`](./scripts/) | Extract / upload / schedule helpers + the manual processor. See [`scripts/README.md`](./scripts/README.md). |
| [`azure-container/`](./azure-container/) | Planned ACA Job for secretless managed-identity scheduling (WIP). |

---

<details>
<summary><strong>Troubleshooting</strong></summary>

| Symptom | Fix |
|---|---|
| `python: command not found` | Install Python 3.10+ and retry. |
| `0 records returned` (PAX) | `AuditLogsQuery.Read.All` consent missing — re-grant in Entra. |
| Masked UPNs (32-char hex) | M365 Admin → Org settings → Reports → untick "Display concealed names". |
| `403 Forbidden` on upload | App lacks per-site write — re-run [`ProvisionSiteAccess-SP-AppReg.ps1`](./scripts/ProvisionSiteAccess-SP-AppReg.ps1). |
| `404 Not Found` on upload | `-FolderPath` doesn't exist in SharePoint — create it, or use `/` for the library root. |
| Refresh hits 1 GB / 2-hour cap | Move to [`../1. Fabric/`](../1.%20Fabric/) for high-volume tenants. |
</details>
