"""Checks for the optional Agent Evaluator template."""
import json
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PBIT = ROOT / "1. Fabric" / "Manual setup" / "Add Agent Evaluator" / "Agent Evaluator.pbit"


def measures():
    with zipfile.ZipFile(PBIT) as archive:
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))
    found = {}
    for table in model["model"]["tables"]:
        for measure in table.get("measures", []):
            expression = measure["expression"]
            found[measure["name"]] = "\n".join(expression) if isinstance(expression, list) else expression
    return found


class AgentEvaluatorTemplateTests(unittest.TestCase):
    def test_answered_rate_is_the_complement_of_the_gap_rate(self):
        # Both are shares of knowledge searches, so Answered + Gap = 100%. Answered
        # used to divide by every session, and Focus 2 subtracted the two shares.
        found = measures()
        self.assertIn("1 - [Knowledge Gap Rate]", found["Knowledge Answered Rate"])
        self.assertIn("'Agent Sessions'[knowledge_searched] = TRUE ()", found["Knowledge Gap Rate"])
        self.assertIn("VAR gap = [Knowledge Gap Rate]", found["⭐ Focus 2: Knowledge Gap"])


if __name__ == "__main__":
    unittest.main()
