// Example parameters for a manual `az deployment group what-if/create`.
// The installer generates these values itself and records them in valuelens-install.json.
using 'main.bicep'

param namePrefix = 'vlens'
param installId = '00000000-0000-0000-0000-000000000000'
param imageTag = '0.1.0'
param runSchedule = '0 3 * * *'
param deployWeb = true
param webMinReplicas = 0
