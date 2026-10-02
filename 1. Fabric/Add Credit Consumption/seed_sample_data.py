"""
Load the sample dataset straight into a Fabric Lakehouse.

The quickest way to see the Fabric template working. It writes the eleven
Consumption Central tables from the synthetic CSVs in
`1. Local CSV/Add Credit Consumption/sample-data/`, so you can point the
template at a real Lakehouse without first standing up the ingester
notebooks, arranging exports, or waiting for a billing cycle.

It is a TESTING convenience, not part of the pipeline. For real data use the
notebooks - they merge rather than overwrite, so they accumulate history.

    pip install pandas deltalake requests
    az login --tenant <your-tenant>
    python seed_sample_data.py --workspace <guid> --lakehouse <guid>

Find both GUIDs in the Fabric portal URL when the Lakehouse is open:
    app.fabric.microsoft.com/groups/<workspace>/lakehouses/<lakehouse>

Authentication is whoever `az login` signed in as, and that identity needs
write access to the Lakehouse. No secret is stored anywhere.

WHAT IT WILL AND WILL NOT TOUCH
It overwrites the eleven Consumption Central tables and refuses to write anything else.
Lakehouses are often shared, so a script that takes a name and deletes what it
is told is not a script worth running.
"""
import argparse
import os
import subprocess
import sys

try:
    import pandas as pd
    from deltalake import write_deltalake
except ImportError:
    sys.exit("pip install pandas deltalake requests")

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE = os.path.join(HERE, "..", "..", "1. Local CSV", "Add Credit Consumption", "sample-data")

# Written in full every run. Nothing outside this set is created or removed.
OURS = ["viva_credits_weekly", "viva_spending_policy", "studio_tenant_daily",
        "studio_agent", "studio_user", "github_ai_usage", "github_user_map",
        "org_attributes", "commercial_terms", "azure_ai_spend", "azure_ai_tokens"]


def token():
    """Whatever `az login` is signed in as. Nothing is cached by this script."""
    r = subprocess.run(
        ["az", "account", "get-access-token",
         "--resource", "https://storage.azure.com",
         "--query", "accessToken", "-o", "tsv"],
        capture_output=True, text=True, shell=(os.name == "nt"))
    if r.returncode or not r.stdout.strip():
        sys.exit("az login first - " + (r.stderr.strip() or "no token returned"))
    return r.stdout.strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workspace", required=True, help="workspace GUID")
    ap.add_argument("--lakehouse", required=True, help="lakehouse GUID")
    ap.add_argument("--schema", default="dbo",
                    help="dbo for a schema-enabled Lakehouse; pass --schema= "
                         "(empty) for one created without schemas")
    ap.add_argument("--sample-dir", default=SAMPLE)
    ap.add_argument("--identified", action="store_true", default=True,
                    help="join PersonPolicyMap to give the Viva metrics real "
                         "UPNs (default). See the note below.")
    ap.add_argument("--de-identified", dest="identified", action="store_false",
                    help="leave the Viva metrics hashed, as the raw sample is. "
                         "Department breakdowns will be empty - which is what a "
                         "de-identified export genuinely does.")
    a = ap.parse_args()

    if not os.path.isdir(a.sample_dir):
        sys.exit(f"sample data not found: {a.sample_dir}")

    tables = f"{a.lakehouse}/Tables" + (f"/{a.schema}" if a.schema else "")
    uri = f"abfss://{a.workspace}@onelake.dfs.fabric.microsoft.com/{tables}"
    opts = {"bearer_token": token(), "use_fabric_endpoint": "true"}
    loaded_at = pd.Timestamp.now("UTC").tz_localize(None)

    def read(n):
        return pd.read_csv(os.path.join(a.sample_dir, n), encoding="utf-8-sig")

    def put(name, df):
        assert name in OURS, f"{name} is not a Consumption Central table"
        df = df.copy()
        df["_loaded_at"] = loaded_at
        write_deltalake(f"{uri}/{name}", df, mode="overwrite",
                        schema_mode="overwrite", storage_options=opts)
        print(f"  {name:<24} {len(df):>6,} rows")

    def d(s):
        return pd.to_datetime(s, errors="coerce", format="mixed").dt.date

    print(f"Writing to {a.workspace}/{tables}\n")

    # ---- Viva -------------------------------------------------------------
    met = read("PersonServiceCreditsMetrics.csv")
    # The sample is a DE-IDENTIFIED export: PersonId is a hash and there is no
    # UserPrincipalName, so org attributes cannot join and every department
    # breakdown is empty. That is correct behaviour and worth seeing once, but
    # it exercises less of the report. PersonPolicyMap.csv does carry UPNs, so
    # by default we join them on to produce the identified shape instead.
    if a.identified:
        upn = read("PersonPolicyMap.csv").set_index("PersonId")["userPrincipalName"]
        resolved = met["PersonId"].map(upn).str.lower()
    else:
        resolved = pd.Series([None] * len(met), dtype="object")

    put("viva_credits_weekly", pd.DataFrame({
        "person_id": met["PersonId"].astype(str),
        "user_principal_name": resolved,
        "entra_id": pd.Series([None] * len(met), dtype="object"),
        "people_historical_id": met["PeopleHistoricalId"].astype(str),
        "service_id": met["ServiceId"].astype(str),
        "service_name": met["ServiceName"].astype(str),
        "spending_policy_id": met["SpendingPolicyId"].astype(str),
        "metric_date": d(met["MetricDate"]),
        "session_count": met["Session count"].astype("Int32"),
        "spending_policy_limit": met["Spending policy limit"].astype("Int64"),
        "credits_used": met["Total Copilot Credits used"].astype(float),
        "user_limit": met["User limit"].astype("Int64"),
    }))

    pol = read("SpendingPolicyMetadata.csv")
    put("viva_spending_policy", pd.DataFrame({
        "spending_policy_id": pol["SpendingPolicyId"].astype(str),
        "name": pol["Name"].astype(str),
        "plan_limit": pol["PlanLimit"].astype("Int64"),
        "user_limit": pol["UserLimit"].astype("Int64"),
        "included_services": pol["IncludedServices"].astype(str),
    }))

    # ---- Studio -----------------------------------------------------------
    ten = read("StudioTenantDaily.csv")
    put("studio_tenant_daily", pd.DataFrame({
        "billing_plan_id": ten["BillingPlan Id"].astype(str),
        "billing_plan_name": ten["BillingPlan Name"].astype(str),
        "environment_id": ten["Environment Id"].astype(str),
        "environment_name": ten["Environment Name"].astype(str),
        "capacity_type": ten["Capacity Type"].astype(str),
        "source_file": "StudioTenantDaily.csv",
        "entitled_quantity": ten["Entitled Quantity"].astype(float),
        "prepaid_consumed": ten["Prepaid Consumed Quantity"].astype(float),
        "payg_consumed": ten["Pay as you go Consumed Quantity"].astype(float),
        "usage_date": d(ten["Usage Date"]),
    }))

    # The per-agent and per-user exports carry no date at all - they are
    # month-to-date aggregates. The ingester stamps the month so repeated runs
    # build history; the template then reads the newest stamp only, because
    # each snapshot is already a month total and summing them would multiply
    # every agent's credits by the number of months loaded.
    snapshot = pd.Timestamp(d(ten["Usage Date"]).max()).replace(day=1).date()

    ag = read("StudioPerAgent.csv")
    put("studio_agent", pd.DataFrame({
        "snapshot_month": snapshot,
        "agent_name": ag["Agent Name"].astype(str),
        "agent_id": ag["Agent Id"].astype(str),
        "product": ag["Product"].astype(str),
        "billable_feature": ag["AI Feature/Billable Feature"].astype(str),
        "billed_credit": ag["Billed credit"].astype(float),
        "non_billed_credit": ag["Non-billed credit"].astype(float),
        "channel": ag["Channel"].astype(str),
        "knowledge_sources": ag["Knowledge Sources"].astype(str),
        "tool_used": ag["Tool Used"].astype(str),
        "llm_model": ag["LLM Model"].astype(str),
        "scenario_name": ag["Scenario Name"].astype(str),
        "environment_id": ag["Environment Id"].astype(str),
        "environment_name": ag["Environment Name"].astype(str),
        "source_file": "StudioPerAgent.csv",
    }))

    us = read("StudioPerUser.csv")
    lic = us["M365 Copilot Licensed"].astype(str).str.strip().str.lower()
    put("studio_user", pd.DataFrame({
        "snapshot_month": snapshot,
        "user_id": us["User Id"].astype(str),
        "user_email": us["User Email"].astype(str).str.lower(),
        "agent_id": us["Agent Id"].astype(str),
        "agent_name": us["Agent Name"].astype(str),
        "billable_credit_used": us["Billable credit used"].astype(float),
        "credits_used": us["Credits used"].astype(float),
        "m365_copilot_licensed": lic.isin(["true", "yes", "1"]),
        "source_file": "StudioPerUser.csv",
    }))

    # ---- GitHub -----------------------------------------------------------
    gh = read("GitHubAiUsage.csv")
    put("github_ai_usage", pd.DataFrame({
        "usage_date": d(gh["date"]),
        "username": gh["username"].astype(str).str.lower(),
        "product": gh["product"].astype(str),
        "sku": gh["sku"].astype(str),
        "model": gh["model"].astype(str),
        "quantity": gh["quantity"].astype(float),
        "unit_type": gh["unit_type"].astype(str),
        "applied_cost_per_quantity": gh["applied_cost_per_quantity"].astype(float),
        "gross_amount": gh["gross_amount"].astype(float),
        "discount_amount": gh["discount_amount"].astype(float),
        "net_amount": gh["net_amount"].astype(float),
        "total_monthly_quota": gh["total_monthly_quota"].astype(float),
        "organization": gh["organization"].astype(str),
        "repository": gh["repository"].astype(str),
        "cost_center_name": gh["cost_center_name"].astype(str),
    }))

    gm = read("GitHubUserMap.csv")
    put("github_user_map", pd.DataFrame({
        "username": gm["username"].astype(str).str.lower(),
        "user_principal_name": gm["userPrincipalName"].astype(str).str.lower(),
        "display_name": gm["displayName"].astype(str),
        "plan": gm["plan"].astype(str),
        "included_credits": gm["included_credits"].astype("Int64"),
    }))

    # ---- Org --------------------------------------------------------------

    # ---- Azure AI Foundry -------------------------------------------------
    # Optional, like everything else. Absent tables give an empty Foundry
    # page rather than a broken model.
    try:
        spend = read("AzureAiSpendDaily.csv")
    except FileNotFoundError:
        spend = None
    if spend is not None and len(spend):
        spend["UsageDate"] = pd.to_datetime(spend["UsageDate"]).dt.date
        for c in ("Cost", "UsageQuantity"):
            spend[c] = pd.to_numeric(spend[c], errors="coerce").fillna(0.0)
        put("azure_ai_spend", spend)

    try:
        tok = read("AzureAiTokensDaily.csv")
    except FileNotFoundError:
        tok = None
    if tok is not None and len(tok):
        tok["Date"] = pd.to_datetime(tok["Date"]).dt.date
        tok["Value"] = pd.to_numeric(tok["Value"], errors="coerce").fillna(0.0)
        put("azure_ai_tokens", tok)

    org = read("entra_org.csv")
    put("org_attributes", pd.DataFrame({
        "user_principal_name": org["userPrincipalName"].astype(str).str.lower(),
        "display_name": org["displayName"].astype(str),
        "department": org["department"].astype(str),
        "job_title": org["jobTitle"].astype(str),
        "job_family": org["jobFamily"].astype(str),
        "city": org["city"].astype(str),
        "country": org["country"].astype(str),
        "cost_center": org["costCenter"].astype(str),
        "manager": org["manager"].astype(str),
        "business_unit": org["businessUnit"].astype(str),
    }))

    # ---- Commercial terms -------------------------------------------------
    # Deliberately NOT list price. If the template is reading this table the
    # cost pages show a rate of 0.0092; if it has fallen back to its parameters
    # they show 0.01. That makes the override visibly testable rather than
    # something you have to take on trust.
    put("commercial_terms", pd.DataFrame([{
        "credit_rate": 0.0092,
        "prepaid_credit_rate": 0.0074,
        "prepaid_credit_balance": 250000.0,
        "github_business_seat": 17.5,
        "github_enterprise_seat": 35.0,
    }]))

    print("\nDone. The SQL analytics endpoint syncs asynchronously - give it a")
    print("minute before the tables appear to Power BI.")


if __name__ == "__main__":
    main()
