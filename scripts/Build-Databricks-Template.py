"""Derive the Databricks ValueLens template from the Fabric template.

The Databricks template is the Fabric template with only its source swapped: the two Fabric
connection parameters become four Databricks parameters, and the FabricTable helper is replaced
by scripts/databricks/FabricTable.pq. Every table, column, measure, relationship, refresh policy
and report part is carried over unchanged, and the build refuses to write if anything else moved.

    python scripts/Build-Databricks-Template.py            # write the .pbit and the pbip/ PBIP project
    python scripts/Build-Databricks-Template.py --check    # fail if either is stale
    python scripts/Build-Databricks-Template.py --pbip DIR # also write a PBIP project to another DIR
"""
import argparse
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_TEMPLATE = ROOT / "1. Fabric" / "Manual setup" / "ValueLens - Fabric.pbit"
TEMPLATE = ROOT / "6. Other Data Lake" / "Databricks" / "ValueLens - Databricks.pbit"
PBIP_DIR = ROOT / "6. Other Data Lake" / "Databricks" / "pbip"
HELPER = ROOT / "scripts" / "databricks" / "FabricTable.pq"
NAME = "ValueLens - Databricks"
FABRIC_PARAMETERS = ("Fabric SQL Endpoint", "Lakehouse Name")
REQUIRED = 'meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]'
PARAMETERS = (
    ("Databricks Server Hostname", "null",
     "Required. The SQL warehouse Server Hostname, for example adb-1234567890123456.7.azuredatabricks.net. "
     "Copy it from SQL Warehouses -> your warehouse -> Connection details.",
     "1a2b3c4d-db01-4001-8001-000000000001"),
    ("Databricks HTTP Path", "null",
     "Required. The SQL warehouse HTTP Path, for example /sql/1.0/warehouses/1234567890abcdef. "
     "Copy it from SQL Warehouses -> your warehouse -> Connection details.",
     "1a2b3c4d-db01-4001-8001-000000000002"),
    ("Databricks Catalog", '"main"',
     "Required. The Unity Catalog catalog the ValueLens notebooks write to (notebook widget catalog).",
     "1a2b3c4d-db01-4001-8001-000000000003"),
    ("Databricks Schema", '"dbo"',
     "Required. The Unity Catalog schema the ValueLens notebooks write to (notebook widget schema).",
     "1a2b3c4d-db01-4001-8001-000000000004"),
)
FILE_DESCRIPTION = (
    "ValueLens for Microsoft Copilot - Databricks\n"
    "Reads the ValueLens tables from Unity Catalog through a Databricks SQL warehouse.\n"
    "Enter the Server Hostname, HTTP Path, catalog and schema, then Load.\n"
)
OWNED_PARTS = ("DataModelSchema", "Metadata")
ZIP_METADATA = (
    "filename", "orig_filename", "date_time", "compress_type", "comment", "extra",
    "create_system", "create_version", "extract_version", "reserved", "flag_bits",
    "volume", "internal_attr", "external_attr",
)


def read_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or "DataModelSchema" not in names:
            raise ValueError("expected unique ZIP members including DataModelSchema")
        if "UnappliedChanges" in names:
            raise ValueError("the source template has pending Power Query edits; apply them first")
        return infos, {info.filename: archive.read(info) for info in infos}, archive.comment


def decode(payload):
    return json.loads(payload.decode("utf-16-le"))


def dump(document, newline="\n"):
    return json.dumps(document, ensure_ascii=False, indent=2).replace("\n", newline).encode("utf-16-le")


def one(records, name):
    matches = [record for record in records if record.get("name") == name]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one expression {name!r}, found {len(matches)}")
    return matches[0]


def source_neutral(model):
    """The model with the owned source objects masked, for the unrelated-fields check."""
    result = copy.deepcopy(model)
    owned = set(FABRIC_PARAMETERS) | {name for name, *_ in PARAMETERS} | {"FabricTable"}
    result["expressions"] = [e for e in result["expressions"] if e["name"] not in owned]
    for annotation in result.get("annotations", []):
        if annotation["name"] == "PBI_QueryOrder":
            order = [n for n in json.loads(annotation["value"]) if n not in owned]
            annotation["value"] = json.dumps(order)
    return result


def convert_model(document, helper_lines):
    model = document["model"]
    expressions = model["expressions"]
    template = one(expressions, FABRIC_PARAMETERS[0])
    position = expressions.index(template)
    for name in FABRIC_PARAMETERS:
        expressions.remove(one(expressions, name))
    parameters = []
    for name, default, description, lineage in PARAMETERS:
        record = copy.deepcopy(template)
        record.update(name=name, description=description, lineageTag=lineage,
                      expression=f"{default} {REQUIRED}")
        parameters.append(record)
    expressions[position:position] = parameters
    helper = one(expressions, "FabricTable")
    if not isinstance(helper.get("expression"), list):
        raise ValueError("expected the line-array FabricTable representation")
    helper["expression"] = helper_lines
    annotation = one(model["annotations"], "PBI_QueryOrder")
    order = json.loads(annotation["value"])
    start = order.index(FABRIC_PARAMETERS[0])
    order = [n for n in order if n not in FABRIC_PARAMETERS]
    order[start:start] = [name for name, *_ in PARAMETERS]
    annotation["value"] = json.dumps(order, ensure_ascii=False, separators=(",", ":"))
    text = json.dumps(model, ensure_ascii=False)
    for name in FABRIC_PARAMETERS:
        if f'#\\"{name}\\"' in text:
            raise ValueError(f"the Fabric parameter {name!r} is still referenced")
    return document


def build_template(original, helper):
    lines = helper.decode("utf-8").replace("\r\n", "\n").split("\n")
    if lines == [""]:
        raise ValueError("the Databricks FabricTable helper is empty")
    infos, payloads, comment = read_archive(original)
    raw = payloads["DataModelSchema"].decode("utf-16-le")
    newline = "\r\n" if "\r\n" in raw else "\n"
    document = json.loads(raw)
    if dump(document, newline) != payloads["DataModelSchema"]:
        raise ValueError("DataModelSchema does not round-trip; refusing to rewrite it")
    before = copy.deepcopy(document["model"])
    convert_model(document, lines)
    if source_neutral(before) != source_neutral(document["model"]):
        raise ValueError("unrelated model fields changed")
    payloads["DataModelSchema"] = dump(document, newline)
    metadata = decode(payloads["Metadata"])
    metadata["FileDescription"] = FILE_DESCRIPTION
    payloads["Metadata"] = json.dumps(metadata, ensure_ascii=False).encode("utf-16-le")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.comment = comment
        for info in infos:
            archive.writestr(copy.copy(info), payloads[info.filename])
    rebuilt = output.getvalue()
    validate_rebuild(original, rebuilt)
    return rebuilt


def validate_rebuild(original, rebuilt):
    before_infos, before, before_comment = read_archive(original)
    after_infos, after, after_comment = read_archive(rebuilt)
    if list(before) != list(after) or before_comment != after_comment:
        raise ValueError("ZIP members, order or archive comment changed")
    for old, new in zip(before_infos, after_infos):
        if any(getattr(old, key) != getattr(new, key) for key in ZIP_METADATA):
            raise ValueError(f"ZIP metadata changed: {old.filename}")
        if old.filename not in OWNED_PARTS and before[old.filename] != after[new.filename]:
            raise ValueError(f"unrelated ZIP member changed: {old.filename}")
    if source_neutral(decode(before["DataModelSchema"])["model"]) != source_neutral(
            decode(after["DataModelSchema"])["model"]):
        raise ValueError("unrelated model fields changed")


def platform(item_type, logical_id):
    return {
        "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
        "metadata": {"type": item_type, "displayName": NAME},
        "config": {"version": "2.0", "logicalId": logical_id},
    }


def pbip_files(template):
    """Return the PBIP project for the template as {relative path: bytes}.

    The model is DataModelSchema as model.bim. The report is already in the enhanced PBIR format
    (Report/definition/...), so its parts are copied byte for byte rather than converted to the
    legacy single-file report.json.
    """
    _, payloads, _ = read_archive(template)
    model_dir = Path(f"{NAME}.SemanticModel")
    report_dir = Path(f"{NAME}.Report")
    documents = {
        Path(f"{NAME}.pbip"): {
            "$schema": "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json",
            "version": "1.0",
            "artifacts": [{"report": {"path": f"{NAME}.Report"}}],
            "settings": {"enableAutoRecovery": True},
        },
        model_dir / "definition.pbism": {
            "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
            "version": "1.0",
            "settings": {},
        },
        report_dir / "definition.pbir": {
            "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
            "version": "4.0",
            "datasetReference": {"byPath": {"path": f"../{NAME}.SemanticModel"}},
        },
        model_dir / "model.bim": decode(payloads["DataModelSchema"]),
        model_dir / "diagramLayout.json": decode(payloads["DiagramLayout"]),
        model_dir / ".platform": platform("SemanticModel", "1a2b3c4d-db01-4001-8001-0000000000a1"),
        report_dir / ".platform": platform("Report", "1a2b3c4d-db01-4001-8001-0000000000a2"),
        Path(".gitignore"): None,
    }
    files = {}
    for path, document in documents.items():
        if document is None:
            files[path.as_posix()] = b"**/.pbi/localSettings.json\n**/.pbi/cache.abf\n"
        else:
            files[path.as_posix()] = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    for member, payload in payloads.items():
        if member.startswith("Report/"):
            files[(report_dir / member[len("Report/"):]).as_posix()] = payload
    return files


def long_path(path):
    """Prefix an absolute Windows path so deep PBIR parts work past MAX_PATH."""
    path = os.path.abspath(path)
    if os.name == "nt" and not path.startswith("\\\\?\\"):
        return "\\\\?\\" + path
    return path


def existing_pbip(directory):
    root = long_path(directory)
    if not os.path.isdir(root):
        return {}
    files = {}
    for folder, subfolders, names in os.walk(root):
        subfolders[:] = [name for name in subfolders if name != ".pbi"]
        for name in names:
            full = os.path.join(folder, name)
            with open(full, "rb") as handle:
                files[os.path.relpath(full, root).replace(os.sep, "/")] = handle.read()
    return files


def write_pbip(template, directory):
    """Write the template as a PBIP project, removing generated files that no longer exist."""
    root = long_path(directory)
    expected = pbip_files(template)
    existing = existing_pbip(directory)
    for relative in set(existing) - set(expected):
        os.remove(os.path.join(root, *relative.split("/")))
    for relative, payload in expected.items():
        if existing.get(relative) == payload:
            continue
        path = os.path.join(root, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(payload)
    return Path(directory) / f"{NAME}.pbip"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail if the Databricks template is stale")
    parser.add_argument("--pbip", metavar="DIR", help="also write a PBIP project to another DIR")
    args = parser.parse_args(argv)
    original = SOURCE_TEMPLATE.read_bytes()
    rebuilt = build_template(original, HELPER.read_bytes())
    current = TEMPLATE.read_bytes() if TEMPLATE.exists() else None
    if args.check:
        stale = []
        if current != rebuilt:
            stale.append(TEMPLATE)
        if existing_pbip(PBIP_DIR) != pbip_files(rebuilt):
            stale.append(PBIP_DIR)
        for path in stale:
            print(f"Databricks template is stale: {path.relative_to(ROOT)}", file=sys.stderr)
        if stale:
            return 1
        print("Databricks template and PBIP project: current")
        return 0
    elif current != rebuilt:
        if SOURCE_TEMPLATE.read_bytes() != original:
            raise ValueError("Fabric template changed during the build; refusing to write")
        TEMPLATE.write_bytes(rebuilt)
        print("Databricks template: written")
    else:
        print("Databricks template: current")
    print(f"PBIP project: {write_pbip(rebuilt, PBIP_DIR).relative_to(ROOT)}")
    if args.pbip:
        print(f"PBIP project: {write_pbip(rebuilt, args.pbip)}")
    print("PBIT SHA256: " + hashlib.sha256(rebuilt).hexdigest())
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Databricks template build failed: {error}", file=sys.stderr)
        sys.exit(1)
