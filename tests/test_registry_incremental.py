"""Mocked tests for the incremental, parallel Agent 365 registry pull.

No network and no Spark: helpers are lifted out of the notebook cells by name and
Graph is replaced with in-memory fakes.
"""
import ast
import json
import threading
import time as _real_time
import unittest
from datetime import datetime, timedelta, timezone

from test_snapshot_safety import FakeClock, FakeResponse, code_from_cell, extract

NOTEBOOK = "Copilot_Agent365_Registry_Ingester.ipynb"
NOW = datetime(2026, 10, 6, 6, 0, tzinfo=timezone.utc)
NOW_ISO = "2026-10-06T06:00:00Z"


def detail_helpers():
    ns = extract(
        NOTEBOOK,
        6,
        functions=(
            "_package_id", "_list_modified", "_parse_utc", "_iso_utc",
            "_select_detail_targets", "_merge_fresh", "_merge_cached",
            "_fetch_details", "_assemble_details", "_cache_from_rows", "_cache_to_rows",
        ),
        import_names=("_json", "ThreadPoolExecutor", "as_completed", "datetime", "timedelta", "timezone"),
    )
    return ns


class ScriptedRequests:
    """requests stand-in: token endpoint plus a scripted list of Graph responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.minted = 0
        self.calls = []
        self.lock = threading.Lock()

    def post(self, url, data=None, timeout=None):
        with self.lock:
            self.minted += 1
            n = self.minted
        _real_time.sleep(0.01)          # widen the race window for the lock test
        return FakeResponse(200, {"access_token": f"token-{n}", "expires_in": 3600})

    def request(self, method, url, headers=None, **kwargs):
        with self.lock:
            self.calls.append((method, url, dict(headers or {})))
            item = self.responses.pop(0) if self.responses else 200
        if isinstance(item, tuple):
            status, retry_after = item
            response = FakeResponse(status)
            response.headers = {"Retry-After": retry_after}
            return response
        return FakeResponse(item)


def graph_client(responses, max_retries=6):
    ns = extract(
        NOTEBOOK,
        2,
        functions=("_get_graph_token", "graph_headers", "_retry_delay", "graph_request"),
        assigns=("_TOKEN_CACHE", "_TOKEN_LOCK", "RETRY_STATUSES", "MAX_RETRIES"),
        import_names={"threading", "random"},
    )
    fake, clock = ScriptedRequests(responses), FakeClock()
    ns.update(requests=fake, time=clock, TENANT_ID="t", CLIENT_ID="c", CLIENT_SECRET="s",
              MAX_RETRIES=max_retries)
    return ns, fake, clock


class GraphRetryTests(unittest.TestCase):
    def test_throttled_calls_are_retried_honouring_retry_after(self):
        ns, fake, clock = graph_client([(429, "7"), (503, "2"), 200])
        response = ns["graph_request"]("GET", "https://graph/x")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(fake.calls), 3)
        self.assertEqual(clock.slept, [7.0, 2.0])

    def test_504_without_retry_after_backs_off_exponentially(self):
        ns, fake, clock = graph_client([504, 504, 200])
        self.assertEqual(ns["graph_request"]("GET", "https://graph/x").status_code, 200)
        self.assertEqual(len(clock.slept), 2)
        self.assertTrue(1.0 <= clock.slept[0] < 2.0 and 2.0 <= clock.slept[1] < 3.0, clock.slept)

    def test_retries_stop_at_the_cap_and_surface_the_last_status(self):
        ns, fake, _ = graph_client([429] * 10, max_retries=3)
        self.assertEqual(ns["graph_request"]("GET", "https://graph/x").status_code, 429)
        self.assertEqual(len(fake.calls), 4, "1 call + 3 retries")

    def test_non_retryable_errors_are_not_retried(self):
        for status in (400, 403, 404, 500):
            ns, fake, clock = graph_client([status])
            self.assertEqual(ns["graph_request"]("GET", "https://graph/x").status_code, status)
            self.assertEqual(len(fake.calls), 1, status)
            self.assertEqual(clock.slept, [])

    def test_absurd_retry_after_is_capped(self):
        ns, _, clock = graph_client([(429, "86400"), 200])
        ns["graph_request"]("GET", "https://graph/x")
        self.assertEqual(clock.slept, [120.0])

    def test_concurrent_401s_mint_one_new_token_not_one_per_worker(self):
        ns, fake, _ = graph_client([])
        ns["time"] = _real_time
        ns["_get_graph_token"]()                                    # token-1 cached
        self.assertEqual(fake.minted, 1)
        barrier = threading.Barrier(8)

        def worker():
            barrier.wait()
            ns["_get_graph_token"](True, "token-1")                # every worker saw token-1 rejected

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(fake.minted, 2, "the lock must collapse eight refreshes into one")
        self.assertEqual(ns["_TOKEN_CACHE"]["value"], "token-2")


class DetailSelectionTests(unittest.TestCase):
    def setUp(self):
        self.ns = detail_helpers()

    def cache_entry(self, modified, as_of=NOW_ISO):
        return {"detail": {"id": "x"}, "lastModifiedDateTime": modified, "detailAsOf": as_of}

    def test_only_new_changed_or_refresh_due_agents_are_fetched(self):
        fresh = (NOW - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        stale = (NOW - timedelta(days=7, minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        packages = [
            {"id": "new", "lastModifiedDateTime": "2026-10-01T00:00:00Z"},
            {"id": "same", "lastModifiedDateTime": "2026-09-01T00:00:00Z"},
            {"id": "newer", "lastModifiedDateTime": "2026-10-05T00:00:00Z"},
            {"id": "older", "lastModifiedDateTime": "2026-08-01T00:00:00Z"},
            {"id": "due", "lastModifiedDateTime": "2026-09-01T00:00:00Z"},
            {"id": "bad-as-of", "lastModifiedDateTime": "2026-09-01T00:00:00Z"},
        ]
        cache = {
            "same": self.cache_entry("2026-09-01T00:00:00Z", fresh),
            "newer": self.cache_entry("2026-09-01T00:00:00Z", fresh),
            "older": self.cache_entry("2026-09-01T00:00:00Z", fresh),
            "due": self.cache_entry("2026-09-01T00:00:00Z", stale),
            "bad-as-of": self.cache_entry("2026-09-01T00:00:00Z", "not a date"),
        }
        targets = self.ns["_select_detail_targets"](packages, cache, NOW, "incremental", 7)
        self.assertEqual(targets, {
            "new": "new / uncached",
            "newer": "changed",
            "older": "changed",              # differs, even though it is earlier
            "due": "scheduled refresh",
            "bad-as-of": "scheduled refresh",
        })

    def test_full_mode_fetches_everything_and_bad_modes_fail(self):
        packages = [{"id": "a"}, {"id": "b"}, {"id": "a"}]
        cache = {"a": self.cache_entry(""), "b": self.cache_entry("")}
        self.assertEqual(set(self.ns["_select_detail_targets"](packages, cache, NOW, "full", 7)), {"a", "b"})
        with self.assertRaisesRegex(ValueError, "DETAIL_MODE"):
            self.ns["_select_detail_targets"](packages, cache, NOW, "delta", 7)

    def test_list_item_without_an_id_fails(self):
        with self.assertRaisesRegex(ValueError, "missing id"):
            self.ns["_select_detail_targets"]([{"displayName": "x"}], {}, NOW)


class DetailMergeAndCacheTests(unittest.TestCase):
    def setUp(self):
        self.ns = detail_helpers()

    def test_merge_precedence(self):
        listed = {"id": "a", "displayName": "Today", "isBlocked": True}
        detail = {"id": "a", "displayName": "Detail", "activeUsers": 9}
        fresh = self.ns["_merge_fresh"](listed, detail)
        self.assertEqual(fresh["displayName"], "Detail", "fresh detail wins over the list")
        cached = self.ns["_merge_cached"](listed, {"id": "a", "displayName": "Old", "isBlocked": False,
                                                   "activeUsers": 9})
        self.assertEqual((cached["displayName"], cached["isBlocked"], cached["activeUsers"]),
                         ("Today", True, 9), "today's list wins over cached detail; detail-only fields kept")

    def test_parallel_fetch_collects_results_and_errors_with_eight_workers(self):
        active, peak, lock = [0], [0], threading.Lock()

        def fetch(package_id):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            _real_time.sleep(0.02)
            with lock:
                active[0] -= 1
            if package_id == "boom":
                raise RuntimeError("HTTP 500")
            return {"id": package_id}

        ids = [f"a{i}" for i in range(20)] + ["boom"]
        fetched, failed = self.ns["_fetch_details"](ids, fetch, 8)
        self.assertEqual(len(fetched), 20)
        self.assertEqual(list(failed), ["boom"])
        self.assertLessEqual(peak[0], 8)
        self.assertGreater(peak[0], 1, "detail calls must run in parallel")
        self.assertEqual(self.ns["_fetch_details"]([], fetch, 8), ({}, {}))

    def test_assemble_uses_cache_drops_removed_agents_and_keeps_failed_refetch_retryable(self):
        packages = [
            {"id": "fresh", "lastModifiedDateTime": "M2", "displayName": "F"},
            {"id": "cached", "lastModifiedDateTime": "M1", "displayName": "C today"},
            {"id": "failed", "lastModifiedDateTime": "M9", "displayName": "X"},
        ]
        cache = {
            "cached": {"detail": {"id": "cached", "displayName": "C old", "activeUsers": 3},
                       "lastModifiedDateTime": "M1", "detailAsOf": "2026-10-01T00:00:00Z",
                       "creatorUpn": "a@x.com", "creatorSource": "ownerId"},
            "failed": {"detail": {"id": "failed"}, "lastModifiedDateTime": "M8",
                       "detailAsOf": "2026-10-02T00:00:00Z"},
            "gone": {"detail": {"id": "gone"}, "lastModifiedDateTime": "M0", "detailAsOf": "x"},
        }
        details, meta, new_cache = self.ns["_assemble_details"](
            packages, cache, {"fresh": {"id": "fresh", "botId": "b"}}, {"failed": RuntimeError("503")}, NOW_ISO)
        self.assertEqual([d["id"] for d in details], ["fresh", "cached", "failed"])
        self.assertEqual(details[1]["displayName"], "C today")
        self.assertEqual(details[1]["activeUsers"], 3)
        self.assertEqual([m["detailAsOf"] for m in meta], [NOW_ISO, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"])
        self.assertEqual([m["fetched"] for m in meta], [True, False, False])
        self.assertNotIn("gone", new_cache, "agents removed from the list leave the cache")
        self.assertEqual(new_cache["fresh"]["lastModifiedDateTime"], "M2")
        self.assertEqual(new_cache["failed"]["lastModifiedDateTime"], "M8",
                         "a failed refetch must stay 'changed' so the next run retries it")

    def test_assemble_fails_when_a_new_agent_has_no_detail(self):
        with self.assertRaisesRegex(RuntimeError, "no cached copy"):
            self.ns["_assemble_details"]([{"id": "new"}], {}, {}, {"new": RuntimeError("429")}, NOW_ISO)

    def test_cache_round_trips_and_skips_corrupt_rows(self):
        cache = {"a": {"detail": {"id": "a", "n": [1]}, "lastModifiedDateTime": "M",
                       "detailAsOf": NOW_ISO, "creatorUpn": "u@x.com", "creatorSource": "ownerId"}}
        rows = self.ns["_cache_to_rows"](cache)
        rows.append({"package_id": "bad", "detail_json": "{not json"})
        rows.append({"package_id": "", "detail_json": "{}"})
        self.assertEqual(self.ns["_cache_from_rows"](rows), cache)


class CreatorCacheTests(unittest.TestCase):
    def test_cached_creators_are_reused_only_for_agents_not_refetched(self):
        ns = extract(NOTEBOOK, 9, functions=("_seed_creators_from_cache",))
        meta = [
            {"packageId": "a", "fetched": False},
            {"packageId": "b", "fetched": True},
            {"packageId": "c", "fetched": False},
            {"packageId": "d", "fetched": False},
        ]
        cache = {
            "a": {"creatorUpn": "a@x.com", "creatorSource": "ownerId"},
            "b": {"creatorUpn": "old@x.com", "creatorSource": "ownerId"},
            "c": {"creatorUpn": "", "creatorSource": "unattributed"},
            "d": {},
        }
        upns, sources, settled = ns["_seed_creators_from_cache"](meta, cache)
        self.assertEqual(upns, {0: "a@x.com"})
        self.assertEqual(sources, {0: "ownerId"})
        self.assertEqual(settled, {0, 2}, "refetched (b) and never-resolved (d) agents run the tiers")


class BatchRequests:
    """requests stand-in that answers each $batch call with per-key statuses."""

    def __init__(self, answers, batch_status=200):
        self.answers, self.batch_status, self.batches = answers, batch_status, []

    def request(self, method, url, headers=None, json=None, **kwargs):
        self.batches.append(json)
        responses = []
        for item in json["requests"]:
            key = item["url"].split("/users/", 1)[1].split("?", 1)[0]
            status, enabled = self.answers.get(key, (500, None))
            body = {} if enabled is None else {"accountEnabled": enabled}
            responses.append({"id": item["id"], "status": status, "body": body})
        return FakeResponse(self.batch_status, {"responses": responses})


class OwnerAccountTests(unittest.TestCase):
    def setUp(self):
        self.ns = extract(NOTEBOOK, 8, functions=("_owner_key", "_owner_account_status"), import_names=())

    def check(self, keys, answers, batch_status=200):
        fake = BatchRequests(answers, batch_status)
        self.ns["graph_request"] = lambda method, url, **kwargs: fake.request(method, url, **kwargs)
        return self.ns["_owner_account_status"](keys), fake

    def test_owner_key_prefers_the_stable_object_id(self):
        key = self.ns["_owner_key"]
        self.assertEqual(key("oid-1", "a@x.com", "ownerId"), "oid-1")
        self.assertEqual(key("oid-1", "a@x.com", "auditLog"), "a@x.com")
        self.assertEqual(key("", "a@x.com", "ownerId"), "a@x.com")
        self.assertEqual(key("oid-1", "", "unattributed"), "")

    def test_statuses_map_to_active_disabled_and_not_found(self):
        status, _ = self.check(["a", "b", "c", "d", ""], {
            "a": (200, True), "b": (200, False), "c": (404, None), "d": (429, None)})
        self.assertEqual(status, {"a": "Active", "b": "Disabled", "c": "Not found"},
                         "a throttled answer stays unknown rather than reading as an owner who left")

    def test_a_failed_batch_leaves_every_key_unknown(self):
        status, _ = self.check(["a"], {"a": (404, None)}, batch_status=503)
        self.assertEqual(status, {})

    def test_keys_are_deduplicated_batched_by_twenty_and_url_encoded(self):
        keys = [f"user{n}@x.com" for n in range(25)] + ["user0@x.com", "guest_y.com#EXT#@x.com"]
        status, fake = self.check(keys, {})
        self.assertEqual([len(b["requests"]) for b in fake.batches], [20, 6])
        urls = [r["url"] for b in fake.batches for r in b["requests"]]
        self.assertIn("/users/guest_y.com%23EXT%23@x.com?$select=id,accountEnabled", urls)

    def test_owner_account_is_written_to_the_snapshot_but_not_history(self):
        ns = extract(NOTEBOOK, 11, assigns=("CANONICAL", "NEW_CANONICAL", "SNAPSHOT_ONLY"), import_names=())
        self.assertEqual(ns["SNAPSHOT_ONLY"], ["Owner account"])
        self.assertNotIn("Owner account", ns["CANONICAL"] + ns["NEW_CANONICAL"])
        self.assertIn("'Owner account':        owner_account.get(idx, '')", code_from_cell(NOTEBOOK, 11))


class RegistryWriteOrderTests(unittest.TestCase):
    def test_history_merge_key_and_updates(self):
        ns = extract(NOTEBOOK, 11, functions=("_history_merge_clauses",), assigns=("HISTORY_KEY",),
                     import_names=())
        condition, updates = ns["_history_merge_clauses"](
            ["Agent name", "Title ID", "Last updated", "Detail As Of", "First Seen", "Last Seen"])
        self.assertEqual(condition, "t.`Title ID` = s.`Title ID` AND t.`Last updated` = s.`Last updated`")
        self.assertEqual(set(updates), {"`Agent name`", "`Detail As Of`", "`Last Seen`"},
                         "First Seen and the key columns are never overwritten")

    def test_cache_is_written_last_after_snapshot_and_history(self):
        source = code_from_cell(NOTEBOOK, 11)
        tree = ast.parse(source)
        top_calls = []
        for node in tree.body:
            for call in ast.walk(node):
                if isinstance(call, ast.Call):
                    func = call.func
                    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
                    if name in ("saveAsTable", "_write_registry_history", "_write_detail_cache") \
                            and not isinstance(node, ast.FunctionDef):
                        top_calls.append(name)
        self.assertEqual(top_calls, ["saveAsTable", "_write_registry_history", "_write_detail_cache"])
        self.assertIn("'Detail As Of'", source)

    def test_registry_keeps_the_full_detail_field_set(self):
        source = code_from_cell(NOTEBOOK, 11)
        for column in ("'Bot Id'", "'Active Users'", "'Total sessions'", "'Users shared'",
                       "'Groups shared'", "'Entra Agent ID'", "'Last Activity Date'"):
            self.assertIn(column, source)


class IncrementalRunSimulationTests(unittest.TestCase):
    """Two mocked runs end to end through the cell-6 helpers."""

    def test_second_run_only_fetches_the_changed_agent(self):
        ns = detail_helpers()
        calls = []

        def fetch(package_id):
            calls.append(package_id)
            return {"id": package_id, "botId": f"bot-{package_id}", "activeUsers": 1}

        day1 = [{"id": f"a{i}", "lastModifiedDateTime": "2026-09-01T00:00:00Z"} for i in range(50)]
        targets = ns["_select_detail_targets"](day1, {}, NOW, "incremental", 7)
        fetched, failed = ns["_fetch_details"](list(targets), fetch, 8)
        _, _, cache = ns["_assemble_details"](day1, {}, fetched, failed, NOW_ISO)
        self.assertEqual(len(calls), 50)

        calls.clear()
        cache = ns["_cache_from_rows"](ns["_cache_to_rows"](cache))     # persisted and reloaded
        day2 = [dict(p) for p in day1[1:]] + [{"id": "a50", "lastModifiedDateTime": "2026-10-05T00:00:00Z"}]
        day2[0]["lastModifiedDateTime"] = "2026-10-05T00:00:00Z"        # a1 edited, a0 deleted
        tomorrow = NOW + timedelta(days=1)
        targets = ns["_select_detail_targets"](day2, cache, tomorrow, "incremental", 7)
        fetched, failed = ns["_fetch_details"](list(targets), fetch, 8)
        details, meta, cache2 = ns["_assemble_details"](day2, cache, fetched, failed, "2026-10-07T06:00:00Z")
        self.assertEqual(sorted(calls), ["a1", "a50"])
        self.assertEqual(len(details), 50)
        self.assertNotIn("a0", cache2)
        self.assertTrue(all(d.get("botId") for d in details), "cached rows keep detail-only fields")

        calls.clear()
        week_later = NOW + timedelta(days=7, hours=12)
        targets = ns["_select_detail_targets"](day2, cache2, week_later, "incremental", 7)
        self.assertEqual(len(targets), 48, "every agent last fetched on day 1 is due its weekly refresh")


if __name__ == "__main__":
    unittest.main()
