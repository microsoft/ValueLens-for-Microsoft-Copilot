"""Durable conversation snapshots: paths, ownership, failure/retry and writer lifetime."""
import ast
import json
from types import SimpleNamespace

import pytest

from conversation_parity import NOTEBOOK, run_materialization_regression, snapshot_helpers
from test_valuelens_core_parity import _spark_available


ROOT = "abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse"


@pytest.mark.parametrize("table", ["Tables/custom_output", "Tables/analytics/custom_output"])
def test_snapshot_root_uses_target_lakehouse_not_default_or_schema(table):
    resolve = snapshot_helpers()["conversation_snapshot_root"]
    assert resolve(f"{ROOT}/{table}") == f"{ROOT}/Files/_valuelens_conversations"


@pytest.mark.parametrize("location", [
    "Files/snapshots", "/lakehouse/default/Tables/output",
    "file:///lakehouse/default/Tables/output", "/tmp/output",
    f"{ROOT}/Tables", f"{ROOT}/Files/output", f"{ROOT}/Tables/schema/output/extra",
    f"{ROOT}/Tables/../output", f"{ROOT}/Tables//output",
    f"{ROOT}/Tables/output?query=1", f"{ROOT}/Tables/output#fragment",
])
def test_snapshot_root_rejects_nonshared_or_ambiguous_locations(location):
    with pytest.raises(ValueError, match="ABFSS lakehouse table location"):
        snapshot_helpers()["conversation_snapshot_root"](location)


class FakeFS:
    def __init__(self):
        self.paths, self.deleted = set(), []
        self.delete_error = None

    def exists(self, path):
        return any(p == path.value or p.startswith(path.value + "/") for p in self.paths)

    def delete(self, path, recursive):
        assert recursive
        self.deleted.append(path.value)
        if self.delete_error:
            raise self.delete_error
        self.paths = {p for p in self.paths if p != path.value and not p.startswith(path.value + "/")}
        return True


def fake_spark(fs, master="yarn"):
    class Path:
        def __init__(self, value):
            self.value = value

        def getFileSystem(self, conf):
            return fs

    ns = SimpleNamespace
    return ns(sparkContext=ns(master=master, _jvm=ns(org=ns(apache=ns(hadoop=ns(fs=ns(Path=Path))))),
                             _jsc=ns(hadoopConfiguration=lambda: None)))


def frame(spark, fs, *, fail_write=False, fail_read=False):
    schema = object()

    class Writer:
        def mode(self, mode):
            assert mode == "errorifexists"
            return self

        def parquet(self, path):
            assert not fs.exists(SimpleNamespace(value=path))
            fs.paths.add(path + "/part-0.parquet")
            if fail_write:
                raise RuntimeError("write failed")

    class Reader:
        def schema(self, actual):
            assert actual is schema
            return self

        def parquet(self, path):
            assert fs.exists(SimpleNamespace(value=path))
            if fail_read:
                raise RuntimeError("read failed")
            return path

    spark.read = Reader()
    return SimpleNamespace(schema=schema, write=Writer())


@pytest.mark.parametrize("root", ["Files/temporary", "/tmp/stage", "file:///lakehouse/default/Files/stage"])
def test_cluster_rejects_local_or_unqualified_snapshot_roots(root):
    with pytest.raises(ValueError, match="shared ABFSS"):
        snapshot_helpers()["ConversationSnapshots"](fake_spark(FakeFS()), root)


@pytest.mark.parametrize("failure", ["write", "read", "consumer"])
def test_partial_failure_cleans_only_owned_run_and_retry_uses_new_path(failure):
    fs = FakeFS()
    spark = fake_spark(fs)
    store = snapshot_helpers()["ConversationSnapshots"]
    fs.paths.add(ROOT + "/Files/stage/another-run/keep.parquet")
    with pytest.raises(RuntimeError, match=f"{failure} failed"):
        with store(spark, ROOT + "/Files/stage") as failed:
            failed.materialize(frame(spark, fs, fail_write=failure == "write", fail_read=failure == "read"))
            raise RuntimeError("consumer failed")
    with store(spark, ROOT + "/Files/stage") as retry:
        retry.materialize(frame(spark, fs))
        assert retry.path != failed.path
        assert not fs.exists(SimpleNamespace(value=failed.path))
    assert fs.deleted == [failed.path, retry.path]
    assert fs.paths == {ROOT + "/Files/stage/another-run/keep.parquet"}
    with pytest.raises(RuntimeError, match="closed"):
        retry.materialize(frame(spark, fs))


def test_cleanup_failure_is_not_silent_or_substituted_for_processing_failure(capsys):
    fs = FakeFS()
    spark = fake_spark(fs)
    store = snapshot_helpers()["ConversationSnapshots"]
    fs.delete_error = RuntimeError("delete failed")
    with pytest.raises(RuntimeError, match="delete failed"):
        with store(spark, ROOT + "/Files/stage") as snapshots:
            snapshots.materialize(frame(spark, fs))
    with pytest.raises(ValueError, match="original failure"):
        with store(spark, ROOT + "/Files/stage") as snapshots:
            snapshots.materialize(frame(spark, fs))
            raise ValueError("original failure")
    assert "[warn] conversation snapshot cleanup also failed: delete failed" in capsys.readouterr().out


def test_uuid_collision_never_deletes_existing_data(monkeypatch):
    ns = snapshot_helpers()
    monkeypatch.setattr(ns["uuid"], "uuid4", lambda: SimpleNamespace(hex="existing"))
    fs = FakeFS()
    fs.paths.add(ROOT + "/Files/stage/existing/keep.parquet")
    with pytest.raises(FileExistsError):
        with ns["ConversationSnapshots"](fake_spark(fs), ROOT + "/Files/stage"):
            pytest.fail("A preexisting run must not be adopted")
    assert fs.deleted == []


@pytest.mark.parametrize("plan", [{"full": True, "months": ["2026-10"]}, {"full": False, "months": []}])
def test_full_and_noop_publish_do_not_allocate_storage(plan):
    ns = snapshot_helpers()
    ns.update(spark=fake_spark(FakeFS()), PROCESSOR_CONFIG="config", SOURCE_MONTHS={},
              build_processor_state=lambda *args: "state", historical_audit_changed=lambda *args: False,
              write_curated_output=lambda *args: "result", save_processor_state=lambda *args: None)
    code = "".join(json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"][15]["source"])
    fn = next(n for n in ast.parse(code).body if isinstance(n, ast.FunctionDef) and n.name == "publish_curated_output")
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "processor:publish", "exec"), ns)
    assert ns["publish_curated_output"]("frame", plan) == ("result", plan)


@pytest.mark.parametrize("failure", [None, "history", "refresh-check", "prepare", "write", "state"])
def test_publish_keeps_snapshots_through_all_consumers_and_cleans_on_failure(failure):
    fs = FakeFS()
    spark = fake_spark(fs)
    table = "analytics.custom_output"
    sql_calls, events = [], []

    def sql(query):
        sql_calls.append(query)
        return SimpleNamespace(first=lambda: {"location": ROOT + "/Tables/analytics/custom_output"})

    spark.sql, spark.table = sql, lambda name: name
    ns = snapshot_helpers()
    ns.update(spark=spark, OUT_TABLE=table, PROCESSOR_CONFIG="config", SOURCE_MONTHS={"2026-10": "1:2"},
              build_processor_state=lambda config, months: (config, months))

    def history(df, previous, months, snapshots):
        assert previous == table
        snapshots.materialize(frame(spark, fs))
        events.append("history")
        if failure == "history":
            raise RuntimeError("history failed")
        return "stable-frame", ["2026-07", "2026-10"]

    def step(name, result=None):
        def call(*args):
            assert fs.paths, "Snapshot was removed while consumers are still reading"
            events.append(name)
            if name in ("refresh-check", "write"):
                assert args == ("stable-frame", {"full": False, "months": ["2026-07", "2026-10"]})
            if failure == name:
                raise RuntimeError(name + " failed")
            return result
        return call

    ns.update(update_conversation_history=history, historical_audit_changed=step("refresh-check", True),
              write_curated_output=step("write", "incremental"), prepare_audit_refresh_intent=step("prepare", {}),
              save_processor_state=step("state"))
    code = "".join(json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"][15]["source"])
    fn = next(n for n in ast.parse(code).body if isinstance(n, ast.FunctionDef) and n.name == "publish_curated_output")
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "processor:publish", "exec"), ns)
    plan = {"full": False, "months": ["2026-10"]}
    if failure:
        with pytest.raises(RuntimeError, match=failure + " failed"):
            ns["publish_curated_output"]("replacement", plan)
    else:
        assert ns["publish_curated_output"]("replacement", plan) == (
            "incremental", {"full": False, "months": ["2026-07", "2026-10"]})
        assert events == ["history", "refresh-check", "prepare", "write", "state"]
    assert sql_calls == [f"DESCRIBE DETAIL {table}"]
    assert not fs.paths
    assert len(fs.deleted) == 1
    if failure in ("history", "refresh-check", "prepare", "write"):
        assert "state" not in events


@pytest.mark.skipif(not _spark_available(), reason="pyspark/Java not installed")
def test_spark_snapshot_survives_cache_loss_source_replacement_and_other_run_cleanup():
    from valuelens_golden import spark_session

    assert run_materialization_regression(spark_session()) == {
        "source_replaced": True, "owned_cache_evicted": True, "snapshot_rows": 12,
        "complex_schema_preserved": True, "empty_snapshot": True,
        "local_checkpoint_loss_reproduced": True,
        "other_run_survived": True, "owned_cleanup": True,
    }
