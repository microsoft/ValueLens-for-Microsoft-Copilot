"""Parity: valuelens_core.{licensed,org,m365} vs the pure-Python logic in the Fabric notebooks."""
from __future__ import annotations

from datetime import date, datetime

import pytest

import notebook_source
from valuelens_core import licensed, m365, org

LICENSED_NB = "Copilot_Licensed_Users_Direct_Ingester.ipynb"
ORG_NB = "Copilot_Org_Data_Direct_Ingester.ipynb"
M365_NB = "Copilot_M365_Activity_Ingester.ipynb"

PRODUCTS = [
    "MICROSOFT 365 E5+MICROSOFT 365 COPILOT",
    "Microsoft 365 E3; Copilot for Microsoft 365",
    "MICROSOFT 365 COPILOT VIRAL TRIAL",
    "Microsoft Copilot Studio",
    "Microsoft 365 Copilot Chat",
    "MICROSOFT 365 E7",
    "MICROSOFT 365 E7 ADD-ON",
    "Security Copilot,M365 Copilot",
    "",
]
CSV = (
    "\ufeffReport Refresh Date,User Principal Name,Display Name,Assigned Products\n"
    "2026-03-01,Ada@contoso.com,Ada,MICROSOFT 365 E5+MICROSOFT 365 COPILOT\n"
    "2026-03-01,bob@contoso.com,Bob,Microsoft 365 E3\n"
    "2026-03-01,Ada@contoso.com ,Ada,MICROSOFT 365 E5+MICROSOFT 365 COPILOT\n"
    ",,,\n"
    "2026-03-01,cy@contoso.com,\"Cy, Jr\",MICROSOFT 365 COPILOT VIRAL TRIAL\n"
)
USERS = [
    {"userPrincipalName": "ceo@contoso.com", "displayName": "Ceo", "accountEnabled": True},
    {"userPrincipalName": "vp@contoso.com", "displayName": "Vp", "department": "Sales",
     "manager": {"userPrincipalName": "ceo@contoso.com"}},
    {"userPrincipalName": "ic@contoso.com", "displayName": None, "accountEnabled": False,
     "manager": {"userPrincipalName": "VP@contoso.com"}},
    {"userPrincipalName": "orphan@contoso.com", "displayName": "Orphan",
     "manager": {"userPrincipalName": "gone@contoso.com"}},
    {"userPrincipalName": "vp@contoso.com", "displayName": "Vp", "department": "Sales",
     "manager": {"userPrincipalName": "ceo@contoso.com"}},
]


@pytest.fixture(scope="module")
def nb_licensed():
    return notebook_source.namespace(LICENSED_NB, {"COPILOT_SKU_PATTERNS", "COPILOT_SKU_EXCLUDE", "_pats", "_excl"})


def test_licence_patterns_match_notebook(nb_licensed):
    assert licensed.COPILOT_SKU_PATTERNS == nb_licensed["COPILOT_SKU_PATTERNS"]
    assert licensed.COPILOT_SKU_EXCLUDE == nb_licensed["COPILOT_SKU_EXCLUDE"]


@pytest.mark.parametrize("products", PRODUCTS)
def test_licence_classifier_matches_notebook(nb_licensed, products):
    assert licensed.make_classifier()(products) == nb_licensed["_is_copilot"](products)


def test_licensed_parse_matches_notebook(nb_licensed):
    assert licensed._parse_active_user_report(CSV) == nb_licensed["_parse_active_user_report"](CSV)


def test_licensed_snapshot_shape():
    cols, rows = licensed.build_snapshot(CSV)
    assert cols == ["Assigned_Products", "Display_Name", "Has_license", "Report_Refresh_Date",
                    "User_Principal_Name", "UPN_Normalized"]
    assert [r[-1] for r in rows] == ["ada@contoso.com", "bob@contoso.com", "cy@contoso.com"]
    assert [r[2] for r in rows] == ["TRUE", "FALSE", "FALSE"]


def test_licensed_conflicting_duplicate_rejected():
    bad = CSV.replace("Ada@contoso.com ,Ada,", "Ada@contoso.com ,Ada Lovelace,")
    with pytest.raises(ValueError, match="conflict"):
        licensed.build_snapshot(bad)


def test_licensed_empty_guard():
    header = "User Principal Name,Assigned Products\n"
    with pytest.raises(ValueError):
        licensed.build_snapshot(header)
    with pytest.raises(ValueError):
        licensed.build_snapshot(header, allow_empty=True, table_exists=True)
    assert licensed.build_snapshot(header, allow_empty=True)[1] == []


def test_org_matches_notebook():
    nb = notebook_source.namespace(ORG_NB, {"MAX_ORG_LEVELS", "HIER_FIXED", "HIER_LEVELS", "HIER_COLUMNS"})
    nb_rows = nb["_dedupe_org_rows"]([nb["_canonical_org_row"](u) for u in USERS])
    assert nb_rows == org._dedupe_org_rows([org._canonical_org_row(u) for u in USERS])
    assert nb["build_hierarchy"](nb_rows) == org.build_hierarchy(nb_rows)
    assert nb["HIER_COLUMNS"] == org.HIER_COLUMNS


def test_org_snapshot_shape():
    cols, rows = org.build_snapshot(USERS)
    by = {r[0]: dict(zip(cols, r)) for r in rows}
    assert len(rows) == 4 and len(cols) == len(org.COLUMNS)
    assert by["ic@contoso.com"]["HierarchyPath"] == "Ceo > Vp > ic@contoso.com"
    assert by["ic@contoso.com"]["OrgLevel"] == "2" and by["vp@contoso.com"]["IsManager"] == "TRUE"
    assert by["orphan@contoso.com"]["Level0_Name"] == "Orphan"
    assert {r["TotalEmployees"] for r in by.values()} == {"4"}
    assert by["ceo@contoso.com"]["accountEnabled"] == "True" and by["vp@contoso.com"]["accountEnabled"] == ""


def test_org_cycle_rejected():
    users = [{"userPrincipalName": "a@x", "manager": {"userPrincipalName": "b@x"}},
             {"userPrincipalName": "b@x", "manager": {"userPrincipalName": "a@x"}}]
    with pytest.raises(ValueError, match="Cycle"):
        org.build_snapshot(users)


def test_m365_matches_notebook():
    nb = notebook_source.namespace(M365_NB, {"REPORTS", "COUNTS", "FLAGS", "ACTIVE", "VALUE_COLUMNS",
                                             "_ISO_DURATION", "BY_REPORT", "GRAPH"})
    for name in ("REPORTS", "COUNTS", "FLAGS", "ACTIVE", "VALUE_COLUMNS"):
        assert getattr(m365, name) == nb[name], name
    teams = [{"Report Refresh Date": "2026-03-05", "User Principal Name": "Ada@contoso.com",
              "Team Chat Message Count": "3", "Audio Duration": "PT1H2M3S", "Call Count": ""},
             {"User Principal Name": "", "Call Count": "9"},
             {"User Principal Name": "D41D8CD98F00B204E9800998ECF8427E", "Meeting Count": "1"}]
    apps = [{"User Principal Name": "ada@contoso.com", "Word": "Yes", "Mac": "no", "Report Refresh Date": "2026-03-06"},
            {"User Principal Name": "idle@contoso.com", "Word": "No"}]
    day, loaded_at = date(2026, 3, 4), datetime(2026, 3, 7, 1, 2, 3)
    ours, theirs = {}, {}
    for key, recs in (("teams", teams), ("apps", apps)):
        m365.add_report(ours, key, recs)
        nb["add_report"](theirs, key, recs)
    assert ours == theirs
    assert m365.build_rows(day, ours, loaded_at) == nb["build_rows"](day, theirs, loaded_at)
    assert len(m365.build_rows(day, ours, loaded_at)[0]) == len(m365.COLUMNS)
    today = date(2026, 3, 10)
    loaded = {today.replace(day=d) for d in range(1, 10)}
    assert m365.days_to_load(today, loaded, {date(2026, 3, 2)}, 4) == \
        nb["days_to_load"](today, loaded, {date(2026, 3, 2)}, 4)
