"""The three active routes stay simple without breaking shared and archived assets."""
import hashlib
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ("1. SharePoint", "2. Fabric", "3. Azure")
GUIDES = (
    "README.md",
    *(f"{route}/README.md" for route in ROUTES),
    "archive/5. Local CSV/README.md",
    "archive/5. Local CSV/Add Credit Consumption/README.md",
    "shared/scripts/README.md",
    "shared/sample-data/README.md",
    "shared/sample-data/consumption/README.md",
    "docs/CUSTOMISE.md",
    "docs/SECURITY-PRIVACY-SETUP.md",
)


def test_root_route_order_and_brevity():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    choices = re.findall(r"^\| \*\*\[([1-9]\. [A-Za-z]+)", readme, re.MULTILINE)
    assert tuple(choices) == ROUTES
    assert len(readme.splitlines()) <= 90
    assert "5. Local CSV" not in readme
    assert "3. Power Automate" not in readme
    assert len((ROOT / "2. Fabric" / "README.md").read_text(encoding="utf-8").splitlines()) <= 100


def test_route_and_shared_guide_links_resolve():
    for guide in GUIDES:
        path = ROOT / guide
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\]\(([^)\s]+)\)", text):
            if target.startswith(("https:", "http:", "mailto:", "#")):
                continue
            destination = (path.parent / unquote(target.split("#")[0])).resolve()
            assert destination.exists(), (guide, target)


def test_shared_runtime_assets_are_outside_archived_routes():
    for name in (
        "copilot_interactions_sample.csv",
        "copilot_users_sample.csv",
        "agents_365_sample.csv",
        "product_feedback_sample.csv",
        "Build-SampleData.py",
        "consumption/AzureAiSpendDaily.csv",
    ):
        assert (ROOT / "shared" / "sample-data" / name).is_file()
    for name in (
        "Purview_CopilotInteraction_Processor_v4.0.0.py",
        "Adapt-OrgFile-To-EntraUsers.py",
        "OrgData-Template.csv",
        "pull_azure_ai.py",
    ):
        assert (ROOT / "shared" / "scripts" / name).is_file()
    for source in (
        "app/scripts/prepare-sample.mjs",
        "installer/packaging/payload.js",
        "3. Azure/jobs/Dockerfile",
        "2. Fabric/Manual setup/Add Credit Consumption/seed_sample_data.py",
        "archive/3. Power Automate + Dataverse/scripts/Build-DataverseCoreFeeds.py",
    ):
        text = (ROOT / source).read_text(encoding="utf-8")
        assert "5. Local CSV" not in text, source
        assert "shared" in text, source


def test_retired_routes_live_only_in_archive():
    ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    for route in ("3. Power Automate + Dataverse", "5. Local CSV"):
        assert not (ROOT / route).exists()
        assert (ROOT / "archive" / route / "README.md").is_file()
    for old in ("1. Fabric", "2. Azure", "3. Power Automate + Dataverse", "4. SharePoint", "5. Local CSV"):
        assert f"/{old}/" in ignored, old


def test_retired_templates_keep_original_binary_content():
    # The archive move must not rebuild models or reports as a side effect.
    for name, digest in (
        ("ValueLens - Local CSV.pbit", "acb141f8da07511ac503cbc33e68e8bc63f4c62931a92399e14b4fcd5fa459a2"),
        ("Add Credit Consumption/Consumption Central - Local CSV.pbit", "5024b297e4103eb9ad53c71058d9251834cbf9e756ba812fe0e3e4cffcf4398f"),
    ):
        content = (ROOT / "archive" / "5. Local CSV" / name).read_bytes()
        assert hashlib.sha256(content).hexdigest() == digest
