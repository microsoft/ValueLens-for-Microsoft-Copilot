"""Offline tests for the Azure jobs' credit consumption module (Consumption Central): the drop
folder, the Studio / Viva / Azure AI collectors, publish targets and the V002 migration.

HTTP is faked at the session level; Azure SQL is stood in for by sqlite3.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import date, datetime, timedelta, timezone
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


def utc(*when) -> float:
    return datetime(*when, tzinfo=timezone.utc).timestamp()


# When the drop folder's files were uploaded, unless a test says otherwise: in TODAY's month, so a Studio
# per-agent or per-user export counts as that month's.
UPLOADED = utc(2026, 9, 5, 12)


def csv_text(header: list[str], rows: list[list]) -> str:
    lines = [",".join(header)] + [",".join("" if v is None else str(v) for v in r) for r in rows]
    return "\n".join(lines) + "\n"


def write_csv(folder: Path, name: str, header: list[str], rows: list[list], uploaded: float | None = UPLOADED) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text(csv_text(header, rows), encoding="utf-8")
    if uploaded is not None:
        os.utime(path, (uploaded, uploaded))
    return path


def table(store: LocalStore, name: str, where: str = "TRUE", order: str = "ALL"):
    path = (store.root / "curated" / name / "part-0.parquet").as_posix()
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{path}') WHERE {where} ORDER BY {order}")
    return [dict(zip(rel.columns, r)) for r in rel.fetchall()]


def pick(store: LocalStore, name: str, cols: list[str], where: str = "TRUE") -> list[tuple]:
    return [tuple(r[c] for c in cols) for r in table(store, name, where, ", ".join(cols))]


def seed(store: LocalStore, name: str, rows: list[dict]) -> None:
    """Stores `rows` as the Studio table `name`, as an earlier version left it; columns not given are NULL."""
    cols = studio.SCHEMAS[name]
    columns = ", ".join(f'"{c}" {t}' for c, t in cols)
    con = duckdb.connect()
    con.execute(f"CREATE TABLE t ({columns})")
    con.executemany(f"INSERT INTO t VALUES ({', '.join('?' for _ in cols)})",
                    [[r.get(c) for c, _ in cols] for r in rows])
    target = store.root / "curated" / name / "part-0.parquet"
    target.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY t TO '{target.as_posix()}' (FORMAT PARQUET)")
    con.close()


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


def test_dropfolder_list_and_fetch_still_skip_the_backfill_folder(tmp_path):
    # The other collectors read only the files directly in their folder, on both drop folders.
    write_csv(tmp_path / "landing" / "studio", "a.csv", ["x"], [[1]])
    write_csv(tmp_path / "landing" / "studio" / "backfill" / "2026-08", "c.csv", ["x"], [[1]])
    drop = StoreDropFolder(LocalStore(tmp_path))
    assert [n for n, _ in drop.list("studio")] == ["a.csv"]
    assert [p.name for p in drop.fetch("studio")] == ["a.csv"]

    site = "contoso.sharepoint.com,1111,2222"
    routes = {
        f"{G}/sites/{site}": Resp(200, {"id": site}),
        f"{G}/drives/b!drive/root:/ValueLens/studio:/children": Resp(200, {"value": [
            {"name": "a.csv", "id": "i1", "file": {}, "lastModifiedDateTime": "2026-09-05T12:00:00Z"},
            {"name": "backfill", "id": "bf", "folder": {"childCount": 1}}]}),
        f"{G}/drives/b!drive/items/i1/content": Resp(200, content=b"x\n1\n"),
    }
    api, session = make_api(_sharepoint_handler(routes))
    drop = SharePointDropFolder(api, site, "b!drive", "ValueLens")
    assert [n for n, _ in drop.list("studio")] == ["a.csv"]
    assert [p.name for p in drop.fetch("studio", tmp_path / "dl")] == ["a.csv"]
    assert not any("/items/bf" in c[1] for c in session.calls)


def test_store_dropfolder_fetch_tree_reads_one_folder_two_levels_down(tmp_path):
    folder = tmp_path / "landing" / "studio"
    write_csv(folder, "a.csv", ["x"], [[1]])
    write_csv(folder / "backfill", "stray.csv", ["x"], [[1]], uploaded=utc(2026, 8, 1))
    write_csv(folder / "backfill" / "2026-08", "c.csv", ["x"], [[1]], uploaded=utc(2026, 8, 2))
    write_csv(folder / "backfill" / "2026-08" / "old", "d.csv", ["x"], [[1]])
    write_csv(folder / "archive", "e.csv", ["x"], [[1]])
    tree = StoreDropFolder(LocalStore(tmp_path)).fetch_tree("studio", nested="backfill")
    assert tree.root == "landing/studio"
    # The upload time is the blob's, which pull stamps on the local copy.
    assert [(f.rel, f.uploaded) for f in tree.files] == [
        ("a.csv", UPLOADED), ("backfill/2026-08/c.csv", utc(2026, 8, 2)), ("backfill/stray.csv", utc(2026, 8, 1))]
    assert tree.files[0].path == folder / "a.csv"
    assert tree.folders == ("backfill", "backfill/2026-08", "backfill/2026-08/old")


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


def _agent(agent_id: str, billed) -> list:
    """A per-agent export row: Classic answer, Teams, env-1."""
    return ["HR Bot", agent_id, "Copilot Studio", "Classic answer", billed, 0, "Teams", "", "", "", "", "env-1",
            "Env One"]


def _user(user_id: str, billed) -> list:
    """A per-user export row for agent-1."""
    return [user_id, f"{user_id}@contoso-demo.com", "agent-1", "HR Bot", billed, billed, "Yes"]


def _day(day: str, prepaid, env: str = "env-1") -> list:
    """A tenant export row for plan-1 on `day` (M/D) 2026."""
    return ["plan-1", "Prepaid plan", env, "Env One", "MCSMessages", 1000, prepaid, 0, f"{day}/2026 0:00"]


def _api_day(day: str, billed, env: str = "env-1") -> list:
    """A flow row (StudioApiAgentDaily) for agent-1 on `day` (YYYY-MM-DD)."""
    return [day, "agent-1", "HR Bot", env, "", "Classic answer", "Teams", "", "", "", billed, 0, 1]


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


def test_studio_export_without_its_key_columns_is_skipped_with_a_warning(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.studio")
    bad = write_csv(tmp_path, "Tenant.csv", ["Environment Id"], [["env-1"]])
    out = studio.ingest(LocalStore(tmp_path / "store"), {"Tenant.csv": bad}, today=TODAY)
    assert out["tables"] == {}
    assert ("studio/Tenant.csv: skipped as the tenant export, missing column(s): Usage Date, BillingPlan Id, "
            "Capacity Type") in caplog.text
    assert "no tenant export - skipping" in caplog.text

    # A file with its export's key columns is read, so any other column that export needs is still required.
    agent = write_csv(tmp_path, "PerAgent.csv", AGENT_HEADER[1:], [_agent("agent-1", 1)[1:]])
    with pytest.raises(ValueError, match="no column 'Agent Name'"):
        studio.ingest(LocalStore(tmp_path / "store2"), {"PerAgent.csv": agent}, today=TODAY)


def test_studio_per_agent_and_per_user_exports_load_without_a_tenant_export(tmp_path, caplog):
    # Their names contain "Tenant", so *Tenant*.csv matches them; the header check keeps them out of the tenant load.
    caplog.set_level("INFO", logger="valuelens_jobs.collect.studio")
    files = _export_files(tmp_path / "drop")
    files.pop("EntitlementConsumptionTenantDetailsReport_MCSMessages_1.csv")
    store = LocalStore(tmp_path / "store")
    out = studio.ingest(store, files, today=TODAY)
    assert out["tables"] == {"studio_agent": 1, "studio_user": 1}
    assert ("studio/EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages_1.csv: skipped as the tenant "
            "export, missing column(s): Usage Date, BillingPlan Id, Capacity Type") in caplog.text
    assert ("studio/EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages_1.csv: skipped as the tenant "
            "export, missing column(s): Usage Date, Environment Id, BillingPlan Id, Capacity Type") in caplog.text
    assert pick(store, "studio_agent", ["snapshot_month", "agent_id", "billed_credit"]) == [
        (date(2026, 9, 1), "agent-1", 99.0)]

    # A per-user export whose name matches *Agent*.csv is read as the per-user export only.
    users = write_csv(tmp_path / "drop2", "AgentUsers.csv", USER_HEADER, [_user("user-x", 5)])
    out = studio.ingest(LocalStore(tmp_path / "s2"), {"AgentUsers.csv": users}, today=TODAY)
    assert out["tables"] == {"studio_user": 1}
    assert ("studio/AgentUsers.csv: skipped as the per-agent export, missing column(s): AI Feature/Billable "
            "Feature, Channel, Environment Id") in caplog.text


def test_collect_studio_reads_landing_container(tmp_path):
    store = LocalStore(tmp_path)
    _export_files(tmp_path / "landing" / "studio")
    (tmp_path / "landing" / "flows").mkdir()
    (tmp_path / "landing" / "flows" / "StudioUser.csv").write_text("not,a,studio,file\n", encoding="utf-8")
    out = studio.collect_studio(None, store, Settings(), today=TODAY)
    assert out["tables"] == {"studio_tenant_daily": 1, "studio_agent": 1, "studio_user": 1}
    assert (tmp_path / "curated" / "studio_agent" / "part-0.parquet").is_file()
    assert sorted(p.name for p in (tmp_path / "landing" / "studio").iterdir()) == sorted(_export_files(tmp_path / "x"))


def test_collect_studio_counts_each_export_as_the_month_it_was_uploaded(tmp_path):
    # The month is UTC's: one minute either side of midnight on 1 September.
    folder = tmp_path / "landing" / "studio"
    write_csv(folder, "PerAgent_aug.csv", AGENT_HEADER, [_agent("agent-1", 8)], uploaded=utc(2026, 8, 31, 23, 59))
    write_csv(folder, "PerAgent_sep.csv", AGENT_HEADER, [_agent("agent-1", 9)], uploaded=utc(2026, 9, 1, 0, 1))
    write_csv(folder, "PerUser_aug.csv", USER_HEADER, [_user("user-x", 2)], uploaded=utc(2026, 8, 2))
    write_csv(folder, "PerUser_sep.csv", USER_HEADER, [_user("user-x", 9)], uploaded=utc(2026, 9, 9))
    store = LocalStore(tmp_path)
    out = studio.collect_studio(None, store, Settings(), today=TODAY)
    assert out["files"] == 4 and out["tables"] == {"studio_agent": 2, "studio_user": 2}
    assert pick(store, "studio_agent", ["snapshot_month", "agent_id", "billed_credit", "source_file"]) == [
        (date(2026, 8, 1), "agent-1", 8.0, "PerAgent_aug.csv"), (date(2026, 9, 1), "agent-1", 9.0, "PerAgent_sep.csv")]
    assert pick(store, "studio_user", ["snapshot_month", "user_id", "billable_credit_used", "source_file"]) == [
        (date(2026, 8, 1), "user-x", 2.0, "PerUser_aug.csv"), (date(2026, 9, 1), "user-x", 9.0, "PerUser_sep.csv")]


def test_collect_studio_reads_sharepoint_upload_months_and_backfill(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.studio")
    site, items = "contoso.sharepoint.com,1111,2222", f"{G}/drives/b!drive/items"
    content = {f"a{n}": csv_text(AGENT_HEADER, [_agent("agent-1", n)]) for n in (7, 8, 9)}
    content["u9"] = csv_text(USER_HEADER, [_user("user-x", 9)])
    routes = {
        f"{G}/sites/{site}": Resp(200, {"id": site}),
        f"{G}/drives/b!drive/root:/ValueLens/studio:/children": Resp(200, {"value": [
            {"name": "PerAgent_aug.csv", "id": "a8", "file": {}, "lastModifiedDateTime": "2026-08-31T23:59:00Z"},
            {"name": "backfill", "id": "bf", "folder": {"childCount": 1}},
            {"name": "archive", "id": "ar", "folder": {"childCount": 1}}],
            "@odata.nextLink": f"{G}/studio-page-2"}),
        f"{G}/studio-page-2": Resp(200, {"value": [
            {"name": "PerAgent_sep.csv", "id": "a9", "file": {}, "lastModifiedDateTime": "2026-09-01T00:01:00Z"},
            {"name": "PerUser.csv", "id": "u9", "file": {}}]}),
        f"{items}/bf/children": Resp(200, {"value": [{"name": "2026-07", "id": "m7", "folder": {"childCount": 2}}]}),
        f"{items}/m7/children": Resp(200, {"value": [
            # Uploaded in September, but its folder makes it July's.
            {"name": "PerAgent_jul.csv", "id": "a7", "file": {}, "lastModifiedDateTime": "2026-09-03T08:00:00Z"},
            {"name": "old", "id": "old", "folder": {"childCount": 1}}]}),
        f"{G}/drives/b!drive/root:/ValueLens/viva:/children": Resp(404, {"error": {"code": "itemNotFound"}}),
        **{f"{items}/{i}/content": Resp(200, content=body.encode()) for i, body in content.items()},
    }
    api, session = make_api(_sharepoint_handler(routes))
    store = LocalStore(tmp_path / "store")
    s = Settings(drop_site_id=site, drop_drive_id="b!drive", drop_folder="ValueLens")
    out = studio.collect_studio(api, store, s, today=TODAY)
    assert out["files"] == 4
    assert pick(store, "studio_agent", ["snapshot_month", "billed_credit"]) == [
        (date(2026, 7, 1), 7.0), (date(2026, 8, 1), 8.0), (date(2026, 9, 1), 9.0)]
    assert pick(store, "studio_user", ["snapshot_month", "user_id"]) == [(date(2026, 9, 1), "user-x")]
    assert "ValueLens/studio/PerUser.csv: no upload time, so it counts as this month, 2026-09" in caplog.text
    assert "ValueLens/studio/backfill/2026-07/old: a folder inside a month folder isn't read" in caplog.text
    assert not any(f"{items}/ar/" in c[1] or f"{items}/old/" in c[1] for c in session.calls)

    drop = SharePointDropFolder(api, site, "b!drive", "ValueLens")
    tree = drop.fetch_tree("studio", tmp_path / "dl", nested="backfill")
    assert tree.root == "ValueLens/studio"
    assert tree.folders == ("backfill", "backfill/2026-07", "backfill/2026-07/old")
    assert [(f.rel, f.uploaded) for f in tree.files] == [
        ("PerAgent_aug.csv", utc(2026, 8, 31, 23, 59)), ("PerAgent_sep.csv", utc(2026, 9, 1, 0, 1)),
        ("PerUser.csv", None), ("backfill/2026-07/PerAgent_jul.csv", utc(2026, 9, 3, 8))]
    jul = tree.files[-1].path
    assert jul == tmp_path / "dl" / "studio" / "backfill" / "2026-07" / "PerAgent_jul.csv"
    assert jul.read_bytes() == content["a7"].encode() and jul.stat().st_mtime == utc(2026, 9, 3, 8)
    empty = drop.fetch_tree("viva", tmp_path / "dl", nested="backfill")
    assert (empty.root, empty.files, empty.folders) == ("ValueLens/viva", (), ())


def test_studio_newest_export_wins_each_key(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.studio")
    drop = tmp_path / "drop"
    files = {
        "PerAgent_a.csv": write_csv(drop, "PerAgent_a.csv", AGENT_HEADER, [_agent("agent-1", 30)],
                                    uploaded=utc(2026, 9, 8)),
        "PerAgent_b.csv": write_csv(drop, "PerAgent_b.csv", AGENT_HEADER, [_agent("agent-1", 10), _agent("agent-2", 5)],
                                    uploaded=utc(2026, 9, 2)),
        # Uploaded at the same moment: the name decides.
        "PerUser_y.csv": write_csv(drop, "PerUser_y.csv", USER_HEADER, [_user("user-x", 1)], uploaded=utc(2026, 9, 4)),
        "PerUser_z.csv": write_csv(drop, "PerUser_z.csv", USER_HEADER, [_user("user-x", 2), _user("user-x", 3)],
                                   uploaded=utc(2026, 9, 4)),
    }
    store = LocalStore(tmp_path / "store")
    studio.ingest(store, files, today=TODAY)
    assert pick(store, "studio_agent", ["agent_id", "billed_credit", "source_file"]) == [
        ("agent-1", 30.0, "PerAgent_a.csv"), ("agent-2", 5.0, "PerAgent_b.csv")]
    # Rows that share a key within one file all stay, as the merge keeps them.
    assert pick(store, "studio_user", ["user_id", "billable_credit_used", "source_file"]) == [
        ("user-x", 2.0, "PerUser_z.csv"), ("user-x", 3.0, "PerUser_z.csv")]
    assert "row(s) replaced by a newer export" in caplog.text

    before = {t: table(store, t) for t in ("studio_agent", "studio_user")}
    studio.ingest(store, files, today=TODAY)
    assert {t: table(store, t) for t in before} == before


def test_studio_overlapping_tenant_exports_count_each_day_once(tmp_path):
    drop = tmp_path / "drop"
    files = {
        "Tenant_1.csv": write_csv(drop, "Tenant_1.csv", TENANT_HEADER, [_day("8/4", 12), _day("8/5", 6)],
                                  uploaded=utc(2026, 8, 6)),
        "Tenant_2.csv": write_csv(drop, "Tenant_2.csv", TENANT_HEADER, [_day("8/5", 7), _day("8/6", 5)],
                                  uploaded=utc(2026, 9, 1)),
    }
    store = LocalStore(tmp_path / "store")
    studio.ingest(store, files, today=TODAY)
    assert pick(store, "studio_tenant_daily", ["usage_date", "prepaid_consumed", "source_file"]) == [
        (date(2026, 8, 4), 12.0, "Tenant_1.csv"), (date(2026, 8, 5), 7.0, "Tenant_2.csv"),
        (date(2026, 8, 6), 5.0, "Tenant_2.csv")]


def test_collect_studio_reads_backfill_month_folders(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.studio")
    folder = tmp_path / "landing" / "studio"
    write_csv(folder, "PerAgent.csv", AGENT_HEADER, [_agent("agent-1", 20)])
    write_csv(folder / "backfill" / "2026-07", "PerAgent.csv", AGENT_HEADER, [_agent("agent-1", 7)],
              uploaded=utc(2026, 9, 6))
    write_csv(folder / "backfill" / "2026-08", "Users.csv", USER_HEADER, [_user("user-x", 8)])
    # Never read: the flow's files in backfill/, other folders, and a folder inside a month folder.
    write_csv(folder / "backfill" / "2026-07", "StudioApiUserDaily_1.csv", API_USER_HEADER,
              [["2026-07-02", "user-y", "env-1", "agent-1", 70, 0]])
    write_csv(folder / "archive", "PerAgent_old.csv", AGENT_HEADER, [_agent("agent-9", 1)])
    write_csv(folder / "backfill" / "2026-07" / "old", "PerAgent_old.csv", AGENT_HEADER, [_agent("agent-9", 1)])
    store = LocalStore(tmp_path)
    out = studio.collect_studio(None, store, Settings(), today=TODAY)
    assert out["files"] == 4 and out["tables"] == {"studio_agent": 2, "studio_user": 1}
    assert pick(store, "studio_agent", ["snapshot_month", "agent_id", "billed_credit", "source_file"]) == [
        (date(2026, 7, 1), "agent-1", 7.0, "PerAgent.csv"), (date(2026, 9, 1), "agent-1", 20.0, "PerAgent.csv")]
    assert pick(store, "studio_user", ["snapshot_month", "user_id", "billable_credit_used"]) == [
        (date(2026, 8, 1), "user-x", 8.0)]
    assert "landing/studio/backfill/2026-07/old: a folder inside a month folder isn't read" in caplog.text


@pytest.mark.parametrize("bad, problem", [
    ("backfill/stray.csv", "backfill/stray.csv: a file outside a month folder"),
    ("backfill/July/a.csv", "backfill/July: the folder name isn't a month (YYYY-MM)"),
    ("backfill/2026-13/a.csv", "backfill/2026-13: the folder name isn't a month (YYYY-MM)"),
    ("backfill/2026-10/a.csv", "backfill/2026-10: a month after this one (2026-09)"),
], ids=["file-in-backfill", "not-a-month", "month-13", "future-month"])
def test_collect_studio_stops_on_a_misplaced_backfill_export_and_writes_nothing(tmp_path, bad, problem):
    folder = tmp_path / "landing" / "studio"
    _api_files(folder)
    _export_files(folder)
    store = LocalStore(tmp_path)
    studio.collect_studio(None, store, Settings(), today=TODAY)
    before = {p: p.read_bytes() for p in (tmp_path / "curated").rglob("*.parquet")}
    assert len(before) == 5

    target = folder / bad
    write_csv(target.parent, target.name, AGENT_HEADER, [_agent("agent-1", 1)])
    with pytest.raises(ValueError) as err:
        studio.collect_studio(None, store, Settings(), today=TODAY)
    assert str(err.value) == f"{studio.STOP}\n  landing/studio/{problem}"
    assert {p: p.read_bytes() for p in (tmp_path / "curated").rglob("*.parquet")} == before


def test_collect_studio_stop_lists_every_problem(tmp_path):
    folder = tmp_path / "landing" / "studio"
    for rel in ("backfill/stray.csv", "backfill/notes.txt", "backfill/July/a.csv", "backfill/2026-13/a.csv",
                "backfill/2026-10/a.csv", "backfill/2026-08/a.csv"):
        target = folder / rel
        write_csv(target.parent, target.name, AGENT_HEADER, [_agent("agent-1", 1)])
    with pytest.raises(ValueError) as err:
        studio.collect_studio(None, LocalStore(tmp_path), Settings(), today=TODAY)
    assert str(err.value).splitlines() == [studio.STOP] + [f"  landing/studio/backfill/{p}" for p in (
        "2026-10: a month after this one (2026-09)", "2026-13: the folder name isn't a month (YYYY-MM)",
        "July: the folder name isn't a month (YYYY-MM)", "notes.txt: a file outside a month folder",
        "stray.csv: a file outside a month folder")]
    assert not (tmp_path / "curated").exists()


def test_a_backfill_stop_fails_the_studio_collector_and_the_others_still_run(tmp_path, monkeypatch):
    write_csv(tmp_path / "landing" / "studio" / "backfill", "stray.csv", AGENT_HEADER, [_agent("agent-1", 1)])
    ran = []
    monkeypatch.setattr(viva, "collect_viva", lambda api, store, settings: ran.append("viva") or {})
    out = jobs_main.collect(LocalStore(tmp_path), Settings(modules=frozenset({"consumption"})), api=object())
    assert out["errors"]["studio"].startswith("ValueError: Nothing was written. Each export in backfill/ goes in")
    assert "\n  landing/studio/backfill/stray.csv: a file outside a month folder" in out["errors"]["studio"]
    assert ran == ["viva"] and "studio" not in out
    assert not (tmp_path / "curated").exists()


def test_studio_export_with_no_environment_still_covers_its_day(tmp_path):
    drop = tmp_path / "drop"
    files = {
        "Tenant.csv": write_csv(drop, "Tenant.csv", TENANT_HEADER, [_day("8/5", 12, env="")]),
        "StudioApiAgentDaily_1.csv": write_csv(drop, "StudioApiAgentDaily_1.csv", API_AGENT_HEADER, [
            _api_day("2026-08-05", 10, env=""), _api_day("2026-08-06", 4, env="")]),
    }
    store = LocalStore(tmp_path / "store")
    studio.ingest(store, files, today=TODAY)
    # The export's day isn't counted again from the flow's figures: the match on the environment is null-safe.
    assert pick(store, "studio_tenant_daily", ["usage_date", "environment_id", "prepaid_consumed", "source_file"]) == [
        (date(2026, 8, 5), None, 12.0, "Tenant.csv"), (date(2026, 8, 6), None, 4.0, "ppac-api")]


def test_studio_export_with_no_upload_time_counts_as_the_run_month(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.studio")
    path = write_csv(tmp_path / "drop", "PerAgent.csv", AGENT_HEADER, [_agent("agent-1", 7)], uploaded=utc(2026, 7, 15))
    store = LocalStore(tmp_path / "store")
    studio.ingest(store, {"PerAgent.csv": path}, today=TODAY, uploaded={"PerAgent.csv": None})
    assert pick(store, "studio_agent", ["snapshot_month", "agent_id"]) == [(date(2026, 9, 1), "agent-1")]
    assert "studio/PerAgent.csv: no upload time, so it counts as this month, 2026-09" in caplog.text

    # Without `uploaded`, the local copy's modified time is the upload time.
    fresh = LocalStore(tmp_path / "fresh")
    studio.ingest(fresh, {"PerAgent.csv": path}, today=TODAY)
    assert pick(fresh, "studio_agent", ["snapshot_month", "agent_id"]) == [(date(2026, 7, 1), "agent-1")]


def test_studio_first_run_after_updating_from_an_earlier_version(tmp_path, caplog):
    """Earlier versions counted every per-agent and per-user export in the folder as the month the job ran, on
    every run. This seeds the tables as they left them after runs in July, August and September."""
    caplog.set_level("INFO", logger="valuelens_jobs.collect.studio")
    jul, aug, sep, oct_ = (date(2026, m, 1) for m in (7, 8, 9, 10))
    july, august = utc(2026, 7, 3), utc(2026, 8, 4)
    folder = tmp_path / "landing" / "studio"
    write_csv(folder, "Tenant_jul.csv", TENANT_HEADER, [_day("7/1", 5), _day("7/2", 6)], uploaded=july)
    write_csv(folder, "Tenant_aug.csv", TENANT_HEADER, [_day("7/2", 7), _day("8/3", 8)], uploaded=august)
    write_csv(folder, "PerAgent_jul.csv", AGENT_HEADER, [_agent("agent-1", 10), _agent("agent-2", 20)], uploaded=july)
    write_csv(folder, "PerAgent_aug.csv", AGENT_HEADER, [_agent("agent-1", 11), _agent("agent-3", 30)], uploaded=august)
    write_csv(folder, "PerUser_jul.csv", USER_HEADER, [_user("user-x", 1), _user("user-y", 2)], uploaded=july)
    write_csv(folder, "PerUser_aug.csv", USER_HEADER, [_user("user-x", 3), _user("user-z", 4)], uploaded=august)
    write_csv(folder, "StudioApiAgentDaily_1.csv", API_AGENT_HEADER, [_api_day("2026-09-02", 4)])
    write_csv(folder, "StudioApiUserDaily_1.csv", API_USER_HEADER, [["2026-09-02", "user-x", "env-1", "agent-1", 4, 0]])

    store = LocalStore(tmp_path)
    seed(store, "studio_tenant_daily", [
        {"usage_date": day, "environment_id": "env-1", "billing_plan_id": "plan-1", "capacity_type": "MCSMessages",
         "prepaid_consumed": value, "source_file": name}
        for day, value, name in ((date(2026, 7, 1), 5.0, "Tenant_jul.csv"), (date(2026, 7, 2), 6.0, "Tenant_jul.csv"),
                                 (date(2026, 7, 2), 7.0, "Tenant_aug.csv"), (date(2026, 8, 3), 8.0, "Tenant_aug.csv"))])
    agents_jul = [("agent-1", 10.0, "PerAgent_jul.csv"), ("agent-2", 20.0, "PerAgent_jul.csv")]
    agents_aug = [("agent-1", 11.0, "PerAgent_aug.csv"), ("agent-3", 30.0, "PerAgent_aug.csv")]
    seed(store, "studio_agent", [
        {"snapshot_month": month, "agent_id": agent, "billable_feature": "Classic answer", "channel": "Teams",
         "environment_id": "env-1", "billed_credit": billed, "source_file": name}
        for month, rows in ((jul, agents_jul), (aug, agents_jul + agents_aug), (sep, agents_jul + agents_aug))
        for agent, billed, name in rows])
    users_jul = [("user-x", 1.0, "PerUser_jul.csv"), ("user-y", 2.0, "PerUser_jul.csv")]
    users_aug = [("user-x", 3.0, "PerUser_aug.csv"), ("user-z", 4.0, "PerUser_aug.csv")]
    seed(store, "studio_user", [
        {"snapshot_month": month, "user_id": user, "agent_id": "agent-1", "billable_credit_used": billed,
         "source_file": name}
        for month, rows in ((jul, users_jul), (aug, users_jul + users_aug), (sep, users_jul + users_aug))
        for user, billed, name in rows])

    studio.collect_studio(None, store, Settings(), today=TODAY)
    # Tenant: each day in an export still in the folder is rewritten from the newest export that has it.
    assert pick(store, "studio_tenant_daily", ["usage_date", "prepaid_consumed", "source_file"]) == [
        (date(2026, 7, 1), 5.0, "Tenant_jul.csv"), (date(2026, 7, 2), 7.0, "Tenant_aug.csv"),
        (date(2026, 8, 3), 8.0, "Tenant_aug.csv"), (date(2026, 9, 2), 4.0, "ppac-api")]
    agent_cols = ["snapshot_month", "agent_id", "billed_credit", "source_file"]
    agents = [
        (jul, "agent-1", 10.0, "PerAgent_jul.csv"), (jul, "agent-2", 20.0, "PerAgent_jul.csv"),
        # August's own export replaces the copies it has a row for; agent-2, which it doesn't list, keeps July's copy.
        (aug, "agent-1", 11.0, "PerAgent_aug.csv"), (aug, "agent-2", 20.0, "PerAgent_jul.csv"),
        (aug, "agent-3", 30.0, "PerAgent_aug.csv"),
        # September has no export of its own, so it keeps every copy, and the flow's figures don't replace them.
        (sep, "agent-1", 10.0, "PerAgent_jul.csv"), (sep, "agent-1", 11.0, "PerAgent_aug.csv"),
        (sep, "agent-2", 20.0, "PerAgent_jul.csv"), (sep, "agent-3", 30.0, "PerAgent_aug.csv")]
    assert pick(store, "studio_agent", agent_cols) == agents
    user_cols = ["snapshot_month", "user_id", "billable_credit_used", "source_file"]
    users = [
        (jul, "user-x", 1.0, "PerUser_jul.csv"), (jul, "user-y", 2.0, "PerUser_jul.csv"),
        (aug, "user-x", 3.0, "PerUser_aug.csv"), (aug, "user-y", 2.0, "PerUser_jul.csv"),
        (aug, "user-z", 4.0, "PerUser_aug.csv"),
        (sep, "user-x", 1.0, "PerUser_jul.csv"), (sep, "user-x", 3.0, "PerUser_aug.csv"),
        (sep, "user-y", 2.0, "PerUser_jul.csv"), (sep, "user-z", 4.0, "PerUser_aug.csv")]
    assert pick(store, "studio_user", user_cols) == users
    assert "2026-09: an export covers this month, so the API figures aren't used" in caplog.text

    # From the next month on, the flow's figures apply; the exports keep their months.
    write_csv(folder, "StudioApiAgentDaily_2.csv", API_AGENT_HEADER, [_api_day("2026-10-02", 5)])
    write_csv(folder, "StudioApiUserDaily_2.csv", API_USER_HEADER, [["2026-10-02", "user-x", "env-1", "agent-1", 5, 0]])
    studio.collect_studio(None, store, Settings(), today=date(2026, 10, 10))
    assert pick(store, "studio_agent", agent_cols) == agents + [(oct_, "agent-1", 5.0, "ppac-api")]
    assert pick(store, "studio_user", user_cols) == users + [(oct_, "user-x", 5.0, "ppac-api")]


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


def _arm_handler(rid, calls, windowed=False):
    """Fake ARM. Cost rows are on 1 and 2 Aug, or with `windowed` on the query's first two days."""
    def handler(method, url, kw):
        calls.append((method, url, kw))
        assert url.startswith("https://management.azure.com/")
        if method == "POST" and url.endswith("/query?api-version=2025-03-01"):
            body = kw["json"]
            first = date.fromisoformat(body["timePeriod"]["from"][:10]) if windowed else date(2026, 8, 1)
            spend_day, payg_day = (int(f"{d:%Y%m%d}") for d in (first, first + timedelta(days=1)))
            grouping = [g["name"] for g in body["dataset"]["grouping"]]
            if grouping == ["ServiceName", "MeterCategory"]:
                return _cost_page(["Cost", "UsageQuantity", "UsageDate", "ServiceName", "MeterCategory", "Currency"],
                                  [[1.5, 3, spend_day, "Foundry Models", "Foundry Models", "USD"]])
            if grouping == ["Meter", "ResourceId"]:
                return _cost_page(["Cost", "UsageQuantity", "UsageDate", "Meter", "ResourceId", "Currency"],
                                  [[1.5, 3, spend_day, "gpt 1M input tokens", rid, "USD"]])
            if grouping == ["Meter", "serviceName"]:
                tagged = PAYG_SUB in url
                return _cost_page(["PreTaxCost", "UsageQuantity", "UsageDate", "Meter", "TagKey", "TagValue", "Currency"],
                                  [[2.0, 200, payg_day, "Pay As You Go Copilot Credit",
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


AI_RID = f"/subscriptions/{SUB}/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/demo-ai"


def _run_azure_ai(store, today, handler=None):
    api, _ = make_api(handler or _arm_handler(AI_RID, [], windowed=True))
    s = Settings(modules=frozenset({"consumption"}), azure_ai_subscription=SUB, payg_subscriptions=(PAYG_SUB,))
    return azure_ai.collect_azure_ai(api, store, s, today=today)


def _raw(store, name, columns):
    path = (store.root / "raw" / name).as_posix()
    rows = duckdb.sql(f"SELECT {columns} FROM read_parquet('{path}/*.parquet') ORDER BY ALL").fetchall()
    return [r[0] if len(r) == 1 else r for r in rows]


def _health_row(metric_date, snapshot_date, name):
    return {"MetricDate": metric_date, "SnapshotDate": snapshot_date, "DeploymentName": name}


def _recon_row(first, last, pool):
    return {"Period": f"{first:%Y-%m}", "PeriodStart": first, "PeriodEnd": last, "PoolName": pool}


def test_azure_ai_reload_keeps_older_rows(tmp_path):
    store = LocalStore(tmp_path)
    assert _run_azure_ai(store, TODAY)["azure_ai_spend"] == 1  # window from 12 June
    for _ in range(2):  # window from 17 June; a rerun replaces it again rather than adding to it
        out = _run_azure_ai(store, TODAY + timedelta(days=5))
        assert out["azure_ai_spend"] == 2 and out["copilot_payg_spend"] == 4
    assert _raw(store, "azure_ai_spend", "UsageDate") == [date(2026, 6, 12), date(2026, 6, 17)]
    assert _raw(store, "copilot_payg_spend", "UsageDate") == [date(2026, 6, 13)] * 2 + [date(2026, 6, 18)] * 2
    assert store.list("raw/azure_ai_spend") == ["raw/azure_ai_spend/part-0.parquet"]


def test_azure_ai_empty_strict_result_replaces_its_window(tmp_path):
    store = LocalStore(tmp_path)
    _run_azure_ai(store, TODAY)
    _run_azure_ai(store, TODAY + timedelta(days=5))
    inner = _arm_handler(AI_RID, [], windowed=True)

    def no_costs(method, url, kw):
        return Resp(204) if method == "POST" else inner(method, url, kw)

    out = _run_azure_ai(store, TODAY + timedelta(days=3), no_costs)  # window from 15 June
    assert out["azure_ai_spend"] == 1 and out["copilot_payg_spend"] == 2
    assert _raw(store, "azure_ai_spend", "UsageDate") == [date(2026, 6, 12)]
    assert _raw(store, "copilot_payg_spend", "UsageDate") == [date(2026, 6, 13)] * 2


def test_azure_ai_best_effort_step_that_fails_leaves_its_table(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    azure_ai.write_tables(store, date(2026, 5, 1), {"azure_deployment_health": [
        _health_row(date(2026, 5, 31), date(2026, 5, 31), "may"), _health_row(date(2026, 6, 30), date(2026, 6, 30), "june"),
        _health_row(date(2026, 7, 31), date(2026, 7, 20), "july"), _health_row(None, None, "undated")]})
    stored = tmp_path / "raw" / "azure_deployment_health" / "part-0.parquet"
    before = stored.read_bytes()

    def boom(*a, **k):
        raise RuntimeError("Monitor is unavailable")

    for step, warnings in ((boom, 1), (lambda *a, **k: None, None)):
        monkeypatch.setattr(azure_ai, "collect_health", step)
        out = _run_azure_ai(store, TODAY)
        assert "azure_deployment_health" not in out and out.get("warnings") == warnings
        assert out["azure_ai_spend"] == 1 and out["azure_solution_spend"] == 0
        assert stored.read_bytes() == before
    # A step that succeeds with no rows replaces its window. The window starts on 12 June, and
    # June's rows were stored after it ended, so June is kept; July and the undated row go.
    monkeypatch.setattr(azure_ai, "collect_health", lambda *a, **k: [])
    assert _run_azure_ai(store, TODAY)["azure_deployment_health"] == 2
    assert _raw(store, "azure_deployment_health", "DeploymentName") == ["june", "may"]


@pytest.mark.parametrize("start, june_covered, kept", [
    (date(2026, 6, 12), date(2026, 6, 30), True),  # June was stored after it ended
    (date(2026, 6, 12), date(2026, 6, 20), False),  # stored while June was in progress
    (date(2026, 6, 1), date(2026, 6, 30), False),  # the window covers all of June
])
def test_azure_ai_monthly_tables_replace_whole_months(tmp_path, start, june_covered, kept):
    store = LocalStore(tmp_path)
    azure_ai.write_tables(store, date(2026, 4, 1), {
        "azure_deployment_health": [_health_row(date(2026, 5, 31), date(2026, 5, 31), "old"),
                                    _health_row(date(2026, 6, 30), june_covered, "old")],
        "azure_billing_reconciliation": [_recon_row(date(2026, 5, 1), date(2026, 5, 31), "old"),
                                         _recon_row(date(2026, 6, 1), june_covered, "old")]})
    out = azure_ai.write_tables(store, start, {
        "azure_deployment_health": [_health_row(date(2026, 6, 30), date(2026, 6, 30), "new"),
                                    _health_row(date(2026, 7, 31), date(2026, 7, 31), "new")],
        "azure_billing_reconciliation": [_recon_row(start, date(2026, 6, 30), "new"),
                                         _recon_row(date(2026, 7, 1), date(2026, 7, 31), "new")]})
    assert out == {"azure_deployment_health": 3, "azure_billing_reconciliation": 3}
    june = "old" if kept else "new"
    assert _raw(store, "azure_deployment_health", "MetricDate, DeploymentName") == [
        (date(2026, 5, 31), "old"), (date(2026, 6, 30), june), (date(2026, 7, 31), "new")]
    assert _raw(store, "azure_billing_reconciliation", "PeriodStart, PoolName") == [
        (date(2026, 5, 1), "old"), (date(2026, 6, 1) if kept else start, june), (date(2026, 7, 1), "new")]


class _FailingPull(LocalStore):
    def pull(self, prefix):
        if prefix == "raw/azure_ai_tokens":
            raise OSError("download failed")
        return super().pull(prefix)


def test_azure_ai_unreadable_stored_table_fails_and_replaces_nothing(tmp_path):
    store = LocalStore(tmp_path)
    _run_azure_ai(store, TODAY)
    files = [tmp_path / "raw" / t / "part-0.parquet" for t in ("azure_ai_spend", "azure_ai_tokens", "copilot_payg_spend")]
    before = [p.read_bytes() for p in files]
    later = TODAY + timedelta(days=5)
    with pytest.raises(RuntimeError, match="can't be read, so nothing was replaced .*download failed"):
        _run_azure_ai(_FailingPull(tmp_path), later)
    assert [p.read_bytes() for p in files] == before
    files[2].write_bytes(b"not parquet")
    with pytest.raises(RuntimeError, match="can't be read, so nothing was replaced"):
        _run_azure_ai(store, later)
    assert [p.read_bytes() for p in files] == before[:2] + [b"not parquet"]


def test_azure_ai_unreadable_best_effort_table_is_left_with_a_warning(tmp_path, caplog):
    store = LocalStore(tmp_path)
    _run_azure_ai(store, TODAY)
    health = tmp_path / "raw" / "azure_deployment_health" / "part-0.parquet"
    health.write_bytes(b"not parquet")
    out = _run_azure_ai(store, TODAY + timedelta(days=5))
    assert out["warnings"] == 1 and "azure_deployment_health" not in out
    assert out["azure_ai_spend"] == 2 and out["azure_solution_spend"] == 0
    assert health.read_bytes() == b"not parquet"
    assert "azure_deployment_health failed; left unchanged" in caplog.text


def test_azure_ai_rows_with_no_date_are_replaced(tmp_path):
    store = LocalStore(tmp_path)
    azure_ai.write_tables(store, date(2026, 5, 1), {"azure_ai_spend": [
        {"UsageDate": None, "Meter": "undated"}, {"UsageDate": date(2026, 5, 2), "Meter": "older"}]})
    assert _raw(store, "azure_ai_spend", "Meter") == ["older", "undated"]
    out = azure_ai.write_tables(store, date(2026, 6, 12), {"azure_ai_spend": [
        {"UsageDate": date(2026, 6, 12), "Meter": "new"}, {"UsageDate": date(2026, 6, 1), "Meter": "before the window"}]})
    assert out == {"azure_ai_spend": 2}
    assert _raw(store, "azure_ai_spend", "UsageDate, Meter") == [(date(2026, 5, 2), "older"), (date(2026, 6, 12), "new")]


def test_azure_ai_reads_stored_files_by_the_current_columns(tmp_path):
    store = LocalStore(tmp_path)
    folder = tmp_path / "raw" / "azure_ai_spend"
    folder.mkdir(parents=True)
    duckdb.sql(f"COPY (SELECT DATE '2026-05-02' AS UsageDate, 'm' AS Meter, 1.5 AS Cost, 'x' AS Retired) "
               f"TO '{(folder / 'part-0.parquet').as_posix()}' (FORMAT PARQUET)")
    duckdb.sql(f"COPY (SELECT DATE '2026-05-03' AS UsageDate, 'n' AS Meter, 'Ops' AS DepartmentTag) "
               f"TO '{(folder / 'part-3.parquet').as_posix()}' (FORMAT PARQUET)")
    assert azure_ai.write_tables(store, date(2026, 6, 12), {"azure_ai_spend": []}) == {"azure_ai_spend": 2}
    assert store.list("raw/azure_ai_spend") == ["raw/azure_ai_spend/part-0.parquet"]
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{(folder / 'part-0.parquet').as_posix()}') ORDER BY ALL")
    assert rel.columns == [c for c, _ in azure_ai.SCHEMAS["azure_ai_spend"]]
    rows = [dict(zip(rel.columns, r)) for r in rel.fetchall()]
    assert [(r["UsageDate"], r["Meter"], r["Cost"], r["DepartmentTag"]) for r in rows] == [
        (date(2026, 5, 2), "m", 1.5, None), (date(2026, 5, 3), "n", None, "Ops")]


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
