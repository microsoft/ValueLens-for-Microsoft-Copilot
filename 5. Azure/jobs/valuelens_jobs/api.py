"""Graph / Power BI / SQL tokens and a retrying HTTP client for the jobs' managed identity."""
from __future__ import annotations

import logging
import time

log = logging.getLogger("valuelens_jobs.http")

GRAPH = "https://graph.microsoft.com/.default"
POWERBI = "https://analysis.windows.net/powerbi/api/.default"
SQL = "https://database.windows.net/.default"
TRANSIENT = {429, 500, 502, 503, 504}


class TokenSource:
    """Caches one token per scope and refreshes five minutes before expiry."""

    def __init__(self, credential=None, clock=time.time):
        if credential is None:
            from azure.identity import DefaultAzureCredential

            credential = DefaultAzureCredential()
        self._credential = credential
        self._clock = clock
        self._cache: dict[str, tuple[str, float]] = {}

    def get(self, scope: str, force: bool = False) -> str:
        cached = self._cache.get(scope)
        if cached and not force and cached[1] - 300 > self._clock():
            return cached[0]
        token = self._credential.get_token(scope)
        self._cache[scope] = (token.token, float(token.expires_on))
        return token.token


def retry_after(response, attempt: int) -> float:
    try:
        return max(1.0, min(120.0, float(response.headers.get("Retry-After", ""))))
    except (TypeError, ValueError):
        return float(min(60, 2 ** attempt))


class Api:
    """`request` retries throttling and transient errors, and refreshes the token once on 401.

    Other statuses are returned to the caller, which knows what a 400/403/404 means for it.
    """

    def __init__(self, tokens, session=None, sleep=time.sleep, attempts: int = 6):
        if session is None:
            import requests

            session = requests.Session()
        self.tokens = tokens
        self.session = session
        self.sleep = sleep
        self.attempts = attempts

    def request(self, method: str, url: str, *, scope: str = GRAPH, headers=None, timeout=120, **kwargs):
        refreshed = False
        attempt = 0
        while True:
            attempt += 1
            h = {"Authorization": f"Bearer {self.tokens.get(scope, force=refreshed)}", **(headers or {})}
            try:
                r = self.session.request(method, url, headers=h, timeout=timeout, **kwargs)
            except Exception as exc:  # connection reset, DNS, read timeout
                if attempt >= self.attempts or not _is_network_error(exc):
                    raise
                wait = float(min(60, 2 ** attempt))
                log.warning("%s %s failed (%s); retrying in %.0fs", method, _short(url), type(exc).__name__, wait)
                self.sleep(wait)
                continue
            if r.status_code == 401 and not refreshed:
                refreshed = True
                attempt -= 1
                continue
            if r.status_code in TRANSIENT and attempt < self.attempts:
                wait = retry_after(r, attempt)
                log.warning("%s %s returned %s; retrying in %.0fs", method, _short(url), r.status_code, wait)
                self.sleep(wait)
                continue
            return r

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)


def _is_network_error(exc) -> bool:
    try:
        import requests

        if isinstance(exc, requests.RequestException):
            return True
    except ImportError:
        pass
    return isinstance(exc, (ConnectionError, TimeoutError))


def _short(url: str) -> str:
    return url.split("?")[0][-80:]


def raise_for_status(r, what: str):
    if 200 <= r.status_code < 300:
        return r
    body = (getattr(r, "text", "") or "")[:500]
    raise RuntimeError(f"{what}: HTTP {r.status_code} {body}".strip())
