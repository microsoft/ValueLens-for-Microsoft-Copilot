# 1. Fabric

Notebooks collect the data into a Lakehouse; a pipeline runs them on a schedule.
The ValueLens Power BI report reads the result.

[All routes](../README.md#choose-your-path): **4. SharePoint**, **1. Fabric**, **2. Azure**.

## Before you start

You need Fabric capacity (F2 or larger), a workspace, Power BI Pro to publish,
and administrator consent for the read-only source permissions.
For manual setup, you also need an app registration, Azure Key Vault for its secret,
and Power BI Desktop (June 2024 or later).

[Full prerequisites](../docs/PREREQUISITES.md) · [Permissions](../docs/PERMISSIONS.md) ·
[Data responsibility](../README.md#disclaimer)

<a id="choose-your-path"></a>
<a id="analytics-hub-installer-work-in-progress"></a>
<a id="valuelens-installer"></a>
<a id="install"></a>

## Installer

**Work in progress: try a test environment first.** For production, follow the manual setup.

Follow [Install](../docs/INSTALL.md), choose **Set up ValueLens**, then **Fabric**.
The ValueLens installer creates the Lakehouse, notebooks, daily pipeline, semantic model,
report and viewer group. It loads the first data and checks it.
It deploys the report only; it does not yet deploy the app on this route.

[What it sets up](../installer/README.md#fabric-route) ·
[Installer reference](../installer/README.md)

For the combined adoption, value, consumption and governance app, use the separate
[DataHub installer](https://github.com/microsoft/DataHub-App-for-Microsoft-Copilot-Agents-Cowork-and-Autopilots).

<a id="set-it-up"></a>

## Manual

Follow [Manual setup](Manual%20setup/README.md): load the data with
[notebooks](Manual%20setup/notebooks/README.md), publish the report, then schedule the
[pipeline](Manual%20setup/pipelines/README.md).

<a id="video"></a>

[Watch the manual setup](https://youtu.be/-pAuSQSP5pc) or
[download the walkthrough](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/installer-v0.2.2/ValueLens_Fabric_Setup.mp4).

<a id="use-it"></a>

## After setup

Open the report and check its data dates and load status. The pipeline keeps it fresh.
Share the report with the viewer group, not a workspace role; review
[viewer access](../installer/README.md#viewer-access) and
[administrator security and privacy setup](../docs/SECURITY-PRIVACY-SETUP.md) first.

For an app, choose the [CSV app](../app/README.md) or
[Fabric-hosted app](../fabric-app/README.md). These are hosting options for this route,
not extra data routes. [Customise ValueLens](../docs/CUSTOMISE.md) covers branding,
assumptions and organisation grouping.

<a id="optional-extras"></a>
<a id="data-source-cards"></a>
<a id="prefer-power-bi-desktop"></a>

## Optional sources and advanced setup

[Optional notebooks](Manual%20setup/notebooks/README.md#optional-notebooks) ·
[Credit consumption](Manual%20setup/Add%20Credit%20Consumption/README.md) ·
[Agent Evaluator](Manual%20setup/Add%20Agent%20Evaluator/README.md) ·
[Installer data sources and Desktop templates](../installer/README.md#fabric-route)

<a id="problems"></a>

## Help

[Installer troubleshooting](../installer/README.md#troubleshooting) ·
[Audit-load troubleshooting](Manual%20setup/notebooks/README.md#an-audit-window-keeps-failing) ·
[Support](../SUPPORT.md)
