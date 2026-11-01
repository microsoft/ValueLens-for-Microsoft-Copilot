"""The -Dashboard value the SharePoint Run-PAX-AIBV.ps1 passes to PAX.

PAX purview-v1.11.15 renamed the ValueLens rollup's -Dashboard value from AIBV to
ValueLens, and its ValidateSet rejects AIBV; v1.11.5 to v1.11.14 accept only AIBV.
The runner reads the downloaded PAX script's param block, without running it, and
passes the name that release accepts.

Get-PaxDashboardValue is loaded from the runner's syntax tree and pointed at param
blocks shaped like each PAX release, so nothing is downloaded and no PAX code runs.
Loading it needs a PowerShell whose execution policy allows scripts (CI's pwsh on
Linux does); where the policy blocks scripts the test is skipped, not bypassed. The
parse check never executes the script.
"""
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RUNNER = REPO / "4. SharePoint" / "scripts" / "Run-PAX-AIBV.ps1"


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

# A body that throws proves the helper only parses the PAX script.
NEVER_RUN = "throw 'PAX code ran'\n"

PAX_SCRIPTS = {
    # purview-v1.11.15, the current release
    "v1.11.15": "[CmdletBinding()]\nparam(\n  [Parameter(Mandatory = $false)]\n"
                "  [ValidateSet('AIO', 'ValueLens', 'M365', 'AISID')]\n"
                "  [string]$Dashboard = 'AIO',\n  [switch]$Rollup\n)\n" + NEVER_RUN,
    # purview-v1.11.5 to v1.11.14
    "v1.11.14": "[CmdletBinding()]\nparam(\n  [Parameter(Mandatory = $false)]\n"
                "  [ValidateSet('AIO', 'AIBV', 'M365', 'AISID')]\n"
                "  [string]$Dashboard = 'AIO',\n  [switch]$Rollup\n)\n" + NEVER_RUN,
    # The v1.11.16 and v2.0.0 prereleases check a string array in code instead.
    "prerelease": "[CmdletBinding()]\nparam(\n  [Parameter(Mandatory = $false)]\n"
                  "  [ArgumentCompleter({ param($c, $p, $w) 'AIO', 'ValueLens' })]\n"
                  "  [string[]]$Dashboard = @('AIO')\n)\n" + NEVER_RUN,
    # purview-v1.11.4 and earlier have no -Dashboard.
    "v1.11.4": "[CmdletBinding()]\nparam([string]$TenantId, [switch]$Rollup)\n" + NEVER_RUN,
    "neither": "param([ValidateSet('AIO', 'M365')] [string]$Dashboard = 'AIO')\n" + NEVER_RUN,
    # A cut-off download.
    "truncated": "param(\n  [ValidateSet('AIO', 'ValueLens'\n",
}

# `pwsh -Command -` reads stdin like a console: a multi-line block runs only once a blank
# line follows it, so keep the blank line after the foreach.
HARNESS = r"""
$ErrorActionPreference = 'Stop'
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('__RUNNER__', [ref]$null, [ref]$parseErrors)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-PaxDashboardValue' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$cases = Get-Content -LiteralPath '__CASES__' -Raw -Encoding UTF8 | ConvertFrom-Json
$out = [ordered]@{}
foreach ($case in $cases) {
  try { $out[$case.name] = Get-PaxDashboardValue -ScriptPath $case.path }
  catch { $out[$case.name] = 'error: ' + $_.Exception.Message }
}

$out | ConvertTo-Json -Compress
"""


def _ps_literal(path):
    return str(path).replace("'", "''")


# pwsh on Linux can write terminal-mode escapes such as "\x1b[?1h" around `-Command -` output.
TERMINAL_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[=>])")


def _json_result(stdout):
    for line in reversed(TERMINAL_ESCAPE.sub("", stdout).splitlines()):
        if line.strip().startswith("{"):
            return json.loads(line)
    raise AssertionError("no JSON result in the pwsh output: " + repr(stdout))


class RunnerSourceTests(unittest.TestCase):
    def test_pax_gets_the_detected_value(self):
        text = RUNNER.read_text(encoding="utf-8")
        self.assertIn("Dashboard = $paxDashboard", text)
        self.assertNotIn("Dashboard = 'AIBV'", text)
        # -OnlyUserInfo builds no rollup, so it skips the check and passes PAX no -Dashboard.
        detect = text.index(
            "$paxDashboard = if ($OnlyUserInfo) { $null } else { Get-PaxDashboardValue -ScriptPath $pax.Path }")
        self.assertLess(text.index("$pax = Get-PaxReleaseScript"), detect)
        self.assertLess(detect, text.index("& $pax.Path @paxParams"))
        self.assertIn("pax_dashboard      = $paxDashboard", text)

    @unittest.skipUnless(PWSH, "no PowerShell executable available")
    def test_runner_parses(self):
        result = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command",
             f"$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('{_ps_literal(RUNNER)}', [ref]$null, [ref]$e) | Out-Null; $e.Count"],
            capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0")


@unittest.skipUnless(SCRIPTS_ALLOWED, "PowerShell execution policy blocks scripts here (not bypassed)")
class DashboardChoiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = []
            for name, text in PAX_SCRIPTS.items():
                path = root / f"PAX_Purview_Audit_Log_Processor_{name}.ps1"
                path.write_text(text, encoding="utf-8")
                cases.append({"name": name, "path": str(path)})
            cases_json = root / "cases.json"
            cases_json.write_text(json.dumps(cases), encoding="utf-8")
            command = (HARNESS.replace("__RUNNER__", _ps_literal(RUNNER))
                       .replace("__CASES__", _ps_literal(cases_json)))
            result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", "-"], input=command,
                                    capture_output=True, text=True, timeout=180, check=False,
                                    env={**os.environ, "NO_COLOR": "1"})
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        cls.out = _json_result(result.stdout)

    def test_current_release_gets_valuelens(self):
        self.assertEqual(self.out["v1.11.15"], "ValueLens")

    def test_older_releases_keep_aibv(self):
        self.assertEqual(self.out["v1.11.14"], "AIBV")

    def test_prereleases_without_a_validateset_get_valuelens(self):
        self.assertEqual(self.out["prerelease"], "ValueLens")

    def test_release_without_dashboard_stops(self):
        self.assertTrue(self.out["v1.11.4"].startswith("error: This PAX release has no -Dashboard parameter"),
                        self.out["v1.11.4"])
        self.assertIn("v1.11.5", self.out["v1.11.4"])

    def test_release_without_either_name_stops(self):
        self.assertTrue(self.out["neither"].startswith("error: This PAX release's -Dashboard accepts only AIO, M365"),
                        self.out["neither"])

    def test_unreadable_download_points_at_force_download(self):
        self.assertTrue(self.out["truncated"].startswith("error: Can't read the PAX script"), self.out["truncated"])
        self.assertIn("-ForcePaxDownload", self.out["truncated"])

    def test_pax_code_never_runs(self):
        self.assertNotIn("PAX code ran", json.dumps(self.out))


if __name__ == "__main__":
    unittest.main()
