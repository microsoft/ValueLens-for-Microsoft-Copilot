# ValueLens app

The ValueLens dashboard as an app (preview). It shows the same numbers as the Power BI report,
with the same DAX rules ported to TypeScript, in seven tabs instead of sixteen pages.

It runs in the browser. Your CSV files are read on your PC, and no data is sent anywhere.

![The ValueLens app's Adoption tab, showing the built-in synthetic sample data](../Images/ValueLens-App-Adoption.png)

## Get the app

None of these needs a Power BI licence.

| Option | Best for | How |
|---|---|---|
| **Copilot Managed App** (recommended, preview) | Sharing it across your organisation | [Deploy it once](#as-a-copilot-managed-app). Viewers need Power Apps Premium or Copilot Credits. |
| **On your PC** | Trying it, or one person | Open [`download/ValueLens-App.html`](download/ValueLens-App.html), choose **Download raw file**, open it in Edge or Chrome. Works offline. |
| **Fabric App** (alternative) | Tenants with Fabric capacity | [Host it in a workspace](#as-a-fabric-app-in-a-fabric-workspace). |

It opens on labelled sample data. Choose **Change data** and drop in [your CSVs](#data) to see your own.

The Fabric installer deploys a different app, the [Analytics Hub app](../1.%20Fabric/Fabric%20App/),
which reads your semantic model live instead of CSV files.

## Deploy

The same `npm run build` output runs in either host. Nothing in this repo deploys it automatically.

### As a Copilot Managed App

The recommended host, on Copilot Managed Runtime (preview). You deploy it once with Microsoft's `ms`
tool. Deploying needs no licence; opening the app does (step 2).

1. **An admin allows CLI apps.** A Global or Power Platform Administrator opens the
   [Power Platform admin center](https://admin.powerplatform.microsoft.com) > **Copilot** >
   **Settings** > **Managed apps**. For your environment (or its group), they turn on both:
   - **Allow app creation with the Copilot Managed Runtime command line interface (CLI)**
   - **External artifacts in managed apps** (the app is built on your PC, then uploaded)

   Both are off by default. The `ms` tool uses your personal developer environment unless you pick
   another in step 5. See [Control whether apps can be created using the CLI](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#control-whether-apps-can-be-created-using-the-cli).

2. **Check viewers' licences.** Each viewer needs **Power Apps Premium** or **Copilot Credits**.
   The Power Apps rights in Microsoft 365 don't count, and no Microsoft 365 Copilot licence is needed.
   <details><summary>Using Copilot Credits</summary>

   An admin turns on usage-based billing in the [Microsoft 365 admin center](https://admin.microsoft.com)
   and adds viewers to a spending policy for managed apps. Each call the app makes, such as opening
   it, uses 0.1 credits. During the preview, someone with neither licence gets a warning, then is
   blocked after 20 operations or five minutes. See the
   [licensing FAQ](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq).

   </details>

3. **Install the tools:** [Node.js](https://nodejs.org/) 24.11 or later, [Git](https://git-scm.com/downloads),
   and the `ms` tool (these steps were checked with 0.29.0):

   ```powershell
   npm install -g @microsoft/managed-apps-cli@0.29.0
   ms --version
   ```

   If PowerShell says scripts are disabled, use `npm.cmd` and `ms.cmd` here and below.

4. **Sign in** to your viewers' tenant. (No browser on this PC? Use `ms auth login --device-code`.)

   ```powershell
   ms auth login
   ```

5. **Get the code and set up the app.**

   ```powershell
   git clone https://github.com/microsoft/ValueLens-for-Microsoft-Copilot.git
   cd ValueLens-for-Microsoft-Copilot/app
   npm ci
   ms app init -n "ValueLens" --repo none -b ./dist -S "npm run build"
   ```

   `--repo none` means you build on your PC, which is why step 1 needs the second setting.
   `ms app init` saves your tenant's IDs in `ms.config.json` (git ignores it, so each deployer runs
   it once). If it times out finding your environment, add `-e <environment-id>` from the
   environment's page in the Power Platform admin center.

6. **Deploy it.** This builds, uploads and publishes the app.

   ```powershell
   ms app deploy
   ```

   To update later: `git pull`, `npm ci`, then `ms app deploy` again.

7. **Share it** with people or groups (emails or Entra object IDs, comma-separated). Sharing gives
   access, not a licence. Or run `ms app share link create` for an org-wide link.

   ```powershell
   ms app share alice@contoso.com,valuelens-viewers@contoso.com
   ```

8. **Viewers open it** at [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft), choose
   **ValueLens**, then **Change data**, and pick their CSV files ([which files](#data),
   [where to get them](#getting-the-files-from-each-variant)).

> **Can Copilot do this for me?** A coding agent can run these steps, but it should deploy this code,
> not rewrite it. Cowork, Copilot Studio and coding agents build a *new*, untested app from a prompt.

### As a Fabric App in a Fabric workspace

An alternative host, also in preview. You need a workspace on Fabric capacity (F2 or larger, or a
trial; not *My workspace*) and the **Fabric Apps (preview)** tenant setting. The config is
[`rayfin/rayfin.yml`](rayfin/rayfin.yml); only auth and static hosting are on, as the app keeps no
server-side data.

```powershell
npx rayfin up --dry-run
npx rayfin up --tenant <tenant-id> --workspace-id <workspace-id> -y
```

It prints the item's portal link. Share the item (or give a workspace role) so people can open it.
To update, run `npx rayfin up` again. Its deploy state (`rayfin/.deployments.json`, `rayfin/.env`)
is gitignored.

## Data

### Which files the app reads

The same CSV files as the **Local CSV** and **SharePoint** paths. Choose **Change data** and drop
them in. The app tells each file's type from its column headers.

| File | Detected by | Needed? | Local CSV / SharePoint file |
|---|---|---|---|
| Copilot interactions | `ThreadId` plus `Audit_UserId` or `Message_isPrompt` | **Required** | `*_Interactions_*.csv` or `copilot_interactions_rollup.csv` |
| Organisation and licences | A user key (`PersonId` or `UserPrincipalName`), plus `Organization` or `Has License` | Recommended: organisation filter, licensed counts, Readiness tab | `*_Users_*.csv` or `copilot_users_rollup.csv` |
| Agent 365 registry | `Agent name` | Optional: Agents tab and agent lifecycle | `Agents365Registry.csv` or `agents_365.csv` |
| Product feedback | `Feedback Type` or `Feedback Id` | Optional: Feedback tab | `product_feedback.csv` |

The interactions file must be the **processed** output, not the raw Purview export. It needs the
processor's derived columns, such as `Behavior_Enriched_Full`, `Value_Outcome`, `Expertise_Role`,
`AI_Model`, `Agent_Type` and `License Status`. Two paths already produce these files, and most others
share the processor, so every active path has one input format.

### Getting the files from each variant

| Path | How to get the CSVs |
|---|---|
| 5. Local CSV | The processor's `*_Interactions_*.csv` and `*_Users_*.csv`, plus the optional agent and feedback exports. |
| 4. SharePoint + PAX | `copilot_interactions_rollup.csv`, `copilot_users_rollup.csv` and `agents_365.csv` from the folder `Upload-Rollups-SharePoint.ps1` writes to. |
| 1. Fabric | Export the Lakehouse tables from a notebook, e.g. `spark.table("copilot_interactions_curated").toPandas().to_csv(...)`. For users, export org data with a UPN, `Organization` and `Has License`. |
| 2. Azure | The run job writes the same curated table to `curated/copilot_interactions_curated` and Azure SQL. Export it the same way, or run the Local CSV processor on a Purview export. |
| 3. Power Automate + Dataverse ([archived](../archive/3.%20Power%20Automate%20%2B%20Dataverse/README.md)) | Its Dataverse columns are prefixed. Run [`Purview_CopilotInteraction_Processor`](../5.%20Local%20CSV/scripts/) on a Purview audit export instead, and add `agents_365.csv` if you use one. |

### Sample data

The app shows a synthetic sample, labelled **Sample data**, until you load your own files.
`npm run dev`, `build` and `build:file` first run `scripts/prepare-sample.mjs`, which builds it in
`public/sample/` from `5. Local CSV/sample-data` (git ignores the output, so build from a full clone).

The sample registry has no `Total Users` column, so agent lifecycle and usage review fall back to
users seen in the audit log. Your own registry export does the same if it lacks that column.

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

- **Filters:** only those that apply to the current view show (dates, organisation, licence, tool,
  agent type, agent, creator). One that doesn't apply is cleared when you switch.
- **Info buttons** show each metric's glossary definition.
- **Assumptions** (in the header) replace the report's parameter tables: hourly rate, currency,
  licence price, effort scenario, Cowork grading and monthly licence cost. Changes apply everywhere.

## Differences from Power BI

The Guide tab lists these too. The values are unchanged.

- Treemaps, donuts and pies are ranked bars or a single proportion bar.
- The activation chart is a two-sided bar.
- Tabs and views replace bookmarks and the page navigator.
- Behaviour charts on the agent lens hide agents with fewer than two users (a privacy floor).

## Develop

```powershell
npm install
npm run dev         # local dev server
npm run lint
npm test            # unit tests for the upload checks (Node 24, no install needed)
npm run build       # type-check and build to dist/ (Fabric App and Managed App hosting)
npm run build:file  # build the single-file download to download/ValueLens-App.html
```

`download/ValueLens-App.html` is committed so people can download it. After any app change, run
`npm run build:file` and commit the result. It inlines the code and styles and embeds the sample
CSVs gzipped, so it needs no server and makes no network calls.

`scripts/extract-model-tables.py` re-extracts the glossary, behaviour value map and human time
estimates from the report into `src/data/*.json`. Run it when those tables change in the `.pbit`.

| Folder | Holds |
|---|---|
| `src/data/` | CSV loading, header detection and the report's reference tables |
| `src/metrics/` | The DAX port, one module per report area |
| `src/ui/` | The design kit |
| `src/pages/` | The tabs |

Design system: [DESIGN.md](DESIGN.md). Product brief: [PRODUCT.md](PRODUCT.md).
