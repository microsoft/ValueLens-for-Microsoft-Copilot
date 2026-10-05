# teams: Analytics Hub tab with SSO (design)

The installer will generate `AnalyticsHub-Teams.zip` from a manifest template (v1.17 or later) with:
- A static personal tab and a configurable channel tab, both pointing at the web app's FQDN.
- `webApplicationInfo`: `{ id: <clientId>, resource: "api://<fqdn>/<clientId>" }`.
- `validDomains`: the Container Apps FQDN, or a custom domain.

On the app registration, the installer sets the identifier URI `api://<fqdn>/<clientId>` and pre-authorises
the Teams clients `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (desktop and mobile) and
`5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (web).

The app calls `authentication.getAuthToken()` and falls back to `authentication.authenticate()` when consent
or MFA is needed. The server performs the OBO to Power BI. The CSP `frame-ancestors` must allow
`teams.microsoft.com`, `*.teams.microsoft.com` and `*.cloud.microsoft`. This is Phase 2 work (plan section 6).
