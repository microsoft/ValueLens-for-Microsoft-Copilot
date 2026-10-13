"""Portable mode/schema guards; run generated Fabric checks for real Delta coverage."""
import ast
import json
import math
import re
import tempfile
import types
import unittest
import uuid
from pathlib import Path

from fabric_workday_enrichment import SOURCE, build


def namespace():
    cells = json.loads(SOURCE.read_text(encoding="utf-8"))["cells"]
    code = ["".join(c["source"]) for c in cells if c["cell_type"] == "code"]
    scope = {"math": math, "re": re, "uuid": uuid}
    exec(code[0], scope)
    tree = ast.parse(code[1])
    nodes = [node for node in tree.body if isinstance(node, (ast.Assign, ast.FunctionDef))]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "workday_helpers", "exec"), scope)
    return scope


class WorkdayEnrichmentTests(unittest.TestCase):
    def test_notebook_is_clean_and_compiles(self):
        notebook = json.loads(SOURCE.read_text(encoding="utf-8"))
        self.assertEqual(set(notebook["metadata"]), {"kernelspec", "language_info"})
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                ast.parse("".join(cell["source"]))
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])

    def test_defaults_require_deliberate_publication(self):
        scope = namespace()
        self.assertEqual(scope["MODE"], "auto")
        self.assertEqual(scope["OUTPUT_TABLE"], "dbo.copilot_org_data_workday_preview")
        self.assertEqual(scope["MIN_WORKDAY_MATCH_RATE"], 0.5)
        self.assertIs(scope["ALLOW_BASE_OVERWRITE"], False)
        scope["_validate_config"]()
        scope["OUTPUT_TABLE"] = scope["BASE_TABLE"].upper()
        with self.assertRaisesRegex(ValueError, "ALLOW_BASE_OVERWRITE"):
            scope["_validate_config"]()
        scope["ALLOW_BASE_OVERWRITE"] = True
        scope["_validate_config"]()

    def test_config_rejects_unsafe_identifiers_and_population_change(self):
        for setting, value in [
            ("MODE", "guess"), ("INCLUDE_UNMATCHED_WORKDAY", True),
            ("MIN_WORKDAY_MATCH_RATE", float("nan")), ("MIN_WORKDAY_MATCH_RATE", True),
            ("MIN_WORKDAY_MATCH_RATE", -0.1), ("MIN_WORKDAY_MATCH_RATE", 1.1),
            ("BASE_TABLE", "dbo.foo;DROP TABLE bar"), ("WORKDAY_EMAIL_COLUMN", ""),
        ]:
            with self.subTest(setting=setting, value=value):
                scope = namespace()
                scope[setting] = value
                with self.assertRaises(ValueError):
                    scope["_validate_config"]()

    def test_normalization_and_reserved_names(self):
        scope = namespace()
        self.assertEqual(scope["_safe_name"]("Job Family"), "Job_Family")
        self.assertEqual(scope["_norm"]("Job Family"), scope["_norm"]("job_family"))
        for names, workday in [
            (["Country", "country"], False),
            (["Job Family", "Job_Family"], True),
            (["_vlwd_base_key"], False),
            (["_wd_join"], True),
            (["   "], True),
        ]:
            with self.subTest(names=names), self.assertRaises(ValueError):
                scope["_validate_names"](names, workday=workday)
        scope["_validate_names"](["PersonId", "JobTitle", "Persona"])

    def test_auto_falls_back_only_on_absence(self):
        scope = namespace()
        scope["land_standalone"] = lambda wd: ("standalone", wd)
        scope["enrich_additive"] = lambda base, wd: ("enriched", {})
        scope["spark"] = types.SimpleNamespace(
            catalog=types.SimpleNamespace(tableExists=lambda name: False))
        self.assertEqual(scope["prepare_org_snapshot"]("fixture"), ("standalone", "fixture"))
        scope["spark"].catalog.tableExists = lambda name: True
        scope["spark"].table = lambda name: "base"
        self.assertEqual(scope["prepare_org_snapshot"]("fixture"), ("enriched", {"mode": "enrich"}))

        def denied(name):
            raise PermissionError("Catalog unavailable")

        scope["spark"].catalog.tableExists = denied
        with self.assertRaises(PermissionError):
            scope["prepare_org_snapshot"]("fixture")

    def test_invalid_existing_baseline_never_becomes_standalone(self):
        scope = namespace()
        scope["spark"] = types.SimpleNamespace(
            catalog=types.SimpleNamespace(tableExists=lambda name: True),
            table=lambda name: "invalid",
        )

        def invalid(base, wd):
            raise ValueError("Baseline must have a PersonId column.")

        scope["enrich_additive"] = invalid
        scope["land_standalone"] = lambda wd: self.fail("Unexpected standalone fallback")
        with self.assertRaisesRegex(ValueError, "PersonId"):
            scope["prepare_org_snapshot"]("fixture")

    def test_standalone_does_not_read_baseline(self):
        scope = namespace()
        scope["MODE"] = "standalone"
        scope["spark"] = None
        scope["land_standalone"] = lambda wd: ("standalone", wd)
        self.assertEqual(scope["prepare_org_snapshot"]("fixture"), ("standalone", "fixture"))

    def test_enrich_requires_existing_baseline(self):
        scope = namespace()
        scope["MODE"] = "enrich"
        scope["spark"] = types.SimpleNamespace(
            catalog=types.SimpleNamespace(tableExists=lambda name: False))
        with self.assertRaisesRegex(ValueError, "missing"):
            scope["prepare_org_snapshot"]("fixture")

    def test_fabric_generator_embeds_exact_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "verification.ipynb"
            run_id = build(output)
            generated = json.loads(output.read_text(encoding="utf-8"))
        source = "".join(generated["cells"][0]["source"])
        tree = ast.parse(source)
        setup = [node for node in tree.body if isinstance(node, (ast.Assign, ast.Import))]
        scope = {}
        exec(compile(ast.Module(body=setup, type_ignores=[]), "generated", "exec"), scope)
        self.assertEqual(scope["RUN_ID"], run_id)
        self.assertEqual(scope["NOTEBOOK"], json.loads(SOURCE.read_text(encoding="utf-8")))
        self.assertIn('report["production_versions_unchanged"]', source)
        self.assertIn('"same_table_rerun"', source)


if __name__ == "__main__":
    unittest.main()
