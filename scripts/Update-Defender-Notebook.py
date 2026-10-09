"""Copy shared/python/valuelens_core/defender.py into Copilot_Defender_Ingester.ipynb.

The notebook runs on its own in Fabric, so it carries the shared Defender logic in one cell.
Edit the module, then run this script; tests/test_defender.py fails while the two differ.

    python scripts/Update-Defender-Notebook.py
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "shared" / "python" / "valuelens_core" / "defender.py"
NOTEBOOK = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Defender_Ingester.ipynb"
MARKER = "# Shared Defender logic, copied from shared/python/valuelens_core/defender.py"
HEADER = [
    MARKER,
    "# by scripts/Update-Defender-Notebook.py. Edit the module and re-run the script, not this cell.",
    "",
]


def embedded_source(module_text: str) -> str:
    """The module without its docstring and `from __future__` line, under the marker comment."""
    tree = ast.parse(module_text)
    lines = module_text.split("\n")
    start = 0
    for node in tree.body:
        is_doc = isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant) \
            and isinstance(node.value.value, str)
        is_future = isinstance(node, ast.ImportFrom) and node.module == "__future__"
        if is_doc or is_future:
            start = node.end_lineno
            continue
        break
    body = "\n".join(lines[start:]).strip("\n")
    return "\n".join(HEADER) + body + "\n"


def to_source_lines(text: str) -> list[str]:
    parts = text.split("\n")
    out = [p + "\n" for p in parts[:-1]]
    if parts[-1]:
        out.append(parts[-1])
    return out


def shared_cell_index(notebook: dict) -> int:
    hits = [i for i, c in enumerate(notebook["cells"])
            if c.get("cell_type") == "code" and "".join(c.get("source", [])).startswith(MARKER)]
    if len(hits) != 1:
        raise SystemExit(f"Expected one cell starting with the marker in {NOTEBOOK.name}, found {len(hits)}.")
    return hits[0]


def main() -> int:
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    index = shared_cell_index(notebook)
    wanted = to_source_lines(embedded_source(MODULE.read_text(encoding="utf-8")))
    if notebook["cells"][index]["source"] == wanted:
        print("Notebook already matches the module.")
        return 0
    notebook["cells"][index]["source"] = wanted
    NOTEBOOK.write_text(json.dumps(notebook, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Updated cell {index} of {NOTEBOOK.name}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
