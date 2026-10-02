# Scripts

Quick reference for the scripts in this folder. The folder
[README](../README.md) is the place to start — this file is the parameter
reference.

| Script | What it does | When you run it |
|---|---|---|
| `ProvisionSiteAccess-SP-AppReg.ps1` | Grants your Entra app `Sites.Selected` write access to one SharePoint site. Prints the `SiteId` and `DriveId` the upload script needs. | **Once per site.** |
| `Run-PAX-AIBV.ps1` | Downloads the latest extract tool, runs the AIBV rollup, and drops two rollup CSVs into `.\processed\` (plus the Agent 365 registry CSV with `-IncludeAgent365Info`). | **Every refresh.** |
| `Upload-Rollups-SharePoint.ps1` | Uploads the rollup CSVs (and the registry CSV, when the manifest lists one) to fixed file names in your SharePoint library (overwrites the previous run). | **Every refresh, after the extract.** |
| `Register-TaskScheduler.ps1` | Registers the above two as a single daily Windows Scheduled Task. | **Once, when you want to schedule.** |
| `Get-Agents365Registry.ps1` | Optional. Exports the Agent 365 registry as the canonical 48-column CSV every template's `Agent 365` parameter reads (same shape as the Fabric notebook's `agents_365`). `Run-PAX-AIBV.ps1 -IncludeAgent365Info` calls it for you. | Ad-hoc, or every refresh via the extract. |

> **Looking for the manual Python processor?** It moved to
> [`../../1. Local CSV/scripts/`](../../1.%20Local%20CSV/scripts/) along with the org-data helpers,
> because the manual route is now its own path. `Run-PAX-AIBV.ps1` doesn't use it — PAX embeds the
> same v4.0.0 rollup internally.
>
> Supplying your own org data here via `-UserInfoFile`? The sample template lives at
> [`../../1. Local CSV/scripts/OrgData-Template.csv`](../../1.%20Local%20CSV/scripts/OrgData-Template.csv).

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
    [-IncludeAgent365Info] `
    [-Agent365Source Canonical|PAX] `
    [-Agents365Csv <admin-centre-agents-export.csv>]
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
- `Agents365Registry.csv` (with `-IncludeAgent365Info`)
- `rollup-manifest.json` (paths + timings for the upload step; `agents365_csv` points at the registry,
  or at your `-Agents365Csv` file when the fallback was used)
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

`-IncludeAgent365Info` (optional): exports the Agent 365 registry. By default
(`-Agent365Source Canonical`) the extract runs `Get-Agents365Registry.ps1` after PAX and writes
the canonical 48-column CSV (the same columns as the Fabric notebook, including `Entra Agent ID`,
`Publisher`, `Is Blocked` and `Agent creator UPN`). Auth follows `-Auth`: `AppRegistration`
reuses this run's app and secret (unattended); `WebLogin`, `DeviceCode`, `Credential` and
`Silent` sign in interactively; `ManagedIdentity` falls back to PAX. Requires admin-consented
`CopilotPackages.Read.All` + `Application.Read.All` + `User.Read.All` and an **Agent 365
licence** in the tenant (a missing licence returns `403`). A registry failure prints a warning
and leaves the rollups untouched; the last good `agents_365.csv` in SharePoint stays in place.

`-Agent365Source PAX`: pass `-IncludeAgent365Info` to PAX instead (app-only as of PAX
purview-v1.11.12). Its catalogue has 28 columns and no Entra Agent ID, publisher, blocked flag
or creator, so fewer agents join and the Agent Registry page shows less. The template still
reads it.

`-Agents365Csv <file>` (optional): the **CSV fallback**, matching the Fabric pipeline's API-first
design. With `-IncludeAgent365Info` the file is used only when the API export fails or produces no
file (for example `403` with no Agent 365 licence). Without `-IncludeAgent365Info` it is used
directly, with no API call, which suits tenants without an Agent 365 licence. Point it at the
Microsoft 365 admin centre **Agents** export (or any earlier registry CSV). The manifest records
`agent365_source = CsvFallback`, and the upload lands the file as `agents_365.csv`. A missing
file is a warning only. The script never edits the file, so re-export it when agents change; if
the API works reliably, drop the parameter so an old export can't stand in after a transient
failure.

```powershell
# API first, admin-centre export if the API step fails
.\Run-PAX-AIBV.ps1 -TenantId <id> -ClientId <id> -IncludeAgent365Info -Agents365Csv .\agents.csv
# No Agent 365 licence: CSV only
.\Run-PAX-AIBV.ps1 -TenantId <id> -ClientId <id> -Agents365Csv .\agents.csv
```

### `Get-Agents365Registry.ps1` on its own

```powershell
.\Get-Agents365Registry.ps1 -OutputCsv .\Agents365Registry.csv `
    [-Auth Auto|AppRegistration|Interactive] [-TenantId <id>] [-ClientId <id>] [-ClientSecret <secret>] `
    [-ApiVersion v1.0|beta] [-SkipDetail] [-SkipCreatorResolution] [-AllowEmpty]
```

`Auto` uses the app registration when `-ClientId` is given (secret from `-ClientSecret`,
`$env:AIBV_CLIENT_SECRET`, Credential Manager `PAX-AIBV-<TenantId>`, then a prompt), otherwise an
interactive Graph sign-in. The script refuses to replace an existing
file with an empty snapshot, and `-AllowEmpty` is for an intentional empty first export only.
Point the template's `Agent 365` parameter at the output (Local CSV) or upload it
(SharePoint, Dataverse CSV fallback).

`-UserInfoFile` (optional, BYOD): supply your own user directory CSV instead of pulling it live from
Entra — copy [`OrgData-Template.csv`](../../1.%20Local%20CSV/scripts/OrgData-Template.csv) as a
starting point. `UserPrincipalName`
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
- `agents_365.csv` (only when the manifest's `agents365_csv` is set, or `-Agents365Csv <path>` is passed)

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
    [-IncludeAgent365Info] `
    [-Agents365Csv <admin-centre-agents-export.csv>] `
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

## Moved: the manual extract tools

`Purview_CopilotInteraction_Processor_v4.0.0.py`, `Adapt-OrgFile-To-EntraUsers.py` and
`OrgData-Template.csv` now live in
**[`../../1. Local CSV/scripts/`](../../1.%20Local%20CSV/scripts/)** — with their own parameter
reference — because the manual route is now its own deployment path.

Nothing here depends on them: `Run-PAX-AIBV.ps1` calls Microsoft PAX, which embeds the same v4.0.0
rollup internally.
