"""Collect Azure AI CSVs using the scheduled runner's existing Azure CLI login.

Examples:
    python pull_azure_ai.py "C:\\Data\\ConsumptionCentral"
    python pull_azure_ai.py "C:\\Data\\ConsumptionCentral" --subscription UUID --days 90

Without --subscription, uses `az account show`'s current subscription. Authenticate
the runner beforehand using managed identity or a certificate-backed service
principal; this program never accepts credentials. Requires cost, resource,
metrics and deployment read permissions. Schedule daily after UTC midnight and
refresh Power BI ONLY after exit code 0. Days are complete UTC days, not today.
All queries and validation precede publication. Each CSV replacement is atomic,
but the replacements are NOT a transaction; serialize runs and readers.
Historical windows replace rather than append; costs can arrive late.

The three core CSVs (spend, tokens, deployments) are strict: any failure exits 1
and publishes nothing. The report's Azure capacity, solution spend and billing
reconciliation CSVs (AzureDeploymentHealth.csv, AzureSolutionSpend.csv,
AzureBillingReconciliation.csv) are best effort: a failed account, metric or
cost call prints a WARNING and is skipped, and a CSV whose source fails entirely
is not replaced. Reconciliation list prices come from the public, unauthenticated
Azure Retail Prices API (prices.azure.com); no credential is ever sent there.
"""

import argparse
import csv
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit
from uuid import UUID, uuid4

ARM = "https://management.azure.com"
API = "2025-03-01"
SERIES_LIMIT = 10000
MAX_PAGES = 10000
AI_SERVICES = ["Foundry Models", "Microsoft Copilot Studio", "Cognitive Services",
               "Azure Machine Learning", "Azure OpenAI"]
TAG_KEYS = ["Department", "department", "CostCentre", "CostCenter",
            "Team", "BusinessUnit", "Owner"]
SPEND_HEADERS = ["UsageDate", "ServiceName", "MeterCategory", "Meter",
                 "ResourceId", "ResourceName", "ResourceGroup", "Cost",
                 "UsageQuantity", "Currency", "DepartmentTag"]
TOKEN_HEADERS = ["Date", "ResourceName", "ResourceGroup", "Deployment", "Metric", "Value"]
DEPLOYMENT_HEADERS = ["ResourceName", "ResourceGroup", "Location", "Deployment",
                      "Model", "ModelVersion", "Sku", "Capacity"]
METRIC_FAMILIES = [
    ("InputTokens", "ProcessedPromptTokens"),
    ("OutputTokens", "GeneratedTokens"),
    ("ModelRequests", "AzureOpenAIRequests", "TotalCalls"),
    ("ProvisionedUtilization", "AzureOpenAIProvisionedManagedUtilizationV2"),
]
UTILIZATION = set(METRIC_FAMILIES[-1])


class CollectionError(RuntimeError):
    """Collection is incomplete; existing output must not be published over."""


def arm_url(url):
    if not isinstance(url, str):
        raise CollectionError("Invalid ARM URL")
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc.lower() != "management.azure.com"
            or parsed.fragment or "\\" in url or any(ord(c) <= 32 for c in url)):
        raise CollectionError("Request/continuation must use HTTPS on management.azure.com")
    return url


def endpoint(path, **params):
    return arm_url(ARM + path) + "?" + urlencode(params)


class AzureCLI:
    def __init__(self, executable=None, sleep=time.sleep):
        self.executable = executable
        self.sleep = sleep

    def command(self):
        executable = self.executable or shutil.which("az")
        if not executable:
            raise CollectionError("Azure CLI not found; install it and authenticate the runner first")
        path = Path(executable)
        # Never pass JSON, filters or URLs through cmd.exe / shell=True.
        # Official Windows Azure CLI installs bundle Python beside wbin.
        if path.suffix.lower() in (".cmd", ".bat"):
            for python in (path.parent.parent / "python.exe", path.parent / "python.exe"):
                if python.is_file():
                    return [str(python), "-IBm", "azure.cli"]
            raise CollectionError("Cannot safely launch Azure CLI batch wrapper: "
                                  "use the official Windows CLI with bundled python.exe")
        return [str(path)]

    def run(self, args, allow_empty=False):
        command = self.command() + args + ["--only-show-errors", "--output", "json"]
        for attempt in range(4):
            try:
                result = subprocess.run(command, shell=False, capture_output=True,
                                        text=True, timeout=180)
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise CollectionError(f"Azure CLI execution failed: {type(exc).__name__}") from exc
            if result.returncode == 0:
                if not result.stdout.strip():
                    if allow_empty:
                        return None  # Cost Query can return HTTP 204.
                    raise CollectionError("Azure CLI returned empty output")
                try:
                    payload = json.loads(result.stdout)
                except (ValueError, TypeError) as exc:
                    raise CollectionError("Azure CLI returned invalid JSON") from exc
                if isinstance(payload, dict) and payload.get("error"):
                    raise CollectionError("Azure returned an error payload")
                return payload
            error = result.stderr or ""
            # CLI does not reliably expose Retry-After. Only recognized transient
            # HTTP failures get bounded exponential backoff: 2, 4, 8 seconds, or
            # 15, 30, 60 for throttling, since Cost Management's per-scope quota
            # asks for about 20 seconds after a burst of queries.
            transient = re.search(
                r"\b(?:429|500|502|503|504|TooManyRequests|ServiceUnavailable|"
                r"GatewayTimeout|InternalServerError|BadGateway)\b", error, re.I)
            if not transient or attempt == 3:
                # Avoid dumping CLI diagnostics that might contain auth details.
                raise CollectionError(f"Azure CLI {args[0]} failed (exit {result.returncode}); "
                                      "check runner login, read permissions and Azure availability")
            throttled = re.search(r"\b(?:429|TooManyRequests|Too Many Requests)\b", error, re.I)
            self.sleep(15 * 2 ** attempt if throttled else 2 ** (attempt + 1))
        raise CollectionError("Azure CLI retry limit exceeded")

    def request(self, method, url, body=None):
        args = ["rest", "--method", method, "--uri", arm_url(url)]
        if body is not None:
            args += ["--headers", "Content-Type=application/json",
                     "--body", json.dumps(body, allow_nan=False)]
        allow_empty = (method.upper() == "POST" and body is not None
                       and urlsplit(url).path.lower().endswith("/providers/microsoft.costmanagement/query"))
        return self.run(args, allow_empty=allow_empty)

    def pages(self, url, body=None):
        seen = set()
        while url:
            arm_url(url)
            if url in seen or len(seen) >= MAX_PAGES:
                raise CollectionError("Repeated or excessive ARM continuation pages")
            seen.add(url)
            page = self.request("POST" if body is not None else "GET", url, body)
            if page is None and body is not None and len(seen) == 1:
                return
            if not isinstance(page, dict) or page.get("error"):
                raise CollectionError("Missing or invalid ARM response page")
            yield page
            props = page.get("properties", {})
            url = props.get("nextLink") or page.get("nextLink")

    def list(self, url):
        items = []
        for page in self.pages(url):
            if not isinstance(page.get("value"), list):
                raise CollectionError("ARM list response is missing value array")
            items.extend(page["value"])
        return items


def finite_number(value):
    if value is None or isinstance(value, bool):
        raise CollectionError("Missing/invalid numeric value")
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise CollectionError("Invalid numeric value") from exc
    if not math.isfinite(number):
        raise CollectionError("Non-finite numeric value")
    return number


def resource_group(rid):
    parts = rid.split("/")
    lower = [p.lower() for p in parts]
    if "resourcegroups" in lower:
        i = lower.index("resourcegroups")
        if i + 1 < len(parts):
            return parts[i + 1]
    return ""


def cost_date(value):
    raw = str(value)
    pattern = "%Y%m%d" if re.fullmatch(r"\d{8}", raw) else "%Y-%m-%d"
    try:
        return datetime.strptime(raw, pattern).date()
    except ValueError as exc:
        raise CollectionError("Invalid cost UsageDate") from exc


def dimension_filter(name, values):
    return {"dimensions": {"name": name, "operator": "In", "values": values}}


def cost_query(client, subscription, start, end, grouping, extra_filter=None,
               cost_type="ActualCost"):
    if not 1 <= len(grouping) <= 2 or len(set(grouping)) != len(grouping):
        raise CollectionError("Cost Management supports at most two distinct groupings")
    if cost_type not in ("ActualCost", "AmortizedCost"):
        raise CollectionError("Unsupported cost type")
    body = {
        "type": cost_type, "timeframe": "Custom",
        "timePeriod": {"from": f"{start}T00:00:00Z",
                       "to": f"{end - timedelta(days=1)}T23:59:59Z"},
        "dataset": {
            "granularity": "Daily",
            "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"},
                            "totalQty": {"name": "UsageQuantity", "function": "Sum"}},
            "grouping": [{"type": "Dimension", "name": g} for g in grouping],
        },
    }
    if extra_filter:
        body["dataset"]["filter"] = extra_filter
    rows = []
    url = endpoint(f"/subscriptions/{subscription}/providers/Microsoft.CostManagement/query",
                   **{"api-version": API})
    for response in client.pages(url, body):
        page = response["properties"]
        columns = [c["name"] for c in page["columns"]]
        if len(set(columns)) != len(columns):
            raise CollectionError("Duplicate cost columns")
        if any(c not in columns for c in grouping + ["UsageDate", "Currency"]):
            raise CollectionError("Cost response missing required columns")
        for values in page["rows"]:
            if len(values) != len(columns):
                raise CollectionError("Cost row does not match page columns")
            row = dict(zip(columns, values))
            for target, aliases in (("Cost", ("Cost", "totalCost", "PreTaxCost")),
                                    ("UsageQuantity", ("UsageQuantity", "totalQty"))):
                found = [a for a in aliases if a in row]
                if not found:
                    raise CollectionError(f"Missing cost aggregation {target}")
                numbers = [finite_number(row[a]) for a in found]
                if any(n != numbers[0] for n in numbers):
                    raise CollectionError(f"Conflicting cost aggregation {target}")
                row[target] = numbers[0]
            day = cost_date(row["UsageDate"])
            if not start <= day < end:
                raise CollectionError("Cost date outside complete UTC window")
            if not isinstance(row["Currency"], str) or not row["Currency"].strip():
                raise CollectionError("Cost currency missing; cannot safely combine currencies")
            rows.append(row)
    return rows


def collect_spend(client, subscription, start, end, resources):
    summary = cost_query(client, subscription, start, end,
                         ["ServiceName", "MeterCategory"],
                         dimension_filter("ServiceName", AI_SERVICES))
    pairs = {(r["ServiceName"], r["MeterCategory"]) for r in summary}
    if any(not service or not category for service, category in pairs):
        raise CollectionError("Blank service/category cannot be safely partitioned")
    tags = {}
    for res in resources:
        rid = res["id"].lower()
        if rid in tags:
            raise CollectionError("Duplicate resource inventory ID")
        tag = {k.lower(): v for k, v in (res.get("tags") or {}).items()}
        tags[rid] = next((tag[k.lower()] for k in TAG_KEYS if k.lower() in tag), "")
    result, seen = [], set()
    for service, category in sorted(pairs):
        filt = {"and": [dimension_filter("ServiceName", [service]),
                        dimension_filter("MeterCategory", [category])]}
        details = cost_query(client, subscription, start, end,
                             ["Meter", "ResourceId"], filt)
        if not details:
            raise CollectionError("Empty cost details for discovered service/category; retry later")
        for row in details:
            resource_id = row["ResourceId"] or ""
            rid = resource_id.lower()
            day = cost_date(row["UsageDate"]).isoformat()
            key = (day, service, category, row["Meter"], rid, row["Currency"])
            if key in seen:
                raise CollectionError("Duplicate cost grain; refusing to double count")
            seen.add(key)
            result.append(dict(zip(SPEND_HEADERS, [
                day, service, category, row["Meter"], rid, resource_id.split("/")[-1],
                resource_group(resource_id), row["Cost"], row["UsageQuantity"], row["Currency"],
                tags.get(rid, ""),
            ])))
    return result


def select_metrics(definitions, account_kind=None):
    available = {}
    for definition in definitions:
        name = definition["name"]["value"]
        if name in available:
            raise CollectionError(f"Duplicate metric definition: {name}")
        available[name] = definition
    selected = [next((n for n in family if n in available), None)
                for family in METRIC_FAMILIES]
    if account_kind == "OpenAI" and selected[2] == "TotalCalls":
        selected[2] = None
        print("WARNING: TotalCalls is not a model-request counter for this OpenAI account.",
              file=sys.stderr)
    if not any(selected[:2]) and "TotalTokens" in available:
        selected.append("TotalTokens")
        print("WARNING: only TotalTokens is available; shipped DAX Total Tokens uses "
              "prompt + output and will NOT use this fallback.", file=sys.stderr)
    elif bool(selected[0]) != bool(selected[1]):
        print("WARNING: only one token component is available; shipped DAX token totals "
              "are incomplete.", file=sys.stderr)
    return [(name, available[name]) for name in selected if name]


def metric_parameters(name, definition, start, end):
    aggregation = "Average" if name in UTILIZATION else "Total"
    supported = definition.get("supportedAggregationTypes") or [
        definition.get("primaryAggregationType", "")]
    if aggregation.lower() not in {s.lower() for s in supported}:
        raise CollectionError(f"{name} does not support {aggregation}")
    dimensions = [d["value"] for d in definition.get("dimensions", [])]
    deployment = next((d for candidate in ("modeldeploymentname", "deploymentname", "deployment")
                       for d in dimensions if d.lower() == candidate), None)
    params = {
        "api-version": "2023-10-01", "metricnames": name, "aggregation": aggregation,
        "interval": "P1D", "timespan": f"{start}T00:00:00Z/{end}T00:00:00Z",
        "AutoAdjustTimegrain": "false", "ValidateDimensions": "true",
    }
    if definition.get("namespace"):
        params["metricnamespace"] = definition["namespace"]
    if deployment:
        # Only deployment is wildcarded. Omitted dimensions aggregate on the
        # server; never average averages or add dimension slices client-side.
        params.update({"$filter": f"{deployment} eq '*'", "top": SERIES_LIMIT})
    return params, deployment, aggregation.lower()


def metric_points(payload, name, deployment_dimension, field, account, start, end):
    if payload.get("error"):
        raise CollectionError("Azure Monitor returned an error")
    metrics = payload["value"]
    if len(metrics) != 1 or metrics[0]["name"]["value"] != name:
        raise CollectionError(f"Azure Monitor omitted/changed {name}")
    metric = metrics[0]
    if metric.get("errorCode") not in (None, "Success", "0", 0):
        raise CollectionError(f"Azure Monitor metric error for {name}")
    if payload.get("interval") != "P1D":
        raise CollectionError("Expected daily metrics; refusing to reaggregate")
    series = metric["timeseries"]
    if len(series) >= SERIES_LIMIT:
        raise CollectionError("Metric series limit reached; results may be truncated")
    rows, seen_series, seen_points = [], set(), set()
    for item in series:
        metadata = {}
        for m in item.get("metadatavalues", []):
            key = m["name"]["value"].lower()
            if key in metadata:
                raise CollectionError("Duplicate metric dimension metadata")
            metadata[key] = m["value"]
        expected = deployment_dimension.lower() if deployment_dimension else None
        if any(k != expected and v not in ("", None) for k, v in metadata.items()):
            raise CollectionError("Unexpected dimension split")
        if expected and expected not in metadata:
            raise CollectionError("Missing advertised deployment metadata")
        deployment = metadata.get(expected, "") or ""
        if deployment == "*" or deployment in seen_series:
            raise CollectionError("Duplicate or rolled-up deployment series")
        seen_series.add(deployment)
        for point in item["data"]:
            stamp = datetime.fromisoformat(point["timeStamp"].replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                raise CollectionError("Metric timestamp requires timezone")
            stamp = stamp.astimezone(timezone.utc)
            day = stamp.date()
            midnight = (stamp.hour, stamp.minute, stamp.second, stamp.microsecond) == (0, 0, 0, 0)
            if day == end and midnight:
                continue
            if not start <= day < end or not midnight:
                raise CollectionError("Metric timestamp outside daily UTC window")
            key = (day, deployment)
            if key in seen_points:
                raise CollectionError("Duplicate daily metric point")
            seen_points.add(key)
            if field not in point and any(k in point for k in
                                         ("total", "average", "count", "minimum", "maximum")):
                raise CollectionError(f"Missing requested {field} aggregation")
            value = point.get(field)
            if value is None:
                continue
            rid = account["id"]
            rows.append(dict(zip(TOKEN_HEADERS, [
                day.isoformat(), account.get("name") or rid.split("/")[-1], resource_group(rid),
                deployment, name, finite_number(value),
            ])))
    return rows


# --- Shared with the Fabric notebook Ingest_Azure_AI.ipynb (section 4); keep identical. ---
HEALTH_HEADERS = ["SnapshotDate", "MetricDate", "SubscriptionName", "SubscriptionId",
                  "ResourceId", "DeploymentId", "DeploymentName", "Application", "ModelName",
                  "ModelVersion", "SkuName", "Region", "PtuCapacity", "MeanUtilizationPct",
                  "PeakUtilizationPct", "Requests", "ServerErrors5xx", "Throttles429",
                  "MeanLatencyMs"]
RECON_HEADERS = ["Period", "PeriodStart", "PeriodEnd", "Product", "PoolName", "Representation",
                 "Amount", "Currency", "Status", "EvidenceType", "Notes"]
SOLUTION_HEADERS = ["UsageDate", "SubscriptionName", "SubscriptionId", "ResourceId",
                    "ResourceName", "ResourceGroup", "Application", "DepartmentTag",
                    "ServiceName", "ServiceCategory", "ActualCost", "AmortizedCost", "Currency",
                    "TotalTokensM", "PaygTokensM", "InputPaygCost", "OutputPaygCost",
                    "CachedPaygCost", "Requests", "SpeechHours", "DocumentPages", "Images",
                    "AllocationStatus", "PricingModel", "BillingScope"]
APPLICATION_TAG_KEYS = ["Application", "App", "Solution", "Workload", "Project"]
HEALTH_REQUEST_METRICS = ("ModelRequests", "AzureOpenAIRequests")
HEALTH_UTILIZATION_METRICS = ("ProvisionedUtilization", "AzureOpenAIProvisionedManagedUtilizationV2")
HEALTH_LATENCY_METRICS = ("TimeToLastByte", "AzureOpenAITTLTInMS",
                          "TimeToResponse", "AzureOpenAITimeToResponse")
TOKEN_METRICS = {"inputtokens", "processedprompttokens", "outputtokens", "generatedtokens",
                 "totaltokens"}
REQUEST_METRICS = {"modelrequests", "azureopenairequests", "totalcalls"}
# Cost Management service names. Copilot Studio pay-as-you-go is deliberately excluded:
# it has its own table and is not Foundry spend.
SOLUTION_AI_SERVICES = ["Foundry Models", "Azure OpenAI", "Cognitive Services", "Foundry Tools",
                        "Azure Machine Learning", "Azure AI Search", "Azure Cognitive Search"]
MODEL_SERVICES = {"foundry models", "azure openai"}
PAYG_POOL = "Foundry PAYG Pool"
PROVISIONED_POOL = "Foundry Provisioned Pool"
RECON_TOLERANCES = ((0.01, "Reconciled"), (0.05, "Variance within tolerance"))


def as_number(value):
    """Finite float, or None for anything missing or invalid. Never raises."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def as_day(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    raw = str(value or "")
    for pattern in ("%Y%m%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw[:10] if "-" in raw else raw, pattern).date()
        except ValueError:
            continue
    return None


def tag_value(tags, keys):
    lowered = {str(k).lower(): v for k, v in (tags or {}).items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value not in (None, ""):
            return str(value)
    return ""


def month_end(day):
    following = (day.replace(day=28) + timedelta(days=4)).replace(day=1)
    return following - timedelta(days=1)


def metric_windows(start, end, days=30):
    windows, first = [], start
    while first < end:
        last = min(first + timedelta(days=days), end)
        windows.append((first, last))
        first = last
    return windows


def is_provisioned(text):
    lowered = str(text or "").lower()
    return "provisioned" in lowered or re.search(r"\bptu\b", lowered) is not None


def deployment_inventory(account, deployments, warnings):
    """One dict per deployment, keyed by lower-case account resource ID."""
    rid = str(account.get("id") or "").lower()
    application = tag_value(account.get("tags"), APPLICATION_TAG_KEYS)
    found = []
    for deployment in deployments or []:
        try:
            name = str(deployment["name"])
            props = deployment.get("properties") or {}
            model = props.get("model") or {}
            sku = deployment.get("sku") or {}
            sku_name = str(sku.get("name") or "")
            found.append({
                "ResourceId": rid,
                "DeploymentName": name,
                "Application": tag_value(deployment.get("tags"), APPLICATION_TAG_KEYS) or application,
                "ModelName": str(model.get("name") or ""),
                "ModelVersion": str(model.get("version") or ""),
                "SkuName": sku_name,
                "Region": str(account.get("location") or ""),
                # Standard/GlobalStandard capacity is a rate limit (K TPM), not PTUs.
                "PtuCapacity": as_number(sku.get("capacity")) if is_provisioned(sku_name) else None,
            })
        except (KeyError, TypeError, AttributeError) as exc:
            warnings.append(f"{rid}: skipped malformed deployment ({type(exc).__name__})")
    return found


def _dimension(definition, names):
    for item in definition.get("dimensions") or []:
        value = item.get("value") if isinstance(item, dict) else None
        if value and value.lower() in names:
            return value
    return None


def _aggregations(definition):
    supported = definition.get("supportedAggregationTypes") or [
        definition.get("primaryAggregationType")]
    return {str(s).lower() for s in supported if s}


def health_metric_requests(definitions):
    """Plan batched Monitor calls: one for requests by status, one for utilisation + latency."""
    available = {}
    for definition in definitions or []:
        try:
            available.setdefault(definition["name"]["value"], definition)
        except (KeyError, TypeError):
            continue
    deployment_names = ("modeldeploymentname", "deploymentname", "deployment")

    def pick(family, needed):
        for name in family:
            definition = available.get(name)
            if not definition or not needed <= _aggregations(definition):
                continue
            dimension = _dimension(definition, deployment_names)
            if dimension:
                return name, definition, dimension
        return None

    plans = []
    found = pick(HEALTH_REQUEST_METRICS, {"total"})
    if found:
        name, definition, dimension = found
        status = _dimension(definition, ("statuscode",))
        plans.append({
            "metricnames": [name], "aggregation": "Total",
            "filter": f"{dimension} eq '*'" + (f" and {status} eq '*'" if status else ""),
            "roles": {name: "requests"}, "deployment": dimension, "status": status,
            "namespace": definition.get("namespace")})
    grouped = {}
    for family, role in ((HEALTH_UTILIZATION_METRICS, "utilization"),
                         (HEALTH_LATENCY_METRICS, "latency")):
        found = pick(family, {"average"})
        if not found:
            continue
        name, definition, dimension = found
        plan = grouped.setdefault((dimension, definition.get("namespace")), {
            "metricnames": [], "maximum": True, "filter": f"{dimension} eq '*'", "roles": {},
            "deployment": dimension, "status": None, "namespace": definition.get("namespace")})
        plan["metricnames"].append(name)
        plan["roles"][name] = role
        plan["maximum"] = plan["maximum"] and "maximum" in _aggregations(definition)
    for plan in grouped.values():
        plan["aggregation"] = "Average,Maximum" if plan.pop("maximum") else "Average"
        plans.append(plan)
    return plans


def health_metric_parameters(plan, names, first, last):
    params = {"api-version": "2023-10-01", "metricnames": ",".join(names),
              "aggregation": plan["aggregation"], "interval": "P1D",
              "timespan": f"{first}T00:00:00Z/{last}T00:00:00Z",
              "AutoAdjustTimegrain": "false", "$filter": plan["filter"], "top": 10000}
    if plan.get("namespace"):
        params["metricnamespace"] = plan["namespace"]
    return params


def health_accumulate(acc, payload, plan, resource_id, first, last, warnings, label):
    """Fold one Monitor response into acc[(resource, deployment, day)]. Skips bad data."""
    rid = str(resource_id).lower()
    deployment_key = plan["deployment"].lower()
    status_key = (plan.get("status") or "").lower()
    for metric in (payload or {}).get("value") or []:
        try:
            name = metric["name"]["value"]
        except (KeyError, TypeError):
            continue
        role = plan["roles"].get(name)
        if role is None:
            continue
        if metric.get("errorCode") not in (None, "Success", "0", 0):
            warnings.append(f"{label}: {name} returned {metric.get('errorCode')}; skipped")
            continue
        for series in metric.get("timeseries") or []:
            meta = {}
            for item in series.get("metadatavalues") or []:
                try:
                    meta[str(item["name"]["value"]).lower()] = item.get("value")
                except (KeyError, TypeError):
                    continue
            deployment = str(meta.get(deployment_key) or "")
            if not deployment or deployment == "*":
                continue
            status = str(meta.get(status_key) or "") if status_key else ""
            for point in series.get("data") or []:
                try:
                    stamp = datetime.fromisoformat(str(point["timeStamp"]).replace("Z", "+00:00"))
                except (KeyError, TypeError, ValueError):
                    continue
                if stamp.tzinfo is not None:
                    stamp = stamp.astimezone(timezone.utc)
                day = stamp.date()
                if not first <= day < last:
                    continue
                slot = acc.setdefault((rid, deployment.lower(), day), {"name": deployment})
                if role == "requests":
                    value = as_number(point.get("total"))
                    if value is None:
                        continue
                    slot["requests"] = slot.get("requests", 0.0) + value
                    if status_key:
                        # The status split proves the zeroes; without it they stay blank.
                        slot["throttles"] = slot.get("throttles", 0.0) + (value if status == "429" else 0.0)
                        slot["errors"] = slot.get("errors", 0.0) + (value if status.startswith("5") else 0.0)
                elif role == "utilization":
                    average, maximum = as_number(point.get("average")), as_number(point.get("maximum"))
                    if average is not None:
                        slot["utilization"] = average
                    if maximum is not None:
                        slot["peak"] = maximum
                elif role == "latency":
                    average = as_number(point.get("average"))
                    if average is not None:
                        slot["latency"] = average


def health_rows(inventory, acc, start, end, subscription_id, subscription_name):
    """One row per deployment per calendar month (MetricDate = month end).

    Past months list deployments that reported telemetry; the current month lists every
    inventoried deployment so blanks read as "No telemetry" instead of disappearing.
    """
    last_day = end - timedelta(days=1)
    current = month_end(last_day)
    months = {}
    for (rid, deployment, day), slot in acc.items():
        if start <= day < end:
            months.setdefault((rid, deployment, month_end(day)), []).append(slot)
    known = {}
    for item in inventory:
        known.setdefault((item["ResourceId"].lower(), item["DeploymentName"].lower()), item)
    keys = set(months) | {(rid, deployment, current) for rid, deployment in known}
    rows = []
    for rid, deployment, metric_date in sorted(keys):
        slots = months.get((rid, deployment, metric_date), [])
        info = known.get((rid, deployment)) or {
            "ResourceId": rid, "DeploymentName": slots[0]["name"] if slots else deployment,
            "Application": "", "ModelName": "", "ModelVersion": "", "SkuName": "", "Region": "",
            "PtuCapacity": None}
        provisioned = is_provisioned(info["SkuName"])

        def total(field):
            values = [s[field] for s in slots if field in s]
            return round(sum(values), 4) if values else None

        utilization = [s["utilization"] for s in slots if "utilization" in s] if provisioned else []
        peaks = [s["peak"] for s in slots if "peak" in s] if provisioned else []
        latency = [(s["latency"], s.get("requests") or 0.0) for s in slots if "latency" in s]
        weight = sum(w for _, w in latency)
        if latency and weight > 0:
            mean_latency = sum(v * w for v, w in latency) / weight
        elif latency:
            mean_latency = sum(v for v, _ in latency) / len(latency)
        else:
            mean_latency = None
        rows.append(dict(zip(HEALTH_HEADERS, [
            min(metric_date, last_day), metric_date, subscription_name, subscription_id, rid,
            info["DeploymentName"], info["DeploymentName"], info["Application"],
            info["ModelName"], info["ModelVersion"], info["SkuName"], info["Region"],
            info["PtuCapacity"],
            round(sum(utilization) / len(utilization), 2) if utilization else None,
            round(max(peaks), 2) if peaks else None,
            total("requests"), total("errors"), total("throttles"),
            round(mean_latency, 2) if mean_latency is not None else None,
        ])))
    return rows


def token_meter(meter):
    """(kind, millions of tokens per billed unit) for a token meter, else None."""
    text = str(meter or "").lower()
    match = re.search(r"(?:\b(\d+(?:\.\d+)?)\s*([km])\s+)?tokens?\b", text)
    if not match:
        return None
    # The retail price sheet bills token meters that name no unit per 1K tokens.
    size, unit = match.group(1) or "1", match.group(2) or "k"
    millions = float(size) * (0.001 if unit == "k" else 1.0)
    words = set(re.findall(r"[a-z0-9]+", text))
    if words & {"cchd", "cached", "cache", "cd"}:
        kind = "cached"
    elif words & {"outp", "output", "opt", "outpt", "out"}:
        kind = "output"
    else:
        kind = "input"
    return kind, millions


def service_category(service):
    lowered = str(service or "").lower()
    if lowered in MODEL_SERVICES:
        return "Model"
    if lowered in {s.lower() for s in SOLUTION_AI_SERVICES}:
        return "AI service"
    return "Supporting"


def monitor_usage(points, accounts):
    """(day, account id) -> tokens (millions) and requests, from the Monitor token table."""
    ids = {(str(a.get("name") or "").lower(), resource_group(str(a.get("id") or "")).lower()):
           str(a.get("id") or "").lower() for a in accounts}
    usage = {}
    for point in points:
        rid = ids.get((str(point.get("ResourceName") or "").lower(),
                       str(point.get("ResourceGroup") or "").lower()))
        day, value = as_day(point.get("Date")), as_number(point.get("Value"))
        metric = str(point.get("Metric") or "").lower()
        # Monitor returns a zero for every quiet day; only real usage gets a row.
        if not rid or day is None or not value:
            continue
        if metric in TOKEN_METRICS:
            key, value = "tokens", value / 1e6
        elif metric in REQUEST_METRICS:
            key = "requests"
        else:
            continue
        slot = usage.setdefault((day, rid), {})
        slot[key] = slot.get(key, 0.0) + value
    return usage


def solution_rows(actual, amortized, meters, usage, resources, subscription_id,
                  subscription_name, warnings):
    """Daily AI-solution spend by resource and service, plus PAYG token detail and usage."""
    rows, names = {}, {}
    for field, source in (("ActualCost", actual), ("AmortizedCost", amortized)):
        for record in source:
            day, cost = as_day(record.get("UsageDate")), as_number(record.get("Cost"))
            resource_id = str(record.get("ResourceId") or "")
            currency = str(record.get("Currency") or "").strip()
            if day is None or cost is None or not resource_id or not currency:
                continue
            rid = resource_id.lower()
            names.setdefault(rid, resource_id)
            key = (day, rid, str(record.get("ServiceName") or ""), currency)
            row = rows.setdefault(key, {"ActualCost": 0.0, "AmortizedCost": 0.0})
            row[field] += cost
    detail = {}
    for record in meters:
        service = str(record.get("ServiceName") or "")
        day, cost = as_day(record.get("UsageDate")), as_number(record.get("Cost"))
        resource_id = str(record.get("ResourceId") or "")
        if day is None or cost is None or not resource_id or service_category(service) != "Model":
            continue
        key = (day, resource_id.lower(), service, str(record.get("Currency") or "").strip())
        slot = detail.setdefault(key, {"payg": False, "provisioned": False})
        token = token_meter(record.get("Meter"))
        if token:
            kind, millions = token
            slot["payg"] = True
            slot[kind] = slot.get(kind, 0.0) + cost
            quantity = as_number(record.get("UsageQuantity"))
            if quantity is not None:
                slot["tokens"] = slot.get("tokens", 0.0) + quantity * millions
        elif is_provisioned(record.get("Meter")):
            slot["provisioned"] = True
    currencies = {key[3] for key in rows}
    # Attach Monitor usage to exactly one row per resource-day, or the sums double count.
    owners = {}
    for key in sorted(rows, key=lambda k: (service_category(k[2]) != "Model", k)):
        owners.setdefault((key[0], key[1]), key)
    for day_rid, values in usage.items():
        if day_rid in owners or not values:
            continue
        if len(currencies) != 1:
            warnings.append("Monitor usage without matching cost rows skipped: currency unknown")
            continue
        key = (day_rid[0], day_rid[1], "Foundry Models", next(iter(currencies)))
        rows[key] = {"ActualCost": 0.0, "AmortizedCost": 0.0}
        owners[day_rid] = key
    owner_of = {key: day_rid for day_rid, key in owners.items()}
    result = []
    for key in sorted(rows):
        day, rid, service, currency = key
        row, resource_id = rows[key], names.get(rid, rid)
        info = resources.get(rid) or {}
        application = tag_value(info.get("tags"), APPLICATION_TAG_KEYS)
        department = str(info.get("department") or "")
        meter = detail.get(key)
        used = usage.get(owner_of[key], {}) if key in owner_of else {}
        if meter and meter["payg"] and meter["provisioned"]:
            pricing = "PAYG + Provisioned"
        elif meter and meter["provisioned"]:
            pricing = "Provisioned"
        else:
            pricing = "PAYG"

        def money(field):
            value = meter.get(field) if meter else None
            return round(value, 6) if value is not None else None

        result.append(dict(zip(SOLUTION_HEADERS, [
            day, subscription_name, subscription_id, rid, resource_id.split("/")[-1],
            resource_group(resource_id), application, department, service,
            service_category(service), round(row["ActualCost"], 6), round(row["AmortizedCost"], 6),
            currency,
            round(used["tokens"], 6) if "tokens" in used else None,
            round(meter["tokens"], 6) if meter and "tokens" in meter else None,
            money("input"), money("output"), money("cached"),
            used.get("requests"), None, None, None,
            "Tagged" if application or department else "Untagged", pricing,
            f"Subscription: {subscription_name or subscription_id}",
        ])))
    return result


def retail_price_map(items):
    """meterId -> list-price details, preferring the base tier in the primary region."""
    best = {}
    for item in items:
        if str(item.get("type") or "") != "Consumption":
            continue
        meter_id = str(item.get("meterId") or "").lower()
        price = as_number(item.get("retailPrice"))
        if not meter_id or price is None:
            continue
        rank = ((as_number(item.get("tierMinimumUnits")) or 0.0) != 0.0,
                not item.get("isPrimaryMeterRegion", True))
        if meter_id not in best or rank < best[meter_id][0]:
            best[meter_id] = (rank, {
                "price": price, "unit": str(item.get("unitOfMeasure") or ""),
                "meterName": str(item.get("meterName") or ""),
                "productName": str(item.get("productName") or ""),
                "currency": str(item.get("currencyCode") or "")})
    return {meter_id: value for meter_id, (_, value) in best.items()}


def recon_rows(costs, prices, start, end):
    """Monthly UsageEstimate (metered quantity x retail list price) vs AzureActual."""
    last_day = end - timedelta(days=1)
    groups = {}
    for record in costs:
        day, cost = as_day(record.get("UsageDate")), as_number(record.get("Cost"))
        currency = str(record.get("Currency") or "").strip()
        if day is None or cost is None or not currency or not start <= day < end:
            continue
        meter_id = str(record.get("ResourceGuid") or "").lower()
        price = prices.get(meter_id)
        if price and price["currency"] and price["currency"].upper() != currency.upper():
            price = None
        pool = (PROVISIONED_POOL if price and is_provisioned(
            price["meterName"] + " " + price["productName"]) else PAYG_POOL)
        key = (month_end(day), str(record.get("ServiceName") or ""), pool, currency)
        group = groups.setdefault(key, {"actual": 0.0, "estimate": 0.0, "priced": set(),
                                        "unpriced": set(), "unpriced_cost": 0.0})
        group["actual"] += cost
        quantity = as_number(record.get("UsageQuantity"))
        if price and quantity is not None:
            # Cost Management quantities are in the meter's unit of measure, as is the price.
            group["estimate"] += quantity * price["price"]
            group["priced"].add(meter_id)
        else:
            group["unpriced"].add(meter_id or "(no meter id)")
            group["unpriced_cost"] += cost
    rows = []
    for (period_end, product, pool, currency), group in sorted(groups.items()):
        actual, estimate = round(group["actual"], 2), round(group["estimate"], 2)
        if not group["priced"]:
            status, estimate = "Unpriced", None
        else:
            # Judge only the priced meters; unpriced cost is called out in Notes instead.
            priced_actual = group["actual"] - group["unpriced_cost"]
            variance = abs(group["estimate"] - priced_actual) / max(abs(priced_actual), 0.01)
            status = next((label for limit, label in RECON_TOLERANCES if variance <= limit),
                          "Unexplained variance")
        note = f"Retail list price x metered quantity for {len(group['priced'])} meter(s)."
        if group["unpriced"]:
            note += (f" {len(group['unpriced'])} meter(s) had no retail price"
                     f" ({group['unpriced_cost']:.2f} {currency} of actual cost not estimated).")
        note += " List prices exclude negotiated discounts, credits and reservations."
        period = [period_end.strftime("%Y-%m"), max(period_end.replace(day=1), start),
                  min(period_end, last_day), product, pool]
        rows.append(dict(zip(RECON_HEADERS, period + [
            "UsageEstimate", estimate, currency, status, "Retail Prices API x usage quantity", note])))
        rows.append(dict(zip(RECON_HEADERS, period + [
            "AzureActual", actual, currency, status, "Cost Management query",
            "ActualCost from the Cost Management Query API for the period."])))
    return rows
# --- End of shared block. ---


RETAIL_PRICES = "https://prices.azure.com/api/retail/prices"
RETAIL_BATCH = 15
DETAIL_FAILURES = (CollectionError, KeyError, TypeError, ValueError, AttributeError)


def warn(message):
    print(f"WARNING: {message}", file=sys.stderr)


def flush(found):
    for message in found:
        warn(message)
    found.clear()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch_json(url, sleep=time.sleep):
    """GET JSON from the public Retail Prices API. No credentials, no redirects."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc.lower() != "prices.azure.com" or parsed.fragment:
        raise CollectionError("Retail Prices URL must use HTTPS on prices.azure.com")
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    for attempt in range(4):
        try:
            with opener.open(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503, 504) and attempt < 3:
                sleep(2 ** (attempt + 1))
                continue
            raise CollectionError(f"Retail Prices API returned HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise CollectionError(f"Retail Prices API unavailable ({type(exc).__name__})") from exc
    raise CollectionError("Retail Prices retry limit exceeded")


def retail_prices(meter_ids, currency, fetch=fetch_json):
    if not re.fullmatch(r"[A-Z]{3}", str(currency)):
        raise CollectionError("Unexpected currency code")
    query = {"currencyCode": currency,
             "$filter": " or ".join(f"meterId eq '{UUID(m)}'" for m in meter_ids)}
    url = RETAIL_PRICES + "?" + urlencode(query, quote_via=quote)
    items, seen = [], set()
    while url:
        if url in seen or len(seen) >= 50:
            raise CollectionError("Repeated or excessive Retail Prices pages")
        seen.add(url)
        page = fetch(url)
        if not isinstance(page, dict) or not isinstance(page.get("Items", []), list):
            raise CollectionError("Invalid Retail Prices response")
        items.extend(page.get("Items") or [])
        url = page.get("NextPageLink")
    return items


def department_tags(resources):
    found = {}
    for res in resources:
        tag = {str(k).lower(): v for k, v in (res.get("tags") or {}).items()}
        found[res["id"].lower()] = next((tag[k.lower()] for k in TAG_KEYS if k.lower() in tag), "")
    return found


def collect_health(client, subscription, subscription_name, start, end, accounts,
                   deployments, definitions):
    inventory, acc, found = [], {}, []
    calls = failures = 0
    for account in accounts:
        rid = account["id"]
        label = account.get("name") or rid.split("/")[-1]
        items = deployments.get(rid.lower()) or []
        inventory.extend(deployment_inventory(account, items, found))
        flush(found)
        if not items:
            continue
        plans = health_metric_requests(definitions.get(rid.lower()))
        if not plans:
            warn(f"{label}: no per-deployment request, utilisation or latency metrics advertised")
        for plan in plans:
            for first, last in metric_windows(start, end):
                # One batched call per plan and window; if it fails, retry its metrics one by one.
                batches = [plan["metricnames"]]
                while batches:
                    names = batches.pop()
                    calls += 1
                    try:
                        url = endpoint(rid + "/providers/microsoft.insights/metrics",
                                       **health_metric_parameters(plan, names, first, last))
                        for payload in client.pages(url):
                            health_accumulate(acc, payload, plan, rid, first, last, found, label)
                    except DETAIL_FAILURES as exc:
                        failures += 1
                        warn(f"{label}: {','.join(names)} {first}..{last} failed ({exc})")
                        if len(names) > 1:
                            batches.extend([name] for name in names)
                    flush(found)
    print(f"Deployment health: {len(inventory)} deployments; "
          f"{calls - failures}/{calls} metric calls succeeded")
    return health_rows(inventory, acc, start, end, subscription, subscription_name)


def collect_solution(client, subscription, subscription_name, start, end, accounts,
                     resources, spend, points):
    service_filter = dimension_filter("ServiceName", SOLUTION_AI_SERVICES)
    groups = sorted({resource_group(a["id"]) for a in accounts} - {""})
    # Supporting services are the non-AI resources that share a resource group with an AI account.
    solution_filter = ({"or": [service_filter, dimension_filter("ResourceGroupName", groups)]}
                       if groups else service_filter)
    grouping = ["ResourceId", "ServiceName"]
    actual = cost_query(client, subscription, start, end, grouping, solution_filter, "ActualCost")
    amortized = cost_query(client, subscription, start, end, grouping, solution_filter,
                           "AmortizedCost")
    departments = department_tags(resources)
    known = {r["id"].lower(): {"tags": r.get("tags"), "department": departments[r["id"].lower()]}
             for r in resources}
    found = []
    rows = solution_rows(actual, amortized, spend, monitor_usage(points, accounts), known,
                         subscription, subscription_name, found)
    flush(found)
    return rows


def collect_recon(client, subscription, start, end, fetch=fetch_json):
    costs = cost_query(client, subscription, start, end, ["ResourceGuid", "ServiceName"],
                       dimension_filter("ServiceName", SOLUTION_AI_SERVICES))
    prices = {}
    for currency in sorted({str(r["Currency"]).upper() for r in costs}):
        ids = set()
        for r in costs:
            try:
                if str(r["Currency"]).upper() == currency:
                    ids.add(str(UUID(str(r["ResourceGuid"]))))
            except ValueError:
                continue
        ids = sorted(ids)
        for i in range(0, len(ids), RETAIL_BATCH):
            batch = ids[i:i + RETAIL_BATCH]
            try:
                prices.update(retail_price_map(retail_prices(batch, currency, fetch)))
            except DETAIL_FAILURES as exc:
                warn(f"retail prices unavailable for {len(batch)} {currency} meters ({exc}); "
                     "they are reported as unpriced")
    return recon_rows(costs, prices, start, end)


def collect_details(client, subscription, start, end, context, fetch=fetch_json):
    """The report's capacity, solution spend and reconciliation CSVs; failures are skipped."""
    try:
        subscription_name = str(client.request(
            "GET", endpoint(f"/subscriptions/{subscription}", **{"api-version": "2022-12-01"})
        ).get("displayName") or "")
    except DETAIL_FAILURES as exc:
        subscription_name = ""
        warn(f"subscription name unavailable ({exc})")
    datasets = {}
    steps = [
        ("AzureDeploymentHealth.csv", HEALTH_HEADERS, lambda: collect_health(
            client, subscription, subscription_name, start, end, context["accounts"],
            context["deployments"], context["definitions"])),
        ("AzureSolutionSpend.csv", SOLUTION_HEADERS, lambda: collect_solution(
            client, subscription, subscription_name, start, end, context["accounts"],
            context["resources"], context["spend"], context["points"])),
        ("AzureBillingReconciliation.csv", RECON_HEADERS, lambda: collect_recon(
            client, subscription, start, end, fetch)),
    ]
    for filename, headers, step in steps:
        try:
            datasets[filename] = (headers, step())
        except DETAIL_FAILURES as exc:
            warn(f"{filename} not refreshed; the existing file is kept ({exc})")
    return datasets

def collect(client, subscription, start, end, details=True):
    resources = client.list(endpoint(f"/subscriptions/{subscription}/resources",
                                     **{"api-version": "2021-04-01"}))
    spend = collect_spend(client, subscription, start, end, resources)
    accounts = client.list(endpoint(
        f"/subscriptions/{subscription}/providers/Microsoft.CognitiveServices/accounts",
        **{"api-version": "2023-05-01"}))
    points, inventory, account_ids = [], [], set()
    definitions_by_account, deployments_by_account = {}, {}
    for account in accounts:
        rid = account["id"].lower()
        if (rid in account_ids or not rid.startswith(f"/subscriptions/{subscription.lower()}/")
                or "?" in rid or "#" in rid):
            raise CollectionError("Duplicate/invalid Cognitive Services account ID")
        account_ids.add(rid)
        definitions = client.list(endpoint(
            rid + "/providers/microsoft.insights/metricDefinitions",
            **{"api-version": "2018-01-01"}))
        definitions_by_account[rid] = definitions
        selected = select_metrics(definitions, account.get("kind"))
        if not selected:
            print(f"WARNING: {rid}: no known metrics advertised; telemetry unavailable.",
                  file=sys.stderr)
        for name, definition in selected:
            first = start
            while first < end:
                last = min(first + timedelta(days=30), end)
                params, dimension, field = metric_parameters(name, definition, first, last)
                # Monitor normally has no nextLink. Handle it if provided and
                # validate the final combined grain instead of silently truncating.
                for payload in client.pages(endpoint(
                        rid + "/providers/microsoft.insights/metrics", **params)):
                    points.extend(metric_points(payload, name, dimension, field,
                                                account, first, last))
                first = last
        deployments = client.list(endpoint(rid + "/deployments",
                                            **{"api-version": "2023-05-01"}))
        deployments_by_account[rid] = deployments
        seen_deployments = set()
        for deployment in deployments:
            name = deployment["name"]
            if not name or name.lower() in seen_deployments:
                raise CollectionError("Duplicate/blank deployment inventory name")
            seen_deployments.add(name.lower())
            model = deployment["properties"].get("model") or {}
            sku = deployment.get("sku") or {}
            capacity = sku.get("capacity")
            if capacity is not None:
                finite_number(capacity)
            inventory.append(dict(zip(DEPLOYMENT_HEADERS, [
                account.get("name") or account["id"].split("/")[-1],
                resource_group(account["id"]), account.get("location", ""),
                name, model.get("name", ""), model.get("version", ""),
                sku.get("name", ""), capacity,
            ])))
    keys = set()
    for point in points:
        key = tuple(point[h] for h in TOKEN_HEADERS[:-1])
        if key in keys:
            raise CollectionError("Duplicate metric grain across pages/windows/accounts")
        keys.add(key)
    if not points:
        print("WARNING: no metric points returned; missing telemetry is NOT proof of zero traffic.",
              file=sys.stderr)
    datasets = {
        "AzureAiSpendDaily.csv": (SPEND_HEADERS, spend),
        "AzureAiTokensDaily.csv": (TOKEN_HEADERS, points),
        "AzureAiDeployments.csv": (DEPLOYMENT_HEADERS, inventory),
    }
    if details:
        datasets.update(collect_details(client, subscription, start, end, {
            "accounts": accounts, "resources": resources, "spend": spend, "points": points,
            "deployments": deployments_by_account, "definitions": definitions_by_account}))
    return datasets


def publish(outdir, datasets):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    staged = []
    replaced = []
    try:
        for filename, (headers, rows) in datasets.items():
            if Path(filename).name != filename:
                raise CollectionError("Output filename must not contain a directory")
            path = outdir / f".{filename}.{uuid4().hex}.staging"
            staged.append((path, outdir / filename))
            with path.open("x", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=headers)
                writer.writeheader()
                for row in rows:
                    if set(row) != set(headers):
                        raise CollectionError(f"Invalid output schema for {filename}")
                    writer.writerow(row)
                handle.flush()
                os.fsync(handle.fileno())
        for path, destination in staged:
            os.replace(path, destination)
            replaced.append(destination.name)
    except (OSError, CollectionError, ValueError, TypeError, csv.Error) as exc:
        if replaced:
            raise CollectionError("Publication partially completed (" + ", ".join(replaced)
                                  + "); CSV replacements are not a multi-file transaction. "
                                  "Do not refresh; rerun the entire collector.") from exc
        raise
    finally:
        for path, _ in staged:
            path.unlink(missing_ok=True)


def subscription_id(value):
    try:
        identifier = UUID(value)
        if identifier.int == 0:
            raise ValueError
        return str(identifier)
    except (ValueError, TypeError, AttributeError) as exc:
        raise argparse.ArgumentTypeError("subscription must be a nonzero UUID") from exc


def days_count(value):
    number = int(value)
    if not 1 <= number <= 90:
        raise argparse.ArgumentTypeError("days must be from 1 to 90")
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("outdir", type=Path, help="Existing Power BI DataFolder (CSV output directory)")
    parser.add_argument("--subscription", type=subscription_id,
                        help="Subscription UUID; default: current Azure CLI account subscription")
    parser.add_argument("--days", type=days_count, default=90,
                        help="Complete UTC days before today, 1-90 (default: 90)")
    args = parser.parse_args(argv)
    try:
        client = AzureCLI()
        subscription = args.subscription or subscription_id(client.run(["account", "show"])["id"])
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=args.days)
        print(f"Subscription {subscription}; UTC window [{start}, {end})")
        datasets = collect(client, subscription, start, end)
        publish(args.outdir, datasets)
        for filename, (_, rows) in datasets.items():
            print(f"Wrote {filename}: {len(rows)} rows")
        print("Success. Per-file atomic replacements; not a multi-file transaction.")
        return 0
    except (CollectionError, OSError, ValueError, TypeError, KeyError,
            AttributeError, argparse.ArgumentTypeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
