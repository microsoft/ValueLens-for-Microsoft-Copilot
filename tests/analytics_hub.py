"""Parity with Analytics Hub, which moved to https://github.com/microsoft/AnalyticsHub-Dashboard.

The Fabric notebooks there are the source of truth for the classifiers that the Local CSV processor
copies, and for the model, glossary and task descriptions that the templates here share. Tests that
compare against them read a checkout of AnalyticsHub-Dashboard from ANALYTICS_HUB_ROOT. CI checks out
the release pinned in .github/workflows/tests.yml. Locally those tests skip when it isn't set:

    git clone https://github.com/microsoft/AnalyticsHub-Dashboard ../AnalyticsHub-Dashboard
    $env:ANALYTICS_HUB_ROOT = "../AnalyticsHub-Dashboard"
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

ENV = "ANALYTICS_HUB_ROOT"
_value = os.environ.get(ENV, "").strip()
AVAILABLE = bool(_value)

if not AVAILABLE and os.environ.get("GITHUB_ACTIONS") == "true":
    raise RuntimeError(f"{ENV} isn't set. tests.yml checks out AnalyticsHub-Dashboard and sets it.")

# When it isn't set, ROOT points at a folder that doesn't exist, so building paths at import is safe.
ROOT = Path(_value).resolve() if AVAILABLE else Path(__file__).resolve().parent / ".analytics-hub-not-set"
if AVAILABLE and not (ROOT / "fabric" / "notebooks").is_dir():
    raise RuntimeError(f"{ENV}={_value} isn't a checkout of AnalyticsHub-Dashboard.")

FABRIC = ROOT / "fabric"
NOTEBOOKS = FABRIC / "notebooks"
APP = ROOT / "app"
INSTALLER = ROOT / "installer"
AZURE = ROOT / "azure"

required = pytest.mark.skipif(not AVAILABLE, reason=f"{ENV} isn't set; see tests/analytics_hub.py")
