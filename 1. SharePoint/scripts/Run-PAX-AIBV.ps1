<#
.SYNOPSIS
  Thin wrapper around the latest PAX AIBV rollup release.

.DESCRIPTION
  Downloads the selected Microsoft PAX release script, runs the built-in AIBV
  rollup pipeline, and leaves the two rollup CSVs the SharePoint PBIT consumes
  in .\processed\. No separate local Python processor is used here.

.PARAMETER TenantId
  Target Entra tenant GUID.

.PARAMETER ClientId
  App registration client ID in the target tenant.

.PARAMETER ClientSecret
  App registration secret. If omitted, the script tries the environment and
  Windows Credential Manager.

.PARAMETER Days
  Lookback window in days. Used to derive the PAX start/end date range.

.PARAMETER WorkRoot
  Working directory. Holds the downloaded PAX release cache and processed CSVs.

.PARAMETER PaxReleaseTag
  GitHub release tag to use. Default: latest.

.PARAMETER IncludeAgent365Info
  Passes the PAX -IncludeAgent365Info switch so the optional Agent 365 catalogue
  output is produced. As of PAX purview-v1.11.12 the catalogue export honours
  app-only auth (AppRegistration secret/certificate or ManagedIdentity), reusing
  this run's own -Auth mode, so it works unattended - no separate interactive
  sign-in. Requires the app's admin-consented Application permissions
  CopilotPackages.Read.All + Application.Read.All, and an Agent 365 licence in the
  tenant (a missing licence returns 403).

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
  (created by the seed run). Applies to interactions only - the Users snapshot is overwritten, not
  appended. Keep -Deidentify consistent across all appends to the same file.

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

.EXAMPLE
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid>

.EXAMPLE
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 30 -IncludeAgent365Info

.EXAMPLE
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -UserInfoFile .\users.csv

.EXAMPLE
  # First run - seed the interactions file with a back-fill (no -AppendFile):
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 30
  # Subsequent scheduled runs - append only the latest window:
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 2 -AppendFile Purview_CopilotInteraction_Rollup.csv
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
  [switch]$ForcePaxDownload
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
    [switch]$ForceDownload
  )

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

  if ($ForceDownload -or -not (Test-Path -LiteralPath $scriptPath)) {
    Write-Host "==> Downloading PAX $($release.tag_name) -> $scriptPath" -ForegroundColor Cyan
    Invoke-WebRequest -Method Get -Uri $asset.browser_download_url -OutFile $scriptPath -Headers @{ 'User-Agent' = 'Microsoft-Scout' }
  } else {
    Write-Host "==> Using cached PAX $($release.tag_name) at $scriptPath" -ForegroundColor Cyan
  }

  $meta = [pscustomobject]@{
    requested_tag = $ReleaseTag
    resolved_tag  = $release.tag_name
    asset_name    = $asset.name
    asset_url     = $asset.browser_download_url
    cached_utc    = (Get-Date).ToUniversalTime().ToString('o')
  }
  $meta | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metaPath -Encoding utf8

  [pscustomobject]@{
    Path = $scriptPath
    Tag = $release.tag_name
    Asset = $asset.name
  }
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
$StartDate = (Get-Date).AddDays(-$Days).ToString('yyyy-MM-dd')
$EndDate = (Get-Date).ToString('yyyy-MM-dd')

$pax = Get-PaxReleaseScript -ReleaseTag $PaxReleaseTag -CacheRoot $PaxCacheRoot -ForceDownload:$ForcePaxDownload

Write-Host ""
Write-Host "==== PAX run ====" -ForegroundColor Cyan
Write-Host ("Tenant   : {0}" -f $TenantId)
Write-Host ("App      : {0}" -f $ClientId)
Write-Host ("Window   : {0} -> {1} ({2} days)" -f $StartDate, $EndDate, $Days)
Write-Host ("Release  : {0} ({1})" -f $pax.Tag, $pax.Asset)
Write-Host ("Out dir  : {0}" -f $OutDir)
Write-Host ""

$paxStart = Get-Date
$paxParams = @{
  TenantId = $TenantId
  ClientId = $ClientId
  Auth = $Auth
  Dashboard = 'AIBV'
  StartDate = $StartDate
  EndDate = $EndDate
  OutputPath = $OutDir
}

if ($secret) {
  $paxParams.ClientSecret = $secret
}

if ($RollupPlusRaw) {
  $paxParams.RollupPlusRaw = $true
} else {
  $paxParams.Rollup = $true
}

if ($AppendFile) {
  $paxParams.AppendFile = $AppendFile
  # Resolve a bare filename against the processed dir for a friendly pre-check (PAX also validates).
  $appendProbe = if ([System.IO.Path]::IsPathRooted($AppendFile)) { $AppendFile } else { Join-Path $OutDir $AppendFile }
  if (Test-Path -LiteralPath $appendProbe) {
    Write-Host ("Mode     : APPEND interactions -> {0}" -f $AppendFile) -ForegroundColor Cyan
  } else {
    Write-Host ("Mode     : APPEND requested but '{0}' not found in {1}." -f $AppendFile, $OutDir) -ForegroundColor Yellow
    Write-Host "            Seed it first with a back-fill run WITHOUT -AppendFile, then append on subsequent runs." -ForegroundColor DarkGray
  }
} else {
  Write-Host "Mode     : SEED (no -AppendFile) - creates a fresh interactions file; add -AppendFile on scheduled runs." -ForegroundColor DarkGray
}

if ($IncludeUserInfo) {
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

if ($IncludeAgent365Info) {
  $paxParams.IncludeAgent365Info = $true
  Write-Host ("Agent 365 : catalogue export ON (app-only via -Auth {0}). " -f $Auth) -ForegroundColor Cyan
  Write-Host "            Needs Application perms CopilotPackages.Read.All + Application.Read.All (admin-consented) and an Agent 365 licence (else 403)." -ForegroundColor DarkGray
}

& $pax.Path @paxParams
if (-not $?) {
  throw "PAX failed."
}

$paxElapsed = (Get-Date) - $paxStart
Write-Host ("==> PAX finished in {0:N1} min" -f $paxElapsed.TotalMinutes) -ForegroundColor Green

$interactions = Get-ChildItem $OutDir -Filter '*_Interactions*.csv' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$users = $null
if ($IncludeUserInfo) {
  $users = Get-ChildItem $OutDir -Filter '*_Users*.csv' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if (-not $interactions) { throw "No rollup interactions CSV found in $OutDir." }
if ($IncludeUserInfo -and -not $users) { throw "No rollup users CSV found in $OutDir." }

Write-Host ""
Write-Host "==== Rollup outputs ====" -ForegroundColor Cyan
Write-Host ("  Interactions : {0} ({1:N0} bytes)" -f $interactions.FullName, $interactions.Length)
if ($users) {
  Write-Host ("  Users        : {0} ({1:N0} bytes)" -f $users.FullName, $users.Length)
}

$manifest = [pscustomobject]@{
  generated_utc      = (Get-Date).ToUniversalTime().ToString('o')
  tenant_id          = $TenantId
  window_days        = $Days
  window_start       = $StartDate
  window_end         = $EndDate
  pax_release_tag    = $pax.Tag
  pax_release_asset  = $pax.Asset
  pax_elapsed_min    = [math]::Round($paxElapsed.TotalMinutes, 2)
  pax_auth_mode      = $Auth
  rollup_mode        = if ($RollupPlusRaw) { 'RollupPlusRaw' } else { 'Rollup' }
  include_userinfo   = [bool]$IncludeUserInfo
  user_info_file     = $UserInfoFile
  append_file        = $AppendFile
  append_mode        = [bool]$AppendFile
  deidentify         = [bool]$Deidentify
  filler_label       = $FillerLabel
  filler_label_text  = $FillerLabelText
  include_agent365   = [bool]$IncludeAgent365Info
  interactions_csv   = $interactions.FullName
  users_csv          = if ($users) { $users.FullName } else { $null }
}

$manifestPath = Join-Path $OutDir 'rollup-manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host ""
Write-Host ("Manifest written: {0}" -f $manifestPath) -ForegroundColor Green
Write-Host ""
Write-Host "Next: .\Upload-Rollups-SharePoint.ps1 -Manifest `"$manifestPath`" -SiteId <...> -DriveId <...> -FolderPath /AIBV" -ForegroundColor Yellow
