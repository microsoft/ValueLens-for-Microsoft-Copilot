<#
.SYNOPSIS
    Capture full Microsoft Graph CopilotInteraction audit records and (optionally)
    retain each full payload in Dataverse.

.DESCRIPTION
    Runs a Graph auditLog query for a UTC date window, streams every full record to
    a JSONL file, and can idempotently upsert each full record into the companion
    raw table (poc_valuelensrawaudits).

    Safety properties:
      * All date inputs are normalised to UTC; the window must be non-empty.
      * The poll loop is bounded by -TimeoutSeconds; unknown/failed query status throws.
      * When -ExecuteDataverseWrite is set, Dataverse readiness is validated BEFORE the
        expensive Graph query so credential problems fail fast.
      * Paging follows only nextLink values whose host is graph.microsoft.com; the
        Authorization header is never sent to an unexpected origin.
      * Output is written atomically to a temp file and moved into place only on success;
        an existing output file is never deleted before the new capture completes.
      * Row keys are toLower(GUID) of the audit id to align idempotence with the
        Power Automate flow. poc_payloadhash is SHA-256 of the exact payload.
      * No secrets are written to logs.

.NOTES
    No cloud writes occur unless -ExecuteDataverseWrite is passed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ClientId,

    [string]$ClientSecret = $env:GRAPH_CLIENT_SECRET,
    [string]$GraphAccessToken = $env:GRAPH_ACCESS_TOKEN,

    [Parameter(Mandatory)]
    [datetime]$StartDate,

    [Parameter(Mandatory)]
    [datetime]$EndDate,

    [string]$OutJsonl = (Join-Path $PSScriptRoot "..\processed\copilotinteraction-raw.jsonl"),

    [string]$DataverseUrl,
    [string]$DataverseToken = $env:DATAVERSE_TOKEN,
    [string]$RawTable = "poc_valuelensrawaudits",

    [ValidateRange(1, 600)]
    [int]$PollSeconds = 20,

    [ValidateRange(30, 86400)]
    [int]$TimeoutSeconds = 900,

    [switch]$ExecuteDataverseWrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$GraphHost = 'graph.microsoft.com'
$MemoMax = 1048576

# --- Input validation ------------------------------------------------------
$startUtc = $StartDate.ToUniversalTime()
$endUtc = $EndDate.ToUniversalTime()
if ($endUtc -le $startUtc) {
    throw "EndDate must be after StartDate (UTC). Start=$($startUtc.ToString('o')) End=$($endUtc.ToString('o'))."
}

function Assert-StrictHttpsHost {
    param([string]$Url, [string]$ExpectedHost, [string]$Name)
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "$Name is not a valid absolute URL."
    }
    if ($uri.Scheme -ne 'https') { throw "$Name must use https." }
    if ($uri.UserInfo) { throw "$Name must not contain user-info credentials." }
    if ($ExpectedHost -and ($uri.Host -ne $ExpectedHost)) {
        throw "$Name host '$($uri.Host)' is not the expected '$ExpectedHost'."
    }
    return $uri
}

function Assert-DataverseReady {
    if (-not $DataverseUrl) { throw "Dataverse raw write requires -DataverseUrl." }
    if (-not $DataverseToken) { throw "Dataverse raw write requires -DataverseToken (or `$env:DATAVERSE_TOKEN)." }
    $uri = $null
    if (-not [System.Uri]::TryCreate($DataverseUrl, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "DataverseUrl is not a valid absolute URL."
    }
    if ($uri.Scheme -ne 'https') { throw "DataverseUrl must use https." }
    if ($uri.UserInfo) { throw "DataverseUrl must not contain user-info credentials." }
}

function Invoke-JsonRequest {
    param(
        [string]$Method,
        [string]$Uri,
        [hashtable]$Headers,
        $Body
    )
    $bodyJson = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 50 -Compress } else { $null }
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            if ($bodyJson) {
                return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -Body $bodyJson -ContentType "application/json"
            }
            return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
        }
        catch {
            $resp = $_.Exception.Response
            $status = if ($resp) { $resp.StatusCode.value__ } else { 0 }
            if ($status -notin @(429, 500, 502, 503, 504) -or $attempt -eq 4) { throw }
            Start-Sleep -Seconds ([math]::Pow(2, $attempt))
        }
    }
}

function Get-GraphToken {
    if ($GraphAccessToken) { return $GraphAccessToken }
    if (-not $ClientSecret) { throw "Pass -GraphAccessToken or -ClientSecret (or set the matching env vars)." }
    $body = @{
        client_id     = $ClientId
        client_secret = $ClientSecret
        scope         = "https://graph.microsoft.com/.default"
        grant_type    = "client_credentials"
    }
    $token = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" -Body $body
    return $token.access_token
}

function ConvertTo-AuditRowKey {
    param([string]$Id)
    $g = [guid]::Empty
    if (-not [guid]::TryParse($Id, [ref]$g)) {
        throw "Audit record id '$Id' is not a GUID; cannot build a stable cross-collector row key."
    }
    return $g.ToString('D').ToLowerInvariant()
}

function Get-PayloadHash {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
        return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
    }
    finally {
        $sha.Dispose()
    }
}

function Write-DataverseRawRow {
    param(
        [string]$PayloadJson,
        [string]$RecordId,
        [string]$RunId
    )
    if (-not $ExecuteDataverseWrite) { return }
    if ($PayloadJson.Length -gt $MemoMax) {
        throw "Raw payload for audit id '$RecordId' is $($PayloadJson.Length) chars, exceeding the memo max of $MemoMax."
    }
    $key = ConvertTo-AuditRowKey $RecordId
    $uri = $DataverseUrl.TrimEnd("/") + "/api/data/v9.2/$RawTable(poc_rowkey='$key')"
    $body = [ordered]@{
        poc_rowkey      = $key
        poc_runid       = $RunId
        poc_name        = $RecordId
        poc_payloadhash = (Get-PayloadHash $PayloadJson)
        poc_payloadjson = $PayloadJson
    }
    Invoke-JsonRequest -Method Patch -Uri $uri -Headers @{
        Authorization      = "Bearer $DataverseToken"
        Accept             = "application/json"
        "OData-Version"    = "4.0"
        "OData-MaxVersion" = "4.0"
    } -Body $body | Out-Null
}

# --- Preflight (fail fast before the expensive Graph query) ----------------
if ($ExecuteDataverseWrite) { Assert-DataverseReady }

$runId = "raw-capture-" + $startUtc.ToString('yyyyMMddTHHmmssZ')

$graphToken = Get-GraphToken
$headers = @{ Authorization = "Bearer $graphToken"; Accept = "application/json" }
$queryBody = @{
    displayName         = "ValueLens CopilotInteraction raw capture"
    filterStartDateTime = $startUtc.ToString("o")
    filterEndDateTime   = $endUtc.ToString("o")
    operationFilters    = @("CopilotInteraction")
}

$query = Invoke-JsonRequest -Method Post -Uri "https://$GraphHost/v1.0/security/auditLog/queries" -Headers $headers -Body $queryBody
$queryId = $query.id
if (-not $queryId) { throw "Graph did not return an auditLog query id." }

# --- Bounded poll loop -----------------------------------------------------
$runningStatuses = @('notStarted', 'running', 'queued', 'inProgress')
$deadline = (Get-Date).ToUniversalTime().AddSeconds($TimeoutSeconds)
$status = ''
do {
    Start-Sleep -Seconds $PollSeconds
    $query = Invoke-JsonRequest -Method Get -Uri "https://$GraphHost/v1.0/security/auditLog/queries/$queryId" -Headers $headers
    $status = "$($query.status)"
    if ([string]::IsNullOrWhiteSpace($status)) {
        throw "Graph auditLog query $queryId returned an empty/unknown status."
    }
    if (((Get-Date).ToUniversalTime() -gt $deadline) -and ($status -in $runningStatuses)) {
        throw "Timed out after ${TimeoutSeconds}s waiting for auditLog query $queryId (last status '$status')."
    }
} while ($status -in $runningStatuses)

if ($status -ne 'succeeded') {
    throw "Graph auditLog query $queryId ended with unexpected status '$status'."
}

# --- Atomic output setup ---------------------------------------------------
$outDir = Split-Path -Parent $OutJsonl
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
$tempOut = "$OutJsonl.partial"
if (Test-Path -LiteralPath $tempOut) { Remove-Item -LiteralPath $tempOut -Force }

$count = 0
try {
    $next = "https://$GraphHost/v1.0/security/auditLog/queries/$queryId/records"
    while ($next) {
        # Only follow nextLink values that stay on the Graph host; never leak the token elsewhere.
        [void](Assert-StrictHttpsHost -Url $next -ExpectedHost $GraphHost -Name 'auditLog records nextLink')
        $page = Invoke-JsonRequest -Method Get -Uri $next -Headers $headers
        foreach ($record in $page.value) {
            $payload = $record | ConvertTo-Json -Depth 100 -Compress
            Add-Content -LiteralPath $tempOut -Value $payload -Encoding utf8
            Write-DataverseRawRow -PayloadJson $payload -RecordId $record.id -RunId $runId
            $count++
        }
        $next = $page.'@odata.nextLink'
    }
}
catch {
    if (Test-Path -LiteralPath $tempOut) { Remove-Item -LiteralPath $tempOut -Force }
    throw
}

# Success: atomically replace any existing output.
Move-Item -LiteralPath $tempOut -Destination $OutJsonl -Force

Write-Host "Captured $count full CopilotInteraction audit records to $OutJsonl"
if ($ExecuteDataverseWrite) {
    Write-Host "Upserted $count raw records into $RawTable (runId $runId)."
}
elseif ($DataverseUrl) {
    Write-Host "Dataverse write was not executed. Re-run with -ExecuteDataverseWrite after approval."
}
