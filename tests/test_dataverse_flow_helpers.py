"""Unit tests for the Power Automate + Dataverse raw-retention adapter (Prepare-CollectorRawCapture.py).

All fixtures are SYNTHETIC and shaped from the observed public solution structure. No private/complete
collector flow definition, no real tenant identifiers, and no real audit payloads are copied here. Tests
cover: required/missing paths, managed-source refusal, unsupported-version detection (no blind text
replacement), successful injection semantics, repo-containment enforcement of the private output,
idempotence, and provenance emission.
"""
import importlib.util
import json
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "4. Power Automate + Dataverse" / "scripts" / "Prepare-CollectorRawCapture.py"

_spec = importlib.util.spec_from_file_location("prepare_collector_raw_capture", TOOL)
prep = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prep)


SOLUTION_XML = """<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive">
  <SolutionManifest>
    <UniqueName>{unique}</UniqueName>
    <Version>{version}</Version>
    <Managed>{managed}</Managed>
    <Publisher>
      <UniqueName>ProofOfConcept</UniqueName>
      <CustomizationPrefix>{prefix}</CustomizationPrefix>
    </Publisher>
    <RootComponents>
      <RootComponent type="29" id="{{aaaaaaaa-0000-0000-0000-000000000001}}" behavior="0" />
    </RootComponents>
  </SolutionManifest>
</ImportExportXml>
"""

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="xml" ContentType="application/octet-stream" />'
    '<Default Extension="json" ContentType="application/json" />'
    "</Types>"
)

CUSTOMIZATIONS_XML = (
    '<?xml version="1.0" encoding="utf-8"?>'
    "<ImportExportXml><Workflows><Workflow WorkflowId=\"{aaaaaaaa-0000-0000-0000-000000000001}\" "
    'Name="Synthetic Flow"><JsonFileName>/Workflows/Flow.json</JsonFileName></Workflow>'
    "</Workflows></ImportExportXml>"
)


def _summary_upsert():
    return {
        "runAfter": {"Compose_Resources": ["Succeeded"]},
        "type": "OpenApiConnection",
        "inputs": {
            "parameters": {
                "entityName": "poc_copilotinteractions",
                "recordId": "@items('For_each_1')?['id']",
                "item/poc_auditlogid": "@items('For_each_1')?['id']",
                "item/poc_resources": "@if(greater(length(outputs('Compose_Resources')), 4000), substring(outputs('Compose_Resources'), 0, 4000), outputs('Compose_Resources'))",
            },
            "host": {
                "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                "connectionName": "shared_commondataserviceforapps-1",
                "operationId": "UpdateRecord",
            },
        },
    }


def build_workflow(with_summary=True):
    loop_actions = {}
    if with_summary:
        loop_actions["Upsert_a_row_2"] = _summary_upsert()
        loop_actions["Increment_UpsertedCount"] = {
            "runAfter": {"Upsert_a_row_2": ["Succeeded"]},
            "type": "IncrementVariable",
            "inputs": {"name": "varUpsertedCount", "value": 1},
        }
        loop_actions["Compose_Resources"] = {"type": "Compose", "inputs": "@join(json('[]'), '; ')"}
    else:
        # A structurally different flow that must NOT be blindly patched.
        loop_actions["Do_Something_Else"] = {
            "type": "OpenApiConnection",
            "inputs": {
                "parameters": {"entityName": "poc_somethingelse"},
                "host": {
                    "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                    "connectionName": "shared_commondataserviceforapps-1",
                    "operationId": "CreateRecord",
                },
            },
        }
    return {
        "properties": {
            "connectionReferences": {
                "shared_commondataserviceforapps-1": {
                    "api": {"name": "shared_commondataserviceforapps"},
                    "connection": {"connectionReferenceLogicalName": "poc_sharedcommondataserviceforapps_2dd46"},
                    "runtimeSource": "embedded",
                }
            },
            "definition": {
                "$schema": "https://schema.management.azure.com/",
                "triggers": {"Recurrence": {"type": "Recurrence"}},
                "actions": {
                    "AuditLogQueryRecordsURL": {
                        "type": "InitializeVariable",
                        "inputs": {
                            "variables": [
                                {"name": "AuditLogQueryRecordsURL", "type": "string", "value": "@{null}"}
                            ]
                        },
                    },
                    "RetryLogic-StartAuditLogQuery": {
                        "type": "Until",
                        "expression": "@equals(outputs('AuditLogQuery')['statusCode'], 201)",
                        "limit": {"count": 5, "timeout": "PT5M"},
                        "actions": {"AuditLogQuery": {"type": "Http", "inputs": {"method": "POST"}}},
                    },
                    "WaitUntilQueryFinished": {
                        "type": "Until",
                        "expression": "@equals(body('ParseBody-QueryStatus')?['status'], 'succeeded')",
                        "limit": {"count": 300, "timeout": "PT3H"},
                        "actions": {},
                    },
                    "Set-InitialAuditLogQueryRecordsURL": {
                        "type": "SetVariable",
                        "inputs": {
                            "name": "AuditLogQueryRecordsURL",
                            "value": "https://graph.microsoft.com/beta/security/auditLog/queries/@{variables('AuditLogQueryID')}/records?$top=500",
                        },
                    },
                    "Scope-AuditLogRecords": {
                        "type": "Scope",
                        "actions": {
                            "ProcessAuditLogRecords": {
                                "type": "Until",
                                "expression": "@equals(length(variables('AuditLogQueryRecordsURL')), 0)",
                                "limit": {"count": 1000, "timeout": "PT10H"},
                                "actions": {
                                    "RetryLogic-AuditLogRecords": {
                                        "type": "Until",
                                        "expression": "@equals(outputs('AuditLogRecords')['statusCode'], 200)",
                                        "limit": {"count": 5, "timeout": "PT10M"},
                                        "actions": {
                                            "AuditLogRecords": {"type": "Http", "inputs": {"method": "GET"}}
                                        },
                                    },
                                    "ParseBody-AuditLogRecords": {
                                        "type": "ParseJson",
                                        "inputs": {
                                            "content": "@body('AuditLogRecords')",
                                            "schema": {
                                                "type": "object",
                                                "properties": {
                                                    "@@odata.nextLink": {"type": "string"},
                                                    "value": {"type": "array"},
                                                },
                                            },
                                        },
                                    },
                                    "For_each_1": {
                                        "type": "Foreach",
                                        "foreach": "@body('ParseBody-AuditLogRecords')?['value']",
                                        "runAfter": {"ParseBody-AuditLogRecords": ["Succeeded"]},
                                        "actions": loop_actions,
                                    },
                                    "Set-AuditLogQueryRecordsURL": {
                                        "type": "SetVariable",
                                        "runAfter": {"For_each_1": ["Succeeded"]},
                                        "inputs": {
                                            "name": "AuditLogQueryRecordsURL",
                                            "value": "@body('ParseBody-AuditLogRecords')?['@odata.nextLink']",
                                        },
                                    },
                                    "Add_Records_Retrieved_to_Flow_Log": {
                                        "type": "OpenApiConnection",
                                        "runAfter": {
                                            "Set-AuditLogQueryRecordsURL": ["Succeeded", "Skipped"]
                                        },
                                        "inputs": {
                                            "parameters": {"entityName": "poc_copilotinteractionflowrunses"},
                                            "host": {
                                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                                                "connectionName": "shared_commondataserviceforapps-1",
                                                "operationId": "UpdateOnlyRecord",
                                            },
                                        },
                                    },
                                },
                            }
                        },
                    }
                },
            },
        },
        "schemaVersion": "1.0.0.0",
    }


def write_solution_zip(path, *, unique="CopilotInteractionLogging", version="1.0.0.8", managed="0",
                       prefix="poc", with_summary=True, extra_workflow_json=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr(
            "solution.xml",
            SOLUTION_XML.format(unique=unique, version=version, managed=managed, prefix=prefix),
        )
        archive.writestr("customizations.xml", CUSTOMIZATIONS_XML)
        flow = extra_workflow_json if extra_workflow_json is not None else build_workflow(with_summary)
        archive.writestr("Workflows/Flow.json", json.dumps(flow))
    return path


class PrepareRawCaptureTests(unittest.TestCase):
    def setUp(self):
        # Scratch is created OUTSIDE the repository (a sibling of the repo root) so the tool's
        # repo-containment guard is exercised realistically and nothing lands in git.
        self.repo_root = ROOT
        self.outside = ROOT.parent / "_pa_dv_test_out"
        self.outside.mkdir(parents=True, exist_ok=True)
        self.source = self.outside / "source.zip"
        self.out = self.outside / "adapted.zip"
        for leftover in self.outside.glob("*"):
            if leftover.is_file():
                leftover.unlink()

    def tearDown(self):
        if self.outside.exists():
            for path in sorted(self.outside.rglob("*"), reverse=True):
                if path.is_file():
                    path.unlink()
                else:
                    path.rmdir()
            self.outside.rmdir()

    # -- negative: missing/invalid paths ------------------------------------------------
    def test_missing_source_zip_fails(self):
        with self.assertRaisesRegex(prep.PrepareError, "not found"):
            prep.adapt_zip(self.outside / "nope.zip", self.out, repo_root=self.repo_root)

    def test_output_inside_repo_is_refused(self):
        write_solution_zip(self.source)
        inside = self.repo_root / "4. Power Automate + Dataverse" / "processed" / "should-not-write.zip"
        with self.assertRaisesRegex(prep.PrepareError, "inside the repository"):
            prep.adapt_zip(self.source, inside, repo_root=self.repo_root)
        self.assertFalse(inside.exists())

    def test_existing_output_requires_overwrite(self):
        write_solution_zip(self.source)
        self.out.write_bytes(b"existing")
        with self.assertRaisesRegex(prep.PrepareError, "already exists"):
            prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)

    # -- negative: manifest validation --------------------------------------------------
    def test_managed_source_is_refused(self):
        write_solution_zip(self.source, managed="1")
        with self.assertRaisesRegex(prep.UnsupportedSourceError, "Managed"):
            prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)

    def test_unknown_solution_name_is_refused(self):
        write_solution_zip(self.source, unique="SomeOtherSolution")
        with self.assertRaisesRegex(prep.UnsupportedSourceError, "Unsupported source solution"):
            prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)

    def test_unexpected_publisher_prefix_is_refused(self):
        write_solution_zip(self.source, prefix="xyz")
        with self.assertRaisesRegex(prep.UnsupportedSourceError, "publisher prefix"):
            prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)

    # -- negative: unsupported flow shape (no blind replacement) ------------------------
    def test_unsupported_flow_shape_fails_without_output(self):
        write_solution_zip(self.source, with_summary=False)
        with self.assertRaisesRegex(prep.UnsupportedSourceError, "No workflow"):
            prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)
        self.assertFalse(self.out.exists())

    def test_solution_without_workflows_fails(self):
        with zipfile.ZipFile(self.source, "w") as archive:
            archive.writestr("[Content_Types].xml", CONTENT_TYPES)
            archive.writestr(
                "solution.xml",
                SOLUTION_XML.format(unique="CopilotInteractionLogging", version="1.0.0.8", managed="0", prefix="poc"),
            )
        with self.assertRaisesRegex(prep.UnsupportedSourceError, "no Workflows"):
            prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)

    # -- positive: injection semantics --------------------------------------------------
    def _adapt_and_load_flow(self):
        provenance = prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)
        with zipfile.ZipFile(self.out) as archive:
            flow = json.loads(archive.read("Workflows/Flow.json"))
            solution_xml = archive.read("solution.xml").decode("utf-8")
        loop = (
            flow["properties"]["definition"]["actions"]["Scope-AuditLogRecords"]["actions"]
            ["ProcessAuditLogRecords"]["actions"]["For_each_1"]["actions"]
        )
        return provenance, flow, loop, solution_xml

    def test_injection_adds_raw_actions_with_expected_wiring(self):
        write_solution_zip(self.source)
        provenance, _flow, loop, solution_xml = self._adapt_and_load_flow()

        self.assertIn(prep.COMPOSE_ACTION, loop)
        self.assertIn(prep.RAW_ACTION, loop)
        # Summary upsert preserved unchanged.
        self.assertEqual(loop["Upsert_a_row_2"]["inputs"]["parameters"]["entityName"], "poc_copilotinteractions")
        # Raw runs before the summary upsert so summary failures cannot skip retention.
        self.assertEqual(loop[prep.COMPOSE_ACTION]["runAfter"], {"Compose_Resources": ["Succeeded"]})
        self.assertEqual(loop[prep.RAW_ACTION]["runAfter"], {prep.COMPOSE_ACTION: ["Succeeded"]})
        self.assertEqual(loop["Upsert_a_row_2"]["runAfter"], {prep.RAW_ACTION: ["Succeeded"]})
        # Success counter only increments after raw retention and summary upsert succeed.
        self.assertEqual(loop["Increment_UpsertedCount"]["runAfter"], {"Upsert_a_row_2": ["Succeeded"]})

        raw_params = loop[prep.RAW_ACTION]["inputs"]["parameters"]
        self.assertEqual(raw_params["entityName"], "poc_valuelensrawaudits")
        self.assertEqual(raw_params["recordId"], "@items('For_each_1')?['id']")
        self.assertEqual(raw_params["item/poc_rowkey"], "@{toLower(items('For_each_1')?['id'])}")
        self.assertEqual(raw_params["item/poc_payloadjson"], f"@outputs('{prep.COMPOSE_ACTION}')")
        # Flow must not fabricate a SHA-256 content hash.
        self.assertNotIn("item/poc_payloadhash", raw_params)
        # Full, untruncated payload capture.
        self.assertEqual(loop[prep.COMPOSE_ACTION]["inputs"], "@string(items('For_each_1'))")

        # Secure the payload-bearing actions. A Compose only supports securing "inputs"
        # (Power Automate rejects "outputs" on a Compose at activation); the downstream
        # OpenApiConnection upsert secures both inputs and outputs.
        compose_secure = loop[prep.COMPOSE_ACTION]["runtimeConfiguration"]["secureData"]["properties"]
        self.assertEqual(set(compose_secure), {"inputs"})
        raw_secure = loop[prep.RAW_ACTION]["runtimeConfiguration"]["secureData"]["properties"]
        self.assertEqual(set(raw_secure), {"inputs", "outputs"})

        # Regression: injected descriptions must stay within the 256-char activation limit,
        # and a Compose must never request "outputs" securing (both blocked live activation).
        for name in (prep.COMPOSE_ACTION, prep.RAW_ACTION):
            desc = loop[name].get("description") or ""
            self.assertLessEqual(len(desc), prep.DESCRIPTION_MAX, f"{name} description too long")
        self.assertNotIn(
            "outputs",
            loop[prep.COMPOSE_ACTION]["runtimeConfiguration"]["secureData"]["properties"],
        )

        # Solution version bumped, still unmanaged.
        self.assertIn("<Version>1.0.0.9</Version>", solution_xml)
        self.assertIn("<Managed>0</Managed>", solution_xml)

    def test_provenance_written_outside_repo_with_hashes(self):
        write_solution_zip(self.source)
        provenance, _flow, _loop, _xml = self._adapt_and_load_flow()
        prov_path = Path(provenance["provenancePath"])
        self.assertTrue(prov_path.exists())
        self.assertFalse(prep.is_within(prov_path, self.repo_root))
        self.assertEqual(len(provenance["source"]["sha256"]), 64)
        self.assertEqual(len(provenance["output"]["sha256"]), 64)
        self.assertEqual(provenance["output"]["version"], "1.0.0.9")
        self.assertEqual(provenance["injected"]["idempotenceKeyExpression"], "toLower(items('For_each_1')?['id'])")
        self.assertFalse(provenance["injected"]["payloadHashSetByFlow"])
        self.assertTrue(provenance["injected"]["recordPagingHardened"])
        self.assertTrue(any("Deploy order" in w for w in provenance["warnings"]))

    def test_record_paging_loop_is_bounded_and_fail_closed(self):
        write_solution_zip(self.source)
        _provenance, flow, _loop, _solution_xml = self._adapt_and_load_flow()
        actions = flow["properties"]["definition"]["actions"]
        self.assertEqual(actions["RetryLogic-StartAuditLogQuery"]["limit"], {"count": 3, "timeout": "PT3M"})
        self.assertEqual(actions["WaitUntilQueryFinished"]["limit"], {"count": 60, "timeout": "PT3M"})
        self.assertEqual(
            actions["Set-InitialAuditLogQueryRecordsURL"]["inputs"]["value"].split("$top=")[1],
            "100",
        )
        self.assertEqual(
            actions["AuditLogQueryRecordsURL"]["inputs"]["variables"][0]["value"],
            "",
        )
        paging = actions["Scope-AuditLogRecords"]["actions"]["ProcessAuditLogRecords"]
        self.assertEqual(paging["limit"], {"count": 100, "timeout": "PT3M"})
        inner = paging["actions"]
        self.assertEqual(inner["RetryLogic-AuditLogRecords"]["limit"], {"count": 3, "timeout": "PT3M"})
        self.assertEqual(
            inner["ParseBody-AuditLogRecords"]["inputs"]["schema"]["properties"]["@@odata.nextLink"]["type"],
            ["string", "null"],
        )
        self.assertEqual(
            inner["Set-AuditLogQueryRecordsURL"]["inputs"]["value"],
            "@{coalesce(body('ParseBody-AuditLogRecords')?['@odata.nextLink'], '')}",
        )
        self.assertEqual(
            inner["Add_Records_Retrieved_to_Flow_Log"]["runAfter"],
            {"Set-AuditLogQueryRecordsURL": ["Succeeded"]},
        )
        self.assertEqual(
            inner[prep.FLAG_RECORD_ERROR_ACTION]["runAfter"],
            {"For_each_1": ["Failed", "TimedOut"]},
        )
        self.assertEqual(
            inner[prep.STOP_PAGING_ON_RECORD_ERROR_ACTION]["runAfter"],
            {prep.FLAG_RECORD_ERROR_ACTION: ["Succeeded"]},
        )
        self.assertEqual(
            inner[prep.STOP_PAGING_ON_RECORD_ERROR_ACTION]["inputs"],
            {"name": "AuditLogQueryRecordsURL", "value": ""},
        )
        fail_action = actions["Scope-AuditLogRecords"]["actions"][prep.RECORD_PROCESSING_FAILURE_ACTION]
        self.assertEqual(
            fail_action["runAfter"],
            {"ProcessAuditLogRecords": ["Succeeded", "Failed", "TimedOut"]},
        )
        self.assertEqual(fail_action["type"], "If")
        self.assertIn("varRecordErrorCount", fail_action["expression"])
        self.assertEqual(
            fail_action["actions"]["Terminate_Record_Processing_Failed"]["inputs"]["runStatus"],
            "Failed",
        )
        self.assertEqual(
            actions["Scope-AuditLogRecords"]["actions"][prep.RECORD_PROCESSING_FAILURE_ACTION]["runAfter"],
            {"ProcessAuditLogRecords": ["Succeeded", "Failed", "TimedOut"]},
        )

    def test_existing_adapted_flow_can_be_rewired_without_private_data(self):
        flow = build_workflow()
        loop = (
            flow["properties"]["definition"]["actions"]["Scope-AuditLogRecords"]["actions"]
            ["ProcessAuditLogRecords"]["actions"]["For_each_1"]["actions"]
        )
        loop.update(prep._build_raw_actions("shared_commondataserviceforapps-1", {"Upsert_a_row_2": ["Succeeded"]}))
        loop[prep.RAW_ACTION]["inputs"]["parameters"]["recordId"] = "poc_rowkey='@{toLower(items('For_each_1')?['id'])}'"
        loop["Increment_UpsertedCount"]["runAfter"] = {prep.RAW_ACTION: ["Succeeded"]}

        self.assertTrue(prep.rewire_raw_retention_before_summary(flow))
        self.assertEqual(loop[prep.COMPOSE_ACTION]["runAfter"], {"Compose_Resources": ["Succeeded"]})
        self.assertEqual(loop["Upsert_a_row_2"]["runAfter"], {prep.RAW_ACTION: ["Succeeded"]})
        self.assertEqual(loop["Increment_UpsertedCount"]["runAfter"], {"Upsert_a_row_2": ["Succeeded"]})
        self.assertEqual(loop[prep.RAW_ACTION]["inputs"]["parameters"]["recordId"], "@items('For_each_1')?['id']")
        self.assertTrue(prep.harden_audit_record_paging(flow))
        self.assertEqual(
            flow["properties"]["definition"]["actions"]["Scope-AuditLogRecords"]["actions"]
            ["ProcessAuditLogRecords"]["limit"],
            {"count": 100, "timeout": "PT3M"},
        )

    def test_second_run_detects_already_patched(self):
        write_solution_zip(self.source)
        prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)
        # Re-run using the adapted zip as the source: it must refuse to double-inject.
        with self.assertRaises(prep.AlreadyPatchedError):
            prep.adapt_zip(self.out, self.outside / "twice.zip", repo_root=self.repo_root)

    def test_solution_rename_applies_and_warns(self):
        write_solution_zip(self.source)
        provenance = prep.adapt_zip(
            self.source, self.out, repo_root=self.repo_root, solution_name="CopilotInteractionLoggingRaw"
        )
        with zipfile.ZipFile(self.out) as archive:
            solution_xml = archive.read("solution.xml").decode("utf-8")
        self.assertIn("<UniqueName>CopilotInteractionLoggingRaw</UniqueName>", solution_xml)
        self.assertEqual(provenance["output"]["uniqueName"], "CopilotInteractionLoggingRaw")
        self.assertTrue(any("clean/isolated environment" in w for w in provenance["warnings"]))

    def test_no_private_raw_publication_in_repo(self):
        # Guard against accidental artefacts: the adapter must never create files under the repo.
        write_solution_zip(self.source)
        before = {p for p in (self.repo_root / "4. Power Automate + Dataverse").rglob("*") if p.is_file()}
        prep.adapt_zip(self.source, self.out, repo_root=self.repo_root)
        after = {p for p in (self.repo_root / "4. Power Automate + Dataverse").rglob("*") if p.is_file()}
        self.assertEqual(before, after)


class ManifestHelperTests(unittest.TestCase):
    def test_bump_version(self):
        self.assertEqual(prep.bump_version("1.0.0.8"), "1.0.0.9")
        self.assertEqual(prep.bump_version("2.3.10"), "2.3.11")

    def test_bump_version_rejects_non_numeric(self):
        with self.assertRaises(prep.UnsupportedSourceError):
            prep.bump_version("1.0.preview")

    def test_parse_manifest_reads_fields(self):
        manifest = prep.parse_solution_manifest(
            SOLUTION_XML.format(unique="CopilotInteractionLogging", version="1.0.0.8", managed="0", prefix="poc")
        )
        self.assertEqual(manifest.unique_name, "CopilotInteractionLogging")
        self.assertEqual(manifest.version, "1.0.0.8")
        self.assertFalse(manifest.managed)
        self.assertEqual(manifest.publisher_prefix, "poc")


if __name__ == "__main__":
    unittest.main()
