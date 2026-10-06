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

> **Delta table names are lower-case** throughout (`copilot_interactions_parsed`,
> `copilot_interactions_curated`, …). The dashboard table names in column 2 are the *model* names and
> may contain spaces.

> **`Environment` is licensing only** (`Licensed` / `Unlicensed`). Cowork is identified by
> `Agent Filter = "Cowork"`. Older processor output that still carries `Environment = "Cowork"`
> is mapped back to its licence (`Licensed`, or `Unlicensed` when `License Status` says so) by the
> non-Fabric templates' interactions query, so Cowork never appears in the Environment slicer.

All other model tables (Calendar, legends, ranking/summary, glossary, value maps, etc.) are
**calculated/DAX or static** — they have no external source and are version-independent.

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

> **Runtime records with no messages.** A Copilot Studio agent used in Teams or another channel logs
> a record with no `Messages`. It is kept as one row with `Prompts_Available` FALSE,
> `Message_isPrompt` FALSE and a `message:none` `Message_Id`, so the user still counts. Every other
> record without messages is still dropped. `ConversationId` falls back to the record's
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
on 429, 503 and 504. `DETAIL_MODE = "full"` forces a full refresh. It keeps three tables:

| Table | Holds |
|---|---|
| `agents_365` | Today's registry, one row per agent, with **`Detail As Of`** (when that agent's detail was last fetched) |
| `agents_365_detail_cache` | The last detail response and resolved creator per agent. Written only after a successful run; agents gone from the list are dropped |
| `agents_365_history` | Every version of every agent, merged on Title ID and `Last updated`, so registry changes can be traced |

For a cached agent, today's list fields override the cached detail; freshly fetched detail
overrides the list. Usage fields (`Active Users`, `Total sessions` and similar) can therefore be up
to `FULL_REFRESH_DAYS` old; check `Detail As Of`.

**Local CSV, SharePoint and Dataverse templates** read the same contract from a CSV set in the
`Agent 365` parameter (blank = the page loads empty). Produce it with
[`Get-Agents365Registry.ps1`](../3.%20SharePoint/scripts/Get-Agents365Registry.ps1), which calls the
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
responses, caches each agent's resolved creator, and writes the cache only after the CSV. The CSV
keeps its 48 columns; it has no `Detail As Of` column.

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

**Fabric only for now.** `Copilot_Audit_Log_Processor` adds six columns that say what kind of agent
each row used and who published it. This covers the Microsoft first-party agents that never link
to `agents_365`. They are additive: `Agent_LinkID` and `Agent_Surface` are unchanged.

| Column | Meaning |
|---|---|
| `Agent_Key` | The agent: agent ID, else agent name, else `AppIdentity`. Blank for rows with no agent. |
| `Agent_Type` | The category, from the first matching rule in [METHODOLOGY §3.3](METHODOLOGY.md#agent-type-classification). |
| `Agent_Type_Basis` | How firm the category is: `documented`, `observed`, `inferred` (agent-ID prefix convention Microsoft does not document) or `override`. |
| `Agent_Publisher` | `Microsoft`, `Your organisation`, `User-shared`, `Agent Store`, `Connected app` or `Unknown`. |
| `Agent_Is_Published` | TRUE / FALSE, or blank when the audit log cannot tell (Agent Builder, Copilot Studio, connected apps, unclassified). |
| `Agent_Consolidated_Name` | One name per Microsoft first-party agent (every Researcher row shows `Researcher`, whatever its ID or host). Other agents keep their own name. |

**Optional overrides.** Create a Lakehouse table `agent_type_overrides` with columns `key` and
`Agent_Type` to correct a category. `key` is an agent ID, agent name or `AppIdentity` (matched
case-insensitively, in that order); the row's `Agent_Type_Basis` becomes `override`. A category
that is not one of the built-in names gets `Agent_Publisher` `Unknown`. The processor skips the
step when the table does not exist (`AGENT_TYPE_OVERRIDES_TABLE` in the config cell).

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
