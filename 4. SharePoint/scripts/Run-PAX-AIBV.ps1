<#
.SYNOPSIS
  Thin wrapper around the latest PAX AIBV rollup release.

.DESCRIPTION
  Downloads the selected Microsoft PAX release script, runs the built-in AIBV
  rollup pipeline, and leaves the two rollup CSVs the SharePoint PBIT consumes
  in .\processed\. No separate local Python processor is used here. With
  -IncludeAgent365Info it also writes the Agent 365 registry CSV (see below).

.PARAMETER TenantId
  Target Entra tenant GUID.

.PARAMETER ClientId
  App registration client ID in the target tenant.

.PARAMETER ClientSecret
  App registration secret. If omitted, the script tries the environment and
  Windows Credential Manager.

.PARAMETER Days
  Lookback window in days, ending today. Used to derive the PAX start/end date range.
  Ignored when -StartDate and -EndDate are given.

.PARAMETER WorkRoot
  Working directory. Holds the downloaded PAX release cache and processed CSVs.

.PARAMETER PaxReleaseTag
  GitHub release tag to use. Default: latest. The script reads the release's
  -Dashboard values without running it and passes ValueLens (PAX purview-v1.11.15
  and later) or AIBV (v1.11.5 to v1.11.14); both build the same rollup. Releases
  before v1.11.5 have no ValueLens rollup and stop with an error.

.PARAMETER IncludeAgent365Info
  Also export the Agent 365 registry (Copilot agent catalogue) for the template's
  optional "Agent 365" parameter. By default (-Agent365Source Canonical) this runs
  .\Get-Agents365Registry.ps1 after PAX. It writes processed\Agents365Registry.csv
  in the same 48-column shape as the Fabric notebook's dbo.agents_365 (Entra Agent
  ID, Publisher, Is Blocked and the resolved creator UPN included), and the
  manifest records it as agents365_csv, so Upload-Rollups-SharePoint.ps1 uploads
  it as agents_365.csv. Needs admin-consented CopilotPackages.Read.All +
  Application.Read.All + User.Read.All and an Agent 365 licence in the tenant (a
  missing licence returns 403). A registry failure is reported as a warning; the
  rollup CSVs are unaffected. Add -Agents365Csv to fall back to an admin-centre
  export when the API step fails.

.PARAMETER Agents365Csv
  Optional CSV fallback for the Agent 365 registry: the Microsoft 365 admin centre
  Agents export (or any earlier registry CSV). With -IncludeAgent365Info it is
  used only when the API export fails or produces no file (for example 403, no
  Agent 365 licence). Without -IncludeAgent365Info it is used directly, with no
  API call, for tenants without an Agent 365 licence. The manifest then records
  agent365_source = CsvFallback and agents365_csv = this path, so
  Upload-Rollups-SharePoint.ps1 uploads it as agents_365.csv. A missing file is a
  warning, not a failure. Refresh the export yourself; the script never edits it.

.PARAMETER Agent365Source
  Canonical (default): Get-Agents365Registry.ps1, as above. With -Auth
  AppRegistration it reuses this run's app and secret and runs unattended; with
  WebLogin, DeviceCode, Credential or Silent it signs in interactively (delegated).
  The script has no ManagedIdentity mode, so -Auth ManagedIdentity falls back to PAX.
  PAX: pass -IncludeAgent365Info to PAX instead (app-only as of PAX
  purview-v1.11.12; tested with v1.11.14). Its 28-column export has no Entra Agent
  ID, Publisher, Is Blocked or creator columns; the template still reads it.

.PARAMETER Auth
  PAX auth mode. Default: AppRegistration.

.PARAMETER RollupPlusRaw
  Use PAX -RollupPlusRaw instead of the default -Rollup mode.

.PARAMETER AppendFile
  Interactions incremental append (PAX -AppendFile). Filename (resolved in the run's processed
  folder) or full path of the cumulative interactions CSV to append this run's rows into. Leave
  UNSET on the very first run to seed the file with a back-fill window (e.g. -Days 30); set it on
  every subsequent scheduled run (e.g. -Days 2) so PAX appends only the latest window. As of PAX
  purview-v1.11.12 the append de-duplicates on each interaction's stable message identity, so
  overlapping days are reconciled (nothing dropped or double-counted). The file must already exist
  (created by the seed run). Applies to interactions only: the Users file is overwritten unless
  -AppendUserInfo is set too. Keep -Deidentify consistent across all appends to the same file.
  PAX takes an output folder or an append target, not both, so an append run passes PAX the
  target's full path and no -OutputPath. PAX then writes its log and working files next to the
  target.

.PARAMETER IncludeUserInfo
  Include the Users output by default. Pass -IncludeUserInfo:$false to disable.

.PARAMETER UserInfoFile
  BYOD - bring your own user directory (PAX purview-v1.11.12 -UserInfoFile). Path to a CSV of
  users (UserPrincipalName required; DisplayName / Department / Manager / License etc. optional,
  header names are alias-aware) used instead of pulling the directory live from Entra. Drives
  enrichment, org/manager hierarchy, the rolled-up Users dimension, de-identification and upload.
  The path can be local, a SharePoint URL, or a Fabric/OneLake path. License handling is hybrid:
  provided values are used as-is and blanks are resolved online by UPN, so the run is fully offline
  only when every row supplies a license value (a single blank triggers a tenant lookup needing
  User.Read.All + Organization.Read.All). Mutually exclusive with PAX -GroupNames (not used here).

.PARAMETER Deidentify
  Passes the PAX -Deidentify switch.

.PARAMETER FillerLabel
  Optional hierarchy filler mode (Blank, RepeatSelf, RepeatManager, Fixed).

.PARAMETER FillerLabelText
  Label text used when -FillerLabel Fixed is selected.

.PARAMETER ForcePaxDownload
  Re-download the selected PAX release script even if it is already cached.

.PARAMETER PaxSha256
  Expected SHA-256 of the PAX release script, as 64 hex characters. Needs a fixed
  -PaxReleaseTag. The cached or downloaded copy is checked against it, and PAX doesn't run
  if they differ. A cached copy that matches is used without calling GitHub.

.PARAMETER AppendUserInfo
  Users incremental append (PAX -AppendUserInfo). Filename (resolved in the run's processed
  folder) or full path of the cumulative rolled-up Users CSV to merge this run's users into;
  name it like <name>_Users.csv. Users missing from this run are kept, so every user in the
  interactions file still has a Users row. Seed it like -AppendFile: leave it unset on the
  first run, then pass the Users file that run wrote. Use it with -AppendFile, which keeps
  each user's key the same from run to run.

.PARAMETER SkipVersionCheck
  Passes PAX -SkipVersionCheck, which skips PAX's check for a newer release. For scheduled
  runs on a pinned release.

.PARAMETER StartDate
  First day to export, as yyyy-MM-dd. Use it with -EndDate instead of -Days, for example to
  load a long history in shorter windows. PAX reads each date as midnight UTC.

.PARAMETER EndDate
  The day after the last day to export, as yyyy-MM-dd: PAX reads up to, but not including,
  this date. So windows that share a date (2026-09-01 to 2026-09-08, then 2026-09-08 to
  2026-09-15) meet with no gap and no overlap.

.EXAMPLE
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid>

.EXAMPLE
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 30 -IncludeAgent365Info

.EXAMPLE
  # Agent 365 API first, admin-centre export if the API step fails:
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -IncludeAgent365Info -Agents365Csv .\agents.csv

.EXAMPLE
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -UserInfoFile .\users.csv

.EXAMPLE
  # First run - seed the interactions file with a back-fill (no -AppendFile):
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 30
  # Rename the seeded <stem>_Interactions_<timestamp>.csv in .\processed to cumulative_Interactions.csv,
  # then on subsequent scheduled runs append only the latest window:
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 2 -AppendFile cumulative_Interactions.csv

.EXAMPLE
  # A pinned PAX release, appending the Users file too. Seed both first with a run that has
  # neither -Append switch, then rename its two outputs to these names:
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 3 -PaxReleaseTag purview-v1.11.15 `
    -PaxSha256 <sha256> -AppendFile cumulative_Interactions.csv -AppendUserInfo cumulative_Users.csv
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$TenantId,
  [Parameter(Mandatory = $true)] [string]$ClientId,
  [string]$ClientSecret,
  [int]$Days = 7,
  [string]$WorkRoot = (Get-Location).Path,
  [string]$PaxReleaseTag = 'latest',
  [ValidateSet('WebLogin', 'DeviceCode', 'Credential', 'Silent', 'AppRegistration', 'ManagedIdentity')]
  [string]$Auth = 'AppRegistration',
  [switch]$RollupPlusRaw,
  [string]$AppendFile,
  [bool]$IncludeUserInfo = $true,
  [string]$UserInfoFile,
  [switch]$Deidentify,
  [ValidateSet('Blank', 'RepeatSelf', 'RepeatManager', 'Fixed')]
  [string]$FillerLabel,
  [string]$FillerLabelText,
  [switch]$IncludeAgent365Info,
  [ValidateSet('Canonical', 'PAX')]
  [string]$Agent365Source = 'Canonical',
  [string]$Agents365Csv,
  [switch]$ForcePaxDownload,
  [string]$PaxSha256,
  [string]$AppendUserInfo,
  [switch]$SkipVersionCheck,
  [string]$StartDate,
  [string]$EndDate
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "PowerShell 7+ required. Run with 'pwsh', not 'powershell'."
}

if ($FillerLabel -eq 'Fixed' -and -not $FillerLabelText) {
  throw "-FillerLabelText is required when -FillerLabel Fixed is selected."
}

if ($UserInfoFile) {
  # Only validate local paths; SharePoint URLs and Fabric/OneLake paths are resolved by PAX itself.
  $isRemote = $UserInfoFile -match '^(https?://|abfss://|onelake:)'
  if (-not $isRemote -and -not (Test-Path -LiteralPath $UserInfoFile)) {
    throw "-UserInfoFile '$UserInfoFile' not found. Provide a local path, a SharePoint URL, or a Fabric/OneLake path."
  }
}

if ($PaxSha256) {
  if ($PaxSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "-PaxSha256 must be 64 hex characters." }
  if ($PaxReleaseTag -eq 'latest') {
    throw "-PaxSha256 needs a fixed -PaxReleaseTag, such as purview-v1.11.15. 'latest' changes with every PAX release."
  }
}

if ($AppendUserInfo -and -not $IncludeUserInfo) {
  throw "-AppendUserInfo merges the Users file, so it can't be used with -IncludeUserInfo:`$false."
}

$Invariant = [System.Globalization.CultureInfo]::InvariantCulture
if ($StartDate -or $EndDate) {
  if (-not ($StartDate -and $EndDate)) {
    throw "-StartDate and -EndDate go together. Pass both, as yyyy-MM-dd, or neither to use -Days."
  }
  $windowFrom = [datetime]::MinValue
  $windowTo = [datetime]::MinValue
  if (-not [datetime]::TryParseExact($StartDate, 'yyyy-MM-dd', $Invariant, [System.Globalization.DateTimeStyles]::None, [ref]$windowFrom)) {
    throw "-StartDate must be a date as yyyy-MM-dd, such as 2026-09-01. Got '$StartDate'."
  }
  if (-not [datetime]::TryParseExact($EndDate, 'yyyy-MM-dd', $Invariant, [System.Globalization.DateTimeStyles]::None, [ref]$windowTo)) {
    throw "-EndDate must be a date as yyyy-MM-dd, such as 2026-09-08. Got '$EndDate'."
  }
  if ($windowTo -le $windowFrom) {
    throw "-EndDate must be after -StartDate. PAX reads up to, but not including, -EndDate."
  }
  $Days = [int]($windowTo - $windowFrom).TotalDays
}

# PAX exits 0 when its rollup step fails (it only acts on that under -Dashboard AISID), so this
# script reads PAX's log too. These are the lines PAX writes when the rollup fails.
$RollupFailurePattern = 'Rollup: (post-processor (returned non-zero exit code|failed:)|expected (Fact|Users dim) CSV not produced)'

function Find-PaxRollupFailure {
  param([string[]]$Folders, [datetime]$Since)
  foreach ($folder in @($Folders | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { continue }
    $logs = Get-ChildItem -LiteralPath $folder -Filter '*.log' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $Since } | Sort-Object LastWriteTime -Descending
    foreach ($log in $logs) {
      $hit = Select-String -LiteralPath $log.FullName -Pattern $RollupFailurePattern -List -ErrorAction SilentlyContinue
      if ($hit) {
        return [pscustomobject]@{ Line = $hit.Line.Substring($hit.Matches[0].Index).Trim(); Log = $log.FullName }
      }
    }
  }
  return $null
}

function Resolve-Secret {
  param([string]$Provided, [string]$TenantId)
  if ($Provided) { return $Provided }
  if ($env:AIBV_CLIENT_SECRET) { return $env:AIBV_CLIENT_SECRET }
  $credTarget = "PAX-AIBV-$TenantId"
  try {
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class _AIBVCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CR {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName; }
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flag, out IntPtr ptr);
  [DllImport("Advapi32.dll", EntryPoint="CredFree")] public static extern void CredFree(IntPtr cred);
  public static string Get(string target) {
    IntPtr p; if (!CredRead(target, 1u, 0u, out p)) return null;
    try { var c = (CR)Marshal.PtrToStructure(p, typeof(CR));
      return Marshal.PtrToStringUni(c.CredentialBlob, (int)(c.CredentialBlobSize/2)); }
    finally { CredFree(p); } } }
"@ -ErrorAction SilentlyContinue | Out-Null
    $fromCm = [_AIBVCred]::Get($credTarget)
    if ($fromCm) { return $fromCm }
  } catch { }
  $secure = Read-Host -Prompt "Client secret for app $ClientId" -AsSecureString
  return [System.Net.NetworkCredential]::new('', $secure).Password
}

function Get-GitHubRelease {
  param([string]$ReleaseTag)

  $headers = @{
    'User-Agent' = 'Microsoft-Scout'
    'Accept'     = 'application/vnd.github+json'
  }

  $uri = if ($ReleaseTag -eq 'latest') {
    'https://api.github.com/repos/microsoft/PAX/releases/latest'
  } else {
    "https://api.github.com/repos/microsoft/PAX/releases/tags/$ReleaseTag"
  }

  try {
    Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -ErrorAction Stop
  } catch {
    throw "Failed to resolve PAX release '$ReleaseTag': $_"
  }
}

function Get-PaxReleaseScript {
  param(
    [string]$ReleaseTag,
    [string]$CacheRoot,
    [string]$Sha256,
    [switch]$ForceDownload
  )

  # A pinned release whose cached copy matches needs no call to GitHub.
  if ($Sha256 -and -not $ForceDownload) {
    $cached = Get-ChildItem -LiteralPath (Join-Path (Join-Path $CacheRoot 'releases') $ReleaseTag) -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^PAX_Purview_Audit_Log_Processor_v.*\.ps1$' -and (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -eq $Sha256 } |
      Select-Object -First 1
    if ($cached) {
      Write-Host "==> Using cached PAX $ReleaseTag at $($cached.FullName) (SHA-256 matches)" -ForegroundColor Cyan
      return [pscustomobject]@{
        Path = $cached.FullName
        Tag = $ReleaseTag
        Asset = $cached.Name
        Sha256 = $Sha256.ToLowerInvariant()
      }
    }
  }

  $release = Get-GitHubRelease -ReleaseTag $ReleaseTag
  $asset = $release.assets |
    Where-Object { $_.name -match '^PAX_Purview_Audit_Log_Processor_v.*\.ps1$' } |
    Select-Object -First 1

  if (-not $asset) {
    throw "No PAX script asset found in release $($release.tag_name)."
  }

  $releaseRoot = Join-Path $CacheRoot 'releases'
  $tagRoot = Join-Path $releaseRoot $release.tag_name
  $scriptPath = Join-Path $tagRoot $asset.name
  $metaPath = Join-Path $tagRoot 'release.json'

  New-Item -ItemType Directory -Force -Path $tagRoot | Out-Null

  $download = $ForceDownload -or -not (Test-Path -LiteralPath $scriptPath)
  if (-not $download -and $Sha256 -and (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash -ne $Sha256) {
    Write-Host "==> The cached PAX $($release.tag_name) doesn't match the expected SHA-256. Downloading it again." -ForegroundColor Yellow
    $download = $true
  }
  if ($download) {
    Write-Host "==> Downloading PAX $($release.tag_name) -> $scriptPath" -ForegroundColor Cyan
    Invoke-WebRequest -Method Get -Uri $asset.browser_download_url -OutFile $scriptPath -Headers @{ 'User-Agent' = 'Microsoft-Scout' }
  } else {
    Write-Host "==> Using cached PAX $($release.tag_name) at $scriptPath" -ForegroundColor Cyan
  }

  $hash = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Sha256 -and $hash -ne $Sha256) {
    Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
    throw "PAX $($release.tag_name) ($($asset.name)) doesn't match the expected SHA-256, so it wasn't run. Expected $($Sha256.ToLowerInvariant()), got $hash."
  }

  $meta = [pscustomobject]@{
    requested_tag = $ReleaseTag
    resolved_tag  = $release.tag_name
    asset_name    = $asset.name
    asset_url     = $asset.browser_download_url
    sha256        = $hash
    cached_utc    = (Get-Date).ToUniversalTime().ToString('o')
  }
  $meta | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metaPath -Encoding utf8

  [pscustomobject]@{
    Path = $scriptPath
    Tag = $release.tag_name
    Asset = $asset.name
    Sha256 = $hash
  }
}

function Get-PaxDashboardValue {
  # Reads -Dashboard from the PAX script's param block without running it. PAX
  # purview-v1.11.15 renamed the ValueLens rollup's value from AIBV to ValueLens and
  # rejects AIBV; v1.11.5 to v1.11.14 accept only AIBV. Both build the same rollup.
  param([Parameter(Mandatory = $true)] [string]$ScriptPath)

  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$null, [ref]$parseErrors)
  if ($parseErrors) {
    throw "Can't read the PAX script at '$ScriptPath': $($parseErrors[0].Message) Re-download it with -ForcePaxDownload."
  }

  $dashboard = $null
  if ($ast.ParamBlock) {
    $dashboard = $ast.ParamBlock.Parameters |
      Where-Object { $_.Name.VariablePath.UserPath -eq 'Dashboard' } |
      Select-Object -First 1
  }
  if (-not $dashboard) {
    throw "This PAX release has no -Dashboard parameter, so it can't build the ValueLens rollup. Use PAX purview-v1.11.5 or later (-PaxReleaseTag)."
  }

  $validateSet = $dashboard.Attributes |
    Where-Object {
      $_ -is [System.Management.Automation.Language.AttributeAst] -and
      $_.TypeName.Name -match '^(System\.Management\.Automation\.)?ValidateSet(Attribute)?$'
    } |
    Select-Object -First 1
  # Newer prereleases check the value in code instead of a ValidateSet, and take ValueLens.
  if (-not $validateSet) { return 'ValueLens' }

  $accepted = @($validateSet.PositionalArguments |
    Where-Object { $_ -is [System.Management.Automation.Language.StringConstantExpressionAst] } |
    ForEach-Object { $_.Value })
  foreach ($candidate in 'ValueLens', 'AIBV') {
    $match = $accepted | Where-Object { $_ -eq $candidate } | Select-Object -First 1
    if ($match) { return $match }
  }
  throw ("This PAX release's -Dashboard accepts only {0}, so it can't build the ValueLens rollup. Use PAX purview-v1.11.5 or later (-PaxReleaseTag)." -f ($accepted -join ', '))
}

if (-not (Test-Path -LiteralPath $WorkRoot)) {
  New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
}
$WorkRoot = (Resolve-Path -LiteralPath $WorkRoot).Path
$PaxCacheRoot = Join-Path $WorkRoot 'pax'
$OutDir = Join-Path $WorkRoot 'processed'
New-Item -ItemType Directory -Force -Path $PaxCacheRoot, $OutDir | Out-Null

$secret = $null
if ($Auth -eq 'AppRegistration') {
  $secret = Resolve-Secret -Provided $ClientSecret -TenantId $TenantId
} elseif ($ClientSecret) {
  $secret = $ClientSecret
}
if (-not $StartDate) {
  $today = (Get-Date).Date
  $StartDate = $today.AddDays(-$Days).ToString('yyyy-MM-dd', $Invariant)
  $EndDate = $today.ToString('yyyy-MM-dd', $Invariant)
}

$pax = Get-PaxReleaseScript -ReleaseTag $PaxReleaseTag -CacheRoot $PaxCacheRoot -Sha256 $PaxSha256 -ForceDownload:$ForcePaxDownload
$paxDashboard = Get-PaxDashboardValue -ScriptPath $pax.Path

Write-Host ""
Write-Host "==== PAX run ====" -ForegroundColor Cyan
Write-Host ("Tenant   : {0}" -f $TenantId)
Write-Host ("App      : {0}" -f $ClientId)
Write-Host ("Window   : {0} -> {1} ({2} days)" -f $StartDate, $EndDate, $Days)
Write-Host ("Release  : {0} ({1})" -f $pax.Tag, $pax.Asset)
Write-Host ("SHA-256  : {0}" -f $pax.Sha256)
Write-Host ("Dashboard: {0}" -f $paxDashboard)
Write-Host ("Out dir  : {0}" -f $OutDir)
Write-Host ""

$paxStart = Get-Date
$paxParams = @{
  TenantId = $TenantId
  ClientId = $ClientId
  Auth = $Auth
  Dashboard = $paxDashboard
  StartDate = $StartDate
  EndDate = $EndDate
}

if ($secret) {
  $paxParams.ClientSecret = $secret
}

if ($RollupPlusRaw) {
  $paxParams.RollupPlusRaw = $true
} else {
  $paxParams.Rollup = $true
}

# PAX takes -OutputPath or -AppendFile, never both, and reads a bare -AppendFile name against
# -OutputPath. So an append run passes the target's full path and no -OutputPath.
$appendTarget = $null
if ($AppendFile) {
  $appendTarget = [System.IO.Path]::GetFullPath($(if ([System.IO.Path]::IsPathRooted($AppendFile)) { $AppendFile } else { Join-Path $OutDir $AppendFile }))
  $paxParams.AppendFile = $appendTarget
  if (Test-Path -LiteralPath $appendTarget) {
    Write-Host ("Mode     : APPEND interactions -> {0}" -f $appendTarget) -ForegroundColor Cyan
  } else {
    Write-Host ("Mode     : APPEND requested but '{0}' was not found." -f $appendTarget) -ForegroundColor Yellow
    Write-Host "            Seed it first with a back-fill run WITHOUT -AppendFile, then append on subsequent runs." -ForegroundColor DarkGray
  }
} else {
  $paxParams.OutputPath = $OutDir
  Write-Host "Mode     : SEED (no -AppendFile) - creates a fresh interactions file; add -AppendFile on scheduled runs." -ForegroundColor DarkGray
}

# Likewise -OutputPathUserInfo or -AppendUserInfo, never both.
$appendUsersTarget = $null
if ($AppendUserInfo) {
  $appendUsersTarget = [System.IO.Path]::GetFullPath($(if ([System.IO.Path]::IsPathRooted($AppendUserInfo)) { $AppendUserInfo } else { Join-Path $OutDir $AppendUserInfo }))
  $paxParams.IncludeUserInfo = $true
  $paxParams.AppendUserInfo = $appendUsersTarget
  if (Test-Path -LiteralPath $appendUsersTarget) {
    Write-Host ("Users    : APPEND -> {0}" -f $appendUsersTarget) -ForegroundColor Cyan
  } else {
    Write-Host ("Users    : APPEND requested but '{0}' was not found." -f $appendUsersTarget) -ForegroundColor Yellow
    Write-Host "            Seed it first with a run WITHOUT -AppendUserInfo, then append on subsequent runs." -ForegroundColor DarkGray
  }
} elseif ($IncludeUserInfo) {
  $paxParams.IncludeUserInfo = $true
  $paxParams.OutputPathUserInfo = $OutDir
}

if ($UserInfoFile) {
  $paxParams.UserInfoFile = $UserInfoFile
  Write-Host ("Users src : BYOD directory -> {0}" -f $UserInfoFile) -ForegroundColor Cyan
  Write-Host "            (UserPrincipalName required; blank License rows fall back to a tenant lookup needing User.Read.All + Organization.Read.All)." -ForegroundColor DarkGray
}

if ($Deidentify) {
  $paxParams.Deidentify = $true
}

if ($FillerLabel) {
  $paxParams.FillerLabel = $FillerLabel
}

if ($FillerLabelText) {
  $paxParams.FillerLabelText = $FillerLabelText
}

if ($SkipVersionCheck) {
  $paxParams.SkipVersionCheck = $true
}

$agentSource = $null
if ($IncludeAgent365Info) {
  $agentSource = $Agent365Source
  if ($agentSource -eq 'Canonical' -and $Auth -eq 'ManagedIdentity') {
    Write-Host "Agent 365 : Get-Agents365Registry.ps1 has no ManagedIdentity mode - using the PAX catalogue export instead." -ForegroundColor Yellow
    $agentSource = 'PAX'
  }
  if ($agentSource -eq 'PAX') {
    $paxParams.IncludeAgent365Info = $true
    Write-Host ("Agent 365 : PAX catalogue export ON (app-only via -Auth {0}). " -f $Auth) -ForegroundColor Cyan
    Write-Host "            Needs Application perms CopilotPackages.Read.All + Application.Read.All (admin-consented) and an Agent 365 licence (else 403)." -ForegroundColor DarkGray
  } else {
    Write-Host "Agent 365 : registry export ON - Get-Agents365Registry.ps1 runs after PAX (canonical 48-column CSV)." -ForegroundColor Cyan
    Write-Host "            Needs CopilotPackages.Read.All + Application.Read.All + User.Read.All (admin-consented) and an Agent 365 licence (else 403)." -ForegroundColor DarkGray
  }
}

# Each append target's write time, to tell afterwards whether PAX wrote to it. A file system can
# stamp a write slightly earlier than Get-Date, so the run's start time can't tell.
$appendWrittenBefore = @{}
foreach ($path in @($appendTarget, $appendUsersTarget) | Where-Object { $_ }) {
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    $appendWrittenBefore[$path] = (Get-Item -LiteralPath $path).LastWriteTimeUtc
  }
}

& $pax.Path @paxParams
if (-not $?) {
  throw "PAX failed."
}

# A run's own files only: processed\ is reused across runs. Allow for coarse file times.
$freshSince = $paxStart.AddSeconds(-2)
$logFolders = @($OutDir) + @($appendTarget, $appendUsersTarget | Where-Object { $_ } | ForEach-Object { Split-Path -Parent $_ })
$rollupFailure = Find-PaxRollupFailure -Folders $logFolders -Since $freshSince
if ($rollupFailure) {
  throw ("PAX's rollup step failed, though PAX exited 0: {0} PAX's log: {1}" -f $rollupFailure.Line, $rollupFailure.Log)
}

$paxElapsed = (Get-Date) - $paxStart
Write-Host ("==> PAX finished in {0:N1} min" -f $paxElapsed.TotalMinutes) -ForegroundColor Green

# An append run's output is its target. Otherwise take the newest file this run wrote.
if ($appendTarget) {
  $interactions = Get-Item -LiteralPath $appendTarget -ErrorAction SilentlyContinue
  if (-not $interactions) { throw "The interactions file $appendTarget is missing after the run." }
} else {
  $interactions = Get-ChildItem $OutDir -Filter '*_Interactions*.csv' |
    Where-Object { $_.LastWriteTime -ge $freshSince } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $interactions) { throw "PAX wrote no rollup interactions CSV to $OutDir this run. PAX's log there says why." }
}
$users = $null
if ($appendUsersTarget) {
  $users = Get-Item -LiteralPath $appendUsersTarget -ErrorAction SilentlyContinue
  if (-not $users) { throw "The users file $appendUsersTarget is missing after the run." }
} elseif ($IncludeUserInfo) {
  $users = Get-ChildItem $OutDir -Filter '*_Users*.csv' |
    Where-Object { $_.LastWriteTime -ge $freshSince } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $users) { throw "PAX wrote no rollup users CSV to $OutDir this run. PAX's log there says why." }
}

# PAX leaves an append target untouched when it has nothing to add, or when the target is too old
# to merge into safely (it then writes this run's rows to a new file beside it). Its merge failures
# exit 40, which stops this script above.
foreach ($path in @($appendTarget, $appendUsersTarget) | Where-Object { $_ }) {
  if ($appendWrittenBefore.ContainsKey($path) -and (Get-Item -LiteralPath $path).LastWriteTimeUtc -eq $appendWrittenBefore[$path]) {
    Write-Warning ("PAX didn't update {0} this run, so it still holds the earlier data. PAX's log next to it says why." -f $path)
  }
}

$agents365 = $null
if ($agentSource -eq 'Canonical') {
  $registryCsv = Join-Path $OutDir 'Agents365Registry.csv'
  $regParams = @{ OutputCsv = $registryCsv; TenantId = $TenantId }
  if ($Auth -eq 'AppRegistration') {
    $regParams.Auth = 'AppRegistration'
    $regParams.ClientId = $ClientId
    $regParams.ClientSecret = $secret
  } else {
    $regParams.Auth = 'Interactive'
  }
  Write-Host ""
  Write-Host "==== Agent 365 registry ====" -ForegroundColor Cyan
  try {
    & (Join-Path $PSScriptRoot 'Get-Agents365Registry.ps1') @regParams
    $agents365 = Get-Item -LiteralPath $registryCsv
  } catch {
    Write-Warning ("Agent 365 registry export failed: {0}" -f $_.Exception.Message)
    Write-Warning "The rollup CSVs are unaffected; the agent pages load without registry detail until the export succeeds."
  }
} elseif ($agentSource -eq 'PAX') {
  # processed\ is reused across runs, so only accept an export written by this run.
  $agents365 = Get-ChildItem $OutDir -Filter '*Agent*365*.csv' |
    Where-Object { $_.Name -ne 'Agents365Registry.csv' -and $_.LastWriteTime -ge $paxStart } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $agents365) { Write-Warning "PAX -IncludeAgent365Info produced no *Agent*365*.csv in $OutDir during this run." }
}

if (-not $agents365 -and $Agents365Csv) {
  $fallback = Get-Item -LiteralPath $Agents365Csv -ErrorAction SilentlyContinue
  if ($fallback -and -not $fallback.PSIsContainer -and $fallback.Length -gt 0) {
    $agents365 = $fallback
    $agentSource = 'CsvFallback'
    $why = if ($IncludeAgent365Info) { 'the API export did not succeed' } else { '-IncludeAgent365Info not set' }
    Write-Host ("Agent 365 : using CSV fallback ({0}): {1} (last written {2:yyyy-MM-dd HH:mm})" -f $why, $fallback.FullName, $fallback.LastWriteTime) -ForegroundColor Yellow
  } else {
    Write-Warning ("Agent 365 CSV fallback not found or empty: {0}. The agent pages load without registry detail." -f $Agents365Csv)
  }
}

Write-Host ""
Write-Host "==== Rollup outputs ====" -ForegroundColor Cyan
Write-Host ("  Interactions : {0} ({1:N0} bytes)" -f $interactions.FullName, $interactions.Length)
if ($users) {
  Write-Host ("  Users        : {0} ({1:N0} bytes)" -f $users.FullName, $users.Length)
}
if ($agents365) {
  Write-Host ("  Agent 365    : {0} ({1:N0} bytes)" -f $agents365.FullName, $agents365.Length)
}

$manifest = [pscustomobject]@{
  generated_utc      = (Get-Date).ToUniversalTime().ToString('o')
  tenant_id          = $TenantId
  window_days        = $Days
  window_start       = $StartDate
  window_end         = $EndDate
  pax_release_tag    = $pax.Tag
  pax_release_asset  = $pax.Asset
  pax_sha256         = $pax.Sha256
  pax_dashboard      = $paxDashboard
  pax_elapsed_min    = [math]::Round($paxElapsed.TotalMinutes, 2)
  pax_auth_mode      = $Auth
  rollup_mode        = if ($RollupPlusRaw) { 'RollupPlusRaw' } else { 'Rollup' }
  include_userinfo   = [bool]$IncludeUserInfo
  user_info_file     = $UserInfoFile
  append_file        = $appendTarget
  append_mode        = [bool]$AppendFile
  append_user_info   = $appendUsersTarget
  deidentify         = [bool]$Deidentify
  filler_label       = $FillerLabel
  filler_label_text  = $FillerLabelText
  include_agent365   = [bool]$IncludeAgent365Info
  agent365_source    = $agentSource
  agents365_csv      = if ($agents365) { $agents365.FullName } else { $null }
  interactions_csv   = $interactions.FullName
  users_csv          = if ($users) { $users.FullName } else { $null }
}

$manifestPath = Join-Path $OutDir 'rollup-manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host ""
Write-Host ("Manifest written: {0}" -f $manifestPath) -ForegroundColor Green
Write-Host ""
Write-Host "Next: .\Upload-Rollups-SharePoint.ps1 -Manifest `"$manifestPath`" -SiteId <...> -DriveId <...> -FolderPath /AIBV" -ForegroundColor Yellow
