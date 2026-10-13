# Prerequisites

What you need before you install Analytics Hub, on one page. For the detail behind each line, see
[PERMISSIONS.md](PERMISSIONS.md). Once you sign in, the installer's **Prerequisites** panel (or
`prereqs` in the terminal) checks most of this for you.

## Platform

- **Windows 10 or 11** (64-bit) to run the installer, or [Node.js](../1.%20Fabric/installer/README.md#without-the-exe).
- **Fabric:** a [Fabric capacity](https://learn.microsoft.com/fabric/enterprise/licenses#capacity), F2 or
  larger, or a [trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial). Use **F64 or larger**
  for a tenant with more than 10,000 people ([A large tenant](../1.%20Fabric/installer/README.md#a-large-tenant)).
- **Fabric:** somewhere to keep the app's secret: [Contributor](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#contributor)
  on a subscription or resource group for a new [Key Vault](https://learn.microsoft.com/azure/key-vault/general/rbac-guide),
  or access to an existing one ([Where the secret goes](../1.%20Fabric/installer/README.md#where-the-secret-goes)).
- **Azure (preview), instead of Fabric:** [Contributor](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#contributor)
  plus [User Access Administrator](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#user-access-administrator),
  or [Owner](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#owner), on the
  subscription or resource group, and [Power BI Pro or PPU](https://learn.microsoft.com/power-bi/fundamentals/service-features-license-type).
  Agent 365, product feedback, Copilot Studio transcripts, GitHub Copilot credits and the Cowork credits
  Dataflow aren't on Azure yet ([Azure target](../1.%20Fabric/installer/README.md#azure-target-preview)).
- **Fabric tenant settings** turned on:
  [*Service principals can call Fabric public APIs*](https://learn.microsoft.com/fabric/admin/service-admin-portal-developer#service-principals-can-call-fabric-public-apis),
  [*Semantic Model Execute Queries REST API*](https://learn.microsoft.com/fabric/admin/service-admin-portal-integration#semantic-model-execute-queries-rest-api)
  and, on Fabric only, [*Fabric App items*](https://learn.microsoft.com/fabric/admin/tenant-settings-index#microsoft-fabric).

## Identity

- Permission to [register an app](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app)
  in Entra. Users can by default ([who can](https://learn.microsoft.com/entra/identity/role-based-access-control/delegate-app-roles#restrict-who-can-create-applications));
  otherwise an admin registers it with the [admin pack](../1.%20Fabric/installer/README.md#if-you-cant-register-apps).
- A [Global Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#global-administrator)
  or [Privileged Role Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#privileged-role-administrator)
  to [grant admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent)
  for the [Graph application permissions](https://learn.microsoft.com/graph/permissions-reference) below.

## Required roles and permissions

- **Purview audit (Copilot usage):** Graph [`AuditLogsQuery.Read.All`](https://learn.microsoft.com/graph/permissions-reference#auditlogsqueryreadall),
  for the [audit log query API](https://learn.microsoft.com/graph/api/security-auditcoreroot-post-auditlogqueries).
- **Licensing (licensed users):** Graph [`Reports.Read.All`](https://learn.microsoft.com/graph/permissions-reference#reportsreadall),
  for the [usage reports](https://learn.microsoft.com/graph/api/reportroot-getoffice365activeuserdetail).
- **Entra / org data:** Graph [`User.Read.All`](https://learn.microsoft.com/graph/permissions-reference#userreadall),
  to [list users](https://learn.microsoft.com/graph/api/user-list).

## Recommended optional

- **Copilot Studio credits:** a [Power Platform Administrator](https://learn.microsoft.com/power-platform/admin/use-service-admin-role-manage-tenant),
  [Billing Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#billing-administrator)
  or Global Administrator signs in to the flow. The flow's owner needs
  [Power Automate Premium](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/types).
- **Cowork credits:** a Viva Insights [Insights Analyst](https://learn.microsoft.com/viva/insights/advanced/setup-maint/assign-user-roles)
  signs in to the Dataflow. On Azure, drop the Consumption Dashboard's export in instead.
- **Azure credit consumption:** [Owner](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#owner)
  or [User Access Administrator](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#user-access-administrator)
  on the subscription, so the installer can assign the cost roles.
- **Agent 365:** an [Agent 365](https://learn.microsoft.com/microsoft-agent-365/overview) licence, plus Graph
  [`CopilotPackages.Read.All`](https://learn.microsoft.com/graph/permissions-reference#copilotpackagesreadall) and
  [`Application.Read.All`](https://learn.microsoft.com/graph/permissions-reference#applicationreadall), to
  [list Copilot packages](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list).

## Additional optional

- **Copilot Studio transcripts:** [System Administrator](https://learn.microsoft.com/power-platform/admin/database-security)
  in each Power Platform environment, to add the app as an [application user](https://learn.microsoft.com/power-platform/admin/manage-application-users)
  with the [Bot Transcript Viewer](https://learn.microsoft.com/microsoft-copilot-studio/analytics-transcripts-powerapps) role.
- **Microsoft 365 activity:** nothing extra, but the setting that
  [conceals user names in reports](https://learn.microsoft.com/troubleshoot/microsoft-365/admin/miscellaneous/reports-show-anonymous-user-name)
  must be off.
- **Defender:** [Defender for Endpoint P2](https://learn.microsoft.com/defender-endpoint/minimum-requirements) or
  [Defender XDR](https://learn.microsoft.com/defender-xdr/prerequisites) for devices and agents, and
  [Defender for Cloud Apps](https://learn.microsoft.com/defender-cloud-apps/set-up-cloud-discovery) for Cloud Discovery.
  Plus Graph [`ThreatHunting.Read.All`](https://learn.microsoft.com/graph/permissions-reference#threathuntingreadall)
  for [runHuntingQuery](https://learn.microsoft.com/graph/api/security-security-runhuntingquery) and
  [`CloudApp-Discovery.Read.All`](https://learn.microsoft.com/graph/permissions-reference#cloudapp-discoveryreadall)
  for the [Cloud Discovery API](https://learn.microsoft.com/graph/api/resources/security-cloudappdiscovery-overview?view=graph-rest-beta).
  A probe you aren't licensed for is skipped.
- **Resource Graph:** Azure [Reader](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/general#reader)
  at the [tenant root group](https://learn.microsoft.com/azure/governance/management-groups/overview) or a management
  group, plus [Global Reader](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#global-reader),
  [Power Platform Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#power-platform-administrator)
  or [AI Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#ai-administrator)
  for the app ([Azure Resource Graph](https://learn.microsoft.com/azure/governance/resource-graph/overview)).
- **Product feedback:** a Global Administrator or [Reports Reader](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#reports-reader)
  exports it from the Microsoft 365 admin center (**Health** > **Product feedback**); a
  [Power Automate flow](../1.%20Fabric/installer/README.md#power-automate-flows) or an upload lands it.
- **GitHub Copilot credits:** a GitHub [personal access token](https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
  with `manage_billing:enterprise`, from an enterprise admin or billing manager, for the
  [billing usage API](https://docs.github.com/enterprise-cloud@latest/rest/billing/usage). Or export the AI usage
  report from [GitHub Billing](https://docs.github.com/billing/reference/billing-reports). Not in the installer: see
  [Add Credit Consumption](../1.%20Fabric/Manual%20setup/Add%20Credit%20Consumption/README.md).

## Viewers

- [Power BI Pro or PPU](https://learn.microsoft.com/power-bi/fundamentals/service-features-license-type), unless
  the workspace is on an [F64 or larger capacity](https://learn.microsoft.com/fabric/enterprise/licenses#per-user-or-individual-licenses).
- Membership of the **Analytics Hub Viewers** group ([Viewing Analytics Hub](PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2)).
