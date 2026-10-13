// Private networking mode (publicNetworkAccess = Disabled): a VNet for the Container Apps
// environment, private endpoints with private DNS for SQL and Storage, and a subnet delegated
// to Power Platform so a Power BI VNet data gateway can refresh the model from SQL.
// Private endpoints may sit in a different region from their target (Azure SQL can be moved
// to another region for capacity), so everything here uses the VNet's location.
param location string
param tags object
param vnetName string
param addressPrefix string
param sqlServerId string
param storageAccountId string

var subnets = {
  apps: cidrSubnet(addressPrefix, 23, 0)
  endpoints: cidrSubnet(addressPrefix, 24, 2)
  gateway: cidrSubnet(addressPrefix, 27, 24)
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'snet-apps'
        properties: {
          addressPrefix: subnets.apps
          delegations: [{ name: 'containerapps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'snet-endpoints'
        properties: {
          addressPrefix: subnets.endpoints
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-powerbi-gateway'
        properties: {
          addressPrefix: subnets.gateway
          delegations: [{ name: 'powerplatform', properties: { serviceName: 'Microsoft.PowerPlatform/vnetaccesslinks' } }]
        }
      }
    ]
  }
}

var endpoints = [
  { name: 'sql', target: sqlServerId, group: 'sqlServer', zone: 'privatelink${environment().suffixes.sqlServerHostname}' }
  { name: 'blob', target: storageAccountId, group: 'blob', zone: 'privatelink.blob.${environment().suffixes.storage}' }
  { name: 'dfs', target: storageAccountId, group: 'dfs', zone: 'privatelink.dfs.${environment().suffixes.storage}' }
  { name: 'table', target: storageAccountId, group: 'table', zone: 'privatelink.table.${environment().suffixes.storage}' }
]

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for e in endpoints: {
  name: e.zone
  location: 'global'
  tags: tags
}]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (e, i) in endpoints: {
  parent: zones[i]
  name: vnetName
  location: 'global'
  tags: tags
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}]

resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for e in endpoints: {
  name: 'pe-${last(split(e.target, '/'))}-${e.name}'
  location: location
  tags: tags
  properties: {
    subnet: { id: '${vnet.id}/subnets/snet-endpoints' }
    privateLinkServiceConnections: [{
      name: e.name
      properties: { privateLinkServiceId: e.target, groupIds: [e.group] }
    }]
  }
}]

resource dnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (e, i) in endpoints: {
  parent: privateEndpoints[i]
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: e.name, properties: { privateDnsZoneId: zones[i].id } }] }
}]

output vnetId string = vnet.id
output vnetName string = vnet.name
output appsSubnetId string = '${vnet.id}/subnets/snet-apps'
output gatewaySubnetName string = 'snet-powerbi-gateway'
