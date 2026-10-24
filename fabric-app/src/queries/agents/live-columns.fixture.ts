//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names as returned by the live semantic model, captured by running
 * each `.dax` file against the published `ValueLens - Fabric` model.
 *
 * Every Cowork fit measure returns BLANK in a tenant with no Cowork activity,
 * so the column names below are the only live evidence those queries parse
 * and resolve. The per-grade breakdowns beneath the summary live with the
 * Efficiency queries; their row shape was confirmed by running the same
 * rollups over non-Cowork measures.
 */
export const liveColumns = {
    // Recovery additions (keys, totals and spotlight summaries) are authored
    // contracts, not newly captured live-query evidence.
    agentActivitySummary: [
        "[Agent Users]",
        "[Agent User Share]",
        "[Agent Sessions]",
        "[Sessions Per User]",
    ],
    agentUsage: ["[Agent]", "[Sessions]", "[Users]", "[Organizations]"],
    agentEstateSummary: [
        "[Registry Agents]",
        "[Tenant Built]",
        "[Seen In Use]",
        "[Unmatched Sessions]",
        "[Registry Updated]",
    ],
    agentLifecycle: ["[Lifecycle Order]", "[Lifecycle]", "[Type]", "[Agents]"],
    agentLeaderboard: [
        "[Agent]",
        "[Registry Id]",
        "[Agent Key]",
        "[In Registry]",
        "[Type]",
        "[Creator]",
        "[Users]",
        "[Sessions]",
        "[Sessions Per User]",
        "[Orgs Reached]",
        "[Last Activity]",
        "[Features]",
        "[Lifecycle]",
        "[Adoption]",
        "[Description]",
        "[Top Sessions]",
        "[Session Leaders]",
        "[Session Leader Count]",
        "[Top Orgs]",
        "[Org Leaders]",
        "[Org Leader Count]",
        "[In Use]",
        "[Registered]",
        "[Total]",
    ],
    coworkReadinessSummary: [
        "[Eligible Users]",
        "[Surfaces Per Day]",
        "[Prompts Per Session]",
        "[Agent User Share]",
    ],
    coworkReadinessByOrg: [
        "[Organization]",
        "[Eligible Users]",
        "[Surfaces Per Day]",
        "[Prompts Per Session]",
        "[Agent User Share]",
    ],
    coworkCandidates: [
        "[Rank]",
        "[User]",
        "[Organization]",
        "[Surfaces Per Day]",
        "[Prompts Per Session]",
        "[Uses Agents]",
        "[Depths]",
        "[Total]",
    ],
    coworkFitSummary: [
        "[Cowork Sessions]",
        "[Tasks Completed]",
        "[Active Days Per User]",
        "[Expert Hours]",
        "[Strong Fit Share]",
        "[Worth A Look Share]",
        "[Fit Notice]",
    ],
    // Authored from the model's measure definitions, not captured live: no published model was
    // reachable when these were written.
    agentFunctions: ["[Agent]", "[Registry Id]", "[Agent Key]", "[Functions]", "[Leader Count]"],
} as const;
