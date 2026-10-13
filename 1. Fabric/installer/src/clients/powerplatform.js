// @ts-check
/**
 * Power Platform licensing: the billing policies that charge Copilot pay-as-you-go to Azure.
 */

export const POWER_PLATFORM_URL = 'https://api.powerplatform.com';

/**
 * A pay-as-you-go billing policy. Its Azure subscription is billed for the credits that
 * Copilot Studio and Cowork use beyond prepaid capacity.
 * @typedef {object} BillingPolicy
 * @property {string} id
 * @property {string} [name]
 * @property {string} [status]
 * @property {{ id?: string, subscriptionId?: string, resourceGroup?: string }} [billingInstrument]
 */

/** @param {import('../http.js').HttpClient} http */
export function powerPlatformApi(http) {
  return {
    /** @returns {Promise<BillingPolicy[]>} */
    billingPolicies: () => http.list('/licensing/billingPolicies?api-version=2024-10-01'),
  };
}

/** @typedef {ReturnType<typeof powerPlatformApi>} PowerPlatformApi */
