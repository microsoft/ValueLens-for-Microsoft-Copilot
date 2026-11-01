# Runs task.ps1 in-process against stand-ins for the ScheduledTasks module, for
# test_pax_runner.py. No scheduled task is registered, started or removed:
#   - The module's commands are global functions here, which PowerShell runs in place of the
#     module's own functions. The module is never imported: importing it would replace them.
#   - Module autoloading is off, so a command without a stand-in fails instead of reaching
#     Task Scheduler. Each scenario checks this before and after it runs.
#   - Get-ExecutionPolicy reports the policy a scenario asks for.
# Every call's parameter names and plain values are recorded, so task-check.ps1 can confirm,
# in another process, that the real module accepts them.
# WorkPath gets a stand-in refresh.ps1, refresh.json and pwsh.exe, and a LOCALAPPDATA folder
# with the Microsoft Store's pwsh alias.
param(
  [Parameter(Mandatory = $true)] [string]$TaskScript,
  [Parameter(Mandatory = $true)] [string]$WorkPath,
  [Parameter(Mandatory = $true)] [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility
$PSModuleAutoLoadingPreference = 'None'

$global:HarnessPolicy = 'RemoteSigned'
$global:HarnessTasks = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
$global:HarnessCalls = [System.Collections.Generic.List[object]]::new()
# Task Scheduler reports this time, with result 267011, for a task that has never run.
$global:HarnessNeverRan = [datetime]::new(1999, 11, 30, 0, 0, 0, [System.DateTimeKind]::Local)
$global:HarnessNextRun = [datetime]::new(2026, 1, 16, 2, 0, 0, [System.DateTimeKind]::Local)
$global:HarnessLastRun = [datetime]::new(2026, 1, 15, 2, 0, 0, [System.DateTimeKind]::Local)

function global:Add-HarnessCall {
  param([string]$Command, [System.Collections.IDictionary]$Bound)
  $values = [ordered]@{}
  foreach ($key in $Bound.Keys) {
    $value = $Bound[$key]
    $values[$key] = if ($value -is [System.Management.Automation.SwitchParameter]) {
      $value.IsPresent
    } elseif ($value -is [string] -or $value -is [System.ValueType]) {
      [string]$value
    } else {
      $null
    }
  }
  $global:HarnessCalls.Add([ordered]@{ command = $Command; parameters = @($Bound.Keys); values = $values })
}

function global:Get-HarnessKey {
  param([string]$TaskPath, [string]$TaskName)
  return "$TaskPath|$TaskName"
}

function global:Get-ExecutionPolicy {
  [CmdletBinding()]
  param()
  Add-HarnessCall 'Get-ExecutionPolicy' $PSBoundParameters
  return $global:HarnessPolicy
}

function global:New-ScheduledTaskAction {
  [CmdletBinding()]
  param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
  Add-HarnessCall 'New-ScheduledTaskAction' $PSBoundParameters
  return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}

function global:New-ScheduledTaskTrigger {
  [CmdletBinding()]
  param([switch]$Daily, [datetime]$At)
  Add-HarnessCall 'New-ScheduledTaskTrigger' $PSBoundParameters
  return [pscustomobject]@{ Daily = $Daily.IsPresent; At = $At.ToString('HH:mm', [cultureinfo]::InvariantCulture) }
}

function global:New-ScheduledTaskPrincipal {
  [CmdletBinding()]
  param([string]$UserId, [string]$LogonType, [string]$RunLevel)
  Add-HarnessCall 'New-ScheduledTaskPrincipal' $PSBoundParameters
  return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}

function global:New-ScheduledTaskSettingsSet {
  [CmdletBinding()]
  param(
    [switch]$StartWhenAvailable,
    [switch]$AllowStartIfOnBatteries,
    [switch]$DontStopIfGoingOnBatteries,
    [switch]$RunOnlyIfNetworkAvailable,
    [timespan]$ExecutionTimeLimit,
    [string]$MultipleInstances
  )
  Add-HarnessCall 'New-ScheduledTaskSettingsSet' $PSBoundParameters
  return [pscustomobject]@{
    StartWhenAvailable         = $StartWhenAvailable.IsPresent
    AllowStartIfOnBatteries    = $AllowStartIfOnBatteries.IsPresent
    DontStopIfGoingOnBatteries = $DontStopIfGoingOnBatteries.IsPresent
    RunOnlyIfNetworkAvailable  = $RunOnlyIfNetworkAvailable.IsPresent
    ExecutionTimeLimit         = $ExecutionTimeLimit.ToString()
    MultipleInstances          = $MultipleInstances
  }
}

function global:Register-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$TaskPath, $Action, $Trigger, $Principal, $Settings, [switch]$Force, [string]$Description)
  Add-HarnessCall 'Register-ScheduledTask' $PSBoundParameters
  $key = Get-HarnessKey $TaskPath $TaskName
  if ($global:HarnessTasks.ContainsKey($key) -and -not $Force) { throw "Harness: the task $TaskName already exists." }
  $task = [pscustomobject]@{
    TaskName    = $TaskName
    TaskPath    = $TaskPath
    State       = 'Ready'
    Description = $Description
    Actions     = @($Action)
    Triggers    = @($Trigger)
    Principal   = $Principal
    Settings    = $Settings
    Info        = [pscustomobject]@{ LastRunTime = $global:HarnessNeverRan; LastTaskResult = 267011; NextRunTime = $global:HarnessNextRun }
  }
  $global:HarnessTasks[$key] = $task
  return $task
}

function global:Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$TaskPath)
  Add-HarnessCall 'Get-ScheduledTask' $PSBoundParameters
  $key = Get-HarnessKey $TaskPath $TaskName
  if ($global:HarnessTasks.ContainsKey($key)) { return $global:HarnessTasks[$key] }
  # The real command writes this error, which -ErrorAction SilentlyContinue hides.
  Write-Error -Message "No MSFT_ScheduledTask objects found with property 'TaskName' equal to '$TaskName'." -Category ObjectNotFound
}

function global:Get-ScheduledTaskInfo {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true, ValueFromPipeline = $true)] $InputObject)
  process {
    Add-HarnessCall 'Get-ScheduledTaskInfo' $PSBoundParameters
    $InputObject.Info
  }
}

function global:Unregister-ScheduledTask {
  # Like the real command, this asks for confirmation unless -Confirm:$false is passed, and
  # asking fails in a non-interactive session.
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
  param([string]$TaskName, [string]$TaskPath)
  Add-HarnessCall 'Unregister-ScheduledTask' $PSBoundParameters
  $key = Get-HarnessKey $TaskPath $TaskName
  if (-not $global:HarnessTasks.ContainsKey($key)) { throw "Harness: there's no task $TaskName to remove." }
  if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister')) { [void]$global:HarnessTasks.Remove($key) }
}

function global:Start-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$TaskPath)
  Add-HarnessCall 'Start-ScheduledTask' $PSBoundParameters
  $key = Get-HarnessKey $TaskPath $TaskName
  if (-not $global:HarnessTasks.ContainsKey($key)) { throw "Harness: there's no task $TaskName to start." }
  $global:HarnessTasks[$key].State = 'Running'
}

$harnessMocks = 'Get-ExecutionPolicy', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskPrincipal',
'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask', 'Get-ScheduledTask', 'Get-ScheduledTaskInfo',
'Unregister-ScheduledTask', 'Start-ScheduledTask'

function Assert-HarnessSafe {
  if (Get-Module -Name ScheduledTasks) { throw 'SAFETY: the ScheduledTasks module is loaded, so a real task could change.' }
  if ($PSModuleAutoLoadingPreference -ne 'None') { throw 'SAFETY: module autoloading is on.' }
  foreach ($harnessMock in $harnessMocks) {
    $harnessFound = @(Get-Command -Name $harnessMock -ErrorAction SilentlyContinue)
    if ($harnessFound.Count -ne 1 -or $harnessFound[0].CommandType -ne 'Function' -or $harnessFound[0].ModuleName) {
      throw "SAFETY: $harnessMock doesn't resolve to the harness's stand-in."
    }
  }
}

$harnessScenarios = [System.Collections.Generic.List[object]]::new()

function Invoke-Scenario {
  param([string]$Name, [hashtable]$Arguments, [string]$Policy = 'RemoteSigned')
  Assert-HarnessSafe
  $global:HarnessPolicy = $Policy
  $global:HarnessCalls.Clear()
  $harnessOutput = $null
  $harnessFailure = $null
  try {
    $harnessOutput = (& $TaskScript @Arguments | Out-String).Trim()
  } catch {
    $harnessFailure = $_.Exception.Message
  }
  Assert-HarnessSafe
  $harnessKey = Get-HarnessKey '\' $Arguments.TaskName
  $harnessSnapshot = $null
  if ($global:HarnessTasks.ContainsKey($harnessKey)) {
    $harnessSnapshot = $global:HarnessTasks[$harnessKey] | ConvertTo-Json -Depth 6 | ConvertFrom-Json -AsHashtable
  }
  $harnessScenarios.Add([ordered]@{
      name     = $Name
      taskName = $Arguments.TaskName
      output   = $harnessOutput
      error    = $harnessFailure
      task     = $harnessSnapshot
      calls    = @($global:HarnessCalls)
    })
}

# The work folder's name has a space, as most install paths do.
New-Item -ItemType Directory -Force -Path $WorkPath | Out-Null
$harnessWork = (Resolve-Path -LiteralPath $WorkPath).Path
$harnessLocal = Join-Path $harnessWork 'localappdata'
$harnessEmptyLocal = Join-Path $harnessWork 'empty localappdata'
New-Item -ItemType Directory -Force -Path (Join-Path $harnessLocal 'Microsoft\WindowsApps'), $harnessEmptyLocal | Out-Null
$harnessScript = Join-Path $harnessWork 'refresh.ps1'
$harnessConfig = Join-Path $harnessWork 'refresh.json'
$harnessPwsh = Join-Path $harnessWork 'pwsh.exe'
$harnessAlias = Join-Path $harnessLocal 'Microsoft\WindowsApps\pwsh.exe'
foreach ($harnessFile in $harnessScript, $harnessConfig, $harnessPwsh, $harnessAlias) {
  [System.IO.File]::WriteAllText($harnessFile, '')
}
# A Microsoft Store install's versioned folder, which doesn't exist here.
$harnessStorePwsh = 'C:\Program Files\WindowsApps\Microsoft.PowerShell_0.0.1.0_x64__8wekyb3d8bbwe\pwsh.exe'
$harnessMissingPwsh = Join-Path $harnessWork 'nowhere\pwsh.exe'

$harnessName = 'PaxRunnerTest-' + [guid]::NewGuid().ToString('N')
$harnessOther = $harnessName + '-other'
$harnessRealLocal = $env:LOCALAPPDATA

function New-RegisterArguments {
  param([string]$TaskName, [hashtable]$Extra = @{})
  $harnessArguments = @{ Action = 'Register'; TaskName = $TaskName; ScriptPath = $harnessScript; ConfigPath = $harnessConfig; Pwsh = $harnessPwsh }
  foreach ($harnessKey in $Extra.Keys) {
    if ($null -eq $Extra[$harnessKey]) { $harnessArguments.Remove($harnessKey) } else { $harnessArguments[$harnessKey] = $Extra[$harnessKey] }
  }
  return $harnessArguments
}

Invoke-Scenario 'register-ok' (New-RegisterArguments $harnessName @{ Description = 'Test refresh' })
Invoke-Scenario 'info-never-ran' @{ Action = 'Info'; TaskName = $harnessName }
$harnessTask = $global:HarnessTasks[(Get-HarnessKey '\' $harnessName)]
$harnessTask.Info.LastRunTime = $global:HarnessLastRun
$harnessTask.Info.LastTaskResult = 0
Invoke-Scenario 'info-ran' @{ Action = 'Info'; TaskName = $harnessName }
Invoke-Scenario 'start-present' @{ Action = 'Start'; TaskName = $harnessName }
Invoke-Scenario 'start-missing' @{ Action = 'Start'; TaskName = $harnessOther }
Invoke-Scenario 'info-missing' @{ Action = 'Info'; TaskName = $harnessOther }
Invoke-Scenario 'policy-allsigned' (New-RegisterArguments $harnessOther) -Policy 'AllSigned'
Invoke-Scenario 'policy-restricted' (New-RegisterArguments $harnessOther) -Policy 'Restricted'
Invoke-Scenario 'missing-script' (New-RegisterArguments $harnessOther @{ ScriptPath = $null })
Invoke-Scenario 'missing-config' (New-RegisterArguments $harnessOther @{ ConfigPath = $null })
Invoke-Scenario 'missing-pwsh' (New-RegisterArguments $harnessOther @{ Pwsh = $harnessMissingPwsh })
Invoke-Scenario 'folder-name' @{ Action = 'Info'; TaskName = 'Folder\Task' }
Invoke-Scenario 'padded-name' @{ Action = 'Info'; TaskName = ' Padded' }
Invoke-Scenario 'bad-time' (New-RegisterArguments $harnessOther @{ At = '25:00' })
Invoke-Scenario 'bad-action' @{ Action = 'Delete'; TaskName = $harnessOther }
try {
  $env:LOCALAPPDATA = $harnessLocal
  Invoke-Scenario 'store-alias' (New-RegisterArguments ($harnessName + '-alias') @{ Pwsh = $harnessStorePwsh; At = '23:30' })
  $env:LOCALAPPDATA = $harnessEmptyLocal
  Invoke-Scenario 'store-no-alias' (New-RegisterArguments $harnessOther @{ Pwsh = $harnessStorePwsh })
} finally {
  $env:LOCALAPPDATA = $harnessRealLocal
}
Invoke-Scenario 'default-pwsh' (New-RegisterArguments ($harnessName + '-default') @{ Pwsh = $null })
Invoke-Scenario 're-register' (New-RegisterArguments $harnessName @{ At = '04:15' })
Invoke-Scenario 'unregister-present' @{ Action = 'Unregister'; TaskName = $harnessName }
Invoke-Scenario 'unregister-missing' @{ Action = 'Unregister'; TaskName = $harnessName }

$harnessResult = [ordered]@{
  identity     = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  userName     = [Environment]::UserName
  processPath  = [Environment]::ProcessPath
  localAppData = $harnessRealLocal
  taskName     = $harnessName
  otherName    = $harnessOther
  paths        = [ordered]@{
    work        = $harnessWork
    script      = $harnessScript
    config      = $harnessConfig
    pwsh        = $harnessPwsh
    alias       = $harnessAlias
    storePwsh   = $harnessStorePwsh
    missingPwsh = $harnessMissingPwsh
  }
  lastRunUtc   = $global:HarnessLastRun.ToUniversalTime().ToString('o')
  nextRunUtc   = $global:HarnessNextRun.ToUniversalTime().ToString('o')
  remaining    = @($global:HarnessTasks.Keys | Sort-Object)
  scenarios    = $harnessScenarios.ToArray()
}
[System.IO.File]::WriteAllText($ResultPath, (ConvertTo-Json -InputObject $harnessResult -Depth 10), [System.Text.UTF8Encoding]::new($false))
