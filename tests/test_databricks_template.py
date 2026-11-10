"""Guard the generated Databricks template against drift from the Fabric report and model."""
import importlib.util
import io
import json
import re
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "databricks_template", ROOT / "scripts" / "Build-Databricks-Template.py"
)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def model(template_bytes):
    _, payloads, _ = BUILDER.read_archive(template_bytes)
    return BUILDER.decode(payloads["DataModelSchema"])["model"]


def expression_text(record):
    value = record["expression"]
    return "\n".join(value) if isinstance(value, list) else value


class DatabricksTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = BUILDER.SOURCE_TEMPLATE.read_bytes()
        cls.template = BUILDER.TEMPLATE.read_bytes()
        cls.fabric = model(cls.source)
        cls.databricks = model(cls.template)

    def test_committed_template_matches_the_builder(self):
        rebuilt = BUILDER.build_template(self.source, BUILDER.HELPER.read_bytes())
        self.assertEqual(rebuilt, self.template,
                         "run python scripts/Build-Databricks-Template.py")
        BUILDER.validate_rebuild(self.source, rebuilt)

    def test_report_and_model_match_the_fabric_template(self):
        _, before, _ = BUILDER.read_archive(self.source)
        _, after, _ = BUILDER.read_archive(self.template)
        self.assertEqual(list(before), list(after))
        for member in before:
            if member.startswith("Report/") or member in ("DiagramLayout", "Settings", "Version"):
                self.assertEqual(before[member], after[member], member)
        for key in ("tables", "relationships", "cultures"):
            self.assertEqual(self.fabric.get(key), self.databricks.get(key), key)
        self.assertEqual(BUILDER.source_neutral(self.fabric), BUILDER.source_neutral(self.databricks))
        measures = sum(len(table.get("measures", [])) for table in self.databricks["tables"])
        self.assertEqual((len(self.databricks["tables"]), measures,
                          len(self.databricks["relationships"])), (19, 202, 7))

    def test_source_is_parameterized_databricks_without_credentials(self):
        expressions = {record["name"]: record for record in self.databricks["expressions"]}
        for name, *_ in BUILDER.PARAMETERS:
            self.assertIn("IsParameterQuery=true", expression_text(expressions[name]))
            self.assertTrue(expressions[name].get("description"))
        for name in BUILDER.FABRIC_PARAMETERS:
            self.assertNotIn(name, expressions)
        helper = expression_text(expressions["FabricTable"])
        self.assertEqual(helper.count("Databricks.Catalogs("), 1)
        text = json.dumps(self.databricks, ensure_ascii=False)
        self.assertNotIn("Sql.Database(", text)
        m_code = "\n".join(expression_text(record) for record in self.databricks["expressions"])
        self.assertIsNone(re.search(r"(?i)dapi[0-9a-f]{8}|password|access_?token|bearer ", m_code))
        self.assertIn('"main"', expression_text(expressions["Databricks Catalog"]))
        self.assertTrue(expression_text(expressions["Databricks Server Hostname"]).startswith("null "))

    def test_validation_rejects_unrelated_changes(self):
        infos, payloads, comment = BUILDER.read_archive(self.template)
        document = BUILDER.decode(payloads["DataModelSchema"])
        document["model"]["tables"][0]["measures"][0]["expression"] = "1"
        payloads["DataModelSchema"] = BUILDER.dump(document)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.comment = comment
            for info in infos:
                archive.writestr(info, payloads[info.filename])
        with self.assertRaisesRegex(ValueError, "unrelated model fields"):
            BUILDER.validate_rebuild(self.source, output.getvalue())

    def test_pbip_export_carries_the_same_model_and_report(self):
        _, payloads, _ = BUILDER.read_archive(self.template)
        with tempfile.TemporaryDirectory() as directory:
            pbip = BUILDER.write_pbip(self.template, directory)
            root = Path(directory)
            self.assertTrue(pbip.exists())
            bim = json.loads((root / f"{BUILDER.NAME}.SemanticModel" / "model.bim")
                             .read_text(encoding="utf-8"))
            self.assertEqual(bim, BUILDER.decode(payloads["DataModelSchema"]))
            pbir = json.loads((root / f"{BUILDER.NAME}.Report" / "definition.pbir")
                              .read_text(encoding="utf-8"))
            self.assertEqual(pbir["datasetReference"]["byPath"]["path"],
                             f"../{BUILDER.NAME}.SemanticModel")
            for member, payload in payloads.items():
                if member.startswith("Report/"):
                    path = root / f"{BUILDER.NAME}.Report" / member[len("Report/"):]
                    self.assertEqual(path.read_bytes(), payload, member)

    def test_pbip_export_refuses_nonempty_unowned_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / ".gitignore"
            existing.write_text("important\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "non-empty"):
                BUILDER.write_pbip(self.template, directory)
            self.assertEqual(existing.read_text(encoding="utf-8"), "important\n")
            self.assertFalse((root / f"{BUILDER.NAME}.pbip").exists())

    def test_pbip_export_refuses_unexpected_project_files_without_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = BUILDER.write_pbip(self.template, directory)
            project.write_text("outdated", encoding="utf-8")
            extra = root / f"{BUILDER.NAME}.Report" / "notes.txt"
            extra.write_text("keep this", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unexpected file"):
                BUILDER.write_pbip(self.template, directory)
            self.assertEqual(extra.read_text(encoding="utf-8"), "keep this")
            self.assertEqual(project.read_text(encoding="utf-8"), "outdated")

    def test_pbip_export_preserves_user_gitignore_and_desktop_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = BUILDER.write_pbip(self.template, directory)
            cache = root / f"{BUILDER.NAME}.Report" / ".pbi" / "localSettings.json"
            cache.parent.mkdir()
            cache.write_text("local settings", encoding="utf-8")
            project.write_text("outdated", encoding="utf-8")
            BUILDER.write_pbip(self.template, directory)
            self.assertEqual(cache.read_text(encoding="utf-8"), "local settings")
            self.assertEqual(project.read_bytes(), BUILDER.pbip_files(self.template)[f"{BUILDER.NAME}.pbip"])
            ignore = root / ".gitignore"
            ignore.write_text("custom rules\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "gitignore was modified"):
                BUILDER.write_pbip(self.template, directory)
            self.assertEqual(ignore.read_text(encoding="utf-8"), "custom rules\n")

    def test_committed_pbip_project_matches_the_template(self):
        committed = BUILDER.existing_pbip(BUILDER.PBIP_DIR)
        self.assertEqual(committed, BUILDER.pbip_files(self.template),
                         "run python scripts/Build-Databricks-Template.py")
        name = BUILDER.NAME
        for part in (f"{name}.pbip", f"{name}.SemanticModel/model.bim",
                     f"{name}.SemanticModel/definition.pbism", f"{name}.Report/definition.pbir",
                     f"{name}.Report/definition/report.json", f"{name}.Report/definition/version.json"):
            self.assertIn(part, committed)
        project = json.loads(committed[f"{name}.pbip"])
        self.assertEqual(project["artifacts"], [{"report": {"path": f"{name}.Report"}}])


if __name__ == "__main__":
    unittest.main()
