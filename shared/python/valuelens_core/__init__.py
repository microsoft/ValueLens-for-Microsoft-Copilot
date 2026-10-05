"""ValueLens shared processing logic (DuckDB engine).

The Fabric notebooks remain the reference implementation; this package is a
row-for-row port used by the Azure-hosted variant and verified by golden tests.
"""
from .processor import ENRICHED_COLS, REQUIRED_TEXT_COLS, curate

__all__ = ["curate", "ENRICHED_COLS", "REQUIRED_TEXT_COLS"]
__version__ = "0.1.0"
