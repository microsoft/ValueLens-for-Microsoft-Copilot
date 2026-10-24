# Install

The ValueLens installer sets ValueLens up in your tenant, then you check it worked. It has two
routes: **Fabric**, and **No Fabric: PAX + SharePoint**. To set it up by hand instead, follow
[1. Fabric](../1.%20Fabric/README.md) or [4. SharePoint](../4.%20SharePoint/README.md). What each
route sets up, the commands and troubleshooting are in the
[installer's README](../installer/README.md).

Check the [prerequisites](PREREQUISITES.md#the-valuelens-installer) first. Then start the
installer one of these ways. They all run the same installer and ask the same questions.

| Your PC | Start with |
|---|---|
| Windows | [The PowerShell one-liner](#from-powershell) |
| Windows, and you'd rather download a program | [The exe](#run-it) |
| Windows, with a Node.js your IT team has approved | [IT-approved Node.js](#it-approved-nodejs) |
| Locked down, or not Windows (Fabric route only) | [Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell) |
| Nothing can run on your PC, and no Cloud Shell | Ask your IT team |
| A clone of this repo, with Node.js | [Without the exe](#without-the-exe) |

If your organisation's policy blocks a route, don't work around it. Use another route, or ask
your IT team.

**Which route.** After you sign in, the installer asks **Where should ValueLens run?** On the
command line, `--target fabric` or `--target pax` answers it.

- **Fabric.** Notebooks and a pipeline in a Fabric workspace load the data into a Lakehouse each
  day, for the report. Needs a Fabric capacity (F2 or larger, or a trial).
- **No Fabric: PAX + SharePoint.** A daily task on this Windows PC runs PAX and writes the data to
  a SharePoint folder, which the report and the app read. Needs Power BI Pro, PowerShell 7.2 or
  later and Python 3.10 or later. Run the installer on the PC that will run the task. Azure Cloud
  Shell can't set it up.

An install stays on the route it started on. More in
[What it sets up](../installer/README.md#what-it-sets-up).

When it finishes: [Check it worked](#check-it-worked).

## Run it

Paste this into PowerShell (see [From PowerShell](#from-powershell)):

```powershell
irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1 | iex
```

Or download
[ValueLensInstaller.exe](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/ValueLensInstaller.exe)
and open it. Both get installer 0.1.0. Other versions are on the
[installer releases](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=valuelens-installer-v)
page. Don't use the repo's **Latest** release: it's usually a dashboard release, not the
installer. To check the exe, see [Check the download](#check-the-download). If your organisation
blocks either, use another route in the table above.

1. The first time, it takes about a minute to unpack. Then it opens in your browser. Keep its
   window open while you use the page. If you close the page, go back to that window and press
   **Enter** to open it again. The installer keeps the PC awake until it exits, so keep it
   plugged in.
2. Choose **Set up ValueLens** and sign in: **Browser** (a Microsoft sign-in window opens on this
   computer), **Code** (sign in on any device with a code) or **Azure CLI**.
3. Choose the route.
4. Answer the questions.
   - **Fabric.** The page shows your settings in categories: **Data collection**, **Fabric
     placement**, **Power BI**, **Viewer access**, **Identity and secrets**, **Module
     connections**, **Governance and flows**, and **Schedule and loading**. Each is marked
     **Needs review** or **Reviewed**. Open each one, check its answers and save it. When they're
     all reviewed, choose **Review and deploy**. **Save and close** keeps your choices as a
     draft for next time.
   - **No Fabric: PAX + SharePoint.** First it checks this PC: PowerShell 7.2 or later, an
     execution policy that runs local scripts, full language mode, and Python 3.10 or later. If
     something's missing, it says what to install or change, and stops. Then it asks, one
     question at a time:
     - **What it collects**, then **Change the advanced settings?** **No** keeps the defaults
       for the Agent 365 file, who can view, the new workspace's name, the first load's history
       and when the refresh runs.
     - **Where the files go**: the address of a folder in a SharePoint document library.
     - **Power BI workspace for the report**: a new one, or one you're in.
     - **The app**: **Deploy the ValueLens app?** Yes by default.
     - **App registration**: create **ValueLens (PAX)**, or use one you already have.

     Choose **Back** to change an earlier answer.
5. Check the plan: what it creates, who gets access to what, and where it runs. Choose
   **Go ahead**. Nothing is created until you do.
6. Wait for it to finish.
   - **Fabric.** Loading the history usually takes under an hour, longer on a trial or small
     capacity, and longer again for [a large tenant](../installer/README.md#a-large-tenant). Once
     the first load has started, you can close the page: the run carries on in Fabric.
   - **No Fabric: PAX + SharePoint.** The first load runs on this PC, in the background, straight
     after setup. It can take hours on a large tenant. Leave the PC on, and stay signed in, until
     it finishes.
7. Read the Done page. See [Check it worked](#check-it-worked).

**The install record.** The installer keeps your answers in `Documents\ValueLens`, in an install
record named `valuelens-setup.json`. It holds no secrets. Keep that folder. To run, check, update
or repair the set-up later, start the installer again the same way. **Manage ValueLens** shows
the record's full path. Choices you haven't approved yet are kept beside it, in
`valuelens-setup.json.draft.json`.

**The workspace has gone?** On the Fabric route, after you sign in, the installer checks that the
record's workspace still exists. If Fabric says it doesn't, or the record is for another tenant,
the home page says so. Choose **Start fresh** to set up again. The old record is kept beside the
new one, renamed with the date and time, such as `valuelens-setup.20260507-090302.json`. Or
choose **Keep this record** to carry on with it.

**Using a workspace that already has things in it?** The installer never changes anything it
didn't create. If one of its names is taken, its own item gets the next free name, such as
`ValueLens Model 2` or `ValueLens_Pipeline_2`. The plan shows the names before you approve it.

**Analytics Hub.** The installer won't use a workspace that holds an Analytics Hub install, which
already has the ValueLens report. It also leaves alone an Analytics Hub install record
(`valuelens-install.json`), or one from this repo's earlier installer. Manage those with the
[Analytics Hub installer](https://github.com/microsoft/AnalyticsHub-Dashboard).

## Check it worked

1. **Read the Done page.** It starts with "N steps left": a card for each thing still to do, with
   who does it, why, a link and the steps. For a step another admin does, the card has a message
   to copy and send. See [After it finishes](#after-it-finishes).
2. **Check what loaded** (Fabric). After the first run, each source has a card: loaded, warning,
   failed, skipped or still running. A failed card says why and what to do. The same is in the
   Lakehouse table `dbo.load_log`. See
   [Load status and reruns](../installer/README.md#load-status-and-reruns).
3. **Check status.** Open the installer again and choose **Check status** (`status`). It changes
   nothing.
   - Fabric: recent runs, model refreshes, secret expiry and the last data check.
   - PAX: the scheduled refresh and its last run, the client secret, the SharePoint folder and
     the model's last refresh.
4. **Check the data.**
   - Fabric: **Check the data** (`check`) reads the Lakehouse tables again for row counts, date
     ranges and licence matches, without running the pipeline.
   - PAX: **Check the SharePoint folder** (`check`) checks that the app registration can still
     write to the folder.
5. **Open the report**, and on the PAX route, the app. Pages for sources you skipped stay empty.

Something failed? On the Fabric route, choose **Rerun failed loads** (`rerun-failed`). On the PAX
route, choose **Run now** (`run`). Or see [Troubleshooting](../installer/README.md#troubleshooting).

### After it finishes

The Done page shows only the cards that apply to your answers.

- **Fabric:**
  - **Share the report with ValueLens Viewers**, if you chose **Later** when asked.
  - **Sign in to the Power Automate flows**, if you chose one. You or a Power Platform
    administrator does it.
  - **Ask for Global Reader** for the app registration, when agent configuration comes from Azure
    Resource Graph. Only a Privileged Role Administrator can assign it.
  - **Ask for the product feedback export**, when its flow is on.
- **No Fabric: PAX + SharePoint:**
  - **Ask for the app's access to the SharePoint site**, if your account couldn't give it. A
    SharePoint Administrator or Global Administrator runs the commands in the message.
  - **Wait for the first refresh to finish**, **Fix the first refresh** if it failed, or **Check
    Copilot activity is audited** if it found none.
  - **Publish the report from Power BI Desktop**, if Power BI didn't take it through its API.
  - **Sign ValueLens in to SharePoint**, if you chose **Later**. Until then the report has no data.
  - **Share the report with ValueLens Viewers**, if you chose **Later** when asked.
  - **Ask for managed apps to be turned on**, if the tenant wasn't ready for the app.
  - **Finish the ValueLens app**, if the app step stopped.
  - **Keep the refresh running while you're signed out** (optional), or **Store the password for
    the scheduled task** if the task was changed not to store one.
  - **Ask for the app's access to the old site to be taken back**, if you moved the folder to
    another site and your account couldn't take that access back.

**Admin consent.** If you couldn't grant it, the installer gives you a link for a Global
Administrator or Privileged Role Administrator, and skips the first load. Once they've approved
it, run the command the installer printed: `run --backfill-days <days>` on the Fabric route, or
`run` on the PAX route.

**Viewers.** The installer creates **ValueLens Viewers** (or uses a group you name), with you as
owner, and gives it **Build** on the semantic model. The group gets no workspace role. Then:

1. **Once:** share the report with the group. The installer asks you to: in the workspace, choose
   **…** (More options) next to the report, then **Manage permissions** > **Add user**. Enter the
   group and choose **Grant**. Then choose **I've shared it**. **Later** leaves a card on the
   Done page, and Repair asks again.
2. **To give someone access:** add them to the group in
   [My Groups](https://myaccount.microsoft.com/groups), or run `access` (**Manage access** in the
   browser).

Keep viewers off workspace roles. More in [Viewer access](../installer/README.md#viewer-access).

## Check the download

Each [installer release](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=valuelens-installer-v)
lists the exe's SHA-256, which is also in `ValueLensInstaller.exe.sha256`. To check your copy,
run this in PowerShell, in the folder you downloaded it to:

```powershell
(Get-FileHash .\ValueLensInstaller.exe -Algorithm SHA256).Hash
```

It should match, ignoring capitals. If it doesn't, delete the file and download it again.
`install.ps1` checks the zip's SHA-256 for you the same way.

A matching hash confirms the file is the one in the release. It doesn't confirm who published it.
The release notes say whether that release's exe is code-signed:

- **Signed.** To check, right-click the exe and choose **Properties**, then **Digital
  Signatures**.
- **Not signed.** Edge and Windows SmartScreen may warn about it. If your organisation's policy
  blocks it, don't work around it. Use the [PowerShell one-liner](#from-powershell) or another
  route in the table at the top, or ask your IT team.

## From PowerShell

Paste this into PowerShell (Windows PowerShell 5.1 or PowerShell 7). It runs the same installer
as the exe, with the same browser steps:

```powershell
irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1 | iex
```

It downloads `ValueLensInstaller.zip` from that release (Node.js, the installer and everything it
deploys, including the app, already built), checks its SHA-256 against the one written into
`install.ps1`, unpacks it under `%LOCALAPPDATA%\ValueLens` and opens the installer in your
browser. It needs no admin rights and installs nothing system-wide. It removes other versions it
unpacked there.

- **Later commands.** It leaves a command behind for the version it unpacked:
  `& $env:LOCALAPPDATA\ValueLens\valuelens.cmd`. With no arguments it opens the browser steps.
  Add a command to use the terminal, for example
  `& $env:LOCALAPPDATA\ValueLens\valuelens.cmd status`. If that version has since been removed,
  it prints the install command to run.
- **A fixed version.** Each command is pinned to one release. The release notes and the
  installer's update banner give the command for a newer one. If a release's zip has since been
  removed, `install.ps1` says so, points you to the installer releases and stops. It doesn't
  switch versions on its own.
- **Download and run.** To keep the files, download `install.ps1` and `ValueLensInstaller.zip`
  from the same release and, where your execution policy allows scripts, run
  `.\install.ps1 -ZipPath .\ValueLensInstaller.zip`. Anything after the options goes to the
  installer, for example `.\install.ps1 -ZipPath .\ValueLensInstaller.zip status`.
- **If policy blocks it.** If execution policy, endpoint protection or another control blocks
  `irm | iex` or the script, don't work around it. Use another route in the table at the top, or
  ask your IT team.
- **Behind a proxy.** To download through a proxy, signed in as you, run
  `$env:VALUELENS_PROXY = 'http://proxy:8080'` first, or use `-Proxy`. If the proxy blocks
  GitHub's download host, download the zip in a browser and set `$env:VALUELENS_ZIP` to its path,
  or use `-ZipPath`.
- **Constrained Language Mode** works for the launcher. It skips keeping the PC awake, so keep the
  PC plugged in and awake yourself. The PAX route's refresh needs full language mode: see
  [Prerequisites](PREREQUISITES.md#the-valuelens-installer).
- **Remove it** with `.\install.ps1 -Uninstall` (from the download-and-run steps above). It
  removes the unpacked installer and its command. Your install record in `Documents\ValueLens`
  stays, and so does the `pax` folder that a scheduled PAX refresh runs from. To remove what's in
  your tenant and the scheduled refresh, use **Uninstall** in the installer first. See
  [Remove the installer](../installer/README.md#remove-the-installer).

AppLocker or App Control for Business rules that block programs under your profile stop the
unpacked `node.exe`, as they stop the exe. The launcher and the exe spot this and say what to do
instead of showing the raw error. If your IT team has approved a Node.js install, for example
from Company Portal, use [IT-approved Node.js](#it-approved-nodejs). Otherwise use
[Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell) for the Fabric route, or ask your IT
team.

## IT-approved Node.js

If your organisation has installed an approved Node.js (x64; 22.13 or later on 22.x, or 24.x), the
PowerShell launcher can run the installer with it instead of the `node.exe` in the zip:

```powershell
$env:VALUELENS_USE_INSTALLED_NODE = '1'; irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1 | iex
```

Or, from the [download-and-run](#from-powershell) files,
`.\install.ps1 -ZipPath .\ValueLensInstaller.zip -UseInstalledNode`.

- **Which Node.js.** The `node` on your PATH. It stops if there's none, or it isn't x64.
- **What's still downloaded.** The same zip, checked the same way and unpacked to
  `%LOCALAPPDATA%\ValueLens`. It holds the installer and the app. The zip's `node.exe` is
  unpacked but not run.
- **The app needs Node.js 24.11 or later.** The managed apps CLI that deploys it needs that. With
  an older Node.js, the installer skips the app and the Done page has a **Finish the ValueLens
  app** card. The rest of the set-up doesn't need it.
- **Same install.** It uses the same folders and the same install record as the other Windows
  routes. The command it leaves behind, `valuelens.cmd`, keeps using the approved Node.js, and so
  does the update command the installer shows.

## Locked-down tenant / Azure Cloud Shell

If your PC can't run the exe or the PowerShell command (AppLocker, App Control, or no local
PowerShell at all), you can run the **Fabric** route in [Azure Cloud Shell](https://shell.azure.com)
instead. Nothing runs on your PC: the installer runs in Cloud Shell and asks its questions in the
terminal. The **No Fabric: PAX + SharePoint** route can't run there: its daily task needs a
Windows PC.

Choose **PowerShell** in Cloud Shell and paste the same command:

```powershell
irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1 | iex
```

In Cloud Shell, `install.ps1` doesn't download the Windows zip. It fetches the release's source
from GitHub with git, at the commit written into `install.ps1`, checks it got that commit, and
installs the installer's packages with `npm ci`. If Cloud Shell's Node.js is older than 22.13, it
downloads the Node.js version the release was built with from nodejs.org, and checks its SHA-256
against the list nodejs.org publishes. It all goes in `~/.valuelens`.

- **Options.** To pass options or a command, run
  `& ([scriptblock]::Create((irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1))) --use-az status`.
  In Bash, run
  `pwsh -c "irm https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/valuelens-installer-v0.1.0/install.ps1 | iex"`.
- **Later commands.** It leaves `~/.valuelens/valuelens` behind, which works from Bash or
  PowerShell, for example `~/.valuelens/valuelens status`. To update, run a newer release's
  install command.
- **Terminal only.** Cloud Shell can't open the installer's page in your browser, so `--ui` isn't
  available. The terminal asks the same questions, one at a time.
- **Signing in.** By default the installer signs you in with a code: it shows a code and a link,
  and you sign in on any device within 15 minutes. The tokens stay in memory, so each run asks
  again. Cloud Shell's own sign-in, which the Azure CLI uses until you sign it in, can't get tokens
  for some of the APIs the installer uses. To use `--use-az`, first run
  `az login --use-device-code`. The installer then checks that the Azure CLI can reach every API
  it uses before it changes anything.
- **Keep the install record.** It's in `~/valuelens/valuelens-setup.json`. Your home folder is
  kept between sessions only if Cloud Shell has a storage account (it then has `~/clouddrive`);
  `install.ps1` warns if it doesn't. Without the record, running the installer again sets up a
  second copy. So in that case, download it before you close Cloud Shell: choose **Manage files**
  > **Download** and enter the path the installer gives you. It reminds you at the end of each
  run. In a new session, upload it with **Manage files** > **Upload** and run the installer
  again: it moves the uploaded record from your home folder to where it looks. To carry on from a
  Windows PC later, put the record in `Documents\ValueLens`.
- **Idle timeout.** Cloud Shell signs you out after 20 minutes without input. If that stops the
  installer, run the same command again: it carries on from the install record. `--no-wait` saves
  waiting for the first load.
- **Remove it** by deleting `~/.valuelens`, or with the **Options** command above and
  `-Uninstall` in place of `--use-az status`. Your install record in `~/valuelens` stays.

`install.ps1` spots Cloud Shell from its environment. To force it either way, set
`$env:VALUELENS_CLOUD_SHELL` to `1` or `0` first. Cloud Shell is the PowerShell launcher's only
Linux target. On other Linux or macOS machines, use [Without the exe](#without-the-exe), for the
Fabric route.

## Without the exe

If you can't run the exe, run the installer from a clone of this repo with Node.js 22.13 or
later:

```text
cd installer
npm ci
npm start -- --ui
```

Leave out `--ui` to answer the questions in the terminal. `npm start` runs
`node bin/valuelens-installer.js`, so `npm start -- status` runs a command. Add `--help` for the
commands and options, or see [Commands and options](../installer/README.md#commands-and-options).
The exe takes the same commands, for example `ValueLensInstaller.exe status`.

From a clone, the PAX route's app step needs a build of the app and the managed apps CLI, and
Node.js 24.11 or later. From the repo's root:

```text
cd app
npm ci
node scripts/prepare-sample.mjs
npm run build
cd ..
npm ci --ignore-scripts --omit=dev --prefix installer/managed-cli
```

Without them, the installer skips the app, and the Done page says how to finish it. The exe and
the PowerShell launcher carry both.

`install --yes` keeps the client secret in the notebooks for a new Fabric install. Read
[Where the secret goes](../installer/README.md#where-the-secret-goes) first, and add `--key-vault`
to use Key Vault instead. `--secret-days <n>` sets how long the secret in the notebooks lasts.
