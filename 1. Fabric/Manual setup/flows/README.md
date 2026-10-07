# Product feedback flow

[`Copilot_ProductFeedback_Email_to_OneLake.json`](Copilot_ProductFeedback_Email_to_OneLake.json)
saves an emailed Microsoft 365 Copilot product feedback export to `Files/product_feedback/`, so
you don't have to upload it by hand. You still export the file from the admin center yourself.

1. Import the flow into Power Automate. Set up its Outlook connection and email filter.
2. Set `OneLakeWorkspace`, `OneLakeLakehouse` and `TargetFolder`. Use `Files/product_feedback`, or
   `Files/analytics_hub_uploads` if you use the [installer](../../installer/README.md#data-sources-and-exports)'s
   drop folder. Or let the installer create this flow for you, as `Analytics Hub - Product
   feedback`: it reads the app's secret from Key Vault, and you only sign in to its connections.
   See [Power Automate flows](../../installer/README.md#power-automate-flows-optional).
3. Set the OneLake HTTP authentication to the `https://storage.azure.com/` audience. The identity
   needs write access to the Lakehouse. Don't put a secret in the flow definition.
4. Turn on `EnableProductFeedback` in the [pipeline](../pipelines/README.md#optional-sources), and
   set the report's `Enable_ProductFeedback` parameter to `Include`.