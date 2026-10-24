"""Apply the model refresh fixes to the Agent Evaluator and Consumption Central PBITs.

Consumption Central (Fabric):
  * The partitions that read a Lakehouse table column by column buffer it first. Unbuffered, the
    SQL endpoint is queried once per column, which on a large tenant exhausts the connection pool.

Consumption Central (all three active variants: Fabric, Viva Direct, Local CSV; the archived
Power Automate + Dataverse variant is frozen and not patched):
  * Refresh-time DAX that ranked every user against every other user is rewritten to give the
    same results. The Group By table finds each percentile cut once with TOPN instead of RANKX
    over every user for every user, and CreditsWeekly[Weeks Ago] drops a per-row CALCULATE.
    CoworkBilling[UsageCohortRank] moves from a calculated column that ranked the whole table
    per row into CoworkBilling's query, which sorts the credits once, reads the five cut values
    and compares each row to them (COHORT_RANK_QUERY). CoworkBilling[UsageCohort] reads its
    bucket from UsageCohortRank instead of ranking again. Weeks Active and Weeks Over Limit are
    unchanged.

Agent Evaluator:
  * 'Agent Turns'[Response Seconds] scans its own conversation with FILTER(ALL(...)) instead of
    CALCULATE(..., ALLEXCEPT(...)), which ran out of memory on large transcript tables.
  * Imported columns nothing reads are no longer loaded (UNUSED_IMPORTED_COLUMNS): error_message,
    content_preview, the bot message and variable copies in Agent Performance. Agent Errors and
    Agent Performance drop them with Table.RemoveColumns(..., MissingField.Ignore), so a source
    without them still loads; Conversation Transcripts (Raw) no longer builds content_preview.
  * In Fabric mode the credit tables read credit_consumption_<name> when it has rows, else the
    Consumption Central add-on's studio_* tables (FabricCreditTable). Nothing in Fabric writes
    credit_consumption_*, so the Credit Consumption page used to stay empty.
  * Agent Name Map reads the credit-side names the same way, instead of an empty table in Fabric.
  * Agent Name Map is the one side of two relationships, so both of its key columns must be
    unique as the engine compares text (case-insensitive, trailing spaces ignored). Unmatched
    names used to share a blank agent_schema, which failed the refresh (AgentNameMapRows).

Each change lands in DataModelSchema and in the UnappliedChanges copy of the queries. Every
other model field and ZIP member is left untouched, and the script is idempotent.

    python scripts/Update-Model-Refresh-Fixes.py           # patch the templates in place
    python scripts/Update-Model-Refresh-Fixes.py --check   # exit 1 if any template is stale

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
AGENT_EVALUATOR = Path("1. Fabric") / "Manual setup" / "Add Agent Evaluator" / "Agent Evaluator.pbit"
CONSUMPTION = Path("1. Fabric") / "Manual setup" / "Add Credit Consumption" / "Consumption Central - Fabric.pbit"
# The other Consumption Central variants share the Fabric model's DAX and CoworkBilling's query
# ending, but not its Lakehouse queries.
CONSUMPTION_VARIANTS = (
    Path("4. SharePoint") / "Add Credit Consumption" / "Consumption Central - Viva Direct.pbit",
    Path("5. Local CSV") / "Add Credit Consumption" / "Consumption Central - Local CSV.pbit",
)
MEMBERS = ("DataModelSchema", "UnappliedChanges")
ZIP_METADATA = (
    "filename", "orig_filename", "date_time", "compress_type", "comment", "extra",
    "create_system", "create_version", "extract_version", "reserved", "flag_bits",
    "volume", "internal_attr", "external_attr",
)

# ---------------------------------------------------------------------------
# Consumption Central: buffer the tables Normalize reads column by column
# ---------------------------------------------------------------------------

BUFFERED_TABLES = {
    "Credit Consumption (Tenant)": "studio_tenant_daily",
    "Credit Consumption (Agent)": "studio_agent",
    "Credit Consumption (User)": "studio_user",
    "AzureAiSpend": "azure_ai_spend",
    "AzureSolutionSpend": "azure_solution_spend",
    "AzureDeploymentHealth": "azure_deployment_health",
    "AzureBillingReconciliation": "azure_billing_reconciliation",
}


def buffered_raw(lakehouse_table):
    return (
        f'    Raw = GetTable("{lakehouse_table}"),',
        f'    Raw = let r = GetTable("{lakehouse_table}") in if r = null then null else Table.Buffer(r),',
    )


CONSUMPTION_QUERIES = {name: (buffered_raw(table),) for name, table in BUFFERED_TABLES.items()}

# ---------------------------------------------------------------------------
# Consumption Central: calculated columns and tables that ranked every user per user
# ---------------------------------------------------------------------------

COHORT_CUTS = (
    ("50", "0.50"),
    ("75", "0.75"),
    ("90", "0.90"),
    ("95", "0.95"),
    ("99", "0.99"),
)


def cohort_rank(results):
    rank = (
        "VAR Rk = RANKX(ALL('CoworkBilling'), 'CoworkBilling'[MonthlyCreditsUsed],, ASC)",
    )
    exact = (
        "// RANKX(ALL('CoworkBilling'), ..., ASC) re-ranked the whole table for every row. An",
        "// ascending rank that skips ties is 1 + the number of rows with a smaller value.",
        "VAR v = 'CoworkBilling'[MonthlyCreditsUsed]",
        "VAR Rk = 1 + COUNTROWS(FILTER(ALL('CoworkBilling'), 'CoworkBilling'[MonthlyCreditsUsed] < v))",
    )
    rest = (
        "VAR Tot = COUNTROWS(ALL('CoworkBilling'))",
        "VAR P = DIVIDE(Rk, Tot)",
        "RETURN SWITCH(TRUE(),",
    ) + tuple(f"    P <= {cut}, {result}," for (_, cut), result in zip(COHORT_CUTS, results)) + (
        f"    {results[-1]})",
    )
    return "\n".join(rank + rest), "\n".join(exact + rest)


COHORT_LABELS = ('"1. Light"', '"2. Regular"', '"3. Engaged"', '"4. Native"', '"5. Power"', '"6. Frontier"')
# The calculated forms UsageCohortRank may still have: the original RANKX, and the per-row count
# an earlier version of this script wrote. Both become the imported column below.
USAGE_COHORT_RANK_OLD, USAGE_COHORT_RANK_COUNT = cohort_rank(("1", "2", "3", "4", "5", "6"))
USAGE_COHORT_OLD, _ = cohort_rank(COHORT_LABELS)

COWORK_BILLING = "CoworkBilling"
USAGE_COHORT_RANK = "UsageCohortRank"
COHORT_QUERY_END = "\n".join((
    '\tAddedRecency = Table.AddColumn(AddedDays, "RecencyBucket", each if [DaysSinceActivity] <= 7 then "0-7 days" '
    'else if [DaysSinceActivity] <= 30 then "8-30 days" else if [DaysSinceActivity] <= 60 then "31-60 days" '
    'else "60+ days", type text)',
    "in",
    "\tAddedRecency",
))
COHORT_QUERY_STEPS = "\n".join((
    COHORT_QUERY_END.split("\n")[0] + ",",
    "\t// UsageCohortRank: the cohort (1-6) of each user's ascending credit rank, ties skipped, as a",
    "\t// share of all users, cut at 50/75/90/95/99%. That rank is at most m exactly when the credits",
    "\t// are at most the m-th smallest value, so each cut is read once from the sorted credits",
    "\t// instead of ranking every user against every other user. m is the largest whole number",
    "\t// with m / N <= k, and a blank counts as 0, as it did in RANKX.",
    "\tLoaded = Table.Buffer(AddedRecency),",
    "\tSortedUsed = List.Sort(List.Transform(Loaded[MonthlyCreditsUsed], each if _ = null then 0 else _)),",
    "\tUserCount = List.Count(SortedUsed),",
    "\tCutValue = (k as number) =>",
    "\t\tlet",
    "\t\t\tNear = Number.RoundDown(k * UserCount),",
    "\t\t\tRank = List.Max(List.Select({Near - 2 .. Near + 2}, each _ >= 1 and _ <= UserCount and _ / UserCount <= k))",
    "\t\tin",
    "\t\t\tif Rank = null then null else SortedUsed{Rank - 1},",
    "\tCohortCuts = List.Buffer(List.Transform({"
    + ", ".join(cut for _, cut in COHORT_CUTS) + "}, CutValue)),",
    "\tAddedCohortRank = Table.AddColumn(Loaded, \"UsageCohortRank\", (row) =>",
    "\t\tlet",
    "\t\t\tUsed = if row[MonthlyCreditsUsed] = null then 0 else row[MonthlyCreditsUsed],",
    "\t\t\tCohort = List.PositionOf(List.Transform(CohortCuts, each _ <> null and Used <= _), true)",
    "\t\tin",
    "\t\t\tif Cohort < 0 then 6 else Cohort + 1, Int64.Type)",
    "in",
    "\tAddedCohortRank",
))
COHORT_RANK_QUERY = (COHORT_QUERY_END, COHORT_QUERY_STEPS)
# Every variant's CoworkBilling query ends with the same AddedRecency step.
COHORT_QUERIES = {COWORK_BILLING: (COHORT_RANK_QUERY,)}
CONSUMPTION_QUERIES.update(COHORT_QUERIES)

# Same percentile as UsageCohortRank, so read the bucket from it instead of ranking again.
USAGE_COHORT = "\n".join(
    ("SWITCH('CoworkBilling'[UsageCohortRank],",)
    + tuple(f"    {rank}, {label}," for rank, label in enumerate(COHORT_LABELS[:-1], start=1))
    + (f"    {COHORT_LABELS[-1]})",)
)
WEEKS_AGO_OLD = "\n".join((
    "",
    "VAR MaxWk = CALCULATE( MAX('CreditsWeekly'[MetricDate]), ALL('CreditsWeekly') )",
    "RETURN DATEDIFF( 'CreditsWeekly'[MetricDate], MaxWk, DAY ) / 7",
    "",
))
# A calculated column has no filter context, so MAX already sees every row; the CALCULATE
# only added a context transition over the whole row for each of the table's rows.
WEEKS_AGO = "\n".join((
    "",
    "VAR MaxWk = MAX('CreditsWeekly'[MetricDate])",
    "RETURN DATEDIFF( 'CreditsWeekly'[MetricDate], MaxWk, DAY ) / 7",
    "",
))
CONSUMPTION_COLUMNS = {
    ("CoworkBilling", "UsageCohort"): (USAGE_COHORT_OLD, USAGE_COHORT),
    ("CreditsWeekly", "Weeks Ago"): (WEEKS_AGO_OLD, WEEKS_AGO),
}

GROUP_BY = "Group By"
INTENSITY_LABELS = (
    '"1. Light (Bottom 50%)"',
    '"2. Regular (Top 25\u201350%)"',
    '"3. Engaged (Top 10\u201325%)"',
    '"4. Native (Top 5\u201310%)"',
    '"5. Power (Top 1\u20135%)"',
    '"6. Frontier (Top 1%)"',
)


def intensity_rows(product):
    """Replace RANKX inside ADDCOLUMNS over the same table, which re-ranks every user per user."""
    by_user = f"{product}ByUser"
    tail = (
        f'        "Attribute", "Usage Intensity ({product})",',
        '        "Group", SWITCH( TRUE(),',
        '            [@Used] <= 0, "0. Not used",',
    )
    old = (
        f"VAR {product}Rows =",
        "    SELECTCOLUMNS(",
        "        ADDCOLUMNS(",
        f"            {by_user},",
        '            "@P", DIVIDE(',
        f"                RANKX( {by_user}, [@Used], , ASC ),",
        f"                COUNTROWS( {by_user} )",
        "            )",
        "        ),",
    ) + tail + tuple(
        f"            [@P] <= {cut}, {label}," for (_, cut), label in zip(COHORT_CUTS, INTENSITY_LABELS)
    )
    new = (
        "// A user's ascending rank (ties skipped) is at most m exactly when their credits are",
        "// at most the m-th smallest value. So for each cut k, find once the largest m with",
        "// DIVIDE( m, N ) <= k and the m-th smallest value with TOPN, then compare each user",
        "// to it. Same buckets as DIVIDE( RANKX( ... ), N ) <= k, without ranking per user.",
        f"VAR {product}N = COUNTROWS( {by_user} )",
        f"VAR {product}Steps = GENERATESERIES( 1, MAX( {product}N, 1 ) )",
    ) + tuple(
        f"VAR {product}M{name} = MAXX( FILTER( {product}Steps, DIVIDE( [Value], {product}N ) <= {cut} ), [Value] ) + 0"
        for name, cut in COHORT_CUTS
    ) + (
        "// No m fits only when N = 1; the blank cut then fails every user past the <= 0 branch.",
    ) + tuple(
        f"VAR {product}T{name} = IF( {product}M{name} >= 1, "
        f"MAXX( TOPN( {product}M{name}, {by_user}, [@Used], ASC ), [@Used] ) )"
        for name, _ in COHORT_CUTS
    ) + (
        f"VAR {product}Rows =",
        "    SELECTCOLUMNS(",
        f"        {by_user},",
    ) + tail + tuple(
        f"            [@Used] <= {product}T{name}, {label}," for (name, _), label in zip(COHORT_CUTS, INTENSITY_LABELS)
    )
    return "\n".join(old), "\n".join(new)


GROUP_BY_EDITS = (intensity_rows("Studio"), intensity_rows("GitHub"))

# ---------------------------------------------------------------------------
# Agent Evaluator
# ---------------------------------------------------------------------------

TURNS = "Agent Turns"
RESPONSE_SECONDS_OLD = "\n".join((
    "VAR conv = 'Agent Turns'[conversation_id]",
    "VAR ts = 'Agent Turns'[turn_timestamp_utc]",
    "VAR prevUser =",
    "    CALCULATE (",
    "        MAX ( 'Agent Turns'[turn_timestamp_utc] ),",
    "        ALLEXCEPT ( 'Agent Turns', 'Agent Turns'[conversation_id] ),",
    "        'Agent Turns'[turn_role] = \"user\",",
    "        'Agent Turns'[turn_timestamp_utc] < ts",
    "    )",
    "RETURN",
    "    IF (",
    "        'Agent Turns'[turn_role] = \"bot\" && NOT ISBLANK ( prevUser ),",
    "        DATEDIFF ( prevUser, ts, SECOND )",
    "    )",
))
# Scan only the three columns the lookup needs, not the whole table per row.
RESPONSE_SECONDS = "\n".join((
    "VAR conv = 'Agent Turns'[conversation_id]",
    "VAR ts = 'Agent Turns'[turn_timestamp_utc]",
    "VAR prevUser =",
    "    MAXX (",
    "        FILTER (",
    "            ALL ( 'Agent Turns'[conversation_id], 'Agent Turns'[turn_role], 'Agent Turns'[turn_timestamp_utc] ),",
    "            'Agent Turns'[conversation_id] = conv",
    "                && 'Agent Turns'[turn_role] = \"user\"",
    "                && 'Agent Turns'[turn_timestamp_utc] < ts",
    "        ),",
    "        'Agent Turns'[turn_timestamp_utc]",
    "    )",
    "RETURN",
    "    IF (",
    "        'Agent Turns'[turn_role] = \"bot\" && NOT ISBLANK ( prevUser ),",
    "        DATEDIFF ( prevUser, ts, SECOND )",
    "    )",
))

FABRIC_CREDIT_TABLE = "\n".join((
    "(name as text, columns as list) as table =>",
    "    let",
    "        // credit_consumption_<name> holds a Power Platform admin centre export as exported.",
    "        // Without one, read the table the Consumption Central add-on's Ingest_Studio notebook",
    "        // loads from the same exports.",
    "        Direct = try FabricTable(\"credit_consumption_\" & name) otherwise null,",
    "        UseDirect = Direct <> null and not Table.IsEmpty(Direct),",
    "        StudioName =",
    "            if name = \"agent\" then \"studio_agent\"",
    "            else if name = \"user\" then \"studio_user\"",
    "            else if name = \"tenant\" then \"studio_tenant_daily\"",
    "            else error \"FabricCreditTable: unknown credit table \" & name,",
    "        Renames = {",
    "            {\"agent_name\", \"Agent_Name\"}, {\"agent_id\", \"Agent_Id\"}, {\"product\", \"Product\"},",
    "            {\"billable_feature\", \"AI_Feature_Billable_Feature\"}, {\"billed_credit\", \"Billed_credit\"},",
    "            {\"non_billed_credit\", \"Non_billed_credit\"}, {\"channel\", \"Channel\"},",
    "            {\"knowledge_sources\", \"Knowledge_Sources\"}, {\"tool_used\", \"Tool_Used\"},",
    "            {\"llm_model\", \"LLM_Model\"}, {\"scenario_name\", \"Scenario_Name\"},",
    "            {\"environment_id\", \"Environment_Id\"}, {\"environment_name\", \"Environment_Name\"},",
    "            {\"user_id\", \"User_Id\"}, {\"user_email\", \"User_Email\"},",
    "            {\"billable_credit_used\", \"Billable_credit_used\"}, {\"credits_used\", \"Credits_used\"},",
    "            {\"m365_copilot_licensed\", \"M365_Copilot_Licensed\"},",
    "            {\"billing_plan_id\", \"BillingPlan_Id\"}, {\"billing_plan_name\", \"BillingPlan_Name\"},",
    "            {\"capacity_type\", \"Capacity_Type\"}, {\"entitled_quantity\", \"Entitled_Quantity\"},",
    "            {\"prepaid_consumed\", \"Prepaid_Consumed_Quantity\"},",
    "            {\"payg_consumed\", \"Pay_as_you_go_Consumed_Quantity\"}, {\"usage_date\", \"Usage_Date\"}",
    "        },",
    "        Studio = FabricTable(StudioName),",
    "        // studio_agent and studio_user keep a snapshot per export month. Read the latest only, as",
    "        // Consumption Central does, so credits aren't counted once per snapshot.",
    "        Months =",
    "            if Table.HasColumns(Studio, \"snapshot_month\") then",
    "                List.RemoveNulls(Table.Column(Table.Distinct(Table.SelectColumns(Studio, {\"snapshot_month\"})), \"snapshot_month\"))",
    "            else {},",
    "        LastMonth = List.Max(Months),",
    "        Latest = if List.IsEmpty(Months) then Studio else Table.SelectRows(Studio, each [snapshot_month] = LastMonth),",
    "        Picked = Table.SelectColumns(Table.RenameColumns(Latest, Renames, MissingField.Ignore), columns, MissingField.UseNull),",
    "        // The export spells the licence flag TRUE / FALSE; the ingester stores a logical.",
    "        FromStudio =",
    "            if List.Contains(columns, \"M365_Copilot_Licensed\") then",
    "                Table.TransformColumns(Picked, {{\"M365_Copilot_Licensed\", each",
    "                    if _ = null then null",
    "                    else if Value.Is(_, type logical) then (if _ then \"TRUE\" else \"FALSE\")",
    "                    else Text.From(_), type nullable text}})",
    "            else Picked",
    "    in",
    "        if UseDirect then Table.SelectColumns(Direct, columns, MissingField.UseNull) else FromStudio",
))
FABRIC_CREDIT_TABLE_DESCRIPTION = "\n".join((
    "Helper: a credit table in Fabric mode. Reads credit_consumption_<name> when it has rows, else the",
    "Consumption Central add-on's studio_* table (latest snapshot), renamed to the export's columns.",
))

AGENT_NAME_MAP_ROWS = "\n".join((
    "(rows as list) as list =>",
    "    let",
    "        // The engine compares text case-insensitively and ignores trailing spaces, so key on that.",
    "        Key = (value) => if value = null then \"\" else Text.Lower(Text.TrimEnd(Text.From(value))),",
    "        // Overrides claim their schema before automatic matches do.",
    "        Ordered = List.Select(rows, (r) => r[match_type] = \"Override\")",
    "            & List.Select(rows, (r) => r[match_type] <> \"Override\"),",
    "        NameKeys = List.Buffer(List.Transform(Ordered, (r) => Key(r[credit_agent_name]))),",
    "        Named = List.Transform(",
    "            List.Select(List.Positions(Ordered), (i) => List.PositionOf(NameKeys, NameKeys{i}) = i),",
    "            (i) => Ordered{i}),",
    "        SchemaKeys = List.Buffer(List.Transform(Named, (r) => Key(r[agent_schema]))),",
    "        // A blank or already claimed schema gets a placeholder that can't match a transcript.",
    "        Result = List.Transform(List.Positions(Named), (i) =>",
    "            let r = Named{i}, k = SchemaKeys{i} in",
    "            if k <> \"\" and List.PositionOf(SchemaKeys, k) = i then r",
    "            else [",
    "                credit_agent_name = r[credit_agent_name],",
    "                agent_schema = \"(unmatched) \" & (if r[credit_agent_name] = null then \"\" else Text.From(r[credit_agent_name])),",
    "                match_type = \"Unmatched\",",
    "                match_key = r[match_key]])",
    "    in",
    "        Result",
))
AGENT_NAME_MAP_ROWS_DESCRIPTION = "\n".join((
    "Helper: make Agent Name Map's two key columns unique. Keeps the first row per credit name, and",
    "gives a blank or already claimed agent_schema an \"(unmatched) <name>\" placeholder.",
))

NEW_FUNCTIONS = (
    ("FabricCreditTable", FABRIC_CREDIT_TABLE, FABRIC_CREDIT_TABLE_DESCRIPTION),
    ("AgentNameMapRows", AGENT_NAME_MAP_ROWS, AGENT_NAME_MAP_ROWS_DESCRIPTION),
)


def credit_source(name):
    comment = (
        f"        // Outside Fabric, read <CSV Folder Path>\\credit_consumption_{name}.csv when present.\n"
        "        // Missing file -> the original empty shape, so the file stays optional.\n"
    )
    return (
        comment
        + f'        if #"Source Mode" = "Fabric" then (try FabricTable("credit_consumption_{name}") otherwise EmptyTable(Cols))',
        f"        // In Fabric, read credit_consumption_{name}, else the Consumption Central add-on's tables.\n"
        + comment
        + f'        if #"Source Mode" = "Fabric" then (try FabricCreditTable("{name}", Cols) otherwise EmptyTable(Cols))',
    )


AGENT_PERFORMANCE_UNREAD = (
    "FirstBotMessage",
    "LastBotMessage",
    "Var_ESS_Message_Disclaimer",
    "Var_ESS_UserContext_RefreshInterval_Hours",
    "Var_ESS_UserContext_Conversation_Initialized",
    "AllVariables",
)

AGENT_EVALUATOR_QUERIES = {
    "Credit Consumption (Agent)": (credit_source("agent"),),
    "Credit Consumption (User)": (credit_source("user"),),
    "Credit Consumption (Tenant)": (credit_source("tenant"),),
    "Agent Name Map": (
        (
            '\t\tif #"Source Mode" = "Fabric" then EmptyTable(CreditCols)',
            '\t\tif #"Source Mode" = "Fabric" then (try FabricCreditTable("agent", CreditCols) otherwise EmptyTable(CreditCols))',
        ),
        (
            "\tT = Table.FromRecords(Rows, type table [",
            "\t// Both key columns are relationship keys, so each must be unique.\n"
            "\tT = Table.FromRecords(AgentNameMapRows(Rows), type table [",
        ),
    ),
    "Agent Errors": (
        (
            '    Typed = Table.TransformColumnTypes(Promoted, {\n'
            '        {"conversation_id", type text},\n'
            '        {"error_timestamp_utc", type datetime},\n'
            '        {"error_code", type text},\n'
            '        {"error_sub_code", type text},\n'
            '        {"error_message", type text},\n',
            "    // Nothing in the report reads error_message, so it isn't loaded.\n"
            '    Kept = Table.RemoveColumns(Promoted, {"error_message"}, MissingField.Ignore),\n'
            '    Typed = Table.TransformColumnTypes(Kept, {\n'
            '        {"conversation_id", type text},\n'
            '        {"error_timestamp_utc", type datetime},\n'
            '        {"error_code", type text},\n'
            '        {"error_sub_code", type text},\n',
        ),
    ),
    "Agent Performance": (
        (
            "    ChangedTypes = Table.TransformColumnTypes(\n        PromotedHeaders,\n",
            "    // Nothing in the report reads these, so they aren't loaded. Var_ESS_UserContext_UPN stays:\n"
            "    // [Unique Users] counts it.\n"
            "    Trimmed = Table.RemoveColumns(PromotedHeaders, {"
            + ", ".join(f'"{c}"' for c in AGENT_PERFORMANCE_UNREAD)
            + "}, MissingField.Ignore),\n"
            "    ChangedTypes = Table.TransformColumnTypes(\n        Trimmed,\n",
        ),
    ),
    "Conversation Transcripts (Raw)": (
        (
            '"content_length", "content_preview"}, {}),',
            '"content_length"}, {}),',
        ),
        (
            '                WithPrev = Table.AddColumn(WithLen, "content_preview", each if [content] = null then null'
            ' else Text.Start(Text.From([content]), 500), type text),\n'
            "                Ren = Table.RenameColumns(WithPrev, ",
            "                Ren = Table.RenameColumns(WithLen, ",
        ),
        (
            '"content_length", "content_preview"}, MissingField.UseNull)',
            '"content_length"}, MissingField.UseNull)',
        ),
        (
            '{"name", type text}, {"content_preview", type text}})',
            '{"name", type text}})',
        ),
    ),
}

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def lines(text):
    """PBIT JSON keeps single-line text as a string and multi-line text as a line array."""
    parts = text.split("\n")
    return parts if len(parts) > 1 else text


def lineage_tag(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"analyticshub:agent-evaluator:expression:{name}"))


def replace_snippets(label, text, edits):
    for old, new in edits:
        if new in text:
            continue
        if text.count(old) != 1:
            raise ValueError(f"{label}: expected the original text once, found it {text.count(old)} times")
        text = text.replace(old, new)
    return text


def one(records, name, label):
    hits = [r for r in records if r.get("name") == name]
    if len(hits) != 1:
        raise ValueError(f"{label}: expected one {name!r}, found {len(hits)}")
    return hits[0]


def partition_source(model, table_name):
    table = one(model["tables"], table_name, "DataModelSchema tables")
    partitions = table.get("partitions", [])
    if len(partitions) != 1 or partitions[0]["source"].get("type") != "m":
        raise ValueError(f"{table_name} is not a single-partition M table")
    return partitions[0]["source"]


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


# ---------------------------------------------------------------------------
# Member edits: each returns the labels it changed
# ---------------------------------------------------------------------------


def edit_queries_model(document, queries):
    changed = []
    for name, edits in queries.items():
        source = partition_source(document["model"], name)
        old = joined(source["expression"])
        new = replace_snippets(name, old, edits)
        if new != old:
            source["expression"] = lines(new)
            changed.append(name)
    return changed


def edit_queries_pending(document, queries):
    changed = []
    for name, edits in queries.items():
        query = one(document["queries"], name, "UnappliedChanges queries")
        old = joined(query["text"])
        new = replace_snippets(name, old, edits)
        if new != old:
            query["text"] = new.split("\n")
            set_last_loaded(query, old, new)
            changed.append(name)
    return changed


def edit_functions_model(document):
    changed = []
    expressions = document["model"]["expressions"]
    for name, text, description in NEW_FUNCTIONS:
        hits = [e for e in expressions if e["name"] == name]
        record = {
            "name": name,
            "description": lines(description),
            "kind": "m",
            "expression": lines(text),
            "lineageTag": lineage_tag(name),
            "annotations": [{"name": "PBI_ResultType", "value": "Function"}],
        }
        if not hits:
            expressions.append(record)
            changed.append(name)
        elif hits[0] != record:
            hits[0].clear()
            hits[0].update(record)
            changed.append(name)
    return changed


def edit_functions_pending(document):
    changed = []
    queries = document["queries"]
    for name, text, description in NEW_FUNCTIONS:
        hits = [q for q in queries if q["name"] == name]
        record = {
            "name": name,
            "lineageTag": lineage_tag(name),
            "description": description,
            "text": text.split("\n"),
            "loadAsTableDisabled": True,
            "resultType": "Function",
            "isHidden": False,
        }
        if not hits:
            queries.append(record)
            changed.append(name)
        elif hits[0] != record:
            hits[0].clear()
            hits[0].update(record)
            changed.append(name)
    return changed


def edit_response_seconds(document):
    table = one(document["model"]["tables"], TURNS, "DataModelSchema tables")
    column = one(table.get("columns", []), "Response Seconds", TURNS)
    if column.get("type") != "calculated":
        raise ValueError(f"{TURNS}[Response Seconds] is not a calculated column")
    current = joined(column["expression"])
    if current == RESPONSE_SECONDS:
        return []
    if current != RESPONSE_SECONDS_OLD:
        raise ValueError(f"{TURNS}[Response Seconds] has changed; review it before patching")
    column["expression"] = lines(RESPONSE_SECONDS)
    return [f"{TURNS}[Response Seconds]"]


def calculated_partition_source(model, table_name):
    table = one(model["tables"], table_name, "DataModelSchema tables")
    partitions = table.get("partitions", [])
    if len(partitions) != 1 or partitions[0]["source"].get("type") != "calculated":
        raise ValueError(f"{table_name} is not a single-partition calculated table")
    return partitions[0]["source"]


def imported_cohort_rank(column):
    """UsageCohortRank as a column CoworkBilling's query loads, keeping its name, tag and format."""
    record = {}
    for key, value in column.items():
        if key in ("type", "expression", "isDataTypeInferred"):
            continue
        if key == "lineageTag":
            record["sourceColumn"] = USAGE_COHORT_RANK
        record[key] = value
    record.setdefault("sourceColumn", USAGE_COHORT_RANK)
    return record


def edit_cohort_rank_column(model):
    table = one(model["tables"], COWORK_BILLING, "DataModelSchema tables")
    columns = table.get("columns", [])
    column = one(columns, USAGE_COHORT_RANK, COWORK_BILLING)
    if column.get("type", "data") == "data":
        if column.get("sourceColumn") != USAGE_COHORT_RANK or "expression" in column:
            raise ValueError(f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] has changed; review it before patching")
        return []
    if column.get("type") != "calculated" or joined(column["expression"]) not in (
            USAGE_COHORT_RANK_OLD, USAGE_COHORT_RANK_COUNT):
        raise ValueError(f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] has changed; review it before patching")
    if column.get("dataType") != "int64":
        raise ValueError(f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] is not a whole number")
    columns[columns.index(column)] = imported_cohort_rank(column)
    return [f"{COWORK_BILLING}[{USAGE_COHORT_RANK}] loaded by the query"]


def edit_consumption_dax(document):
    changed = []
    model = document["model"]
    changed += edit_cohort_rank_column(model)
    for (table_name, column_name), (old, new) in CONSUMPTION_COLUMNS.items():
        table = one(model["tables"], table_name, "DataModelSchema tables")
        column = one(table.get("columns", []), column_name, table_name)
        if column.get("type") != "calculated":
            raise ValueError(f"{table_name}[{column_name}] is not a calculated column")
        current = joined(column["expression"])
        if current == new:
            continue
        if current != old:
            raise ValueError(f"{table_name}[{column_name}] has changed; review it before patching")
        column["expression"] = lines(new)
        changed.append(f"{table_name}[{column_name}]")
    source = calculated_partition_source(model, GROUP_BY)
    old = joined(source["expression"])
    new = replace_snippets(GROUP_BY, old, GROUP_BY_EDITS)
    if new != old:
        source["expression"] = lines(new)
        changed.append(GROUP_BY)
    return changed


def model_references(model, table_name, column_name):
    """Where the model still uses a column: DAX text, sort-by, hierarchies, relationships."""
    ref = f"[{column_name}]".lower()
    uses = []
    for table in model["tables"]:
        for kind in ("columns", "measures"):
            for item in table.get(kind, []):
                if (table["name"], item["name"]) == (table_name, column_name):
                    continue
                if ref in joined(item.get("expression", "")).lower():
                    uses.append(f"{table['name']}[{item['name']}]")
                if kind == "columns" and table["name"] == table_name and item.get("sortByColumn") == column_name:
                    uses.append(f"{table['name']}[{item['name']}] sort-by")
        for partition in table.get("partitions", []):
            if partition["source"].get("type") == "calculated" and ref in joined(
                    partition["source"].get("expression", "")).lower():
                uses.append(table["name"])
        for hierarchy in table.get("hierarchies", []):
            if table["name"] == table_name and any(level["column"] == column_name for level in hierarchy["levels"]):
                uses.append(f"{table['name']} hierarchy {hierarchy['name']}")
    for rel in model.get("relationships", []):
        if (rel["fromTable"], rel["fromColumn"]) == (table_name, column_name) or (
                rel["toTable"], rel["toColumn"]) == (table_name, column_name):
            uses.append(f"relationship {rel['name']}")
    return uses


def edit_unused_columns(document):
    changed = []
    model = document["model"]
    for table_name, column_name in UNUSED_IMPORTED_COLUMNS:
        table = one(model["tables"], table_name, "DataModelSchema tables")
        hits = [c for c in table.get("columns", []) if c["name"] == column_name]
        if not hits:
            continue
        if hits[0].get("type", "data") != "data" or hits[0].get("sourceColumn") != column_name:
            raise ValueError(f"{table_name}[{column_name}] is not an imported column")
        uses = model_references(model, table_name, column_name)
        if uses:
            raise ValueError(f"{table_name}[{column_name}] is still used by {', '.join(uses)}")
        table["columns"] = [c for c in table["columns"] if c["name"] != column_name]
        changed.append(f"drop {table_name}[{column_name}]")
    return changed


# Imported columns nothing reads; AGENT_EVALUATOR_QUERIES stops loading them.
UNUSED_IMPORTED_COLUMNS = (
    ("Agent Errors", "error_message"),
    *(("Agent Performance", name) for name in AGENT_PERFORMANCE_UNREAD),
    ("Conversation Transcripts (Raw)", "content_preview"),
)


def owned_mask_model(document, queries, functions, dax):
    result = copy.deepcopy(document)
    model = result["model"]
    for name in queries:
        partition_source(model, name)["expression"] = "<owned>"
    if functions:
        names = {name for name, _, _ in NEW_FUNCTIONS}
        model["expressions"] = [e for e in model["expressions"] if e["name"] not in names]
    if dax == "agent-evaluator":
        one(one(model["tables"], TURNS, "tables")["columns"], "Response Seconds", TURNS)["expression"] = "<owned>"
        for table_name, column_name in UNUSED_IMPORTED_COLUMNS:
            table = one(model["tables"], table_name, "tables")
            table["columns"] = [c for c in table["columns"] if c["name"] != column_name]
    if dax == "consumption":
        cowork = one(model["tables"], COWORK_BILLING, "tables")
        cowork["columns"] = [c if c["name"] != USAGE_COHORT_RANK else {"name": c["name"], "owned": True}
                             for c in cowork["columns"]]
        for table_name, column_name in CONSUMPTION_COLUMNS:
            one(one(model["tables"], table_name, "tables")["columns"], column_name, table_name)["expression"] = "<owned>"
        calculated_partition_source(model, GROUP_BY)["expression"] = "<owned>"
    return result


def owned_mask_pending(document, queries, functions):
    result = copy.deepcopy(document)
    for query in result["queries"]:
        if query["name"] in queries:
            query["text"] = "<owned>"
            query.pop("lastLoadedAsTableFormulaText", None)
    if functions:
        names = {name for name, _, _ in NEW_FUNCTIONS}
        result["queries"] = [q for q in result["queries"] if q["name"] not in names]
    return result


# (template, M query edits, add the Agent Evaluator functions, which model DAX edits apply)
TARGETS = (
    (AGENT_EVALUATOR, AGENT_EVALUATOR_QUERIES, True, "agent-evaluator"),
    (CONSUMPTION, CONSUMPTION_QUERIES, False, "consumption"),
) + tuple((path, COHORT_QUERIES, False, "consumption") for path in CONSUMPTION_VARIANTS)

# ---------------------------------------------------------------------------
# Archive handling
# ---------------------------------------------------------------------------


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
        if len(names) != len(set(names)) or any(m not in names for m in MEMBERS):
            raise ValueError("expected unique ZIP members including DataModelSchema and UnappliedChanges")
        return infos, {info.filename: archive.read(info) for info in infos}, archive.comment


def build(original, queries, functions, dax):
    infos, payloads, comment = read_archive(original)
    changed = []

    model, encode_model = codec(payloads["DataModelSchema"], "DataModelSchema")
    before = copy.deepcopy(model)
    edits = edit_queries_model(model, queries)
    if functions:
        edits += edit_functions_model(model)
    if dax == "agent-evaluator":
        edits += edit_response_seconds(model)
        edits += edit_unused_columns(model)
    elif dax == "consumption":
        edits += edit_consumption_dax(model)
    if edits:
        if owned_mask_model(before, queries, functions, dax) != owned_mask_model(model, queries, functions, dax):
            raise ValueError("unrelated DataModelSchema fields changed")
        payloads["DataModelSchema"] = encode_model(model)
        changed += [f"DataModelSchema {e}" for e in edits]

    pending, encode_pending = codec(payloads["UnappliedChanges"], "UnappliedChanges")
    before = copy.deepcopy(pending)
    edits = edit_queries_pending(pending, queries)
    if functions:
        edits += edit_functions_pending(pending)
    if edits:
        if owned_mask_pending(before, queries, functions) != owned_mask_pending(pending, queries, functions):
            raise ValueError("unrelated UnappliedChanges fields changed")
        payloads["UnappliedChanges"] = encode_pending(pending)
        changed += [f"UnappliedChanges {e}" for e in edits]

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
    for old, new in zip(infos, after_infos):
        if any(getattr(old, key) != getattr(new, key) for key in ZIP_METADATA):
            raise ValueError(f"ZIP metadata changed: {old.filename}")
        if old.filename not in MEMBERS and payloads[old.filename] != after_payloads[new.filename]:
            raise ValueError(f"unrelated ZIP member changed: {old.filename}")
    return rebuilt, changed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="report stale templates without writing")
    args = parser.parse_args(argv)
    stale = 0
    for relative, queries, functions, dax in TARGETS:
        path = ROOT / relative
        original = path.read_bytes()
        rebuilt, changed = build(original, queries, functions, dax)
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
        print(f"Model refresh fix update failed: {error}", file=sys.stderr)
        sys.exit(1)
