#!/usr/bin/env python3
"""Build the Dataverse core ValueLens feeds from full CopilotInteraction audit payloads.

The script intentionally reuses the existing ValueLens Purview processor instead of
reimplementing classification logic. It accepts full raw Graph/Purview audit JSON,
creates the processor's raw Purview CSV input, runs the canonical processor, then
publishes schema-equivalent curated rows to local JSONL or Dataverse companion tables.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import uuid
from typing import Any
from urllib import error, request
from urllib.parse import quote, urlencode, urlsplit
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
PROCESSOR = ROOT / "1. Local CSV" / "scripts" / "Purview_CopilotInteraction_Processor_v4.0.0.py"
CORE_SCHEMA = ROOT / "4. Power Automate + Dataverse" / "dataverse-core-schema.json"
DEFAULT_RAW_TABLE = "poc_valuelensrawaudits"
INTERACTIONS_TABLE = "poc_valuelensinteractions"
USERS_TABLE = "poc_valuelensusers"
RUNS_TABLE = "poc_valuelensruns"
PUBLISH_COLUMNS = ("poc_rowkey", "poc_runid", "poc_payloadjson", "poc_payloadhash")

# Entity set (plural) -> entity logical (singular) contract fixed with main.
ENTITY_LOGICAL_BY_SET = {
    DEFAULT_RAW_TABLE: "poc_valuelensrawaudit",
    INTERACTIONS_TABLE: "poc_valuelensinteraction",
    USERS_TABLE: "poc_valuelensuser",
    RUNS_TABLE: "poc_valuelensrun",
}
# Only these entity set names may ever appear in a URL path or publish target.
ALLOWED_ENTITY_SETS = frozenset(ENTITY_LOGICAL_BY_SET)
# Core curated snapshot tables the bridge writes (raw audits are owned by the collector).
CORE_PUBLISH_SETS = (INTERACTIONS_TABLE, USERS_TABLE)

API_VERSION = "v9.2"
# poc_payloadjson is a Dataverse memo capped at 1,048,576 characters.
MEMO_LIMIT = 1_048_576
MAX_HTTP_ATTEMPTS = 6
MAX_RETRY_SLEEP = 60
MAX_TOTAL_RETRY = 300
DEFAULT_TIMEOUT = 100


class PathwayError(RuntimeError):
    pass


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def row_key(payload: dict[str, Any]) -> str:
    """Content identity of a row (NOT run-isolated). Retained for callers that need
    a pure content hash; core snapshot rows use :func:`core_row_key` instead."""
    basis = payload.get("RecordId") or payload.get("SourceRecordKey") or stable_json(payload)
    return hashlib.sha256(str(basis).encode("utf-8")).hexdigest()


def core_row_key(run_id: str, table: str, ordinal: int, payload: str) -> str:
    """Run-isolated primary key for a curated snapshot row.

    Keying on the run id guarantees a later refresh writes a disjoint key space,
    so immutable prior snapshots are never overwritten and a reader pinned to a
    specific run never sees stale rows mixed in.
    """
    basis = f"{run_id}|{table}|{ordinal}|{payload}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def dataverse_origin(url: str) -> str:
    """Return the lowercase scheme://host[:port] origin of a URL."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    netloc = host + (f":{parts.port}" if parts.port else "")
    return f"{parts.scheme.lower()}://{netloc}"


def validate_dataverse_url(url: str | None) -> str:
    """Validate a Dataverse environment URL before any credentialed request.

    Enforces an HTTPS Dataverse origin with no embedded userinfo, query, or
    fragment so bearer tokens are never leaked to an off-origin or crafted URL.
    Returns the canonical origin.
    """
    if not url:
        raise PathwayError("A Dataverse environment URL is required for this operation")
    parts = urlsplit(url)
    if parts.scheme.lower() != "https":
        raise PathwayError("Dataverse URL must use https")
    if parts.username or parts.password or "@" in parts.netloc:
        raise PathwayError("Dataverse URL must not embed credentials (userinfo)")
    if parts.query:
        raise PathwayError("Dataverse URL must not include a query string")
    if parts.fragment:
        raise PathwayError("Dataverse URL must not include a fragment")
    if parts.path not in ("", "/"):
        raise PathwayError("Dataverse URL must be an environment origin, without a path")
    if parts.port not in (None, 443):
        raise PathwayError("Dataverse URL must use the standard HTTPS port")
    host = (parts.hostname or "").lower()
    if not host:
        raise PathwayError("Dataverse URL is missing a host")
    if not host.endswith(".dynamics.com"):
        raise PathwayError("Dataverse URL host must be a *.dynamics.com origin")
    return dataverse_origin(url)


def require_allowed_entity_set(table: str) -> str:
    if table not in ALLOWED_ENTITY_SETS:
        raise PathwayError(f"Entity set '{table}' is not in the ValueLens core allowlist")
    return table


class _SameOriginRedirectHandler(request.HTTPRedirectHandler):
    """Refuse cross-origin redirects so an Authorization header is never replayed
    to a different host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        if dataverse_origin(newurl) != dataverse_origin(req.full_url):
            raise PathwayError("Refusing cross-origin redirect; credentials would leak off-origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = request.build_opener(_SameOriginRedirectHandler())


def parse_json_value(value: Any, label: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return parsed
    raise PathwayError(f"{label} must contain a full JSON object")


def raw_audit_payload(record: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("AuditData", "auditData", "rawAuditData", "fullAuditData", "poc_rawauditdata", "poc_fullauditdata"):
        if key in record and record[key] not in (None, ""):
            return parse_json_value(record[key], key)
    return None


def extract_audit_payload(record: dict[str, Any]) -> dict[str, Any]:
    audit = raw_audit_payload(record)
    if audit is None:
        raise PathwayError(
            "Full raw audit payload is required. Summary-only poc_copilotinteractions rows "
            "or truncated poc_resources cannot be converted to ValueLens core facts."
        )

    audit = json.loads(stable_json(audit))
    operation = audit.get("Operation") or record.get("operation") or record.get("Operation")
    if operation and not audit.get("Operation"):
        audit["Operation"] = operation
    created = audit.get("CreationTime") or record.get("createdDateTime") or record.get("CreationDate")
    if created and not audit.get("CreationTime"):
        audit["CreationTime"] = created
    if not audit.get("UserId") and record.get("userPrincipalName"):
        audit["UserId"] = record["userPrincipalName"]

    ced = audit.get("CopilotEventData")
    if not isinstance(ced, dict):
        raise PathwayError("Full raw audit payload is missing CopilotEventData")
    messages = ced.get("Messages")
    if not isinstance(messages, list) or not messages:
        raise PathwayError("Full raw audit payload is missing CopilotEventData.Messages")
    # Mirror the canonical processor's semantics: only isPrompt messages become
    # facts. Response-only audit records are valid and must not be rejected. We
    # never fabricate Message Ids, but a prompt message that already carries an Id
    # must keep it (a blank prompt Id is a corrupt record, not something to invent).
    for message in messages:
        if isinstance(message, dict) and message.get("isPrompt") is True:
            if not str(message.get("Id") or "").strip():
                raise PathwayError(
                    "Prompt messages must retain their original Message Id; the bridge will not fabricate them"
                )
    return audit


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise PathwayError(f"{path} line {line_number} is not a JSON object")
            rows.append(value)
    return rows


def read_csv_records(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def dataverse_request(method: str, url: str, token: str, body: Any | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "OData-Version": "4.0",
        "OData-MaxVersion": "4.0",
    }
    req = request.Request(url, data=data, headers=headers, method=method)
    started = time.monotonic()
    for attempt in range(MAX_HTTP_ATTEMPTS):
        try:
            with _OPENER.open(req, timeout=DEFAULT_TIMEOUT) as response:
                content = response.read()
                return json.loads(content.decode("utf-8")) if content else {}
        except error.HTTPError as exc:
            retryable = exc.code in (429, 500, 502, 503, 504)
            if not retryable or attempt == MAX_HTTP_ATTEMPTS - 1:
                detail = exc.read().decode("utf-8", errors="replace")[:2000]
                # Never echo the Authorization header / bearer token into errors.
                raise PathwayError(f"{method} {url} failed: HTTP {exc.code} {detail}") from exc
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            delay = _retry_delay(retry_after, attempt)
            if time.monotonic() - started + delay > MAX_TOTAL_RETRY:
                raise PathwayError(f"{method} {url} exceeded max retry budget") from exc
            time.sleep(delay)
        except error.URLError as exc:
            if attempt == MAX_HTTP_ATTEMPTS - 1:
                raise PathwayError(f"{method} {url} failed: {exc.reason}") from exc
            time.sleep(min(2 ** attempt, MAX_RETRY_SLEEP))
    raise PathwayError(f"{method} {url} failed after {MAX_HTTP_ATTEMPTS} attempts")


def _retry_delay(retry_after: str | None, attempt: int) -> float:
    if retry_after:
        try:
            return min(float(retry_after), MAX_RETRY_SLEEP)
        except ValueError:
            pass
    return float(min(2 ** attempt, MAX_RETRY_SLEEP))


def read_dataverse_rows(dataverse_url: str, token: str, table: str, source_run_id: str | None = None) -> list[dict[str, Any]]:
    require_allowed_entity_set(table)
    origin = validate_dataverse_url(dataverse_url)
    base = dataverse_url.rstrip("/") + f"/api/data/{API_VERSION}/{table}"
    query = {"$select": "poc_payloadjson,poc_runid"}
    if source_run_id:
        query["$filter"] = f"poc_runid eq '{source_run_id}'"
    url: str | None = base + "?" + urlencode(query, safe="' ")
    rows: list[dict[str, Any]] = []
    seen_pages: set[str] = set()
    while url:
        if url in seen_pages:
            raise PathwayError("Dataverse returned a repeated pagination link")
        seen_pages.add(url)
        if dataverse_origin(url) != origin:
            raise PathwayError("Refusing to follow off-origin nextLink; credentials would leak cross-origin")
        page = dataverse_request("GET", url, token)
        if not isinstance(page, dict):
            raise PathwayError("Dataverse response was not a JSON object")
        value = page.get("value")
        if not isinstance(value, list):
            raise PathwayError("Dataverse response is missing the 'value' array")
        for item in value:
            record = parse_json_value(item.get("poc_payloadjson"), "poc_payloadjson")
            if item.get("poc_runid") and "poc_runid" not in record:
                record["poc_runid"] = item.get("poc_runid")
            rows.append(record)
        url = page.get("@odata.nextLink")
    return rows


def parse_utc(value: str, label: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PathwayError(f"{label} must be an ISO-8601 UTC timestamp") from exc
    if parsed.tzinfo is None:
        raise PathwayError(f"{label} must include UTC timezone information")
    return parsed.astimezone(timezone.utc)


def audit_creation_time(record: dict[str, Any]) -> datetime | None:
    audit = raw_audit_payload(record)
    if audit is None:
        return None
    created = audit.get("CreationTime") or record.get("createdDateTime") or record.get("CreationDate")
    if not created:
        return None
    try:
        return datetime.fromisoformat(str(created).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError as exc:
        raise PathwayError(f"Audit record has invalid CreationTime: {created}") from exc


def filter_records_by_coverage(
    records: list[dict[str, Any]], start_utc: str | None, end_utc: str | None, source_run_id: str | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    start = parse_utc(start_utc, "--raw-start-utc") if start_utc else None
    end = parse_utc(end_utc, "--raw-end-utc") if end_utc else None
    if bool(start) ^ bool(end):
        raise PathwayError("--raw-start-utc and --raw-end-utc must be supplied together")
    if start and end and start > end:
        raise PathwayError("--raw-start-utc must be earlier than or equal to --raw-end-utc")

    kept: list[dict[str, Any]] = []
    stats: dict[str, Any] = {
        "inputRecords": len(records),
        "filteredBySourceRunId": 0,
        "filteredByTimeWindow": 0,
        "selectedRecords": 0,
        "sourceRunId": source_run_id,
        "windowStartUtc": start_utc,
        "windowEndUtc": end_utc,
        "minCreationUtc": None,
        "maxCreationUtc": None,
    }
    for record in records:
        if source_run_id and str(record.get("poc_runid") or "") != source_run_id:
            stats["filteredBySourceRunId"] += 1
            continue
        created = audit_creation_time(record)
        if start and end and (created is None or created < start or created > end):
            stats["filteredByTimeWindow"] += 1
            continue
        if created:
            text = created.isoformat().replace("+00:00", "Z")
            if stats["minCreationUtc"] is None or text < stats["minCreationUtc"]:
                stats["minCreationUtc"] = text
            if stats["maxCreationUtc"] is None or text > stats["maxCreationUtc"]:
                stats["maxCreationUtc"] = text
        kept.append(record)
    stats["selectedRecords"] = len(kept)
    if (start or end or source_run_id) and not kept:
        raise PathwayError("Raw source filters selected zero records; refusing to publish an empty scoped snapshot")
    return kept, stats


def write_purview_csv(records: list[dict[str, Any]], path: Path) -> dict[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    seen: dict[str, str] = {}
    stats = {"input": 0, "deduped": 0, "written": 0, "skippedNonMessage": 0}
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["RecordId", "CreationDate", "Operation", "AuditData"], lineterminator="\n")
        writer.writeheader()
        for record in records:
            stats["input"] += 1
            try:
                audit = extract_audit_payload(record)
            except PathwayError as exc:
                if "CopilotEventData" in str(exc):
                    stats["skippedNonMessage"] += 1
                    continue
                raise
            if audit.get("Operation") != "CopilotInteraction":
                continue
            payload = stable_json(audit)
            key = str(record.get("id") or record.get("RecordId") or audit.get("Id") or hashlib.sha256(payload.encode("utf-8")).hexdigest())
            if key in seen:
                if seen[key] != payload:
                    raise PathwayError("Conflicting payloads share an audit record ID; resolve the retained source records before publishing")
                stats["deduped"] += 1
                continue
            seen[key] = payload
            writer.writerow(
                {
                    "RecordId": key,
                    "CreationDate": audit.get("CreationTime", ""),
                    "Operation": audit.get("Operation", ""),
                    "AuditData": payload,
                }
            )
            stats["written"] += 1
    if stats["written"] == 0:
        raise PathwayError("No full CopilotInteraction audit records were written")
    return stats


def newest_csv(directory: Path, pattern: str, before: set[Path]) -> Path:
    candidates = [p for p in directory.glob(pattern) if p not in before]
    if not candidates:
        raise PathwayError(f"Processor did not create {pattern}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def run_processor(purview_csv: Path, entra_csv: Path, out_dir: Path, licensing_csv: Path | None, quiet: bool) -> tuple[Path, Path]:
    before = set(out_dir.glob("*.csv"))
    cmd = [
        sys.executable,
        str(PROCESSOR),
        "--purview",
        str(purview_csv),
        "--entra",
        str(entra_csv),
        "--out-dir",
        str(out_dir),
        "--profile",
        "aibv",
    ]
    if licensing_csv:
        cmd.extend(["--licensing", str(licensing_csv)])
    if quiet:
        cmd.append("--quiet")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise PathwayError(proc.stderr or proc.stdout or "ValueLens processor failed")
    return newest_csv(out_dir, f"{purview_csv.stem}_Interactions_*.csv", before), newest_csv(out_dir, f"{entra_csv.stem}_Users_*.csv", before)


def csv_payloads(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def prepare_snapshot(
    rows_by_table: dict[str, list[dict[str, Any]]], run_id: str
) -> dict[str, list[tuple[str, str, list[str]]]]:
    """Serialize, size-check and de-duplicate curated rows BEFORE any write.

    Returns table -> list of (poc_rowkey, poc_payloadjson, sorted column names).
    Raises ``TypeError`` for non-serializable rows and :class:`PathwayError` for
    an over-limit memo payload, so an oversize row is rejected before the first
    publication write and a snapshot is never left half-committed.
    """
    validate_run_id(run_id)
    if set(rows_by_table) != set(CORE_PUBLISH_SETS):
        raise PathwayError("A core snapshot must contain both the interactions and users tables")
    prepared: dict[str, list[tuple[str, str, list[str]]]] = {}
    for table, rows in rows_by_table.items():
        require_allowed_entity_set(table)
        if not rows:
            raise PathwayError(f"Refusing an empty core snapshot table: {table}")
        expected_columns = set(rows[0])
        seen: dict[str, str] = {}
        out: list[tuple[str, str, list[str]]] = []
        for ordinal, row in enumerate(rows):
            if set(row) != expected_columns:
                raise PathwayError(f"Inconsistent row columns in core snapshot table: {table}")
            payload = stable_json(row)
            if len(payload.encode("utf-8")) > MEMO_LIMIT:
                raise PathwayError(
                    f"Row {ordinal} for {table} exceeds the {MEMO_LIMIT}-char poc_payloadjson memo limit"
                )
            key = core_row_key(run_id, table, ordinal, payload)
            existing = seen.get(payload)
            if existing is not None:
                # Identical content already captured in this run: dedup silently.
                continue
            seen[payload] = key
            out.append((key, payload, sorted(row.keys())))
        prepared[table] = out
    return prepared


def validate_run_id(run_id: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", run_id):
        raise PathwayError("Run ID must contain 1-100 letters, digits, underscores or hyphens, starting with a letter or digit")


def _manifest_payload(
    run_id: str,
    status: str,
    prepared: dict[str, list[tuple[str, str, list[str]]]],
    completed_at: str | None,
    source_coverage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tables = {
        table: {"count": len(entries), "columns": (entries[0][2] if entries else [])}
        for table, entries in prepared.items()
    }
    payload = {"runId": run_id, "status": status, "tables": tables, "completedAt": completed_at}
    if source_coverage is not None:
        payload["sourceCoverage"] = source_coverage
    return payload


def _snapshot_row(run_id: str, key: str, payload: str) -> dict[str, str]:
    return {
        "poc_name": key[:100],
        "poc_rowkey": key,
        "poc_runid": run_id,
        "poc_payloadhash": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        "poc_payloadjson": payload,
    }


def publish_local(rows_by_table: dict[str, list[dict[str, Any]]], out_dir: Path, run_id: str, source_coverage: dict[str, Any] | None = None) -> Path:
    validate_run_id(run_id)
    root = out_dir / "dataverse-local"
    run_dir = root / run_id
    pending_manifest = run_dir / "manifest.json.pending"
    final_manifest = run_dir / "manifest.json"
    if final_manifest.exists() or pending_manifest.exists() or any(run_dir.glob("*.jsonl")):
        raise PathwayError(
            f"Run ID '{run_id}' already has local snapshot artifacts; pick a fresh UUID run id (e.g. {uuid.uuid4()})"
        )
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "runId": run_id,
        "status": "pending",
        "tables": {table: len(rows) for table, rows in rows_by_table.items()},
        "completedAt": None,
    }
    pending_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    try:
        prepared = prepare_snapshot(rows_by_table, run_id)
        manifest["tables"] = {table: len(entries) for table, entries in prepared.items()}
        for table, entries in prepared.items():
            pending = run_dir / f"{table}.jsonl.pending"
            final = run_dir / f"{table}.jsonl"
            with pending.open("w", encoding="utf-8", newline="\n") as handle:
                for key, payload, _columns in entries:
                    handle.write(stable_json(_snapshot_row(run_id, key, payload)) + "\n")
            pending.replace(final)
        # Only after every isolated snapshot row is committed do we write the run
        # manifest row keyed by runID and flip status to succeeded.
        completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        runs_payload = stable_json(_manifest_payload(run_id, "succeeded", prepared, completed_at, source_coverage))
        runs_pending = run_dir / f"{RUNS_TABLE}.jsonl.pending"
        runs_final = run_dir / f"{RUNS_TABLE}.jsonl"
        with runs_pending.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(stable_json(_snapshot_row(run_id, run_id, runs_payload)) + "\n")
        runs_pending.replace(runs_final)
        manifest["status"] = "succeeded"
        manifest["completedAt"] = completed_at
        pending_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        pending_manifest.replace(final_manifest)
    except (OSError, TypeError, ValueError, PathwayError):
        manifest["status"] = "failed"
        pending_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        raise
    return final_manifest


def _entity_key_url(dataverse_url: str, table: str, key: str) -> str:
    entity_key = quote(f"poc_rowkey='{key}'", safe="'=")
    return dataverse_url.rstrip("/") + f"/api/data/{API_VERSION}/{table}({entity_key})"


def _run_manifest_exists(dataverse_url: str, token: str, run_id: str) -> bool:
    url = _entity_key_url(dataverse_url, RUNS_TABLE, run_id) + "?$select=poc_runid"
    try:
        dataverse_request("GET", url, token)
        return True
    except PathwayError as exc:
        if "HTTP 404" in str(exc):
            return False
        raise


def publish_dataverse(
    rows_by_table: dict[str, list[dict[str, Any]]],
    dataverse_url: str,
    token: str,
    run_id: str,
    source_coverage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    validate_run_id(run_id)
    validate_dataverse_url(dataverse_url)
    if _run_manifest_exists(dataverse_url, token, run_id):
        raise PathwayError(
            f"Run ID '{run_id}' already has a run manifest in Dataverse; pick a fresh UUID run id (e.g. {uuid.uuid4()})"
        )
    # Fully prepare (serialize, size-check, dedup) before the first write.
    prepared = prepare_snapshot(rows_by_table, run_id)

    def _write_manifest(status: str, completed_at: str | None) -> None:
        payload = stable_json(_manifest_payload(run_id, status, prepared, completed_at, source_coverage))
        dataverse_request("PATCH", _entity_key_url(dataverse_url, RUNS_TABLE, run_id), token, _snapshot_row(run_id, run_id, payload))

    # In-progress manifest is written first as pending; it is never 'succeeded'
    # until all snapshot rows land.
    # Creating the uniquely keyed manifest (rather than upserting it) atomically
    # reserves this run ID even when two publishers race after the existence check.
    pending_payload = stable_json(_manifest_payload(run_id, "pending", prepared, None, source_coverage))
    dataverse_request(
        "POST", dataverse_url.rstrip("/") + f"/api/data/{API_VERSION}/{RUNS_TABLE}",
        token, _snapshot_row(run_id, run_id, pending_payload),
    )
    try:
        for table, entries in prepared.items():
            for key, payload, _columns in entries:
                dataverse_request(
                    "PATCH",
                    _entity_key_url(dataverse_url, table, key),
                    token,
                    _snapshot_row(run_id, key, payload),
                )
    except (OSError, ValueError, PathwayError):
        try:
            _write_manifest("failed", None)
        except (OSError, ValueError, PathwayError) as manifest_error:
            print(f"Failed to record failure for run {run_id}: {manifest_error}", file=sys.stderr)
        raise
    completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _write_manifest("succeeded", completed_at)
    return _manifest_payload(run_id, "succeeded", prepared, completed_at, source_coverage)


def core_schema_definition() -> dict[str, Any]:
    """Canonical, deployable definition of the ValueLens core Dataverse schema.

    This is the single source of truth shared by :func:`emit_schema` and the
    Deploy-DataverseCoreSchema.py metadata deployer.
    """
    common_columns = [
        {"logicalName": "poc_rowkey", "displayName": "Row Key", "type": "String", "maxLength": 100, "required": True, "alternateKey": True},
        {"logicalName": "poc_runid", "displayName": "Run ID", "type": "String", "maxLength": 100, "required": False},
        {"logicalName": "poc_payloadhash", "displayName": "Payload Hash", "type": "String", "maxLength": 64, "required": False},
        {"logicalName": "poc_payloadjson", "displayName": "Payload JSON", "type": "Memo", "maxLength": MEMO_LIMIT, "required": False},
    ]
    tables = []
    descriptions = {
        DEFAULT_RAW_TABLE: "Full raw Graph/Purview audit payload retention (collector-owned).",
        INTERACTIONS_TABLE: "Curated ValueLens interaction rows consumed by the PBIT.",
        USERS_TABLE: "Curated ValueLens users/licensing rows consumed by the PBIT.",
        RUNS_TABLE: "Bridge run manifests and completion status, one row per runID.",
    }
    for entity_set, logical in ENTITY_LOGICAL_BY_SET.items():
        tables.append(
            {
                "entitySetName": entity_set,
                "logicalName": logical,
                "schemaName": logical,
                "displayName": logical,
                "displayCollectionName": entity_set,
                "description": descriptions[entity_set],
                "ownershipType": "UserOwned",
                "hasActivities": False,
                "hasNotes": False,
            }
        )
    return {
        "version": "1.0",
        "publisherPrefix": "poc",
        "apiVersion": API_VERSION,
        "primaryAttribute": {"logicalName": "poc_name", "displayName": "Name", "type": "String", "maxLength": 100},
        "commonColumns": common_columns,
        "alternateKey": {"schemaName": "poc_rowkey_key", "displayName": "Row Key", "keyAttributes": ["poc_rowkey"]},
        "tables": tables,
    }


def emit_schema(path: Path) -> None:
    path.write_text(json.dumps(core_schema_definition(), indent=2), encoding="utf-8")


def resolve_input_source(args: argparse.Namespace) -> str:
    """Decide which raw source to read and validate the CLI combination.

    A local raw file (``--raw-jsonl`` / ``--raw-csv``) is an input; Dataverse
    credentials are only treated as an input source when no local file is given.
    This lets a legitimate "read local raw, publish to Dataverse" invocation
    through instead of miscounting the publish target as a second source.
    """
    local = [bool(args.raw_jsonl), bool(args.raw_csv)]
    if sum(local) > 1:
        raise PathwayError("Supply at most one local raw source: --raw-jsonl OR --raw-csv")
    if args.raw_jsonl:
        return "raw_jsonl"
    if args.raw_csv:
        return "raw_csv"
    if args.dataverse_url and args.dataverse_token:
        return "dataverse"
    raise PathwayError(
        "Provide a raw source: --raw-jsonl, --raw-csv, or --dataverse-url with a token "
        "(env DATAVERSE_TOKEN or --dataverse-token) to read raw audits from Dataverse"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-jsonl", type=Path, help="JSONL file containing full Graph/Purview audit records")
    parser.add_argument("--raw-csv", type=Path, help="CSV with an AuditData/full raw payload column")
    parser.add_argument("--dataverse-url", help="Dataverse environment URL for reading/publishing")
    parser.add_argument(
        "--dataverse-token",
        default=os.environ.get("DATAVERSE_TOKEN"),
        help="Bearer token for the Dataverse Web API. Prefer the DATAVERSE_TOKEN env var over the CLI so the secret is not captured in shell history/process listings.",
    )
    parser.add_argument("--raw-table", default=DEFAULT_RAW_TABLE)
    parser.add_argument("--source-run-id", help="Optional collector run id to select from retained raw Dataverse rows")
    parser.add_argument("--raw-start-utc", help="Inclusive UTC CreationTime lower bound for retained raw records")
    parser.add_argument("--raw-end-utc", help="Inclusive UTC CreationTime upper bound for retained raw records")
    parser.add_argument("--entra", type=Path, help="Graph Entra users/org CSV or BYOD equivalent")
    parser.add_argument("--licensing", type=Path, help="Optional Graph/Admin Center licensing CSV")
    parser.add_argument("--out-dir", type=Path, default=Path("4. Power Automate + Dataverse") / "processed")
    parser.add_argument("--run-id", default=f"valuelens-{uuid.uuid4()}")
    parser.add_argument("--publish", choices=("local", "dataverse", "none"), default="local")
    parser.add_argument("--emit-schema", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    if args.emit_schema:
        emit_schema(CORE_SCHEMA)
        if not any((args.raw_jsonl, args.raw_csv, args.dataverse_url)):
            if not args.quiet:
                print(f"Schema written: {CORE_SCHEMA}")
            return 0
    if not args.entra:
        raise PathwayError("--entra is required when building curated feeds")
    validate_run_id(args.run_id)

    source = resolve_input_source(args)
    if args.publish == "dataverse" and not (args.dataverse_url and args.dataverse_token):
        raise PathwayError("--publish dataverse requires --dataverse-url and a token (DATAVERSE_TOKEN or --dataverse-token)")

    require_allowed_entity_set(args.raw_table)
    if source == "raw_jsonl":
        records = read_jsonl(args.raw_jsonl)
    elif source == "raw_csv":
        records = read_csv_records(args.raw_csv)
    else:
        records = read_dataverse_rows(args.dataverse_url, args.dataverse_token, args.raw_table, args.source_run_id)
    records, coverage_stats = filter_records_by_coverage(records, args.raw_start_utc, args.raw_end_utc, args.source_run_id)

    # Isolate each run in its own working directory so concurrent runs sharing a
    # 1-second timestamp can never collide on processor intermediates.
    work_dir = args.out_dir / args.run_id
    work_dir.mkdir(parents=True, exist_ok=True)
    purview_csv = work_dir / f"{args.run_id}_purview_raw.csv"
    raw_stats = write_purview_csv(records, purview_csv)
    interactions_csv, users_csv = run_processor(purview_csv, args.entra, work_dir, args.licensing, args.quiet)
    rows_by_table = {
        INTERACTIONS_TABLE: csv_payloads(interactions_csv),
        USERS_TABLE: csv_payloads(users_csv),
    }
    manifest = None
    remote_manifest = None
    if args.publish == "local":
        manifest = publish_local(rows_by_table, args.out_dir, args.run_id, coverage_stats)
    elif args.publish == "dataverse":
        remote_manifest = publish_dataverse(rows_by_table, args.dataverse_url, args.dataverse_token, args.run_id, coverage_stats)

    if not args.quiet:
        print(json.dumps({
            "runId": args.run_id,
            "raw": raw_stats,
            "interactionsCsv": str(interactions_csv),
            "usersCsv": str(users_csv),
            "localManifest": str(manifest) if manifest else None,
            "dataverseManifest": remote_manifest,
        }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, csv.Error, subprocess.SubprocessError, PathwayError) as exc:
        print(f"Build-DataverseCoreFeeds failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
