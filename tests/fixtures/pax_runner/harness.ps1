# Runs refresh.ps1 in-process against stand-ins, for test_pax_runner.py. Nothing reaches
# Entra ID, Microsoft Graph or SharePoint:
#   - Invoke-RestMethod and Invoke-WebRequest are functions here, which PowerShell runs in
#     place of the cmdlets. Graph's drive API works on an in-memory library.
#   - credential.ps1, Run-PAX-AIBV.ps1 and Upload-Rollups-SharePoint.ps1 next to refresh.ps1
#     are stubs that keep the real scripts' param blocks.
#   - python is a function that reports the version a run asks for.
# The case file holds:
#   root       the install folder, which holds refresh.json
#   runner     the copy of refresh.ps1 to run
#   caseDir    where each run's state.json is copied, as state-run<n>.json
#   emptyPath  a folder with no programs, used as PATH when Python is missing
#   holdLock   true to hold refresh.lock for the whole case
#   tokenError true to fail every sign-in as Entra ID does for a wrong secret
#   remote     the library's items by path: { folder, content, modified, size }
#   status     forced HTTP statuses, keyed GET:<path> or POST:<parent>/<name>, or
#              GET:sites/<site> and GET:sites/<site ID>/drives for the site lookups
#   sites      Graph sites by the ID or path form the runner asks for: { id, webUrl }
#   drives     each site's document libraries by Graph site ID, one per page: [{ id, name, webUrl }]
#   runs       each run's { args, env, python }; python is ok, old, store or none
param(
  [Parameter(Mandatory = $true)] [string]$CasePath,
  [Parameter(Mandatory = $true)] [string]$ResultPath
)

$ErrorActionPreference = 'Stop'

$global:HarnessCase = Get-Content -LiteralPath $CasePath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
$global:HarnessCalls = [System.Collections.Generic.List[object]]::new()
$global:HarnessDownloads = [System.Collections.Generic.List[object]]::new()
$global:HarnessStatus = @{}
$global:HarnessRemote = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)

function global:ConvertTo-HarnessPath {
  param([string]$Path)
  return (@($Path -split '/' | Where-Object { $_ }) -join '/')
}

function global:Set-HarnessItem {
  # Adds or replaces an item, and any missing folders above it.
  param([string]$Path, [hashtable]$Item)
  $Path = ConvertTo-HarnessPath $Path
  $segments = @($Path -split '/')
  for ($i = 0; $i -lt $segments.Count - 1; $i++) {
    $parent = $segments[0..$i] -join '/'
    if (-not $global:HarnessRemote.ContainsKey($parent)) { $global:HarnessRemote[$parent] = @{ folder = $true } }
  }
  $global:HarnessRemote[$Path] = $Item
}

function global:New-HarnessError {
  param([string]$Code, [string]$Message)
  return @{ error = @{ code = $Code; message = $Message } }
}

if ($HarnessCase.Contains('status') -and $HarnessCase.status) {
  foreach ($key in $HarnessCase.status.Keys) { $global:HarnessStatus[$key] = [int]$HarnessCase.status[$key] }
}
if ($HarnessCase.Contains('remote') -and $HarnessCase.remote) {
  foreach ($key in $HarnessCase.remote.Keys) {
    $item = @{}
    foreach ($property in $HarnessCase.remote[$key].Keys) { $item[$property] = $HarnessCase.remote[$key][$property] }
    Set-HarnessItem -Path $key -Item $item
  }
}

function global:Invoke-RestMethod {
  [CmdletBinding()]
  param(
    [string]$Method = 'Get',
    [string]$Uri,
    $Headers,
    $Body,
    [string]$ContentType,
    [switch]$SkipHttpErrorCheck,
    [string]$StatusCodeVariable
  )
  if ($Uri -match '^https://login\.microsoftonline\.com/(?<tenant>[^/]+)/oauth2/v2\.0/token$') {
    $global:HarnessCalls.Add([ordered]@{
        kind      = 'token'
        method    = $Method.ToUpperInvariant()
        tenant    = $Matches['tenant']
        clientId  = [string]$Body.client_id
        secretOk  = ([string]$Body.client_secret -ceq 'stub-secret')
        scope     = [string]$Body.scope
        grantType = [string]$Body.grant_type
      })
    if ($global:HarnessCase.Contains('tokenError') -and $global:HarnessCase.tokenError) {
      $exception = [System.Net.Http.HttpRequestException]::new('Response status code does not indicate success: 401 (Unauthorized).')
      $record = [System.Management.Automation.ErrorRecord]::new($exception, 'WebCmdletWebResponseException',
        [System.Management.Automation.ErrorCategory]::InvalidOperation, $Uri)
      $description = 'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.' +
        "`r`nTrace ID: 00000000-0000-0000-0000-000000000000`r`nCorrelation ID: 00000000-0000-0000-0000-000000000000"
      $json = [ordered]@{ error = 'invalid_client'; error_description = $description } | ConvertTo-Json -Compress
      $record.ErrorDetails = [System.Management.Automation.ErrorDetails]::new($json)
      $PSCmdlet.ThrowTerminatingError($record)
    }
    return [pscustomobject]@{ token_type = 'Bearer'; access_token = 'stub-token' }
  }

  if ($Uri -match '^https://graph\.microsoft\.com/v1\.0/sites/(?<rest>[^?]+)(?:\?(?<query>.*))?$') {
    $rest = $Matches['rest']
    $query = [string]$Matches['query']
    $call = [ordered]@{
      kind   = 'site'
      method = $Method.ToUpperInvariant()
      path   = $rest
      query  = $query
      status = 0
      authOk = (@($Headers.Values) -contains 'Bearer stub-token')
    }
    if ($call.method -ne 'GET') { throw "Harness: unexpected request $Method $Uri" }
    $sites = if ($global:HarnessCase.Contains('sites') -and $global:HarnessCase.sites) { $global:HarnessCase.sites } else { @{} }
    $drives = if ($global:HarnessCase.Contains('drives') -and $global:HarnessCase.drives) { $global:HarnessCase.drives } else { @{} }
    if ($global:HarnessStatus.ContainsKey("GET:sites/$rest")) {
      $status = $global:HarnessStatus["GET:sites/$rest"]
      $result = New-HarnessError 'accessDenied' 'Access denied'
    } elseif ($rest -match '^(?<site>.+)/drives$') {
      $site = $Matches['site']
      if (-not $drives.Contains($site)) {
        $status = 404
        $result = New-HarnessError 'itemNotFound' 'Requested site could not be found'
      } else {
        # One library per page, so the runner has to follow nextLink.
        $page = if ($query -match '(?:^|&)\$skiptoken=(?<n>\d+)') { [int]$Matches['n'] } else { 0 }
        $all = @($drives[$site])
        $status = 200
        $result = @{ value = @($all | Select-Object -Skip $page -First 1) }
        if ($page + 1 -lt $all.Count) {
          $result['@odata.nextLink'] = "https://graph.microsoft.com/v1.0/sites/$site/drives?`$select=id,name,webUrl&`$skiptoken=$($page + 1)"
        }
      }
    } elseif ($sites.Contains($rest)) {
      $status = 200
      $result = @{ id = $sites[$rest].id; webUrl = $sites[$rest].webUrl }
    } else {
      $status = 404
      $result = New-HarnessError 'itemNotFound' 'Requested site could not be found'
    }
    $call.status = $status
    $global:HarnessCalls.Add($call)
    if ($StatusCodeVariable) { Set-Variable -Name $StatusCodeVariable -Value $status -Scope 1 }
    if ($status -ge 400 -and -not $SkipHttpErrorCheck) { throw "Harness: HTTP $status for $Method $Uri" }
    return ($result | ConvertTo-Json -Depth 6 | ConvertFrom-Json)
  }

  if ($Uri -notmatch '^https://graph\.microsoft\.com/v1\.0/drives/(?<drive>[^/]+)/root(?<rest>.*)$') {
    throw "Harness: unexpected request $Method $Uri"
  }
  $rest = $Matches['rest']
  $call = [ordered]@{
    kind        = 'graph'
    method      = $Method.ToUpperInvariant()
    drive       = $Matches['drive']
    path        = $null
    name        = $null
    status      = 0
    authOk      = (@($Headers.Values) -contains 'Bearer stub-token')
    conflict    = $null
    folderFacet = $null
  }
  if ($call.method -eq 'GET') {
    if ($rest -eq '') {
      $path = ''
    } elseif ($rest -match '^:/(?<path>.+)$') {
      $path = ConvertTo-HarnessPath ([uri]::UnescapeDataString($Matches['path']))
    } else {
      throw "Harness: unexpected request $Method $Uri"
    }
    $call.path = $path
    $item = if ($path -and $global:HarnessRemote.ContainsKey($path)) { $global:HarnessRemote[$path] } else { $null }
    if ($global:HarnessStatus.ContainsKey("GET:$path")) {
      $status = $global:HarnessStatus["GET:$path"]
      $result = New-HarnessError 'accessDenied' 'Access denied'
    } elseif ($path -eq '') {
      $status = 200
      $result = @{ name = 'root'; root = @{}; folder = @{ childCount = 0 } }
    } elseif (-not $item) {
      $status = 404
      $result = New-HarnessError 'itemNotFound' 'The resource could not be found.'
    } elseif ($item.folder) {
      $status = 200
      $result = @{ name = ($path -split '/')[-1]; folder = @{ childCount = 0 } }
    } else {
      $status = 200
      $content = [string]$item.content
      $size = if ($item.Contains('size')) { [long]$item.size } else { [System.Text.Encoding]::UTF8.GetByteCount($content) }
      $modified = [DateTimeOffset]::FromUnixTimeSeconds([long]$item.modified).UtcDateTime
      $result = @{
        name                           = ($path -split '/')[-1]
        size                           = $size
        lastModifiedDateTime           = $modified.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [cultureinfo]::InvariantCulture)
        '@microsoft.graph.downloadUrl' = 'https://download.invalid/' + [uri]::EscapeDataString($path)
        file                           = @{}
      }
    }
  } elseif ($call.method -eq 'POST') {
    if ($rest -notmatch '^(?::/(?<path>.+):)?/children$') { throw "Harness: unexpected request $Method $Uri" }
    $parentPath = if ($Matches['path']) { ConvertTo-HarnessPath ([uri]::UnescapeDataString($Matches['path'])) } else { '' }
    $request = [string]$Body | ConvertFrom-Json -AsHashtable
    $name = [string]$request['name']
    $path = if ($parentPath) { "$parentPath/$name" } else { $name }
    $call.path = $parentPath
    $call.name = $name
    $call.conflict = $request['@microsoft.graph.conflictBehavior']
    $call.folderFacet = ($request['folder'] -is [System.Collections.IDictionary])
    $parent = if ($parentPath -and $global:HarnessRemote.ContainsKey($parentPath)) { $global:HarnessRemote[$parentPath] } else { $null }
    if ($global:HarnessStatus.ContainsKey("POST:$path")) {
      $status = $global:HarnessStatus["POST:$path"]
      $result = New-HarnessError 'accessDenied' 'Access denied'
    } elseif ($parentPath -and -not ($parent -and $parent.folder)) {
      $status = 404
      $result = New-HarnessError 'itemNotFound' 'The resource could not be found.'
    } elseif ($global:HarnessRemote.ContainsKey($path)) {
      $status = 409
      $result = New-HarnessError 'nameAlreadyExists' 'An item with the same name already exists under the parent.'
    } else {
      Set-HarnessItem -Path $path -Item @{ folder = $true }
      $status = 201
      $result = @{ name = $name; folder = @{ childCount = 0 } }
    }
  } else {
    throw "Harness: unexpected request $Method $Uri"
  }
  $call.status = $status
  $global:HarnessCalls.Add($call)
  # The cmdlet sets this variable in its caller's scope.
  if ($StatusCodeVariable) { Set-Variable -Name $StatusCodeVariable -Value $status -Scope 1 }
  if ($status -ge 400 -and -not $SkipHttpErrorCheck) { throw "Harness: HTTP $status for $Method $Uri" }
  return ($result | ConvertTo-Json -Depth 6 | ConvertFrom-Json)
}

function global:Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [string]$OutFile)
  if ($Uri -notmatch '^https://download\.invalid/(?<path>.+)$') { throw "Harness: unexpected download $Uri" }
  $path = [uri]::UnescapeDataString($Matches['path'])
  $global:HarnessDownloads.Add([ordered]@{ path = $path; outFile = $OutFile })
  if (-not $global:HarnessRemote.ContainsKey($path)) { throw "Harness: the library has no file $path." }
  $item = $global:HarnessRemote[$path]
  if ($item.Contains('downloadError') -and $item.downloadError) { throw [string]$item.downloadError }
  [System.IO.File]::WriteAllText($OutFile, [string]$item.content, [System.Text.UTF8Encoding]::new($false))
}

$harnessSavedPath = $env:PATH
$harnessLock = $null
$harnessRuns = [System.Collections.Generic.List[object]]::new()
$harnessN = 0
if ($HarnessCase.Contains('holdLock') -and $HarnessCase.holdLock) {
  New-Item -ItemType Directory -Force -Path $HarnessCase.root | Out-Null
  $harnessLock = [System.IO.File]::Open((Join-Path $HarnessCase.root 'refresh.lock'), [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
}
try {
  foreach ($harnessRun in $HarnessCase.runs) {
    $harnessN++
    foreach ($harnessName in 'STUB_MODE', 'STUB_MODES', 'STUB_PAX_EXIT', 'STUB_AGENTS', 'STUB_UPLOAD_FAIL', 'STUB_NO_SECRET') {
      Remove-Item -LiteralPath "Env:$harnessName" -ErrorAction SilentlyContinue
    }
    if ($harnessRun.Contains('env') -and $harnessRun.env) {
      foreach ($harnessName in $harnessRun.env.Keys) { Set-Item -LiteralPath "Env:$harnessName" -Value ([string]$harnessRun.env[$harnessName]) }
    }
    $env:STUB_RUN = [string]$harnessN
    $global:HarnessCalls.Clear()
    $global:HarnessDownloads.Clear()

    Remove-Item -LiteralPath Function:\python -ErrorAction SilentlyContinue
    $harnessPython = if ($harnessRun.Contains('python')) { [string]$harnessRun.python } else { 'ok' }
    switch ($harnessPython) {
      'ok' { function python { $global:LASTEXITCODE = 0; '3.12' } }
      'old' { function python { $global:LASTEXITCODE = 0; '3.9' }; $env:PATH = $HarnessCase.emptyPath }
      # The Microsoft Store's placeholder prints nothing useful and exits 9009.
      'store' { function python { $global:LASTEXITCODE = 9009 }; $env:PATH = $HarnessCase.emptyPath }
      'none' { $env:PATH = $HarnessCase.emptyPath }
      default { throw "Harness: unknown python mode $harnessPython" }
    }

    Write-Host "=== HARNESS RUN $harnessN ==="
    $harnessArgs = @{}
    foreach ($harnessName in $harnessRun.args.Keys) { $harnessArgs[$harnessName] = $harnessRun.args[$harnessName] }
    $harnessError = $null
    $global:LASTEXITCODE = $null
    try {
      & $HarnessCase.runner @harnessArgs
    } catch {
      $harnessError = "HARNESS-ERROR: $($_.Exception.Message)"
      Write-Host $harnessError
    }
    $harnessExit = $global:LASTEXITCODE
    $env:PATH = $harnessSavedPath
    Remove-Item -LiteralPath Function:\python -ErrorAction SilentlyContinue

    $harnessState = Join-Path $HarnessCase.root 'state.json'
    if (Test-Path -LiteralPath $harnessState) {
      Copy-Item -LiteralPath $harnessState -Destination (Join-Path $HarnessCase.caseDir "state-run$harnessN.json") -Force
    }
    $harnessFiles = [ordered]@{}
    if (Test-Path -LiteralPath $HarnessCase.root) {
      $harnessRoot = (Resolve-Path -LiteralPath $HarnessCase.root).Path.TrimEnd('\') + '\'
      foreach ($harnessFile in @(Get-ChildItem -LiteralPath $HarnessCase.root -Recurse -Force -File)) {
        $harnessFiles[$harnessFile.FullName.Substring($harnessRoot.Length).Replace('\', '/')] = $harnessFile.Length
      }
    }
    $harnessRuns.Add([ordered]@{
        run           = $harnessN
        exit          = $harnessExit
        harnessError  = $harnessError
        calls         = @($global:HarnessCalls)
        downloads     = @($global:HarnessDownloads)
        secretCleared = -not (Test-Path -LiteralPath Env:AIBV_CLIENT_SECRET)
        files         = $harnessFiles
      })
  }
} finally {
  if ($harnessLock) { $harnessLock.Dispose() }
}

$harnessRemoteOut = [ordered]@{}
foreach ($harnessKey in @($global:HarnessRemote.Keys | Sort-Object)) {
  $harnessItem = $global:HarnessRemote[$harnessKey]
  $harnessRemoteOut[$harnessKey] = [ordered]@{ folder = [bool]$harnessItem.folder; content = $harnessItem.content }
}
$harnessResult = [ordered]@{
  userName = [Environment]::UserName
  runs     = $harnessRuns.ToArray()
  remote   = $harnessRemoteOut
}
[System.IO.File]::WriteAllText($ResultPath, (ConvertTo-Json -InputObject $harnessResult -Depth 8), [System.Text.UTF8Encoding]::new($false))
