"""Audit exclusion and runtime keys in the Local CSV processor and the Power Automate bridge.

The Analytics Hub Fabric notebooks own these rules. With ANALYTICS_HUB_ROOT set (see analytics_hub.py),
EXCLUDE_CASES are checked against the processor notebook's CASE expression, run in sqlite.
"""
import ast
import json
import re
import sqlite3
import unittest
from pathlib import Path

import analytics_hub

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOKS = analytics_hub.NOTEBOOKS
PROCESSOR = NOTEBOOKS / "Copilot_Audit_Log_Processor.ipynb"

GUID_A = "11111111-2222-3333-4444-555555555555"
GUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
ZERO = "00000000-0000-0000-0000-000000000000"


def cells(path):
    return ["".join(cell["source"]) for cell in json.loads(path.read_text(encoding="utf-8"))["cells"]]


def load_pure(path, index, names):
    """Exec only the named top-level assignments and functions (no pyspark imports)."""
    tree = ast.parse(cells(path)[index])
    wanted = set(names)
    body = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            body.append(node)
        elif isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id in wanted for t in node.targets):
            body.append(node)
    ns = {"re": re}
    exec(compile(ast.Module(body=body, type_ignores=[]), f"{path.name}:cell{index}", "exec"), ns)
    missing = wanted - set(ns)
    if missing:
        raise AssertionError(f"{path.name} cell {index} lacks {sorted(missing)}")
    return ns


# (AppHost, Prompts_Available, AgentId, expected reason)
EXCLUDE_CASES = [
    ("Copilot Studio", "TRUE", "T_x.y", "Copilot Studio test pane"),
    (" copilot studio ", "FALSE", None, "Copilot Studio test pane"),
    ("pva-maker-evaluation", "FALSE", None, "Maker evaluation"),
    ("agentic-builder", "TRUE", None, "Agent authoring"),
    ("Autonomous", "FALSE", None, "Autonomous run"),
    ("workflow-agents", "FALSE", None, "Workflow run"),
    ("M365Copilot", "FALSE", None, "M365 Copilot twin"),
    ("m365copilot", "false", "T_abc", "M365 Copilot twin"),
    ("M365Copilot", "TRUE", None, None),
    ("M365Copilot", None, None, None),
    ("Teams", "FALSE", None, None),
    ("Teams", "TRUE", ZERO, "Fabric multi-agent"),
    ("Teams", "TRUE", "0000", "Fabric multi-agent"),
    ("Teams", "TRUE", GUID_A, None),
    ("Teams", "TRUE", "", None),
    (None, None, None, None),
    ("Outlook", "TRUE", "  ", None),
]


@analytics_hub.required
class NotebookParityTests(unittest.TestCase):
    def test_exclude_cases_match_the_notebook_sql(self):
        sql = load_pure(PROCESSOR, 2, ["EXCLUDE_REASON_SQL"])["EXCLUDE_REASON_SQL"]
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE t (AppHost TEXT, Prompts_Available TEXT, AgentId TEXT, expected TEXT)")
        db.executemany("INSERT INTO t VALUES (?,?,?,?)", EXCLUDE_CASES)
        got = db.execute(f"SELECT AppHost, Prompts_Available, AgentId, expected, {sql} FROM t").fetchall()
        for host, prompts, agent, expected, actual in got:
            with self.subTest(host=host, prompts=prompts, agent=agent):
                self.assertEqual(expected, actual)


CSV_PROCESSOR = ROOT / "5. Local CSV" / "scripts" / "Purview_CopilotInteraction_Processor_v4.0.0.py"


def load_csv_processor():
    import importlib.util
    spec = importlib.util.spec_from_file_location("valuelens_csv_processor", CSV_PROCESSOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def audit_row(record_id, app_host, messages, agent_id="", platform=None, platform_agent_id=None,
              thread_id="thread-1", conversation_id=None, user="person@contoso.com"):
    ced = {"AppHost": app_host, "Messages": messages, "AccessedResources": [], "Contexts": []}
    if thread_id:
        ced["ThreadId"] = thread_id
    audit = {"Id": record_id, "Operation": "CopilotInteraction", "CreationTime": "2026-09-01T10:00:00",
             "UserId": user, "AgentId": agent_id, "AgentName": "Agent", "CopilotEventData": ced}
    if platform:
        audit["AgentPlatform"] = platform
    if platform_agent_id:
        audit["PlatformAgentId"] = platform_agent_id
    if conversation_id:
        audit["ConversationId"] = conversation_id
    return {"Operation": "CopilotInteraction", "AuditData": json.dumps(audit)}


class LocalCsvProcessorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_csv_processor()

    def test_python_classifier_matches_the_cases(self):
        for host, prompts, agent, expected in EXCLUDE_CASES:
            with self.subTest(host=host, prompts=prompts, agent=agent):
                self.assertEqual(expected or "", self.mod.classify_exclude_reason(host, prompts, agent))

    @analytics_hub.required
    def test_drop_reasons_match_the_notebook_sql(self):
        sql = load_pure(PROCESSOR, 2, ["EXCLUDE_REASON_SQL"])["EXCLUDE_REASON_SQL"]
        self.assertEqual(set(re.findall(r"THEN '([^']+)'", sql)), set(self.mod.DROP_EXCLUDE_REASONS))

    def test_runtime_keys(self):
        self.assertEqual((GUID_A, f"Default-{GUID_B}"),
                         self.mod.derive_bot_and_environment(f"Default-{GUID_B}_{GUID_A.upper()}"))
        self.assertEqual(("", ""), self.mod.derive_bot_and_environment(None))
        self.assertEqual("", self.mod.derive_agent_entra_id(ZERO, ZERO))
        self.assertEqual(GUID_A, self.mod.derive_agent_entra_id(GUID_A, GUID_A))

    def run_profile(self, profile, rows):
        import csv
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            purview, entra = tmp / "purview.csv", tmp / "entra.csv"
            with purview.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["Operation", "AuditData"])
                writer.writeheader()
                writer.writerows(rows)
            entra.write_text("userPrincipalName,Has license\nperson@contoso.com,Yes\n", encoding="utf-8")
            stats = self.mod.run_processor(str(purview), str(entra), str(tmp / "fact.csv"),
                                           str(tmp / "users.csv"), profile=profile, quiet=True)
            with (tmp / "fact.csv").open(encoding="utf-8", newline="") as handle:
                return stats, list(csv.DictReader(handle))

    def sample(self):
        prompt = [{"Id": "m1", "isPrompt": True}]
        return [
            audit_row("r-prompt", "Teams", prompt, agent_id="T_title-1"),
            audit_row("r-runtime", "Teams", [], agent_id=GUID_A, platform="Copilot Studio",
                      platform_agent_id=f"Default-{GUID_B}_{GUID_A}", thread_id=None,
                      conversation_id="conv-9"),
            audit_row("r-runtime-2", "Teams", [], agent_id=GUID_A, platform="CopilotStudio",
                      platform_agent_id=f"Default-{GUID_B}_{GUID_A}", thread_id=None),
            audit_row("r-twin", "M365Copilot", [], platform="CopilotStudio"),
            audit_row("r-testpane", "Copilot Studio", prompt, agent_id="T_title-1"),
            audit_row("r-zero", "Teams", [{"Id": "m2", "isPrompt": True}], agent_id=ZERO),
            audit_row("r-empty", "Teams", []),
        ]

    def test_aibv_keeps_runtime_records_and_drops_excluded(self):
        stats, rows = self.run_profile("aibv", self.sample())
        self.assertEqual({"Copilot Studio test pane": 1, "Fabric multi-agent": 1, "M365 Copilot twin": 1},
                         stats["excluded_by_reason"])
        self.assertEqual(3, len(rows))
        runtime = [r for r in rows if r["Message_isPrompt"] == "FALSE"]
        self.assertEqual(2, len(runtime))
        self.assertEqual(2, len({r["Message_Id"] for r in runtime}), "each runtime record is its own message")
        for row in runtime:
            self.assertEqual("FALSE", row["Prompts_Available"])
            self.assertEqual(GUID_A, row["Agent_BotId"])
            self.assertEqual(f"Default-{GUID_B}", row["Agent_EnvironmentId"])
            self.assertEqual(GUID_A, row["Agent_EntraId"])
            self.assertEqual("", row["Exclude_Reason"])
        # ThreadId falls back to the conversation id; one runtime record has none.
        self.assertEqual(1, sum(1 for r in runtime if r["ThreadId"]))
        prompt = [r for r in rows if r["Message_isPrompt"] == "TRUE"]
        self.assertEqual("TRUE", prompt[0]["Prompts_Available"])

    def test_aio_profile_keeps_v310_behaviour(self):
        stats, rows = self.run_profile("aio", self.sample())
        self.assertEqual({}, stats["excluded_by_reason"])
        self.assertEqual(list(self.mod.FACT_HEADER_AIO), list(rows[0].keys()))
        self.assertEqual(3, len(rows))  # the three prompt records; no runtime rows
        self.assertEqual({"TRUE"}, {r["Message_isPrompt"] for r in rows})
        for column in ("Agent_BotId", "Prompts_Available", "Exclude_Reason", "Agent_EntraId"):
            self.assertNotIn(column, self.mod.FACT_HEADER_AIO)


class PowerAutomateBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import importlib.util
        path = ROOT / "3. Power Automate + Dataverse" / "scripts" / "Build-DataverseCoreFeeds.py"
        spec = importlib.util.spec_from_file_location("valuelens_bridge_linking", path)
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)

    def payload(self, messages, platform=None):
        audit = {"Operation": "CopilotInteraction", "CreationTime": "2026-09-01T10:00:00",
                 "UserId": "person@contoso.com", "CopilotEventData": {"AppHost": "Teams"}}
        if messages is not ...:
            audit["CopilotEventData"]["Messages"] = messages
        if platform:
            audit["AgentPlatform"] = platform
        return {"AuditData": audit}

    def test_copilot_studio_runtime_records_without_messages_are_accepted(self):
        for messages in ([], None, ...):
            with self.subTest(messages=messages):
                audit = self.bridge.extract_audit_payload(self.payload(messages, platform="Copilot Studio"))
                self.assertEqual("CopilotInteraction", audit["Operation"])

    def test_other_records_without_messages_are_still_rejected(self):
        for messages, platform in (([], None), (None, "AgentBuilder"), ("text", "CopilotStudio")):
            with self.subTest(messages=messages, platform=platform):
                with self.assertRaisesRegex(self.bridge.PathwayError, "CopilotEventData.Messages"):
                    self.bridge.extract_audit_payload(self.payload(messages, platform=platform))


if __name__ == "__main__":
    unittest.main()
