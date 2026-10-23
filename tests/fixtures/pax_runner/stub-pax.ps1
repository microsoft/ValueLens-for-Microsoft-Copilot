# Stub Run-PAX-AIBV.ps1 body. test_pax_runner.py puts the real script's param block before it,
# so refresh.ps1's child command line binds exactly as it would to the real script. The stub
# writes rows the way PAX does, then picks its outputs and writes rollup-manifest.json the
# way the real script does. STUB_MODE picks the behaviour:
#   (unset)      appends a row to each target, or writes a first run's files
#   zero         prints PAX's zero-row lines and writes nothing
#   stale        writes nothing
#   users-stale  writes the interactions only
#   fail         prints "Exit code: $env:STUB_PAX_EXIT" and fails as the real script does
$ErrorActionPreference = 'Stop'

$bound = [ordered]@{}
foreach ($key in $PSBoundParameters.Keys) { $bound[$key] = [string]$PSBoundParameters[$key] }
[ordered]@{
  run      = $env:STUB_RUN
  params   = $bound
  argv     = @([Environment]::GetCommandLineArgs())
  secretOk = ($env:AIBV_CLIENT_SECRET -ceq 'stub-secret')
} | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $env:STUB_PAX_LOG -Encoding utf8

$mode = if ($AppendFile) { 'append' } else { 'seed' }
Write-Host "Stub PAX: run $env:STUB_RUN, $Days days, mode $mode"

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
$row = "row-from-run-$env:STUB_RUN"

switch ($env:STUB_MODE) {
  'fail' {
    Write-Host "Exit code: $env:STUB_PAX_EXIT"
    throw 'PAX failed.'
  }
  'zero' {
    Write-Host '  Retained:  0 records'
    Write-Host '  Exported:  0 rows'
  }
  'stale' { }
  default {
    if ($appendTarget) {
      Add-Content -LiteralPath $appendTarget -Value $row
    } else {
      Set-Content -LiteralPath (Join-Path $OutDir "Purview_Stub_${stamp}_Interactions.csv") -Value 'Message_Id_Raw', $row
    }
    if ($env:STUB_MODE -ne 'users-stale') {
      if ($appendUsersTarget) {
        Add-Content -LiteralPath $appendUsersTarget -Value $row
      } elseif ($IncludeUserInfo) {
        Set-Content -LiteralPath (Join-Path $OutDir "EntraUsers_Stub_${stamp}_Users.csv") -Value 'Id', $row
      }
    }
  }
}

# The real script's picks, with its messages.
if ($appendTarget) {
  $interactions = Get-Item -LiteralPath $appendTarget -ErrorAction SilentlyContinue
  if (-not $interactions) { throw "The interactions file $appendTarget is missing after the run." }
} else {
  $interactions = Get-ChildItem $OutDir -Filter '*_Interactions*.csv' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $interactions) { throw "No rollup interactions CSV found in $OutDir." }
}
$users = $null
if ($appendUsersTarget) {
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
  interactions_csv = $interactions.FullName
  users_csv        = if ($users) { $users.FullName } else { $null }
  agents365_csv    = if ($agents365) { $agents365.FullName } else { $null }
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir 'rollup-manifest.json') -Encoding utf8
