"""Offline regression tests for notebook snapshot-safety helpers."""
import ast
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NOTEBOOKS = ROOT / "3. Fabric" / "notebooks"


def notebook(name):
    return json.loads((NOTEBOOKS / name).read_text(encoding="utf-8"))


def code_from_cell(name, index):
    return "".join(notebook(name)["cells"][index]["source"])


def extract(name, index, *, functions=(), assigns=(), import_names=None):
    tree = ast.parse(code_from_cell(name, index))
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if import_names is None:
                selected.append(node)
                continue
            names = {
                alias.asname or alias.name.split(".")[0]
                for alias in node.names
            }
            if names & set(import_names):
                selected.append(node)
        elif isinstance(node, ast.Assign):
            targets = {
                target.id
                for target in node.targets
                if isinstance(target, ast.Name)
            }
            if targets & set(assigns):
                selected.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in set(functions):
            selected.append(node)
    missing = (set(functions) | set(assigns)) - {
        node.name if isinstance(node, ast.FunctionDef) else target.id
        for node in selected
        for target in (getattr(node, "targets", None) or [node])
        if isinstance(node, ast.FunctionDef) or isinstance(target, ast.Name)
    }
    if missing:
        raise AssertionError(
            f"{name} cell {index} does not define {sorted(missing)}; cell indices have drifted."
        )
    namespace = {}
    exec(compile(ast.Module(body=selected, type_ignores=[]), f"{name}:cell{index}", "exec"), namespace)
    return namespace


class SnapshotSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spark = None
        cls.spark_error = None
        if importlib.util.find_spec("pyspark"):
            from pyspark.sql import SparkSession

            try:
                cls.spark = (
                    SparkSession.builder.master("local[1]")
                    .appName("snapshot-safety-tests")
                    .getOrCreate()
                )
            except Exception as exc:  # pragma: no cover - environment-specific
                cls.spark_error = exc

    @classmethod
    def tearDownClass(cls):
        if cls.spark is not None:
            cls.spark.stop()

    def test_licensed_report_rejects_malformed_rows_and_conflicting_duplicates(self):
        ns = extract(
            "Copilot_Licensed_Users_Direct_Ingester.ipynb",
            6,
            functions=(
                "_normalise_header",
                "_pick_report_column",
                "_normalise_identity",
                "_parse_active_user_report",
                "_validate_report_rows",
            ),
            import_names=("csv", "StringIO"),
        )
        with self.assertRaisesRegex(ValueError, "row 2 has 1 columns; expected 2"):
            ns["_parse_active_user_report"](
                "User Principal Name,Assigned Products\nuser@example.com\n"
            )
        _, rows, upn_col, _ = ns["_parse_active_user_report"](
            "User Principal Name,Assigned Products\n"
            "User@Example.com,Microsoft 365 E7\n"
            " user@example.com ,Microsoft 365 Copilot\n"
        )
        with self.assertRaisesRegex(ValueError, "Duplicate licensed-user row conflict"):
            ns["_validate_report_rows"](rows, upn_col)

    def test_org_helpers_reject_malformed_pages_conflicts_and_cycles(self):
        page = extract(
            "Copilot_Org_Data_Direct_Ingester.ipynb",
            6,
            functions=("_validate_users_page",),
        )
        with self.assertRaisesRegex(ValueError, "missing required 'value'"):
            page["_validate_users_page"]({"@odata.nextLink": "x"}, 1)
        with self.assertRaisesRegex(ValueError, "invalid '@odata.nextLink'"):
            page["_validate_users_page"]({"value": [], "@odata.nextLink": 123}, 1)

        rows_ns = extract(
            "Copilot_Org_Data_Direct_Ingester.ipynb",
            8,
            functions=("_normalise_identity", "_canonical_org_row", "_dedupe_org_rows"),
        )
        rows = [
            rows_ns["_canonical_org_row"](
                {"userPrincipalName": "A@example.com", "displayName": "Alice", "department": "HR"}
            ),
            rows_ns["_canonical_org_row"](
                {"userPrincipalName": " a@example.com ", "displayName": "Alicia", "department": "HR"}
            ),
        ]
        with self.assertRaisesRegex(ValueError, "Conflicting org rows"):
            rows_ns["_dedupe_org_rows"](rows)

        hier = extract(
            "Copilot_Org_Data_Direct_Ingester.ipynb",
            10,
            functions=("build_hierarchy",),
            assigns=("MAX_ORG_LEVELS", "HIER_FIXED", "HIER_LEVELS", "HIER_COLUMNS"),
        )
        with self.assertRaisesRegex(ValueError, "Cycle detected"):
            hier["build_hierarchy"](
                [
                    {"PersonId": "a@example.com", "displayName": "A", "managerUPN": "b@example.com"},
                    {"PersonId": "b@example.com", "displayName": "B", "managerUPN": "a@example.com"},
                ]
            )

    def test_registry_helpers_validate_pages_tolerate_bad_elements_and_reject_duplicate_keys(self):
        page = extract(
            "Copilot_Agent365_Registry_Ingester.ipynb",
            4,
            functions=("_validate_catalog_page",),
            import_names=(),
        )
        with self.assertRaisesRegex(ValueError, "missing required 'value'"):
            page["_validate_catalog_page"]({"@odata.nextLink": "x"}, 1)

        shape = extract(
            "Copilot_Agent365_Registry_Ingester.ipynb",
            11,
            functions=(
                "_normalise_registry_key",
                "_note_element_skip",
                "_elements",
                "_dedupe_registry_rows",
            ),
            assigns=("_ELEMENT_SKIPS",),
            import_names=("_json",),
        )
        shape.setdefault("_json", json)
        # A malformed publisher payload must be counted and skipped, never fatal:
        # one bad element used to discard the entire tenant snapshot.
        self.assertEqual(
            shape["_elements"](
                {"elementDetails": [{"elementType": "command", "elements": [{"definition": "{"}]}]}
            ),
            ("command", "", ""),
        )
        self.assertEqual(shape["_elements"]({"elementDetails": "not-a-list"}), ("", "", ""))
        self.assertEqual(
            shape["_elements"]({"elementDetails": [{"elementType": "x", "elements": "bad"}, "bad"]}),
            ("x", "", ""),
        )
        self.assertEqual(sum(shape["_ELEMENT_SKIPS"].values()), 4)
        with self.assertRaisesRegex(ValueError, "Conflicting Agent 365 rows"):
            shape["_dedupe_registry_rows"](
                [
                    {"Title ID": "T_1", "Agent name": "Agent A"},
                    {"Title ID": " t_1 ", "Agent name": "Agent B"},
                ]
            )

    def test_audit_creator_tier_detects_this_repos_own_audit_column_names(self):
        # The curated audit table this notebook reads exposes Audit_UserId / AgentId /
        # CreationDate. If tier 3's candidate lists miss them, creator resolution
        # silently degrades to "UNATTRIBUTED" on every real tenant.
        source = code_from_cell("Copilot_Agent365_Registry_Ingester.ipynb", 8)
        tree = ast.parse(source)
        resolver = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "_audit_creator_map"
        )
        candidates = [
            {element.value.lower() for element in node.elts if isinstance(element, ast.Constant)}
            for node in ast.walk(resolver)
            if isinstance(node, ast.Tuple)
        ]
        for column in ("audit_userid", "agentid", "creationdate"):
            self.assertTrue(
                any(column in group for group in candidates),
                f"tier 3 cannot detect the audit column {column}",
            )


        ns = extract(
            "Copilot_ProductFeedback_Ingester.ipynb",
            8,
            functions=("_assert_feedback_write_mode", "_decide_missing_feedback_action"),
            import_names=(),
        )
        ns.update({
            "REPORT_GLOB": "*feedback*",
            "SOURCE_DIR": "Files/product_feedback",
            "TARGET_TABLE": "dbo.user_feedback",
        })
        with self.assertRaisesRegex(ValueError, "WRITE_MODE='append' is not supported"):
            ns["_assert_feedback_write_mode"]("append")
        decision = ns["_decide_missing_feedback_action"](
            matches=[],
            table_exists=True,
            strict=False,
            allow_empty_first_snapshot=False,
        )
        self.assertEqual(decision["action"], "preserve")
        self.assertIn("Preserving existing", decision["message"])
        with self.assertRaisesRegex(ValueError, "ALLOW_EMPTY_FIRST_SNAPSHOT"):
            ns["_decide_missing_feedback_action"](
                matches=[],
                table_exists=False,
                strict=False,
                allow_empty_first_snapshot=False,
            )

    def test_feedback_has_no_superseded_writer_before_guarded_publication(self):
        # A second writer used to erase the table before the tested guard ran.
        cells = notebook("Copilot_ProductFeedback_Ingester.ipynb")["cells"]
        publishing_cells = []
        for index, cell in enumerate(cells):
            if cell["cell_type"] != "code":
                continue
            tree = ast.parse("".join(cell["source"]))
            if any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr == "saveAsTable" for node in ast.walk(tree)):
                publishing_cells.append(index)
        self.assertEqual(publishing_cells, [8])

    def test_agent365_lander_alias_plan_is_comprehensive_and_rejects_ambiguity(self):
        ns = extract(
            "Copilot_Agent365_Lander.ipynb",
            2,
            functions=("_norm", "_build_alias_plan", "_build_header_groups", "_resolve_alias_targets"),
            import_names=("re",),
        )
        canonical, plan = ns["_build_alias_plan"]()
        self.assertEqual(set(canonical), set(plan))
        resolved = ns["_resolve_alias_targets"](
            ["name", "title_id", "publisher", "deployed_to", "total_runtime"],
            plan,
            canonical,
        )
        self.assertEqual(resolved["Agent name"], "name")
        self.assertEqual(resolved["Title ID"], "title_id")
        self.assertEqual(resolved["Publisher"], "publisher")
        self.assertEqual(resolved["Deployment"], "deployed_to")
        self.assertEqual(resolved["Run Time"], "total_runtime")
        with self.assertRaisesRegex(ValueError, "Ambiguous source headers"):
            ns["_resolve_alias_targets"](["Title ID", "title_id"], plan, canonical)

    def test_agent365_lander_duplicate_equivalence_is_behavioral(self):
        if self.spark is None:
            self.skipTest(f"local Spark unavailable: {self.spark_error}")
        ns = extract(
            "Copilot_Agent365_Lander.ipynb",
            2,
            functions=("_columns_equivalent",),
            import_names=("F",),
        )
        df_same = self.spark.createDataFrame(
            [("T_1", "T_1"), ("T_2", "T_2")],
            ["Title ID", "title_id"],
        )
        df_diff = self.spark.createDataFrame(
            [("T_1", "P_1")],
            ["Title ID", "title_id"],
        )
        self.assertTrue(ns["_columns_equivalent"](df_same, ["Title ID", "title_id"]))
        self.assertFalse(ns["_columns_equivalent"](df_diff, ["Title ID", "title_id"]))

    def test_data_check_helpers_keep_full_totals_and_only_overlap_real_licensed_identities(self):
        ns = extract(
            "ValueLens_Data_Check.ipynb",
            3,
            functions=("_accepted_flag", "_summarize_flag_values", "_licensed_upns"),
            assigns=("ACCEPTED",),
            import_names=("Counter",),
        )
        values = [("TRUE" if i < 3 else f"other-{i}") for i in range(30)]
        summary = ns["_summarize_flag_values"](values)
        self.assertEqual(summary["counted"], 3)
        self.assertEqual(summary["total"], 30)
        self.assertEqual(len(summary["display_rows"]), 25)
        self.assertIsNone(ns["_licensed_upns"]([], "User Principal Name", None))
        self.assertEqual(
            ns["_licensed_upns"](
                [
                    {"User Principal Name": "a@example.com", "Has license": "TRUE"},
                    {"User Principal Name": " ", "Has license": "TRUE"},
                    {"User Principal Name": "b@example.com", "Has license": "FALSE"},
                    {"User Principal Name": "A@example.com", "Has license": "TRUE"},
                ],
                "User Principal Name",
                "Has license",
            ),
            {"a@example.com"},
        )


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class FakeRequests:
    """Minimal stand-in for the requests module - records every call."""

    def __init__(self, token_lifetime=3600, statuses=None):
        self.token_lifetime = token_lifetime
        self.statuses = list(statuses or [])
        self.minted = []
        self.calls = []

    def post(self, url, data=None, timeout=None):
        self.minted.append(data)
        return FakeResponse(
            200,
            {
                "access_token": f"token-{len(self.minted)}",
                "expires_in": self.token_lifetime,
            },
        )

    def request(self, method, url, headers=None, **kwargs):
        self.calls.append((method, url, dict(headers or {})))
        status = self.statuses.pop(0) if self.statuses else 200
        return FakeResponse(status)


class FakeClock:
    def __init__(self):
        self.now = 1_000.0

    def time(self):
        return self.now


class Agent365TokenRefreshTests(unittest.TestCase):
    """The registry ingester must survive a token expiring mid-snapshot.

    A full snapshot issues one Graph request per package, so a large tenant can run
    past the ~60 minute lifetime of a client-credentials token. Minting once at the
    top of the notebook made every later call fail with 401.
    """

    NOTEBOOK = "Copilot_Agent365_Registry_Ingester.ipynb"

    def build(self, token_lifetime=3600, statuses=None):
        ns = extract(
            self.NOTEBOOK,
            2,
            functions=("_get_graph_token", "graph_headers", "graph_request"),
            assigns=("_TOKEN_CACHE",),
            import_names=set(),
        )
        fake = FakeRequests(token_lifetime=token_lifetime, statuses=statuses)
        clock = FakeClock()
        ns.update(
            requests=fake,
            time=clock,
            TENANT_ID="tenant",
            CLIENT_ID="client",
            CLIENT_SECRET="secret",
        )
        return ns, fake, clock

    def test_token_is_cached_rather_than_reminted_per_call(self):
        ns, fake, _ = self.build()
        first = ns["_get_graph_token"]()
        second = ns["_get_graph_token"]()
        self.assertEqual(first, second)
        self.assertEqual(len(fake.minted), 1)

    def test_token_is_reminted_once_the_cached_one_goes_stale(self):
        ns, fake, clock = self.build(token_lifetime=3600)
        self.assertEqual(ns["_get_graph_token"](), "token-1")
        # Still inside the lifetime, minus the early-renewal margin.
        clock.now += 3000
        self.assertEqual(ns["_get_graph_token"](), "token-1")
        self.assertEqual(len(fake.minted), 1)
        # Past the renewal point: a long snapshot must not keep using the old token.
        clock.now += 600
        self.assertEqual(ns["_get_graph_token"](), "token-2")
        self.assertEqual(len(fake.minted), 2)

    def test_short_lived_token_still_gets_a_usable_cache_window(self):
        ns, fake, clock = self.build(token_lifetime=60)
        ns["_get_graph_token"]()
        clock.now += 30
        ns["_get_graph_token"]()
        self.assertEqual(len(fake.minted), 1, "margin must not force a mint per call")

    def test_graph_request_retries_once_with_a_fresh_token_on_401(self):
        ns, fake, _ = self.build(statuses=[401, 200])
        response = ns["graph_request"]("GET", "https://graph.microsoft.com/v1.0/thing")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(fake.calls), 2)
        self.assertEqual(len(fake.minted), 2, "retry must mint a new token, not reuse")
        self.assertEqual(fake.calls[0][2]["Authorization"], "Bearer token-1")
        self.assertEqual(fake.calls[1][2]["Authorization"], "Bearer token-2")

    def test_graph_request_surfaces_a_persistent_401(self):
        ns, fake, _ = self.build(statuses=[401, 401])
        response = ns["graph_request"]("GET", "https://graph.microsoft.com/v1.0/thing")
        self.assertEqual(response.status_code, 401, "consent failures must stay visible")
        self.assertEqual(len(fake.calls), 2, "retry exactly once - no infinite loop")

    def test_graph_request_does_not_retry_a_successful_call(self):
        ns, fake, _ = self.build(statuses=[200])
        ns["graph_request"]("GET", "https://graph.microsoft.com/v1.0/thing")
        self.assertEqual(len(fake.calls), 1)

    def test_graph_request_preserves_caller_supplied_headers(self):
        ns, fake, _ = self.build()
        ns["graph_request"](
            "POST",
            "https://graph.microsoft.com/v1.0/$batch",
            headers={"Content-Type": "application/json"},
        )
        _, _, headers = fake.calls[0]
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertTrue(headers["Authorization"].startswith("Bearer "))

    def test_no_graph_call_bypasses_the_refreshing_wrapper(self):
        """Any direct requests.get/post outside the token plumbing reintroduces the bug."""
        allowed = {"_get_graph_token", "graph_request"}
        offenders = []
        for index, cell in enumerate(notebook(self.NOTEBOOK)["cells"]):
            if cell["cell_type"] != "code":
                continue
            tree = ast.parse("".join(cell["source"]))
            enclosing = {}
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef):
                    for child in ast.walk(node):
                        enclosing[child] = node.name
            for node in ast.walk(tree):
                func = node.func if isinstance(node, ast.Call) else None
                if not isinstance(func, ast.Attribute):
                    continue
                if not (isinstance(func.value, ast.Name) and func.value.id == "requests"):
                    continue
                if enclosing.get(node) in allowed:
                    continue
                offenders.append(f"cell {index}: requests.{func.attr} at line {node.lineno}")
        self.assertEqual(offenders, [], "call Graph through graph_request so the token refreshes")


if __name__ == "__main__":
    unittest.main()
