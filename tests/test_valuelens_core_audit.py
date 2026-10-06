"""Audit ingester parity: valuelens_core.audit (DuckDB) vs the Fabric notebook (Spark goldens)."""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone

import pytest

import valuelens_audit_golden as ag
import valuelens_golden as vg
from valuelens_core import audit


def test_duckdb_flatten_matches_spark_golden():
    problems = vg.diff(ag.read_expected(), ag.run_duckdb())
    assert not problems, "\n".join(problems)


def test_helpers_match_notebook_cell6():
    nb = ag.notebook_helpers()
    for record in ag.records():
        assert audit.canonicalize_audit_record(record) == nb["canonicalize_audit_record"](record)
        assert audit.build_source_record_key(record) == nb["build_source_record_key"](record)
    s = datetime(2026, 3, 1, tzinfo=timezone.utc)
    e = datetime(2026, 3, 2, 5, tzinfo=timezone.utc)
    assert audit.stable_window_key(s, e) == nb["stable_window_key"](s, e)
    assert list(audit.KEY_COLUMNS) == list(nb["KEY_COLUMNS"])


def test_build_windows_cover_range_without_gaps():
    s = datetime(2026, 3, 1, tzinfo=timezone.utc)
    e = datetime(2026, 3, 2, 5, tzinfo=timezone.utc)
    windows = audit.build_windows(s, e, 8)
    assert windows[0][0] == s and windows[-1][1] == e
    assert all(a[1] == b[0] for a, b in zip(windows, windows[1:]))


def test_golden_is_current_with_notebook():
    if not (os.environ.get("JAVA_HOME") or shutil.which("java")):
        pytest.skip("Spark/Java not available")
    pytest.importorskip("pyspark")
    problems = vg.diff(ag.read_expected(), ag.run_spark(vg.spark_session()))
    assert not problems, "\n".join(problems)
