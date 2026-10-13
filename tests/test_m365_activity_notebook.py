"""Offline checks for the M365 activity ingester's Graph reads, row shaping and day planning."""
import ast
import json
import types
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "Copilot_M365_Activity_Ingester.ipynb"
NOTEBOOK = json.loads((ROOT / "1. Fabric" / "Manual setup" / "notebooks" / NAME).read_text(encoding="utf-8"))


def cell(marker):
    """Source of the one code cell containing `marker`, so tests survive cells moving."""
    hits = ["".join(c["source"]) for c in NOTEBOOK["cells"] if c["cell_type"] == "code" and marker in "".join(c["source"])]
    if len(hits) != 1:
        raise AssertionError(f"expected one code cell with {marker!r}, found {len(hits)}")
    return hits[0]


def definitions(source, namespace):
    """Runs only the imports, assignments and functions of a cell, skipping Spark and network calls."""
    keep = (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef, ast.ClassDef)
    body = [n for n in ast.parse(source).body if isinstance(n, keep) and not _uses_spark(n)]
    exec(compile(ast.Module(body=body, type_ignores=[]), NAME, "exec"), namespace)
    return namespace


def _uses_spark(node):
    if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("pyspark"):
        return True
    names = {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}
    return isinstance(node, ast.Assign) and bool(names & {"spark", "StructType", "_token", "get_graph_token"})


class FakeResponse:
    def __init__(self, status, body=b"", headers=None):
        self.status_code = status
        self.content = body
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class M365ActivityNotebookTests(unittest.TestCase):
    def setUp(self):
        self.calls, self.sleeps, self.tokens = [], [], []
        self.responses = []
        fake_requests = types.SimpleNamespace(
            get=self._get,
            RequestException=OSError,
        )
        self.ns = {
            "requests": fake_requests,
            "time": types.SimpleNamespace(sleep=self.sleeps.append),
            "GRAPH": "https://graph.example/v1.0",
            "_token": {"value": "old"},
            "get_graph_token": self._token,
            "REREAD_DAYS": 4,
        }
        definitions(cell("def fetch_report"), self.ns)
        definitions(cell("def add_report"), self.ns)
        definitions(cell("def build_rows"), self.ns)
        definitions(cell("def days_to_load"), self.ns)

    def _get(self, url, headers, timeout):
        self.calls.append((url, headers["Authorization"]))
        return self.responses.pop(0)

    def _token(self):
        self.tokens.append(1)
        return "new"

    def test_config_has_the_lines_the_installer_fills_in(self):
        config = cell("# === CONFIG ===")
        for line in (
            "TENANT_ID     = '<your-tenant-guid>'",
            "CLIENT_ID     = '<your-app-reg-client-id>'",
            "CLIENT_SECRET = '<your-client-secret-value>'",
            "OUTPUT_TABLE  = 'dbo.m365_activity_daily'",
        ):
            self.assertIn(line, config)

    def test_every_code_cell_compiles(self):
        for index, c in enumerate(NOTEBOOK["cells"]):
            if c["cell_type"] == "code":
                compile("".join(c["source"]), f"{NAME}:cell{index}", "exec")
                self.assertEqual(c["outputs"], [])

    def test_fetch_reads_the_csv_and_strips_the_byte_order_mark(self):
        self.responses = [FakeResponse(200, "\ufeffUser Principal Name,Send Count\r\na@x.com,3\r\n".encode("utf-8"))]
        rows = self.ns["fetch_report"]("getEmailActivityUserDetail", date(2026, 9, 1))
        self.assertEqual(rows, [{"User Principal Name": "a@x.com", "Send Count": "3"}])
        self.assertEqual(self.calls[0][0], "https://graph.example/v1.0/reports/getEmailActivityUserDetail(date=2026-09-01)")

    def test_fetch_treats_400_as_no_report_for_that_day(self):
        self.responses = [FakeResponse(400)]
        with self.assertRaises(self.ns["ReportUnavailable"]):
            self.ns["fetch_report"]("getTeamsUserActivityUserDetail", date(2026, 9, 1))

    def test_fetch_refreshes_an_expired_token_once(self):
        self.responses = [FakeResponse(401), FakeResponse(200, b"User Principal Name\n")]
        self.assertEqual(self.ns["fetch_report"]("getTeamsUserActivityUserDetail", date(2026, 9, 1)), [])
        self.assertEqual([auth for _, auth in self.calls], ["Bearer old", "Bearer new"])
        self.assertEqual(len(self.tokens), 1)

    def test_fetch_explains_a_missing_permission(self):
        self.responses = [FakeResponse(403)]
        with self.assertRaisesRegex(PermissionError, "Reports.Read.All"):
            self.ns["fetch_report"]("getTeamsUserActivityUserDetail", date(2026, 9, 1))

    def test_fetch_waits_for_throttling_and_server_errors(self):
        self.responses = [FakeResponse(429, headers={"Retry-After": "7"}), FakeResponse(503), FakeResponse(200, b"User Principal Name\n")]
        self.ns["fetch_report"]("getTeamsUserActivityUserDetail", date(2026, 9, 1))
        self.assertEqual(self.sleeps, [7, 4])

    def test_rows_join_reports_per_person_and_flag_active_workloads(self):
        people = {}
        add = self.ns["add_report"]
        add(people, "teams", [
            {"Report Refresh Date": "2026-09-03", "User Principal Name": "Ana@Contoso.com",
             "Team Chat Message Count": "4", "Meeting Count": "2", "Audio Duration": "PT1H2M3S"},
        ])
        add(people, "email", [
            {"User Principal Name": "ana@contoso.com", "Send Count": "5", "Receive Count": "40"},
            {"User Principal Name": "bo@contoso.com", "Receive Count": "12"},
            {"User Principal Name": "cy@contoso.com", "Send Count": "", "Receive Count": "0"},
        ])
        add(people, "apps", [{"User Principal Name": "ana@contoso.com", "Word": "Yes", "Outlook": "No", "Web": "Yes"}])
        rows = self.ns["build_rows"](date(2026, 9, 2), people, "now")
        columns = ["ActivityDate", "WeekStart", "UPN", "UPN_Normalized", "ReportRefreshDate"] + self.ns["VALUE_COLUMNS"] + list(self.ns["ACTIVE"]) + ["WorkloadsActive", "LoadedAtUtc"]
        by_person = {r[3]: dict(zip(columns, r)) for r in rows}

        self.assertEqual(set(by_person), {"ana@contoso.com", "bo@contoso.com"})  # cy did nothing
        ana = by_person["ana@contoso.com"]
        self.assertEqual(ana["UPN"], "Ana@Contoso.com")
        self.assertEqual(ana["WeekStart"], date(2026, 8, 31))
        self.assertEqual(ana["ReportRefreshDate"], date(2026, 9, 3))
        self.assertEqual((ana["TeamsChatMessages"], ana["TeamsMeetings"], ana["TeamsAudioSeconds"]), (4, 2, 3723))
        self.assertEqual((ana["EmailSent"], ana["EmailReceived"], ana["AppWord"], ana["AppOutlook"], ana["PlatformWeb"]), (5, 40, 1, 0, 1))
        self.assertEqual((ana["TeamsActive"], ana["EmailActive"], ana["AppsActive"], ana["SharePointActive"]), (1, 1, 1, 0))
        self.assertEqual(ana["WorkloadsActive"], 3)
        bo = by_person["bo@contoso.com"]
        self.assertEqual((bo["EmailReceived"], bo["EmailActive"], bo["WorkloadsActive"]), (12, 0, 0))
        self.assertEqual(len(columns), len(rows[0]))

    def test_days_cover_the_window_once_then_only_gaps_recent_and_concealed_days(self):
        today = date(2026, 10, 1)
        days_to_load = self.ns["days_to_load"]
        first = days_to_load(today, set(), set(), 4)
        self.assertEqual((len(first), first[0], first[-1]), (28, today - timedelta(days=28), today - timedelta(days=1)))
        loaded = set(first) - {today - timedelta(days=20)}
        concealed = {today - timedelta(days=10)}
        later = days_to_load(today, loaded, concealed, 4)
        self.assertEqual(later, sorted({today - timedelta(days=20), today - timedelta(days=10)} | {today - timedelta(days=n) for n in range(1, 5)}))


if __name__ == "__main__":
    unittest.main()
