# Analytics Hub installer

Sets up Analytics Hub in your tenant, on [Fabric](../fabric/README.md) or [Azure](../azure/README.md),
loads the first data and checks it. This page is the reference. To get going, follow the
[Getting started](../README.md#getting-started) steps:
[Prerequisites](../docs/PREREQUISITES.md) → [Install](../docs/INSTALL.md) → [Check it worked](../docs/INSTALL.md#check-it-worked).

## Install

Paste this into PowerShell. It needs no admin rights: it downloads installer 0.1.0 as a zip,
checks its SHA-256 and opens the installer in your browser.

```powershell
irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1 | iex
```

Or download
[ValueLensInstaller.exe](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/ValueLensInstaller.exe)
and run it. Other versions are on the
[installer releases](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=valuelens-installer-v).
The repo's "Latest" release is usually a dashboard release, not the installer.

## Editing setup and recovering from failures

The browser installer opens **Review and fix setup**, with a summary card for each category.
Choose **Edit settings** on just the category you need: placement, networking, Power BI, data
collection, viewer access, module connections, governance, Ask / AI, identity (Fabric), or schedule
and loading. There is no Advanced settings switch in this view. Azure placement, networking and
schedules group related fields on one screen. **Back to settings** cancels the open category
without changing its saved choices; **Save and close** keeps your draft for next time.

After a failed deployment, use **Edit all settings**, the suggested category (for recognised
region, capacity, model or policy errors), or **Retry saved configuration** directly from the
error screen. You do not need to return Home or repeat unrelated questions. Previous attempts
remain available under **Previous attempts in this session**. **Review and deploy** refreshes checks and shows the plan,
access grants and costs before you approve another attempt. Availability and quota checks are
best effort, not a reservation of Azure capacity.

Unapproved answers are checkpointed beside the install record as
`valuelens-install.json.draft.json` (or `<your-record-path>.draft.json`). The deployed-resource
record is kept separately until you approve the plan. Neither file contains secrets. A pasted
secret stays in memory only, so you may need to paste it again after closing the installer.
Staged CSV selections survive commands in the same installer session. If the installer restarts
or a staged file is removed, Data collection explicitly requires you to select that file again.
If another command has updated the install record since the draft was saved, setup asks you to
keep the latest deployed IDs and archive the older draft, or stop without changing either file.
**Start fresh** archives both the record and its draft; it does not delete cloud resources.

Retries reuse resources where safe. Before changing Azure placement or networking, the installer
checks live resources, including resources left by a failed deployment that returned no outputs.
You can change the SQL region independently while its server has not been created. Existing SQL
servers cannot move regions, and existing Container Apps environments cannot switch networking
in place. Such changes require a separate deployment and, where applicable, a data migration;
the installer will not silently replace or delete resources. Turning Ask off leaves any existing
AI account in place, so review its remaining charges.

Terminal setup and `--yes` keep their existing sequential/default-answer behaviour.
References to **Advanced settings** below apply to terminal setup; in the browser, open the
corresponding settings category directly.

## Before you start

Moved to [Prerequisites](../docs/PREREQUISITES.md). Once you sign in, the **Prerequisites** panel
(`prereqs` in the terminal) checks most of it, and changes nothing.

### Where the secret goes

The notebooks sign in as the app registration with its client secret. Fabric notebooks can't get
Microsoft Graph tokens from a workspace identity, so they need that secret. The installer offers
three places for it. For a new Fabric install, the default is no Key Vault:

| Option | You need | Use it when |
|---|---|---|
| **No Key Vault: keep the secret in the notebooks** (the default) | Nothing in Azure: no subscription and no vault | You want the quickest set-up, have no Azure subscription, or can't create or write to a vault. Anyone with a role in the workspace can read the secret. |
| **Key Vault, written by the installer** | Contributor to create a vault, or write access to an existing one | You want workspace roles not to expose the secret. Choose **Azure Key Vault**, or run `install --key-vault`. |
| **A vault admin will add the secret for me** | Read access to the vault: Key Vault Secrets User, or secret Get and List on an access policy | You want Key Vault but can't write to the vault and can't create one. Offered when the installer finds you can't write. |

Installs that already keep the secret in Key Vault carry on using it. `--flow-identity app` reads
the secret from Key Vault, so it goes to the Key Vault questions.

**A vault admin adds the secret.** The installer shows the vault, the secret name and one
Azure Cloud Shell command for the admin. The command creates a new client secret on the app and
stores it in the vault in one step, so nobody, including the installer, sees its value. If you
don't have read access yet and can't give it to yourself, the command gives it to you as well.
The installer can make the admin an owner of the app, so they can create its secret: enter their
email when asked. Then answer **Has the admin added it?** with **Yes, carry on**, or choose
**Stop and resume later** and run the installer again once it's there. Your answers are kept.
Read access is all the notebooks need: they read the secret with `notebookutils` as the person
the run uses. The choice is recorded in the install record as `keyVault.mode: "keyvault-admin"`.

**No Key Vault: keep the secret in the notebooks.** The default for a new Fabric install: take it
at the **Where should the app's client secret go?** question, or run `install --no-key-vault`
(`--secret-in-notebook` still works). It's also recommended when you pick Key Vault but can't
create a vault or write to the one you picked. The installer states the trade-off and asks you to
confirm (with `--yes`, the default is taken):

- **Anyone with a role in the workspace can read the secret**, Viewer included, and so can anyone
  a notebook is shared with. They could use it to read your tenant's data through Microsoft Graph
  until it expires. Key Vault avoids that: the notebooks read the secret from the vault at run
  time, so a workspace role doesn't expose it.
- It is copied into notebook run snapshots, exports and deployment pipelines.
- There's no vault audit log of who read it, and no vault network rules.

To limit that, the installer:

- Gives the secret a short life: **90 days** by default. Change it with `--secret-days <n>` (1 to
  730), or under **Advanced settings**.
- Replaces it on every install, **Repair or change** and `update`: it writes a new secret into
  the notebooks, then removes the old one from the app. If the rewrite stops part-way, the old
  secret is kept until the next run finishes.
- Won't write it into a workspace connected to Git, so it never reaches source control. Disconnect
  Git under **Workspace settings** > **Git integration**, or choose Key Vault.
- Never writes it to the install record or the logs. `valuelens-install.json` holds only the
  secret's ID and expiry date.

The installer records `keyVault.mode: "notebook"`. Power Automate flows still work in this mode,
because they sign in to OneLake rather than read the secret (unless you choose
`--flow-identity app`). If you brought your own app, the installer can't make its secrets, so it
doesn't replace yours: paste a new one with **Create new secrets** (`rotate-secret`). To move to
Key Vault later, run the installer again and choose **Use Key Vault instead**. It rewrites the
notebooks to read the secret from the vault and removes the secret they held from the app.

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

## Azure target

The installer can also set up Analytics Hub in **your Azure subscription**. Start it with
`--target azure`, or pick **Your Azure subscription** as the first wizard answer.

You need:

- Contributor plus User Access Administrator (or Owner) on the subscription or resource group. Or,
  for least privilege, Contributor and a limited Role Based Access Control Administrator on just a
  resource group your Azure admin creates: see
  [Least-privilege Azure install](../docs/AZURE-LEAST-PRIVILEGE.md).
- Permission to register Entra apps, or an Application Administrator.
- A Global Administrator or Privileged Role Administrator to grant the managed identity's Graph app
  roles, or to use the admin links the installer prints.
- Power BI Pro or PPU, and permission to create or use the chosen Power BI workspace.
- To publish the Teams app for you: the Teams Administrator or Global Administrator role, and consent
  to `AppCatalog.ReadWrite.All` for Microsoft Graph Command Line Tools at a second sign-in. Without
  them, a Teams admin uploads the generated package: see
  [Give it to everyone](../azure/teams/README.md#give-it-to-everyone).
- The tenant settings *Service principals can call Fabric public APIs* (enabled for a group that holds
  the managed identity, so the jobs can refresh the model) and *Semantic Model Execute Queries REST
  API* (for the app's queries).
- For Agent Evaluator: System Administrator in each Power Platform environment you pick, so the
  installer can add the jobs' managed identity there. Otherwise an admin adds it: see
  [Agent Evaluator](#agent-evaluator).

It creates or reuses a resource group and deploys a managed identity, Storage, Log Analytics,
Azure SQL Database serverless, Container Apps jobs, and the web app from the ARM template in
`src/azure/main.arm.json`. It also creates the Azure web app registration, an SQL reader app
registration, a Power BI workspace and model, and an `AnalyticsHub-Teams.zip` package (the app as a
Teams tab, built by `src/azure/teams/build-package.mjs`) next to the install record. It publishes the
package to your org's Teams app catalog, and later runs update that app rather than add another. If
it can't, if you say no when the plan asks, or if the sign-in isn't finished within 5 minutes, it
prints the steps to upload it by hand and carries on.

Every module is supported on Azure: `core`, `orgData`, `m365Activity`, `agent365`, `productFeedback`,
`consumption`, `agentEvaluator` and `defender`. Credit consumption deploys the Consumption Central model,
gives the jobs' managed identity Cost Management and Azure AI roles, and creates the Copilot Studio flow,
signed in as you (`--flow-identity app` is Fabric only). With public endpoints the flow writes to the
storage account's `landing` container and you get **Storage Blob Data Contributor** on it. With private
networking it writes to a SharePoint folder you name, and the managed identity gets **Sites.Selected** read
on that site (a SharePoint or Global administrator grants it). See
[Azure](../azure/README.md#credit-consumption).
The Agent 365 registry comes from its CSV export, which you drop in the same place, under
`agent365`; the Agent 365 API is Fabric only for now. See
[Agent 365 registry](../azure/README.md#agent-365-registry).
Product feedback comes from its CSV exports, which you drop there too, under `product_feedback`; the
emailed export flow is Fabric only for now. See [Product feedback](../azure/README.md#product-feedback).
Workday org data, under the advanced settings, comes from its CSV export, which you drop there too,
under `workday`. See [Workday org data](../azure/README.md#workday-org-data).
Agent Evaluator deploys the Agent Evaluator model and adds the jobs' managed identity to the Power
Platform environments you pick, so the jobs can read their Copilot Studio transcripts: see
[Agent Evaluator](#agent-evaluator).
Agent configuration and Foundry from Azure
Resource Graph also works on Azure: see [Agent configuration and Foundry](#agent-configuration-and-foundry).
The app's Ask page answers with an Azure OpenAI model, an AI Services account the installer creates
by default or a deployment you already have: see [Ask](#ask).
Re-runs are incremental and use the same
`valuelens-install.json`, with `target: "azure"` and an `azure` block. The installer tags every Azure
resource with `valuelens-install-id` and stops rather than modifying untagged resources with colliding
names.

### A large tenant on Azure

On a tenant with more than 10,000 Copilot seats, setup sizes Azure for the tenant and asks before
anything costs more:

- **Power BI capacity.** Setup recommends F64 or larger and suggests the first active capacity that
  size. It warns when the semantic model would sit on shared capacity, where a model is limited to
  1 GB.
- **Azure SQL.** **Azure placement** offers to let the database scale up to 4 vCores and carry on
  past the free offer's monthly allowance, for about $30-80 a month. Otherwise, when the allowance
  runs out, Azure pauses the database until next month and the jobs stop until then.
- **Web app.** **Azure placement** offers to keep one replica running, for about $10-20 a month, so
  the first visit after a quiet spell doesn't wait while the app starts.

The prices are indicative: check the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/).
Neither paid option is on unless you choose it: `--yes` never turns one on, and **Repair or change**
keeps what you chose. The plan also warns when the sizing looks small and says where to change it:
the free offer, fewer than 4 max vCores from 30,000 seats, the run job's time limit, and shared
capacity. If your organisation's policy rules a change out, setup still works and the loads are
slower. Tenants with 10,000 seats or fewer aren't asked or warned, and deploy as before.

Each run of the collector job has 4 vCPU, 8 GiB and up to 4 hours, which Azure enforces. The run
loads the data and then refreshes the semantic models, waiting up to 2 hours for each refresh. On a
large tenant the first load may not fit in one run. The audit collector records each time window as
it finishes, so the next run (the next scheduled one, or **Run** on the home page) queries only the
windows still to do, and then loads them all. The dashboard fills in once that's done. A reload of
more history carries over the same way: when a run stops at 4 hours, the next runs carry on with it,
and the dashboard gets the extra history once a run has loaded all of it. At 20,000
seats, start with 30 days of history and [load more](#load-more-audit-history) once the first load
has finished. In an offline test at 20,000 seats, with the audit service simulated, the run stayed
within the job's memory and disk. Collecting the audit records took about 3 minutes for the first
30 days and 18 minutes for 180 days, plus the time each audit query waits in Microsoft's queue,
which the test couldn't measure. Processing them took about 3 minutes for the first 30 days, 5
minutes for a nightly run and 25 to 35 minutes for 180 days. How long the refresh takes depends on
the capacity and the history loaded.

### Demo mode

Under [Advanced settings](#advanced-settings), the wizard asks which data the dashboard shows. **Demo mode (sample data)**
deploys everything as usual but sets `VALUELENS_SAMPLE_DATA=true` on the run job, so each run publishes
the synthetic sample bundled in the jobs image (dates moved forward to end last week) instead of calling
the tenant's APIs. It's recorded as `azure.sampleData`. Demo mode leaves
[credit consumption](../azure/README.md#credit-consumption) out for now: the installer deploys the
Consumption Central model once you switch. To switch to tenant data, run the installer again,
choose **Yes** for the advanced settings and pick **Your tenant's data**; the next run replaces the sample.
There's no Agent Evaluator sample, so demo mode reads no transcripts and hides those pages. It leaves
the jobs' managed identity in its environments for when you switch to your tenant's data.

### Networking

Under [Advanced settings](#advanced-settings), the wizard asks how the app, jobs and Power BI reach Azure SQL and Storage:

- **Public endpoints** (default). SQL allows Azure services and Power BI connects to it directly.
- **Private networking**. Choose this where Azure Policy keeps public network access off (common on
  managed and MCAPS subscriptions; the installer says so when what-if hits `DenyPublicEndpointEnabled`).
  On a first install, when an Azure Policy assignment denies Azure SQL public access or modifies it
  to `Disabled`, the installer names it and uses Private networking: SQL with public access off can't
  take the firewall rule that public endpoints need. Your machine never connects to SQL either way:
  the migrate job creates the schema and reader user over the private endpoint, and Power BI goes
  through the VNet data gateway. Policy exemptions aren't read.
  It adds a VNet whose subnets share a network security group, private endpoints and private DNS
  zones for SQL, Storage (blob, dfs, table) and the Ask AI Services account when the installer
  creates it, a VNet-integrated Container Apps environment, and a Power BI **VNet data gateway** that
  the model's SQL connection runs through. SQL uses the Proxy connection policy, so everything stays
  on port 1433. Storage, AI Services and Log Analytics turn public network access off too. The web
  app keeps public ingress, so people can open it.
  - **Private DNS zones.** Landing zones often deny private DNS zones outside a hub subscription, or
    let a policy add the DNS records. The wizard then asks how to handle the `privatelink.*` zones:
    - **Create them in this resource group** (default). If the resource group already has one of
      them that this install didn't create, yours or another Analytics Hub install's, the preflight
      names it and stops before deploying: the install would tag the zone as its own, so its
      uninstall would try to delete it. To use the zones there, choose **Use existing zones in
      another resource group** and give this resource group's ID, after creating any of the zones
      that aren't there yet. Or install into another resource group.
    - **Use existing zones in another resource group.** Give the resource ID of the hub resource group that holds them. Every
      zone must already exist there, including the three AI zones when Ask is created. The installer
      links the VNet to them, which needs **Private DNS Zone Contributor** on that group.
    - **Leave DNS to Azure Policy or the network team.** No zones and no DNS records. The jobs can't reach SQL or Storage
      until a policy or your network team adds them, so the first migrate may fail.
  - The setting is saved as `azure.privateDns`: `{ "mode": "existing", "resourceGroupId": "/subscriptions/<id>/resourceGroups/<name>" }`.
  - Container Apps logs go to Log Analytics through a diagnostic setting, in the
    `ContainerAppConsoleLogs` and `ContainerAppSystemLogs` tables. Querying them from a public network
    needs an Azure Monitor Private Link Scope.
  - When Azure Policy blocks the deployment, the installer names each policy, its assignment and the
    resource it blocked, and prints the command that shows the full error. When any deployment
    fails, it reads the deployment operations and shows each failing resource's own error code and
    message, not just `DeploymentFailed`.
  - It needs an active Fabric (F or trial) or Power BI Premium capacity to host the gateway. The
    Power BI workspace is assigned to it.
  - The preflight registers the `Microsoft.Network/AllowBringYourOwnPublicIpAddress` subscription
    feature, which VNet-integrated Container Apps environments need. It's approved automatically.
  - It adds about $30–40 a month (four or five private endpoints and DNS zones). The gateway uses capacity units
    while refreshing.
  - Networking can't be changed in place. Uninstall and install again to switch.

### Regions and images

- **Region preflight.** On a first install, the region list shows only the regions where every
  resource can go. A region is left out if any of these are true:
  - Azure Policy denies it. The installer reads the built-in **Allowed locations** and **Allowed
    locations for resource groups** policies, either assigned directly or inside an initiative,
    and simple custom deny rules on `location`.
  - The subscription isn't offered one of the resource types there.
  - Standard_LRS storage is restricted there.
  - Azure SQL is restricted there.

  The installer says why each region was dropped. If no region passes, it stops before deploying
  anything. It still deploys if it can't read a policy, says so, and leaves that check to Azure.
  The Ask model's account only moves to regions that policy allows. A re-run keeps its region.
- `azure.sqlLocation` puts Azure SQL in a different region from everything else. Some subscriptions
  can't create SQL in busy regions (for example uksouth, northeurope or westeurope on MCAPS). The
  preflight checks SQL capability and points at this setting. With **Yes** to advanced settings, the
  region list keeps regions where only SQL is blocked, and the Azure SQL list offers only regions
  where SQL can go. The private endpoint can be in another region from the server.
- `azure.images` overrides where the jobs and web images come from, for air-gapped tenants or testing
  an unreleased build: `{ "registry": "myacr.azurecr.io/valuelens", "registryResourceId": "<ACR
  resource ID>", "tag": "dev-abc123" }`. With `registryResourceId` set, the managed identity is granted
  AcrPull. Build into your registry from the repo root with
  `az acr build -r myacr -t valuelens/valuelens-jobs:<tag> -f "azure/jobs/Dockerfile" .` (and the
  same for `valuelens-web` with `azure/web/Dockerfile`). If the upload fails on long `node_modules`
  paths, build from a folder that holds only the paths the Dockerfile copies.

If the database migration job fails, setup stops before the first load and prints the
`az containerapp job logs show` command for its logs. Fix the cause and run install again; finished
steps are skipped.

Azure commands:

- `run` starts the Container Apps run job, unless a run of it is already going. Then it says which
  one, and to run `run` again once it has finished.
- `status` shows job executions, the web URL, pending admin actions, and SQL reader secret expiry.
  With Agent Evaluator it also shows which environments the jobs' managed identity can read, and
  what the jobs' last read found in each.
- `refresh` starts a Power BI model refresh. It refreshes the Agent Evaluator model only once the
  jobs' managed identity can read one of its environments.
- `update` re-runs preflight/what-if and redeploys with the current installer image tag.
- `rotate-secret` creates a new SQL reader secret and rebinds the Power BI credential.
- `uninstall` deletes the created resource group, or only tagged resources if you used an existing group.
  Before that it removes what it added in each Agent Evaluator environment: see
  [Agent Evaluator](#agent-evaluator).
  It waits up to 45 minutes for Azure to finish deleting the group (`--no-wait` doesn't). In an existing
  group it deletes each tagged resource before what it depends on, and waits for each to go. If any are
  left, it lists them and fails: run `uninstall` again to finish. It also deletes
  the Power BI workspace if the installer created it, after asking.

## Run it

Moved to [Run it](../docs/INSTALL.md#run-it).

### Advanced settings

After the data sources, the installer asks **Change the advanced settings?** With **No** (the
default, and what `--yes` answers) it uses what you chose last time, or else the defaults below.
With **Yes** it asks about each one as it comes. To change one later, choose **Repair or change**,
then **Yes**.

| Setting | Default |
|---|---|
| [Power BI](#power-bi-reports) | The semantic model, the Power BI reports and the app. Or the model and reports, the model and app, the model only, or neither. |
| Who can view | A new **Analytics Hub Viewers** group. You're who people ask for access. **Manage access** changes it later. |
| [Audit history](#load-more-audit-history) for the first load | 30 days. Or 90 or 180. |
| [How many people are in the tenant](#a-large-tenant) | More than 10,000 on an F64 or larger capacity or with more than 10,000 Copilot seats assigned, otherwise up to 10,000. An existing install keeps its size. |
| Lakehouse name | `Analytics_Hub`, or the next free name (`ValueLens` on earlier installs, which keep it). Spaces and hyphens become underscores. |
| A new Key Vault's resource group, region and name, and the secret's name | `rg-valuelens`, the capacity's region, `valuelens-` and six random characters, and the default secret name. If you can't use `rg-valuelens`, it asks. |
| Schedule | Daily, at the default time. Or weekly, and the time (UTC). |
| Run the first load as soon as setup finishes | Yes. |
| Value page currency | US dollars. See below. |
| [Agent configuration and Foundry](#agent-configuration-and-foundry) | The whole tenant, agents and Foundry. |
| [Ask data agent](#ask) | Yes, on a paid F2 or larger, or Premium, capacity. |

**Currency for the Value page.** Licences and credits are billed in US dollars, so it reports in
dollars unless you choose another, such as euros or pounds. For another currency you can type how
many of it make $1, or leave it blank and set it under **Prices** in the app. It also sets the
Power BI model's currency symbol. Nothing is looked up online. To choose it without the question,
use `install --currency GBP --exchange-rate 0.79`. The installer keeps your choice for next time.

The [Azure target](#azure-target) asks the same question. Its advanced settings also cover
[demo mode](#demo-mode), the Azure SQL region, the name prefix, extra tags,
[networking](#networking), where credits come from,
[Workday org data](../azure/README.md#workday-org-data), agent configuration and Foundry, and
[which model Ask uses](#ask).

## After it finishes

Moved to [After it finishes](../docs/INSTALL.md#after-it-finishes).

### When an update has to clear a model's data

`update`, and `install` or **Repair or change** run from a newer version, update each semantic
model in place and keep its data. Some changes, such as new columns, can't keep it: Fabric then
turns the update down and changes nothing. The installer names the model, says reports on it show
no data until it's reloaded from the Lakehouse or Azure SQL (which isn't changed), and asks before
clearing it. Answer no, and the run stops with that model unchanged.

`--yes` alone never clears a model's data: the run stops instead. For an unattended run that
may clear it, add `--allow-model-reset`. In the browser setup, the page asks.

After a model's definition changes, the installer reloads it, and only says it's done once a
whole-model refresh that it requested after the change was applied has finished cleanly:
Completed, with no warnings or errors in its details. A refresh it didn't request, such as the
pipeline's or one already running that it had to wait behind, never counts, because it may cover
only some tables; nor does one that reported problems, or one whose details can't be read. Until then
the install record notes that the model is owed a reload, so if the run stops, fails or can't
tell, the next `install`, `update` or **Repair or change** reloads it, even with nothing else to
change. If the installer can't tell whether the change itself was applied, the next run applies
it again before reloading. If that reload fails or can't run, `update` and `install` end as failed
and say which models have no data. Run `refresh`, or run the same command again. If other
refreshes keep running so the installer can't start its own, a waited `refresh` fails and says so
rather than reporting the model refreshed. Run without
waiting, the refresh is only started, so the run says the model is still reloading rather than
"Up to date". On the Azure target, the model is reloaded before any first load or history reload
starts, rather than assuming that load reloads it.

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

On the [Azure target](#azure-target) the installer publishes no reports: the web app's pages read
the models. It deploys the Agent Evaluator model when Agent Evaluator is on with an environment,
outside [demo mode](#demo-mode).

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
    "agentEvaluator": false,
    "defender": false
  }
}
```

Older installs may not have `modules`; the app then probes the model as before.

On Azure the web app serves the same `modules` in its `/app.config.json`, from the list the
installer gives the jobs (`VALUELENS_MODULES`). An Azure install gets it at its next **Update** or
**Repair or change**; until then the app probes as before.

**Editing a report.** A new installer version may bring a new version of a report. **Update** and
**Repair or change** then ask before replacing it, because that replaces edits made in Power BI.
To keep your edits, use **File** > **Save a copy** in Power BI first and edit the copy.

**Blank visuals.** The Tornado chart, Word cloud and Deneb visuals need the tenant setting
*Allow visuals created using the Power BI SDK*. If you're a Fabric administrator, the installer
checks it.

Without the reports, publish the templates yourself: open `ValueLens - Fabric.pbit` in Power BI
Desktop (June 2024 or later) with the values the installer shows, and publish it to the workspace.

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

**Loaded, with a warning.** Some loads finish but couldn't read everything. When that happens, the
card is amber, and in the terminal the line is too, with the reason:

- Resource Graph was refused (`arg_status`).
- Defender isn't licensed (`defender_status`).
- Agent Evaluator found no transcripts (`evaluator_status`).

`load_log` records these as `Warning`, with a `reason_kind` of `empty`, `forbidden` or
`unlicensed`. A warning doesn't fail the run. The app's freshness line shows the latest status and
reason for each source. It reads them after the next model refresh, because the status step runs
after the refresh.

**Rerun only what failed.** Choose **Rerun failed loads**, or run `rerun-failed`. It runs the
failed loads again, then the steps that depend on them, and refreshes the model. Loads that worked
aren't run again, unless they read what a rerun step writes: when the Cowork Dataflow reruns, so do
the Viva load and the consumption model refresh, even if they succeeded on the empty input. A Viva
load that got no rows from the Dataflow shows as **to do**, not loaded. If the capacity is still busy, it waits five minutes and tries again, twice. It
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
people are in the tenant, under [Advanced settings](#advanced-settings). A new install chooses it
for you on an F64 or larger capacity (a trial counts as the F size it matches, so FTL64 does), or
when more than 10,000 Microsoft 365 Copilot seats are assigned. The installer reads the assigned seats in the prerequisite checks and shows them in the
plan. An install that already has a tenant size keeps it, but the plan warns when the seats have
outgrown it. Then:

- The audit log is read in 2-hour windows instead of 24-hour ones. A long window can hold too many
  records, and the audit service fails it after an hour or more. A window that fails is split after
  one retry instead of three.
- Each daily run reads the last 3 days again, not 7, which keeps the extra queries down. Records
  that arrive more than 3 days late are missed.
- The loads and the model refresh get longer time limits: up to 6 hours for the audit log.
- If a run can't finish the history in time, it stops before writing anything and the retry carries
  on from where it stopped. Windows already read aren't read again. `run` does the same.

The slow Graph loads get longer time limits for both sizes than the pipeline template's:

| Load | Template | Up to 10,000 | More than 10,000 |
|---|---|---|---|
| Agent 365 registry | 2 hours | 3 hours | 6 hours, retried twice |
| Copilot Studio transcripts | 2 hours | 3 hours | 6 hours |
| Defender | 30 minutes | 1 hour | 2 hours |

The Agent 365 registry re-reads each agent's detail once a week, spread across the week: each agent
has its own day, so a daily run refreshes about a seventh of them. New and changed agents are read
first. Within a time budget set below the time limit (2 hours, or 4.5 hours for more than 10,000),
the registry leaves any refreshes still to do to the next run and writes what it has; nothing is
older than 7 days for long.

With 30,000 or more seats on a capacity smaller than F64, the plan warns and says to choose an F64
or larger capacity in **Fabric placement**. If your organisation's policy keeps you on the smaller
capacity, setup still works, but the loads take longer and may hit their time limits.

Expect the first load to take several hours. Start with 30 days, use an F64 or larger capacity,
and [load more history](#load-more-audit-history) later. Don't run audit searches in the
Purview portal while it loads. To change the tenant size, choose **Repair or change**, then **Yes**
for the advanced settings. An install from an earlier version keeps its audit windows and time
limits until you do. An install that has a tenant size gets the new time limits on its next
**Update** or **Repair or change**, and keeps its data and settings.

On the Azure target, the Power BI capacity, Azure SQL and web app sizing and the run job's time
limit are under [A large tenant on Azure](#a-large-tenant-on-azure).

### Load more audit history

The first load reads the history you chose: 30, 90 or 180 days. To load more later, any of these
work:

- **Repair or change** asks *Load more audit history?* once the first load has finished, offering
  only more than you have. Keep is the default. The plan shows the reload, and it runs once,
  straight after the repair. Later runs load only what's new. If a run is already going, the reload
  doesn't start: use `run --backfill-days <n>` once that run has finished.
- On the home page, the **Run** row has an **Audit history** picker: the usual run, or 30, 90 or
  180 days.
- In the terminal: `run --backfill-days <n>`, with `<n>` from 1 to 180.

The record keeps the most history loaded, once the reload has started. On Fabric, windows already
read are reused, so a reload only queries what's missing. On a large tenant, 90 or 180 days can
take many hours.

On the [Azure target](#azure-target), the reload starts the run job once with
`VALUELENS_AUDIT_BACKFILL_DAYS` set, and leaves its usual settings alone. Job images older than
this installer ignore it and run as usual: run `update` first if yours is.

The run records the reload before it reads anything. If it stops short, at the run job's 4-hour
limit or on a query that fails, the next runs carry the reload on and query only what's missing.
The audit history and Agent Evaluator both carry it over until they've finished it: the audit
history until a run has loaded every window, and Agent Evaluator until it has read each environment.
The dashboard gets the extra history once a run has loaded all of it.

## Data sources and exports

| Source | Connected (API) | Upload CSV: where to export it | Fills |
|---|---|---|---|
| Copilot usage and licences | Always | | Every page |
| Org data (Entra ID) | Always | | Organisation filters |
| Workday org data | | Workday: a report of active workers with **Primary Work Email** | Organisation filters |
| Microsoft 365 activity | Yes | | M365 activity |
| Agent 365 registry | Needs an Agent 365 licence. Fabric only for now: on Azure, use the export | Microsoft 365 admin center > **Agents** > **All agents** > **Export** | Agents |
| Product feedback | No API. **Power Automate (emailed export)**: a flow saves exports emailed to you. Fabric only for now: on Azure, use the export | Microsoft 365 admin center > **Health** > **Product feedback** > **Export** | User Feedback |
| Copilot Studio credits | **Connected (Power Automate flow)**, the default: a daily flow reads the licensing API (tenant, environment, agent and per-user figures) | Power Platform admin center > **Licensing** > **Products** > **Copilot Studio** (Summary, Environments, Agents and Users) | Consumption Central |
| Copilot Cowork credits | **Connected (Dataflow)**: a Dataflow Gen2 reads your Viva Insights query | Viva Insights > Copilot Consumption Dashboard > **Export** | Consumption Central |
| Azure AI costs | Yes | | Consumption Central |
| Agent Evaluator | Yes | | Agent Evaluator |
| Defender (shadow AI and agent risk) | Yes, through Microsoft Graph. Needs Defender for Endpoint P2 or Defender for Cloud Apps | | Governance: Shadow AI and the *No sign-in required* flag |
| Agent configuration and Foundry (Azure Resource Graph) | Off by default. See [Agent configuration and Foundry](#agent-configuration-and-foundry) | | Governance: agent configuration, Foundry estate and the *No sign-in required* flag (ahead of Defender) |

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

**On Azure** there's no Lakehouse, and **Upload exports** is Fabric only. Drop the Agent 365 export
in `agent365/` in the storage account's `landing` container or, with private networking, in the
`agent365` folder under the SharePoint folder you gave the installer. Each run loads the newest
one. Product feedback exports go in `product_feedback/` the same way, and each run loads them all.
The Workday export goes in `workday/`, and each run adds the newest one to the org data. See
[Agent 365 registry](../azure/README.md#agent-365-registry),
[Product feedback](../azure/README.md#product-feedback) and
[Workday org data](../azure/README.md#workday-org-data); credit files are in
[Credit consumption](../azure/README.md#credit-consumption).

### Power Automate flows

The installer creates these flows in the Power Platform environment you pick, **turned off**, then
helps you sign in to them and turns them on. It preselects the tenant's default environment. The
environment's DLP policy must allow *HTTP with Microsoft Entra ID (preauthorized)*, and people with
access to the environment can see the flows.

| Flow | When | What it does | Sign in to |
|---|---|---|---|
| `Analytics Hub - Copilot Studio credits` | Copilot Studio credits set to **Connected** (the default) | Each day, an hour before the pipeline, reads credits by agent, by user and the tenant's entitlement from the Power Platform licensing API. The first run loads about six months; later runs restate the last ten days | Power Platform API and OneLake |
| `Analytics Hub - Product feedback` | Product feedback set to **Power Automate (emailed export)**, on Fabric only for now | Saves product feedback exports emailed with the subject `Copilot Product Feedback` | Office 365 Outlook and OneLake |
| `Analytics Hub - Agent inventory` | Agent configuration and Foundry set to **Connected**, with agents | Each day, an hour before the pipeline, saves the Power Platform inventory of Copilot Studio agents, environments and agent flows to `Files/arg_inventory`, for when Resource Graph won't give the app the agents | Power Platform API and OneLake |

They need Power Automate Premium: whoever signs in to the HTTP with Microsoft Entra ID
connections, and you as the flows' owner. See the
[Power Platform admin checklist](../docs/PREREQUISITES.md#power-platform-admin-for-the-copilot-studio-credits-flow).

**The installer signs them in with you.** Straight after it creates the flows, it:

1. Makes the HTTP with Microsoft Entra ID connections the flows need, with their URLs filled in,
   named `Analytics Hub - Power Platform API` and `Analytics Hub - OneLake` (on Azure,
   `Analytics Hub - Azure Storage (<account>)`). It reuses ones of the same name that are signed in
   to already.
2. Gives one sign-in link for each, and says who signs in. If a link opens nothing, your browser
   blocked the pop-up: allow pop-ups for `make.powerautomate.com` and `login.microsoftonline.com`.
   If there's no link, it names the connection to find on the environment's Connections page and
   click **Fix connection**.
3. Waits while you sign in. Choose **I've signed in, check now**, or **Do this later**. `--yes`
   doesn't wait.
4. Once they're signed in to, points each flow at them and turns it on, so the Studio flow can run
   before the first pipeline load. Run `update` to finish this later.
5. Deletes the connections it made before that nobody signed in to and no flow uses. It lists your
   other HTTP with Microsoft Entra ID connections that aren't signed in to, but never deletes them.

The feedback flow's Outlook connection, and the Key Vault one with `--flow-identity app`, are still
yours to sign in to in Power Automate. If the installer can't do any of this, it shows the steps
below as soon as it creates the flows, and again at the end. If you leave the sign-ins for later,
Copilot Studio data arrives after the flow runs and the next daily load.

To finish a flow by hand:

1. Open it in Power Automate. Allow pop-ups for `make.powerautomate.com`: each sign-in opens one.
2. Sign in to its connections, or pick the ones the installer made. Each action's name ends in the
   connection it uses: "via Power Platform API", "via OneLake" or "via Azure Storage".
   - **HTTP with Microsoft Entra ID (preauthorized), for the Power Platform API** (Studio flow):
     Base Resource URL and Resource URI `https://api.powerplatform.com`. Sign in as a Power
     Platform, Billing or Global administrator. For the agent inventory flow, sign in as a Power
     Platform administrator or Global Reader: the inventory API takes delegated sign-ins only.
   - **Office 365 Outlook** (feedback flow): sign in as the mailbox the export is emailed to.
   - **HTTP with Microsoft Entra ID (preauthorized), for OneLake**: Base Resource URL
     `https://onelake.dfs.fabric.microsoft.com`, Resource URI `https://storage.azure.com`. Sign in
     as someone with Contributor or higher on the workspace.
3. Save, then turn it on.
4. For product feedback, schedule the export to be emailed to that mailbox with the subject
   `Copilot Product Feedback`, in the
   [Microsoft 365 admin center > Health > Product feedback](https://admin.microsoft.com/Adminportal/Home#/tenantfeedback).

**Load the Studio credits now.** The Studio flow loads its first six months on its first run,
which is otherwise the next day, an hour before the pipeline. Once it's on, click **Run** in
Power Automate to load them now. Or use `run`, or **Repair or change**: when the flow is on and
hasn't loaded them yet (there's no `Files/analytics_hub_flows/studio_backfill_done` in the
Lakehouse, or on Azure no successful run), the installer offers to run it as you, and to wait for it
so the pipeline that follows picks up its files. `--yes` never runs it. If the flow is off, or
Power Automate turns the run down, the installer shows these steps instead.

The flows write to the drop folder as the person who signed in to the OneLake connection, so
there's no secret and no Key Vault connection. That works when your Key Vault only takes private
connections. The Fabric tenant setting **Users can access data stored in OneLake with apps
external to Fabric** must be on (it is by default). Workspaces that block public inbound access
can't take writes from Power Automate.

**Keep them running.** A flow runs as the people who signed in to its connections. Sign in with a
dedicated admin account rather than your own, and add a co-owner. Sign in again if the account's
password is reset, the account is disabled, or the flow hasn't run for about 90 days.

**Write as the app instead (optional).** `install --flow-identity app` makes the flows write as
the app registration, with its secret read from Key Vault through an **Azure Key Vault**
connection, and gives the app **Contributor** on the workspace. The Key Vault connector needs the
vault to allow public network access, so use this only where it does. It needs the secret in Key
Vault, not in the notebooks.

If a flow can't be created (no environment, or no maker rights), the installer writes it to a file
beside your answers in `Documents\Analytics Hub`. Create a cloud flow and paste the file's
`definition` in. The [Manual setup flows](../fabric/flows/README.md) describe the feedback
flow by hand. **Repair or change** updates existing flows and keeps the connections you signed in
to. If an update adds a connection, the installer turns the flow off and tells you which one to
sign in to. Dataverse won't update a flow that still has a connection to sign in to, so a flow
whose connections were never signed in to is replaced with the new version instead, and so is one
Dataverse refuses to update. Its connections are still there to pick when you sign in again.

The Studio flow only sees environments that have Copilot Studio credits allocated, and its
per-user figures come from an undocumented API route, so they're best effort. Exports are still
accepted: for a month an export covers, its figures are used, and they add users' email
addresses, the M365 Copilot licence flag and the exact prepaid split.

### Commands

| To | Run |
|---|---|
| Choose sources without the questions | `install --data productFeedback=csv,agent365=api --yes` |
| Upload exports during the install | `install --data productFeedback=csv --csv feedback.csv` |
| Create the product feedback email flow | `install --data productFeedback=flow --flow-environment https://contoso.crm.dynamics.com` |
| Read Copilot Studio credits with the flow | `install --data studioCredits=api --flow-environment https://contoso.crm.dynamics.com` |
| Have the flows write as the app, with its secret in Key Vault | `install --flow-identity app` |
| Read Cowork credits with a Dataflow | `install --data coworkCredits=api --viva-partition <id> --viva-query <id>` |
| Read agent configuration and Foundry from Resource Graph | `install --data resourceGraph=api --arg-management-group <id>` |
| Report the Value page in another currency | `install --currency GBP --exchange-rate 0.79` |
| Upload exports later, then load them now | `upload feedback.csv agents.csv --run` |
| Run only the loads that failed last time | `rerun-failed` |
| Delete the Fabric workspace and everything in it | `uninstall` |
| After signing in to the Cowork Dataflow, refresh it and load Cowork credits | `load-cowork` |
| Add viewers or owners to the viewer group, or choose another group | `access` |
| Show each viewer only the orgs they're given (opt-in) | `access`, then **Turn on org-scoped access**. See [Org-scoped access](../docs/PERMISSIONS.md#org-scoped-access-row-level-security) |

Source IDs for `--data`: `workday`, `m365Activity`, `agent365`, `productFeedback`,
`studioCredits`, `coworkCredits`, `azureAi`, `agentEvaluator`, `defender`, `resourceGraph`. Modes:
`api`, `csv` or `skip` (`defender` and `resourceGraph` take `api` or `skip`, and `workday` takes
`csv` or `skip`).
For `productFeedback` and `studioCredits`, `flow` is the same as `api`. `--feedback-flow` still
works: it's the same as `productFeedback=flow`.
On Azure, `agent365` and `productFeedback` are `csv` or `skip`. `api` warns and uses the exports, as
do `productFeedback=flow` and `--feedback-flow`. `workday=csv` works there too, with org data.
`agentEvaluator=api` ticks Agent Evaluator on Azure as well as on Fabric.
Without `--flow-environment`, the installer asks which environment to use.
With `resourceGraph=api`, `--arg-management-group <id>` reads one management group rather than the
whole tenant, and `--no-arg-agents` or `--no-arg-foundry` leaves agents or Foundry out.
`--currency <code>` sets the Value page currency (US dollars by default), and `--exchange-rate <n>`
how many of it make $1. Without the rate, set it under **Prices** in the app. In the browser, choose
the currency under [Advanced settings](#advanced-settings) instead.

On the Azure target, `upload`, `--csv`, `load-cowork`, `--flow-identity app` and
`coworkCredits=api` are Fabric only for now. `upload`, `--csv` and `load-cowork` stop and name the
folder to put exports in. The other two warn, then the Copilot Studio credits flow signs in as you
and Cowork credits come from the CSV export. See
[Parity with Fabric](../azure/README.md#parity-with-fabric).

`uninstall` on Fabric asks before it deletes the workspace. If the installer didn't create the
workspace, the answer defaults to no. It deletes the workspace's managed private endpoints first,
because Fabric won't delete a workspace that still has them, and waits up to ten minutes for them
to go. It leaves the following alone: the app registration, the Key Vault, the flows, Dataverse
access and the roles it gave.

## Microsoft 365 activity

On by default. It fills the app's **Work patterns** page.

**Turn off concealed names**, or the organisation filters won't work on that page. In the
Microsoft 365 admin center, go to **Settings** > **Org settings** > **Services** > **Reports** and clear
**Display concealed user, group, and site names in all reports**. Then choose **Run now**.

The `M365 Activity` table refreshes incrementally, like the audit table. The model keeps 12 months
of it, and each refresh reloads only the last 35 days. That covers every day the notebook can
rewrite: Microsoft keeps 28 days of reports. The first refresh after installing, or after
**Repair or change** adds the policy to an existing install, still loads all of it once. If you set the
notebook's `RETAIN_DAYS`, make it 0 or at least 400: days it deletes within the last 12 months stay
in the model until they're older than that.

## Credit consumption

Optional. It fills the app's Consumption pages. See [Consumption Central](../fabric/Add%20Credit%20Consumption/).
On the Azure target, see [Credit consumption](../azure/README.md#credit-consumption) instead.
On the **Data sources** screen it's three cards, grouped as **Credit consumption**: **Copilot
Studio credits**, **Copilot Cowork credits** and **Azure AI costs**. Choose any of them.

- **Azure AI costs.** The installer reads Azure AI and Copilot pay-as-you-go costs for you.
  `Ingest_Azure_AI` also fills the Azure capacity and health, billing reconciliation and Foundry
  solution spend pages from ARM, Azure Monitor, Cost Management and the public Retail Prices API.
  It needs no extra roles. Installs from 0.3.5 or earlier get it with **Repair or change**.
- **Copilot Studio credits.** Leave it on **Connected** and finish the
  [Copilot Studio credits flow](#power-automate-flows). To add exports as well, or instead, in the
  Power Platform admin center go to **Licensing** > **Products** > **Copilot Studio**. Download the
  `EntitlementConsumption…_MCSMessages…csv` files from the Summary, Environments, Agents and Users
  tabs, and add them as [exports](#data-sources-and-exports). A new file replaces the last one of
  the same kind, and an export's figures win for the month it covers.
- **Copilot Cowork credits.** Choose **Connected (Dataflow)** where you can. Your Viva Insights
  analyst creates the query first: send them the
  [note in the checklist](../docs/PREREQUISITES.md#send-this-to-your-viva-insights-analyst-first).
  In Viva Insights > **Create analysis** > **Create custom query** > **Consumption query**, they
  keep the preselected credit metrics, turn on **Auto-refresh** and run it. In **Analysis
  results**, the link icon copies its partition and query IDs. Step by step:
  [Running the Viva Insights query](../docs/VIVA-QUERY.md). The
  installer fills in the partition ID with your tenant ID, which is usually right. If you don't
  have the query ID yet, choose **Not yet** to add the query later: Cowork credits use the CSV
  export until then, and you add the IDs with **Repair or change**. With the IDs, the installer
  creates the Dataflow Gen2 `AnalyticsHub_Cowork_Credits`, which loads the query into
  `viva_credits_dataflow`, and the pipeline refreshes it before each Viva load. Its connections
  need signing in once, and the installer can't do that for you:
  1. Open the Dataflow from the link on the **Done** page or at the end of the install.
  2. It shows **Configure connection** twice, once for each thing it connects to: the Viva Insights
     source (the VivaInsights query) and the Lakehouse destination.
  3. On each one, choose **Configure connection**, sign in, then **Connect**.
  4. Choose **Save**, then wait until the Dataflow shows it has finished publishing.
  5. Choose **Load Cowork now**, or run `load-cowork`. It waits for publishing to finish, refreshes
     the Dataflow (trying once more a minute later if the refresh fails straight after the save),
     then runs the Viva load and the consumption model refresh and says how many rows it loaded.

  If the Dataflow isn't signed in yet when the first load starts, the installer leaves it out of
  that run (the pipeline's `SkipCowork` parameter), so the other loads aren't marked as failed,
  and the **Done** page shows an amber **To do: sign in to the Cowork Dataflow** card with these
  steps. Scheduled runs never skip it: until someone signs in, they fail on
  `Refresh_Cowork_Credits` with *Needs sign-in*. Rows in the editor's preview use your own sign-in,
  so they show even while every refresh still fails for want of saved connections. See the
  [Viva Insights guide](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric).
  You need the Viva Insights **Insights Analyst** role. Without the IDs, or if the Dataflow can't be
  created, Cowork credits fall back to the Consumption Dashboard's CSV
  [export](#data-sources-and-exports). Exports can still fill weeks before the query; the
  Dataflow wins for weeks both cover. Fabric also adds **DataflowsStagingLakehouse** and
  **DataflowsStagingWarehouse** items to the workspace for the Dataflow. They're expected: leave
  them. See [staging items](https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview#staging-items-in-your-workspace).

If you can't assign Azure roles, ask an Owner or User Access Administrator to give the app
registration Reader, Cost Management Reader and Monitoring Reader on the subscription. Then
choose **Repair or change**.

## Defender (shadow AI and agent risk)

Optional and off by default, on the Fabric and the Azure target. It fills the **Shadow AI** section of
the app's **Governance** page, and gives the Agent 365 registry a *No sign-in required* flag.

- **What it reads.** Microsoft Defender advanced hunting, through Microsoft Graph
  `POST /security/runHuntingQuery` (`ThreatHunting.Read.All`), and Cloud Discovery in Defender for
  Cloud Apps (`CloudApp-Discovery.Read.All`). The installer asks for both permissions; a tenant that
  doesn't offer one yet gets a warning and that part is skipped.
- **Four probes, each on its own.** Devices that ran or reached a watched AI tool, devices with one
  installed, AI agents and whether they need sign-in, and generative AI apps in Cloud Discovery. A
  probe the tenant isn't licensed for, or can't read, is recorded in `defender_status` and skipped.
  The rest of the load carries on, and the page says what didn't load.
- **Licences.** The device and agent probes need Defender for Endpoint P2 (or Microsoft Defender
  XDR); Cloud Discovery needs Defender for Cloud Apps. The prerequisite check looks for them.
- **The watchlist.** The first run writes a starting list of AI tools to
  `Files/defender/ai_watchlist.csv` (Fabric) or the `landing` container's
  `defender/ai_watchlist.csv` (Azure). Edit it to add tools, and set each tool's `Posture` to
  `Sanctioned`, `Unsanctioned` or `Not reviewed` (the default). Sanctioned tools aren't shadow AI, so
  the page leaves them out.
- **It's a floor, not a census.** Defender sees only onboarded devices and the tools on the
  watchlist. See [Methodology](../docs/METHODOLOGY.md#shadow-ai-what-other-ai-tools-are-in-use).

## Agent configuration and Foundry

Optional and off by default. On the Data sources screen set **Agent configuration and Foundry
(Azure Resource Graph)** to **Connected**, or use `--data resourceGraph=api`. Each day
`Copilot_Resource_Graph_Ingester` reads Copilot Studio agents (authentication, connectors, sharing,
model and channels), Power Platform environments, agent flows, and Foundry resources and projects,
into `arg_agent_config`, `arg_environments`, `arg_agent_flows`, `arg_foundry_resources` and
`arg_status`. An agent's authentication setting feeds the Agent 365 registry's *Sign-in Required*
column, ahead of Defender when both are on. It reads the tenant root group, or under
[Advanced settings](#advanced-settings) one management group you name. On Azure, turn it on under
Advanced settings. It
never fails for want of a role: what it couldn't read is in `arg_status`, in plain words.

Whoever runs the load (the app registration, or on Azure the jobs' managed identity) needs:

- **Foundry:** Azure **Reader** on the management group, or on the tenant root group. The installer
  gives it when you can assign roles there. If you can't, it prints the command for an Owner or
  User Access Administrator:
  `az role assignment create --assignee <app or identity client ID> --role Reader --scope /providers/Microsoft.Management/managementGroups/<group or tenant ID>`.
- **Agents:** one of the Entra roles **Global Reader**, **Power Platform Administrator** or **AI
  Administrator**. If you're a Global Administrator or Privileged Role Administrator, the
  installer gives it **Global Reader** itself, and *Ready to set up* says so. It checks first,
  so a repeat install doesn't add it again. If you aren't, it shows a message to copy to someone
  who is. The message names the role, the app and its object ID, with a link to **Roles and
  administrators** in the Entra admin center. Without the role, Resource Graph returns no agents,
  and the Governance page says *Not collected: permission missing*. See
  [PERMISSIONS](../docs/PERMISSIONS.md#azure-resource-graph).

When Resource Graph won't return the agents, the load reads the newest file the
`Analytics Hub - Agent inventory` [flow](#power-automate-flows) saved instead. The Power Platform
inventory API it calls takes delegated sign-ins only, so the flow reads as the admin who signed in
to its connection. It writes to `Files/arg_inventory` in the Lakehouse, or on Azure to
`landing/arg_inventory`, or with private networking the `arg_inventory` subfolder of the
SharePoint drop folder. Agent Title IDs are matched from the Agent 365 registry, so the load runs
after it. They're matched on its `Bot Id` and `Entra Agent ID` columns, which the admin center's
export doesn't have, so with only the export (on Azure, for now) they stay blank.

On Azure the installer adds `resourceGraph` to the jobs' modules and passes the management group
and what to read (`argManagementGroup`, `argAgents`, `argFoundry`). Demo mode leaves it out.

## Agent Evaluator

Optional. It fills the app's Agent Evaluation pages from your Copilot Studio conversations. See
[Agent Evaluator](../fabric/Add%20Agent%20Evaluator/).

**Which environments.** When you have more than one, the installer always asks which to read.
Read the environments that hold your Copilot Studio agents. It checks each environment for agents,
four at a time, and ticks the ones that have some. If it can't tell, it ticks the default
environment and says so. It lists only environments you're a member of, so ask for access to any
that are missing.

**How far back.** An environment's first run reads up to 180 days of transcripts, including an
environment you add later. After that, each run reads the last 14 days. Copilot Studio keeps
transcripts for 30 days by default, so a first run usually finds about a month's worth.

**When it finds none.** The parser records what it read in each environment in
`evaluator_status`: how many transcripts, over how many days, and why any are missing. When there
are none, the Agent Evaluation page says where it looked and how far back. To add environments,
choose **Repair or change**, then **Agent Evaluator**. If an environment has transcripts but none
are found, the reader likely has only Bot Transcript Viewer there, as on installs from before 0.6.8:
choose **Update**, or **Repair or change**, as a System Administrator of the environment, so the
installer adds the role that reads every transcript. Then
[load more audit history](#load-more-audit-history) once, for example with
`run --backfill-days 30`: later runs read only the last 14 days of transcripts, and a reload reads
up to 180 days, so it picks up the older ones the environment still keeps.

**Who reads them.** On Fabric, the transcript notebook signs in as the app registration. In each
environment you pick, the installer adds it as an application user with the **Bot Transcript
Viewer** role, and gives it a role the installer creates for the install in the root business unit:
*Analytics Hub transcript reader* followed by the first 8 characters of the workspace's ID. That
role holds exactly one privilege, read on the ConversationTranscript table at Organization depth, so
the app reads every transcript in the environment, whoever owns it, and nothing else through it.
Bot Transcript Viewer on its own reads only the transcripts the application user owns, or that are
shared with it. A new role comes with 9 platform privileges of its own, so the installer takes those
off, and reads the role's privileges back before it gives it. It never changes a role it didn't
create. It adds transcript read to its own role only while no user or team other than the app has
the role; otherwise it leaves the role as it is, and prints the steps for a System Administrator.
Installs from before 0.6.8 get the role on **Update**, or **Repair or change**.

If you aren't a System Administrator in an environment you pick, ask one to:

1. Open the [Power Platform admin center](https://admin.powerplatform.microsoft.com) and go to
   **Manage** > **Environments** > the environment > **Settings** > **Users + permissions**.
2. **Security roles** > **+ New role**. Name it, for example *Analytics Hub transcript reader*, keep
   the root business unit, turn off **Include App Opener privileges for running Model-Driven apps**,
   and **Save**. Then set the **ConversationTranscript** table's **Read** to **Organization**, and
   **Save**.
3. **Application users** > **New app user**. Pick the app registration, the root business unit, and
   the **Bot Transcript Viewer** role and the new role. If the app is an application user there
   already, open it, choose **Edit security roles**, tick the new role, and **Save**.

Then choose **Repair or change**, and when it asks, say the app already has access, or already
reads every transcript.

When you untick an environment or the module, or uninstall, the installer takes the transcript
reader role away from the app, and deletes the role if it created it. On Fabric it leaves the app's
application user and its Bot Transcript Viewer role, as before.

**On Azure.** Tick **Agent Evaluator** under **Data collection**, then pick its environments under
**Module connections**, from the same list. The jobs read the transcripts as their managed identity,
the one they already run as, so it's the managed identity that needs to be an application user with
the **Bot Transcript Viewer** role and the transcript reader role in each environment. The role is
named for the install's ID. The web app's registration gets no Dataverse access. The **Transcript
access** step adds both when you're a System Administrator of the environment. When it can't, it
prints the steps above with the managed identity's name and client ID, then asks whether to **Leave
it out for now** or whether **It already has access**. When the managed identity has Bot Transcript
Viewer already, it asks whether to **Carry on for now**, reading only the transcripts shared with
it, or whether **It already reads every transcript**. In step 3 the admin chooses **+ Add an app**
and searches for the client ID, not the name. `--yes` leaves it out, or carries on.

The Agent Evaluator pages show while the module is on and its model is deployed, outside
[demo mode](#demo-mode), even before the managed identity can read an environment. They stay empty
until the jobs first read transcripts. The installer refreshes the model, turns on its scheduled
refresh and gives the jobs the environments to read only once the managed identity can read one of
them. The jobs' modules include `agentEvaluator` whenever the module is ticked, as on Fabric.

When you untick an environment or the module, or uninstall, the installer removes only what it
added there: the transcript reader role it gave, and the role itself if it created it, then the Bot
Transcript Viewer role it gave, and the application user if it created it. Unticking the module
keeps the model, hides its pages and turns off its scheduled refresh; ticking it again reuses the
model. Demo mode reads no transcripts and adds no access. Switching to it removes nothing, so the
managed identity keeps its access for when you switch back. See
[Agent Evaluator on Azure](../azure/README.md#agent-evaluator).

## Ask

The app's **Ask** page answers questions about the dashboard in plain language. It lists suggested
questions for each page the install shows, from `app/src/ask/catalogue.json`. How it answers depends
on the target.

**Fabric.** The installer creates a data agent, **Analytics Hub Ask**, in the workspace and publishes
it. It reads `Analytics Hub Model`, and Consumption Central and Agent Evaluator when they're on. Its
instructions come from the same catalogue: what the measures mean, how to filter by date and
organization, to compare rather than explain why, never to estimate, and to leave out groups under
5 people. A data agent built on semantic models can't take example queries, so these all go into its
instructions. On a re-run the installer updates and republishes it only when the models or the
catalogue changed, and a failure here never stops the install. The app's Ask page links to the agent
in Fabric (**Open the data agent in Fabric**) and copies questions to ask it. To use it in Teams or
Microsoft 365 Copilot, publish it there from Fabric by hand: there's no API for that yet.

It needs:

- A paid Fabric capacity, **F2 or larger**, or Premium (P1 or larger). On a trial capacity the
  installer skips the agent and the Ask page lists the questions only.
- The tenant settings **Users can create and share data agent items**, **Users can use Copilot and
  other features powered by Azure OpenAI** and, if your capacity isn't in the US or EU, **Data sent
  to Azure OpenAI can be processed outside your capacity's geographic region**. The installer
  checks them when it can read tenant settings and warns about any that look off.
- For the people who ask it: access to the agent (share it, or a workspace role) and **Build** or
  **Read** on the models it reads. The viewer group already has Build.

To leave it out, choose **Yes** for the advanced settings and **No** when asked to create the data
agent. It's recorded as `dataAgent` in `valuelens-install.json`.

**Azure.** The web app answers on the page itself through `POST /api/ask`, with an Azure OpenAI model.
The model can only run the named queries the pages run, as the person asking, so it sees only what
they can see. Under [Advanced settings](#advanced-settings) the wizard asks which model to use:

- **Create one for Ask** (the default): an Azure AI Services account in the resource group with a
  `gpt-5-mini` deployment, billed per token. Choose whether prompts may be processed in any region
  (Global Standard) or only in your data zone (Data Zone Standard). The installer checks the region
  offers the model and has quota, and moves a global deployment to another region if it doesn't,
  but only to a region that Azure Policy allows.
  The web app's managed identity gets **Cognitive Services OpenAI User** on it.
- **Use an Azure OpenAI deployment you already have**: pick the account and a chat deployment that
  supports tool calling. The installer gives the managed identity Cognitive Services OpenAI User on
  that account if you can assign roles there, or prints the `az role assignment create` command.
- **Leave Ask off**: the page lists suggested questions without answers. An account the installer
  created earlier stays until you delete it.

It's recorded as `azure.ask`. See [Ask](../azure/README.md#ask) for the limits and what's logged.

## Private Key Vaults

If your vault blocks public access, the installer connects the workspace to it with a managed
private endpoint. You need to be a workspace Admin, on an F or trial capacity. If you can't approve
the endpoint, someone who manages the vault approves it under **Networking** >
**Private endpoint connections**. Then choose **Repair or change**.

## Troubleshooting

Moved to [Troubleshooting](../docs/TROUBLESHOOTING.md#troubleshooting).

## Check the download

Moved to [Check the download](../docs/INSTALL.md#check-the-download).

## From PowerShell

Moved to [From PowerShell](../docs/INSTALL.md#from-powershell).

## Locked-down tenant / Azure Cloud Shell

Moved to [Locked-down tenant / Azure Cloud Shell](../docs/INSTALL.md#locked-down-tenant--azure-cloud-shell).

## Without the exe

Moved to [Without the exe](../docs/INSTALL.md#without-the-exe).
