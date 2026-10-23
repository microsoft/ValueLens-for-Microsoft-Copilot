// @ts-check
/** Power BI REST API calls for semantic model data sources and refreshes. */

/** @param {import('../http.js').HttpClient} http */
export function powerBiApi(http) {
  return {
    /** @param {string} workspaceId @param {string} datasetId @returns {Promise<any[]>} */
    datasources: async (workspaceId, datasetId) => (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/datasources`))?.value ?? [],
    /** @returns {Promise<any[]>} */
    groups: async () => (await http.get('/groups'))?.value ?? [],
    /** @param {string} name */
    createGroup: (name) => http.post('/groups', { name }),
    /** Deletes a workspace and everything in it. @param {string} workspaceId */
    deleteGroup: (workspaceId) => http.del(`/groups/${workspaceId}`),
    /** @param {string} workspaceId @param {{ identifier: string, principalType: 'App' | 'User' | 'Group', groupUserAccessRight: 'Admin' | 'Member' | 'Contributor' | 'Viewer' }} body */
    addGroupUser: (workspaceId, body) => http.post(`/groups/${workspaceId}/users`, body),
    /** Who has direct access to a semantic model. @param {string} workspaceId @param {string} datasetId @returns {Promise<any[]>} */
    datasetUsers: async (workspaceId, datasetId) => (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/users`))?.value ?? [],
    /**
     * Grants a principal access to a semantic model. ReadExplore is Read plus Build.
     * @param {string} workspaceId @param {string} datasetId
     * @param {{ identifier: string, principalType: 'User' | 'Group' | 'App', datasetUserAccessRight: 'Read' | 'ReadExplore' | 'ReadReshare' | 'ReadReshareExplore' }} body
     */
    addDatasetUser: (workspaceId, datasetId, body) => http.post(`/groups/${workspaceId}/datasets/${datasetId}/users`, body),
    /** @param {string} workspaceId @param {string} datasetId @param {any} body */
    setRefreshSchedule: (workspaceId, datasetId, body) => http.patch(`/groups/${workspaceId}/datasets/${datasetId}/refreshSchedule`, body),
    /** @param {string} gatewayId @param {string} datasourceId @param {any} body */
    updateDatasource: (gatewayId, datasourceId, body) => http.patch(`/gateways/${gatewayId}/datasources/${datasourceId}`, body),
    /**
     * Points a dataset at a gateway connection (VNet data gateway in private mode).
     * @param {string} workspaceId @param {string} datasetId @param {{ gatewayObjectId: string, datasourceObjectIds: string[] }} body
     */
    bindToGateway: (workspaceId, datasetId, body) => http.post(`/groups/${workspaceId}/datasets/${datasetId}/Default.BindToGateway`, body),
    /**
     * Starts an enhanced refresh and returns its request ID.
     * @param {string} workspaceId
     * @param {string} datasetId
     * @param {any} body
     */
    async refresh(workspaceId, datasetId, body) {
      const res = await http.request('POST', `/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { body });
      const location = res.headers.get('location') ?? '';
      const requestId = location.split('/').filter(Boolean).pop() ?? res.headers.get('requestid');
      if (!requestId) throw new Error('Power BI started the refresh but returned no request ID to follow.');
      return requestId;
    },
    /** @param {string} workspaceId @param {string} datasetId @param {string} requestId */
    getRefresh: (workspaceId, datasetId, requestId) => http.get(`/groups/${workspaceId}/datasets/${datasetId}/refreshes/${requestId}`),
    /** @param {string} workspaceId @param {string} datasetId @param {number} [top] @returns {Promise<any[]>} */
    refreshes: async (workspaceId, datasetId, top = 5) =>
      (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { query: { $top: top } }))?.value ?? [],
    /**
     * Runs a DAX query. With `impersonatedUserName`, it runs as that person, under their row-level security.
     * @param {string} workspaceId @param {string} datasetId @param {string} query
     * @param {{ impersonatedUserName?: string }} [opts]
     * @returns {Promise<any>}
     */
    executeQueries: (workspaceId, datasetId, query, opts = {}) =>
      http.post(`/groups/${workspaceId}/datasets/${datasetId}/executeQueries`, {
        queries: [{ query }],
        serializerSettings: { includeNulls: true },
        ...(opts.impersonatedUserName ? { impersonatedUserName: opts.impersonatedUserName } : {}),
      }),
  };
}

/** @typedef {ReturnType<typeof powerBiApi>} PowerBiApi */
