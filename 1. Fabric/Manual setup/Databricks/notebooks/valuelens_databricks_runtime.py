"""Shared Databricks helpers for the ValueLens notebook route."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone


_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_VOLUME_PREFIX = "/Volumes/"


def _identifier(value: str, label: str) -> str:
    value = str(value or "").strip()
    if not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"{label} must contain only letters, numbers, and underscores.")
    return value


def _quote_identifier(value: str) -> str:
    return f"`{value.replace('`', '``')}`"


class VolumeFileSystem:
    """Translate route-relative Files paths to a configured Unity Catalog volume."""

    def __init__(self, dbutils, root: str):
        self._dbutils = dbutils
        self.root = root.rstrip("/")

    def path(self, path) -> str:
        value = str(path or "").strip().replace("\\", "/")
        if value.startswith("dbfs:/Volumes/"):
            return value[len("dbfs:") :]
        if value.startswith(_VOLUME_PREFIX):
            return value
        if value.startswith("/lakehouse/default/"):
            value = value[len("/lakehouse/default/") :]
        if value == "Files":
            return self.root
        if value.startswith("Files/"):
            return f"{self.root}/{value[len('Files/') :]}"
        if value.startswith("abfss://"):
            raise ValueError("Databricks file inputs must use the configured Unity Catalog volume.")
        return value

    def exists(self, path) -> bool:
        try:
            self._dbutils.fs.ls(self.path(path))
            return True
        except Exception as exc:
            detail = str(exc)
            if "FileNotFoundException" in detail or "PATH_NOT_FOUND" in detail:
                return False
            raise

    def ls(self, path):
        return self._dbutils.fs.ls(self.path(path))

    def mkdirs(self, path):
        return self._dbutils.fs.mkdirs(self.path(path))

    def rm(self, path, recurse=False):
        return self._dbutils.fs.rm(self.path(path), recurse)

    def mv(self, source, destination, recurse=False):
        return self._dbutils.fs.mv(self.path(source), self.path(destination), recurse)

    def cp(self, source, destination, recurse=False):
        return self._dbutils.fs.cp(self.path(source), self.path(destination), recurse)

    def head(self, path, max_bytes=65536):
        return self._dbutils.fs.head(self.path(path), max_bytes)

    def put(self, path, contents, overwrite=False):
        return self._dbutils.fs.put(self.path(path), contents, overwrite)


class ValueLensDatabricksRuntime:
    def __init__(self, spark, dbutils):
        self.spark = spark
        self.dbutils = dbutils
        self.started_at = datetime.now(timezone.utc)
        self.catalog = _identifier(self.widget("catalog", "main"), "catalog")
        self.schema = _identifier(self.widget("schema", "dbo"), "schema")
        self.volume = _identifier(self.widget("volume", "valuelens"), "volume")
        self.volume_root = f"{_VOLUME_PREFIX}{self.catalog}/{self.schema}/{self.volume}"
        self.fs = VolumeFileSystem(dbutils, self.volume_root)

        spark.sql(f"USE CATALOG {_quote_identifier(self.catalog)}")
        spark.sql(f"USE SCHEMA {_quote_identifier(self.schema)}")

    def widget(self, name: str, default: str) -> str:
        widgets = self.dbutils.widgets
        if name not in widgets.getAll():
            widgets.text(name, default)
        return widgets.get(name)

    def path(self, path) -> str:
        return self.fs.path(path)

    def secret(self) -> str:
        scope = self.widget("secret_scope", "").strip()
        key = self.widget("client_secret_key", "client-secret").strip()
        if not scope or not key:
            raise ValueError("Set the Databricks secret_scope and client_secret_key parameters.")
        return self.dbutils.secrets.get(scope=scope, key=key)

    def powerbi_headers(self, tenant_id: str, client_id: str, client_secret: str) -> dict:
        import requests

        if not tenant_id or not client_id or not client_secret:
            raise ValueError("Set tenant_id, client_id, and a Databricks secret for the Power BI refresh.")
        if not re.fullmatch(r"[A-Za-z0-9.-]+", tenant_id):
            raise ValueError("tenant_id must be a tenant ID or domain name.")
        response = requests.post(
            f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "scope": "https://analysis.windows.net/powerbi/api/.default",
                "grant_type": "client_credentials",
            },
            timeout=60,
        )
        response.raise_for_status()
        token = response.json().get("access_token")
        if not token:
            raise RuntimeError("The token response did not contain an access_token.")
        return {"Authorization": f"Bearer {token}"}

    def record_task_success(self, detail=None) -> None:
        if not self.widget("job_run_id", "").strip():
            return
        ended_at = datetime.now(timezone.utc)
        value = {
            "status": "Succeeded",
            "started_at": self.started_at.isoformat(),
            "ended_at": ended_at.isoformat(),
            "duration_seconds": round((ended_at - self.started_at).total_seconds(), 1),
            "attempts": self._attempt_count(),
            "detail": detail,
        }
        task_key = self.widget("task_key", "").strip()
        if not task_key:
            raise ValueError("Set the Databricks task_key parameter for workflow status tracking.")
        self.dbutils.jobs.taskValues.set(
            key="valuelens_status",
            value=json.dumps(value, separators=(",", ":")),
        )

    def record_task_start(self) -> None:
        if not self.widget("job_run_id", "").strip():
            return
        task_key = self.widget("task_key", "").strip()
        if not task_key:
            raise ValueError("Set the Databricks task_key parameter for workflow status tracking.")
        value = {
            "status": "Running",
            "started_at": self.started_at.isoformat(),
            "attempts": self._attempt_count(),
        }
        self.dbutils.jobs.taskValues.set(
            key="valuelens_status",
            value=json.dumps(value, separators=(",", ":")),
        )

    def _attempt_count(self) -> int:
        value = self.widget("task_execution_count", "1").strip() or "1"
        if not value.isdigit() or int(value) < 1:
            raise ValueError("task_execution_count must be a positive integer.")
        return int(value)

    def task_status(self, task_key: str):
        value = self.dbutils.jobs.taskValues.get(
            taskKey=task_key,
            key="valuelens_status",
            default=None,
        )
        if not value:
            return None
        return json.loads(value)


def initialize(spark, dbutils) -> ValueLensDatabricksRuntime:
    """Configure the current catalog/schema and return the shared route helpers."""
    return ValueLensDatabricksRuntime(spark, dbutils)


def normalize_task_status(state, task_value, required=False) -> str:
    """Map a Databricks Workflow result and task value to the load-log status."""
    state = str(state or "").strip().upper()
    task_value = task_value or {}
    if state in ("SUCCESS", "SUCCEEDED"):
        return "Succeeded"
    if state in ("FAILED", "TIMEDOUT", "TIMED_OUT"):
        return "Failed"
    if state in ("CANCELED", "CANCELLED"):
        return "Cancelled"
    if state in ("SKIPPED", "EXCLUDED"):
        return "Skipped"
    if state:
        return "Failed"
    if task_value.get("status") == "Succeeded":
        return "Succeeded"
    if task_value.get("status") == "Running":
        return "Failed"
    return "Failed" if required else "Skipped"


def workflow_task_runs(labels, result_states, task_values, required_tasks, aliases=None):
    """Build the load-log activity map from Workflow results and published task values."""
    aliases = aliases or {}
    runs = {}
    for task_key in labels:
        if task_key == "Record_Load_Status":
            continue
        value_key = aliases.get(task_key, task_key)
        task_value = task_values.get(value_key) or {}
        status = normalize_task_status(
            result_states.get(task_key),
            task_value,
            required=task_key in required_tasks,
        )
        message = task_value.get("detail")
        if status == "Failed" and not message:
            message = (
                "The Databricks workflow task failed or did not publish a success value; "
                "inspect the workflow run for its error details."
            )
        duration_seconds = task_value.get("duration_seconds")
        runs[task_key] = {
            "activityName": task_key,
            "activityType": "Notebook",
            "status": status,
            "error": {"message": message} if message else None,
            "activityRunStart": task_value.get("started_at"),
            "activityRunEnd": task_value.get("ended_at"),
            "durationInMs": (
                int(float(duration_seconds) * 1000)
                if duration_seconds is not None
                else None
            ),
            "attempts": int(task_value.get("attempts") or 1),
        }
    return runs
