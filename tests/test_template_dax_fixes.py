"""The shared DAX fixes are in every shipped ValueLens and Consumption Central template.

Structural checks only: Desktop refresh and rendering still need live QA.
"""
import importlib.util
import json
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("template_dax", ROOT / "scripts" / "Update-Template-Dax.py")
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)
AUDIT = PATCHER.AUDIT


def text(value):
    return "\n".join(value) if isinstance(value, list) else (value or "")


def load(relative):
    with zipfile.ZipFile(ROOT / relative) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]


def objects(model, table_name):
    table = PATCHER.find_table(model, table_name)
    measures = {m["name"]: m for m in table.get("measures", [])}
    columns = {c["name"]: c for c in table.get("columns", [])}
    return table, measures, columns


class TemplatesAreCurrent(unittest.TestCase):
    def test_every_template_is_current_and_the_patcher_is_idempotent(self):
        self.assertEqual(len(PATCHER.VALUELENS), 5)
        self.assertEqual(len(PATCHER.CONSUMPTION), 4)
        for relative, specs in PATCHER.TARGETS:
            original = (ROOT / relative).read_bytes()
            rebuilt, changed = PATCHER.build(original, specs)
            self.assertEqual(changed, [], f"{relative} is stale: run scripts/Update-Template-Dax.py")
            self.assertEqual(rebuilt, original, relative)

    def test_patcher_refuses_to_replace_an_imported_column(self):
        model = {"tables": [{"name": AUDIT, "columns": [{"name": "Is Usage Row", "sourceColumn": "x"}]}]}
        spec = next(s for s in PATCHER.VALUELENS_OBJECTS if s["name"] == "Is Usage Row")
        with self.assertRaises(ValueError):
            PATCHER.apply(model, spec)

    def test_owned_objects_keep_stable_lineage(self):
        for relative in PATCHER.VALUELENS:
            _, measures, columns = objects(load(relative), AUDIT)
            for spec in PATCHER.VALUELENS_OBJECTS:
                record = {"column": columns, "measure": measures}.get(spec["kind"], {}).get(spec.get("name"))
                if record is not None and "new" in spec:
                    self.assertEqual(record["lineageTag"], PATCHER.lineage_tag(spec), (relative, spec["name"]))


class CoworkScheduledRuns(unittest.TestCase):
    """P3: Cowork runs with no prompt are kept as task rows; they make people active, not prompts."""

    def test_usage_row_is_prompt_rows_plus_cowork_task_rows(self):
        for relative in PATCHER.VALUELENS:
            _, measures, columns = objects(load(relative), AUDIT)
            usage = columns["Is Usage Row"]
            self.assertEqual(usage["type"], "calculated")
            self.assertEqual(usage["dataType"], "boolean")
            self.assertTrue(usage["isHidden"])
            self.assertIn("[Is Prompt Row]", text(usage["expression"]))
            self.assertIn("[Is_Cowork]", text(usage["expression"]))
            self.assertIn("[Is Usage Row] = TRUE()", text(measures["Usage Rows"]["expression"]))
            self.assertTrue(measures["Usage Rows"]["isHidden"])

    def test_active_user_counts_include_cowork_task_rows(self):
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            for name in ("All Active Users", "Active Licensed Users", "Active Unlicensed Users", "Cowork Users"):
                expression = text(measures[name]["expression"])
                self.assertIn("CALCULATE([Usage Rows]) > 0", expression, (relative, name))
                self.assertNotIn("[AI Tasks]", expression, (relative, name))
            self.assertIn('[License Status] = "M365 Copilot Licensed"',
                          text(measures["Active Licensed Users"]["expression"]))
            self.assertIn('[License Status] = "Unlicensed"', text(measures["Active Unlicensed Users"]["expression"]))
            self.assertIn("[Is_Cowork] = TRUE()", text(measures["Cowork Users"]["expression"]))

    def test_prompt_and_task_measures_stay_prompt_only(self):
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            self.assertIn("[Is Prompt Row] = TRUE()", text(measures["AI Tasks"]["expression"]))
            self.assertIn("[AI Tasks]", text(measures["Cowork AI Tasks"]["expression"]))
            runs = text(measures["Cowork Scheduled Runs"]["expression"])
            self.assertIn("[Is_Cowork] = TRUE()", runs)
            self.assertIn("[Is Prompt Row] = FALSE()", runs)
            self.assertEqual(measures["Cowork Scheduled Runs"]["displayFolder"], "AI Fluency\\Cowork - Value")


class CalendarRange(unittest.TestCase):
    """P7: the Calendar no longer collapses to one day when the audit is empty."""

    def test_calendar_spans_audit_and_feedback_with_a_rolling_fallback(self):
        for relative in PATCHER.VALUELENS:
            model = load(relative)
            table = PATCHER.find_table(model, "Calendar")
            expression = text(table["partitions"][0]["source"]["expression"])
            self.assertIn(f"MIN('{AUDIT}'[CreationDate])", expression)
            self.assertIn("MIN('ProductFeedback'[FeedbackDate])", expression)
            self.assertIn("MINX({ AuditMin, FeedbackMin }, [Value])", expression)
            self.assertIn("MAXX({ AuditMax, FeedbackMax }, [Value])", expression)
            self.assertIn("RunDate - 364", expression)
            self.assertNotIn("DATE(2024, 1, 1)", expression)
            # The calculated columns still come from the same ADDCOLUMNS names.
            sources = {c.get("sourceColumn") for c in table["columns"]}
            for name in ("Date", "Year", "Year-Month", "Week Start", "Is Weekend"):
                self.assertIn(f"[{name}]", sources, (relative, name))

    def test_the_installer_range_lines_match_the_template(self):
        # 1. Fabric/installer/src/transform/m365.js widens these two lines with the M365 dates.
        source = (ROOT / "1. Fabric" / "installer" / "src" / "transform" / "m365.js").read_text(encoding="utf-8")
        for line in ("VAR MinDate = MINX({ AuditMin, FeedbackMin }, [Value])",
                     "VAR MaxDate = MAXX({ AuditMax, FeedbackMax }, [Value])"):
            self.assertIn(line, PATCHER.CALENDAR)
            self.assertIn(f"'{line}'", source)


class CoworkNoLimit(unittest.TestCase):
    """P9: a blank or zero Cowork limit means no limit is set, never 'over the limit'."""

    def test_allowances_are_blank_without_a_positive_limit(self):
        for relative in PATCHER.CONSUMPTION:
            _, measures, _ = objects(load(relative), "CoworkBilling")
            self.assertIn("IF(Limit > 0, Limit)", text(measures["Person Allowance"]["expression"]))
            self.assertIn("IF(Limit > 0, Limit)", text(measures["Policy Allowance"]["expression"]))
            for name in ("Person Headroom", "Policy Headroom"):
                self.assertIn("IF(NOT ISBLANK(Allowance)", text(measures[name]["expression"]), (relative, name))
            self.assertIn("IF(NOT ISBLANK(Allowance)", text(measures["Over Limit Credits"]["expression"]))
            self.assertIn("IF(Limit > 0", text(measures["Over Limit Credits (Individual)"]["expression"]))

    def test_people_without_a_limit_are_never_over_or_near_it(self):
        for relative in PATCHER.CONSUMPTION:
            _, measures, _ = objects(load(relative), "CoworkBilling")
            for name in ("Users Over Limit", "Users Near Limit"):
                expression = text(measures[name]["expression"])
                self.assertIn("[l] > 0 &&", expression, (relative, name))
                self.assertTrue(expression.endswith("+ 0"), (relative, name))
            # Used % divides by the guarded allowance, so it is blank with no limit.
            self.assertEqual(text(measures["Person Allowance Used %"]["expression"]),
                             "DIVIDE([Cowork Total Credits Used], [Person Allowance])")

    def test_consumption_templates_share_the_limit_measures(self):
        names = {s["name"] for s in PATCHER.CONSUMPTION_OBJECTS if s["table"] == "CoworkBilling"}
        baseline = None
        for relative in PATCHER.CONSUMPTION:
            _, measures, _ = objects(load(relative), "CoworkBilling")
            current = {n: text(measures[n]["expression"]) for n in names}
            baseline = baseline or current
            self.assertEqual(current, baseline, relative)


class StudioSnapshotNote(unittest.TestCase):
    """Studio user and agent detail can come from the licensing API, not only an export."""

    def test_every_consumption_template_names_both_sources(self):
        baseline = None
        for relative in PATCHER.CONSUMPTION:
            _, measures, _ = objects(load(relative), "Settings")
            expression = text(measures["Studio Snapshot Note"]["expression"])
            self.assertIn("PPAC export", expression, relative)
            self.assertIn("licensing API", expression, relative)
            self.assertIn("Copilot Studio credits flow", expression, relative)
            self.assertNotIn("undated export snapshot", expression, relative)
            baseline = baseline or expression
            self.assertEqual(expression, baseline, relative)


if __name__ == "__main__":
    unittest.main()
