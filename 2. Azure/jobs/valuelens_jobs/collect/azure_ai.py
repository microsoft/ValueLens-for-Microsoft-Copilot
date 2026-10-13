"""Azure AI spend, tokens and Copilot pay-as-you-go from Azure Resource Manager, with the jobs'
managed identity. A port of the Fabric notebook `Ingest_Azure_AI` (same tables and columns):

* Strict (any failure fails the collector and none of the three is replaced):
  `azure_ai_spend` (Cost Management, AI services by day x meter x resource), `copilot_payg_spend`
  (Copilot Studio / Cowork pay-as-you-go billed to the AI subscription and
  VALUELENS_PAYG_SUBSCRIPTIONS) and `azure_ai_tokens` (Azure Monitor token/request metrics).
* Best effort (a failure is logged and leaves that table as it was): `azure_deployment_health`,
  `azure_solution_spend` and `azure_billing_reconciliation`. Reconciliation list prices come from
  the public Azure Retail Prices API, which is called without credentials.

The managed identity needs Cost Management Reader and Monitoring Reader (or Reader) on each
subscription. Every table is a full replace of the last 90 complete UTC days.
"""
from __future__ import annotations

import logging
import math
import re
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlsplit
from uuid import UUID

from ..api import ARM as ARM_SCOPE
from ..api import HttpError
from ..tables import write_rows

log = logging.getLogger("valuelens_jobs.collect.azure_ai")

ARM = "https://management.azure.com"
COST_API = "2025-03-01"
DAYS = 90
TAG_KEYS = ["Department", "department", "CostCentre", "CostCenter", "Team", "BusinessUnit", "Owner"]
AI_SERVICES = ["Foundry Models", "Microsoft Copilot Studio", "Cognitive Services", "Azure Machine Learning",
               "Azure OpenAI"]
PAYG_SERVICE = "Microsoft Copilot Studio"
PAYG_PRODUCTS = {"": "Copilot Studio", "cowork": "Cowork"}
METRIC_FAMILIES = [
    ("InputTokens", "ProcessedPromptTokens"),
    ("OutputTokens", "GeneratedTokens"),
    ("ModelRequests", "AzureOpenAIRequests", "TotalCalls"),
    ("ProvisionedUtilization", "AzureOpenAIProvisionedManagedUtilizationV2"),
]
UTILIZATION = set(METRIC_FAMILIES[-1])
SERIES_LIMIT = 10000
RETAIL_PRICES = "https://prices.azure.com/api/retail/prices"
RETAIL_BATCH = 15
MAX_PAGES = 10000

TBL_SPEND = "azure_ai_spend"
TBL_TOKENS = "azure_ai_tokens"
TBL_PAYG = "copilot_payg_spend"
TBL_HEALTH = "azure_deployment_health"
TBL_SOLUTION = "azure_solution_spend"
TBL_RECON = "azure_billing_reconciliation"
D, S, F = "DATE", "VARCHAR", "DOUBLE"
SCHEMAS = {
    TBL_SPEND: [("UsageDate", D), ("ServiceName", S), ("MeterCategory", S), ("Meter", S), ("ResourceId", S),
                ("ResourceName", S), ("ResourceGroup", S), ("Cost", F), ("UsageQuantity", F), ("Currency", S),
                ("DepartmentTag", S)],
    TBL_TOKENS: [("Date", D), ("ResourceName", S), ("ResourceGroup", S), ("Deployment", S), ("Metric", S),
                 ("Value", F)],
    TBL_PAYG: [("UsageDate", D), ("SubscriptionId", S), ("Meter", S), ("ServiceTag", S), ("Product", S),
               ("Cost", F), ("UsageQuantity", F), ("Currency", S)],
    TBL_HEALTH: [("SnapshotDate", D), ("MetricDate", D), ("SubscriptionName", S), ("SubscriptionId", S),
                 ("ResourceId", S), ("DeploymentId", S), ("DeploymentName", S), ("Application", S),
                 ("ModelName", S), ("ModelVersion", S), ("SkuName", S), ("Region", S), ("PtuCapacity", F),
                 ("MeanUtilizationPct", F), ("PeakUtilizationPct", F), ("Requests", F), ("ServerErrors5xx", F),
                 ("Throttles429", F), ("MeanLatencyMs", F)],
    TBL_SOLUTION: [("UsageDate", D), ("SubscriptionName", S), ("SubscriptionId", S), ("ResourceId", S),
                   ("ResourceName", S), ("ResourceGroup", S), ("Application", S), ("DepartmentTag", S),
                   ("ServiceName", S), ("ServiceCategory", S), ("ActualCost", F), ("AmortizedCost", F),
                   ("Currency", S), ("TotalTokensM", F), ("PaygTokensM", F), ("InputPaygCost", F),
                   ("OutputPaygCost", F), ("CachedPaygCost", F), ("Requests", F), ("SpeechHours", F),
                   ("DocumentPages", F), ("Images", F), ("AllocationStatus", S), ("PricingModel", S),
                   ("BillingScope", S)],
    TBL_RECON: [("Period", S), ("PeriodStart", D), ("PeriodEnd", D), ("Product", S), ("PoolName", S),
                ("Representation", S), ("Amount", F), ("Currency", S), ("Status", S), ("EvidenceType", S),
                ("Notes", S)],
}


class ArmClient:
    """ARM calls with the managed identity. Continuation URLs never leave management.azure.com."""

    def __init__(self, api):
        self.api = api

    def request(self, method, url, params=None, body=None):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc.lower() != "management.azure.com" or parsed.fragment:
            raise ValueError("Invalid ARM request or continuation URL")
        kwargs = {"params": params} if params else {}
        if body is not None:
            kwargs["json"] = body
        r = self.api.request(method, url, scope=ARM_SCOPE, timeout=180, allow_redirects=False, **kwargs)
        if r.status_code == 204:
            return None
        if not 200 <= r.status_code < 300:
            hint = (" - grant the jobs' managed identity Cost Management Reader and Monitoring Reader "
                    "(or Reader) on the subscription" if r.status_code in (401, 403) else "")
            text = (getattr(r, "text", "") or "")[:300]
            raise HttpError(f"ARM {method} {parsed.path}: HTTP {r.status_code}{hint} {text}".strip(), r.status_code)
        return r.json()

    def get(self, url, **params):
        payload = self.request("GET", url, params=params)
        if payload is None:
            raise ValueError("Empty ARM response")
        return payload

    def list(self, url, **params):
        items, seen = [], set()
        while url:
            if url in seen or len(seen) >= MAX_PAGES:
                raise RuntimeError("Repeated ARM continuation URL")
            seen.add(url)
            page = self.get(url, **params)
            items.extend(page["value"])
            url, params = page.get("nextLink"), {}
        return items

    def cost_query(self, url, body, required=None):
        records, seen = [], set()
        while url:
            if url in seen or len(seen) >= MAX_PAGES:
                raise RuntimeError("Repeated Cost Management continuation URL")
            seen.add(url)
            response = self.request("POST", url, body=body)
            if response is None:
                if records or len(seen) > 1:
                    raise RuntimeError("Unexpected empty Cost Management continuation page")
                return []
            page = response["properties"]
            columns = [c["name"] for c in page["columns"]]
            if len(columns) != len(set(columns)):
                raise ValueError("Duplicate cost columns")
            for values in page["rows"]:
                if len(values) != len(columns):
                    raise ValueError("Cost row does not match its page columns")
                row = dict(zip(columns, values))
                for alias, spec in body["dataset"]["aggregation"].items():
                    candidates = [spec["name"], alias]
                    if spec["name"] == "Cost":
                        candidates.append("PreTaxCost")
                    found = [key for key in candidates if key in row]
                    if not found:
                        raise ValueError(f"Missing cost aggregation {spec['name']}")
                    row[spec["name"]] = finite_number(row[found[0]])
                for key in (required or [g["name"] for g in body["dataset"]["grouping"]]) + ["UsageDate", "Currency"]:
                    if key not in row:
                        raise ValueError(f"Missing cost column {key}")
                records.append(row)
            url = page.get("nextLink")
        return records


def finite_number(value):
    if value is None or isinstance(value, bool):
        raise ValueError("Missing numeric value in Azure response")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite numeric value in Azure response")
    return number


def resource_group(rid):
    parts = rid.split("/")
    lower = [p.lower() for p in parts]
    if "resourcegroups" in lower:
        i = lower.index("resourcegroups")
        if i + 1 < len(parts):
            return parts[i + 1]
    return ""


def cost_day(value):
    raw = str(value)
    return datetime.strptime(raw, "%Y%m%d" if re.fullmatch(r"\d{8}", raw) else "%Y-%m-%d").date()


def subscription_id(value) -> str:
    identifier = UUID(str(value).strip())
    if identifier.int == 0:
        raise ValueError("Configure a real subscription ID")
    return str(identifier)


def select_metrics(definitions, kind):
    available = {d["name"]["value"]: d for d in definitions}
    selected = []
    for family in METRIC_FAMILIES:
        name = next((n for n in family if n in available
                     and not (n == "TotalCalls" and (kind or "").lower() == "openai")), None)
        if name:
            selected.append(name)
    if not any(n in selected for family in METRIC_FAMILIES[:2] for n in family):
        if "TotalTokens" in available:
            selected.append("TotalTokens")
    return [(name, available[name]) for name in selected]


def metric_parameters(name, definition, first, last):
    aggregation = "Average" if name in UTILIZATION else "Total"
    supported = definition.get("supportedAggregationTypes") or [definition["primaryAggregationType"]]
    if aggregation.lower() not in {s.lower() for s in supported}:
        raise ValueError(f"{name} does not support required {aggregation} aggregation")
    dimensions = [d["value"] for d in definition.get("dimensions", [])]
    deployment = next((d for candidate in ("modeldeploymentname", "deploymentname", "deployment")
                       for d in dimensions if d.lower() == candidate), None)
    params = {"api-version": "2023-10-01", "metricnames": name,
              "aggregation": aggregation, "interval": "P1D",
              "timespan": f"{first}T00:00:00Z/{last}T00:00:00Z",
              "AutoAdjustTimegrain": "false", "ValidateDimensions": "true"}
    if definition.get("namespace"):
        params["metricnamespace"] = definition["namespace"]
    if deployment:
        params.update({"$filter": f"{deployment} eq '*'", "top": SERIES_LIMIT})
    return params, deployment, aggregation.lower()


def metric_points(payload, name, deployment_dimension, field, account, first, last):
    if payload.get("error"):
        raise RuntimeError(f"Azure Monitor error: {payload['error']}")
    metrics = payload["value"]
    if len(metrics) != 1 or metrics[0]["name"]["value"] != name:
        raise ValueError(f"Azure Monitor omitted or changed requested metric {name}")
    metric = metrics[0]
    if metric.get("errorCode") not in (None, "Success", "0"):
        raise RuntimeError(f"{name}: {metric['errorCode']}: {metric.get('errorMessage', '')}")
    if payload.get("interval") != "P1D":
        raise ValueError(f"{name}: expected daily points; refusing to reaggregate averages")
    series = metric["timeseries"]
    if len(series) >= SERIES_LIMIT:
        raise RuntimeError(f"{name}: series limit reached; results may be truncated")
    result, seen_series, seen_points = [], set(), set()
    for series_item in series:
        metadata = {m["name"]["value"].lower(): m["value"] for m in series_item.get("metadatavalues", [])}
        expected = deployment_dimension.lower() if deployment_dimension else None
        if any(key != expected and value not in ("", None) for key, value in metadata.items()):
            raise ValueError(f"{name}: unexpected dimension split; refusing to double count")
        if expected and expected not in metadata:
            raise ValueError(f"{name}: missing deployment metadata")
        deployment = metadata.get(expected, "") or ""
        if deployment == "*" or deployment in seen_series:
            raise ValueError(f"{name}: duplicate or rolled-up deployment series")
        seen_series.add(deployment)
        for point in series_item["data"]:
            stamp = datetime.fromisoformat(point["timeStamp"].replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                raise ValueError("Metric timestamp is missing its timezone")
            stamp = stamp.astimezone(timezone.utc)
            day = stamp.date()
            midnight = (stamp.hour, stamp.minute, stamp.second, stamp.microsecond) == (0, 0, 0, 0)
            # Some APIs include the upper endpoint; adjacent windows must not overlap.
            if day == last and midnight:
                continue
            if not first <= day < last or not midnight:
                raise ValueError(f"{name}: unexpected daily timestamp")
            if field not in point and any(k in point for k in ("total", "average", "count", "minimum", "maximum")):
                raise ValueError(f"{name}: missing requested {field} aggregation")
            value = point.get(field)
            if value is None:
                continue
            key = (day, deployment)
            if key in seen_points:
                raise ValueError(f"{name}: duplicate daily metric point")
            seen_points.add(key)
            result.append({"Date": day, "ResourceName": account.get("name") or account["id"].split("/")[-1],
                           "ResourceGroup": resource_group(account["id"]),
                           "Deployment": deployment, "Metric": name, "Value": finite_number(value)})
    return result


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


def cost_body(start, end, cost_type="ActualCost"):
    return {
        "type": cost_type, "timeframe": "Custom",
        "timePeriod": {"from": f"{start}T00:00:00Z", "to": f"{end - timedelta(days=1)}T23:59:59Z"},
        "dataset": {
            "granularity": "Daily",
            "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"},
                            "totalQty": {"name": "UsageQuantity", "function": "Sum"}},
            "grouping": [{"type": "Dimension", "name": d} for d in ["ServiceName", "MeterCategory"]],
            "filter": {"dimensions": {"name": "ServiceName", "operator": "In", "values": AI_SERVICES}},
        },
    }


def cost_url(subscription):
    return f"{ARM}/subscriptions/{subscription}/providers/Microsoft.CostManagement/query?api-version={COST_API}"


def collect_spend(arm, subscription, start, end):
    body = cost_body(start, end)
    url = cost_url(subscription)
    pairs = {(r["ServiceName"], r["MeterCategory"]) for r in arm.cost_query(url, body)}
    rows = []
    for service, category in sorted(pairs):
        if not service or not category:
            raise ValueError("Cost query returned a blank service/category; cannot safely partition")
        detail = deepcopy(body)
        detail["dataset"]["grouping"] = [{"type": "Dimension", "name": d} for d in ["Meter", "ResourceId"]]
        detail["dataset"]["filter"] = {"and": [
            {"dimensions": {"name": key, "operator": "In", "values": [value]}}
            for key, value in [("ServiceName", service), ("MeterCategory", category)]]}
        details = arm.cost_query(url, detail)
        if not details:
            raise RuntimeError("Cost detail is empty for a discovered service/category; rerun")
        for row in details:
            row.update(ServiceName=service, MeterCategory=category)
        rows.extend(details)

    # Resource tags, fetched separately and joined on resource id.
    resources = arm.list(f"{ARM}/subscriptions/{subscription}/resources", **{"api-version": "2021-04-01"})
    tags = {}
    for res in resources:
        t = res.get("tags") or {}
        for k in TAG_KEYS:
            if k in t:
                tags[res["id"].lower()] = t[k]
                break

    recs, keys = [], set()
    for r in rows:
        rid = str(r["ResourceId"] or "")
        parts = rid.split("/")
        usage_date = cost_day(r["UsageDate"])
        if not start <= usage_date < end:
            raise ValueError("Cost date outside the requested UTC window")
        key = (usage_date, r["ServiceName"], r["MeterCategory"], r["Meter"], rid.lower(), r["Currency"])
        if key in keys:
            raise ValueError("Duplicate aggregated cost grain; refusing to double count")
        keys.add(key)
        recs.append({
            "UsageDate": usage_date, "ServiceName": r["ServiceName"], "MeterCategory": r["MeterCategory"],
            "Meter": r["Meter"], "ResourceId": rid, "ResourceName": parts[-1] if parts else "",
            "ResourceGroup": resource_group(rid), "Cost": r["Cost"], "UsageQuantity": r["UsageQuantity"],
            "Currency": r["Currency"], "DepartmentTag": tags.get(rid.lower(), ""),
        })
    log.info("azure_ai: %s spend rows; %s resources carry a department tag", len(recs), len(tags))
    return recs, resources, tags


def collect_payg(arm, subscriptions, start, end):
    """Copilot Studio and Cowork credits billed through Power Platform billing policies."""
    query = cost_body(start, end)
    query["dataset"]["grouping"] = [{"type": "Dimension", "name": "Meter"},
                                    {"type": "TagKey", "name": "serviceName"}]
    query["dataset"]["filter"] = {"dimensions": {"name": "ServiceName", "operator": "In", "values": [PAYG_SERVICE]}}
    recs, keys = [], set()
    for subscription in subscriptions:
        found = arm.cost_query(cost_url(subscription), query, required=["Meter", "TagKey", "TagValue"])
        for r in found:
            tag_key = str(r["TagKey"] or "")
            if tag_key.lower() not in ("", "servicename"):
                raise ValueError(f"Unexpected cost tag key {tag_key!r}; refusing to guess the product")
            tag = str(r["TagValue"] or "") if tag_key else ""
            meter = str(r["Meter"] or "")
            if not meter:
                raise ValueError("Copilot cost row has no meter")
            usage_date = cost_day(r["UsageDate"])
            if not start <= usage_date < end:
                raise ValueError("Cost date outside the requested UTC window")
            key = (usage_date, subscription, meter, tag, r["Currency"])
            if key in keys:
                raise ValueError("Duplicate Copilot cost grain; refusing to double count")
            keys.add(key)
            recs.append({"UsageDate": usage_date, "SubscriptionId": subscription, "Meter": meter,
                         "ServiceTag": tag, "Product": PAYG_PRODUCTS.get(tag.lower(), tag), "Cost": r["Cost"],
                         "UsageQuantity": r["UsageQuantity"], "Currency": r["Currency"]})
        log.info("azure_ai: %s: %s Copilot pay-as-you-go rows", subscription, len(found))
    return recs


def collect_tokens(arm, subscription, start, end):
    accounts = arm.list(f"{ARM}/subscriptions/{subscription}/providers/Microsoft.CognitiveServices/accounts",
                        **{"api-version": "2023-05-01"})
    points, ids = [], set()
    for a in accounts:
        if a["id"].lower() in ids:
            raise ValueError("Duplicate Cognitive Services account in paginated inventory")
        ids.add(a["id"].lower())
        defs = arm.list(f"{ARM}{a['id']}/providers/microsoft.insights/metricDefinitions",
                        **{"api-version": "2018-01-01"})
        ask = select_metrics(defs, a.get("kind", ""))
        if not ask:
            log.info("  %s: publishes none of the known token metrics", a.get("name"))
            continue
        for name, definition in ask:
            first = start
            while first < end:
                last = min(first + timedelta(days=30), end)
                params, dimension, field = metric_parameters(name, definition, first, last)
                md = arm.get(f"{ARM}{a['id']}/providers/microsoft.insights/metrics", **params)
                points.extend(metric_points(md, name, dimension, field, a, first, last))
                first = last
    if not points:
        log.warning("azure_ai: no metric points returned. Missing telemetry is not proof of zero traffic.")
    return accounts, points


def collect_health(arm, subscription, subscription_name, start, end, accounts, warnings):
    """None when every deployment inventory call failed (the table is then left as it is)."""
    inventory, acc, found = [], {}, []
    inventory_failures = calls = failures = 0
    for a in accounts:
        try:
            deployments = arm.list(f"{ARM}{a['id']}/deployments", **{"api-version": "2023-05-01"})
        except Exception as exc:
            inventory_failures += 1
            warnings.append(f"{a.get('name')}: deployment inventory failed ({type(exc).__name__}: {exc})")
            continue
        inventory.extend(deployment_inventory(a, deployments, found))
        _flush(found, warnings)
        if not deployments:
            continue
        try:
            definitions = arm.list(f"{ARM}{a['id']}/providers/microsoft.insights/metricDefinitions",
                                   **{"api-version": "2018-01-01"})
        except Exception as exc:
            warnings.append(f"{a.get('name')}: metric definitions unavailable ({type(exc).__name__}: {exc})")
            continue
        plans = health_metric_requests(definitions)
        if not plans:
            warnings.append(f"{a.get('name')}: no per-deployment request, utilisation or latency metrics advertised")
        for plan in plans:
            for first, last in metric_windows(start, end):
                # One batched call per plan and window; if it fails, retry its metrics one by one.
                batches = [plan["metricnames"]]
                while batches:
                    names = batches.pop()
                    calls += 1
                    try:
                        payload = arm.get(f"{ARM}{a['id']}/providers/microsoft.insights/metrics",
                                          **health_metric_parameters(plan, names, first, last))
                        health_accumulate(acc, payload, plan, a["id"], first, last, found, a.get("name"))
                    except Exception as exc:
                        failures += 1
                        warnings.append(f"{a.get('name')}: {','.join(names)} {first}..{last} failed "
                                        f"({type(exc).__name__}: {exc})")
                        if len(names) > 1:
                            batches.extend([name] for name in names)
                    _flush(found, warnings)
    log.info("azure_ai: %s deployments; %s/%s metric calls succeeded", len(inventory), calls - failures, calls)
    if accounts and inventory_failures == len(accounts):
        warnings.append(f"every deployment inventory call failed; {TBL_HEALTH} left unchanged")
        return None
    return health_rows(inventory, acc, start, end, subscription, subscription_name)


def retail_prices(api, meter_ids, currency):
    """Public, unauthenticated API: no token is ever sent here."""
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("Unexpected currency code")
    url = RETAIL_PRICES
    params = {"currencyCode": currency, "$filter": " or ".join(f"meterId eq '{UUID(m)}'" for m in meter_ids)}
    items, seen = [], set()
    while url:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc.lower() != "prices.azure.com" or url in seen or len(seen) >= 50:
            raise ValueError("Unexpected Retail Prices continuation URL")
        seen.add(url)
        for attempt in range(4):
            r = api.session.request("GET", url, params=params, timeout=60, allow_redirects=False)
            if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                api.sleep(2 ** (attempt + 1))
                continue
            break
        if not 200 <= r.status_code < 300:
            raise HttpError(f"Retail Prices API returned HTTP {r.status_code}", r.status_code)
        page = r.json()
        items.extend(page.get("Items") or [])
        url, params = page.get("NextPageLink"), None
    return items


def collect_solution(arm, subscription, subscription_name, start, end, accounts, resources, tags, spend, points,
                     warnings):
    service_filter = {"dimensions": {"name": "ServiceName", "operator": "In", "values": SOLUTION_AI_SERVICES}}
    groups = sorted({resource_group(a["id"]) for a in accounts} - {""})
    # Supporting services are the non-AI resources that share a resource group with an AI account.
    solution_filter = ({"or": [service_filter, {"dimensions": {
        "name": "ResourceGroupName", "operator": "In", "values": groups}}]} if groups else service_filter)
    actual = _cost_detail(arm, subscription, start, end, "ActualCost", ["ResourceId", "ServiceName"], solution_filter)
    amortized = _cost_detail(arm, subscription, start, end, "AmortizedCost", ["ResourceId", "ServiceName"],
                             solution_filter)
    known = {r["id"].lower(): {"tags": r.get("tags"), "department": tags.get(r["id"].lower(), "")}
             for r in resources}
    found = []
    rows = solution_rows(actual, amortized, spend, monitor_usage(points, accounts), known, subscription,
                         subscription_name, found)
    _flush(found, warnings)
    return rows


def collect_recon(api, arm, subscription, start, end, warnings):
    service_filter = {"dimensions": {"name": "ServiceName", "operator": "In", "values": SOLUTION_AI_SERVICES}}
    costs = _cost_detail(arm, subscription, start, end, "ActualCost", ["ResourceGuid", "ServiceName"], service_filter)
    prices = {}
    for currency in sorted({str(r["Currency"]).upper() for r in costs}):
        ids = []
        for r in costs:
            try:
                if str(r["Currency"]).upper() == currency:
                    ids.append(str(UUID(str(r["ResourceGuid"]))))
            except ValueError:
                continue
        ids = sorted(set(ids))
        for i in range(0, len(ids), RETAIL_BATCH):
            try:
                prices.update(retail_price_map(retail_prices(api, ids[i:i + RETAIL_BATCH], currency)))
            except Exception as exc:
                warnings.append(f"retail prices unavailable for {len(ids[i:i + RETAIL_BATCH])} {currency} meters "
                                f"({type(exc).__name__}: {exc}); they are reported as unpriced")
    return recon_rows(costs, prices, start, end)


def _cost_detail(arm, subscription, start, end, cost_type, grouping, cost_filter):
    query = cost_body(start, end, cost_type)
    query["dataset"]["grouping"] = [{"type": "Dimension", "name": g} for g in grouping]
    query["dataset"]["filter"] = cost_filter
    return arm.cost_query(cost_url(subscription), query)


def _flush(found, warnings):
    warnings.extend(found)
    found.clear()


def write_table(store, table, rows) -> int:
    """Replaces `raw/<table>/` with the rows (dicts keyed by column)."""
    schema = SCHEMAS[table]
    prefix = f"raw/{table}"
    rel = f"{prefix}/part-0.parquet"
    columns = [c for c, _ in schema]
    n = write_rows(store.path(rel), columns, [[r.get(c) for c in columns] for r in rows], [t for _, t in schema])
    store.push([rel])
    stale = [r for r in store.list(prefix) if r != rel]
    if stale:
        store.remove(stale)
    log.info("azure_ai: wrote %s: %s rows", table, n)
    return n


def collect_azure_ai(api, store, settings, *, today: date | None = None) -> dict:
    subscription = subscription_id(settings.azure_ai_subscription)
    end = today or datetime.now(timezone.utc).date()
    start = end - timedelta(days=DAYS)
    arm = ArmClient(api)
    payg_subscriptions = []
    for identifier in [subscription, *settings.payg_subscriptions]:
        sub = subscription_id(identifier)
        if sub not in payg_subscriptions:
            payg_subscriptions.append(sub)
    log.info("azure_ai: subscription %s; PAYG %s; UTC window [%s, %s)", subscription,
             ", ".join(payg_subscriptions), start, end)

    # Strict: the three core tables are written only once all of them have been collected.
    spend, resources, tags = collect_spend(arm, subscription, start, end)
    payg = collect_payg(arm, payg_subscriptions, start, end)
    accounts, points = collect_tokens(arm, subscription, start, end)
    out = {TBL_SPEND: write_table(store, TBL_SPEND, spend), TBL_TOKENS: write_table(store, TBL_TOKENS, points),
           TBL_PAYG: write_table(store, TBL_PAYG, payg)}

    # Best effort: a failure leaves that table as it was.
    warnings = []
    try:
        subscription_name = str(arm.get(f"{ARM}/subscriptions/{subscription}",
                                        **{"api-version": "2022-12-01"}).get("displayName") or "")
    except Exception as exc:
        subscription_name = ""
        warnings.append(f"subscription name unavailable ({type(exc).__name__}: {exc})")
    steps = [
        (TBL_HEALTH, lambda: collect_health(arm, subscription, subscription_name, start, end, accounts, warnings)),
        (TBL_SOLUTION, lambda: collect_solution(arm, subscription, subscription_name, start, end, accounts,
                                                resources, tags, spend, points, warnings)),
        (TBL_RECON, lambda: collect_recon(api, arm, subscription, start, end, warnings)),
    ]
    for table, step in steps:
        try:
            rows = step()
            if rows is not None:
                out[table] = write_table(store, table, rows)
        except Exception as exc:
            warnings.append(f"{table} failed; left unchanged ({type(exc).__name__}: {exc})")
    for message in warnings:
        log.warning("azure_ai: %s", message)
    if warnings:
        out["warnings"] = len(warnings)
    return out
