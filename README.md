# ValueLens for Microsoft Copilot

**Understand the hours and value Microsoft 365 Copilot and agents deliver.**

Use the app or the Power BI report. Find reports and walkthroughs on
[DataHub site](https://ai-datalab.github.io/).

<a id="start-here-the-app-preview"></a>
<a id="app-edition-preview"></a>
<a id="where-your-data-comes-from"></a>
<a id="pick-a-path"></a>
<a id="manual"></a>

## Choose your path

**Start with the app** if you want to explore ValueLens without Fabric or Power BI.
[Download the sample app](app/download/ValueLens-App.html) using **Download raw file**, then
open it in Edge or Chrome. To use your own data, load processed CSVs from
[PAX or the shared processor](shared/scripts/README.md#getting-the-raw-export), not raw audit logs.
No Power BI licence or Azure subscription is needed for this browser app.
[App setup and sharing](app/README.md) covers the preview Managed App option and its separate licences.

**For a scheduled Power BI report**, choose by the services you have:

| Data route | What you need | Start here |
|---|---|---|
| **[SharePoint](4.%20SharePoint/README.md)** | No Fabric or Azure subscription. Power BI Pro/PPU, a SharePoint library and a Windows PC for the daily PAX export | ValueLens installer, or manual setup |
| **[Fabric](1.%20Fabric/README.md)** | Fabric capacity (F2+) and a workspace; Power BI Pro/PPU to publish | ValueLens installer, or manual setup |
| **[Azure](2.%20Azure/README.md)** | Azure subscription, Power BI Pro and a workspace; no Fabric | Separate DataHub installer; work in progress |

<a id="before-you-start"></a>
<a id="installer"></a>

Before installing, check [prerequisites](docs/PREREQUISITES.md) and
[permissions](docs/PERMISSIONS.md). The [ValueLens installer](docs/INSTALL.md) covers
SharePoint and Fabric; Azure uses the separate installer linked in its route guide.
Installers are experimental: try a test environment first.
Databricks is not an installer target; the [Fabric notebooks need adaptation](1.%20Fabric/Manual%20setup/notebooks/README.md#databricks).

<a id="after-setup"></a>
<a id="the-power-bi-report"></a>
<a id="the-fabric-app-alternative"></a>

## Use and customise

[Read the report](docs/ValueLens-Report-Interpretation-Guide.pdf) ·
[How value is calculated](docs/METHODOLOGY.md) ·
[Customise ValueLens](docs/CUSTOMISE.md) ·
[Administrator security and privacy setup](docs/SECURITY-PRIVACY-SETUP.md)

For app hosting and sharing, follow [the app guide](app/README.md). The downloaded app starts
with labelled synthetic data; it does not collect tenant data or set up a scheduled report.

<a id="watch-first"></a>

[Watch the demo](https://youtu.be/P0uHJb13ZR0) ·
[App explainer](https://ai-datalab.github.io/#/watch/valuelens-explainer) ·
[Get help](SUPPORT.md) ·
[Report an issue](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues)

**Also see [DataHub App for Microsoft Copilot, Agents, Cowork and Autopilots](https://github.com/microsoft/DataHub-App-for-Microsoft-Copilot-Agents-Cowork-and-Autopilots):**
one app for adoption, value, consumption and governance, including the ValueLens report.

## Disclaimer

This is an experimental template, not the official Copilot report and not supported through
Microsoft support channels. Purview audit logs are not an authoritative source for licensing
or full-fidelity usage; figures may differ from the official Microsoft 365 and Viva reports.

You are responsible for extracted data, access, retention, deletion and compliance. Source-system
policies do not automatically apply to copies in your own storage. Microsoft has no visibility into
your input data or control over your use of this template, and disclaims liability arising from
its use. You must comply with applicable laws and regulations, including privacy and security.

[MIT license](LICENSE) · [Security reporting](SECURITY.md) · [Contributing](CONTRIBUTING.md)
