"""Portable structural release checks for the three Power BI templates.

The Fabric templates and app live in Analytics Hub. With ANALYTICS_HUB_ROOT set (see analytics_hub.py),
the templates must ship the same report and measures as the Fabric template, and the app's task
descriptions and glossary. Desktop refresh and rendering still need live QA.
"""
import json
import re
import unittest
import zipfile
from pathlib import Path

import analytics_hub

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = (
    Path("5. Local CSV") / "ValueLens - Local CSV.pbit",
    Path("4. SharePoint") / "ValueLens - SharePoint.pbit",
    Path("3. Power Automate + Dataverse") / "ValueLens - Power Automate + Dataverse.pbit",
)
FABRIC_TEMPLATES = (
    analytics_hub.FABRIC / "ValueLens - Fabric.pbit",
    analytics_hub.FABRIC / "ValueLens - Fabric OneLake.pbit",
)
PAGE_COUNT = 16
# Separate Consumption Central report shipped as an optional add-on in each path.
ADDON = "Add Credit Consumption"
# Separate reports from other repositories, shipped as optional add-ons.
ADDONS = {ADDON, "Add Agent Evaluator"}
HIDDEN_PAGES = {"licenseprioritisation"}
VALUE_PAGE = "0a7ca92c179ad5909bba"
VALUE_TOGGLES = ("Time Saved", "Value Table")
# Behaviour toggles ship with working defaults; every connection or file parameter ships blank.
PARAMETER_DEFAULTS = {
    "Enable_ProductFeedback": '"Include"',
    "Enable_Agent365": '"Include"',
    "RangeStart": "#datetime(2025, 1, 1, 0, 0, 0)",
    "RangeEnd": "#datetime(2027, 1, 1, 0, 0, 0)",
    "Use SharePoint CSV fallback": "false",
}
# Machine-bound or pending-edit parts that a portable template must not carry.
FORBIDDEN_PARTS = ("DataModel", "SecurityBindings", "UnappliedChanges")
LOCAL_PATH = re.compile(r"[a-z]:\\{1,2}users\\{1,2}|onedrive - ", re.IGNORECASE)
# The Fabric App shows the same task descriptions as the Signal - Impact Table.
APP_TASK_DESCRIPTIONS = analytics_hub.APP / "src" / "queries" / "appendix" / "task-descriptions.json"
# The Fabric App adds these glossary entries when a model lacks them, so the templates carry them too.
APP_GLOSSARY = analytics_hub.APP / "src" / "queries" / "appendix" / "app-glossary.json"
M_STRING = re.compile(r'"((?:[^"]|"")*)"')
GLOSSARY_ORDERS = re.compile(r",(-?\d+),(-?\d+)\},?$")


def text(value):
    return "\n".join(value) if isinstance(value, list) else value


def field_refs(node, aliases=None):
    """Yield (kind, table, property) for every column and measure reference."""
    if isinstance(node, list):
        for child in node:
            yield from field_refs(child, aliases)
        return
    if not isinstance(node, dict):
        return
    aliases = dict(aliases or {})
    for source in node.get("From", []) if isinstance(node.get("From"), list) else []:
        if isinstance(source, dict) and "Name" in source and "Entity" in source:
            aliases[source["Name"]] = source["Entity"]
    for kind in ("Column", "Measure"):
        value = node.get(kind)
        if isinstance(value, dict) and "Property" in value:
            ref = value.get("Expression", {}).get("SourceRef", {})
            yield kind, ref.get("Entity") or aliases.get(ref.get("Source")), value["Property"]
    for child in node.values():
        yield from field_refs(child, aliases)


def load_template(relative):
    with zipfile.ZipFile(ROOT / relative) as archive:
        if archive.testzip() is not None:
            raise AssertionError(f"Corrupt archive: {relative}")
        members = {n: archive.read(n) for n in archive.namelist()}
    model = json.loads(members["DataModelSchema"].decode("utf-16-le"))["model"]
    docs = {n: json.loads(b) for n, b in members.items()
            if n.startswith("Report/definition/") and n.endswith(".json")}
    return str(relative), members, model, docs


def measures(model):
    return {(t["name"], m["name"]): (text(m["expression"]), m.get("formatString"))
            for t in model["tables"] for m in t.get("measures", [])}


def report(members):
    return {n: v for n, v in members.items() if n.startswith("Report/")}


class CoreTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.templates = [load_template(relative) for relative in TEMPLATES]

    def test_exactly_three_active_templates(self):
        active = {p.relative_to(ROOT) for p in ROOT.rglob("*.pbit")
                  if "archive" not in p.parts and not ADDONS & set(p.parts)}
        self.assertEqual(active, set(TEMPLATES))

    def test_portable_parts_only(self):
        for name, members, _, _ in self.templates:
            for part in FORBIDDEN_PARTS:
                self.assertNotIn(part, members, (name, part))

    def assert_same_report(self, others):
        baseline = report(self.templates[0][1])
        for name, members, _, _ in others:
            other = report(members)
            self.assertEqual(sorted(other), sorted(baseline), name)
            self.assertEqual([n for n in other if other[n] != baseline[n]], [], name)

    def assert_same_measures(self, others):
        baseline = measures(self.templates[0][2])
        self.assertGreater(len(baseline), 0)
        for name, _, model, _ in others:
            self.assertEqual(measures(model), baseline, name)

    def test_all_templates_ship_identical_report(self):
        self.assert_same_report(self.templates[1:])

    def test_all_templates_share_identical_measures(self):
        self.assert_same_measures(self.templates[1:])

    @analytics_hub.required
    def test_fabric_templates_ship_the_same_report_and_measures(self):
        fabric = [load_template(path) for path in FABRIC_TEMPLATES]
        self.assert_same_report(fabric)
        self.assert_same_measures(fabric)

    def test_report_field_references_resolve_in_every_model(self):
        for name, _, model, docs in self.templates:
            columns = {(t["name"], c["name"]) for t in model["tables"] for c in t.get("columns", [])}
            measures = {(t["name"], m["name"]) for t in model["tables"] for m in t.get("measures", [])}
            refs = {ref for doc in docs.values() for ref in field_refs(doc)}
            self.assertGreater(len(refs), 100, name)
            missing = sorted(
                (kind, str(table), prop) for kind, table, prop in refs
                if (table, prop) not in (measures if kind == "Measure" else columns)
            )
            self.assertEqual(missing, [], name)

    def test_neutral_parameter_bindings(self):
        for name, _, model, _ in self.templates:
            parameters = [e for e in model.get("expressions", []) if "IsParameterQuery" in text(e["expression"])]
            self.assertGreater(len(parameters), 0, name)
            for expression in parameters:
                value = text(expression["expression"]).split(" meta ")[0].strip()
                self.assertEqual(value, PARAMETER_DEFAULTS.get(expression["name"], "null"),
                                 (name, expression["name"]))

    def test_no_local_paths_or_personal_folders(self):
        for name, members, _, _ in self.templates:
            for part in ["DataModelSchema"] + [n for n in members if n.startswith("Report/definition/")]:
                payload = members[part]
                decoded = payload.decode("utf-16-le") if part == "DataModelSchema" else payload.decode("utf-8")
                self.assertIsNone(LOCAL_PATH.search(decoded), (name, part))

    def test_page_inventory(self):
        for name, _, _, docs in self.templates:
            pages = {d["name"]: d for n, d in docs.items() if n.endswith("/page.json")}
            order = docs["Report/definition/pages/pages.json"]
            self.assertEqual(len(pages), PAGE_COUNT, name)
            self.assertEqual(sorted(order["pageOrder"]), sorted(pages), name)
            hidden = {p for p, d in pages.items() if d.get("visibility") == "HiddenInViewMode"}
            self.assertEqual(hidden, HIDDEN_PAGES, name)
            self.assertIn(order["activePageName"], set(pages) - hidden, name)

    def test_bookmarks_are_indexed_and_reference_existing_pages(self):
        for name, _, _, docs in self.templates:
            pages = {d["name"] for n, d in docs.items() if n.endswith("/page.json")}
            files = {d["name"] for n, d in docs.items() if n.endswith(".bookmark.json")}
            listed = set()
            for item in docs["Report/definition/bookmarks/bookmarks.json"]["items"]:
                listed.update(item["children"] if "children" in item else [item["name"]])
            self.assertEqual(listed, files, name)
            for part, bookmark in docs.items():
                if not part.endswith(".bookmark.json"):
                    continue
                state = bookmark.get("explorationState", {})
                self.assertIn(state.get("activeSection"), pages, part)
                self.assertLessEqual(set(state.get("sections", {})), pages, part)

    def test_value_page_toggles_hide_only_existing_visuals(self):
        for name, _, _, docs in self.templates:
            visuals = {d["name"] for n, d in docs.items()
                       if f"/pages/{VALUE_PAGE}/visuals/" in n and n.endswith("/visual.json")}
            hidden = {}
            for bookmark in (d for n, d in docs.items() if n.endswith(".bookmark.json")):
                if bookmark.get("displayName") not in VALUE_TOGGLES:
                    continue
                self.assertNotIn(bookmark["displayName"], hidden, name)
                containers = bookmark["explorationState"]["sections"][VALUE_PAGE]["visualContainers"]
                hidden[bookmark["displayName"]] = {
                    v for v, c in containers.items()
                    if c.get("singleVisual", {}).get("display") == {"mode": "hidden"}
                }
            self.assertEqual(set(hidden), set(VALUE_TOGGLES), name)
            for toggle, names in hidden.items():
                self.assertTrue(names, (name, toggle))
                self.assertLessEqual(names, visuals, (name, toggle))
            self.assertNotEqual(hidden["Time Saved"], hidden["Value Table"], name)

    def test_field_parameter_spans(self):
        for _, _, _, docs in self.templates:
            for name, doc in docs.items():
                for role in doc.get("visual", {}).get("query", {}).get("queryState", {}).values():
                    count = len(role.get("projections", []))
                    for parameter in role.get("fieldParameters", []):
                        self.assertGreaterEqual(parameter["index"], 0, name)
                        self.assertGreaterEqual(parameter["length"], 0, name)
                        self.assertLessEqual(parameter["index"] + parameter["length"], count, name)

    @analytics_hub.required
    def test_task_descriptions_match_the_fabric_app(self):
        expected = list(json.loads(APP_TASK_DESCRIPTIONS.read_text(encoding="utf-8")).items())
        self.assertTrue(expected)
        for name, _, model, _ in self.templates:
            table = next(t for t in model["tables"] if t["name"] == "Behavior Value Map")
            self.assertIn("Description", [column["name"] for column in table["columns"]], name)
            rows = []
            for line in text(table["partitions"][0]["source"]["expression"]).splitlines():
                values = [value.replace('""', '"') for value in M_STRING.findall(line)]
                if len(values) == 5 and line.lstrip().startswith("{"):
                    rows.append(values)
            self.assertEqual(rows[0], ["Signal", "Behavior", "Use Case", "Value Outcome", "Description"], name)
            self.assertEqual([(row[1], row[4]) for row in rows[1:]], expected, name)

    @analytics_hub.required
    def test_app_host_glossary_matches_the_fabric_app(self):
        glossary = json.loads(APP_GLOSSARY.read_text(encoding="utf-8"))
        expected = [(entry["metric"], entry["description"]) for entry in glossary["entries"]]
        self.assertTrue(expected)
        for name, _, model, _ in self.templates:
            table = next(t for t in model["tables"] if t["name"].endswith("Metric Glossary"))
            rows = []
            for line in text(table["partitions"][0]["source"]["expression"]).splitlines():
                strings = [value.replace('""', '"') for value in M_STRING.findall(line)]
                orders = GLOSSARY_ORDERS.search(line.rstrip())
                if len(strings) == 4 and orders:
                    rows.append((*strings, int(orders[1]), int(orders[2])))
            page = sorted((row for row in rows if row[0] == glossary["page"]), key=lambda row: row[5])
            self.assertEqual({(row[1], row[4]) for row in page},
                             {(glossary["pageDescription"], glossary["pageOrder"])}, name)
            # The entries close the page, in the app's order and wording, as the app would add them.
            self.assertEqual([(row[2], row[3]) for row in page[-len(expected):]], expected, name)


if __name__ == "__main__":
    unittest.main()
