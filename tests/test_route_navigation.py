"""The three active routes stay simple without breaking shared and archived assets."""
import hashlib
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ("4. SharePoint", "1. Fabric", "2. Azure", "6. Other Data Lake")
ROUTE_LABELS = ("SharePoint", "Fabric", "Azure", "Other data lakes")
GUIDES = (
    "README.md",
    "SUPPORT.md",
    *(f"{route}/README.md" for route in ROUTES),
    "docs/INSTALL.md",
    "docs/PREREQUISITES.md",
    "docs/PERMISSIONS.md",
    "installer/README.md",
    "app/README.md",
    "1. Fabric/Manual setup/README.md",
    "1. Fabric/Manual setup/notebooks/README.md",
    "6. Other Data Lake/Databricks/README.md",
    "5. Local CSV/README.md",
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
    choices = re.findall(r"^\| \*\*\[([^\]]+)\]\(([^)]+)\)", readme, re.MULTILINE)
    assert tuple(label for label, _ in choices) == ROUTE_LABELS
    assert tuple(unquote(target) for _, target in choices) == tuple(
        f"{route}/README.md" for route in ROUTES
    )
    assert len(readme.splitlines()) <= 90
    assert "5. Local CSV" not in readme
    assert "3. Power Automate" not in readme
    assert len((ROOT / "1. Fabric" / "README.md").read_text(encoding="utf-8").splitlines()) <= 100


def test_setup_navigation_uses_service_names_not_folder_numbers():
    for guide in GUIDES:
        if guide.startswith(("archive/", "5. Local CSV/")):
            continue
        text = (ROOT / guide).read_text(encoding="utf-8")
        assert not re.search(r"\[(?:[124]\. (?:SharePoint|Fabric|Azure))\]", text), guide
    for route, label in zip(ROUTES, ROUTE_LABELS):
        text = (ROOT / route / "README.md").read_text(encoding="utf-8")
        assert f"# {label}\n" in text
        assert f'<a id="{route.lower().replace(". ", "-").replace(" ", "-")}"></a>' in text


def test_app_only_and_installer_choices_are_distinct():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert readme.index("**Start with the app**") < readme.index("**For a scheduled Power BI report**")
    assert "No Power BI licence or Azure subscription is needed for this browser app." in readme
    install = (ROOT / "docs" / "INSTALL.md").read_text(encoding="utf-8")
    assert "The installer sets up a report on both routes" in install
    assert "Azure is not a target of the ValueLens installer" in install
    notebooks = (ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "README.md").read_text(encoding="utf-8")
    assert "They do not run unchanged on" in notebooks
    assert "OPTIMIZE ... VORDER" in notebooks


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
        "2. Azure/jobs/Dockerfile",
        "1. Fabric/Manual setup/Add Credit Consumption/seed_sample_data.py",
        "archive/3. Power Automate + Dataverse/scripts/Build-DataverseCoreFeeds.py",
    ):
        text = (ROOT / source).read_text(encoding="utf-8")
        assert "5. Local CSV" not in text, source
        assert "shared" in text, source


def test_only_compatibility_notice_remains_in_retired_route():
    assert {path.name for path in (ROOT / "5. Local CSV").iterdir() if path.is_file()} == {"README.md"}
    for route in ("3. Power Automate + Dataverse", "5. Local CSV"):
        assert (ROOT / "archive" / route / "README.md").is_file()
        assert "archive" in (ROOT / route / "README.md").read_text(encoding="utf-8")


def test_retired_templates_keep_original_binary_content():
    # The archive move must not rebuild models or reports as a side effect.
    for name, digest in (
        ("ValueLens - Local CSV.pbit", "acb141f8da07511ac503cbc33e68e8bc63f4c62931a92399e14b4fcd5fa459a2"),
        ("Add Credit Consumption/Consumption Central - Local CSV.pbit", "5024b297e4103eb9ad53c71058d9251834cbf9e756ba812fe0e3e4cffcf4398f"),
    ):
        content = (ROOT / "archive" / "5. Local CSV" / name).read_bytes()
        assert hashlib.sha256(content).hexdigest() == digest
