"""Agent type classification, copied verbatim from Copilot_Audit_Log_Processor.ipynb (cell 2).

tests/test_valuelens_core_agents.py checks every definition here against the notebook.
Change the notebook and this module together.
"""
from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Agent type classification: what kind of agent a row used and who published it.
# Port of the rules in the Purview audit-log analyser. Pure Python: the processor
# runs it once per distinct agent key combination on the driver.
# Agent_Type_Basis says how firm each category is:
#   documented = a value pattern Microsoft documents for audit records
#   observed   = seen in real audit data but not formally documented
#   inferred   = the T_ / U_ / P_ agent-ID prefix convention, which Microsoft
#                does not document
#   override   = set by the optional AGENT_TYPE_OVERRIDES_TABLE
# ---------------------------------------------------------------------------
AGENT_TYPE_FP_PUBLISHED = "Microsoft first-party agents - published"
AGENT_TYPE_FP_NON_PUBLISHED = "Microsoft first-party agents - non-published"
AGENT_TYPE_FP_M365 = "Microsoft first-party agents - M365 Copilot agents"
AGENT_TYPE_DECLARATIVE = "Microsoft 365 Copilot Agent Builder - declarative agents"
AGENT_TYPE_CUSTOM_ENGINE = "Copilot Studio - custom engine agents"
AGENT_TYPE_COPILOT_STUDIO = "Copilot Studio - other / standalone agents"
AGENT_TYPE_FACILITATOR = "Microsoft Facilitator (Teams)"
AGENT_TYPE_ORG_PUBLISHED = "Published by your organisation"
AGENT_TYPE_SHARED = "Shared by creator"
AGENT_TYPE_STORE = "Agent Store package (publisher not identified)"
AGENT_TYPE_CONNECTED_APP = "Custom / third-party AI apps registered in your organisation"
AGENT_TYPE_UNCLASSIFIED = "Unclassified agents"

# Agent_Type -> (Agent_Publisher, Agent_Is_Published, Agent_Type_Basis).
# Agent_Is_Published is None where the audit log cannot tell.
AGENT_TYPE_INFO = {
    AGENT_TYPE_FP_PUBLISHED: ("Microsoft", True, "documented/observed"),
    AGENT_TYPE_FP_NON_PUBLISHED: ("Microsoft", False, "documented/observed"),
    AGENT_TYPE_FP_M365: ("Microsoft", True, "observed"),
    AGENT_TYPE_DECLARATIVE: ("Your organisation", None, "documented"),
    AGENT_TYPE_CUSTOM_ENGINE: ("Your organisation", None, "documented"),
    AGENT_TYPE_COPILOT_STUDIO: ("Your organisation", None, "documented"),
    AGENT_TYPE_FACILITATOR: ("Microsoft", True, "documented"),
    AGENT_TYPE_ORG_PUBLISHED: ("Your organisation", True, "inferred"),
    AGENT_TYPE_SHARED: ("User-shared", False, "inferred"),
    AGENT_TYPE_STORE: ("Agent Store", True, "inferred"),
    AGENT_TYPE_CONNECTED_APP: ("Connected app", None, "documented"),
    AGENT_TYPE_UNCLASSIFIED: ("Unknown", None, None),
}
FIRST_PARTY_AGENT_TYPES = (AGENT_TYPE_FP_PUBLISHED, AGENT_TYPE_FP_NON_PUBLISHED,
                           AGENT_TYPE_FP_M365, AGENT_TYPE_FACILITATOR)

# Microsoft agents that sometimes appear by name only. Extend as needed.
MICROSOFT_AGENT_NAMES = (
    "Researcher", "Analyst", "Facilitator", "Word Drafting Agent", "Draft as 1P Agent",
    "Prompt Coach", "Writing Coach", "Idea Coach", "Career Coach", "Learning Coach", "Surveys",
    "Skills Agent", "Employee Self-Service", "Visual Creator", "Project Manager",
    "Knowledge Agent", "Interpreter", "Sales Agent", "Service Agent", "People", "Photos",
)


def _agent_text(value) -> str:
    return "" if value is None else str(value).strip()


def _agent_name_key(value) -> str:
    # 'Word Drafting Agent', 'WordDraftingAgent' and 'word-drafting-agent' compare equal.
    return re.sub(r"[^a-z0-9]", "", _agent_text(value).lower())


MICROSOFT_AGENT_CANONICAL = {_agent_name_key(name): name for name in MICROSOFT_AGENT_NAMES}


def _microsoft_agent_segment(app_identity) -> str:
    # '<name>' of an AppIdentity 'MicrosoftAgent.<name>.<...>'.
    match = re.match(r"(?i)^microsoftagent\.([^.]+)", _agent_text(app_identity))
    return match.group(1) if match else ""


def microsoft_agent_name(agent_id=None, agent_name=None, app_identity=None):
    """Canonical Microsoft agent name ('Researcher', 'Word Drafting Agent', ...) or None.

    Tries the agent name, the agent ID (with and without a 'BuiltIn_' prefix) and the
    <name> part of 'MicrosoftAgent.<name>.<...>'.
    """
    aid = _agent_text(agent_id)
    candidates = [agent_name, aid, _microsoft_agent_segment(app_identity)]
    if aid.lower().startswith("builtin_"):
        candidates.append(aid[len("builtin_"):])
    for candidate in candidates:
        found = MICROSOFT_AGENT_CANONICAL.get(_agent_name_key(candidate))
        if found:
            return found
    return None


def build_agent_type_overrides(rows):
    """{lower-cased key: Agent_Type} from (key, Agent_Type) pairs. Blank pairs are skipped."""
    result = {}
    for key, agent_type in rows:
        key, agent_type = _agent_text(key).lower(), _agent_text(agent_type)
        if key and agent_type:
            result[key] = agent_type
    return result


def agent_type_override(overrides, agent_id=None, agent_name=None, app_identity=None):
    # Agent ID first, then agent name, then AppIdentity.
    for key in (agent_id, agent_name, app_identity):
        key = _agent_text(key).lower()
        if key and overrides and key in overrides:
            return overrides[key]
    return None


def classify_agent(agent_id=None, agent_name=None, app_identity=None, agent_type=None, workload=None):
    """Agent_Type for one row, or None when the row involves no agent. First match wins."""
    aid, name, app = _agent_text(agent_id), _agent_text(agent_name), _agent_text(app_identity)
    aid_l, app_l = aid.lower(), app.lower()
    kind = re.sub(r"\s", "", _agent_text(agent_type).lower())
    work = _agent_text(workload).lower()
    blob = f"{aid_l} {app_l}"
    if work == "aiapp" or app_l.startswith("aiapp."):
        return None  # third-party SaaS AI apps (for example ChatGPT) are not agents
    if work == "connectedaiapp" or app_l.startswith("connectedaiapp."):
        return AGENT_TYPE_CONNECTED_APP
    if app_l.startswith("copilot.teamcopilot."):
        return AGENT_TYPE_FACILITATOR
    if "customengine" in blob:
        return AGENT_TYPE_CUSTOM_ENGINE
    if "copilotstudio.declarative" in blob or "copilot.studio.declarative" in blob:
        return AGENT_TYPE_DECLARATIVE
    if app_l.startswith("microsoftagent.") or aid_l.startswith("builtin_") or microsoft_agent_name(aid, name, app):
        if app_l.startswith("copilot.m365copilot"):
            return AGENT_TYPE_FP_M365
        if app_l.startswith("microsoftagent."):
            published = re.match(r"^microsoftagent\..+\.p_", app_l) is not None
        else:
            published = aid_l.startswith("p_")
        return AGENT_TYPE_FP_PUBLISHED if published else AGENT_TYPE_FP_NON_PUBLISHED
    if app_l.startswith("copilot.studio.") or kind == "copilotstudio":
        return AGENT_TYPE_COPILOT_STUDIO
    if not (aid or name or kind):
        return None  # plain Copilot chat: no agent fields
    prefix = (aid or app)[:2].upper()
    if prefix == "T_":
        return AGENT_TYPE_ORG_PUBLISHED
    if prefix == "U_":
        return AGENT_TYPE_SHARED
    if prefix == "P_":
        return AGENT_TYPE_STORE
    # An agent inside the Microsoft 365 Copilot app that no rule above identified.
    if app_l.startswith("copilot.m365copilot"):
        return AGENT_TYPE_FP_M365
    return AGENT_TYPE_UNCLASSIFIED


def describe_agent(agent_id=None, agent_name=None, app_identity=None, agent_type=None, workload=None,
                   overrides=None):
    """(Agent_Key, Agent_Type, Agent_Type_Basis, Agent_Publisher, Agent_Is_Published,
    Agent_Consolidated_Name) for one row. All None when the row involves no agent.

    Agent_Consolidated_Name rolls every Microsoft first-party row up to one canonical
    name (for example all Researcher rows, whatever their ID or host); other agents
    keep their own name.
    """
    aid, name, app = _agent_text(agent_id), _agent_text(agent_name), _agent_text(app_identity)
    override = agent_type_override(overrides, aid, name, app)
    category = override or classify_agent(aid, name, app, agent_type, workload)
    if not category:
        return (None,) * 6
    publisher, published, basis = AGENT_TYPE_INFO.get(category, ("Unknown", None, None))
    if override:
        basis = "override"
    consolidated = None
    if category in FIRST_PARTY_AGENT_TYPES:
        consolidated = (microsoft_agent_name(aid, name, app)
                        or ("Facilitator" if category == AGENT_TYPE_FACILITATOR else None)
                        or name or _microsoft_agent_segment(app))
    return (aid or name or app or None, category, basis, publisher, published,
            consolidated or name or aid or app or None)
