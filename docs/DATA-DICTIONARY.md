# Data Dictionary & Source Contract

This is the **single source of truth** for the tables the dashboard consumes. Both deployment
versions read the *same* logical tables with the *same* column names — only the **source layer**
differs:

| Version | Source layer | Each table loads via |
| --- | --- | --- |
| **Fabric** | OneLake Lakehouse (Delta) | `FabricTable("<delta_table>")` via either the SQL analytics endpoint or the OneLake Tables endpoint |
| **SharePoint** | CSV files in SharePoint/OneDrive | `SharePointCsv("<file>")` / `Web.Contents(...)` |

Because the schema is identical, the report, every measure, and all downstream M is shared. A
producer (notebook or script) is "compatible" **iff** the Delta table / CSV it writes exposes the
exact column names below (casing and spaces matter).

> Copilot Studio transcripts and credit consumption are add-ons with their own tables: see
> [Add Agent Evaluator](../1.%20Fabric/Manual%20setup/Add%20Agent%20Evaluator/README.md) and
> [Add Credit Consumption](../1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/DATA-DICTIONARY.md).

---

## Tier model — core vs optional

Optional sources must **degrade to an empty table with the correct columns** when absent, so the
template never breaks. Each one is wrapped in `try … otherwise` and switched by its `Enable_*`
parameter.

| # | Dashboard table | Lakehouse Delta name | Tier | Fabric producer | SharePoint producer |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat + Agent Interactions (Audit Logs) | `copilot_interactions_curated` | **Core** | `Copilot_Audit_Log_Direct_Ingester` → `Copilot_Audit_Log_Processor` | `GetCopilotInteractions*` |
| 2 | Copilot Licensed | `copilot_licensed_users` | **Core** | `Copilot_Licensed_Users_Direct_Ingester` | `GetCopilotUsers*` |
| 3 | Chat + Agent Org Data | `copilot_org_data` | **Core** | `Copilot_Org_Data_Direct_Ingester` *(+ optional `notebooks/workday-org-data/` overlay)* | `Get-EntraOrgData*` |
| 4 | Agents 365 | `agents_365` | *Optional* | `Copilot_Agent365_Registry_Ingester` *(API, primary)* → `Copilot_Agent365_Lander` *(CSV fallback if the API step fails)* | `Get-Agents365Registry.ps1` *(API)*, or an admin centre export via `-Agents365Csv` *(fallback)* → `Agent 365` CSV (also Local CSV and the Dataverse template) |
| 5 | ProductFeedback | `user_feedback` | *Optional* | `Copilot_ProductFeedback_Ingester` | OCV feedback CSV (`Feedback File`) |
| 6 | Defender AI Watchlist, Shadow AI Daily, Shadow AI Totals, Defender AI Installed, Defender Cloud Discovery, Defender AI Agents, Defender Status | `defender_*` (7 tables) | *Optional* (off by default) | `Copilot_Defender_Ingester` | None. Fabric and Azure only (Azure: the `defender` jobs module) |
| 7 | Agent Configuration, Power Platform Environments, Agent Flows, Foundry Resources, Resource Graph Status | `arg_agent_config`, `arg_environments`, `arg_agent_flows`, `arg_foundry_resources`, `arg_status` | *Optional* | `Copilot_Resource_Graph_Ingester` *(Azure Resource Graph, with the Agent inventory flow's JSON as the fallback for agents)* | — *(Fabric and Azure only; the Azure jobs' module `resourceGraph`)* |

> **Delta table names are lower-case** throughout (`copilot_interactions_parsed`,
> `copilot_interactions_curated`, …). The dashboard table names in column 2 are the *model* names and
> may contain spaces.

> **`Environment` is licensing only** (`Licensed` / `Unlicensed`). Cowork is identified by
> `Agent Filter = "Cowork"`. Older processor output that still carries `Environment = "Cowork"`
> is mapped back to its licence (`Licensed`, or `Unlicensed` when `License Status` says so) by the
> non-Fabric templates' interactions query, so Cowork never appears in the Environment slicer.

All other model tables (Calendar, legends, ranking/summary, glossary, value maps, etc.) are
**calculated/DAX or static** — they have no external source and are version-independent.

> **`Calendar`** runs from the earliest to the latest date across the audit (`CreationDate`) and
> product feedback (`FeedbackDate`). On Fabric installs made by the Analytics Hub installer it also
> covers `M365 Activity[ActivityDate]`. With no dates in any of them it holds the last 365 days up
> to the refresh date, so date slicers still work before the first audit load.

---

## Core tables

### 1. `copilot_interactions_parsed` — audit interactions (ingester output)
Producer flattens Purview/Graph `CopilotInteraction` audit JSON **upstream** (the report M is a thin
pass-through guarded by `Table.HasColumns`, so missing optional columns are tolerated).

```
CreationDate, AgentId, AgentName,
AppIdentity_AppId, AppIdentity_DisplayName, AppIdentity_PublisherId,
AppIdentity_Text, Agent_TargetPlatformId, Agent_TargetName, Agent_PlatformType,
ApplicationName, ClientRegion,
Audit_UserId, Audit_UserId_Normalized, Workload,
AppHost, ThreadId, SensitivityLabelId, Context_Type,
AISystemPlugin_Id, AISystemPlugin_Name, ModelTransparencyDetails_ModelName,
AccessedResource_Type, AccessedResource_Action, AccessedResource_SiteUrl, AccessedResource_SensitivityLabelId,
Message_Id, Message_isPrompt, Resource_Count,
InteractionDate, WeekStart, MonthStart,
Agent_TitleID, Agent_EntraId,
AgentPlatform, PlatformAgentId, ConversationId, Prompts_Available,
Agent_BotId, Agent_EnvironmentId, Exclude_Reason
```

> **Agent identifiers (three keys).** `Agent_TitleID` is parsed from the legacy
> `CopilotStudio.Declarative.{title}` / `T_`/`P_` forms. `Agent_EntraId` captures the **Microsoft
> Entra Agent ID** GUID that **Agent 365** now stamps into the audit `AgentId` instead of the
> declarative string (an all-zero GUID is treated as no ID). The two are populated mutually
> exclusively per row. `Agent_BotId` and `Agent_EnvironmentId` are parsed from `PlatformAgentId` on
> Copilot Studio runtime records (`AgentPlatform` "CopilotStudio"), which usually carry no Title ID.

> **Agent-type inputs.** `AppIdentity_Text` is the raw `AppIdentity` value. Microsoft documents it as
> a `workload.appGroup.appName` string (for example `Copilot.Studio.<AppId>` or
> `MicrosoftAgent.Researcher.P_<id>`); when the record holds an object instead, its `DisplayName` is
> used. `Agent_TargetPlatformId`, `Agent_TargetName` (falling back to `CopilotEventData.AgentName`) and
> `Agent_PlatformType` come from `CopilotEventData`. The processor uses all four only to compute the
> [agent type columns](#agent-type-and-publisher); linking does not use them.

> **Records with no prompt.** A Copilot Studio agent used in Teams or another channel logs a
> record with no `Messages`. A Microsoft 365 Copilot **Cowork scheduled or autonomous run** (app
> host `Cowork`, or an `AppIdentity` starting `Copilot.M365Copilot.Cowork`) logs a record whose
> messages hold no prompt. Both are kept as one task row per record, with `Prompts_Available` FALSE,
> `Message_isPrompt` FALSE, a `message:none` `Message_Id` and no resource fan-out. The user still
> counts as active, but the row adds no AI task, prompt or session; the model's `Is Usage Row`
> column (`Is Prompt Row` or `Is_Cowork`) and the `Cowork Scheduled Runs` measure count them. Every
> other record without a prompt is still dropped. `ConversationId` falls back to the record's
> `ConversationId` when it has no `ThreadId`.

> **`Exclude_Reason`** flags records that are not end-user agent usage: Copilot Studio test pane,
> maker evaluation, agent authoring, autonomous and workflow runs, the M365 Copilot twin of a
> runtime record, and Fabric multi-agent records. They stay in `_parsed`; the processor drops every
> reason in `DROP_EXCLUDE_REASONS` (all of them by default). The rules are in
> [METHODOLOGY §2.1](METHODOLOGY.md#21-which-audit-records-count).

> **`AppHost`** is the Microsoft 365 surface the interaction happened in, such as Word, Outlook,
> Microsoft365Chat or Cowork. It records where Copilot was used, not what the person did. What each
> value means, and which values set a task, are classified by what they touched or are excluded, is in
> [METHODOLOGY §3.5](METHODOLOGY.md#35-app-host-reference).

### 1b. `copilot_interactions_curated` — the table the Fabric model actually reads
`Copilot_Audit_Log_Processor` reads `copilot_interactions_parsed` (joining `copilot_licensed_users`
and `agents_365`) and writes **`copilot_interactions_curated`**. This — not the `_parsed` table — is
what the Fabric template's `Chat + Agent Interactions (Audit Logs)` partition binds to. It is the
same shape the template's Power Query used to produce, but computed once in Spark and V-Ordered on
disk so the shipped Import templates can read a flat fact table quickly.

**Schema:** additive canonical shaping plus the 32 enrichment columns below, **not**
a verbatim copy of every parsed column. By default the processor consumes/drops
`AppIdentity`, `AccessedResources`, `AISystemPlugin` and `Audit_UserId_Normalized`,
and removes internal join/enrichment helpers.

With `INCLUDE_RAW_PASSTHROUGH = True`, the first three payloads are retained as string
columns `AppIdentity_Raw`, `AccessedResources_Raw` and `AISystemPlugin_Raw`; the original
`Audit_UserId_Normalized` is retained when supplied. Unknown/nested/case-variant JSON
keys remain in these complete raw payloads, not dynamically flattened columns. Canonical
values and resource-row grain do not change. The entire resource array is repeated for
each exploded row, and the raw plugin array includes elements after the first.
See [settings you might change](../1.%20Fabric/Manual%20setup/notebooks/README.md#settings-you-might-change)
before enabling this default-off option.

```
Environment, License Status, Is_Sensitive, AI_Model,
Behavior_Category, Behavior_Enriched, Behavior_Enriched_Full, Behavior_Source,
Value_Outcome, Usage_Mode, Expertise_Role, Efficiency_Breakdown,
Web_Grounded_Signal, Behavior_Plausible, Workflow_Action,
Is_Agent_Activity, Agent Filter, Grounding Source, Agent_Surface, Execution_Trigger,
UserMonthKey, Delegation_Event_Key, ActivityDate, Agent Last Used Date,
User_Stage_Maturity, User_Stage,
Agent_Key, Agent_Type, Agent_Type_Basis, Agent_Publisher, Agent_Is_Published,
Agent_Consolidated_Name
```

**Names in the report.** The report and the Fabric App show `Behavior_Enriched_Full` as **Task
Breakdown**, and the 12 groups it rolls up to (the model's `Task Breakdown Group` column) as **Task
Category**. Each task's plain-English description comes from the static `Behavior Value Map` table
inside the `.pbit`, not from this table.

It also carries the agent link: `Agent_LinkID` (the registry Title ID the row belongs to, the
relationship key to `agents_365`), `Agent_MatchedTitleID` (the Title ID that actually matched,
before LOB/Shared copies are merged) and `Agent_LinkMethod` (`Title ID`, `Bot Id`,
`Entra Agent ID`, `Schema GUID`, `Unlinked`, or null when the row names no agent key). The raw keys
`Agent_TitleID`, `Agent_EntraId`, `Agent_BotId`, `Agent_EnvironmentId`, `AgentPlatform`,
`PlatformAgentId`, `Prompts_Available` and `Exclude_Reason` pass through. See
[agent identity resolution](#agent-identity-resolution).

> **`Behavior_Category` is the join key for the value model.** It relates to the static
> `Human Time Estimates` table inside the `.pbit`, which holds the per-behaviour
> `Human Baseline (min)` figures. `Estimated Hours Saved` resolves those at query time via
> `RELATED` — the baselines are **not** materialised into this Delta table.
>
> Use `WRITE_MODE = "overwrite"` for the first backfill, then `"merge"` for daily runs. The notebook
> asserts all 32 columns are present before writing, so a partial enrichment fails loudly rather than
> silently shipping an incomplete fact table.

### 2. `copilot_licensed_users` — licensed user list
The producer sanitizes spaces→underscores, writing `User_Principal_Name` and `Has_license`; the
model's variant lists accept both those and the spaced/camel forms (see finding **B** below — resolved).
Key columns:

```
User_Principal_Name  (canonical join key; also accepts: User Principal Name / userPrincipalName / UserPrincipalName)
Has_license          (Yes/No flag; also accepts: Has license / HasLicense / HasCopilot / …)
UPN_Normalized       (lower(trim(UPN)) — dedupe + join key)
… plus all Office365ActiveUserDetail columns (sanitized)
```

### 3. `copilot_org_data` — Entra org / people data
Dashboard normalizes dynamically (UPN/PersonId variants, `Department`→`Organization`) and adds
`PersonId_Normalized` + `TotalEmployees` if missing.

```
id, PersonId, displayName, Organization, JobTitle, companyName,
officeLocation, city, country, accountEnabled, managerUPN
```

**Join key:** `PersonId` = **userPrincipalName (UPN)** — used by the **Audit Logs** path
(`Audit_UserId → PersonId`). `id` (AAD object id) is also emitted for downstream joins.

#### Optional Workday / HRIS enrichment or standalone source

`Copilot_Org_Data_Workday_Lander` ([`notebooks/workday-org-data/`](../1.%20Fabric/Manual%20setup/notebooks/workday-org-data/README.md))
lands a worker extract from `Files/org_workday/` as a user-level org table. Default `MODE='auto'`
uses additive enrichment if `BASE_TABLE` exists, or standalone mode if it is absent. An invalid
existing baseline is rejected, not silently replaced. It remains an optional source, not a
required step in the core pipeline.

Enrichment joins normalized **work email to `PersonId`** and preserves every existing baseline
column and value, including blank attributes and the Entra hierarchy. Only new column names are
added; comparisons ignore case and account for output-name sanitization. Workday-only people are
excluded. A user ID that is not an email needs an explicit upstream mapping.

```
Job_Profile, Job_Family, Job_Family_Group, Persona, Compensation_Grade,
Worker_Type, Worker_SubType, On_Leave, IsOnLeave, sub_Country,
Function, Location, primaryWorkEmail, OrgData_Source
```

The PBIT's org query reads `copilot_org_data`; its existing `Audit_UserId` to `PersonId` relationship
connects matching users to interactions after refresh. This notebook does not create new model
relationships. Review the refreshed schema before using additional columns in visuals.
Existing baseline metadata is preserved rather than relabelled as Workday data.

Enrichment adds absent source columns without interpreting differently named Workday fields as
Entra attributes. No existing field is overwritten or filled, even if its Entra value is null.
This intentionally changes the earlier lander's Workday-precedence behavior. The safe default
output is `dbo.copilot_org_data_workday_preview`; publishing to the model requires explicitly
selecting `dbo.copilot_org_data` and allowing baseline overwrite when it is also the input.

Standalone mode needs no Entra input. It uses Workday work email for `PersonId` and
`PersonId_Normalized`, retains the extract's attributes, and supplies canonical nullable columns
where unavailable. Only standalone mode supplies missing canonical mappings such as `JobTitle`
from `Job_Profile`. It does not invent a manager hierarchy or a matching audit identity.

> **Refresh behavior:** run the Graph ingester first, then this lander, then refresh the model.
> Alternatively keep a separate fresh Graph baseline and enriched output. Additive enrichment
> against yesterday's enriched table preserves yesterday's already-existing Workday columns.
> For recurring no-Entra refreshes, explicitly choose `MODE='standalone'`: auto checks table
> existence and would otherwise see the table created by its first standalone run.

---

## Optional tables

### 4. `agents_365`
Landed into the Lakehouse by **`Copilot_Agent365_Registry_Ingester`** (the default — Graph app-only,
runs unattended) or by `Copilot_Agent365_Lander` (CSV fallback → `dbo.agents_365`; Delta
column-mapping preserves spaced header names like `Agent name`). Both write the same table, so the
shipped pipeline runs the Ingester **first** and the Lander **only if the Ingester fails**
(`Run_Agent365_CSV_Fallback`, e.g. no Agent 365 licence). Read via `FabricTable("agents_365")`, wrapped with `Enable_Agent365`. The Fabric
model is now **100% Lakehouse-sourced**.

**Incremental pull.** The ingester lists every agent on every run, but calls the per-agent detail
endpoint (Bot Id, usage, sharing, element types) only for agents that are new, whose
`lastModifiedDateTime` changed, that have no cache entry, or whose cached detail is older than
`FULL_REFRESH_DAYS` (default 7). Detail calls run in parallel (`DETAIL_WORKERS`, default 8) and retry
on 429, 500, 502, 503 and 504 and on network timeouts or dropped connections. `DETAIL_MODE = "full"`
forces a full refresh. It keeps three tables:

| Table | Holds |
|---|---|
| `agents_365` | Today's registry, one row per agent, with **`Detail As Of`** (when that agent's detail was last fetched) |
| `agents_365_detail_cache` | The last detail response and resolved creator per agent. Freshly fetched detail is checkpointed into it during the run (every `DETAIL_CHECKPOINT_EVERY` calls, default 1000, and again if the run fails); the full rewrite, which drops agents gone from the list, happens only after a successful run |
| `agents_365_history` | Every version of every agent, merged on Title ID and `Last updated`, so registry changes can be traced |

For a cached agent, today's list fields override the cached detail; freshly fetched detail
overrides the list. The exception is `lastModifiedDateTime`, which is always the list's (the
detail's only when the list has none), so `Last updated` is the same stamp change detection uses
and does not change between fetched and cached runs. The detail payload's stamp can differ from
the list's for some agents. Usage fields (`Active Users`, `Total sessions` and similar) can therefore be up
to `FULL_REFRESH_DAYS` old; check `Detail As Of`.

**Large tenants and failed detail calls.** A first run has no cache, so a tenant with tens of
thousands of agents makes one detail call per agent; the ingester prints the expected duration
and a progress line with an ETA every `DETAIL_PROGRESS_EVERY` calls (default 500). Because
successful calls are checkpointed, a run that fails or is stopped part-way loses nothing: rerun
it in incremental mode and only the agents still missing are fetched. (Full mode ignores the
cache, so it does not resume.) Checkpoints hold only freshly fetched detail, keyed to the
`lastModifiedDateTime` it was fetched for, so an agent is never marked as seen with stale data.
When an agent's detail call fails (a 424 *Failed Dependency* or 404, which are not retried, or
a 403, or a 429, 5xx or network error that is still failing after retries):

- **It has cached detail:** the cached detail is used and the agent stays due a refetch.
  `Detail status` = `cached - refetch failed`.
- **It has no cached detail:** the agent is written list-only. Its list fields (name, owner,
  type, dates and so on) are kept; usage, Bot Id and capability columns are blank. `Detail
  status` records why, for example `missing (HTTP 424)`. The agent is left out of the cache and
  of `agents_365_history`, and is retried next run. There is no limit: however many agents are
  missing, the run writes, and step 3 prints a warning counting them by `Detail status`.

The one exception: if **every** detail call failed with 401 or 403 and there is no cached detail
at all, sign-in or consent is broken (for example `CopilotPackages.Read.All` not admin-consented),
so the run fails and the previous `agents_365` is left in place, rather than writing a registry
with no detail.

Each step of the notebook checks the one before it, so a failed detail step stops the later
cells with a message pointing back to it, rather than a `NameError`.

| `Detail status` | Meaning |
|---|---|
| `fetched` | Detail fetched this run |
| `cached` | Unchanged agent; cached detail reused |
| `cached - refetch failed` | Changed or stale agent whose detail call failed; cached detail used, retried next run |
| `missing (<reason>)` | No detail and none cached; list-only row, retried next run. The reason is the HTTP status (`missing (HTTP 424)`, `missing (HTTP 404)`, `missing (HTTP 403)`, `missing (HTTP 503)`) or, for a network error, the exception type (`missing (ReadTimeout)`) |

`Detail status` is a Fabric snapshot column like `Detail As Of`: it is not in the 48-column CSV
contract and not written to `agents_365_history`.

**Local CSV, SharePoint and Dataverse templates** read the same contract from a CSV set in the
`Agent 365` parameter (blank = the page loads empty). Produce it with
[`Get-Agents365Registry.ps1`](../4.%20SharePoint/scripts/Get-Agents365Registry.ps1), which calls the
same Graph endpoints as the ingester and writes the same **48 columns in the same order**, with the
same value rules; a parity test runs one mocked Graph response through both. `Run-PAX-AIBV.ps1
-IncludeAgent365Info` runs it for you and `Upload-Rollups-SharePoint.ps1` lands it as
`agents_365.csv`. Paging, detail calls and creator resolution all happen in the script, so Power
Query only reads and types the file. A hidden staging query (`Agents 365 Staging`) reads it once;
both the `Agents 365` table and the interactions query's `Agent_LinkID` resolution use it, so they
always agree. The PAX 28-column catalogue and the admin centre export are still accepted.

The script also keeps a detail cache next to the CSV (`<csv>.detailcache.jsonl`) and, like the
ingester, fetches detail only for new or changed agents, or those whose cached detail is older than
`-FullDetailRefreshDays` (default 7; 0 fetches every agent). It honours `Retry-After` on 429 and 5xx
responses, retries network timeouts and dropped connections, and caches each agent's resolved
creator. Like the ingester, it checkpoints successful detail calls into the cache
(`-CheckpointEvery`, default 1000) so a failed or stopped run resumes, prints progress with an ETA
(`-ProgressEvery`, default 500), and handles failed detail calls the same way: any number of
agents are written list-only and retried next run, and only an all-401/403 run with no cache stops
without writing. The full cache rewrite still happens only after the CSV. The CSV keeps its 48
columns; it has no `Detail As Of` or `Detail status` column, so list-only agents are reported as a
warning in the script output, counted by reason (for example `missing (HTTP 424) x312`).

#### ⚠️ Two different Agent 365 exports — registry vs observability

Microsoft exposes Agent 365 data as **two separate exports**, and they do **not** carry the same
columns. Which one you land decides how much of the **🛡 Agent Registry** page populates:

| Export | Source | Carries |
|---|---|---|
| **Registry / catalogue** | Graph `/copilot/admin/catalog/packages` — used by `Copilot_Agent365_Registry_Ingester`, `Get-Agents365Registry.ps1` and PAX `-IncludeAgent365Info` | An inventory: agent name, Title ID, publisher/developer, version, availability, sensitivity, capability and permission flags, created/last-updated metadata. The ingester and the script write **48 columns** (adding Entra Agent ID, Bot/App/Asset IDs, Is Blocked, sharing, element types and resolved creator); PAX writes **28** |
| **Observability** | Microsoft Admin Center → **Agents** export ([agent map docs](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-map)) | Usage telemetry: `Users shared`, `Active Users`, `Total sessions`, `Exception rate`, `Last Activity Date` |

The **registry export does not emit the observability columns.** If you land only the registry /
PAX output — the documented default — those five fields are unavailable.

**The model tolerates this.** The Agents 365 query ends with a *stable superset guard* that adds any
model-declared column the chosen source did not supply as a **typed null**, so:

- the table always returns the same column set regardless of which export you land,
- refresh never fails with a missing-column error, and
- visuals bound to an unavailable field render **blank** rather than breaking the page.

To populate the observability visuals, land the **Admin Center Agents export** instead of (or merged
with) the registry export. `Agent Activity Status` falls back to audit-log-derived activity when
`Last Activity Date` is absent, so agent recency still works on the registry-only path.

> Adding a column to the Agents 365 model? Add it to the guard's `__expected` list in the query too,
> or it will be unstable on any source that doesn't emit it.

#### Agent identity resolution

The interactions fact joins the Agents dimension through a **resolved key** (`Agent_LinkID`) rather
than the raw `Agent_TitleID`. The audit log and the registry use different identifiers: the audit
`AgentId` can be a `T_…` Title ID, an `SPO_…` blob, a built-in name (`WordDraftingAgent`), an
**Entra Agent ID GUID** (Agent 365), or, on Copilot Studio runtime records, a Bot Id in
`PlatformAgentId`. On one large tenant **55%** of agent rows matched a registry Title ID directly;
most of the rest are Microsoft first-party agents with no registry row.

**Fabric (`Copilot_Audit_Log_Processor`).** Resolution runs in Spark, as a priority chain that
always lands on a real registry `Title ID` or null, and never uses the agent's name:

1. **Title ID** — `Agent_TitleID → agents_365[Title ID]`.
2. **Bot Id** — `Agent_BotId → agents_365[Bot Id]` (Copilot Studio runtime records).
3. **Entra agent ID** — `Agent_EntraId → agents_365[Entra Agent ID]` (`agentIdentityId`).
4. **Schema GUID** — a Title ID found inside a Copilot Studio schema name.

A key is used only when it maps to one registry agent. When a Copilot Studio agent has an LOB and a
Shared copy (two Title IDs) that share a Bot Id or Entra agent ID, both resolve to one
`Agent_LinkID`: the LOB Title ID, or for Shared-only copies the most recently updated one. Distinct
users are therefore counted once across the copies. Agent Builder and Microsoft agents are never
merged. `Agent_MatchedTitleID` keeps the Title ID that matched. Matching by name was removed:
names are not unique, and it linked only about 1.3% more rows.

**Local CSV, SharePoint and Dataverse templates.** Resolution is still done in Power Query, in this
order: `Agent_EntraId → Entra Agent ID`, then a direct Title ID, then the normalised agent name.
These templates have not yet moved to the Fabric rules above, so they can still merge two agents
that share a name.

All lookup maps are deduped and null-guarded, so the fact never fans out. The relationship is
**`Chat + Agent Interactions[Agent_LinkID] → agents_365[Title ID]`**.

**Zero-touch identity detection (templates).** `agents_365` is given an add-if-missing **`Entra Agent ID`** column
that **auto-detects** the GUID from whatever the export provides — it picks the first present of
`Entra Agent ID → EntraAgentId → Agent ID → Bot Id` (and common variants). The customer never has to
create or populate a column by hand; a non-matching GUID simply does not join (no false links).

#### Agent type and publisher

`Copilot_Audit_Log_Processor` (Fabric) and the Local CSV processor add six columns that say what
kind of agent each row used and who published it. This covers the Microsoft first-party agents
that never link to `agents_365`. They are additive: `Agent_LinkID` and `Agent_Surface` are unchanged.

| Column | Meaning |
|---|---|
| `Agent_Key` | The agent: agent ID, else agent name, else `AppIdentity`. Blank for rows with no agent. |
| `Agent_Type` | The category, from the first matching rule in [METHODOLOGY §3.3](METHODOLOGY.md#agent-type-classification). |
| `Agent_Type_Basis` | How firm the category is: `documented`, `observed`, `inferred` (agent-ID prefix convention Microsoft does not document) or `override`. |
| `Agent_Publisher` | `Microsoft`, `Your organisation`, `User-shared`, `Agent Store`, `Connected app` or `Unknown`. |
| `Agent_Is_Published` | TRUE / FALSE, or blank when the audit log cannot tell (Agent Builder, Copilot Studio, connected apps, unclassified). |
| `Agent_Consolidated_Name` | One name per Microsoft first-party agent (every Researcher row shows `Researcher`, whatever its ID or host). Other agents keep their own name. |

**Optional overrides.** Create a Lakehouse table `agent_type_overrides` (Fabric) or a CSV passed as
`--agent-type-overrides` (Local CSV processor) with columns `key` and `Agent_Type` (`Category` is
also accepted in the CSV) to correct a category. `key` is an agent ID, agent name or `AppIdentity`
(matched case-insensitively, in that order); the row's `Agent_Type_Basis` becomes `override`. A
category that is not one of the built-in names gets `Agent_Publisher` `Unknown`. The Fabric
processor skips the step when the table does not exist (`AGENT_TYPE_OVERRIDES_TABLE` in the config
cell).

**Coverage by variant.** Every template loads all six columns on `Chat + Agent Interactions`, and
the Agent Registry page has an **Agent type (audit log)** slicer and an active-users-by-agent-type
chart. Where the columns come from depends on the variant:

| Variant | Source of the six columns | Inputs | Overrides |
|---|---|---|---|
| Fabric (both templates) | `Copilot_Audit_Log_Processor` | All five (agent ID, name, AppIdentity, PlatformAgentType, workload) | `agent_type_overrides` table |
| Local CSV | Python processor (`--profile aibv`) | All five | `--agent-type-overrides` CSV |
| Power Automate + Dataverse | Snapshots built by `Build-DataverseCoreFeeds.py`, which runs the Local CSV processor | All five | Not wired in |
| Power Automate + Dataverse, snapshots built before this change | Power Query (`ValueLensDescribeAgent`) at refresh | Agent ID, name, AppIdentity only | None |
| SharePoint (PAX rollup) | Power Query (`ValueLensDescribeAgent`) at refresh | Agent ID, name, AppIdentity only | None |

`ValueLensDescribeAgent` is a Power Query port of the same rules. It runs only when the extract has
no `Agent_Type` column. The PAX rollup and older snapshots carry `AgentId` (the audit `AgentId`, not
`CopilotEventData.TargetPlatformAgentId`), `AgentName` and `AppIdentity_DisplayName`, but no
`PlatformAgentType` or workload. So in those extracts, connected apps and third-party AI apps
(`ConnectedAIApp` / `AIApp` workloads) are found only by their `AppIdentity` prefix, and a Copilot
Studio agent known only by `PlatformAgentType` lands in **Unclassified agents**. A test runs the
shipped M text against the Python rules on the same inputs, so the two cannot drift.

**`Agent Publish Status` (Local CSV, Dataverse, SharePoint) is separate and unchanged.** It is the
older AI-in-One flag: `Not an Agent Row` with no agent ID, `Unpublished` only for "Draft as 1P"
agents, otherwise `Published`. `Agent_Type`, `Agent_Publisher` and `Agent_Is_Published` are the
finer replacement for new analysis: they add the AppIdentity, PlatformAgentType and workload
signals, name the Microsoft first-party agents, leave the published flag blank where the audit log
cannot tell and mark which rules are inferred. Local CSV output from a processor older than this
change also falls back to `ValueLensDescribeAgent`.

The Fabric model loads all six columns. It drops the four raw inputs (`AppIdentity_Text`,
`Agent_TargetPlatformId`, `Agent_TargetName`, `Agent_PlatformType`). Re-run the processor before
refreshing an updated template, so the curated table has the new columns.

#### Agent creator attribution (`Agent creator UPN` / `Agent creator source`)

The registry export's `Agent creator` field is a **display string** (often the publisher, a service
principal, or blank) — it is not a resolvable identity, so it can't be joined to
`copilot_licensed_users` or used to answer *"who in my org is building agents?"*.

`Copilot_Agent365_Registry_Ingester` therefore emits two extra columns:

| Column | Meaning |
|---|---|
| `Agent creator UPN` | resolved user principal name of the agent's creator, or blank |
| `Agent creator source` | which tier resolved it — `ownerId`, `servicePrincipalOwner`, `auditLog`, or `unattributed` |

Three tiers run in order; each only processes agents still unresolved, and each is independently
switchable via a `RESOLVE_VIA_*` flag at the top of the notebook:

| Tier | Method | Extra permission |
|---|---|---|
| 1 | package `ownerId` → `/users/{id}` (batched) | **`User.Read.All`** (new) |
| 2 | `appId` / `agentIdentityId` → `/servicePrincipals/{id}/owners` | `Application.Read.All` (already required) |
| 3 | earliest agent-creation event in the Purview audit table | none (reads the Lakehouse) |

> **`User.Read.All` is a new application permission** on top of `CopilotPackages.Read.All` and
> `Application.Read.All`. Without it tier 1 is skipped and coverage falls back to tiers 2–3; the
> notebook still runs. Tier 3 requires a **parseable timestamp** column in the audit table — if the
> date is an unparseable string the tier **skips visibly** rather than guessing, so an agent is left
> `unattributed` instead of being attributed to the wrong person.

Because attribution is best-effort, always surface `Agent creator source` alongside any
creator-based visual — filtering out `unattributed` silently understates your builder counts.

#### Governance columns (`Owner account`, `Sharing Scope`, `Data Access`, `Sign-in Required`, `Governance Flags`)

These back the Fabric App's Governance page ([Methodology](METHODOLOGY.md#governance-which-agents-need-a-review)).

| Column | Where it comes from |
|---|---|
| `Owner account` | Fabric ingester only. Each run looks up every agent's `ownerId` at `/users/{id}?$select=id,accountEnabled` (batched, `User.Read.All`) and writes `Active`, `Disabled` or `Not found`; blank when unchecked. It is a snapshot column, like `Detail As Of`: not in the 48-column CSV contract, not cached and not written to `agents_365_history`. `CHECK_OWNER_ACCOUNT = False` skips it |
| `Sharing Scope` | Power Query, from `Availability`, `Status` and the share count: `Whole organisation`, `Specific people or groups`, `Not shared` or `Not stated` |
| `Shared With Count` | Power Query: distinct people and groups across the share lists. The lists themselves are not loaded |
| `Data Access` | DAX calculated column, from the SharePoint, OneDrive, Graph connector and uploaded-file capability flags |
| `Sign-in Required` | Power Query: `Yes`, `No` or `Unknown`. It matches the agent on its Entra agent ID, bot ID, app ID or agent ID against an ordered list of sources, and the first source that knows the agent wins: Azure Resource Graph's agent configuration (`arg_agent_config`, `NoSignIn`), then the optional Defender agents table (`defender_ai_agents`). `Unknown` when no source does, or both are off |
| `Governance Flags` | DAX calculated column: the review flags that apply, separated by `; `. Blank for catalogue and blocked agents. `Sign-in Required = No` adds *No sign-in required* |

Only the two Fabric templates carry these columns so far. The CSV, SharePoint and Dataverse
templates will gain `Sharing Scope`, `Data Access` and `Governance Flags` later; they have no
`Owner account`, so owners there will read *Not checked*.

#### Optional raw API passthrough (`INCLUDE_RAW_PASSTHROUGH`)

The ingester maps the Graph payload onto the model's canonical column names. Fields the model does
not declare are dropped. Setting `INCLUDE_RAW_PASSTHROUGH = True` additionally carries **every**
field the API returned into the Delta table under its raw API name (nested objects/arrays are
JSON-serialised).

**It ships `False`, on purpose.** The PBIT's `Agents 365` query has no `Table.SelectColumns` — it is
purely additive — so every extra Delta column lands in the semantic model as an unmodelled field.
Turn it on only when you're deliberately exploring the payload. Measured against a 469-agent
tenant the table goes from **48 to 80 columns** (41 raw additions). Only `appId`, `assetId`,
`requestType`, `requestStatus`, `manifestId` and `governanceMetadata` are reachable *exclusively*
through the flag, and all six were empty in that tenant; the rest duplicate columns you already
have. Note also that `allowedUsersAndGroups`, `acquireUsersAndGroups` and `sharedWithUsersAndGroups`
carry user and group identifiers, so enabling this permanently is a privacy review decision rather
than a display preference. `Agent creator UPN` is canonical and is **not** gated by this flag.

Where a raw key collides case-insensitively with a canonical column (e.g. `version` vs `Version`,
`categories` vs `Categories`), the canonical column wins; the raw value is kept under `<key>_raw`
only when it actually differs. Spark resolves column names case-insensitively, so without this the
write fails outright with `AMBIGUOUS_REFERENCE`.

### 5. `user_feedback` — Product Feedback (OCV export)
An OCV/Viva feedback **CSV** dropped at `Files/product_feedback/`, parsed by
`Copilot_ProductFeedback_Ingester.ipynb`. The dashboard's `ProductFeedback` table renames the OCV
space-named columns. The empty placeholder emits the **full superset** so a missing/partial export
cannot break refresh, and the notebook now rejects `WRITE_MODE='append'` for this snapshot source:

```
Feedback Id, Comment, Translated Comment, Comment Language,
Date Submitted UTC, Feedback Type, Microsoft Response Status,
App, App Language, Platform, Source Type, Logs, Attachments,
User Id, User Email, Browser, Browser Version,
AI Context Prompt, AI Context Response Message,
Survey Question, Survey Response Option, Additional Metadata,
Date Submitted Date, Sentiment
```
*(The model should also keep `MissingField.Ignore` on `Table.RenameColumns` so partial OCV exports remain tolerant.)*

### 6. Defender (shadow AI and agent risk)

Optional, off by default. `Copilot_Defender_Ingester` (Fabric) or the `defender` module of the Azure
jobs reads Microsoft Defender through Microsoft Graph: advanced hunting
(`POST /security/runHuntingQuery`) and, in beta, Cloud Discovery in Defender for Cloud Apps. Both
paths share one module, `valuelens_core.defender`, so the tables match. Each probe fails on its own:
a probe the tenant can't read writes its status to `defender_status` and leaves its table empty.
When the source is off, the model loads every table empty with the right columns.

| Model table | Delta / SQL table | Grain | Columns |
| --- | --- | --- | --- |
| Defender AI Watchlist | `defender_ai_watchlist` | One row per watched tool, from the watchlist CSV | `Tool`, `Category`, `Vendor`, `Posture` (`Sanctioned`, `Unsanctioned`, `Not reviewed`), `ProcessNames`, `Domains`, `InstallPrefixes` (`;`-separated) |
| Shadow AI Daily | `defender_shadow_ai_daily` | Day ? window ? layer ? tool | `Day`, `Window` (`1d`, `7d`, `30d`), `Layer` (`Ran`, `Network`), `Tool`, `Devices`, `Users`, `Events`, `LoadedAt` |
| Shadow AI Totals | `defender_shadow_ai_totals_daily` | Day ? window ? layer, across tools not marked Sanctioned | As the daily table without `Tool`; `Layer` adds `Any` (ran or reached) |
| Defender AI Installed | `defender_ai_installed` | Snapshot, one row per tool | `SnapshotDate`, `Tool`, `Devices`, `SoftwareNames`, `LoadedAt` |
| Defender Cloud Discovery | `defender_cloud_discovery_ai` | Snapshot, one row per stream and AI app (last 30 days) | `SnapshotDate`, `StreamId`, `StreamName`, `AppId`, `AppName`, `Category`, `RiskScore`, `Users`, `Devices`, `IpAddresses`, `Transactions`, `UploadBytes`, `DownloadBytes`, `LastSeen`, `Tags`, `Posture`, `WatchlistTool`, `LoadedAt` |
| Defender AI Agents | `defender_ai_agents` | Snapshot, one row per agent Defender knows | `SnapshotDate`, `AgentId`, `AgentName`, `Platform`, `SourceTable`, `EntraAgentId`, `BotId`, `AppId`, `AuthenticationType`, `SignInRequired` (`Yes`, `No`, `Unknown`), `UsesWebKnowledge`, `PublishedStatus`, `LifecycleStatus`, `Availability`, `LoadedAt` |
| Defender Status | `defender_status` | One row per probe per run | `RunAt`, `Probe` (`device_activity`, `installed`, `agents`, `cloud_discovery`), `Status` (`ok`, `empty`, `forbidden`, `unlicensed`, `error`), `Source`, `Rows`, `Message` |

- **Counts are distinct per window.** `1d` rows hold each day; `7d` and `30d` rows hold the windows
  ending on the last loaded day. `Devices` and `Users` are distinct within a row, so they don't add
  across days, windows or tools. Advanced hunting's `dcount` is approximate.
- **History.** The two daily tables keep one row set per `Day` (the Azure publish replaces by `Day`);
  the first load backfills up to 29 days. The other tables are snapshots, replaced each run.
- **Service accounts** (`S-1-5-18`, `-19`, `-20`) are left out of `Users`.
- **Relationships.** `Day` on both daily tables to `Calendar`; `Tool` on the daily and installed tables
  to the watchlist.
- **Measures** (on Shadow AI Totals): `AI Tools Watched`, `Unsanctioned AI Tools`,
  `Shadow AI Tools Found` (30 days), `Shadow AI Tools This Week`, `Shadow AI Devices`,
  `Shadow AI Users`, `Shadow AI Users (Cloud Discovery)` and `Shadow AI Status`.

### 7. Azure Resource Graph — agent configuration and the Foundry estate

Daily snapshots from `Copilot_Resource_Graph_Ingester` (Fabric) or the Azure jobs' `resource_graph`
collector (module `resourceGraph`). Same tables and columns on both paths; each run replaces a table
with today's snapshot, and a probe that's refused or fails leaves its table as it was. The model
tables use the same column names. Every model table exists, empty, when the source is off.
Permissions: [PERMISSIONS](PERMISSIONS.md#azure-resource-graph).

**`arg_agent_config`** → model `Agent Configuration`. One row per Copilot Studio agent, from
`PowerPlatformResources` (type `microsoft.copilotstudio/agents`), or from the Agent inventory flow's
file when Resource Graph refuses or returns nothing (`Source` says which).

| Column | Meaning |
|---|---|
| `SnapshotDate` | The run's UTC date |
| `AgentResourceId`, `BotId`, `AgentName` | The agent. `BotId` is lower case |
| `EntraAgentId`, `EntraAppId` | The agent's Entra identities, when published with one |
| `TitleId`, `MatchedOn` | The Agent 365 registry's Title ID, matched on `Bot Id` first, then `Entra Agent ID`. Blank when no match (always on Azure, which doesn't collect Agent 365). The model relates `TitleId` to `Agents 365[Title ID]` |
| `EnvironmentId` | Lower case; relates to `Power Platform Environments` |
| `Authentication`, `NoSignIn` | The agent's authentication setting. `NoSignIn` is true when it's *None*: anyone with the link can chat without signing in |
| `IsQuarantined`, `IsManaged`, `WebSearchEnabled` | Admin quarantine, managed environment, and web search on for knowledge |
| `ConnectorCount`, `McpConnectorCount`, `KnowledgeConnectorCount`, `Connectors` | Distinct Power Platform connectors (MCP servers are connectors whose id contains `mcp`), connector operations used as knowledge, and the connector ids |
| `ConnectedAgentCount` | Agents it calls |
| `SharedUsers`, `SharedGroups`, `SharedEntireTenant` | Who it's shared with to chat |
| `Orchestration`, `Model`, `Channels`, `OwnerId`, `CreatedIn`, `LastPublishedAt` | As reported. Many inventory fields are in preview, so any may be blank |
| `Source` | `Resource Graph` or `Inventory API (flow)` |

**`arg_environments`** → `Power Platform Environments`: `SnapshotDate`, `EnvironmentId`,
`EnvironmentName`, `EnvironmentType`, `IsDefault`, `IsManaged`, `Region`, `Source`.

**`arg_agent_flows`** → `Agent Flows`: `SnapshotDate`, `FlowId`, `FlowName`, `EnvironmentId`,
`OwnerId`, `ConnectorCount`, `Trigger`, `CreatedAt`, `LastModifiedAt`, `Source`.

**`arg_foundry_resources`** → `Foundry Resources` (in both the ValueLens and Consumption models).
Foundry accounts (`microsoft.cognitiveservices/accounts`), projects (`…/accounts/projects`) and
Azure Machine Learning workspaces the identity can read. Accounts and projects only: there's no
per-project agent sweep.

| Column | Meaning |
|---|---|
| `ResourceId` | Lower case, so it joins to the Azure AI spend's resource ids |
| `ResourceName`, `ResourceType`, `Kind`, `Location`, `SubscriptionId`, `ResourceGroup`, `Sku` | As reported. A project's name is its last segment |
| `PublicNetworkAccess`, `PublicNetwork` | The setting, and whether it's open to the public network (Azure treats an unset value as enabled) |
| `DisableLocalAuth` | True when key-based auth is off |
| `IsProject`, `AccountId` | Whether it's a project, and its account's id (an account's own id) |

**`arg_status`** → `Resource Graph Status`: one row per probe (`arg_agent_config`,
`arg_environments`, `arg_agent_flows`, `arg_foundry_resources`) with `Status` *ok*, *empty*,
*forbidden*, *error* or *skipped* (turned off), `Rows`, `Source` and `Detail` (the error, or which
inventory file was read). The dashboard uses it to say why a section is empty.
