# ValueLens and Consumption Central Fabric App

ValueLens and Consumption Central as a web app in your Fabric workspace, in the App Edition's
green design. It reads the products' published semantic models live: every figure comes from the
models' own DAX measures, queried at the grain each view needs, as the person viewing it, so
row-level security applies. The app keeps no copy of your data and never pulls raw rows.

One codebase deploys as three apps. Each is its own Fabric item, so all three can sit in one
workspace:

| Variant | Command | Fabric item id | Shows |
|---|---|---|---|
| `vl` | `npm run deploy:vl` | `valuelens-fabric-app` | ValueLens |
| `cc` | `npm run deploy:cc` | `consumption-central-fabric-app` | Consumption Central |
| `both` | `npm run deploy:both` | `valuelens-consumption-central` | Both, with a switcher in the band |

The joined app works with only one product installed: the missing product's switcher tab doesn't
show, and its pages and filters stay hidden. ValueLens pages that add a Consumption Central figure
(such as credits on the Executive summary) leave it out when that model isn't connected.

> **Kept in two repos.** This folder is copied byte-for-byte between
> `microsoft/ValueLens-for-Microsoft-Copilot` and `microsoft/ConsumptionCentral-for-Microsoft-Copilot`,
> both under `fabric-app/`. Change it in one repo, then copy the whole folder to the other in a
> matching pull request. Keep it product-neutral: no links or paths outside this folder.

## Getting around

A dark-teal band across the top has the product switcher (in the joined app) and the chosen
product's pages as tabs. Each page has a title, a segmented control for its sections, and its
filters. **Assumptions**, **Ask**, **Reports**, **Share** and the theme toggle sit at the top
right and keep the product you were on. Below 640 pixels wide the band stacks and its tabs scroll
sideways. [`DESIGN.md`](DESIGN.md) has the design system and [`PRODUCT.md`](PRODUCT.md) who it's
for and which page shows what.

## Before you deploy

- The product's semantic model, published to a Fabric workspace by its installer or by hand from
  its Fabric template (`ValueLens - Fabric.pbit`, `Consumption Central - Fabric.pbit`).
- A workspace on Fabric capacity (F2 or larger, or a trial) to deploy into. *My workspace* won't work.
- The tenant settings **Fabric Apps (preview)** and **Semantic Model Execute Queries REST API**
  turned on.
- [Node.js](https://nodejs.org/) 24.15 or later, or 22.22 or later, and a Fabric sign-in that can
  create items in the workspace.

## Deploy

From this folder:

```powershell
npm install
npm run deploy:both -- --workspace-uri "https://app.fabric.microsoft.com/groups/<workspace-id>/list"
```

Use `deploy:vl` or `deploy:cc` for a single product. Add `--dry-run` first to see which models it
found and what `rayfin up` would do, without deploying. Sign in when asked, then open the
**Fabric portal** link it prints.

The script:

1. **Finds the models** in the target workspace through the Fabric REST API, by name:

   | Product | A model matches when its name is | or starts with | or contains |
   |---|---|---|---|
   | ValueLens | `Analytics Hub Model`, `ValueLens Model`, `ValueLens - Fabric`, `ValueLens - Fabric OneLake` | `Analytics Hub Model`, `ValueLens` | ` - ValueLens`, as in `<owner> - ValueLens (sample)` |
   | Consumption Central | `Analytics Hub Consumption Model`, `ValueLens Consumption Model`, `Consumption Central - Fabric` | those, or `Consumption Central` | ` - Consumption Central` |

   Names are matched ignoring case, and consumption models never count as ValueLens. When
   exactly one model matches, it is used. When several match, the script never picks one: it
   lists them and asks which to use, or, with `--yes` or no terminal to ask in, stops and asks
   you to name it. Name a model yourself with
   `--vl-model <id>` or `--cc-model <id>` (the id is in its URL:
   `app.powerbi.com/groups/<workspaceId>/datasets/<itemId>`), and add
   `--model-workspace-id <id>` when the models live in another workspace. A single-product app
   stops if its model isn't found; the joined app deploys with whichever it finds.
2. **Writes `public/fabric.config.json`** with the variant and the models it found, keeping any
   other keys already in that file (see [Optional settings](#optional-settings)).
3. **Runs `rayfin up`** with the variant's own item id and deployment record, so the three
   variants never update each other's item. The build bakes the variant in. Each variant's record
   is kept in `rayfin/.variants/<variant>/` (gitignored); running the same command again updates
   that item.
4. **Puts back** `rayfin/rayfin.yml`, `public/fabric.config.json` and `.env.local` as they were.

| Option | |
|---|---|
| `--variant <vl\|cc\|both>` | Which app. The `deploy:*` scripts set it. |
| `--workspace-uri <url>` or `--workspace-id <id>` | The workspace to deploy into. |
| `--vl-model <id>`, `--cc-model <id>` | A model to use instead of finding one by name. |
| `--model-workspace-id <id>` | Where those models live, when not the target workspace. |
| `--data-agent <id>` | A Fabric data agent in the target workspace for the **Ask** page. |
| `--tenant <id>` | Your Entra tenant, when your account spans several. |
| `--token <token>` | A Fabric API token for finding the models. Otherwise it uses `FABRIC_TOKEN`, your `rayfin` sign-in, then the Azure CLI. |
| `--dry-run`, `-n` | Find the models and preview `rayfin up` without deploying. |
| `--yes`, `-y` | Accept `rayfin`'s prompts. |

The app can't look the models up itself: in Fabric it can only run DAX against the models it was
deployed with. So the script finds them at deploy time; deploy again after replacing a model.

## Share it

Each person needs:

- the app: *Run and interact* on the item (share it with a group once), not a workspace role;
- the data: **Build** on each model the app reads.

Queries run as the person viewing, so the models' row-level security decides what they see.

## Optional settings

Put any of these in `public/fabric.config.json` before you deploy; the script keeps them. The file
is gitignored, so your tenant's values stay out of the repo.

- `"access": { "groupId": "<object id>", "groupName": "...", "contact": "you@example.com", "requestUrl": "https://..." }`:
  who to ask for access, shown when someone can't read the data. `requestUrl` is optional and
  must be https.
- `"modules": { ... }`: optional ValueLens sources your install left off, so their pages stay
  hidden without probing (see [`src/lib/runtime-config.ts`](src/lib/runtime-config.ts)).
- `"reporting": { "currency": "EUR", "exchangeRate": 0.92 }`: the reporting currency for the
  Value page before anyone changes it in the app.

**Ask** links to a Fabric data agent over the same models: create one in the target workspace,
then deploy with `--data-agent <id>`. Data agents need a paid Fabric capacity (F2 or larger, or
Power BI Premium) and the tenant settings for Copilot and data agents. Without one, the page
lists the kinds of questions it answers.

## Optional data

The app leaves out ValueLens pages and sections whose optional data hasn't arrived. When it opens,
it counts the rows in the ValueLens model's optional sources (unfiltered), in one query.
**Feedback** needs `ProductFeedback` and **Work patterns** needs `M365 Activity`. Without
registry data, **Governance** shows how to connect the Agent 365 registry instead of empty
sections, and the **Agents** leaderboard drops its registry columns. Governance's **Shadow AI**
section needs `Defender Status`. Everything shows while the check runs, or if it fails, and a page
comes back on the next open once its data loads.

## Bounded detail lists

Person and registry detail lists return the top 1,000 rows, with deterministic tie-breakers.
Consumption's Studio agent list follows the same limit. Sorting or filtering inside a grid acts on
those returned rows; use the page filters to query another selection. Truncation notices identify
omitted rows and flag unavailable full counts rather than substituting the displayed row count.

Group and grand totals still cover the full filtered population, including groups whose people are
outside the cap. Leaderboard and Studio concentration are computed across all person rows;
Leaderboard returns only the top 1%, 5% and 25% cuts. Value by habit returns whole-population
habit totals and concentration cuts, not a truncated person list. Agent spotlights return
full-population maxima and tie counts with two named winners.

## How pages load

The app is built to stay quick for a large tenant (about 20,000 people):

- **The last 12 weeks by default on a large tenant.** When more than 10,000 people have Copilot
  activity, the ValueLens date filter starts at **Last 12 weeks**; **Show all dates** widens it in
  one click. A smaller tenant starts on **All dates**. Consumption Central keeps every date until
  you choose a range. `LARGE_TENANT_PEOPLE` in `src/lib/filters.ts` sets the threshold.
- **One tab at a time.** Each page shows one section at a time, and opening a tab runs only that
  tab's queries. Downloads and report packs still include every section.
- **Long lists wait for a click.** Leaderboard rankings and by-organization and by-person lists
  load when you choose **Show …**. The cards above them still count everyone.
- **The next pages load in the background**, one query at a time, and wait whenever the page on
  screen is loading. `PREFETCH` in `src/components/prefetcher.tsx` turns this off.
- **A busy model slows down on its own.** If Power BI throttles a model, only that model's queries
  back off (1, 2, 4, 8, then 15 seconds, for up to a minute), then the card shows **Power BI is
  busy** with **Try again**. Cards ask again by themselves once the model answers. The browser
  console logs each step (`Fabric app: …`).
- **Results last for the visit.** Up to 1,000 results stay in memory for up to an hour. Nothing is
  kept between opens.

## Settings in the app

Anyone who can open the app can change these, and the change applies for everyone in that app.
Share the item only with people who should.

- **Rates & packs** and **Monthly budgets** (Consumption): your pay-as-you-go and prepaid rates,
  Capacity Pack balance, and optional monthly budgets for the Budget runway.
- **Prices** (Value, Cost vs value): the Copilot licence price, the reporting currency and its
  exchange rate.
- **Time per task** (Assumptions): the minutes each task would take without Copilot.

The app saves these in a small SQL database under its item. The Power BI reports don't see them.

## Reports

**Reports** at the top right lists report packs: named, ordered lists of sections from any page.
The built-in packs can't be edited, but **Save a copy** starts your own. **Download PDF** and
**Download PowerPoint** are on every page and pack, with the filters and the date the data runs
to; **Download CSV** is on each chart and table.

## Change the app

| Task | How |
|---|---|
| Preview live | `npm run dev` (add `-- --mode vl` or `-- --mode cc` for one product), then open a deployed item in Fabric with `&devUri=http://localhost:5173` on the URL |
| Test | `npm test` and `npm run lint` |
| Build a variant | `npm run build -- --mode vl` (or `cc`, `both`) |
| Edit a query | `src/queries/<page>/`: a `.dax` query and a `.ts` definition per visual |
| Edit a page | `src/screens/<page>/` |
| Change the variants | `src/lib/app-variant.ts` and `VARIANTS` in `scripts/deploy.mjs` |

`fabric.yaml` holds placeholders for local builds and tests; deploys use `public/fabric.config.json`.
Don't commit IDs or the redirect URI that `rayfin up` adds to `rayfin/rayfin.yml`. Never deploy
with the item id `valuelens`: an older app uses it. [`AGENTS.md`](AGENTS.md) has the conventions
for coding agents.
