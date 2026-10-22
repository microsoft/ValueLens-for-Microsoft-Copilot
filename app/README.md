# ValueLens: App Edition

A Copilot Managed App version of the ValueLens Power BI report. It shows the same information as the report: every measure, chart and table, calculated with the same DAX rules ported to TypeScript. The layout is simpler, with seven data tabs and short sub-views instead of sixteen report pages.

Everything runs in the browser. The app reads your CSV files locally and calculates every number on the page. No data is sent anywhere.

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

These files were chosen because two of the variants already produce them, and the processor that writes them is shared by most of the others. That keeps one input format for every variant.

### Getting the files from each variant

| Variant | How to get the CSVs |
|---|---|
| 5. Local CSV | Use the files you give the template: the processor's `*_Interactions_*.csv` and `*_Users_*.csv`, plus the optional agent and feedback exports. |
| 4. SharePoint + PAX | Download `copilot_interactions_rollup.csv`, `copilot_users_rollup.csv` and `agents_365.csv` from the SharePoint folder that `Upload-Rollups-SharePoint.ps1` writes to. |
| 3. Power Automate + Dataverse | The snapshot uses the Local CSV processor, but its Dataverse tables have prefixed column names. Run [`Purview_CopilotInteraction_Processor`](../5.%20Local%20CSV/scripts/) on a Purview audit export to get CSVs the app reads, and add `agents_365.csv` if you use one. |
| 1. Fabric | Export the Lakehouse tables to CSV from a notebook (for example `spark.table("copilot_interactions_curated").toPandas().to_csv(...)`). The curated table has the processor's columns. For the users file, export your org data with a UPN, `Organization` and `Has License`. |
| 2. Azure | The run job writes the same curated table to `curated/copilot_interactions_curated` and to Azure SQL, under the Fabric table names. Export it to CSV the same way, or run the Local CSV processor on a Purview export. |

### Sample data

The app opens with a synthetic sample in `public/sample/`. It is labelled **Sample data** in the header until you load your own files. To rebuild the sample from `5. Local CSV/sample-data`, run `node scripts/prepare-sample.mjs`.

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
npm run dev       # local dev server
npm run lint
npm run build     # type-check and build to dist/
```

The code is organised like this:
- `src/data/`: CSV loading, header detection and the report's reference tables.
- `src/metrics/`: the DAX port, one module per report area.
- `src/ui/`: the design kit.
- `src/pages/`: the tabs.

The design system is in [DESIGN.md](DESIGN.md) and the product brief is in [PRODUCT.md](PRODUCT.md).

## Deploy

Deployment is up to you, and nothing in this repo deploys the app automatically. You need the `ms` CLI, signed in to the target tenant.

`ms app init` writes `ms.config.json` with your tenant's app and environment IDs. The file is gitignored, so each deployer runs `ms app init` once.

```powershell
ms app init -n "ValueLens" --repo none -b ./dist -S "npm run build"   # add -e <environment-id> if environment lookup times out
ms app deploy
```
