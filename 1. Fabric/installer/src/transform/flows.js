// @ts-check
/**
 * The Power Automate cloud flows the installer can create: one saves product feedback exports
 * emailed to the admin, the other reads Copilot Studio credits from the Power Platform licensing
 * API each day. Both drop CSVs in the Lakehouse drop folder, where the pipeline's router picks
 * them up, so they need nothing the uploads don't. They write with the installer's app
 * registration, whose secret they read from Key Vault at run time.
 */
import { UPLOAD_DIR } from '../uploads.js';

export const FEEDBACK_FLOW_NAME = 'Analytics Hub - Product feedback';
export const STUDIO_FLOW_NAME = 'Analytics Hub - Copilot Studio credits';
/** The subject the product feedback export is emailed under. */
export const FEEDBACK_SUBJECT = 'Copilot Product Feedback';
/** Days of agent credits each Studio flow run restates; the licensing API revises recent days. */
export const STUDIO_FLOW_DAYS = 10;
/** The Power Platform API, read as the flow's owner. Its licensing routes take delegated sign-ins only. */
export const PPAPI = 'https://api.powerplatform.com';
const LICENSING_VERSION = '2024-10-01';

const SCHEMA = 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';
const SECURE = { secureData: { properties: ['inputs', 'outputs'] } };

/**
 * A connector the flows use. Each becomes a connection reference the user signs in to once.
 * @type {Record<'outlook' | 'keyVault' | 'entra', { name: string, label: string }>}
 */
export const CONNECTORS = {
  outlook: { name: 'shared_office365', label: 'Office 365 Outlook' },
  keyVault: { name: 'shared_keyvault', label: 'Azure Key Vault' },
  entra: { name: 'shared_webcontents', label: 'HTTP with Microsoft Entra ID (preauthorized)' },
};

/**
 * @typedef {object} FlowTarget
 * @property {string} tenantId
 * @property {string} clientId  The app registration that writes to OneLake.
 * @property {string} secretName  Its client secret in Key Vault.
 * @property {string} workspaceId
 * @property {string} lakehouseId
 */

/** @param {string} connectionName */
const host = (connectionName) => ({
  connectionName,
  apiId: `/providers/Microsoft.PowerApps/apis/${connectionName}`,
});

/** @param {FlowTarget} t */
function getSecret(t) {
  return {
    type: 'OpenApiConnection',
    inputs: {
      host: { ...host(CONNECTORS.keyVault.name), operationId: 'GetSecret' },
      parameters: { secretName: t.secretName },
      authentication: "@parameters('$authentication')",
    },
    runtimeConfiguration: SECURE,
  };
}

/**
 * Writes a file to the drop folder with the app's identity. Workspace and Lakehouse are GUIDs:
 * OneLake rejects a mix of a GUID and a name.
 * @param {FlowTarget} t
 * @param {string} fileName  Expression text inside the URL, e.g. `@{...}`.
 * @param {string} body
 * @param {Record<string, string[]>} runAfter
 */
function putToDropFolder(t, fileName, body, runAfter) {
  return {
    type: 'Http',
    runAfter,
    inputs: {
      method: 'PUT',
      uri: `https://onelake.blob.fabric.microsoft.com/${t.workspaceId}/${t.lakehouseId}/${UPLOAD_DIR}/${fileName}`,
      headers: { 'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'text/csv' },
      body,
      authentication: {
        type: 'ActiveDirectoryOAuth',
        authority: 'https://login.microsoftonline.com',
        tenant: t.tenantId,
        audience: 'https://storage.azure.com/',
        clientId: t.clientId,
        secret: "@body('Get_client_secret')?['value']",
      },
    },
    runtimeConfiguration: { secureData: { properties: ['inputs'] } },
  };
}

const PARAMETERS = {
  $connections: { defaultValue: {}, type: 'Object' },
  $authentication: { defaultValue: {}, type: 'SecureObject' },
};

/**
 * Saves product feedback CSVs emailed to the flow's owner into the drop folder.
 * @param {FlowTarget} t
 * @param {{ subject?: string, prefix?: string }} [o]
 */
export function feedbackFlowDefinition(t, o = {}) {
  const item = "items('For_each_attachment')";
  return {
    $schema: SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: PARAMETERS,
    triggers: {
      When_a_new_email_arrives_V3: {
        type: 'OpenApiConnectionNotification',
        inputs: {
          host: { ...host(CONNECTORS.outlook.name), operationId: 'OnNewEmailV3' },
          parameters: { folderPath: 'Inbox', subjectFilter: o.subject ?? FEEDBACK_SUBJECT, hasAttachments: true, includeAttachments: true, importance: 'Any' },
          authentication: "@parameters('$authentication')",
        },
        splitOn: "@triggerOutputs()?['body/value']",
      },
    },
    actions: {
      Get_client_secret: { ...getSecret(t), runAfter: {} },
      For_each_attachment: {
        type: 'Foreach',
        runAfter: { Get_client_secret: ['Succeeded'] },
        foreach: "@triggerOutputs()?['body/attachments']",
        actions: {
          Only_feedback_CSVs: {
            type: 'If',
            expression: {
              and: [
                { endsWith: [`@toLower(${item}?['name'])`, '.csv'] },
                { startsWith: [`@toLower(${item}?['name'])`, (o.prefix ?? 'feedback').toLowerCase()] },
              ],
            },
            actions: {
              Save_to_drop_folder: putToDropFolder(
                t,
                `@{utcNow('yyyyMMddHHmmss')}_@{encodeUriComponent(${item}?['name'])}`,
                `@base64ToBinary(${item}?['contentBytes'])`,
                {},
              ),
            },
            else: { actions: {} },
          },
        },
      },
    },
  };
}

/** @param {string} path  A Power Platform API path and query, with expressions. */
function ppApi(path) {
  return {
    type: 'OpenApiConnection',
    inputs: {
      host: { ...host(CONNECTORS.entra.name), operationId: 'InvokeHttp' },
      parameters: { 'request/method': 'GET', 'request/url': `${PPAPI}${path}` },
      authentication: "@parameters('$authentication')",
    },
  };
}

/**
 * Pipeline time less an hour, so the day's files are waiting when the pipeline runs.
 * @param {string} time  HH:mm.
 */
export function hourBefore(time) {
  const [h, m] = time.split(':').map(Number);
  return { hours: [(h + 23) % 24], minutes: [m] };
}

/**
 * Reads Copilot Studio credits from the Power Platform licensing API once a day and drops two CSVs
 * the router recognises: credits by agent for the last ten days, and the tenant entitlement with
 * each environment's allocation. The notebook turns them into the same tables as the exports.
 * @param {FlowTarget} t
 * @param {{ time: string, timeZone: string }} schedule  The pipeline's, as HH:mm and a Windows time zone.
 */
export function studioFlowDefinition(t, schedule) {
  const v = `api-version=${LICENSING_VERSION}`;
  const page = "body('Get_agent_credits')";
  const resources = `coalesce(${page}?['value']?[0]?['resources'], ${page}?['value'], json('[]'))`;
  const alloc = "body('Get_allocations')";
  const tenant = "body('Get_entitlement')?['entitlement']";
  const envs = "body('Get_environments')";
  const env = "items('For_each_environment')";
  const envName = `first(body('Find_environment'))`;
  const stamp = "@{utcNow('yyyyMMddHHmmss')}";
  const both = ['Succeeded', 'Failed', 'Skipped', 'TimedOut'];
  return {
    $schema: SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: PARAMETERS,
    triggers: {
      Daily: {
        type: 'Recurrence',
        recurrence: { frequency: 'Day', interval: 1, timeZone: schedule.timeZone, schedule: hourBefore(schedule.time) },
      },
    },
    actions: {
      Agent_rows: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'AgentRows', type: 'array', value: [] }] } },
      Token: { type: 'InitializeVariable', runAfter: { Agent_rows: ['Succeeded'] }, inputs: { variables: [{ name: 'Token', type: 'string', value: '' }] } },
      Day: { type: 'InitializeVariable', runAfter: { Token: ['Succeeded'] }, inputs: { variables: [{ name: 'Day', type: 'string', value: '' }] } },
      Get_client_secret: { ...getSecret(t), runAfter: { Day: ['Succeeded'] } },
      // One day per call keeps the daily grain; pages of 5,000 stay stable on busy days.
      For_each_day: {
        type: 'Foreach',
        runAfter: { Get_client_secret: ['Succeeded'] },
        foreach: `@range(1, ${STUDIO_FLOW_DAYS})`,
        runtimeConfiguration: { concurrency: { repetitions: 1 } },
        actions: {
          Set_day: {
            type: 'SetVariable',
            runAfter: {},
            inputs: { name: 'Day', value: "@{formatDateTime(addDays(utcNow(), mul(-1, items('For_each_day'))), 'yyyy-MM-dd')}" },
          },
          Reset_token: { type: 'SetVariable', runAfter: { Set_day: ['Succeeded'] }, inputs: { name: 'Token', value: '' } },
          Each_page: {
            type: 'Until',
            runAfter: { Reset_token: ['Succeeded'] },
            expression: "@equals(variables('Token'), 'done')",
            limit: { count: 50, timeout: 'PT1H' },
            actions: {
              Get_agent_credits: {
                ...ppApi(
                  `/licensing/entitlements/MCSMessages/resources?${v}&fromDate=@{variables('Day')}&toDate=@{variables('Day')}&pageSize=5000&includeFields=users%2Ctags%2CasOfDate&continuationtoken=@{encodeUriComponent(variables('Token'))}`,
                ),
                runAfter: {},
              },
              Rows: {
                type: 'Select',
                runAfter: { Get_agent_credits: ['Succeeded'] },
                inputs: {
                  from: `@${resources}`,
                  select: {
                    'Usage Date': "@variables('Day')",
                    'Agent Id': "@item()?['resourceId']",
                    'Agent Name': "@item()?['metadata']?['ResourceName']",
                    'Environment Id': "@item()?['environmentId']",
                    'Environment Name': '',
                    'Billed credit': "@item()?['consumed']",
                    'Non-billed credit': "@item()?['metadata']?['NonBillableQuantity']",
                    Users: "@item()?['metadata']?['Users']",
                    Channel: "@item()?['metadata']?['ChannelId']",
                    Feature: "@item()?['metadata']?['FeatureName']",
                    'LLM Model': "@item()?['metadata']?['LLMModel']",
                    'Tool Used': "@item()?['metadata']?['ToolInvoked']",
                    'Knowledge Sources': "@item()?['metadata']?['KnowledgeSources']",
                    Unit: "@item()?['unit']",
                  },
                },
              },
              Add_rows: {
                type: 'Compose',
                runAfter: { Rows: ['Succeeded'] },
                inputs: "@union(variables('AgentRows'), body('Rows'))",
              },
              Keep_rows: { type: 'SetVariable', runAfter: { Add_rows: ['Succeeded'] }, inputs: { name: 'AgentRows', value: "@outputs('Add_rows')" } },
              Next_page: {
                type: 'SetVariable',
                runAfter: { Keep_rows: ['Succeeded'] },
                inputs: {
                  name: 'Token',
                  value: `@{if(empty(coalesce(${page}?['continuationtoken'], ${page}?['continuationToken'], ${page}?['value']?[0]?['continuationToken'], '')), 'done', coalesce(${page}?['continuationtoken'], ${page}?['continuationToken'], ${page}?['value']?[0]?['continuationToken']))}`,
                },
              },
              // A day that fails ends that day's paging; the others still run.
              Stop_paging: {
                type: 'SetVariable',
                runAfter: { Get_agent_credits: ['Failed', 'TimedOut'] },
                inputs: { name: 'Token', value: 'done' },
              },
            },
          },
        },
      },
      Agent_CSV: {
        type: 'Table',
        runAfter: { For_each_day: both },
        inputs: { from: "@variables('AgentRows')", format: 'CSV' },
      },
      Any_agent_credits: {
        type: 'If',
        runAfter: { Agent_CSV: ['Succeeded'] },
        expression: { greater: ["@length(variables('AgentRows'))", 0] },
        actions: { Save_agent_credits: putToDropFolder(t, `StudioApiAgentDaily_${stamp}.csv`, "@body('Agent_CSV')", {}) },
        else: { actions: {} },
      },
      Get_entitlement: { ...ppApi(`/licensing/entitlements/MCSMessages?${v}`), runAfter: { Any_agent_credits: both } },
      // Without the tenant entitlement there is no snapshot: zeros would read as all pay-as-you-go.
      Get_allocations: { ...ppApi(`/licensing/allocationsByEnvironment?${v}`), runAfter: { Get_entitlement: ['Succeeded'] } },
      Get_environments: { ...ppApi(`/environmentmanagement/environments?${v}`), runAfter: { Get_allocations: ['Succeeded', 'Failed', 'TimedOut'] } },
      Entitlement_rows: {
        type: 'InitializeVariable',
        runAfter: { Get_environments: ['Succeeded', 'Failed', 'TimedOut'] },
        inputs: {
          variables: [
            {
              name: 'EntitlementRows',
              type: 'array',
              // The tenant row carries the prepaid share even when no environment has an allocation.
              value: [entitlementRow(tenant, "''", "''", '0')],
            },
          ],
        },
      },
      For_each_environment: {
        type: 'Foreach',
        runAfter: { Entitlement_rows: ['Succeeded'] },
        foreach: `@coalesce(${alloc}?['value'], ${alloc}, json('[]'))`,
        runtimeConfiguration: { concurrency: { repetitions: 1 } },
        actions: {
          Studio_allocation: {
            type: 'Query',
            runAfter: {},
            inputs: { from: `@coalesce(${env}?['currencyAllocations'], json('[]'))`, where: "@equals(item()?['currencyType'], 'MCSMessages')" },
          },
          Find_environment: {
            type: 'Query',
            runAfter: { Studio_allocation: ['Succeeded'] },
            inputs: {
              from: `@coalesce(${envs}?['value'], json('[]'))`,
              where: `@or(equals(toLower(coalesce(item()?['id'], '')), toLower(${env}?['environmentId'])), endsWith(toLower(coalesce(item()?['id'], '')), concat('/', toLower(${env}?['environmentId']))), equals(toLower(coalesce(item()?['name'], '')), toLower(${env}?['environmentId'])))`,
            },
          },
          Has_allocation: {
            type: 'If',
            runAfter: { Find_environment: ['Succeeded', 'Failed'] },
            expression: { greater: ["@length(body('Studio_allocation'))", 0] },
            actions: {
              Add_environment: {
                type: 'AppendToArrayVariable',
                runAfter: {},
                inputs: {
                  name: 'EntitlementRows',
                  value: entitlementRow(
                    tenant,
                    `${env}?['environmentId']`,
                    `coalesce(${envName}?['displayName'], ${envName}?['properties']?['displayName'], '')`,
                    "add(coalesce(first(body('Studio_allocation'))?['allocated'], 0), coalesce(first(body('Studio_allocation'))?['autoAllocated'], 0))",
                  ),
                },
              },
            },
            else: { actions: {} },
          },
        },
      },
      Entitlement_CSV: {
        type: 'Table',
        runAfter: { For_each_environment: both },
        inputs: { from: "@variables('EntitlementRows')", format: 'CSV' },
      },
      Save_entitlement: {
        ...putToDropFolder(t, `StudioApiEntitlement_${stamp}.csv`, "@body('Entitlement_CSV')", { Entitlement_CSV: ['Succeeded'] }),
      },
    },
  };
}

/**
 * @param {string} tenant  Expression for the entitlement object.
 * @param {string} envId  Expressions.
 * @param {string} envName
 * @param {string} allocated
 */
function entitlementRow(tenant, envId, envName, allocated) {
  return {
    'Snapshot Date': "@{utcNow('yyyy-MM-dd')}",
    'Environment Id': `@{${envId}}`,
    'Environment Name': `@{${envName}}`,
    'Environment Allocated': `@${allocated}`,
    'Tenant Entitled': `@coalesce(${tenant}?['capacity']?['entitled']?['value'], 0)`,
    'Tenant Prepaid Consumed': `@coalesce(${tenant}?['capacity']?['consumed']?['value'], 0)`,
    'Tenant PAYG Consumed': `@coalesce(${tenant}?['payGo']?['consumed']?['value'], 0)`,
    'Tenant Consumed Updated': `@{coalesce(${tenant}?['capacity']?['consumed']?['lastUpdatedOn'], '')}`,
    Status: `@{coalesce(${tenant}?['capacity']?['status'], '')}`,
  };
}

/**
 * The connection references a definition uses, from the connectors its actions name.
 * @param {any} definition
 */
export function connectorsUsed(definition) {
  const found = new Set();
  JSON.stringify(definition, (key, value) => {
    if (key === 'connectionName' && typeof value === 'string') found.add(value);
    return value;
  });
  return [...found].sort();
}

/**
 * The `clientdata` of a Dataverse `workflow` row for a cloud flow. Its connection references are
 * left unbound: the owner signs in to each when they first open the flow.
 * @param {any} definition
 */
export function flowClientData(definition) {
  const connectionReferences = Object.fromEntries(
    connectorsUsed(definition).map((name) => [name, { runtimeSource: 'embedded', connection: {}, api: { name } }]),
  );
  return JSON.stringify({ properties: { connectionReferences, definition }, schemaVersion: '1.0.0.0' });
}

/**
 * A flow to import by hand, for when it can't be created: the Power Automate import format.
 * @param {string} name
 * @param {any} definition
 * @param {string} note
 */
export function flowFile(name, definition, note) {
  return {
    $comment: note,
    name,
    connectors: connectorsUsed(definition).map((c) => Object.values(CONNECTORS).find((k) => k.name === c)?.label ?? c),
    definition,
  };
}
