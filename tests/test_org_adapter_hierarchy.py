"""Local CSV org adapter: manager-chain flattening tolerates cycles and self-managers."""
from __future__ import annotations

import csv
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "5. Local CSV" / "scripts" / "Adapt-OrgFile-To-EntraUsers.py"


@pytest.fixture(scope="module")
def adapter():
    spec = importlib.util.spec_from_file_location("adapt_org_file", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROWS = [
    {"UPN": "ceo@contoso.com", "Name": "Ceo", "Manager": "CEO@contoso.com"},
    {"UPN": "vp@contoso.com", "Name": "Vp", "Manager": "ceo@contoso.com"},
    {"UPN": "ic@contoso.com", "Name": "Ic", "Manager": "vp@contoso.com"},
    {"UPN": "a@contoso.com", "Name": "A", "Manager": "b@contoso.com"},
    {"UPN": "b@contoso.com", "Name": "B", "Manager": "a@contoso.com"},
]


def test_self_manager_is_root_without_error(adapter):
    hier = adapter.build_hierarchy(ROWS, "UPN", "Manager", "Name", 14)
    ceo = hier["ceo@contoso.com"]
    assert ceo["HierarchyError"] == "" and ceo["OrgLevel"] == "0" and ceo["HierarchyPath"] == "Ceo"
    assert ceo["DirectReports"] == "1"


def test_normal_chain_unchanged(adapter):
    ic = adapter.build_hierarchy(ROWS, "UPN", "Manager", "Name", 14)["ic@contoso.com"]
    assert ic["HierarchyPath"] == "Ceo > Vp > Ic" and ic["OrgLevel"] == "2" and ic["HierarchyError"] == ""


def test_two_person_cycle_kept_and_flagged(adapter):
    hier = adapter.build_hierarchy(ROWS, "UPN", "Manager", "Name", 14)
    assert hier["a@contoso.com"]["HierarchyError"] == "Cycle detected at 'a@contoso.com'"
    assert hier["a@contoso.com"]["HierarchyPath"] == "B > A"
    assert hier["a@contoso.com"]["DirectReports"] == "1"


def test_cli_writes_hierarchy_error_column(tmp_path):
    src = tmp_path / "org.csv"
    with open(src, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["UserPrincipalName", "DisplayName", "ManagerUpn"])
        w.writeheader()
        for r in ROWS:
            w.writerow({"UserPrincipalName": r["UPN"], "DisplayName": r["Name"], "ManagerUpn": r["Manager"]})
    out = tmp_path / "out.csv"
    proc = subprocess.run([sys.executable, str(SCRIPT), "--in", str(src), "--out", str(out)],
                          capture_output=True, text=True, encoding="utf-8",
                          env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    assert proc.returncode == 0, proc.stderr
    assert "Manager cycles      : 2 distinct" in proc.stdout
    with open(out, encoding="utf-8") as f:
        rows = {r["userPrincipalName"]: r for r in csv.DictReader(f)}
    assert len(rows) == 5
    assert rows["ceo@contoso.com"]["HierarchyError"] == ""
    assert rows["b@contoso.com"]["HierarchyError"] == "Cycle detected at 'b@contoso.com'"
