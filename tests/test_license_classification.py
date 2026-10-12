"""Copilot licence flags in the templates and the Local CSV processor.

The Analytics Hub licensed-users notebook owns the Assigned Products classifier and its tests. The
templates read the supplied flags; with ANALYTICS_HUB_ROOT set (see analytics_hub.py) the Local CSV
processor is checked against the notebook's output. Never authenticates or writes Delta.
"""
import ast
import contextlib
import functools
import io
import json
import re
import unittest
import zipfile
from pathlib import Path

import analytics_hub

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = analytics_hub.NOTEBOOKS / "Copilot_Licensed_Users_Direct_Ingester.ipynb"
TEMPLATES = (
    Path("5. Local CSV") / "ValueLens - Local CSV.pbit",
    Path("4. SharePoint") / "ValueLens - SharePoint.pbit",
    Path("3. Power Automate + Dataverse") / "ValueLens - Power Automate + Dataverse.pbit",
)


def cells(path):
    return ["".join(c["source"]) for c in json.loads(path.read_text(encoding="utf-8"))["cells"]]


def classify(products):
    code = cells(NOTEBOOK)
    namespace = {}
    exec(compile(code[2], f"{NOTEBOOK}:config", "exec"), namespace)
    namespace["rows"] = [{"Assigned Products": value} for value in products]
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(code[8], f"{NOTEBOOK}:classifier", "exec"), namespace)
    return namespace, output.getvalue()


class LicenseClassificationTests(unittest.TestCase):
    def test_active_pbits_consume_flags_not_assigned_product_classifiers(self):
        for relative in TEMPLATES:
            with self.subTest(template=str(relative)), zipfile.ZipFile(ROOT / relative) as archive:
                self.assertIsNone(archive.testzip())
                model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]
                table = next(t for t in model["tables"] if t["name"] == "Copilot Licensed")
                expression = table["partitions"][0]["source"]["expression"]
                expression = "\n".join(expression) if isinstance(expression, list) else expression
                # The lean pass drops unused export columns by name; dropping is not classifying.
                read = re.sub(r"Table\.RemoveColumns\([^{]*\{[^}]*\}", "", expression)
                self.assertNotIn("Assigned Products", read)
                self.assertNotIn("Assigned_Products", read)
                self.assertIn('"Has license"', expression)
                self.assertIn('#"Org Data File"', expression)
                self.assertIn("Csv.Document", expression)

    @analytics_hub.required
    def test_supplied_flags_feed_optional_processor_without_sku_inference(self):
        path = ROOT / "5. Local CSV" / "scripts" / "Purview_CopilotInteraction_Processor_v4.0.0.py"
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        nodes = [
            node for node in tree.body
            if (isinstance(node, ast.FunctionDef) and node.name == "compute_license_status")
            or (isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "_LICENSE_TRUTHY" for target in node.targets))
        ]
        namespace = {"functools": functools}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)
        flags, _ = classify(["Microsoft 365 E7", "Microsoft 365 E5"])
        status = namespace["compute_license_status"]
        self.assertEqual([status(row["HasCopilot"]) for row in flags["rows"]],
                         ["M365 Copilot Licensed", "Unlicensed"])
        self.assertEqual(status("Microsoft 365 E7"), "Unlicensed")


if __name__ == "__main__":
    unittest.main()
