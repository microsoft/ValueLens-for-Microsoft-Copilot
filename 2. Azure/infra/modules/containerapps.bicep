// Container Apps environment (consumption), the scheduled run job, the manual migrate
// job and the Analytics Hub web app. Images are public on GHCR unless registryServer names a
// private registry, which is then pulled from with the managed identity.
param location string
param tags object
param environmentName string
param runJobName string
param migrateJobName string
param webName string
param deployWeb bool
param logAnalyticsName string
param identityId string
param identityClientId string
param jobsImage string
param webImage string
param runSchedule string
param runSteps string
param sampleData bool = false
param storageAccountName string
param sqlServerFqdn string
param sqlDatabaseName string
param webMinReplicas int = 0
param webClientId string = ''
param webAppIdUri string = ''
param version string
param modules string
param auditHistoryDays int
param powerBiWorkspaceId string
param semanticModels string
param sqlReaderName string
param sqlReaderClientId string = ''
param registryServer string = ''
@description('Subnet delegated to Microsoft.App/environments (private networking). Empty = no VNet.')
param infrastructureSubnetId string = ''

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    // Private mode: jobs reach SQL and Storage through private endpoints; web ingress stays public.
    vnetConfiguration: empty(infrastructureSubnetId) ? null : { infrastructureSubnetId: infrastructureSubnetId, internal: false }
  }
}

var commonEnv = [
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  { name: 'VALUELENS_STORAGE_ACCOUNT', value: storageAccountName }
  { name: 'VALUELENS_SQL_SERVER', value: sqlServerFqdn }
  { name: 'VALUELENS_SQL_DATABASE', value: sqlDatabaseName }
  { name: 'VALUELENS_TENANT_ID', value: subscription().tenantId }
  { name: 'VALUELENS_VERSION', value: version }
  { name: 'VALUELENS_POWERBI_WORKSPACE_ID', value: powerBiWorkspaceId }
  { name: 'VALUELENS_SEMANTIC_MODELS', value: semanticModels }
]
var jobEnv = concat(commonEnv, [
  { name: 'VALUELENS_MODULES', value: modules }
  { name: 'VALUELENS_AUDIT_HISTORY_DAYS', value: string(auditHistoryDays) }
  { name: 'VALUELENS_SQL_READER_NAME', value: sqlReaderName }
  { name: 'VALUELENS_SQL_READER_CLIENT_ID', value: sqlReaderClientId }
  { name: 'VALUELENS_SAMPLE_DATA', value: sampleData ? 'true' : 'false' }
])
var registries = empty(registryServer) ? [] : [{ server: registryServer, identity: identityId }]
var identity = {
  type: 'UserAssigned'
  userAssignedIdentities: { '${identityId}': {} }
}

resource runJob 'Microsoft.App/jobs@2024-03-01' = {
  name: runJobName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      registries: registries
      replicaTimeout: 14400
      replicaRetryLimit: 1
      scheduleTriggerConfig: { cronExpression: runSchedule, parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{
        name: 'run'
        image: jobsImage
        args: ['run', '--steps', runSteps]
        env: jobEnv
        resources: { cpu: json('4'), memory: '8Gi' }
      }]
    }
  }
}

resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: migrateJobName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      registries: registries
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [{
        name: 'migrate'
        image: jobsImage
        args: ['migrate']
        env: jobEnv
        resources: { cpu: json('0.5'), memory: '1Gi' }
      }]
    }
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = if (deployWeb) {
  name: webName
  location: location
  tags: tags
  identity: identity
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }
      registries: registries
    }
    template: {
      containers: [{
        name: 'web'
        image: webImage
        env: concat(commonEnv, [
          { name: 'VALUELENS_WEB_CLIENT_ID', value: webClientId }
          { name: 'VALUELENS_APP_ID_URI', value: webAppIdUri }
        ])
        resources: { cpu: json('0.5'), memory: '1Gi' }
        probes: [{ type: 'Liveness', httpGet: { path: '/api/health', port: 8080 } }]
      }]
      scale: { minReplicas: webMinReplicas, maxReplicas: 3 }
    }
  }
}

output environmentId string = env.id
output webUrl string = deployWeb ? 'https://${web!.properties.configuration.ingress.fqdn}' : ''
output webFqdn string = deployWeb ? web!.properties.configuration.ingress.fqdn : ''
