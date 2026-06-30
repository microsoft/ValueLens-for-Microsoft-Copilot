# Data Dictionary & Source Contract

This is the **single source of truth** for the tables the dashboard consumes. Both deployment
versions read the *same* logical tables with the *same* column names — only the **source layer**
differs:

| Version | Source layer | Each table loads via |
| --- | --- | --- |
| **Fabric** | OneLake Lakehouse (Delta) | `FabricTable("<delta_table>")` → Lakehouse SQL endpoint |
| **SharePoint** | CSV files in SharePoint/OneDrive | `SharePointCsv("<file>")` / `Web.Contents(...)` |

Because the schema is identical, the report, every measure, and all downstream M is shared. A
producer (notebook or script) is "compatible" **iff** the Delta table / CSV it writes exposes the
exact column names below (casing and spaces matter).

---

## Tier model — core vs optional

Optional sources must **degrade to an empty table with the correct columns** when absent, so the
template never breaks. See `OPTIONAL-SOURCES.md` for the `EmptyTable` + `try…otherwise` +
`Enable_*` toggle pattern.

| # | Dashboard table | Lakehouse Delta name | Tier | Fabric producer | SharePoint producer |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat + Agent Interactions (Audit Logs) | `Copilot_Interactions_Parsed` | **Core** | `Copilot_Audit_Log_Direct_Ingester` | `GetCopilotInteractions*` |
| 2 | Copilot Licensed | `copilot_licensed_users` | **Core** | `Copilot_Licensed_Users_Direct_Ingester` | `GetCopilotUsers*` |
| 3 | Chat + Agent Org Data | `copilot_org_data` | **Core** | `Copilot_Org_Data_Direct_Ingester` | `Get-EntraOrgData*` |
| 4 | Agents 365 | `agents_365` | *Optional* | `Copilot_Agent365_Lander` | `Get-Agents365Registry` |
| 5 | ProductFeedback | `user_feedback` | *Optional* | `Copilot_Agent_Transcript_Parser` (`build_feedback`) | OCV feedback CSV |
| 6 | Agent Sessions | `agent_sessions` | *Optional* (Dataverse) | `Copilot_Agent_Transcript_Parser` | n/a |
| 7 | Agent Turns | `agent_turns` | *Optional* (Dataverse) | `Copilot_Agent_Transcript_Parser` | n/a |
| 8 | Agent Errors | `agent_errors` | *Optional* (Dataverse) | `Copilot_Agent_Transcript_Parser` | n/a |
| 9 | Agent Sub-Agent Calls | `agent_subagents` | *Optional* (Dataverse) | `Copilot_Agent_Transcript_Parser` | n/a |
| 10 | Agent Catalogue | `agent_catalogue` | *Optional* (Dataverse) | `Copilot_Agent_Transcript_Parser` | n/a |
| 11 | Agent Performance | `agent_performance` | *Optional* (Dataverse) | `Copilot_Agent_Transcript_Parser` | n/a |
| 12 | Credit Consumption (Tenant) | `credit_consumption_tenant` | *Optional* (billing) | `Copilot_Credit_Consumption_Ingester` | n/a |
| 13 | Credit Consumption (Agent) | `credit_consumption_agent` | *Optional* (billing) | `Copilot_Credit_Consumption_Ingester` | n/a |
| 14 | Credit Consumption (User) | `credit_consumption_user` | *Optional* (billing) | `Copilot_Credit_Consumption_Ingester` | n/a |

All other model tables (Calendar, legends, ranking/summary, glossary, value maps, etc.) are
**calculated/DAX or static** — they have no external source and are version-independent.

---

## Core tables

### 1. `Copilot_Interactions_Parsed` — audit interactions
Producer flattens Purview/Graph `CopilotInteraction` audit JSON **upstream** (the report M is a thin
pass-through guarded by `Table.HasColumns`, so missing optional columns are tolerated).

```
CreationDate, AgentId, AgentName,
AppIdentity_AppId, AppIdentity_DisplayName, AppIdentity_PublisherId,
ApplicationName, ClientRegion,
Audit_UserId, Audit_UserId_Normalized, Workload,
AppHost, ThreadId, SensitivityLabelId, Context_Type,
AISystemPlugin_Id, AISystemPlugin_Name, ModelTransparencyDetails_ModelName,
AccessedResource_Type, AccessedResource_Action, AccessedResource_SiteUrl, AccessedResource_SensitivityLabelId,
Message_Id, Message_isPrompt, Resource_Count,
InteractionDate, WeekStart, MonthStart,
Agent_TitleID, Agent_EntraId
```

> **Agent identifiers (two keys, used together).** `Agent_TitleID` is parsed from the legacy
> `CopilotStudio.Declarative.{title}` / `T_`/`P_` forms. `Agent_EntraId` captures the **Microsoft
> Entra Agent ID** GUID that **Agent 365** now stamps into the audit `AgentId` instead of the
> declarative string. When agents are registered/recreated under Entra Agent ID, `Agent_TitleID`
> would otherwise land NULL and drop out of the Agents join — `Agent_EntraId` keeps them resolvable
> via the registry crosswalk. The two are populated mutually exclusively per row (legacy → TitleID,
> Entra → EntraId), so old and new agents both join cleanly during a mixed migration.

### 2. `copilot_licensed_users` — licensed user list
⚠️ **Contract fix required.** The producer sanitizes spaces→underscores, writing
`User_Principal_Name` and `Has_license`, but the dashboard's variant lists only contain spaced/camel
forms. Either (B1) add `User_Principal_Name` / `Has_license` to the model's variant lists, or
(B2) keep the spaced names in the Delta table (column-mapping). Key columns:

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

**Two join keys (important):**
- `PersonId` = **userPrincipalName (UPN)** — used by the **Audit Logs** path (`Audit_UserId → PersonId`).
- `id` = **AAD object id** — used by the **Dataverse** path (`Agent Sessions.user_id_hash → id`), because
  the transcript parser emits the user's `aadObjectId`, not the UPN. The producer must populate `id`
  (Graph `/users` `id`) or the credit-by-organization breakdown silently shows 100% for every org
  (dangling relationship → Organization filter never reaches Agent Sessions).

---

## Optional tables

### 4. `agents_365`
Landed into the Lakehouse by `Copilot_Agent365_Lander` (CSV → `dbo.agents_365`; Delta column-mapping
preserves spaced header names like `Agent name`) and read via `FabricTable("agents_365")`, wrapped with
`Enable_Agent365`. The Fabric model is now **100% Lakehouse-sourced**. Columns from the Agents MAC export.

#### Agent identity resolution (3-key bridge: Entra → Title ID → Name)

The interactions fact joins the Agents dimension through a **resolved key** (`Agent_LinkID`) rather
than the raw `Agent_TitleID`. This is necessary because the **audit log and the MAC Agents export use
different identifier namespaces** — the audit `AgentId` is an `SPO_…` blob, a built-in name
(`WordDraftingAgent`), or an **Entra Agent ID GUID** (Agent 365), while the export keys on `T_…`
Title IDs. On real tenant data the raw `Agent_TitleID → Title ID` join matches **0%**; resolving the
shared **display name** lifts that to ~**84% of distinct agents** (the unmatched remainder are mostly
Microsoft first-party agents that legitimately have no registry row).

Resolution is done in Power Query (no DAX circular-dependency risk; mirrors the existing license merge),
as a **priority chain** that always lands on a real registry `Title ID` or null:

1. **Entra Agent ID** — `Agent_EntraId → agents_365[Entra Agent ID]` (future Agent 365 agents).
2. **Direct Title ID** — `Agent_TitleID` only when it already *is* a registry Title ID.
3. **Normalised name** — `lower(trim(AgentName)) → agents_365[Agent name]` (the high-yield fallback).

`Agent_LinkID = COALESCE(EntraTitle, DirectTitle, NameTitle)`. All three lookup maps are deduped and
null-guarded, so the 1.2M-row fact never fans out. The relationship is
**`Chat + Agent Interactions[Agent_LinkID] → agents_365[Title ID]`** (replaces the old `Agent_TitleID`
relationship; cross-filter direction unchanged).

**Zero-touch identity detection.** `agents_365` is given an add-if-missing **`Entra Agent ID`** column
that **auto-detects** the GUID from whatever the export provides — it picks the first present of
`Entra Agent ID → EntraAgentId → Agent ID → Bot Id` (and common variants). The customer never has to
create or populate a column by hand; a non-matching GUID simply does not join (no false links). Until
an export carries Entra GUIDs, custom agents still resolve by name.
**Dataverse path:** not applicable — it keys agents on `botSchemaName` (transcript trace), not audit `AgentId`.

### 5. `user_feedback` — Product Feedback (OCV export)
**Not** a Dataverse source — it is an OCV/Viva feedback **CSV** dropped at
`Files/copilot_transcripts/feedback.csv`, parsed by `build_feedback()`. The dashboard's
`ProductFeedback` table renames the OCV space-named columns. The empty placeholder now emits the
**full superset** (fixed) so a missing/partial export cannot break refresh:

```
Feedback Id, Comment, Translated Comment, Comment Language,
Date Submitted UTC, Feedback Type, Microsoft Response Status,
App, App Language, Platform, Source Type, Logs, Attachments,
User Id, User Email, Browser, Browser Version,
AI Context Prompt, AI Context Response Message,
Survey Question, Survey Response Option, Additional Metadata,
Date Submitted Date, Sentiment
```
*(Recommended: also add `MissingField.Ignore` to the model's `Table.RenameColumns` so partial OCV exports are tolerant.)*

### 6–11. Dataverse agent tables (from `conversationtranscripts`)
Produced by `Copilot_Agent_Transcript_Parser` (`SOURCE_MODE='dataverse'`, `AUTH_MODE='sp'`).
**Note:** Fabric `notebookutils.getToken` cannot mint a Dataverse token — the notebook must use an
**app-registration service principal** added as an **Application User** (e.g. *Bot Transcript Viewer*
role) in each environment. When Dataverse is not configured these six tables load empty.

**`agent_sessions`** (31)
```
conversation_id, session_start_utc, session_duration_ms, user_id_hash,
primary_agent_schema, agent_name, agent_id,
connected_agent_schemas, connected_agent_count,
msg_count, user_msg_count, bot_msg_count, plan_step_count,
total_displayed_cost, total_latency_ms,
knowledge_searched, knowledge_answered, knowledge_sources_count, grounding_source,
error_count, first_error_code,
feedback_offered_count, feedback_submitted, feedback_verdict, feedback_comment,
first_user_prompt,
session_outcome_explicit, session_outcome_reason_explicit,
is_authenticated, is_returning_user, primary_topic_derived
```
> `primary_agent_schema` is the agent **join key** (→ `agent_catalogue.agent_schema`). It is
> resolved from the most reliable signal available — Dataverse bot lookup, then bot-message
> `from.name`/`from.id`, then user-message `recipient`, then orchestration trace, then the
> transcript `name` — so single-agent transcripts (no orchestration trace) are still attributed.
> `agent_name` / `agent_id` carry the real resolved bot display name and id for richer binding.
**`agent_turns`** (17)
```
conversation_id, turn_id, turn_timestamp_utc, turn_role, turn_channel,
from_user_hash, text_preview_500, text_length,
intent_title, intent_id, intent_score,
knowledge_searched, knowledge_answered, knowledge_sources,
feedback_offered, feedback_verdict, feedback_comment
```
**`agent_errors`** (6)
```
conversation_id, error_timestamp_utc, error_code, error_sub_code, error_message, is_user_error
```
**`agent_subagents`** (8)
```
conversation_id, invocation_timestamp_utc, event_type,
parent_agent_schema, connected_agent_schema, dialog_schema,
user_id_hash, plan_step_id
```
**`agent_catalogue`** (3, +`source_environments` when `TAG_ENVIRONMENT=True`)
```
agent_schema, agent_display_name, agent_class
```
**`agent_performance`** (39)
```
ConversationTranscriptId, ConversationStartTime, SchemaVersion, BotName, BotId,
AADTenantId, BatchId, SessionStartTimeUtc, SessionEndTimeUtc,
SessionType, SessionOutcome, TurnCount, OutcomeReason, ImpliedSuccess,
LastUserIntentId, IsDesignMode, Locale,
UserMessageCount, BotMessageCount, TotalMessageCount,
FirstUserMessage, LastUserMessage, FirstBotMessage, LastBotMessage,
TopicsTriggered, TopicCount, PrimaryTopic,
DurationSeconds, AverageLatencyMs,
Var_ESS_UserContext_UPN, Var_ESS_Message_Disclaimer,
Var_ESS_UserContext_RefreshInterval_Hours, Var_ESS_UserContext_Conversation_Initialized,
AllVariables, TotalActivityCount, TraceActivityCount, EventActivityCount,
StatusCode, StateCode
```
*When `TAG_ENVIRONMENT=True`, the five fact tables also carry `source_environment` (and
`agent_catalogue` carries `source_environments`).*

---

## Known compatibility findings (tracked)

| ID | Table | Finding | Fix |
| --- | --- | --- | --- |
| A | `user_feedback` | Empty placeholder had 6 cols; `Table.RenameColumns` expects 17 → refresh broke when no feedback.csv | **Fixed** in notebook (full superset). Also add `MissingField.Ignore` in model. |
| B | `copilot_licensed_users` | Producer writes underscore names; model variant lists only have spaced/camel forms → UPN + licence load null | **Fixed** — underscore variants added to model |
| C | `agents_365` | Fabric model read a SharePoint URL | **Fixed** — `Copilot_Agent365_Lander` lands `dbo.agents_365`; table now `FabricTable` + `Enable_Agent365` |
| D | Audit/Licensed/Org core M | Staged from an older snapshot assuming RAW audit JSON (unconditional adds + `Json.Document`) → "field already exists" on pre-flattened producer output | **Fixed** — re-based on the §7-fixed versions (17 `HasColumns` guards, conditional parse) |
| E | `Agent Sessions → Org` (credits) | Join `user_id_hash → id` dangled because org producer never emitted `id`; credit-by-org showed 100% per org | **Fixed (producer)** — org ingester now emits Graph `id` (AAD objectId). Requires org re-land. |

## Known limitation — cross-environment / cross-tenant user identity

The **Dataverse** agent tables key on the user's **AAD objectId** (`user_id_hash`), while **Org** data is
Entra from *this* tenant. These only reconcile when the **transcripts and the Entra directory describe
the same users in the same tenant**. If agents are published in a **different environment/tenant** (common
in demos), the objectIds won't exist in the org table and credit-by-organization will show no/!00%
breakdown — this is a **data alignment** issue, not a model bug.

**Recommended robust design for the customer template** (not breaking, degrades cleanly):
1. Keep the objectId join (`user_id_hash → id`) as primary.
2. Optionally have the parser also emit the **UPN** (`user_upn`) when the transcript activity carries it,
   and add a fallback relationship `user_upn → PersonId_Normalized`.
3. Surface unmatched credit rows under an **"(Unmapped)"** organization rather than letting them silently
   inflate every org's share — so a key mismatch is *visible*, never misleading.
