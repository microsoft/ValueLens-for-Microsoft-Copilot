<#
.SYNOPSIS
    Preflight checks for the Power Automate + Dataverse pathway.

.DESCRIPTION
    Verifies that the required local build assets exist and that any supplied URLs
    are well formed (strict HTTPS). On any failure of a REQUIRED check the script
    throws an aggregate error (non-zero exit) rather than silently succeeding.

    By default the check runs in core-only mode and does NOT require a private
    collector solution zip. Pass -IncludeInventory (with an explicit
    -SolutionZipPath) to additionally validate that a local reference package is
    present.

.PARAMETER DataverseUrl
    Optional Dataverse Web API URL to syntax-check (strict HTTPS).

.PARAMETER EnvironmentUrl
    Optional Power Platform environment URL to syntax-check (strict HTTPS).

.PARAMETER SolutionZipPath
    Explicit path to a compatible reference solution zip. Only consulted (and
    required) when -IncludeInventory is set. There are no hard-coded fallback
    paths.

.PARAMETER RequirePac
    Treat the presence of the pac CLI as a required check.

.PARAMETER IncludeInventory
    Additionally require an explicit, existing -SolutionZipPath.
#>
[CmdletBinding()]
param(
    [string]$DataverseUrl,
    [string]$EnvironmentUrl,
    [string]$SolutionZipPath,
    [switch]$RequirePac,
    [switch]$IncludeInventory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-StrictHttpsUrl {
    param([string]$Url)
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) { return $false }
    if ($uri.Scheme -ne 'https') { return $false }
    if ($uri.UserInfo) { return $false }
    if ($uri.AbsolutePath -and $uri.AbsolutePath -ne '/') { return $false }
    if ($uri.Query) { return $false }
    if ($uri.Fragment) { return $false }
    return $true
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pathwayRoot = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $PSScriptRoot 'Build-PowerAutomateDataverse-Template.py'
$bridgeScript = Join-Path $PSScriptRoot 'Build-DataverseCoreFeeds.py'
$rawCaptureScript = Join-Path $PSScriptRoot 'Invoke-CopilotAuditRawCapture.ps1'
$prepareScript = Join-Path $PSScriptRoot 'Prepare-CollectorRawCapture.py'
$templatePath = Join-Path $pathwayRoot 'ValueLens - Power Automate + Dataverse.pbit'
$schemaPath = Join-Path $pathwayRoot 'dataverse-core-schema.json'

$pac = Get-Command pac -ErrorAction SilentlyContinue
$pacDetail = if ($pac) { $pac.Source } else { 'Not installed / not on PATH' }

$checks = New-Object System.Collections.Generic.List[object]
function Add-Check {
    param([string]$Check, [bool]$Result, [string]$Detail, [bool]$Required = $true)
    $checks.Add([pscustomobject]@{ Check = $Check; Required = $Required; Result = $Result; Detail = $Detail })
}

Add-Check 'Source template' (Test-Path (Join-Path $repoRoot '2. SharePoint\ValueLens - SharePoint.pbit')) 'Base template for the additive pathway'
Add-Check 'Build script' (Test-Path $buildScript) $buildScript
Add-Check 'Core bridge script' (Test-Path $bridgeScript) 'Requires full raw AuditData; rejects summary-only collector rows'
Add-Check 'Raw capture/backfill script' (Test-Path $rawCaptureScript) 'Captures full Graph audit payloads; Dataverse write is opt-in'
Add-Check 'Raw reuse patch tool' (Test-Path $prepareScript) 'Adapts a private CopilotInteractionLogging zip to add raw retention'
Add-Check 'Dataverse core schema' (Test-Path $schemaPath) $schemaPath
foreach ($script in @('Deploy-DataverseCoreSchema.py', 'Export-EntraCoreSnapshot.py', 'Invoke-DataverseCoreRefresh.ps1')) {
    $scriptPath = Join-Path $PSScriptRoot $script
    Add-Check $script (Test-Path $scriptPath) $scriptPath
}
Add-Check 'Built template' (Test-Path $templatePath) $templatePath

if ($DataverseUrl) {
    Add-Check 'Dataverse URL (strict https)' (Test-StrictHttpsUrl $DataverseUrl) $DataverseUrl
}
if ($EnvironmentUrl) {
    Add-Check 'Environment URL (strict https)' (Test-StrictHttpsUrl $EnvironmentUrl) $EnvironmentUrl
}

if ($RequirePac) {
    Add-Check 'pac CLI' ([bool]$pac) $pacDetail
}
else {
    Add-Check 'pac CLI' ([bool]$pac) $pacDetail -Required:$false
}

if ($IncludeInventory) {
    if (-not $SolutionZipPath) {
        Add-Check 'Collector solution zip' $false 'IncludeInventory requested but -SolutionZipPath was not supplied'
    }
    else {
        $exists = Test-Path -LiteralPath $SolutionZipPath -PathType Leaf
        $detail = if ($exists) { $SolutionZipPath } else { "Not found: $SolutionZipPath" }
        Add-Check 'Collector solution zip' $exists $detail
    }
}

$checks | Format-Table -AutoSize Check, Required, Result, Detail | Out-String | Write-Host

$failed = $checks | Where-Object { $_.Required -and -not $_.Result }
if ($failed) {
    $lines = $failed | ForEach-Object { " - $($_.Check): $($_.Detail)" }
    throw ("Preflight failed. {0} required check(s) did not pass:`n{1}" -f $failed.Count, ($lines -join "`n"))
}

Write-Host 'Preflight passed: all required checks satisfied.'
