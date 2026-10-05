"""valuelens-jobs entry point.

    python -m valuelens_jobs run --steps collect,process,publish,refresh
    python -m valuelens_jobs process --data-dir <dir>      # local / mounted data
    python -m valuelens_jobs migrate

Step order mirrors the Fabric CopilotAdoptionPipeline. `process` is implemented on the
shared DuckDB core; collect, publish, refresh and migrate are MVP (Phase 1) work and
fail loudly rather than pretending to succeed.

Data layout (same under a local directory or the ADLS account):
    raw/copilot_interactions_parsed/*.parquet
    raw/copilot_licensed_users/*.parquet   (optional)
    raw/agents_365/*.parquet               (optional)
    curated/copilot_interactions_curated/part-0.parquet
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

import duckdb

from valuelens_core import curate

log = logging.getLogger("valuelens_jobs")
STEPS = ("collect", "process", "publish", "refresh")


class NotYetImplemented(RuntimeError):
    pass


def _glob(base: Path, table: str):
    folder = base / "raw" / table
    if folder.is_dir() and any(folder.glob("*.parquet")):
        return f"read_parquet('{(folder / '*.parquet').as_posix()}')"
    return None


def process(data_dir: str, *, exclude_agent_identities=True, include_raw_passthrough=False) -> int:
    base = Path(data_dir)
    interactions = _glob(base, "copilot_interactions_parsed")
    if not interactions:
        raise FileNotFoundError(f"no parquet under {base / 'raw' / 'copilot_interactions_parsed'}")
    con = duckdb.connect()
    rel = curate(con, interactions, _glob(base, "copilot_licensed_users"), _glob(base, "agents_365"),
                 exclude_agent_identities=exclude_agent_identities,
                 include_raw_passthrough=include_raw_passthrough)
    out = base / "curated" / "copilot_interactions_curated"
    out.mkdir(parents=True, exist_ok=True)
    target = (out / "part-0.parquet").as_posix().replace("'", "''")
    con.execute(f"COPY ({rel.sql_query()}) TO '{target}' (FORMAT PARQUET)")
    rows = rel.count("*").fetchone()[0]
    log.info("process: wrote %s curated rows to %s", rows, target)
    return rows


def _pending(step: str):
    raise NotYetImplemented(
        f"step '{step}' is Phase 1 work (see docs/plans/AZURE-HOSTED-PLAN.md section 7)")


def main(argv=None) -> int:
    logging.basicConfig(level=os.environ.get("VALUELENS_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    ap = argparse.ArgumentParser(prog="valuelens_jobs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("--steps", default=",".join(STEPS))
    run.add_argument("--data-dir", default=os.environ.get("VALUELENS_DATA_DIR"))
    proc = sub.add_parser("process")
    proc.add_argument("--data-dir", required=True)
    proc.add_argument("--keep-agent-identities", action="store_true")
    proc.add_argument("--raw-passthrough", action="store_true")
    sub.add_parser("migrate")
    args = ap.parse_args(argv)

    if args.cmd == "process":
        process(args.data_dir, exclude_agent_identities=not args.keep_agent_identities,
                include_raw_passthrough=args.raw_passthrough)
        return 0
    if args.cmd == "migrate":
        _pending("migrate")
    steps = [s.strip() for s in args.steps.split(",") if s.strip()]
    unknown = [s for s in steps if s not in STEPS]
    if unknown:
        ap.error(f"unknown steps {unknown}; expected a subset of {list(STEPS)}")
    for step in STEPS:
        if step not in steps:
            continue
        log.info("step %s: start", step)
        if step == "process":
            if not args.data_dir:
                _pending("process (ADLS I/O)")
            process(args.data_dir)
        else:
            _pending(step)
        log.info("step %s: done", step)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except NotYetImplemented as exc:
        log.error("%s", exc)
        sys.exit(2)
