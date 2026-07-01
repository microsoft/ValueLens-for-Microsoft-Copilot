# Fabric Notebooks — Core vs Optional

The notebooks are split by which **template** they feed. Import only the notebooks
for the template(s) you deploy.

## `core/` — feed the **core** template (*No Studio*)

The core dashboard needs these seven ingesters. Each writes one Delta table the
semantic model reads via the `FabricTable(...)` helper.

| Notebook | Output table | Feeds |
|---|---|---|
| `Copilot_Audit_Log_Direct_Ingester` | `copilot_interactions_parsed` | Chat + Agent interactions (usage backbone) |
| `Copilot_Cost_Consumption_Ingester` | `copilot_cost_consumption` | Credit Consumption / Cowork pages |
| `Copilot_Credit_Consumption_Ingester` | `credit_consumption_agent` / `_user` / `_tenant` | Billing credit tables |
| `Copilot_Licensed_Users_Direct_Ingester` | `copilot_licensed_users` | Licence readiness |
| `Copilot_Org_Data_Direct_Ingester` | `copilot_org_data` | Org / department dimension |
| `Copilot_ProductFeedback_Ingester` | `user_feedback` | User Feedback page |
| `Copilot_Agent365_Lander` | `agents_365` | Agent Governance |

## `optional/copilot-studio/` — add for the **+ Copilot Studio** template

Only needed if you deploy the fuller *+ Copilot Studio* template, which adds the
seven Studio pages (Quality & Performance, Topic Explorer, Conversation Flow,
Knowledge Files, Error Analysis, Studio Credit Consumption, Studio User Feedback).

| Notebook | Output tables | Feeds |
|---|---|---|
| `Copilot_Agent_Transcript_Parser` | `agent_sessions`, `agent_turns`, `agent_performance`, `agent_errors`, `agent_subagents`, `agent_variables`, `agent_catalogue` | All Copilot Studio pages |
| `Copilot_Agent365_Registry_Ingester_PREVIEW` | `agent365_catalog` | Optional live Agent 365 registry enrichment (preview) |

## `optional/m365/` — add for the **M365 Signals** template (preview)

Manual-work signals from the Microsoft 365 Unified Audit Log, for the
*AI vs Manual Work* comparison. Template still in development.

| Notebook | Output table | Feeds |
|---|---|---|
| `Copilot_M365_Work_Behavior_Ingester` | `m365_work_behavior` | AI vs Manual Work page |

---

**Note:** all model partitions are gated by an `Enable_*` parameter and fall back to
an empty table when their source isn't present, so a template opens cleanly even if
you haven't run its optional notebooks yet.
