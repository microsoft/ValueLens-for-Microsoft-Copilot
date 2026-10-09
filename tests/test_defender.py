"""Defender (shadow AI and agent risk): shared core, and the notebook copy of it."""
from __future__ import annotations

import importlib.util
import json
import unittest
from datetime import date, datetime, timedelta

from valuelens_core import defender as d

from notebook_source import NOTEBOOKS, ROOT

NOTEBOOK = "Copilot_Defender_Ingester.ipynb"
NOW = datetime(2026, 10, 9, 6, 30)
TODAY = date(2026, 10, 9)


def _updater():
    spec = importlib.util.spec_from_file_location("upd", ROOT / "scripts" / "Update-Defender-Notebook.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Transport:
    """Fake Graph: answers keyed by a substring of the KQL or URL; unmatched calls 500."""

    def __init__(self, hunts=None, gets=None):
        self.hunts, self.gets, self.calls = hunts or {}, gets or {}, []

    @staticmethod
    def _answer(table, key):
        for needle, answer in table.items():
            if needle in key:
                if isinstance(answer, Exception):
                    raise answer
                return answer
        return 500, {"error": {"message": "unexpected"}}

    def hunt(self, kql):
        self.calls.append(("hunt", kql))
        return self._answer(self.hunts, kql)

    def get(self, url):
        self.calls.append(("get", url))
        return self._answer(self.gets, url)


FORBIDDEN = (403, {"error": {"code": "Forbidden", "message": "Missing role ThreatHunting.Read.All"}})
NO_TABLE = (400, {"error": {"code": "BadRequest", "message": "Failed to resolve table expression named 'AgentsInfo'"}})


class NotebookParity(unittest.TestCase):
    def test_notebook_embeds_the_module_unchanged(self):
        upd = _updater()
        notebook = json.loads((NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8"))
        cell = notebook["cells"][upd.shared_cell_index(notebook)]
        wanted = upd.embedded_source((ROOT / "shared" / "python" / "valuelens_core" / "defender.py")
                                     .read_text(encoding="utf-8"))
        self.assertEqual("".join(cell["source"]), wanted,
                         "Run python scripts/Update-Defender-Notebook.py after editing defender.py.")

    def test_notebook_keeps_credentials_for_the_installer(self):
        text = (NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8")
        for name in ("TENANT_ID", "CLIENT_ID", "CLIENT_SECRET"):
            self.assertIn(f"{name} ", text)
        self.assertIn("HUNTING_URL", text)
        self.assertNotIn("api.security.microsoft.com", text)

    def test_installer_model_reads_the_tables_and_columns_the_core_writes(self):
        import re
        js = (ROOT / "1. Fabric" / "installer" / "src" / "transform" / "defender.js").read_text(encoding="utf-8")
        found = {}
        for source, cols in re.findall(r"source: '(\w+)',\s*\n\s*description: [^\n]*\n\s*columns: \[(.*)\],\n", js):
            found[source] = re.findall(r"\['(\w+)', '(\w+)'\]", cols)
        self.assertEqual(set(found), set(d.TABLES.values()))
        for key, table in d.TABLES.items():
            self.assertEqual(found[table], [tuple(c) for c in d.COLUMNS[key]], table)


class Watchlist(unittest.TestCase):
    def test_seed_round_trips(self):
        rows = d.default_watchlist()
        self.assertEqual(len(rows), len(d.WATCHLIST_SEED))
        self.assertEqual(d.parse_watchlist(d.watchlist_csv(rows)), rows)
        sanctioned = {r["Tool"] for r in rows if r["Posture"] == "Sanctioned"}
        self.assertEqual(sanctioned, {"Microsoft 365 Copilot", "GitHub Copilot"})
        self.assertFalse(any(r["Posture"] == "Unsanctioned" for r in rows))

    def test_postures_and_terms_normalised(self):
        rows = d.parse_watchlist("\ufefftool,posture,Domains\nX, unsanctioned ,A.com; b.com,a.com\nY,maybe,\nx,Sanctioned,\n")
        self.assertEqual([r["Tool"] for r in rows], ["X", "Y"])
        self.assertEqual(rows[0]["Posture"], "Unsanctioned")
        self.assertEqual(rows[0]["Domains"], ["a.com", "b.com"])
        self.assertEqual(rows[1]["Posture"], "Not reviewed")
        self.assertEqual(rows[1]["ProcessNames"], [])

    def test_needs_tool_column(self):
        with self.assertRaises(ValueError):
            d.parse_watchlist("Name\nX\n")
        self.assertEqual(d.parse_watchlist(""), [])

    def test_longest_domain_wins(self):
        wl = d.parse_watchlist("Tool,Domains\nGeneric,example.com\nSpecific,chat.example.com\n")
        self.assertEqual(d.term_map(wl, "Domains")[0], ("chat.example.com", "Specific"))
        self.assertEqual(d.match_domain("api.chat.example.com.", wl), "Specific")
        self.assertEqual(d.match_domain("www.example.com", wl), "Generic")
        self.assertEqual(d.match_domain("notexample.com", wl), "")


class Kql(unittest.TestCase):
    def test_activity_query(self):
        kql = d.activity_kql(d.default_watchlist(), TODAY, date(2026, 9, 10))
        for part in ("DeviceProcessEvents", "DeviceNetworkEvents", "let End = datetime(2026-10-09);",
                     "let Load = datetime(2026-09-10);", '"chatgpt.exe"', '"chatgpt.com"', 'Window = "7d"',
                     'Window = "30d"', 'Layer = "Any"', "dcount(DeviceId"):
            self.assertIn(part, kql)
        shadow = kql.split("let Shadow")[1].split(";")[0]
        self.assertNotIn("GitHub Copilot", shadow)
        self.assertIn("ChatGPT", shadow)
        self.assertNotIn("DeviceName", kql)
        self.assertNotIn("AccountUpn", kql)

    def test_quotes_are_escaped(self):
        wl = d.parse_watchlist('Tool,ProcessNames\n"Bad ""tool""",a\\b.exe\n')
        kql = d.activity_kql(wl, TODAY, TODAY - timedelta(days=1))
        self.assertIn('"a\\\\b.exe"', kql)
        self.assertIn('"Bad \\"tool\\""', kql)

    def test_layers_without_terms_use_an_empty_table(self):
        wl = d.parse_watchlist("Tool,Domains\nX,x.com\n")
        kql = d.activity_kql(wl, TODAY, TODAY - timedelta(days=1))
        self.assertNotIn("DeviceProcessEvents", kql)
        self.assertIn("let Ran = datatable(", kql)
        self.assertIsNone(d.installed_kql(wl))
        self.assertIn("startswith", d.installed_kql(d.default_watchlist()))


class Days(unittest.TestCase):
    def test_load_start(self):
        self.assertEqual(d.load_start(TODAY, None), TODAY - timedelta(days=29))
        self.assertEqual(d.load_start(TODAY, TODAY - timedelta(days=1)), TODAY - timedelta(days=2))
        self.assertEqual(d.load_start(TODAY, date(2020, 1, 1)), TODAY - timedelta(days=29))
        self.assertEqual(d.load_start(TODAY, TODAY + timedelta(days=3)), TODAY - timedelta(days=1))

    def test_activity_rows_zero_fill_totals(self):
        start = TODAY - timedelta(days=2)
        results = [
            {"Day": "2026-10-07T00:00:00Z", "Window": "1d", "Layer": "Ran", "Tool": "ChatGPT",
             "Devices": 3, "Users": 2, "Events": 9},
            {"Day": "2026-10-07T00:00:00Z", "Window": "1d", "Layer": "Any", "Tool": "", "Devices": 3,
             "Users": 2, "Events": 9},
            {"Day": "2026-10-08T00:00:00Z", "Window": "30d", "Layer": "Any", "Tool": "", "Devices": "5",
             "Users": None, "Events": 12.0},
            {"Day": None, "Window": "1d"},
        ]
        daily, totals = d.activity_rows(results, TODAY, start, NOW)
        self.assertEqual(daily, [(date(2026, 10, 7), "1d", "Ran", "ChatGPT", 3, 2, 9, NOW)])
        self.assertEqual(len(totals), (2 + len(d.WINDOWS)) * 3)
        by_key = {(r[0], r[1], r[2]): r[3:6] for r in totals}
        self.assertEqual(by_key[(date(2026, 10, 7), "1d", "Any")], (3, 2, 9))
        self.assertEqual(by_key[(date(2026, 10, 8), "1d", "Network")], (0, 0, 0))
        self.assertEqual(by_key[(date(2026, 10, 8), "30d", "Any")], (5, 0, 12))
        self.assertEqual(by_key[(date(2026, 10, 8), "7d", "Ran")], (0, 0, 0))


class Answers(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(d.classify(*FORBIDDEN)[0], "forbidden")
        self.assertEqual(d.classify(*NO_TABLE)[0], "unlicensed")
        self.assertEqual(d.classify(403, {"error": {"message": "Tenant is not onboarded"}})[0], "unlicensed")
        self.assertEqual(d.classify(500, "boom"), ("error", "boom"))
        self.assertEqual(d.classify(400, {})[1], "HTTP 400")

    def test_sign_in(self):
        self.assertEqual(d.sign_in_required("None"), "No")
        self.assertEqual(d.sign_in_required("No authentication"), "No")
        self.assertEqual(d.sign_in_required("Microsoft"), "Yes")
        self.assertEqual(d.sign_in_required("Custom"), "Yes")
        self.assertEqual(d.sign_in_required(""), "Unknown")
        self.assertEqual(d.sign_in_required("SomethingNew"), "Unknown")
        nested = json.dumps({"settings": [{"Authentication_Mode": "None"}]})
        self.assertEqual(d.find_key(nested, ("authenticationmode",)), "None")
        self.assertIsNone(d.find_key({"a": {"b": []}}, ("authenticationmode",)))
        self.assertEqual(d.uses_web_knowledge(None, '[{"type":"PublicWebsite"}]'), "Yes")
        self.assertEqual(d.uses_web_knowledge([{"type": "SharePoint"}]), "No")
        self.assertEqual(d.uses_web_knowledge(None, ""), "Unknown")

    def test_agent_rows_keep_join_keys_not_people(self):
        rows = d.agent_rows([
            {"AgentId": "1", "AgentName": "b", "EntraAgentId": "ABC", "SourceAgentId": "BOT",
             "RawAgentInfo": {"appId": "APP", "auth": {"authenticationMode": "None"}, "owner": "x@y.com"},
             "DeclaredDataSources": [{"kind": "WebSearch"}]},
            {"AgentId": "1", "AgentName": "dupe"},
            {"AgentId": "2", "AgentName": "A", "UserAuthenticationType": "Microsoft", "AppId": "Q"},
            {"AgentName": "no id"},
        ], "AgentsInfo", TODAY, NOW)
        self.assertEqual([r[1] for r in rows], ["2", "1"])
        first = dict(zip([c for c, _ in d.COLUMNS["agents"]], rows[1]))
        self.assertEqual((first["EntraAgentId"], first["BotId"], first["AppId"]), ("abc", "bot", "app"))
        self.assertEqual((first["SignInRequired"], first["UsesWebKnowledge"]), ("No", "Yes"))
        self.assertNotIn("x@y.com", repr(rows))
        self.assertEqual(rows[0][9], "Yes")

    def test_rows_match_columns(self):
        result = d.run(*_healthy().fns(), d.default_watchlist(), TODAY, None, now=NOW)
        for key in d.TABLES:
            for row in result[key]:
                self.assertEqual(len(row), len(d.COLUMNS[key]), key)


def _healthy():
    activity = [{"Day": "2026-10-08", "Window": "1d", "Layer": "Ran", "Tool": "Claude", "Devices": 1,
                 "Users": 1, "Events": 4}]
    t = Transport(
        hunts={
            "DeviceProcessEvents": (200, {"schema": [], "results": activity}),
            "DeviceTvmSoftwareInventory": (200, {"results": [{"Tool": "Cursor", "Devices": 2, "SoftwareNames": "cursor"}]}),
            "AgentsInfo\n": (200, {"results": [{"AgentId": "a", "AgentName": "Helper", "RawAgentInfo": "{}"}]}),
        },
        gets={
            "uploadedStreams/s1/": (200, {"value": [
                {"id": "x", "displayName": "ChatGPT", "category": "generativeAi", "domains": ["chatgpt.com"],
                 "tags": ["Unsanctioned"], "userCount": 7, "lastSeenDateTime": "2026-10-08T10:11:12.1234567Z"},
                {"id": "y", "displayName": "Mail", "category": "webemail"},
            ]}),
            "uploadedStreams": (200, {"value": [{"id": "s1", "displayName": "Firewall"}]}),
        },
    )
    t.fns = lambda: (t.hunt, t.get)
    return t


class Run(unittest.TestCase):
    def test_healthy_run(self):
        t = _healthy()
        result = d.run(t.hunt, t.get, d.default_watchlist(), TODAY, None, now=NOW)
        status = {r[1]: r[2] for r in result["status"]}
        self.assertEqual(status, {p: "ok" for p in d.PROBES})
        self.assertTrue(all(result["loaded"].values()))
        self.assertEqual(result["load_start"], TODAY - timedelta(days=29))
        self.assertEqual(len(result["daily"]), 1)
        self.assertEqual(len(result["totals"]), (29 + len(d.WINDOWS)) * 3)
        self.assertEqual(result["installed"][0][1:3], ("Cursor", 2))
        cloud = dict(zip([c for c, _ in d.COLUMNS["cloud"]], result["cloud"][0]))
        self.assertEqual(len(result["cloud"]), 1)
        self.assertEqual((cloud["Posture"], cloud["WatchlistTool"], cloud["Users"]), ("Unsanctioned", "ChatGPT", 7))
        self.assertEqual(cloud["LastSeen"], datetime(2026, 10, 8, 10, 11, 12, 123456))
        self.assertEqual(result["agents"][0][4], "AgentsInfo")
        self.assertEqual(len(result["watchlist"]), len(d.WATCHLIST_SEED))
        get_urls = [c[1] for c in t.calls if c[0] == "get"]
        self.assertTrue(any("aggregatedAppsDetails(period=duration'P30D')" in u for u in get_urls))

    def test_each_probe_fails_soft(self):
        t = Transport(
            hunts={
                "DeviceProcessEvents": FORBIDDEN,
                "DeviceTvmSoftwareInventory": RuntimeError("socket closed"),
                "AIAgentsInfo": NO_TABLE,
                "AgentsInfo\n": NO_TABLE,
            },
            gets={"uploadedStreams": (403, {"error": {"message": "Insufficient privileges"}})},
        )
        result = d.run(t.hunt, t.get, d.default_watchlist(), TODAY, TODAY - timedelta(days=1), now=NOW)
        status = {r[1]: (r[2], r[5]) for r in result["status"]}
        self.assertEqual(status["device_activity"][0], "forbidden")
        self.assertEqual(status["installed"], ("error", "RuntimeError: socket closed"))
        self.assertEqual(status["agents"][0], "unlicensed")
        self.assertEqual(status["cloud_discovery"][0], "forbidden")
        self.assertFalse(any(result["loaded"].values()))
        self.assertEqual(result["daily"] + result["totals"] + result["agents"] + result["cloud"], [])
        self.assertTrue(result["watchlist"])

    def test_agents_fall_back_to_the_older_table(self):
        t = Transport(hunts={
            "AIAgentsInfo": (200, {"results": [{"AgentId": "B1", "AgentName": "Old", "UserAuthenticationType": "None",
                                                "EntraAgentId": "E1", "SourceAgentId": "B1", "AppId": "A1"}]}),
            "AgentsInfo\n": NO_TABLE,
        })
        result = d.run(t.hunt, t.get, [], TODAY, None, now=NOW, probes=("agents",))
        self.assertEqual(result["status"][0][1:5], ("agents", "ok", "AIAgentsInfo", 1))
        self.assertEqual(result["agents"][0][4:10], ("AIAgentsInfo", "e1", "b1", "a1", "None", "No"))

    def test_forbidden_agents_do_not_fall_back(self):
        t = Transport(hunts={"AgentsInfo\n": FORBIDDEN})
        result = d.run(t.hunt, t.get, [], TODAY, None, now=NOW, probes=("agents",))
        self.assertEqual(result["status"][0][2], "forbidden")
        self.assertEqual(len([c for c in t.calls if c[0] == "hunt"]), 1)

    def test_empty_answers(self):
        t = Transport(hunts={"DeviceProcessEvents": (200, {"results": []})},
                      gets={"uploadedStreams": (200, {"value": []})})
        result = d.run(t.hunt, t.get, d.default_watchlist(), TODAY, None, now=NOW,
                       probes=("device_activity", "cloud_discovery"))
        status = {r[1]: r[2] for r in result["status"]}
        self.assertEqual(status, {"device_activity": "empty", "cloud_discovery": "empty"})
        self.assertTrue(result["loaded"]["device_activity"])
        self.assertTrue(result["totals"])
        no_prefixes = d.parse_watchlist("Tool\nX\n")
        result = d.run(t.hunt, t.get, no_prefixes, TODAY, None, now=NOW, probes=("installed",))
        self.assertEqual(result["status"][0][2], "empty")


class CloudDiscovery(unittest.TestCase):
    def test_pages_and_partial_stream_failures(self):
        base = d.CLOUD_DISCOVERY_URL + "/uploadedStreams"
        t = Transport(gets={
            "/s1/aggregatedAppsDetails": (200, {"value": [{"id": "1", "category": "mcpServer", "displayName": "M"}],
                                               "@odata.nextLink": base + "/s1/page2"}),
            "/s1/page2": (200, {"value": [{"id": "2", "category": "clientAiApp", "displayName": "Ollama"}]}),
            "/s2/aggregatedAppsDetails": (500, {"error": {"message": "busy"}}),
            "uploadedStreams": (200, {"value": [{"id": "s1"}, {"id": "s2", "displayName": "Proxy"}]}),
        })
        sink = []
        status, message = d.cloud_discovery(t.get, d.default_watchlist(), TODAY, NOW, sink)
        self.assertEqual(status, "ok")
        self.assertIn("Proxy: busy", message)
        self.assertEqual([r[4] for r in sink], ["M", "Ollama"])
        self.assertEqual(sink[1][16], "Ollama")

    def test_next_link_loop_stops(self):
        url = d.CLOUD_DISCOVERY_URL + "/uploadedStreams"
        t = Transport(gets={"uploadedStreams": (200, {"value": [], "@odata.nextLink": url})})
        self.assertEqual(list(d._pages(t.get, url)), [[]])


if __name__ == "__main__":
    unittest.main()


class TemplateTests(unittest.TestCase):
    """Sign-in Required and the No sign-in required flag in both Fabric PBITs."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("tpl", ROOT / "scripts" / "Update-Defender-Template.py")
        cls.tpl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.tpl)

    def _table(self, relative):
        import zipfile
        with zipfile.ZipFile(ROOT / relative) as archive:
            model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]
        return next(t for t in model["tables"] if t["name"] == "Agents 365")

    def test_templates_are_current(self):
        self.assertEqual(self.tpl.main(["--check"]), 0)

    def test_sign_in_comes_from_the_defender_agent_table_and_flags_it(self):
        for relative in self.tpl.TEMPLATES:
            with self.subTest(template=relative.name):
                table = self._table(relative)
                query = self.tpl.joined(table["partitions"][0]["source"]["expression"])
                self.assertIn('FabricTable("defender_ai_agents") otherwise null', query)
                self.assertIn("Table.RemoveColumns(__withSignIn, ", query)
                self.assertNotIn('"Sign-in Required"', query.split("__lean =", 1)[1], "the lean pass must keep it")
                for key in ("EntraAgentId", "BotId", "AppId", "SignInRequired", "SnapshotDate"):
                    self.assertIn(key, query)
                names = [c["name"] for c in table["columns"]]
                self.assertEqual(names.count("Sign-in Required"), 1)
                column = next(c for c in table["columns"] if c["name"] == "Sign-in Required")
                self.assertEqual((column["dataType"], column["sourceColumn"]), ("string", "Sign-in Required"))
                flags = self.tpl.joined(next(c for c in table["columns"] if c["name"] == "Governance Flags")["expression"])
                self.assertIn("'Agents 365'[Sign-in Required] = \"No\", \"; No sign-in required\"", flags)
                for kept in ("Owner has left", "No owner on record", "Org-wide with org data", "Shared, no recorded use"):
                    self.assertIn(kept, flags)

    def test_core_writes_the_columns_the_template_reads(self):
        written = {name for name, _ in d.COLUMNS["agents"]}
        self.assertEqual(d.TABLES["agents"], "defender_ai_agents")
        self.assertLessEqual({"SnapshotDate", "EntraAgentId", "BotId", "AppId", "AgentId", "SignInRequired"}, written)
        self.assertEqual({d.sign_in_required("None"), d.sign_in_required("Integrated"), d.sign_in_required("")},
                         {"No", "Yes", "Unknown"})
