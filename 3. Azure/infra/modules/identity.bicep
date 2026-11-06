// User-assigned managed identity used by the jobs and the web app. Graph app roles
// (AuditLogsQuery.Read.All, Reports.Read.All, User.Read.All, ...) are assigned to its
// service principal by the installer through Graph; ARM cannot grant them.
param location string
param name string
param tags object

resource mi 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

output id string = mi.id
output principalId string = mi.properties.principalId
output clientId string = mi.properties.clientId
output name string = mi.name
