<#
.SYNOPSIS
  Register Run-PAX-AIBV + Upload-Rollups-SharePoint as a daily Windows Task.

.DESCRIPTION
  Creates a Windows Scheduled Task that runs (in this order):
    1. .\Run-PAX-AIBV.ps1               — extract + process
    2. .\Upload-Rollups-SharePoint.ps1  — push rollups to SharePoint

  The task runs under your interactive Windows account by default (so the
  Credential Manager target PAX-AIBV-<TenantId> is reachable). For a
  service-style run, pass -RunAsUser <DOMAIN\user> and the script will prompt
  for that account's password and register the task to run whether or not
  the user is signed in.

  Idempotent — re-run to update an existing task.

.PARAMETER TaskName
  Display name for the task. Default: AIBV-Rollup-Refresh.

.PARAMETER ScriptsRoot
  Path to the scripts/ folder that contains Run-PAX-AIBV.ps1 and
  Upload-Rollups-SharePoint.ps1. Default: this script's folder.

.PARAMETER WorkRoot
  Where Run-PAX-AIBV.ps1 should put pax/ + raw/ + processed/. Default:
  C:\AIBV.

.PARAMETER TenantId, ClientId
  Entra app reg credentials (forwarded to both scripts). Required.

.PARAMETER SiteId, DriveId
  SharePoint target (forwarded to the upload script). Required. Get these
  once from ProvisionSiteAccess-SP-AppReg.ps1.

.PARAMETER FolderPath
  Subfolder in the SharePoint library. Default: /AIBV.

.PARAMETER Days
  Lookback window for PAX. Default: 7 (sensible for daily incrementals).

.PARAMETER AppendFile
  Interactions CSV to append into on each scheduled run (passed to Run-PAX-AIBV -AppendFile).
  Recommended for the daily task: seed the file once manually with a back-fill run (no -AppendFile),
  then set this so the scheduled runs append only the latest window (de-duplicated). Omit to have the
  task run in non-append mode.

.PARAMETER RunAt
  Local time the task fires daily. Default: 02:00.

.PARAMETER RunAsUser
  Optional. If supplied (e.g. CONTOSO\svc_aibv), task runs under that account
  whether the user is signed in or not. You'll be prompted for the password
  once. Omit to run under your interactive Windows account.

.EXAMPLE
  # Interactive account, daily at 02:00
  .\Register-TaskScheduler.ps1 `
      -TenantId   <guid> `
      -ClientId   <guid> `
      -SiteId     '<host>,<siteguid>,<webguid>' `
      -DriveId    'b!...'

.EXAMPLE
  # Service account, custom time + work folder
  .\Register-TaskScheduler.ps1 `
      -TenantId  <guid> -ClientId <guid> `
      -SiteId    '...'  -DriveId 'b!...' `
      -RunAt     '03:30' `
      -WorkRoot  'D:\AIBV' `
      -RunAsUser 'CONTOSO\svc_aibv'

.NOTES
  Run elevated (right-click PowerShell → Run as administrator). The task
  itself is created in the root Task Scheduler library; remove with
  Unregister-ScheduledTask -TaskName <name> -Confirm:$false.

  The client secret is NOT stored in the task. Both scripts pull it at
  runtime from $env:AIBV_CLIENT_SECRET or the Windows Credential Manager
  target PAX-AIBV-<TenantId>. Stash it once with:
      cmdkey /generic:PAX-AIBV-<tenant-id> /user:app /pass:<client-secret>
#>
[CmdletBinding()]
param(
  [string]$TaskName    = 'AIBV-Rollup-Refresh',
  [string]$ScriptsRoot = $PSScriptRoot,
  [string]$WorkRoot    = 'C:\AIBV',
  [Parameter(Mandatory=$true)] [string]$TenantId,
  [Parameter(Mandatory=$true)] [string]$ClientId,
  [Parameter(Mandatory=$true)] [string]$SiteId,
  [Parameter(Mandatory=$true)] [string]$DriveId,
                                 [string]$FolderPath = '/AIBV',
                                 [int]$Days  = 7,
                                 [string]$AppendFile,
                                 [string]$RunAt = '02:00',
                                 [string]$RunAsUser
)

$ErrorActionPreference = 'Stop'

# Sanity checks
foreach ($s in 'Run-PAX-AIBV.ps1','Upload-Rollups-SharePoint.ps1') {
  $p = Join-Path $ScriptsRoot $s
  if (-not (Test-Path -LiteralPath $p)) { throw "Missing script: $p" }
}
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null

$pwshCmd  = Get-Command pwsh -ErrorAction SilentlyContinue
$pwshPath = if ($pwshCmd) { $pwshCmd.Source } else { $null }
if (-not $pwshPath) { throw "pwsh.exe not found on PATH. Install PowerShell 7+." }

# Build one inline command so both scripts run sequentially in one task action.
# Quoting note: ScheduledTasks doesn't expand variables, so all params are baked into the string.
$extract = "& '$(Join-Path $ScriptsRoot 'Run-PAX-AIBV.ps1')' -TenantId '$TenantId' -ClientId '$ClientId' -Days $Days -WorkRoot '$WorkRoot'"
if ($AppendFile) { $extract += " -AppendFile '$AppendFile'" }
$upload  = "& '$(Join-Path $ScriptsRoot 'Upload-Rollups-SharePoint.ps1')' -Manifest '$WorkRoot\processed\rollup-manifest.json' -TenantId '$TenantId' -ClientId '$ClientId' -SiteId '$SiteId' -DriveId '$DriveId' -FolderPath '$FolderPath'"
$inline  = "$extract; if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }; $upload"

$action = New-ScheduledTaskAction -Execute $pwshPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$inline`""
$trigger  = New-ScheduledTaskTrigger -Daily -At $RunAt
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RunOnlyIfNetworkAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4)

if ($RunAsUser) {
  Write-Host "Registering task '$TaskName' to run as $RunAsUser ..."
  $cred = Get-Credential -UserName $RunAsUser -Message "Password for $RunAsUser (task will run whether user is signed in or not)"
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password `
    -RunLevel Highest -Force | Out-Null
} else {
  $current = "$env:USERDOMAIN\$env:USERNAME"
  Write-Host "Registering task '$TaskName' to run as $current (interactive) ..."
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User $current -RunLevel Highest -Force | Out-Null
}

$task = Get-ScheduledTask -TaskName $TaskName
$next = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
Write-Host ""
Write-Host "==> Task '$TaskName' registered." -ForegroundColor Green
Write-Host ("    State        : {0}" -f $task.State)
Write-Host ("    Next run     : {0}" -f $next)
Write-Host ("    Daily at     : {0}" -f $RunAt)
Write-Host ("    Work folder  : {0}" -f $WorkRoot)
Write-Host ""
Write-Host "Test it once now (synchronously):"
Write-Host "    Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Yellow
Write-Host "    Get-ScheduledTaskInfo -TaskName '$TaskName'  # check LastTaskResult (0 = success)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Remove with:"
Write-Host "    Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" -ForegroundColor DarkGray
