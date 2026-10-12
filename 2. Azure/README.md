# Azure: moved to Analytics Hub

The Azure-hosted path (Bicep, container jobs, the web app and the Teams app) now lives in its own repo:
**[microsoft/AnalyticsHub-Dashboard](https://github.com/microsoft/AnalyticsHub-Dashboard)**, in
[`azure/`](https://github.com/microsoft/AnalyticsHub-Dashboard/tree/main/azure).

- [Download the installer](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)
  and choose **Azure** when it asks where to install.
- Already installed? Open the newest installer and choose **Repair or change** to update. Your
  resources, images (`ghcr.io/microsoft/valuelens-jobs` and `valuelens-web`) and settings keep their names.

The other paths here (3 Power Automate + Dataverse, 4 SharePoint, 5 Local CSV) are unchanged. See the
[main README](../README.md).