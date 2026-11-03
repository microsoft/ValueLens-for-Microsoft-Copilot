#!/usr/bin/env python3
"""Build a self-contained browser demo from the checked-in report and sample CSVs."""

from __future__ import annotations

import csv
import json
import re
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
                aggregation = field.get("Aggregation", {})
                if isinstance(aggregation, dict) and isinstance(aggregation.get("Expression"), dict):
                    field = aggregation["Expression"]
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
                    "aggregate": aggregation.get("Function") if isinstance(aggregation, dict) else None,
                }
            )
    return result


def filter_predicates(container):
    result = []
    def scalar(value):
        if value == "null":
            return None
        if value in ("true", "false"):
            return value == "true"
        if value.startswith("'"):
            return value[1:-1].replace("''", "'")
        return float(value.rstrip("LD"))
    for entry in container.get("filterConfig", {}).get("filters", []):
        query = entry.get("filter", {})
        tables = {item["Name"]: item["Entity"] for item in query.get("From", [])}
        for clause in query.get("Where", []):
            condition = clause.get("Condition", {})
            negate = "Not" in condition
            condition = condition.get("Not", {}).get("Expression", condition) if negate else condition
            if "In" in condition:
                body = condition["In"]
                field = body["Expressions"][0]
                values = [item[0]["Literal"]["Value"] for item in body["Values"]]
                operation = "notIn" if negate else "in"
            elif "Comparison" in condition:
                body = condition["Comparison"]
                field = body["Left"]
                values = [body["Right"]["Literal"]["Value"]]
                operation = f"compare{body['ComparisonKind']}"
            elif "Contains" in condition:
                body = condition["Contains"]
                field = body["Left"]
                values = [body["Right"]["Literal"]["Value"]]
                operation = "notContains" if negate else "contains"
            else:
                raise ValueError(f"Unimplemented source visual predicate: {condition}")
            aggregate = field.get("Aggregation", {}).get("Function")
            field = field.get("Aggregation", {}).get("Expression", field)
            kind = "measure" if "Measure" in field else "column"
            detail = field.get("Measure", field.get("Column", {}))
            source = detail.get("Expression", {}).get("SourceRef", {})
            result.append({
                "table": source.get("Entity", tables.get(source.get("Source"), "")),
                "name": detail["Property"], "kind": kind, "aggregate": aggregate,
                "operation": operation,
                "values": [scalar(value) for value in values],
            })
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
        behaviors = []
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
                    "format": clean(measure.get("formatString")),
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
                        "baseline": clean(row[1]),
                        "source": clean(row[3]),
                        "category": clean(row[5]),
                        "valueOutcome": clean(row[6]),
                        "coworkCategory": clean(row[7]),
                        "low": clean(row[8]),
                        "typical": clean(row[9]),
                        "high": clean(row[10]),
                        "grain": clean(row[11]),
                    }
                    for row in rows
                    if len(row) >= 12 and row[0] != "Behavior"
                ]
            if table_name == "Behavior Value Map":
                rows = parse_datatable_rows(table.get("partitions", [{}])[0].get("source", {}).get("expression"))
                behaviors = [
                    dict(zip(("signal", "behavior", "useCase", "valueOutcome", "description"), row[:5]))
                    for row in rows if len(row) >= 5 and row[0] != "Signal"
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
                        "parent": clean(container.get("parentGroupName")),
                        "isGroup": "visualGroup" in container,
                        "predicates": filter_predicates(container),
                        "sorts": [
                            {
                                "name": item.get("field", {}).get("Measure", item.get("field", {}).get("Column", {})).get("Property", ""),
                                "direction": item.get("direction", "Ascending"),
                            }
                            for item in visual.get("query", {}).get("sortDefinition", {}).get("sort", [])
                        ],
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
                    visibility = {
                        visual_id: visual_state["singleVisual"].get("display", {}).get("mode") != "hidden"
                        for visual_id, visual_state in visual_states.items()
                        if isinstance(visual_state, dict) and "singleVisual" in visual_state
                    } if isinstance(visual_states, dict) else {}
                    visibility.update({
                        group_id: not group_state.get("isHidden", False)
                        for group_id, group_state in section_state.get("visualContainerGroups", {}).items()
                    })
                    views.append(
                        {
                            "id": clean(bookmark_id),
                            "name": clean(bookmark.get("displayName")),
                            "hiddenVisualIds": hidden_ids,
                            "visibility": visibility,
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
                    "predicates": filter_predicates(page),
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
            "behaviors": behaviors,
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
            (
                user_key(row),
                "Teams" if clean(row.get("AppHost")) == "Microsoft Teams" else clean(row.get("AppHost")),
                clean(row.get("ThreadId")),
            )
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
        prompt_row = clean(row.get("Message_isPrompt")).upper() in ("TRUE", "1")
        observed_prompt = (
            prompt_row
            and bool(key)
            and bool(clean(row.get("Message_Id")))
            and bool(clean(row.get("ThreadId")))
        )
        usage_row = prompt_row or "cowork" in clean(row.get("AppHost")).lower()
        task, task_detail = task_values(row)
        app_host = clean(row.get("AppHost"))
        session = (key, "Teams" if app_host == "Microsoft Teams" else app_host, clean(row.get("ThreadId")))
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
                1 if prompt_row else 0,
                baseline,
                task_detail_index.get(task_detail, -1),
                1 if observed_prompt else 0,
                1 if usage_row else 0,
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
        "sourceRecords": sanitized_records(interactions, users, registry, feedback),
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


def sanitized_records(interactions, users, agents, feedback):
    user_ids = sorted({clean(r.get("Audit_UserId")).lower() for r in interactions} |
                      {clean(r.get("PersonId")).lower() for r in users})
    person = {key: f"person{index + 1:03d}" for index, key in enumerate(user_ids) if key}
    org = {key: f"Group {index + 1:02d}" for index, key in enumerate(
        sorted({clean(r.get("Organization")) for r in users if clean(r.get("Organization"))}))}
    names = sorted({clean(r.get("AgentName")) for r in interactions if clean(r.get("AgentName"))} |
                   {clean(r.get("Agent name")) for r in agents if clean(r.get("Agent name"))})
    agent_names = {key: f"Agent {index + 1:03d}" for index, key in enumerate(names)}
    creators = {key: f"Creator {index + 1:03d}" for index, key in enumerate(
        sorted({clean(r.get("Agent creator")) for r in agents if clean(r.get("Agent creator"))}))}
    source_ids = {
        clean(row.get(key)) for row in interactions
        for key in ("ThreadId", "Message_Id", "AgentId", "Agent_TitleID", "Agent_EntraId")
    } | {clean(row.get(key)) for row in agents for key in ("Title ID", "Entra Agent ID")}
    ids = {value: f"synthetic-{index + 1:06d}" for index, value in enumerate(sorted(source_ids - {""}))}

    def identifier(value):
        value = clean(value)
        if not value:
            return ""
        if value not in ids:
            ids[value] = f"synthetic-{len(ids) + 1:06d}"
        return ids[value]

    interaction_fields = (
        "CreationDate", "AppHost", "Context_Type", "Message_isPrompt", "AccessedResource_Type",
        "AccessedResource_Action", "Behavior_Enriched_Full", "Behavior_Category", "Value_Outcome",
        "WeekStart", "InteractionDate", "MonthStart", "Usage_Mode", "Expertise_Role", "Efficiency_Breakdown",
        "License Status", "Environment", "AI_Model", "Behavior_Plausible", "Is_Agent_Activity", "Agent_Type",
    )
    safe_interactions = []
    for row in interactions:
        safe = {key: clean(row.get(key)) for key in interaction_fields}
        safe["Audit_UserId"] = person.get(clean(row.get("Audit_UserId")).lower(), "")
        safe["AgentName"] = agent_names.get(clean(row.get("AgentName")), "")
        for key in ("ThreadId", "Message_Id", "AgentId", "Agent_TitleID", "Agent_EntraId"):
            safe[key] = identifier(row.get(key))
        safe_interactions.append(safe)
    safe_users = [{
        "PersonId": person[clean(row["PersonId"]).lower()],
        "Organization": org.get(clean(row.get("Organization")), ""),
        "Has license": clean(row.get("Has license")),
    } for row in users if clean(row.get("PersonId"))]
    agent_fields = (
        "Supported in", "Created in", "Last updated", "Can read OneDrive files",
        "Can read Sharepoint sites and files", "Can extend to Graph connector",
        "Can generate images using user prompt", "Can use code interpreter", "Contains uploaded files",
        "Can read OneDrive and Sharepoint items", "Status", "Is Blocked", "Agent creator source",
        "Agent type (A365)",
    )
    safe_agents = []
    agent_users = {}
    for row in interactions:
        agent_users.setdefault(clean(row.get("AgentName")), set()).add(clean(row.get("Audit_UserId")).lower())
    for row in agents:
        safe = {key: clean(row.get(key)) for key in agent_fields}
        safe.update({
            "Agent name": agent_names.get(clean(row.get("Agent name")), ""),
            "Agent creator": creators.get(clean(row.get("Agent creator")), ""),
            "Agent description": "Invented agent for the offline demonstration.",
            "Title ID": identifier(row.get("Title ID")),
            "Entra Agent ID": identifier(row.get("Entra Agent ID")),
            "Total Users": str(len(agent_users.get(clean(row.get("Agent name")), set()))),
        })
        safe_agents.append(safe)
    # Generate local, non-identifying feedback text instead of exporting free-form comments.
    safe_feedback = []
    for index, row in enumerate(feedback):
        safe_feedback.append({
            "Date Submitted UTC": clean(row.get("Date Submitted UTC")),
            "Feedback Type": clean(row.get("Feedback Type")),
            "App": clean(row.get("App")),
            "Comment": ("Useful reporting dashboard" if index % 3 == 0 else
                        "Email draft was helpful" if index % 3 == 1 else "Training answer needs improvement"),
        })
    return {"interactions": safe_interactions, "users": safe_users,
            "agents": safe_agents, "feedback": safe_feedback}


def main() -> None:
    metadata = report_metadata()
    fixture = sample_fixture(metadata["estimates"])
    if len(metadata["pages"]) != 16:
        raise SystemExit(f"Expected 16 report pages; found {len(metadata['pages'])}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "styles.css", "app.js"):
        with (OUTPUT_DIR / name).open("w", encoding="utf-8", newline="\n") as output:
            output.write((SOURCE_DIR / name).read_text(encoding="utf-8"))
    payload = json.dumps(
        {"report": metadata, "fixture": fixture},
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    with (OUTPUT_DIR / "report-data.js").open("w", encoding="utf-8", newline="\n") as output:
        output.write(f"window.VALUE_LENS_REPORT_DEMO = {payload};\n")
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8").strip()
    notice = (
        "# License and third-party notices\n\n"
        "This browser-native report port has no third-party runtime dependencies. "
        "The source repository MIT license applies:\n\n"
        f"## MIT License\n\n{license_text}\n"
    )
    with (OUTPUT_DIR / "THIRD_PARTY_NOTICES.md").open("w", encoding="utf-8", newline="\n") as output:
        output.write(notice)
    print(f"Built {len(metadata['pages'])} pages to {OUTPUT_DIR.relative_to(ROOT)}")
    print(f"Fixture: {len(fixture['rows'])} interactions, {fixture['peopleCount']} people, {fixture['agentCount']} agents")
    print(f"Feedback: {fixture['feedbackCount']} fabricated entries; no user identifiers are emitted")


if __name__ == "__main__":
    main()
