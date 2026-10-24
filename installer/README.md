# ValueLens installer

Sets up [ValueLens](../README.md) in your tenant, loads the first data and checks it. You answer
its questions in your browser, or in the terminal. This page is the reference. To get going:
[Prerequisites](../docs/PREREQUISITES.md#the-valuelens-installer) →
[Install](../docs/INSTALL.md) → [Check it worked](../docs/INSTALL.md#check-it-worked).

It covers ValueLens only. [Analytics Hub](https://github.com/microsoft/AnalyticsHub-Dashboard),
which covers ValueLens plus Consumption Central, Agent Evaluator and an Azure route, has its own
installer.

## Install

Paste this into PowerShell. It needs no admin rights: it downloads installer 0.1.0 as a zip,
checks its SHA-256 and opens the installer in your browser.

```powershell
irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1 | iex
```

Or download
[ValueLensInstaller.exe](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/ValueLensInstaller.exe)
and run it. Other versions are on the
[installer releases](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=valuelens-installer-v).
The repo's "Latest" release is usually a dashboard release, not the installer.

## Run it

[docs/INSTALL.md](../docs/INSTALL.md) has the steps:

- [Run it](../docs/INSTALL.md#run-it): the one-liner or the exe, the questions and the install
  record.
- [Check it worked](../docs/INSTALL.md#check-it-worked): the Done page, status and the data check.
- [Check the download](../docs/INSTALL.md#check-the-download): the exe's SHA-256.
- [From PowerShell](../docs/INSTALL.md#from-powershell): later commands, `-ZipPath`, `-Proxy`
  and `-Uninstall`.
- [IT-approved Node.js](../docs/INSTALL.md#it-approved-nodejs): `-UseInstalledNode`.
- [Locked-down tenant / Azure Cloud Shell](../docs/INSTALL.md#locked-down-tenant--azure-cloud-shell):
  the Fabric route only.
- [Without the exe](../docs/INSTALL.md#without-the-exe): from a clone of this repo.

The installer has two routes. Choose one in the browser, or with `--target fabric` or
`--target pax`. An install stays on the route it started on.

| Route | Each day | The data | Needs |
|---|---|---|---|
| **Fabric** | Notebooks and a pipeline in a Fabric workspace load the data | A Lakehouse | A Fabric capacity (F2 or larger, or a trial) |
| **No Fabric: PAX + SharePoint** | A scheduled task on a Windows PC runs PAX | CSV files in a SharePoint folder | Power BI Pro, PowerShell 7.2 or later and Python 3.10 or later |

To set it up by hand instead, follow [1. Fabric](../1.%20Fabric/README.md) or
[4. SharePoint](../4.%20SharePoint/README.md).

## What it sets up

### Fabric route

It sets up what [1. Fabric](../1.%20Fabric/README.md) describes, from
`1. Fabric/Manual setup`:

| What | Default name |
|---|---|
| Fabric workspace | `ValueLens`, or one you choose, on your Fabric capacity |
| Lakehouse | `ValueLens` |
| Notebooks | `ValueLens_…`. The `Copilot_…` loads keep their names |
| Pipeline | `ValueLens_Pipeline`, which runs the loads each day |
| Semantic model | `ValueLens Model` |
| Report | `ValueLens` |
| Connection | `ValueLens SQL` and the first 8 characters of the workspace ID: the model's connection to the Lakehouse's SQL analytics endpoint, signed in as the app registration |
| App registration | `ValueLens (Fabric)`, with the Microsoft Graph permissions your data sources need. See [Permissions](../docs/PERMISSIONS.md#the-valuelens-installer) |
| Viewer group | `ValueLens Viewers`, with Build on the model. See [Viewer access](#viewer-access) |
| Power Automate flows | Only for the sources that use them: `ValueLens - Product feedback` and `ValueLens - Agent inventory` |
| Azure Key Vault | Only if you choose it. See [Where the secret goes](#where-the-secret-goes) |

The Fabric route deploys the report only. Deploying the app from it comes in a later version.

The installer never changes anything it didn't create. If one of its names is taken in the
workspace, its own item gets the next free name, such as `ValueLens Model 2` or `ValueLens_Pipeline_2`.
The plan shows the names before you approve it.

**Data sources.** Each source has a card, with how its data arrives: **Connected (API)**,
**Upload CSV** or **Skip**. On the command line, use `--data <id>=<mode>`, with `api`, `csv` or
`skip`.

| Card | `--data` id | Choices | Default | Needs |
|---|---|---|---|---|
| Copilot usage and licences | `core` | Connected (API) | Always on | Graph: AuditLogsQuery.Read.All, Reports.Read.All |
| Org data (Microsoft Entra ID) | `orgData` | Connected (API) | Always on | Graph: User.Read.All |
| Workday org data | `workday` | Upload CSV, Skip | Skip | A Workday export |
| Microsoft 365 activity | `m365Activity` | Connected (API), Skip | Connected (API) | Graph: Reports.Read.All |
| Agent 365 registry | `agent365` | Connected (API), Upload CSV, Skip | Skip | The API needs an Agent 365 licence. Graph: CopilotPackages.Read.All, Application.Read.All, User.Read.All |
| Product feedback | `productFeedback` | Power Automate (emailed export), Upload CSV, Skip | Skip | The flow needs Power Automate Premium |
| Defender (shadow AI and agent risk) | `defender` | Connected (API), Skip | Skip | Defender for Endpoint P2 or Defender for Cloud Apps. Graph: ThreatHunting.Read.All, CloudApp-Discovery.Read.All |
| Agent configuration and Foundry (Azure Resource Graph) | `resourceGraph` | Connected (API), Skip | Skip | Foundry needs Reader on a management group. Agents need an Entra role such as Global Reader |

- **Upload CSV.** Upload the export with **Upload exports** in the browser, or `upload <files>`.
  It goes to the Lakehouse folder `Files/analytics_hub_uploads`, and the next run loads it.
  `install --csv <file>` uploads one during the install, and `upload --run` runs the pipeline
  straight after.
- **Product feedback** by flow: `--data productFeedback=flow`, or `--feedback-flow`. The flow
  saves the product feedback exports emailed to you. The Done page then has
  **Ask for the product feedback export**.
- **Agent configuration and Foundry** reads Copilot Studio agents and Foundry resources through
  Azure Resource Graph, from the whole tenant or one management group
  (`--arg-management-group`). `--no-arg-agents` or `--no-arg-foundry` leaves one out. With agents
  on, the installer also makes the `ValueLens - Agent inventory` flow. What can't be read is
  reported, not failed. The Done page has **Ask for Global Reader** when the app registration
  needs it.
- **The flows** go in a Power Platform environment you choose (`--flow-environment`). People with
  access to it can see them. Its data policy (DLP) must allow the
  "HTTP with Microsoft Entra ID (preauthorized)" connector, and whoever signs in to the flows
  needs a Power Automate Premium licence. By default a person signs in to the flows' connection
  (`--flow-identity user`). `--flow-identity app` uses the app registration, with its secret from
  Key Vault; the vault must allow public network access. With the secret in the notebooks, flows
  that would use the app aren't made.
- **Currency.** The report shows money in USD unless you choose another (`--currency`).

### Where the secret goes

The notebooks sign in as the app registration with a client secret. A new install asks
**Where should the app's client secret go?**

- **No Key Vault: keep the secret in the notebooks** (the default). Nothing in Azure. Anyone with
  a role in the workspace can read the secret. It lasts 90 days unless you change it (in the
  advanced settings, or `--secret-days`, 1 to 730), and each install, repair or update replaces
  it.
- **Azure Key Vault.** Needs an Azure subscription where you can create or use a vault.
  Workspace roles don't expose the secret.

Repair offers **Keep it in the notebooks** or **Use Key Vault instead**. With `--yes`, a new
install keeps the secret in the notebooks unless you add `--key-vault`. Either way, viewers get
no workspace role: see [Viewer access](#viewer-access).

### No Fabric: PAX + SharePoint route

[PAX](https://github.com/microsoft/PAX) (Portable Audit eXporter) exports Copilot audit records.
This route automates [4. SharePoint](../4.%20SharePoint/README.md):

| What | Name or place |
|---|---|
| App registration | `ValueLens (PAX)`. Its client secret is kept in Windows Credential Manager on this PC. See [Permissions](../docs/PERMISSIONS.md#the-valuelens-installer) |
| Access to one SharePoint site | Write access to the site that holds the folder, and to no other site (Sites.Selected) |
| Scheduled task | `ValueLens - PAX refresh`, on this PC, each day at 02:00 by default |
| Local folder | `%LOCALAPPDATA%\ValueLens\pax\`: the scripts, settings, logs and working files |
| SharePoint folder | The CSV files the report and the app read |
| Power BI workspace | A new one, `ValueLens` by default, or one you're in |
| Semantic model and report | Both `ValueLens`, from the template in [4. SharePoint](../4.%20SharePoint/README.md) |
| Refresh schedule | Twice a day, after the task |
| Viewer group | `ValueLens Viewers`, with Build on the model. See [Viewer access](#viewer-access) |
| The app | `ValueLens`, a Copilot Managed App, unless you turn it off. See [The app](#the-app) |

#### Checks before it changes anything

First the installer checks this PC. It stops, and says what to do, if:

- It's Azure Cloud Shell, or not Windows. Run the installer on the Windows PC that will run the
  task.
- PowerShell is older than 7.2: `winget install --id Microsoft.PowerShell --source winget`.
- The execution policy is **AllSigned** or **Restricted**. The scripts aren't signed, and the
  installer doesn't change or bypass the policy. Run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or ask your IT admin if Group Policy
  sets it.
- An application control policy, such as App Control for Business or AppLocker, limits
  PowerShell, so the refresh can't keep its secret in Credential Manager. Ask your IT admin to
  allow the scripts.
- Python 3.10 or later is missing. PAX's `-Rollup` needs it to build the files. Without it, PAX
  tries to install Python itself, which a scheduled task can't finish:
  `winget install --id Python.Python.3.13 --scope user`.

#### The daily refresh

The task, `ValueLens - PAX refresh`:

- Runs as you, each day at 02:00 by default, in this PC's time. The advanced settings change it:
  **When should the refresh run each day?**
- Runs at run level **Limited**: not elevated.
- Runs only while you're signed in to this PC (logon type **Interactive**). A missed run starts
  when it can. To run it when you're signed out too, change it in Task Scheduler to
  **Run whether user is logged on or not**, which may need the "Log on as a batch job" right. The
  installer keeps that change. The Done page card **Keep the refresh running while you're signed
  out** has the steps.
- Runs only with a network connection, never twice at once, and stops after 12 hours.
- Runs `pwsh.exe -NoProfile -NonInteractive -WindowStyle Hidden -File "<refresh.ps1>" -Config "<refresh.json>"`.
  There's no `-ExecutionPolicy Bypass`.

Each run:

1. Takes a lock, so only one run works at a time.
2. Reads the client secret from Credential Manager.
3. If this PC has no files yet, copies them from the SharePoint folder.
4. Runs PAX in its own PowerShell process. PAX is pinned to release `purview-v1.11.15`, and the
   script's SHA-256 is checked before it runs.
5. Uploads the files to the SharePoint folder.
6. Writes `state.json` and a log.

| Where | What |
|---|---|
| `%LOCALAPPDATA%\ValueLens\pax\scripts\` | `refresh.ps1`, and the scripts from `4. SharePoint/scripts` it runs: `Run-PAX-AIBV.ps1`, `Get-Agents365Registry.ps1` and `Upload-Rollups-SharePoint.ps1` |
| `…\pax\refresh.json` | The task's settings |
| `…\pax\state.json` | The last run |
| `…\pax\logs\` | A log for each run, kept 30 days |
| `…\pax\data\` | The cumulative files, PAX's logs and any set-aside files |
| `…\pax\work\` | PAX's working files |
| Windows Credential Manager, `PAX-ValueLens-<tenant ID>` | The client secret. It lasts 12 months |

The first load runs straight after setup and pulls 30 days of audit history by default. It can
take hours on a large tenant. Leave the PC on, and stay signed in, until it finishes.

#### The SharePoint folder

- Use a folder in a document library on a SharePoint site. A OneDrive folder is refused, so the
  refresh doesn't depend on one person's OneDrive. Subsites aren't supported. A folder name with
  spaces at the start or end, or a full stop at the end, is refused.
- The refresh writes `copilot_interactions_rollup.csv` and `copilot_users_rollup.csv`, and
  `agents_365.csv` if you chose the Agent 365 file. The report reads only these.
- If the folder has a file this PC didn't upload or copy down, the refresh doesn't overwrite it.
  It moves this PC's copy to `data\set-aside-<date and time>-<name>`, and the next run carries on
  from SharePoint's copy.
- `upload <files> --folder <path>` uploads other files to a subfolder, such as `Exports/2026`.
  Missing folders are created, and names can include `#` and `%`. The report doesn't read them.
- Uninstalling leaves the files in SharePoint.

**The site grant.** Giving the app write access to the site needs a sign-in with
Sites.FullControl.All, which the installer's sign-in usually doesn't have. The installer then
shows the commands for a SharePoint Administrator or Global Administrator (Microsoft Graph
PowerShell, or PnP PowerShell), and asks: **Check again**, or
**Carry on without it (the refresh can't save its files until it's done)**. If you carry on, the
Done page has **Ask for the app's access to the SharePoint site**, with a message to send.

#### The report

- The installer publishes the report through the Power BI API, to a new workspace
  (**Create a new workspace**) or one you're in. Creating one needs the tenant setting
  **Create workspaces**. In an existing workspace you need Admin or Member.
- If Power BI won't take the report through the API, for example in a workspace without a
  capacity or with the API turned off for the tenant, the installer falls back to Power BI
  Desktop. It writes `ValueLens.pbit` beside the install record and shows the steps:
  1. Open it in Power BI Desktop, which is free from the Microsoft Store.
  2. Keep the parameters and select **Load**.
  3. When it asks how to connect to SharePoint, choose **Microsoft account** (or
     **Organizational account**), sign in with your work account and select **Connect**.
  4. Save it as `ValueLens.pbix`.
  5. Select **Publish**, choose the workspace, and select **Replace** if it asks.

  Then choose **I've published it**, **Keep the version that's there for now** or
  **Stop and resume later**. Once you've used Desktop, later updates go through Desktop too. If
  you stop, the Done page has **Publish the report from Power BI Desktop**.

**Sign the model in to SharePoint.** Once, after publishing, the model needs your sign-in to
read the folder. The installer shows the steps: in the workspace, open the model's settings, then
**Data source credentials** > **Edit credentials**. Choose **OAuth2** and privacy level **None**,
then **Sign in**. Do the same for each source. If a site fails the test, select
**Skip test connection**. Then choose **I've signed it in**. **Later** leaves
**Sign ValueLens in to SharePoint** on the Done page. Until it's done, the report has no data.

**Refresh schedule.** Once the model is signed in, the installer schedules its refresh each day
4 and 10 hours after the task, rounded up to the half hour: 06:00 and 12:00 for a 02:00 task, in
this PC's time zone. Power BI emails if a refresh fails. Power BI Pro allows 8 refreshes a day.

### The app

On the PAX route, the installer asks **Deploy the ValueLens app?** Yes is the default.

- The app is a Copilot Managed App named `ValueLens`. The installer deploys it with the bundled
  `ms` CLI (`@microsoft/managed-apps-cli`), which signs in separately: a browser opens.
- It goes in your Power Platform developer environment, unless you pass `--environment-id`.
- It's shared with the viewer group. Each viewer needs Power Apps Premium or Copilot Credits. The
  Power Apps rights in Microsoft 365 don't count. For Copilot Credits, turn on usage-based billing
  and add the viewers to a spending policy for managed apps.
- In the app, viewers choose **Change data** and pick the CSV files from the SharePoint folder. So
  they need read access to the folder. The installer doesn't give it.
- **Update** and **Deploy the app** (`deploy-app`) deploy it again only when the build has
  changed.
- The CLI needs Node.js 24.11 or later. The exe and the PowerShell command bring what it needs.
  With `-UseInstalledNode`, or from a clone, see
  [IT-approved Node.js](../docs/INSTALL.md#it-approved-nodejs) and
  [Without the exe](../docs/INSTALL.md#without-the-exe).

**If the tenant isn't ready.** If the Power Platform settings
**Allow app creation with the Copilot Managed Runtime CLI** or
**External artifacts in managed apps** are off, the installer says which. It finishes at the
report instead of failing, and the Done page has **Ask for managed apps to be turned on**. A
Power Platform administrator turns them on in the Power Platform admin center: **Copilot** >
**Settings** > **Managed apps**, or, for an environment group, its rules. Then choose
**Deploy the app** (`deploy-app`). **Repair or change** asks about the app again.

If the app step stops for another reason, the Done page has **Finish the ValueLens app**, with
what went wrong. For example:

- **AADSTS53003.** Conditional Access blocked the CLI's sign-in. Ask for its app ID,
  `9cee029c-6210-4654-90bb-17e6e9d36617`, to be allowed.
- **No developer environment.** Pass `--environment-id` with the environment to use.
- **An app with that name already exists.** Rename or delete it at
  [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft/).
- **A policy blocks sharing apps in the environment.** Allow it, or deploy to another
  environment.

## Viewer access

The installer creates a viewer group, **ValueLens Viewers** (or uses one you name), with you as
owner.

- **No workspace role.** Workspace viewers can read the notebooks' code, and a default Fabric
  install keeps the app's client secret in the notebooks. So the group gets no workspace role on
  either route.
- **Build on the model.** The installer gives the group Build (ReadExplore) on the semantic model
  through the Power BI API. If that fails, share the model with the group from its
  **Manage permissions** page, with "Allow recipients to build content" ticked.
- **Share the report, once.** Power BI has no API for it, so the installer asks you: in the
  workspace, choose **…** next to the report, then **Manage permissions** > **Add user**. Enter
  the group and choose **Grant**. Then choose **I've shared it**. **Later** leaves
  **Share the report with ValueLens Viewers** on the Done page, and **Repair or change** asks
  again.
- **The app.** On the PAX route, the app is shared with the group too.

To give someone access, add them to the group: choose **Manage access** (`access`), or use
[My Groups](https://myaccount.microsoft.com/groups). They need no workspace role. Unless the
workspace is on a paid F64 or larger Fabric capacity, or a Power BI Premium capacity, each of
them needs Power BI Pro or Premium Per User.

## Check it worked

[Check it worked](../docs/INSTALL.md#check-it-worked) in docs/INSTALL.md has the steps. In
short: read the Done page, choose **Check status** (`status`), which changes nothing, then
**Check the data** (Fabric) or **Check the SharePoint folder** (PAX), both `check`.

## Load status and reruns

**Fabric.** After a run, each source has a card: loaded, warning, failed, skipped or still
running. The same is in the Lakehouse table `dbo.load_log`. A failed card says why:

| Why it failed | What to do |
|---|---|
| The capacity was too busy (430) | Nothing is lost. Rerun later, or use a larger capacity |
| The SQL analytics endpoint hadn't caught up | Wait a couple of minutes and rerun |
| Sign-in failed (AADSTS, 401, 403 or consent) | Check admin consent, and that the client secret hasn't expired |
| It timed out | Rerun. Load less history, or use a larger capacity |
| The file isn't there | Upload it, or set the source to **Skip** |

A warning means the load ran but something was missing: a role or permission
([Permissions](../docs/PERMISSIONS.md#the-valuelens-installer) lists them), a licence, or any
data. Azure Resource Graph and Defender also write what they couldn't read to the tables
`arg_status` and `defender_status`.

- **Rerun failed loads** (`rerun-failed`) runs again only the loads that failed in the latest
  pipeline run.
- **Run now** (`run`) runs the pipeline, then the data check.
- **Check the data** (`check`) runs the data check again, without the pipeline.

**No Fabric: PAX + SharePoint.** **Check status** (`status`) shows the task and its last run, the
client secret, the SharePoint folder and the model's last refresh. **Run now** (`run`) runs the
refresh now. Each run's log is in `%LOCALAPPDATA%\ValueLens\pax\logs\`. If the first refresh
fails, the Done page has **Fix the first refresh**.

## A large tenant

- **Fabric.** The advanced settings ask **How many people are in the tenant?** **More than
  10,000** uses smaller audit windows and longer time limits, and is best on F64 or larger. The
  installer picks a default from your capacity and licences.
- **No Fabric: PAX + SharePoint.** The first load pulls 30 days of audit history by default. The
  advanced settings offer 30, 90 or 180 days. On a large tenant the first load can take hours:
  leave the PC on, and stay signed in, until it finishes.

### Load more audit history

`run --backfill-days <n>` reloads `n` days of audit history, 1 to 180. On the Fabric route it
rebuilds the curated table. On the PAX route it adds the days to the SharePoint folder's files.

## Already set up by hand

- **Fabric.** The installer leaves alone anything it didn't create. In a workspace that already
  has ValueLens items, its own items get the next free names, so you have two copies. Use a new
  workspace, or delete the hand-made items first.
- **No Fabric: PAX + SharePoint.** The installer's task, secret and local folder have their own
  names, so a hand set-up from [4. SharePoint](../4.%20SharePoint/README.md) keeps running. If
  both write to the same SharePoint folder, the installer's refresh won't overwrite files it
  didn't write: it sets its own copy aside (see [The SharePoint folder](#the-sharepoint-folder)).
  Give it its own folder.
- **Analytics Hub.** The installer won't use a workspace that holds an Analytics Hub install, or
  an Analytics Hub install record (`valuelens-install.json`). Manage those with the
  [Analytics Hub installer](https://github.com/microsoft/AnalyticsHub-Dashboard).

## Update, repair or change

**Updates.** When the browser page starts, the installer checks for a newer installer. It lists
this repo's releases and takes the newest published `valuelens-installer-v*` release, skipping
drafts and prereleases. It never uses GitHub's **Latest** release, which is usually a dashboard
release. If there's a newer one,
the page says **Installer x.y.z is available.**, and **Get it** opens that release. If you
started the installer from PowerShell, it also gives the command for that version, pinned to its
release. Close the installer, run the newer one, then choose **Repair or change**. The check gives
up quietly if GitHub doesn't answer within 5 seconds. Set `VALUELENS_NO_UPDATE_CHECK=1` to turn
it off.

**Update** (`update`) pushes the version you're running to your install: on the Fabric route,
the notebooks, pipeline and semantic model; on the PAX route, the scripts on this PC, the report
and the app.

**Repair or change.** Start the installer again the same way and choose **Repair or change**
(`install`). It goes through the set-up again from the install record and puts back what's
missing. It also asks again about what you put off, such as sharing the report, Key Vault and the
app.

**The install record.** The installer keeps your answers in `valuelens-setup.json`, in
`Documents\ValueLens` when you start it with the exe or the PowerShell command. It holds no
secrets, and its `product` is `valuelens`. Choices you haven't approved yet are kept beside it in
`valuelens-setup.json.draft.json`. Use `--config <file>` for another record.

**Changing route.** An install stays on its route. Uninstall it first, or pass `--config` with a
new file name to set up a second copy.

## Secrets expire

| Route | Where the client secret is | How long it lasts |
|---|---|---|
| Fabric, no Key Vault | In the notebooks | 90 days by default (`--secret-days`, 1 to 730). Each install, repair or update replaces it |
| Fabric, Key Vault | In Key Vault | **Check status** shows when it expires |
| No Fabric: PAX + SharePoint | Credential Manager on this PC | 12 months. When the installer runs with 30 days or fewer left, it makes a new one |

**Check status** (`status`) shows when each secret expires. On the Fabric route, it warns when
fewer than 30 days are left. To replace it, choose **Create new secrets** (Fabric) or
**Create a new client secret** (PAX), or run `rotate-secret`:

- **Fabric, no Key Vault.** A new secret is written into the notebooks, then the old one is
  removed from the app registration, so copies of it in run snapshots, exports or Git stop
  working. If you brought your own app registration, you paste the new secret, then delete the
  old one from its **Certificates & secrets** page.
- **Fabric, Key Vault.** New secrets go into Key Vault and the model's connection. The old secret
  keeps working until it expires: delete it from the app's **Certificates & secrets** page once a
  run has succeeded.
- **No Fabric: PAX + SharePoint.** A new secret goes into Credential Manager on this PC. If the
  installer didn't create the app registration, it can't make one: make a secret in Entra ID
  (**App registrations** > the app > **Certificates & secrets**), then run `rotate-secret`.

## Uninstall

Choose **Uninstall** (`uninstall`).

**Fabric:**

- It asks before it deletes the workspace and everything in it, including the Lakehouse data. Yes
  is the default only if the installer created the workspace.
- It deletes the workspace's managed private endpoints, the workspace and the model's
  connection.
- It leaves alone the app registration, the Key Vault and its secret, any Power Automate flows,
  the viewer group, and the other roles the app registration was given.
- The install record still names the deleted workspace. Move it aside before you install again.

**No Fabric: PAX + SharePoint:**

- It asks first, then removes the scheduled task.
- If the installer created the Power BI workspace, it asks before it deletes it and everything in
  it (yes by default). Otherwise it deletes the report, and asks before it deletes the model (yes
  by default).
- It deletes the app. If it can't, it says to delete it at
  [managedapps.cloud.microsoft](https://managedapps.cloud.microsoft/).
- It removes the app registration's access to the SharePoint site.
- If the installer created the app registration, it asks before it deletes it (no by default). If
  the app registration stays, it removes the client secret the installer made.
- It removes the secret from Credential Manager, and the `%LOCALAPPDATA%\ValueLens\pax` folder.
- It leaves the files in SharePoint, the viewer group, PowerShell 7 and Python.
- Move the install record aside before you install again, or the installer picks up the old
  set-up.

## Remove the installer

Uninstall removes what's in your tenant and the scheduled refresh, not the installer itself. To
remove that:

- **The exe or the PowerShell command.** Run `.\install.ps1 -Uninstall` (see
  [From PowerShell](../docs/INSTALL.md#from-powershell)), or run the one-liner from
  [Install](#install) as `& ([scriptblock]::Create((irm <its install.ps1 link>))) -Uninstall`. It
  removes the installer folders unpacked under `%LOCALAPPDATA%\ValueLens`, and the `valuelens.cmd`
  command. Your install record in `Documents\ValueLens` stays, and so does the `pax` folder a
  scheduled PAX refresh runs from. Then delete the exe, if you downloaded it.
- **Azure Cloud Shell.** Delete `~/.valuelens`. Your install record in `~/valuelens` stays.
- **A clone.** Delete the clone.

## If you can't register apps

When the installer asks about the app registration, you can choose:

- **Use an app registration I already have.** Enter its client ID and, when asked, a client
  secret's value.
- **An admin will register the app for me.** The installer writes an admin pack,
  `valuelens-admin-pack.md`, beside the install record. It has an Azure Cloud Shell (Bash) script
  and the same steps in the portal, for someone who can register apps and grant admin consent,
  such as a Privileged Role Administrator or Global Administrator. On the PAX route it adds the
  PowerShell that gives the app the SharePoint site, for a SharePoint Administrator or Global
  Administrator. The admin sends you the client ID, and the client secret through a secure
  channel, unless the secret goes straight into Key Vault.

[Permissions](../docs/PERMISSIONS.md#the-valuelens-installer) lists what each app registration
needs.

## Prerequisites

[Prerequisites](../docs/PREREQUISITES.md#the-valuelens-installer) lists what each route needs, by
person. [Permissions](../docs/PERMISSIONS.md#the-valuelens-installer) lists what the installer
creates and grants. To check your own account, choose **Check prerequisites** in the browser, or
run `prereqs` (add `--target pax` for the PAX route). It's read-only and works before anything is
installed.

## Troubleshooting

- **"Release valuelens-installer-v… is no longer available".** That `install.ps1` is pinned to a
  release whose zip has gone. Get the current release's command from the
  [installer releases](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=valuelens-installer-v).
- **A proxy blocks the download.** Use `-Proxy` or `VALUELENS_PROXY`, or download the zip in a
  browser and use `-ZipPath`. See [From PowerShell](../docs/INSTALL.md#from-powershell).
- **AppLocker or App Control blocks `node.exe`.** Use
  [IT-approved Node.js](../docs/INSTALL.md#it-approved-nodejs), or
  [Azure Cloud Shell](../docs/INSTALL.md#locked-down-tenant--azure-cloud-shell) for the Fabric
  route.
- **`valuelens.cmd` says this copy has been removed or replaced.** Run the command it prints.
- **The installer won't use a workspace or an install record.** It holds an Analytics Hub
  install. Use the [Analytics Hub installer](https://github.com/microsoft/AnalyticsHub-Dashboard).
- **"This install record is for the … route".** See [Changing route](#update-repair-or-change).
- **The first load was skipped.** Admin consent wasn't granted. Once it is, run the command the
  installer printed: `run --backfill-days <days>` (Fabric) or `run` (PAX).
- **A Fabric load failed.** See [Load status and reruns](#load-status-and-reruns).
- **The PAX checks stop the install.** See
  [Checks before it changes anything](#checks-before-it-changes-anything).
- **The SharePoint folder's address is refused.** Use a folder on a SharePoint site, not OneDrive
  or a subsite, with no spaces at the start or end of a name and no full stop at the end.
- **The refresh can't save its files.** The app doesn't have the site yet. See
  [The SharePoint folder](#the-sharepoint-folder).
- **The task didn't run.** It runs only while you're signed in. See
  [The daily refresh](#the-daily-refresh). Its logs are in `%LOCALAPPDATA%\ValueLens\pax\logs\`.
- **The refresh found no Copilot audit records.** If Copilot is in use, check that auditing is
  on: in the Microsoft Purview portal, open **Audit**. If it offers to start recording user and
  admin activity, auditing is off: turn it on. Activity is audited from then on.
- **Files called `set-aside-…`.** SharePoint had a file this PC didn't write. See
  [The SharePoint folder](#the-sharepoint-folder).
- **The workspace can't be created.** Ask a Fabric administrator for the tenant setting
  **Create workspaces**, or ask someone to create one and add you as Admin or Member. If the name
  is taken, choose another, or ask its admin to add you.
- **Power BI wouldn't schedule the model's refresh.** It usually means the model isn't signed in
  to SharePoint. Sign it in, then run the installer again.
- **The app wasn't deployed.** See [The app](#the-app).
- **Something else.** Run the command again with `--verbose` to print each API call, and
  [open an issue](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/issues).

## Commands and options

In the browser, choose a command on the home page. In the terminal, add it to the command you
started with: `& $env:LOCALAPPDATA\ValueLens\valuelens.cmd status`,
`ValueLensInstaller.exe status`, `~/.valuelens/valuelens status` in Cloud Shell, or
`npm start -- status` from a clone. `--help` lists them all.

| Command | Browser | What it does |
|---|---|---|
| `install` | **Repair or change** | Set up ValueLens, or repair it from the install record (the default) |
| `update` | **Update** | Push this version to the install: Fabric's notebooks, pipeline and semantic model, or PAX's scripts on this PC, the report and the app |
| `run` | **Run now** | Fabric: run the pipeline now, then the data check. PAX: run the refresh now |
| `rerun-failed` | **Rerun failed loads** | Fabric: run again only the loads that failed in the latest pipeline run |
| `check` | **Check the data**, **Check the SharePoint folder** | Fabric: run the data check again, without the pipeline. PAX: check the app can still write to the SharePoint folder |
| `refresh` | **Refresh the model** | Refresh the semantic model now |
| `status` | **Check status** | Show recent runs and refreshes, the last data check and when secrets expire |
| `rotate-secret` | **Create new secrets**, **Create a new client secret** | Create new client secrets: Fabric's and the model's connection's, or PAX's in Credential Manager on this PC |
| `access` | **Manage access** | Who can view: the viewer group, its members and owners, and its Build on the model |
| `upload [files]` | **Upload exports** (Fabric) | Fabric: upload CSV exports to the drop folder, which the next run loads. PAX: upload any files to the SharePoint folder |
| `deploy-app` | **Deploy the app** | PAX: deploy the app, or deploy it again from this version's build |
| `uninstall` | **Uninstall** | See [Uninstall](#uninstall) |
| `prereqs` | **Check prerequisites** | Check the roles, licences, capacities and Azure access you have and lack. Read-only. `--target pax` checks the PAX route's |
| `preview` | | Write what would be deployed to a folder, without signing in |

**Options:**

| Option | What it does |
|---|---|
| `--ui` | Run the installer in your browser instead of the terminal. Only this computer can reach the page |
| `--no-open` | With `--ui`: print the link instead of opening the browser |
| `--config <file>` | The install record (default `./valuelens-setup.json`) |
| `--source <dir>` | The repo folder to deploy from (default: this checkout) |
| `--tenant <id>` | Tenant ID or domain to sign in to |
| `--target <fabric\|pax>` | The route. `install` asks when it's left out, and an install record keeps its route |
| `--device-code` | Sign in with a code on another device instead of a browser. The default in Azure Cloud Shell |
| `--use-az` | Use the account you're signed in to with the Azure CLI. In Cloud Shell, run `az login --use-device-code` first |
| `--backfill-days <n>` | With `run`: reload `n` days of audit history, 1 to 180 |
| `--out <dir>` | With `preview`: where to write (default `./valuelens-preview`) |
| `--yes` | Take saved answers and defaults without asking. It never lets Fabric clear a model's data: add `--allow-model-reset` for that |
| `--no-wait` | Don't wait for the first load or a refresh to finish |
| `--verbose` | Print each API call |
| `-h`, `--help` | Show the help |
| `-v`, `--version` | Show the version |

**Fabric route options.** Without `--target` or an install record, they choose this route.

| Option | What it does |
|---|---|
| `--data <id=mode>` | With `install`: how a source arrives, `api`, `csv` or `skip`. Repeat it or use commas, such as `--data productFeedback=flow,agent365=api`. `flow` is product feedback's Power Automate flow. Ids: `core`, `orgData`, `workday`, `m365Activity`, `agent365`, `productFeedback`, `defender`, `resourceGraph` |
| `--csv <file>` | With `install`: an export to upload during the install. Repeat for more |
| `--feedback-flow` | With `install`: the same as `--data productFeedback=flow` |
| `--flow-environment <url>` | With `install`: the Power Platform environment to create the flows in |
| `--flow-identity <user\|app>` | With `install`: who the flows write to OneLake as. `user` (default): a person signs in to an HTTP with Microsoft Entra ID connection. `app`: the app registration, with its secret from Key Vault, which must allow public network access |
| `--arg-management-group <id>` | With `install`: the management group Resource Graph reads from (default: the whole tenant) |
| `--no-arg-agents` | With `install`: leave Copilot Studio agents out of Resource Graph |
| `--no-arg-foundry` | With `install`: leave Foundry resources out of Resource Graph |
| `--currency <code>` | With `install`: the currency the report shows money in, such as GBP (default USD) |
| `--run` | With `upload`: run the pipeline straight after |
| `--no-key-vault` | With `install`: keep the client secret in the notebooks, the default for a new install. Same as `--secret-in-notebook` |
| `--key-vault` | With `install`: keep the client secret in Azure Key Vault. Needed with `--yes` to choose Key Vault for a new install |
| `--secret-days <n>` | With `install` or `rotate-secret`, and no Key Vault: how many days the secret in the notebooks lasts, 1 to 730 (default 90) |
| `--allow-model-reset` | With `install`, `update` or `access`: when Fabric can't update a model and keep its data, clear the data and reload it without asking. Reports on that model show no data until the reload finishes |

**No Fabric: PAX + SharePoint route options.** Without `--target` or an install record, they
choose this route.

| Option | What it does |
|---|---|
| `--environment-id <id>` | With `install` or `deploy-app`: the Power Platform environment for a new app |
| `--folder <path>` | With `upload`: a subfolder of the SharePoint folder, such as `Exports/2026`. Missing folders are created. Names can include `#` and `%` |

## For maintainers

- **Layout.** `bin/valuelens-installer.js` starts the installer. `src/` has the commands and
  steps, with the browser page in `src/web/`, the PAX route in `src/steps/pax/` (the PowerShell
  the task runs is in `src/steps/pax/runner/`) and the app step in `src/managed-app/`. The names
  are in `src/product.js`. `packaging/` builds the exe and `install.ps1`.
- **npm scripts** (in `installer/`):
  - `npm start` runs `node bin/valuelens-installer.js`.
  - `npm test` runs `node --test`.
  - `npm run typecheck` runs `tsc -p jsconfig.json`.
  - `npm run build:exe` builds the exe, the zip and `install.ps1`. It needs Windows, Node.js
    24.11 or later (the exe ships the Node.js that builds it), the .NET Framework C# compiler that
    comes with Windows, and `npm ci` run first in `installer/` and `app/`. Without the app's
    dependencies the exe has no app, and its app step stops. Options: `--out <dir>` (default
    `./dist-exe`), `--keep` (keep the working folder), `--release` (fail rather than warn when
    something a published download needs is missing) and `--repo <owner/name>`.
- **Node.js.** The installer needs Node.js 22.13 or later (`engines` in `package.json`), because
  its Azure and prompt packages do. The app step and the exe build need 24.11 or later.
- **The workflow.** `.github/workflows/valuelens-installer-exe.yml` runs on
  `valuelens-installer-v*` tags, pull requests that touch the installer or what it carries,
  manual runs and published releases. It checks the tag matches the version in `package.json`,
  runs `npm ci` in `app/` and `installer/`, `npm test`, `npm run typecheck` and
  `npm run build:exe -- --release`, then smoke-tests the exe and `install.ps1`. On a tag it drafts
  a release with `--draft --latest=false`. A `-rc.N` tag makes a prerelease, which the update
  check skips. It never publishes a release: you publish it by hand. `--latest=false` keeps the
  repo's **Latest** release the dashboard's, so every installer link names its version.
- **Signing.** The exe is Authenticode-signed with ESRP outside the workflow
  (`packaging/sign-installer.azure-pipelines.yml`), which replaces the draft's exe, `.sha256` and
  notes. With the repo variable `REQUIRE_SIGNED_INSTALLER` set to `true`, publishing an unsigned
  release turns it back into a draft.
- **A new version.** Change `version` in `package.json`, and the pinned links in this README's
  [Install](#install) section and in [docs/INSTALL.md](../docs/INSTALL.md). `test/script.test.js`
  checks they match. Then push a `valuelens-installer-v<version>` tag.
- **The older installer.** `1. Fabric/installer` is the older Analytics Hub installer. It's built
  by `installer-exe.yml` on `installer-v*` tags.

Ported from the Analytics Hub installer at
[microsoft/AnalyticsHub-Dashboard@1af87db](https://github.com/microsoft/AnalyticsHub-Dashboard/commit/1af87db)
(installer 0.6.8-rc.2). Removed in the port: the Azure route, Credit consumption (Consumption
Central), Agent Evaluator, Ask, and the Analytics Hub app step.
