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
InteractionDate, WeekStart, MonthStart
```

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

**`agent_sessions`** (23, +`primary_topic_derived` when enrichment cell 5b runs, **+4** when enrichment cell 5c runs)
```
conversation_id, session_start_utc, session_duration_ms, user_id_hash,
primary_agent_schema, connected_agent_schemas, connected_agent_count,
msg_count, user_msg_count, bot_msg_count, plan_step_count,
total_displayed_cost, total_latency_ms,
knowledge_searched, knowledge_answered, knowledge_sources_count,
error_count, first_error_code,
feedback_offered_count, feedback_submitted, feedback_verdict, feedback_comment,
first_user_prompt,
session_outcome_explicit, session_outcome_reason_explicit,
is_authenticated, is_returning_user
```
**`agent_turns`** (17, +`topic_derived`, `role_inferred`, `role_mismatch` when enrichment cell 5b runs)
```
conversation_id, turn_id, turn_timestamp_utc, turn_role, turn_channel,
from_user_hash, text_preview_500, text_length,
intent_title, intent_id, intent_score,
knowledge_searched, knowledge_answered, knowledge_sources,
feedback_offered, feedback_verdict, feedback_comment
```

**Transcript enrichment (notebook cell 5b — non-destructive, added)**
A post-build step tags topics from the **full turn text** and infers speaker from message content. Originals (`turn_role`, `intent_title`) are kept untouched.

| Column | Table | Meaning |
| --- | --- | --- |
| `topic_derived` | `agent_turns` | Business topic of the message — keyword taxonomy (default) or Azure OpenAI when `TOPIC_METHOD='llm'`. Noise buckets are prefixed 🚫. Far higher coverage than the export's sparse `intent_title`. |
| `role_inferred` | `agent_turns` | Speaker inferred from content shape (official markup / length / question form). Falls back to `turn_role` when undecided. |
| `role_mismatch` | `agent_turns` | `True` where `role_inferred` ≠ `turn_role` — a direct measure of source role-label quality (high on some channels). |
| `primary_topic_derived` | `agent_sessions` | Most frequent non-noise `topic_derived` across the conversation's turns. |

Config flags (cell 2): `TOPIC_METHOD` (`'keyword'`\|`'llm'`), `ROLE_INFERENCE` (bool), `TOPIC_TAXONOMY` (list), and `AOAI_*` for the optional LLM path.
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
**`agent_performance`** (39, **+18** when enrichment cell 5c runs)
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
StatusCode, StateCode,
SessionOutcomeExplicit, SessionOutcomeReasonExplicit, IsAuthenticated,
TopicsStarted, TopicsCompleted, TopicCompletionRate,
PrimaryTopicDwellMs, TotalTopicDwellMs,
LLMCallCount, PromptTokenCount, CompletionTokenCount, TotalTokenCount,
PluginCallCount, PluginSuccessCount, GenerativeResponseCount,
MultiAgentSession, FirstErrorCode, ErrorCategory
```

**Deep-dive transcript enrichment (notebook cell 5c — non-destructive, added)**
A second post-build step derives Copilot Studio platform-emitted signals from
`parsed['content_json']` and joins them onto `agent_sessions` and
`agent_performance` (no edits to the build_* functions). Also produces the new
`agent_variables` fact table. All matchers calibrated to the **real** Copilot
Studio transcript schema (`SessionInfo`, `IntentRecognition`, `GPTAnswer`,
`VariableAssignment`, `ConnectedAgentInitializeTraceData`,
`AuthenticationTraceData`, `ErrorTraceData`) — verified end-to-end with a
8-transcript files-mode smoke test (7 tables, all enrichment columns populating).

| Column | Table | Source | Meaning |
| --- | --- | --- | --- |
| `session_outcome_explicit` | `agent_sessions` | `SessionInfo.outcome` | Platform-emitted explicit outcome (replaces the heuristic). Falls back to legacy `ConversationEnd*` traces if a future export emits them. |
| `session_outcome_reason_explicit` | `agent_sessions` | `SessionInfo.outcomeReason` | Reason string from the same trace. |
| `is_authenticated` | `agent_sessions` | `AuthenticationTraceData` OR `aadObjectId` on any message | `True` when the user resolved to Entra (explicit auth success **or** implicit aadObjectId). |
| `is_returning_user` | `agent_sessions` | Computed post-build | `True` when the user has at least one earlier session in the same batch (ordered by `session_start_utc`). |
| `SessionOutcomeExplicit` / `SessionOutcomeReasonExplicit` / `IsAuthenticated` | `agent_performance` | (same sources) | PascalCase mirror of the `agent_sessions` columns, on the KPI fact. |
| `TopicsStarted` / `TopicsCompleted` / `TopicCompletionRate` | `agent_performance` | `IntentRecognition` (preferred) or `TopicStart`/`TopicEndTrace` | Count of recognised intents (Copilot Studio's actual unit of "topic"); completion = no `ErrorTraceData` followed. |
| `PrimaryTopicDwellMs` / `TotalTopicDwellMs` | `agent_performance` | Time between consecutive `IntentRecognition` events | Coarse dwell measure — gap to next intent (or session end). |
| `LLMCallCount` / `PromptTokenCount` / `CompletionTokenCount` / `TotalTokenCount` | `agent_performance` | `LLMCallTraceData` / `LlmCallTraceData` / `GenerativeAnswer` | LLM cost proxy; tokens summed across all calls in the session. |
| `PluginCallCount` / `PluginSuccessCount` | `agent_performance` | `*Plugin*` / `*Tool*` / `ConnectorAction` traces | Connector / Power Automate / plugin invocations + success counter. |
| `GenerativeResponseCount` | `agent_performance` | `GPTAnswer` trace (real Copilot Studio schema) | Number of generative answers in the session. |
| `MultiAgentSession` | `agent_performance` | Any `ConnectedAgentInitializeTraceData` present | Flag for sessions that crossed into a child / connected agent. |
| `FirstErrorCode` / `ErrorCategory` | `agent_performance` | First `ErrorTraceData` in the session | Categorised into Knowledge / Flow-Plugin / Auth / LLM-Model / Transient / Runtime / User. |

### 12. `agent_variables` — Copilot Studio variable assignments fact
Built by enrichment cell 5c. One row per `(conversation_id, variable_name)` —
decomposes the `VariableAssignment` trace activities that Copilot Studio writes
on every turn, exposing every custom variable an agent author has defined as a
first-class slicer in the dashboard. Most-recent value wins on conflict within
a session. Long values are truncated to 1,000 chars.

```
conversation_id, variable_name, variable_value
```

*When `TAG_ENVIRONMENT=True`, the six fact tables also carry `source_environment` (and
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
| F | `agent_turns.turn_role` | On some channels (esp. `m365copilot`) the source `from.role` does not match message content — agent-style answers tagged *user*, user questions tagged *bot* (a Copilot Studio transcript-export quirk, not a parser bug). | **Diagnosed + mitigated** — enrichment cell 5b adds `role_inferred` + `role_mismatch` (content heuristics) **without** altering `turn_role`. Run the cell to see per-channel mismatch rates; the dashboard can opt into `role_inferred`. A source-side fix needs raw `content_json` inspection in Fabric. |
| G | `agent_turns.intent_title` | Topic field is populated for only ~4% of turns and is mostly system labels (`Logging`, `[System] - Response Preparation`), so topic analysis on it is near-empty. | **Mitigated** — cell 5b adds `topic_derived` mined from full message text (keyword default; Azure OpenAI optional). Upgrade path: switch `TOPIC_METHOD='llm'`. |

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
