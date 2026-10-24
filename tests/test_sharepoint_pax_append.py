"""Run-PAX-AIBV.ps1's pinned release and appends, and Upload-Rollups-SharePoint.ps1 -File.

PAX purview-v1.11.15 takes one destination per output stream: -OutputPath or -AppendFile
for the interactions, and -OutputPathUserInfo or -AppendUserInfo for the users. A bare
-AppendFile name is read against -OutputPath, so an append run must pass the full path.

The scripts run against a stub PAX that records the parameters it gets. Invoke-RestMethod
and Invoke-WebRequest are replaced by functions in the harness session, so nothing reaches
GitHub, Entra or SharePoint. Running the scripts needs a PowerShell whose execution policy
allows them (CI's pwsh on Linux does); where the policy blocks scripts the tests are
skipped, not bypassed.
"""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "4. SharePoint" / "scripts"
RUNNER = SCRIPTS / "Run-PAX-AIBV.ps1"
UPLOADER = SCRIPTS / "Upload-Rollups-SharePoint.ps1"

TAG = "purview-v9.9.9"
ASSET = "PAX_Purview_Audit_Log_Processor_v9.9.9.ps1"


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

STUB_PAX = r"""[CmdletBinding()]
param(
  [string]$TenantId,
  [string]$ClientId,
  [string]$ClientSecret,
  [string]$Auth,
  [ValidateSet('AIO', 'ValueLens', 'M365', 'AISID')]
  [string]$Dashboard = 'AIO',
  [string]$StartDate,
  [string]$EndDate,
  [string]$OutputPath,
  [string]$AppendFile,
  [switch]$IncludeUserInfo,
  [string]$OutputPathUserInfo,
  [string]$AppendUserInfo,
  [switch]$Rollup,
  [switch]$RollupPlusRaw,
  [switch]$Deidentify,
  [string]$FillerLabel,
  [string]$FillerLabelText,
  [string]$UserInfoFile,
  [switch]$SkipVersionCheck,
  [switch]$IncludeAgent365Info
)
$bound = [ordered]@{}
foreach ($key in $PSBoundParameters.Keys) {
  if ($key -ne 'ClientSecret') { $bound[$key] = "$($PSBoundParameters[$key])" }
}
$bound['HasSecret'] = [bool]$ClientSecret
$bound | ConvertTo-Json | Set-Content -LiteralPath $env:PAX_STUB_LOG -Encoding utf8
if ($env:PAX_STUB_MODE -eq 'no-output') { exit 0 }
if ($env:PAX_STUB_MODE -eq 'rollup-fail') {
  # PAX logs a failed rollup and still exits 0. Its log sits beside the append target, or in
  # the output folder on a seed run; a seed run can leave a partial interactions file.
  $logDir = if ($AppendFile) { Split-Path -Parent $AppendFile } else { $OutputPath }
  Set-Content -LiteralPath (Join-Path $logDir 'Purview_Audit_UsageActivity_CopilotInteraction_stub.log') -Value @(
    '[2026-10-24 10:00:00] [INFO] Rollup: running the post-processor.',
    '[2026-10-24 10:00:01] [ERROR] Rollup: post-processor returned non-zero exit code 1. Raw CSV(s) preserved.')
  if ($OutputPath) { Set-Content -LiteralPath (Join-Path $OutputPath 'Purview_Stub_Interactions.csv') -Value 'Message_Id_Raw' }
  exit 0
}
if ($env:PAX_STUB_SKIP_MERGE -ne '1') {
  if ($AppendFile) { Add-Content -LiteralPath $AppendFile -Value 'merged' }
  if ($AppendUserInfo) { Add-Content -LiteralPath $AppendUserInfo -Value 'merged' }
}
if ($OutputPath) { Set-Content -LiteralPath (Join-Path $OutputPath 'Purview_Stub_Interactions.csv') -Value 'Message_Id_Raw' }
if ($OutputPathUserInfo) { Set-Content -LiteralPath (Join-Path $OutputPathUserInfo 'EntraUsers_Stub_Users.csv') -Value 'PersonId' }
"""

HARNESS = r"""param([string]$CasesPath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'

function global:Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Method, [string]$Uri, $Headers, $Body, [string]$ContentType, [string]$InFile)
  $global:Calls.Add([pscustomobject]@{ Cmd = 'Invoke-RestMethod'; Method = $Method; Uri = $Uri; ContentType = $ContentType; InFile = $InFile })
  if ($Uri -like 'https://api.github.com/*') {
    if ($global:Case.github -ne 'release') { throw 'offline' }
    return [pscustomobject]@{
      tag_name = $global:Case.tag
      assets = @([pscustomobject]@{ name = $global:Case.asset; browser_download_url = 'https://example.invalid/pax.ps1' })
    }
  }
  if ($Uri -like 'https://login.microsoftonline.com/*') { return [pscustomobject]@{ access_token = 'token' } }
  if ($Uri -like 'https://graph.microsoft.com/*') { return $null }
  throw "unexpected call to $Uri"
}

function global:Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Method, [string]$Uri, [string]$OutFile, $Headers)
  $global:Calls.Add([pscustomobject]@{ Cmd = 'Invoke-WebRequest'; Method = $Method; Uri = $Uri; ContentType = $null; InFile = $null })
  if ($global:Case.download -eq 'good') { Copy-Item -LiteralPath $global:Case.goodStub -Destination $OutFile -Force }
  elseif ($global:Case.download -eq 'bad') { Set-Content -LiteralPath $OutFile -Value 'tampered' }
  else { throw 'offline' }
}

$results = [ordered]@{}
foreach ($case in (Get-Content -LiteralPath $CasesPath -Raw -Encoding UTF8 | ConvertFrom-Json)) {
  $global:Case = $case
  $global:Calls = [System.Collections.Generic.List[object]]::new()
  $env:PAX_STUB_LOG = $case.stubLog
  $env:PAX_STUB_SKIP_MERGE = if ($case.skipMerge) { '1' } else { '0' }
  $env:PAX_STUB_MODE = [string]$case.stubMode
  $params = @{}
  foreach ($prop in $case.args.PSObject.Properties) { $params[$prop.Name] = $prop.Value }
  $text = [System.Text.StringBuilder]::new()
  $err = $null
  try {
    & $case.script @params *>&1 | ForEach-Object { [void]$text.AppendLine("$_") }
  } catch {
    $err = $_.Exception.Message
  }
  $results[$case.name] = [ordered]@{ error = $err; output = $text.ToString(); calls = @($global:Calls) }
}
$results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding utf8
"""


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _read_json(path):
    path = Path(path)
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else None


def _same(a, b):
    return a is not None and Path(a).exists() and os.path.samefile(a, b)


class SourceTests(unittest.TestCase):
    @unittest.skipUnless(PWSH, "no PowerShell executable available")
    def test_uploader_parses(self):
        literal = str(UPLOADER).replace("'", "''")
        result = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command",
             f"$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('{literal}', [ref]$null, [ref]$e) | Out-Null; $e.Count"],
            capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0")

    def test_runner_never_sends_an_output_folder_with_an_append_target(self):
        text = RUNNER.read_text(encoding="utf-8")
        self.assertNotIn("  OutputPath = $OutDir\n", text.replace("\r\n", "\n"))
        self.assertIn("$paxParams.OutputPath = $OutDir", text)
        self.assertIn("$paxParams.AppendFile = $appendTarget", text)
        self.assertIn("$paxParams.AppendUserInfo = $appendUsersTarget", text)


@unittest.skipUnless(SCRIPTS_ALLOWED, "PowerShell execution policy blocks scripts here (not bypassed)")
class ScriptBehaviourTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="vl-pax-"))
        cls.stub = cls.tmp / "stub" / ASSET
        cls.stub.parent.mkdir(parents=True)
        cls.stub.write_text(STUB_PAX, encoding="utf-8")
        cls.sha = _sha256(cls.stub)
        cls.cases = {}
        cases = []

        def add(name, script=RUNNER, args=None, cache="good", **extra):
            root = cls.tmp / name
            work = root / "work"
            cache_dir = work / "pax" / "releases" / TAG
            cache_dir.mkdir(parents=True)
            if cache == "good":
                shutil.copyfile(cls.stub, cache_dir / ASSET)
            elif cache == "tampered":
                (cache_dir / ASSET).write_text("tampered\n", encoding="utf-8")
            (work / "processed").mkdir()
            base = {"TenantId": "tenant", "ClientId": "client", "ClientSecret": "secret"}
            if script == RUNNER:
                base.update({"WorkRoot": str(work), "PaxReleaseTag": TAG, "PaxSha256": cls.sha})
            case = {
                "name": name,
                "script": str(script),
                "args": {**base, **(args or {})},
                "stubLog": str(root / "stub-bound.json"),
                "skipMerge": False,
                "stubMode": "",
                "github": "offline",
                "download": "offline",
                "tag": TAG,
                "asset": ASSET,
                "goodStub": str(cls.stub),
                **extra,
            }
            cases.append(case)
            cls.cases[name] = {"root": root, "work": work, "processed": work / "processed",
                               "cached": cache_dir / ASSET, "case": case}
            return root

        add("seed", args={"Days": 30, "SkipVersionCheck": True})

        root = add("append_bare", args={"AppendFile": "cumulative_Interactions.csv",
                                        "AppendUserInfo": "cumulative_Users.csv"})
        for leaf in ("cumulative_Interactions.csv", "cumulative_Users.csv"):
            (root / "work" / "processed" / leaf).write_text("header\n", encoding="utf-8")

        root = add("append_elsewhere")
        data = root / "data"
        data.mkdir()
        for leaf in ("cumulative_Interactions.csv", "cumulative_Users.csv"):
            (data / leaf).write_text("header\n", encoding="utf-8")
        cls.cases["append_elsewhere"]["case"]["args"].update({
            "AppendFile": str(data / "cumulative_Interactions.csv"),
            "AppendUserInfo": str(data / "cumulative_Users.csv"),
        })

        root = add("append_not_updated", skipMerge=True,
                   args={"AppendFile": "cumulative_Interactions.csv", "AppendUserInfo": "cumulative_Users.csv"})
        hour_ago = time.time() - 3600
        for leaf in ("cumulative_Interactions.csv", "cumulative_Users.csv"):
            target = root / "work" / "processed" / leaf
            target.write_text("header\n", encoding="utf-8")
            os.utime(target, (hour_ago, hour_ago))

        add("bad_sha", args={"PaxSha256": "abc"})
        add("sha_with_latest", args={"PaxReleaseTag": "latest"})
        add("users_append_without_users", args={"AppendUserInfo": "cumulative_Users.csv", "IncludeUserInfo": False})
        add("dates_start_only", args={"StartDate": "2026-09-01"})
        add("dates_bad_format", args={"StartDate": "01/09/2026", "EndDate": "2026-09-08"})
        add("dates_end_not_after_start", args={"StartDate": "2026-09-08", "EndDate": "2026-09-08"})
        add("explicit_dates", args={"StartDate": "2026-09-01", "EndDate": "2026-09-08", "Days": 30})

        add("rollup_fail_seed", stubMode="rollup-fail")
        root = add("rollup_fail_append", stubMode="rollup-fail")
        data = root / "data"
        data.mkdir()
        for leaf in ("cumulative_Interactions.csv", "cumulative_Users.csv"):
            (data / leaf).write_text("header\n", encoding="utf-8")
        cls.cases["rollup_fail_append"]["case"]["args"].update({
            "AppendFile": str(data / "cumulative_Interactions.csv"),
            "AppendUserInfo": str(data / "cumulative_Users.csv"),
        })

        # An earlier run's failed-rollup log and outputs are left alone.
        root = add("earlier_failure_log_ignored")
        old_log = root / "work" / "processed" / "Purview_Audit_old.log"
        old_log.write_text("[2026-10-01 10:00:01] [ERROR] Rollup: post-processor failed: old\n", encoding="utf-8")
        os.utime(old_log, (hour_ago, hour_ago))
        root = add("earlier_outputs_not_picked", stubMode="no-output")
        for leaf in ("Purview_Old_Interactions.csv", "EntraUsers_Old_Users.csv"):
            old = root / "work" / "processed" / leaf
            old.write_text("old\n", encoding="utf-8")
            os.utime(old, (hour_ago, hour_ago))

        add("cached_mismatch_redownloads", cache="tampered", github="release", download="good")
        add("download_mismatch_stops", cache=None, github="release", download="bad")
        add("cache_mismatch_offline_stops", cache="tampered")

        root = add("upload_file", script=UPLOADER)
        (root / "notes.json").write_text("{}\n", encoding="utf-8")
        cls.cases["upload_file"]["case"]["args"].update({
            "File": str(root / "notes.json"), "SiteId": "site", "DriveId": "drive", "FolderPath": "/VL data"})

        root = add("upload_csv_renamed", script=UPLOADER)
        (root / "extra.csv").write_text("a,b\n", encoding="utf-8")
        cls.cases["upload_csv_renamed"]["case"]["args"].update({
            "File": str(root / "extra.csv"), "RemoteName": "copilot_extra.csv",
            "SiteId": "site", "DriveId": "drive", "FolderPath": "/"})

        root = add("upload_rejects_folder_in_name", script=UPLOADER)
        (root / "extra.csv").write_text("a,b\n", encoding="utf-8")
        cls.cases["upload_rejects_folder_in_name"]["case"]["args"].update({
            "File": str(root / "extra.csv"), "RemoteName": "sub/extra.csv",
            "SiteId": "site", "DriveId": "drive"})

        root = add("upload_file_or_manifest", script=UPLOADER)
        (root / "extra.csv").write_text("a,b\n", encoding="utf-8")
        cls.cases["upload_file_or_manifest"]["case"]["args"].update({
            "File": str(root / "extra.csv"), "Manifest": str(root / "rollup-manifest.json"),
            "SiteId": "site", "DriveId": "drive"})

        cases_path = cls.tmp / "cases.json"
        cases_path.write_text(json.dumps(cases), encoding="utf-8")
        harness = cls.tmp / "harness.ps1"
        harness.write_text(HARNESS, encoding="utf-8")
        result_path = cls.tmp / "results.json"
        result = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-File", str(harness),
             "-CasesPath", str(cases_path), "-ResultPath", str(result_path)],
            capture_output=True, text=True, timeout=300, check=False, env={**os.environ, "NO_COLOR": "1"})
        if result.returncode != 0 or not result_path.exists():
            raise AssertionError(result.stdout + result.stderr)
        cls.results = _read_json(result_path)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def result(self, name):
        return self.results[name]

    def bound(self, name):
        return _read_json(self.cases[name]["case"]["stubLog"])

    def manifest(self, name):
        return _read_json(self.cases[name]["processed"] / "rollup-manifest.json")

    def assertRan(self, name):
        res = self.result(name)
        self.assertIsNone(res["error"], res["output"])

    def test_seed_writes_new_files_to_the_output_folder(self):
        self.assertRan("seed")
        bound = self.bound("seed")
        processed = self.cases["seed"]["processed"]
        self.assertTrue(_same(bound["OutputPath"], processed))
        self.assertTrue(_same(bound["OutputPathUserInfo"], processed))
        for key in ("AppendFile", "AppendUserInfo"):
            self.assertNotIn(key, bound)
        self.assertEqual(bound["IncludeUserInfo"], "True")
        self.assertEqual(bound["SkipVersionCheck"], "True")
        self.assertEqual(bound["Dashboard"], "ValueLens")
        self.assertTrue(bound["HasSecret"])
        manifest = self.manifest("seed")
        self.assertTrue(_same(manifest["interactions_csv"], processed / "Purview_Stub_Interactions.csv"))
        self.assertTrue(_same(manifest["users_csv"], processed / "EntraUsers_Stub_Users.csv"))
        self.assertIsNone(manifest["append_file"])
        self.assertIsNone(manifest["append_user_info"])
        self.assertEqual(manifest["pax_sha256"], self.sha)
        start, end = (date.fromisoformat(bound[k]) for k in ("StartDate", "EndDate"))
        self.assertEqual((end - start).days, 30)
        self.assertEqual(manifest["window_days"], 30)

    def test_explicit_dates_go_to_pax_and_set_the_window(self):
        self.assertRan("explicit_dates")
        bound = self.bound("explicit_dates")
        self.assertEqual((bound["StartDate"], bound["EndDate"]), ("2026-09-01", "2026-09-08"))
        manifest = self.manifest("explicit_dates")
        self.assertEqual((manifest["window_start"], manifest["window_end"]), ("2026-09-01", "2026-09-08"))
        self.assertEqual(manifest["window_days"], 7)

    def test_a_failed_rollup_stops_the_run_though_pax_exits_0(self):
        logs = {"rollup_fail_seed": self.cases["rollup_fail_seed"]["processed"],
                "rollup_fail_append": self.cases["rollup_fail_append"]["root"] / "data"}
        for name, folder in logs.items():
            with self.subTest(name):
                res = self.result(name)
                self.assertIsNotNone(res["error"], res["output"])
                self.assertIn("PAX's rollup step failed, though PAX exited 0: Rollup: post-processor returned "
                              "non-zero exit code 1. Raw CSV(s) preserved.", res["error"])
                self.assertNotIn("[ERROR]", res["error"])
                log = res["error"].split("PAX's log: ", 1)[1].strip()
                self.assertTrue(_same(log, folder / "Purview_Audit_UsageActivity_CopilotInteraction_stub.log"))
                self.assertIsNone(self.manifest(name))
                self.assertNotIn("PAX finished", res["output"])

    def test_an_earlier_runs_failure_log_is_not_read(self):
        self.assertRan("earlier_failure_log_ignored")
        self.assertIsNotNone(self.manifest("earlier_failure_log_ignored"))

    def test_an_earlier_runs_outputs_are_never_taken_for_this_runs(self):
        res = self.result("earlier_outputs_not_picked")
        self.assertIsNotNone(res["error"])
        self.assertIn("PAX wrote no rollup interactions CSV to", res["error"])
        self.assertIn("this run", res["error"])
        self.assertIsNone(self.manifest("earlier_outputs_not_picked"))

    def test_pinned_cache_is_used_without_github(self):
        self.assertRan("seed")
        self.assertEqual(self.result("seed")["calls"], [])
        self.assertIn("SHA-256 matches", self.result("seed")["output"])

    def test_append_sends_full_paths_and_no_output_folders(self):
        for name, folder in (("append_bare", self.cases["append_bare"]["processed"]),
                             ("append_elsewhere", self.cases["append_elsewhere"]["root"] / "data")):
            with self.subTest(name):
                self.assertRan(name)
                bound = self.bound(name)
                interactions = folder / "cumulative_Interactions.csv"
                users = folder / "cumulative_Users.csv"
                self.assertNotIn("OutputPath", bound)
                self.assertNotIn("OutputPathUserInfo", bound)
                self.assertTrue(os.path.isabs(bound["AppendFile"]))
                self.assertTrue(_same(bound["AppendFile"], interactions))
                self.assertTrue(_same(bound["AppendUserInfo"], users))
                self.assertEqual(bound["IncludeUserInfo"], "True")
                self.assertNotIn("SkipVersionCheck", bound)
                manifest = self.manifest(name)
                self.assertTrue(_same(manifest["interactions_csv"], interactions))
                self.assertTrue(_same(manifest["users_csv"], users))
                self.assertTrue(_same(manifest["append_file"], interactions))
                self.assertTrue(_same(manifest["append_user_info"], users))
                self.assertTrue(manifest["append_mode"])
                self.assertNotIn("didn't update", self.result(name)["output"])

    def test_append_targets_pax_left_alone_are_flagged(self):
        self.assertRan("append_not_updated")
        output = self.result("append_not_updated")["output"]
        self.assertIn("didn't update", output)
        self.assertIn("cumulative_Interactions.csv", output.split("didn't update", 1)[1])
        self.assertEqual(output.count("didn't update"), 2)

    def test_bad_inputs_stop_before_any_download_or_pax_run(self):
        expected = {
            "bad_sha": "-PaxSha256 must be 64 hex characters",
            "sha_with_latest": "-PaxSha256 needs a fixed -PaxReleaseTag",
            "users_append_without_users": "-AppendUserInfo merges the Users file",
            "dates_start_only": "-StartDate and -EndDate go together",
            "dates_bad_format": "-StartDate must be a date as yyyy-MM-dd",
            "dates_end_not_after_start": "-EndDate must be after -StartDate",
        }
        for name, message in expected.items():
            with self.subTest(name):
                res = self.result(name)
                self.assertIsNotNone(res["error"])
                self.assertIn(message, res["error"])
                self.assertEqual(res["calls"], [])
                self.assertIsNone(self.bound(name))

    def test_cached_copy_that_does_not_match_is_downloaded_again(self):
        self.assertRan("cached_mismatch_redownloads")
        res = self.result("cached_mismatch_redownloads")
        self.assertIn("doesn't match the expected SHA-256. Downloading it again", res["output"])
        self.assertEqual([c["Cmd"] for c in res["calls"]], ["Invoke-RestMethod", "Invoke-WebRequest"])
        self.assertEqual(_sha256(self.cases["cached_mismatch_redownloads"]["cached"]), self.sha)
        self.assertIsNotNone(self.bound("cached_mismatch_redownloads"))
        release = _read_json(self.cases["cached_mismatch_redownloads"]["cached"].parent / "release.json")
        self.assertEqual(release["sha256"], self.sha)

    def test_download_that_does_not_match_is_deleted_and_never_run(self):
        res = self.result("download_mismatch_stops")
        self.assertIsNotNone(res["error"])
        self.assertIn("doesn't match the expected SHA-256, so it wasn't run", res["error"])
        self.assertFalse(self.cases["download_mismatch_stops"]["cached"].exists())
        self.assertIsNone(self.bound("download_mismatch_stops"))

    def test_mismatched_cache_is_not_run_when_github_is_unreachable(self):
        res = self.result("cache_mismatch_offline_stops")
        self.assertIsNotNone(res["error"])
        self.assertIn("Failed to resolve PAX release", res["error"])
        self.assertIsNone(self.bound("cache_mismatch_offline_stops"))

    def test_upload_one_file_keeps_its_name(self):
        res = self.result("upload_file")
        self.assertIsNone(res["error"], res["output"])
        calls = res["calls"]
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0]["Uri"].startswith("https://login.microsoftonline.com/tenant/"))
        put = calls[1]
        self.assertEqual(put["Method"], "PUT")
        self.assertEqual(put["Uri"], "https://graph.microsoft.com/v1.0/drives/drive/root:/VL%20data/notes.json:/content")
        self.assertEqual(put["ContentType"], "application/octet-stream")
        self.assertTrue(_same(put["InFile"], self.cases["upload_file"]["root"] / "notes.json"))

    def test_upload_one_file_under_another_name(self):
        res = self.result("upload_csv_renamed")
        self.assertIsNone(res["error"], res["output"])
        put = res["calls"][-1]
        self.assertEqual(put["Uri"], "https://graph.microsoft.com/v1.0/drives/drive/root:/copilot_extra.csv:/content")
        self.assertEqual(put["ContentType"], "text/csv")

    def test_upload_rejects_a_folder_in_the_remote_name(self):
        res = self.result("upload_rejects_folder_in_name")
        self.assertIsNotNone(res["error"])
        self.assertIn("-RemoteName must be a file name", res["error"])
        self.assertEqual(res["calls"], [])

    def test_upload_takes_a_file_or_a_manifest_not_both(self):
        res = self.result("upload_file_or_manifest")
        self.assertIsNotNone(res["error"])
        self.assertIn("Parameter set cannot be resolved", res["error"])
        self.assertEqual(res["calls"], [])


if __name__ == "__main__":
    unittest.main()
