<#
.SYNOPSIS
    Refresh the Power Automate + Dataverse core ValueLens snapshot from Microsoft Graph.

.DESCRIPTION
    Orchestrates the PA+DV alternative data pathway end to end for a single run:

        1. (dry run, default) Validate inputs only. No auth, no network calls, no
           cloud writes of any kind. Prints the plan and exits 0.
        2. (-Execute, opt-in) Acquire a Microsoft Graph app-only token and a
           Dataverse app-only token via client credentials, run
           Export-EntraCoreSnapshot.py to produce a basic-org Entra CSV under
           -WorkRoot, then run Build-DataverseCoreFeeds.py against that CSV with
           --publish dataverse to write the curated poc_valuelensinteractions /
           poc_valuelensusers tables and the poc_valuelensruns manifest row for
           this run id.

    This script is a thin orchestrator; all classification logic lives in the
    existing canonical processor and bridge scripts (unchanged). It never calls
    Power BI or any deployment API — it stops once the Dataverse curated tables
    and run manifest are written, and its only output on success is the run id
    ("Core Snapshot ID"), which a Power BI report parameterized with a required
    "Core Snapshot ID" parameter should be pointed at manually. This script does
    NOT trigger a Power BI dataset refresh and does NOT deploy anything — do not
    describe this as a full, automatic, end-to-end refresh of the dashboard.

.PARAMETER TenantId
    Microsoft Entra tenant id (GUID). Required in both dry-run and -Execute modes
    so the full plan (including the token endpoint that would be used) can be
    validated before anything runs.

.PARAMETER ClientId
    App registration (service principal) client id (GUID) used for both the
    Graph and Dataverse client-credentials token requests.

.PARAMETER EnvironmentUrl
    Dataverse environment URL, e.g. https://contoso.crm.dynamics.com. Must be a
    bare HTTPS *.dynamics.com origin: no path, no query string, no userinfo.

.PARAMETER WorkRoot
    Local working directory for this run's exporter CSV and bridge output. A
    per-run subfolder named after the run id is created underneath it.

.PARAMETER Execute
    Opt-in switch. Without it, the script only validates inputs and prints the
    plan (dry run). With it, the script acquires tokens and calls the exporter
    and bridge scripts for real, publishing to Dataverse.

.PARAMETER RunId
    Optional run id (also used as the "Core Snapshot ID"). Defaults to a new
    GUID. Pass one explicitly to make an -Execute run reproducible/traceable
    from an external orchestrator (e.g. Task Scheduler).

.PARAMETER CopilotSkuId
    Optional additional verified Copilot skuId(s) (GUID) forwarded to the
    exporter's --copilot-sku-id opt-in flag. Repeatable.

.PARAMETER SourceRunId
    Optional collector run id used to scope retained raw audit rows. Use this
    with RawStartUtc/RawEndUtc after a bounded collector run completes, so an
    incomplete wider backfill cannot leak into the curated snapshot.

.PARAMETER RawStartUtc
    Inclusive UTC CreationTime lower bound for retained raw audit rows.

.PARAMETER RawEndUtc
    Inclusive UTC CreationTime upper bound for retained raw audit rows.

.EXAMPLE
    # Dry run (safe default): validates GUIDs/URL and prints the plan only.
    .\Invoke-DataverseCoreRefresh.ps1 -TenantId $tenantId -ClientId $clientId `
        -EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot 'C:\ValueLensRuns'

.EXAMPLE
    # Real run: set the client secret in the environment first (never as a
    # parameter, never persisted to disk by this script), then execute.
    $env:AZURE_CLIENT_SECRET = '<secret>'
    $runId = .\Invoke-DataverseCoreRefresh.ps1 -TenantId $tenantId -ClientId $clientId `
        -EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot 'C:\ValueLensRuns' -Execute
    Remove-Item Env:\AZURE_CLIENT_SECRET
    # $runId is the Core Snapshot ID to enter into the PBIT's "Core Snapshot ID" parameter.

.EXAMPLE
    # Register a recurring Task Scheduler job (the task still only performs an
    # -Execute run when explicitly configured to pass -Execute; scheduling this
    # script does NOT by itself refresh any Power BI report/dataset).
    $action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument (
        '-NoProfile -File "C:\path\to\Invoke-DataverseCoreRefresh.ps1" ' +
        '-TenantId <tenantGuid> -ClientId <clientGuid> ' +
        '-EnvironmentUrl "https://contoso.crm.dynamics.com" -WorkRoot "C:\ValueLensRuns" -Execute'
    )
    $trigger = New-ScheduledTaskTrigger -Daily -At 6am
    Register-ScheduledTask -TaskName 'ValueLens Core Snapshot Refresh' -Action $action -Trigger $trigger
    # AZURE_CLIENT_SECRET must be provisioned for the task's run-as account out of band
    # (e.g. a machine-level environment variable or a secret store the task reads at
    # start) — this script never persists it. The task's captured output is the run id;
    # a human or a separate downstream step is responsible for using it (e.g. updating
    # the "Core Snapshot ID" report parameter). No PBI refresh or deployment is triggered.

.NOTES
    Required environment variable for -Execute: AZURE_CLIENT_SECRET (client secret for
    -ClientId). It is read once, used only in-memory for the token requests, and is
    never echoed, logged, or persisted. GRAPH_ACCESS_TOKEN / DATAVERSE_TOKEN are set as
    process-scoped environment variables for the child script calls and are restored
    (removed or reset to their prior value) in a finally block even if a step fails.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [string]$ClientId,

    [Parameter(Mandatory)]
    [string]$EnvironmentUrl,

    [Parameter(Mandatory)]
    [string]$WorkRoot,

    [switch]$Execute,

    [string]$RunId = [guid]::NewGuid().ToString(),

    [string[]]$CopilotSkuId,

    [string]$SourceRunId,

    [string]$RawStartUtc,

    [string]$RawEndUtc
)

$ErrorActionPreference = 'Stop'

function Test-IsGuid {
    param([string]$Value)
    $parsed = [guid]::Empty
    return [guid]::TryParse($Value, [ref]$parsed)
}

function Assert-ValidGuid {
    param([string]$Name, [string]$Value)
    if (-not (Test-IsGuid $Value)) {
        throw "$Name must be a valid GUID; got '$Value'."
    }
}

function Assert-StrictDataverseUrl {
    <#
        Enforce an HTTPS *.dynamics.com origin with no userinfo, no path beyond
        '/', no query string, and no fragment, so a bearer token is never sent
        to an unexpected or crafted host/path.
    #>
    param([string]$Url)
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "EnvironmentUrl is not a valid absolute URL: '$Url'."
    }
    if ($uri.Scheme -ne 'https') {
        throw "EnvironmentUrl must use https: '$Url'."
    }
    if ($uri.UserInfo) {
        throw "EnvironmentUrl must not embed credentials (userinfo): '$Url'."
    }
    if ($uri.Query) {
        throw "EnvironmentUrl must not include a query string: '$Url'."
    }
    if ($uri.Fragment) {
        throw "EnvironmentUrl must not include a fragment: '$Url'."
    }
    if ($uri.AbsolutePath -ne '/' -and $uri.AbsolutePath -ne '') {
        throw "EnvironmentUrl must not include a path: '$Url'."
    }
    if (-not $uri.Host.ToLowerInvariant().EndsWith('.dynamics.com')) {
        throw "EnvironmentUrl host must be a *.dynamics.com origin: '$Url'."
    }
    return "$($uri.Scheme)://$($uri.Host)"
}

# ---------------------------------------------------------------------------
# Validate every input before doing anything else (dry run and -Execute alike).
# ---------------------------------------------------------------------------
Assert-ValidGuid -Name 'TenantId' -Value $TenantId
Assert-ValidGuid -Name 'ClientId' -Value $ClientId
$dataverseOrigin = Assert-StrictDataverseUrl -Url $EnvironmentUrl
if ($RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$') {
    throw 'RunId must contain 1-100 letters, digits, underscores or hyphens, starting with a letter or digit.'
}
if ($SourceRunId -and $SourceRunId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$') {
    throw 'SourceRunId must contain 1-100 letters, digits, underscores or hyphens, starting with a letter or digit.'
}
if ([bool]$RawStartUtc -ne [bool]$RawEndUtc) {
    throw 'RawStartUtc and RawEndUtc must be supplied together.'
}
if ($RawStartUtc) {
    try {
        $rawStart = [datetimeoffset]::Parse($RawStartUtc).UtcDateTime
        $rawEnd = [datetimeoffset]::Parse($RawEndUtc).UtcDateTime
    } catch {
        throw 'RawStartUtc and RawEndUtc must be ISO-8601 timestamps with UTC timezone information.'
    }
    if ($rawStart -gt $rawEnd) {
        throw 'RawStartUtc must be earlier than or equal to RawEndUtc.'
    }
}

$scriptRoot = $PSScriptRoot
$exporterScript = Join-Path $scriptRoot 'Export-EntraCoreSnapshot.py'
$bridgeScript = Join-Path $scriptRoot 'Build-DataverseCoreFeeds.py'
if (-not (Test-Path $exporterScript)) { throw "Exporter script not found: $exporterScript" }
if (-not (Test-Path $bridgeScript)) { throw "Bridge script not found: $bridgeScript" }

$runDir = Join-Path $WorkRoot $RunId
$entraCsv = Join-Path $runDir 'entra-core-snapshot.csv'

if (-not $Execute) {
    Write-Host "DRY RUN (no -Execute): validated inputs only. No auth, no network calls, no cloud writes were made."
    Write-Host "  TenantId:        $TenantId"
    Write-Host "  ClientId:        $ClientId"
    Write-Host "  Dataverse origin: $dataverseOrigin"
    Write-Host "  WorkRoot:        $WorkRoot"
    Write-Host "  RunId:           $RunId"
    if ($SourceRunId) { Write-Host "  SourceRunId:     $SourceRunId" }
    if ($RawStartUtc) { Write-Host "  Raw window UTC:  $RawStartUtc .. $RawEndUtc" }
    Write-Host "  Would run:       python `"$exporterScript`" --output `"$entraCsv`" [--copilot-sku-id ...]"
    Write-Host "  Would then run:  python `"$bridgeScript`" --dataverse-url $dataverseOrigin --entra `"$entraCsv`" --out-dir `"$WorkRoot`" --run-id $RunId --publish dataverse [raw scope if supplied]"
    Write-Host "Re-run with -Execute (after acquiring approval and setting `$env:AZURE_CLIENT_SECRET) to perform the real refresh."
    return
}

# ---------------------------------------------------------------------------
# -Execute path: acquire tokens, run the exporter, then the bridge. Everything
# below this line is the only part of the script that performs network I/O.
# ---------------------------------------------------------------------------
$clientSecret = $env:AZURE_CLIENT_SECRET
if (-not $clientSecret) {
    throw "AZURE_CLIENT_SECRET environment variable is required for -Execute and was not set. " +
        "Set it in the current session (never pass it as a parameter) before re-running with -Execute."
}

function Get-ClientCredentialsToken {
    param(
        [Parameter(Mandatory)][string]$Scope,
        [Parameter(Mandatory)][string]$Secret
    )
    $tokenUri = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"
    $body = @{
        client_id     = $ClientId
        client_secret = $Secret
        scope         = $Scope
        grant_type    = 'client_credentials'
    }
    $response = Invoke-RestMethod -Method Post -Uri $tokenUri -Body $body
    if (-not $response.access_token) {
        throw "Token request for scope '$Scope' did not return an access_token."
    }
    return $response.access_token
}

# Preserve any pre-existing values so they can be restored exactly, rather than
# leaving behind a token this run acquired.
$previousGraphToken = $env:GRAPH_ACCESS_TOKEN
$previousDataverseToken = $env:DATAVERSE_TOKEN
$hadGraphToken = Test-Path Env:\GRAPH_ACCESS_TOKEN
$hadDataverseToken = Test-Path Env:\DATAVERSE_TOKEN

try {
    New-Item -ItemType Directory -Force -Path $runDir | Out-Null

    $graphToken = Get-ClientCredentialsToken -Scope 'https://graph.microsoft.com/.default' -Secret $clientSecret
    $dataverseToken = Get-ClientCredentialsToken -Scope "$dataverseOrigin/.default" -Secret $clientSecret

    # Scope tokens to this process's environment only, for the child scripts to read.
    $env:GRAPH_ACCESS_TOKEN = $graphToken
    $env:DATAVERSE_TOKEN = $dataverseToken

    $exporterArgs = @('--output', $entraCsv)
    foreach ($sku in ($CopilotSkuId | Where-Object { $_ })) {
        $exporterArgs += @('--copilot-sku-id', $sku)
    }
    Write-Verbose "Running exporter: python `"$exporterScript`" $($exporterArgs -join ' ')"
    $exporterOutput = & python $exporterScript @exporterArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Export-EntraCoreSnapshot.py failed with exit code $LASTEXITCODE."
    }
    if ($null -ne $exporterOutput) { $exporterOutput | Write-Verbose }

    $bridgeArgs = @(
        '--dataverse-url', $dataverseOrigin,
        '--entra', $entraCsv,
        '--out-dir', $WorkRoot,
        '--run-id', $RunId,
        '--publish', 'dataverse',
        '--quiet'
    )
    if ($SourceRunId) {
        $bridgeArgs += @('--source-run-id', $SourceRunId)
    }
    if ($RawStartUtc) {
        $bridgeArgs += @('--raw-start-utc', $RawStartUtc, '--raw-end-utc', $RawEndUtc)
    }
    Write-Verbose "Running bridge: python `"$bridgeScript`" $($bridgeArgs -join ' ')"
    $bridgeOutput = & python $bridgeScript @bridgeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Build-DataverseCoreFeeds.py failed with exit code $LASTEXITCODE."
    }
    if ($null -ne $bridgeOutput) { $bridgeOutput | Write-Verbose }
}
finally {
    if ($hadGraphToken) { $env:GRAPH_ACCESS_TOKEN = $previousGraphToken } else { Remove-Item Env:\GRAPH_ACCESS_TOKEN -ErrorAction SilentlyContinue }
    if ($hadDataverseToken) { $env:DATAVERSE_TOKEN = $previousDataverseToken } else { Remove-Item Env:\DATAVERSE_TOKEN -ErrorAction SilentlyContinue }
}

# Only the run id ("Core Snapshot ID") is written to the success output, for a
# calling orchestrator (e.g. Task Scheduler capturing stdout) to consume. This
# does not advance, refresh, or deploy the Power BI template automatically.
Write-Output $RunId
