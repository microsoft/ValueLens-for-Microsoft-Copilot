# Automated OneLake Landing Flows

These Power Automate flows remove the **manual export → save** step for Microsoft's
**export-only** reports (the ones with no API — you can only click *Export* / *Download*
in an admin portal). They drop the CSVs straight into the Fabric Lakehouse, where the
matching ingester notebook picks them up on its next run. The same landing mechanism
(`PUT → append → flush`) is reused across every export-only source.

```
                       ┌─ Email arrives with CSV ─┐
Admin portal export ───┤                          ├─▶ OneLake  Files/<target>/*.csv ─▶ Ingester notebook ─▶ Delta
                       └─ Dropped to SharePoint ──┘
```

## Flows in this folder

| File | Source | Lands in | Details |
| --- | --- | --- | --- |
| `Copilot_CostConsumption_Email_to_OneLake.json` | **MAC Cowork / Work IQ** credit consumption (mailed export) | `Files/cost_consumption/` | [`COST-CONSUMPTION.md`](./COST-CONSUMPTION.md) |
| `Copilot_CostConsumption_SharePoint_to_OneLake.json` | **MAC Cowork / Work IQ** credit consumption (SharePoint drop) | `Files/cost_consumption/` | [`COST-CONSUMPTION.md`](./COST-CONSUMPTION.md) |
| `Copilot_ProductFeedback_Email_to_OneLake.json` | **M365 Copilot user product feedback** (Admin Center → Health → Product Feedback → Export) | `Files/product_feedback/` | [below](#generalising-to-other-export-only-sources) |

All write to OneLake with the **DFS (ADLS Gen2) three-step pattern**: `PUT ?resource=file` →
`PATCH ?action=append` → `PATCH ?action=flush`.

> **Power Platform Admin Center (PPAC) credit-consumption flows have moved.** The
> `Copilot_Consumption_*` flows and their setup guide now live with the fuller template in
> [`../../3. Fabric Extended/Fabric + Copilot Studio/flows/`](../../3.%20Fabric%20Extended/Fabric%20+%20Copilot%20Studio/flows/README.md).
> Add them only if you deploy the *Fabric + Copilot Studio* build.

## Import & configure

1. **Power Automate** → *My flows* → *Import* → *Import Package (Legacy)* or paste the definition into a new flow.
2. Re-create the connection the trigger needs:
   - Email flow → **Office 365 Outlook** connection.
   - SharePoint flow → **SharePoint** connection.
3. Set the flow **parameters**:
   - `OneLakeWorkspace` — Fabric workspace name or GUID (e.g. `<your-workspace>`).
   - `OneLakeLakehouse` — lakehouse name **without** the `.Lakehouse` suffix (e.g. `<your-lakehouse>`).
   - `TargetFolder` — the landing folder for this source (e.g. `Files/cost_consumption` or
     `Files/product_feedback`). Must match `SOURCE_DIR` in the source's ingester notebook.
   - `TenantId`, `ClientId`, `ClientSecret` — identity used for the OneLake calls (see below).
   - Email flow only: `SubjectFilter` (the subject line the export is mailed under).
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
re-landing is safe: the ingesters run with `WRITE_MODE='overwrite'` (full snapshot) by default and
`unionByName` every file in the folder. If you switch a notebook to `'append'`, prune the folder
(or dedupe on `SourceFile`) between loads.

## Not all customers will send every source

That's expected. If a landing folder is empty, its ingester writes **empty, correctly-named**
tables and the PBIP's matching `Enable_*` toggle keeps those visuals dormant — the rest of the
dashboard keeps working regardless. Set the toggle to `"Include"` once the data is landing.

> The optional-source toggles are **list parameters** with the values `"Include"` / `"Exclude"`
> (not `true`/`false`).

## Generalising to other export-only sources

This flow pattern works for **any Microsoft report that has no API** — i.e. anything you can only
get by clicking "Export" / "Download" in an admin portal. The OneLake landing mechanism
(`PUT → append → flush`) is identical; only the **trigger filter** and the **target folder** change.

The clearest in-folder example is **Microsoft 365 Copilot user product feedback** (the thumbs
up/down + verbatim comments users leave on Copilot responses). As of 2026 this is **export-only** —
there is **no Graph or REST API** for the raw feedback. It lives in the **Microsoft 365 Admin Center →
Health → Product Feedback**, where an admin can *view / export / delete* it, and nothing else.
(The only programmatic feedback signal anywhere is an **aggregate** satisfaction % in the Viva
Insights Copilot Dashboard — no verbatims, no per-user rows.)

So feedback is landed exactly like the MAC cost export:

| | Cost consumption (MAC) | Product feedback |
| --- | --- | --- |
| Source portal | M365 Admin Center → Copilot → Cost management | M365 Admin Center → Health → Product Feedback |
| API available? | ❌ export-only | ❌ export-only |
| Flow | `Copilot_CostConsumption_Email_to_OneLake.json` | `Copilot_ProductFeedback_Email_to_OneLake.json` |
| Lands in | `Files/cost_consumption/` | `Files/product_feedback/` |
| Model table | `Cost Consumption` (`copilot_cost_consumption` Delta) | `ProductFeedback` (`user_feedback` Delta) |
| Toggle | `Enable_CostConsumption` | `Enable_ProductFeedback` |

**To finish the feedback path** you also need an **ingester notebook** that reads
`Files/product_feedback/*.csv` and writes the `user_feedback` Delta table (the 23-column contract
the `ProductFeedback` model table expects). Clone `../notebooks/Copilot_Cost_Consumption_Ingester.ipynb`,
point `SOURCE_DIR` at `Files/product_feedback`, and map the export's columns to the
`user_feedback` schema in [`../docs/DATA-DICTIONARY.md`](../docs/DATA-DICTIONARY.md).
The same case-preserving column sanitiser (`[^0-9A-Za-z]+ → _`) keeps the names matching the model.
