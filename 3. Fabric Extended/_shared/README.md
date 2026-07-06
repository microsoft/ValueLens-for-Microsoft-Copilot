# _shared — core Fabric notebooks (mirrored from `2. Fabric`)

These are **byte-identical copies** of the seven core ingesters shipped under
[`2. Fabric/notebooks/`](../../2.%20Fabric/notebooks/). They live here so every
`3. Fabric Extended/*` add-on is **self-contained** — you can download or clone a
single add-on folder and stand it up without reaching back into the base path.

## Files

| Notebook | Purpose |
|---|---|
| `Copilot_Audit_Log_Direct_Ingester.ipynb` | Purview-style Copilot chat + agent interaction audit logs → `dbo.audit_logs` |
| `Copilot_Licensed_Users_Direct_Ingester.ipynb` | Microsoft 365 Copilot licence assignments → `dbo.licensed_users` |
| `Copilot_Org_Data_Direct_Ingester.ipynb` | Entra user + manager hierarchy → `dbo.org_data` |
| `Copilot_ProductFeedback_Ingester.ipynb` | OCV product feedback exports → `dbo.product_feedback` |
| `Copilot_Cost_Consumption_Ingester.ipynb` | Monthly Copilot cost/consumption → `dbo.cost_consumption` |
| `Copilot_Agent365_Registry_Ingester.ipynb` | Agent 365 registry via Graph (app-only, GA) → `dbo.agents_365` |
| `Copilot_Agent365_Lander.ipynb` | Optional Agent 365 CSV lander → `dbo.agents_365` |

## Do not edit here

The **source of truth is `2. Fabric/notebooks/`**. Edit there, then run:

```powershell
.\scripts\sync-shared.ps1
```

from the repo root. The script overwrites the copies in every `_shared/`
directory and each add-on's `notebooks/_core/`. CI runs the same script in
check mode on every push and fails the build if drift is detected.
