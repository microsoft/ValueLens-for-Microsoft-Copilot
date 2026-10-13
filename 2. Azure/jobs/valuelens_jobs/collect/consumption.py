"""Shared plumbing for the consumption collectors (Copilot Studio, Viva): the tables' merged state as
Parquet in the store, and reading the drop folder's CSVs into DuckDB.

Fabric keeps these tables as Delta and merges each run's files into them. Here each table is one
Parquet file (`curated/<table>/part-0.parquet`): loaded into DuckDB, merged with the same keys and
rules as the notebooks, and written back whole (atomically) when it changed.
"""
from __future__ import annotations

import fnmatch
import logging
import re
from pathlib import Path

from ..tables import ident, q

log = logging.getLogger("valuelens_jobs.collect.consumption")


class TableState:
    """The consumption tables in one DuckDB connection, loaded from and saved to the store."""

    def __init__(self, con, store, schemas: dict, container: str = "curated"):
        self.con = con
        self.store = store
        self.schemas = schemas  # {table: [(column, duckdb type), ...]}
        self.container = container
        self.existed: set[str] = set()
        self.changed: set[str] = set()

    def prefix(self, table: str) -> str:
        return f"{self.container}/{table}"

    def columns(self, table: str) -> list[str]:
        return [c for c, _ in self.schemas[table]]

    def load(self) -> None:
        for table, schema in self.schemas.items():
            cols = ", ".join(f"{ident(c)} {t}" for c, t in schema)
            self.con.execute(f"CREATE OR REPLACE TABLE {ident(table)} ({cols})")
            files = [r for r in self.store.pull(self.prefix(table)) if r.endswith(".parquet")]
            if not files:
                continue
            self.existed.add(table)
            src = f"read_parquet({q(self.store.path(self.prefix(table)) / '*.parquet')}, union_by_name=true)"
            have = {r[0] for r in self.con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
            pick = [c for c, _ in schema if c in have]
            if pick:
                names = ", ".join(ident(c) for c in pick)
                self.con.execute(f"INSERT INTO {ident(table)} ({names}) SELECT {names} FROM {src}")

    def exists(self, table: str) -> bool:
        """Whether the table has been created yet (Fabric's `tableExists`)."""
        return table in self.existed or table in self.changed

    def count(self, table: str) -> int:
        return self.con.execute(f"SELECT count(*) FROM {ident(table)}").fetchone()[0]

    def merge(self, table: str, source: str, keys) -> None:
        """Delta `MERGE ... whenMatchedUpdateAll().whenNotMatchedInsertAll()` with null-safe keys."""
        before = self.count(table)
        match = " AND ".join(f"{ident(table)}.{ident(k)} IS NOT DISTINCT FROM s.{ident(k)}" for k in keys)
        self.con.execute(f"DELETE FROM {ident(table)} WHERE EXISTS (SELECT 1 FROM {source} s WHERE {match})")
        names = ", ".join(ident(c) for c in self.columns(table))
        self.con.execute(f"INSERT INTO {ident(table)} ({names}) SELECT {names} FROM {source}")
        self.changed.add(table)
        log.info("  %s: %s -> %s rows", table, before, self.count(table))

    def delete(self, table: str, where: str, params=None) -> None:
        if not self.exists(table):
            return
        self.con.execute(f"DELETE FROM {ident(table)} WHERE {where}", params or [])
        self.changed.add(table)

    def replace(self, table: str, source: str) -> None:
        self.con.execute(f"DELETE FROM {ident(table)}")
        names = ", ".join(ident(c) for c in self.columns(table))
        self.con.execute(f"INSERT INTO {ident(table)} ({names}) SELECT {names} FROM {source}")
        self.changed.add(table)
        log.info("  %s: replaced, %s rows", table, self.count(table))

    def save(self) -> dict:
        out = {}
        for table in sorted(self.changed):
            rel = f"{self.prefix(table)}/part-0.parquet"
            target = self.store.path(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".tmp")
            self.con.execute(f"COPY (SELECT * FROM {ident(table)}) TO {q(tmp)} (FORMAT PARQUET)")
            tmp.replace(target)
            self.store.push([rel])
            stale = [r for r in self.store.list(self.prefix(table)) if r != rel]
            if stale:
                self.store.remove(stale)
            out[table] = self.count(table)
        return out


def match_files(names, patterns, *, include=lambda n: True) -> list[str]:
    """CSV names matching the first pattern that matches anything (case-insensitive)."""
    names = [n for n in names if n.lower().endswith(".csv") and include(n)]
    for p in patterns:
        hits = sorted(n for n in names if fnmatch.fnmatchcase(n.lower(), p.lower()))
        if hits:
            return hits
    return []


def read_csvs(con, files, view: str, norm) -> set | None:
    """Every CSV in `files` unioned by name into temp table `view`, with columns renamed to
    `norm(header)` (first wins) and a `__source_file` column. None when there are no rows.

    The quote/escape settings matter: agent names, scenarios and knowledge sources are free text,
    and one comma or line break inside a value would shift every column after it for that row.
    """
    parts, columns = [], set()
    for path in files:
        path = Path(path)
        src = (f"read_csv({q(path)}, header=true, all_varchar=true, delim=',', quote='\"', escape='\"', "
               "null_padding=true)")
        try:
            names = [d[0] for d in con.execute(f"SELECT * FROM {src} LIMIT 0").description]
        except Exception as exc:
            log.warning("  can't read %s (%s); skipped", path.name, exc)
            continue
        seen, select = set(), []
        for n in names:
            k = norm(n)
            if k and k not in seen:
                seen.add(k)
                select.append(f"{ident(n)} AS {ident(k)}")
        if not select:
            continue
        columns |= seen
        literal = "'" + path.name.replace("'", "''") + "'"
        parts.append(f"SELECT {', '.join(select)}, {literal} AS __source_file FROM {src}")
    if not parts:
        return None
    con.execute(f"CREATE OR REPLACE TEMP TABLE {ident(view)} AS " + " UNION ALL BY NAME ".join(parts))
    n = con.execute(f"SELECT count(*) FROM {ident(view)}").fetchone()[0]
    log.info("  %s file(s), %s rows: %s", len(parts), n, ", ".join(Path(p).name for p in files))
    return columns if n else None


def text(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def sql_list(values) -> str:
    return ", ".join(text(v) for v in values) or "NULL"


GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
