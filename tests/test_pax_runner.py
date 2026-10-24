"""Behaviour tests for the PAX route's runner scripts, in installer/src/steps/pax/runner.

refresh.ps1 runs inside tests/fixtures/pax_runner/harness.ps1. It sits next to stand-ins for
credential.ps1, Run-PAX-AIBV.ps1 and Upload-Rollups-SharePoint.ps1 that keep the real scripts'
param blocks, so every call binds as it would in production. Entra ID, Microsoft Graph and the
SharePoint library are in-memory stand-ins, so nothing leaves the machine.

task.ps1 runs inside task-harness.ps1, where the ScheduledTasks cmdlets are stand-ins and
nothing is registered. task-check.ps1 then checks every recorded call, read-only, against the
real ScheduledTasks module.

credential.ps1 runs for real against a throwaway Windows Credential Manager entry, which the
test deletes.

Where PowerShell's execution policy blocks scripts, these tests skip rather than bypass it.
"""

import functools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RUNNER_DIR = REPO / "installer" / "src" / "steps" / "pax" / "runner"
REFRESH = RUNNER_DIR / "refresh.ps1"
TASK = RUNNER_DIR / "task.ps1"
CREDENTIAL = RUNNER_DIR / "credential.ps1"
SCRIPTS = REPO / "4. SharePoint" / "scripts"
WRAPPER = SCRIPTS / "Run-PAX-AIBV.ps1"
UPLOADER = SCRIPTS / "Upload-Rollups-SharePoint.ps1"
FIXTURES = REPO / "tests" / "fixtures" / "pax_runner"
HARNESS = FIXTURES / "harness.ps1"
TASK_HARNESS = FIXTURES / "task-harness.ps1"
TASK_CHECK = FIXTURES / "task-check.ps1"
AST_DUMP = FIXTURES / "ast-dump.ps1"
STUB_PAX = FIXTURES / "stub-pax.ps1"
STUB_UPLOAD = FIXTURES / "stub-upload.ps1"
STUB_CRED = FIXTURES / "stub-credential.ps1"


def _find_pwsh():
    # The runner needs PowerShell 7, which the installer checks for.
    exe = shutil.which("pwsh")
    if not exe:
        return None
    try:
        result = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
                                capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    major = result.stdout.strip()
    return exe if result.returncode == 0 and major.isdigit() and int(major) >= 7 else None


PWSH = _find_pwsh()


def _scripts_allowed():
    if not PWSH:
        return False
    result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"],
                            capture_output=True, text=True, timeout=60, check=False)
    return result.returncode == 0 and result.stdout.strip() not in ("Restricted", "AllSigned")


SCRIPTS_ALLOWED = _scripts_allowed()
WINDOWS = sys.platform == "win32"
needs_pwsh = unittest.skipUnless(
    PWSH and SCRIPTS_ALLOWED,
    "needs PowerShell 7 with an execution policy that runs local scripts (the tests don't bypass it)")
needs_windows = unittest.skipUnless(WINDOWS, "needs Windows")

PAX_TAG = "purview-v1.11.15"
PAX_SHA = "13a8d41a70c462650207e452eb0ccab274729eb65b0d640bc0a52d6a40ad46c9"
TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT = "66666666-7777-8888-9999-aaaaaaaaaaaa"
CRED_TARGET = f"PAX-TestProduct-{TENANT}"
SITE = "example.sharepoint.com,aaaaaaaa-0000-0000-0000-000000000001,bbbbbbbb-0000-0000-0000-000000000002"
DRIVE = "b!stub-drive"
PRODUCT = "Test Product"
HINT = "Run 'test-installer repair'."
INTERACTIONS = "copilot_interactions_rollup.csv"
USERS = "copilot_users_rollup.csv"
AGENTS = "agents_365.csv"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
PYTHON_MESSAGE = ("PAX needs Python 3.10 or later to build the rollup files, and this account has none. "
                  "Install it for this user with: winget install Python.Python.3.13 --scope user. "
                  "Then run the refresh again.")
GRANT_MESSAGE = "The app needs write access to the SharePoint site, through a Sites.Selected grant."
BUSY_MESSAGE = "Another refresh is running, so this one stopped. The next scheduled run starts as usual."
# A site as the installer writes it from a folder address, and its libraries as Graph lists them.
SITE_PATH = "example.sharepoint.com:/sites/Analytics"
SITE_URL = "https://example.sharepoint.com/sites/Analytics"
LOCKED_SITE = "example.sharepoint.com:/sites/Locked"
LIBRARIES = [
    {"id": "b!site-assets", "name": "Site Assets", "webUrl": f"{SITE_URL}/SiteAssets"},
    {"id": DRIVE, "name": "Documents", "webUrl": f"{SITE_URL}/Shared%20Documents"},
]
SITE_LOOKUP = "$select=id,webUrl"
DRIVES_PAGE_1 = "$select=id,name,webUrl"
DRIVES_PAGE_2 = "$select=id,name,webUrl&$skiptoken=1"


def default_config(**overrides):
    config = {
        "schema": 1,
        "product": PRODUCT,
        "tenantId": TENANT,
        "clientId": CLIENT,
        "credentialTarget": CRED_TARGET,
        "siteId": SITE,
        "driveId": DRIVE,
        "folderPath": "/Reports",
        "paxReleaseTag": PAX_TAG,
        "paxSha256": PAX_SHA,
        "files": {"interactions": INTERACTIONS, "users": USERS, "agents365": AGENTS},
        "seedDays": 30,
        "maxDays": 30,
        "minDays": 3,
        "overlapDays": 2,
        "keepRunFilesDays": 3,
        # One window, so each run makes one PAX call with -Days. The window cases set their own.
        "windowDays": 180,
        "agent365": False,
        "deidentify": False,
        "repairHint": HINT,
    }
    config.update(overrides)
    return config


def _pwsh_file(script, *args, env=None, input_text=None, timeout=300):
    run_env = {key: value for key, value in os.environ.items() if key.upper() != "AIBV_CLIENT_SECRET"}
    run_env["NO_COLOR"] = "1"
    run_env.update(env or {})
    stdin = {"input": input_text} if input_text is not None else {"stdin": subprocess.DEVNULL}
    return subprocess.run(
        [PWSH, "-NoProfile", "-NonInteractive", "-File", str(script), *map(str, args)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, check=False, env=run_env, **stdin)


@functools.lru_cache(maxsize=None)
def ast_report():
    """PowerShell's own parse of the runner scripts and the two scripts they call, keyed by file name."""
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "ast.json"
        paths = [str(path) for path in (REFRESH, TASK, CREDENTIAL, WRAPPER, UPLOADER)]
        result = _pwsh_file(AST_DUMP, env={"PAX_RUNNER_AST_INPUT": json.dumps(paths),
                                           "PAX_RUNNER_AST_OUTPUT": str(output)}, timeout=120)
        if result.returncode != 0 or not output.exists():
            raise RuntimeError(f"ast-dump.ps1 failed:\n{result.stdout}\n{result.stderr}")
        report = json.loads(output.read_text(encoding="utf-8-sig"))
    return {Path(key).name: value for key, value in report.items()}


def build_scripts_dir(root):
    """refresh.ps1, with stand-ins next to it that start with the real scripts' param blocks."""
    scripts = root / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REFRESH, scripts / "refresh.ps1")
    report = ast_report()
    for real, stub in ((CREDENTIAL, STUB_CRED), (WRAPPER, STUB_PAX), (UPLOADER, STUB_UPLOAD)):
        text = report[real.name]["paramBlock"] + "\n" + stub.read_text(encoding="utf-8-sig")
        with open(scripts / real.name, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
    return scripts


def local_midnight_utc(days_ago):
    """Local midnight days_ago days back, in UTC, as refresh.ps1 writes it to state.json."""
    midnight = datetime.combine(date.today() - timedelta(days=days_ago), time(0)).astimezone()
    return midnight.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.0000000Z")


def local_noon_epoch(days_ago):
    return int(datetime.combine(date.today() - timedelta(days=days_ago), time(12)).astimezone().timestamp())


def windows(days, count):
    """A load of days days, ending today, split as refresh.ps1 splits it: (StartDate, EndDate) per window,
    oldest first. EndDate is the day after the window's last day."""
    start = date.today() - timedelta(days=days)
    bounds = [k * days // count for k in range(count + 1)]
    return [((start + timedelta(days=bounds[k])).isoformat(), (start + timedelta(days=bounds[k + 1])).isoformat())
            for k in range(count)]


def day_before(iso_day):
    return (date.fromisoformat(iso_day) - timedelta(days=1)).isoformat()


def early(spans, first=False):
    """The (StartDate, EndDate) refresh.ps1 passes for those windows. PAX reads days in the PC's time zone but keeps
    whole UTC days, so each window after the first starts a day early, and so does the first when first is True."""
    return [(day_before(start) if k or first else start, end) for k, (start, end) in enumerate(spans)]


EARLY = ("a day early, because PAX reads days in this PC's time zone but keeps whole UTC days. PAX drops the rows it "
         "already has.")
NO_OVERLAP = ("This load reads its days without the day before, because a run that read one day with the day before "
              "didn't finish inside the task's time limit. So each day can miss the activity between midnight UTC and "
              "midnight in this PC's time zone.")


ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def flat(text):
    """Drops colour codes, the error view's '|' margins and all whitespace, so wrapped messages compare."""
    text = ANSI.sub("", text or "")
    text = re.sub(r"(?m)^\s*\|\s?", "", text)
    return re.sub(r"\s+", "", text)


def G(path, status):
    return ("GET", path, None, status)


def P(parent, name, status):
    return ("POST", parent, name, status)


class Case:
    """One harness run of refresh.ps1: its install folder, stand-in library and runs."""

    def __init__(self, root, name):
        self.name = name
        self.dir = root / "cases" / name
        self.install = self.dir / "install"
        self.data = self.install / "data"
        self.stub = self.dir / "stub"
        self.files = self.dir / "files"
        self.empty_path = self.dir / "empty-path"
        for folder in (self.install, self.stub, self.files, self.empty_path):
            folder.mkdir(parents=True, exist_ok=True)
        self.config_path = self.install / "refresh.json"
        self.spec = {
            "root": str(self.install),
            "runner": str(root / "scripts" / "refresh.ps1"),
            "caseDir": str(self.dir),
            "emptyPath": str(self.empty_path),
            "holdLock": False,
            "tokenError": False,
            "remote": {"Reports": {"folder": True}},
            "status": {},
            "runs": [],
        }
        self.result = None
        self.stdout = ""
        self.stderr = ""
        self.error = None

    # Building the case.

    def config(self, path=None, raw=None, **overrides):
        data = raw if raw is not None else default_config(**overrides)
        Path(path or self.config_path).write_text(json.dumps(data, indent=2), encoding="utf-8")
        return self

    def state(self, days_ago, synced=True, **extra):
        """A previous run's state.json. days_ago=None leaves coverage unset; extra adds keys such as progress."""
        data = {
            "schema": 1,
            "coveredThroughUtc": None if days_ago is None else local_midnight_utc(days_ago),
            "streams": {"interactions": {"synced": synced}, "users": {"synced": synced}},
            **extra,
        }
        (self.install / "state.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
        return self

    def local(self, mtime=None, users=True):
        """The cumulative files a previous run left, an hour old unless mtime says otherwise."""
        stamp = datetime.now().timestamp() - 3600 if mtime is None else mtime
        self.data.mkdir(parents=True, exist_ok=True)
        files = {"cumulative_Interactions.csv": "Message_Id_Raw\nlocal-row\n"}
        if users:
            files["cumulative_Users.csv"] = "Id\nlocal-user\n"
        for name, text in files.items():
            with open(self.data / name, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
            os.utime(self.data / name, (stamp, stamp))
        return self

    def file(self, relpath, age_days):
        target = self.install / relpath
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("x\n", encoding="utf-8")
        stamp = (datetime.now() - timedelta(days=age_days)).timestamp()
        os.utime(target, (stamp, stamp))
        return self

    def remote_file(self, path, content, days_ago, **extra):
        self.spec["remote"][path] = {"folder": False, "content": content, "modified": local_noon_epoch(days_ago), **extra}
        return self

    def run(self, python="ok", env=None, **args):
        args.setdefault("Config", self.config_path)
        self.spec["runs"].append({
            "args": {key: str(value) if isinstance(value, Path) else value for key, value in args.items()},
            "env": env or {},
            "python": python,
        })
        return self

    def write(self):
        (self.dir / "case.json").write_text(json.dumps(self.spec, indent=2), encoding="utf-8")

    def execute(self):
        env = {
            "STUB_PAX_LOG": str(self.stub / "pax.jsonl"),
            "STUB_UPLOAD_LOG": str(self.stub / "upload.jsonl"),
            "STUB_CRED_LOG": str(self.stub / "credential.jsonl"),
        }
        result_path = self.dir / "result.json"
        try:
            completed = _pwsh_file(HARNESS, "-CasePath", self.dir / "case.json", "-ResultPath", result_path,
                                   env=env, timeout=600)
        except subprocess.TimeoutExpired as exc:
            self.error = f"the harness didn't finish within {exc.timeout} seconds"
            return self
        self.stdout, self.stderr = completed.stdout, completed.stderr
        # The harness's exit code can echo the last run's, so result.json is the sign it finished.
        if not result_path.exists():
            self.error = f"the harness wrote no result (exit {completed.returncode}):\n{completed.stdout}\n{completed.stderr}"
            return self
        self.result = json.loads(result_path.read_text(encoding="utf-8-sig"))
        return self

    # Reading the results.

    def run_result(self, n):
        return self.result["runs"][n - 1]

    def exit(self, n=1):
        return self.run_result(n)["exit"]

    def state_after(self, n=1):
        path = self.dir / f"state-run{n}.json"
        return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else None

    def graph(self, n=1):
        return [(call["method"], call["path"], call["name"], call["status"])
                for call in self.run_result(n)["calls"] if call["kind"] == "graph"]

    def sites(self, n=1):
        """The run's site and library lookups: (path under sites/, query, status)."""
        return [(call["path"], call["query"], call["status"])
                for call in self.run_result(n)["calls"] if call["kind"] == "site"]

    def check_result(self, n=1):
        """-Check's JSON, which is the run's last line of output."""
        lines = [line for line in self.output(n).splitlines() if line.strip()]
        return json.loads(lines[-1]) if lines else None

    def tokens(self, n=1):
        return [call for call in self.run_result(n)["calls"] if call["kind"] == "token"]

    def downloads(self, n=1):
        return [(item["path"], item["outFile"]) for item in self.run_result(n)["downloads"]]

    def files_after(self, n=1):
        return self.run_result(n)["files"] or {}

    def log(self, kind, n=None):
        path = self.stub / f"{kind}.jsonl"
        if not path.exists():
            return []
        entries = [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
        return entries if n is None else [entry for entry in entries if entry.get("run") == str(n)]

    def output(self, n=1):
        parts = re.split(r"^=== HARNESS RUN (\d+) ===\s*$", self.stdout, flags=re.M)
        runs = {int(parts[i]): parts[i + 1] for i in range(1, len(parts) - 1, 2)}
        return runs.get(n, "")

    def remote_lines(self, path):
        item = self.result["remote"].get(path)
        return None if item is None else (item["content"] or "").splitlines()


CASES = {}


def refresh_case(name):
    def register(build):
        CASES[name] = build
        return build
    return register


REMOTE_INTERACTIONS = "Message_Id_Raw\nremote-row\n"
REMOTE_USERS = "Id\nremote-user\n"


def _remote_rollups(c, days_ago):
    c.remote_file(f"Reports/{INTERACTIONS}", REMOTE_INTERACTIONS, days_ago)
    c.remote_file(f"Reports/{USERS}", REMOTE_USERS, days_ago)
    return c


@refresh_case("seed")
def _seed(c):
    c.spec["remote"] = {}
    c.config(folderPath="/Reports/Test Product").run()


@refresh_case("restore")
def _restore(c):
    _remote_rollups(c, 5).config().run()


@refresh_case("restore-stale")
def _restore_stale(c):
    _remote_rollups(c, 5).config().run(env={"STUB_MODE": "stale"}).run()


@refresh_case("append-1day")
def _append_1day(c):
    c.config().state(1).local().run()


@refresh_case("append-10days")
def _append_10days(c):
    c.config().state(10).local().run()


@refresh_case("gap")
def _gap(c):
    c.config().state(40).local().run().run().run(Days=42)


@refresh_case("gap-long")
def _gap_long(c):
    c.config().state(200).local().run().run(Days=180)


@refresh_case("no-state")
def _no_state(c):
    c.config().local(mtime=local_noon_epoch(6)).run()


@refresh_case("lost-state")
def _lost_state(c):
    _remote_rollups(c, 2).config().local().run().run()


@refresh_case("zero-append")
def _zero_append(c):
    c.config().state(1).local().run(env={"STUB_MODE": "zero"})


@refresh_case("zero-seed")
def _zero_seed(c):
    c.config().run(env={"STUB_MODE": "zero"})


@refresh_case("zero-users-seed")
def _zero_users_seed(c):
    c.config().state(1).local(users=False).run(env={"STUB_MODE": "zero"})


@refresh_case("merge-not-updated")
def _merge_not_updated(c):
    c.config().state(1).local().run(env={"STUB_MODE": "stale"})


@refresh_case("stale-seed-file")
def _stale_seed_file(c):
    c.config()
    c.file("work/processed/Purview_Old_Interactions.csv", 1)
    c.file("work/processed/EntraUsers_Old_Users.csv", 1)
    c.run(env={"STUB_MODE": "stale"})


@refresh_case("users-stale")
def _users_stale(c):
    c.config().state(1).local().run(env={"STUB_MODE": "users-stale"})


# PAX's exit codes, in run order, and the reason refresh.ps1 gives for each.
FAIL_REASONS = {
    10: "PAX reached Microsoft Purview's audit search limit. Run a refresh with a smaller -Days, or try again later.",
    20: "Microsoft Purview throttled PAX for too long, so PAX stopped. The next scheduled run tries again.",
    30: "PAX couldn't read users from Entra ID. Check that the app still has the User.Read.All permission.",
    40: "PAX finished with gaps in the data, so it left the cumulative files unchanged. The next scheduled run tries again.",
    1: "PAX stopped on an error.",
    99: None,
}


@refresh_case("fail")
def _fail(c):
    c.config().state(1).local()
    for code in FAIL_REASONS:
        c.run(env={"STUB_MODE": "fail", "STUB_PAX_EXIT": code})


@refresh_case("busy")
def _busy(c):
    c.spec["holdLock"] = True
    c.config().run()


@refresh_case("secret-missing")
def _secret_missing(c):
    c.config().run(env={"STUB_NO_SECRET": "1"})


@refresh_case("python")
def _python(c):
    c.config().run(python="none").run(python="old").run(python="store")


@refresh_case("token-error")
def _token_error(c):
    c.spec["tokenError"] = True
    c.config().run()


@refresh_case("restore-403")
def _restore_403(c):
    c.spec["status"] = {f"GET:Reports/{INTERACTIONS}": 403}
    c.config().run()


@refresh_case("short-download")
def _short_download(c):
    c.remote_file(f"Reports/{INTERACTIONS}", REMOTE_INTERACTIONS, 5, size=999)
    c.config().run()


@refresh_case("upload-fails")
def _upload_fails(c):
    c.config().state(1).local().run(env={"STUB_UPLOAD_FAIL": USERS})


@refresh_case("agents-on")
def _agents_on(c):
    c.config(agent365=True, deidentify=True).state(1).local().run().run(env={"STUB_AGENTS": "none"})


def _site_with_libraries(c):
    c.spec["sites"] = {SITE_PATH: {"id": SITE, "webUrl": SITE_URL}}
    c.spec["drives"] = {SITE: LIBRARIES}
    return c


@refresh_case("library")
def _library(c):
    # refresh.json names the site by path and the library by its address, as the installer
    # writes them when its own sign-in can't read the site.
    _site_with_libraries(c).config(siteId=SITE_PATH, driveId=None, library="Shared Documents").state(1).local().run()
    source = c.files / "export.csv"
    source.write_text("a,b\n", encoding="utf-8")
    c.run(Upload=source, RemoteFolder="Exports")


# Each -Check run's refresh.json changes, and what the check prints.
CHECK_RUNS = [
    ({"library": "Shared Documents"}, {"ok": True, "siteId": SITE, "driveId": DRIVE, "folder": "/Reports"}),
    ({"library": "Documents", "folderPath": "/Reports/New/Sub"},
     {"ok": True, "siteId": SITE, "driveId": DRIVE, "folder": "/Reports/New/Sub"}),
    ({"library": "Archive"}, {"ok": False, "error": (
        f"{SITE_URL} has no document library called 'Archive'. Its libraries are: Site Assets (SiteAssets), "
        f"Documents (Shared Documents). {HINT}")}),
    ({"library": "Documents", "siteId": LOCKED_SITE}, {"ok": False, "status": 403, "error": (
        f"Finding the SharePoint site {LOCKED_SITE} failed with HTTP 403: Access denied. {GRANT_MESSAGE} {HINT}")}),
    ({"siteId": SITE, "driveId": DRIVE}, {"ok": True, "siteId": SITE, "driveId": DRIVE, "folder": "/Reports"}),
]


@refresh_case("check")
def _check(c):
    # The lock is held throughout: a check doesn't wait for a scheduled refresh.
    c.spec["holdLock"] = True
    _site_with_libraries(c).spec["status"] = {f"GET:sites/{LOCKED_SITE}": 403}
    for n, (changes, _) in enumerate(CHECK_RUNS, start=1):
        path = c.install / f"check-{n}.json"
        c.config(path=path, **{"siteId": SITE_PATH, "driveId": None, **changes}).run(Config=path, Check=True)
    c.run(Config=c.install / "missing.json", Check=True)


INVALID_CONFIG = {
    "schema": 2,
    "product": "",
    "tenantId": "not-a-guid",
    "clientId": 5,
    "credentialTarget": None,
    "siteId": 12,
    "driveId": "  ",
    "folderPath": "/Reports/bad:folder",
    "paxReleaseTag": "latest",
    "paxSha256": "abc",
    "files": {"interactions": "same.csv", "users": "same.csv", "agents365": "bad?.csv"},
    "seedDays": 0,
    "maxDays": 10,
    "minDays": 20,
    "overlapDays": 31,
    "keepRunFilesDays": "3",
    "windowDays": 0,
    "runHours": 30,
    "agent365": "yes",
    "deidentify": 1,
    "repairHint": HINT,
}
INVALID_CONFIG_PROBLEMS = [
    "schema is '2', and this script reads schema 1.",
    "tenantId must be a GUID.",
    "clientId must be a GUID.",
    "product is missing.",
    "credentialTarget is missing.",
    "siteId is missing.",
    "driveId and library are both missing. One of them must name the document library.",
    "paxReleaseTag must name one PAX release, not 'latest'.",
    "paxSha256 must be the pinned PAX script's SHA-256, as 64 hex characters.",
    "folderPath has a folder name that SharePoint can't use: 'bad:folder'.",
    "files.agents365 isn't a file name that SharePoint can use: 'bad?.csv'.",
    "files.interactions, files.users and files.agents365 must be three different names.",
    "seedDays must be a whole number from 1 to 180.",
    "overlapDays must be a whole number from 0 to 30.",
    "keepRunFilesDays must be a whole number from 1 to 365.",
    "windowDays must be a whole number from 1 to 180.",
    "minDays can't be more than maxDays.",
    "runHours must be a number of hours above 0 and up to 23.",
    "agent365 must be true or false.",
    "deidentify must be true or false.",
]
WRONG_SHAPE_PROBLEMS = [
    "files must be an object of file names.",
    "library must be text.",
    "folderPath must be a folder path in the library, such as /Reports.",
]


@refresh_case("invalid-config")
def _invalid_config(c):
    c.config(raw=INVALID_CONFIG).run()
    second = c.install / "refresh-2.json"
    c.config(path=second, raw=default_config(files=["a.csv"], folderPath=7, library=5)).run(Config=second)


@refresh_case("missing-config")
def _missing_config(c):
    c.run(Config=c.install / "missing.json")


@refresh_case("days-override")
def _days_override(c):
    c.config().state(1).local().run(Days=45)


ROLLUP_LINE = "Rollup: post-processor returned non-zero exit code 1. Raw CSV(s) preserved."


@refresh_case("rollup-fail")
def _rollup_fail(c):
    c.config().state(1).local().run(env={"STUB_MODE": "rollup-fail"})


@refresh_case("rollup-exit0")
def _rollup_exit0(c):
    c.config().state(1).local().run(env={"STUB_MODE": "rollup-exit0"})


# The window cases set windowDays 7, so a 30-day first run reads five windows of 6 days.
@refresh_case("windowed-seed")
def _windowed_seed(c):
    c.config(windowDays=7, agent365=True).run()


@refresh_case("window-fail-resume")
def _window_fail_resume(c):
    c.config(windowDays=7).run(env={"STUB_MODES": ",fail", "STUB_PAX_EXIT": 1}).run()


@refresh_case("window-halving")
def _window_halving(c):
    # The last run ended inside its first window without a result, as when Task Scheduler stops
    # a run at its time limit.
    progress = {"fromUtc": local_midnight_utc(12), "days": 12, "seed": True, "windowDays": 7, "throughUtc": None,
                "pending": {"from": local_midnight_utc(12), "to": local_midnight_utc(6), "days": 6, "first": True}}
    c.config(windowDays=7, seedDays=12).state(None, progress=progress).run()


@refresh_case("window-zero-first")
def _window_zero_first(c):
    c.config(windowDays=7).run(env={"STUB_MODES": "zero"})


@refresh_case("window-budget")
def _window_budget(c):
    # A limit of a few hundredths of a second stops the first run after one window. The second
    # run's config, in the same folder, shares its state and files and has the default limit.
    full = c.install / "refresh-full.json"
    c.config(windowDays=7, runHours=1e-05).config(path=full, windowDays=7).run().run(Config=full)


@refresh_case("window-resume-small")
def _window_resume_small(c):
    # A load that has reached 5 days ago in one-day windows. The limit stops this run after one.
    progress = {"fromUtc": local_midnight_utc(10), "days": 10, "seed": True, "windowDays": 1,
                "throughUtc": local_midnight_utc(5), "pending": None}
    c.config(windowDays=7, runHours=1e-05).state(5, progress=progress).local().run()


@refresh_case("window-no-overlap")
def _window_no_overlap(c):
    # The last run was stopped inside a one-day window that read the day before too. The limit
    # stops the first run after one window, and the second run has the default limit.
    progress = {"fromUtc": local_midnight_utc(10), "days": 10, "seed": True, "windowDays": 1,
                "throughUtc": local_midnight_utc(5),
                "pending": {"from": local_midnight_utc(5), "to": local_midnight_utc(4), "days": 1, "first": True,
                            "early": True}}
    full = c.install / "refresh-full.json"
    c.config(windowDays=7, runHours=1e-05).config(path=full, windowDays=7)
    c.state(5, progress=progress).local().run().run(Config=full)


@refresh_case("window-join-daily")
def _window_join_daily(c):
    # With no days of overlap, a daily run starts at the day the cumulative files stop.
    c.config(overlapDays=0, minDays=1).state(1).local().run()


@refresh_case("window-join-180")
def _window_join_180(c):
    c.config().state(180).local().run(Days=180)


# Files left by earlier runs: their age in days, and whether the refresh keeps them.
PRUNE_FILES = {
    "data/old.log": (40, False),
    "data/recent.log": (10, True),
    "data/set-aside-20250101-000000-x.csv": (40, False),
    "data/set-aside-20250102-000000-y.csv": (20, True),
    "data/extra.csv": (5, False),
    "data/fresh-extra.csv": (1, True),
    "data/sub/old.csv": (40, True),
    "data/current_Agents365.csv": (100, True),
    "work/processed/old-run.csv": (5, False),
    "work/processed/new-run.csv": (1, True),
    "work/pax/PAX.ps1": (100, True),
    "logs/refresh-20250101-000000.log": (31, False),
    "logs/refresh-20250102-000000.log": (29, True),
}


@refresh_case("prune")
def _prune(c):
    c.config().state(1).local()
    for path, (age, _) in PRUNE_FILES.items():
        c.file(path, age)
    c.run()


@refresh_case("upload")
def _upload(c):
    # The lock is held throughout: -Upload doesn't wait for a scheduled refresh.
    c.spec["holdLock"] = True
    c.config()
    source = c.files / "export.csv"
    with open(source, "w", encoding="utf-8", newline="") as handle:
        handle.write("a,b\n1,2\n")
    c.run(Upload=source, RemoteFolder="Exports/2026")
    c.run(Upload=source, RemoteName="COPILOT_INTERACTIONS_ROLLUP.CSV")
    c.run(Upload=source, RemoteName=USERS, RemoteFolder="Archive")
    c.run(Upload=source, RemoteName="bad:name.csv")
    c.run(Upload=source, RemoteFolder=" bad")
    c.run(Upload=c.files / "missing.csv")
    c.run(Upload=source, RemoteName="renamed.csv")


@refresh_case("upload-folder-is-file")
def _upload_folder_is_file(c):
    c.spec["status"] = {"POST:Reports/New": 403}
    c.remote_file("Reports/Exports", "not a folder", 1)
    c.config()
    source = c.files / "export.csv"
    source.write_text("a,b\n", encoding="utf-8")
    c.run(Upload=source, RemoteFolder="Exports").run(Upload=source, RemoteFolder="New")


@needs_pwsh
@needs_windows
class RefreshTests(unittest.TestCase):
    """refresh.ps1 against the stand-in library: one harness process per case, run in parallel."""

    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="vl pax runner ")).resolve()
        if not os.environ.get("PAX_RUNNER_KEEP"):
            cls.addClassCleanup(shutil.rmtree, cls.root, ignore_errors=True)
        build_scripts_dir(cls.root)
        started = date.today()
        cls.cases = {}
        for name, build in CASES.items():
            case = Case(cls.root, name)
            build(case)
            case.write()
            cls.cases[name] = case
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(Case.execute, cls.cases.values()))
        cls.same_day = date.today() == started

    def case(self, name):
        """The case's results, after the checks every case shares."""
        if not self.same_day:
            self.skipTest("the date changed while the cases ran, so the expected windows moved")
        case = self.cases[name]
        self.assertIsNone(case.error, case.error)
        for run in case.result["runs"]:
            n = run["run"]
            self.assertIsNone(run["harnessError"], f"run {n}:\n{case.output(n)}\n{case.stderr}")
            self.assertTrue(run["secretCleared"], f"run {n} left AIBV_CLIENT_SECRET in the environment")
            for call in run["calls"]:
                if call["kind"] == "token":
                    self.assertEqual(
                        (call["method"], call["tenant"], call["clientId"], call["secretOk"], call["scope"], call["grantType"]),
                        ("POST", TENANT, CLIENT, True, GRAPH_SCOPE, "client_credentials"))
                    continue
                self.assertTrue(call["authOk"], call)
                if call["kind"] == "site":
                    self.assertEqual(call["method"], "GET", call)
                    continue
                self.assertEqual(call["drive"], DRIVE, call)
                if call["method"] == "POST":
                    self.assertEqual((call["conflict"], call["folderFacet"]), ("fail", True), call)
        for entry in case.log("pax"):
            self.assertTrue(entry["secretOk"], entry)
        for entry in case.log("upload"):
            self.assertEqual((entry["secretOk"], entry["tenantId"], entry["clientId"], entry["siteId"], entry["driveId"]),
                             (True, TENANT, CLIENT, SITE, DRIVE))
        for entry in case.log("credential"):
            self.assertEqual((entry["action"], entry["target"]), ("Read", CRED_TARGET))
        for path in case.dir.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"stub-secret", path.read_bytes(), f"{path} holds the client secret")
        self.assertNotIn("stub-secret", case.stdout + case.stderr)
        return case

    def assertState(self, case, n, **expected):
        state = case.state_after(n)
        self.assertIsNotNone(state, f"run {n} left no state.json:\n{case.output(n)}")
        self.assertEqual({key: state.get(key) for key in expected}, expected, case.output(n))
        return state

    @staticmethod
    def days(case, n):
        runs = case.log("pax", n)
        return runs[0]["params"]["Days"] if len(runs) == 1 else runs

    @staticmethod
    def uploads(case, n):
        return [(entry["file"], entry["remoteName"], entry["folderPath"]) for entry in case.log("upload", n)]

    @staticmethod
    def remote_names(case, n):
        return [entry["remoteName"] for entry in case.log("upload", n)]

    @staticmethod
    def spans(case, n):
        return [(entry["params"].get("StartDate"), entry["params"].get("EndDate")) for entry in case.log("pax", n)]

    @staticmethod
    def progress(from_days_ago, days, through_days_ago, window_days=7, no_overlap=False):
        return {"fromUtc": local_midnight_utc(from_days_ago), "days": days, "seed": True, "windowDays": window_days,
                "noOverlap": no_overlap, "throughUtc": local_midnight_utc(through_days_ago), "pending": None}

    def assertRolledUp(self, case, interactions, users, folder="Reports"):
        self.assertEqual(case.remote_lines(f"{folder}/{INTERACTIONS}"), interactions)
        self.assertEqual(case.remote_lines(f"{folder}/{USERS}"), users)

    def test_a_first_run_seeds_creates_the_folder_and_uploads_both_files(self):
        c = self.case("seed")
        folder = "Reports/Test Product"
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(c.graph(1), [
            G(f"{folder}/{INTERACTIONS}", 404), G(f"{folder}/{USERS}", 404),
            G(folder, 404), P("", "Reports", 201), P("Reports", "Test Product", 201),
            G(f"{folder}/{INTERACTIONS}", 404), G(f"{folder}/{USERS}", 404)])
        self.assertEqual(len(c.tokens(1)), 2)
        pax = c.log("pax", 1)
        self.assertEqual(len(pax), 1)
        self.assertEqual(pax[0]["params"], {
            "TenantId": TENANT, "ClientId": CLIENT, "Days": "30", "WorkRoot": str(c.install / "work"),
            "PaxReleaseTag": PAX_TAG, "PaxSha256": PAX_SHA, "SkipVersionCheck": "True"})
        self.assertEqual(self.uploads(c, 1), [
            (str(c.data / "cumulative_Interactions.csv"), INTERACTIONS, "/Reports/Test Product"),
            (str(c.data / "cumulative_Users.csv"), USERS, "/Reports/Test Product")])
        state = self.assertState(c, 1, lastResult="success", lastMessage="SharePoint's files are up to date.",
                                 days=30, coveredThroughUtc=local_midnight_utc(0))
        logs = [path for path in c.files_after(1) if path.startswith("logs/")]
        self.assertEqual(len(logs), 1, logs)
        self.assertEqual(c.install / logs[0], Path(state["lastLog"]))
        self.assertIn("Stub PAX", Path(state["lastLog"]).read_text(encoding="utf-8-sig", errors="replace"))
        self.assertRolledUp(c, ["Message_Id_Raw", "row-from-run-1"], ["Id", "row-from-run-1"], folder)

    def test_a_new_machine_restores_the_library_copies_and_appends_to_them(self):
        c = self.case("restore")
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(c.graph(1), [G(f"Reports/{INTERACTIONS}", 200), G(f"Reports/{USERS}", 200), G("Reports", 200)])
        self.assertEqual(c.downloads(1), [
            (f"Reports/{INTERACTIONS}", str(c.data / "cumulative_Interactions.csv.download")),
            (f"Reports/{USERS}", str(c.data / "cumulative_Users.csv.download"))])
        params = c.log("pax", 1)[0]["params"]
        self.assertEqual((params["Days"], params["AppendFile"], params["AppendUserInfo"]),
                         ("7", str(c.data / "cumulative_Interactions.csv"), str(c.data / "cumulative_Users.csv")))
        self.assertRolledUp(c, ["Message_Id_Raw", "remote-row", "row-from-run-1"], ["Id", "remote-user", "row-from-run-1"])

    def test_a_restored_file_that_pax_didnt_update_waits_for_the_next_run(self):
        c = self.case("restore-stale")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertEqual(c.graph(1), [G(f"Reports/{INTERACTIONS}", 200), G(f"Reports/{USERS}", 200)])
        self.assertEqual(len(c.downloads(1)), 2)
        self.assertEqual(len(c.tokens(1)), 1)
        self.assertEqual(c.log("upload", 1), [])
        self.assertState(c, 1, lastResult="failed", coveredThroughUtc=None, lastError=(
            "PAX didn't update cumulative_Interactions.csv, so it still holds the earlier data. "
            f"PAX's log in {c.data} says why."))
        self.assertIn("data/cumulative_Interactions.csv", c.files_after(1))
        self.assertIn("data/cumulative_Users.csv", c.files_after(1))
        # The next run keeps the restored files, with the library's dates, and appends to them.
        self.assertEqual(c.exit(2), 0, c.output(2))
        self.assertEqual(self.days(c, 2), "7")
        self.assertEqual(c.graph(2), [G("Reports", 200)])
        self.assertEqual(len(c.log("upload", 2)), 2)
        self.assertRolledUp(c, ["Message_Id_Raw", "remote-row", "row-from-run-2"], ["Id", "remote-user", "row-from-run-2"])

    def test_a_daily_run_looks_back_from_the_last_covered_day(self):
        for name, days in (("append-1day", "3"), ("append-10days", "12")):
            with self.subTest(name):
                c = self.case(name)
                self.assertEqual(c.exit(1), 0, c.output(1))
                self.assertEqual(self.days(c, 1), days)
                self.assertEqual(c.graph(1), [G("Reports", 200)])
                self.assertEqual(len(c.tokens(1)), 2)
                self.assertEqual(self.uploads(c, 1), [
                    (str(c.data / "cumulative_Interactions.csv"), INTERACTIONS, "/Reports"),
                    (str(c.data / "cumulative_Users.csv"), USERS, "/Reports")])
                self.assertState(c, 1, lastResult="success", days=int(days), coveredThroughUtc=local_midnight_utc(0))
                self.assertRolledUp(c, ["Message_Id_Raw", "local-row", "row-from-run-1"],
                                    ["Id", "local-user", "row-from-run-1"])

    def test_a_long_pause_records_the_gap_until_a_run_covers_it(self):
        c = self.case("gap")
        warning = (f"The cumulative files are missing activity from {(date.today() - timedelta(days=40)).isoformat()}, "
                   "because the refresh didn't run for longer than it looks back. "
                   "Run a refresh once with -Days 42 to fill the gap.")
        self.assertEqual([self.days(c, n) for n in (1, 2, 3)], ["30", "3", "42"])
        for n in (1, 2):
            with self.subTest(run=n):
                self.assertEqual(c.exit(n), 0, c.output(n))
                self.assertState(c, n, lastResult="success", gapFromUtc=local_midnight_utc(40), gapDays=42,
                                 gapWarning=warning)
        self.assertEqual(c.exit(3), 0, c.output(3))
        self.assertState(c, 3, lastResult="success", gapFromUtc=None, gapDays=None, gapWarning=None)

    def test_a_gap_older_than_purviews_retention_says_so(self):
        c = self.case("gap-long")
        warning = (f"The cumulative files are missing activity from {(date.today() - timedelta(days=200)).isoformat()}, "
                   "because the refresh didn't run for longer than it looks back. "
                   "Run a refresh once with -Days 180 to fill the gap. Microsoft Purview keeps audit records for "
                   "180 days on most licences, so the oldest part of the gap may not come back.")
        self.assertEqual(self.days(c, 1), "30")
        self.assertState(c, 1, gapFromUtc=local_midnight_utc(200), gapDays=180, gapWarning=warning)
        self.assertEqual(self.days(c, 2), "180")
        self.assertState(c, 2, lastResult="success", gapFromUtc=None, gapDays=None, gapWarning=None)

    def test_without_state_the_local_files_date_sets_the_window(self):
        c = self.case("no-state")
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(self.days(c, 1), "8")
        self.assertEqual(c.graph(1), [G("Reports", 200), G(f"Reports/{INTERACTIONS}", 404), G(f"Reports/{USERS}", 404)])
        self.assertEqual(len(c.log("upload", 1)), 2)

    def test_a_library_copy_this_machine_didnt_upload_is_never_overwritten(self):
        c = self.case("lost-state")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertEqual(self.days(c, 1), "3")
        self.assertEqual(c.log("upload", 1), [])
        files = list(c.files_after(1))
        for name in (INTERACTIONS, USERS):
            pattern = re.compile(r"data/set-aside-\d{8}-\d{6}-" + re.escape(name) + "$")
            self.assertTrue([path for path in files if pattern.match(path)], files)
        self.assertEqual([path for path in files if path.startswith("data/cumulative_")], [])
        self.assertIn(f"SharePoint already has a {INTERACTIONS} that this machine didn't upload, "
                      "so this run didn't overwrite it.", c.state_after(1)["lastError"])
        # The next run starts again from the library's copies.
        self.assertEqual(c.exit(2), 0, c.output(2))
        self.assertEqual(len(c.downloads(2)), 2)
        self.assertEqual(self.days(c, 2), "4")
        self.assertEqual(len(c.log("upload", 2)), 2)
        self.assertRolledUp(c, ["Message_Id_Raw", "remote-row", "row-from-run-2"], ["Id", "remote-user", "row-from-run-2"])


    def test_a_run_with_no_new_activity_still_publishes(self):
        c = self.case("zero-append")
        self.assertEqual(c.exit(1), 0, c.output(1))
        state = self.assertState(c, 1, lastResult="success",
                                 lastMessage="PAX found no new Copilot activity, and SharePoint's files are up to date.")
        self.assertTrue(state["streams"]["interactions"]["noNewRows"])
        self.assertTrue(state["streams"]["users"]["noNewRows"])
        self.assertEqual(self.remote_names(c, 1), [INTERACTIONS, USERS])

    def test_a_first_run_with_no_activity_waits_for_the_next(self):
        c = self.case("zero-seed")
        self.assertEqual(c.exit(1), 3, c.output(1))
        self.assertState(c, 1, lastResult="no-data", coveredThroughUtc=None, lastMessage=(
            "PAX found no Copilot activity in the last 30 days, so there's nothing to upload yet. "
            "The next scheduled run tries again."))
        self.assertEqual(c.log("upload", 1), [])
        self.assertEqual(len(c.tokens(1)), 1)

    def test_a_users_file_that_pax_couldnt_create_doesnt_hold_back_the_interactions(self):
        c = self.case("zero-users-seed")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertState(c, 1, lastError=(
            "PAX creates cumulative_Users.csv only on a run that finds Copilot activity, and this run found none. "
            "The next scheduled run tries again."))
        self.assertEqual(self.remote_names(c, 1), [INTERACTIONS])
        self.assertEqual(c.graph(1), [G(f"Reports/{USERS}", 404), G("Reports", 200)])

    def test_a_merge_that_pax_didnt_write_uploads_nothing(self):
        c = self.case("merge-not-updated")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertState(c, 1, lastResult="failed", coveredThroughUtc=local_midnight_utc(1), lastError=(
            f"PAX didn't update cumulative_Interactions.csv, so it still holds the earlier data. PAX's log in {c.data} says why."))
        self.assertEqual(c.log("upload", 1), [])
        self.assertEqual(len(c.tokens(1)), 1)

    def test_an_old_run_file_never_passes_for_a_new_seed(self):
        c = self.case("stale-seed-file")
        self.assertEqual(c.exit(1), 1, c.output(1))
        state = c.state_after(1)
        self.assertEqual(state["lastError"], f"PAX didn't create cumulative_Interactions.csv. The log is {state['lastLog']}.")
        self.assertEqual(c.log("upload", 1), [])

    def test_a_users_file_that_pax_didnt_update_isnt_uploaded(self):
        c = self.case("users-stale")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertState(c, 1, coveredThroughUtc=local_midnight_utc(0), lastError=(
            f"PAX didn't update cumulative_Users.csv, so it still holds the earlier data. PAX's log in {c.data} says why."))
        self.assertEqual(self.remote_names(c, 1), [INTERACTIONS])

    def test_a_failed_pax_run_names_the_reason_and_uploads_nothing(self):
        c = self.case("fail")
        for n, (code, reason) in enumerate(FAIL_REASONS.items(), start=1):
            with self.subTest(pax_exit=code):
                self.assertEqual(c.exit(n), 1, c.output(n))
                state = c.state_after(n)
                because = f"{reason} " if reason else ""
                self.assertEqual(state["lastError"],
                                 f"The PAX run failed (exit code 1). {because}PAX failed. The log is {state['lastLog']}.")
                self.assertEqual(state["coveredThroughUtc"], local_midnight_utc(1))
                self.assertEqual(c.log("upload", n), [])
                self.assertEqual(len(c.tokens(n)), 1)

    def test_a_second_refresh_stops_while_one_is_running(self):
        c = self.case("busy")
        self.assertEqual(c.exit(1), 2, c.output(1))
        self.assertIn(BUSY_MESSAGE, c.output(1))
        self.assertEqual(set(c.files_after(1)), {"refresh.json", "refresh.lock"})
        self.assertEqual(c.log("credential"), [])
        self.assertEqual(c.tokens(1), [])

    def test_a_missing_secret_stops_before_signing_in(self):
        c = self.case("secret-missing")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertState(c, 1, lastResult="failed", lastError=(
            f"Couldn't read the app's client secret. Windows Credential Manager has no credential named {CRED_TARGET} "
            f"for {c.result['userName']}. {HINT}"))
        self.assertEqual(c.tokens(1), [])
        self.assertEqual(c.log("pax"), [])

    def test_python_3_10_or_later_is_needed_before_pax_runs(self):
        c = self.case("python")
        for n, mode in enumerate(("none", "old", "store"), start=1):
            with self.subTest(python=mode):
                self.assertEqual(c.exit(n), 1, c.output(n))
                self.assertState(c, n, lastResult="failed", lastError=PYTHON_MESSAGE)
                self.assertEqual(c.tokens(n), [])
                self.assertEqual(len(c.log("credential", n)), 1)
        self.assertEqual(c.log("pax"), [])

    def test_a_rejected_secret_gives_entras_reason_without_its_trace(self):
        c = self.case("token-error")
        self.assertEqual(c.exit(1), 1, c.output(1))
        state = self.assertState(c, 1, lastError=(
            f"Couldn't sign in to Microsoft Graph as the app {CLIENT}: AADSTS7000215: Invalid client secret provided. "
            f"Ensure the secret being sent in the request is the client secret value, not the client secret ID. {HINT}"))
        self.assertNotIn("Trace ID", state["lastError"])
        self.assertEqual(c.log("pax"), [])

    def test_a_denied_library_points_at_the_sites_selected_grant(self):
        c = self.case("restore-403")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertState(c, 1, lastError=(
            f"Checking SharePoint for {INTERACTIONS} failed with HTTP 403: Access denied. {GRANT_MESSAGE} {HINT}"))
        self.assertEqual(c.log("pax"), [])

    def test_a_short_download_is_never_used(self):
        c = self.case("short-download")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertState(c, 1, lastError=(
            f"Downloading {INTERACTIONS} from SharePoint failed: the download stopped at 26 of 999 bytes."))
        self.assertEqual([path for path in c.files_after(1) if path.endswith(".download")], [])
        self.assertEqual(c.log("pax"), [])

    def test_a_failed_upload_names_the_file(self):
        c = self.case("upload-fails")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertState(c, 1, lastResult="failed", lastError=(
            f"Uploading {USERS} to SharePoint failed: HTTP 507 Insufficient Storage: the library is full."))
        self.assertEqual(set(c.result["remote"]), {"Reports", f"Reports/{INTERACTIONS}"})
        self.assertEqual(self.remote_names(c, 1), [INTERACTIONS, USERS])

    def test_agent_365_and_deidentify_pass_through_and_a_missed_registry_keeps_the_last_copy(self):
        c = self.case("agents-on")
        self.assertEqual(c.exit(1), 0, c.output(1))
        params = c.log("pax", 1)[0]["params"]
        self.assertEqual((params.get("IncludeAgent365Info"), params.get("Deidentify")), ("True", "True"))
        self.assertEqual(sorted(self.remote_names(c, 1)), sorted([INTERACTIONS, USERS, AGENTS]))
        self.assertEqual(c.exit(2), 0, c.output(2))
        self.assertEqual(sorted(self.remote_names(c, 2)), sorted([INTERACTIONS, USERS]))
        self.assertState(c, 2, lastResult="success", lastMessage=(
            "SharePoint's files are up to date. The Agent 365 registry didn't refresh this run, "
            "so SharePoint keeps its last copy."))
        self.assertEqual(c.remote_lines(f"Reports/{AGENTS}"), ["AgentId", "row-from-run-1"])

    def test_an_invalid_config_lists_every_problem_and_stops_early(self):
        c = self.case("invalid-config")
        for n, path, problems in ((1, c.config_path, INVALID_CONFIG_PROBLEMS),
                                  (2, c.install / "refresh-2.json", WRONG_SHAPE_PROBLEMS)):
            with self.subTest(run=n):
                message = f"{path} has problems:\n  - " + "\n  - ".join(problems) + "\n" + HINT
                self.assertEqual(c.exit(n), 1, c.output(n))
                self.assertEqual(c.state_after(n)["lastError"].replace("\r\n", "\n"), message)
                self.assertIn("ERROR: " + message, c.output(n).replace("\r\n", "\n"))
                self.assertEqual(c.tokens(n), [])
        self.assertEqual(c.log("credential"), [])
        self.assertEqual(c.log("pax"), [])

    def test_a_missing_config_points_at_repair(self):
        c = self.case("missing-config")
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertIn(f"ERROR: There's no refresh config at {c.install / 'missing.json'}. Run the installer's repair command.",
                      c.output(1))
        self.assertEqual(c.files_after(1), {})

    def test_days_overrides_the_window(self):
        c = self.case("days-override")
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(self.days(c, 1), "45")
        self.assertState(c, 1, days=45)

    def test_a_failed_rollup_step_that_the_wrapper_caught_is_named_once(self):
        c = self.case("rollup-fail")
        self.assertEqual(c.exit(1), 1, c.output(1))
        state = self.assertState(c, 1, lastResult="failed", coveredThroughUtc=local_midnight_utc(1), progress=None)
        pax_log = c.install / "work" / "processed" / "PAX_Stub.log"
        # The error view can wrap the wrapper's message, so the text is compared without spaces.
        self.assertEqual(flat(state["lastError"]), flat(
            f"The PAX run failed (exit code 1). PAX's rollup step failed, though PAX exited 0: {ROLLUP_LINE} "
            f"PAX's log: {pax_log} The log is {state['lastLog']}."))
        self.assertEqual(c.log("upload", 1), [])
        self.assertEqual(len(c.tokens(1)), 1)

    def test_a_failed_rollup_step_fails_the_run_even_when_pax_exits_0(self):
        c = self.case("rollup-exit0")
        self.assertEqual(c.exit(1), 1, c.output(1))
        state = self.assertState(c, 1, lastResult="failed", coveredThroughUtc=local_midnight_utc(1), progress=None)
        self.assertEqual(state["lastError"],
                         f"PAX's rollup step failed, though PAX exited 0: {ROLLUP_LINE} The log is {state['lastLog']}.")
        self.assertEqual(c.log("upload", 1), [])
        self.assertEqual(len(c.tokens(1)), 1)

    def test_a_long_load_reads_its_days_in_windows_oldest_first(self):
        c = self.case("windowed-seed")
        nominal = windows(30, 5)
        # Each window after the first starts a day early, so no hours fall between two windows.
        expected = early(nominal)
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(self.spans(c, 1), expected)
        pax = c.log("pax", 1)
        self.assertEqual([("Days" in run["params"], "AppendFile" in run["params"], "AppendUserInfo" in run["params"])
                          for run in pax], [(False, False, False)] + [(False, True, True)] * 4)
        # The Agent 365 registry is a snapshot, so only the first window reads it.
        self.assertEqual(["IncludeAgent365Info" in run["params"] for run in pax], [True, False, False, False, False])
        output = c.output(1)
        self.assertIn(f"PAX looks back 30 days, from {nominal[0][0]}.", output)
        self.assertIn("It reads them in 5 windows of up to 6 days, oldest first.", output)
        self.assertIn(f"Each window after the first starts {EARLY}", output)
        self.assertIn(f"==> Window 2 of 5: {nominal[1][0]} to {day_before(nominal[1][1])}", output)
        self.assertEqual(len(c.tokens(1)), 2)
        rows = [f"row-from-run-1-{start}" for start, _ in expected]
        self.assertRolledUp(c, ["Message_Id_Raw", *rows], ["Id", *rows])
        self.assertEqual(c.remote_lines(f"Reports/{AGENTS}"), ["AgentId", rows[0]])
        self.assertState(c, 1, lastResult="success", lastMessage="SharePoint's files are up to date.", days=30,
                         coveredThroughUtc=local_midnight_utc(0), progress=None)

    def test_a_failed_window_keeps_the_ones_before_it_and_the_next_run_carries_on(self):
        c = self.case("window-fail-resume")
        first = windows(30, 5)
        self.assertEqual(c.exit(1), 1, c.output(1))
        self.assertEqual(self.spans(c, 1), early(first[:2]))
        self.assertEqual(c.log("upload", 1), [])
        state = self.assertState(c, 1, lastResult="failed", coveredThroughUtc=local_midnight_utc(24),
                                 progress=self.progress(30, 30, 24))
        self.assertEqual(state["lastError"],
                         f"The PAX run failed (exit code 1). PAX stopped on an error. PAX failed. The log is {state['lastLog']}.")
        # The next run carries on at the day the last window it read stopped. Its first window
        # starts there, so it starts a day early too.
        second = early(windows(24, 4), first=True)
        self.assertEqual(c.exit(2), 0, c.output(2))
        self.assertEqual(self.spans(c, 2), second)
        self.assertIn(f"The last run stopped part way through a load, so this run carries on from {first[0][1]}.",
                      c.output(2))
        self.assertIn("It reads them in 4 windows of up to 6 days, oldest first.", c.output(2))
        self.assertIn(f"Each window starts {EARLY}", c.output(2))
        self.assertState(c, 2, lastResult="success", days=24, coveredThroughUtc=local_midnight_utc(0), progress=None)
        rows = [f"row-from-run-1-{first[0][0]}"] + [f"row-from-run-2-{start}" for start, _ in second]
        self.assertRolledUp(c, ["Message_Id_Raw", *rows], ["Id", *rows])

    def test_a_run_stopped_inside_its_first_window_halves_the_next_runs_windows(self):
        c = self.case("window-halving")
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertIn("The last run never finished its first window, of 6 days, so this run reads windows of up to "
                      "3 days.", c.output(1))
        self.assertEqual(self.spans(c, 1), early(windows(12, 4)))
        self.assertState(c, 1, lastResult="success", days=12, coveredThroughUtc=local_midnight_utc(0), progress=None)

    def test_a_first_window_with_no_activity_leaves_the_files_to_a_later_window(self):
        c = self.case("window-zero-first")
        nominal = windows(30, 5)
        expected = early(nominal)
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(self.spans(c, 1), expected)
        self.assertIn(f"PAX found no Copilot activity from {nominal[0][0]} to {day_before(nominal[0][1])}, "
                      "so a later window starts the files.", c.output(1))
        self.assertEqual(["AppendFile" in run["params"] for run in c.log("pax", 1)], [False, False, True, True, True])
        rows = [f"row-from-run-1-{start}" for start, _ in expected[1:]]
        self.assertRolledUp(c, ["Message_Id_Raw", *rows], ["Id", *rows])
        self.assertState(c, 1, lastResult="success", coveredThroughUtc=local_midnight_utc(0), progress=None)

    def test_a_run_near_its_time_limit_publishes_what_it_has_and_the_next_carries_on(self):
        c = self.case("window-budget")
        first = windows(30, 5)
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(self.spans(c, 1), first[:1])
        self.assertIn("The run stops here.", c.output(1))
        self.assertState(c, 1, lastResult="success", coveredThroughUtc=local_midnight_utc(24),
                         progress=self.progress(30, 30, 24), lastMessage=(
                             f"This run loaded activity up to {day_before(first[0][1])}, then stopped to stay inside "
                             "the task's time limit. SharePoint has everything loaded so far, and the next scheduled "
                             "run carries on from there."))
        self.assertEqual(self.remote_names(c, 1), [INTERACTIONS, USERS])
        second = early(windows(24, 4), first=True)
        self.assertEqual(c.exit(2), 0, c.output(2))
        self.assertEqual(self.spans(c, 2), second)
        self.assertState(c, 2, lastResult="success", lastMessage="SharePoint's files are up to date.", days=24,
                         coveredThroughUtc=local_midnight_utc(0), progress=None)
        rows = [f"row-from-run-1-{first[0][0]}"] + [f"row-from-run-2-{start}" for start, _ in second]
        self.assertRolledUp(c, ["Message_Id_Raw", *rows], ["Id", *rows])

    def test_a_resumed_load_moves_on_with_every_window_however_small(self):
        c = self.case("window-resume-small")
        self.assertEqual(c.exit(1), 0, c.output(1))
        # Starting with the usual overlap would read only days the load already has. Its windows
        # start a day early instead.
        self.assertEqual(self.spans(c, 1), early(windows(5, 5)[:1], first=True))
        self.assertIn(f"Each window starts {EARLY}", c.output(1))
        self.assertIn("The run stops here.", c.output(1))
        self.assertState(c, 1, lastResult="success", days=5, coveredThroughUtc=local_midnight_utc(4),
                         progress=self.progress(10, 10, 4, window_days=1))

    def test_a_one_day_window_stopped_with_the_day_before_reads_on_without_it_and_warns(self):
        c = self.case("window-no-overlap")
        first = windows(5, 5)
        self.assertEqual(c.exit(1), 0, c.output(1))
        # A one-day window can't be halved, so the load gives up the day before instead.
        self.assertIn("The last run never finished its first window, of one day read with the day before, so this run "
                      "reads its days without the day before.", c.output(1))
        self.assertEqual(self.spans(c, 1), first[:1])
        self.assertNotIn("a day early", c.output(1))
        self.assertIn(NO_OVERLAP, c.output(1))
        self.assertState(c, 1, lastResult="success", coveredThroughUtc=local_midnight_utc(4),
                         progress=self.progress(10, 10, 4, window_days=1, no_overlap=True), lastMessage=(
                             f"This run loaded activity up to {day_before(first[0][1])}, then stopped to stay inside "
                             "the task's time limit. SharePoint has everything loaded so far, and the next scheduled "
                             f"run carries on from there. {NO_OVERLAP}"))
        # The rest of the load reads without the day before too, and the run that finishes it says so.
        self.assertEqual(c.exit(2), 0, c.output(2))
        self.assertEqual(self.spans(c, 2), windows(4, 4))
        self.assertNotIn("a day early", c.output(2))
        self.assertState(c, 2, lastResult="success", days=4, coveredThroughUtc=local_midnight_utc(0), progress=None,
                         lastMessage=f"SharePoint's files are up to date. {NO_OVERLAP}")

    def test_a_daily_run_that_starts_where_the_files_stop_starts_a_day_early(self):
        c = self.case("window-join-daily")
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(self.spans(c, 1), early(windows(1, 1), first=True))
        self.assertNotIn("Days", c.log("pax", 1)[0]["params"])
        self.assertIn(f"It starts {EARLY}", c.output(1))
        self.assertState(c, 1, lastResult="success", days=1, coveredThroughUtc=local_midnight_utc(0), progress=None)

    def test_a_load_of_180_days_never_reaches_back_a_day_further(self):
        c = self.case("window-join-180")
        self.assertEqual(c.exit(1), 0, c.output(1))
        self.assertEqual(self.days(c, 1), "180")
        self.assertNotIn("a day early", c.output(1))
        self.assertState(c, 1, lastResult="success", days=180, coveredThroughUtc=local_midnight_utc(0))

    def test_old_run_files_and_logs_are_pruned(self):
        c = self.case("prune")
        self.assertEqual(c.exit(1), 0, c.output(1))
        files = c.files_after(1)
        for path, (age, kept) in PRUNE_FILES.items():
            with self.subTest(path=path, age=age):
                self.assertEqual(path in files, kept)

    def test_upload_puts_one_file_in_the_library(self):
        c = self.case("upload")
        self.assertEqual([c.exit(n) for n in range(1, 8)], [0, 1, 0, 1, 1, 1, 0], c.stdout)
        self.assertEqual(c.graph(1), [G("Reports/Exports/2026", 404), P("", "Reports", 409),
                                      P("Reports", "Exports", 201), P("Reports/Exports", "2026", 201)])
        self.assertIn("Uploaded export.csv to /Reports/Exports/2026 in the SharePoint library.", c.output(1))
        self.assertIn("ERROR: The scheduled refresh keeps COPILOT_INTERACTIONS_ROLLUP.CSV in this folder, so -Upload "
                      "won't replace it. Use -RemoteFolder for a subfolder, or -RemoteName for another name.", c.output(2))
        self.assertEqual(c.graph(3), [G("Reports/Archive", 404), P("", "Reports", 409), P("Reports", "Archive", 201)])
        self.assertIn("ERROR: SharePoint can't use 'bad:name.csv' as a file name.", c.output(4))
        self.assertIn("ERROR: SharePoint can't use ' bad' as a folder name.", c.output(5))
        self.assertIn(f"ERROR: There's no file at {c.files / 'missing.csv'}.", c.output(6))
        self.assertEqual(c.graph(7), [G("Reports", 200)])
        self.assertIn("Uploaded renamed.csv to /Reports in the SharePoint library.", c.output(7))
        for n in range(1, 8):
            with self.subTest(run=n):
                signed_in = 1 if n in (1, 3, 7) else 0
                self.assertEqual(len(c.tokens(n)), signed_in)
                self.assertEqual(len(c.log("credential", n)), signed_in)
                # -Upload keeps no state and no log.
                self.assertEqual(set(c.files_after(n)), {"refresh.json", "refresh.lock"})
        self.assertEqual([(entry["remoteName"], entry["folderPath"]) for entry in c.log("upload")], [
            ("export.csv", "/Reports/Exports/2026"), (USERS, "/Reports/Archive"), ("renamed.csv", "/Reports")])
        for path in ("Reports/Exports/2026/export.csv", f"Reports/Archive/{USERS}", "Reports/renamed.csv"):
            self.assertEqual(c.remote_lines(path), ["a,b", "1,2"], path)

    def test_upload_stops_on_a_file_where_a_folder_belongs_or_a_denied_folder(self):
        c = self.case("upload-folder-is-file")
        self.assertEqual((c.exit(1), c.exit(2)), (1, 1), c.stdout)
        self.assertIn("ERROR: SharePoint has a file named Reports/Exports where the folder should be.", c.output(1))
        self.assertEqual(c.graph(2), [G("Reports/New", 404), P("", "Reports", 409), P("Reports", "New", 403)])
        self.assertIn(f"ERROR: Creating the SharePoint folder Reports/New failed with HTTP 403: Access denied. "
                      f"{GRANT_MESSAGE} {HINT}", c.output(2))
        self.assertEqual(c.log("upload"), [])

    def test_a_library_and_a_site_path_resolve_with_the_apps_own_access(self):
        c = self.case("library")
        self.assertEqual((c.exit(1), c.exit(2)), (0, 0), c.stdout)
        self.assertIn(f"SharePoint site {SITE_PATH}, library Shared Documents, folder /Reports", c.output(1))
        for n in (1, 2):
            with self.subTest(run=n):
                self.assertEqual(c.sites(n), [(SITE_PATH, SITE_LOOKUP, 200), (f"{SITE}/drives", DRIVES_PAGE_1, 200),
                                              (f"{SITE}/drives", DRIVES_PAGE_2, 200)])
                self.assertIn(f"Library: Documents on {SITE_URL}", c.output(n))
        self.assertState(c, 1, lastResult="success")
        # The shared checks hold every upload to Graph's site ID and the library's drive ID.
        self.assertEqual(self.remote_names(c, 1), [INTERACTIONS, USERS])
        self.assertEqual(self.uploads(c, 2), [(str(c.files / "export.csv"), "export.csv", "/Reports/Exports")])

    def test_check_finds_the_library_makes_the_folder_and_prints_one_line_of_json(self):
        c = self.case("check")
        for n, (_, expected) in enumerate(CHECK_RUNS, start=1):
            with self.subTest(run=n):
                self.assertEqual(c.check_result(n), expected, c.output(n))
                self.assertEqual(c.exit(n), 0 if expected["ok"] else 1, c.output(n))
                self.assertEqual((len(c.tokens(n)), len(c.log("credential", n))), (1, 1))
        lookups = [(SITE_PATH, SITE_LOOKUP, 200), (f"{SITE}/drives", DRIVES_PAGE_1, 200),
                   (f"{SITE}/drives", DRIVES_PAGE_2, 200)]
        self.assertEqual([c.sites(n) for n in (1, 2, 3)], [lookups] * 3)
        self.assertEqual(c.graph(1), [G("Reports", 200)])
        self.assertEqual(c.graph(2), [G("Reports/New/Sub", 404), P("", "Reports", 409), P("Reports", "New", 201),
                                      P("Reports/New", "Sub", 201)])
        self.assertEqual((c.sites(4), c.graph(3), c.graph(4)), ([(LOCKED_SITE, SITE_LOOKUP, 403)], [], []))
        # A drive ID needs no lookup.
        self.assertEqual((c.sites(5), c.graph(5)), ([], [G("Reports", 200)]))
        missing = len(CHECK_RUNS) + 1
        self.assertEqual(c.exit(missing), 1, c.output(missing))
        self.assertEqual(c.check_result(missing), {"ok": False, "error": (
            f"There's no refresh config at {c.install / 'missing.json'}. Run the installer's repair command.")})
        self.assertEqual((c.tokens(missing), c.log("credential", missing)), ([], []))
        for n in range(1, missing + 1):
            with self.subTest(run=n):
                # A check keeps no state or log, and leaves no run files.
                files = c.files_after(n)
                self.assertEqual([path for path in files if path == "state.json" or "/" in path], [])
        self.assertEqual((c.log("pax"), c.log("upload")), ([], []))


@needs_pwsh
class RunnerSourceTests(unittest.TestCase):
    """The runner scripts as PowerShell's parser reads them, and the calls between them."""

    @classmethod
    def setUpClass(cls):
        cls.ast = ast_report()

    def params(self, script):
        return {param["name"]: param for param in self.ast[script.name]["params"]}

    def test_the_runner_scripts_parse_and_are_plain_ascii(self):
        for script in (REFRESH, TASK, CREDENTIAL):
            with self.subTest(script=script.name):
                self.assertEqual(self.ast[script.name]["errors"], [])
                data = script.read_bytes()
                offset = next((i for i, byte in enumerate(data) if byte > 127), None)
                line = None if offset is None else data[:offset].count(b"\n") + 1
                self.assertIsNone(offset, f"{script.name} has a non-ASCII byte on line {line}")

    def test_every_flag_refresh_passes_to_pax_is_a_wrapper_parameter(self):
        strings = self.ast[REFRESH.name]["functions"]["Invoke-PaxChild"]["strings"]
        flags = {match.group(1) for text in strings if (match := re.fullmatch(r"-(\w+)", text))}
        flags -= {"NoProfile", "NonInteractive", "File"}
        # The secret travels in AIBV_CLIENT_SECRET, never on a command line that other processes can read.
        self.assertEqual(flags, {"TenantId", "ClientId", "Days", "StartDate", "EndDate", "WorkRoot", "PaxReleaseTag",
                                 "PaxSha256", "SkipVersionCheck", "AppendFile", "AppendUserInfo", "IncludeAgent365Info",
                                 "Deidentify"})
        wrapper = self.params(WRAPPER)
        self.assertLessEqual(flags, set(wrapper), sorted(flags - set(wrapper)))
        self.assertEqual({name for name in flags if wrapper[name]["switch"]},
                         {"SkipVersionCheck", "IncludeAgent365Info", "Deidentify"})

    def test_send_file_binds_to_the_uploaders_single_file_set(self):
        keys = set(self.ast[REFRESH.name]["functions"]["Send-File"]["hashtableKeys"])
        self.assertEqual(keys, {"File", "RemoteName", "TenantId", "ClientId", "ClientSecret", "SiteId", "DriveId",
                                "FolderPath"})
        uploader = self.params(UPLOADER)
        for key in sorted(keys):
            with self.subTest(parameter=key):
                self.assertIn(key, uploader)
                sets = {entry["set"] for entry in uploader[key]["sets"]}
                self.assertTrue(not sets or sets & {"File", "__AllParameterSets"}, sets)
        mandatory = {name for name, param in uploader.items()
                     if any(entry["mandatory"] and entry["set"] in ("File", "__AllParameterSets")
                            for entry in param["sets"])}
        self.assertIn("File", mandatory)
        self.assertLessEqual(mandatory, keys, sorted(mandatory - keys))

    def test_refresh_reads_the_secret_with_credential_ps1s_read_action(self):
        credential = self.params(CREDENTIAL)
        self.assertIn("Read", credential["Action"]["validateSet"])
        self.assertIn("Target", credential)
        strings = self.ast[REFRESH.name]["functions"]["Get-AppSecret"]["strings"]
        self.assertIn("credential.ps1", strings)
        self.assertIn("Read", strings)

    def test_nothing_the_task_runs_bypasses_the_execution_policy_or_elevates(self):
        for script in (REFRESH, TASK, CREDENTIAL, WRAPPER, UPLOADER):
            text = script.read_text(encoding="utf-8-sig")
            with self.subTest(script=script.name):
                self.assertIsNone(re.search(r"(?<![\w-])-ExecutionPolicy\b", text, re.IGNORECASE))
                self.assertNotIn("PSExecutionPolicyPreference", text)
                self.assertIsNone(re.search(r"\bBypass\b", text))
                self.assertNotIn("Highest", text)
        self.assertIn("-RunLevel Limited", TASK.read_text(encoding="utf-8"))

    def test_days_outside_1_to_180_is_refused_before_anything_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp).resolve() / "nope.json"
            for days in (0, 181):
                with self.subTest(days=days):
                    result = _pwsh_file(REFRESH, "-Config", config, "-Days", days, timeout=120)
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn("Days", flat(result.stdout + result.stderr))
                    self.assertNotIn("norefreshconfig", flat(result.stdout + result.stderr).lower())


TASK_COMMANDS = {"Get-ExecutionPolicy", "New-ScheduledTaskAction", "New-ScheduledTaskTrigger", "New-ScheduledTaskPrincipal",
                 "New-ScheduledTaskSettingsSet", "Register-ScheduledTask", "Get-ScheduledTask", "Get-ScheduledTaskInfo",
                 "Unregister-ScheduledTask", "Start-ScheduledTask"}
REGISTER_CALLS = ["Get-ExecutionPolicy", "New-ScheduledTaskAction", "New-ScheduledTaskTrigger", "New-ScheduledTaskPrincipal",
                  "New-ScheduledTaskSettingsSet", "Register-ScheduledTask", "Get-ScheduledTask", "Get-ScheduledTaskInfo"]
TASK_READS = {
    "MSFT_ScheduledTask.Actions", "MSFT_ScheduledTask.State", "MSFT_ScheduledTask.Principal",
    "MSFT_TaskPrincipal.UserId", "MSFT_TaskPrincipal.LogonType", "MSFT_TaskPrincipal.RunLevel",
    "MSFT_TaskDynamicInfo.LastRunTime", "MSFT_TaskDynamicInfo.LastTaskResult", "MSFT_TaskDynamicInfo.NextRunTime",
    "MSFT_TaskExecAction.Execute", "MSFT_TaskExecAction.Arguments", "MSFT_TaskExecAction.WorkingDirectory",
}
# Calls the real module rejects, so the check can't pass by accepting everything.
BAD_TASK_CALLS = [
    ({"command": "New-ScheduledTaskPrincipal", "parameters": ["UserId", "LogonType"],
      "values": {"UserId": "someone", "LogonType": "Foo"}},
     "New-ScheduledTaskPrincipal -LogonType doesn't accept 'Foo'"),
    ({"command": "Register-ScheduledTask", "parameters": ["TaskName", "Action", "User", "Principal"],
      "values": {"TaskName": "x", "Action": None, "User": "someone", "Principal": None}},
     "No parameter set of Register-ScheduledTask"),
    ({"command": "New-ScheduledTaskTrigger", "parameters": ["Daily"], "values": {"Daily": True}},
     "No parameter set of New-ScheduledTaskTrigger"),
    ({"command": "Start-ScheduledTask", "parameters": ["Bogus"], "values": {"Bogus": "x"}},
     "Start-ScheduledTask has no -Bogus parameter"),
    ({"command": "Remove-Item", "parameters": ["Path"], "values": {"Path": "x"}},
     "Remove-Item isn't in the ScheduledTasks"),
]


@needs_pwsh
@needs_windows
class TaskTests(unittest.TestCase):
    """task.ps1 against stand-ins for the ScheduledTasks commands, then its calls against the real module."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="vl pax task ")).resolve()
        cls.addClassCleanup(shutil.rmtree, cls.tmp, ignore_errors=True)
        result_path = cls.tmp / "result.json"
        harness = _pwsh_file(TASK_HARNESS, "-TaskScript", TASK, "-WorkPath", cls.tmp / "task work",
                             "-ResultPath", result_path)
        if not result_path.exists():
            raise RuntimeError(f"task-harness.ps1 failed:\n{harness.stdout}\n{harness.stderr}")
        cls.result = json.loads(result_path.read_text(encoding="utf-8-sig"))
        cls.scenarios = {scenario["name"]: scenario for scenario in cls.result["scenarios"]}
        cls.check = cls.run_check("calls", [call for scenario in cls.result["scenarios"] for call in scenario["calls"]])
        cls.bad_check = cls.run_check("bad-calls", [call for call, _ in BAD_TASK_CALLS])

    @classmethod
    def run_check(cls, name, calls):
        calls_path = cls.tmp / f"{name}.json"
        result_path = cls.tmp / f"{name}-check.json"
        calls_path.write_text(json.dumps(calls), encoding="utf-8")
        check = _pwsh_file(TASK_CHECK, "-CallsPath", calls_path, "-TaskScript", TASK, "-ResultPath", result_path)
        if not result_path.exists():
            raise RuntimeError(f"task-check.ps1 failed:\n{check.stdout}\n{check.stderr}")
        return json.loads(result_path.read_text(encoding="utf-8-sig"))

    def report(self, name):
        scenario = self.scenarios[name]
        self.assertIsNone(scenario["error"], scenario["error"])
        return json.loads(scenario["output"])

    def commands(self, name):
        return [call["command"] for call in self.scenarios[name]["calls"]]

    def assertFails(self, name, message, calls=()):
        scenario = self.scenarios[name]
        self.assertIsNotNone(scenario["error"], scenario["output"])
        self.assertIn(message, scenario["error"])
        self.assertEqual(self.commands(name), list(calls))
        self.assertIsNone(scenario["task"])

    def test_every_call_task_ps1_makes_fits_the_real_scheduledtasks_module(self):
        self.assertEqual(self.check["problems"], [])
        self.assertEqual({shape.split(" ")[0] for shape in self.check["calls"]}, TASK_COMMANDS)
        self.assertLessEqual(TASK_READS, set(self.check["reads"]), sorted(TASK_READS - set(self.check["reads"])))
        self.assertEqual(self.check["leftover"], [], "a test task is registered in Task Scheduler")

    def test_the_check_reports_calls_the_real_module_rejects(self):
        problems = self.bad_check["problems"]
        for call, message in BAD_TASK_CALLS:
            with self.subTest(command=call["command"]):
                self.assertTrue(any(message in problem for problem in problems), problems)

    def test_register_creates_a_limited_daily_task_for_the_signed_in_user(self):
        r = self.result
        paths = r["paths"]
        self.assertEqual(self.report("register-ok"), {
            "taskName": r["taskName"], "exists": True, "state": "Ready", "lastRunTime": None,
            "lastTaskResult": 267011, "neverRan": True, "nextRunTime": r["nextRunUtc"],
            "userId": r["identity"], "logonType": "Interactive", "runLevel": "Limited", "execute": paths["pwsh"],
            "arguments": (f'-NoProfile -NonInteractive -WindowStyle Hidden -File "{paths["script"]}" '
                          f'-Config "{paths["config"]}"'),
            "workingDirectory": paths["work"]})
        self.assertEqual(self.commands("register-ok"), REGISTER_CALLS)
        task = self.scenarios["register-ok"]["task"]
        self.assertEqual(task["Description"], "Test refresh")
        self.assertEqual(task["Triggers"], [{"Daily": True, "At": "02:00"}])
        self.assertEqual(task["Settings"], {
            "StartWhenAvailable": True, "AllowStartIfOnBatteries": True, "DontStopIfGoingOnBatteries": True,
            "RunOnlyIfNetworkAvailable": True, "ExecutionTimeLimit": "12:00:00", "MultipleInstances": "IgnoreNew"})

    def test_info_reports_whether_the_task_has_run(self):
        r = self.result
        self.assertEqual(self.report("info-never-ran"), self.report("register-ok"))
        ran = self.report("info-ran")
        self.assertEqual((ran["neverRan"], ran["lastRunTime"], ran["lastTaskResult"], ran["nextRunTime"]),
                         (False, r["lastRunUtc"], 0, r["nextRunUtc"]))
        self.assertEqual(self.commands("info-ran"), ["Get-ScheduledTask", "Get-ScheduledTaskInfo"])
        self.assertEqual(self.report("info-missing"), {"taskName": r["otherName"], "exists": False})
        self.assertEqual(self.commands("info-missing"), ["Get-ScheduledTask"])

    def test_start_runs_the_task_now_and_points_at_repair_when_it_is_missing(self):
        self.assertEqual(self.report("start-present")["state"], "Running")
        self.assertEqual(self.commands("start-present"),
                         ["Get-ScheduledTask", "Start-ScheduledTask", "Get-ScheduledTask", "Get-ScheduledTaskInfo"])
        self.assertFails("start-missing", f"There's no scheduled task named '{self.result['otherName']}'. "
                         "Run the installer's repair to register it again.", ["Get-ScheduledTask"])

    def test_register_stops_when_the_execution_policy_would_block_the_scripts(self):
        for name, policy in (("policy-allsigned", "AllSigned"), ("policy-restricted", "Restricted")):
            with self.subTest(policy=policy):
                self.assertFails(name, (
                    f"PowerShell's execution policy for {self.result['userName']} is {policy}, so a scheduled task "
                    "can't run the refresh scripts, which aren't signed. The installer doesn't bypass the policy. "
                    "Ask your administrator to allow RemoteSigned for this account "
                    "(Set-ExecutionPolicy -Scope CurrentUser RemoteSigned), or use a machine that allows it."),
                    ["Get-ExecutionPolicy"])

    def test_bad_arguments_stop_before_task_scheduler_is_touched(self):
        paths = self.result["paths"]
        for name in ("missing-script", "missing-config"):
            with self.subTest(name):
                self.assertFails(name, "Register needs -ScriptPath and -ConfigPath.")
        self.assertFails("missing-pwsh", f"pwsh.exe wasn't found at '{paths['missingPwsh']}'.", ["Get-ExecutionPolicy"])
        for name in ("folder-name", "padded-name"):
            with self.subTest(name):
                self.assertFails(name, "-TaskName must be a plain name, without folders or surrounding spaces.")
        self.assertFails("bad-time", "Cannot validate argument on parameter 'At'")
        self.assertFails("bad-action", "parameter 'Action'")

    def test_a_microsoft_store_pwsh_runs_through_its_stable_alias(self):
        r = self.result
        self.assertEqual(self.report("store-alias")["execute"], r["paths"]["alias"])
        task = self.scenarios["store-alias"]["task"]
        self.assertEqual((task["Triggers"][0]["At"], task["Description"]), ("23:30", ""))
        self.assertFails("store-no-alias", f"pwsh.exe wasn't found at '{r['paths']['storePwsh']}'.",
                         ["Get-ExecutionPolicy"])
        process = r["processPath"]
        alias = Path(r["localAppData"], "Microsoft", "WindowsApps", "pwsh.exe")
        store = re.search(r"\\WindowsApps\\", process, re.IGNORECASE) and alias.exists()
        self.assertEqual(self.report("default-pwsh")["execute"], str(alias) if store else process)

    def test_register_again_replaces_the_task_and_unregister_is_quiet(self):
        r = self.result
        name = r["taskName"]
        self.assertEqual(self.scenarios["re-register"]["task"]["Triggers"][0]["At"], "04:15")
        self.assertEqual(self.report("unregister-present"), {"taskName": name, "removed": True})
        unregister = [call for call in self.scenarios["unregister-present"]["calls"]
                      if call["command"] == "Unregister-ScheduledTask"]
        self.assertEqual(len(unregister), 1)
        self.assertIs(unregister[0]["values"]["Confirm"], False)
        self.assertIsNone(self.scenarios["unregister-present"]["task"])
        self.assertEqual(self.report("unregister-missing"), {"taskName": name, "removed": False})
        self.assertEqual(self.commands("unregister-missing"), ["Get-ScheduledTask"])
        self.assertEqual(r["remaining"], [f"\\|{name}-alias", f"\\|{name}-default"])


@needs_pwsh
@needs_windows
class CredentialTests(unittest.TestCase):
    """credential.ps1 against Windows Credential Manager, with throwaway entries that each test deletes."""

    @staticmethod
    def credential(action, target, *args, input_text=None):
        return _pwsh_file(CREDENTIAL, "-Action", action, "-Target", target, *args, input_text=input_text, timeout=120)

    @classmethod
    def setUpClass(cls):
        probe = cls.credential("Test", f"PaxRunnerTest-{uuid.uuid4().hex}")
        output = probe.stdout + probe.stderr
        if probe.returncode != 0 and ("1312" in output or "logon session" in output.lower()):
            raise unittest.SkipTest("Windows Credential Manager isn't available in this logon session")

    def throwaway(self):
        target = f"PaxRunnerTest-{uuid.uuid4().hex}"
        self.addCleanup(self.credential, "Delete", target)
        return target

    def test_write_read_test_and_delete_round_trip(self):
        target = self.throwaway()
        first = self.credential("Write", target, "-UserName", "earlier", input_text="first-secret\n")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        # Writing again replaces the secret, as repair does.
        written = self.credential("Write", target, "-UserName", CLIENT, input_text="  round-trip-secret  \n")
        self.assertEqual(written.returncode, 0, written.stdout + written.stderr)
        self.assertEqual(json.loads(written.stdout), {"target": target, "written": True})
        self.assertNotIn("round-trip-secret", written.stdout + written.stderr)
        read = self.credential("Read", target)
        self.assertEqual((read.returncode, read.stdout.strip()), (0, "round-trip-secret"), read.stderr)
        info = json.loads(self.credential("Test", target).stdout)
        self.assertEqual((info["target"], info["exists"], info["userName"]), (target, True, CLIENT))
        stamp = re.sub(r"\.(\d{6})\d*", r".\1", info["lastWrittenUtc"]).replace("Z", "+00:00")
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()
        self.assertLess(abs(age), 300, info["lastWrittenUtc"])
        for expected in (True, False):
            deleted = self.credential("Delete", target)
            self.assertEqual(json.loads(deleted.stdout), {"target": target, "deleted": expected})
        missing = self.credential("Read", target)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn(flat(f"no credential named {target}"), flat(missing.stdout + missing.stderr))
        self.assertEqual(json.loads(self.credential("Test", target).stdout),
                         {"target": target, "exists": False, "userName": None, "lastWrittenUtc": None})

    def test_write_needs_a_secret_on_standard_input(self):
        target = self.throwaway()
        empty = self.credential("Write", target, "-UserName", CLIENT, input_text=" \n")
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn(flat("No secret arrived on standard input."), flat(empty.stdout + empty.stderr))
        self.assertFalse(json.loads(self.credential("Test", target).stdout)["exists"])

    def test_a_padded_target_is_refused(self):
        result = self.credential("Test", " lead")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(flat("-Target must not start or end with spaces."), flat(result.stdout + result.stderr))


if __name__ == "__main__":
    unittest.main()
