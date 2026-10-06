"""Purview audit log (Copilot interactions) -> raw/copilot_interactions_parsed/day-YYYYMMDD.parquet.

Port of the Fabric `Copilot_Audit_Log_Ingester` notebook:
* the same window grid (`CHUNK_HOURS`), bounded concurrency and per-query wait ceiling;
* a manifest of finished windows so a failed run resumes without re-querying them;
* windows within the trailing look-back are always re-queried (late-arriving records);
* records are canonicalised and flattened by `valuelens_core.audit` (golden-checked against Spark);
* new rows replace existing rows with the same `Id` (the notebook's Delta MERGE), one file per day.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import duckdb

from valuelens_core import audit

from ..api import raise_for_status
from ..tables import ident, q

log = logging.getLogger("valuelens_jobs.collect.audit")

QUERIES = "https://graph.microsoft.com/beta/security/auditLog/queries"
PARSED = "raw/copilot_interactions_parsed"
STAGING = "raw/_audit_staging"
STATE = "raw/_state/audit.json"
CHUNK_HOURS = 8
MAX_CONCURRENT_QUERIES = 6
MAX_WAIT_MIN_PER_QUERY = 240
POLL_INTERVAL_SEC = 30


def day_file(day) -> str:
    return f"{PARSED}/day-{day:%Y%m%d}.parquet" if day else f"{PARSED}/day-none.parquet"


def _iso(value) -> str:
    return audit._as_utc_datetime(value).isoformat()


class AuditCollector:
    def __init__(self, api, store, settings, *, now=None, sleep=time.sleep, poll_seconds=POLL_INTERVAL_SEC,
                 max_wait_minutes=MAX_WAIT_MIN_PER_QUERY, chunk_hours=CHUNK_HOURS,
                 max_concurrent=MAX_CONCURRENT_QUERIES):
        self.api, self.store, self.settings = api, store, settings
        self.end = now or datetime.now(timezone.utc)
        self.sleep, self.poll_seconds, self.max_wait_minutes = sleep, poll_seconds, max_wait_minutes
        self.chunk_hours, self.max_concurrent = chunk_hours, max_concurrent
        self.lookback = max(int(settings.audit_lookback_days), 0)
        self._lock = threading.RLock()
        self.state = store.read_json(STATE, {}) or {}
        self.manifest = dict(self.state.get("windows") or {})

    # -------------------------------------------------------------- window plan
    def plan(self):
        hw = self.state.get("high_water_mark")
        if hw:
            start = audit.determine_incremental_start(self.end, hw, self.lookback)
        else:
            start = self.end - timedelta(days=max(int(self.settings.audit_history_days), self.lookback, 1))
        return audit.build_windows(start, self.end, self.chunk_hours)

    def _files(self, key):
        return sorted(rel for rel in self.store.list(STAGING) if rel.split("/")[-1].startswith(f"win_{key}_"))

    def _reusable(self, key, win_end, entry) -> bool:
        if not entry or entry.get("status") != "succeeded" or not entry.get("completed_at"):
            return False
        if audit._as_utc_datetime(win_end) > self.end - timedelta(days=self.lookback):
            return False
        recorded = entry.get("files") or []
        if not recorded:
            return int(entry.get("rows", 0) or 0) == 0
        present = set(self._files(key))
        return all(f"{STAGING}/{name}" in present for name in recorded)

    def _mark(self, key, status, **extra):
        with self._lock:
            entry = dict(self.manifest.get(key) or {})
            entry.update(extra, status=status)
            self.manifest[key] = entry
            self._save()

    def _save(self):
        with self._lock:
            self.state["windows"] = self.manifest
            self.store.write_json(STATE, self.state)

    # -------------------------------------------------------------- Graph
    def create_query(self, ws, we) -> str:
        body = {
            "displayName": f"Copilot Interactions {ws:%Y%m%d%H%M}-{we:%Y%m%d%H%M}",
            "filterStartDateTime": ws.isoformat(),
            "filterEndDateTime": we.isoformat(),
            "recordTypeFilters": ["copilotInteraction"],
            "operationFilters": [],
        }
        r = self.api.post(QUERIES, json=body, timeout=60)
        if r.status_code == 403:
            raise PermissionError("Graph returned 403 creating an audit log query. The jobs' managed identity "
                                  "needs AuditLogsQuery.Read.All; re-run the installer to grant it.")
        raise_for_status(r, "create audit query")
        return r.json()["id"]

    def wait(self, qid: str):
        deadline = time.monotonic() + self.max_wait_minutes * 60
        while True:
            r = self.api.get(f"{QUERIES}/{qid}", timeout=60)
            raise_for_status(r, f"audit query {qid}")
            payload = r.json()
            status = payload.get("status") if isinstance(payload, dict) else None
            if not isinstance(status, str) or not status.strip():
                raise RuntimeError(f"Query {qid} returned missing/invalid status: {status!r}")
            status = status.strip().lower()
            if status == "succeeded":
                return
            if status in ("failed", "cancelled"):
                raise RuntimeError(f"Query {qid} ended with status: {status}")
            if status not in ("notstarted", "running"):
                raise RuntimeError(f"Query {qid} returned unexpected status: {status}")
            if time.monotonic() > deadline:
                raise TimeoutError(f"Query {qid} did not succeed within {self.max_wait_minutes} min.")
            self.sleep(self.poll_seconds)

    @staticmethod
    def _records_url(url, qid):
        if not isinstance(url, str) or not url.strip():
            raise RuntimeError(f"Query {qid} returned missing/invalid @odata.nextLink: {url!r}")
        p = urlparse(url.strip())
        if not (p.scheme == "https" and p.netloc == "graph.microsoft.com"
                and p.path.startswith(f"/beta/security/auditLog/queries/{qid}/records")):
            raise RuntimeError(f"Query {qid} returned non-Graph records continuation URL: {url}")
        return url.strip()

    def drain(self, qid, key):
        self.store.remove(self._files(key))
        url, seen, rows, page, files = self._records_url(f"{QUERIES}/{qid}/records?$top=999", qid), set(), 0, 0, []
        while url:
            if url in seen:
                raise RuntimeError(f"Query {qid} returned repeated pagination link cycle: {url}")
            seen.add(url)
            r = self.api.get(url, timeout=120)
            raise_for_status(r, f"audit records {qid}")
            payload = r.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("value"), list):
                raise RuntimeError(f"Query {qid} returned a malformed records page for {url}")
            values = payload["value"]
            if any(not isinstance(v, dict) for v in values):
                raise RuntimeError(f"Query {qid} records page has a non-object item for {url}")
            nxt = payload.get("@odata.nextLink")
            nxt = self._records_url(nxt, qid) if nxt is not None else None
            if values:
                rel = f"{STAGING}/win_{key}_{page:04d}.jsonl"
                path = self.store.path(rel)
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "w", encoding="utf-8") as fh:
                    for record in values:
                        fh.write(json.dumps(audit.canonicalize_audit_record(record)))
                        fh.write("\n")
                self.store.push([rel])
                files.append(rel.split("/")[-1])
                page += 1
                rows += len(values)
            url = nxt
        return rows, files

    def _window(self, ws, we):
        key = audit.stable_window_key(ws, we)
        self._mark(key, "querying", window_start=_iso(ws), window_end=_iso(we),
                   refreshed_at=datetime.now(timezone.utc).isoformat(), completed_at=None)
        qid = None
        try:
            qid = self.create_query(ws, we)
            self._mark(key, "waiting", query_id=qid)
            self.wait(qid)
            self._mark(key, "draining", query_id=qid)
            rows, files = self.drain(qid, key)
            self._mark(key, "succeeded", query_id=qid, rows=rows, pages=len(files), files=files,
                       completed_at=datetime.now(timezone.utc).isoformat())
            return key, rows
        except Exception as exc:
            self._mark(key, "failed", error=f"{type(exc).__name__}: {exc}", query_id=qid, completed_at=None)
            self.store.remove(self._files(key))
            raise

    # -------------------------------------------------------------- run
    def run(self) -> dict:
        windows = self.plan()
        self.store.pull(STAGING)
        keys = {audit.stable_window_key(ws, we): (ws, we) for ws, we in windows}
        pending = [(ws, we) for key, (ws, we) in keys.items() if not self._reusable(key, we, self.manifest.get(key))]
        log.info("audit: %s window(s) of %sh from %s; %s to query (<= %s at a time)", len(windows),
                 self.chunk_hours, windows[0][0] if windows else "-", len(pending), self.max_concurrent)
        errors = []
        with ThreadPoolExecutor(max_workers=self.max_concurrent) as pool:
            futures = {pool.submit(self._window, ws, we): (ws, we) for ws, we in pending}
            for fut in as_completed(futures):
                try:
                    key, rows = fut.result()
                    log.info("audit: window %s +%s record(s)", key, rows)
                except PermissionError:
                    raise
                except Exception as exc:
                    errors.append(f"{futures[fut][0]:%Y-%m-%d %H:%M}: {type(exc).__name__}: {exc}")
        if errors:
            raise RuntimeError(f"{len(errors)} audit window(s) failed; finished windows are kept and the next run "
                               f"resumes. First error: {errors[0]}")
        result = self.merge(keys)
        self.prune(keys)
        return result

    def merge(self, keys) -> dict:
        files = sorted(rel for rel in self.store.list(STAGING)
                       if rel.split("/")[-1].split("_", 1)[-1].rsplit("_", 1)[0] in keys)
        if not files:
            log.info("audit: no records in the window set")
            return {"rows": 0, "days": 0}
        con = duckdb.connect()
        con.execute("SET TimeZone = 'UTC'")
        cols = "{" + ", ".join(f"'{c}': 'VARCHAR'" for c in audit.STAGE_COLUMNS) + "}"
        paths = "[" + ", ".join(q(self.store.path(f)) for f in files) + "]"
        staged = f"read_json({paths}, format='newline_delimited', columns={cols})"
        rel = audit.flatten(con, staged)
        con.execute(f"CREATE TEMP TABLE new_rows AS {rel.sql_query()}")
        blank = con.execute("SELECT count(*) FROM new_rows WHERE Id IS NULL OR trim(Id) = ''").fetchone()[0]
        if blank:
            raise RuntimeError(f"{blank} parsed audit row(s) have a blank Id; refusing to merge duplicates.")
        select = ", ".join(ident(c) for c in audit.PARSED_COLUMNS)
        days = [d for (d,) in con.execute("SELECT DISTINCT InteractionDate FROM new_rows").fetchall()]
        total = 0
        for day in days:
            rel_path = day_file(day)
            self.store.pull(rel_path)
            target = self.store.path(rel_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            match = "InteractionDate IS NULL" if day is None else f"InteractionDate = DATE '{day.isoformat()}'"
            source = f"SELECT {select} FROM new_rows WHERE {match}"
            if target.is_file():
                source = (f"SELECT {select} FROM ({source} UNION ALL BY NAME SELECT {select} FROM "
                          f"read_parquet({q(target)}) WHERE Id NOT IN (SELECT Id FROM new_rows))")
            tmp = target.with_suffix(".parquet.tmp")
            con.execute(f"COPY ({source} ORDER BY CreationDate, Id) TO {q(tmp)} (FORMAT PARQUET)")
            tmp.replace(target)
            self.store.push([rel_path])
            total += con.execute(f"SELECT count(*) FROM new_rows WHERE {match}").fetchone()[0]
        newest = con.execute("SELECT max(CreationDate) FROM new_rows").fetchone()[0]
        con.close()
        if newest is not None:
            old = audit._as_utc_datetime(self.state.get("high_water_mark"))
            newest = audit._as_utc_datetime(newest)
            self.state["high_water_mark"] = (max(old, newest) if old else newest).isoformat()
        self._save()
        log.info("audit: merged %s row(s) across %s day file(s)", total, len(days))
        return {"rows": total, "days": len(days)}

    def prune(self, keys):
        stale = [k for k in self.manifest if k not in keys]
        if not stale:
            return
        self.store.remove([rel for rel in self.store.list(STAGING)
                           if rel.split("/")[-1].split("_", 1)[-1].rsplit("_", 1)[0] in stale])
        for k in stale:
            self.manifest.pop(k, None)
        self._save()


def collect_audit(api, store, settings, **kwargs) -> dict:
    return AuditCollector(api, store, settings, **kwargs).run()
