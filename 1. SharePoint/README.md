# SharePoint deployment

Run **ValueLens** on **Power BI Pro** — no Fabric capacity, no gateway.
Pick how you get the data in:

| Option | Best for | What you do |
|---|---|---|
| **A — Manual (first run)** ⭐ | A **quick first look** to see how the numbers land, or a one-off refresh. | Export two CSVs by hand → run one [processor script](#option-a--manual-first-run) → connect the **(Local CSV)** template. No app registration, no scheduling. |
| **B — Automated (scheduled script)** | An **ongoing**, scheduled refresh. | Run the [extract script](#option-b--automated-scheduled-script) on a schedule — it pulls the data, rolls it up, writes to SharePoint, and Power BI refreshes automatically. No manual export. |

```
Option A (manual):     [export 2 CSVs] -> [Processor .py] -> [ (Local CSV) PBIT ]
Option B (automated):  [Run-PAX-AIBV] -> [Upload-Rollups-SharePoint] -> [ SharePoint PBIT, scheduled ]
```

Both produce the **same two rollup CSVs** the dashboard reads
(`copilot_interactions_rollup.csv` + `copilot_users_rollup.csv`). Start with **A**, move to **B** when you want it hands-off.

---

## 📚 Dashboard pages

<details>
<summary>13 report pages — activation, adoption, value, maturity, governance &amp; appendices</summary>

| Page | Purpose |
|---|---|
| **◆ Activation** | Activation across teams — licensed vs unlicensed, active vs inactive |
| **🎯 Readiness** | Ranks unlicensed / low-adoption users by upgrade‑priority score |
| **📡 Adoption** | User counts, coverage %, licensed vs unlicensed reach |
| **🪙 Consumption** | Copilot &amp; agent consumption — credits / messages over time |
| **🔮 Activity** | Copilot and agent usage, tasks and behaviour mix |
| **🚀 Value** | Hours saved, dollar‑equivalent assisted value, and the business case |
| **🌱 Maturity** | Progression: Asking → Finding → Consuming → Producing → Delegating |
| **🛡 Agent Health** | Agent resolution, abandonment, escalation and response time |
| **📈 Heatmap** | Activity heatmap across the reporting period |
| **🏅 Leaderboard** | Top users, agents, and functions |
| **📘 Appendix: Glossary** | Metric definitions and research sources |
| **🧬 Appendix: Signal Table** | Trace raw signals through to value (audit trail) |
| **📘 Appendix: Key Concepts** | Methodology and key‑concept explainers |

</details>

---

## Option A — Manual (first run)

> The fastest way to see real numbers — export your data, run one script, connect the template.
> No upload, no app registration. **Great for a first look at how the numbers land.**

<details>
<summary><strong>Manual extract — step by step</strong></summary>

**You need:** any shell, **Python 3.9+**, and read access to the admin exports below.

**1. Export the source files**

The processor takes the raw audit log plus **users** and **licence** info. Org attributes come from
**Entra**; the Copilot **licence** flag comes from the **M365 Admin Center** — they're different
exports, joined on **UPN**. Supply them as two files (recommended) or pre-merged as one:

| Export | Where | Becomes |
|---|---|---|
| Raw **Copilot interactions** (audit log CSV) | Microsoft **Purview** -> Audit -> search `CopilotInteraction` -> Export | `--purview` |
| **Org / users** (UPN, department, job title, manager) | Microsoft **Entra** -> Users -> Export, **or your own org/HR file** ([sample template](./scripts/OrgData-Template.csv)) | `--entra` |
| **Licensing** (UPN + a `Has License` flag) | **M365 Admin Center** -> Copilot user export | `--licensing` |

> **One combined file instead?** If your users export already contains a licence column, pass it as
> `--entra` and **omit** `--licensing` — the licence column is auto-detected.
>
> **Bring your own org data (instead of Entra)?** Copy the
> [sample template](./scripts/OrgData-Template.csv) — the same shape a **Viva Insights** org-data file
> uses — fill in your users, and pass it as `--entra`. Got a messy HR export with different headers?
> Run it through [`scripts/Adapt-OrgFile-To-EntraUsers.py`](./scripts/Adapt-OrgFile-To-EntraUsers.py) first.

**2. Run the processor** ([`scripts/Purview_CopilotInteraction_Processor_v4.0.0.py`](./scripts/Purview_CopilotInteraction_Processor_v4.0.0.py))

```bash
python "scripts/Purview_CopilotInteraction_Processor_v4.0.0.py" \
    --purview    "<raw_copilot_interactions.csv>" \
    --entra      "<entra_users_org.csv>" \
    --licensing  "<m365_copilot_licence_list.csv>" \   # omit if --entra already has a licence column
    --profile    aibv
```

It writes the two rollup CSVs next to your inputs (`*_Interactions_*.csv`, `*_Users_*.csv`).
Run with `--help` for all options (`--out-dir`, `--with-aggregates`, …). Full column expectations
are in [`../2. Fabric/docs/DATA-DICTIONARY.md`](../2.%20Fabric/docs/DATA-DICTIONARY.md).

**3. Connect the template**

Open **`ValueLens - SharePoint (Local CSV).pbit`**, and when prompted point the two
parameters at the rollup CSVs from step 2:

| Parameter | Value |
|---|---|
| Copilot Interactions File | local path to `*_Interactions_*.csv` |
| Org Data File | local path to `*_Users_*.csv` |
| Agent 365 *(optional)* | blank, or a local Agents 365 CSV |

**Load** — done. To refresh, re-export, re-run the processor, and **Refresh** in Desktop.

> Want this on a schedule instead? Upload the same two CSVs to SharePoint (see **Option B → Daily
> refresh → Upload** below) and use the standard `…- SharePoint.pbit` template.

</details>

---

## Option B — Automated (scheduled script)

Scheduled refresh from a SharePoint library: the script extracts + rolls up your data, uploads the
two CSVs to SharePoint, and Power BI refreshes on a schedule. Provision once, then it runs hands-off.

Three helper scripts do the work, in order —
[`Run-PAX-AIBV.ps1`](./scripts/Run-PAX-AIBV.ps1) (extract) →
[`Upload-Rollups-SharePoint.ps1`](./scripts/Upload-Rollups-SharePoint.ps1) (upload) →
[`Register-TaskScheduler.ps1`](./scripts/Register-TaskScheduler.ps1) (schedule).

> **Using your own org data instead of Entra?** Point the extract at your own org/HR file with
> `-UserInfoFile <path|SharePoint-URL|OneLake-path>` — copy the
> [sample template](./scripts/OrgData-Template.csv) (same shape as a Viva Insights org-data file) to
> get started. Only `UserPrincipalName` is required. See the **Daily refresh** step below.

Provision once, then extract + upload on a cadence.

<details>
<summary><strong>Prerequisites</strong></summary>

**On the machine that runs the extract:**
- PowerShell 7+ (`pwsh`) — [install guide](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows). Run scripts with `pwsh`, not Windows PowerShell.
- Internet access to GitHub Releases (the script downloads the current extract tool automatically).
- Python 3.10+ (the script bootstraps it internally for the rollup).

**In your tenant:**
- An Entra app registration with these admin-consented **Microsoft Graph Application** permissions:
  `AuditLogsQuery.Read.All`, `Reports.Read.All`, `User.Read.All`, `Organization.Read.All`, `Sites.Selected`.
  - *Only if you use `-IncludeAgent365Info`* (optional Agent 365 catalogue): also add
    `CopilotPackages.Read.All` + `Application.Read.All`, and an **Agent 365 licence** in the tenant.
- A SharePoint document library to hold the two CSVs.
- A Power BI Pro (or Premium / PPU) workspace to publish into.

You'll need the **Tenant ID**, **Client ID**, and **Client Secret** before you start.
</details>

<details>
<summary><strong>Authentication</strong> — App registration vs Managed identity</summary>

| | **App registration** | **Managed identity** |
|---|---|---|
| **Best when** | Windows host or CI (Task Scheduler, GitHub Actions) | Hosted in Azure (Container Apps Job) |
| **`-Auth`** | `AppRegistration` (secret **or** certificate) | `ManagedIdentity` |
| **Secret to manage** | Yes — or a certificate to avoid rotation | None |
| **SharePoint write** | `Sites.Selected` (per-library, least privilege) | `Sites.Selected` when you own the upload step; the bundled `Deploy-PAXAcaJob.ps1` needs the broader `Sites.ReadWrite.All` + `Files.ReadWrite.All` — an upstream constraint of that script. |
| **Status here** | ✅ Available now | ⏳ Pending the ACA Job — see [`azure-container/`](./azure-container/) |

Both use the **same Graph read permissions**; they differ only in how the identity signs in. Run
**one** option, never both. The rest of this guide uses the app registration via
[`Register-TaskScheduler.ps1`](./scripts/Register-TaskScheduler.ps1).
</details>

<details>
<summary><strong>One-time setup</strong></summary>

**1. Grant the app write access to your SharePoint site** — [`ProvisionSiteAccess-SP-AppReg.ps1`](./scripts/ProvisionSiteAccess-SP-AppReg.ps1)
```powershell
cd scripts
.\ProvisionSiteAccess-SP-AppReg.ps1 `
    -TenantId "<tenant-id>" -SiteHost "<tenant>.sharepoint.com" `
    -AppClientId "<client-id>" -AppDisplayName "<app-name>"
```
Save the **SiteId** and **DriveId** it prints — the upload step needs both.

**2. Stash the client secret** (optional, recommended)
```powershell
cmdkey /generic:PAX-AIBV-<tenant-id> /user:app /pass:<client-secret>
```
The scripts read it from here at runtime.
</details>

<details>
<summary><strong>Daily refresh</strong> — extract → upload → schedule</summary>

### Extract — [`Run-PAX-AIBV.ps1`](./scripts/Run-PAX-AIBV.ps1)

**Seed once, then append.** The Purview interactions data is a growing time-series, so the pattern is:
a **first back-fill run** to create the file, then **automated short-window append runs** on a schedule.

```powershell
cd scripts
# 1. First run — seed the interactions file with a back-fill (no -AppendFile)
.\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 30

# 2. Subsequent (scheduled) runs — append only the latest window
.\Run-PAX-AIBV.ps1 -TenantId <tenant-id> -ClientId <client-id> -Days 2 `
    -AppendFile Purview_CopilotInteraction_Rollup.csv
```
The append de-duplicates on each interaction's stable message identity, so overlapping days
reconcile — nothing dropped or double-counted. **Interactions append; the Users/org
and Agent 365 outputs are snapshots (overwritten each run).**

> **Upgrading from an older run?** If you already have an append file from a previous version, start a
> **fresh** output file and re-run your full date range — earlier versions could under-count on append.
> Nothing is lost: your source data is still queryable, so re-running rebuilds the complete picture.

Produces `.\processed\*_Interactions_*.csv`, `.\processed\*_Users_*.csv`, and `rollup-manifest.json`
(5–15 min for 30 days). Add `-IncludeAgent365Info` for the optional Agents 365 output — this runs
**app-only/unattended** under your `-Auth` mode (needs
`CopilotPackages.Read.All` + `Application.Read.All` and an Agent 365 licence; a missing licence
returns `403`). To supply your own user directory instead of pulling it live from Entra, add
`-UserInfoFile <path|SharePoint-URL|OneLake-path>` (BYOD; `UserPrincipalName` required, other columns
optional/alias-aware). For privacy-restricted tenants, pair it with `-Deidentify` to anonymise user
identities. See [`scripts/README.md`](./scripts/README.md) for all parameters.

### Upload — [`Upload-Rollups-SharePoint.ps1`](./scripts/Upload-Rollups-SharePoint.ps1)
```powershell
.\Upload-Rollups-SharePoint.ps1 `
    -Manifest .\processed\rollup-manifest.json `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' -FolderPath '/AIBV'
```
Lands as fixed names `copilot_interactions_rollup.csv` + `copilot_users_rollup.csv` (overwrites the previous run).

### Schedule — [`Register-TaskScheduler.ps1`](./scripts/Register-TaskScheduler.ps1)
Seed the interactions file once manually (the back-fill run above), then register the daily task with
`-AppendFile` so each run appends only the latest window:
```powershell
.\Register-TaskScheduler.ps1 `
    -TenantId <tenant-id> -ClientId <client-id> `
    -SiteId '<host>,<siteguid>,<webguid>' -DriveId 'b!...' `
    -FolderPath '/AIBV' -Days 2 -AppendFile Purview_CopilotInteraction_Rollup.csv -RunAt '02:00'
```
Add `-RunAsUser DOMAIN\svc_aibv` for a service account. Runs under the app registration; the secret
is **not** stored in the task. (Secretless managed-identity scheduling is WIP — see [`azure-container/`](./azure-container/).)
</details>

<details>
<summary><strong>Connect the template</strong> (SharePoint refresh)</summary>

1. Open **`ValueLens - SharePoint.pbit`** in Power BI Desktop.
2. **Transform data → Edit parameters**:

   | Parameter | Value |
   |---|---|
   | Copilot Interactions File | `https://<tenant>.sharepoint.com/.../copilot_interactions_rollup.csv` |
   | Org Data File | `https://<tenant>.sharepoint.com/.../copilot_users_rollup.csv` |
   | Agent 365 *(optional)* | blank, or a SharePoint URL to your Agents 365 export |

3. **Load** → **Publish** to a Power BI workspace.
4. In Power BI Service: dataset **Settings → Data source credentials** → sign in to SharePoint, **Privacy: None**.
5. **Scheduled refresh** → enable, set to run after your extract (e.g. extract 02:00, refresh 04:00).

> **Using your own org data (BYOD)?** If you ran the extract with `-UserInfoFile`, your directory
> still lands in the same `copilot_users_rollup.csv` — so **this template step is unchanged**: point
> `Org Data File` at that file exactly as above. Nothing else to configure.
</details>

---

## What's in this folder

| Item | Purpose |
|---|---|
| `ValueLens - SharePoint.pbit` | The dashboard template (refreshes from SharePoint URLs). |
| `ValueLens - SharePoint (Local CSV).pbit` | Same dashboard, parameters take **local** CSV paths — used by **Option A**. |
| [`scripts/`](./scripts/) | Extract / upload / schedule helpers + the manual processor. See [`scripts/README.md`](./scripts/README.md). |
| [`azure-container/`](./azure-container/) | Planned ACA Job for secretless managed-identity scheduling (WIP). |

---

<details>
<summary><strong>Troubleshooting</strong></summary>

| Symptom | Fix |
|---|---|
| `python: command not found` | Install Python 3.10+ and retry. |
| `0 records returned` | `AuditLogsQuery.Read.All` consent missing — re-grant in Entra. |
| Masked UPNs (32-char hex) | M365 Admin → Org settings → Reports → untick "Display concealed names". |
| `403 Forbidden` on upload | App lacks per-site write — re-run [`ProvisionSiteAccess-SP-AppReg.ps1`](./scripts/ProvisionSiteAccess-SP-AppReg.ps1). |
| `404 Not Found` on upload | `-FolderPath` doesn't exist in SharePoint — create it, or use `/` for the library root. |
| Refresh hits 1 GB / 2-hour cap | Move to [`../2. Fabric/`](../2.%20Fabric/) for high-volume tenants. |
</details>
