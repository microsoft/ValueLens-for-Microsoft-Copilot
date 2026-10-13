"""Generate the INPUT tables in the golden test data for the audit-log processor parity harness.

    python "tests/fixtures/valuelens-golden/make_fixtures.py"

The output is deterministic: running it again produces byte-identical files. Every identity is
synthetic (example.invalid). The EXPECTED outputs are produced separately, by running the real
Fabric notebook in local Spark:  python tests/valuelens_golden.py --regenerate
"""
import json
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
INPUTS = HERE / "inputs"

# Columns that Copilot_Audit_Log_Direct_Ingester writes to copilot_interactions_parsed, in order.
MODERN_COLUMNS = [
    ("Id", "string"), ("RecordId", "string"), ("Source_RecordKey", "string"),
    ("Source_MessageKey", "string"), ("Source_ResourceKey", "string"),
    ("CreationDate", "timestamp"), ("AgentId", "string"), ("AgentName", "string"),
    ("AppIdentity_AppId", "string"), ("AppIdentity_DisplayName", "string"),
    ("AppIdentity_PublisherId", "string"), ("ApplicationName", "string"), ("ClientRegion", "string"),
    ("Audit_UserId", "string"), ("Audit_UserId_Normalized", "string"), ("Workload", "string"),
    ("AppHost", "string"), ("ThreadId", "string"), ("SensitivityLabelId", "string"),
    ("Context_Type", "string"), ("AISystemPlugin_Id", "string"), ("AISystemPlugin_Name", "string"),
    ("ModelTransparencyDetails_ModelName", "string"),
    ("AccessedResource_Type", "string"), ("AccessedResource_Action", "string"),
    ("AccessedResource_SiteUrl", "string"), ("AccessedResource_SensitivityLabelId", "string"),
    ("Message_Id", "string"), ("Message_isPrompt", "string"),
    ("Message_Ordinal", "bigint"), ("Resource_Ordinal", "bigint"), ("Resource_Count", "bigint"),
    ("InteractionDate", "date"), ("WeekStart", "date"), ("MonthStart", "date"),
    ("Agent_TitleID", "string"), ("Agent_EntraId", "string"),
]

GUID_A = "0f8fad5b-d9cb-469f-a165-70867728950e"
GUID_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

# One scenario per behaviour branch: (AppHost, Context_Type, ResType, ResAction, SiteUrl,
# PluginId, PluginName, Model, AgentName, AgentId, SensitivityLabel, ResSensitivityLabel)
S = [
    ("Outlook", None, "EmailMessage", "Read", None, None, None, "DEEP_LEO", None, None, None, None),
    ("Outlook", None, "EmailMessage", "Draft", None, None, None, "gpt-4.1-mini", None, None, None, None),
    ("Outlook", None, None, "SendEmailV2", None, None, None, "GPT-5-chat", None, None, None, None),
    ("OutlookSidePane", None, None, None, None, None, None, None, None, None, None, None),
    ("Teams", "TeamsMeeting", "Event", "Read", None, None, None, "o3-mini", None, None, None, None),
    ("Teams", None, None, "mcp_MeetingManagement", None, None, None, "REASONING_V2", None, None, None, None),
    ("Teams", "TeamsChat", "TeamsMessage", "PostMessageToConversation", None, None, None, "o1-preview", None, None, None, None),
    ("Teams", None, "TeamsChannel", "Read", None, None, None, None, None, None, "lbl-1", None),
    ("Excel", "xlsx", "xlsx", "Write", None, None, None, "claude-sonnet", None, None, None, None),
    ("Excel", "csv", "CSV", "Read", None, None, None, "gemini-pro", None, None, None, None),
    ("Excel", None, None, None, None, None, None, "LLAMA-3", None, None, None, None),
    ("Word", "docx", "docx", "Create", None, None, None, "phi-4", None, None, None, "res-lbl"),
    ("Word", "docx", "docx", "Read", None, None, None, "NULL", None, None, None, None),
    ("Word", "docx", "doc", "Summarize", None, None, None, "unknown-model-x", None, None, None, None),
    ("Word", "docx", None, None, None, None, None, None, None, None, None, None),
    ("PowerPoint", "pptx", "pptx", "Write", None, None, None, None, None, None, None, None),
    ("PowerPoint", "pptx", "ppt", "Read", None, None, None, None, None, None, None, None),
    ("PowerPoint", "pptm", None, None, None, None, None, None, None, None, None, None),
    ("BizChat", None, "PeopleInferenceAnswer", None, None, None, None, "OFFENSIVE_FILTER", None, None, None, None),
    ("BizChat", None, "ListItem", "Read", "https://contoso.sharepoint.com/sites/hr", None, None, None, None, None, None, None),
    ("BizChat", None, "aspx", "Read", "https://contoso.sharepoint.com/sites/x/page.aspx", None, None, None, None, None, None, None),
    ("BizChat", None, "WebSearchQuery", None, "https://www.bing.com", "BingWebSearch", "Bing", None, None, None, None, None),
    ("BizChat", None, "pdf", "Read", None, None, None, None, None, None, None, None),
    ("BizChat", None, "py", "Write", None, None, None, None, None, None, None, None),
    ("BizChat", None, "json", "Read", None, None, None, None, None, None, None, None),
    ("Designer", None, "png", "Create", None, None, None, None, None, None, None, None),
    ("BizChat", None, "jpeg", "Read", None, None, None, None, None, None, None, None),
    ("Stream", "StreamVideo", "mp4", "Read", None, None, None, None, None, None, None, None),
    ("Planner", None, "PlanId", "Read", None, None, None, None, None, None, None, None),
    ("Loop", None, "LoopPage", "Read", None, None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://github.com/org/repo", None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://learning.cloud.microsoft/x", None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://contoso.sharepoint.com/a", None, None, None, None, None, None, None),
    ("BizChat", None, "http://schema.skype.com/HyperLink", None, "https://news.example.invalid", None, None, None, None, None, None, None),
    ("BizChat", None, "External", None, None, None, None, None, None, None, None, None),
    ("BizChat", None, "Http", "Invoke", None, None, None, None, None, None, None, None),
    ("BizChat", None, None, None, "https://contoso.service-now.com/x", None, None, None, None, None, None, None),
    ("BizChat", None, None, None, "https://org.crm.dynamics.com", None, None, None, None, None, None, None),
    ("BizChat", None, None, "ExecuteDatasetQuery", None, None, None, None, None, None, None, None),
    ("BizChat", None, None, None, None, "EnterpriseSearch", "Enterprise search", None, None, None, None, None),
    ("BizChat", None, None, None, None, "WebPlugin", "Web", None, None, None, None, None),
    ("BizChat", None, None, None, None, None, None, None, None, None, None, None),
    ("SharePoint", None, None, None, None, None, None, None, None, None, None, None),
    ("OneNote", None, None, None, None, None, None, None, None, None, None, None),
    ("Forms", None, None, None, None, None, None, None, None, None, None, None),
    ("Whiteboard", None, None, None, None, None, None, None, None, None, None, None),
    ("Power BI", None, None, None, None, None, None, None, None, None, None, None),
    ("Copilot Studio", None, None, None, None, None, None, None, "Coach Bot", "T_coach.v1", None, None),
    (" Teams ", "aspx", None, None, None, None, None, None, None, None, None, None),
    # Agents and workflows (index 49 onwards)
    ("Copilot Studio", None, None, None, None, None, None, None, "Sales Helper", "CopilotStudio.Declarative.T_sales.1", None, None),
    ("BizChat", None, None, None, None, None, None, None, "Research Analyst", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "HR Onboarding Buddy", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Policy Checker", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "IT Support", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Draft Writer", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Dashboard Bot", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Wiki Buddy", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Brainstorm Pal", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Mystery Agent", GUID_A, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Coder Agent", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Painter Agent", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Files Agent", None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Plain Agent", GUID_B, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Scout", None, None, None),
    ("Autonomous", None, "Flow", "SendEmail", "https://outlook.office.com", None, None, None, "Mail Flow", None, None, None),
    ("Autonomous", None, None, None, None, None, None, None, None, None, None, None),
    ("Logic App", None, "Connector", "CreateItem", "https://contoso.sharepoint.com/list", None, None, None, "List Flow", None, None, None),
    ("Logic App", None, None, None, None, None, None, None, None, None, None, None),
    ("Autonomous", None, "Flow", "Invoke", "https://contoso.service-now.com", None, None, None, "SNOW Flow", None, None, None),
    ("Autonomous", None, "Flow", "UpdateRecord", "https://calendar.example.invalid", None, None, None, "Calendar Flow", None, None, None),
    ("Autonomous", None, "Flow", "GetRows", "https://app.powerbi.com", None, None, None, "Report Flow", None, None, None),
    ("Autonomous", None, "Flow", "DeleteFile", None, None, None, None, "Approve Flow", None, None, None),
    ("Autonomous", None, "Flow", None, None, None, None, None, "Nothing Flow", None, None, None),
    ("Cowork", None, None, None, None, None, None, None, None, None, None, None),
    ("BizChat", None, None, None, None, None, None, None, "Cowork Researcher", None, None, None),
]

# (user, active days as (month, day)). The counts are chosen to land users in each User_Stage.
USERS = [
    ("power@example.invalid", [(9, d) for d in range(1, 17)]),
    ("agentic@example.invalid", [(9, d) for d in range(1, 12)]),
    ("habit@example.invalid", [(9, d) for d in range(1, 10)]),
    ("develop@example.invalid", [(9, 1), (9, 2), (9, 3), (9, 4)]),
    ("beginner@example.invalid", [(9, 7)]),
    ("unlicensed@example.invalid", [(8, 30), (8, 31), (9, 1)]),
    ("MixedCase@Example.Invalid", [(9, 6), (9, 7)]),
    ("SecurityCopilotAgentUser-123@example.invalid", [(9, 2)]),
    (None, [(9, 3)]),
    ("", [(9, 3)]),
]


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def modern_rows():
    rows = []
    n = 0
    for u_idx, (user, days) in enumerate(USERS):
        heavy = bool(user) and user.startswith(("power", "agentic", "habit"))
        for d_idx, (month, day) in enumerate(days):
            for k in range(3 if heavy else 2):
                s = S[(u_idx * 7 + d_idx * 3 + k) % len(S)]
                if user == "agentic@example.invalid" and k == 0:
                    s = S[49 + (d_idx % 6)]          # agent rows
                if user == "agentic@example.invalid" and k == 1:
                    s = S[1 + (d_idx % 2) * 7]       # producing rows
                n += 1
                # Late-evening times check that dates are taken in UTC.
                created = datetime(2026, month, day, [9, 13, 23][k % 3], 30 if k == 2 else 0, k)
                host, ctx, rtype, ract, url, pid, pname, model, aname, aid, lbl, rlbl = s
                title = entra = None
                if aid:
                    if "CopilotStudio.Declarative." in aid:
                        title = aid.split("CopilotStudio.Declarative.")[1].split(".")[0]
                    elif aid.startswith(("P_", "T_")):
                        title = aid.split(".")[0]
                    elif len(aid) == 36:
                        entra = aid
                day_ = created.date()
                rid = f"rec-{n:04d}"
                rows.append([
                    f"id-{n:04d}", rid, f"rid:{rid}", f"msg:{n}",
                    "resource:none" if rtype is None else f"res:{n}",
                    iso(created), aid, aname,
                    "app-1" if n % 4 == 0 else None, "Copilot" if n % 4 == 0 else None, None,
                    "Microsoft 365 Copilot" if n % 2 else None, "GBR" if n % 3 else None,
                    user, None if user is None else user.strip().lower(), "Copilot",
                    host, f"thread-{n % 11}", lbl, ctx, pid, pname, model,
                    rtype, ract, url, rlbl,
                    f"m-{n}", "true", 0, 0, 1 if rtype else 0,
                    day_.isoformat(), (day_ - timedelta(days=day_.weekday())).isoformat(),
                    day_.replace(day=1).isoformat(),
                    title, entra,
                ])
    # A duplicate source row must stay a duplicate. Also add a row with a NULL CreationDate.
    rows.append(list(rows[0]))
    tail = list(rows[5])
    tail[0], tail[5] = "id-nulldate", None
    rows.append(tail)
    return rows


LICENSED_UPN = {
    "columns": [("User Principal Name", "string"), ("Has license", "string"), ("Department", "string")],
    "rows": [
        [" Power@example.invalid ", "Yes", "Sales"],
        ["power@example.invalid", "Yes", "Sales"],
        ["agentic@example.invalid", "TRUE", "Ops"],
        ["habit@example.invalid", "1", "Ops"],
        ["develop@example.invalid", "y", "HR"],
        ["beginner@example.invalid", "Yes", "HR"],
        ["unlicensed@example.invalid", "No", "Finance"],
        ["mixedcase@example.invalid", "Yes", "Finance"],
        ["", "Yes", "Blank"],
        [None, "Yes", "Null"],
    ],
}

AGENT_COLUMNS = [
    ("Title ID", "string"), ("Entra Agent ID", "string"), ("Agent name", "string"),
    ("Agent description", "string"), ("Custom actions", "string"), ("Can use code interpreter", "string"),
    ("Can generate images using user prompt", "string"), ("Can read Sharepoint sites and files", "string"),
    ("Agent type (A365)", "string"),
]
AGENTS_FULL = {
    "columns": AGENT_COLUMNS,
    "rows": [
        ["T_coach", None, "Coach Bot", "Career coaching", None, "No", "No", "No", "Declarative"],
        ["T_sales", None, "Sales Helper", None, None, "No", "No", "No", "Declarative"],
        ["T_mystery", GUID_A, "Mystery Agent", "Helps you brainstorm ideas", None, "No", "No", "No", "Declarative"],
        ["T_coder", None, "Coder Agent", "General helper", None, "Yes", "No", "No", "Declarative"],
        ["T_painter", None, " painter agent ", "General helper", None, "No", "Yes", "No", "Declarative"],
        ["T_files", None, "Files Agent", "General helper", None, "No", "No", "Yes", "Declarative"],
        ["T_plain", GUID_B, "Plain Agent", "Nothing in particular", "Look up tickets", "No", "No", "No", "Autonomous"],
        ["T_kb", None, "Unused Agent", "Product handbook", None, "No", "No", "No", "Declarative"],
        ["", None, "Blank Title", None, None, None, None, None, None],
        ["T_coach", None, "Coach Bot", "Career coaching", None, "No", "No", "No", "Declarative"],
    ],
}

LICENSED_NORMALIZED = {
    "columns": [("UPN_Normalized", "string"), ("Has license", "string")],
    "rows": [["licensed@example.invalid", "Yes"], ["licensed@example.invalid", "Yes"],
             ["unlicensed@example.invalid", "No"]],
}
AGENTS_MIN = {
    "columns": [("Title ID", "string"), ("Entra Agent ID", "string"), ("Agent name", "string")],
    "rows": [["title-1", "entra-1", "Agent One"], ["title-1", "entra-1", "Agent One"],
             ["title-2", "entra-2", "Agent Two"]],
}

# Older exports carry the raw JSON columns. These are the edge cases the Spark parser must survive.
PAYLOADS = [
    ('[{"Type":"docx","Action":"Read","SiteUrl":"https://example.invalid",'
     '"type":"case-variant","SensitivityLabelId":"raw-only","Rare":{"x":[1,null,true]},'
     '"a.b":"dot","odd key":"space"},'
     '{"Type":"xlsx","Action":"Write","FileName":"second.xlsx"}]',
     '{"Id":"plugin-1","Name":"Plugin","id":"lowercase","Extra":{"a":[1,null]}}'),
    ('[]', '[]'), (None, None), ('', ''), ('null', 'null'), ('[null]', '[null]'),
    ('[{}]', '{}'), ('not-json', 'broken'),
    ('[{"Type":42,"Action":true,"Extra":[1,"mixed",null]}]',
     '[{"Id":"first","Name":"First","Extra":1},{"Id":"second","Extra":{"z":2}}]'),
    ('{"Type":"object-shape","Extra":"keep"}', '{"Name":"no-id","Extra":null}'),
    ('[{"Type":null,"Action":null,"Extra":{"nested":null}}]', '[{},{"Name":"second"}]'),
    ('  [ {"Type":"pptx","Extra":"whitespace"} ]  ', '  {"Id":"spaced","Extra":false}  '),
    ('[{"Type":{"mixed":"object"},"Extra":123}]', '{"Id":123,"Extra":[true,{}]}'),
    ('[1, {"Type":"after-scalar"}]', '[1]'),
    ('"just a string"', '"just a string"'),
    ('42', '42'),
    ('[{"Type":"a"},{"Type":"b"},{"Type":"c"}]', '[{"Id":"x","Name":"X"}]'),
    ('[{"Type":"pdf","Action":"Read"}]', '{"Id":"EnterpriseSearch","Name":"ES"}'),
]


def legacy():
    cols = [("Id", "string"), ("CreationDate", "string"), ("Audit_UserId", "string"),
            ("Audit_UserId_Normalized", "string"), ("AccessedResources", "string"),
            ("AISystemPlugin", "string"), ("AppIdentity", "string"),
            ("AccessedResource_SensitivityLabelId", "string"), ("AppHost", "string"),
            ("AgentName", "string"), ("Agent_EntraId", "string"), ("AgentId", "string"),
            ("TenantField", "string")]
    stamps = ["2026-09-01T12:00:00Z", "2026-09-06T23:30:00Z", "2026-09-07T00:15:00+01:00",
              "2026-08-31 08:00:00", "2026-09-02T10:11:12.345Z", "not-a-date"]
    rows = []
    for i, (resources, plugin) in enumerate(PAYLOADS):
        normalized = {2: None, 3: "", 4: "masked-identity", 5: " MixedCase "}.get(
            i, "licensed@example.invalid")
        rows.append([f"row-{i}", stamps[i % len(stamps)], " LICENSED@example.invalid ",
                     normalized, resources, plugin, '{"appId":"app","unknown":null}',
                     "canonical-label" if i % 2 else None, ["Teams", "Word", "Autonomous"][i % 3],
                     "Agent One" if i % 4 else " agent two ",
                     "entra-1" if i % 3 == 0 else None,
                     "title-1.suffix" if i % 3 == 1 else (" title-2 " if i % 3 == 2 else None),
                     "tenant-value"])
    rows.append(list(rows[0]))
    return {"columns": cols, "rows": rows}


def minimal(with_id=True):
    cols = [("Id", "string"), ("CreationDate", "string"), ("Audit_UserId", "string")]
    rows = [["minimal", "2026-09-02T12:00:00Z", "unlicensed@example.invalid"]]
    if not with_id:
        cols, rows = cols[1:], [r[1:] for r in rows]
    return {"columns": cols, "rows": rows}


def dump(name, table):
    INPUTS.mkdir(parents=True, exist_ok=True)
    payload = {"columns": [list(c) for c in table["columns"]], "rows": table["rows"]}
    for row in payload["rows"]:
        assert len(row) == len(payload["columns"]), (name, row)
    (INPUTS / f"{name}.json").write_text(
        json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def main():
    dump("modern_interactions", {"columns": MODERN_COLUMNS, "rows": modern_rows()})
    dump("licensed_upn", LICENSED_UPN)
    dump("agents_full", AGENTS_FULL)
    dump("legacy_interactions", legacy())
    dump("licensed_normalized", LICENSED_NORMALIZED)
    dump("agents_min", AGENTS_MIN)
    dump("minimal_interactions", minimal())
    dump("minimal_no_id_interactions", minimal(with_id=False))
    dump("empty_interactions", {"columns": minimal()["columns"], "rows": []})


if __name__ == "__main__":
    main()
