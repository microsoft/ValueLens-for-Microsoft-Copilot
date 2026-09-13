"""Structural checks for the additive Power Automate + Dataverse pathway."""
import json
import csv
import importlib.util
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATHWAY = ROOT / "4. Power Automate + Dataverse"
SOURCE = ROOT / "2. SharePoint" / "ValueLens - SharePoint.pbit"
TEMPLATE = PATHWAY / "ValueLens - Power Automate + Dataverse.pbit"
SCRIPT = PATHWAY / "scripts" / "Build-PowerAutomateDataverse-Template.py"
BRIDGE = PATHWAY / "scripts" / "Build-DataverseCoreFeeds.py"
SOURCE_MAP = PATHWAY / "source-map.json"


class PowerAutomateDataversePathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with zipfile.ZipFile(SOURCE) as source_archive:
            cls.source_members = {name: source_archive.read(name) for name in source_archive.namelist()}
        with zipfile.ZipFile(TEMPLATE) as template_archive:
            if template_archive.testzip() is not None:
                raise AssertionError("Corrupt Power Automate + Dataverse template archive")
            cls.template_members = {name: template_archive.read(name) for name in template_archive.namelist()}
        cls.model = json.loads(cls.template_members["DataModelSchema"].decode("utf-16-le"))["model"]
        cls.queries = json.loads(cls.template_members["UnappliedChanges"].decode("utf-16-le"))["queries"]
        cls.source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))

    def test_expected_files_exist(self):
        for relative in (
            "README.md",
            "NOTICE.md",
            "ValueLens - Power Automate + Dataverse.pbit",
            "dataverse-core-schema.json",
            "source-map.json",
            "scripts/Build-PowerAutomateDataverse-Template.py",
            "scripts/Build-DataverseCoreFeeds.py",
            "scripts/Invoke-CopilotAuditRawCapture.ps1",
            "scripts/Test-PowerAutomateDataverse-Preflight.ps1",
            "scripts/Invoke-SharePointAgentLogging-Import.ps1",
            "scripts/power-automate-dataverse.settings.json.example",
        ):
            self.assertTrue((PATHWAY / relative).exists(), relative)

    def test_template_report_is_inherited_unchanged(self):
        self.assertEqual(
            {name: data for name, data in self.source_members.items() if name.startswith("Report/")},
            {name: data for name, data in self.template_members.items() if name.startswith("Report/")},
        )

    def test_dataverse_parameter_and_query_added(self):
        expressions = {expression["name"]: expression for expression in self.model["expressions"]}
        self.assertIn("Dataverse URL", expressions)
        self.assertIn("Use SharePoint CSV fallback", expressions)
        self.assertIn("Core Snapshot ID", expressions)
        self.assertIn("Include SharePoint agent inventory", expressions)
        self.assertIn("ValueLensDataverseRows", expressions)
        self.assertEqual(
            expressions["Dataverse URL"]["expression"],
            'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]',
        )
        self.assertEqual(
            expressions["Use SharePoint CSV fallback"]["expression"],
            'false meta [IsParameterQuery=true, Type="Logical", IsParameterQueryRequired=true]',
        )
        parameter_query = next(query for query in self.queries if query.get("name") == "Dataverse URL")
        self.assertTrue(parameter_query["loadAsTableDisabled"])
        self.assertIn("curated valuelens core tables", parameter_query["description"].lower())

    def test_unapplied_query_lineage_matches_static_model_objects(self):
        expressions = {expression["name"]: expression["lineageTag"] for expression in self.model["expressions"]}
        tables = {table["name"]: table["lineageTag"] for table in self.model["tables"]}
        for query in self.queries:
            name = query.get("name")
            if name in expressions:
                self.assertEqual(query["lineageTag"], expressions[name], name)
            elif name in tables:
                self.assertEqual(query["lineageTag"], tables[name], name)

    def test_core_tables_default_to_dataverse_curated_feeds(self):
        for table_name, entity_name in (
            ("Chat + Agent Interactions (Audit Logs)", "poc_valuelensinteractions"),
            ("Copilot Licensed", "poc_valuelensusers"),
            ("Chat + Agent Org Data", "poc_valuelensusers"),
        ):
            table = next(table for table in self.model["tables"] if table["name"] == table_name)
            expression = "\n".join(table["partitions"][0]["source"]["expression"])
            self.assertIn(f'ValueLensDataverseRows("{entity_name}")', expression)
            self.assertIn("UseSharePointCsvFallback", expression)

    def test_org_data_dataverse_path_backfills_all_model_columns(self):
        table = next(table for table in self.model["tables"] if table["name"] == "Chat + Agent Org Data")
        expression = "\n".join(table["partitions"][0]["source"]["expression"])
        for column in table["columns"]:
            self.assertIn(json.dumps(column["name"]), expression)

    def test_power_automate_template_repairs_known_calculated_column_metadata(self):
        table = next(table for table in self.model["tables"] if table["name"] == "Agents 365")
        column = next(column for column in table["columns"] if column["name"] == "Return Rate Category")
        expression = "\n".join(column["expression"])
        self.assertTrue(expression.startswith("VAR Rate"))
        self.assertNotIn("lineageTag:", expression)
        partition = "\n".join(table["partitions"][0]["source"]["expression"])
        self.assertIn('{"Status", type text}', partition)
        glossary = next(table for table in self.model["tables"] if table["name"] == "📖 Metric Glossary")
        metric = next(column for column in glossary["columns"] if column["name"] == "Metric")
        self.assertNotIn("sortByColumn", metric)

    def test_sharepoint_agents_dimension_added(self):
        tables = {table["name"]: table for table in self.model["tables"]}
        self.assertIn("SharePoint Agents", tables)
        table = tables["SharePoint Agents"]
        self.assertGreaterEqual(len(table["columns"]), 21)
        self.assertEqual(table["partitions"][0]["source"]["type"], "m")
        measure_names = {measure["name"] for measure in table["measures"]}
        self.assertTrue(
            {"SharePoint Agents", "Current SharePoint Agents", "Deleted SharePoint Agents", "SharePoint Audit Events"}
            <= measure_names
        )

    def test_interactions_table_enriched_and_related(self):
        table = next(table for table in self.model["tables"] if table["name"] == "Chat + Agent Interactions (Audit Logs)")
        columns = {column["name"] for column in table["columns"]}
        self.assertTrue(
            {
                "SharePointAgentKey",
                "SharePointAgentName",
                "SharePointSiteUrl",
                "SharePointObjectUrl",
                "SharePointLibraryPath",
                "SharePointIsDeleted",
            }
            <= columns
        )
        expression = "\n".join(table["partitions"][0]["source"]["expression"])
        self.assertIn('Table.SelectRows(#"SharePoint Agents"', expression)
        self.assertIn('AppIdentity_AppId', expression)
        relationship = next(
            (
                relationship
                for relationship in self.model["relationships"]
                if relationship["fromTable"] == "Chat + Agent Interactions (Audit Logs)"
                and relationship["fromColumn"] == "SharePointAgentKey"
                and relationship["toTable"] == "SharePoint Agents"
                and relationship["toColumn"] == "AgentKey"
            ),
            None,
        )
        self.assertIsNotNone(relationship)

    def test_unapplied_queries_include_dataverse_lane(self):
        names = {query.get("name") for query in self.queries}
        self.assertIn("SharePoint Agents", names)
        query = next(query for query in self.queries if query.get("name") == "SharePoint Agents")
        text = "\n".join(query["text"])
        self.assertIn('ValueLensDataverseEntity', text)
        self.assertIn('poc_sharepointagents', text)
        interaction_query = next(query for query in self.queries if query.get("name") == "Chat + Agent Interactions (Audit Logs)")
        interaction_text = "\n".join(interaction_query["text"])
        self.assertIn("SharePointAgentKey", interaction_text)
        self.assertIn("__spoGuid", interaction_text)

    def test_pinned_snapshot_manifest_guards_all_core_reads(self):
        expressions = {item["name"]: item for item in self.model["expressions"]}
        text = "\n".join(expressions["ValueLensDataverseRows"]["expression"])
        self.assertIn('#"Core Snapshot ID"', text)
        self.assertIn('Manifest[status] <> "succeeded"', text)
        self.assertIn('[poc_runid] = SnapshotId', text)
        self.assertIn('Table.RowCount(Kept) <> ExpectedCount', text)
        self.assertIn('Table.FromRecords(Records, Columns, MissingField.Error)', text)
        self.assertNotIn("MissingField.UseNull", text)

    def test_inventory_is_genuinely_optional_and_keys_are_validated(self):
        expressions = {item["name"]: item for item in self.model["expressions"]}
        self.assertTrue(expressions["Include SharePoint agent inventory"]["expression"].startswith("false meta"))
        table = next(item for item in self.model["tables"] if item["name"] == "SharePoint Agents")
        text = "\n".join(table["partitions"][0]["source"]["expression"])
        self.assertIn('if not #"Include SharePoint agent inventory" then', text)
        self.assertIn("DuplicateSharePointAgentKey", text)
        self.assertIn("InvalidSharePointAgentKey", text)

    def test_interaction_patch_separates_bindings_and_handles_null_identifiers(self):
        table = next(item for item in self.model["tables"] if item["name"] == "Chat + Agent Interactions (Audit Logs)")
        text = "\n".join(table["partitions"][0]["source"]["expression"])
        before, _ = text.split("__withAppIdentity =", 1)
        self.assertTrue(before.rstrip().endswith(","), "M let bindings need a comma before the first inserted step")
        self.assertIn('app = if [AppIdentity_AppId] = null then ""', text)
        self.assertIn('agent = if [AgentId] = null then ""', text)
        self.assertNotIn('app = try Text.Trim', text)
        self.assertIn('DecodeItemGuid = (driveItemId as text) as nullable text =>', text)
        query = next(item for item in self.queries if item.get("name") == table["name"])
        self.assertEqual(text, "\n".join(query["text"]))
        self.assertEqual(text, json.loads(query["lastLoadedAsTableFormulaText"])["RootFormulaText"])

    def test_core_csv_parameters_are_not_required_in_dataverse_mode(self):
        expressions = {item["name"]: item for item in self.model["expressions"]}
        for name in ("Copilot Interactions File", "Org Data File"):
            self.assertIn('IsParameterQueryRequired=false', expressions[name]["expression"])
            query = next(item for item in self.queries if item.get("name") == name)
            self.assertIn('IsParameterQueryRequired=false', "\n".join(query["text"]))

    def test_query_order_and_source_mapping_document_gaps(self):
        query_order = next(annotation["value"] for annotation in self.model["annotations"] if annotation["name"] == "PBI_QueryOrder")
        self.assertIn("Dataverse URL", query_order)
        self.assertIn("Use SharePoint CSV fallback", query_order)
        self.assertIn("SharePoint Agents", query_order)
        required = {item["modelTable"] for item in self.source_map["requiredFeeds"]}
        self.assertEqual(required, {"Chat + Agent Interactions (Audit Logs)", "Copilot Licensed", "Chat + Agent Org Data"})
        gaps = {item["lane"]: item["status"] for item in self.source_map["documentedGaps"]}
        self.assertEqual(gaps["E"], "Implemented")
        self.assertEqual(gaps["C"], "Implemented with raw-payload extension")

    def test_builder_is_idempotent(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), "--check"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)


class DataverseCoreBridgeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("bridge", BRIDGE)
        self.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bridge)
        self.temp_dir = tempfile.TemporaryDirectory(prefix="valuelens-test-bridge-")
        self.addCleanup(self.temp_dir.cleanup)
        self.work = Path(self.temp_dir.name)

    def test_rejects_summary_without_full_raw_payload(self):
        with self.assertRaisesRegex(Exception, "Full raw audit payload is required"):
            self.bridge.extract_audit_payload({
                "poc_auditlogid": "summary-only",
                "poc_resources": "x" * 4000,
                "poc_primarydetail": "not raw audit json",
            })

    def test_dataverse_raw_reader_follows_pagination(self):
        calls = []

        def fake_request(method, url, token, body=None):
            calls.append((method, url, token, body))
            if len(calls) == 1:
                return {
                    "value": [{"poc_payloadjson": json.dumps({"auditData": {"Operation": "CopilotInteraction"}})}],
                    "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.2/poc_valuelensrawaudits?$skiptoken=2",
                }
            return {"value": [{"poc_payloadjson": json.dumps({"auditData": {"Operation": "CopilotInteraction", "Id": "two"}})}]}

        self.bridge.dataverse_request = fake_request
        rows = self.bridge.read_dataverse_rows("https://contoso.crm.dynamics.com", "token", "poc_valuelensrawaudits")
        self.assertEqual(len(rows), 2)
        self.assertEqual(len(calls), 2)
        self.assertIn("$skiptoken=2", calls[1][1])

    def test_failed_local_publish_does_not_mark_snapshot_complete(self):
        with self.assertRaises(TypeError):
            self.bridge.publish_local(
                {
                    "poc_valuelensinteractions": [{"RecordId": "ok"}],
                    "poc_valuelensusers": [{"bad": object()}],
                },
                self.work,
                "failed-run",
            )
        run_dir = self.work / "dataverse-local" / "failed-run"
        self.assertFalse((run_dir / "manifest.json").exists())
        pending = json.loads((run_dir / "manifest.json.pending").read_text(encoding="utf-8"))
        self.assertEqual(pending["status"], "failed")

    def test_bridge_reuses_processor_and_publishes_complete_local_snapshot(self):
        raw = self.work / "raw.jsonl"
        users = self.work / "users.csv"
        audit = {
            "Operation": "CopilotInteraction",
            "CreationTime": "2026-09-10T08:00:00Z",
            "UserId": "user@example.com",
            "CopilotEventData": {
                "AppHost": "BizChat",
                "ThreadId": "thread-1",
                "Messages": [
                    {"Id": "message-1", "isPrompt": True},
                    {"Id": "message-2", "isPrompt": True},
                ],
                "AccessedResources": [{"Type": "Web", "Action": "Read", "SiteUrl": "https://contoso.sharepoint.com/sites/a"}],
                "Contexts": [{"Type": "Web"}],
                "ModelTransparencyDetails": [{"ModelName": "Copilot"}],
            },
        }
        raw.write_text(
            "\n".join(
                [
                    json.dumps({"id": "audit-1", "auditData": audit}),
                    json.dumps({"id": "audit-1", "auditData": audit}),
                ]
            ),
            encoding="utf-8",
        )
        users.write_text(
            "userPrincipalName,department,jobTitle,Has license\n"
            "user@example.com,Sales,Seller,Yes\n",
            encoding="utf-8",
        )
        proc = subprocess.run(
            [
                sys.executable,
                str(BRIDGE),
                "--raw-jsonl",
                str(raw),
                "--entra",
                str(users),
                "--out-dir",
                str(self.work),
                "--run-id",
                "test-run",
                "--quiet",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        manifest = json.loads((self.work / "dataverse-local" / "test-run" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "succeeded")
        self.assertEqual(manifest["tables"]["poc_valuelensusers"], 1)
        interaction_rows = [
            json.loads(line)
            for line in (self.work / "dataverse-local" / "test-run" / "poc_valuelensinteractions.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        payloads = [json.loads(row["poc_payloadjson"]) for row in interaction_rows]
        self.assertEqual({row["Message_Id"] for row in payloads}, {"1", "2"})
        self.assertEqual({row["Audit_UserId_Normalized"] for row in payloads}, {"user@example.com"})
        self.assertFalse(any(self.work.rglob("*.pending")))


if __name__ == "__main__":
    unittest.main()
