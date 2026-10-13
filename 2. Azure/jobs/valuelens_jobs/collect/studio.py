"""Copilot Studio credits: the Power Platform admin center exports and the Copilot Studio credits
flow's licensing API files, merged into the Consumption Central tables.

A port of the Fabric notebook `Ingest_Studio` (same tables, columns, keys and precedence rules):

* Exports (`EntitlementConsumptionTenant*DetailsReport_MCSMessages*.csv`, or a renamed `*Tenant*`,
  `*PerAgent*`/`*Agent*`, `*PerUser*`/`*User*` file) feed `studio_tenant_daily` by day, and
  `studio_agent` / `studio_user` by `snapshot_month` (the month the run happens in, since those two
  exports have no date).
* The flow's files (`StudioApiAgentDaily*`, `StudioApiEntitlement*`, `StudioApiUserDaily*`) feed
  `studio_agent_daily` and `studio_user_daily`, and are rolled up into the other three tables with
  `source_file = 'ppac-api'`.
* An export always wins: API rows are dropped wherever an export covers the same day and
  environment (tenant), or the same month (agents, users).

The drop folder is re-read in full every run; the merges make that idempotent.
"""
from __future__ import annotations

import logging
import re
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import quote

import duckdb

from ..dropfolder import open_dropfolder
from .consumption import GUID, TableState, match_files, read_csvs, sql_list, text

log = logging.getLogger("valuelens_jobs.collect.studio")

SUBDIR = "studio"
PAT_TENANT = ("EntitlementConsumptionTenantDetailsReport_MCSMessages*.csv", "*Tenant*.csv")
PAT_AGENT = ("EntitlementConsumptionTenantPerAgentDetailsReport_MCSMessages*.csv", "*PerAgent*.csv", "*Agent*.csv")
PAT_USER = ("EntitlementConsumptionTenantPerUserDetailsReport_MCSMessages*.csv", "*PerUser*.csv", "*User*.csv")
PAT_API_AGENT = ("StudioApiAgentDaily*.csv",)
PAT_API_ENTITLEMENT = ("StudioApiEntitlement*.csv",)
PAT_API_USER = ("StudioApiUserDaily*.csv",)

TBL_TENANT = "studio_tenant_daily"
TBL_AGENT = "studio_agent"
TBL_USER = "studio_user"
TBL_AGENT_DAILY = "studio_agent_daily"
TBL_USER_DAILY = "studio_user_daily"
API_SOURCE = "ppac-api"
API_BILLING_PLAN = "00000000-0000-0000-0000-000000000000"
IDS_PER_QUERY = 15
QUERIES_PER_BATCH = 20
BATCH_URL = "https://graph.microsoft.com/v1.0/$batch"

V, D, F, B = "VARCHAR", "DATE", "DOUBLE", "BOOLEAN"
SCHEMAS = {
    TBL_TENANT: [("billing_plan_id", V), ("billing_plan_name", V), ("environment_id", V), ("environment_name", V),
                 ("capacity_type", V), ("entitled_quantity", F), ("prepaid_consumed", F), ("payg_consumed", F),
                 ("usage_date", D), ("source_file", V)],
    TBL_AGENT: [("snapshot_month", D), ("agent_name", V), ("agent_id", V), ("product", V), ("billable_feature", V),
                ("billed_credit", F), ("non_billed_credit", F), ("channel", V), ("knowledge_sources", V),
                ("tool_used", V), ("llm_model", V), ("scenario_name", V), ("environment_id", V),
                ("environment_name", V), ("source_file", V)],
    TBL_USER: [("snapshot_month", D), ("user_id", V), ("user_email", V), ("agent_id", V), ("agent_name", V),
               ("billable_credit_used", F), ("credits_used", F), ("m365_copilot_licensed", B), ("source_file", V)],
    TBL_AGENT_DAILY: [("usage_date", D), ("agent_id", V), ("billable_feature", V), ("channel", V),
                      ("environment_id", V), ("agent_name", V), ("environment_name", V), ("billed_credit", F),
                      ("non_billed_credit", F), ("users", F), ("llm_model", V), ("tool_used", V),
                      ("knowledge_sources", V), ("source_file", V)],
    TBL_USER_DAILY: [("usage_date", D), ("user_id", V), ("environment_id", V), ("agent_id", V), ("user_upn", V),
                     ("billed_credit", F), ("non_billed_credit", F), ("source_file", V)],
}
TENANT_KEY = ["usage_date", "environment_id", "billing_plan_id", "capacity_type"]
AGENT_KEY = ["snapshot_month", "agent_id", "billable_feature", "channel", "environment_id"]
USER_KEY = ["snapshot_month", "user_id", "agent_id"]
AGENT_DAILY_KEY = ["usage_date", "agent_id", "billable_feature", "channel", "environment_id"]
USER_DAILY_KEY = ["usage_date", "user_id", "environment_id", "agent_id"]
# PPAC writes US-style M/d/yyyy with a time; a re-saved file may lose the seconds or gain ISO dates.
USAGE_DATE_FORMATS = ["%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %I:%M %p", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M",
                      "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"]


def norm(name: str) -> str:
    return re.sub(r"[ _\-/]", "", str(name)).lower()


class Columns:
    """Column lookup for one read, ignoring case and separators (the PPAC headers contain spaces and
    a slash, and get tidied up between releases)."""

    def __init__(self, cols, what):
        self.cols = cols
        self.what = what
        self.missing = []

    def pick(self, *aliases):
        for a in aliases:
            if norm(a) in self.cols:
                return f'"{norm(a)}"'
        return None

    def req(self, *aliases):
        c = self.pick(*aliases)
        if c is None:
            self.missing.append(aliases[0])
            return "NULL"
        return c

    def opt(self, *aliases):
        return self.pick(*aliases) or "NULL"

    def check(self):
        if self.missing:
            raise ValueError(f"The {self.what} has no column {', '.join(repr(m) for m in self.missing)}")


def _str(c):
    return f"CAST({c} AS VARCHAR)"


def _dbl(c):
    return f"TRY_CAST(trim({c}) AS DOUBLE)"


def _iso_date(c):
    return f"TRY_CAST(left(trim({c}), 10) AS DATE)"


def _blank_null(c):
    return f"CASE WHEN trim({c}) <> '' THEN trim({c}) END"


def _joined(c):
    return f"coalesce(string_agg(DISTINCT {c}, ', ' ORDER BY {c}), '') AS {c}"


class StudioIngest:
    def __init__(self, con, state: TableState, files: dict, snapshot: date, api=None):
        self.con = con
        self.state = state
        self.files = files  # {name: local path}
        self.snapshot = snapshot
        self.api = api
        self.summary: dict = {}

    def read(self, view, *patterns, api=False):
        """Files from the first pattern that matches anything. The flow's files (StudioApi*) are only
        read with api=True, so a loose export pattern such as *Agent*.csv never picks them up."""
        names = match_files(self.files, patterns, include=lambda n: n.lower().startswith("studioapi") == api)
        if not names:
            log.info("  no file matched %s", patterns)
            return None
        cols = read_csvs(self.con, [self.files[n] for n in names], view, norm)
        return Columns(cols, f"file(s) {', '.join(names)}") if cols else None

    def drop_api_rows(self, table, source, keys):
        if not self.state.exists(table):
            return
        match = " AND ".join(f"{table}.{k} IS NOT DISTINCT FROM s.{k}" for k in keys)
        self.state.delete(table, f"source_file = '{API_SOURCE}' AND EXISTS "
                                 f"(SELECT 1 FROM (SELECT DISTINCT {', '.join(keys)} FROM {source}) s WHERE {match})")

    def exports(self):
        c = self.read("raw_tenant", *PAT_TENANT)
        if c is None:
            log.info("no tenant export - skipping")
        else:
            sel = f"""SELECT {_str(c.req('BillingPlan Id'))} AS billing_plan_id,
                    {_str(c.req('BillingPlan Name'))} AS billing_plan_name,
                    {_str(c.req('Environment Id'))} AS environment_id,
                    {_str(c.req('Environment Name'))} AS environment_name,
                    {_str(c.req('Capacity Type'))} AS capacity_type,
                    {_dbl(c.req('Entitled Quantity'))} AS entitled_quantity,
                    {_dbl(c.req('Prepaid Consumed Quantity'))} AS prepaid_consumed,
                    {_dbl(c.req('Pay as you go Consumed Quantity'))} AS payg_consumed,
                    CAST(try_strptime(trim({c.req('Usage Date')}), {USAGE_DATE_FORMATS!r}) AS DATE) AS usage_date,
                    __source_file AS source_file
                FROM raw_tenant"""
            c.check()
            self.con.execute(f"CREATE OR REPLACE TEMP TABLE src_tenant AS {sel}")
            bad = self.con.execute("SELECT count(*) FROM src_tenant WHERE usage_date IS NULL").fetchone()[0]
            if bad:
                log.warning("  ! %s rows have an unparseable Usage Date - check the format", bad)
            self.state.merge(TBL_TENANT, "src_tenant", TENANT_KEY)
            self.drop_api_rows(TBL_TENANT, "src_tenant", ["usage_date", "environment_id"])
            self.summary["tenant_export_rows"] = self._n("src_tenant")

        month = f"DATE '{self.snapshot.isoformat()}'"
        c = self.read("raw_agent", *PAT_AGENT)
        if c is None:
            log.info("no per-agent export - skipping")
        else:
            sel = f"""SELECT {month} AS snapshot_month, {_str(c.req('Agent Name'))} AS agent_name,
                    {_str(c.req('Agent Id'))} AS agent_id, {_str(c.req('Product'))} AS product,
                    {_str(c.req('AI Feature/Billable Feature', 'Billable Feature'))} AS billable_feature,
                    {_dbl(c.req('Billed credit'))} AS billed_credit,
                    {_dbl(c.req('Non-billed credit'))} AS non_billed_credit,
                    {_str(c.req('Channel'))} AS channel, {_str(c.req('Knowledge Sources'))} AS knowledge_sources,
                    {_str(c.req('Tool Used'))} AS tool_used, {_str(c.req('LLM Model'))} AS llm_model,
                    {_str(c.req('Scenario Name'))} AS scenario_name,
                    {_str(c.req('Environment Id'))} AS environment_id,
                    {_str(c.req('Environment Name'))} AS environment_name, __source_file AS source_file
                FROM raw_agent"""
            c.check()
            self.con.execute(f"CREATE OR REPLACE TEMP TABLE src_agent AS {sel}")
            # An agent appears once per feature per channel per environment, so all four are in the key.
            self.state.merge(TBL_AGENT, "src_agent", AGENT_KEY)
            self.drop_api_rows(TBL_AGENT, "src_agent", ["snapshot_month"])
            self.summary["agent_export_rows"] = self._n("src_agent")

        c = self.read("raw_user", *PAT_USER)
        if c is None:
            log.info("no per-user export - skipping")
        else:
            sel = f"""SELECT {month} AS snapshot_month, {_str(c.req('User Id'))} AS user_id,
                    lower(trim({c.req('User Email')})) AS user_email,
                    {_str(c.req('Agent Id'))} AS agent_id, {_str(c.req('Agent Name'))} AS agent_name,
                    {_dbl(c.req('Billable credit used'))} AS billable_credit_used,
                    {_dbl(c.req('Credits used'))} AS credits_used,
                    upper(trim({c.req('M365 Copilot Licensed')})) IN ('TRUE', 'YES', '1') AS m365_copilot_licensed,
                    __source_file AS source_file
                FROM raw_user"""
            c.check()
            self.con.execute(f"CREATE OR REPLACE TEMP TABLE src_user AS {sel}")
            self.state.merge(TBL_USER, "src_user", USER_KEY)
            self.drop_api_rows(TBL_USER, "src_user", ["snapshot_month"])
            self.summary["user_export_rows"] = self._n("src_user")

    def _n(self, table):
        return self.con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]

    def _covered(self, table):
        if not self.state.exists(table):
            return set()
        return {r[0] for r in self.con.execute(
            f"SELECT DISTINCT snapshot_month FROM {table} "
            f"WHERE source_file IS NULL OR source_file <> '{API_SOURCE}'").fetchall()}

    def api_agents(self):
        c = self.read("raw_api_agent", *PAT_API_AGENT, api=True)
        if c is None:
            log.info("no licensing API files - skipping")
            return
        self.con.execute(f"""CREATE OR REPLACE TEMP TABLE api_rows AS
            SELECT {_iso_date(c.opt('Usage Date'))} AS usage_date, {_str(c.opt('Agent Id'))} AS agent_id,
                   {_str(c.opt('Agent Name'))} AS agent_name, {_str(c.opt('Environment Id'))} AS environment_id,
                   {_str(c.opt('Environment Name'))} AS environment_name,
                   {_str(c.opt('Feature'))} AS billable_feature, {_str(c.opt('Channel'))} AS channel,
                   {_str(c.opt('LLM Model'))} AS llm_model, {_str(c.opt('Tool Used'))} AS tool_used,
                   {_str(c.opt('Knowledge Sources'))} AS knowledge_sources,
                   {_dbl(c.opt('Billed credit'))} AS billed_credit,
                   {_dbl(c.opt('Non-billed credit'))} AS non_billed_credit, {_dbl(c.opt('Users'))} AS users
            FROM raw_api_agent""")
        self.con.execute("DELETE FROM api_rows WHERE usage_date IS NULL OR agent_id IS NULL")

        # The flow fills environment names from the environments API; the entitlement snapshot fills any it missed.
        e = self.read("raw_api_names", *PAT_API_ENTITLEMENT, api=True)
        if e is not None:
            self.con.execute(f"""CREATE OR REPLACE TEMP TABLE env_names AS
                SELECT environment_id, any_value(env_name) AS env_name FROM (
                    SELECT {_str(e.opt('Environment Id'))} AS environment_id,
                           {_str(e.opt('Environment Name'))} AS env_name FROM raw_api_names)
                WHERE env_name IS NOT NULL AND env_name <> '' GROUP BY environment_id""")
            self.con.execute("UPDATE api_rows SET environment_name = NULL WHERE environment_name = ''")
            self.con.execute("""UPDATE api_rows SET environment_name = n.env_name FROM env_names n
                WHERE api_rows.environment_id = n.environment_id
                  AND (api_rows.environment_name IS NULL OR api_rows.environment_name = '')""")

        keys = ", ".join(AGENT_DAILY_KEY)
        self.con.execute(f"""CREATE OR REPLACE TEMP TABLE daily AS
            SELECT {keys}, any_value(agent_name) AS agent_name, any_value(environment_name) AS environment_name,
                   sum(billed_credit) AS billed_credit, sum(non_billed_credit) AS non_billed_credit,
                   max(users) AS users, {_joined('llm_model')}, {_joined('tool_used')},
                   {_joined('knowledge_sources')}, '{API_SOURCE}' AS source_file
            FROM api_rows GROUP BY {keys}""")
        days = [r[0] for r in self.con.execute("SELECT DISTINCT usage_date FROM daily ORDER BY 1").fetchall()]
        log.info("  %s agent-days over %s day(s)", self._n("daily"), len(days))
        self.summary["api_agent_days"] = len(days)
        if not days:
            return
        day_list = sql_list(d.isoformat() for d in days)
        self.state.delete(TBL_AGENT_DAILY, f"usage_date IN ({day_list})")
        self.state.merge(TBL_AGENT_DAILY, "daily", AGENT_DAILY_KEY)

        # studio_agent: months no export covers.
        months = sorted({d.replace(day=1) for d in days})
        covered = self._covered(TBL_AGENT)
        for m in months:
            if m in covered:
                log.info("  %s: an export covers this month, so the API figures aren't used", m.strftime("%Y-%m"))
        api_months = [m for m in months if m not in covered]
        if api_months:
            month_list = sql_list(m.isoformat() for m in api_months)
            self.con.execute(f"""CREATE OR REPLACE TEMP TABLE monthly AS
                SELECT snapshot_month, any_value(agent_name) AS agent_name, agent_id,
                       'Copilot Studio' AS product, billable_feature, sum(billed_credit) AS billed_credit,
                       sum(non_billed_credit) AS non_billed_credit, channel,
                       any_value(knowledge_sources) AS knowledge_sources, any_value(tool_used) AS tool_used,
                       any_value(llm_model) AS llm_model, CAST(NULL AS VARCHAR) AS scenario_name,
                       environment_id, any_value(environment_name) AS environment_name,
                       '{API_SOURCE}' AS source_file
                FROM (SELECT *, CAST(date_trunc('month', usage_date) AS DATE) AS snapshot_month
                      FROM {TBL_AGENT_DAILY})
                WHERE snapshot_month IN ({month_list})
                GROUP BY snapshot_month, agent_id, billable_feature, channel, environment_id""")
            self.state.delete(TBL_AGENT, f"snapshot_month IN ({month_list}) AND source_file = '{API_SOURCE}'")
            self.state.merge(TBL_AGENT, "monthly", AGENT_KEY)

        # studio_tenant_daily: the entitlement snapshot gives the prepaid share and each environment's allocation.
        share, allocated = None, {}
        e = self.read("raw_api_ent", *PAT_API_ENTITLEMENT, api=True)
        if e is not None:
            self.con.execute(f"""CREATE OR REPLACE TEMP TABLE ent AS
                SELECT row_number() OVER () AS n, {_iso_date(e.opt('Snapshot Date'))} AS snapshot_date,
                       {_str(e.opt('Environment Id'))} AS environment_id,
                       {_dbl(e.opt('Environment Allocated'))} AS allocated,
                       {_dbl(e.opt('Tenant Entitled'))} AS tenant_entitled,
                       {_dbl(e.opt('Tenant Prepaid Consumed'))} AS prepaid, {_dbl(e.opt('Tenant PAYG Consumed'))} AS payg
                FROM raw_api_ent""")
            snap = self.con.execute("""SELECT environment_id, allocated, tenant_entitled, prepaid, payg FROM ent
                WHERE snapshot_date = (SELECT max(snapshot_date) FROM ent) ORDER BY n""").fetchall()
            allocated = {r[0]: r[1] for r in snap if r[0]}
            if snap:
                prepaid, payg, entitled = (snap[0][3] or 0.0), (snap[0][4] or 0.0), (snap[0][2] or 0.0)
                share = prepaid / (prepaid + payg) if prepaid + payg > 0 else (1.0 if entitled > 0 else 0.0)
                log.info("  entitlement snapshot: prepaid share %.0f%%, %s environment(s)", share * 100, len(allocated))
        if share is None:
            share = 1.0
            log.info("  no entitlement snapshot - treating every credit as prepaid")
        self.summary["prepaid_share"] = share

        self.con.execute("CREATE OR REPLACE TEMP TABLE alloc (environment_id VARCHAR, entitled_quantity DOUBLE)")
        if allocated:
            self.con.executemany("INSERT INTO alloc VALUES (?, ?)", list(allocated.items()))
        exported = ""
        if self.state.exists(TBL_TENANT):
            exported = f"""WHERE NOT EXISTS (SELECT 1 FROM {TBL_TENANT} x
                WHERE (x.source_file IS NULL OR x.source_file <> '{API_SOURCE}')
                  AND x.usage_date = t.usage_date AND x.environment_id = t.environment_id)"""
        self.con.execute(f"""CREATE OR REPLACE TEMP TABLE tenant_api AS
            SELECT '{API_BILLING_PLAN}' AS billing_plan_id, 'Power Platform licensing API' AS billing_plan_name,
                   t.environment_id, t.environment_name, 'MCSMessages' AS capacity_type,
                   coalesce(a.entitled_quantity, 0.0) AS entitled_quantity,
                   t.consumed * {share!r} AS prepaid_consumed, t.consumed * {1.0 - share!r} AS payg_consumed,
                   t.usage_date, '{API_SOURCE}' AS source_file
            FROM (SELECT usage_date, environment_id, any_value(environment_name) AS environment_name,
                         sum(billed_credit) AS consumed FROM daily GROUP BY usage_date, environment_id) t
            LEFT JOIN alloc a ON a.environment_id = t.environment_id
            {exported}""")
        self.state.delete(TBL_TENANT, f"usage_date IN ({day_list}) AND source_file = '{API_SOURCE}'")
        self.state.merge(TBL_TENANT, "tenant_api", TENANT_KEY)

    def resolve_upns(self, ids) -> dict:
        """{object id (lower case): UPN (lower case)} for the IDs Graph knows (`/users` with `id in`)."""
        found = {}
        queries = [ids[i:i + IDS_PER_QUERY] for i in range(0, len(ids), IDS_PER_QUERY)]
        for start in range(0, len(queries), QUERIES_PER_BATCH):
            pending = {str(n): qy for n, qy in enumerate(queries[start:start + QUERIES_PER_BATCH])}
            for attempt in range(6):
                if not pending:
                    break
                body = {"requests": [
                    {"id": key, "method": "GET",
                     "url": "/users?$filter=" + quote("id in (" + ",".join(f"'{i}'" for i in qy) + ")")
                            + "&$select=id,userPrincipalName"}
                    for key, qy in pending.items()]}
                r = self.api.request("POST", BATCH_URL, json=body)
                if r.status_code in (401, 403):
                    raise _no_access(r.status_code)
                if r.status_code == 429 or r.status_code >= 500:
                    self.api.sleep(min(2 ** attempt, 60))
                    continue
                if not 200 <= r.status_code < 300:
                    raise RuntimeError(f"Graph $batch returned HTTP {r.status_code}")
                wait = 0.0
                for item in r.json().get("responses", []):
                    status = int(item.get("status") or 0)
                    if status == 200:
                        for u in (item.get("body") or {}).get("value", []):
                            if u.get("id") and u.get("userPrincipalName"):
                                found[u["id"].lower()] = u["userPrincipalName"].strip().lower()
                        pending.pop(item.get("id"), None)
                    elif status in (401, 403):
                        raise _no_access(status)
                    elif status == 429 or status >= 500:
                        try:
                            wait = max(wait, float((item.get("headers") or {}).get("Retry-After", 2 ** attempt)))
                        except (TypeError, ValueError):
                            wait = max(wait, float(2 ** attempt))
                    else:
                        log.info("  UPN lookup query skipped: HTTP %s", status)
                        pending.pop(item.get("id"), None)
                if pending:
                    self.api.sleep(min(wait or 2 ** attempt, 60))
            if pending:
                log.warning("  %s UPN lookup query(ies) still throttled; those users show by ID.", len(pending))
        return found

    def api_users(self):
        c = self.read("raw_api_user", *PAT_API_USER, api=True)
        if c is None:
            log.info("no licensing API user files - skipping")
            return
        keys = ", ".join(USER_DAILY_KEY)
        self.con.execute(f"""CREATE OR REPLACE TEMP TABLE udaily AS
            SELECT {keys}, sum(billed_credit) AS billed_credit, sum(non_billed_credit) AS non_billed_credit FROM (
                SELECT {_iso_date(c.opt('Usage Date'))} AS usage_date,
                       lower({_blank_null(_str(c.opt('User Id')))}) AS user_id,
                       {_blank_null(_str(c.opt('Environment Id')))} AS environment_id,
                       {_blank_null(_str(c.opt('Agent Id')))} AS agent_id,
                       {_dbl(c.opt('Billed credit'))} AS billed_credit,
                       {_dbl(c.opt('Non-billed credit'))} AS non_billed_credit
                FROM raw_api_user)
            WHERE usage_date IS NOT NULL AND user_id IS NOT NULL
            GROUP BY {keys}""")

        # UPNs already known from earlier loads and exports, then Graph for the rest.
        known = {}
        if self.state.exists(TBL_USER):
            known.update({r[0].lower(): r[1] for r in self.con.execute(
                f"SELECT DISTINCT user_id, user_email FROM {TBL_USER} "
                "WHERE user_id IS NOT NULL AND user_email IS NOT NULL").fetchall()})
        if self.state.exists(TBL_USER_DAILY):
            known.update({r[0]: r[1] for r in self.con.execute(
                f"SELECT DISTINCT user_id, user_upn FROM {TBL_USER_DAILY} WHERE user_upn IS NOT NULL").fetchall()})
        ids = sorted(i for i in {r[0] for r in self.con.execute("SELECT DISTINCT user_id FROM udaily").fetchall()}
                     - set(known) if GUID.match(i))
        if ids and self.api is not None:
            try:
                found = self.resolve_upns(ids)
                known.update(found)
                log.info("  resolved %s of %s user object IDs to UPNs", len(found), len(ids))
                self.summary["upns_resolved"] = len(found)
            except Exception as exc:  # best effort: those users show by ID
                log.warning("  UPN lookup skipped: %s", exc)
                self.summary["upn_lookup_error"] = f"{type(exc).__name__}: {exc}"

        self.con.execute("CREATE OR REPLACE TEMP TABLE upns (user_id VARCHAR, user_upn VARCHAR)")
        if known:
            self.con.executemany("INSERT INTO upns VALUES (?, ?)", list(known.items()))
        self.con.execute(f"""CREATE OR REPLACE TEMP TABLE udaily_named AS
            SELECT d.usage_date, d.user_id, d.environment_id, d.agent_id, u.user_upn, d.billed_credit,
                   d.non_billed_credit, '{API_SOURCE}' AS source_file
            FROM udaily d LEFT JOIN (SELECT user_id, any_value(user_upn) AS user_upn FROM upns GROUP BY user_id) u
              ON u.user_id = d.user_id""")
        udays = [r[0] for r in self.con.execute("SELECT DISTINCT usage_date FROM udaily_named ORDER BY 1").fetchall()]
        log.info("  %s user rows over %s day(s)", self._n("udaily_named"), len(udays))
        self.summary["api_user_days"] = len(udays)
        if not udays:
            return
        self.state.delete(TBL_USER_DAILY, f"usage_date IN ({sql_list(d.isoformat() for d in udays)})")
        self.state.merge(TBL_USER_DAILY, "udaily_named", USER_DAILY_KEY)

        # studio_user: months no export covers.
        months = sorted({d.replace(day=1) for d in udays})
        covered = self._covered(TBL_USER)
        for m in months:
            if m in covered:
                log.info("  %s: an export covers this month, so the API user figures aren't used", m.strftime("%Y-%m"))
        user_months = [m for m in months if m not in covered]
        if not user_months:
            return
        month_list = sql_list(m.isoformat() for m in user_months)
        self.con.execute(f"""CREATE OR REPLACE TEMP TABLE umonthly AS
            SELECT u.snapshot_month, u.user_id, u.user_email, u.agent_id, a.agent_name, u.billable_credit_used,
                   u.credits_used, CAST(NULL AS BOOLEAN) AS m365_copilot_licensed, '{API_SOURCE}' AS source_file
            FROM (SELECT snapshot_month, user_id, agent_id, any_value(user_upn) AS user_email,
                         sum(billed_credit) AS billable_credit_used,
                         sum(coalesce(billed_credit, 0.0) + coalesce(non_billed_credit, 0.0)) AS credits_used
                  FROM (SELECT *, CAST(date_trunc('month', usage_date) AS DATE) AS snapshot_month
                        FROM {TBL_USER_DAILY})
                  WHERE snapshot_month IN ({month_list})
                  GROUP BY snapshot_month, user_id, agent_id) u
            LEFT JOIN (SELECT agent_id, any_value(agent_name) AS agent_name FROM {TBL_AGENT_DAILY}
                       GROUP BY agent_id) a ON a.agent_id = u.agent_id""")
        self.state.delete(TBL_USER, f"snapshot_month IN ({month_list}) AND source_file = '{API_SOURCE}'")
        self.state.merge(TBL_USER, "umonthly", USER_KEY)


def _no_access(status):
    return PermissionError(f"Graph returned HTTP {status}. Grant the jobs' managed identity Microsoft Graph "
                           "User.Read.All (application) so Copilot Studio users show by UPN.")


def ingest(store, files: dict, *, api=None, today: date | None = None) -> dict:
    """Merges the drop folder's Studio files (`{name: local path}`) into the tables in `store`."""
    today = today or datetime.now(timezone.utc).date()
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    try:
        state = TableState(con, store, SCHEMAS)
        state.load()
        run = StudioIngest(con, state, files, today.replace(day=1), api=api)
        log.info("studio: %s file(s) in the drop folder; snapshot month %s", len(files), run.snapshot)
        run.exports()
        run.api_agents()
        run.api_users()
        written = state.save()
    finally:
        con.close()
    return {"files": len(files), "tables": written, **run.summary}


def collect_studio(api, store, settings, *, drop=None, today: date | None = None) -> dict:
    drop = drop or open_dropfolder(store, settings, api)
    with tempfile.TemporaryDirectory(prefix="valuelens-studio-") as tmp:
        paths = drop.fetch(SUBDIR, tmp)
        files = {Path(p).name: Path(p) for p in paths if Path(p).name.lower().endswith(".csv")}
        return ingest(store, files, api=api, today=today)
