"""Every sort-by-column in a DATATABLE-backed table of the shipped templates has one sort key
per value.

The engine refuses to sort a column by another when one value has several sort keys: "Cannot
order 'Metric Glossary'[Metric] by [MetricOrder] because at least one value in [Metric] has
multiple distinct values in [MetricOrder]". The refresh reports that only as a warning, and the
installer fails on refresh warnings. Text is compared case-insensitively, as the engine does.
Fix the Metric Glossary with scripts/Update-Glossary-Sort-Order.py.
"""
import importlib.util
import json
import re
import unittest
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("glossary_sort", ROOT / "scripts" / "Update-Glossary-Sort-Order.py")
GLOSSARY_SCRIPT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GLOSSARY_SCRIPT)

TOKEN = re.compile(
    r'(?P<skip>\s+|//[^\n]*|--[^\n]*|/\*.*?\*/)|(?P<string>"(?:[^"]|"")*")'
    r'|(?P<number>[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(?P<word>[A-Za-z_]\w*)|(?P<punct>[(){},])',
    re.DOTALL,
)


def tokens(text):
    found, offset = [], 0
    while offset < len(text):
        match = TOKEN.match(text, offset)
        if match is None:
            raise ValueError(f"cannot read DATATABLE at {text[offset:offset + 40]!r}")
        if match.lastgroup != "skip":
            found.append((match.lastgroup, match.group()))
        offset = match.end()
    return found


def parse_datatable(expression):
    """(column names, rows) of a DATATABLE expression, or None when it is not one. Values are
    strings, numbers, or the text of a constant such as TRUE or BLANK()."""
    text = "\n".join(expression) if isinstance(expression, list) else str(expression or "")
    if not re.match(r"(?:\s+|//[^\n]*|--[^\n]*|/\*.*?\*/)*DATATABLE\s*\(", text, re.IGNORECASE | re.DOTALL):
        return None
    stream = tokens(text)
    position = 2

    def take(kind=None, value=None):
        nonlocal position
        if position >= len(stream):
            raise ValueError("DATATABLE ends early")
        token = stream[position]
        if (kind and token[0] != kind) or (value and token[1] != value):
            raise ValueError(f"expected {value or kind}, got {token[1]!r}")
        position += 1
        return token

    def constant():
        kind, raw = take()
        if kind == "string":
            return raw[1:-1].replace('""', '"')
        if kind == "number":
            number = float(raw)
            return int(number) if number.is_integer() else number
        if kind != "word":
            raise ValueError(f"expected a value, got {raw!r}")
        if position < len(stream) and stream[position][1] == "(":
            depth = 0
            while True:
                _, part = take()
                raw += part
                depth += {"(": 1, ")": -1}.get(part, 0)
                if depth == 0:
                    break
        return raw.upper()

    columns = []
    while stream[position][1] != "{":
        columns.append(constant())
        take("punct", ",")
        take("word")
        take("punct", ",")
    take("punct", "{")
    rows = []
    while True:
        take("punct", "{")
        row = [constant()]
        while stream[position][1] == ",":
            take()
            row.append(constant())
        take("punct", "}")
        if len(row) != len(columns):
            raise ValueError(f"row {len(rows) + 1} has {len(row)} values for {len(columns)} columns")
        rows.append(row)
        if take("punct")[1] == "}":
            break
    take("punct", ")")
    if position != len(stream):
        raise ValueError("unexpected DAX after DATATABLE")
    return columns, rows


def sort_conflicts(table):
    """'Column by SortColumn: value -> [keys]' for each value with more than one sort key."""
    partitions = table.get("partitions") or []
    source = partitions[0].get("source", {}) if partitions else {}
    if source.get("type") != "calculated":
        return None
    parsed = parse_datatable(source.get("expression"))
    if parsed is None:
        return None
    columns, rows = parsed
    problems = []
    for column in table.get("columns", []):
        by = column.get("sortByColumn")
        if not by:
            continue
        label, key = columns.index(column["name"]), columns.index(by)
        keys = defaultdict(set)
        for row in rows:
            value = row[label].casefold() if isinstance(row[label], str) else row[label]
            keys[value].add(row[key])
        problems += [f"{column['name']} by {by}: {value!r} -> {sorted(found)}"
                     for value, found in keys.items() if len(found) > 1]
    return problems


def shipped_templates():
    return sorted(p for p in ROOT.rglob("*.pbit") if "archive" not in p.relative_to(ROOT).parts)


def load(path):
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]


def table(expression, sorts):
    return {"partitions": [{"source": {"type": "calculated", "expression": expression}}],
            "columns": [{"name": name, "sortByColumn": by} for name, by in sorts.items()]}


class DatatableSortByColumns(unittest.TestCase):
    def test_the_parser_reads_datatable_values(self):
        columns, rows = parse_datatable(
            'DATATABLE("Name", STRING, "Order", INTEGER, "On", BOOLEAN, "Rate", DOUBLE, {\n'
            '  {"a ""quoted"", {brace}", -1, TRUE, 1.5}, // comment\n'
            '  /* } , */ {"b", +2, FALSE(), BLANK()}\n})')
        self.assertEqual(columns, ["Name", "Order", "On", "Rate"])
        self.assertEqual(rows, [['a "quoted", {brace}', -1, "TRUE", 1.5], ["b", 2, "FALSE()", "BLANK()"]])
        self.assertEqual(parse_datatable('// why\n/* note */\nDATATABLE("a", STRING, {{"x"}})'), (["a"], [["x"]]))
        self.assertIsNone(parse_datatable("SELECTCOLUMNS(T, \"a\", 1)"))
        for broken in ('DATATABLE("a", STRING, {{"x", "y"}})', 'DATATABLE("a", STRING, {{"x"}'):
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                parse_datatable(broken)

    def test_the_check_catches_a_value_with_two_sort_keys(self):
        expression = ('DATATABLE("Metric", STRING, "MetricOrder", INTEGER, {'
                      '{"AI Tasks", 108}, {"Other", 109}, {"ai tasks", 801}, {"Other", 109}})')
        self.assertEqual(sort_conflicts(table(expression, {"Metric": "MetricOrder"})),
                         ["Metric by MetricOrder: 'ai tasks' -> [108, 801]"])
        self.assertEqual(sort_conflicts(table(expression.replace("801", "108"), {"Metric": "MetricOrder"})), [])

    def test_shipped_datatables_sort_cleanly(self):
        problems, checked = [], 0
        for path in shipped_templates():
            for item in load(path)["tables"]:
                found = sort_conflicts(item)
                if found is None:
                    continue
                checked += any(column.get("sortByColumn") for column in item.get("columns", []))
                problems += [f"{path.relative_to(ROOT)}: {item['name']}: {problem}" for problem in found]
        self.assertGreaterEqual(checked, 30, "expected the glossaries, legends and period tables")
        self.assertEqual(problems, [], "A value sorts by several keys:\n" + "\n".join(problems))

    def test_glossary_script_is_current(self):
        for path in shipped_templates():
            with self.subTest(template=path.name):
                _, changed = GLOSSARY_SCRIPT.build(path.read_bytes())
                self.assertEqual(changed, 0, "run python scripts/Update-Glossary-Sort-Order.py")

    def test_glossary_script_keeps_each_metrics_lowest_order(self):
        lines = ['DATATABLE(', '    "Page", STRING,', '    "PageDescription", STRING,',
                 '    "Metric", STRING,', '    "Description", STRING,', '    "PageOrder", INTEGER,',
                 '    "MetricOrder", INTEGER,', '    {',
                 '        {"P1", "d", "AI Tasks", "Says ""hi"".", 1, 108},',
                 '        {"P2", "d", "Users", "x", 2, 201},',
                 '        {"P8", "d", "ai tasks", "x", 8, 801}', '    }', ')']
        changes = GLOSSARY_SCRIPT.new_orders(lines)
        self.assertEqual(list(changes), [10])
        self.assertEqual(changes[10][1], '        {"P8", "d", "ai tasks", "x", 8, 108}')


if __name__ == "__main__":
    unittest.main()
