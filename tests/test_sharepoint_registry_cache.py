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
SCRIPT = REPO / "4. SharePoint" / "scripts" / "Get-Agents365Registry.ps1"


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
$out = [ordered]@{}

# Real Invoke-Graph against a mocked transport: network errors and 5xx are retried,
# a 404 or 424 is not.
$script:GraphMode = 'Interactive'
$global:Calls = 0
$global:Steps = @()
function Start-Sleep { param([int]$Seconds) }
function Invoke-MgGraphRequest { param($Method, $Uri, $Body, $ContentType)
  $step = $global:Steps[$global:Calls]; $global:Calls++
  if ($step -eq 'timeout') { throw [System.TimeoutException]::new('The operation has timed out.') }
  if ($step -eq 'reset') { throw [System.Net.Http.HttpRequestException]::new('connection reset', [System.IO.IOException]::new('reset')) }
  if ($step -match '^\d+$') { throw "Response status code does not indicate success: $step (Status)." }
  return 'ok' }
$global:Calls = 0; $global:Steps = @('timeout', 'reset', '502', 'ok')
$out.netRetry = @((Invoke-Graph -Uri 'https://graph.test/x'), $global:Calls)
$global:Calls = 0; $global:Steps = @('404', 'ok')
try { [void](Invoke-Graph -Uri 'https://graph.test/x'); $out.notFound = 'no error' } catch { $out.notFound = "error $($_.Exception.Data['HttpStatus'])" }
$out.notFoundCalls = $global:Calls
$global:Calls = 0; $global:Steps = @('424', 'ok')
try { [void](Invoke-Graph -Uri 'https://graph.test/x'); $out.failedDependency = 'no error' } catch { $out.failedDependency = "error $($_.Exception.Data['HttpStatus'])" }
$out.failedDependencyCalls = $global:Calls
$global:Calls = 0; $global:Steps = @('timeout') * 10
try { [void](Invoke-Graph -Uri 'https://graph.test/x'); $out.netCap = 'no error' } catch { $out.netCap = 'error' }
$out.netCapCalls = $global:Calls
$out.transient = @(
  (Test-TransientNetworkError ([pscustomobject]@{ Exception = [System.TimeoutException]::new('t') })),
  (Test-TransientNetworkError ([pscustomobject]@{ Exception = [System.InvalidOperationException]::new('x') })))
Remove-Item function:Start-Sleep

$global:Fetched = [System.Collections.Generic.List[string]]::new()
$global:OwnerLookups = [System.Collections.Generic.List[string]]::new()
$global:FailIds = @()
$global:StatusIds = @{}
function Get-AgentPackages { param([string]$Version)
  [pscustomobject]@{ Version = $Version; Base = 'https://graph.test/packages'; Packages = @($global:Catalog) } }
function Invoke-Graph { param([string]$Method = 'GET', [string]$Uri, $Body)
  $id = $Uri.Substring($Uri.LastIndexOf('/') + 1)
  if ($global:FailIds -contains $id) { throw "mock 500 for $id" }
  if ($global:StatusIds.ContainsKey($id)) {
    $e = [System.Exception]::new("mock HTTP $($global:StatusIds[$id]) for $id"); $e.Data['HttpStatus'] = $global:StatusIds[$id]; throw $e }
  $global:Fetched.Add($id)
  return $global:Details[$id] }
function Resolve-OwnerIds { param([string[]]$OwnerIds)
  $map = @{}; foreach ($o in $OwnerIds) { $global:OwnerLookups.Add($o); if ($o -eq 'owner-a') { $map[$o] = 'alice@contoso.com' } }; return $map }
function Resolve-SpOwner { param([string]$AppId, [string]$AgentIdentityId) return '' }
function Pkg($id, $name, $lm, $owner) { [pscustomobject]@{ id = $id; displayName = $name; lastModifiedDateTime = $lm; ownerId = $owner; type = 'Shared' } }
function Det($id, $users) { [pscustomobject]@{ id = $id; activeUsers = $users; totalSessions = 5; sharedWithUsersAndGroups = @() } }
function Run([int]$days = 7, [int]$every = 1000) {
  $global:Fetched.Clear(); $global:OwnerLookups.Clear()
  [void](Export-Agents365Registry -OutputCsvPath $csv -Version 'v1.0' -FullRefreshDays $days -CheckpointEvery $every)
  return @{ fetched = @($global:Fetched | Sort-Object); owners = @($global:OwnerLookups | Sort-Object) } }
function RunLogged([int]$every = 1000) {
  # Run, capturing Write-Host (the information stream) as 'log'.
  $res = @(& { Run 7 $every } 6>&1)
  $r = @($res | Where-Object { $_ -is [hashtable] })[0]
  $r.log = (@($res | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object { "$($_.MessageData)" }) -join "`n")
  return $r }

function CacheIds { @(Get-Content -LiteralPath "$csv.detailcache.jsonl" | Select-Object -Skip 1 | ForEach-Object { ($_ | ConvertFrom-Json).id } | Sort-Object -Unique) }
function CacheEntry($id) { Get-Content -LiteralPath "$csv.detailcache.jsonl" | Select-Object -Skip 1 | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.id -eq $id } | Select-Object -Last 1 }
function CsvRow($titleId) { Import-Csv -LiteralPath $csv | Where-Object { $_.'Title ID' -eq $titleId } }

$csv = Join-Path '__TMP__' 'Agents365Registry.csv'

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

# 4: a failed refetch of a changed, cached agent falls back to the cached detail and
# keeps the cached lastModified, so the change is not marked as seen and is retried.
$global:Catalog = @((Pkg 'A' 'Alpha renamed' '2025-03-01T00:00:00Z' 'owner-a'), (Pkg 'B' 'Beta' '2025-02-01T00:00:00Z' 'owner-b'))
$global:FailIds = @('A')
try { [void](Run); $out.run4 = 'no error' } catch { $out.run4 = "error: $($_.Exception.Message)" }
$global:FailIds = @()
$out.run4ActiveUsers = (CsvRow 'T_A').'Active Users'
$out.run4CachedLastModified = (ConvertTo-StampKey (CacheEntry 'A').lastModified)
$out.run4b = Run

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

# 6: a new agent whose detail fails, with no cache, is written list-only, left out of
# the cache, and the only call on the next run.
$global:Catalog = @((Pkg 'A' 'Alpha renamed' '2025-01-01T00:00:00Z' 'owner-a'), (Pkg 'B' 'Beta' '2025-02-01T00:00:00Z' 'owner-b'), (Pkg 'D' 'Delta' '2025-04-01T00:00:00Z' ''))
$global:Details['D'] = (Det 'D' 40)
$global:FailIds = @('D')
try { [void](Run); $out.run6 = 'no error' } catch { $out.run6 = "error: $($_.Exception.Message)" }
$global:FailIds = @()
$d = CsvRow 'T_D'
$out.run6Row = @("$($d.'Agent name')", "$($d.'Active Users')")
$out.run6Cache = CacheIds
$out.run6b = Run

# 7: no limit on missing detail. 424 and 404 agents (here 3 of 4 new ones) are written
# list-only with the reason in the log, never cached, and retried next run; successes
# are checkpointed as they arrive.
$global:Catalog = @($global:Catalog) + @((Pkg 'F' 'Foxtrot' '2025-05-01T00:00:00Z' ''), (Pkg 'G' 'Golf' '2025-05-01T00:00:00Z' ''), (Pkg 'H' 'Hotel' '2025-05-01T00:00:00Z' ''), (Pkg 'I' 'India' '2025-05-01T00:00:00Z' ''))
foreach ($k in 'F', 'G', 'H', 'I') { $global:Details[$k] = (Det $k 50) }
$global:StatusIds = @{ F = 424; G = 424; H = 404 }
try { $r7 = RunLogged 1; $out.run7 = 'no error'; $out.run7Log = $r7.log; $out.run7Fetched = $r7.fetched } catch { $out.run7 = "error: $($_.Exception.Message)" }
$global:StatusIds = @{}
$out.run7Csv = @(Import-Csv -LiteralPath $csv | ForEach-Object { $_.'Title ID' } | Sort-Object)
$f = CsvRow 'T_F'
$out.run7Row = @("$($f.'Agent name')", "$($f.'Active Users')")
$out.run7Cache = CacheIds
$out.run7b = Run

# 8: a corrupt trailing line (a checkpoint cut off mid-write) is skipped, not fatal.
[System.IO.File]::AppendAllText("$csv.detailcache.jsonl", '{"id":"A","lastMod')
try { $out.run8 = Run } catch { $out.run8 = "error: $($_.Exception.Message)" }

# 9: every detail call failing with 401/403 and nothing cached is a consent problem:
# fail, and write no CSV. One non-auth failure, or any detail to fall back on, writes.
$csv = Join-Path '__TMP__' 'Auth.csv'
$global:Catalog = @((Pkg 'P' 'Papa' '2025-01-01T00:00:00Z' ''), (Pkg 'Q' 'Quebec' '2025-01-01T00:00:00Z' ''))
$global:StatusIds = @{ P = 403; Q = 401 }
try { [void](Run); $out.run9 = 'no error' } catch { $out.run9 = "error: $($_.Exception.Message)" }
$out.run9Csv = Test-Path -LiteralPath $csv
$global:StatusIds = @{ P = 403; Q = 424 }
try { [void](Run); $out.run9b = 'no error' } catch { $out.run9b = "error: $($_.Exception.Message)" }
$global:StatusIds = @{}

# 10: 'Last updated' is the list's lastModifiedDateTime on fetched and cached runs alike,
# even when the detail payload carries a different stamp; the detail's is the fallback.
$csv = Join-Path '__TMP__' 'Stamp.csv'
$global:Catalog = @((Pkg 'S' 'Sierra' '2025-06-01T10:00:39.3974298Z' ''), (Pkg 'U' 'Uniform' '' ''))
$global:Details['S'] = [pscustomobject]@{ id = 'S'; activeUsers = 1; lastModifiedDateTime = '2025-06-01T10:00:39.7161648Z' }
$global:Details['U'] = [pscustomobject]@{ id = 'U'; activeUsers = 1; lastModifiedDateTime = '2025-06-02T00:00:00Z' }
$r10 = Run
$out.run10 = @($r10.fetched, @((CsvRow 'T_S').'Last updated', (CsvRow 'T_U').'Last updated'))
$r10b = Run
$out.run10b = @($r10b.fetched, @((CsvRow 'T_S').'Last updated', (CsvRow 'T_U').'Last updated'))

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

    def test_checkpoint_flush_is_in_a_finally_before_the_csv(self):
        text = SCRIPT.read_text(encoding="utf-8")
        body = text[text.index("function Export-Agents365Registry"):]
        flush = body.index("} finally {")
        self.assertLess(flush, body.index("Add-DetailCacheEntries -Path", flush))
        self.assertLess(body.index("Add-DetailCacheEntries -Path", flush), body.index("Write-RegistryCsv -Rows"))
        for param in ("[int]$CheckpointEvery = 1000", "[int]$ProgressEvery = 500"):
            self.assertIn(param, text)
        self.assertNotIn("MaxMissingDetail", text, "the missing-detail limit is gone")

    def test_fetched_and_cached_rows_both_keep_the_list_stamp(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("Set-ListModified (Merge-Detail $package $detail) $package $detail", text)
        self.assertIn("Set-ListModified (Merge-Detail $cachedDetail $package) $package $cachedDetail", text)


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

    def test_failed_refetch_falls_back_to_cache_without_marking_seen(self):
        self.assertEqual(self.out["run4"], "no error")
        self.assertEqual(self.out["run4ActiveUsers"], "10")
        self.assertEqual(self.out["run4CachedLastModified"], "2025-01-01T00:00:00Z")
        self.assertEqual(self.out["run4b"]["fetched"], ["A"])

    def test_missing_detail_is_list_only_and_retried(self):
        self.assertEqual(self.out["run6"], "no error")
        self.assertEqual(self.out["run6Row"], ["Delta", ""])
        self.assertEqual(self.out["run6Cache"], ["A", "B"])
        self.assertEqual(self.out["run6b"]["fetched"], ["D"])

    def test_424_and_404_never_fail_the_run_and_are_retried_next_run(self):
        self.assertEqual(self.out["run7"], "no error")
        self.assertEqual(self.out["run7Fetched"], ["I"])
        self.assertEqual(self.out["run7Csv"], ["T_A", "T_B", "T_D", "T_F", "T_G", "T_H", "T_I"])
        self.assertEqual(self.out["run7Row"], ["Foxtrot", ""])
        self.assertIn("3 agent(s) have no detail and no cached copy", self.out["run7Log"])
        self.assertIn("missing (HTTP 424) x2, missing (HTTP 404) x1", self.out["run7Log"])
        self.assertEqual(self.out["run7Cache"], ["A", "B", "D", "I"])
        self.assertEqual(self.out["run7b"]["fetched"], ["F", "G", "H"])

    def test_all_401_403_with_no_cache_fails_without_writing(self):
        self.assertTrue(self.out["run9"].startswith("error: Every Agent 365 detail call failed with HTTP 401/403"),
                        self.out["run9"])
        self.assertIn("CopilotPackages.Read.All", self.out["run9"])
        self.assertFalse(self.out["run9Csv"])
        self.assertEqual(self.out["run9b"], "no error")

    def test_corrupt_checkpoint_line_is_skipped(self):
        self.assertIsInstance(self.out["run8"], dict, self.out["run8"])

    def test_last_updated_is_the_list_stamp_on_fetched_and_cached_runs(self):
        stamps = ["2025-06-01T10:00:39.3974298Z", "2025-06-02T00:00:00Z"]
        self.assertEqual(self.out["run10"], [["S", "U"], stamps])
        self.assertEqual(self.out["run10b"], [[], stamps], "cached run: same 'Last updated', no refetch")
        self.assertEqual(self.out["run8"]["fetched"], [])

    def test_network_errors_and_5xx_are_retried(self):
        self.assertEqual(self.out["netRetry"], ["ok", 4])
        self.assertEqual(self.out["netCap"], "error")
        self.assertEqual(self.out["netCapCalls"], 6)
        self.assertEqual(self.out["transient"], [True, False])

    def test_404_and_424_are_not_retried(self):
        self.assertEqual(self.out["notFound"], "error 404")
        self.assertEqual(self.out["notFoundCalls"], 1)
        self.assertEqual(self.out["failedDependency"], "error 424")
        self.assertEqual(self.out["failedDependencyCalls"], 1)

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
