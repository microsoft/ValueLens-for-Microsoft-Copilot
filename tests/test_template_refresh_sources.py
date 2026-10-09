"""Every web data source in the file-based templates is static, so the Power BI service can schedule refresh.

The service reads each Web.Contents base URL without running the query. It accepts a parameter that has a
value, passed directly or through a plain let binding; anything computed (Text.Trim, if, ??, &) is reported
as "Data source for Query1" and blocks scheduled refresh. A blank optional parameter must never be a base URL.
"""
import importlib.util
import json
import re
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "template_refresh_sources", ROOT / "scripts" / "Update-Template-Refresh-Sources.py")
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)

# The parameters each template may pass to Web.Contents as the base URL.
WEB_BASES = {
    PATCHER.SHAREPOINT: {"Copilot Interactions File", "Org Data File", "SharePoint Site URL"},
    PATCHER.POWER_AUTOMATE: {"Dataverse URL", "SharePoint Site URL"},
    PATCHER.LOCAL_CSV: set(),
}
FEEDBACK_GUARD = 'if FilePath = null or Text.Trim(FilePath) = "" then EmptyTable(Expected)'


def text(value):
    return "\n".join(value) if isinstance(value, list) else (value or "")


def load(relative):
    with zipfile.ZipFile(ROOT / relative) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]


def m_sources(model):
    for expression in model.get("expressions", []):
        yield expression["name"], text(expression["expression"])
    for table in model["tables"]:
        for partition in table.get("partitions", []):
            if partition["source"].get("type") == "m":
                yield table["name"], text(partition["source"]["expression"])


def parameters(model):
    found = {}
    for expression in model.get("expressions", []):
        m = text(expression["expression"])
        if "IsParameterQuery=true" in m:
            found[expression["name"]] = "IsParameterQueryRequired=true" in m
    return found


def base_parameter(m, argument):
    """The parameter a Web.Contents base argument names, directly or through one plain let binding."""
    direct = re.fullmatch(r'#"([^"]+)"', argument)
    if direct:
        return direct.group(1)
    if re.fullmatch(r"\w+", argument):
        binding = re.search(rf'^\s*{argument}\s*=\s*#"([^"]+)"\s*,\s*$', m, re.MULTILINE)
        if binding:
            return binding.group(1)
    return None


class TemplatesAreCurrent(unittest.TestCase):
    def test_every_template_is_current_and_the_patcher_is_idempotent(self):
        self.assertEqual(len(PATCHER.TARGETS), 3)
        for relative, edits in PATCHER.TARGETS:
            original = (ROOT / relative).read_bytes()
            rebuilt, changed = PATCHER.build(original, edits)
            self.assertEqual(changed, [], f"{relative} is stale: run scripts/Update-Template-Refresh-Sources.py")
            self.assertEqual(rebuilt, original, relative)

    def test_added_expressions_keep_stable_lineage(self):
        for relative, edits in PATCHER.TARGETS:
            expressions = {e["name"]: e for e in load(relative).get("expressions", [])}
            for edit in edits:
                if edit["kind"] == "add":
                    self.assertEqual(expressions[edit["name"]]["lineageTag"], PATCHER.lineage_tag(edit["name"]))


class StaticDataSources(unittest.TestCase):
    def test_every_web_base_url_is_a_parameter_with_a_value(self):
        for relative, allowed in WEB_BASES.items():
            model = load(relative)
            required = parameters(model)
            seen = set()
            for name, m in m_sources(model):
                for argument in re.findall(r"Web\.Contents\(\s*([^,()]+?)\s*[,)]", m):
                    parameter = base_parameter(m, argument)
                    self.assertIn(parameter, allowed, (relative, name, argument))
                    seen.add(parameter)
                    if relative == PATCHER.SHAREPOINT:
                        self.assertTrue(required[parameter], (relative, name, parameter))
            self.assertEqual(seen, allowed, relative)

    def test_no_computed_url_feeds_a_data_source(self):
        for relative in WEB_BASES:
            for name, m in m_sources(load(relative)):
                for call in re.findall(r"(?:Web|File)\.Contents\(\s*([^,()]+?)\s*[,)]", m):
                    self.assertNotRegex(call, r"Text\.|\bif\b|\?\?|&", (relative, name))

    def test_optional_files_are_read_through_the_site(self):
        for relative in (PATCHER.SHAREPOINT, PATCHER.POWER_AUTOMATE):
            sources = dict(m_sources(load(relative)))
            optional = ["ProductFeedback", "Agents 365 Staging"]
            if relative == PATCHER.POWER_AUTOMATE:
                optional += ["Chat + Agent Interactions (Audit Logs)", "Copilot Licensed", "Chat + Agent Org Data"]
            for name in optional:
                self.assertIn(PATCHER.READ_SITE_CSV, sources[name], (relative, name))
                self.assertNotIn(PATCHER.READ_CSV, sources[name], (relative, name))

    def test_site_function_calls_web_contents_on_the_site_parameter(self):
        for relative in (PATCHER.SHAREPOINT, PATCHER.POWER_AUTOMATE):
            function = dict(m_sources(load(relative)))[PATCHER.SITE_FUNCTION]
            self.assertEqual(function, PATCHER.SITE_FUNCTION_M)
            self.assertIn("Web.Contents(Site, [RelativePath = RelativePath])", function)
            self.assertIn('Site = #"SharePoint Site URL",', function)
            self.assertIn("_api/web/GetFileByServerRelativeUrl(", function)

    def test_dataverse_reads_from_the_parameter(self):
        dataverse = dict(m_sources(load(PATCHER.POWER_AUTOMATE)))[PATCHER.DATAVERSE]
        self.assertIn('Web.Contents(#"Dataverse URL", [RelativePath = ApiPath & relativePath', dataverse)
        self.assertNotIn("Web.Contents(BaseUrl", dataverse)


class OptionalParametersStayOptional(unittest.TestCase):
    def test_site_parameter_is_required_only_in_sharepoint(self):
        self.assertTrue(parameters(load(PATCHER.SHAREPOINT))["SharePoint Site URL"])
        self.assertFalse(parameters(load(PATCHER.POWER_AUTOMATE))["SharePoint Site URL"])
        self.assertNotIn("SharePoint Site URL", parameters(load(PATCHER.LOCAL_CSV)))

    def test_blank_feedback_file_loads_an_empty_table(self):
        for relative, _ in PATCHER.TARGETS:
            model = load(relative)
            self.assertFalse(parameters(model)["Feedback File"], relative)
            feedback = dict(m_sources(model))["ProductFeedback"]
            self.assertIn('FilePath = #"Feedback File",', feedback, relative)
            self.assertIn(FEEDBACK_GUARD, feedback, relative)
            self.assertNotIn('Text.Trim(#"Feedback File")', feedback, relative)

    def test_blank_agent_file_loads_an_empty_table(self):
        for relative in (PATCHER.SHAREPOINT, PATCHER.POWER_AUTOMATE):
            model = load(relative)
            self.assertFalse(parameters(model)["Agent 365"], relative)
            agents = dict(m_sources(model))["Agents 365 Staging"]
            self.assertRegex(agents, r'FilePath = #"Agent 365"', relative)
            self.assertIn("EmptyTable", agents, relative)


if __name__ == "__main__":
    unittest.main()
