# Scripts

Quick reference for the scripts in this folder. The folder
[README](../README.md) is the place to start — this file is the parameter
reference.

| Script | What it does | When you run it |
|---|---|---|
| `ProvisionSiteAccess-SP-AppReg.ps1` | Grants your Entra app `Sites.Selected` write access to one SharePoint site. Prints the `SiteId` and `DriveId` the upload script needs. | **Once per site.** |
| `Run-PAX-AIBV.ps1` | Downloads the latest extract tool, runs the AIBV rollup, and drops two rollup CSVs into `.\processed\`. | **Every refresh.** |
| `Upload-Rollups-SharePoint.ps1` | Uploads the two rollup CSVs to fixed file names in your SharePoint library (overwrites the previous run). | **Every refresh, after the extract.** |
| `Register-TaskScheduler.ps1` | Registers the above two as a single daily Windows Scheduled Task. | **Once, when you want to schedule.** |
| `Get-Agents365Registry.ps1` | Optional. Exports the Agents 365 registry for the dashboard's Agents 365 page. | Ad-hoc. |
| `Purview_CopilotInteraction_Processor_v4.0.0.py` | **Manual extract.** Turns a raw Purview audit CSV + an Entra users CSV into the two rollup CSVs the template reads — no scheduling or app registration. | **First run / quick look** (see Option A in the [folder README](../README.md)). |
| `Adapt-OrgFile-To-EntraUsers.py` | Optional helper for the manual extract. Normalises a **custom HR/org export** (any headers/delimiter) into the EntraUsers-shaped `--entra` input the processor expects. | Before the processor, when your org file isn't a standard Entra users export. |
| `OrgData-Template.csv` | Sample **bring-your-own org data** file — copy it, fill in your users, and pass it as `--entra` (manual) or `-UserInfoFile` (automated). Same shape as a Viva Insights org-data export. | When you supply org data yourself instead of Entra. |

---

## `ProvisionSiteAccess-SP-AppReg.ps1`

```powershell
.\ProvisionSiteAccess-SP-AppReg.ps1 `
    -TenantId       "<tenant-id>" `
    -SiteHost       "<tenant>.sharepoint.com" `
    -AppClientId    "<client-id>" `
    -AppDisplayName "<app-name>"
```

---

## `Run-PAX-AIBV.ps1`

```powershell
.\Run-PAX-AIBV.ps1 `
    -TenantId   <tenant-id> `
    -ClientId   <client-id> `
    [-ClientSecret <secret>] `
    [-Days 7] `
    [-WorkRoot .] `
    [-PaxReleaseTag latest] `
    [-Auth AppRegistration|ManagedIdentity|DeviceCode|WebLogin|Credential|Silent] `
    [-RollupPlusRaw] `
    [-AppendFile <interactions.csv>] `
    [-IncludeUserInfo:$false] `
    [-UserInfoFile <path|SharePoint-URL|OneLake-path>] `
    [-Deidentify] `
    [-FillerLabel Blank|RepeatSelf|RepeatManager|Fixed] `
    [-FillerLabelText "<text>"] `
    [-IncludeAgent365Info]
```

Secret resolution (first match wins):
1. `-ClientSecret` param
2. `$env:AIBV_CLIENT_SECRET`
3. Windows Credential Manager target `PAX-AIBV-<TenantId>`
   (`cmdkey /generic:PAX-AIBV-<tenant-id> /user:app /pass:<secret>`)
4. Interactive secure-string prompt

Outputs to `<WorkRoot>\processed\`:
- `<purview-stem>_Interactions_<ts>.csv`
- `<entra-stem>_Users_<ts>.csv`
- `rollup-manifest.json` (paths + timings for the upload step)
The script downloads the selected extract-tool release into `<WorkRoot>\pax\releases\`.
Defaults are `-Auth AppRegistration`, `-Rollup`, and `-IncludeUserInfo`.

**Seed once, then append (interactions)** — `-AppendFile`: the Purview interactions data is a growing
time-series, so run the **first** extract as a **back-fill with no `-AppendFile`** (e.g. `-Days 30`)
to create the file, then have **every scheduled run** use `-AppendFile <that file>` with a short
window (e.g. `-Days 2`). The append de-duplicates on each interaction's
stable message identity, so overlapping days reconcile (nothing dropped or double-counted). Applies
to interactions only; the Users/org and Agent 365 outputs are **snapshots** (overwritten each run).
Keep `-Deidentify` consistent across all appends to the same file.
```powershell
# First run — seed with a back-fill (no -AppendFile)
.\Run-PAX-AIBV.ps1 -TenantId <id> -ClientId <id> -Days 30
# Scheduled runs — append only the latest window
.\Run-PAX-AIBV.ps1 -TenantId <id> -ClientId <id> -Days 2 -AppendFile Purview_CopilotInteraction_Rollup.csv
```

`-IncludeAgent365Info` (optional): produces the Agent 365 catalogue export. It runs
**app-only/unattended** under the same `-Auth` mode (no separate
interactive sign-in). Requires the app's admin-consented **Application** permissions
`CopilotPackages.Read.All` + `Application.Read.All` and an **Agent 365 licence** in the tenant
(a missing licence returns `403`).

`-UserInfoFile` (optional, BYOD): supply your own user directory CSV instead of pulling it live from
Entra — copy [`OrgData-Template.csv`](./OrgData-Template.csv) as a starting point. `UserPrincipalName`
is required (header
aliases `UPN` / `PersonId` also accepted, values must be UPNs not GUIDs); other columns
(DisplayName / Department / Manager / License…) are optional and alias-aware. `HasLicense` must be
the literal word `TRUE` or `FALSE` (`Yes/No`, `1/0` are **not** recognised). The path can be
**local, a SharePoint URL, or a Fabric/OneLake path**. License handling is hybrid — rows with a
license value are used as-is; blanks fall back to a tenant lookup (needs `User.Read.All` +
`Organization.Read.All`), so a run is fully offline only when every row supplies a license.

> **Privacy-restricted tenants:** pair `-UserInfoFile` (no live Entra pull) with `-Deidentify`
> (masks user identities in the output) so no real user IDs land in the report.

**Required CSV schema** (UTF-8, header row):
`UserPrincipalName` (required, key) · `DisplayName`, `Department`, `JobTitle`, `ManagerUpn` (recommended) · `HasLicense` = `TRUE`/`FALSE` (optional) · extra columns pass through. Example header:
```csv
UserPrincipalName,DisplayName,Department,JobTitle,ManagerUpn,HasLicense
```
Full field reference: [`-UserInfoFile` CSV schema (upstream docs)](https://github.com/microsoft/PAX/blob/release/release_documentation/Purview_Audit_Log_Processor/PAX_Purview_Audit_Log_Processor_Documentation_v1.11.x.md#-userinfofile-csv-schema-shareable-reference).

---

## `Upload-Rollups-SharePoint.ps1`

```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -Manifest    .\processed\rollup-manifest.json `
    -TenantId    <tenant-id> `
    -ClientId    <client-id> `
    -SiteId      '<host>,<siteguid>,<webguid>' `
    -DriveId     'b!...' `
    [-FolderPath /AIBV]
```

Uploads as fixed names:
- `copilot_interactions_rollup.csv`
- `copilot_users_rollup.csv`

Or skip the manifest and pass CSVs directly:

```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -InteractionsCsv .\processed\..._Interactions_....csv `
    -UsersCsv        .\processed\..._Users_....csv `
    -TenantId        <tenant-id> -ClientId <client-id> `
    -SiteId          '...' -DriveId '...'
```

---

## `Register-TaskScheduler.ps1`

```powershell
.\Register-TaskScheduler.ps1 `
    -TenantId   <tenant-id> -ClientId <client-id> `
    -SiteId     '<host>,<siteguid>,<webguid>' `
    -DriveId    'b!...' `
    [-FolderPath /AIBV] `
    [-RunAt 02:00] `
    [-RunAsUser DOMAIN\svc_aibv]
```

Run elevated. Removes with:

```powershell
Unregister-ScheduledTask -TaskName 'AIBV-Rollup-Refresh' -Confirm:$false
```

The client secret is **not** stored in the task — both scripts pull it at
runtime via the resolution chain above.

---

## `Purview_CopilotInteraction_Processor_v4.0.0.py`

The **manual** alternative to the automated script. Bring your exports yourself — it produces the same two rollup CSVs
the template reads. Use it for a **first run / quick look** with no app registration or scheduling
(this is **Option A** in the [folder README](../README.md)).

Inputs join on **UPN**: org attributes come from **Entra** (`--entra`), the Copilot **licence** flag
from the **M365 Admin Center** (`--licensing`). Supply them as two files, or pass a single combined
users+licence file as `--entra` and omit `--licensing` (licence column auto-detected).

```bash
python "Purview_CopilotInteraction_Processor_v4.0.0.py" \
    --purview    "<raw_copilot_interactions.csv>" \  # Purview audit export (CopilotInteraction)
    --entra      "<entra_users_org.csv>" \           # Entra users: UPN, department, title, manager
    --licensing  "<m365_copilot_licence_list.csv>" \ # M365 Admin Center; omit if --entra has licence
    --profile    aibv                                # default; ValueLens fact superset
```

Outputs (in `--out-dir`, default = the `--purview` folder):
- `<purview_stem>_Interactions_<ts>.csv` — fact table
- `<entra_stem>_Users_<ts>.csv` — users dim

Point the **`… - SharePoint (Local CSV).pbit`** template at those two files, or upload them to
SharePoint with `Upload-Rollups-SharePoint.ps1` to use the standard template. Run with `--help` for
all options (`--out-dir`, `--with-aggregates`, `--profile aio`). Requires **Python 3.9+**
(`pip install orjson` optional, for faster parsing). Column contract:
[`../../2. Fabric/docs/DATA-DICTIONARY.md`](../../2.%20Fabric/docs/DATA-DICTIONARY.md).

---

## `Adapt-OrgFile-To-EntraUsers.py`

Optional pre-step for the manual extract. The processor's `--entra` input must be in the
**EntraUsers** shape (it joins to the audit log on `userPrincipalName`). If your org/HR export uses
different headers, an employee-ID key, a semicolon delimiter or UTF-16, this adapter maps it into the
expected shape (and can flatten the manager chain into the `Level0..N` hierarchy for org drill-down).

```bash
python "Adapt-OrgFile-To-EntraUsers.py" \
    --in   "<custom_org_export.csv>" \
    --out  "EntraUsers_adapted.csv" \
    --upn-col "<your UPN column>"
# then feed EntraUsers_adapted.csv to the processor's --entra
```

> **Critical:** the `--upn-col` value must be the **same UPN** that appears in the Purview audit log,
> or users won't join and every interaction shows as unmatched. Run with `--help` for the full
> column-mapping options.
