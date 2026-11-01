"""Rename Department to Organization in the org query only when there's no Organization column.

"Chat + Agent Org Data" renames the first column whose name normalises to "department" to
Organization. The Graph org data ingester always writes Organization, and the Workday org data
adds any column the table lacks, so a Workday export with a Department column made the rename
collide with Organization and the refresh failed. An org data CSV with both columns failed the
same way. The query now renames Department only when there's no Organization column, and
otherwise leaves both columns as they are. It doesn't fill a blank Organization from Department.

Every active data-source variant's ValueLens template and the Agent Evaluator carry the query, and
the installer builds the Fabric model from ValueLens - Fabric.pbit. The archived Power Automate +
Dataverse template is frozen, so it isn't patched. The change lands in DataModelSchema and, when a
template has one, in the UnappliedChanges copy. Every other model field and ZIP member is left
untouched, and the script is idempotent. Ported from the Analytics Hub's script of the same name.

    python scripts/Update-Org-Department-Rename.py           # patch the templates in place
    python scripts/Update-Org-Department-Rename.py --check   # exit 1 if any template is stale

Desktop refresh still needs live QA after a change here.
"""
import argparse
import copy
import io
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FABRIC = Path("1. Fabric") / "Manual setup"
TEMPLATES = (
    FABRIC / "ValueLens - Fabric.pbit",
    FABRIC / "ValueLens - Fabric OneLake.pbit",
    FABRIC / "Add Agent Evaluator" / "Agent Evaluator.pbit",
    Path("4. SharePoint") / "ValueLens - SharePoint.pbit",
    Path("5. Local CSV") / "ValueLens - Local CSV.pbit",
)
QUERY = "Chat + Agent Org Data"
ZIP_METADATA = (
    "filename", "orig_filename", "date_time", "compress_type", "comment", "extra",
    "create_system", "create_version", "extract_version", "reserved", "flag_bits",
    "volume", "internal_attr", "external_attr",
)

OLD = "\n".join((
    "    // Rename Department to Organization (if exists)",
    "    RenamedColumns =",
    "        if colDepartment <> null then",
))
NEW = "\n".join((
    "    // Rename Department to Organization only when there's no Organization column: renaming",
    "    // onto an existing one fails the refresh. The table can have both when a Workday export",
    "    // adds a Department column, and Organization is then left as it is.",
    "    RenamedColumns =",
    "        if colDepartment <> null and not Table.HasColumns(RenamedPersonId, \"Organization\") then",
))


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def lines(text):
    """PBIT JSON keeps single-line text as a string and multi-line text as a line array."""
    parts = text.split("\n")
    return parts if len(parts) > 1 else text


def guarded(label, text):
    if NEW in text:
        return text
    if text.count(OLD) != 1:
        raise ValueError(f"{label}: expected the Department rename once, found it {text.count(OLD)} times")
    return text.replace(OLD, NEW)


def one(records, name, label):
    hits = [r for r in records if r.get("name") == name]
    if len(hits) != 1:
        raise ValueError(f"{label}: expected one {name!r}, found {len(hits)}")
    return hits[0]


def set_last_loaded(query, old_text, new_text):
    """Keep the last-loaded copy in step when it matched the query, so Desktop shows no pending edits."""
    raw = query.get("lastLoadedAsTableFormulaText")
    if not raw:
        return
    data = json.loads(raw)
    if json.dumps(data, ensure_ascii=False, separators=(",", ":")) != raw:
        raise ValueError(f"{query['name']}: lastLoadedAsTableFormulaText does not round-trip")
    if data.get("RootFormulaText") == old_text:
        data["RootFormulaText"] = new_text
        query["lastLoadedAsTableFormulaText"] = json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def model_source(document):
    table = one(document["model"]["tables"], QUERY, "DataModelSchema tables")
    partitions = table.get("partitions", [])
    if len(partitions) != 1 or partitions[0]["source"].get("type") != "m":
        raise ValueError(f"{QUERY} is not a single-partition M table")
    return partitions[0]["source"]


def edit_model(document):
    source = model_source(document)
    old = joined(source["expression"])
    new = guarded(f"DataModelSchema {QUERY}", old)
    if new == old:
        return False
    source["expression"] = lines(new)
    return True


def edit_pending(document):
    query = one(document["queries"], QUERY, "UnappliedChanges queries")
    old = joined(query["text"])
    new = guarded(f"UnappliedChanges {QUERY}", old)
    if new == old:
        return False
    query["text"] = new.split("\n")
    set_last_loaded(query, old, new)
    return True


def masked_model(document):
    result = copy.deepcopy(document)
    model_source(result)["expression"] = "<owned>"
    return result


def masked_pending(document):
    result = copy.deepcopy(document)
    query = one(result["queries"], QUERY, "UnappliedChanges queries")
    query["text"] = "<owned>"
    query.pop("lastLoadedAsTableFormulaText", None)
    return result


# The members that carry the query: DataModelSchema always, UnappliedChanges when the template has it.
MEMBERS = (
    ("DataModelSchema", edit_model, masked_model),
    ("UnappliedChanges", edit_pending, masked_pending),
)


def codec(payload, member):
    """Find how a member is serialised, so an unchanged document re-encodes byte-for-byte."""
    raw = payload.decode("utf-16-le")
    bom = "\ufeff" if raw.startswith("\ufeff") else ""
    document = json.loads(raw[len(bom):])
    newline = "\r\n" if "\r\n" in raw else "\n"
    styles = (
        {"ensure_ascii": False, "indent": 2},
        {"ensure_ascii": False},
        {"ensure_ascii": False, "separators": (",", ":")},
    )
    for style in styles:
        def encode(doc, style=style):
            return (bom + json.dumps(doc, **style).replace("\n", newline)).encode("utf-16-le")
        if encode(document) == payload:
            return document, encode
    raise ValueError(f"{member} does not round-trip; refusing to rewrite it")


def read_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or "DataModelSchema" not in names:
            raise ValueError("expected unique ZIP members including DataModelSchema")
        return infos, {info.filename: archive.read(info) for info in infos}, archive.comment


def build(original):
    infos, payloads, comment = read_archive(original)
    changed = []
    for member, edit, masked in MEMBERS:
        if member not in payloads:
            continue
        document, encode = codec(payloads[member], member)
        before = copy.deepcopy(document)
        if not edit(document):
            continue
        if masked(before) != masked(document):
            raise ValueError(f"unrelated {member} fields changed")
        payloads[member] = encode(document)
        changed.append(f"{member} {QUERY}")
    if not changed:
        return original, changed
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.comment = comment
        for info in infos:
            archive.writestr(copy.copy(info), payloads[info.filename])
    rebuilt = output.getvalue()
    after_infos, after_payloads, after_comment = read_archive(rebuilt)
    if after_comment != comment or [i.filename for i in after_infos] != [i.filename for i in infos]:
        raise ValueError("ZIP members, order or comment changed")
    owned = {member for member, _, _ in MEMBERS}
    for old, new in zip(infos, after_infos):
        if any(getattr(old, key) != getattr(new, key) for key in ZIP_METADATA):
            raise ValueError(f"ZIP metadata changed: {old.filename}")
        if old.filename not in owned and payloads[old.filename] != after_payloads[new.filename]:
            raise ValueError(f"unrelated ZIP member changed: {old.filename}")
    return rebuilt, changed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="report stale templates without writing")
    args = parser.parse_args(argv)
    stale = 0
    for relative in TEMPLATES:
        path = ROOT / relative
        original = path.read_bytes()
        rebuilt, changed = build(original)
        if not changed:
            print(f"current  {relative}")
            continue
        stale += 1
        if args.check:
            print(f"stale    {relative}: {', '.join(changed)}", file=sys.stderr)
            continue
        if path.read_bytes() != original:
            raise ValueError(f"{relative} changed during rebuild; refusing to overwrite")
        path.write_bytes(rebuilt)
        print(f"updated  {relative}: {', '.join(changed)}")
    return 1 if args.check and stale else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Org Department rename update failed: {error}", file=sys.stderr)
        sys.exit(1)
