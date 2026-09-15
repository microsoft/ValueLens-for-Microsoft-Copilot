"""Build an isolated Fabric regression notebook; does not authenticate or run it."""
import argparse
import ast
import hashlib
import inspect
import json
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "3. Fabric" / "notebooks" / "optional" / "workday-org-data" / "Copilot_Org_Data_Workday_Lander.ipynb"


def verification():
    import contextlib
    import csv
    import io
    import traceback
    from collections import Counter

    import notebookutils
    from pyspark.sql import functions as F

    prefix = "vl_org_additive_" + RUN_ID
    folder = "Files/" + prefix
    report = {
        "run_id": RUN_ID, "source_sha256": SOURCE_HASH, "status": "running",
        "checks": [], "scenarios": [], "cleanup": [],
        "limitations": ["Synthetic fixtures only", "No PBIT refresh", "No production deployment"],
    }
    created_tables = set()
    created_files = set()
    before = None
    spark.conf.set("spark.sql.shuffle.partitions", "4")

    def check(condition, label):
        if not condition:
            raise AssertionError(label)
        report["checks"].append(label)

    def protected_versions():
        versions = {}
        for entry in spark.catalog.listTables("dbo"):
            if entry.isTemporary or entry.name.startswith(prefix):
                continue
            quoted = "dbo.`" + entry.name.replace("`", "``") + "`"
            detail = spark.sql("DESCRIBE DETAIL " + quoted).first()
            if detail["format"] == "delta":
                versions[entry.name] = spark.sql(
                    "DESCRIBE HISTORY " + quoted + " LIMIT 1").first()["version"]
        return versions

    def table(suffix):
        name = "dbo." + prefix + "_" + suffix
        if name not in created_tables:
            check(not spark.catalog.tableExists(name), "scratch name unused: " + suffix)
            created_tables.add(name)
        return name

    def fixture(suffix, rows, headers):
        path = folder + "/" + suffix + ".csv"
        created_files.add(path)
        text = io.StringIO()
        writer = csv.writer(text, lineterminator="\n")
        writer.writerow(headers)
        writer.writerows(rows)
        notebookutils.fs.put(path, text.getvalue(), True)
        return path

    def rows(df):
        return Counter(tuple(row) for row in df.collect())

    def unchanged(expected, actual, label):
        projected = actual.select(*[F.col("`" + c.replace("`", "``") + "`") for c in expected.columns])
        check(expected.schema == projected.schema, label + ": full baseline types preserved")
        check(rows(expected) == rows(projected), label + ": full baseline row multiset preserved")
        check(actual.columns[:len(expected.columns)] == expected.columns, label + ": baseline column order preserved")

    def execute(label, path, mode, base, output):
        namespace = {"spark": spark}
        completed = []
        settings = dict(
            SOURCE_PATH=path, MODE=mode, BASE_TABLE=base, OUTPUT_TABLE=output,
            INCLUDE_UNMATCHED_WORKDAY=False, MIN_WORKDAY_MATCH_RATE=0.5,
            ALLOW_BASE_OVERWRITE=True,
        )
        check(output.startswith("dbo." + prefix + "_"), label + ": isolated output")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            for index, cell in enumerate(NOTEBOOK["cells"]):
                if cell["cell_type"] != "code":
                    continue
                source = "".join(cell["source"])
                exec(compile(source, "candidate_cell_" + str(index), "exec"), namespace)
                completed.append(index)
                if "SOURCE_PATH" in source and "OUTPUT_TABLE" in source and "MODE =" in source:
                    namespace.update(settings)
        report["scenarios"].append({"name": label, "executed_cells": completed})
        return namespace

    def rejects(label, path, mode, base, output, expected):
        try:
            execute(label, path, mode, base, output)
        except ValueError as exc:
            check(expected.lower() in str(exc).lower(), label + ": expected rejection")
            check(not spark.catalog.tableExists(output), label + ": no output written")
        else:
            raise AssertionError(label + ": expected rejection did not occur")

    try:
        before = protected_versions()
        report["protected_before"] = before
        notebookutils.fs.mkdirs(folder)
        base_name = table("base")
        base = spark.createDataFrame([
            ("alice@example.com", "id-a", None, "", "boss@example.com", 2, True, "old-a"),
            ("bob@example.com", "id-b", "Entra role", "Entra dept", None, 0, False, "old-b"),
            ("carol@example.com", "id-c", "Keep role", "Keep dept", None, 1, True, "old-c"),
        ], "PersonId string, id string, JobTitle string, Organization string, managerUPN string, "
           "DirectReports long, accountEnabled boolean, OrgData_Source string")
        base.write.format("delta").mode("errorifexists").saveAsTable(base_name)
        baseline = spark.table(base_name)
        csv_path = fixture("workers", [
            [" ALICE@example.com ", "Advisor", "Workday role", "WD dept", "alpha", "secretariat"],
            ["bob@example.com", "Engineer", "Another role", "WD dept", "beta", "operations"],
            ["dave@example.com", "Analyst", "New role", "WD dept", "gamma", "finance"],
        ], ["primaryWorkEmail", "Persona", "Job_Profile", "Job_Family_Group", "CustomAttribute", "jobtitle"])

        out = table("enrich")
        execute("enrich", csv_path, "enrich", base_name, out)
        enriched = spark.table(out)
        unchanged(baseline, enriched, "enrich")
        check(enriched.count() == 3, "enrich: no Workday-only person added")
        check({"Persona", "CustomAttribute", "Job_Profile"} <= set(enriched.columns),
              "enrich: all distinct Workday attributes retained")
        check(sum(c.casefold() == "jobtitle" for c in enriched.columns) == 1,
              "enrich: differently cased existing column not duplicated")
        values = {r["PersonId"]: (r["Persona"], r["CustomAttribute"]) for r in enriched.collect()}
        check(values == {"alice@example.com": ("Advisor", "alpha"),
                         "bob@example.com": ("Engineer", "beta"),
                         "carol@example.com": (None, None)}, "enrich: independent email/attribute oracle")

        auto_out = table("auto_existing")
        execute("auto_existing", csv_path, "auto", base_name, auto_out)
        check(rows(enriched) == rows(spark.table(auto_out)), "auto existing matches explicit enrichment")

        same_snapshot = enriched.collect()
        same_schema = enriched.schema
        execute("same_table_rerun", csv_path, "enrich", out, out)
        check(spark.table(out).schema == same_schema and
              rows(spark.table(out)) == Counter(tuple(row) for row in same_snapshot),
              "same-table staged rerun preserves existing values")

        no_base = table("absent")
        standalone_out = table("standalone")
        execute("standalone", csv_path, "standalone", no_base, standalone_out)
        standalone = spark.table(standalone_out)
        check(standalone.count() == 3, "standalone: all Workday people landed")
        check({"PersonId", "PersonId_Normalized", "Persona", "CustomAttribute", "managerUPN"} <=
              set(standalone.columns), "standalone: user-level schema and extra attributes")
        check(standalone.filter(F.col("managerUPN").isNotNull()).count() == 0,
              "standalone: no invented hierarchy")
        check({r["PersonId_Normalized"] for r in standalone.collect()} ==
              {"alice@example.com", "bob@example.com", "dave@example.com"},
              "standalone: normalized identity oracle")
        check({r["PersonId"] for r in standalone.collect()} ==
              {"alice@example.com", "bob@example.com", "dave@example.com"},
              "standalone: model relationship identity oracle")
        standalone_schema = standalone.schema
        standalone_rows = rows(standalone)
        execute("standalone_rerun", csv_path, "standalone", standalone_out, standalone_out)
        check(spark.table(standalone_out).schema == standalone_schema and
              rows(spark.table(standalone_out)) == standalone_rows, "explicit standalone refresh repeatable")

        auto_missing = table("auto_absent")
        execute("auto_absent", csv_path, "auto", no_base, auto_missing)
        check(rows(spark.table(auto_missing)) == standalone_rows,
              "auto missing baseline matches standalone")

        invalid = table("invalid_base")
        spark.createDataFrame([("not-an-org-snapshot",)], ["Other"]).write.format("delta").saveAsTable(invalid)
        rejects("invalid_existing_auto", csv_path, "auto", invalid, table("invalid_out"), "PersonId")
        check(spark.table(invalid).count() == 1, "invalid baseline not replaced")

        mismatch = fixture("mismatch", [["none@example.com", "P"]], ["primaryWorkEmail", "Persona"])
        rejects("mismatch", mismatch, "enrich", base_name, table("mismatch_out"), "match")
        blank = fixture("blank", [["", "P"]], ["primaryWorkEmail", "Persona"])
        rejects("blank_identity", blank, "standalone", no_base, table("blank_out"), "blank")
        duplicate = fixture("duplicate", [["alice@example.com", "P"], ["alice@example.com", "Q"]],
                            ["primaryWorkEmail", "Persona"])
        rejects("duplicate_identity", duplicate, "enrich", base_name, table("duplicate_out"), "conflict")
        report["status"] = "passed"
    except Exception as exc:
        report.update(status="failed", error_type=type(exc).__name__, error=str(exc)[:1200],
                      traceback=traceback.format_exc(limit=8))
    finally:
        # Also remove staging tables produced by the actual notebook writer.
        for entry in spark.catalog.listTables("dbo"):
            if entry.name.startswith(prefix) and not entry.isTemporary:
                name = "dbo.`" + entry.name.replace("`", "``") + "`"
                detail = spark.sql("DESCRIBE DETAIL " + name).first()
                location = detail["location"]
                spark.sql("DROP TABLE " + name)
                if notebookutils.fs.exists(location):
                    notebookutils.fs.rm(location, True)
                report["cleanup"].append(entry.name)
        for path in created_files:
            if notebookutils.fs.exists(path):
                notebookutils.fs.rm(path, False)
        after = protected_versions()
        report["protected_after"] = after
        report["production_versions_unchanged"] = before == after
        if before != after:
            report["status"] = "failed"
        report["scratch_files_absent"] = all(not notebookutils.fs.exists(p) for p in created_files)
        if not report["scratch_files_absent"]:
            report["status"] = "failed"
        notebookutils.fs.put(folder + "/report.json", json.dumps(report, indent=2), True)
        print(json.dumps(report, indent=2))
    if report["status"] != "passed":
        raise AssertionError("Workday regression failed; inspect aggregate report")


def build(output, source=SOURCE):
    source = Path(source)
    raw = source.read_bytes()
    candidate = json.loads(raw)
    run_id = uuid.uuid4().hex[:12]
    code = (
        "import json\n"
        f"RUN_ID = {run_id!r}\n"
        f"SOURCE_HASH = {hashlib.sha256(raw).hexdigest()!r}\n"
        f"NOTEBOOK = json.loads({json.dumps(candidate)!r})\n\n"
        + inspect.getsource(verification) + "\nverification()\n"
    )
    ast.parse(code)
    notebook = {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {
            "language_info": {"name": "python"},
            "kernelspec": {"display_name": "Synapse PySpark", "language": "python", "name": "synapse_pyspark"},
        },
        "cells": [{"cell_type": "code", "execution_count": None, "outputs": [], "metadata": {},
                   "source": code.splitlines(keepends=True)}],
    }
    Path(output).write_text(json.dumps(notebook, indent=2) + "\n", encoding="utf-8")
    return run_id


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=SOURCE)
    args = parser.parse_args()
    print(build(args.output, args.source))
