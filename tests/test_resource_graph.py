"""Azure Resource Graph source (#162): the Azure jobs' collector, the Fabric notebook's shared block,
the inventory flow fallback, publish targets and the V004 migration. HTTP is faked at the session level."""
from __future__ import annotations

import ast
import json
import re
import sqlite3
from datetime import date

import duckdb
import pytest

import notebook_source
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import api as api_mod
from valuelens_jobs import publish as pub
from valuelens_jobs import sql as sql_mod
from valuelens_jobs.collect import resource_graph as rg
from valuelens_jobs.config import Settings
from valuelens_jobs.storage import LocalStore

ROOT = notebook_source.ROOT
V004 = ROOT / "2. Azure" / "sql" / "migrations" / "V004__resource_graph.sql"
COLLECTOR = ROOT / "2. Azure" / "jobs" / "valuelens_jobs" / "collect" / "resource_graph.py"
NOTEBOOK = "Copilot_Resource_Graph_Ingester.ipynb"
SHARED_START = "# --- Shared with the Fabric notebook Copilot_Resource_Graph_Ingester.ipynb (section 2); keep identical. ---\n"
SHARED_END = "# --- End of shared block. ---\n"
TODAY = date(2026, 9, 10)
BOT = "AAAAAAAA-0000-0000-0000-000000000001"
ENV = "BBBBBBBB-0000-0000-0000-000000000002"
ACCOUNT = "/subscriptions/S1/resourceGroups/RG/providers/Microsoft.CognitiveServices/accounts/Hub"


# ---------------------------------------------------------------- fakes
class Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body
        self.headers = {}
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        return self._body


class Session:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def request(self, method, url, headers=None, timeout=None, **kw):
        self.calls.append((method, url, kw))
        return self.handler(method, url, kw)


class Tokens:
    def get(self, scope, force=False):
        return f"tok-{scope}"


def make_api(handler):
    session = Session(handler)
    return api_mod.Api(Tokens(), session=session, sleep=lambda s: None), session


def agent_record(**props):
    base = {
        "botId": BOT, "displayName": "Helpdesk", "environmentId": ENV, "authentication": "None",
        "isQuarantined": False, "isManaged": "true", "IsWebSearchEnabledForKnowledge": True,
        "entraAgentId": "CCCCCCCC-0000-0000-0000-000000000003", "ownerId": "OWNER-1",
        "powerPlatformConnectors": [
            {"connectorId": "shared_sharepointonline", "operations": [{"usedAs": "Knowledge"}]},
            {"connectorId": "shared_contoso_mcp", "operations": [{"usedAs": "Tool"}]},
            {"connectorId": "shared_sharepointonline", "operations": []},
        ],
        "capabilitiesCounts": {"connectedAgents": 2, "topics": 7},
        "sharedWithViewers": {"userCount": 4, "groupCount": "1", "entireTenant": "true"},
        "channels": ["Teams", "Web"], "lastPublishedAt": "2026-09-01T10:00:00Z",
    }
    base.update(props)
    return {"id": f"/providers/Microsoft.CopilotStudio/agents/{BOT}", "name": BOT.lower(),
            "type": rg.AGENT_TYPE, "location": "europe", "properties": base}


def env_record():
    return {"id": f"/providers/Microsoft.PowerPlatform/environments/{ENV}", "name": ENV, "type": rg.ENVIRONMENT_TYPE,
            "location": "europe", "properties": {"displayName": "Default", "environmentType": "Default",
                                                 "isManaged": False}}


def flow_record():
    return {"id": "/flows/F1", "name": "F1", "type": rg.FLOW_TYPE,
            "properties": {"displayName": "Triage", "environmentId": ENV, "ownerId": "OWNER-1",
                           "powerPlatformConnectors": [{"connectorId": "a"}, {"connectorId": "b"}]}}


def foundry_records():
    return [
        {"id": ACCOUNT, "name": "Hub", "type": "microsoft.cognitiveservices/accounts", "kind": "AIServices",
         "location": "swedencentral", "subscriptionId": "S1", "resourceGroup": "RG", "sku": {"name": "S0"},
         "publicNetworkAccess": "", "disableLocalAuth": True},
        {"id": ACCOUNT + "/projects/Bots", "name": "Hub/Bots", "type": "Microsoft.CognitiveServices/accounts/projects",
         "location": "swedencentral", "subscriptionId": "S1", "resourceGroup": "RG",
         "publicNetworkAccess": "Disabled", "disableLocalAuth": None},
    ]


def by_query(responses):
    """A handler answering each Resource Graph query by its table, from `responses[table]`."""
    def handler(method, url, kw):
        assert method == "POST" and url == rg.ARG_URL and kw["params"] == {"api-version": rg.ARG_API}
        query = kw["json"]["query"]
        table = next(t for t, q in rg.ARG_QUERIES.items() if q == query)
        answer = responses[table]
        return answer(kw["json"]) if callable(answer) else answer
    return handler


def parquet(store, table):
    path = (store.root / "raw" / table / "part-0.parquet").as_posix()
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{path}')")
    return [dict(zip(rel.columns, r)) for r in rel.fetchall()]


# ---------------------------------------------------------------- shared block + notebook
def _shared() -> str:
    text = COLLECTOR.read_text(encoding="utf-8").replace("\r\n", "\n")
    return text.split(SHARED_START, 1)[1].split(SHARED_END, 1)[0].strip()


def _cells():
    return json.loads((notebook_source.NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8"))["cells"]


def test_shared_block_is_identical_in_notebook_and_collector():
    shared = _shared()
    found = [c for c in _cells() if c["cell_type"] == "code" and "def collect_rows(" in "".join(c["source"])]
    assert len(found) == 1
    assert "".join(found[0]["source"]).strip() == shared
    assert not any(isinstance(n, (ast.Import, ast.ImportFrom)) for n in ast.parse(shared).body)


def test_notebook_config_is_what_the_installer_sets():
    config = next(c for c in _cells() if c["cell_type"] == "code" and "# === CONFIG ===" in "".join(c["source"]))
    text = "".join(config["source"])
    for name in ("TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", "MANAGEMENT_GROUP", "INCLUDE_AGENTS", "INCLUDE_FOUNDRY",
                 "REGISTRY_TABLE", "INVENTORY_FOLDER"):
        assert re.search(rf"^{name}\s*=", text, re.M), name
    assert "INVENTORY_FOLDER = 'Files/arg_inventory'" in text


def test_notebook_runs_the_shared_logic_like_the_collector():
    ns = notebook_source.namespace(NOTEBOOK, {"ARG_SCHEMAS", "ARG_QUERIES", "TBL_AGENTS", "TBL_FOUNDRY", "TBL_STATUS",
                                              "INVENTORY_TABLES", "INVENTORY_TYPES", "ROW_BUILDERS", "AGENT_TYPE",
                                              "ENVIRONMENT_TYPE", "FLOW_TYPE", "FOUNDRY_TYPES", "TBL_ENVIRONMENTS",
                                              "TBL_FLOWS", "SOURCE_ARG", "SOURCE_INVENTORY", "ARG_PAGE_SIZE"})
    assert ns["ARG_SCHEMAS"] == rg.ARG_SCHEMAS and ns["ARG_QUERIES"] == rg.ARG_QUERIES
    args = (True, True, lambda kql: [], lambda: ("x.json", [agent_record()]), lambda: [], TODAY)
    assert ns["collect_rows"](*args) == rg.collect_rows(*args)


# ---------------------------------------------------------------- normalisers
def test_agent_row_reads_configuration():
    row = rg.agent_row(agent_record(), TODAY)
    assert set(row) == {c for c, _ in rg.ARG_SCHEMAS[rg.TBL_AGENTS]}
    assert row["BotId"] == BOT.lower() and row["EnvironmentId"] == ENV.lower()
    assert row["AgentName"] == "Helpdesk" and row["Authentication"] == "None" and row["NoSignIn"] is True
    assert row["IsQuarantined"] is False and row["IsManaged"] is True and row["WebSearchEnabled"] is True
    assert row["ConnectorCount"] == 2 and row["McpConnectorCount"] == 1 and row["KnowledgeConnectorCount"] == 1
    assert row["Connectors"] == "shared_contoso_mcp; shared_sharepointonline"
    assert row["ConnectedAgentCount"] == 2
    assert (row["SharedUsers"], row["SharedGroups"], row["SharedEntireTenant"]) == (4, 1, True)
    assert row["Channels"] == "Teams; Web" and row["Source"] == rg.SOURCE_ARG


def test_agent_row_is_lenient_with_missing_fields():
    row = rg.agent_row({"name": "x", "type": rg.AGENT_TYPE}, TODAY)
    assert row["BotId"] == "x" and row["AgentName"] == "x"
    assert row["NoSignIn"] is None and row["IsQuarantined"] is None and row["ConnectorCount"] == 0
    assert row["SharedEntireTenant"] is False
    assert rg.agent_row(agent_record(authentication="Integrated"), TODAY)["NoSignIn"] is False


def test_environment_and_flow_rows():
    env = rg.environment_row(env_record(), TODAY)
    assert env["EnvironmentId"] == ENV.lower() and env["IsDefault"] is True and env["IsManaged"] is False
    flow = rg.flow_row(flow_record(), TODAY)
    assert flow["FlowId"] == "f1" and flow["EnvironmentId"] == ENV.lower() and flow["ConnectorCount"] == 2


def test_foundry_rows_lowercase_ids_and_link_projects():
    account, project = (rg.foundry_row(r, TODAY) for r in foundry_records())
    assert account["ResourceId"] == ACCOUNT.lower() and account["IsProject"] is False
    assert account["AccountId"] == ACCOUNT.lower() and account["Sku"] == "S0"
    assert account["PublicNetwork"] is True and account["DisableLocalAuth"] is True
    assert project["IsProject"] is True and project["ResourceName"] == "Bots"
    assert project["AccountId"] == ACCOUNT.lower() and project["PublicNetwork"] is False
    assert project["ResourceType"] == "microsoft.cognitiveservices/accounts/projects"


def test_titles_resolve_by_bot_id_then_entra_agent_id():
    rows = [rg.agent_row(agent_record(), TODAY),
            rg.agent_row(agent_record(botId="other", entraAgentId="E-2"), TODAY),
            rg.agent_row(agent_record(botId="none", entraAgentId=""), TODAY)]
    registry = [{"Title ID": "T1", "Bot Id": f"zzz; {BOT}", "Entra Agent ID": ""},
                {"Title ID": "T2", "Bot Id": "", "Entra Agent ID": "e-2"},
                {"Title ID": "", "Bot Id": "none"}]
    rg.resolve_titles(rows, registry)
    assert [(r["TitleId"], r["MatchedOn"]) for r in rows] == [("T1", "Bot Id"), ("T2", "Entra Agent ID"), ("", "")]


def test_arg_body_scopes_and_pages():
    assert rg.arg_body("q") == {"query": "q", "options": {"$top": 1000, "resultFormat": "objectArray"}}
    body = rg.arg_body("q", "tok", "mg-1")
    assert body["options"]["$skipToken"] == "tok" and body["managementGroups"] == ["mg-1"]


def test_inventory_records_accept_pages_and_records():
    page = {"data": [agent_record(), "junk"], "skipToken": "x"}
    assert len(rg.inventory_records(page)) == 1
    assert len(rg.inventory_records([page, {"data": [env_record()]}])) == 2
    assert len(rg.inventory_records([agent_record(), {"no": "type"}])) == 1
    grouped = rg.split_inventory([agent_record(), env_record(), flow_record(), {"type": "other"}])
    assert {t: len(v) for t, v in grouped.items()} == {rg.TBL_AGENTS: 1, rg.TBL_ENVIRONMENTS: 1, rg.TBL_FLOWS: 1}


# ---------------------------------------------------------------- orchestration
def test_collect_rows_falls_back_to_the_inventory_flow():
    def run_query(kql):
        if kql.startswith("PowerPlatformResources"):
            raise rg.ResourceGraphError("nope", 403)
        return foundry_records()

    tables, statuses = rg.collect_rows(True, True, run_query, lambda: ("20260910_agent_inventory.json",
                                       [agent_record(), env_record(), flow_record()]),
                                       lambda: [{"Title ID": "T1", "Bot Id": BOT}], TODAY)
    assert {t: len(r) for t, r in tables.items()} == {rg.TBL_AGENTS: 1, rg.TBL_ENVIRONMENTS: 1, rg.TBL_FLOWS: 1,
                                                       rg.TBL_FOUNDRY: 2}
    assert tables[rg.TBL_AGENTS][0]["TitleId"] == "T1"
    assert tables[rg.TBL_AGENTS][0]["Source"] == rg.SOURCE_INVENTORY
    status = {s["Probe"]: s for s in statuses}
    assert status[rg.TBL_AGENTS]["Status"] == "ok" and status[rg.TBL_AGENTS]["Source"] == rg.SOURCE_INVENTORY
    assert status[rg.TBL_AGENTS]["Detail"] == "Resource Graph forbidden; read 20260910_agent_inventory.json"
    assert status[rg.TBL_FOUNDRY]["Source"] == rg.SOURCE_ARG and status[rg.TBL_FOUNDRY]["Rows"] == 2


def test_collect_rows_records_why_a_probe_is_empty():
    def run_query(kql):
        if kql.startswith("resources"):
            raise rg.ResourceGraphError("throttled", 500)
        return []

    def bad_inventory():
        raise ValueError("not json")

    tables, statuses = rg.collect_rows(True, True, run_query, bad_inventory, lambda: [], TODAY)
    status = {s["Probe"]: s for s in statuses}
    assert set(tables) == {rg.TBL_AGENTS, rg.TBL_ENVIRONMENTS, rg.TBL_FLOWS} and tables[rg.TBL_AGENTS] == []
    assert status[rg.TBL_AGENTS]["Status"] == "empty"
    assert status[rg.TBL_FOUNDRY]["Status"] == "error" and rg.TBL_FOUNDRY not in tables


def test_collect_rows_skips_turned_off_probes_and_keeps_refused_tables():
    calls = []

    def run_query(kql):
        calls.append(kql)
        raise rg.ResourceGraphError("denied", 401)

    tables, statuses = rg.collect_rows(False, True, run_query, lambda: pytest.fail("no inventory"),
                                       lambda: pytest.fail("no registry"), TODAY)
    assert tables == {} and calls == [rg.ARG_QUERIES[rg.TBL_FOUNDRY]]
    assert [(s["Probe"], s["Status"]) for s in statuses] == [
        (rg.TBL_FOUNDRY, "forbidden"), (rg.TBL_AGENTS, "skipped"), (rg.TBL_ENVIRONMENTS, "skipped"),
        (rg.TBL_FLOWS, "skipped")]
    rg.mark_write_failed(statuses, rg.TBL_AGENTS, OSError("disk"))
    assert statuses[1]["Status"] == "error" and statuses[1]["Detail"] == "OSError: disk"


# ---------------------------------------------------------------- Azure jobs collector
def test_query_follows_skip_tokens_and_reads_table_results():
    pages = iter([
        Resp(body={"data": [{"id": "a"}], "$skipToken": "t1"}),
        Resp(body={"data": {"columns": [{"name": "id"}], "rows": [["b"]]}}),
    ])
    api, session = make_api(lambda m, u, kw: next(pages))
    assert rg.query(api, "resources", "mg") == [{"id": "a"}, {"id": "b"}]
    assert [kw["json"]["options"].get("$skipToken") for _, _, kw in session.calls] == [None, "t1"]
    assert all(kw["json"]["managementGroups"] == ["mg"] and kw["allow_redirects"] is False
               for _, _, kw in session.calls)


def test_query_raises_with_the_status_code():
    api, _ = make_api(lambda m, u, kw: Resp(403, {"error": {"code": "Forbidden"}}))
    with pytest.raises(rg.ResourceGraphError) as err:
        rg.query(api, "resources")
    assert err.value.status_code == 403 and rg.failure_status(err.value.status_code) == "forbidden"


def test_collect_writes_tables_and_status(tmp_path):
    store = LocalStore(tmp_path)
    api, _ = make_api(by_query({
        rg.TBL_AGENTS: Resp(body={"data": [agent_record()]}),
        rg.TBL_ENVIRONMENTS: Resp(body={"data": [env_record()]}),
        rg.TBL_FLOWS: Resp(body={"data": []}),
        rg.TBL_FOUNDRY: Resp(body={"data": foundry_records()}),
    }))
    out = rg.collect_resource_graph(api, store, Settings(modules=frozenset({"resourceGraph"})), today=TODAY)
    assert out == {rg.TBL_AGENTS: 1, rg.TBL_ENVIRONMENTS: 1, rg.TBL_FLOWS: 0, rg.TBL_FOUNDRY: 2, rg.TBL_STATUS: 4}
    agents = parquet(store, rg.TBL_AGENTS)
    assert agents[0]["NoSignIn"] is True and agents[0]["TitleId"] == "" and agents[0]["SnapshotDate"] == TODAY
    assert [c for c, _ in rg.ARG_SCHEMAS[rg.TBL_AGENTS]] == list(agents[0])
    status = {r["Probe"]: r["Status"] for r in parquet(store, rg.TBL_STATUS)}
    assert status == {rg.TBL_AGENTS: "ok", rg.TBL_ENVIRONMENTS: "ok", rg.TBL_FLOWS: "empty", rg.TBL_FOUNDRY: "ok"}


def test_collect_uses_the_landing_inventory_and_keeps_refused_foundry(tmp_path):
    store = LocalStore(tmp_path)
    # Yesterday's Foundry snapshot stays when today's probe is refused.
    rg.write_table(store, rg.TBL_FOUNDRY, [rg.foundry_row(r, date(2026, 9, 9)) for r in foundry_records()])
    drop = tmp_path / "landing" / rg.INVENTORY_DIR
    drop.mkdir(parents=True)
    (drop / "20260909060000_agent_inventory.json").write_text(json.dumps([{"data": [env_record()]}]), "utf-8")
    (drop / "20260910060000_agent_inventory.json").write_text(
        "\ufeff" + json.dumps([{"data": [agent_record(), env_record()]}, {"data": [flow_record()]}]), "utf-8")
    (drop / "notes.txt").write_text("ignore me", "utf-8")
    api, _ = make_api(lambda m, u, kw: Resp(403, {"error": {"code": "AuthorizationFailed"}}))
    settings = Settings(modules=frozenset({"resourceGraph"}), arg_management_group="mg-1")
    out = rg.collect_resource_graph(api, store, settings, today=TODAY)
    assert out == {rg.TBL_AGENTS: 1, rg.TBL_ENVIRONMENTS: 1, rg.TBL_FLOWS: 1, rg.TBL_STATUS: 4}
    assert parquet(store, rg.TBL_AGENTS)[0]["Source"] == rg.SOURCE_INVENTORY
    assert {r["SnapshotDate"] for r in parquet(store, rg.TBL_FOUNDRY)} == {date(2026, 9, 9)}
    status = {r["Probe"]: r for r in parquet(store, rg.TBL_STATUS)}
    assert status[rg.TBL_FOUNDRY]["Status"] == "forbidden"
    assert status[rg.TBL_AGENTS]["Detail"] == "Resource Graph forbidden; read 20260910060000_agent_inventory.json"


def test_settings_parse_resource_graph():
    s = Settings.from_env({"VALUELENS_MODULES": "core,resourceGraph", "VALUELENS_ARG_MANAGEMENT_GROUP": " mg-1 ",
                           "VALUELENS_ARG_AGENTS": "false", "VALUELENS_ARG_FOUNDRY": "true"})
    assert s.has("resourceGraph") and s.arg_management_group == "mg-1"
    assert s.arg_agents is False and s.arg_foundry is True
    empty = Settings.from_env({})
    assert empty.arg_management_group == "" and empty.arg_agents is True and empty.arg_foundry is True


def test_collect_wiring_and_publish_targets(tmp_path, monkeypatch):
    from valuelens_jobs.collect import audit, graph

    called = []
    for mod, name in ((graph, "collect_licensed"), (audit, "collect_audit"), (rg, "collect_resource_graph")):
        monkeypatch.setattr(mod, name, lambda *a, _n=name, **k: called.append(_n))
    store = LocalStore(tmp_path)
    jobs_main.collect(store, Settings(modules=frozenset({"core"})), api=object())
    assert called == ["collect_licensed", "collect_audit"]
    called.clear()
    jobs_main.collect(store, Settings(modules=frozenset({"core", "resourceGraph"})), api=object())
    assert called == ["collect_licensed", "collect_audit", "collect_resource_graph"]

    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "resourceGraph"}))) == [
        "curated", "licensed", *pub.RESOURCE_GRAPH]
    assert jobs_main.publish_targets(Settings(modules=frozenset({"resourceGraph"}), sample_data=True)) == [
        "curated", "licensed", "org"]
    for name in pub.RESOURCE_GRAPH:
        t = pub.TARGETS[name]
        assert t.prefix == f"raw/{name}" and not t.incremental and t.partition is None


# ---------------------------------------------------------------- V004
def _v004_tables() -> dict:
    sql = V004.read_text(encoding="utf-8")
    out = {}
    for name, body in re.findall(r"CREATE TABLE dbo\.(\w+) \((.*?)\n\);", sql, re.S):
        out[name] = [tuple(m) for m in re.findall(r"\[(\w+)\] ([A-Z]+(?:\(\d+\))?) NULL", body)]
    return out


def test_v004_matches_collector_schemas():
    sql = V004.read_text(encoding="utf-8")
    assert sql_mod.batches(sql) and [v for v, _ in sql_mod.migrations(V004.parent)][:4] == [1, 2, 3, 4]
    assert "WHERE version = 4)" in sql and "VALUES (4," in sql
    tables = _v004_tables()
    assert list(tables) == pub.RESOURCE_GRAPH
    for name, cols in tables.items():
        assert cols == [(c, pub.sql_type(t)) for c, t in rg.ARG_SCHEMAS[name]], name
        assert f"IF OBJECT_ID(N'dbo.{name}', N'U') IS NULL" in sql


def test_publish_resource_graph_onto_v004_tables_in_sqlite(tmp_path):
    conn = sqlite3.connect(":memory:")
    for name, cols in _v004_tables().items():
        conn.execute(f"CREATE TABLE [{name}] ({', '.join(f'[{c}] {t} NULL' for c, t in cols)})")
    store = LocalStore(tmp_path)
    api, _ = make_api(by_query({
        rg.TBL_AGENTS: Resp(body={"data": [agent_record()]}),
        rg.TBL_ENVIRONMENTS: Resp(body={"data": [env_record()]}),
        rg.TBL_FLOWS: Resp(body={"data": [flow_record()]}),
        rg.TBL_FOUNDRY: Resp(403, {}),
    }))
    rg.collect_resource_graph(api, store, Settings(modules=frozenset({"resourceGraph"})), today=TODAY)
    results = {r["table"]: r for r in pub.publish(conn, store, pub.RESOURCE_GRAPH)}
    assert results[rg.TBL_FOUNDRY] == {"table": rg.TBL_FOUNDRY, "skipped": True}
    assert all(not r.get("added_columns") for r in results.values())
    assert conn.execute("SELECT count(*) FROM arg_agent_config WHERE NoSignIn = 1").fetchone() == (1,)
    assert conn.execute("SELECT count(*) FROM arg_status").fetchone() == (4,)
