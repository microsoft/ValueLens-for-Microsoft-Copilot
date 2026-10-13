# web: Analytics Hub on Azure

`valuelens-web` is the Node 24 service for Analytics Hub on Azure. It serves the built SPA from `/app/public` (or `VALUELENS_PUBLIC_DIR`) and exposes the API on port `8080` (`PORT` overrides it).

## Routes

- `GET /app.config.json` returns Azure host configuration for the SPA and is never cached. Its `reporting` object carries the Value page's default currency and exchange rate from `VALUELENS_CURRENCY` (an ISO code, default `USD`) and `VALUELENS_EXCHANGE_RATE` (units of that currency per $1, optional). A currency or rate saved under **Prices** in the app overrides them.
- `GET /api/health` returns `{ "status": "ok", "version" }` for Container Apps probes.
- `POST /api/query` validates an Analytics Hub JWT, checks the configured semantic-model allow-list, acquires a Power BI OBO token, and proxies `executeQueries` JSON verbatim. It coalesces identical requests, caches per user for 10 minutes, limits each user to four upstream calls, and preserves 429 `Retry-After`.
- `POST /api/ask` answers a question (`{ question, history? }`) with Azure OpenAI, returning `{ answer, runs }`. It is on only when `VALUELENS_ASK_ENDPOINT` and `VALUELENS_ASK_DEPLOYMENT` are set, and then `/app.config.json` carries `ask: { mode: "chat" }`. The model can call only the named queries in `1. Fabric/Fabric App/src/ask/catalogue.json` (copied to `VALUELENS_ASK_DIR` in the image), never its own DAX. Each query runs through the `/api/query` path, as the signed-in user, with only date and organization filters applied. Groups under 5 people are left out before the model sees a row, and at most 50 rows go to the model. A question gets at most 8 queries; each user gets 20 questions per 10 minutes and 2 at once. The web app reaches the model with its managed identity, which needs **Cognitive Services OpenAI User**. Logs keep the question and the query names, never the answer or the data.
- `GET/PUT/DELETE /api/settings/:entity[/:id]` stores `CommercialTerms`, `ReportPack` and `TaskTime` rows in Azure Table Storage table `appsettings` using managed identity. Writes require `AnalyticsHub.Admin` unless `VALUELENS_SETTINGS_WRITERS=all`.
- `GET /api/version` compares `VALUELENS_VERSION` with the stable releases of `microsoft/ValueLens-for-Microsoft-Copilot` tagged `installer-v`, `analytics-hub-azure-v` or `v`.
- `GET/POST /api/delegations`, `DELETE /api/delegations/:id` and `POST /api/delegations/:id/approve` back scoped delegation in the Share panel when org-scoped access (row-level security) is on. They read and write `dbo.access_scope` in Azure SQL (`VALUELENS_SQL_SERVER`, `VALUELENS_SQL_DATABASE`) as the managed identity, writing only rows with `GrantedVia = 'share'`. The jobs' access step leaves those rows alone. Adding someone to the viewer group goes through Graph as the signed-in user. When they can't do that, the scope waits for an admin to approve it. After a change, the service refreshes the model's `Access Scope` table as the managed identity: at most one refresh waits per model. When RLS is off, `GET` returns `{ "enabled": false }`.
- Other GETs serve static assets, with SPA fallback to `index.html` for HTML navigation requests.

Security headers, including a Teams-compatible CSP `frame-ancestors`, are applied to all responses. The server intentionally does not set `X-Frame-Options`.

## Development

```powershell
cd "2. Azure/web"
npm.cmd install
npm.cmd test
```

The Dockerfile is intended to be built from the repository root and produces a non-root `node:24-alpine` image that builds the Fabric SPA and copies its `dist` into `/app/public`.
