// @ts-check
/**
 * The Power Automate cloud flows the installer can create: one saves product feedback exports
 * emailed to the admin, the other reads the Power Platform agent inventory each day. Both save
 * files in the Lakehouse, where the pipeline picks them up, so they need nothing the uploads don't.
 *
 * By default the flows write through an "HTTP with Microsoft Entra ID (preauthorized)" connection
 * to storage that a person signs in to: no secret, no Key Vault. With the `app` identity they
 * write as the installer's app registration instead, reading its secret from Key Vault at run time.
 * The writer only needs a DFS base URL. A target can name a SharePoint folder instead, which they
 * write through the SharePoint connector.
 */
import { PRODUCT } from '../product.js';
import { UPLOAD_DIR } from '../uploads.js';

export const FEEDBACK_FLOW_NAME = PRODUCT.flows.feedback;
export const AGENT_INVENTORY_FLOW_NAME = PRODUCT.flows.agentInventory;
/** Where the agent inventory flow saves on a Lakehouse; the notebook reads the newest file there. */
export const AGENT_INVENTORY_DIR = 'Files/arg_inventory';
/** The Power Platform inventory types the Resource Graph collector reads. */
export const INVENTORY_TYPES = ['microsoft.copilotstudio/agents', 'microsoft.powerplatform/environments', 'microsoft.powerautomate/agentflows'];
const INVENTORY_VERSION = '2024-10-01';
/** The subject the product feedback export is emailed under. */
export const FEEDBACK_SUBJECT = 'Copilot Product Feedback';
/** The Power Platform API, read as the flow's owner: its inventory route takes delegated sign-ins only. */
export const PPAPI = 'https://api.powerplatform.com';
/** OneLake's ADLS Gen2 (DFS) endpoint, and the resource its tokens are for. */
export const ONELAKE_DFS = 'https://onelake.dfs.fabric.microsoft.com';
export const STORAGE_RESOURCE = 'https://storage.azure.com';
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

/** @type {Record<'outlook' | 'keyVault' | 'entra' | 'storage' | 'sharePoint', Connector>} */
export const CONNECTORS = {
  outlook: { name: 'shared_office365', api: 'shared_office365', label: 'Office 365 Outlook' },
  keyVault: { name: 'shared_keyvault', api: 'shared_keyvault', label: 'Azure Key Vault' },
  entra: { name: 'shared_webcontents', api: 'shared_webcontents', label: 'HTTP with Microsoft Entra ID (preauthorized), for the Power Platform API' },
  storage: { name: 'shared_webcontents_storage', api: 'shared_webcontents', label: 'HTTP with Microsoft Entra ID (preauthorized), for OneLake' },
  sharePoint: { name: 'shared_sharepointonline', api: 'shared_sharepointonline', label: 'SharePoint' },
};

/** @param {string} name  A connection reference key. */
export const connectorByName = (name) => Object.values(CONNECTORS).find((k) => k.name === name);

/**
 * The words that end the name of each action using an HTTP with Microsoft Entra ID connection, by
 * connection reference. Both connections use the same connector and look alike in the designer, so
 * the name is how the user tells which one a card needs.
 * @param {{ endpoint?: string }} t
 * @returns {Record<string, string>}
 */
const connectionSuffixes = (t) => ({
  [CONNECTORS.entra.name]: 'via_Power_Platform_API',
  [CONNECTORS.storage.name]: /\.fabric\.microsoft\.com/i.test(t.endpoint ?? '') ? 'via_OneLake' : 'via_Azure_Storage',
});

/**
 * Renames each action that uses one of the two HTTP with Microsoft Entra ID connections after the
 * connection, e.g. Get_agent_credits_via_Power_Platform_API, and updates the references to it.
 * @param {any} def  A flow definition.
 * @param {{ endpoint?: string }} t
 */
export function nameByConnection(def, t) {
  const suffixes = connectionSuffixes(t);
  /** @type {Map<string, string>} */
  const renames = new Map();
  /** @param {any} actions */
  const collect = (actions) => {
    for (const [name, a] of Object.entries(actions ?? {})) {
      const suffix = suffixes[a.inputs?.host?.connectionName];
      if (suffix) renames.set(name, `${name}_${suffix}`);
      collect(a.actions);
      collect(a.else?.actions);
    }
  };
  collect(def.actions);
  if (!renames.size) return def;
  const quoted = new RegExp(`'(${[...renames.keys()].join('|')})'`, 'g');
  /** @param {any} v @returns {any} */
  const rename = (v) => {
    if (typeof v === 'string') return v.replace(quoted, (_, n) => `'${renames.get(n)}'`);
    if (Array.isArray(v)) return v.map(rename);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [renames.get(k) ?? k, rename(x)]));
    return v;
  };
  return rename(def);
}

/**
 * Where and how a flow writes.
 * @typedef {object} FlowTarget
 * @property {'user' | 'app'} [identity]  user (default): a signed-in storage connection. app: the app registration.
 * @property {string} endpoint  DFS base, e.g. https://onelake.dfs.fabric.microsoft.com/{workspace}/{lakehouse}
 *   or https://{account}.dfs.core.windows.net/{container}. GUIDs for OneLake: it rejects a mix of a GUID and a name.
 * @property {string} [dropDir]  The drop folder under the endpoint. Default the Lakehouse's.
 * @property {{ siteUrl: string, folder: string }} [sharePoint]  Write to this SharePoint folder (its
 *   server-relative path, e.g. /sites/Analytics/Shared Documents/ValueLens) instead of the endpoint. User identity only.
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
const asApp = (t) => t.identity === 'app' && !t.sharePoint;

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
 * @param {string} [contentType]
 */
function storageCall(method, url, body, contentType = 'text/csv') {
  return {
    type: 'OpenApiConnection',
    inputs: {
      host: host(CONNECTORS.storage, 'InvokeHttp'),
      parameters: {
        'request/method': method,
        'request/url': url,
        'request/headers': { 'x-ms-version': STORAGE_VERSION, ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
        ...(body !== undefined ? { 'request/body': body } : {}),
      },
      authentication: "@parameters('$authentication')",
    },
    runtimeConfiguration: SECURE_INPUTS,
  };
}

/**
 * A SharePoint connector call on the target's site.
 * @param {FlowTarget} t
 * @param {string} operationId
 * @param {Record<string, any>} parameters
 */
function sharePointCall(t, operationId, parameters) {
  return {
    type: 'OpenApiConnection',
    inputs: {
      host: host(CONNECTORS.sharePoint, operationId),
      parameters: { dataset: t.sharePoint?.siteUrl, ...parameters },
      authentication: "@parameters('$authentication')",
    },
    runtimeConfiguration: SECURE_INPUTS,
  };
}

/** A folder under the target's SharePoint folder. @param {FlowTarget} t @param {string} dir */
const sharePointFolder = (t, dir) => `${String(t.sharePoint?.folder).replace(/\/+$/, '')}/${dir}`;

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
 * @param {string} [contentType]
 */
function saveFile(t, name, dir, fileName, body, runAfter, contentType = 'text/csv') {
  if (t.sharePoint) {
    return { [name]: { ...sharePointCall(t, 'CreateFile', { folderPath: sharePointFolder(t, dir), name: fileName, body }), runAfter } };
  }
  if (asApp(t)) {
    return {
      [name]: {
        type: 'Http',
        runAfter,
        inputs: {
          method: 'PUT',
          uri: `${blobOf(t.endpoint)}/${dir}/${fileName}`,
          headers: { 'x-ms-version': STORAGE_VERSION, 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType },
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
          ...storageCall('PATCH', `${url}?action=append&position=0&flush=true`, body, contentType),
          runAfter: { [`${name}_create`]: ['Succeeded'] },
        },
      },
    },
  };
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

/**
 * @param {string} path  A Power Platform API path and query, with expressions.
 * @param {any} [body]  A JSON body: the call is then a POST.
 */
function ppApi(path, body) {
  return {
    type: 'OpenApiConnection',
    inputs: {
      host: host(CONNECTORS.entra, 'InvokeHttp'),
      parameters:
        body === undefined
          ? { 'request/method': 'GET', 'request/url': `${PPAPI}${path}` }
          : { 'request/method': 'POST', 'request/url': `${PPAPI}${path}`, 'request/headers': { 'Content-Type': 'application/json' }, 'request/body': body },
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
 * Reads the Power Platform inventory (Copilot Studio agents, environments and agent flows) once a
 * day and saves its pages as one JSON file, for when Azure Resource Graph won't give the app or
 * managed identity the agents. The inventory API takes delegated sign-ins only, so it reads as the
 * flow's owner.
 * @param {FlowTarget} t
 * @param {{ time: string, timeZone: string }} schedule  The pipeline's, as HH:mm and a Windows time zone.
 * @param {string} dir  Folder under the endpoint the collector reads.
 */
export function agentInventoryFlowDefinition(t, schedule, dir) {
  const page = "body('Get_inventory')";
  const token = `coalesce(${page}?['skipToken'], ${page}?['$skipToken'], ${page}?['SkipToken'], '')`;
  const secret = secretStep(t, { Pages: ['Succeeded'] });
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
      Skip_token: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'SkipToken', type: 'string', value: '' }] } },
      Pages: { type: 'InitializeVariable', runAfter: { Skip_token: ['Succeeded'] }, inputs: { variables: [{ name: 'Pages', type: 'array', value: [] }] } },
      ...secret.actions,
      Each_page: {
        type: 'Until',
        runAfter: secret.next,
        expression: "@equals(variables('SkipToken'), 'done')",
        limit: { count: 100, timeout: 'PT1H' },
        actions: {
          Get_inventory: {
            ...ppApi(`/resourcequery/resources/query?api-version=${INVENTORY_VERSION}`, {
              TableName: 'PowerPlatformResources',
              Clauses: [{ $type: 'where', FieldName: 'type', Operator: 'in~', Values: INVENTORY_TYPES.map((v) => `'${v}'`) }],
              Options: { Top: 1000, Skip: 0, SkipToken: "@{variables('SkipToken')}" },
            }),
            runAfter: {},
          },
          Keep_page: { type: 'AppendToArrayVariable', runAfter: { Get_inventory: ['Succeeded'] }, inputs: { name: 'Pages', value: `@${page}` } },
          Next_page: { type: 'SetVariable', runAfter: { Keep_page: ['Succeeded'] }, inputs: { name: 'SkipToken', value: `@{if(empty(${token}), 'done', ${token})}` } },
          // A refused or failed page ends the paging; what was read is still saved.
          Stop_paging: { type: 'SetVariable', runAfter: { Get_inventory: ['Failed', 'TimedOut'] }, inputs: { name: 'SkipToken', value: 'done' } },
        },
      },
      Any_pages: {
        type: 'If',
        runAfter: { Each_page: ANY },
        expression: { greater: ["@length(variables('Pages'))", 0] },
        actions: saveFile(t, 'Save_inventory', dir, "@{utcNow('yyyyMMddHHmmss')}_agent_inventory.json", "@{string(variables('Pages'))}", {}, 'application/json'),
        else: { actions: {} },
      },
    },
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
 * Whether a connection reference is signed in to. The installer leaves `connection: {}`; a
 * sign-in in the designer fills it with `connectionName` (and `id`), or with
 * `connectionReferenceLogicalName` in a solution.
 * @param {any} ref
 */
export function isBound(ref) {
  const c = ref?.connection;
  return !!c && ['connectionName', 'connectionReferenceLogicalName', 'name', 'id'].some((k) => typeof c[k] === 'string' && c[k] !== '');
}

/** The connector a reference points at: `api.name`, or the last part of `api.id`. @param {any} ref */
function refApi(ref) {
  return ref?.api?.name ?? (typeof ref?.api?.id === 'string' ? ref.api.id.split('/').pop() : undefined);
}

/**
 * The signed-in reference to keep for `name`: the one with that name, for the same connector.
 * Only the name matches: two references can share a connector with different sign-ins (the
 * Power Platform API and storage both use HTTP with Microsoft Entra ID).
 * @param {string} name
 * @param {Record<string, any>} keep
 */
function keptBinding(name, keep) {
  const api = connectorByName(name)?.api ?? name;
  const ref = keep[name];
  return isBound(ref) && (refApi(ref) ?? api) === api ? ref : undefined;
}

/**
 * The `clientdata` of a Dataverse `workflow` row for a cloud flow. Connection references are left
 *  unbound, for the owner to sign in to, unless `keep` has a binding for the same reference and
  * connector: an update then keeps the sign-in.
 * @param {any} definition
 * @param {Record<string, any>} [keep]  The current flow's connection references.
 */
export function flowClientData(definition, keep = {}) {
  const connectionReferences = Object.fromEntries(
    connectorsUsed(definition).map((name) => {
      const api = connectorByName(name)?.api ?? name;
      return [name, keptBinding(name, keep) ?? { runtimeSource: 'embedded', connection: {}, api: { name: api } }];
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
  return connectorsUsed(definition).filter((name) => !keptBinding(name, current));
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
