# Checks task-harness.ps1's recorded calls against the real ScheduledTasks module, for
# test_pax_runner.py. Read-only: it imports the module to read its commands' parameters, reads
# Task Scheduler's CIM class definitions, and lists any leftover test tasks. It never registers,
# starts, changes or removes a task.
#   - Each call's parameters must fit one of the real command's parameter sets, with all of that
#     set's mandatory parameters, and enum values must parse as the real enum.
#   - Each property task.ps1 reads from a task, its first action, its principal or its info must
#     exist on the CIM class Task Scheduler returns.
param(
  [Parameter(Mandatory = $true)] [string]$CallsPath,
  [Parameter(Mandatory = $true)] [string]$TaskScript,
  [Parameter(Mandatory = $true)] [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks, Microsoft.PowerShell.Security

$common = @([System.Management.Automation.Cmdlet]::CommonParameters) + @([System.Management.Automation.Cmdlet]::OptionalCommonParameters)
$problems = [System.Collections.Generic.List[string]]::new()
$checkedCalls = [System.Collections.Generic.List[string]]::new()

foreach ($call in @(Get-Content -LiteralPath $CallsPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable)) {
  $command = Get-Command -Name $call.command -CommandType Function, Cmdlet -ErrorAction SilentlyContinue |
    Where-Object { $_.ModuleName -in 'ScheduledTasks', 'Microsoft.PowerShell.Security' } | Select-Object -First 1
  if (-not $command) {
    $problems.Add("$($call.command) isn't in the ScheduledTasks or Microsoft.PowerShell.Security module.")
    continue
  }
  $used = @($call.parameters)
  $shape = '{0} {1}' -f $call.command, (($used | Sort-Object) -join ',')
  $checkedCalls.Add($shape)
  foreach ($name in $used) {
    if (-not $command.Parameters.ContainsKey($name)) { $problems.Add("$($call.command) has no -$name parameter.") }
  }
  $named = @($used | Where-Object { $_ -notin $common })
  $fits = @($command.ParameterSets | Where-Object {
      $setNames = @($_.Parameters.Name)
      $mandatory = @($_.Parameters | Where-Object IsMandatory | ForEach-Object Name)
      (@($named | Where-Object { $_ -notin $setNames }).Count -eq 0) -and (@($mandatory | Where-Object { $_ -notin $named }).Count -eq 0)
    })
  if (-not $fits) { $problems.Add("No parameter set of $($call.command) takes exactly: $($named -join ', ').") }
  foreach ($name in $used) {
    if (-not $command.Parameters.ContainsKey($name)) { continue }
    $value = $call.values[$name]
    $type = $command.Parameters[$name].ParameterType
    if ($type.IsArray) { $type = $type.GetElementType() }
    if ($type -eq [System.Management.Automation.SwitchParameter]) {
      if ($value -isnot [bool]) { $problems.Add("$($call.command) -$name is a switch, but got '$value'.") }
    } elseif ($type.IsEnum) {
      $parsed = $null
      if ($null -eq $value -or -not [enum]::TryParse($type, [string]$value, $true, [ref]$parsed) -or -not [enum]::IsDefined($type, $parsed)) {
        $problems.Add("$($call.command) -$name doesn't accept '$value'. It takes $([enum]::GetNames($type) -join ', ').")
      }
    }
  }
}

# The variables task.ps1 reads properties from, and the class each one holds.
$classes = @{
  task      = 'MSFT_ScheduledTask'
  principal = 'MSFT_TaskPrincipal'
  first     = 'MSFT_TaskExecAction'
  info      = 'MSFT_TaskDynamicInfo'
}
$properties = @{}
foreach ($class in $classes.Values) {
  $properties[$class] = @((Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName $class).CimClassProperties.Name)
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($TaskScript, [ref]$tokens, [ref]$errors)
if ($errors) { $problems.Add("task.ps1 doesn't parse: $($errors[0].Message)") }
$reads = [System.Collections.Generic.List[string]]::new()
$isMember = { $args[0] -is [System.Management.Automation.Language.MemberExpressionAst] }
foreach ($member in $ast.FindAll($isMember, $true)) {
  if ($member.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { continue }
  $target = $member.Expression
  $holder = $null
  if ($target -is [System.Management.Automation.Language.VariableExpressionAst]) {
    $holder = $target.VariablePath.UserPath
  } elseif ($target -is [System.Management.Automation.Language.MemberExpressionAst] -and
    $target.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $target.Expression.VariablePath.UserPath -eq 'task' -and $target.Member.Value -eq 'Principal') {
    $holder = 'principal'
  }
  if (-not $holder -or -not $classes.ContainsKey($holder)) { continue }
  $class = $classes[$holder]
  $reads.Add("$class.$($member.Member.Value)")
  if ($member.Member.Value -notin $properties[$class]) {
    $problems.Add("task.ps1 reads $($member.Extent.Text), but $class has no $($member.Member.Value) property.")
  }
}

$leftover = @(Get-ScheduledTask -TaskName 'PaxRunnerTest-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskPath + $_.TaskName })

$report = [ordered]@{
  calls    = @($checkedCalls | Sort-Object -Unique)
  reads    = @($reads | Sort-Object -Unique)
  leftover = $leftover
  problems = $problems.ToArray()
}
[System.IO.File]::WriteAllText($ResultPath, (ConvertTo-Json -InputObject $report -Depth 5), [System.Text.UTF8Encoding]::new($false))
