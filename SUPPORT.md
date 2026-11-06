# Support

ValueLens for Microsoft Copilot is an **experimental Power BI template**.
It is **not supported through Microsoft support channels**. Use this repository's
[GitHub issues](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues)
to ask for help, report bugs or suggest improvements. Assistance is best effort;
there is no guaranteed response time or support service-level agreement.

## Before opening an issue

Start with the [README](README.md), then follow the setup and troubleshooting
guidance for what you deployed:

- [1. SharePoint](1.%20SharePoint/README.md)
- [2. Fabric](2.%20Fabric/README.md), including the [Fabric App](2.%20Fabric/Fabric%20App/README.md)
- [3. Azure](3.%20Azure/README.md)

For app hosting, see [the app guide](app/README.md). The
[Power Automate + Dataverse](archive/3.%20Power%20Automate%20%2B%20Dataverse/README.md) and
[Local CSV](archive/5.%20Local%20CSV/README.md) standalone routes are archived and no longer maintained.

Search existing issues for the same symptom. For a new bug report, include:

- Deployment path, template filename and repository revision or download date.
- Power BI Desktop version, and whether the problem occurs in Desktop or Service.
- Whether you used the fabricated sample data or your own data.
- Optional sources enabled, relevant script/runtime versions, and steps to reproduce.
- Expected behaviour and the exact error message, with sensitive values removed.

Use a minimal fabricated example where possible. Do not post tenant exports,
credentials, user identities, prompts or private solution packages. Redact logs
and screenshots before sharing them.

<sub>Stuck? Create a support file and email it to us: run the installer with `--support-bundle`, or, without the installer, [`scripts/support_file.py`](scripts/support_file.py).</sub>

## Security and contributions

Do **not** report security vulnerabilities in public issues. Follow the private
reporting instructions in [SECURITY.md](SECURITY.md).

To propose a fix or documentation change, see [CONTRIBUTING.md](CONTRIBUTING.md)
and the [Code of Conduct](CODE_OF_CONDUCT.md).
