"""Small DuckDB/Parquet helpers shared by the collectors."""
from __future__ import annotations

import json
import tempfile
from datetime import date, datetime
from pathlib import Path

import duckdb


def q(path) -> str:
    return "'" + Path(path).as_posix().replace("'", "''") + "'"


def ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _json_default(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def write_rows(path, columns, rows, types=None) -> int:
    """Write `rows` (sequences in `columns` order) to one Parquet file. Types default to VARCHAR."""
    types = types or ["VARCHAR"] * len(columns)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "rows.jsonl"
        with open(src, "w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(dict(zip(columns, row)), default=_json_default))
                fh.write("\n")
        spec = "{" + ", ".join("'" + c.replace("'", "''") + f"': '{t}'" for c, t in zip(columns, types)) + "}"
        select = ", ".join(ident(c) for c in columns)
        con = duckdb.connect()
        con.execute("SET TimeZone = 'UTC'")
        tmp_out = path.with_suffix(path.suffix + ".tmp")
        con.execute(f"COPY (SELECT {select} FROM read_json({q(src)}, format='newline_delimited', "
                    f"columns={spec})) TO {q(tmp_out)} (FORMAT PARQUET)")
        count = con.execute(f"SELECT count(*) FROM read_parquet({q(tmp_out)})").fetchone()[0]
        con.close()
    tmp_out.replace(path)
    return count


def parquet_glob(store_root, prefix: str):
    folder = Path(store_root) / prefix
    if folder.is_dir() and any(folder.glob("*.parquet")):
        return f"read_parquet({q(folder / '*.parquet')}, union_by_name=true)"
    return None
