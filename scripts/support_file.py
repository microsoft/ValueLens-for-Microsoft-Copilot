"""Write a ValueLens support file without the installer.

For people who set ValueLens up by hand (Fabric notebooks, Azure, SharePoint + PAX or Local CSV).
It writes the same zip as the installer's ``--support-bundle``: ``valuelens-support-<yyyyMMdd-HHmmss>.zip``
(UTC) holding README.txt, manifest.json, settings.json, last-run.json, prereqs.json, runs.json,
row-counts.json and logs-summary.json, all plain text. Look through it, then email it to us.

It never reads a data row: CSVs are counted by line, tables with ``count()``. Secrets, keys and
tokens are removed; email addresses, UPNs and people's names are hashed with a random salt that
is never saved. Tenant, workspace and item IDs (GUIDs) are kept, because they help troubleshoot.

On a PC (Python 3.9 or later, nothing to install):

    python support_file.py --route csv --data "C:\\ValueLens\\output" --logs "C:\\ValueLens\\logs"
    python support_file.py --route pax --pax-root "%LOCALAPPDATA%\\ValueLens\\pax"
    python support_file.py --config my-settings.json --out .

In a Fabric notebook attached to the ValueLens Lakehouse: paste this file into a cell and run it.
It counts the Lakehouse's tables and writes the zip under Files/valuelens_support/, to download
from the Lakehouse explorer.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import secrets as _secrets
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

TOOL_VERSION = "1.0.0"
PRODUCT = "valuelens"
REMOVED = "[removed]"

SUPPORT_FILES = [
    "README.txt",
    "manifest.json",
    "settings.json",
    "last-run.json",
    "prereqs.json",
    "runs.json",
    "row-counts.json",
    "logs-summary.json",
]

ROUTE_NAMES = {
    "fabric": "Fabric",
    "azure": "Azure",
    "pax": "No Fabric: PAX + SharePoint",
    "csv": "Local CSV",
}

# The same rules as the installer (installer/src/support.js) and the Analytics Hub installer.
SECRET_KEY = re.compile(r"secret|password|token|key(?!Vault)|signature|connectionString|sas|credential|authorization", re.I)
SECRET_VALUES = [
    re.compile(r"\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*"),  # JWT
    re.compile(r"\bBearer\s+[\w.~+/=-]+", re.I),
    re.compile(r"\bsig=[^&\s\"';]+", re.I),  # SAS signature
    re.compile(r"\bAccountKey=[^;\s\"']+", re.I),
    re.compile(r"\b(?:password|pwd)=[^;\s\"'&]+", re.I),
    re.compile(r"[\w~.-]{3}\dQ~[\w~.-]{31,34}"),  # Entra client secret
]
EMAIL = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
PERSON_KEY = re.compile(
    r"^(upn|userPrincipalName|mail|email|adminEmail|contact|owner|createdBy|userName|userDisplayName|signedInUser|displayName|givenName|surname)$",
    re.I,
)
THING_PARENT = re.compile(r"^(app|keyVault|fabric|semanticModel|managedApp|powerBi|sharePoint|pax|access)$", re.I)

REDACTION_RULES = [
    f'Values under keys matching /{SECRET_KEY.pattern}/i are replaced with "{REMOVED}".',
    f'Values that look like a JWT, a Bearer token, a SAS signature (sig=), an AccountKey=, a password= or an Entra client secret are replaced with "{REMOVED}".',
    "Email addresses, UPNs and people's names are replaced with user-<hash>: SHA-256 of a random salt and the lowercased value. "
    "The salt is never saved, so the hashes can't be reversed, but the same person gets the same hash throughout this file.",
    "Tenant, workspace and item IDs (GUIDs) are kept: they are needed to troubleshoot.",
    "No data rows are read or included: only row counts.",
]

LOG_RULES = {
    "http429": re.compile(r"\b429\b|too ?many ?requests|throttl", re.I),
    "http401": re.compile(r"\b401\b|unauthori[sz]ed|invalid_client|AADSTS\d+", re.I),
    "http403": re.compile(r"\b403\b|forbidden|Authorization_RequestDenied|insufficient privileges", re.I),
    "timeouts": re.compile(r"timed? ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|TaskCanceled", re.I),
}
WINDOW_LINE = re.compile(r"==>\s*Window\s+\d+\s+of\s+\d+", re.I)
ERROR_LINE = re.compile(r"\bERROR\b|\berror:|exception|\bfailed\b|exit code [1-9]", re.I)

DATA_CHECK_FILE = "Files/valuelens_installer/data_check.json"


def not_collected(reason: str) -> Dict[str, str]:
    return {"notCollected": reason}


class Redactor:
    """Hashes people and removes secrets, counting what it changed. One per support file."""

    def __init__(self, salt: Optional[bytes] = None) -> None:
        self.salt = salt if salt is not None else _secrets.token_bytes(16)
        self.counts = {"secrets": 0, "emails": 0, "names": 0}
        self.names: List[str] = []

    def token(self, value: str) -> str:
        h = hashlib.sha256(self.salt + value.strip().lower().encode("utf-8")).hexdigest()
        return f"user-{h[:10]}"

    def learn(self, name: Any) -> None:
        if not isinstance(name, str):
            return
        n = name.strip()
        if len(n) < 3 or "@" in n or re.fullmatch(r"user-[0-9a-f]{10}", n):
            return
        if n not in self.names:
            self.names = sorted([*self.names, n], key=len, reverse=True)

    def learn_from(self, v: Any, key: Optional[str] = None, parent: Optional[str] = None) -> None:
        if isinstance(v, str):
            if key and PERSON_KEY.match(key) and not (key == "displayName" and parent and THING_PARENT.match(parent)):
                self.learn(v)
        elif isinstance(v, list):
            for x in v:
                self.learn_from(x, None, key)
        elif isinstance(v, dict):
            for k, x in v.items():
                self.learn_from(x, k, key)

    def text(self, s: str) -> str:
        out = str(s)

        def removed(_m: "re.Match[str]") -> str:
            self.counts["secrets"] += 1
            return REMOVED

        for rx in SECRET_VALUES:
            out = rx.sub(removed, out)

        def email(m: "re.Match[str]") -> str:
            self.counts["emails"] += 1
            return self.token(m.group(0))

        out = EMAIL.sub(email, out)
        for n in self.names:
            rx = re.compile(r"(?<![\w])" + re.escape(n) + r"(?![\w])", re.I)

            def name(_m: "re.Match[str]", n: str = n) -> str:
                self.counts["names"] += 1
                return self.token(n)

            out = rx.sub(name, out)
        return out

    def value(self, value: Any, key: Optional[str] = None, parent: Optional[str] = None) -> Any:
        if key is not None and SECRET_KEY.search(key) and value not in (None, "", False):
            self.counts["secrets"] += 1
            return REMOVED
        if isinstance(value, str):
            if key is not None and PERSON_KEY.match(key) and not (key == "displayName" and parent and THING_PARENT.match(parent)) and value.strip():
                if "@" in value:
                    return self.text(value)
                self.learn(value)
                self.counts["names"] += 1
                return self.token(value)
            return self.text(value)
        if isinstance(value, list):
            return [self.value(v, None, key) for v in value]
        if isinstance(value, dict):
            return {k: self.value(v, k, key) for k, v in value.items()}
        return value


def summarise_log(text: str, r: Redactor) -> Dict[str, Any]:
    lines = str(text or "").splitlines() or [""]
    out: Dict[str, Any] = {"lines": len(lines), "http429": 0, "http401": 0, "http403": 0, "timeouts": 0, "windows": 0, "firstError": None}
    for line in lines:
        for k, rx in LOG_RULES.items():
            if rx.search(line):
                out[k] += 1
        if WINDOW_LINE.search(line):
            out["windows"] += 1
        if out["firstError"] is None and ERROR_LINE.search(line):
            out["firstError"] = r.text(line.strip())[:500]
    return out


def csv_row_counts(folder: Path, max_depth: int = 3) -> Dict[str, int]:
    """Rows per CSV under a folder, counted by line breaks. No row is read into the file."""
    out: Dict[str, int] = {}

    def walk(d: Path, rel: str, depth: int) -> None:
        try:
            entries = sorted(d.iterdir())
        except OSError:
            return
        for e in entries:
            name = f"{rel}/{e.name}" if rel else e.name
            if e.is_dir() and depth < max_depth:
                walk(e, name, depth + 1)
            elif e.is_file() and e.suffix.lower() == ".csv":
                try:
                    lines = 0
                    last = b""
                    with e.open("rb") as f:
                        for chunk in iter(lambda: f.read(1 << 20), b""):
                            lines += chunk.count(b"\n")
                            last = chunk
                    if last and not last.endswith(b"\n"):
                        lines += 1
                    out[name] = max(0, lines - 1)
                except OSError:
                    pass

    walk(folder, "", 0)
    return out


def newest_logs(folder: Path, n: int = 5) -> List[Path]:
    try:
        files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in (".log", ".txt")]
    except OSError:
        return []
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[:n]


def read_json(path: Optional[Path]) -> Any:
    if not path:
        return None
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def file_name(now: datetime) -> str:
    return f"{PRODUCT}-support-{now.astimezone(timezone.utc):%Y%m%d-%H%M%S}.zip"


def collect(
    route: str,
    config: Optional[Path] = None,
    data: Optional[Path] = None,
    logs: Optional[Path] = None,
    pax_root: Optional[Path] = None,
    table_counts: Optional[Callable[[], Dict[str, Any]]] = None,
    runs: Any = None,
    now: Optional[datetime] = None,
    redactor: Optional[Redactor] = None,
) -> List[Dict[str, str]]:
    """The support file's contents, in order, as {name, text}."""
    now = now or datetime.now(timezone.utc)
    r = redactor or Redactor()
    if route not in ROUTE_NAMES:
        raise ValueError(f"route must be one of {', '.join(ROUTE_NAMES)}")
    if pax_root:
        data = data or pax_root / "data"
        logs = logs or pax_root / "logs"

    settings = read_json(config)
    state = read_json(pax_root / "state.json") if pax_root else None
    r.learn_from(settings)
    r.learn_from(state)

    files: Dict[str, Any] = {}
    if settings is not None:
        files["settings.json"] = r.value(settings)
    elif config:
        files["settings.json"] = not_collected(f"{Path(config).name} couldn't be read as JSON.")
    else:
        files["settings.json"] = not_collected("No settings file was given. Pass --config with your settings or install record.")

    manual = "Made with the manual support script, not the installer, so there is no installer run to show."
    files["last-run.json"] = not_collected(manual)
    files["prereqs.json"] = not_collected(manual + " Run the installer's prereqs command to check prerequisites and permissions.")

    if runs is not None:
        files["runs.json"] = r.value(runs)
    elif state is not None:
        files["runs.json"] = r.value({"refreshState": state})
    else:
        files["runs.json"] = not_collected("No run history was found here. For Fabric, open the pipeline's run history; for PAX, pass --pax-root.")

    counts: Any = None
    if table_counts is not None:
        try:
            counts = table_counts()
        except Exception as err:  # noqa: BLE001 - the reason goes in the file
            counts = not_collected(r.text(f"Counting the tables failed: {err}")[:300])
    elif data is not None:
        counts = csv_row_counts(Path(data)) if Path(data).is_dir() else None
        if not counts:
            counts = not_collected(f"No CSV files under {Path(data).name}.")
    files["row-counts.json"] = counts if counts is not None else not_collected("No data folder or tables were given. Pass --data with the folder that holds the CSVs.")

    summaries: Dict[str, Any] = {}
    for p in newest_logs(Path(logs)) if logs else []:
        try:
            summaries[p.name] = summarise_log(p.read_text(encoding="utf-8", errors="replace"), r)
        except OSError:
            summaries[p.name] = not_collected("The log couldn't be read.")
    files["logs-summary.json"] = summaries or not_collected("No logs were found. Pass --logs with the folder that holds them.")

    body = [{"name": n, "text": json.dumps(files[n], indent=2, ensure_ascii=False) + "\n"} for n in SUPPORT_FILES[2:]]
    created = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    readme = readme_text(created, ROUTE_NAMES[route], r.counts)
    manifest = {
        "product": PRODUCT,
        "installerVersion": None,
        "tool": f"support_file.py {TOOL_VERSION}",
        "createdAt": created,
        "route": route,
        "routeName": ROUTE_NAMES[route],
        "signedIn": False,
        "files": [{"name": "README.txt", "bytes": len(readme.encode("utf-8"))}]
        + [{"name": f["name"], "bytes": len(f["text"].encode("utf-8"))} for f in body],
        "redaction": {"rules": REDACTION_RULES, "counts": dict(r.counts)},
    }
    return [
        {"name": "README.txt", "text": readme},
        {"name": "manifest.json", "text": json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"},
        *body,
    ]


def readme_text(created: str, route_name: str, counts: Dict[str, int]) -> str:
    return "\r\n".join(
        [
            "ValueLens support file",
            f"Made by support_file.py {TOOL_VERSION} at {created} (UTC). Route: {route_name}.",
            "Made without the installer, from the files and tables given to it.",
            "",
            "What's inside (all plain text, so you can read every file before you send it):",
            "  manifest.json      the route, the files and what was removed",
            "  settings.json      your settings, with secrets removed",
            "  last-run.json      the last installer run (not collected by this script)",
            "  prereqs.json       the prerequisite and permission checks (not collected by this script)",
            "  runs.json          recent refresh state or runs, with their error messages",
            "  row-counts.json    rows per table (counts only: a 0 shows a source that loaded nothing)",
            "  logs-summary.json  per log: HTTP 429, 401 and 403 lines, timeouts, time windows, first error",
            "",
            "What was removed:",
            *[f"  - {rule}" for rule in REDACTION_RULES],
            f"  This file: {counts['secrets']} secret value(s) removed, {counts['emails']} email address(es) and {counts['names']} name(s) hashed.",
            "",
            'A piece that couldn\'t be collected says why, as { "notCollected": "<reason>" }.',
            "",
        ]
    )


def write_zip(files: List[Dict[str, str]], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.writestr(f["name"], f["text"].encode("utf-8"))
    path.write_bytes(buf.getvalue())
    return path


def spark_table_counts(spark: Any) -> Dict[str, Any]:
    """Rows per table in the attached Lakehouse, with count() only."""
    out: Dict[str, Any] = {}
    for t in spark.catalog.listTables():
        if getattr(t, "isTemporary", False):
            continue
        try:
            out[t.name] = spark.table(t.name).count()
        except Exception as err:  # noqa: BLE001
            out[t.name] = not_collected(str(err).splitlines()[0][:200])
    return out


def _active_spark() -> Any:
    try:
        from pyspark.sql import SparkSession  # type: ignore

        return SparkSession.getActiveSession()
    except Exception:  # noqa: BLE001
        return None


def run_in_fabric(spark: Any, out_dir: str = "/lakehouse/default/Files/valuelens_support") -> Path:
    """For a Fabric notebook cell: counts the Lakehouse's tables and saves the zip under Files/."""
    lakehouse = Path("/lakehouse/default")
    check = read_json(lakehouse / DATA_CHECK_FILE)
    now = datetime.now(timezone.utc)
    files = collect(
        "fabric",
        table_counts=lambda: spark_table_counts(spark),
        runs={"dataCheck": check} if check is not None else None,
        now=now,
    )
    path = write_zip(files, Path(out_dir) / file_name(now))
    print(f"Support file: {path}\nDownload it from Files/valuelens_support in the Lakehouse explorer, look through it, then email it to us.")
    return path


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Write a ValueLens support file to email us. Secrets are removed and people's names hashed.")
    p.add_argument("--route", choices=list(ROUTE_NAMES), help="Where ValueLens runs. Default: pax with --pax-root, otherwise csv.")
    p.add_argument("--config", type=Path, help="Your settings or install record (JSON). Secrets are removed.")
    p.add_argument("--data", type=Path, help="The folder that holds the CSV output. Only the rows are counted.")
    p.add_argument("--logs", type=Path, help="The folder that holds the refresh logs.")
    p.add_argument("--pax-root", type=Path, help="The PAX refresh folder (holds state.json, logs and data).")
    p.add_argument("--out", type=Path, default=Path("."), help="The folder for the zip (default: this folder).")
    a, _ = p.parse_known_args(argv)
    route = a.route or ("pax" if a.pax_root else "csv")
    now = datetime.now(timezone.utc)
    files = collect(route, config=a.config, data=a.data, logs=a.logs, pax_root=a.pax_root, now=now)
    path = write_zip(files, a.out / file_name(now))
    print(f"Support file: {path.resolve()}")
    for f in files:
        print(f"  {f['name']}")
    print("Look through it (all plain text), then email it to us.")
    return 0


if __name__ == "__main__":
    _spark = globals().get("spark") or (_active_spark() if "ipykernel" in sys.modules else None)
    if _spark is not None and os.path.isdir("/lakehouse/default"):
        run_in_fabric(_spark)
    else:
        sys.exit(main())
