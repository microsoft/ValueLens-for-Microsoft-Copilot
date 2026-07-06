# SharePoint scripts

One flat set: two **one‑time setup** scripts, then the **data extractors** you run on a schedule.
All authenticate with an Entra **app registration** (service principal) so they can run unattended.

## Run order

| # | Script | When | What it does |
|---|---|---|---|
| **Setup (once)** | `ProvisionPreReqs.ps1` | Once per tenant, as Global Admin | Creates the app registration + grants the Graph permissions. |
| **Setup (once)** | `ProvisionSiteAccess-SP-AppReg.ps1` | Once per tenant + site | Grants the app `Sites.Selected` write access to your SharePoint site; prints the **SiteId** and **DriveId** the extractors need. |
| 1 | `CreateAuditLogQuery-AppReg.ps1` | Each run | Starts the Purview audit‑log query for the date range. |
| 2 | `GetCopilotInteractions-SP-AppReg.ps1` | Each run *(≈30 min after step 1)* | Fetches results, flattens to 15 cols → uploads `copilot_interactions.csv`. |
| 3 | `GetCopilotUsers-SP-AppReg.ps1` | Each run | Licensed users + Copilot flag → `copilot_licensed_users.csv`. |
| 4 | `Get-EntraOrgData-SP-AppReg.ps1` | Each run | Org structure (manager, dept, location) → `org_data.csv`. |
| Optional | `Get-Agents365Registry.ps1` | As needed | Exports the Agents 365 registry (if licensed). |

Each extractor writes a **fixed filename** and **overwrites** it every run, so the template's single
SharePoint URLs always stay valid.

## Two ways to run them

1. **Your own scheduler** *(simplest)* — Task Scheduler, cron, or GitHub Actions calling these scripts
   with the app‑reg credentials. Or just run them by hand for a one‑off refresh.
2. **Azure Automation** *(turnkey)* — see [`../azure-automation/`](../azure-automation/) for Bicep that
   stands up a managed‑identity Automation Account and wires these in as runbooks on a schedule.

## Troubleshooting

See the parent [`README.md`](../README.md#common-errors) for the full error table (permissions,
upload 403/404, masked UPNs, etc.).
