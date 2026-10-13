"""Org-scoped access on Azure: keeps dbo.access_scope and dbo.access_people up to date (publish step).

* `landing/access/access_scope.csv` is the installer-managed list (`access` command). When it's there, its
  rows replace the installer-managed rows (GrantedVia seed/installer); rows granted in the app (share) stay,
  unless the CSV has the same (person, type, value), which wins.
* `access_people` is rebuilt from the org data each run: one row per person and their manager chain.

Both tables come from migration V005. Before it has run, the sync logs and does nothing. Models without
row-level security never read them. SQL is portable (bracket quoting, `?` parameters) so tests use sqlite3.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import duckdb

from valuelens_core import org
from valuelens_core.access import MANAGED_VIA, PEOPLE_COLUMNS, PEOPLE_TABLE, SCOPE_COLUMNS, SCOPE_TABLE, \
    parse_scope_csv

from .publish import TARGETS, _columns, b
from .tables import parquet_glob

log = logging.getLogger("valuelens_jobs.access")

ACCESS_FILE = "landing/access/access_scope.csv"


def _bit(value: str) -> int:
    return 1 if value == "true" else 0


def _stamp(text: str, default: datetime) -> str:
    try:
        when = datetime.fromisoformat(text.replace("Z", "+00:00")) if text else default
    except ValueError:
        when = default
    if when.tzinfo is not None:
        when = when.astimezone(timezone.utc).replace(tzinfo=None)
    return when.replace(microsecond=0).isoformat(sep=" ")


def sync_scope(conn, rows, *, now=None) -> int:
    stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(tzinfo=None)
    cur = conn.cursor()
    marks = ", ".join("?" for _ in MANAGED_VIA)
    cur.execute(f"DELETE FROM {b(SCOPE_TABLE)} WHERE {b('GrantedVia')} IN ({marks})", MANAGED_VIA)
    cols = ", ".join(b(c) for c in SCOPE_COLUMNS)
    params = ", ".join("?" for _ in SCOPE_COLUMNS)
    for r in rows:
        cur.execute(f"DELETE FROM {b(SCOPE_TABLE)} WHERE {b('UserPrincipalName')} = ? AND {b('ScopeType')} = ? "
                    f"AND {b('ScopeValue')} = ?", (r["UserPrincipalName"], r["ScopeType"], r["ScopeValue"]))
        created = _stamp(r["CreatedAt"], stamp)
        cur.execute(f"INSERT INTO {b(SCOPE_TABLE)} ({cols}) VALUES ({params})", (
            r["UserPrincipalName"], r["ScopeType"], r["ScopeValue"], _bit(r["CanDelegate"]), r["GrantedBy"] or None,
            r["GrantedVia"], r["Status"], r["Note"] or None, created))
    conn.commit()
    return len(rows)


def read_people(store) -> list[tuple[str, str]]:
    prefix = TARGETS["org"].prefix
    store.pull(prefix)
    src = parquet_glob(store.root, prefix)
    if not src:
        return []
    con = duckdb.connect()
    try:
        con.execute(f"CREATE TEMP VIEW src AS SELECT * FROM {src}")
        have = {r[0] for r in con.execute("DESCRIBE src").fetchall()}
        wanted = [c for c in ("PersonId", "managerUPN", "displayName", "OrgPath") if c in have]
        if "PersonId" not in wanted:
            return []
        select = ", ".join(f'"{c}"' for c in wanted)
        rows = [dict(zip(wanted, r)) for r in con.execute(f"SELECT {select} FROM src").fetchall()]
    finally:
        con.close()
    return org.access_people(rows)


def sync_people(conn, people) -> int:
    cur = conn.cursor()
    cur.execute(f"DELETE FROM {b(PEOPLE_TABLE)}")
    if people:
        cols = ", ".join(b(c) for c in PEOPLE_COLUMNS)
        cur.executemany(f"INSERT INTO {b(PEOPLE_TABLE)} ({cols}) VALUES (?, ?)", people)
    conn.commit()
    return len(people)


def sync_access(conn, store) -> dict:
    if _columns(conn, SCOPE_TABLE) is None or _columns(conn, PEOPLE_TABLE) is None:
        log.info("access: the access tables aren't there yet (migration V005); skipped")
        return {"skipped": True}
    out = {}
    store.pull(ACCESS_FILE)
    path = store.path(ACCESS_FILE)
    if path.is_file():
        out["scope_rows"] = sync_scope(conn, parse_scope_csv(path.read_text(encoding="utf-8")))
        log.info("access: %s installer-managed scope row(s) loaded", out["scope_rows"])
    people = read_people(store)
    if people:
        out["people"] = sync_people(conn, people)
        log.info("access: %s people with an org path", out["people"])
    return out
