"""Azure SQL connection (managed identity token) and schema migrations."""
from __future__ import annotations

import logging
import re
import struct
import time
import uuid
from pathlib import Path

from .api import SQL

log = logging.getLogger("valuelens_jobs.sql")

SQL_COPT_SS_ACCESS_TOKEN = 1256
MIGRATION = re.compile(r"^V(\d+)__.+\.sql$", re.IGNORECASE)
GO = re.compile(r"^\s*GO\s*;?\s*$", re.IGNORECASE | re.MULTILINE)
# Serverless databases resume from auto-pause on the first connection: 40613 / 40197 / 40501.
RESUMING = ("40613", "40197", "40501", "not currently available")


def access_token_struct(token: str) -> bytes:
    raw = token.encode("utf-16-le")
    return struct.pack(f"<I{len(raw)}s", len(raw), raw)


def connect(settings, tokens, *, attempts: int = 8, sleep=time.sleep):
    import pyodbc

    conn_str = (
        "Driver={ODBC Driver 18 for SQL Server};"
        f"Server=tcp:{settings.sql_server},1433;Database={settings.sql_database};"
        "Encrypt=yes;TrustServerCertificate=no;Connection Timeout=60"
    )
    for attempt in range(1, attempts + 1):
        try:
            token = access_token_struct(tokens.get(SQL))
            return pyodbc.connect(conn_str, attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token}, autocommit=False)
        except pyodbc.Error as exc:
            if attempt == attempts or not any(code in str(exc) for code in RESUMING):
                raise
            wait = min(60, 10 * attempt)
            log.info("SQL database is resuming (%s); retrying in %ss", exc.args[0] if exc.args else exc, wait)
            sleep(wait)


def migrations(folder) -> list[tuple[int, Path]]:
    found = []
    for p in sorted(Path(folder).glob("*.sql")):
        m = MIGRATION.match(p.name)
        if m:
            found.append((int(m.group(1)), p))
    versions = [v for v, _ in found]
    if len(set(versions)) != len(versions):
        raise ValueError(f"Duplicate migration versions in {folder}: {versions}")
    return sorted(found)


def batches(script: str) -> list[str]:
    return [part.strip() for part in GO.split(script) if part.strip()]


def applied_versions(conn) -> set[int]:
    cur = conn.cursor()
    try:
        cur.execute("SELECT version FROM dbo.schema_version")
        return {int(r[0]) for r in cur.fetchall()}
    except Exception:
        conn.rollback()
        return set()


def migrate(conn, folder) -> list[int]:
    done = applied_versions(conn)
    ran = []
    for version, path in migrations(folder):
        if version in done:
            continue
        log.info("migrate: applying %s", path.name)
        cur = conn.cursor()
        for batch in batches(path.read_text(encoding="utf-8")):
            cur.execute(batch)
        cur.execute("IF NOT EXISTS (SELECT 1 FROM dbo.schema_version WHERE version = ?) "
                    "INSERT dbo.schema_version (version, description) VALUES (?, ?)",
                    (version, version, path.stem.split("__", 1)[-1][:200]))
        conn.commit()
        ran.append(version)
    log.info("migrate: %s applied, %s already present", len(ran), len(done))
    return ran


def sid_literal(client_id: str) -> str:
    """Entra application SID for `CREATE USER ... WITH SID`: the app ID GUID as little-endian bytes."""
    return "0x" + uuid.UUID(client_id).bytes_le.hex().upper()


def reader_statements(name: str, client_id: str) -> list[str]:
    if not name or not client_id:
        return []
    sid = sid_literal(client_id)
    quoted = "[" + name.replace("]", "]]") + "]"
    literal = "N'" + name.replace("'", "''") + "'"
    return [
        f"IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = {literal}) "
        f"CREATE USER {quoted} WITH SID = {sid}, TYPE = E",
        f"IF IS_ROLEMEMBER('db_datareader', {literal}) = 0 ALTER ROLE db_datareader ADD MEMBER {quoted}",
    ]


def ensure_reader(conn, name: str, client_id: str) -> bool:
    """Grant the Power BI credential (SQL reader app) db_datareader without needing Graph on the server."""
    statements = reader_statements(name, client_id)
    if not statements:
        log.warning("migrate: VALUELENS_SQL_READER_NAME/CLIENT_ID not set; the Power BI reader user was not created")
        return False
    cur = conn.cursor()
    for stmt in statements:
        cur.execute(stmt)
    conn.commit()
    log.info("migrate: %s can read the database", name)
    return True


def default_migrations_dir() -> Path:
    here = Path(__file__).resolve()
    for candidate in (Path("/app/sql/migrations"), here.parents[2] / "sql" / "migrations"):
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("SQL migrations folder not found (set VALUELENS_MIGRATIONS_DIR).")
