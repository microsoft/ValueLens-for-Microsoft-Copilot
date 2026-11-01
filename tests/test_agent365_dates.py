"""Agent 365 dates before 2000 load as blank, in core and in both Fabric notebooks."""
import json
from datetime import date, datetime, timezone

import pytest

import notebook_source
from valuelens_core import dates

REGISTRY = "Copilot_Agent365_Registry_Ingester.ipynb"
LANDER = "Copilot_Agent365_Lander.ipynb"
CONSTANTS = {"MIN_PLAUSIBLE_YEAR", "YEAR_PATTERN", "DATE_COLUMNS"}

CASES = [
    ("0001-01-01T00:00:00Z", None),
    ("0001-01-01", None),
    ("1/1/0001 12:00:00 AM", None),
    ("1999-12-31T23:59:59Z", None),
    ("2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z"),
    ("2026-09-10T08:00:00Z", "2026-09-10T08:00:00Z"),
    ("9/10/2026 8:00:00 AM", "9/10/2026 8:00:00 AM"),
    ("Not Available", "Not Available"),
    ("", ""),
    (None, None),
    (date(1, 1, 1), None),
    (datetime(2026, 9, 10, tzinfo=timezone.utc), datetime(2026, 9, 10, tzinfo=timezone.utc)),
]


def _cell_sources(notebook):
    cells = json.loads((notebook_source.NOTEBOOKS / notebook).read_text(encoding="utf-8"))["cells"]
    return ["".join(cell["source"]) for cell in cells if cell["cell_type"] == "code"]


@pytest.mark.parametrize(("value", "expected"), CASES)
def test_core_blanks_dates_before_2000(value, expected):
    assert dates.plausible_date(value) == expected


@pytest.mark.parametrize(("value", "expected"), CASES)
def test_registry_ingester_matches_core(value, expected):
    ns = notebook_source.namespace(REGISTRY, CONSTANTS)
    assert ns["_plausible_date"](value) == expected


@pytest.mark.parametrize("notebook", [REGISTRY, LANDER])
def test_notebook_constants_match_core(notebook):
    ns = notebook_source.namespace(notebook, CONSTANTS)
    assert ns["MIN_PLAUSIBLE_YEAR"] == dates.MIN_PLAUSIBLE_YEAR
    assert ns["YEAR_PATTERN"] == dates.YEAR_PATTERN


def test_registry_rows_guard_date_created_and_last_activity():
    row_cell = next(s for s in _cell_sources(REGISTRY) if "'Date created':" in s)
    for field in ("createdDateTime", "lastUsedDateTime"):
        assert f"_plausible_date(detail.get('{field}'))" in row_cell
    # 'Last updated' keys history and stamps changes, so it stays as sent.
    assert "_plausible_date(detail.get('lastModifiedDateTime'))" not in row_cell


def test_lander_blanks_dates_before_snapshot_as_of_and_write():
    ns = notebook_source.namespace(LANDER, CONSTANTS)
    assert ns["DATE_COLUMNS"] == ("Date created", "Last Activity Date")
    cell = next(s for s in _cell_sources(LANDER) if "def _blank_implausible_dates" in s)
    blank = cell.index("df, dates_blanked = _blank_implausible_dates(df)")
    assert blank < cell.index("row_count = df.count()")
    assert blank < cell.index("as_of = df.agg(")
    assert blank < cell.index("saveAsTable(OUTPUT_TABLE)")
