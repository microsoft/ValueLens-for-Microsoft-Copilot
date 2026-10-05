// Analytics Hub on Azure: resource-group scope deployment, run by the installer in
// incremental mode (with ARM what-if for the plan screen). Every resource carries the
// `valuelens-install-id` tag; the installer never modifies resources without it.
targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

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

@description('Cron schedule (UTC) for the daily collect/process/publish run.')
param runSchedule string = '0 3 * * *'

@description('Steps the scheduled run executes, mirroring the Enable* switches of the Fabric pipeline.')
param runSteps string = 'collect,process,publish,refresh'

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

@description('Deploy the Analytics Hub web app (SPA + /api).')
param deployWeb bool = true
param webMinReplicas int = 0
@description('App registration (client) id of the Analytics Hub web app; empty until the installer creates it.')
param webClientId string = ''

var allTags = union(tags, { 'valuelens-install-id': installId, 'valuelens-component': 'analytics-hub' })
var suffix = substring(uniqueString(resourceGroup().id, installId), 0, 6)
var names = {
  identity: 'id-${namePrefix}-collector-${suffix}'
  logs: 'log-${namePrefix}-${suffix}'
  storage: toLower(take('st${replace(namePrefix, '-', '')}${suffix}', 24))
  sqlServer: 'sql-${namePrefix}-${suffix}'
  sqlDatabase: 'valuelens'
  environment: 'cae-${namePrefix}-${suffix}'
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
    location: location
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

module apps 'modules/containerapps.bicep' = {
  name: 'vl-containerapps'
  params: {
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
    storageAccountName: storage.outputs.name
    sqlServerFqdn: sql.outputs.serverFqdn
    sqlDatabaseName: sql.outputs.databaseName
    webMinReplicas: webMinReplicas
    webClientId: webClientId
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
