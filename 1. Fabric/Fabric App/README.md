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
   - the app: *Run and interact* on the item (share it with a group once), not a workspace role
   - the data: **Build** on each model the app reads

   The installer does this with one group, **Analytics Hub Viewers**. By hand, add an `access`
   object to `fabric.config.json` so the app shows who to ask and links to the group:
   `{ "groupId": "<object id>", "groupName": "...", "contact": "you@example.com", "requestUrl": "https://..." }`
   (`requestUrl` is optional and must be https).

To update it, run `npx rayfin up` again.

The app also leaves out pages and sections whose optional data hasn't arrived. When it opens, it
counts the rows in the ValueLens model's optional sources (unfiltered). **Feedback** needs
`ProductFeedback` and **Work patterns** needs `M365 Activity`. Without registry data, **Governance**
shows how to connect the Agent 365 registry instead of empty sections, and the **Agents** leaderboard
drops its registry columns. Governance's **Shadow AI** section needs `Defender Status`, and says how to
turn Defender on without it; it doesn't depend on the registry. Newer installer builds also write which optional modules were switched
off into `fabric.config.json`; those pages stay hidden without probing until the admin turns the
module on. Everything shows while the check runs, or if it fails, and a page comes back on the next
open once its data loads.

## Settings in the app

Anyone who can open the app can change these, and the change applies for everyone. Share the item
only with people who should.

- **Rates & packs** (Consumption page): your pay-as-you-go rate, prepaid rate and Capacity Pack
  balance. Leave a box empty to keep the model's value.
- **Monthly budgets** (Consumption page): an optional monthly budget for Cowork / Work IQ, Copilot
  Studio and Azure, for the Budget runway section. Leave a box empty for no budget.
- **Prices** (Value page, Cost vs value): the Copilot licence price ($30 if empty), the reporting
  currency for the Value page (US dollars unless the installer set another) and, for any other
  currency, the exchange rate per $1.
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
`fabric.config.json` deployed next to the app. Newer files also include a `modules` block for the
optional module choices. A deploy from this folder uses `fabric.yaml` instead. See
[`src/lib/runtime-config.ts`](src/lib/runtime-config.ts).
[`AGENTS.md`](AGENTS.md) has the conventions for coding agents.