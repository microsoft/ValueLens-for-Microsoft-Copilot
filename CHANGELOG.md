# Changelog

Notable, reviewed changes to the ValueLens templates, notebooks and helper scripts.

This file starts here. Everything before the first entry below lives in `git log` and the
pull-request history — this repo shipped for a while before anyone thought to write the
changes down in one place, and back-filling that accurately from commit messages would be a
worse record than pointing you at the commits themselves.

Deployment instructions do **not** live here. They live in the READMEs:
[the app](app/README.md) ·
[1. Fabric](1.%20Fabric/README.md) ·
[1. Fabric/Fabric App](1.%20Fabric/Fabric%20App/README.md) ·
[2. Azure](2.%20Azure/README.md) ·
[4. SharePoint](4.%20SharePoint/README.md) ·
[5. Local CSV](5.%20Local%20CSV/README.md). The archived
[Power Automate + Dataverse](archive/3.%20Power%20Automate%20%2B%20Dataverse/README.md) path keeps its own.

---

## Unreleased — The app comes first, and Power Automate + Dataverse is archived

**Why.** The app is now the recommended way to use ValueLens, so the README starts with it and has
every step to deploy it. Archiving the Power Automate + Dataverse path leaves fewer paths to choose
between and keep up to date.

- **The README starts with the app (preview).** Numbered steps cover the two Power Platform admin
  settings, the licence each viewer needs (Power Apps Premium or Copilot Credits), installing the
  `ms` CLI at the version the steps were checked with (0.29.0), then `ms auth login`,
  `ms app init`, `ms app deploy` and `ms app share`. Then come where your data comes from, the
  Power BI report, the Fabric App (alternative) and Archived. The list of agents the audit log
  covers moved to [docs/AUDIT-LOG-COVERAGE.md](docs/AUDIT-LOG-COVERAGE.md). Nothing was removed,
  and links to the old `#app-edition-preview`, `#pick-a-path` and `#watch-first` sections still
  work.
- **"App Edition" is now "the app".** The footer, the data dialog, the app README, PRODUCT.md and
  DESIGN.md say so, and `app/download/ValueLens-App.html` was rebuilt. The Fabric App deploy keeps
  `id: valuelens-app-edition` in `app/rayfin/rayfin.yml`, so redeploying still updates the existing
  item instead of creating a second one.
- **Power Automate + Dataverse moved to
  [`archive/3. Power Automate + Dataverse/`](archive/3.%20Power%20Automate%20%2B%20Dataverse/README.md).**
  Installs you already have keep running, but the path is unsupported and no longer gets dashboard
  changes. A README at the old path links to the new one, and a `.gitignore` there keeps the files
  an earlier run left behind out of git. If a scheduled task runs the refresh from a clone, point it
  at `archive\3. Power Automate + Dataverse\scripts\Invoke-DataverseCoreRefresh.ps1` after you
  pull.
- **Template scripts and tests skip the archive.** `Update-Template-Refresh-Sources.py`,
  `Update-Template-Dax.py` and `Update-Model-Refresh-Fixes.py` no longer patch the archived
  template. The template tests already skipped `archive/`, so two minimum counts in them went down.
- **CONTRIBUTING** says report and app changes go to the app and the active paths only, and that
  nothing in `archive/` is maintained.

---

## Unreleased — Fabric App: large tenants open on the last 12 weeks

**Why.** On a large tenant, the first pages took several seconds because every query read every
date. Measured at 20,000 people, a three-month window made the Adoption summary about 30% quicker
and drilling from an organization to a person about 15% quicker. The gain should grow with the
tenant.

- **Large tenants start on Last 12 weeks.** When more than 10,000 people have Copilot activity, the
  date filter starts on the 12 weeks up to the last day with activity, not today. Smaller tenants
  still start on **All dates**.
- **No wait.** Each query works out the tenant's size and the 12 weeks in the model itself, so the
  first queries don't wait for the filter choices to load. Nothing is asked again when they arrive.
- **The filter bar says so.** It shows *Last 12 weeks* with its dates, notes that it's the default
  for large organizations, and has a **Show all dates** button. Until the filter choices load, it
  says *Default dates*.
- **Reset filters** (was **Clear filters**) goes back to where the tenant starts: the last 12 weeks
  on a large tenant, all dates on a small one.
- The Executive summary's range and the filters listed in PDF and PowerPoint downloads use the same
  dates. Cost vs value already uses the days with activity inside the date filter, so on a large
  tenant it compares the same 12 weeks.
- The Azure host serves the same app, so it gets this too. The Power Automate + Dataverse,
  SharePoint and Local CSV paths have no app and don't change.

Redeploy the app to pick this up, in the same way as the cache entry below. The models don't
change. The AnalyticsHub app made the same change in microsoft/AnalyticsHub-Dashboard#177.

---

## Unreleased — Shorter refreshes: Consumption Central cohorts, Lakehouse compaction, Agent Evaluator columns

**Why.** On a large tenant, refresh time grew much faster than the number of users. These changes
cut work the refresh didn't need to do. The results are the same. Mirrored from Analytics Hub.

- **Consumption Central, all four versions (Fabric, Power Automate + Dataverse, SharePoint / Viva
  Direct, Local CSV).** The Studio and GitHub usage intensity groups (`Group By`) find each
  percentile cut once instead of ranking every user against every other user. `Weeks Ago` no longer
  looks up the latest week separately for every row. The Cowork usage cohorts are now worked out
  in the `CoworkBilling` query, which sorts the credits once and compares each user with five cut
  values, instead of ranking every user for every user. `UsageCohortRank` keeps its name and is
  still what `UsageCohort` sorts by. `Weeks Active` and `Weeks Over Limit` are unchanged. Azure
  builds its Consumption Central model from the Fabric template, so it gets this too.
- **Fabric notebooks compact what they wrote.** The Microsoft 365 activity ingester and the Agent
  Evaluator transcript parser now run `OPTIMIZE ... VORDER` once at the end of each run, on the
  tables that run wrote. Daily and incremental writes no longer pile up small files that slow down
  refresh. A failed compaction is reported and the load still succeeds. Set `RUN_OPTIMIZE = False`
  to turn it off. Azure has no Delta tables and doesn't change.
- **Agent Evaluator loads eight fewer columns.** Nothing in the report read them: error messages,
  the 500-character transcript preview, the first and last bot messages, and the variable copies
  other than the user's UPN (which **Unique Users** counts). Refresh reads less and the model is
  smaller. A source that still has the columns loads as before.

How much time this saves hasn't been measured on a large copy yet. The new `CoworkBilling` query
steps were checked offline in Power BI Desktop, but the full query hasn't been refreshed against a
lakehouse. The changes are applied by
`scripts/Update-Model-Refresh-Fixes.py` (`--check` reports templates that need it). **Repair or
change** deploys the updated models and notebooks; refresh the models afterwards. On the Power
Automate + Dataverse, SharePoint and Local CSV paths, open the new Consumption Central template.

---

## Unreleased — Fabric App: pages you go back to open from the cache

**Why.** The app keeps query results in memory while it's open, but only the SDK's default of 64.
It has well over a hundred distinct queries (128 `.dax` files alone), so by the time you went back
to a page its results had usually been pushed out, and every query on it ran again.

- **Up to 1,000 results, each for up to an hour.** A page you've seen in the same visit opens again
  without asking the model. A result held longer than an hour is fetched again, so in a tab left open
  all day, going back to a page picks up the model's refresh within the hour. Before, a result that
  stayed among the last 64 was used however old it was.
- **Errors aren't reused.** If the cache kept an error, such as *Data not loaded yet*, the app asks
  the model again rather than show it, both on a page you go back to and on **Try again**. Before,
  **Try again** could show the kept error again straight away.
- Nothing is kept between opens: closing or reloading the app clears it. As before, results stay in
  the browser tab that asked for them. The time this saves hasn't been measured.
- The Azure host serves the same app, so it gets this too. The Power Automate + Dataverse,
  SharePoint and Local CSV paths have no app and don't change.

Redeploy the app to pick this up. On Fabric, choose **Repair or change** in the installer, or run
`npx rayfin up` if you deployed it by hand. On Azure, **Repair or change** with the next installer
pulls a `valuelens-web` image that has it. The models don't change.

---

## Unreleased — UserMonthMetrics no longer fails on blank and whitespace-only user IDs

**Why.** In the Power Automate + Dataverse, SharePoint and Local CSV templates, `UserMonthMetrics` has a row per
user ID and month, keyed `<user ID>|yyyy-MM`. Power BI stores a whitespace-only user ID as an empty string, so in
a month with both a blank and a whitespace-only ID, two rows got the key `|yyyy-MM`. The refresh then reported
"contains a duplicate value '|yyyy-MM'" and left the table empty. Any query that used the audit table's
`User_Stage_Maturity` column then failed, such as the stage filters on the Task Breakdown charts.

- `UserMonthMetrics` now leaves out blank and whitespace-only user IDs, as the active-user counts do. No audit
  row related to those rows anyway: the audit table's own key is blank for a blank ID and keeps the whitespace
  of a whitespace-only one. So no user's stage changes.
- On synthetic data the table lost only its 3 blank and whitespace-only rows. The other 43,311 rows were
  unchanged, and so was the stage on all 1,372,709 audit rows. With a blank and a whitespace-only ID in the same
  month, the old table failed to refresh and the new one refreshed cleanly.
- The table refreshes as fast as before: 2.15 s against 2.16 s with 20,000 synthetic users.
- The Fabric templates don't have this table and are unchanged. `scripts/Update-Template-Dax.py` writes the new
  definition, and `tests/test_template_dax_fixes.py` checks it.

---

## Unreleased — Faster habit-stage counts

**Why.** The eight habit-stage counts, `[Beginner Users, Last Month]` and `[Beginner Users (Monthly)]` and the
same pairs for Developing, Habitual and Power users, counted each user's active days one user at a time. They
feed the Habit Formation page and the Fabric App's habit figures, and 6 other measures use them.

- All five ValueLens templates now count every user's active days in one `SUMMARIZECOLUMNS`, then count the
  users in each band. The bands don't change (Beginner 1–5 active days, Developing 6–10, Habitual 11–15,
  Power 16 or more), and blank user IDs count as they did before. Where user IDs are filtered directly, the
  eight measures still check each user.
- The numbers don't change. On synthetic data, old and new matched in 209 filter contexts, and so did the
  6 measures built on them, in 23 contexts including a row per user. Names, format strings, display folders
  and descriptions are unchanged.
- In Power BI Desktop with 20,000 synthetic users and an empty cache, the monthly stage chart took 0.40 s
  instead of 0.52 s, the stage table by department and month 0.32 s instead of 0.40 s, and the Fabric App's
  habit-by-month query 0.68 s instead of 0.93 s. Tables with a row per user still check each user, so they
  take about as long as before.
- **Needs the June 2024 or later Power BI engine**, because the new definitions use `SUMMARIZECOLUMNS` inside
  a measure. The Power BI service and Fabric are up to date. Power BI Desktop releases before June 2024 show
  errors in most habit-stage visuals, so update Desktop before opening a template.
- `scripts/Update-Template-Dax.py` writes the new definitions, and `tests/test_template_dax_fixes.py` checks them.

---

## Unreleased — Faster agent, unlicensed and Cowork user counts

**Why.** `[Active Agent Users]`, `[Active Unlicensed Users]`, `[Cowork Users]` and `[Cowork Fit: Eligible Users]`
checked each user ID one at a time, like the two counts in "Faster active-user counts" below. They feed the
agent, unlicensed-use and Cowork pages, and 17 other measures use them.

- All five ValueLens templates now count these users in one pass, as `[All Active Users]` does: the user IDs
  with prompt rows (agent users) or usage rows (unlicensed and Cowork users), less any blank or
  whitespace-only IDs. Where user IDs are filtered directly, the four measures still check each user.
- `[Cowork Fit: Eligible Users]` leaves out everyone who has used Cowork, whatever the filters. It now counts
  the IDs with prompt rows in one pass over a list of user IDs without the Cowork users and the blank or
  whitespace-only IDs.
- The numbers don't change. On synthetic data, old and new matched in 152 filter contexts, and so did the
  17 measures built on them, in 17 contexts including a row per user. Names, format strings, display folders
  and descriptions are unchanged.
- In Power BI Desktop with 20,000 synthetic users and an empty cache, the Cowork Fit chart by department took
  0.4 s instead of 2.4 s, the unlicensed chart by department 0.5 s instead of 1.0 s, and the 17 dependent
  measures 1.8 s instead of 4.5 s. Tables with a row per user still check each user, so they gain less.
- `scripts/Update-Template-Dax.py` writes the new definitions, and `tests/test_template_dax_fixes.py` checks them.

---

## Unreleased — SharePoint refresh works with PAX v1.11.15

**Why.** PAX purview-v1.11.15, the current release, renamed the ValueLens rollup's `-Dashboard` value
from `AIBV` to `ValueLens` and rejects `AIBV`. `Run-PAX-AIBV.ps1` downloads the latest release by
default and passed `-Dashboard AIBV`, so the SharePoint refresh stopped before PAX started.

- [`Run-PAX-AIBV.ps1`](4.%20SharePoint/scripts/Run-PAX-AIBV.ps1) now reads the `-Dashboard` values
  from the downloaded PAX script without running it. It passes `ValueLens` to v1.11.15 and later and
  `AIBV` to v1.11.5 to v1.11.14, so a pinned `-PaxReleaseTag` still works. A release before v1.11.5
  stops with a clear error. The run prints the value, and `rollup-manifest.json` records it as
  `pax_dashboard`.
- Both names build the same rollup (`--profile aibv`), so the output files, the uploaded file names and
  the templates don't change. The script, the `AIBV-Rollup-Refresh` task and the output files keep
  their names.
- The [Azure Container Apps notes](4.%20SharePoint/azure-container/README.md) and the
  [Azure-hosted plan](docs/plans/AZURE-HOSTED-PLAN.md) now say `-Dashboard ValueLens`, and the worked
  example uses a 1.11.15 image.
- `tests/test_sharepoint_pax_dashboard.py` checks the choice against param blocks shaped like each
  PAX release.

---

## Unreleased — Faster active-user counts

**Why.** `[All Active Users]` and `[Active Licensed Users]` checked each user ID one at a time, which is
slow on a large tenant. 21 measures use them directly and 41 in all, so most pages waited on them.

- All five ValueLens templates now count the user IDs with usage rows in one pass, less any blank or
  whitespace-only IDs. It's the approach Analytics Hub took in `microsoft/AnalyticsHub-Dashboard` #118.
- Where user IDs are filtered directly (a row per user, a user slicer, or a selection that pairs users
  with another field), the two measures still check each user, because only there could the counts differ.
- The numbers don't change. On synthetic data, old and new matched in 98 filter contexts, and so did the
  41 measures built on them. Names, format strings, display folders and descriptions are unchanged.
- In Power BI Desktop with 20,000 synthetic users and an empty cache, a monthly trend took 0.2 s instead
  of 2.3 s, the 41 dependent measures 1.8 s instead of 12.8 s, and the report's department-by-user tables,
  fully expanded, about 4.4 s instead of 8–9 s.
- `scripts/Update-Template-Dax.py` writes the new definitions, and `tests/test_template_dax_fixes.py`
  checks them.

---

## Unreleased — Manual setup is the main Fabric path

**Why.** The installer is still changing, so production setups should use the manual steps.

- [1. Fabric](1.%20Fabric/README.md) leads with the manual setup: the notebooks, the pipeline and the
  Power BI report. The installer has its own section, marked as a work in progress.
- The root README, the manual setup and notebooks READMEs, the installer README, the
  [checklist](docs/PREREQUISITES.md) and [2. Azure](2.%20Azure/README.md) say the same. Azure is set
  up only by the installer, so it's a work in progress too.

---

## Unreleased — Fabric and Azure paths are back

**Why.** Analytics Hub (paths 1 and 2) moved to its own repo, `microsoft/AnalyticsHub-Dashboard`,
for installer 0.5.0. It's back here, in its original folders, with everything made there since.

- [1. Fabric](1.%20Fabric/) and [2. Azure](2.%20Azure/) are back, with the installer, the Fabric App,
  the Azure jobs and web app, and `shared/python`, as they were before the move.
- They're up to date with installer 0.5.1 and the changes below.
- The installer's update check and the Azure web app's update banner read this repo's releases.

---

## Unreleased — Prerequisites and questions

Findings F8, F12, F13 and F14 from the newcomer self-serve test of installer 0.4.2.

### Changed: the prerequisite check covers more, in plainer words

**Why.** A newcomer couldn't tell from the list whether they had what the flows and the Cowork
credits need, and "PIM-eligible" meant nothing to them.

- New optional rows: **Microsoft 365 Copilot licences in the tenant**, **Power Automate Premium**
  (for whoever signs in to the flows) and the **Viva Insights analyst** role, which can't be
  checked, so it says how to get it.
- The Fabric administrator row says it's only needed if the tenant settings are off. A role you
  can activate says so, with a link to Privileged Identity Management.
- The check now records whether you can assign directory roles (Global Administrator or
  Privileged Role Administrator), as `canAssignDirectoryRoles`.

### Changed: the questions explain themselves

**Why.** Defaults were picked by name, not by what the tenant uses, and some choices didn't say
what they cost or need.

- The Power Platform environment defaults to the tenant's default environment, with a note on
  DLP, Power Automate Premium and who can see the flows.
- The capacity question recommends F64 or larger for more than 10,000 people, and shows each
  capacity's SKU and region.
- A new install names the workspace `Analytics Hub` and the Lakehouse `Analytics_Hub`. Existing
  installs keep `ValueLens`.
- The Azure target is described in plain words.
- Cowork credits ask first whether you have the Viva Insights query IDs. **Not yet** uses the CSV
  export until you add them. The partition ID is prefilled with the tenant ID.
- The Copilot Studio, Cowork and Azure AI cards sit under **Credit consumption**, and their hints
  say what each needs.
- **Ready to set up** lists the costs that apply, with links to the pricing pages.

### Fixed: an access contact from another tenant

**Why.** A record carried over from another tenant kept an outside address as the person to ask
for access.

- If the saved contact isn't on one of the tenant's verified domains, it's reset to you, with a
  note.
- The request-access link question says what it's for.

---

## Unreleased — Install record and launch

**Why.** In a newcomer self-serve test of installer 0.4.2, an install record for a deleted
workspace kept showing **Manage Analytics Hub**. Nothing said where the record was or how to start
again. A closed page couldn't be reopened without the printed link, the PC could sleep mid-setup,
and some text named internal tools.

- **A record whose workspace has gone.** After sign-in, the installer checks that the record's
  workspace still exists. If Fabric says it doesn't, or the record is for another tenant, the home
  page says so and offers **Start fresh** or **Keep this record**. Start fresh renames the record to
  `valuelens-install.<yyyyMMdd-HHmmss>.json` beside it. A network error or a 403 changes nothing.
  In the terminal, `install` asks whether to start fresh; other commands stop and say how.
- **Where the record is.** **Manage Analytics Hub** shows the record's full path, and notes that
  OneDrive may sync it.
- **Reopen the page.** The installer's window says to press **Enter** to open the page again. A
  page opened without the link says to do that.
- **Keep awake.** The exe stops Windows going to sleep while it runs. The plan says to keep the
  PC plugged in and awake until setup finishes.
- **Wording.** The web page says you can close the window while a run carries on, not Ctrl+C. The
  app deploy says a browser window may open for sign-in, without naming its deploy tool.

---

## Unreleased — Before you start checklist (docs)

Docs only. Nothing in the installer, app or notebooks changes.

### Changed: one checklist for everything you need before you install

**Why.** A newcomer had to piece together what to ask for from three overlapping lists, found out
about the Viva Insights query, Power Automate Premium and the data policy only part-way through,
and had no idea how long it would take or what it would cost.

- **[Before you start](docs/PREREQUISITES.md)** is now the one checklist, organised by person: you,
  the Fabric admin, the Power Platform admin, the Viva Insights analyst, the Entra admin and the
  Microsoft 365 admin, then each optional extra with what it needs. The root, Fabric and installer
  READMEs link to it rather than repeat it.
- **Send this to your Viva Insights analyst first.** A short note to forward, so the Cowork credits
  query exists before you start. The partition ID defaults to the tenant ID, and you can add the
  query later.
- **How long it takes**: about 5 minutes of questions, 15 minutes of setup, and the first data
  about 25 minutes after **Go ahead** (about 2 hours for 180 days). Keep the PC awake and plugged
  in.
- **What it costs**: links to the official pricing pages for Fabric capacity (with a size hint),
  the Fabric free trial, Power Automate Premium and the optional Azure resources. No prices are
  written down.
- **Fabric README.** The installer comes before the manual setup video. Sharing is two steps:
  share the app with Analytics Hub Viewers once, then add people to the group. The data source
  cards are named as the installer shows them, and the Dataflow staging items are explained.
- **Credit consumption** docs use the card names (Copilot Studio credits, Copilot Cowork credits,
  Azure AI costs). A broken link from the Fabric README to the installer's download check is
  fixed.

---

## Unreleased — Org-scoped access (row-level security)

**Nothing changes unless you turn it on.** Upgrading or choosing **Repair or change** deploys the
models exactly as before. To use it, run the installer's `access` command and choose **Turn on
org-scoped access**. See [Org-scoped access](docs/PERMISSIONS.md#org-scoped-access-row-level-security).

### Added: each viewer can see only the orgs they're given

**Why.** Everyone in Analytics Hub Viewers saw every org. A leader sharing the dashboard with their
own org had no way to keep the rest of the tenant out of it.

- **Scopes.** A viewer can see everyone, everyone below a person (from the org data's manager
  chain), or one department or country. The installer's `access` command adds and removes them,
  switches between department and country, applies the changes and turns the feature off again.
- **Models.** When it's on, the ValueLens, Consumption Central and Agent Evaluator models get two
  roles and two hidden access tables. Tenant-wide data (spend, agent inventory, Defender, Resource
  Graph, product feedback) shows only to people who see everyone.
- **Turning it on keeps everyone's view.** Current members of the viewer group, and you, get an
  "everyone" scope. People added to the group later see nothing until they're given a scope.
- **Role members are applied after every deploy.** A model deploy drops them, so the installer
  runs the new `AnalyticsHub_Access_Scope` notebook through the XMLA endpoint after each deploy,
  then checks the result by querying as a seeded viewer. It needs **Allow XMLA endpoints** and a
  capacity with the XMLA endpoint set to Read Write. On Azure the Power BI workspace has to be on a
  capacity, and installs with private networking aren't supported yet.
- **App.** Pages say whose data they show ("Showing: people below …"). A viewer with no scope sees
  who to ask instead of empty pages.
- **Data.** The org data gains an `OrgPath` column (the manager chain by UPN) on both targets. Azure
  gets an `access_scope` table (migration V005) and an `access_people` view, and the jobs' publish
  step loads the scope list into it.

### Added: leaders give their own org from the Share panel (Azure)

**Why.** Every scope change went through an admin running the installer, even when a leader only
wanted to share their own org with someone who works for them.

- **Admins** (AnalyticsHub.Admin) give anyone the people below a person, or an org, from **Share**
  in the app, and can let them share their org in turn.
- **Leaders** with a "can share" scope give someone their own org: the people below them. They
  can't pass on "can share" and take back only what they gave. Nobody gives "everyone" from the
  app: that stays in the installer.
- **Waiting for an admin.** The delegate is added to the viewer group as the signed-in person. When
  Microsoft Entra doesn't allow that (only group owners and directory admins can), the scope waits
  until an admin approves it in the Share panel. No new Graph permissions.
- **Applies in minutes.** The web app saves the scope to Azure SQL as its managed identity and
  refreshes the models' access table. Changes close together share a refresh; if Power BI won't
  take one, the change applies at the next scheduled refresh. The jobs' load leaves these scopes
  alone.
- **Fabric** stays admin-only, through the installer. The Share panel says who to ask.

---

## Unreleased — Fabric App: chart redraw and Shadow AI fixes

### Fixed: charts that collapsed after a filter, and missing Shadow AI bars

- **Row charts redraw when their row count changes.** Charts with one row per category (by org,
  city, country or surface) set their height from the row count. When a filter or a different
  grouping returned fewer rows, the plot kept its old layout: the rows collapsed onto one line and
  the bars vanished until the window was resized. Every chart now redraws from scratch when its
  row count changes.
- **Cloud Discovery shows its unreviewed apps.** Defender for Cloud Apps leaves most apps
  untagged (an empty posture) or marks them Monitored. The Shadow AI tools query only caught a
  blank posture, so these apps had no colour and drew no bar. Anything that isn't Sanctioned or
  Unsanctioned now reads as Not reviewed, as the Cloud Discovery KPI already counts it.

Redeploy the app (**Repair or change**) to pick these up. The models don't change.

---

## Unreleased — Agent Evaluator and Consumption Central model fixes

### Fixed: refresh failures and an empty Credit Consumption page

**Why.** On a large tenant the Consumption Central and Agent Evaluator models failed to refresh,
and in Fabric mode the Agent Evaluator's Credit Consumption page was always empty.

- **Consumption Central: connection pool exhausted.** The credit and Azure tables that are read
  column by column (`studio_tenant_daily`, `studio_agent`, `studio_user` and the four
  `azure_*` spend and health tables) now buffer the Lakehouse table first. Unbuffered, the SQL
  endpoint was queried once per column.
- **Agent Evaluator: `'Agent Turns'[Response Seconds]` ran out of memory.** It now scans just the
  conversation, role and timestamp columns with `FILTER(ALL(...))` instead of
  `CALCULATE(..., ALLEXCEPT(...))`. The values are the same.
- **Agent Evaluator: Credit Consumption page empty in Fabric mode.** Nothing in Fabric writes the
  `credit_consumption_*` tables the page read. A new `FabricCreditTable` function reads them when
  they have rows, else the Consumption Central add-on's `studio_agent`, `studio_user` and
  `studio_tenant_daily` tables (latest snapshot), renamed to the export's columns.
- **Agent Evaluator: Agent Name Map.** In Fabric mode it now reads the credit-side agent names
  too, instead of an empty table. Both of its key columns are relationship keys, so a new
  `AgentNameMapRows` function keeps them unique the way the engine compares text (ignoring case
  and trailing spaces): one row per credit name, and a blank or already claimed `agent_schema`
  becomes `(unmatched) <name>`. Unmatched names used to share a blank key and fail the refresh.

The changes are applied by `scripts/Update-Model-Refresh-Fixes.py` (`--check` reports templates
that need it). **Repair or change** deploys the updated models; refresh them afterwards.

---

## Unreleased — Fabric App: report packs, PDF and PowerPoint

### New: report packs, exported as PDF and PowerPoint

**What changed.** The Fabric App, which serves both the Fabric and Azure paths, can now build and
export reports (#24).

- **Report packs.** A pack is a named, ordered list of sections taken from any page, listed under
  **Reports** in the sidebar. *Exec pre-read*, *Finance weekly* and *Adoption review* come built
  in; **Save a copy** starts a new pack from one. **New pack** opens an editor to name a pack, tick
  sections and order them. Packs are stored with the other settings: in the app's SQL database on
  Fabric, where anyone who can open the app can change them, and in Table Storage through
  `/api/settings/ReportPack` on Azure, where saving needs `AnalyticsHub.Admin`. A pack skips, and
  names, sections whose page this install hides.
- **Download PDF.** Every page and pack can be printed as a report laid out for paper, through the
  browser's **Save as PDF**. Where the host blocks the print dialog, it downloads as an HTML page
  to print instead.
- **Download PowerPoint.** A deck with a cover (filters, data dates, sections left out) and one
  slide per chart or table, built in the browser with `pptxgenjs`.
- **Data dates in file names.** Exports and each chart's **Download CSV** are named with the
  date the data runs to, such as `exec-pre-read-data-to-2026-10-11.pptx`.

Scheduled digests by email are not part of this change. The Power BI templates are unchanged.

---

## 2026-10-12 — Analytics Hub installer 0.5.1

**Updating is optional.** What the installer deploys is the same as 0.4.2 and 0.5.0. To update,
download installer 0.5.1 [from this repo](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/latest/download/AnalyticsHubInstaller.exe), open it and choose **Repair or change**.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.5.1`, which the Azure
install pulls.

### Added: update notices

- The installer checks this repo's latest release when it starts and says when a newer one is
  out. It stays quiet when it can't reach GitHub, for example offline or behind a proxy. Set
  `ANALYTICS_HUB_NO_UPDATE_CHECK=1` to turn it off.
- The Azure web app's update banner recognises `installer-v` tags.

### Changed: Azure is no longer in preview

- The READMEs, prerequisites and the installer no longer call the Azure target a preview. The
  installer README section is now [Azure target](1.%20Fabric/installer/README.md#azure-target), so
  links to `#azure-target-preview` open the top of that README instead.

### Changed

- The `valuelens-jobs` and `valuelens-web` images carry this repo as their source.
- The exe's release notes and the ESRP signing pipeline are in the
  [entry below](#2026-10-12--analytics-hub-installer-download-checking-it-and-getting-it-signed).

---

## 2026-10-12 — Analytics Hub installer download: checking it, and getting it signed

**Nothing to update.** This changes how the exe is released, not what it does.

### Changed: the download explains its warnings and how to check it

**Why.** The exe isn't code-signed yet, so Edge says it "isn't commonly downloaded" and Windows
SmartScreen may block it. That's a reputation warning, not a malware detection. An unsigned file
builds reputation by its hash, so each new version starts again from nothing.

- **Release notes** now list the exe's SHA-256, show the PowerShell command that checks it, and
  say what to click past the warnings. For a signed exe they say how to see the signature instead.
- **READMEs.** A new [Check the download](1.%20Fabric/installer/README.md#check-the-download)
  section, linked from every download link, has the same steps and points to
  [running it with Node.js](1.%20Fabric/installer/README.md#without-the-exe) for organisations that
  block the download.

### Added: the release is ready for ESRP signing

- `packaging/sign-installer.azure-pipelines.yml` is an Azure DevOps pipeline. It signs a drafted
  release's exe with ESRP using the Microsoft Corporation certificate, checks the signature, then
  replaces the draft's exe, `.sha256` and notes. Signed exes take the publisher's SmartScreen
  reputation, so new versions don't trigger the warning. It needs ESRP onboarding before it can run.
- `packaging/finish-exe.js` checks that a signature is valid, from Microsoft Corporation and
  timestamped. It writes or checks the `.sha256` and writes the release notes. The `installer-exe`
  workflow and the signing pipeline both use it.
- **Publishing check.** When an installer release is published, `installer-exe` downloads the exe and
  checks it against its `.sha256`. With the repo variable `REQUIRE_SIGNED_INSTALLER` set to `true`, it
  also requires the signature. A release that fails goes back to being a draft, so the download link
  keeps serving the last good version.

---

## 2026-10-12 — Analytics Hub installer 0.4.2

**Update an existing install:** download installer 0.4.2, open it and choose **Repair or change**.
Your saved answers are kept, so it asks fewer questions. If **Give the group Build on the models**
failed last time, run the installer's **access** command.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.4.2`, which the
Azure install pulls.

### Changed: fewer questions, with the rest under Advanced settings

**What changed.** The installer had gained a question for each new option: the reporting currency,
who can view, the schedule, Resource Graph's scope and more. A first install now asks only what it
can't guess.

- **The short path.** Fabric: sign in, the data sources, the capacity and workspace, the app
  registration and the Key Vault. Azure: sign in, what to collect, the subscription, resource group,
  region and Power BI workspace. A source that can't work without more, such as a flow's Power
  Platform environment, still asks for it.
- **Advanced settings.** One new question, **Change the advanced settings?**, comes after the data
  sources. **No**, the default and what `--yes` answers, keeps what you chose last time or takes the
  defaults. **Yes** asks as before: the Power BI items, who can view, audit history, tenant size,
  the Lakehouse name, a new vault's details, the schedule, the first load, the currency and
  Resource Graph's scope. On Azure it also covers demo mode, the SQL region, the name prefix, tags,
  networking and where credits come from. The plan still shows every setting before you approve it.
- **No currency question.** The Value page reports in US dollars unless you choose another under
  Advanced settings, with `install --currency GBP --exchange-rate 0.79`, or later under **Prices**
  in the app. A saved choice is kept.
- **Without Advanced settings,** a new install creates the **Analytics Hub Viewers** group with you
  as the contact, and a new Key Vault goes in `rg-valuelens` (it asks if you can't use that).

**Why.** Each option made sense alone, but together they made the first install long. Most
organisations take the defaults.

**What you need to do.** Nothing. Saved answers in `valuelens-install.json` still apply, and every
flag still works.

### Fixed: currency separators shown as "?" and Build not granted to a new viewers group

- The plan's currency line and the Value page's cost summary showed **USD ? US dollar** and
  **Loading?**. They now show **USD · US dollar** and **Loading…**.
- On a first install, the installer could create the **Analytics Hub Viewers** group and then fail
  to give it Build on the models (*"Parameter identifier is missing or invalid"*), because Power BI
  hadn't seen the new group yet. It now waits and retries for up to two minutes. To fix an install
  that hit this, run the installer's **access** command.

### Fixed: the browser page

- Only one scrollbar on the right: the page no longer scrolls behind the log.
- The steps on the left show only the chosen target's. A Fabric install no longer shows **Done**
  struck through, or Azure steps that never come.
- The Cowork credits Dataflow's sign-in steps show as numbered steps rather than broken lines, in
  the terminal too.

### Fixed: a network blip no longer fails the install, and an unrefreshed model says so

- A brief network or DNS failure on the PC running the installer (for example *"Failed to resolve
  'login.microsoftonline.com'"*) made the sign-in token call fail and stopped the install while it
  watched the first load, even though the load carried on in Fabric. Token calls now retry with
  backoff, and watching a pipeline run keeps going through up to 20 minutes of lost connection.
- When the semantic model hasn't been refreshed yet, the app's pages showed raw engine errors such
  as *"needs to be recalculated or refreshed"*. They now say **Data not loaded yet**, and explain
  to wait for the first load or choose **Repair or change** in the installer.

### Fixed: Defender agents reported as "Not licensed" when a column was missing

- Defender's **AgentsInfo** table is in preview and its columns vary between tenants. The agents
  probe failed when a column such as `AgentName` was missing, and reported it as **Not licensed**.
  It now reads every optional column only when it's there, and reports a missing column as a failed
  query rather than a missing licence.

---

## 2026-10-11 — Analytics Hub installer 0.4.1

**Update an existing install:** download installer 0.4.1, open it and choose **Repair or change**.
It asks for the Value page's reporting currency: pick **GBP** to keep pounds. It also asks who can
view; let it create the **Analytics Hub Viewers** group, or name your own.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.4.1`, which the
Azure install pulls.

### Changed: one reporting currency, US dollars by default

**What changed.** The Fabric App's Value page used to show costs in dollars and value in pounds.
Return on cost and the break-even hourly rate stayed blank until someone saved a pounds-per-dollar
rate (#173).

- **One currency.** The whole Value page now uses one reporting currency: US dollars unless another
  is chosen. With dollars nothing is converted and nothing needs setting.
- **Another currency.** Pick it under **Prices** on the Value page (16 common currencies) and give
  how many of it make $1. Licence and credit costs are converted at that rate. The hourly value is
  entered in the chosen currency.
- **Consumption** figures stay in the currency they're billed in, now labelled *as billed*.
- **Installer.** Setup, on both Fabric and Azure, asks for the Value page's currency and an
  optional rate. Nothing is looked up online. It saves them in `valuelens-install.json`, passes them
  to the app (`fabric.config.json` on Fabric; `VALUELENS_CURRENCY` and `VALUELENS_EXCHANGE_RATE` on
  the Azure web app), and sets the Power BI model's `Currency Symbol Value` to match.
- **Settings.** The app's settings gain a `currency` value next to the exchange rate: a column in
  the app's SQL database on Fabric, and a field in Table Storage on Azure.

**If you used pounds.** A saved exchange rate with no currency is read as pounds, the old
behaviour, until the installer is run again. The installer defaults to US dollars, so pick
**GBP** in it, or under **Prices**, to keep pounds. A currency saved under Prices always wins.

**Power BI templates.** The manual `.pbit` templates still ship with `£` as `Currency Symbol Value`.
Change that measure in the `Assumptions` table to your currency; #167 tracks the templates.

### New: share Analytics Hub by adding people to one group

**What changed.** Sharing used to take three or four grants across two or three portals for each person.
Now, on both the Fabric and the Azure path, who can view is one Entra security group,
**Analytics Hub Viewers**, and sharing is adding people to it (#172).

- **Installer.** A *Who can view* question creates the group with you as owner, or uses a group you
  name. It also asks who people should ask for access (you by default) and takes an optional https
  request link, such as a My Access package. A **Viewer access** step gives the group **Build** on
  each model the app reads. The new `access` command (**Manage access** in the browser) adds
  viewers or owners and repairs the Build grants.
- **Share in the app.** A **Share** button copies the app link. On Azure, group owners and
  `AnalyticsHub.Admin` add and remove people or groups in the app; it calls Graph as them
  (delegated `GroupMember.ReadWrite.All`), so Graph still enforces ownership. On Fabric it opens
  the group in My Groups.
- **Request access.** People without access see which group to join, a **Request access** link
  and a prefilled email to the contact, instead of "Ask your admin". On Azure the reason is typed:
  not in the group (`NotAViewer`) or no access to the model (`PowerBIAccessDenied`).
- **Azure web app.** Lets in members of the group (through the `groups` claim, or
  `checkMemberGroups` when someone is in too many groups to fit it) as well as the
  `AnalyticsHub.User` app role. New `/api/access` endpoints back the Share panel.
- **Teams.** The install summary and `2. Azure/teams/README.md` cover publishing the package to the
  org app catalog and pinning it for the group with a setup policy.
- **Fabric.** The app item still has to be shared with the group once, by hand; there is no API
  for it. After that, membership is enough.

Unaffected: the Power BI template variants (CSV, SharePoint, Power Automate + Dataverse), which share
through Power BI. Scoped views, named queries and delegated access come in later phases of #172.

### Fixed: scheduled refresh blocked by "Data source for Query1" on the SharePoint template

**What changed.** After publishing `ValueLens - SharePoint.pbit`, the Power BI service refused to
schedule refresh: *"the following data sources currently don't support refresh: Data source for
Query1"*. The service only schedules a `Web.Contents` source whose URL is a parameter with a value.
`ProductFeedback` built its URL with `Text.Trim(#"Feedback File")`, and a blank optional file
parameter is never a valid source URL either.

- **SharePoint.** A new required **SharePoint Site URL** parameter. `Agent 365` and `Feedback File`
  are read through it with the SharePoint REST API (`ValueLensSharePointFile`), so they can stay
  blank or be set. They must be in that site. Republish and set credentials for each listed source.
- **Power Automate + Dataverse.** The same optional **SharePoint Site URL** parameter reads the
  optional files and the CSV fallback. Dataverse reads use `Dataverse URL` directly as the base URL.
  For scheduled refresh, set both URLs (the same value if you use only one source).
- **Local CSV.** `ProductFeedback` takes the parameter directly, the same as the other templates.
- `scripts/Update-Template-Refresh-Sources.py` applies the change (`--check` reports stale templates),
  and `tests/test_template_refresh_sources.py` fails on any computed or optional base URL.

Tested in the Power BI service with sample CSVs in a test SharePoint site: no refresh banner, the
schedule turns on, and on-demand refresh succeeds with the optional files blank and set, and in
Power Automate CSV fallback.

---

## 2026-10-09 — Analytics Hub installer 0.4.0

**Update an existing install:** download installer 0.4.0, open it and choose **Repair or change**.
To turn on the new optional sources, tick **Defender (shadow AI and agent risk)** or **Agent
configuration and Foundry (Azure Resource Graph)** there, and grant the permissions or roles the
installer lists.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.4.0`, which the
Azure install pulls.

### New: Defender shadow AI and agent risk (optional)

**What changed.** A new optional data source, **Defender (shadow AI and agent risk)**, off by default,
on both the Fabric and the Azure path (#160). It reads Microsoft Defender through Microsoft Graph:
advanced hunting (`POST /security/runHuntingQuery`, `ThreatHunting.Read.All`) and Cloud Discovery in
Defender for Cloud Apps (`CloudApp-Discovery.Read.All`). Fabric runs the new
`Copilot_Defender_Ingester` notebook; Azure runs the `defender` jobs module. Both share
`valuelens_core.defender`, and `V003__defender.sql` creates the Azure SQL tables.

- **Shadow AI on the Governance page.** AI tools other than Copilot that people ran, reached on the
  network or installed on Defender-onboarded devices, plus generative AI apps from Cloud Discovery.
  Tools come from an editable watchlist (`defender/ai_watchlist.csv`), each *Sanctioned*,
  *Unsanctioned* or *Not reviewed* (the default). The section shows with or without the Agent 365
  registry, and says how to turn Defender on when it's off. It is a floor, not a census.
- **Fail-soft probes.** Device activity, installed software, AI agents and Cloud Discovery run on
  their own. One the tenant isn't licensed for, or can't read, is logged in `defender_status` and
  skipped; the rest of the load, and the rest of Governance, carry on, and the page names what
  didn't load.
- **Agent risk.** The two Fabric templates' `Agents 365` table gains `Sign-in Required` (*Yes*, *No*
  or *Unknown*). It takes the first source that knows the agent, Defender's agent inventory for now,
  so a more direct source can go ahead of it. *No* adds a **No sign-in required** governance flag.
- **A weighted review queue.** Flags now carry weights (*No sign-in required* and *Owner has left*
  3, *Org-wide with org data* and *No owner on record* 2, *Shared, no recorded use* 1), and the queue
  sorts by their sum, then flag count, then users.
- **Installer.** A *Defender (shadow AI and agent risk)* choice on both targets (`--data
  defender=api`), the optional permissions, a licence prerequisite (Defender for Endpoint P2, Defender
  XDR or Defender for Cloud Apps) and the `EnableDefender` pipeline parameter.

### New: agent configuration and Foundry from Azure Resource Graph (optional)

**What changed.** A new optional data source, **Agent configuration and Foundry (Azure Resource
Graph)**, off by default, on both the Fabric and the Azure path (#162). Fabric runs the new
`Copilot_Resource_Graph_Ingester` notebook; Azure runs the `resourceGraph` jobs module, and
`V004__resource_graph.sql` creates the Azure SQL tables.

- **Agent configuration.** Copilot Studio agents from `PowerPlatformResources` (authentication,
  connectors, sharing, model and channels), Power Platform environments and agent flows. Resource
  Graph returns agents only to an identity with an Entra role such as Global Reader, so when it
  returns none the load reads the newest file from the new **Analytics Hub - Agent inventory** flow,
  which calls the Power Platform inventory API with a delegated sign-in.
- **Sign-in Required, Resource Graph first.** The `Agents 365` sign-in lookup now asks Resource
  Graph's agent configuration before Defender's agent inventory, so *No sign-in required* works with
  either source. The review queue weights are unchanged.
- **The Foundry estate.** Foundry accounts and projects across the management group (or the whole
  tenant), with public network access and region, on the Governance page. The Consumption page
  joins them to Azure AI spend on resource ID to show spend per Foundry project.
- **Fail-soft probes.** Each probe runs on its own and records what it couldn't read, and why, in
  `arg_status`. The Governance page shows empty states that say how to turn the source on.
- **Installer.** An *Agent configuration and Foundry* choice on both targets (`--data
  resourceGraph=api`, `--arg-management-group`), the Reader role assignment (or the command to run),
  the optional flow, and the `resourceGraph` module on Azure.

### New: Fabric App concentration, value by habit, agent spotlights and chart actions

**What changed.** More additions to the Fabric App, for both the Fabric and Azure paths (#163).

- **Concentration.** Leaderboards, Consumption's Copilot Studio section and Value show the share
  taken by the top 1%, 5% and 25% of people, with a Pareto curve. A share is shown only when its
  slice covers at least five people.
- **Value by habit.** Value has a new section with expert-equivalent hours per person last month
  for Power, Habitual, Developing and Beginner users, labelled as a comparison, not a cause.
- **Agent spotlights.** The agent leaderboard opens with the most used agent, the one used by the
  most job functions, and the one reached across the most organisations.
- **Chart actions.** Every chart's menu has **Copy as image** (it downloads a PNG where the
  clipboard is blocked) and **Download CSV**.
- **Data freshness.** Each page lists the latest date each of its sources holds.

The Power BI templates are unchanged; #167 tracks porting the read-only visuals to them.

### New: Fabric App budget runway, chart headlines and heavy users without a licence

**What changed.** Three additions to the Fabric App, which serves both the Fabric and Azure paths
(#163).

- **Budget runway.** On Consumption, **Monthly budgets** sits next to Rates & packs. It takes an
  optional monthly budget for Cowork / Work IQ, Copilot Studio and Azure. A new *Budget runway*
  section shows each source's spend so far this month against its budget, projects the month-end
  in a straight line, and says whether it is on track, at risk (with the date it would pass the
  budget) or already over. The budgets are stored with the rates: in the app's SQL database on
  Fabric, and in Table Storage through `/api/settings` on Azure.
- **Chart headlines.** Most charts now have one plain sentence above them, worked out from the
  rows they draw, such as the largest category and its share or the peak week. A headline is left
  out when the data is too thin to support one, and it never claims a cause.
- **Heavy users without a licence.** Readiness has a new section that splits last month's active
  people by habit (Power, Habitual, Developing, Beginner) and by licence, and lists the ten
  unlicensed people active on the most days.

The Power BI templates are unchanged.

## 2026-10-09 — Analytics Hub installer 0.3.9

**Update an existing install:** download installer 0.3.9, open it and choose **Repair or change**.
On Azure, run `update` first if you want to load more audit history: older job images ignore
`VALUELENS_AUDIT_BACKFILL_DAYS`.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.9`, which the
Azure install pulls.

### Docs: a disclaimer in the README

**What changed.** The README has a short **Disclaimer** section above *Pick a path*, and each path
README points to it. It says two things. ValueLens isn't the official Copilot report: that's the
Microsoft 365 admin center Copilot usage reports and the Viva Insights Copilot Dashboard, and
because ValueLens reads mainly the Purview audit log its numbers may not always match them. And
once data is extracted into Fabric, Azure, Dataverse, SharePoint or CSV files, the retention,
deletion and other policies set in the source systems don't apply to those copies, so managing
them is up to you.

### New: Repair or change can load more audit history

**What changed.** Once the first load has finished, **Repair or change** asks *Load more audit
history?* and offers only more than is loaded (90 or 180 days after 30, for example); keeping what
you have is the default (#158). The plan shows the reload, which runs once straight after the
repair; later runs load only what's new. The record keeps the larger figure once the reload has
started. This works for Fabric and Azure installs, in the terminal and in `--ui`. On the `--ui`
home page, the **Run** row also gets an **Audit history** picker, and the installed record shows
how much history is loaded. `run --backfill-days <n>` still works.

On Azure, the reload starts the run job once with the new `VALUELENS_AUDIT_BACKFILL_DAYS` setting,
leaving the job's usual settings alone. Job images older than this release ignore it, so run
`update` first.

### New: a Prerequisites check on the installer's home page

**What changed.** After you sign in, the home page shows a **Prerequisites** panel: the roles,
licences, capacities and access the install needs, each as met, missing, eligible or couldn't
check, with what it's for and how to get it. It checks the consent roles (Global or Privileged Role
Administrator), Fabric and Power Platform administrator, app registration, Power BI Pro, Fabric
capacities, Azure access per subscription (Owner, or Contributor plus User Access Administrator),
Key Vault, System Administrator in each Power Platform environment, and the Fabric tenant settings.
Only active roles count; a role you're eligible for in Privileged Identity Management shows as
**eligible, activate first**. Everything is read-only. In the terminal, run `prereqs`.

### Fixed: Repair failed with `FlowMissingConnection` when a flow had changed

**What changed.** Dataverse refuses to update a flow while any of its connections is still to be
signed in to (400 `0x80060467 FlowMissingConnection`), even when the flow is off. So **Repair or
change** failed on a flow created by an earlier version whose connections were never signed in to,
when the new version changed it. Now a flow with no connections signed in to is replaced with the
new version. Bindings made in the Power Automate designer are recognised and kept. A flow that gains
a connection is turned off first, and replaced if Dataverse refuses the update.

### Changed: Product feedback's Power Automate route is its own choice

**What changed.** Product feedback now offers **Power Automate (emailed export)** next to
**Upload CSV** and **Skip**, rather than a yes/no question after Upload CSV. It creates the flow that
saves the exports emailed to a mailbox. The plan, the Data sources screen in `--ui` and the README
show it as its own mode. On the command line it's `--data productFeedback=flow` (or `=api`);
`--feedback-flow` still works and means the same. A saved install that had the flow keeps it.

### New: run the Copilot Studio credits flow now

**What changed.** The Studio credits flow loads its first six months on its first run, which used to
be the next day. Now `run` (in the terminal and in `--ui`) and **Repair or change** check whether
the flow is on and has loaded them yet. If it hasn't, they offer to run it now as you, and to wait
for it so the pipeline that follows picks up its files. On Fabric the check is the flow's
`studio_backfill_done` marker; on Azure, its run history. If the flow is off, or Power Automate
turns the run down, the installer prints the steps to do it by hand and carries on. `--yes` never
runs it. The flows summary after an install says the same.

---

## 2026-10-09 — Analytics Hub installer 0.3.8

### New: credit consumption on the Azure path, with the Studio licensing API as the default

**What changed.** **Credit consumption** can now be ticked on an Azure install (#149), matching what
#150 did for Fabric. The Azure install deploys the Consumption Central model next to the ValueLens
Model, both reading the same Azure SQL database, and the app shows the Consumption Central pages.

- **Copilot Studio credits** come from the Power Platform licensing API by default. The installer
  creates the same daily Power Automate flow as on Fabric: the first run loads about 180 days, later
  runs the last ten, and per-user credits (`studio_user_daily`) are best effort. The flow signs in as
  the person installing; `--flow-identity app` is Fabric only for now, so on Azure it warns and is
  ignored. The PPAC CSV exports remain an option.
- **Where the files land.** With public endpoints the flow writes to the storage account's `landing`
  container (`studio/`, with its own state in `flows/`), and the installer gives the person installing
  **Storage Blob Data Contributor** on the account. With private networking, where Power Automate can't
  reach the storage account, the flow writes to a SharePoint folder you name instead. The jobs'
  managed identity reads it with **Sites.Selected**, which the installer grants if you're a SharePoint
  or Global administrator, or prints the `Grant-PnPAzureADAppSitePermission` command for one.
- **Cowork credits**: drop the Consumption Dashboard's Viva Insights export in the `viva` folder.
- **Azure AI and pay-as-you-go**: the jobs read Cost Management and Azure Monitor with their managed
  identity. The installer assigns the roles on the subscriptions you choose.
- `valuelens-jobs` gains a consumption step that reads the files where they land (it doesn't move them,
  the same as the Fabric notebooks), and a `V002` migration adds the consumption tables.

**Not on Azure yet** (follow-up issues): GitHub Copilot consumption, the dated Agent Daily table, Viva
without a CSV, and `--flow-identity app`.

**Update an existing Azure install:** run installer 0.3.8, choose **Repair or change** and tick
**Credit consumption**. Sign in to the flow's connections when the installer lists them, then turn the
flow on.

Other variants (CSV/SharePoint, Power Automate + Dataverse) are unchanged.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.8`, which the
Azure install pulls.

---

## 2026-10-09 — Analytics Hub installer 0.3.7

**Update an existing install:** download installer 0.3.7, open it and choose **Repair or change**.
If you keep the client secret in the notebooks, run `AnalyticsHubInstaller.exe update` instead:
Repair doesn't rewrite those notebooks.

Both update the Power Automate flows in place and keep the connections already signed in to.
Because the flows now need a OneLake connection, each flow is turned off and the connection to
sign in to is listed. Sign in, then turn the flow back on. A saved choice of *Upload CSV* for
Copilot Studio credits with the flow chosen becomes **Connected**, which behaves the same.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.7`, which the
Azure install pulls.

### Fix: Azure capacity, reconciliation and solution spend pages are blank

**Symptom.** In Consumption Central, **10. Azure: Capacity & Health**, **10.1 Billing:
Reconciliation** and the Foundry solution spend visuals are empty on a real install, even with
Azure OpenAI deployments in the subscription. `AzureAiSpend` and `AzureAiTokens` have rows;
`AzureDeploymentHealth`, `AzureBillingReconciliation` and `AzureSolutionSpend` have none.

**Cause.** Nothing wrote `azure_deployment_health`, `azure_billing_reconciliation` or
`azure_solution_spend`. Only the sample data had them.

**Fix.** `Ingest_Azure_AI` now writes all three after its existing tables, best-effort:

- **Deployment health**, by month and deployment: model, version, SKU, region and PTU capacity
  from ARM, then requests, 429s, 5xx, latency and provisioned utilisation from Azure Monitor. The
  metric calls are batched per account and window, and a failed batch is retried one metric at a
  time. Standard and GlobalStandard deployments have no PTU capacity or utilisation.
- **Solution spend**, by day, resource and service: actual and amortized cost from Cost
  Management for the AI services and the resources in the AI accounts' resource groups, with
  pay-as-you-go token cost, Monitor tokens and requests, and tags.
- **Billing reconciliation**, by month, service and pool: metered quantity times the public
  Retail Prices API list rate, compared with the actual cost. List prices exclude negotiated
  discounts. Meters with no retail price show as `Unpriced`.

An account, deployment or metric that fails is logged as a `WARNING` and skipped. A table whose
source fails entirely is left as it was, and the existing three tables are unaffected. The
existing Reader, Cost Management Reader and Monitoring Reader roles are enough.

The Local CSV and SharePoint script `pull_azure_ai.py` writes the same three files with the same
logic. The Azure (preview) path has no Consumption Central collector yet, and the Power Automate +
Dataverse flows don't fill these tables; import the script's CSVs there. Speech hours, document
pages and images aren't collected. The reconciliation page's context text still describes the
sample data.

### Change: Power Automate flows write to OneLake as a signed-in person, with no Key Vault

**Symptom.** The installer's flows (`Analytics Hub - Product feedback` and `Analytics Hub -
Copilot Studio credits`) read the app's secret through the Azure Key Vault connector. That
connector needs the vault to allow public network access. Where tenant policy keeps vaults
private, the flows could never run. The installer's advice ("allow public access from trusted
services or use a gateway") was wrong: Power Automate isn't an Azure trusted service, and a data
gateway doesn't help this connector.

**Fix.**

- By default, the flows write to `Files/analytics_hub_uploads` through an **HTTP with Microsoft
  Entra ID (preauthorized)** connection to OneLake (Base Resource URL
  `https://onelake.dfs.fabric.microsoft.com`, Resource URI `https://storage.azure.com`). Whoever
  signs in needs Contributor or higher on the workspace. No secret, no Key Vault connection, and
  the flows now work when the secret is kept in the notebooks.
- `install --flow-identity app` keeps the previous behaviour, for tenants that want writes made
  by the app registration. It needs Key Vault, and the installer warns if the vault is private.
- The private-vault warning now says only what's true, and appears only with `--flow-identity app`.
- The installer's next steps for each flow are short numbered steps, with a tip to sign in with
  a dedicated admin account and add a co-owner.
- The manual-setup product feedback flow (`Manual setup/flows`) uses the same OneLake connection.
- The flow writer accepts any ADLS Gen2 (DFS) endpoint, ready for the Azure path.

### Change: Copilot Studio credits come from the licensing API by default

- **Connected (Power Automate flow)** is now the default for Copilot Studio credits. Admin centre
  exports are optional, and win for the months they cover.
- The flow's first run loads about six months of history; then it restates the last ten days
  each day.
- It fills in environment names, which were blank on API rows.
- It also saves per-user credits by day (`StudioApiUserDaily_*.csv`), best effort, from an
  undocumented API route. `Ingest_Studio` loads them into the new `studio_user_daily` table,
  resolves user IDs to UPNs, and fills `studio_user` for months no export covers.
- Consumption Central and the Fabric App say which Studio figures are dated (API) and which are
  month-to-date snapshots (export).

---

## 2026-10-09 — Analytics Hub installer 0.3.6

**Update an existing install:** download installer 0.3.6, open it and choose **Repair or change**.
Repair sees the changed Agent Evaluator model, redeploys it and refreshes it.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.6`, which the
Azure install pulls.

The README also has a new collapsed note on which agents the Purview audit log covers.

### Fix: Agent Evaluator refresh fails with "Cannot order 'Metric Glossary'[Metric] by [MetricOrder]"

Since 0.3.4 the installer treats refresh warnings as failures. That exposed a warning that was
already there: in the Agent Evaluator glossary, 11 metrics are listed on more than one page with a
different `MetricOrder` on each, so `Metric` can't be sorted by `MetricOrder`.

- Each glossary metric now uses its lowest `MetricOrder`, the same rule the ValueLens glossary
  already follows. The rows, descriptions and page order are unchanged.
- `scripts/Update-Glossary-Sort-Order.py` applies the rule to every shipped template, and
  `--check` reports any template that needs it.
- A new test, `tests/test_dax_sort_by_columns.py`, checks every calculated `DATATABLE` that has a
  sort-by column in the shipped templates. It fails when a value has more than one sort key.
  Only the Agent Evaluator template was affected.

---

## 2026-10-09 — Analytics Hub installer 0.3.5

**Update an existing install:** download installer 0.3.5, open it and choose **Repair or change**.
Repair pushes the new org data notebook when the client secret is in Key Vault. If you chose to
keep the secret in the notebooks, run `AnalyticsHubInstaller.exe update` instead: Repair doesn't
rewrite those notebooks, and `update` writes them with a new secret.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.5`, which the
Azure install pulls.

### Fix: org data load stops with "Cycle detected in manager hierarchy"

**Symptom.** On a tenant whose manager data contains a cycle, the org data notebook
(`Copilot_Org_Data_Direct_Ingester`), and so the nightly pipeline, stops with
`ValueError: Cycle detected in manager hierarchy at '…'` and `copilot_org_data` isn't written.
The Azure path's org collector stops the same way.

**Cause.** The manager-chain walk treated any repeat as fatal. That includes someone who is
their own manager in Entra, which is common for the person at the top of the org.

**Fix.**

- Someone whose manager is themselves is now the top of their chain, with no error, and is no
  longer counted as one of their own direct reports.
- A real loop between people (A → B → A) no longer stops the load. Every row is kept, the chain
  is cut where it loops, and the new `HierarchyError` column says where (for example
  `Cycle detected at 'a@contoso.com'`). It's empty for everyone else. The notebook prints how
  many distinct loops it found and up to 20 examples; the Azure collector logs the same as a
  warning.
- The same rules apply to the Local CSV `Adapt-OrgFile-To-EntraUsers.py` adapter, which also
  gains the `HierarchyError` column. The Workday lander's standalone mode adds the column empty so
  its output keeps the same shape.

The report templates don't need changing: they ignore org columns they don't use. The table is
written with `overwriteSchema`, so the new column needs no migration.

---

## 2026-10-08 — Analytics Hub installer 0.3.4

This release fixes models that never finished calculating, and lets long first loads on very
large tenants carry on instead of timing out.

### Fix: report pages say a column "needs to be recalculated"

**Symptom.** After installing with 0.3.3, or deploying a 0.3.3 ValueLens template, report pages
fail with *"The expression referenced column '…'[Is Usage Row] which does not hold any data
because it needs to be recalculated"*. The relationship between Audit_UserId and Org Data
PersonId shows the same message. The model refresh still says **Completed**.

**Cause.** The Calendar table named a variable `LastDate`, which the DAX parser rejects. Power BI
only logs that as a refresh warning, so Calendar, `Is Usage Row` and the relationship were never
calculated. The Agent Evaluator template had two more warnings of the same kind: its Metric
Glossary table and its Conversations Shown measure didn't parse.

**Fix an existing install (Fabric):**

1. Download installer 0.3.4 and open it.
2. Choose **Repair or change** and go through the steps. The installer redeploys any model whose
   definition changed (ValueLens, and Agent Evaluator if you have it), connects it again,
   refreshes it and runs a test query against it. The run ends with
   `✓ … answers queries (its Calendar has N days)`.
3. If you run commands instead, `AnalyticsHubInstaller.exe update` does the same.
4. To check later, run `AnalyticsHubInstaller.exe check`. It now also queries the model and fails
   when its tables weren't calculated.

**Fix an existing install (Azure):** choose **Repair or change**, then run
`AnalyticsHubInstaller.exe refresh`. A redeployed model has no data until it refreshes.

**Manual set-up from a template:** download the updated `.pbit`, or open the Calendar table's
DAX in Power BI Desktop, rename the variable `LastDate` to `MaxDay` (it appears three times), and
refresh.

What else changes:

- A refresh that ends **Completed** with a warning or error message now counts as failed, both in
  the installer and in the `AnalyticsHub_Refresh_Model` notebook. So the nightly pipeline fails
  instead of leaving a half-calculated model.
- **Repair** now pushes new versions of the notebooks, such as the refresh notebook and the
  ingesters below. Before, only `update` did. Notebooks that hold the client secret inline (no
  Key Vault) still need `update`, because writing them needs a fresh secret.
- CI rejects DAX variable names that the service rejects
  ([tests/fixtures/dax_reserved_names.txt](tests/fixtures/dax_reserved_names.txt), built by
  asking the service) and string literals with an unescaped quote.

### Fabric: long first loads on very large tenants carry on instead of timing out

- The **first load now defaults to 30 days** of audit history (the notebook was 180, the installer
  90). You can still choose up to 180 days, or load more later with `run --backfill-days <n>`.
- The **audit ingester** stops cleanly before its activity time limit (`TIME_BUDGET_MIN`) and saves
  where it got to. The next run or the pipeline retry reuses queries the audit service is still
  working on, and skips recent windows it finished in the last few hours, so nothing is queried twice.
- The **Licensed users** and **Org data** ingesters retry Microsoft Graph throttling (429), server
  errors and dropped connections, honour `Retry-After`, and renew an expired token once.
- The installer asks **how many people are in the tenant**, prefilled from the capacity size:
  - **Up to 10,000** uses 24-hour audit windows (about 8 queries a day instead of 22) and keeps the
    template timeouts.
  - **More than 10,000** uses 2-hour windows that the audit service can finish, gives up on a failing
    window after one retry, splits it sooner, and gives the longer activities more time.
  - An existing install keeps 8-hour windows and its timeouts until you choose **Repair or change**.
- The first-load message gives a realistic estimate instead of "10 to 40 minutes", and the
  missing service principal message says **Carry on anyway** creates it.

The first daily run after you pick a size re-queries the trailing week once, because the windows
change size. A first load in progress restarts its windows at the new size.

---

## 2026-10-08 — Analytics Hub installer 0.3.3

The installer bundles the notebooks, templates and app when it is built, so this release brings
everything merged since 0.3.2 to installer users:

- set-ups **without Key Vault write access or app registration rights**: a vault admin adds the
  secret, an admin pack for app registration, and a check of a bring-your-own app (#138);
- the **audit ingester** retries, splits and throttles failed query windows instead of stopping
  the run (#137);
- Cowork scheduled runs counted, an **Update your install** prompt when the install is older
  than the app, and empty-source fixes (#136).

The audit ingester's manifest gains a `split` window status, and older copies of the notebook
reject a manifest that contains one. Don't roll back to an earlier installer or notebook in the
middle of a backfill.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.3`, which the
Azure install pulls. To update, download the installer again, open it and choose
**Repair or change**.

---

## 2026-10-08 — Analytics Hub installer: set-ups without Key Vault write access or app registration rights

Until now, the installer stopped with `You can't write secrets to …` when you could pick a vault
but not write to it, and needed you to register the app yourself or bring one that was ready.
In a large tenant, those rights often sit with someone else. The existing paths haven't changed.
The new ones are:

- **A vault admin will add the secret for me.** This is offered when you can't write to the
  vault. The installer shows the vault, the secret name and one Azure Cloud Shell command. The
  command creates the client secret and stores it in the vault, so its value never reaches the
  installer. You only need read access (Key Vault Secrets User, or Get and List on an access
  policy), which is all the notebooks need to read the secret at run time. The installer can
  make the admin an owner of the app. You can stop and resume later. `rotate-secret` gives the
  same handoff. It's recorded as `keyVault.mode: "keyvault-admin"`.
- **Store the secret in the notebook (not recommended).** For quick tests only. It needs no
  Azure subscription or vault. You have to confirm a warning first: the secret is plain text,
  anyone with workspace access can read it, and it is copied into run snapshots, exports, Git
  sync and deployment pipelines. `install --secret-in-notebook` chooses it with `--yes`.
  Rotating creates a new secret, rewrites the notebooks and removes the old secret. Power
  Automate flows are skipped. It's recorded as `keyVault.mode: "notebook"`.
- **Contributor on one resource group** is enough for a new vault. If the installer can't read
  the subscription's resource providers, that's no longer fatal. It uses an existing group
  instead of trying to create it, and explains a 403 or an unregistered `Microsoft.KeyVault`
  provider.
- **Admin pack.** If you can't register apps or grant consent, choose **An admin will register
  the app for me**. You get `analytics-hub-admin-pack.md`, which has a Cloud Shell script and
  portal steps covering every Graph permission your modules need, admin consent and the secret.
- **Bring-your-own app check.** An app you bring is checked before anything is created: its
  service principal, its Graph permissions and admin consent. You get a list of what's missing,
  the consent link, and the choice to **Check again** or **Carry on anyway**.

Both the terminal and the web UI support all of these. See
[Where the secret goes](1.%20Fabric/installer/README.md#where-the-secret-goes).

---

## 2026-10-08 — Audit ingester: failed query windows retry, split and slow down

On large tenants, Purview sometimes ends audit-log queries with status `failed` or `cancelled`,
often several at once, when the tenant's limit on concurrent audit queries (about 10, including
searches other admins run in Purview) is reached. Until now, the first failed window stopped
`Copilot_Audit_Log_Direct_Ingester`, nothing was written, and the only way back was a manual
rerun with `MODE = 'backfill'`. Switching to `'incremental'` first lost the older failed windows.

The ingester now recovers by itself:

- **Retry.** A window whose query ends `failed` or `cancelled`, or times out, is sent again as a
  **new** query after an exponential backoff with jitter, up to `WINDOW_RETRIES` (3) times. The
  manifest records `attempts` and the recent `attempt_errors` for each window.
- **Split.** A window that still fails is split in half (8h → 4h → 2h → 1h, down to
  `MIN_CHUNK_HOURS`) and the halves are queried. A window that hits `MAX_WAIT_MIN_PER_QUERY`
  splits at once (`SPLIT_ON_TIMEOUT`).
- **Adaptive concurrency.** After a failure, the run makes one fewer query at a time, and after an
  HTTP 429 it makes half as many. This lasts for the rest of the run, at most one change a minute,
  and never goes below `MIN_CONCURRENT_QUERIES`. `MAX_CONCURRENT_QUERIES` now defaults to **5**
  (it was 6) to leave room for other admins.
- **No early abort.** Every window is attempted, then a summary prints what was reused, fetched,
  retried, split and failed.
- **Safe final failure.** If any window still fails at the smallest size, the run fails **without
  writing**, with one message listing the failed windows and the next step ("rerun with
  `MODE='backfill'`; succeeded windows are reused"). An `'incremental'` run refuses to start
  while an older window failed and was never recovered, so it can't leave a silent gap. Set
  `ALLOW_UNRECOVERED_GAPS = True` to accept the gap. Missing permissions (401/403) still stop
  the run at once.

Manifest compatibility: window keys are unchanged (`WINDOW_KEY_VERSION` stays `v2`), so existing
manifests and their succeeded windows are reused. The halves use the same `stable_window_key` as
any other window. A split window stays in the manifest with status `split` and its `parts`, and
counts as complete once all its parts succeed. A manifest that contains a `split` window is
rejected by older copies of the notebook, so don't switch back after a split.

Other variants:

- **Azure jobs** (`2. Azure/jobs`, also used by the SharePoint Azure container): the same retry,
  split and concurrency behaviour, using the shared `valuelens_core.audit` helpers. As before,
  windows that finished are merged and the high-water mark holds until every window succeeds.
  The job now lists the failed windows (up to 10).
- **`Invoke-CopilotAuditRawCapture.ps1`** (Power Automate + Dataverse): new `-QueryRetries`
  (default 2), `-RetryBaseSeconds` and `-RetryMaxSeconds`. A failed, cancelled or timed-out query
  is sent again as a new query. The script covers one window, so it doesn't split.
- Not affected: the Power Automate / PAX collector flows, SharePoint without Azure, and Local
  CSV. They export audit data with Microsoft's tools rather than run these queries.

See [An audit window keeps failing](1.%20Fabric/Manual%20setup/notebooks/README.md#an-audit-window-keeps-failing).

---

## 2026-10-08 — Cowork scheduled runs, install version checks and empty-source fixes

Fixes from a data audit of a customer install.

**Cowork scheduled and autonomous runs are counted (P3).** These runs log a record with no
prompt, so every parser dropped them and their users never appeared in Adoption or Executive,
even though Viva Insights billed their credits. They are now kept as one task row per record
(`Message_isPrompt` FALSE, `message:none`, no resource fan-out), the way Copilot Studio runtime
records already were. In the model:

- a hidden `Is Usage Row` column (`Is Prompt Row` or `Is_Cowork`) and `Usage Rows` measure;
- `All Active Users`, `Active Licensed Users`, `Active Unlicensed Users` and `Cowork Users` count
  people with a usage row, so a person whose only use was a scheduled run is an active Cowork user;
- a new `Cowork Scheduled Runs` measure;
- `AI Tasks`, prompts, sessions and Cowork Fit stay prompt-only. Per-user session and prompt
  averages now include people whose only use was a scheduled run.

| Variant | Change |
|---|---|
| Fabric | Audit ingester notebook; both Fabric templates; the Fabric App's org-coverage count |
| Azure | `valuelens_core` DuckDB port (which now also keeps Copilot Studio runtime records, matching Fabric) |
| Local CSV | `Purview_CopilotInteraction_Processor_v4.0.0.py` (aibv profile) and template |
| SharePoint | Template. The scheduled path flattens with the upstream PAX processor that `Run-PAX-AIBV.ps1` downloads, so that needs a PAX follow-up; installs that run the Local CSV processor get the fix |
| Power Automate + Dataverse | `Build-DataverseCoreFeeds.py` and template |

**The app says when the install is older than the app (P1).** Pages that need newer model
columns, starting with Governance and the Agent 365 columns from #130, probe for them first. If
any are missing, the page shows **Update your install** and lists them, instead of four query
errors. Requirements are listed in one place (`src/lib/model-requirements.ts`), and any query that
fails on a missing column or table shows the same guidance. *Fabric App and installer only.*

**Optional modules left off are "not configured" (P8).** The installer now writes the chosen
modules into the app's `fabric.config.json`. A module that is off hides its pages, as an empty
source already did (#129), and the Feedback page explains it isn't set up rather than saying
"No feedback data". Installs without the field keep the data probe. *Fabric App and installer
only.*

**The Calendar covers more than the audit (P7).** It runs from the earliest to the latest of the
audit and product feedback dates, and on installer-built Fabric models the M365 Activity dates.
With none of them it holds the last 365 days, so date-sliced M365 and feedback visuals work before
the first audit load. *All five ValueLens templates, and the Fabric installer for M365 Activity,
which only it adds.*

**A blank or 0 Cowork limit means no limit (P9).** Allowance and headroom are blank, and nobody
is over or near the limit, instead of a negative headroom and everyone over. The app's Cowork
section shows **No limit set**. *All four Consumption Central templates and the Fabric App.*

**The Agent Evaluator writes empty tables in merge mode (P6).** With no transcripts and no
existing tables, merge and append now create the `dbo.agent_*` tables with their schema, as
overwrite does, and the log says what happened to each table. *Fabric only: the Agent Evaluator
notebooks run only there.*

The template DAX changes are applied by `scripts/Update-Template-Dax.py` (`--check` reports
templates that need it). Refresh a published model after updating its template.

---

## 2026-10-07 — Analytics Hub installer 0.3.2: Azure install fix

Every Azure install with the default settings (images pulled from the public
`ghcr.io/microsoft/valuelens-*` registry) failed at step 2, *Azure resources*, with
`InvalidTemplate: ... 'vl-containerapps' ... array index '2' is out of bounds`.

The template's optional private-registry step (the AcrPull role assignment) took its
subscription and resource group by splitting `imageRegistryResourceId`, and the Container Apps
deployment always depends on it. ARM evaluates those expressions while validating, even when
the step is switched off, so an empty registry id broke the deployment. `2. Azure/infra/main.bicep`
now parses a well-formed stand-in id when no private registry is set; installs that use a private
Azure Container Registry are unchanged.

The installer tests now evaluate the compiled template the way ARM validates it, with the
parameters the installer sends (default, private registry, private networking), so this class of
error fails CI. Previously CI only checked that the template matched the Bicep source and that the
parameter names and types lined up.

The tag publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.2`. To update, download
the installer again, open it and choose **Repair or change**.

---

## 2026-10-07 — Analytics Hub installer 0.3.1

The installer bundles the notebooks, templates and app when it is built, so this release brings
everything merged since 0.3.0 to installer users:

- the **Power BI reports**, published and connected to the semantic models (#128);
- the Fabric App's **Governance** page (#130), pages hidden when their optional source has no
  data (#129), and the Feedback card height and heatmap contrast fixes (#133);
- the Agent 365 registry ingester that checkpoints and resumes on large tenants, and no longer
  fails on agents with no detail (#131, #132).

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.1`, which the
Azure install pulls. To update, download the installer again, open it and choose
**Repair or change**.

---

## 2026-10-07 — Agent 365 registry: agents with no detail no longer fail the run

On large tenants, some agents' detail calls fail every time, typically with HTTP 424 *Failed
Dependency* on that package, and there can be more of them than the missing-detail tolerance
added in the previous entry allowed (25 agents or 0.5% of the catalogue). The run then failed,
even though every other agent's detail had been fetched.

The tolerance is gone. In the Fabric ingester (`Copilot_Agent365_Registry_Ingester.ipynb`) and
`Get-Agents365Registry.ps1`:

- **Any agent whose detail call fails is written list-only**, whatever the reason: 424, 404,
  403, or a 429, 5xx or network error after retries. Its list fields are kept, and the usage,
  Bot Id and capability columns are blank. In Fabric, `Detail status` records the reason, for
  example `missing (HTTP 424)`. The run prints a warning counting these agents by reason.
- **These agents are never cached, so every run retries them.** 424 and 404 are not retried
  within a run. An agent with cached detail still falls back to it (`cached - refetch failed`).
- **One safety net remains:** if every detail call failed with 401 or 403 and there is no cached
  detail, sign-in or consent is broken, so the run fails without writing rather than replacing
  the registry with one that has no detail at all.
- `MAX_MISSING_DETAIL` / `MAX_MISSING_DETAIL_PCT` and `-MaxMissingDetail` / `-MaxMissingDetailPct`
  are removed. A notebook whose config cell still sets them runs unchanged; the values are ignored.
  Scripts or scheduled tasks that pass the PowerShell parameters must drop them.

Also fixed: **`Last updated` no longer flips between runs.** For a few agents per tenant, the
detail payload's `lastModifiedDateTime` differs from the list's. A freshly fetched agent took the
detail's stamp and a cached one took the list's, so `Last updated`, which is part of the
`agents_365_history` key, changed whenever an agent moved between fetched and cached. Each change
added a duplicate history row: 499 rows for 495 agents after three runs on one test tenant.
`Last updated` is now always the list's stamp (the one change detection keys on), falling back to
the detail's only when the list has none. This applies to the notebook and the PowerShell script.
History rows already written are left as they are.

To pick it up, re-import the notebook (or update the script) and rerun it. If you patched the
detail loop by hand to skip 424s, drop that patch: the updated notebook handles them. See the
[data dictionary](docs/DATA-DICTIONARY.md).

---

## 2026-10-07 — Agent 365 registry: first runs on very large tenants resume instead of starting over

On a first run there is no detail cache, so a tenant with ~20,000 agents makes ~20,000 detail
calls. Before this change, one failed call among them failed the whole step, the cache was
written only at the very end, and so every successful fetch was thrown away. The next run then
started from zero again. The step 4 cell then failed with `NameError: name 'details' is not
defined` instead of saying what went wrong.

The Fabric ingester (`Copilot_Agent365_Registry_Ingester.ipynb`) and its PowerShell twin for the
CSV, SharePoint and Power Automate + Dataverse templates (`Get-Agents365Registry.ps1`) now:

- **Checkpoint the detail cache during the fetch** (every 1,000 successful calls, and again if
  the run fails), so a rerun fetches only what is still missing. Checkpoints hold only freshly
  fetched detail, so a changed agent is never marked as seen with stale data.
- **Retry network timeouts, dropped connections, 500 and 502** with the existing backoff, as
  well as 429, 503 and 504.
- **Tolerate a few agents with no detail**, for example a 404 or 403 on one package: up to 25
  agents or 0.5% of the catalogue, whichever is larger. These agents are written list-only and
  retried next run. In Fabric they carry a new snapshot column, `Detail status` = `missing`. An
  agent whose refetch fails keeps its cached detail. Above the tolerance the run fails clearly,
  listing the failure reasons, and leaves the previous registry in place.
- **Print the expected duration and progress with an ETA** every 500 calls.
- **Guard each notebook step**, so a failed step stops later cells with a message naming it.

To pick it up, re-import the notebook (or update the script) and rerun it; if the run is
interrupted, run it again and it resumes from the cache. The 48-column CSV contract is
unchanged. See the [data dictionary](docs/DATA-DICTIONARY.md).

---

## 2026-10-07 — Analytics Hub app: pages without data no longer appear

The app (Fabric and Azure) now checks the ValueLens model's optional sources when it opens, and
leaves out what would be blank:

- **Feedback** is hidden until `ProductFeedback` has rows, and **Work patterns** until
  `M365 Activity` does. Links to them (the Executive summary's attention items, page footers)
  disappear too, and the Executive summary drops its Satisfaction card.
- Without Agent 365 registry data, **Governance** shows one *Connect the Agent 365 registry* state
  instead of four empty sections. **Leaderboards** keeps the agent usage and leaderboard, drops the
  registry-only columns, and drops its link to Governance.
- The check is unfiltered, so a filter that empties a page never hides it. If the check fails for
  any reason other than a missing table, everything stays visible.

---

## 2026-10-07 — Analytics Hub installer: the Power BI reports

The installer can now publish the reports from the Power BI templates, already connected to the
semantic models it deploys: `ValueLens`, and `Consumption Central` and `Agent Evaluator` with their
modules. It's the new default for Power BI, alongside the model and the app, so nobody needs Power BI
Desktop. The plan lists the reports, and the summary links to them.

A new installer version that brings a changed report asks before replacing it, because that
replaces edits made in Power BI. A report that can't be published is reported, and the rest of the
install carries on. If you're a Fabric administrator, the installer also checks the tenant setting
*Allow visuals created using the Power BI SDK*, which the Tornado chart, Word cloud and Deneb
visuals need. See [Power BI reports](1.%20Fabric/installer/README.md#power-bi-reports).

An earlier install gets the reports offered the next time you choose **Repair or change**.
Installer users get this in the next installer release.

---

## 2026-10-07 — Analytics Hub installer 0.3.0: the Azure target, and demo mode

This is the first release that can install Analytics Hub in **your own Azure subscription**
instead of Fabric (preview, see [2. Azure](2.%20Azure/README.md)). Pick **Your Azure subscription**
as the first wizard answer. The tag also publishes the `valuelens-jobs` and `valuelens-web`
images to `ghcr.io/microsoft` with the same version, which the Azure install pulls.

- **Demo mode (sample data).** After the data tick boxes, the Azure wizard asks whether the
  dashboard shows your tenant's data or a synthetic sample. Demo mode deploys everything as usual,
  but each run publishes the sample bundled in the jobs image, moved forward to end last week.
  Run the installer again and pick your tenant's data to switch.
- The Fabric App's page canvas has one scrollbar instead of two (#125), for both targets.

To update a Fabric install, download the installer again, open it and choose **Repair or change**.

---

## 2026-10-07 — Paths renumbered: Azure second

The Azure path (preview) joins the numbered paths, second after Fabric, because it's the other
route that installs everything for you:

| Was | Now |
|---|---|
| `5. Azure` | `2. Azure` |
| `2. Power Automate + Dataverse` | `3. Power Automate + Dataverse` |
| `3. SharePoint` | `4. SharePoint` |
| `4. Local CSV` | `5. Local CSV` |

`1. Fabric` is unchanged. Only paths changed: links, the CI workflows, the Dockerfiles, the tests and
the installer all point at the new folders, and the older entries below use the new paths so their
links keep working. Released installers are unaffected, because they bundle what they deploy rather
than downloading it from the repo. Bookmarks and links from outside the repo to the old folder names
will break, because GitHub doesn't redirect renamed folders.

---

## 2026-10-06 — Analytics Hub installer 0.2.5

The installer bundles the notebooks and templates when it is built, so this release brings
everything merged since 0.2.4 to installer users:

- the **Data sources** screen, with the API, a CSV upload or Skip for every source, one drop
  folder for CSV exports, and product feedback;
- the Viva Insights Dataflow for Cowork credits, the Power Automate flows for product feedback
  and Copilot Studio credits, and the Analytics Hub names;
- agent type, publisher and consolidated name in the audit processor;
- one shared Spark session per run, a card for each source, `dbo.load_log`, **Rerun failed
  loads**, the SQL endpoint sync before the model refresh, and a data check that explains an
  empty Copilot interactions table;
- the Fabric App's Executive summary page.

To update, download the installer again, open it and choose **Repair or change**.
---

## 2026-10-06 — Analytics Hub installer: fewer busy-capacity failures, and clearer ones

- **One Spark session per run.** The pipeline's notebooks now share a high-concurrency Spark
  session, instead of each starting its own. Small capacities are much less often too busy to
  start them (`TooManyRequestsForCapacity`). The installer turns the workspace setting on; that
  needs the workspace Admin role, and without it the installer warns and carries on.
- **A card for each source.** After a run, the installer says which sources loaded, failed,
  were skipped or are still running. A failure says why in plain words, such as a busy capacity,
  a sign-in problem, a timeout or a missing export, and what to do.
- **`dbo.load_log`.** A new last pipeline step, `AnalyticsHub_Load_Status`, records the same
  thing in the Lakehouse, one row per source per run. It fails the run when a load failed, so
  Fabric's run history and alerts show it.
- **Rerun failed loads.** A new command and button runs only the loads that failed, and the
  steps and refreshes after them. It waits and tries again while the capacity is busy, and so
  does the data check after a run.
- **The model refresh waits for the SQL endpoint.** `AnalyticsHub_Refresh_Model` now asks the
  Lakehouse SQL endpoints to sync before it refreshes the model. Before, a refresh straight after
  a load could fail with *Table '…' is not in database*. If it still happens, the card says so
  and suggests a rerun.
- **An empty Copilot interactions table says why.** When the audit log only held test or admin
  activity, such as Copilot Studio test runs (*Maker evaluation*), the Audit Log Processor leaves
  all of it out and the table is empty. The data check now counts what was left out and why,
  instead of just reporting 0 rows.

Installer users get this in the next installer release.

---

## 2026-10-06 — Analytics Hub installer: a Viva Insights Dataflow, Power Automate flows and new names

- **Cowork credits** can come straight from a Viva Insights query. Choose **Connected (Dataflow)**
  and give the partition and query IDs. The installer creates the Dataflow Gen2
  `AnalyticsHub_Cowork_Credits`, and the pipeline refreshes it before each Viva load. The CSV
  export is still the fallback. `Ingest_Viva_Consumption` reads both, and the Dataflow wins for
  weeks both cover.
- **Copilot Studio credits** can come from the Power Platform licensing API. An optional flow,
  `Analytics Hub - Copilot Studio credits`, saves the last ten days by agent each day.
  `Ingest_Studio` loads them into the new `studio_agent_daily` table, and fills the tenant and
  agent views for days and months no export covers. It only sees environments with credits
  allocated, and exports still add per-user figures.
- **The product feedback flow** is now created for you in Power Automate, turned off, instead of
  written to a file to import. Both flows read the app's secret from Key Vault; you sign in to
  their connections and turn them on.
- **New names.** A new install calls its items Analytics Hub: `Analytics Hub Model`,
  `AnalyticsHub_Pipeline`, `Analytics Hub SQL …` and `Analytics Hub Data Collector`. Existing
  installs keep their names.

Installer users get this in the next installer release.

---

## 2026-10-05 — Task time estimates cite peer-reviewed sources

The `Human Time Estimates` table in all five templates now cites peer-reviewed studies or major
research institutions, such as Noy & Zhang (*Science* 2023), Brynjolfsson et al. (NBER) and
Microsoft Research CHI papers, instead of vendor surveys, blogs and landing pages. Links are DOIs
where one exists. Rows with no credible time study now say *Provisional estimate*, have no link
and are rated Low. No confidence went up, and no minutes changed, so value and hours-saved figures
are the same. The Fabric App reads the new sources from the model. Installer users get this in the
next installer release.

---

## 2026-10-05 — Analytics Hub installer 0.2.4

The installer bundles the notebooks and templates when it is built, so this release brings
everything merged since 0.2.3 to installer users: the plain-English task descriptions and App host
in the glossary, one name for each task level, the review fixes below, agents linked even when they have no name, and an incremental Agent 365
registry pull. It also stops the installer overwriting another install's client secret in a Key
Vault you already have.

To update, download the installer again, open it and choose **Repair or change**.

---

## 2026-10-05 — Analytics Hub review fixes

**Templates, all four paths, and the Fabric App.**
- **🌱 Habit Formation** follows the date filter. Stages use the most recent complete month in
  the selected dates, capped at the last complete month in the data. Before, they always used the
  last complete month, whatever dates were picked. Inactive is now blank for Unlicensed users and
  Agents as well as Cowork, since none of them have a seat to measure against. The app says so,
  and shows a message instead of a trend when the dates cover fewer than two months.

**Consumption Central add-on, all four paths.** Models named from Azure meters are spelled the
way OpenAI writes them: GPT-4o, o4-mini, GPT-5.4, GPT-4.1 and GPT-5, not "Gpt 4O", "O4 Mini" and a
bare "5.4". Other meters, such as Pay As You Go Copilot Credit, keep their names. The app's Cost
by model and Foundry resources views show the new names even before the template is updated.

**Fabric App.**
- **Feedback** counts only feedback dated inside the Calendar, as its weekly trend always did.
  Feedback sent outside the report's dates no longer inflates the totals, satisfaction, topics
  and surfaces.
- **Cowork fit** with License set to Unlicensed says Cowork needs a Copilot license, the same as
  the Cowork leaderboard does, rather than suggesting there's no Cowork activity yet.
- **Agent registry** keeps its side panel below the table until the window is extra wide, so the
  table's columns aren't squeezed on a laptop screen.

**Agent Evaluator add-on.** **Knowledge Answered Rate** is now a share of knowledge searches, the
complement of **Knowledge Gap Rate**, so the two add up to 100%. It used to divide by every
session, so the Knowledge Gap focus card understated how often searches found an answer. The
card's content gap is now the Gap Rate itself.

**Fabric installer.** In a Key Vault you already have, the installer no longer overwrites another
install's client secret. If the secret name is taken by a secret that isn't this app's, it is
left alone and the new secret goes in the next free name, such as `valuelens-client-secret-2`.

## 2026-10-05 — One name for each task level, and Fabric App review fixes

**Templates, all four paths.** Every page now calls the 12 task groups **Task Category** and the
detailed tasks **Task Breakdown**. Before, Estimated Value said Category and Task, and the
Leaderboard said task group and task category. Engagement charts say **Engagement mode**. The
**🧬 Appendix: Signal → Impact** table adds a plain-English **Description** of each task, and the
**📖 Metric Glossary** explains App host and why it makes the task mix indicative. Download the
template again to get these. The installer picks them up in its next release.

**Fabric App.**
- The filter bar alone picks Licensed, Unlicensed, Agents or Cowork. The pages' own Cohort
  switches, which could disagree with it, are gone.
- Work patterns: an org filter no longer inflates active days or drops weeks from the trend.
- Feedback: feedback with no date stays out of the weekly trend.
- Consumption: Cowork credits name each person, instead of one "(No value)" row.
- Value: a return just below 1x shows as a loss, such as 0.97x in red, never as break-even.
- Adoption: the Activation headline reads as one sentence.
- Tables fit their headers, date slicers say Date, and the Value task chart's switch reads
  "Break down by".

---

## 2026-10-05 — Analytics Hub installer 0.2.3: a busy trial capacity

On a Fabric trial or a small capacity, the first load could fail with `TooManyRequestsForCapacity`.
The pipeline started about six notebooks at once, and Fabric turned some of them away. The pipeline
now runs its notebooks in two lanes, so no more than two run at the same time. If a notebook still
fails, the pipeline waits five minutes and tries it again. If Fabric is still too busy after that,
the installer says so in plain words: nothing is lost, wait a few minutes and choose **Run now**
again.

If this happened to you, download the installer again, open it and choose **Repair or change**. It
offers to update the pipeline and to run the first load again. Until the first load succeeds,
**Run now** runs it again, with the audit history you picked.

---

## 2026-10-05 — Analytics Hub installer 0.2.2: a Key Vault that another workspace already reads

If you picked a Key Vault that blocks public access, and another Analytics Hub workspace already
reads it, the installer mistook that workspace's approved connection for its own. It never approved
the new one, waited 20 minutes, and stopped at **Workspace and Lakehouse** with "Waiting for Fabric
to see the approval for more than 20 minutes". It now finds its own connection by the workspace ID
and approves it.

If this happened to you, download the installer again, open it and choose **Repair or change**. It
approves the waiting connection and carries on.

---

## 2026-10-05 — Analytics Hub installer 0.2.1: Back, and Lakehouse names with spaces

Every question now has a **Back** button, and so does the plan. Back opens the previous question
with your answer filled in, and the questions after it are asked again. Going back reuses what the
installer already looked up in your tenant, so it's quick. If you go back to the client secret, an
empty box keeps the one you pasted. If you go back further, you'll be asked for it again. The
secret still isn't saved in the install record or shown on the page.

The Lakehouse name now takes spaces and hyphens. Fabric doesn't allow them, so they become
underscores, and the installer says so: `My Lakehouse` becomes `My_Lakehouse`.

---

## 2026-10-05 — Analytics Hub installer 0.2.0: tick what to collect

**What to collect** is now a list of tick boxes, and each one says where its data comes from and
what it shows. Copilot usage, licences and org data are always collected, because the dashboard is
built on them. Their boxes are ticked and locked. Microsoft 365 activity is ticked. The Agent 365
registry, product feedback, credit consumption and the Agent Evaluator aren't. Copilot Studio
transcripts are now called **Agent Evaluator**, after the page they feed. An install record that
turned org data off turns it back on, so the next update also updates the pipeline.

The installer is also safe in a workspace that already has things in it. It never changes an item
it didn't create. If one of its names is taken, its own item gets the next free name, such as
`ValueLens_2`, and the plan shows the names before you approve it.

---

## 2026-10-05 — Fabric: one folder for setting up by hand

`1. Fabric` now holds only its README, the installer, the Fabric App and a new
[`Manual setup`](1.%20Fabric/Manual%20setup/) folder. Everything for setting up by hand moved into
it: the two report templates, `notebooks/`, `pipelines/`, `flows/` and both add-ons. The add-ons'
notebooks now sit with the others, in `notebooks/credit-consumption/` and
`notebooks/agent-evaluator/`, and the Workday overlay moved from `notebooks/optional/` to
`notebooks/workday-org-data/`. The installer reads the new paths. The published installer exe
carries its own copy of these files, so it isn't affected. Old links to the moved folders no
longer work.

The Fabric README's optional extras now say what each one shows and where its data comes from.

## 2026-10-05 — A leaner repo: simple steps, less clutter

Every path README is now just the steps to follow. The root README is a short path picker, and
the Fabric README walks through the installer exe. The notebooks, pipeline, flows, add-on and
Fabric App READMEs cover only the manual steps they're needed for.

Removed: the archived Fabric templates and extended references (`1. Fabric/archive/`), the
Dataverse path's archive, the Fabric design docs and checker (`1. Fabric/docs/`), the architecture
diagrams, page screenshots, `scripts/sync-shared.ps1` and its workflow, and two one-off fix
scripts. The old Power BI templates are kept, flat, in [`archive/`](archive/). The retired credit
cost table is gone from the [data dictionary](docs/DATA-DICTIONARY.md); its ingester was already
archived and no template read it.

The pipeline still carries its `EnableConsumption` branch, off by default, so existing pipelines
keep working.

---

## 2026-10-05 — Analytics Hub installer: download and double-click

`AnalyticsHubInstaller.exe` runs the installer without Node.js, a terminal or a clone of this repo.
Download it from the repo's releases and double-click it: it unpacks once to
`%LOCALAPPDATA%\AnalyticsHub` and opens the installer in your browser. It carries the notebooks,
pipeline, semantic models and a ready-built Analytics Hub app, and keeps the install record in
`Documents\Analytics Hub`. The app now reads its model IDs from a `fabric.config.json` deployed
next to it, so one build serves every tenant; deploys from a clone still use `fabric.yaml`.
Messages name `AnalyticsHubInstaller.exe` when it started the installer. A new `installer-exe`
workflow builds and smoke-tests the exe, and drafts a release for each `installer-v*` tag. See
[Download and run](1.%20Fabric/installer/README.md#run-it).

---

## 2026-10-04 — Fabric installer: now the Analytics Hub installer

The installer now calls itself the Analytics Hub installer in its README and in the descriptions
it gives what it creates: the app registration's notes and client secret, and the semantic model,
notebooks and pipeline. The command is still `npx valuelens-install`, and the data-side names (the
Lakehouse, notebooks, pipeline and models) still say ValueLens.

---

## 2026-10-04 — Fabric installer: check the data again

The data check isn't part of the pipeline, so the scheduled runs never updated it, and `status`
went on showing what the first load found. `status` now says when the pipeline has run since the
last check, and `npx valuelens-install check` (or **Check the data** in the browser) runs the check
again on its own, without the pipeline. See [Commands](1.%20Fabric/installer/README.md#without-the-exe).

---

## 2026-10-03 — Fabric installer: in your browser

`npx valuelens-install --ui` runs the installer as a page in your browser instead of the terminal.
It opens on a home page: set up Analytics Hub, or, once it's installed, run the pipeline, refresh
the models, check status, update, redeploy the app, create new secrets, or repair the set-up. The
questions, the plan and each step's progress appear on the page, and nothing is created before you
approve the plan. You can save the plan, or a record of a finished run, as Markdown. It works on a
phone-sized window too.

The page is served on `127.0.0.1` only and opens from the link the installer prints; every request
needs the key in that link. Pasted secrets never reach the page's history or the saved record. The
terminal mirrors the page and must stay open. See
[In your browser](1.%20Fabric/installer/README.md#run-it).

---

## 2026-10-03 — Fabric: Copilot pay-as-you-go billed in Azure

The Copilot Studio and Cowork credit figures come from exports that count credits, not what was
charged. Credits beyond prepaid capacity are billed to the Azure subscription on a Power Platform
billing policy, and Azure Cost Management records that bill. The Consumption pages now show it.

`Ingest_Azure_AI` reads Copilot pay-as-you-go from the Azure AI subscription and any listed in
`PAYG_SUBSCRIPTION_IDS`, splits Copilot Studio from Cowork by the tag Azure puts on the charges, and
writes `copilot_payg_spend`. The installer reads the billing policies to find their subscriptions,
gives the app registration Cost Management Reader on each one, and adds a `CopilotPaygSpend` table
to `ValueLens Consumption Model` at deploy time. The Power BI template doesn't change. A
subscription it can't grant, or billing policies it can't read, are left out with a note, rather
than failing the run.

In the Analytics Hub, the Copilot Studio stage has a **Pay-as-you-go billed in Azure** panel: daily
cost or credits by product for the same period, with totals, the subscriptions and how the bill
compares with the export. The Cowork stage notes what Azure billed for Cowork. Billing can lag usage
by a day or more, and no currency conversion is done. Without the table, both stay hidden. See the
[data dictionary](1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/DATA-DICTIONARY.md#copilot_payg_spend).

---

## 2026-10-03 — Fabric: Microsoft 365 activity and the Work patterns page

The installer has a new module, **Microsoft 365 activity**, on by default. Its notebook,
`Copilot_M365_Activity_Ingester`, reads the Microsoft 365 usage reports from Graph (Teams, Outlook,
SharePoint, OneDrive, Viva Engage and the Microsoft 365 apps) into one row per person per active
day. It uses `Reports.Read.All`, which the core already has. The installer adds it to the pipeline
behind `EnableM365Activity`, and adds an `M365 Activity` table to `ValueLens Model` at deploy time.
The Power BI templates don't change. `update` adds the module to existing installs, and the
installer's data check reports the activity table's rows and dates after each `run`.

The Analytics Hub app has a new **Work patterns** page: people active, active days, meetings and
email per week, how far each workload and app reaches, how many of the apps each person uses and on
which devices, and how Copilot users' working weeks compare with everyone else's, overall and by
organisation. The page says which days its figures cover, explains how each is worked out, and
puts organisations with fewer than five active people into one *Smaller groups* row. With the
activity loaded, Readiness's *Who to
license next* adds breadth, the Microsoft 365 workloads someone uses a day, to its priority score:
50 / 30 / 20 for tasks, days and breadth, instead of 60 / 40. People with no Microsoft 365 activity
keep the 60 / 40 score.

If the tenant conceals user names in reports, the activity can't be matched to people. The
notebook and the page say so and how to fix it, and the notebook reloads those days once the
setting is off. See the [methodology](docs/METHODOLOGY.md#84-work-patterns).

---

## 2026-10-03 — Fabric App: renamed Analytics Hub

The [Fabric App](1.%20Fabric/Fabric%20App/) is now called **Analytics Hub**: the browser tab, the
sidebar title, the page that points visitors to Fabric, and the installer's prompts. The data side
keeps the ValueLens name: workspace, Lakehouse, models, pipeline and app registration.

The installer renames an app item still called `valuelens` or "AI in One 2.0" the next time it
runs, even if you don't rebuild the app. A name you gave it yourself is kept. A manual
`rayfin up` still creates an item called `valuelens`; rename it in the workspace.

---

## 2026-10-03 — Fabric installer: Agent Evaluator

The installer can now set up the [Agent Evaluator](1.%20Fabric/Manual%20setup/Add%20Agent%20Evaluator/) from
[AgentEvaluator-for-Copilot-Studio](https://github.com/microsoft/AgentEvaluator-for-Copilot-Studio),
so the app's Agent Evaluation pages show how Copilot Studio agents perform. It's off by default.

Choose it and the installer lists the Power Platform environments you're a member of. In each one
you pick, it adds the app registration as an application user with the Bot Transcript Viewer role,
or prints the admin center steps if you aren't a System Administrator there. It deploys the
transcript parser notebook with those environments, adds it to the pipeline in merge mode so
history builds past Dataverse's 30 days, and deploys the `ValueLens Agent Evaluator Model` on the
ValueLens model's connection. The app is rebuilt with the model as its `ae` source.

The parser and template are copied from upstream commit `e37b1ac`. The notebook gains one cell that
looks up each user's UPN in Entra, so agent sessions join to org data. The installer adjusts the
template so the service can bind it to the Lakehouse connection, and so it refreshes before the
parser's first run, when it reads empty tables.

---

## 2026-10-03 — Fabric: licences that don't match people, and agent accounts

A walk-through of an older AI in One 2.0 install found three problems that our sample data
never showed.

**Hidden user names.** When the Microsoft 365 setting "Display concealed user, group, and site
names in all reports" is on, the licensed-users table holds hashed names that can't match the
audit log. The app then said 0 licensed and everyone unlicensed, with no explanation. The
`ValueLens_Data_Check` notebook now spots the hashed names and prints the admin center fix, and
the installer's data check repeats it. It also reports how many people using Copilot have a licence.

**Readiness without a matching roster.** "Who to license next" ranked every active user as if
nobody had a licence. When the roster doesn't match, Readiness now says so at the top and on the
list, and the dormancy chart explains why it is empty.

**Agent accounts counted as people.** Security Copilot agents sign in as
`SecurityCopilotAgentUser-<id>`; in that install they made 62% of audit rows and topped the
licence list. `Copilot_Audit_Log_Processor` now drops them by default
(`EXCLUDE_AGENT_IDENTITIES`, `AGENT_IDENTITY_PATTERNS`). Only the Fabric path has this so far;
Power Automate + Dataverse, SharePoint and Local CSV will follow.

---

## 2026-10-03 — Fabric App: readable consumption charts over time

The Copilot Studio "Consumption over time" and "Cost over time" charts were unreadable.
Each of about 90 daily bars carried a white value label, and the date axis showed no dates,
because every day got its own text slot only a few pixels wide. The days now sit on a real
time axis with a tick each week, the bars keep a sensible width at any panel size, and the
value labels are gone. Hover over a bar to see the day's numbers.

The Cowork / Work IQ weekly "Cost over time" chart also loses its per-bar labels, which showed
uneven decimals and a stray 0 on every week with no pay-as-you-go spend. The Azure "Foundry cost
over time" chart now has the same weekly date ticks as Copilot Studio, where before it showed only
the first of each month.

`rayfin up` could fail with "No rayfin/.temp/compiled/data/*.js files found" after the app
folder moved or `rayfin/.temp` was cleared. The data service shared the app's TypeScript build
cache, so the compiler thought it was up to date and emitted nothing. It now keeps its own cache
inside `rayfin/.temp/compiled`.

## 2026-10-03 — Paths renumbered: Fabric first

The path folders are renumbered so the recommended route comes first, and the web app now lives
inside the Fabric path:

| Was | Now |
|---|---|
| `3. Fabric` | `1. Fabric` |
| `4. Power Automate + Dataverse` | `2. Power Automate + Dataverse` |
| `2. SharePoint` | `3. SharePoint` |
| `1. Local CSV` | `4. Local CSV` |
| `5. Fabric App` | `1. Fabric/Fabric App` |

The templates, notebooks, scripts and app are unchanged apart from the paths they mention.
Links in this repo, the CI workflows, the tests and the installer all point at the new folders,
and the older entries below use the new paths so their links keep working. Bookmarks and links
from outside the repo to the old folder names will break, because GitHub doesn't redirect renamed
folders. Local CSV is still the place to start if you just want to see the dashboard. If you run
the app from a clone, `cd "1. Fabric/Fabric App"` instead of `cd "5. Fabric App"`.

## 2026-10-03 — Fabric App: small costs

On the Consumption pages, cost axes printed every tick as a whole number, so a tenant that had
spent a few cents saw a column of zeros. The axes now show as many decimals as the ticks need
(0.0001, 0.0002…) and still show whole numbers for ordinary spend. Cost cards and grid cells show a
real spend under half a cent as "<$0.01" instead of "$0.00", which read as free.

## 2026-10-03 — Consumption Central: Foundry token counts

`[Foundry Tokens (M)]` treated every Azure token meter as billed per 1M tokens. Older meters are
billed per 1K, so 212 tokens showed as 0.2 million. The measure now reads the unit from the meter
name: meters with "1M Token" are per million, other token meters are per thousand, and meters that
aren't tokens (pages, images, hours) count as zero. `[Foundry Cost per 1M Tokens]` is corrected by
the same change. Fixed in all four [Consumption Central](1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/)
templates. The sample data only uses per-1M meters, so its figures don't change.

The [Fabric App](1.%20Fabric/Fabric%20App/) now shows token counts at their own scale (212, 45K, 1.3M)
instead of in millions, where small counts rounded to 0.0.

## 2026-10-02 — Fabric installer: credit consumption

The [installer](1.%20Fabric/installer/#credit-consumption) has a new optional module, *Credit
consumption*, that sets up [Consumption Central](1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/) in the
same Lakehouse. It deploys the Azure AI, Copilot Studio and Cowork notebooks into the pipeline. It
gives the app registration read-only Azure roles on the subscription you choose, and makes the
upload folders. It also deploys `ValueLens Consumption Model` and adds it to the app, which turns
on the Consumption pages. Copilot Studio and Cowork have no API, so the installer prints the
steps to land their exports. `Ingest_Viva_Consumption` now skips quietly when there's no CSV, in
the installer's copy only.

## 2026-10-02 — Fabric: installer

New [`1. Fabric/installer`](1.%20Fabric/installer/): run `npx valuelens-install` to set up the
Fabric path in one go. It checks the tenant and asks a few questions. It then creates the app
registration, with its secret in Azure Key Vault, and grants admin consent, or gives you a link
for an admin. It also sets up the workspace, Lakehouse, notebooks, pipeline and schedule. Last,
it runs the first load and reports what arrived. The notebooks read the secret from Key Vault
when they run.

If Azure Policy makes the vault private, the installer saves the secret through Azure Resource
Manager. It also connects the workspace to the vault with a managed private endpoint and
approves it.

Its answers and IDs are saved in `valuelens-install.json`, which holds no secrets. Re-running it
repairs what is missing. Other commands: `update`, `run`, `status`, `rotate-secret` and
`preview`. The canonical notebooks and pipeline JSON are unchanged; the installer fills in a copy
of each as it deploys.

It can also deploy the semantic model from `ValueLens - Fabric.pbit` and the ValueLens app
(`1. Fabric/Fabric App`) on top of it, so nothing has to be published from Power BI Desktop. The model
reads the Lakehouse through a cloud connection that signs in as the app registration. A new
notebook, `ValueLens_Refresh_Model`, refreshes the model as the pipeline's last step. New
commands: `refresh` and `deploy-app`.

## 2026-10-02 — Fabric App: reloads itself after a deploy

A page opened before a deploy used to fail on its next page change with *Failed to fetch
dynamically imported module*, because the deploy replaces the app's code files. The app now
reloads once to pick up the new build. If the same error comes back straight away, it stays on
screen rather than reloading again.

## 2026-10-02 — Fabric App: renamed AI in One 2.0

The [Fabric App](1.%20Fabric/Fabric%20App/) is now called **AI in One 2.0**: the browser tab, the sidebar
title and the page that points visitors to Fabric all use the new name. The data model is still
ValueLens, and nothing else in the app changes. A new deploy still creates an item called
`valuelens`; rename it in the workspace to match.

## 2026-10-02 — Fabric App: change the task times

The [Fabric App](1.%20Fabric/Fabric%20App/) has a new reference page, **Assumptions**. Its **Time per
task** stage lists the Conservative, Typical and Optimistic minutes behind each task's hours, with
the research link and confidence for each, and the hours each task gives at Typical.

Type over any minutes to match your organisation; the page shows the hours before you save.
**Save for everyone** stores them in the app's SQL database, in a new `TaskTime` table, and every
page in the app then values work at them. **Use research** puts a task back. Cowork hours keep their
task-category bands. The Power BI report, and the CSV, SharePoint, Fabric and Power Automate
paths, keep the model's `Human Time Estimates`.

---

## 2026-10-02 — Fabric App: the hosting address points to Fabric

Opening the [Fabric App](1.%20Fabric/Fabric%20App/) at its `…fabricapps.net` hosting address used to offer
a sign-in, then fail every visual with *Not running inside a Fabric iframe*, because the app's
data only loads through Fabric. That address now shows an **Open in Fabric** button that goes to
the app's Fabric item, in the tenant it was deployed to.

---

## 2026-10-02 — Fabric App: cost vs value

The [Fabric App](1.%20Fabric/Fabric%20App/)'s Value page ends with a new stage, **Cost vs value**. It sets
Microsoft 365 Copilot licences, Copilot Studio credits and Cowork / Work IQ credits against the
estimated value of the work each pays for, over the days ValueLens and Consumption Central both
hold. It shows the return on cost, with a conservative-to-optimistic range, and the break-even
hourly rate. It also shows each cost beside its value, and each Copilot Studio agent's share of
the cost beside that agent's value. Copilot Chat by people without a licence is left out of the
value, because it's free with Microsoft 365.

A **Prices** menu on the stage saves a licence price (the $30 US list price by default) and an
exchange rate, alongside the shared rates. A **Scenario** switch beside it changes the effort
scenario here and on Estimated value; it starts at Typical. Saving rates or prices now writes only the fields that
changed, so one person's save no longer overwrites another's. In the Consumption Central sample,
seven of the eight Copilot Studio agents now share names with the ValueLens sample's agents, so
the agents comparison has data. Onboarding Buddy is left unmatched on purpose. The sample's Cowork credits
now follow the ValueLens sample's Cowork pilot, with a session for each Cowork thread, so both
samples describe the same company. Cowork credits are priced as the Consumption page's Cowork
section prices them: Capacity Pack first at the prepaid rate, then pay-as-you-go. The method is in
[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md#83-cost-vs-value).

---

## 2026-10-01 — Fabric App: set-up checked from a fresh clone

A clean Windows clone of `1. Fabric/Fabric App` now passes every README step: `npm install`, build, test,
lint and a `rayfin up` dry run. Two query tests failed when Git checked the `.dax` files out with
Windows line endings, and `npm run lint` reported one error in the query hook; both are fixed. The
README now asks for Node.js 22.13 or later, the oldest 22.x release the build tools support.

---

## 2026-10-01 — methodology: from signal to task category

[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md#32-from-signal-to-task-category) has a new section
that traces each audit signal to its behaviour, its task category and its Cowork category. It lists
every rule in order, the agent keywords, the workflow split, the Cowork file-type test and the
behaviour-to-category table, with worked examples. It also notes that paths 1, 2 and 4 don't read
the agent registry or split workflows, and corrects how the doc described the value outcome and
Could have used.

---

## 2026-09-30 — a methodology document

[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) explains how ValueLens turns audit records into each
figure. It covers how records are flattened and counted, the classification rules, the value
model for Copilot, agents and Cowork, the rules behind every page, the settings you can change, and
the Fabric App's Consumption and Agent Evaluation pages. An appendix lists every time band with
its source. The root README's maturity bullet now describes the Habit Formation stages the report
actually uses.

---

## 2026-09-30 — Fabric App: a Consumption page from Consumption Central

The [Fabric App](1.%20Fabric/Fabric%20App/) has an eighth page, **Consumption**. It reads a published
Consumption Central model, bound as a second connection (`cc`), and rebuilds that report's
consumption and cost pages. There are four sections: all products side by side, Cowork / Work IQ,
Copilot Studio and Azure. The Cowork and Studio sections each switch between a Consumption view
and a Cost view, and keep the report's period, service and group-by choices. Azure shows the
whole-solution cost export when one is loaded, and Azure AI Foundry model spend otherwise. The
Consumption Central model is optional: without it, the page says what to connect. The app also
opens in light mode by default again.

---

## 2026-09-30 — path 5: the ValueLens Fabric App (preview)

A new top-level folder, [`1. Fabric/Fabric App`](1.%20Fabric/Fabric%20App/), holds ValueLens rebuilt as a web
app. It's hosted as an item in a Fabric workspace and queries the published ValueLens model live,
as the viewer. It runs on the model from any of paths 1–4, because all five templates carry the
fields it uses. It has seven pages: Adoption, Leaderboards, Readiness, Value, Efficiency,
Feedback and Appendix. Deploy it with `npx rayfin up`; see the folder README. The app was
developed under `1. Fabric/app` and has moved here unchanged.

---

## 2026-09-30 — task names without the "Agent:" prefix

Eleven task names started with "Agent:". Cowork and agent sessions that don't match a more
specific task are given these names, so filtering to Cowork showed a list of "Agent:" tasks.
The prefix is gone: for example, "Agent: Knowledge Base" is now **Knowledge Base**. Two names change more:
"Agent: General Purpose" is now **General Assistance**, and the "Specialist Agents" efficiency
group is now **Specialist Support**. The baselines, value outcomes and colours are unchanged.
All five templates, both processors (the Fabric notebook and the Local CSV / SharePoint /
Power Automate script), and the sample data carry the change.

- **Reprocess existing data once.** The templates look up the new names, so rows processed
  before this change have no time baseline until they're reprocessed. In Fabric, run
  `Copilot_Audit_Log_Processor` with `WRITE_MODE = "overwrite"`, which is the default. For the other
  paths, rerun `Purview_CopilotInteraction_Processor_v4.0.0.py` over your export.
- **Saved filters.** If you built your own visuals or bookmarks that filter on an old name, re-pick
  the new name.

---

## 2026-09-30 — Task Breakdown Users column blank on Cowork / Copilot

On **Task Breakdown**, the Users column in the Organization and Agent tables was bound to
`[Active Agent Users]`, which hard-codes `[Agent Filter (Normalized)] = "Agents"`. Selecting
the Cowork or Copilot button intersected that with a different segment, so every Users cell
went blank while Sessions still populated. Both tables (and the Value Outcome table's sort)
now use `[All Active Users]`, which follows the selected Licensed / Agents / Copilot / Cowork
button. Applied to all five ValueLens templates with
`scripts/Fix-TaskBreakdown-UsersMeasure.py`. Other pages that deliberately report agent users
are unchanged.

## 2026-09-29 — optional Add Credit Consumption add-on

Each path folder now has an optional `Add Credit Consumption/` folder holding
**Consumption Central**, a separate Power BI report for Copilot credit consumption and cost
across Cowork / Work IQ, Copilot Studio, GitHub Copilot and Azure AI Foundry. The ValueLens
templates are unchanged and don't read it.

- **5. Local CSV** — the Local CSV template, `pull_azure_ai.py` and the shared synthetic sample
  data.
- **4. SharePoint** — the Viva Direct template, which reads Cowork data straight from Viva
  Insights. Consumption Central has no SharePoint template.
- **1. Fabric** — the Fabric template, seven ingestion notebooks, `seed_sample_data.py` and the
  data dictionary. It can share the ValueLens Lakehouse; no table names overlap.
- **3. Power Automate + Dataverse** — the Dataverse template, flow package, schema deploy script
  and permissions. Tables use the `cc_` prefix, so they sit beside ValueLens's `poc_` tables.

Copied from `microsoft/ConsumptionCentral-for-Microsoft-Copilot` at commit `24b0ca8`, with the
fixes from microsoft/ConsumptionCentral-for-Microsoft-Copilot#39: the example addresses in the
`SecurityFilter` table now use the fictional `contoso-health.com` domain, and the Dataverse path
gets a table for Cowork / Work IQ. Links to the full documentation point at that repository.

---

## 2026-09-29 — fuller sample data

The Local CSV sample now fills every page, so a first look shows what each page does on a
real estate rather than a thin version of it. Before this, about a third of the report's
visuals came up empty or thin on the sample.

- **Bigger, longer, deeper.** 13,337 interaction rows (3,716 sessions) across three full months,
  170 people in 14 organisations with a management hierarchy, a 104-agent registry and 1,215
  feedback rows over 15 months.
- **Every page populated.** All four habit bands, dormant and never-used licences, all eight
  Cowork work shapes, Model Fit's Over-specified and Under-specified sessions, every Agent
  Registry lifecycle state, and 11 feedback types.
- **Still synthetic by construction.** `Build-SampleData.py` generates every value from a fixed
  seed. Its proportions were tuned against aggregate counts from real deployments; no rows or
  values were copied. People are invented `first.last@contoso-demo.com` names.
- **New generator options.** `--end`, `--months`, `--users` and `--unlicensed-agent-share`, and
  a coverage report after each run. `--days` is gone; use `--months`.

---

## 2026-09-29 — gentler, adjustable fit grading

Feedback on Cowork Fit was that it read as too critical (about half of graded Cowork sessions
came out Low fit) and that the rule behind it was hard to see. The grades are now plainer, the
default is less strict, and you can choose how strict it is. All five templates carry the change.

- **New labels.** High / Medium / Low fit are now **Strong fit**, **Fair fit** and **Worth a
  look**. On Model Fit, "Try cheaper" is now **Lighter model may do**; Good match and Try
  stronger are unchanged. Measure names are unchanged, so custom visuals built on them keep
  working.
- **Grading setting.** `Assumptions[Fit Grading]` is a calculated column set to `"Balanced"`. To
  change it, select the column in Power BI Desktop and edit its formula to `"Strict"` or
  `"Lenient"`.
  - **Strict** reproduces the previous grade exactly.
  - **Balanced** (default) grades two kinds of session Fair fit instead of Worth a look:
    Cowork sessions that read messages (inbox and channel work, which Cowork logs as message
    reads, previously graded as plain chat) and work done in a single app.
  - **Lenient** also grades multi-turn chats Fair fit.
- **Coaching flag.** The Cowork Fit people table has a ⚑ column. It marks anyone with at least
  five graded Cowork sessions of which half or more are Worth a look; organisation and total
  rows show how many people are flagged. It is a coaching prompt, not a ranking.
- **Clearer notices.** The "how to read" notes on Model Fit and Cowork Fit name the grading
  setting in use and say what a flag means.
- **Task categories.** Estimated Value and Task Breakdown note that their task categories are
  rule-based, so they won't match the AI-inferred categories in Copilot Analytics.
- **Glossary.** The fit rows use the new wording, and a new row explains the grading setting.

---

## 2026-09-28 — sample product feedback

- New `5. Local CSV/sample-data/product_feedback_sample.csv` (172 rows): a fabricated
  Microsoft 365 admin centre product-feedback export, so the User Feedback page fills in from
  the sample data like every other page. `Build-SampleData.py` generates it from its own
  random stream, so the other three sample files are unchanged. It uses the same 21-column
  export shape the Fabric `Copilot_ProductFeedback_Ingester` reads.
- `.gitignore`: the sample-data exception now matches `5. Local CSV/sample-data/`. It was
  anchored to a root `sample-data/` folder that doesn't exist, so new sample files were ignored.

---

## 2026-09-28 — one lean report across all five templates

The Local CSV, SharePoint, Fabric, Fabric OneLake and Power Automate + Dataverse templates had
drifted apart (different page sets and models). They now ship the same report and the same 198
measures; only the data-source layer differs. Each `.pbit`
is about 1.2 MB (previously 4.7–10.5 MB) because it no longer carries pending query edits
(`UnappliedChanges`). Setup steps are unchanged except where noted in the path READMEs.

### Report

- 15 visible pages: Activation, Adoption, Habit Formation, Agent Registry, Task Breakdown,
  Estimated Value, Model Fit, Cowork Fit, Cowork Readiness, License Readiness, User Feedback,
  Leaderboard, Trend Heatmap, and the Glossary and Signal – Impact appendices. License Allocation
  ships hidden.
- **Model Fit** (new) grades every session High, Medium or Low fit for the model it used, across
  every tool, with ranked model usage and fit by tool.
- **Cowork Fit** (new) shows what share of each Cowork task is High, Medium or Low fit, why, and
  which people drive it.
- **Cowork Readiness** ranks where to roll out Cowork next by organization, then user, the
  same way License Readiness does.
- **User Feedback** reads the optional product-feedback export, now on every template.
- Removed: the Key Concepts introduction page (the Glossary covers it) and, from the SharePoint
  template, the Credit Meter page.
- Money values share one display symbol, the `Currency Symbol Value` measure in `Assumptions`
  (default `£`). It changes the symbol only; there is no FX conversion.

### Model

- Lean pass: tables, measures, relationships and source columns that nothing reads were removed,
  and duplicate measures were folded into one survivor each.
- `Environment` is now the licensing dimension only (Licensed / Unlicensed). Cowork is flagged in
  `Agent Filter`, as the Fabric notebook already did, so a Licensed filter no longer drops licensed
  Cowork work. The Local CSV processor (`Purview_CopilotInteraction_Processor_v4.0.0.py`) and the
  sample data follow the same rule.
- `Top Value Outcome` ranks Cowork task categories when the filter context is Cowork only, so the
  Adoption page's Cowork card no longer shows the generic chat outcome.

### Agents 365: API first, CSV fallback

- **Fabric:** the pipeline runs `Copilot_Agent365_Registry_Ingester` (Graph API) and, only if it
  fails, `Copilot_Agent365_Lander` (admin-centre CSV). See the
  [pipelines README](1.%20Fabric/Manual%20setup/pipelines/README.md) for the migration steps.
- **Other paths:** [`Get-Agents365Registry.ps1`](4.%20SharePoint/scripts/Get-Agents365Registry.ps1)
  writes the same 48-column registry as the Fabric notebook. `Run-PAX-AIBV.ps1
  -IncludeAgent365Info` runs it after PAX; add `-Agents365Csv` to fall back to the admin-centre
  export, or use `-Agents365Csv` alone in tenants without an Agent 365 licence.
- **Fabric templates:** `Enable_Agent365` and `Enable_ProductFeedback` default to `Include`, and a
  table that hasn't been landed yet loads empty instead of failing the refresh.

### Retired and archived

- No template reads cost consumption any more: the `copilot_cost_consumption`, `Credit Budget` and
  `Credit Unit Cost` tables and the `Cost Consumption File` parameter left the SharePoint and
  Dataverse templates.
  `Copilot_Cost_Consumption_Ingester` moved to
  `1. Fabric/archive/notebooks/`; seven shared notebooks remain.
- Power Automate + Dataverse: the `SharePoint Agents` table and the `Include SharePoint agent
  inventory` parameter were dropped (no page used them), and `Use SharePoint CSV fallback` now
  defaults to `false`. The template is built from the same project as the other four, so its old
  builder moved to `archive/scripts/`.

### Tests

- `tests/test_core_templates.py` now checks all five templates: identical report and measures,
  every report field reference resolves, neutral parameter defaults, no machine-bound parts or
  local paths, page inventory, bookmark targets and the optional Fabric tables' empty-load guard.
- The Dataverse, glossary and schema-hash tests were updated for the new templates, and CI now
  runs the full suite with no deselected tests.

### What was and wasn't validated

Every template was built from one project and passed structural, PBIR-schema and field-reference
checks. The report was refreshed in Power BI Desktop against a Fabric Lakehouse, and against
synthetic data for the Local CSV, SharePoint and Dataverse builds. The Agent 365 fallback logic
was exercised with a test harness and fixture data, not a live tenant.

This does **not** validate Power BI Service refresh, tenant Graph permissions or a production
Agent 365 run. Validate those in your own deployment before switching production over.

---

## 2026-09-15 — reviewed Fabric notebook set

These notes describe what changed in the notebooks under
[`1. Fabric/notebooks/`](1.%20Fabric/Manual%20setup/notebooks/). The guidance you need in order to *run* them
is in the [Fabric README](1.%20Fabric/README.md) and
`INGESTION-STRATEGY.md`.

### Audit ingester — `Copilot_Audit_Log_Direct_Ingester`

- Stable parsed-row keys now include **`Id`**, **`Source_RecordKey`**, **`Source_MessageKey`**
  and **`Source_ResourceKey`**.
- `MODE` must be **`backfill`** or **`incremental`**.
- **Backfill** writes the parsed table with **`WRITE_MODE='overwrite'`**.
- **Incremental** re-queries the trailing **`LOOKBACK_DAYS = 7`** and writes with
  **merge-by-`Id`** semantics.
- Parsed output still derives `InteractionDate`, `WeekStart` and `MonthStart` from `CreationDate`.
- Legacy parsed tables missing the stable key columns now fail clearly and require a deliberate
  fresh backfill before incremental resumes. The upgrade procedure is operational guidance and
  lives in the [Fabric README](1.%20Fabric/README.md) and
  `INGESTION-STRATEGY.md`.

### Audit processor — `Copilot_Audit_Log_Processor`

- Curated output now uses **`MERGE_KEYS = ["Id"]`**.
- First curated rebuild: **`WRITE_MODE="overwrite"`**.
- Ongoing runs after the parsed-table key upgrade: **`WRITE_MODE="merge"`**.
- Merge is rejected if the source keys are missing or blank, or if the existing curated table is
  missing the merge key — rather than silently producing an ambiguous curated table.

### Snapshot-safety guards

Each snapshot source now validates before it replaces anything:

- **Licensed users:** rejects empty, malformed and conflicting duplicate rows.
- **Org data:** rejects malformed `/users` pages, conflicting duplicate identities and manager cycles.
- **Agent 365 registry:** rejects rows without `Title ID` and conflicting duplicate registry rows.
- **Product feedback:** `WRITE_MODE='append'` is explicitly rejected; missing files preserve the
  existing snapshot unless you deliberately allow an empty first placeholder.
- Feedback discovers exports using OneLake file metadata, not a notebook-local filesystem mount.
  Agent 365 aliases are projected without duplicate case-insensitive column names.

### What was and wasn't validated

The updated transformation and Delta-write paths were exercised in Fabric Spark using synthetic
inputs: audit replay/reordering, late-event insertion, processor overwrite/merge, and
licence/org/Agent 365/feedback snapshot safeguards. Local regressions also cover
extraction/checkpoint helpers and packaged model contracts.

This does **not** validate tenant Graph permissions, source retention/completeness, a production
backfill, or scheduled Power BI refresh. Validate those in your own deployment before switching
production over.

### Data check scope

`ValueLens_Data_Check.ipynb` is a **read-only diagnostic**. It shows stored flags, distinct counts
and identity overlap. It does **not** independently classify licences or prove historical parity
by itself.
