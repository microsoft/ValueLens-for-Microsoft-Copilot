"""Guard model-fix preservation and the notebook distribution that blocked PR 37."""
import hashlib
import importlib.util
import json
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "1. Fabric" / "notebooks"
MIRRORS = (
    ROOT / "1. Fabric" / "archive" / "extended" / "Fabric + Copilot Studio" / "notebooks" / "_core",
)

# DataModelSchema bytes stay pinned (the templates ship no UnappliedChanges part);
# OneLake pins every field except its FabricTable helper, which is checked
# separately against its canonical source.
SCHEMA_HASHES = {
    "ValueLens - Fabric.pbit": {
        "DataModelSchema": "38b89fa9af8d991c512368f053c660d24c0038d0bbea5d5b0ccf6308dcb5219f",
    },
    "ValueLens - Fabric OneLake.pbit": {
        "DataModelSchema": "10d01fc18ae8c66051b43ad5bacbf732bcbd22edfdba4f723c2ddc01fa496223",
    },
}


class ConsolidatedReleaseTests(unittest.TestCase):
    def test_exactly_two_core_transport_templates(self):
        self.assertEqual(
            {path.name for path in (ROOT / "1. Fabric").glob("*.pbit")},
            set(SCHEMA_HASHES),
        )
        self.assertFalse((ROOT / "1. Fabric" / "ValueLens - Fabric (OneLake).pbit").exists())

    def test_previous_schema_fixes_preserved_without_model_rewrite(self):
        spec = importlib.util.spec_from_file_location(
            "onelake_packager", ROOT / "scripts" / "Update-OneLake-Template.py"
        )
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        for name, expected in SCHEMA_HASHES.items():
            with zipfile.ZipFile(ROOT / "1. Fabric" / name) as archive:
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
        unmirrored = {
            "Copilot_Audit_Log_Processor.ipynb",
            "Copilot_M365_Activity_Ingester.ipynb",
            "ValueLens_Refresh_Model.ipynb",
        }
        sources = [p for p in CORE.glob("*.ipynb") if p.name not in unmirrored]
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
