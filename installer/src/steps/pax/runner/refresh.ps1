#Requires -Version 7.2
<#
.SYNOPSIS
  Runs the scheduled PAX refresh for a PAX + SharePoint install, or uploads one file to its
  SharePoint folder.

.DESCRIPTION
  A refresh, the default, works in the folder that holds refresh.json:
    1. Takes refresh.lock, so two runs never overlap.
    2. Reads the app's client secret from Windows Credential Manager with credential.ps1.
    3. When this machine has no cumulative files, restores them from the SharePoint folder.
    4. Runs Run-PAX-AIBV.ps1 in a child pwsh process for each window of up to windowDays
       days, oldest first. PAX appends the new activity to the cumulative files, or creates
       them on the first run.
    5. Uploads the files to the SharePoint folder with Upload-Rollups-SharePoint.ps1.
    6. Writes state.json, and a log under logs\.

  state.json records the load after each window. When the next window might not finish
  inside runHours, the run stops there and uploads what it has, and the next run carries on
  from the last finished window. So does the next run after one that failed part way. When
  Task Scheduler stops a run inside its first window, the next run reads windows half that size.

  The folder holds:
    data\         the cumulative files, PAX's logs, and any files set aside
    work\         Run-PAX-AIBV.ps1's working folder: the PAX download and processed\
    logs\         one log per run, kept for 30 days
    state.json    the last run's result, which the installer's status command reads

  -Upload puts one file into the SharePoint folder, or a subfolder of it, with the same app
  and secret.

  -Check signs in as the app, finds the site, library and folder, creates the folder if it's
  missing, and prints one line of JSON: {"ok":true,"siteId":...,"driveId":...,"folder":...}, or
  {"ok":false,"error":...,"status":<HTTP status, when Graph refused>}.

  refresh.json names the document library by driveId, or by library: its name or the last
  part of its address, such as Documents or Shared Documents. A library is looked up on each
  run with the app's own access, because the installer's sign-in may not be able to read the
  site. siteId can be Graph's site ID or its path form, such as contoso.sharepoint.com:/sites/Analytics.

  Product names come only from refresh.json, so other products can reuse this script.

.PARAMETER Config
  The refresh.json that the installer wrote.

.PARAMETER Days
  How many days of activity to ask PAX for, from 1 to 180, in place of the number this script
  works out. Use it once to fill a gap that state.json reports. The days are still read in
  windows.

.PARAMETER Upload
  A local file to upload into the SharePoint folder.

.PARAMETER RemoteName
  The uploaded file's name. Defaults to the local file's name.

.PARAMETER RemoteFolder
  A subfolder of the SharePoint folder, such as Exports/2026. Missing folders are created.

.PARAMETER Check
  Checks that the app can reach the SharePoint folder, and prints the result as JSON.

.NOTES
  Exit codes: 0 success; 1 failed; 2 another run holds the lock; 3 PAX found no Copilot
  activity yet, so there was nothing to upload.
#>
[CmdletBinding(DefaultParameterSetName = 'Refresh')]
param(
  [Parameter(Mandatory = $true)] [string]$Config,
  [Parameter(ParameterSetName = 'Refresh')] [ValidateRange(1, 180)] [int]$Days,
  [Parameter(ParameterSetName = 'Upload', Mandatory = $true)] [string]$Upload,
  [Parameter(ParameterSetName = 'Upload')] [string]$RemoteName,
  [Parameter(ParameterSetName = 'Upload')] [string]$RemoteFolder,
  [Parameter(ParameterSetName = 'Check', Mandatory = $true)] [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false

$script:ExitCode = 1
$script:LastGraphStatus = $null
$script:RepairHint = "Run the installer's repair command."
$script:Streams = [ordered]@{
  interactions = @{ Local = 'cumulative_Interactions.csv'; Manifest = 'interactions_csv' }
  users        = @{ Local = 'cumulative_Users.csv'; Manifest = 'users_csv' }
  agents365    = @{ Local = 'current_Agents365.csv'; Manifest = 'agents365_csv' }
}
# PAX 1.11.15 prints one of these when its rollup step fails, and still exits 0.
$script:RollupFailurePattern = 'Rollup: (post-processor (returned non-zero exit code|failed:)|expected (Fact|Users dim) CSV not produced)'

# ---- Helpers ----

function Test-FileName {
  # A file or folder name that SharePoint and Windows both accept.
  param([string]$Name)
  if (-not $Name) { return $false }
  if ($Name -match '[\\/:*?"<>|\x00-\x1f]') { return $false }
  if ($Name -ne $Name.Trim() -or $Name.EndsWith('.')) { return $false }
  return $true
}

function Split-FolderPath {
  param([string]$Path)
  if ($Path) { $Path -split '[\\/]' | Where-Object { $_ -ne '' } }
}

function ConvertTo-UtcDate {
  param($Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [datetimeoffset]) { return $Value.UtcDateTime }
  if ($Value -is [datetime]) {
    if ($Value.Kind -eq [DateTimeKind]::Local) { return $Value.ToUniversalTime() }
    return [datetime]::SpecifyKind($Value, [DateTimeKind]::Utc)
  }
  $parsed = [datetimeoffset]::MinValue
  $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal
  if ([datetimeoffset]::TryParse([string]$Value, [cultureinfo]::InvariantCulture, $styles, [ref]$parsed)) {
    return $parsed.UtcDateTime
  }
  return $null
}

function Format-UtcDate {
  param($Value)
  $date = ConvertTo-UtcDate $Value
  if ($null -eq $date) { return $null }
  return $date.ToString('o', [cultureinfo]::InvariantCulture)
}

function ConvertTo-PlainData {
  # Turns ConvertFrom-Json's objects into hashtables, whose keys ignore case.
  param($Value)
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $table = @{}
    foreach ($property in $Value.PSObject.Properties) {
      $table[$property.Name] = ConvertTo-PlainData $property.Value
    }
    return $table
  }
  return , $Value
}

function Read-JsonFile {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path)
  if (-not $text.Trim()) { throw "$Path is empty." }
  return ConvertTo-PlainData ($text | ConvertFrom-Json)
}

function Write-JsonFileAtomic {
  param([string]$Path, $Data)
  $temp = "$Path.tmp"
  $json = $Data | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($temp, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-ErrorDescription {
  # The most useful line of an error, including the body of a failed web request.
  param($ErrorRecord)
  $text = $null
  $details = $ErrorRecord.ErrorDetails
  if ($details -and $details.Message) {
    $text = $details.Message
    try {
      $body = $details.Message | ConvertFrom-Json
      if ($body.error_description) { $text = [string]$body.error_description }
      elseif ($body.error.message) { $text = [string]$body.error.message }
    } catch { }
  }
  if (-not $text) { $text = $ErrorRecord.Exception.Message }
  # Entra ID adds trace and correlation IDs on later lines. The first line says what's wrong.
  return ([string]$text -split "`r?`n")[0].Trim()
}

# ---- Config ----

function Read-RefreshConfig {
  # refresh.json's values over these defaults. Every problem is reported at once.
  param([string]$Path)
  $config = [ordered]@{
    schema           = 1
    product          = 'Dashboard'
    tenantId         = $null
    clientId         = $null
    credentialTarget = $null
    siteId           = $null
    driveId          = $null
    library          = $null
    folderPath       = '/'
    paxReleaseTag    = $null
    paxSha256        = $null
    files            = @{
      interactions = 'copilot_interactions_rollup.csv'
      users        = 'copilot_users_rollup.csv'
      agents365    = 'agents_365.csv'
    }
    seedDays         = 30
    maxDays          = 30
    minDays          = 3
    overlapDays      = 2
    keepRunFilesDays = 3
    windowDays       = 7
    runHours         = 10
    agent365         = $false
    deidentify       = $false
    repairHint       = $script:RepairHint
  }
  $problems = [System.Collections.Generic.List[string]]::new()
  $raw = Read-JsonFile $Path
  if ($raw -isnot [hashtable]) { throw "$Path doesn't hold a JSON object." }
  foreach ($key in @($raw.Keys)) {
    if ($key -ne 'files') { $config[$key] = $raw[$key]; continue }
    if ($raw[$key] -isnot [hashtable]) { $problems.Add('files must be an object of file names.'); continue }
    foreach ($name in @($raw[$key].Keys)) { $config.files[$name] = $raw[$key][$name] }
  }
  if ($config.repairHint -is [string] -and $config.repairHint.Trim()) { $script:RepairHint = $config.repairHint.Trim() }

  if ($config.schema -ne 1) { $problems.Add("schema is '$($config.schema)', and this script reads schema 1.") }
  $guid = [guid]::Empty
  foreach ($key in 'tenantId', 'clientId') {
    if (-not ($config[$key] -is [string] -and [guid]::TryParse($config[$key], [ref]$guid))) { $problems.Add("$key must be a GUID.") }
  }
  foreach ($key in 'product', 'credentialTarget', 'siteId', 'paxReleaseTag') {
    if (-not ($config[$key] -is [string] -and $config[$key].Trim())) { $problems.Add("$key is missing.") }
  }
  foreach ($key in 'driveId', 'library') {
    if ($null -ne $config[$key] -and $config[$key] -isnot [string]) { $problems.Add("$key must be text.") }
    elseif ($config[$key] -is [string]) { $config[$key] = $config[$key].Trim() }
  }
  if (-not ($config.driveId -is [string] -and $config.driveId) -and -not ($config.library -is [string] -and $config.library)) {
    $problems.Add('driveId and library are both missing. One of them must name the document library.')
  }
  if ($config.paxReleaseTag -eq 'latest') { $problems.Add("paxReleaseTag must name one PAX release, not 'latest'.") }
  if (-not ($config.paxSha256 -is [string] -and $config.paxSha256 -match '^[0-9a-fA-F]{64}$')) {
    $problems.Add("paxSha256 must be the pinned PAX script's SHA-256, as 64 hex characters.")
  }
  if ($config.folderPath -isnot [string]) {
    $problems.Add('folderPath must be a folder path in the library, such as /Reports.')
  } else {
    foreach ($segment in @(Split-FolderPath $config.folderPath)) {
      if (-not (Test-FileName $segment)) { $problems.Add("folderPath has a folder name that SharePoint can't use: '$segment'.") }
    }
  }
  $names = @()
  foreach ($key in $script:Streams.Keys) {
    $name = $config.files[$key]
    if ($name -is [string] -and (Test-FileName $name)) { $names += $name }
    else { $problems.Add("files.$key isn't a file name that SharePoint can use: '$name'.") }
  }
  if (@($names | Sort-Object -Unique).Count -ne $names.Count) {
    $problems.Add('files.interactions, files.users and files.agents365 must be three different names.')
  }
  $ranges = @(
    @('seedDays', 1, 180), @('maxDays', 1, 180), @('minDays', 1, 180),
    @('overlapDays', 0, 30), @('keepRunFilesDays', 1, 365), @('windowDays', 1, 180)
  )
  foreach ($range in $ranges) {
    $value = $config[$range[0]]
    if (($value -is [int] -or $value -is [long]) -and $value -ge $range[1] -and $value -le $range[2]) {
      $config[$range[0]] = [int]$value
    } else {
      $problems.Add(('{0} must be a whole number from {1} to {2}.' -f $range[0], $range[1], $range[2]))
    }
  }
  if ($config.minDays -is [int] -and $config.maxDays -is [int] -and $config.minDays -gt $config.maxDays) {
    $problems.Add("minDays can't be more than maxDays.")
  }
  $hours = $config.runHours
  if (($hours -is [int] -or $hours -is [long] -or $hours -is [double] -or $hours -is [decimal]) -and $hours -gt 0 -and $hours -le 23) {
    $config.runHours = [double]$hours
  } else {
    $problems.Add('runHours must be a number of hours above 0 and up to 23.')
  }
  foreach ($key in 'agent365', 'deidentify') {
    if ($config[$key] -isnot [bool]) { $problems.Add("$key must be true or false.") }
  }
  if ($problems.Count) {
    throw ("{0} has problems:`n  - {1}`n{2}" -f $Path, ($problems -join "`n  - "), $script:RepairHint)
  }
  $config.folderPath = '/' + (@(Split-FolderPath $config.folderPath) -join '/')
  return $config
}

# ---- State, lock, log ----

function New-StreamState {
  param($Previous)
  if ($Previous -isnot [hashtable]) { $Previous = @{} }
  return [ordered]@{
    mode        = $null
    synced      = ($Previous.synced -eq $true)
    updated     = $false
    noNewRows   = $false
    bytes       = $Previous.bytes
    uploadedUtc = Format-UtcDate $Previous.uploadedUtc
    error       = $null
    warning     = $null
  }
}

function ConvertTo-Progress {
  # The load that the last run left unfinished, or $null when there's none or it doesn't read.
  param($Value)
  if ($Value -isnot [hashtable]) { return $null }
  $from = Format-UtcDate $Value.fromUtc
  if (-not $from) { return $null }
  foreach ($key in 'days', 'windowDays') {
    $number = $Value[$key]
    if (-not (($number -is [int] -or $number -is [long]) -and $number -ge 1 -and $number -le 180)) { return $null }
  }
  $pending = $null
  $window = $Value.pending
  if ($window -is [hashtable] -and (Format-UtcDate $window.from) -and (Format-UtcDate $window.to) -and
    ($window.days -is [int] -or $window.days -is [long]) -and $window.days -ge 1 -and $window.days -le 180) {
    $pending = [ordered]@{
      from  = Format-UtcDate $window.from
      to    = Format-UtcDate $window.to
      days  = [int]$window.days
      first = ($window.first -eq $true)
    }
  }
  return [ordered]@{
    fromUtc    = $from
    days       = [int]$Value.days
    seed       = ($Value.seed -eq $true)
    windowDays = [int]$Value.windowDays
    throughUtc = Format-UtcDate $Value.throughUtc
    pending    = $pending
  }
}

function Initialize-State {
  # A new state that carries over what later runs need from the last one.
  $previous = $null
  if (Test-Path -LiteralPath $script:StatePath) {
    try { $previous = Read-JsonFile $script:StatePath }
    catch { Write-Warning "state.json couldn't be read, so this run starts a new one: $($_.Exception.Message)" }
  }
  if ($previous -isnot [hashtable]) { $previous = @{} }
  $script:PreviousState = $previous
  $streams = if ($previous.streams -is [hashtable]) { $previous.streams } else { @{} }
  $script:State = [ordered]@{
    schema            = 1
    lastRunUtc        = Format-UtcDate ([datetime]::UtcNow)
    lastResult        = 'failed'
    lastError         = $null
    lastMessage       = $null
    lastSuccessUtc    = Format-UtcDate $previous.lastSuccessUtc
    coveredThroughUtc = Format-UtcDate $previous.coveredThroughUtc
    gapFromUtc        = Format-UtcDate $previous.gapFromUtc
    gapDays           = $null
    gapWarning        = $null
    days              = $null
    progress          = ConvertTo-Progress $previous.progress
    lastLog           = $script:LogPath
    streams           = [ordered]@{}
  }
  foreach ($name in $script:Streams.Keys) { $script:State.streams[$name] = New-StreamState $streams[$name] }
}

function Save-State {
  param($Snapshot)
  if (-not $script:State) { return }
  $state = if ($Snapshot) { $Snapshot } else { $script:State }
  $gapFrom = ConvertTo-UtcDate $state.gapFromUtc
  $state.gapDays = $null
  $state.gapWarning = $null
  if ($gapFrom) {
    $overlap = if ($script:Cfg) { $script:Cfg.overlapDays } else { 2 }
    # Local calendar days, so a daylight saving change doesn't add a day.
    $needed = [int][math]::Ceiling([math]::Max(0, ((Get-Date).Date - $gapFrom.ToLocalTime()).TotalDays)) + $overlap
    $state.gapDays = [math]::Min(180, $needed)
    $state.gapWarning = "The cumulative files are missing activity from {0:yyyy-MM-dd}, because the refresh didn't run for longer than it looks back. Run a refresh once with -Days {1} to fill the gap." -f $gapFrom.ToLocalTime(), $state.gapDays
    if ($needed -gt 180) {
      $state.gapWarning += ' Microsoft Purview keeps audit records for 180 days on most licences, so the oldest part of the gap may not come back.'
    }
  }
  try { Write-JsonFileAtomic $script:StatePath $state }
  catch { Write-Warning "state.json couldn't be saved: $($_.Exception.Message)" }
}

function Save-Progress {
  # Saves the load's progress part way through a run, so a run that's stopped from outside
  # leaves it for the next one. The result fields keep the last run's values until this run
  # ends, so the installer doesn't take this save for the run's end.
  $previous = $script:PreviousState
  $snapshot = [ordered]@{}
  foreach ($key in $script:State.Keys) { $snapshot[$key] = $script:State[$key] }
  foreach ($key in 'lastRunUtc', 'lastSuccessUtc') { $snapshot[$key] = Format-UtcDate $previous[$key] }
  foreach ($key in 'lastResult', 'lastError', 'lastMessage', 'lastLog', 'days') { $snapshot[$key] = $previous[$key] }
  Save-State $snapshot
}

function Complete-Progress {
  # Keeps a load that this run didn't finish, so the next run carries on from its last
  # finished window. A one-window run that failed leaves nothing to carry on from.
  if (-not $script:State -or -not $script:Load) { return }
  $progress = $script:State.progress
  if ($script:LoadDone -or -not $progress) {
    $script:State.progress = $null
    return
  }
  # A window that failed, rather than one that was stopped from outside, keeps its size.
  $progress.pending = $null
  if (-not $script:Stopped -and -not $progress.throughUtc -and @($script:Windows).Count -le 1) {
    $script:State.progress = $null
  }
}

function Enter-RunLock {
  # Holds refresh.lock open without sharing until the run ends. The file itself stays.
  $path = Join-Path $script:Root 'refresh.lock'
  try {
    $script:Lock = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    return $true
  } catch {
    for ($e = $_.Exception; $e; $e = $e.InnerException) {
      # 32 and 33 are Windows' sharing and lock violations: another run has the file open.
      if ($e -is [System.IO.IOException] -and ($e.HResult -band 0xFFFF) -in 32, 33) { return $false }
    }
    throw
  }
}

function Start-RunLog {
  New-Item -ItemType Directory -Force -Path $script:LogsDir | Out-Null
  $stamp = [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss', [cultureinfo]::InvariantCulture)
  $script:LogPath = Join-Path $script:LogsDir "refresh-$stamp.log"
  for ($n = 2; Test-Path -LiteralPath $script:LogPath; $n++) { $script:LogPath = Join-Path $script:LogsDir "refresh-$stamp-$n.log" }
  try {
    Start-Transcript -LiteralPath $script:LogPath -UseMinimalHeader | Out-Null
    $script:Transcribing = $true
  } catch {
    Write-Warning "This run has no log, because its transcript didn't start: $($_.Exception.Message)"
    $script:LogPath = $null
  }
  # The PAX child shares this console, so both sides read and write its output as UTF-8.
  try {
    $script:OldEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  } catch {
    $script:OldEncoding = $null
  }
}

function Stop-RunLog {
  if ($script:OldEncoding) {
    try { [Console]::OutputEncoding = $script:OldEncoding } catch { }
  }
  if ($script:Transcribing) {
    try { Stop-Transcript | Out-Null } catch { }
    $script:Transcribing = $false
  }
}

function Remove-OldFiles {
  # Run files go after keepRunFilesDays; logs and files set aside after 30 days.
  # work\pax, the PAX download, is never touched.
  $keepDays = if ($script:Cfg) { $script:Cfg.keepRunFilesDays } else { 3 }
  $managed = @($script:Streams.Values | ForEach-Object { $_.Local })
  $now = [datetime]::UtcNow
  foreach ($folder in @($script:DataDir, (Join-Path $script:WorkDir 'processed'), $script:LogsDir)) {
    if (-not (Test-Path -LiteralPath $folder)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $folder -File)) {
      if ($file.Name -in $managed) { continue }
      $limit = if ($file.Extension -eq '.csv' -and $file.Name -notlike 'set-aside-*') { $keepDays } else { 30 }
      if (($now - $file.LastWriteTimeUtc).TotalDays -le $limit) { continue }
      try { Remove-Item -LiteralPath $file.FullName -Force }
      catch { Write-Warning "Couldn't remove the old file $($file.FullName): $($_.Exception.Message)" }
    }
  }
}

# ---- Secret, Python, Graph ----

function Get-AppSecret {
  try {
    $value = & (Join-Path $PSScriptRoot 'credential.ps1') -Action Read -Target $script:Cfg.credentialTarget
  } catch {
    throw "Couldn't read the app's client secret. $($_.Exception.Message) $script:RepairHint"
  }
  $value = [string]($value | Select-Object -Last 1)
  if (-not $value) { throw "Credential Manager returned an empty client secret for $($script:Cfg.credentialTarget). $script:RepairHint" }
  $script:Secret = $value
}

function Test-Python {
  # PAX's -Rollup runs a Python post-processor. Without Python 3.10 or later, PAX tries to
  # install it with winget, which a scheduled task can't finish, so check first.
  $probe = 'import sys; print("%d.%d" % sys.version_info[:2])'
  foreach ($candidate in 'python', 'py -3.13', 'py -3.12', 'py -3.11', 'py -3.10', 'python3') {
    $parts = @($candidate -split ' ')
    if (-not (Get-Command $parts[0] -ErrorAction SilentlyContinue)) { continue }
    $arguments = @($parts | Select-Object -Skip 1) + @('-c', $probe)
    try {
      $ErrorActionPreference = 'Continue'
      $output = & $parts[0] @arguments 2>$null
      $code = $LASTEXITCODE
    } catch {
      continue
    } finally {
      $ErrorActionPreference = 'Stop'
    }
    # The Microsoft Store's python.exe placeholder exits 9009 when Python isn't installed.
    if ($code -ne 0) { continue }
    $version = $null
    $text = [string]($output | Select-Object -Last 1)
    if ([version]::TryParse($text.Trim(), [ref]$version) -and $version -ge [version]'3.10') {
      Write-Host "Python $($text.Trim()) ($candidate)"
      return
    }
  }
  throw ("PAX needs Python 3.10 or later to build the rollup files, and this account has none. " +
    'Install it for this user with: winget install Python.Python.3.13 --scope user. Then run the refresh again.')
}

function Connect-Graph {
  $body = @{
    client_id     = $script:Cfg.clientId
    client_secret = $script:Secret
    scope         = 'https://graph.microsoft.com/.default'
    grant_type    = 'client_credentials'
  }
  $uri = 'https://login.microsoftonline.com/' + $script:Cfg.tenantId + '/oauth2/v2.0/token'
  try {
    $response = Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/x-www-form-urlencoded'
  } catch {
    throw "Couldn't sign in to Microsoft Graph as the app $($script:Cfg.clientId): $(Get-ErrorDescription $_) $script:RepairHint"
  }
  $script:GraphToken = $response.access_token
}

function Invoke-Graph {
  # Returns the status and body, so callers decide what each status means.
  param([string]$Method = 'Get', [string]$Path, $Body)
  $request = @{
    Method             = $Method
    Uri                = 'https://graph.microsoft.com/v1.0/' + $Path
    Headers            = @{ Authorization = ('Bearer ' + $script:GraphToken) }
    SkipHttpErrorCheck = $true
    StatusCodeVariable = 'graphStatus'
  }
  if ($null -ne $Body) {
    $request.Body = $Body | ConvertTo-Json -Depth 5 -Compress
    $request.ContentType = 'application/json'
  }
  $graphStatus = 0
  $result = Invoke-RestMethod @request
  return [pscustomobject]@{ Status = [int]$graphStatus; Body = $result }
}

function Format-GraphError {
  param($Response, [string]$Doing)
  $script:LastGraphStatus = $Response.Status
  $text = "$Doing failed with HTTP $($Response.Status)"
  $message = $null
  if ($Response.Body -and $Response.Body.error) { $message = ([string]$Response.Body.error.message).Trim() }
  # Graph's messages often have no full stop, such as "Access denied".
  if ($message -and $message -notmatch '[.!?]$') { $message += '.' }
  if ($message) { $text += ": $message" } else { $text += '.' }
  if ($Response.Status -in 401, 403) {
    $text += " The app needs write access to the SharePoint site, through a Sites.Selected grant. $script:RepairHint"
  }
  return $text
}

function Get-FolderSegments {
  # The configured folder, then an optional subfolder, as one list of names.
  param([string]$Subfolder)
  Split-FolderPath $script:Cfg.folderPath
  Split-FolderPath $Subfolder
}

function Get-UrlLeaf {
  # The last part of an address's path, decoded: Shared Documents for .../Shared%20Documents.
  param([string]$Url)
  $uri = $null
  if (-not [uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { return $null }
  $parts = @($uri.AbsolutePath -split '/' | Where-Object { $_ })
  if (-not $parts) { return $null }
  return [uri]::UnescapeDataString($parts[-1])
}

function Resolve-Drive {
  # Finds the site's Graph ID and, when refresh.json names the library rather than its drive
  # ID, the library's drive, with the app's own access.
  $cfg = $script:Cfg
  if ($cfg.driveId) { return }
  $site = Invoke-Graph -Path ('sites/' + $cfg.siteId + '?$select=id,webUrl')
  if ($site.Status -ne 200) { throw (Format-GraphError $site "Finding the SharePoint site $($cfg.siteId)") }
  $siteId = [string]$site.Body.id
  $siteUrl = [string]$site.Body.webUrl
  $drives = [System.Collections.Generic.List[object]]::new()
  $base = 'https://graph.microsoft.com/v1.0/'
  $path = 'sites/' + $siteId + '/drives?$select=id,name,webUrl'
  while ($path) {
    $page = Invoke-Graph -Path $path
    if ($page.Status -ne 200) { throw (Format-GraphError $page "Listing the document libraries on $siteUrl") }
    foreach ($drive in @($page.Body.value)) { if ($drive) { $drives.Add($drive) } }
    $next = [string]$page.Body.'@odata.nextLink'
    $path = if ($next.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { $next.Substring($base.Length) } else { $null }
  }
  # The address's last part first: a library's name can change, and English sites call
  # Shared Documents "Documents".
  $wanted = $cfg.library
  $byUrl = @($drives | Where-Object { (Get-UrlLeaf ([string]$_.webUrl)) -eq $wanted })
  $byName = @($drives | Where-Object { [string]$_.name -eq $wanted })
  $match = @($byUrl + $byName) | Select-Object -First 1
  if (-not $match) {
    $known = @($drives | ForEach-Object {
        $leaf = Get-UrlLeaf ([string]$_.webUrl)
        if ($leaf -and $leaf -ne [string]$_.name) { "$($_.name) ($leaf)" } else { [string]$_.name }
      })
    $list = if ($known) { 'Its libraries are: ' + ($known -join ', ') + '.' } else { 'The app can see no libraries there.' }
    throw "$siteUrl has no document library called '$wanted'. $list $script:RepairHint"
  }
  $cfg.siteId = $siteId
  $cfg.driveId = [string]$match.id
  Write-Host "Library: $($match.name) on $siteUrl"
}

function Get-DrivePath {
  param([string[]]$Segments)
  $root = 'drives/' + $script:Cfg.driveId + '/root'
  if (-not $Segments) { return $root }
  return $root + ':/' + (($Segments | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/')
}

function Confirm-RemoteFolder {
  # Creates any missing folders along the path. The library's root always exists.
  param([string[]]$Segments)
  if (-not $Segments) { return }
  $shown = $Segments -join '/'
  $probe = Invoke-Graph -Path (Get-DrivePath $Segments)
  if ($probe.Status -eq 200) {
    if (-not $probe.Body.folder) { throw "SharePoint has a file named $shown where the folder should be." }
    return
  }
  if ($probe.Status -ne 404) { throw (Format-GraphError $probe "Checking the SharePoint folder $shown") }
  for ($i = 0; $i -lt $Segments.Count; $i++) {
    $parent = if ($i -eq 0) { (Get-DrivePath @()) + '/children' } else { (Get-DrivePath $Segments[0..($i - 1)]) + ':/children' }
    $body = @{ name = $Segments[$i]; folder = @{}; '@microsoft.graph.conflictBehavior' = 'fail' }
    $created = Invoke-Graph -Method Post -Path $parent -Body $body
    if ($created.Status -notin 200, 201, 409) {
      throw (Format-GraphError $created "Creating the SharePoint folder $($Segments[0..$i] -join '/')")
    }
  }
}

# ---- Restore, window, PAX ----

function ConvertTo-DayStart {
  # The start of the local day that holds a UTC time, in UTC. PAX's window is whole local days.
  param([datetime]$Utc)
  return $Utc.ToLocalTime().Date.ToUniversalTime()
}

function Get-LocalPath {
  param([string]$Name)
  return Join-Path $script:DataDir $script:Streams[$Name].Local
}

function Get-RemoteItem {
  # A stream's file in the SharePoint folder, or $null when there's none.
  param([string]$Name)
  $remoteName = $script:Cfg.files[$Name]
  $response = Invoke-Graph -Path (Get-DrivePath (@(Get-FolderSegments) + $remoteName))
  if ($response.Status -eq 404) { return $null }
  if ($response.Status -ne 200) { throw (Format-GraphError $response "Checking SharePoint for $remoteName") }
  if ($response.Body.folder) { throw "SharePoint has a folder named $remoteName where the file should be." }
  return $response.Body
}

function Restore-Stream {
  # PAX appends to this machine's cumulative file when there is one. Otherwise the run carries
  # on from SharePoint's copy, as on a new machine, or PAX creates the file.
  param([string]$Name)
  $stream = $script:State.streams[$Name]
  $local = Get-LocalPath $Name
  if (Test-Path -LiteralPath $local) {
    $stream.mode = 'append'
    return
  }
  $stream.synced = $false
  $remoteName = $script:Cfg.files[$Name]
  $item = Get-RemoteItem $Name
  if (-not $item) {
    $stream.mode = 'seed'
    return
  }
  $url = $item.'@microsoft.graph.downloadUrl'
  if (-not $url) { throw "SharePoint didn't return a download link for $remoteName." }
  $download = "$local.download"
  try {
    Invoke-WebRequest -Uri $url -OutFile $download
    $size = (Get-Item -LiteralPath $download).Length
    if ($null -ne $item.size -and $size -ne [long]$item.size) {
      throw "the download stopped at $size of $($item.size) bytes."
    }
  } catch {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    throw "Downloading $remoteName from SharePoint failed: $(Get-ErrorDescription $_)"
  }
  Move-Item -LiteralPath $download -Destination $local -Force
  $modified = ConvertTo-UtcDate $item.lastModifiedDateTime
  # The file keeps SharePoint's time, so a PAX run that doesn't update it can't pass for one
  # that did, and a later run without state.json still looks back far enough.
  if ($modified) { (Get-Item -LiteralPath $local).LastWriteTimeUtc = $modified }
  $stream.mode = 'append'
  $stream.synced = $true
  if ($Name -eq 'interactions' -and $modified) { $script:RestoredCovered = ConvertTo-DayStart $modified }
  Write-Host "Restored $remoteName from SharePoint: $size bytes."
}

function Set-RunWindow {
  # PAX looks back to the day the cumulative files cover, plus a few days of overlap that
  # PAX's de-duplication absorbs, within minDays and maxDays. A load that the last run left
  # unfinished carries on from its last finished window instead. The days are read in windows
  # of up to windowDays days, oldest first, so a long load can stop between them.
  $cfg = $script:Cfg
  $state = $script:State
  $interactions = $state.streams.interactions
  $script:Covered = $null
  if ($interactions.mode -eq 'append') {
    $script:Covered = $script:RestoredCovered
    if (-not $script:Covered) { $script:Covered = ConvertTo-UtcDate $state.coveredThroughUtc }
    if (-not $script:Covered) { $script:Covered = ConvertTo-DayStart (Get-Item -LiteralPath (Get-LocalPath 'interactions')).LastWriteTimeUtc }
  }
  $script:CoveredAtStart = $script:Covered
  $progress = $state.progress
  $today = (Get-Date).Date
  # Files restored from SharePoint hold only what was uploaded, so they don't resume a load.
  $resume = $progress -and -not $script:DaysOverride -and $interactions.mode -eq 'append' -and -not $script:RestoredCovered
  if ($resume) {
    $reachFrom = ConvertTo-UtcDate $(if ($progress.throughUtc) { $progress.throughUtc } else { $progress.fromUtc })
    $behind = [math]::Ceiling([math]::Max(0, ($today - $reachFrom.ToLocalTime()).TotalDays))
    $days = [math]::Min(180, [math]::Max($cfg.minDays, $behind + $cfg.overlapDays))
  } elseif ($script:DaysOverride) {
    $days = $script:DaysOverride
    $reachFrom = $script:Covered
  } elseif ($interactions.mode -eq 'seed') {
    $days = $cfg.seedDays
    $reachFrom = $null
  } else {
    $behind = [math]::Ceiling([math]::Max(0, ($today - $script:Covered.ToLocalTime()).TotalDays))
    $days = [math]::Min($cfg.maxDays, [math]::Max($cfg.minDays, $behind + $cfg.overlapDays))
    $reachFrom = $script:Covered
  }
  $script:RunDays = [int]$days
  $start = $today.AddDays(-$script:RunDays)
  $script:WindowStart = $start.ToUniversalTime()
  $state.days = $script:RunDays
  # The oldest day this run can't reach, when the files stop short of where it starts.
  $script:NewGapFrom = $null
  if ($reachFrom -and $script:WindowStart -gt $reachFrom -and $script:RunDays -lt 180) { $script:NewGapFrom = $reachFrom }

  $size = $cfg.windowDays
  if ($progress) {
    $size = [math]::Min($size, $progress.windowDays)
    $pending = $progress.pending
    if ($pending -and $pending.first) {
      # The last run ended inside its first window without saving a result, which is what
      # happens when Task Scheduler stops a run at its time limit.
      $size = [math]::Min($size, [math]::Max(1, [math]::Floor($pending.days / 2)))
      Write-Host ('The last run never finished its first window, of {0} days, so this run reads windows of up to {1} days.' -f $pending.days, $size)
    }
  }
  $size = [int]$size
  $count = [int][math]::Ceiling($script:RunDays / $size)
  $total = $script:RunDays
  $script:Windows = @(for ($k = 0; $k -lt $count; $k++) {
      $first = [int][math]::Floor($k * $total / $count)
      $next = [int][math]::Floor(($k + 1) * $total / $count)
      $to = $start.AddDays($next)
      [pscustomobject]@{ Index = $k + 1; From = $start.AddDays($first); To = $to; Days = $next - $first; Through = $to.ToUniversalTime() }
    })

  if ($resume) {
    $script:Load = [ordered]@{ fromUtc = $progress.fromUtc; days = $progress.days; seed = $progress.seed }
    $through = $progress.throughUtc
    Write-Host ('The last run stopped part way through a load, so this run carries on from {0:yyyy-MM-dd}.' -f $reachFrom.ToLocalTime())
  } else {
    $script:Load = [ordered]@{ fromUtc = Format-UtcDate $script:WindowStart; days = $script:RunDays; seed = ($interactions.mode -eq 'seed') }
    $through = $null
  }
  $state.progress = [ordered]@{
    fromUtc    = $script:Load.fromUtc
    days       = $script:Load.days
    seed       = $script:Load.seed
    windowDays = $size
    throughUtc = $through
    pending    = $null
  }
  Write-Host ('PAX looks back {0} days, from {1:yyyy-MM-dd}.' -f $script:RunDays, $start)
  if ($count -gt 1) { Write-Host ('It reads them in {0} windows of up to {1} days, oldest first.' -f $count, [int][math]::Ceiling($total / $count)) }
}

function Invoke-PaxChild {
  # Runs Run-PAX-AIBV.ps1 for one window in a child pwsh, so PAX's exit and its session changes
  # stay there. Its output is echoed as it arrives, so this run's log holds it.
  param($Window)
  $cfg = $script:Cfg
  $arguments = [System.Collections.Generic.List[string]]::new()
  $arguments.AddRange([string[]]@(
      '-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'Run-PAX-AIBV.ps1'),
      '-TenantId', $cfg.tenantId, '-ClientId', $cfg.clientId))
  if (@($script:Windows).Count -gt 1) {
    # PAX reads from the start date up to, but not including, the end date.
    $arguments.AddRange([string[]]@(
        '-StartDate', $Window.From.ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture),
        '-EndDate', $Window.To.ToString('yyyy-MM-dd', [cultureinfo]::InvariantCulture)))
  } else {
    $arguments.AddRange([string[]]@('-Days', [string]$script:RunDays))
  }
  $arguments.AddRange([string[]]@(
      '-WorkRoot', $script:WorkDir, '-PaxReleaseTag', $cfg.paxReleaseTag, '-PaxSha256', $cfg.paxSha256,
      '-SkipVersionCheck'))
  if ($script:State.streams.interactions.mode -eq 'append') { $arguments.AddRange([string[]]@('-AppendFile', (Get-LocalPath 'interactions'))) }
  if ($script:State.streams.users.mode -eq 'append') { $arguments.AddRange([string[]]@('-AppendUserInfo', (Get-LocalPath 'users'))) }
  # The registry is a snapshot, so one window reads it.
  if ($cfg.agent365 -and $Window.Index -eq 1) { $arguments.Add('-IncludeAgent365Info') }
  if ($cfg.deidentify) { $arguments.Add('-Deidentify') }
  $argv = $arguments.ToArray()

  # A file that an earlier window wrote can look new to this one, so each file's time is
  # recorded first. Test-FreshFile passes only a file whose time then changes.
  $script:WrittenBefore = @{}
  $files = @(Get-LocalPath 'interactions'; Get-LocalPath 'users')
  $processed = Join-Path $script:WorkDir 'processed'
  if (Test-Path -LiteralPath $processed) {
    $files += @(Get-ChildItem -LiteralPath $processed -File -Recurse -Force | ForEach-Object FullName)
  }
  foreach ($file in $files) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $script:WrittenBefore[[System.IO.Path]::GetFullPath($file)] = (Get-Item -LiteralPath $file).LastWriteTimeUtc
    }
  }

  $script:ChildErrors = [System.Collections.Generic.List[string]]::new()
  $script:ZeroRows = $false
  $script:PaxExitCode = $null
  $script:RollupFailed = $null
  $pwsh = (Get-Process -Id $PID).Path
  # Under Stop, PowerShell 7.0 and 7.1 can end this run on the child's first error line.
  $ErrorActionPreference = 'Continue'
  $env:AIBV_CLIENT_SECRET = $script:Secret
  try {
    $script:PaxStart = [datetime]::UtcNow
    & $pwsh @argv 2>&1 | ForEach-Object {
      $line = $_.ToString() -replace '\x1b\[[0-9;?]*[ -/]*[@-~]', ''
      if (-not $script:RollupFailed) {
        $match = [regex]::Match($line, $script:RollupFailurePattern)
        if ($match.Success) { $script:RollupFailed = $line.Substring($match.Index).Trim() }
      }
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        $script:ChildErrors.Add($line)
      } elseif ($line -match '^ {2}(Exported:\s+0 rows|Retained:\s+0 records)\s*$') {
        $script:ZeroRows = $true
      } elseif ($line -match '^Exit code:\s*(\d+)\s*$') {
        $script:PaxExitCode = [int]$Matches[1]
      }
      Write-Host $line
    }
    $script:ChildExit = $LASTEXITCODE
  } finally {
    $env:AIBV_CLIENT_SECRET = $null
    $ErrorActionPreference = 'Stop'
  }
  # Two seconds' grace for file systems that store coarse write times.
  $script:FreshAfter = $script:PaxStart.AddSeconds(-2)
  Write-Host "The PAX run ended with exit code $($script:ChildExit)."
}

function Get-ChildErrorText {
  # pwsh prints an unhandled error as the failing line, a ~~~ line under it, then the message
  # on lines that start with |. Prefer that message, else the last line of error output.
  $lines = @($script:ChildErrors)
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -notmatch '^\s*\|\s*~+\s*$') { continue }
    $message = for ($j = $i + 1; $j -lt $lines.Count -and $lines[$j] -match '^\s*\|\s?(.*)$'; $j++) { $Matches[1].Trim() }
    $text = (@($message) -join ' ').Trim()
    if ($text) { return $text }
  }
  return ([string](@($lines | Where-Object { $_.Trim() }) | Select-Object -Last 1)).Trim()
}

function Get-PaxFailure {
  $text = "The PAX run failed (exit code $($script:ChildExit))."
  $reasons = @{
    1  = 'PAX stopped on an error.'
    10 = "PAX reached Microsoft Purview's audit search limit. Run a refresh with a smaller -Days, or try again later."
    20 = 'Microsoft Purview throttled PAX for too long, so PAX stopped. The next scheduled run tries again.'
    30 = "PAX couldn't read users from Entra ID. Check that the app still has the User.Read.All permission."
    40 = 'PAX finished with gaps in the data, so it left the cumulative files unchanged. The next scheduled run tries again.'
  }
  if ($null -ne $script:PaxExitCode -and $reasons.ContainsKey($script:PaxExitCode)) { $text += ' ' + $reasons[$script:PaxExitCode] }
  $detail = Get-ChildErrorText
  if ($detail) { $text += " $detail" }
  # The error view can wrap a long message, so the rollup line is compared without spaces.
  if ($script:RollupFailed -and -not ($detail -and ($detail -replace '\s', '').Contains(($script:RollupFailed -replace '\s', '')))) {
    $text += " PAX's rollup step failed: $($script:RollupFailed)"
  }
  if ($script:LogPath) { $text += " The log is $($script:LogPath)." }
  return $text
}

# ---- After the run ----

function Test-FreshFile {
  # True when PAX wrote the file during this window's run.
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $written = (Get-Item -LiteralPath $Path).LastWriteTimeUtc
  $key = [System.IO.Path]::GetFullPath($Path)
  if ($script:WrittenBefore -and $script:WrittenBefore.ContainsKey($key) -and $script:WrittenBefore[$key] -eq $written) {
    return $false
  }
  return $written -ge $script:FreshAfter
}

function Complete-PaxRun {
  # Checks what PAX wrote in a window and moves first-run files into data\. Sets $script:Skip
  # when there's nothing to upload yet, and $script:WindowRead once the window's days are in
  # the cumulative files.
  param($Window)
  $final = $Window.Index -eq @($script:Windows).Count
  $script:WindowRead = $false
  $streams = $script:State.streams
  $seeding = $streams.interactions.mode -eq 'seed' -or $streams.users.mode -eq 'seed'
  if ($script:ChildExit -eq 0 -and $script:RollupFailed) {
    $text = "PAX's rollup step failed, though PAX exited 0: $($script:RollupFailed)"
    if ($script:LogPath) { $text += " The log is $($script:LogPath)." }
    throw $text
  }
  # After a run that finds no activity, PAX writes no new files, so the wrapper fails when it
  # looks for a first run's files. That case is handled below.
  if ($script:ChildExit -ne 0 -and -not ($script:ZeroRows -and $seeding)) { throw (Get-PaxFailure) }
  if ($script:ZeroRows -and $streams.interactions.mode -eq 'seed') {
    if (-not $final) {
      Write-Host ('PAX found no Copilot activity from {0:yyyy-MM-dd} to {1:yyyy-MM-dd}, so a later window starts the files.' -f $Window.From, $Window.To.AddDays(-1))
      return
    }
    $script:LoadDone = $true
    $script:State.lastResult = 'no-data'
    $script:State.lastMessage = "PAX found no Copilot activity in the last $($script:RunDays) days, so there's nothing to upload yet. The next scheduled run tries again."
    Write-Host $script:State.lastMessage
    $script:ExitCode = 3
    $script:Skip = $true
    return
  }
  $manifest = @{}
  $manifestPath = Join-Path $script:WorkDir 'processed\rollup-manifest.json'
  if ($script:ChildExit -eq 0 -and (Test-FreshFile $manifestPath)) { $manifest = Read-JsonFile $manifestPath }
  foreach ($name in 'interactions', 'users') {
    $stream = $streams[$name]
    $info = $script:Streams[$name]
    $local = Get-LocalPath $name
    if ($stream.mode -eq 'seed') {
      $made = $manifest[$info.Manifest]
      if ($made -and (Test-FreshFile $made)) {
        Move-Item -LiteralPath $made -Destination $local -Force
        $stream.updated = $true
      } elseif ($script:ZeroRows) {
        $stream.error = "PAX creates $($info.Local) only on a run that finds Copilot activity, and this run found none. The next scheduled run tries again."
      } else {
        $stream.error = "PAX didn't create $($info.Local). The log is $($script:LogPath)."
      }
    } elseif (Test-FreshFile $local) {
      $stream.updated = $true
    } elseif ($script:ZeroRows) {
      $stream.noNewRows = $true
    } else {
      $stream.error = "PAX didn't update $($info.Local), so it still holds the earlier data. PAX's log in $($script:DataDir) says why."
    }
  }
  if ($script:Cfg.agent365 -and $Window.Index -eq 1) {
    $agents = $streams.agents365
    $agents.mode = 'replace'
    $made = $manifest[$script:Streams.agents365.Manifest]
    if ($made -and (Test-FreshFile $made)) {
      Copy-Item -LiteralPath $made -Destination (Get-LocalPath 'agents365') -Force
      $agents.updated = $true
    } else {
      $agents.warning = "The Agent 365 registry didn't refresh this run, so SharePoint keeps its last copy."
    }
  }
  if ($streams.interactions.error) { throw $streams.interactions.error }
  Update-Coverage -Through $Window.Through -Final:$final
  $script:WindowRead = $true
}

function Update-Coverage {
  # Records how far the cumulative files reach, and the oldest day they may be missing when
  # the refresh didn't run for longer than this run looks back. Save-State turns that day
  # into a warning. A load clears an older gap only once its last window is read.
  param([datetime]$Through, [switch]$Final)
  $state = $script:State
  $gapFrom = ConvertTo-UtcDate $state.gapFromUtc
  if ($Final) {
    $load = $script:Load
    # A first run starts the files, and 180 days is as far back as Purview's records go.
    if ($load.seed -or $load.days -ge 180 -or ($gapFrom -and (ConvertTo-UtcDate $load.fromUtc) -le $gapFrom)) {
      $gapFrom = $null
    }
  }
  if ($script:NewGapFrom -and (-not $gapFrom -or $script:NewGapFrom -lt $gapFrom)) { $gapFrom = $script:NewGapFrom }
  $state.gapFromUtc = Format-UtcDate $gapFrom
  $covered = $Through
  if ($script:CoveredAtStart -and $script:CoveredAtStart -gt $covered) { $covered = $script:CoveredAtStart }
  $state.coveredThroughUtc = Format-UtcDate $covered
}

function Send-File {
  param([string]$Path, [string]$Name, [string[]]$Segments)
  $upload = @{
    File         = $Path
    RemoteName   = $Name
    TenantId     = $script:Cfg.tenantId
    ClientId     = $script:Cfg.clientId
    ClientSecret = $script:Secret
    SiteId       = $script:Cfg.siteId
    DriveId      = $script:Cfg.driveId
    FolderPath   = '/' + ($Segments -join '/')
  }
  & (Join-Path $PSScriptRoot 'Upload-Rollups-SharePoint.ps1') @upload | Out-Null
}

function Publish-Streams {
  # Uploads every file this run has, even on days with no new rows, so SharePoint always
  # holds this machine's latest copy.
  Connect-Graph
  $segments = @(Get-FolderSegments)
  Confirm-RemoteFolder $segments
  $problems = [System.Collections.Generic.List[string]]::new()
  foreach ($name in $script:Streams.Keys) {
    $stream = $script:State.streams[$name]
    $remoteName = $script:Cfg.files[$name]
    if ($stream.error) { $problems.Add($stream.error); continue }
    if ($name -eq 'agents365' -and -not $stream.updated) { continue }
    $local = Get-LocalPath $name
    if (-not $stream.synced -and $name -ne 'agents365') {
      # A file this machine didn't upload or restore may hold another machine's data.
      try { $existing = Get-RemoteItem $name }
      catch { $stream.error = $_.Exception.Message; $problems.Add($stream.error); continue }
      if ($existing) {
        $stamp = [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss', [cultureinfo]::InvariantCulture)
        $aside = Join-Path $script:DataDir "set-aside-$stamp-$remoteName"
        Move-Item -LiteralPath $local -Destination $aside -Force
        $stream.error = "SharePoint already has a $remoteName that this machine didn't upload, so this run didn't overwrite it. This machine's copy is now $aside. The next run continues from SharePoint's copy."
        $problems.Add($stream.error)
        continue
      }
    }
    try {
      Send-File -Path $local -Name $remoteName -Segments $segments
      $stream.synced = $true
      $stream.uploadedUtc = Format-UtcDate ([datetime]::UtcNow)
      $stream.bytes = (Get-Item -LiteralPath $local).Length
    } catch {
      $stream.error = "Uploading $remoteName to SharePoint failed: $(Get-ErrorDescription $_)"
      $problems.Add($stream.error)
    }
  }
  if ($problems.Count) { throw ($problems -join "`n") }
}

# ---- Main ----

function Invoke-Refresh {
  $script:RunStart = [datetime]::UtcNow
  $script:Cfg = Read-RefreshConfig $script:ConfigPath
  $cfg = $script:Cfg
  $now = $script:RunStart.ToString('yyyy-MM-dd HH:mm', [cultureinfo]::InvariantCulture)
  Write-Host "$($cfg.product): PAX refresh at $now UTC"
  Write-Host "Tenant $($cfg.tenantId), app $($cfg.clientId)"
  $library = if ($cfg.driveId) { $cfg.driveId } else { $cfg.library }
  Write-Host "SharePoint site $($cfg.siteId), library $library, folder $($cfg.folderPath)"
  New-Item -ItemType Directory -Force -Path $script:DataDir, $script:WorkDir | Out-Null
  Get-AppSecret
  Test-Python
  Connect-Graph
  Resolve-Drive
  Restore-Stream 'interactions'
  Restore-Stream 'users'
  Set-RunWindow
  $state = $script:State
  $windows = @($script:Windows)
  $budget = [timespan]::FromHours($cfg.runHours)
  $longest = [timespan]::Zero
  $lastRead = $null
  foreach ($window in $windows) {
    if ($windows.Count -gt 1) {
      Write-Host ('==> Window {0} of {1}: {2:yyyy-MM-dd} to {3:yyyy-MM-dd}' -f $window.Index, $windows.Count, $window.From, $window.To.AddDays(-1))
    }
    # A file that an earlier window started takes the later windows' activity.
    foreach ($name in 'interactions', 'users') {
      $stream = $state.streams[$name]
      if ($stream.mode -eq 'seed' -and (Test-Path -LiteralPath (Get-LocalPath $name))) { $stream.mode = 'append' }
    }
    # Each window reads the users again, so only the last window's problem with them counts.
    $state.streams.users.error = $null
    $state.progress.pending = [ordered]@{
      from  = Format-UtcDate $window.From
      to    = Format-UtcDate $window.To
      days  = $window.Days
      first = ($window.Index -eq 1)
    }
    Save-Progress
    $started = [datetime]::UtcNow
    Invoke-PaxChild $window
    Complete-PaxRun $window
    if ($script:Skip) { return }
    $state.progress.pending = $null
    if ($script:WindowRead) {
      $state.progress.throughUtc = Format-UtcDate $window.Through
      $lastRead = $window
    }
    Save-Progress
    $took = [datetime]::UtcNow - $started
    if ($took -gt $longest) { $longest = $took }
    if ($windows.Count -gt 1) { Write-Host ('Window {0} took {1:hh\:mm\:ss}.' -f $window.Index, $took) }
    $elapsed = [datetime]::UtcNow - $script:RunStart
    # Stops only once there's something to upload.
    if ($window.Index -lt $windows.Count -and (Test-Path -LiteralPath (Get-LocalPath 'interactions')) -and $elapsed + $longest -gt $budget) {
      $script:Stopped = $true
      Write-Host ('This run has taken {0:N1} hours, and its longest window took {1:N1}, so the next window might not finish inside {2:N1} hours. The run stops here.' -f $elapsed.TotalHours, $longest.TotalHours, $budget.TotalHours)
      break
    }
  }
  $script:LoadDone = -not $script:Stopped
  foreach ($name in $script:Streams.Keys) {
    # A stream that took rows in any window has new rows, whatever the last window found.
    if ($state.streams[$name].updated) { $state.streams[$name].noNewRows = $false }
  }
  $agents = $state.streams.agents365
  if ($cfg.agent365 -and -not $agents.updated -and -not $agents.warning) {
    $agents.mode = 'replace'
    $agents.warning = "The Agent 365 registry didn't refresh this run, so SharePoint keeps its last copy."
  }
  Publish-Streams
  $state.lastResult = 'success'
  $state.lastSuccessUtc = Format-UtcDate ([datetime]::UtcNow)
  $state.lastMessage = if ($script:Stopped) {
    "This run loaded activity up to {0:yyyy-MM-dd}, then stopped to stay inside the task's time limit. SharePoint has everything loaded so far, and the next scheduled run carries on from there." -f $(if ($lastRead) { $lastRead.To.AddDays(-1) } else { $windows[0].From.AddDays(-1) })
  } elseif ($state.streams.interactions.noNewRows) {
    "PAX found no new Copilot activity, and SharePoint's files are up to date."
  } else {
    "SharePoint's files are up to date."
  }
  if ($agents.warning) { $state.lastMessage += ' ' + $agents.warning }
  Write-Host $state.lastMessage
  $script:ExitCode = 0
}

function Invoke-Upload {
  $script:Cfg = Read-RefreshConfig $script:ConfigPath
  if (-not (Test-Path -LiteralPath $script:UploadPath -PathType Leaf)) { throw "There's no file at $($script:UploadPath)." }
  $name = if ($RemoteName) { $RemoteName } else { Split-Path -Leaf $script:UploadPath }
  if (-not (Test-FileName $name)) { throw "SharePoint can't use '$name' as a file name." }
  $subfolder = @(Split-FolderPath $RemoteFolder)
  foreach ($segment in $subfolder) {
    if (-not (Test-FileName $segment)) { throw "SharePoint can't use '$segment' as a folder name." }
  }
  if (-not $subfolder -and $name -in @($script:Cfg.files.Values)) {
    throw "The scheduled refresh keeps $name in this folder, so -Upload won't replace it. Use -RemoteFolder for a subfolder, or -RemoteName for another name."
  }
  Get-AppSecret
  Connect-Graph
  Resolve-Drive
  $segments = @(Get-FolderSegments $RemoteFolder)
  Confirm-RemoteFolder $segments
  Send-File -Path $script:UploadPath -Name $name -Segments $segments
  Write-Host "Uploaded $name to /$($segments -join '/') in the SharePoint library."
}

function Invoke-Check {
  $script:Cfg = Read-RefreshConfig $script:ConfigPath
  Get-AppSecret
  Connect-Graph
  Resolve-Drive
  $segments = @(Get-FolderSegments)
  Confirm-RemoteFolder $segments
  return [ordered]@{ ok = $true; siteId = $script:Cfg.siteId; driveId = $script:Cfg.driveId; folder = '/' + ($segments -join '/') }
}

function Write-CheckResult {
  # One line, last and plain ASCII, so the installer can read it under anything the scripts
  # printed, whatever the console's code page.
  param($Result)
  [Console]::Out.WriteLine(($Result | ConvertTo-Json -Compress -EscapeHandling EscapeNonAscii))
}

$script:ConfigPath = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($Config)
if (-not (Test-Path -LiteralPath $script:ConfigPath -PathType Leaf)) {
  $missing = "There's no refresh config at $($script:ConfigPath). $script:RepairHint"
  if ($PSCmdlet.ParameterSetName -eq 'Check') { Write-CheckResult ([ordered]@{ ok = $false; error = $missing }) }
  else { Write-Host "ERROR: $missing" }
  exit 1
}
$script:Root = Split-Path -Parent $script:ConfigPath
$script:DataDir = Join-Path $script:Root 'data'
$script:WorkDir = Join-Path $script:Root 'work'
$script:LogsDir = Join-Path $script:Root 'logs'
$script:StatePath = Join-Path $script:Root 'state.json'
if ($PSBoundParameters.ContainsKey('Days')) { $script:DaysOverride = $Days }

if ($PSCmdlet.ParameterSetName -eq 'Check') {
  # Like -Upload, a check keeps no state and doesn't wait for a scheduled refresh.
  try {
    $checkResult = Invoke-Check
    $script:ExitCode = 0
  } catch {
    $checkResult = [ordered]@{ ok = $false; error = $_.Exception.Message }
    if ($script:LastGraphStatus) { $checkResult.status = $script:LastGraphStatus }
    $script:ExitCode = 1
  } finally {
    $script:Secret = $null
    $script:GraphToken = $null
  }
  Write-CheckResult $checkResult
  exit $script:ExitCode
}

if ($PSCmdlet.ParameterSetName -eq 'Upload') {
  $script:UploadPath = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($Upload)
  try {
    Invoke-Upload
    $script:ExitCode = 0
  } catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    $script:ExitCode = 1
  } finally {
    $script:Secret = $null
    $script:GraphToken = $null
  }
  exit $script:ExitCode
}

if (-not (Enter-RunLock)) {
  Write-Host 'Another refresh is running, so this one stopped. The next scheduled run starts as usual.'
  exit 2
}
try {
  Start-RunLog
  Initialize-State
  Invoke-Refresh
} catch {
  Write-Host "ERROR: $($_.Exception.Message)"
  if ($script:State) {
    $script:State.lastResult = 'failed'
    $script:State.lastError = $_.Exception.Message
  }
  $script:ExitCode = 1
} finally {
  Complete-Progress
  Save-State
  try { Remove-OldFiles } catch { Write-Warning "Removing old files failed: $($_.Exception.Message)" }
  Stop-RunLog
  $script:Secret = $null
  $script:GraphToken = $null
  $script:Lock.Dispose()
}
exit $script:ExitCode
