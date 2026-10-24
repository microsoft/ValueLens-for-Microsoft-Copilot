"""Create the Consumption Central tables in Dataverse.

Reads `dataverse-schema.json` - which is generated from the report template, so
the column names here are the ones the report binds to - and creates the tables,
columns and alternate keys in a Dataverse environment.

Nothing is written without `--execute`. The default is a dry run that prints the
plan, so you can see exactly what would be created before it is.

Re-running is safe. Anything that already exists is left alone, so this can be
used to add tables from a later release without disturbing loaded data.

    export DATAVERSE_TOKEN="..."
    python Deploy-DataverseSchema.py --environment https://your-org.crm.dynamics.com
    python Deploy-DataverseSchema.py --environment https://your-org.crm.dynamics.com --execute

Get a token with the Azure CLI:

    az account get-access-token \
        --resource https://your-org.crm.dynamics.com \
        --query accessToken -o tsv
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCHEMA_FILE = Path(__file__).resolve().parents[1] / "dataverse-schema.json"
API = "/api/data/v9.2"
TIMEOUT = 60

# Dataverse creates an alternate key asynchronously. It is normally ready in a
# few seconds, but the flow cannot upsert until it is Active, so wait rather
# than leave someone with a flow that fails on its first run.
KEY_TIMEOUT = 180
KEY_POLL = 5

TYPES = {
    "String": {
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        "AttributeType": "String", "AttributeTypeName": {"Value": "StringType"},
        "FormatName": {"Value": "Text"}, "MaxLength": 4000,
    },
    "Memo": {
        "@odata.type": "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
        "AttributeType": "Memo", "AttributeTypeName": {"Value": "MemoType"},
        "MaxLength": 100000,
    },
    "Integer": {
        "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
        "AttributeType": "Integer", "AttributeTypeName": {"Value": "IntegerType"},
        "MinValue": -2147483648, "MaxValue": 2147483647,
    },
    "Decimal": {
        "@odata.type": "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
        "AttributeType": "Decimal", "AttributeTypeName": {"Value": "DecimalType"},
        "Precision": 6, "MinValue": -100000000000, "MaxValue": 100000000000,
    },
    "DateTime": {
        "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
        "AttributeType": "DateTime", "AttributeTypeName": {"Value": "DateTimeType"},
        "Format": "DateAndTime",
        # Usage dates are calendar dates from a billing system, not moments in
        # time. Letting Dataverse shift them by a time zone would move usage
        # between days and quietly change the daily numbers.
        "DateTimeBehavior": {"Value": "TimeZoneIndependent"},
    },
    "Boolean": {
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
        "AttributeType": "Boolean", "AttributeTypeName": {"Value": "BooleanType"},
        "OptionSet": {
            "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
            "TrueOption": {"Value": 1, "Label": {"@odata.type": "Microsoft.Dynamics.CRM.Label",
                           "LocalizedLabels": [{"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                                                "Label": "Yes", "LanguageCode": 1033}]}},
            "FalseOption": {"Value": 0, "Label": {"@odata.type": "Microsoft.Dynamics.CRM.Label",
                            "LocalizedLabels": [{"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                                                 "Label": "No", "LanguageCode": 1033}]}},
        },
    },
}


def fail(message: str) -> None:
    sys.exit(f"error: {message}")


def label(text: str) -> dict:
    return {"@odata.type": "Microsoft.Dynamics.CRM.Label",
            "LocalizedLabels": [{"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                                 "Label": text, "LanguageCode": 1033}]}


class Dataverse:
    def __init__(self, environment: str, token: str, execute: bool):
        parsed = urllib.parse.urlparse(environment)
        if parsed.scheme != "https" or not parsed.hostname:
            fail("--environment must be an https URL")
        if not parsed.hostname.endswith(".dynamics.com"):
            fail(f"refusing to send a token to {parsed.hostname}")
        self.base = f"https://{parsed.hostname}{API}"
        self.token = token
        self.execute = execute

    def request(self, method: str, path: str, body=None):
        url = path if path.startswith("https://") else f"{self.base}/{path}"
        if not url.startswith(self.base):
            fail(f"refusing to follow {url}")
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        })
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            if error.code == 429:
                wait = int(error.headers.get("Retry-After", "10"))
                print(f"    throttled, waiting {wait}s")
                time.sleep(min(wait, 120))
                return self.request(method, path, body)
            raise RuntimeError(f"{method} {url} -> {error.code}: {detail}") from None

    def exists(self, path: str) -> bool:
        # A dry run with no token still has to print a useful plan, so assume
        # nothing exists rather than refuse to run. With a token we check for
        # real, which makes the dry run an accurate preview.
        if not self.token:
            return False
        try:
            self.request("GET", path)
            return True
        except RuntimeError as error:
            if " -> 404" in str(error):
                return False
            raise


def create_table(client: Dataverse, table: dict, prefix: str) -> None:
    logical = table["logicalName"]
    path = f"EntityDefinitions(LogicalName='{logical}')"
    if client.exists(path):
        print(f"  {logical:34} exists")
        return
    if not client.execute:
        print(f"  {logical:34} would create")
        return
    client.request("POST", "EntityDefinitions", {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
        "SchemaName": logical,
        "DisplayName": label(table["displayName"]),
        "DisplayCollectionName": label(table["displayName"]),
        "HasActivities": False, "HasNotes": False, "IsActivity": False,
        "OwnershipType": "OrganizationOwned",
        "Attributes": [dict(TYPES["String"], **{
            "SchemaName": f"{prefix}name",
            "DisplayName": label("Name"),
            "MaxLength": 400,
            "IsPrimaryName": True,
            "RequiredLevel": {"Value": "None"},
        })],
    })
    print(f"  {logical:34} created")


def create_column(client: Dataverse, logical: str, column: dict) -> None:
    name = column["logicalName"]
    path = f"EntityDefinitions(LogicalName='{logical}')/Attributes(LogicalName='{name}')"
    if client.exists(path):
        return
    if not client.execute:
        print(f"      + {name} ({column['type']})")
        return
    body = dict(TYPES[column["type"]])
    if "maxLength" in column and "MaxLength" in body:
        body["MaxLength"] = column["maxLength"]
    body.update({
        "SchemaName": name,
        "DisplayName": label(column["displayName"]),
        "RequiredLevel": {"Value": "None"},
    })
    client.request("POST", f"EntityDefinitions(LogicalName='{logical}')/Attributes", body)
    print(f"      + {name}")


def create_key(client: Dataverse, logical: str, prefix: str) -> None:
    key = f"{logical}_rowkey"
    path = f"EntityDefinitions(LogicalName='{logical}')/Keys(LogicalName='{key.lower()}')"
    if client.exists(path):
        print(f"      key {key} exists")
        return
    if not client.execute:
        print(f"      key {key} would be created on {prefix}rowkey")
        return
    client.request("POST", f"EntityDefinitions(LogicalName='{logical}')/Keys", {
        "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
        "SchemaName": key,
        "DisplayName": label("Row Key"),
        "KeyAttributes": [f"{prefix}rowkey"],
    })

    deadline = time.time() + KEY_TIMEOUT
    while time.time() < deadline:
        state = client.request("GET", f"{path}?$select=EntityKeyIndexStatus")
        status = (state or {}).get("EntityKeyIndexStatus")
        if status == "Active":
            print(f"      key {key} active")
            return
        if status in ("Failed", "InProgress_Failed"):
            fail(f"{logical}: alternate key failed to build")
        time.sleep(KEY_POLL)
    print(f"      key {key} still building - the flow cannot upsert until it is Active")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--environment", required=True,
                        help="https://your-org.crm.dynamics.com")
    parser.add_argument("--execute", action="store_true",
                        help="actually create things; without it this is a dry run")
    parser.add_argument("--table", action="append",
                        help="only this source table; repeatable")
    arguments = parser.parse_args()

    if not SCHEMA_FILE.exists():
        fail(f"{SCHEMA_FILE.name} not found - run generate_dataverse_schema.py first")
    schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    prefix = schema["publisherPrefix"] + "_"

    token = os.environ.get("DATAVERSE_TOKEN", "").strip()
    if arguments.execute and not token:
        fail("DATAVERSE_TOKEN is not set")

    tables = schema["tables"]
    if arguments.table:
        wanted = set(arguments.table)
        tables = [t for t in tables if t["sourceTable"] in wanted]
        missing = wanted - {t["sourceTable"] for t in tables}
        if missing:
            fail(f"unknown table(s): {', '.join(sorted(missing))}")

    client = Dataverse(arguments.environment, token, arguments.execute)
    mode = "creating" if arguments.execute else "DRY RUN - nothing will be created"
    columns = sum(len(t["columns"]) for t in tables) + len(schema["commonColumns"]) * len(tables)
    print(f"{mode}: {len(tables)} tables, {columns} columns\n")

    for table in tables:
        logical = table["logicalName"]
        create_table(client, table, prefix)
        for column in schema["commonColumns"] + table["columns"]:
            create_column(client, logical, column)
        create_key(client, logical, prefix)

    if not arguments.execute:
        print("\nnothing was created. re-run with --execute to apply this plan.")
    else:
        print("\ndone. next: import the flows, then run the backfill flow once.")


if __name__ == "__main__":
    main()
