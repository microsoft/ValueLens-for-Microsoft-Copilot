# Which agents does the audit log cover?

ValueLens takes its Copilot figures mainly from the Purview audit log. This is what that log
covers.

- **Covered by default (Audit Standard):** Microsoft 365 Copilot and its agents, Copilot Studio agents, Security Copilot, Copilot in Fabric, Cowork.
- **Self-hosted pro-code agents** (Agents SDK, Semantic Kernel, LangChain, etc.): only if developers send interactions to Purview (Purview SDK/APIs).
- **Foundry agents:** only when Purview data security is on for the Azure subscription.
- **Third-party AI** (ChatGPT Enterprise, Gemini, Claude): only with Purview pay-as-you-go, logged as `AIAppInteraction`.
- **Consumer Copilot** (personal Microsoft accounts): not logged; outside the tenant.
- **What Analytics Hub reads:** `CopilotInteraction` records only, so `AIAppInteraction` activity isn't included.

Source: [Audit logs for Copilot and AI applications](https://learn.microsoft.com/en-us/purview/audit-copilot)
