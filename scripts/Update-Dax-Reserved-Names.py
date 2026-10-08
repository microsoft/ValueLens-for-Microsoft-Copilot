"""Rebuild tests/fixtures/dax_reserved_names.txt: the names a DAX VAR cannot use.

The DAX parser rejects some function names (LASTDATE, SUM, VALUE) and some grammar words
(STATUS, TYPE, ROWS) as VAR names, but accepts others (YEAR, RATE, WINDOW). There is no
published list, so this asks the Power BI service. Every candidate (each DAX function name
in the docs, plus the words in EXTRA) is tried as `EVALUATE VAR <name> = 1 RETURN ...`
against a semantic model you can read, and only the names that fail to parse are kept.

    az login
    python scripts/Update-Dax-Reserved-Names.py --dataset <semantic model id>

executeQueries allows about 120 queries a minute, so a run takes about six minutes.
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "dax_reserved_names.txt"
TOC = "https://learn.microsoft.com/en-us/dax/toc.json"
TITLE = re.compile(r"^([A-Z][A-Z0-9_]*[A-Z0-9])( \(.*\))?$")
EXTRA = """
AND OR NOT IN TRUE FALSE VAR RETURN DEFINE EVALUATE MEASURE COLUMN TABLE FUNCTION ORDER BY
START AT ASC DESC WITH CALENDAR VISUAL SHAPE AXIS DENSIFY ROWS COLUMNS ROOT LEAF NEXT PREVIOUS
FIRST LAST PARENT CHILD CURRENT HIGHESTPARENT LOWESTPARENT REL ABS SKIP DENSE BLANKS KEEP
PARTITIONBY ORDERBY MATCHBY BOOLEAN DOUBLE INTEGER INT64 DECIMAL CURRENCY STRING DATETIME
VARIANT NUMERIC SCALAR ANYVAL ANYREF EXPR VAL STATUS TYPE NAME ERROR DATA MODE SCORE TOTAL
DEFAULT INDEX VALUE KEY HIDDEN FORMAT EXPRESSION DESCRIPTION QUERY GROUP DETAIL ROW LEVEL PATH
RESULT RANGE STEP SIZE PARAMETER MPARAMETER RELATIONSHIP ROLE PERSPECTIVE CULTURE SELECTED
"""


def candidates():
    with urllib.request.urlopen(TOC) as response:
        toc = json.load(response)
    names = set(EXTRA.split())

    def walk(items):
        for item in items:
            match = TITLE.match(item.get("toc_title", ""))
            if match:
                names.add(match.group(1))
            walk(item.get("children", []))

    walk(toc["items"])
    return sorted(names)


def token():
    az = "az.cmd" if sys.platform == "win32" else "az"
    return subprocess.check_output(
        [az, "account", "get-access-token", "--resource", "https://analysis.windows.net/powerbi/api",
         "--query", "accessToken", "-o", "tsv"], text=True).strip()


def rejected(name, dataset, bearer):
    query = f'EVALUATE VAR {name} = 1 RETURN ROW("x", {name} + 0)'
    body = json.dumps({"queries": [{"query": query}]}).encode()
    request = urllib.request.Request(
        f"https://api.powerbi.com/v1.0/myorg/datasets/{dataset}/executeQueries", data=body,
        headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request) as response:
                json.load(response)
            return False
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")
            if error.code == 429:
                time.sleep(15 * (attempt + 1))
                continue
            if error.code == 400 and "is incorrect" in text:
                return True
            raise RuntimeError(f"{name}: HTTP {error.code}: {text[:300]}") from error
    raise RuntimeError(f"{name}: still throttled")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", required=True, help="Id of a semantic model you can query")
    args = parser.parse_args(argv)
    bearer = token()
    names = candidates()
    bad = []
    for i, name in enumerate(names, 1):
        if rejected(name, args.dataset, bearer):
            bad.append(name)
        print(f"\r{i}/{len(names)} checked, {len(bad)} rejected", end="", flush=True)
        time.sleep(0.55)
    print()
    header = [
        "# Names the DAX parser rejects as VAR names (\"The syntax for '<name>' is incorrect\").",
        "# A Calendar table that declared VAR LastDate never calculated, and Power BI reported it",
        "# only as a refresh warning. Checked by tests/test_dax_var_names.py and the installer's",
        "# test/model-step.test.js. Rebuild with scripts/Update-Dax-Reserved-Names.py.",
        f"# {len(names)} candidates checked; matching is case-insensitive.",
    ]
    OUT.write_text("\n".join(header + bad) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(bad)} names to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
