<#
.SYNOPSIS
  End-to-end PAX → AIBV rollup extractor.

.DESCRIPTION
  Drives Microsoft PAX (Portable Audit eXporter) to pull Copilot interactions +
  Entra user info from a tenant, then runs the AIBV v4.0.0 Python processor to
  produce the two rollup CSVs the AIBV SharePoint PBIT consumes:

    *_Interactions_<timestamp>.csv   (50-col AIBV profile)
    *_Users_<timestamp>.csv          (51-col AIBV profile)

  On first run, this script auto-clones the microsoft/PAX repo into
  <PaxRoot> (default: .\pax\) and pins to the release branch. Subsequent runs
  do `git pull` to stay current.

  Requires:
    - PowerShell 7+  (pwsh)
    - git on PATH
    - python 3.10+  on PATH
    - An Entra app registration in the target tenant with these Microsoft Graph
      Application permissions (admin-consented):
        AuditLogsQuery.Read.All
        Reports.Read.All
        User.Read.All
        Organization.Read.All

.PARAMETER TenantId
  GUID of the target Entra tenant.

.PARAMETER ClientId
  GUID of the app registration in the target tenant.

.PARAMETER ClientSecret
  Secret value for the app registration. If omitted, the script tries (in order):
    1. $env:AIBV_CLIENT_SECRET
    2. Windows Credential Manager target: PAX-AIBV-<TenantId>
    3. Interactive Read-Host -AsSecureString prompt

.PARAMETER Days
  Lookback window in days. Default: 7. PAX partitions the window into 12 h
  chunks and runs up to 10 in parallel.

.PARAMETER WorkRoot
  Working directory. Holds .\pax\ (PAX clone), .\raw\ (PAX output) and
  .\processed\ (v4.0.0 rollup output). Default: current directory.

.PARAMETER PaxBranch
  PAX repo branch to pin. Default: release.

.PARAMETER SkipProcessor
  Stop after PAX (don't run the v4.0.0 processor). The PAX run still emits its
  embedded v3.1.0 rollup CSVs — but those have a 33-col schema, not the 50-col
  AIBV schema the PBIT expects. Use this only for raw-data inspection.

.EXAMPLE
  # First run, secret from prompt:
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid>

.EXAMPLE
  # Scheduled run, secret from env var, 30-day window, work folder on D:
  $env:AIBV_CLIENT_SECRET = '...'
  .\Run-PAX-AIBV.ps1 -TenantId <guid> -ClientId <guid> -Days 30 -WorkRoot D:\AIBV

.NOTES
  Reference: https://github.com/microsoft/PAX
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$TenantId,
  [Parameter(Mandatory = $true)] [string]$ClientId,
  [string]$ClientSecret,
  [int]$Days = 7,
  [string]$WorkRoot = (Get-Location).Path,
  [string]$PaxBranch = 'release',
  [switch]$SkipProcessor
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false  # git/python write to stderr by design

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "PowerShell 7+ required. Run with 'pwsh', not 'powershell'."
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

function Test-Command([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "$name not found on PATH. Install it and retry." }
}

Test-Command git
Test-Command python

$WorkRoot = (Resolve-Path -LiteralPath $WorkRoot).Path
$PaxRoot  = Join-Path $WorkRoot 'pax'
$RawDir   = Join-Path $WorkRoot 'raw'
$ProcDir  = Join-Path $WorkRoot 'processed'
New-Item -ItemType Directory -Force -Path $RawDir, $ProcDir | Out-Null

# ---- 1. Ensure PAX is present + up to date ----
if (-not (Test-Path $PaxRoot)) {
  Write-Host "==> Cloning microsoft/PAX ($PaxBranch) -> $PaxRoot" -ForegroundColor Cyan
  git clone --branch $PaxBranch --depth 1 https://github.com/microsoft/PAX $PaxRoot 2>&1 | Write-Host
} else {
  Write-Host "==> Updating PAX clone in $PaxRoot" -ForegroundColor Cyan
  Push-Location $PaxRoot
  try { git fetch --depth 1 origin $PaxBranch 2>&1 | Write-Host; git checkout $PaxBranch 2>&1 | Write-Host; git reset --hard "origin/$PaxBranch" 2>&1 | Write-Host }
  finally { Pop-Location }
}

$PaxScript = Get-ChildItem -Path $PaxRoot -Filter 'PAX_Purview_Audit_Log_Processor_v*.ps1' -File |
             Sort-Object Name -Descending | Select-Object -First 1
if (-not $PaxScript) { throw "No PAX_Purview_Audit_Log_Processor_v*.ps1 found in $PaxRoot." }

# ---- 2. Resolve secret + window ----
$secret = Resolve-Secret -Provided $ClientSecret -TenantId $TenantId
$StartDate = (Get-Date).AddDays(-$Days).ToString('yyyy-MM-dd')
$EndDate   = (Get-Date).ToString('yyyy-MM-dd')

Write-Host ""
Write-Host "==== PAX run ====" -ForegroundColor Cyan
Write-Host ("Tenant   : {0}" -f $TenantId)
Write-Host ("App      : {0}" -f $ClientId)
Write-Host ("Window   : {0} -> {1} ({2} days)" -f $StartDate, $EndDate, $Days)
Write-Host ("Script   : {0}" -f $PaxScript.Name)
Write-Host ("Raw out  : {0}" -f $RawDir)
Write-Host ""

$paxStart = Get-Date
& $PaxScript.FullName `
    -StartDate           $StartDate `
    -EndDate             $EndDate `
    -Auth                AppRegistration `
    -TenantId            $TenantId `
    -ClientId            $ClientId `
    -ClientSecret        $secret `
    -OutputPath          $RawDir `
    -OutputPathUserInfo  $RawDir `
    -IncludeUserInfo `
    -RollupPlusRaw `
    -Force
$paxElapsed = (Get-Date) - $paxStart
Write-Host ("==> PAX finished in {0:N1} min" -f $paxElapsed.TotalMinutes) -ForegroundColor Green

if ($SkipProcessor) {
  Write-Host "-SkipProcessor set; stopping. Inspect raw output in $RawDir." -ForegroundColor Yellow
  return
}

# ---- 3. Find newest raw Purview + Entra files ----
$rawPurview = Get-ChildItem $RawDir -Filter 'Purview_Audit_UsageActivity_CopilotInteraction_*.csv' |
              Where-Object { $_.Name -notmatch '_Interactions(\.|_)|_Users(\.|_)|_Rollup' } |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
$rawEntra   = Get-ChildItem $RawDir -Filter 'EntraUsers_MAClicensing_*.csv' |
              Where-Object { $_.Name -notmatch '_Interactions(\.|_)|_Users(\.|_)|_Rollup' } |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $rawPurview) { throw "No raw Purview CSV found in $RawDir." }
if (-not $rawEntra)   { throw "No raw Entra CSV found in $RawDir." }

# ---- 4. Run AIBV v4.0.0 processor (richer 50-col schema than PAX's embedded v3.1.0) ----
$processor = Join-Path $PSScriptRoot 'Purview_CopilotInteraction_Processor_v4.0.0.py'
if (-not (Test-Path $processor)) { throw "Processor not found: $processor" }

Write-Host ""
Write-Host "==== v4.0.0 processor (AIBV profile) ====" -ForegroundColor Cyan
Write-Host ("Purview  : {0}" -f $rawPurview.Name)
Write-Host ("Entra    : {0} (combined users+licensing)" -f $rawEntra.Name)
Write-Host ("Out dir  : {0}" -f $ProcDir)
Write-Host ""

$procStart = Get-Date
python $processor `
    --purview $rawPurview.FullName `
    --entra   $rawEntra.FullName `
    -o        $ProcDir
$procElapsed = (Get-Date) - $procStart
Write-Host ("==> Processor finished in {0:N1} s" -f $procElapsed.TotalSeconds) -ForegroundColor Green

# ---- 5. Surface what was produced ----
$interactions = Get-ChildItem $ProcDir -Filter '*_Interactions_*.csv' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$users        = Get-ChildItem $ProcDir -Filter '*_Users_*.csv'        | Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host ""
Write-Host "==== Rollup outputs ====" -ForegroundColor Cyan
if ($interactions) { Write-Host ("  Interactions : {0} ({1:N0} bytes)" -f $interactions.FullName, $interactions.Length) }
if ($users)        { Write-Host ("  Users        : {0} ({1:N0} bytes)" -f $users.FullName, $users.Length) }

# ---- 6. Manifest for the upload step ----
$manifest = [pscustomobject]@{
  generated_utc       = (Get-Date).ToUniversalTime().ToString('o')
  tenant_id           = $TenantId
  window_days         = $Days
  window_start        = $StartDate
  window_end          = $EndDate
  pax_script          = $PaxScript.Name
  pax_elapsed_min     = [math]::Round($paxElapsed.TotalMinutes, 2)
  processor_elapsed_s = [math]::Round($procElapsed.TotalSeconds, 2)
  interactions_csv    = $interactions.FullName
  users_csv           = $users.FullName
}
$manifestPath = Join-Path $ProcDir 'rollup-manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host ""
Write-Host ("Manifest written: {0}" -f $manifestPath) -ForegroundColor Green
Write-Host ""
Write-Host "Next: .\Upload-Rollups-SharePoint.ps1 -Manifest `"$manifestPath`" -SiteId <...> -DriveId <...> -FolderPath /AIBV" -ForegroundColor Yellow
