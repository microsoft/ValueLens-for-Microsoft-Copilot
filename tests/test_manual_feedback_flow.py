"""The manual-setup product feedback flow writes to OneLake as a signed-in person, with no secret."""
import json
from pathlib import Path
import unittest

FLOW = (Path(__file__).resolve().parents[1] / "1. Fabric" / "Manual setup" / "flows"
        / "Copilot_ProductFeedback_Email_to_OneLake.json")


def actions(node):
    for name, action in node.get("actions", {}).items():
        yield name, action
        yield from actions(action)
        yield from actions(action.get("else", {}))


class ManualFeedbackFlow(unittest.TestCase):
    def setUp(self):
        self.document = json.loads(FLOW.read_text(encoding="utf-8"))
        self.definition = self.document["definition"]

    def test_no_app_secret_or_key_vault(self):
        text = json.dumps(self.definition)
        for needle in ("ClientSecret", "ClientId", "ActiveDirectoryOAuth", "shared_keyvault"):
            self.assertNotIn(needle, text)

    def test_writes_through_the_onelake_connection(self):
        writes = {name: a for name, a in actions(self.definition) if name.endswith(("_PUT", "_PATCH"))}
        self.assertEqual(set(writes), {"Create_file_PUT", "Append_and_flush_PATCH"})
        for name, action in writes.items():
            self.assertEqual(action["type"], "OpenApiConnection", name)
            host = action["inputs"]["host"]
            self.assertEqual(host["apiId"], "/providers/Microsoft.PowerApps/apis/shared_webcontents", name)
            self.assertEqual(host["operationId"], "InvokeHttp", name)
            url = action["inputs"]["parameters"]["request/url"]
            self.assertTrue(url.startswith("https://onelake.dfs.fabric.microsoft.com/"), name)
        patch = writes["Append_and_flush_PATCH"]["inputs"]["parameters"]
        self.assertIn("action=append&position=0&flush=true", patch["request/url"])
        # The connector sends text, so the attachment's base64 is decoded first.
        self.assertTrue(patch["request/body"].startswith("@base64ToString("))


if __name__ == "__main__":
    unittest.main()
