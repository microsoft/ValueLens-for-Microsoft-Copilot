//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names the data-freshness queries return. Authored from the model
 * schemas in the `.pbit` templates, not captured live: no published model was
 * reachable when these were written.
 */
export const liveColumns = {
    auditLogFreshness: ["[Last Date]"],
    m365ActivityFreshness: ["[Last Date]"],
    productFeedbackFreshness: ["[Last Date]"],
    registryFreshness: ["[Last Date]"],
    consumptionFreshness: ["[Cowork Last Date]", "[Studio Last Date]", "[Azure Last Date]"],
    evaluatorFreshness: ["[Last Date]"],
} as const;