"""Apply the shared DAX fixes to every shipped ValueLens and Consumption Central PBIT.

The five ValueLens templates and the four Consumption Central add-ons carry the same
model, so a DAX fix has to land in all of them byte-for-byte. This script owns those
objects: it sets each one's expression (adding the object when a template lacks it),
leaves every other model field and ZIP member untouched, and is idempotent.

    python scripts/Update-Template-Dax.py           # patch the templates in place
    python scripts/Update-Template-Dax.py --check   # exit 1 if any template is stale

Desktop refresh and rendering still need live QA after a change here.
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
VALUELENS = (
    Path("1. Fabric") / "Manual setup" / "ValueLens - Fabric.pbit",
    Path("1. Fabric") / "Manual setup" / "ValueLens - Fabric OneLake.pbit",
    Path("5. Local CSV") / "ValueLens - Local CSV.pbit",
    Path("4. SharePoint") / "ValueLens - SharePoint.pbit",
    Path("3. Power Automate + Dataverse") / "ValueLens - Power Automate + Dataverse.pbit",
)
CONSUMPTION = (
    Path("1. Fabric") / "Manual setup" / "Add Credit Consumption" / "Consumption Central - Fabric.pbit",
    Path("3. Power Automate + Dataverse") / "Add Credit Consumption"
    / "Consumption Central - Power Automate + Dataverse.pbit",
    Path("4. SharePoint") / "Add Credit Consumption" / "Consumption Central - Viva Direct.pbit",
    Path("5. Local CSV") / "Add Credit Consumption" / "Consumption Central - Local CSV.pbit",
)
ZIP_METADATA = (
    "filename", "orig_filename", "date_time", "compress_type", "comment", "extra",
    "create_system", "create_version", "extract_version", "reserved", "flag_bits",
    "volume", "internal_attr", "external_attr",
)
AUDIT = "Chat + Agent Interactions (Audit Logs)"
A = f"'{AUDIT}'"

# ---------------------------------------------------------------------------
# ValueLens: Cowork scheduled runs (P3) and the Calendar range (P7)
# ---------------------------------------------------------------------------

ACTIVE_USERS_FILTER = (
    f"COUNTROWS(FILTER(VALUES({A}[Audit_UserId]),\n"
    f"        LEN(TRIM({A}[Audit_UserId])) > 0 && CALCULATE([Usage Rows]) > 0))"
)


def _active_users_in(filter_expression):
    return f"CALCULATE(\n    {ACTIVE_USERS_FILTER},\n    KEEPFILTERS({filter_expression})\n)"


CALENDAR = "\n".join((
    "",
    "// Spans every date the model can be sliced by - audit activity and product",
    "// feedback, plus Microsoft 365 activity where the Analytics Hub installer adds",
    "// that table - so an empty or late-starting audit no longer collapses the",
    "// calendar to a single day and hides the M365 and feedback trends.",
    "// MINX / MAXX skip blank sources. With no dates anywhere (first refresh, or",
    "// CreationDate failed to parse) it falls back to the last 365 days, because",
    "// CALENDAR(BLANK, BLANK) errors with \"start date can not be later than end date\".",
    f"VAR AuditMin = MIN({A}[CreationDate])",
    f"VAR AuditMax = MAX({A}[CreationDate])",
    "VAR FeedbackMin = MIN('ProductFeedback'[FeedbackDate])",
    "VAR FeedbackMax = MAX('ProductFeedback'[FeedbackDate])",
    "VAR MinDate = MINX({ AuditMin, FeedbackMin }, [Value])",
    "VAR MaxDate = MAXX({ AuditMax, FeedbackMax }, [Value])",
    "VAR RunDate = TODAY()",
    "VAR SafeMin = IF(ISBLANK(MinDate), RunDate - 364, DATE(YEAR(MinDate), MONTH(MinDate), DAY(MinDate)))",
    "VAR LastDate = IF(ISBLANK(MaxDate), RunDate, DATE(YEAR(MaxDate), MONTH(MaxDate), DAY(MaxDate)))",
    "VAR SafeMax = IF(LastDate < SafeMin, SafeMin, LastDate)",
    "RETURN",
    "ADDCOLUMNS(",
    "    CALENDAR(SafeMin, SafeMax),",
    "    \"Year\", YEAR([Date]),",
    "    \"Year-Month\", FORMAT([Date], \"YYYY-MM\"),",
    "    \"Month Name\", FORMAT([Date], \"MMMM\"),",
    "    \"Month Number\", MONTH([Date]),",
    "    \"Quarter\", \"Q\" & QUARTER([Date]),",
    "    \"Quarter Number\", QUARTER([Date]),",
    "    \"Week Number\", WEEKNUM([Date], 2),",
    "    \"Week Start\", [Date] - WEEKDAY([Date], 2) + 1,",
    "    \"Day Name\", FORMAT([Date], \"dddd\"),",
    "    \"Day Number\", DAY([Date]),",
    "    \"Is Weekend\", WEEKDAY([Date], 1) IN {1, 7}",
    ")",
))

VALUELENS_OBJECTS = (
    {
        "kind": "column", "table": AUDIT, "name": "Is Usage Row",
        "expression": f"{A}[Is Prompt Row] || {A}[Is_Cowork]",
        "new": {
            "dataType": "boolean", "isHidden": True, "summarizeBy": "none",
            "description": [
                "TRUE for rows that show a person used Copilot: every prompt row, plus",
                "Cowork task rows. Scheduled and autonomous Cowork runs carry no prompt,",
                "so the audit parsers keep each one as a single task row",
                "(Message_isPrompt = FALSE). Drives the active-user counts only; prompt,",
                "task and session measures stay prompt-based.",
            ],
        },
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Usage Rows",
        "expression": f"CALCULATE(COUNTROWS({A}), KEEPFILTERS({A}[Is Usage Row] = TRUE()))",
        "new": {
            "formatString": "#,##0", "isHidden": True, "displayFolder": "AI Fluency\\Overall - Value",
            "description": [
                "Prompt rows plus Cowork scheduled-run task rows. The basis for the",
                "active-user counts, so someone whose only Copilot use was a scheduled",
                "Cowork run still counts as active. Not a prompt count: use AI Tasks.",
            ],
        },
    },
    {
        "kind": "measure", "table": AUDIT, "name": "All Active Users",
        "expression": ACTIVE_USERS_FILTER,
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Active Licensed Users",
        "expression": _active_users_in(f"{A}[License Status] = \"M365 Copilot Licensed\""),
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Active Unlicensed Users",
        "expression": _active_users_in(f"{A}[License Status] = \"Unlicensed\""),
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Cowork Users",
        "expression": _active_users_in(f"{A}[Is_Cowork] = TRUE()"),
        "set": {
            "description": "Users with Cowork activity: a prompt in Cowork, or a scheduled / autonomous Cowork run.",
        },
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Cowork Scheduled Runs",
        "expression": "\n".join((
            "CALCULATE(",
            f"    COUNTROWS({A}),",
            f"    KEEPFILTERS({A}[Is_Cowork] = TRUE()),",
            f"    KEEPFILTERS({A}[Is Prompt Row] = FALSE())",
            ")",
        )),
        "new": {
            "formatString": "#,##0", "displayFolder": "AI Fluency\\Cowork - Value",
            "description": [
                "Scheduled or autonomous Cowork runs: Cowork audit records with no user",
                "prompt, kept as one task row each. Not counted in AI Tasks or AI Prompts.",
            ],
        },
    },
    {"kind": "calculatedTable", "table": "Calendar", "expression": CALENDAR},
)

# ---------------------------------------------------------------------------
# Consumption Central: a blank or zero Cowork limit means "no limit set" (P9)
# ---------------------------------------------------------------------------

CB = "'CoworkBilling'"
NO_LIMIT = "A blank or zero limit means no limit is set, so this returns BLANK."
CONSUMPTION_OBJECTS = (
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Person Allowance",
        "expression": f"VAR Limit = SUM({CB}[MonthlyCreditLimit])\nRETURN IF(Limit > 0, Limit)",
    },
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Person Headroom",
        "expression": "VAR Allowance = [Person Allowance]\n"
                      "RETURN IF(NOT ISBLANK(Allowance), Allowance - [Cowork Total Credits Used])",
        "set": {"description": [
            "Credits still available before people hit their own monthly limits.",
            "Governance headroom, not money already spent. " + NO_LIMIT,
        ]},
    },
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Over Limit Credits",
        "expression": "VAR Allowance = [Person Allowance]\n"
                      "RETURN IF(NOT ISBLANK(Allowance), MAX(0, [Cowork Total Credits Used] - Allowance), 0)",
    },
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Over Limit Credits (Individual)",
        "expression": "\n".join((
            "SUMX(",
            f"    {CB},",
            f"    VAR Limit = {CB}[MonthlyCreditLimit]",
            f"    RETURN IF(Limit > 0, MAX(0, {CB}[MonthlyCreditsUsed] - Limit), 0)",
            ")",
        )),
    },
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Users Over Limit",
        "expression": f"VAR T = SUMMARIZE({CB}, {CB}[UserPrincipalName], \"u\", [Cowork Total Credits Used], "
                      "\"l\", [Person Allowance])\nRETURN COUNTROWS(FILTER(T, [l] > 0 && [u] > [l])) + 0",
    },
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Users Near Limit",
        "expression": f"VAR T = SUMMARIZE({CB}, {CB}[UserPrincipalName], \"u\", [Cowork Total Credits Used], "
                      "\"l\", [Person Allowance])\n"
                      "RETURN COUNTROWS(FILTER(T, [l] > 0 && [u] >= 0.85 * [l] && [u] <= [l])) + 0",
    },
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Policy Allowance",
        "expression": "\n".join((
            "VAR Limit =",
            "    CALCULATE(",
            "        SUM('SpendingPolicy'[PlanLimit]),",
            "        'SpendingPolicy'[SpendingPolicyId] <> \"00000000-0000-0000-0000-000000000000\"",
            "    )",
            "RETURN IF(Limit > 0, Limit)",
        )),
    },
    {
        "kind": "measure", "table": "CoworkBilling", "name": "Policy Headroom",
        "expression": "VAR Allowance = [Policy Allowance]\n"
                      "RETURN IF(NOT ISBLANK(Allowance), Allowance - [Cowork Total Credits Used])",
        "set": {"description": [
            "Credits still available before consumption exceeds the spending policy",
            "limits. Shown as \"Credits left\". " + NO_LIMIT,
        ]},
    },
)

TARGETS = tuple((path, VALUELENS_OBJECTS) for path in VALUELENS) + tuple(
    (path, CONSUMPTION_OBJECTS) for path in CONSUMPTION)


def model_text(expression):
    """PBIT JSON keeps single-line DAX as a string and multi-line DAX as a line array."""
    lines = expression.split("\n")
    return lines if len(lines) > 1 else expression


def lineage_tag(spec):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"valuelens:dax:{spec['table']}:{spec['kind']}:{spec['name']}"))


def find_table(model, name):
    matches = [t for t in model["tables"] if t["name"] == name]
    if len(matches) != 1:
        raise ValueError(f"expected one table {name!r}, found {len(matches)}")
    return matches[0]


def locate(model, spec):
    """Return (container list, index or None, record holding the expression, field)."""
    table = find_table(model, spec["table"])
    if spec["kind"] == "calculatedTable":
        partitions = table.get("partitions", [])
        if len(partitions) != 1 or partitions[0]["source"].get("type") != "calculated":
            raise ValueError(f"{spec['table']} is not a single-partition calculated table")
        return None, None, partitions[0]["source"], "expression"
    key = "columns" if spec["kind"] == "column" else "measures"
    items = table.setdefault(key, [])
    hits = [i for i, item in enumerate(items) if item["name"] == spec["name"]]
    if len(hits) > 1:
        raise ValueError(f"duplicate {spec['kind']} {spec['table']}[{spec['name']}]")
    if spec["kind"] == "column" and hits and items[hits[0]].get("type") != "calculated":
        raise ValueError(f"{spec['table']}[{spec['name']}] exists but is not a calculated column")
    return items, (hits[0] if hits else None), (items[hits[0]] if hits else None), "expression"


def apply(model, spec):
    items, index, record, field = locate(model, spec)
    wanted = model_text(spec["expression"])
    if record is None:
        record = {"name": spec["name"]}
        if spec["kind"] == "column":
            record["type"] = "calculated"
        record[field] = wanted
        for key, value in spec.get("new", {}).items():
            record[key] = model_text("\n".join(value)) if key == "description" and isinstance(value, list) else value
        record["lineageTag"] = lineage_tag(spec)
        items.append(record)
        return True
    changed = False
    if record.get(field) != wanted:
        record[field] = wanted
        changed = True
    for key, value in spec.get("set", {}).items():
        value = model_text("\n".join(value)) if isinstance(value, list) else value
        if record.get(key) != value:
            record[key] = value
            changed = True
    return changed


def masked(model, specs):
    """The model with every owned object removed, for the unrelated-fields check."""
    result = copy.deepcopy(model)
    for spec in specs:
        table = find_table(result, spec["table"])
        if spec["kind"] == "calculatedTable":
            table["partitions"][0]["source"]["expression"] = "<owned>"
            continue
        key = "columns" if spec["kind"] == "column" else "measures"
        table[key] = [item for item in table.get(key, []) if item["name"] != spec["name"]]
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


def build(original, specs):
    infos, payloads, comment = read_archive(original)
    raw = payloads["DataModelSchema"].decode("utf-16-le")
    newline = "\r\n" if "\r\n" in raw else "\n"
    document = json.loads(raw)
    if dump(document, newline) != payloads["DataModelSchema"]:
        raise ValueError("DataModelSchema does not round-trip; refusing to rewrite it")
    before = copy.deepcopy(document["model"])
    changed = [f"{s['table']}[{s.get('name', '')}]" for s in specs if apply(document["model"], s)]
    if not changed:
        return original, changed
    if masked(before, specs) != masked(document["model"], specs):
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
    for relative, specs in TARGETS:
        path = ROOT / relative
        original = path.read_bytes()
        rebuilt, changed = build(original, specs)
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
        print(f"Template DAX update failed: {error}", file=sys.stderr)
        sys.exit(1)
