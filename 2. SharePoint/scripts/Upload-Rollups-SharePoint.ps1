<#
.SYNOPSIS
  Upload the AIBV rollup CSVs to a SharePoint document library via Graph.

.DESCRIPTION
  Reads the manifest emitted by Run-PAX-AIBV.ps1 (or accepts the two CSVs
  directly), then uploads each to a FIXED name in your SharePoint library:

    copilot_interactions_rollup.csv
    copilot_users_rollup.csv

  Fixed names are intentional: the AIBV PBIT points at single URLs, so each
  upload OVERWRITES the previous file. No folder iteration, no privacy-firewall
  fights at refresh time.

  Auth: uses the same Entra app reg as Run-PAX-AIBV.ps1. The app must have
  the Sites.Selected Graph permission AND a per-site write grant — set up once
  via .\ProvisionSiteAccess-SP-AppReg.ps1.

.PARAMETER Manifest
  Path to rollup-manifest.json (produced by Run-PAX-AIBV.ps1). Use this OR
  the explicit -InteractionsCsv + -UsersCsv pair.

.PARAMETER InteractionsCsv
  Explicit path to the *_Interactions_*.csv. Required if -Manifest not given.

.PARAMETER UsersCsv
  Explicit path to the *_Users_*.csv. Required if -Manifest not given.

.PARAMETER TenantId
.PARAMETER ClientId
.PARAMETER ClientSecret
  Entra app reg credentials. Secret resolution falls back to
  $env:AIBV_CLIENT_SECRET and the Windows Credential Manager target
  "PAX-AIBV-<TenantId>" (same convention as Run-PAX-AIBV.ps1).

.PARAMETER SiteId
  Graph site ID (the long "<host>,<siteGuid>,<webGuid>" form). Printed by
  ProvisionSiteAccess-SP-AppReg.ps1.

.PARAMETER DriveId
  Graph drive ID for the target document library. Also printed by
  ProvisionSiteAccess-SP-AppReg.ps1.

.PARAMETER FolderPath
  Folder within the library, e.g. /AIBV or /Shared Documents/AIBV. Default: /
  (drive root). Must already exist.

.EXAMPLE
  .\Upload-Rollups-SharePoint.ps1 `
      -Manifest .\processed\rollup-manifest.json `
      -TenantId <guid> -ClientId <guid> `
      -SiteId   '<host>,<siteguid>,<webguid>' `
      -DriveId  'b!...' `
      -FolderPath '/AIBV'

.NOTES
  Files >4 MB use a Graph upload session (chunked). The two rollup CSVs in a
  typical 30-day tenant run are well under 4 MB, so the simple PUT path is the
  default; the chunked path kicks in automatically when needed.
#>
[CmdletBinding(DefaultParameterSetName='Manifest')]
param(
  [Parameter(ParameterSetName='Manifest', Mandatory=$true)] [string]$Manifest,
  [Parameter(ParameterSetName='Files',    Mandatory=$true)] [string]$InteractionsCsv,
  [Parameter(ParameterSetName='Files',    Mandatory=$true)] [string]$UsersCsv,
  [Parameter(Mandatory=$true)] [string]$TenantId,
  [Parameter(Mandatory=$true)] [string]$ClientId,
                                 [string]$ClientSecret,
  [Parameter(Mandatory=$true)] [string]$SiteId,
  [Parameter(Mandatory=$true)] [string]$DriveId,
                                 [string]$FolderPath = '/'
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "PowerShell 7+ required." }

# ---- Resolve secret (same convention as Run-PAX-AIBV.ps1) ----
function Resolve-Secret {
  param([string]$Provided, [string]$TenantId)
  if ($Provided) { return $Provided }
  if ($env:AIBV_CLIENT_SECRET) { return $env:AIBV_CLIENT_SECRET }
  try {
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class _AIBVUpCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CR {
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
    $v = [_AIBVUpCred]::Get("PAX-AIBV-$TenantId")
    if ($v) { return $v }
  } catch { }
  $secure = Read-Host -Prompt "Client secret for app $ClientId" -AsSecureString
  return [System.Net.NetworkCredential]::new('', $secure).Password
}

function Get-GraphToken {
  param([string]$TenantId, [string]$ClientId, [string]$ClientSecret)
  $body = @{
    client_id     = $ClientId
    client_secret = $ClientSecret
    scope         = 'https://graph.microsoft.com/.default'
    grant_type    = 'client_credentials'
  }
  $resp = Invoke-RestMethod -Method POST -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" -Body $body
  return $resp.access_token
}

function Invoke-GraphPutCsv {
  param([string]$Token, [string]$DriveId, [string]$FolderPath, [string]$RemoteName, [string]$LocalPath)
  $size = (Get-Item -LiteralPath $LocalPath).Length
  $folder = $FolderPath.Trim('/')
  $itemPath = if ($folder) { "$folder/$RemoteName" } else { $RemoteName }
  $itemPathEnc = ($itemPath -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'

  $headers = @{ Authorization = "Bearer $Token" }

  if ($size -le 4MB) {
    Write-Host ("  PUT  {0} ({1:N0} bytes)" -f $RemoteName, $size)
    $uri = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/$itemPathEnc`:/content"
    Invoke-RestMethod -Method PUT -Uri $uri -Headers $headers `
      -ContentType 'text/csv' -InFile $LocalPath | Out-Null
    return
  }

  # Chunked upload session for >4 MB
  Write-Host ("  Upload session {0} ({1:N0} bytes, chunked)" -f $RemoteName, $size)
  $sessionUri = "https://graph.microsoft.com/v1.0/drives/$DriveId/root:/$itemPathEnc`:/createUploadSession"
  $body = @{ item = @{ '@microsoft.graph.conflictBehavior' = 'replace'; name = $RemoteName } } | ConvertTo-Json -Depth 4
  $session = Invoke-RestMethod -Method POST -Uri $sessionUri -Headers $headers -ContentType 'application/json' -Body $body
  $upUrl = $session.uploadUrl

  $chunk = 5MB
  $fs = [System.IO.File]::OpenRead($LocalPath)
  try {
    $buf = New-Object byte[] $chunk
    $offset = 0
    while ($offset -lt $size) {
      $toRead = [Math]::Min($chunk, $size - $offset)
      $read = $fs.Read($buf, 0, $toRead)
      $endByte = $offset + $read - 1
      $range = "bytes $offset-$endByte/$size"
      $slice = if ($read -eq $buf.Length) { $buf } else { $buf[0..($read-1)] }
      Invoke-RestMethod -Method PUT -Uri $upUrl `
        -Headers @{ 'Content-Range' = $range; 'Content-Length' = $read } `
        -ContentType 'application/octet-stream' -Body $slice | Out-Null
      $offset += $read
    }
  } finally { $fs.Dispose() }
}

# ---- Resolve sources ----
if ($PSCmdlet.ParameterSetName -eq 'Manifest') {
  if (-not (Test-Path -LiteralPath $Manifest)) { throw "Manifest not found: $Manifest" }
  $m = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
  $InteractionsCsv = $m.interactions_csv
  $UsersCsv        = $m.users_csv
}
foreach ($p in @($InteractionsCsv, $UsersCsv)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "CSV not found: $p" }
}

$secret = Resolve-Secret -Provided $ClientSecret -TenantId $TenantId

Write-Host "==== Upload to SharePoint ====" -ForegroundColor Cyan
Write-Host ("Site         : {0}" -f $SiteId)
Write-Host ("Drive        : {0}" -f $DriveId)
Write-Host ("Folder       : {0}" -f $FolderPath)
Write-Host ("Interactions : {0}" -f $InteractionsCsv)
Write-Host ("Users        : {0}" -f $UsersCsv)
Write-Host ""

$token = Get-GraphToken -TenantId $TenantId -ClientId $ClientId -ClientSecret $secret
Invoke-GraphPutCsv -Token $token -DriveId $DriveId -FolderPath $FolderPath `
  -RemoteName 'copilot_interactions_rollup.csv' -LocalPath $InteractionsCsv
Invoke-GraphPutCsv -Token $token -DriveId $DriveId -FolderPath $FolderPath `
  -RemoteName 'copilot_users_rollup.csv'        -LocalPath $UsersCsv

Write-Host ""
Write-Host "==> Upload complete." -ForegroundColor Green
Write-Host "Point the AIBV PBIT parameters at:"
$folderForUrl = $FolderPath.Trim('/')
$base = if ($folderForUrl) { "<sharepoint-site-url>/<library>/$folderForUrl" } else { "<sharepoint-site-url>/<library>" }
Write-Host ("  Copilot Interactions File = {0}/copilot_interactions_rollup.csv" -f $base)
Write-Host ("  Org Data File             = {0}/copilot_users_rollup.csv"        -f $base)
