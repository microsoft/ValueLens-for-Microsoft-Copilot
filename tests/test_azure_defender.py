"""Offline tests for the Azure jobs' Defender collector (module `defender`): transport, watchlist, day files,
fail-soft snapshots, wiring, publish targets and the V003 migration. Graph is faked; Azure SQL is sqlite3."""
from __future__ import annotations

import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb

from valuelens_core import defender as d
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import publish as pub
from valuelens_jobs import sql as sql_mod
from valuelens_jobs.collect import defender as coll
from valuelens_jobs.config import Settings
from valuelens_jobs.storage import LocalStore
from valuelens_jobs.tables import parquet_glob

ROOT = Path(__file__).resolve().parents[1]
V003 = ROOT / "2. Azure" / "sql" / "migrations" / "V003__defender.sql"
NOW = datetime(2026, 10, 9, 6, 30)
TODAY = date(2026, 10, 9)
FORBIDDEN = (403, {"error": {"code": "Forbidden", "message": "Missing role ThreatHunting.Read.All"}})


class Resp:
    def __init__(self, status, body):
        self.status_code, self._body, self.text = status, body, str(body)

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class Api:
    """Fake `valuelens_jobs.api.Api`: answers keyed by a substring of the KQL or URL; unmatched calls 500."""

    def __init__(self, hunts=None, gets=None):
        self.hunts, self.gets, self.calls = hunts or {}, gets or {}, []

    @staticmethod
    def _answer(table, key):
        for needle, (status, body) in table.items():
            if needle in key:
                return Resp(status, body)
        return Resp(500, {"error": {"message": "unexpected"}})

    def post(self, url, json=None, timeout=None, **kw):
        self.calls.append(("post", url, json, kw.get("headers")))
        return self._answer(self.hunts, json["Query"])

    def get(self, url, headers=None, timeout=None, **kw):
        self.calls.append(("get", url, None, headers))
        return self._answer(self.gets, url)


def healthy(day="2026-10-08"):
    return Api(
        hunts={
            "DeviceProcessEvents": (200, {"results": [
                {"Day": day, "Window": "1d", "Layer": "Ran", "Tool": "Claude", "Devices": 1, "Users": 1, "Events": 4},
                {"Day": day, "Window": "1d", "Layer": "Any", "Tool": "", "Devices": 1, "Users": 1, "Events": 4}]}),
            "DeviceTvmSoftwareInventory": (200, {"results": [{"Tool": "Cursor", "Devices": 2, "SoftwareNames": "c"}]}),
            "AgentsInfo\n": (200, {"results": [{"AgentId": "a", "AgentName": "Helper", "RawAgentInfo": "{}"}]}),
        },
        gets={
            "uploadedStreams/s1/": (200, {"value": [{"id": "x", "displayName": "ChatGPT", "category": "generativeAi"}]}),
            "uploadedStreams": (200, {"value": [{"id": "s1"}]}),
        },
    )


def broken():
    return Api(hunts={"Device": FORBIDDEN, "AgentsInfo": FORBIDDEN},
               gets={"uploadedStreams": (403, {"error": {"message": "Insufficient privileges"}})})


def read(store, key):
    src = parquet_glob(store.root, coll.prefix(key))
    return duckdb.sql(f"SELECT * FROM {src}").fetchall() if src else []


def test_transport_uses_graph_hunting_and_the_beta_header():
    api = Api(hunts={"Q": (200, {"results": []})}, gets={"x": (200, ValueError("not json"))})
    hunt, get = coll.transport(api)
    assert hunt("Q") == (200, {"results": []})
    assert api.calls[0][:3] == ("post", "https://graph.microsoft.com/v1.0/security/runHuntingQuery", {"Query": "Q"})
    status, body = get("https://graph.microsoft.com/beta/x")
    assert status == 200 and "error" in body
    assert api.calls[1][3] == {"Prefer": "include-unknown-enum-members"}


def test_watchlist_seeded_once_then_read(tmp_path):
    store = LocalStore(tmp_path)
    assert coll.read_watchlist(store) == d.default_watchlist()
    path = store.path(coll.WATCHLIST_FILE)
    assert path.is_file()
    path.write_text("Tool,Posture,Domains\nAcme AI,Unsanctioned,acme.ai\n", encoding="utf-8")
    rows = coll.read_watchlist(store)
    assert [(r["Tool"], r["Posture"]) for r in rows] == [("Acme AI", "Unsanctioned")]
    assert "Acme AI" in path.read_text(encoding="utf-8")
    path.write_text("Name\nX\n", encoding="utf-8")
    assert coll.read_watchlist(store) == d.default_watchlist()
    assert path.read_text(encoding="utf-8") == "Name\nX\n"


def test_healthy_run_writes_every_table_and_a_file_per_day(tmp_path):
    store = LocalStore(tmp_path)
    out = coll.collect_defender(healthy(), store, Settings(), today=TODAY, now=NOW)
    assert out["status"] == {p: "ok" for p in d.PROBES}
    assert set(out["written"]) == set(d.TABLES)
    days = sorted(store.list(coll.prefix("totals")))
    assert len(days) == 29
    assert days[0].endswith(f"day-{TODAY - timedelta(days=29):%Y%m%d}.parquet")
    assert days[-1].endswith(f"day-{TODAY - timedelta(days=1):%Y%m%d}.parquet")
    assert len(store.list(coll.prefix("daily"))) == 29
    assert [r[3] for r in read(store, "daily")] == ["Claude"]
    assert coll.last_loaded(store) == TODAY - timedelta(days=1)
    for key in d.TABLES:
        cols = [c[0] for c in duckdb.sql(f"DESCRIBE SELECT * FROM {parquet_glob(store.root, coll.prefix(key))}").fetchall()]
        assert cols == [c for c, _ in d.COLUMNS[key]], key

    # Next day: the last two days are reloaded (10-08 now answers empty, so its file is replaced); older stay.
    old = store.path(coll.day_file("totals", date(2026, 9, 20))).stat().st_mtime_ns
    coll.collect_defender(healthy("2026-10-09"), store, Settings(), today=TODAY + timedelta(days=1),
                          now=NOW + timedelta(days=1))
    assert len(store.list(coll.prefix("totals"))) == 30
    assert sorted(r[0] for r in read(store, "daily")) == [date(2026, 10, 9)]
    assert store.path(coll.day_file("totals", date(2026, 9, 20))).stat().st_mtime_ns == old


def test_failed_probes_keep_last_good_data_and_never_raise(tmp_path):
    store = LocalStore(tmp_path)
    coll.collect_defender(healthy(), store, Settings(), today=TODAY, now=NOW)
    before = {k: read(store, k) for k in ("daily", "totals", "installed", "agents", "cloud")}
    out = coll.collect_defender(broken(), store, Settings(), today=TODAY + timedelta(days=1),
                                now=NOW + timedelta(days=1))
    assert out["status"] == {"device_activity": "forbidden", "installed": "forbidden", "agents": "forbidden",
                             "cloud_discovery": "forbidden"}
    assert set(out["written"]) == {"watchlist", "status"}
    for key, rows in before.items():
        assert read(store, key) == rows, key
    assert {r[1]: r[2] for r in read(store, "status")} == out["status"]


def test_first_run_with_nothing_licensed_writes_status_only(tmp_path):
    store = LocalStore(tmp_path)
    out = coll.collect_defender(broken(), store, Settings(), today=TODAY, now=NOW)
    assert set(out["written"]) == {"watchlist", "status"}
    assert store.list(coll.prefix("totals")) == [] and coll.last_loaded(store) is None
    assert len(read(store, "status")) == len(d.PROBES)


def test_collect_wiring_follows_defender_module(tmp_path, monkeypatch):
    from valuelens_jobs.collect import audit, graph

    called = []
    for mod, name in ((graph, "collect_licensed"), (audit, "collect_audit"), (coll, "collect_defender")):
        monkeypatch.setattr(mod, name, lambda *a, _n=name, **k: called.append(_n))
    store = LocalStore(tmp_path)
    jobs_main.collect(store, Settings(modules=frozenset({"core"})), api=object())
    assert "collect_defender" not in called
    called.clear()
    jobs_main.collect(store, Settings(modules=frozenset({"defender"})), api=object())
    assert called == ["collect_defender"]


def test_publish_targets_include_defender():
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core"}))) == ["curated", "licensed"]
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "defender"}))) == [
        "curated", "licensed", *pub.DEFENDER]
    assert "defender_status" not in jobs_main.publish_targets(Settings(modules=frozenset({"defender"}), sample_data=True))
    assert pub.DEFENDER == list(d.TABLES.values())
    for key, name in d.TABLES.items():
        t = pub.TARGETS[name]
        assert (t.table, t.prefix, t.incremental) == (name, coll.prefix(key), False)
        assert t.partition == ("Day" if key in ("daily", "totals") else None)


def _v003_tables() -> dict:
    sql = V003.read_text(encoding="utf-8")
    out = {}
    for name, body in re.findall(r"CREATE TABLE dbo\.(\w+) \((.*?)\n\);", sql, re.S):
        out[name] = [tuple(m) for m in re.findall(r"\[(\w+)\] ([A-Z0-9]+(?:\(\d+\))?) NULL", body)]
    return out


def test_v003_matches_core_columns():
    sql = V003.read_text(encoding="utf-8")
    assert sql_mod.batches(sql) and [v for v, _ in sql_mod.migrations(V003.parent)][:3] == [1, 2, 3]
    assert "WHERE version = 3)" in sql and "VALUES (3," in sql
    tables = _v003_tables()
    assert list(tables) == list(d.TABLES.values())
    for key, name in d.TABLES.items():
        assert tables[name] == [(c, pub.sql_type(coll.DUCK_TYPES[t])) for c, t in d.COLUMNS[key]], name


def test_publish_onto_v003_tables_in_sqlite(tmp_path):
    store = LocalStore(tmp_path)
    coll.collect_defender(healthy(), store, Settings(), today=TODAY, now=NOW)
    conn = sqlite3.connect(":memory:")
    for name, cols in _v003_tables().items():
        conn.execute(f"CREATE TABLE [{name}] ({', '.join(f'[{c}] {t} NULL' for c, t in cols)})")
    results = {r["table"]: r for r in pub.publish(conn, store, pub.DEFENDER)}
    assert set(results) == set(pub.DEFENDER)
    assert conn.execute("SELECT count(*) FROM defender_shadow_ai_daily").fetchone() == (1,)
    assert conn.execute("SELECT count(*) FROM defender_status").fetchone() == (len(d.PROBES),)
    assert conn.execute("SELECT count(*) FROM defender_ai_watchlist").fetchone() == (len(d.WATCHLIST_SEED),)
