"""Give every Metric in the shipped templates' Metric Glossary one MetricOrder.

The glossary sorts Metric by MetricOrder. A metric listed on several pages with different
orders breaks that sort: the refresh fails with "Cannot order 'Metric Glossary'[Metric] by
[MetricOrder] because at least one value in [Metric] has multiple distinct values in
[MetricOrder]". Like the ValueLens glossary, each metric keeps the lowest order it has on any
page (metrics are compared case-insensitively, as the engine does). Only those numbers change:
the rest of the model and every other ZIP member stay byte-for-byte the same. Idempotent.

    python scripts/Update-Glossary-Sort-Order.py           # patch the templates in place
    python scripts/Update-Glossary-Sort-Order.py --check   # exit 1 if any template is stale
"""
import argparse
import copy
import io
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GLOSSARY = "\U0001f4d6 Metric Glossary"
COLUMNS = ("Page", "PageDescription", "Metric", "Description", "PageOrder", "MetricOrder")
HEADER = re.compile(r'\s*DATATABLE\s*\(\s*' + r'\s*,\s*'.join(
    rf'"{name}"\s*,\s*\w+' for name in COLUMNS) + r'\s*,\s*\{\s*$', re.IGNORECASE)
STRING = re.compile(r'"((?:[^"]|"")*)"')
ROW_END = re.compile(r"(,\s*-?\d+\s*,\s*)(-?\d+)(\s*\}\s*,?\s*)$")
ZIP_METADATA = ("filename", "date_time", "compress_type", "comment", "extra", "create_system",
                "create_version", "extract_version", "flag_bits", "volume", "internal_attr",
                "external_attr")


def shipped_templates():
    return sorted(p for p in ROOT.rglob("*.pbit") if "archive" not in p.relative_to(ROOT).parts)


def glossary(model):
    tables = [t for t in model["tables"] if t["name"] == GLOSSARY]
    return tables[0] if tables else None


def new_orders(lines):
    """{line index: (old line, new line)} for each row whose MetricOrder must change."""
    first = next((i for i, line in enumerate(lines) if line.lstrip().startswith("{\"")), len(lines))
    if not HEADER.match("\n".join(lines[:first])):
        raise ValueError("glossary is not the expected DATATABLE")
    rows = {}
    for index, line in enumerate(lines[first:], first):
        if re.fullmatch(r"[\s{}();]*", line):
            continue
        strings, end = STRING.findall(line), ROW_END.search(line)
        if len(strings) != 4 or not end:
            raise ValueError(f"glossary line {index + 1} is not one row of 4 strings and 2 numbers")
        rows[index] = (strings[2].replace('""', '"').casefold(), int(end.group(2)))
    lowest = {}
    for metric, order in rows.values():
        lowest[metric] = min(order, lowest.get(metric, order))
    changes = {}
    for index, (metric, order) in rows.items():
        if order != lowest[metric]:
            line = lines[index]
            changes[index] = (line, ROW_END.sub(lambda m: f"{m.group(1)}{lowest[metric]}{m.group(3)}", line))
    return changes


def encoded(line, raw):
    """The line as it is spelled inside the raw DataModelSchema JSON."""
    for ascii_only in (False, True):
        text = json.dumps(line, ensure_ascii=ascii_only)[1:-1]
        if raw.count(text) == 1:
            return text, ascii_only
    raise ValueError(f"cannot find exactly one copy of glossary row {line.strip()[:60]!r}")


def read_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or "DataModelSchema" not in names:
            raise ValueError("expected unique ZIP members including DataModelSchema")
        return infos, {info.filename: archive.read(info) for info in infos}, archive.comment


def build(original):
    infos, payloads, comment = read_archive(original)
    raw = payloads["DataModelSchema"].decode("utf-16-le")
    document = json.loads(raw)
    table = glossary(document["model"])
    if table is None:
        return original, 0
    expression = table["partitions"][0]["source"]["expression"]
    lines = expression if isinstance(expression, list) else expression.split("\n")
    changes = new_orders(lines)
    if not changes:
        return original, 0
    patched = raw
    for old, new in changes.values():
        text, ascii_only = encoded(old, patched)
        patched = patched.replace(text, json.dumps(new, ensure_ascii=ascii_only)[1:-1])
    expected = copy.deepcopy(document)
    expected_lines = list(lines)
    for index, (_, new) in changes.items():
        expected_lines[index] = new
    glossary(expected["model"])["partitions"][0]["source"]["expression"] = (
        expected_lines if isinstance(expression, list) else "\n".join(expected_lines))
    if json.loads(patched) != expected:
        raise ValueError("patch changed more than the glossary MetricOrder values")
    payloads["DataModelSchema"] = patched.encode("utf-16-le")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.comment = comment
        for info in infos:
            archive.writestr(copy.copy(info), payloads[info.filename])
    rebuilt = output.getvalue()
    after_infos, after_payloads, after_comment = read_archive(rebuilt)
    if after_comment != comment or [i.filename for i in after_infos] != [i.filename for i in infos]:
        raise ValueError("ZIP members, order or comment changed")
    for old, new in zip(infos, after_infos):
        if any(getattr(old, key) != getattr(new, key) for key in ZIP_METADATA):
            raise ValueError(f"ZIP metadata changed: {old.filename}")
        if after_payloads[new.filename] != payloads[old.filename]:
            raise ValueError(f"ZIP member did not round-trip: {old.filename}")
    return rebuilt, len(changes)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="report stale templates without writing")
    args = parser.parse_args(argv)
    stale = 0
    for path in shipped_templates():
        relative = path.relative_to(ROOT)
        original = path.read_bytes()
        rebuilt, changed = build(original)
        if not changed:
            print(f"current  {relative}")
            continue
        stale += 1
        if args.check:
            print(f"stale    {relative}: {changed} glossary rows", file=sys.stderr)
            continue
        if path.read_bytes() != original:
            raise ValueError(f"{relative} changed during rebuild; refusing to overwrite")
        path.write_bytes(rebuilt)
        print(f"updated  {relative}: {changed} glossary rows")
    return 1 if args.check and stale else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Glossary sort order update failed: {error}", file=sys.stderr)
        sys.exit(1)
