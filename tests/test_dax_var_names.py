"""DAX in the shipped templates parses: no VAR uses a name the DAX parser rejects, and no
string literal has an unescaped quote.

`VAR LastDate = ...` fails to parse. Power BI reports that only as a refresh warning, so the
refresh still ends Completed while the calculated table, the calculated columns and the
relationships that depend on it are never calculated. The rejected names were found by asking
the service (scripts/Update-Dax-Reserved-Names.py); many function names, such as TODAY, are fine.
"""
import importlib.util
import json
import re
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESERVED_FILE = ROOT / "tests" / "fixtures" / "dax_reserved_names.txt"
SPEC = importlib.util.spec_from_file_location("template_dax", ROOT / "scripts" / "Update-Template-Dax.py")
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)

VAR = re.compile(r"(?<![\w.'\[])VAR\s+([A-Za-z_][\w.]*)\s*=", re.IGNORECASE)
DAX_KEYS = ("expression", "filterExpression")


def reserved_names():
    lines = RESERVED_FILE.read_text(encoding="utf-8").splitlines()
    return {line.strip().upper() for line in lines if line.strip() and not line.startswith("#")}


def text(value):
    return "\n".join(value) if isinstance(value, list) else str(value or "")


def strip_comments_and_strings(dax):
    dax = re.sub(r'"(?:[^"]|"")*"', '""', dax)
    dax = re.sub(r"/\*.*?\*/", " ", dax, flags=re.DOTALL)
    return re.sub(r"(//|--)[^\n]*", " ", dax)


def var_names(dax):
    return VAR.findall(strip_comments_and_strings(dax))


# Words that may follow a string literal: "a" IN {...}, ORDER BY ... "x" ASC.
AFTER_STRING = {"IN", "ASC", "DESC"}


def unescaped_quotes(dax):
    """Words straight after a closing quote, such as Include in "the "Include" toggle". A quote
    inside a DAX string is written "", so a word there means the string ended early."""
    found, i, n = [], 0, len(dax)
    while i < n:
        c = dax[i]
        if dax.startswith(("//", "--"), i):
            i = dax.find("\n", i) if "\n" in dax[i:] else n
        elif dax.startswith("/*", i):
            end = dax.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif c in "'[":
            close = "'" if c == "'" else "]"
            i += 1
            while i < n and not (dax[i] == close and dax[i + 1 : i + 2] != close):
                i += 2 if dax[i] == close else 1
            i += 1
        elif c == '"':
            i += 1
            while i < n and not (dax[i] == '"' and dax[i + 1 : i + 2] != '"'):
                i += 2 if dax[i] == '"' else 1
            i += 1
            word = re.match(r"[ \t]*([A-Za-z_]\w*)", dax[i:])
            if word and word.group(1).upper() not in AFTER_STRING:
                found.append(word.group(1))
        else:
            i += 1
    return found


def dax_expressions(node, where="model"):
    """Every DAX expression in a model: measures, calculated columns and tables, calculation
    items, format strings, detail rows and role filters. Power Query (M) partitions and shared
    expressions are skipped."""
    if isinstance(node, dict):
        if node.get("type") in ("m", "query", "entity", "policyRange") and "expression" in node:
            return
        for key, value in node.items():
            if key == "expressions" and where == "model":
                continue
            label = f"{where}/{node.get('name', key)}" if key in DAX_KEYS else f"{where}/{key}"
            if key in DAX_KEYS and isinstance(value, (str, list)):
                yield label, text(value)
            else:
                yield from dax_expressions(value, label if key not in DAX_KEYS else where)
    elif isinstance(node, list):
        for item in node:
            yield from dax_expressions(item, where)


def shipped_templates():
    return sorted(p for p in ROOT.rglob("*.pbit") if "archive" not in p.relative_to(ROOT).parts)


def load(path):
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]


class DaxVarNames(unittest.TestCase):
    def test_reserved_list_has_the_names_that_bit_us(self):
        names = reserved_names()
        self.assertGreater(len(names), 100)
        for name in ("LASTDATE", "FIRSTDATE", "DATE", "VALUE", "VALUES", "SUM", "MAX", "ALL", "RETURN", "STATUS"):
            self.assertIn(name, names)
        for name in ("TODAY", "RATE", "WINDOW", "MAXDAY", "ALLSHOWN"):
            self.assertNotIn(name, names, "the service accepts this name")

    def test_the_check_catches_a_function_name(self):
        reserved = reserved_names()
        dax = "VAR LastDate = TODAY()\nVAR maxday = 1\n// VAR Today = 1\nVAR s = \"VAR Date = 1\"\nRETURN LastDate"
        self.assertEqual(var_names(dax), ["LastDate", "maxday", "s"])
        self.assertEqual([n for n in var_names(dax) if n.upper() in reserved], ["LastDate"])

    def test_the_check_catches_an_unescaped_quote(self):
        self.assertEqual(unescaped_quotes('{"by the "Include" toggle.", 1}'), ["Include"])
        ok = "// it's \"fine\" here\n'T''s'[a ]] b] IN {\"x\"} && \"say \"\"hi\"\"\" & [m]\nORDER BY \"z\" DESC"
        self.assertEqual(unescaped_quotes(ok), [])

    def test_shipped_templates_have_no_unescaped_quotes(self):
        problems = []
        for path in shipped_templates():
            for where, dax in dax_expressions(load(path)):
                problems += [f"{path.relative_to(ROOT)}: {where}: \"...\"{w}" for w in unescaped_quotes(dax)]
        self.assertEqual(problems, [], "Write a quote inside a DAX string as \"\":\n" + "\n".join(problems))

    def test_patcher_expressions_use_safe_var_names(self):
        reserved = reserved_names()
        for spec in PATCHER.VALUELENS_OBJECTS + PATCHER.CONSUMPTION_OBJECTS:
            bad = [n for n in var_names(spec["expression"]) if n.upper() in reserved]
            self.assertEqual(bad, [], f"{spec['table']}[{spec.get('name', '')}]")

    def test_shipped_templates_use_safe_var_names(self):
        reserved = reserved_names()
        templates = shipped_templates()
        self.assertGreaterEqual(len(templates), 10)
        problems = []
        checked = 0
        for path in templates:
            for where, dax in dax_expressions(load(path)):
                for name in var_names(dax):
                    checked += 1
                    if name.upper() in reserved:
                        problems.append(f"{path.relative_to(ROOT)}: {where}: VAR {name}")
        self.assertGreater(checked, 0)
        self.assertEqual(problems, [], "VAR names the DAX parser rejects:\n" + "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
