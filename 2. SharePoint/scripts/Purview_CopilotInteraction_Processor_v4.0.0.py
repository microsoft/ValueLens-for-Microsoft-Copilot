#!/usr/bin/env python3
"""
Purview CopilotInteraction Processor v4.0.0
-------------------------------------------
Two-input / two-output preprocessor for the AI Business Value Dashboard
and AI-in-One Rollup PBIPs.

Output profiles (--profile):
    aibv  (default) : AI Business Value Dashboard. 50-column fact superset —
                      3-value Environment {Cowork, Licensed, Unlicensed},
                      all DAX calc-columns pre-computed (Behavior_*, Usage_Mode,
                      Expertise_Role, Efficiency_Breakdown, Human_Baseline_Min,
                      Behavior_Plausible, Workflow_Action, Delegation_Event_Key,
                      Is_Agent_Activity/Web_Grounded_Signal promoted into the
                      grain for sliceability) + Audit_UserId passthrough.
    aio             : AI-in-One Dashboard. 36-column fact — 5-value Environment
                      {Autonomous Agent, Cowork, Agents, Licensed M365 Copilot,
                      Unlicensed Chat}. Reproduces the v3.1.0 AIO output
                      BYTE-IDENTICALLY (validated), so the AIO dashboard is
                      unaffected. ~41% smaller than the aibv fact.

Inputs:
    --purview <raw Purview audit log CSV>     (required)
    --entra   <Entra users CSV w/ licensing>  (required)

Outputs (in --out-dir, default = directory of --purview):
    <purview_stem>_Interactions_<YYYYMMDD_HHMMSS>.csv   (fact table)
    <entra_stem>_Users_<YYYYMMDD_HHMMSS>.csv            (dim table)

    These two files are all the AIBV template needs. Pass --with-aggregates
    (aibv only) to ALSO write 5 pre-aggregated tables for a future calc-table
    offload:
        <purview_stem>_ActiveDaysSummary_<ts>.csv
        <purview_stem>_UserMonthMetrics_<ts>.csv
        <purview_stem>_LicensedUserRankings_<ts>.csv
        <purview_stem>_UnlicensedUserRankings_<ts>.csv
        <purview_stem>_LicensedUserSummary_<ts>.csv

Grain:
    One row per (16-column grain x Message_Id; aibv adds 3 sliceable flag
    keys -> 19). DAX measures use DISTINCTCOUNT(Message_Id) which yields exact
    parity with the semantic-model definitions at every visual / slicer
    combination. Per-resource accumulation is intentionally avoided so counts
    are
    not inflated (~2.25x) by per (prompt x AccessedResource) iteration.

INT-surrogated columns (perf):
    Message_Id, ThreadId, and UserKey (replaces Audit_UserId) are emitted
    as 1-based INTs assigned in input encounter order. Cuts CSV size,
    parse time, AND VertiPaq dictionary build time on the three highest-
    cardinality GUID columns. UserKey is written to BOTH the fact CSV
    and the Users dim CSV (same shared map keyed on normalized UPN), so
    the fact↔Users relationship is INT-to-INT. DISTINCTCOUNT semantics
    are identical between INT and string surrogates of the same set.
    UserMonthKey stays string (cross-processor blast radius).

Calc cols ported from DAX -> precomputed here for ingestion-time speedup:
    Agent_TitleID, Behavior_Source, Value_Outcome, ActivityDate
    (= InteractionDate alias).

Stays in DAX (cross-table dependencies that cannot be precomputed without
shipping Agents 365 / UserMonthMetrics / AgentMetrics into the processor):
    Behavior_Enriched_Full (RELATED Agents 365),
    User_Stage_Maturity / User_Stage (RELATED UserMonthMetrics),
    Usage_Mode, Expertise_Role, Efficiency_Breakdown
    (all depend on Behavior_Enriched_Full),
    Agent Last Used Date (LOOKUPVALUE AgentMetrics).

Requirements:
    Python 3.9+
    pip install orjson   (OPTIONAL - faster JSON parsing; falls back to stdlib json)
"""

from __future__ import annotations

import argparse
import csv
import functools
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import orjson

    def json_loads(value: str | bytes) -> Any:
        if isinstance(value, str):
            value = value.encode("utf-8")
        return orjson.loads(value)

    _JSON_ENGINE = "orjson"
except ImportError:
    import json as _json

    def json_loads(value: str | bytes) -> Any:
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        return _json.loads(value)

    _JSON_ENGINE = "json (stdlib)"


SCRIPT_VERSION = "4.0.0"

# ---------------------------------------------------------------------------
# Output schemas — TWO PROFILES
#
#   --profile aio   : reproduces the v3.1.0 AIO-faithful output EXACTLY
#                     (36-col fact, 5-value Environment vocabulary). This is
#                     the contract the AI-in-One dashboard already consumes;
#                     it must remain byte-identical to v3.1.0.
#   --profile aibv  : the AIBV-faithful superset (50-col fact, 3-value
#                     Environment, all offloaded calc cols + grain-promoted
#                     sliceable flags) built in this v4.0.0 effort.
#
# Both share one classification CODEBASE; the per-profile vocabulary is
# selected by the `profile` argument threaded through the classifiers.
# ---------------------------------------------------------------------------

# Common grain prefix (identical in both profiles).
_GRAIN_KEYS_COMMON: tuple[str, ...] = (
    "UserKey",
    "InteractionDate",
    "AgentId",
    "AgentName",
    "AppHost",
    "Environment",
    "License Status",
    "Context_Type",
    "Behavior_Category",
    "Behavior_Enriched",
    "AI_Model",
    "Is_Sensitive",
    "Autonomy_Pattern",
    "AppIdentity_AppId",
    "AISystemPlugin_Name",
    "ThreadId",
)

# AIO grain = the common 16 (matches v3.1.0 exactly).
GRAIN_KEYS_AIO: tuple[str, ...] = _GRAIN_KEYS_COMMON

# AIBV grain = common 16 + 3 promoted per-resource flags (sliceability fix).
GRAIN_KEYS_AIBV: tuple[str, ...] = _GRAIN_KEYS_COMMON + (
    # Promoted into the grain (sliceability fix): computed per-resource and
    # bound to AIBV slicers/filters, so they MUST be grain-faithful. Validated
    # at 0.000% row inflation on real data.
    "Is_Agent_Activity",
    "Web_Grounded_Signal",
    "Workflow_Action",
)

# AIO non-grain carried attrs = exactly the v3.1.0 set (ends at ActivityDate).
_NONGRAIN_ATTRS_AIO: tuple[str, ...] = (
    "CreationDate",
    "WeekStart",
    "MonthStart",
    "UserMonthKey",
    "Has license",
    "Resource_Count",
    "SensitivityLabelId",
    "AccessedResource_Type",
    "AccessedResource_Action",
    "AccessedResource_SiteUrl",
    "AccessedResource_SensitivityLabelId",
    "AppIdentity_DisplayName",
    "AISystemPlugin_Id",
    "ModelTransparencyDetails_ModelName",
    "Agent_TitleID",
    "Message_isPrompt",
    # Calc cols ported from DAX (present in AIO since v3.1.0)
    "Behavior_Source",
    "Value_Outcome",
    "ActivityDate",
)

# AIBV non-grain carried attrs = AIO set + AIBV-only offloaded columns.
_NONGRAIN_ATTRS_AIBV: tuple[str, ...] = _NONGRAIN_ATTRS_AIO + (
    # M1: UPN passthrough for AIBV joins + DISTINCTCOUNT.
    "Audit_UserId",
    "Audit_UserId_Normalized",
    # AIBV-faithful row-level flags. (Is_Agent_Activity / Web_Grounded_Signal /
    # Workflow_Action were promoted into GRAIN_KEYS_AIBV.) `Agent Filter`
    # derives from Is_Agent_Activity, so it stays a grain-consistent carried attr.
    "Agent Filter",
    "Agent Publish Status",
    # Downstream classification chain (offloaded; faithful without Agents 365 per F2).
    "Behavior_Enriched_Full",
    "Usage_Mode",
    "Expertise_Role",
    "Efficiency_Breakdown",
    # ROI baseline pre-join (offloads the Human Equivalent Hours SUMX+RELATED).
    "Human_Baseline_Min",
    # Remaining row-level calc cols (offloaded).
    "Behavior_Plausible",
    "Delegation_Event_Key",
)

# Final fact CSV schemas. One row per (grain x Message_Id). Message_Id is
# emitted as a sequential INT surrogate (1-based, assigned in input order).
FACT_HEADER_AIO: list[str] = list(GRAIN_KEYS_AIO) + ["Message_Id"] + list(_NONGRAIN_ATTRS_AIO)
FACT_HEADER_AIBV: list[str] = list(GRAIN_KEYS_AIBV) + ["Message_Id"] + list(_NONGRAIN_ATTRS_AIBV)


def schema_for(profile: str) -> tuple[tuple[str, ...], tuple[str, ...], list[str]]:
    """Return (grain_keys, nongrain_attrs, fact_header) for the profile."""
    if profile == "aio":
        return GRAIN_KEYS_AIO, _NONGRAIN_ATTRS_AIO, FACT_HEADER_AIO
    return GRAIN_KEYS_AIBV, _NONGRAIN_ATTRS_AIBV, FACT_HEADER_AIBV

# Entra column-name aliases used by the existing PBIP M-code. We mirror the
# same renaming so the dim CSV is drop-in compatible with all downstream DAX.
UPN_VARIANTS_NORMALIZED = {"userprincipalname", "upn", "personid"}
DEPARTMENT_VARIANT_NORMALIZED = "department"
JOBTITLE_RAW_NAME = "jobTitle"  # exact-match rename to "JobTitle"
HAS_LICENSE_VARIANTS = (
    "Has license",
    "Has License",
    "hasLicense",
    "HasLicense",
    "Has Copilot License",
    "Has Copilot license",
    "HasCopilotLicense",
    "Has Copilot License Assigned",
    "Has Copilot license assigned",
    "isUser",
)

# ---------------------------------------------------------------------------
# Datetime helpers
# ---------------------------------------------------------------------------

_CREATION_TIME_FORMATS: tuple[str, ...] = (
    "%Y-%m-%dT%H:%M:%S.%fZ",
    "%Y-%m-%dT%H:%M:%SZ",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %H:%M:%S",
)


def safe_get(obj: Any, key: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def get_array(obj: Any, key: str) -> list[Any]:
    value = safe_get(obj, key)
    return value if isinstance(value, list) else []


def to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def normalize_user_id(value: Any) -> str:
    return to_text(value).strip().lower()


# Non-human/system identities found in Purview audit logs (Teams Sync, SharePoint app,
# SupervisoryReview bots, ServicePrincipals, NT-style accounts, SIDs, bare GUIDs, etc.).
# These have no matching userPrincipalName in EntraUsers and would render as blank
# User/Department rows in downstream visuals. Filter out before any record is emitted.
_UPN_LOCAL_RE = re.compile(r"^[^\s\\@]+$")
_BARE_GUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _is_human_upn(uid: str) -> bool:
    """True iff uid is a syntactically valid human UPN (local@domain.tld), excluding
    well-known service/bot patterns (SupervisoryReview{...}@..., bare GUIDs)."""
    if not uid:
        return False
    s = uid.strip()
    if _BARE_GUID_RE.match(s):
        return False
    if s.lower().startswith("supervisoryreview{"):
        return False
    if "@" not in s or s.count("@") != 1:
        return False
    local, domain = s.split("@", 1)
    if not _UPN_LOCAL_RE.match(local):
        return False
    if "." not in domain or not domain or domain.startswith(".") or domain.endswith("."):
        return False
    return True


def parse_creation_time(value: Any) -> datetime | None:
    raw = to_text(value).strip()
    if not raw:
        return None
    return _parse_creation_time_cached(raw)


@functools.lru_cache(maxsize=None)
def _parse_creation_time_cached(raw: str) -> datetime | None:
    # Fast path: ISO 8601 (covers ~100% of Purview audit timestamps).
    # datetime.fromisoformat is ~10x faster than strptime and avoids the
    # locale lookup that strptime performs on every call. Python 3.11+
    # accepts a trailing "Z"; for 3.10 and earlier we strip it.
    try:
        if raw.endswith("Z"):
            try:
                return datetime.fromisoformat(raw)
            except ValueError:
                return datetime.fromisoformat(raw[:-1])
        return datetime.fromisoformat(raw)
    except ValueError:
        pass
    # Slow path: legacy non-ISO formats kept for backwards compat with
    # older / hand-edited audit exports.
    for fmt in _CREATION_TIME_FORMATS:
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def format_creation_date(value: Any) -> str:
    parsed = parse_creation_time(value)
    if parsed is None:
        raw = to_text(value).strip()
        if len(raw) >= 10 and raw[4:5] == "-":
            return raw[:10] + "T00:00:00.000Z"
        return raw
    return parsed.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")


def interaction_date(parsed: datetime | None) -> str:
    return parsed.strftime("%Y-%m-%d") if parsed else ""


def week_start(parsed: datetime | None) -> str:
    if parsed is None:
        return ""
    return (parsed - timedelta(days=parsed.weekday())).strftime("%Y-%m-%d")


def month_start(parsed: datetime | None) -> str:
    if parsed is None:
        return ""
    return parsed.replace(day=1).strftime("%Y-%m-%d")


# Cached bundle: given a raw timestamp string, return all 4 derived date
# strings in one shot. Avoids 4x strftime + tzinfo replace per record. The
# distinct raw-timestamp count in a typical dataset is small relative to
# input row count (many records share the same audit timestamp at the
# second granularity), so this collapses ~4N strftime calls to ~K where
# K is the distinct timestamp count.
@functools.lru_cache(maxsize=None)
def _date_strings_for_raw(raw: str) -> tuple[str, str, str, str]:
    """
    Returns (creation_date_iso_z, interaction_date, week_start, month_start)
    for the given raw timestamp string. Empty string is returned for any
    field that cannot be derived (matches non-cached helper semantics).
    """
    if not raw:
        return ("", "", "", "")
    parsed = _parse_creation_time_cached(raw)
    if parsed is None:
        if len(raw) >= 10 and raw[4:5] == "-":
            return (raw[:10] + "T00:00:00.000Z", "", "", "")
        return (raw, "", "", "")
    # Direct f-string formatting is ~10x faster than strftime (which does
    # locale lookup + format-string parsing on every call). Output bytes
    # are byte-identical to the prior strftime("%Y-%m-%d") output for any
    # year in [1000, 9999] (CreationTime range).
    y = parsed.year
    m = parsed.month
    d = parsed.day
    creation = f"{y:04d}-{m:02d}-{d:02d}T00:00:00.000Z"
    interaction = f"{y:04d}-{m:02d}-{d:02d}"
    # Week start (Monday-based, mirroring strftime((parsed-weekday).strftime))
    ws = parsed - timedelta(days=parsed.weekday())
    week = f"{ws.year:04d}-{ws.month:02d}-{ws.day:02d}"
    month = f"{y:04d}-{m:02d}-01"
    return (creation, interaction, week, month)


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip())
    return slug.strip("-")


# ---------------------------------------------------------------------------
# Audit JSON shaping
# ---------------------------------------------------------------------------


def app_identity_values(audit_data: dict[str, Any]) -> tuple[str, str]:
    app_identity = safe_get(audit_data, "AppIdentity")
    if isinstance(app_identity, str):
        return "", app_identity
    if isinstance(app_identity, dict):
        return (
            to_text(safe_get(app_identity, "AppId")),
            to_text(safe_get(app_identity, "DisplayName")),
        )
    return "", ""


def derive_agent_name(agent_name: Any, app_identity_display: str, app_identity_app_id: str) -> str:
    # Match the BEFORE PBIP behavior: AgentName comes straight from the audit JSON.
    # Do NOT synthesize from AppIdentity when it's blank — that fabricates distinct
    # agent identities (e.g. "Copilot-Studio-Default-<tenantGuid>-<agentGuid>") that
    # don't exist in the raw data and inflate Active Agents / per-agent rollups.
    return to_text(agent_name).strip()


def derive_agent_title_id(agent_id: Any) -> str:
    agent_id_text = to_text(agent_id).strip()
    if not agent_id_text:
        return ""
    return agent_id_text.rsplit(".", 1)[-1]


def first_dict_item(items: list[Any]) -> dict[str, Any]:
    for item in items:
        if isinstance(item, dict):
            return item
    return {}


def prompt_messages(ced: dict[str, Any]) -> list[dict[str, Any]]:
    prompts: list[dict[str, Any]] = []
    for message in get_array(ced, "Messages"):
        if isinstance(message, dict) and message.get("isPrompt") is True:
            prompts.append(message)
    return prompts


def resource_rows(ced: dict[str, Any]) -> list[dict[str, Any]]:
    resources = [item for item in get_array(ced, "AccessedResources") if isinstance(item, dict)]
    return resources if resources else [{}]


def is_copilot_interaction(audit_data: dict[str, Any], raw_row: dict[str, Any]) -> bool:
    operation = to_text(
        safe_get(audit_data, "Operation")
        or raw_row.get("Operation")
        or raw_row.get("Operations")
    ).strip()
    return operation == "CopilotInteraction"


# ---------------------------------------------------------------------------
# Classification logic (ports of the PBIP DAX calc columns)
# ---------------------------------------------------------------------------

_LICENSE_TRUTHY = {"YES", "TRUE", "Y", "1"}
_ACTIVE_RES_ACTION_TOKENS = ("send", "draft", "create", "post", "invoke", "write", "patch", "execute")


def normalize_has_license(raw: str) -> str:
    """Normalize any truthy/falsy variant to canonical 'TRUE' / 'FALSE'.

    Existing PBIP measures filter with literal `[Has license] = "FALSE"`, so
    we canonicalize here to guarantee those filters match regardless of how
    the upstream Entra/PAX export rendered the value.
    """
    val = (raw or "").strip().upper()
    if val in _LICENSE_TRUTHY:
        return "TRUE"
    if val in {"NO", "FALSE", "N", "0"}:
        return "FALSE"
    return "FALSE"


@functools.lru_cache(maxsize=None)
def compute_license_status(has_license_raw: str) -> str:
    val = (has_license_raw or "").strip().upper()
    return "M365 Copilot Licensed" if val in _LICENSE_TRUTHY else "Unlicensed"


@functools.lru_cache(maxsize=None)
def compute_environment(profile: str, has_license_raw: str, agent_name: str, agent_id: str, app_host: str) -> str:
    license_val = (has_license_raw or "").strip().upper()
    if profile == "aio":
        # v3.1.0 AIO vocabulary (5-value, keyed off app_host + agent presence).
        host = (app_host or "").lower()
        has_agent = bool((agent_name or "").strip()) or bool((agent_id or "").strip())
        if host in {"autonomous", "logic app"}:
            return "Autonomous Agent"
        if "cowork" in host:
            return "Cowork"
        if has_agent:
            return "Agents"
        if license_val in _LICENSE_TRUTHY:
            return "Licensed M365 Copilot"
        return "Unlicensed Chat"
    # AIBV vocabulary (verbatim port of current AIBV calc col `Environment`):
    #   IF(CONTAINSSTRING(LOWER(TRIM(AgentName)),"cowork"),"Cowork",
    #   IF(isLicensed,"Licensed","Unlicensed"))
    if "cowork" in (agent_name or "").strip().lower():
        return "Cowork"
    if license_val in _LICENSE_TRUTHY:
        return "Licensed"
    return "Unlicensed"


@functools.lru_cache(maxsize=None)
def compute_is_sensitive(sens_label: str, resource_sens_label: str) -> str:
    return "TRUE" if (sens_label or "").strip() or (resource_sens_label or "").strip() else "FALSE"


@functools.lru_cache(maxsize=None)
def compute_ai_model(model_name: str) -> str:
    m = (model_name or "").upper()
    if not m or m == "NULL":
        return "Embedded App (no model logged)"
    if "DEEP_LEO" in m:
        return "GPT-4 (Standard)"
    if "REASONING" in m:
        return "Reasoning Model (o1/o3)"
    if "OFFENSIVE" in m:
        return "Safety Filter (blocked)"
    if "GPT-41" in m or "GPT-4.1" in m:
        return "GPT-4.1 (Next Gen)"
    if "O3-MINI" in m or "O3MINI" in m:
        return "o3-mini (Reasoning)"
    if "O3" in m or "O1" in m:
        return "Reasoning Model (o-series)"
    if "GPT-5" in m or "GPT5" in m:
        return "GPT-5 (Next Gen)"
    if "CLAUDE" in m:
        return "Claude (Anthropic)"
    if "GEMINI" in m:
        return "Gemini (Google)"
    if "LLAMA" in m or "META" in m:
        return "LLaMA (Meta)"
    if "PHI" in m:
        return "Phi (Microsoft Small Model)"
    return model_name or ""


def _resource_behavior(
    profile: str, res_type: str, res_action: str, site_url: str, is_active: bool
) -> str:
    if res_action in {"sendemailv2", "draftemail", "senddraftemail", "updatedraftemail"}:
        return "Email Drafting"
    if res_type == "emailmessage":
        return "Email Drafting" if is_active else "Email Summarising"
    if res_action == "mcp_meetingmanagement":
        return "Meeting Scheduling"
    if res_type in {"event", "teamsmeeting"}:
        return "Meeting Prep"
    if res_action in {"postmessagetoconversation", "createchat"}:
        return "Teams Messaging"
    if res_type in {"teamsmessage", "teamschat", "teamschannel"}:
        return "Teams Messaging"
    if profile == "aio":
        # v3.1.0: any flow/connector/http resource -> "Workflow Execution".
        if res_type in {"flow", "connector", "http"}:
            return "Workflow Execution"
    else:
        # AIBV: explicit Flow always; connector/http only with an active verb.
        if res_type == "flow":
            return "Running a Workflow"
        if res_type in {"connector", "http"} and is_active:
            return "Running a Workflow"
    if res_action in {"executedatasetquery", "getitems", "getalltables", "gettableviews"}:
        return "Data Querying"
    if res_type in {"xlsx", "csv", "xlsm", "xlsb", "xls"}:
        return "Excel Assistance" if is_active else "Spreadsheet Review"
    if res_type == "peopleinferenceanswer":
        return "People Lookup"
    if res_type in {"listitem", "aspx"}:
        return "Enterprise Searching"
    if res_type == "websearchquery":
        return "Web Searching"
    if res_type == "pdf":
        return "PDF Analysis"
    if res_type in {"py", "js", "java", "tsx", "jsx", "css", "php", "sh"} and is_active:
        return "Code Writing"
    if res_type in {"py", "sql", "js", "java", "json", "xml", "html", "yaml", "yml", "txt"}:
        return "Code Analysis"
    if res_type in {"png", "jpg", "jpeg", "svg", "gif"} and is_active:
        return "Image Generation"
    if res_type in {"png", "jpg", "jpeg", "gif"}:
        return "Image / Media Analysis"
    if res_type in {"streamvideo", "mp4", "mov", "webm", "mkv"}:
        return "Video Summarising"
    if res_type in {"planid", "taskids"}:
        return "Task Management"
    if res_type == "looppage":
        return "Real-time Collaboration"
    if res_type == "http://schema.skype.com/hyperlink":
        for token in ("github.com", "stackoverflow.com", "npmjs.com", "pypi.org", "docker.com", "kubernetes.io", "leetcode.com"):
            if token in site_url:
                return "Code Analysis"
        for token in ("learning.cloud.microsoft", "coursera.org", "udemy.com"):
            if token in site_url:
                return "Agent: Coaching"
        if "sharepoint.com" in site_url:
            return "Enterprise Searching"
        return "Web Searching"
    if res_type in {"external", "http"}:
        return "Web Searching"
    if res_type in {"docx", "doc", "rtf"}:
        if is_active:
            return "Document Drafting"
        if res_action == "read":
            return "File Retrieval"
        return "Document Summarising"
    if res_type in {"pptx", "ppt", "potx"}:
        if is_active:
            return "Presentation Creation"
        if res_action == "read":
            return "File Retrieval"
        return "Presentation Summarising"
    if "service-now.com" in site_url or "servicenow.com" in site_url:
        return "Agent: IT & Service Desk"
    if "dynamics.com" in site_url:
        return "Agent: Sales & Customer"
    return ""


def _context_behavior(profile: str, app_host: str, ctx_type: str, is_active: bool, has_agent: bool) -> str:
    if ctx_type == "teamsmeeting":
        return "Meeting Prep"
    if ctx_type == "streamvideo":
        return "Video Summarising"
    if ctx_type == "docx":
        return "Document Drafting" if (app_host == "word" and is_active) else "Document Summarising"
    if ctx_type in {"xlsx", "xlsm", "xlsb", "xls", "csv"}:
        return "Spreadsheet Review"
    if ctx_type in {"pptx", "pptm"}:
        return "Presentation Creation" if (app_host == "powerpoint" and is_active) else "Presentation Summarising"
    if ctx_type in {"teamschat", "teamschannel"}:
        return "Teams Messaging"
    if ctx_type == "aspx":
        return "Enterprise Searching"
    if app_host in {"outlook", "outlooksidepane"}:
        return "Email Drafting" if is_active else "Email Summarising"
    if app_host == "excel":
        return "Excel Assistance"
    if app_host == "word":
        return "Document Drafting" if is_active else "Document Summarising"
    if app_host == "powerpoint":
        return "Presentation Creation" if is_active else "Presentation Summarising"
    if app_host == "stream":
        return "Video Summarising"
    if app_host == "sharepoint":
        return "SharePoint Access"
    if app_host == "designer":
        return "Image Generation"
    if app_host == "onenote":
        return "Note Taking"
    if app_host == "forms":
        return "Form / Survey Work"
    if app_host == "planner":
        return "Task Management"
    if app_host in {"loop", "whiteboard", "vivaengage"}:
        return "Real-time Collaboration"
    if app_host == "copilot studio":
        return "Domain-Specific Agent"
    if profile == "aio":
        # v3.1.0: autonomous OR logic app -> "Workflow Execution".
        if app_host in {"autonomous", "logic app"}:
            return "Workflow Execution"
    else:
        # AIBV: autonomous always; logic app only when an agent context is present.
        if app_host == "autonomous":
            return "Running a Workflow"
        if app_host == "logic app" and has_agent:
            return "Running a Workflow"
    if app_host in {"datawarehousing core", "power bi"}:
        return "Data Querying"
    return "General Chat"


@functools.lru_cache(maxsize=None)
def compute_behavior_category(
    profile: str,
    app_host: str,
    ctx_type: str,
    res_type: str,
    res_action: str,
    site_url: str,
    plugin_id: str,
    has_agent: bool,
) -> str:
    app_host_l = (app_host or "").lower()
    ctx_l = (ctx_type or "").lower()
    res_t_l = (res_type or "").lower()
    res_a_l = (res_action or "").lower()
    site_l = (site_url or "").lower()
    plugin_l = (plugin_id or "").lower()
    is_active = any(tok in res_a_l for tok in _ACTIVE_RES_ACTION_TOKENS)

    from_resource = _resource_behavior(profile, res_t_l, res_a_l, site_l, is_active)
    if from_resource:
        return from_resource
    if plugin_l == "enterprisesearch":
        return "Enterprise Searching"
    return _context_behavior(profile, app_host_l, ctx_l, is_active, has_agent)


_GENERIC_QA_BEHAVIORS = {"General Q&A", "M365 Chat Q&A", "Teams Q&A", "Browser Q&A", "General Chat"}
_AGENT_NAME_RULES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("coach", "mentor", "learning", "career"), "Agent: Coaching"),
    (("research", "analyst", "analy"), "Agent: Research & Analysis"),
    (("sales", "commercial", "customer", "crm", "revenue"), "Agent: Sales & Customer"),
    (("hr", "recruit", "talent", "onboard", "people"), "Agent: HR & People"),
    (("policy", "compliance", "legal", "audit", "risk"), "Agent: Compliance & Policy"),
    (("service", "support", "help", "ticket", "incident"), "Agent: IT & Service Desk"),
    (("summar", "draft", "translat", "editor"), "Agent: Content Generation"),
    (("data", "report", "dashboard", "metric"), "Agent: Data & Reporting"),
    (("knowledge", "faq", "wiki", "buddy", "guide"), "Agent: Knowledge Base"),
    (("idea", "brainstorm", "creative", "design"), "Agent: Ideation & Creative"),
)


@functools.lru_cache(maxsize=None)
def compute_behavior_enriched(profile: str, behavior_category: str, agent_name: str, environment: str) -> str:
    # AIO enriches agent/autonomous rows; AIBV enriches agents/cowork rows.
    # (In practice AIBV `Environment` never returns "Agents", so only Cowork enriches.)
    enrich_envs = {"Agents", "Autonomous Agent"} if profile == "aio" else {"Agents", "Cowork"}
    if environment not in enrich_envs:
        return behavior_category
    if behavior_category not in _GENERIC_QA_BEHAVIORS:
        return behavior_category
    name_l = (agent_name or "").lower()
    for tokens, label in _AGENT_NAME_RULES:
        if any(t in name_l for t in tokens):
            return label
    return "Agent: General Purpose"


# Autonomy_Pattern — profile-aware.
#   AIO (v3.1.0): keyed off the 5-value Environment.
#   AIBV: SWITCH(Cowork->3, Is_Agent_Activity->2, Licensed->1, else BLANK).
@functools.lru_cache(maxsize=None)
def compute_autonomy_pattern(profile: str, environment: str, is_agent_activity_str: str) -> str:
    if profile == "aio":
        if environment == "Licensed M365 Copilot":
            return "1 - Copilot"
        if environment == "Agents":
            return "2 - Agent-Assisted"
        if environment == "Autonomous Agent":
            return "3 - Autonomous"
        return ""
    if environment == "Cowork":
        return "3 - Cowork"
    if is_agent_activity_str == "TRUE":
        return "2 - Agent-Assisted"
    if environment == "Licensed":
        return "1 - Copilot"
    return ""


# Behavior_Source — profile-aware (AIO: "Autonomous Agent" branch; AIBV: "Cowork").
@functools.lru_cache(maxsize=None)
def compute_behavior_source(
    profile: str,
    behavior_category: str,
    environment: str,
    agent_name: str,
    plugin_name: str,
    app_host: str,
) -> str:
    agent = (agent_name or "").strip()
    plugin = (plugin_name or "").strip()
    app = (app_host or "").strip()
    if profile == "aio" and environment == "Autonomous Agent":
        source = "Autonomous Agent" + (f": {agent}" if agent else "")
    elif profile != "aio" and environment == "Cowork":
        source = "Cowork" + (f": {agent}" if agent else "")
    elif environment == "Agents" and agent:
        source = f"Agent: {agent}"
    elif plugin:
        source = f"{app} ({plugin})"
    elif app:
        source = app
    else:
        source = "Copilot Chat"
    return f"{behavior_category} → {source}"


# Verbatim port of current AIBV DAX calc col `Value_Outcome`.
_VO_TIME_EMAIL = frozenset({"Email Summarising", "Email Triage", "Email Thread Summary"})
_VO_TIME_MEET = frozenset({"Meeting Prep", "Video Summarising"})
_VO_TIME_DOC = frozenset({"Document Summarising", "Presentation Summarising", "Note Taking"})
_VO_SEARCH = frozenset({
    "Web Searching", "Enterprise Searching", "File Retrieval", "PDF Analysis",
    "SharePoint Access", "People Lookup", "Agent: Knowledge Base",
})
_VO_COMM = frozenset({"Teams Messaging", "Meeting Scheduling"})
_VO_SHEET = frozenset({"Spreadsheet Review", "Spreadsheet Analysis", "Excel Assistance"})
_VO_CONTENT = frozenset({
    "Email Drafting", "Document Drafting", "Presentation Creation",
    "Image Generation", "Image / Media Analysis", "Image/Media Analysis",
    "Agent: Content Generation", "Agent: Ideation & Creative",
})
_VO_TEAMCOLLAB = frozenset({"Real-time Collaboration", "Form / Survey Work"})
_VO_DATA = frozenset({"Data Querying", "Agent: Data & Reporting", "Agent: Research & Analysis"})
_VO_CODE = frozenset({"Code Writing", "Code Analysis", "Code Analysis (URL)"})
_VO_COACH = frozenset({"Agent: Coaching", "Agent: Coaching (URL)"})
_VO_DOMAIN = frozenset({"Domain-Specific Agent", "Cross-Org Agent"})


@functools.lru_cache(maxsize=None)
def compute_value_outcome(
    profile: str, behavior_enriched: str, environment: str, is_sensitive_str: str
) -> str:
    b = behavior_enriched or ""
    # Profile-specific workflow signal (AIO: Workflow Execution / Autonomous Agent;
    # AIBV: Running a Workflow / Cowork).
    workflow_behavior = "Workflow Execution" if profile == "aio" else "Running a Workflow"
    workflow_env = "Autonomous Agent" if profile == "aio" else "Cowork"
    if b in _VO_TIME_EMAIL:
        return "Time Saved (Email)"
    if b in _VO_TIME_MEET:
        return "Time Saved (Meetings)"
    if b in _VO_TIME_DOC:
        return "Time Saved (Documents)"
    if b in _VO_SEARCH:
        return "Search Time Saved"
    if b in _VO_COMM:
        return "Communication Time Saved"
    if b in _VO_SHEET:
        return "Spreadsheet Time Saved"
    if b in _VO_CONTENT:
        return "Content Output"
    if b in _VO_TEAMCOLLAB:
        return "Team Collaboration"
    if b == workflow_behavior or environment == workflow_env:
        return "Workflow Automation"
    if b == "Task Management":
        return "Task Coordination"
    if (
        is_sensitive_str == "TRUE"
        and environment != "Agents"
        and environment != workflow_env
    ):
        return "Compliance & Risk"
    if b in _VO_DATA:
        return "Data-Driven Decisions"
    if b in _VO_CODE:
        return "Coding Capability"
    if b in _VO_COACH:
        return "Skills Development"
    if b == "Agent: Sales & Customer":
        return "Revenue Enablement"
    if b == "Agent: IT & Service Desk":
        return "Service Desk Deflection"
    if b == "Agent: Compliance & Policy":
        return "Compliance & Risk"
    if b == "Agent: HR & People":
        return "HR Expertise"
    if b in _VO_DOMAIN:
        return "Specialist Expertise"
    return "General AI Productivity"


# ---------------------------------------------------------------------------
# Downstream classification chain (offloaded from AIBV DAX).
#
# Per F2 (see offload plan): in the current AIBV model `Environment` never
# returns "Agents", so `Behavior_Enriched_Full`'s NeedsEnhancement guard
# (Env = "Agents" && BaseEnriched = "Agent: General Purpose") is always FALSE
# and the RELATED('Agents 365'...) lookups never execute. Therefore
# Behavior_Enriched_Full == Behavior_Enriched and the whole chain
# (Usage_Mode / Expertise_Role / Efficiency_Breakdown) is fully computable
# here WITHOUT ingesting Agents 365 — and stays pixel-identical to AIBV.
# ---------------------------------------------------------------------------


def compute_behavior_enriched_full(behavior_enriched: str) -> str:
    # No Agents 365 ingestion (by design) => NeedsEnhancement is always FALSE
    # => Behavior_Enriched_Full is exactly Behavior_Enriched.
    return behavior_enriched


_UM_PRODUCING = frozenset({
    "Email Drafting", "Document Drafting", "Presentation Creation", "Image Generation",
    "Code Writing", "Code Analysis", "Code Analysis (URL)", "Data Querying",
    "Spreadsheet Analysis", "Excel Assistance", "Agent: Content Generation",
    "Agent: Ideation & Creative", "Agent: Research & Analysis", "Agent: Data & Reporting",
    "Agent: Sales & Customer", "Agent: HR & People", "Agent: IT & Service Desk",
    "Agent: Compliance & Policy", "Agent: Coaching", "Agent: Coaching (URL)",
    "Domain-Specific Agent", "Cross-Org Agent", "Form / Survey Work",
    "Real-time Collaboration", "Note Taking", "Teams Messaging", "Meeting Scheduling",
    "Task Management",
})
_UM_CONSUMING = frozenset({
    "Document Summarising", "Email Summarising", "Email Thread Summary", "Email Triage",
    "Presentation Summarising", "Video Summarising", "Meeting Prep",
    "Image / Media Analysis", "Image/Media Analysis", "Sensitive Content Interaction",
})
_UM_FINDING = frozenset({
    "Web Searching", "Enterprise Searching", "PDF Analysis", "SharePoint Access",
    "File Retrieval", "People Lookup", "Agent: Knowledge Base", "Spreadsheet Review",
})


@functools.lru_cache(maxsize=None)
def compute_usage_mode(behavior_enriched_full: str, environment: str, app_host: str) -> str:
    # Verbatim port of AIBV `Usage_Mode` with the Agents-365 term dropped
    # (agentTypeA365 = IFERROR(RELATED(...),BLANK()) -> BLANK when A365 absent,
    # so its IN {...} test is always FALSE).
    behavior = behavior_enriched_full
    host = (app_host or "").lower()
    is_delegating = (
        environment == "Cowork"
        or host == "autonomous"
        or behavior == "Running a Workflow"
    )
    if is_delegating:
        return "5 - Delegating"
    if behavior in _UM_PRODUCING:
        return "4 - Producing"
    if behavior in _UM_CONSUMING:
        return "3 - Consuming"
    if behavior in _UM_FINDING:
        return "2 - Finding"
    return "1 - Asking"


# Verbatim port of AIBV `Expertise_Role` (ordered IF cascade on Behavior_Enriched_Full).
_EXPERTISE_RULES: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"Data Querying", "Agent: Data & Reporting", "Spreadsheet Analysis"}), "Data Analyst"),
    (frozenset({"Code Writing", "Code Analysis", "Code Analysis (URL)"}), "Software Engineer"),
    (frozenset({"Agent: Research & Analysis"}), "Business Analyst"),
    (frozenset({"Agent: Compliance & Policy", "Sensitive Content Interaction"}), "Compliance Specialist"),
    (frozenset({"Agent: Sales & Customer"}), "Sales Consultant"),
    (frozenset({"Agent: IT & Service Desk"}), "IT Specialist"),
    (frozenset({"Agent: HR & People"}), "HR Specialist"),
    (frozenset({"Agent: Coaching", "Agent: Coaching (URL)"}), "Coach"),
    (frozenset({"Running a Workflow", "Task Management"}), "Automation Engineer"),
    (frozenset({"Domain-Specific Agent", "Cross-Org Agent"}), "Domain Expert"),
    (frozenset({"Email Drafting"}), "Communications Specialist"),
    (frozenset({"Email Triage", "Meeting Scheduling", "Email Summarising", "Email Thread Summary"}), "Executive Assistant"),
    (frozenset({"Document Drafting", "Agent: Content Generation", "Note Taking", "Document Summarising"}), "Content Writer"),
    (frozenset({"Presentation Creation", "Presentation Summarising"}), "Presentation Designer"),
    (frozenset({"Image Generation", "Image/Media Analysis", "Image / Media Analysis", "Agent: Ideation & Creative"}), "Visual Designer"),
    (frozenset({"Meeting Prep", "Video Summarising"}), "Meeting Coordinator"),
    (frozenset({"Web Searching", "PDF Analysis", "Agent: Knowledge Base"}), "Researcher"),
    (frozenset({"Enterprise Searching", "SharePoint Access", "File Retrieval", "People Lookup"}), "Knowledge Navigator"),
    (frozenset({"Spreadsheet Review", "Excel Assistance"}), "Spreadsheet Specialist"),
    (frozenset({"Real-time Collaboration", "Form / Survey Work", "Form/Survey Work", "Teams Messaging"}), "Collaboration Lead"),
)


@functools.lru_cache(maxsize=None)
def compute_expertise_role(behavior_enriched_full: str) -> str:
    for members, label in _EXPERTISE_RULES:
        if behavior_enriched_full in members:
            return label
    return ""  # AIBV returns BLANK()


# Verbatim port of AIBV `Efficiency_Breakdown` (behavior cascade, then Behavior_Category fallback).
_EFF_RULES: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"Email Summarising", "Email Triage", "Email Thread Summary", "Email Drafting"}), "Email"),
    (frozenset({"Document Summarising", "Note Taking", "Document Drafting", "Agent: Content Generation"}), "Document Assistance"),
    (frozenset({"Presentation Summarising", "Presentation Creation"}), "Presentations"),
    (frozenset({"Meeting Prep", "Video Summarising", "Meeting Scheduling"}), "Meetings"),
    (frozenset({"Web Searching", "Enterprise Searching", "PDF Analysis", "SharePoint Access", "File Retrieval", "People Lookup", "Agent: Knowledge Base", "Agent: Research & Analysis"}), "Search & Research"),
    (frozenset({"Spreadsheet Review", "Excel Assistance", "Spreadsheet Analysis", "Data Querying", "Agent: Data & Reporting"}), "Data & Spreadsheets"),
    (frozenset({"Image Generation", "Image / Media Analysis", "Image/Media Analysis", "Agent: Ideation & Creative", "Code Writing", "Code Analysis", "Code Analysis (URL)"}), "Creative & Technical"),
    (frozenset({"Teams Messaging", "Real-time Collaboration", "Form / Survey Work", "Task Management", "Running a Workflow"}), "Collaboration & Workflows"),
    (frozenset({"Agent: Sales & Customer", "Agent: IT & Service Desk", "Agent: HR & People", "Agent: Compliance & Policy", "Agent: Coaching", "Agent: Coaching (URL)", "Domain-Specific Agent", "Cross-Org Agent"}), "Specialist Agents"),
)


@functools.lru_cache(maxsize=None)
def compute_efficiency_breakdown(behavior_enriched_full: str, behavior_category: str) -> str:
    for members, label in _EFF_RULES:
        if behavior_enriched_full in members:
            return label
    if behavior_category == "Teams Q&A":
        return "Teams Chat"
    if behavior_category == "M365 Chat Q&A":
        return "BizChat Q&A"
    if behavior_category == "Browser Q&A":
        return "BizChat Q&A"
    return "General Q&A"


# ---------------------------------------------------------------------------
# Embedded static value map (offloads the ROI baseline join).
#
# `Human Time Estimates` is a static lookup (Behavior -> Human Baseline (min)).
# The AIBV measure `Human Equivalent Hours` does:
#     SUMX(FILTER(fact, isPrompt="TRUE"), DIVIDE(RELATED(HTE[Human Baseline]),60,0))
# which traverses fact -> Behavior Value Map (BVM) -> Human Time Estimates (HTE)
# per row. We pre-join `Human_Baseline_Min` onto every fact row so the PBIT
# measure collapses to SUM(fact[Human_Baseline_Min])/60 (no SUMX, no RELATED).
#
# FIDELITY: HTE is reachable in the model ONLY through the BVM bridge, so a
# baseline is emitted ONLY when Behavior_Enriched_Full is present in BVM (then
# looked up in HTE; BVM is a strict subset of HTE, so the lookup always hits).
# Behaviors not in BVM contribute 0 hours in the current AIBV — we emit "" for
# them, which SUMs to 0 identically. Both maps are transcribed verbatim from
# the AIBV `.pbit` static #table literals (see temp/_offload_test/_parse_maps.py).
# ---------------------------------------------------------------------------

_HUMAN_BASELINE_MIN: dict[str, int] = {
    "Agent: Coaching": 45,
    "Agent: Coaching (URL)": 25,
    "Agent: Compliance & Policy": 25,
    "Agent: Content Generation": 25,
    "Agent: Data & Reporting": 35,
    "Agent: General Purpose": 15,
    "Agent: HR & People": 35,
    "Agent: IT & Service Desk": 20,
    "Agent: Ideation & Creative": 40,
    "Agent: Knowledge Base": 12,
    "Agent: Research & Analysis": 45,
    "Agent: Sales & Customer": 35,
    "Browser Q&A": 10,
    "Code Analysis": 30,
    "Code Analysis (URL)": 15,
    "Code Writing": 45,
    "Cross-Org Agent": 30,
    "Data Querying": 30,
    "Document Drafting": 60,
    "Document Summarising": 20,
    "Domain-Specific Agent": 25,
    "Email Drafting": 8,
    "Email Summarising": 4,
    "Email Thread Summary": 5,
    "Email Triage": 10,
    "Enterprise Searching": 18,
    "Excel Assistance": 30,
    "File Retrieval": 15,
    "Form / Survey Work": 25,
    "Form/Survey Work": 25,
    "General Chat": 10,
    "General Q&A": 10,
    "Image / Media Analysis": 8,
    "Image Generation": 60,
    "Image/Media Analysis": 8,
    "M365 Chat Q&A": 10,
    "Meeting Prep": 15,
    "Meeting Scheduling": 12,
    "Note Taking": 20,
    "PDF Analysis": 35,
    "People Lookup": 10,
    "Presentation Creation": 90,
    "Presentation Summarising": 12,
    "Real-time Collaboration": 30,
    "Running a Workflow": 15,
    "Sensitive Content Interaction": 20,
    "SharePoint Access": 12,
    "Spreadsheet Analysis": 40,
    "Spreadsheet Review": 25,
    "Task Management": 20,
    "Teams Messaging": 8,
    "Teams Q&A": 10,
    "Video Summarising": 30,
    "Web Searching": 22,
}

# Behaviors present in the Behavior Value Map bridge (gates HTE reachability).
_BVM_BEHAVIORS: frozenset = frozenset({
    "Agent: Coaching",
    "Agent: Compliance & Policy",
    "Agent: Content Generation",
    "Agent: Data & Reporting",
    "Agent: General Purpose",
    "Agent: HR & People",
    "Agent: IT & Service Desk",
    "Agent: Ideation & Creative",
    "Agent: Knowledge Base",
    "Agent: Research & Analysis",
    "Agent: Sales & Customer",
    "Code Analysis",
    "Code Writing",
    "Data Querying",
    "Document Drafting",
    "Document Summarising",
    "Domain-Specific Agent",
    "Email Drafting",
    "Email Summarising",
    "Enterprise Searching",
    "Excel Assistance",
    "File Retrieval",
    "Form / Survey Work",
    "General Chat",
    "Image / Media Analysis",
    "Image Generation",
    "Meeting Prep",
    "Meeting Scheduling",
    "Note Taking",
    "PDF Analysis",
    "People Lookup",
    "Presentation Creation",
    "Presentation Summarising",
    "Real-time Collaboration",
    "Running a Workflow",
    "SharePoint Access",
    "Spreadsheet Review",
    "Task Management",
    "Teams Messaging",
    "Video Summarising",
    "Web Searching",
})


@functools.lru_cache(maxsize=None)
def compute_human_baseline_min(behavior_enriched_full: str) -> str:
    # Emit the baseline only when reachable via the BVM bridge (AIBV topology).
    if behavior_enriched_full in _BVM_BEHAVIORS:
        return str(_HUMAN_BASELINE_MIN[behavior_enriched_full])
    return ""


# ---------------------------------------------------------------------------
# Remaining row-level calc cols (offloaded from AIBV DAX).
# ---------------------------------------------------------------------------

# Verbatim port of AIBV `Behavior_Plausible`.
_UNLICENSED_PLAUSIBLE = frozenset({
    "General Chat", "Web Searching", "PDF Analysis", "Document Summarising",
    "Image / Media Analysis", "Image Generation", "Code Analysis", "Translation",
})
_BP_WORKAROUND_EMAIL = frozenset({"Email Summarising", "Email Drafting"})
_BP_WORKAROUND_SHEET = frozenset({"Excel Assistance", "Spreadsheet Review", "Data Querying"})
_BP_WORKAROUND_MEET = frozenset({"Meeting Prep", "Meeting Scheduling"})
_BP_WORKAROUND_ENT = frozenset({"Enterprise Searching", "People Lookup"})
_BP_WORKAROUND_WORKFLOW = frozenset({"Running a Workflow", "Task Management"})


@functools.lru_cache(maxsize=None)
def compute_behavior_plausible(license_status: str, behavior_category: str) -> str:
    lic = license_status
    beh = behavior_category
    if lic == "M365 Copilot Licensed" or beh in _UNLICENSED_PLAUSIBLE:
        return beh
    if beh in _BP_WORKAROUND_EMAIL:
        return "Free Chat Workaround (pasting Email)"
    if beh in _BP_WORKAROUND_SHEET:
        return "Free Chat Workaround (pasting Spreadsheet/Data)"
    if beh in _BP_WORKAROUND_MEET:
        return "Free Chat Workaround (pasting Meeting info)"
    if beh == "Teams Messaging":
        return "Free Chat Workaround (pasting Teams content)"
    if beh in _BP_WORKAROUND_ENT:
        return "Free Chat Workaround (pasting Enterprise data)"
    if beh in _BP_WORKAROUND_WORKFLOW:
        return "Free Chat Workaround (pasting Workflow)"
    if beh == "Real-time Collaboration":
        return "Free Chat Workaround (pasting Loop content)"
    if beh == "Code Writing":
        return "Free Chat Workaround (pasting Code)"
    if beh == "Video Summarising":
        return "Free Chat Workaround (uploading Video)"
    return "Free Chat Workaround (Other)"


# Verbatim port of AIBV `Workflow_Action`.
@functools.lru_cache(maxsize=None)
def compute_workflow_action(behavior_enriched_full: str, res_action: str, app_host: str) -> str:
    if behavior_enriched_full != "Running a Workflow":
        return ""
    ra = (res_action or "").lower()
    host = (app_host or "").lower()
    if "send" in ra or "post" in ra or "notify" in ra:
        return "Sending / Notifying"
    if "create" in ra or "draft" in ra or "write" in ra or "add" in ra:
        return "Creating Content"
    if "invoke" in ra or "execute" in ra or "trigger" in ra or "run" in ra:
        return "Invoking / Triggering"
    if "update" in ra or "patch" in ra or "modify" in ra or "set" in ra:
        return "Updating Records"
    if "read" in ra or "get" in ra or "list" in ra or "fetch" in ra:
        return "Reading Data"
    if "delete" in ra or "remove" in ra:
        return "Deleting / Removing"
    if host == "autonomous":
        return "Autonomous Run (no action logged)"
    if host == "logic app":
        return "Logic App Run (no action logged)"
    return "Workflow (other)"


def compute_delegation_event_key(
    audit_user_id: str,
    interaction_date_str: str,
    agent_name: str,
    workflow_action: str,
    app_host: str,
) -> str:
    # Verbatim port of AIBV `Delegation_Event_Key`:
    #   Audit_UserId & "|" & FORMAT(InteractionDate,"yyyy-mm-dd") & "|" &
    #   COALESCE(AgentName, Workflow_Action, AppHost, "unknown-workflow")
    # NOTE: DAX FORMAT "mm" resolves to MONTH here (not minute) because it does
    # not follow h/hh — so interaction_date_str ("%Y-%m-%d") matches exactly.
    # COALESCE: we treat empty/whitespace as blank (skip it). The blank-vs-empty
    # nuance + rollup-vs-fanout grain interaction are flagged for Phase 4 live
    # parity (measure: [Delegation Events] = DISTINCTCOUNT, filtered Usage_Mode
    # = "5 - Delegating").
    tail = "unknown-workflow"
    for candidate in (agent_name, workflow_action, app_host):
        if candidate and candidate.strip():
            tail = candidate
            break
    return f"{audit_user_id}|{interaction_date_str}|{tail}"


def compute_user_month_key(audit_user_id: str, month_start_str: str) -> str:
    if not audit_user_id or not month_start_str:
        return ""
    # MonthStart is YYYY-MM-DD; format key as YYYY-MM (mirrors DAX FORMAT(...,"yyyy-MM"))
    return f"{audit_user_id}|{month_start_str[:7]}"


# Verbatim port of AIBV calc col `Agent Publish Status`.
@functools.lru_cache(maxsize=None)
def compute_agent_publish_status(agent_id: str, agent_name: str) -> str:
    has_agent_id = bool((agent_id or "").strip())
    if not has_agent_id:
        return "Not an Agent Row"
    if "draft as 1p" in (agent_name or "").lower():
        return "Unpublished"
    return "Published"


# Verbatim port of AIBV calc col `Is_Agent_Activity` (emitted as TRUE/FALSE text,
# mirroring the Is_Sensitive / Message_isPrompt convention; the PBIT types it
# logical in Phase 3). res_type is the per-resource AccessedResource_Type.
@functools.lru_cache(maxsize=None)
def compute_is_agent_activity(agent_name: str, agent_id: str, app_host: str, res_type: str) -> str:
    has_agent = bool((agent_name or "").strip())
    has_agent_id = bool((agent_id or "").strip())
    host = (app_host or "").lower()
    rt = (res_type or "").lower()
    is_autonomous = host in {"autonomous", "logic app"} or rt in {"flow", "connector"}
    return "TRUE" if (has_agent or has_agent_id or is_autonomous) else "FALSE"


# Verbatim port of AIBV calc col `Web_Grounded_Signal`.
@functools.lru_cache(maxsize=None)
def compute_web_grounded_signal(res_type: str, site_url: str) -> str:
    rt = (res_type or "").lower()
    su = (site_url or "").lower()
    is_internal = "sharepoint.com" in su or ".onmicrosoft.com" in su
    if (
        rt == "websearchquery"
        or rt in {"external", "http"}
        or (rt == "http://schema.skype.com/hyperlink" and not is_internal)
    ):
        return "Web Grounded"
    return "Not Web Grounded"


# ---------------------------------------------------------------------------
# Entra loader / Users dim CSV writer
# ---------------------------------------------------------------------------


def _normalize_col_name(name: str) -> str:
    return re.sub(r"[\s_\-.()\[\]]", "", (name or "").lower())


def detect_has_license_column(headers: list[str]) -> str | None:
    for variant in HAS_LICENSE_VARIANTS:
        if variant in headers:
            return variant
    return None


def detect_upn_column(headers: list[str]) -> str | None:
    for h in headers:
        if _normalize_col_name(h) in UPN_VARIANTS_NORMALIZED:
            return h
    return None


def detect_department_column(headers: list[str]) -> str | None:
    for h in headers:
        if _normalize_col_name(h) in {DEPARTMENT_VARIANT_NORMALIZED, "organization", "organisation"}:
            return h
    return None


def detect_jobtitle_column(headers: list[str]) -> str | None:
    for h in headers:
        if _normalize_col_name(h) == "jobtitle":
            return h
    return None


def load_licensing_map(licensing_csv: str) -> tuple[dict[str, str], int]:
    """Read a standalone licensing CSV (UPN + 'Has License' columns) and return
    (normalized_upn -> raw license value, data_row_count).

    Used by the 3-file input mode to merge license status into a users-only
    Entra file. UPN + license columns are detected with the same alias lists as
    the Entra loader. Duplicate UPNs are last-write-wins (mirrors the M-code
    Table.Distinct behavior on the licensed-users path).
    """
    with open(licensing_csv, "r", encoding="utf-8-sig", newline="") as fin:
        reader = csv.DictReader(fin)
        headers = reader.fieldnames or []
        if not headers:
            raise ValueError(f"Licensing CSV has no header row: {licensing_csv}")
        upn_col = detect_upn_column(headers)
        if upn_col is None:
            raise ValueError(
                f"Licensing CSV has no recognized UPN column "
                f"(expected one of {sorted(UPN_VARIANTS_NORMALIZED)}): {licensing_csv}"
            )
        lic_col = detect_has_license_column(headers)
        if lic_col is None:
            raise ValueError(
                f"Licensing CSV has no recognized license column "
                f"(expected one of {list(HAS_LICENSE_VARIANTS)}): {licensing_csv}"
            )
        license_map: dict[str, str] = {}
        row_count = 0
        for row in reader:
            row_count += 1
            upn_norm = (row.get(upn_col) or "").strip().lower()
            if not upn_norm:
                continue
            license_map[upn_norm] = row.get(lic_col) or ""
    return license_map, row_count


def load_entra_and_write_users(
    entra_csv: str,
    users_out_csv: str,
    user_key_map: dict[str, int],
    licensing_csv: str | None = None,
    quiet: bool = False,
) -> dict[str, dict[str, str]]:
    """
    Read the Entra CSV, write the Users dim CSV (with PBIP-compatible renames +
    precomputed License Status + UserKey INT surrogate), and return a dict
    keyed on PersonId_Normalized -> {"Has license": ..., "License Status": ...}
    for fact-row lookup.

    Mutates `user_key_map` (normalized_upn -> int) in place — every Entra row
    with a non-empty PersonId_Normalized is assigned a UserKey (1-based, in
    Entra-file order). The same map is reused by the fact path so any audit
    user already in Entra resolves to the same INT.

    Mirrors the rename/normalization logic in the existing PBIP M-code:
      userPrincipalName/upn/personid -> PersonId
      department                     -> Organization
      jobTitle                       -> JobTitle
      Has license variants           -> "Has license"
      adds PersonId_Normalized (lower+trim of PersonId)
      adds License Status (precomputed)
      adds TotalEmployees (row count, repeated per row)

    3-file input mode: when `licensing_csv` is provided, `entra_csv` is treated
    as a users-only file and the per-user license value is merged in from the
    separate licensing CSV (keyed on normalized UPN). When `licensing_csv` is
    None the function behaves exactly as before (license read from the combined
    Entra row), so the legacy 2-file output is byte-identical.
    """
    license_map: dict[str, str] | None = None
    licensing_rows = 0
    if licensing_csv:
        license_map, licensing_rows = load_licensing_map(licensing_csv)

    with open(entra_csv, "r", encoding="utf-8-sig", newline="") as fin:
        # Sniff via a generous quote-aware reader; encoding="utf-8-sig" eats BOM if present.
        reader = csv.DictReader(fin)
        original_headers = reader.fieldnames or []
        if not original_headers:
            raise ValueError(f"Entra CSV has no header row: {entra_csv}")

        upn_col = detect_upn_column(original_headers)
        dept_col = detect_department_column(original_headers)
        has_license_col = detect_has_license_column(original_headers)
        jobtitle_col = detect_jobtitle_column(original_headers)

        # Build rename map: source_header -> target_header
        rename_map: dict[str, str] = {}
        if upn_col and upn_col != "PersonId":
            rename_map[upn_col] = "PersonId"
        if dept_col and dept_col != "Organization":
            rename_map[dept_col] = "Organization"
        if jobtitle_col and jobtitle_col != "JobTitle":
            rename_map[jobtitle_col] = "JobTitle"
        if has_license_col and has_license_col != "Has license":
            rename_map[has_license_col] = "Has license"

        # Final header list for users CSV — preserve original order, apply renames,
        # then append injected columns. UserKey is the INT surrogate that joins
        # to the fact table.
        renamed_headers = [rename_map.get(h, h) for h in original_headers]
        injected = ["UserKey", "PersonId_Normalized", "License Status", "TotalEmployees"]
        if "Has license" not in renamed_headers:
            renamed_headers.append("Has license")
        for inj in injected:
            if inj not in renamed_headers:
                renamed_headers.append(inj)

        rows = list(reader)

    total_rows = len(rows)
    user_lookup: dict[str, dict[str, str]] = {}

    out_dir = Path(users_out_csv).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    pax_licensed = 0
    pax_unlicensed = 0
    no_license_col = 0
    matched_in_licensing = 0
    seen_normalized_keys: set[str] = set()

    with open(users_out_csv, "w", encoding="utf-8", newline="") as fout:
        writer = csv.DictWriter(fout, fieldnames=renamed_headers, lineterminator="\n")
        writer.writeheader()

        for src_row in rows:
            # Apply renames + ensure all renamed_headers keys exist in the out row.
            out_row: dict[str, str] = {h: "" for h in renamed_headers}
            for src_h, value in src_row.items():
                tgt_h = rename_map.get(src_h, src_h)
                if tgt_h in out_row:
                    out_row[tgt_h] = "" if value is None else str(value)

            # PersonId_Normalized
            person_id = out_row.get("PersonId", "")
            person_id_norm = person_id.strip().lower() if person_id else ""
            out_row["PersonId_Normalized"] = person_id_norm

            # UserKey (INT surrogate; assigned in Entra-file order)
            if person_id_norm:
                user_key = user_key_map.get(person_id_norm)
                if user_key is None:
                    user_key = len(user_key_map) + 1
                    user_key_map[person_id_norm] = user_key
                out_row["UserKey"] = str(user_key)
            else:
                out_row["UserKey"] = ""

            # License Status (mirrors PBIP DAX exactly).
            # We also normalize Has license to canonical TRUE/FALSE so existing
            # measures that filter `[Has license] = "FALSE"` match regardless
            # of source casing.
            #
            # 3-file input mode: when a separate licensing file is supplied, the
            # per-user license value comes from that file (keyed on normalized
            # UPN). When it is NOT supplied, the value is read from the
            # (combined) Entra row exactly as before -> byte-identical 2-file
            # output.
            if license_map is not None:
                has_license_raw = license_map.get(person_id_norm, "")
            else:
                has_license_raw = out_row.get("Has license", "")
            normalized_has_license = normalize_has_license(has_license_raw)
            if license_map is not None:
                if person_id_norm and person_id_norm in license_map:
                    matched_in_licensing += 1
                if (has_license_raw or "").strip().upper() in _LICENSE_TRUTHY:
                    pax_licensed += 1
                else:
                    pax_unlicensed += 1
            elif has_license_col is None:
                no_license_col += 1
            elif (has_license_raw or "").strip().upper() in _LICENSE_TRUTHY:
                pax_licensed += 1
            else:
                pax_unlicensed += 1
            out_row["Has license"] = normalized_has_license
            out_row["License Status"] = compute_license_status(normalized_has_license)

            # TotalEmployees (matches M-code: row count repeated per row)
            out_row["TotalEmployees"] = str(total_rows)

            writer.writerow(out_row)

            # Build fact-lookup dict (dedupe on normalized key, last-wins matches
            # M-code Table.Distinct behavior on the licensed-users path).
            if person_id_norm:
                user_lookup[person_id_norm] = {
                    "Has license": normalized_has_license,
                    "License Status": out_row["License Status"],
                }
                seen_normalized_keys.add(person_id_norm)

    if not quiet:
        print(f"  Entra rows:            {total_rows:,}")
        print(f"  Unique users (norm):   {len(seen_normalized_keys):,}")
        if license_map is not None:
            print(f"  Licensing file:        {licensing_csv}")
            print(f"  Licensing rows:        {licensing_rows:,}")
            print(f"  Matched to users:      {matched_in_licensing:,}")
            print(f"  Licensed:              {pax_licensed:,}")
            print(f"  Unlicensed:            {pax_unlicensed:,}")
        elif has_license_col:
            print(f"  License col detected:  '{has_license_col}'")
            print(f"  Licensed (PAX):        {pax_licensed:,}")
            print(f"  Unlicensed (PAX):      {pax_unlicensed:,}")
        else:
            print(f"  License col detected:  NO RECOGNIZED LICENSE COLUMN FOUND IN ENTRA CSV")
            print(f"     Fallback: every user will be tagged 'Unlicensed' until a recognized column is present.")

    return user_lookup


# ---------------------------------------------------------------------------
# Fact row explosion + output
# ---------------------------------------------------------------------------


def explode_record(
    audit_data: dict[str, Any],
    user_lookup: dict[str, dict[str, str]],
    user_key_map: dict[str, int],
    thread_key_map: dict[str, int],
    profile: str,
) -> list[dict[str, Any]]:
    creation_time_raw = audit_data.get("CreationTime")
    creation_time_raw_str = to_text(creation_time_raw).strip()
    # Cached bundle: 4 derived date strings in one shot, keyed on the raw
    # timestamp string (~K distinct values across N records).
    creation_date_str, interaction_date_str, week_start_str, month_start_str = (
        _date_strings_for_raw(creation_time_raw_str)
    )
    app_identity_app_id, app_identity_display = app_identity_values(audit_data)
    agent_id = to_text(audit_data.get("AgentId"))
    agent_name = derive_agent_name(audit_data.get("AgentName"), app_identity_display, app_identity_app_id)

    ced = audit_data.get("CopilotEventData")
    if not isinstance(ced, dict):
        return []

    prompts = prompt_messages(ced)
    if not prompts:
        return []

    resources = resource_rows(ced)
    real_resource_count = sum(1 for item in get_array(ced, "AccessedResources") if isinstance(item, dict))
    resource_count_value = real_resource_count if real_resource_count > 0 else 1
    first_context = first_dict_item(get_array(ced, "Contexts"))
    first_plugin = first_dict_item(get_array(ced, "AISystemPlugin"))
    first_model = first_dict_item(get_array(ced, "ModelTransparencyDetails"))

    audit_user_id_raw = to_text(audit_data.get("UserId"))
    if not _is_human_upn(audit_user_id_raw):
        return []
    audit_user_id_norm = normalize_user_id(audit_user_id_raw)
    # UserKey INT surrogate. If this audit user wasn't in Entra, mint a new
    # INT and stash so subsequent rows for the same user reuse it. The
    # caller tracks unmatched-vs-Entra via the lookup membership check.
    if audit_user_id_norm:
        user_key = user_key_map.get(audit_user_id_norm)
        if user_key is None:
            user_key = len(user_key_map) + 1
            user_key_map[audit_user_id_norm] = user_key
    else:
        user_key = ""
    # ThreadId INT surrogate.
    thread_id_raw = to_text(ced.get("ThreadId"))
    if thread_id_raw:
        thread_key = thread_key_map.get(thread_id_raw)
        if thread_key is None:
            thread_key = len(thread_key_map) + 1
            thread_key_map[thread_id_raw] = thread_key
    else:
        thread_key = ""
    app_host_str = to_text(ced.get("AppHost"))
    sens_label_str = to_text(ced.get("SensitivityLabelId"))
    ctx_type_str = to_text(first_context.get("Type")) if first_context else ""
    plugin_id_str = to_text(first_plugin.get("Id")) if first_plugin else ""
    model_name_str = to_text(first_model.get("ModelName")) if first_model else ""

    # User-level lookups (constant per record)
    user_rec = user_lookup.get(audit_user_id_norm) or {}
    has_license_raw = user_rec.get("Has license", "")
    license_status = user_rec.get("License Status") or compute_license_status(has_license_raw)
    environment = compute_environment(profile, has_license_raw, agent_name, agent_id, app_host_str)
    ai_model = compute_ai_model(model_name_str)
    user_month_key = compute_user_month_key(audit_user_id_raw, month_start_str)

    is_aibv = profile != "aio"

    # Per-record constants hoisted out of the (prompt x resource) inner loop.
    # All grain values are pre-stringified via to_text() exactly once so the
    # rollup loop can use the tuple directly as the dict key.
    user_key_text = to_text(user_key)
    thread_key_text = to_text(thread_key)
    agent_title_id = derive_agent_title_id(agent_id)
    aisystem_plugin_name_str = to_text(first_plugin.get("Name")) if first_plugin else ""
    in_entra = (audit_user_id_norm in user_lookup) if audit_user_id_norm else True
    # AIBV-only per-record constants.
    agent_publish_status = compute_agent_publish_status(agent_id, agent_name) if is_aibv else ""
    # has_agent gate for the Behavior_Category "logic app" branch (AIBV).
    has_agent_ctx = bool(agent_name.strip()) or bool(agent_id.strip())

    # Stable portion of the nongrain dict (everything that does NOT depend on
    # the per-resource fields). Built once per record; copied per emitted row
    # and updated with the resource-varying keys. Common keys first; AIBV-only
    # keys appended only for the aibv profile so the AIO output stays the exact
    # v3.1.0 column set.
    base_nongrain: dict[str, Any] = {
        "CreationDate": creation_date_str,
        "WeekStart": week_start_str,
        "MonthStart": month_start_str,
        "UserMonthKey": user_month_key,
        "Has license": has_license_raw,
        "Resource_Count": resource_count_value,
        "SensitivityLabelId": sens_label_str,
        # AccessedResource_* injected per-resource below.
        "AccessedResource_Type": "",
        "AccessedResource_Action": "",
        "AccessedResource_SiteUrl": "",
        "AccessedResource_SensitivityLabelId": "",
        "AppIdentity_DisplayName": app_identity_display,
        "AISystemPlugin_Id": plugin_id_str,
        "ModelTransparencyDetails_ModelName": model_name_str,
        "Agent_TitleID": agent_title_id,
        "Message_isPrompt": "TRUE",
        # Behavior_Source / Value_Outcome injected per-resource below.
        "Behavior_Source": "",
        "Value_Outcome": "",
        "ActivityDate": interaction_date_str,
    }
    if is_aibv:
        base_nongrain.update({
            # M1: UPN passthrough (raw mirrors AIBV [Audit_UserId]; normalized for joins).
            "Audit_UserId": audit_user_id_raw,
            "Audit_UserId_Normalized": audit_user_id_norm,
            # Agent Filter injected per-resource; Agent Publish Status constant per record.
            "Agent Filter": "",
            "Agent Publish Status": agent_publish_status,
            # Downstream chain + ROI baseline + remaining calc cols (per-resource).
            "Behavior_Enriched_Full": "",
            "Usage_Mode": "",
            "Expertise_Role": "",
            "Efficiency_Breakdown": "",
            "Human_Baseline_Min": "",
            "Behavior_Plausible": "",
            "Delegation_Event_Key": "",
        })

    # Output schema: list of tuples
    #   (grain_tuple, message_id_str, nongrain_dict, in_entra, audit_user_id_norm)
    # consumed directly by run_processor's rollup loop. The grain arity differs
    # by profile (AIO 16 keys; AIBV 19 — the 3 promoted sliceable flags).
    rows: list[tuple[tuple[str, ...], str, dict[str, Any], bool, str]] = []
    for message in prompts:
        message_id = to_text(message.get("Id"))
        for resource in resources:
            res_type_str = to_text(resource.get("Type"))
            res_action_str = to_text(resource.get("Action"))
            res_site_str = to_text(resource.get("SiteUrl"))
            res_sens_label_str = to_text(resource.get("SensitivityLabelId"))
            behavior_category = compute_behavior_category(
                profile, app_host_str, ctx_type_str, res_type_str, res_action_str,
                res_site_str, plugin_id_str, has_agent_ctx,
            )
            behavior_enriched = compute_behavior_enriched(
                profile, behavior_category, agent_name, environment
            )
            is_sensitive_str = compute_is_sensitive(sens_label_str, res_sens_label_str)
            behavior_source = compute_behavior_source(
                profile, behavior_category, environment, agent_name,
                aisystem_plugin_name_str, app_host_str,
            )
            value_outcome = compute_value_outcome(
                profile, behavior_enriched, environment, is_sensitive_str,
            )

            nongrain = dict(base_nongrain)
            nongrain["AccessedResource_Type"] = res_type_str
            nongrain["AccessedResource_Action"] = res_action_str
            nongrain["AccessedResource_SiteUrl"] = res_site_str
            nongrain["AccessedResource_SensitivityLabelId"] = res_sens_label_str
            nongrain["Behavior_Source"] = behavior_source
            nongrain["Value_Outcome"] = value_outcome

            common_grain = (
                user_key_text,
                interaction_date_str,
                agent_id,
                agent_name,
                app_host_str,
                environment,
                license_status,
                ctx_type_str,
                behavior_category,
                behavior_enriched,
                ai_model,
                is_sensitive_str,
            )

            if is_aibv:
                # AIBV-faithful per-resource flags (3 are grain keys).
                is_agent_activity_str = compute_is_agent_activity(
                    agent_name, agent_id, app_host_str, res_type_str
                )
                web_grounded_str = compute_web_grounded_signal(res_type_str, res_site_str)
                # Autonomy_Pattern depends on per-resource Is_Agent_Activity (AIBV).
                autonomy_pattern = compute_autonomy_pattern(
                    profile, environment, is_agent_activity_str
                )
                # Downstream chain (faithful without Agents 365 per F2).
                behavior_enriched_full = compute_behavior_enriched_full(behavior_enriched)
                usage_mode = compute_usage_mode(behavior_enriched_full, environment, app_host_str)
                expertise_role = compute_expertise_role(behavior_enriched_full)
                efficiency_breakdown = compute_efficiency_breakdown(
                    behavior_enriched_full, behavior_category
                )
                human_baseline_min = compute_human_baseline_min(behavior_enriched_full)
                behavior_plausible = compute_behavior_plausible(license_status, behavior_category)
                workflow_action = compute_workflow_action(
                    behavior_enriched_full, res_action_str, app_host_str
                )
                delegation_event_key = compute_delegation_event_key(
                    audit_user_id_raw, interaction_date_str, agent_name,
                    workflow_action, app_host_str,
                )
                grain_tuple = common_grain + (
                    autonomy_pattern,
                    app_identity_app_id,
                    aisystem_plugin_name_str,
                    thread_key_text,
                    is_agent_activity_str,
                    web_grounded_str,
                    workflow_action,
                )
                nongrain["Agent Filter"] = "Agents" if is_agent_activity_str == "TRUE" else ""
                nongrain["Behavior_Enriched_Full"] = behavior_enriched_full
                nongrain["Usage_Mode"] = usage_mode
                nongrain["Expertise_Role"] = expertise_role
                nongrain["Efficiency_Breakdown"] = efficiency_breakdown
                nongrain["Human_Baseline_Min"] = human_baseline_min
                nongrain["Behavior_Plausible"] = behavior_plausible
                nongrain["Delegation_Event_Key"] = delegation_event_key
            else:
                # AIO (v3.1.0): autonomy keyed purely off Environment; 16-key grain.
                autonomy_pattern = compute_autonomy_pattern(profile, environment, "")
                grain_tuple = common_grain + (
                    autonomy_pattern,
                    app_identity_app_id,
                    aisystem_plugin_name_str,
                    thread_key_text,
                )

            rows.append((grain_tuple, message_id, nongrain, in_entra, audit_user_id_norm))

    return rows


# ---------------------------------------------------------------------------
# Pre-aggregated tables (AIBV only) — offload the DAX calculated tables.
#
# Each of these replaces a DAX calc table that SUMMARIZEs the ENTIRE fact on
# every refresh. We compute them ONCE here from the same rollup that produces
# the fact CSV, so they equal exactly what the existing DAX would compute when
# evaluated over the rolled-up fact (internally consistent — a reviewer can
# keep the DAX calc tables over the rollup fact and get the same numbers).
#
# Grain-key index map (AIBV profile): see GRAIN_KEYS_AIBV.
#   [1]=InteractionDate  [3]=AgentName  [6]=License Status
# The remaining inputs come from the nongrain dict
#   (MonthStart, WeekStart, Audit_UserId, Behavior_Enriched_Full, Usage_Mode).
# ---------------------------------------------------------------------------

_VALUEFOCUS_MODES = frozenset({"4 - Producing", "5 - Delegating"})


def _percentile_inc(sorted_vals: list[float], p: float) -> float:
    """PERCENTILE.INC / PERCENTILEX.INC — linear interpolation, p in [0, 1]."""
    n = len(sorted_vals)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_vals[0]
    rank = p * (n - 1)
    lo = int(rank)  # floor (rank is non-negative)
    if lo + 1 >= n:
        return sorted_vals[lo]
    frac = rank - lo
    return sorted_vals[lo] + (sorted_vals[lo + 1] - sorted_vals[lo]) * frac


def _usage_rank(avg_ppw: float, p90: float, p75: float, p50: float, p25: float) -> str:
    if avg_ppw == 0:
        return "0. No Usage"
    if avg_ppw >= p90:
        return "5. Top 10% Users"
    if avg_ppw >= p75:
        return "4. 75-90% Users"
    if avg_ppw >= p50:
        return "3. 50-75% Users"
    if avg_ppw >= p25:
        return "2. 25-50% Users"
    return "1. Bottom 25% Users"


def _user_stage(active_days: int, behavior_count: int, value_focus_share: float, has_agent: bool) -> str:
    if active_days >= 15 or (active_days >= 10 and value_focus_share >= 0.30 and has_agent):
        return "4 - Power"
    if active_days >= 8 and behavior_count >= 5:
        return "3 - Habitual"
    if active_days >= 3 and behavior_count >= 3:
        return "2 - Developing"
    return "1 - Beginner"


def _activity_segment(avg_days: float) -> str:
    if avg_days == 0:
        return "0. No Activity"
    if avg_days <= 5:
        return "1. 1-5 Chat Days/Month - 'Infrequent'"
    if avg_days <= 10:
        return "2. 6-10 Chat Days/Month - 'Moderate'"
    if avg_days <= 19:
        return "3. 11-19 Chat Days/Month - 'Frequent'"
    return "4. 20+ Chat Days/Month - 'Daily'"


def _fmt_float(x: float) -> str:
    """Shortest round-trippable float, integers without trailing '.0'."""
    if x == int(x):
        return str(int(x))
    return repr(x)


def compute_and_write_aggregates(
    rollup: dict[tuple[Any, ...], dict[str, Any]],
    agg_paths: dict[str, str],
    quiet: bool = False,
) -> dict[str, int]:
    """Build the 5 AIBV pre-aggregated tables from the rollup and write them.

    Returns {table_name: row_count}. `agg_paths` keys:
      active_days, user_month_metrics, licensed_rankings,
      unlicensed_rankings, licensed_summary.
    """
    # Per (Audit_UserId, MonthStart) accumulators.
    um: dict[tuple[str, str], dict[str, Any]] = {}
    # Per Audit_UserId accumulators (for the rankings).
    ua: dict[str, dict[str, Any]] = {}

    for grain_key, nongrain in rollup.items():
        gk = grain_key[0]  # rollup key is ((grain_tuple), mid_int)
        mid = grain_key[1]
        interaction_date = gk[1]
        agent_name = gk[3]
        license_status = gk[6]
        uid = nongrain["Audit_UserId"]
        month = nongrain["MonthStart"]
        week = nongrain["WeekStart"]
        bef = nongrain["Behavior_Enriched_Full"]
        usage_mode = nongrain["Usage_Mode"]

        mk = (uid, month)
        a = um.get(mk)
        if a is None:
            a = um[mk] = {
                "idates": set(), "mids": set(), "behaviors": set(),
                "has_agent": False, "rows": 0, "valuefocus": 0, "license": license_status,
            }
        a["idates"].add(interaction_date)
        a["mids"].add(mid)
        a["behaviors"].add(bef)
        if agent_name.strip():
            a["has_agent"] = True
        a["rows"] += 1
        if usage_mode in _VALUEFOCUS_MODES:
            a["valuefocus"] += 1
        if license_status < a["license"]:  # MIN(License Status), lexicographic (matches DAX MIN)
            a["license"] = license_status

        u = ua.get(uid)
        if u is None:
            u = ua[uid] = {"rows": 0, "weeks": set(), "license": license_status}
        u["rows"] += 1
        u["weeks"].add(week)
        if license_status < u["license"]:
            u["license"] = license_status

    # ---- ActiveDaysSummary (filter ChatActiveDays > 0; always true here) ----
    ads_rows: list[tuple[str, str, int, int, str]] = []
    for (uid, month), a in um.items():
        chat_active_days = len(a["idates"])
        if chat_active_days <= 0:
            continue
        ads_rows.append((uid, month, chat_active_days, len(a["mids"]), a["license"]))
    ads_rows.sort(key=lambda r: (r[0], r[1]))

    # ---- UserMonthMetrics ----
    umm_rows: list[tuple] = []
    for (uid, month), a in um.items():
        active_days = len(a["idates"])
        behavior_count = len(a["behaviors"])
        value_focus_share = (a["valuefocus"] / a["rows"]) if a["rows"] else 0.0
        has_agent = a["has_agent"]
        user_month_key = f"{uid}|{month[:7]}" if (uid and month) else ""
        stage = _user_stage(active_days, behavior_count, value_focus_share, has_agent)
        umm_rows.append((
            uid, month, behavior_count, "True" if has_agent else "False",
            active_days, user_month_key, stage, value_focus_share,
        ))
    umm_rows.sort(key=lambda r: (r[0], r[1]))

    # ---- Rankings (per user, partitioned by license) ----
    def _build_rankings(target_license: str) -> list[tuple]:
        summary = []  # (uid, total_prompts, total_weeks, avg_ppw)
        for uid, u in ua.items():
            if u["license"] != target_license:
                continue
            total_prompts = u["rows"]
            total_weeks = len(u["weeks"])
            avg_ppw = (total_prompts / total_weeks) if total_weeks else 0.0
            summary.append((uid, total_prompts, total_weeks, avg_ppw))
        avgs = sorted(s[3] for s in summary)
        p90 = _percentile_inc(avgs, 0.90)
        p75 = _percentile_inc(avgs, 0.75)
        p50 = _percentile_inc(avgs, 0.50)
        p25 = _percentile_inc(avgs, 0.25)
        out = []
        for uid, tp, tw, avg in summary:
            out.append((uid, _usage_rank(avg, p90, p75, p50, p25), tp, tw, avg))
        out.sort(key=lambda r: r[0])
        return out

    licensed_rank_rows = _build_rankings("M365 Copilot Licensed")
    unlicensed_rank_rows = _build_rankings("Unlicensed")

    # ---- Licensed Chat User Summary (from ActiveDaysSummary, licensed only) ----
    lsum: dict[str, dict[str, int]] = {}
    for uid, month, chat_active_days, prompt_count, lic in ads_rows:
        if lic != "M365 Copilot Licensed":
            continue
        s = lsum.get(uid)
        if s is None:
            s = lsum[uid] = {"days": 0, "months": 0, "prompts": 0}
        s["days"] += chat_active_days
        s["months"] += 1  # every ADS row already has ChatActiveDays > 0
        s["prompts"] += prompt_count
    summary_rows: list[tuple] = []
    for uid, s in lsum.items():
        total_days = s["days"]
        total_months = s["months"]
        total_prompts = s["prompts"]
        avg_days = (total_days / total_months) if total_months else 0.0
        summary_rows.append((
            uid, _activity_segment(avg_days), total_days, total_months,
            total_prompts, avg_days,
        ))
    summary_rows.sort(key=lambda r: r[0])

    # ---- write all 5 ----
    def _write(path: str, header: list[str], rows: list[tuple], float_cols: set[int]) -> int:
        with open(path, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(header)
            for r in rows:
                w.writerow([_fmt_float(v) if i in float_cols else v for i, v in enumerate(r)])
        return len(rows)

    counts = {}
    counts["active_days"] = _write(
        agg_paths["active_days"],
        ["Audit_UserId", "MonthStart", "ChatActiveDays", "PromptCount", "LicenseStatus"],
        ads_rows, set(),
    )
    counts["user_month_metrics"] = _write(
        agg_paths["user_month_metrics"],
        ["Audit_UserId", "MonthStart", "BehaviorCount", "HasAgent", "ActiveDays",
         "UserMonthKey", "UserStage", "ValueFocusShare"],
        umm_rows, {7},
    )
    counts["licensed_rankings"] = _write(
        agg_paths["licensed_rankings"],
        ["Audit_UserId", "Usage Rank", "TotalPrompts", "TotalWeeks", "AvgPromptsPerWeek"],
        licensed_rank_rows, {4},
    )
    counts["unlicensed_rankings"] = _write(
        agg_paths["unlicensed_rankings"],
        ["Audit_UserId", "Usage Rank", "TotalPrompts", "TotalWeeks", "AvgPromptsPerWeek"],
        unlicensed_rank_rows, {4},
    )
    counts["licensed_summary"] = _write(
        agg_paths["licensed_summary"],
        ["Audit_UserId", "Activity Segment", "TotalActiveDays", "TotalMonths",
         "TotalPrompts", "AvgActiveDaysPerMonth"],
        summary_rows, {5},
    )

    if not quiet:
        print("  Pre-aggregated tables (AIBV):")
        print(f"    ActiveDaysSummary:        {counts['active_days']:,} rows")
        print(f"    UserMonthMetrics:         {counts['user_month_metrics']:,} rows")
        print(f"    Licensed User Rankings:   {counts['licensed_rankings']:,} rows")
        print(f"    Unlicensed User Rankings: {counts['unlicensed_rankings']:,} rows")
        print(f"    Licensed User Summary:    {counts['licensed_summary']:,} rows")

    return counts


def run_processor(
    purview_csv: str,
    entra_csv: str,
    fact_out_csv: str,
    users_out_csv: str,
    profile: str = "aibv",
    agg_paths: dict[str, str] | None = None,
    quiet: bool = False,
    licensing_csv: str | None = None,
) -> dict[str, Any]:
    start_time = time.perf_counter()
    stats: dict[str, Any] = {
        "input_records": 0,
        "skipped_non_copilot": 0,
        "output_rows": 0,
        "errors": 0,
        "unmatched_users": 0,
    }

    if not quiet:
        print(f"Purview CopilotInteraction Processor v{SCRIPT_VERSION}")
        print(f"  Profile:        {profile}")
        print(f"  JSON engine:    {_JSON_ENGINE}")
        print(f"  Purview input:  {purview_csv}")
        print(f"  Entra input:    {entra_csv}")
        if licensing_csv:
            print(f"  Licensing:      {licensing_csv}")
        print(f"  Purview output: {fact_out_csv}")
        print(f"  Entra output:   {users_out_csv}")
        print()
        print("Loading Entra users + writing Users dim CSV...")

    # Shared INT-surrogate maps. UserKey is populated first by the Entra
    # loader (so Entra-known users get the lowest INTs / lowest dictionary
    # offsets in VertiPaq); the fact path then reuses + extends the map.
    user_key_map: dict[str, int] = {}
    thread_key_map: dict[str, int] = {}

    user_lookup = load_entra_and_write_users(
        entra_csv, users_out_csv, user_key_map, licensing_csv=licensing_csv, quiet=quiet
    )

    if not quiet:
        print()
        print("Flattening CopilotInteraction records...")

    # One row per (grain x distinct Message_Id). Per-resource accumulation
    # is intentionally avoided here so counts are not inflated ~2.25x by
    # per (prompt x AccessedResource) iteration. Downstream measures use
    # DISTINCTCOUNT(Message_Id) for exact parity with the semantic-model
    # definitions.
    #
    # Message_Id is INT-surrogated (1-based, encounter order) for CSV size
    # and parse-time win on the highest-cardinality column.
    #
    # Key:    (grain_tuple, message_id_int)
    # Value:  dict of non-grain attrs (last-write-wins on a per-resource
    #         basis for AccessedResource_* / SensitivityLabelId — same
    #         semantic as the prior dict-overwrite behavior).
    rollup: dict[tuple[Any, ...], dict[str, Any]] = {}
    mid_to_int: dict[str, int] = {}
    unmatched: set[str] = set()

    with open(purview_csv, "r", encoding="utf-8-sig", newline="") as fin:
        reader = csv.DictReader(fin)

        for raw_row in reader:
            stats["input_records"] += 1

            audit_raw = raw_row.get("AuditData", "") or ""
            try:
                audit_data = json_loads(audit_raw) if audit_raw.strip() else {}
            except Exception:
                stats["errors"] += 1
                continue

            if not isinstance(audit_data, dict):
                stats["errors"] += 1
                continue

            if not is_copilot_interaction(audit_data, raw_row):
                stats["skipped_non_copilot"] += 1
                continue

            try:
                rows = explode_record(audit_data, user_lookup, user_key_map, thread_key_map, profile)
            except Exception:
                stats["errors"] += 1
                continue

            for grain_key, message_id_str, nongrain, in_entra, audit_user_norm in rows:
                stats["output_rows"] += 1
                if not in_entra and audit_user_norm:
                    unmatched.add(audit_user_norm)
                mid_int = mid_to_int.get(message_id_str)
                if mid_int is None:
                    mid_int = len(mid_to_int) + 1
                    mid_to_int[message_id_str] = mid_int
                rollup[(grain_key, mid_int)] = nongrain

    if not quiet:
        print(f"  Input records:         {stats['input_records']:,}")
        print(f"  Skipped (non-Copilot): {stats['skipped_non_copilot']:,}")
        print(f"  Raw prompt rows:       {stats['output_rows']:,}")
        print(f"  Errors:                {stats['errors']:,}")
        print()
        print("Writing rolled-up fact CSV...")

    # Profile-specific output schema (AIO = v3.1.0 36-col; AIBV = 50-col superset).
    grain_keys, nongrain_attrs_sel, fact_header = schema_for(profile)
    with open(fact_out_csv, "w", encoding="utf-8", newline="") as fout:
        writer = csv.writer(fout, lineterminator="\n")
        writer.writerow(fact_header)
        # Pre-compute the index of Message_Id within FACT_HEADER so we can
        # splice the INT surrogate into a list-of-attrs in one shot. The
        # list-based csv.writer.writerow path is materially faster than
        # DictWriter (skips dict-to-list translation + per-row genexpr).
        nongrain_attrs = nongrain_attrs_sel  # local rebind
        grain_len = len(grain_keys)
        for (grain_key, mid_int), attrs in rollup.items():
            # fact_header = grain_keys + ("Message_Id",) + nongrain_attrs
            row_out = list(grain_key)
            row_out.append(mid_int)
            row_out.extend(attrs[k] for k in nongrain_attrs)
            writer.writerow(row_out)

    stats["output_rows_rollup"] = len(rollup)
    stats["distinct_message_ids"] = len(mid_to_int)
    stats["distinct_thread_ids"] = len(thread_key_map)
    stats["distinct_user_keys"] = len(user_key_map)
    stats["unmatched_users"] = len(unmatched)

    # Pre-aggregated tables (AIBV profile only). These offload the DAX
    # calculated tables (ActiveDaysSummary / UserMonthMetrics / rankings /
    # summary), each of which otherwise SUMMARIZEs the whole fact on refresh.
    if profile != "aio" and agg_paths:
        if not quiet:
            print()
            print("Writing pre-aggregated tables...")
        compute_and_write_aggregates(rollup, agg_paths, quiet=quiet)
    elapsed = time.perf_counter() - start_time
    if not quiet:
        reduction_pct = (1 - len(rollup) / stats["output_rows"]) * 100 if stats["output_rows"] else 0
        print(f"  Rollup rows:           {len(rollup):,}  ({reduction_pct:.1f}% reduction)")
        print(f"  Distinct Message_Ids:  {len(mid_to_int):,}")
        print(f"  Distinct ThreadIds:    {len(thread_key_map):,}")
        print(f"  Distinct UserKeys:     {len(user_key_map):,}")
        print(f"  Unmatched users:       {stats['unmatched_users']:,}")
        print(f"  Elapsed:               {elapsed:.2f}s")

    return stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            f"Purview CopilotInteraction Processor v{SCRIPT_VERSION} - "
            "Two/three-input, two-output preprocessor that produces a rolled-up "
            "Interactions fact CSV (~85% row reduction via PromptCount grain) "
            "and a Users dim CSV for the AI Business Value Dashboard PBIP."
        )
    )
    parser.add_argument(
        "--purview",
        required=True,
        help="Path to the raw Purview audit log CSV (must contain AuditData column).",
    )
    parser.add_argument(
        "--entra",
        required=True,
        help=(
            "Path to the Entra users CSV (UPN + org columns). The license column "
            "is optional: supply it separately via --licensing (recommended for "
            "standalone use), or omit --licensing to use a single combined "
            "users+licensing file (license column auto-detected)."
        ),
    )
    parser.add_argument(
        "--licensing",
        default=None,
        help=(
            "Path to a separate licensing CSV (UPN + 'Has License' columns), e.g. "
            "the Microsoft Admin Center Copilot user export. When provided, "
            "--entra is treated as a users-only file and license status is merged "
            "in from this file (the 3-file workflow). Omit to use a single "
            "combined Entra file (license column auto-detected). Applies to both "
            "--profile aibv and --profile aio."
        ),
    )
    parser.add_argument(
        "--combined-entra",
        action="store_true",
        default=False,
        help=(
            "Legacy 2-file mode: assert that --entra is a single combined "
            "users+licensing file (as produced by the PAX script). Mutually "
            "exclusive with --licensing. Optional - even without this flag a "
            "combined file still works (the license column is auto-detected)."
        ),
    )
    parser.add_argument(
        "--out-dir",
        "-o",
        default=None,
        help="Directory for output files. Default: same directory as the Purview file.",
    )
    parser.add_argument(
        "--profile",
        "-p",
        choices=("aibv", "aio"),
        default="aibv",
        help=(
            "Output profile. 'aibv' (default) = AI Business Value Dashboard "
            "superset (50-col fact, 3-value Environment). 'aio' = AI-in-One "
            "Dashboard (36-col fact, 5-value Environment) — reproduces the "
            "v3.1.0 AIO output exactly."
        ),
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        default=False,
        help="Suppress progress output.",
    )
    parser.add_argument(
        "--with-aggregates",
        action="store_true",
        default=False,
        help=(
            "Also write the AIBV pre-aggregated tables (ActiveDaysSummary, "
            "UserMonthMetrics, Licensed/Unlicensed user rankings, Licensed user "
            "summary). OFF by default — the AIBV template only needs the two core "
            "rollup files (Interactions + Users). No effect for --profile aio."
        ),
    )
    parser.add_argument(
        # Deprecated no-op: aggregates are now OFF by default, so this flag does
        # nothing. Kept so older command lines don't error.
        "--no-aggregates",
        action="store_true",
        default=False,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {SCRIPT_VERSION}",
    )

    args = parser.parse_args()

    if args.licensing and args.combined_entra:
        print(
            "ERROR: --licensing and --combined-entra are mutually exclusive. Use "
            "--licensing for the 3-file (separate licensing) workflow, or "
            "--combined-entra (or neither) for a single combined Entra file.",
            file=sys.stderr,
        )
        sys.exit(1)

    purview_path = os.path.abspath(args.purview)
    entra_path = os.path.abspath(args.entra)
    for label, p in (("Purview", purview_path), ("Entra", entra_path)):
        if not os.path.isfile(p):
            print(f"ERROR: {label} input file not found: {p}", file=sys.stderr)
            sys.exit(1)

    licensing_path = os.path.abspath(args.licensing) if args.licensing else None
    if licensing_path and not os.path.isfile(licensing_path):
        print(f"ERROR: Licensing input file not found: {licensing_path}", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(os.path.abspath(args.out_dir)) if args.out_dir else Path(purview_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    purview_stem = Path(purview_path).stem
    entra_stem = Path(entra_path).stem
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    fact_out = str(out_dir / f"{purview_stem}_Interactions_{run_ts}.csv")
    users_out = str(out_dir / f"{entra_stem}_Users_{run_ts}.csv")

    # Pre-aggregated table paths (AIBV only, opt-in via --with-aggregates).
    # Default: not written — the AIBV template consumes only the Interactions
    # + Users rollups. The aggregates remain available for the future
    # calc-table offload (point the 5 DAX calc tables at these CSVs).
    agg_paths: dict[str, str] | None = None
    if args.profile != "aio" and args.with_aggregates:
        agg_paths = {
            "active_days": str(out_dir / f"{purview_stem}_ActiveDaysSummary_{run_ts}.csv"),
            "user_month_metrics": str(out_dir / f"{purview_stem}_UserMonthMetrics_{run_ts}.csv"),
            "licensed_rankings": str(out_dir / f"{purview_stem}_LicensedUserRankings_{run_ts}.csv"),
            "unlicensed_rankings": str(out_dir / f"{purview_stem}_UnlicensedUserRankings_{run_ts}.csv"),
            "licensed_summary": str(out_dir / f"{purview_stem}_LicensedUserSummary_{run_ts}.csv"),
        }

    stats = run_processor(
        purview_csv=purview_path,
        entra_csv=entra_path,
        fact_out_csv=fact_out,
        users_out_csv=users_out,
        profile=args.profile,
        agg_paths=agg_paths,
        quiet=args.quiet,
        licensing_csv=licensing_path,
    )
    sys.exit(1 if stats["errors"] > 0 else 0)


if __name__ == "__main__":
    main()
