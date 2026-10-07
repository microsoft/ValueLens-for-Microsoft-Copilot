"""Golden parity harness for the audit ingester: notebook (Spark) vs valuelens_core.audit (DuckDB).

    python tests\\valuelens_audit_golden.py --regenerate   # Spark -> expected/audit_flatten.json
    python tests\\valuelens_audit_golden.py --check        # DuckDB vs expected

Staging uses the notebook's own cell-6 helpers (extracted by AST, so no Graph calls run)
and the flatten exec-s cells 14, 16 and 18 verbatim on local Spark.
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "shared" / "python"))
sys.path.insert(0, str(ROOT / "tests"))

import valuelens_golden as vg  # noqa: E402

NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Audit_Log_Direct_Ingester.ipynb"
RECORDS = vg.INPUTS / "audit_records.json"
EXPECTED = vg.EXPECTED / "audit_flatten.json"
HELPER_CELL, FLATTEN_CELLS = 6, (14, 16, 18)
_KEEP_ASSIGNS = {"WINDOW_KEY_VERSION", "KEY_COLUMNS", "_RESOURCE_KEY_FIELDS", "_SYNTHETIC_AUDIT_FIELDS"}


def _cells():
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]


def notebook_helpers() -> dict:
    """Functions and constants from notebook cell 6, without its top-level Spark/Graph code."""
    tree = ast.parse("".join(_cells()[HELPER_CELL]["source"]))
    keep = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef)):
            keep.append(node)
        elif isinstance(node, ast.Assign) and all(
                isinstance(t, ast.Name) and t.id in _KEEP_ASSIGNS for t in node.targets):
            keep.append(node)
    ns: dict = {}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "ingester:cell6", "exec"), ns)
    return ns


def records() -> list:
    return json.loads(RECORDS.read_text(encoding="utf-8"))


def staged_rows(canonicalize) -> list[dict]:
    return [canonicalize(r) for r in records()]


def run_duckdb() -> dict:
    import duckdb
    from valuelens_core import audit

    rows = staged_rows(audit.canonicalize_audit_record)
    con = duckdb.connect()
    con.execute("CREATE TABLE staged (" + ", ".join(f'"{c}" VARCHAR' for c in audit.STAGE_COLUMNS) + ")")
    con.executemany(f"INSERT INTO staged VALUES ({', '.join('?' for _ in audit.STAGE_COLUMNS)})",
                    [[r.get(c) for c in audit.STAGE_COLUMNS] for r in rows])
    rel = audit.flatten(con, "staged")
    columns = [[c, vg.DUCK_TYPES.get(str(t), str(t))] for c, t in zip(rel.columns, rel.types)]
    return vg.snapshot(columns, rel.fetchall())


def run_spark(spark) -> dict:
    from pyspark.sql import functions as F, types as T

    helpers = notebook_helpers()
    tmp = Path(tempfile.mkdtemp(prefix="vl_audit_golden_")) / "staged.jsonl"
    with tmp.open("w", encoding="utf-8") as fh:
        for r in staged_rows(helpers["canonicalize_audit_record"]):
            fh.write(json.dumps(r) + "\n")
    ns = {"spark": spark, "F": F, "StructType": T.StructType, "StructField": T.StructField,
          "StringType": T.StringType, "ArrayType": T.ArrayType, "raw": spark.read.json(str(tmp))}
    cells = _cells()
    for index in FLATTEN_CELLS:
        exec(compile("".join(cells[index]["source"]), f"ingester:cell{index}", "exec"), ns)
    flat = ns["flat"]
    columns = [[f.name, vg.SPARK_TYPES.get(f.dataType.simpleString(), f.dataType.simpleString())]
               for f in flat.schema.fields]
    out = flat.select([
        F.date_format(F.col(f"`{f.name}`"), "yyyy-MM-dd HH:mm:ss.SSSSSS").alias(f.name)
        if isinstance(f.dataType, T.TimestampType) else F.col(f"`{f.name}`")
        for f in flat.schema.fields])
    return vg.snapshot(columns, [list(r) for r in out.collect()])


def read_expected() -> dict:
    return json.loads(EXPECTED.read_text(encoding="utf-8"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--regenerate", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    if args.regenerate:
        snap = run_spark(vg.spark_session())
        EXPECTED.write_text(json.dumps(snap, indent=1, ensure_ascii=False) + "\n",
                            encoding="utf-8", newline="\n")
        print(f"audit_flatten: {len(snap['rows'])} rows x {len(snap['columns'])} cols")
    problems = vg.diff(read_expected(), run_duckdb())
    print("audit_flatten:", "OK" if not problems else "MISMATCH")
    for p in problems:
        print("   ", p)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
