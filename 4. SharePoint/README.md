# 4. SharePoint — scheduled refresh on Power BI Pro

Use this path when you want ValueLens in Power BI Pro with scheduled refresh from SharePoint CSVs, and you do not use Fabric.

## You need

- Power BI Pro, PPU, or Premium, plus a workspace where you can publish and schedule refresh.
- PowerShell 7+ (`pwsh`), Python 3.10+, and internet access to GitHub Releases on the machine that runs the extract.
- An Entra app registration with tenant ID, client ID, and client secret.
- The licences, roles, Graph permissions, admin consent, and SharePoint access listed in [`../docs/PERMISSIONS.md`](../docs/PERMISSIONS.md).
- A SharePoint document library and folder for the CSVs. The examples use `/AIBV`.
- Optional: an Agent 365 licence for `-IncludeAgent365Info`, or an admin-centre Agents export for `-Agents365Csv`.

Read the [disclaimer](../README.md#disclaimer) too: these aren't the official Copilot reports, and
you're responsible for the CSVs once they're in SharePoint.

## Setup

Use [`scripts/README.md`](scripts/README.md) for the full parameter reference. Run scripts with PowerShell 7, not Windows PowerShell.

1. Create the Entra app registration, add the permissions from [`../docs/PERMISSIONS.md`](../docs/PERMISSIONS.md), grant admin consent, create a client secret, and copy the tenant ID, client ID, and secret.

2. Grant the app write access to the SharePoint site.

   ```powershell
   cd "4. SharePoint\scripts"
   .\ProvisionSiteAccess-SP-AppReg.ps1 `
       -TenantId "<tenant-id>" `
       -SiteHost "<tenant>.sharepoint.com" `
       -SitePath "/sites/<site-name>" `
       -AppClientId "<client-id>" `
       -AppDisplayName "<app-name>"
   ```

   Omit `-SitePath` for the root site. Save the printed `-SharePointSiteId` value as `-SiteId`, and save `-DriveId`.

3. Store the client secret for unattended runs.

   ```powershell
   cmdkey /generic:PAX-AIBV-<tenant-id> /user:app /pass:<client-secret>
   ```

4. Seed the interactions file once.

   ```powershell
   .\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 30
   ```

   Add `-UserInfoFile <path|SharePoint-URL|OneLake-path>` if you use your own org file; start from [`../5. Local CSV/scripts/OrgData-Template.csv`](../5.%20Local%20CSV/scripts/OrgData-Template.csv). Add `-IncludeAgent365Info` or `-Agents365Csv <admin-centre-agents-export.csv>` for Agent 365. The script writes `.\processed\rollup-manifest.json`.

5. Upload the seeded files to SharePoint.

   ```powershell
   .\Upload-Rollups-SharePoint.ps1 `
       -Manifest .\processed\rollup-manifest.json `
       -TenantId <tenant-id> -ClientId <client-id> `
       -SiteId '<host>,<siteguid>,<webguid>' `
       -DriveId 'b!...' `
       -FolderPath '/AIBV'
   ```

   The upload uses fixed names: `copilot_interactions_rollup.csv`, `copilot_users_rollup.csv`, and `agents_365.csv` when supplied.

6. Open [`ValueLens - SharePoint.pbit`](ValueLens%20-%20SharePoint.pbit) in Power BI Desktop, then select **Transform data → Edit parameters**.

   | Parameter | Value |
   |---|---|
   | Copilot Interactions File | `https://<tenant>.sharepoint.com/.../copilot_interactions_rollup.csv` |
   | Org Data File | `https://<tenant>.sharepoint.com/.../copilot_users_rollup.csv` |
   | Agent 365 | Blank, or `https://<tenant>.sharepoint.com/.../agents_365.csv` |
   | Feedback File | Blank, or a SharePoint URL to the admin-centre feedback export |

7. Select **Load**, then **Publish** to your Power BI workspace.

## Schedule refresh

1. Register the daily Windows Scheduled Task from an elevated PowerShell 7 window.

   ```powershell
   .\Register-TaskScheduler.ps1 `
       -TenantId <tenant-id> -ClientId <client-id> `
       -SiteId '<host>,<siteguid>,<webguid>' `
       -DriveId 'b!...' `
       -FolderPath '/AIBV' `
       -Days 2 `
       -AppendFile Purview_CopilotInteraction_Rollup.csv `
       -RunAt '02:00'
   ```

   Add `-IncludeAgent365Info`, `-Agents365Csv <admin-centre-agents-export.csv>`, or `-RunAsUser DOMAIN\svc_aibv` if needed. The task name is `AIBV-Rollup-Refresh`; it runs `Run-PAX-AIBV.ps1` and then `Upload-Rollups-SharePoint.ps1`.

2. In Power BI Service, open the semantic model **Settings**. Under **Data source credentials**, sign in to SharePoint and set **Privacy level** to **None**. Under **Scheduled refresh**, turn it on and schedule it after the extract, for example extract at `02:00` and refresh at `04:00`.

3. Check or run the scheduled task when needed.

   ```powershell
   Get-ScheduledTaskInfo -TaskName 'AIBV-Rollup-Refresh'
   Start-ScheduledTask -TaskName 'AIBV-Rollup-Refresh'
   ```

   Rotate the secret by rerunning `cmdkey`. For Azure Container Apps or managed-identity scheduling notes, see [`azure-container/README.md`](azure-container/README.md).

## Troubleshooting

| Issue | What to do |
|---|---|
| `pwsh.exe not found` | Install PowerShell 7+ and rerun from `pwsh`. |
| `python: command not found` | Install Python 3.10+ on the machine that runs the extract. |
| `0 records returned` | Check the date window and the app permissions in [`../docs/PERMISSIONS.md`](../docs/PERMISSIONS.md). |
| `403 Forbidden` on upload | Re-run `ProvisionSiteAccess-SP-AppReg.ps1` and confirm the app has write access to the target site. |
| `404 Not Found` on upload | Create the `-FolderPath` in SharePoint, or use `/` for the library root. |
| Power BI refresh cannot authenticate | Re-enter SharePoint credentials in the semantic model settings and set privacy level to **None**. |
| Agent 365 export returns `403` | Add the Agent 365 licence and permissions, or use `-Agents365Csv <admin-centre-agents-export.csv>`. |
| Refresh hits the 1 GB or 2-hour Power BI Pro limit | Move to [`../1. Fabric/README.md`](../1.%20Fabric/README.md). |

Optional: add Copilot credit consumption with [`Add Credit Consumption/README.md`](Add%20Credit%20Consumption/README.md).