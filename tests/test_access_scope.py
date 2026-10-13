"""Org-scoped access: the scope CSV, access_people, the Fabric notebook's parity and the Azure publish sync."""
from __future__ import annotations

import base64
import json
import sqlite3
from datetime import datetime, timezone

import pytest

import notebook_source
from valuelens_core import access, org
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import access as jobs_access
from valuelens_jobs.storage import LocalStore
from valuelens_jobs.tables import write_rows

NB = "AnalyticsHub_Access_Scope.ipynb"
NOW = datetime(2026, 9, 10, 12, 0, tzinfo=timezone.utc)
HEADER = ",".join(access.SCOPE_COLUMNS)
CSV = (
    "\ufeff" + HEADER + "\n"
    "*,org,Sales,false,admin@contoso.com,installer,active,,\n"
    "Ada@Contoso.com,all,ignored,TRUE,admin@contoso.com,seed,active,Seeded,2026-01-02T03:04:05Z\n"
    "bob@contoso.com,hierarchy,VP@contoso.com,0,,,,,\n"
    "bob@contoso.com,hierarchy,vp@contoso.com,0,,,,duplicate,\n"
    ",,,,,,,,\n"
)
ORG_ROWS = [
    {"PersonId": "CEO@contoso.com", "managerUPN": ""},
    {"PersonId": "vp@contoso.com", "managerUPN": "ceo@contoso.com"},
    {"PersonId": "ic@contoso.com", "managerUPN": "VP@contoso.com"},
    {"PersonId": "loop1@contoso.com", "managerUPN": "loop2@contoso.com"},
    {"PersonId": "loop2@contoso.com", "managerUPN": "loop1@contoso.com"},
    {"PersonId": "", "managerUPN": "x"},
]


def nb():
    return notebook_source.namespace(NB, {"SCOPE_COLUMNS", "SCOPE_TYPES", "STATUSES", "MANAGED_VIA"})


# ---------------------------------------------------------------- CSV
def test_parse_scope_csv_normalises_and_dedupes():
    rows = access.parse_scope_csv(CSV)
    assert [(r["UserPrincipalName"], r["ScopeType"], r["ScopeValue"]) for r in rows] == [
        ("*", "org", "Sales"), ("ada@contoso.com", "all", ""), ("bob@contoso.com", "hierarchy", "vp@contoso.com")]
    assert [r["CanDelegate"] for r in rows] == ["false", "true", "false"]
    assert [r["GrantedVia"] for r in rows] == ["installer", "seed", "installer"]
    assert {r["Status"] for r in rows} == {"active"}
    assert rows[1]["CreatedAt"] == "2026-01-02T03:04:05Z" and rows[1]["Note"] == "Seeded"


@pytest.mark.parametrize("line, message", [
    ("nobody,all,,,,,,,", "UPN or"),
    ("a@contoso.com,team,x,,,,,,", "ScopeType"),
    ("a@contoso.com,hierarchy,Some Name,,,,,,", "root person"),
    ("a@contoso.com,org,,,,,,,", "org scope needs a value"),
    ("a@contoso.com,all,,,,share,,,", "GrantedVia"),
    ("a@contoso.com,all,,,,,revoked,,", "Status"),
])
def test_parse_scope_csv_rejects_bad_rows(line, message):
    with pytest.raises(ValueError, match=message):
        access.parse_scope_csv(HEADER + "\n" + line + "\n")


def test_parse_scope_csv_needs_the_key_columns():
    with pytest.raises(ValueError, match="missing column"):
        access.parse_scope_csv("Upn,Scope\na@contoso.com,all\n")
    with pytest.raises(ValueError):
        access.parse_scope_csv("")


# ---------------------------------------------------------------- access_people
def test_access_people_builds_chains_and_keeps_org_path():
    people = dict(org.access_people(ORG_ROWS))
    assert people["ceo@contoso.com"] == "ceo@contoso.com"
    assert people["ic@contoso.com"] == "ceo@contoso.com|vp@contoso.com|ic@contoso.com"
    assert people["loop1@contoso.com"].split("|")[-1] == "loop1@contoso.com"
    assert "" not in people
    kept = org.access_people([{"PersonId": "a@x.com", "OrgPath": "Top@x.com|A@x.com"}])
    assert kept == [("a@x.com", "top@x.com|a@x.com")]


def test_notebook_matches_core():
    ns = nb()
    assert ns["SCOPE_COLUMNS"] == access.SCOPE_COLUMNS
    assert ns["SCOPE_TYPES"] == access.SCOPE_TYPES and ns["STATUSES"] == access.STATUSES
    assert ns["MANAGED_VIA"] == access.MANAGED_VIA
    assert ns["parse_scope_csv"](CSV) == access.parse_scope_csv(CSV)
    assert ns["access_people"](ORG_ROWS) == org.access_people(ORG_ROWS)
    # The notebook's own chain builder agrees with build_hierarchy's OrgPath.
    hier = org.build_hierarchy(ORG_ROWS)
    assert ns["org_paths"](ORG_ROWS) == {k: v["OrgPath"] for k, v in hier.items()}
    for line in ("a@contoso.com,team,x,,,,,,", "a@contoso.com,all,,,,share,,,"):
        with pytest.raises(ValueError):
            ns["parse_scope_csv"](HEADER + "\n" + line + "\n")


def test_notebook_merge_keeps_app_grants():
    ns = nb()
    existing = [
        {"UserPrincipalName": "old@contoso.com", "ScopeType": "all", "ScopeValue": "", "GrantedVia": "installer"},
        {"UserPrincipalName": "seed@contoso.com", "ScopeType": "all", "ScopeValue": "", "GrantedVia": "seed"},
        {"UserPrincipalName": "d@contoso.com", "ScopeType": "hierarchy", "ScopeValue": "vp@contoso.com",
         "GrantedVia": "share"},
        {"UserPrincipalName": "bob@contoso.com", "ScopeType": "hierarchy", "ScopeValue": "vp@contoso.com",
         "GrantedVia": "share"},
    ]
    merged = ns["merge_scope"](existing, access.parse_scope_csv(CSV))
    keys = [(r["UserPrincipalName"], r["GrantedVia"]) for r in merged]
    assert keys == [("d@contoso.com", "share"), ("*", "installer"), ("ada@contoso.com", "seed"),
                    ("bob@contoso.com", "installer")]


def test_notebook_role_scripts():
    ns = nb()
    assert ns["role_scripts"]("") == []
    role = {"name": "Scoped viewers", "modelPermission": "read", "members": [{"memberName": "obj:g@t"}]}
    b64 = base64.b64encode(json.dumps([{"dataset": "ValueLens", "role": role}]).encode()).decode()
    [(dataset, script)] = ns["role_scripts"](b64)
    assert dataset == "ValueLens"
    assert script == {"createOrReplace": {"object": {"database": "ValueLens", "role": "Scoped viewers"}, "role": role}}
    # The installer writes the same JSON to a file when the member list is large; extra fields are ignored.
    text = json.dumps([{"dataset": "ValueLens", "datasetId": "ds-1", "role": role}])
    assert ns["role_scripts_json"](text) == [(dataset, script)]
    assert ns["role_scripts_json"]("  ") == []


# ---------------------------------------------------------------- Azure sync
def _access_tables(conn):
    conn.execute("CREATE TABLE access_scope (UserPrincipalName TEXT NOT NULL, ScopeType TEXT NOT NULL, "
                 "ScopeValue TEXT NOT NULL DEFAULT '', CanDelegate INTEGER NOT NULL DEFAULT 0, GrantedBy TEXT, "
                 "GrantedVia TEXT NOT NULL DEFAULT 'installer', Status TEXT NOT NULL DEFAULT 'active', Note TEXT, "
                 "CreatedAt TEXT NOT NULL, UNIQUE (UserPrincipalName, ScopeType, ScopeValue))")
    conn.execute("CREATE TABLE access_people (PersonId TEXT, OrgPath TEXT)")


def test_sync_access_skips_before_migration(tmp_path):
    conn = sqlite3.connect(":memory:")
    assert jobs_access.sync_access(conn, LocalStore(tmp_path)) == {"skipped": True}


def test_sync_access_replaces_installer_rows_and_keeps_shares(tmp_path):
    store = LocalStore(tmp_path)
    conn = sqlite3.connect(":memory:")
    _access_tables(conn)
    conn.executemany("INSERT INTO access_scope (UserPrincipalName, ScopeType, ScopeValue, GrantedVia, CreatedAt) "
                     "VALUES (?, ?, ?, ?, '2026-01-01 00:00:00')", [
                         ("old@contoso.com", "all", "", "installer"),
                         ("d@contoso.com", "hierarchy", "vp@contoso.com", "share"),
                         ("bob@contoso.com", "hierarchy", "vp@contoso.com", "share"),
                     ])
    # No file yet: the scopes stay as they are.
    assert "scope_rows" not in jobs_access.sync_access(conn, store)
    assert conn.execute("SELECT count(*) FROM access_scope").fetchone() == (3,)

    path = store.path(jobs_access.ACCESS_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(CSV, encoding="utf-8")
    write_rows(store.path("raw/copilot_org_data/part-0.parquet"), ["PersonId", "managerUPN", "OrgPath"],
               [("ceo@contoso.com", "", "ceo@contoso.com"), ("vp@contoso.com", "ceo@contoso.com", ""),
                ("ic@contoso.com", "vp@contoso.com", None)])
    out = jobs_access.sync_access(conn, store)
    assert out == {"scope_rows": 3, "people": 3}
    rows = conn.execute("SELECT UserPrincipalName, ScopeType, ScopeValue, CanDelegate, GrantedVia, CreatedAt "
                        "FROM access_scope ORDER BY UserPrincipalName, ScopeType").fetchall()
    assert [r[:5] for r in rows] == [
        ("*", "org", "Sales", 0, "installer"),
        ("ada@contoso.com", "all", "", 1, "seed"),
        ("bob@contoso.com", "hierarchy", "vp@contoso.com", 0, "installer"),
        ("d@contoso.com", "hierarchy", "vp@contoso.com", 0, "share"),
    ]
    assert rows[1][5] == "2026-01-02 03:04:05"
    assert conn.execute("SELECT * FROM access_people ORDER BY PersonId").fetchall() == [
        ("ceo@contoso.com", "ceo@contoso.com"),
        ("ic@contoso.com", "ceo@contoso.com|vp@contoso.com|ic@contoso.com"),
        ("vp@contoso.com", "ceo@contoso.com|vp@contoso.com"),
    ]


def test_sync_scope_stamps_rows_without_a_date():
    conn = sqlite3.connect(":memory:")
    _access_tables(conn)
    jobs_access.sync_scope(conn, access.parse_scope_csv(HEADER + "\n*,all,,,,,,,\n"), now=NOW)
    assert conn.execute("SELECT CreatedAt FROM access_scope").fetchone() == ("2026-09-10 12:00:00",)


def test_publish_step_runs_the_access_sync_and_survives_its_failure(tmp_path, monkeypatch):
    class Conn:
        closed = rolled = False

        def close(self):
            self.closed = True

        def rollback(self):
            self.rolled = True

    monkeypatch.setattr("valuelens_jobs.publish.publish", lambda conn, store, targets: [{"table": "x"}])
    monkeypatch.setattr(jobs_access, "sync_access", lambda conn, store: {"people": 2})
    conn = Conn()
    settings = type("S", (), {"modules": ["core"]})()
    monkeypatch.setattr(jobs_main, "publish_targets", lambda s: ["org"])
    assert jobs_main.publish_step(LocalStore(tmp_path), settings, conn) == [{"table": "x"}, {"table": "access", "people": 2}]
    assert conn.closed

    def boom(conn, store):
        raise RuntimeError("bad csv")

    monkeypatch.setattr(jobs_access, "sync_access", boom)
    conn = Conn()
    out = jobs_main.publish_step(LocalStore(tmp_path), settings, conn)
    assert out[-1] == {"table": "access", "error": "RuntimeError: bad csv"} and conn.rolled and conn.closed


def test_access_step_runs_the_sync_alone(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(jobs_main, "access_step", lambda store, settings: calls.append("access") or {})
    monkeypatch.setattr(jobs_main, "publish_step", lambda store, settings: calls.append("publish") or [])
    monkeypatch.setattr(jobs_main, "refresh_step", lambda settings, publish_results=None: calls.append("refresh"))
    env = {"VALUELENS_MODULES": "core"}
    assert jobs_main.main(["run", "--data-dir", str(tmp_path), "--steps", "access,refresh"], env) == 0
    assert calls == ["access", "refresh"]
    calls.clear()
    # With publish, the sync is part of it.
    assert jobs_main.main(["run", "--data-dir", str(tmp_path), "--steps", "publish,access"], env) == 0
    assert calls == ["publish"]
    assert "access" not in jobs_main.DEFAULT_STEPS
