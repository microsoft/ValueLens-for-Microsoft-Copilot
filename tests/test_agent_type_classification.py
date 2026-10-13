"""Agent type / publisher classification in the Fabric audit processor.

The rules are pure Python in the processor helpers cell, so they are exec'd straight
out of the notebook (Spark is not available locally).
"""
import unittest

from test_agent_linking import INGESTER, PROCESSOR, cells, load_pure


TYPE_NAMES = [
    "AGENT_TYPE_FP_PUBLISHED", "AGENT_TYPE_FP_NON_PUBLISHED", "AGENT_TYPE_FP_M365",
    "AGENT_TYPE_DECLARATIVE", "AGENT_TYPE_CUSTOM_ENGINE", "AGENT_TYPE_COPILOT_STUDIO",
    "AGENT_TYPE_FACILITATOR", "AGENT_TYPE_ORG_PUBLISHED", "AGENT_TYPE_SHARED", "AGENT_TYPE_STORE",
    "AGENT_TYPE_CONNECTED_APP", "AGENT_TYPE_UNCLASSIFIED",
]
CLASSIFIER_NAMES = TYPE_NAMES + [
    "AGENT_TYPE_INFO", "FIRST_PARTY_AGENT_TYPES", "MICROSOFT_AGENT_NAMES", "MICROSOFT_AGENT_CANONICAL",
    "_agent_text", "_agent_name_key", "_microsoft_agent_segment", "microsoft_agent_name",
    "build_agent_type_overrides", "agent_type_override", "classify_agent", "describe_agent",
]

NS = load_pure(PROCESSOR, 2, CLASSIFIER_NAMES)
T = {name: NS[name] for name in TYPE_NAMES}

# (agent_id, agent_name, app_identity, platform_agent_type, workload, expected Agent_Type key or None)
SAMPLES = [
    # Microsoft first-party
    ("P_researcher01", "Researcher", "MicrosoftAgent.Researcher.P_researcher01", None, "Copilot",
     "AGENT_TYPE_FP_PUBLISHED"),
    ("P_9f1c", "Analyst", None, None, "Copilot", "AGENT_TYPE_FP_PUBLISHED"),
    (None, "Word Drafting Agent", "MicrosoftAgent.WordDraftingAgent", None, "Copilot",
     "AGENT_TYPE_FP_NON_PUBLISHED"),
    ("BuiltIn_Interpreter", None, None, None, "Copilot", "AGENT_TYPE_FP_NON_PUBLISHED"),
    ("WordDraftingAgent", None, None, None, "Copilot", "AGENT_TYPE_FP_NON_PUBLISHED"),
    ("x1", "Researcher", "Copilot.M365Copilot.Chat", None, "Copilot", "AGENT_TYPE_FP_M365"),
    # Copilot Studio / Agent Builder
    ("T_abc.declarative", "HR Helper", "CopilotStudio.Declarative.T_abc", None, "Copilot",
     "AGENT_TYPE_DECLARATIVE"),
    ("U_def", "Sales bot", "Copilot.Studio.Declarative.xyz", None, "Copilot", "AGENT_TYPE_DECLARATIVE"),
    ("T_ce1", "Ops bot", "CopilotStudio.CustomEngine.T_ce1", None, "Copilot", "AGENT_TYPE_CUSTOM_ENGINE"),
    ("abcd-1234", "IT bot", "Copilot.Studio.0d1e2f", None, "Copilot", "AGENT_TYPE_COPILOT_STUDIO"),
    ("abcd-1234", "IT bot", None, "Copilot Studio", "Copilot", "AGENT_TYPE_COPILOT_STUDIO"),
    # Teams Facilitator
    (None, None, "Copilot.TeamCopilot.Meeting", None, "Copilot", "AGENT_TYPE_FACILITATOR"),
    # Prefix conventions (inferred)
    ("T_8a2b.contoso", "Contoso Policies", None, None, "Copilot", "AGENT_TYPE_ORG_PUBLISHED"),
    ("U_5e5e.alice", "Alice notes", None, None, "Copilot", "AGENT_TYPE_SHARED"),
    ("P_7c7c.vendor", "Vendor agent", None, None, "Copilot", "AGENT_TYPE_STORE"),
    # Connected AI apps
    (None, None, "ConnectedAIApp.Foundry.myapp", None, "ConnectedAIApp", "AGENT_TYPE_CONNECTED_APP"),
    ("foundry-1", "Foundry agent", None, None, "ConnectedAIApp", "AGENT_TYPE_CONNECTED_APP"),
    # Agent in the M365 Copilot app that no other rule identified
    ("zz-9", "Mystery", "Copilot.M365Copilot.Agent", None, "Copilot", "AGENT_TYPE_FP_M365"),
    # Unclassified agent
    ("1234-abcd", "Something", None, None, "Copilot", "AGENT_TYPE_UNCLASSIFIED"),
    # Not agents
    (None, None, None, None, "Copilot", None),
    (None, None, "Copilot.M365Copilot.Chat", None, "Copilot", None),
    ("x", "ChatGPT", "AIApp.ChatGPT", None, "AIApp", None),
]


class ClassifyAgentTests(unittest.TestCase):
    def test_sample_record_per_category(self):
        for aid, name, app, kind, workload, expected in SAMPLES:
            with self.subTest(aid=aid, name=name, app=app):
                want = T[expected] if expected else None
                self.assertEqual(NS["classify_agent"](aid, name, app, kind, workload), want)

    def test_every_category_has_a_sample(self):
        covered = {expected for *_, expected in SAMPLES if expected}
        self.assertEqual(covered, set(TYPE_NAMES))

    def test_every_category_has_publisher_info(self):
        self.assertEqual(set(NS["AGENT_TYPE_INFO"]), set(T.values()))

    def test_case_and_whitespace_insensitive(self):
        self.assertEqual(
            NS["classify_agent"]("  t_abc ", None, " COPILOTSTUDIO.CUSTOMENGINE.X ", None, "copilot"),
            T["AGENT_TYPE_CUSTOM_ENGINE"])
        self.assertEqual(NS["classify_agent"](None, " researcher ", None, None, None),
                         T["AGENT_TYPE_FP_NON_PUBLISHED"])

    def test_precedence(self):
        classify = NS["classify_agent"]
        # Custom engine beats declarative and the T_ prefix.
        self.assertEqual(classify("T_x.customengine", None, "CopilotStudio.Declarative.x", None, None),
                         T["AGENT_TYPE_CUSTOM_ENGINE"])
        # A known Microsoft name beats the P_ store rule.
        self.assertEqual(classify("P_1", "Analyst", None, None, None), T["AGENT_TYPE_FP_PUBLISHED"])
        # MicrosoftAgent.* decides published from the AppIdentity, not the agent ID prefix.
        self.assertEqual(classify("P_1", None, "MicrosoftAgent.Researcher", None, None),
                         T["AGENT_TYPE_FP_NON_PUBLISHED"])
        # Connected apps beat every agent rule.
        self.assertEqual(classify("T_1", "Researcher", None, None, "ConnectedAIApp"),
                         T["AGENT_TYPE_CONNECTED_APP"])
        # The prefix falls back to AppIdentity when no agent ID exists.
        self.assertEqual(classify(None, "Bot", "U_1.bot", None, None), T["AGENT_TYPE_SHARED"])


class DescribeAgentTests(unittest.TestCase):
    def test_columns_for_published_microsoft_agent(self):
        self.assertEqual(
            NS["describe_agent"]("P_r1", "researcher", "MicrosoftAgent.Researcher.P_r1", None, "Copilot"),
            ("P_r1", T["AGENT_TYPE_FP_PUBLISHED"], "documented/observed", "Microsoft", True, "Researcher"))

    def test_prefix_rules_are_inferred(self):
        for aid, publisher, published in (("T_1", "Your organisation", True),
                                          ("U_1", "User-shared", False),
                                          ("P_1", "Agent Store", True)):
            with self.subTest(aid=aid):
                _, _, basis, pub, is_pub, _ = NS["describe_agent"](aid, "Bot", None, None, None)
                self.assertEqual((basis, pub, is_pub), ("inferred", publisher, published))

    def test_builder_and_studio_publish_state_is_unknown(self):
        for app in ("CopilotStudio.Declarative.x", "CopilotStudio.CustomEngine.x", "Copilot.Studio.x"):
            with self.subTest(app=app):
                row = NS["describe_agent"]("abc", "Bot", app, None, None)
                self.assertEqual(row[3:5], ("Your organisation", None))

    def test_not_an_agent_is_all_null(self):
        self.assertEqual(NS["describe_agent"](None, None, None, None, "Copilot"), (None,) * 6)
        self.assertEqual(NS["describe_agent"]("", "", "", "", ""), (None,) * 6)

    def test_microsoft_agents_consolidate_across_ids_and_hosts(self):
        describe = NS["describe_agent"]
        rows = [
            describe("P_aa", "Researcher", "MicrosoftAgent.Researcher.P_aa", None, None),
            describe("P_bb", None, "MicrosoftAgent.Researcher.P_bb", None, None),
            describe("BuiltIn_Researcher", None, None, None, None),
            describe("x", "RESEARCHER", "Copilot.M365Copilot.Chat", None, None),
        ]
        self.assertEqual({r[5] for r in rows}, {"Researcher"})
        self.assertEqual(len({r[0] for r in rows}), 4)
        self.assertEqual(describe(None, None, "MicrosoftAgent.WordDraftingAgent", None, None)[5],
                         "Word Drafting Agent")
        self.assertEqual(describe(None, None, "Copilot.TeamCopilot.Meeting", None, None)[5], "Facilitator")

    def test_other_agents_keep_their_own_name(self):
        self.assertEqual(NS["describe_agent"]("T_1", "Contoso Policies", None, None, None)[5],
                         "Contoso Policies")
        self.assertEqual(NS["describe_agent"]("T_1", None, None, None, None)[5], "T_1")

    def test_agent_key_prefers_id_then_name_then_app(self):
        describe = NS["describe_agent"]
        self.assertEqual(describe("T_1", "Bot", "Copilot.Studio.x", None, None)[0], "T_1")
        self.assertEqual(describe(None, "Bot", "Copilot.Studio.x", None, None)[0], "Bot")
        self.assertEqual(describe(None, None, "Copilot.Studio.x", None, None)[0], "Copilot.Studio.x")

    def test_overrides(self):
        overrides = NS["build_agent_type_overrides"]([
            (" T_1 ", T["AGENT_TYPE_STORE"]),
            ("Mystery", "My custom bucket"),
            ("", "ignored"), ("blank", None),
        ])
        self.assertEqual(set(overrides), {"t_1", "mystery"})
        describe = NS["describe_agent"]
        self.assertEqual(describe("t_1", "Bot", None, None, None, overrides=overrides)[1:5],
                         (T["AGENT_TYPE_STORE"], "override", "Agent Store", True))
        self.assertEqual(describe("1234", "mystery", None, None, None, overrides=overrides)[1:5],
                         ("My custom bucket", "override", "Unknown", None))
        # Overrides can also classify rows the rules ignore, and are optional.
        self.assertEqual(describe("1234", "Other", None, None, None, overrides=overrides)[1],
                         T["AGENT_TYPE_UNCLASSIFIED"])
        self.assertEqual(describe("1234", "Other", None, None, None)[1], T["AGENT_TYPE_UNCLASSIFIED"])


class NotebookWiringTests(unittest.TestCase):
    def test_ingester_keeps_agent_type_inputs(self):
        code = "\n".join(cells(INGESTER))
        for column in ("AppIdentity_Text", "Agent_TargetPlatformId", "Agent_TargetName", "Agent_PlatformType"):
            with self.subTest(column=column):
                self.assertIn(f"alias('{column}')", code)
                self.assertIn(f"'{column}'", code.split("alias('Agent_PlatformType')")[1])
        for field in ("TargetPlatformAgentId", "TargetAgentName", "PlatformAgentType"):
            self.assertIn(f"_ced_text('{field}')", code)

    def test_processor_config_ensures_and_enrichment(self):
        processor = cells(PROCESSOR)
        self.assertIn('AGENT_TYPE_OVERRIDES_TABLE = "agent_type_overrides"', processor[1])
        for column in ("AppIdentity_Text", "Agent_TargetPlatformId", "Agent_TargetName", "Agent_PlatformType"):
            self.assertIn(f'"{column}"', processor[4])
        enrichment = processor[14]
        self.assertIn("describe_agent(*r, overrides=_at_overrides)", enrichment)
        self.assertIn('"Agent_Is_Published"', enrichment)
        self.assertIn("] + AGENT_TYPE_COLS", enrichment)
        self.assertLess(enrichment.index("Agent_Surface"), enrichment.index("AGENT_TYPE_COLS ="))


if __name__ == "__main__":
    unittest.main()
