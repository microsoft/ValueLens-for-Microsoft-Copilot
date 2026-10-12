from __future__ import annotations

import csv
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "cowork_scheduled_runs.jsonl"
CSV_PROCESSOR = ROOT / "5. Local CSV" / "scripts" / "Purview_CopilotInteraction_Processor_v4.0.0.py"
DATAVERSE_BUILDER = ROOT / "3. Power Automate + Dataverse" / "scripts" / "Build-DataverseCoreFeeds.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture_rows() -> list[dict]:
    return [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]


def cowork_records() -> list[dict]:
    return fixture_rows()[:6]


def negative_record() -> dict:
    return fixture_rows()[6]


def write_purview_and_entra(tmp_path: Path, rows: list[dict]) -> tuple[Path, Path]:
    purview = tmp_path / "purview.csv"
    entra = tmp_path / "entra.csv"
    with purview.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["Operation", "AuditData"], lineterminator="\n")
        writer.writeheader()
        writer.writerows({"Operation": r["Operation"], "AuditData": r["AuditData"]} for r in rows)
    entra.write_text("userPrincipalName,Has license\nuser1@example.com,Yes\n", encoding="utf-8")
    return purview, entra


def test_local_csv_aibv_keeps_cowork_and_drops_response_only_control(tmp_path):
    mod = load_module("valuelens_csv_cowork", CSV_PROCESSOR)
    purview, entra = write_purview_and_entra(tmp_path, fixture_rows())
    fact = tmp_path / "fact.csv"
    users = tmp_path / "users.csv"

    stats = mod.run_processor(str(purview), str(entra), str(fact), str(users), profile="aibv", quiet=True)
    with fact.open(encoding="utf-8", newline="") as handle:
        got = list(csv.DictReader(handle))

    assert stats["output_rows"] == 6
    assert stats["distinct_message_ids"] == 6
    assert len(got) == 6
    assert {r["AppHost"] for r in got} == {"cowork"}
    assert {r["Message_isPrompt"] for r in got} == {"FALSE"}
    assert {r["Prompts_Available"] for r in got} == {"FALSE"}
    assert {r["Audit_UserId"] for r in got} == {"user1@example.com"}
    assert {r["ThreadId"] for r in got} == {str(i) for i in range(1, 7)}
    assert {r["AccessedResource_Type"] for r in got} == {""}
    assert {r["InteractionDate"] for r in got} == {r["CreationDate"][:10] for r in cowork_records()}
    assert all(r["Message_Id"].isdigit() for r in got)


def test_local_csv_studio_runtime_task_row_still_works(tmp_path):
    mod = load_module("valuelens_csv_studio_cowork", CSV_PROCESSOR)
    audit_data = {
        "Id": "studio-runtime-1",
        "Operation": "CopilotInteraction",
        "CreationTime": "2026-10-05T16:00:00Z",
        "UserId": "user1@example.com",
        "AgentId": "11111111-2222-3333-4444-555555555555",
        "AgentName": "Studio Agent",
        "AgentPlatform": "Copilot Studio",
        "PlatformAgentId": "Default-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_11111111-2222-3333-4444-555555555555",
        "CopilotEventData": {"AppHost": "Teams", "Messages": [], "AccessedResources": [], "Contexts": []},
    }
    purview, entra = write_purview_and_entra(
        tmp_path,
        [{"Operation": "CopilotInteraction", "AuditData": json.dumps(audit_data)}],
    )
    fact = tmp_path / "fact.csv"
    users = tmp_path / "users.csv"

    mod.run_processor(str(purview), str(entra), str(fact), str(users), profile="aibv", quiet=True)
    with fact.open(encoding="utf-8", newline="") as handle:
        got = list(csv.DictReader(handle))

    assert len(got) == 1
    assert got[0]["Message_isPrompt"] == "FALSE"
    assert got[0]["Prompts_Available"] == "FALSE"
    assert got[0]["AppHost"] == "Teams"


def test_dataverse_builder_delegates_cowork_task_rows(tmp_path):
    bridge = load_module("valuelens_dataverse_cowork", DATAVERSE_BUILDER)
    raw_records = [
        {"RecordId": r["RecordId"], "AuditData": json.loads(r["AuditData"])}
        for r in fixture_rows()
    ]
    purview = tmp_path / "purview.csv"
    stats = bridge.write_purview_csv(raw_records, purview)
    entra = tmp_path / "entra.csv"
    entra.write_text("userPrincipalName,Has license\nuser1@example.com,Yes\n", encoding="utf-8")

    interactions_csv, _users_csv = bridge.run_processor(purview, entra, tmp_path, None, True)
    with interactions_csv.open(encoding="utf-8", newline="") as handle:
        got = list(csv.DictReader(handle))

    assert stats["written"] == 7
    assert len(got) == 6
    assert {r["AppHost"] for r in got} == {"cowork"}
    assert {r["Message_isPrompt"] for r in got} == {"FALSE"}
    assert {r["Prompts_Available"] for r in got} == {"FALSE"}
    assert {r["Audit_UserId"] for r in got} == {"user1@example.com"}
