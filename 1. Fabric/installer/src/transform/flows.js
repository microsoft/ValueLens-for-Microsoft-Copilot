// @ts-check
/**
 * The Power Automate cloud flows the installer can create: one saves product feedback exports
 * emailed to the admin, the other reads Copilot Studio credits from the Power Platform licensing
 * API each day. Both drop CSVs in the Lakehouse drop folder, where the pipeline's router picks
 * them up, so they need nothing the uploads don't.
 *
 * By default the flows write through an "HTTP with Microsoft Entra ID (preauthorized)" connection
 * to storage that a person signs in to: no secret, no Key Vault. With the `app` identity they
 * write as the installer's app registration instead, reading its secret from Key Vault at run time.
 * The writer only needs a DFS base URL, so the same flows can target OneLake or an ADLS container.
 */
import { UPLOAD_DIR } from '../uploads.js';

export const FEEDBACK_FLOW_NAME = 'Analytics Hub - Product feedback';
export const STUDIO_FLOW_NAME = 'Analytics Hub - Copilot Studio credits';
/** The subject the product feedback export is emailed under. */
export const FEEDBACK_SUBJECT = 'Copilot Product Feedback';
/** Days of credits each Studio flow run restates; the licensing API revises recent days. */
export const STUDIO_FLOW_DAYS = 10;
/** Days the first Studio flow run reads. The licensing API has kept about six months in practice. */
export const STUDIO_BACKFILL_DAYS = 180;
/** The Power Platform API, read as the flow's owner. Its licensing routes take delegated sign-ins only. */
export const PPAPI = 'https://api.powerplatform.com';
/** OneLake's ADLS Gen2 (DFS) endpoint, and the resource its tokens are for. */
export const ONELAKE_DFS = 'https://onelake.dfs.fabric.microsoft.com';
export const STORAGE_RESOURCE = 'https://storage.azure.com';
/** Where the flows keep their own state, outside the folders the pipeline reads. */
export const FLOW_STATE_DIR = 'Files/analytics_hub_flows';
/** Written once the Studio flow's first run has read the full history. */
export const BACKFILL_MARKER = 'studio_backfill_done';
const LICENSING_VERSION = '2024-10-01';
const STORAGE_VERSION = '2023-11-03';

const SCHEMA = 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';
const SECURE = { secureData: { properties: ['inputs', 'outputs'] } };
const SECURE_INPUTS = { secureData: { properties: ['inputs'] } };
const ANY = ['Succeeded', 'Failed', 'Skipped', 'TimedOut'];

/**
 * A connection reference the flows use, which the user signs in to once. Two references can share
 * a connector: each HTTP with Microsoft Entra ID connection holds a single resource.
 * @typedef {object} Connector
 * @property {string} name  The connection reference's key.
 * @property {string} api  The connector.
 * @property {string} label  What the user sees.
 */

/** @type {Record<'outlook' | 'keyVault' | 'entra' | 'storage', Connector>} */
export const CONNECTORS = {
  outlook: { name: 'shared_office365', api: 'shared_office365', label: 'Office 365 Outlook' },
  keyVault: { name: 'shared_keyvault', api: 'shared_keyvault', label: 'Azure Key Vault' },
  entra: { name: 'shared_webcontents', api: 'shared_webcontents', label: 'HTTP with Microsoft Entra ID (preauthorized), for the Power Platform API' },
  storage: { name: 'shared_webcontents_storage', api: 'shared_webcontents', label: 'HTTP with Microsoft Entra ID (preauthorized), for OneLake' },
};

/** @param {string} name  A connection reference key. */
export const connectorByName = (name) => Object.values(CONNECTORS).find((k) => k.name === name);

/**
 * Where and how a flow writes.
 * @typedef {object} FlowTarget
 * @property {'user' | 'app'} [identity]  user (default): a signed-in storage connection. app: the app registration.
 * @property {string} endpoint  DFS base, e.g. https://onelake.dfs.fabric.microsoft.com/{workspace}/{lakehouse}
 *   or https://{account}.dfs.core.windows.net/{container}. GUIDs for OneLake: it rejects a mix of a GUID and a name.
 * @property {string} [dropDir]  The drop folder under the endpoint. Default the Lakehouse's.
 * @property {string} [stateDir]  Where the flow keeps its state. Default {@link FLOW_STATE_DIR}.
 * @property {string} [tenantId]  The app identity's tenant, app and Key Vault secret.
 * @property {string} [clientId]
 * @property {string} [secretName]
 */

/**
 * The OneLake DFS base for a Lakehouse.
 * @param {string} workspaceId
 * @param {string} lakehouseId
 */
export const oneLakeEndpoint = (workspaceId, lakehouseId) => `${ONELAKE_DFS}/${workspaceId}/${lakehouseId}`;

/** @param {FlowTarget} t */
const asApp = (t) => t.identity === 'app';

/**
 * @param {Connector} connector
 * @param {string} operationId
 */
const host = (connector, operationId) => ({
  connectionName: connector.name,
  operationId,
  apiId: `/providers/Microsoft.PowerApps/apis/${connector.api}`,
});

/** @param {FlowTarget} t */
function getSecret(t) {
  return {
    type: 'OpenApiConnection',
    inputs: {
      host: host(CONNECTORS.keyVault, 'GetSecret'),
      parameters: { secretName: t.secretName },
      authentication: "@parameters('$authentication')",
    },
    runtimeConfiguration: SECURE,
  };
}

/** @param {FlowTarget} t */
const appAuth = (t) => ({
  type: 'ActiveDirectoryOAuth',
  authority: 'https://login.microsoftonline.com',
  tenant: t.tenantId,
  audience: `${STORAGE_RESOURCE}/`,
  clientId: t.clientId,
  secret: "@body('Get_client_secret')?['value']",
});

/** The Blob endpoint for a DFS base: the app writes block blobs, as before. @param {string} dfs */
const blobOf = (dfs) => dfs.replace('.dfs.', '.blob.');

/**
 * A call to storage through the signed-in connection.
 * @param {string} method
 * @param {string} url
 * @param {string} [body]
 */
function storageCall(method, url, body) {
  return {
    type: 'OpenApiConnection',
    inputs: {
      host: host(CONNECTORS.storage, 'InvokeHttp'),
      parameters: {
        'request/method': method,
        'request/url': url,
        'request/headers': { 'x-ms-version': STORAGE_VERSION, ...(body !== undefined ? { 'Content-Type': 'text/csv' } : {}) },
        ...(body !== undefined ? { 'request/body': body } : {}),
      },
      authentication: "@parameters('$authentication')",
    },
    runtimeConfiguration: SECURE_INPUTS,
  };
}

/**
 * Saves text to a file under the endpoint. As a user it creates the file then appends and flushes
 * the text (the DFS API: the connector sends text bodies, which suits CSV). As the app it writes
 * one block blob. The name is worked out once, so both calls hit the same file.
 * @param {FlowTarget} t
 * @param {string} name  The action's name; its steps are named after it.
 * @param {string} dir  Folder under the endpoint.
 * @param {string} fileName  Expression text, e.g. `@{...}`.
 * @param {string} body  Text expression.
 * @param {Record<string, string[]>} runAfter
 */
function saveFile(t, name, dir, fileName, body, runAfter) {
  if (asApp(t)) {
    return {
      [name]: {
        type: 'Http',
        runAfter,
        inputs: {
          method: 'PUT',
          uri: `${blobOf(t.endpoint)}/${dir}/${fileName}`,
          headers: { 'x-ms-version': STORAGE_VERSION, 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'text/csv' },
          body,
          authentication: appAuth(t),
        },
        runtimeConfiguration: SECURE_INPUTS,
      },
    };
  }
  const url = `${t.endpoint}/${dir}/@{outputs('${name}_path')}`;
  return {
    [name]: {
      type: 'Scope',
      runAfter,
      actions: {
        [`${name}_path`]: { type: 'Compose', runAfter: {}, inputs: fileName },
        [`${name}_create`]: { ...storageCall('PUT', `${url}?resource=file`), runAfter: { [`${name}_path`]: ['Succeeded'] } },
        [`${name}_write`]: {
          ...storageCall('PATCH', `${url}?action=append&position=0&flush=true`, body),
          runAfter: { [`${name}_create`]: ['Succeeded'] },
        },
      },
    },
  };
}

/**
 * Reads a file under the endpoint; the action fails when it isn't there.
 * @param {FlowTarget} t
 * @param {string} path
 */
function readFile(t, path) {
  if (asApp(t)) {
    return {
      type: 'Http',
      inputs: { method: 'GET', uri: `${blobOf(t.endpoint)}/${path}`, headers: { 'x-ms-version': STORAGE_VERSION }, authentication: appAuth(t) },
      runtimeConfiguration: SECURE_INPUTS,
    };
  }
  return storageCall('GET', `${t.endpoint}/${path}`);
}

/**
 * Creates an empty file under the endpoint.
 * @param {FlowTarget} t
 * @param {string} path
 */
function touchFile(t, path) {
  if (asApp(t)) {
    return {
      type: 'Http',
      inputs: {
        method: 'PUT',
        uri: `${blobOf(t.endpoint)}/${path}`,
        headers: { 'x-ms-version': STORAGE_VERSION, 'x-ms-blob-type': 'BlockBlob' },
        body: '',
        authentication: appAuth(t),
      },
      runtimeConfiguration: SECURE_INPUTS,
    };
  }
  return storageCall('PUT', `${t.endpoint}/${path}?resource=file`);
}

/**
 * The first actions of a flow: in app mode, the secret from Key Vault after `after`.
 * @param {FlowTarget} t
 * @param {Record<string, string[]>} runAfter
 * @returns {{ actions: Record<string, any>, next: Record<string, string[]> }}
 */
function secretStep(t, runAfter) {
  if (!asApp(t)) return { actions: {}, next: runAfter };
  return { actions: { Get_client_secret: { ...getSecret(t), runAfter } }, next: { Get_client_secret: ['Succeeded'] } };
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
  const secret = secretStep(t, {});
  return {
    $schema: SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: PARAMETERS,
    triggers: {
      When_a_new_email_arrives_V3: {
        type: 'OpenApiConnectionNotification',
        inputs: {
          host: host(CONNECTORS.outlook, 'OnNewEmailV3'),
          parameters: { folderPath: 'Inbox', subjectFilter: o.subject ?? FEEDBACK_SUBJECT, hasAttachments: true, includeAttachments: true, importance: 'Any' },
          authentication: "@parameters('$authentication')",
        },
        splitOn: "@triggerOutputs()?['body/value']",
      },
    },
    actions: {
      ...secret.actions,
      For_each_attachment: {
        type: 'Foreach',
        runAfter: secret.next,
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
            actions: saveFile(
              t,
              'Save_to_drop_folder',
              t.dropDir ?? UPLOAD_DIR,
              `@{utcNow('yyyyMMddHHmmss')}_@{encodeUriComponent(${item}?['name'])}`,
              asApp(t) ? `@base64ToBinary(${item}?['contentBytes'])` : `@base64ToString(${item}?['contentBytes'])`,
              {},
            ),
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
      host: host(CONNECTORS.entra, 'InvokeHttp'),
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

/** The next continuation token from a licensing page, or 'done'. Both casings and envelopes are seen. @param {string} page */
const nextToken = (page) => {
  const token = `coalesce(${page}?['continuationtoken'], ${page}?['continuationToken'], ${page}?['value']?[0]?['continuationToken'], '')`;
  return `@{if(empty(${token}), 'done', ${token})}`;
};

/** A JSON string literal for an expression, escaped: `"..."`. @param {string} expr */
const jsonString = (expr) => `substring(string(createArray(${expr})), 1, sub(length(string(createArray(${expr}))), 2))`;

/**
 * Reads Copilot Studio credits from the Power Platform licensing API once a day and drops CSVs the
 * router recognises: credits by agent and day, credits by user and day (best effort: the route is
 * newer), and the tenant entitlement with each environment's allocation. The first run reads about
 * six months; later runs restate the last ten days. The notebook turns them into the same tables
 * as the exports.
 * @param {FlowTarget} t
 * @param {{ time: string, timeZone: string }} schedule  The pipeline's, as HH:mm and a Windows time zone.
 */
export function studioFlowDefinition(t, schedule) {
  const v = `api-version=${LICENSING_VERSION}`;
  const page = "body('Get_agent_credits')";
  const resources = `coalesce(${page}?['value']?[0]?['resources'], ${page}?['value'], json('[]'))`;
  const userPage = "body('Get_user_credits')";
  const users = `coalesce(${userPage}?['value']?[0]?['users'], ${userPage}?['value'], json('[]'))`;
  const alloc = "body('Get_allocations')";
  const tenant = "body('Get_entitlement')?['entitlement']";
  const envs = "body('Get_environments')";
  const env = "items('For_each_environment')";
  const envName = `first(body('Find_environment'))`;
  const stamp = "@{utcNow('yyyyMMddHHmmss')}";
  const stateDir = t.stateDir ?? FLOW_STATE_DIR;
  const dropDir = t.dropDir ?? UPLOAD_DIR;
  const marker = `${stateDir}/${BACKFILL_MARKER}`;
  /** @param {string} name @param {'array' | 'string' | 'object'} type @param {any} value @param {string} [after] */
  const init = (name, type, value, after) => ({
    type: 'InitializeVariable',
    runAfter: after ? { [after]: ['Succeeded'] } : {},
    inputs: { variables: [{ name, type, value }] },
  });
  const secret = secretStep(t, { Env_names: ['Succeeded'] });
  // Environment GUID -> display name, so each agent row carries its environment's name.
  const envKey = "toLower(last(split(coalesce(item()?['id'], item()?['name'], ''), '/')))";
  const envDisplay = "coalesce(item()?['displayName'], item()?['properties']?['displayName'], '')";
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
      Agent_rows: init('AgentRows', 'array', []),
      Token: init('Token', 'string', '', 'Agent_rows'),
      Day: init('Day', 'string', '', 'Token'),
      User_rows: init('UserRows', 'array', [], 'Day'),
      User_token: init('UserToken', 'string', '', 'User_rows'),
      User_day: init('UserDay', 'string', '', 'User_token'),
      Env_names: init('EnvNames', 'object', {}, 'User_day'),
      ...secret.actions,
      Get_environments: { ...ppApi(`/environmentmanagement/environments?${v}`), runAfter: secret.next },
      Env_pairs: {
        type: 'Select',
        runAfter: { Get_environments: ['Succeeded'] },
        inputs: { from: `@coalesce(${envs}?['value'], json('[]'))`, select: `@concat(${jsonString(envKey)}, ':', ${jsonString(envDisplay)})` },
      },
      Set_env_names: {
        type: 'SetVariable',
        runAfter: { Env_pairs: ['Succeeded'] },
        inputs: { name: 'EnvNames', value: "@json(concat('{', join(body('Env_pairs'), ','), '}'))" },
      },
      // Missing on the first run, so that run reads the full history.
      Check_backfill: { ...readFile(t, marker), runAfter: { Set_env_names: ANY } },
      Days: {
        type: 'InitializeVariable',
        runAfter: { Check_backfill: ['Succeeded', 'Failed', 'TimedOut'] },
        inputs: {
          variables: [
            {
              name: 'Days',
              type: 'integer',
              // A refused read (401, 403) is a sign-in problem, not a first run: don't re-read six months.
              value: `@if(or(equals(actions('Check_backfill')?['status'], 'Succeeded'), contains(createArray(401, 403), outputs('Check_backfill')?['statusCode'])), ${STUDIO_FLOW_DAYS}, ${STUDIO_BACKFILL_DAYS})`,
            },
          ],
        },
      },
      // One day per call keeps the daily grain; pages of 5,000 stay stable on busy days.
      For_each_day: {
        type: 'Foreach',
        runAfter: { Days: ['Succeeded'] },
        foreach: "@range(1, variables('Days'))",
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
                    'Environment Name': "@coalesce(variables('EnvNames')?[toLower(coalesce(item()?['environmentId'], ''))], '')",
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
              Next_page: { type: 'SetVariable', runAfter: { Keep_rows: ['Succeeded'] }, inputs: { name: 'Token', value: nextToken(page) } },
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
        runAfter: { For_each_day: ANY },
        inputs: { from: "@variables('AgentRows')", format: 'CSV' },
      },
      Any_agent_credits: {
        type: 'If',
        runAfter: { Agent_CSV: ['Succeeded'] },
        expression: { greater: ["@length(variables('AgentRows'))", 0] },
        actions: saveFile(t, 'Save_agent_credits', dropDir, `StudioApiAgentDaily_${stamp}.csv`, "@body('Agent_CSV')", {}),
        else: { actions: {} },
      },
      // Once the history is saved, later runs read ten days.
      Mark_backfill_done: {
        type: 'If',
        runAfter: { Any_agent_credits: ['Succeeded'] },
        expression: { greater: ["@variables('Days')", STUDIO_FLOW_DAYS] },
        actions: { Save_backfill_marker: { ...touchFile(t, marker), runAfter: {} } },
        else: { actions: {} },
      },
      // Credits by user. The route is newer than the others, so it is best effort: when it isn't
      // there, this scope fails and the entitlement is still read and saved.
      Per_user_credits: {
        type: 'Scope',
        runAfter: { Mark_backfill_done: ANY },
        actions: {
          Check_users: {
            ...ppApi(`/licensing/entitlements/MCSMessages/users?${v}&fromDate=@{formatDateTime(addDays(utcNow(), -1), 'yyyy-MM-dd')}&toDate=@{formatDateTime(addDays(utcNow(), -1), 'yyyy-MM-dd')}&pageSize=1`),
            runAfter: {},
          },
          For_each_user_day: {
            type: 'Foreach',
            runAfter: { Check_users: ['Succeeded'] },
            foreach: "@range(1, variables('Days'))",
            runtimeConfiguration: { concurrency: { repetitions: 1 } },
            actions: {
              Set_user_day: {
                type: 'SetVariable',
                runAfter: {},
                inputs: { name: 'UserDay', value: "@{formatDateTime(addDays(utcNow(), mul(-1, items('For_each_user_day'))), 'yyyy-MM-dd')}" },
              },
              Reset_user_token: { type: 'SetVariable', runAfter: { Set_user_day: ['Succeeded'] }, inputs: { name: 'UserToken', value: '' } },
              Each_user_page: {
                type: 'Until',
                runAfter: { Reset_user_token: ['Succeeded'] },
                expression: "@equals(variables('UserToken'), 'done')",
                limit: { count: 50, timeout: 'PT1H' },
                actions: {
                  Get_user_credits: {
                    ...ppApi(
                      `/licensing/entitlements/MCSMessages/users?${v}&fromDate=@{variables('UserDay')}&toDate=@{variables('UserDay')}&pageSize=5000@{if(empty(variables('UserToken')), '', concat('&continuationToken=', encodeUriComponent(variables('UserToken'))))}`,
                    ),
                    runAfter: {},
                  },
                  // A row with no user would add up other people's credits under nobody.
                  With_user: {
                    type: 'Query',
                    runAfter: { Get_user_credits: ['Succeeded'] },
                    inputs: { from: `@${users}`, where: "@not(empty(coalesce(item()?['userId'], '')))" },
                  },
                  User_page_rows: {
                    type: 'Select',
                    runAfter: { With_user: ['Succeeded'] },
                    inputs: {
                      from: "@body('With_user')",
                      select: {
                        'Usage Date': "@variables('UserDay')",
                        'User Id': "@item()?['userId']",
                        'Environment Id': "@item()?['environmentId']",
                        'Agent Id': "@item()?['resourceId']",
                        'Billed credit': "@item()?['consumed']",
                        'Non-billed credit': "@item()?['metadata']?['NonBillableQuantity']",
                        Unit: "@item()?['unit']",
                      },
                    },
                  },
                  Add_user_rows: {
                    type: 'Compose',
                    runAfter: { User_page_rows: ['Succeeded'] },
                    inputs: "@union(variables('UserRows'), body('User_page_rows'))",
                  },
                  Keep_user_rows: { type: 'SetVariable', runAfter: { Add_user_rows: ['Succeeded'] }, inputs: { name: 'UserRows', value: "@outputs('Add_user_rows')" } },
                  Next_user_page: { type: 'SetVariable', runAfter: { Keep_user_rows: ['Succeeded'] }, inputs: { name: 'UserToken', value: nextToken(userPage) } },
                  Stop_user_paging: {
                    type: 'SetVariable',
                    runAfter: { Get_user_credits: ['Failed', 'TimedOut'] },
                    inputs: { name: 'UserToken', value: 'done' },
                  },
                },
              },
            },
          },
          User_CSV: {
            type: 'Table',
            runAfter: { For_each_user_day: ANY },
            inputs: { from: "@variables('UserRows')", format: 'CSV' },
          },
          Any_user_credits: {
            type: 'If',
            runAfter: { User_CSV: ['Succeeded'] },
            expression: { greater: ["@length(variables('UserRows'))", 0] },
            actions: saveFile(t, 'Save_user_credits', dropDir, `StudioApiUserDaily_${stamp}.csv`, "@body('User_CSV')", {}),
            else: { actions: {} },
          },
        },
      },
      Get_entitlement: { ...ppApi(`/licensing/entitlements/MCSMessages?${v}`), runAfter: { Per_user_credits: ANY } },
      // Without the tenant entitlement there is no snapshot: zeros would read as all pay-as-you-go.
      Get_allocations: { ...ppApi(`/licensing/allocationsByEnvironment?${v}`), runAfter: { Get_entitlement: ['Succeeded'] } },
      Entitlement_rows: {
        type: 'InitializeVariable',
        runAfter: { Get_allocations: ['Succeeded', 'Failed', 'TimedOut'] },
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
        runAfter: { For_each_environment: ANY },
        inputs: { from: "@variables('EntitlementRows')", format: 'CSV' },
      },
      ...saveFile(t, 'Save_entitlement', dropDir, `StudioApiEntitlement_${stamp}.csv`, "@body('Entitlement_CSV')", { Entitlement_CSV: ['Succeeded'] }),
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
 * The `clientdata` of a Dataverse `workflow` row for a cloud flow. Connection references are left
 * unbound, for the owner to sign in to, unless `keep` has a binding for the same reference and
 * connector: an update then keeps the sign-in.
 * @param {any} definition
 * @param {Record<string, any>} [keep]  The current flow's connection references.
 */
export function flowClientData(definition, keep = {}) {
  const connectionReferences = Object.fromEntries(
    connectorsUsed(definition).map((name) => {
      const api = connectorByName(name)?.api ?? name;
      const old = keep[name];
      const bound = old && (old.api?.name ?? api) === api && old.connection && Object.keys(old.connection).length;
      return [name, bound ? old : { runtimeSource: 'embedded', connection: {}, api: { name: api } }];
    }),
  );
  return JSON.stringify({ properties: { connectionReferences, definition }, schemaVersion: '1.0.0.0' });
}

/**
 * The connection references in a flow's `clientdata`.
 * @param {string | undefined} clientdata
 * @returns {Record<string, any>}
 */
export function connectionReferencesOf(clientdata) {
  try {
    return JSON.parse(clientdata ?? '{}')?.properties?.connectionReferences ?? {};
  } catch {
    return {};
  }
}

/**
 * Connections in `definition` the user still has to sign in to, given the flow's current references.
 * @param {any} definition
 * @param {Record<string, any>} current
 */
export function newConnections(definition, current) {
  return connectorsUsed(definition).filter((name) => {
    const old = current[name];
    return !(old && old.connection && Object.keys(old.connection).length && (old.api?.name ?? connectorByName(name)?.api) === connectorByName(name)?.api);
  });
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
    connectors: connectorsUsed(definition).map((c) => connectorByName(c)?.label ?? c),
    definition,
  };
}
