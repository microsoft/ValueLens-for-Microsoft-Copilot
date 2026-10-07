"""DuckDB port (shared/python/valuelens_core) must match the Fabric Spark notebook row for row.

Expected outputs in tests/fixtures/valuelens-golden/expected were produced by running the
notebook's own cells on local Spark (`python tests/valuelens_golden.py --regenerate`).
The Spark regeneration check runs only when pyspark and Java are available.
"""
import importlib.util
import json
import os
import shutil
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("valuelens_golden", HERE / "valuelens_golden.py")
golden = importlib.util.module_from_spec(spec)
spec.loader.exec_module(golden)

duckdb = pytest.importorskip("duckdb")
CASES = list(golden.CASES)


@pytest.mark.parametrize("case", CASES)
def test_duckdb_matches_spark_golden(case):
    problems = golden.diff(golden.read_expected(case), golden.run_duckdb(case))
    assert not problems, "\n".join(problems)


def test_goldens_cover_every_case_and_enrichment_column():
    from valuelens_core import ENRICHED_COLS, REQUIRED_TEXT_COLS

    for case in CASES:
        names = [c for c, _ in golden.read_expected(case)["columns"]]
        missing = [c for c in ENRICHED_COLS + REQUIRED_TEXT_COLS if c not in names]
        assert not missing, (case, missing)


def test_rerun_is_idempotent_on_one_connection():
    from valuelens_core import curate

    con = duckdb.connect()
    con.execute("CREATE TABLE src AS SELECT 'x' AS Id, '2026-09-02T12:00:00Z' AS CreationDate, "
                "'a@example.invalid' AS Audit_UserId")
    first = curate(con, "src").fetchall()
    second = curate(con, "src").fetchall()
    assert first == second
    leftovers = [r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE '__vl_%' "
        "AND table_name NOT LIKE '%_curated'").fetchall()]
    assert not leftovers, leftovers


def test_raw_passthrough_collision_is_rejected():
    from valuelens_core import curate

    con = duckdb.connect()
    con.execute("CREATE TABLE src AS SELECT 'x' AS Id, '2026-09-02' AS CreationDate, "
                "'a@example.invalid' AS Audit_UserId, 'y' AS appidentity_raw")
    with pytest.raises(ValueError, match="already exist"):
        curate(con, "src", include_raw_passthrough=True)


def _spark_available():
    try:
        import pyspark  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("JAVA_HOME") or shutil.which("java"))


@pytest.mark.skipif(not _spark_available(), reason="pyspark/Java not installed")
def test_spark_goldens_are_current():
    spark = golden.spark_session()
    for case in CASES:
        actual = golden.run_spark(spark, case)
        problems = golden.diff(golden.read_expected(case), actual)
        assert not problems, f"{case}: regenerate goldens\n" + "\n".join(problems)
