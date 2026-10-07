import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT / "shared" / "python", ROOT / "tests", ROOT / "5. Azure" / "jobs"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))
