# ValueLens app

The ValueLens dashboard as an app (preview). It shows the same information as the Power BI report: every measure, chart and table, calculated with the same DAX rules ported to TypeScript. The layout is simpler, with seven data tabs and short sub-views instead of sixteen report pages.

Everything runs in the browser. The app reads your CSV files locally and calculates every number on the page. No data is sent anywhere.

## Get the app

None of these options needs a Power BI licence.

| Option | What you do | Best for |
|---|---|---|
| **Copilot Managed App** (recommended, preview) | Deploy it once with the `ms` CLI: see [As a Copilot Managed App](#as-a-copilot-managed-app). People open it at [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft). | Sharing it across your organisation. Each viewer needs a Power Apps Premium licence or Copilot Credits. |
| **Open it on your PC** | Open [`download/ValueLens-App.html`](download/ValueLens-App.html), choose **Download raw file**, then open the downloaded file in Edge or Chrome. Nothing to install. | Trying it out, or one person looking at the numbers. It works offline. |
| **Fabric App** (alternative) | Host it in your Fabric workspace: see [As a Fabric App](#as-a-fabric-app-in-a-fabric-workspace). | Tenants with Fabric capacity. |

The app opens with a labelled synthetic sample. To see your own numbers, choose **Change data** and drop in your CSVs (see [Data](#data)). The files are read in the browser and never leave your PC.

On the Fabric path, the Analytics Hub installer deploys a different app, the [Analytics Hub app](../1.%20Fabric/Fabric%20App/), which reads your semantic model live instead of CSV files.

## Tabs

| Tab | Views | Power BI pages it replaces |
|---|---|---|
| Adoption | Activation, Usage, Heatmap, Leaderboard | Activation, Adoption, Trend Heatmap, Leaderboard |
| Habits | — | Habit Formation |
| Agents | — | Agent Registry |
| Value | Tasks, Estimated value, Signal map | Task Breakdown, Estimated Value, Appendix: Signal - Impact Table |
| Fit | Cowork fit, Model fit | Cowork Fit, Model Fit |
| Readiness | Licences, Cowork | License Readiness and License Allocation (combined), Cowork Readiness |
| Feedback | — | User Feedback |
| Guide | — | Appendix: Glossary, plus the differences from Power BI |

Only the filters that apply to the current view are shown in the toolbar: dates, organisation, licence, tool, agent type, agent and creator. A filter that doesn't apply is cleared when you move to that view.

Each metric has an info button that shows its definition from the report's glossary.

The report's parameter tables are replaced by the **Assumptions** panel in the header. It holds the hourly rate, currency, licence price, effort scenario, Cowork grading and monthly licence cost. Changes apply to every tab straight away.

## Data

### Which files the app reads

The app reads the same CSV files as the **Local CSV** and **SharePoint** variants. Click **Change data** in the header and drop in the files. The app works out each file's type from its column headers.

| File | Detected by | Required | Local CSV / SharePoint file |
|---|---|---|---|
| Copilot interactions | `ThreadId` plus `Audit_UserId` or `Message_isPrompt` | Yes | `*_Interactions_*.csv` or `copilot_interactions_rollup.csv` |
| Organisation and licences | A user key (`PersonId` or `UserPrincipalName`), plus `Organization` or `Has License` | Recommended: needed for the organisation filter, licensed and unlicensed counts, and the Readiness tab | `*_Users_*.csv` or `copilot_users_rollup.csv` |
| Agent 365 registry | `Agent name` | Optional: needed for the Agents tab and agent lifecycle | `Agents365Registry.csv` or `agents_365.csv` |
| Product feedback | `Feedback Type` or `Feedback Id` | Optional: needed for the Feedback tab | `product_feedback.csv` |

The interactions file must be the **processed** output, not the raw Purview export. It needs the processor's derived columns, such as `Behavior_Enriched_Full`, `Value_Outcome`, `Expertise_Role`, `AI_Model`, `Agent_Type` and `License Status`.

These files were chosen because two of the variants already produce them, and the processor that writes them is shared by most of the others. That keeps one input format for every active variant.

### Getting the files from each variant

| Variant | How to get the CSVs |
|---|---|
| 5. Local CSV | Use the files you give the template: the processor's `*_Interactions_*.csv` and `*_Users_*.csv`, plus the optional agent and feedback exports. |
| 4. SharePoint + PAX | Download `copilot_interactions_rollup.csv`, `copilot_users_rollup.csv` and `agents_365.csv` from the SharePoint folder that `Upload-Rollups-SharePoint.ps1` writes to. |
| 1. Fabric | Export the Lakehouse tables to CSV from a notebook (for example `spark.table("copilot_interactions_curated").toPandas().to_csv(...)`). The curated table has the processor's columns. For the users file, export your org data with a UPN, `Organization` and `Has License`. |
| 2. Azure | The run job writes the same curated table to `curated/copilot_interactions_curated` and to Azure SQL, under the Fabric table names. Export it to CSV the same way, or run the Local CSV processor on a Purview export. |
| 3. Power Automate + Dataverse ([archived](../archive/3.%20Power%20Automate%20%2B%20Dataverse/README.md)) | The snapshot uses the Local CSV processor, but its Dataverse tables have prefixed column names. Run [`Purview_CopilotInteraction_Processor`](../5.%20Local%20CSV/scripts/) on a Purview audit export to get CSVs the app reads, and add `agents_365.csv` if you use one. |

### Sample data

The app opens with a synthetic sample. It is labelled **Sample data** in the header until you load your own files. `npm run dev`, `npm run build` and `npm run build:file` first run `scripts/prepare-sample.mjs`, which builds the sample in `public/sample/` from `5. Local CSV/sample-data`. Git ignores the generated files, so build the app from a full clone of the repo.

The sample registry has no `Total Users` column. Without it, agent lifecycle and usage review fall back to the users seen in the audit log. The same fallback applies to your own registry export if it lacks that column.

`scripts/extract-model-tables.py` re-extracts the glossary, the behaviour value map and the human time estimates from the report into `src/data/*.json`. Run it whenever those tables change in the `.pbit`.

## Differences from Power BI

The Guide tab lists these differences too.
- Treemaps, donuts and pies are shown as ranked bars or a single proportion bar.
- The activation chart is a two-sided bar.
- The values are unchanged.
- Report bookmarks and the page navigator are replaced by tabs and views.
- Behaviour charts on the agent lens hide agents with fewer than two users. This is a privacy floor.

## Develop

```powershell
npm install
npm run dev         # local dev server
npm run lint
npm run build       # type-check and build to dist/ (Fabric App and Managed App hosting)
npm run build:file  # build the single-file download to download/ValueLens-App.html
```

`download/ValueLens-App.html` is committed so people can download it. Whenever you change the app, run `npm run build:file` and commit the result. The single-file build inlines the code and styles and embeds the sample CSVs gzipped, so the page needs no server and makes no network calls.

The code is organised like this:
- `src/data/`: CSV loading, header detection and the report's reference tables.
- `src/metrics/`: the DAX port, one module per report area.
- `src/ui/`: the design kit.
- `src/pages/`: the tabs.

The design system is in [DESIGN.md](DESIGN.md) and the product brief is in [PRODUCT.md](PRODUCT.md).

## Deploy

The same `npm run build` output runs in two hosts. Pick one. Nothing in this repo deploys the app automatically.

### As a Copilot Managed App

This is the recommended host. It runs on Copilot Managed Runtime, which is in preview. The [main README](../README.md#start-here-the-app-preview) has the full steps, including the two admin settings and the licence each viewer needs.

In short: install Node.js 24.11 or later and the `ms` CLI (`npm install -g @microsoft/managed-apps-cli@0.29.0`, the version these steps were checked with). Then, from this folder:

```powershell
ms auth login
npm ci
ms app init -n "ValueLens" --repo none -b ./dist -S "npm run build"   # add -e <environment-id> if environment lookup times out
ms app deploy
ms app share alice@contoso.com,valuelens-viewers@contoso.com
```

`ms app init` writes `ms.config.json` with your tenant's app and environment IDs. The file is gitignored, so each deployer runs `ms app init` once. To update the app, run `ms app deploy` again. In Windows PowerShell, if running scripts is disabled, use `ms.cmd` and `npm.cmd`.

### As a Fabric App in a Fabric workspace

An alternative host, also in preview. You need a workspace on Fabric capacity (F2 or larger, or a trial; *My workspace* won't work) and the **Fabric Apps (preview)** tenant setting turned on. The project config is [`rayfin/rayfin.yml`](rayfin/rayfin.yml). The app keeps no server-side data, so only auth and static hosting are on.

```powershell
npx rayfin up --dry-run
npx rayfin up --tenant <tenant-id> --workspace-id <workspace-id> -y
```

It prints the item's portal link. People need access to the item (share it, or give them a workspace role) to open it. To update, run `npx rayfin up` again. The deploy state it writes (`rayfin/.deployments.json`, `rayfin/.env`) is gitignored.
