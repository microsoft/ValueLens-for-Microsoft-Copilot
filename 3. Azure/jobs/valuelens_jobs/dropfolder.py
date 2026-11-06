"""The drop folder the consumption collectors read: Copilot Studio exports / flow output and Viva CSVs.

Two layouts, chosen by settings:

* Storage (default, public networking): the `landing` container, `landing/studio/*.csv` and
  `landing/viva/*.csv`. The Power Automate flow's state under `landing/flows/` is ignored.
* SharePoint (private networking, `VALUELENS_DROP_SITE_ID` set): `<folder>/studio/*.csv` and
  `<folder>/viva/*.csv` in a document library, read through Microsoft Graph with the job's managed
  identity (Sites.Selected with a read grant on the site).
  - `VALUELENS_DROP_SITE_ID` is a Graph site id (`host,guid,guid`) or a path (`host:/sites/Name`);
    both resolve with `GET /sites/{value}`.
  - `VALUELENS_DROP_DRIVE_ID` set: `VALUELENS_DROP_FOLDER` is relative to that drive's root.
    Empty: the folder's first segment is the library's name (e.g. `Shared Documents/ValueLens`).

Files are never moved or deleted: the collectors re-read everything and merge idempotently.

`list`, `read_bytes` and `fetch` see only the files directly in a subfolder. `fetch_tree` also reads
one named folder inside it, two levels deep, with each file's upload time: the Copilot Studio
collector's `studio/backfill/<YYYY-MM>/`.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from .api import GRAPH, raise_for_status

log = logging.getLogger("valuelens_jobs.dropfolder")

GRAPH_V1 = "https://graph.microsoft.com/v1.0"
SUBDIRS = ("studio", "viva")


@dataclass(frozen=True)
class DropFile:
    rel: str  # the path under the subfolder, such as "a.csv" or "backfill/2026-08/a.csv"
    path: Path  # the local copy
    uploaded: float | None  # when it was uploaded (POSIX seconds), or None if the source doesn't say


@dataclass(frozen=True)
class DropTree:
    root: str  # the subfolder as its owner would name it, for messages
    files: tuple = ()  # DropFile, by rel
    folders: tuple = ()  # the paths of the named folder, the folders in it and the folders in those


def _safe_name(name: str) -> str:
    name = Path(str(name).replace("\\", "/")).name
    if not name or name in (".", ".."):
        raise ValueError(f"Unsafe drop folder file name: {name!r}")
    return name


def _posix(stamp) -> float | None:
    """POSIX seconds for an ISO 8601 time such as Graph's `2026-09-05T10:00:00Z`; None if there isn't one."""
    if not stamp:
        return None
    try:
        t = datetime.fromisoformat(str(stamp).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()


class StoreDropFolder:
    """`landing/<subdir>/` in the job's store (ADLS, or a local folder for tests)."""

    kind = "storage"

    def __init__(self, store, container: str = "landing"):
        self.store = store
        self.container = container

    def _prefix(self, subdir: str) -> str:
        return f"{self.container}/{subdir.strip('/')}"

    def list(self, subdir: str) -> list[tuple[str, str | None]]:
        prefix = self._prefix(subdir)
        out = []
        for rel in self.store.pull(prefix):
            rest = rel[len(prefix):].lstrip("/")
            if rest and "/" not in rest:  # direct children only
                p = self.store.path(rel)
                out.append((rest, str(p.stat().st_mtime) if p.is_file() else None))
        return sorted(out)

    def read_bytes(self, subdir: str, name: str) -> bytes:
        return self.store.path(f"{self._prefix(subdir)}/{_safe_name(name)}").read_bytes()

    def fetch(self, subdir: str, dest=None) -> list[Path]:
        """Local paths of the files in `subdir` (already local after `pull`; `dest` is unused)."""
        return [self.store.path(f"{self._prefix(subdir)}/{name}") for name, _ in self.list(subdir)]

    def fetch_tree(self, subdir: str, dest=None, *, nested: str) -> DropTree:
        """The files directly in `subdir`, in its folder `nested` and in the folders in that, and the folders
        found from `nested` down, one level further. Other folders aren't read. A file's upload time is its
        blob's, which `pull` stamps on the local copy (`dest` is unused). A folder shows only through the
        files in it: `pull` lists files, not folders, so an empty folder isn't seen."""
        prefix = self._prefix(subdir)
        files, folders = [], set()
        for rel in self.store.pull(prefix):
            parts = rel[len(prefix):].strip("/").split("/")
            if not parts[0] or (len(parts) > 1 and parts[0] != nested):
                continue
            folders.update("/".join(parts[:n]) for n in range(1, min(len(parts), 4)))
            p = self.store.path(rel)
            if len(parts) <= 3 and p.is_file():
                files.append(DropFile("/".join(parts), p, p.stat().st_mtime))
        return DropTree(prefix, tuple(sorted(files, key=lambda f: f.rel)), tuple(sorted(folders)))


class SharePointDropFolder:
    """`<folder>/<subdir>/` in a SharePoint document library, read via Graph."""

    kind = "sharepoint"

    def __init__(self, api, site: str, drive: str = "", folder: str = ""):
        self.api = api
        self.site_setting = (site or "").strip()
        self.drive_setting = (drive or "").strip()
        self.folder_setting = (folder or "").strip().strip("/")
        self._resolved = None
        self._items: dict[tuple[str, str], str] = {}

    def _get(self, url: str, what: str):
        return raise_for_status(self.api.request("GET", url, scope=GRAPH), what).json()

    def resolve(self) -> tuple[str, str, str]:
        """(site id, drive id, folder under the drive root), looked up once per run."""
        if self._resolved:
            return self._resolved
        if not self.site_setting:
            raise ValueError("VALUELENS_DROP_SITE_ID is empty")
        site = self._get(f"{GRAPH_V1}/sites/{quote(self.site_setting, safe=',:/')}",
                         "Resolve the drop folder site (VALUELENS_DROP_SITE_ID)")
        site_id = site.get("id") or self.site_setting
        segments = [s for s in self.folder_setting.replace("\\", "/").split("/") if s]
        if self.drive_setting:
            drive_id = self.drive_setting
        else:
            if not segments:
                raise ValueError("VALUELENS_DROP_DRIVE_ID is empty, so VALUELENS_DROP_FOLDER must start "
                                 "with the document library's name (e.g. 'Shared Documents/ValueLens')")
            library, segments = segments[0], segments[1:]
            drive_id = self._find_drive(site_id, library)
        self._resolved = (site_id, drive_id, "/".join(segments))
        log.info("drop folder: SharePoint site %s, drive %s, folder '%s'", site_id, drive_id, self._resolved[2])
        return self._resolved

    def _find_drive(self, site_id: str, library: str) -> str:
        want = library.strip().lower()
        url = f"{GRAPH_V1}/sites/{quote(site_id, safe=',')}/drives?$select=id,name,webUrl"
        names = []
        while url:
            page = self._get(url, "List the drop folder site's document libraries")
            for d in page.get("value") or []:
                names.append(d.get("name"))
                web = unquote(urlparse(d.get("webUrl") or "").path.rstrip("/").rsplit("/", 1)[-1])
                if (d.get("name") or "").strip().lower() == want or web.strip().lower() == want:
                    return d["id"]
            url = page.get("@odata.nextLink")
        raise ValueError(f"No document library named '{library}' on the drop folder site "
                         f"(found: {', '.join(n for n in names if n) or 'none'})")

    def _children_url(self, subdir: str) -> str:
        _, drive_id, folder = self.resolve()
        path = "/".join(s for s in (folder, subdir.strip("/")) if s)
        return f"{GRAPH_V1}/drives/{quote(drive_id, safe='!')}/root:/{quote(path)}:/children"

    def list(self, subdir: str) -> list[tuple[str, str | None]]:
        url = self._children_url(subdir)
        out = []
        while url:
            r = self.api.request("GET", url, scope=GRAPH)
            if r.status_code == 404:
                log.info("drop folder: no '%s' folder on SharePoint", subdir)
                return []
            page = raise_for_status(r, f"List the SharePoint drop folder '{subdir}'").json()
            for item in page.get("value") or []:
                if "folder" in item or not item.get("name"):
                    continue
                self._items[(subdir, item["name"])] = item["id"]
                out.append((item["name"], item.get("lastModifiedDateTime")))
            url = page.get("@odata.nextLink")
        return sorted(out)

    def read_bytes(self, subdir: str, name: str) -> bytes:
        item = self._items.get((subdir, name))
        if item is None:
            self.list(subdir)
            item = self._items.get((subdir, name))
        if item is None:
            raise FileNotFoundError(f"{subdir}/{name} isn't in the SharePoint drop folder")
        _, drive_id, _ = self.resolve()
        url = f"{GRAPH_V1}/drives/{quote(drive_id, safe='!')}/items/{quote(item)}/content"
        r = raise_for_status(self.api.request("GET", url, scope=GRAPH, timeout=300),
                             f"Download {subdir}/{name} from the SharePoint drop folder")
        return r.content

    def fetch(self, subdir: str, dest) -> list[Path]:
        """Downloads the files in `subdir` into `dest` and returns their local paths."""
        dest = Path(dest) / subdir.strip("/")
        dest.mkdir(parents=True, exist_ok=True)
        out = []
        for name, _ in self.list(subdir):
            p = dest / _safe_name(name)
            p.write_bytes(self.read_bytes(subdir, name))
            out.append(p)
        return out

    def _item_url(self, item: str) -> str:
        _, drive_id, _ = self.resolve()
        return f"{GRAPH_V1}/drives/{quote(drive_id, safe='!')}/items/{quote(item)}"

    def _children(self, url: str, what: str) -> list[dict] | None:
        """The named items in a folder, page by page; None if there's no such folder."""
        out = []
        while url:
            r = self.api.request("GET", url, scope=GRAPH)
            if r.status_code == 404:
                return None
            page = raise_for_status(r, f"List the SharePoint drop folder '{what}'").json()
            out += [item for item in page.get("value") or [] if item.get("name")]
            url = page.get("@odata.nextLink")
        return out

    def fetch_tree(self, subdir: str, dest, *, nested: str) -> DropTree:
        """Downloads the files directly in `subdir`, in its folder `nested` and in the folders in that into
        `dest`, keeping their paths, and returns them with the folders found from `nested` down, one level
        further. Other folders aren't read. A file's upload time is its item's `lastModifiedDateTime`, which
        SharePoint sets when the file is saved, and is stamped on the local copy."""
        subdir = subdir.strip("/")
        root = "/".join(s for s in (self.folder_setting, subdir) if s)
        top = self._children(self._children_url(subdir), subdir)
        if top is None:
            log.info("drop folder: no '%s' folder on SharePoint", subdir)
            return DropTree(root)
        dest = Path(dest) / subdir
        files, folders = [], []

        def walk(items, parents, depth):
            for item in items:
                rel = "/".join([*parents, item["name"]])
                if "folder" not in item:
                    files.append(self._download(subdir, rel, item, dest.joinpath(*map(_safe_name, rel.split("/")))))
                elif depth or item["name"] == nested:
                    folders.append(rel)
                    if depth < 2:
                        walk(self._children(self._item_url(item["id"]) + "/children", f"{subdir}/{rel}") or [],
                             [*parents, item["name"]], depth + 1)

        walk(top, [], 0)
        return DropTree(root, tuple(sorted(files, key=lambda f: f.rel)), tuple(sorted(folders)))

    def _download(self, subdir: str, rel: str, item: dict, target: Path) -> DropFile:
        r = raise_for_status(self.api.request("GET", self._item_url(item["id"]) + "/content", scope=GRAPH,
                                              timeout=300),
                             f"Download {subdir}/{rel} from the SharePoint drop folder")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(r.content)
        uploaded = _posix(item.get("lastModifiedDateTime"))
        if uploaded is not None:
            os.utime(target, (uploaded, uploaded))
        return DropFile(rel, target, uploaded)


def open_dropfolder(store, settings, api=None):
    if getattr(settings, "drop_site_id", ""):
        if api is None:
            raise ValueError("The SharePoint drop folder needs a Graph client")
        return SharePointDropFolder(api, settings.drop_site_id, settings.drop_drive_id, settings.drop_folder)
    return StoreDropFolder(store)
