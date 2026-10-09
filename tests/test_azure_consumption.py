"""Offline tests for the Azure jobs' credit consumption module (Consumption Central): the drop
folder, the Studio / Viva / Azure AI collectors, publish targets and the V002 migration.

HTTP is faked at the session level; Azure SQL is stood in for by sqlite3.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import date
from pathlib import Path

import duckdb
import pytest

from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import api as api_mod
from valuelens_jobs import publish as pub
from valuelens_jobs import sql as sql_mod
from valuelens_jobs.collect import azure_ai, studio, viva
from valuelens_jobs.config import Settings
from valuelens_jobs.dropfolder import SharePointDropFolder, StoreDropFolder, open_dropfolder
from valuelens_jobs.storage import LocalStore

ROOT = Path(__file__).resolve().parents[1]
V002 = ROOT / "2. Azure" / "sql" / "migrations" / "V002__consumption.sql"
SAMPLES = ROOT / "5. Local CSV" / "Add Credit Consumption" / "sample-data"
TODAY = date(2026, 9, 10)  # snapshot month 2026-09
G = "https://graph.microsoft.com/v1.0"
SUB = "11111111-1111-1111-1111-111111111111"
PAYG_SUB = "22222222-2222-2222-2222-222222222222"


# ---------------------------------------------------------------- fakes
class Resp:
    def __init__(self, status=200, body=None, text=None, headers=None, content=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = text if text is not None else (json.dumps(body) if body is not None else "")
        self.content = content if content is not None else self.text.encode("utf-8")

    def json(self):
        return self._body


class Session:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def request(self, method, url, headers=None, timeout=None, **kw):
        self.calls.append((method, url, kw, headers))
        return self.handler(method, url, kw)


class Tokens:
    def get(self, scope, force=False):
        return f"tok-{scope}"


def make_api(handler):
    session = Session(handler)
    return api_mod.Api(Tokens(), session=session, sleep=lambda s: None), session


def no_http(method, url, kw):
    raise AssertionError(f"unexpected HTTP {method} {url}")


def write_csv(folder: Path, name: str, header: list[str], rows: list[list]) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    lines = [",".join(header)] + [",".join("" if v is None else str(v) for v in r) for r in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def table(store: LocalStore, name: str, where: str = "TRUE", order: str = "ALL"):
    path = (store.root / "curated" / name / "part-0.parquet").as_posix()
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{path}') WHERE {where} ORDER BY {order}")
    return [dict(zip(rel.columns, r)) for r in rel.fetchall()]


# ---------------------------------------------------------------- settings
def test_settings_parse_consumption_contract():
    s = Settings.from_env({
        "VALUELENS_MODULES": "core,consumption",
        "VALUELENS_AZURE_AI_SUBSCRIPTION": f" {SUB} ",
        "VALUELENS_PAYG_SUBSCRIPTIONS": f"{PAYG_SUB}, ,{SUB} ",
        "VALUELENS_DROP_SITE_ID": "contoso.sharepoint.com:/sites/Analytics",
        "VALUELENS_DROP_DRIVE_ID": "",
        "VALUELENS_DROP_FOLDER": "/Shared Documents/ValueLens/",
    })
    assert s.has("consumption")
    assert s.azure_ai_subscription == SUB
    assert s.payg_subscriptions == (PAYG_SUB, SUB)
    assert s.drop_site_id == "contoso.sharepoint.com:/sites/Analytics"
    assert s.drop_drive_id == "" and s.drop_folder == "Shared Documents/ValueLens"
    empty = Settings.from_env({})
    assert not empty.has("consumption") and empty.payg_subscriptions == () and empty.drop_site_id == ""


# ---------------------------------------------------------------- drop folder
def test_store_dropfolder_lists_direct_children_of_landing_subdir(tmp_path):
    store = LocalStore(tmp_path)
    write_csv(tmp_path / "landing" / "studio", "a.csv", ["x"], [[1]])
    write_csv(tmp_path / "landing" / "studio" / "nested", "b.csv", ["x"], [[1]])
    (tmp_path / "landing" / "flows").mkdir(parents=True)
    (tmp_path / "landing" / "flows" / "state.json").write_text("{}", encoding="utf-8")
    drop = open_dropfolder(store, Settings())
    assert isinstance(drop, StoreDropFolder)
    assert [n for n, _ in drop.list("studio")] == ["a.csv"]
    assert drop.list("viva") == []
    assert drop.read_bytes("studio", "a.csv").startswith(b"x")
    assert [p.name for p in drop.fetch("studio")] == ["a.csv"]


def _sharepoint_handler(routes):
    def handler(method, url, kw):
        assert method == "GET"
        for prefix, resp in routes.items():
            if url == prefix or url.startswith(prefix + "?"):
                return resp() if callable(resp) else resp
        raise AssertionError(f"unexpected {url}")
    return handler


def test_sharepoint_dropfolder_site_id_form_with_drive_id_pages_and_downloads(tmp_path):
    site = "contoso.sharepoint.com,1111,2222"
    children = f"{G}/drives/b!drive/root:/ValueLens/studio:/children"
    routes = {
        f"{G}/sites/{site}": Resp(200, {"id": site}),
        children: Resp(200, {"value": [{"name": "Tenant.csv", "id": "i1", "file": {}},
                                       {"name": "sub", "id": "f1", "folder": {}}],
                             "@odata.nextLink": f"{G}/next-page"}),
        f"{G}/next-page": Resp(200, {"value": [{"name": "StudioApiAgentDaily_1.csv", "id": "i2"}]}),
        f"{G}/drives/b!drive/items/i1/content": Resp(200, content=b"a,b\n1,2\n"),
        f"{G}/drives/b!drive/items/i2/content": Resp(200, content=b"c\n3\n"),
        f"{G}/drives/b!drive/root:/ValueLens/viva:/children": Resp(404, {"error": {"code": "itemNotFound"}}),
    }
    api, session = make_api(_sharepoint_handler(routes))
    s = Settings(drop_site_id=site, drop_drive_id="b!drive", drop_folder="ValueLens")
    drop = open_dropfolder(LocalStore(tmp_path), s, api)
    assert isinstance(drop, SharePointDropFolder)
    paths = drop.fetch("studio", tmp_path / "dl")
    assert sorted(p.name for p in paths) == ["StudioApiAgentDaily_1.csv", "Tenant.csv"]
    assert (tmp_path / "dl" / "studio" / "Tenant.csv").read_bytes() == b"a,b\n1,2\n"
    assert drop.list("viva") == []
    assert all(c[3]["Authorization"] == f"Bearer tok-{api_mod.GRAPH}" for c in session.calls)
    assert sum(1 for c in session.calls if c[1].startswith(f"{G}/sites/")) == 1  # resolved once


def test_sharepoint_dropfolder_path_form_resolves_library_from_folder(tmp_path):
    site_path = "contoso.sharepoint.com:/sites/Analytics"
    site_id = "contoso.sharepoint.com,aaaa,bbbb"
    routes = {
        f"{G}/sites/{site_path}": Resp(200, {"id": site_id, "webUrl": "https://contoso.sharepoint.com/sites/Analytics"}),
        f"{G}/sites/{site_id}/drives": Resp(200, {
            "value": [{"id": "b!other", "name": "Site Assets",
                       "webUrl": "https://contoso.sharepoint.com/sites/Analytics/SiteAssets"}],
            "@odata.nextLink": f"{G}/drives-page-2"}),
        f"{G}/drives-page-2": Resp(200, {"value": [
            {"id": "b!docs", "name": "Documents",
             "webUrl": "https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents"}]}),
        f"{G}/drives/b!docs/root:/ValueLens/Drop/viva:/children": Resp(200, {"value": [
            {"name": "PersonServiceCreditsMetrics.csv", "id": "v1"}]}),
    }
    api, session = make_api(_sharepoint_handler(routes))
    drop = SharePointDropFolder(api, site_path, "", "Shared Documents/ValueLens/Drop")
    assert drop.resolve() == (site_id, "b!docs", "ValueLens/Drop")
    assert [n for n, _ in drop.list("viva")] == ["PersonServiceCreditsMetrics.csv"]

    # The library can also be named by its display name, case-insensitively, at the drive root.
    routes[f"{G}/drives/b!docs/root:/studio:/children"] = Resp(200, {"value": []})
    drop = SharePointDropFolder(api, site_path, "", "documents")
    assert drop.resolve() == (site_id, "b!docs", "")
    assert drop.list("studio") == []

    with pytest.raises(ValueError, match="No document library named 'Missing'"):
        SharePointDropFolder(api, site_path, "", "Missing/ValueLens").resolve()
    with pytest.raises(ValueError, match="must start"):
        SharePointDropFolder(api, site_path, "", "").resolve()


def test_sharepoint_dropfolder_site_lookup_failure_is_an_error():
    api, _ = make_api(lambda m, u, kw: Resp(403, {"error": {"code": "accessDenied"}}))
    with pytest.raises(api_mod.HttpError, match="VALUELENS_DROP_SITE_ID"):
        SharePointDropFolder(api, "contoso.sharepoint.com,1,2", "b!d", "").list("studio")


# ---------------------------------------------------------------- studio
TENANT_HEADER = ["BillingPlan Id", "BillingPlan Name", "Environment Id", "Environment Name", "Capacity Type",
                 "Entitled Quantity", "Prepaid Consumed Quantity", "Pay as you go Consumed Quantity", "Usage Date"]
AGENT_HEADER = ["Agent Name", "Agent Id", "Product", "AI Feature/Billable Feature", "Billed credit",
                "Non-billed credit", "Channel", "Knowledge Sources", "Tool Used", "LLM Model", "Scenario Name",
                "Environment Id", "Environment Name"]
USER_HEADER = ["User Id", "User Email", "Agent Id", "Agent Name", "Billable credit used", "Credits used",
               "M365 Copilot Licensed"]
API_AGENT_HEADER = ["Usage Date", "Agent Id", "Agent Name", "Environment Id", "Environment Name", "Feature",
                    "Channel", "LLM Model", "Tool Used", "Knowledge Sources", "Billed credit", "Non-billed credit",
                    "Users"]
API_ENT_HEADER = ["Snapshot Date", "Environment Id", "Environment Name", "Environment Allocated", "Tenant Entitled",
                  "Tenant Prepaid Consumed", "Tenant PAYG Consumed"]
API_USER_HEADER = ["Usage Date", "User Id", "Environment Id", "Agent Id", "Billed credit", "Non-billed credit"]
U1 = "AAAAAAAA-0000-0000-0000-000000000001"
U2 = "aaaaaaaa-0000-0000-0000-000000000002"


def _api_files(folder: Path) -> dict:
    files = {}
    files["StudioApiAgentDaily_20260910.csv"] = write_csv(folder, "StudioApiAgentDaily_20260910.csv", API_AGENT_HEADER, [
        # Two rows for one key (August, env-1): summed credits, max users, sorted distinct lists.
        ["2026-08-05", "agent-1", "HR Bot", "env-1", "", "Classic answer", "Teams", "gpt-5", "Search", "SharePoint", 10, 1, 3],
        ["2026-08-05", "agent-1", "HR Bot", "env-1", "", "Classic answer", "Teams", "gpt-4o", "", "SharePoint", 5, 2, 7],
        ["2026-08-05", "agent-2", "IT Bot", "env-2", "Env Two", "Generative answer", "Web", "", "", "", 20, 0, 1],
        # September: the export month, so the export wins for studio_agent / studio_user.
        ["2026-09-02", "agent-1", "HR Bot", "env-1", "Env One", "Classic answer", "Teams", "gpt-5", "", "", 4, 0, 2],
    ])
    files["StudioApiEntitlement_20260910.csv"] = write_csv(folder, "StudioApiEntitlement_20260910.csv", API_ENT_HEADER, [
        ["2026-09-01", "env-1", "", 100, 1000, 10, 90],
        ["2026-09-10", "env-1", "Env One", 500, 1000, 75, 25],
        ["2026-09-10", "env-2", "Env Two", 0, 1000, 75, 25],
    ])
    files["StudioApiUserDaily_20260910.csv"] = write_csv(folder, "StudioApiUserDaily_20260910.csv", API_USER_HEADER, [
        ["2026-08-05", U1, "env-1", "agent-1", 6, 1],
        ["2026-08-05", U1.lower(), "env-1", "agent-1", 4, 0],
        ["2026-08-05", U2, "env-2", "agent-2", 20, 0],
    ])
    return files


def _export_files(folder: Path) -> dict:
    return {
        "EntitlementConsumptionTenantDetailsReport_MCSMessages_1.csv": write_csv(
            folder, "EntitlementConsumptionTenantDetailsReport_MCSMessages_1.csv", TENANT_HEADER, [
                ["plan-1", "Prepaid plan", "env-1", "Env One", "MCSMessages", 1000, 12, 3, "8/5/2026 0:00"],
            ]),
        "EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_1.csv": write_csv(
            folder, "EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_1.csv", AGENT_HEADER, [
                ["HR Bot", "agent-1", "Copilot Studio", "Classic answer", 99, 1, "Teams", "SharePoint", "", "gpt-5",
                 "", "env-1", "Env One"],
            ]),
        "EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages_1.csv": write_csv(
            folder, "EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages_1.csv", USER_HEADER, [
                ["user-x", "Alex@Contoso-Demo.com", "agent-1", "HR Bot", 50, 60, "Yes"],
            ]),
    }


def test_studio_api_rollups_and_tenant_split(tmp_path):
    store = LocalStore(tmp_path / "store")
    out = studio.ingest(store, _api_files(tmp_path / "drop"), today=TODAY)
    assert out["prepaid_share"] == 0.75

    daily = table(store, "studio_agent_daily", "usage_date = DATE '2026-08-05' AND agent_id = 'agent-1'")
    assert len(daily) == 1
    row = daily[0]
    assert (row["billed_credit"], row["non_billed_credit"], row["users"]) == (15.0, 3.0, 7.0)
    assert row["llm_model"] == "gpt-4o, gpt-5" and row["tool_used"] == "Search"
    assert row["environment_name"] == "Env One"  # filled from the entitlement file
    assert row["source_file"] == "ppac-api"

    agents = table(store, "studio_agent", order="snapshot_month, agent_id")
    assert [(a["snapshot_month"], a["agent_id"], a["billed_credit"]) for a in agents] == [
        (date(2026, 8, 1), "agent-1", 15.0), (date(2026, 8, 1), "agent-2", 20.0), (date(2026, 9, 1), "agent-1", 4.0)]
    assert all(a["product"] == "Copilot Studio" and a["scenario_name"] is None for a in agents)

    tenant = {(t["usage_date"], t["environment_id"]): t for t in table(store, "studio_tenant_daily")}
    t1 = tenant[(date(2026, 8, 5), "env-1")]
    assert t1["billing_plan_id"] == "00000000-0000-0000-0000-000000000000"
    assert t1["billing_plan_name"] == "Power Platform licensing API" and t1["capacity_type"] == "MCSMessages"
    assert t1["entitled_quantity"] == 500.0
    assert (t1["prepaid_consumed"], t1["payg_consumed"]) == (11.25, 3.75)
    assert tenant[(date(2026, 8, 5), "env-2")]["entitled_quantity"] == 0.0

    # Idempotent: re-reading the same drop folder changes nothing.
    before = {t: table(store, t) for t in ("studio_agent_daily", "studio_agent", "studio_tenant_daily")}
    studio.ingest(store, _api_files(tmp_path / "drop"), today=TODAY)
    assert {t: table(store, t) for t in before} == before


def test_studio_tenant_split_without_snapshot_or_consumption(tmp_path):
    store = LocalStore(tmp_path / "store")
    files = _api_files(tmp_path / "drop")
    files.pop("StudioApiEntitlement_20260910.csv")
    assert studio.ingest(store, files, today=TODAY)["prepaid_share"] == 1.0
    files = _api_files(tmp_path / "drop2")
    write_csv(tmp_path / "drop2", "StudioApiEntitlement_20260910.csv", API_ENT_HEADER,
              [["2026-09-10", "env-1", "Env One", 5, 0, 0, 0]])
    assert studio.ingest(LocalStore(tmp_path / "s2"), files, today=TODAY)["prepaid_share"] == 0.0


def test_studio_export_wins_over_api_by_month_and_day_env(tmp_path):
    store = LocalStore(tmp_path / "store")
    drop = tmp_path / "drop"
    studio.ingest(store, _api_files(drop), today=TODAY)
    assert any(a["snapshot_month"] == date(2026, 9, 1) for a in table(store, "studio_agent"))

    # The exports arrive later: the API rows they cover go.
    files = {**_api_files(drop), **_export_files(drop)}
    studio.ingest(store, files, today=TODAY)
    sept = table(store, "studio_agent", "snapshot_month = DATE '2026-09-01'")
    assert [(a["agent_id"], a["billed_credit"], a["source_file"]) for a in sept] == [
        ("agent-1", 99.0, "EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_1.csv")]
    assert len(table(store, "studio_agent", "snapshot_month = DATE '2026-08-01'")) == 2  # no export for August

    tenant = table(store, "studio_tenant_daily", "usage_date = DATE '2026-08-05'", "environment_id, source_file")
    assert [(t["environment_id"], t["billing_plan_id"]) for t in tenant] == [("env-1", "plan-1"),
                                                                            ("env-2", "00000000-0000-0000-0000-000000000000")]
    users = table(store, "studio_user", "snapshot_month = DATE '2026-09-01'")
    assert [(u["user_id"], u["user_email"], u["m365_copilot_licensed"]) for u in users] == [
        ("user-x", "alex@contoso-demo.com", True)]

    # Same result whichever order the files arrive in, and on every re-run.
    fresh = LocalStore(tmp_path / "fresh")
    studio.ingest(fresh, files, today=TODAY)
    for name in studio.SCHEMAS:
        assert table(fresh, name) == table(store, name), name


def test_studio_users_resolve_upns_via_graph_batch(tmp_path):
    def handler(method, url, kw):
        assert (method, url) == ("POST", studio.BATCH_URL)
        reqs = kw["json"]["requests"]
        assert len(reqs) == 1 and "id%20in%20" in reqs[0]["url"]
        return Resp(200, {"responses": [{"id": "0", "status": 200, "body": {"value": [
            {"id": U1.lower(), "userPrincipalName": "Ana@Contoso-Demo.com"}]}}]})

    api, session = make_api(handler)
    store = LocalStore(tmp_path / "store")
    out = studio.ingest(store, _api_files(tmp_path / "drop"), api=api, today=TODAY)
    assert out["upns_resolved"] == 1 and len(session.calls) == 1
    rows = table(store, "studio_user_daily", order="user_id")
    assert [(r["user_id"], r["user_upn"], r["billed_credit"]) for r in rows] == [
        (U1.lower(), "ana@contoso-demo.com", 10.0), (U2, None, 20.0)]
    users = table(store, "studio_user", order="user_id")
    assert [(u["snapshot_month"], u["user_email"], u["agent_name"], u["billable_credit_used"], u["credits_used"],
             u["m365_copilot_licensed"]) for u in users] == [
        (date(2026, 8, 1), "ana@contoso-demo.com", "HR Bot", 10.0, 11.0, None),
        (date(2026, 8, 1), None, "IT Bot", 20.0, 20.0, None)]

    # Known UPNs aren't looked up again.
    studio.ingest(store, _api_files(tmp_path / "drop"), api=api, today=TODAY)
    urls = [c[2]["json"]["requests"][0]["url"] for c in session.calls[1:]]
    assert len(urls) == 1 and U2 in urls[0] and U1.lower() not in urls[0]


def test_studio_user_lookup_failure_is_not_fatal(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(403, {"error": {"code": "Authorization_RequestDenied"}}))
    store = LocalStore(tmp_path / "store")
    out = studio.ingest(store, _api_files(tmp_path / "drop"), api=api, today=TODAY)
    assert "User.Read.All" in out["upn_lookup_error"]
    assert {r["user_upn"] for r in table(store, "studio_user_daily")} == {None}

    def boom(*a, **k):
        raise ConnectionError("network down")

    api, _ = make_api(boom)
    api.attempts = 1
    out = studio.ingest(LocalStore(tmp_path / "s2"), _api_files(tmp_path / "drop"), api=api, today=TODAY)
    assert "network down" in out["upn_lookup_error"]


def test_studio_export_missing_column_fails(tmp_path):
    bad = write_csv(tmp_path, "Tenant.csv", ["Environment Id"], [["env-1"]])
    with pytest.raises(ValueError, match="BillingPlan Id"):
        studio.ingest(LocalStore(tmp_path / "store"), {"Tenant.csv": bad}, today=TODAY)


def test_collect_studio_reads_landing_container(tmp_path):
    store = LocalStore(tmp_path)
    _export_files(tmp_path / "landing" / "studio")
    (tmp_path / "landing" / "flows").mkdir()
    (tmp_path / "landing" / "flows" / "StudioUser.csv").write_text("not,a,studio,file\n", encoding="utf-8")
    out = studio.collect_studio(None, store, Settings(), today=TODAY)
    assert out["tables"] == {"studio_tenant_daily": 1, "studio_agent": 1, "studio_user": 1}
    assert (tmp_path / "curated" / "studio_agent" / "part-0.parquet").is_file()
    assert sorted(p.name for p in (tmp_path / "landing" / "studio").iterdir()) == sorted(_export_files(tmp_path / "x"))


# ---------------------------------------------------------------- viva
VIVA_HEADER = ["PersonId", "UserPrincipalName", "ServiceId", "ServiceName", "SpendingPolicyId", "MetricDate",
               "Session count", "Spending policy limit", "Total Copilot Credits used", "User limit", "Department"]
POLICY_HEADER = ["SpendingPolicyId", "Name", "PlanLimit", "UserLimit", "IncludedServices"]


def test_viva_merge_coalesces_org_and_replaces_policies(tmp_path):
    store = LocalStore(tmp_path / "store")
    drop = tmp_path / "drop"
    first = {
        "PersonServiceCreditsMetrics_1.csv": write_csv(drop, "PersonServiceCreditsMetrics_1.csv", VIVA_HEADER, [
            ["p1", "Ana@Contoso-Demo.com", "svc", "Cowork", "pol-1", "2026-08-02", 3, 1000, 12.5, 100, "Finance"],
            ["p2", "", "svc", "Cowork", "pol-1", "2026-08-02", 1, 1000, 2, 100, "Sales"],
        ]),
        "SpendingPolicyMetadata_1.csv": write_csv(drop, "SpendingPolicyMetadata_1.csv", POLICY_HEADER, [
            ["pol-1", "Standard", 1000, 100, "Cowork"], ["pol-2", "", 0, 0, ""]]),
    }
    out = viva.ingest(store, first)
    assert out["metric_rows"] == 2 and out["policies"] == 2
    rows = table(store, "viva_credits_weekly", order="person_id")
    assert [(r["person_id"], r["user_principal_name"], r["metric_date"], r["credits_used"], r["department"])
            for r in rows] == [("ana@contoso-demo.com", "ana@contoso-demo.com", date(2026, 8, 2), 12.5, "Finance"),
                               ("p2", None, date(2026, 8, 2), 2.0, "Sales")]
    assert {p["spending_policy_id"]: p["name"] for p in table(store, "viva_spending_policy")} == {
        "pol-1": "Standard", "pol-2": "(Unassigned)"}

    # A re-export: credits updated, a blank department keeps the stored one, a new week is added,
    # and without a policy file the policy table is left as it is.
    second = {"PersonServiceCreditsMetrics_2.csv": write_csv(drop, "PersonServiceCreditsMetrics_2.csv", VIVA_HEADER, [
        ["p1", " ana@contoso-demo.com ", "svc", "Cowork", "pol-1", "2026-08-02", 4, 1000, 20, 100, ""],
        ["p1", "ana@contoso-demo.com", "svc", "Cowork", "pol-1", "2026-08-09", 1, 1000, 1, 100, "Finance"],
    ])}
    out = viva.ingest(store, second)
    assert "policies" not in out
    rows = table(store, "viva_credits_weekly", order="person_id, metric_date")
    assert [(r["person_id"], r["metric_date"], r["credits_used"], r["session_count"], r["department"])
            for r in rows] == [("ana@contoso-demo.com", date(2026, 8, 2), 20.0, 4, "Finance"),
                               ("ana@contoso-demo.com", date(2026, 8, 9), 1.0, 1, "Finance"),
                               ("p2", date(2026, 8, 2), 2.0, 1, "Sales")]
    assert len(table(store, "viva_spending_policy")) == 2

    third = {"SpendingPolicyMetadata_2.csv": write_csv(drop, "SpendingPolicyMetadata_2.csv", POLICY_HEADER,
                                                       [["pol-3", "New", 5, 5, "Cowork"]])}
    viva.ingest(store, third)
    assert [p["spending_policy_id"] for p in table(store, "viva_spending_policy")] == ["pol-3"]
    assert len(table(store, "viva_credits_weekly")) == 3


def test_viva_rejects_files_without_a_person_key(tmp_path):
    bad = write_csv(tmp_path, "PersonServiceCreditsMetrics.csv", ["ServiceId"], [["svc"]])
    with pytest.raises(ValueError, match="No person key"):
        viva.ingest(LocalStore(tmp_path / "store"), {bad.name: bad})


def test_sample_consumption_loads_every_table_with_data(tmp_path):
    from valuelens_jobs import sample

    store = LocalStore(tmp_path)
    out = sample.load_consumption(store, SAMPLES)
    assert out["studio"]["tables"]["studio_tenant_daily"] > 0 and out["viva"]["metric_rows"] > 0
    for name in ("azure_ai_spend", "azure_ai_tokens", "azure_deployment_health", "azure_solution_spend",
                 "azure_billing_reconciliation"):
        assert out[name] > 0, name
    assert sample.load_consumption(store, tmp_path / "missing") == {}


# ---------------------------------------------------------------- azure ai
def _cost_page(columns, rows):
    return Resp(200, {"properties": {"columns": [{"name": c} for c in columns], "rows": rows, "nextLink": None}})


def _arm_handler(rid, calls):
    def handler(method, url, kw):
        calls.append((method, url, kw))
        assert url.startswith("https://management.azure.com/")
        if method == "POST" and url.endswith("/query?api-version=2025-03-01"):
            body = kw["json"]
            grouping = [g["name"] for g in body["dataset"]["grouping"]]
            if grouping == ["ServiceName", "MeterCategory"]:
                return _cost_page(["Cost", "UsageQuantity", "UsageDate", "ServiceName", "MeterCategory", "Currency"],
                                  [[1.5, 3, 20260801, "Foundry Models", "Foundry Models", "USD"]])
            if grouping == ["Meter", "ResourceId"]:
                return _cost_page(["Cost", "UsageQuantity", "UsageDate", "Meter", "ResourceId", "Currency"],
                                  [[1.5, 3, 20260801, "gpt 1M input tokens", rid, "USD"]])
            if grouping == ["Meter", "serviceName"]:
                tagged = PAYG_SUB in url
                return _cost_page(["PreTaxCost", "UsageQuantity", "UsageDate", "Meter", "TagKey", "TagValue", "Currency"],
                                  [[2.0, 200, 20260802, "Pay As You Go Copilot Credit",
                                    "serviceName" if tagged else "", "cowork" if tagged else "", "USD"]])
            return Resp(204)  # solution spend / reconciliation detail: no rows
        if url.endswith("/resources"):
            return Resp(200, {"value": [{"id": rid, "tags": {"CostCenter": "Ops"}}]})
        if url.endswith("/providers/Microsoft.CognitiveServices/accounts"):
            return Resp(200, {"value": []})
        if url == f"https://management.azure.com/subscriptions/{SUB}":
            return Resp(200, {"displayName": "Demo AI"})
        raise AssertionError(f"unexpected {method} {url}")
    return handler


def test_collect_azure_ai_writes_spend_payg_and_tokens(tmp_path):
    rid = f"/subscriptions/{SUB}/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/demo-ai"
    calls = []
    api, session = make_api(_arm_handler(rid, calls))
    store = LocalStore(tmp_path)
    s = Settings(modules=frozenset({"consumption"}), azure_ai_subscription=SUB, payg_subscriptions=(PAYG_SUB, SUB))
    out = azure_ai.collect_azure_ai(api, store, s, today=TODAY)
    assert out["azure_ai_spend"] == 1 and out["copilot_payg_spend"] == 2 and out["azure_ai_tokens"] == 0
    assert all(c[3]["Authorization"] == f"Bearer tok-{api_mod.ARM}" for c in session.calls)

    def read(name):
        rel = duckdb.sql(f"SELECT * FROM read_parquet('{(tmp_path / 'raw' / name).as_posix()}/*.parquet') ORDER BY ALL")
        assert rel.columns == [c for c, _ in azure_ai.SCHEMAS[name]]
        return [dict(zip(rel.columns, r)) for r in rel.fetchall()]

    spend = read("azure_ai_spend")
    assert spend[0]["UsageDate"] == date(2026, 8, 1) and spend[0]["ResourceGroup"] == "rg-ai"
    assert spend[0]["ResourceName"] == "demo-ai" and spend[0]["DepartmentTag"] == "Ops"
    payg = read("copilot_payg_spend")
    assert [(p["SubscriptionId"], p["Product"], p["ServiceTag"], p["Cost"]) for p in payg] == [
        (SUB, "Copilot Studio", "", 2.0), (PAYG_SUB, "Cowork", "cowork", 2.0)]
    assert read("azure_ai_tokens") == []
    # PAYG subscriptions are de-duplicated; the AI subscription is always read.
    payg_urls = [u for m, u, kw in calls if m == "POST" and kw["json"]["dataset"]["grouping"][-1]["name"] == "serviceName"]
    assert len(payg_urls) == 2


def test_collect_azure_ai_strict_failure_writes_nothing(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(403, {"error": {"code": "AuthorizationFailed"}}))
    s = Settings(azure_ai_subscription=SUB)
    with pytest.raises(api_mod.HttpError, match="Cost Management Reader"):
        azure_ai.collect_azure_ai(api, LocalStore(tmp_path), s, today=TODAY)
    assert not (tmp_path / "raw").exists()
    with pytest.raises(ValueError):
        azure_ai.collect_azure_ai(api, LocalStore(tmp_path), Settings(azure_ai_subscription="not-a-guid"))


def test_arm_client_refuses_foreign_continuation_urls():
    api, _ = make_api(no_http)
    with pytest.raises(ValueError, match="Invalid ARM"):
        azure_ai.ArmClient(api).get("https://example.com/subscriptions")


# ---------------------------------------------------------------- wiring + publish
def test_collect_wiring_follows_consumption_module(tmp_path, monkeypatch):
    from valuelens_jobs.collect import audit, graph

    called = []
    for mod, name in ((graph, "collect_licensed"), (graph, "collect_org"), (graph, "collect_m365"),
                      (audit, "collect_audit"), (studio, "collect_studio"), (viva, "collect_viva"),
                      (azure_ai, "collect_azure_ai")):
        monkeypatch.setattr(mod, name, lambda *a, _n=name, **k: called.append(_n))
    store = LocalStore(tmp_path)
    jobs_main.collect(store, Settings(modules=frozenset({"core"})), api=object())
    assert called == ["collect_licensed", "collect_audit"]
    called.clear()
    jobs_main.collect(store, Settings(modules=frozenset({"consumption"})), api=object())
    assert called == ["collect_studio", "collect_viva"]
    called.clear()
    jobs_main.collect(store, Settings(modules=frozenset({"consumption"}), azure_ai_subscription=SUB), api=object())
    assert called == ["collect_studio", "collect_viva", "collect_azure_ai"]

    def boom(*a, **k):
        raise ValueError("bad drop file")

    monkeypatch.setattr(studio, "collect_studio", boom)
    called.clear()
    out = jobs_main.collect(store, Settings(modules=frozenset({"consumption"}), azure_ai_subscription=SUB), api=object())
    assert called == ["collect_viva", "collect_azure_ai"]
    assert out["errors"] == {"studio": "ValueError: bad drop file"}


def test_publish_targets_include_consumption():
    consumption = list(pub.CONSUMPTION)
    assert len(consumption) == 13 and len(set(consumption)) == 13
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core"}))) == ["curated", "licensed"]
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "consumption"}))) == [
        "curated", "licensed", *consumption]
    assert jobs_main.publish_targets(Settings(modules=frozenset({"consumption"}), sample_data=True)) == [
        "curated", "licensed", "org", *consumption]
    for name in consumption:
        t = pub.TARGETS[name]
        assert t.table == name and not t.incremental
        assert t.prefix == ("raw/" if name in azure_ai.SCHEMAS else "curated/") + name
    assert {n: pub.TARGETS[n].partition for n in consumption if pub.TARGETS[n].partition} == {
        "studio_tenant_daily": "usage_date", "studio_agent_daily": "usage_date", "studio_user_daily": "usage_date",
        "viva_credits_weekly": "metric_date"}


def _v002_tables() -> dict:
    sql = V002.read_text(encoding="utf-8")
    out = {}
    for name, body in re.findall(r"CREATE TABLE dbo\.(\w+) \((.*?)\n\);", sql, re.S):
        out[name] = [tuple(m) for m in re.findall(r"\[(\w+)\] ([A-Z]+(?:\(\d+\))?) NULL", body)]
    return out


def test_v002_matches_collector_schemas():
    sql = V002.read_text(encoding="utf-8")
    assert sql_mod.batches(sql) and [v for v, _ in sql_mod.migrations(V002.parent)][:2] == [1, 2]
    assert "WHERE version = 2)" in sql and "VALUES (2," in sql
    tables = _v002_tables()
    schemas = {**studio.SCHEMAS, **viva.SCHEMAS, **azure_ai.SCHEMAS}
    assert list(tables) == list(pub.CONSUMPTION)
    for name, cols in tables.items():
        assert cols == [(c, pub.sql_type(t)) for c, t in schemas[name]], name
        assert f"IF OBJECT_ID(N'dbo.{name}', N'U') IS NULL" in sql


def test_publish_consumption_onto_v002_tables_in_sqlite(tmp_path):
    conn = sqlite3.connect(":memory:")
    for name, cols in _v002_tables().items():
        conn.execute(f"CREATE TABLE [{name}] ({', '.join(f'[{c}] {t} NULL' for c, t in cols)})")
    store = LocalStore(tmp_path)
    studio.ingest(store, {**_api_files(tmp_path / "drop"), **_export_files(tmp_path / "drop")}, today=TODAY)
    results = {r["table"]: r for r in pub.publish(conn, store, pub.CONSUMPTION)}
    for name in ("viva_credits_weekly", "viva_spending_policy", *azure_ai.SCHEMAS):
        assert results[name] == {"table": name, "skipped": True}
    assert all(not r.get("added_columns") for r in results.values())
    assert results["studio_tenant_daily"]["days_changed"] == 2 and results["studio_tenant_daily"]["oldest_day"] is None
    assert conn.execute("SELECT count(*) FROM studio_agent").fetchone() == (3,)
    assert conn.execute("SELECT count(*) FROM studio_user_daily").fetchone() == (2,)
    again = {r["table"]: r for r in pub.publish(conn, store, pub.CONSUMPTION)}
    assert again["studio_tenant_daily"]["days_changed"] == 0
