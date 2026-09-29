"""Structural checks for the optional Consumption Central add-on folders."""
import json
import re
import unittest
import zipfile
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
ADDON = "Add Credit Consumption"
PBITS = {
    "1. Local CSV": "Consumption Central - Local CSV.pbit",
    "2. SharePoint": "Consumption Central - Viva Direct.pbit",
    "3. Fabric": "Consumption Central - Fabric.pbit",
    "4. Power Automate + Dataverse": "Consumption Central - Power Automate + Dataverse.pbit",
}
LINK = re.compile(r"\]\(([^)\s]+)\)")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
ALLOWED_DOMAINS = {"contoso-health.com"}


def addon_files(pattern):
    return sorted(p for path in PBITS for p in (ROOT / path / ADDON).rglob(pattern))


class CreditConsumptionAddon(unittest.TestCase):
    def test_each_path_has_readme_and_one_template(self):
        for path, name in PBITS.items():
            folder = ROOT / path / ADDON
            self.assertTrue((folder / "README.md").is_file(), path)
            self.assertEqual([p.name for p in folder.glob("*.pbit")], [name], path)

    def test_templates_are_valid_and_carry_no_real_addresses(self):
        for path, name in PBITS.items():
            with zipfile.ZipFile(ROOT / path / ADDON / name) as archive:
                self.assertIsNone(archive.testzip(), name)
                for member in ("DataModelSchema", "UnappliedChanges"):
                    text = archive.read(member).decode("utf-16-le")
                    json.loads(text.lstrip("\ufeff"))
                    domains = {m.group(1).lower() for m in EMAIL.finditer(text)}
                    self.assertLessEqual(domains, ALLOWED_DOMAINS, (name, member))

    def test_fabric_sample_seeder_points_at_shared_sample(self):
        source = (ROOT / "3. Fabric" / ADDON / "seed_sample_data.py").read_text(encoding="utf-8")
        self.assertIn('"..", "..", "1. Local CSV", "Add Credit Consumption", "sample-data"', source)
        self.assertTrue((ROOT / "1. Local CSV" / ADDON / "sample-data" / "README.md").is_file())

    def test_relative_links_resolve(self):
        for doc in addon_files("*.md") + addon_files("*.ipynb"):
            for target in LINK.findall(doc.read_text(encoding="utf-8")):
                if target.startswith(("http://", "https://", "#", "mailto:")):
                    continue
                resolved = (doc.parent / unquote(target.split("#")[0])).resolve()
                self.assertTrue(resolved.exists(), (str(doc.relative_to(ROOT)), target))


if __name__ == "__main__":
    unittest.main()
