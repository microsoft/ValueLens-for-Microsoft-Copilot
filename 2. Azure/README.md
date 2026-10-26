# 2. Azure

Analytics Hub in **your own Azure subscription**, without Microsoft Fabric. It has the same data,
the same ValueLens Model and measures, and the same app pages as `1. Fabric`.

> **Work in progress.** Only the [installer](../1.%20Fabric/installer/) sets this path up, and
> it's also a work in progress. Try it in a demo or test tenant first. There's no manual path.
> The design and roadmap are in [`docs/plans/AZURE-HOSTED-PLAN.md`](../docs/plans/AZURE-HOSTED-PLAN.md).

## What you get

- Azure SQL, scheduled Container Apps jobs, Power BI models, a web app and a Teams package.
- Copilot interactions, licences, org data, Microsoft 365 activity and credit consumption.
- Optionally, Defender shadow AI and agent risk. Other modules are coming.

## Before you start

- [ ] **An Azure subscription.** Contributor plus User Access Administrator, or Owner, on the
      subscription or resource group.
- [ ] **Power BI Pro** and a Power BI workspace.
- [ ] **Admin consent.** A Global Administrator or Privileged Role Administrator approves the
      read-only Microsoft Graph permissions.
- [ ] **Windows 10 or 11** for the installer, or Node.js on another system.
- [ ] **Read the [disclaimer](../README.md#disclaimer).** You're responsible for the data once it's in your Azure SQL database.

Every prerequisite, with links to Microsoft Learn, is in [Before you start](../docs/PREREQUISITES.md).
Networking, regions and the commands are in the installer's
[Azure target section](../1.%20Fabric/installer/README.md#azure-target).

## Install it

1. [Download the installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe)
   (0.3.0 or later) and open it, or run `npx valuelens-install --ui` from `1. Fabric/installer` after
   `npm install` (see [Without the exe](../1.%20Fabric/installer/README.md#without-the-exe)). If Edge or
   Windows warns about the download, see
   [Check the download](../1.%20Fabric/installer/README.md#check-the-download).
2. Pick **Your Azure subscription** and tick the data to collect. **Change the advanced settings?**
   **No** takes the defaults that suit most organisations: see
   [Advanced settings](../1.%20Fabric/installer/README.md#advanced-settings). With **Yes** you can also
   choose which data the dashboard shows:
   - **Your tenant's data** (the default) collects from the audit log and Microsoft Graph.
   - **Demo mode (sample data)** publishes a synthetic sample instead, with its dates moved forward to end
     last week. It's handy for a demo or to try Analytics Hub before the Graph permissions are granted. Run
     the installer again, choose **Repair or change**, then **Yes** for the advanced settings, and pick
     your tenant's data to switch; the next run replaces the sample.
3. Choose the subscription, resource group, region and Power BI workspace.
4. Review the plan and approve it. The installer prints the web app's URL and writes `AnalyticsHub-Teams.zip`.

## Share it

Who can open the web app and the Teams tab is one Entra group, **Analytics Hub Viewers**, which the
installer creates with you as owner (or a group you name). It also gives the group **Build** on the
models. To share, add people to the group:

- **In the app:** choose **Share**. Group owners and `AnalyticsHub.Admin` can add people or groups
  and remove them; everyone else sees who to ask. **Copy app link** copies the URL.
- **In the installer:** **Manage access** (`access`).
- **In [My Groups](https://myaccount.microsoft.com/groups)**, as an owner.

The `AnalyticsHub.User` app role still works too. People without access get a page that names the
group and links to your contact or request link. For Teams, publish the package to your org's app
catalog: see [teams](teams/README.md#give-it-to-everyone). Permissions are in
[Viewing Analytics Hub](../docs/PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2).

## After setup

- **Check it worked.** Open the web app URL the installer printed. You should see your organisation's data.
- **Keep it fresh.** The Container Apps job runs on its schedule.
- **Status, updates or repairs:** open the installer again and choose **Repair or change**.
- **Problems?** See the installer's [Troubleshooting](../1.%20Fabric/installer/README.md#troubleshooting),
  or [open an issue](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues).

---

<a id="credit-consumption"></a>

<details>
<summary><strong>Credit consumption</strong></summary>

<br>

Tick **Credit consumption** to get the Consumption Central pages, from a second Power BI model
(*Consumption Central*) that reads the same Azure SQL database.

- **Copilot Studio credits** come from the Power Platform licensing API by default, as on Fabric. The
  installer creates a daily Power Automate flow, signed in as you through **HTTP with Microsoft Entra ID**.
  Its first run loads about six months, then it reads the last ten days. Per-user credits are best effort.
  You can choose the PPAC CSV exports instead.
- **Cowork credits**: drop the Consumption Dashboard's Viva Insights export in the `viva` folder.
- **Azure AI and pay-as-you-go**: the jobs read Cost Management and Azure Monitor with their managed
  identity. The installer gives it the roles on the subscriptions you pick, if you can assign them.

Where the files land depends on networking:

| Networking | Credit files go to | Who needs what |
|---|---|---|
| Public endpoints | The storage account's `landing` container: `studio/`, `viva/` (the flow keeps its own state in `flows/`) | Whoever signs the flow's storage connection in needs **Storage Blob Data Contributor** on the account. The installer gives it to you |
| Private networking | A SharePoint folder you choose, with `studio/` and `viva/` under it. Power Automate can't reach private storage | The jobs' managed identity needs **Sites.Selected** with read on that site. The installer grants it if you're a SharePoint or Global administrator; otherwise it prints the `Grant-PnPAzureADAppSitePermission` command for one |

The jobs read the files where they land and don't move them, the same as the Fabric notebooks.

**Copilot Studio exports and their month.** A tenant export has its own dates. The per-agent and
per-user exports carry none, so each counts as the month, in UTC, that it was uploaded to `studio/`:
the blob's last-modified time in Storage, or the item's last-modified time in SharePoint. A file left
in the folder keeps its month. Where two exports of a kind share a key, the newer upload's rows win. A
CSV whose name matches an export but lacks that export's key columns is skipped, with a warning.

**Loading an earlier month's export.** Upload it to `studio/backfill/<YYYY-MM>/` for the month it
covers. It counts as that month on every run. The Studio load stops before writing, and lists the
paths, if `backfill/` holds a file outside a month folder, a folder not named `YYYY-MM`, or a month
after the current one (UTC). The other loads still run, but the run fails; its log message starts
`Nothing was written.` Move or remove what it lists, then run again.

**Updating from an earlier version.** Earlier versions stored a per-agent or per-user export left in
`studio/` again as each later month's, and added together rows two exports shared. Updating leaves
those copies, so each month holding one stays covered by an export, and with the flow its figures
aren't used for that month (this month too, if an earlier version already ran in it). A month's own
export replaces the copied rows it matches on the table's key; a copied agent or user it doesn't list
stays. There's no cleanup step.

Not on Azure yet: GitHub Copilot consumption, the dated Agent Daily table, Viva without a CSV, and
`--flow-identity app` (the flow always signs in as you; the option warns and is ignored).

</details>

<a id="ask"></a>

<details>
<summary><strong>Ask: questions in plain language</strong></summary>

<br>

The app's **Ask** page answers questions about the dashboard in plain language, inline. The web app's
`POST /api/ask` sends the question to an Azure OpenAI model, which can only call the named queries in
`1. Fabric/Fabric App/src/ask/catalogue.json`, the same DAX the pages run, with a date range and organizations. It
never writes its own DAX. Each query runs through `/api/query` as the signed-in person, so Ask sees
only what they can. The answer shows which queries it ran and links to the page each came from.

- **The model.** By default the installer creates an Azure AI Services account (`ai-<prefix>-<suffix>`)
  with a `gpt-5-mini` deployment and gives the web app's managed identity **Cognitive Services OpenAI
  User** on it. Or it uses a deployment you already have, or leaves Ask off. See
  [Ask](../1.%20Fabric/installer/README.md#ask) in the installer's README. The web app reads
  `VALUELENS_ASK_ENDPOINT` and `VALUELENS_ASK_DEPLOYMENT`; without both, `/app.config.json` has no
  `ask` block and the page lists suggested questions only.
- **Limits.** Groups under 5 people are left out before the model sees a row, and at most 50 rows of
  each query reach it. A question runs at most 8 queries and keeps the last 8 turns of the
  conversation. Each person gets 20 questions every 10 minutes and 2 at once.
- **Logs.** The question and the names of the queries it ran, never the answer or the data.
- **Cost.** Billed per token on the AI Services account. Light use costs a few dollars a month.

</details>

<a id="whats-here"></a>

<details>
<summary><strong>What's in this folder</strong></summary>

<br>

| Folder | Contents |
|---|---|
| `infra/` | Bicep: a user-assigned managed identity, ADLS Gen2 (shared keys off), Log Analytics, Azure SQL serverless (Entra-only), a Container Apps environment, a scheduled run job, a manual migrate job, the web app, optional private networking and an optional Azure AI Services account for Ask. Every resource is tagged `valuelens-install-id`. The installer ships it compiled as `src/azure/main.arm.json` |
| `jobs/` | The `valuelens-jobs` image: `python -m valuelens_jobs run --steps collect,process,publish,refresh` |
| `sql/migrations/` | Versioned `V###__*.sql` scripts and a `schema_version` table, applied by the migrate job |
| `web/` | The `valuelens-web` image: the Node service that serves the app's `dist` plus `/api/query`, `/api/ask`, `/api/settings`, `/api/version` and `/api/health` |
| `teams/` | The Teams tab manifest template (SSO) |

The processing logic lives in [`shared/python/valuelens_core`](../shared/python/valuelens_core). It's a DuckDB
port of `Copilot_Audit_Log_Processor`, held to the Fabric notebook row for row by
`tests/test_valuelens_core_parity.py`. **The notebook is still the source of truth**: change both together,
then run `python tests/valuelens_golden.py --regenerate` (this needs pyspark and Java) and `--check`.

What you need, networking, regions and the commands are in the installer's
[Azure target section](../1.%20Fabric/installer/README.md#azure-target). The images come from
`ghcr.io/microsoft/valuelens-jobs` and `valuelens-web`, tagged with the installer's version. For every
prerequisite on one page, with links to Microsoft Learn, see [Prerequisites](../docs/PREREQUISITES.md).

</details>

<a id="try-the-processor-locally"></a>

<details>
<summary><strong>Try the processor locally</strong></summary>

<br>

```powershell
pip install duckdb
$env:PYTHONPATH = "shared\python;2. Azure\jobs"
# raw\copilot_interactions_parsed\*.parquet (and optionally copilot_licensed_users, agents_365)
python -m valuelens_jobs process --data-dir .\data
# -> data\curated\copilot_interactions_curated\part-0.parquet
```

Or run it on single files: `python -m valuelens_core --interactions in.csv --out curated.parquet`.

</details>

<a id="validate-the-templates"></a>

<details>
<summary><strong>Validate the templates</strong></summary>

<br>

```powershell
az bicep build --file "2. Azure/infra/main.bicep" --stdout > $null
az deployment group what-if -g <rg> --template-file "2. Azure/infra/main.bicep" --parameters "2. Azure/infra/main.bicepparam"
```

The installer runs the same what-if for its plan screen, then deploys in incremental mode. It passes the
live SQL capacity values back in, so scale changes you make survive updates.

</details>

<a id="after-deployment-installer-steps-not-arm"></a>

<details>
<summary><strong>What the installer does after the ARM deployment</strong></summary>

<br>

ARM can't do these, so the installer:
- Grant the managed identity its Graph app roles (`AuditLogsQuery.Read.All`, `Reports.Read.All`,
  `User.Read.All` and module extras).
- Run the migrate job, which creates the database users.
- Create the web app registration with a federated credential, and the Power BI workspace, models and refresh.
- Create or find the viewer group, give it Build on the models, and pass it to the web app as `VALUELENS_ACCESS`.
- With credit consumption: the managed identity's Cost Management and Azure AI roles, write access to
  where the credit files land, the Consumption Central model, and the Copilot Studio Power Automate flow.

</details>
