"""Guard model-fix preservation and the notebook distribution that blocked PR 37."""
import hashlib
import importlib.util
import json
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "1. Fabric" / "Manual setup"
CORE = SETUP / "notebooks"

# DataModelSchema bytes stay pinned (the templates ship no UnappliedChanges part);
# OneLake pins every field except its FabricTable helper, which is checked
# separately against its canonical source.
SCHEMA_HASHES = {
    "ValueLens - Fabric.pbit": {
        "DataModelSchema": "e0a6a12b9a0b8de46e4168b7fe86e069f3ac4a5281de7415940ff621ce8e7c8d",
    },
    "ValueLens - Fabric OneLake.pbit": {
        "DataModelSchema": "65a122306e4ef915ca5daecf853e9dfa36dd238ada75f287d5e4c176fa2bca79",
    },
}


class ConsolidatedReleaseTests(unittest.TestCase):
    def test_exactly_two_core_transport_templates(self):
        self.assertEqual(
            {path.name for path in SETUP.glob("*.pbit")},
            set(SCHEMA_HASHES),
        )
        self.assertFalse((SETUP / "ValueLens - Fabric (OneLake).pbit").exists())

    def test_previous_schema_fixes_preserved_without_model_rewrite(self):
        spec = importlib.util.spec_from_file_location(
            "onelake_packager", ROOT / "scripts" / "Update-OneLake-Template.py"
        )
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        for name, expected in SCHEMA_HASHES.items():
            with zipfile.ZipFile(SETUP / name) as archive:
                for member, sha in expected.items():
                    payload = archive.read(member)
                    if "OneLake" in name:
                        document = json.loads(payload.decode("utf-16-le"))
                        actual = packager.unrelated_hash(document, member)
                        record, field = packager.helper_record(document, member)
                        canonical = packager.SOURCE.read_text(encoding="utf-8").split("\n")
                        self.assertEqual(record[field], canonical, (name, member))
                    else:
                        actual = hashlib.sha256(payload).hexdigest()
                    self.assertEqual(actual, sha, (name, member))

    def test_consolidated_notebook_cells_compile(self):
        for name in (
            "Copilot_Agent365_Lander.ipynb",
            "Copilot_Agent365_Registry_Ingester.ipynb",
            "Copilot_Licensed_Users_Direct_Ingester.ipynb",
            "Copilot_M365_Activity_Ingester.ipynb",
            "ValueLens_Data_Check.ipynb",
        ):
            notebook = json.loads((CORE / name).read_text(encoding="utf-8"))
            self.assertEqual(notebook["nbformat"], 4)
            for index, cell in enumerate(notebook["cells"]):
                if cell["cell_type"] != "code":
                    continue
                code = cell["source"]
                code = "".join(code) if isinstance(code, list) else code
                compile(code, f"{name}:cell{index}", "exec")
                self.assertFalse(any(o.get("output_type") == "error" for o in cell.get("outputs", [])),
                                 (name, index))


if __name__ == "__main__":
    unittest.main()
