#!/usr/bin/env python3
"""
Generate the ValueLens sample dataset.

Produces four CSVs that satisfy the exact column contract of
`1. Local CSV/ValueLens - Local CSV.pbit`:

    copilot_interactions_sample.csv   -> "Copilot Interactions File"
    copilot_users_sample.csv          -> "Org Data File"
    agents_365_sample.csv             -> "Agent 365"      (optional parameter)
    product_feedback_sample.csv       -> "Feedback File"  (optional parameter)

SYNTHETIC BY CONSTRUCTION
-------------------------
Every row, name, prompt, comment and identifier is fabricated here from a fixed
seed. The PROPORTIONS - how many prompts a session runs to, how many resources
a prompt touches, which models each tool logs, how often people come back, how
uneven organisations are - were tuned against aggregate counts from real
deployments so the pages read like a real estate rather than a toy. Nothing was
copied, sampled or derived row-by-row from any tenant, export or audit log: you
can verify that by reading this file rather than by trusting a scrub.

WHAT IT EXERCISES
-----------------
    * Three full calendar months, so month-on-month trends, "last complete
      month" habit bands and 30-90 day dormancy all have data.
    * 14 organisations of uneven size and licence coverage, a four-level
      management hierarchy, licensed and unlicensed staff.
    * Adoption that grows across the window: Beginner, Developing, Habitual
      and Power users in the latest month, people who lapsed, and licences
      that were never used.
    * Multi-turn sessions (ThreadId) and multi-resource prompts, so session
      depth, work shape and fit grading have something to grade.
    * Licensed Microsoft 365 Copilot in Word / Outlook / Excel / PowerPoint /
      Teams / Loop / OneNote / SharePoint, and unlicensed Copilot Chat.
    * Agents built in Agent Builder, SharePoint, Copilot Studio and Azure AI
      Foundry, autonomous agents, Marketplace and line-of-business agents,
      Microsoft agents (Researcher, Analyst), Copilot Cowork and Microsoft Scout.
    * Frontier and workhorse models, and prompts with no model logged, so the
      Model Fit page can show well-matched, lighter-model and stronger-model
      sessions.
    * An Agents 365 registry that covers every Agent Lifecycle state.
    * Fifteen months of product feedback across every feedback type the admin
      centre exports (thumbs, NPS, PSAT, surveys, ideas, bugs, smiles, frowns).

ROW SHAPE
---------
Rows follow the Fabric export: one row per resource a prompt touched, sharing
the prompt's Message_Id (most prompts touch zero or one resource). The Local CSV
processor collapses a prompt to one row; every prompt and session count in the
template uses distinct Message_Id / ThreadId, so totals are the same either way.

CLASSIFICATION FIDELITY
-----------------------
The derived columns (Behavior_Enriched, Value_Outcome, Usage_Mode,
Expertise_Role, Efficiency_Breakdown, Environment, Autonomy_Pattern, AI_Model,
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
    python Build-SampleData.py                      # window ends last day of last month
    python Build-SampleData.py --end 2026-08-31     # reproduce the shipped files
    python Build-SampleData.py --out <dir> --users 240 --months 3
"""
from __future__ import annotations

import argparse
import calendar
import csv
import importlib.util
import json
import os
import random
import sys
import uuid
from datetime import date, datetime, timedelta

SEED = 20260807          # fixed: same --end gives byte-identical output
DOMAIN = "contoso-demo.com"
COMPANY = "Contoso Demo Ltd"
SP_ROOT = "https://contoso-demo.sharepoint.com/sites"

# The template's AIBV profile: licensing Environment {Licensed, Unlicensed},
# Cowork flagged in Agent Filter, plus the offloaded calc columns. Must match
# the profile the processor is run with for real tenants.
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
# Organisation. (name, relative headcount, licence coverage, engagement).
# Engagement > 1 tilts people towards the Habitual / Power bands. Uneven on
# purpose: org charts and licence-readiness rankings need something to rank.
# The first organisation holds the CEO, who tops the hierarchy.
# --------------------------------------------------------------------------
ORGS = [
    ("Executive Office", 2, 1.00, 1.10),
    ("Sales", 15, 0.72, 1.15),
    ("Customer Service", 12, 0.35, 0.80),
    ("Operations", 11, 0.50, 0.90),
    ("IT", 10, 0.85, 1.30),
    ("Finance", 9, 0.70, 1.05),
    ("Engineering", 8, 0.60, 1.20),
    ("Marketing", 7, 0.75, 1.10),
    ("HR", 6, 0.60, 0.95),
    ("Supply Chain", 5, 0.40, 0.85),
    ("Procurement", 4, 0.55, 0.90),
    ("Legal", 4, 0.80, 0.75),
    ("Risk & Compliance", 4, 0.65, 0.90),
    ("Strategy", 3, 0.90, 1.25),
]
# (head of organisation, team lead, staff titles)
TITLES = {
    "Executive Office": ("Chief Executive Officer", "Chief of Staff",
                         ["Executive Assistant", "Strategy Advisor", "Communications Lead"]),
    "Sales": ("Sales Director", "Sales Manager",
              ["Account Executive", "Solution Specialist", "Inside Sales Rep", "Bid Manager"]),
    "Customer Service": ("Head of Customer Service", "Service Manager",
                         ["Support Engineer", "Customer Advisor", "Success Manager", "Support Lead"]),
    "Operations": ("Operations Director", "Operations Manager",
                   ["Process Analyst", "Programme Manager", "Coordinator", "Planner"]),
    "IT": ("Chief Information Officer", "IT Manager",
           ["Systems Engineer", "Platform Engineer", "Service Desk Analyst", "Security Analyst"]),
    "Finance": ("Finance Director", "Finance Manager",
                ["Financial Analyst", "Accountant", "Controller", "Payroll Specialist"]),
    "Engineering": ("Head of Engineering", "Engineering Manager",
                    ["Software Engineer", "Data Engineer", "QA Engineer", "Solutions Architect"]),
    "Marketing": ("Marketing Director", "Marketing Manager",
                  ["Content Strategist", "Campaign Manager", "Brand Lead", "Digital Specialist"]),
    "HR": ("HR Director", "HR Manager",
           ["HR Business Partner", "Recruiter", "People Operations Lead", "Learning Specialist"]),
    "Supply Chain": ("Supply Chain Director", "Logistics Manager",
                     ["Demand Planner", "Logistics Coordinator", "Inventory Analyst"]),
    "Procurement": ("Head of Procurement", "Category Manager",
                    ["Buyer", "Procurement Analyst", "Supplier Manager"]),
    "Legal": ("General Counsel", "Legal Manager",
              ["Legal Counsel", "Contracts Manager", "Paralegal"]),
    "Risk & Compliance": ("Chief Risk Officer", "Compliance Manager",
                          ["Compliance Officer", "Risk Analyst", "Internal Auditor"]),
    "Strategy": ("Strategy Director", "Strategy Manager",
                 ["Strategy Analyst", "Transformation Lead", "Insights Analyst"]),
}
CITIES = [("London", "GB"), ("Manchester", "GB"), ("Dublin", "IE"),
          ("Amsterdam", "NL"), ("Madrid", "ES"), ("Milan", "IT")]
FIRST = ["Alex", "Sam", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Jamie",
         "Avery", "Quinn", "Rowan", "Skyler", "Harper", "Emerson", "Finley",
         "Dakota", "Reese", "Sage", "Blake", "Charlie", "Robin", "Drew", "Ellis",
         "Hayden", "Jesse", "Kai", "Logan", "Micah", "Noel", "Parker", "Remy",
         "Shay", "Tatum", "Val", "Wren", "Ari", "Bailey", "Cameron", "Devon", "Frankie"]
LAST = ["Adams", "Baker", "Clarke", "Dawson", "Ellis", "Fletcher", "Grant",
        "Harris", "Ingram", "Jensen", "Keller", "Lawson", "Mercer", "Norton",
        "Osborne", "Palmer", "Quincy", "Rivera", "Sutton", "Turner", "Upton",
        "Vaughan", "Walsh", "Young", "Barnes", "Carter", "Doyle", "Foster",
        "Hughes", "Kemp", "Lowe", "Marsh", "Nash", "Pearce", "Reid", "Shaw",
        "Tate", "Ward", "Wells", "York"]

# --------------------------------------------------------------------------
# Adoption. Licensed people get a band for the LATEST month (the template's
# habit bands: 1-5, 6-10, 11-15, 16+ active days); earlier months are lighter,
# so adoption visibly grows. "lapsed" people stop after the first month or two
# (30-90 day dormancy); "never" holds a licence that is never used.
# --------------------------------------------------------------------------
TIER_WEIGHTS = {"power": 17, "habitual": 25, "developing": 28, "beginner": 17,
                "lapsed": 7, "never": 6}
TIER_DAYS = {"power": (16, 20), "habitual": (11, 15), "developing": (6, 10), "beginner": (1, 5)}
# sessions started on an active day: (count, weight)
TIER_SESSIONS = {
    "power": [(1, 62), (2, 32), (3, 6)],
    "habitual": [(1, 74), (2, 24), (3, 2)],
    "developing": [(1, 86), (2, 14)],
    "beginner": [(1, 93), (2, 7)],
    "lapsed": [(1, 88), (2, 12)],
    "unlicensed": [(1, 90), (2, 10)],
}
# unlicensed intensity: days per month
UNLICENSED_DAYS = [((1, 3), 55), ((4, 7), 30), ((8, 12), 15)]
WEEKEND_WEIGHT = 0.07     # relative chance of a weekend day being an active day

# Prompts per session, by tool. Buckets and weights follow the shape observed
# in real tenants: most sessions are one prompt, with a long tail.
TURNS = {
    "copilot": [((1, 1), 57), ((2, 3), 25), ((4, 6), 10), ((7, 9), 5), ((10, 14), 3)],
    "agent": [((1, 1), 70), ((2, 3), 18), ((4, 6), 7), ((7, 9), 3), ((10, 14), 2)],
    "cowork": [((1, 1), 50), ((2, 3), 25), ((4, 6), 13), ((7, 9), 8), ((10, 14), 4)],
}
# Resource rows per prompt (non-Cowork). Most prompts touch nothing or one thing.
ROWS_PER_PROMPT = [((1, 1), 82), ((2, 2), 9), ((3, 4), 5.5), ((5, 8), 3), ((9, 12), 0.5)]
# Working-hours curve (hour, weight). Scout runs off-hours as well.
HOURS = [(6, 1), (7, 3), (8, 8), (9, 12), (10, 13), (11, 12), (12, 9), (13, 10),
         (14, 11), (15, 10), (16, 8), (17, 5), (18, 3), (19, 2), (20, 1.5), (21, 1), (22, 0.5)]

# --------------------------------------------------------------------------
# Human (non-agent) behaviours and their relative frequency. Every name is a
# member of the template's Behavior Value Map, so each carries a real
# Human_Baseline_Min.
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

_M365, _TEAMS = "Microsoft365Chat", "Microsoft Teams"
# Where each behaviour usually happens. Anything unlisted uses DEFAULT_HOSTS.
BEHAVIOUR_HOSTS = {
    "Email Drafting": [("Outlook", 7), (_M365, 2), (_TEAMS, 1)],
    "Email Summarising": [("Outlook", 7), (_M365, 3)],
    "Email Triage": [("Outlook", 8), (_M365, 2)],
    "Email Thread Summary": [("Outlook", 9), (_M365, 1)],
    "Document Drafting": [("Word", 6), (_M365, 3), ("Loop", 1)],
    "Document Summarising": [("Word", 5), (_M365, 4), (_TEAMS, 1)],
    "Presentation Creation": [("PowerPoint", 8), (_M365, 2)],
    "Presentation Summarising": [("PowerPoint", 6), (_M365, 4)],
    "Excel Assistance": [("Excel", 9), (_M365, 1)],
    "Spreadsheet Analysis": [("Excel", 7), (_M365, 3)],
    "Spreadsheet Review": [("Excel", 8), (_M365, 2)],
    "Teams Messaging": [(_TEAMS, 9), (_M365, 1)],
    "Meeting Prep": [(_TEAMS, 5), (_M365, 4), ("Outlook", 1)],
    "Meeting Scheduling": [("Outlook", 6), (_TEAMS, 4)],
    "Note Taking": [(_TEAMS, 5), ("OneNote", 3), ("Loop", 2)],
    "Video Summarising": [(_TEAMS, 8), (_M365, 2)],
    "Real-time Collaboration": [("Loop", 7), (_TEAMS, 3)],
    "SharePoint Access": [("SharePoint", 7), (_M365, 3)],
    "Enterprise Searching": [(_M365, 6), ("SharePoint", 2), (_TEAMS, 2)],
    "File Retrieval": [(_M365, 6), (_TEAMS, 2), ("SharePoint", 2)],
}
DEFAULT_HOSTS = [(_M365, 6), (_TEAMS, 4)]
# In-app Copilot often logs no model name ("Embedded App (no model logged)").
EMBEDDED_HOSTS = {"Word", "Excel", "PowerPoint", "OneNote", "Loop", "SharePoint"}

# Resource types each behaviour touches: (chance the prompt touches material,
# pool of AccessedResource_Type values). Vocabulary is the one real audit logs
# use (EmailMessage, TeamsMessage, Event, SitePageModern, CITATION, file
# extensions ...), which is what the template's fit rules read.
BEHAVIOUR_RESOURCES = {
    "Email Drafting": (0.55, ["EmailMessage"] * 4 + ["eml", "msg"]),
    "Email Summarising": (0.85, ["EmailMessage"]),
    "Email Triage": (0.85, ["EmailMessage"]),
    "Email Thread Summary": (0.90, ["EmailMessage", "EmailMessage", "msg"]),
    "General Chat": (0.12, ["docx", "pdf", "pptx", "xlsx", "loop", "png", "txt"]),
    "Document Drafting": (0.60, ["docx", "docx", "docx", "loop", "pdf", "txt"]),
    "Document Summarising": (0.85, ["docx", "docx", "pdf", "txt", "loop"]),
    "Teams Messaging": (0.80, ["TeamsMessage"]),
    "Meeting Prep": (0.85, ["Event", "Event", "EmailMessage", "TeamsMessage", "docx", "pptx"]),
    "Meeting Scheduling": (0.80, ["Event"]),
    "Note Taking": (0.70, ["Event", "TeamsMessage", "loop", "onepart"]),
    "Video Summarising": (0.90, ["mp4", "Event"]),
    "Enterprise Searching": (0.70, ["SitePageModern", "aspx", "File", "docx", "pdf", "pptx"]),
    "SharePoint Access": (0.90, ["SitePageModern", "aspx", "aspx"]),
    "File Retrieval": (0.90, ["File", "docx", "xlsx", "pptx", "pdf"]),
    "Excel Assistance": (0.80, ["xlsx", "xlsx", "xlsm", "csv"]),
    "Spreadsheet Analysis": (0.90, ["xlsx", "xlsx", "csv", "xlsm"]),
    "Spreadsheet Review": (0.90, ["xlsx"]),
    "Presentation Creation": (0.75, ["pptx", "pptx", "docx", "pdf"]),
    "Presentation Summarising": (0.90, ["pptx"]),
    "Data Querying": (0.60, ["xlsx", "csv", "External"]),
    "Code Writing": (0.35, ["py", "json", "html"]),
    "Code Analysis": (0.35, ["py", "json", "txt"]),
    "PDF Analysis": (0.95, ["pdf"]),
    "Task Management": (0.50, ["loop", "TeamsMessage"]),
    "Image Generation": (0.30, ["png"]),
    "Real-time Collaboration": (0.85, ["loop", "docx"]),
    "Form / Survey Work": (0.50, ["File", "aspx"]),
}
HYPERLINK = "http://schema.skype.com/HyperLink"
WEB_SITES = ["https://learn.microsoft.com/en-us/", "https://www.gov.uk/guidance/",
             "https://en.wikipedia.org/wiki/", "https://www.example.org/insights/"]
# Types that live in SharePoint / OneDrive and so carry a site URL.
SITE_TYPES = {"SitePageModern", "aspx", "File", "docx", "xlsx", "xlsm", "csv",
              "pptx", "pdf", "loop", "txt", "mp4", "png"}
WORKFLOW_ACTIONS = ["invoke", "create", "update", "send", "read"]
SENSITIVITY_LABELS = ["b2c3d4e5-0000-4f00-9000-000000000001",
                      "b2c3d4e5-0000-4f00-9000-000000000002"]

# --------------------------------------------------------------------------
# Agent estate. kind drives the host, the registry entry and how the
# processor classifies the row:
#
#   declarative  Agent Builder agent in Teams / Copilot Chat
#   sharepoint   SharePoint site agent
#   studio       Copilot Studio custom engine agent  -> AppHost "Copilot Studio"
#   foundry      Azure AI Foundry agent published to Microsoft 365
#   autonomous   unattended workflow agent           -> AppHost "Autonomous"
#   marketplace  third-party agent from the Agent Store
#   lob          line-of-business agent published by IT
#   microsoft    Microsoft-built agent (Researcher, Analyst)
#   cowork       Copilot Cowork                      -> Agent Filter "Cowork"
#                (the processor keys Cowork off "cowork" in the host or agent name)
#   scout        Microsoft Scout, proactive assistance -> AppHost "Microsoft Scout"
#
# Behaviours come from the Behavior Value Map, so every agent contributes real
# modelled hours. orgs = where the agent is mostly used (None = everyone);
# pop = relative popularity, so the estate has a head and a long tail.
# --------------------------------------------------------------------------
def _agent(tid, name, kind, behaviours, publisher, orgs=None, pop=1.0):
    return {"tid": tid, "name": name, "kind": kind, "beh": behaviours,
            "publisher": publisher, "orgs": orgs, "pop": pop}


AGENTS = [
    # Agent Builder
    _agent("T_1001", "HR Onboarding Agent", "declarative", ("HR & People",), "Employee Services", pop=2),
    _agent("T_1002", "IT Helpdesk Agent", "declarative", ("IT & Service Desk",), COMPANY, pop=5),
    _agent("T_1003", "Sales Insights Agent", "declarative", ("Sales & Customer",), COMPANY, ["Sales"], 2),
    _agent("T_1004", "Policy Lookup Agent", "declarative", ("Compliance & Policy",), COMPANY, pop=2),
    _agent("T_1005", "Market Research Agent", "declarative", ("Research & Analysis",), COMPANY, ["Marketing", "Strategy"]),
    _agent("T_1006", "Learning Coach Agent", "declarative", ("Coaching",), "Employee Services", pop=0.6),
    _agent("T_1007", "Finance Reporting Agent", "declarative", ("Data & Reporting",), COMPANY, ["Finance"], 1.5),
    _agent("T_1008", "Product Knowledge Agent", "declarative", ("Knowledge Base",), COMPANY, ["Sales", "Customer Service"], 1.5),
    _agent("T_1009", "Brand Content Agent", "declarative", ("Content Generation",), "Marketing Ops", ["Marketing"]),
    _agent("T_1010", "Campaign Ideation Agent", "declarative", ("Ideation & Creative",), "Marketing Ops", ["Marketing"], 0.6),
    _agent("T_1011", "Benefits Buddy", "declarative", ("HR & People", "Knowledge Base"), "Employee Services", pop=2),
    _agent("T_1012", "Contract Review Agent", "declarative", ("Compliance & Policy",), "Legal Ops", ["Legal", "Procurement"]),
    _agent("T_1013", "Onboarding FAQ Agent", "declarative", ("Knowledge Base",), "Employee Services", pop=0.5),
    _agent("T_1014", "Executive Briefing Agent", "declarative", ("Research & Analysis",), COMPANY, ["Executive Office", "Strategy", "Sales"]),
    _agent("T_1015", "Sales Proposal Writer", "declarative", ("Content Generation", "Sales & Customer"), COMPANY, ["Sales"], 1.5),
    _agent("T_1016", "Meeting Notes Agent", "declarative", ("Note Taking",), COMPANY, pop=2),
    # SharePoint site agents
    _agent("T_1101", "HR Policies Site Agent", "sharepoint", ("HR & People",), "HR", pop=1.5),
    _agent("T_1102", "IT Knowledge Site Agent", "sharepoint", ("Knowledge Base",), "IT", ["IT"]),
    _agent("T_1103", "Sales Playbook Site Agent", "sharepoint", ("Sales & Customer",), "Sales", ["Sales"]),
    _agent("T_1104", "Finance Handbook Site Agent", "sharepoint", ("Knowledge Base",), "Finance", ["Finance"], 0.6),
    _agent("T_1105", "Engineering Standards Site Agent", "sharepoint", ("Knowledge Base",), "Engineering", ["Engineering"]),
    # Copilot Studio
    _agent("T_2001", "ServiceNow Ticket Agent", "studio", ("IT & Service Desk", "Domain-Specific Agent"), "IT Service Management", pop=3),
    _agent("T_2002", "Dynamics 365 Opportunity Agent", "studio", ("Sales & Customer", "Domain-Specific Agent"), "Revenue Operations", ["Sales"], 1.5),
    _agent("T_2003", "SAP Invoice Agent", "studio", ("Domain-Specific Agent", "Data & Reporting"), "Finance Systems", ["Finance", "Procurement"]),
    _agent("T_2004", "Workday Absence Agent", "studio", ("HR & People", "Domain-Specific Agent"), "People Systems", pop=3),
    _agent("T_2005", "Salesforce Account Agent", "studio", ("Cross-Org Agent", "Sales & Customer"), "Revenue Operations", ["Sales", "Customer Service"]),
    _agent("T_2006", "Dataverse Analytics Agent", "studio", ("Data & Reporting", "Domain-Specific Agent"), "Data & Analytics", ["IT", "Strategy", "Operations"]),
    _agent("T_2007", "Supplier Onboarding Agent", "studio", ("Domain-Specific Agent", "Compliance & Policy"), "Procurement", ["Procurement", "Supply Chain"]),
    _agent("T_2008", "Claims Triage Agent", "studio", ("Domain-Specific Agent",), "Customer Operations", ["Customer Service"], 1.5),
    _agent("T_2009", "Safety Policy Agent", "studio", ("Compliance & Policy", "Domain-Specific Agent"), "Risk & Compliance", ["Risk & Compliance", "Operations"]),
    _agent("T_2010", "Store Operations Agent", "studio", ("Domain-Specific Agent",), "Retail Operations", ["Operations"]),
    _agent("T_2011", "Field Service Scheduler", "studio", ("Domain-Specific Agent", "Task Management"), "Field Operations", ["Operations", "Customer Service"]),
    _agent("T_2012", "Partner Portal Agent", "studio", ("Cross-Org Agent",), "Partner Ecosystem", ["Sales"], 0.5),
    _agent("T_2013", "Customer Escalation Agent", "studio", ("Sales & Customer", "Domain-Specific Agent"), "Customer Operations", ["Customer Service"]),
    _agent("T_2014", "Procurement Policy Agent", "studio", ("Compliance & Policy",), "Procurement", ["Procurement", "Finance"], 0.6),
    _agent("T_2015", "Quality Inspection Agent", "studio", ("Domain-Specific Agent",), "Manufacturing", ["Operations", "Engineering"], 0.6),
    _agent("T_2016", "Logistics Tracking Agent", "studio", ("Domain-Specific Agent", "Data & Reporting"), "Supply Chain", ["Supply Chain"]),
    _agent("T_2017", "Engineering Knowledge Agent", "studio", ("Knowledge Base", "Domain-Specific Agent"), "Engineering", ["Engineering"]),
    _agent("T_2018", "Tender Response Agent", "studio", ("Content Generation", "Cross-Org Agent"), "Bid Management", ["Sales", "Legal"], 0.6),
    # Azure AI Foundry
    _agent("T_2101", "Pricing Optimisation Agent", "foundry", ("Data & Reporting",), "Data & Analytics", ["Sales", "Finance"]),
    _agent("T_2102", "Contract Intelligence Agent", "foundry", ("Compliance & Policy",), "Legal Ops", ["Legal"]),
    _agent("T_2103", "Demand Forecasting Agent", "foundry", ("Research & Analysis",), "Supply Chain", ["Supply Chain", "Operations"]),
    # Autonomous
    _agent("T_3001", "Invoice Matching Autonomous Agent", "autonomous", ("Running a Workflow",), "Finance Systems", ["Finance"], 0.8),
    _agent("T_3002", "Lead Qualification Autonomous Agent", "autonomous", ("Running a Workflow",), "Revenue Operations", ["Sales"], 0.8),
    _agent("T_3003", "Ticket Deflection Autonomous Agent", "autonomous", ("Running a Workflow",), "IT Service Management", ["IT"], 0.8),
    _agent("T_3004", "Compliance Monitoring Autonomous Agent", "autonomous", ("Running a Workflow",), "Risk & Compliance", ["Risk & Compliance"], 0.8),
    _agent("T_3005", "Inventory Replenishment Autonomous Agent", "autonomous", ("Running a Workflow",), "Supply Chain", ["Supply Chain"], 0.8),
    # Marketplace (fictional publishers)
    _agent("T_6001", "Fabrikam Travel Assistant", "marketplace", ("Knowledge Base",), "Fabrikam, Inc.", pop=1.5),
    _agent("T_6002", "Northwind CRM Assistant", "marketplace", ("Sales & Customer",), "Northwind Traders", ["Sales"]),
    _agent("T_6003", "Tailspin Legal Research", "marketplace", ("Compliance & Policy",), "Tailspin Toys", ["Legal"], 0.6),
    _agent("T_6004", "Litware Market Intelligence", "marketplace", ("Research & Analysis",), "Litware, Inc.", ["Marketing", "Strategy"]),
    # Line of business
    _agent("T_6101", "Contoso Field Guide", "lob", ("Knowledge Base",), COMPANY, ["Operations"]),
    _agent("T_6102", "Contoso Pricing Desk", "lob", ("Sales & Customer",), COMPANY, ["Sales"]),
    _agent("T_6103", "Contoso Safety Reporter", "lob", ("Compliance & Policy",), COMPANY, ["Operations", "Risk & Compliance"], 0.6),
    # Microsoft
    _agent("T_7001", "Researcher", "microsoft", ("Research & Analysis",), "Microsoft", pop=4),
    _agent("T_7002", "Analyst", "microsoft", ("Data & Reporting",), "Microsoft", pop=2),
    # Cowork and Scout are picked by their own share, not from favourites.
    _agent("T_4001", "Copilot Cowork", "cowork", ("General Chat",), "Microsoft"),
    _agent("T_5001", "Microsoft Scout", "scout", ("Research & Analysis", "Meeting Prep", "Email Triage", "Email Thread Summary"), "Microsoft"),
]
AGENT_BY_ID = {a["tid"]: a for a in AGENTS}
BLOCKED = {"T_2012"}                  # used early in the window, then blocked by an admin
WEAK_AGENTS = {"T_1004", "T_2003", "T_2008", "T_6003"}   # lower satisfaction, so ratings spread

KINDS = {
    #              hosts                         A365 type     Created in                            Supported in                                  Status             feedback type
    "declarative": ((_TEAMS, _M365),             "Shared",     "Microsoft 365 Copilot Agent Builder", "Microsoft 365 Copilot;Teams",                 "AcquiredForAll",  "DeclarativeAgent"),
    "sharepoint":  (("SharePoint", _TEAMS),      "Shared",     "SharePoint",                         "SharePoint;Microsoft 365 Copilot;Teams",      "AcquiredForSome", "DeclarativeAgent"),
    "studio":      (("Copilot Studio",),         "Shared",     "Copilot Studio",                     "Microsoft 365 Copilot;Teams;Copilot Studio",  "AcquiredForSome", "CustomEngineAgent"),
    "foundry":     ((_M365, _TEAMS),             "Shared",     "Azure AI Foundry",                   "Microsoft 365 Copilot;Teams",                 "AcquiredForSome", "CustomEngineAgent"),
    "autonomous":  (("Autonomous",),             "Shared",     "Copilot Studio",                     "Copilot Studio;Power Automate",               "AcquiredForSome", ""),
    "marketplace": ((_TEAMS, _M365),             "ThirdParty", "",                                   "Microsoft 365 Copilot;Teams",                 "AcquiredForAll",  "DeclarativeAgent"),
    "lob":         ((_TEAMS, _M365),             "LOB",        "",                                   "Microsoft 365 Copilot;Teams",                 "AcquiredForAll",  "DeclarativeAgent"),
    "microsoft":   ((_M365,),                    "FirstParty", "",                                   "Microsoft 365 Copilot",                       "AcquiredForAll",  "FirstPartyAgent"),
    "cowork":      (("Cowork",),                 "FirstParty", "",                                   "Microsoft 365 Copilot;Cowork",                "AcquiredForSome", "Cowork"),
    "scout":       (("Microsoft Scout",),        "FirstParty", "",                                   "Microsoft 365 Copilot;Scout",                 "AcquiredForSome", "Scout"),
}
# Kinds an unlicensed person can reach from free Copilot Chat (pay-as-you-go).
UNLICENSED_KINDS = {"declarative", "sharepoint", "marketplace"}
# Material an agent's answers are grounded in: (chance of material, pool).
AGENT_RESOURCES = {
    "declarative": (0.45, ["SitePageModern", "docx", "pdf", "aspx", "File"]),
    "sharepoint": (0.70, ["SitePageModern", "aspx", "docx", "pdf"]),
    "studio": (0.40, ["External", "External", "pdf", "docx", "xlsx"]),
    "foundry": (0.50, ["External", "xlsx", "csv", "pdf"]),
    "autonomous": (0.45, ["External", "xlsx", "EmailMessage", "pdf"]),
    "marketplace": (0.40, ["External", "External", "pdf"]),
    "lob": (0.40, ["External", "SitePageModern", "pdf"]),
    "T_7001": (0.85, ["docx", "pdf", "EmailMessage", "TeamsMessage", "pptx", "Event"]),
    "T_7002": (0.85, ["xlsx", "csv", "xlsx", "py"]),
    "scout": (0.85, ["EmailMessage", "Event", "TeamsMessage", "docx"]),
}

# Raw model names as the audit log carries them; AI_Model is derived by the
# processor. Cowork is where frontier models run; everything else is on
# workhorse models or logs none.
MODELS = {
    "copilot": [("gpt-5-chat", 85), ("claude-sonnet-4-5", 6), ("gpt-4.1", 2), ("", 7)],
    "embedded": [("", 70), ("gpt-5-chat", 27), ("claude-sonnet-4-5", 3)],
    "agent": [("gpt-5-chat", 86), ("", 10), ("claude-sonnet-4-5", 4)],
    "cowork": [("OPUS 5", 50), ("", 22), ("SONNET 5", 10), ("OPUS 4.8", 8), ("GPT-5", 6), ("GPT-6 ASTRA", 4)],
    "scout": [("gpt-5-chat", 85), ("", 15)],
}

# Copilot Cowork logs MIME types, plus an untyped "message" row for each
# message it reads. A session is planned as one of the work shapes the
# template grades, in roughly the mix real Cowork estates show.
_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
_PDF, _MAIL, _MD, _PNG = "application/pdf", "message/rfc822", "text/markdown", "image/png"
COWORK_SURFACES = [_XLSX, _DOCX, _PPTX, _PDF, _MAIL]
COWORK_SHAPES = [("read", 18), ("chat", 18), ("multi", 17), ("cross", 12), ("thin", 11),
                 ("single", 9), ("build", 8), ("moderate", 7)]
# Some people use Cowork mostly as a chat window, so the WHO table has people to flag.
COWORK_SHAPES_LIGHT = [("chat", 58), ("read", 12), ("single", 10), ("moderate", 8), ("multi", 7), ("thin", 5)]
COWORK_READS = [((1, 5), 49), ((6, 15), 17), ((16, 40), 30), ((41, 60), 4)]

COWORK_BEHAVIOURS = {
    "chat": ["General Chat"],
    "read": ["Email Thread Summary", "Email Triage", "Teams Messaging"],
    "thin": ["Document Drafting", "Research & Analysis", "Image Generation"],
    "single": ["Spreadsheet Analysis", "Document Summarising", "Presentation Creation"],
    "moderate": ["Research & Analysis", "Document Drafting"],
    "multi": ["Research & Analysis", "Data & Reporting", "Document Drafting"],
    "build": ["Code Writing", "Content Generation", "Running a Workflow"],
    "cross": ["Presentation Creation", "Running a Workflow", "Task Management", "Document Drafting"],
}
COWORK_PROMPTS = {
    "chat": ["Help me think through the options for the reorganisation",
             "What should I focus on this week?"],
    "read": ["Go through my unread mail and tell me what needs a reply",
             "Catch me up on the project channel since Monday"],
    "thin": ["Tidy up these notes into a short summary"],
    "single": ["Review this sales workbook and highlight anomalies"],
    "moderate": ["Pull the key points from these research notes"],
    "multi": ["Build a board paper from these notes and the budget workbook",
              "Research three competitors and write a comparison"],
    "build": ["Turn this data into a small web dashboard I can share",
              "Package these scripts and a readme into one bundle"],
    "cross": ["Plan the Q4 kickoff: agenda, invites and a briefing pack",
              "Send follow-ups and create tasks from today's meetings"],
}

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
    # Canonical registry extras (Get-Agents365Registry.ps1 / Fabric ingester).
    "Is Blocked", "Agent creator UPN", "Agent creator source",
]

# Microsoft 365 admin centre > Health > Product feedback export, verbatim headers.
# The template derives FeedbackDate from "Date Submitted UTC" (MM/dd/yyyy HH:mm:ss)
# and agent identity from "Additional Metadata"; the rest pass through unread.
FEEDBACK_COLS = [
    "Feedback Id", "Comment", "Translated Comment", "Comment Language",
    "Date Submitted UTC", "Feedback Type", "Microsoft Response Status", "App",
    "App Language", "Platform", "Source Type", "Logs, Attachments", "User Id",
    "User Email", "Browser", "Browser Version", "AI Context Prompt",
    "AI Context Response Message", "Survey Question", "Survey Response Option",
    "Additional Metadata",
]
FEEDBACK_SHARE = 0.045       # share of prompts in the window that get a thumbs up / down
FEEDBACK_HISTORY_MONTHS = 12  # months of feedback before the interaction window
FEEDBACK_APP = {
    "Microsoft Teams": "Teams", "Microsoft365Chat": "Microsoft 365 Copilot",
    "Microsoft Edge": "Edge", "Copilot Studio": "Microsoft 365 Copilot",
    "Cowork": "Microsoft 365 Copilot", "Microsoft Scout": "Microsoft 365 Copilot",
    "SharePoint": "SharePoint", "Autonomous": "Microsoft 365 Copilot",
}
# Survey-style feedback people leave outside a single prompt, with the real
# export's relative volumes (thumbs are drawn from prompts separately).
SURVEY_TYPES = [("NPS", 40), ("Idea", 14), ("Feature Survey", 10), ("Frown", 9),
                ("PSAT", 5), ("Bug", 4), ("Smile", 4), ("Unclassified", 1.5), ("NLQS", 1)]
NPS_QUESTION = "How likely are you to recommend Microsoft 365 Copilot to a friend or colleague?"
PSAT_QUESTION = "Overall, how satisfied are you with Microsoft 365 Copilot?"
PSAT_OPTIONS = ["Very dissatisfied", "Dissatisfied", "Neutral", "Satisfied", "Very satisfied"]
FEATURE_SURVEYS = [
    ("How useful was the meeting recap?", ["Very useful", "Somewhat useful", "Not useful"]),
    ("Did the summary capture what you needed?", ["Yes", "Partly", "No"]),
    ("How accurate was the draft?", ["Accurate", "Needed edits", "Inaccurate"]),
]
IDEAS = [
    "Let me schedule a prompt to run every Monday morning.",
    "Please support pinning favourite agents in Teams.",
    "It would help to cite the page number in long PDFs.",
    "Allow sharing a Copilot chat with my team.",
    "Add a way to set a default tone for email drafts.",
    "Remember the format I prefer for weekly reports.",
]
BUGS = [
    "The Excel formula it suggested returns a #VALUE error.",
    "The summary cut off halfway through the last section.",
    "Copilot pane would not load in Word this morning.",
    "It lost the attachment when I switched to another chat.",
]
SMILES = ["Loving the meeting recaps.", "The inbox catch-up is brilliant.",
          "Saved me an hour on the board pack."]
FROWNS = ["It keeps asking me to rephrase.", "Answers are too long.",
          "It couldn't find the file I know exists.", "Slow to respond this week."]

# Fabricated prompts. The template's FeedbackCategory buckets feedback by
# keywords in prompt + comment, so these are worded to land in a realistic
# spread of categories rather than all in "General".
BEHAVIOUR_PROMPTS = {
    "Email Drafting": ["Draft a reply to this email confirming Thursday's delivery",
                       "Write a polite follow-up email chasing the signed contract"],
    "Email Summarising": ["Summarise my unread emails from this morning"],
    "Email Triage": ["Which emails in my inbox need a reply today?"],
    "Email Thread Summary": ["Summarise this email thread and list the open questions"],
    "General Chat": ["Rewrite this paragraph so it is shorter and clearer",
                     "Give me three ideas for a team offsite agenda",
                     "Help me write a better prompt for summarising contracts"],
    "Document Drafting": ["Draft a one-page project brief for the new supplier portal",
                          "Draft an introduction for the quarterly business review"],
    "Document Summarising": ["Summarise this document in five bullet points",
                             "Summarise this project plan in five bullet points"],
    "Teams Messaging": ["Post a summary of this chat to the project channel in Teams"],
    "Meeting Prep": ["Prepare me for my Teams meeting with the account team"],
    "Enterprise Searching": ["Find the travel policy on SharePoint"],
    "Web Searching": ["What changed in the new EU AI Act guidance?",
                      "Search the web for security guidance on passkeys"],
    "Excel Assistance": ["Write an Excel formula to total sales by region"],
    "Spreadsheet Analysis": ["Find the trends in this spreadsheet and chart them"],
    "Spreadsheet Review": ["Check this budget sheet for errors"],
    "Presentation Creation": ["Generate five slides from this proposal"],
    "Presentation Summarising": ["Summarise this deck for someone who missed the meeting"],
    "Data Querying": ["Show last quarter's pipeline data by region"],
    "Code Writing": ["Write a Python function that validates postcodes"],
    "Code Analysis": ["Explain what this SQL query does",
                      "Why does this script throw an error on line 12?"],
    "PDF Analysis": ["Pull the key terms out of this PDF contract"],
    "Note Taking": ["Take notes from this Teams call and list the actions"],
    "Task Management": ["Create tasks in Planner from these meeting actions"],
    "File Retrieval": ["Find the most recent version of the pricing deck on OneDrive"],
    "Meeting Scheduling": ["Find a slot next week for a Teams call with Finance"],
    "People Lookup": ["Who owns supplier onboarding in Procurement?"],
    "SharePoint Access": ["Open the HR policies SharePoint site"],
    "Image Generation": ["Generate an image for the newsletter header"],
    "Form / Survey Work": ["Build a sign-up form for the training day"],
    "Video Summarising": ["Summarise the Teams recording of yesterday's town hall"],
    "Real-time Collaboration": ["Turn this Loop page into an action list"],
}
AGENT_PROMPTS = {
    "T_1001": ["How do I set up my payroll details?"],
    "T_1002": ["My laptop won't turn on after the update",
               "Outlook keeps freezing when I open attachments",
               "I'm locked out of my account after the password change"],
    "T_1003": ["Which accounts in my territory are at risk this quarter?"],
    "T_1004": ["What is the expense policy for client dinners?",
               "Can I work remotely from abroad for two weeks?"],
    "T_1005": ["Summarise competitor pricing moves this month"],
    "T_1006": ["Suggest a learning path to get better at data storytelling"],
    "T_1007": ["Build the month-end variance report for cost centre 204"],
    "T_1008": ["What are the warranty terms for the X200 range?"],
    "T_1009": ["Write a LinkedIn post announcing the new office"],
    "T_1010": ["Generate campaign ideas for the spring launch"],
    "T_1011": ["What health benefits am I eligible for?",
               "How does the wellbeing allowance work?"],
    "T_1012": ["Highlight risky clauses in this NDA"],
    "T_1013": ["How do I request a new laptop?"],
    "T_1014": ["Brief me on the Northwind account before tomorrow's meeting"],
    "T_1015": ["Draft a proposal for the Fabrikam renewal"],
    "T_1016": ["Write up the notes from the Teams call"],
    "T_1101": ["What is the parental leave policy?"],
    "T_1102": ["How do I set up the VPN on a new phone?"],
    "T_1103": ["What's our standard discount approval process?"],
    "T_1104": ["When is the quarter-end close deadline?"],
    "T_1105": ["What's the code review checklist?"],
    "T_2001": ["Open an incident for the VPN outage in Madrid",
               "What's the status of my ticket?"],
    "T_2002": ["Move the Contoso opportunity to stage 3"],
    "T_2003": ["Why is invoice 4471 on hold?"],
    "T_2004": ["Book two days of annual leave next week",
               "How much time off do I have left?"],
    "T_2005": ["Show open cases for the Tailspin account"],
    "T_2006": ["Show weekly case volumes as a chart"],
    "T_2007": ["What documents does a new supplier need to provide?"],
    "T_2008": ["Triage this claim and suggest next steps"],
    "T_2009": ["Which policy covers lone working on site?"],
    "T_2010": ["Which stores are below target on stock checks?"],
    "T_2011": ["Reschedule tomorrow's engineer visits in the north region"],
    "T_2012": ["How do I register a new partner deal?"],
    "T_2013": ["Draft an escalation summary for the Litware complaint"],
    "T_2014": ["Do I need three quotes for a 20k purchase?"],
    "T_2015": ["Summarise failed inspections on line 4 this week"],
    "T_2016": ["Where is shipment 88213?"],
    "T_2017": ["Find the design standard for pump housings"],
    "T_2018": ["Draft answers for section 3 of this tender"],
    "T_2101": ["What price should we quote for a 3-year renewal?"],
    "T_2102": ["Which contracts renew in the next 90 days?"],
    "T_2103": ["Forecast demand for the winter range"],
    "T_6001": ["Book me a train to Manchester on Tuesday"],
    "T_6002": ["Log this call against the Northwind account"],
    "T_6003": ["Find case law on late delivery penalties"],
    "T_6004": ["What are analysts saying about our sector?"],
    "T_6101": ["What's the procedure for a site shutdown?"],
    "T_6102": ["What's the list price for part 7781?"],
    "T_6103": ["Report a near miss at the Leeds depot"],
    "T_7001": ["Research the market for heat pumps in Ireland",
               "Write a briefing on the new data protection rules"],
    "T_7002": ["Analyse this sales extract and find the outliers"],
    "T_5001": ["What should I prioritise today?",
               "Brief me on today's meetings and unread email"],
}
FALLBACK_PROMPT = "Help me finish this piece of work"
POSITIVE_COMMENTS = [
    "Exactly what I needed.", "Saved me twenty minutes.", "Clear and well structured.",
    "Accurate, with the right sources.", "Much quicker than doing it by hand.",
    "Good starting point, needed only light edits.", "Great summary.",
]
NEGATIVE_COMMENTS = [
    "The answer was incorrect.", "It quoted a figure that isn't in the source.",
    "Too slow to respond.", "Missed the attachment I referenced.",
    "Too generic to be useful.", "It ignored half of my request.",
    "Cited an out-of-date policy.", "Kept asking me to rephrase.",
]

MATERIAL_SCALE = 0.55        # tunes how often a prompt touches typed material
UNLICENSED_WORKAROUNDS = [("Email Drafting", 4), ("Excel Assistance", 2), ("Meeting Prep", 1.5),
                          ("Code Writing", 1.5), ("Teams Messaging", 1),
                          ("Enterprise Searching", 1), ("Task Management", 0.5)]
UNLICENSED_WORKAROUND_SHARE = 0.16
UNLICENSED_UPLOADS = (0.15, ["pdf", "docx", "png", "txt"])


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def pick(rng: random.Random, pairs):
    """Weighted choice from [(value, weight), ...]."""
    return rng.choices([v for v, _ in pairs], [w for _, w in pairs])[0]


def draw(rng: random.Random, buckets) -> int:
    """An integer from [((lo, hi), weight), ...]."""
    lo, hi = pick(rng, buckets)
    return rng.randint(lo, hi)


def sample_weighted(rng: random.Random, items, weights, k):
    """k distinct items, weighted, without replacement."""
    keyed = sorted(zip(items, weights), key=lambda iw: -(rng.random() ** (1.0 / iw[1])))
    return [i for i, _ in keyed[:k]]


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def month_windows(end: date, months: int):
    """[(first_day, last_day), ...] oldest first, the last one ending on `end`."""
    out, first = [], end.replace(day=1)
    for _ in range(months):
        last = first.replace(day=calendar.monthrange(first.year, first.month)[1])
        out.append((first, min(last, end)))
        first = (first - timedelta(days=1)).replace(day=1)
    return out[::-1]


def pick_days(rng: random.Random, days, n):
    """n distinct days from `days`, heavily weighted towards weekdays."""
    if n <= 0 or not days:
        return []
    w = [WEEKEND_WEIGHT if d.weekday() >= 5 else 1.0 for d in days]
    return sorted(sample_weighted(rng, days, w, n))


def slug(s: str) -> str:
    s = s.lower().replace("&", "and").replace(" ", "-")
    return "".join(ch for ch in s if ch.isalnum() or ch == "-")


# --------------------------------------------------------------------------
# Directory: CEO > heads of organisation > team leads > staff
# --------------------------------------------------------------------------
def build_users(n: int, rng: random.Random):
    total_w = sum(o[1] for o in ORGS)
    sizes = [max(2, round(n * o[1] / total_w)) for o in ORGS]
    sizes[1] += n - sum(sizes)              # rounding lands in the largest organisation
    names = [(f, l) for f in FIRST for l in LAST]
    rng.shuffle(names)
    users = []

    def person(org, title, manager, level):
        first, last = names[len(users)]
        city, cc = CITIES[0] if level <= 1 else rng.choice(CITIES)
        u = {"idx": len(users) + 1, "org": org, "title": title, "manager": manager,
             "level": level, "given": first, "surname": last,
             "display": f"{first} {last}",
             "upn": f"{first}.{last}@{DOMAIN}".lower(),
             "city": city, "country": cc}
        users.append(u)
        return u

    ceo = None
    for (org, _, cov, eng), size in zip(ORGS, sizes):
        head_t, lead_t, staff_t = TITLES[org]
        if ceo is None:
            head = ceo = person(org, head_t, None, 0)
        else:
            head = person(org, head_t, ceo, 1)
        rest = size - 1
        n_leads = 0 if rest < 5 else max(1, round(rest / 8))
        leads = [person(org, lead_t, head, head["level"] + 1) for _ in range(n_leads)]
        for i in range(rest - n_leads):
            mgr = leads[i % n_leads] if leads else head
            person(org, rng.choice(staff_t), mgr, mgr["level"] + 1)

    org_meta = {o[0]: o for o in ORGS}
    for u in users:
        _, _, cov, eng = org_meta[u["org"]]
        is_lead = u["level"] <= 2 and any(x["manager"] is u for x in users)
        u["licensed"] = u is ceo or rng.random() < min(1.0, cov + (0.2 if is_lead else 0.0))
        if u["licensed"]:
            tw = dict(TIER_WEIGHTS)
            tw["power"] *= eng * eng
            tw["habitual"] *= eng
            for k in ("beginner", "lapsed", "never"):
                tw[k] /= eng
            u["tier"] = pick(rng, list(tw.items()))
        else:
            u["tier"] = "unlicensed"
        u["active"] = u["licensed"] or rng.random() < 0.68
        u["cowork"] = u["licensed"] and rng.random() < 0.30 * eng
        u["cowork_light"] = u["cowork"] and rng.random() < 0.3
        u["scout"] = u["licensed"] and rng.random() < 0.22 * eng

        pool = [a for a in AGENTS
                if a["kind"] not in {"cowork", "scout"}
                and (a["orgs"] is None or u["org"] in a["orgs"])
                and (u["licensed"] or a["kind"] in UNLICENSED_KINDS)]
        k = pick(rng, [(1, 25), (2, 35), (3, 25), (4, 15)])
        fav = sample_weighted(rng, pool, [a["pop"] * (3 if a["orgs"] else 1) for a in pool], k)
        u["fav"] = fav

    for u in users:
        u["direct"] = [x for x in users if x["manager"] is u]
    for u in reversed(users):               # children are created after their manager
        u["total"] = len(u["direct"]) + sum(x["total"] for x in u["direct"])
    return users


# --------------------------------------------------------------------------
# Activity calendar
# --------------------------------------------------------------------------
def plan_days(u, months, rng: random.Random):
    """The days one person used Copilot, across the whole window."""
    tier = u["tier"]
    if tier == "never" or not u["active"]:
        return []
    out = []
    end = months[-1][1]
    for k, (first, last) in enumerate(months):
        age = len(months) - 1 - k           # 0 = the latest month
        days = [first + timedelta(i) for i in range((last - first).days + 1)]
        if tier == "unlicensed":
            if rng.random() > (0.8 if age == 0 else 0.62):
                continue
            n = draw(rng, UNLICENSED_DAYS)
        elif tier == "lapsed":
            # Last seen 30-90+ days before the window ends.
            days = [d for d in days if d <= end - timedelta(days=32)]
            if age == 0 or not days or (age == 1 and rng.random() < 0.5):
                continue
            n = rng.randint(3, 10) if age >= 2 else rng.randint(1, 5)
        else:
            lo, hi = TIER_DAYS[tier]
            n = rng.randint(lo, hi)
            if age:
                if tier == "beginner" and rng.random() < 0.3 * age:
                    continue                # newer adopters
                n = round(n * rng.uniform(*((0.5, 0.9) if age == 1 else (0.3, 0.7))))
        chosen = pick_days(rng, days, n)
        # Power users are in on the window's last day, so the latest month
        # counts as complete for the habit bands.
        if tier == "power" and age == 0 and last.weekday() < 5 and last not in chosen:
            chosen = sorted(chosen[1:] + [last])
        out.extend(chosen)
    return out

# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------
HOST_BEHAVIOURS = {}
for _b, _w in WEIGHTS.items():
    for _h, _hw in BEHAVIOUR_HOSTS.get(_b, DEFAULT_HOSTS):
        HOST_BEHAVIOURS.setdefault(_h, []).append((_b, _w * _hw))


def resource(rng: random.Random, rtype: str, site: str, action: str = ""):
    """One AccessedResource row: (type, action, site url, resource sensitivity label)."""
    url = ""
    if rtype in SITE_TYPES:
        url = f"{SP_ROOT}/{site}"
    elif rtype == HYPERLINK:
        url = rng.choice(WEB_SITES) if rng.random() < 0.7 else f"{SP_ROOT}/{site}"
    if not action and rtype and rtype not in {"CITATION", HYPERLINK, "WebSearchQuery", "People"}:
        action = "Read"
    label = SENSITIVITY_LABELS[1] if rtype in SITE_TYPES and rng.random() < 0.04 else ""
    return (rtype, action, url, label)


def prompt_rows(rng: random.Random, behaviour: str, spec, site: str, action: str = ""):
    """Resource rows for one non-Cowork prompt (always at least one row)."""
    chance, pool = spec
    n = draw(rng, ROWS_PER_PROMPT)
    material = rng.random() < chance * MATERIAL_SCALE
    rows = []
    for i in range(n):
        if i == 0:
            if material:
                t = rng.choice(pool)
            elif behaviour == "Web Searching":
                t = "WebSearchQuery"
            elif behaviour == "People Lookup":
                t = "People"
            else:
                t = "CITATION" if n > 1 else ""
        else:
            r = rng.random()
            t = rng.choice(pool) if material and r < 0.3 else "CITATION" if r < 0.62 else HYPERLINK
        rows.append(resource(rng, t, site, action if i == 0 else ""))
    return rows


def cowork_types(rng: random.Random, shape: str):
    """Every resource type a Cowork session touches, as one flat list."""
    other = [_MD, _PNG, "text/plain"]
    if shape == "chat":
        return []
    if shape == "read":
        return ["message"] * draw(rng, COWORK_READS)
    if shape == "thin":
        return [rng.choice(other)] * rng.randint(1, 2)
    if shape == "single":
        return [rng.choice(COWORK_SURFACES)] * rng.randint(1, 2)
    if shape == "moderate":
        return [rng.choice(other)] * rng.randint(3, 5) if rng.random() < 0.6 else rng.sample(other, 2)
    if shape == "multi":
        return ([rng.choice(COWORK_SURFACES)] * rng.randint(1, 2) + [_MD] * rng.randint(2, 3)
                + [_PNG] * rng.randint(0, 2))
    if shape == "build":
        art = rng.choice(["application/json", "text/html", "application/zip", "application/json"])
        return ([art] * rng.randint(1, 3) + [_MD] * rng.randint(0, 2)
                + ([rng.choice(COWORK_SURFACES)] if rng.random() < 0.4 else []))
    a, b = rng.sample(COWORK_SURFACES, 2)   # cross-app
    return [a] * rng.randint(1, 3) + [b] * rng.randint(1, 2) + [_MD] * rng.randint(0, 2)


def plan_session(u, d: date, hour: int, ramp: float, rng: random.Random, shares):
    """One conversation thread: tool, agent, model, prompts and their resources."""
    site = slug(u["org"])
    agent, kind, shape = None, "", ""
    if u["licensed"]:
        r = rng.random()
        cw = shares["cowork"] * ramp if u["cowork"] else 0.0
        sc = shares["scout"] * ramp if u["scout"] else 0.0
        if r < shares["agent"] and u["fav"]:
            agent = pick(rng, [(a, a["pop"]) for a in u["fav"]])
        elif shares["agent"] <= r < shares["agent"] + cw:
            agent = AGENT_BY_ID["T_4001"]
        elif shares["agent"] + cw <= r < shares["agent"] + cw + sc:
            agent = AGENT_BY_ID["T_5001"]
    elif u["fav"] and rng.random() < shares["unlicensed_agent"]:
        agent = pick(rng, [(a, a["pop"]) for a in u["fav"]])
    if agent and d > shares["retire"].get(agent["tid"], date.max):
        agent = None
    if agent:
        kind = agent["kind"]

    if kind == "cowork":
        group, turns = "cowork", TURNS["cowork"]
    elif kind:
        group, turns = ("scout" if kind == "scout" else "agent"), TURNS["agent"]
    else:
        group, turns = "copilot", TURNS["copilot"]
    n_prompts = 1 if kind == "autonomous" else draw(rng, turns)
    if kind == "scout":
        n_prompts = min(n_prompts, 3)
        hour = rng.randint(5, 22)
    elif kind == "autonomous":
        hour = rng.randint(0, 23)

    # Host and first behaviour.
    if not kind and not u["licensed"]:
        host = rng.choice(UNLICENSED_HOSTS)
    elif not kind:
        first_b = pick(rng, list(WEIGHTS.items()))
        host = pick(rng, BEHAVIOUR_HOSTS.get(first_b, DEFAULT_HOSTS))
    else:
        host = rng.choice(KINDS[kind][0])
    if not kind and host in EMBEDDED_HOSTS:
        group = "embedded"
    model = pick(rng, MODELS[group])

    ts = datetime(d.year, d.month, d.day, hour, rng.randint(0, 59), rng.randint(0, 59))
    prompts = []
    if kind == "cowork":
        shape = pick(rng, COWORK_SHAPES_LIGHT if u["cowork_light"] else COWORK_SHAPES)
        types = cowork_types(rng, shape)
        cut = sorted(rng.randint(0, len(types)) for _ in range(n_prompts - 1))
        chunks = [types[a:b] for a, b in zip([0] + cut, cut + [len(types)])]
        chunks.sort(key=len, reverse=True)  # the opening prompt does most of the work
        build_art = {"application/json", "text/html", "application/zip"}
        for chunk in chunks:
            rows = [resource(rng, t, site, "Create" if t in build_art else "Read") for t in chunk] \
                or [resource(rng, "", site)]
            for i, row in enumerate(rows):   # Cowork resources carry no site url
                rows[i] = (row[0], row[1], "", row[3])
            prompts.append({"ts": ts, "behaviour": rng.choice(COWORK_BEHAVIOURS[shape]),
                            "host": host, "rows": rows})
            ts += timedelta(minutes=rng.randint(2, 12), seconds=rng.randint(0, 59))
        return {"user": u, "agent": agent, "kind": kind, "model": model, "shape": shape,
                "prompts": prompts}

    behaviour = None
    for i in range(n_prompts):
        if kind:
            behaviour = rng.choice(agent["beh"])
            spec = AGENT_RESOURCES.get(agent["tid"]) or AGENT_RESOURCES.get(kind, (0.4, ["docx"]))
            if not u["licensed"]:
                spec = UNLICENSED_UPLOADS
        elif not u["licensed"]:
            if behaviour is None or rng.random() > 0.6:
                behaviour = (pick(rng, UNLICENSED_WORKAROUNDS)
                             if rng.random() < UNLICENSED_WORKAROUND_SHARE
                             else rng.choices(UNLICENSED_PLAUSIBLE, UNLICENSED_WEIGHTS)[0])
            spec = UNLICENSED_UPLOADS
        else:
            if behaviour is None:
                behaviour = first_b
            elif rng.random() > 0.55:
                behaviour = pick(rng, HOST_BEHAVIOURS.get(host, HOST_BEHAVIOURS[_M365]))
            spec = BEHAVIOUR_RESOURCES.get(behaviour, (0.1, ["docx"]))
        action = rng.choice(WORKFLOW_ACTIONS) if behaviour == "Running a Workflow" else ""
        prompts.append({"ts": ts, "behaviour": behaviour, "host": host,
                        "rows": prompt_rows(rng, behaviour, spec, site, action)})
        ts += timedelta(minutes=rng.randint(1, 6), seconds=rng.randint(0, 59))
    return {"user": u, "agent": agent, "kind": kind, "model": model, "shape": shape,
            "prompts": prompts}


def make_row(proc, u, ts: datetime, s, p, res, n_rows: int, sens_label: str):
    """One interaction row. Every derived column comes from the processor."""
    agent, kind, host, behaviour = s["agent"], s["kind"], p["host"], p["behaviour"]
    res_type, res_action, site_url, res_label = res
    d = ts.date()
    aname = agent["name"] if agent else ""
    # Copilot Cowork logs its agent name but no agent id; it links by name.
    tid = agent["tid"] if agent and kind != "cowork" else ""
    has_license_raw = "TRUE" if u["licensed"] else "FALSE"
    license_status = proc.compute_license_status(has_license_raw)
    environment = proc.compute_environment(PROFILE, has_license_raw, aname, tid, host)
    class_env = proc.compute_classifier_environment(PROFILE, environment, aname, host)
    behavior_enriched = proc.compute_behavior_enriched(PROFILE, behaviour, aname, class_env)
    behavior_full = proc.compute_behavior_enriched_full(behavior_enriched)
    is_sensitive = proc.compute_is_sensitive(sens_label, res_label)
    is_agent_activity = proc.compute_is_agent_activity(aname, tid, host, res_type)
    workflow_action = proc.compute_workflow_action(behavior_full, res_action, host)
    month = d.replace(day=1).isoformat()
    if kind:
        context = "agent"
    elif host in EMBEDDED_HOSTS:
        context = "file"
    elif behaviour in {"Meeting Prep", "Note Taking", "Video Summarising"}:
        context = "meeting"
    else:
        context = "chat"
    return {
        "CreationDate": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Audit_UserId": u["upn"],
        "AppHost": host,
        "Context_Type": context,
        "Message_Id": p["id"],
        "Message_isPrompt": "TRUE",
        "ModelTransparencyDetails_ModelName": s["model"],
        "AgentId": tid, "AgentName": aname,
        "Has license": has_license_raw,
        "AISystemPlugin_Id": "", "AISystemPlugin_Name": "",
        "Agent_TitleID": tid, "ThreadId": s["id"],
        "AccessedResource_Type": res_type,
        "AccessedResource_Action": res_action,
        "SensitivityLabelId": sens_label,
        "Behavior_Source": proc.compute_behavior_source(
            PROFILE, behaviour, class_env, aname, "", host),
        "Behavior_Enriched_Full": behavior_full,
        "AccessedResource_SiteUrl": site_url,
        "Behavior_Category": behaviour,
        "Value_Outcome": proc.compute_value_outcome(
            PROFILE, behavior_enriched, class_env, is_sensitive),
        "Behavior_Enriched": behavior_enriched,
        "AccessedResource_SensitivityLabelId": res_label,
        "WeekStart": week_start(d).isoformat(),
        "InteractionDate": d.isoformat(),
        "MonthStart": month,
        "Usage_Mode": proc.compute_usage_mode(behavior_full, class_env, host),
        "Expertise_Role": proc.compute_expertise_role(behavior_full),
        "Efficiency_Breakdown": proc.compute_efficiency_breakdown(behavior_full, behaviour),
        "AppIdentity_AppId": "", "AppIdentity_DisplayName": host,
        "ApplicationName": host,
        "ActivityDate": d.isoformat(),
        "License Status": license_status,
        "Environment": environment,
        "Is_Sensitive": is_sensitive,
        "AI_Model": proc.compute_ai_model(s["model"]),
        "Autonomy_Pattern": proc.compute_autonomy_pattern(PROFILE, class_env, is_agent_activity),
        "UserMonthKey": proc.compute_user_month_key(u["upn"], month),
        "Web_Grounded_Signal": proc.compute_web_grounded_signal(res_type, site_url),
        "Behavior_Plausible": proc.compute_behavior_plausible(license_status, behaviour),
        "Workflow_Action": workflow_action,
        "Is_Agent_Activity": is_agent_activity,
        "Agent Filter": proc.compute_agent_filter(PROFILE, aname, host, is_agent_activity),
        "Agent Publish Status": proc.compute_agent_publish_status(tid, aname),
        "Resource_Count": n_rows,
        "Audit_UserKey": u["upn"],
        "Workload": "Copilot",
        "ClientRegion": u["country"],
        "Delegation_Event_Key": proc.compute_delegation_event_key(
            u["upn"], d.isoformat(), aname, workflow_action, host),
        "Human_Baseline_Min": proc.compute_human_baseline_min(behavior_full),
        "UserKey": u["upn"],
        "Audit_UserId_Normalized": u["upn"],
        "Agent_EntraId": f"agt-{agent['tid'].lower()}" if kind in {"autonomous", "cowork", "scout"} else "",
        "_kind": kind, "_shape": s["shape"], "_tid": agent["tid"] if agent else "",
    }


def build_interactions(users, months, rng: random.Random, proc, shares):
    start, end = months[0][0], months[-1][1]
    span = max((end - start).days, 1)
    sessions = []
    for u in users:
        for d in plan_days(u, months, rng):
            ramp = 0.4 + 0.6 * (d - start).days / span   # Cowork and Scout grow over the window
            for hour in sorted(pick(rng, HOURS) for _ in range(pick(rng, TIER_SESSIONS[u["tier"]]))):
                sessions.append(plan_session(u, d, hour, ramp, rng, shares))

    sessions.sort(key=lambda s: (s["prompts"][0]["ts"], s["user"]["idx"]))
    rows, n_msg = [], 0
    for i, s in enumerate(sessions, 1):
        s["id"] = f"thr-{i:06d}"
        for p in s["prompts"]:
            n_msg += 1
            p["id"] = f"msg-{n_msg:07d}"
            # A small share of prompts touch labelled content, so the
            # sensitivity visuals have something to show.
            sens = SENSITIVITY_LABELS[0] if rng.random() < 0.04 else ""
            for res in p["rows"]:
                rows.append(make_row(proc, s["user"], p["ts"], s, p, res, len(p["rows"]), sens))
    rows.sort(key=lambda r: r["CreationDate"])
    return rows, sessions

# --------------------------------------------------------------------------
# Users file
# --------------------------------------------------------------------------
def chain_of(u):
    chain = []
    while u is not None:
        chain.append(u)
        u = u["manager"]
    return chain[::-1]


def user_rows(users):
    total = len(users)
    out = []
    for u in users:
        mgr, chain = u["manager"], chain_of(u)
        r = {c: "" for c in USER_COLS}
        r.update({
            "Organization": u["org"], "PersonId": u["upn"],
            "PersonId_Normalized": u["upn"], "TotalEmployees": total,
            "country": u["country"], "displayName": u["display"],
            "surname": u["surname"], "mail": u["upn"], "givenName": u["given"],
            "id": f"00000000-0000-0000-0000-{u['idx']:012d}", "userType": "Member",
            "JobTitle": u["title"], "accountEnabled": "TRUE",
            "usageLocation": u["country"], "city": u["city"],
            "officeLocation": f"{u['city']} Office", "companyName": COMPANY,
            "creationType": "", "directorySynced": "TRUE",
            "createdDateTime": "2024-01-15T09:00:00Z",
            "Has license": "Yes" if u["licensed"] else "No",
            "UserKey": u["upn"],
            "License Status": "Licensed" if u["licensed"] else "Unlicensed",
            "assignedLicenses": "Microsoft 365 E5;Microsoft 365 Copilot" if u["licensed"] else "Microsoft 365 E5",
            "employeeType": "Employee", "employeeId": f"E{u['idx']:05d}",
            "BusinessAreaLabel": u["org"], "CountryofEmployment": u["country"],
            "CompanyCodeLabel": "CD01", "CostCentreLabel": f"CC-{slug(u['org'])[:6].upper()}",
            "OrgLevel": u["level"], "IsManager": "TRUE" if u["direct"] else "FALSE",
            "DirectReports": len(u["direct"]), "TotalReports": u["total"],
            "TopOfChain_UserKey": chain[0]["upn"],
            "HierarchyPath": " > ".join(x["display"] for x in chain),
        })
        for i, x in enumerate(chain):
            r[f"Level{i}_UserKey"], r[f"Level{i}_Name"] = x["upn"], x["display"]
        if mgr:
            r.update({
                "manager_id": f"00000000-0000-0000-0000-{mgr['idx']:012d}",
                "manager_displayName": mgr["display"],
                "manager_userPrincipalName": mgr["upn"], "manager_mail": mgr["upn"],
                "manager_jobTitle": mgr["title"], "ManagerID": mgr["upn"],
                "Manager_UserKey": mgr["upn"],
            })
        out.append(r)
    return out


# --------------------------------------------------------------------------
# Agents 365 registry
# --------------------------------------------------------------------------
# Registry entries nobody used in the window, so every Agent Lifecycle state
# has something to show. (title id, name, kind, state):
#   deployed     acquired for users, not used yet   -> "Deployed, not yet used"
#   noowner      built in the tenant, owner unknown -> "Tenant-built, no owner"
#   notdeployed  built in the tenant, owner known   -> "Tenant-built, not deployed"
#   catalogue    Microsoft / partner listing        -> "Catalogue listing"
REGISTRY_ONLY = [
    ("T_8001", "Travel Booking Agent", "declarative", "deployed"),
    ("T_8002", "Expense Assistant", "studio", "deployed"),
    ("T_8003", "Facilities Request Agent", "studio", "deployed"),
    ("T_8004", "Visitor Registration Agent", "declarative", "deployed"),
    ("T_8005", "Training Enrolment Agent", "sharepoint", "deployed"),
    ("T_8006", "Sustainability Reporting Agent", "foundry", "deployed"),
    ("T_8007", "Grant Application Agent", "studio", "deployed"),
    ("T_8101", "My Research Helper", "declarative", "noowner"),
    ("T_8102", "Weekly Report Writer", "declarative", "noowner"),
    ("T_8103", "Copy of IT Helpdesk Agent", "declarative", "noowner"),
    ("T_8104", "Test Agent", "declarative", "noowner"),
    ("T_8105", "Project Falcon Site Agent", "sharepoint", "noowner"),
    ("T_8106", "Q3 Planning Helper", "declarative", "noowner"),
    ("T_8107", "Email Tone Checker", "declarative", "noowner"),
    ("T_8108", "Team Wiki Agent", "sharepoint", "noowner"),
    ("T_8109", "Budget Bot", "studio", "noowner"),
    ("T_8110", "Customer FAQ Prototype", "studio", "noowner"),
    ("T_8111", "Translation Helper", "declarative", "noowner"),
    ("T_8112", "Proposal Checker", "declarative", "noowner"),
    ("T_8113", "Meeting Minutes Helper", "declarative", "noowner"),
    ("T_8114", "Store Wiki Agent", "sharepoint", "noowner"),
    ("T_8115", "Pricing Model Test", "foundry", "noowner"),
    ("T_8116", "Policy Q&A (old)", "declarative", "noowner"),
    ("T_8117", "Interview Question Helper", "declarative", "noowner"),
    ("T_8118", "Sales Call Prep", "declarative", "noowner"),
    ("T_8201", "Draft Pricing Agent", "studio", "notdeployed"),
    ("T_8202", "Pilot Claims Summariser", "studio", "notdeployed"),
    ("T_8203", "Supplier Risk Scanner", "foundry", "notdeployed"),
    ("T_8204", "New Joiner Guide", "declarative", "notdeployed"),
    ("T_8205", "Warehouse Safety Agent", "studio", "notdeployed"),
    ("T_8206", "Board Pack Assistant", "declarative", "notdeployed"),
    ("T_8301", "Adatum Expense Scanner", "marketplace", "catalogue"),
    ("T_8302", "Proseware Translator", "marketplace", "catalogue"),
    ("T_8303", "Wingtip Survey Builder", "marketplace", "catalogue"),
    ("T_8304", "Woodgrove Finance Assistant", "marketplace", "catalogue"),
    ("T_8305", "Relecloud Travel Planner", "marketplace", "catalogue"),
    ("T_8306", "Alpine Events Booking", "marketplace", "catalogue"),
    ("T_8307", "Coho Wine Guide", "marketplace", "catalogue"),
    ("T_8308", "Trey Research Insights", "marketplace", "catalogue"),
    ("T_8401", "Prompt Coach", "microsoft", "catalogue"),
    ("T_8402", "Writing Coach", "microsoft", "catalogue"),
    ("T_8403", "Idea Coach", "microsoft", "catalogue"),
    ("T_8404", "Visual Creator", "microsoft", "catalogue"),
    ("T_8405", "Skills Agent", "microsoft", "catalogue"),
    ("T_8501", "Contoso Timesheets", "lob", "catalogue"),
    ("T_8502", "Contoso Parking", "lob", "catalogue"),
]
TENANT_KINDS = {"declarative", "sharepoint", "studio", "foundry", "autonomous"}


def agent_rows(users, rng: random.Random):
    """One registry row per agent: the estate that was used, then the rest."""
    makers = [u for u in users if u["licensed"] and u["org"] in {"IT", "Engineering", "Operations", "Sales", "HR", "Finance"}]
    it = [u for u in users if u["org"] == "IT"]
    entries = [(a["tid"], a["name"], a["kind"], "used", a["beh"][0], a["publisher"]) for a in AGENTS]
    entries += [(tid, name, kind, state, "General Assistance", COMPANY) for tid, name, kind, state in REGISTRY_ONLY]
    out = []
    for i, (tid, name, kind, state, beh, publisher) in enumerate(entries):
        _, a365, created_in, supported, status, _ = KINDS[kind]
        creator = rng.choice(it if kind == "lob" else makers)
        tenant = kind in TENANT_KINDS
        if state in {"notdeployed", "noowner", "catalogue"}:
            status = ""
        owned = tenant and state != "noowner"
        if kind in {"microsoft", "cowork", "scout"}:
            c_name, c_id = "Microsoft", ""
        elif kind == "marketplace":
            c_name, c_id = publisher if state == "used" else name.split()[0], ""
        elif state == "noowner":
            c_name, c_id = "", ""
        else:
            c_name, c_id = creator["display"], creator["upn"]
        primary = beh.replace("Agent: ", "").lower()
        custom_actions = rng.randint(3, 14) if kind in {"studio", "autonomous", "foundry"} else 0
        created = date(2025, 9, 1) + timedelta(days=(i * 37) % 330)
        r = {c: "" for c in AGENT_COLS}
        r.update({
            "Title ID": tid, "Agent name": name,
            "Agent creator": c_name, "Agent creator ID": c_id, "Creator Id": c_id,
            "Agent type (A365)": a365,
            "Agent description": {
                "declarative": f"Agent Builder agent for {primary} requests, grounded in Microsoft 365 content.",
                "sharepoint": f"SharePoint site agent answering {primary} questions from the site's content.",
                "studio": f"Copilot Studio agent for {primary}, published by {publisher}.",
                "foundry": f"Azure AI Foundry agent for {primary}, published to Microsoft 365 Copilot.",
                "autonomous": f"Autonomous agent that runs the {primary} workflow unattended.",
                "marketplace": f"Partner agent from the Agent Store for {primary}.",
                "lob": f"Line-of-business agent for {primary}, published by IT.",
                "microsoft": f"Microsoft agent for {primary}.",
                "cowork": "Copilot Cowork plans and carries out multi-step work across apps with human approval.",
                "scout": "Microsoft Scout proactive assistance, running under its own agent identity.",
            }[kind],
            "Version": "1.0.0" if state != "used" else f"1.{i % 4}.0",
            "Availability": "Everyone" if kind in {"declarative", "microsoft", "marketplace", "lob"} else "Specific groups",
            "Supported in": supported,
            "Created in": created_in,
            "Date created": f"{created.isoformat()}T10:00:00Z",
            "Last updated": f"{(created + timedelta(days=30 + i % 60)).isoformat()}T14:30:00Z",
            "Custom actions": custom_actions,
            "Custom action list": "; ".join(
                f"{slug(primary).split('-')[0]}_action_{n + 1}" for n in range(min(custom_actions, 3))),
            "Status": status,
            "Channel": {"studio": "Copilot Studio", "autonomous": "Power Automate", "foundry": "Azure AI Foundry",
                        "sharepoint": "SharePoint", "cowork": "Microsoft 365 Copilot",
                        "scout": "Microsoft Scout"}.get(kind, "Microsoft Teams"),
            "Sensitivity": "Confidential" if kind in {"studio", "autonomous", "foundry"} and i % 3 == 0 else "General",
            "Can read OneDrive files": "Yes" if kind in {"cowork", "scout"} or i % 3 == 0 else "No",
            "Can read Sharepoint sites and files": "Yes" if kind != "marketplace" else "No",
            "Can extend to Graph connector": "Yes" if kind in {"studio", "foundry"} else "No",
            "Graph connector details": f"{publisher} connector" if kind in {"studio", "foundry"} else "",
            "Can generate images using user prompt": "Yes" if i % 5 == 0 else "No",
            "Can use code interpreter": "Yes" if kind in {"studio", "foundry"} and i % 4 == 1 else "No",
            "Contains uploaded files": "Yes" if kind in {"declarative", "sharepoint"} and i % 2 == 0 else "No",
            "Can read OneDrive and Sharepoint items": "Yes" if kind != "marketplace" else "No",
            "Sharepoint sites": f"{SP_ROOT}/{slug(creator['org'])}" if kind == "sharepoint" else "",
            "Instructions": f"Answer {primary} questions and hand off when confidence is low." if tenant else "",
            "Environment Id": f"env-{i + 1:04d}" if kind in {"studio", "autonomous"} else "",
            "Bot Id": f"bot-{i + 1:04d}" if kind in {"studio", "autonomous"} else "",
            "Entra Agent ID": f"agt-{tid.lower()}" if kind in {"autonomous", "cowork", "scout"} else "",
            "Groups shared": rng.randint(1, 6) if status else 0,
            "Users shared": rng.randint(20, 260) if status else 0,
            "Is Blocked": "true" if tid in BLOCKED else "false",
            "Agent creator UPN": c_id,
            "Agent creator source": "ownerId" if owned else ("unattributed" if tenant else ""),
        })
        out.append(r)
    return out


# --------------------------------------------------------------------------
# Product feedback
# --------------------------------------------------------------------------
def _platform(rng, app):
    if app in {"Microsoft 365 Copilot", "Edge"}:
        return "Web"
    return rng.choice(["Windows", "Windows", "Web", "iOS", "Android"] if app == "Teams"
                      else ["Windows", "Windows", "Windows", "Mac", "Web"])


def _fb_row(rng, u, ts, ftype, app, comment="", prompt="", question="", option="", meta=None):
    platform = _platform(rng, app)
    web = platform == "Web"
    return {
        "Feedback Id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
        "Comment": comment,
        "Comment Language": "en" if comment else "",
        "Date Submitted UTC": ts.strftime("%m/%d/%Y %H:%M:%S"),
        "Feedback Type": ftype,
        "Microsoft Response Status": "Received" if ftype == "Bug" else "",
        "App": app,
        "App Language": "en-GB" if u["country"] in {"GB", "IE"} else "en-US",
        "Platform": platform,
        "Logs, Attachments": "Yes" if ftype == "Bug" else "",
        "User Id": f"00000000-0000-0000-0000-{u['idx']:012d}",
        "User Email": u["upn"],
        "Browser": rng.choice(["Edge", "Edge", "Chrome"]) if web else "",
        "Browser Version": "140.0" if web else "",
        "AI Context Prompt": prompt,
        "Survey Question": question,
        "Survey Response Option": option,
        "Additional Metadata": json.dumps(meta or {"UiHost": app}, separators=(",", ":")),
    }


def _thumbs(rng, u, ts, host, behaviour, agent):
    tid = agent["tid"] if agent else ""
    down_p = 0.55 if tid in WEAK_AGENTS else 0.40 if not u["licensed"] else 0.33
    up = rng.random() >= down_p
    comment = ""
    if rng.random() < (0.40 if up else 0.65):
        comment = rng.choice(POSITIVE_COMMENTS if up else NEGATIVE_COMMENTS)
    prompt = rng.choice(AGENT_PROMPTS.get(tid) or BEHAVIOUR_PROMPTS.get(behaviour) or [FALLBACK_PROMPT])
    if agent and agent["kind"] == "cowork":
        prompt = rng.choice(COWORK_PROMPTS["cross"] + COWORK_PROMPTS["multi"])
    meta = {"UiHost": host}
    if agent:
        if agent["kind"] in {"studio", "foundry"}:
            meta.update({"copilotType": "custom", "essAgentId": tid})
        meta["aiAgents"] = [{"Name": agent["name"], "Type": KINDS[agent["kind"]][5] or "Agent"}]
    return _fb_row(rng, u, ts, "Thumbs Up" if up else "Thumbs Down",
                   FEEDBACK_APP.get(host, host), comment, prompt, meta=meta)


def _survey(rng, u, ts):
    ftype = pick(rng, SURVEY_TYPES)
    app = rng.choice(["Microsoft 365 Copilot", "Teams", "Outlook", "Word", "Excel"])
    if ftype == "NPS":
        score = pick(rng, [((9, 10), 38), ((7, 8), 37), ((0, 6), 25)])
        score = rng.randint(*score)
        comment = rng.choice(SMILES if score >= 9 else FROWNS) if rng.random() < 0.3 else ""
        return _fb_row(rng, u, ts, ftype, app, comment, question=NPS_QUESTION, option=str(score))
    if ftype == "PSAT":
        return _fb_row(rng, u, ts, ftype, app, question=PSAT_QUESTION,
                       option=pick(rng, list(zip(PSAT_OPTIONS, [5, 8, 20, 42, 25]))))
    if ftype == "Feature Survey":
        q, opts = rng.choice(FEATURE_SURVEYS)
        return _fb_row(rng, u, ts, ftype, app, question=q, option=pick(rng, list(zip(opts, [55, 30, 15]))))
    if ftype == "NLQS":
        return _fb_row(rng, u, ts, ftype, app, question="Did Copilot understand your question?",
                       option=rng.choice(["Yes", "Yes", "No"]))
    comment = {"Idea": IDEAS, "Bug": BUGS, "Smile": SMILES, "Frown": FROWNS}.get(ftype)
    return _fb_row(rng, u, ts, ftype, app, rng.choice(comment) if comment else "")


def feedback_rows(users, sessions, months):
    """Admin centre product-feedback export.

    Thumbs up / down are tied to real sample prompts (same person, same app or
    agent, a few minutes later). Survey-style feedback (NPS, PSAT, ideas, bugs
    ...) comes from anyone licensed, and both run back FEEDBACK_HISTORY_MONTHS
    before the interaction window so the monthly trend has a history.
    Drawn from its own RNG, so feedback never disturbs the other three files.
    """
    rng = random.Random(SEED + 2)
    out = []
    for s in sessions:
        if s["kind"] == "autonomous":
            continue                         # nobody is there to rate it
        for p in s["prompts"]:
            if rng.random() < FEEDBACK_SHARE:
                ts = p["ts"] + timedelta(minutes=rng.randint(1, 15), seconds=rng.randint(0, 59))
                out.append(_thumbs(rng, s["user"], ts, p["host"], p["behaviour"], s["agent"]))

    licensed = [u for u in users if u["licensed"]]
    first = months[0][0]
    n_hist = FEEDBACK_HISTORY_MONTHS
    for k in range(n_hist + len(months)):
        m_first = first
        for _ in range(n_hist - k):
            m_first = (m_first - timedelta(days=1)).replace(day=1)
        if k > n_hist:
            m_first = months[k - n_hist][0]
        m_last = m_first.replace(day=calendar.monthrange(m_first.year, m_first.month)[1])
        days = [m_first + timedelta(i) for i in range((m_last - m_first).days + 1)]
        growth = min(k, n_hist) / n_hist
        n_surveys = round(10 + 22 * growth)
        n_thumbs = round(18 + 40 * growth) if k < n_hist else 0
        for _ in range(n_surveys):
            d = pick_days(rng, days, 1)[0]
            ts = datetime(d.year, d.month, d.day, pick(rng, HOURS), rng.randint(0, 59), rng.randint(0, 59))
            out.append(_survey(rng, rng.choice(licensed), ts))
        for _ in range(n_thumbs):
            d = pick_days(rng, days, 1)[0]
            ts = datetime(d.year, d.month, d.day, pick(rng, HOURS), rng.randint(0, 59), rng.randint(0, 59))
            u = rng.choice(licensed)
            behaviour = pick(rng, list(WEIGHTS.items()))
            host = pick(rng, BEHAVIOUR_HOSTS.get(behaviour, DEFAULT_HOSTS))
            agent = rng.choice(u["fav"]) if u["fav"] and rng.random() < 0.25 else None
            if agent:
                host = rng.choice(KINDS[agent["kind"]][0])
            out.append(_thumbs(rng, u, ts, host, behaviour, agent))
    out.sort(key=lambda x: datetime.strptime(x["Date Submitted UTC"], "%m/%d/%Y %H:%M:%S"))
    return out

# --------------------------------------------------------------------------
# Output and a self-check of what the template will show
# --------------------------------------------------------------------------
def write_csv(path, cols, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})
    return os.path.getsize(path)


_MATERIAL = {"docx", "doc", "xlsx", "xlsm", "xls", "csv", "pptx", "ppt", "pdf", "txt", "md", "html",
             "htm", "json", "xml", "py", "zip", "png", "jpg", "jpeg", "gif", "mp4", "loop", "aspx",
             "sitepagemodern", "onepart", "page", "eml", "msg", "emailmessage", "teamsmessage",
             "event", "file", "external", "report"}
_BUILD_TOKENS = {"zip", "gz", "html", "htm", "json", "xml", "py", "ps1", "js", "ts", "ipynb", "sh"}
_SURFACES = [
    (("spreadsheetml", "ms-excel", "text/csv"), {"xlsx", "xlsm", "xls", "csv"}),
    (("wordprocessingml", "msword"), {"docx", "doc"}),
    (("presentationml", "ms-powerpoint"), {"pptx", "ppt"}),
    (("rfc822", "ms-outlook"), {"emailmessage", "eml", "msg", "event"}),
    (("application/pdf",), {"pdf"}),
    ((), {"teamsmessage"}),
]
STEP_GRADE = {1: "Strong fit", 2: "Strong fit", 3: "Strong fit", 4: "Worth a look", 5: "Fair fit",
              8: "Fair fit", 10: "Fair fit", 7: "Unclassified"}
STEP_SHAPE = {1: "Cross-app chain", 2: "Builds an artifact", 3: "Multi-source synthesis",
              4: "Chat only", 5: "Moderate sourcing", 8: "Read messages", 10: "Single-app task",
              7: "Not enough detail"}


def fit_step(rows):
    """Python replica of the template's Balanced 'Fit Rule Step' for one ThreadId."""
    cowork = rows[0]["Agent Filter"] == "Cowork"
    types = [r["AccessedResource_Type"].strip().lower() for r in rows]
    if cowork:
        mat = [t for t in types if t and t != "message"]
    else:
        mat = [t for t in types if t in _MATERIAL]
    m, b = len(mat), len(set(mat))
    tokens = set(types)
    blob = "|".join(tokens)
    surf = sum(1 for subs, toks in _SURFACES if any(s in blob for s in subs) or tokens & toks)
    build = any(s in blob for s in ("application/zip", "application/gzip", "octet-stream", "text/html",
                                    "application/json", "application/xml")) or bool(tokens & _BUILD_TOKENS)
    reads = types.count("message") if cowork else 0
    if surf >= 2:
        return 1
    if build:
        return 2
    if (m >= 3 and b >= 2) or m > 5:
        return 3
    if m == 0 and reads > 0:
        return 8
    if m == 0:
        return 4
    if b >= 2 or m >= 3:
        return 5
    return 10 if surf == 1 else 7


def model_tier(ai_model):
    m = ai_model.upper()
    if not m or "NO MODEL LOGGED" in m:
        return "Not attributed"
    if "OPUS" in m or "GPT-6" in m:
        return "Frontier"
    if any(k in m for k in ("SONNET", "CLAUDE", "GPT-5", "GPT-4")):
        return "Workhorse"
    return "Unclassified"


def _table(title, counts, total=None):
    total = total or sum(counts.values()) or 1
    print(f"  {title}")
    for k, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"    {str(k):<28} {n:>6,}  ({n / total:.1%})")
    print()


def report(inter, users, sessions, feedback, agents, months):
    from collections import Counter, defaultdict
    threads = defaultdict(list)
    for r in inter:
        threads[r["ThreadId"]].append(r)
    tool = lambda r: r["Agent Filter"] or "Copilot"
    grade, shape, tiers, fit, bands = Counter(), Counter(), Counter(), Counter(), Counter()
    for rows in threads.values():
        step = fit_step(rows)
        g = STEP_GRADE[step]
        grade[(tool(rows[0]), g)] += 1
        if rows[0]["Agent Filter"] == "Cowork":
            shape[STEP_SHAPE[step]] += 1
        order = ["Frontier", "Workhorse", "Unclassified", "Not attributed"]
        tier = min((model_tier(r["AI_Model"]) for r in rows), key=order.index)
        tiers[tier] += 1
        if g != "Unclassified" and tier in {"Frontier", "Workhorse"}:
            fit["Over-specified" if tier == "Frontier" and g == "Worth a look"
                else "Under-specified" if tier == "Workhorse" and g == "Strong fit" else "Well-matched"] += 1
        n = len(rows)
        bands["1 turn" if n == 1 else "2-3 turns" if n <= 3 else "4-6 turns" if n <= 6 else "7+ turns"] += 1

    last_first, last_end = months[-1]
    days = defaultdict(set)
    last_seen = {}
    for r in inter:
        d = date.fromisoformat(r["InteractionDate"])
        last_seen[r["Audit_UserId"]] = max(last_seen.get(r["Audit_UserId"], d), d)
        if last_first <= d <= last_end and r["License Status"] != "Unlicensed":
            days[r["Audit_UserId"]].add(d)
    habit = Counter()
    for n in (len(v) for v in days.values()):
        habit["Power (16+)" if n >= 16 else "Habitual (11-15)" if n >= 11
              else "Developing (6-10)" if n >= 6 else "Beginner (1-5)"] += 1
    dormancy = Counter()
    for u in users:
        if not u["licensed"]:
            continue
        seen = last_seen.get(u["upn"])
        gap = (last_end - seen).days if seen else None
        dormancy["Never active" if gap is None else "Active (<30d)" if gap < 30
                  else "Inactive 30-90d" if gap <= 90 else "Inactive 90+d"] += 1

    print(f"  window              : {inter[0]['InteractionDate']} -> {inter[-1]['InteractionDate']}")
    print(f"  people              : {len(users)} in {len({u['org'] for u in users})} organisations, "
          f"{sum(u['licensed'] for u in users)} licensed")
    print(f"  sessions / prompts  : {len(threads):,} / {len({r['Message_Id'] for r in inter}):,}")
    hours = sum(int(r["Human_Baseline_Min"]) for r in {r["Message_Id"]: r for r in inter}.values()
                if r["Human_Baseline_Min"]) / 60
    print(f"  raw hours modelled  : {hours:,.0f}")
    print()
    _table("sessions by tool", Counter(tool(rows[0]) for rows in threads.values()))
    _table("fit grade (tool, grade)", grade)
    _table("Cowork work shape", shape)
    cw = defaultdict(Counter)
    for rows in threads.values():
        if rows[0]["Agent Filter"] == "Cowork":
            g = STEP_GRADE[fit_step(rows)]
            if g != "Unclassified":
                cw[rows[0]["Audit_UserId"]][g] += 1
    flagged = sum(1 for c in cw.values() if c["Worth a look"] / sum(c.values()) >= 0.5)
    print(f"  Cowork people       : {len(cw)} graded, {flagged} flagged (half or more 'Worth a look')")
    print()
    _table("session model tier", tiers)
    _table("model fit (graded sessions)", fit)
    _table("session turn band (rows per thread)", bands)
    _table("habit band, licensed, latest month", habit)
    _table("dormancy, licensed", dormancy)
    _table("organisation (people)", Counter(u["org"] for u in users))
    _table("feedback type", Counter(f["Feedback Type"] for f in feedback))
    fb_months = {f["Date Submitted UTC"][6:10] + "-" + f["Date Submitted UTC"][:2] for f in feedback}
    print(f"  feedback months     : {len(fb_months)} ({min(fb_months)} -> {max(fb_months)})")
    used = {r["_tid"] for r in inter if r["_tid"]}
    print(f"  agents used         : {len(used)} of {len(agents)} registered")


def main():
    ap = argparse.ArgumentParser(description="Generate the ValueLens sample dataset.")
    ap.add_argument("--out", default=_HERE, help="output folder (default: alongside this script)")
    ap.add_argument("--end", type=date.fromisoformat,
                    default=date.today().replace(day=1) - timedelta(days=1),
                    help="last day of the window, YYYY-MM-DD (default: last day of last month)")
    ap.add_argument("--months", type=int, default=3, help="full months in the window")
    ap.add_argument("--users", type=int, default=170)
    ap.add_argument("--agent-share", type=float, default=0.20,
                    help="share of licensed sessions handled by agents")
    ap.add_argument("--cowork-share", type=float, default=0.20,
                    help="share of sessions handled by Copilot Cowork, for people who have it")
    ap.add_argument("--scout-share", type=float, default=0.08,
                    help="share of sessions handled by Microsoft Scout, for people who have it")
    ap.add_argument("--unlicensed-agent-share", type=float, default=0.18,
                    help="share of unlicensed sessions that use an agent")
    ap.add_argument("--quiet", action="store_true", help="skip the coverage report")
    a = ap.parse_args()

    proc = load_classifier()
    rng = random.Random(SEED)
    os.makedirs(a.out, exist_ok=True)
    months = month_windows(a.end, a.months)
    start = months[0][0]
    shares = {"agent": a.agent_share, "cowork": a.cowork_share, "scout": a.scout_share,
              "unlicensed_agent": a.unlicensed_agent_share,
              # Agents that stopped being used part-way through, so agent usage
              # review has cooling agents; the Partner Portal Agent was then blocked.
              "retire": {"T_2012": start + timedelta(days=34), "T_1013": start + timedelta(days=45),
                         "T_6003": start + timedelta(days=52)}}

    users = build_users(a.users, rng)
    inter, sessions = build_interactions(users, months, rng, proc, shares)
    agents = agent_rows(users, rng)
    feedback = feedback_rows(users, sessions, months)

    f1 = write_csv(os.path.join(a.out, "copilot_interactions_sample.csv"), INTERACTION_COLS, inter)
    f2 = write_csv(os.path.join(a.out, "copilot_users_sample.csv"), USER_COLS, user_rows(users))
    f3 = write_csv(os.path.join(a.out, "agents_365_sample.csv"), AGENT_COLS, agents)
    f4 = write_csv(os.path.join(a.out, "product_feedback_sample.csv"), FEEDBACK_COLS, feedback)

    print(f"sample data written to {a.out}")
    print(f"  copilot_interactions_sample.csv  {len(inter):>7,} rows  {f1 / 1024:>7,.0f} KB")
    print(f"  copilot_users_sample.csv         {len(users):>7,} rows  {f2 / 1024:>7,.0f} KB")
    print(f"  agents_365_sample.csv            {len(agents):>7,} rows  {f3 / 1024:>7,.0f} KB")
    print(f"  product_feedback_sample.csv      {len(feedback):>7,} rows  {f4 / 1024:>7,.0f} KB")
    print()
    if not a.quiet:
        report(inter, users, sessions, feedback, agents, months)


if __name__ == "__main__":
    main()
