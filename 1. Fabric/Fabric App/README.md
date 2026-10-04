# Analytics Hub app

The ValueLens dashboard as a web app in your Fabric workspace. The [installer](../installer/README.md)
deploys it for you. Use this folder only to deploy it by hand or to change it.

The app keeps no copy of your data. Each page queries the semantic model live, as the person
viewing it, so row-level security applies. How each figure is worked out is in the
[methodology](../../docs/METHODOLOGY.md).

## Deploy it by hand

You need:

- A published ValueLens semantic model from any path, 1 to 4.
- A workspace on Fabric capacity (F2 or larger, or a trial). *My workspace* won't work.
- The tenant settings **Fabric Apps (preview)** and **Semantic Model Execute Queries REST API** turned on.
- [Node.js 22.13 or later](https://nodejs.org/).

From this folder (`1. Fabric/Fabric App`):

1. Run `npm install`.
2. In [`fabric.yaml`](fabric.yaml), replace `workspaceId` and `itemId` under `vl` with your
   ValueLens model's IDs. They're in the model's URL:
   `app.powerbi.com/groups/<workspaceId>/datasets/<itemId>`. Do the same under `cc` for
   Consumption Central and `ae` for Agent Evaluator, or delete those blocks to hide their pages.
3. Deploy, and sign in when asked:
   ```powershell
   npx rayfin up --workspace-uri "https://app.fabric.microsoft.com/groups/<workspace-id>"
   ```
   Add `--tenant <tenant-id>` if your account spans tenants.
4. Open the **Fabric portal** link it prints. To call the item **Analytics Hub**, rename it in its
   settings.
5. Share it. Each person needs:
   - the app: Viewer on the workspace, or *Run and interact* on the item
   - the data: **Build** on each model the app reads

To update it, run `npx rayfin up` again.

## Settings in the app

Anyone who can open the app can change these, and the change applies for everyone. Share the item
only with people who should.

- **Rates & packs** (Consumption page): your pay-as-you-go rate, prepaid rate and Capacity Pack
  balance. Leave a box empty to keep the model's value.
- **Prices** (Value page, Cost vs value): the Copilot licence price ($30 if empty) and, if your
  model doesn't use $, the exchange rate.
- **Time per task** (Assumptions page): the minutes each task would take without Copilot.
  **Use research** puts them back.

The app saves these in a small SQL database under its item. The Power BI report doesn't see them.

## Change the app

| Task | How |
|---|---|
| Preview live | `npm run dev`, then open the app in Fabric with `&devUri=http://localhost:5173` on the URL |
| Test | `npm test` and `npm run lint` |
| Edit a query | `src/queries/<page>/`: a `.dax` query and a `.ts` definition per visual |
| Edit a page | `src/screens/<page>/` |

Don't commit your IDs in `fabric.yaml` or the redirect URI that `rayfin up` adds to
`rayfin/rayfin.yml`. Its local state files are gitignored.

The installer ships one build for every tenant, so it reads the model IDs from a
`fabric.config.json` deployed next to the app. A deploy from this folder uses `fabric.yaml`
instead. See [`src/lib/runtime-config.ts`](src/lib/runtime-config.ts).
[`AGENTS.md`](AGENTS.md) has the conventions for coding agents.