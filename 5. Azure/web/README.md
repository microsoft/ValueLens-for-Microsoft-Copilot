# web: Analytics Hub on Azure (design)

One Node container (`valuelens-web`) serves the existing app's `dist` and a small API. The same bundle runs
on Fabric and Azure, and `/app.config.json` selects the host (plan section 3.1).

| Route | Behaviour |
|---|---|
| `POST /api/query` | Validates the user's token (audience `api://<fqdn>/<clientId>`, role *Analytics Hub User*). Gets a Power BI token **on behalf of** the user and calls `executeQueries`. Caches per user, keyed by the model's last refresh |
| `GET/PUT /api/settings` | `CommercialTerms` and `TaskTime` in Table Storage (`appsettings`). Writes need *Analytics Hub Admin* |
| `GET /api/version` | Installed version versus the latest release, for the "Update available" notice |
| `GET /api/health` | The liveness probe used by `infra/modules/containerapps.bicep` |

The OBO client assertion is signed with the user-assigned managed identity through a federated credential,
so no secret is needed. It listens on port 8080. This is not implemented yet; it's MVP work (plan section 7).
