"""Refresh Model notebook: syncs the Lakehouse SQL endpoints before refreshing the semantic model."""
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "ValueLens_Refresh_Model.ipynb"
WS = "00000000-0000-0000-0000-0000000000aa"
FABRIC = f"https://api.fabric.microsoft.com/v1/workspaces/{WS}"


class Response:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.content = b"" if body is None else json.dumps(body).encode()
        self.text = self.content.decode()

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeApi:
    """Answers the Fabric and Power BI calls the notebook makes and records them in order."""

    def __init__(self, endpoints, sync=None, refresh=None):
        self.endpoints = endpoints
        self.sync = sync or (lambda endpoint_id: Response(200, {"value": []}))
        self.refresh = refresh or {"status": "Completed"}
        self.calls = []

    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(("GET", url))
        if url == f"{FABRIC}/sqlEndpoints":
            return self.endpoints if isinstance(self.endpoints, Response) else Response(200, {"value": self.endpoints})
        if url.startswith("https://operations/"):
            return Response(200, {"status": "Succeeded"})
        if url.endswith("/refreshes"):
            return Response(200, {"value": [{"status": "Completed"}]})
        return Response(200, self.refresh)

    def post(self, url, headers=None, json=None, timeout=None):
        self.calls.append(("POST", url))
        if url.endswith("/refreshMetadata"):
            return self.sync(url.split("/")[-2])
        return Response(202, headers={"Location": url + "/r1"})


def run_notebook(api):
    cells = ["".join(c["source"]) for c in json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"] if c["cell_type"] == "code"]
    notebookutils = types.ModuleType("notebookutils")
    notebookutils.credentials = types.SimpleNamespace(getToken=lambda audience: "token")
    requests = types.ModuleType("requests")
    requests.get, requests.post = api.get, api.post
    scope = {}
    with mock.patch.dict(sys.modules, {"notebookutils": notebookutils, "requests": requests}), \
            mock.patch("time.sleep"), mock.patch("builtins.print"):
        exec(cells[0], scope)
        scope.update(WORKSPACE_ID=WS, SEMANTIC_MODEL_ID="model")
        exec(cells[1], scope)
    return [(method, url) for method, url in api.calls if method == "POST"]


class RefreshModelTests(unittest.TestCase):
    def test_notebook_is_clean(self):
        notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
                compile("".join(cell["source"]), str(NOTEBOOK), "exec")

    def test_syncs_sql_endpoints_before_refreshing(self):
        api = FakeApi([
            {"id": "lh", "displayName": "Analytics_Hub_LH"},
            {"id": "staging", "displayName": "StagingLakehouseForDataflows_20260101"},
        ])
        posts = run_notebook(api)
        self.assertEqual(posts[0], ("POST", f"{FABRIC}/sqlEndpoints/lh/refreshMetadata"))
        self.assertTrue(posts[1][1].endswith("/datasets/model/refreshes"))
        self.assertNotIn(("POST", f"{FABRIC}/sqlEndpoints/staging/refreshMetadata"), posts)

    def test_waits_for_a_long_running_sync(self):
        api = FakeApi([{"id": "lh", "displayName": "LH"}],
                      sync=lambda _: Response(202, headers={"Location": "https://operations/1", "Retry-After": "1"}))
        run_notebook(api)
        self.assertIn(("GET", "https://operations/1"), api.calls)
        poll = api.calls.index(("GET", "https://operations/1"))
        refresh = next(i for i, (m, u) in enumerate(api.calls) if m == "POST" and u.endswith("/refreshes"))
        self.assertLess(poll, refresh)

    def test_a_failed_sync_does_not_stop_the_refresh(self):
        for api in (FakeApi(Response(403, {"error": "Forbidden"})),
                    FakeApi([{"id": "lh", "displayName": "LH"}], sync=lambda _: Response(500, {"error": "boom"}))):
            with self.subTest(calls=api.endpoints):
                posts = run_notebook(api)
                self.assertTrue(posts[-1][1].endswith("/datasets/model/refreshes"))

    def test_a_completed_refresh_with_a_warning_fails(self):
        # A calculated table whose DAX does not parse is only a Warning, and the refresh still
        # ends Completed. Nothing that depends on it is calculated, so the notebook must fail.
        warning = {"type": "Warning", "code": "0x413A0013",
                   "message": "The syntax for 'LastDate' is incorrect."}
        for body in ({"status": "Completed", "messages": [warning]},
                     {"status": "Completed", "messages": [dict(warning, type="Error")]},
                     {"status": "Failed", "messages": [{"message": "boom"}]}):
            with self.subTest(body=body):
                with self.assertRaises(RuntimeError) as raised:
                    run_notebook(FakeApi([], refresh=body))
                self.assertIn(body["messages"][0]["message"], str(raised.exception))

    def test_a_completed_refresh_with_only_information_messages_passes(self):
        info = {"type": "Information", "message": "Partition processed."}
        posts = run_notebook(FakeApi([], refresh={"status": "Completed", "messages": [info]}))
        self.assertTrue(posts[-1][1].endswith("/datasets/model/refreshes"))


if __name__ == "__main__":
    unittest.main()
