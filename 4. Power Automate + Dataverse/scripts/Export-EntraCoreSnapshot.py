#!/usr/bin/env python3
"""Read-only Microsoft Graph directory snapshot exporter for the Power Automate +
Dataverse core pathway (the "PA+DV" alternative to the Local CSV pathway).

This is a *basic org* exporter only: it reads ``GET /v1.0/users`` (paged) and
``GET /v1.0/subscribedSkus`` and writes a CSV that is a drop-in "--entra" input
for ``Build-DataverseCoreFeeds.py``, which in turn hands it to the canonical
processor (``1. Local CSV/scripts/Purview_CopilotInteraction_Processor_v4.0.0.py``).
It does not walk manager chains, groups, or any deeper org hierarchy — bring
your own data (BYOD) via a CSV built from your own HR/org source for that.

Required Microsoft Graph application permissions (admin consent, read-only):
    User.Read.All
    Organization.Read.All

Output columns (aliases recognized by the canonical processor):
    userPrincipalName, displayName, department, jobTitle, "Has license" (TRUE/FALSE),
    "License Status" (Licensed/Unlicensed)

Auth:
    Reads the bearer token from the GRAPH_ACCESS_TOKEN environment variable only.
    The token is never written to the CSV, stdout, stderr, or any log line.

Licensing determination:
    "Has license" is TRUE only if the user's assignedLicenses contain a skuId
    from the approved allowlist (below) — i.e. a verified, non-trial SKU that
    grants standalone paid M365 Copilot capability. No broad "contains Copilot"
    string matching on product names is used, and trial/E5 SKUs are never
    treated as licensed by default.

Approved SKU allowlist (source: Microsoft Learn "Product names and service
plan identifiers for licensing", licensing-service-plan-reference, reviewed
2026-09-11 revision dated 2026-08-19):
    https://learn.microsoft.com/en-us/entra/identity/users/licensing-service-plan-reference
      Microsoft 365 E7              skuPartNumber MICROSOFT_365_E7        skuId 9a18296a-025f-4e37-9ffa-30bf8d1ce775
      Copilot for Microsoft 365     skuPartNumber Microsoft_365_Copilot   skuId 639dec6b-bb19-468b-871c-c5c441c4b0cb
        (the standalone paid M365 Copilot add-on SKU; NOT a trial SKU)

Use --copilot-sku-id to opt in additional verified SKU GUIDs (e.g. a
sovereign-cloud variant of the same product) on a per-run basis. Any assigned
SKU whose skuPartNumber looks Copilot- or E7-like (by name) but is not in the
allowlist triggers a warning on stderr rather than being silently counted
either way, so an operator can review and, if legitimate, add it explicitly.

Safety:
    * Every Graph URL (including @odata.nextLink pagination links) is
      validated to be same-origin (https://graph.microsoft.com) before any
      request is made, and cross-origin HTTP redirects are refused, so the
      bearer token is never replayed off-origin.
    * Bounded retry with Retry-After honored on HTTP 429/5xx.
    * The output CSV is written atomically (temp file + rename) to the
      explicit --output path; a failed/partial run never overwrites a
      previous successful snapshot.
    * An empty snapshot (zero users) is a hard failure, not an empty file.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib import error, request
from urllib.parse import urlsplit

GRAPH_ORIGIN = "https://graph.microsoft.com"
USERS_SELECT = "id,userPrincipalName,displayName,department,jobTitle,assignedLicenses"
USERS_URL = f"{GRAPH_ORIGIN}/v1.0/users?$select={USERS_SELECT}&$top=999"
SKUS_URL = f"{GRAPH_ORIGIN}/v1.0/subscribedSkus"

MAX_HTTP_ATTEMPTS = 6
MAX_RETRY_SLEEP = 60.0
DEFAULT_TIMEOUT = 100
MAX_PAGES = 1000  # sanity bound; a legitimate tenant will finish long before this

# Verified, non-trial SKUs that grant standalone paid M365 Copilot capability.
# See the module docstring for the authoritative source and verification date.
APPROVED_LICENSE_SKUS: dict[str, str] = {
    "9a18296a-025f-4e37-9ffa-30bf8d1ce775": "MICROSOFT_365_E7",
    "639dec6b-bb19-468b-871c-c5c441c4b0cb": "Microsoft_365_Copilot",
}

# Word-boundary match so "E7" doesn't false-positive inside unrelated tokens.
_E7_WORD_RE = re.compile(r"(?<![A-Za-z0-9])E7(?![A-Za-z0-9])", re.IGNORECASE)

CSV_FIELDNAMES = [
    "userPrincipalName",
    "displayName",
    "department",
    "jobTitle",
    "Has license",
    "License Status",
]


class ExportError(RuntimeError):
    """Raised for any condition that must stop the export rather than guess."""


def _graph_origin(url: str) -> str:
    """Return the lowercase scheme://host[:port] origin of a URL."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    netloc = host + (f":{parts.port}" if parts.port else "")
    return f"{parts.scheme.lower()}://{netloc}"


class _SameOriginRedirectHandler(request.HTTPRedirectHandler):
    """Refuse cross-origin redirects so the Authorization header is never
    replayed to a different host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        if _graph_origin(newurl) != _graph_origin(req.full_url):
            raise ExportError("Refusing cross-origin redirect; credentials would leak off-origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _perform_request(req: "request.Request") -> dict[str, Any]:
    """Issue one HTTP request and parse the JSON body. Isolated as its own
    function so tests can substitute it without touching the network."""
    opener = request.build_opener(_SameOriginRedirectHandler)
    with opener.open(req, timeout=DEFAULT_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def graph_get(url: str, token: str) -> dict[str, Any]:
    """GET a Microsoft Graph URL with bounded retry on 429/5xx, honoring
    Retry-After. Never logs the token or Authorization header. Refuses to
    call, or follow a redirect/nextLink to, any non-Graph origin."""
    origin = _graph_origin(url)
    if origin != GRAPH_ORIGIN:
        raise ExportError(f"Refusing to call non-Graph origin: {origin}")
    attempt = 0
    while True:
        attempt += 1
        req = request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        try:
            return _perform_request(req)
        except error.HTTPError as exc:
            retryable = exc.code in (429, 500, 502, 503, 504)
            if retryable and attempt < MAX_HTTP_ATTEMPTS:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                try:
                    sleep_for = float(retry_after) if retry_after else float(2**attempt)
                except (TypeError, ValueError):
                    sleep_for = float(2**attempt)
                time.sleep(min(sleep_for, MAX_RETRY_SLEEP))
                continue
            raise ExportError(f"Graph request failed: HTTP {exc.code} {exc.reason}") from exc
        except error.URLError as exc:
            if attempt < MAX_HTTP_ATTEMPTS:
                time.sleep(min(float(2**attempt), MAX_RETRY_SLEEP))
                continue
            raise ExportError(f"Graph request failed: {exc.reason}") from exc


def _paginate(first_url: str, token: str) -> list[dict[str, Any]]:
    """Follow @odata.nextLink pages, refusing off-origin links and repeated
    links (a pagination loop), and bounding total pages defensively."""
    values: list[dict[str, Any]] = []
    url: str | None = first_url
    seen: set[str] = set()
    pages = 0
    while url:
        if url in seen:
            raise ExportError("Graph pagination loop detected (repeated @odata.nextLink)")
        seen.add(url)
        pages += 1
        if pages > MAX_PAGES:
            raise ExportError(f"Graph pagination exceeded {MAX_PAGES} pages; refusing to continue")
        page = graph_get(url, token)
        values.extend(page.get("value") or [])
        url = page.get("@odata.nextLink")
    return values


def fetch_all_users(token: str) -> list[dict[str, Any]]:
    return _paginate(USERS_URL, token)


def fetch_subscribed_skus(token: str) -> dict[str, dict[str, Any]]:
    """Return {lowercase skuId: subscribedSku dict} for the tenant."""
    skus: dict[str, dict[str, Any]] = {}
    for sku in _paginate(SKUS_URL, token):
        sku_id = (sku.get("skuId") or "").lower()
        if sku_id:
            skus[sku_id] = sku
    return skus


def approved_sku_ids(extra_copilot_sku_ids: list[str] | None) -> dict[str, str]:
    """Merge the verified default allowlist with any opt-in --copilot-sku-id values."""
    approved = dict(APPROVED_LICENSE_SKUS)
    for sku_id in extra_copilot_sku_ids or []:
        normalized = (sku_id or "").strip().lower()
        if normalized:
            approved.setdefault(normalized, "opt-in-copilot-sku")
    return approved


def _looks_copilot_or_e7(sku_part_number: str) -> bool:
    """Heuristic used only to decide whether to *warn* about an unrecognized
    SKU; it never marks a user licensed on its own."""
    if not sku_part_number:
        return False
    if "copilot" in sku_part_number.lower():
        return True
    return bool(_E7_WORD_RE.search(sku_part_number))


def classify_user(
    user: dict[str, Any],
    subscribed_skus: dict[str, dict[str, Any]],
    approved: dict[str, str],
    warnings: list[str],
) -> tuple[str, str]:
    """Return ("TRUE"/"FALSE", "Licensed"/"Unlicensed") for one Graph user
    record, based solely on assignedLicenses skuIds present in the tenant's
    /subscribedSkus and the approved allowlist."""
    upn = user.get("userPrincipalName") or user.get("id") or "<unknown user>"
    has_license = False
    for lic in user.get("assignedLicenses") or []:
        sku_id = (lic.get("skuId") or "").strip().lower()
        if not sku_id:
            continue
        sku_info = subscribed_skus.get(sku_id)
        if sku_info is None:
            raise ExportError(
                f"User {upn} has assigned license skuId '{sku_id}' that is not present in this "
                "tenant's /subscribedSkus response; refusing to silently label the user unlicensed"
            )
        if sku_id in approved:
            has_license = True
            continue
        sku_part_number = sku_info.get("skuPartNumber", "")
        if _looks_copilot_or_e7(sku_part_number):
            warnings.append(
                f"User {upn}: assigned SKU '{sku_part_number}' ({sku_id}) looks Copilot/E7-like by "
                "name but is not in the verified allowlist; NOT counted as licensed. Review it and, "
                "if legitimate, add it explicitly with --copilot-sku-id."
            )
    return ("TRUE" if has_license else "FALSE"), ("Licensed" if has_license else "Unlicensed")


def build_rows(
    users: list[dict[str, Any]],
    subscribed_skus: dict[str, dict[str, Any]],
    approved: dict[str, str],
) -> tuple[list[dict[str, str]], list[str]]:
    rows: list[dict[str, str]] = []
    warnings: list[str] = []
    for user in users:
        has_license, status = classify_user(user, subscribed_skus, approved, warnings)
        rows.append(
            {
                "userPrincipalName": user.get("userPrincipalName") or "",
                "displayName": user.get("displayName") or "",
                "department": user.get("department") or "",
                "jobTitle": user.get("jobTitle") or "",
                "Has license": has_license,
                "License Status": status,
            }
        )
    return rows, warnings


def write_csv_atomic(rows: list[dict[str, str]], output_path: Path) -> None:
    """Write the CSV to a temp file in the same directory, then atomically
    rename over the destination. A failure at any point before the rename
    leaves a prior successful snapshot at output_path untouched."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=output_path.name + ".", suffix=".tmp", dir=str(output_path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=CSV_FIELDNAMES)
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, output_path)
    except BaseException:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


def run_export(token: str | None, output_path: Path, extra_copilot_sku_ids: list[str] | None) -> dict[str, Any]:
    if not token:
        raise ExportError(
            "GRAPH_ACCESS_TOKEN environment variable is required and was not set "
            "(never pass a token on the command line)"
        )
    users = fetch_all_users(token)
    if not users:
        raise ExportError("Microsoft Graph returned zero users; refusing to write an empty snapshot")
    subscribed_skus = fetch_subscribed_skus(token)
    approved = approved_sku_ids(extra_copilot_sku_ids)
    rows, warnings = build_rows(users, subscribed_skus, approved)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    write_csv_atomic(rows, output_path)
    licensed = sum(1 for row in rows if row["Has license"] == "TRUE")
    return {
        "usersExported": len(rows),
        "licensedCount": licensed,
        "unlicensedCount": len(rows) - licensed,
        "warnings": len(warnings),
        "outputPath": str(output_path),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Read-only Microsoft Graph /users + /subscribedSkus exporter for the Power "
            "Automate + Dataverse core pathway. Basic org only; BYOD your own CSV for "
            "deeper hierarchy. Requires Graph roles User.Read.All and Organization.Read.All."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Auth: reads the bearer token from the GRAPH_ACCESS_TOKEN environment variable only.\n"
            "Approved license SKUs (see module docstring for the authoritative source):\n"
            "  MICROSOFT_365_E7        9a18296a-025f-4e37-9ffa-30bf8d1ce775\n"
            "  Microsoft_365_Copilot   639dec6b-bb19-468b-871c-c5c441c4b0cb (standalone paid Copilot)\n"
        ),
    )
    parser.add_argument("--output", required=True, type=Path, help="Explicit output CSV path (written atomically)")
    parser.add_argument(
        "--copilot-sku-id",
        dest="copilot_sku_ids",
        action="append",
        default=[],
        metavar="SKU_GUID",
        help="Opt-in: an additional verified Copilot skuId (GUID) to treat as licensed. Repeatable.",
    )
    args = parser.parse_args(argv)

    token = os.environ.get("GRAPH_ACCESS_TOKEN")
    try:
        summary = run_export(token, args.output, args.copilot_sku_ids)
    except ExportError as exc:
        print(f"Export-EntraCoreSnapshot failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
