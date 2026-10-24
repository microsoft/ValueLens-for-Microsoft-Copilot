<#
.SYNOPSIS
    Import the SharePointAgentLogging solution into a Dataverse environment via the
    Power Platform CLI (pac).

.DESCRIPTION
    Default behaviour is a DRY RUN: the resolved command is printed and nothing is
    sent to the cloud. Pass -Execute to opt in to the actual import (guarded by
    ShouldProcess).

    The supplied solution zip is validated by parsing its solution.xml:
      * UniqueName must be 'SharePointAgentLogging' (no silent fallback to other solutions).
      * The Managed flag inside the package must match the -Managed switch.

    -SolutionZipPath is required and must point at an existing file. There are no
    hard-coded fallback paths.

.PARAMETER EnvironmentUrl
    Target environment URL. Must be a strict HTTPS URL with no user-info, path,
    query or fragment (e.g. https://contoso.crm.dynamics.com).

.PARAMETER SolutionZipPath
    Explicit path to the SharePointAgentLogging solution zip. Required.

.PARAMETER SettingsFile
    Optional deployment settings file passed to 'pac solution import --settings-file'
    to bind connection references / environment variables. Its contents are never printed.

.PARAMETER Managed
    Whether the package is expected to be a managed solution. Defaults to $true.
    The value is enforced against the Managed flag parsed from the package.

.PARAMETER Execute
    Opt in to the real import. Without it the script is a dry run.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$EnvironmentUrl,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$SolutionZipPath,

    [string]$SettingsFile,

    [string]$PacExe = 'pac',

    [switch]$Managed = $true,

    [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-StrictHttpsUrl {
    param([string]$Url, [string]$Name)
    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "$Name is not a valid absolute URL: '$Url'."
    }
    if ($uri.Scheme -ne 'https') {
        throw "$Name must use https, got '$($uri.Scheme)'."
    }
    if ($uri.UserInfo) {
        throw "$Name must not contain user-info credentials."
    }
    if ($uri.AbsolutePath -and $uri.AbsolutePath -ne '/') {
        throw "$Name must not contain a path component: '$($uri.AbsolutePath)'."
    }
    if ($uri.Query) {
        throw "$Name must not contain a query string."
    }
    if ($uri.Fragment) {
        throw "$Name must not contain a fragment."
    }
    return $uri
}

function Get-SolutionManifest {
    param([string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entry = $archive.Entries | Where-Object { $_.FullName -ieq 'solution.xml' } | Select-Object -First 1
        if (-not $entry) {
            throw "solution.xml not found inside '$ZipPath'. This does not look like a Dataverse solution package."
        }
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { $xmlText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    finally {
        $archive.Dispose()
    }

    [xml]$xml = $xmlText
    $manifest = $xml.ImportExportXml.SolutionManifest
    if (-not $manifest) {
        throw "solution.xml in '$ZipPath' is missing SolutionManifest."
    }
    $managedText = "$($manifest.Managed)".Trim()
    return [pscustomobject]@{
        UniqueName = "$($manifest.UniqueName)".Trim()
        Managed    = ($managedText -eq '1')
        Version    = "$($manifest.Version)".Trim()
    }
}

# --- Validate inputs -------------------------------------------------------
$envUri = Assert-StrictHttpsUrl -Url $EnvironmentUrl -Name 'EnvironmentUrl'

if (-not (Test-Path -LiteralPath $SolutionZipPath -PathType Leaf)) {
    throw "SolutionZipPath does not exist or is not a file: '$SolutionZipPath'."
}
$zip = (Resolve-Path -LiteralPath $SolutionZipPath).ProviderPath

if ($SettingsFile) {
    if (-not (Test-Path -LiteralPath $SettingsFile -PathType Leaf)) {
        throw "SettingsFile does not exist or is not a file: '$SettingsFile'."
    }
    $SettingsFile = (Resolve-Path -LiteralPath $SettingsFile).ProviderPath
}

$manifest = Get-SolutionManifest -ZipPath $zip
$expectedName = 'SharePointAgentLogging'
if ($manifest.UniqueName -ne $expectedName) {
    throw "Solution UniqueName mismatch: package is '$($manifest.UniqueName)', expected '$expectedName'. Refusing to import an unexpected solution."
}
if ($manifest.Managed -ne [bool]$Managed) {
    $pkgKind = if ($manifest.Managed) { 'managed' } else { 'unmanaged' }
    $wantKind = if ($Managed) { 'managed' } else { 'unmanaged' }
    throw "Managed flag mismatch: package is $pkgKind but -Managed indicates $wantKind. Pass -Managed:`$$([bool]$Managed -eq $false) to match, or supply the correct package."
}

$pac = Get-Command $PacExe -ErrorAction SilentlyContinue
$pacSource = if ($pac) { $pac.Source } else { $PacExe }
if ($Execute -and -not $pac) {
    throw "Could not find '$PacExe'. Install the Power Platform CLI or pass -PacExe."
}

$pacArgs = @(
    'solution', 'import',
    '--path', $zip,
    '--environment', $envUri.AbsoluteUri,
    '--activate-plugins'
)
if ($SettingsFile) {
    $pacArgs += @('--settings-file', $SettingsFile)
}

Write-Host ("Solution        : {0} (v{1}, {2})" -f $manifest.UniqueName, $manifest.Version, $(if ($manifest.Managed) { 'managed' } else { 'unmanaged' }))
Write-Host ("Environment     : {0}" -f $envUri.AbsoluteUri)
if ($SettingsFile) {
    # Do NOT print contents: settings files may carry connection secrets.
    Write-Host ("Settings file   : {0} (contents not shown)" -f $SettingsFile)
}

if (-not $Execute) {
    Write-Host 'Dry run only. No import was attempted. Re-run with -Execute to import.'
    Write-Host ('Command: ' + $pacSource + ' ' + ($pacArgs -join ' '))
    return
}

if ($PSCmdlet.ShouldProcess($envUri.AbsoluteUri, "Import $($manifest.UniqueName) from $zip")) {
    & $pacSource @pacArgs
    if ($LASTEXITCODE -ne 0) {
        throw "pac solution import failed with exit code $LASTEXITCODE"
    }
    Write-Host 'Import completed.'
}
