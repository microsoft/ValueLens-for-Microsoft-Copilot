# Product feedback flow

[`Copilot_ProductFeedback_Email_to_OneLake.json`](Copilot_ProductFeedback_Email_to_OneLake.json)
saves an emailed Microsoft 365 Copilot product feedback export to `Files/product_feedback/`, so
you don't have to upload it by hand. You still export the file from the admin center yourself.

1. Import the flow into Power Automate. Set up its Outlook connection and email filter.
2. Set `OneLakeWorkspace`, `OneLakeLakehouse` and `TargetFolder`. Use `Files/product_feedback`, or
   `Files/analytics_hub_uploads` if you use the [installer](../../installer/README.md#data-sources-and-exports)'s
   drop folder. Or let the installer create this flow for you, as `Analytics Hub - Product
   feedback`. See [Power Automate flows](../../installer/README.md#power-automate-flows).
3. Sign in to its **HTTP with Microsoft Entra ID (preauthorized)** connection: Base Resource URL
   `https://onelake.dfs.fabric.microsoft.com`, Resource URI `https://storage.azure.com`. The flow
   writes as that person, so they need Contributor or higher on the workspace. There's no secret,
   and no Key Vault connection.
4. Turn on `EnableProductFeedback` in the [pipeline](../pipelines/README.md#optional-sources), and
   set the report's `Enable_ProductFeedback` parameter to `Include`.