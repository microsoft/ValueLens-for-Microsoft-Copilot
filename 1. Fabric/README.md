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
- **Power BI Desktop**, June 2024 or later, to open the template, and Power BI Pro to publish it.
  In older Desktop releases, the habit-stage charts and cards on the Habit Formation page can show
  errors, because their measures use `SUMMARIZECOLUMNS` in ways those releases don't fully
  support. Reports in the Power BI service and Fabric aren't affected.

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

## ValueLens installer

The [ValueLens installer](../installer/README.md) sets up what this page describes, with its
**Fabric** route. To get it, see [Install](../installer/README.md#install) in its README, or the
[installer releases](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=valuelens-installer-v).
[docs/INSTALL.md](../docs/INSTALL.md) has the steps, and
[Prerequisites](../docs/PREREQUISITES.md#the-valuelens-installer) lists what it needs.

Using Analytics Hub? It has its own installer, in
[microsoft/AnalyticsHub-Dashboard](https://github.com/microsoft/AnalyticsHub-Dashboard).

### What it sets up

In a Fabric workspace on your capacity, from `Manual setup`:

- A Lakehouse, the notebooks, and a pipeline that runs them each day.
- The `ValueLens Model` semantic model and the `ValueLens` report.
- An app registration, `ValueLens (Fabric)`, with the Microsoft Graph permissions your data
  sources need. The notebooks sign in as it.
- A viewer group, `ValueLens Viewers`.
- Power Automate flows, only for the sources that use them.

Then it loads the first data and checks it. It deploys the report only: deploying the app from
the Fabric route comes in a later version. The full list is in
[What it sets up](../installer/README.md#fabric-route).

### Data source cards

Copilot usage and licences, and org data from Microsoft Entra ID, are always collected. Choose
the rest on the installer's **Data sources** screen, where each source has a card:

| Card | What it adds | How the data arrives |
|---|---|---|
| Workday org data | Fields from a Workday report that the org data doesn't have, matched on Primary Work Email | **Upload CSV** |
| Microsoft 365 activity *(on by default)* | Teams, Outlook, SharePoint, OneDrive, Viva Engage and Office app usage | **Connected (API)**, from the Microsoft 365 usage reports |
| Agent 365 registry | The agents in your tenant and who made them | **Connected (API)**, which needs an Agent 365 licence, or **Upload CSV** of the Microsoft 365 admin center export |
| Product feedback | What people say about Copilot | The Microsoft 365 admin center export, saved by a Power Automate flow, or **Upload CSV** |
| Defender (shadow AI and agent risk) | Other AI tools on your devices and network, and agents that answer without sign-in | **Connected (API)**, from Microsoft Defender. Needs Defender for Endpoint P2 or Defender for Cloud Apps |
| Agent configuration and Foundry (Azure Resource Graph) | How each Copilot Studio agent is set up, and your Foundry resources and projects | **Connected (API)**, from Azure Resource Graph. Foundry needs Reader on a management group; agents need an Entra role such as Global Reader |

What each one needs, and the command-line options, are in
[What it sets up](../installer/README.md#fabric-route). The app registration's permissions are in
[PERMISSIONS](../docs/PERMISSIONS.md#the-valuelens-installer).

### Share it

- The installer creates the **ValueLens Viewers** group, with you as owner, and gives it **Build**
  on the semantic model.
- The group gets no workspace role. Workspace viewers can read the notebooks' code, and by
  default the app registration's client secret is in the notebooks.
- **Once:** share the report with the group. In the workspace, choose **…** next to the
  **ValueLens** report, then **Manage permissions** > **Add user**. Enter **ValueLens Viewers**
  and choose **Grant**. The installer asks you to do this. **Later** leaves a card for it on the
  Done page, and a repair asks again.
- **To give someone access:** add them to the group, with **Manage access** in the installer or
  in [My Groups](https://myaccount.microsoft.com/groups).

More in [Viewer access](../installer/README.md#viewer-access).

### Prefer Power BI Desktop?

To build your own reports, connect Power BI Desktop to `ValueLens Model` in your workspace.

To use a template instead, answer **Deploy the semantic model?** with **Neither**, in the
installer's **Power BI** settings. In the terminal, it's one of the advanced settings. When the
installer finishes, it shows the values to enter in
[`ValueLens - Fabric.pbit`](Manual%20setup/ValueLens%20-%20Fabric.pbit) (SQL endpoint) or
[`ValueLens - Fabric OneLake.pbit`](Manual%20setup/ValueLens%20-%20Fabric%20OneLake.pbit)
(OneLake). Publish the report, then
[add a refresh step to the pipeline](Manual%20setup/pipelines/README.md#refresh-power-bi-from-the-pipeline).

## Problems

See [Troubleshooting](../installer/README.md#troubleshooting) for the installer, and
[An audit window keeps failing](Manual%20setup/notebooks/README.md#an-audit-window-keeps-failing) for the notebooks.
