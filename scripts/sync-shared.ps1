<#
.SYNOPSIS
Mirrors the seven core Fabric ingester notebooks from `2. Fabric/notebooks/`
into every self-contained location under `3. Fabric Extended/`.

.DESCRIPTION
The source of truth for the core ingesters is `2. Fabric/notebooks/`. To keep
each `3. Fabric Extended/*` add-on downloadable-and-runnable in isolation, we
duplicate those notebooks into:

  3. Fabric Extended/_shared/notebooks/                       (documentation copy)
  3. Fabric Extended/Fabric + Copilot Studio/notebooks/_core/ (runnable copy)
  3. Fabric Extended/Fabric + M365/notebooks/_core/           (runnable copy)

Run this after editing any file in `2. Fabric/notebooks/`.

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
$source   = Join-Path $repoRoot '2. Fabric\notebooks'

$destinations = @(
    (Join-Path $repoRoot '3. Fabric Extended\_shared\notebooks'),
    (Join-Path $repoRoot '3. Fabric Extended\Fabric + Copilot Studio\notebooks\_core'),
    (Join-Path $repoRoot '3. Fabric Extended\Fabric + M365\notebooks\_core')
)

$notebooks = Get-ChildItem $source -Filter '*.ipynb' -File

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

if (-not $Check) {
    Write-Host ""
    Write-Host "sync-shared: OK ($($notebooks.Count) notebook(s) x $($destinations.Count) destinations)"
}
