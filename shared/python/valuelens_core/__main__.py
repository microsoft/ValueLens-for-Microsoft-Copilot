"""python -m valuelens_core --interactions <file> [--licensed <file>] [--agents <file>] --out <file.parquet>

Inputs may be Parquet, CSV or JSON/NDJSON (anything DuckDB's readers accept).
"""
import argparse
import sys

import duckdb

from .processor import curate


def _reader(path: str) -> str:
    p = path.replace("'", "''")
    lower = path.lower()
    if lower.endswith(".parquet") or "*" in lower and ".parquet" in lower:
        return f"read_parquet('{p}')"
    if lower.endswith((".csv", ".tsv", ".txt")):
        return f"read_csv_auto('{p}', all_varchar = true)"
    return f"read_json_auto('{p}')"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="valuelens_core", description=__doc__)
    ap.add_argument("--interactions", required=True)
    ap.add_argument("--licensed")
    ap.add_argument("--agents")
    ap.add_argument("--out", required=True, help="Output Parquet file")
    ap.add_argument("--keep-agent-identities", action="store_true",
                    help="Do not exclude Security Copilot agent identities")
    ap.add_argument("--raw-passthrough", action="store_true")
    args = ap.parse_args(argv)

    con = duckdb.connect()
    rel = curate(con, _reader(args.interactions),
                 _reader(args.licensed) if args.licensed else None,
                 _reader(args.agents) if args.agents else None,
                 exclude_agent_identities=not args.keep_agent_identities,
                 include_raw_passthrough=args.raw_passthrough)
    out = args.out.replace("'", "''")
    con.execute(f"COPY ({rel.sql_query()}) TO '{out}' (FORMAT PARQUET)")
    print(f"wrote {rel.count('*').fetchone()[0]} rows to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
