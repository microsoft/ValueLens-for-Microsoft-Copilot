# 1. Fabric

The recommended path. Notebooks in a Fabric Lakehouse collect the data, a pipeline runs them on a
schedule, and the ValueLens Power BI report reads it. You set it up by hand, step by step.

## Before you start

- A **Fabric capacity**, F2 or larger. No capacity?
  [Start a free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).
- An **app registration** with the Microsoft Graph permissions in
  [PERMISSIONS](../docs/PERMISSIONS.md), and a **Global Administrator** or **Privileged Role
  Administrator** to grant admin consent.
- An **Azure Key Vault** for the app's secret.
- **Power BI Desktop** to open the template, and Power BI Pro to publish it.

The [Before you start checklist](../docs/PREREQUISITES.md) goes through who to ask for what, the
optional extras and the costs.

Read the [disclaimer](../README.md#disclaimer) too: these aren't the official Copilot reports, and
you're responsible for the data once it's in your workspace.

## Set it up

Follow [Manual setup](Manual%20setup/README.md):

1. **[Notebooks](Manual%20setup/notebooks/README.md).** Register an app, create a Lakehouse, load
   the data and publish the report.
2. **[Pipeline](Manual%20setup/pipelines/README.md).** Run the notebooks on a schedule and refresh
   the report.

This video walks through it, from a fresh app registration to a saved, self-refreshing Power BI
report.

https://github.com/user-attachments/assets/c834bed3-49fa-4f6a-bc7a-01bded2fd53e

> Prefer to download it? [Get the walkthrough video](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/installer-v0.2.2/ValueLens_Fabric_Setup.mp4).

## Optional extras

Copilot usage, licences and org data are always collected. Each of these adds a notebook or a
report of its own:

| Extra | What it shows | Set it up |
|---|---|---|
| Microsoft 365 activity | How people work across Teams, Outlook, SharePoint, OneDrive and the Office apps | [Optional notebooks](Manual%20setup/notebooks/README.md#optional-notebooks) |
| Agent 365 registry | The agents in your tenant and who made them | [Optional notebooks](Manual%20setup/notebooks/README.md#optional-notebooks) |
| Product feedback | What people say about Copilot | [Optional notebooks](Manual%20setup/notebooks/README.md#optional-notebooks) and the [flow](Manual%20setup/flows/) |
| Credit consumption | Credits used and what they cost across Copilot Studio, Copilot Cowork and Azure AI | [Add Credit Consumption](Manual%20setup/Add%20Credit%20Consumption/) |
| Agent Evaluator | How well your Copilot Studio agents work | [Add Agent Evaluator](Manual%20setup/Add%20Agent%20Evaluator/) |
| Defender (shadow AI and agent risk) | AI tools other than Copilot in use on your devices and network, and agents that answer without sign-in | [Optional notebooks](Manual%20setup/notebooks/README.md#optional-notebooks) |
| Agent configuration and Foundry (Azure Resource Graph) | How each Copilot Studio agent is set up, and your Foundry resources | [Optional notebooks](Manual%20setup/notebooks/README.md#optional-notebooks) |

## Analytics Hub installer (work in progress)

> **Work in progress.** The installer automates the manual setup above and adds **Analytics Hub**,
> the dashboard as an app in Fabric. It's still changing, so try it in a test or demo tenant first,
> and use the manual setup for production. [Tell us](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues)
> what works and what doesn't.

[Download the installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe) (Windows 10 or 11). The
[Before you start checklist](../docs/PREREQUISITES.md) lists what it needs. Allow about 5 minutes of questions and 15
minutes of setup. The first data reaches the app about 25 minutes after you choose **Go ahead**, or
about 2 hours with 180 days of history. The full reference is in the
[installer README](installer/README.md).

### Install

1. [Download the installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe).
   If Edge says it isn't commonly downloaded, choose **…** next to the file, then **Keep**,
   **Show more** and **Keep anyway**.
2. Open it. If Windows says it protected your PC, choose **More info**, then **Run anyway**.
   These warnings appear because the installer is new and isn't code-signed yet. To check the
   file first, or if your organisation blocks it, see
   [Check the download](installer/README.md#check-the-download).
3. After about a minute, it opens in your browser. Keep the installer window open until you're
   done.
4. Choose **Set up Analytics Hub** and sign in with your work account.
5. Answer the questions. Under **Data sources**, choose the data you want: each source has a
   card. Then **Change the advanced settings?** **No** takes the defaults, which suit most
   organisations: see [Advanced settings](installer/README.md#advanced-settings). **Back** takes
   you to the previous question, with your answer filled in.
6. Check the plan and approve it. Nothing is created until you do.
7. Wait for it to finish. It sets everything up, loads the first data and gives you a link to the
   app.

If admin consent isn't granted yet, the installer skips the first load. Once an admin has granted
it, open the exe again and choose **Run now**.

### Use it

- **Open the app:** in your Fabric workspace, open **Analytics Hub**.
- **Share it.** The installer creates the **Analytics Hub Viewers** group, with you as owner, and
  gives it access to the data. Then:
  1. **Once:** share the app with the group. In the workspace, choose **…** next to the
     **Analytics Hub** app, then **Share**, add **Analytics Hub Viewers** and choose **Grant**. Do
     the same for the **ValueLens** report if you use the Power BI reports.
  2. **To give someone access:** add them to the group in
     [My Groups](https://myaccount.microsoft.com/groups).

  People without access see who to ask. See
  [Viewing Analytics Hub](../docs/PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2).
- **Fresh data:** the pipeline runs on the schedule you chose.
- **Status, updates or repairs:** open the exe again.
- **Items you didn't expect.** If you chose Copilot Cowork credits, Fabric adds items such as
  `DataflowsStagingLakehouse` and `DataflowsStagingWarehouse` to the workspace. Dataflows use them
  behind the scenes. They're expected: leave them alone
  ([Microsoft's note](https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview#staging-items-in-your-workspace)).
- Installs from earlier versions keep the model name `ValueLens Model`.

### Data source cards

Copilot usage, licences and org data are always collected. Choose any of these on the
installer's **Data sources** screen, where each one is a card. Each has a few steps of its own:
see [Optional extras](../docs/PREREQUISITES.md#optional-extras) for what each one needs.

| Card | What it shows | Where the data comes from |
|---|---|---|
| [Microsoft 365 activity](installer/README.md#microsoft-365-activity) *(on by default)* | How people work across Teams, Outlook, SharePoint, OneDrive and the Office apps | Microsoft 365 usage reports |
| [Agent 365 registry](installer/README.md#data-sources-and-exports) | The agents in your tenant and who made them | The Agent 365 API, or the Microsoft 365 admin center export |
| [Product feedback](installer/README.md#power-automate-flows) | What people say about Copilot | The Microsoft 365 admin center export, saved by a flow or uploaded |
| [Credit consumption](installer/README.md#credit-consumption): **Copilot Studio credits**, **Copilot Cowork credits** and **Azure AI costs** | Credits used and what they cost across Copilot Studio, Copilot Cowork and Azure AI | Copilot Studio credits from a daily flow on the Power Platform licensing API (exports from the Power Platform admin center are optional), Cowork credits from a Viva Insights query through a Dataflow (or its CSV export), and Azure AI and pay-as-you-go costs from Azure |
| [Agent Evaluator](installer/README.md#agent-evaluator) | How well your Copilot Studio agents work: how conversations end, topics, knowledge, errors and user feedback | Copilot Studio conversation transcripts in Dataverse |
| [Defender (shadow AI and agent risk)](installer/README.md#defender-shadow-ai-and-agent-risk) | AI tools other than Copilot in use on your devices and network, and agents that answer without sign-in | Microsoft Defender advanced hunting and Cloud Discovery |
| [Agent configuration and Foundry (Azure Resource Graph)](installer/README.md#agent-configuration-and-foundry) | How each Copilot Studio agent is set up, and your Foundry resources | Azure Resource Graph |

### Prefer Power BI Desktop?

To build your own reports, connect Power BI Desktop to `Analytics Hub Model` (or `ValueLens Model`)
in your workspace.

To use a template instead, choose not to deploy the model in the installer's **Power BI** step.
When it finishes, it shows the values to enter in
[`ValueLens - Fabric.pbit`](Manual%20setup/ValueLens%20-%20Fabric.pbit) (SQL endpoint) or
[`ValueLens - Fabric OneLake.pbit`](Manual%20setup/ValueLens%20-%20Fabric%20OneLake.pbit) (OneLake).
Publish the report, then
[add a refresh step to the pipeline](Manual%20setup/pipelines/README.md#refresh-power-bi-from-the-pipeline).

## Problems

See [Troubleshooting](installer/README.md#troubleshooting) for the installer, and
[An audit window keeps failing](Manual%20setup/notebooks/README.md#an-audit-window-keeps-failing) for the notebooks.
