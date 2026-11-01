"""Synthetic parsed-input cross-month check; runnable with local Spark or a Fabric Spark session.

No production tables or credentials are used. In Fabric, call run_spark(spark).
Run-owned temporary Parquet snapshots are removed after their last reader.
The fixture runs the actual processor cells, then the notebook's incremental dependency
helper. Delta/SQL publishing and semantic-model equality are separate validation gates.
"""
from __future__ import annotations

import ast
from contextlib import contextmanager, nullcontext
import datetime
import json
from pathlib import Path
import tempfile
from urllib.parse import urlsplit, urlunsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
COLUMNS = [
    "Id", "CreationDate", "Audit_UserId", "AppHost", "ThreadId", "Message_Id",
    "Message_isPrompt", "AccessedResource_Type", "AccessedResource_Action",
    "ModelTransparencyDetails_ModelName",
]


def fixture(stage=0):
    def row(key, date, thread, message, resource):
        return [key, date + "T12:00:00Z", "person@example.invalid", "Cowork", thread,
                message, "true", resource, "read", "gpt-5"]

    rows = [
        row("a", "2026-07-30", "Thread-A", "Message-A", "message"),
        row("b", "2026-08-01", "Thread-B", "message-a", "application/pdf"),
        row("c", "2026-06-02", "thread-b", "Message-C", "text/plain"),
        row("d", "2026-05-01", "Independent", "Independent", "message"),
        row("null-old", "2026-07-03", None, None, "message"),
        row("empty-old", "2026-07-04", "", "", "message"),
    ]
    if stage in (1, 2):
        rows.extend([
            row("new", "2026-10-01", "thread-a", "MESSAGE-A" if stage == 1 else "Changed-ID", "text/markdown"),
            row("null-new", "2026-10-02", None, None, "application/json"),
            row("empty-new", "2026-10-03", "", "", "text/markdown"),
        ])
    return rows


def snapshot_helpers():
    code = "".join(json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"][2]["source"])
    nodes = [n for n in ast.parse(code).body if isinstance(n, (ast.ClassDef, ast.FunctionDef))
             and n.name in ("ConversationSnapshots", "conversation_snapshot_root")]
    ns = {"uuid": uuid, "urlsplit": urlsplit, "urlunsplit": urlunsplit}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "processor:snapshots", "exec"), ns)
    return ns


@contextmanager
def snapshot_scope(spark, root=None):
    """Local tests own a temp directory; Fabric qualifies Files to shared ABFSS."""
    local = spark.sparkContext.master.startswith("local")
    with tempfile.TemporaryDirectory(prefix="conversation_") if local and root is None else nullcontext() as tmp:
        if root is None:
            if local:
                root = Path(tmp).as_uri()
            else:
                path = spark.sparkContext._jvm.org.apache.hadoop.fs.Path("Files/_valuelens_conversation_tests")
                fs = path.getFileSystem(spark.sparkContext._jsc.hadoopConfiguration())
                root = fs.makeQualified(path).toString()
        with snapshot_helpers()["ConversationSnapshots"](spark, root) as snapshots:
            yield snapshots


def spark_curate(spark, rows, snapshots=None):
    """Run real transform cells; an optional caller-owned scope materializes the result.

    Without a scope the returned frame has only immutable VALUES input, not table/file
    lineage. Callers needing a short plan can provide a scope covering all their readers.
    """
    name = "conversation_fixture_" + uuid.uuid4().hex
    quote = lambda v: "CAST(NULL AS STRING)" if v is None else "'" + str(v).replace("'", "''") + "'"
    values = ", ".join("(" + ", ".join(quote(v) for v in row) + ")" for row in rows)
    source = spark.sql(f"SELECT * FROM VALUES {values} AS src({', '.join(COLUMNS)})")
    source.createOrReplaceTempView(name)
    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    ns = {"spark": spark}
    try:
        for index, cell in enumerate(nb["cells"][:15]):
            if cell["cell_type"] != "code":
                continue
            exec(compile("".join(cell["source"]), f"processor:cell{index}", "exec"), ns)
            if index == 1:
                ns.update(SRC_INTERACTIONS=name, SRC_LICENSED=name + "_absent_licenses",
                          SRC_AGENTS=name + "_absent_agents", OUT_TABLE=name + "_unused_output",
                          AGENT_TYPE_OVERRIDES_TABLE=None, WRITE_MODE="overwrite")
        fact = snapshots.materialize(ns["fact"]) if snapshots is not None else ns["fact"]
        return fact, ns
    finally:
        spark.catalog.dropTempView(name)


def run_spark(spark):
    with snapshot_scope(spark) as snapshots:
        return _run_spark(spark, snapshots)


def _run_spark(spark, snapshots):
    from pyspark.sql import functions as F

    previous, ns = spark_curate(spark, fixture(), snapshots)
    results = []
    # Append across months; change an ID; delete the new month entirely.
    for stage in (1, 2, 3):
        full, ns = spark_curate(spark, fixture(stage), snapshots)
        new_rows = [r for r in fixture(stage) if r[1].startswith("2026-10")]
        replacement = spark_curate(spark, new_rows, snapshots)[0] if new_rows else full.limit(0)
        rewritten, months = ns["update_conversation_history"](replacement, previous, ["2026-10"], snapshots)
        predicate = F.expr(ns["month_predicate_sql"]("MonthStart", months))
        actual = snapshots.materialize(previous.where(~predicate).unionByName(rewritten))
        columns = sorted(full.columns)
        projection = [F.col(f"`{c}`") for c in columns]
        got = [tuple(r) for r in actual.select(*projection).orderBy("Id").collect()]
        expected = [tuple(r) for r in full.select(*projection).orderBy("Id").collect()]
        if got != expected:
            mismatch = next(((a, b) for a, b in zip(got, expected) if a != b), (len(got), len(expected)))
            raise AssertionError(f"Spark stage {stage} incremental != full: {mismatch}")
        if "2026-05" in months:
            raise AssertionError("Independent month was needlessly rewritten")
        # Row b shares the changed message, not the changed thread: its thread still
        # includes row c, which is outside the affected working set.
        band = actual.where("Id = 'b'").select("Session Turn Band").first()[0]
        if band != "2-3 turns":
            raise AssertionError(f"Partly included, unaffected thread was changed: {band}")
        writer = "".join(json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"][15]["source"])
        definition = next(n for n in ast.parse(writer).body
                          if isinstance(n, ast.FunctionDef) and n.name == "historical_audit_changed")
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "processor:refresh-check", "exec"), ns)
        previous.createOrReplaceTempView(ns["OUT_TABLE"])
        try:
            changed = ns["historical_audit_changed"](
                rewritten, {"full": False, "months": months}, datetime.date(2026, 10, 4))
            if not changed:
                raise AssertionError("Historical conversation updates did not request model refresh")
            unchanged = previous.where(predicate)
            if ns["historical_audit_changed"](
                    unchanged, {"full": False, "months": months}, datetime.date(2026, 10, 4)):
                raise AssertionError("Unchanged historical rows needlessly request full refresh")
        finally:
            spark.catalog.dropTempView(ns["OUT_TABLE"])
        results.append({"stage": stage, "rows": len(expected), "rewritten_months": months,
                        "historical_refresh": changed})
        previous = actual
    return results


def run_materialization_regression(spark):
    """Lose owned cache blocks and replace source files; snapshots must remain stable."""
    from pyspark.sql import functions as F

    # Negative control: remove only this fixture's checkpoint RDD, not shared caches.
    unsafe = spark.range(6).localCheckpoint(eager=True)
    unsafe._jdf.logicalPlan().rdd().unpersist(True)
    try:
        unsafe.groupBy().sum("id").collect()
    except Exception as error:
        text = str(error).lower()
        if "checkpoint" not in text or not ("unpersist" in text or "not found" in text):
            raise
    else:
        raise AssertionError("Negative control did not reproduce local-checkpoint block loss")

    with snapshot_scope(spark) as snapshots:
        source = snapshots.materialize(spark.range(12).repartition(2))
        source_path = source.inputFiles()[0].rsplit("/", 1)[0]
        cached = source.cache()
        try:
            assert cached.count() == 12
            stable = snapshots.materialize(cached.unionByName(cached).groupBy("id").count())
            stable.cache()
            try:
                assert stable.count() == 12
            finally:
                stable.unpersist(blocking=True)
        finally:
            cached.unpersist(blocking=True)
        # No original source files survive. A persist+count fallback would now fail
        # or recompute different rows; a shared snapshot is independent of that lineage.
        spark.range(100, 103).write.mode("overwrite").parquet(source_path)
        got = [(r.id, r["count"]) for r in stable.orderBy("id").collect()]
        assert got == [(i, 2) for i in range(12)], got
        assert spark.read.parquet(source_path).count() == 3
        complex_rows = spark.sql("""
            SELECT CAST(NULL AS STRING) AS optional, array(1, NULL, 3) AS items,
                   map('key', 'value') AS attributes, named_struct('value', 'nested') AS detail,
                   CAST(1.25 AS DECIMAL(12,2)) AS amount, DATE'2026-07-01' AS day,
                   TIMESTAMP'2026-07-01 12:00:00' AS stamp
        """).select("*", F.lit("meta").alias("tag", metadata={"source": "fixture"}))
        complex_snapshot = snapshots.materialize(complex_rows)
        assert complex_snapshot.collect() == complex_rows.collect()
        assert complex_snapshot.schema.simpleString() == complex_rows.schema.simpleString()
        assert complex_snapshot.schema["tag"].metadata == {"source": "fixture"}
        assert snapshots.materialize(complex_rows.limit(0)).count() == 0
        # A separate active scope must survive the first scope's cleanup.
        with snapshot_scope(spark, snapshots.path.rsplit("/", 1)[0]) as other:
            survivor = other.materialize(spark.range(5))
            snapshots.close()
            assert not snapshots.fs.exists(snapshots._hadoop_path)
            assert survivor.count() == 5
        assert not other.fs.exists(other._hadoop_path)
    return {"source_replaced": True, "owned_cache_evicted": True, "snapshot_rows": len(got),
            "complex_schema_preserved": True, "empty_snapshot": True,
            "local_checkpoint_loss_reproduced": True,
            "other_run_survived": True, "owned_cleanup": True}


if __name__ == "__main__":
    from valuelens_golden import spark_session

    spark = spark_session()
    print(json.dumps({"parity": run_spark(spark), "durability": run_materialization_regression(spark)}, indent=2))
