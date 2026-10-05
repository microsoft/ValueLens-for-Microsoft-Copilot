# ValueLens for Microsoft Copilot

A Power BI dashboard that shows how your organisation uses Microsoft 365 Copilot and agents, and
the hours and value they deliver.

![ValueLens preview](Images/ValueLens-Preview.gif)

**Have Fabric?** [Download the Analytics Hub installer](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe),
open it and follow the steps in your browser. Check
[what you need](1.%20Fabric/README.md#before-you-start) first.

## Pick a path

Every path gives you the same dashboard. Pick the one that matches what you have, then follow the
steps in its README.

| Path | You need | Setup |
|---|---|---|
| **[1. Fabric](1.%20Fabric/)** (recommended) | Fabric capacity (F2 or larger, or a trial) | Double-click an installer. It sets up everything and deploys the dashboard as an app. **[🎥 Watch the setup](1.%20Fabric/README.md#watch-the-setup)** |
| **[2. Power Automate + Dataverse](2.%20Power%20Automate%20+%20Dataverse/)** (preview) | Power Automate premium and Dataverse | Import a collector solution and run a refresh script. |
| **[3. SharePoint](3.%20SharePoint/)** | Power BI Pro | App registration, a SharePoint library and a scheduled export. |
| **[4. Local CSV](4.%20Local%20CSV/)** | Power BI Desktop | Open the template. Sample data is included. |

**Just want a look?** Use [4. Local CSV](4.%20Local%20CSV/) with its sample data. It takes two
minutes and needs no access to your tenant.

## Optional add-ons

- **Credit consumption and cost:** in Fabric, choose it in the installer. Other paths have an
  `Add Credit Consumption` folder.
- **Copilot Studio agent conversations:** in Fabric, choose *Agent Evaluator* in the installer, or
  [set it up by hand](1.%20Fabric/Manual%20setup/Add%20Agent%20Evaluator/).

## Reference

- [How the value is calculated](docs/METHODOLOGY.md)
- [Permissions](docs/PERMISSIONS.md)
- [Data dictionary](docs/DATA-DICTIONARY.md)
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