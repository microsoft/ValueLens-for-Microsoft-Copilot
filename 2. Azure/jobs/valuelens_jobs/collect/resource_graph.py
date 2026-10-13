"""Agent configuration and the Foundry estate from Azure Resource Graph, with the jobs' managed identity.
A port of the Fabric notebook `Copilot_Resource_Graph_Ingester` (same tables and columns):

* `arg_agent_config`, `arg_environments`, `arg_agent_flows`: Copilot Studio agents, Power Platform
  environments and agent flows from `PowerPlatformResources`. The identity needs an Entra role that
  can read the Power Platform inventory (Power Platform Administrator, Global Reader or AI
  Administrator). App-only access to this table isn't documented, so when Resource Graph refuses it
  or returns nothing, the latest file the "Analytics Hub - Agent inventory" flow dropped in
  `landing/arg_inventory/` is used instead (the flow reads the inventory API as a signed-in admin).
* `arg_foundry_resources`: Foundry accounts and projects, and Azure Machine Learning workspaces, from
  `resources`. The identity needs Reader where the resources are: a management group, or the tenant
  root group to see all of them. Resource Graph returns only what the identity can see.
* `arg_status`: one row per probe (ok, empty, forbidden, error or skipped) so the dashboard can say
  why a page is empty.

Every probe is best effort: a failed probe leaves its table as it was and the others still run.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from urllib.parse import urlsplit

from ..api import ARM as ARM_SCOPE
from ..api import HttpError
from ..dropfolder import open_dropfolder
from ..tables import parquet_glob, write_rows

log = logging.getLogger("valuelens_jobs.collect.resource_graph")

ARG_URL = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources"
ARG_API = "2022-10-01"
INVENTORY_DIR = "arg_inventory"
MAX_PAGES = 1000


# --- Shared with the Fabric notebook Copilot_Resource_Graph_Ingester.ipynb (section 2); keep identical. ---
ARG_PAGE_SIZE = 1000
TBL_AGENTS = "arg_agent_config"
TBL_ENVIRONMENTS = "arg_environments"
TBL_FLOWS = "arg_agent_flows"
TBL_FOUNDRY = "arg_foundry_resources"
TBL_STATUS = "arg_status"

AGENT_TYPE = "microsoft.copilotstudio/agents"
ENVIRONMENT_TYPE = "microsoft.powerplatform/environments"
FLOW_TYPE = "microsoft.powerautomate/agentflows"
FOUNDRY_TYPES = ("microsoft.cognitiveservices/accounts", "microsoft.cognitiveservices/accounts/projects",
                 "microsoft.machinelearningservices/workspaces")

ARG_QUERIES = {
    TBL_AGENTS: f"PowerPlatformResources | where type =~ '{AGENT_TYPE}' "
                "| project id, name, type, location, properties",
    TBL_ENVIRONMENTS: f"PowerPlatformResources | where type =~ '{ENVIRONMENT_TYPE}' "
                      "| project id, name, type, location, properties",
    TBL_FLOWS: f"PowerPlatformResources | where type =~ '{FLOW_TYPE}' "
               "| project id, name, type, location, properties",
    TBL_FOUNDRY: "resources | where type in~ ("
                 + ", ".join(f"'{t}'" for t in FOUNDRY_TYPES) + ") "
                 "| project id, name, type, kind, location, subscriptionId, resourceGroup, sku, "
                 "publicNetworkAccess = tostring(properties.publicNetworkAccess), "
                 "disableLocalAuth = tobool(properties.disableLocalAuth)",
}
# The tables Resource Graph serves from PowerPlatformResources: these fall back to the inventory flow.
INVENTORY_TABLES = (TBL_AGENTS, TBL_ENVIRONMENTS, TBL_FLOWS)
INVENTORY_TYPES = {AGENT_TYPE: TBL_AGENTS, ENVIRONMENT_TYPE: TBL_ENVIRONMENTS, FLOW_TYPE: TBL_FLOWS}

ARG_SCHEMAS = {
    TBL_AGENTS: [("SnapshotDate", "DATE"), ("AgentResourceId", "VARCHAR"), ("BotId", "VARCHAR"),
                 ("AgentName", "VARCHAR"), ("EntraAgentId", "VARCHAR"), ("EntraAppId", "VARCHAR"),
                 ("TitleId", "VARCHAR"), ("MatchedOn", "VARCHAR"), ("EnvironmentId", "VARCHAR"),
                 ("Authentication", "VARCHAR"), ("NoSignIn", "BOOLEAN"), ("IsQuarantined", "BOOLEAN"),
                 ("IsManaged", "BOOLEAN"), ("WebSearchEnabled", "BOOLEAN"), ("ConnectorCount", "BIGINT"),
                 ("McpConnectorCount", "BIGINT"), ("KnowledgeConnectorCount", "BIGINT"),
                 ("ConnectedAgentCount", "BIGINT"), ("Connectors", "VARCHAR"), ("SharedUsers", "BIGINT"),
                 ("SharedGroups", "BIGINT"), ("SharedEntireTenant", "BOOLEAN"), ("Orchestration", "VARCHAR"),
                 ("Model", "VARCHAR"), ("Channels", "VARCHAR"), ("OwnerId", "VARCHAR"), ("CreatedIn", "VARCHAR"),
                 ("LastPublishedAt", "VARCHAR"), ("Source", "VARCHAR")],
    TBL_ENVIRONMENTS: [("SnapshotDate", "DATE"), ("EnvironmentId", "VARCHAR"), ("EnvironmentName", "VARCHAR"),
                       ("EnvironmentType", "VARCHAR"), ("IsDefault", "BOOLEAN"), ("IsManaged", "BOOLEAN"),
                       ("Region", "VARCHAR"), ("Source", "VARCHAR")],
    TBL_FLOWS: [("SnapshotDate", "DATE"), ("FlowId", "VARCHAR"), ("FlowName", "VARCHAR"),
                ("EnvironmentId", "VARCHAR"), ("OwnerId", "VARCHAR"), ("ConnectorCount", "BIGINT"),
                ("Trigger", "VARCHAR"), ("CreatedAt", "VARCHAR"), ("LastModifiedAt", "VARCHAR"),
                ("Source", "VARCHAR")],
    TBL_FOUNDRY: [("SnapshotDate", "DATE"), ("ResourceId", "VARCHAR"), ("ResourceName", "VARCHAR"),
                  ("ResourceType", "VARCHAR"), ("Kind", "VARCHAR"), ("Location", "VARCHAR"),
                  ("SubscriptionId", "VARCHAR"), ("ResourceGroup", "VARCHAR"), ("Sku", "VARCHAR"),
                  ("PublicNetworkAccess", "VARCHAR"), ("PublicNetwork", "BOOLEAN"),
                  ("DisableLocalAuth", "BOOLEAN"), ("IsProject", "BOOLEAN"), ("AccountId", "VARCHAR")],
    TBL_STATUS: [("SnapshotDate", "DATE"), ("Probe", "VARCHAR"), ("Status", "VARCHAR"), ("Rows", "BIGINT"),
                 ("Source", "VARCHAR"), ("Detail", "VARCHAR")],
}
SOURCE_ARG = "Resource Graph"
SOURCE_INVENTORY = "Inventory API (flow)"


def arg_body(query, skip_token=None, management_group=""):
    """The Resource Graph request: a page of `query`, at the tenant or one management group."""
    options = {"$top": ARG_PAGE_SIZE, "resultFormat": "objectArray"}
    if skip_token:
        options["$skipToken"] = skip_token
    body = {"query": query, "options": options}
    if management_group:
        body["managementGroups"] = [management_group]
    return body


def failure_status(status_code):
    """A refused probe is `forbidden` (the identity lacks the role); anything else is an `error`."""
    return "forbidden" if status_code in (401, 403) else "error"


def _prop(props, *names):
    """A property by any of `names`, case-insensitively; also looks one level into `knowledge`."""
    if not isinstance(props, dict):
        return None
    folded = {str(k).lower(): v for k, v in props.items()}
    for name in names:
        if name.lower() in folded:
            return folded[name.lower()]
    nested = folded.get("knowledge")
    if isinstance(nested, dict):
        return _prop(nested, *names)
    return None


def _text(value):
    return "" if value is None else str(value).strip()


def _flag(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("true", "1", "yes"):
        return True
    if text in ("false", "0", "no"):
        return False
    return None


def _count(value):
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _guid(value):
    return _text(value).lower()


def agent_row(record, snapshot, source=SOURCE_ARG):
    """One `arg_agent_config` row from a `microsoft.copilotstudio/agents` record."""
    props = record.get("properties") or {}
    connectors = [c for c in (_prop(props, "powerPlatformConnectors") or []) if isinstance(c, dict)]
    ids = sorted({_text(c.get("connectorId")) for c in connectors if _text(c.get("connectorId"))})
    knowledge = 0
    for connector in connectors:
        for op in connector.get("operations") or []:
            if isinstance(op, dict) and _text(_prop(op, "usedAs")).lower() == "knowledge":
                knowledge += 1
    counts = _prop(props, "capabilitiesCounts") or {}
    connected = 0
    if isinstance(counts, dict):
        connected = sum(_count(v) for k, v in counts.items() if "connectedagent" in str(k).lower())
    viewers = _prop(props, "sharedWithViewers") or {}
    viewers = viewers if isinstance(viewers, dict) else {}
    auth = _text(_prop(props, "authentication"))
    channels = _prop(props, "channels") or []
    bot = _guid(_prop(props, "botId")) or _guid(_prop(props, "name")) or _guid(record.get("name"))
    return {
        "SnapshotDate": snapshot,
        "AgentResourceId": _text(record.get("id")).lower(),
        "BotId": bot,
        "AgentName": _text(_prop(props, "displayName")) or _text(record.get("name")),
        "EntraAgentId": _guid(_prop(props, "entraAgentId")),
        "EntraAppId": _guid(_prop(props, "entraAppId")),
        "TitleId": "",
        "MatchedOn": "",
        "EnvironmentId": _guid(_prop(props, "environmentId")),
        "Authentication": auth,
        "NoSignIn": auth.lower() == "none" if auth else None,
        "IsQuarantined": _flag(_prop(props, "isQuarantined")),
        "IsManaged": _flag(_prop(props, "isManaged")),
        "WebSearchEnabled": _flag(_prop(props, "IsWebSearchEnabledForKnowledge", "isWebSearchEnabled")),
        "ConnectorCount": len(ids),
        "McpConnectorCount": sum(1 for i in ids if "mcp" in i.lower()),
        "KnowledgeConnectorCount": knowledge,
        "ConnectedAgentCount": connected,
        "Connectors": "; ".join(ids),
        "SharedUsers": _count(viewers.get("userCount")),
        "SharedGroups": _count(viewers.get("groupCount")),
        "SharedEntireTenant": bool(_flag(viewers.get("entireTenant"))),
        "Orchestration": _text(_prop(props, "orchestration")),
        "Model": _text(_prop(props, "model")),
        "Channels": "; ".join(_text(c) for c in channels if _text(c)) if isinstance(channels, list) else _text(channels),
        "OwnerId": _guid(_prop(props, "ownerId")),
        "CreatedIn": _text(_prop(props, "createdIn")),
        "LastPublishedAt": _text(_prop(props, "lastPublishedAt")),
        "Source": source,
    }


def environment_row(record, snapshot, source=SOURCE_ARG):
    props = record.get("properties") or {}
    env_type = _text(_prop(props, "environmentType"))
    return {
        "SnapshotDate": snapshot,
        "EnvironmentId": _guid(record.get("name")),
        "EnvironmentName": _text(_prop(props, "displayName")),
        "EnvironmentType": env_type,
        "IsDefault": env_type.lower() == "default" if env_type else None,
        "IsManaged": _flag(_prop(props, "isManaged")),
        "Region": _text(record.get("location")),
        "Source": source,
    }


def flow_row(record, snapshot, source=SOURCE_ARG):
    props = record.get("properties") or {}
    connectors = [c for c in (_prop(props, "powerPlatformConnectors") or []) if isinstance(c, dict)]
    return {
        "SnapshotDate": snapshot,
        "FlowId": _guid(record.get("name")),
        "FlowName": _text(_prop(props, "displayName")),
        "EnvironmentId": _guid(_prop(props, "environmentId")),
        "OwnerId": _guid(_prop(props, "ownerId")),
        "ConnectorCount": len({_text(c.get("connectorId")) for c in connectors if _text(c.get("connectorId"))}),
        "Trigger": _text(_prop(props, "trigger")),
        "CreatedAt": _text(_prop(props, "createdAt")),
        "LastModifiedAt": _text(_prop(props, "lastModifiedAt")),
        "Source": source,
    }


def foundry_row(record, snapshot):
    """One `arg_foundry_resources` row. Ids are lower case so they join to Cost Management's."""
    rid = _text(record.get("id")).lower()
    rtype = _text(record.get("type")).lower()
    project = rtype.endswith("/projects")
    sku = record.get("sku")
    access = _text(record.get("publicNetworkAccess"))
    return {
        "SnapshotDate": snapshot,
        "ResourceId": rid,
        "ResourceName": _text(record.get("name")).split("/")[-1],
        "ResourceType": rtype,
        "Kind": _text(record.get("kind")),
        "Location": _text(record.get("location")),
        "SubscriptionId": _guid(record.get("subscriptionId")),
        "ResourceGroup": _text(record.get("resourceGroup")),
        "Sku": _text(sku.get("name")) if isinstance(sku, dict) else _text(sku),
        "PublicNetworkAccess": access,
        # Azure treats an unset value as Enabled.
        "PublicNetwork": access.lower() != "disabled",
        "DisableLocalAuth": _flag(record.get("disableLocalAuth")),
        "IsProject": project,
        "AccountId": rid.rsplit("/projects/", 1)[0] if project else rid,
    }


ROW_BUILDERS = {TBL_AGENTS: agent_row, TBL_ENVIRONMENTS: environment_row, TBL_FLOWS: flow_row}


def registry_keys(registry):
    """Bot Id and Entra Agent ID -> Title ID, from `agents_365` rows (dicts). Bot Id may list several."""
    by_bot, by_entra = {}, {}
    for row in registry:
        title = _text(row.get("Title ID"))
        if not title:
            continue
        for bot in str(row.get("Bot Id") or "").replace(",", ";").split(";"):
            if _guid(bot):
                by_bot.setdefault(_guid(bot), title)
        entra = _guid(row.get("Entra Agent ID"))
        if entra:
            by_entra.setdefault(entra, title)
    return by_bot, by_entra


def resolve_titles(rows, registry):
    """Sets TitleId and MatchedOn on agent rows: Bot Id first, then Entra Agent ID."""
    by_bot, by_entra = registry_keys(registry)
    for row in rows:
        title, matched = by_bot.get(row["BotId"]), "Bot Id"
        if not title and row["EntraAgentId"]:
            title, matched = by_entra.get(row["EntraAgentId"]), "Entra Agent ID"
        row["TitleId"], row["MatchedOn"] = (title, matched) if title else ("", "")
    return rows


def inventory_records(payload):
    """Records from one inventory flow file: a page ({"data": [...]}), a list of pages, or a list of records."""
    pages = payload if isinstance(payload, list) else [payload]
    out = []
    for page in pages:
        if isinstance(page, dict) and isinstance(page.get("data"), list):
            out.extend(r for r in page["data"] if isinstance(r, dict))
        elif isinstance(page, dict) and page.get("type"):
            out.append(page)
    return out


def split_inventory(records):
    """Inventory records grouped by table, by their `type`."""
    grouped = {table: [] for table in INVENTORY_TABLES}
    for record in records:
        table = INVENTORY_TYPES.get(_text(record.get("type")).lower())
        if table:
            grouped[table].append(record)
    return grouped


def status_row(probe, status, rows, source, detail, snapshot):
    return {"SnapshotDate": snapshot, "Probe": probe, "Status": status, "Rows": rows, "Source": source,
            "Detail": _text(detail)[:500]}


def _failure(exc):
    return failure_status(getattr(exc, "status_code", None)), f"{type(exc).__name__}: {exc}"


def collect_rows(include_agents, include_foundry, run_query, read_inventory, read_registry, snapshot):
    """Rows per table, and one status row per probe. Every probe is best effort.

    `run_query(kql)` returns Resource Graph records; `read_inventory()` returns (file name, records)
    from the newest inventory flow file; `read_registry()` returns `agents_365` rows. A table that
    couldn't be read is left out, so its last snapshot stays.
    """
    probes = (list(INVENTORY_TABLES) if include_agents else []) + ([TBL_FOUNDRY] if include_foundry else [])
    fetched, refused = {}, {}
    for table in probes:
        try:
            fetched[table] = run_query(ARG_QUERIES[table])
        except Exception as exc:
            refused[table] = _failure(exc)

    inventory_used, inventory_note = None, ""
    if include_agents and not fetched.get(TBL_AGENTS):
        try:
            name, records = read_inventory()
        except Exception as exc:
            name, records = None, []
            inventory_note = f"; the inventory flow file couldn't be read ({_failure(exc)[1]})"
        if records:
            inventory_used = name
            fetched.update(split_inventory(records))

    registry = []
    if TBL_AGENTS in fetched:
        try:
            registry = read_registry() or []
        except Exception:
            registry = []

    tables, statuses = {}, []
    for table in probes:
        source = SOURCE_INVENTORY if inventory_used and table in INVENTORY_TABLES else SOURCE_ARG
        if table not in fetched:
            status, detail = refused[table]
            note = inventory_note if table in INVENTORY_TABLES else ""
            statuses.append(status_row(table, status, 0, source, detail + note, snapshot))
            continue
        records = fetched[table]
        if table == TBL_FOUNDRY:
            rows = [foundry_row(r, snapshot) for r in records]
        else:
            rows = [ROW_BUILDERS[table](r, snapshot, source) for r in records]
        if table == TBL_AGENTS:
            resolve_titles(rows, registry)
        detail = ""
        if source == SOURCE_INVENTORY:
            first = refused.get(table, ("empty", ""))[0]
            detail = f"Resource Graph {first}; read {inventory_used}"
        tables[table] = rows
        statuses.append(status_row(table, "ok" if rows else "empty", len(rows), source, detail, snapshot))
    for table in (*INVENTORY_TABLES, TBL_FOUNDRY):
        if table not in probes:
            statuses.append(status_row(table, "skipped", 0, SOURCE_ARG, "Turned off in the installer", snapshot))
    return tables, statuses


def mark_write_failed(statuses, table, exc):
    """Turns a probe's status into an error when its table couldn't be written."""
    for row in statuses:
        if row["Probe"] == table:
            row.update(Status="error", Rows=0, Detail=_failure(exc)[1][:500])
# --- End of shared block. ---


class ResourceGraphError(Exception):
    def __init__(self, message, status_code=None):
        super().__init__(message)
        self.status_code = status_code


def query(api, kql, management_group=""):
    """Every row of `kql`, following $skipToken. Never sends the token anywhere but ARM."""
    rows, token, pages = [], None, 0
    while True:
        pages += 1
        if pages > MAX_PAGES:
            raise ResourceGraphError("Resource Graph returned too many pages")
        parsed = urlsplit(ARG_URL)
        if parsed.scheme != "https" or parsed.netloc.lower() != "management.azure.com":
            raise ValueError("Invalid Resource Graph URL")
        r = api.request("POST", ARG_URL, scope=ARM_SCOPE, timeout=180, allow_redirects=False,
                        params={"api-version": ARG_API}, json=arg_body(kql, token, management_group))
        if not 200 <= r.status_code < 300:
            text = (getattr(r, "text", "") or "")[:300]
            raise ResourceGraphError(f"Resource Graph: HTTP {r.status_code} {text}".strip(), r.status_code)
        page = r.json() or {}
        data = page.get("data") or []
        if isinstance(data, dict):  # the table result format, in case a proxy rewrites options
            cols = [c.get("name") for c in data.get("columns") or []]
            data = [dict(zip(cols, row)) for row in data.get("rows") or []]
        rows.extend(d for d in data if isinstance(d, dict))
        token = page.get("$skipToken")
        if not token:
            return rows


def write_table(store, table, rows) -> int:
    schema = ARG_SCHEMAS[table]
    prefix = f"raw/{table}"
    rel = f"{prefix}/part-0.parquet"
    columns = [c for c, _ in schema]
    n = write_rows(store.path(rel), columns, [[r.get(c) for c in columns] for r in rows], [t for _, t in schema])
    store.push([rel])
    stale = [r for r in store.list(prefix) if r != rel]
    if stale:
        store.remove(stale)
    log.info("resource_graph: wrote %s: %s rows", table, n)
    return n


def load_registry(store):
    """`agents_365` rows (Title ID, Bot Id, Entra Agent ID), or none when Agent 365 isn't collected."""
    import duckdb

    store.pull("raw/agents_365")
    src = parquet_glob(store.root, "raw/agents_365")
    if not src:
        return []
    con = duckdb.connect()
    try:
        cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
        if "Title ID" not in cols:
            return []
        pick = [c for c in ("Title ID", "Bot Id", "Entra Agent ID") if c in cols]
        sel = ", ".join('"' + c + '"' for c in pick)
        return [dict(zip(pick, row)) for row in con.execute(f"SELECT {sel} FROM {src}").fetchall()]
    finally:
        con.close()


def latest_inventory(store, settings, api):
    """(file name, records) from the newest inventory flow file, or (None, [])."""
    drop = open_dropfolder(store, settings, api)
    files = [(stamp or "", name) for name, stamp in drop.list(INVENTORY_DIR) if name.lower().endswith(".json")]
    if not files:
        return None, []
    _, name = max(files, key=lambda f: (f[1], f[0]))  # names carry a UTC stamp
    payload = json.loads(drop.read_bytes(INVENTORY_DIR, name).decode("utf-8-sig"))
    return name, inventory_records(payload)


def collect_resource_graph(api, store, settings, *, today: date | None = None) -> dict:
    snapshot = today or datetime.now(timezone.utc).date()
    group = settings.arg_management_group

    def run_query(kql):
        return query(api, kql, group)

    tables, statuses = collect_rows(settings.arg_agents, settings.arg_foundry, run_query,
                                    lambda: latest_inventory(store, settings, api),
                                    lambda: load_registry(store), snapshot)
    for row in statuses:
        if row["Status"] in ("forbidden", "error"):
            log.warning("resource_graph %s: %s %s", row["Probe"], row["Status"], row["Detail"])
    out = {}
    for table, rows in tables.items():
        try:
            out[table] = write_table(store, table, rows)
        except Exception as exc:
            log.warning("resource_graph: %s couldn't be written: %s", table, exc)
            mark_write_failed(statuses, table, exc)
    out[TBL_STATUS] = write_table(store, TBL_STATUS, statuses)
    return out


__all__ = ["collect_resource_graph", "query", "HttpError"]
