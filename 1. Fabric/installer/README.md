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
  `az acr build -r myacr -t valuelens/valuelens-jobs:<tag> -f "5. Azure/jobs/Dockerfile" .` (and the
  same for `valuelens-web` with `5. Azure/web/Dockerfile`). If the upload fails on long `node_modules`
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
   1. **What to collect.** Tick the data you want. Each box says where its data comes from and
      what it shows. Copilot usage, licences and org data are always collected. Microsoft 365
      activity is ticked. The Agent 365 registry, product feedback, credit consumption and the
      Agent Evaluator aren't.
   2. **Power BI:** the semantic model and the app (the default), the model only, or neither.
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
`ValueLens_2` or `Analytics Hub 2`. The plan shows the names before you approve it.

## After it finishes

- **Admin consent.** If you couldn't grant it, send the link the installer gives you to an admin.
  They select **Grant admin consent**. Then open the exe again and choose **Run now**.
- **Share the app.** Open **Analytics Hub** in the workspace, choose **Share**, and add people or a
  group. They also need **Build** on `ValueLens Model` (its **Manage permissions** page), or Viewer
  on the workspace.
- **Own reports.** Connect Power BI Desktop to `ValueLens Model`.
- **Someone else takes over the pipeline?** The notebooks run as the person who last changed the
  pipeline, or the schedule's owner. Give them Key Vault Secrets User on the vault and Contributor
  on the workspace first.
- **Secrets expire after 12 months.** **Check status** warns you 30 days before. Choose
  **Create new secrets**.

## Microsoft 365 activity

On by default. It fills the app's **Work patterns** page.

**Turn off concealed names**, or the organisation filters won't work on that page. In the
Microsoft 365 admin center, go to **Settings** > **Org settings** > **Services** > **Reports** and clear
**Display concealed user, group, and site names in all reports**. Then choose **Run now**.

## Credit consumption

Optional. It fills the app's Consumption pages. See [Consumption Central](../Manual%20setup/Add%20Credit%20Consumption/).

The installer reads Azure AI and Copilot pay-as-you-go costs for you. Two sources you add yourself:

- **Copilot Studio credits.** In the Power Platform admin center, go to **Licensing** >
  **Products** > **Copilot Studio**. Download the `EntitlementConsumption…_MCSMessages…csv` files
  from the Summary, Environments and Agents tabs. Upload them to `Files/landing/studio` in the
  Lakehouse. Replace them each month.
- **Cowork credits.** Build a Viva Insights query with the Copilot credit metrics and turn on
  auto-refresh. Create a Dataflow Gen2 in the workspace that loads it into `viva_credits_weekly`,
  following the [Viva Insights guide](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric)
  (Schema type *Pivoted*, Data granularity *Row-level data*). Or upload the Consumption
  Dashboard's CSV export to `Files/landing/viva`.

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
| `Fabric couldn't set up the model's connection` | Turn on *Service principals can call Fabric public APIs*, then choose **Repair or change**. |
| `Couldn't connect ValueLens Model to …` | Open the link it shows. Under **Gateway and cloud connections**, pick `ValueLens SQL …`. Then choose **I've connected it myself**. |
| A model refresh fails with `Login failed` | The connection's secret expired. Choose **Create new secrets**. |
| `The app wasn't deployed` | Fix the cause it shows, then choose **Redeploy the app**. |
| `You can't assign Azure roles in …` | See [Credit consumption](#credit-consumption). |
| `You can't add … to …, so its transcripts are skipped` | See [Agent Evaluator](#agent-evaluator). |
| Work patterns says the reports hide user names | See [Microsoft 365 activity](#microsoft-365-activity). |

## Without the exe

If you can't run the exe, run the installer from a clone of this repo with Node.js 22.13 or later:

```text
cd "1. Fabric/installer"
npm install
npx valuelens-install --ui
```

Leave out `--ui` to answer the questions in the terminal. Other commands: `run`, `check`,
`refresh`, `status`, `update`, `deploy-app`, `rotate-secret` and `preview`. Add `--help` for
options. The exe takes the same commands, for example `AnalyticsHubInstaller.exe status`.