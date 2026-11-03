"""Independent arithmetic over sanitized raw records; never imports the report engine."""
from __future__ import annotations

import calendar
import json
import math
import re
import statistics
import subprocess
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def verify(payload):
    raw = payload["fixture"]["sourceRecords"]
    orgs = {u["PersonId"]: u["Organization"] for u in raw["users"]}
    estimates = {e["behavior"]: e for e in payload["report"]["estimates"]}
    behavior_scope = {b["behavior"] for b in payload["report"]["behaviors"]}
    with (ROOT / "app" / "src" / "data" / "estimates.json").open(encoding="utf-8") as f:
        for entry in json.load(f):
            source = estimates[entry["behavior"]]
            for name in ("low", "typical", "high", "baseline"):
                assert float(source[name]) == entry[name], f"App/source estimate drift: {entry['behavior']} {name}"
            assert source["grain"] == entry["grain"]
    def groups(rows, key):
        result = defaultdict(list)
        for r in rows:
            result[key(r)].append(r)
        return result
    def count(rows, key):
        return len({key(r) for r in rows if key(r)})
    def mean(values):
        return statistics.mean(values) if values else None
    def feedback_date(record):
        value = record["Date Submitted UTC"]
        match = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", value)
        if match:
            month, day, year = map(int, match.groups())
            return date(year, month, day).isoformat()
        return value[:10]
    rows = []
    message_types = defaultdict(set)
    for record in raw["interactions"]:
        r = dict(record)
        r["prompt"] = r["Message_isPrompt"].strip().upper() in ("TRUE", "1")
        r["cowork"] = "cowork" in r["AppHost"].lower()
        r["usage"] = r["prompt"] or r["cowork"]
        r["tool"] = "Cowork" if r["cowork"] else "Agents" if r["AgentId"] or r["Is_Agent_Activity"].upper() in ("TRUE", "YES", "1") else "Copilot"
        r["org"] = orgs.get(r["Audit_UserId"], "")
        r["host"] = "Teams" if r["AppHost"] == "Microsoft Teams" else r["AppHost"]
        r["observed"] = r["prompt"] and all(r[k] for k in ("Audit_UserId", "ThreadId", "Message_Id"))
        message_types[r["Message_Id"]].add(r["AccessedResource_Type"].strip().lower())
        rows.append(r)
    def cowork_category(r):
        t = "|".join(sorted(message_types[r["Message_Id"]]))
        for label, terms in [
            ("Email workflows", ("rfc822", "ms-outlook")),
            ("Analysis & Research", ("spreadsheetml", "text/csv", "application/json", "application/xml", "application/pdf", "application/zip", "application/gzip")),
            ("Document & content creation", ("wordprocessingml", "presentationml", "ms-powerpoint", "text/markdown", "text/html", "image/")),
            ("Communication workflows", ("message",)),
        ]:
            if any(term in t for term in terms):
                return label
        return "General assistance / Other"
    materials = set("docx doc xlsx xlsm xls csv pptx ppt pdf txt md html htm json xml py zip png jpg jpeg gif mp4 loop aspx sitepagemodern onepart page eml msg emailmessage teamsmessage event file external report".split())
    thread_meta = {}
    for thread, records in groups(rows, lambda r: r["ThreadId"]).items():
        types = {r["AccessedResource_Type"].lower() for r in records}
        material = [r for r in records if (bool(r["AccessedResource_Type"]) and r["AccessedResource_Type"].lower() != "message") if r["cowork"]]
        material += [r for r in records if not r["cowork"] and r["AccessedResource_Type"].lower() in materials]
        m, b = len(material), len({r["AccessedResource_Type"] for r in material})
        surfaces = [
            any(any(term in t for term in ("spreadsheetml", "ms-excel", "text/csv")) or t in {"xlsx", "xlsm", "xls", "csv"} for t in types),
            any(any(term in t for term in ("wordprocessingml", "msword")) or t in {"docx", "doc"} for t in types),
            any(any(term in t for term in ("presentationml", "ms-powerpoint")) or t in {"pptx", "ppt"} for t in types),
            any(any(term in t for term in ("rfc822", "ms-outlook")) or t in {"emailmessage", "eml", "msg", "event"} for t in types),
            any(t in {"application/pdf", "pdf"} for t in types), "teamsmessage" in types,
        ]
        build = any(any(term in t for term in ("application/zip", "application/gzip", "octet-stream", "text/html", "application/json", "application/xml")) or t in {"zip", "gz", "html", "htm", "json", "xml", "py", "ps1", "js", "ts", "ipynb", "sh"} for t in types)
        step = 1 if sum(surfaces) >= 2 else 2 if build else 3 if m >= 3 and b >= 2 or m > 5 else 8 if m == 0 and "message" in types and any(r["cowork"] for r in records) else 4 if m == 0 else 5 if b >= 2 or m >= 3 else 10 if sum(surfaces) == 1 else 7
        grade = "Strong fit" if step in (1, 2, 3) else "Fair fit" if step in (5, 8, 9, 10) else "Worth a look" if step in (4, 6) else "Unclassified"
        models = [r["AI_Model"].upper() for r in records]
        tier = "frontier" if any("OPUS" in m or "GPT-6" in m for m in models) else "workhorse" if any(any(t in m for t in ("SONNET", "CLAUDE", "GPT-5", "GPT-4")) for m in models) else "missing"
        thread_meta[thread] = (grade, tier)
    for r in rows:
        r["category"] = cowork_category(r) if r["cowork"] else r["Behavior_Enriched_Full"]
    baseline = {}
    for behavior, rs in groups([r for r in rows if r["prompt"]], lambda r: r["Behavior_Enriched_Full"]).items():
        baseline[behavior] = len(rs) / max(1, count(rs, lambda r: r["Message_Id"]))
    bands = {"Analysis & Research": (30, 67, 92, 5), "Document & content creation": (12, 24, 42, 0), "Email workflows": (3, 7, 12, 4), "Meeting workflows": (12, 31, 43, 3), "Communication workflows": (2, 4, 11, 4), "Specialized workflows": (10, 25, 40, 0), "Write or debug code": (30, 56, 96, 6), "General assistance / Other": (2, 5, 8, 0)}
    def hours(rs, scenario="Typical"):
        result = 0
        for behavior, bs in groups([r for r in rs if r["prompt"] and not r["cowork"]], lambda r: r["Behavior_Enriched_Full"]).items():
            e = estimates.get(behavior)
            if e and behavior in behavior_scope:
                units = len(bs) / baseline[behavior] if e["grain"] == "Per Resource" else count(bs, lambda r: r["Message_Id"])
                result += float(e[{"Typical": "typical", "Conservative": "low", "Optimistic": "high"}[scenario]]) * units / 60
        for (_, category), cs in groups([r for r in rs if r["cowork"]], lambda r: (r["ThreadId"], r["category"])).items():
            band = bands[category]
            reads = sum(bool(r["AccessedResource_Type"]) and r["AccessedResource_Type"].lower() != "message" for r in cs)
            runs = max(1, round(reads / band[3])) if band[3] else 1
            result += runs * band[{"Conservative": 0, "Typical": 1, "Optimistic": 2}[scenario]] / 60
        return result
    def sessions(rs):
        return len({(r["Audit_UserId"], r["host"], r["ThreadId"]) for r in rs if r["observed"]})
    def active(rs):
        return count([r for r in rs if r["usage"]], lambda r: r["Audit_UserId"])
    def days(rs):
        return count(rs, lambda r: r["InteractionDate"])
    def metrics(rs, state):
        prompts = [r for r in rs if r["prompt"]]
        l = [r for r in rs if r["License Status"] == "M365 Copilot Licensed"]
        u = [r for r in rs if r["License Status"] == "Unlicensed"]
        ag = [r for r in rs if r["tool"] == "Agents"]
        cw = [r for r in rs if r["cowork"]]
        roster = [p for p in raw["users"] if state.get("team", -1) < 0 or p["Organization"] == payload["fixture"]["teams"][state["team"]]]
        licensed = sum(p["Has license"].lower() in ("yes", "true", "1") for p in roster)
        weekly = [sessions(week) / active(week) for week in groups(rs, lambda r: r["WeekStart"]).values() if active(week)]
        investment = 30 * sum(count(ms, lambda r: r["Audit_UserId"]) for ms in groups(l, lambda r: r["MonthStart"]).values())
        h = hours(rs)
        threads = {r["ThreadId"] for r in rs if r["ThreadId"]}
        judged = {t for t in threads if thread_meta[t][1] != "missing" and thread_meta[t][0] != "Unclassified"}
        over = {t for t in threads if thread_meta[t] == ("Worth a look", "frontier")}
        under = {t for t in threads if thread_meta[t] == ("Strong fit", "workhorse")}
        cwthreads = {r["ThreadId"] for r in cw if r["ThreadId"]}
        cwgraded = {t for t in cwthreads if thread_meta[t][0] != "Unclassified"}
        ever_cw = {r["Audit_UserId"] for r in rows if r["cowork"]}
        eligible = {r["Audit_UserId"] for r in prompts if r["Audit_UserId"] not in ever_cw}
        el = [r for r in rs if r["Audit_UserId"] in eligible]
        elp = [r for r in el if r["prompt"] and not r["cowork"]]
        breadth = [len({r["host"] for r in ds}) for ds in groups(elp, lambda r: (r["Audit_UserId"], r["InteractionDate"])).values()]
        first = payload["fixture"]["months"][state.get("from", 12)] + "-01"
        last_month = payload["fixture"]["months"][state.get("to", 14)]
        y, m = map(int, last_month.split("-"))
        last = f"{last_month}-{calendar.monthrange(y, m)[1]}"
        f = [x for x in raw["feedback"] if first <= feedback_date(x) <= last]
        result = {
            "AI Tasks": len(prompts), "All Active Users": active(rs), "Active Licensed Users": active(l), "Active Unlicensed Users": active(u),
            "Active Agent Users": count([r for r in ag if r["prompt"]], lambda r: r["Audit_UserId"]),
            "Licensed Users (Filter-Aware)": licensed, "Inactive Licensed Users (Filter-Aware)": licensed - active(l),
            "Observed Sessions": sessions(rs), "Observed Agent Sessions": sessions(ag), "Observed Cowork Sessions": sessions(cw),
            "Observed Sessions per User per Week": mean(weekly),
            "Expert Equivalent Hours": h, "AI Assisted Value": h * 50, "Copilot License Investment": investment, "Net ROI": h * 50 - investment,
            "Model: Sessions": len(threads), "Model: Well-matched Sessions": len(judged) - len(over) - len(under),
            "Model: Over-specified Sessions": len(over), "Model: Under-specified Sessions": len(under), "Model: Not Judged Sessions": len(threads) - len(judged),
            "Usage Efficiency: Consumption Sessions": len(cwthreads), "Usage Efficiency: Consumption Tasks": count([r for r in cw if r["prompt"]], lambda r: r["Message_Id"]),
            "Usage Efficiency: High Fit Share": len({t for t in cwgraded if thread_meta[t][0] == "Strong fit"}) / len(cwgraded) if cwgraded else None,
            "Cowork Fit: Eligible Users": len(eligible), "Cowork Fit: Session Depth": count([r for r in el if r["observed"]], lambda r: (r["Audit_UserId"], r["host"], r["ThreadId"], r["Message_Id"])) / sessions(el) if sessions(el) else None,
            "Cowork Fit: Surfaces Per Active Day": mean(breadth), "Cowork Fit: Agent User Share": count([r for r in el if r["prompt"] and r["tool"] == "Agents"], lambda r: r["Audit_UserId"]) / len(eligible) if eligible else None,
            "Total Feedback": len(f), "Satisfaction Rate": sum(x["Feedback Type"] == "Thumbs Up" for x in f) / len(f) if f else 0,
        }
        # Stage measures use the last complete month in the loaded audit window.
        maximum = max(r["InteractionDate"] for r in rows)
        maxdate = date.fromisoformat(maximum)
        month = maxdate.month if maxdate.day == calendar.monthrange(maxdate.year, maxdate.month)[1] else maxdate.month - 1
        month = min(month, 6 if state.get("to") == 12 else 8)
        mr = [r for r in rs if r["InteractionDate"].startswith(f"2026-{month:02d}")]
        counts = Counter(1 if days(us) <= 5 else 2 if days(us) <= 10 else 3 if days(us) <= 15 else 4 for us in groups(mr, lambda r: r["Audit_UserId"]).values())
        for i, stage in enumerate(("Beginner", "Developing", "Habitual", "Power"), 1):
            result[f"{stage} Users, Last Month"] = counts[i]
        if state.get("tool", -1) not in (1, 2) and state.get("license", -1) != 1:
            result["Inactive Users, Last Month"] = max(0, licensed - active([r for r in mr if r["License Status"] == "M365 Copilot Licensed"]))
        last_activity = {user: max(r["InteractionDate"] for r in us)
                         for user, us in groups(rows, lambda r: r["Audit_UserId"]).items()}
        audit_end = date.fromisoformat(max(r["InteractionDate"] for r in rows))
        span = (audit_end - date.fromisoformat(min(r["InteractionDate"] for r in rows))).days
        dormant_days = [(audit_end - date.fromisoformat(last_activity[p["PersonId"]])).days
                        if p["PersonId"] in last_activity else span
                        for p in roster if p["Has license"].lower() in ("true", "yes", "1")]
        result["Avg Days Since Last Active"] = mean(dormant_days) if licensed else None
        result["Licensed Inactive 30d+"] = sum(d >= 30 for d in dormant_days) if licensed else None
        return result
    def page_charts(selected, state):
        roster = [p for p in raw["users"] if state.get("team", -1) < 0 or p["Organization"] == payload["fixture"]["teams"][state["team"]]]
        teams = groups(selected, lambda r: r["org"])
        team_names = sorted({p["Organization"] for p in roster})
        inactive = {o: sum(p["Has license"].lower() in ("yes", "true", "1") for p in roster if p["Organization"] == o) -
                       active([r for r in teams.get(o, []) if r["License Status"] == "M365 Copilot Licensed"]) for o in team_names}
        lifecycle = Counter()
        for a in raw["agents"]:
            if state.get("agent", -1) > 0 and a["Agent name"] != payload["fixture"]["agents"][state["agent"]]:
                continue
            used = int(a["Total Users"]) > 0
            blocked = a["Is Blocked"].lower() in ("yes", "true", "1")
            tenant = a["Created in"].lower() not in ("", "not available")
            label = "Blocked by admin" if blocked else "In use" if used else "Deployed, not yet used" if a["Status"] and a["Status"].lower() != "acquiredfornone" else "Tenant-built, no owner" if tenant and a["Agent creator source"].lower() != "ownerid" else "Tenant-built, not deployed" if tenant else "Catalogue listing"
            lifecycle[label] += 1
        selected_weeks = count([r for r in rows if payload["fixture"]["months"][state.get("from", 12)] <= r["InteractionDate"][:7] <= payload["fixture"]["months"][state.get("to", 14)]], lambda r: r["WeekStart"])
        category_hours = {cat: hours(rs) / selected_weeks if selected_weeks else 0 for cat, rs in groups(selected, lambda r: r["category"]).items()}
        tool_well = {}
        for tool, rs in groups(selected, lambda r: r["tool"]).items():
            ts = {r["ThreadId"] for r in rs}
            judged = {t for t in ts if thread_meta[t][1] != "missing" and thread_meta[t][0] != "Unclassified"}
            tool_well[tool] = len(judged) - sum(thread_meta[t] == ("Worth a look", "frontier") for t in ts) - sum(thread_meta[t] == ("Strong fit", "workhorse") for t in ts)
        cat_grade = {}
        cw = [r for r in selected if r["cowork"] and thread_meta[r["ThreadId"]][0] != "Unclassified"]
        for cat, rs in groups(cw, lambda r: r["category"]).items():
            total = count(rs, lambda r: r["ThreadId"])
            for grade, gs in groups(rs, lambda r: thread_meta[r["ThreadId"]][0]).items():
                cat_grade[f"{cat} | {grade}"] = count(gs, lambda r: r["ThreadId"]) / total
        ever_cw = {r["Audit_UserId"] for r in rows if r["cowork"]}
        eligible = {o: count([r for r in rs if r["prompt"] and r["Audit_UserId"] not in ever_cw], lambda r: r["Audit_UserId"]) for o, rs in teams.items()}
        eligible = {o: n for o, n in eligible.items() if n > 0}
        # Dormancy is a calculated-column inventory distribution over the entire loaded audit window.
        last_activity = {user: max(r["InteractionDate"] for r in us) for user, us in groups(rows, lambda r: r["Audit_UserId"]).items()}
        audit_end = date.fromisoformat(max(r["InteractionDate"] for r in rows))
        dormant = dict.fromkeys(("Active (<30 days)", "Inactive 30-89 days", "Inactive 90-179 days", "Inactive 180+ days", "Never active"), 0)
        for p in roster:
            if p["Has license"].lower() not in ("yes", "true", "1"):
                continue
            last = last_activity.get(p["PersonId"])
            d = (audit_end - date.fromisoformat(last)).days if last else 0
            bucket = "Never active" if not last else "Active (<30 days)" if d < 30 else "Inactive 30-89 days" if d < 90 else "Inactive 90-179 days" if d < 180 else "Inactive 180+ days"
            dormant[bucket] += 1
        first = payload["fixture"]["months"][state.get("from", 12)] + "-01"
        final_month = payload["fixture"]["months"][state.get("to", 14)]
        fs = [f for f in raw["feedback"] if first <= feedback_date(f) and feedback_date(f)[:7] <= final_month]
        feedback_up = {m: sum(f["Feedback Type"] == "Thumbs Up" for f in records)
                       for m, records in groups(fs, lambda f: feedback_date(f)[:7] + "-01").items()}
        person_sessions = {f"{org} | {user}": sessions(rs) for (org, user), rs in groups(selected, lambda r: (r["org"], r["Audit_UserId"])).items()}
        heat = {f"{week} | {org}": active(rs) for (week, org), rs in groups(selected, lambda r: (r["WeekStart"], r["org"])).items()
                if hours(rs) > 0 and any(r["prompt"] for r in rs) and active(rs) > 0}
        priority = {}
        for user, rs in groups([r for r in selected if r["License Status"] == "Unlicensed" and r["prompt"]], lambda r: r["Audit_UserId"]).items():
            weeks = count(rs, lambda r: r["WeekStart"])
            priority[user] = math.floor(60 * min(len(rs) / weeks / 30, 1) + 40 * min(days(rs) / weeks / 5, 1) + .5)
        priority_ranks = {user: 1 + len({score for other, score in priority.items() if score > value}) for user, value in priority.items()}
        nested_priority_ranks = {f"{orgs[user]} | {user}": 1 + len({score for other, score in priority.items() if orgs[other] == orgs[user] and score > value}) for user, value in priority.items()}
        readiness_inputs = {}
        for user, rs in groups(selected, lambda r: r["Audit_UserId"]).items():
            if sessions([r for r in rs if r["cowork"]]) > 0:
                continue
            ps = [r for r in rs if r["prompt"] and not r["cowork"] and r["host"]]
            userdays = {(r["Audit_UserId"], r["InteractionDate"]) for r in ps}
            breadth = len({(r["Audit_UserId"], r["InteractionDate"], r["host"]) for r in ps}) / len(userdays) if userdays else 0
            noncowork = [r for r in rs if not r["cowork"]]
            depth = count([r for r in noncowork if r["observed"]], lambda r: (r["Audit_UserId"], r["host"], r["ThreadId"], r["Message_Id"])) / sessions(noncowork) if sessions(noncowork) else 0
            if breadth and depth:
                readiness_inputs[user] = (breadth, depth, int(sessions([r for r in rs if r["tool"] == "Agents"]) > 0))
        max_b = max((x[0] for x in readiness_inputs.values()), default=1)
        max_d = max((x[1] for x in readiness_inputs.values()), default=1)
        scores = {u: math.floor(45 * b / max_b + 35 * d / max_d + 20 * a + .5) for u, (b, d, a) in readiness_inputs.items()}
        readiness_ranks = {f"{orgs[user]} | {user}": 1 + len({v for other, v in scores.items() if orgs[other] == orgs[user] and v > score}) for user, score in scores.items() if user not in ever_cw}
        result = [
            {"page": 0, "dimension": "Organization", "measure": "Inactive Licensed Users (Filter-Aware)", "values": inactive},
            {"page": 3, "id": "01309d156775aee28225", "dimension": "Agent Lifecycle", "measure": "Agent Registry Records", "values": dict(lifecycle)},
            {"page": 5, "dimension": "Task Breakdown Category", "measure": "Expert Equivalent Hours Per Week", "values": category_hours},
            {"page": 6, "dimension": "Agent Filter (Normalized)", "measure": "Model: Well-matched Sessions", "values": tool_well},
            {"page": 7, "id": "cf_what", "dimensions": ["Cowork Task Category", "Work Weight Grade"], "measure": "Usage Efficiency: Task Grade Share", "values": cat_grade},
            {"page": 8, "dimension": "Organization", "measure": "Cowork Fit: Eligible Users", "values": eligible},
            {"page": 8, "id": "ae948a1bd70ed7073652", "dimensions": ["Organization", "Audit_UserId"], "measure": "Cowork Readiness Rank (Dynamic)", "values": readiness_ranks},
            {"page": 9, "dimension": "Dormancy Bucket", "measure": "Licensed Seats by Dormancy (Verified)", "values": dormant},
            {"page": 10, "dimension": "MonthStart", "measure": "Thumbs Up Count", "values": feedback_up},
            {"page": 11, "id": "504d4cf1a471deec4ed5", "dimensions": ["Organization", "Audit_UserId"], "measure": "Observed Sessions", "values": person_sessions},
            {"page": 12, "id": "1dc65c5770aac98559c3", "dimensions": ["WeekStart", "Organization"], "measure": "All Active Users", "values": heat},
            {"page": 15, "id": "vllpcandidates", "dimension": "Audit_UserId", "measure": "License Priority Score (User)", "values": priority},
            {"page": 15, "id": "vllpcandidates", "dimension": "Audit_UserId", "measure": "License Priority Rank (Dynamic)", "values": priority_ranks},
            {"page": 9, "id": "rd_lic_users", "dimensions": ["Organization", "Audit_UserId"], "measure": "License Priority Rank (Dynamic)", "values": nested_priority_ranks},
        ]
        # The registry lifecycle matrix's ID is selected by its source bindings, not the unrelated estate table.
        result[1]["id"] = next(v["id"] for v in payload["report"]["pages"][3]["visuals"] if any(f["name"] == "Agent Lifecycle" and f["role"] == "Rows" for f in v["fields"]))
        return result
    active_agents = Counter(r["AgentName"] for r in rows
                            if r["prompt"] and r["AgentName"] and "2026-06" <= r["InteractionDate"][:7] <= "2026-08")
    one_agent = payload["fixture"]["agents"].index(active_agents.most_common(1)[0][0])
    cases = []
    for name, state in [
        ("overall", {}), ("licensed", {"license": 0}), ("unlicensed", {"license": 1}),
        ("licensed Group 01", {"license": 0, "team": 0}), ("unlicensed Group 01", {"license": 1, "team": 0}),
        ("June only", {"to": 12}), ("agents", {"tool": 1}), ("Cowork", {"tool": 2}), ("one agent", {"agent": one_agent}),
        ("empty audit window", {"from": 0, "to": 0}),
    ]:
        selected = [r for r in rows if payload["fixture"]["months"][state.get("from", 12)] <= r["InteractionDate"][:7] <= payload["fixture"]["months"][state.get("to", 14)]
                    and (state.get("team", -1) < 0 or r["org"] == payload["fixture"]["teams"][state["team"]])
                    and (state.get("license", -1) < 0 or r["License Status"] == ("M365 Copilot Licensed" if state["license"] == 0 else "Unlicensed"))
                    and (state.get("tool", -1) < 0 or r["tool"] == payload["fixture"]["tools"][state["tool"]])
                    and (state.get("agent", -1) < 0 or r["AgentName"] == payload["fixture"]["agents"][state["agent"]])]
        behavior = Counter(r["Behavior_Enriched_Full"] for r in selected if r["prompt"])
        cases.append({"name": name, "state": state, "metrics": metrics(selected, state), "charts": page_charts(selected, state) + [
            {"page": 1, "dimension": "Behavior_Enriched_Full", "measure": "AI Tasks", "values": dict(behavior)},
            {"page": 4, "dimension": "Task Breakdown Category", "measure": "Activity Share",
             "values": {category: total / sum(r["prompt"] for r in selected)
                        for category, total in Counter(r["category"] for r in selected if r["prompt"]).items()}},
        ]})
    result = subprocess.run(["node", str(Path(__file__).with_name("test-engine.mjs"))],
                            input=json.dumps({"cases": cases, "scenarios": {s: hours(rows, s) for s in ("Conservative", "Typical", "Optimistic")}}, sort_keys=True),
                            encoding="utf-8", capture_output=True, check=False)
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    print(result.stdout.strip())
