# Scripts

Quick reference for the scripts in this folder. The folder
[README](../README.md) is the place to start — this file is the parameter
reference.

| Script | What it does | When you run it |
|---|---|---|
| `ProvisionSiteAccess-SP-AppReg.ps1` | Grants your Entra app `Sites.Selected` write access to one SharePoint site. Prints the `SiteId` and `DriveId` the upload script needs. | **Once per site.** |
| `Run-PAX-AIBV.ps1` | Downloads the extract tool (the latest release, or one you pin), runs the AIBV rollup, and drops two rollup CSVs into `.\processed\` (plus the Agent 365 registry CSV with `-IncludeAgent365Info`). | **Every refresh.** |
| `Upload-Rollups-SharePoint.ps1` | Uploads the rollup CSVs (and the registry CSV, when the manifest lists one) to fixed file names in your SharePoint library (overwrites the previous run). Can also upload one file you name. | **Every refresh, after the extract.** |
| `Register-TaskScheduler.ps1` | Registers the above two as a single daily Windows Scheduled Task. | **Once, when you want to schedule.** |
| `Get-Agents365Registry.ps1` | Optional. Exports the Agent 365 registry as the canonical 48-column CSV every template's `Agent 365` parameter reads (same shape as the Fabric notebook's `agents_365`). `Run-PAX-AIBV.ps1 -IncludeAgent365Info` calls it for you. | Ad-hoc, or every refresh via the extract. |

> **Looking for the manual Python processor?** It moved to
> [`../../5. Local CSV/scripts/`](../../5.%20Local%20CSV/scripts/) along with the org-data helpers,
> because the manual route is now its own path. `Run-PAX-AIBV.ps1` doesn't use it — PAX embeds the
> same v4.0.0 rollup internally.
>
> Supplying your own org data here via `-UserInfoFile`? The sample template lives at
> [`../../5. Local CSV/scripts/OrgData-Template.csv`](../../5.%20Local%20CSV/scripts/OrgData-Template.csv).

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
    [-StartDate <yyyy-MM-dd> -EndDate <yyyy-MM-dd>] `
    [-WorkRoot .] `
    [-PaxReleaseTag latest] `
    [-PaxSha256 <sha256>] `
    [-SkipVersionCheck] `
    [-Auth AppRegistration|ManagedIdentity|DeviceCode|WebLogin|Credential|Silent] `
    [-RollupPlusRaw] `
    [-AppendFile <interactions.csv>] `
    [-AppendUserInfo <users.csv>] `
    [-IncludeUserInfo:$false] `
    [-UserInfoFile <path|SharePoint-URL|OneLake-path>] `
    [-OnlyUserInfo] `
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
It reads that release's `-Dashboard` values without running it and passes `ValueLens` (PAX v1.11.15
and later) or `AIBV` (v1.11.5 to v1.11.14), which build the same rollup. A release before v1.11.5
stops with an error. The manifest records the value as `pax_dashboard`.
Defaults are `-Auth AppRegistration`, `-Rollup`, and `-IncludeUserInfo`.

**A date range** — `-StartDate` and `-EndDate`, both as `yyyy-MM-dd`, instead of `-Days`. PAX reads
each date as midnight UTC, and reads up to, but not including, `-EndDate`. So windows that share a
date, such as `2026-09-01` to `2026-09-08` and then `2026-09-08` to `2026-09-15`, meet with no gap
and no overlap. Pass both or neither. The installer's refresh uses them to read a long history a
week at a time.

**A failed rollup fails the run.** PAX 1.11.15 can exit 0 when its rollup step fails. So the script
also reads the logs PAX wrote this run, and stops with an error that names PAX's log if they show
the rollup failed. Without `-AppendFile`, it also stops if PAX wrote no new rollup file this run.

**Seed once, then append** — `-AppendFile` and `-AppendUserInfo`: the Purview interactions data is a
growing time-series, so run the **first** extract as a **back-fill with no `-AppendFile`** (e.g.
`-Days 30`), then rename its `<purview-stem>_Interactions_<ts>.csv` to a stable name ending in
`_Interactions.csv`, such as `cumulative_Interactions.csv`. Have **every scheduled run** use
`-AppendFile <that file>` with a short window (e.g. `-Days 2`). The append de-duplicates on each
interaction's stable message identity, so overlapping days reconcile (nothing dropped or
double-counted). A bare file name is read from `<WorkRoot>\processed`, so seed and append with the
same `-WorkRoot`, or pass a full path. PAX takes an output folder or an append target, never both
(v1.11.15 stops if it gets both), so an append run passes PAX only the target's full path, and PAX
writes its log and working files next to the target.

`-AppendUserInfo` does the same for the Users file: rename the seed run's
`<entra-stem>_Users_<ts>.csv` to a name like `cumulative_Users.csv` and pass it. Users missing from
a run are kept. Without it the Users/org output is a **snapshot** (overwritten each run), as the
Agent 365 output always is. Keep `-Deidentify` consistent across all appends to the same file. If
PAX can't merge a run into a target, it leaves the target as it was, and the script warns that PAX
didn't update it.

**Only the user directory** — `-OnlyUserInfo`: one PAX `-OnlyUserInfo` pass, with no audit query,
date window or rollup. It leaves only `EntraUsers_MAClicensing_<ts>.csv` in `.\processed\`, and the
manifest records it as `users_csv`. Each run's file is a whole snapshot of the directory, to replace
the last one rather than add to it. The app needs `User.Read.All` and `Organization.Read.All`, not
`AuditLogsQuery.Read.All`. It can't be used with `-Days`, the date range, `-AppendFile`,
`-AppendUserInfo`, `-RollupPlusRaw` or the Agent 365 parameters. Upload the file with
`Upload-Rollups-SharePoint.ps1 -File <csv> -RemoteName <name>.csv`: the `-Manifest` upload stops on
this run's manifest, which has no rollup. The ValueLens report reads the rollups, so it doesn't use
this mode. It's for dashboards that need only the user directory, such as Consumption Central's
org file.

**Agent type columns.** The PAX rollup does not write `Agent_Type` and the other five
[agent-type columns](../../docs/DATA-DICTIONARY.md#agent-type-and-publisher). The SharePoint template
classifies each row at refresh instead, in Power Query (`ValueLensDescribeAgent`), from `AgentId`,
`AgentName` and `AppIdentity_DisplayName`. The rollup has no `PlatformAgentType` or workload, so a
Copilot Studio agent known only by its platform type lands in **Unclassified agents**, and connected
or third-party AI apps are recognised only by their `AppIdentity` prefix. The Fabric and Local CSV
processors use all five inputs and also accept overrides. If PAX later writes the columns, the
template uses them as they are.
```powershell
# First run — seed with a back-fill (no -AppendFile)
.\Run-PAX-AIBV.ps1 -TenantId <id> -ClientId <id> -Days 30
# Give the seeded interactions file a stable name
Get-ChildItem .\processed\*_Interactions_*.csv | Sort-Object LastWriteTime | Select-Object -Last 1 |
    Rename-Item -NewName cumulative_Interactions.csv
# Scheduled runs — append only the latest window
.\Run-PAX-AIBV.ps1 -TenantId <id> -ClientId <id> -Days 2 -AppendFile cumulative_Interactions.csv
```

**Pinning the extract tool** — `-PaxReleaseTag` and `-PaxSha256`: by default each run downloads the
latest PAX release. For scheduled runs, pin a release and the SHA-256 of its script, so a new
release can't change the output unannounced:

```powershell
.\Run-PAX-AIBV.ps1 -TenantId <id> -ClientId <id> -Days 2 -AppendFile cumulative_Interactions.csv `
    -PaxReleaseTag purview-v1.11.15 `
    -PaxSha256 13a8d41a70c462650207e452eb0ccab274729eb65b0d640bc0a52d6a40ad46c9 `
    -SkipVersionCheck
```

The script checks the cached or downloaded copy against the hash and doesn't run PAX if they differ.
A cached copy that matches is used without calling GitHub. `-SkipVersionCheck` turns off PAX's own
check for a newer release. The manifest records the hash as `pax_sha256`.

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
    [-ApiVersion v1.0|beta] [-SkipDetail] [-FullDetailRefreshDays 7] `
    [-CheckpointEvery 1000] [-ProgressEvery 500] `
    [-SkipCreatorResolution] [-AllowEmpty]
```

**Large tenants.** The first run has no detail cache, so it makes one detail call per agent
(roughly 0.5 s each; the script prints the expected duration and a progress line with an ETA).
Successful calls are checkpointed into `<OutputCsv>.detailcache.jsonl` every `-CheckpointEvery`
calls and again if the run fails or is stopped, so **rerun the same command** after a failure and
only the agents still missing are fetched. Network timeouts, dropped connections, 429 and 5xx are
retried; 404 and 424 *Failed Dependency* are not. An agent whose detail call fails and that has no
cached detail is written list-only (usage, Bot Id and capability columns blank) and retried next
run, however many there are; the script prints a warning counting them by reason, for example
`missing (HTTP 424) x312`. Only if every detail call failed with 401 or 403 and nothing is cached
does the run stop, leaving the existing CSV in place, because that means sign-in or consent is
broken.

`Auto` uses the app registration when `-ClientId` is given (secret from `-ClientSecret`,
`$env:AIBV_CLIENT_SECRET`, Credential Manager `PAX-AIBV-<TenantId>`, then a prompt), otherwise an
interactive Graph sign-in. The script refuses to replace an existing
file with an empty snapshot, and `-AllowEmpty` is for an intentional empty first export only.
Point the template's `Agent 365` parameter at the output (Local CSV) or upload it
(SharePoint, or the archived Dataverse path's CSV fallback).

`-UserInfoFile` (optional, BYOD): supply your own user directory CSV instead of pulling it live from
Entra — copy [`OrgData-Template.csv`](../../5.%20Local%20CSV/scripts/OrgData-Template.csv) as a
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

Or upload one file, under its own name or the name you give with `-RemoteName`:

```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -File       .\agents.csv `
    -RemoteName agents_365.csv `
    -TenantId   <tenant-id> -ClientId <client-id> `
    -SiteId     '...' -DriveId '...' `
    [-FolderPath /AIBV]
```

`-RemoteName` must be a file name, not a path. A `.csv` file uploads as `text/csv`, anything else
as `application/octet-stream`.

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
**[`../../5. Local CSV/scripts/`](../../5.%20Local%20CSV/scripts/)** — with their own parameter
reference — because the manual route is now its own deployment path.

Nothing here depends on them: `Run-PAX-AIBV.ps1` calls Microsoft PAX, which embeds the same v4.0.0
rollup internally.
