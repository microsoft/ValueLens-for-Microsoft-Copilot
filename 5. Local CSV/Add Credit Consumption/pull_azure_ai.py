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
but the three replacements are NOT a transaction; serialize runs and readers.
Historical windows replace rather than append; costs can arrive late.
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit
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
            # HTTP failures get bounded exponential backoff (2, 4, 8 seconds).
            transient = re.search(
                r"\b(?:429|500|502|503|504|TooManyRequests|ServiceUnavailable|"
                r"GatewayTimeout|InternalServerError|BadGateway)\b", error, re.I)
            if not transient or attempt == 3:
                # Avoid dumping CLI diagnostics that might contain auth details.
                raise CollectionError(f"Azure CLI {args[0]} failed (exit {result.returncode}); "
                                      "check runner login, read permissions and Azure availability")
            self.sleep(2 ** (attempt + 1))
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


def cost_query(client, subscription, start, end, grouping, extra_filter=None):
    if not 1 <= len(grouping) <= 2 or len(set(grouping)) != len(grouping):
        raise CollectionError("Cost Management supports at most two distinct groupings")
    body = {
        "type": "ActualCost", "timeframe": "Custom",
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


def collect(client, subscription, start, end):
    resources = client.list(endpoint(f"/subscriptions/{subscription}/resources",
                                     **{"api-version": "2021-04-01"}))
    spend = collect_spend(client, subscription, start, end, resources)
    accounts = client.list(endpoint(
        f"/subscriptions/{subscription}/providers/Microsoft.CognitiveServices/accounts",
        **{"api-version": "2023-05-01"}))
    points, inventory, account_ids = [], [], set()
    for account in accounts:
        rid = account["id"].lower()
        if (rid in account_ids or not rid.startswith(f"/subscriptions/{subscription.lower()}/")
                or "?" in rid or "#" in rid):
            raise CollectionError("Duplicate/invalid Cognitive Services account ID")
        account_ids.add(rid)
        definitions = client.list(endpoint(
            rid + "/providers/microsoft.insights/metricDefinitions",
            **{"api-version": "2018-01-01"}))
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
    return {
        "AzureAiSpendDaily.csv": (SPEND_HEADERS, spend),
        "AzureAiTokensDaily.csv": (TOKEN_HEADERS, points),
        "AzureAiDeployments.csv": (DEPLOYMENT_HEADERS, inventory),
    }


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
