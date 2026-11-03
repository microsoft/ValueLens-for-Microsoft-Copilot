#!/usr/bin/env python3
"""Build a self-contained browser demo from the checked-in report and sample CSVs."""

from __future__ import annotations

import csv
import json
import re
import shutil
import zipfile
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE_REPORT = ROOT / "5. Local CSV" / "ValueLens - Local CSV.pbit"
SAMPLE_DIR = ROOT / "5. Local CSV" / "sample-data"
SOURCE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "demo" / "valuelens-report"
BASE_REVISION = "8ea817cc7129d46eaf0d230abbf448ea1f39c22c"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def clean(value: object) -> str:
    return str(value or "").strip()


def month_for(value: str) -> str:
    value = clean(value)
    if not value:
        return ""
    match = re.match(r"^(\d{4})-(\d{2})", value)
    if match:
        return f"{match.group(1)}-{match.group(2)}"
    for form in ("%m/%d/%Y %H:%M:%S", "%m/%d/%Y"):
        try:
            return datetime.strptime(value, form).strftime("%Y-%m")
        except ValueError:
            pass
    return ""


def parse_datatable_rows(expression: object) -> list[list[object]]:
    source = "\n".join(expression) if isinstance(expression, list) else str(expression or "")
    rows: list[list[object]] = []
    for line in source.splitlines():
        text = line.strip()
        if not text.startswith('{"'):
            continue
        values: list[object] = []
        index = 1
        while index < len(text):
            char = text[index]
            if char == '"':
                index += 1
                value = ""
                while index < len(text):
                    if text[index] == '"':
                        if index + 1 < len(text) and text[index + 1] == '"':
                            value += '"'
                            index += 2
                            continue
                        break
                    value += text[index]
                    index += 1
                values.append(value)
                index += 1
            elif char.isdigit() or char in "-.":
                match = re.match(r"-?[\d.]+", text[index:])
                if match:
                    token = match.group()
                    values.append(float(token) if "." in token else int(token))
                    index += len(token)
                else:
                    index += 1
            elif text.startswith("null", index):
                values.append(None)
                index += 4
            elif char == "}":
                break
            else:
                index += 1
        rows.append(values)
    return rows


def expression_text(expression: object) -> str:
    return "\n".join(expression) if isinstance(expression, list) else str(expression or "")


def literal_values(value: object) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        if "Literal" in value and isinstance(value["Literal"], dict):
            literal = value["Literal"].get("Value")
            if isinstance(literal, str):
                text = literal.strip()
                if len(text) >= 2 and text[0] == text[-1] == '"':
                    text = text[1:-1].replace('""', '"')
                if text and text not in found:
                    found.append(text)
        for nested in value.values():
            for text in literal_values(nested):
                if text not in found:
                    found.append(text)
    elif isinstance(value, list):
        for nested in value:
            for text in literal_values(nested):
                if text not in found:
                    found.append(text)
    return found


def object_property(visual: dict[str, object], object_name: str, property_name: str) -> str:
    objects = visual.get("objects", {})
    if not isinstance(objects, dict):
        objects = {}
    entries = objects.get(object_name, [])
    if not entries:
        container_objects = visual.get("visualContainerObjects", {})
        if isinstance(container_objects, dict):
            entries = container_objects.get(object_name, [])
    if not isinstance(entries, list) or not entries or not isinstance(entries[0], dict):
        return ""
    properties = entries[0].get("properties", {})
    if not isinstance(properties, dict):
        return ""
    values = literal_values(properties.get(property_name))
    return values[0].strip("'") if values else ""


def textbox_text(visual: dict[str, object]) -> str:
    objects = visual.get("objects", {})
    if not isinstance(objects, dict):
        return ""
    paragraphs = objects.get("general", [])
    runs: list[str] = []

    def collect(value: object) -> None:
        if isinstance(value, dict):
            text_runs = value.get("textRuns")
            if isinstance(text_runs, list):
                runs.extend(
                    clean(run.get("value"))
                    for run in text_runs
                    if isinstance(run, dict) and clean(run.get("value"))
                )
                return
            for nested in value.values():
                collect(nested)
        elif isinstance(value, list):
            for nested in value:
                collect(nested)

    collect(paragraphs)
    return " ".join(runs).strip()


def projection_fields(visual: dict[str, object]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    query = visual.get("query", {})
    if not isinstance(query, dict):
        return result
    query_state = query.get("queryState", {})
    if not isinstance(query_state, dict):
        return result
    for role, state in query_state.items():
        if not isinstance(state, dict):
            continue
        projections = state.get("projections", [])
        if not isinstance(projections, list):
            continue
        for projection in projections:
            if not isinstance(projection, dict):
                continue
            field = projection.get("field", {})
            field_kind = ""
            entity = ""
            property_name = ""
            if isinstance(field, dict):
                for candidate in ("Measure", "Column", "Hierarchy"):
                    detail = field.get(candidate)
                    if isinstance(detail, dict):
                        field_kind = candidate.lower()
                        expression = detail.get("Expression", {})
                        if isinstance(expression, dict):
                            source = expression.get("SourceRef", {})
                            if isinstance(source, dict):
                                entity = clean(source.get("Entity"))
                        property_name = clean(detail.get("Property") or detail.get("Hierarchy"))
                        break
            label = clean(
                projection.get("displayName")
                or projection.get("nativeQueryRef")
                or property_name
                or projection.get("queryRef")
            )
            result.append(
                {
                    "role": clean(role),
                    "kind": field_kind,
                    "table": entity,
                    "name": property_name or label,
                    "label": label,
                    "measure": "true" if field_kind == "measure" else "false",
                }
            )
    return result


def visual_title(visual: dict[str, object], fields: list[dict[str, str]]) -> str:
    if clean(visual.get("visualType")).lower() == "textbox":
        text = textbox_text(visual)
        if text:
            return text
    objects = visual.get("objects", {})
    if isinstance(objects, dict):
        title_objects = objects.get("title", [])
        texts = literal_values(title_objects)
        for text in texts:
            if text.strip() and len(text) < 120:
                return text.strip()
    if clean(visual.get("visualType")).lower() == "textbox":
        texts = [
            text.strip()
            for text in literal_values(objects)
            if text.strip() and len(text.strip()) < 220 and not text.strip().startswith("#")
        ]
        if texts:
            return max(texts, key=len)
    if fields:
        labels = [field["label"] for field in fields if field["label"]]
        if labels:
            return " · ".join(labels[:2])
    return clean(visual.get("visualType")).replace("Chart", " chart").replace("Visual", " visual")


def field_dimension(field_name: str) -> str:
    name = field_name.lower()
    if "date" in name or "month" in name or "week" in name:
        return "period"
    if "organization" in name or "department" in name or "org" in name:
        return "team"
    if "licen" in name or "environment" in name:
        return "license"
    if "agent filter" in name or name == "tool":
        return "tool"
    if "agent" in name:
        return "agent"
    if "feedback" in name:
        return "feedback"
    if "model" in name:
        return "model"
    if "task breakdown category" in name or "cowork task category" in name:
        return "taskDetail"
    if "behavior" in name or "task" in name or "outcome" in name:
        return "task"
    if "status" in name or "lifecycle" in name:
        return "status"
    return ""


def report_metadata() -> dict[str, object]:
    with zipfile.ZipFile(SOURCE_REPORT) as archive:
        names = set(archive.namelist())
        page_index = json.loads(archive.read("Report/definition/pages/pages.json"))
        order = page_index.get("pageOrder", [])
        bookmark_index = json.loads(archive.read("Report/definition/bookmarks/bookmarks.json"))
        bookmark_groups = {item["name"]: item for item in bookmark_index.get("items", [])}
        bookmarks: dict[str, dict[str, object]] = {}
        for item in names:
            prefix = "Report/definition/bookmarks/"
            if item.startswith(prefix) and item.endswith(".bookmark.json"):
                bookmark = json.loads(archive.read(item))
                bookmarks[clean(bookmark.get("name"))] = bookmark
        pages_by_id: dict[str, dict[str, object]] = {}
        visuals_by_page: dict[str, list[str]] = {}
        for item in names:
            prefix = "Report/definition/pages/"
            if not item.startswith(prefix):
                continue
            suffix = item[len(prefix):]
            parts = suffix.split("/")
            if len(parts) == 2 and parts[1] == "page.json":
                pages_by_id[parts[0]] = json.loads(archive.read(item))
            elif len(parts) == 4 and parts[1] == "visuals" and parts[3] == "visual.json":
                visuals_by_page.setdefault(parts[0], []).append(item)

        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))["model"]
        glossary: list[dict[str, object]] = []
        estimates: list[dict[str, str]] = []
        measures: dict[str, dict[str, str]] = {}
        for table in model.get("tables", []):
            table_name = clean(table.get("name"))
            for measure in table.get("measures", []):
                name = clean(measure.get("name"))
                measures[name.lower()] = {
                    "name": name,
                    "table": table_name,
                    "expression": expression_text(measure.get("expression")),
                    "description": clean(measure.get("description")),
                }
            if table_name == "📖 Metric Glossary":
                rows = parse_datatable_rows(table.get("partitions", [{}])[0].get("source", {}).get("expression"))
                glossary = [
                    {
                        "page": row[0],
                        "pageDescription": row[1],
                        "metric": row[2],
                        "description": row[3],
                        "pageOrder": row[4],
                        "metricOrder": row[5],
                    }
                    for row in rows
                    if len(row) >= 6 and row[0] != "Page"
                ]
            if table_name == "Human Time Estimates":
                rows = parse_datatable_rows(table.get("partitions", [{}])[0].get("source", {}).get("expression"))
                estimates = [
                    {
                        "behavior": clean(row[0]),
                        "category": clean(row[5]),
                        "low": clean(row[8]),
                        "typical": clean(row[9]),
                        "high": clean(row[10]),
                        "grain": clean(row[11]),
                    }
                    for row in rows
                    if len(row) >= 12 and row[0] != "Behavior"
                ]

        pages: list[dict[str, object]] = []
        for page_id in order:
            page = pages_by_id.get(page_id)
            if not page:
                continue
            visuals: list[dict[str, object]] = []
            for path in sorted(visuals_by_page.get(page_id, [])):
                container = json.loads(archive.read(path))
                visual = container.get("visual", {})
                if not isinstance(visual, dict):
                    continue
                fields = projection_fields(visual)
                position = container.get("position", {})
                if not isinstance(position, dict):
                    position = {}
                visuals.append(
                    {
                        "type": clean(visual.get("visualType")) or "unknown",
                        "id": clean(container.get("name")),
                        "title": visual_title(visual, fields),
                        "position": {
                            key: round(float(position.get(key, 0) or 0), 2)
                            for key in ("x", "y", "width", "height", "z")
                        },
                        "fields": fields,
                        "hidden": bool(visual.get("isHidden") or container.get("isHidden")),
                        "bookmarkGroup": object_property(visual, "bookmarks", "bookmarkGroup"),
                        "selectedBookmark": object_property(visual, "bookmarks", "selectedBookmark"),
                        "bookmarkTarget": object_property(visual, "visualLink", "bookmark"),
                    }
                )
            view_groups: list[dict[str, object]] = []
            for visual in visuals:
                group_id = clean(visual.get("bookmarkGroup"))
                group = bookmark_groups.get(group_id)
                if not group:
                    continue
                views: list[dict[str, object]] = []
                for bookmark_id in group.get("children", []):
                    bookmark = bookmarks.get(clean(bookmark_id), {})
                    section_state = (
                        bookmark.get("explorationState", {})
                        .get("sections", {})
                        .get(page_id, {})
                    )
                    visual_states = section_state.get("visualContainers", {}) if isinstance(section_state, dict) else {}
                    hidden_ids = [
                        visual_id
                        for visual_id, visual_state in visual_states.items()
                        if isinstance(visual_state, dict)
                        and visual_state.get("singleVisual", {}).get("display", {}).get("mode") == "hidden"
                    ] if isinstance(visual_states, dict) else []
                    views.append(
                        {
                            "id": clean(bookmark_id),
                            "name": clean(bookmark.get("displayName")),
                            "hiddenVisualIds": hidden_ids,
                        }
                    )
                view_groups.append(
                    {
                        "id": group_id,
                        "name": clean(group.get("displayName")),
                        "selected": clean(visual.get("selectedBookmark")) or (views[0]["id"] if views else ""),
                        "views": views,
                    }
                )
            for visual in visuals:
                target_id = clean(visual.get("bookmarkTarget"))
                target = bookmarks.get(target_id)
                if target:
                    visual["bookmarkTarget"] = {
                        "id": target_id,
                        "pageId": clean(target.get("explorationState", {}).get("activeSection")),
                    }
            slicer_fields = sorted(
                {
                    field["label"]
                    for visual in visuals
                    if visual["type"] in ("slicer", "advancedSlicerVisual")
                    for field in visual["fields"]
                    if field["label"]
                }
            )
            pages.append(
                {
                    "id": page_id,
                    "name": clean(page.get("displayName")),
                    "width": int(page.get("width", 1280)),
                    "height": int(page.get("height", 720)),
                    "filters": slicer_fields,
                    "visuals": visuals,
                    "views": view_groups,
                }
            )
        return {
            "source": "5. Local CSV/ValueLens - Local CSV.pbit",
            "baseRevision": BASE_REVISION,
            "pages": pages,
            "glossary": glossary,
            "measures": measures,
            "estimates": estimates,
        }


def sample_fixture(estimates: list[dict[str, str]]) -> dict[str, object]:
    interactions = read_csv(SAMPLE_DIR / "copilot_interactions_sample.csv")
    users = read_csv(SAMPLE_DIR / "copilot_users_sample.csv")
    registry = read_csv(SAMPLE_DIR / "agents_365_sample.csv")
    feedback = read_csv(SAMPLE_DIR / "product_feedback_sample.csv")

    def user_key(row: dict[str, str]) -> str:
        return clean(
            row.get("Audit_UserId_Normalized")
            or row.get("Audit_UserId")
            or row.get("UserKey")
            or row.get("PersonId")
        ).lower()

    org_by_user: dict[str, str] = {}
    license_by_user: dict[str, int] = {}
    all_user_ids: set[str] = set()
    for person in users:
        key = clean(
            person.get("UserKey")
            or person.get("PersonId")
            or person.get("UserPrincipalName")
            or person.get("User Principal Name")
        ).lower()
        if key:
            all_user_ids.add(key)
            org_by_user[key] = clean(person.get("Organization"))
            license_by_user[key] = (
                0
                if clean(person.get("Has license") or person.get("License Status")).lower()
                in ("yes", "true", "1", "licensed", "m365 copilot licensed")
                else 1
            )
    user_ids = sorted(
        all_user_ids | {user_key(row) for row in interactions if user_key(row)}
    )
    user_index = {key: index for index, key in enumerate(user_ids)}
    for row in interactions:
        key = user_key(row)
        if key and key not in license_by_user:
            license_by_user[key] = 0 if clean(row.get("License Status")).lower() == "m365 copilot licensed" else 1
    org_names = sorted({org_by_user.get(key, "") for key in user_ids if org_by_user.get(key, "")})
    team_index = {value: index for index, value in enumerate(org_names)}
    source_agent_names = sorted(
        {
            clean(row.get("AgentName"))
            for row in interactions
            if clean(row.get("AgentName"))
        }
        | {
            clean(row.get("Agent name"))
            for row in registry
            if clean(row.get("Agent name"))
        }
    )
    agent_names = [f"Agent {index + 1:03d}" for index in range(len(source_agent_names))]
    agent_name_index = {value: index + 1 for index, value in enumerate(source_agent_names)}
    months = sorted(
        {
            month_for(row.get("InteractionDate") or row.get("CreationDate", ""))
            for row in interactions
        }
        | {month_for(row.get("Date Submitted UTC", "")) for row in feedback}
    )
    month_index = {value: index for index, value in enumerate(months)}
    behaviors = sorted({clean(row.get("Behavior_Enriched_Full")) for row in interactions if clean(row.get("Behavior_Enriched_Full"))})
    behavior_index = {value: index for index, value in enumerate(behaviors)}
    behavior_category: dict[str, str] = {}
    for estimate in estimates:
        behavior_category.setdefault(estimate["behavior"], estimate["category"])

    def tool_index(row: dict[str, str]) -> int:
        agent_filter = clean(row.get("Agent Filter")).lower()
        host = clean(row.get("AppHost")).lower()
        if "cowork" in agent_filter or "cowork" in host:
            return 2
        if agent_filter == "agents" or clean(row.get("AgentId")) or clean(row.get("AgentName")):
            return 1
        return 0

    cowork_resources: dict[str, set[str]] = {}
    for row in interactions:
        if tool_index(row) != 2:
            continue
        message = clean(row.get("Message_Id"))
        if message:
            cowork_resources.setdefault(message, set()).add(clean(row.get("AccessedResource_Type")).lower())

    def cowork_category(message: str) -> str:
        resource_types = "|".join(sorted(cowork_resources.get(message, set())))
        if "rfc822" in resource_types or "ms-outlook" in resource_types:
            return "Email workflows"
        if any(value in resource_types for value in ("spreadsheetml", "text/csv", "application/json", "application/xml", "application/pdf", "application/zip", "application/gzip")):
            return "Analysis & Research"
        if any(value in resource_types for value in ("wordprocessingml", "presentationml", "ms-powerpoint", "text/markdown", "text/html", "image/")):
            return "Document & content creation"
        if "message" in resource_types:
            return "Communication workflows"
        return "General assistance / Other"

    cowork_group = {
        "Email workflows": "Email",
        "Analysis & Research": "Data & Analysis",
        "Document & content creation": "Document Creation",
        "Communication workflows": "Collaboration & Workflows",
        "General assistance / Other": "General Chat & Q&A",
    }

    def task_values(row: dict[str, str]) -> tuple[str, str]:
        behavior = clean(row.get("Behavior_Enriched_Full"))
        if tool_index(row) == 2:
            detail = cowork_category(clean(row.get("Message_Id")))
            return cowork_group.get(detail, "General Chat & Q&A"), detail
        return behavior_category.get(behavior, ""), behavior

    task_values_by_row = [task_values(row) for row in interactions]
    tasks = sorted({group for group, _ in task_values_by_row if group})
    task_index = {value: index for index, value in enumerate(tasks)}
    task_details = sorted({detail for _, detail in task_values_by_row if detail})
    task_detail_index = {value: index for index, value in enumerate(task_details)}
    models = sorted({clean(row.get("AI_Model")) for row in interactions if clean(row.get("AI_Model"))})
    model_index = {value: index for index, value in enumerate(models)}
    session_keys = sorted(
        {
            (user_key(row), clean(row.get("AppHost")), clean(row.get("ThreadId")))
            for row in interactions
            if user_key(row) and clean(row.get("ThreadId"))
        }
    )
    session_index = {value: index for index, value in enumerate(session_keys)}

    compact_rows: list[list[object]] = []
    for row in interactions:
        key = user_key(row)
        month = month_for(row.get("InteractionDate") or row.get("CreationDate", ""))
        if not key or month not in month_index:
            continue
        agent_name = clean(row.get("AgentName"))
        tool = tool_index(row)
        license_index = 0 if clean(row.get("License Status")).lower() == "m365 copilot licensed" else 1
        task, task_detail = task_values(row)
        session = (key, clean(row.get("AppHost")), clean(row.get("ThreadId")))
        try:
            baseline = float(clean(row.get("Human_Baseline_Min")) or 0)
        except ValueError:
            baseline = 0
        compact_rows.append(
            [
                month_index[month],
                team_index.get(org_by_user.get(key, ""), -1),
                license_index,
                tool,
                agent_name_index.get(agent_name, 0),
                behavior_index.get(clean(row.get("Behavior_Enriched_Full")), -1),
                task_index.get(task, -1),
                model_index.get(clean(row.get("AI_Model")), -1),
                user_index[key],
                session_index.get(session, -1),
                1 if clean(row.get("Message_isPrompt")).upper() == "TRUE" else 0,
                baseline,
                task_detail_index.get(task_detail, -1),
            ]
        )

    feedback_types = sorted({clean(row.get("Feedback Type")) for row in feedback if clean(row.get("Feedback Type"))})
    feedback_type_index = {value: index for index, value in enumerate(feedback_types)}
    feedback_rows = [
        [month_index[month], feedback_type_index[clean(row.get("Feedback Type"))]]
        for row in feedback
        if (month := month_for(row.get("Date Submitted UTC", ""))) in month_index
        and clean(row.get("Feedback Type")) in feedback_type_index
    ]

    statuses = sorted({clean(row.get("Status")) for row in registry if clean(row.get("Status"))})
    types = sorted({clean(row.get("Agent type (A365)")) for row in registry if clean(row.get("Agent type (A365)"))})
    status_index = {value: index for index, value in enumerate(statuses)}
    type_index = {value: index for index, value in enumerate(types)}
    registry_rows = [
        [
            agent_name_index.get(clean(row.get("Agent name")), 0),
            type_index.get(clean(row.get("Agent type (A365)")), -1),
            status_index.get(clean(row.get("Status")), -1),
            1 if clean(row.get("Is Blocked")).lower() in ("true", "yes", "1") else 0,
        ]
        for row in registry
    ]

    return {
        "months": months,
        "teams": [f"Group {index + 1:02d}" for index in range(len(org_names))],
        "userTeams": [team_index.get(org_by_user.get(key, ""), -1) for key in user_ids],
        "userLicenses": [license_by_user.get(key, 1) for key in user_ids],
        "licenses": ["Licensed", "Unlicensed"],
        "tools": ["Copilot", "Agents", "Cowork"],
        "agents": ["Unattributed"] + [f"Agent {index + 1:03d}" for index in range(len(agent_names))],
        "behaviors": behaviors,
        "tasks": tasks,
        "taskDetails": task_details,
        "models": models,
        "people": [f"Person {index + 1:03d}" for index in range(len(user_ids))],
        "feedbackTypes": feedback_types,
        "registryStatuses": statuses,
        "registryTypes": types,
        "rows": compact_rows,
        "feedbackRows": feedback_rows,
        "registryRows": registry_rows,
        "peopleCount": len(user_ids),
        "agentCount": len(registry),
        "feedbackCount": len(feedback),
    }


def main() -> None:
    metadata = report_metadata()
    fixture = sample_fixture(metadata["estimates"])
    if len(metadata["pages"]) != 16:
        raise SystemExit(f"Expected 16 report pages; found {len(metadata['pages'])}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "styles.css", "app.js"):
        shutil.copyfile(SOURCE_DIR / name, OUTPUT_DIR / name)
    payload = json.dumps(
        {"report": metadata, "fixture": fixture},
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    (OUTPUT_DIR / "report-data.js").write_text(
        f"window.VALUE_LENS_REPORT_DEMO = {payload};\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"Built {len(metadata['pages'])} pages to {OUTPUT_DIR.relative_to(ROOT)}")
    print(f"Fixture: {len(fixture['rows'])} interactions, {fixture['peopleCount']} people, {fixture['agentCount']} agents")
    print(f"Feedback: {fixture['feedbackCount']} fabricated entries; no user identifiers are emitted")


if __name__ == "__main__":
    main()
