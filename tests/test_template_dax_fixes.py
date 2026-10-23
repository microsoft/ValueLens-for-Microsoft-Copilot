"""The shared DAX fixes are in every active ValueLens and Consumption Central template.

The archived Power Automate + Dataverse templates are frozen, so they aren't checked.
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


def flat(dax):
    return " ".join(dax.split())


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
        self.assertEqual(len(PATCHER.VALUELENS), 4)
        self.assertEqual(len(PATCHER.CONSUMPTION), 3)
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


class ActiveUserFastPath(unittest.TestCase):
    """The per-user counts use distinct counts unless Audit_UserId is filtered directly. There they
    keep the per-user form: the fast path is only proven equal to this one, so a change to it
    needs the fast path re-proven."""

    USER_ID = f"'{AUDIT}'[Audit_UserId]"
    PER_USER = (f"COUNTROWS(FILTER(VALUES({USER_ID}), LEN(TRIM({USER_ID})) > 0"
                " && CALCULATE([Usage Rows]) > 0))")
    PROMPT_USERS = PER_USER.replace("[Usage Rows]", "[AI Tasks]")
    FILTERS = {
        "Active Licensed Users": f"KEEPFILTERS('{AUDIT}'[License Status] = \"M365 Copilot Licensed\")",
        "Active Unlicensed Users": f"KEEPFILTERS('{AUDIT}'[License Status] = \"Unlicensed\")",
        "Cowork Users": f"KEEPFILTERS('{AUDIT}'[Is_Cowork] = TRUE())",
    }
    AGENTS = f"KEEPFILTERS('{AUDIT}'[Agent Filter (Normalized)] = \"Agents\")"
    NAMES = ("All Active Users", "Active Licensed Users", "Active Unlicensed Users", "Cowork Users",
             "Active Agent Users", "Cowork Fit: Eligible Users")

    def assert_guarded(self, expression, per_user, rows, ids, where):
        self.assertIn(f"IF( ISFILTERED({self.USER_ID}), {per_user}, VAR BlankIds =", flat(expression), where)
        self.assertIn(f"FILTER( ALL({self.USER_ID}), LEN(TRIM({self.USER_ID})) = 0 )", flat(expression), where)
        self.assertEqual(expression.count(f"DISTINCTCOUNT({self.USER_ID})"), 2, where)
        self.assertEqual(expression.count(rows), 2, where)
        self.assertEqual(expression.count("KEEPFILTERS(BlankIds)"), 1, where)
        self.assertIn(f"VAR ActiveIds = {ids} - Blank{ids}", expression, where)
        self.assertTrue(flat(expression).endswith("RETURN IF(ActiveIds > 0, ActiveIds) )"), where)

    def test_usage_counts_guard_the_per_user_form(self):
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            # The fast path filters usage rows exactly as [Usage Rows] does.
            self.assertIn(PATCHER.USAGE_ROW_FILTER, text(measures["Usage Rows"]["expression"]), relative)
            self.assert_guarded(text(measures["All Active Users"]["expression"]), self.PER_USER,
                                PATCHER.USAGE_ROW_FILTER, "UsageIds", (relative, "All Active Users"))
            for name, keep in self.FILTERS.items():
                expression = text(measures[name]["expression"])
                self.assert_guarded(expression, f"CALCULATE( {self.PER_USER}, {keep} )",
                                    PATCHER.USAGE_ROW_FILTER, "UsageIds", (relative, name))
                # The filter is in the per-user form and in both distinct counts.
                self.assertEqual(expression.count(keep), 3, (relative, name))

    def test_agent_users_guard_the_prompt_based_per_user_form(self):
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            # The distinct counts filter prompt rows exactly as [AI Tasks] counts them.
            self.assertEqual(flat(text(measures["AI Tasks"]["expression"])),
                             f"CALCULATE(COUNTROWS('{AUDIT}'), {PATCHER.PROMPT_ROW_FILTER})", relative)
            expression = text(measures["Active Agent Users"]["expression"])
            where = (relative, "Active Agent Users")
            self.assert_guarded(expression, f"CALCULATE( {self.PROMPT_USERS}, {self.AGENTS} )",
                                PATCHER.PROMPT_ROW_FILTER, "PromptIds", where)
            self.assertEqual(expression.count(self.AGENTS), 3, where)
            self.assertNotIn("[Usage Rows]", expression, where)

    def test_cowork_fit_guards_the_per_user_form(self):
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            expression = flat(text(measures["Cowork Fit: Eligible Users"]["expression"]))
            where = (relative, "Cowork Fit: Eligible Users")
            # Cowork users are anyone with a Cowork row under any filter; the per-user form is unchanged.
            self.assertIn(
                f"VAR _CoworkUsers = CALCULATETABLE( VALUES({self.USER_ID}), REMOVEFILTERS('{AUDIT}'), "
                f"'{AUDIT}'[Is_Cowork] = TRUE() ) RETURN IF( ISFILTERED({self.USER_ID}), "
                f"VAR _ActiveUsers = FILTER(VALUES({self.USER_ID}), LEN(TRIM({self.USER_ID})) > 0 "
                "&& CALCULATE([AI Tasks]) > 0) VAR _Eligible = EXCEPT(_ActiveUsers, _CoworkUsers) "
                "RETURN COUNTROWS(_Eligible), VAR Excluded = UNION( _CoworkUsers, "
                f"FILTER( ALL({self.USER_ID}), LEN(TRIM({self.USER_ID})) = 0 ) )", expression, where)
            self.assertEqual(expression.count(f"DISTINCTCOUNT({self.USER_ID})"), 1, where)
            self.assertEqual(expression.count(PATCHER.PROMPT_ROW_FILTER), 1, where)
            self.assertTrue(expression.endswith(
                f"{PATCHER.PROMPT_ROW_FILTER}, KEEPFILTERS(EXCEPT(ALL({self.USER_ID}), Excluded)) ) )"), where)

    def test_templates_share_the_active_user_counts(self):
        baseline = None
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            current = {name: measures[name]["expression"] for name in self.NAMES}
            baseline = baseline or current
            self.assertEqual(current, baseline, relative)


class HabitStageFastPath(unittest.TestCase):
    """The 8 habit-stage counts count every user's active days in one SUMMARIZECOLUMNS unless
    Audit_UserId is filtered directly. There they keep the per-user form: the fast path is only
    proven equal to this one, so a change to it needs the fast path re-proven."""

    USER_ID = f"'{AUDIT}'[Audit_UserId]"
    DAY = f"'{AUDIT}'[InteractionDate]"
    LAST_MONTH = f"REMOVEFILTERS('Calendar'), '{AUDIT}'[MonthStart] = MStart"
    BANDS = {"Beginner": "[Days] >= 1 && [Days] <= 5", "Developing": "[Days] >= 6 && [Days] <= 10",
             "Habitual": "[Days] >= 11 && [Days] <= 15", "Power": "[Days] >= 16"}
    SUFFIXES = {", Last Month": True, " (Monthly)": False}

    def names(self):
        return [f"{stage} Users{suffix}" for suffix in self.SUFFIXES for stage in self.BANDS]

    def expected(self, band, last_month):
        days = f'SUMMARIZECOLUMNS( {self.USER_ID}, "Days", DISTINCTCOUNT({self.DAY}) )'
        count = f"RETURN COUNTROWS(FILTER(UserDays, {band}))"
        if last_month:
            per_user = (f"VAR UserDays = ADDCOLUMNS( CALCULATETABLE( VALUES({self.USER_ID}), {self.LAST_MONTH} ), "
                        f"\"Days\", CALCULATE( DISTINCTCOUNT({self.DAY}), {self.LAST_MONTH} ) ) {count}")
            fast = f"VAR UserDays = CALCULATETABLE( {days}, {self.LAST_MONTH} ) {count}"
            return f"VAR MStart = [Last Full Month Start] RETURN IF( ISFILTERED({self.USER_ID}), {per_user}, {fast} )"
        per_user = (f"VAR UserDays = ADDCOLUMNS( VALUES({self.USER_ID}), "
                    f"\"Days\", CALCULATE(DISTINCTCOUNT({self.DAY})) ) {count}")
        return f"IF( ISFILTERED({self.USER_ID}), {per_user}, VAR UserDays = {days} {count} )"

    def test_stage_counts_guard_the_per_user_form(self):
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            for suffix, last_month in self.SUFFIXES.items():
                for stage, band in self.BANDS.items():
                    name = f"{stage} Users{suffix}"
                    expression = text(measures[name]["expression"])
                    code = "\n".join(line for line in expression.split("\n") if not line.lstrip().startswith("//"))
                    self.assertEqual(flat(code), self.expected(band, last_month), (relative, name))
                    # SUMMARIZECOLUMNS in a measure needs the June 2024 or later engine; the note says so.
                    self.assertIn("June 2024", expression, (relative, name))

    def test_templates_share_the_stage_counts(self):
        baseline = None
        for relative in PATCHER.VALUELENS:
            _, measures, _ = objects(load(relative), AUDIT)
            current = {name: measures[name]["expression"] for name in self.names()}
            baseline = baseline or current
            self.assertEqual(current, baseline, relative)


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


class UserMonthMetricsKeys(unittest.TestCase):
    """UserMonthMetrics leaves out blank and whitespace-only IDs. The engine stores a whitespace-only
    ID as "", so with a blank ID in the same month both rows got the key "|yyyy-MM" and the refresh
    failed on the one side of the UserMonthKey relationship."""

    USER_ID = f"'{AUDIT}'[Audit_UserId]"

    def expression(self, model):
        return text(PATCHER.find_table(model, "UserMonthMetrics")["partitions"][0]["source"]["expression"])

    def test_only_the_power_query_templates_have_the_table(self):
        self.assertEqual(len(PATCHER.USER_MONTH_TEMPLATES), 2)
        for relative in PATCHER.VALUELENS:
            names = {t["name"] for t in load(relative)["tables"]}
            self.assertEqual("UserMonthMetrics" in names, relative in PATCHER.USER_MONTH_TEMPLATES, relative)

    def test_blank_and_whitespace_only_ids_are_left_out(self):
        for relative in PATCHER.USER_MONTH_TEMPLATES:
            expression = flat(self.expression(load(relative)))
            # The metrics still run straight over SUMMARIZE (one pass); the filter comes after them.
            self.assertIn("VAR WithMetrics = ADDCOLUMNS( Base,", expression, relative)
            self.assertIn(f"VAR UserMonths = FILTER( WithMetrics, LEN(TRIM({self.USER_ID})) > 0 )",
                          expression, relative)
            self.assertIn("RETURN ADDCOLUMNS( UserMonths, \"UserStage\",", expression, relative)
            # The key itself is unchanged, so every audit row still finds its user-month.
            self.assertIn(f"\"UserMonthKey\", {self.USER_ID} & \"|\" & FORMAT('{AUDIT}'[MonthStart], \"yyyy-MM\")",
                          expression, relative)

    def test_no_audit_row_relates_to_a_blank_or_whitespace_only_id(self):
        for relative in PATCHER.USER_MONTH_TEMPLATES:
            model = load(relative)
            relationships = [r for r in model["relationships"] if r["toTable"] == "UserMonthMetrics"]
            self.assertEqual([(r["fromTable"], r["fromColumn"], r["toColumn"]) for r in relationships],
                             [(AUDIT, "UserMonthKey", "UserMonthKey")], relative)
            _, _, columns = objects(model, AUDIT)
            self.assertEqual(text(columns["User_Stage_Maturity"]["expression"]),
                             "RELATED('UserMonthMetrics'[UserStage])", relative)
            # The audit key is built in Power Query: null for a blank ID ("" is already null there),
            # and a whitespace-only ID keeps its whitespace, so it never matches "|yyyy-MM".
            query = text(PATCHER.find_table(model, AUDIT)["partitions"][0]["source"]["expression"])
            self.assertIn('Table.ReplaceValue(__model, "", null, Replacer.ReplaceValue, {"CreationDate", "Audit_UserId",',
                          query, relative)
            self.assertIn("each if [Audit_UserId] = null or [MonthStart] = null then null", query, relative)
            self.assertIn('else Text.From([Audit_UserId]) & "|" & DateTime.ToText([MonthStart]', query, relative)

    def test_templates_share_the_table(self):
        self.assertEqual(len({self.expression(load(r)) for r in PATCHER.USER_MONTH_TEMPLATES}), 1)


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
