"""Portable contract tests; real Spark/Delta regression is generated separately."""
import ast
import json
import tempfile
import unittest
from pathlib import Path

from fabric_audit_passthrough import build

ROOT = Path(__file__).resolve().parents[1]
PROCESSOR = ROOT / "3. Fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"


def sources():
    return ["".join(c["source"]) for c in json.loads(PROCESSOR.read_text(encoding="utf-8"))["cells"]]


class AuditPassthroughTests(unittest.TestCase):
    def test_code_compiles_and_default_is_off(self):
        notebook = json.loads(PROCESSOR.read_text(encoding="utf-8"))
        for index, cell in enumerate(notebook["cells"]):
            if cell["cell_type"] == "code":
                ast.parse("".join(cell["source"]), filename=f"processor:{index}")
        config = {}
        exec(sources()[1], config)
        self.assertIs(config["INCLUDE_RAW_PASSTHROUGH"], False)

    def test_guard_checks_actual_alias_destinations(self):
        tree = ast.parse(sources()[2])
        nodes = [n for n in tree.body if
                 isinstance(n, ast.FunctionDef) and n.name == "validate_passthrough_columns"
                 or isinstance(n, ast.Assign) and any(
                     isinstance(t, ast.Name) and t.id == "RAW_PASSTHROUGH_COLUMNS"
                     for t in n.targets)]
        namespace = {}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "guard", "exec"), namespace)
        check = namespace["validate_passthrough_columns"]
        check(["Id", "AppIdentity", "Audit_UserId_Normalized"],
              ["Id", "AppIdentity_Raw", "Audit_UserId_Normalized"])
        for source, target in namespace["RAW_PASSTHROUGH_COLUMNS"].items():
            with self.subTest(source=source), self.assertRaisesRegex(RuntimeError, source):
                check([source], [source])
            check([source], [target])
        with self.assertRaisesRegex(RuntimeError, "TenantField"):
            check(["TenantField"], [])
        with self.assertRaisesRegex(RuntimeError, "Audit_UserId_Normalized"):
            check(["Audit_UserId_Normalized"], ["_NormUPN"])

    def test_guard_precedes_write_and_join_helper_stays_private(self):
        code = sources()
        self.assertLess(code[15].index("validate_passthrough_columns(passthrough_source_columns"),
                        code[15].index("write_strategy = write_curated_output(fact)"))
        self.assertIn('"__nkey_fact", "_NormUPN")', code[11])
        self.assertNotIn('withColumn("Audit_UserId_Norm"', "\n".join(code))
        self.assertIn("if not INCLUDE_RAW_PASSTHROUGH:", code[11])

    def test_canonical_parsers_remain_fixed_and_do_not_infer(self):
        current = sources()
        for index, fields in [(5, ["Type", "Action", "SiteUrl"]), (6, ["Id", "Name"])]:
            tree = ast.parse(current[index])
            parsed_fields = [n.args[0].value for n in ast.walk(tree)
                             if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                             and n.func.attr == "StructField"]
            self.assertEqual(parsed_fields, fields)
            self.assertNotIn("infer", current[index].lower())
        self.assertIn('F.explode_outer("_resources")', current[5])
        self.assertIn("as_arr.getItem(0)", current[6])

    def test_regression_notebook_embeds_verbatim_cells_and_fabric_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "verification.ipynb"
            run_id = build(output, baseline_ref="HEAD")
            notebook = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(notebook["metadata"]["language_info"]["name"], "python")
        code = "".join(notebook["cells"][0]["source"])
        tree = ast.parse(code)
        config = {}
        config_nodes = [node for node in tree.body if isinstance(node, (ast.Import, ast.Assign))]
        exec(compile(ast.Module(body=config_nodes, type_ignores=[]), "config", "exec"), config)
        self.assertEqual(config["RUN_ID"], run_id)
        current = json.loads(PROCESSOR.read_text(encoding="utf-8"))
        self.assertEqual(config["CANDIDATE"], current["cells"])
        self.assertIn('compare("missing_id"', code)


if __name__ == "__main__":
    unittest.main()
