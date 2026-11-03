from __future__ import annotations

import json
import re
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT_SOURCE = ROOT / "5. Local CSV" / "ValueLens - Local CSV.pbit"
REPORT_DATA = ROOT / "demo" / "valuelens-report" / "report-data.js"
APP_SOURCE = ROOT / "demos" / "valuelens-report" / "app.js"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def normalized(value: object) -> str:
    if isinstance(value, list):
        value = " ".join(str(part) for part in value)
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def load_payload() -> dict[str, object]:
    assignment = REPORT_DATA.read_text(encoding="utf-8").split("=", 1)[1]
    return json.loads(assignment.strip().rstrip(";"))


payload = load_payload()
report = payload["report"]
fixture = payload["fixture"]
require(report["source"] == "5. Local CSV/ValueLens - Local CSV.pbit", "Unexpected report source")
require(report["baseRevision"] == "8ea817cc7129d46eaf0d230abbf448ea1f39c22c", "Unexpected report base revision")

adoption = next(page for page in report["pages"] if "adoption" in page["name"].lower())
ai_tasks_visual = next(
    visual
    for visual in adoption["visuals"]
    if visual["type"] == "treemap"
    and any(field["kind"] == "column" and field["name"] == "Behavior_Enriched_Full" for field in visual["fields"])
    and any(field["kind"] == "measure" and field["name"] == "AI Tasks" for field in visual["fields"])
)
ai_tasks_dax = normalized(report["measures"]["ai tasks"]["expression"])
require("countrows(" in ai_tasks_dax and "[is prompt row] = true()" in ai_tasks_dax, "AI Tasks source formula changed")
active_licensed_dax = normalized(report["measures"]["active licensed users"]["expression"])
usage_rows_dax = normalized(report["measures"]["usage rows"]["expression"])
inactive_licensed_dax = normalized(report["measures"]["inactive licensed users (filter-aware)"]["expression"])
inactive_unlicensed_dax = normalized(report["measures"]["inactive unlicensed users (filter-aware)"]["expression"])
require("[usage rows]" in active_licensed_dax, "Active Licensed Users source formula changed")
require("[is usage row] = true()" in usage_rows_dax, "Usage Rows source formula changed")
require("[licensed users (filter-aware)]" in inactive_licensed_dax and "[active licensed users]" in inactive_licensed_dax, "Inactive Licensed Users source formula changed")
require("[unlicensed users (filter-aware)]" in inactive_unlicensed_dax and "[active unlicensed users]" in inactive_unlicensed_dax, "Inactive Unlicensed Users source formula changed")

activation = next(page for page in report["pages"] if "activation" in page["name"].lower())
activation_donut = next(
    visual
    for visual in activation["visuals"]
    if visual["type"] == "donutChart"
    and {field["name"] for field in visual["fields"] if field["kind"] == "measure"}
    == {"Active Licensed Users (Verified Inventory)", "Inactive Licensed Users (Filter-Aware)"}
)

with zipfile.ZipFile(REPORT_SOURCE) as archive:
    model = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))["model"]
    interaction_table = next(
        table for table in model["tables"]
        if table["name"] == "Chat + Agent Interactions (Audit Logs)"
    )
    columns = {column["name"]: normalized(column.get("expression")) for column in interaction_table["columns"]}

require("[message_isprompt]" in columns["Is Prompt Row"], "Source prompt-row mapping changed")
require("[is prompt row]" in columns["Is Usage Row"] and "[is_cowork]" in columns["Is Usage Row"], "Source usage-row mapping changed")
require(all(term in columns["Is Observed Prompt"] for term in ("[message_isprompt]", "[audit_userid]", "[message_id]", "[threadid]")), "Source observed-prompt mapping changed")

start = next(index for index, month in enumerate(fixture["months"]) if month >= "2026-06")
period_rows = [row for row in fixture["rows"] if row[0] >= start]
prompt_rows = [row for row in period_rows if row[10] == 1]
usage_rows = [row for row in period_rows if row[14] == 1]
require(len(prompt_rows) == 13337, "AI Tasks fixture total changed")
require(all(row[10] == 1 for row in prompt_rows), "Unexpected non-prompt row in the default window")

active_licensed = {row[8] for row in usage_rows if row[2] == 0}
active_unlicensed = {row[8] for row in usage_rows if row[2] == 1}
licensed_population = sum(license == 0 for license in fixture["userLicenses"])
unlicensed_population = sum(license == 1 for license in fixture["userLicenses"])
require((len(active_licensed), licensed_population - len(active_licensed)) == (108, 4), "Licensed-user values changed")
require((len(active_unlicensed), unlicensed_population - len(active_unlicensed)) == (43, 15), "Unlicensed-user values changed")

default_view = next(
    view["name"]
    for group in report["pages"][0]["views"]
    for view in group["views"]
    if view["id"] == group["selected"]
)
require(default_view.lower() == "licensed", "Default report bookmark changed")

def behavior_counts(rows: list[list[object]]) -> Counter[str]:
    return Counter(fixture["behaviors"][row[5]] for row in rows if row[5] >= 0)


licensed_prompt_rows = [row for row in prompt_rows if row[2] == 0]
top_behavior_counts = behavior_counts(licensed_prompt_rows).most_common(3)
require(
    top_behavior_counts == [("Email Drafting", 1203), ("General Chat", 922), ("Email Summarising", 799)],
    "AI Tasks-by-behavior chart values changed",
)

team_index = fixture["teams"].index("Group 01")
licensed_team = [
    row for row in prompt_rows
    if row[1] == team_index and row[2] == 0
]
licensed_team_users = {
    row[8] for row in usage_rows
    if row[1] == team_index and row[2] == 0
}
require((len(licensed_team), len(licensed_team_users)) == (593, 5), "Licensed Group 01 filter values changed")
licensed_team_population = sum(
    1
    for user_team, license in zip(fixture["userTeams"], fixture["userLicenses"])
    if user_team == team_index and license == 0
)
require(licensed_team_population == 6, "Licensed Group 01 inventory changed")
require(licensed_team_population - len(licensed_team_users) == 1, "Licensed Group 01 inactive count changed")
licensed_team_top_behaviors = behavior_counts(licensed_team).most_common(3)
require(
    licensed_team_top_behaviors == [("General Chat", 69), ("Email Drafting", 64), ("Email Summarising", 47)],
    "Licensed Group 01 chart values changed",
)

unlicensed_team = [
    row for row in prompt_rows
    if row[1] == team_index and row[2] == 1
]
unlicensed_team_users = {
    row[8] for row in usage_rows
    if row[1] == team_index and row[2] == 1
}
require((len(unlicensed_team), len(unlicensed_team_users)) == (287, 8), "Team/licence filter values changed")
unlicensed_team_population = sum(
    1
    for user_team, license in zip(fixture["userTeams"], fixture["userLicenses"])
    if user_team == team_index and license == 1
)
require(unlicensed_team_population == 14, "Unlicensed Group 01 inventory changed")
require(unlicensed_team_population - len(unlicensed_team_users) == 6, "Unlicensed Group 01 inactive count changed")
unlicensed_team_top_behaviors = behavior_counts(unlicensed_team).most_common(3)
require(
    unlicensed_team_top_behaviors == [("General Chat", 73), ("Web Searching", 45), ("Document Summarising", 42)],
    "Unlicensed Group 01 chart values changed",
)

app_source = APP_SOURCE.read_text(encoding="utf-8")
require(
    "measureValue(measureFields[0].name, groupRows)" in app_source,
    "Grouped charts must evaluate their source measure for each category",
)

print(f"Source chart: Adoption / {ai_tasks_visual['type']} / Behavior_Enriched_Full × AI Tasks")
print("Source measure: AI Tasks = count rows where Is Prompt Row is true")
print(f"Source chart: Activation / {activation_donut['type']} / Active Licensed + Inactive Licensed Users")
print(f"Jun-Aug 2026 licensed view: 11,721 AI Tasks; behavior leaders {top_behavior_counts}")
print(f"Activation inventory: 108 active + 4 inactive licensed; 43 active + 15 inactive unlicensed")
print(f"Licensed Group 01 filter: 593 AI Tasks, 5 active + 1 inactive / 6 inventory people; behavior leaders {licensed_team_top_behaviors}")
print(f"Unlicensed Group 01: 287 AI Tasks, 8 active + 6 inactive / 14 inventory people; behavior leaders {unlicensed_team_top_behaviors}")
