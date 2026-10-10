"""Keep every ValueLens web data source schedulable in the Power BI service.

The service only schedules refresh when it can resolve every Web.Contents base URL without
running the query. The base URL must be a parameter (or literal) with a value. A computed URL
(Text.Trim, if/else, concatenation) or a blank parameter, even in an unused branch, makes the
source dynamic and blocks scheduled refresh with "Data source for Query1".

This script owns the M that reads web sources in the SharePoint and Power Automate + Dataverse
templates, and the matching optional-file read in the Local CSV template:

* Optional SharePoint files (Feedback File, Agent 365) and the PA CSV fallback are read through
  a SharePoint Site URL parameter and the SharePoint REST API (ValueLensSharePointFile), so a
  blank file parameter no longer blocks scheduled refresh.
* The Dataverse reader passes the Dataverse URL parameter as the base URL, with the API path
  in RelativePath.
* ProductFeedback passes the Feedback File parameter straight through, guarded for blank.

It leaves every other model field and ZIP member untouched, and is idempotent.

    python scripts/Update-Template-Refresh-Sources.py           # patch the templates in place
    python scripts/Update-Template-Refresh-Sources.py --check   # exit 1 if any template is stale
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
SHAREPOINT = Path("4. SharePoint") / "ValueLens - SharePoint.pbit"
POWER_AUTOMATE = Path("3. Power Automate + Dataverse") / "ValueLens - Power Automate + Dataverse.pbit"
LOCAL_CSV = Path("5. Local CSV") / "ValueLens - Local CSV.pbit"
ZIP_METADATA = (
    "filename", "orig_filename", "date_time", "compress_type", "comment", "extra",
    "create_system", "create_version", "extract_version", "reserved", "flag_bits",
    "volume", "internal_attr", "external_attr",
)
SITE_PARAMETER = "SharePoint Site URL"
SITE_FUNCTION = "ValueLensSharePointFile"
QUERY_ORDER = "PBI_QueryOrder"

SITE_FUNCTION_M = "\n".join((
    "(fileUrl as text) as binary =>",
    "let",
    "    // Reads a CSV on SharePoint through the SharePoint Site URL parameter and the SharePoint REST API.",
    "    // The Power BI service schedules refresh only when every Web.Contents base URL is a parameter",
    "    // with a value, so the file URL (which may be blank) goes in RelativePath, never in the base URL.",
    "    Site = #\"SharePoint Site URL\",",
    "    SiteParts = Uri.Parts(Site),",
    "    FileParts = Uri.Parts(Text.Trim(fileUrl)),",
    "    SitePath = Text.TrimEnd(SiteParts[Path], \"/\"),",
    "    FilePath = FileParts[Path],",
    "    Inside = Text.Lower(SiteParts[Host]) = Text.Lower(FileParts[Host])",
    "        and Text.StartsWith(Text.Lower(FilePath), Text.Lower(SitePath) & \"/\"),",
    "    Segments = Text.Split(Text.Range(FilePath, Text.Length(SitePath) + 1), \"/\"),",
    "    // A tenant-root site URL reaches a file in /sites/<name>, /teams/<name> or /personal/<name> through that site.",
    "    WebPath =",
    "        if SitePath = \"\" and List.Count(Segments) > 2",
    "            and List.Contains({\"sites\", \"teams\", \"personal\"}, Text.Lower(Segments{0}))",
    "        then Segments{0} & \"/\" & Segments{1} & \"/\"",
    "        else \"\",",
    "    RelativePath =",
    "        if Site = null or Text.Trim(Site) = \"\" then",
    "            error Error.Record(\"MissingSharePointSiteUrl\", \"Set SharePoint Site URL to the SharePoint site that holds the CSV files.\", null)",
    "        else if Site <> Text.Trim(Site) or SiteParts[Scheme] <> \"https\" or FileParts[Scheme] <> \"https\" or not Inside then",
    "            error Error.Record(\"FileOutsideSharePointSite\", \"The file must be an https URL in the SharePoint Site URL site.\", [File = fileUrl, Site = Site])",
    "        else",
    "            WebPath & \"_api/web/GetFileByServerRelativeUrl('\" & Text.Replace(FilePath, \"'\", \"''\") & \"')/$value\"",
    "in",
    "    Web.Contents(Site, [RelativePath = RelativePath])",
))


def parameter(required):
    flag = "true" if required else "false"
    return f'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired={flag}]'


def new_expression(name, expression, description, result_type, after):
    return {"kind": "add", "name": name, "expression": expression, "description": description,
            "result_type": result_type, "after": after}


def replace(name, old, new):
    return {"kind": "replace", "name": name, "old": old, "new": new}


SITE_FUNCTION_SPEC = new_expression(
    SITE_FUNCTION, SITE_FUNCTION_M,
    "Helper: reads a CSV in the SharePoint Site URL site through the SharePoint REST API, so scheduled refresh "
    "works in the Power BI service when an optional file parameter is blank.",
    "Function", "Feedback File")

READ_CSV = "Csv.Document(Web.Contents(FilePath),"
READ_SITE_CSV = f"Csv.Document({SITE_FUNCTION}(FilePath),"
AGENTS_365 = replace("Agents 365 Staging", READ_CSV, READ_SITE_CSV)
FEEDBACK_FILE_PATH = replace(
    "ProductFeedback",
    'FilePath = if #"Feedback File" = null then "" else Text.Trim(#"Feedback File"),',
    'FilePath = #"Feedback File",')


def feedback_read(reader):
    return replace(
        "ProductFeedback",
        f"Imported = if FilePath = \"\" then EmptyTable(Expected) else Table.PromoteHeaders(Csv.Document({reader}(FilePath),",
        f"Imported = if FilePath = null or Text.Trim(FilePath) = \"\" then EmptyTable(Expected) else "
        f"Table.PromoteHeaders(Csv.Document({SITE_FUNCTION if reader == 'Web.Contents' else reader}(FilePath),")


SHAREPOINT_EDITS = (
    new_expression(
        SITE_PARAMETER, parameter(True),
        "SharePoint site that holds the ValueLens CSVs, e.g. https://contoso.sharepoint.com/sites/ValueLens. "
        "The optional Agent 365 and Feedback File CSVs must be in this site. Required for scheduled refresh "
        "in the Power BI service, even when those files are blank.",
        "Text", "Org Data File"),
    SITE_FUNCTION_SPEC,
    AGENTS_365,
    FEEDBACK_FILE_PATH,
    feedback_read("Web.Contents"),
)

DATAVERSE = "ValueLensDataverseEntity"
POWER_AUTOMATE_EDITS = (
    new_expression(
        SITE_PARAMETER, parameter(False),
        "SharePoint site that holds the SharePoint CSVs (CSV fallback, Agent 365, Feedback File), e.g. "
        "https://contoso.sharepoint.com/sites/ValueLens. For scheduled refresh in the Power BI service, set "
        "both this and Dataverse URL; if you use only one source, set both to the same URL.",
        "Text", "Dataverse URL"),
    SITE_FUNCTION_SPEC,
    AGENTS_365,
    FEEDBACK_FILE_PATH,
    feedback_read("Web.Contents"),
    replace("Chat + Agent Interactions (Audit Logs)", READ_CSV, READ_SITE_CSV),
    replace("Copilot Licensed", READ_CSV, READ_SITE_CSV),
    replace("Chat + Agent Org Data", READ_CSV, READ_SITE_CSV),
    replace(
        DATAVERSE,
        '        if Parts[Scheme] <> "https" or Parts[Host] = ""\n',
        '        if Parts[Scheme] <> "https" or Parts[Host] = ""\n'
        '            or (Text.From(DataverseUrl) <> BaseUrl and Text.From(DataverseUrl) <> BaseUrl & "/")\n'),
    replace(
        DATAVERSE,
        '"Use the HTTPS environment origin only, without credentials, path or query."',
        '"Use the HTTPS environment origin only, without spaces, credentials, path or query."'),
    replace(
        DATAVERSE,
        "        Json.Document(Web.Contents(ApiRoot, [RelativePath = relativePath, Query = query, Headers = Headers])),",
        "        // The base URL is the Dataverse URL parameter itself: the Power BI service cannot schedule refresh of a computed URL.\n"
        "        Json.Document(Web.Contents(#\"Dataverse URL\", [RelativePath = ApiPath & relativePath, Query = query, Headers = Headers])),"),
    {"kind": "description", "name": "Dataverse URL", "description": [
        "Dataverse environment URL for the Power Automate + Dataverse core pathway.",
        "For scheduled refresh in the Power BI service, set it even with Use SharePoint CSV fallback (use the SharePoint Site URL).",
    ]},
)

LOCAL_CSV_EDITS = (
    FEEDBACK_FILE_PATH,
    feedback_read("File.Contents"),
)

TARGETS = (
    (SHAREPOINT, SHAREPOINT_EDITS),
    (POWER_AUTOMATE, POWER_AUTOMATE_EDITS),
    (LOCAL_CSV, LOCAL_CSV_EDITS),
)


def text(value):
    return "\n".join(value) if isinstance(value, list) else value


def model_text(value, like=None):
    """PBIT JSON keeps single-line M as a string and multi-line M as a line array."""
    if isinstance(like, str):
        return value
    lines = value.split("\n")
    return lines if len(lines) > 1 else value


def lineage_tag(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"valuelens:m:{name}"))


def sources(model, name):
    """Every (record, field) holding the M for a named expression or table partition."""
    hits = [(e, "expression") for e in model.get("expressions", []) if e["name"] == name]
    for table in model["tables"]:
        if table["name"] == name:
            hits += [(p["source"], "expression") for p in table.get("partitions", [])
                     if p["source"].get("type") == "m"]
    if len(hits) != 1:
        raise ValueError(f"expected one M source named {name!r}, found {len(hits)}")
    return hits[0]


def query_order(model):
    hits = [a for a in model.get("annotations", []) if a["name"] == QUERY_ORDER]
    if len(hits) != 1:
        raise ValueError(f"expected one {QUERY_ORDER} annotation")
    return hits[0]


def apply(model, edit):
    if edit["kind"] == "replace":
        record, field = sources(model, edit["name"])
        current = text(record[field])
        # The new M can contain the old M, so look for the new M first.
        if current.count(edit["new"]) == 1:
            return False
        old_count = current.count(edit["old"])
        if old_count != 1:
            raise ValueError(f"{edit['name']}: expected the old M once, found it {old_count} times")
        record[field] = model_text(current.replace(edit["old"], edit["new"]), record[field])
        return True
    if edit["kind"] == "description":
        record, _ = sources(model, edit["name"])
        if record.get("description") == edit["description"]:
            return False
        record["description"] = edit["description"]
        return True
    expressions = model.setdefault("expressions", [])
    hits = [e for e in expressions if e["name"] == edit["name"]]
    wanted = model_text(edit["expression"])
    changed = False
    if not hits:
        names = [e["name"] for e in expressions]
        record = {
            "name": edit["name"],
            "description": edit["description"],
            "kind": "m",
            "expression": wanted,
            "lineageTag": lineage_tag(edit["name"]),
            "annotations": [{"name": "PBI_ResultType", "value": edit["result_type"]}],
        }
        expressions.insert(names.index(edit["after"]) + 1, record)
        changed = True
    else:
        record = hits[0]
        for key, value in (("expression", wanted), ("description", edit["description"])):
            if record.get(key) != value:
                record[key] = value
                changed = True
    annotation = query_order(model)
    order = json.loads(annotation["value"])
    if edit["name"] not in order:
        order.insert(order.index(edit["after"]) + 1, edit["name"])
        annotation["value"] = json.dumps(order, ensure_ascii=False, separators=(",", ":"))
        changed = True
    return changed


def masked(model, edits):
    """The model with every owned M source removed, for the unrelated-fields check."""
    result = copy.deepcopy(model)
    added = {e["name"] for e in edits if e["kind"] == "add"}
    result["expressions"] = [e for e in result.get("expressions", []) if e["name"] not in added]
    for edit in edits:
        if edit["kind"] == "replace":
            record, field = sources(result, edit["name"])
            record[field] = "<owned>"
        elif edit["kind"] == "description":
            sources(result, edit["name"])[0]["description"] = "<owned>"
    annotation = query_order(result)
    annotation["value"] = json.dumps([n for n in json.loads(annotation["value"]) if n not in added])
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


def build(original, edits):
    infos, payloads, comment = read_archive(original)
    raw = payloads["DataModelSchema"].decode("utf-16-le")
    newline = "\r\n" if "\r\n" in raw else "\n"
    document = json.loads(raw)
    if dump(document, newline) != payloads["DataModelSchema"]:
        raise ValueError("DataModelSchema does not round-trip; refusing to rewrite it")
    before = copy.deepcopy(document["model"])
    changed = [f"{e['kind']} {e['name']}" for e in edits if apply(document["model"], e)]
    if not changed:
        return original, changed
    if masked(before, edits) != masked(document["model"], edits):
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
    for relative, edits in TARGETS:
        path = ROOT / relative
        original = path.read_bytes()
        rebuilt, changed = build(original, edits)
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
        print(f"Template refresh-source update failed: {error}", file=sys.stderr)
        sys.exit(1)
