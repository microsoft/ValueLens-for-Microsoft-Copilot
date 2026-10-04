# 1. Fabric

The recommended path. An installer sets everything up in your tenant and deploys the dashboard as
an app in Fabric, called **Analytics Hub**. You don't need a terminal or Power BI Desktop.

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

## Install

1. Download `AnalyticsHubInstaller.exe` from the
   [latest release](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases).
2. Double-click it. If Windows says it protected your PC, choose **More info**, then **Run anyway**.
3. The installer opens in your browser. Keep the installer window open until you're done.
4. Choose **Set up Analytics Hub** and sign in.
5. Answer the questions. The defaults are fine for most tenants.
6. Check the plan and approve it. Nothing is created until you do.
7. Wait for it to finish. It sets everything up, loads the first data and gives you a link to the
   app.

If admin consent isn't granted yet, the installer skips the first load. Once an admin has granted
it, open the exe again and choose **Run now**.

## Use it

- **Open the app:** in your Fabric workspace, open **Analytics Hub**.
- **Share it:** in the app, choose **Share** and add people. They also need **Build** permission on
  `ValueLens Model` (under **Manage permissions**).
- **Fresh data:** the pipeline runs on the schedule you chose.
- **Status, updates or repairs:** open the exe again.

## Optional extras

Choose these in the installer under **What to collect**. Each one has a few steps of its own.

- [Credit consumption](installer/README.md#credit-consumption): what Copilot costs.
- [Agent Evaluator](installer/README.md#agent-evaluator): how your Copilot Studio agents perform.
- [Microsoft 365 activity](installer/README.md#microsoft-365-activity) (on by default): how people
  work across Teams, Outlook and the Office apps.

## Prefer Power BI Desktop?

To build your own reports, connect Power BI Desktop to `ValueLens Model` in your workspace.

To use a template instead, choose not to deploy the model in the installer's **Power BI** step.
When it finishes, it shows the values to enter in `ValueLens - Fabric.pbit` (SQL endpoint) or
`ValueLens - Fabric OneLake.pbit` (OneLake). Publish the report, then
[add a refresh step to the pipeline](pipelines/README.md#refresh-power-bi-from-the-pipeline).

## Set it up by hand

If you can't use the installer, follow [notebooks](notebooks/README.md), then
[pipelines](pipelines/README.md).

## Problems

See [Troubleshooting](installer/README.md#troubleshooting).