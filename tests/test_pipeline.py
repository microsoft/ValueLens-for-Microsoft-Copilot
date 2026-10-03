"""Offline checks for the published pipeline's processor dependency contract."""
import json
import re
import unittest
from graphlib import TopologicalSorter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPELINES = ROOT / "1. Fabric" / "pipelines"
PROCESSOR = "Run_Audit_Log_Processor"
AGENT365 = "Conditionally_Run_Agent365"
FALLBACK = "Run_Agent365_CSV_Fallback"
INPUTS = {
    "Run_Audit_Log_Ingester",
    "Run_Licensed_Users_Ingester",
    FALLBACK,
}


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = PIPELINES / "CopilotAdoptionPipeline.DataPipeline" / "pipeline-content.json"
        cls.definition = json.loads(path.read_text(encoding="utf-8"))
        cls.properties = cls.definition["properties"]
        cls.activities = {a["name"]: a for a in cls.properties["activities"]}

    def test_processor_is_a_required_notebook_with_deployment_placeholders(self):
        processor = self.activities[PROCESSOR]
        self.assertEqual(processor["type"], "TridentNotebook")
        self.assertEqual(processor["typeProperties"], {
            "notebookId": "REPLACE_WITH_AUDIT_LOG_PROCESSOR_NOTEBOOK_ID",
            "workspaceId": "REPLACE_WITH_WORKSPACE_ID",
            "parameters": {},
        })
        self.assertEqual(processor.get("state", "Active"), "Active")
        self.assertEqual(processor["policy"]["timeout"], "0.02:00:00")
        self.assertEqual(processor["policy"]["retry"], 1)
        self.assertTrue(
            (ROOT / "1. Fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb").is_file()
        )

    def test_processor_waits_for_all_and_only_its_input_producers_to_succeed(self):
        dependencies = self.activities[PROCESSOR]["dependsOn"]
        self.assertEqual(len(dependencies), len(INPUTS))
        self.assertEqual({d["activity"] for d in dependencies}, INPUTS)
        for dependency in dependencies:
            expected = ["Succeeded", "Skipped"] if dependency["activity"] == FALLBACK else ["Succeeded"]
            self.assertEqual(dependency["dependencyConditions"], expected, dependency["activity"])

    def test_agent365_runs_api_first_with_top_level_csv_fallback(self):
        condition = self.activities[AGENT365]
        self.assertEqual(condition["type"], "IfCondition")
        self.assertIs(self.properties["parameters"]["EnableAgent365"]["defaultValue"], False)
        self.assertEqual(condition["typeProperties"]["expression"], {
            "value": "@pipeline().parameters.EnableAgent365",
            "type": "Expression",
        })
        self.assertEqual(condition["typeProperties"]["ifFalseActivities"], [])
        enabled = condition["typeProperties"]["ifTrueActivities"]
        self.assertEqual(len(enabled), 1)
        self.assertEqual(enabled[0]["name"], "Run_Agent365_Registry_Ingester")
        self.assertEqual(enabled[0]["type"], "TridentNotebook")
        self.assertEqual(enabled[0]["typeProperties"]["notebookId"], "REPLACE_WITH_AGENT365_REGISTRY_NOTEBOOK_ID")
        fallback = self.activities[FALLBACK]
        self.assertEqual(fallback["type"], "TridentNotebook")
        self.assertEqual(fallback["typeProperties"]["notebookId"], "REPLACE_WITH_AGENT365_LANDER_NOTEBOOK_ID")
        self.assertEqual(fallback["dependsOn"], [{"activity": AGENT365, "dependencyConditions": ["Failed"]}])
        dependencies = {d["activity"] for d in self.activities[PROCESSOR]["dependsOn"]}
        self.assertNotIn(AGENT365, dependencies)
        self.assertNotIn(enabled[0]["name"], dependencies)
        for path in ("Copilot_Agent365_Registry_Ingester.ipynb", "Copilot_Agent365_Lander.ipynb"):
            self.assertTrue((ROOT / "1. Fabric" / "notebooks" / path).is_file(), path)

    def simulate(self, outcomes, enabled):
        """Apply Data Factory's documented dependency and leaf-status rules to the Agent 365 path."""
        order = ["Run_Audit_Log_Ingester", "Run_Licensed_Users_Ingester", AGENT365, FALLBACK, PROCESSOR]
        status = {}
        for name in order:
            activity = self.activities[name]
            if not all(status[d["activity"]] in d["dependencyConditions"] for d in activity["dependsOn"]):
                status[name] = "Skipped"
            elif activity["type"] == "IfCondition":
                branch = "ifTrueActivities" if enabled else "ifFalseActivities"
                inner = activity["typeProperties"][branch]
                status[name] = "Failed" if any(outcomes.get(a["name"]) == "Failed" for a in inner) else "Succeeded"
            else:
                status[name] = outcomes.get(name, "Succeeded")
        parents = {n: [d["activity"] for d in self.activities[n]["dependsOn"]] for n in order}

        def evaluated(name):
            if status[name] != "Skipped":
                return status[name] == "Succeeded"
            return all(evaluated(p) for p in parents[name])

        leaves = [n for n in order if not any(n in parents[m] for m in order)]
        return status, all(evaluated(n) for n in leaves)

    def test_agent365_fallback_scenarios_follow_try_catch_semantics(self):
        cases = {
            "disabled": ({}, False, "Skipped", "Succeeded", True),
            "api succeeds": ({}, True, "Skipped", "Succeeded", True),
            "api fails, csv lands": ({"Run_Agent365_Registry_Ingester": "Failed"}, True, "Succeeded", "Succeeded", True),
            "api and csv fail": (
                {"Run_Agent365_Registry_Ingester": "Failed", FALLBACK: "Failed"}, True, "Failed", "Skipped", False,
            ),
        }
        for label, (outcomes, enabled, fallback, processor, pipeline_ok) in cases.items():
            with self.subTest(label):
                status, ok = self.simulate(outcomes, enabled)
                self.assertEqual(status[FALLBACK], fallback)
                self.assertEqual(status[PROCESSOR], processor)
                self.assertIs(ok, pipeline_ok)

    def test_graph_is_acyclic_and_all_dependencies_resolve_at_top_level(self):
        self.assertEqual(len(self.activities), len(self.properties["activities"]))
        graph = {}
        for name, activity in self.activities.items():
            graph[name] = {d["activity"] for d in activity["dependsOn"]}
            self.assertTrue(graph[name] <= self.activities.keys())
        order = list(TopologicalSorter(graph).static_order())
        for source in INPUTS:
            self.assertLess(order.index(source), order.index(PROCESSOR))

    def test_ingestion_branches_remain_parallel_and_optional_defaults_unchanged(self):
        for name, activity in self.activities.items():
            if name not in {PROCESSOR, FALLBACK}:
                self.assertEqual(activity["dependsOn"], [], name)
        self.assertEqual(
            {name: p["defaultValue"] for name, p in self.properties["parameters"].items()},
            {
                "EnableOrgDataPull": True,
                "EnableDataverse": False,
                "EnableConsumption": False,
                "EnableProductFeedback": False,
                "EnableAgent365": False,
            },
        )

    def test_readme_documents_all_placeholders_and_refresh_handoff(self):
        readme = (PIPELINES / "README.md").read_text(encoding="utf-8")
        for placeholder in set(re.findall(r"REPLACE_WITH_[A-Z_]+", json.dumps(self.definition))):
            self.assertIn(placeholder, readme)
        self.assertIn("Import the 4 notebooks", readme)
        self.assertIn("5 GUIDs total", readme)
        self.assertIn("Refresh the semantic model only after pipeline success", readme)


if __name__ == "__main__":
    unittest.main()
