"""Dependency-free regression checks for read-only overlap diagnostics."""

import ast
import json
import unittest
from pathlib import Path


NOTEBOOK = (
    Path(__file__).resolve().parents[1]
    / "1. Fabric"
    / "Manual setup"
    / "notebooks"
    / "ValueLens_Data_Check.ipynb"
)


class DataCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
        cls.sources = ["".join(cell["source"]) for cell in notebook["cells"]]
        source = next(text for text in cls.sources if "def _overlap_diagnostic(" in text)
        definitions = [
            node for node in ast.parse(source).body
            if isinstance(node, ast.FunctionDef) and node.name == "_overlap_diagnostic"
        ]
        if len(definitions) != 1:
            raise AssertionError("Expected exactly one overlap diagnostic helper")
        namespace = {}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(NOTEBOOK), "exec"), namespace)
        cls.diagnose = staticmethod(namespace["_overlap_diagnostic"])

    def assert_not_comparable(self, counts, expected):
        status, message = self.diagnose(*counts)
        self.assertEqual(status, "not_comparable")
        self.assertIn(expected, message)
        self.assertIn('"Active Licensed Users" will be zero', message)
        self.assertIn("cannot be assessed", message)
        self.assertNotIn("NO OVERLAP", message)
        self.assertNotIn("identity formats", message)
        self.assertNotIn("different tenants", message)

    def test_empty_audit_is_not_an_identity_mismatch(self):
        self.assert_not_comparable((5, 0, 0, 0), "NO AUDIT ROWS")

    def test_null_or_blank_audit_identifiers_are_not_an_identity_mismatch(self):
        self.assert_not_comparable((5, 0, 0, 8), "NO USABLE AUDIT USER IDENTIFIERS")

    def test_no_qualifying_licensed_users_is_not_an_identity_mismatch(self):
        self.assert_not_comparable((0, 5, 0, 8), "NO LICENSED USERS WITH USABLE UPNs")

    def test_both_sources_empty_reports_both_gaps(self):
        self.assert_not_comparable((0, 0, 0, 0), "NO AUDIT ROWS")
        self.assertIn("NO LICENSED USERS WITH USABLE UPNs", self.diagnose(0, 0, 0, 0)[1])

    def test_both_sources_without_usable_users_reports_both_gaps(self):
        self.assert_not_comparable((0, 0, 0, 8), "NO USABLE AUDIT USER IDENTIFIERS")
        self.assertIn("NO LICENSED USERS WITH USABLE UPNs", self.diagnose(0, 0, 0, 8)[1])

    def test_nonempty_disjoint_users_still_warn(self):
        status, message = self.diagnose(5, 5, 0, 8)
        self.assertEqual(status, "no_overlap")
        self.assertIn("NO OVERLAP", message)
        self.assertIn("possible causes, not a diagnosis", message)
        self.assertIn("audit users are licensed", message)

    def test_low_overlap_still_warns(self):
        status, message = self.diagnose(5, 5, 1, 8)
        self.assertEqual(status, "low_overlap")
        self.assertIn("low overlap", message)

    def test_overlap_threshold_and_matching_users_do_not_warn(self):
        for counts in ((4, 4, 2, 8), (5, 5, 5, 8), (10, 2, 2, 8)):
            with self.subTest(counts=counts):
                self.assertEqual(self.diagnose(*counts), ("overlap", ""))

    def test_notebook_uses_diagnostic_and_displays_only_comparable_samples(self):
        source = next(text for text in self.sources if "# === 4. OVERLAP CHECK" in text)
        tree = ast.parse(source)
        calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "_overlap_diagnostic"
        ]
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            [ast.unparse(arg) for arg in calls[0].args],
            ["nl", "na", "both", "adf.count()"],
        )
        self.assertIn("if status in ('no_overlap', 'low_overlap'):", source)
        self.assertIn("if message:\n            print(message)", source)

    def test_empty_audit_does_not_suggest_a_null_date_range(self):
        source = next(text for text in self.sources if "# === 2. AUDIT LOG COVERAGE" in text)
        self.assertIn("if n == 0:", source)
        self.assertIn("NO AUDIT ROWS - date coverage cannot be assessed.", source)
        self.assertIn("elif dcol:", source)
        self.assertIn("distinct usable users in audit data", source)
        self.assertIn("isNotNull() & (F.trim(F.col(f'`{ucol}`')) != '')", source)


class MaskedUserNameTests(unittest.TestCase):
    """Hidden user names in the M365 reports make the licence roster unjoinable."""

    @classmethod
    def setUpClass(cls):
        notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
        sources = ["".join(cell["source"]) for cell in notebook["cells"]]
        cls.source = next(text for text in sources if "def _masked_hint(" in text)
        body = [
            node for node in ast.parse(cls.source).body
            if (isinstance(node, ast.FunctionDef) and node.name == "_masked_hint")
            or (isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "MASKED_UPN" for t in node.targets))
        ]
        namespace = {}
        exec(compile(ast.Module(body=body, type_ignores=[]), str(NOTEBOOK), "exec"), namespace)
        cls.hint = staticmethod(namespace["_masked_hint"])
        cls.pattern = namespace["MASKED_UPN"]

    def test_pattern_matches_concealed_names_only(self):
        import re
        self.assertRegex("0f8fad5bd9cb469fa16570867728950e", self.pattern)
        for upn in ("jane@contoso.com", "0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5bd9cb469f"):
            with self.subTest(upn=upn):
                self.assertIsNone(re.match(self.pattern, upn))

    def test_mostly_masked_roster_explains_the_admin_center_fix(self):
        message = self.hint(98, 98)
        self.assertIn("MASKED USER NAMES", message)
        self.assertIn("Org settings", message)
        self.assertIn("Display concealed user, group, and site names in all reports", message)
        self.assertTrue(self.hint(50, 100))

    def test_a_few_hash_like_names_do_not_warn(self):
        self.assertEqual(self.hint(0, 100), "")
        self.assertEqual(self.hint(49, 100), "")
        self.assertEqual(self.hint(0, 0), "")

    def test_overlap_check_records_a_summary_for_the_installer(self):
        self.assertIn("overlap_summary = None", self.source)
        self.assertIn(
            "overlap_summary = {'licensed': nl, 'audit': na, 'matched': both, 'masked': masked}",
            self.source,
        )
        self.assertIn("hint = _masked_hint(masked, nl)", self.source)


class ExcludedAuditTests(unittest.TestCase):
    """An empty curated table can mean every parsed record was test activity."""

    @classmethod
    def setUpClass(cls):
        notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
        sources = ["".join(cell["source"]) for cell in notebook["cells"]]
        cls.config = sources[1]
        cls.source = next(text for text in sources if "def _excluded_summary(" in text)
        body = [
            node for node in ast.parse(cls.source).body
            if isinstance(node, ast.FunctionDef) and node.name in ("_excluded_summary", "_excluded_message")
        ]
        namespace = {}
        exec(compile(ast.Module(body=body, type_ignores=[]), str(NOTEBOOK), "exec"), namespace)
        cls.summarize = staticmethod(namespace["_excluded_summary"])
        cls.message = staticmethod(namespace["_excluded_message"])

    def test_counts_reasons_most_common_first_and_names_blank_reasons(self):
        summary = self.summarize({"Maker evaluation": 30, None: 2, "  ": 1, "Autonomous run": 5})
        self.assertEqual(summary["parsed"], 38)
        self.assertEqual(list(summary["reasons"].items()),
                         [("Maker evaluation", 30), ("Autonomous run", 5), ("Other filters", 3)])

    def test_nothing_parsed_returns_none(self):
        self.assertIsNone(self.summarize({}))
        self.assertIsNone(self.summarize({"Maker evaluation": 0}))

    def test_message_explains_test_activity_and_how_to_keep_it(self):
        message = self.message({"parsed": 30, "reasons": {"Maker evaluation": 30}})
        self.assertIn("30 audit records were found", message)
        self.assertIn("Maker evaluation: 30", message)
        self.assertIn("DROP_EXCLUDE_REASONS", message)

    def test_message_without_parsed_rows_points_at_the_window(self):
        message = self.message(None)
        self.assertIn("NO AUDIT ROWS", message)
        self.assertIn("window", message)
        self.assertNotIn("test or admin activity", message)

    def test_empty_audit_reads_the_parsed_table_and_exposes_the_summary(self):
        self.assertIn("PARSED_TABLE   = 'copilot_interactions_parsed'", self.config)
        self.assertIn("audit_excluded = None", self.source)
        self.assertIn("pt = _resolve(PARSED_TABLE)", self.source)
        self.assertIn("audit_excluded = _excluded_summary(counts)", self.source)
        self.assertIn("print(_excluded_message(audit_excluded))", self.source)


if __name__ == "__main__":
    unittest.main()
