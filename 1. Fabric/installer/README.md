# Analytics Hub installer

One command that sets up the [Fabric path](../README.md) in your tenant. It asks a few questions,
shows you the plan, and then creates everything the manual steps would: the app registration, its
secret in Azure Key Vault, admin consent, a workspace and Lakehouse, the notebooks, the pipeline
and its schedule. It can also deploy the ValueLens semantic model and the
[Analytics Hub app](../Fabric%20App/) on top of it, so there is nothing to publish from
Power BI Desktop. With [Microsoft 365 activity](#microsoft-365-activity), on by default, it reads
how people work across Teams, Outlook, SharePoint and the Office apps for the app's Work patterns
page. With [credit consumption](#credit-consumption), it adds the Consumption Central
notebooks and model too. With the [Agent Evaluator](#agent-evaluator), it reads your Copilot Studio
agent conversations as well. It then runs the first load and checks the data that arrives.

It keeps its answers and the IDs it creates in `valuelens-install.json`. Run it again with that
file to repair, change or update the set-up. The file holds no secrets.

The easiest way to run it is to [download `AnalyticsHubInstaller.exe`](#download-and-run) and
double-click it. It opens in your browser, and you don't need Node.js, a terminal or a copy of this
repo. From a clone of this repo:

```text
cd "1. Fabric/installer"
npm install
npx valuelens-install
```

**Jump to:** [Before you start](#before-you-start) · [Download and run](#download-and-run) ·
[In your browser](#in-your-browser) · [What it creates](#what-it-creates) ·
[Microsoft 365 activity](#microsoft-365-activity) · [Credit consumption](#credit-consumption) ·
[Agent Evaluator](#agent-evaluator) · [Commands](#commands) · [Good to know](#good-to-know) ·
[Troubleshooting](#troubleshooting)

---

## Before you start

| You need | Why |
|---|---|
| **Windows 10 or 11** (64-bit) for `AnalyticsHubInstaller.exe`, or **Node.js 20.12 or later** and a clone of this repo | The exe carries everything it needs, including a ready-built app. From a clone, the installer deploys the notebooks and pipeline from your checkout, and the Analytics Hub app needs **Node.js 22.13 or later** to build. |
| An **active Fabric capacity** (F2 or larger, or a trial) you can assign workspaces to | It creates the workspace on it. Or pick an existing workspace where you're an Admin or Member. |
| An **Azure subscription** where you can create a Key Vault (Contributor), or an existing vault you can write secrets to | The client secret lives in Key Vault, never in a notebook. Owner or User Access Administrator lets it use Azure RBAC; otherwise the vault uses access policies. |
| Permission to **register apps** in Entra | The default user setting is enough, or Application Administrator. You can also use an app you already have. |
| A **Global Administrator** or **Privileged Role Administrator** | Only to grant admin consent for the Graph permissions. If that isn't you, the installer gives you a link to send them. |
| For the semantic model and app, these **Fabric tenant settings** | *Service principals can call Fabric public APIs*, because the model reads the Lakehouse as the app registration. For the app, also *Semantic Model Execute Queries REST API* and *Fabric App items*. If you're a Fabric administrator, the installer checks them and warns you. |
| For Azure AI costs, **Owner** or **User Access Administrator** on the subscription | Only if you add credit consumption. The installer gives the app registration three read-only roles there, and Cost Management Reader on any other subscription billed for Copilot pay-as-you-go. A **Power Platform administrator** lets it find those subscriptions. See [Credit consumption](#credit-consumption). |
| For agent transcripts, **System Administrator** in each Power Platform environment | Only if you add the Agent Evaluator. The installer adds the app registration to each environment you pick. If you aren't an admin there, it prints the steps for one. See [Agent Evaluator](#agent-evaluator). |

The permissions it requests are the ones in [`/docs/PERMISSIONS.md`](../../docs/PERMISSIONS.md):
`AuditLogsQuery.Read.All`, `Reports.Read.All` and `User.Read.All`, plus `CopilotPackages.Read.All`
and `Application.Read.All` if you add the Agent 365 registry.

## Download and run

1. Download `AnalyticsHubInstaller.exe` from the latest `installer-v…` release on the
   [releases page](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases). To check
   the download, compare `Get-FileHash AnalyticsHubInstaller.exe` with the release's
   `AnalyticsHubInstaller.exe.sha256`.
2. Double-click it. If Windows says it protected your PC, choose **More info**, then **Run anyway**.
   The exe isn't code-signed yet.
3. The first time, it takes about a minute to unpack to `%LOCALAPPDATA%\AnalyticsHub`. Then it
   opens the installer [in your browser](#in-your-browser). Keep its window open while you use the
   page.

The exe carries Node.js, the installer, the notebooks, the pipeline, the semantic models and a
ready-built Analytics Hub app, so it deploys the version it was released with. A newer exe unpacks
its own copy and removes the old one.

It keeps the install record in `Documents\Analytics Hub`. Keep that folder. To check on Analytics
Hub, run the pipeline, update or repair the set-up later, open the exe again.

The [commands](#commands) work from the exe too. In a terminal, run for example
`AnalyticsHubInstaller.exe status` or `AnalyticsHubInstaller.exe run --backfill-days 90`. Relative
`--config` and `--out` paths are in `Documents\Analytics Hub`.

## Run it

```text
npx valuelens-install                 # sign in with a browser
npx valuelens-install --device-code   # sign in with a code on another device
npx valuelens-install --use-az        # use your Azure CLI sign-in (az login)
npx valuelens-install --tenant contoso.onmicrosoft.com
npx valuelens-install --ui            # do it all in your browser instead
```

It checks your tenant first (roles, capacities, subscriptions), then asks:

1. **What to collect.** Copilot usage and licences are always on. Org data from Entra and
   Microsoft 365 activity are on by default. The Agent 365 registry, product feedback, credit
   consumption and the Agent Evaluator are off.
2. **Power BI**: the semantic model and the Analytics Hub app (the default), the model only, or
   neither. The model needs org data, so choosing it switches org data on.
   - With credit consumption, **which subscription's Azure AI costs** to read, or leave Azure AI
     out. It defaults to the first subscription with Azure OpenAI or AI Foundry resources, and
     shows which subscriptions Power Platform billing policies charge Copilot pay-as-you-go to.
   - With the Agent Evaluator, **which Power Platform environments** to read transcripts from.
     It lists the environments you're a member of. If it can't, paste their URLs.
3. **How much audit history** the first load pulls: 30, 90 or 180 days.
4. **Capacity, workspace and Lakehouse name.**
5. **App registration**: create "ValueLens Data Collector", or use one you have. If you use your
   own, you paste its secret once and it goes straight to Key Vault.
6. **Key Vault**: create one (resource group, region, name) or pick one you have.
7. **Schedule**: daily or weekly, and the time (UTC).
8. **Whether to run the first load** straight away.

Then it shows the plan and asks to go ahead. Nothing is created before you say yes. Your
answers are saved either way.

When it finishes, it prints links to the semantic model and the app, and how to share them. If
you chose neither, it prints the values for the Power BI templates instead: the SQL endpoint and
Lakehouse name for `ValueLens - Fabric.pbit`, or the workspace and Lakehouse IDs for
`ValueLens - Fabric OneLake.pbit`. Carry on from step 5 of the [Fabric quick start](../README.md#quick-start).

### In your browser

```text
npx valuelens-install --ui            # opens the installer in your browser
npx valuelens-install --ui --no-open  # prints the link instead
```

`--ui` runs the same installer as a page in your browser. It opens on a home page. With no install
record, you set up Analytics Hub from there. With one, the page shows what's installed and lets
you run the pipeline, refresh the models, check status, check the data, update, redeploy the app,
create new secrets, or repair or change the set-up. `--tenant`, `--device-code`, `--use-az`, `--config` and
`--source` work as they do in the terminal. It doesn't take a command, `--yes` or `preview`.

The questions, the plan and each step's progress appear on the page. Nothing is created before
you approve the plan, and you can save the plan, or a record of a finished run, as Markdown.
Secrets you paste go to the installer and Key Vault, and are never shown again or saved in the
record.

The page is served on `127.0.0.1` only, and it opens only from the link the installer prints,
which holds a key made for that run. Keep the terminal open while you use it: it mirrors the
page, and the page stops working when it closes. Press **Ctrl+C** there, or **Close installer** on
the page when nothing is running, to stop.

## What it creates

| Item | Details |
|---|---|
| Key Vault | Secret `valuelens-client-secret` (you can rename it), with its expiry date set. You get Key Vault Secrets Officer on a new RBAC vault. |
| App registration | "ValueLens Data Collector", single tenant, with the Graph application permissions above and a 12-month client secret. |
| Admin consent | Granted for you if you have the role; otherwise a link for an admin. |
| Workspace | On the capacity you chose. An existing workspace with no capacity is assigned to it. |
| Managed private endpoint | Only if the vault blocks public access. It connects the workspace to the vault, and the installer approves it on the vault. See [Private Key Vaults](#private-key-vaults). |
| Lakehouse | `ValueLens` by default, with schemas turned on, so tables land in `dbo`. |
| Notebooks | The core ingesters, the processor, `ValueLens_Data_Check` and any optional modules. Each one is bound to the Lakehouse. Notebooks that call Graph read the secret from Key Vault when they run. With the semantic model, also `ValueLens_Refresh_Model`. |
| Pipeline | `ValueLens_Pipeline`, built from [`pipelines/`](../pipelines/) with your notebook IDs filled in. Archived and switched-off branches are removed. With the semantic model, its last step, `Refresh_Semantic_Model`, refreshes the model once the data has loaded. |
| Schedule | Daily or weekly at the time you chose, starting tomorrow. |
| Semantic model | `ValueLens Model`, built from `ValueLens - Fabric.pbit` and pointed at your Lakehouse. Optional pages follow the modules you chose. |
| Connection | `ValueLens SQL <workspace>`, a cloud connection to the Lakehouse's SQL endpoint that signs in as the app registration, with a secret of its own. The app registration gets Viewer on the workspace so it can read the Lakehouse. |
| Analytics Hub app | A Fabric App item, "Analytics Hub", built from [`1. Fabric/Fabric App`](../Fabric%20App/) against your semantic model. Rayfin, the app's build tool, may open a browser for you to sign in. |
| Microsoft 365 activity | On by default. One more notebook and an `M365 Activity` table in the semantic model. See [Microsoft 365 activity](#microsoft-365-activity). |
| Credit consumption | Only if you choose it. Three more notebooks, the `ValueLens Consumption Model`, two upload folders, and read access to Azure costs. See [Credit consumption](#credit-consumption). |
| Agent Evaluator | Only if you choose it. The app registration as a transcript reader in each environment you pick, one more notebook and the `ValueLens Agent Evaluator Model`. See [Agent Evaluator](#agent-evaluator). |
| First load | A pipeline run with your chosen history, then the data check. The run reports row counts and the date range of the audit data and the Microsoft 365 activity. Without a first load, the model is refreshed straight away. |

The data check copy is the only notebook the installer adds to. It writes a short summary to
`Files/valuelens_installer/data_check.json` in the Lakehouse, so the installer can read the
result back. It isn't part of the pipeline, so the scheduled runs don't update it: it runs after
the first load, after `run`, and when you run `check`. `status` warns when the pipeline has run
since the last check.

## Microsoft 365 activity

On by default. It reads the Microsoft 365 usage reports, so the app's **Work patterns** page shows
how people work: meetings, email, chat and files, which workloads and apps they use and on which
devices, and how Copilot users' weeks compare with everyone else's. It also lets Readiness's *Who to license next*
weigh how many workloads each person uses a day. It needs `Reports.Read.All`, which the core
already has, so there's nothing more to consent to.

| Item | Details |
|---|---|
| Notebook | `Copilot_M365_Activity_Ingester`, from [`notebooks/`](../notebooks/README.md#optional--microsoft-365-activity). It reads six reports a day (Teams, Outlook, SharePoint, OneDrive, Viva Engage and the Microsoft 365 apps) and writes one row per person per active day to `m365_activity_daily`. |
| Pipeline | `Conditionally_Run_M365_Activity` runs it alongside the ValueLens notebooks. |
| Semantic model | An `M365 Activity` table in `ValueLens Model`, joined to the calendar, org data and licences, so the date and organisation filters reach it. It's added at deploy time; the `.pbit` and the Power BI report don't change. |
| App page | **Work patterns**, between Leaderboards and Agent Evaluation. |

Microsoft keeps 28 days of these reports and publishes each day two to three days late. The first
load reads all 28 days, and history builds up from there.

**Turn off concealed names.** If **Display concealed user, group, and site names in all reports**
is on, the reports hold random IDs instead of names. The totals still work, but the organisation
filter, the Copilot comparison and the licence score can't. Turn it off in the Microsoft 365 admin
center under **Settings** > **Org settings** > **Reports**. The next run reloads the concealed
days. The data check and the Work patterns page both warn you while it's on.

**Existing installs.** `update` adds the module, because it's on by default. The page fills in
after the next pipeline run: run `run`, or wait for the schedule. To leave it out, run `install`
and clear it under *What to collect*.

## Credit consumption

An optional module. It sets up [Consumption Central](../Add%20Credit%20Consumption/) in the same
Lakehouse, so the app's Consumption pages show what Copilot costs alongside what it's worth.

| Item | Details |
|---|---|
| Notebooks | `Consumption_Ingest_Azure_AI`, `Consumption_Ingest_Studio` and `Consumption_Ingest_Viva`, from [`Add Credit Consumption/notebooks`](../Add%20Credit%20Consumption/notebooks/). The pipeline runs them alongside the ValueLens notebooks. |
| Azure access | Reader, Cost Management Reader and Monitoring Reader for the app registration on the subscription you chose. The Azure AI notebook reads 90 days of cost and token metrics for that one subscription, signing in with the same Key Vault secret. If you can't assign roles, Azure AI stays out of the pipeline until someone does and you run `install` again. |
| Copilot pay-as-you-go | The installer reads your Power Platform billing policies to find the subscriptions they charge, and gives the app registration Cost Management Reader on each one besides the Azure AI subscription. The Azure AI notebook then writes what Azure billed for Copilot Studio and Cowork to `copilot_payg_spend`, and the model gets a `CopilotPaygSpend` table. A subscription you can't grant is left out; without a Power Platform administrator, only the Azure AI subscription is read. |
| Upload folders | `Files/landing/studio` and `Files/landing/viva` in the Lakehouse. |
| Semantic model | `ValueLens Consumption Model`, built from `Consumption Central - Fabric.pbit`. It uses the ValueLens model's connection, so it's only deployed with the semantic model. The pipeline refreshes it after the consumption notebooks. |
| App pages | The app gets the model as its `cc` data source, which turns on its Consumption pages. A deployed app is rebuilt to add them. |

Two sources have no API, so you land them yourself. The installer prints these steps at the end:

- **Copilot Studio credits.** In the Power Platform admin center, go to **Licensing** >
  **Products** > **Copilot Studio**. Download the `EntitlementConsumption…_MCSMessages…csv` files
  from the Summary, Environments and Agents tabs. Upload them to `Files/landing/studio` and replace
  them each month: every run counts the files there as the current month.
- **Cowork credits.** Build a Viva Insights query with the Copilot credit metrics and turn on
  auto-refresh. Then create a Dataflow Gen2 in the workspace that loads it into the table
  `viva_credits_weekly`. Follow the [Viva Insights guide](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric),
  with Schema type *Pivoted* and Data granularity *Row-level data*. Or upload the Consumption
  Dashboard's CSV export to `Files/landing/viva` instead.

The notebooks skip a source with nothing in its folder, so the pipeline still succeeds before you
upload anything. GitHub Copilot and commercial terms aren't set up by the installer; see the
[Consumption Central README](../Add%20Credit%20Consumption/) for those.

## Agent Evaluator

An optional module. It sets up the [Agent Evaluator](../Add%20Agent%20Evaluator/) in the same
Lakehouse, so the app's Agent Evaluation pages show how your Copilot Studio agents perform:
sessions, outcomes, topics, knowledge, errors and feedback. Copilot Studio keeps conversation
transcripts in Dataverse for about 30 days; each run adds to the Lakehouse, so history builds up
past that.

| Item | Details |
|---|---|
| Environments | You pick them from the Power Platform environments you're a member of. Only the ones you pick are read. |
| Access | In each environment, the app registration becomes an application user with the **Bot Transcript Viewer** role, in the root business unit. This needs System Administrator there. |
| Notebook | `AgentEval_Transcript_Parser`, from [`Add Agent Evaluator/notebooks`](../Add%20Agent%20Evaluator/notebooks/), with your environments filled in. It signs in with the same Key Vault secret, merges each run into the `agent_*` tables, and looks up each user's UPN in Entra so sessions join to org data. It's only deployed once the app can read at least one environment. |
| Pipeline | `Run_Agent_Evaluator_Transcripts` runs alongside the ValueLens notebooks and re-reads the last 14 days of transcripts. The first load and `run --backfill-days <n>` read the history you ask for instead, up to what Dataverse still holds. |
| Semantic model | `ValueLens Agent Evaluator Model`, built from `Agent Evaluator.pbit`. It uses the ValueLens model's connection, so it's only deployed with the semantic model. The pipeline refreshes it after the transcripts and org data load. |
| App pages | The app gets the model as its `ae` data source, which turns on its Agent Evaluation pages. A deployed app is rebuilt to add them. |

If you aren't a System Administrator in an environment, the installer skips it and prints the steps
for an admin:

1. In the [Power Platform admin center](https://admin.powerplatform.microsoft.com), go to
   **Manage** > **Environments** > the environment > **Settings** > **Users + permissions** >
   **Application users** > **New app user**.
2. Pick the app registration, the root business unit and the **Bot Transcript Viewer** role.

Then run `install` again. It finds the access and deploys the notebook, or answer *It already has
access* when it asks. An environment without the Bot Transcript Viewer role doesn't have Copilot
Studio set up, so it's skipped. The template's Credit Consumption page stays empty; use
[credit consumption](#credit-consumption) for Copilot Studio credits.

## Commands

| Command | What it does |
|---|---|
| `install` (default) | Sets everything up, or repairs it from the install record. Re-running only does what is missing. It asks before rebuilding an app that is already deployed. |
| `update` | Pushes the notebooks, pipeline and semantic models from this checkout, or the ones the exe carries, over the deployed ones, then refreshes the models. A module that's new in this version and on by default, such as [Microsoft 365 activity](#microsoft-365-activity), is added too. It asks whether to redeploy the app too. Use it after you pull a new version of the repo or download a newer exe. |
| `run` | Runs the pipeline now, then the data check. `--backfill-days <n>` reloads that much audit history and rebuilds the curated table. |
| `check` | Runs the data check again, without the pipeline, and shows the row counts, date ranges and licence matches. |
| `refresh` | Refreshes the semantic models now and waits for them. |
| `deploy-app` | Deploys the Analytics Hub app again, for example after a failed deploy. From a clone, it builds the app first, so you can also use it once you have a newer Node.js. |
| `status` | Shows recent pipeline runs and model refreshes, the last data check, and when the secrets expire. It says when the data check is older than the last pipeline run. |
| `rotate-secret` | Creates a new client secret and replaces the one in Key Vault. It also gives the model's connection a new secret and removes its old one. |
| `preview` | Writes the notebooks, pipeline, schedule and `model.bim` it would deploy to `./valuelens-preview`, without signing in. With credit consumption, also `consumption-model.bim`; with the Agent Evaluator, `agent-evaluator-model.bim`. |

| Option | |
|---|---|
| `--config <file>` | Install record to use (default `./valuelens-install.json`). |
| `--source <dir>` | The `1. Fabric` folder to deploy from (default: this checkout). |
| `--yes`, `-y` | Take saved answers and defaults without asking. A question with no answer stops the run. |
| `--no-wait` | Don't wait for the first load or a model refresh to finish. |
| `--verbose` | Print each API call, and the full error body when one fails. |

## Good to know

**Who the notebooks run as.** Fabric runs pipeline notebooks as the person who last changed the
pipeline, and scheduled runs as the schedule's owner. The notebooks read the client secret from
Key Vault as that person, and `ValueLens_Refresh_Model` refreshes the model as them too. If
someone else edits the pipeline or takes over the schedule, give them "get" on the secret first
(Key Vault Secrets User) and Contributor on the workspace, or the next run fails.

**Sharing the app.** Open the app in the workspace, choose **Share**, and add people or a group.
They also need **Build** on `ValueLens Model` (its **Manage permissions** page), or Viewer on the
workspace, because the app queries the model as them. To build your own reports, connect Power BI
Desktop to `ValueLens Model` instead of publishing a template.

**`update` replaces the pipeline definition.** That includes anything you added to it yourself.
The installer asks first. If you deploy the semantic model, the installer adds the refresh step
for you; otherwise re-add the one from
[`pipelines/README.md`](../pipelines/README.md#refresh-power-bi-from-the-pipeline) afterwards, or
say no and keep your version. Changing the modules on a re-run of `install` asks the same question.

**`update` reloads the model.** Deploying a new model definition clears its data, so `update`
refreshes it straight away.

**Same-name items.** If the workspace already has a notebook, pipeline or semantic model with a
ValueLens name, the installer asks before replacing it.

**The secrets expire after 12 months.** `status` warns you 30 days before, for both the Key
Vault secret and the model connection's. Run `rotate-secret`; the notebooks' old secret keeps
working until it expires.

**Admin consent without the role.** The installer prints the app's API permissions page. An admin
opens it and selects **Grant admin consent**. You can wait and choose **Check again**, or carry on.
If you carry on, the first load is skipped. Once consent is granted, run
`npx valuelens-install run --backfill-days 90` (or `AnalyticsHubInstaller.exe run --backfill-days 90`).

**Sign-in.** Browser and device-code sign-in use the Azure CLI's public client, the default for
the Azure Identity library. Your tenant must allow it, as it does for `az login`. Nothing is
registered for the installer itself.

### Private Key Vaults

Some tenants use Azure Policy to turn off public network access on every new Key Vault. The
installer notices this and works with it:

- It saves the client secret through Azure Resource Manager instead of the vault's own endpoint.
  That needs Contributor or Key Vault Contributor on the vault. You have it on a vault the
  installer creates.
- It creates a managed private endpoint from the workspace to the vault and approves it on the
  vault. The notebooks then read the secret through it. You need to be a workspace Admin, on an
  F or trial capacity.
- If you can't approve the endpoint, the installer prints the vault's Networking page. Someone
  who manages the vault approves the request under **Private endpoint connections**. Until then,
  the first load is skipped. Run `install` again once it's approved.

A workspace with a managed private endpoint has no starter pool, so each notebook run takes a
few more minutes to start.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Windows says it protected your PC when you open the exe | Choose **More info**, then **Run anyway**. The exe isn't code-signed yet. |
| `The installer couldn't start` | If it says the download is damaged, download the exe again. Otherwise delete `%LOCALAPPDATA%\AnalyticsHub` so it unpacks afresh, then open the exe again. |
| `No active Fabric capacity you can use` | Start a Fabric trial, or ask a capacity admin to make you a Contributor on a capacity. |
| `No Azure subscription you can use` | Ask for Contributor on a subscription, or on a resource group with an existing vault. |
| A run fails with `AADSTS7000215` (invalid client secret) | The secret in Key Vault doesn't match the app. Run `rotate-secret`. |
| A run fails with `Forbidden` from Graph | Admin consent is missing or still propagating. Run `install` again to check consent, then `run`. |
| A run fails reading the secret | The person the run uses can't read the secret. See "Who the notebooks run as" above. On a private vault, check the workspace's private endpoint is approved. |
| `Fabric couldn't create a managed private endpoint` | Use an F or trial capacity, and make sure you're a workspace Admin. See [Private Key Vaults](#private-key-vaults). |
| `Fabric couldn't set up the model's connection` | Check *Service principals can call Fabric public APIs* is on for the app registration. Then run `install` again. |
| `Couldn't connect ValueLens Model to …` | Open the link it prints, and under **Gateway and cloud connections** pick `ValueLens SQL …` for the SQL source. Then choose **I've connected it myself**. |
| A model refresh fails with `Login failed` | The connection's secret expired or was removed from the app. Run `rotate-secret`. |
| `The app wasn't deployed` | Read the Rayfin output above the message, fix the cause, then run `deploy-app`. |
| `You can't assign Azure roles in …` | Ask an Owner or User Access Administrator on the subscription to give the app registration Reader, Cost Management Reader and Monitoring Reader. Then run `install` again. |
| `You can't assign Azure roles in …, so its Copilot pay-as-you-go is left out` | Ask an Owner or User Access Administrator on that subscription to give the app registration Cost Management Reader. Then run `install` again. |
| `Couldn't read Power Platform billing policies` | Only the Azure AI subscription's pay-as-you-go is read. Ask a Power Platform administrator to run `install` again. |
| `Run_Consumption_Azure_AI` fails with `AuthorizationFailed` | New Azure roles can take a few minutes to apply. The activity retries twice; if it still fails, run `run` later. |
| `You can't add … to …, so its transcripts are skipped` | Ask a System Administrator of that environment to follow the steps it prints. See [Agent Evaluator](#agent-evaluator). Then run `install` again. |
| `Run_Agent_Evaluator_Transcripts` fails with 401 or 403 from Dataverse | The app's application user was removed, disabled or lost the Bot Transcript Viewer role. Check it in the Power Platform admin center, then run `run`. |
| Work patterns says the usage reports hide user names | Turn off concealed names in the Microsoft 365 admin center, then run `run`. See [Microsoft 365 activity](#microsoft-365-activity). |
| `The install record is for tenant …` | Pass `--tenant` with the tenant in the record, or use another `--config`. |

Run with `--verbose` to see each call and the full error.

## Development

```text
npm test                       # unit tests with fakes, no sign-in
npm run typecheck              # TypeScript checks over the JSDoc types
npx valuelens-install preview  # writes ./valuelens-preview (ignored by git)
npm run build:exe              # builds dist-exe/AnalyticsHubInstaller.exe (Windows, about 10 minutes)
```

### Building the exe

`npm run build:exe` builds the [Analytics Hub app](../Fabric%20App/) once, stages it with the
installer and the notebooks, pipeline and templates it deploys, and zips them with a portable
Node.js into a small C# launcher, compiled with the `csc` that comes with the .NET Framework. It
runs on Windows; run `npm ci` here and in the app first. The app reads its model IDs from
`fabric.config.json` when it loads, so the installer deploys the same build to every tenant.
`--release` fails rather than warns when something a published download needs is missing;
`--out <dir>` writes the exe somewhere else.

The [`installer-exe`](../../.github/workflows/installer-exe.yml) workflow builds, tests and
smoke-tests the exe on pull requests that touch `packaging/`. To publish one, set the version in
`package.json` and push a tag `installer-v<version>`. The workflow drafts a release with the exe
and its SHA-256; review it and publish.
