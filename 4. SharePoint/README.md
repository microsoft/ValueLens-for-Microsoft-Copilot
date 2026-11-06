# 4. SharePoint

ValueLens in Power BI Pro, without Fabric. A daily script exports the data to a SharePoint library,
and the Power BI report refreshes from it. The app can read the same CSV files.

[All routes](../README.md#choose-your-path): **4. SharePoint**, **1. Fabric**, **2. Azure**.

**Security and privacy:** file/folder sharing is not row-level security. This route has no
installer-managed scoped RLS or end-to-end user-ID hashing switch. Follow the
[administrator setup guide](../docs/SECURITY-PRIVACY-SETUP.md) before sharing files or a report.

<a id="you-need"></a>

## Before you start

You need Power BI Pro (or PPU/Premium), a report workspace, a SharePoint library/folder,
and a Windows PC for the daily export. That PC needs PowerShell 7.2+, Python 3.10+ and access
to GitHub Releases. Manual setup also needs Power BI Desktop (June 2024+) and an app registration.
An administrator must approve Graph permissions and access to the selected SharePoint site.

[Installer prerequisites](../docs/PREREQUISITES.md#no-fabric-pax--sharepoint-route) ·
[Permissions](../docs/PERMISSIONS.md) · [Data responsibility](../README.md#disclaimer)

<a id="installer"></a>
<a id="let-the-installer-set-it-up"></a>

## Installer

**Work in progress: try a test environment first.**
Follow [Install](../docs/INSTALL.md), choose **Set up ValueLens**, then
**No Fabric: PAX + SharePoint**. Run it on the PC that will run the daily refresh.
It registers the app, guides the administrator's site-access grant, schedules PAX,
publishes the report and can deploy the app. You sign the model in to SharePoint once.

[What it sets up](../installer/README.md#no-fabric-pax--sharepoint-route) ·
[Installer reference](../installer/README.md)

<a id="setup"></a>
<a id="steps"></a>

## Manual

Run every script from PowerShell 7, not Windows PowerShell. Every parameter is in [`scripts/README.md`](scripts/README.md).
Agent 365 is optional: use an Agent 365 licence for `-IncludeAgent365Info`, or an admin center
Agents export for `-Agents365Csv`.

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

4. Seed the interactions file once, in the work folder the scheduled task uses (`C:\AIBV` by default).

   ```powershell
   .\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 30 -WorkRoot 'C:\AIBV'
   ```

   Add `-UserInfoFile <path|SharePoint-URL|OneLake-path>` if you use your own org file; start from the [shared org-data template](../shared/scripts/OrgData-Template.csv). Add `-IncludeAgent365Info` or `-Agents365Csv <admin-centre-agents-export.csv>` for Agent 365. The script writes `C:\AIBV\processed\rollup-manifest.json`.

5. Upload the seeded files to SharePoint.

   ```powershell
   .\Upload-Rollups-SharePoint.ps1 `
       -Manifest 'C:\AIBV\processed\rollup-manifest.json' `
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
   | SharePoint Site URL | The site that holds the optional files, for example `https://<tenant>.sharepoint.com/sites/<site>`, or `https://<tenant>.sharepoint.com` for files in the root site |
   | Agent 365 | Blank, or `https://<tenant>.sharepoint.com/.../agents_365.csv` |
   | Feedback File | Blank, or a SharePoint URL to the admin-centre feedback export |

   The optional files are read through **SharePoint Site URL**, so scheduled refresh works in the Power BI service whether they're blank or set. They must be in that site. Set **SharePoint Site URL** even when both optional files are blank.

7. Select **Load**, then **Publish** to your Power BI workspace.

## Schedule refresh

1. Give the seeded interactions file a stable name, so the daily runs can append to it.

   ```powershell
   Get-ChildItem 'C:\AIBV\processed\*_Interactions_*.csv' | Sort-Object LastWriteTime |
       Select-Object -Last 1 | Rename-Item -NewName 'cumulative_Interactions.csv'
   ```

2. Register the daily Windows Scheduled Task from an elevated PowerShell 7 window.

   ```powershell
   .\Register-TaskScheduler.ps1 `
       -TenantId <tenant-id> -ClientId <client-id> `
       -SiteId '<host>,<siteguid>,<webguid>' `
       -DriveId 'b!...' `
       -FolderPath '/AIBV' `
       -Days 2 `
       -AppendFile cumulative_Interactions.csv `
       -RunAt '02:00'
   ```

   Add `-IncludeAgent365Info`, `-Agents365Csv <admin-centre-agents-export.csv>`, or `-RunAsUser DOMAIN\svc_aibv` if needed. The task name is `AIBV-Rollup-Refresh`; it runs `Run-PAX-AIBV.ps1` and then `Upload-Rollups-SharePoint.ps1`.

3. In Power BI Service, open the semantic model **Settings**. Under **Data source credentials**, sign in to SharePoint (**OAuth2**) for each listed source and set **Privacy level** to **None**. If the tenant-root site URL fails the connection test, tick **Skip test connection** for it. Under **Scheduled refresh**, turn it on and schedule it after the extract, for example extract at `02:00` and refresh at `04:00`.

4. Check or run the scheduled task when needed.

   ```powershell
   Get-ScheduledTaskInfo -TaskName 'AIBV-Rollup-Refresh'
   Start-ScheduledTask -TaskName 'AIBV-Rollup-Refresh'
   ```

   Rotate the secret by rerunning `cmdkey`. For Azure Container Apps or managed-identity scheduling notes, see [`azure-container/README.md`](azure-container/README.md).

## After setup

- **Check it worked.** In the Power BI service, the semantic model's refresh history shows a
  successful refresh, and the report shows your organisation's data.
- **Use the app.** Download `copilot_interactions_rollup.csv`, `copilot_users_rollup.csv` and
  `agents_365.csv` from the SharePoint folder, then load them in [the app](../app/README.md#data).
- **Optional:** add Copilot credit consumption with [Add Credit Consumption](Add%20Credit%20Consumption/README.md).
- **Problems?** See [Troubleshooting](#troubleshooting) below, or
  [open an issue](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues).

---

<a id="troubleshooting"></a>

<details>
<summary><strong>Troubleshooting</strong></summary>

<br>

<sub>Stuck? Create a support file and email it to us: [`scripts/support_file.py`](../scripts/support_file.py).</sub>

| Issue | What to do |
|---|---|
| `pwsh.exe not found` | Install PowerShell 7+ and rerun from `pwsh`. |
| `python: command not found` | Install Python 3.10+ on the machine that runs the extract. |
| `0 records returned` | Check the date window and the app permissions in [`../docs/PERMISSIONS.md`](../docs/PERMISSIONS.md). |
| `403 Forbidden` on upload | Re-run `ProvisionSiteAccess-SP-AppReg.ps1` and confirm the app has write access to the target site. |
| `404 Not Found` on upload | Create the `-FolderPath` in SharePoint, or use `/` for the library root. |
| Power BI refresh cannot authenticate | Re-enter SharePoint credentials in the semantic model settings and set privacy level to **None**. |
| "You can't schedule refresh for this semantic model because the following data sources currently don't support refresh: Data source for Query1" | The model was published from a template older than this fix, which built the feedback file URL in M. Republish from the current `ValueLens - SharePoint.pbit` and set **SharePoint Site URL**, then set credentials for each listed source. |
| Refresh error `FileOutsideSharePointSite` or `MissingSharePointSiteUrl` | Set **SharePoint Site URL** to the https site that holds the `Agent 365` and `Feedback File` files, with no spaces around it. |
| Agent 365 export returns `403` | Add the Agent 365 licence and permissions, or use `-Agents365Csv <admin-centre-agents-export.csv>`. |
| Refresh hits the 1 GB or 2-hour Power BI Pro limit | Move to [`../1. Fabric/README.md`](../1.%20Fabric/README.md). |

</details>
