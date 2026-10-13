"""Offline tests for the Graph retry helper in the Licensed users and Org data ingesters.

A large tenant's pull runs long enough to meet throttling (429), brief outages (5xx) and token
expiry; one bad response must not fail the whole load.
"""
import unittest

from notebook_source import namespace

NOTEBOOKS = (
    "Copilot_Licensed_Users_Direct_Ingester.ipynb",
    "Copilot_Org_Data_Direct_Ingester.ipynb",
)


class HTTPError(Exception):
    pass


class FakeResponse:
    def __init__(self, status, retry_after=None):
        self.status_code = status
        self.headers = {} if retry_after is None else {"Retry-After": retry_after}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPError(self.status_code)


class FakeRequests:
    class ConnectionError(Exception):
        pass

    class Timeout(Exception):
        pass

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(dict(headers))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeTime:
    def __init__(self):
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)


def helper(notebook, outcomes):
    ns = namespace(notebook, keep_assigns={"GRAPH_MAX_ATTEMPTS", "GRAPH_MAX_WAIT_SEC", "MAX_ORG_LEVELS"})
    fake = FakeRequests(outcomes)
    clock = FakeTime()
    tokens = iter(["fresh-1", "fresh-2"])
    ns.update(
        requests=fake,
        time=clock,
        token="old",
        headers={"Authorization": "Bearer old"},
        TENANT_ID="t",
        CLIENT_ID="c",
        CLIENT_SECRET="s",
        get_graph_token=lambda *_: next(tokens),
    )
    return ns, fake, clock


class GraphRetryTests(unittest.TestCase):
    def test_a_good_response_is_returned_without_waiting(self):
        for nb in NOTEBOOKS:
            with self.subTest(nb):
                ns, fake, clock = helper(nb, [FakeResponse(200)])
                self.assertEqual(ns["graph_get"]("u").status_code, 200)
                self.assertEqual((len(fake.calls), clock.sleeps), (1, []))

    def test_throttling_waits_for_retry_after_capped(self):
        for nb in NOTEBOOKS:
            with self.subTest(nb):
                ns, fake, clock = helper(nb, [FakeResponse(429, "7"), FakeResponse(429, "9999"), FakeResponse(200)])
                self.assertEqual(ns["graph_get"]("u").status_code, 200)
                self.assertEqual(clock.sleeps, [7.0, ns["GRAPH_MAX_WAIT_SEC"]])

    def test_server_errors_and_dropped_connections_back_off(self):
        for nb in NOTEBOOKS:
            with self.subTest(nb):
                outcomes = [FakeResponse(503), FakeRequests.ConnectionError(), FakeResponse(200)]
                ns, fake, clock = helper(nb, outcomes)
                self.assertEqual(ns["graph_get"]("u").status_code, 200)
                self.assertEqual(clock.sleeps, [10, 20])

    def test_an_expired_token_is_renewed_once_and_later_pages_use_it(self):
        for nb in NOTEBOOKS:
            with self.subTest(nb):
                ns, fake, clock = helper(nb, [FakeResponse(401), FakeResponse(200), FakeResponse(200)])
                ns["graph_get"]("page-1")
                ns["graph_get"]("page-2")
                self.assertEqual(
                    [c["Authorization"] for c in fake.calls],
                    ["Bearer old", "Bearer fresh-1", "Bearer fresh-1"],
                )
                self.assertEqual(clock.sleeps, [])

    def test_a_second_401_is_a_real_permission_error(self):
        for nb in NOTEBOOKS:
            with self.subTest(nb):
                ns, fake, _ = helper(nb, [FakeResponse(401), FakeResponse(401)])
                with self.assertRaises(HTTPError):
                    ns["graph_get"]("u")
                self.assertEqual(len(fake.calls), 2)

    def test_client_errors_fail_at_once(self):
        for nb in NOTEBOOKS:
            with self.subTest(nb):
                ns, fake, clock = helper(nb, [FakeResponse(403)])
                with self.assertRaises(HTTPError):
                    ns["graph_get"]("u")
                self.assertEqual((len(fake.calls), clock.sleeps), (1, []))

    def test_it_gives_up_after_the_last_attempt(self):
        for nb in NOTEBOOKS:
            with self.subTest(nb):
                ns, fake, clock = helper(nb, [FakeResponse(503)] * 10)
                with self.assertRaises(HTTPError):
                    ns["graph_get"]("u")
                self.assertEqual(len(fake.calls), ns["GRAPH_MAX_ATTEMPTS"])
                self.assertEqual(len(clock.sleeps), ns["GRAPH_MAX_ATTEMPTS"] - 1)

    def test_every_graph_call_goes_through_the_helper(self):
        import json

        from notebook_source import NOTEBOOKS as DIR

        for nb in NOTEBOOKS:
            with self.subTest(nb):
                cells = json.loads((DIR / nb).read_text(encoding="utf-8"))["cells"]
                code = "".join("".join(c["source"]) for c in cells if c["cell_type"] == "code")
                self.assertEqual(code.count("requests.get("), 1, "only graph_get should call requests.get")
                self.assertIn("r = graph_get(", code)


if __name__ == "__main__":
    unittest.main()
