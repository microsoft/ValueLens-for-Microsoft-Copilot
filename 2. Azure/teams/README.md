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
