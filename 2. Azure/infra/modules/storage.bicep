// ADLS Gen2 for raw and curated Parquet, plus Table Storage for app settings.
// Shared keys are disabled: everything uses Entra RBAC (common MSCAPS policy).
param location string
param name string
param tags object
param principalId string
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

var containers = ['raw', 'curated', 'landing']
var roles = {
  blobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  tableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
}

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    isHnsEnabled: true
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: publicNetworkAccess
    networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices' }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource blobContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for c in containers: {
  parent: blobService
  name: c
  properties: { publicAccess: 'None' }
}]

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource settingsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'appsettings'
}

resource roleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in items(roles): {
  name: guid(account.id, principalId, role.value)
  scope: account
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role.value)
  }
}]

output id string = account.id
output name string = account.name
output dfsEndpoint string = account.properties.primaryEndpoints.dfs
