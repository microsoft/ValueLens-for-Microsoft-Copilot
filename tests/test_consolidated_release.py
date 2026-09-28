"""Guard model-fix preservation and the notebook distribution that blocked PR 37."""
import hashlib
import importlib.util
import json
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "3. Fabric" / "notebooks"
MIRRORS = (
    ROOT / "3. Fabric" / "archive" / "extended" / "Fabric + Copilot Studio" / "notebooks" / "_core",
)

# DataModelSchema bytes stay pinned (the templates ship no UnappliedChanges part);
# OneLake pins every field except its FabricTable helper, which is checked
# separately against its canonical source.
SCHEMA_HASHES = {
    "ValueLens - Fabric.pbit": {
        "DataModelSchema": "9df69db21b8c3b68052f9388c0ded9285dbdb835cf3891c68dbe8f118e09c670",
    },
    "ValueLens - Fabric OneLake.pbit": {
        "DataModelSchema": "8495e8b84dd1a28d0e4aef0c7a782d136444750c12c041b9b6a2a32cafee5d76",
    },
}


class ConsolidatedReleaseTests(unittest.TestCase):
    def test_exactly_two_core_transport_templates(self):
        self.assertEqual(
            {path.name for path in (ROOT / "3. Fabric").glob("*.pbit")},
            set(SCHEMA_HASHES),
        )
        self.assertFalse((ROOT / "3. Fabric" / "ValueLens - Fabric (OneLake).pbit").exists())

    def test_previous_schema_fixes_preserved_without_model_rewrite(self):
        spec = importlib.util.spec_from_file_location(
            "onelake_packager", ROOT / "scripts" / "Update-OneLake-Template.py"
        )
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        for name, expected in SCHEMA_HASHES.items():
            with zipfile.ZipFile(ROOT / "3. Fabric" / name) as archive:
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

    def test_all_shared_notebooks_match_canonical_bytes(self):
        sources = [p for p in CORE.glob("*.ipynb") if p.name != "Copilot_Audit_Log_Processor.ipynb"]
        self.assertEqual(len(sources), 7)
        for source in sources:
            for folder in MIRRORS:
                self.assertTrue((folder / source.name).is_file(), (folder, source.name))
                self.assertEqual(source.read_bytes(), (folder / source.name).read_bytes(), (folder, source.name))

    def test_consolidated_notebook_cells_compile(self):
        for name in (
            "Copilot_Agent365_Lander.ipynb",
            "Copilot_Agent365_Registry_Ingester.ipynb",
            "Copilot_Licensed_Users_Direct_Ingester.ipynb",
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
