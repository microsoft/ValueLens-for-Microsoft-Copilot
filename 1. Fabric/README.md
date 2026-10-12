# Fabric: moved to Analytics Hub

The Fabric path, the Analytics Hub app and its installer now live in their own repo:
**[microsoft/AnalyticsHub-Dashboard](https://github.com/microsoft/AnalyticsHub-Dashboard)**.

- [Download the installer](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)
  and see [how to install on Fabric](https://github.com/microsoft/AnalyticsHub-Dashboard/tree/main/fabric#install).
- The manual set-up (notebooks, pipeline and `.pbit` templates) is in
  [`fabric/`](https://github.com/microsoft/AnalyticsHub-Dashboard/tree/main/fabric), and the app is in
  [`app/`](https://github.com/microsoft/AnalyticsHub-Dashboard/tree/main/app).
- Already installed? Open the newest installer and choose **Repair or change** to update. Nothing
  about your install changes because of the move.
- Installers up to 0.4.2 stay on
  [this repo's releases](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=installer-v).

The other paths here (3 Power Automate + Dataverse, 4 SharePoint, 5 Local CSV) are unchanged. See the
[main README](../README.md).