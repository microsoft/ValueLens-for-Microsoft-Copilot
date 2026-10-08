# Analytics Hub installer

Sets up the [Fabric path](../README.md) in your tenant: the app registration and its secret in Key
Vault, a workspace and Lakehouse, the notebooks, the pipeline and its schedule, the semantic model
and the Analytics Hub app. Then it loads the first data and checks it.

## Before you start

| You need | Why |
|---|---|
| **Windows 10 or 11** (64-bit) | To run `AnalyticsHubInstaller.exe`. Or use [Node.js](#without-the-exe). |
| An **active Fabric capacity** (F2 or larger, or a trial) | The workspace runs on it. Or pick an existing workspace where you're an Admin or Member. |
| For a new Key Vault: **Contributor** on a subscription, or on just one resource group | The client secret lives in Key Vault. With Contributor on one resource group only, pick that group: the installer doesn't need to create one. |
| Or an existing Key Vault you can **write secrets to** (Key Vault Secrets Officer, or secret Set on an access policy) | The installer stores the secret for you. |
| Or an existing Key Vault you can only **read secrets from** (Key Vault Secrets User, or secret Get on an access policy) | A vault admin adds the secret for you. See [Where the secret goes](#where-the-secret-goes). |
| Permission to **register apps** in Entra | The default user setting is enough. Or use an app you already have, which the installer checks first. Or let an admin register it with the [admin pack](#if-you-cant-register-apps). |
| A **Global Administrator** or **Privileged Role Administrator** | To grant admin consent for the Graph permissions. If that isn't you, the installer gives you a link to send them. |
| These **Fabric tenant settings** turned on | *Service principals can call Fabric public APIs*, *Semantic Model Execute Queries REST API* and *Fabric App items*. If you're a Fabric administrator, the installer checks them. |
| For credit consumption: **Owner** or **User Access Administrator** on the subscription | Only if you add [credit consumption](#credit-consumption). |
| For the Agent Evaluator: **System Administrator** in each Power Platform environment | Only if you add the [Agent Evaluator](#agent-evaluator). |

The Graph permissions are listed in [`/docs/PERMISSIONS.md`](../../docs/PERMISSIONS.md).

### Where the secret goes

The notebooks sign in as the app registration with its client secret. The installer offers three
places for it:

| Option | You need | Use it when |
|---|---|---|
| **Key Vault, written by the installer** (the default) | Contributor to create a vault, or write access to an existing one | You can create a vault or already write to one. |
| **A vault admin will add the secret for me** | Read access to the vault: Key Vault Secrets User, or secret Get and List on an access policy | You can't write to the vault and can't create one. Offered when the installer finds you can't write. |
| **Store the secret in the notebook (not recommended)** | Nothing in Azure: no subscription and no vault | Quick tests only, in a workspace nobody else uses. |

**A vault admin adds the secret.** The installer shows the vault, the secret name and one
Azure Cloud Shell command for the admin. The command creates a new client secret on the app and
stores it in the vault in one step, so nobody, including the installer, sees its value. If you
don't have read access yet and can't give it to yourself, the command gives it to you as well.
The installer can make the admin an owner of the app, so they can create its secret: enter their
email when asked. Then answer **Has the admin added it?** with **Yes, carry on**, or choose
**Stop and resume later** and run the installer again once it's there. Your answers are kept.
Read access is all the notebooks need: they read the secret with `notebookutils` as the person
the run uses. The choice is recorded in the install record as `keyVault.mode: "keyvault-admin"`.

**Store the secret in the notebook.** Choose it in the Key Vault question, or run
`install --secret-in-notebook`. The installer warns you first, and you have to confirm. The answer
defaults to no:

- The secret is plain text in the notebook code.
- Anyone with access to the workspace can read it, and use it to read your tenant's data through
  Microsoft Graph.
- It is copied into notebook run snapshots, exports, Git sync and deployment pipelines.

The installer writes the value into each notebook that needs it instead of a Key Vault
reference, and records `keyVault.mode: "notebook"`. It never logs the value. Power Automate flows
are left out in this mode, because they read the secret from Key Vault. To move to Key Vault
later, run the installer again and choose **Use Key Vault instead**. It rewrites the notebooks to
read the secret from the vault and removes the secret they held from the app.

### If you can't register apps

Choose **An admin will register the app for me** in the app registration question. Before
anything is created, the installer writes `analytics-hub-admin-pack.md` next to the install record.
It holds an Azure Cloud Shell script and the same steps for the portal. An admin uses it to:

1. Register the app, with every Graph application permission the modules you picked need.
2. Grant admin consent.
3. Create a client secret. If you chose **A vault admin will add the secret for me**, the
   secret goes straight into the vault. Otherwise the admin sends it to you through a secure
   channel.

They send you back the client ID. Run the installer again, enter it, and paste the secret if
you're asked. The installer then checks the app as below.

**Using an app you already have?** The installer checks it before anything is created: that the
app and its service principal exist, and that every Graph application permission you need is on
it with admin consent. It lists anything missing with the link to the app's API permissions page.
Once an admin has fixed it, choose **Check again**. Or choose **Carry on anyway**: data the missing
permissions cover won't load until they're fixed.

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
   3. **How much audit history** to load first: 30 (the default), 90 or 180 days. You can load
      more later with `run --backfill-days <n>`.
   4. **Capacity, workspace and Lakehouse.** Spaces and hyphens in the Lakehouse name become
      underscores, because Fabric doesn't allow them. With the capacity comes **how many people
      are in the tenant**: up to 10,000, or more. See [A large tenant](#a-large-tenant).
   5. **App registration:** create one, use your own (it's checked first), or let an admin
      register it. See [If you can't register apps](#if-you-cant-register-apps).
   6. **Key Vault:** create one, or pick one you have. If you can't write to it, a vault admin
      can add the secret. See [Where the secret goes](#where-the-secret-goes).
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
  on the workspace first. With the secret in the notebooks, they only need Contributor.
- **Secrets expire after 12 months.** **Check status** warns you 30 days before. Choose
  **Create new secrets** (`rotate-secret`). Where the secret goes decides what happens:
  - **Key Vault, written by the installer:** it creates and stores a new secret.
  - **A vault admin adds it:** it shows the admin the same steps again, then waits for you to
    say it's done.
  - **In the notebooks:** it creates a new secret, rewrites the notebooks and removes the old
    one. If you brought the app, paste its new secret when asked. Rotate it regularly: anyone
    who could read the old one could keep using it until then.

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

The Analytics Hub app reads a small `fabric.config.json` deployed beside it. It contains the
semantic model IDs the app should query and, for newer installs, the optional modules the admin
turned on:

```json
{
  "semanticModels": {
    "vl": { "workspaceId": "<workspace>", "itemId": "<Analytics Hub Model>" }
  },
  "modules": {
    "m365Activity": true,
    "agent365": false,
    "productFeedback": false,
    "consumption": false,
    "agentEvaluator": false
  }
}
```

Older installs may not have `modules`; the app then probes the model as before.

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

## A large tenant

Each audit query waits a few minutes in Microsoft's queue, however little it returns, so the first
load's time grows with the days of history. With 30 days a tenant of up to 10,000 people usually
loads in under an hour. Later runs load only what's new.

On a tenant with tens of thousands of people, choose **More than 10,000** when asked how many
people are in the tenant. It's chosen for you on an F64 or larger capacity. Then:

- The audit log is read in 2-hour windows instead of 24-hour ones. A long window can hold too many
  records, and the audit service fails it after an hour or more. A window that fails is split after
  one retry instead of three.
- Each daily run reads the last 3 days again, not 7, which keeps the extra queries down. Records
  that arrive more than 3 days late are missed.
- The loads and the model refresh get longer time limits: up to 6 hours for the audit log.
- If a run can't finish the history in time, it stops before writing anything and the retry carries
  on from where it stopped. Windows already read aren't read again. `run` does the same.

Expect the first load to take several hours. Start with 30 days, use an F64 or larger capacity,
and load more history later with `run --backfill-days <n>`. Don't run audit searches in the
Purview portal while it loads. To change the tenant size, choose **Repair or change** and answer
again. An install from an earlier version keeps its audit windows and time limits until you do.

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
| `No Azure subscription you can use` | Ask for Contributor on a subscription, on a resource group, or for read access to an existing vault a vault admin can add the secret to. Or, for a quick test only, [store the secret in the notebook](#where-the-secret-goes). |
| `You can't write secrets to …` or `You can't change access policies on …` | Run the installer again without `--yes`, pick the vault, and choose **A vault admin will add the secret for me**. See [Where the secret goes](#where-the-secret-goes). |
| `You can't create resource groups in this subscription` | Run the installer again and give the name of a resource group where you're a Contributor. |
| `The subscription isn't registered for Microsoft.KeyVault` | Ask a subscription Owner or Contributor to register the `Microsoft.KeyVault` resource provider, then run the installer again. |
| `Stopped until the vault admin has added the secret` | Send the admin the steps the installer showed (run `rotate-secret` to see them again). Once the secret is in the vault, run the installer again: it carries on from there. |
| `Stopped until an admin has registered the app` | Send the admin `analytics-hub-admin-pack.md` from the install folder. Once they send you the client ID, run the installer again without `--yes`. |
| `… isn't ready yet. It still needs:` | The app you brought is missing its service principal, Graph permissions or admin consent. Send the admin the link it shows, then choose **Check again**. |
| A run fails with `AADSTS7000215` | The secret doesn't match the app. Choose **Create new secrets**. |
| A run fails with `Forbidden` from Graph | Admin consent is missing or still applying. Choose **Repair or change**, then **Run now**. |
| A run fails reading the secret | The person the run uses can't read it, or a vault admin hasn't added it yet. See **Someone else takes over the pipeline?** above. |
| A run says Fabric's capacity was too busy (`TooManyRequestsForCapacity`) | Nothing is lost. Wait a few minutes, then choose **Rerun failed loads**. It happens most on trials and small capacities, and less once the notebooks share one Spark session. See [Load status and reruns](#load-status-and-reruns). |
| `Couldn't turn on high concurrency for pipelines` | You need the workspace Admin role to change it. Ask a workspace admin to turn it on, or carry on: the notebooks start their own Spark sessions. See [Load status and reruns](#load-status-and-reruns). |
| The model refresh fails with `Table '…' is not in database` | The Lakehouse's SQL endpoint hadn't caught up with tables the run had just written. The refresh notebook syncs the endpoint first, so this is rare. Wait a couple of minutes, then choose **Rerun failed loads** or **Refresh the models**. |
| A run failed and you want to know which source | Its cards say. Or query `dbo.load_log` in the Lakehouse for the run: each row has the source, its status and the reason. |
| Copilot interactions fails with `audit window(s) still failed` | Purview kept failing some audit queries, usually because too many ran at once. The ingester already resends and splits failing windows, and nothing was written. Wait, make sure no one is running audit searches in the Purview portal, then choose **Rerun failed loads**. Windows that succeeded are reused. If it keeps failing, see [An audit window keeps failing](../Manual%20setup/notebooks/README.md#an-audit-window-keeps-failing). |
| Copilot interactions fails with `earlier audit range(s) failed and were never recovered` | An earlier load failed and was never rerun, and the usual run doesn't go back that far. Run `run --backfill-days <n>`, with `<n>` covering the listed dates. Windows that succeeded are reused. |
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
`install --yes --secret-in-notebook` keeps the secret in the notebooks without asking; only use it
for [quick tests](#where-the-secret-goes).