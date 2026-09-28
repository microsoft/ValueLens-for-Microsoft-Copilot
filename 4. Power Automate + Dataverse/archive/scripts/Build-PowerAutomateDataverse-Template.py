"""Build the additional ValueLens Dataverse template without changing the existing dashboard."""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE_TEMPLATE = ROOT / "2. SharePoint" / "ValueLens - SharePoint.pbit"
TARGET_TEMPLATE = ROOT / "4. Power Automate + Dataverse" / "ValueLens - Power Automate + Dataverse.pbit"
QUERY_ORDER = "PBI_QueryOrder"
ZIP_METADATA = (
    "filename",
    "orig_filename",
    "date_time",
    "compress_type",
    "comment",
    "extra",
    "create_system",
    "create_version",
    "extract_version",
    "reserved",
    "flag_bits",
    "volume",
    "internal_attr",
    "external_attr",
)

DATAVERSE_PARAMETER = "Dataverse URL"
CSV_FALLBACK_PARAMETER = "Use SharePoint CSV fallback"
SNAPSHOT_PARAMETER = "Core Snapshot ID"
INVENTORY_PARAMETER = "Include SharePoint agent inventory"
DATAVERSE_ENTITY_FUNCTION = "ValueLensDataverseEntity"
DATAVERSE_ROWS_FUNCTION = "ValueLensDataverseRows"
SHAREPOINT_TABLE = "SharePoint Agents"
INTERACTIONS_TABLE = "Chat + Agent Interactions (Audit Logs)"
LICENSED_TABLE = "Copilot Licensed"
ORG_TABLE = "Chat + Agent Org Data"
MARKER = "__spLookup = Table.Distinct("
RETURN_RATE_CATEGORY_COLUMN = "Return Rate Category"


def stable_guid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/{name}"))


def read_archive(data: bytes):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate ZIP members are not safe to update")
        payloads = {info.filename: archive.read(info) for info in infos}
        if "DataModelSchema" not in payloads or "UnappliedChanges" not in payloads:
            raise ValueError("Missing DataModelSchema or UnappliedChanges")
        return infos, payloads, archive.comment


def write_archive(infos, payloads, comment) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.comment = comment
        for info in infos:
            archive.writestr(copy.copy(info), payloads[info.filename])
    return output.getvalue()


def load_utf16_json(payloads: dict[str, bytes], member: str):
    return json.loads(payloads[member].decode("utf-16-le"))


def dump_utf16_json(document) -> bytes:
    return json.dumps(document, ensure_ascii=False, indent=2).encode("utf-16-le")


def find_table(model: dict, name: str) -> dict:
    return next(table for table in model["tables"] if table["name"] == name)


def find_query(queries: list[dict], name: str) -> dict:
    return next(query for query in queries if query.get("name") == name or query.get("Name") == name)


def model_object_lineage(model: dict, name: str) -> str:
    for collection in ("expressions", "tables"):
        item = next((item for item in model.get(collection, []) if item["name"] == name), None)
        if item is not None:
            return item["lineageTag"]
    raise ValueError(f"Could not locate model object for query lineage: {name}")


def ensure_query_order(model: dict):
    annotation = next((item for item in model.get("annotations", []) if item["name"] == QUERY_ORDER), None)
    if annotation is None:
        annotation = {"name": QUERY_ORDER, "value": "[]"}
        model.setdefault("annotations", []).append(annotation)
    order = json.loads(annotation["value"])
    for item in (DATAVERSE_PARAMETER, CSV_FALLBACK_PARAMETER, SNAPSHOT_PARAMETER, INVENTORY_PARAMETER, DATAVERSE_ENTITY_FUNCTION, DATAVERSE_ROWS_FUNCTION, SHAREPOINT_TABLE):
        if item not in order:
            order.append(item)
    annotation["value"] = json.dumps(order, ensure_ascii=False, separators=(",", ":"))


def ensure_parameter_expression(model: dict):
    expressions = model.setdefault("expressions", [])
    existing = {expression["name"] for expression in expressions}
    for name, value, result_type, description in (
        (SNAPSHOT_PARAMETER, 'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]', "Text",
         "Completed bridge run ID. Pins all core tables to one immutable snapshot, preserving shared user and message keys."),
        (INVENTORY_PARAMETER, 'false meta [IsParameterQuery=true, Type="Logical", IsParameterQueryRequired=true]', "Logical",
         "Enable only after importing and configuring a compatible SharePointAgentLogging solution in the selected Dataverse environment."),
    ):
        if name not in existing:
            expressions.append({
                "name": name, "kind": "m", "expression": value,
                "description": description,
                "lineageTag": stable_guid(f"expr/{name}"),
                "annotations": [{"name": "PBI_ResultType", "value": result_type}],
            })
    for expression in expressions:
        if expression["name"] in {"Copilot Interactions File", "Org Data File"}:
            expression["expression"] = 'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]'
    if DATAVERSE_PARAMETER not in existing:
        expressions.append(
            {
                "name": DATAVERSE_PARAMETER,
                "description": [
                    "Required Dataverse environment URL for the Power Automate + Dataverse core pathway.",
                    "Leave blank only when Use SharePoint CSV fallback is true.",
                ],
                "kind": "m",
                "expression": 'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]',
                "lineageTag": stable_guid("expr/dataverse-url"),
                "annotations": [
                    {"name": "PBI_NavigationStepName", "value": "Navigation"},
                    {"name": "PBI_ResultType", "value": "Text"},
                ],
            }
        )
    if CSV_FALLBACK_PARAMETER not in existing:
        expressions.append(
            {
                "name": CSV_FALLBACK_PARAMETER,
                "description": [
                    "Explicit compatibility switch. False means core ValueLens facts are read from Dataverse curated tables.",
                    "Set true only to preserve the original SharePoint CSV transport.",
                ],
                "kind": "m",
                "expression": 'false meta [IsParameterQuery=true, Type="Logical", IsParameterQueryRequired=true]',
                "lineageTag": stable_guid("expr/sharepoint-csv-fallback"),
                "annotations": [
                    {"name": "PBI_NavigationStepName", "value": "Navigation"},
                    {"name": "PBI_ResultType", "value": "Logical"},
                ],
            }
        )
    if DATAVERSE_ENTITY_FUNCTION not in existing:
        expressions.append(
            {
                "name": DATAVERSE_ENTITY_FUNCTION,
                "description": "Reads one Dataverse Web API entity set and fails loudly when the configured environment or table is missing.",
                "kind": "m",
                "expression": text_lines(dataverse_entity_function_text()),
                "lineageTag": stable_guid("expr/dataverse-entity-function"),
            }
        )
    if DATAVERSE_ROWS_FUNCTION not in existing:
        expressions.append(
            {
                "name": DATAVERSE_ROWS_FUNCTION,
                "description": "Expands ValueLens curated row payload JSON from Dataverse companion tables into the original dashboard schema.",
                "kind": "m",
                "expression": text_lines(dataverse_rows_function_text()),
                "lineageTag": stable_guid("expr/dataverse-rows-function"),
            }
        )


def ensure_parameter_query(model: dict, queries: list[dict]):
    def add_query(name: str, text: str, result_type: str, description: str):
        existing = next((query for query in queries if (query.get("name") or query.get("Name")) == name), None)
        if existing is not None:
            existing["lineageTag"] = model_object_lineage(model, name)
            return
        queries.append(
            {
                "name": name,
                "lineageTag": model_object_lineage(model, name),
                "description": description,
                "navigationStepName": "Navigation",
                "text": text_lines(text),
                "loadAsTableDisabled": True,
                "resultType": result_type,
                "isHidden": False,
            }
        )

    add_query(
        DATAVERSE_PARAMETER,
        'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]',
        "Text",
        "Required Dataverse environment URL for the curated ValueLens core tables unless the explicit CSV fallback is enabled.",
    )
    add_query(
        CSV_FALLBACK_PARAMETER,
        'false meta [IsParameterQuery=true, Type="Logical", IsParameterQueryRequired=true]',
        "Logical",
        "Compatibility switch. False reads the core facts from Dataverse; true preserves the original SharePoint CSV transport.",
    )
    add_query(SNAPSHOT_PARAMETER,
              'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]',
              "Text", "Completed bridge run ID used consistently by every core table.")
    add_query(INVENTORY_PARAMETER,
              'false meta [IsParameterQuery=true, Type="Logical", IsParameterQueryRequired=true]',
              "Logical", "Opt in to a compatible SharePointAgentLogging inventory after importing its solution.")
    for query in queries:
        if query.get("name") in {"Copilot Interactions File", "Org Data File"}:
            query["text"] = ['null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]']
    add_query(DATAVERSE_ENTITY_FUNCTION, dataverse_entity_function_text(), "Function", "Dataverse entity set reader.")
    add_query(DATAVERSE_ROWS_FUNCTION, dataverse_rows_function_text(), "Function", "ValueLens curated JSON row expander.")


def text_lines(text: str) -> list[str]:
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def dataverse_entity_function_text() -> str:
    return """(entityName as text) as table =>
let
    DataverseUrl = #"Dataverse URL",
    BaseUrl =
        if DataverseUrl = null or Text.Trim(Text.From(DataverseUrl)) = "" then
            error Error.Record(
                "MissingDataverseUrl",
                "Dataverse URL is required when Use SharePoint CSV fallback is false.",
                [Parameter = "Dataverse URL"]
            )
        else
            Text.TrimEnd(Text.Trim(Text.From(DataverseUrl)), "/"),
    Parts = Uri.Parts(BaseUrl),
    ValidatedUrl =
        if Parts[Scheme] <> "https" or Parts[Host] = ""
            or (Parts[Path] <> "" and Parts[Path] <> "/")
            or Record.FieldCount(Parts[Query]) <> 0
            or Record.FieldOrDefault(Parts, "Fragment", "") <> ""
            or Record.FieldOrDefault(Parts, "UserName", "") <> ""
            or Record.FieldOrDefault(Parts, "Password", "") <> ""
        then error Error.Record("InvalidDataverseUrl", "Use the HTTPS environment origin only, without credentials, path or query.", null)
        else BaseUrl,
    Feed = OData.Feed(ValidatedUrl & "/api/data/v9.2/", null, [Implementation = "2.0", ODataVersion = 4]),
    Found = Table.SelectRows(Feed, each [Name] = entityName),
    Output =
        if Table.IsEmpty(Found) then
            error Error.Record(
                "MissingDataverseTable",
                "Expected Dataverse table was not found in the supplied environment.",
                [DataverseUrl = BaseUrl, ExpectedTable = entityName]
            )
        else
            Found{0}[Data]
in
    Output"""


def dataverse_rows_function_text() -> str:
    return """(entityName as text) as table =>
let
    SnapshotId =
        if #"Core Snapshot ID" = null or Text.Trim(Text.From(#"Core Snapshot ID")) = "" then
            error Error.Record("MissingCoreSnapshot", "Set Core Snapshot ID to a completed bridge run ID. All core tables must use the same snapshot.", null)
        else Text.Trim(Text.From(#"Core Snapshot ID")),
    AllowedEntity =
        if List.Contains({"poc_valuelensinteractions", "poc_valuelensusers"}, entityName) then entityName
        else error Error.Record("InvalidCoreEntity", "Unsupported core entity set.", [Entity = entityName]),
    Runs = ValueLensDataverseEntity("poc_valuelensruns"),
    SelectedRun = Table.SelectRows(Runs, each [poc_rowkey] = SnapshotId and [poc_runid] = SnapshotId),
    Manifest =
        if Table.RowCount(SelectedRun) <> 1 then
            error Error.Record("MissingCoreSnapshot", "The selected run manifest was not found or was not unique.", [SnapshotId = SnapshotId])
        else Json.Document(Text.ToBinary(SelectedRun{0}[poc_payloadjson], TextEncoding.Utf8)),
    Contract =
        if Manifest[runId] <> SnapshotId or Manifest[status] <> "succeeded" then
            error Error.Record("IncompleteCoreSnapshot", "The selected run is not a successfully published snapshot.", [SnapshotId = SnapshotId])
        else Record.Field(Manifest[tables], AllowedEntity),
    Columns = Contract[columns],
    ExpectedCount = Contract[count],
    Raw = ValueLensDataverseEntity(entityName),
    SnapshotRows = Table.SelectRows(Raw, each [poc_runid] = SnapshotId),
    Kept = Table.Buffer(Table.SelectColumns(SnapshotRows, {"poc_rowkey", "poc_payloadjson"})),
    Checked =
        if Table.RowCount(Kept) <> ExpectedCount
            or List.Count(List.Distinct(Kept[poc_rowkey])) <> ExpectedCount then
            error Error.Record("IncompleteCoreSnapshot", "Snapshot row count or uniqueness differs from its completed manifest.", [SnapshotId = SnapshotId, Entity = entityName])
        else Kept,
    Records = List.Transform(Checked[poc_payloadjson], each Json.Document(Text.ToBinary(_, TextEncoding.Utf8))),
    Output = Table.FromRecords(Records, Columns, MissingField.Error)
in
    Output"""


def patch_core_source(original: str, table_name: str, file_parameter: str, entity_name: str) -> str:
    fallback_line = f'    UseSharePointCsvFallback = #"Use SharePoint CSV fallback",\n'
    if f'ValueLensDataverseRows("{entity_name}")' in original:
        return original
    needle = (
        f'    FilePath = #"{file_parameter}",\n'
        '    Source = Csv.Document(Web.Contents(FilePath), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),\n'
        '    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),'
    )
    replacement = (
        fallback_line +
        f'    FilePath = #"{file_parameter}",\n'
        f'    Source = if UseSharePointCsvFallback then Csv.Document(Web.Contents(FilePath), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]) else ValueLensDataverseRows("{entity_name}"),\n'
        '    #"Promoted Headers" = if UseSharePointCsvFallback then Table.PromoteHeaders(Source, [PromoteAllScalars = true]) else Source,'
    )
    if needle not in original:
        raise ValueError(f"Could not locate {table_name} CSV source block for Dataverse patch")
    return original.replace(needle, replacement, 1)


def ensure_backfills_model_columns(query_text: str, table: dict) -> str:
    if "DeclaredCols =" not in query_text:
        return query_text
    declared = [column["name"] for column in table.get("columns", []) if not column.get("type")]
    literal = ", ".join(json.dumps(name, ensure_ascii=False) for name in declared)
    replacement = f"DeclaredCols = {{{literal}}},"
    return re.sub(r"DeclaredCols\s*=\s*\{.*?\},\n\s*WithMissing", replacement + "\n    WithMissing", query_text, count=1, flags=re.S)


def repair_agents365_return_rate_category(model: dict):
    try:
        table = find_table(model, "Agents 365")
    except StopIteration:
        return
    column = next((column for column in table.get("columns", []) if column.get("name") == RETURN_RATE_CATEGORY_COLUMN), None)
    if column is None:
        return
    expression = column.get("expression")
    text = "\n".join(expression) if isinstance(expression, list) else str(expression or "")
    if not text.lstrip().startswith("isHidden"):
        return
    column["expression"] = text_lines(
        """VAR Rate = 'Agents 365'[Return Rate Value]
RETURN
    SWITCH(
        TRUE(),
        ISBLANK(Rate), "No Usage",
        Rate >= 0.50, "High",
        Rate >= 0.20, "Medium",
        "Low"
    )"""
    )


def repair_agents365_optional_status_source(model: dict, queries: list[dict]):
    try:
        table = find_table(model, "Agents 365")
    except StopIteration:
        return
    partition = table.get("partitions", [{}])[0]
    source = partition.get("source", {})
    expression = source.get("expression")
    text = "\n".join(expression) if isinstance(expression, list) else str(expression or "")
    if '{"Uploaded files", type text},\n        {"Channel", type text}' in text:
        text = text.replace(
            '{"Uploaded files", type text},\n        {"Channel", type text}',
            '{"Uploaded files", type text},\n        {"Status", type text},\n        {"Channel", type text}',
            1,
        )
        source["expression"] = text_lines(text)
        try:
            query = find_query(queries, "Agents 365")
            query["text"] = text_lines(text)
            update_last_loaded_formula(query, text)
        except StopIteration:
            pass


def repair_metric_glossary_sort(model: dict):
    try:
        table = find_table(model, "📖 Metric Glossary")
    except StopIteration:
        return
    column = next((column for column in table.get("columns", []) if column.get("name") == "Metric"), None)
    if column and column.get("sortByColumn") == "MetricOrder":
        column.pop("sortByColumn", None)


def sharepoint_agents_query_text() -> str:
    return """let
    DataverseUrl = #"Dataverse URL",
    EmptyTable = #table(
        {
            "AgentKey", "AgentName", "FileName", "SiteUrl", "ObjectUrl", "LibraryPath",
            "SiteId", "WebId", "ListId", "ItemId", "FirstSeenAt", "LastSeenAt",
            "CollectedAt", "LastOperation", "LastActor", "ApplicationId",
            "ApplicationName", "IsDeleted", "EventCount", "AuditRecordId", "FlowRunId"
        },
        {}
    ),
    Output =
        if not #"Include SharePoint agent inventory" then
            EmptyTable
        else
            let
                Raw = ValueLensDataverseEntity("poc_sharepointagents"),
                Kept = Table.SelectColumns(
                    Raw,
                    {
                        "poc_agentkey", "poc_name", "poc_filename", "poc_siteurl", "poc_objecturl",
                        "poc_sourcerelativeurl", "poc_siteid", "poc_webid", "poc_listid", "poc_itemid",
                        "poc_firstseenat", "poc_lastseenat", "poc_collectedat", "poc_lastoperation",
                        "poc_lastactor", "poc_applicationid", "poc_applicationname", "poc_isdeleted",
                        "poc_eventcount", "poc_auditrecordid", "poc_flowrunid"
                    }
                ),
                Renamed = Table.RenameColumns(Kept, {
                    {"poc_agentkey", "AgentKey"},
                    {"poc_name", "AgentName"},
                    {"poc_filename", "FileName"},
                    {"poc_siteurl", "SiteUrl"},
                    {"poc_objecturl", "ObjectUrl"},
                    {"poc_sourcerelativeurl", "LibraryPath"},
                    {"poc_siteid", "SiteId"},
                    {"poc_webid", "WebId"},
                    {"poc_listid", "ListId"},
                    {"poc_itemid", "ItemId"},
                    {"poc_firstseenat", "FirstSeenAt"},
                    {"poc_lastseenat", "LastSeenAt"},
                    {"poc_collectedat", "CollectedAt"},
                    {"poc_lastoperation", "LastOperation"},
                    {"poc_lastactor", "LastActor"},
                    {"poc_applicationid", "ApplicationId"},
                    {"poc_applicationname", "ApplicationName"},
                    {"poc_isdeleted", "IsDeleted"},
                    {"poc_eventcount", "EventCount"},
                    {"poc_auditrecordid", "AuditRecordId"},
                    {"poc_flowrunid", "FlowRunId"}
                }),
                Keyed =
                    if Table.RowCount(Table.SelectRows(Renamed, each [AgentKey] = null or Text.Trim(Text.From([AgentKey])) = "")) > 0 then
                        error Error.Record("InvalidSharePointAgentKey", "Inventory contains blank stable keys; repair the collector output.", null)
                    else Renamed,
                Normalized = Table.TransformColumns(Keyed, {{"AgentKey", each Text.Lower(Text.Trim(Text.From(_))), type text}}),
                Unique =
                    if List.Count(List.Distinct(Normalized[AgentKey])) <> Table.RowCount(Normalized) then
                        error Error.Record("DuplicateSharePointAgentKey", "Inventory keys must be unique; repair the collector output.", null)
                    else Normalized,
                Typed = Table.TransformColumnTypes(Unique, {
                    {"AgentName", type text},
                    {"FileName", type text},
                    {"SiteUrl", type text},
                    {"ObjectUrl", type text},
                    {"LibraryPath", type text},
                    {"SiteId", type text},
                    {"WebId", type text},
                    {"ListId", type text},
                    {"ItemId", type text},
                    {"FirstSeenAt", type datetime},
                    {"LastSeenAt", type datetime},
                    {"CollectedAt", type datetime},
                    {"LastOperation", type text},
                    {"LastActor", type text},
                    {"ApplicationId", type text},
                    {"ApplicationName", type text},
                    {"IsDeleted", type logical},
                    {"EventCount", Int64.Type},
                    {"AuditRecordId", type text},
                    {"FlowRunId", type text}
                })
            in
                Typed
in
    Output"""


def patched_interactions_text(original: str) -> str:
    if MARKER in original:
        return original
    needle = "\nin\n    __out"
    if needle not in original:
        raise ValueError("Could not locate the Chat + Agent Interactions final output marker")
    patch = """,
    __withAppIdentity = if Table.HasColumns(__out, "AppIdentity_AppId") then __out else Table.AddColumn(__out, "AppIdentity_AppId", each null, type text),
    __spoGuid = (appIdentity as any) as nullable text =>
        let
            a = if appIdentity = null then "" else Text.Trim(Text.From(appIdentity)),
            DecodeItemGuid = (driveItemId as text) as nullable text =>
                let
                    Encoded = if Text.StartsWith(driveItemId, "01") then Text.Range(driveItemId, 2) else driveItemId,
                    Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
                    Values = List.Transform(Text.ToList(Text.Upper(Encoded)), each Text.PositionOf(Alphabet, _)),
                    Valid = Text.Length(Encoded) = 32 and List.AllTrue(List.Transform(Values, each _ >= 0)),
                    Bits = if not Valid then {} else List.Combine(List.Transform(Values, (v) =>
                        List.Transform({4, 3, 2, 1, 0}, (power) => Number.Mod(Number.IntegerDivide(v, Number.Power(2, power)), 2)))),
                    Bytes = if not Valid then {} else List.Transform(List.Split(Bits, 8), (octet) =>
                        List.Sum(List.Transform(List.Positions(octet), (i) => octet{i} * Number.Power(2, 7 - i)))),
                    GuidBytes = if List.Count(Bytes) = 20 then List.Range(Bytes, 4, 16) else {},
                    Hex = (n as number) as text =>
                        Text.Range("0123456789abcdef", Number.IntegerDivide(n, 16), 1)
                        & Text.Range("0123456789abcdef", Number.Mod(n, 16), 1),
                    JoinHex = (items as list) as text => Text.Combine(List.Transform(items, each Hex(_))),
                    Value =
                        if List.Count(GuidBytes) <> 16 then ""
                        else JoinHex(List.Reverse(List.FirstN(GuidBytes, 4))) & "-"
                            & JoinHex(List.Reverse(List.Range(GuidBytes, 4, 2))) & "-"
                            & JoinHex(List.Reverse(List.Range(GuidBytes, 6, 2))) & "-"
                            & JoinHex(List.Range(GuidBytes, 8, 2)) & "-"
                            & JoinHex(List.Range(GuidBytes, 10, 6))
                in
                    if Value = "" then null else Text.Lower(Value),
            Key =
                if not Text.StartsWith(a, "SPO_") then null
                else
                    let
                        body = Text.Range(a, 4),
                        cut = Text.PositionOf(body, "_", Occurrence.Last),
                        item = if cut > 0 then Text.Range(body, cut + 1) else body
                    in
                        DecodeItemGuid(item)
        in
            Key,
    __spLookup = Table.Distinct(
        Table.SelectColumns(
            Table.SelectRows(#"SharePoint Agents", each [AgentKey] <> null and Text.Trim(Text.From([AgentKey])) <> ""),
            {"AgentKey", "AgentName", "SiteUrl", "ObjectUrl", "LibraryPath", "IsDeleted"}
        ),
        {"AgentKey"}
    ),
    __spFact = Table.AddColumn(__withAppIdentity, "SharePointAgentKey", each
        let
            app = if [AppIdentity_AppId] = null then "" else Text.Trim(Text.From([AppIdentity_AppId])),
            agent = if [AgentId] = null then "" else Text.Trim(Text.From([AgentId])),
            value =
                if Text.StartsWith(app, "SPO_") then __spoGuid(app)
                else if Text.StartsWith(agent, "SPO_") then __spoGuid(agent)
                else null
        in
            value, type text),
    __spJoin = Table.NestedJoin(__spFact, {"SharePointAgentKey"}, __spLookup, {"AgentKey"}, "__sp", JoinKind.LeftOuter),
    __spExpand = Table.ExpandTableColumn(__spJoin, "__sp", {"AgentName", "SiteUrl", "ObjectUrl", "LibraryPath", "IsDeleted"}, {"SharePointAgentName", "SharePointSiteUrl", "SharePointObjectUrl", "SharePointLibraryPath", "SharePointIsDeleted"}),
    __spTyped = Table.TransformColumnTypes(__spExpand, {
        {"SharePointAgentKey", type text},
        {"SharePointAgentName", type text},
        {"SharePointSiteUrl", type text},
        {"SharePointObjectUrl", type text},
        {"SharePointLibraryPath", type text},
        {"SharePointIsDeleted", type logical}
    })
in
    __spTyped"""
    return original.replace(needle, patch, 1)


def update_last_loaded_formula(query: dict, text: str):
    payload = query.get("lastLoadedAsTableFormulaText")
    if not payload:
        return
    parsed = json.loads(payload)
    parsed["RootFormulaText"] = text
    parsed["ReferencedQueriesFormulaText"] = {}
    query["lastLoadedAsTableFormulaText"] = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))


def make_column(name: str, data_type: str, *, hidden: bool = False, fmt: str | None = None, summarize: str = "none", source_column: str | None = None):
    column = {
        "name": name,
        "dataType": data_type,
        "sourceColumn": source_column or name,
        "lineageTag": stable_guid(f"column/{name}"),
        "summarizeBy": summarize,
    }
    if hidden:
        column["isHidden"] = True
        column["changedProperties"] = [{"property": "IsHidden"}]
    if fmt:
        column["formatString"] = fmt
    return column


def make_measure(name: str, expression: str, *, fmt: str, folder: str):
    return {
        "name": name,
        "expression": text_lines(expression),
        "formatString": fmt,
        "displayFolder": folder,
        "lineageTag": stable_guid(f"measure/{name}"),
    }


def ensure_interactions_columns(table: dict):
    columns = table.setdefault("columns", [])
    existing = {column["name"] for column in columns}
    additions = [
        make_column("SharePointAgentKey", "string", hidden=True),
        make_column("SharePointAgentName", "string"),
        make_column("SharePointSiteUrl", "string"),
        make_column("SharePointObjectUrl", "string"),
        make_column("SharePointLibraryPath", "string"),
        make_column("SharePointIsDeleted", "boolean"),
    ]
    for column in additions:
        if column["name"] not in existing:
            columns.append(column)


def ensure_sharepoint_table(model: dict):
    tables = model.setdefault("tables", [])
    if any(table["name"] == SHAREPOINT_TABLE for table in tables):
        return
    table = {
        "name": SHAREPOINT_TABLE,
        "lineageTag": stable_guid("table/sharepoint-agents"),
        "columns": [
            make_column("AgentKey", "string", hidden=True),
            make_column("AgentName", "string"),
            make_column("FileName", "string"),
            make_column("SiteUrl", "string"),
            make_column("ObjectUrl", "string"),
            make_column("LibraryPath", "string"),
            make_column("SiteId", "string", hidden=True),
            make_column("WebId", "string", hidden=True),
            make_column("ListId", "string", hidden=True),
            make_column("ItemId", "string"),
            make_column("FirstSeenAt", "dateTime", fmt="yyyy-mm-dd hh:nn:ss"),
            make_column("LastSeenAt", "dateTime", fmt="yyyy-mm-dd hh:nn:ss"),
            make_column("CollectedAt", "dateTime", fmt="yyyy-mm-dd hh:nn:ss"),
            make_column("LastOperation", "string"),
            make_column("LastActor", "string"),
            make_column("ApplicationId", "string", hidden=True),
            make_column("ApplicationName", "string"),
            make_column("IsDeleted", "boolean"),
            make_column("EventCount", "int64", fmt="#,0", summarize="sum"),
            make_column("AuditRecordId", "string", hidden=True),
            make_column("FlowRunId", "string", hidden=True),
        ],
        "partitions": [
            {
                "name": SHAREPOINT_TABLE,
                "mode": "import",
                "source": {"type": "m", "expression": text_lines(sharepoint_agents_query_text())},
            }
        ],
        "measures": [
            make_measure("SharePoint Agents", "COUNTROWS ( 'SharePoint Agents' )", fmt="#,0", folder="Optional\\SharePoint Agents"),
            make_measure(
                "Current SharePoint Agents",
                "CALCULATE ( [SharePoint Agents], KEEPFILTERS ( 'SharePoint Agents'[IsDeleted] = FALSE () ) )",
                fmt="#,0",
                folder="Optional\\SharePoint Agents",
            ),
            make_measure(
                "Deleted SharePoint Agents",
                "CALCULATE ( [SharePoint Agents], KEEPFILTERS ( 'SharePoint Agents'[IsDeleted] = TRUE () ) )",
                fmt="#,0",
                folder="Optional\\SharePoint Agents",
            ),
            make_measure("SharePoint Audit Events", "SUM ( 'SharePoint Agents'[EventCount] )", fmt="#,0", folder="Optional\\SharePoint Agents"),
            make_measure(
                "SharePoint Inventory Age (days)",
                "VAR collected = MAX ( 'SharePoint Agents'[CollectedAt] ) RETURN IF ( ISBLANK ( collected ), BLANK (), DATEDIFF ( collected, NOW (), DAY ) )",
                fmt="#,0",
                folder="Optional\\SharePoint Agents",
            ),
        ],
        "hierarchies": [],
        "annotations": [],
    }
    tables.append(table)


def ensure_relationship(model: dict):
    relationships = model.setdefault("relationships", [])
    exists = any(
        relationship.get("fromTable") == INTERACTIONS_TABLE
        and relationship.get("fromColumn") == "SharePointAgentKey"
        and relationship.get("toTable") == SHAREPOINT_TABLE
        and relationship.get("toColumn") == "AgentKey"
        for relationship in relationships
    )
    if exists:
        return
    relationships.append(
        {
            "name": stable_guid("relationship/chat-sharepoint-agents"),
            "fromTable": INTERACTIONS_TABLE,
            "fromColumn": "SharePointAgentKey",
            "toTable": SHAREPOINT_TABLE,
            "toColumn": "AgentKey",
        }
    )


def ensure_sharepoint_query(model: dict, queries: list[dict]):
    existing = next((query for query in queries if (query.get("name") or query.get("Name")) == SHAREPOINT_TABLE), None)
    if existing is not None:
        existing["lineageTag"] = model_object_lineage(model, SHAREPOINT_TABLE)
        return
    text = sharepoint_agents_query_text()
    queries.append(
        {
            "name": SHAREPOINT_TABLE,
            "lineageTag": model_object_lineage(model, SHAREPOINT_TABLE),
            "navigationStepName": "Navigation",
            "text": text_lines(text),
            "isDirectQuery": False,
            "lastLoadedAsTableFormulaText": json.dumps(
                {"IncludesReferencedQueries": False, "RootFormulaText": text, "ReferencedQueriesFormulaText": {}},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            "loadAsTableDisabled": False,
            "resultType": "Table",
            "isHidden": False,
        }
    )


def patch_model(payloads: dict[str, bytes]):
    schema = load_utf16_json(payloads, "DataModelSchema")
    unapplied = load_utf16_json(payloads, "UnappliedChanges")
    model = schema["model"]
    queries = unapplied["queries"]

    repair_agents365_return_rate_category(model)
    repair_agents365_optional_status_source(model, queries)
    repair_metric_glossary_sort(model)
    ensure_parameter_expression(model)
    ensure_parameter_query(model, queries)
    ensure_query_order(model)

    interactions_table = find_table(model, INTERACTIONS_TABLE)
    ensure_interactions_columns(interactions_table)
    interaction_expression = interactions_table["partitions"][0]["source"]["expression"]
    interaction_text = "\n".join(interaction_expression) if isinstance(interaction_expression, list) else interaction_expression
    interaction_text = patch_core_source(
        interaction_text,
        INTERACTIONS_TABLE,
        "Copilot Interactions File",
        "poc_valuelensinteractions",
    )
    interaction_text = patched_interactions_text(interaction_text)
    interactions_table["partitions"][0]["source"]["expression"] = text_lines(interaction_text)

    interaction_query = find_query(queries, INTERACTIONS_TABLE)
    interaction_query["text"] = text_lines(interaction_text)
    update_last_loaded_formula(interaction_query, interaction_text)

    for table_name, file_parameter, entity_name in (
        (LICENSED_TABLE, "Org Data File", "poc_valuelensusers"),
        (ORG_TABLE, "Org Data File", "poc_valuelensusers"),
    ):
        table = find_table(model, table_name)
        table_expression = table["partitions"][0]["source"]["expression"]
        table_text = "\n".join(table_expression) if isinstance(table_expression, list) else table_expression
        table_text = patch_core_source(table_text, table_name, file_parameter, entity_name)
        if table_name == ORG_TABLE:
            table_text = ensure_backfills_model_columns(table_text, table)
        table["partitions"][0]["source"]["expression"] = text_lines(table_text)
        query = find_query(queries, table_name)
        query["text"] = text_lines(table_text)
        update_last_loaded_formula(query, table_text)

    ensure_sharepoint_table(model)
    ensure_sharepoint_query(model, queries)
    ensure_relationship(model)

    payloads["DataModelSchema"] = dump_utf16_json(schema)
    payloads["UnappliedChanges"] = dump_utf16_json(unapplied)


def validate_preserved_zip(original: bytes, rebuilt: bytes):
    before_info, before, before_comment = read_archive(original)
    after_info, after, after_comment = read_archive(rebuilt)
    if list(before) != list(after) or before_comment != after_comment:
        raise ValueError("ZIP members, order or archive comment changed")
    for old, new in zip(before_info, after_info):
        if any(getattr(old, key) != getattr(new, key) for key in ZIP_METADATA):
            raise ValueError(f"ZIP metadata changed: {old.filename}")
        if old.filename not in {"DataModelSchema", "UnappliedChanges"} and before[old.filename] != after[old.filename]:
            raise ValueError(f"Unrelated ZIP member changed: {old.filename}")


def build_template() -> bytes:
    original = SOURCE_TEMPLATE.read_bytes()
    infos, payloads, comment = read_archive(original)
    patch_model(payloads)
    rebuilt = write_archive(infos, payloads, comment)
    validate_preserved_zip(original, rebuilt)
    return rebuilt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Exit non-zero when the target template is missing or stale")
    args = parser.parse_args(argv)

    rebuilt = build_template()
    current = TARGET_TEMPLATE.read_bytes() if TARGET_TEMPLATE.exists() else None

    if args.check:
        if current != rebuilt:
            print("Power Automate + Dataverse template is missing or stale", file=sys.stderr)
            return 1
        print("Power Automate + Dataverse template is current")
        return 0

    TARGET_TEMPLATE.parent.mkdir(parents=True, exist_ok=True)
    if current != rebuilt:
        TARGET_TEMPLATE.write_bytes(rebuilt)
    print("Template SHA256: " + hashlib.sha256(rebuilt).hexdigest())
    print(("Updated" if current != rebuilt else "Current") + f": {TARGET_TEMPLATE}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, StopIteration, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(f"Power Automate + Dataverse template build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
