# ValueLens for Microsoft Copilot

Shows how your organisation uses Microsoft 365 Copilot and agents, and the hours and value they
deliver. Use it as an app (preview) or as a Power BI report.

**Also see [Analytics Hub for Microsoft Copilot](https://github.com/microsoft/AnalyticsHub-Dashboard):**
one installer sets up an app on Microsoft Fabric or Azure that shows Copilot and agent adoption,
value, consumption and governance in one place. It includes the ValueLens report.

![ValueLens preview](Images/ValueLens-Preview.gif)

> **This isn't the official Copilot report, and you're responsible for the data it extracts.**
> Read the [disclaimer](#disclaimer) first.

**▶ [Watch the demo](https://youtu.be/P0uHJb13ZR0)**: what the dashboard measures, page by page (2m 4s).

1. [Start here: the app](#start-here-the-app-preview)
2. [Where your data comes from](#where-your-data-comes-from)
3. [The Power BI report](#the-power-bi-report)
4. [The Fabric App (alternative)](#the-fabric-app-alternative)
5. [Archived](#archived)

<a id="app-edition-preview"></a>

## Start here: the app (preview)

The app is the ValueLens dashboard as a web app. It keeps every measure, chart and table from the
report, with the DAX ported to TypeScript, and groups them into seven tabs that are easier to
navigate. It reads the CSV files that every [data path](#where-your-data-comes-from) can produce,
and works out every number in the viewer's browser, so the data never leaves their PC. It runs on
Copilot Managed Runtime, which is in preview.

**Have a look first:** open [`app/download/ValueLens-App.html`](app/download/ValueLens-App.html),
choose **Download raw file**, and open the file in Edge or Chrome. It works offline and opens with a
labelled synthetic sample, with nothing to install. Choose **Change data** to load your own CSVs.

### Deploy the app

You deploy it once, from a copy of this repo, with Microsoft's `ms` command-line tool. Deploying
doesn't need a licence; opening the app does (step 2).

1. **An admin allows apps from the command line.** A Global Administrator or Power Platform
   Administrator opens the [Power Platform admin center](https://admin.powerplatform.microsoft.com),
   goes to **Copilot** > **Settings** > **Managed apps**, and turns on both of these settings for
   the environment you'll deploy to, or for its environment group. Both are off by default.
   - **Allow app creation with the Copilot Managed Runtime command line interface (CLI)**
   - **External artifacts in managed apps**, because the app is built on your PC and then uploaded

   Unless you choose another environment in step 5, the `ms` tool uses your personal developer
   environment. See
   [Control whether apps can be created using the CLI](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#control-whether-apps-can-be-created-using-the-cli).

2. **Check that viewers have a licence.** Everyone who opens the app needs a **Power Apps Premium**
   licence or **Copilot Credits**. The Power Apps rights included with Microsoft 365 don't count,
   and nobody needs a Microsoft 365 Copilot licence for it. To use Copilot Credits, an admin turns
   on usage-based billing in the [Microsoft 365 admin center](https://admin.microsoft.com) and adds
   the viewers to a spending policy for managed apps. Each call the app makes, such as opening it,
   uses 0.1 credits. During the preview, someone with neither gets a warning, then is blocked after
   20 operations or five minutes. See the
   [licensing FAQ](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq).

3. **Install the tools:** [Node.js](https://nodejs.org/) 24.11 or later,
   [Git](https://git-scm.com/downloads) and the `ms` tool. These steps were checked with version
   0.29.0 of the `ms` tool, so install that one:

   ```powershell
   npm install -g @microsoft/managed-apps-cli@0.29.0
   ms --version
   ```

   If PowerShell says running scripts is disabled, add `.cmd` to the tool's name (`npm.cmd`,
   `ms.cmd`) here and in the steps below.

4. **Sign in** to the tenant your viewers use. A browser opens. If you can't use a browser on this
   PC, run `ms auth login --device-code` instead.

   ```powershell
   ms auth login
   ```

5. **Get the code and set up the app.** `ms app init` makes the `app` folder a managed app called
   ValueLens and saves its IDs in `ms.config.json`, which git ignores. `--repo none` means you build
   the app on your PC, which is why step 1 needs the second setting.

   ```powershell
   git clone https://github.com/microsoft/ValueLens-for-Microsoft-Copilot.git
   cd ValueLens-for-Microsoft-Copilot/app
   npm ci
   ms app init -n "ValueLens" --repo none -b ./dist -S "npm run build"
   ```

   If it times out finding your environment, run it again with `-e <environment-id>`. The ID is on
   the environment's page in the Power Platform admin center.

6. **Deploy it.** This builds the app, uploads it and makes it live.

   ```powershell
   ms app deploy
   ```

   To update the app later, run `git pull` and `npm ci` in the same folder, then `ms app deploy`
   again.

7. **Share it** with the people or groups who'll use it, as a comma-separated list of email
   addresses or Entra object IDs. Sharing gives them access, not a licence.

   ```powershell
   ms app share alice@contoso.com,valuelens-viewers@contoso.com
   ```

   Or run `ms app share link create` for a link that anyone in your organisation can use to get
   access.

8. **Viewers open it** at [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft): they
   choose **ValueLens**, then **Change data**, and pick their CSV files. The files are read in the
   browser and never leave their PC. See [which files the app reads](app/README.md#data) and
   [where each path puts them](app/README.md#getting-the-files-from-each-variant).

**Can Copilot do this for me?** Don't give it this code to build from. Cowork, Copilot Studio and
coding agents such as GitHub Copilot build a *new* app from a prompt, so you'd get an untested copy.
A coding agent can run the steps above for you, but it should deploy this code, not rewrite it.

More about the app, including local development, is in the [app README](app/README.md).

<a id="pick-a-path"></a>

## Where your data comes from

The app and the report show the same data. Pick the path that matches what you have, then follow
the steps in its README. Every path can produce the CSV files the app reads. Power BI Pro and Power
BI Desktop are only needed for the report.

| Path | You need | Setup |
|---|---|---|
| **[1. Fabric](1.%20Fabric/)** (recommended) | Fabric capacity (F2 or larger, or a [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager)) | Import the notebooks, schedule the pipeline and publish the report. **[🎥 Watch the setup](1.%20Fabric/README.md#set-it-up)**. The [installer](1.%20Fabric/README.md#analytics-hub-installer-work-in-progress) that automates it is a work in progress. |
| **[2. Azure](2.%20Azure/)** (work in progress) | An Azure subscription (Contributor plus User Access Administrator) and Power BI Pro | Open the installer and pick **Your Azure subscription**. It runs the data collection in your Azure subscription (scheduled jobs in Azure Container Apps, with Azure SQL and the web app) and publishes to a Power BI workspace, with no Fabric. See [Azure target](1.%20Fabric/installer/README.md#azure-target). |
| **[4. SharePoint](4.%20SharePoint/)** | Power BI Pro | App registration, a SharePoint library and a scheduled export. |
| **[5. Local CSV](5.%20Local%20CSV/)** | Power BI Desktop, June 2024 or later | Open the template. Sample data is included. |

Path 3, Power Automate + Dataverse, is [archived](#archived).

**Have Fabric?** Follow the [manual setup](1.%20Fabric/README.md#set-it-up): import the notebooks,
schedule the pipeline and publish the report. **[🎥 Watch the setup](1.%20Fabric/README.md#set-it-up)**.
The [Analytics Hub installer](https://github.com/microsoft/AnalyticsHub-Dashboard)
automates it, but it's a work in progress: try it in a test tenant first.

**Before you start**, see [what you need](1.%20Fabric/README.md#before-you-start). No Fabric capacity?
[Start a free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).

## The Power BI report

Each path also gives you the ValueLens Power BI report.

<a id="watch-first"></a>

[![Watch the demo on YouTube](https://img.youtube.com/vi/P0uHJb13ZR0/maxresdefault.jpg)](https://youtu.be/P0uHJb13ZR0)

**Just want a look?** Use [5. Local CSV](5.%20Local%20CSV/) with its sample data. It takes two
minutes and needs no access to your tenant.

**Opening a template?** Use Power BI Desktop from June 2024 or later. In older releases, some
charts and cards on the Habit Formation page show errors ([why](5.%20Local%20CSV/README.md)).
Reports in the Power BI service and Fabric aren't affected.

### Report interpretation guide

A page-by-page guide to reading the ValueLens report — 15 report pages, with the key questions each one answers. Built for both internal teams and external customers.

[![ValueLens Report Interpretation Guide](Images/Report-Interpretation-Guide-Cover.png)](docs/ValueLens-Report-Interpretation-Guide.pdf)

**[📖 Open the Report Interpretation Guide (PDF)](docs/ValueLens-Report-Interpretation-Guide.pdf)**

### Optional add-ons

- **Credit consumption and cost:** each path has an `Add Credit Consumption` folder. In Fabric,
  [set it up by hand](1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/).
- **Copilot Studio agent conversations:** in Fabric,
  [set up Agent Evaluator by hand](1.%20Fabric/Manual%20setup/Add%20Agent%20Evaluator/).
- **Shadow AI and agent risk:** in Fabric, run the
  [Defender notebook](1.%20Fabric/Manual%20setup/notebooks/README.md#optional-notebooks). It reads Microsoft Defender, needs Defender for Endpoint P2 or Defender for Cloud
  Apps, and fills the Shadow AI section of the Analytics Hub app's Governance page
  ([details](1.%20Fabric/installer/README.md#defender-shadow-ai-and-agent-risk)).

## The Fabric App (alternative)

You can host the dashboard in your own Fabric workspace instead, as a Fabric App (also in preview).
Instead of the settings in step 1, it needs a workspace on Fabric capacity (F2 or larger, or a
trial; *My workspace* won't work) and the **Fabric Apps (preview)** tenant setting. These options
stay in the repo as alternatives to the app.

- **[Analytics Hub app](1.%20Fabric/Fabric%20App/)**: queries your published ValueLens semantic
  model live, as the person viewing it, so row-level security applies. The
  [installer](1.%20Fabric/installer/README.md) deploys it. It also needs the **Semantic Model
  Execute Queries REST API** tenant setting.
- **[`fabric-app/`](fabric-app/)**: the app's design, reading your published ValueLens and
  Consumption Central semantic models live, as the person viewing it, so row-level security
  applies. It keeps no copy of your data. Deploy ValueLens alone (`npm run deploy:vl`),
  Consumption Central alone (`npm run deploy:cc`), or both behind a product switcher
  (`npm run deploy:both`); the joined app hides the tab of a product that isn't installed. Add
  `--dry-run` first to see which models it found. It also needs the **Semantic Model Execute
  Queries REST API** tenant setting. The folder is kept identical in the
  [Consumption Central](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot)
  repo. **[Fabric App details →](fabric-app/README.md)**
- **The app, in Fabric**: the same `app/` code, reading the same CSV files, hosted in your
  workspace. See [As a Fabric App](app/README.md#as-a-fabric-app-in-a-fabric-workspace).

## Archived

- **[Power Automate + Dataverse](archive/3.%20Power%20Automate%20%2B%20Dataverse/README.md)**, path
  3, was archived on 23 October 2026. Existing installs keep running, but it's no longer supported
  and gets no updates. For a new install, [pick another path](#where-your-data-comes-from).
- Older report templates are kept in [`archive/`](archive/) for reference.

## Disclaimer

- **This isn't the official Copilot report.** The official sources are the
  [Microsoft 365 admin center Copilot usage reports](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-usage)
  and the [Viva Insights Copilot Dashboard](https://learn.microsoft.com/en-us/viva/insights/org-team-insights/copilot-dashboard).
  ValueLens takes its Copilot figures mainly from the Purview audit log, which isn't the
  authoritative source, so its numbers may not always match those reports exactly.
- **You're responsible for the data once it's extracted.** ValueLens copies data into your own
  Fabric, Azure, Dataverse, SharePoint or CSV files. The retention, deletion and other policies you
  set in Purview, Microsoft 365, Entra ID, Dataverse and the other sources don't apply to those
  copies. Managing that data and meeting your organisation's requirements is up to you.

## Reference

- [How the value is calculated](docs/METHODOLOGY.md)
- [Analytics Hub app guide](docs/APP-GUIDE.md)
- [Before you start](docs/PREREQUISITES.md)
- [Permissions](docs/PERMISSIONS.md)
- [Data dictionary](docs/DATA-DICTIONARY.md)
- [Which agents the audit log covers](docs/AUDIT-LOG-COVERAGE.md)
- [Report interpretation guide (PDF)](docs/ValueLens-Report-Interpretation-Guide.pdf)
- [Installer reference](1.%20Fabric/installer/README.md) (work in progress)
- [What changed](CHANGELOG.md)

## Help

[Open an issue](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues) ·
[Support](SUPPORT.md) · [Report a vulnerability](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[MIT licence](LICENSE)

<details>
<summary>Usage and compliance disclaimer</summary>

While this tool helps customers understand the business value of their AI usage data, Microsoft has
**no visibility** into the data customers input, nor control over how the template is used. Customers
are solely responsible for ensuring their use complies with all applicable laws and regulations
(including data privacy and security). **Microsoft disclaims all liability** arising from use of this
template.

This is an **experimental** template with Purview audit logs as the primary source. Audit logs
provide visibility into Copilot/agent interactions but are not intended as the sole source of truth
for licensing or full‑fidelity reporting. Not supported through Microsoft support channels — please
open an issue in this repo.
</details>
