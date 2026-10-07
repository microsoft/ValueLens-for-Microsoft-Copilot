from __future__ import annotations

import csv
import importlib.util
import json
from pathlib import Path

import duckdb

from valuelens_core import audit


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "cowork_scheduled_runs.jsonl"
INGESTER = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Audit_Log_Direct_Ingester.ipynb"
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


def test_fabric_ingester_source_has_cowork_task_row_rule():
    source = "\n".join(
        "".join(cell.get("source", []))
        for cell in json.loads(INGESTER.read_text(encoding="utf-8"))["cells"]
        if cell.get("cell_type") == "code"
    )
    assert "def is_cowork_autonomous" in source
    assert "_task_row_record = _copilot_studio_runtime | _cowork_autonomous" in source
    assert ".withColumn('Prompts_Available', F.when(_has_prompt_messages" in source
    assert ".withColumn('_Task_Row_Placeholder'" in source
    assert "F.when(F.col('_Task_Row_Placeholder'), F.array(_empty_message))" in source
    assert "F.when(F.col('_Task_Row_Placeholder'), F.array(_empty_resource))" in source
    assert "F.when(F.col('_Task_Row_Placeholder'), F.lit('message:none'))" in source
    assert "Copilot Cowork scheduled/autonomous runs" in source


def test_duckdb_audit_keeps_one_cowork_task_row_per_record():
    rows = fixture_rows()
    con = duckdb.connect()
    con.execute("CREATE TABLE staged (" + ", ".join(f'"{c}" VARCHAR' for c in audit.STAGE_COLUMNS) + ")")
    con.executemany(
        "INSERT INTO staged VALUES (" + ", ".join("?" for _ in audit.STAGE_COLUMNS) + ")",
        [[r.get(c) for c in audit.STAGE_COLUMNS] for r in rows],
    )
    rel = audit.flatten(con, "staged")
    got = [dict(zip(rel.columns, row)) for row in rel.fetchall()]

    expected_threads = {
        json.loads(r["AuditData"])["CopilotEventData"]["ThreadId"]
        for r in cowork_records()
    }
    assert {r["RecordId"] for r in got} == {r["RecordId"] for r in cowork_records()}
    assert negative_record()["RecordId"] not in {r["RecordId"] for r in got}
    assert len(got) == 6
    assert {r["ThreadId"] for r in got} == expected_threads
    for row in got:
        assert row["AppHost"] == "cowork"
        assert row["AgentName"] == "Copilot Cowork"
        assert row["Audit_UserId"] == "user1@example.com"
        assert row["Message_Id"] == "message:none"
        assert row["Message_isPrompt"] == "false"
        assert row["Source_MessageKey"] == "message:none"
        assert row["Source_ResourceKey"] == "resource:none"
        assert row["Resource_Ordinal"] == 0


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
