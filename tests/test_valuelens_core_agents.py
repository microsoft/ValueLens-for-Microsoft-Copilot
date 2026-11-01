"""The core agent link and agent type modules are verbatim copies of notebook definitions."""
import ast
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
MODULES = [ROOT / "shared" / "python" / "valuelens_core" / name
           for name in ("agent_link.py", "agent_type.py", "incremental.py")]


def _notebook_code() -> str:
    cells = json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]
    return "\n".join("".join(c["source"]) for c in cells if c["cell_type"] == "code")


def _definitions(path: Path):
    text = path.read_text(encoding="utf-8")
    for node in ast.parse(text).body:
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.FunctionDef, ast.ClassDef)):
            yield ast.get_source_segment(text, node)


@pytest.mark.parametrize("path", MODULES, ids=lambda p: p.name)
def test_module_definitions_are_in_the_notebook(path):
    code = _notebook_code()
    definitions = list(_definitions(path))
    assert definitions
    missing = [d.splitlines()[0] for d in definitions if d not in code]
    assert not missing, f"{path.name} drifted from the notebook: {missing}"
