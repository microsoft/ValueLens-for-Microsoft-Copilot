"""The agent-type classifier copies outside Fabric must not drift from the Fabric notebook rules.

- Local CSV processor: an exact source copy of notebook cell 2's classifier, checked by AST and by output.
- Power Query templates (Local CSV, SharePoint, Dataverse): ValueLensDescribeAgent is an M port. Its
  shipped text is run with tests/m_eval.py over the samples and a combinatorial grid of inputs.
"""
import ast
import csv
import itertools
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from m_eval import evaluate
from test_agent_linking import CSV_PROCESSOR, PROCESSOR, audit_row, cells, load_csv_processor
from test_agent_type_classification import CLASSIFIER_NAMES, NS, SAMPLES

ROOT = Path(__file__).resolve().parents[1]
FACT = "Chat + Agent Interactions (Audit Logs)"
AGENT_TYPE_COLS = ["Agent_Key", "Agent_Type", "Agent_Type_Basis", "Agent_Publisher",
                   "Agent_Is_Published", "Agent_Consolidated_Name"]
FABRIC_TEMPLATES = (
    Path("1. Fabric") / "Manual setup" / "ValueLens - Fabric.pbit",
    Path("1. Fabric") / "Manual setup" / "ValueLens - Fabric OneLake.pbit",
)
M_TEMPLATES = (
    Path("4. Local CSV") / "ValueLens - Local CSV.pbit",
    Path("3. SharePoint") / "ValueLens - SharePoint.pbit",
    Path("2. Power Automate + Dataverse") / "ValueLens - Power Automate + Dataverse.pbit",
)
AGENTS_PAGE = "93c52bc8ecf242b91ee4"

# Inputs for the grid: edge cases of every rule (prefixes, MicrosoftAgent.* segments, hosts).
GRID_IDS = [None, "", "  ", "T_1", "u_9.x", "P_r1", "BuiltIn_Researcher", "builtin_", "Analyst",
            "x.customengine", "abcd-1234"]
GRID_NAMES = [None, "", " researcher ", "Word-Drafting Agent", "Bot", "Copilot Cowork"]
GRID_APPS = [None, "", "MicrosoftAgent.", "MicrosoftAgent.Researcher", "microsoftagent.Analyst.P_1",
             "MicrosoftAgent..p_x", "MicrosoftAgent.ab.p_", "MicrosoftAgent.x.y.P_z", "Copilot.M365Copilot.Chat",
             "Copilot.TeamCopilot.Meeting", "CopilotStudio.Declarative.T_1", "Copilot.Studio.x",
             "ConnectedAIApp.Foundry.a", "AIApp.ChatGPT", "U_1.bot", "T_", "Teams"]
GRID_KINDS = [(None, None), ("Copilot Studio", "Copilot"), (None, "ConnectedAIApp"), (" copilotstudio\t", "AIApp")]


def schema(relative):
    with zipfile.ZipFile(ROOT / relative) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]


def fact_table(model):
    return next(t for t in model["tables"] if t["name"] == FACT)


def text(value):
    return "\n".join(value) if isinstance(value, list) else value


def top_level(source):
    """{name: normalised AST dump} of top-level functions and assignments."""
    found = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef):
            found[node.name] = ast.dump(node)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    found[target.id] = ast.dump(node)
    return found


def m_function_text():
    return {str(rel): text(next(e for e in schema(rel)["expressions"]
                                if e["name"] == "ValueLensDescribeAgent")["expression"])
            for rel in M_TEMPLATES}


def m_row(record):
    if record is None:
        return (None,) * 6
    return tuple(record[c] for c in AGENT_TYPE_COLS)


class LocalCsvClassifierParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_csv_processor()

    def test_source_is_an_exact_copy_of_the_notebook(self):
        notebook = top_level(cells(PROCESSOR)[2])
        local = top_level(CSV_PROCESSOR.read_text(encoding="utf-8"))
        for name in CLASSIFIER_NAMES:
            with self.subTest(name=name):
                self.assertIn(name, local)
                self.assertEqual(local[name], notebook[name])

    def test_outputs_match_the_notebook(self):
        overrides = NS["build_agent_type_overrides"]([("T_8a2b.contoso", "Custom bucket")])
        for aid, name, app, kind, workload, _ in SAMPLES:
            for extra in ({}, {"overrides": overrides}):
                with self.subTest(aid=aid, name=name, app=app, extra=bool(extra)):
                    self.assertEqual(self.mod.describe_agent(aid, name, app, kind, workload, **extra),
                                     NS["describe_agent"](aid, name, app, kind, workload, **extra))

    def test_describer_writes_csv_text(self):
        describe = self.mod.make_agent_type_describer()
        self.assertEqual(describe("P_r1", "Researcher", "MicrosoftAgent.Researcher.P_r1", "", "Copilot"),
                         ("P_r1", NS["AGENT_TYPE_FP_PUBLISHED"], "documented/observed", "Microsoft", "TRUE",
                          "Researcher"))
        self.assertEqual(describe("U_1", "Bot", "", "", "")[4], "FALSE")
        self.assertEqual(describe("abc", "Bot", "Copilot.Studio.x", "", "")[4], "")
        self.assertEqual(describe("", "", "", "", "Copilot"), ("",) * 6)


class LocalCsvProcessorOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_csv_processor()

    def run_processor(self, profile, rows, overrides=None):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            purview, entra = tmp / "purview.csv", tmp / "entra.csv"
            with purview.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["Operation", "AuditData"])
                writer.writeheader()
                writer.writerows(rows)
            entra.write_text("userPrincipalName,Has license\nperson@contoso.com,Yes\n", encoding="utf-8")
            overrides_path = None
            if overrides is not None:
                overrides_path = tmp / "overrides.csv"
                overrides_path.write_text(overrides, encoding="utf-8")
            self.mod.run_processor(str(purview), str(entra), str(tmp / "fact.csv"), str(tmp / "users.csv"),
                                   profile=profile, quiet=True,
                                   agent_type_overrides_csv=str(overrides_path) if overrides_path else None)
            with (tmp / "fact.csv").open(encoding="utf-8", newline="") as handle:
                reader = csv.DictReader(handle)
                return reader.fieldnames, list(reader)

    def rows(self):
        prompt = [{"Id": "m1", "isPrompt": True}]
        researcher = json.loads(audit_row("r-researcher", "Teams", [{"Id": "m2", "isPrompt": True}],
                                          agent_id="P_r1")["AuditData"])
        researcher["AppIdentity"] = "MicrosoftAgent.Researcher.P_r1"
        researcher["AgentName"] = "researcher"
        studio = json.loads(audit_row("r-studio", "Teams", [{"Id": "m3", "isPrompt": True}])["AuditData"])
        studio["CopilotEventData"].update(TargetPlatformAgentId="abcd-1234", TargetAgentName="IT bot",
                                          PlatformAgentType="Copilot Studio")
        studio["AgentName"] = ""
        chat = json.loads(audit_row("r-chat", "Teams", [{"Id": "m4", "isPrompt": True}])["AuditData"])
        chat["AgentName"] = ""
        chat = {"Operation": "CopilotInteraction", "AuditData": json.dumps(chat)}
        return [
            audit_row("r-org", "Teams", prompt, agent_id="T_title-1"),
            {"Operation": "CopilotInteraction", "AuditData": json.dumps(researcher)},
            {"Operation": "CopilotInteraction", "AuditData": json.dumps(studio)},
            chat,
        ]

    def values(self, rows):
        return sorted(tuple(r[c] for c in AGENT_TYPE_COLS) for r in rows)

    def test_aibv_emits_agent_type_columns(self):
        header, rows = self.run_processor("aibv", self.rows())
        self.assertEqual([c for c in header if c in AGENT_TYPE_COLS], AGENT_TYPE_COLS)
        self.assertIn("Agent Publish Status", header)
        self.assertEqual(self.values(rows), sorted([
            ("T_title-1", NS["AGENT_TYPE_ORG_PUBLISHED"], "inferred", "Your organisation", "TRUE", "Agent"),
            ("P_r1", NS["AGENT_TYPE_FP_PUBLISHED"], "documented/observed", "Microsoft", "TRUE", "Researcher"),
            # CopilotEventData agent fields win, as in the Fabric processor.
            ("abcd-1234", NS["AGENT_TYPE_COPILOT_STUDIO"], "documented", "Your organisation", "", "IT bot"),
            ("",) * 6,
        ]))
    def test_aio_profile_is_unchanged(self):
        header, _ = self.run_processor("aio", self.rows())
        self.assertFalse(set(AGENT_TYPE_COLS) & set(header))

    def test_overrides_csv(self):
        _, rows = self.run_processor("aibv", self.rows(), "key,Agent_Type\nt_title-1,My bucket\n")
        got = next(r for r in rows if r["Agent_Key"] == "T_title-1")
        self.assertEqual((got["Agent_Type"], got["Agent_Type_Basis"], got["Agent_Publisher"]),
                         ("My bucket", "override", "Unknown"))
        with self.assertRaises(ValueError):
            self.run_processor("aibv", self.rows(), "agent,type\nx,y\n")


class PowerQueryPortParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        texts = m_function_text()
        cls.texts = texts
        cls.describe = staticmethod(evaluate(next(iter(texts.values()))))

    def assert_same(self, aid, name, app, kind, workload):
        want = NS["describe_agent"](aid, name, app, kind, workload)
        got = m_row(self.describe(aid, name, app, kind, workload))
        self.assertEqual(got, want, (aid, name, app, kind, workload))

    def test_identical_in_every_template(self):
        self.assertEqual(len(set(self.texts.values())), 1, list(self.texts))

    def test_samples(self):
        for aid, name, app, kind, workload, _ in SAMPLES:
            with self.subTest(aid=aid, name=name, app=app):
                self.assert_same(aid, name, app, kind, workload)

    def test_grid(self):
        count = 0
        for aid, name, app in itertools.product(GRID_IDS, GRID_NAMES, GRID_APPS):
            self.assert_same(aid, name, app, None, None)
            count += 1
        for (kind, workload), aid, app in itertools.product(GRID_KINDS, GRID_IDS, GRID_APPS):
            self.assert_same(aid, "Bot", app, kind, workload)
            count += 1
        self.assertGreater(count, 1000)

    def test_logical_and_text_types(self):
        row = self.describe("U_1", "Bot", None, None, None)
        self.assertIs(row["Agent_Is_Published"], False)
        self.assertIsNone(self.describe(None, None, "Copilot.M365Copilot.Chat", None, "Copilot"))


class TemplateAgentTypeColumnTests(unittest.TestCase):
    def test_model_columns_match_fabric(self):
        def columns(relative):
            table = fact_table(schema(relative))
            return [c for c in table["columns"] if c["name"] in AGENT_TYPE_COLS]
        baseline = columns(FABRIC_TEMPLATES[0])
        self.assertEqual([c["name"] for c in baseline], AGENT_TYPE_COLS)
        published = next(c for c in baseline if c["name"] == "Agent_Is_Published")
        self.assertEqual(published["dataType"], "boolean")
        for relative in FABRIC_TEMPLATES[1:] + M_TEMPLATES:
            with self.subTest(template=str(relative)):
                self.assertEqual(columns(relative), baseline)
                names = [c["name"] for c in fact_table(schema(relative))["columns"]]
                at = names.index("Agent_LinkID")
                self.assertEqual(names[at + 1:at + 7], AGENT_TYPE_COLS)

    def test_power_query_templates_classify_when_the_extract_lacks_the_columns(self):
        for relative in M_TEMPLATES:
            with self.subTest(template=str(relative)):
                model = schema(relative)
                query = text(fact_table(model)["partitions"][0]["source"]["expression"])
                self.assertIn('Table.HasColumns(__link, "Agent_Type")', query)
                self.assertIn("ValueLensDescribeAgent([AgentId], [AgentName], [AppIdentity_DisplayName]", query)
                for column in AGENT_TYPE_COLS:
                    self.assertIn(f'"{column}"', query)
                self.assertIn('{"Agent_Is_Published", type logical}', query)
                order = next(json.loads(a["value"]) for a in model["annotations"] if a["name"] == "PBI_QueryOrder")
                self.assertLess(order.index("ValueLensDescribeAgent"), order.index(FACT))

    def test_agents_page_has_agent_type_slicer_and_breakdown(self):
        for relative in FABRIC_TEMPLATES + M_TEMPLATES:
            with zipfile.ZipFile(ROOT / relative) as archive:
                names = set(archive.namelist())
                for visual, kind in (("agenttypeslicer", "slicer"), ("agenttypebreakdown", "clusteredBarChart")):
                    with self.subTest(template=str(relative), visual=visual):
                        part = f"Report/definition/pages/{AGENTS_PAGE}/visuals/{visual}/visual.json"
                        self.assertIn(part, names)
                        doc = json.loads(archive.read(part))
                        self.assertEqual(doc["visual"]["visualType"], kind)
                        self.assertIn('"Property": "Agent_Type"', json.dumps(doc))


if __name__ == "__main__":
    unittest.main()
