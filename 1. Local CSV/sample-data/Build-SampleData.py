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

COVERAGE
--------
The dataset is deliberately inclusive of the whole Copilot estate, not just
chat, so every page of the template has something to show:

    * Licensed M365 Copilot in Word / Outlook / Excel / PowerPoint / Teams
    * Unlicensed free Copilot Chat (the licence-upgrade cohort)
    * Copilot Studio agents - declarative agents AND custom engine agents
      published over ServiceNow, Dynamics 365, SAP, Workday, Salesforce
      and Dataverse
    * Autonomous agents running unattended workflows
    * Copilot Cowork - multi-step, multi-app task orchestration
    * Microsoft Scout - proactive, always-on assistance

Use --agent-share / --cowork-share / --scout-share to re-balance that mix.

CLASSIFICATION FIDELITY
-----------------------
The derived columns (Behavior_Enriched, Value_Outcome, Usage_Mode,
Expertise_Role, Efficiency_Breakdown, Environment, Autonomy_Pattern,
Human_Baseline_Min, ...) are NOT re-implemented here. They are computed by
importing the production classifier:

    1. Local CSV/scripts/Purview_CopilotInteraction_Processor_v4.0.0.py

so the sample data cannot drift away from what the processor would emit for the
same raw interaction, and every behaviour name used here resolves through the
template's Behavior Value Map to a real Human_Baseline_Min.

Agent_LinkID is deliberately NOT emitted here. The template derives it by
joining these rows to the Agents 365 registry, so shipping it in the CSV makes
that step fail with "The field 'Agent_LinkID' already exists in the record".
The production processor does not emit it either.

Usage:
    python Build-SampleData.py                 # write to ./sample-data
    python Build-SampleData.py --out <dir>
    python Build-SampleData.py --users 260 --days 60
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import os
import random
import sys
from datetime import date, datetime, timedelta

SEED = 20260807          # fixed: regenerating gives byte-identical output
DOMAIN = "contoso-demo.com"
COMPANY = "Contoso Demo Ltd"

# The template's AIBV profile: 3-value Environment {Cowork, Licensed,
# Unlicensed} plus the offloaded calc columns. Must match the profile the
# processor is run with for real tenants.
PROFILE = "aibv"

_HERE = os.path.dirname(os.path.abspath(__file__))
PROCESSOR = os.path.normpath(os.path.join(
    _HERE, os.pardir, "scripts", "Purview_CopilotInteraction_Processor_v4.0.0.py"))


def load_classifier(path: str = PROCESSOR):
    """Import the production processor so its classifiers can be reused."""
    if not os.path.isfile(path):
        sys.exit(f"processor not found: {path}\n"
                 "Run this script from inside the repo so the sample data is "
                 "classified by the same code that classifies real exports.")
    spec = importlib.util.spec_from_file_location("valuelens_processor", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# Human (non-agent) behaviours and their relative frequency - roughly what a
# real tenant looks like: lots of email and chat, fewer long-tail tasks.
# Every name below is a member of the template's Behavior Value Map, so each
# one carries a real Human_Baseline_Min.
# --------------------------------------------------------------------------
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
    "Real-time Collaboration": 1, "Form / Survey Work": 1,
    "Video Summarising": 1, "Spreadsheet Review": 1,
}

# Behaviours an UNLICENSED user can plausibly perform in free Copilot Chat.
# Mirrors _UNLICENSED_PLAUSIBLE in the production processor.
UNLICENSED_PLAUSIBLE = [
    "General Chat", "Web Searching", "PDF Analysis", "Document Summarising",
    "Image Generation", "Code Analysis",
]
UNLICENSED_WEIGHTS = [30, 22, 10, 16, 6, 8]
UNLICENSED_HOSTS = ["Microsoft365Chat", "Microsoft Edge"]

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

# --------------------------------------------------------------------------
# Agent estate.
#
# kind drives how the interaction is shaped and how the processor classifies it:
#
#   declarative  Agent Builder / M365 Copilot agent, used inside Teams/BizChat
#   studio       Copilot Studio custom engine agent  -> AppHost "Copilot Studio"
#   autonomous   unattended workflow agent           -> AppHost "Autonomous"
#   cowork       Copilot Cowork skill                -> Environment "Cowork"
#                (the processor keys Cowork off "cowork" in the agent name)
#   scout        Microsoft Scout, proactive assistance -> AppHost "Microsoft Scout"
#
# behaviours are drawn from the template's Behavior Value Map, so each agent
# contributes real modelled hours rather than silently scoring zero.
# --------------------------------------------------------------------------
AGENTS = [
    # --- declarative agents (Agent Builder / Microsoft 365 Copilot) ---------
    ("T_1001", "HR Onboarding Agent", "declarative", ("Agent: HR & People",), "Employee Services"),
    ("T_1002", "IT Helpdesk Agent", "declarative", ("Agent: IT & Service Desk",), COMPANY),
    ("T_1003", "Sales Insights Agent", "declarative", ("Agent: Sales & Customer",), COMPANY),
    ("T_1004", "Policy Lookup Agent", "declarative", ("Agent: Compliance & Policy",), COMPANY),
    ("T_1005", "Market Research Agent", "declarative", ("Agent: Research & Analysis",), COMPANY),
    ("T_1006", "Learning Coach Agent", "declarative", ("Agent: Coaching",), "Employee Services"),
    ("T_1007", "Finance Reporting Agent", "declarative", ("Agent: Data & Reporting",), COMPANY),
    ("T_1008", "Product Knowledge Agent", "declarative", ("Agent: Knowledge Base",), COMPANY),
    ("T_1009", "Brand Content Agent", "declarative", ("Agent: Content Generation",), "Marketing Ops"),
    ("T_1010", "Campaign Ideation Agent", "declarative", ("Agent: Ideation & Creative",), "Marketing Ops"),
    ("T_1011", "Benefits Buddy", "declarative", ("Agent: HR & People", "Agent: Knowledge Base"), "Employee Services"),
    ("T_1012", "Contract Review Agent", "declarative", ("Agent: Compliance & Policy",), "Legal Ops"),
    ("T_1013", "Onboarding FAQ Agent", "declarative", ("Agent: Knowledge Base",), "Employee Services"),
    ("T_1014", "Executive Briefing Agent", "declarative", ("Agent: Research & Analysis",), COMPANY),
    ("T_1015", "Sales Proposal Writer", "declarative", ("Agent: Content Generation", "Agent: Sales & Customer"), COMPANY),
    ("T_1016", "Meeting Notes Agent", "declarative", ("Note Taking",), COMPANY),

    # --- Copilot Studio custom engine agents --------------------------------
    ("T_2001", "ServiceNow Ticket Agent", "studio", ("Agent: IT & Service Desk", "Domain-Specific Agent"), "IT Service Management"),
    ("T_2002", "Dynamics 365 Opportunity Agent", "studio", ("Agent: Sales & Customer", "Domain-Specific Agent"), "Revenue Operations"),
    ("T_2003", "SAP Invoice Agent", "studio", ("Domain-Specific Agent", "Agent: Data & Reporting"), "Finance Systems"),
    ("T_2004", "Workday Absence Agent", "studio", ("Agent: HR & People", "Domain-Specific Agent"), "People Systems"),
    ("T_2005", "Salesforce Account Agent", "studio", ("Cross-Org Agent", "Agent: Sales & Customer"), "Revenue Operations"),
    ("T_2006", "Dataverse Analytics Agent", "studio", ("Agent: Data & Reporting", "Domain-Specific Agent"), "Data & Analytics"),
    ("T_2007", "Supplier Onboarding Agent", "studio", ("Domain-Specific Agent", "Agent: Compliance & Policy"), "Procurement"),
    ("T_2008", "Claims Triage Agent", "studio", ("Domain-Specific Agent",), "Customer Operations"),
    ("T_2009", "Clinical Policy Agent", "studio", ("Agent: Compliance & Policy", "Domain-Specific Agent"), "Risk & Compliance"),
    ("T_2010", "Store Operations Agent", "studio", ("Domain-Specific Agent",), "Retail Operations"),
    ("T_2011", "Field Service Scheduler", "studio", ("Domain-Specific Agent", "Task Management"), "Field Operations"),
    ("T_2012", "Partner Portal Agent", "studio", ("Cross-Org Agent",), "Partner Ecosystem"),
    ("T_2013", "Customer Escalation Agent", "studio", ("Agent: Sales & Customer", "Domain-Specific Agent"), "Customer Operations"),
    ("T_2014", "Procurement Policy Agent", "studio", ("Agent: Compliance & Policy",), "Procurement"),
    ("T_2015", "Quality Inspection Agent", "studio", ("Domain-Specific Agent",), "Manufacturing"),
    ("T_2016", "Logistics Tracking Agent", "studio", ("Domain-Specific Agent", "Agent: Data & Reporting"), "Supply Chain"),
    ("T_2017", "Engineering Knowledge Agent", "studio", ("Agent: Knowledge Base", "Domain-Specific Agent"), "Engineering"),
    ("T_2018", "Tender Response Agent", "studio", ("Agent: Content Generation", "Cross-Org Agent"), "Bid Management"),

    # --- autonomous agents --------------------------------------------------
    ("T_3001", "Invoice Matching Autonomous Agent", "autonomous", ("Running a Workflow",), "Finance Systems"),
    ("T_3002", "Lead Qualification Autonomous Agent", "autonomous", ("Running a Workflow",), "Revenue Operations"),
    ("T_3003", "Ticket Deflection Autonomous Agent", "autonomous", ("Running a Workflow",), "IT Service Management"),
    ("T_3004", "Compliance Monitoring Autonomous Agent", "autonomous", ("Running a Workflow",), "Risk & Compliance"),
    ("T_3005", "Inventory Replenishment Autonomous Agent", "autonomous", ("Running a Workflow",), "Supply Chain"),

    # --- Copilot Cowork skills ---------------------------------------------
    ("T_4001", "Cowork Planning Agent", "cowork", ("Running a Workflow", "Task Management"), COMPANY),
    ("T_4002", "Cowork Research Sprint", "cowork", ("Agent: Research & Analysis", "Running a Workflow"), COMPANY),
    ("T_4003", "Cowork Document Build", "cowork", ("Agent: Content Generation", "Running a Workflow"), COMPANY),
    ("T_4004", "Cowork Meeting Follow-up", "cowork", ("Task Management", "Running a Workflow"), COMPANY),
    ("T_4005", "Cowork Data Review", "cowork", ("Agent: Data & Reporting", "Running a Workflow"), COMPANY),
    ("T_4006", "Cowork Onboarding Pack", "cowork", ("Agent: HR & People", "Running a Workflow"), "Employee Services"),

    # --- Microsoft Scout ----------------------------------------------------
    ("T_5001", "Microsoft Scout", "scout", ("Agent: Research & Analysis", "Agent: Knowledge Base"), "Microsoft"),
    ("T_5002", "Scout Daily Briefing", "scout", ("Agent: Research & Analysis",), "Microsoft"),
    ("T_5003", "Scout Meeting Prep", "scout", ("Meeting Prep",), "Microsoft"),
    ("T_5004", "Scout Inbox Watch", "scout", ("Email Triage", "Email Thread Summary"), "Microsoft"),
    ("T_5005", "Scout Deal Watch", "scout", ("Agent: Sales & Customer", "Running a Workflow"), "Microsoft"),
]

# AppHost per agent kind. "cowork" / "autonomous" / "copilot studio" are load
# bearing: the processor keys Usage_Mode = "5 - Delegating" and the workflow
# behaviours off these hosts.
KIND_HOSTS = {
    "declarative": ("Microsoft Teams", "Microsoft365Chat"),
    "studio": ("Copilot Studio",),
    "autonomous": ("Autonomous",),
    "cowork": ("Cowork",),
    "scout": ("Microsoft Scout",),
}
KIND_CREATED_IN = {
    "declarative": "Microsoft 365 Copilot Agent Builder",
    "studio": "Copilot Studio",
    "autonomous": "Copilot Studio",
    "cowork": "Microsoft 365 Copilot",
    "scout": "Microsoft Scout",
}
KIND_SUPPORTED_IN = {
    "declarative": "Microsoft 365 Copilot;Teams",
    "studio": "Microsoft 365 Copilot;Teams;Copilot Studio",
    "autonomous": "Copilot Studio;Power Automate",
    "cowork": "Microsoft 365 Copilot;Cowork",
    "scout": "Microsoft 365 Copilot;Scout",
}

# Resources touched by agent work, so Web_Grounded_Signal / Workflow_Action /
# Resource_Count are driven by something rather than hardcoded.
WORKFLOW_ACTIONS = ["invoke", "create", "update", "send", "read"]

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
    "UserKey", "Audit_UserId_Normalized", "Agent_EntraId",
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
        licensed = rng.random() < 0.62      # ~62% licensed
        users.append({
            "idx": i, "upn": upn, "dept": dept,
            "display": f"{first} {last}", "given": first, "surname": last,
            "title": rng.choice(JOB_TITLES[dept]), "city": city, "country": cc,
            "licensed": licensed,
            # Cowork and Scout are newer: only part of the licensed estate has
            # them switched on, which is what an early-adoption tenant looks like.
            "cowork": licensed and rng.random() < 0.55,
            "scout": licensed and rng.random() < 0.45,
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


def _agents_of(kind: str):
    return [a for a in AGENTS if a[2] == kind]


def build_interactions(users, days: int, rng: random.Random, proc,
                       agent_share: float, cowork_share: float, scout_share: float):
    behaviours = list(WEIGHTS)
    weights = [WEIGHTS[b] for b in behaviours]
    end = date.today().replace(day=1) - timedelta(days=1)
    start = end - timedelta(days=days - 1)

    by_kind = {k: _agents_of(k) for k in KIND_HOSTS}
    # Declarative and Studio agents make up the "Agents" slice; Studio is the
    # larger estate in a tenant that has invested in Copilot Studio.
    agent_pool = [("declarative", 40), ("studio", 48), ("autonomous", 12)]
    agent_kinds = [k for k, _ in agent_pool]
    agent_kind_w = [w for _, w in agent_pool]

    # Adoption is uneven: a power tail, a long middle, and some dormant licences.
    # Unlicensed staff still appear: they use free Copilot Chat, which is exactly
    # the cohort the Licence Readiness page ranks as upgrade candidates.
    actives = [u for u in users
               if (u["licensed"] and rng.random() < 0.88)
               or (not u["licensed"] and rng.random() < 0.55)]
    rows = []
    for u in actives:
        tier = rng.random()
        if u["licensed"]:
            n_days = rng.randint(14, 22) if tier > 0.85 else \
                     rng.randint(7, 14) if tier > 0.55 else \
                     rng.randint(3, 8) if tier > 0.25 else rng.randint(1, 3)
        else:
            n_days = rng.randint(5, 10) if tier > 0.80 else \
                     rng.randint(2, 5) if tier > 0.45 else rng.randint(1, 3)
        chosen = rng.sample(range(days), min(n_days, days))
        for off in chosen:
            d = start + timedelta(days=off)
            if d.weekday() >= 5 and rng.random() < 0.8:
                continue                       # weekday-heavy
            # Cowork and Scout ramp up across the window rather than appearing
            # fully formed on day one.
            ramp = 0.35 + 0.65 * (off / max(days - 1, 1))
            n_per_day = rng.randint(1, 6) if u["licensed"] else rng.randint(1, 3)
            for _ in range(n_per_day):
                agent = None
                kind = ""
                if not u["licensed"]:
                    # No Office-embedded Copilot and no agents: free chat only.
                    behaviour = rng.choices(UNLICENSED_PLAUSIBLE, UNLICENSED_WEIGHTS)[0]
                    host = rng.choice(UNLICENSED_HOSTS)
                else:
                    roll = rng.random()
                    cw = cowork_share * ramp if u["cowork"] else 0.0
                    sc = scout_share * ramp if u["scout"] else 0.0
                    if roll < agent_share:
                        kind = rng.choices(agent_kinds, agent_kind_w)[0]
                    elif roll < agent_share + cw:
                        kind = "cowork"
                    elif roll < agent_share + cw + sc:
                        kind = "scout"
                    if kind:
                        agent = rng.choice(by_kind[kind])
                        behaviour = rng.choice(agent[3])
                        host = rng.choice(KIND_HOSTS[kind])
                    else:
                        behaviour = rng.choices(behaviours, weights)[0]
                        host = rng.choice(APP_HOSTS)

                # Scout works while nobody is watching, so it is not confined to
                # office hours the way interactive Copilot use is.
                hour = rng.randint(5, 22) if kind == "scout" else rng.randint(8, 18)
                ts = datetime(d.year, d.month, d.day, hour, rng.randint(0, 59), rng.randint(0, 59))

                tid = agent[0] if agent else ""
                aname = agent[1] if agent else ""
                has_license_raw = "TRUE" if u["licensed"] else "FALSE"

                # Resources touched, which drive the grounding / workflow columns.
                if behaviour == "Web Searching":
                    res_type, site_url = "WebSearchQuery", ""
                elif kind in {"studio", "autonomous", "cowork"}:
                    res_type = rng.choice(["flow", "connector", "file", "site"])
                    site_url = "https://contoso-demo.sharepoint.com/sites/ops" if res_type == "site" else ""
                elif kind == "scout":
                    res_type = rng.choice(["", "email", "file", "meeting"])
                    site_url = ""
                else:
                    res_type = rng.choice(["", "file", "email", "site"])
                    site_url = "https://contoso-demo.sharepoint.com/sites/team" if res_type == "site" else ""
                res_action = rng.choice(WORKFLOW_ACTIONS) if behaviour == "Running a Workflow" else ""

                # A small share of work touches labelled content, so the
                # sensitivity and compliance visuals are not empty.
                sens_label = "b2c3d4e5-0000-4f00-9000-000000000001" if rng.random() < 0.04 else ""

                # ---- every derived column below comes from the processor ----
                license_status = proc.compute_license_status(has_license_raw)
                environment = proc.compute_environment(PROFILE, has_license_raw, aname, tid, host)
                behavior_enriched = proc.compute_behavior_enriched(PROFILE, behaviour, aname, environment)
                behavior_full = proc.compute_behavior_enriched_full(behavior_enriched)
                is_sensitive = proc.compute_is_sensitive(sens_label, "")
                is_agent_activity = proc.compute_is_agent_activity(aname, tid, host, res_type)
                model = rng.choice(MODELS)
                workflow_action = proc.compute_workflow_action(behavior_full, res_action, host)
                rows.append({
                    "CreationDate": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "Audit_UserId": u["upn"],
                    "AppHost": host,
                    "Context_Type": "agent" if agent else rng.choice(["chat", "file", "meeting"]),
                    "Message_Id": "",
                    "Message_isPrompt": "TRUE",
                    "ModelTransparencyDetails_ModelName": model,
                    "AgentId": tid, "AgentName": aname,
                    "Has license": has_license_raw,
                    "AISystemPlugin_Id": "", "AISystemPlugin_Name": "",
                    "Agent_TitleID": tid, "ThreadId": f"thr-{rng.randint(10**6, 10**7-1)}",
                    "AccessedResource_Type": res_type,
                    "AccessedResource_Action": res_action,
                    "SensitivityLabelId": sens_label,
                    "Behavior_Source": proc.compute_behavior_source(
                        PROFILE, behaviour, environment, aname, "", host),
                    "Behavior_Enriched_Full": behavior_full,
                    "AccessedResource_SiteUrl": site_url,
                    "Behavior_Category": behaviour,
                    "Value_Outcome": proc.compute_value_outcome(
                        PROFILE, behavior_enriched, environment, is_sensitive),
                    "Behavior_Enriched": behavior_enriched,
                    "AccessedResource_SensitivityLabelId": "",
                    "WeekStart": week_start(d).isoformat(),
                    "InteractionDate": d.isoformat(),
                    "MonthStart": d.replace(day=1).isoformat(),
                    "Usage_Mode": proc.compute_usage_mode(behavior_full, environment, host),
                    "Expertise_Role": proc.compute_expertise_role(behavior_full),
                    "Efficiency_Breakdown": proc.compute_efficiency_breakdown(behavior_full, behaviour),
                    "AppIdentity_AppId": "", "AppIdentity_DisplayName": host,
                    "ApplicationName": host,
                    "ActivityDate": d.isoformat(),
                    "License Status": license_status,
                    "Environment": environment,
                    "Is_Sensitive": is_sensitive,
                    "AI_Model": proc.compute_ai_model(model),
                    "Autonomy_Pattern": proc.compute_autonomy_pattern(
                        PROFILE, environment, is_agent_activity),
                    "UserMonthKey": proc.compute_user_month_key(
                        u["upn"], d.replace(day=1).isoformat()),
                    "Web_Grounded_Signal": proc.compute_web_grounded_signal(res_type, site_url),
                    "Behavior_Plausible": proc.compute_behavior_plausible(license_status, behaviour),
                    "Workflow_Action": workflow_action,
                    "Is_Agent_Activity": is_agent_activity,
                    "Agent Filter": aname or "(No Agent)",
                    "Agent Publish Status": proc.compute_agent_publish_status(tid, aname),
                    "Resource_Count": rng.randint(0, 3),
                    "Audit_UserKey": u["upn"].lower(),
                    "Workload": "Copilot",
                    "ClientRegion": u["country"],
                    "Delegation_Event_Key": proc.compute_delegation_event_key(
                        u["upn"], d.isoformat(), aname, workflow_action, host),
                    "Human_Baseline_Min": proc.compute_human_baseline_min(behavior_full),
                    "UserKey": u["upn"].lower(),
                    "Audit_UserId_Normalized": u["upn"].lower(),
                    "Agent_EntraId": f"agt-{tid.lower()}" if kind in {"autonomous", "cowork", "scout"} else "",
                    "_kind": kind,
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
    """Agents 365 registry: one row per agent in the estate."""
    out = []
    for i, (tid, name, kind, behaviours, publisher) in enumerate(AGENTS):
        creator = users[(i * 17) % len(users)]
        primary = behaviours[0].replace("Agent: ", "").lower()
        custom_actions = rng.randint(3, 14) if kind in {"studio", "autonomous"} else 0
        r = {c: "" for c in AGENT_COLS}
        r.update({
            "Title ID": tid, "Agent name": name,
            "Agent creator": "Microsoft" if kind == "scout" else creator["display"],
            "Agent creator ID": "microsoft" if kind == "scout" else creator["upn"],
            "Creator Id": "microsoft" if kind == "scout" else creator["upn"],
            "Agent type (A365)": {
                "declarative": "Shared", "studio": "Shared",
                "autonomous": "Autonomous", "cowork": "Cowork", "scout": "Proactive",
            }[kind],
            "Agent description": {
                "declarative": f"Declarative agent for {primary} requests, grounded in Microsoft 365 content.",
                "studio": f"Copilot Studio custom engine agent for {primary}, published by {publisher}.",
                "autonomous": f"Autonomous agent that runs the {primary} workflow unattended on a schedule and on events.",
                "cowork": f"Copilot Cowork skill that plans and executes multi-step {primary} work across apps with human approval.",
                "scout": f"Microsoft Scout proactive assistance for {primary}, running continuously under its own agent identity.",
            }[kind],
            "Version": "1.0.0",
            "Availability": "Everyone" if kind in {"declarative", "cowork", "scout"} else "Specific groups",
            "Supported in": KIND_SUPPORTED_IN[kind],
            "Created in": KIND_CREATED_IN[kind],
            "Date created": "2026-03-02T10:00:00Z",
            "Last updated": "2026-06-20T14:30:00Z",
            "Custom actions": custom_actions,
            "Custom action list": "; ".join(
                f"{primary.split()[0]}_action_{n+1}" for n in range(min(custom_actions, 3))),
            "Status": "Available",
            "Channel": {"studio": "Copilot Studio", "autonomous": "Power Automate",
                        "cowork": "Microsoft 365 Copilot", "scout": "Microsoft Scout"}.get(kind, "Microsoft Teams"),
            "Sensitivity": "Confidential" if kind in {"studio", "autonomous"} and i % 3 == 0 else "General",
            "Can read OneDrive files": "Yes" if kind in {"cowork", "scout"} or i % 3 == 0 else "No",
            "Can read Sharepoint sites and files": "Yes",
            "Can extend to Graph connector": "Yes" if kind in {"studio", "scout"} else "No",
            "Graph connector details": f"{publisher} connector" if kind in {"studio", "scout"} else "",
            "Can generate images using user prompt": "Yes" if i % 5 == 0 else "No",
            "Can use code interpreter": "Yes" if kind == "studio" and i % 4 == 1 else "No",
            "Contains uploaded files": "Yes" if kind in {"declarative", "studio"} and i % 2 == 0 else "No",
            "Can read OneDrive and Sharepoint items": "Yes",
            "Instructions": f"Answer {primary} questions for {publisher} and hand off when confidence is low.",
            "Environment Id": f"env-{i+1:04d}", "Bot Id": f"bot-{i+1:04d}",
            "Entra Agent ID": f"agt-{tid.lower()}" if kind in {"autonomous", "cowork", "scout"} else "",
            "Groups shared": rng.randint(1, 6),
            "Users shared": rng.randint(20, 260),
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
    ap.add_argument("--out", default=_HERE,
                    help="output folder (default: alongside this script)")
    ap.add_argument("--users", type=int, default=260)
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--agent-share", type=float, default=0.34,
                    help="share of licensed interactions handled by agents")
    ap.add_argument("--cowork-share", type=float, default=0.12,
                    help="share of licensed interactions handled by Copilot Cowork")
    ap.add_argument("--scout-share", type=float, default=0.10,
                    help="share of licensed interactions handled by Microsoft Scout")
    a = ap.parse_args()

    proc = load_classifier()
    rng = random.Random(SEED)
    os.makedirs(a.out, exist_ok=True)

    users = build_users(a.users, rng)
    inter = build_interactions(users, a.days, rng, proc,
                               a.agent_share, a.cowork_share, a.scout_share)

    f1 = write_csv(os.path.join(a.out, "copilot_interactions_sample.csv"), INTERACTION_COLS, inter)
    f2 = write_csv(os.path.join(a.out, "copilot_users_sample.csv"), USER_COLS, user_rows(users))
    f3 = write_csv(os.path.join(a.out, "agents_365_sample.csv"), AGENT_COLS, agent_rows(users, rng))

    hours = sum(int(r["Human_Baseline_Min"]) for r in inter if r["Human_Baseline_Min"]) / 60
    lic = sum(1 for u in users if u["licensed"])
    print(f"sample data written to {a.out}/")
    print(f"  copilot_interactions_sample.csv  {len(inter):>6,} rows  {f1/1024:>7,.0f} KB")
    print(f"  copilot_users_sample.csv         {len(users):>6,} rows  {f2/1024:>7,.0f} KB")
    print(f"  agents_365_sample.csv            {len(AGENTS):>6,} rows  {f3/1024:>7,.0f} KB")
    print()
    lic_actives = len({r["Audit_UserId"] for r in inter if r["License Status"] == "M365 Copilot Licensed"})
    unlic_actives = len({r["Audit_UserId"] for r in inter if r["License Status"] == "Unlicensed"})
    print(f"  active licensed     : {lic_actives} of {lic} licensed")
    print(f"  active unlicensed   : {unlic_actives} of {a.users - lic} unlicensed (free chat)")
    print(f"  date range          : {inter[0]['InteractionDate']} -> {inter[-1]['InteractionDate']}")
    print(f"  raw hours modelled  : {hours:,.0f}  (x0.70 uplift -> ~{hours*0.7:,.0f} hours saved)")
    print()
    print("  interaction mix")
    kinds = {}
    for r in inter:
        kinds[r["_kind"] or "user-led Copilot"] = kinds.get(r["_kind"] or "user-led Copilot", 0) + 1
    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        print(f"    {k:<20} {n:>6,}  ({n/len(inter):.1%})")
    print()
    print("  environment")
    envs = {}
    for r in inter:
        envs[r["Environment"]] = envs.get(r["Environment"], 0) + 1
    for k, n in sorted(envs.items(), key=lambda kv: -kv[1]):
        print(f"    {k:<20} {n:>6,}  ({n/len(inter):.1%})")
    print()
    agents_seen = len({r["AgentName"] for r in inter if r["AgentName"]})
    print(f"  agents used         : {agents_seen} of {len(AGENTS)} registered")


if __name__ == "__main__":
    main()
