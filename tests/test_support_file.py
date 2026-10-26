"""The manual support file: same layout and redaction as the installer's --support-bundle."""

import importlib.util
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("support_file", ROOT / "scripts" / "support_file.py")
sf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sf)

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJ1cG4iOiJhZGFAZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJlLXZhbHVl"
CLIENT_SECRET = "abc8Q~abcdefghijklmnopqrstuvwxyz0123456"
TENANT = "11111111-2222-3333-4444-555555555555"
NOW = datetime(2026, 10, 27, 8, 5, 9, tzinfo=timezone.utc)
SECRETS = [JWT, CLIENT_SECRET, "SuperSecretSig", "QUJDREVGR0hJSktMTU5PUA==", "hunter2", "plain-client-secret-value"]
PEOPLE = ["ada.lovelace@example.com", "Ada Lovelace", "grace@example.org", "Grace Hopper"]


def _files(files):
    return {f["name"]: f["text"] for f in files}


def test_rules_match_the_installer():
    js = (ROOT / "installer" / "src" / "support.js").read_text(encoding="utf-8")
    assert f"/{sf.SECRET_KEY.pattern}/i" in js
    for name in sf.SUPPORT_FILES:
        assert f"'{name}'" in js


def test_secret_keys_removed_keyvault_and_guids_kept():
    r = sf.Redactor(salt=b"\x01" * 16)
    out = r.value({"clientSecret": "x", "accessToken": "y", "password": "z", "sasUrl": "u", "connectionString": "c", "apiKey": "k", "keyVault": {"name": "kv"}, "tenantId": TENANT})
    for k in ("clientSecret", "accessToken", "password", "sasUrl", "connectionString", "apiKey"):
        assert out[k] == sf.REMOVED
    assert out["keyVault"] == {"name": "kv"}
    assert out["tenantId"] == TENANT


def test_credential_shaped_values_removed():
    r = sf.Redactor()
    out = r.text(f"{JWT} Bearer abc.defghij sig=SuperSecretSig&x AccountKey=QUJDREVGR0hJSktMTU5PUA==; password=hunter2 {CLIENT_SECRET}")
    for s in SECRETS[:-1] + ["Bearer abc.defghij"]:
        assert s not in out
    assert r.counts["secrets"] == 6


def test_people_hashed_consistently_per_file():
    r = sf.Redactor()
    a = r.text("ada.lovelace@example.com")
    assert re.fullmatch(r"user-[0-9a-f]{10}", a)
    assert r.text(" ADA.Lovelace@Example.com") == f" {a}"
    v = r.value({"displayName": "Ada Lovelace", "app": {"displayName": "ValueLens collector"}})
    assert v["app"]["displayName"] == "ValueLens collector"
    assert r.text("by Ada Lovelace") == f"by {v['displayName']}"
    assert sf.Redactor().text("ada.lovelace@example.com") != a


def test_hash_matches_the_installer_formula():
    salt = b"\x02" * 16
    import hashlib

    want = "user-" + hashlib.sha256(salt + b"ada@example.com").hexdigest()[:10]
    assert sf.Redactor(salt=salt).token("  Ada@Example.com ") == want


def test_pax_folder_writes_the_full_zip_without_secrets_people_or_rows(tmp_path):
    root = tmp_path / "pax"
    (root / "logs").mkdir(parents=True)
    (root / "data" / "audit").mkdir(parents=True)
    (root / "data" / "licensed.csv").write_text("Upn,Licensed\nada.lovelace@example.com,true\ngrace@example.org,true\n", encoding="utf-8")
    (root / "data" / "audit" / "events.csv").write_text("Upn,Event\n", encoding="utf-8")
    (root / "state.json").write_text(json.dumps({"lastError": f"Throttled for grace@example.org {JWT}"}), encoding="utf-8")
    (root / "logs" / "refresh.log").write_text(
        "==> Window 1 of 2\nWARN HTTP 429 Too Many Requests\n==> Window 2 of 2\nERROR 401 Unauthorized for Grace Hopper\nThe operation timed out\n403 Forbidden\n",
        encoding="utf-8",
    )
    config = tmp_path / "settings.json"
    config.write_text(
        json.dumps({"tenantId": TENANT, "adminEmail": "ada.lovelace@example.com", "owner": "Grace Hopper", "signedInUser": "Ada Lovelace", "clientSecret": "plain-client-secret-value", "notes": f"password=hunter2 {CLIENT_SECRET} sig=SuperSecretSig AccountKey=QUJDREVGR0hJSktMTU5PUA=="}),
        encoding="utf-8",
    )
    files = sf.collect("pax", config=config, pax_root=root, now=NOW)
    path = sf.write_zip(files, tmp_path / "out" / sf.file_name(NOW))
    assert path.name == "valuelens-support-20261027-080509.zip"

    with zipfile.ZipFile(path) as z:
        assert z.namelist() == sf.SUPPORT_FILES
        text = "\n".join(z.read(n).decode("utf-8") for n in z.namelist())
    for s in SECRETS + PEOPLE:
        assert s.lower() not in text.lower(), s
    assert TENANT in text
    assert "true" not in _files(files)["row-counts.json"]

    f = _files(files)
    assert json.loads(f["row-counts.json"]) == {"audit/events.csv": 0, "licensed.csv": 2}
    log = json.loads(f["logs-summary.json"])["refresh.log"]
    assert (log["windows"], log["http429"], log["http401"], log["http403"], log["timeouts"]) == (2, 1, 1, 1, 1)
    assert re.fullmatch(r"ERROR 401 Unauthorized for user-[0-9a-f]{10}", log["firstError"])
    m = json.loads(f["manifest.json"])
    assert m["product"] == "valuelens" and m["route"] == "pax" and m["createdAt"] == "2026-10-27T08:05:09Z"
    assert [x["name"] for x in m["files"]] == [n for n in sf.SUPPORT_FILES if n != "manifest.json"]
    assert all(m["redaction"]["counts"][k] > 0 for k in ("secrets", "emails", "names"))
    assert json.loads(f["settings.json"])["clientSecret"] == sf.REMOVED


def test_nothing_given_still_writes_every_file(tmp_path):
    files = sf.collect("csv", now=NOW)
    assert [x["name"] for x in files] == sf.SUPPORT_FILES
    for name in sf.SUPPORT_FILES[2:]:
        assert "notCollected" in json.loads(_files(files)[name])


def test_fabric_cell_counts_tables_with_count_only(tmp_path):
    class T:
        def __init__(self, name):
            self.name = name
            self.isTemporary = False

    class DF:
        def __init__(self, n):
            self.n = n

        def count(self):
            return self.n

        def collect(self):  # pragma: no cover - a row read would fail the test
            raise AssertionError("rows were read")

    class Catalog:
        def listTables(self):
            return [T("licensed"), T("audit"), T("broken")]

    class Spark:
        catalog = Catalog()

        def table(self, name):
            if name == "broken":
                raise RuntimeError("Table not found\nstack")
            return DF({"licensed": 12, "audit": 0}[name])

    counts = sf.spark_table_counts(Spark())
    assert counts == {"licensed": 12, "audit": 0, "broken": {"notCollected": "Table not found"}}


def test_cli_writes_to_out(tmp_path, capsys):
    data = tmp_path / "data"
    data.mkdir()
    (data / "a.csv").write_text("h\n1\n", encoding="utf-8")
    assert sf.main(["--data", str(data), "--out", str(tmp_path)]) == 0
    zips = list(tmp_path.glob("valuelens-support-*.zip"))
    assert len(zips) == 1 and re.fullmatch(r"valuelens-support-\d{8}-\d{6}\.zip", zips[0].name)
    assert "email it to us" in capsys.readouterr().out


def test_bad_route_rejected():
    with pytest.raises(ValueError):
        sf.collect("dataverse")


def test_parity_vector_with_analytics_hub():
    assert sf.Redactor(salt=bytes(16)).token("  Ada.Lovelace@Contoso.com ") == "user-1a37274c6a"


def test_secret_keys_keep_ids_dates_numbers_and_booleans():
    r = sf.Redactor()
    out = r.value({"secretExpiry": "2027-01-31T00:00:00Z", "clientSecretId": TENANT, "tokenLifetime": 3600, "keyRotated": True, "sasUrl": "https://x/y?sv=1", "secret": {"value": "s3cret", "id": TENANT}})
    assert out == {"secretExpiry": "2027-01-31T00:00:00Z", "clientSecretId": TENANT, "tokenLifetime": 3600, "keyRotated": True, "sasUrl": sf.REMOVED, "secret": {"value": sf.REMOVED, "id": TENANT}}


def test_resource_paths_kept_long_base64_removed():
    r = sf.Redactor()
    path = "/subscriptions/" + TENANT + "/resourceGroups/rg-valuelens-collector-production-westeurope/providers/Microsoft.Web/sites/collector"
    blob = "Ab1" * 30
    assert r.text(path) == path
    assert r.text(f"key {blob}") == f"key {sf.REMOVED}"


def test_guest_upn_hashed():
    r = sf.Redactor()
    assert re.fullmatch(r"user-[0-9a-f]{10}", r.text("ada_example.com#EXT#@tenant.onmicrosoft.com"))


def test_manifest_matches_analytics_hub_and_run_log_fills_last_run(tmp_path):
    rec = tmp_path / "valuelens-setup.json"
    rec.write_text(json.dumps({"tenantId": TENANT, "signedInAs": "ada.lovelace@example.com"}), encoding="utf-8")
    runs = [{"command": "install", "startedAt": f"2026-10-2{i}T08:00:00Z", "ok": i == 3, "failedStep": None if i == 3 else 2, "error": None if i == 3 else "HTTP 401 for ada.lovelace@example.com", "steps": []} for i in (1, 2, 3)]
    (tmp_path / "valuelens-setup.log.json").write_text(json.dumps({"runs": runs, "prereqs": {"at": "2026-10-23T08:00:00Z", "items": [{"name": "Fabric admin", "ok": False}]}}), encoding="utf-8")
    log = tmp_path / "collector.log"
    log.write_text("HTTP 429\nERROR timed out\n", encoding="utf-8")
    files = _files(sf.collect("fabric", config=rec, log_files=[log, tmp_path / "missing.log"], now=NOW))
    m = json.loads(files["manifest.json"])
    assert list(m) == ["product", "installerVersion", "madeBy", "createdAt", "route", "signedIn", "files", "redaction"]
    assert m["madeBy"] == f"support_file.py {sf.TOOL_VERSION}" and m["signedIn"] is False
    last = json.loads(files["last-run.json"])
    assert last["startedAt"] == "2026-10-23T08:00:00Z" and [x["startedAt"] for x in last["earlierRuns"]] == ["2026-10-22T08:00:00Z", "2026-10-21T08:00:00Z"]
    assert "ada.lovelace" not in files["last-run.json"]
    assert json.loads(files["prereqs.json"])["live"] is False
    logs = json.loads(files["logs-summary.json"])
    assert logs["collector.log"]["http429"] == 1 and "notCollected" in logs["missing.log"]