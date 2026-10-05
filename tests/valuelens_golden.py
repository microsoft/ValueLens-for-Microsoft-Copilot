"""Golden parity harness: Fabric Spark notebook vs the DuckDB port (valuelens_core).

    python tests\\valuelens_golden.py --regenerate     # Spark -> expected/*.json (needs pyspark + Java)
    python tests\\valuelens_golden.py --check          # DuckDB vs expected/*.json

Expected outputs are produced by exec-ing the notebook cells 1-14 verbatim on local
Spark, so they track the notebook rather than a hand-written spec. Regenerate after
any change to Copilot_Audit_Log_Processor.ipynb and update the DuckDB port to match.
"""
from __future__ import annotations

import argparse
import datetime as dt
import decimal
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "valuelens-golden"
INPUTS, EXPECTED = FIXTURES / "inputs", FIXTURES / "expected"
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
sys.path.insert(0, str(ROOT / "shared" / "python"))

# name -> (interactions, licensed, agents, options)
CASES = {
    "modern_exclude": ("modern_interactions", "licensed_upn", "agents_full", {}),
    "modern_keep_agents": ("modern_interactions", "licensed_upn", "agents_full",
                           {"exclude_agent_identities": False}),
    "legacy": ("legacy_interactions", "licensed_normalized", "agents_min", {}),
    "legacy_passthrough": ("legacy_interactions", "licensed_normalized", "agents_min",
                           {"include_raw_passthrough": True}),
    "minimal_no_dims": ("minimal_interactions", None, None, {}),
    "minimal_no_id": ("minimal_no_id_interactions", "licensed_normalized", "agents_min", {}),
    "empty": ("empty_interactions", "licensed_normalized", "agents_min", {}),
}


def load_input(name: str) -> dict:
    return json.loads((INPUTS / f"{name}.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------- serialisation
SPARK_TYPES = {"string": "string", "timestamp": "timestamp", "date": "date", "bigint": "bigint",
               "boolean": "boolean", "int": "int", "double": "double"}
DUCK_TYPES = {"VARCHAR": "string", "TIMESTAMP": "timestamp", "DATE": "date", "BIGINT": "bigint",
              "BOOLEAN": "boolean", "INTEGER": "int", "DOUBLE": "double"}


def _value(v):
    if isinstance(v, dt.datetime):
        return v.replace(tzinfo=None).isoformat(sep=" ", timespec="microseconds")
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    return v


def snapshot(columns, rows) -> dict:
    data = [[_value(v) for v in r] for r in rows]
    data.sort(key=lambda r: json.dumps(r, sort_keys=True, ensure_ascii=False))
    return {"columns": [list(c) for c in columns], "rows": data}


def diff(expected: dict, actual: dict) -> list[str]:
    problems = []
    if expected["columns"] != actual["columns"]:
        e, a = expected["columns"], actual["columns"]
        problems.append(f"columns differ:\n  expected {e}\n  actual   {a}")
        en, an = [c[0] for c in e], [c[0] for c in a]
        problems.append(f"  missing {[c for c in en if c not in an]} extra {[c for c in an if c not in en]}")
        return problems
    if len(expected["rows"]) != len(actual["rows"]):
        problems.append(f"row count {len(actual['rows'])} != expected {len(expected['rows'])}")
    names = [c[0] for c in expected["columns"]]
    for i, (er, ar) in enumerate(zip(expected["rows"], actual["rows"])):
        if er != ar:
            cols = [f"{n}: {e!r} != {a!r}" for n, e, a in zip(names, er, ar) if e != a]
            problems.append(f"row {i}: " + "; ".join(cols[:8]))
            if len(problems) > 12:
                break
    return problems


# ---------------------------------------------------------------------------- DuckDB
def run_duckdb(case: str) -> dict:
    import duckdb
    from valuelens_core import curate

    inter, lic, ag, opts = CASES[case]
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")

    def table(name, alias):
        d = load_input(name)
        dtypes = {"string": "VARCHAR", "timestamp": "TIMESTAMP", "date": "DATE", "bigint": "BIGINT"}
        cols = ", ".join(f'"{c}" {dtypes[t]}' for c, t in d["columns"])
        con.execute(f'CREATE TABLE "{alias}" ({cols})')
        if d["rows"]:
            ph = ", ".join("?" for _ in d["columns"])
            con.executemany(f'INSERT INTO "{alias}" VALUES ({ph})', d["rows"])
        return f'"{alias}"'

    rel = curate(con, table(inter, "src"), table(lic, "lic") if lic else None,
                 table(ag, "ag") if ag else None, **opts)
    columns = [[c, DUCK_TYPES.get(str(t), str(t))] for c, t in zip(rel.columns, rel.types)]
    return snapshot(columns, rel.fetchall())


# ---------------------------------------------------------------------------- Spark
def spark_session():
    from pyspark.sql import SparkSession
    return (SparkSession.builder.master("local[1]").appName("valuelens-golden")
            .config("spark.sql.session.timeZone", "UTC").config("spark.ui.enabled", "false")
            .config("spark.sql.shuffle.partitions", "1").getOrCreate())


def run_spark(spark, case: str) -> dict:
    from pyspark.sql import functions as F, types as T

    inter, lic, ag, opts = CASES[case]
    views = {}
    tmp = Path(tempfile.mkdtemp(prefix="vl_golden_"))

    def view(name, alias):
        d = load_input(name)
        path = tmp / f"{alias}.jsonl"
        with path.open("w", encoding="utf-8") as fh:
            for r in d["rows"]:
                fh.write(json.dumps(dict(zip([c for c, _ in d["columns"]], r))) + "\n")
        schema = T.StructType([T.StructField(c, T.StringType()) for c, _ in d["columns"]])
        df = spark.read.schema(schema).json(str(path))
        for c, t in d["columns"]:
            if t != "string":
                df = df.withColumn(c, F.col(f"`{c}`").cast(t))
        full = f"vl_golden_{case}_{alias}"
        df.createOrReplaceTempView(full)
        views[alias] = full
        return full

    src = view(inter, "src")
    lic_v = view(lic, "lic") if lic else f"vl_golden_absent_{case}_lic"
    ag_v = view(ag, "ag") if ag else f"vl_golden_absent_{case}_ag"

    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    ns = {"spark": spark}
    for index, cell in enumerate(nb["cells"]):
        if cell["cell_type"] != "code" or index >= 15:
            continue
        exec(compile("".join(cell["source"]), f"processor:cell{index}", "exec"), ns)
        if index == 1:
            ns.update(SRC_INTERACTIONS=src, SRC_LICENSED=lic_v, SRC_AGENTS=ag_v,
                      INCLUDE_RAW_PASSTHROUGH=opts.get("include_raw_passthrough", False),
                      EXCLUDE_AGENT_IDENTITIES=opts.get("exclude_agent_identities", True))
    fact = ns["fact"]
    columns = [[f.name, SPARK_TYPES.get(f.dataType.simpleString(), f.dataType.simpleString())]
               for f in fact.schema.fields]
    # collect() converts timestamps to the driver's local zone; format them in UTC inside Spark.
    out = fact.select([
        F.date_format(F.col(f"`{f.name}`"), "yyyy-MM-dd HH:mm:ss.SSSSSS").alias(f.name)
        if isinstance(f.dataType, T.TimestampType) else F.col(f"`{f.name}`")
        for f in fact.schema.fields])
    rows = [list(r) for r in out.collect()]
    for v in views.values():
        spark.catalog.dropTempView(v)
    return snapshot(columns, rows)


def write_expected(case: str, snap: dict):
    EXPECTED.mkdir(parents=True, exist_ok=True)
    (EXPECTED / f"{case}.json").write_text(
        json.dumps(snap, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def read_expected(case: str) -> dict:
    return json.loads((EXPECTED / f"{case}.json").read_text(encoding="utf-8"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--regenerate", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("cases", nargs="*")
    args = ap.parse_args(argv)
    cases = args.cases or list(CASES)
    failed = 0
    if args.regenerate:
        spark = spark_session()
        for c in cases:
            snap = run_spark(spark, c)
            write_expected(c, snap)
            print(f"{c}: {len(snap['rows'])} rows x {len(snap['columns'])} cols")
    if args.check or not args.regenerate:
        for c in cases:
            problems = diff(read_expected(c), run_duckdb(c))
            print(f"{c}: {'OK' if not problems else 'MISMATCH'}")
            for p in problems:
                print("   ", p)
            failed += bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
