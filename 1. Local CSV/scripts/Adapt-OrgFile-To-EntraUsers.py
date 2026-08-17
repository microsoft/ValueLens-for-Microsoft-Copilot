#!/usr/bin/env python3
"""
Adapt-OrgFile-To-EntraUsers.py
================================================================
Turns a CUSTOM org / HR export (any column names, any delimiter) into an
EntraUsers-shaped CSV that the bundled Purview_CopilotInteraction_Processor
(v4.0.0) accepts as its --entra input.

Why this exists
---------------
The standalone processor does NOT call PAX. It expects the --entra file to be
in PAX's *EntraUsers schema*: it auto-detects only a few column ALIASES and
joins to the audit log on **userPrincipalName**. A generic HR file (different
headers, employee-ID key, semicolon delimiter, UTF-16) is not recognised, so
the dashboard comes back blank or the run errors. This adapter renames/maps the
columns and (optionally) flattens the manager chain into the Level0..N
hierarchy that PAX would normally build, so org drill-down still works.

Pipeline:
    <custom org/HR export>  --[this adapter]-->  EntraUsers_adapted.csv
                                              |
                                              v
    Purview_CopilotInteraction_Processor_v4.0.0.py --purview <audit> \
        --entra EntraUsers_adapted.csv --profile aibv --out-dir <out>

CRITICAL: the value in --upn-col MUST be the same UPN that appears in the
Purview audit log (the UserId). If your HR file keys on employee ID or name,
add/translate a UPN column first (e.g. via an employeeId->UPN crosswalk) or the
users will not join and every interaction shows as unmatched.
"""
import argparse
import csv
import io
import re
import sys
from pathlib import Path

# Output column names the processor / PBIP expect (aliases it recognises).
OUT_UPN = "userPrincipalName"
OUT_DISPLAY = "displayName"
OUT_DEPT = "department"
OUT_TITLE = "jobTitle"
OUT_LICENSE = "hasLicense"           # exact processor-recognised license header
OUT_MGR_UPN = "manager_userPrincipalName"
OUT_MGR_NAME = "manager_displayName"

DEFAULT_TRUE = "yes,true,1,y,assigned,licensed,copilot,m365 copilot,has license,enabled"


def sniff_text(path: str) -> tuple[str, str]:
    """Return (text, delimiter). Handles BOM, UTF-8/16, and ,/;/tab/pipe."""
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "utf-16", "utf-16-le", "latin-1"):
        try:
            text = raw.decode(enc)
            if "\x00" not in text:           # bad utf-16 guess leaves nulls
                break
        except (UnicodeDecodeError, UnicodeError):
            continue
    else:
        text = raw.decode("utf-8", errors="replace")
    sample = text[:8192]
    try:
        delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        # fall back to the most common non-comma separator present
        counts = {d: sample.count(d) for d in [",", ";", "\t", "|"]}
        delim = max(counts, key=counts.get) or ","
    return text, delim


def norm(s: str) -> str:
    return re.sub(r"[\s_\-.()\[\]]", "", (s or "").lower())


def resolve_col(headers, wanted, auto_aliases):
    """Pick a column: explicit --x-col wins; else fuzzy match against aliases."""
    if wanted:
        for h in headers:
            if h == wanted or norm(h) == norm(wanted):
                return h
        sys.exit(f"ERROR: column '{wanted}' not found. Headers: {headers}")
        return None
    alias_norm = {norm(a) for a in auto_aliases}
    for h in headers:
        if norm(h) in alias_norm:
            return h
    return None


def build_hierarchy(rows, upn_key, mgr_key, name_key, max_levels):
    """Flatten the manager chain into Level0_Name..LevelN_Name + OrgLevel +
    HierarchyPath, mirroring PAX. Level0 = top of chain, deepest = the person.
    Cycle-safe. Returns dict upn_norm -> {col: value}."""
    by_upn = {}
    name_of = {}
    mgr_of = {}
    for r in rows:
        u = (r.get(upn_key) or "").strip().lower()
        if not u:
            continue
        by_upn[u] = r
        name_of[u] = (r.get(name_key) or r.get(upn_key) or "").strip() if name_key else u
        mgr_of[u] = (r.get(mgr_key) or "").strip().lower() if mgr_key else ""

    # direct-report counts
    direct = {u: 0 for u in by_upn}
    for u, m in mgr_of.items():
        if m and m in direct:
            direct[m] += 1

    out = {}
    for u in by_upn:
        chain = []
        seen = set()
        cur = u
        while cur and cur in by_upn and cur not in seen:
            seen.add(cur)
            chain.append(cur)
            cur = mgr_of.get(cur, "")
        chain = list(reversed(chain))        # top -> self
        rec = {}
        for i in range(max_levels + 1):
            rec[f"Level{i}_Name"] = name_of.get(chain[i], "") if i < len(chain) else ""
        rec["OrgLevel"] = str(len(chain) - 1)
        rec["HierarchyPath"] = " > ".join(name_of.get(c, c) for c in chain)
        rec["TopOfChain_Name"] = name_of.get(chain[0], "") if chain else ""
        rec["IsManager"] = "TRUE" if direct.get(u, 0) > 0 else "FALSE"
        rec["DirectReports"] = str(direct.get(u, 0))
        out[u] = rec
    return out


def main():
    ap = argparse.ArgumentParser(description="Adapt a custom org/HR export to EntraUsers schema for the AIBV processor.")
    ap.add_argument("--in", dest="infile", required=True, help="Path to the custom org/HR CSV.")
    ap.add_argument("--out", dest="outfile", required=True, help="Path to write the adapted EntraUsers CSV.")
    ap.add_argument("--upn-col", help="Column holding the UPN/email that matches the audit log. Auto-detected if omitted.")
    ap.add_argument("--license-col", help="Column holding the license indicator. Auto-detected if omitted.")
    ap.add_argument("--license-true-values", default=DEFAULT_TRUE,
                    help=f"Comma list of values meaning LICENSED (case-insensitive). Default: {DEFAULT_TRUE}")
    ap.add_argument("--display-col", help="Column holding display name. Optional.")
    ap.add_argument("--dept-col", help="Column holding department/org. Optional.")
    ap.add_argument("--title-col", help="Column holding job title. Optional.")
    ap.add_argument("--manager-col", help="Column holding the MANAGER's UPN/email. Enables org-hierarchy flattening.")
    ap.add_argument("--max-levels", type=int, default=14, help="Deepest LevelN to emit (default 14, mirrors PAX).")
    args = ap.parse_args()

    text, delim = sniff_text(args.infile)
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    headers = reader.fieldnames or []
    if not headers:
        sys.exit("ERROR: input has no header row.")
    rows = list(reader)

    upn = resolve_col(headers, args.upn_col, ["userprincipalname", "upn", "personid", "email", "mail", "emailaddress"])
    if not upn:
        sys.exit(f"ERROR: could not find a UPN/email column. Pass --upn-col. Headers: {headers}")
    lic = resolve_col(headers, args.license_col,
                      ["haslicense", "license", "licence", "copilotlicense", "hascopilotlicense", "licensed"])
    disp = resolve_col(headers, args.display_col, ["displayname", "fullname", "name"])
    dept = resolve_col(headers, args.dept_col, ["department", "organization", "organisation", "team", "division"])
    title = resolve_col(headers, args.title_col, ["jobtitle", "title", "role", "position"])
    mgr = resolve_col(headers, args.manager_col, ["managerupn", "manageremail", "manager", "manageruserprincipalname"]) if (args.manager_col or True) else None

    true_set = {v.strip().lower() for v in args.license_true_values.split(",") if v.strip()}

    hierarchy = {}
    if mgr:
        hierarchy = build_hierarchy(rows, upn, mgr, disp, args.max_levels)

    out_cols = [OUT_UPN, OUT_DISPLAY, OUT_DEPT, OUT_TITLE, OUT_MGR_UPN, OUT_MGR_NAME, OUT_LICENSE]
    hier_cols = []
    if mgr:
        hier_cols = (["OrgLevel", "HierarchyPath", "TopOfChain_Name", "IsManager", "DirectReports"]
                     + [f"Level{i}_Name" for i in range(args.max_levels + 1)])
    out_cols += hier_cols

    name_by_upn = {}
    if disp:
        for r in rows:
            u = (r.get(upn) or "").strip().lower()
            if u:
                name_by_upn[u] = (r.get(disp) or "").strip()

    n = 0
    licensed = 0
    valid_upn = 0
    upn_re = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    Path(args.outfile).parent.mkdir(parents=True, exist_ok=True)
    with open(args.outfile, "w", encoding="utf-8", newline="") as fo:
        w = csv.DictWriter(fo, fieldnames=out_cols, lineterminator="\n")
        w.writeheader()
        for r in rows:
            uval = (r.get(upn) or "").strip()
            un = uval.lower()
            row = {c: "" for c in out_cols}
            row[OUT_UPN] = uval
            if disp:
                row[OUT_DISPLAY] = (r.get(disp) or "").strip()
            if dept:
                row[OUT_DEPT] = (r.get(dept) or "").strip()
            if title:
                row[OUT_TITLE] = (r.get(title) or "").strip()
            if mgr:
                mval = (r.get(mgr) or "").strip()
                row[OUT_MGR_UPN] = mval
                row[OUT_MGR_NAME] = name_by_upn.get(mval.lower(), "")
            is_lic = lic and (r.get(lic) or "").strip().lower() in true_set
            row[OUT_LICENSE] = "TRUE" if is_lic else "FALSE"
            if is_lic:
                licensed += 1
            if mgr and un in hierarchy:
                row.update(hierarchy[un])
            if upn_re.match(uval):
                valid_upn += 1
            w.writerow(row)
            n += 1

    print("Adapt-OrgFile-To-EntraUsers — done")
    print(f"  Input               : {args.infile}")
    print(f"  Detected delimiter  : {repr(delim)}")
    print(f"  Mapped UPN col      : {upn}")
    print(f"  Mapped license col  : {lic or 'NONE (all users -> Unlicensed)'}")
    print(f"  Mapped dept / title : {dept or '-'} / {title or '-'}")
    print(f"  Mapped manager col  : {mgr or 'NONE (no org hierarchy built)'}")
    print(f"  Rows written        : {n}")
    print(f"  UPN-shaped values   : {valid_upn}/{n}" + ("  <-- WARNING: some rows are not UPNs; they will not join the audit log" if valid_upn < n else ""))
    print(f"  Licensed (TRUE)     : {licensed}")
    print(f"  Output              : {args.outfile}")
    if valid_upn == 0:
        print("  *** CRITICAL: no UPN-shaped values found. The --upn-col must contain the same UPN as the audit log. ***")


if __name__ == "__main__":
    main()
