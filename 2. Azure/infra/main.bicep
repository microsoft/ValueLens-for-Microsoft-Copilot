// Analytics Hub on Azure: resource-group scope deployment, run by the installer in
// incremental mode (with ARM what-if for the plan screen). Every resource carries the
// `valuelens-install-id` tag; the installer never modifies resources without it.
targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Region for Azure SQL only. Some regions stop accepting new SQL servers (RegionDoesNotAllowProvisioning); the installer lets you pick another. Empty = location.')
param sqlLocation string = ''

@description('Short lowercase prefix used in resource names.')
@minLength(2)
@maxLength(10)
param namePrefix string = 'vlens'

@description('Installer record id (GUID). Stamped on every resource as valuelens-install-id.')
param installId string

@description('Extra tags required by the customer\'s policy.')
param tags object = {}

@description('Container image registry and tag for the jobs and web images.')
param imageRegistry string = 'ghcr.io/microsoft'
param imageTag string

@description('Optional resource ID of a private Azure Container Registry holding the images. The managed identity gets AcrPull on it and pulls with that identity. Empty = public registry.')
param imageRegistryResourceId string = ''

@description('Cron schedule (UTC) for the daily collect/process/publish run.')
param runSchedule string = '0 3 * * *'

@description('Steps the scheduled run executes, mirroring the Enable* switches of the Fabric pipeline.')
param runSteps string = 'collect,process,publish,refresh'

@description('Demo mode: the run job publishes the bundled synthetic sample instead of collecting tenant data (VALUELENS_SAMPLE_DATA).')
param sampleData bool = false

@description('Entra principal that administers SQL. Defaults to the managed identity so the migrate job can create database users.')
param sqlAdminLogin string = ''
param sqlAdminObjectId string = ''
@allowed(['User', 'Group', 'Application'])
param sqlAdminPrincipalType string = 'Application'

@description('Preserve-on-update: the installer reads the live values back and passes them in.')
param sqlMinCapacity string = '0.5'
param sqlMaxCapacity int = 2
param sqlAutoPauseDelayMinutes int = 60
param sqlUseFreeLimit bool = false

@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Enabled'

@description('Private networking only: address space of the VNet (at least a /22).')
param vnetAddressPrefix string = '10.60.0.0/22'

@description('Deploy the Analytics Hub web app (SPA + /api).')
param deployWeb bool = true
param webMinReplicas int = 0
@description('App registration (client) id of the Analytics Hub web app; empty until the installer creates it.')
param webClientId string = ''
@description('Identifier URI the web API exposes (api://<fqdn>/<clientId>); empty until the installer sets it.')
param webAppIdUri string = ''

@description('Collection modules the run job executes (catalog ids), e.g. core,org,m365.')
param modules string = 'core'
@description('Audit history to backfill on the first run, in days.')
@allowed([30, 90, 180])
param auditHistoryDays int = 30

@description('Power BI workspace and semantic models (JSON: {"alias":{"workspaceId":"..","itemId":".."}}). Set by the installer after the models exist.')
param powerBiWorkspaceId string = ''
param semanticModels string = '{}'

@description('Display name of the SQL reader app registration that the migrate job grants db_datareader (the Power BI refresh credential).')
param sqlReaderName string = ''

@description('Client (app) ID of the SQL reader app registration. The migrate job creates its database user by SID, so the SQL server needs no Graph access.')
param sqlReaderClientId string = ''

@description('Credit consumption: subscription whose Azure OpenAI and AI Foundry costs the run job reads. Empty = Azure AI left out.')
param azureAiSubscriptionId string = ''
@description('Credit consumption: other subscriptions (comma-separated) that Copilot pay-as-you-go billing policies charge.')
param paygSubscriptionIds string = ''
@description('Credit consumption, private networking: SharePoint site, drive and folder the Copilot Studio flow and the Viva export are dropped in. Empty = the storage account\'s landing container.')
param dropSiteId string = ''
param dropDriveId string = ''
param dropFolder string = ''

var allTags = union(tags, { 'valuelens-install-id': installId, 'valuelens-component': 'analytics-hub' })
var privateNetworking = publicNetworkAccess == 'Disabled'
var suffix = substring(uniqueString(resourceGroup().id, installId), 0, 6)
var names = {
  identity: 'id-${namePrefix}-collector-${suffix}'
  logs: 'log-${namePrefix}-${suffix}'
  storage: toLower(take('st${replace(namePrefix, '-', '')}${suffix}', 24))
  // A separate SQL region gets its own name: a failed create in the first region keeps the old name reserved.
  sqlServer: empty(sqlLocation) ? 'sql-${namePrefix}-${suffix}' : 'sql-${namePrefix}-${substring(uniqueString(resourceGroup().id, installId, sqlLocation), 0, 6)}'
  sqlDatabase: 'valuelens'
  // Container Apps environment networking can't change after creation, so private mode gets its own environment.
  environment: privateNetworking ? 'cae-${namePrefix}-${suffix}-vnet' : 'cae-${namePrefix}-${suffix}'
  vnet: 'vnet-${namePrefix}-${suffix}'
  runJob: 'job-${namePrefix}-run'
  migrateJob: 'job-${namePrefix}-migrate'
  web: 'ca-${namePrefix}-web'
}

module identity 'modules/identity.bicep' = {
  name: 'vl-identity'
  params: { location: location, name: names.identity, tags: allTags }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'vl-monitoring'
  params: { location: location, name: names.logs, tags: allTags }
}

module storage 'modules/storage.bicep' = {
  name: 'vl-storage'
  params: {
    location: location
    name: names.storage
    tags: allTags
    principalId: identity.outputs.principalId
    publicNetworkAccess: publicNetworkAccess
  }
}

module sql 'modules/sql.bicep' = {
  name: 'vl-sql'
  params: {
    location: empty(sqlLocation) ? location : sqlLocation
    serverName: names.sqlServer
    databaseName: names.sqlDatabase
    tags: allTags
    adminLogin: empty(sqlAdminLogin) ? names.identity : sqlAdminLogin
    adminObjectId: empty(sqlAdminObjectId) ? identity.outputs.principalId : sqlAdminObjectId
    adminPrincipalType: empty(sqlAdminObjectId) ? 'Application' : sqlAdminPrincipalType
    minCapacity: sqlMinCapacity
    maxCapacity: sqlMaxCapacity
    autoPauseDelayMinutes: sqlAutoPauseDelayMinutes
    useFreeLimit: sqlUseFreeLimit
    publicNetworkAccess: publicNetworkAccess
  }
}

var privateRegistry = !empty(imageRegistryResourceId)
// ARM evaluates the scope and dependsOn of a module even when its condition is false, so
// indexing split('') fails validation. Without a private registry, parse a well-formed
// stand-in id (this resource group) instead; the acrPull module is still skipped.
var registryIdParts = split(privateRegistry ? imageRegistryResourceId : '${resourceGroup().id}/providers/Microsoft.ContainerRegistry/registries/none', '/')

module network 'modules/network.bicep' = if (privateNetworking) {
  name: 'vl-network'
  params: {
    location: location
    tags: allTags
    vnetName: names.vnet
    addressPrefix: vnetAddressPrefix
    sqlServerId: sql.outputs.serverId
    storageAccountId: storage.outputs.id
  }
}

module acrPull 'modules/acrpull.bicep' = if (privateRegistry) {
  name: 'vl-acrpull-${suffix}'
  scope: resourceGroup(registryIdParts[2], registryIdParts[4])
  params: {
    registryName: last(registryIdParts)
    principalId: identity.outputs.principalId
  }
}

module apps 'modules/containerapps.bicep' = {
  name: 'vl-containerapps'
  dependsOn: [acrPull]
  params: {
    infrastructureSubnetId: privateNetworking ? network!.outputs.appsSubnetId : ''
    registryServer: privateRegistry ? split(imageRegistry, '/')[0] : ''
    location: location
    tags: allTags
    environmentName: names.environment
    runJobName: names.runJob
    migrateJobName: names.migrateJob
    webName: names.web
    deployWeb: deployWeb
    logAnalyticsName: monitoring.outputs.name
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    jobsImage: '${imageRegistry}/valuelens-jobs:${imageTag}'
    webImage: '${imageRegistry}/valuelens-web:${imageTag}'
    runSchedule: runSchedule
    runSteps: runSteps
    sampleData: sampleData
    storageAccountName: storage.outputs.name
    sqlServerFqdn: sql.outputs.serverFqdn
    sqlDatabaseName: sql.outputs.databaseName
    webMinReplicas: webMinReplicas
    webClientId: webClientId
    webAppIdUri: webAppIdUri
    version: imageTag
    modules: modules
    auditHistoryDays: auditHistoryDays
    powerBiWorkspaceId: powerBiWorkspaceId
    semanticModels: semanticModels
    sqlReaderName: sqlReaderName
    sqlReaderClientId: sqlReaderClientId
    azureAiSubscriptionId: azureAiSubscriptionId
    paygSubscriptionIds: paygSubscriptionIds
    dropSiteId: dropSiteId
    dropDriveId: dropDriveId
    dropFolder: dropFolder
  }
}

output identityId string = identity.outputs.id
output identityPrincipalId string = identity.outputs.principalId
output identityClientId string = identity.outputs.clientId
output storageAccountName string = storage.outputs.name
output sqlServerFqdn string = sql.outputs.serverFqdn
output sqlDatabaseName string = sql.outputs.databaseName
output runJobName string = names.runJob
output migrateJobName string = names.migrateJob
output webUrl string = apps.outputs.webUrl
output webFqdn string = apps.outputs.webFqdn
output environmentName string = names.environment
output webName string = deployWeb ? names.web : ''
output vnetName string = privateNetworking ? names.vnet : ''
output gatewaySubnetName string = privateNetworking ? network!.outputs.gatewaySubnetName : ''
