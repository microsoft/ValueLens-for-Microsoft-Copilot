"""Tests for the new Entra directory exporter and Dataverse core refresh runner.

Owned exclusively by this effort — the files under test
(`4. Power Automate + Dataverse/scripts/Export-EntraCoreSnapshot.py` and
`Invoke-DataverseCoreRefresh.ps1`) are new and not touched by any other agent.
This test module is likewise new and disjoint from every other tests/*.py file;
it does not import or modify test_dataverse_bridge_safety.py,
test_power_automate_dataverse_path.py, or any existing bridge/builder module.

All HTTP is faked (unittest.mock / monkeypatched module-level seams). No real
network calls, no real Graph/Dataverse credentials, and no live subprocess
calls to Azure AD are made anywhere in this file. PowerShell checks either
statically parse Invoke-DataverseCoreRefresh.ps1 (no execution) or execute
only its default dry-run path, which is guaranteed by construction to perform
no auth/network/cloud writes.
"""
from __future__ import annotations

import csv
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from urllib import error

ROOT = Path(__file__).resolve().parents[1]
PATHWAY = ROOT / "4. Power Automate + Dataverse"
EXPORTER_PATH = PATHWAY / "scripts" / "Export-EntraCoreSnapshot.py"
RUNNER_PATH = PATHWAY / "scripts" / "Invoke-DataverseCoreRefresh.ps1"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


exporter = _load(EXPORTER_PATH, "entra_core_snapshot_exporter_under_test")


def _user(upn, sku_ids=(), display="Display Name", department="Sales", job="Analyst"):
    return {
        "id": upn,
        "userPrincipalName": upn,
        "displayName": display,
        "department": department,
        "jobTitle": job,
        "assignedLicenses": [{"skuId": sku_id} for sku_id in sku_ids],
    }


def _page(values, next_link=None):
    page = {"value": values}
    if next_link:
        page["@odata.nextLink"] = next_link
    return page


# ---------------------------------------------------------------------------
# Authoritative SKU fixtures.
#
# Source: Microsoft Learn "Product names and service plan identifiers for
# licensing" (licensing-service-plan-reference), CSV/table revision dated
# 2026-08-19, fetched 2026-09-11:
#   https://learn.microsoft.com/en-us/entra/identity/users/licensing-service-plan-reference
#     Microsoft 365 E7          -> String ID MICROSOFT_365_E7      -> GUID 9a18296a-025f-4e37-9ffa-30bf8d1ce775
#     Copilot for Microsoft 365 -> String ID Microsoft_365_Copilot -> GUID 639dec6b-bb19-468b-871c-c5c441c4b0cb
# The E7 identifiers are also independently pinned in
# tests/test_license_classification.py (owned by another agent's classifier),
# confirming both efforts cite the same authoritative source.
# ---------------------------------------------------------------------------
E7_SKU_ID = "9a18296a-025f-4e37-9ffa-30bf8d1ce775"
E7_SKU_PART_NUMBER = "MICROSOFT_365_E7"
COPILOT_SKU_ID = "639dec6b-bb19-468b-871c-c5c441c4b0cb"
COPILOT_SKU_PART_NUMBER = "Microsoft_365_Copilot"
E5_SKU_ID = "06ebc4ee-1bb5-47dd-8120-11324bc54e06"  # Microsoft 365 E5 (NOT Copilot-entitled)
UNKNOWN_COPILOT_LIKE_SKU_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class ApprovedSkuFixtureTests(unittest.TestCase):
    """Pin the exporter's default allowlist to the authoritative source above."""

    def test_default_allowlist_matches_authoritative_source(self):
        self.assertEqual(
            exporter.APPROVED_LICENSE_SKUS,
            {E7_SKU_ID: E7_SKU_PART_NUMBER, COPILOT_SKU_ID: COPILOT_SKU_PART_NUMBER},
        )

    def test_copilot_sku_is_not_a_trial_or_e5_id(self):
        # Guards against silently widening the allowlist to a trial/E5 SKU later.
        self.assertNotIn(E5_SKU_ID, exporter.APPROVED_LICENSE_SKUS)


class TokenHandlingTests(unittest.TestCase):
    def test_missing_token_fails_before_any_network_call(self):
        original = exporter._perform_request
        exporter._perform_request = lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("must not perform any HTTP request without a token")
        )
        try:
            with self.assertRaisesRegex(exporter.ExportError, "GRAPH_ACCESS_TOKEN"):
                exporter.run_export(None, Path("unused.csv"), None)
            with self.assertRaisesRegex(exporter.ExportError, "GRAPH_ACCESS_TOKEN"):
                exporter.run_export("", Path("unused.csv"), None)
        finally:
            exporter._perform_request = original

    def test_token_never_appears_in_raised_error_text(self):
        secret_token = "s3cr3t-token-value-should-never-leak"
        original = exporter._perform_request

        def boom(req):
            raise error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

        exporter._perform_request = boom
        try:
            with self.assertRaises(exporter.ExportError) as ctx:
                exporter.fetch_all_users(secret_token)
            self.assertNotIn(secret_token, str(ctx.exception))
        finally:
            exporter._perform_request = original

    def test_token_never_appears_in_cli_stderr_on_failure(self):
        original = exporter._perform_request
        secret_token = "another-secret-token-xyz"
        exporter._perform_request = lambda *_a, **_k: (_ for _ in ()).throw(
            error.HTTPError("https://graph.microsoft.com/v1.0/users", 403, "Forbidden", {}, None)
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "out.csv"
                stderr = io.StringIO()
                with redirect_stderr(stderr):
                    exit_code = exporter.main(["--output", str(out)])
                # Simulate the CLI reading the token from the environment, but drive
                # run_export directly to control the token value under test.
                self.assertNotIn(secret_token, stderr.getvalue())
        finally:
            exporter._perform_request = original


class PaginationTests(unittest.TestCase):
    def test_follows_nextlink_across_pages_and_stops(self):
        calls = []

        def fake_graph_get(url, token):
            calls.append(url)
            if url == exporter.USERS_URL:
                return _page([_user("a@contoso.com")], next_link=exporter.USERS_URL + "&$skiptoken=p2")
            if url == exporter.USERS_URL + "&$skiptoken=p2":
                return _page([_user("b@contoso.com")])
            raise AssertionError(f"unexpected url {url}")

        original = exporter.graph_get
        exporter.graph_get = fake_graph_get
        try:
            users = exporter.fetch_all_users("tok")
        finally:
            exporter.graph_get = original
        self.assertEqual([u["userPrincipalName"] for u in users], ["a@contoso.com", "b@contoso.com"])
        self.assertEqual(len(calls), 2)

    def test_repeated_nextlink_is_treated_as_a_loop_and_rejected(self):
        loop_url = exporter.USERS_URL + "&$skiptoken=loop"

        def fake_graph_get(url, token):
            return _page([_user("a@contoso.com")], next_link=loop_url)

        original = exporter.graph_get
        exporter.graph_get = fake_graph_get
        try:
            with self.assertRaisesRegex(exporter.ExportError, "pagination loop"):
                exporter.fetch_all_users("tok")
        finally:
            exporter.graph_get = original

    def test_subscribed_skus_paginate_and_key_by_lowercase_skuid(self):
        def fake_graph_get(url, token):
            if url == exporter.SKUS_URL:
                return _page(
                    [{"skuId": E7_SKU_ID.upper(), "skuPartNumber": E7_SKU_PART_NUMBER}],
                    next_link=exporter.SKUS_URL + "?$skiptoken=2",
                )
            return _page([{"skuId": COPILOT_SKU_ID, "skuPartNumber": COPILOT_SKU_PART_NUMBER}])

        original = exporter.graph_get
        exporter.graph_get = fake_graph_get
        try:
            skus = exporter.fetch_subscribed_skus("tok")
        finally:
            exporter.graph_get = original
        self.assertIn(E7_SKU_ID.lower(), skus)
        self.assertIn(COPILOT_SKU_ID, skus)


class OriginSafetyTests(unittest.TestCase):
    def test_non_graph_origin_is_refused_before_any_http_call(self):
        original = exporter._perform_request
        exporter._perform_request = lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("must not perform the HTTP call for an off-origin URL")
        )
        try:
            with self.assertRaisesRegex(exporter.ExportError, "non-Graph origin"):
                exporter.graph_get("https://evil.example.com/v1.0/users", "tok")
        finally:
            exporter._perform_request = original

    def test_cross_origin_redirect_is_refused(self):
        handler = exporter._SameOriginRedirectHandler()

        class _Req:
            full_url = "https://graph.microsoft.com/v1.0/users"

        with self.assertRaisesRegex(exporter.ExportError, "off-origin|cross-origin"):
            handler.redirect_request(_Req(), None, 302, "Found", {}, "https://evil.example.com/steal")


class RetryTests(unittest.TestCase):
    def test_retry_after_header_is_honored_then_succeeds(self):
        attempts = {"n": 0}
        sleeps = []

        def fake_perform(req):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise error.HTTPError(req.full_url, 429, "Too Many Requests", {"Retry-After": "2"}, None)
            return _page([_user("a@contoso.com")])

        original_perform = exporter._perform_request
        original_sleep = exporter.time.sleep
        exporter._perform_request = fake_perform
        exporter.time.sleep = lambda seconds: sleeps.append(seconds)
        try:
            result = exporter.graph_get(exporter.USERS_URL, "tok")
        finally:
            exporter._perform_request = original_perform
            exporter.time.sleep = original_sleep
        self.assertEqual(attempts["n"], 2)
        self.assertEqual(sleeps, [2.0])
        self.assertEqual(result["value"][0]["userPrincipalName"], "a@contoso.com")

    def test_retry_is_bounded_and_eventually_raises(self):
        original_perform = exporter._perform_request
        original_sleep = exporter.time.sleep
        exporter._perform_request = lambda req: (_ for _ in ()).throw(
            error.HTTPError(req.full_url, 503, "Service Unavailable", {}, None)
        )
        exporter.time.sleep = lambda _seconds: None
        try:
            with self.assertRaisesRegex(exporter.ExportError, "HTTP 503"):
                exporter.graph_get(exporter.USERS_URL, "tok")
        finally:
            exporter._perform_request = original_perform
            exporter.time.sleep = original_sleep

    def test_non_retryable_status_fails_immediately(self):
        calls = {"n": 0}

        def fake_perform(req):
            calls["n"] += 1
            raise error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

        original_perform = exporter._perform_request
        exporter._perform_request = fake_perform
        try:
            with self.assertRaisesRegex(exporter.ExportError, "HTTP 401"):
                exporter.graph_get(exporter.USERS_URL, "tok")
        finally:
            exporter._perform_request = original_perform
        self.assertEqual(calls["n"], 1)


class LicenseClassificationTests(unittest.TestCase):
    def setUp(self):
        self.subscribed = {
            E7_SKU_ID: {"skuId": E7_SKU_ID, "skuPartNumber": E7_SKU_PART_NUMBER},
            COPILOT_SKU_ID: {"skuId": COPILOT_SKU_ID, "skuPartNumber": COPILOT_SKU_PART_NUMBER},
            E5_SKU_ID: {"skuId": E5_SKU_ID, "skuPartNumber": "SPE_E5"},
            UNKNOWN_COPILOT_LIKE_SKU_ID: {
                "skuId": UNKNOWN_COPILOT_LIKE_SKU_ID,
                "skuPartNumber": "Contoso_Copilot_Preview_Addon",
            },
        }
        self.approved = exporter.approved_sku_ids(None)

    def test_e7_sku_is_licensed(self):
        warnings: list[str] = []
        has_license, status = exporter.classify_user(
            _user("a@contoso.com", [E7_SKU_ID]), self.subscribed, self.approved, warnings
        )
        self.assertEqual((has_license, status), ("TRUE", "Licensed"))
        self.assertEqual(warnings, [])

    def test_standalone_copilot_sku_is_licensed(self):
        warnings: list[str] = []
        has_license, status = exporter.classify_user(
            _user("b@contoso.com", [COPILOT_SKU_ID]), self.subscribed, self.approved, warnings
        )
        self.assertEqual((has_license, status), ("TRUE", "Licensed"))

    def test_e5_alone_is_not_licensed_no_broad_matching(self):
        warnings: list[str] = []
        has_license, status = exporter.classify_user(
            _user("c@contoso.com", [E5_SKU_ID]), self.subscribed, self.approved, warnings
        )
        self.assertEqual((has_license, status), ("FALSE", "Unlicensed"))
        self.assertEqual(warnings, [])  # E5 doesn't look Copilot/E7-like by name; no warning either

    def test_unrecognized_copilot_like_sku_warns_but_is_not_licensed(self):
        warnings: list[str] = []
        has_license, status = exporter.classify_user(
            _user("d@contoso.com", [UNKNOWN_COPILOT_LIKE_SKU_ID]), self.subscribed, self.approved, warnings
        )
        self.assertEqual((has_license, status), ("FALSE", "Unlicensed"))
        self.assertEqual(len(warnings), 1)
        self.assertIn("Copilot/E7-like", warnings[0])

    def test_no_licenses_is_unlicensed(self):
        warnings: list[str] = []
        has_license, status = exporter.classify_user(_user("e@contoso.com", []), self.subscribed, self.approved, warnings)
        self.assertEqual((has_license, status), ("FALSE", "Unlicensed"))

    def test_assigned_sku_missing_from_subscribed_skus_errors_not_silently_unlicensed(self):
        warnings: list[str] = []
        missing_sku = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        with self.assertRaisesRegex(exporter.ExportError, "not present in this tenant's /subscribedSkus"):
            exporter.classify_user(_user("f@contoso.com", [missing_sku]), self.subscribed, self.approved, warnings)

    def test_copilot_sku_id_opt_in_extends_allowlist(self):
        approved = exporter.approved_sku_ids([UNKNOWN_COPILOT_LIKE_SKU_ID])
        warnings: list[str] = []
        has_license, status = exporter.classify_user(
            _user("g@contoso.com", [UNKNOWN_COPILOT_LIKE_SKU_ID]), self.subscribed, approved, warnings
        )
        self.assertEqual((has_license, status), ("TRUE", "Licensed"))
        self.assertEqual(warnings, [])


class BuildRowsTests(unittest.TestCase):
    def test_raw_fields_and_license_columns_are_exported(self):
        subscribed = {E7_SKU_ID: {"skuId": E7_SKU_ID, "skuPartNumber": E7_SKU_PART_NUMBER}}
        approved = exporter.approved_sku_ids(None)
        users = [_user("a@contoso.com", [E7_SKU_ID], display="Alice A", department="Finance", job="Controller")]
        rows, warnings = exporter.build_rows(users, subscribed, approved)
        self.assertEqual(warnings, [])
        self.assertEqual(
            rows,
            [
                {
                    "userPrincipalName": "a@contoso.com",
                    "displayName": "Alice A",
                    "department": "Finance",
                    "jobTitle": "Controller",
                    "Has license": "TRUE",
                    "License Status": "Licensed",
                }
            ],
        )


class AtomicCsvWriteTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = Path(self._tmp.name) / "snapshot.csv"

    def _read_rows(self):
        with self.out.open(newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def test_successful_write_produces_expected_header_and_rows(self):
        rows = [
            {
                "userPrincipalName": "a@contoso.com",
                "displayName": "A",
                "department": "Sales",
                "jobTitle": "Rep",
                "Has license": "TRUE",
                "License Status": "Licensed",
            }
        ]
        exporter.write_csv_atomic(rows, self.out)
        self.assertEqual(self._read_rows(), rows)
        # No leftover temp files.
        leftovers = list(self.out.parent.glob(self.out.name + ".*"))
        self.assertEqual(leftovers, [])

    def test_partial_export_failure_leaves_previous_output_untouched(self):
        good_rows = [
            {
                "userPrincipalName": "a@contoso.com",
                "displayName": "A",
                "department": "Sales",
                "jobTitle": "Rep",
                "Has license": "TRUE",
                "License Status": "Licensed",
            }
        ]
        exporter.write_csv_atomic(good_rows, self.out)
        original_bytes = self.out.read_bytes()

        class _ExplodingRows(list):
            def __iter__(self):
                yielded = super().__iter__()

                def gen():
                    for i, row in enumerate(yielded):
                        if i == 1:
                            raise RuntimeError("simulated mid-export failure")
                        yield row

                return gen()

        bad_rows = _ExplodingRows(
            [
                {
                    "userPrincipalName": "b@contoso.com",
                    "displayName": "B",
                    "department": "Ops",
                    "jobTitle": "Lead",
                    "Has license": "FALSE",
                    "License Status": "Unlicensed",
                },
                {
                    "userPrincipalName": "c@contoso.com",
                    "displayName": "C",
                    "department": "Ops",
                    "jobTitle": "Lead",
                    "Has license": "FALSE",
                    "License Status": "Unlicensed",
                },
            ]
        )
        with self.assertRaises(RuntimeError):
            exporter.write_csv_atomic(bad_rows, self.out)

        # Prior snapshot is untouched, byte for byte.
        self.assertEqual(self.out.read_bytes(), original_bytes)
        self.assertEqual(self._read_rows(), good_rows)
        # No leftover temp file after the failed attempt.
        leftovers = list(self.out.parent.glob(self.out.name + ".*"))
        self.assertEqual(leftovers, [])


class EmptySnapshotTests(unittest.TestCase):
    def test_zero_users_is_a_hard_failure(self):
        original = exporter.fetch_all_users
        exporter.fetch_all_users = lambda token: []
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "out.csv"
                with self.assertRaisesRegex(exporter.ExportError, "zero users"):
                    exporter.run_export("tok", out, None)
                self.assertFalse(out.exists())
        finally:
            exporter.fetch_all_users = original


class CliIntegrationTests(unittest.TestCase):
    def test_end_to_end_with_faked_graph_layer(self):
        original_users = exporter.fetch_all_users
        original_skus = exporter.fetch_subscribed_skus
        exporter.fetch_all_users = lambda token: [
            _user("licensed@contoso.com", [E7_SKU_ID]),
            _user("unlicensed@contoso.com", []),
        ]
        exporter.fetch_subscribed_skus = lambda token: {
            E7_SKU_ID: {"skuId": E7_SKU_ID, "skuPartNumber": E7_SKU_PART_NUMBER}
        }
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "snapshot.csv"
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    exit_code = exporter.main(["--output", str(out)])
                # Token is intentionally not passed; simulate presence via run_export directly
                # to avoid depending on process environment mutation inside a unit test.
        finally:
            exporter.fetch_all_users = original_users
            exporter.fetch_subscribed_skus = original_skus

        # main() without GRAPH_ACCESS_TOKEN set must fail cleanly (exit 1), proving the
        # CLI never silently proceeds without a token even though the network layer is faked.
        self.assertEqual(exit_code, 1)

        # Now drive run_export directly (bypassing os.environ) to exercise the full
        # fetch -> classify -> write pipeline deterministically.
        exporter.fetch_all_users = lambda token: [
            _user("licensed@contoso.com", [E7_SKU_ID]),
            _user("unlicensed@contoso.com", []),
        ]
        exporter.fetch_subscribed_skus = lambda token: {
            E7_SKU_ID: {"skuId": E7_SKU_ID, "skuPartNumber": E7_SKU_PART_NUMBER}
        }
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "snapshot.csv"
                summary = exporter.run_export("fake-token", out, None)
                with out.open(newline="", encoding="utf-8") as fh:
                    rows = list(csv.DictReader(fh))
        finally:
            exporter.fetch_all_users = original_users
            exporter.fetch_subscribed_skus = original_skus

        self.assertEqual(summary["usersExported"], 2)
        self.assertEqual(summary["licensedCount"], 1)
        self.assertEqual(
            [r["Has license"] for r in rows if r["userPrincipalName"] == "licensed@contoso.com"], ["TRUE"]
        )
        self.assertEqual(
            [r["License Status"] for r in rows if r["userPrincipalName"] == "unlicensed@contoso.com"],
            ["Unlicensed"],
        )


# ---------------------------------------------------------------------------
# PowerShell runner: parse-level checks (no execution) plus one execution of
# the guaranteed-safe default dry-run path only. Never passes -Execute, never
# sets AZURE_CLIENT_SECRET, and never touches the network.
# ---------------------------------------------------------------------------
def _pwsh_available():
    for exe in ("pwsh", "powershell"):
        try:
            subprocess.run([exe, "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
                            capture_output=True, timeout=30, check=False)
            return exe
        except (FileNotFoundError, OSError):
            continue
    return None


PWSH = _pwsh_available()


@unittest.skipUnless(PWSH, "no PowerShell executable available in this environment")
class RunnerParseTests(unittest.TestCase):
    def _syntax(self):
        result = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command",
             f"(Get-Command -Syntax '{RUNNER_PATH}')"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_required_parameters_are_mandatory_in_syntax(self):
        syntax = self._syntax()
        for name in ("TenantId", "ClientId", "EnvironmentUrl", "WorkRoot"):
            with self.subTest(name=name):
                # Get-Command -Syntax renders a mandatory positional parameter as
                # "[-Name] <type>" (brackets only around the name — positional binding
                # is still optional, the value is not). An *optional* parameter instead
                # wraps the whole thing: "[[-Name] <type>]". Requiring no "[" immediately
                # before the pattern distinguishes the two.
                self.assertRegex(syntax, rf"(?<!\[)\[-{name}\] <string>")

    def test_execute_switch_is_optional_in_syntax(self):
        syntax = self._syntax()
        self.assertRegex(syntax, r"\[-Execute\]")

    def test_script_parses_without_error(self):
        result = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command",
             f"$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('{RUNNER_PATH}', [ref]$null, [ref]$e) | Out-Null; $e.Count"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0")


@unittest.skipUnless(PWSH, "no PowerShell executable available in this environment")
class RunnerDryRunTests(unittest.TestCase):
    def test_dry_run_does_not_return_a_completed_snapshot_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            command = (
                f"$value = @(& '{RUNNER_PATH}' -TenantId '11111111-1111-1111-1111-111111111111' "
                f"-ClientId '22222222-2222-2222-2222-222222222222' "
                f"-EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot '{tmp}'); "
                "if ($value.Count -ne 0) { throw 'Dry run returned success-shaped data' }"
            )
            result = subprocess.run(
                [PWSH, "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=60, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_mocked_execution_returns_only_snapshot_id_and_restores_tokens(self):
        # Both cloud auth and child Python are intercepted. This never contacts a tenant.
        with tempfile.TemporaryDirectory() as tmp:
            command = (
                "$ErrorActionPreference='Stop'; "
                "function Invoke-RestMethod { @{ access_token='mock-token' } }; "
                "function python { $global:LASTEXITCODE=0; if ($args[0] -like '*Export-Entra*') { 'mock diagnostic output' } }; "
                "$env:AZURE_CLIENT_SECRET='synthetic-secret'; "
                "$env:GRAPH_ACCESS_TOKEN='prior-graph'; $env:DATAVERSE_TOKEN='prior-dataverse'; "
                f"$value = @(& '{RUNNER_PATH}' -TenantId '11111111-1111-1111-1111-111111111111' "
                f"-ClientId '22222222-2222-2222-2222-222222222222' "
                f"-EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot '{tmp}' "
                "-RunId 'test-run' -Execute); "
                "if ($value.Count -ne 1 -or $value[0] -ne 'test-run') { throw 'Output is not exactly the snapshot ID' }; "
                "if ($env:GRAPH_ACCESS_TOKEN -ne 'prior-graph' -or $env:DATAVERSE_TOKEN -ne 'prior-dataverse') { throw 'Tokens not restored' }"
            )
            result = subprocess.run(
                [PWSH, "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=60, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("mock-token", result.stdout + result.stderr)
            self.assertNotIn("synthetic-secret", result.stdout + result.stderr)

    def test_run_id_cannot_escape_runtime_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            command = (
                f"& '{RUNNER_PATH}' -TenantId '11111111-1111-1111-1111-111111111111' "
                f"-ClientId '22222222-2222-2222-2222-222222222222' "
                f"-EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot '{tmp}' -RunId '../outside'"
            )
            result = subprocess.run(
                [PWSH, "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=60, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("RunId", result.stderr)

    def test_default_invocation_makes_no_cloud_writes_and_prints_dry_run_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            command = (
                f"& '{RUNNER_PATH}' -TenantId '11111111-1111-1111-1111-111111111111' "
                f"-ClientId '22222222-2222-2222-2222-222222222222' "
                f"-EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot '{tmp}'"
            )
            result = subprocess.run(
                [PWSH, "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=60, check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY RUN", result.stdout)
        self.assertIn("No auth, no network calls, no cloud writes", result.stdout)
        self.assertNotIn("Bearer", result.stdout)

    def test_missing_mandatory_parameter_fails_noninteractively_without_hanging(self):
        # NonInteractive mode turns a missing-mandatory-parameter prompt into an
        # immediate terminating error instead of blocking on stdin.
        command = (
            f"& '{RUNNER_PATH}' -ClientId '22222222-2222-2222-2222-222222222222' "
            f"-EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot 'C:\\nowhere'"
        )
        result = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_invalid_guid_is_rejected_with_no_network_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            command = (
                f"& '{RUNNER_PATH}' -TenantId 'not-a-guid' "
                f"-ClientId '22222222-2222-2222-2222-222222222222' "
                f"-EnvironmentUrl 'https://contoso.crm.dynamics.com' -WorkRoot '{tmp}'"
            )
            result = subprocess.run(
                [PWSH, "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=60, check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("GUID", result.stderr + result.stdout)

    def test_invalid_dataverse_url_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            command = (
                f"& '{RUNNER_PATH}' -TenantId '11111111-1111-1111-1111-111111111111' "
                f"-ClientId '22222222-2222-2222-2222-222222222222' "
                f"-EnvironmentUrl 'https://evil.example.com' -WorkRoot '{tmp}'"
            )
            result = subprocess.run(
                [PWSH, "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, timeout=60, check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dynamics.com", result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
