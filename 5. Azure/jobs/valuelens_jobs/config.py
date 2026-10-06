"""Job settings, read from the environment contract set by `infra/modules/containerapps.bicep`."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

DEFAULT_MODULES = ("core", "orgData")


@dataclass(frozen=True)
class Settings:
    tenant_id: str = ""
    client_id: str = ""
    storage_account: str = ""
    sql_server: str = ""
    sql_database: str = ""
    version: str = ""
    powerbi_workspace_id: str = ""
    semantic_models: dict = field(default_factory=dict)
    modules: frozenset = frozenset(DEFAULT_MODULES)
    audit_history_days: int = 30
    audit_lookback_days: int = 7
    sql_reader_name: str = ""
    sql_reader_client_id: str = ""

    def has(self, module: str) -> bool:
        return module in self.modules

    @classmethod
    def from_env(cls, env=None) -> "Settings":
        env = os.environ if env is None else env
        raw_models = (env.get("VALUELENS_SEMANTIC_MODELS") or "").strip() or "{}"
        try:
            models = json.loads(raw_models)
        except json.JSONDecodeError as exc:
            raise ValueError(f"VALUELENS_SEMANTIC_MODELS is not valid JSON: {exc}") from exc
        if not isinstance(models, dict):
            raise ValueError("VALUELENS_SEMANTIC_MODELS must be a JSON object keyed by model name.")
        modules = [m.strip() for m in (env.get("VALUELENS_MODULES") or "").split(",") if m.strip()]
        return cls(
            tenant_id=env.get("VALUELENS_TENANT_ID", ""),
            client_id=env.get("AZURE_CLIENT_ID", ""),
            storage_account=env.get("VALUELENS_STORAGE_ACCOUNT", ""),
            sql_server=env.get("VALUELENS_SQL_SERVER", ""),
            sql_database=env.get("VALUELENS_SQL_DATABASE", ""),
            version=env.get("VALUELENS_VERSION", ""),
            powerbi_workspace_id=env.get("VALUELENS_POWERBI_WORKSPACE_ID", ""),
            semantic_models=models,
            modules=frozenset(modules or DEFAULT_MODULES),
            audit_history_days=_int(env, "VALUELENS_AUDIT_HISTORY_DAYS", 30),
            audit_lookback_days=_int(env, "VALUELENS_AUDIT_LOOKBACK_DAYS", 7),
            sql_reader_name=env.get("VALUELENS_SQL_READER_NAME", ""),
            sql_reader_client_id=env.get("VALUELENS_SQL_READER_CLIENT_ID", ""),
        )


def _int(env, name: str, default: int) -> int:
    value = (env.get(name) or "").strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a whole number, got {value!r}") from exc
