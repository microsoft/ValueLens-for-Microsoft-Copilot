<#
.SYNOPSIS
  Export the Agent 365 registry (Copilot agent catalogue) as the canonical
  ValueLens "Agent 365" CSV.

.DESCRIPTION
  Produces the same columns, names, mappings and row rules as the Fabric notebook
  1. Fabric/Manual setup/notebooks/Copilot_Agent365_Registry_Ingester.ipynb, so the Local CSV,
  SharePoint and Power Automate + Dataverse templates read exactly the registry
  the Fabric template reads from dbo.agents_365:

    1. List    GET /v1.0/copilot/admin/catalog/packages (falls back to /beta on 404)
    2. Detail  GET .../packages/{id} for every package (usage metrics, elementDetails)
    3. Creator ownerId -> /users (tier 1), then appId / agentIdentityId ->
               servicePrincipal owners (tier 2). The notebook's tier 3 (earliest
               audit-log event) needs the Lakehouse, so it is Fabric-only here.
    4. Shape   Title ID prefixed T_, one row per Title ID, fixed column order.

  All of the paging, detail calls and creator resolution happen here, once per
  run, so the template's Power Query only reads a finished CSV.

  The templates still accept the PAX -IncludeAgent365Info export and the admin
  centre Agents export, but PAX's 28-column export carries no Entra Agent ID,
  Publisher, Is Blocked or creator attribution, so the Agent Lifecycle and agent
  linking work best from this script's output.

.PARAMETER OutputCsv
  Output path. Default: .\Agents365Registry.csv. Point the template's "Agent 365"
  parameter at this file (Local CSV) or at its SharePoint URL once uploaded.

.PARAMETER Auth
  Auto (default): AppRegistration when -ClientId is supplied, otherwise Interactive.
  AppRegistration: app-only client credentials, runs unattended. Needs the
  Application permissions below, admin-consented.
  Interactive: delegated sign-in through Microsoft.Graph.Authentication.

.PARAMETER TenantId
.PARAMETER ClientId
.PARAMETER ClientSecret
  App registration details for -Auth AppRegistration. If -ClientSecret is omitted
  the secret is read from $env:AIBV_CLIENT_SECRET, then the Windows Credential
  Manager target "PAX-AIBV-<TenantId>" (the Run-PAX-AIBV.ps1 convention), then a
  prompt.

.PARAMETER ApiVersion
  v1.0 (default) or beta. v1.0 falls back to beta automatically on a 404.

.PARAMETER SkipDetail
  List call only. Faster, but usage metrics, Bot Id, Element types and Custom
  actions stay blank.

.PARAMETER FullDetailRefreshDays
  Maximum age, in days, of a cached detail. Default 7. The list is pulled in full on
  every run, but details are fetched only for agents that are new, whose
  lastModifiedDateTime changed, that have no cache entry, or whose cached detail is
  older than this; the rest reuse the detail cached in <OutputCsv>.detailcache.jsonl
  with today's list fields over it. Usage fields (Active Users, Total sessions, Last
  Activity Date) of a reused detail can therefore be up to this many days old. 0
  fetches every detail on every run.

.PARAMETER CheckpointEvery
  Successful detail calls are appended to the detail cache every this many calls
  (default 1000) and again if the run fails or is stopped, so a rerun after a failure
  fetches only what is still missing. A first run on a large tenant has no cache, so
  this is what stops one failure from discarding thousands of fetched details.

.PARAMETER ProgressEvery
  Print a progress line with an ETA every this many detail calls. Default 500.

.PARAMETER SkipCreatorResolution
  Do not resolve Agent creator UPN. Every row is then "unattributed".

.PARAMETER AllowEmpty
  Allow writing a header-only CSV when the catalogue returns no agents and the
  output file does not exist yet. An existing file is never replaced by an empty
  snapshot.

.EXAMPLE
  .\Get-Agents365Registry.ps1 -TenantId <guid> -ClientId <guid>

.EXAMPLE
  .\Get-Agents365Registry.ps1 -Auth Interactive -OutputCsv .\processed\Agents365Registry.csv

.NOTES
  Permissions (Application for AppRegistration, delegated for Interactive):
    CopilotPackages.Read.All  the catalogue
    Application.Read.All      tier 2 creator resolution
    User.Read.All             tier 1 creator resolution
  The tenant also needs an Agent 365 licence. That is a SKU check, separate from
  permissions: a missing licence returns 403 "Customer must be licensed for Agent 365".
  Point-in-time snapshot: deleted agents disappear on the next run. The detail cache
  (<OutputCsv>.detailcache.jsonl) is checkpointed during the detail pull with freshly
  fetched detail only, then rewritten after the CSV is written, keeping only agents in
  the current list. It can be deleted at any time to force a full detail refresh.
  Missing detail: an agent whose detail call fails (424 Failed Dependency, 404, 403, or
  a 429 / 5xx / network error after retries) falls back to its cached detail if it has
  one. If not, it is written list-only - usage, Bot Id and capability columns blank -
  with a warning that counts the failures by reason, is left out of the cache and is
  retried on the next run. This never stops the export, unless every detail call failed
  with 401 or 403 and nothing is cached: sign-in or consent is broken, so no CSV is
  written. 404 and 424 are not retried within a run.
#>
[CmdletBinding()]
param(
  [string]$OutputCsv = '.\Agents365Registry.csv',
  [ValidateSet('Auto', 'AppRegistration', 'Interactive')]
  [string]$Auth = 'Auto',
  [string]$TenantId,
  [string]$ClientId,
  [string]$ClientSecret,
  [ValidateSet('v1.0', 'beta')]
  [string]$ApiVersion = 'v1.0',
  [switch]$SkipDetail,
  [ValidateRange(0, 365)]
  [int]$FullDetailRefreshDays = 7,
  [ValidateRange(1, 1000000)]
  [int]$CheckpointEvery = 1000,
  [ValidateRange(1, 1000000)]
  [int]$ProgressEvery = 500,
  [switch]$SkipCreatorResolution,
  [switch]$AllowEmpty
)

$ErrorActionPreference = 'Stop'

# Column order of dbo.agents_365 as written by the Fabric ingester: its CANONICAL list,
# the two creator columns, then the remaining mapped columns in the order it adds them.
$script:RegistryColumns = @(
  'Agent name', 'Supported in', 'Date created', 'Agent creator', 'Publisher',
  'Agent type (A365)', 'Version', 'Availability', 'Agent creator ID',
  'Agent description', 'Created in', 'Last updated', 'Custom actions',
  'Title ID', 'Sensitivity',
  'Can read OneDrive and Sharepoint items', 'OneDrive and Sharepoint items',
  'Can read OneDrive files', 'OneDrive files', 'OneDrive sites',
  'Can read Sharepoint sites and files', 'Sharepoint files', 'Sharepoint sites',
  'Can extend to Graph connector', 'Graph connector details',
  'Can generate images using user prompt', 'Can use code interpreter',
  'Contains uploaded files', 'Uploaded files', 'Status',
  'Active Users', 'Total sessions', 'Exception rate', 'Last Activity Date',
  'Deployment', 'Run Time', 'Risks',
  'Agent creator UPN', 'Agent creator source',
  'Entra Agent ID', 'Bot Id', 'App Id', 'Asset Id', 'Categories', 'Is Blocked',
  'Users shared', 'Groups shared', 'Element types'
)

$script:GraphMode = $null
$script:Token = $null
$script:TokenExpiry = [datetime]::MinValue
$script:ElementSkips = @{}

#############################################################
# Graph access
#############################################################

function Resolve-Secret {
  param([string]$Provided, [string]$TenantId)
  if ($Provided) { return $Provided }
  if ($env:AIBV_CLIENT_SECRET) { return $env:AIBV_CLIENT_SECRET }
  try {
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class _A365Cred {
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
    $fromCm = [_A365Cred]::Get("PAX-AIBV-$TenantId")
    if ($fromCm) { return $fromCm }
  } catch { }
  $secure = Read-Host -Prompt "Client secret for app $ClientId" -AsSecureString
  return [System.Net.NetworkCredential]::new('', $secure).Password
}

function Connect-Registry {
  param([string]$Mode, [string]$TenantId, [string]$ClientId, [string]$ClientSecret)
  if ($Mode -eq 'Auto') { $Mode = if ($ClientId) { 'AppRegistration' } else { 'Interactive' } }
  $script:GraphMode = $Mode
  if ($Mode -eq 'AppRegistration') {
    if (-not $TenantId -or -not $ClientId) { throw '-Auth AppRegistration needs -TenantId and -ClientId.' }
    $script:AppTenant = $TenantId
    $script:AppClient = $ClientId
    $script:AppSecret = Resolve-Secret -Provided $ClientSecret -TenantId $TenantId
    [void](Get-AppToken)
    Write-Host 'Signed in app-only (client credentials).'
    return
  }
  if (-not (Get-Module -ListAvailable -Name 'Microsoft.Graph.Authentication')) {
    Write-Host 'Installing module: Microsoft.Graph.Authentication...'
    Install-Module -Name 'Microsoft.Graph.Authentication' -Force -AllowClobber -Scope CurrentUser
  }
  $connect = @{ Scopes = @('CopilotPackages.Read.All', 'Application.Read.All', 'User.Read.All'); NoWelcome = $true }
  if ($TenantId) { $connect.TenantId = $TenantId }
  Connect-MgGraph @connect
  Write-Host 'Signed in interactively (delegated).'
}

function Get-AppToken {
  # Client-credential tokens last about an hour and a large catalogue makes one
  # request per package, so re-mint shortly before expiry rather than once per run.
  if ($script:Token -and [datetime]::UtcNow -lt $script:TokenExpiry) { return $script:Token }
  $body = @{
    client_id     = $script:AppClient
    client_secret = $script:AppSecret
    scope         = 'https://graph.microsoft.com/.default'
    grant_type    = 'client_credentials'
  }
  $resp = Invoke-RestMethod -Method POST -Body $body `
    -Uri "https://login.microsoftonline.com/$($script:AppTenant)/oauth2/v2.0/token"
  $life = 3600
  if ($resp.expires_in) { $life = [int]$resp.expires_in }
  $script:Token = $resp.access_token
  $script:TokenExpiry = [datetime]::UtcNow.AddSeconds([Math]::Max($life - 300, 60))
  return $script:Token
}

function Get-HttpStatus {
  param($ErrorRecord)
  $resp = $ErrorRecord.Exception.Response
  if ($resp -and $resp.StatusCode) { return [int]$resp.StatusCode }
  if ("$($ErrorRecord.Exception.Message)" -match '\b([45]\d\d)\b') { return [int]$Matches[1] }
  return 0
}

function Test-TransientNetworkError {
  # True for a timeout or dropped connection that never produced an HTTP response.
  param($ErrorRecord)
  # Matched by name: Windows PowerShell 5.1 does not load System.Net.Http by default.
  $names = 'System.TimeoutException', 'System.Threading.Tasks.TaskCanceledException',
           'System.Net.Http.HttpRequestException', 'System.IO.IOException', 'System.Net.Sockets.SocketException'
  $ex = $ErrorRecord.Exception
  while ($ex) {
    $name = $ex.GetType().FullName
    if ($names -contains $name) { return $true }
    if ($name -eq 'System.Net.WebException' -and $null -eq $ex.Response) { return $true }
    $ex = $ex.InnerException
  }
  return $false
}

function Get-RetryAfterSeconds {
  # Graph's Retry-After header when present (seconds, capped at 60), else 2^attempt.
  param($ErrorRecord, [int]$Attempt)
  $fallback = [int][Math]::Pow(2, $Attempt)
  $value = $null
  try {
    $resp = $ErrorRecord.Exception.Response
    if ($resp -and $resp.Headers) {
      if ($resp.Headers -is [System.Net.WebHeaderCollection]) {
        $value = $resp.Headers['Retry-After']
      } elseif ($resp.Headers.RetryAfter) {
        if ($resp.Headers.RetryAfter.Delta) { $value = [Math]::Ceiling($resp.Headers.RetryAfter.Delta.TotalSeconds) }
      }
    }
  } catch { $value = $null }
  $seconds = 0
  if ($null -ne $value -and [int]::TryParse("$value".Trim(), [ref]$seconds) -and $seconds -ge 0) {
    return [int][Math]::Min(60, [Math]::Max(1, $seconds))
  }
  return $fallback
}

function Invoke-Graph {
  # One Graph call with a live token. Retries once on 401 (expired token), and up to
  # five times on 429/5xx or a network timeout / dropped connection, honouring
  # Retry-After; anything else is rethrown with the HTTP status attached.
  param([string]$Method = 'GET', [string]$Uri, $Body)
  for ($attempt = 1; ; $attempt++) {
    try {
      $call = @{ Method = $Method; Uri = $Uri }
      if ($null -ne $Body) {
        $call.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $call.ContentType = 'application/json'
      }
      if ($script:GraphMode -eq 'AppRegistration') {
        $call.Headers = @{ Authorization = ('Bearer ' + (Get-AppToken)) }
        return Invoke-RestMethod @call
      }
      return Invoke-MgGraphRequest @call
    } catch {
      $status = Get-HttpStatus $_
      if ($status -eq 401 -and $attempt -eq 1 -and $script:GraphMode -eq 'AppRegistration') {
        $script:Token = $null
        continue
      }
      $transient = $status -eq 429 -or $status -ge 500 -or ($status -eq 0 -and (Test-TransientNetworkError $_))
      if ($transient -and $attempt -lt 6) {
        Start-Sleep -Seconds ([Math]::Min(60, (Get-RetryAfterSeconds $_ $attempt)))
        continue
      }
      $err = [System.Exception]::new("Graph $Method $Uri failed (HTTP $status): $($_.Exception.Message)", $_.Exception)
      $err.Data['HttpStatus'] = $status
      throw $err
    }
  }
}

function Invoke-GraphOrNull {
  param([string]$Method = 'GET', [string]$Uri, $Body)
  try { return Invoke-Graph -Method $Method -Uri $Uri -Body $Body } catch { return $null }
}

#############################################################
# Value helpers (mirror the notebook's str()/join rules)
#############################################################

function Get-Field {
  # Invoke-RestMethod returns objects and Invoke-MgGraphRequest hashtables; read both.
  # The leading comma stops PowerShell unrolling a one-item array into a scalar.
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return , $Object[$Name] }
    return $null
  }
  $p = $Object.PSObject.Properties[$Name]
  if ($p) { return , $p.Value }
  return $null
}

function Get-FieldNames {
  param($Object)
  if ($null -eq $Object) { return @() }
  if ($Object -is [System.Collections.IDictionary]) { return @($Object.Keys) }
  return @($Object.PSObject.Properties | ForEach-Object { $_.Name })
}

function ConvertTo-Text {
  # Python str(value or ''): null, false, 0 and '' become ''. Dates the JSON parser
  # turned into DateTime go back to ISO-8601 UTC.
  param($Value)
  if ($null -eq $Value) { return '' }
  if ($Value -is [bool]) { if ($Value) { return 'True' } else { return '' } }
  if ($Value -is [datetimeoffset]) { return $Value.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.FFFFFFFZ', [cultureinfo]::InvariantCulture) }
  if ($Value -is [datetime]) {
    $d = $Value
    if ($d.Kind -eq [DateTimeKind]::Unspecified) { $d = [datetime]::SpecifyKind($d, [DateTimeKind]::Utc) }
    return $d.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.FFFFFFFZ', [cultureinfo]::InvariantCulture)
  }
  if ($Value -is [string]) { return $Value }
  if ($Value -is [System.ValueType]) {
    if ($Value -eq 0) { return '' }
    return [System.Convert]::ToString($Value, [cultureinfo]::InvariantCulture)
  }
  return ($Value | ConvertTo-Json -Depth 10 -Compress)
}

function Test-IsRecord {
  # A JSON object from either parser. [pscustomobject] alone is not enough: it also
  # matches any PSObject-wrapped value, such as a string that came down the pipeline.
  param($Value)
  return ($Value -is [System.Collections.IDictionary]) -or ($Value -is [System.Management.Automation.PSCustomObject])
}

function Get-Items {
  # A collection field as an array to loop over. Use it as (Get-Items ...), never
  # @(Get-Items ...) or @(Get-Field ...): @() would wrap the array a second time.
  param($Object, [string]$Name)
  $v = Get-Field $Object $Name
  if ($null -eq $v) { return , @() }
  return , @($v)
}

function Test-IsList {
  param($Value)
  return ($Value -is [System.Collections.IList]) -and -not ($Value -is [System.Collections.IDictionary])
}

function Join-Values {
  param($Value)
  if ($null -eq $Value) { return '' }
  if (-not (Test-IsList $Value)) { return (ConvertTo-Text $Value) }
  $out = foreach ($item in $Value) {
    if ($null -eq $item) { continue }
    if ((Test-IsRecord $item) -or (Test-IsList $item)) {
      $item | ConvertTo-Json -Depth 10 -Compress
    } else { ConvertTo-Text $item }
  }
  return (@($out) -join ';')
}

function Join-Access {
  param($Value)
  if ($null -eq $Value) { return '' }
  if (-not (Test-IsList $Value)) { $Value = @($Value) }
  $out = foreach ($item in $Value) {
    if (Test-IsRecord $item) {
      $n = Get-Field $item 'displayName'
      if (-not $n) { $n = Get-Field $item 'id' }
      if (-not $n) { $n = $item | ConvertTo-Json -Depth 10 -Compress }
      "$n"
    } elseif ($null -ne $item) { "$item" }
  }
  return (@($out) -join ';')
}

function Add-ElementSkip {
  param([string]$Reason)
  if ($script:ElementSkips.ContainsKey($Reason)) { $script:ElementSkips[$Reason]++ } else { $script:ElementSkips[$Reason] = 1 }
}

function Get-ElementSummary {
  # elementDetails -> (element types, bot ids, custom action titles). Vendor payloads
  # vary, so a malformed entry is counted and skipped rather than failing the run.
  param($Detail)
  $types = [System.Collections.Generic.List[string]]::new()
  $bots = [System.Collections.Generic.List[string]]::new()
  $commands = [System.Collections.Generic.List[string]]::new()
  $groups = Get-Field $Detail 'elementDetails'
  if ($null -ne $groups) {
    if (-not (Test-IsList $groups)) { Add-ElementSkip 'elementDetails is not a list'; $groups = @() }
    foreach ($group in $groups) {
      if (-not (Test-IsRecord $group)) { Add-ElementSkip 'group is not an object'; continue }
      $elementType = Get-Field $group 'elementType'
      if ($elementType) { $types.Add("$elementType") }
      $elements = Get-Field $group 'elements'
      if ($null -eq $elements) { continue }
      if (-not (Test-IsList $elements)) { Add-ElementSkip 'elements is not a list'; continue }
      foreach ($element in $elements) {
        if (-not (Test-IsRecord $element)) { Add-ElementSkip 'element is not an object'; continue }
        $definition = Get-Field $element 'definition'
        if ($null -eq $definition -or "$definition" -eq '') { continue }
        if ($definition -is [string]) {
          try { $definition = $definition | ConvertFrom-Json } catch { Add-ElementSkip 'definition is not valid JSON'; continue }
        }
        if (-not (Test-IsRecord $definition)) { Add-ElementSkip 'definition did not decode to an object'; continue }
        $botId = Get-Field $definition 'botId'
        if ($botId) { $bots.Add("$botId") }
        foreach ($commandList in (Get-Items $definition 'commandLists')) {
          if ($null -eq $commandList) { continue }
          if (-not (Test-IsRecord $commandList)) { Add-ElementSkip 'commandLists entry is not an object'; continue }
          foreach ($command in (Get-Items $commandList 'commands')) {
            $title = Get-Field $command 'title'
            if ($title) { $commands.Add("$title") }
          }
        }
        foreach ($command in (Get-Items $definition 'commands')) {
          $title = Get-Field $command 'title'
          if ($title) { $commands.Add("$title") }
        }
      }
    }
  }
  $unique = { param($list) (@($list | Select-Object -Unique) -join ';') }
  return @((& $unique $types), (& $unique $bots), (& $unique $commands))
}

function Get-TitleId {
  param($Detail)
  $raw = Get-Field $Detail 'id'
  if (-not $raw) { $raw = Get-Field $Detail 'titleId' }
  if (-not $raw) { $raw = Get-Field $Detail 'packageId' }
  if (-not $raw) { throw 'Agent 365 package is missing id/titleId/packageId.' }
  $raw = "$raw"
  if ($raw.StartsWith('T_') -or $raw.StartsWith('P_')) { return $raw }
  return "T_$raw"
}

#############################################################
# Catalogue
#############################################################

function Get-CatalogBase {
  param([string]$Version)
  return "https://graph.microsoft.com/$Version/copilot/admin/catalog/packages"
}

function Get-AgentPackages {
  param([string]$Version)
  $base = Get-CatalogBase $Version
  try {
    [void](Invoke-Graph -Uri "$base`?`$top=1")
  } catch {
    $status = $_.Exception.Data['HttpStatus']
    if ($status -eq 404 -and $Version -eq 'v1.0') {
      Write-Host 'v1.0 catalogue not available in this tenant yet - using beta.' -ForegroundColor Yellow
      return Get-AgentPackages -Version 'beta'
    }
    if ($status -eq 403) {
      throw ('403: Agent 365 catalogue not accessible. The tenant needs an Agent 365 LICENCE (a SKU check) ' +
             'and the app needs admin-consented CopilotPackages.Read.All.')
    }
    if ($status -eq 401) {
      throw '401 after a token refresh: check admin consent for CopilotPackages.Read.All + Application.Read.All + User.Read.All.'
    }
    throw
  }
  Write-Host "Using $Version catalogue endpoint."

  $packages = [System.Collections.Generic.List[object]]::new()
  $seen = @{}
  $uri = $base
  for ($page = 1; $page -le 500; $page++) {
    if ($seen.ContainsKey($uri)) { throw "Agent 365 catalogue paging loop detected at page $page." }
    $seen[$uri] = $true
    $resp = Invoke-Graph -Uri $uri
    $value = Get-Field $resp 'value'
    if ($null -eq $value) { throw "Agent 365 catalogue page $page is missing 'value'." }
    foreach ($item in @($value)) { $packages.Add($item) }
    $uri = Get-Field $resp '@odata.nextLink'
    if (-not $uri) {
      return [pscustomobject]@{ Version = $Version; Base = $base; Packages = $packages }
    }
  }
  throw 'Agent 365 catalogue exceeded the 500-page safety cap.'
}

function Merge-Detail {
  # List item overlaid with its detail payload; detail wins, as in the notebook.
  param($Package, $Detail)
  $merged = [ordered]@{}
  foreach ($k in (Get-FieldNames $Package)) { $merged[$k] = Get-Field $Package $k }
  foreach ($k in (Get-FieldNames $Detail)) { $merged[$k] = Get-Field $Detail $k }
  return $merged
}

#############################################################
# Detail cache (incremental detail fetch)
#############################################################

function ConvertTo-StampKey {
  # lastModifiedDateTime as a comparable UTC string, whichever JSON parser read it.
  param($Value)
  $text = ConvertTo-Text $Value
  if (-not $text) { return '' }
  $parsed = [datetimeoffset]::MinValue
  if ([datetimeoffset]::TryParse($text, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
    return $parsed.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.FFFFFFFZ', [cultureinfo]::InvariantCulture)
  }
  return $text.Trim()
}

function Get-DetailCachePath {
  param([string]$CsvPath)
  return "$CsvPath.detailcache.jsonl"
}

function Read-DetailCache {
  # JSON lines: a header {apiVersion}, then one {id, lastModified, detailAsOfUtc,
  # detail, creatorUpn, creatorSource} per agent; a later line for the same id wins,
  # which is how mid-run checkpoints are appended. A missing, unreadable or
  # other-API-version cache reads as empty, so every detail is fetched; a single
  # corrupt line (say, a checkpoint cut off mid-write) is skipped.
  param([string]$Path, [string]$Version)
  $agents = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $agents }
  try {
    $lines = [System.IO.File]::ReadAllLines($Path, [System.Text.UTF8Encoding]::new($false))
    if ($lines.Count -eq 0) { return $agents }
    if ("$(Get-Field ($lines[0] | ConvertFrom-Json) 'apiVersion')" -ne $Version) { return @{} }
    for ($i = 1; $i -lt $lines.Count; $i++) {
      if (-not $lines[$i].Trim()) { continue }
      try { $entry = $lines[$i] | ConvertFrom-Json } catch { continue }
      $id = "$(Get-Field $entry 'id')"
      if ($id) { $agents[$id] = $entry }
    }
    return $agents
  } catch {
    Write-Host "detail cache unreadable ($($_.Exception.Message)); fetching every detail" -ForegroundColor Yellow
    return @{}
  }
}

function Test-NeedsDetail {
  # Fetch when the agent is uncached, its cache entry has no detail, the list's
  # lastModifiedDateTime differs from the cached one (newer or older), or the cached
  # detail is older than the cutoff - the weekly refresh that keeps usage fields fresh.
  param($Package, $Entry, [datetime]$CutoffUtc)
  if ($null -eq $Entry) { return $true }
  if ($null -eq (Get-Field $Entry 'detail')) { return $true }
  if ((ConvertTo-StampKey (Get-Field $Package 'lastModifiedDateTime')) -ne (ConvertTo-StampKey (Get-Field $Entry 'lastModified'))) { return $true }
  $asOf = [datetimeoffset]::MinValue
  $stamp = ConvertTo-StampKey (Get-Field $Entry 'detailAsOfUtc')
  if (-not $stamp -or -not [datetimeoffset]::TryParse($stamp, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$asOf)) { return $true }
  return ($asOf.UtcDateTime -lt $CutoffUtc)
}

function Write-DetailCache {
  # Full rewrite, after the CSV, for agents in today's list only, so deleted agents
  # drop out and checkpoint lines are compacted. Mid-run checkpoints
  # (Add-DetailCacheEntries) only ever add freshly fetched detail.
  param([string]$Path, [string]$Version, $Entries)
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add(([ordered]@{ apiVersion = $Version } | ConvertTo-Json -Compress))
  foreach ($entry in $Entries) { $lines.Add(($entry | ConvertTo-Json -Depth 50 -Compress)) }
  $tmp = "$Path.tmp"
  [System.IO.File]::WriteAllLines($tmp, $lines, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Add-DetailCacheEntries {
  # Mid-run checkpoint: append freshly fetched entries (later lines win on read). Starts
  # a new file when there is none, or when the existing one is for another API version.
  param([string]$Path, [string]$Version, $Entries)
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($entry in $Entries) { $lines.Add(($entry | ConvertTo-Json -Depth 50 -Compress)) }
  if ($lines.Count -eq 0) { return }
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $header = $null
  if (Test-Path -LiteralPath $Path) {
    try {
      $first = [System.IO.File]::ReadAllLines($Path, $utf8) | Select-Object -First 1
      $header = "$(Get-Field ($first | ConvertFrom-Json) 'apiVersion')"
    } catch { $header = $null }
  }
  if ($header -ne $Version) { Write-DetailCache -Path $Path -Version $Version -Entries @() }
  [System.IO.File]::AppendAllLines($Path, $lines, $utf8)
}

function Format-Duration {
  param([double]$Seconds)
  $t = [timespan]::FromSeconds([Math]::Max(0, [Math]::Round($Seconds)))
  if ($t.TotalHours -ge 1) { return ('{0}h {1:00}m' -f [int][Math]::Floor($t.TotalHours), $t.Minutes) }
  if ($t.TotalMinutes -ge 1) { return ('{0}m {1:00}s' -f $t.Minutes, $t.Seconds) }
  return ('{0}s' -f $t.Seconds)
}

#############################################################
# Creator resolution
#############################################################

function Resolve-OwnerIds {
  # Tier 1: ownerId -> userPrincipalName, 15 lookups per $batch.
  param([string[]]$OwnerIds)
  $resolved = @{}
  $ids = @($OwnerIds | Where-Object { $_ } | Select-Object -Unique)
  for ($i = 0; $i -lt $ids.Count; $i += 15) {
    $chunk = $ids[$i..([Math]::Min($i + 14, $ids.Count - 1))]
    $n = 0
    $requests = foreach ($oid in $chunk) {
      @{ id = "$n"; method = 'GET'; url = "/users/$oid`?`$select=id,userPrincipalName" }
      $n++
    }
    $resp = Invoke-GraphOrNull -Method POST -Uri 'https://graph.microsoft.com/v1.0/$batch' -Body @{ requests = @($requests) }
    if ($null -eq $resp) { Write-Host '  tier1: batch failed - skipping chunk' -ForegroundColor Yellow; continue }
    foreach ($item in (Get-Items $resp 'responses')) {
      if ([int](Get-Field $item 'status') -ne 200) { continue }
      $body = Get-Field $item 'body'
      $id = Get-Field $body 'id'
      $upn = ("$(Get-Field $body 'userPrincipalName')").Trim().ToLowerInvariant()
      if ($id -and $upn) { $resolved["$id"] = $upn }
    }
  }
  return $resolved
}

$script:SpCache = @{}
function Resolve-SpOwner {
  # Tier 2: the first owner with a UPN of the agent's service principal.
  param([string]$AppId, [string]$AgentIdentityId)
  $key = "$AppId|$AgentIdentityId"
  if ($script:SpCache.ContainsKey($key)) { return $script:SpCache[$key] }
  $result = ''
  foreach ($pair in @(@($AppId, $true), @($AgentIdentityId, $false))) {
    $ident = $pair[0]
    if (-not $ident -or $result) { continue }
    $uri = if ($pair[1]) { "https://graph.microsoft.com/v1.0/servicePrincipals(appId='$ident')" }
           else { "https://graph.microsoft.com/v1.0/servicePrincipals/$ident" }
    $sp = Invoke-GraphOrNull -Uri $uri
    $spId = Get-Field $sp 'id'
    if (-not $spId) { continue }
    $owners = Invoke-GraphOrNull -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/owners?`$select=id,userPrincipalName"
    foreach ($owner in (Get-Items $owners 'value')) {
      $upn = ("$(Get-Field $owner 'userPrincipalName')").Trim().ToLowerInvariant()
      if ($upn) { $result = $upn; break }
    }
  }
  $script:SpCache[$key] = $result
  return $result
}

#############################################################
# Shaping and output
#############################################################

function ConvertTo-RegistryRow {
  param($Detail, [string]$TitleId, [string]$CreatorUpn, [string]$CreatorSource)
  $summary = Get-ElementSummary $Detail
  $elementTypes = $summary[0]
  if (-not $elementTypes) { $elementTypes = Join-Values (Get-Field $Detail 'elementTypes') }
  $description = ConvertTo-Text (Get-Field $Detail 'shortDescription')
  if (-not $description) { $description = ConvertTo-Text (Get-Field $Detail 'longDescription') }
  $row = [ordered]@{}
  foreach ($c in $script:RegistryColumns) { $row[$c] = '' }
  $row['Agent name'] = ConvertTo-Text (Get-Field $Detail 'displayName')
  $row['Title ID'] = $TitleId
  $row['Version'] = ConvertTo-Text (Get-Field $Detail 'version')
  $row['Entra Agent ID'] = ConvertTo-Text (Get-Field $Detail 'agentIdentityId')
  $row['Bot Id'] = $summary[1]
  $row['App Id'] = ConvertTo-Text (Get-Field $Detail 'appId')
  $row['Asset Id'] = ConvertTo-Text (Get-Field $Detail 'assetId')
  $row['Publisher'] = ConvertTo-Text (Get-Field $Detail 'publisher')
  $row['Agent creator'] = ConvertTo-Text (Get-Field $Detail 'publisher')
  $row['Agent creator ID'] = ConvertTo-Text (Get-Field $Detail 'ownerId')
  $row['Agent type (A365)'] = ConvertTo-Text (Get-Field $Detail 'type')
  $row['Created in'] = ConvertTo-Text (Get-Field $Detail 'platform')
  $row['Date created'] = ConvertTo-Text (Get-Field $Detail 'createdDateTime')
  $row['Last updated'] = ConvertTo-Text (Get-Field $Detail 'lastModifiedDateTime')
  $row['Agent description'] = $description
  $row['Categories'] = Join-Values (Get-Field $Detail 'categories')
  $row['Supported in'] = Join-Values (Get-Field $Detail 'supportedHosts')
  $row['Availability'] = ConvertTo-Text (Get-Field $Detail 'availableTo')
  $row['Status'] = ConvertTo-Text (Get-Field $Detail 'deployedTo')
  $row['Is Blocked'] = ConvertTo-Text (Get-Field $Detail 'isBlocked')
  $row['Users shared'] = Join-Access (Get-Field $Detail 'sharedWithUsersAndGroups')
  $row['Groups shared'] = Join-Access (Get-Field $Detail 'allowedUsersAndGroups')
  $row['Element types'] = $elementTypes
  $row['Custom actions'] = $summary[2]
  $row['Active Users'] = ConvertTo-Text (Get-Field $Detail 'activeUsers')
  $row['Total sessions'] = ConvertTo-Text (Get-Field $Detail 'totalSessions')
  $row['Exception rate'] = ConvertTo-Text (Get-Field $Detail 'exceptionRate')
  $row['Run Time'] = ConvertTo-Text (Get-Field $Detail 'totalRunTimeInHours')
  $row['Last Activity Date'] = ConvertTo-Text (Get-Field $Detail 'lastUsedDateTime')
  $row['Agent creator UPN'] = $CreatorUpn
  $row['Agent creator source'] = if ($CreatorSource) { $CreatorSource } else { 'unattributed' }
  return $row
}

function Select-UniqueRows {
  # One row per Title ID (case-insensitive). An identical repeat is dropped; two
  # different rows for one Title ID stop the run rather than guess.
  param($Rows)
  $seen = @{}
  $out = [System.Collections.Generic.List[object]]::new()
  foreach ($row in $Rows) {
    $key = "$($row['Title ID'])".Trim().ToUpperInvariant()
    if (-not $key) { throw 'Agent 365 row is missing Title ID; refusing to write an ambiguous snapshot.' }
    $sig = (@($script:RegistryColumns | ForEach-Object { "$($row[$_])".Trim() }) -join [string][char]0x1F)
    if ($seen.ContainsKey($key)) {
      if ($seen[$key] -ne $sig) { throw "Conflicting Agent 365 rows for '$key'; refusing to overwrite a good snapshot." }
      continue
    }
    $seen[$key] = $sig
    $out.Add($row)
  }
  return , $out
}

function Write-RegistryCsv {
  param($Rows, [string]$Path)
  $quote = { param($v) '"' + ("$v" -replace '"', '""') + '"' }
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add((@($script:RegistryColumns | ForEach-Object { & $quote $_ }) -join ','))
  foreach ($row in $Rows) {
    $lines.Add((@($script:RegistryColumns | ForEach-Object { & $quote $row[$_] }) -join ','))
  }
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = "$Path.tmp"
  [System.IO.File]::WriteAllLines($tmp, $lines, [System.Text.UTF8Encoding]::new($true))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Export-Agents365Registry {
  param([string]$OutputCsvPath, [string]$Version, [switch]$NoDetail, [switch]$NoCreators, [switch]$AllowEmptySnapshot,
        [int]$FullRefreshDays = 7, [int]$CheckpointEvery = 1000, [int]$ProgressEvery = 500)
  if (-not [System.IO.Path]::IsPathRooted($OutputCsvPath)) {
    $OutputCsvPath = Join-Path -Path (Get-Location -PSProvider FileSystem).ProviderPath -ChildPath $OutputCsvPath
  }
  $OutputCsvPath = [System.IO.Path]::GetFullPath($OutputCsvPath)
  $script:ElementSkips = @{}
  $nowUtc = [datetime]::UtcNow
  $cachePath = Get-DetailCachePath $OutputCsvPath

  $catalog = Get-AgentPackages -Version $Version
  Write-Host "packages in catalogue: $($catalog.Packages.Count)"

  $cache = @{}
  $cutoffUtc = $nowUtc
  if (-not $NoDetail) {
    $cache = Read-DetailCache -Path $cachePath -Version $Version
    if ($FullRefreshDays -gt 0) { $cutoffUtc = $nowUtc.AddDays(-$FullRefreshDays) } else { $cutoffUtc = [datetime]::MaxValue }
    Write-Host "detail: $($cache.Count) cached; re-fetching new, modified and older-than-$FullRefreshDays-day agents"
  }

  # Pass 1: which agents need a detail call.
  $plan = [System.Collections.Generic.List[object]]::new()
  foreach ($package in $catalog.Packages) {
    $id = Get-Field $package 'id'
    if (-not $id) { $id = Get-Field $package 'titleId' }
    if (-not $id) { $id = Get-Field $package 'packageId' }
    if (-not $id) { throw 'Agent 365 catalogue item is missing id/titleId/packageId.' }
    $id = "$id"
    $entry = if ($cache.ContainsKey($id)) { $cache[$id] } else { $null }
    $need = (-not $NoDetail) -and (Test-NeedsDetail $package $entry $cutoffUtc)
    $plan.Add(@{ Id = $id; Package = $package; Entry = $entry; Need = $need })
  }
  $toFetch = @($plan | Where-Object { $_.Need }).Count
  if ($toFetch) {
    Write-Host "detail calls needed: $toFetch of $($plan.Count) - expected duration roughly $(Format-Duration ($toFetch * 0.5)) at ~0.5s per call"
    Write-Host "successful calls are checkpointed to the detail cache every $CheckpointEvery; if this run fails or is stopped, rerun it and only what is missing is fetched"
  }

  # Pass 2: fetch (checkpointing each success), fall back to cache, or mark missing.
  $details = [System.Collections.Generic.List[object]]::new()
  $meta = [System.Collections.Generic.List[object]]::new()
  $checkpointBatch = [System.Collections.Generic.List[object]]::new()
  $failures = @{}
  $done = 0
  $started = [datetime]::UtcNow
  try {
    foreach ($p in $plan) {
      $package = $p.Package; $id = $p.Id; $entry = $p.Entry
      if ($NoDetail) { $details.Add((Merge-Detail $package $null)); $meta.Add($null); continue }
      $refetchFailed = $false
      if ($p.Need) {
        $detail = $null; $reason = $null
        try {
          $detail = Invoke-Graph -Uri "$($catalog.Base)/$id"
        } catch {
          $status = $_.Exception.Data['HttpStatus']
          if (-not $status) { $status = Get-HttpStatus $_ }
          $cause = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }
          $reason = if ($status) { "HTTP $status" } else { $cause.GetType().Name }
          $failures[$reason] = 1 + [int]$failures[$reason]
        }
        $done++
        if ($done % $ProgressEvery -eq 0 -or $done -eq $toFetch) {
          $elapsed = ([datetime]::UtcNow - $started).TotalSeconds
          $rate = if ($elapsed -gt 0) { $done / $elapsed } else { 0 }
          $eta = if ($rate -gt 0) { Format-Duration (($toFetch - $done) / $rate) } else { 'unknown' }
          $failed = [int](@($failures.Values) | Measure-Object -Sum).Sum
          Write-Host ("  detail calls {0}/{1} ({2:0}%) | {3:0.0}/s | failed {4} | elapsed {5} | ETA {6}" -f $done, $toFetch, ($done * 100 / $toFetch), $rate, $failed, (Format-Duration $elapsed), $eta)
        }
        if ($null -eq $reason) {
          # Fresh detail goes over the list fields.
          $lastModified = ConvertTo-StampKey (Get-Field $package 'lastModifiedDateTime')
          $details.Add((Merge-Detail $package $detail))
          $meta.Add(@{ Id = $id; Fetched = $true; Detail = $detail; AsOf = $nowUtc; Entry = $entry; Status = 'fetched'
                       LastModified = $lastModified })
          # Checkpoint entries carry no creator, so the creator tiers run for them.
          $checkpointBatch.Add([ordered]@{ id = $id; lastModified = $lastModified; detailAsOfUtc = (ConvertTo-Text $nowUtc)
                                           creatorUpn = ''; creatorSource = ''; detail = $detail })
          if ($checkpointBatch.Count -ge $CheckpointEvery) {
            try { Add-DetailCacheEntries -Path $cachePath -Version $Version -Entries @($checkpointBatch); $checkpointBatch.Clear() }
            catch { Write-Host "detail checkpoint failed ($($_.Exception.Message)); retrying with the next batch" -ForegroundColor Yellow }
          }
          continue
        }
        if ($null -eq $entry -or $null -eq (Get-Field $entry 'detail')) {
          # No detail and nothing cached: list-only row, never cached, retried next run.
          $details.Add((Merge-Detail $package $null))
          $meta.Add(@{ Id = $id; Fetched = $false; Missing = $true; Status = "missing ($reason)"; Reason = $reason })
          continue
        }
        # Refetch failed: fall back to the cached detail, keeping the cached
        # lastModified so the change is retried next run rather than marked as seen.
        $refetchFailed = $true
      }
      # Cached detail, with today's list fields over it.
      $cachedDetail = Get-Field $entry 'detail'
      $details.Add((Merge-Detail $cachedDetail $package))
      $meta.Add(@{ Id = $id; Fetched = $false; Detail = $cachedDetail; AsOf = (Get-Field $entry 'detailAsOfUtc'); Entry = $entry
                   Status = $(if ($refetchFailed) { 'cached - refetch failed' } else { 'cached' })
                   LastModified = (ConvertTo-StampKey (Get-Field $entry 'lastModified')) })
    }
  } finally {
    if ($checkpointBatch.Count) {
      try { Add-DetailCacheEntries -Path $cachePath -Version $Version -Entries @($checkpointBatch) }
      catch { Write-Host "detail checkpoint failed ($($_.Exception.Message))" -ForegroundColor Yellow }
    }
  }
  if (-not $NoDetail) {
    $fetched = @($meta | Where-Object { $_.Fetched }).Count
    Write-Host "details fetched: $fetched, reused from cache: $(@($meta | Where-Object { -not $_.Fetched -and -not $_.Missing }).Count)"
    $census = ($failures.Keys | Sort-Object { -$failures[$_] }, { $_ } | ForEach-Object { "$_ x$($failures[$_])" }) -join ', '
    if ($failures.Count) {
      Write-Host "detail calls that returned no detail (429, 5xx and network errors after retries; 404 and 424 are not retried): $census" -ForegroundColor Yellow
    }
    $authOnly = $failures.Count -and -not @($failures.Keys | Where-Object { $_ -notin 'HTTP 401', 'HTTP 403' }).Count
    if ($authOnly -and $meta.Count -and -not @($meta | Where-Object { -not $_.Missing }).Count) {
      throw ("Every Agent 365 detail call failed with HTTP 401/403 ($census) and there is no cached detail to fall back on, " +
             "so the CSV is not written: it would carry no detail at all. This is a sign-in or consent problem, not a per-agent one - " +
             "check that CopilotPackages.Read.All is granted and admin-consented, then rerun.")
    }
    $missingIds = @($meta | Where-Object { $_.Missing } | ForEach-Object { $_.Id } | Select-Object -Unique)
    if ($missingIds.Count) {
      $byStatus = @{}
      foreach ($m in @($meta | Where-Object { $_.Missing })) { $byStatus[$m.Status] = 1 + [int]$byStatus[$m.Status] }
      $statusCensus = ($byStatus.Keys | Sort-Object { -$byStatus[$_] }, { $_ } | ForEach-Object { "$_ x$($byStatus[$_])" }) -join ', '
      Write-Host ("WARNING: $($missingIds.Count) agent(s) have no detail and no cached copy: written list-only (usage, Bot Id and capability columns blank) " +
                  "and retried next run. By status: $statusCensus. First: $(($missingIds | Select-Object -First 10) -join ', ')") -ForegroundColor Yellow
    }
    $refetchFailedCount = @($meta | Where-Object { $_.Status -eq 'cached - refetch failed' }).Count
    if ($refetchFailedCount) { Write-Host "WARNING: $refetchFailedCount agent(s) kept their cached detail after a failed refetch; retried next run." -ForegroundColor Yellow }
  }

  $titleIds = @($details | ForEach-Object { Get-TitleId $_ })
  $upn = @{}
  $source = @{}
  $settled = @{}
  # Reuse the cached creator for agents whose detail was not re-fetched. Agents cached
  # as unattributed are retried at their next detail fetch, not on every run.
  for ($i = 0; $i -lt $details.Count -and -not $NoCreators; $i++) {
    $m = $meta[$i]
    if ($null -eq $m -or $m.Fetched -or $m.Missing) { continue }
    $cachedSource = "$(Get-Field $m.Entry 'creatorSource')"
    if (-not $cachedSource) { continue }
    $settled[$i] = $true
    $cachedUpn = "$(Get-Field $m.Entry 'creatorUpn')"
    if ($cachedSource -ne 'unattributed' -and $cachedUpn) { $upn[$i] = $cachedUpn; $source[$i] = $cachedSource }
  }
  if (-not $NoCreators -and $details.Count) {
    Write-Host "creators reused from cache: $($settled.Count)"
    $ownerIds = @($details | ForEach-Object { "$(Get-Field $_ 'ownerId')" })
    $pending = @(for ($i = 0; $i -lt $details.Count; $i++) { if ($ownerIds[$i] -and -not $settled.ContainsKey($i)) { $ownerIds[$i] } })
    Write-Host "tier1: ownerId populated on $(@($ownerIds | Where-Object { $_ }).Count)/$($details.Count) agents, $($pending.Count) to resolve"
    $before = $upn.Count
    if ($pending.Count) {
      $map = Resolve-OwnerIds $pending
      for ($i = 0; $i -lt $details.Count; $i++) {
        if ($settled.ContainsKey($i)) { continue }
        if ($ownerIds[$i] -and $map.ContainsKey($ownerIds[$i])) { $upn[$i] = $map[$ownerIds[$i]]; $source[$i] = 'ownerId' }
      }
    }
    Write-Host "tier1: resolved $($upn.Count - $before)"
    $before = $upn.Count
    for ($i = 0; $i -lt $details.Count; $i++) {
      if ($upn.ContainsKey($i) -or $settled.ContainsKey($i)) { continue }
      $owner = Resolve-SpOwner -AppId "$(Get-Field $details[$i] 'appId')" -AgentIdentityId "$(Get-Field $details[$i] 'agentIdentityId')"
      if ($owner) { $upn[$i] = $owner; $source[$i] = 'servicePrincipalOwner' }
    }
    Write-Host "tier2: resolved $($upn.Count - $before) more"
    $unattributed = $details.Count - $upn.Count
    if ($unattributed) { Write-Host "unattributed: $unattributed (left-join these; do not drop them)" }
  }

  $rows = for ($i = 0; $i -lt $details.Count; $i++) {
    ConvertTo-RegistryRow -Detail $details[$i] -TitleId $titleIds[$i] -CreatorUpn "$($upn[$i])" -CreatorSource "$($source[$i])"
  }
  $rows = Select-UniqueRows @($rows)

  if ($rows.Count -eq 0) {
    if (Test-Path -LiteralPath $OutputCsvPath) { throw "Fetched 0 Agent 365 rows; refusing to replace existing $OutputCsvPath." }
    if (-not $AllowEmptySnapshot) { throw "Fetched 0 Agent 365 rows. Re-run with -AllowEmpty only for an intentional empty first export." }
  }
  Write-RegistryCsv -Rows $rows -Path $OutputCsvPath

  if (-not $NoDetail) {
    $entries = for ($i = 0; $i -lt $details.Count; $i++) {
      $m = $meta[$i]
      if ($m.Missing) { continue }   # list-only: nothing to cache, retried next run
      if ($NoCreators) {
        # Creators were not resolved this run: keep whatever the cache already had.
        $cUpn = "$(Get-Field $m.Entry 'creatorUpn')"
        $cSource = if ($m.Fetched) { '' } else { "$(Get-Field $m.Entry 'creatorSource')" }
      } else {
        $cUpn = "$($upn[$i])"
        $cSource = if ($source.ContainsKey($i)) { $source[$i] } else { 'unattributed' }
      }
      [ordered]@{ id = $m.Id; lastModified = $m.LastModified; detailAsOfUtc = (ConvertTo-Text $m.AsOf)
                  creatorUpn = $cUpn; creatorSource = $cSource; detail = $m.Detail }
    }
    Write-DetailCache -Path $cachePath -Version $Version -Entries @($entries)
  }

  if ($script:ElementSkips.Count) {
    Write-Host "elementDetails entries skipped: $((@($script:ElementSkips.Values) | Measure-Object -Sum).Sum)" -ForegroundColor Yellow
    foreach ($k in ($script:ElementSkips.Keys | Sort-Object)) { Write-Host ("   {0,-44} {1}" -f $k, $script:ElementSkips[$k]) }
  }
  Write-Host "Exported $($rows.Count) agents ($($script:RegistryColumns.Count) columns) to: $OutputCsvPath" -ForegroundColor Green
  return $OutputCsvPath
}

#############################################################
# Main (skipped when dot-sourced, so the functions can be tested)
#############################################################

if ($MyInvocation.InvocationName -ne '.') {
  Connect-Registry -Mode $Auth -TenantId $TenantId -ClientId $ClientId -ClientSecret $ClientSecret
  [void](Export-Agents365Registry -OutputCsvPath $OutputCsv -Version $ApiVersion `
    -NoDetail:$SkipDetail -NoCreators:$SkipCreatorResolution -AllowEmptySnapshot:$AllowEmpty `
    -FullRefreshDays $FullDetailRefreshDays -CheckpointEvery $CheckpointEvery -ProgressEvery $ProgressEvery)
}
