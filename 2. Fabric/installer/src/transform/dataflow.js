// @ts-check
/**
 * The Dataflow Gen2 that pulls Cowork (Viva Insights) credits into the Lakehouse. It writes every
 * column as text into a staging table; Consumption_Ingest_Viva normalises it and merges it into
 * viva_credits_weekly, so history keeps accruing past Viva's six-month window.
 */

export const COWORK_DATAFLOW_TABLE = 'viva_credits_dataflow';
const QUERY = 'CoworkCredits';
const DESTINATION = `${QUERY}_DataDestination`;
// Query ids are local to the Dataflow. Fixed values keep updateDefinition from churning them.
const QUERY_ID = '5b1f3f0e-9c55-4a51-8a63-6f1c2f0a7c01';
const DESTINATION_ID = '5b1f3f0e-9c55-4a51-8a63-6f1c2f0a7c02';

/** Partition and query ids come from Viva Insights; they are GUIDs, so anything else is a typo. */
const VIVA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string | undefined} id */
export const isVivaId = (id) => !!id && VIVA_ID.test(id.trim());

/** @param {string} s  An M text literal. */
const m = (s) => `"${s.replace(/"/g, '""')}"`;

/**
 * @param {{ partitionId: string, queryId: string, workspaceId: string, lakehouseId: string }} o
 */
export function coworkMashup(o) {
  for (const [name, id] of /** @type {const} */ ([['Viva partition id', o.partitionId], ['Viva query id', o.queryId]])) {
    if (!isVivaId(id)) throw new Error(`The ${name} should be a GUID; got "${id}".`);
  }
  // Columns lose the characters a Lakehouse table rejects; values become text with ISO dates so
  // the notebook's to_date and casts read them the same way as a downloaded CSV.
  return `section Section1;
[DataDestinations = {[Definition = [Kind = "Reference", QueryName = "${DESTINATION}", IsNewTarget = true], Settings = [Kind = "Automatic", TypeSettings = [Kind = "Table"]]]}]
shared ${QUERY} = let
    Source = VivaInsights.Data(${m(o.partitionId.trim())}, "", ${m(o.queryId.trim())}, [SchemaType = "Pivoted", APIType = "Row-level data"]),
    Renamed = Table.TransformColumnNames(Source, each Text.Remove(_, {" ", ",", ";", "{", "}", "(", ")", "=", "/", "\\", "-"})),
    AsText = Table.TransformColumns(Renamed, {}, each if _ is null then null else if _ is date then Date.ToText(_, "yyyy-MM-dd") else if _ is datetime then DateTime.ToText(_, "yyyy-MM-dd") else if _ is datetimezone then DateTimeZone.ToText(_, "yyyy-MM-dd") else Text.From(_, "en-US")),
    Typed = Table.TransformColumnTypes(AsText, List.Transform(Table.ColumnNames(AsText), each {_, type text}))
in
    Typed;
shared ${DESTINATION} = let
    Pattern = Lakehouse.Contents([HierarchicalNavigation = null, CreateNavigationProperties = false, EnableFolding = false]),
    Navigation_1 = Pattern{[workspaceId = ${m(o.workspaceId)}]}[Data],
    Navigation_2 = Navigation_1{[lakehouseId = ${m(o.lakehouseId)}]}[Data],
    TableNavigation = Navigation_2{[Id = ${m(COWORK_DATAFLOW_TABLE)}, ItemKind = "Table"]}?[Data]?
in
    TableNavigation;
`;
}

/** @param {string} displayName */
export function coworkQueryMetadata(displayName) {
  return {
    formatVersion: '202502',
    computeEngineSettings: {},
    name: displayName,
    queryGroups: [],
    documentLocale: 'en-US',
    queriesMetadata: {
      // loadEnabled is "Enable staging": not needed, and it would double the capacity used.
      [QUERY]: { queryId: QUERY_ID, queryName: QUERY, loadEnabled: false },
      [DESTINATION]: { queryId: DESTINATION_ID, queryName: DESTINATION, isHidden: true, loadEnabled: false },
    },
    connections: [],
  };
}

/** @param {string} text */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * @param {string} displayName
 * @param {{ partitionId: string, queryId: string, workspaceId: string, lakehouseId: string }} o
 */
export function coworkDataflowDefinition(displayName, o) {
  const platform = {
    $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
    metadata: { type: 'Dataflow', displayName },
    config: { version: '2.0', logicalId: '00000000-0000-0000-0000-000000000000' },
  };
  return {
    parts: [
      { path: 'queryMetadata.json', payload: b64(JSON.stringify(coworkQueryMetadata(displayName), null, 2)), payloadType: 'InlineBase64' },
      { path: 'mashup.pq', payload: b64(coworkMashup(o)), payloadType: 'InlineBase64' },
      { path: '.platform', payload: b64(JSON.stringify(platform, null, 2)), payloadType: 'InlineBase64' },
    ],
  };
}
