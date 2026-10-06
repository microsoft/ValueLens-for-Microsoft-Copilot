"""Upload Router notebook: header detection and the signatures the installer writes."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "AnalyticsHub_Upload_Router.ipynb"
INSTALLER = ROOT / "1. Fabric" / "installer"

# Header rows as each export has them (made-up columns only, no tenant data).
HEADERS = {
    "productFeedback": "Feedback Id,Date submitted (UTC),Feedback type,App,Feedback",
    "agent365": "Agent name,Title ID,Publisher type,Availability",
    "studioTenant": "Billing plan id,Environment id,Capacity type,Prepaid consumed quantity,Usage date",
    "studioAgent": "Agent id,Agent name,Billed credit,Non billed credit,Channel",
    "studioUser": "User id,User email,Credits used,Billable credit used",
    "vivaCredits": "ServiceId,ServiceName,SpendingPolicyId,MetricDate,TotalCopilotCreditsUsed",
    "vivaPolicy": "SpendingPolicyId,Name,PlanLimit,UserLimit,IncludedServices",
    "workday": "Primary Work Email,Cost Center,Level",
}


def cells():
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    return notebook, ["".join(c["source"]) for c in notebook["cells"] if c["cell_type"] == "code"]


def namespace():
    _, code = cells()
    scope = {}
    exec(code[0], scope)  # config
    exec(code[1], scope)  # pure helpers
    return scope


class UploadRouterTests(unittest.TestCase):
    def test_notebook_is_clean(self):
        notebook, code = cells()
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
        for source in code:
            compile(source, str(NOTEBOOK), "exec")

    def test_every_export_is_recognised(self):
        s = namespace()
        sigs = json.loads(s["SIGNATURES_JSON"])
        self.assertEqual({sig["kind"] for sig in sigs}, set(HEADERS))
        for kind, line in HEADERS.items():
            with self.subTest(kind=kind):
                sig, reason = s["detect"](s["parse_header"](line + "\r\n1,2,3\r\n"), sigs)
                self.assertIsNotNone(sig, reason)
                self.assertEqual(sig["kind"], kind)

    def test_refusals(self):
        s = namespace()
        sigs = json.loads(s["SIGNATURES_JSON"])
        self.assertEqual(s["detect"]([], sigs), (None, "the file has no header row"))
        self.assertIn("matches no export", s["detect"](["Name", "Colour"], sigs)[1])
        tie = HEADERS["vivaPolicy"] + ",ServiceId,ServiceName,MetricDate,TotalCopilotCreditsUsed"
        self.assertIn("more than one export", s["detect"](s["parse_header"](tie), sigs)[1])
        skipped = s["detect"](s["parse_header"](HEADERS["workday"]), sigs, s["enabled_set"]("productFeedback"))
        self.assertIn("set to Skip", skipped[1])
        self.assertIsNone(s["enabled_set"](""))

    def test_header_parsing(self):
        s = namespace()
        self.assertEqual(s["parse_header"]('\ufeff"Feedback Id","a, ""b""",c\n1'), ["Feedback Id", 'a, "b"', "c"])
        self.assertEqual(s["parse_header"]("a;b;c\n"), ["a", "b", "c"])
        self.assertEqual(s["parse_header"](""), [])
        self.assertEqual(s["norm"]("Date Submitted (UTC)"), "datesubmittedutc")

    def test_targets(self):
        s = namespace()
        sigs = {sig["kind"]: sig for sig in json.loads(s["SIGNATURES_JSON"])}
        self.assertEqual(s["target_path"](sigs["agent365"], "X"), "Files/agent365/agents.csv")
        self.assertEqual(s["target_path"](sigs["productFeedback"], "20260601T000000Z_001"), "Files/product_feedback/feedback_20260601T000000Z_001.csv")
        self.assertEqual(s["kind_prefix"](sigs["vivaPolicy"]), "SpendingPolicyMetadata")
        self.assertEqual(s["file_key"]("a", 1, "2"), "a|1|2")
        self.assertEqual(s["DROP_DIR"], "Files/analytics_hub_uploads")
        self.assertTrue(s["SHAREPOINT_DIR"].startswith(s["DROP_DIR"] + "/"))

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_signatures_match_the_installer(self):
        script = "import('./src/uploads.js').then(m => process.stdout.write(m.routerSignaturesJson()))"
        out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=INSTALLER, capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(namespace()["SIGNATURES_JSON"]), json.loads(out))


if __name__ == "__main__":
    unittest.main()
