# Before you start

Everything you need before you install Analytics Hub, on one page, by who does it. Most of it
takes another admin a few minutes. Send them their part before you start, so you don't have to
stop halfway.

Once you sign in, the installer's **Prerequisites** panel (or `prereqs` in the terminal) checks
most of this for you. For the detail behind each permission, see [PERMISSIONS.md](PERMISSIONS.md).

- [How long it takes](#how-long-it-takes)
- [Send this to your Viva Insights analyst first](#send-this-to-your-viva-insights-analyst-first)
- [Checklist, by person](#checklist-by-person)
- [Optional extras](#optional-extras)
- [What it costs](#what-it-costs)

## How long it takes

| Step | Time |
|---|---|
| Answering the questions | About 5 minutes |
| Setting up, after you choose **Go ahead** | About 15 minutes |
| First data in the app, with 30 days of history | About 25 minutes after **Go ahead** |
| First data in the app, with 180 days of history | About 2 hours after **Go ahead** |
| Copilot Studio credits | After the Studio flow's first run. Run it straight away, or it runs the next day |

A tenant with more than 10,000 people takes longer: see [A large tenant](../1.%20Fabric/installer/README.md#a-large-tenant).

**Keep this PC awake and plugged in** until the installer says it's finished, and keep the
installer window open. If the PC sleeps, setup stops until it wakes.

## Send this to your Viva Insights analyst first

Only if you want **Copilot Cowork credits** from Viva Insights. The installer asks for the query's
IDs, and building the query can take a while, so ask for it now. Copy this:

> Hi, I'm setting up Analytics Hub, which reports Copilot Cowork credits from Viva Insights.
> Could you build a query for it?
>
> 1. In [Viva Insights](https://analysis.insights.viva.office.com/), go to **Analysis** and build a
>    query with the **Copilot credit** metrics. Turn on **Auto-refresh**.
> 2. Once it has run, go to **Analysis results**, choose the **link icon** next to the query, and
>    copy its **partition ID** and **query ID**.
> 3. Send me both IDs. Later, I'll ask you to sign in to a Fabric Dataflow that reads the query.
>
> You need the Viva Insights **Insights Analyst** role. Microsoft's guide:
> [Export query data to Microsoft Fabric](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric).

The installer fills in the partition ID with your tenant ID, which is usually right. No query
yet? Carry on: choose **Not yet** to **add the query later**. Until then, Cowork credits come
from the Copilot Consumption Dashboard's CSV export. Once you have the IDs, open the installer
again and choose **Repair or change**.

## Checklist, by person

One person can be several of these. A Global Administrator can do everything except the Viva
Insights part.

The installer registers an app in Microsoft Entra ID (the tenant's directory of people and apps)
called **Analytics Hub Data Collector**. It's the identity the daily loads sign in as. Several
items below give it access.

### You: the person who runs the installer

- [ ] **Windows 10 or 11** (64-bit). Or [Node.js](../1.%20Fabric/installer/README.md#without-the-exe) on
      another system.
- [ ] **A Fabric capacity you can use.** You're a Contributor on a capacity, or an Admin or Member of
      a workspace that's on one. The Fabric admin can give you this (see below).
- [ ] **Somewhere to keep the app's secret.**
      [Contributor](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#contributor)
      on an Azure subscription, or on one resource group, so the installer can create a
      [Key Vault](https://learn.microsoft.com/azure/key-vault/general/overview). Or access to a
      vault you already have. See [Where the secret goes](../1.%20Fabric/installer/README.md#where-the-secret-goes).
- [ ] **Permission to register an app** in Microsoft Entra ID. Everyone can by default
      ([who can](https://learn.microsoft.com/entra/identity/role-based-access-control/delegate-app-roles#restrict-who-can-create-applications)).
      If you can't, an admin registers it with the [admin pack](../1.%20Fabric/installer/README.md#if-you-cant-register-apps).
- [ ] **About 45 minutes**, with the PC awake and plugged in.

### Fabric admin: about 5 minutes

- [ ] **A capacity.** An F2 or larger [Fabric capacity](https://learn.microsoft.com/fabric/enterprise/licenses#capacity),
      or a [free trial](#what-it-costs). Use **F64 or larger** for a tenant with more than 10,000
      people. Make the person who runs the installer a **Contributor** on it.
- [ ] **Three tenant settings** turned on, in the Fabric admin portal under **Tenant settings**. They
      can be on for the whole organisation, or for a security group that the Analytics Hub Data
      Collector app is in:
  - [*Service principals can call Fabric public APIs*](https://learn.microsoft.com/fabric/admin/service-admin-portal-developer#service-principals-can-call-fabric-public-apis).
    Lets apps, not only people, work with Fabric, so the daily loads can run on their own.
  - [*Semantic Model Execute Queries REST API*](https://learn.microsoft.com/fabric/admin/service-admin-portal-integration#semantic-model-execute-queries-rest-api).
    Lets the app's pages query the model.
  - [*Fabric App items*](https://learn.microsoft.com/fabric/admin/tenant-settings-index#microsoft-fabric).
    Lets the installer create the Analytics Hub app in Fabric.
- [ ] **Leave on** *Users can access data stored in OneLake with apps external to Fabric*. It's on
      by default. The Power Automate flows need it.
- [ ] For the Power BI reports: *Allow visuals created using the Power BI SDK*, or some visuals
      stay blank.

If you're a Fabric admin yourself, the installer checks these settings for you.

### Power Platform admin: for the Copilot Studio credits flow

Only if you want **Copilot Studio credits** through the daily flow, or the optional product
feedback or agent inventory flows.

- [ ] **An environment for the flows.** Usually the default environment. The person who runs the
      installer needs to be able to create flows there (the Environment Maker role).
      [About environments](https://learn.microsoft.com/power-platform/admin/environments-overview).
- [ ] **Data policies allow the connector.** If the environment has
      [data policies](https://learn.microsoft.com/power-platform/admin/prevent-data-loss) (also
      called DLP), they must allow
      [**HTTP with Microsoft Entra ID (preauthorized)**](https://learn.microsoft.com/connectors/webcontents/).
      For the product feedback flow, it must be in the same group as **Office 365 Outlook**.
- [ ] **A Power Automate Premium licence** for whoever signs in to the Copilot Studio credits flow.
      HTTP with Microsoft Entra ID is a premium connector.
      [Licence types](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/types).
- [ ] **Someone signs in to the flow** once, after the install, as a Power Platform Administrator,
      Billing Administrator or Global Administrator. Often the same person.

### Viva Insights analyst: for Copilot Cowork credits

Only if you want **Copilot Cowork credits** from Viva Insights. Send them
[the note above](#send-this-to-your-viva-insights-analyst-first) first.

- [ ] Has the [Insights Analyst](https://learn.microsoft.com/viva/insights/advanced/setup-maint/assign-user-roles)
      role.
- [ ] Builds the query and sends you its partition ID and query ID, **before you start**.
- [ ] After the install, signs in to the `AnalyticsHub_Cowork_Credits` Dataflow once. See
      [Credit consumption](../1.%20Fabric/installer/README.md#credit-consumption).

### Entra admin: about 2 minutes

A [Global Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#global-administrator)
or [Privileged Role Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#privileged-role-administrator),
the Entra roles that can approve app permissions and give roles to apps. If you're one of them,
the installer does both of these itself, and you can skip this section.

- [ ] **Grant admin consent** for the Analytics Hub Data Collector app's Microsoft Graph
      permissions. They let it read the audit log, licences and org data, and nothing else unless
      you add an extra. All are read-only. The installer gives you a link to send.
      [Which permissions](PERMISSIONS.md#core-sources-required) ·
      [About admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent).
- [ ] **Give the Analytics Hub Data Collector app the Global Reader role**, for agent configuration.
      [Global Reader](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#global-reader)
      can read settings but change nothing. The installer gives you a message to send, with a link.
      [How to assign a role](https://learn.microsoft.com/entra/identity/role-based-access-control/manage-roles-portal).

Some organisations make admins switch a role on before they use it (Privileged Identity
Management). If yours does, switch the role on first, then sign in to the installer. A role that's
not switched on shows as **can be activated** in the Prerequisites panel.

### Microsoft 365 admin

- [ ] **Show real names in usage reports**, for Microsoft 365 activity (on by default). In the
      Microsoft 365 admin center, go to **Settings** > **Org settings** > **Services** > **Reports**
      and clear **Display concealed user, group, and site names in all reports**.
      [Why](https://learn.microsoft.com/troubleshoot/microsoft-365/admin/miscellaneous/reports-show-anonymous-user-name).
- [ ] **Schedule the product feedback export**, only if you want product feedback through the flow.
      In the Microsoft 365 admin center, go to **Health** > **Product feedback** and schedule the
      export to be emailed to the flow's mailbox, with the subject `Copilot Product Feedback`. This
      needs a Global Administrator or [Reports Reader](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#reports-reader).
      [About product feedback](https://learn.microsoft.com/microsoft-365/admin/misc/feedback-user-control#how-can-i-see-my-users-feedback).

### People who view the app

- [ ] [Power BI Pro or Premium Per User](https://learn.microsoft.com/power-bi/fundamentals/service-features-license-type),
      unless the workspace is on an [F64 or larger capacity](https://learn.microsoft.com/fabric/enterprise/licenses#per-user-or-individual-licenses).
- [ ] Membership of the **Analytics Hub Viewers** group. See [Share it](../1.%20Fabric/README.md#use-it).

## Optional extras

Copilot usage, licences and org data are always collected. Each extra is a card on the
installer's **Data sources** screen. Pick only the ones you want: what you skip stays empty, and
nothing fails.

| Card | What it needs, beyond the checklist |
|---|---|
| **Microsoft 365 activity** *(on by default)* | Real names in usage reports (Microsoft 365 admin). |
| **Agent 365 registry** | An [Agent 365](https://learn.microsoft.com/microsoft-agent-365/overview) licence for **Connected**. Without one, upload the export from the Microsoft 365 admin center. |
| **Product feedback** | No API. With the flow: a Power Automate Premium licence, a mailbox for the exports, and the export schedule (Microsoft 365 admin). Or upload the export yourself. |
| **Workday org data** | A Workday report of active workers with **Primary Work Email**, uploaded as a CSV. |
| **Credit consumption** | Three cards, below. |
| ↳ **Copilot Studio credits** | The Power Platform admin items above: environment, data policies, Premium licence and the sign-in. Or upload the exports from the Power Platform admin center each month. |
| ↳ **Copilot Cowork credits** | The Viva Insights query (Viva Insights analyst). The Dataflow that reads it is Fabric only. Or upload the Copilot Consumption Dashboard's export. |
| ↳ **Azure AI costs** | [Owner](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#owner) or [User Access Administrator](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#user-access-administrator) on the subscription, so the installer can give the app read-only cost roles. Otherwise someone with that role gives them. |
| **Agent Evaluator** | [System Administrator](https://learn.microsoft.com/power-platform/admin/database-security) in each Power Platform environment you pick, to add the app with the [Bot Transcript Viewer](https://learn.microsoft.com/microsoft-copilot-studio/analytics-transcripts-powerapps) role. Fabric only. |
| **Defender (shadow AI and agent risk)** | [Defender for Endpoint P2](https://learn.microsoft.com/defender-endpoint/minimum-requirements) or [Defender XDR](https://learn.microsoft.com/defender-xdr/prerequisites) for devices and agents, and [Defender for Cloud Apps](https://learn.microsoft.com/defender-cloud-apps/set-up-cloud-discovery) for Cloud Discovery. A part you aren't licensed for is skipped. |
| **Agent configuration and Foundry (Azure Resource Graph)** | Azure [Reader](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/general#reader) for the app on the [tenant root group](https://learn.microsoft.com/azure/governance/management-groups/overview) or a management group (someone who's an Owner there), and **Global Reader** for the app (Entra admin). The agent inventory flow needs the Power Platform admin items above. |
| **Ask data agent** (advanced settings) | A paid F2 or larger capacity, not a trial, and the Fabric tenant settings for data agents and Copilot. See [Ask](../1.%20Fabric/installer/README.md#ask). |
| **Your Azure subscription instead of Fabric** | [Contributor](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#contributor) plus [User Access Administrator](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#user-access-administrator), or Owner, on the subscription or resource group, and Power BI Pro. Agent 365, product feedback, Agent Evaluator, GitHub Copilot credits and Cowork credits through the Dataflow aren't on Azure yet. See [Azure target](../1.%20Fabric/installer/README.md#azure-target). |
| **GitHub Copilot credits** | Not in the installer. A GitHub [personal access token](https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) with `manage_billing:enterprise`, or the AI usage report export. See [Add Credit Consumption](../1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/README.md). |

The Microsoft Graph permissions each extra adds, such as
[`ThreatHunting.Read.All`](https://learn.microsoft.com/graph/permissions-reference#threathuntingreadall)
for Defender, are in [PERMISSIONS.md](PERMISSIONS.md). The Entra admin consents to them all at once.

## What it costs

Analytics Hub itself is free. It runs on services your organisation pays for. Prices vary by
region and agreement, so check the official pages:

- **Fabric capacity.** [Microsoft Fabric pricing](https://azure.microsoft.com/pricing/details/microsoft-fabric/).
  Sizes run from F2 upwards ([capacity sizes](https://learn.microsoft.com/fabric/enterprise/licenses#capacity)).
  F2 is enough to start. Use **F64 or larger** for a tenant with more than 10,000 people. Small and
  trial capacities work, but loads take longer, and a trial can't run the Ask data agent.
- **Fabric free trial.** 60 days, at no cost:
  [start a free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).
  Before it ends, move the workspace to a paid capacity, or its notebooks and pipeline stop.
- **Power BI for viewers.** Below F64, each viewer needs Power BI Pro or Premium Per User.
  [Power BI pricing](https://www.microsoft.com/power-platform/products/power-bi/pricing).
- **Power Automate Premium**, for whoever signs in to the flows.
  [Power Automate pricing](https://www.microsoft.com/power-platform/products/power-automate/pricing).
- **Azure Key Vault**, for the app's secret. Billed per operation, which is small for a few reads
  a day. [Key Vault pricing](https://azure.microsoft.com/pricing/details/key-vault/).
- **Azure, only on the Azure target:**
  [Container Apps](https://azure.microsoft.com/pricing/details/container-apps/),
  [Storage](https://azure.microsoft.com/pricing/details/storage/blobs/),
  [Azure SQL Database](https://azure.microsoft.com/pricing/details/azure-sql-database/single/),
  and Azure OpenAI tokens for the Ask page.
  Estimate them with the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/).

Copilot credits aren't charged by Analytics Hub: it reads what you've already used.
