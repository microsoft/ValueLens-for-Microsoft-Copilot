# Changelog

Notable, reviewed changes to the ValueLens templates, notebooks and helper scripts.

This file starts here. Everything before the first entry below lives in `git log` and the
pull-request history — this repo shipped for a while before anyone thought to write the
changes down in one place, and back-filling that accurately from commit messages would be a
worse record than pointing you at the commits themselves.

Deployment instructions do **not** live here. They live in the path READMEs:
[1. Fabric](1.%20Fabric/README.md) ·
[1. Fabric/Fabric App](1.%20Fabric/Fabric%20App/README.md) ·
[2. Power Automate + Dataverse](2.%20Power%20Automate%20+%20Dataverse/README.md) ·
[3. SharePoint](3.%20SharePoint/README.md) ·
[4. Local CSV](4.%20Local%20CSV/README.md).

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

- **4. Local CSV** — the Local CSV template, `pull_azure_ai.py` and the shared synthetic sample
  data.
- **3. SharePoint** — the Viva Direct template, which reads Cowork data straight from Viva
  Insights. Consumption Central has no SharePoint template.
- **1. Fabric** — the Fabric template, seven ingestion notebooks, `seed_sample_data.py` and the
  data dictionary. It can share the ValueLens Lakehouse; no table names overlap.
- **2. Power Automate + Dataverse** — the Dataverse template, flow package, schema deploy script
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

- New `4. Local CSV/sample-data/product_feedback_sample.csv` (172 rows): a fabricated
  Microsoft 365 admin centre product-feedback export, so the User Feedback page fills in from
  the sample data like every other page. `Build-SampleData.py` generates it from its own
  random stream, so the other three sample files are unchanged. It uses the same 21-column
  export shape the Fabric `Copilot_ProductFeedback_Ingester` reads.
- `.gitignore`: the sample-data exception now matches `4. Local CSV/sample-data/`. It was
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
- **Other paths:** [`Get-Agents365Registry.ps1`](3.%20SharePoint/scripts/Get-Agents365Registry.ps1)
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
