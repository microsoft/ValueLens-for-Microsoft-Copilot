"""Checks for the model refresh fixes in the Agent Evaluator and Consumption Central templates."""
import importlib.util
import json
import re
import unittest
import zipfile
from pathlib import Path

from m_eval import evaluate

ROOT = Path(__file__).resolve().parents[1]
AGENT_EVALUATOR = ROOT / "1. Fabric" / "Manual setup" / "Add Agent Evaluator" / "Agent Evaluator.pbit"
CONSUMPTION = ROOT / "1. Fabric" / "Manual setup" / "Add Credit Consumption" / "Consumption Central - Fabric.pbit"
SCRIPT = ROOT / "scripts" / "Update-Model-Refresh-Fixes.py"
CREDIT_TABLES = {
    "Credit Consumption (Agent)": "agent",
    "Credit Consumption (User)": "user",
    "Credit Consumption (Tenant)": "tenant",
}


def joined(value):
    return "\n".join(value) if isinstance(value, list) else value


def members(path):
    with zipfile.ZipFile(path) as archive:
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))
        pending = json.loads(archive.read("UnappliedChanges").decode("utf-16-le").lstrip("\ufeff"))
    return model["model"], pending


def model_queries(model):
    found = {}
    for table in model["tables"]:
        for partition in table.get("partitions", []):
            if partition["source"].get("type") == "m":
                found[table["name"]] = joined(partition["source"]["expression"])
    for expression in model.get("expressions", []):
        found[expression["name"]] = joined(expression["expression"])
    return found


def pending_queries(pending):
    return {query["name"]: joined(query["text"]) for query in pending["queries"]}


def both_copies(path):
    model, pending = members(path)
    return (("DataModelSchema", model_queries(model)), ("UnappliedChanges", pending_queries(pending)))


def load_script():
    spec = importlib.util.spec_from_file_location("update_model_refresh_fixes", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ModelRefreshFixes(unittest.TestCase):
    def test_templates_are_current(self):
        script = load_script()
        for relative, queries, functions, response_seconds in script.TARGETS:
            original = (ROOT / relative).read_bytes()
            rebuilt, changed = script.build(original, queries, functions, response_seconds)
            self.assertEqual(changed, [], relative)
            self.assertEqual(rebuilt, original, relative)

    def test_pending_query_copies_match_the_model(self):
        for path in (AGENT_EVALUATOR, CONSUMPTION):
            model, pending = members(path)
            in_model, in_pending = model_queries(model), pending_queries(pending)
            for name, text in in_pending.items():
                if name in in_model:
                    self.assertEqual(text, in_model[name], (path.name, name))

    def test_consumption_buffers_tables_read_column_by_column(self):
        # Unbuffered, Normalize's Table.Column calls each send their own query to the SQL endpoint.
        for member, queries in both_copies(CONSUMPTION):
            read = {name: text for name, text in queries.items()
                    if "GetTable(" in text and ("Normalize" in text or "Table.Column(Raw" in text)}
            self.assertGreaterEqual(len(read), 7, member)
            for name, text in read.items():
                self.assertRegex(text, r"Raw = let r = GetTable\(\"\w+\"\) in if r = null then null else Table\.Buffer\(r\),",
                                 (member, name))

    def test_response_seconds_does_not_use_allexcept(self):
        model, _ = members(AGENT_EVALUATOR)
        turns = next(t for t in model["tables"] if t["name"] == "Agent Turns")
        column = next(c for c in turns["columns"] if c["name"] == "Response Seconds")
        dax = joined(column["expression"])
        self.assertNotIn("ALLEXCEPT", dax)
        self.assertNotIn("CALCULATE", dax)
        self.assertIn("FILTER (", dax)
        self.assertIn("ALL ( 'Agent Turns'[conversation_id], 'Agent Turns'[turn_role], 'Agent Turns'[turn_timestamp_utc] )", dax)

    def test_fabric_credit_tables_fall_back_to_the_studio_tables(self):
        for member, queries in both_copies(AGENT_EVALUATOR):
            helper = queries["FabricCreditTable"]
            for table in ("studio_agent", "studio_user", "studio_tenant_daily"):
                self.assertIn(f'"{table}"', helper, member)
            self.assertIn('FabricTable("credit_consumption_" & name)', helper, member)
            self.assertIn("snapshot_month", helper, member)
            self.assertNotIn("Sql.Database", helper, member)
            for name, short in CREDIT_TABLES.items():
                text = queries[name]
                self.assertIn(f'(try FabricCreditTable("{short}", Cols) otherwise EmptyTable(Cols))', text, (member, name))
                self.assertNotIn(f'FabricTable("credit_consumption_{short}")', text, (member, name))

    def test_fabric_credit_table_renames_cover_every_credit_column(self):
        model, _ = members(AGENT_EVALUATOR)
        helper = model_queries(model)["FabricCreditTable"]
        renamed = set(re.findall(r'\{"[a-z0-9_]+", "(\w+)"\}', helper))
        for table in model["tables"]:
            if table["name"] in CREDIT_TABLES:
                columns = {c.get("sourceColumn", c["name"]) for c in table["columns"] if c.get("type") != "calculated"}
                self.assertLessEqual(columns, renamed, table["name"])

    def test_agent_name_map_reads_credit_names_in_fabric(self):
        for member, queries in both_copies(AGENT_EVALUATOR):
            text = queries["Agent Name Map"]
            self.assertIn('(try FabricCreditTable("agent", CreditCols) otherwise EmptyTable(CreditCols))', text, member)
            self.assertNotIn('"Fabric" then EmptyTable(CreditCols)', text, member)
            self.assertIn("Table.FromRecords(AgentNameMapRows(Rows),", text, member)

    def test_agent_name_map_rows_makes_both_keys_unique(self):
        model, _ = members(AGENT_EVALUATOR)
        unique = evaluate(model_queries(model)["AgentNameMapRows"])

        def row(name, schema, match_type):
            return {"credit_agent_name": name, "agent_schema": schema, "match_type": match_type, "match_key": "k"}

        result = unique([
            row("Payroll Helper", "cr9a2_payrollAgent", "Auto"),
            row("payroll helper ", "cr9a2_payrollAgent", "Auto"),
            row("Payroll Bot", "CR9A2_PAYROLLAGENT", "Auto"),
            row("Travel & Expense Agent", "cr9a2_payrollAgent", "Override"),
            row("Unknown One", None, "Unmatched"),
            row("Unknown Two", None, "Unmatched"),
            row("Blank Schema", "", "Auto"),
            row("Flow", "cr9a2_flow", "Auto"),
        ])
        by_name = {r["credit_agent_name"]: r for r in result}
        self.assertEqual(set(by_name), {"Travel & Expense Agent", "Payroll Helper", "Payroll Bot",
                                        "Unknown One", "Unknown Two", "Blank Schema", "Flow"})
        self.assertEqual(by_name["Travel & Expense Agent"]["agent_schema"], "cr9a2_payrollAgent")
        self.assertEqual(by_name["Travel & Expense Agent"]["match_type"], "Override")
        self.assertEqual(by_name["Flow"], row("Flow", "cr9a2_flow", "Auto"))
        for name in ("Payroll Helper", "Payroll Bot", "Unknown One", "Unknown Two", "Blank Schema"):
            self.assertEqual(by_name[name]["agent_schema"], f"(unmatched) {name}", name)
            self.assertEqual(by_name[name]["match_type"], "Unmatched", name)
        for column in ("credit_agent_name", "agent_schema"):
            keys = [r[column].rstrip().lower() for r in result]
            self.assertEqual(len(keys), len(set(keys)), column)

    def test_agent_name_map_rows_keeps_unique_rows(self):
        model, _ = members(AGENT_EVALUATOR)
        unique = evaluate(model_queries(model)["AgentNameMapRows"])
        rows = [{"credit_agent_name": "A", "agent_schema": "x_a", "match_type": "Auto", "match_key": "a"},
                {"credit_agent_name": "B", "agent_schema": "x_b", "match_type": "Override", "match_key": "b"}]
        self.assertEqual(sorted(unique(rows), key=lambda r: r["credit_agent_name"]), rows)
        self.assertEqual(unique([]), [])


if __name__ == "__main__":
    unittest.main()
