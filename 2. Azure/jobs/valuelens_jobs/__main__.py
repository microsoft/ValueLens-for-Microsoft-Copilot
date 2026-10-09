"""valuelens-jobs entry point.

    python -m valuelens_jobs run --steps collect,process,publish,refresh
    python -m valuelens_jobs run --data-dir <dir> --steps process      # local / mounted data
    python -m valuelens_jobs process --data-dir <dir>
    python -m valuelens_jobs migrate

Step order mirrors the Fabric CopilotAdoptionPipeline. Without `--data-dir` the job works on the
ADLS account in VALUELENS_STORAGE_ACCOUNT with its managed identity.

Data layout (same under a local directory or the ADLS account; first segment = container):
    raw/copilot_interactions_parsed/day-YYYYMMDD.parquet
    raw/copilot_licensed_users/part-0.parquet
    raw/copilot_org_data/part-0.parquet
    raw/m365_activity_daily/day-YYYYMMDD.parquet
    raw/agents_365/*.parquet                                   (Phase 2, optional)
    curated/copilot_interactions_curated/part-0.parquet
    curated/<studio_* | viva_*>/part-0.parquet                 (module consumption, merged state)
    raw/<azure_ai_* | copilot_payg_spend | ...>/part-0.parquet (module consumption, Azure AI)
    landing/studio/*.csv, landing/viva/*.csv                   (consumption drop folder, read only)
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

import duckdb

from valuelens_core import curate

from .config import Settings
from .storage import LocalStore, open_store
from .tables import parquet_glob, q

log = logging.getLogger("valuelens_jobs")
STEPS = ("collect", "process", "publish", "refresh")
CURATED = "curated/copilot_interactions_curated/part-0.parquet"
PROCESS_INPUTS = ("raw/copilot_interactions_parsed", "raw/copilot_licensed_users", "raw/agents_365")


def process(store, *, exclude_agent_identities=True, include_raw_passthrough=False) -> int:
    for prefix in PROCESS_INPUTS:
        store.pull(prefix)
    interactions = parquet_glob(store.root, PROCESS_INPUTS[0])
    if not interactions:
        log.warning("process: no Copilot interactions collected yet; nothing to curate")
        return 0
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    rel = curate(con, interactions, parquet_glob(store.root, PROCESS_INPUTS[1]),
                 parquet_glob(store.root, PROCESS_INPUTS[2]),
                 exclude_agent_identities=exclude_agent_identities,
                 include_raw_passthrough=include_raw_passthrough)
    target = store.path(CURATED)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    con.execute(f"COPY ({rel.sql_query()}) TO {q(tmp)} (FORMAT PARQUET)")
    rows = con.execute(f"SELECT count(*) FROM read_parquet({q(tmp)})").fetchone()[0]
    con.close()
    tmp.replace(target)
    store.push([CURATED])
    log.info("process: wrote %s curated rows", rows)
    return rows


def _api(settings):
    from .api import Api, TokenSource

    return Api(TokenSource())


def collect(store, settings, api=None) -> dict:
    """Run every selected collector. One failing source doesn't stop the others (or the publish that
    follows); failures are returned under ``errors`` and fail the job once the remaining steps finish."""
    from .collect.audit import collect_audit
    from .collect.graph import collect_licensed, collect_m365, collect_org

    api = api or _api(settings)
    jobs = []
    if settings.has("core"):
        jobs += [("licensed", collect_licensed), ("audit", collect_audit)]
    if settings.has("orgData"):
        jobs.append(("org", collect_org))
    if settings.has("m365Activity"):
        jobs.append(("m365", collect_m365))
    if settings.has("consumption"):
        from .collect.studio import collect_studio
        from .collect.viva import collect_viva

        jobs += [("studio", collect_studio), ("viva", collect_viva)]
        if settings.azure_ai_subscription:
            from .collect.azure_ai import collect_azure_ai

            jobs.append(("azure_ai", collect_azure_ai))
        else:
            # As in Fabric: without the Azure AI subscription, Copilot pay-as-you-go isn't read either.
            log.info("collect azure_ai: VALUELENS_AZURE_AI_SUBSCRIPTION not set; Azure AI and PAYG skipped")
    out, errors = {}, {}
    for name, fn in jobs:
        try:
            out[name] = fn(api, store, settings)
        except Exception as exc:
            log.exception("collect %s failed: %s", name, exc)
            errors[name] = f"{type(exc).__name__}: {exc}"
    if errors:
        out["errors"] = errors
    return out


def publish_targets(settings) -> list[str]:
    from .publish import CONSUMPTION

    consumption = list(CONSUMPTION) if settings.has("consumption") else []
    if settings.sample_data:
        # The sample replaces the people, Copilot and consumption tables; tenant M365 activity is left as it is.
        return ["curated", "licensed", "org", *consumption]
    targets = []
    if settings.has("core"):
        targets += ["curated", "licensed"]
    if settings.has("orgData"):
        targets.append("org")
    if settings.has("m365Activity"):
        targets.append("m365")
    return targets + consumption


def _sql(settings):
    from .api import TokenSource
    from .sql import connect

    if not settings.sql_server or not settings.sql_database:
        raise ValueError("VALUELENS_SQL_SERVER and VALUELENS_SQL_DATABASE must be set.")
    return connect(settings, TokenSource())


def publish_step(store, settings, conn=None):
    from .publish import publish

    conn = conn or _sql(settings)
    try:
        return publish(conn, store, publish_targets(settings))
    finally:
        conn.close()


def migrate_step(settings, conn=None, folder=None):
    from .sql import default_migrations_dir, ensure_reader, migrate

    folder = folder or os.environ.get("VALUELENS_MIGRATIONS_DIR") or default_migrations_dir()
    conn = conn or _sql(settings)
    try:
        ran = migrate(conn, folder)
        ensure_reader(conn, settings.sql_reader_name, settings.sql_reader_client_id)
        return ran
    finally:
        conn.close()


def refresh_step(settings, api=None, publish_results=None, today=None):
    from datetime import date

    from .refresh import needs_full_refresh, refresh_models

    all_partitions = needs_full_refresh(publish_results, today or date.today())
    return refresh_models(api or _api(settings), settings, all_partitions=all_partitions)


def main(argv=None, env=None) -> int:
    logging.basicConfig(level=os.environ.get("VALUELENS_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # The Azure SDK logs every HTTP request and response at INFO, which buries the job's own lines.
    logging.getLogger("azure").setLevel(os.environ.get("VALUELENS_AZURE_LOG_LEVEL", "WARNING"))
    ap =  argparse.ArgumentParser(prog="valuelens_jobs")
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
    settings = Settings.from_env(env)
    log.info("valuelens-jobs %s; modules: %s", settings.version or "dev", ",".join(sorted(settings.modules)))

    if args.cmd == "process":
        process(LocalStore(args.data_dir), exclude_agent_identities=not args.keep_agent_identities,
                include_raw_passthrough=args.raw_passthrough)
        return 0
    if args.cmd == "migrate":
        migrate_step(settings)
        return 0
    steps = [s.strip() for s in args.steps.split(",") if s.strip()]
    unknown = [s for s in steps if s not in STEPS]
    if unknown:
        ap.error(f"unknown steps {unknown}; expected a subset of {list(STEPS)}")
    store = open_store(args.data_dir, settings) if {"collect", "process", "publish"} & set(steps) else None
    if store is not None and settings.sample_data:
        import tempfile

        # A throwaway store, so the tenant's collected data in Storage is neither read nor changed.
        store = LocalStore(tempfile.mkdtemp(prefix="valuelens-sample-"))
        log.warning("VALUELENS_SAMPLE_DATA is on: publishing the synthetic sample instead of tenant data")
    collect_errors = {}
    published = None
    for step in STEPS:
        if step not in steps:
            continue
        log.info("step %s: start", step)
        if step == "collect":
            if settings.sample_data:
                from .sample import load

                load(store, consumption=settings.has("consumption"))
            else:
                collect_errors = collect(store, settings).get("errors", {})
        elif step == "process":
            process(store)
        elif step == "publish":
            published = publish_step(store, settings)
        else:
            refresh_step(settings, publish_results=published)
        log.info("step %s: done", step)
    if collect_errors:
        raise RuntimeError("the run published what it collected, but these sources failed and resume next run: "
                           + "; ".join(f"{k}: {v}" for k, v in collect_errors.items()))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # one clear line in the Container Apps log, then non-zero exit
        log.exception("valuelens-jobs failed: %s", exc)
        sys.exit(1)
