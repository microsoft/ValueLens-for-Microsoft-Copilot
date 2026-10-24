"""Agent link and exclusion rules, copied verbatim from Copilot_Audit_Log_Processor.ipynb (cell 2).

tests/test_valuelens_core_agents.py checks every definition here against the notebook.
Change the notebook and this module together.
"""
from __future__ import annotations

import re


# Records that are not end-user agent usage. Flagged with the first matching reason:
#   AppHost "Copilot Studio"       -> the maker's test pane
#   AppHost "pva-maker-evaluation" -> Copilot Studio evaluation runs
#   AppHost "agentic-builder"      -> agent authoring in Agent Builder
#   AppHost "autonomous"           -> autonomous (trigger-driven) agent runs
#   AppHost "workflow-agents"      -> workflow agent runs
#   no messages + AppHost "M365Copilot" -> the Copilot Studio runtime twin of an
#       M365 Copilot chat that is already counted from its own prompt record
#   all-zero AgentId               -> Fabric multi-agent orchestration
# Plain SQL (lower/trim/coalesce/replace) so the same text runs in Spark and in the tests.
EXCLUDE_REASON_SQL = """
CASE
  WHEN lower(trim(coalesce(AppHost, ''))) = 'copilot studio' THEN 'Copilot Studio test pane'
  WHEN lower(trim(coalesce(AppHost, ''))) = 'pva-maker-evaluation' THEN 'Maker evaluation'
  WHEN lower(trim(coalesce(AppHost, ''))) = 'agentic-builder' THEN 'Agent authoring'
  WHEN lower(trim(coalesce(AppHost, ''))) = 'autonomous' THEN 'Autonomous run'
  WHEN lower(trim(coalesce(AppHost, ''))) = 'workflow-agents' THEN 'Workflow run'
  WHEN upper(trim(coalesce(Prompts_Available, 'TRUE'))) = 'FALSE'
       AND lower(trim(coalesce(AppHost, ''))) = 'm365copilot' THEN 'M365 Copilot twin'
  WHEN trim(coalesce(AgentId, '')) <> ''
       AND replace(replace(lower(trim(coalesce(AgentId, ''))), '-', ''), '0', '') = ''
       THEN 'Fabric multi-agent'
  ELSE NULL
END
"""


# ---------------------------------------------------------------------------
# Agent linking. Pure Python: the registry is small enough to resolve on the driver.
# ---------------------------------------------------------------------------
PLATFORM_AGENT_ID_PATTERN = r'^(.*)_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
BARE_GUID_PATTERN = r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
# Declarative agent ids 'T_<title guid>.<schema guid>' tie a schema GUID to a Title ID.
TITLE_SCHEMA_PATTERN = r'^([TtPp]_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'


def _link_key(value) -> str:
    return "" if value is None else str(value).strip().lower()


def _letters(value) -> str:
    return re.sub(r"[^a-z]", "", _link_key(value))


def _is_zero_guid(value) -> bool:
    key = _link_key(value)
    return bool(key) and not key.replace("-", "").replace("0", "")


def _split_link_keys(value):
    parts = re.split(r"[;,]", "" if value is None else str(value))
    return [k for k in (_link_key(p) for p in parts) if k]


def preferred_agent(rows):
    # The LOB copy first, then Shared, then any other type; then the newest
    # Last updated; then the lowest Title ID, so the choice is deterministic.
    rank = {"lob": 0, "shared": 1}
    ordered = sorted(rows, key=lambda r: str(r.get("title") or "").strip())
    ordered = sorted(ordered, key=lambda r: str(r.get("updated") or ""), reverse=True)
    ordered = sorted(ordered, key=lambda r: rank.get(_link_key(r.get("type")), 2))
    return ordered[0]


def is_copilot_studio_copy(row) -> bool:
    # Only LOB/Shared Copilot Studio agents are merged. Agent Builder agents are
    # never merged: two of them with the same name are usually different agents.
    if _link_key(row.get("type")) not in ("lob", "shared"):
        return False
    created_in = _letters(row.get("created_in"))
    if "agentbuilder" in created_in:
        return False
    return bool(_split_link_keys(row.get("bot"))) or "copilotstudio" in created_in


def build_agent_link_maps(registry_rows):
    """Lookup maps for resolve_agent_link.

    registry_rows: dicts with title, bot, entra, type, created_in and updated.
    LOB and Shared copies of one Copilot Studio agent (same Bot Id or Entra agent
    ID) form a group whose canonical Title ID is the preferred (LOB) copy.
    """
    by_title = {}
    for row in registry_rows:
        title = str(row.get("title") or "").strip()
        if title:
            by_title.setdefault(title.upper(), []).append(dict(row, title=title))
    agents = {key: preferred_agent(rows) for key, rows in by_title.items()}

    bot_rows, entra_rows = {}, {}
    for agent in agents.values():
        for bot in _split_link_keys(agent.get("bot")):
            bot_rows.setdefault(bot, []).append(agent)
        entra = _link_key(agent.get("entra"))
        if entra and not _is_zero_guid(entra):
            entra_rows.setdefault(entra, []).append(agent)

    parent = {}

    def find(key):
        parent.setdefault(key, key)
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    for sharing in list(bot_rows.values()) + list(entra_rows.values()):
        members = [a["title"].upper() for a in sharing if is_copilot_studio_copy(a)]
        for other in members[1:]:
            parent[find(other)] = find(members[0])
    groups = {}
    for key in list(parent):
        groups.setdefault(find(key), []).append(agents[key])
    canonical = {}
    for members in groups.values():
        if len(members) > 1:
            lead = preferred_agent(members)["title"]
            for member in members:
                canonical[member["title"].upper()] = lead

    return {
        "title": {key: agent["title"] for key, agent in agents.items()},
        "bot": {key: preferred_agent(rows)["title"] for key, rows in bot_rows.items()},
        "entra": {key: preferred_agent(rows)["title"] for key, rows in entra_rows.items()},
        "canonical": canonical,
    }


def build_schema_title_map(agent_ids):
    # schema GUID -> Title ID, from 'T_<title guid>.<schema guid>' agent ids seen in
    # the audit log. Kept only when the schema GUID maps to exactly one Title ID.
    seen = {}
    for agent_id in agent_ids:
        match = re.match(TITLE_SCHEMA_PATTERN, "" if agent_id is None else str(agent_id).strip())
        if match:
            seen.setdefault(match.group(2).lower(), set()).add(match.group(1).upper())
    return {key: next(iter(titles)) for key, titles in seen.items() if len(titles) == 1}


def resolve_agent_link(maps, title_id=None, bot_id=None, entra_id=None, schema_title=None):
    """(Agent_LinkID, Agent_MatchedTitleID, Agent_LinkMethod) for one audit row.

    Keys are tried in order: Title ID, Bot Id, Entra agent ID, schema GUID. Agent
    names are never used. Agent_LinkMethod is 'Unlinked' when the row names an
    agent the registry does not hold, and None when the row has no agent key.
    """
    candidates = (
        ("Title ID", maps["title"].get(str(title_id or "").strip().upper())),
        ("Bot Id", maps["bot"].get(_link_key(bot_id))),
        ("Entra Agent ID", None if _is_zero_guid(entra_id) else maps["entra"].get(_link_key(entra_id))),
        ("Schema GUID", maps["title"].get(str(schema_title or "").strip().upper())),
    )
    for method, matched in candidates:
        if matched:
            return maps["canonical"].get(matched.upper(), matched), matched, method
    if any(_link_key(v) and not _is_zero_guid(v) for v in (title_id, bot_id, entra_id)):
        return None, None, "Unlinked"
    return None, None, None
