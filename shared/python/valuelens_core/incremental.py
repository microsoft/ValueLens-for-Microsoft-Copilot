"""Incremental processing plan for the curated interactions table.

The curated table is stored by month. A daily run recomputes only the months
whose source rows changed (per-month row count + row-hash fingerprint), plus
every month inside the lookback window, so late-arriving audit records are
picked up. A recomputed month is rebuilt from all of its source rows, so its
rows equal a full rebuild. Anything that would change every month (processor
settings, processing logic, source schema) forces a full rebuild.

These definitions are verbatim in Copilot_Audit_Log_Processor.ipynb.
"""
import datetime
import hashlib
import json

PROCESSOR_STATE_VERSION = 1
NULL_MONTH = "none"
DEFAULT_INCREMENTAL_LOOKBACK_DAYS = 14


def month_key(value) -> str:
    # 'YYYY-MM' for a date, datetime or ISO text; NULL_MONTH for rows without a usable date.
    if value is None:
        return NULL_MONTH
    if isinstance(value, (datetime.date, datetime.datetime)):
        return f"{value.year:04d}-{value.month:02d}"
    text = str(value).strip()
    if len(text) >= 7 and text[4] == "-" and text[:4].isdigit() and text[5:7].isdigit():
        return text[:7]
    return NULL_MONTH


def month_start(key):
    # First day of a month key; None for NULL_MONTH.
    if key == NULL_MONTH:
        return None
    return datetime.date(int(key[:4]), int(key[5:7]), 1)


def processor_config_fingerprint(settings) -> str:
    # Stable hash of everything that changes the output of every month.
    payload = json.dumps(settings, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_processor_state(text):
    # The state saved by the last successful run, or None when absent or unreadable.
    if not text:
        return None
    try:
        state = json.loads(text)
    except (TypeError, ValueError):
        return None
    if (not isinstance(state, dict) or state.get("version") != PROCESSOR_STATE_VERSION
            or not isinstance(state.get("config"), str) or not isinstance(state.get("months"), dict)):
        return None
    return state


def build_processor_state(config, months) -> str:
    return json.dumps({"version": PROCESSOR_STATE_VERSION, "config": config,
                       "months": {str(k): str(v) for k, v in sorted(months.items())}},
                      sort_keys=True, separators=(",", ":"))


def month_predicate_sql(column, months) -> str:
    # SQL predicate selecting the given month keys of a MonthStart-style DATE column.
    dates = sorted(month_start(k).isoformat() for k in months if k != NULL_MONTH)
    parts = []
    if dates:
        parts.append(f"`{column}` IN ({', '.join(f'DATE{chr(39)}{d}{chr(39)}' for d in dates)})")
    if NULL_MONTH in months:
        parts.append(f"`{column}` IS NULL")
    return "(" + " OR ".join(parts) + ")" if parts else "FALSE"


def plan_incremental_months(source_months, state, config, *, max_creation=None,
                            lookback_days=DEFAULT_INCREMENTAL_LOOKBACK_DAYS,
                            force_full=False, target_ready=True):
    """Which months to (re)compute.

    source_months maps month key -> fingerprint of the source rows in that month.
    Returns {"full": bool, "reason": str, "months": sorted month keys}. On a full
    rebuild "months" lists every source month. Otherwise it lists the changed
    months, the months inside the lookback window and the months that vanished
    from the source (rewritten empty, as a full rebuild would drop them).
    """
    source_months = {str(k): str(v) for k, v in (source_months or {}).items()}
    everything = sorted(source_months)
    if force_full:
        return {"full": True, "reason": "full rebuild requested", "months": everything}
    if not target_ready:
        return {"full": True, "reason": "target missing or not stored by month (one-time migration)",
                "months": everything}
    if state is None:
        return {"full": True, "reason": "no saved processing state", "months": everything}
    if state.get("config") != config:
        return {"full": True, "reason": "processor settings, logic or source schema changed",
                "months": everything}
    saved = {str(k): str(v) for k, v in state["months"].items()}
    months = {k for k, v in source_months.items() if saved.get(k) != v}
    months |= {k for k in saved if k not in source_months}
    if max_creation is not None:
        if isinstance(max_creation, datetime.datetime):
            max_creation = max_creation.date()
        floor = month_key(max_creation - datetime.timedelta(days=max(int(lookback_days or 0), 0)))
        months |= {k for k in source_months if k != NULL_MONTH and k >= floor}
    reason = "incremental: no changed months" if not months else "incremental"
    return {"full": False, "reason": reason, "months": sorted(months)}
