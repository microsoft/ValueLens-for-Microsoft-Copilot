# ValueLens for Microsoft Copilot

**Understand the hours and value Microsoft 365 Copilot and agents deliver.**

Use the Power BI report, with an optional app. Find reports and walkthroughs on
[DataHub site](https://ai-datalab.github.io/).

<a id="start-here-the-app-preview"></a>
<a id="app-edition-preview"></a>
<a id="where-your-data-comes-from"></a>
<a id="pick-a-path"></a>
<a id="manual"></a>

## Choose your path

Pick one. Start with SharePoint if you don't have Fabric.

| Route | What you need | Start here |
|---|---|---|
| **[1. SharePoint](1.%20SharePoint/README.md)** | Power BI Pro, a SharePoint library and a Windows PC for the scheduled PAX export | ValueLens installer, or manual setup |
| **[2. Fabric (or another data platform)](2.%20Fabric/README.md)** | Fabric capacity and a workspace. On another platform, adapt the same notebooks and report; only Fabric is tested | ValueLens installer, or manual setup |
| **[3. Azure](3.%20Azure/README.md)** | Azure subscription and Power BI workspace; no Fabric | DataHub installer only; work in progress |

Older Power Automate + Dataverse and Local CSV setups are in [`archive/`](archive/).

<a id="before-you-start"></a>
<a id="installer"></a>

Before installing, check [prerequisites](docs/PREREQUISITES.md) and
[permissions](docs/PERMISSIONS.md). The [ValueLens installer](docs/INSTALL.md) covers
SharePoint and Fabric; Azure uses the separate installer linked in its route guide.
Installers are experimental: try a test environment first.

<a id="after-setup"></a>
<a id="the-power-bi-report"></a>
<a id="the-fabric-app-alternative"></a>

## Use and customise

[Read the report](docs/ValueLens-Report-Interpretation-Guide.pdf) ·
[How value is calculated](docs/METHODOLOGY.md) ·
[Customise ValueLens](docs/CUSTOMISE.md) ·
[Administrator security and privacy setup](docs/SECURITY-PRIVACY-SETUP.md)

For app hosting and sharing, follow your route guide. To look around without connecting data,
[download the sample app](app/download/ValueLens-App.html) using **Download raw file**,
then open it in Edge or Chrome. Its data is synthetic; it is not another setup route.

<a id="watch-first"></a>

[Watch the demo](https://youtu.be/P0uHJb13ZR0) ·
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
