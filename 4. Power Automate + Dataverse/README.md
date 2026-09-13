# 4. Power Automate + Dataverse

**Additional preview pathway, same ValueLens dashboard.** The original Local CSV,
SharePoint and Fabric templates are unchanged. This template reads its required
interaction and user/licence feeds from Dataverse instead of SharePoint CSVs.
A representative bounded interval has been exercised through live solution import,
manual collection, scoped snapshot publication and a full Power BI Desktop model
refresh. This remains a preview, not a production-scale or unattended-refresh certification.

This is **not a flow-only deployment**. Power Automate collects the records;
a scheduled PowerShell/Python runner uses the existing ValueLens processor to
prepare them. That preserves the existing classification and value calculations
rather than approximating them from incomplete audit summaries.

```text
Compatible CopilotInteractionLogging collector package, with local raw-retention extension
  -> Dataverse: full original audit records
  -> ValueLens processor bridge <--- Graph users + assigned Copilot licences
  -> Dataverse: immutable interactions/users snapshot + completed run manifest
  -> ValueLens - Power Automate + Dataverse.pbit

Optional: compatible SharePointAgentLogging -> Dataverse SharePoint-agent inventory
```

## Collector package compatibility

The local package adapter **extends a separately supplied authorized interaction
collector package**: it retains the existing audit query, polling, pagination,
connections and summary writes, then adds full-record retention and gates its
success counter on that write. It does not copy private flow definitions into
this repository. Supply an authorized local **unmanaged**
`CopilotInteractionLogging.zip`; the adapted ZIP and SHA-256 provenance are
written outside the repository.

The optional SharePoint inventory uses a compatible
`SharePointAgentLogging` solution and `poc_sharepointagents` contract. Its
observed file IDs can be joined to decoded `SPO_*` interaction IDs, **never
agent display names**. Unmatched agents remain unmatched.

Existing `poc_copilotinteractions` summaries do not retain the original message
IDs and all resource detail required by ValueLens. The extension keeps the
**full original Graph audit record**, not a reconstruction of those summaries.
Existing history needs a full-payload backfill within available audit retention.

See [NOTICE.md](NOTICE.md) for component-boundary guidance and
[source-map.json](source-map.json) for required sources, optional sources and
unsupported signals.

## Prerequisites

| Component | Required configuration |
|---|---|
| Power Platform | An isolated demo environment with Dataverse, sufficient database capacity, and appropriate Power Automate premium/Dataverse licensing. |
| Collector | A separately supplied authorized local unmanaged interaction solution and its documented connections/environment variables. Optional separate compatible SharePoint-agent solution. |
| Audit API | App-only Graph `AuditLogsQuery.Read.All`, admin consent, and available CopilotInteraction audit records. No Agent 365 licence is required for audit collection. |
| Directory API | App-only Graph `User.Read.All` and `Organization.Read.All` for users and subscribed SKUs. |
| Dataverse identity | An application user for the runner's Entra app, with privileges to read raw rows and create/read/update the four companion tables. Consent to Graph does **not** grant Dataverse access. |
| Schema setup | A deployment identity allowed to customize Dataverse tables, columns and alternate keys. Runtime processing does not need those customization privileges. |
| Runner | PowerShell 7+, Python 3.10+, network access to Graph/Dataverse, and protected local working storage. No Python third-party packages are required. |
| Power BI | Desktop to configure/publish the template; appropriate service/workspace licence and Dataverse read access for the refresh identity. No on-premises gateway is needed for the cloud sources. |

Use commercial-cloud `https://<org>.crm[region].dynamics.com` environment origins.
Sovereign-cloud endpoints are not supported by the current runner.

## Setup

Run commands from this pathway's `scripts` directory. Paths below are examples;
keep private solution packages, deployment settings, credentials and tenant data
outside the repository.

### 1. Check local prerequisites

```powershell
.\Test-PowerAutomateDataverse-Preflight.ps1 `
  -DataverseUrl 'https://contoso.crm.dynamics.com' -RequirePac
```

`pac` is needed for solution import, not for template generation or local
processor use. Omitting `-RequirePac` permits core build checks without the CLI.

### 2. Provision the four companion tables

```powershell
# Dry run: no network calls or credentials.
python .\Deploy-DataverseCoreSchema.py `
  --dataverse-url 'https://contoso.crm.dynamics.com'
```

After approving the target environment and privileges, obtain its Dataverse
access token securely in process environment variable `DATAVERSE_TOKEN` and
repeat with `--execute`. The helper creates/verifies the string and memo
columns and waits for the `poc_rowkey` alternate keys to become active.
It does not provision app users, assign security roles, grant consent or delete data.

| Entity set | Contents |
|---|---|
| `poc_valuelensrawaudits` | Full original Graph audit records, upserted by lowercase audit ID. |
| `poc_valuelensinteractions` | Curated interaction rows, isolated by bridge run ID. |
| `poc_valuelensusers` | Matching curated user/licence rows from the same bridge run. |
| `poc_valuelensruns` | Completed-run manifests, row counts and column contracts. |

### 3. Prepare and import the interaction flow

```powershell
python .\Prepare-CollectorRawCapture.py `
  --source-zip 'C:\PrivateSolutions\CopilotInteractionLogging.zip' `
  --out-zip 'C:\PrivateSolutions\ValueLens\CopilotInteractionLoggingRaw.zip'
```

The adapter refuses managed sources, unsupported flow structures, double-patching
and outputs inside the repository. It produces an **unmanaged** package and
provenance JSON; it does not import or activate anything.

**Use an isolated environment.** Component IDs are deliberately preserved for
collector-package compatibility. Importing over an existing installation updates
those same components; changing the solution display name does not create
independent flows. Do not import into an in-use working environment unless that
change is explicitly authorized.

After the schema and application-user setup, use Power Platform's solution import
UI or `pac solution import` to import the adapted package. Generate the import
settings from that specific package with `pac solution create-settings`, then bind
its connection references and configure its existing tenant/app/auth/lookback
environment variables. The settings example in this folder is a **reference
checklist**, not a PAC deployment settings file.

Keep the flow disabled until connections, authentication and lookback are correct.
Then run the manual collector/backfill before enabling its daily schedule.
Existing summary history cannot populate the raw table by itself.

### 4. Build and publish a core snapshot

```powershell
# Dry run: no authentication, Graph requests or Dataverse writes.
.\Invoke-DataverseCoreRefresh.ps1 `
  -TenantId '<tenant-guid>' -ClientId '<app-client-guid>' `
  -EnvironmentUrl 'https://contoso.crm.dynamics.com' `
  -WorkRoot 'C:\ValueLensRuns'
```

For an approved live run, supply `AZURE_CLIENT_SECRET` through a secret store into
the process environment, then add `-Execute`. Do not place the secret in command
arguments, source files, scheduled-task arguments or chat.

The runner fetches actual Graph user/licence data, reads full retained audits from
Dataverse, runs the existing `Purview_CopilotInteraction_Processor_v4.0.0.py`, and
publishes a new snapshot. It emits a **Core Snapshot ID only after success**.
Its Graph and Dataverse token environment variables are restored afterward.

**For a bounded test or backfill, select a completed collector run and its exact
UTC interval.** A raw table may also contain partial records from cancelled runs;
those must not become a supposedly complete snapshot. Add:

```powershell
  -SourceRunId '<completed-manual-collector-run-id>' `
  -RawStartUtc '<approved-start-ISO8601-with-Z>' `
  -RawEndUtc '<approved-end-ISO8601-with-Z>'
```

These parameters constrain the bridge's input; they do not trigger collection or
prove the selected collector completed successfully. Check the collector's terminal
status, all page/write results and record errors first. The snapshot manifest records
the selected source run, UTC bounds and selected record count for reconciliation.
Use smaller complete weekly batches when a long lookback exceeds the run limit.
Do not combine partial windows or describe a representative week as a complete
90-day backfill. Overlapping collections can update a raw row's source run tag;
publish a scoped snapshot promptly after its successful collection.

For bounded demo/backfill validation, pin the bridge to a completed collector run
and its exact audited UTC window:

```powershell
.\Invoke-DataverseCoreRefresh.ps1 `
  -TenantId '<tenant-guid>' -ClientId '<app-client-guid>' `
  -EnvironmentUrl 'https://contoso.crm.dynamics.com' `
  -WorkRoot 'C:\ValueLensRuns' -Execute `
  -SourceRunId '<completed-flow-run-id>' `
  -RawStartUtc '2026-07-05T18:51:53.556Z' `
  -RawEndUtc '2026-07-12T18:51:53.556Z'
```

The raw filter uses the original audit `CreationTime`, not Dataverse capture
time, and records the selected source run/window in the completed manifest.
Use these arguments whenever retained raw rows include incomplete fallback or
cancelled batches, so partial windows cannot leak into a published snapshot.

For an equivalent BYOD directory export or offline audit fixture:

```powershell
python .\Build-DataverseCoreFeeds.py `
  --raw-jsonl 'C:\ValueLensRuns\full-audit.jsonl' `
  --entra 'C:\ValueLensRuns\entra-users.csv' `
  --out-dir 'C:\ValueLensRuns\offline'
```

This produces local snapshot files, not cloud writes. For separate licensing
exports add `--licensing`. For full-payload manual audit backfill without running
the cloud flow, `Invoke-CopilotAuditRawCapture.ps1` is an alternative collector;
it writes Dataverse only with `-ExecuteDataverseWrite`.

### 5. Open the new PBIT

| Parameter | Setting |
|---|---|
| `Dataverse URL` | The environment origin containing the core tables. |
| `Core Snapshot ID` | The successful run ID emitted in step 4. |
| `Use SharePoint CSV fallback` | Leave `false` for the new pathway. |
| `Include SharePoint agent inventory` | Leave `false` unless you enable the optional lane below. |
| `Copilot Interactions File` / `Org Data File` | Not required in Dataverse mode; used only with explicit CSV fallback. |
| `Agent 365` / `Cost Consumption File` | Existing optional SharePoint sources; not invented from audit data. |

All three core queries use the **same immutable run ID** and refuse missing,
incomplete or count-inconsistent snapshots. This prevents combining one run's
integer user/message keys with another run's dimensions.

Publish the configured report and set organizational credentials for Dataverse
(and SharePoint only when optional CSV inputs or fallback are used).

### Optional: add compatible SharePoint-agent inventory

```powershell
# Dry run, validates the explicit managed package.
.\Invoke-SharePointAgentLogging-Import.ps1 `
  -EnvironmentUrl 'https://contoso.crm.dynamics.com' `
  -SolutionZipPath 'C:\PrivateSolutions\SharePointAgentLogging_managed.zip'
```

For an approved import add `-Execute`; optionally pass a package-generated PAC
deployment file with `-SettingsFile`. Configure the existing `poc_SP_*`
environment variables and connections, then run its backfill. Enable
`Include SharePoint agent inventory` in the PBIT afterward. If explicitly enabled
but absent or invalid, the inventory query fails rather than hiding the problem.

## Scheduling, security and limits

- Schedule the collector first, then the refresh runner after collection succeeds.
  **The runner does not update Power BI parameters or trigger a report refresh.**
  Update `Core Snapshot ID` to the newly completed run, then refresh Power BI.
  Scheduling the runner alone does not advance the dashboard. This explicit
  handoff is intentional in the preview.
- The extra Python processing host and Dataverse database capacity are real
  dependencies/costs. No host, licences or cloud resources are provisioned by this
  build. Core publishing currently writes individual rows; benchmark the demo
  volume before selecting a production cadence.
- The directory exporter includes basic org fields. Use a complete BYOD export
  for deeper manager hierarchy. Copilot entitlement is based on assigned verified
  SKU IDs, not usage or enabled service plans; unknown assignments require review.
- Raw audit records, resource URLs and user identities are sensitive. Apply
  least-privilege Dataverse roles and protected runner storage. The added flow
  actions secure their inputs/outputs; review original flow run-history settings
  too. No prompt content or tokens should be written to repository files.
- Payloads above the 1,048,576-character Dataverse memo limit fail rather than
  truncate. Audit retention bounds available backfill. SharePoint-agent inventory
  is an observed-file inventory, not a guaranteed current tenant-wide census.
- Snapshots are immutable and retained. Define retention/cleanup separately;
  never delete a snapshot still referenced by Power BI. These helpers do not
  automatically delete raw records or old runs.
- Agent 365 catalogue, Copilot Studio health and billing/consumption sources remain
  separate optional evidence. This pathway does not infer those metrics.

## Development

Rebuild from the current SharePoint template:

```powershell
python .\Build-PowerAutomateDataverse-Template.py
python .\Build-PowerAutomateDataverse-Template.py --check
```

The generator preserves the original report layout and existing measures. It
updates both model and pending Power Query definitions. Repository tests cover
source contracts, snapshot safety, collector adaptation, directory classification
and dry-run helpers. Those local checks do not replace a real solution import,
authenticated Power Query refresh or demo-tenant metric reconciliation.

The representative live validation reconciled original distinct prompt-message IDs,
curated message IDs and Desktop DAX counts for the same completed interval. Fact
row count can exceed distinct-message count because of the dashboard's grain.
Likewise, `Copilot Licensed` contains the directory's licence flags: its total row
count is **not** the licensed-seat count; filter `Has license = "TRUE"` for that.

Live fixes are retained in the reusable package adapter and template generator:
raw writes use the audit GUID as the Dataverse connector row ID, failed writes
stop paging and fail the run, and model/pending-query metadata remains aligned.
Deployment-scale throughput, full 90-day collection, non-empty SharePoint-agent
inventory and automatic Power BI parameter advancement require separate validation.
