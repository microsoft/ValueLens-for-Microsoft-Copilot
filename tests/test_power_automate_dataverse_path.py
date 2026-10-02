"""Structural checks for the Power Automate + Dataverse pathway."""
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
PATHWAY = ROOT / "2. Power Automate + Dataverse"
SOURCE = ROOT / "3. SharePoint" / "ValueLens - SharePoint.pbit"
ONELAKE = ROOT / "1. Fabric" / "ValueLens - Fabric OneLake.pbit"
TEMPLATE = PATHWAY / "ValueLens - Power Automate + Dataverse.pbit"
BRIDGE = PATHWAY / "scripts" / "Build-DataverseCoreFeeds.py"
SOURCE_MAP = PATHWAY / "source-map.json"
FACT = "Chat + Agent Interactions (Audit Logs)"
GLOSSARY = "\U0001f4d6 Metric Glossary"


def text(value):
    return "\n".join(value) if isinstance(value, list) else value


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
        cls.expressions = {item["name"]: item for item in cls.model["expressions"]}
        cls.tables = {item["name"]: item for item in cls.model["tables"]}
        cls.source_map = json.loads(SOURCE_MAP.read_text(encoding="utf-8"))

    def partition(self, table_name):
        return text(self.tables[table_name]["partitions"][0]["source"]["expression"])

    def test_expected_files_exist(self):
        for relative in (
            "README.md",
            "NOTICE.md",
            "ValueLens - Power Automate + Dataverse.pbit",
            "dataverse-core-schema.json",
            "source-map.json",
            "archive/README.md",
            "archive/scripts/Build-PowerAutomateDataverse-Template.py",
            "scripts/Build-DataverseCoreFeeds.py",
            "scripts/Invoke-CopilotAuditRawCapture.ps1",
            "scripts/Test-PowerAutomateDataverse-Preflight.ps1",
            "scripts/Invoke-SharePointAgentLogging-Import.ps1",
            "scripts/power-automate-dataverse.settings.json.example",
        ):
            self.assertTrue((PATHWAY / relative).exists(), relative)
        # The retired generator rebuilds the pre-lean model; it must not sit beside the live scripts.
        self.assertFalse((PATHWAY / "scripts" / "Build-PowerAutomateDataverse-Template.py").exists())

    def test_template_report_matches_sharepoint(self):
        self.assertEqual(
            {name: data for name, data in self.source_members.items() if name.startswith("Report/")},
            {name: data for name, data in self.template_members.items() if name.startswith("Report/")},
        )

    def test_template_ships_the_applied_model_only(self):
        self.assertNotIn("UnappliedChanges", self.template_members)
        self.assertNotIn("DataModel", self.template_members)

    def test_dataverse_parameters_and_helpers(self):
        for name in (
            "Dataverse URL",
            "Use SharePoint CSV fallback",
            "Core Snapshot ID",
            "ValueLensDataverseEntity",
            "ValueLensDataverseRows",
        ):
            self.assertIn(name, self.expressions)
        self.assertEqual(
            text(self.expressions["Dataverse URL"]["expression"]),
            'null meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=false]',
        )
        self.assertEqual(
            text(self.expressions["Use SharePoint CSV fallback"]["expression"]),
            'false meta [IsParameterQuery=true, Type="Logical", IsParameterQueryRequired=true]',
        )
        self.assertIn("dataverse environment url", text(self.expressions["Dataverse URL"]["description"]).lower())

    def test_core_tables_default_to_dataverse_curated_feeds(self):
        for table_name, entity_name in (
            (FACT, "poc_valuelensinteractions"),
            ("Copilot Licensed", "poc_valuelensusers"),
            ("Chat + Agent Org Data", "poc_valuelensusers"),
        ):
            expression = self.partition(table_name)
            self.assertIn(f'ValueLensDataverseRows("{entity_name}")', expression)
            self.assertIn('#"Use SharePoint CSV fallback"', expression)

    def test_org_data_dataverse_path_backfills_all_model_columns(self):
        table = self.tables["Chat + Agent Org Data"]
        expression = self.partition("Chat + Agent Org Data")
        data_columns = [c for c in table["columns"] if c.get("type", "data") == "data"]
        self.assertGreater(len(data_columns), 0)
        for column in data_columns:
            self.assertIn(json.dumps(column["name"]), expression)

    def test_calculated_columns_carry_no_serialised_metadata(self):
        for table in self.model["tables"]:
            for column in table.get("columns", []):
                if column.get("type") == "calculated":
                    self.assertNotIn("lineageTag:", text(column["expression"]), (table["name"], column["name"]))
        self.assertIn('{"Status", type text}', self.partition("Agents 365"))

    def test_glossary_matches_the_sort_checked_onelake_glossary(self):
        # test_onelake_source proves each Metric/Page maps to one sort order in this table.
        with zipfile.ZipFile(ONELAKE) as archive:
            onelake = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]
        mine = self.tables[GLOSSARY]
        theirs = next(table for table in onelake["tables"] if table["name"] == GLOSSARY)
        self.assertEqual(mine["partitions"][0]["source"], theirs["partitions"][0]["source"])
        self.assertEqual(
            {column["name"]: column.get("sortByColumn") for column in mine["columns"]},
            {column["name"]: column.get("sortByColumn") for column in theirs["columns"]},
        )

    def test_sharepoint_agent_inventory_is_not_modelled(self):
        self.assertNotIn("SharePoint Agents", self.tables)
        self.assertNotIn("Include SharePoint agent inventory", self.expressions)
        self.assertEqual(
            [c["name"] for c in self.tables[FACT]["columns"] if c["name"].startswith("SharePointAgent")], []
        )
        self.assertFalse(any(
            "SharePoint Agents" in (relationship["fromTable"], relationship["toTable"])
            for relationship in self.model["relationships"]
        ))

    def test_pinned_snapshot_manifest_guards_all_core_reads(self):
        rows = text(self.expressions["ValueLensDataverseRows"]["expression"])
        self.assertIn('#"Core Snapshot ID"', rows)
        self.assertIn('Manifest[status] <> "succeeded"', rows)
        self.assertIn('"poc_runid eq " & ODataText(SnapshotId)', rows)
        self.assertIn("Table.RowCount(Kept) <> ExpectedCount", rows)
        self.assertIn("Table.FromRecords(Records, Columns, MissingField.Error)", rows)
        self.assertNotIn("MissingField.UseNull", rows)

    def test_core_csv_parameters_are_not_required_in_dataverse_mode(self):
        for name in ("Copilot Interactions File", "Org Data File"):
            self.assertIn("IsParameterQueryRequired=false", text(self.expressions[name]["expression"]))

    def test_query_order_and_source_mapping_document_gaps(self):
        query_order = json.loads(next(
            annotation["value"] for annotation in self.model["annotations"] if annotation["name"] == "PBI_QueryOrder"
        ))
        for name in ("Dataverse URL", "Use SharePoint CSV fallback", "Core Snapshot ID"):
            self.assertIn(name, query_order)
        self.assertNotIn("SharePoint Agents", query_order)
        required = {item["modelTable"] for item in self.source_map["requiredFeeds"]}
        self.assertEqual(required, {FACT, "Copilot Licensed", "Chat + Agent Org Data"})
        gaps = {item["lane"]: item["status"] for item in self.source_map["documentedGaps"]}
        self.assertEqual(gaps["E"], "Implemented upstream; not read by the current report")
        self.assertEqual(gaps["C"], "Implemented with raw-payload extension")


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
