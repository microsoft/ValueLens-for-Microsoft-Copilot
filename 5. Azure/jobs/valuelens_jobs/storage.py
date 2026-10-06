"""Data stores. Every path is relative and POSIX-style, e.g. `raw/copilot_org_data/part-0.parquet`.

The first segment is the ADLS container (raw, curated, landing). Jobs work on a local copy
(`store.root`): `pull` brings a prefix down, `push` sends written files back up. `LocalStore`
is the same layout on disk, for `--data-dir` runs and tests, where pull and push do nothing.
"""
from __future__ import annotations

import json
import logging
import shutil
import tempfile
from pathlib import Path

log = logging.getLogger("valuelens_jobs.storage")


class LocalStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, rel: str) -> Path:
        return self.root / rel

    def pull(self, prefix: str) -> list[str]:
        return self.list(prefix)

    def push(self, rels) -> None:
        pass

    def list(self, prefix: str) -> list[str]:
        base = self.root / prefix
        if base.is_file():
            return [prefix]
        if not base.is_dir():
            return []
        return sorted(p.relative_to(self.root).as_posix() for p in base.rglob("*") if p.is_file())

    def remove(self, rels) -> None:
        for rel in rels:
            p = self.root / rel
            if p.is_file():
                p.unlink()

    def read_json(self, rel: str, default=None):
        self.pull(rel)
        p = self.path(rel)
        if not p.is_file():
            return default
        return json.loads(p.read_text(encoding="utf-8"))

    def write_json(self, rel: str, data) -> None:
        p = self.path(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True, default=str), encoding="utf-8")
        tmp.replace(p)
        self.push([rel])


class AdlsStore(LocalStore):
    """Blob-endpoint access with the job's managed identity (shared-key access is disabled)."""

    def __init__(self, account: str, credential=None, root=None, service=None):
        super().__init__(root or tempfile.mkdtemp(prefix="valuelens-"))
        if service is None:
            from azure.identity import DefaultAzureCredential
            from azure.storage.blob import BlobServiceClient

            service = BlobServiceClient(f"https://{account}.blob.core.windows.net",
                                        credential=credential or DefaultAzureCredential())
        self._service = service

    @staticmethod
    def _split(rel: str):
        container, _, name = rel.strip("/").partition("/")
        return container, name

    def _container(self, name):
        return self._service.get_container_client(name)

    def list(self, prefix: str) -> list[str]:
        container, name = self._split(prefix)
        names = self._container(container).list_blobs(name_starts_with=name)
        return sorted(f"{container}/{b.name}" for b in names
                      if b.name == name or not name or b.name.startswith(name.rstrip("/") + "/"))

    def pull(self, prefix: str) -> list[str]:
        rels = self.list(prefix)
        local = self.root / prefix
        if local.is_dir():
            shutil.rmtree(local)
        for rel in rels:
            container, name = self._split(rel)
            target = self.path(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as fh:
                self._container(container).download_blob(name).readinto(fh)
        log.info("pulled %s file(s) under %s", len(rels), prefix)
        return rels

    def push(self, rels) -> None:
        for rel in rels:
            container, name = self._split(rel)
            with open(self.path(rel), "rb") as fh:
                self._container(container).upload_blob(name, fh, overwrite=True)

    def remove(self, rels) -> None:
        for rel in rels:
            container, name = self._split(rel)
            try:
                self._container(container).delete_blob(name)
            except Exception as exc:  # already gone is fine
                if "BlobNotFound" not in str(exc) and "404" not in str(exc):
                    raise
        super().remove(rels)


def open_store(data_dir, settings):
    if data_dir:
        return LocalStore(data_dir)
    if not settings.storage_account:
        raise ValueError("Set --data-dir or VALUELENS_STORAGE_ACCOUNT.")
    return AdlsStore(settings.storage_account)
