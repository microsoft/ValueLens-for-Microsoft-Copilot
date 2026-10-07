"""Incremental detail cache in the SharePoint Get-Agents365Registry.ps1.

The script is dot-sourced with Graph mocked (no network, no credentials). Execution
needs a PowerShell whose execution policy allows scripts (CI's pwsh on Linux does);
on a machine whose policy blocks scripts the execution tests are skipped rather than
the policy being bypassed. The parse check never executes the script.
"""
import csv
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "3. SharePoint" / "scripts" / "Get-Agents365Registry.ps1"


def _find_pwsh():
    for exe in ("pwsh", "powershell"):
        try:
            subprocess.run([exe, "-NoProfile", "-NonInteractive", "-Command", "1"],
                           capture_output=True, timeout=30, check=False)
            return exe
        except (FileNotFoundError, OSError):
            continue
    return None


PWSH = _find_pwsh()


def _scripts_allowed():
    if not PWSH:
        return False
    result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"],
                            capture_output=True, text=True, timeout=30, check=False)
    return result.returncode == 0 and result.stdout.strip() not in ("Restricted", "AllSigned")


SCRIPTS_ALLOWED = _scripts_allowed()

# Mocks replace the Graph-facing functions after the dot-source. $global:Catalog is
# the list the "catalogue" returns; $global:Details the per-id detail payloads.
HARNESS = r"""
$ErrorActionPreference = 'Stop'
. '__SCRIPT__'
$global:Fetched = [System.Collections.Generic.List[string]]::new()
$global:OwnerLookups = [System.Collections.Generic.List[string]]::new()
$global:FailId = ''
function Get-AgentPackages { param([string]$Version)
  [pscustomobject]@{ Version = $Version; Base = 'https://graph.test/packages'; Packages = @($global:Catalog) } }
function Invoke-Graph { param([string]$Method = 'GET', [string]$Uri, $Body)
  $id = $Uri.Substring($Uri.LastIndexOf('/') + 1)
  if ($id -eq $global:FailId) { throw "mock 500 for $id" }
  $global:Fetched.Add($id)
  return $global:Details[$id] }
function Resolve-OwnerIds { param([string[]]$OwnerIds)
  $map = @{}; foreach ($o in $OwnerIds) { $global:OwnerLookups.Add($o); if ($o -eq 'owner-a') { $map[$o] = 'alice@contoso.com' } }; return $map }
function Resolve-SpOwner { param([string]$AppId, [string]$AgentIdentityId) return '' }
function Pkg($id, $name, $lm, $owner) { [pscustomobject]@{ id = $id; displayName = $name; lastModifiedDateTime = $lm; ownerId = $owner; type = 'Shared' } }
function Det($id, $users) { [pscustomobject]@{ id = $id; activeUsers = $users; totalSessions = 5; sharedWithUsersAndGroups = @() } }
function Run([int]$days = 7) {
  $global:Fetched.Clear(); $global:OwnerLookups.Clear()
  [void](Export-Agents365Registry -OutputCsvPath $csv -Version 'v1.0' -FullRefreshDays $days)
  return @{ fetched = @($global:Fetched | Sort-Object); owners = @($global:OwnerLookups | Sort-Object) } }

$csv = Join-Path '__TMP__' 'Agents365Registry.csv'
$out = [ordered]@{}

# 1: first run, no cache -> every detail fetched.
$global:Catalog = @((Pkg 'A' 'Alpha' '2025-01-01T00:00:00Z' 'owner-a'), (Pkg 'B' 'Beta' '2025-01-01T00:00:00Z' 'owner-b'))
$global:Details = @{ A = (Det 'A' 10); B = (Det 'B' 20) }
$out.run1 = Run

# 2: A unchanged (but renamed in the list), B modified, C new.
$global:Catalog = @((Pkg 'A' 'Alpha renamed' '2025-01-01T00:00:00Z' 'owner-a'), (Pkg 'B' 'Beta' '2025-02-01T00:00:00Z' 'owner-b'), (Pkg 'C' 'Gamma' '2025-02-01T00:00:00Z' ''))
$global:Details = @{ A = (Det 'A' 999); B = (Det 'B' 21); C = (Det 'C' 30) }
$out.run2 = Run
$out.csv2 = @(Import-Csv -LiteralPath $csv | Select-Object 'Title ID', 'Agent name', 'Active Users', 'Agent creator UPN', 'Agent creator source')

# 3: C deleted from the list -> pruned from the cache.
$global:Catalog = @((Pkg 'A' 'Alpha renamed' '2025-01-01T00:00:00Z' 'owner-a'), (Pkg 'B' 'Beta' '2025-02-01T00:00:00Z' 'owner-b'))
$out.run3 = Run
$out.cache3 = @(Get-Content -LiteralPath "$csv.detailcache.jsonl" | Select-Object -Skip 1 | ForEach-Object { ($_ | ConvertFrom-Json).id } | Sort-Object)

# 4: a failing detail call leaves the CSV and the cache untouched.
$global:Catalog = @((Pkg 'A' 'Alpha renamed' '2025-03-01T00:00:00Z' 'owner-a'), (Pkg 'B' 'Beta' '2025-02-01T00:00:00Z' 'owner-b'))
$cacheBefore = [System.IO.File]::ReadAllText("$csv.detailcache.jsonl")
$global:FailId = 'A'
try { [void](Run); $out.run4 = 'no error' } catch { $out.run4 = 'error' }
$global:FailId = ''
$out.cacheUnchanged = ([System.IO.File]::ReadAllText("$csv.detailcache.jsonl") -eq $cacheBefore)

# 5: an agent whose cached detail is older than FullRefreshDays is re-fetched.
$lines = [System.IO.File]::ReadAllLines("$csv.detailcache.jsonl")
for ($i = 1; $i -lt $lines.Count; $i++) {
  $e = $lines[$i] | ConvertFrom-Json
  if ($e.id -eq 'A') { $e.detailAsOfUtc = [datetime]::UtcNow.AddDays(-8).ToString('o'); $lines[$i] = ($e | ConvertTo-Json -Depth 50 -Compress) }
}
[System.IO.File]::WriteAllLines("$csv.detailcache.jsonl", $lines)
$global:Catalog = @((Pkg 'A' 'Alpha renamed' '2025-01-01T00:00:00Z' 'owner-a'), (Pkg 'B' 'Beta' '2025-02-01T00:00:00Z' 'owner-b'))
$out.run5 = Run
$out.run5b = Run
$out.run5zero = Run 0

# Retry-After: header honoured and capped, else 2^attempt.
$h = [System.Net.WebHeaderCollection]::new(); $h.Add('Retry-After', '7')
$err = [pscustomobject]@{ Exception = [pscustomobject]@{ Response = [pscustomobject]@{ Headers = $h } } }
$big = [System.Net.WebHeaderCollection]::new(); $big.Add('Retry-After', '600')
$errBig = [pscustomobject]@{ Exception = [pscustomobject]@{ Response = [pscustomobject]@{ Headers = $big } } }
$out.retry = @((Get-RetryAfterSeconds $err 1), (Get-RetryAfterSeconds $errBig 1), (Get-RetryAfterSeconds $null 3))
$out.columns = $script:RegistryColumns.Count
$out | ConvertTo-Json -Depth 6 -Compress
"""


class ParseTests(unittest.TestCase):
    @unittest.skipUnless(PWSH, "no PowerShell executable available")
    def test_script_parses(self):
        result = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command",
             f"$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('{SCRIPT}', [ref]$null, [ref]$e) | Out-Null; $e.Count"],
            capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0")

    def test_cache_is_written_after_the_csv(self):
        text = SCRIPT.read_text(encoding="utf-8")
        body = text[text.index("function Export-Agents365Registry"):]
        self.assertLess(body.index("Write-RegistryCsv -Rows"), body.index("Write-DetailCache -Path"))
        self.assertIn("[int]$FullDetailRefreshDays = 7", text)


@unittest.skipUnless(SCRIPTS_ALLOWED, "PowerShell execution policy blocks scripts here (not bypassed)")
class IncrementalCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        command = HARNESS.replace("__SCRIPT__", str(SCRIPT)).replace("__TMP__", cls.tmp.name)
        result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", "-"],
                                input=command, capture_output=True, text=True, timeout=180, check=False,
                                env={**os.environ, "NO_COLOR": "1"})
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        cls.out = json.loads(result.stdout.strip().splitlines()[-1])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_first_run_fetches_every_detail(self):
        self.assertEqual(self.out["run1"]["fetched"], ["A", "B"])

    def test_only_new_or_modified_agents_are_fetched(self):
        self.assertEqual(self.out["run2"]["fetched"], ["B", "C"])

    def test_list_fields_go_over_cached_detail(self):
        rows = {r["Title ID"]: r for r in self.out["csv2"]}
        self.assertEqual(rows["T_A"]["Agent name"], "Alpha renamed")
        self.assertEqual(rows["T_A"]["Active Users"], "10")  # cached, not the unfetched 999
        self.assertEqual(rows["T_B"]["Active Users"], "21")  # fresh detail

    def test_creator_is_cached_per_agent(self):
        rows = {r["Title ID"]: r for r in self.out["csv2"]}
        self.assertEqual(rows["T_A"]["Agent creator UPN"], "alice@contoso.com")
        self.assertNotIn("owner-a", self.out["run2"]["owners"])
        self.assertEqual(rows["T_B"]["Agent creator source"], "unattributed")

    def test_deleted_agents_are_pruned(self):
        self.assertEqual(self.out["run3"]["fetched"], [])
        self.assertEqual(self.out["cache3"], ["A", "B"])

    def test_failed_run_does_not_advance_cache(self):
        self.assertEqual(self.out["run4"], "error")
        self.assertTrue(self.out["cacheUnchanged"])

    def test_stale_detail_is_refreshed(self):
        self.assertEqual(self.out["run5"]["fetched"], ["A"])
        self.assertEqual(self.out["run5b"]["fetched"], [])
        self.assertEqual(self.out["run5zero"]["fetched"], ["A", "B"])

    def test_retry_after(self):
        self.assertEqual(self.out["retry"], [7, 60, 8])

    def test_column_contract_unchanged(self):
        self.assertEqual(self.out["columns"], 48)
        with open(Path(self.tmp.name) / "Agents365Registry.csv", encoding="utf-8-sig", newline="") as fh:
            self.assertEqual(len(next(csv.reader(fh))), 48)


if __name__ == "__main__":
    unittest.main()
