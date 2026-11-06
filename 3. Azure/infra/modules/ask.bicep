// The Azure OpenAI model behind the web app's /api/ask: an Azure AI Services account with one
// model deployment. Only the web app's managed identity can call it (no keys).

param location string
param tags object
param accountName string
@description('Principal ID of the managed identity the web app runs as.')
param principalId string
param modelName string
param modelVersion string
param deploymentName string
@description('Deployment SKU, e.g. GlobalStandard or DataZoneStandard.')
param sku string
@description('Throughput, in thousands of tokens per minute.')
param capacity int

// Cognitive Services OpenAI User: call the deployments, nothing else.
var openAiUserRole = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: deploymentName
  sku: { name: sku, capacity: capacity }
  properties: {
    model: { format: 'OpenAI', name: modelName, version: modelVersion }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource userRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, principalId, openAiUserRole)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRole)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output endpoint string = account.properties.endpoint
output deploymentName string = deployment.name
output id string = account.id
