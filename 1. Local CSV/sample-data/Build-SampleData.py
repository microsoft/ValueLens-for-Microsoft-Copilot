#!/usr/bin/env python3
"""
Generate the ValueLens sample dataset.

Produces three CSVs that satisfy the exact column contract of
`1. Local CSV/ValueLens - Local CSV.pbit`:

    copilot_interactions_sample.csv   -> "Copilot Interactions File"
    copilot_users_sample.csv          -> "Org Data File"
    agents_365_sample.csv             -> "Agent 365"  (optional parameter)

Every value is fabricated here from a fixed seed. Nothing is copied, sampled or
derived from any tenant, export or audit log, so the output is synthetic by
construction rather than by redaction — you can verify that by reading this file
rather than by trusting a scrub.

Behaviour names and their Human_Baseline_Min values are kept consistent with the
production classifier in
`1. Local CSV/scripts/Purview_CopilotInteraction_Processor_v4.0.0.py`, so the
value model (hours saved -> assisted value) computes realistically.

Usage:
    python Build-SampleData.py                 # write to ./sample-data
    python Build-SampleData.py --out <dir>
    python Build-SampleData.py --users 260 --days 60
"""
from __future__ import annotations

import argparse
import csv
import os
import random
from datetime import date, datetime, timedelta

SEED = 20260807          # fixed: regenerating gives byte-identical output
DOMAIN = "contoso-demo.com"
COMPANY = "Contoso Demo Ltd"

# --------------------------------------------------------------------------
# Behaviour taxonomy -> human-time baseline (minutes).
# Mirrors _HUMAN_BASELINE_MIN in the processor. Keep the two in step.
# --------------------------------------------------------------------------
BASELINE = {
    "Email Drafting": 8, "Email Summarising": 4, "Email Triage": 10,
    "Email Thread Summary": 5, "Document Drafting": 60,
    "Document Summarising": 20, "Presentation Creation": 90,
    "Presentation Summarising": 12, "Spreadsheet Analysis": 40,
    "Excel Assistance": 30, "Data Querying": 30, "Code Writing": 45,
    "Code Analysis": 30, "Web Searching": 22, "Enterprise Searching": 18,
    "General Chat": 10, "Meeting Prep": 15, "Meeting Scheduling": 12,
    "Note Taking": 20, "Teams Messaging": 8, "Task Management": 20,
    "PDF Analysis": 35, "File Retrieval": 15, "People Lookup": 10,
    "SharePoint Access": 12, "Image Generation": 60,
    "Agent: HR & People": 35, "Agent: IT & Service Desk": 20,
    "Agent: Sales & Customer": 35, "Agent: Research & Analysis": 45,
    "Agent: Compliance & Policy": 25, "Agent: Coaching": 45,
    "Agent: Data & Reporting": 35, "Agent: Knowledge Base": 12,
}

# Relative frequency - roughly what a real tenant looks like: lots of email and
# chat, fewer long-tail production tasks.
WEIGHTS = {
    "Email Drafting": 14, "Email Summarising": 9, "Email Triage": 5,
    "General Chat": 11, "Document Drafting": 7, "Document Summarising": 6,
    "Teams Messaging": 6, "Meeting Prep": 5, "Enterprise Searching": 5,
    "Web Searching": 4, "Excel Assistance": 4, "Spreadsheet Analysis": 3,
    "Presentation Creation": 3, "Data Querying": 3, "Code Writing": 2,
    "Code Analysis": 2, "PDF Analysis": 2, "Note Taking": 2,
    "Task Management": 2, "File Retrieval": 2, "Meeting Scheduling": 2,
    "People Lookup": 1, "SharePoint Access": 1, "Email Thread Summary": 1,
    "Presentation Summarising": 1, "Image Generation": 1,
    "Agent: HR & People": 2, "Agent: IT & Service Desk": 2,
    "Agent: Sales & Customer": 2, "Agent: Research & Analysis": 1,
    "Agent: Compliance & Policy": 1, "Agent: Coaching": 1,
    "Agent: Data & Reporting": 1, "Agent: Knowledge Base": 1,
}

VALUE_OUTCOME = {
    "Email Drafting": "Communication Efficiency", "Email Summarising": "Communication Efficiency",
    "Email Triage": "Communication Efficiency", "Email Thread Summary": "Communication Efficiency",
    "Teams Messaging": "Communication Efficiency", "Meeting Scheduling": "Communication Efficiency",
    "Document Drafting": "Content Production", "Presentation Creation": "Content Production",
    "Image Generation": "Content Production", "Note Taking": "Content Production",
    "Document Summarising": "Knowledge Access", "Presentation Summarising": "Knowledge Access",
    "PDF Analysis": "Knowledge Access", "Enterprise Searching": "Knowledge Access",
    "Web Searching": "Knowledge Access", "File Retrieval": "Knowledge Access",
    "SharePoint Access": "Knowledge Access", "People Lookup": "Knowledge Access",
    "General Chat": "Knowledge Access", "Meeting Prep": "Knowledge Access",
    "Data Querying": "Data-Driven Decisions", "Spreadsheet Analysis": "Data-Driven Decisions",
    "Excel Assistance": "Data-Driven Decisions", "Agent: Data & Reporting": "Data-Driven Decisions",
    "Agent: Research & Analysis": "Data-Driven Decisions",
    "Code Writing": "Technical Productivity", "Code Analysis": "Technical Productivity",
    "Task Management": "Process Automation", "Agent: IT & Service Desk": "Service Resolution",
    "Agent: HR & People": "Service Resolution", "Agent: Sales & Customer": "Revenue Support",
    "Agent: Compliance & Policy": "Risk & Compliance", "Agent: Coaching": "Skills Development",
    "Agent: Knowledge Base": "Knowledge Access",
}

USAGE_MODE = {
    "Email Drafting": "Producing", "Document Drafting": "Producing",
    "Presentation Creation": "Producing", "Image Generation": "Producing",
    "Code Writing": "Producing", "Note Taking": "Producing",
    "Excel Assistance": "Producing", "Data Querying": "Producing",
    "Spreadsheet Analysis": "Producing", "Teams Messaging": "Producing",
    "Task Management": "Producing", "Meeting Scheduling": "Producing",
    "Email Summarising": "Consuming", "Document Summarising": "Consuming",
    "Presentation Summarising": "Consuming", "PDF Analysis": "Consuming",
    "Email Thread Summary": "Consuming", "Meeting Prep": "Consuming",
    "Code Analysis": "Consuming", "Email Triage": "Consuming",
    "Enterprise Searching": "Finding", "Web Searching": "Finding",
    "File Retrieval": "Finding", "People Lookup": "Finding",
    "SharePoint Access": "Finding", "General Chat": "Asking",
}

APP_HOSTS = ["Microsoft Teams", "Word", "Outlook", "Excel", "PowerPoint",
             "Microsoft365Chat", "OneNote", "Loop", "SharePoint"]
MODELS = ["GPT-4.1 (Next Gen)", "GPT-4o", "GPT-5 (Next Gen)", "o3-mini (Reasoning)"]
DEPARTMENTS = ["Sales", "IT", "Marketing", "Finance", "HR", "Legal", "Operations", "Customer Service"]
JOB_TITLES = {
    "Sales": ["Account Executive", "Sales Manager", "Sales Director", "Solution Specialist"],
    "IT": ["Systems Engineer", "IT Manager", "Platform Engineer", "Service Desk Analyst"],
    "Marketing": ["Marketing Manager", "Content Strategist", "Campaign Manager", "Brand Lead"],
    "Finance": ["Financial Analyst", "Controller", "Finance Manager", "Accountant"],
    "HR": ["HR Business Partner", "Recruiter", "People Operations Lead", "HR Manager"],
    "Legal": ["Legal Counsel", "Contracts Manager", "Compliance Officer", "Paralegal"],
    "Operations": ["Operations Manager", "Process Analyst", "Programme Manager", "Coordinator"],
    "Customer Service": ["Support Engineer", "Service Manager", "Success Manager", "Support Lead"],
}
CITIES = [("London", "GB"), ("Manchester", "GB"), ("Dublin", "IE"),
          ("Amsterdam", "NL"), ("Madrid", "ES"), ("Milan", "IT")]

AGENTS = [
    ("T_1001", "HR Onboarding Agent", "Agent: HR & People", "Employee Services"),
    ("T_1002", "IT Helpdesk Agent", "Agent: IT & Service Desk", "Contoso Demo Ltd"),
    ("T_1003", "Sales Insights Agent", "Agent: Sales & Customer", "Contoso Demo Ltd"),
    ("T_1004", "Policy Lookup Agent", "Agent: Compliance & Policy", "Contoso Demo Ltd"),
    ("T_1005", "Market Research Agent", "Agent: Research & Analysis", "Contoso Demo Ltd"),
    ("T_1006", "Learning Coach Agent", "Agent: Coaching", "Employee Services"),
    ("T_1007", "Finance Reporting Agent", "Agent: Data & Reporting", "Contoso Demo Ltd"),
    ("T_1008", "Product Knowledge Agent", "Agent: Knowledge Base", "Contoso Demo Ltd"),
]
AGENT_BY_BEHAVIOUR = {b: (t, n) for t, n, b, _ in AGENTS}

INTERACTION_COLS = [
    "CreationDate", "Audit_UserId", "AppHost", "Context_Type", "Message_Id",
    "Message_isPrompt", "ModelTransparencyDetails_ModelName", "AgentId", "AgentName",
    "Has license", "AISystemPlugin_Id", "AISystemPlugin_Name", "Agent_TitleID",
    "ThreadId", "AccessedResource_Type", "AccessedResource_Action", "SensitivityLabelId",
    "Behavior_Source", "Behavior_Enriched_Full", "AccessedResource_SiteUrl",
    "Behavior_Category", "Value_Outcome", "Behavior_Enriched",
    "AccessedResource_SensitivityLabelId", "WeekStart", "InteractionDate", "MonthStart",
    "Usage_Mode", "Expertise_Role", "Efficiency_Breakdown", "AppIdentity_AppId",
    "AppIdentity_DisplayName", "ApplicationName", "ActivityDate", "License Status",
    "Environment", "Is_Sensitive", "AI_Model", "Autonomy_Pattern", "UserMonthKey",
    "Web_Grounded_Signal", "Behavior_Plausible", "Workflow_Action", "Is_Agent_Activity",
    "Agent Filter", "Agent Publish Status", "Resource_Count", "Audit_UserKey",
    "Workload", "ClientRegion", "Delegation_Event_Key", "Human_Baseline_Min",
    "UserKey", "Audit_UserId_Normalized", "Agent_EntraId", "Agent_LinkID",
]

USER_COLS = [
    "Organization", "PersonId", "PersonId_Normalized", "TotalEmployees", "country",
    "displayName", "surname", "mail", "givenName", "id", "userType", "JobTitle",
    "accountEnabled", "usageLocation", "streetAddress", "state", "officeLocation",
    "city", "postalCode", "telephoneNumber", "mobilePhone", "alternateEmailAddress",
    "ageGroup", "consentProvidedForMinor", "legalAgeGroupClassification", "companyName",
    "creationType", "directorySynced", "invitationState", "identityIssuer",
    "createdDateTime", "Has license", "UserKey", "License Status", "employeeType",
    "employeeId", "manager_id", "manager_displayName", "manager_userPrincipalName",
    "manager_mail", "manager_jobTitle", "ManagerID", "BusinessAreaLabel",
    "CountryofEmployment", "CompanyCodeLabel", "CostCentreLabel", "assignedLicenses",
    "Manager_UserKey", "OrgLevel", "HierarchyPath", "TopOfChain_UserKey", "IsManager",
    "DirectReports", "TotalReports",
] + [f"Level{i}_{s}" for i in range(15) for s in ("UserKey", "Name")]

AGENT_COLS = [
    "Supported in", "Date created", "Created in", "Last updated", "Custom actions",
    "Title ID", "Can read OneDrive files", "Can read Sharepoint sites and files",
    "Can extend to Graph connector", "Can generate images using user prompt",
    "Can use code interpreter", "Contains uploaded files", "Agent name", "Agent creator",
    "Agent type (A365)", "Agent description", "Version", "Availability",
    "Agent creator ID", "Sensitivity", "Can read OneDrive and Sharepoint items",
    "OneDrive and Sharepoint items", "OneDrive files", "OneDrive sites",
    "Sharepoint files", "Sharepoint sites", "Graph connector details", "Uploaded files",
    "Status", "Channel", "Creator Id", "Environment Id", "Bot Id", "Custom action list",
    "Instructions", "Groups shared", "Users shared", "Entra Agent ID",
]

FIRST = ["Alex", "Sam", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Jamie",
         "Avery", "Quinn", "Rowan", "Skyler", "Harper", "Emerson", "Finley",
         "Dakota", "Reese", "Sage", "Blake", "Charlie"]
LAST = ["Adams", "Baker", "Clarke", "Dawson", "Ellis", "Fletcher", "Grant",
        "Harris", "Ingram", "Jensen", "Keller", "Lawson", "Mercer", "Norton",
        "Osborne", "Palmer", "Quincy", "Rivera", "Sutton", "Turner"]


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def build_users(n: int, rng: random.Random):
    """Directory with a 3-level management hierarchy."""
    users = []
    for i in range(1, n + 1):
        dept = DEPARTMENTS[i % len(DEPARTMENTS)]
        first, last = rng.choice(FIRST), rng.choice(LAST)
        upn = f"user{i:04d}@{DOMAIN}"
        city, cc = rng.choice(CITIES)
        users.append({
            "idx": i, "upn": upn, "dept": dept,
            "display": f"{first} {last}", "given": first, "surname": last,
            "title": rng.choice(JOB_TITLES[dept]), "city": city, "country": cc,
            # ~62% licensed, so the Readiness page has an unlicensed cohort to rank
            "licensed": rng.random() < 0.62,
        })

    # First user per department is that department's lead; user0001 is the top.
    leads = {}
    for u in users:
        leads.setdefault(u["dept"], u)
    top = users[0]
    for u in users:
        lead = leads[u["dept"]]
        u["manager"] = None if u is top else (top if u is lead else lead)
    return users


def build_interactions(users, days: int, rng: random.Random):
    behaviours = list(WEIGHTS)
    weights = [WEIGHTS[b] for b in behaviours]
    end = date.today().replace(day=1) - timedelta(days=1)
    start = end - timedelta(days=days - 1)

    # Adoption is uneven: a power tail, a long middle, and some dormant licences.
    actives = [u for u in users if u["licensed"] and rng.random() < 0.88]
    rows = []
    for u in actives:
        tier = rng.random()
        n_days = rng.randint(14, 22) if tier > 0.85 else \
                 rng.randint(7, 14) if tier > 0.55 else \
                 rng.randint(3, 8) if tier > 0.25 else rng.randint(1, 3)
        chosen = rng.sample(range(days), min(n_days, days))
        for off in chosen:
            d = start + timedelta(days=off)
            if d.weekday() >= 5 and rng.random() < 0.8:
                continue                       # weekday-heavy
            for _ in range(rng.randint(1, 6)):
                b = rng.choices(behaviours, weights)[0]
                ts = datetime(d.year, d.month, d.day,
                              rng.randint(8, 18), rng.randint(0, 59), rng.randint(0, 59))
                is_agent = b.startswith("Agent:")
                tid, aname = AGENT_BY_BEHAVIOUR.get(b, ("", ""))
                host = "Copilot Studio" if is_agent else rng.choice(APP_HOSTS)
                mode = USAGE_MODE.get(b, "Delegating" if is_agent else "Asking")
                rows.append({
                    "CreationDate": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "Audit_UserId": u["upn"],
                    "AppHost": host,
                    "Context_Type": "agent" if is_agent else rng.choice(["chat", "file", "meeting"]),
                    "Message_Id": f"msg-{len(rows)+1:07d}",
                    "Message_isPrompt": "TRUE",
                    "ModelTransparencyDetails_ModelName": rng.choice(MODELS),
                    "AgentId": tid, "AgentName": aname,
                    "Has license": "Yes",
                    "AISystemPlugin_Id": "", "AISystemPlugin_Name": "",
                    "Agent_TitleID": tid, "ThreadId": f"thr-{rng.randint(10**6, 10**7-1)}",
                    "AccessedResource_Type": rng.choice(["", "file", "email", "site"]),
                    "AccessedResource_Action": "", "SensitivityLabelId": "",
                    "Behavior_Source": "Agent" if is_agent else "Resource",
                    "Behavior_Enriched_Full": b,
                    "AccessedResource_SiteUrl": "",
                    "Behavior_Category": b,
                    "Value_Outcome": VALUE_OUTCOME.get(b, "Knowledge Access"),
                    "Behavior_Enriched": b,
                    "AccessedResource_SensitivityLabelId": "",
                    "WeekStart": week_start(d).isoformat(),
                    "InteractionDate": d.isoformat(),
                    "MonthStart": d.replace(day=1).isoformat(),
                    "Usage_Mode": mode,
                    "Expertise_Role": "Specialist Agents" if is_agent else "Knowledge Worker",
                    "Efficiency_Breakdown": "Automation" if is_agent else "Augmentation",
                    "AppIdentity_AppId": "", "AppIdentity_DisplayName": host,
                    "ApplicationName": host,
                    "ActivityDate": d.isoformat(),
                    "License Status": "Licensed",
                    "Environment": "Work",
                    "Is_Sensitive": "FALSE",
                    "AI_Model": rng.choice(MODELS),
                    "Autonomy_Pattern": "Pattern 2 - Human + Agent" if is_agent else "Pattern 1 - Human + Copilot",
                    "UserMonthKey": f"{u['upn']}|{d.strftime('%Y-%m')}",
                    "Web_Grounded_Signal": "FALSE",
                    "Behavior_Plausible": "TRUE",
                    "Workflow_Action": "Delegated" if is_agent else "Assisted",
                    "Is_Agent_Activity": "TRUE" if is_agent else "FALSE",
                    "Agent Filter": aname or "(No Agent)",
                    "Agent Publish Status": "Published" if is_agent else "",
                    "Resource_Count": rng.randint(0, 3),
                    "Audit_UserKey": u["upn"].lower(),
                    "Workload": "Copilot",
                    "ClientRegion": u["country"],
                    "Delegation_Event_Key": f"{u['upn']}|{d.isoformat()}|{tid}" if is_agent else "",
                    "Human_Baseline_Min": BASELINE.get(b, 10),
                    "UserKey": u["upn"].lower(),
                    "Audit_UserId_Normalized": u["upn"].lower(),
                    "Agent_EntraId": "",
                    "Agent_LinkID": tid,
                })
    rows.sort(key=lambda r: r["CreationDate"])
    for i, r in enumerate(rows, 1):
        r["Message_Id"] = f"msg-{i:07d}"
    return rows


def user_rows(users):
    total = len(users)
    out = []
    for u in users:
        mgr = u["manager"]
        lvl = 0 if mgr is None else (1 if mgr["manager"] is None else 2)
        is_mgr = any(x["manager"] is u for x in users)
        direct = sum(1 for x in users if x["manager"] is u)
        r = {c: "" for c in USER_COLS}
        r.update({
            "Organization": u["dept"], "PersonId": u["upn"],
            "PersonId_Normalized": u["upn"].lower(), "TotalEmployees": total,
            "country": u["country"], "displayName": u["display"],
            "surname": u["surname"], "mail": u["upn"], "givenName": u["given"],
            "id": f"00000000-0000-0000-0000-{u['idx']:012d}", "userType": "Member",
            "JobTitle": u["title"], "accountEnabled": "TRUE",
            "usageLocation": u["country"], "city": u["city"],
            "officeLocation": f"{u['city']} Office", "companyName": COMPANY,
            "createdDateTime": "2024-01-15T09:00:00Z",
            "Has license": "Yes" if u["licensed"] else "No",
            "UserKey": u["upn"].lower(),
            "License Status": "Licensed" if u["licensed"] else "Unlicensed",
            "employeeType": "Employee", "employeeId": f"E{u['idx']:05d}",
            "BusinessAreaLabel": u["dept"], "CountryofEmployment": u["country"],
            "CompanyCodeLabel": "CD01",
            "CostCentreLabel": f"CC-{u['dept'][:3].upper()}",
            "OrgLevel": lvl, "IsManager": "TRUE" if is_mgr else "FALSE",
            "DirectReports": direct, "TotalReports": direct,
            "Level0_UserKey": users[0]["upn"].lower(), "Level0_Name": users[0]["display"],
        })
        if mgr:
            r.update({
                "manager_id": f"00000000-0000-0000-0000-{mgr['idx']:012d}",
                "manager_displayName": mgr["display"],
                "manager_userPrincipalName": mgr["upn"], "manager_mail": mgr["upn"],
                "manager_jobTitle": mgr["title"], "ManagerID": mgr["upn"],
                "Manager_UserKey": mgr["upn"].lower(),
                "TopOfChain_UserKey": users[0]["upn"].lower(),
                "HierarchyPath": f"{users[0]['display']} > {mgr['display']} > {u['display']}",
            })
        out.append(r)
    return out


def agent_rows(users, rng):
    out = []
    for i, (tid, name, behaviour, publisher) in enumerate(AGENTS):
        creator = users[(i * 17) % len(users)]
        r = {c: "" for c in AGENT_COLS}
        r.update({
            "Title ID": tid, "Agent name": name,
            "Agent creator": creator["display"],
            "Agent creator ID": creator["upn"], "Creator Id": creator["upn"],
            "Agent type (A365)": "Declarative agent",
            "Agent description": f"Sample {behaviour.replace('Agent: ','').lower()} agent for demonstration data.",
            "Version": "1.0.0", "Availability": "Everyone",
            "Supported in": "Microsoft 365 Copilot;Teams",
            "Date created": "2026-03-02T10:00:00Z",
            "Last updated": "2026-06-20T14:30:00Z",
            "Created in": "Copilot Studio", "Status": "Published",
            "Channel": "Microsoft Teams", "Sensitivity": "General",
            "Can read OneDrive files": "FALSE",
            "Can read Sharepoint sites and files": "TRUE",
            "Can extend to Graph connector": "FALSE",
            "Can generate images using user prompt": "FALSE",
            "Can use code interpreter": "FALSE",
            "Contains uploaded files": "TRUE",
            "Can read OneDrive and Sharepoint items": "TRUE",
            "Environment Id": f"env-{i+1:04d}", "Bot Id": f"bot-{i+1:04d}",
            "Groups shared": rng.randint(1, 4),
            "Users shared": rng.randint(20, 180),
        })
        out.append(r)
    return out


def write_csv(path, cols, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser(description="Generate the ValueLens sample dataset.")
    ap.add_argument("--out", default="sample-data")
    ap.add_argument("--users", type=int, default=260)
    ap.add_argument("--days", type=int, default=60)
    a = ap.parse_args()

    rng = random.Random(SEED)
    os.makedirs(a.out, exist_ok=True)

    users = build_users(a.users, rng)
    inter = build_interactions(users, a.days, rng)

    f1 = write_csv(os.path.join(a.out, "copilot_interactions_sample.csv"), INTERACTION_COLS, inter)
    f2 = write_csv(os.path.join(a.out, "copilot_users_sample.csv"), USER_COLS, user_rows(users))
    f3 = write_csv(os.path.join(a.out, "agents_365_sample.csv"), AGENT_COLS, agent_rows(users, rng))

    hours = sum(r["Human_Baseline_Min"] for r in inter) / 60
    lic = sum(1 for u in users if u["licensed"])
    print(f"sample data written to {a.out}/")
    print(f"  copilot_interactions_sample.csv  {len(inter):>6,} rows  {f1/1024:>7,.0f} KB")
    print(f"  copilot_users_sample.csv         {len(users):>6,} rows  {f2/1024:>7,.0f} KB")
    print(f"  agents_365_sample.csv            {len(AGENTS):>6,} rows  {f3/1024:>7,.0f} KB")
    print()
    print(f"  active users        : {len({r['Audit_UserId'] for r in inter})} of {lic} licensed ({a.users} total)")
    print(f"  date range          : {inter[0]['InteractionDate']} -> {inter[-1]['InteractionDate']}")
    print(f"  raw hours modelled  : {hours:,.0f}  (x0.70 uplift -> ~{hours*0.7:,.0f} hours saved)")


if __name__ == "__main__":
    main()
