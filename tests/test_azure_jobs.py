"""Offline tests for `2. Azure/jobs` (valuelens_jobs): collectors, publish, migrate, refresh, orchestration.

Graph and Power BI are faked at the HTTP-session level; Azure SQL is stood in for by sqlite3, which
accepts the bracket-quoted DDL/DML that publish emits.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import duckdb
import pytest

from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import api as api_mod
from valuelens_jobs import publish as pub
from valuelens_jobs import refresh as refresh_mod
from valuelens_jobs import sql as sql_mod
from valuelens_jobs.collect import audit as audit_collect
from valuelens_jobs.collect import graph
from valuelens_jobs.config import Settings
from valuelens_jobs.storage import LocalStore
from valuelens_jobs.tables import write_rows

NOW = datetime(2026, 9, 10, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------- fakes
class Resp:
    def __init__(self, status=200, body=None, text=None, headers=None, content=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = text if text is not None else (json.dumps(body) if body is not None else "")
        self.content = content if content is not None else self.text.encode("utf-8")

    def json(self):
        return self._body


class Session:
    """Routes (method, url-prefix) to a handler; records every call."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def request(self, method, url, headers=None, timeout=None, **kw):
        self.calls.append((method, url, kw, headers))
        return self.handler(method, url, kw)


class Tokens:
    def __init__(self):
        self.forced = 0

    def get(self, scope, force=False):
        self.forced += bool(force)
        return f"tok-{scope}"


def make_api(handler):
    session = Session(handler)
    return api_mod.Api(Tokens(), session=session, sleep=lambda s: None), session


def settings(**kw):
    base = dict(audit_history_days=1, audit_lookback_days=0, modules=frozenset({"core", "orgData", "m365Activity"}))
    base.update(kw)
    return Settings(**base)


# ---------------------------------------------------------------- api
def test_api_retries_throttling_and_refreshes_token_once():
    seq = [Resp(429, {}, headers={"Retry-After": "2"}), Resp(401, {}), Resp(200, {"ok": 1})]
    api, session = make_api(lambda m, u, kw: seq.pop(0))
    assert api.get("https://graph.microsoft.com/v1.0/x").json() == {"ok": 1}
    assert len(session.calls) == 3 and api.tokens.forced == 1
    assert session.calls[0][3]["Authorization"].startswith("Bearer ")


def test_token_source_caches_until_near_expiry():
    issued = []

    class Cred:
        def get_token(self, scope):
            issued.append(scope)
            return SimpleNamespace(token=f"t{len(issued)}", expires_on=1000)

    clock = [0]
    ts = api_mod.TokenSource(Cred(), clock=lambda: clock[0])
    assert ts.get("s") == ts.get("s") == "t1"
    clock[0] = 800
    assert ts.get("s") == "t2"


# ---------------------------------------------------------------- audit collector
def _record(i, when):
    return {
        "id": f"rec-{i}",
        "createdDateTime": when.isoformat().replace("+00:00", "Z"),
        "auditLogRecordType": "copilotInteraction",
        "operation": "CopilotInteraction",
        "userPrincipalName": "ada@contoso.com",
        "auditData": {"Id": f"aud-{i}", "CreationTime": when.strftime("%Y-%m-%dT%H:%M:%S"),
                      "UserId": "ada@contoso.com", "Operation": "CopilotInteraction",
                      "Workload": "Copilot", "RecordType": 261,
                      "CopilotEventData": {"AppHost": "Word", "Contexts": [],
                                           "Messages": [{"Id": f"m{i}", "isPrompt": True}]}},
    }


class AuditGraph:
    """Each created query returns the records whose time falls inside its window, in two pages."""

    def __init__(self, records, fail_first=0):
        self.records, self.queries, self.fail_first = records, {}, fail_first

    def __call__(self, method, url, kw):
        base = audit_collect.QUERIES
        if method == "POST" and url == base:
            if self.fail_first:
                self.fail_first -= 1
                return Resp(500, {"error": "boom"})
            body = kw["json"]
            qid = str(uuid.uuid4())
            ws, we = (datetime.fromisoformat(body[k]) for k in ("filterStartDateTime", "filterEndDateTime"))
            self.queries[qid] = [r for r in self.records
                                 if ws <= datetime.fromisoformat(r["createdDateTime"].replace("Z", "+00:00")) < we]
            return Resp(201, {"id": qid})
        qid = url[len(base) + 1:].split("/")[0].split("?")[0]
        if "/records" not in url:
            return Resp(200, {"status": "succeeded"})
        recs = self.queries[qid]
        if "skip=1" in url:
            return Resp(200, {"value": recs[1:]})
        nxt = f"{base}/{qid}/records?$top=999&skip=1" if len(recs) > 1 else None
        page = {"value": recs[:1]}
        if nxt:
            page["@odata.nextLink"] = nxt
        return Resp(200, page)


def _parsed(store):
    return duckdb.sql(f"SELECT * FROM read_parquet('{(store.root / audit_collect.PARSED).as_posix()}/*.parquet', "
                      f"union_by_name=true) ORDER BY Id").fetchall(), \
        duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{(store.root / audit_collect.PARSED).as_posix()}/*.parquet')"
                   ).fetchall()


def test_audit_collect_merge_is_idempotent(tmp_path):
    t0 = NOW - timedelta(hours=20)
    records = [_record(1, t0), _record(2, t0 + timedelta(hours=1)), _record(3, NOW - timedelta(hours=2))]
    graph_fake = AuditGraph(records)
    api, _ = make_api(graph_fake)
    store = LocalStore(tmp_path)
    s = settings()
    first = audit_collect.collect_audit(api, store, s, now=NOW, sleep=lambda x: None)
    assert first["rows"] == 3
    rows, schema = _parsed(store)
    assert len(rows) == 3
    state = store.read_json(audit_collect.STATE)
    assert state["high_water_mark"].startswith(NOW.date().isoformat()) or state["high_water_mark"]
    assert all(w["status"] == "succeeded" for w in state["windows"].values())

    again = audit_collect.collect_audit(api, store, s, now=NOW + timedelta(minutes=5), sleep=lambda x: None)
    rows2, _ = _parsed(store)
    assert len(rows2) == 3 and again["rows"] <= 3


def test_audit_merge_logs_records_without_prompts(tmp_path, caplog):
    # Copilot Studio evaluations carry no messages and some events carry only responses; like every
    # variant they're not counted, but the run should say so rather than just "merged 0 rows".
    t0 = NOW - timedelta(hours=20)
    evaluation = _record(1, t0)
    evaluation["auditData"]["CopilotEventData"] = {"AppHost": "pva-maker-evaluation", "Messages": []}
    response_only = _record(2, t0 + timedelta(hours=1))
    response_only["auditData"]["CopilotEventData"]["Messages"] = [{"Id": "r2", "isPrompt": False}]
    api, _ = make_api(AuditGraph([evaluation, response_only, _record(3, t0 + timedelta(hours=2))]))
    store = LocalStore(tmp_path)
    with caplog.at_level("INFO", logger="valuelens_jobs.collect.audit"):
        result = audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)
    assert result["rows"] == 1
    assert "2 of 3 staged record(s) have no user prompt" in caplog.text


def test_audit_failed_window_raises_and_resumes(tmp_path):
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=3))]
    api, _ = make_api(AuditGraph(records, fail_first=100))
    store = LocalStore(tmp_path)
    with pytest.raises(RuntimeError, match="audit window"):
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)
    assert not list((tmp_path / "raw").glob("copilot_interactions_parsed/*.parquet"))
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 2


def test_audit_partial_failure_merges_finished_windows(tmp_path):
    """One throttled window must not leave the table empty, nor move the high-water mark past it."""
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=3))]

    class OneBadWindow(AuditGraph):
        def __call__(self, method, url, kw):
            if method == "POST" and kw["json"]["filterStartDateTime"] == (NOW - timedelta(hours=20)).isoformat():
                return Resp(500, {"error": "boom"})
            return super().__call__(method, url, kw)

    api, _ = make_api(OneBadWindow(records))
    store = LocalStore(tmp_path)
    with pytest.raises(RuntimeError, match=r"1 audit window\(s\) failed; the 1 row\(s\)"):
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)
    rows, _ = _parsed(store)
    assert len(rows) == 1
    assert "high_water_mark" not in store.read_json(audit_collect.STATE)
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 2
    assert store.read_json(audit_collect.STATE)["high_water_mark"]


def test_audit_permission_error_is_clear(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(403, {"error": "forbidden"}))
    with pytest.raises(PermissionError, match="AuditLogsQuery.Read.All"):
        audit_collect.collect_audit(api, LocalStore(tmp_path), settings(), now=NOW, sleep=lambda x: None)


def test_audit_rejects_foreign_next_link(tmp_path):
    fake = AuditGraph([_record(1, NOW - timedelta(hours=3)), _record(2, NOW - timedelta(hours=2))])

    def handler(m, u, kw):
        r = fake(m, u, kw)
        if isinstance(r._body, dict) and "@odata.nextLink" in r._body:
            r._body["@odata.nextLink"] = "https://evil.example/records"
        return r

    api, _ = make_api(handler)
    with pytest.raises(RuntimeError, match="audit window"):
        audit_collect.collect_audit(api, LocalStore(tmp_path), settings(), now=NOW, sleep=lambda x: None)


# ---------------------------------------------------------------- graph snapshots
LICENSED_CSV = ("\ufeffReport Refresh Date,User Principal Name,Display Name,Assigned Products\n"
                "2026-09-09,Ada@contoso.com,Ada,MICROSOFT 365 E5+MICROSOFT 365 COPILOT\n"
                "2026-09-09,bob@contoso.com,Bob,Microsoft 365 E3\n")


def test_collect_licensed_and_org(tmp_path):
    users_page2 = graph.org.USERS_URL + "&$skiptoken=2"

    def handler(m, url, kw):
        if "getOffice365ActiveUserDetail" in url:
            return Resp(200, text=LICENSED_CSV, content=LICENSED_CSV.encode("utf-8-sig"))
        if url == graph.org.USERS_URL:
            return Resp(200, {"value": [{"userPrincipalName": "ceo@contoso.com", "displayName": "Ceo"}],
                              "@odata.nextLink": users_page2})
        if url == users_page2:
            return Resp(200, {"value": [{"userPrincipalName": "ada@contoso.com", "displayName": "Ada",
                                         "manager": {"userPrincipalName": "ceo@contoso.com"}}]})
        raise AssertionError(url)

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    assert graph.collect_licensed(api, store, settings()) == 2
    assert graph.collect_org(api, store, settings()) == 2
    lic = duckdb.sql(f"SELECT UPN_Normalized, Has_license FROM '{store.path('raw/copilot_licensed_users/part-0.parquet').as_posix()}' ORDER BY 1").fetchall()
    assert lic == [("ada@contoso.com", "TRUE"), ("bob@contoso.com", "FALSE")]
    org_rows = duckdb.sql(f"SELECT count(*) FROM '{store.path('raw/copilot_org_data/part-0.parquet').as_posix()}'").fetchone()
    assert org_rows == (2,)


def test_collect_org_rejects_loops_and_foreign_links(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(200, {"value": [], "@odata.nextLink": graph.org.USERS_URL}))
    with pytest.raises(RuntimeError, match="looped"):
        graph.collect_org(api, LocalStore(tmp_path), settings())
    api, _ = make_api(lambda m, u, kw: Resp(200, {"value": [], "@odata.nextLink": "https://evil.example/u"}))
    with pytest.raises(RuntimeError, match="non-Graph"):
        graph.collect_org(api, LocalStore(tmp_path), settings())


def test_collect_licensed_403_names_permission(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(403, {}))
    with pytest.raises(PermissionError, match="Reports.Read.All"):
        graph.collect_licensed(api, LocalStore(tmp_path), settings())


def test_collect_m365_writes_day_files(tmp_path):
    csv = ("Report Refresh Date,User Principal Name,Team Chat Message Count\n"
           "2026-09-08,Ada@contoso.com,4\n")

    def handler(m, url, kw):
        if "getTeamsUserActivityUserDetail" in url:
            return Resp(200, text=csv, content=csv.encode())
        return Resp(404, {})

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    out = graph.collect_m365(api, store, settings(), today=date(2026, 9, 10), reread_days=2)
    assert out["written"]
    files = sorted(p.name for p in (tmp_path / "raw" / "m365_activity_daily").glob("*.parquet"))
    assert files == [f"day-{d:%Y%m%d}.parquet" for d in out["written"]]


# ---------------------------------------------------------------- publish
def _write_curated(store, rows, extra_col=False):
    cols = ["Id", "InteractionDate", "UserUPN", "Prompts"] + (["NewCol"] if extra_col else [])
    types = ["VARCHAR", "DATE", "VARCHAR", "BIGINT"] + (["VARCHAR"] if extra_col else [])
    write_rows(store.path("curated/copilot_interactions_curated/part-0.parquet"), cols,
               [r + (("x",) if extra_col else ()) for r in rows], types)


def test_publish_partitions_are_incremental(tmp_path):
    store = LocalStore(tmp_path)
    conn = sqlite3.connect(":memory:")
    d1, d2 = date(2026, 9, 1), date(2026, 9, 2)
    _write_curated(store, [("a", d1, "ada", 1), ("b", d2, "bob", 2)])
    r = pub.publish(conn, store, ["curated"])[0]
    assert r["days_changed"] == 2 and r["rows"] == 2

    r = pub.publish(conn, store, ["curated"])[0]
    assert r["days_changed"] == 0 and r["rows"] == 0

    _write_curated(store, [("a", d1, "ada", 1), ("b2", d2, "bob", 5), ("c", d2, "cy", 1)], extra_col=True)
    r = pub.publish(conn, store, ["curated"])[0]
    assert r["added_columns"] == ["NewCol"]
    assert r["days_changed"] == 2  # schema change re-signs every day
    got = conn.execute("SELECT Id, InteractionDate, NewCol FROM copilot_interactions_curated ORDER BY Id").fetchall()
    assert got == [("a", "2026-09-01", "x"), ("b2", "2026-09-02", "x"), ("c", "2026-09-02", "x")]

    _write_curated(store, [("b2", d2, "bob", 5), ("c", d2, "cy", 1)], extra_col=True)
    r = pub.publish(conn, store, ["curated"])[0]
    assert r["days_removed"] == 1 and r["days_changed"] == 0
    assert r["oldest_day"] == "2026-09-01"
    assert conn.execute("SELECT count(*) FROM copilot_interactions_curated").fetchone() == (2,)
    assert pub.publish(conn, store, ["curated"])[0]["oldest_day"] is None


def test_publish_snapshot_replaces_and_skips_missing(tmp_path):
    store = LocalStore(tmp_path)
    conn = sqlite3.connect(":memory:")
    assert pub.publish(conn, store, ["org"])[0]["skipped"]
    write_rows(store.path("raw/copilot_licensed_users/part-0.parquet"), ["UPN_Normalized", "Has_license"],
               [("a", "TRUE"), ("b", "FALSE")])
    pub.publish(conn, store, ["licensed"])
    write_rows(store.path("raw/copilot_licensed_users/part-0.parquet"), ["UPN_Normalized", "Has_license"],
               [("a", "TRUE")])
    assert pub.publish(conn, store, ["licensed"])[0]["rows"] == 1
    assert conn.execute("SELECT * FROM copilot_licensed_users").fetchall() == [("a", "TRUE")]


def test_publish_type_mapping():
    assert pub.sql_type("VARCHAR") == "NVARCHAR(4000)"
    assert pub.sql_type("TIMESTAMP WITH TIME ZONE") == pub.TYPE_MAP["TIMESTAMP"]
    assert pub.sql_type("DECIMAL(18,2)") == "DECIMAL(18,2)"
    assert pub.b("a]b") == "[a]]b]"


# ---------------------------------------------------------------- migrate
def test_migration_discovery_and_batches(tmp_path):
    (tmp_path / "V002__more.sql").write_text("SELECT 2\nGO\n", encoding="utf-8")
    (tmp_path / "V001__init.sql").write_text("CREATE TABLE t (a INT)\n  go  \nSELECT 1\nGO", encoding="utf-8")
    (tmp_path / "README.md").write_text("x", encoding="utf-8")
    assert [v for v, _ in sql_mod.migrations(tmp_path)] == [1, 2]
    assert sql_mod.batches((tmp_path / "V001__init.sql").read_text()) == ["CREATE TABLE t (a INT)", "SELECT 1"]
    (tmp_path / "V1__dup.sql").write_text("", encoding="utf-8")
    with pytest.raises(ValueError, match="Duplicate"):
        sql_mod.migrations(tmp_path)


def test_migrate_applies_once(tmp_path):
    (tmp_path / "V001__init.sql").write_text(
        "CREATE TABLE schema_version (version INT, description TEXT, applied_at TEXT)\nGO\n"
        "CREATE TABLE t (a INT)\nGO\n", encoding="utf-8")
    (tmp_path / "V002__add.sql").write_text("ALTER TABLE t ADD b INT\n", encoding="utf-8")

    class Conn:
        """sqlite3 with `dbo.` stripped and T-SQL `IF NOT EXISTS ... INSERT` emulated."""

        def __init__(self):
            self.db = sqlite3.connect(":memory:")

        def cursor(self):
            db = self.db

            class Cur:
                def execute(self, stmt, params=()):
                    stmt = stmt.replace("dbo.", "")
                    if stmt.startswith("IF NOT EXISTS"):
                        v, v2, d = params
                        if not db.execute("SELECT 1 FROM schema_version WHERE version = ?", (v,)).fetchone():
                            db.execute("INSERT INTO schema_version (version, description) VALUES (?, ?)", (v2, d))
                        return
                    self.c = db.execute(stmt, params)

                def fetchall(self):
                    return self.c.fetchall()
            return Cur()

        def commit(self):
            self.db.commit()

        def rollback(self):
            self.db.rollback()

    conn = Conn()
    assert sql_mod.migrate(conn, tmp_path) == [1, 2]
    assert sql_mod.migrate(conn, tmp_path) == []
    assert conn.db.execute("SELECT version, description FROM schema_version ORDER BY 1").fetchall() == \
        [(1, "init"), (2, "add")]


def test_reader_sid_and_statements():
    cid = "11223344-5566-7788-99aa-bbccddeeff00"
    assert sql_mod.sid_literal(cid) == "0x44332211665588779" "9AABBCCDDEEFF00"
    stmts = sql_mod.reader_statements("ValueLens ]Reader'", cid)
    assert "CREATE USER [ValueLens ]]Reader'] WITH SID = 0x" in stmts[0]
    assert "N'ValueLens ]Reader'''" in stmts[0]
    assert stmts[1].endswith("ALTER ROLE db_datareader ADD MEMBER [ValueLens ]]Reader']")
    assert sql_mod.reader_statements("", cid) == []
    with pytest.raises(ValueError):
        sql_mod.sid_literal("not-a-guid")


def test_access_token_struct():
    packed = sql_mod.access_token_struct("ab")
    assert packed == b"\x04\x00\x00\x00a\x00b\x00"


def test_repo_migrations_parse():
    found = sql_mod.migrations(sql_mod.default_migrations_dir())
    assert found and found[0][0] == 1
    for _, path in found:
        assert sql_mod.batches(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- refresh
WS, DS = "ws-1", "ds-1"
REFRESHES = f"{refresh_mod.BASE}/groups/{WS}/datasets/{DS}/refreshes"


def _refresher(handler):
    api, session = make_api(handler)
    clock = [0.0]

    def sleep(s):
        clock[0] += s

    return refresh_mod.Refresher(api, sleep=sleep, clock=lambda: clock[0]), session


def test_refresh_enhanced_waits_out_busy_then_polls():
    state = {"posts": 0, "polls": 0}

    def handler(m, url, kw):
        if m == "POST":
            state["posts"] += 1
            if state["posts"] == 1:
                return Resp(409, text="Another refresh is in progress")
            return Resp(202, headers={"Location": f"{REFRESHES}/rid-9", "RequestId": "req"})
        assert url == f"{REFRESHES}/rid-9"
        state["polls"] += 1
        if state["polls"] <= 2:  # Power BI answers 202 while the refresh is in progress
            return Resp(202, {"status": "Unknown", "extendedStatus": "NotStarted" if state["polls"] == 1 else "InProgress"})
        return Resp(200, {"extendedStatus": "Completed"})

    r, session = _refresher(handler)
    r.refresh(WS, DS)
    assert state == {"posts": 2, "polls": 3}
    assert session.calls[1][2]["json"] == refresh_mod.ENHANCED


def test_refresh_pro_falls_back_to_standard_and_reads_history():
    bodies = []

    def handler(m, url, kw):
        if m == "POST":
            bodies.append(kw["json"])
            if kw["json"] is refresh_mod.ENHANCED:
                return Resp(400, text="enhanced refresh needs premium")
            return Resp(202, headers={"RequestId": "req-7"})
        assert kw["params"] == {"$top": 10}
        return Resp(200, {"value": [{"requestId": "other", "status": "Failed"},
                                    {"requestId": "req-7", "status": "Completed"}]})

    r, _ = _refresher(handler)
    r.refresh(WS, DS)
    assert bodies == [refresh_mod.ENHANCED, refresh_mod.STANDARD]


def test_refresh_reloads_all_partitions_when_old_days_were_republished():
    today = date(2026, 10, 7)
    recent = [{"oldest_day": "2026-09-30"}, {"oldest_day": None}, {"table": "x"}]
    assert not refresh_mod.needs_full_refresh(recent, today)
    assert not refresh_mod.needs_full_refresh(None, today)
    assert refresh_mod.needs_full_refresh(recent + [{"oldest_day": "2026-09-29"}], today)

    bodies = []

    def handler(m, url, kw):
        if m == "POST":
            bodies.append(kw["json"])
            return Resp(202, headers={"Location": f"{REFRESHES}/rid-1"})
        return Resp(200, {"extendedStatus": "Completed"})

    r, _ = _refresher(handler)
    r.refresh(WS, DS, all_partitions=True)
    assert bodies == [refresh_mod.ENHANCED_ALL] and bodies[0]["applyRefreshPolicy"] is False


def test_refresh_failure_surfaces_service_error():
    def handler(m, url, kw):
        if m == "POST":
            return Resp(202, headers={"Location": f"{REFRESHES}/r1"})
        return Resp(200, {"status": "Failed", "serviceExceptionJson": "{\"errorCode\":\"DMTS_Credential\"}"})

    r, _ = _refresher(handler)
    with pytest.raises(RuntimeError, match="DMTS_Credential"):
        r.refresh(WS, DS)


def test_refresh_models_skips_when_unconfigured_and_validates():
    assert refresh_mod.refresh_models(None, settings()) == []
    with pytest.raises(ValueError, match="itemId"):
        refresh_mod.refresh_models(None, settings(semantic_models={"m": {"workspaceId": "w"}}))


# ---------------------------------------------------------------- settings / orchestration
def test_settings_from_env():
    s = Settings.from_env({"VALUELENS_MODULES": "core, m365Activity", "VALUELENS_AUDIT_HISTORY_DAYS": "90",
                           "VALUELENS_SEMANTIC_MODELS": json.dumps({"valueLensModel": {"workspaceId": "w", "itemId": "i"}}),
                           "VALUELENS_SQL_READER_CLIENT_ID": "c"})
    assert s.has("m365Activity") and not s.has("orgData") and s.audit_history_days == 90
    assert s.semantic_models["valueLensModel"]["itemId"] == "i" and s.sql_reader_client_id == "c"
    assert Settings.from_env({}).modules == frozenset({"core", "orgData"})
    with pytest.raises(ValueError):
        Settings.from_env({"VALUELENS_SEMANTIC_MODELS": "[1]"})
    with pytest.raises(ValueError):
        Settings.from_env({"VALUELENS_AUDIT_HISTORY_DAYS": "lots"})


def test_publish_targets_follow_modules():
    assert jobs_main.publish_targets(settings(modules=frozenset({"core"}))) == ["curated", "licensed"]
    assert jobs_main.publish_targets(settings()) == ["curated", "licensed", "org", "m365"]
    assert jobs_main.publish_targets(settings(sample_data=True)) == ["curated", "licensed", "org"]


def test_sample_data_setting_from_env():
    assert Settings.from_env({"VALUELENS_SAMPLE_DATA": "true"}).sample_data is True
    assert Settings.from_env({}).sample_data is False


def test_sample_week_shift_keeps_weekdays_and_lands_last_week():
    from valuelens_jobs.sample import week_shift

    assert week_shift(date(2026, 8, 31), date(2026, 10, 6)) == 35
    assert week_shift(date(2026, 10, 5), date(2026, 10, 6)) == 0
    assert week_shift(date(2026, 10, 6), date(2026, 10, 6)) == 0


def test_sample_load_runs_through_processor(tmp_path):
    from pathlib import Path

    from valuelens_jobs import sample

    folder = Path(__file__).resolve().parents[1] / "5. Local CSV" / "sample-data"
    store = LocalStore(tmp_path)
    info = sample.load(store, folder=folder, today=date(2026, 10, 6))
    assert info["people"] == 170 and info["shift_days"] == 35
    assert jobs_main.process(store) == info["interactions"]

    curated = f"read_parquet('{(tmp_path / 'curated/copilot_interactions_curated').as_posix()}/*.parquet')"
    users, latest, licensed = duckdb.sql(
        f"SELECT count(DISTINCT Audit_UserId), max(InteractionDate), "
        f"count(*) FILTER (WHERE \"Has license\"::VARCHAR = 'TRUE') FROM {curated}").fetchone()
    assert users == 151 and latest == date(2026, 10, 5) and licensed > 0
    for prefix in ("raw/copilot_org_data", "raw/copilot_licensed_users"):
        rows = duckdb.sql(f"SELECT count(*) FROM read_parquet('{(tmp_path / prefix).as_posix()}/*.parquet')").fetchone()[0]
        assert rows == 170


def test_collect_dispatch_follows_modules(tmp_path, monkeypatch):
    called = []
    for name in ("collect_licensed", "collect_org", "collect_m365"):
        monkeypatch.setattr(graph, name, lambda *a, _n=name, **k: called.append(_n))
    monkeypatch.setattr(audit_collect, "collect_audit", lambda *a, **k: called.append("collect_audit"))
    jobs_main.collect(LocalStore(tmp_path), settings(modules=frozenset({"core"})), api=object())
    assert called == ["collect_licensed", "collect_audit"]


def test_sql_connect_retries_while_serverless_db_resumes(monkeypatch):
    class Error(Exception):
        pass

    outcomes = [Error("HYT00", "[HYT00] Login timeout expired (0) (SQLDriverConnect)"),
                Error("42000", "[42000] Database 'valuelens' is not currently available. (40613)"), "conn"]

    def fake_connect(*a, **k):
        item = outcomes.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setitem(sys.modules, "pyodbc", SimpleNamespace(Error=Error, connect=fake_connect))
    s = SimpleNamespace(sql_server="srv", sql_database="db")
    tokens = SimpleNamespace(get=lambda scope: "tok")
    waits = []
    assert sql_mod.connect(s, tokens, sleep=waits.append) == "conn"
    assert waits == [10, 20]

    outcomes[:] = [Error("28000", "Login failed for user")]
    with pytest.raises(Error, match="28000"):
        sql_mod.connect(s, tokens, sleep=waits.append)


def test_collect_keeps_going_when_a_source_fails(tmp_path, monkeypatch):
    called = []
    for name in ("collect_licensed", "collect_org", "collect_m365"):
        monkeypatch.setattr(graph, name, lambda *a, _n=name, **k: called.append(_n))

    def boom(*a, **k):
        raise RuntimeError("3 audit window(s) failed")

    monkeypatch.setattr(audit_collect, "collect_audit", boom)
    out = jobs_main.collect(LocalStore(tmp_path), settings(), api=object())
    assert called == ["collect_licensed", "collect_org", "collect_m365"]
    assert out["errors"] == {"audit": "RuntimeError: 3 audit window(s) failed"}


def test_run_publishes_then_fails_when_a_source_failed(monkeypatch):
    ran = []
    monkeypatch.setattr(jobs_main, "open_store", lambda *a: object())
    monkeypatch.setattr(jobs_main, "collect", lambda *a: ran.append("collect") or {"errors": {"audit": "boom"}})
    monkeypatch.setattr(jobs_main, "process", lambda *a: ran.append("process"))
    monkeypatch.setattr(jobs_main, "publish_step", lambda *a: ran.append("publish") or [{"oldest_day": "2020-01-01"}])
    monkeypatch.setattr(jobs_main, "refresh_step", lambda *a, **kw: ran.append(("refresh", kw)))
    monkeypatch.setattr(jobs_main.Settings, "from_env", classmethod(lambda cls, env=None: settings()))
    with pytest.raises(RuntimeError, match="audit: boom"):
        jobs_main.main(["run"])
    assert ran == ["collect", "process", "publish", ("refresh", {"publish_results": [{"oldest_day": "2020-01-01"}]})]


def test_full_local_pipeline_collect_to_publish(tmp_path, monkeypatch):
    """Audit + licensed from fake Graph -> curate -> publish into sqlite."""
    records = [_record(1, NOW - timedelta(hours=5)), _record(2, NOW - timedelta(hours=4))]
    fake = AuditGraph(records)

    def handler(m, url, kw):
        if "getOffice365ActiveUserDetail" in url:
            return Resp(200, text=LICENSED_CSV, content=LICENSED_CSV.encode())
        return fake(m, url, kw)

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    s = settings(modules=frozenset({"core"}))
    monkeypatch.setattr(audit_collect, "collect_audit",
                        lambda a, st, se: audit_collect.AuditCollector(a, st, se, now=NOW, sleep=lambda x: None).run())
    jobs_main.collect(store, s, api=api)
    assert jobs_main.process(store) == 2
    conn = sqlite3.connect(":memory:")
    results = pub.publish(conn, store, jobs_main.publish_targets(s))
    assert results[0]["rows"] == 2
    assert conn.execute("SELECT count(*) FROM copilot_licensed_users").fetchone() == (2,)


def test_adls_store_skips_hns_directory_markers(tmp_path):
    from valuelens_jobs.storage import AdlsStore

    deleted = []

    class Container:
        def list_blobs(self, name_starts_with, include=None):
            assert include == ["metadata"]
            return [
                SimpleNamespace(name="copilot_licensed_users", metadata={"hdi_isfolder": "true"}),
                SimpleNamespace(name="copilot_licensed_users/part-0.parquet", metadata={}),
                SimpleNamespace(name="copilot_licensed_users/part-1.parquet", metadata=None),
                SimpleNamespace(name="copilot_licensed_users_old/part-0.parquet", metadata={}),
            ]

        def delete_blob(self, name):
            deleted.append(name)

    service = SimpleNamespace(get_container_client=lambda name: Container())
    store = AdlsStore("acct", root=tmp_path, service=service)
    assert store.list("raw/copilot_licensed_users") == [
        "raw/copilot_licensed_users/part-0.parquet", "raw/copilot_licensed_users/part-1.parquet"]
    store.remove([r for r in store.list("raw/copilot_licensed_users") if not r.endswith("part-0.parquet")])
    assert deleted == ["copilot_licensed_users/part-1.parquet"]