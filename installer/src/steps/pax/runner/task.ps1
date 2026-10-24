#Requires -Version 7.2
<#
.SYNOPSIS
  Registers, starts, inspects or removes the daily scheduled task that runs refresh.ps1.

.DESCRIPTION
  The task runs as the current user, only while that user is signed in, with limited rights.
  It needs no administrator rights to register. It never bypasses PowerShell's execution
  policy: Register stops when the policy is AllSigned or Restricted, because the refresh
  scripts aren't signed. A run may take up to 12 hours, because the first one on a large
  tenant reads a month of activity; a run that starts at 02:00 still ends before the next.

  To keep the refresh running while nobody is signed in, an administrator can switch the task
  to "Run whether user is logged on or not" in Task Scheduler. The client secret is in the
  same user's Credential Manager, so the task keeps finding it.

  Every action writes one line of JSON.

.PARAMETER Action
  Register, Unregister, Start or Info.

.PARAMETER TaskName
  The task's name, in the root folder of Task Scheduler.

.PARAMETER ScriptPath
  Register: the installed refresh.ps1.

.PARAMETER ConfigPath
  Register: its refresh.json. The task starts in this file's folder.

.PARAMETER At
  Register: the daily start time, as HH:mm. Default 02:00.

.PARAMETER Pwsh
  Register: pwsh.exe. Default: the pwsh running this script, or its stable app alias when
  that is a Microsoft Store install, whose folder changes with every update.

.PARAMETER Description
  Register: the task's description.

.EXAMPLE
  pwsh -NoProfile -NonInteractive -File .\task.ps1 -Action Register -TaskName 'Product - PAX refresh' -ScriptPath .\refresh.ps1 -ConfigPath ..\refresh.json -At 02:00
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet('Register', 'Unregister', 'Start', 'Info')] [string]$Action,
  [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string]$TaskName,
  [string]$ScriptPath,
  [string]$ConfigPath,
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')] [string]$At = '02:00',
  [string]$Pwsh = [Environment]::ProcessPath,
  [string]$Description
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'Task Scheduler is only available on Windows.'
}
if ($TaskName -match '[\\/]' -or $TaskName -ne $TaskName.Trim()) {
  throw '-TaskName must be a plain name, without folders or surrounding spaces.'
}

$TaskFolder = '\'
$NeverRan = 267011

function Resolve-PwshPath {
  param([string]$Path)
  if ($Path -match '\\WindowsApps\\') {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
    if (Test-Path -LiteralPath $alias) { return $alias }
  }
  return $Path
}

function Format-TaskTime {
  param($Value)
  if ($Value -isnot [datetime] -or $Value.Year -lt 2000) { return $null }
  return $Value.ToUniversalTime().ToString('o')
}

function Get-TaskReport {
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskFolder -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $task) {
    return [ordered]@{ taskName = $TaskName; exists = $false }
  }
  $info = $task | Get-ScheduledTaskInfo
  $first = @($task.Actions) | Select-Object -First 1
  return [ordered]@{
    taskName         = $TaskName
    exists           = $true
    state            = "$($task.State)"
    lastRunTime      = Format-TaskTime $info.LastRunTime
    lastTaskResult   = $info.LastTaskResult
    neverRan         = ($info.LastTaskResult -eq $NeverRan)
    nextRunTime      = Format-TaskTime $info.NextRunTime
    userId           = $task.Principal.UserId
    logonType        = "$($task.Principal.LogonType)"
    runLevel         = "$($task.Principal.RunLevel)"
    execute          = if ($first) { $first.Execute } else { $null }
    arguments        = if ($first) { $first.Arguments } else { $null }
    workingDirectory = if ($first) { $first.WorkingDirectory } else { $null }
  }
}

function Write-Report {
  param($Report)
  $Report | ConvertTo-Json -Compress -Depth 3
}

switch ($Action) {
  'Register' {
    if (-not $ScriptPath -or -not $ConfigPath) { throw 'Register needs -ScriptPath and -ConfigPath.' }
    $policy = Get-ExecutionPolicy
    if ("$policy" -in 'AllSigned', 'Restricted') {
      throw ("PowerShell's execution policy for {0} is {1}, so a scheduled task can't run the refresh scripts, which aren't signed. The installer doesn't bypass the policy. Ask your administrator to allow RemoteSigned for this account (Set-ExecutionPolicy -Scope CurrentUser RemoteSigned), or use a machine that allows it." -f [Environment]::UserName, $policy)
    }
    $script = (Resolve-Path -LiteralPath $ScriptPath).Path
    $configFile = (Resolve-Path -LiteralPath $ConfigPath).Path
    $exe = Resolve-PwshPath $Pwsh
    if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { throw "pwsh.exe wasn't found at '$exe'." }

    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Config "{1}"' -f $script, $configFile
    $taskAction = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory (Split-Path -Parent $configFile)
    $startTime = [datetime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    $trigger = New-ScheduledTaskTrigger -Daily -At $startTime
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 12) -MultipleInstances IgnoreNew
    $register = @{
      TaskName  = $TaskName
      TaskPath  = $TaskFolder
      Action    = $taskAction
      Trigger   = $trigger
      Principal = $principal
      Settings  = $settings
      Force     = $true
    }
    if ($Description) { $register.Description = $Description }
    Register-ScheduledTask @register | Out-Null
    Write-Report (Get-TaskReport)
  }
  'Unregister' {
    $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskFolder -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing) {
      Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskFolder -Confirm:$false
    }
    Write-Report ([ordered]@{ taskName = $TaskName; removed = [bool]$existing })
  }
  'Start' {
    $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskFolder -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $existing) { throw "There's no scheduled task named '$TaskName'. Run the installer's repair to register it again." }
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskFolder
    Write-Report (Get-TaskReport)
  }
  'Info' {
    Write-Report (Get-TaskReport)
  }
}
