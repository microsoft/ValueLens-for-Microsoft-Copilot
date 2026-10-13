"""Azure capacity, solution spend and billing reconciliation collectors (Fabric notebook + CSV script)."""
from __future__ import annotations

import ast
import csv
import importlib.util
import json
from datetime import date

import pytest

import notebook_source

ROOT = notebook_source.ROOT
NOTEBOOK = "credit-consumption/Ingest_Azure_AI.ipynb"
CSV_SCRIPT = ROOT / "5. Local CSV" / "Add Credit Consumption" / "pull_azure_ai.py"
JOBS_COLLECTOR = ROOT / "2. Azure" / "jobs" / "valuelens_jobs" / "collect" / "azure_ai.py"
SAMPLES = ROOT / "5. Local CSV" / "Add Credit Consumption" / "sample-data"
DATAVERSE = ROOT / "3. Power Automate + Dataverse" / "Add Credit Consumption" / "dataverse-schema.json"
SHARED_START = "# --- Shared with the Fabric notebook Ingest_Azure_AI.ipynb (section 4); keep identical. ---\n"
SHARED_END = "# --- End of shared block. ---\n"
CONSTANTS = {"HEALTH_HEADERS", "RECON_HEADERS", "SOLUTION_HEADERS", "APPLICATION_TAG_KEYS",
             "HEALTH_REQUEST_METRICS", "HEALTH_UTILIZATION_METRICS", "HEALTH_LATENCY_METRICS",
             "TOKEN_METRICS", "REQUEST_METRICS", "SOLUTION_AI_SERVICES", "MODEL_SERVICES",
             "PAYG_POOL", "PROVISIONED_POOL", "RECON_TOLERANCES"}
TABLES = {"AzureDeploymentHealth": "HEALTH_HEADERS", "AzureSolutionSpend": "SOLUTION_HEADERS",
          "AzureBillingReconciliation": "RECON_HEADERS"}
RID = "/subscriptions/s/resourceGroups/RG1/providers/Microsoft.CognitiveServices/accounts/Acc"
START, END = date(2026, 4, 1), date(2026, 5, 10)


def _load_csv_module():
    spec = importlib.util.spec_from_file_location("pull_azure_ai", CSV_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CSV_MODULE = _load_csv_module()
NOTEBOOK_NS = notebook_source.namespace(NOTEBOOK, CONSTANTS)


@pytest.fixture(params=["notebook", "csv"])
def impl(request):
    return NOTEBOOK_NS if request.param == "notebook" else vars(CSV_MODULE)


def _helper_cell():
    cells = json.loads((notebook_source.NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8"))["cells"]
    found = [c for c in cells if c["cell_type"] == "code" and "def health_rows(" in "".join(c["source"])]
    assert len(found) == 1
    return "".join(found[0]["source"])


def test_shared_block_is_identical_in_notebook_and_csv_script():
    script = CSV_SCRIPT.read_text(encoding="utf-8").replace("\r\n", "\n")
    shared = script.split(SHARED_START, 1)[1].split(SHARED_END, 1)[0].strip()
    cell = _helper_cell()
    assert cell.startswith("import re\n")
    assert cell[len("import re\n"):].strip() == shared
    assert not any(isinstance(n, (ast.Import, ast.ImportFrom)) for n in ast.parse(shared).body)
    jobs = JOBS_COLLECTOR.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert jobs.split(SHARED_START, 1)[1].split(SHARED_END, 1)[0].strip() == shared


@pytest.mark.parametrize("table", TABLES)
def test_headers_match_the_report_contract(table):
    with (SAMPLES / f"{table}.csv").open(encoding="utf-8-sig", newline="") as handle:
        sample = next(csv.reader(handle))
    schema = json.loads(DATAVERSE.read_text(encoding="utf-8"))
    dataverse = next(t for t in schema["tables"] if t["modelTable"] == table)
    headers = getattr(CSV_MODULE, TABLES[table])
    assert headers == sample
    assert headers == [c["canonical"] for c in dataverse["columns"]]
    assert NOTEBOOK_NS[TABLES[table]] == headers


def test_notebook_writes_every_new_table_with_matching_schema():
    cells = json.loads((notebook_source.NOTEBOOKS / NOTEBOOK).read_text(encoding="utf-8"))["cells"]
    source = "\n".join("".join(c["source"]) for c in cells if c["cell_type"] == "code")
    for table, constant in (("azure_deployment_health", "HEALTH"), ("azure_solution_spend", "SOLUTION"),
                            ("azure_billing_reconciliation", "RECON")):
        assert f'LAKEHOUSE_{constant} = "{table}"' in " ".join(source.split())
        assert f"saveAsTable(LAKEHOUSE_{constant})" in source
        schema = source.split(f'{constant}_SCHEMA = (', 1)[1].split(")\n", 1)[0]
        columns = [part.split()[0] for part in "".join(ast.literal_eval(f"({schema})")).split(", ")]
        assert columns == NOTEBOOK_NS[f"{constant}_HEADERS"]


def _series(deployment, status, points):
    metadata = [{"name": {"value": "ModelDeploymentName"}, "value": deployment}]
    if status:
        metadata.append({"name": {"value": "StatusCode"}, "value": status})
    return {"metadatavalues": metadata, "data": points}


DEFINITIONS = [
    {"name": {"value": "ModelRequests"}, "supportedAggregationTypes": ["Total", "Count"],
     "dimensions": [{"value": "ModelDeploymentName"}, {"value": "StatusCode"}]},
    {"name": {"value": "ProvisionedUtilization"}, "supportedAggregationTypes": ["Average", "Maximum"],
     "dimensions": [{"value": "ModelDeploymentName"}]},
    {"name": {"value": "TimeToLastByte"}, "supportedAggregationTypes": ["Average", "Maximum"],
     "dimensions": [{"value": "ModelDeploymentName"}]},
]
DEPLOYMENTS = [
    {"name": "chat", "sku": {"name": "GlobalStandard", "capacity": 50},
     "properties": {"model": {"name": "gpt-4o", "version": "2024-08-06"}}},
    {"name": "ptu", "sku": {"name": "ProvisionedManaged", "capacity": 100},
     "properties": {"model": {"name": "gpt-4o", "version": "2024-08-06"}}, "tags": {"Application": "Bot"}},
]
REQUESTS = {"value": [{"name": {"value": "ModelRequests"}, "errorCode": "Success", "timeseries": [
    _series("chat", "200", [{"timeStamp": "2026-04-02T00:00:00Z", "total": 90},
                            {"timeStamp": "2026-05-02T00:00:00Z", "total": 10}]),
    _series("chat", "429", [{"timeStamp": "2026-04-02T00:00:00Z", "total": 8}]),
    _series("chat", "503", [{"timeStamp": "2026-04-03T00:00:00Z", "total": 2}]),
    _series("ptu", "200", [{"timeStamp": "2026-05-03T00:00:00Z", "total": 100}]),
    _series("deleted", "200", [{"timeStamp": "2026-04-05T00:00:00Z", "total": 5}]),
]}]}
QUALITY = {"value": [
    {"name": {"value": "ProvisionedUtilization"}, "timeseries": [
        _series("ptu", None, [{"timeStamp": "2026-05-03T00:00:00Z", "average": 40, "maximum": 90},
                              {"timeStamp": "2026-05-04T00:00:00Z", "average": 60, "maximum": 70}]),
        _series("chat", None, [{"timeStamp": "2026-04-02T00:00:00Z", "average": 5, "maximum": 5}])]},
    {"name": {"value": "TimeToLastByte"}, "timeseries": [
        _series("chat", None, [{"timeStamp": "2026-04-02T00:00:00Z", "average": 1000},
                               {"timeStamp": "2026-04-03T00:00:00Z", "average": 4000}])]},
]}


def _health(impl):
    warnings, acc = [], {}
    account = {"id": RID, "name": "Acc", "location": "swedencentral", "tags": {"app": "Chat"}}
    inventory = impl["deployment_inventory"](account, DEPLOYMENTS + [{"broken": True}], warnings)
    requests_plan, quality_plan = impl["health_metric_requests"](DEFINITIONS)
    impl["health_accumulate"](acc, REQUESTS, requests_plan, RID, START, END, warnings, "Acc")
    impl["health_accumulate"](acc, QUALITY, quality_plan, RID, START, END, warnings, "Acc")
    rows = impl["health_rows"](inventory, acc, START, END, "sub-id", "Sub")
    return {(r["DeploymentName"], str(r["MetricDate"])): r for r in rows}, warnings


def test_metric_calls_are_batched(impl):
    plans = impl["health_metric_requests"](DEFINITIONS)
    assert [p["metricnames"] for p in plans] == [["ModelRequests"], ["ProvisionedUtilization", "TimeToLastByte"]]
    assert plans[0]["filter"] == "ModelDeploymentName eq '*' and StatusCode eq '*'"
    assert plans[1]["aggregation"] == "Average,Maximum"
    params = impl["health_metric_parameters"](plans[1], plans[1]["metricnames"], START, END)
    assert params["metricnames"] == "ProvisionedUtilization,TimeToLastByte"
    assert params["interval"] == "P1D"
    assert impl["metric_windows"](START, END) == [(START, date(2026, 5, 1)), (date(2026, 5, 1), END)]


def test_health_rows_follow_the_report_measures(impl):
    rows, warnings = _health(impl)
    april = rows[("chat", "2026-04-30")]
    assert (april["Requests"], april["Throttles429"], april["ServerErrors5xx"]) == (100.0, 8.0, 2.0)
    assert april["MeanLatencyMs"] == 1060.0  # weighted by daily requests: (98*1000 + 2*4000) / 100
    assert april["PtuCapacity"] is None and april["MeanUtilizationPct"] is None  # Standard: no PTU
    assert april["Application"] == "Chat" and april["Region"] == "swedencentral"
    assert april["SnapshotDate"] == date(2026, 4, 30)
    ptu = rows[("ptu", "2026-05-31")]
    assert ptu["PtuCapacity"] == 100.0 and ptu["Application"] == "Bot"
    assert (ptu["MeanUtilizationPct"], ptu["PeakUtilizationPct"]) == (50.0, 90.0)
    assert ptu["SnapshotDate"] == date(2026, 5, 9)
    assert ptu["DeploymentId"] == "ptu" and ptu["ResourceId"] == RID.lower()
    assert rows[("deleted", "2026-04-30")]["ModelName"] == ""  # telemetry kept after deletion
    assert ("ptu", "2026-04-30") not in rows  # past months only list deployments with telemetry
    assert any("malformed deployment" in w for w in warnings)


def test_failed_metric_errors_are_logged_not_raised(impl):
    warnings, acc = [], {}
    plan = impl["health_metric_requests"](DEFINITIONS)[1]
    payload = {"value": [{"name": {"value": "TimeToLastByte"}, "errorCode": "Throttled"},
                         {"name": "malformed"}, None and {}]}
    impl["health_accumulate"](acc, payload, plan, RID, START, END, warnings, "Acc")
    impl["health_accumulate"](acc, None, plan, RID, START, END, warnings, "Acc")
    assert acc == {} and warnings == ["Acc: TimeToLastByte returned Throttled; skipped"]


class FakeClient:
    """Fails every batched metric call and the reconciliation cost query; everything else works."""

    def __init__(self):
        self.metric_urls = []

    def pages(self, url, body=None):
        if "/providers/microsoft.insights/metrics" in url:
            self.metric_urls.append(url)
            if "ProvisionedUtilization%2CTimeToLastByte" in url:
                raise CSV_MODULE.CollectionError("batched call failed")
            if "TimeToLastByte" in url:
                raise CSV_MODULE.CollectionError("latency unavailable")
            payload = REQUESTS if "ModelRequests" in url else QUALITY
            yield {"value": [m for m in payload["value"] if f"metricnames={m['name']['value']}&" in url]}
            return
        grouping = [g["name"] for g in body["dataset"]["grouping"]]
        if "ResourceGuid" in grouping:
            raise CSV_MODULE.CollectionError("throttled")
        yield {"properties": {"columns": [{"name": n} for n in ["Cost", "UsageQuantity", "UsageDate",
                                                                    *grouping, "Currency"]],
                              "rows": [[3.0, 1.0, 20260402, RID, "Foundry Models", "USD"]]}}

    def request(self, method, url, body=None):
        return {"displayName": "Sub"}


def test_csv_details_survive_failed_calls(capsys):
    client = FakeClient()
    context = {"accounts": [{"id": RID, "name": "Acc", "location": "swedencentral"}],
               "resources": [{"id": RID, "tags": {"Department": "Finance"}}],
               "spend": [], "points": [],
               "deployments": {RID.lower(): DEPLOYMENTS}, "definitions": {RID.lower(): DEFINITIONS}}
    datasets = CSV_MODULE.collect_details(client, "s", START, END, context)
    assert set(datasets) == {"AzureDeploymentHealth.csv", "AzureSolutionSpend.csv"}
    rows = {(r["DeploymentName"], str(r["MetricDate"])): r for r in datasets["AzureDeploymentHealth.csv"][1]}
    assert rows[("ptu", "2026-05-31")]["MeanUtilizationPct"] == 50.0  # single-metric retry succeeded
    assert rows[("chat", "2026-04-30")]["MeanLatencyMs"] is None
    solution = datasets["AzureSolutionSpend.csv"][1]
    assert solution[0]["ActualCost"] == 3.0 and solution[0]["AmortizedCost"] == 3.0
    assert solution[0]["DepartmentTag"] == "Finance" and solution[0]["SubscriptionName"] == "Sub"
    err = capsys.readouterr().err
    assert "latency unavailable" in err and "AzureBillingReconciliation.csv not refreshed" in err


def test_csv_publish_accepts_detail_rows(tmp_path):
    rows, _ = _health(vars(CSV_MODULE))
    CSV_MODULE.publish(tmp_path, {"AzureDeploymentHealth.csv": (CSV_MODULE.HEALTH_HEADERS, list(rows.values()))})
    with (tmp_path / "AzureDeploymentHealth.csv").open(encoding="utf-8", newline="") as handle:
        written = list(csv.DictReader(handle))
    assert written[0]["MetricDate"] == "2026-04-30" and written[0]["PtuCapacity"] == ""


@pytest.mark.parametrize("meter, expected", [
    ("5 mini pp Inp Gl 1M Tokens", ("input", 1.0)),
    ("gpt 4o 0806 Outp glbl 1K Tokens", ("output", 0.001)),
    ("4o cchd Inp regnl 1M Tokens", ("cached", 1.0)),
    ("gpt 4.1 Inp glbl Tokens", ("input", 0.001)),
    ("o3 mini 0131 Batch Outp Data Zone Tokens", ("output", 0.001)),
    ("Provisioned Managed Unit", None),
    ("", None),
])
def test_token_meter(impl, meter, expected):
    assert impl["token_meter"](meter) == expected


def test_solution_rows_attach_usage_once_and_label_pricing(impl):
    kv = "/subscriptions/s/resourceGroups/RG1/providers/Microsoft.KeyVault/vaults/kv"
    actual = [{"UsageDate": 20260402, "ResourceId": RID, "ServiceName": "Foundry Models", "Cost": 3.0, "Currency": "USD"},
              {"UsageDate": 20260402, "ResourceId": RID, "ServiceName": "Foundry Tools", "Cost": 0.5, "Currency": "USD"},
              {"UsageDate": 20260402, "ResourceId": kv, "ServiceName": "Key Vault", "Cost": 0.1, "Currency": "USD"}]
    amortized = [dict(r, Cost=r["Cost"] / 2) for r in actual]
    meters = [
        {"UsageDate": "2026-04-02", "ServiceName": "Foundry Models", "Meter": "5 mini pp Inp Gl 1M Tokens",
         "ResourceId": RID.lower(), "Cost": 1.0, "UsageQuantity": 2.0, "Currency": "USD"},
        {"UsageDate": "2026-04-02", "ServiceName": "Foundry Models", "Meter": "5 mini pp Outp Gl 1M Tokens",
         "ResourceId": RID.lower(), "Cost": 1.5, "UsageQuantity": 0.5, "Currency": "USD"},
        {"UsageDate": "2026-04-02", "ServiceName": "Foundry Models", "Meter": "Provisioned Managed Unit",
         "ResourceId": RID.lower(), "Cost": 0.5, "UsageQuantity": 1, "Currency": "USD"}]
    points = [{"Date": "2026-04-02", "ResourceName": "Acc", "ResourceGroup": "RG1", "Metric": "InputTokens", "Value": 2.5e6},
              {"Date": "2026-04-02", "ResourceName": "Acc", "ResourceGroup": "RG1", "Metric": "ModelRequests", "Value": 40},
              {"Date": "2026-04-03", "ResourceName": "Acc", "ResourceGroup": "RG1", "Metric": "OutputTokens", "Value": 1e6},
              {"Date": "2026-04-04", "ResourceName": "Acc", "ResourceGroup": "RG1", "Metric": "InputTokens", "Value": 0}]
    usage = impl["monitor_usage"](points, [{"id": RID, "name": "Acc"}])
    resources = {kv.lower(): {"tags": {"Project": "X"}, "department": ""}}
    warnings = []
    rows = impl["solution_rows"](actual, amortized, meters, usage, resources, "sub-id", "Sub", warnings)
    by = {(str(r["UsageDate"]), r["ServiceName"]): r for r in rows}
    model = by[("2026-04-02", "Foundry Models")]
    assert (model["ServiceCategory"], model["PricingModel"]) == ("Model", "PAYG + Provisioned")
    assert (model["TotalTokensM"], model["Requests"], model["PaygTokensM"]) == (2.5, 40.0, 2.5)
    assert (model["InputPaygCost"], model["OutputPaygCost"], model["CachedPaygCost"]) == (1.0, 1.5, None)
    assert (model["ActualCost"], model["AmortizedCost"], model["AllocationStatus"]) == (3.0, 1.5, "Untagged")
    tools = by[("2026-04-02", "Foundry Tools")]
    assert tools["ServiceCategory"] == "AI service" and tools["Requests"] is None
    assert by[("2026-04-02", "Key Vault")]["ServiceCategory"] == "Supporting"
    assert by[("2026-04-02", "Key Vault")]["Application"] == "X"
    assert by[("2026-04-03", "Foundry Models")]["ActualCost"] == 0.0  # usage-only day, single currency
    assert not any(str(r["UsageDate"]) == "2026-04-04" for r in rows)  # Monitor's zero for a quiet day
    assert sum(r["Requests"] or 0 for r in rows) == 40.0
    assert {r["Currency"] for r in rows} == {"USD"} and not warnings
    assert all(r["SpeechHours"] is None and r["BillingScope"] == "Subscription: Sub" for r in rows)


def test_retail_price_map_prefers_base_tier_in_primary_region(impl):
    items = [
        {"type": "Consumption", "meterId": "AAAA", "retailPrice": 0.25, "currencyCode": "USD",
         "tierMinimumUnits": 0, "isPrimaryMeterRegion": False},
        {"type": "Consumption", "meterId": "aaaa", "retailPrice": 0.20, "currencyCode": "USD",
         "tierMinimumUnits": 0, "isPrimaryMeterRegion": True},
        {"type": "Consumption", "meterId": "aaaa", "retailPrice": 0.10, "currencyCode": "USD",
         "tierMinimumUnits": 1000, "isPrimaryMeterRegion": True},
        {"type": "Reservation", "meterId": "bbbb", "retailPrice": 100},
        {"type": "Consumption", "meterId": "cccc", "retailPrice": "bad"},
    ]
    assert {k: v["price"] for k, v in impl["retail_price_map"](items).items()} == {"aaaa": 0.20}


def test_recon_rows_statuses_and_pools(impl):
    prices = {"aaaa": {"price": 0.2, "unit": "1M", "meterName": "5 mini Inp 1M Tokens", "productName": "Azure OpenAI", "currency": "USD"},
              "cccc": {"price": 1.0, "unit": "1 Hour", "meterName": "Provisioned Managed Unit", "productName": "Azure OpenAI", "currency": "USD"}}
    costs = [{"UsageDate": 20260402, "ResourceGuid": "AAAA", "ServiceName": "Foundry Models", "Cost": 0.41, "UsageQuantity": 2.0, "Currency": "USD"},
             {"UsageDate": 20260403, "ResourceGuid": "cccc", "ServiceName": "Foundry Models", "Cost": 10.0, "UsageQuantity": 10, "Currency": "USD"},
             {"UsageDate": 20260502, "ResourceGuid": "dddd", "ServiceName": "Azure AI Search", "Cost": 5, "UsageQuantity": 1, "Currency": "USD"},
             {"UsageDate": 20260503, "ResourceGuid": "aaaa", "ServiceName": "Foundry Models", "Cost": 0.3, "UsageQuantity": 1.0, "Currency": "USD"},
             {"UsageDate": 20260504, "ResourceGuid": "eeee", "ServiceName": "Foundry Models", "Cost": 0.7, "UsageQuantity": 1.0, "Currency": "USD"}]
    rows = impl["recon_rows"](costs, prices, START, END)
    by = {(r["Period"], r["Product"], r["PoolName"], r["Representation"]): r for r in rows}
    assert len(rows) == 2 * 4
    payg = by[("2026-04", "Foundry Models", "Foundry PAYG Pool", "UsageEstimate")]
    assert (payg["Amount"], payg["Status"]) == (0.4, "Variance within tolerance")
    assert by[("2026-04", "Foundry Models", "Foundry Provisioned Pool", "AzureActual")]["Status"] == "Reconciled"
    unpriced = by[("2026-05", "Azure AI Search", "Foundry PAYG Pool", "UsageEstimate")]
    assert (unpriced["Amount"], unpriced["Status"]) == (None, "Unpriced")
    # Unpriced meters are excluded from the variance and called out instead.
    mixed = by[("2026-05", "Foundry Models", "Foundry PAYG Pool", "UsageEstimate")]
    assert mixed["Status"] == "Unexplained variance" and "1 meter(s) had no retail price" in mixed["Notes"]
    assert by[("2026-05", "Foundry Models", "Foundry PAYG Pool", "AzureActual")]["Amount"] == 1.0
    assert {(r["PeriodStart"], r["PeriodEnd"]) for r in rows if r["Period"] == "2026-05"} == {(date(2026, 5, 1), date(2026, 5, 9))}
    assert {r["Representation"] for r in rows} == {"UsageEstimate", "AzureActual"}


def test_csv_cli_backs_off_longer_when_throttled(monkeypatch):
    class Result:
        def __init__(self, code, stderr="", stdout=""):
            self.returncode, self.stderr, self.stdout = code, stderr, stdout

    results = iter([Result(1, "ERROR: Too Many Requests({\"error\":{\"code\":\"429\"}})"),
                    Result(1, "ERROR: (ServiceUnavailable)"), Result(0, stdout="{\"ok\": 1}")])
    monkeypatch.setattr(CSV_MODULE.subprocess, "run", lambda *a, **k: next(results))
    sleeps = []
    client = CSV_MODULE.AzureCLI(executable="az", sleep=sleeps.append)
    assert client.run(["rest"]) == {"ok": 1}
    assert sleeps == [15, 4]


def test_retail_prices_never_leave_the_public_host():
    with pytest.raises(CSV_MODULE.CollectionError):
        CSV_MODULE.fetch_json("https://management.azure.com/subscriptions")
    pages = iter([{"Items": [{"meterId": "x"}], "NextPageLink": "https://evil.example/next"}])
    seen = []

    def fetch(url):
        seen.append(url)
        if len(seen) > 1:
            return CSV_MODULE.fetch_json(url)
        return next(pages)

    meter = "11111111-1111-1111-1111-111111111111"
    with pytest.raises(CSV_MODULE.CollectionError):
        CSV_MODULE.retail_prices([meter], "USD", fetch)
    assert seen[0].startswith("https://prices.azure.com/api/retail/prices?currencyCode=USD&%24filter=meterId%20eq%20")
    with pytest.raises(ValueError):
        CSV_MODULE.retail_prices(["not-a-uuid'"], "USD", fetch)
    with pytest.raises(CSV_MODULE.CollectionError):
        CSV_MODULE.retail_prices([meter], "usd'", fetch)
