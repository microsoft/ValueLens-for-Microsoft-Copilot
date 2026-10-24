"""Apply the shared DAX fixes to every active ValueLens and Consumption Central PBIT.

The four active ValueLens templates and the three active Consumption Central add-ons carry the
same model, so a DAX fix has to land in all of them byte-for-byte; UserMonthMetrics is only
in the two ValueLens templates that build the audit table in Power Query. This script
owns those objects: it sets each one's expression (adding the object when a template lacks it),
leaves every other model field and ZIP member untouched, and is idempotent. The archived Power
Automate + Dataverse templates are frozen, so it doesn't patch them.

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
)
CONSUMPTION = (
    Path("1. Fabric") / "Manual setup" / "Add Credit Consumption" / "Consumption Central - Fabric.pbit",
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
# ValueLens: Cowork scheduled runs (P3), the Calendar range (P7) and the
# active-user and habit-stage fast paths
# ---------------------------------------------------------------------------

USER_ID = f"{A}[Audit_UserId]"
USAGE_ROW_FILTER = f"KEEPFILTERS({A}[Is Usage Row] = TRUE())"
# [AI Tasks] counts these rows; the prompt-based counts below rely on that.
PROMPT_ROW_FILTER = f"KEEPFILTERS({A}[Is Prompt Row] = TRUE())"
LICENSED = f"{A}[License Status] = \"M365 Copilot Licensed\""
UNLICENSED = f"{A}[License Status] = \"Unlicensed\""
COWORK = f"{A}[Is_Cowork] = TRUE()"
AGENTS = f"{A}[Agent Filter (Normalized)] = \"Agents\""


def _users_with(rows_measure):
    return (
        f"COUNTROWS(FILTER(VALUES({USER_ID}),\n"
        f"        LEN(TRIM({USER_ID})) > 0 && CALCULATE({rows_measure}) > 0))"
    )


ACTIVE_USERS_FILTER = _users_with("[Usage Rows]")
PROMPT_USERS_FILTER = _users_with("[AI Tasks]")


def _active_users_in(filter_expression, users=ACTIVE_USERS_FILTER):
    return f"CALCULATE(\n    {users},\n    KEEPFILTERS({filter_expression})\n)"


def _indent(expression, prefix="    "):
    return "\n".join(prefix + line if line else line for line in expression.split("\n"))


def _guarded_active_users(per_user, *filters, rows=USAGE_ROW_FILTER, kind="usage"):
    """The per-user count as distinct counts, keeping the per-user form where it can differ.

    Counting the IDs that have `kind` rows (usage rows, or prompt rows for counts built on
    [AI Tasks]), less the blank or whitespace-only ones, gives the per-user result whenever
    Audit_UserId has no direct filter: each ID's CALCULATE then sees the same rows as the
    distinct count. A direct filter on it (user rows, a user slicer, or a selection pairing
    users with other fields) is overridden per ID by the per-user form but intersected by the
    distinct count, so those contexts still run the per-user form.
    """
    keep = (rows,) + tuple(f"KEEPFILTERS({f})" for f in filters)
    ids = f"{kind.capitalize()}Ids"

    def distinct_ids(*extra):
        arguments = ",\n".join(f"            {k}" for k in keep + extra)
        return f"        CALCULATE(\n            DISTINCTCOUNT({USER_ID}),\n{arguments}\n        )"

    return "\n".join((
        f"// Fast path: distinct counts of the IDs with {kind} rows, less any blank or",
        "// whitespace-only IDs, instead of one CALCULATE per user. When Audit_UserId",
        "// is filtered directly (user rows, a user slicer, or a selection that pairs",
        "// users with other fields) the per-user form runs, so results always match it.",
        "IF(",
        f"    ISFILTERED({USER_ID}),",
        _indent(per_user) + ",",
        "    VAR BlankIds =",
        "        FILTER(",
        f"            ALL({USER_ID}),",
        f"            LEN(TRIM({USER_ID})) = 0",
        "        )",
        f"    VAR {ids} =",
        distinct_ids(),
        f"    VAR Blank{ids} =",
        distinct_ids("KEEPFILTERS(BlankIds)"),
        f"    VAR ActiveIds = {ids} - Blank{ids}",
        "    RETURN",
        "        IF(ActiveIds > 0, ActiveIds)",
        ")",
    ))


def _cowork_fit_eligible_users():
    """Prompt users who have never used Cowork, as one distinct count unless Audit_UserId is filtered.

    _CoworkUsers ignores every filter, so leaving it and the blank or whitespace-only IDs out of
    ALL(Audit_UserId) gives a list that does not depend on the context. A distinct count of the
    prompt-row IDs in that list is then the per-user result, under the same Audit_UserId guard
    as _guarded_active_users. It returns BLANK, as the per-user form does, when no one is eligible.
    """
    per_user = "\n".join((
        "VAR _ActiveUsers =",
        f"    FILTER(VALUES({USER_ID}),",
        f"        LEN(TRIM({USER_ID})) > 0 && CALCULATE([AI Tasks]) > 0)",
        "VAR _Eligible = EXCEPT(_ActiveUsers, _CoworkUsers)",
        "RETURN COUNTROWS(_Eligible)",
    ))
    fast = "\n".join((
        "VAR Excluded =",
        "    UNION(",
        "        _CoworkUsers,",
        "        FILTER(",
        f"            ALL({USER_ID}),",
        f"            LEN(TRIM({USER_ID})) = 0",
        "        )",
        "    )",
        "RETURN",
        "    CALCULATE(",
        f"        DISTINCTCOUNT({USER_ID}),",
        f"        {PROMPT_ROW_FILTER},",
        f"        KEEPFILTERS(EXCEPT(ALL({USER_ID}), Excluded))",
        "    )",
    ))
    return "\n".join((
        "// Fast path: one distinct count of the IDs with prompt rows, leaving out the Cowork",
        "// users and any blank or whitespace-only IDs, instead of one CALCULATE per user.",
        "// When Audit_UserId is filtered directly (user rows, a user slicer, or a selection",
        "// that pairs users with other fields) the per-user form runs, so results always match it.",
        "VAR _CoworkUsers =",
        "    CALCULATETABLE(",
        f"        VALUES({USER_ID}),",
        f"        REMOVEFILTERS({A}),",
        f"        {COWORK}",
        "    )",
        "RETURN",
        "    IF(",
        f"        ISFILTERED({USER_ID}),",
        _indent(per_user, "        ") + ",",
        _indent(fast, "        "),
        "    )",
    ))


ACTIVE_DATE = f"{A}[InteractionDate]"
# Active days a user needs in the month (Last Month) or the period (Monthly) for each stage.
HABIT_STAGES = (("Beginner", 1, 5), ("Developing", 6, 10), ("Habitual", 11, 15), ("Power", 16, None))


def _habit_stage_users(low, high, last_month):
    """Users whose active days fall in a stage's band, counted in one pass unless Audit_UserId is filtered.

    The per-user form lists the users, then counts each one's active days in its own CALCULATE.
    SUMMARIZECOLUMNS counts every user's days in one pass. It returns the same users and counts
    whenever Audit_UserId has no direct filter, because each user's CALCULATE then only adds that
    user's ID to the filters. A direct filter on it (user rows, a user slicer, or a selection
    pairing users with other fields) is overridden per ID by the per-user form but intersected by
    SUMMARIZECOLUMNS, so those contexts still run the per-user form. Blank and whitespace-only IDs
    count in both forms, as before. SUMMARIZECOLUMNS in a measure needs a June 2024 or later engine.
    """
    band = f"[Days] >= {low}" if high is None else f"[Days] >= {low} && [Days] <= {high}"
    count = ("RETURN", f"    COUNTROWS(FILTER(UserDays, {band}))")
    days = f"\"Days\", DISTINCTCOUNT({ACTIVE_DATE})"
    if last_month:
        month = ("REMOVEFILTERS('Calendar'),", f"{A}[MonthStart] = MStart")
        per_user = (
            "VAR UserDays =",
            "    ADDCOLUMNS(",
            "        CALCULATETABLE(",
            f"            VALUES({USER_ID}),",
            *(f"            {line}" for line in month),
            "        ),",
            "        \"Days\",",
            "            CALCULATE(",
            f"                DISTINCTCOUNT({ACTIVE_DATE}),",
            *(f"                {line}" for line in month),
            "            )",
            "    )",
        ) + count
        fast = (
            "VAR UserDays =",
            "    CALCULATETABLE(",
            "        SUMMARIZECOLUMNS(",
            f"            {USER_ID},",
            f"            {days}",
            "        ),",
            *(f"        {line}" for line in month),
            "    )",
        ) + count
    else:
        per_user = (
            "VAR UserDays =",
            "    ADDCOLUMNS(",
            f"        VALUES({USER_ID}),",
            f"        \"Days\", CALCULATE(DISTINCTCOUNT({ACTIVE_DATE}))",
            "    )",
        ) + count
        fast = (
            "VAR UserDays =",
            "    SUMMARIZECOLUMNS(",
            f"        {USER_ID},",
            f"        {days}",
            "    )",
        ) + count
    guarded = (
        "IF(",
        f"    ISFILTERED({USER_ID}),",
        _indent("\n".join(per_user)) + ",",
        _indent("\n".join(fast)),
        ")",
    )
    comment = (
        "// Fast path: one SUMMARIZECOLUMNS counts every user's active days, instead of",
        "// one CALCULATE per user. When Audit_UserId is filtered directly (user rows, a",
        "// user slicer, or a selection that pairs users with other fields) the per-user",
        "// form runs, so results always match it. Needs the June 2024 or later engine.",
    )
    if not last_month:
        return "\n".join(comment + guarded)
    return "\n".join(comment + ("VAR MStart = [Last Full Month Start]", "RETURN", _indent("\n".join(guarded))))


CALENDAR = "\n".join((
    "",
    "// Spans every date the model can be sliced by - audit activity and product",
    "// feedback, plus Microsoft 365 activity where the Analytics Hub installer adds",
    "// that table - so an empty or late-starting audit no longer collapses the",
    "// calendar to a single day and hides the M365 and feedback trends.",
    "// MINX / MAXX skip blank sources. With no dates anywhere (first refresh, or",
    "// CreationDate failed to parse) it falls back to the last 365 days, because",
    "// CALENDAR(BLANK, BLANK) errors with \"start date can not be later than end date\".",
    "// VAR names must not be DAX function names (tests/test_dax_var_names.py).",
    f"VAR AuditMin = MIN({A}[CreationDate])",
    f"VAR AuditMax = MAX({A}[CreationDate])",
    "VAR FeedbackMin = MIN('ProductFeedback'[FeedbackDate])",
    "VAR FeedbackMax = MAX('ProductFeedback'[FeedbackDate])",
    "VAR MinDate = MINX({ AuditMin, FeedbackMin }, [Value])",
    "VAR MaxDate = MAXX({ AuditMax, FeedbackMax }, [Value])",
    "VAR RunDate = TODAY()",
    "VAR SafeMin = IF(ISBLANK(MinDate), RunDate - 364, DATE(YEAR(MinDate), MONTH(MinDate), DAY(MinDate)))",
    "VAR MaxDay = IF(ISBLANK(MaxDate), RunDate, DATE(YEAR(MaxDate), MONTH(MaxDate), DAY(MaxDate)))",
    "VAR SafeMax = IF(MaxDay < SafeMin, SafeMin, MaxDay)",
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
        "expression": f"CALCULATE(COUNTROWS({A}), {USAGE_ROW_FILTER})",
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
        "expression": _guarded_active_users(ACTIVE_USERS_FILTER),
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Active Licensed Users",
        "expression": _guarded_active_users(_active_users_in(LICENSED), LICENSED),
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Active Unlicensed Users",
        "expression": _guarded_active_users(_active_users_in(UNLICENSED), UNLICENSED),
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Active Agent Users",
        "expression": _guarded_active_users(
            _active_users_in(AGENTS, PROMPT_USERS_FILTER), AGENTS, rows=PROMPT_ROW_FILTER, kind="prompt"),
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Cowork Users",
        "expression": _guarded_active_users(_active_users_in(COWORK), COWORK),
        "set": {
            "description": "Users with Cowork activity: a prompt in Cowork, or a scheduled / autonomous Cowork run.",
        },
    },
    {
        "kind": "measure", "table": AUDIT, "name": "Cowork Fit: Eligible Users",
        "expression": _cowork_fit_eligible_users(),
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
) + tuple(
    {
        "kind": "measure", "table": AUDIT, "name": f"{stage} Users{suffix}",
        "expression": _habit_stage_users(low, high, last_month),
    }
    for last_month, suffix in ((True, ", Last Month"), (False, " (Monthly)"))
    for stage, low, high in HABIT_STAGES
)

# ---------------------------------------------------------------------------
# ValueLens: UserMonthMetrics keys. Only the templates that build the audit
# table in Power Query have UserMonthMetrics; the Fabric ones read the stage
# from the Lakehouse.
# ---------------------------------------------------------------------------

USER_MONTH_TEMPLATES = tuple(path for path in VALUELENS if path.parts[0] != "1. Fabric")
USER_MONTH_METRICS = "\n".join((
    "VAR Base =",
    "    SUMMARIZE(",
    f"\t{A},",
    f"\t{USER_ID},",
    f"\t{A}[MonthStart]",
    "    )",
    "VAR WithMetrics =",
    "    ADDCOLUMNS(",
    "\tBase,",
    "\t\"BehaviorCount\", CALCULATE(",
    f"\t    DISTINCTCOUNTNOBLANK({A}[Behavior_Enriched_Full])",
    "\t),",
    "\t\"HasAgent\", CALCULATE(",
    "\t    COUNTROWS(",
    "\t\tFILTER(",
    f"\t\t    {A},",
    f"\t\t    NOT(ISBLANK({A}[AgentName]))",
    f"\t\t\t&& {A}[AgentName] <> \"\"",
    "\t\t)",
    "\t    )",
    "\t) > 0,",
    "\t\"ActiveDays\", CALCULATE(",
    f"\t    DISTINCTCOUNTNOBLANK({A}[InteractionDate])",
    "\t),",
    "\t\"ValueFocusShare\",",
    "\t    DIVIDE(",
    "\t\tCALCULATE(",
    f"\t\t    COUNTROWS({A}),",
    f"\t\t    {A}[Usage_Mode] IN {{\"4 - Producing\",\"5 - Delegating\"}}",
    "\t\t),",
    f"\t\tCALCULATE(COUNTROWS({A})),",
    "\t\t0",
    "\t    ),",
    "\t\"UserMonthKey\",",
    f"\t    {USER_ID} & \"|\" &",
    f"\t    FORMAT({A}[MonthStart], \"yyyy-MM\")",
    "    )",
    "// Leaves out blank and whitespace-only user IDs, as the active-user counts do. The",
    "// engine stores a whitespace-only ID as \"\", so with a blank ID in the same month",
    "// both rows would get the key \"|yyyy-MM\" and the refresh would fail on the one",
    "// side of the UserMonthKey relationship. No audit row relates to either: the audit",
    "// table's own key is null for a blank ID and keeps the whitespace of the other.",
    "// Filtering Base instead, before the metrics, doubled this table's refresh time.",
    "VAR UserMonths =",
    "    FILTER(",
    "\tWithMetrics,",
    f"\tLEN(TRIM({USER_ID})) > 0",
    "    )",
    "RETURN",
    "    ADDCOLUMNS(",
    "\tUserMonths,",
    "\t\"UserStage\",",
    "\t    IF(",
    "\t\t[ActiveDays] >= 15",
    "\t\t    || ([ActiveDays] >= 10 && [ValueFocusShare] >= 0.30 && [HasAgent]),",
    "\t\t\"4 - Power\",",
    "\t    IF([ActiveDays] >= 8 && [BehaviorCount] >= 5, \"3 - Habitual\",",
    "\t    IF([ActiveDays] >= 3 && [BehaviorCount] >= 3, \"2 - Developing\",",
    "\t    \"1 - Beginner\")))",
    "    )",
))
USER_MONTH_OBJECTS = (
    {"kind": "calculatedTable", "table": "UserMonthMetrics", "expression": USER_MONTH_METRICS},
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
    {
        # Fabric installs fill Studio user and agent detail from the licensing API for
        # months no PPAC export covers, so the note no longer says "export" only.
        "kind": "measure", "table": "Settings", "name": "Studio Snapshot Note",
        "expression": "\n".join((
            "VAR AgentRows = COUNTROWS('Credit Consumption (Agent)')",
            "VAR UserRows = COUNTROWS('Credit Consumption (User)')",
            "RETURN \"Date controls affect tenant totals only. User and agent detail is a month-to-date "
            "snapshot, from a PPAC export or, where your install collects it, the Power Platform "
            "licensing API. Costs are rate estimates, not an allocation of the selected-period PAYG bill. \"",
            "& IF(AgentRows = 0, \"No matching agent-detail rows: model/feature breakdown is unavailable. \", \"\")",
            "& IF(UserRows = 0, \"No matching user-detail rows: upload a PPAC user export, or turn on the "
            "Copilot Studio credits flow if your install has one. \", \"\")",
        )),
    },
)

TARGETS = tuple(
    (path, VALUELENS_OBJECTS + (USER_MONTH_OBJECTS if path in USER_MONTH_TEMPLATES else ()))
    for path in VALUELENS) + tuple((path, CONSUMPTION_OBJECTS) for path in CONSUMPTION)


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
