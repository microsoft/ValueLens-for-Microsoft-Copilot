#!/usr/bin/env python3
"""Deploy (or dry-run) the ValueLens core Dataverse schema via the Metadata Web API.

The deployer reads ``dataverse-core-schema.json`` (the canonical contract emitted by
Build-DataverseCoreFeeds.py) and creates the four core tables, their common
columns, the string/memo primary attribute, and the ``poc_rowkey`` alternate key,
then polls the alternate key until it is Active.

Safety posture
--------------
* Default is a **dry run**: no network calls are made and no credentials are
  required, so ``--dataverse-url dummy`` is accepted for offline planning.
* ``--execute`` is required to perform any write. Only then is the Dataverse URL
  validated (HTTPS *.dynamics.com origin, no userinfo/query/fragment) and a token
  required.
* When a table already exists its attributes are validated against the schema
  (type + max length) instead of blindly assumed correct.

Metadata REST references (public Microsoft Learn docs):
* Create a table:      POST /api/data/v9.2/EntityDefinitions
* Add a column:        POST /api/data/v9.2/EntityDefinitions(LogicalName='..')/Attributes
* Add an alternate key:POST /api/data/v9.2/EntityDefinitions(LogicalName='..')/Keys
No proprietary flow code is copied; only documented Web API shapes are used.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BRIDGE_PATH = HERE / "Build-DataverseCoreFeeds.py"
DEFAULT_SCHEMA = HERE.parent / "dataverse-core-schema.json"
LANGUAGE_CODE = 1033


def _load_bridge() -> Any:
    spec = importlib.util.spec_from_file_location("dataverse_bridge", BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise DeployError(f"Cannot load bridge module at {BRIDGE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeployError(RuntimeError):
    pass


bridge = _load_bridge()


def label(text: str) -> dict[str, Any]:
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.Label",
        "LocalizedLabels": [
            {
                "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                "Label": text,
                "LanguageCode": LANGUAGE_CODE,
            }
        ],
    }


def load_schema(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    validate_schema_document(document)
    return document


def validate_schema_document(document: dict[str, Any]) -> None:
    for key in ("primaryAttribute", "commonColumns", "alternateKey", "tables"):
        if key not in document:
            raise DeployError(f"Schema is missing required key '{key}'")
    primary = document["primaryAttribute"]
    if primary.get("logicalName") != "poc_name" or primary.get("type") != "String":
        raise DeployError("Schema primaryAttribute must be the String column poc_name")
    columns = {column["logicalName"]: column for column in document["commonColumns"]}
    for expected in ("poc_rowkey", "poc_runid", "poc_payloadhash", "poc_payloadjson"):
        if expected not in columns:
            raise DeployError(f"Schema commonColumns is missing '{expected}'")
    payload = columns["poc_payloadjson"]
    if payload.get("type") != "Memo" or int(payload.get("maxLength", 0)) != bridge.MEMO_LIMIT:
        raise DeployError("poc_payloadjson must be a Memo column with the 1,048,576 char limit")
    if columns["poc_payloadhash"].get("maxLength") != 64:
        raise DeployError("poc_payloadhash must have max length 64")
    alt = document["alternateKey"]
    if alt.get("keyAttributes") != ["poc_rowkey"]:
        raise DeployError("Alternate key must be keyed on poc_rowkey")
    sets = {table.get("entitySetName") for table in document["tables"]}
    if sets != set(bridge.ALLOWED_ENTITY_SETS):
        raise DeployError(f"Schema entity sets {sorted(sets)} do not match the allowlist {sorted(bridge.ALLOWED_ENTITY_SETS)}")
    for table in document["tables"]:
        entity_set = table.get("entitySetName")
        expected_logical = bridge.ENTITY_LOGICAL_BY_SET.get(entity_set)
        if table.get("logicalName") != expected_logical:
            raise DeployError(
                f"Entity set '{entity_set}' must map to logical name '{expected_logical}', got '{table.get('logicalName')}'"
            )


def _string_attribute(column: dict[str, Any], *, primary: bool = False) -> dict[str, Any]:
    body = {
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        "SchemaName": column["logicalName"],
        "DisplayName": label(column.get("displayName", column["logicalName"])),
        "RequiredLevel": {"Value": "ApplicationRequired" if column.get("required") else "None"},
        "MaxLength": int(column.get("maxLength", 100)),
        "FormatName": {"Value": "Text"},
    }
    if primary:
        body["IsPrimaryName"] = True
        body["RequiredLevel"] = {"Value": "ApplicationRequired"}
    return body


def _memo_attribute(column: dict[str, Any]) -> dict[str, Any]:
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
        "SchemaName": column["logicalName"],
        "DisplayName": label(column.get("displayName", column["logicalName"])),
        "RequiredLevel": {"Value": "None"},
        "MaxLength": int(column.get("maxLength", bridge.MEMO_LIMIT)),
        "Format": "Text",
    }


def _attribute_body(column: dict[str, Any]) -> dict[str, Any]:
    if column.get("type") == "Memo":
        return _memo_attribute(column)
    return _string_attribute(column)


def _table_body(document: dict[str, Any], table: dict[str, Any]) -> dict[str, Any]:
    return {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
        "SchemaName": table["logicalName"],
        "EntitySetName": table["entitySetName"],
        "DisplayName": label(table.get("displayName", table["logicalName"])),
        "DisplayCollectionName": label(table.get("displayCollectionName", table["entitySetName"])),
        "Description": label(table.get("description", "")),
        "OwnershipType": table.get("ownershipType", "UserOwned"),
        "IsActivity": False,
        "HasActivities": bool(table.get("hasActivities", False)),
        "HasNotes": bool(table.get("hasNotes", False)),
        "Attributes": [_string_attribute(document["primaryAttribute"], primary=True)],
    }


def plan_operations(document: dict[str, Any]) -> list[str]:
    plan: list[str] = []
    for table in document["tables"]:
        logical = table["logicalName"]
        plan.append(f"CREATE TABLE {logical} (set={table['entitySetName']}) primary poc_name String(100)")
        for column in document["commonColumns"]:
            kind = "Memo" if column.get("type") == "Memo" else f"String({column.get('maxLength')})"
            plan.append(f"  ADD COLUMN {logical}.{column['logicalName']} {kind}")
        plan.append(f"  ADD ALTERNATE KEY {document['alternateKey']['schemaName']} -> [poc_rowkey]; poll until Active")
    return plan


# --- Execution (network) helpers -------------------------------------------------


def _meta_url(url: str, suffix: str) -> str:
    return url.rstrip("/") + f"/api/data/{bridge.API_VERSION}/{suffix}"


def _entity_exists(url: str, token: str, logical: str) -> dict[str, Any] | None:
    target = _meta_url(url, f"EntityDefinitions(LogicalName='{logical}')?$select=LogicalName,EntitySetName")
    try:
        return bridge.dataverse_request("GET", target, token)
    except bridge.PathwayError as exc:
        if "HTTP 404" in str(exc):
            return None
        raise


def _existing_attributes(url: str, token: str, logical: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    # MaxLength belongs to these derived metadata types, not AttributeMetadata.
    for attribute_type in ("String", "Memo"):
        target = _meta_url(
            url,
            f"EntityDefinitions(LogicalName='{logical}')/Attributes/"
            f"Microsoft.Dynamics.CRM.{attribute_type}AttributeMetadata"
            "?$select=LogicalName,AttributeType,MaxLength",
        )
        page = bridge.dataverse_request("GET", target, token)
        if not isinstance(page.get("value"), list):
            raise DeployError("Attribute metadata response did not contain a value array")
        result.update({item["LogicalName"]: item for item in page["value"]})
    return result


def _validate_existing_columns(url: str, token: str, document: dict[str, Any], logical: str) -> list[str]:
    attributes = _existing_attributes(url, token, logical)
    primary_name = document["primaryAttribute"]["logicalName"]
    problems: list[str] = []
    for column in [document["primaryAttribute"], *document["commonColumns"]]:
        name = column["logicalName"]
        found = attributes.get(name)
        if not found:
            problems.append(f"{logical}.{name} is missing")
            continue
        expected_type = "Memo" if column.get("type") == "Memo" else "String"
        if found.get("AttributeType") != expected_type:
            problems.append(f"{logical}.{name} type is {found.get('AttributeType')}, expected {expected_type}")
        expected_len = int(column.get("maxLength", 0))
        actual_len = found.get("MaxLength")
        if name == primary_name:
            # Dataverse manages the primary-name attribute's MaxLength itself
            # (it assigns a platform default of 850 and ignores a smaller
            # requested value at table-create time), so only require that the
            # live length is at least what the schema asked for.
            if isinstance(actual_len, int) and actual_len < expected_len:
                problems.append(f"{logical}.{name} MaxLength is {actual_len}, expected at least {expected_len}")
        elif actual_len != expected_len:
            problems.append(f"{logical}.{name} MaxLength is {actual_len}, expected {expected_len}")
    return problems


def _poll_key_active(url: str, token: str, logical: str, key_schema: str, timeout: float) -> None:
    target = _meta_url(
        url,
        f"EntityDefinitions(LogicalName='{logical}')/Keys?$select=SchemaName,EntityKeyIndexStatus",
    )
    deadline = time.monotonic() + timeout
    while True:
        page = bridge.dataverse_request("GET", target, token)
        status = next(
            (item.get("EntityKeyIndexStatus") for item in page.get("value", []) if item.get("SchemaName") == key_schema),
            None,
        )
        if status == "Active":
            return
        if status == "Failed":
            raise DeployError(f"Alternate key {key_schema} on {logical} failed to activate")
        if time.monotonic() > deadline:
            raise DeployError(f"Alternate key {key_schema} on {logical} not Active within {timeout:.0f}s (status={status})")
        time.sleep(3)


def deploy(document: dict[str, Any], url: str, token: str, timeout: float, log: Any) -> None:
    bridge.validate_dataverse_url(url)
    if not token:
        raise DeployError("--execute requires a token (DATAVERSE_TOKEN or --dataverse-token)")
    for table in document["tables"]:
        logical = table["logicalName"]
        existing = _entity_exists(url, token, logical)
        if existing is None:
            log(f"Creating table {logical}")
            bridge.dataverse_request("POST", _meta_url(url, "EntityDefinitions"), token, _table_body(document, table))
        else:
            log(f"Table {logical} exists; validating attributes")
            if existing.get("EntitySetName") != table["entitySetName"]:
                raise DeployError(f"{logical} has an incompatible EntitySetName")
        # Add any missing common columns (existing ones are validated below).
        current = _existing_attributes(url, token, logical) if existing else {}
        for column in document["commonColumns"]:
            if column["logicalName"] in current:
                continue
            log(f"  Adding column {logical}.{column['logicalName']}")
            bridge.dataverse_request(
                "POST",
                _meta_url(url, f"EntityDefinitions(LogicalName='{logical}')/Attributes"),
                token,
                _attribute_body(column),
            )
        problems = _validate_existing_columns(url, token, document, logical)
        if problems:
            raise DeployError("Existing schema mismatch: " + "; ".join(problems))
        key_schema = document["alternateKey"]["schemaName"]
        log(f"  Ensuring alternate key {key_schema} on {logical}")
        keys = bridge.dataverse_request(
            "GET", _meta_url(url, f"EntityDefinitions(LogicalName='{logical}')/Keys?$select=SchemaName,KeyAttributes"),
            token,
        )
        if not isinstance(keys.get("value"), list):
            raise DeployError("Key metadata response did not contain a value array")
        existing_key = next((key for key in keys["value"] if key["SchemaName"] == key_schema), None)
        if existing_key is not None and existing_key.get("KeyAttributes") != document["alternateKey"]["keyAttributes"]:
            raise DeployError(f"{logical}.{key_schema} has incompatible key attributes")
        if existing_key is None:
            bridge.dataverse_request(
                "POST",
                _meta_url(url, f"EntityDefinitions(LogicalName='{logical}')/Keys"),
                token,
                {
                    "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
                    "SchemaName": key_schema,
                    "DisplayName": label(document["alternateKey"].get("displayName", "Row Key")),
                    "KeyAttributes": document["alternateKey"]["keyAttributes"],
                },
            )
        _poll_key_active(url, token, logical, key_schema, timeout)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA, help="Path to dataverse-core-schema.json")
    parser.add_argument("--dataverse-url", required=True, help="Dataverse environment URL (dummy is fine for dry-run)")
    parser.add_argument(
        "--dataverse-token",
        default=os.environ.get("DATAVERSE_TOKEN"),
        help="Bearer token. Prefer the DATAVERSE_TOKEN env var over the CLI.",
    )
    parser.add_argument("--execute", action="store_true", help="Perform writes. Default is a no-network dry run.")
    parser.add_argument("--key-timeout", type=float, default=300.0, help="Seconds to wait for alternate key activation")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    log = (lambda *_: None) if args.quiet else (lambda *m: print(*m))
    document = load_schema(args.schema)

    if not args.execute:
        log("DRY RUN (no network). Planned operations:")
        for line in plan_operations(document):
            log(line)
        log("Re-run with --execute against a real HTTPS *.dynamics.com URL and a token to apply.")
        return 0

    deploy(document, args.dataverse_url, args.dataverse_token, args.key_timeout, log)
    log("Schema deployment complete.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, DeployError, bridge.PathwayError) as exc:
        print(f"Deploy-DataverseCoreSchema failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
