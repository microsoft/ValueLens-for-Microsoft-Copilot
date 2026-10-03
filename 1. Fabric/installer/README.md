# ValueLens Fabric installer

One command that sets up the [Fabric path](../README.md) in your tenant. It asks a few questions,
shows you the plan, and then creates everything the manual steps would: the app registration, its
secret in Azure Key Vault, admin consent, a workspace and Lakehouse, the notebooks, the pipeline
and its schedule. It can also deploy the ValueLens semantic model and the
[ValueLens app](../Fabric%20App/) on top of it, so there is nothing to publish from
Power BI Desktop. With [credit consumption](#credit-consumption), it adds the Consumption Central
notebooks and model too. It then runs the first load and checks the data that arrives.

It keeps its answers and the IDs it creates in `valuelens-install.json`. Run it again with that
file to repair, change or update the set-up. The file holds no secrets.

```text
cd "1. Fabric/installer"
npm install
npx valuelens-install
```

**Jump to:** [Before you start](#before-you-start) · [What it creates](#what-it-creates) ·
[Credit consumption](#credit-consumption) · [Commands](#commands) · [Good to know](#good-to-know) ·
[Troubleshooting](#troubleshooting)

---

## Before you start

| You need | Why |
|---|---|
| **Node.js 20.12 or later** and a clone of this repo | The installer deploys the notebooks and pipeline from this checkout. The ValueLens app needs **Node.js 22.13 or later** to build. |
| An **active Fabric capacity** (F2 or larger, or a trial) you can assign workspaces to | It creates the workspace on it. Or pick an existing workspace where you're an Admin or Member. |
| An **Azure subscription** where you can create a Key Vault (Contributor), or an existing vault you can write secrets to | The client secret lives in Key Vault, never in a notebook. Owner or User Access Administrator lets it use Azure RBAC; otherwise the vault uses access policies. |
| Permission to **register apps** in Entra | The default user setting is enough, or Application Administrator. You can also use an app you already have. |
| A **Global Administrator** or **Privileged Role Administrator** | Only to grant admin consent for the Graph permissions. If that isn't you, the installer gives you a link to send them. |
| For the semantic model and app, these **Fabric tenant settings** | *Service principals can call Fabric public APIs*, because the model reads the Lakehouse as the app registration. For the app, also *Semantic Model Execute Queries REST API* and *Fabric App items*. If you're a Fabric administrator, the installer checks them and warns you. |
| For Azure AI costs, **Owner** or **User Access Administrator** on the subscription | Only if you add credit consumption. The installer gives the app registration three read-only roles there. See [Credit consumption](#credit-consumption). |

The permissions it requests are the ones in [`/docs/PERMISSIONS.md`](../../docs/PERMISSIONS.md):
`AuditLogsQuery.Read.All`, `Reports.Read.All` and `User.Read.All`, plus `CopilotPackages.Read.All`
and `Application.Read.All` if you add the Agent 365 registry.

## Run it

```text
npx valuelens-install                 # sign in with a browser
npx valuelens-install --device-code   # sign in with a code on another device
npx valuelens-install --use-az        # use your Azure CLI sign-in (az login)
npx valuelens-install --tenant contoso.onmicrosoft.com
```

It checks your tenant first (roles, capacities, subscriptions), then asks:

1. **What to collect.** Copilot usage and licences are always on. Org data from Entra is on by
   default. The Agent 365 registry, product feedback and credit consumption are off.
2. **Power BI**: the semantic model and the ValueLens app (the default), the model only, or
   neither. The model needs org data, so choosing it switches org data on.
   - With credit consumption, **which subscription's Azure AI costs** to read, or leave Azure AI
     out. It defaults to the first subscription with Azure OpenAI or AI Foundry resources.
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
| ValueLens app | A Fabric App item, "AI in One 2.0", built from [`1. Fabric/Fabric App`](../Fabric%20App/) against your semantic model. Rayfin, the app's build tool, may open a browser for you to sign in. |
| Credit consumption | Only if you choose it. Three more notebooks, the `ValueLens Consumption Model`, two upload folders, and read access to Azure costs. See [Credit consumption](#credit-consumption). |
| First load | A pipeline run with your chosen history, then the data check. The run reports row counts and the date range of the audit data. Without a first load, the model is refreshed straight away. |

The data check copy is the only notebook the installer adds to. It writes a short summary to
`Files/valuelens_installer/data_check.json` in the Lakehouse, so the installer can read the
result back.

## Credit consumption

An optional module. It sets up [Consumption Central](../Add%20Credit%20Consumption/) in the same
Lakehouse, so the app's Consumption pages show what Copilot costs alongside what it's worth.

| Item | Details |
|---|---|
| Notebooks | `Consumption_Ingest_Azure_AI`, `Consumption_Ingest_Studio` and `Consumption_Ingest_Viva`, from [`Add Credit Consumption/notebooks`](../Add%20Credit%20Consumption/notebooks/). The pipeline runs them alongside the ValueLens notebooks. |
| Azure access | Reader, Cost Management Reader and Monitoring Reader for the app registration on the subscription you chose. The Azure AI notebook reads 90 days of cost and token metrics for that one subscription, signing in with the same Key Vault secret. If you can't assign roles, Azure AI stays out of the pipeline until someone does and you run `install` again. |
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

## Commands

| Command | What it does |
|---|---|
| `install` (default) | Sets everything up, or repairs it from the install record. Re-running only does what is missing. It asks before rebuilding an app that is already deployed. |
| `update` | Pushes the notebooks, pipeline and semantic models from this checkout over the deployed ones, then refreshes the models. It asks whether to redeploy the app too. Use it after you pull a new version of the repo. |
| `run` | Runs the pipeline now, then the data check. `--backfill-days <n>` reloads that much audit history and rebuilds the curated table. |
| `refresh` | Refreshes the semantic models now and waits for them. |
| `deploy-app` | Builds and deploys the ValueLens app again, for example after a failed deploy or once you have a newer Node.js. |
| `status` | Shows recent pipeline runs and model refreshes, the last data check, and when the secrets expire. |
| `rotate-secret` | Creates a new client secret and replaces the one in Key Vault. It also gives the model's connection a new secret and removes its old one. |
| `preview` | Writes the notebooks, pipeline, schedule and `model.bim` it would deploy to `./valuelens-preview`, without signing in. With credit consumption, also `consumption-model.bim`. |

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
`npx valuelens-install run --backfill-days 90`.

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
| `Run_Consumption_Azure_AI` fails with `AuthorizationFailed` | New Azure roles can take a few minutes to apply. The activity retries twice; if it still fails, run `run` later. |
| `The install record is for tenant …` | Pass `--tenant` with the tenant in the record, or use another `--config`. |

Run with `--verbose` to see each call and the full error.

## Development

```text
npm test                       # unit tests with fakes, no sign-in
npm run typecheck              # TypeScript checks over the JSDoc types
npx valuelens-install preview  # writes ./valuelens-preview (ignored by git)
```
