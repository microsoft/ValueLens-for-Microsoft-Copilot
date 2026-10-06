# Power Automate + Dataverse setup

This preview path is for customers who use a compatible Power Automate `CopilotInteractionLogging` collector and want ValueLens to read curated Dataverse snapshots.

## You need

- An isolated Power Platform environment with Dataverse, Power Automate premium/Dataverse licensing, enough Dataverse database capacity, and access to a Power BI workspace.
- An authorized local unmanaged `CopilotInteractionLogging.zip` collector package supplied outside this repository.
- A deployment user, Entra app, and Dataverse application user with the full least-privilege access in [`../docs/PERMISSIONS.md`](../docs/PERMISSIONS.md).
- PowerShell 7+, Python 3.10+, Power BI Desktop, and a commercial-cloud Dataverse URL such as `https://contoso.crm.dynamics.com`.

## Setup
Run the commands from this folder:

```powershell
Set-Location ".\2. Power Automate + Dataverse\scripts"
```

Keep private ZIP files, tokens, secrets, and run data outside the repository.

### 1. Check the workstation

```powershell
.\Test-PowerAutomateDataverse-Preflight.ps1 `
  -DataverseUrl 'https://contoso.crm.dynamics.com' `
  -RequirePac
```

Use `-RequirePac` on the computer that imports the solution. Omit it only for local checks that do not import.

### 2. Create the Dataverse core tables

Dry run first:

```powershell
python .\Deploy-DataverseCoreSchema.py `
  --dataverse-url 'https://contoso.crm.dynamics.com'
```

For the live schema write, set `DATAVERSE_TOKEN` in the process environment, then run:

```powershell
python .\Deploy-DataverseCoreSchema.py `
  --dataverse-url 'https://contoso.crm.dynamics.com' `
  --execute
```

This creates or verifies `poc_valuelensrawaudits`, `poc_valuelensinteractions`, `poc_valuelensusers`, and `poc_valuelensruns`.

### 3. Prepare and import the collector

Create the raw-retention copy of your unmanaged collector package:

```powershell
python .\Prepare-CollectorRawCapture.py `
  --source-zip 'C:\PrivateSolutions\CopilotInteractionLogging.zip' `
  --out-zip 'C:\PrivateSolutions\ValueLens\CopilotInteractionLoggingRaw.zip'
```

Import `CopilotInteractionLoggingRaw.zip` into the isolated environment with Power Platform solution import or `pac solution import`.

Before import:

1. Generate PAC settings from that exact ZIP with `pac solution create-settings`.
2. Bind the package connection references.
3. Set the collector tenant, app, authentication, and lookback environment variables.
4. Use [`scripts/power-automate-dataverse.settings.json.example`](scripts/power-automate-dataverse.settings.json.example) only as a checklist. It is not a ready PAC settings file.

Keep the flow disabled until the connections and variables are correct. Then run the manual collector/backfill once and confirm the flow run completed before enabling its daily schedule.

### 4. Build a Dataverse snapshot

Dry run first:

```powershell
.\Invoke-DataverseCoreRefresh.ps1 `
  -TenantId '<tenant-guid>' `
  -ClientId '<app-client-guid>' `
  -EnvironmentUrl 'https://contoso.crm.dynamics.com' `
  -WorkRoot 'C:\ValueLensRuns'
```

For a live run, provide `AZURE_CLIENT_SECRET` through a secret store or process environment, then add `-Execute`:

```powershell
.\Invoke-DataverseCoreRefresh.ps1 `
  -TenantId '<tenant-guid>' `
  -ClientId '<app-client-guid>' `
  -EnvironmentUrl 'https://contoso.crm.dynamics.com' `
  -WorkRoot 'C:\ValueLensRuns' `
  -Execute
```

The script prints the successful run ID. That value is the Power BI `Core Snapshot ID`.

The snapshot runs the [Local CSV processor](../4.%20Local%20CSV/scripts/), so it carries the six
[agent-type columns](../docs/DATA-DICTIONARY.md#agent-type-and-publisher). Snapshots built before
those columns were added still load: the template classifies their rows in Power Query from the
agent ID, name and AppIdentity only, so more rows can land in **Unclassified agents**. Build a new
snapshot to get the full classification.

If retained raw rows include cancelled, partial, or overlapping collector runs, pin the snapshot to one completed collector run and its audited UTC window:

```powershell
.\Invoke-DataverseCoreRefresh.ps1 `
  -TenantId '<tenant-guid>' `
  -ClientId '<app-client-guid>' `
  -EnvironmentUrl 'https://contoso.crm.dynamics.com' `
  -WorkRoot 'C:\ValueLensRuns' `
  -Execute `
  -SourceRunId '<completed-flow-run-id>' `
  -RawStartUtc '2026-07-05T18:51:53.556Z' `
  -RawEndUtc '2026-07-12T18:51:53.556Z'
```

### 5. Open the Power BI template

Open `ValueLens - Power Automate + Dataverse.pbit` and set:

| Parameter | Setting |
|---|---|
| `Dataverse URL` | Your Dataverse environment origin. |
| `Core Snapshot ID` | The successful run ID from step 4. |
| `Use SharePoint CSV fallback` | `false`. |
| `Copilot Interactions File` | Leave blank unless you intentionally use CSV fallback. |
| `Org Data File` | Leave blank unless you intentionally use CSV fallback. |
| `Agent 365` | Optional SharePoint URL to `agents_365.csv` from [`Get-Agents365Registry.ps1`](../3.%20SharePoint/scripts/Get-Agents365Registry.ps1) or [`Upload-Rollups-SharePoint.ps1 -Agents365Csv`](../3.%20SharePoint/scripts/Upload-Rollups-SharePoint.ps1). |
| `Feedback File` | Optional SharePoint URL to the Microsoft 365 admin centre feedback export. |

Publish the report. Set organizational credentials for Dataverse, and for SharePoint only if you use optional SharePoint URLs or CSV fallback.

## Refresh and keep it running

1. Let the Power Automate collector complete first.
2. Schedule `Invoke-DataverseCoreRefresh.ps1` after the collector. Use `-Execute`.
3. Capture the new run ID from the scheduled runner output.
4. Manually update the Power BI parameter `Core Snapshot ID` to that new run ID.
5. Refresh the Power BI semantic model.

For Task Scheduler, run `pwsh.exe -NoProfile -File "C:\ValueLens\2. Power Automate + Dataverse\scripts\Invoke-DataverseCoreRefresh.ps1" -TenantId "<tenant-guid>" -ClientId "<app-client-guid>" -EnvironmentUrl "https://contoso.crm.dynamics.com" -WorkRoot "C:\ValueLensRuns" -Execute`. Store `AZURE_CLIENT_SECRET` for the task account outside the arguments.

The runner does not update Power BI parameters, trigger Power BI refresh, or delete old snapshots. Do not delete snapshots that reports still use.

## Troubleshooting

| Issue | What to do |
|---|---|
| Preflight says `pac` is missing | Install Power Platform CLI on the import computer, or rerun without `-RequirePac` for local checks only. |
| Schema deployment fails | Confirm `DATAVERSE_TOKEN`, the commercial-cloud `https://<org>.crm[region].dynamics.com` URL, and the schema customization privileges in [`../docs/PERMISSIONS.md`](../docs/PERMISSIONS.md). |
| Collector import fails | Regenerate settings from the exact adapted ZIP, bind all connection references, and check the collector environment variables. |
| Snapshot build cannot read Graph or Dataverse | Check Graph consent, `AZURE_CLIENT_SECRET`, the Dataverse application user, and Dataverse table privileges. |
| Snapshot includes partial data | Re-run with `-SourceRunId`, `-RawStartUtc`, and `-RawEndUtc` from one completed collector run. |
| PBIT refuses a snapshot | Use a completed `Core Snapshot ID` from `poc_valuelensruns`; all core tables must have matching row counts for that run. |
| Dashboard does not change after the schedule runs | Manually advance `Core Snapshot ID` to the new run ID, then refresh Power BI. |
| Agent catalogue details are blank | Provide an `Agent 365` URL to `agents_365.csv`; audit data alone does not create that catalogue. |
| A large audit row fails to write | Dataverse memo fields reject payloads above 1,048,576 characters. The helper fails rather than truncates. |

## Optional add-on

For credit consumption and cost reporting, use the separate [`Add Credit Consumption/`](Add%20Credit%20Consumption/README.md) add-on.
