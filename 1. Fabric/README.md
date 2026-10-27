# 1. Fabric

The recommended data path. Notebooks in a Fabric Lakehouse collect the data. A pipeline runs them
on a schedule. The ValueLens Power BI report reads the result.

## Video

This video walks through the manual setup, from a new app registration to a self-refreshing
Power BI report.

[![Watch the Fabric setup on YouTube](https://img.youtube.com/vi/-pAuSQSP5pc/maxresdefault.jpg)](https://youtu.be/-pAuSQSP5pc)

**▶ [Watch on YouTube](https://youtu.be/-pAuSQSP5pc)**

> Prefer to download it? [Get the walkthrough video](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/installer-v0.2.2/ValueLens_Fabric_Setup.mp4).

## Before you start

- [ ] **A Fabric capacity**, F2 or larger. No capacity?
      [Start a free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).
- [ ] **An app registration** with the Microsoft Graph permissions in [Permissions](../docs/PERMISSIONS.md).
      A Global Administrator or Privileged Role Administrator grants admin consent.
- [ ] **An Azure Key Vault** for the app's secret.
- [ ] **Power BI Desktop**, June 2024 or later, and Power BI Pro to publish the report.
- [ ] **Read the [disclaimer](../README.md#disclaimer).** You're responsible for the data once it's in your workspace.

The full checklist, by who does what, is in [Before you start](../docs/PREREQUISITES.md).

<details>
<summary>Why June 2024 or later?</summary>

In older Desktop releases, the habit-stage charts and cards on the Habit Formation page can show
errors, because their measures use `SUMMARIZECOLUMNS` in ways those releases don't fully
support. Reports in the Power BI service and Fabric aren't affected.

</details>

## Choose your path

| Path | Who it suits |
|---|---|
| **[Installer](#installer)** (recommended, fastest) | Most people. It sets up everything, plus the Analytics Hub app. It's a work in progress. |
| **[Manual](#manual)** (step by step) | Production installs, or people who want to control each step. |

<a id="analytics-hub-installer-work-in-progress"></a>
<a id="install"></a>

## Installer

> **Work in progress.** Try it in a test or demo tenant first, and use the manual setup for
> production. [Tell us](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues) what
> works and what doesn't. A ValueLens-only installer is coming soon
> ([#216](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/pull/216)).

Allow about 5 minutes of questions and 15 minutes of setup.

1. [Download the installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe)
   (Windows 10 or 11). If Edge says it isn't commonly downloaded, choose **…** next to the file,
   then **Keep**, **Show more** and **Keep anyway**.
2. Open it. If Windows says it protected your PC, choose **More info**, then **Run anyway**.
   The installer isn't code-signed yet. To check the file first, see
   [Check the download](installer/README.md#check-the-download).
3. After about a minute, it opens in your browser. Keep the installer window open until you're done.
4. Choose **Set up Analytics Hub** and sign in with your work account.
5. Answer the questions. Under **Data sources**, pick the data you want. For
   **Change the advanced settings?**, **No** takes the defaults
   ([Advanced settings](installer/README.md#advanced-settings)).
6. Check the plan and approve it. Nothing is created until you do.
7. Wait for it to finish. It loads the first data and gives you a link to the app.
   The first data arrives about 25 minutes after **Go ahead**, or about 2 hours with 180 days of history.

No admin consent yet? The installer skips the first load. Once an admin grants it, open the exe
again and choose **Run now**.

<a id="set-it-up"></a>

## Manual

Follow [Manual setup](Manual%20setup/README.md). The [video](#video) shows every step.

1. **[Notebooks](Manual%20setup/notebooks/README.md).** Register an app, create a Lakehouse, load
   the data and publish the report.
2. **[Pipeline](Manual%20setup/pipelines/README.md).** Run the notebooks on a schedule and refresh
   the report.
3. **Optional: [add extras](#optional-extras)**, such as credit consumption or Agent Evaluator.

<a id="use-it"></a>

## After setup

- **Check it worked.** Open the report, or the **Analytics Hub** app in your Fabric workspace.
  You should see your organisation's data.
- **Share it.** The installer creates the **Analytics Hub Viewers** group, with you as owner.
  1. **Once:** in the workspace, choose **…** next to the **Analytics Hub** app, then **Share**.
     Add **Analytics Hub Viewers** and choose **Grant**. Do the same for the **ValueLens** report
     if you use it.
  2. **To give someone access:** add them to the group in [My Groups](https://myaccount.microsoft.com/groups).

  People without access see who to ask. See
  [Viewing Analytics Hub](../docs/PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2).
- **Keep it fresh.** The pipeline runs on the schedule you chose.
- **Status, updates or repairs:** open the installer again.
- **Problems?** See [Problems](#problems).

---

<a id="optional-extras"></a>

<details>
<summary><strong>Optional extras</strong></summary>

<br>

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

</details>

<a id="data-source-cards"></a>

<details>
<summary><strong>Installer data source cards</strong></summary>

<br>

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

**Items you didn't expect.** If you chose Copilot Cowork credits, Fabric adds items such as
`DataflowsStagingLakehouse` and `DataflowsStagingWarehouse` to the workspace. Dataflows use them
behind the scenes. They're expected: leave them alone
([Microsoft's note](https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview#staging-items-in-your-workspace)).
Installs from earlier versions keep the model name `ValueLens Model`.

</details>

<a id="prefer-power-bi-desktop"></a>

<details>
<summary><strong>Installed with the installer but prefer Power BI Desktop?</strong></summary>

<br>

To build your own reports, connect Power BI Desktop to `Analytics Hub Model` (or `ValueLens Model`)
in your workspace.

To use a template instead, choose not to deploy the model in the installer's **Power BI** step.
When it finishes, it shows the values to enter in
[`ValueLens - Fabric.pbit`](Manual%20setup/ValueLens%20-%20Fabric.pbit) (SQL endpoint) or
[`ValueLens - Fabric OneLake.pbit`](Manual%20setup/ValueLens%20-%20Fabric%20OneLake.pbit) (OneLake).
Publish the report, then
[add a refresh step to the pipeline](Manual%20setup/pipelines/README.md#refresh-power-bi-from-the-pipeline).

</details>

<a id="problems"></a>

<details>
<summary><strong>Problems</strong></summary>

<br>

- **The installer:** [Troubleshooting](installer/README.md#troubleshooting). The full reference
  is in the [installer README](installer/README.md).
- **The notebooks:** [An audit window keeps failing](Manual%20setup/notebooks/README.md#an-audit-window-keeps-failing).

</details>
