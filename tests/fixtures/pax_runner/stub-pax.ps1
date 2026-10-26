# Stub Run-PAX-AIBV.ps1 body. test_pax_runner.py puts the real script's param block before it,
# so refresh.ps1's child command line binds exactly as it would to the real script. The stub
# writes rows the way PAX does, then picks its outputs and writes rollup-manifest.json the
# way the real script does. Its picks don't check that a file is new, so the runner's own
# check is what keeps an earlier run's file out. STUB_MODE picks the behaviour:
#   (unset)       appends a row to each target, or writes a first run's files. With
#                 -OnlyUserInfo it writes the user directory alone, as PAX does: a
#                 userPrincipalName column and one row, or STUB_USER_CSV's text when that's
#                 set, with {row} as the run's row. STUB_USER_CSV=<empty> writes an empty file
#   zero          prints PAX's zero-row lines and writes nothing
#   stale         writes nothing
#   users-stale   writes the interactions only
#   fail          prints "Exit code: $env:STUB_PAX_EXIT" and fails as the real script does
#   rollup-fail   prints PAX's failed-rollup line, then fails as the real script does when it
#                 finds that line in PAX's log
#   rollup-exit0  prints PAX's failed-rollup line and exits 0, as a script that doesn't read
#                 PAX's log would
# STUB_MODES, a comma-separated list, sets the mode for each PAX call in a run in turn. An
# empty item, or a call past the list's end, uses STUB_MODE.
$ErrorActionPreference = 'Stop'

$call = 1
if (Test-Path -LiteralPath $env:STUB_PAX_LOG) {
  $runPrefix = '{"run":"' + $env:STUB_RUN + '"'
  $call += @(Get-Content -LiteralPath $env:STUB_PAX_LOG | Where-Object { $_.StartsWith($runPrefix) }).Count
}
$behaviour = $env:STUB_MODE
if ($env:STUB_MODES) {
  $modes = @($env:STUB_MODES -split ',')
  if ($call -le $modes.Count -and $modes[$call - 1].Trim()) { $behaviour = $modes[$call - 1].Trim() }
}

$bound = [ordered]@{}
foreach ($key in $PSBoundParameters.Keys) { $bound[$key] = [string]$PSBoundParameters[$key] }
[ordered]@{
  run      = $env:STUB_RUN
  params   = $bound
  argv     = @([Environment]::GetCommandLineArgs())
  secretOk = ($env:AIBV_CLIENT_SECRET -ceq 'stub-secret')
} | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $env:STUB_PAX_LOG -Encoding utf8

$mode = if ($OnlyUserInfo) { 'only-user-info' } elseif ($AppendFile) { 'append' } else { 'seed' }
$span = if ($OnlyUserInfo) { 'no window' } elseif ($StartDate) { "$StartDate to $EndDate" } else { "$Days days" }
Write-Host "Stub PAX: run $env:STUB_RUN, call $call, $span, mode $mode, behaviour $(if ($behaviour) { $behaviour } else { 'rows' })"

if (-not (Test-Path -LiteralPath $WorkRoot)) { New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null }
$WorkRoot = (Resolve-Path -LiteralPath $WorkRoot).Path
$OutDir = Join-Path $WorkRoot 'processed'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$appendTarget = $null
if ($AppendFile) {
  $appendTarget = [System.IO.Path]::GetFullPath($(if ([System.IO.Path]::IsPathRooted($AppendFile)) { $AppendFile } else { Join-Path $OutDir $AppendFile }))
}
$appendUsersTarget = $null
if ($AppendUserInfo) {
  $appendUsersTarget = [System.IO.Path]::GetFullPath($(if ([System.IO.Path]::IsPathRooted($AppendUserInfo)) { $AppendUserInfo } else { Join-Path $OutDir $AppendUserInfo }))
}
$stamp = (Get-Date).ToString('yyyyMMdd_HHmmss_fff')
# A window's rows name its start, so a test can see which windows reached the files.
$row = if ($StartDate) { "row-from-run-$env:STUB_RUN-$StartDate" } else { "row-from-run-$env:STUB_RUN" }
$rollupLine = 'Rollup: post-processor returned non-zero exit code 1. Raw CSV(s) preserved.'

switch ($behaviour) {
  'fail' {
    Write-Host "Exit code: $env:STUB_PAX_EXIT"
    throw 'PAX failed.'
  }
  'rollup-fail' {
    Write-Host "[ERROR] $rollupLine"
    throw ("PAX's rollup step failed, though PAX exited 0: {0} PAX's log: {1}" -f $rollupLine, (Join-Path $OutDir 'PAX_Stub.log'))
  }
  'rollup-exit0' {
    Write-Host "[ERROR] $rollupLine"
  }
  'zero' {
    Write-Host '  Retained:  0 records'
    Write-Host '  Exported:  0 rows'
  }
  'stale' { }
  default {
    if ($OnlyUserInfo) {
      $directory = Join-Path $OutDir "EntraUsers_MAClicensing_${stamp}.csv"
      if ($env:STUB_USER_CSV -eq '<empty>') {
        [System.IO.File]::WriteAllBytes($directory, [byte[]]@())
      } elseif ($env:STUB_USER_CSV) {
        [System.IO.File]::WriteAllText($directory, $env:STUB_USER_CSV.Replace('{row}', $row), [System.Text.UTF8Encoding]::new($true))
      } else {
        Set-Content -LiteralPath $directory -Value 'userPrincipalName', $row
      }
    } elseif ($appendTarget) {
      Add-Content -LiteralPath $appendTarget -Value $row
    } else {
      Set-Content -LiteralPath (Join-Path $OutDir "Purview_Stub_${stamp}_Interactions.csv") -Value 'Message_Id_Raw', $row
    }
    if (-not $OnlyUserInfo -and $behaviour -ne 'users-stale') {
      if ($appendUsersTarget) {
        Add-Content -LiteralPath $appendUsersTarget -Value $row
      } elseif ($IncludeUserInfo) {
        Set-Content -LiteralPath (Join-Path $OutDir "EntraUsers_Stub_${stamp}_Users.csv") -Value 'Id', $row
      }
    }
  }
}

# The real script's picks, with its messages.
if ($OnlyUserInfo) {
  $interactions = $null
} elseif ($appendTarget) {
  $interactions = Get-Item -LiteralPath $appendTarget -ErrorAction SilentlyContinue
  if (-not $interactions) { throw "The interactions file $appendTarget is missing after the run." }
} else {
  $interactions = Get-ChildItem $OutDir -Filter '*_Interactions*.csv' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $interactions) { throw "No rollup interactions CSV found in $OutDir." }
}
$users = $null
if ($OnlyUserInfo) {
  $users = Get-ChildItem -LiteralPath $OutDir -Filter 'EntraUsers_MAClicensing_*.csv' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $users) { throw "PAX wrote no user directory CSV to $OutDir this run. PAX's log there says why." }
} elseif ($appendUsersTarget) {
  $users = Get-Item -LiteralPath $appendUsersTarget -ErrorAction SilentlyContinue
  if (-not $users) { throw "The users file $appendUsersTarget is missing after the run." }
} elseif ($IncludeUserInfo) {
  $users = Get-ChildItem $OutDir -Filter '*_Users*.csv' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $users) { throw "No rollup users CSV found in $OutDir." }
}

$agents365 = $null
if ($IncludeAgent365Info -and $env:STUB_AGENTS -ne 'none') {
  $registryCsv = Join-Path $OutDir 'Agents365Registry.csv'
  Set-Content -LiteralPath $registryCsv -Value 'AgentId', $row
  $agents365 = Get-Item -LiteralPath $registryCsv
}

[ordered]@{
  interactions_csv = if ($interactions) { $interactions.FullName } else { $null }
  users_csv        = if ($users) { $users.FullName } else { $null }
  agents365_csv    = if ($agents365) { $agents365.FullName } else { $null }
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir 'rollup-manifest.json') -Encoding utf8
