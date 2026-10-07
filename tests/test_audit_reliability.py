"""Behavioral notebook checks for audit ingestion reliability and merge safety."""

import ast
import json
import shutil
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NOTEBOOKS = ROOT / "1. Fabric" / "Manual setup" / "notebooks"
INGESTER = NOTEBOOKS / "Copilot_Audit_Log_Direct_Ingester.ipynb"
PROCESSOR = NOTEBOOKS / "Copilot_Audit_Log_Processor.ipynb"
SCRATCH = Path(tempfile.gettempdir()) / ("valuelens-audit-tests-" + uuid.uuid4().hex)


def cells(path):
    return ["".join(cell["source"]) for cell in json.loads(path.read_text(encoding="utf-8"))["cells"]]


def exec_notebook_cell(path, index, namespace):
    source = cells(path)[index]
    exec(compile(source, f"{path.name}:cell{index}", "exec"), namespace)
    return namespace


def exec_named_defs(path, index, names, namespace=None, include_imports=True):
    tree = ast.parse(cells(path)[index], filename=f"{path.name}:cell{index}")
    body = []
    wanted = set(names)
    for node in tree.body:
        if include_imports and isinstance(node, (ast.Import, ast.ImportFrom)):
            body.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in wanted:
            body.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in wanted for t in node.targets
        ):
            body.append(node)
    compiled = compile(ast.Module(body=body, type_ignores=[]), f"{path.name}:cell{index}", "exec")
    ns = {} if namespace is None else namespace
    exec(compiled, ns)
    return ns


class FakeCatalog:
    def __init__(self, exists=False):
        self._exists = exists

    def tableExists(self, _name):
        return self._exists


class FakeSpark:
    def __init__(self, exists=False):
        self.catalog = FakeCatalog(exists=exists)

    def table(self, _name):
        raise AssertionError("table() should not be called in this unit test path")


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class FakeNotebookUtilsFS:
    def __init__(self, root):
        self.root = Path(root)
        self.calls = []

    def _normalize(self, path):
        if not isinstance(path, str) or not path:
            raise AssertionError(f"unexpected path: {path!r}")
        return path.replace("\\", "/").rstrip("/")

    def _resolve(self, path):
        normalized = self._normalize(path)
        if normalized.startswith("file:"):
            return Path(normalized[5:])
        if normalized == "Files" or normalized.startswith("Files/"):
            relative = normalized[6:] if normalized.startswith("Files/") else ""
            return self.root / "Files" / Path(relative)
        if normalized.startswith("abfss://"):
            return self.root / "_abfss" / normalized.replace("://", "__", 1).replace("/", "_")
        raise AssertionError(f"unexpected notebookutils path: {path!r}")

    def exists(self, path):
        self.calls.append(("exists", path))
        return self._resolve(path).exists()

    def mkdirs(self, path):
        self.calls.append(("mkdirs", path))
        self._resolve(path).mkdir(parents=True, exist_ok=True)
        return True

    def ls(self, path):
        self.calls.append(("ls", path))
        base = self._resolve(path)
        if not base.exists():
            return []
        prefix = self._normalize(path)
        return [type("Entry", (), {"path": prefix + "/" + child.name})() for child in sorted(base.iterdir())]

    def rm(self, path, recurse=False):
        self.calls.append(("rm", path, recurse))
        target = self._resolve(path)
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        return True

    def cp(self, src, dst):
        self.calls.append(("cp", src, dst))
        source = self._resolve(src)
        target = self._resolve(dst)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return True

    def mv(self, src, dst, create_path=False, overwrite=False):
        self.calls.append(("mv", src, dst, overwrite))
        source = self._resolve(src)
        target = self._resolve(dst)
        target.parent.mkdir(parents=True, exist_ok=True)
        if overwrite and target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.move(str(source), str(target))
        return True

    def head(self, *_args, **_kwargs):
        raise AssertionError("head() should not be used for manifest reads")


class AuditReliabilityTests(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.ingester_cell16 = cells(INGESTER)[16]
        cls.processor_cell15 = cells(PROCESSOR)[15]

    def setUp(self):
        shutil.rmtree(SCRATCH, ignore_errors=True)
        SCRATCH.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(SCRATCH, ignore_errors=True)

    def ingester_helpers(self):
        namespace = {
            "MODE": "incremental",
            "BACKFILL_DAYS": 180,
            "LOOKBACK_DAYS": 7,
            "CHUNK_HOURS": 8,
            "OUTPUT_TABLE": "dbo.Copilot_Interactions_Parsed",
            "spark": FakeSpark(exists=False),
            "_request": lambda *a, **k: None,
            "get_headers": lambda: {},
        }
        return exec_notebook_cell(INGESTER, 6, namespace)

    def stage_helpers(self):
        return exec_named_defs(
            INGESTER,
            10,
            {
                "_normalize_stage_dir",
                "_is_remote_stage_dir",
                "_stage_path_join",
                "_stage_basename",
                "_list_stage_paths",
                "_stage_exists",
                "_stage_remove",
                "_get_notebook_fs",
                "_ensure_stage_dir",
                "list_window_files",
                "purge_window_files",
                "list_active_stage_files",
                "manifest_succeeded",
                "should_refresh_window",
                "window_stage_files_reusable",
                "is_window_reusable",
            },
            {"_as_utc_datetime": self.ingester_helpers()["_as_utc_datetime"]},
        )

    def row_builder(self):
        return exec_named_defs(INGESTER, 10, {"_row"}, self.ingester_helpers())

    def processor_helpers(self):
        return exec_named_defs(
            PROCESSOR,
            2,
            {"normalize_actor_token", "classify_actor_environment", "resolve_write_strategy"},
            include_imports=False,
        )

    def query_helpers(self, namespace=None):
        ns = {
            "MAX_WAIT_MIN_PER_QUERY": 1,
            "POLL_INTERVAL_SEC": 0,
            "_request": lambda *a, **k: None,
            "get_headers": lambda: {},
        }
        if namespace:
            ns.update(namespace)
        return exec_named_defs(INGESTER, 8, {"AuditQueryFailed", "_read_query_status", "wait_for_query"}, ns)

    def checkpoint_helpers(self, namespace=None):
        ingester = self.ingester_helpers()
        ns = {
            "MODE": "incremental",
            "OUTPUT_TABLE": "dbo.Copilot_Interactions_Parsed",
            "MAX_CONCURRENT_QUERIES": 5,
            "MIN_CONCURRENT_QUERIES": 1,
            "WINDOW_RETRIES": 3,
            "MIN_CHUNK_HOURS": 1,
            "SPLIT_ON_TIMEOUT": True,
            "RETRY_BASE_SEC": 0,
            "RETRY_MAX_SEC": 0,
            "_TRANSIENT": {429, 500, 502, 503, 504},
            "AuditQueryFailed": self.query_helpers()["AuditQueryFailed"],
            "QUERY_LIMITER": ingester["AdaptiveLimiter"](5, 1),
            "AdaptiveLimiter": ingester["AdaptiveLimiter"],
            "split_window": ingester["split_window"],
            "expand_split_windows": ingester["expand_split_windows"],
            "retry_delay": ingester["retry_delay"],
            "uncovered_failed_ranges": ingester["uncovered_failed_ranges"],
            "STAGING_ABS": str(SCRATCH),
            "MANIFEST": str(SCRATCH / "_manifest.json"),
            "LOCAL_STAGE_TMP_DIR": str(SCRATCH),
            "MANIFEST_LOCK": threading.RLock(),
            "manifest": {},
            "LOOKBACK_DAYS": 7,
            "end_date": datetime(2026, 9, 10, tzinfo=timezone.utc),
            "datetime": datetime,
            "timedelta": timedelta,
            "timezone": timezone,
            "stable_window_key": ingester["stable_window_key"],
            "_as_utc_datetime": ingester["_as_utc_datetime"],
            "canonicalize_audit_record": ingester["canonicalize_audit_record"],
            "create_query": lambda ws, we: "qid-1",
            "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
            "_request": lambda *a, **k: None,
            "get_headers": lambda: {},
        }
        if namespace:
            ns.update(namespace)
        return exec_named_defs(
            INGESTER,
            10,
            {
                "_normalize_stage_dir",
                "_is_remote_stage_dir",
                "_stage_path_join",
                "_stage_basename",
                "_file_uri",
                "_driver_temp_root",
                "_new_local_temp_path",
                "_get_notebook_fs",
                "_ensure_stage_dir",
                "_list_stage_paths",
                "_stage_exists",
                "_stage_remove",
                "_write_stage_text",
                "_write_stage_jsonl",
                "_move_stage_file",
                "_read_stage_json",
                "list_window_files",
                "purge_window_files",
                "list_active_stage_files",
                "_allowed_manifest_statuses",
                "_validate_manifest_payload",
                "_load_manifest",
                "_manifest_temp_path",
                "_save_manifest",
                "manifest_succeeded",
                "should_refresh_window",
                "window_stage_files_reusable",
                "is_window_reusable",
                "_read_manifest_entry",
                "_mark_window",
                "_row",
                "_is_graph_records_url",
                "_validate_graph_records_url",
                "_validate_records_page",
                "_drain",
                "_process",
                "_FATAL_HTTP",
                "_http_status",
                "is_retryable_window_error",
                "_run_window",
                "leaf_windows",
                "_fmt_range",
                "assert_no_unrecovered_gaps",
                "fetch_windows",
            },
            ns,
        )

    def remote_checkpoint_helpers(self, namespace=None):
        remote_root = SCRATCH / "_remote"
        fake_fs = FakeNotebookUtilsFS(remote_root)
        ns = {
            "STAGING_ABS": "Files/_audit_staging",
            "MANIFEST": "Files/_audit_staging/_manifest.json",
            "LOCAL_STAGE_TMP_DIR": str(SCRATCH / "_driver_tmp"),
            "NOTEBOOK_FS": fake_fs,
        }
        if namespace:
            ns.update(namespace)
        helpers = self.checkpoint_helpers(ns)
        helpers["_fake_fs"] = fake_fs
        helpers["_remote_root"] = remote_root
        return helpers

    def test_incremental_start_uses_trailing_overlap_but_still_catches_up_from_stale_watermark(self):
        ns = self.ingester_helpers()
        end_dt = datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc)
        self.assertEqual(
            ns["determine_incremental_start"](end_dt, end_dt - timedelta(days=2), 7),
            end_dt - timedelta(days=7),
        )
        self.assertEqual(
            ns["determine_incremental_start"](end_dt, end_dt - timedelta(days=30), 7),
            end_dt - timedelta(days=30),
        )

    def test_manifest_updates_preserve_memory_when_mounted_reads_are_stale(self):
        # Lakehouse mount reads can lag a successful atomic rename. A worker must
        # not replace newer process-local checkpoints with that older snapshot.
        ns = self.checkpoint_helpers()
        ns["manifest"]["completed-window"] = {"status": "succeeded"}
        ns["_load_manifest"] = lambda: {}
        ns["_mark_window"]("next-window", "waiting")
        self.assertEqual(ns["_read_manifest_entry"]("completed-window")["status"], "succeeded")
        persisted = json.loads(Path(ns["MANIFEST"]).read_text(encoding="utf-8"))
        self.assertEqual(persisted["completed-window"]["status"], "succeeded")

    def test_synthetic_record_key_uses_canonical_json_and_ignores_array_order(self):
        ns = self.ingester_helpers()
        left = json.dumps(
            {
                "CopilotEventData": {
                    "Messages": [
                        {"isPrompt": "true", "Id": "msg-b"},
                        {"Id": "msg-a", "isPrompt": "true"},
                    ],
                    "AccessedResources": [
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"SiteUrl": "https://a", "Action": "read", "Type": "docx"},
                    ],
                }
            }
        )
        right = json.dumps(
            {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                        {"SiteUrl": "https://b", "Type": "docx", "Action": "read"},
                    ],
                    "Messages": [
                        {"Id": "msg-a", "isPrompt": "true"},
                        {"isPrompt": "true", "Id": "msg-b"},
                    ],
                }
            }
        )

        self.assertEqual(
            ns["build_source_record_key"](None, "2026-09-10T08:00:00Z", "View", left),
            ns["build_source_record_key"](None, "2026-09-10T08:00:00Z", "View", right),
        )

    def test_stage_row_builder_uses_canonical_identity_and_preserves_real_ids(self):
        row = self.row_builder()["_row"]
        record_a = {
            "id": "record-1",
            "createdDateTime": "2026-09-10T08:00:00Z",
            "auditLogRecordType": "copilotInteraction",
            "operation": "View",
            "associatedAdminUnits": [],
            "associatedAdminUnitsNames": [],
            "auditData": {
                "CreationTime": "2026-09-10T08:00:00Z",
                "CopilotEventData": {
                    "Messages": [
                        {"Id": "msg-b", "isPrompt": "true"},
                        {"isPrompt": "true", "Id": "msg-a"},
                    ],
                    "AccessedResources": [
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                    ],
                },
            },
        }
        record_b = {
            **record_a,
            "auditData": {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"SiteUrl": "https://a", "Type": "docx", "Action": "read"},
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                    ],
                    "Messages": [
                        {"Id": "msg-a", "isPrompt": "true"},
                        {"isPrompt": "true", "Id": "msg-b"},
                    ],
                },
                "CreationTime": "2026-09-10T08:00:00Z",
            },
        }

        row_a = row(record_a)
        row_b = row(record_b)
        audit = json.loads(row_a["AuditData"])

        self.assertEqual(row_a["SourceRecordKey"], "rid:record-1")
        self.assertEqual(row_a["SourceRecordKey"], row_b["SourceRecordKey"])
        self.assertEqual(row_a["AuditData"], row_b["AuditData"])
        self.assertEqual(
            [message["_StableKey"] for message in audit["CopilotEventData"]["Messages"]],
            ["mid:msg-a", "mid:msg-b"],
        )
        self.assertEqual(
            [resource["_StableOrdinal"] for resource in audit["CopilotEventData"]["AccessedResources"]],
            [0, 1],
        )

    def test_missing_message_ids_use_content_fingerprint_plus_occurrence_not_position(self):
        ns = self.ingester_helpers()
        payload_a = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "Messages": [
                        {"isPrompt": "true", "Text": "Alpha"},
                        {"Text": "Beta", "isPrompt": "true"},
                        {"Text": "Alpha", "isPrompt": "true"},
                    ]
                }
            }
        )
        payload_b = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "Messages": [
                        {"Text": "Alpha", "isPrompt": "true"},
                        {"isPrompt": "true", "Text": "Alpha"},
                        {"isPrompt": "true", "Text": "Beta"},
                    ]
                }
            }
        )

        keys_a = [message["_StableKey"] for message in payload_a["CopilotEventData"]["Messages"]]
        keys_b = [message["_StableKey"] for message in payload_b["CopilotEventData"]["Messages"]]
        self.assertEqual(keys_a, keys_b)
        self.assertEqual(len(keys_a), 3)
        self.assertEqual(len(set(keys_a)), 3)
        self.assertTrue(any(key.endswith("#2") for key in keys_a))

    def test_repeated_resources_keep_distinct_stable_keys_after_canonical_sort(self):
        ns = self.ingester_helpers()
        payload_a = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://a"},
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                    ]
                }
            }
        )
        payload_b = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"SiteUrl": "https://a", "Type": "docx", "Action": "read"},
                    ]
                }
            }
        )

        keys_a = [resource["_StableKey"] for resource in payload_a["CopilotEventData"]["AccessedResources"]]
        keys_b = [resource["_StableKey"] for resource in payload_b["CopilotEventData"]["AccessedResources"]]
        self.assertEqual(keys_a, keys_b)
        self.assertEqual(len(keys_a), 3)
        self.assertEqual(len(set(keys_a)), 3)
        self.assertTrue(any(key.endswith("#2") for key in keys_a))

    def test_legacy_incremental_table_without_new_keys_fails_clearly(self):
        ns = self.ingester_helpers()
        with self.assertRaisesRegex(RuntimeError, "missing stable key columns"):
            ns["validate_incremental_target_columns"](
                ["CreationDate", "RecordId", "Message_Id"],
                ns["KEY_COLUMNS"],
                "dbo.Copilot_Interactions_Parsed",
            )

    def test_stage_scope_reuses_recent_windows_only_and_cleans_partial_files(self):
        helpers = self.stage_helpers()
        recent_key = "v2_recent"
        old_key = "v2_old"
        recent = SCRATCH / f"win_{recent_key}_0000.jsonl"
        old = SCRATCH / f"win_{old_key}_0000.jsonl"
        partial = SCRATCH / f"win_{recent_key}_0001.jsonl.partial"
        recent.write_text("{}", encoding="utf-8")
        old.write_text("{}", encoding="utf-8")
        partial.write_text("{}", encoding="utf-8")

        scoped = [Path(p).name for p in helpers["list_active_stage_files"](str(SCRATCH), {recent_key})]
        self.assertEqual(scoped, [recent.name])
        removed = helpers["purge_window_files"](str(SCRATCH), recent_key, include_partial=True)
        self.assertEqual(removed, 2)
        self.assertFalse(recent.exists())
        self.assertFalse(partial.exists())
        self.assertTrue(old.exists())

    def test_remote_stage_publication_uses_notebookutils_without_mount_paths(self):
        ingester = self.ingester_helpers()
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = ingester["stable_window_key"](*win)
        start_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-remote/records?$top=999"
        payload = {
            "value": [
                {
                    "id": "record-1",
                    "createdDateTime": "2026-09-10T08:00:00Z",
                    "auditLogRecordType": "copilotInteraction",
                    "operation": "View",
                    "associatedAdminUnits": [],
                    "associatedAdminUnitsNames": [],
                    "auditData": {"CreationTime": "2026-09-10T08:00:00Z"},
                }
            ]
        }
        helpers = self.remote_checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-remote",
                "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
                "_request": lambda method, url, **kwargs: FakeResponse(payload if url == start_url else {"value": []}),
            }
        )

        self.assertEqual(helpers["_process"](win), (key, 1, "done"))
        self.assertEqual(
            helpers["list_window_files"](helpers["STAGING_ABS"], key),
            [f"Files/_audit_staging/win_{key}_0000.jsonl"],
        )
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[key]["status"], "succeeded")
        self.assertEqual(manifest[key]["files"], [f"win_{key}_0000.jsonl"])
        self.assertFalse((helpers["_remote_root"] / "Files" / "_audit_staging" / f"win_{key}_0000.jsonl.partial").exists())
        self.assertTrue(all("/lakehouse/default" not in str(call) for call in helpers["_fake_fs"].calls))

    def test_failed_remote_delete_cannot_publish_stale_pages_as_empty_success(self):
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = self.ingester_helpers()["stable_window_key"](*win)
        helpers = self.remote_checkpoint_helpers({
            "create_query": lambda ws, we: "qid-empty",
            "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
            "_request": lambda *args, **kwargs: FakeResponse({"value": []}),
        })
        fs = helpers["_fake_fs"]
        stale_path = f"Files/_audit_staging/win_{key}_0000.jsonl"
        stale = fs._resolve(stale_path)
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_text('{"id":"stale"}\n', encoding="utf-8")
        original_rm = fs.rm
        fs.rm = lambda path, recurse=False: False if path == stale_path else original_rm(path, recurse)

        with self.assertRaisesRegex(RuntimeError, "Failed to remove staged file"):
            helpers["_process"](win)
        self.assertTrue(stale.exists())
        self.assertEqual(helpers["_load_manifest"]()[key]["status"], "failed")
        self.assertIn("Failed to remove staged file", helpers["_load_manifest"]()[key]["error"])

    def test_remote_copy_and_move_false_results_are_fatal(self):
        for operation in ("cp", "mv"):
            with self.subTest(operation=operation):
                helpers = self.remote_checkpoint_helpers()
                setattr(helpers["_fake_fs"], operation, lambda *args: False)
                with self.assertRaisesRegex(RuntimeError, "Failed to (copy|move)"):
                    helpers["_mark_window"]("failed-publish", "succeeded", rows=0)
                self.assertNotIn("failed-publish", helpers["manifest"])
                self.assertEqual(helpers["_load_manifest"](), {})

    def test_missing_published_files_force_refresh_instead_of_stale_skip(self):
        helpers = self.stage_helpers()
        cutoff = datetime(2026, 9, 3, tzinfo=timezone.utc)
        old_end = datetime(2026, 8, 15, tzinfo=timezone.utc)
        entry = {"status": "succeeded", "rows": 3, "pages": 1, "files": ["win_v2_old_0000.jsonl"]}

        self.assertFalse(helpers["window_stage_files_reusable"](str(SCRATCH), "v2_old", entry))
        self.assertFalse(helpers["is_window_reusable"](str(SCRATCH), "v2_old", old_end, entry, cutoff))

    def test_recent_completed_windows_requery_for_late_arrivals_but_old_completed_windows_skip(self):
        helpers = self.stage_helpers()
        cutoff = datetime(2026, 9, 3, tzinfo=timezone.utc)
        recent_end = datetime(2026, 9, 9, tzinfo=timezone.utc)
        old_end = datetime(2026, 8, 15, tzinfo=timezone.utc)
        succeeded = {"status": "succeeded", "completed_at": "2026-09-01T00:00:00+00:00"}

        self.assertTrue(helpers["should_refresh_window"](recent_end, succeeded, cutoff))
        self.assertFalse(helpers["should_refresh_window"](old_end, succeeded, cutoff))
        self.assertTrue(helpers["should_refresh_window"](old_end, {"status": "failed"}, cutoff))

    def test_processor_merge_strategy_is_explicit_and_never_silent_overwrite_on_missing_id(self):
        helpers = self.processor_helpers()
        self.assertEqual(
            helpers["resolve_write_strategy"]("overwrite", ["CreationDate"], True, [], ["Id"]),
            "overwrite",
        )
        self.assertEqual(
            helpers["resolve_write_strategy"]("merge", ["Id"], False, [], ["Id"]),
            "overwrite",
        )
        with self.assertRaisesRegex(RuntimeError, "requires source key columns"):
            helpers["resolve_write_strategy"]("merge", ["CreationDate"], True, ["Id"], ["Id"])
        with self.assertRaisesRegex(RuntimeError, "requires non-blank values"):
            helpers["resolve_write_strategy"]("merge", ["Id"], True, ["Id"], ["Id"], source_key_health=False)
        with self.assertRaisesRegex(RuntimeError, "missing merge key columns"):
            helpers["resolve_write_strategy"]("merge", ["Id"], True, ["CreationDate"], ["Id"])

    def test_processor_actor_environment_restores_agent_and_cowork_paths(self):
        helpers = self.processor_helpers()
        self.assertEqual(helpers["classify_actor_environment"](app_host="autonomous"), "Agents")
        self.assertEqual(helpers["classify_actor_environment"](app_host="m365 cowork canvas"), "Cowork")
        self.assertEqual(
            helpers["classify_actor_environment"](agent_name="Sales Copilot Agent", environment="Licensed"),
            "Agents",
        )
        self.assertEqual(helpers["classify_actor_environment"](app_host="word", environment="Licensed"), "User")

    def test_notebooks_share_stable_id_contract(self):
        for token in ["'Id'", "'Source_RecordKey'", "'Source_MessageKey'", "'Source_ResourceKey'"]:
            self.assertIn(token, self.ingester_cell16)
        self.assertIn("MERGE_KEYS       = [\"Id\"]", cells(PROCESSOR)[1])
        self.assertIn("resolve_write_strategy", self.processor_cell15)
        self.assertIn("canonicalize_audit_record", cells(INGESTER)[10])
        self.assertIn("SourceRecordKey", cells(INGESTER)[12])
        self.assertIn("ArrayType", cells(INGESTER)[12])
        self.assertIn("msg._StableKey", self.ingester_cell16)
        self.assertIn("res._StableKey", self.ingester_cell16)
        self.assertIn("ambiguous synthetic SourceRecordKey", self.ingester_cell16)
        self.assertIn("dropDuplicates(['Id'])", self.ingester_cell16)

    def test_wait_for_query_distinguishes_success_failure_and_malformed_status(self):
        responses = iter(
            [
                FakeResponse({"status": "running"}),
                FakeResponse({"status": "succeeded", "id": "qid-success"}),
            ]
        )
        helpers = self.query_helpers({"_request": lambda *a, **k: next(responses)})
        payload = helpers["wait_for_query"]("qid-success", max_wait_min=1)
        self.assertEqual(payload["status"], "succeeded")

        helpers = self.query_helpers({"_request": lambda *a, **k: FakeResponse({"status": "failed"})})
        with self.assertRaisesRegex(RuntimeError, "ended with status: failed"):
            helpers["wait_for_query"]("qid-failed", max_wait_min=1)

        helpers = self.query_helpers({"_request": lambda *a, **k: FakeResponse({})})
        with self.assertRaisesRegex(RuntimeError, "missing/invalid status"):
            helpers["wait_for_query"]("qid-malformed", max_wait_min=1)

    def test_manifest_load_allows_absent_but_rejects_corrupt_shape_and_status(self):
        helpers = self.checkpoint_helpers()
        manifest_path = Path(helpers["MANIFEST"])

        self.assertEqual(helpers["_load_manifest"](), {})

        manifest_path.write_text("{bad json", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "not valid JSON"):
            helpers["_load_manifest"]()

        manifest_path.write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "must be a JSON object"):
            helpers["_load_manifest"]()

        manifest_path.write_text(json.dumps({"win_bad": {"status": "done"}}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "invalid status"):
            helpers["_load_manifest"]()

    def test_threaded_checkpoint_updates_persist_valid_json(self):
        helpers = self.checkpoint_helpers()
        manifest_path = Path(helpers["MANIFEST"])

        def update(index):
            helpers["_mark_window"](
                f"v2_{index:03d}",
                "succeeded",
                rows=index,
                completed_at=f"2026-09-10T00:{index % 60:02d}:00+00:00",
            )

        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(update, range(100)))

        persisted = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(len(persisted), 100)
        self.assertEqual(helpers["_load_manifest"](), persisted)
        self.assertTrue(all(entry["status"] == "succeeded" for entry in persisted.values()))
        self.assertFalse(list(SCRATCH.glob(".*.tmp")))

    def test_remote_manifest_roundtrip_avoids_truncated_head_reads(self):
        helpers = self.remote_checkpoint_helpers()

        for index in range(40):
            helpers["_mark_window"](
                f"v2_{index:03d}",
                "succeeded",
                rows=index,
                pages=index % 3,
                completed_at=f"2026-09-10T00:{index % 60:02d}:00+00:00",
            )

        manifest = helpers["_load_manifest"]()
        self.assertEqual(len(manifest), 40)
        self.assertEqual(manifest, helpers["manifest"])

    def test_drain_accepts_empty_page_but_rejects_malformed_payloads_and_off_graph_links(self):
        helpers = self.checkpoint_helpers({"_request": lambda *a, **k: FakeResponse({"value": []})})
        self.assertEqual(helpers["_drain"]("qid-empty", "empty"), (0, 0))
        self.assertEqual(helpers["list_window_files"](str(SCRATCH), "empty", include_partial=True), [])

        helpers = self.checkpoint_helpers({"_request": lambda *a, **k: FakeResponse({})})
        with self.assertRaisesRegex(RuntimeError, "missing value list"):
            helpers["_drain"]("qid-missing", "missing")

        helpers = self.checkpoint_helpers({"_request": lambda *a, **k: FakeResponse({"value": ["oops"]})})
        with self.assertRaisesRegex(RuntimeError, "item 0 must be an object"):
            helpers["_drain"]("qid-items", "items")

        helpers = self.checkpoint_helpers(
            {
                "_request": lambda *a, **k: FakeResponse(
                    {"value": [], "@odata.nextLink": "https://example.com/not-graph"}
                )
            }
        )
        with self.assertRaisesRegex(RuntimeError, "non-Graph records continuation URL"):
            helpers["_drain"]("qid-offgraph", "offgraph")

    def test_process_cleans_partial_files_and_marks_failed_on_wait_or_paging_errors(self):
        ingester = self.ingester_helpers()
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = ingester["stable_window_key"](*win)

        helpers = self.checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-failed",
                "wait_for_query": lambda qid: (_ for _ in ()).throw(
                    RuntimeError(f"Query {qid} ended with status: failed")
                ),
            }
        )
        with self.assertRaisesRegex(RuntimeError, "ended with status: failed"):
            helpers["_process"](win)
        failed_manifest = json.loads(Path(helpers["MANIFEST"]).read_text(encoding="utf-8"))
        self.assertEqual(failed_manifest[key]["status"], "failed")
        self.assertNotIn("succeeded", failed_manifest[key]["status"])
        self.assertEqual(helpers["list_window_files"](str(SCRATCH), key, include_partial=True), [])

        start_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-cycle/records?$top=999"
        loop_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-cycle/records?$skiptoken=abc"
        pages = {
            start_url: FakeResponse({"value": [{}], "@odata.nextLink": loop_url}),
            loop_url: FakeResponse({"value": [{}], "@odata.nextLink": start_url}),
        }
        helpers = self.checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-cycle",
                "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
                "_request": lambda method, url, **kwargs: pages[url],
            }
        )
        with self.assertRaisesRegex(RuntimeError, "repeated pagination link cycle"):
            helpers["_process"](win)
        failed_manifest = json.loads(Path(helpers["MANIFEST"]).read_text(encoding="utf-8"))
        self.assertEqual(failed_manifest[key]["status"], "failed")
        self.assertIn("pagination link cycle", failed_manifest[key]["error"])
        self.assertEqual(helpers["list_window_files"](str(SCRATCH), key, include_partial=True), [])

    def test_remote_failures_cleanup_partial_pages_and_keep_manifest_authoritative(self):
        ingester = self.ingester_helpers()
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = ingester["stable_window_key"](*win)
        start_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-bad/records?$top=999"
        next_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-bad/records?$skiptoken=1"
        pages = {
            start_url: FakeResponse(
                {
                    "value": [
                        {
                            "id": "record-1",
                            "createdDateTime": "2026-09-10T08:00:00Z",
                            "auditData": {"CreationTime": "2026-09-10T08:00:00Z"},
                        }
                    ],
                    "@odata.nextLink": next_url,
                }
            ),
            next_url: FakeResponse({}),
        }
        helpers = self.remote_checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-bad",
                "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
                "_request": lambda method, url, **kwargs: pages[url],
            }
        )

        with self.assertRaisesRegex(RuntimeError, "missing value list"):
            helpers["_process"](win)
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[key]["status"], "failed")
        self.assertEqual(helpers["list_window_files"](helpers["STAGING_ABS"], key, include_partial=True), [])


class AgentIdentityTests(unittest.TestCase):
    """Agent accounts such as SecurityCopilotAgentUser-<id> are not people."""

    @classmethod
    def setUpClass(cls):
        ns = exec_named_defs(PROCESSOR, 2, ["agent_identity_regex"], include_imports=False)
        cls.regex = staticmethod(ns["agent_identity_regex"])
        cls.config = exec_notebook_cell(PROCESSOR, 1, {})
        cls.sources = cells(PROCESSOR)

    def default_regex(self):
        return self.regex(self.config["EXCLUDE_AGENT_IDENTITIES"], self.config["AGENT_IDENTITY_PATTERNS"])

    def test_default_config_drops_security_copilot_agents(self):
        import re
        self.assertIs(self.config["EXCLUDE_AGENT_IDENTITIES"], True)
        pattern = self.default_regex()
        self.assertTrue(re.search(pattern, "securitycopilotagentuser-1f2e3d4c@contoso.onmicrosoft.com"))
        for upn in ("jane@contoso.com", "agent.smith@contoso.com", "me-securitycopilotagentuser-1@contoso.com"):
            with self.subTest(upn=upn):
                self.assertIsNone(re.search(pattern, upn))

    def test_filter_can_be_switched_off_or_left_empty(self):
        self.assertIsNone(self.regex(False, [r"^securitycopilotagentuser-"]))
        self.assertIsNone(self.regex(True, []))
        self.assertIsNone(self.regex(True, None))
        self.assertIsNone(self.regex(True, ["", "  "]))

    def test_several_patterns_combine_into_one_regex(self):
        import re
        pattern = self.regex(True, [r"^svc-", r"@agents\.contoso\.com$"])
        self.assertEqual(pattern, r"(?:^svc-)|(?:@agents\.contoso\.com$)")
        self.assertTrue(re.search(pattern, "svc-bot@contoso.com"))
        self.assertTrue(re.search(pattern, "x@agents.contoso.com"))
        self.assertIsNone(re.search(pattern, "jane@contoso.com"))

    def test_processor_filters_new_rows_and_cleans_merged_ones(self):
        filter_cell = next(text for text in self.sources if "# 6b. AGENT IDENTITIES" in text)
        self.assertIn("AGENT_IDENTITY_REGEX = agent_identity_regex(EXCLUDE_AGENT_IDENTITIES, AGENT_IDENTITY_PATTERNS)", filter_cell)
        self.assertIn('F.lower(F.col("_NormUPN")).rlike(AGENT_IDENTITY_REGEX)', filter_cell)
        self.assertLess(filter_cell.index('fact = fact.withColumn("_NormUPN", norm)'), filter_cell.index("# 6b."))
        writer = next(text for text in self.sources if "def write_curated_output" in text)
        self.assertIn("if AGENT_IDENTITY_REGEX and \"Audit_UserId\" in target_columns:", writer)
        self.assertIn(".rlike(AGENT_IDENTITY_REGEX))", writer)


class FakeAuditGraph:
    """Fake Graph audit query API: create_query / wait_for_query / records pages, with scripted failures."""

    def __init__(self, failed, outcome=None):
        self.failed = failed
        self.outcome = outcome or (lambda ws, we, attempt: "succeeded")
        self.created = []
        self.ranges = {}
        self.lock = threading.Lock()

    def attempts(self, ws, we):
        return sum(1 for r in self.created if r == (ws, we))

    def create_query(self, ws, we):
        with self.lock:
            self.created.append((ws, we))
            qid = f"q{len(self.created)}"
            self.ranges[qid] = (ws, we, self.attempts(ws, we))
        return qid

    def wait_for_query(self, qid):
        status = self.outcome(*self.ranges[qid])
        if status == "timeout":
            raise TimeoutError(f"Query {qid} did not finish")
        if status != "succeeded":
            raise self.failed(f"Query {qid} ended with status: {status}")
        return {"status": "succeeded", "id": qid}

    def request(self, method, url, **_kwargs):
        qid = url.split("/queries/")[1].split("/")[0]
        ws, _we, _attempt = self.ranges[qid]
        return FakeResponse({"value": [{"id": f"{ws:%Y%m%d%H%M}", "createdDateTime": ws.isoformat()}]})


class FailedWindowRecoveryTests(unittest.TestCase):
    """Failed audit query windows are retried with a new query, then split, and never written partially."""

    setUp = AuditReliabilityTests.setUp
    tearDown = AuditReliabilityTests.tearDown
    ingester_helpers = AuditReliabilityTests.ingester_helpers
    query_helpers = AuditReliabilityTests.query_helpers
    checkpoint_helpers = AuditReliabilityTests.checkpoint_helpers

    WIN = (datetime(2026, 8, 25, 0, tzinfo=timezone.utc), datetime(2026, 8, 25, 8, tzinfo=timezone.utc))
    NEXT = (datetime(2026, 8, 25, 8, tzinfo=timezone.utc), datetime(2026, 8, 25, 16, tzinfo=timezone.utc))

    def run_helpers(self, outcome, **config):
        failed = self.query_helpers()["AuditQueryFailed"]
        graph = FakeAuditGraph(failed, outcome)
        ns = {
            "AuditQueryFailed": failed,
            "create_query": graph.create_query,
            "wait_for_query": graph.wait_for_query,
            "_request": graph.request,
        }
        ns.update(config)
        helpers = self.checkpoint_helpers(ns)
        helpers["manifest"].update(helpers["_load_manifest"]())
        return helpers, graph

    def key(self, helpers, win):
        return helpers["stable_window_key"](*win)

    def test_failed_query_is_resubmitted_as_a_new_query_and_succeeds(self):
        helpers, graph = self.run_helpers(lambda ws, we, attempt: "failed" if attempt == 1 else "succeeded")
        keys, rows = helpers["fetch_windows"]([self.WIN])
        key = self.key(helpers, self.WIN)
        self.assertEqual(keys, {key})
        self.assertEqual(rows, 1)
        self.assertEqual(graph.attempts(*self.WIN), 2)
        entry = helpers["_load_manifest"]()[key]
        self.assertEqual(entry["status"], "succeeded")
        self.assertEqual(entry["attempts"], 2)
        self.assertEqual(len(entry["attempt_errors"]), 1)
        self.assertIn("ended with status: failed", entry["attempt_errors"][0])
        self.assertIsNone(entry["error"])
        self.assertEqual(helpers["QUERY_LIMITER"].limit, 4)

    def test_cancelled_query_is_retried_too(self):
        helpers, graph = self.run_helpers(lambda ws, we, attempt: "cancelled" if attempt < 3 else "succeeded")
        helpers["fetch_windows"]([self.WIN])
        self.assertEqual(graph.attempts(*self.WIN), 3)

    def test_persistent_failure_splits_window_and_halves_complete_the_parent(self):
        always_fails_at_8h = lambda ws, we, attempt: "failed" if we - ws == timedelta(hours=8) else "succeeded"
        helpers, graph = self.run_helpers(always_fails_at_8h, WINDOW_RETRIES=1)
        keys, rows = helpers["fetch_windows"]([self.WIN, self.NEXT])
        ws, we = self.WIN
        mid = ws + timedelta(hours=4)
        halves = [(ws, mid), (mid, we)]
        manifest = helpers["_load_manifest"]()
        parent = manifest[self.key(helpers, self.WIN)]
        self.assertEqual(parent["status"], "split")
        self.assertEqual(parent["parts"], [self.key(helpers, h) for h in halves])
        self.assertEqual(graph.attempts(*self.WIN), 2)
        for half in halves:
            self.assertEqual(manifest[self.key(helpers, half)]["status"], "succeeded")
        self.assertEqual(len(keys), 4)
        self.assertNotIn(self.key(helpers, self.WIN), keys)
        self.assertEqual(rows, 4)
        staged = helpers["list_active_stage_files"](str(SCRATCH), keys)
        self.assertEqual(len(staged), 4)
        self.assertFalse(helpers["list_window_files"](str(SCRATCH), self.key(helpers, self.WIN), include_partial=True))

        # A rerun reuses the parts and does not query the parent again.
        rerun, graph2 = self.run_helpers(lambda *a: self.fail("nothing should be queried"))
        self.assertEqual(rerun["fetch_windows"]([self.WIN, self.NEXT]), (keys, rows))
        self.assertEqual(graph2.created, [])

    def test_timeout_splits_at_once_when_configured(self):
        helpers, graph = self.run_helpers(
            lambda ws, we, attempt: "timeout" if we - ws == timedelta(hours=8) else "succeeded"
        )
        keys, _ = helpers["fetch_windows"]([self.WIN])
        self.assertEqual(graph.attempts(*self.WIN), 1)
        self.assertEqual(len(keys), 2)

    def test_failure_at_minimum_size_stops_with_one_clear_error_and_writes_nothing(self):
        bad_day = lambda ws, we, attempt: "failed" if ws < self.WIN[1] else "succeeded"
        helpers, graph = self.run_helpers(bad_day, MODE="backfill", WINDOW_RETRIES=1, MIN_CHUNK_HOURS=4)
        with self.assertRaises(RuntimeError) as caught:
            helpers["fetch_windows"]([self.WIN, self.NEXT])
        message = str(caught.exception)
        self.assertIn("2 audit window(s) still failed", message)
        self.assertIn("Nothing was written to dbo.Copilot_Interactions_Parsed", message)
        self.assertIn("2026-08-25 00:00 -> 2026-08-25 04:00 UTC", message)
        self.assertIn("2026-08-25 04:00 -> 2026-08-25 08:00 UTC", message)
        self.assertIn("rerun with MODE='backfill'; succeeded windows are reused", message)
        # The healthy window was still fetched (the run did not abort on the first failure) ...
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[self.key(helpers, self.NEXT)]["status"], "succeeded")
        # ... the 4h halves were each tried twice and left no staged data behind.
        for half in [(self.WIN[0], self.WIN[0] + timedelta(hours=4)), (self.WIN[0] + timedelta(hours=4), self.WIN[1])]:
            self.assertEqual(graph.attempts(*half), 2)
            self.assertEqual(manifest[self.key(helpers, half)]["status"], "failed")
            self.assertFalse(helpers["list_window_files"](str(SCRATCH), self.key(helpers, half), include_partial=True))

        # A rerun queries only the failed halves.
        rerun, graph2 = self.run_helpers(lambda *a: "succeeded", MODE="backfill", MIN_CHUNK_HOURS=4)
        keys, _ = rerun["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(len(keys), 3)
        self.assertEqual(sorted(we - ws for ws, we in graph2.created), [timedelta(hours=4)] * 2)

    def test_rerun_reuses_succeeded_windows_from_an_older_manifest(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        key = self.key(helpers, self.WIN)
        (SCRATCH / f"win_{key}_0000.jsonl").write_text('{"id":"old"}\n', encoding="utf-8")
        legacy = {
            key: {
                "status": "succeeded",
                "query_id": "old",
                "rows": 1,
                "pages": 1,
                "files": [f"win_{key}_0000.jsonl"],
                "completed_at": "2026-08-26T00:00:00+00:00",
                "window_start": self.WIN[0].isoformat(),
                "window_end": self.WIN[1].isoformat(),
            }
        }
        Path(helpers["MANIFEST"]).write_text(json.dumps(legacy), encoding="utf-8")
        rerun, graph = self.run_helpers(lambda *a: "succeeded")
        keys, rows = rerun["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(graph.created, [self.NEXT])
        self.assertEqual(keys, {key, self.key(rerun, self.NEXT)})
        self.assertEqual(rows, 2)

    def test_non_retryable_error_is_not_retried_but_other_windows_continue(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        original = graph.request
        graph.request = lambda method, url, **kw: (
            FakeResponse({"value": [], "@odata.nextLink": "https://evil.example/x"})
            if graph.ranges[url.split("/queries/")[1].split("/")[0]][0] == self.WIN[0]
            else original(method, url, **kw)
        )
        helpers["_request"] = graph.request
        with self.assertRaisesRegex(RuntimeError, "1 audit window\\(s\\) still failed"):
            helpers["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(graph.attempts(*self.WIN), 1)
        self.assertEqual(helpers["_load_manifest"]()[self.key(helpers, self.NEXT)]["status"], "succeeded")

    def test_authorization_errors_stop_the_run(self):
        class Forbidden(Exception):
            response = type("R", (), {"status_code": 403})()

        def create(ws, we):
            raise Forbidden("403 Forbidden")

        helpers, _ = self.run_helpers(lambda *a: "succeeded", create_query=create)
        with self.assertRaises(Forbidden):
            helpers["fetch_windows"]([self.WIN])

    def test_failures_lower_concurrency_for_the_rest_of_the_run(self):
        active, peak = [0], [0]
        lock = threading.Lock()

        def wait(qid):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time_sleep(0.02)
            with lock:
                active[0] -= 1
            if graph.ranges[qid][2] == 1 and graph.ranges[qid][0] == self.WIN[0]:
                raise failed(f"Query {qid} ended with status: failed")
            return {"status": "succeeded"}

        import time as _time
        time_sleep = _time.sleep
        helpers, graph = self.run_helpers(lambda *a: "succeeded", MAX_CONCURRENT_QUERIES=4)
        failed = helpers["AuditQueryFailed"]
        helpers["wait_for_query"] = wait
        helpers["QUERY_LIMITER"] = helpers["AdaptiveLimiter"](4, 1)
        windows = [
            (self.WIN[0] + timedelta(hours=8 * i), self.WIN[0] + timedelta(hours=8 * (i + 1))) for i in range(12)
        ]
        helpers["fetch_windows"](windows)
        self.assertLessEqual(peak[0], 4)
        self.assertEqual(helpers["QUERY_LIMITER"].limit, 3)
        self.assertEqual([h[:2] for h in helpers["QUERY_LIMITER"].history], [(4, 3)])

    def test_http_429_halves_concurrency_through_the_session_hook(self):
        from urllib3.util.retry import Retry

        ns = exec_named_defs(
            INGESTER, 4, {"THROTTLE_LISTENERS", "_notify_throttle", "_ThrottleAwareRetry"}, {"Retry": Retry}
        )
        limiter = self.ingester_helpers()["AdaptiveLimiter"](6, 1)
        ns["THROTTLE_LISTENERS"][:] = [lambda: limiter.shrink("HTTP 429", halve=True)]
        retry = ns["_ThrottleAwareRetry"](total=3, status_forcelist=(429,), raise_on_status=False)
        response = type("Resp", (), {"status": 429, "headers": {}, "get_redirect_location": lambda self: None})()
        retry = retry.increment("GET", "/x", response=response)
        self.assertIsInstance(retry, ns["_ThrottleAwareRetry"])
        self.assertEqual(limiter.limit, 3)

    def test_incremental_run_refuses_to_skip_an_unrecovered_older_window(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        key = self.key(helpers, self.WIN)
        helpers["manifest"][key] = {
            "status": "failed",
            "window_start": self.WIN[0].isoformat(),
            "window_end": self.WIN[1].isoformat(),
        }
        start = datetime(2026, 9, 3, tzinfo=timezone.utc)
        with self.assertRaisesRegex(RuntimeError, "Rerun with MODE='backfill' first") as caught:
            helpers["assert_no_unrecovered_gaps"](start - timedelta(days=180), start)
        self.assertIn("2026-08-25 00:00 -> 2026-08-25 08:00 UTC", str(caught.exception))
        self.assertIn("ALLOW_UNRECOVERED_GAPS = True", str(caught.exception))
        # Once a later backfill covers the range (even via split parts) the guard passes.
        helpers["manifest"]["v2_part_a"] = {
            "status": "succeeded",
            "window_start": self.WIN[0].isoformat(),
            "window_end": self.WIN[1].isoformat(),
        }
        helpers["assert_no_unrecovered_gaps"](start - timedelta(days=180), start)

    def test_manifest_rejects_split_entry_without_parts(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        Path(helpers["MANIFEST"]).write_text(json.dumps({"k": {"status": "split"}}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "split but has no valid parts"):
            helpers["_load_manifest"]()

    def test_main_loop_wires_the_gap_guard_limiter_and_throttle_hook(self):
        source = cells(INGESTER)[10]
        self.assertIn("if MODE == 'incremental' and not ALLOW_UNRECOVERED_GAPS:", source)
        self.assertIn("QUERY_LIMITER = AdaptiveLimiter(MAX_CONCURRENT_QUERIES, MIN_CONCURRENT_QUERIES)", source)
        self.assertIn("THROTTLE_LISTENERS[:] = [", source)
        self.assertIn("ACTIVE_WINDOW_KEYS, total = fetch_windows(windows)", source)
        self.assertNotIn("as_completed", source)


if __name__ == "__main__":
    unittest.main()
