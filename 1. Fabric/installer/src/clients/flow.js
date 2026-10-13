// @ts-check
/**
 * Power Automate: a flow's state and runs, and running its trigger now, as the signed-in user.
 * A solution flow's name here is its Dataverse workflowid.
 */

export const FLOW_URL = 'https://api.flow.microsoft.com';
const VERSION = 'api-version=2016-11-01';

/**
 * @typedef {object} FlowRun
 * @property {string} name
 * @property {{ status?: string, startTime?: string, endTime?: string, error?: { code?: string, message?: string } }} [properties]
 */

/** @param {import('../http.js').HttpClient} http  A client whose base URL is FLOW_URL. */
export function flowApi(http) {
  const path = (/** @type {string} */ env, /** @type {string} */ id) =>
    `/providers/Microsoft.ProcessSimple/environments/${encodeURIComponent(env)}/flows/${encodeURIComponent(id)}`;
  return {
    /**
     * The flow, with properties.state Started, Stopped or Suspended.
     * @param {string} env  The environment's ID, e.g. Default-<tenant>.
     * @param {string} id
     * @returns {Promise<{ name: string, properties?: { state?: string, displayName?: string } }>}
     */
    getFlow: (env, id) => http.get(`${path(env, id)}?${VERSION}`),
    /**
     * The latest runs, newest first.
     * @param {string} env
     * @param {string} id
     * @returns {Promise<FlowRun[]>}
     */
    listRuns: async (env, id) => (await http.get(`${path(env, id)}/runs?${VERSION}`))?.value ?? [],
    /**
     * Runs a trigger now, as the Run button in Power Automate does. Recurrence triggers included.
     * @param {string} env
     * @param {string} id
     * @param {string} trigger  The trigger's name in the definition.
     */
    runTrigger: (env, id, trigger) => http.post(`${path(env, id)}/triggers/${encodeURIComponent(trigger)}/run?${VERSION}`, {}),
  };
}

/** @typedef {ReturnType<typeof flowApi>} FlowApi */
