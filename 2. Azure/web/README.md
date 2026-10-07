# web: Analytics Hub on Azure

`valuelens-web` is the Node 22 service for Analytics Hub on Azure. It serves the built SPA from `/app/public` (or `VALUELENS_PUBLIC_DIR`) and exposes the API on port `8080` (`PORT` overrides it).

## Routes

- `GET /app.config.json` returns Azure host configuration for the SPA and is never cached.
- `GET /api/health` returns `{ "status": "ok", "version" }` for Container Apps probes.
- `POST /api/query` validates an Analytics Hub JWT, checks the configured semantic-model allow-list, acquires a Power BI OBO token, and proxies `executeQueries` JSON verbatim. It coalesces identical requests, caches per user for 10 minutes, limits each user to four upstream calls, and preserves 429 `Retry-After`.
- `GET/PUT/DELETE /api/settings/:entity[/:id]` stores `CommercialTerms` and `TaskTime` rows in Azure Table Storage table `appsettings` using managed identity. Writes require `AnalyticsHub.Admin` unless `VALUELENS_SETTINGS_WRITERS=all`.
- `GET /api/version` compares `VALUELENS_VERSION` with stable GitHub release tags prefixed `analytics-hub-azure-v` or `v`.
- Other GETs serve static assets, with SPA fallback to `index.html` for HTML navigation requests.

Security headers, including a Teams-compatible CSP `frame-ancestors`, are applied to all responses. The server intentionally does not set `X-Frame-Options`.

## Development

```powershell
cd "2. Azure/web"
npm.cmd install
npm.cmd test
```

The Dockerfile is intended to be built from the repository root and produces a non-root `node:22-alpine` image that builds the Fabric SPA and copies its `dist` into `/app/public`.
