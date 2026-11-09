import importlib.util
import json
import re
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
ROUTE = ROOT / "1. Fabric" / "Manual setup" / "Databricks"
NOTEBOOKS = ROUTE / "notebooks"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_module(
    "valuelens_databricks_runtime",
    NOTEBOOKS / "valuelens_databricks_runtime.py",
)
generator = load_module(
    "sync_databricks_notebooks",
    ROOT / "scripts" / "sync_databricks_notebooks.py",
)


class DatabricksRouteTests(unittest.TestCase):
    def test_all_sixteen_notebooks_are_generated_and_current(self):
        self.assertEqual(len(generator.NOTEBOOKS), 16)
        for relative in generator.NOTEBOOKS:
            with self.subTest(notebook=relative):
                source = generator.SOURCE / relative
                generated = NOTEBOOKS / Path(relative).name
                self.assertTrue(generated.is_file())
                self.assertEqual(
                    json.loads(generated.read_text(encoding="utf-8")),
                    generator.build_notebook(source),
                )

    def test_generated_cells_compile_and_use_the_route_runtime(self):
        notebooks = sorted(NOTEBOOKS.glob("*.ipynb"))
        self.assertEqual(len(notebooks), 16)
        for path in notebooks:
            notebook = json.loads(path.read_text(encoding="utf-8"))
            code = [
                "".join(cell.get("source", []))
                for cell in notebook["cells"]
                if cell["cell_type"] == "code"
            ]
            self.assertIn("from valuelens_databricks_runtime import initialize", code[0])
            for index, source in enumerate(code):
                with self.subTest(notebook=path.name, cell=index):
                    compile(source, f"{path.name}:cell{index}", "exec")
                    self.assertNotIn("notebookutils", source)
                    self.assertNotIn("sempy.fabric", source)
                    self.assertNotIn("VORDER", source)
                    self.assertNotIn("/lakehouse/default", source)
                    self.assertNotIn("dbo.", source)
                    self.assertNotIn("getSecret", source)
                    self.assertNotIn("dbutils.credentials", source)
                    self.assertIsNone(
                        re.search(r"CLIENT_SECRET\s*=\s*['\"]", source)
                    )

    def test_volume_path_adapter_maps_route_paths_and_rejects_abfss(self):
        class FakeFs:
            pass

        fs = runtime.VolumeFileSystem(
            type("FakeDbutils", (), {"fs": FakeFs()})(),
            "/Volumes/main/dbo/valuelens",
        )
        self.assertEqual(
            fs.path("Files/agents.csv"),
            "/Volumes/main/dbo/valuelens/agents.csv",
        )
        self.assertEqual(
            fs.path("/lakehouse/default/Files/staging"),
            "/Volumes/main/dbo/valuelens/staging",
        )
        self.assertEqual(
            fs.path("dbfs:/Volumes/main/dbo/valuelens/agents.csv"),
            "/Volumes/main/dbo/valuelens/agents.csv",
        )
        with self.assertRaises(ValueError):
            fs.path("abfss://container@storage.example/Files/agents.csv")

    def test_workflow_status_mapping_preserves_required_and_optional_semantics(self):
        normalize = runtime.normalize_task_status
        self.assertEqual(normalize("SUCCESS", None, required=True), "Succeeded")
        self.assertEqual(normalize("FAILED", None, required=False), "Failed")
        self.assertEqual(normalize("CANCELED", None, required=True), "Cancelled")
        self.assertEqual(normalize("SKIPPED", None, required=True), "Skipped")
        self.assertEqual(normalize("EXCLUDED", None, required=False), "Skipped")
        self.assertEqual(normalize("INTERNAL_ERROR", None, required=False), "Failed")
        self.assertEqual(normalize("", {"status": "Succeeded"}), "Succeeded")
        self.assertEqual(normalize("", {"status": "Running"}), "Failed")
        self.assertEqual(normalize("", None, required=True), "Failed")
        self.assertEqual(normalize("", None, required=False), "Skipped")

    def test_workflow_task_runs_preserve_aliases_and_attempt_metadata(self):
        runs = runtime.workflow_task_runs(
            labels={
                "Run_Agent365_API_Ingester": "Agent audit",
                "Run_Agent365_CSV_Fallback": "CSV audit",
                "Run_Audit_Log_Ingester": "Audit ingester",
                "Record_Load_Status": "Status",
            },
            result_states={
                "Run_Agent365_API_Ingester": "FAILED",
                "Run_Agent365_CSV_Fallback": "SUCCESS",
                "Run_Audit_Log_Ingester": "SUCCESS",
            },
            task_values={
                "Run_Agent365_Lander": {
                    "status": "Succeeded",
                    "attempts": 2,
                    "started_at": "2025-01-01T00:00:00+00:00",
                    "ended_at": "2025-01-01T00:00:03+00:00",
                    "duration_seconds": 3.25,
                }
            },
            required_tasks={"Run_Audit_Log_Ingester"},
            aliases={"Run_Agent365_CSV_Fallback": "Run_Agent365_Lander"},
        )

        self.assertEqual(runs["Run_Agent365_API_Ingester"]["status"], "Failed")
        self.assertIn("error", runs["Run_Agent365_API_Ingester"])
        self.assertEqual(runs["Run_Agent365_CSV_Fallback"]["status"], "Succeeded")
        self.assertEqual(runs["Run_Agent365_CSV_Fallback"]["attempts"], 2)
        self.assertEqual(runs["Run_Agent365_CSV_Fallback"]["durationInMs"], 3250)
        self.assertEqual(runs["Run_Audit_Log_Ingester"]["status"], "Succeeded")
        self.assertNotIn("Record_Load_Status", runs)

    def test_workflow_task_values_capture_attempts_and_runtime(self):
        class FakeWidgets:
            values = {
                "job_run_id": "12345",
                "task_key": "Run_Audit_Log_Ingester",
                "task_execution_count": "2",
            }

            def getAll(self):
                return self.values

            def get(self, name):
                return self.values[name]

            def text(self, name, default):
                self.values.setdefault(name, default)

        class FakeTaskValues:
            value = None

            def set(self, key, value):
                self.value = json.loads(value)

            def get(self, taskKey, key, default=None):
                return self.value if taskKey == "Run_Audit_Log_Ingester" else default

        task_values = FakeTaskValues()
        dbutils = type(
            "FakeDbutils",
            (),
            {
                "widgets": FakeWidgets(),
                "jobs": type("FakeJobs", (), {"taskValues": task_values})(),
            },
        )()
        instance = runtime.ValueLensDatabricksRuntime.__new__(
            runtime.ValueLensDatabricksRuntime
        )
        instance.dbutils = dbutils
        instance.started_at = datetime.now(timezone.utc)
        instance.record_task_start()
        self.assertEqual(task_values.value["status"], "Running")
        self.assertEqual(task_values.value["attempts"], 2)
        instance.record_task_success()
        self.assertEqual(task_values.value["status"], "Succeeded")
        self.assertEqual(task_values.value["attempts"], 2)
        self.assertTrue(task_values.value["ended_at"])

    def test_refresh_uses_secure_power_bi_credentials_without_fabric_endpoint_sync(self):
        path = NOTEBOOKS / "ValueLens_Refresh_Model.ipynb"
        notebook = json.loads(path.read_text(encoding="utf-8"))
        code = "\n".join(
            "".join(cell.get("source", []))
            for cell in notebook["cells"]
            if cell["cell_type"] == "code"
        )
        self.assertIn('VL.widget("pbi_workspace_id"', code)
        self.assertIn('VL.widget("pbi_semantic_model_id"', code)
        self.assertIn("CLIENT_SECRET = VL.secret()", code)
        self.assertIn("VL.powerbi_headers(TENANT_ID, CLIENT_ID, CLIENT_SECRET)", code)
        self.assertNotIn("sqlEndpoints", code)
        self.assertNotIn("getToken", code)

    def test_powerbi_headers_return_the_access_token_as_a_bearer_header(self):
        class FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {"access_token": "test-token"}

        calls = {}

        def fake_post(url, data, timeout):
            calls.update(url=url, data=data, timeout=timeout)
            return FakeResponse()

        requests = type("Requests", (), {"post": staticmethod(fake_post)})
        with patch.dict(sys.modules, {"requests": requests}):
            headers = runtime.ValueLensDatabricksRuntime.powerbi_headers(
                None,
                "tenant.example",
                "client-id",
                "client-secret",
            )

        self.assertEqual(headers, {"Authorization": "Bearer test-token"})
        self.assertEqual(calls["timeout"], 60)
        self.assertEqual(calls["data"]["grant_type"], "client_credentials")

    def test_load_status_excludes_unported_product_feeds_and_fabric_only_reasons(self):
        path = NOTEBOOKS / "AnalyticsHub_Load_Status.ipynb"
        notebook = json.loads(path.read_text(encoding="utf-8"))
        config = next(
            "".join(cell.get("source", []))
            for cell in notebook["cells"]
            if cell["cell_type"] == "code"
            and re.search(r"(?m)^[ \t]*STATUS_JSON[ \t]*=", "".join(cell.get("source", [])))
        )
        namespace = {}
        namespace["DB_SCHEMA"] = "dbo"
        exec(compile(config, str(path), "exec"), namespace)
        status = json.loads(namespace["STATUS_JSON"])
        labels = status["labels"]
        self.assertFalse(any("Consumption" in key for key in labels))
        self.assertFalse(any("Agent_Evaluator" in key for key in labels))
        self.assertNotIn("evaluator_status", [item["table"] for item in status["statusTables"]])
        self.assertFalse(any(item["kind"] == "notSynced" for item in status["reasons"]))


if __name__ == "__main__":
    unittest.main()
