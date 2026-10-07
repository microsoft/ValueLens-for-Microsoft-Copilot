# Analytics Hub installer

Sets up the [Fabric path](../README.md) in your tenant: the app registration and its secret in Key
Vault, a workspace and Lakehouse, the notebooks, the pipeline and its schedule, the semantic model
and the Analytics Hub app. Then it loads the first data and checks it.

## Before you start

| You need | Why |
|---|---|
| **Windows 10 or 11** (64-bit) | To run `AnalyticsHubInstaller.exe`. Or use [Node.js](#without-the-exe). |
| An **active Fabric capacity** (F2 or larger, or a trial) | The workspace runs on it. Or pick an existing workspace where you're an Admin or Member. |
| An **Azure subscription** where you're a Contributor, or an existing Key Vault you can write secrets to | The client secret lives in Key Vault. |
| Permission to **register apps** in Entra | The default user setting is enough. You can also use an app you already have. |
| A **Global Administrator** or **Privileged Role Administrator** | To grant admin consent for the Graph permissions. If that isn't you, the installer gives you a link to send them. |
| These **Fabric tenant settings** turned on | *Service principals can call Fabric public APIs*, *Semantic Model Execute Queries REST API* and *Fabric App items*. If you're a Fabric administrator, the installer checks them. |
| For credit consumption: **Owner** or **User Access Administrator** on the subscription | Only if you add [credit consumption](#credit-consumption). |
| For the Agent Evaluator: **System Administrator** in each Power Platform environment | Only if you add the [Agent Evaluator](#agent-evaluator). |

The Graph permissions are listed in [`/docs/PERMISSIONS.md`](../../docs/PERMISSIONS.md).

## Azure target (preview)

The installer can also set up the Phase 1 preview in **your Azure subscription**. Start it with
`--target azure`, or pick **Your Azure subscription** as the first wizard answer.

You need:

- Contributor plus User Access Administrator (or Owner) on the subscription or resource group.
- Permission to register Entra apps, or an Application Administrator.
- A Global Administrator or Privileged Role Administrator to grant the managed identity's Graph app
  roles, or to use the admin links the installer prints.
- Power BI Pro or PPU, and permission to create or use the chosen Power BI workspace.
- Teams custom app upload rights, or a Teams admin to upload the generated package.
- The tenant settings *Service principals can call Fabric public APIs* (enabled for a group that holds
  the managed identity, so the jobs can refresh the model) and *Semantic Model Execute Queries REST
  API* (for the app's queries).

The preview creates or reuses a resource group and deploys a managed identity, Storage, Log Analytics,
Azure SQL Database serverless, Container Apps jobs, and the web app from the ARM template in
`src/azure/main.arm.json`. It also creates the Azure web app registration, an SQL reader app
registration, a Power BI workspace and model, and an `AnalyticsHub-Teams.zip` package (the app as a
Teams tab, built by `src/azure/teams/build-package.mjs`) next to the install record.

Only `core`, `orgData`, and `m365Activity` are supported on Azure in this preview. Other modules are
shown as coming soon and cannot be selected. Re-runs are incremental and use the same
`valuelens-install.json`, with `target: "azure"` and an `azure` block. The installer tags every Azure
resource with `valuelens-install-id` and stops rather than modifying untagged resources with colliding
names.

### Demo mode

After the data tick boxes, the wizard asks which data the dashboard shows. **Demo mode (sample data)**
deploys everything as usual but sets `VALUELENS_SAMPLE_DATA=true` on the run job, so each run publishes
the synthetic sample bundled in the jobs image (dates moved forward to end last week) instead of calling
the tenant's APIs. It's recorded as `azure.sampleData`. To switch to tenant data, run the installer again
and pick **Your tenant's data**; the next run replaces the sample.

### Networking

The wizard asks how the app, jobs and Power BI reach Azure SQL and Storage:

- **Public endpoints** (default). SQL allows Azure services and Power BI connects to it directly.
- **Private networking**. Choose this where Azure Policy keeps public network access off (common on
  managed and MCAPS subscriptions; the installer says so when what-if hits `DenyPublicEndpointEnabled`).
  It adds a VNet, private endpoints and private DNS zones for SQL and Storage (blob, dfs, table), a
  VNet-integrated Container Apps environment, and a Power BI **VNet data gateway** that the model's SQL
  connection runs through. SQL uses the Proxy connection policy, so everything stays on port 1433.
  - It needs an active Fabric (F or trial) or Power BI Premium capacity to host the gateway. The
    Power BI workspace is assigned to it.
  - The preflight registers the `Microsoft.Network/AllowBringYourOwnPublicIpAddress` subscription
    feature, which VNet-integrated Container Apps environments need. It's approved automatically.
  - It adds about $30–40 a month (four private endpoints and DNS zones). The gateway uses capacity units
    while refreshing.
  - Networking can't be changed in place. Uninstall and install again to switch.

### Regions and images

- `azure.sqlLocation` puts Azure SQL in a different region from everything else. Some subscriptions
  can't create SQL in busy regions (for example uksouth, northeurope or westeurope on MCAPS). The
  preflight checks SQL capability and points at this setting. The private endpoint can be in another
  region from the server.
- `azure.images` overrides where the jobs and web images come from, for air-gapped tenants or testing
  an unreleased build: `{ "registry": "myacr.azurecr.io/valuelens", "registryResourceId": "<ACR
  resource ID>", "tag": "dev-abc123" }`. With `registryResourceId` set, the managed identity is granted
  AcrPull. Build into your registry from the repo root with
  `az acr build -r myacr -t valuelens/valuelens-jobs:<tag> -f "2. Azure/jobs/Dockerfile" .` (and the
  same for `valuelens-web` with `2. Azure/web/Dockerfile`). If the upload fails on long `node_modules`
  paths, build from a folder that holds only the paths the Dockerfile copies.

If the database migration job fails, setup stops before the first load and prints the
`az containerapp job logs show` command for its logs. Fix the cause and run install again; finished
steps are skipped.

Azure commands:

- `run` starts the Container Apps run job.
- `status` shows job executions, the web URL, pending admin actions, and SQL reader secret expiry.
- `refresh` starts a Power BI model refresh.
- `update` re-runs preflight/what-if and redeploys with the current installer image tag.
- `rotate-secret` creates a new SQL reader secret and rebinds the Power BI credential.
- `uninstall` deletes the created resource group, or only tagged resources if you used an existing group.

## Run it

1. [Download the installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe).
   This link always gets the newest version. If Edge says it isn't commonly downloaded, choose
   **…** next to the file, then **Keep**, **Show more** and **Keep anyway**.
2. Open it. If Windows says it protected your PC, choose **More info**, then **Run anyway**.
3. The first time, it takes about a minute to unpack. Then it opens in your browser. Keep its
   window open while you use the page.
4. Choose **Set up Analytics Hub** and sign in.
5. Answer the questions:
   1. **Data sources.** Each source has a card: **Connected (API)**, **Upload CSV** or **Skip**.
      Copilot usage, licences and org data are always connected. Microsoft 365 activity is
      connected by default; the rest are skipped until you choose otherwise. A CSV card says
      where to export the file, and you can pick the exports to upload now. See
      [Data sources and exports](#data-sources-and-exports).
   2. **Power BI:** the semantic model, the Power BI reports and the app (the default). Or the
      model and reports, the model and app, the model only, or neither. See
      [Power BI reports](#power-bi-reports).
   3. **How much audit history** to load first: 30, 90 or 180 days.
   4. **Capacity, workspace and Lakehouse.** Spaces and hyphens in the Lakehouse name become
      underscores, because Fabric doesn't allow them.
   5. **App registration:** create one, or use your own.
   6. **Key Vault:** create one, or pick one you have.
   7. **Schedule:** daily or weekly, and the time (UTC).
   8. **Whether to run the first load** now.
6. Check the plan and approve it. Nothing is created until you do.
7. When it finishes, open the link to the app.

**Want to change an answer?** Choose **Back**, on any question or on the plan. It opens the
previous question with your answer filled in, and the questions after it are asked again. If you
go back to the client secret, leave the box empty to keep the one you pasted. If you go back
further, you'll be asked for it again.

It keeps your answers in `Documents\Analytics Hub`. Keep that folder. To run the pipeline, check
status, update, or repair the set-up later, open the exe again.

**Using a workspace that already has things in it?** The installer never changes anything it
didn't create. If one of its names is taken, its own item gets the next free name, such as
`AnalyticsHub_Pipeline_2` or `Analytics Hub 2`. The plan shows the names before you approve it.

**Item names.** A new install names its items after Analytics Hub: `Analytics Hub Model`,
`AnalyticsHub_Pipeline`, the `Analytics Hub SQL …` connection and the `Analytics Hub Data Collector`
app registration. An install from an earlier version keeps the names it already has, such as
`ValueLens Model`.

## After it finishes

- **Admin consent.** If you couldn't grant it, send the link the installer gives you to an admin.
  They select **Grant admin consent**. Then open the exe again and choose **Run now**.
- **Share the app and reports.** Open **Analytics Hub** or the **ValueLens** report in the
  workspace, choose **Share**, and add people or a group. They also need **Build** on
  `Analytics Hub Model` (its **Manage permissions** page), or Viewer on the workspace.
- **Own reports.** Connect Power BI Desktop to `Analytics Hub Model`, or use **Save a copy** on a
  published report.
- **Flows and the Cowork Dataflow.** If you chose them, the end of the install lists what to sign
  in to. See [Power Automate flows](#power-automate-flows-optional) and
  [Credit consumption](#credit-consumption).
- **Someone else takes over the pipeline?** The notebooks run as the person who last changed the
  pipeline, or the schedule's owner. Give them Key Vault Secrets User on the vault and Contributor
  on the workspace first.
- **Secrets expire after 12 months.** **Check status** warns you 30 days before. Choose
  **Create new secrets**.

## Power BI reports

The installer publishes the reports from the Power BI templates to the workspace, already
connected to its semantic models, so nobody has to open Power BI Desktop:

| Report | Reads | Published when |
|---|---|---|
| `ValueLens` | `Analytics Hub Model` | Always, with the reports |
| `Consumption Central` | `Analytics Hub Consumption Model` | Credit consumption is on |
| `Agent Evaluator` | `Analytics Hub Agent Evaluator Model` | Agent Evaluator is on, with an environment |

Pages for sources you skip stay empty rather than failing. To leave the reports out, choose
**Semantic model and the Analytics Hub app** or **Semantic model only** for Power BI. An install
from an earlier version gets the reports offered the next time you choose **Repair or change**;
**Update** on its own doesn't add them.

**Editing a report.** A new installer version may bring a new version of a report. **Update** and
**Repair or change** then ask before replacing it, because that replaces edits made in Power BI.
To keep your edits, use **File** > **Save a copy** in Power BI first and edit the copy.

**Blank visuals.** The Tornado chart, Word cloud and Deneb visuals need the tenant setting
*Allow visuals created using the Power BI SDK*. If you're a Fabric administrator, the installer
checks it.

Without the reports, publish the templates yourself: open `ValueLens - Fabric.pbit` in Power BI
Desktop with the values the installer shows, and publish it to the workspace.

## Load status and reruns

**One Spark session.** The pipeline's notebooks share one Spark session, up to five at a time,
instead of each starting its own. This keeps a small capacity from being too busy to start them
(`TooManyRequestsForCapacity`). The installer turns on the workspace setting it needs: *High
concurrency for pipeline running multiple notebooks*. That needs the workspace **Admin** role. If
you're a Member, it warns you, and the notebooks start their own sessions as before. A workspace
admin can turn it on under **Workspace settings** > **Data Engineering/Science** >
**Spark settings** > **High concurrency**.

**What loaded.** After a run, the installer shows a card for each source: loaded, failed, skipped,
or still running. A failed card says why in plain words, such as *Fabric's capacity was too busy
to start it*, and what to do about it. The last pipeline step, `AnalyticsHub_Load_Status`, writes
the same thing to the Lakehouse table `dbo.load_log`, one row per source per run. If any load
failed, that step fails too, so the run shows as failed in Fabric and in its alert emails. A failed
Agent 365 API load doesn't count when the Agent 365 export loaded instead.

**Rerun only what failed.** Choose **Rerun failed loads**, or run `rerun-failed`. It runs the
failed loads again, then the steps that depend on them, and refreshes the model. Loads that worked
aren't run again. If the capacity is still busy, it waits five minutes and tries again, twice. It
won't start while a pipeline run is still going. The data check after a run does the same: the
pipeline's Spark session can hold the capacity for a few minutes after the run ends.

**The model sees new tables.** Before refreshing the model, `AnalyticsHub_Refresh_Model` asks the
Lakehouse SQL endpoints to sync. Otherwise a refresh straight after a load can fail with
*Table '…' is not in database*.

## Data sources and exports

| Source | Connected (API) | Upload CSV: where to export it | Fills |
|---|---|---|---|
| Copilot usage and licences | Always | | Every page |
| Org data (Entra ID) | Always | | Organisation filters |
| Workday org data | | Workday: a report of active workers with **Primary Work Email** | Organisation filters |
| Microsoft 365 activity | Yes | | M365 activity |
| Agent 365 registry | Needs an Agent 365 licence | Microsoft 365 admin center > **Agents** > **All agents** > **Export** | Agents |
| Product feedback | No API. An optional flow saves exports emailed to you | Microsoft 365 admin center > **Health** > **Product feedback** > **Export** | User Feedback |
| Copilot Studio credits | An optional daily flow reads the licensing API (environment and agent figures) | Power Platform admin center > **Licensing** > **Products** > **Copilot Studio** (Summary, Environments and Agents) | Consumption Central |
| Copilot Cowork credits | **Connected (Dataflow)**: a Dataflow Gen2 reads your Viva Insights query | Viva Insights > Copilot Consumption Dashboard > **Export** | Consumption Central |
| Azure AI costs | Yes | | Consumption Central |
| Agent Evaluator | Yes | | Agent Evaluator |

A skipped source leaves its table empty and its page blank. Nothing fails. To turn one on later,
choose **Repair or change**.

**Adding exports.** Every export goes to one folder in the Lakehouse, `Files/analytics_hub_uploads`.
Drop files there as downloaded: no renaming and no subfolders. Each pipeline run starts by
recognising each file from its column headers, handing it to the notebook that loads it, and
moving it to `_processed`. A file it doesn't recognise, or one for a skipped source, goes to
`_unrecognised`; the reason is in the `analytics_hub_upload_log` table. Ways to add a file:

- **In the installer.** Choose **Upload exports**, or pick files on the Data sources screen.
- **In Fabric.** Open the Lakehouse, choose **…** next to the folder, then **Upload** > **Upload files**.
- **[OneLake File Explorer](https://learn.microsoft.com/fabric/onelake/onelake-file-explorer)**,
  which shows the folder in Windows Explorer.

The installer uploads files up to 200 MB. Use Fabric or OneLake File Explorer for bigger ones.
Your account needs Contributor or Member on the workspace to write there.

**A SharePoint or OneDrive folder instead (optional).** In the Lakehouse, open
`analytics_hub_uploads`, choose **New shortcut** > **OneDrive (SharePoint)**, pick your folder and
name the shortcut `sharepoint`. Files there are read where they are, loaded once each, and left in
place. Shortcuts need the Fabric tenant setting for OneDrive and SharePoint shortcuts. Without it,
use the Lakehouse folder.

### Power Automate flows (optional)

For a source set to **Upload CSV**, the installer can create a flow that adds the files for you:

| Flow | What it does | Who can use it |
|---|---|---|
| `Analytics Hub - Product feedback` | Saves product feedback exports emailed with the subject `Copilot Product Feedback` | Anyone with Power Automate Premium |
| `Analytics Hub - Copilot Studio credits` | Each day, an hour before the pipeline, reads the last ten days' credits by agent and the tenant's entitlement from the Power Platform licensing API | Power Platform, Billing or Global administrators with Power Automate Premium |

Both are off by default. The installer creates them in the Power Platform environment you pick,
**turned off**. To finish:

1. Open the flow in Power Automate. Sign in to **Azure Key Vault** (your vault), and to **Office 365
   Outlook** (the mailbox the export goes to) or **HTTP with Microsoft Entra ID (preauthorized)**
   (Base Resource URL and Resource URI `https://api.powerplatform.com`).
2. Save, then turn the flow on.
3. For product feedback, schedule the export in the Microsoft 365 admin center to be emailed to
   that mailbox with the subject `Copilot Product Feedback`.

The flows write to the drop folder as the app registration, with its secret from Key Vault, so
the installer gives the app **Contributor** on the workspace. If a flow can't be created (no
environment, or no maker rights), the installer writes it to a file beside your answers in
`Documents\Analytics Hub`. Create a cloud flow and paste the file's `definition` in. The
[Manual setup flows](../Manual%20setup/flows/README.md) describe the same flows by hand.

The Studio flow only sees environments that have Copilot Studio credits allocated. The exports
still add per-user figures and the exact prepaid split. For a month an export covers, the
export's figures are used.

### Commands

| To | Run |
|---|---|
| Choose sources without the questions | `install --data productFeedback=csv,agent365=api --yes` |
| Upload exports during the install | `install --data productFeedback=csv --csv feedback.csv` |
| Create the product feedback email flow | `install --data productFeedback=csv --feedback-flow --flow-environment https://contoso.crm.dynamics.com` |
| Create the Copilot Studio credits flow | `install --data studioCredits=csv --studio-flow --flow-environment https://contoso.crm.dynamics.com` |
| Read Cowork credits with a Dataflow | `install --data coworkCredits=api --viva-partition <id> --viva-query <id>` |
| Upload exports later, then load them now | `upload feedback.csv agents.csv --run` |
| Run only the loads that failed last time | `rerun-failed` |

Source IDs for `--data`: `workday`, `m365Activity`, `agent365`, `productFeedback`,
`studioCredits`, `coworkCredits`, `azureAi`, `agentEvaluator`. Modes: `api`, `csv` or `skip`.
Without `--flow-environment`, the installer asks which environment to use.

## Microsoft 365 activity

On by default. It fills the app's **Work patterns** page.

**Turn off concealed names**, or the organisation filters won't work on that page. In the
Microsoft 365 admin center, go to **Settings** > **Org settings** > **Services** > **Reports** and clear
**Display concealed user, group, and site names in all reports**. Then choose **Run now**.

## Credit consumption

Optional. It fills the app's Consumption pages. See [Consumption Central](../Manual%20setup/Add%20Credit%20Consumption/).

The installer reads Azure AI and Copilot pay-as-you-go costs for you. For the other two:

- **Copilot Studio credits.** In the Power Platform admin center, go to **Licensing** >
  **Products** > **Copilot Studio**. Download the `EntitlementConsumption…_MCSMessages…csv` files
  from the Summary, Environments and Agents tabs, and add them as [exports](#data-sources-and-exports).
  Do it each month; a new file replaces the last one of the same kind. To keep the environment and
  agent figures up to date between exports, add the
  [Copilot Studio credits flow](#power-automate-flows-optional).
- **Cowork credits.** Choose **Connected (Dataflow)** where you can. In Viva Insights > **Analysis**,
  build a query with the Copilot credit metrics and turn on **Auto-refresh**. In **Analysis
  results**, choose the link icon to copy its partition and query IDs, and give them to the
  installer. It creates the Dataflow Gen2 `AnalyticsHub_Cowork_Credits`, which loads the query
  into `viva_credits_dataflow`, and the pipeline refreshes it before each Viva load. Once, open the
  Dataflow, choose **Edit dataflow**, and under **Home** > **Manage connections** sign in to Viva
  Insights and the Lakehouse. Then choose **Save**, wait until it's published, and choose **Refresh
  now**. Rows in the editor's preview use your own sign-in, so they show even while every refresh
  still fails for want of saved connections. See the
  [Viva Insights guide](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric).
  You need the Viva Insights **Insights Analyst** role. Without the IDs, or if the Dataflow can't be
  created, Cowork credits fall back to the Consumption Dashboard's CSV
  [export](#data-sources-and-exports). Exports can still fill weeks before the query; the
  Dataflow wins for weeks both cover.

If you can't assign Azure roles, ask an Owner or User Access Administrator to give the app
registration Reader, Cost Management Reader and Monitoring Reader on the subscription. Then
choose **Repair or change**.

## Agent Evaluator

Optional. It fills the app's Agent Evaluation pages from your Copilot Studio conversations. See
[Agent Evaluator](../Manual%20setup/Add%20Agent%20Evaluator/).

If you aren't a System Administrator in an environment you pick, ask one to:

1. Open the [Power Platform admin center](https://admin.powerplatform.microsoft.com) and go to
   **Manage** > **Environments** > the environment > **Settings** > **Users + permissions** >
   **Application users** > **New app user**.
2. Pick the app registration, the root business unit and the **Bot Transcript Viewer** role.

Then choose **Repair or change**.

## Private Key Vaults

If your vault blocks public access, the installer connects the workspace to it with a managed
private endpoint. You need to be a workspace Admin, on an F or trial capacity. If you can't approve
the endpoint, someone who manages the vault approves it under **Networking** >
**Private endpoint connections**. Then choose **Repair or change**.

## Troubleshooting

| Problem | What to do |
|---|---|
| Edge says the file isn't commonly downloaded | Choose **…** next to the file, then **Keep**, **Show more** and **Keep anyway**. The exe isn't code-signed yet. |
| Windows says it protected your PC | Choose **More info**, then **Run anyway**. The exe isn't code-signed yet. |
| `The installer couldn't start` | Download the exe again. If that doesn't help, delete `%LOCALAPPDATA%\AnalyticsHub` and open it again. |
| `No active Fabric capacity you can use` | Start a Fabric trial, or ask a capacity admin to make you a Contributor on a capacity. |
| `No Azure subscription you can use` | Ask for Contributor on a subscription, or on a resource group with an existing vault. |
| A run fails with `AADSTS7000215` | The secret doesn't match the app. Choose **Create new secrets**. |
| A run fails with `Forbidden` from Graph | Admin consent is missing or still applying. Choose **Repair or change**, then **Run now**. |
| A run fails reading the secret | The person the run uses can't read it. See **Someone else takes over the pipeline?** above. |
| A run says Fabric's capacity was too busy (`TooManyRequestsForCapacity`) | Nothing is lost. Wait a few minutes, then choose **Rerun failed loads**. It happens most on trials and small capacities, and less once the notebooks share one Spark session. See [Load status and reruns](#load-status-and-reruns). |
| `Couldn't turn on high concurrency for pipelines` | You need the workspace Admin role to change it. Ask a workspace admin to turn it on, or carry on: the notebooks start their own Spark sessions. See [Load status and reruns](#load-status-and-reruns). |
| The model refresh fails with `Table '…' is not in database` | The Lakehouse's SQL endpoint hadn't caught up with tables the run had just written. The refresh notebook syncs the endpoint first, so this is rare. Wait a couple of minutes, then choose **Rerun failed loads** or **Refresh the models**. |
| A run failed and you want to know which source | Its cards say. Or query `dbo.load_log` in the Lakehouse for the run: each row has the source, its status and the reason. |
| `Copilot interactions: 0 rows` after a successful run | Either the audit log had no Copilot activity in the window, or all of it was test or admin activity, such as Copilot Studio test runs (*Maker evaluation*), which the dashboard leaves out. The data check says which, with counts. People's own Copilot use appears after the next run. To keep some of the left-out activity, edit `DROP_EXCLUDE_REASONS` in the Audit Log Processor. |
| `Fabric couldn't set up the model's connection` | Turn on *Service principals can call Fabric public APIs*, then choose **Repair or change**. |
| `Couldn't connect Analytics Hub Model to …` | Open the link it shows. Under **Gateway and cloud connections**, pick `Analytics Hub SQL …` (`ValueLens SQL …` on earlier installs). Then choose **I've connected it myself**. |
| A run notes that `Refresh_Cowork_Credits` failed | Most often the Dataflow has no saved connections. The refresh then fails within seconds with "Job instance failed without detail error", even if the editor's preview shows rows. Open `AnalyticsHub_Cowork_Credits`, choose **Edit dataflow** > **Home** > **Manage connections**, and sign in to Viva Insights and the Lakehouse. Then choose **Save**, wait until it's published, and choose **Refresh now**. Otherwise the Viva Insights query may have stopped refreshing. The rest of the run carries on either way. |
| A flow doesn't save any files | Check it's turned on and its connections are signed in. The Copilot Studio credits flow must be signed in as a Power Platform, Billing or Global administrator. |
| A model refresh fails with `Login failed` | The connection's secret expired. Choose **Create new secrets**. |
| `The app wasn't deployed` | Fix the cause it shows, then choose **Redeploy the app**. |
| `The … report wasn't published` | Fix the cause it shows, then choose **Update**. The models and data aren't affected. |
| A report's Tornado chart, Word cloud or Deneb visual is blank | Turn on the tenant setting *Allow visuals created using the Power BI SDK*. See [Power BI reports](#power-bi-reports). |
| `You can't assign Azure roles in …` | See [Credit consumption](#credit-consumption). |
| `You can't add … to …, so its transcripts are skipped` | See [Agent Evaluator](#agent-evaluator). |
| Work patterns says the reports hide user names | See [Microsoft 365 activity](#microsoft-365-activity). |
| An export isn't recognised, or is `set to Skip` | Check it's the export the card names, unedited. Or set its source to **Upload CSV** with **Repair or change**. Files the pipeline couldn't place are in `analytics_hub_uploads/_unrecognised`. |
| A page is blank | Its source is skipped, or no export has arrived yet. See [Data sources and exports](#data-sources-and-exports). |

## Without the exe

If you can't run the exe, run the installer from a clone of this repo with Node.js 22.13 or later:

```text
cd "1. Fabric/installer"
npm install
npx valuelens-install --ui
```

Leave out `--ui` to answer the questions in the terminal. Other commands: `run`, `check`,
`refresh`, `status`, `update`, `deploy-app`, `rotate-secret`, `upload` and `preview`. Add `--help` for
options. The exe takes the same commands, for example `AnalyticsHubInstaller.exe status`.