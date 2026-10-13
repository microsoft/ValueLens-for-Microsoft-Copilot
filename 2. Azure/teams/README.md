# teams: Analytics Hub tab package

This folder contains the Teams manifest template and package builder for Analytics Hub on Azure. The package contains:

- `manifest.json` using Teams manifest schema v1.17.
- `color.png` (192x192) and `outline.png` (32x32, white on transparent).
- A personal static tab at `https://<fqdn>/?host=teams`.
- A configurable team/group chat tab at `https://<fqdn>/?host=teams&config=1`.
- `webApplicationInfo` for Teams SSO with resource `api://<fqdn>/<clientId>` unless overridden.

Build a package with no dependencies:

```powershell
node build-package.mjs --client-id <guid> --fqdn <host> --version 0.1.0 --out AnalyticsHub-Teams.zip
```

The module also exports `buildTeamsPackage({ clientId, fqdn, appIdUri, version })`, returning a zip `Buffer` so the installer can generate the package in-memory.

## Give it to everyone

1. A Teams admin uploads `AnalyticsHub-Teams.zip` in the Teams admin center (**Teams apps** > **Manage apps** > **Upload new app**), which publishes it to your org's app catalog. People then find **Analytics Hub** under **Apps** > **Built for your org**.
2. Optionally, pin it for the viewers: in **Teams apps** > **Setup policies**, add the app to a policy's pinned apps and assign the policy to the **Analytics Hub Viewers** group.
3. To try it first, upload it as a custom app (**Apps** > **Manage your apps** > **Upload an app**).

The tab signs in with Teams SSO, so who can open it is the same as the web app: members of the viewer group, or anyone with the `AnalyticsHub.User` app role.
