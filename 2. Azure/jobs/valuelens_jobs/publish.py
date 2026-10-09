"""Publish curated/raw Parquet into Azure SQL for the Power BI model.

* Columns are created/added NULLable from the DuckDB types; a column is never dropped or narrowed.
* Snapshot tables (licensed users, org data, most consumption tables) are replaced in one transaction.
* Date-partitioned tables (curated interactions, M365 activity, daily consumption) are compared day by day against a
  fingerprint (row count + order-independent row hash + column list) kept in `valuelens_publish_state`;
  only changed days are rewritten (DELETE + INSERT in one transaction), vanished days are deleted.

The SQL is deliberately portable (bracket quoting, `?` parameters) so tests run it on sqlite3.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import duckdb

from .tables import ident

log = logging.getLogger("valuelens_jobs.publish")

STATE_TABLE = "valuelens_publish_state"
TEXT_LIMIT = 4000
CHUNK = 5000

TYPE_MAP = {
    "VARCHAR": f"NVARCHAR({TEXT_LIMIT})",
    "TIMESTAMP": "DATETIME2(6)",
    "TIMESTAMP WITH TIME ZONE": "DATETIME2(6)",
    "DATE": "DATE",
    "BIGINT": "BIGINT",
    "HUGEINT": "BIGINT",
    "INTEGER": "INT",
    "SMALLINT": "SMALLINT",
    "TINYINT": "SMALLINT",
    "BOOLEAN": "BIT",
    "DOUBLE": "FLOAT",
    "FLOAT": "FLOAT",
}


@dataclass(frozen=True)
class Target:
    table: str
    prefix: str
    partition: str | None = None
    # False: rewritten days don't count towards the semantic models' incremental-refresh window
    # (the consumption tables are plain imports, so they never force a full refresh).
    incremental: bool = True


TARGETS = {
    "curated": Target("copilot_interactions_curated", "curated/copilot_interactions_curated", "InteractionDate"),
    "licensed": Target("copilot_licensed_users", "raw/copilot_licensed_users"),
    "org": Target("copilot_org_data", "raw/copilot_org_data"),
    "m365": Target("m365_activity_daily", "raw/m365_activity_daily", "ActivityDate"),
}
# Consumption Central (module `consumption`): the Lakehouse table names, so the model's navigation
# works unchanged. Daily tables are published day by day; the rest are replaced each run.
CONSUMPTION_PARTITIONED = {
    "studio_tenant_daily": "usage_date",
    "studio_agent_daily": "usage_date",
    "studio_user_daily": "usage_date",
    "viva_credits_weekly": "metric_date",
}
CONSUMPTION_CURATED = ["studio_tenant_daily", "studio_agent", "studio_user", "studio_agent_daily",
                       "studio_user_daily", "viva_credits_weekly", "viva_spending_policy"]
CONSUMPTION_RAW = ["azure_ai_spend", "azure_ai_tokens", "copilot_payg_spend", "azure_deployment_health",
                   "azure_solution_spend", "azure_billing_reconciliation"]
CONSUMPTION = CONSUMPTION_CURATED + CONSUMPTION_RAW
for _name in CONSUMPTION:
    TARGETS[_name] = Target(_name, f"{'curated' if _name in CONSUMPTION_CURATED else 'raw'}/{_name}",
                            CONSUMPTION_PARTITIONED.get(_name), incremental=False)
# Defender (module `defender`): the two daily tables are published day by day, the rest replaced each run.
# They are plain imports in the model, so rewritten days never force an incremental refresh.
DEFENDER_PARTITIONED = {"defender_shadow_ai_daily": "Day", "defender_shadow_ai_totals_daily": "Day"}
DEFENDER = ["defender_ai_watchlist", "defender_shadow_ai_daily", "defender_shadow_ai_totals_daily",
            "defender_ai_installed", "defender_cloud_discovery_ai", "defender_ai_agents", "defender_status"]
for _name in DEFENDER:
    TARGETS[_name] = Target(_name, f"raw/{_name}", DEFENDER_PARTITIONED.get(_name), incremental=False)


def b(name: str) -> str:
    return "[" + name.replace("]", "]]") + "]"


def sql_type(duck_type: str) -> str:
    t = duck_type.upper()
    if t.startswith("DECIMAL"):
        return t
    if t.startswith("TIMESTAMP"):
        return TYPE_MAP["TIMESTAMP"]
    return TYPE_MAP.get(t, f"NVARCHAR({TEXT_LIMIT})")


def _columns(conn, table: str):
    cur = conn.cursor()
    try:
        cur.execute(f"SELECT * FROM {b(table)} WHERE 1 = 0")
    except Exception:
        conn.rollback()
        return None
    names = [d[0] for d in cur.description]
    cur.close()
    return names


def ensure_table(conn, table: str, schema) -> list[str]:
    """Create `table` or add missing columns. Returns the columns it added."""
    existing = _columns(conn, table)
    cur = conn.cursor()
    if existing is None:
        cols = ", ".join(f"{b(n)} {sql_type(t)} NULL" for n, t in schema)
        cur.execute(f"CREATE TABLE {b(table)} ({cols})")
        conn.commit()
        return [n for n, _ in schema]
    have = {c.lower() for c in existing}
    added = [(n, t) for n, t in schema if n.lower() not in have]
    for n, t in added:
        cur.execute(f"ALTER TABLE {b(table)} ADD {b(n)} {sql_type(t)} NULL")
    conn.commit()
    return [n for n, _ in added]


def _ensure_state(conn):
    if _columns(conn, STATE_TABLE) is None:
        conn.cursor().execute(
            f"CREATE TABLE {b(STATE_TABLE)} ({b('table_name')} NVARCHAR(128) NOT NULL, "
            f"{b('partition_key')} NVARCHAR(32) NOT NULL, {b('fingerprint')} NVARCHAR(400) NOT NULL, "
            f"{b('published_at')} DATETIME2(0) NOT NULL)")
        conn.commit()


def _select(schema) -> str:
    out = []
    for n, t in schema:
        t = t.upper()
        if t == "VARCHAR":
            out.append(f"left({ident(n)}, {TEXT_LIMIT}) AS {ident(n)}")
        elif t == "TIMESTAMP WITH TIME ZONE":
            out.append(f"CAST({ident(n)} AS TIMESTAMP) AS {ident(n)}")
        else:
            out.append(ident(n))
    return ", ".join(out)


def _insert(conn, con, table, schema, where: str) -> int:
    cols = ", ".join(b(n) for n, _ in schema)
    params = ", ".join("?" for _ in schema)
    cur = conn.cursor()
    if hasattr(cur, "fast_executemany"):
        cur.fast_executemany = True
    src = con.execute(f"SELECT {_select(schema)} FROM src WHERE {where}")
    total = 0
    while True:
        rows = src.fetchmany(CHUNK)
        if not rows:
            break
        cur.executemany(f"INSERT INTO {b(table)} ({cols}) VALUES ({params})", rows)
        total += len(rows)
    return total


def _key(day) -> str:
    return day.isoformat() if day is not None else "null"


def publish_table(conn, store_root, target: Target, *, now=None) -> dict:
    from .tables import parquet_glob

    src = parquet_glob(store_root, target.prefix)
    if not src:
        log.info("publish %s: no data yet, skipped", target.table)
        return {"table": target.table, "skipped": True}
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    con.execute(f"CREATE TEMP VIEW src AS SELECT * FROM {src}")
    schema = [(r[0], r[1]) for r in con.execute("DESCRIBE src").fetchall()]
    added = ensure_table(conn, target.table, schema)
    stamp = (now or datetime.now(timezone.utc)).replace(tzinfo=None, microsecond=0)
    cur = conn.cursor()
    if target.partition is None:
        cur.execute(f"DELETE FROM {b(target.table)}")
        n = _insert(conn, con, target.table, schema, "TRUE")
        conn.commit()
        log.info("publish %s: replaced with %s row(s)", target.table, n)
        return {"table": target.table, "rows": n, "added_columns": added}

    _ensure_state(conn)
    part = ident(target.partition)
    signature = hashlib.sha1("|".join(f"{n}:{t}" for n, t in schema).encode()).hexdigest()[:16]
    fresh = {
        _key(day): (day, f"{count}:{h}:{signature}")
        for day, count, h in con.execute(
            f"SELECT {part}, count(*), sum(hash(s)::HUGEINT) FROM src s GROUP BY 1").fetchall()
    }
    cur.execute(f"SELECT {b('partition_key')}, {b('fingerprint')} FROM {b(STATE_TABLE)} "
                f"WHERE {b('table_name')} = ?", (target.table,))
    known = dict(cur.fetchall())
    col = b(target.partition)
    changed = removed = rows = 0
    touched = []
    for key in sorted(set(known) - set(fresh)):
        _delete_partition(cur, target.table, col, key)
        cur.execute(f"DELETE FROM {b(STATE_TABLE)} WHERE {b('table_name')} = ? AND {b('partition_key')} = ?",
                    (target.table, key))
        conn.commit()
        removed += 1
        touched.append(key)
    for key, (day, fp) in sorted(fresh.items()):
        if known.get(key) == fp:
            continue
        touched.append(key)
        _delete_partition(cur, target.table, col, key)
        where = f"{part} IS NULL" if day is None else f"{part} = DATE '{day.isoformat()}'"
        rows += _insert(conn, con, target.table, schema, where)
        cur.execute(f"DELETE FROM {b(STATE_TABLE)} WHERE {b('table_name')} = ? AND {b('partition_key')} = ?",
                    (target.table, key))
        cur.execute(f"INSERT INTO {b(STATE_TABLE)} ({b('table_name')}, {b('partition_key')}, {b('fingerprint')}, "
                    f"{b('published_at')}) VALUES (?, ?, ?, ?)", (target.table, key, fp, stamp))
        conn.commit()
        changed += 1
    log.info("publish %s: %s day(s) rewritten (%s rows), %s removed, %s unchanged", target.table, changed, rows,
             removed, len(fresh) - changed)
    days = [k for k in touched if k != "null"] if target.incremental else []
    return {"table": target.table, "days_changed": changed, "days_removed": removed, "rows": rows,
            "added_columns": added, "oldest_day": min(days) if days else None}


def _delete_partition(cur, table, col, key):
    if key == "null":
        cur.execute(f"DELETE FROM {b(table)} WHERE {col} IS NULL")
    else:
        cur.execute(f"DELETE FROM {b(table)} WHERE {col} = ?", (key,))


def publish(conn, store, targets) -> list[dict]:
    results = []
    for name in targets:
        target = TARGETS[name]
        store.pull(target.prefix)
        results.append(publish_table(conn, store.root, target))
    return results
