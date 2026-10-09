# Permissions

The app registration the flows use needs the permissions below. This is the
whole list - if something is not here, the flows do not need it.

## App registration

In the Azure portal, **Microsoft Entra ID** → **App registrations** → **New
registration**. Single tenant. No redirect URI.

Note the **Application (client) ID** and **Directory (tenant) ID**. Create a
client secret under **Certificates & secrets** and put it in Key Vault - the
flows read it from there rather than holding it themselves.

## API permissions

All of these are **Application** permissions and all need admin consent.

| API | Permission | Used for |
|---|---|---|
| Power Platform API | `Licensing.Read.All` | Copilot Studio credit consumption |
| Power Platform API | `EnvironmentManagement.Read.All` | Environment names |

If you also want the Azure AI and GitHub pages to refresh automatically:

| API | Permission | Used for |
|---|---|---|
| Azure Service Management | `user_impersonation` | Azure AI Foundry spend |
| GitHub (PAT, not Entra) | `manage_billing:enterprise` | GitHub Copilot usage |

The GitHub feed uses a fine-grained personal access token, not the app
registration. Store it in the same Key Vault.

## Azure role assignments

For the Azure AI pages, give the app registration **Cost Management Reader** on
each subscription you want included. Subscription → **Access control (IAM)** →
**Add role assignment**.

## Power Platform

Give the app registration access to the Power Platform tenant:

```powershell
Add-PowerAppsAccount
New-PowerAppManagementApp -ApplicationId <client-id>
```

## Key Vault

The flows read secrets, nothing else. Give the flow's managed identity the **Key
Vault Secrets User** role on the vault.

## What this does not cover

Copilot Studio **per-user** consumption has no documented API, so these flows
don't load it. That page is fed by a manual `StudioPerUser.csv` export from the
Power Platform admin centre, as described in
[docs/DATA-SOURCES.md](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/DATA-SOURCES.md).
The [Fabric installer's flow](../../1.%20Fabric/installer/README.md#power-automate-flows) also
reads per-user figures, best effort, from an undocumented licensing API route.
