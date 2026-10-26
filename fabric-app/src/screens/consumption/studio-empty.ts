//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

export const PPAC_URL = "https://admin.powerplatform.microsoft.com/";
export const PPAC_EXPORT_TITLE = "Needs a Power Platform admin center export";
/** Where the installer asks for credit exports in a Fabric install. */
export const UPLOAD_FOLDER = "Files/analytics_hub_uploads";

export interface EmptyText {
    title: string;
    description: string;
}

/**
 * The KPI row's empty state. The totals read the tenant daily table, so an
 * empty row with credits in the user snapshot means the totals weren't built,
 * not that nobody used an agent.
 */
export function studioTotalsEmpty(userCredits: boolean): EmptyText {
    return userCredits
        ? {
              title: "Copilot Studio totals aren't loaded yet",
              description:
                  "The user snapshot has Copilot Studio credits, but the tenant totals have no rows for this period. Update the Ingest_Studio notebook (run the installer and choose Repair or change) so the totals are summed from the per-user credits, then run the load again. A Power Platform admin center export fills them too.",
          }
        : {
              title: "No Copilot Studio credits",
              description:
                  "Consumption Central has no Copilot Studio credit rows for this period. Check that the Copilot Studio credits flow is on, or that a PPAC export has loaded.",
          };
}

/** The daily chart's empty state, on the same terms as the KPI row's. */
export function studioDailyEmpty(userCredits: boolean): EmptyText {
    return userCredits
        ? {
              title: "No daily totals yet",
              description:
                  "The user snapshot has Copilot Studio credits, but the tenant totals have no days in this period. Update the Ingest_Studio notebook (Repair or change in the installer) so each day is summed from the per-user credits.",
          }
        : {
              title: "No daily credits",
              description: "The tenant data has no days with Copilot Studio credits in this period.",
          };
}
