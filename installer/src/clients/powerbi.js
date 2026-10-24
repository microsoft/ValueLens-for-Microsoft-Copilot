// @ts-check
/** Power BI REST API calls for semantic model data sources and refreshes. */

/** @param {import('../http.js').HttpClient} http */
export function powerBiApi(http) {
  return {
    /** @param {string} workspaceId @param {string} datasetId @returns {Promise<any[]>} */
    datasources: async (workspaceId, datasetId) => (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/datasources`))?.value ?? [],
    /** @returns {Promise<any[]>} */
    groups: async () => (await http.get('/groups'))?.value ?? [],
    /** Creates a workspace. Not sent twice, since a retry could make a second. @param {string} name */
    createGroup: (name) => http.post('/groups', { name }, { query: { workspaceV2: 'True' }, once: true }),
    /** Deletes a workspace and everything in it. @param {string} workspaceId */
    deleteGroup: (workspaceId) => http.del(`/groups/${workspaceId}`),
    /** @param {string} workspaceId @param {{ identifier: string, principalType: 'App' | 'User' | 'Group', groupUserAccessRight: 'Admin' | 'Member' | 'Contributor' | 'Viewer' }} body */
    addGroupUser: (workspaceId, body) => http.post(`/groups/${workspaceId}/users`, body),
    /** The workspace's semantic models, with id and name. @param {string} workspaceId @returns {Promise<any[]>} */
    datasets: async (workspaceId) => (await http.get(`/groups/${workspaceId}/datasets`))?.value ?? [],
    /** The workspace's reports, with id, name and datasetId. @param {string} workspaceId @returns {Promise<any[]>} */
    reports: async (workspaceId) => (await http.get(`/groups/${workspaceId}/reports`))?.value ?? [],
    /** Deletes a semantic model. @param {string} workspaceId @param {string} datasetId */
    deleteDataset: (workspaceId, datasetId) => http.del(`/groups/${workspaceId}/datasets/${datasetId}`),
    /** Deletes a report. @param {string} workspaceId @param {string} reportId */
    deleteReport: (workspaceId, reportId) => http.del(`/groups/${workspaceId}/reports/${reportId}`),
    /**
     * Starts a standard refresh, the kind a Pro workspace has, and returns its request ID when Power BI gives one.
     * @param {string} workspaceId @param {string} datasetId
     * @returns {Promise<string | undefined>}
     */
    async refreshNow(workspaceId, datasetId) {
      const res = await http.request('POST', `/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { body: { notifyOption: 'NoNotification' } });
      return res.headers.get('requestid') ?? undefined;
    },
    /** Who has direct access to a semantic model. @param {string} workspaceId @param {string} datasetId @returns {Promise<any[]>} */
    datasetUsers: async (workspaceId, datasetId) => (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/users`))?.value ?? [],
    /**
     * Grants a principal access to a semantic model. ReadExplore is Read plus Build.
     * @param {string} workspaceId @param {string} datasetId
     * @param {{ identifier: string, principalType: 'User' | 'Group' | 'App', datasetUserAccessRight: 'Read' | 'ReadExplore' | 'ReadReshare' | 'ReadReshareExplore' }} body
     */
    addDatasetUser: (workspaceId, datasetId, body) => http.post(`/groups/${workspaceId}/datasets/${datasetId}/users`, body),
    /** The model's refresh schedule: enabled, days, times and time zone. @param {string} workspaceId @param {string} datasetId @returns {Promise<any>} */
    refreshSchedule: (workspaceId, datasetId) => http.get(`/groups/${workspaceId}/datasets/${datasetId}/refreshSchedule`),
    /** @param {string} workspaceId @param {string} datasetId @param {any} body */
    setRefreshSchedule: (workspaceId, datasetId, body) => http.patch(`/groups/${workspaceId}/datasets/${datasetId}/refreshSchedule`, body),
    /** @param {string} gatewayId @param {string} datasourceId @param {any} body */
    updateDatasource: (gatewayId, datasourceId, body) => http.patch(`/gateways/${gatewayId}/datasources/${datasourceId}`, body),
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
