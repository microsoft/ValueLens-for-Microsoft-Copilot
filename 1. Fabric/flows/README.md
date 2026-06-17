# Copilot Credit Consumption — Automated Landing Flows

These two Power Automate flows remove the **manual export → save** step for the Power Platform
message-consumption reports (`EntitlementConsumption*_MCSMessages_*.csv`). They drop the CSVs
straight into the Fabric Lakehouse at **`Files/credit_consumption/`**, where
`../notebooks/Copilot_Credit_Consumption_Ingester.ipynb` picks them up on its next run.

```
                       ┌─ Email arrives with CSV ─┐
Power Platform export ─┤                          ├─▶ OneLake  Files/credit_consumption/*.csv ─▶ Ingester notebook ─▶ Delta
                       └─ Dropped to SharePoint ──┘
```

| File | When to use |
| --- | --- |
| `Copilot_Consumption_Email_to_OneLake.json` | The reports arrive by **email** (e.g. the customer mails the export, or a scheduled PPAC export is mailed). |
| `Copilot_Consumption_SharePoint_to_OneLake.json` | The customer prefers a **governed SharePoint document library** drop folder. |
| `Copilot_ProductFeedback_Email_to_OneLake.json` | **Same pattern, different source.** Lands the **Microsoft 365 Copilot user product feedback** export (Admin Center → Health → Product Feedback → Export) into `Files/product_feedback/`. See [Generalising to other export-only sources](#generalising-to-other-export-only-sources) below. |

Both write to OneLake with the **DFS (ADLS Gen2) three-step pattern**: `PUT ?resource=file` →
`PATCH ?action=append` → `PATCH ?action=flush`.

## Import & configure

1. **Power Automate** → *My flows* → *Import* → *Import Package (Legacy)* or paste the definition into a new flow.
2. Re-create the connection the trigger needs:
   - Email flow → **Office 365 Outlook** connection.
   - SharePoint flow → **SharePoint** connection.
3. Set the flow **parameters**:
   - `OneLakeWorkspace` — Fabric workspace name or GUID (e.g. `Copilot Analytics Demo`).
   - `OneLakeLakehouse` — lakehouse name **without** the `.Lakehouse` suffix (e.g. `CopilotAdoptionLake`).
   - `TargetFolder` — keep `Files/credit_consumption` (must match `SOURCE_DIR` in the ingester notebook).
   - `TenantId`, `ClientId`, `ClientSecret` — identity used for the OneLake calls (see below).
   - Email flow only: `SubjectFilter` (default `Copilot Usage Dashboard`).
   - SharePoint flow only: `SharePointSite`, `SharePointLibrary`, `SharePointFolder`.

## OneLake write permission (the one real prerequisite)

The HTTP actions authenticate with **Azure AD OAuth, audience `https://storage.azure.com/`**.
The identity in `ClientId` must be able to **write** to the workspace's OneLake:

- Add the **app registration** (or a **workspace identity** / service principal) as a
  **Member or Contributor** on the **Fabric workspace** that holds the lakehouse.
- Put the secret in **Azure Key Vault** and reference it — don't ship a literal `ClientSecret`.
- Tenant setting **“Service principals can use Fabric APIs”** must be enabled for the SP route.

> Prefer not to use an app secret? Swap the three `Http` actions for the **OneLake / Azure Blob
> connector** actions and authenticate the connection interactively — the create/append/flush
> URIs stay identical.

## Idempotency / re-runs

Microsoft's export filenames already carry the day-window + a `(1)` suffix on re-download, so
re-landing is safe: the ingester runs with `WRITE_MODE='overwrite'` (full snapshot) by default and
`unionByName`s every file in the folder. If you switch the notebook to `'append'`, prune the folder
(or dedupe on `SourceFile`) between loads.

## Not all customers will send consumption data

That's expected. If `Files/credit_consumption/` is empty, the ingester writes **empty, correctly-named**
tables and the PBIP's **`Enable_Consumption = "Exclude"`** toggle keeps the billing visuals dormant —
the transcript-native `Total Cost Units` (displayedCost) view keeps working regardless.

> The optional-source toggles are **list parameters** with the values `"Include"` / `"Exclude"`
> (not `true`/`false`). Set `Enable_Consumption` to `"Include"` once the data is landing.

## Generalising to other export-only sources

This flow pattern works for **any Microsoft report that has no API** — i.e. anything you can only
get by clicking "Export" / "Download" in an admin portal. The OneLake landing mechanism
(`PUT → append → flush`) is identical; only the **trigger filter** and the **target folder** change.

The clearest example is **Microsoft 365 Copilot user product feedback** (the thumbs up/down +
verbatim comments users leave on Copilot responses). As of 2026 this is **export-only** — there is
**no Graph or REST API** for the raw feedback. It lives in the **Microsoft 365 Admin Center →
Health → Product Feedback**, where an admin can *view / export / delete* it, and nothing else.
(The only programmatic feedback signal anywhere is an **aggregate** satisfaction % in the Viva
Insights Copilot Dashboard — no verbatims, no per-user rows.)

So feedback is landed exactly like credit consumption:

| | Credit consumption | Product feedback |
| --- | --- | --- |
| Source portal | Power Platform Admin Center | M365 Admin Center → Health → Product Feedback |
| API available? | ❌ export-only | ❌ export-only |
| Flow | `Copilot_Consumption_Email_to_OneLake.json` | `Copilot_ProductFeedback_Email_to_OneLake.json` |
| Lands in | `Files/credit_consumption/` | `Files/product_feedback/` |
| Model table | `Credit Consumption (Agent/User/Tenant)` | `ProductFeedback` (`user_feedback` Delta) |
| Toggle | `Enable_Consumption` | `Enable_ProductFeedback` |

**To finish the feedback path** you also need an **ingester notebook** that reads
`Files/product_feedback/*.csv` and writes the `user_feedback` Delta table (the 23-column contract
the `ProductFeedback` model table expects). Clone `../notebooks/Copilot_Credit_Consumption_Ingester.ipynb`,
point `SOURCE_DIR` at `Files/product_feedback`, and map the export's columns to the
`user_feedback` schema in [`../docs/DATA-DICTIONARY.md`](../docs/DATA-DICTIONARY.md).
The same case-preserving column sanitiser (`[^0-9A-Za-z]+ → _`) keeps the names matching the model.
