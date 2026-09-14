#!/usr/bin/env python3
"""Adapt a user-supplied authorized CopilotInteractionLogging solution into a raw-retention variant.

This tool adapts an explicit, user-supplied UNMANAGED source solution zip rather
than rebuilding a new collector from scratch: it injects a full-payload
raw-retention Dataverse upsert alongside the existing summary upsert inside the
existing ``For_each_1`` record loop, and writes an adapted UNMANAGED solution zip
plus a provenance manifest to an explicit output path that MUST live OUTSIDE this
repository.

Design guarantees (see the task contract):

* No private source, tenant IDs, connection defaults, or package bytes are embedded in this file
  or in the repository. Both ``--source-zip`` and ``--out-zip`` are required and have no defaults.
* The output path is rejected if it resolves inside the repository, so the private adapted package
  can never be accidentally committed/published.
* The source is validated by parsing ``solution.xml`` (publisher prefix, unique name, Managed flag)
  and by structurally locating the known ``Upsert_a_row_2`` -> ``poc_copilotinteractions`` action.
  Unsupported source versions FAIL instead of being blindly text-replaced.
* The injected raw action is idempotent per audit id (row id = audit ``id``; alternate key
  ``poc_rowkey`` = ``toLower(id)`` for convergence with the PowerShell collector) and stores the
  FULL original Graph record JSON without truncation. The Dataverse ``poc_payloadjson``
  memo column (max 1048576) enforces the size ceiling: oversize payloads fail the action and the run.
* The raw action's failure marks the run failed: the summary success counter is repointed to run
  only after raw retention succeeds, so run stats can never report success when raw is absent.
* New action inputs/outputs are marked ``secureData`` so full payloads are not exposed in run history.

This tool never imports anything and performs no cloud writes.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import io
import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Iterable

TOOL_VERSION = "1.0.0"

# The original solution(s) this adapter knows how to extend. Anything else must fail loudly.
SUPPORTED_UNIQUE_NAMES = ("CopilotInteractionLogging",)
EXPECTED_PUBLISHER_PREFIX = "poc"

# Companion raw retention table (created first by the schema/deploy tool owned by the main agent).
RAW_ENTITY_SET = "poc_valuelensrawaudits"
RAW_ALTERNATE_KEY = "poc_rowkey"
MEMO_MAX = 1048576
# Power Automate rejects action descriptions longer than 256 characters at activation.
DESCRIPTION_MAX = 256

# Names injected into the flow. Distinct/prefixed so idempotence detection is unambiguous.
COMPOSE_ACTION = "Compose_Raw_Audit_Payload"
RAW_ACTION = "Retain_Raw_Audit_Record"
RECORD_PROCESSING_FAILURE_ACTION = "Fail_Audit_Record_Processing"
FLAG_RECORD_ERROR_ACTION = "Flag_Record_Error"
STOP_PAGING_ON_RECORD_ERROR_ACTION = "Stop_Paging_After_Record_Error"

# The original action anchors we honour rather than guess at.
SUMMARY_UPSERT_ACTION = "Upsert_a_row_2"
SUMMARY_COUNTER_ACTION = "Increment_UpsertedCount"
SUMMARY_ENTITY = "poc_copilotinteractions"
FOREACH_ACTION = "For_each_1"
DATAVERSE_API_ID = "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps"
DATAVERSE_API_NAME = "shared_commondataserviceforapps"


class PrepareError(RuntimeError):
    """Recoverable, user-facing failure. Never carries private payload data."""


class UnsupportedSourceError(PrepareError):
    pass


class AlreadyPatchedError(PrepareError):
    pass


# --------------------------------------------------------------------------------------
# Provenance / hashing helpers
# --------------------------------------------------------------------------------------
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------------------
# Repository containment enforcement
# --------------------------------------------------------------------------------------
def find_repo_root(start: Path) -> Path:
    """Return the git repository root that contains *start*, or the top-most ancestor."""
    start = start.resolve()
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    # Fall back to the pathway repo root (…/AI-Business-Value-Dashboard) derived from this file.
    return Path(__file__).resolve().parents[2]


def is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


# --------------------------------------------------------------------------------------
# solution.xml parsing
# --------------------------------------------------------------------------------------
class SolutionManifest:
    def __init__(self, unique_name: str, version: str, managed: bool, publisher_prefix: str, xml_text: str):
        self.unique_name = unique_name
        self.version = version
        self.managed = managed
        self.publisher_prefix = publisher_prefix
        self.xml_text = xml_text


def parse_solution_manifest(xml_text: str) -> SolutionManifest:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:  # pragma: no cover - defensive
        raise UnsupportedSourceError(f"solution.xml is not valid XML: {exc}") from exc
    manifest = root.find("SolutionManifest")
    if manifest is None:
        raise UnsupportedSourceError("solution.xml has no SolutionManifest element")

    def _text(parent: ET.Element, tag: str) -> str:
        node = parent.find(tag)
        return (node.text or "").strip() if node is not None else ""

    unique_name = _text(manifest, "UniqueName")
    version = _text(manifest, "Version")
    managed = _text(manifest, "Managed") == "1"
    publisher = manifest.find("Publisher")
    prefix = _text(publisher, "CustomizationPrefix") if publisher is not None else ""
    if not unique_name or not version:
        raise UnsupportedSourceError("solution.xml is missing UniqueName or Version")
    return SolutionManifest(unique_name, version, managed, prefix, xml_text)


def validate_source_manifest(manifest: SolutionManifest) -> None:
    if manifest.managed:
        raise UnsupportedSourceError(
            "Source solution is Managed. Supply the UNMANAGED export so an editable, "
            "unmanaged adapted package can be produced. This tool never fabricates a signed "
            "managed compilation."
        )
    if manifest.unique_name not in SUPPORTED_UNIQUE_NAMES:
        raise UnsupportedSourceError(
            f"Unsupported source solution '{manifest.unique_name}'. This adapter only extends "
            f"{', '.join(SUPPORTED_UNIQUE_NAMES)}."
        )
    if manifest.publisher_prefix and manifest.publisher_prefix != EXPECTED_PUBLISHER_PREFIX:
        raise UnsupportedSourceError(
            f"Unexpected publisher prefix '{manifest.publisher_prefix}'. The raw table and flow "
            f"expressions require the '{EXPECTED_PUBLISHER_PREFIX}' customization prefix."
        )


def bump_version(version: str) -> str:
    parts = version.split(".")
    if not all(part.isdigit() for part in parts) or len(parts) < 2:
        raise UnsupportedSourceError(f"Cannot increment non-numeric solution version '{version}'")
    parts[-1] = str(int(parts[-1]) + 1)
    return ".".join(parts)


def set_solution_version(xml_text: str, old_version: str, new_version: str) -> str:
    needle = f"<Version>{old_version}</Version>"
    if needle not in xml_text:
        raise UnsupportedSourceError("Could not locate the solution Version element to update")
    return xml_text.replace(needle, f"<Version>{new_version}</Version>", 1)


def set_solution_unique_name(xml_text: str, old_name: str, new_name: str) -> str:
    needle = f"<UniqueName>{old_name}</UniqueName>"
    if needle not in xml_text:
        raise UnsupportedSourceError("Could not locate the solution UniqueName element to update")
    return xml_text.replace(needle, f"<UniqueName>{new_name}</UniqueName>", 1)


# --------------------------------------------------------------------------------------
# Flow definition patching
# --------------------------------------------------------------------------------------
def _iter_action_containers(actions: dict[str, Any]) -> Iterable[dict[str, Any]]:
    """Yield every ``actions`` dict in the tree (depth-first), including the root."""
    yield actions
    for action in actions.values():
        if not isinstance(action, dict):
            continue
        nested = action.get("actions")
        if isinstance(nested, dict):
            yield from _iter_action_containers(nested)
        else_block = action.get("else")
        if isinstance(else_block, dict) and isinstance(else_block.get("actions"), dict):
            yield from _iter_action_containers(else_block["actions"])
        for case in (action.get("cases") or {}).values():
            if isinstance(case, dict) and isinstance(case.get("actions"), dict):
                yield from _iter_action_containers(case["actions"])


def _is_summary_upsert(action: dict[str, Any]) -> bool:
    if not isinstance(action, dict) or action.get("type") != "OpenApiConnection":
        return False
    inputs = action.get("inputs") or {}
    params = inputs.get("parameters") or {}
    host = inputs.get("host") or {}
    return (
        params.get("entityName") == SUMMARY_ENTITY
        and host.get("operationId") == "UpdateRecord"
        and str(host.get("apiId", "")).endswith(DATAVERSE_API_NAME)
    )


def find_foreach_actions(definition: dict[str, Any]) -> dict[str, Any]:
    """Return the ``For_each_1`` actions dict that owns the known summary upsert, or raise."""
    root_actions = definition.get("actions")
    if not isinstance(root_actions, dict):
        raise UnsupportedSourceError("Flow definition has no actions block")
    for container in _iter_action_containers(root_actions):
        foreach = container.get(FOREACH_ACTION)
        if not isinstance(foreach, dict) or foreach.get("type") != "Foreach":
            continue
        loop_actions = foreach.get("actions")
        if not isinstance(loop_actions, dict):
            continue
        upsert = loop_actions.get(SUMMARY_UPSERT_ACTION)
        if _is_summary_upsert(upsert):
            return loop_actions
    raise UnsupportedSourceError(
        f"Could not find the expected '{FOREACH_ACTION} > {SUMMARY_UPSERT_ACTION}' summary upsert "
        f"targeting '{SUMMARY_ENTITY}'. Refusing to patch an unrecognised flow version."
    )


def _connection_name(workflow: dict[str, Any]) -> str:
    refs = ((workflow.get("properties") or {}).get("connectionReferences")) or {}
    for name, ref in refs.items():
        api = (ref.get("api") or {}).get("name")
        if api == DATAVERSE_API_NAME:
            return name
    raise UnsupportedSourceError(
        f"Flow has no '{DATAVERSE_API_NAME}' connection reference to bind the raw upsert to."
    )


def _assert_description_limit(*actions: dict[str, Any]) -> None:
    """Guard: Power Automate rejects action descriptions > 256 chars at activation."""
    for action in actions:
        desc = action.get("description") or ""
        if len(desc) > DESCRIPTION_MAX:
            raise PrepareError(
                f"Injected action description is {len(desc)} chars, exceeding the "
                f"{DESCRIPTION_MAX}-char Power Automate limit."
            )


def _build_raw_actions(connection_name: str, compose_run_after: dict[str, Any]) -> dict[str, Any]:
    # A Compose action only supports securing "inputs": Power Automate flow validation rejects
    # "outputs" on a Compose at activation ("illegal secureData"), so the composed payload
    # expression is hidden via its inputs while the downstream OpenApiConnection upsert secures
    # both its inputs and outputs (the record body carrying the payload never appears in history).
    compose_secure = {"runtimeConfiguration": {"secureData": {"properties": ["inputs"]}}}
    raw_secure = {"runtimeConfiguration": {"secureData": {"properties": ["inputs", "outputs"]}}}
    lower_id = "@{toLower(items('For_each_1')?['id'])}"
    compose = {
        "runAfter": compose_run_after,
        "type": "Compose",
        # Full original Graph/Purview record ({id, auditData, userPrincipalName, ...}) serialised
        # without truncation. The summary upsert keeps its 4000-char poc_resources guard; the raw
        # copy deliberately keeps everything.
        "inputs": "@string(items('For_each_1'))",
        "description": (
            "Full original Graph/Purview CopilotInteraction record serialised without truncation "
            "for ValueLens raw retention. Input secured so the payload expression is hidden."
        ),
    }
    compose.update(compose_secure)
    raw = {
        "runAfter": {COMPOSE_ACTION: ["Succeeded"]},
        "type": "OpenApiConnection",
        "inputs": {
            "parameters": {
                "entityName": RAW_ENTITY_SET,
                # The connector's UpdateRecord path upserts by Dataverse row id (GUID) but returns
                # NotFound for alternate-key text recordIds. Use the original audit id as the row id
                # (matching the base summary flow) and still persist the lowercase alternate key for
                # convergence with the PowerShell collector.
                "recordId": "@items('For_each_1')?['id']",
                f"item/{RAW_ALTERNATE_KEY}": lower_id,
                "item/poc_runid": "@{workflow()?['run']?['name']}",
                "item/poc_name": "@items('For_each_1')?['id']",
                "item/poc_payloadjson": f"@outputs('{COMPOSE_ACTION}')",
            },
            "host": {
                "apiId": DATAVERSE_API_ID,
                "connectionName": connection_name,
                "operationId": "UpdateRecord",
            },
        },
        "description": (
            "Upsert the full raw audit record into poc_valuelensrawaudits by audit id row id. "
            "The lowercase poc_rowkey alternate key is retained for processor convergence. "
            "Oversize payloads exceeding the Dataverse memo limit fail the run."
        ),
    }
    raw.update(raw_secure)
    _assert_description_limit(compose, raw)
    return {COMPOSE_ACTION: compose, RAW_ACTION: raw}


def inject_raw_action(workflow: dict[str, Any]) -> bool:
    """Inject the raw-retention actions into a single workflow JSON object (mutating).

    Returns True on injection. Raises AlreadyPatchedError if the workflow already carries the
    raw action, and UnsupportedSourceError if the required anchors are missing.
    """
    properties = workflow.get("properties")
    if not isinstance(properties, dict):
        raise UnsupportedSourceError("Workflow JSON has no 'properties' object")
    definition = properties.get("definition")
    if not isinstance(definition, dict):
        raise UnsupportedSourceError("Workflow JSON has no 'properties.definition' object")

    connection_name = _connection_name(workflow)
    loop_actions = find_foreach_actions(definition)

    if RAW_ACTION in loop_actions or COMPOSE_ACTION in loop_actions:
        raise AlreadyPatchedError(
            "Workflow already contains the raw-retention action. The tool will not double-inject."
        )
    counter = loop_actions.get(SUMMARY_COUNTER_ACTION)
    if not isinstance(counter, dict):
        raise UnsupportedSourceError(
            f"Expected summary counter action '{SUMMARY_COUNTER_ACTION}' was not found; refusing to "
            "patch an unrecognised flow version."
        )

    summary_upsert = loop_actions[SUMMARY_UPSERT_ACTION]
    original_summary_run_after = dict(summary_upsert.get("runAfter") or {})
    loop_actions.update(_build_raw_actions(connection_name, original_summary_run_after))
    # Retain raw first so a summary/table-shape failure cannot skip full-payload capture.
    summary_upsert["runAfter"] = {RAW_ACTION: ["Succeeded"]}
    # Count success only after both raw retention and the original summary upsert succeed.
    counter["runAfter"] = {SUMMARY_UPSERT_ACTION: ["Succeeded"]}
    return True


def rewire_raw_retention_before_summary(workflow: dict[str, Any]) -> bool:
    """Repair an already-adapted flow so raw retention cannot be skipped by summary failures."""
    definition = ((workflow.get("properties") or {}).get("definition")) or {}
    if not isinstance(definition, dict):
        raise UnsupportedSourceError("Workflow JSON has no 'properties.definition' object")
    loop_actions = find_foreach_actions(definition)
    if RAW_ACTION not in loop_actions or COMPOSE_ACTION not in loop_actions:
        return False

    changed = False
    summary = loop_actions[SUMMARY_UPSERT_ACTION]
    compose = loop_actions[COMPOSE_ACTION]
    raw = loop_actions[RAW_ACTION]
    counter = loop_actions.get(SUMMARY_COUNTER_ACTION)

    if compose.get("runAfter") == {SUMMARY_UPSERT_ACTION: ["Succeeded"]}:
        compose["runAfter"] = dict(summary.get("runAfter") or {})
        changed = True
    if summary.get("runAfter") != {RAW_ACTION: ["Succeeded"]}:
        summary["runAfter"] = {RAW_ACTION: ["Succeeded"]}
        changed = True
    if isinstance(counter, dict) and counter.get("runAfter") != {SUMMARY_UPSERT_ACTION: ["Succeeded"]}:
        counter["runAfter"] = {SUMMARY_UPSERT_ACTION: ["Succeeded"]}
        changed = True
    raw_params = (((raw.get("inputs") or {}).get("parameters")) or {})
    if raw_params.get("recordId") != "@items('For_each_1')?['id']":
        raw_params["recordId"] = "@items('For_each_1')?['id']"
        changed = True
    return changed


def _find_named_action(definition: dict[str, Any], action_name: str) -> dict[str, Any] | None:
    actions = definition.get("actions")
    if not isinstance(actions, dict):
        return None
    for container in _iter_action_containers(actions):
        action = container.get(action_name)
        if isinstance(action, dict):
            return action
    return None


def _find_action_container(definition: dict[str, Any], *action_names: str) -> dict[str, Any] | None:
    actions = definition.get("actions")
    if not isinstance(actions, dict):
        return None
    required = set(action_names)
    for container in _iter_action_containers(actions):
        if required.issubset(container):
            return container
    return None


def harden_audit_record_paging(workflow: dict[str, Any]) -> bool:
    """Bound and fail-close the audit-record paging loop in reusable adapted flows."""
    definition = ((workflow.get("properties") or {}).get("definition")) or {}
    if not isinstance(definition, dict):
        raise UnsupportedSourceError("Workflow JSON has no 'properties.definition' object")

    changed = False
    bounded_limits = {
        "RetryLogic-StartAuditLogQuery": {"count": 3, "timeout": "PT3M"},
        "WaitUntilQueryFinished": {"count": 60, "timeout": "PT3M"},
        "ProcessAuditLogRecords": {"count": 100, "timeout": "PT3M"},
        "RetryLogic-AuditLogRecords": {"count": 3, "timeout": "PT3M"},
    }
    for name, limit in bounded_limits.items():
        action = _find_named_action(definition, name)
        if isinstance(action, dict) and action.get("limit") != limit:
            action["limit"] = dict(limit)
            changed = True

    initial_url = _find_named_action(definition, "Set-InitialAuditLogQueryRecordsURL")
    if isinstance(initial_url, dict):
        inputs = initial_url.setdefault("inputs", {})
        if inputs.get("value") and "$top=500" in inputs["value"]:
            inputs["value"] = inputs["value"].replace("$top=500", "$top=100")
            changed = True

    variable_init = _find_named_action(definition, "AuditLogQueryRecordsURL")
    if isinstance(variable_init, dict):
        variables = ((variable_init.get("inputs") or {}).get("variables")) or []
        for variable in variables:
            if isinstance(variable, dict) and variable.get("name") == "AuditLogQueryRecordsURL":
                if variable.get("value") != "":
                    variable["value"] = ""
                    changed = True

    parse = _find_named_action(definition, "ParseBody-AuditLogRecords")
    if isinstance(parse, dict):
        props = (((parse.get("inputs") or {}).get("schema") or {}).get("properties")) or {}
        next_link = props.get("@@odata.nextLink")
        if isinstance(next_link, dict) and next_link.get("type") != ["string", "null"]:
            next_link["type"] = ["string", "null"]
            changed = True

    paging_container = _find_action_container(
        definition,
        "For_each_1",
        "Set-AuditLogQueryRecordsURL",
        "Add_Records_Retrieved_to_Flow_Log",
    )
    if paging_container is not None:
        setter = paging_container["Set-AuditLogQueryRecordsURL"]
        setter_inputs = setter.setdefault("inputs", {})
        safe_next = "@{coalesce(body('ParseBody-AuditLogRecords')?['@odata.nextLink'], '')}"
        if setter_inputs.get("value") != safe_next:
            setter_inputs["value"] = safe_next
            changed = True
        if setter.get("runAfter") != {"For_each_1": ["Succeeded"]}:
            setter["runAfter"] = {"For_each_1": ["Succeeded"]}
            changed = True

        flow_log = paging_container["Add_Records_Retrieved_to_Flow_Log"]
        if flow_log.get("runAfter") != {"Set-AuditLogQueryRecordsURL": ["Succeeded"]}:
            flow_log["runAfter"] = {"Set-AuditLogQueryRecordsURL": ["Succeeded"]}
            changed = True

        if FLAG_RECORD_ERROR_ACTION not in paging_container:
            paging_container[FLAG_RECORD_ERROR_ACTION] = {
                "runAfter": {"For_each_1": ["Failed", "TimedOut"]},
                "type": "IncrementVariable",
                "inputs": {"name": "varRecordErrorCount", "value": 1},
            }
            changed = True
        if STOP_PAGING_ON_RECORD_ERROR_ACTION not in paging_container:
            paging_container[STOP_PAGING_ON_RECORD_ERROR_ACTION] = {
                "runAfter": {FLAG_RECORD_ERROR_ACTION: ["Succeeded"]},
                "type": "SetVariable",
                "inputs": {"name": "AuditLogQueryRecordsURL", "value": ""},
            }
            changed = True

    process_parent = _find_action_container(definition, "ProcessAuditLogRecords")
    if process_parent is not None:
        fail_action = {
            "runAfter": {"ProcessAuditLogRecords": ["Succeeded", "Failed", "TimedOut"]},
            "type": "If",
            "expression": "@or(greater(variables('varRecordErrorCount'), 0), equals(actions('ProcessAuditLogRecords')?['status'], 'Failed'), equals(actions('ProcessAuditLogRecords')?['status'], 'TimedOut'))",
            "actions": {
                "Terminate_Record_Processing_Failed": {
                    "type": "Terminate",
                    "inputs": {
                        "runStatus": "Failed",
                        "runError": {
                            "code": "RawRecordProcessingFailed",
                            "message": "Audit-record paging or row processing failed; stopping instead of reporting a successful collection.",
                        },
                    },
                },
            },
            "else": {"actions": {}},
        }
        if process_parent.get(RECORD_PROCESSING_FAILURE_ACTION) != fail_action:
            process_parent[RECORD_PROCESSING_FAILURE_ACTION] = fail_action
            changed = True
    return changed


def workflow_can_be_patched(workflow: dict[str, Any]) -> bool:
    try:
        definition = workflow["properties"]["definition"]
        find_foreach_actions(definition)
        return True
    except (KeyError, TypeError, UnsupportedSourceError):
        return False


# --------------------------------------------------------------------------------------
# Zip orchestration
# --------------------------------------------------------------------------------------
def adapt_zip(
    source_zip: Path,
    out_zip: Path,
    *,
    repo_root: Path,
    solution_name: str | None = None,
    solution_version: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    source_zip = source_zip.expanduser()
    out_zip = out_zip.expanduser()

    if not source_zip.is_file():
        raise PrepareError(f"Source solution zip not found: {source_zip}")

    out_resolved = out_zip.resolve()
    if is_within(out_resolved, repo_root):
        raise PrepareError(
            f"Refusing to write the private adapted package inside the repository ({repo_root}). "
            "Choose an --out-zip path outside the repo so it cannot be committed."
        )
    if out_resolved.suffix.lower() != ".zip":
        raise PrepareError("--out-zip must end with .zip")
    if out_resolved.exists() and not overwrite:
        raise PrepareError(f"Output already exists: {out_resolved}. Pass --overwrite to replace it.")

    source_bytes = source_zip.read_bytes()
    source_sha = sha256_bytes(source_bytes)

    with zipfile.ZipFile(io.BytesIO(source_bytes)) as archive:
        names = archive.namelist()
        if "solution.xml" not in names:
            raise UnsupportedSourceError("Source zip is not a Dataverse solution (no solution.xml)")
        members = {name: archive.read(name) for name in names}

    manifest = parse_solution_manifest(members["solution.xml"].decode("utf-8-sig"))
    validate_source_manifest(manifest)

    warnings: list[str] = []
    patched_workflows: list[str] = []
    workflow_names = sorted(n for n in members if n.startswith("Workflows/") and n.endswith(".json"))
    if not workflow_names:
        raise UnsupportedSourceError("Source solution contains no Workflows/*.json definitions")

    for name in workflow_names:
        text = members[name].decode("utf-8-sig")
        try:
            workflow = json.loads(text)
        except json.JSONDecodeError as exc:
            raise UnsupportedSourceError(f"{name} is not valid JSON: {exc}") from exc
        if not workflow_can_be_patched(workflow):
            warnings.append(f"Skipped '{name}': no {FOREACH_ACTION}/{SUMMARY_UPSERT_ACTION} anchor.")
            continue
        inject_raw_action(workflow)
        harden_audit_record_paging(workflow)
        members[name] = json.dumps(workflow, ensure_ascii=False, indent=2).encode("utf-8")
        patched_workflows.append(name)

    if not patched_workflows:
        raise UnsupportedSourceError(
            "No workflow in the source solution matched the expected raw-retention anchor. "
            "Refusing to emit an unmodified or blindly text-replaced package."
        )

    # Update solution metadata on the adapted (still unmanaged) package.
    new_version = solution_version or bump_version(manifest.version)
    xml_text = set_solution_version(manifest.xml_text, manifest.version, new_version)
    effective_name = manifest.unique_name
    if solution_name and solution_name != manifest.unique_name:
        xml_text = set_solution_unique_name(xml_text, manifest.unique_name, solution_name)
        effective_name = solution_name
        warnings.append(
            f"Solution UniqueName changed to '{solution_name}'. The workflow component GUIDs are "
            "unchanged, so importing into an environment that already hosts the original will still "
            "update the same flow. Use a clean/isolated environment to avoid mutating an in-use collector configuration."
        )
    else:
        warnings.append(
            f"Solution UniqueName kept as '{manifest.unique_name}'. Importing this adapted UNMANAGED "
            "package upgrades the existing flow in place. Install into a clean/isolated environment; "
            "do not import over an active managed layer (customised unmanaged over managed may fail "
            "layering)."
        )
    members["solution.xml"] = xml_text.encode("utf-8")

    warnings.append(
        f"Deploy order: create the companion table '{RAW_ENTITY_SET}' (alternate key "
        f"'{RAW_ALTERNATE_KEY}', memo 'poc_payloadjson' max {MEMO_MAX}) with the schema/deploy tool "
        "BEFORE importing this flow. The Dataverse connector binds by dynamic entityName, so no "
        "table metadata is embedded here."
    )
    warnings.append(
        "New actions store full audit payloads and are marked secureData; configure raw retention "
        "size/window and run-history retention per your governance policy."
    )

    out_resolved.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_resolved.with_suffix(out_resolved.suffix + ".partial")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in names:  # preserve original ordering
            archive.writestr(name, members[name])
    tmp.replace(out_resolved)

    out_sha = sha256_bytes(out_resolved.read_bytes())
    provenance = {
        "tool": "Prepare-CollectorRawCapture.py",
        "toolVersion": TOOL_VERSION,
        "generatedAt": _utc_now(),
        "source": {
            "path": str(source_zip),
            "sha256": source_sha,
            "uniqueName": manifest.unique_name,
            "version": manifest.version,
            "managed": manifest.managed,
            "publisherPrefix": manifest.publisher_prefix,
        },
        "output": {
            "path": str(out_resolved),
            "sha256": out_sha,
            "uniqueName": effective_name,
            "version": new_version,
            "managed": False,
        },
        "patchedWorkflows": patched_workflows,
        "injected": {
            "composeAction": COMPOSE_ACTION,
            "rawAction": RAW_ACTION,
            "rawEntitySet": RAW_ENTITY_SET,
            "alternateKey": RAW_ALTERNATE_KEY,
            "idempotenceKeyExpression": "toLower(items('For_each_1')?['id'])",
            "payloadColumn": "poc_payloadjson",
            "payloadHashSetByFlow": False,
            "memoMax": MEMO_MAX,
            "rawRetentionBeforeSummary": True,
            "counterRepointedTo": SUMMARY_UPSERT_ACTION,
            "recordPagingHardened": True,
        },
        "warnings": warnings,
    }
    provenance_path = out_resolved.with_name(out_resolved.stem + ".provenance.json")
    provenance_path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    provenance["provenancePath"] = str(provenance_path)
    return provenance


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--source-zip",
        required=True,
        type=Path,
        help="Explicit path to the PRIVATE, user-supplied UNMANAGED CopilotInteractionLogging "
        "solution zip. Never defaulted; never read from the repository.",
    )
    parser.add_argument(
        "--out-zip",
        required=True,
        type=Path,
        help="Explicit output path for the adapted UNMANAGED zip. MUST be outside this repository.",
    )
    parser.add_argument(
        "--solution-name",
        default=None,
        help="Optional new solution UniqueName for the adapted package (see warnings about layering).",
    )
    parser.add_argument(
        "--solution-version",
        default=None,
        help="Optional explicit solution version. Defaults to incrementing the source version.",
    )
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing --out-zip.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo_root = find_repo_root(Path(__file__))
    try:
        provenance = adapt_zip(
            args.source_zip,
            args.out_zip,
            repo_root=repo_root,
            solution_name=args.solution_name,
            solution_version=args.solution_version,
            overwrite=args.overwrite,
        )
    except PrepareError as exc:
        print(f"Prepare-CollectorRawCapture failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(provenance, indent=2))
    print("", file=sys.stderr)
    print("WARNINGS:", file=sys.stderr)
    for warning in provenance["warnings"]:
        print(f"  - {warning}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
