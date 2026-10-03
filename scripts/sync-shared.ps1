<#
.SYNOPSIS
Mirrors the seven shared Fabric notebooks from `1. Fabric/notebooks/`
into the archived Copilot Studio add-on's local `_core` folder.

.DESCRIPTION
The source of truth for the shared notebooks is `1. Fabric/notebooks/`. To keep
the archived add-on copies consistent with the core, we mirror those notebooks into:

  1. Fabric/archive/extended/Fabric + Copilot Studio/notebooks/_core/

The former `_shared/notebooks/` second copy was redundant and is no longer generated.

Run this after editing any file in `1. Fabric/notebooks/`.

`Copilot_Audit_Log_Processor.ipynb` is deliberately NOT mirrored: it is a
downstream transform (parsed -> curated), not an ingester, and the add-ons
inherit it from the base `1. Fabric` build. `ValueLens_Refresh_Model.ipynb`
is the installer's semantic model refresh and is not mirrored either. Both
are listed in $excluded below.

.PARAMETER Check
When set, exits 1 if any destination differs from the source. Used by CI.

.EXAMPLE
.\scripts\sync-shared.ps1              # sync (writes)
.\scripts\sync-shared.ps1 -Check       # verify only (CI)
#>
[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source   = Join-Path $repoRoot '1. Fabric\notebooks'

$destinations = @(
    (Join-Path $repoRoot '1. Fabric\archive\extended\Fabric + Copilot Studio\notebooks\_core')
)

# Notebooks in $source that are NOT mirrored into the add-ons. The processor is
# a downstream transform, not an ingester, so the add-ons inherit it from the
# base 1. Fabric build rather than shipping their own copy. The refresh notebook
# belongs to the installer's semantic model and has no add-on equivalent.
$excluded = @(
    'Copilot_Audit_Log_Processor.ipynb',
    'ValueLens_Refresh_Model.ipynb'
)

$notebooks = Get-ChildItem $source -Filter '*.ipynb' -File |
             Where-Object { $_.Name -notin $excluded }

if (-not $notebooks) {
    throw "sync-shared: no notebooks found in '$source' after exclusions."
}

$drift = @()

foreach ($dest in $destinations) {
    if (-not (Test-Path $dest)) {
        if ($Check) {
            $drift += "MISSING DIR: $dest"
            continue
        }
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
    }
    foreach ($nb in $notebooks) {
        $target = Join-Path $dest $nb.Name
        $srcHash = (Get-FileHash $nb.FullName -Algorithm SHA256).Hash
        $tgtHash = if (Test-Path $target) { (Get-FileHash $target -Algorithm SHA256).Hash } else { $null }
        if ($srcHash -ne $tgtHash) {
            if ($Check) {
                $drift += "DRIFT: $target"
            } else {
                Copy-Item $nb.FullName $target -Force
                Write-Host "synced -> $target"
            }
        }
    }
}

if ($Check -and $drift.Count -gt 0) {
    Write-Host ""
    Write-Host "sync-shared: drift detected"
    $drift | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "Run scripts\sync-shared.ps1 to fix."
    exit 1
}

Write-Host ""
Write-Host "sync-shared: OK ($($notebooks.Count) notebook(s) x $($destinations.Count) destination(s))"
if ($excluded) {
    Write-Host "  not mirrored: $($excluded -join ', ')"
}
