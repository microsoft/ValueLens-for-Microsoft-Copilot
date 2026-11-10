#!/usr/bin/env python3
"""Generate the Databricks notebook route from the canonical Fabric sources."""

from __future__ import annotations

import ast
import io
import json
import re
import sys
import tokenize
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "1. Fabric" / "Manual setup" / "notebooks"
TARGET = ROOT / "6. Other Data Lake" / "Databricks" / "notebooks"

NOTEBOOKS = (
    "Copilot_Audit_Log_Direct_Ingester.ipynb",
    "Copilot_Audit_Log_Processor.ipynb",
    "ValueLens_Data_Check.ipynb",
    "ValueLens_Refresh_Model.ipynb",
    "Copilot_Licensed_Users_Direct_Ingester.ipynb",
    "Copilot_Org_Data_Direct_Ingester.ipynb",
    "Copilot_Agent365_Registry_Ingester.ipynb",
    "Copilot_Agent365_Lander.ipynb",
    "Copilot_Defender_Ingester.ipynb",
    "Copilot_M365_Activity_Ingester.ipynb",
    "Copilot_ProductFeedback_Ingester.ipynb",
    "Copilot_Resource_Graph_Ingester.ipynb",
    "AnalyticsHub_Access_Scope.ipynb",
    "AnalyticsHub_Upload_Router.ipynb",
    "AnalyticsHub_Load_Status.ipynb",
    "workday-org-data/Copilot_Org_Data_Workday_Lander.ipynb",
)

PATH_PARAMETERS = {
    "STAGING_DIR": "Files/_audit_staging",
    "SCOPE_FILE": "Files/analytics_hub_access/access_scope.csv",
    "SOURCE_CSV": "Files/agent365/agents.csv",
    "SOURCE_DIR": "Files/product_feedback",
    "WATCHLIST_FILE": "Files/defender/ai_watchlist.csv",
    "INVENTORY_FOLDER": "Files/arg_inventory",
    "DROP_DIR": "Files/analytics_hub_uploads",
    "SHAREPOINT_DIR": "Files/analytics_hub_uploads/sharepoint",
    "SOURCE_PATH": "Files/org_workday/",
}

STATUS_EXCLUSIONS = (
    "Consumption",
    "Cowork",
    "Agent_Evaluator",
    "Agent Evaluator",
    "Run_Agent_Evaluator",
    "Refresh_Agent_Evaluator",
)

TASK_STATUS_NOTEBOOK = r'''
import json
import re
from datetime import datetime, timezone
from pyspark.sql import types as T
from valuelens_databricks_runtime import workflow_task_runs

STATUS = json.loads(STATUS_JSON)
JOB_RUN_ID = VL.widget("job_run_id", "").strip()
TASK_STATES_JSON = VL.widget("task_states_json", "{}")
LOG_TABLE = f"{DB_SCHEMA}.load_log"
NOW = datetime.now(timezone.utc)
SCHEMA = T.StructType([
    T.StructField("run_id", T.StringType()),
    T.StructField("activity", T.StringType()),
    T.StructField("source", T.StringType()),
    T.StructField("activity_type", T.StringType()),
    T.StructField("status", T.StringType()),
    T.StructField("reason_kind", T.StringType()),
    T.StructField("reason", T.StringType()),
    T.StructField("attempts", T.IntegerType()),
    T.StructField("started_at", T.TimestampType()),
    T.StructField("ended_at", T.TimestampType()),
    T.StructField("duration_seconds", T.DoubleType()),
    T.StructField("error_code", T.StringType()),
    T.StructField("error_message", T.StringType()),
    T.StructField("logged_at", T.TimestampType()),
])
REQUIRED_TASKS = {
    "Run_Audit_Log_Ingester",
    "Run_Audit_Log_Processor",
    "Run_Licensed_Users_Ingester",
    "Run_Org_Data_Ingester",
    "Refresh_Semantic_Model",
}
TASK_VALUE_ALIASES = {
    "Run_Agent365_CSV_Fallback": "Run_Agent365_Lander",
}


def _workflow_task_runs():
    if not JOB_RUN_ID:
        return {}
    if not re.fullmatch(r"\d+", JOB_RUN_ID):
        raise ValueError("job_run_id must be the numeric Databricks workflow run ID.")
    raw_states = json.loads(TASK_STATES_JSON or "{}")
    task_values = {}
    for task_key in STATUS["labels"]:
        task_value_key = TASK_VALUE_ALIASES.get(task_key, task_key)
        if task_key in raw_states or task_value_key in raw_states:
            task_values[task_value_key] = VL.task_status(task_value_key) or {}
    return workflow_task_runs(
        STATUS["labels"],
        raw_states,
        task_values,
        REQUIRED_TASKS,
        TASK_VALUE_ALIASES,
    )


def record():
    if not JOB_RUN_ID:
        print("No Databricks workflow run ID; load status was not recorded.")
        return []

    last = _workflow_task_runs()
    warnings = find_warnings(last)
    data = rows(
        last,
        STATUS["labels"],
        STATUS["reasons"],
        JOB_RUN_ID,
        NOW.replace(tzinfo=None),
        warnings,
    )
    for row in data:
        for field in ("started_at", "ended_at"):
            if row[field] is not None:
                row[field] = row[field].replace(tzinfo=None)
    if not data:
        print(f"No load-status rows were produced for workflow run {JOB_RUN_ID}.")
        return []

    if not spark.catalog.tableExists(LOG_TABLE):
        spark.createDataFrame(data, schema=SCHEMA).write.format("delta").mode("append").saveAsTable(LOG_TABLE)
    else:
        spark.createDataFrame(data, schema=SCHEMA).createOrReplaceTempView("_valuelens_load_status")
        spark.sql(
            f"DELETE FROM {LOG_TABLE} "
            f"WHERE run_id = '{JOB_RUN_ID}'"
        )
        spark.sql(
            f"INSERT INTO {LOG_TABLE} "
            "SELECT * FROM _valuelens_load_status"
        )

    failures = failed_loads(last)
    if failures:
        raise RuntimeError(f"ValueLens workflow completed with failed tasks: {failures}")
    print(f"Recorded {len(data)} load-status rows for workflow run {JOB_RUN_ID}.")
    return []


record()
dbutils.notebook.exit("Succeeded")
'''


def _cell_source(cell: dict) -> str:
    source = cell.get("source", "")
    return "".join(source) if isinstance(source, list) else source


def _set_cell_source(cell: dict, source: str) -> None:
    cell["source"] = source.splitlines(keepends=True)


def _replace_schema_literals(source: str) -> str:
    lines = source.splitlines(keepends=True)
    offsets = []
    current = 0
    for line in lines:
        offsets.append(current)
        current += len(line)

    replacements = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.STRING or "dbo." not in token.string:
            continue
        match = re.match(r"(?i)^([rubf]*)(('{3}|\"{3})|'|\")", token.string)
        if not match:
            continue
        prefix, quote = match.group(1), match.group(2)
        body = token.string[len(prefix) + len(quote) : -len(quote)]
        if "f" not in prefix.lower() and ("{" in body or "}" in body):
            body = body.replace("{", "{{").replace("}", "}}")
        body = body.replace("dbo.", "{DB_SCHEMA}.")
        if "f" not in prefix.lower():
            prefix = "f" + prefix
        literal = f"{prefix}{quote}{body}{quote}"
        start = offsets[token.start[0] - 1] + token.start[1]
        end = offsets[token.end[0] - 1] + token.end[1]
        replacements.append((start, end, literal))

    for start, end, literal in reversed(replacements):
        source = source[:start] + literal + source[end:]
    return source


def _set_json_assignment(source: str, name: str, value) -> str:
    literal = repr(json.dumps(value, separators=(",", ":"), ensure_ascii=False))
    pattern = rf"(?m)^([ \t]*{re.escape(name)}[ \t]*=[ \t]*).*$"
    updated, count = re.subn(pattern, lambda match: match.group(1) + literal, source)
    if count != 1:
        raise ValueError(f"Expected one {name} assignment, found {count}.")
    return updated


def _read_json_assignment(source: str, name: str):
    module = ast.parse(source)
    for node in ast.walk(module):
        if isinstance(node, ast.Assign):
            if any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
                return json.loads(ast.literal_eval(node.value))
    raise ValueError(f"Missing {name} assignment.")


def _replace_function(source: str, function_name: str, replacement: str, next_marker: str) -> str:
    start = source.find(f"def {function_name}(")
    end = source.find(next_marker, start)
    if start < 0 or end < 0:
        raise ValueError(f"Could not replace function {function_name}.")
    return source[:start] + replacement.rstrip() + source[end:]


def _replace_class(source: str, class_name: str, replacement: str, next_marker: str) -> str:
    start = source.find(f"class {class_name}:")
    end = source.find(next_marker, start)
    if start < 0 or end < 0:
        raise ValueError(f"Could not replace class {class_name}.")
    return source[:start] + replacement.rstrip() + source[end:]


def _filter_load_status_config(source: str) -> str:
    status = _read_json_assignment(source, "STATUS_JSON")
    status["labels"] = {
        key: value
        for key, value in status["labels"].items()
        if not any(exclusion in key for exclusion in STATUS_EXCLUSIONS)
    }
    status["statusTables"] = [
        item
        for item in status["statusTables"]
        if not any(
            exclusion in item.get("table", "") or exclusion in item.get("activity", "")
            for exclusion in STATUS_EXCLUSIONS
        )
    ]
    status["reasons"] = [
        item
        for item in status["reasons"]
        if item.get("kind") != "notSynced"
        and not any(exclusion in item.get("activity", "") for exclusion in STATUS_EXCLUSIONS)
    ]
    for reason in status["reasons"]:
        if reason.get("kind") == "capacity":
            reason["text"] = "The capacity was too busy to start it."
    source = _set_json_assignment(source, "STATUS_JSON", status)
    return source


def _rewrite_snapshots(source: str) -> str:
    root_function = '''def conversation_snapshot_root(_table_location=None):
    return VL.path("Files/_valuelens_conversations")
'''
    source = _replace_function(
        source,
        "conversation_snapshot_root",
        root_function,
        "\n\nclass ConversationSnapshots:",
    )
    snapshot_class = '''class ConversationSnapshots:
    def __init__(self, spark, root):
        self.spark = spark
        self.path = None
        self.closed = False
        if root is not None:
            root = str(root).rstrip("/")
            if not root.startswith("/Volumes/"):
                raise ValueError("Conversation snapshots must use the configured Unity Catalog volume.")
            self.path = root + "/" + uuid.uuid4().hex
            os.makedirs(self.path, exist_ok=False)

    def __enter__(self):
        return self

    def materialize(self, df):
        if self.closed or self.path is None:
            raise RuntimeError("Conversation snapshot scope is closed or has no storage root")
        path = self.path + "/" + uuid.uuid4().hex
        df.write.mode("errorifexists").parquet(path)
        return self.spark.read.schema(df.schema).parquet(path)

    def close(self):
        if not self.closed and self.path and os.path.exists(self.path):
            shutil.rmtree(self.path)
        self.closed = True

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.close()
        except Exception as cleanup_error:
            if exc is None:
                raise
            print(f"[warn] conversation snapshot cleanup also failed: {cleanup_error}")
        return False
'''
    source = _replace_class(
        source,
        "ConversationSnapshots",
        snapshot_class,
        "\n\ndef has_col(",
    )
    if "import os" not in source:
        source = "import os\nimport shutil\n" + source
    elif "import shutil" not in source:
        source = "import shutil\n" + source
    return source


def _rewrite_code(path: Path, source: str) -> str:
    source = source.replace("notebookutils.fs.", "VL.fs.")
    source = source.replace("notebookutils.notebook.exit(", "dbutils.notebook.exit(")
    source = source.replace("notebookutils.credentials.getToken('pbi')", "VL.powerbi_headers(TENANT_ID, CLIENT_ID, CLIENT_SECRET)")
    source = source.replace('notebookutils.credentials.getToken("pbi")', "VL.powerbi_headers(TENANT_ID, CLIENT_ID, CLIENT_SECRET)")
    source = re.sub(r"(?m)^[ \t]*(?:import|from) notebookutils[^\n]*\n", "", source)
    source = re.sub(
        r"(?mi)^[ \t]*#.*(?:CLIENT_SECRET|getSecret|credentials\.getSecret).*\n",
        "",
        source,
    )

    for variable, relative_path in PATH_PARAMETERS.items():
        source = re.sub(
            rf"(?m)^([ \t]*){re.escape(variable)}[ \t]*=.*$",
            rf'\1{variable} = VL.path("{relative_path}")',
            source,
        )

    source = re.sub(
        r"(?m)^([ \t]*)path[ \t]*=[ \t]*f?['\"]/lakehouse/default/\{SCOPE_FILE\}['\"].*$",
        r"\1path = SCOPE_FILE",
        source,
    )
    source = re.sub(
        r"(?m)^([ \t]*)folder[ \t]*=[ \t]*f?['\"]/lakehouse/default/\{INVENTORY_FOLDER\}['\"].*$",
        r"\1folder = INVENTORY_FOLDER",
        source,
    )
    source = re.sub(
        r"(?m)^([ \t]*)TENANT_ID[ \t]*=.*$",
        r'\1TENANT_ID = VL.widget("tenant_id", "")',
        source,
    )
    source = re.sub(
        r"(?m)^([ \t]*)CLIENT_ID[ \t]*=.*$",
        r'\1CLIENT_ID = VL.widget("client_id", "")',
        source,
    )
    source = re.sub(
        r"(?m)^([ \t]*)CLIENT_SECRET[ \t]*=.*$",
        r"\1CLIENT_SECRET = VL.secret()",
        source,
    )

    if path.name == "Copilot_Audit_Log_Direct_Ingester.ipynb":
        if "def _get_notebook_fs(" in source:
            source = _replace_function(
                source,
                "_get_notebook_fs",
                "def _get_stage_fs():\n    return VL.fs",
                "\n\ndef _ensure_stage_dir(",
            )
            source = source.replace("_get_notebook_fs", "_get_stage_fs")
        if "def _normalize_stage_dir(" in source:
            source = _replace_function(
                source,
                "_normalize_stage_dir",
                '''def _normalize_stage_dir(path: str) -> str:
    if not isinstance(path, str) or not path.strip():
        raise ValueError(f"Stage directory must be a non-empty string; found {path!r}.")
    normalized = VL.path(path)
    if normalized.startswith("abfss://"):
        raise ValueError("Audit staging must use the configured Unity Catalog volume.")
    if normalized.startswith("/Volumes/"):
        return normalized.rstrip("/")
    return os.path.abspath(normalized)
''',
                "\n\ndef _is_remote_stage_dir(",
            )
        if "def _is_remote_stage_dir(" in source:
            source = _replace_function(
                source,
                "_is_remote_stage_dir",
                '''def _is_remote_stage_dir(path: str) -> bool:
    if isinstance(path, str) and path.startswith("abfss://"):
        raise ValueError("Audit staging must use the configured Unity Catalog volume.")
    return False
''',
                "\n\ndef _stage_path_join(",
            )
        if "def _driver_temp_root(" in source:
            source = _replace_function(
                source,
                "_driver_temp_root",
                '''def _driver_temp_root(base_dir: str) -> str:
    configured = globals().get("LOCAL_STAGE_TMP_DIR")
    if base_dir.startswith("/Volumes/"):
        root = os.path.abspath(base_dir)
    elif isinstance(configured, str) and configured.strip():
        root = os.path.abspath(configured)
    else:
        root = os.path.abspath(base_dir)
    os.makedirs(root, exist_ok=True)
    return root
''',
                "\n\ndef _new_local_temp_path(",
            )
        source = source.replace(
            "# Fabric's third argument is create_path, not overwrite. Rename in place\n"
            "        # without first deleting the valid destination checkpoint.",
            "# Rename the checkpoint in place without deleting the valid destination first.",
        )
    if path.name == "Copilot_Audit_Log_Processor.ipynb":
        if "def conversation_snapshot_root(" in source:
            source = _rewrite_snapshots(source)
        source = re.sub(
            r'(?m)^[ \t]*spark\.conf\.set\(["\']spark\.sql\.parquet\.vorder\.enabled["\'].*\n',
            "",
            source,
        )
        source = re.sub(r"(?i)\s+VORDER(?=['\"])", "", source)
        source = source.replace("OPTIMIZE + VORDER", "Delta compaction")
        source = source.replace("V-Order for Direct Lake / fast import", "Databricks Delta compaction")
        source = source.replace("Lakehouse table", "Unity Catalog table")
        source = source.replace("# V-Order every Parquet/Delta file this session writes (required for Direct Lake perf).\n", "")
    source = re.sub(r"(?i)\s+VORDER(?=['\"])", "", source)
    source = source.replace("f'dbo.{name}'", "f'{DB_SCHEMA}.{name}'")
    source = source.replace('f"dbo.{name}"', 'f"{DB_SCHEMA}.{name}"')
    if path.name == "Copilot_ProductFeedback_Ingester.ipynb":
        source = re.sub(
            r"(?m)^[ \t]*# OneLake metadata works.*\n[ \t]*# is a notebook-local mount.*$",
            "    # Read source files from the configured Unity Catalog volume.",
            source,
        )
    if path.name == "Copilot_Defender_Ingester.ipynb":
        source = re.sub(
            r"(?m)^[ \t]*# The starting watchlist\..*\n(?:[ \t]*#.*\n)?",
            "# Keep the edited watchlist CSV in the configured volume at Files/defender/ai_watchlist.csv.\n",
            source,
        )
    if path.name == "Copilot_ProductFeedback_Ingester.ipynb":
        source = source.replace(
            "# Folder in the attached Lakehouse where the Power Automate flow lands the feedback CSV(s).",
            "# Folder in the configured Unity Catalog volume where feedback CSVs are delivered.",
        )
    source = source.replace(
        "pure, so they can be tested off Fabric",
        "pure Python helpers",
    )
    if path.name == "ValueLens_Data_Check.ipynb":
        source = source.replace(
            "SCHEMA         = None      # e.g. 'dbo' for a schema-enabled Lakehouse; None to auto-detect",
            "SCHEMA         = DB_SCHEMA  # current Unity Catalog schema",
        )
        source = source.replace(
            '"""Find <name> whether the Lakehouse is schema-enabled or not."""',
            '"""Find <name> in the configured Unity Catalog schema."""',
        )
    if path.name == "AnalyticsHub_Load_Status.ipynb":
        if re.search(r"(?m)^[ \t]*STATUS_JSON[ \t]*=", source):
            source = _filter_load_status_config(source)
            source = re.sub(r"(?m)^[ \t]*PIPELINE_RUN_ID\s*=.*\n", "", source)
            source = re.sub(r"(?m)^[ \t]*PIPELINE_TRIGGER_TIME\s*=.*\n", "", source)
        elif source.lstrip().startswith("# === RECORD ==="):
            source = TASK_STATUS_NOTEBOOK
        elif "sempy.fabric" in source:
            source = re.sub(r"(?m)^[ \t]*(?:import|from) sempy\.fabric.*\n", "", source)
    if path.name == "ValueLens_Refresh_Model.ipynb":
        source = source.replace("import time\n", "import re\nimport time\n", 1)
        source = re.sub(
            r"(?m)^([ \t]*)WORKSPACE_ID[ \t]*=.*$",
            r'\1WORKSPACE_ID = VL.widget("pbi_workspace_id", "")',
            source,
        )
        source = re.sub(
            r"(?m)^([ \t]*)SEMANTIC_MODEL_ID[ \t]*=.*$",
            r'\1SEMANTIC_MODEL_ID = VL.widget("pbi_semantic_model_id", "")',
            source,
        )
        source = re.sub(
            r"(?m)^[ \t]*FABRIC[ \t]*=.*\n",
            "",
            source,
        )
        source = re.sub(
            r"(?m)^[ \t]*SYNC_TIMEOUT_MINUTES[ \t]*=.*\n",
            "",
            source,
        )
        source = re.sub(
            r"(?ms)^def _sync_sql_endpoints\(\):.*?(?=^def _start\()",
            "",
            source,
        )
        source = source.replace(
            "print('Syncing the SQL endpoints...')\n_sync_sql_endpoints()\n",
            "print('Databricks SQL Warehouse reads the configured Unity Catalog schema directly.')\n",
        )
        source = source.replace(
            "return {'Authorization': 'Bearer ' + VL.powerbi_headers(TENANT_ID, CLIENT_ID, CLIENT_SECRET)}",
            "return VL.powerbi_headers(TENANT_ID, CLIENT_ID, CLIENT_SECRET)",
        )
        source = source.replace(
            "if not WORKSPACE_ID or not SEMANTIC_MODEL_ID:\n"
            "    raise ValueError('Set WORKSPACE_ID and SEMANTIC_MODEL_ID in the cell above.')\n",
            "if not WORKSPACE_ID or not SEMANTIC_MODEL_ID:\n"
            "    raise ValueError('Set Power BI workspace and semantic model IDs in the cell above.')\n"
            "GUID = r\"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$\"\n"
            "if not re.fullmatch(GUID, WORKSPACE_ID) or not re.fullmatch(GUID, SEMANTIC_MODEL_ID):\n"
            "    raise ValueError(\"Power BI workspace and semantic model IDs must be GUIDs.\")\n",
        )
        source = source.replace(
            "CHECK_AUDIT_STATE = False",
            "CHECK_AUDIT_STATE = True",
        )
        source = re.sub(
            r"(?m)^([ \t]*)CHECK_AUDIT_STATE[ \t]*=.*$",
            r"\1CHECK_AUDIT_STATE = True  # verify the curated audit table changed before refreshing",
            source,
        )
        source = source.replace(
            "# An explicitly requested check must fail loudly if the default lakehouse is unavailable.",
            "# Fail clearly if the curated Delta table is unavailable.",
        )
        if (
            "WORKSPACE_ID = VL.widget" in source
            and "TENANT_ID = VL.widget" not in source
        ):
            source += (
                '\nTENANT_ID = VL.widget("tenant_id", "")'
                '\nCLIENT_ID = VL.widget("client_id", "")'
                "\nCLIENT_SECRET = VL.secret()"
                "\n"
            )

    source = _replace_schema_literals(source)
    source = source.replace("notebookutils", "dbutils")
    return source


def build_notebook(source_path: Path) -> dict:
    notebook = json.loads(source_path.read_text(encoding="utf-8"))
    code_cells = []
    for cell in notebook.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        cell = dict(cell)
        cell["execution_count"] = None
        cell["outputs"] = []
        _set_cell_source(cell, _rewrite_code(source_path, _cell_source(cell)))
        code_cells.append(cell)

    title = source_path.stem.replace("_", " ")
    intro = {
        "cell_type": "markdown",
        "metadata": {},
        "source": [
            f"# {title} (Databricks)\n",
            "\n",
            "Databricks adaptation of the corresponding ValueLens notebook. It uses the configured Unity Catalog schema and volume; see the [Databricks route guide](../README.md) for setup and scheduling.\n",
        ],
    }
    runtime = {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "from valuelens_databricks_runtime import initialize\n",
            "VL = initialize(spark, dbutils)\n",
            "DB_SCHEMA = VL.schema\n",
            "VL.record_task_start()\n",
        ],
    }
    for cell in code_cells:
        source = _cell_source(cell)
        should_record = source_path.name not in (
            "AnalyticsHub_Load_Status.ipynb",
            "ValueLens_Data_Check.ipynb",
        )
        if should_record and "dbutils.notebook.exit(" in source:
            source = _cell_source(cell)
            if "VL.record_task_success()" not in source:
                source = source.replace(
                    "dbutils.notebook.exit(",
                    "VL.record_task_success()\ndbutils.notebook.exit(",
                )
                _set_cell_source(cell, source)
        elif should_record and cell is code_cells[-1]:
            if "VL.record_task_success()" not in source:
                _set_cell_source(cell, source.rstrip() + "\n\nVL.record_task_success()\n")

    notebook["cells"] = [intro, runtime, *code_cells]
    notebook.setdefault("metadata", {})["kernelspec"] = {
        "display_name": "Python 3",
        "language": "python",
        "name": "python3",
    }
    notebook["metadata"]["language_info"] = {"name": "python"}
    return notebook


def main() -> int:
    check = "--check" in sys.argv[1:]
    errors = []
    for relative in NOTEBOOKS:
        source_path = SOURCE / relative
        if not source_path.is_file():
            errors.append(f"Missing source notebook: {source_path.relative_to(ROOT)}")
            continue
        output_path = TARGET / Path(relative).name
        rendered = json.dumps(build_notebook(source_path), indent=1, ensure_ascii=False) + "\n"
        if check:
            if not output_path.is_file() or output_path.read_text(encoding="utf-8") != rendered:
                errors.append(f"Generated notebook is stale: {output_path.relative_to(ROOT)}")
        else:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered, encoding="utf-8")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"{'Checked' if check else 'Generated'} {len(NOTEBOOKS)} Databricks notebooks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
