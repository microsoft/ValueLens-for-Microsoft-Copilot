"""Load Status notebook: the dbo.load_log rows and failure reasons, matching the installer."""
import json
import shutil
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "AnalyticsHub_Load_Status.ipynb"
INSTALLER = ROOT / "1. Fabric" / "installer"
RUN_ID = "00000000-0000-0000-0000-000000000001"


def cells():
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    return notebook, ["".join(c["source"]) for c in notebook["cells"] if c["cell_type"] == "code"]


def namespace():
    _, code = cells()
    scope = {}
    exec(code[0], scope)  # config
    exec(code[1], scope)  # pure helpers
    return scope


def status(s):
    return json.loads(s["STATUS_JSON"])


def run(name, state, start, error=None, kind="TridentNotebook", ms=1000):
    return {"activityName": name, "activityType": kind, "status": state, "activityRunStart": start,
            "activityRunEnd": start, "durationInMs": ms, "error": error or {}}


class LoadStatusTests(unittest.TestCase):
    def test_notebook_is_clean(self):
        notebook, code = cells()
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
        for source in code:
            compile(source, str(NOTEBOOK), "exec")
        s = namespace()
        self.assertEqual(s["PIPELINE_RUN_ID"], "")
        self.assertEqual(s["LOG_TABLE"], "dbo.load_log")
        self.assertIn("rerun-failed", code[2])

    def test_failures_are_explained_in_plain_words(self):
        s = namespace()
        reasons = status(s)["reasons"]
        cases = {
            "capacity": {"errorCode": "TooManyRequestsForCapacity", "message": "Spark capacity limit reached"},
            "signIn": {"errorCode": "2011", "message": "AADSTS7000215: Invalid client secret provided."},
            "timeout": {"errorCode": "2104", "message": "The notebook timed out after 2 hours"},
            "noData": {"errorCode": "2011", "message": "PATH_NOT_FOUND: Files/agent365/agents.csv"},
            "notSynced": {"errorCode": "2011", "message": "Table 'copilot_interactions_curated' is not in database"},
        }
        for kind, error in cases.items():
            with self.subTest(kind=kind):
                self.assertEqual(s["classify"](error, reasons)[0], kind)
        self.assertEqual(s["classify"]({"errorCode": 430, "message": ""}, reasons)[0], "capacity")
        self.assertEqual(s["classify"]({"message": "\n  KeyError: 'x'\nmore"}, reasons), ("other", "It stopped with an error: KeyError: 'x'"))
        self.assertEqual(s["classify"](None, reasons), ("other", "It stopped without saying why."))

    def test_last_attempt_counts_the_tries(self):
        s = namespace()
        last = s["last_attempts"]([
            run("Run_Licensed_Users_Ingester", "Succeeded", "2026-06-01T10:05:00Z"),
            run("Run_Licensed_Users_Ingester", "Failed", "2026-06-01T10:00:00Z", {"errorCode": "430"}),
            run("Run_Org_Data_Ingester", "Succeeded", "2026-06-01T10:01:00Z"),
        ])
        self.assertEqual(last["Run_Licensed_Users_Ingester"]["status"], "Succeeded")
        self.assertEqual(last["Run_Licensed_Users_Ingester"]["attempts"], 2)
        self.assertEqual(last["Run_Org_Data_Ingester"]["attempts"], 1)

    def test_agent365_api_failure_covered_by_the_export_is_not_a_failure(self):
        s = namespace()
        t = "2026-06-01T10:00:00Z"
        covered = s["last_attempts"]([
            run("Run_Agent365_Registry_Ingester", "Failed", t, {"message": "403 Forbidden"}),
            run("Run_Agent365_CSV_Fallback", "Succeeded", t),
            run("If_Agent365_Failed", "Succeeded", t, kind="IfCondition"),
            run("Run_Audit_Log_Ingester", "Failed", t, {"errorCode": "TooManyRequestsForCapacity"}),
            run("Record_Load_Status", "InProgress", t),
        ])
        self.assertEqual(s["failed_loads"](covered), ["Run_Audit_Log_Ingester"])
        both = s["last_attempts"]([
            run("Run_Agent365_Registry_Ingester", "Failed", t),
            run("Run_Agent365_CSV_Fallback", "Failed", t),
        ])
        self.assertEqual(s["failed_loads"](both), ["Run_Agent365_Registry_Ingester", "Run_Agent365_CSV_Fallback"])

    def test_rows_hold_plain_reasons_and_skip_the_bookkeeping_steps(self):
        s = namespace()
        st = status(s)
        logged = datetime(2026, 6, 1, 12, 0)
        last = s["last_attempts"]([
            run("Run_Audit_Log_Ingester", "Failed", "2026-06-01T10:00:00.1234567Z", {"errorCode": "TooManyRequestsForCapacity", "message": "busy"}, ms=2500),
            run("Run_Org_Data_Ingester", "Succeeded", "2026-06-01T10:01:00Z"),
            run("Run_Some_NewThing", "Skipped", "2026-06-01T10:02:00Z", ms=None),
            run("If_Agent365_Failed", "Succeeded", "2026-06-01T10:02:00Z", kind="IfCondition"),
            run("Record_Load_Status", "InProgress", "2026-06-01T10:03:00Z"),
        ])
        out = {r["activity"]: r for r in s["rows"](last, st["labels"], st["reasons"], RUN_ID, logged)}
        self.assertEqual(set(out), {"Run_Audit_Log_Ingester", "Run_Org_Data_Ingester", "Run_Some_NewThing"})
        audit = out["Run_Audit_Log_Ingester"]
        self.assertEqual((audit["source"], audit["status"], audit["reason_kind"]), ("Copilot audit log", "Failed", "capacity"))
        self.assertEqual(audit["error_code"], "TooManyRequestsForCapacity")
        self.assertEqual(audit["duration_seconds"], 2.5)
        self.assertEqual(audit["started_at"], datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc))
        self.assertEqual((audit["run_id"], audit["logged_at"]), (RUN_ID, logged))
        org = out["Run_Org_Data_Ingester"]
        self.assertEqual((org["source"], org["reason"], org["error_code"], org["error_message"]), ("Org data (Entra ID)", None, None, None))
        new = out["Run_Some_NewThing"]
        self.assertEqual((new["source"], new["duration_seconds"]), ("Some New Thing", None))

    def test_window_covers_the_run(self):
        s = namespace()
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        after, before = s["window"]("2026-06-01T09:30:00.1234567Z", now)
        self.assertEqual(after, datetime(2026, 6, 1, 8, 30, tzinfo=timezone.utc))
        self.assertEqual(before, datetime(2026, 6, 1, 13, 0, tzinfo=timezone.utc))
        self.assertEqual(s["window"]("", now)[0], datetime(2026, 5, 30, 11, 0, tzinfo=timezone.utc))
        self.assertIsNone(s["parse_time"]("not a time"))

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_labels_and_reasons_match_the_installer(self):
        script = "import('./src/loads.js').then(m => process.stdout.write(m.statusConfigJson()))"
        out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=INSTALLER, capture_output=True, text=True, check=True, encoding="utf-8").stdout
        self.assertEqual(status(namespace()), json.loads(out))


if __name__ == "__main__":
    unittest.main()
