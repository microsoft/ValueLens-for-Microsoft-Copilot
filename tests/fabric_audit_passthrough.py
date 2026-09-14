"""Build a self-contained Fabric regression notebook from verbatim processor cells.

python tests\\fabric_audit_passthrough.py --output <scratch.ipynb> [--live-source <table>]
Import into a TEST lakehouse and Run all. Never point output at a production table.
Only --live-source and its optional dimensions are read from the attached lakehouse.
"""
import argparse
import ast
import hashlib
import inspect
import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROCESSOR = ROOT / "3. Fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"


def verification():
    import io
    import sys
    import traceback
    from collections import Counter
    from pyspark.sql import functions as F, types as T

    spark.conf.set("spark.sql.shuffle.partitions", "4")
    prefix = "vl_audit_pt_" + RUN_ID
    report_path = "Files/" + prefix + "/report.json"
    tables = []
    views = []
    cached = []
    report = {"run_id": RUN_ID, "baseline_sha256": BASELINE_HASH,
              "candidate_sha256": CANDIDATE_HASH, "comparisons": [], "checks": [],
              "live": {"requested": bool(LIVE_SOURCE)}, "status": "running"}
    log = io.StringIO()
    original_stdout = sys.stdout

    class Tee:
        def write(self, text):
            log.write(text)
            return original_stdout.write(text)

        def flush(self):
            original_stdout.flush()

    sys.stdout = Tee()

    def view(df, suffix):
        name = prefix + "_" + suffix
        if spark.catalog.tableExists(name):
            raise RuntimeError("Scratch view already exists")
        df = df.cache()
        cached.append(df)
        df.count()
        df.createOrReplaceTempView(name)
        views.append(name)
        return name

    def run(cells, enabled, source, licensed, agents, suffix):
        output = "dbo." + prefix + "_" + suffix
        if spark.catalog.tableExists(output):
            raise RuntimeError("Scratch output already exists")
        tables.append(output)
        ns = {"spark": spark}
        for index, cell in enumerate(cells):
            if cell["cell_type"] != "code":
                continue
            exec(compile("".join(cell["source"]), f"processor:{suffix}:cell{index}", "exec"), ns)
            if index == 1:
                ns.update(SRC_INTERACTIONS=source, SRC_LICENSED=licensed, SRC_AGENTS=agents,
                          OUT_TABLE=output, WRITE_MODE="overwrite", RUN_OPTIMIZE=False,
                          INCLUDE_RAW_PASSTHROUGH=enabled)
        return spark.table(output), ns

    def quote(name):
        return F.col("`" + name.replace("`", "``") + "`")

    def signature(df, columns):
        # Type-aware JSON with explicit nulls; compare the complete row MULTISET, not keys.
        text = df.select(F.to_json(F.struct(*[quote(c) for c in columns]),
                                  options={"ignoreNullFields": "false"}).alias("row"))
        return Counter(r["row"] for r in text.collect())

    def compare(label, source, licensed, agents):
        original, _ = run(BASELINE, False, source, licensed, agents, label + "_base")
        off, off_ns = run(CANDIDATE, False, source, licensed, agents, label + "_off")
        on, on_ns = run(CANDIDATE, True, source, licensed, agents, label + "_on")
        assert original.columns == off.columns, label + ": OFF column order changed"
        canonical = original.columns
        expected_types = [(c, original.schema[c].dataType.json()) for c in canonical]
        assert expected_types == [(c, off.schema[c].dataType.json()) for c in canonical]
        assert expected_types == [(c, on.schema[c].dataType.json()) for c in canonical]
        expected = signature(original, canonical)
        assert expected == signature(off, canonical), label + ": OFF canonical row multiset changed"
        assert expected == signature(on, canonical), label + ": ON canonical row multiset changed"
        assert len({c.casefold() for c in on.columns}) == len(on.columns)
        assert "_NormUPN" not in on.columns and "Audit_UserId_Norm" not in on.columns
        source_df = spark.table(source)
        raw_names = list(on_ns["RAW_PASSTHROUGH_COLUMNS"].values())
        assert set(on.columns) - set(canonical) == set(raw_names) | (
            {"Audit_UserId_Normalized"} if "Audit_UserId_Normalized" in source_df.columns else set())
        # Every output raw payload must equal its originating input, including null/empty/invalid JSON.
        source_keys = ["Id"] if "Id" in source_df.columns else []
        expected_raw = source_df.select(
            *[quote(c) for c in source_keys],
            *[(quote(c) if c in source_df.columns else F.lit(None).cast("string")).alias(target)
              for c, target in on_ns["RAW_PASSTHROUGH_COLUMNS"].items()],
            *([quote("Audit_UserId_Normalized")] if "Audit_UserId_Normalized" in source_df.columns else []))
        raw_compare = source_keys + raw_names
        if "Audit_UserId_Normalized" in source_df.columns:
            raw_compare.append("Audit_UserId_Normalized")
        assert set(signature(expected_raw, raw_compare)) == set(signature(on, raw_compare))
        report["comparisons"].append({
            "dataset": label, "input_rows": source_df.count(), "output_rows": original.count(),
            "canonical_columns": len(canonical), "off_columns": len(off.columns),
            "on_columns": len(on.columns), "all_canonical_values_and_types_equal": True,
            "raw_values_and_source_identity_equal": True})
        return original, off, on, off_ns, on_ns

    def production_versions():
        versions = {}
        for table in ["dbo.copilot_interactions_parsed", "dbo.copilot_interactions_curated",
                      "dbo.copilot_licensed_users", "dbo.agents_365"]:
            if spark.catalog.tableExists(table):
                versions[table] = spark.sql("DESCRIBE HISTORY " + table + " LIMIT 1").first()["version"]
        return versions

    try:
        report["production_versions_before"] = production_versions()
        licensed = view(spark.createDataFrame([
            ("licensed@example.invalid", "Yes"), ("licensed@example.invalid", "Yes"),
            ("unlicensed@example.invalid", "No")],
            "UPN_Normalized string, `Has license` string"), "licensed")
        agents = view(spark.createDataFrame([
            ("title-1", "entra-1", "Agent One"), ("title-1", "entra-1", "Agent One"),
            ("title-2", "entra-2", "Agent Two")],
            "`Title ID` string, `Entra Agent ID` string, `Agent name` string"), "agents")
        payloads = [
            ('[{"Type":"docx","Action":"Read","SiteUrl":"https://example.invalid",'
             '"type":"case-variant","SensitivityLabelId":"raw-only","Rare":{"x":[1,null,true]},'
             '"a.b":"dot","odd key":"space"},'
             '{"Type":"xlsx","Action":"Write","FileName":"second.xlsx"}]',
             '{"Id":"plugin-1","Name":"Plugin","id":"lowercase","Extra":{"a":[1,null]}}'),
            ('[]', '[]'), (None, None), ('', ''), ('null', 'null'), ('[null]', '[null]'),
            ('[{}]', '{}'), ('not-json', 'broken'),
            ('[{"Type":42,"Action":true,"Extra":[1,"mixed",null]}]',
             '[{"Id":"first","Name":"First","Extra":1},{"Id":"second","Extra":{"z":2}}]'),
            ('{"Type":"object-shape","Extra":"keep"}', '{"Name":"no-id","Extra":null}'),
            ('[{"Type":null,"Action":null,"Extra":{"nested":null}}]', '[{},{"Name":"second"}]'),
            ('  [ {"Type":"pptx","Extra":"whitespace"} ]  ', '  {"Id":"spaced","Extra":false}  '),
            ('[{"Type":{"mixed":"object"},"Extra":123}]', '{"Id":123,"Extra":[true,{}]}'),
        ]
        rows = []
        for i, (resources, plugin) in enumerate(payloads):
            normalized = {2: None, 3: "", 4: "masked-identity", 5: " MixedCase "}.get(
                i, "licensed@example.invalid")
            rows.append((f"row-{i}", "2026-09-01T12:00:00Z", " LICENSED@example.invalid ",
                         normalized, resources, plugin, '{"appId":"app","unknown":null}',
                         "canonical display", "canonical-label", "Teams", "Agent One",
                         "entra-1" if i % 3 == 0 else None,
                         "title-1.suffix" if i % 3 == 1 else None, "tenant-value"))
        rows.append(rows[0])  # Duplicate source rows must remain duplicates, including resource explosion.
        schema = ("Id string, CreationDate string, Audit_UserId string, Audit_UserId_Normalized string, "
                  "AccessedResources string, AISystemPlugin string, AppIdentity string, "
                  "AppIdentity_DisplayName string, AccessedResource_SensitivityLabelId string, "
                  "AppHost string, AgentName string, Agent_EntraId string, AgentId string, TenantField string")
        source = view(spark.createDataFrame(rows, schema), "synthetic")
        original, off, on, off_ns, on_ns = compare("synthetic", source, licensed, agents)
        assert on.where(F.col("Id") == "row-0").count() == 4
        assert on.where(F.col("Id").isin("row-1", "row-2", "row-3")).count() == 3
        assert on.where(~F.col("AccessedResource_SensitivityLabelId").eqNullSafe("canonical-label")).count() == 0
        assert on.where(~F.col("AppIdentity_DisplayName").eqNullSafe("canonical display")).count() == 0
        assert on.where(~F.col("Agent_LinkID").eqNullSafe("title-1")).count() == 0
        assert on.where((F.col("Id") == "row-2") & ~F.col("Has license").eqNullSafe("Yes")).count() == 0
        assert on.where(F.col("Id").isin("row-3", "row-4", "row-5") & F.col("Has license").isNotNull()).count() == 0
        report["checks"].append("resource explosion, empty-resource survival, duplicate and canonical/link preservation")

        # Test merge/upsert and both flag transitions on a source with UNIQUE curated keys.
        for ns, frame in [(off_ns, off), (on_ns, on)]:
            unique = frame.dropDuplicates(["Id"])
            ns["WRITE_MODE"] = "overwrite"
            assert ns["write_curated_output"](unique) == "overwrite"
            ns["WRITE_MODE"] = "merge"
            assert ns["write_curated_output"](unique) == "merge"
            assert signature(spark.table(ns["OUT_TABLE"]), unique.columns) == signature(unique, unique.columns)
        # Enabling requires deliberate schema widening; disabling with merge does NOT erase old raw columns.
        off_ns["WRITE_MODE"] = "overwrite"
        off_ns["write_curated_output"](on.dropDuplicates(["Id"]))
        off_ns["WRITE_MODE"] = "merge"
        off_ns["write_curated_output"](off.dropDuplicates(["Id"]))
        assert "AccessedResources_Raw" in spark.table(off_ns["OUT_TABLE"]).columns
        off_ns["WRITE_MODE"] = "overwrite"
        off_ns["write_curated_output"](off.dropDuplicates(["Id"]))
        assert "AccessedResources_Raw" not in spark.table(off_ns["OUT_TABLE"]).columns
        report["checks"].append("unique-key merge idempotence in both modes; ON/OFF overwrite and retained-schema merge")

        minimal = spark.createDataFrame(
            [("minimal", "2026-09-02T12:00:00Z", "unlicensed@example.invalid")],
            "Id string, CreationDate string, Audit_UserId string")
        compare("missing", view(minimal, "missing"), prefix + "_absent_licensed", prefix + "_absent_agents")
        compare("missing_id", view(minimal.drop("Id"), "missing_id"), licensed, agents)
        compare("empty", view(minimal.limit(0), "empty"), licensed, agents)

        helpers = on_ns
        for collision in ["AppIdentity_Raw", "accessedresources_RAW", "aisystemplugin_raw"]:
            try:
                helpers["retain_raw_payloads"](minimal.withColumn(collision, F.lit("existing")))
            except ValueError:
                pass
            else:
                raise AssertionError("Case-insensitive collision was not rejected")
        nested = spark.createDataFrame(
            [({"app": "x", "missing": None},)],
            T.StructType([T.StructField("AppIdentity", T.MapType(T.StringType(), T.StringType()))]))
        encoded = helpers["retain_raw_payloads"](nested).first()["AppIdentity_Raw"]
        assert json.loads(encoded) == {"app": "x", "missing": None}
        late = spark.range(2002).select(
            F.when(F.col("id") == 2001, F.lit('[{"LateOnly":{"x":[null,1]}}]'))
             .otherwise(F.lit("[]")).alias("AccessedResources"))
        assert helpers["retain_raw_payloads"](late).where(
            F.col("AccessedResources_Raw") == '[{"LateOnly":{"x":[null,1]}}]').count() == 1
        report["checks"].append("case-insensitive alias collisions, complex JSON null retention, field beyond row 2000")

        if LIVE_SOURCE:
            if not spark.catalog.tableExists(LIVE_SOURCE):
                raise RuntimeError("Requested live source does not exist")
            live = spark.table(LIVE_SOURCE).limit(200)
            live_count = live.count()
            report["live"]["input_rows"] = live_count
            if live_count:
                live_source = view(live, "live")
                live_licensed = (view(spark.table("dbo.copilot_licensed_users"), "live_licensed")
                                 if spark.catalog.tableExists("dbo.copilot_licensed_users") else licensed)
                live_agents = (view(spark.table("dbo.agents_365"), "live_agents")
                               if spark.catalog.tableExists("dbo.agents_365") else agents)
                report["live"]["licensed_dimension"] = (
                    "live" if live_licensed != licensed else "synthetic fallback")
                report["live"]["agents_dimension"] = "live" if live_agents != agents else "synthetic fallback"
                compare("live", live_source, live_licensed, live_agents)
                report["live"]["validated"] = True
            else:
                report["live"]["validated"] = False
                report["live"]["limitation"] = "Live parsed source is empty; no live-data parity claim."
        report["production_versions_after"] = production_versions()
        report["production_versions_unchanged"] = (
            report["production_versions_before"] == report["production_versions_after"])
        assert report["production_versions_unchanged"], "Production tables changed during verification"
        report["status"] = "passed"
    except Exception:
        report["status"] = "failed"
        # Full diagnostics stay in tenant scratch; publish only sanitized aggregate results.
        traceback.print_exc(file=sys.stdout)
        raise
    finally:
        try:
            for table in tables:
                spark.sql("DROP TABLE IF EXISTS " + table)
            for name in views:
                spark.catalog.dropTempView(name)
            for df in cached:
                df.unpersist()
            report["scratch_tables_removed"] = all(not spark.catalog.tableExists(t) for t in tables)
            report["scratch_table_count"] = len(tables)
        finally:
            sys.stdout = original_stdout
            notebookutils.fs.mkdirs("Files/" + prefix)
            notebookutils.fs.put(report_path, json.dumps(report, indent=2), True)
            notebookutils.fs.put("Files/" + prefix + "/stdout.txt", log.getvalue(), True)
            print(json.dumps(report, indent=2))
            print("REPORT_PATH=" + report_path)


def build(output, baseline_ref="5d20fb9", live_source=""):
    baseline_bytes = subprocess.check_output(
        ["git", "show", f"{baseline_ref}:{PROCESSOR.relative_to(ROOT).as_posix()}"], cwd=ROOT)
    candidate_bytes = PROCESSOR.read_bytes()
    baseline, candidate = json.loads(baseline_bytes), json.loads(candidate_bytes)
    run_id = uuid.uuid4().hex[:12]
    config = "\n".join([
        "import json",
        f"RUN_ID = {run_id!r}",
        f"LIVE_SOURCE = {live_source!r}",
        f"BASELINE_HASH = {hashlib.sha256(baseline_bytes).hexdigest()!r}",
        f"CANDIDATE_HASH = {hashlib.sha256(candidate_bytes).hexdigest()!r}",
        f"BASELINE = json.loads({json.dumps(baseline['cells'])!r})",
        f"CANDIDATE = json.loads({json.dumps(candidate['cells'])!r})",
    ])
    code = config + "\n\n" + inspect.getsource(verification) + "\nverification()\n"
    ast.parse(code)
    notebook = {"nbformat": 4, "nbformat_minor": 5,
                "metadata": {"language_info": {"name": "python"},
                             "kernelspec": {"display_name": "Synapse PySpark", "language": "python",
                                          "name": "synapse_pyspark"}},
                "cells": [{"cell_type": "code", "execution_count": None, "outputs": [],
                           "metadata": {}, "source": code.splitlines(keepends=True)}]}
    output.write_text(json.dumps(notebook, indent=1), encoding="utf-8")
    return run_id


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline-ref", default="5d20fb9")
    parser.add_argument("--live-source", default="")
    args = parser.parse_args()
    print(build(args.output, args.baseline_ref, args.live_source))
