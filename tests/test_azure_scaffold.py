"""Offline checks for the `2. Azure` scaffold: SQL contract, jobs entry point, Bicep invariants."""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
AZURE = ROOT / "2. Azure"
EXPECTED = ROOT / "tests" / "fixtures" / "valuelens-golden" / "expected"
SQL_TYPES = {"string": "NVARCHAR(4000)", "timestamp": "DATETIME2(6)", "date": "DATE",
             "bigint": "BIGINT", "boolean": "BIT"}


def test_v001_matches_curated_contract():
    contract = json.loads((EXPECTED / "minimal_no_dims.json").read_text(encoding="utf-8"))["columns"]
    sql = (AZURE / "sql" / "migrations" / "V001__init.sql").read_text(encoding="utf-8")
    body = re.search(r"CREATE TABLE dbo\.copilot_interactions_curated \((.*?)\n\);", sql, re.S).group(1)
    ddl = re.findall(r"^\s*\[([^\]]+)\] (\S+) NULL", body, re.M)
    assert ddl == [(name, SQL_TYPES[kind]) for name, kind in contract]


def test_every_bicep_resource_is_tagged():
    for path in (AZURE / "infra" / "modules").glob("*.bicep"):
        text = path.read_text(encoding="utf-8")
        for block in re.split(r"\nresource ", text)[1:]:
            header = block.splitlines()[0]
            rtype = header.split("'")[1].split("@")[0]
            # Child resources and role assignments (extension resources) don't take tags.
            if " existing" in header or rtype.count("/") != 1 or rtype.startswith("Microsoft.Authorization/"):
                continue
            assert "tags: tags" in block, f"{path.name}: untagged resource {header}"
    main = (AZURE / "infra" / "main.bicep").read_text(encoding="utf-8")
    assert "'valuelens-install-id': installId" in main


def test_storage_and_sql_follow_policy_defaults():
    storage = (AZURE / "infra" / "modules" / "storage.bicep").read_text(encoding="utf-8")
    sql = (AZURE / "infra" / "modules" / "sql.bicep").read_text(encoding="utf-8")
    assert "allowSharedKeyAccess: false" in storage
    assert "isHnsEnabled: true" in storage
    assert "azureADOnlyAuthentication: true" in sql
    assert "GP_S_Gen5" in sql


def test_jobs_process_end_to_end(tmp_path):
    pytest.importorskip("duckdb")
    import duckdb

    raw = tmp_path / "raw" / "copilot_interactions_parsed"
    raw.mkdir(parents=True)
    duckdb.sql("SELECT 'x' AS Id, '2026-09-02T12:00:00Z' AS CreationDate, 'a@example.invalid' AS Audit_UserId") \
        .write_parquet(str(raw / "p.parquet"))
    env = {"PYTHONPATH": f"{ROOT / 'shared' / 'python'}{';' if sys.platform == 'win32' else ':'}{AZURE / 'jobs'}",
           "PYTHONDONTWRITEBYTECODE": "1"}
    import os
    result = subprocess.run([sys.executable, "-m", "valuelens_jobs", "process", "--data-dir", str(tmp_path)],
                            env={**os.environ, **env}, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    out = tmp_path / "curated" / "copilot_interactions_curated" / "part-0.parquet"
    assert duckdb.sql(f"SELECT count(*) FROM read_parquet('{out.as_posix()}')").fetchone()[0] == 1

    clean = {k: v for k, v in os.environ.items() if not k.startswith("VALUELENS_")}
    unconfigured = subprocess.run([sys.executable, "-m", "valuelens_jobs", "run", "--steps", "collect"],
                                  env={**clean, **env}, capture_output=True, text=True)
    assert unconfigured.returncode == 1 and "VALUELENS_STORAGE_ACCOUNT" in unconfigured.stderr


@pytest.mark.parametrize("name", ["build-package.mjs", "manifest.template.json", "color.png", "outline.png"])
def test_installer_teams_package_is_vendored_copy(name):
    vendored = ROOT / "1. Fabric" / "installer" / "src" / "azure" / "teams" / name
    assert vendored.read_bytes() == (AZURE / "teams" / name).read_bytes(), \
        f"copy 2. Azure/teams/{name} to {vendored.relative_to(ROOT)}"


@pytest.mark.skipif(not shutil.which("az") and not (Path.home() / ".azure" / "bin").exists(),
                    reason="Bicep CLI not installed")
def test_bicep_builds():
    exe = Path.home() / ".azure" / "bin" / ("bicep.exe" if sys.platform == "win32" else "bicep")
    cmd = [str(exe), "build"] if exe.exists() else ["az", "bicep", "build", "--file"]
    result = subprocess.run(cmd + [str(AZURE / "infra" / "main.bicep"), "--stdout"],
                            capture_output=True, text=True, shell=False)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["resources"]
