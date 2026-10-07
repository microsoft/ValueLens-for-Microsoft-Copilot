"""Synthetic demo data in place of the tenant collectors.

With VALUELENS_SAMPLE_DATA=true the run "collects" the repo's fabricated sample
(`4. Local CSV/sample-data`: 170 people at contoso-demo.com, three months of Copilot use) into a
throwaway local store, then processes, publishes and refreshes as usual. The people go through the
same `org` and `licensed` builders as Graph data, and the interactions are given in the parsed
audit shape, so the curated tables come out of the shared processor exactly as real data would.
The tenant's collected data in Storage isn't read or changed; unset the flag and the next run
publishes it again, replacing the sample in SQL.

Dates move forward by whole weeks so the latest sample day falls in the past week (weekday
patterns are kept, and the "last 30 days" measures have data).
"""
from __future__ import annotations

import csv
import logging
import os
from datetime import date, datetime, timedelta, timezone
from io import StringIO
from pathlib import Path

import duckdb

from valuelens_core import audit, licensed, org

from .tables import q, write_rows

log = logging.getLogger("valuelens_jobs.sample")

DEFAULT_DIR = "/app/sample-data"
INTERACTIONS = "copilot_interactions_sample.csv"
PEOPLE = "copilot_users_sample.csv"
PARSED = "raw/copilot_interactions_parsed/part-0.parquet"
COPILOT_PRODUCTS = "MICROSOFT 365 E5+MICROSOFT 365 COPILOT"
BASE_PRODUCTS = "MICROSOFT 365 E5"
REPORT_COLUMNS = [
    "Report Refresh Date", "User Principal Name", "Display Name", "Is Deleted", "Deleted Date",
    "Has Exchange License", "Has OneDrive License", "Has SharePoint License", "Has Skype For Business License",
    "Has Yammer License", "Has Teams License", "Exchange Last Activity Date", "OneDrive Last Activity Date",
    "SharePoint Last Activity Date", "Skype For Business Last Activity Date", "Yammer Last Activity Date",
    "Teams Last Activity Date", "Exchange License Assign Date", "OneDrive License Assign Date",
    "SharePoint License Assign Date", "Skype For Business License Assign Date", "Yammer License Assign Date",
    "Teams License Assign Date", "Assigned Products",
]
# Sample columns carried into the parsed audit shape; curate derives everything else.
CARRIED = [c for c in audit.PARSED_COLUMNS
           if c not in ("Id", "RecordId", "Source_RecordKey", "Source_MessageKey", "Source_ResourceKey",
                        "CreationDate", "Message_Ordinal", "Resource_Ordinal", "Audit_UserId_Normalized",
                        "InteractionDate", "WeekStart", "MonthStart")]


def sample_dir() -> Path:
    return Path(os.environ.get("VALUELENS_SAMPLE_DIR") or DEFAULT_DIR)


def _true(value) -> bool:
    return str(value or "").strip().lower() in ("true", "1", "yes")


def _people(folder: Path) -> list[dict]:
    with open(folder / PEOPLE, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def graph_users(people) -> list[dict]:
    """The sample people as Graph /users items (the fields `org.USERS_URL` selects)."""
    out = []
    for p in people:
        manager = (p.get("manager_userPrincipalName") or "").strip()
        out.append({
            "userPrincipalName": p["mail"], "displayName": p.get("displayName"),
            "department": p.get("Organization"), "jobTitle": p.get("JobTitle"),
            "companyName": p.get("companyName"), "officeLocation": p.get("officeLocation"),
            "city": p.get("city"), "country": p.get("country"),
            "accountEnabled": _true(p.get("accountEnabled")),
            "manager": {"userPrincipalName": manager} if manager else None,
        })
    return out


def licence_report(people, today: date) -> str:
    """The sample people as a Graph getOffice365ActiveUserDetail CSV."""
    buf = StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(REPORT_COLUMNS)
    for p in people:
        row = dict.fromkeys(REPORT_COLUMNS, "")
        row.update({
            "Report Refresh Date": today.isoformat(), "User Principal Name": p["mail"],
            "Display Name": p.get("displayName") or "", "Is Deleted": "False",
            "Has Exchange License": "True", "Has OneDrive License": "True", "Has SharePoint License": "True",
            "Has Skype For Business License": "False", "Has Yammer License": "False", "Has Teams License": "True",
            "Assigned Products": COPILOT_PRODUCTS if _true(p.get("Has license")) else BASE_PRODUCTS,
        })
        w.writerow([row[c] for c in REPORT_COLUMNS])
    return buf.getvalue()


def week_shift(latest: date, today: date) -> int:
    """Whole weeks (as days) that move `latest` into the seven days before `today`."""
    return max(0, ((today - latest).days - 1) // 7 * 7)


def load(store, *, folder: Path | None = None, today: date | None = None) -> dict:
    folder = Path(folder or sample_dir())
    today = today or datetime.now(timezone.utc).date()
    if not (folder / INTERACTIONS).is_file():
        raise FileNotFoundError(f"Sample data isn't in {folder}; the jobs image bundles it at {DEFAULT_DIR}.")
    people = _people(folder)

    columns, rows = org.build_snapshot(graph_users(people), allow_empty=False)
    write_rows(store.path("raw/copilot_org_data/part-0.parquet"), columns, rows)
    columns, rows = licensed.build_snapshot(licence_report(people, today), allow_empty=False)
    write_rows(store.path("raw/copilot_licensed_users/part-0.parquet"), columns, rows)

    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    src = f"read_csv({q(folder / INTERACTIONS)}, all_varchar=true, header=true)"
    con.execute(f"CREATE TEMP VIEW s AS SELECT *, row_number() OVER () AS __n FROM {src}")
    latest = con.execute("SELECT max(CAST(CAST(CreationDate AS TIMESTAMPTZ) AS DATE)) FROM s").fetchone()[0]
    shift = week_shift(latest, today)
    have = {r[0] for r in con.execute("DESCRIBE s").fetchall()}
    carried = ", ".join(f'"{c}"' if c in have else f'CAST(NULL AS VARCHAR) AS "{c}"' for c in CARRIED)
    target = store.path(PARSED)
    target.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"""COPY (
        SELECT 'sample-' || __n AS Id, Message_Id AS RecordId, 'sample:' || Message_Id AS Source_RecordKey,
               Message_Id AS Source_MessageKey, 'sample-resource:' || __n AS Source_ResourceKey,
               CAST(CAST(CreationDate AS TIMESTAMPTZ) AS TIMESTAMP) + INTERVAL ({shift}) DAY AS CreationDate,
               0 AS Message_Ordinal, 0 AS Resource_Ordinal,
               lower(trim(Audit_UserId)) AS Audit_UserId_Normalized, {carried}
        FROM s) TO {q(target)} (FORMAT PARQUET)""")
    count = con.execute(f"SELECT count(*) FROM read_parquet({q(target)})").fetchone()[0]
    con.close()
    log.info("sample: %s people, %s interaction rows; dates moved forward %s day(s) to end %s",
             len(people), count, shift, latest + timedelta(days=shift))
    return {"people": len(people), "interactions": count, "shift_days": shift}
