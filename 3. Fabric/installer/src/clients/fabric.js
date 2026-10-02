// @ts-check
/** Fabric REST API calls the installer needs. */

/** @param {string} text */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** @param {string} ipynb */
export function notebookDefinition(ipynb) {
  return {
    format: 'ipynb',
    parts: [{ path: 'notebook-content.ipynb', payload: b64(ipynb), payloadType: 'InlineBase64' }],
  };
}

/** @param {any} pipeline */
export function pipelineDefinition(pipeline) {
  return {
    parts: [{ path: 'pipeline-content.json', payload: b64(JSON.stringify(pipeline, null, 2)), payloadType: 'InlineBase64' }],
  };
}

/**
 * Converts installer job parameters into Fabric's typed form.
 * @param {Record<string, string | number | boolean>} params
 */
export function notebookJobParameters(params) {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      { value, type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'string' },
    ]),
  );
}

/**
 * @typedef {{ frequency: 'daily' | 'weekly', time: string, weekday: string, timeZone: string }} ScheduleChoice
 */

/**
 * Body for the job scheduler. Starts tomorrow so it never collides with the first load.
 * @param {ScheduleChoice} schedule
 * @param {Date} [now]
 */
export function scheduleBody(schedule, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const end = new Date(Date.UTC(now.getUTCFullYear() + 10, now.getUTCMonth(), now.getUTCDate()));
  const iso = (/** @type {Date} */ d) => d.toISOString().replace(/\.\d{3}Z$/, '');
  /** @type {Record<string, any>} */
  const configuration = {
    startDateTime: iso(start),
    endDateTime: iso(end),
    localTimeZoneId: schedule.timeZone,
    type: schedule.frequency === 'weekly' ? 'Weekly' : 'Daily',
    times: [schedule.time],
  };
  if (schedule.frequency === 'weekly') configuration.weekdays = [schedule.weekday];
  return { enabled: true, configuration };
}

/** @param {import('../http.js').HttpClient} http */
export function fabricApi(http) {
  return {
    listCapacities: () => http.list('/capacities'),
    listWorkspaces: () => http.list('/workspaces'),
    /** @param {string} id */
    getWorkspace: (id) => http.get(`/workspaces/${id}`),
    /** @param {string} displayName @param {string} capacityId */
    createWorkspace: (displayName, capacityId) =>
      http.post('/workspaces', { displayName, capacityId, description: 'ValueLens: Copilot usage and value data.' }),
    /** @param {string} workspaceId @param {string} capacityId */
    assignToCapacity: (workspaceId, capacityId) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/assignToCapacity`, { body: { capacityId } }),

    /** @param {string} workspaceId @param {string} [type] */
    listItems: (workspaceId, type) => http.list(`/workspaces/${workspaceId}/items`, { query: { type } }),
    /** @param {string} workspaceId @param {string} itemId */
    getItem: (workspaceId, itemId) => http.get(`/workspaces/${workspaceId}/items/${itemId}`),

    /** @param {string} workspaceId @param {string} id */
    getLakehouse: (workspaceId, id) => http.get(`/workspaces/${workspaceId}/lakehouses/${id}`),
    /** @param {string} workspaceId @param {string} displayName */
    createLakehouse: (workspaceId, displayName) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/lakehouses`, {
        body: { displayName, description: 'ValueLens tables.', creationPayload: { enableSchemas: true } },
        lroResult: true,
      }),

    /** @param {string} workspaceId @param {string} displayName @param {string} ipynb */
    createNotebook: (workspaceId, displayName, ipynb) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/notebooks`, {
        body: { displayName, description: 'Deployed by the ValueLens installer.', definition: notebookDefinition(ipynb) },
        lroResult: true,
      }),
    /** @param {string} workspaceId @param {string} id @param {string} ipynb */
    updateNotebook: (workspaceId, id, ipynb) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/notebooks/${id}/updateDefinition`, { body: { definition: notebookDefinition(ipynb) } }),

    /** @param {string} workspaceId @param {string} displayName @param {any} pipeline */
    createPipeline: (workspaceId, displayName, pipeline) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/dataPipelines`, {
        body: { displayName, description: 'ValueLens daily load.', definition: pipelineDefinition(pipeline) },
        lroResult: true,
      }),
    /** @param {string} workspaceId @param {string} id @param {any} pipeline */
    updatePipeline: (workspaceId, id, pipeline) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/dataPipelines/${id}/updateDefinition`, {
        body: { definition: pipelineDefinition(pipeline) },
      }),

    /**
     * Starts a job and returns the URL to poll.
     * @param {string} workspaceId
     * @param {string} itemId
     * @param {'Pipeline' | 'RunNotebook'} jobType
     * @param {any} [executionData]
     */
    async runJob(workspaceId, itemId, jobType, executionData) {
      const res = await http.request('POST', `/workspaces/${workspaceId}/items/${itemId}/jobs/instances`, {
        query: { jobType },
        body: executionData ? { executionData } : undefined,
      });
      const location = res.headers.get('location');
      if (!location) throw new Error('Fabric started the job but returned no job instance to follow.');
      return location;
    },
    /** @param {string} jobUrl */
    getJob: (jobUrl) => http.get(jobUrl),
    /** @param {string} workspaceId @param {string} itemId @param {string} jobId */
    jobUrl: (workspaceId, itemId, jobId) => `/workspaces/${workspaceId}/items/${itemId}/jobs/instances/${jobId}`,
    /** @param {string} workspaceId @param {string} itemId */
    listJobs: (workspaceId, itemId) => http.list(`/workspaces/${workspaceId}/items/${itemId}/jobs/instances`),

    /** @param {string} workspaceId @param {string} itemId */
    listSchedules: (workspaceId, itemId) => http.list(`/workspaces/${workspaceId}/items/${itemId}/jobs/Pipeline/schedules`),
    /** @param {string} workspaceId @param {string} itemId @param {any} body */
    createSchedule: (workspaceId, itemId, body) => http.post(`/workspaces/${workspaceId}/items/${itemId}/jobs/Pipeline/schedules`, body),
    /** @param {string} workspaceId @param {string} itemId @param {string} scheduleId @param {any} body */
    updateSchedule: (workspaceId, itemId, scheduleId, body) =>
      http.patch(`/workspaces/${workspaceId}/items/${itemId}/jobs/Pipeline/schedules/${scheduleId}`, body),
  };
}

/** @typedef {ReturnType<typeof fabricApi>} FabricApi */
