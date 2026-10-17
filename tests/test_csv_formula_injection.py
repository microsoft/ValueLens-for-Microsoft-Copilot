"""CSV formula injection (CWE-1236) in the CSVs the Local CSV processor and the SharePoint
registry script write.

Agent names and descriptions are whatever their makers typed, profile fields whatever the
directory holds, and admins open these files in Excel. Text Excel would run as a formula
gets a leading apostrophe, unless it's just a signed number: the rule the Fabric App's CSV
download uses (1. Fabric/Fabric App/src/lib/table-csv.ts).

The registry test dot-sources the PowerShell script, so it needs a PowerShell whose
execution policy allows scripts (CI's pwsh on Linux does); where the policy blocks scripts
it is skipped, not bypassed.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROCESSOR = ROOT / "5. Local CSV" / "scripts" / "Purview_CopilotInteraction_Processor_v4.0.0.py"
REGISTRY = ROOT / "4. SharePoint" / "scripts" / "Get-Agents365Registry.ps1"

PAYLOAD = '=HYPERLINK("http://example.test/x","click")'

# (text, what the CSV must hold)
CASES = [
    ("=1+1", "'=1+1"),
    ("+1+1", "'+1+1"),
    ("-2+3+cmd|' /C calc'!A0", "'-2+3+cmd|' /C calc'!A0"),
    ("@SUM(1+1)", "'@SUM(1+1)"),
    ("\t=1+1", "'\t=1+1"),
    ("\r=1+1", "'\r=1+1"),
    (PAYLOAD, "'" + PAYLOAD),
    ("-5\n", "'-5\n"),  # a number and then more isn't just a number
    ("-\u0663", "'-\u0663"),  # only ASCII digits make a number, as in table-csv.ts
    ("-5", "-5"),
    ("+44", "+44"),
    ("-1,234.50", "-1,234.50"),
    ("-12%", "-12%"),
    ("Alpha", "Alpha"),
    ("a=1", "a=1"),
    ("", ""),
    ("'=1+1", "'=1+1"),  # already neutralised
]


@pytest.fixture(scope="module")
def processor():
    spec = importlib.util.spec_from_file_location("valuelens_csv_formula_injection", PROCESSOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("text, expected", CASES)
def test_processor_rule(processor, text, expected):
    assert processor.csv_text(text) == expected
    assert processor.csv_text(expected) == expected


@pytest.mark.parametrize("value", [None, 5, -5, -1.5, True])
def test_processor_rule_leaves_non_text_alone(processor, value):
    assert processor.csv_text(value) is value


def audit_record(record_id: str, user: str, agent_id: str, agent_name: str) -> dict:
    return {
        "Operation": "CopilotInteraction",
        "AuditData": json.dumps({
            "Id": record_id,
            "Operation": "CopilotInteraction",
            "CreationTime": "2026-10-05T16:00:00Z",
            "UserId": user,
            "AgentId": agent_id,
            "AgentName": agent_name,
            "AgentPlatform": "Copilot Studio",
            "PlatformAgentId": f"Default-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_{agent_id}",
            "CopilotEventData": {
                "AppHost": "Teams",
                "Messages": [{"Id": f"{record_id}-prompt", "isPrompt": True}],
                "AccessedResources": [],
                "Contexts": [],
            },
        }),
    }


def read_rows(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


@pytest.mark.parametrize("profile", ["aibv", "aio"])
def test_processor_outputs_are_neutralised_and_still_join(processor, tmp_path, profile):
    purview = tmp_path / "purview.csv"
    with purview.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["Operation", "AuditData"], lineterminator="\n")
        writer.writeheader()
        writer.writerow(audit_record("r1", "user1@example.com", "11111111-2222-3333-4444-555555555555", PAYLOAD))
        writer.writerow(audit_record("r2", "-dash@example.com", "66666666-7777-8888-9999-000000000000", "Alpha"))
    entra = tmp_path / "entra.csv"
    with entra.open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle, lineterminator="\n").writerows([
            ["userPrincipalName", "Department", "jobTitle", "Has license"],
            ["user1@example.com", PAYLOAD, "-5", "Yes"],
            ["-dash@example.com", "Sales", "@Lead", "No"],
        ])
    fact, users = tmp_path / "fact.csv", tmp_path / "users.csv"
    agg_names = ("active_days", "user_month_metrics", "licensed_rankings", "unlicensed_rankings", "licensed_summary")
    agg_paths = {name: str(tmp_path / f"{name}.csv") for name in agg_names}

    processor.run_processor(str(purview), str(entra), str(fact), str(users), profile=profile,
                            agg_paths=agg_paths, quiet=True)

    users_by_key = {r["UserKey"]: r for r in read_rows(users)}
    people = {r["PersonId"]: r for r in users_by_key.values()}
    assert set(people) == {"user1@example.com", "'-dash@example.com"}
    assert people["user1@example.com"]["Organization"] == "'" + PAYLOAD
    assert people["user1@example.com"]["JobTitle"] == "-5"
    assert people["user1@example.com"]["Has license"] == "TRUE"
    assert people["'-dash@example.com"]["JobTitle"] == "'@Lead"
    assert people["'-dash@example.com"]["PersonId_Normalized"] == "'-dash@example.com"

    fact_rows = {users_by_key[r["UserKey"]]["PersonId"]: r for r in read_rows(fact)}
    assert set(fact_rows) == set(people)
    assert fact_rows["user1@example.com"]["AgentName"] == "'" + PAYLOAD
    assert fact_rows["'-dash@example.com"]["AgentName"] == "Alpha"
    month_keys = {person: row["UserMonthKey"] for person, row in fact_rows.items()}
    assert month_keys == {"user1@example.com": "user1@example.com|2026-10",
                          "'-dash@example.com": "'-dash@example.com|2026-10"}

    if profile == "aio":
        assert not any(Path(p).exists() for p in agg_paths.values())
        return
    for person, row in fact_rows.items():
        assert row["Audit_UserId"] == person, "the fact's text key still matches the users file"
    assert {r["Audit_UserId"] for r in read_rows(Path(agg_paths["active_days"]))} == set(people)
    assert {r["UserMonthKey"] for r in read_rows(Path(agg_paths["user_month_metrics"]))} == set(month_keys.values())
    assert [r["Audit_UserId"] for r in read_rows(Path(agg_paths["unlicensed_rankings"]))] == ["'-dash@example.com"]


def _find_pwsh():
    for exe in ("pwsh", "powershell"):
        try:
            subprocess.run([exe, "-NoProfile", "-NonInteractive", "-Command", "1"],
                           capture_output=True, timeout=30, check=False)
            return exe
        except (FileNotFoundError, OSError):
            continue
    return None


PWSH = _find_pwsh()


def _scripts_allowed():
    if not PWSH:
        return False
    result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"],
                            capture_output=True, text=True, timeout=30, check=False)
    return result.returncode == 0 and result.stdout.strip() not in ("Restricted", "AllSigned")


SCRIPTS_ALLOWED = _scripts_allowed()

# Every case goes into two columns of its own row; a last row puts '@x' in every column.
# `pwsh -Command -` reads stdin like a console: a multi-line block runs only once a blank
# line follows it, so keep the blank line after the foreach.
REGISTRY_HARNESS = r"""
$ErrorActionPreference = 'Stop'
. '__SCRIPT__'
$cases = Get-Content -LiteralPath '__CASES__' -Raw -Encoding UTF8 | ConvertFrom-Json
$rows = [System.Collections.Generic.List[object]]::new()
foreach ($value in $cases) {
  $row = [ordered]@{}
  foreach ($c in $script:RegistryColumns) { $row[$c] = 'x' }
  $row['Agent name'] = $value
  $row['Agent description'] = $value
  $rows.Add($row)
}

$every = [ordered]@{}
foreach ($c in $script:RegistryColumns) { $every[$c] = '@x' }
$rows.Add($every)
Write-RegistryCsv -Rows $rows -Path '__CSV__'
"""


@pytest.mark.skipif(not SCRIPTS_ALLOWED, reason="PowerShell execution policy blocks scripts here (not bypassed)")
def test_registry_rule_matches_and_covers_every_column(tmp_path):
    cases = tmp_path / "cases.json"
    cases.write_text(json.dumps([text for text, _ in CASES]), encoding="utf-8")
    out = tmp_path / "Agents365Registry.csv"
    command = (REGISTRY_HARNESS.replace("__SCRIPT__", str(REGISTRY))
               .replace("__CASES__", str(cases)).replace("__CSV__", str(out)))
    result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", "-"], input=command,
                            capture_output=True, text=True, timeout=180, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert out.exists(), "Write-RegistryCsv never ran: " + result.stdout + result.stderr

    with out.open(encoding="utf-8-sig", newline="") as handle:
        header, *rows = list(csv.reader(handle))
    assert len(header) == 48
    assert not any(h.startswith("'") for h in header)
    name, description = header.index("Agent name"), header.index("Agent description")
    assert [(r[name], r[description]) for r in rows[:-1]] == [(expected, expected) for _, expected in CASES]
    assert set(rows[-1]) == {"'@x"}
