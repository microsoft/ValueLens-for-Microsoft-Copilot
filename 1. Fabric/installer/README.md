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

## Data sources and exports

| Source | Connected (API) | Upload CSV: where to export it | Fills |
|---|---|---|---|
| Copilot usage and licences | Always | | Every page |
| Org data (Entra ID) | Always | | Organisation filters |
| Workday org data | | Workday: a report of active workers with **Primary Work Email** | Organisation filters |
| Microsoft 365 activity | Yes | | M365 activity |
| Agent 365 registry | Needs an Agent 365 licence | Microsoft 365 admin center > **Agents** > **All agents** > **Export** | Agents |
| Product feedback | No API | Microsoft 365 admin center > **Health** > **Product feedback** > **Export** | User Feedback |
| Copilot Studio credits | No API | Power Platform admin center > **Licensing** > **Products** > **Copilot Studio** (Summary, Environments and Agents) | Consumption Central |
| Copilot Cowork credits | | Viva Insights > Copilot Consumption Dashboard > **Export** | Consumption Central |
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

**Product feedback by email (optional).** If you have Power Automate premium, the installer can
write a ready-filled copy of the [product feedback flow](../Manual%20setup/flows/README.md) next to
your answers. Import it, connect Outlook, and set its client secret. The flow saves each emailed
export to the same folder. The app registration needs Contributor on the workspace.

### Commands

| To | Run |
|---|---|
| Choose sources without the questions | `install --data productFeedback=csv,agent365=api --yes` |
| Upload exports during the install | `install --data productFeedback=csv --csv feedback.csv` |
| Write the product feedback email flow | `install --data productFeedback=csv --feedback-flow` |
| Upload exports later, then load them now | `upload feedback.csv agents.csv --run` |

Source IDs for `--data`: `workday`, `m365Activity`, `agent365`, `productFeedback`,
`studioCredits`, `coworkCredits`, `azureAi`, `agentEvaluator`. Modes: `api`, `csv` or `skip`.

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
  from the Summary, Environments and Agents tabs, and add them as [exports](#data-sources-and-exports).
  Do it each month; a new file replaces the last one of the same kind.
- **Cowork credits.** Add the Viva Insights Consumption Dashboard's CSV export as an
  [export](#data-sources-and-exports). Or build a Viva Insights query with the Copilot credit
  metrics, turn on auto-refresh, and create a Dataflow Gen2 in the workspace that loads it into
  `viva_credits_weekly`, following the [Viva Insights guide](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric)
  (Schema type *Pivoted*, Data granularity *Row-level data*).

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
| A run says Fabric's capacity was too busy (`TooManyRequestsForCapacity`) | Nothing is lost. Wait a few minutes, then choose **Run now** again. It happens most on trials and small capacities. |
| `Fabric couldn't set up the model's connection` | Turn on *Service principals can call Fabric public APIs*, then choose **Repair or change**. |
| `Couldn't connect ValueLens Model to …` | Open the link it shows. Under **Gateway and cloud connections**, pick `ValueLens SQL …`. Then choose **I've connected it myself**. |
| A model refresh fails with `Login failed` | The connection's secret expired. Choose **Create new secrets**. |
| `The app wasn't deployed` | Fix the cause it shows, then choose **Redeploy the app**. |
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