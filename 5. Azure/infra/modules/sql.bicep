// Azure SQL Database serverless with Entra-only authentication (no SQL logins).
// Power BI imports the curated tables from here, so they keep the Lakehouse names.
param location string
param serverName string
param databaseName string
param tags object
param adminLogin string
param adminObjectId string
@allowed(['User', 'Group', 'Application'])
param adminPrincipalType string
param minCapacity string = '0.5'
param maxCapacity int = 2
param autoPauseDelayMinutes int = 60
param useFreeLimit bool = false
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

resource server 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: serverName
  location: location
  tags: tags
  properties: {
    minimalTlsVersion: '1.2'
    publicNetworkAccess: publicNetworkAccess
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: true
      login: adminLogin
      sid: adminObjectId
      principalType: adminPrincipalType
      tenantId: subscription().tenantId
    }
  }
}

// Lets the Power BI service and Container Apps reach SQL over the public endpoint.
// Private mode (publicNetworkAccess = Disabled) uses a private endpoint and a gateway instead.
resource allowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = if (publicNetworkAccess == 'Enabled') {
  parent: server
  name: 'AllowAllWindowsAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource db 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: server
  name: databaseName
  location: location
  tags: tags
  sku: { name: 'GP_S_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: maxCapacity }
  properties: {
    minCapacity: json(minCapacity)
    autoPauseDelay: autoPauseDelayMinutes
    useFreeLimit: useFreeLimit
    freeLimitExhaustionBehavior: useFreeLimit ? 'AutoPause' : null
    requestedBackupStorageRedundancy: 'Local'
    zoneRedundant: false
  }
}

output serverFqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = db.name
output serverId string = server.id
