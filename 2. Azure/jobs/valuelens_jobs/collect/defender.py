"""Defender (shadow AI and agent risk). Mirrors Copilot_Defender_Ingester.ipynb; the logic is in
`valuelens_core.defender`.

Optional and fail-soft: a probe the tenant isn't licensed for, or that the managed identity can't read,
becomes a row in `defender_status` and the run carries on. Only storage errors raise.
"""
from __future__ import annotations

import logging
from datetime import timedelta

import duckdb

from valuelens_core import defender

from ..tables import parquet_glob, write_rows

log = logging.getLogger("valuelens_jobs.collect")

WATCHLIST_FILE = "landing/defender/ai_watchlist.csv"
DUCK_TYPES = {"string": "VARCHAR", "long": "BIGINT", "date": "DATE", "timestamp": "TIMESTAMP"}
SNAPSHOT_PROBES = {"installed": "installed", "cloud": "cloud_discovery", "agents": "agents"}


def prefix(key: str) -> str:
    return f"raw/{defender.TABLES[key]}"


def day_file(key: str, day) -> str:
    return f"{prefix(key)}/day-{day:%Y%m%d}.parquet"


def _schema(key):
    return [n for n, _ in defender.COLUMNS[key]], [DUCK_TYPES[t] for _, t in defender.COLUMNS[key]]


def _json(r):
    try:
        return r.json()
    except ValueError:
        return {"error": {"message": (getattr(r, "text", "") or "")[:500]}}


def transport(api):
    """`hunt(kql)` and `get(url)` in the shape the shared core expects: (status_code, json body)."""

    def hunt(kql):
        r = api.post(defender.HUNTING_URL, json={"Query": kql}, timeout=300)
        return r.status_code, _json(r)

    def get(url):
        r = api.get(url, headers=dict(defender.CLOUD_DISCOVERY_HEADERS), timeout=180)
        return r.status_code, _json(r)

    return hunt, get


def read_watchlist(store):
    """The admin's watchlist, or the starting list (written once so there's a file to edit)."""
    store.pull(WATCHLIST_FILE)
    path = store.path(WATCHLIST_FILE)
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(defender.watchlist_csv(), encoding="utf-8")
        store.push([WATCHLIST_FILE])
        log.info("defender: wrote the starting AI watchlist to %s; edit it to add tools or set postures",
                 WATCHLIST_FILE)
        return defender.default_watchlist()
    try:
        rows = defender.parse_watchlist(path.read_text(encoding="utf-8-sig"))
    except ValueError as exc:
        log.warning("defender: %s can't be read (%s); using the starting list this run", WATCHLIST_FILE, exc)
        return defender.default_watchlist()
    if not rows:
        log.warning("defender: %s lists no tools; using the starting list this run", WATCHLIST_FILE)
        return defender.default_watchlist()
    return rows


def last_loaded(store):
    store.pull(prefix("totals"))
    src = parquet_glob(store.root, prefix("totals"))
    if not src:
        return None
    return duckdb.sql(f"SELECT max(Day) FROM {src} WHERE \"Window\" = '1d'").fetchone()[0]


def _write_days(store, key, rows, start, end) -> int:
    """One file per day from `start`; a day with no rows still gets an (empty) file, replacing the old one."""
    names, types = _schema(key)
    by_day = {}
    for row in rows:
        by_day.setdefault(row[0], []).append(row)
    count, day = 0, start
    while day < end:
        rel = day_file(key, day)
        count += write_rows(store.path(rel), names, by_day.get(day, []), types)
        store.push([rel])
        day += timedelta(days=1)
    return count


def collect_defender(api, store, settings, *, today=None, now=None) -> dict:
    watchlist = read_watchlist(store)
    hunt, get = transport(api)
    today = today or defender.utc_today(now)
    result = defender.run(hunt, get, watchlist, today, last_loaded(store), now=now)
    # A probe that didn't answer keeps its last good data; V003__defender.sql creates the SQL tables
    # up front, so the model reads empty tables until a probe first answers.
    written = {"watchlist": _snapshot(store, "watchlist", result["watchlist"])}
    for key, probe in SNAPSHOT_PROBES.items():
        if result["loaded"].get(probe):
            written[key] = _snapshot(store, key, result[key])
    if result["loaded"].get("device_activity"):
        for key in ("daily", "totals"):
            store.pull(prefix(key))
            written[key] = _write_days(store, key, result[key], result["load_start"], today)
    written["status"] = _snapshot(store, "status", result["status"])
    for row in result["status"]:
        level = logging.INFO if row[2] in ("ok", "empty") else logging.WARNING
        log.log(level, "defender %s: %s from %s, %s row(s). %s", row[1], row[2], row[3], row[4], row[5])
    return {"written": written, "status": {row[1]: row[2] for row in result["status"]}}


def _snapshot(store, key, rows) -> int:
    names, types = _schema(key)
    old = store.list(prefix(key))
    target = f"{prefix(key)}/part-0.parquet"
    count = write_rows(store.path(target), names, rows, types)
    store.push([target])
    store.remove([rel for rel in old if rel != target])
    return count
