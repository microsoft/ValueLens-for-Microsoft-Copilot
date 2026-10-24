"""Reloads keep older rows on the Fabric route: an audit backfill replaces parsed rows only from its
earliest record onwards. No Spark: the fake table applies Delta's replaceWhere, including its check
that every written row matches the predicate."""
from __future__ import annotations

import ast
import contextlib
import io
import json
import re
from datetime import datetime, timedelta, timezone

import pytest

import notebook_source

NOTEBOOK = "Copilot_Audit_Log_Direct_Ingester.ipynb"
TABLE = "dbo.Copilot_Interactions_Parsed"
KEYS = ["Id", "Source_RecordKey", "Source_MessageKey", "Source_ResourceKey"]
COLUMNS = KEYS + ["CreationDate", "MonthStart"]
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def micros(*parts):
    return (datetime(*parts, tzinfo=timezone.utc) - EPOCH) // timedelta(microseconds=1)


def notebook_cells():
    return json.loads((notebook_source.NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8"))["cells"]


def code_cell(marker):
    """(index, source) of the one code cell that contains `marker`."""
    found = [(i, "".join(c["source"])) for i, c in enumerate(notebook_cells())
             if c["cell_type"] == "code" and marker in "".join(c["source"])]
    assert len(found) == 1, f"{marker!r} is in {len(found)} code cells"
    return found[0]


def load(marker, ns, assigns=frozenset()):
    """Run a cell's defs, its named assignments and its imports other than pyspark into `ns`."""
    index, source = code_cell(marker)
    body = []
    for node in ast.parse(source).body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            if not any(name.split(".")[0] == "pyspark" for name in names):
                body.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) or (isinstance(node, ast.Assign) and all(
                isinstance(t, ast.Name) and t.id in assigns for t in node.targets)):
            body.append(node)
    exec(compile(ast.Module(body=body, type_ignores=[]), f"{NOTEBOOK}:cell{index}", "exec"), ns)


def notebook_constant(name):
    for cell in notebook_cells():
        if cell["cell_type"] != "code":
            continue
        try:
            tree = ast.parse("".join(cell["source"]))
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, ast.Assign) and [getattr(t, "id", None) for t in node.targets] == [name]:
                return ast.literal_eval(node.value)
    raise KeyError(name)


class Col:
    def __init__(self, expr):
        self.expr = expr

    def alias(self, name):
        return Col(f"{self.expr} AS {name}")


class FakeF:
    @staticmethod
    def lit(value):
        return Col(repr(value))

    @staticmethod
    def count(col):
        return Col(f"count({col.expr})")

    @staticmethod
    def expr(text):
        return Col(text)


class Result:
    def __init__(self, rows):
        self.rows = rows

    def collect(self):
        return self.rows


class Frame:
    def __init__(self, spark, rows, columns):
        self.spark, self.rows, self.columns = spark, [dict(r) for r in rows], list(columns)

    def agg(self, *cols):
        self.spark.aggregates.append([c.expr for c in cols])
        dates = [r["CreationDate"] for r in self.rows if r["CreationDate"] is not None]
        return Result([{"rows": len(self.rows), "earliest": min(dates) if dates else None}])

    @property
    def write(self):
        return Writer(self.spark, self)


class Writer:
    def __init__(self, spark, source):
        self.spark = spark
        self.call = {"source": source, "format": None, "mode": None, "options": {}, "partitionBy": None}

    def format(self, value):
        self.call["format"] = value
        return self

    def mode(self, value):
        self.call["mode"] = value
        return self

    def option(self, key, value):
        self.call["options"][key] = value
        return self

    def partitionBy(self, *columns):
        self.call["partitionBy"] = list(columns)
        return self

    def saveAsTable(self, name):
        self.call["table"] = name
        self.spark.save(self.call)


def matches(predicate, row):
    """Evaluate the two predicate shapes the helper writes, as Delta would."""
    found = re.fullmatch(r"`(\w+)` >= TIMESTAMP '([^']+)Z' OR `\1` IS NULL", predicate)
    if found:
        value = row[found.group(1)]
        bound = datetime.fromisoformat(found.group(2)).replace(tzinfo=timezone.utc)
        return value is None or value >= (bound - EPOCH) // timedelta(microseconds=1)
    found = re.fullmatch(r"`(\w+)` IS NULL", predicate)
    assert found, f"unexpected predicate {predicate!r}"
    return row[found.group(1)] is None


class FakeSpark:
    def __init__(self, rows=None, columns=COLUMNS, partitions=("MonthStart",)):
        self.stored = None if rows is None else [dict(r) for r in rows]
        self.columns = list(columns)
        self.partitions = list(partitions)
        self.writes, self.aggregates = [], []
        spark = self

        class Catalog:
            def tableExists(self, name):
                assert name == TABLE
                return spark.stored is not None

        self.catalog = Catalog()

    def table(self, name):
        assert name == TABLE and self.stored is not None
        return Frame(self, self.stored, self.columns)

    def sql(self, statement):
        assert statement == f"DESCRIBE DETAIL {TABLE}"
        return Result([{"partitionColumns": list(self.partitions)}])

    def save(self, call):
        assert call["format"] == "delta" and call["mode"] == "overwrite"
        self.writes.append(call)
        batch = call["source"].rows
        predicate = call["options"].get("replaceWhere")
        if predicate is None:
            self.stored = [dict(r) for r in batch]
            self.columns = list(call["source"].columns)
            if call["partitionBy"] is not None:
                self.partitions = call["partitionBy"]
            return
        assert "overwriteSchema" not in call["options"] and call["partitionBy"] is None
        if not all(matches(predicate, r) for r in batch):
            raise AssertionError("Delta: written data doesn't match replaceWhere")
        self.stored = [r for r in self.stored if not matches(predicate, r)] + [dict(r) for r in batch]


def row(id_, when):
    return {"Id": id_, "Source_RecordKey": id_, "Source_MessageKey": "", "Source_ResourceKey": "",
            "CreationDate": when, "MonthStart": None if when is None else when // 10}


@pytest.fixture
def ns():
    loaded = {"KEY_COLUMNS": notebook_constant("KEY_COLUMNS")}
    assert loaded["KEY_COLUMNS"] == KEYS
    load("def write_backfill(", loaded, {"PARTITION_COLUMN", "_EPOCH"})
    load("def write_output(", loaded)
    loaded["F"] = FakeF
    return loaded


def run(ns, spark, batch, columns=COLUMNS):
    ns["spark"] = spark
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        action = ns["write_backfill"](Frame(spark, batch, columns), TABLE, ns["KEY_COLUMNS"])
    return action, out.getvalue()


def ids(spark):
    return sorted(r["Id"] for r in spark.stored)


def test_utc_timestamp_literal(ns):
    literal = ns["utc_timestamp_literal"]
    assert literal(0) == "TIMESTAMP '1970-01-01 00:00:00.000000Z'"
    assert literal(micros(2026, 9, 1, 5, 6, 7, 123)) == "TIMESTAMP '2026-09-01 05:06:07.000123Z'"
    for bad in (True, 1.5, "0", None):
        with pytest.raises(ValueError):
            literal(bad)


def test_replace_predicate_is_null_safe(ns):
    predicate = ns["backfill_replace_predicate"]
    start = micros(2026, 8, 3, 1)
    assert predicate(start) == "`CreationDate` >= TIMESTAMP '2026-08-03 01:00:00.000000Z' OR `CreationDate` IS NULL"
    assert predicate(None) == "`CreationDate` IS NULL"
    assert predicate(start, "When") == "`When` >= TIMESTAMP '2026-08-03 01:00:00.000000Z' OR `When` IS NULL"


def test_plan_order(ns):
    plan = ns["plan_backfill_write"]
    assert plan(False, 0, None, ["Id"]) == ("create", None)
    assert plan(True, 0, None, ["Source_RecordKey"]) == ("rebuild", None)
    assert plan(True, 0, None, []) == ("unchanged", None)
    assert plan(True, 2, None, []) == ("replace", "`CreationDate` IS NULL")
    assert plan(True, 2, 0, []) == ("replace", "`CreationDate` >= TIMESTAMP '1970-01-01 00:00:00.000000Z' OR `CreationDate` IS NULL")


def test_backfill_keeps_rows_older_than_its_first_record(ns):
    day = lambda d: micros(2026, 8, d, 9)  # noqa: E731
    spark = FakeSpark([row("old", day(1)), row("same", day(5)), row("gone", day(10)), row("nodate", None)])
    action, out = run(ns, spark, [row("same", day(5)), row("new", day(7)), row("nodate2", None)])
    assert action == "replace"
    # Older rows stay; from the first record onwards the batch replaces the table, NULL dates included.
    assert ids(spark) == ["new", "nodate2", "old", "same"]
    [write] = spark.writes
    assert write["options"] == {"mergeSchema": "true",
                                "replaceWhere": ns["backfill_replace_predicate"](day(5))}
    assert write["partitionBy"] is None and "MonthStart" not in write["options"]["replaceWhere"]
    assert "older rows kept" in out
    assert spark.aggregates == [["count(1) AS rows", "unix_micros(min(`CreationDate`)) AS earliest"]]


def test_the_first_months_older_rows_are_kept(ns):
    # The predicate is on CreationDate, not MonthStart, so a reload starting mid-month keeps the
    # rows of that month that are older than its first record.
    early, late = micros(2026, 8, 2), micros(2026, 8, 20)
    stored = [dict(row("early", early), MonthStart="2026-08-01")]
    spark = FakeSpark(stored)
    run(ns, spark, [dict(row("late", late), MonthStart="2026-08-01")])
    assert ids(spark) == ["early", "late"]


def test_batch_of_only_undated_rows_replaces_only_undated_rows(ns):
    spark = FakeSpark([row("old", micros(2026, 8, 1)), row("nodate", None)])
    action, _ = run(ns, spark, [row("nodate2", None)])
    assert action == "replace" and ids(spark) == ["nodate2", "old"]
    assert spark.writes[0]["options"]["replaceWhere"] == "`CreationDate` IS NULL"


def test_empty_backfill_leaves_the_table(ns):
    spark = FakeSpark([row("old", micros(2026, 8, 1))])
    action, out = run(ns, spark, [])
    assert action == "unchanged" and spark.writes == [] and ids(spark) == ["old"]
    assert "left as it is" in out


def test_missing_table_is_created_by_month(ns):
    spark = FakeSpark(None)
    action, _ = run(ns, spark, [row("a", micros(2026, 8, 1))])
    assert action == "create" and ids(spark) == ["a"]
    [write] = spark.writes
    assert write["options"] == {"overwriteSchema": "true"} and write["partitionBy"] == ["MonthStart"]


def test_legacy_table_without_stable_keys_is_replaced_whole(ns):
    spark = FakeSpark([{"Id": "legacy", "CreationDate": micros(2026, 1, 1), "MonthStart": None}],
                      columns=["Id", "CreationDate", "MonthStart"])
    action, out = run(ns, spark, [row("a", micros(2026, 8, 1))])
    assert action == "rebuild" and ids(spark) == ["a"]
    assert spark.writes[0]["options"] == {"overwriteSchema": "true"}
    assert "Source_RecordKey" in out


def test_unpartitioned_table_is_migrated_then_replaced(ns):
    spark = FakeSpark([row("old", micros(2026, 7, 1)), row("gone", micros(2026, 8, 9))], partitions=())
    action, out = run(ns, spark, [row("new", micros(2026, 8, 3))])
    assert action == "replace" and ids(spark) == ["new", "old"]
    migrate, replace = spark.writes
    assert migrate["options"] == {"overwriteSchema": "true"} and migrate["partitionBy"] == ["MonthStart"]
    assert "replaceWhere" in replace["options"] and spark.partitions == ["MonthStart"]
    assert "migrating" in out


def test_write_output_sends_backfills_to_write_backfill(ns):
    calls = []
    ns.update(OUTPUT_TABLE=TABLE, spark=FakeSpark(None),
              write_backfill=lambda df, table, keys: calls.append((df, table, keys)) or "replace")
    ns["WRITE_MODE"] = "replace"
    assert ns["write_output"]("batch") == "replace"
    assert calls == [("batch", TABLE, ns["KEY_COLUMNS"])]
    # An incremental run with no table yet also creates it through write_backfill.
    ns["WRITE_MODE"] = "merge"
    ns["_validate_batch_keys"] = lambda df, keys, name: None
    assert ns["write_output"]("first") == "replace" and calls[-1][0] == "first"
    ns["WRITE_MODE"] = "overwrite"
    with pytest.raises(ValueError, match="Unsupported WRITE_MODE"):
        ns["write_output"]("batch")


def test_cells_wire_the_backfill_to_replace():
    helper, helper_source = code_cell("def write_backfill(")
    writer, writer_source = code_cell("def write_output(")
    assert helper < writer
    assert "PARTITION_COLUMN = " not in writer_source and "def _table_partition_columns" not in writer_source
    assert "return write_backfill(df, OUTPUT_TABLE, KEY_COLUMNS)" in writer_source
    _, config = code_cell("if MODE == 'backfill':")
    assert "    WRITE_MODE = 'replace'\n" in config and "'overwrite'" not in config
