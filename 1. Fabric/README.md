# 1. Fabric

The recommended path. One installer sets everything up in your tenant and gives you the dashboard
as an app in Fabric, called **Analytics Hub**. You don't need a terminal or Power BI Desktop.

[![Download the Analytics Hub installer](https://img.shields.io/badge/Download-Analytics%20Hub%20installer-0078D4?style=for-the-badge)](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe)

For Windows 10 or 11. Check [what you need](#before-you-start) first.

## For manual setup (not using the Installer)

A full walkthrough of the Fabric setup, from a fresh app registration to a saved, self-refreshing Power BI report.

https://github.com/user-attachments/assets/c834bed3-49fa-4f6a-bc7a-01bded2fd53e

> Prefer to download it? [Get the walkthrough video](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/installer-v0.2.2/ValueLens_Fabric_Setup.mp4).

## Before you start

You need:

- A **Fabric capacity** (F2 or larger, or a trial).
- An **Azure subscription** where you can create a Key Vault.
- Permission to **register apps** in Entra.
- **Windows 10 or 11** to run the installer.

Someone in your organisation also needs to:

- **Grant admin consent** for the app's Graph permissions. This needs a Global Administrator or
  Privileged Role Administrator. The installer gives you a link to send them.
- **Turn on three Fabric tenant settings** in the Fabric admin portal:
  *Service principals can call Fabric public APIs*, *Semantic Model Execute Queries REST API* and
  *Fabric App items*.

The full list of roles is in the [installer README](installer/README.md#before-you-start).

Read the [disclaimer](../README.md#disclaimer) too: these aren't the official Copilot reports, and
you're responsible for the data once it's in your workspace.

## Install

1. [Download the installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe).
   If Edge says it isn't commonly downloaded, choose **…** next to the file, then **Keep**,
   **Show more** and **Keep anyway**.
2. Open it. If Windows says it protected your PC, choose **More info**, then **Run anyway**.
   These warnings appear because the installer is new and isn't code-signed yet.
3. After about a minute, it opens in your browser. Keep the installer window open until you're
   done.
4. Choose **Set up Analytics Hub** and sign in with your work account.
5. Answer the questions. The defaults suit most organisations. Under **What to collect**, tick the
   data you want. **Back** takes you to the previous question, with your answer filled in.
6. Check the plan and approve it. Nothing is created until you do.
7. Wait for it to finish. It sets everything up, loads the first data and gives you a link to the
   app.

If admin consent isn't granted yet, the installer skips the first load. Once an admin has granted
it, open the exe again and choose **Run now**.

## Use it

- **Open the app:** in your Fabric workspace, open **Analytics Hub**.
- **Share it:** in the app, choose **Share** and add people. They also need **Build** permission on
  `Analytics Hub Model` (under **Manage permissions**). Installs from earlier versions keep the
  name `ValueLens Model`.
- **Fresh data:** the pipeline runs on the schedule you chose.
- **Status, updates or repairs:** open the exe again.

## Optional extras

Copilot usage, licences and org data are always collected. Tick any of these extras in the
installer under **What to collect**. Each one has a few steps of its own.

| Extra | What it shows | Where the data comes from |
|---|---|---|
| [Credit consumption](installer/README.md#credit-consumption) | Credits used and what they cost across Copilot Studio, Copilot Cowork and Azure AI | Copilot Studio credits from a daily flow on the Power Platform licensing API (exports from the Power Platform admin center are optional), Cowork credits from a Viva Insights query through a Dataflow (or its CSV export), and Azure AI and pay-as-you-go costs from Azure |
| [Agent Evaluator](installer/README.md#agent-evaluator) | How well your Copilot Studio agents work: how conversations end, topics, knowledge, errors and user feedback | Copilot Studio conversation transcripts in Dataverse |
| [Microsoft 365 activity](installer/README.md#microsoft-365-activity) *(on by default)* | How people work across Teams, Outlook, SharePoint, OneDrive and the Office apps | Microsoft 365 usage reports |
| [Defender (shadow AI and agent risk)](installer/README.md#defender-shadow-ai-and-agent-risk) | AI tools other than Copilot in use on your devices and network, and agents that answer without sign-in | Microsoft Defender advanced hunting and Cloud Discovery |

## Prefer Power BI Desktop?

To build your own reports, connect Power BI Desktop to `Analytics Hub Model` (or `ValueLens Model`)
in your workspace.

To use a template instead, choose not to deploy the model in the installer's **Power BI** step.
When it finishes, it shows the values to enter in
[`ValueLens - Fabric.pbit`](Manual%20setup/ValueLens%20-%20Fabric.pbit) (SQL endpoint) or
[`ValueLens - Fabric OneLake.pbit`](Manual%20setup/ValueLens%20-%20Fabric%20OneLake.pbit) (OneLake).
Publish the report, then
[add a refresh step to the pipeline](Manual%20setup/pipelines/README.md#refresh-power-bi-from-the-pipeline).

## Set it up by hand

If you can't use the installer, follow [Manual setup](Manual%20setup/README.md). It uses the same
files the installer does.

## Problems

See [Troubleshooting](installer/README.md#troubleshooting).
