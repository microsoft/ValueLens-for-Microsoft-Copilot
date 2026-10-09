"""Add the agent sign-in check to the two Fabric ValueLens PBITs.

'Agents 365'[Sign-in Required] says whether an agent asks its users to sign in: Yes, No or
Unknown. The Agents 365 query reads it from an ordered list of sources and keeps the first
answer: Defender advanced hunting's agent inventory (defender_ai_agents) today. A source
that is missing or empty is skipped, so the column is Unknown when none is connected.
Governance Flags then adds "No sign-in required".

The script owns those three things only: the Sign-in Required step in the Agents 365
query, the Sign-in Required column and the Governance Flags expression. Every other model
field and ZIP member is left as it is, and it is idempotent.

    python scripts/Update-Defender-Template.py           # patch the templates in place
    python scripts/Update-Defender-Template.py --check   # exit 1 if a template is stale

Desktop refresh still needs live QA after a change here.
"""
import argparse
import copy
import io
import json
from pathlib import Path
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = (
    Path("1. Fabric") / "Manual setup" / "ValueLens - Fabric.pbit",
    Path("1. Fabric") / "Manual setup" / "ValueLens - Fabric OneLake.pbit",
)
ZIP_METADATA = (
    "filename", "orig_filename", "date_time", "compress_type", "comment", "extra",
    "create_system", "create_version", "extract_version", "reserved", "flag_bits",
    "volume", "internal_attr", "external_attr",
)
TABLE = "Agents 365"
COLUMN = "Sign-in Required"
FLAGS = "Governance Flags"

ANCHOR = (
    "    // Lean pass: drop source columns nothing in the model reads.\n"
    "    __lean = Table.RemoveColumns(__withScope, "
)
STEP = "\n".join((
    "    // Sign-in Required: whether the agent asks its users to sign in (Yes, No or",
    "    // Unknown). Each source is a lookup from a lowercase agent ID (Entra agent ID,",
    "    // bot ID or app ID) to Yes or No, and the first source that knows the agent",
    "    // wins, so put more authoritative sources first. A source that is missing or",
    "    // empty is skipped. Defender advanced hunting's agent inventory is the only",
    "    // source today.",
    "    __signInLookup = (t as nullable table) as record =>",
    "        if t = null then [] else",
    "        let",
    "            cols = Table.ColumnNames(t),",
    "            last = if List.Contains(cols, \"SnapshotDate\") then List.Max(Table.Column(t, \"SnapshotDate\")) else null,",
    "            latest = if last = null then t else Table.SelectRows(t, each Record.Field(_, \"SnapshotDate\") = last),",
    "            known = List.Select(Table.ToRecords(latest),",
    "                (r) => List.Contains({\"Yes\", \"No\"}, Record.FieldOrDefault(r, \"SignInRequired\", null))),",
    "            pairs = List.Combine(List.Transform(known, (r) =>",
    "                List.Transform(",
    "                    List.Select(",
    "                        List.Transform({\"EntraAgentId\", \"BotId\", \"AppId\", \"AgentId\"},",
    "                            (k) => Text.Lower(Text.Trim(Text.From(Record.FieldOrDefault(r, k, null) ?? \"\")))),",
    "                        (k) => k <> \"\"),",
    "                    (k) => {k, r[SignInRequired]}))),",
    "            unique = List.Distinct(pairs, each _{0})",
    "        in",
    "            Record.FromList(List.Transform(unique, each _{1}), List.Transform(unique, each _{0})),",
    "    __signInSources = {",
    "        __signInLookup(try FabricTable(\"defender_ai_agents\") otherwise null)",
    "    },",
    "    __withSignIn = Table.AddColumn(__withScope, \"Sign-in Required\", each",
    "        let",
    "            keys = List.Select(",
    "                List.Transform({[Entra Agent ID], [Bot Id], [App Id]}, (v) => Text.Lower(Text.Trim(Text.From(v ?? \"\")))),",
    "                (k) => k <> \"\"),",
    "            answers = List.RemoveNulls(List.Transform(__signInSources, (src) =>",
    "                List.First(List.RemoveNulls(List.Transform(keys, (k) => Record.FieldOrDefault(src, k, null))), null)))",
    "        in",
    "            List.First(answers, \"Unknown\"), type text),",
    "    // Lean pass: drop source columns nothing in the model reads.",
    "    __lean = Table.RemoveColumns(__withSignIn, ",
))

NEW_COLUMN = {
    "name": COLUMN,
    "dataType": "string",
    "sourceColumn": COLUMN,
    "description": "Whether the agent asks its users to sign in: Yes, No or Unknown. From Defender advanced "
                   "hunting's agent inventory when the Defender source is on; Unknown when no source knows "
                   "the agent.",
    "lineageTag": str(uuid.uuid5(uuid.NAMESPACE_URL, f"valuelens:defender:{TABLE}:column:{COLUMN}")),
    "summarizeBy": "none",
    "annotations": [{"name": "SummarizationSetBy", "value": "Automatic"}],
}

FLAGS_EXPRESSION = "\n".join((
    "VAR _Tenant  = NOT(LOWER(TRIM(COALESCE('Agents 365'[Created in], \"\"))) IN {\"\", \"not available\"})",
    "VAR _Blocked = LOWER(TRIM(COALESCE('Agents 365'[Is Blocked], \"\"))) IN {\"true\", \"yes\", \"1\"}",
    "VAR _Owner   = LOWER(TRIM(COALESCE('Agents 365'[Owner account], \"\")))",
    "VAR _Source  = LOWER(TRIM(COALESCE('Agents 365'[Agent creator source], \"\")))",
    "VAR _Scope   = 'Agents 365'[Sharing Scope]",
    "VAR _Unused  = COALESCE('Agents 365'[Total Users], 0) = 0",
    "VAR _List =",
    "    IF('Agents 365'[Sign-in Required] = \"No\", \"; No sign-in required\")",
    "    & IF(_Owner IN {\"disabled\", \"not found\"}, \"; Owner has left\")",
    "    & IF(_Source = \"unattributed\", \"; No owner on record\")",
    "    & IF(_Scope = \"Whole organisation\" && 'Agents 365'[Data Access] = \"Organisation content\", "
    "\"; Org-wide with org data\")",
    "    & IF(_Scope IN {\"Whole organisation\", \"Specific people or groups\"} && _Unused, "
    "\"; Shared, no recorded use\")",
    "RETURN IF(_Tenant && NOT _Blocked && _List <> \"\", MID(_List, 3, 500))",
))
FLAGS_DESCRIPTION = (
    "Why a tenant-built, unblocked agent needs review, separated by '; ': No sign-in required, Owner has "
    "left, No owner on record, Org-wide with org data, Shared, no recorded use. Blank when none apply."
)


def model_text(text):
    """PBIT JSON keeps single-line text as a string and multi-line text as a line array."""
    lines = text.split("\n")
    return lines if len(lines) > 1 else text


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def find(items, name, what):
    hits = [item for item in items if item["name"] == name]
    if len(hits) != 1:
        raise ValueError(f"expected one {what} {name!r}, found {len(hits)}")
    return hits[0]


def apply(model):
    """Patch the model in place; return what changed."""
    table = find(model["tables"], TABLE, "table")
    changed = []

    partitions = table.get("partitions", [])
    if len(partitions) != 1 or partitions[0]["source"].get("type") != "m":
        raise ValueError(f"{TABLE} is not a single-partition M table")
    source = partitions[0]["source"]
    query = joined(source["expression"])
    if STEP not in query:
        if query.count(ANCHOR) != 1 or "__withSignIn" in query:
            raise ValueError(f"{TABLE}: the lean-pass anchor was not found exactly once")
        source["expression"] = model_text(query.replace(ANCHOR, STEP))
        changed.append(f"{TABLE} query")

    columns = table["columns"]
    flags = find(columns, FLAGS, "column")
    existing = [c for c in columns if c["name"] == COLUMN]
    if not existing:
        columns.insert(columns.index(flags), copy.deepcopy(NEW_COLUMN))
        changed.append(f"{TABLE}[{COLUMN}]")
    elif existing[0] != NEW_COLUMN:
        columns[columns.index(existing[0])] = copy.deepcopy(NEW_COLUMN)
        changed.append(f"{TABLE}[{COLUMN}]")

    if flags.get("type") != "calculated":
        raise ValueError(f"{TABLE}[{FLAGS}] is not a calculated column")
    if joined(flags.get("expression")) != FLAGS_EXPRESSION or flags.get("description") != FLAGS_DESCRIPTION:
        flags["expression"] = model_text(FLAGS_EXPRESSION)
        flags["description"] = FLAGS_DESCRIPTION
        changed.append(f"{TABLE}[{FLAGS}]")
    return changed


def masked(model):
    """The model with the owned objects blanked, for the unrelated-fields check."""
    result = copy.deepcopy(model)
    table = find(result["tables"], TABLE, "table")
    table["partitions"][0]["source"]["expression"] = "<owned>"
    table["columns"] = [c for c in table["columns"] if c["name"] != COLUMN]
    flags = find(table["columns"], FLAGS, "column")
    flags["expression"] = flags["description"] = "<owned>"
    return result


def read_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or "DataModelSchema" not in names:
            raise ValueError("expected unique ZIP members including DataModelSchema")
        return infos, {info.filename: archive.read(info) for info in infos}, archive.comment


def dump(document, newline):
    return json.dumps(document, ensure_ascii=False, indent=2).replace("\n", newline).encode("utf-16-le")


def build(original):
    infos, payloads, comment = read_archive(original)
    raw = payloads["DataModelSchema"].decode("utf-16-le")
    newline = "\r\n" if "\r\n" in raw else "\n"
    document = json.loads(raw)
    if dump(document, newline) != payloads["DataModelSchema"]:
        raise ValueError("DataModelSchema does not round-trip; refusing to rewrite it")
    before = copy.deepcopy(document["model"])
    changed = apply(document["model"])
    if not changed:
        return original, changed
    if masked(before) != masked(document["model"]):
        raise ValueError("unrelated model fields changed")
    payloads["DataModelSchema"] = dump(document, newline)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.comment = comment
        for info in infos:
            archive.writestr(copy.copy(info), payloads[info.filename])
    rebuilt = output.getvalue()
    after_infos, after_payloads, after_comment = read_archive(rebuilt)
    if after_comment != comment or [i.filename for i in after_infos] != [i.filename for i in infos]:
        raise ValueError("ZIP members, order or comment changed")
    for old, new in zip(infos, after_infos):
        if any(getattr(old, key) != getattr(new, key) for key in ZIP_METADATA):
            raise ValueError(f"ZIP metadata changed: {old.filename}")
        if old.filename != "DataModelSchema" and payloads[old.filename] != after_payloads[new.filename]:
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
        print(f"Defender template update failed: {error}", file=sys.stderr)
        sys.exit(1)
