"""Checks that the org query renames Department to Organization only when there's no Organization column."""
import importlib.util
import json
import unittest
import zipfile
from pathlib import Path

from m_eval import MError, evaluate

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "Update-Org-Department-Rename.py"
QUERY = "Chat + Agent Org Data"
UNGUARDED = "        if colDepartment <> null then"


def load_script():
    spec = importlib.util.spec_from_file_location("update_org_department_rename", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def org_queries(path):
    """The org query in DataModelSchema and, when the template has one, in UnappliedChanges."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))["model"]
        pending = (json.loads(archive.read("UnappliedChanges").decode("utf-16-le").lstrip("\ufeff"))
                   if "UnappliedChanges" in names else None)
    table = next(t for t in model["tables"] if t["name"] == QUERY)
    found = {"DataModelSchema": joined(table["partitions"][0]["source"]["expression"])}
    if pending is not None:
        found["UnappliedChanges"] = joined(next(q for q in pending["queries"] if q["name"] == QUERY)["text"])
    return found


class Table:
    """Just enough of an M table for the rename: column names and positional rows."""

    def __init__(self, columns, rows=()):
        self.columns, self.rows = list(columns), [list(row) for row in rows]


IGNORE = object()


def rename_columns(table, renames, missing=None):
    """Table.RenameColumns. As in Power Query, renaming onto a column that exists is an error."""
    columns = list(table.columns)
    for old, new in renames:
        if old not in columns:
            if missing is IGNORE:
                continue
            raise MError(f"The column '{old}' of the table wasn't found.")
        if new != old and new in columns:
            raise MError(f"The field '{new}' already exists in the record.")
        columns[columns.index(old)] = new
    return Table(columns, table.rows)


TABLE_FUNCTIONS = {
    "Table.ColumnNames": lambda table: list(table.columns),
    "Table.HasColumns": lambda table, names: all(
        name in table.columns for name in ([names] if isinstance(names, str) else names)),
    "Table.RenameColumns": rename_columns,
    "MissingField.Ignore": IGNORE,
}


def between(text, start, end):
    i = text.index(start)
    return text[i:text.index(end, i)]


def renamed(query, table):
    """Run the query's Normalize, colDepartment and RenamedColumns steps on a table."""
    normalize = between(query, "    Normalize = ", "\n\n    ColumnNames =").rstrip().rstrip(",")
    rename = between(query, "    // Find Department variant column name", "\n\n    // Normalize *values* for joins")
    source = f"let\n{normalize},\n{rename.rstrip().rstrip(',')}\nin\n    RenamedColumns"
    return evaluate(source, {**TABLE_FUNCTIONS, "RenamedPersonId": table})


class OrgDepartmentRename(unittest.TestCase):
    def test_templates_are_current(self):
        script = load_script()
        for relative in script.TEMPLATES:
            original = (ROOT / relative).read_bytes()
            rebuilt, changed = script.build(original)
            self.assertEqual(changed, [], f"{relative} is stale: run scripts/Update-Org-Department-Rename.py")
            self.assertEqual(rebuilt, original, relative)

    def test_every_copy_of_the_query_has_the_guard(self):
        script = load_script()
        for relative in script.TEMPLATES:
            copies = org_queries(ROOT / relative)
            for member, text in copies.items():
                self.assertEqual(text.count(script.NEW), 1, (relative, member))
                self.assertNotIn(UNGUARDED, text, (relative, member))
            self.assertEqual(len(set(copies.values())), 1, f"{relative}: UnappliedChanges differs from the model")

    def test_the_script_covers_every_template_with_the_rename(self):
        script = load_script()
        covered = {ROOT / relative for relative in script.TEMPLATES}
        for path in sorted(ROOT.rglob("*.pbit")):
            parts = path.relative_to(ROOT).parts
            if "archive" in parts or "node_modules" in parts or parts[0].startswith("."):
                continue
            with zipfile.ZipFile(path) as archive:
                schema = archive.read("DataModelSchema").decode("utf-16-le")
            self.assertEqual("colDepartment" in schema, path in covered, path.relative_to(ROOT))

    def test_department_is_renamed_only_when_organization_is_missing(self):
        script = load_script()
        rows = [["ada@example.com", "Finance", "Payroll"], ["sam@example.com", None, "Sales"]]
        for relative in script.TEMPLATES:
            for member, query in org_queries(ROOT / relative).items():
                label = (relative, member)
                for columns, expected in (
                    (["PersonId", "Department"], ["PersonId", "Organization"]),
                    (["PersonId", "department"], ["PersonId", "Organization"]),
                    (["PersonId", "Organization"], ["PersonId", "Organization"]),
                    (["PersonId"], ["PersonId"]),
                ):
                    self.assertEqual(renamed(query, Table(columns)).columns, expected, (label, columns))
                # Both columns, as when a Workday export adds Department: nothing is renamed, and a
                # blank Organization stays blank rather than being filled from Department.
                both = renamed(query, Table(["PersonId", "Organization", "Department"], rows))
                self.assertEqual(both.columns, ["PersonId", "Organization", "Department"], label)
                self.assertEqual(both.rows, rows, label)

    def test_the_unguarded_rename_failed_when_both_columns_exist(self):
        script = load_script()
        query = org_queries(ROOT / script.TEMPLATES[0])["DataModelSchema"].replace(script.NEW, script.OLD)
        with self.assertRaisesRegex(MError, "'Organization' already exists"):
            renamed(query, Table(["PersonId", "Organization", "Department"]))


if __name__ == "__main__":
    unittest.main()
