# Azure Container Apps Job (WIP)

> [!NOTE]
> **Status: planned.** PAX's prebuilt container image
> ([`microsoft/PAX/fabric_resources/Dockerfile/`](https://github.com/microsoft/PAX/tree/release/fabric_resources/Dockerfile))
> supports SharePoint as a native output tier — confirmed in PAX 1.11.4's
> own header comments and `.EXAMPLE` blocks. But its embedded post-processor
> is **v3.1.0** (33-column rollup schema), and the AIBV PBIT in this folder
> needs the **v4.0.0** schema (50 columns, includes `Agent Filter` Cowork
> tagging, value outcomes, behavior categories).
>
> So a vanilla PAX container shipped to SharePoint wouldn't produce CSVs the
> AIBV PBIT can directly consume.

## Planned design

A thin custom image **layered on top of PAX's**, kept upstream-compatible:

```dockerfile
FROM ghcr.io/microsoft/pax-purview:1.11.4   # or your ACR tag
COPY Purview_CopilotInteraction_Processor_v4.0.0.py /app/
COPY entrypoint.ps1 /app/
ENTRYPOINT ["pwsh", "-File", "/app/entrypoint.ps1"]
```

`entrypoint.ps1` chains:
1. PAX → scratch (`-OutputPath /tmp/pax-out`)
2. v4.0.0 processor → SharePoint (`copilot_interactions_rollup.csv` + `copilot_users_rollup.csv`)

Deploy as ACA Job with:
- **Managed identity** for auth (no client secret rotation)
- Cron trigger (e.g. daily at 02:00 UTC)
- Sites.Selected grant on the target SharePoint library (already provisioned
  by [`../scripts/ProvisionSiteAccess-SP-AppReg.ps1`](../scripts/ProvisionSiteAccess-SP-AppReg.ps1))

## What this folder will contain when shipped

| File | Purpose |
|---|---|
| `Dockerfile` | The thin layer over `microsoft/PAX`. |
| `entrypoint.ps1` | Orchestration: PAX → v4.0.0 processor → SharePoint upload. |
| `Deploy-AcaJob.ps1` | One-shot deployment: ACR build/push + ACA Job + managed identity. Modelled on PAX's own [`Deploy-PAXAcaJob.ps1`](https://github.com/microsoft/PAX/blob/release/fabric_resources/Deploy/Deploy-PAXAcaJob.ps1). |
| `Grant-Permissions.ps1` | One-time per-tenant: API permissions + `Sites.Selected` grant + UAMI Sites.Selected role assignment. |

## Until this lands

Use one of the scheduling options the [folder README](../README.md#scheduling)
documents:

- **Windows Task Scheduler** — see
  [`../scripts/Register-TaskScheduler.ps1`](../scripts/Register-TaskScheduler.ps1)
- **GitHub Actions** — `.yml` workflow that runs `Run-PAX-AIBV.ps1` +
  `Upload-Rollups-SharePoint.ps1` on a `schedule:` cron

## Why not just use PAX's `Deploy-PAXAcaJob.ps1` as-is?

It deploys a vanilla PAX container whose embedded post-processor is v3.1.0
(33-col schema). The AIBV PBIT in this repo expects the v4.0.0 schema (50 cols).
Without the v4.0.0 layer the rollup CSVs won't have:

- `Agent Filter` with Cowork tagging
- `Value Outcome` classifications
- Most of the behavior-category and signal-to-value attribution columns

That's why this needs a small custom layer rather than a straight reuse.

## Tracking

Open an issue tagged `azure-container` if you'd like to help land this.
