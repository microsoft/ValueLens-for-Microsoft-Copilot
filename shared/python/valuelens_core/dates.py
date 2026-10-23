"""Date guards shared by the Agent 365 notebooks.

Agent 365 reports a missing date as the .NET minimum, 0001-01-01, rather than
leaving it blank. Kept as-is, two such agents read as the oldest in the tenant
and skew "newest agents" and age bands. A `Date created` or `Last Activity
Date` before MIN_PLAUSIBLE_YEAR is read as blank. `Last updated` stays as sent:
the Registry Ingester keys history and incremental pulls on it. The Ingester
and the CSV Lander carry a copy of this rule; tests/test_agent365_dates.py
keeps them in step.
"""
from __future__ import annotations

import re
from datetime import date

MIN_PLAUSIBLE_YEAR = 2000
# The first standalone four-digit run is the year in ISO (0001-01-01T00:00:00Z)
# and in the admin center's US export format (1/1/0001 12:00:00 AM).
YEAR_PATTERN = r"(?<!\d)(\d{4})(?!\d)"
_YEAR = re.compile(YEAR_PATTERN)


def plausible_date(value):
    """`value` unchanged, or None when it's a date before MIN_PLAUSIBLE_YEAR."""
    if isinstance(value, date):
        return value if value.year >= MIN_PLAUSIBLE_YEAR else None
    if value is None:
        return None
    match = _YEAR.search(str(value))
    if match and int(match.group(1)) < MIN_PLAUSIBLE_YEAR:
        return None
    return value
