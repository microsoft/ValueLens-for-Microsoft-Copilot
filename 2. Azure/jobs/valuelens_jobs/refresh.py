"""Refresh the Power BI semantic models. Port of the Fabric `ValueLens_Refresh_Model` notebook.

Enhanced refresh (Premium/PPU/Fabric capacity) is tried first so the incremental refresh policy
applies; a Pro workspace rejects it with 400, so the standard refresh is used instead and its
outcome is read from the refresh history.
"""
from __future__ import annotations

import logging
import time
from datetime import timedelta

from .api import POWERBI

log = logging.getLogger("valuelens_jobs.refresh")

BASE = "https://api.powerbi.com/v1.0/myorg"
FINAL = {"Completed", "Failed", "Cancelled", "Disabled", "TimedOut"}
ENHANCED = {"type": "full", "commitMode": "transactional", "applyRefreshPolicy": True, "retryCount": 1}
# Reloads every partition, not just the incremental window. Used when older days were republished.
ENHANCED_ALL = {**ENHANCED, "applyRefreshPolicy": False}
STANDARD = {"notifyOption": "NoNotification"}
# The template's incremental refresh policy reloads the 7 days before today (offset -1).
INCREMENTAL_DAYS = 7


def needs_full_refresh(publish_results, today) -> bool:
    """True when publish rewrote or removed a day the incremental refresh window won't reload."""
    oldest = min((r["oldest_day"] for r in publish_results or [] if r.get("oldest_day")), default=None)
    return oldest is not None and oldest < (today - timedelta(days=INCREMENTAL_DAYS)).isoformat()


class Refresher:
    def __init__(self, api, *, sleep=time.sleep, clock=time.monotonic, busy_minutes=30, timeout_minutes=120,
                 poll_seconds=30):
        self.api, self.sleep, self.clock = api, sleep, clock
        self.busy_minutes, self.timeout_minutes, self.poll_seconds = busy_minutes, timeout_minutes, poll_seconds

    def _url(self, ws, ds):
        return f"{BASE}/groups/{ws}/datasets/{ds}/refreshes"

    def start(self, url, body):
        """Returns (refresh id or request id, enhanced?). Waits while another refresh is running."""
        deadline = self.clock() + self.busy_minutes * 60
        enhanced = body is not STANDARD
        while True:
            r = self.api.post(url, scope=POWERBI, json=body, timeout=60)
            if r.status_code == 202:
                location = (r.headers.get("Location") or "").rstrip("/")
                request_id = r.headers.get("RequestId") or r.headers.get("x-ms-request-id")
                return (location.split("/")[-1] if enhanced and location else request_id), enhanced
            text = (r.text or "").lower()
            busy = r.status_code in (409, 429) or "in progress" in text
            if busy and self.clock() < deadline:
                log.info("refresh: another refresh is running (%s); trying again in a minute", r.status_code)
                self.sleep(60)
                continue
            if enhanced and r.status_code in (400, 403):
                log.info("refresh: enhanced refresh not available (%s); using a standard refresh", r.status_code)
                body, enhanced = STANDARD, False
                continue
            raise RuntimeError(f"Power BI would not start the refresh ({r.status_code}): {(r.text or '')[:1000]}")

    def _status(self, url, refresh_id, enhanced):
        if enhanced:
            r = self.api.get(f"{url}/{refresh_id}", scope=POWERBI, timeout=60)
            # The enhanced refresh details endpoint answers 202 while the refresh is still in progress.
            if r.status_code in (200, 202):
                d = r.json()
                return d.get("extendedStatus") or d.get("status"), d
        else:
            r = self.api.get(url, scope=POWERBI, params={"$top": 10}, timeout=60)
            if r.status_code == 200:
                history = r.json().get("value", [])
                match = next((h for h in history if refresh_id and h.get("requestId") == refresh_id), None)
                match = match or (history[0] if history else None)
                if match:
                    status = match.get("status")
                    return ("Running" if status == "Unknown" else status), match
                return None, {}
        if r.status_code not in (404, 429, 500, 502, 503, 504):
            raise RuntimeError(f"Reading refresh status failed ({r.status_code}): {(r.text or '')[:500]}")
        return None, {}

    def wait(self, url, refresh_id, enhanced):
        deadline = self.clock() + self.timeout_minutes * 60
        while True:
            status, detail = self._status(url, refresh_id, enhanced)
            if status in FINAL:
                if status != "Completed":
                    error = detail.get("serviceExceptionJson") or "; ".join(
                        str(m.get("message", m)) for m in detail.get("messages", []) or [])
                    raise RuntimeError(f"The refresh ended as {status}. {error}".strip())
                return detail
            if self.clock() > deadline:
                raise TimeoutError(f"The refresh was still running after {self.timeout_minutes} minutes.")
            self.sleep(self.poll_seconds)

    def refresh(self, workspace_id, dataset_id, *, all_partitions=False):
        url = self._url(workspace_id, dataset_id)
        refresh_id, enhanced = self.start(url, ENHANCED_ALL if all_partitions else ENHANCED)
        log.info("refresh: started %s (%s%s)", refresh_id, "enhanced" if enhanced else "standard",
                 ", all partitions" if enhanced and all_partitions else "")
        return self.wait(url, refresh_id, enhanced)


def refresh_models(api, settings, *, all_partitions=False, **kwargs) -> list[str]:
    models = settings.semantic_models or {}
    if not models:
        log.warning("refresh: no semantic models configured (VALUELENS_SEMANTIC_MODELS); skipped")
        return []
    r = Refresher(api, **kwargs)
    done = []
    for name, ref in models.items():
        ws = (ref or {}).get("workspaceId") or settings.powerbi_workspace_id
        ds = (ref or {}).get("itemId") or (ref or {}).get("datasetId")
        if not ws or not ds:
            raise ValueError(f"Semantic model {name!r} needs workspaceId and itemId.")
        log.info("refresh: %s", name)
        r.refresh(ws, ds, all_partitions=all_partitions)
        done.append(name)
    return done
