"""Negative-path and safety tests for the Dataverse core snapshot bridge.

These tests are owned by the bridge agent and are intentionally disjoint from
tests/test_power_automate_dataverse_path.py (owned by main). They use only the
stdlib unittest + mock; HTTP is faked, and all filesystem work happens in
auto-cleaned temporary directories. All fixtures are synthetic.
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATHWAY = ROOT / "4. Power Automate + Dataverse"
BRIDGE_PATH = PATHWAY / "scripts" / "Build-DataverseCoreFeeds.py"
DEPLOY_PATH = PATHWAY / "scripts" / "Deploy-DataverseCoreSchema.py"
SCHEMA_PATH = PATHWAY / "dataverse-core-schema.json"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = _load(BRIDGE_PATH, "bridge_under_test")
deploy = _load(DEPLOY_PATH, "deploy_under_test")


def _args(**overrides):
    base = {
        "raw_jsonl": None,
        "raw_csv": None,
        "dataverse_url": None,
        "dataverse_token": None,
        "publish": "local",
    }
    base.update(overrides)
    return type("Args", (), base)()


def _full_audit(user="user@example.com", prompt=True):
    messages = [{"Id": "message-1", "isPrompt": True}] if prompt else [{"Id": "r1", "isPrompt": False}]
    return {
        "Operation": "CopilotInteraction",
        "CreationTime": "2026-09-10T08:00:00Z",
        "UserId": user,
        "CopilotEventData": {"AppHost": "BizChat", "ThreadId": "t1", "Messages": messages},
    }


class SourceSelectionTests(unittest.TestCase):
    def test_local_raw_with_remote_publish_is_accepted(self):
        # The historical bug counted --dataverse-url/token as a second source and
        # blocked a legitimate "read local raw, publish to Dataverse" invocation.
        args = _args(raw_jsonl=Path("raw.jsonl"), dataverse_url="https://c.crm.dynamics.com",
                     dataverse_token="tok", publish="dataverse")
        self.assertEqual(bridge.resolve_input_source(args), "raw_jsonl")

    def test_two_local_sources_rejected(self):
        args = _args(raw_jsonl=Path("a.jsonl"), raw_csv=Path("b.csv"))
        with self.assertRaisesRegex(bridge.PathwayError, "at most one local raw source"):
            bridge.resolve_input_source(args)

    def test_no_source_requires_dataverse_credentials(self):
        with self.assertRaisesRegex(bridge.PathwayError, "Provide a raw source"):
            bridge.resolve_input_source(_args())

    def test_dataverse_source_when_no_local_file(self):
        args = _args(dataverse_url="https://c.crm.dynamics.com", dataverse_token="tok")
        self.assertEqual(bridge.resolve_input_source(args), "dataverse")


class UrlSafetyTests(unittest.TestCase):
    def test_https_dynamics_origin_accepted(self):
        self.assertEqual(
            bridge.validate_dataverse_url("https://contoso.crm.dynamics.com/"),
            "https://contoso.crm.dynamics.com",
        )

    def test_http_rejected(self):
        with self.assertRaisesRegex(bridge.PathwayError, "https"):
            bridge.validate_dataverse_url("http://contoso.crm.dynamics.com")

    def test_userinfo_rejected(self):
        with self.assertRaisesRegex(bridge.PathwayError, "userinfo"):
            bridge.validate_dataverse_url("https://user:pw@contoso.crm.dynamics.com")

    def test_query_rejected(self):
        with self.assertRaisesRegex(bridge.PathwayError, "query"):
            bridge.validate_dataverse_url("https://contoso.crm.dynamics.com/?a=1")

    def test_non_dynamics_host_rejected(self):
        with self.assertRaisesRegex(bridge.PathwayError, "dynamics.com"):
            bridge.validate_dataverse_url("https://evil.example.com")

    def test_environment_path_is_not_silently_stripped(self):
        with self.assertRaisesRegex(bridge.PathwayError, "without a path"):
            bridge.validate_dataverse_url("https://contoso.crm.dynamics.com/api/data")


class ReaderSafetyTests(unittest.TestCase):
    def test_cross_origin_nextlink_is_refused(self):
        original = bridge.dataverse_request

        def fake(method, url, token, body=None):
            return {
                "value": [{"poc_payloadjson": json.dumps({"Operation": "CopilotInteraction"})}],
                "@odata.nextLink": "https://evil.example.com/api/data/v9.2/poc_valuelensrawaudits?$skiptoken=2",
            }

        bridge.dataverse_request = fake
        try:
            with self.assertRaisesRegex(bridge.PathwayError, "off-origin|cross-origin"):
                bridge.read_dataverse_rows("https://contoso.crm.dynamics.com", "tok", "poc_valuelensrawaudits")
        finally:
            bridge.dataverse_request = original

    def test_reader_rejects_non_allowlisted_table(self):
        with self.assertRaisesRegex(bridge.PathwayError, "allowlist"):
            bridge.read_dataverse_rows("https://contoso.crm.dynamics.com", "tok", "poc_secretstuff")

    def test_reader_rejects_missing_value_array(self):
        original = bridge.dataverse_request
        bridge.dataverse_request = lambda *a, **k: {"notvalue": []}
        try:
            with self.assertRaisesRegex(bridge.PathwayError, "value"):
                bridge.read_dataverse_rows("https://contoso.crm.dynamics.com", "tok", "poc_valuelensrawaudits")
        finally:
            bridge.dataverse_request = original

    def test_reader_can_scope_to_collector_run_id(self):
        original = bridge.dataverse_request
        calls = []

        def fake(method, url, token, body=None):
            calls.append(url)
            return {"value": [{"poc_runid": "flow-run-1", "poc_payloadjson": json.dumps({"AuditData": _full_audit()})}]}

        bridge.dataverse_request = fake
        try:
            rows = bridge.read_dataverse_rows("https://contoso.crm.dynamics.com", "tok", "poc_valuelensrawaudits", "flow-run-1")
        finally:
            bridge.dataverse_request = original
        self.assertEqual(rows[0]["poc_runid"], "flow-run-1")
        self.assertIn("poc_runid+eq+'flow-run-1'", calls[0])


class PayloadValidationTests(unittest.TestCase):
    def test_summary_only_record_is_rejected(self):
        with self.assertRaisesRegex(bridge.PathwayError, "Full raw audit payload is required"):
            bridge.extract_audit_payload({"poc_resources": "x" * 100, "poc_primarydetail": "summary"})

    def test_missing_copilot_event_data_is_rejected(self):
        with self.assertRaisesRegex(bridge.PathwayError, "CopilotEventData"):
            bridge.extract_audit_payload({"AuditData": {"Operation": "CopilotInteraction"}})

    def test_response_only_record_is_accepted(self):
        # A record with only response (non-prompt) messages must NOT be rejected.
        audit = bridge.extract_audit_payload({"AuditData": _full_audit(prompt=False)})
        self.assertEqual(audit["Operation"], "CopilotInteraction")

    def test_blank_prompt_id_is_rejected_not_fabricated(self):
        bad = _full_audit()
        bad["CopilotEventData"]["Messages"] = [{"Id": "", "isPrompt": True}]
        with self.assertRaisesRegex(bridge.PathwayError, "fabricate"):
            bridge.extract_audit_payload({"AuditData": bad})

    def test_time_window_filter_uses_original_audit_creation_time(self):
        kept, stats = bridge.filter_records_by_coverage(
            [
                {"poc_runid": "run-a", "AuditData": _full_audit()},
                {"poc_runid": "other", "AuditData": _full_audit()},
                {
                    "poc_runid": "run-a",
                    "AuditData": {
                        **_full_audit(),
                        "CreationTime": "2026-09-20T08:00:00Z",
                    },
                },
            ],
            "2026-09-10T00:00:00Z",
            "2026-09-11T00:00:00Z",
            "run-a",
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(stats["selectedRecords"], 1)
        self.assertEqual(stats["filteredBySourceRunId"], 1)
        self.assertEqual(stats["filteredByTimeWindow"], 1)
        self.assertEqual(stats["minCreationUtc"], "2026-09-10T08:00:00Z")

    def test_non_message_copilot_audits_are_counted_but_not_converted(self):
        with tempfile.TemporaryDirectory() as temp:
            stats = bridge.write_purview_csv(
                [
                    {"id": "audit-1", "AuditData": _full_audit()},
                    {
                        "id": "audit-2",
                        "AuditData": {
                            "Operation": "CopilotInteraction",
                            "CreationTime": "2026-09-10T09:00:00Z",
                            "UserId": "user@example.com",
                            "CopilotEventData": {"AccessedResources": [{"Type": "Web"}]},
                        },
                    },
                ],
                Path(temp) / "out.csv",
            )
        self.assertEqual(stats["written"], 1)
        self.assertEqual(stats["skippedNonMessage"], 1)

    def test_conflicting_records_with_same_id_fail_instead_of_losing_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            first = {"id": "same-id", "AuditData": _full_audit()}
            second = {"id": "same-id", "AuditData": _full_audit(user="other@example.com")}
            with self.assertRaisesRegex(bridge.PathwayError, "Conflicting payloads"):
                bridge.write_purview_csv([first, second], Path(temp) / "out.csv")


class LocalPublishSafetyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _rows(self):
        return {
            "poc_valuelensinteractions": [{"Message_Id": "1", "u": "a"}, {"Message_Id": "2", "u": "a"}],
            "poc_valuelensusers": [{"UserKey": "a"}],
        }

    def test_oversize_row_rejected_before_any_write(self):
        rows = {"poc_valuelensinteractions": [{"big": "x" * (bridge.MEMO_LIMIT + 10)}],
                "poc_valuelensusers": [{"UserKey": "a"}]}
        with self.assertRaisesRegex(bridge.PathwayError, "memo limit"):
            bridge.publish_local(rows, self.out, "oversize-run")
        run_dir = self.out / "dataverse-local" / "oversize-run"
        self.assertFalse((run_dir / "manifest.json").exists())
        self.assertFalse((run_dir / "poc_valuelensinteractions.jsonl").exists())
        pending = json.loads((run_dir / "manifest.json.pending").read_text(encoding="utf-8"))
        self.assertEqual(pending["status"], "failed")

    def test_run_id_reuse_is_rejected(self):
        bridge.publish_local(self._rows(), self.out, "run-a")
        with self.assertRaisesRegex(bridge.PathwayError, "already has local snapshot"):
            bridge.publish_local(self._rows(), self.out, "run-a")

    def test_manifest_row_keyed_by_run_id_with_counts_and_columns(self):
        bridge.publish_local(self._rows(), self.out, "run-m", {"windowStartUtc": "2026-09-10T00:00:00Z"})
        runs_file = self.out / "dataverse-local" / "run-m" / "poc_valuelensruns.jsonl"
        row = json.loads(runs_file.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(row["poc_rowkey"], "run-m")
        self.assertEqual(row["poc_runid"], "run-m")
        payload = json.loads(row["poc_payloadjson"])
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(payload["tables"]["poc_valuelensinteractions"]["count"], 2)
        self.assertEqual(payload["tables"]["poc_valuelensusers"]["count"], 1)
        self.assertEqual(payload["sourceCoverage"]["windowStartUtc"], "2026-09-10T00:00:00Z")
        self.assertIn("Message_Id", payload["tables"]["poc_valuelensinteractions"]["columns"])
        self.assertTrue(payload["completedAt"])

    def test_second_refresh_produces_isolated_rows(self):
        rows = self._rows()
        bridge.publish_local(rows, self.out, "run-1")
        first_file = self.out / "dataverse-local" / "run-1" / "poc_valuelensinteractions.jsonl"
        first_content = first_file.read_text(encoding="utf-8")
        first_keys = {json.loads(line)["poc_rowkey"] for line in first_content.splitlines()}

        bridge.publish_local(rows, self.out, "run-2")
        second_file = self.out / "dataverse-local" / "run-2" / "poc_valuelensinteractions.jsonl"
        second_keys = {json.loads(line)["poc_rowkey"] for line in second_file.read_text(encoding="utf-8").splitlines()}

        # Disjoint key spaces => a reader pinned to run-2 never sees run-1 rows.
        self.assertEqual(first_keys & second_keys, set())
        # Prior snapshot is immutable: untouched by the refresh.
        self.assertEqual(first_file.read_text(encoding="utf-8"), first_content)
        self.assertFalse(any(self.out.rglob("*.pending")))

    def test_identical_rows_are_deduped(self):
        rows = {"poc_valuelensinteractions": [{"Message_Id": "1"}, {"Message_Id": "1"}],
                "poc_valuelensusers": [{"UserKey": "a"}]}
        bridge.publish_local(rows, self.out, "dedup-run")
        lines = (self.out / "dataverse-local" / "dedup-run" / "poc_valuelensinteractions.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        run_dir = self.out / "dataverse-local" / "dedup-run"
        manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
        run_row = json.loads((run_dir / "poc_valuelensruns.jsonl").read_text(encoding="utf-8").splitlines()[0])
        run_manifest = json.loads(run_row["poc_payloadjson"])
        self.assertEqual(manifest["tables"]["poc_valuelensinteractions"], len(lines))
        self.assertEqual(manifest["tables"]["poc_valuelensinteractions"],
                         run_manifest["tables"]["poc_valuelensinteractions"]["count"])

    def test_run_id_cannot_escape_working_directory(self):
        with self.assertRaisesRegex(bridge.PathwayError, "Run ID"):
            bridge.publish_local(self._rows(), self.out, "../outside")
        self.assertFalse((self.out / "dataverse-local").exists())

    def test_empty_or_inconsistent_core_tables_are_rejected(self):
        with self.assertRaisesRegex(bridge.PathwayError, "empty core"):
            bridge.prepare_snapshot({"poc_valuelensinteractions": [], "poc_valuelensusers": [{"UserKey": "a"}]}, "empty")
        with self.assertRaisesRegex(bridge.PathwayError, "Inconsistent row columns"):
            bridge.prepare_snapshot({
                "poc_valuelensinteractions": [{"Message_Id": "1"}, {"different": "2"}],
                "poc_valuelensusers": [{"UserKey": "a"}],
            }, "inconsistent")


class DataversePublishSafetyTests(unittest.TestCase):
    URL = "https://contoso.crm.dynamics.com"
    RUN = "dv-run"

    def _rows(self):
        return {
            "poc_valuelensinteractions": [{"Message_Id": "1"}, {"Message_Id": "2"}, {"Message_Id": "3"}],
            "poc_valuelensusers": [{"UserKey": "a"}],
        }

    def _manifest_statuses(self, calls):
        statuses = []
        for method, body in calls:
            if method in ("PATCH", "POST") and body and body.get("poc_rowkey") == self.RUN:
                statuses.append(json.loads(body["poc_payloadjson"]).get("status"))
        return statuses

    def test_mid_upload_failure_never_marks_manifest_succeeded(self):
        original = bridge.dataverse_request
        calls = []
        core_patches = []

        def fake(method, url, token, body=None):
            calls.append((method, body))
            if method == "GET":  # run-manifest existence check -> 404 (fresh run id)
                raise bridge.PathwayError(f"GET {url} failed: HTTP 404 Not Found")
            if method == "PATCH" and body and body.get("poc_rowkey") != self.RUN:
                core_patches.append(body["poc_rowkey"])
                if len(core_patches) >= 2:  # fail mid-upload
                    raise bridge.PathwayError(f"PATCH {url} failed: HTTP 500 boom")
            return {}

        bridge.dataverse_request = fake
        try:
            with self.assertRaisesRegex(bridge.PathwayError, "HTTP 500"):
                bridge.publish_dataverse(self._rows(), self.URL, "tok", self.RUN)
        finally:
            bridge.dataverse_request = original

        statuses = self._manifest_statuses(calls)
        self.assertIn("pending", statuses)
        self.assertIn("failed", statuses)
        self.assertNotIn("succeeded", statuses)

    def test_run_id_reuse_on_server_is_rejected(self):
        original = bridge.dataverse_request

        def fake(method, url, token, body=None):
            if method == "GET":  # manifest already exists
                return {"poc_runid": self.RUN}
            raise AssertionError("must not write when run id is reused")

        bridge.dataverse_request = fake
        try:
            with self.assertRaisesRegex(bridge.PathwayError, "already has a run manifest"):
                bridge.publish_dataverse(self._rows(), self.URL, "tok", self.RUN)
        finally:
            bridge.dataverse_request = original

    def test_concurrent_manifest_creation_cannot_overwrite_existing_run(self):
        original = bridge.dataverse_request
        writes = []

        def fake(method, url, token, body=None):
            if method == "GET":
                raise bridge.PathwayError("HTTP 404")
            writes.append((method, url))
            if method == "POST":
                raise bridge.PathwayError("HTTP 409 duplicate alternate key")
            raise AssertionError("A losing publisher must not modify any snapshot")

        bridge.dataverse_request = fake
        try:
            with self.assertRaisesRegex(bridge.PathwayError, "HTTP 409"):
                bridge.publish_dataverse(self._rows(), self.URL, "tok", self.RUN)
        finally:
            bridge.dataverse_request = original
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][0], "POST")
        self.assertTrue(writes[0][1].endswith("/poc_valuelensruns"))

    def test_oversize_rejected_before_any_dataverse_write(self):
        original = bridge.dataverse_request
        writes = []

        def fake(method, url, token, body=None):
            if method == "GET":
                raise bridge.PathwayError(f"GET {url} failed: HTTP 404 Not Found")
            writes.append(method)
            return {}

        bridge.dataverse_request = fake
        rows = {"poc_valuelensinteractions": [{"big": "x" * (bridge.MEMO_LIMIT + 1)}],
                "poc_valuelensusers": [{"UserKey": "a"}]}
        try:
            with self.assertRaisesRegex(bridge.PathwayError, "memo limit"):
                bridge.publish_dataverse(rows, self.URL, "tok", "oversize-dv")
        finally:
            bridge.dataverse_request = original
        self.assertEqual(writes, [])  # no PATCH occurred before the oversize rejection


class DeployTests(unittest.TestCase):
    def test_dry_run_needs_no_network_or_token(self):
        self.assertEqual(deploy.main(["--dataverse-url", "dummy", "--quiet"]), 0)

    def test_schema_validation_rejects_bad_entity_sets(self):
        document = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        document["tables"][0]["entitySetName"] = "poc_notallowed"
        with self.assertRaises(deploy.DeployError):
            deploy.validate_schema_document(document)

    def test_schema_validation_requires_memo_payload(self):
        document = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        for column in document["commonColumns"]:
            if column["logicalName"] == "poc_payloadjson":
                column["type"] = "String"
        with self.assertRaises(deploy.DeployError):
            deploy.validate_schema_document(document)

    def test_canonical_schema_document_is_valid(self):
        deploy.validate_schema_document(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))

    def test_execute_requires_valid_https_origin(self):
        with self.assertRaises(deploy.bridge.PathwayError):
            deploy.deploy(json.loads(SCHEMA_PATH.read_text(encoding="utf-8")), "http://evil.example.com", "tok", 1.0, lambda *_: None)

    def test_metadata_length_queries_cast_to_supported_derived_types(self):
        original = deploy.bridge.dataverse_request
        calls = []

        def fake(method, url, token, body=None):
            calls.append(url)
            return {"value": []}

        deploy.bridge.dataverse_request = fake
        try:
            self.assertEqual(deploy._existing_attributes("https://contoso.crm.dynamics.com", "tok", "poc_valuelensuser"), {})
        finally:
            deploy.bridge.dataverse_request = original
        self.assertEqual(len(calls), 2)
        self.assertTrue(any("/Microsoft.Dynamics.CRM.StringAttributeMetadata?" in url for url in calls))
        self.assertTrue(any("/Microsoft.Dynamics.CRM.MemoAttributeMetadata?" in url for url in calls))

    def test_table_body_preserves_explicit_entity_set_and_valid_primary_requirement(self):
        document = bridge.core_schema_definition()
        for table in document["tables"]:
            body = deploy._table_body(document, table)
            self.assertEqual(body["EntitySetName"], table["entitySetName"])
            self.assertEqual(body["Attributes"][0]["RequiredLevel"]["Value"], "ApplicationRequired")

    def test_primary_name_platform_length_is_accepted_but_common_columns_are_strict(self):
        # Dataverse assigns the primary-name attribute a platform-managed
        # MaxLength (850) and ignores the requested 100 at create time. The
        # validator must accept that for poc_name while still enforcing exact
        # lengths on the common columns.
        document = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        original = deploy.bridge.dataverse_request

        def make_fake(rowkey_len):
            def fake(method, url, token, body=None):
                if "StringAttributeMetadata" in url:
                    return {"value": [
                        {"LogicalName": "poc_name", "AttributeType": "String", "MaxLength": 850},
                        {"LogicalName": "poc_rowkey", "AttributeType": "String", "MaxLength": rowkey_len},
                        {"LogicalName": "poc_runid", "AttributeType": "String", "MaxLength": 100},
                        {"LogicalName": "poc_payloadhash", "AttributeType": "String", "MaxLength": 64},
                    ]}
                return {"value": [
                    {"LogicalName": "poc_payloadjson", "AttributeType": "Memo", "MaxLength": bridge.MEMO_LIMIT},
                ]}
            return fake

        try:
            deploy.bridge.dataverse_request = make_fake(100)
            self.assertEqual(
                deploy._validate_existing_columns("https://contoso.crm.dynamics.com", "tok", document, "poc_valuelensrawaudit"),
                [],
            )
            deploy.bridge.dataverse_request = make_fake(50)
            problems = deploy._validate_existing_columns("https://contoso.crm.dynamics.com", "tok", document, "poc_valuelensrawaudit")
            self.assertTrue(any("poc_rowkey" in p for p in problems))
        finally:
            deploy.bridge.dataverse_request = original


if __name__ == "__main__":
    unittest.main()
