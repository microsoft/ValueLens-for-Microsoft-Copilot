"""Graph snapshot and report collectors. Each mirrors its Fabric notebook; the shaping logic lives in `valuelens_core`."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlparse

import duckdb

from valuelens_core import licensed, m365, org

from ..api import raise_for_status
from ..tables import parquet_glob, write_rows

log = logging.getLogger("valuelens_jobs.collect")

GRAPH_V1 = "https://graph.microsoft.com/v1.0"
LICENSED_URL = f"{GRAPH_V1}/reports/getOffice365ActiveUserDetail(period='D7')"


def _permission(r, what: str, permission: str):
    if r.status_code == 403:
        raise PermissionError(
            f"Graph returned 403 for {what}. The jobs' managed identity needs the {permission} "
            "application permission; re-run the installer to grant it.")


def _replace_snapshot(store, prefix: str, columns, rows) -> int:
    old = store.list(prefix)
    target = f"{prefix}/part-0.parquet"
    count = write_rows(store.path(target), columns, rows)
    store.push([target])
    store.remove([rel for rel in old if rel != target])
    return count


def collect_licensed(api, store, settings, *, allow_empty=False) -> int:
    prefix = f"raw/{licensed.TABLE}"
    r = api.get(LICENSED_URL, timeout=300)
    _permission(r, "getOffice365ActiveUserDetail", "Reports.Read.All")
    raise_for_status(r, "licensed users report")
    text = r.content.decode("utf-8-sig") if isinstance(r.content, bytes) else r.text
    columns, rows = licensed.build_snapshot(text, table_exists=bool(store.list(prefix)), allow_empty=allow_empty)
    count = _replace_snapshot(store, prefix, columns, rows)
    log.info("licensed: %s users written", count)
    return count


def _is_graph(url: str) -> bool:
    p = urlparse(url)
    return p.scheme == "https" and p.netloc == "graph.microsoft.com"


def collect_org(api, store, settings, *, allow_empty=False) -> int:
    prefix = f"raw/{org.TABLE}"
    users, url, page, seen = [], org.USERS_URL, 0, set()
    while url:
        if url in seen:
            raise RuntimeError(f"Graph /users paging looped back to {url}; refusing to overwrite org data.")
        seen.add(url)
        page += 1
        r = api.get(url)
        _permission(r, "/users", "User.Read.All")
        raise_for_status(r, f"/users page {page}")
        value, url = org.validate_users_page(r.json(), page)
        if url and not _is_graph(url):
            raise RuntimeError(f"Graph /users returned a non-Graph nextLink: {url}")
        users.extend(value)
    columns, rows = org.build_snapshot(users, table_exists=bool(store.list(prefix)), allow_empty=allow_empty)
    err = columns.index("HierarchyError")
    cycles = sorted({row[err] for row in rows if row[err]})
    if cycles:
        log.warning("org: %s distinct manager cycle(s); rows kept, chain truncated. Examples: %s",
                    len(cycles), "; ".join(cycles[:20]))
    count = _replace_snapshot(store, prefix, columns, rows)
    log.info("org: %s people written from %s page(s)", count, page)
    return count


def _m365_report(api, function, day):
    r = api.get(f"{GRAPH_V1}/reports/{function}(date={day.isoformat()})", timeout=180)
    _permission(r, function, "Reports.Read.All")
    if r.status_code in (400, 404):
        raise m365.ReportUnavailable(f"{function} {day}: HTTP {r.status_code}")
    raise_for_status(r, f"{function} {day}")
    return m365.parse_csv(r.content)


def m365_day_file(day) -> str:
    return f"raw/{m365.TABLE}/day-{day:%Y%m%d}.parquet"


def collect_m365(api, store, settings, *, today=None, reread_days=m365.REREAD_DAYS) -> dict:
    prefix = f"raw/{m365.TABLE}"
    store.pull(prefix)
    today = today or datetime.now(timezone.utc).date()
    loaded, concealed = set(), set()
    src = parquet_glob(store.root, prefix)
    if src:
        for day, share in duckdb.sql(
                f"SELECT ActivityDate, avg(CASE WHEN contains(UPN, '@') THEN 0 ELSE 1 END) "
                f"FROM {src} GROUP BY 1").fetchall():
            loaded.add(day)
            if share > 0.5:
                concealed.add(day)
    todo = m365.days_to_load(today, loaded, concealed, reread_days)
    log.info("m365: %s day(s) loaded; loading %s", len(loaded), len(todo))

    def read_day(day):
        def one(key):
            try:
                return key, _m365_report(api, m365.REPORTS[key], day)
            except m365.ReportUnavailable:
                return key, None

        with ThreadPoolExecutor(max_workers=3) as pool:
            return dict(pool.map(one, m365.REPORTS))

    names = [n for n, _, _ in m365.SCHEMA]
    types = [t for _, t, _ in m365.SCHEMA]
    written, skipped, kept = [], [], []
    people_seen = concealed_seen = 0
    for day in todo:
        try:
            reports = read_day(day)
        except PermissionError:
            raise
        except Exception as exc:
            skipped.append((day, f"{type(exc).__name__}: {exc}"))
            log.warning("m365 %s: skipped (%s)", day, exc)
            continue
        missing = sorted(k for k, recs in reports.items() if recs is None)
        if day in loaded and missing:
            kept.append(day)
            continue
        people = {}
        for key, recs in reports.items():
            if recs:
                m365.add_report(people, key, recs)
        rows = m365.build_rows(day, people, datetime.now(timezone.utc).replace(tzinfo=None))
        if not rows:
            continue
        write_rows(store.path(m365_day_file(day)), names, rows, types)
        store.push([m365_day_file(day)])
        written.append(day)
        if len(rows) >= people_seen:
            people_seen, concealed_seen = len(rows), sum(1 for r in rows if "@" not in r[2])
    if todo and not written and len(skipped) == len(todo):
        raise RuntimeError(f"Every M365 activity day failed to load. First error: {skipped[0][1]}")
    if people_seen and concealed_seen / people_seen > 0.5:
        log.warning("m365: most user names are concealed, so activity cannot be matched to Copilot use. "
                    "In the Microsoft 365 admin center (Settings > Org settings > Reports) turn off "
                    "'Display concealed user, group, and site names in all reports'; the next run reloads "
                    "every concealed day still in the 28-day window.")
    log.info("m365: wrote %s day(s), kept %s, skipped %s", len(written), len(kept), len(skipped))
    return {"written": written, "kept": kept, "skipped": skipped}
