"""Execute the pure-Python parts of a Fabric notebook (imports, defs, chosen constants) for parity tests."""
from __future__ import annotations

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOKS = ROOT / "1. Fabric" / "Manual setup" / "notebooks"
_SKIP_IMPORTS = {"pyspark", "notebookutils", "requests"}


def _keep_import(node) -> bool:
    names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
    return not any(n.split(".")[0] in _SKIP_IMPORTS for n in names)


def namespace(notebook: str, keep_assigns: set[str] = frozenset()) -> dict:
    """Functions, classes and the named top-level assignments from every code cell, in order."""
    cells = json.loads((NOTEBOOKS / notebook).read_text(encoding="utf-8"))["cells"]
    ns: dict = {}
    for index, cell in enumerate(cells):
        if cell.get("cell_type") != "code":
            continue
        try:
            tree = ast.parse("".join(cell["source"]))
        except SyntaxError:
            continue
        body = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                body.append(node)
            elif isinstance(node, (ast.Import, ast.ImportFrom)) and _keep_import(node):
                body.append(node)
            elif isinstance(node, ast.Assign) and all(
                    isinstance(t, ast.Name) and t.id in keep_assigns for t in node.targets):
                body.append(node)
        if body:
            exec(compile(ast.Module(body=body, type_ignores=[]), f"{notebook}:cell{index}", "exec"), ns)
    return ns
