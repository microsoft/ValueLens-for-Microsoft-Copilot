"""Extracts the report's static reference tables into src/data/*.json.

Reads the DataModelSchema inside a ValueLens .pbit and writes:
  glossary.json   - the Metric Glossary DATATABLE
  behaviors.json  - the Behavior Value Map #table
  estimates.json  - the Human Time Estimates #table

Usage: python scripts/extract-model-tables.py "../5. Local CSV/ValueLens - Local CSV.pbit"
Re-run whenever the report's glossary or time estimates change.
"""
import json
import pathlib
import re
import sys
import zipfile

here = pathlib.Path(__file__).resolve().parent
dest = here.parent / "src" / "data"


def parse_rows(expr):
    rows = []
    for line in expr.split("\n"):
        s = line.strip()
        if not s.startswith('{"'):
            continue
        toks, i = [], 1
        while i < len(s):
            c = s[i]
            if c == '"':
                j, buf = i + 1, ""
                while True:
                    if s[j] == '"':
                        if j + 1 < len(s) and s[j + 1] == '"':
                            buf += '"'
                            j += 2
                            continue
                        break
                    buf += s[j]
                    j += 1
                toks.append(buf)
                i = j + 1
            elif c.isdigit() or c in "-.":
                m = re.match(r"-?[\d.]+", s[i:]).group()
                toks.append(float(m) if "." in m else int(m))
                i += len(m)
            elif s.startswith("null", i):
                toks.append(None)
                i += 4
            elif c == "}":
                break
            else:
                i += 1
        rows.append(toks)
    return rows


def main(pbit):
    with zipfile.ZipFile(pbit) as z:
        raw = z.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff")
    model = json.loads(raw)["model"]
    exprs = {}
    for t in model["tables"]:
        e = t["partitions"][0]["source"].get("expression")
        exprs[t["name"]] = "\n".join(e) if isinstance(e, list) else e

    g = parse_rows(exprs["📖 Metric Glossary"])
    b = [r for r in parse_rows(exprs["Behavior Value Map"]) if len(r) == 5 and r[0] != "Signal"]
    h = [r for r in parse_rows(exprs["Human Time Estimates"]) if len(r) == 12 and r[0] != "Behavior"]
    out = {
        "glossary": [dict(page=r[0], pageDescription=r[1], metric=r[2], description=r[3], pageOrder=r[4], metricOrder=r[5]) for r in g],
        "behaviors": [dict(signal=r[0], behavior=r[1], useCase=r[2], valueOutcome=r[3], description=r[4]) for r in b],
        "estimates": [
            dict(behavior=r[0], baseline=r[1], confidence=r[2], source=r[3], url=r[4], category=r[5], valueOutcome=r[6],
                 coworkCategory=r[7], low=r[8], typical=r[9], high=r[10], grain=r[11])
            for r in h
        ],
    }
    for name, rows in out.items():
        (dest / f"{name}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(f"{name}: {len(rows)} rows")


if __name__ == "__main__":
    main(sys.argv[1])
