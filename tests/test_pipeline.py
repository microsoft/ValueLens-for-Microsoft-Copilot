"""Offline checks for the published pipeline's processor dependency contract."""
import json
import re
import unittest
from graphlib import TopologicalSorter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPELINES = ROOT / "1. Fabric" / "Manual setup" / "pipelines"
PROCESSOR = "Run_Audit_Log_Processor"
AGENT365 = "Conditionally_Run_Agent365"
FALLBACK = "Run_Agent365_CSV_Fallback"
INPUTS = {
    "Run_Audit_Log_Ingester",
    "Run_Licensed_Users_Ingester",
    FALLBACK,
}
ORG = "Conditionally_Run_Org_Data"
M365 = "Conditionally_Run_M365_Activity"
FEEDBACK = "Conditionally_Run_Product_Feedback"
DEFENDER = "Conditionally_Run_Defender"
DATAVERSE = "Conditionally_Run_Dataverse_Transcripts"
# Lane 2 in run order: (step, the step it waits for, the outcomes it waits for).
LANE_2 = [
    (AGENT365, "Run_Licensed_Users_Ingester", ["Completed"]),
    (FALLBACK, AGENT365, ["Failed"]),
    (ORG, FALLBACK, ["Completed", "Skipped"]),
    (M365, ORG, ["Completed"]),
    (FEEDBACK, M365, ["Completed"]),
    (DEFENDER, FEEDBACK, ["Completed"]),
    (DATAVERSE, DEFENDER, ["Completed"]),
    ("Conditionally_Run_Credit_Consumption", DATAVERSE, ["Completed"]),
]


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
        self.assertEqual(processor["policy"]["retry"], 2)
        self.assertEqual(processor["policy"]["retryIntervalInSeconds"], 300)
        self.assertTrue(
            (ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb").is_file()
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
            self.assertTrue((ROOT / "1. Fabric" / "Manual setup" / "notebooks" / path).is_file(), path)

    def simulate(self, outcomes, enabled):
        """Apply Data Factory's documented dependency and leaf-status rules to the whole pipeline.

        `enabled` names the IfConditions that take their true branch. `Completed` matches a parent
        that succeeded or failed, so a step after a skipped one must also list `Skipped`.
        """
        parents = {n: [d["activity"] for d in a["dependsOn"]] for n, a in self.activities.items()}
        status = {}
        for name in TopologicalSorter(parents).static_order():
            activity = self.activities[name]
            if not all(self.met(d["dependencyConditions"], status[d["activity"]]) for d in activity["dependsOn"]):
                status[name] = "Skipped"
            elif activity["type"] == "IfCondition":
                branch = "ifTrueActivities" if name in enabled else "ifFalseActivities"
                inner = activity["typeProperties"][branch]
                status[name] = "Failed" if any(outcomes.get(a["name"]) == "Failed" for a in inner) else "Succeeded"
            else:
                status[name] = outcomes.get(name, "Succeeded")

        def evaluated(name):
            if status[name] != "Skipped":
                return status[name] == "Succeeded"
            return all(evaluated(p) for p in parents[name])

        leaves = [n for n in parents if not any(n in p for p in parents.values())]
        return status, all(evaluated(n) for n in leaves)

    @staticmethod
    def met(conditions, status):
        return status in conditions or ("Completed" in conditions and status in {"Succeeded", "Failed"})

    def test_agent365_fallback_scenarios_follow_try_catch_semantics(self):
        cases = {
            "disabled": ({}, set(), "Skipped", "Succeeded", True),
            "api succeeds": ({}, {AGENT365}, "Skipped", "Succeeded", True),
            "api fails, csv lands": (
                {"Run_Agent365_Registry_Ingester": "Failed"}, {AGENT365}, "Succeeded", "Succeeded", True,
            ),
            "api and csv fail": (
                {"Run_Agent365_Registry_Ingester": "Failed", FALLBACK: "Failed"}, {AGENT365}, "Failed", "Skipped",
                False,
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

    def test_loads_run_in_two_lanes_and_optional_defaults_unchanged(self):
        # Lane 1 is the audit log then the processor; lane 2 is one load after another, so a small
        # capacity never runs more than two notebooks at once.
        starts = {name for name, activity in self.activities.items() if not activity["dependsOn"]}
        self.assertEqual(starts, {"Run_Audit_Log_Ingester", "Run_Licensed_Users_Ingester"})
        self.assertEqual(self.activities.keys(), starts | {PROCESSOR} | {step for step, _, _ in LANE_2})
        for step, previous, conditions in LANE_2:
            self.assertEqual(
                self.activities[step]["dependsOn"], [{"activity": previous, "dependencyConditions": conditions}], step,
            )
        self.assertEqual(
            {name: p["defaultValue"] for name, p in self.properties["parameters"].items()},
            {
                "EnableOrgDataPull": True,
                "EnableM365Activity": False,
                "EnableDataverse": False,
                "EnableConsumption": False,
                "EnableProductFeedback": False,
                "EnableDefender": False,
                "EnableAgent365": False,
            },
        )

    def test_a_failed_optional_load_does_not_stop_the_rest_of_its_lane_or_the_processor(self):
        optional = [step for step, _, _ in LANE_2 if self.activities[step]["type"] == "IfCondition"]
        for index, step in enumerate(optional):
            inner = self.activities[step]["typeProperties"]["ifTrueActivities"][0]["name"]
            with self.subTest(step):
                status, _ = self.simulate({inner: "Failed"}, set(optional))
                self.assertEqual(status[step], "Failed")
                for later in optional[index + 1:]:
                    self.assertEqual(status[later], "Succeeded", later)
                self.assertEqual(status[PROCESSOR], "Succeeded")

    def test_readme_documents_all_placeholders_and_refresh_handoff(self):
        readme = (PIPELINES / "README.md").read_text(encoding="utf-8")
        for placeholder in set(re.findall(r"REPLACE_WITH_[A-Z_]+", json.dumps(self.definition))):
            self.assertIn(placeholder, readme)
        self.assertIn("Import the 4 notebooks", readme)
        self.assertIn("5 GUIDs total", readme)
        self.assertIn("Refresh the semantic model only after pipeline success", readme)


if __name__ == "__main__":
    unittest.main()
