"""Checks for the optional Agent Evaluator template."""
import ast
import contextlib
import io
import json
import re
import sys
import types
import unittest
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PBIT = ROOT / "1. Fabric" / "Manual setup" / "Add Agent Evaluator" / "Agent Evaluator.pbit"
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "agent-evaluator" / "Copilot_Agent_Transcript_Parser.ipynb"
AGENT_TABLES = [
    "dbo.agent_sessions",
    "dbo.agent_turns",
    "dbo.agent_errors",
    "dbo.agent_subagents",
    "dbo.agent_catalogue",
    "dbo.agent_performance",
]


def measures():
    with zipfile.ZipFile(PBIT) as archive:
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))
    found = {}
    for table in model["model"]["tables"]:
        for measure in table.get("measures", []):
            expression = measure["expression"]
            found[measure["name"]] = "\n".join(expression) if isinstance(expression, list) else expression
    return found


def notebook_cells():
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]


def notebook_cell_source(needle):
    for cell in notebook_cells():
        source = "".join(cell.get("source", []))
        if needle in source:
            return source
    raise AssertionError(f"Notebook cell not found: {needle}")


class FakeStringType:
    pass


class FakeStructField:
    def __init__(self, name, data_type, nullable):
        self.name = name
        self.data_type = data_type
        self.nullable = nullable


class FakeStructType:
    def __init__(self, fields):
        self.fields = list(fields)


class FakeCatalog:
    def __init__(self, existing):
        self.existing = set(existing)
        self.lookups = []

    def tableExists(self, table):
        self.lookups.append(table)
        return table in self.existing


class FakeWriter:
    def __init__(self, spark, frame):
        self.spark = spark
        self.frame = frame
        self.mode_value = None
        self.format_value = None
        self.options = {}

    def mode(self, value):
        self.mode_value = value
        return self

    def option(self, key, value):
        self.options[key] = value
        return self

    def format(self, value):
        self.format_value = value
        return self

    def saveAsTable(self, table):
        self.spark.saves.append({
            "table": table,
            "mode": self.mode_value,
            "format": self.format_value,
            "options": dict(self.options),
            "schema": self.frame.schema,
            "rows": self.frame.rows,
        })


class FakeFrame:
    def __init__(self, spark, rows, schema):
        self.spark = spark
        self.rows = rows
        self.schema = schema
        self.columns = [field.name for field in schema.fields]

    @property
    def write(self):
        return FakeWriter(self.spark, self)


class FakeSpark:
    def __init__(self, existing=()):
        self.catalog = FakeCatalog(existing)
        self.created = []
        self.saves = []
        self.sqls = []

    def createDataFrame(self, rows, schema=None):
        self.created.append({"rows": rows, "schema": schema})
        return FakeFrame(self, rows, schema)

    def sql(self, statement):
        self.sqls.append(statement)


@contextlib.contextmanager
def fake_pyspark_types():
    module_names = ["pyspark", "pyspark.sql", "pyspark.sql.types"]
    previous = {name: sys.modules.get(name) for name in module_names}
    pyspark = types.ModuleType("pyspark")
    sql = types.ModuleType("pyspark.sql")
    sql_types = types.ModuleType("pyspark.sql.types")
    sql_types.StructType = FakeStructType
    sql_types.StructField = FakeStructField
    sql_types.StringType = FakeStringType
    pyspark.sql = sql
    sql.types = sql_types
    sys.modules.update({
        "pyspark": pyspark,
        "pyspark.sql": sql,
        "pyspark.sql.types": sql_types,
    })
    try:
        yield
    finally:
        for name, module in previous.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def helper_namespace(spark):
    source = notebook_cell_source("def _write_empty_delta_table_if_needed")
    tree = ast.parse(source)
    helper = [
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_write_empty_delta_table_if_needed"
    ]
    ns = {"spark": spark}
    exec(compile(ast.Module(body=helper, type_ignores=[]), "agent-evaluator-helper", "exec"), ns)
    return ns


def run_agent_writer_cell(write_mode, existing=()):
    spark = FakeSpark(existing)
    ns = helper_namespace(spark)
    ns.update({
        "spark": spark,
        "pd": pd,
        "re": re,
        "WRITE_MODE": write_mode,
        "OUTPUT_PREFIX": "dbo",
        "PANDAS_TO_SPARK_CHUNK_ROWS": 20000,
        "parsed": pd.DataFrame(columns=["conversationtranscriptid"]),
        "sessions": pd.DataFrame(columns=["conversation_id", "agent_name"]),
        "turns": pd.DataFrame(columns=["turn_id"]),
        "errors": pd.DataFrame(columns=["conversation_id", "error_timestamp_utc", "error_code"]),
        "subagents": pd.DataFrame(columns=[
            "conversation_id", "invocation_timestamp_utc", "connected_agent_schema", "plan_step_id",
        ]),
        "agent_dim": pd.DataFrame(columns=["agent_schema"]),
        "agent_performance": pd.DataFrame(columns=["ConversationTranscriptId"]),
    })
    source = notebook_cell_source("for name, pdf in outputs.items():")
    output = io.StringIO()
    with fake_pyspark_types(), contextlib.redirect_stdout(output):
        exec(compile(source, "agent-evaluator-writer-cell", "exec"), ns)
    return spark, output.getvalue()


class AgentEvaluatorTemplateTests(unittest.TestCase):
    def test_answered_rate_is_the_complement_of_the_gap_rate(self):
        # Both are shares of knowledge searches, so Answered + Gap = 100%. Answered
        # used to divide by every session, and Focus 2 subtracted the two shares.
        found = measures()
        self.assertIn("1 - [Knowledge Gap Rate]", found["Knowledge Answered Rate"])
        self.assertIn("'Agent Sessions'[knowledge_searched] = TRUE ()", found["Knowledge Gap Rate"])
        self.assertIn("VAR gap = [Knowledge Gap Rate]", found["⭐ Focus 2: Knowledge Gap"])


class AgentEvaluatorNotebookWriteTests(unittest.TestCase):
    def test_zero_row_merge_and_append_create_missing_tables_or_leave_existing_unchanged(self):
        for write_mode in ("merge", "append"):
            with self.subTest(write_mode=write_mode, existing=False):
                spark, output = run_agent_writer_cell(write_mode, existing=())
                self.assertEqual(AGENT_TABLES, [save["table"] for save in spark.saves])
                self.assertTrue(all(save["mode"] == "append" for save in spark.saves))
                self.assertEqual(
                    ["conversation_id", "agent_name"],
                    [field.name for field in spark.saves[0]["schema"].fields],
                )
                self.assertIn("created empty (no rows)", output)
                self.assertNotIn("merge(no-rows)", output)

            with self.subTest(write_mode=write_mode, existing=True):
                spark, output = run_agent_writer_cell(write_mode, existing=AGENT_TABLES)
                self.assertEqual([], spark.saves)
                self.assertEqual([], spark.created)
                self.assertEqual(AGENT_TABLES, spark.catalog.lookups)
                self.assertIn("unchanged (no rows)", output)

    def test_zero_row_notebook_messages_are_accurate(self):
        text = NOTEBOOK.read_text(encoding="utf-8")
        self.assertNotIn("writing empty agent tables (schema preserved)", text)
        self.assertNotIn("merge(no-rows)", text)
        self.assertNotIn("if RAW_TABLE and len(tx):", text)
        self.assertIn(
            "agent tables will be created empty if missing; existing tables are left unchanged in merge/append mode",
            text,
        )
        self.assertIn("created empty (no rows)", text)
        self.assertIn("unchanged (no rows)", text)
        self.assertIn("overwritten empty", text)


if __name__ == "__main__":
    unittest.main()
