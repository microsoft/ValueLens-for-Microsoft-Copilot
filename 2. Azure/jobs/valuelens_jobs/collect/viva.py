"""Viva Insights Copilot credits: the `PersonServiceCreditsMetrics` and `SpendingPolicyMetadata`
CSVs in the drop folder's `viva/` subfolder, merged into `viva_credits_weekly` and
`viva_spending_policy`.

A port of the CSV path of the Fabric notebook `Ingest_Viva_Consumption` (there is no Dataflow on
the Azure path). Same columns, key and rules:

* `viva_credits_weekly` merges on person_id, service_id, spending_policy_id and metric_date.
  person_id is the lower-cased UPN when the export is identified, else the hashed PersonId. Org
  columns from the file only overwrite stored values when they're non-blank.
* `viva_spending_policy` is replaced in full, and only when a `SpendingPolicyMetadata*.csv` exists.
"""
from __future__ import annotations

import logging
import re
import tempfile
from pathlib import Path

import duckdb

from ..dropfolder import open_dropfolder
from .consumption import TableState, read_csvs

log = logging.getLogger("valuelens_jobs.collect.viva")

SUBDIR = "viva"
TBL_METRICS = "viva_credits_weekly"
TBL_POLICY = "viva_spending_policy"
METRICS_PREFIX = "personservicecreditsmetrics"
POLICY_PREFIX = "spendingpolicymetadata"

PERSON_ALIASES = {
    "user_principal_name": ["UserPrincipalName", "UPN", "UserPrincipal", "Email", "Mail", "EmailAddress"],
    "person_id": ["PersonId"],
    "display_name": ["DisplayName", "Name", "FullName", "PreferredName"],
    "department": ["Department", "Dept"],
    "organisation": ["Organisation", "Organization"],
    "job_title": ["JobTitle", "Title", "Role"],
    "job_family": ["JobFamily", "Function", "FunctionType", "JobFunction"],
    "city": ["City", "OfficeLocation", "Location"],
    "country": ["Country", "CountryOrRegion", "Region"],
    "cost_center": ["CostCenter", "CostCentre"],
    "manager": ["Manager", "ManagerName", "Supervisor", "ManagerId", "ManagerUPN"],
    "business_unit": ["BusinessUnit", "Division", "Segment"],
}
ORG_COLUMNS = [c for c in PERSON_ALIASES if c not in ("person_id", "user_principal_name")]
KEY = ["person_id", "service_id", "spending_policy_id", "metric_date"]
SCHEMAS = {
    TBL_METRICS: [("person_id", "VARCHAR"), ("user_principal_name", "VARCHAR"), ("entra_id", "VARCHAR"),
                  ("people_historical_id", "VARCHAR"), ("service_id", "VARCHAR"), ("service_name", "VARCHAR"),
                  ("spending_policy_id", "VARCHAR"), ("metric_date", "DATE"), ("session_count", "INTEGER"),
                  ("spending_policy_limit", "BIGINT"), ("credits_used", "DOUBLE"), ("user_limit", "BIGINT"),
                  *[(c, "VARCHAR") for c in ORG_COLUMNS]],
    TBL_POLICY: [("spending_policy_id", "VARCHAR"), ("name", "VARCHAR"), ("plan_limit", "BIGINT"),
                 ("user_limit", "BIGINT"), ("included_services", "VARCHAR")],
}


def norm(name: str) -> str:
    """Column names compared ignoring case, spaces, dashes and underscores."""
    return re.sub(r"[ _\-]", "", str(name)).lower()


def harmonise(name: str) -> str:
    """A CSV header ('Total Copilot Credits used') as the notebook's normalised key."""
    return re.sub(r"[^0-9a-z]", "", str(name).lower()) or str(name)


def _strip(c):
    return f"NULLIF(regexp_replace(CAST({c} AS VARCHAR), '^\\s+|\\s+$', '', 'g'), '')"


def _identity(c):
    return f"NULLIF(lower(regexp_replace({c}, '^[\\s\\x1c-\\x1f]+|[\\s\\x1c-\\x1f]+$', '', 'g')), '')"


class Picker:
    def __init__(self, cols):
        self.cols = cols

    def pick(self, *aliases):
        for a in aliases:
            if norm(a) in self.cols:
                return f'"{norm(a)}"'
        return None

    def req(self, what, *aliases):
        c = self.pick(*aliases)
        if c is None:
            raise ValueError(f"The {what} CSV has no {aliases[0]!r} column (columns: {sorted(self.cols)})")
        return c

    def person(self, canon):
        """`normalise_person`: the first populated alias, stripped."""
        found = [c for c in (self.pick(a) for a in [canon] + PERSON_ALIASES[canon]) if c]
        found = list(dict.fromkeys(found))
        if not found:
            return "CAST(NULL AS VARCHAR)"
        return f"coalesce({', '.join(_strip(c) for c in found)})" if len(found) > 1 else _strip(found[0])


def _metrics(con, state: TableState, paths) -> dict:
    cols = read_csvs(con, paths, "raw_viva", harmonise)
    if cols is None:
        log.info("viva: no consumption rows in the drop folder, so nothing to load")
        return {"metric_rows": 0}
    p = Picker(cols)
    if not (p.pick(*PERSON_ALIASES["user_principal_name"]) or p.pick("PersonId")):
        raise ValueError("No person key found. Expected UserPrincipalName (identified export) "
                         f"or PersonId (de-identified). Columns present: {sorted(cols)}")
    log.info("viva: export shape %s", "identified" if p.pick(*PERSON_ALIASES["user_principal_name"])
             else "de-identified")
    entra = p.pick("EntraId", "ObjectId", "AadObjectId")
    phid = p.pick("PeopleHistoricalId")
    org = ",\n".join(f"{p.person(c)} AS {c}" for c in ORG_COLUMNS)
    con.execute(f"""CREATE OR REPLACE TEMP TABLE viva_src AS
        SELECT DISTINCT coalesce(lower({p.person('user_principal_name')}), lower({p.person('person_id')})) AS person_id,
               lower({p.person('user_principal_name')}) AS user_principal_name,
               CAST({entra or 'NULL'} AS VARCHAR) AS entra_id,
               CAST({phid or 'NULL'} AS VARCHAR) AS people_historical_id,
               CAST({p.req('metrics', 'ServiceId')} AS VARCHAR) AS service_id,
               CAST({p.req('metrics', 'ServiceName')} AS VARCHAR) AS service_name,
               CAST({p.req('metrics', 'SpendingPolicyId')} AS VARCHAR) AS spending_policy_id,
               TRY_CAST(left(trim({p.req('metrics', 'MetricDate')}), 10) AS DATE) AS metric_date,
               TRY_CAST(trim({p.req('metrics', 'Session count')}) AS INTEGER) AS session_count,
               TRY_CAST(trim({p.req('metrics', 'Spending policy limit')}) AS BIGINT) AS spending_policy_limit,
               TRY_CAST(trim({p.req('metrics', 'Total Copilot Credits used')}) AS DOUBLE) AS credits_used,
               TRY_CAST(trim({p.req('metrics', 'User limit')}) AS BIGINT) AS user_limit,
               {org}
        FROM raw_viva""")
    if con.execute("SELECT count(*) FROM viva_src WHERE person_id IS NULL").fetchone()[0]:
        raise ValueError("Consumption contains a row with no populated UPN alias or PersonId.")
    keys = ", ".join(KEY)
    if con.execute(f"SELECT count(*) FROM (SELECT {keys} FROM viva_src GROUP BY ALL HAVING count(*) > 1)").fetchone()[0]:
        raise ValueError("Conflicting consumption rows share a normalised merge key; reconcile the input files.")
    rows, weeks = con.execute("SELECT count(*), count(DISTINCT metric_date) FROM viva_src").fetchone()
    log.info("viva: %s rows across %s weeks", rows, weeks)

    t = TBL_METRICS
    old_key = f"coalesce({_identity(f'{t}.user_principal_name')}, {_identity(f'{t}.person_id')})"
    rest = KEY[1:]
    if con.execute(f"SELECT count(*) FROM (SELECT {old_key} AS k, {', '.join(rest)} FROM {t} "
                   "GROUP BY ALL HAVING count(*) > 1)").fetchone()[0]:
        raise ValueError("Existing consumption has colliding normalised keys; reconcile duplicates before merging.")
    cond = f"{old_key} = s.person_id AND " + " AND ".join(f"{t}.{k} IS NOT DISTINCT FROM s.{k}" for k in rest)
    columns = state.columns(t)
    updated = ", ".join(f"coalesce(NULLIF(trim(s.{c}), ''), {t}.{c}) AS {c}" if c in ORG_COLUMNS else f"s.{c}"
                        for c in columns)
    before = state.count(t)
    con.execute(f"CREATE OR REPLACE TEMP TABLE viva_upd AS SELECT {t}.rowid AS rid, {updated} "
                f"FROM viva_src s JOIN {t} ON {cond}")
    con.execute(f"CREATE OR REPLACE TEMP TABLE viva_new AS SELECT s.* FROM viva_src s "
                f"WHERE NOT EXISTS (SELECT 1 FROM {t} WHERE {cond})")
    con.execute(f"DELETE FROM {t} WHERE rowid IN (SELECT rid FROM viva_upd)")
    names = ", ".join(columns)
    con.execute(f"INSERT INTO {t} ({names}) SELECT {names} FROM viva_upd")
    con.execute(f"INSERT INTO {t} ({names}) SELECT {names} FROM viva_new")
    state.changed.add(t)
    log.info("  %s: %s -> %s rows", t, before, state.count(t))
    return {"metric_rows": rows, "weeks": weeks}


def _policies(con, state: TableState, paths) -> dict:
    if not paths:
        log.info("viva: no SpendingPolicyMetadata CSV - policy names left as they are")
        return {}
    cols = read_csvs(con, paths, "raw_policy", harmonise) or set()
    p = Picker(cols)
    name = p.req("SpendingPolicyMetadata", "Name") if cols else "NULL"
    if cols:
        sel = f"""SELECT CAST({p.req('SpendingPolicyMetadata', 'SpendingPolicyId')} AS VARCHAR) AS spending_policy_id,
                CASE WHEN {name} IS NULL OR {name} = '' THEN '(Unassigned)' ELSE {name} END AS name,
                coalesce(TRY_CAST(trim({p.req('SpendingPolicyMetadata', 'PlanLimit')}) AS BIGINT), 0) AS plan_limit,
                coalesce(TRY_CAST(trim({p.req('SpendingPolicyMetadata', 'UserLimit')}) AS BIGINT), 0) AS user_limit,
                CAST({p.req('SpendingPolicyMetadata', 'IncludedServices')} AS VARCHAR) AS included_services
            FROM raw_policy"""
    else:
        sel = ("SELECT NULL AS spending_policy_id, NULL AS name, NULL AS plan_limit, NULL AS user_limit, "
               "NULL AS included_services WHERE false")
    con.execute(f"CREATE OR REPLACE TEMP TABLE policy_src AS {sel}")
    state.replace(TBL_POLICY, "policy_src")
    return {"policies": state.count(TBL_POLICY)}


def ingest(store, files: dict) -> dict:
    """Merges the drop folder's Viva files (`{name: local path}`) into the tables in `store`."""
    metrics = [files[n] for n in sorted(files) if n.lower().startswith(METRICS_PREFIX) and n.lower().endswith(".csv")]
    policies = [files[n] for n in sorted(files) if n.lower().startswith(POLICY_PREFIX) and n.lower().endswith(".csv")]
    con = duckdb.connect()
    try:
        state = TableState(con, store, SCHEMAS)
        state.load()
        out = {"files": len(metrics) + len(policies)}
        if metrics:
            out.update(_metrics(con, state, metrics))
        else:
            log.info("viva: no PersonServiceCreditsMetrics CSV in the drop folder")
        out.update(_policies(con, state, policies))
        out["tables"] = state.save()
    finally:
        con.close()
    return out


def collect_viva(api, store, settings, *, drop=None) -> dict:
    drop = drop or open_dropfolder(store, settings, api)
    with tempfile.TemporaryDirectory(prefix="valuelens-viva-") as tmp:
        paths = drop.fetch(SUBDIR, tmp)
        return ingest(store, {Path(p).name: Path(p) for p in paths})
