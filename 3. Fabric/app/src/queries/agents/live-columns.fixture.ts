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
    agentActivitySummary: [
        "[Agent Users]",
        "[Agent User Share]",
        "[Agent Sessions]",
        "[Sessions Per User]",
        "[Return Rate]",
    ],
    agentUsage: ["[Agent]", "[Sessions]", "[Users]", "[Return Rate]", "[Organizations]"],
    agentEstateSummary: [
        "[Registry Agents]",
        "[Tenant Built]",
        "[Seen In Use]",
        "[Unmatched Sessions]",
        "[Registry Updated]",
    ],
    agentLifecycle: ["[Lifecycle Order]", "[Lifecycle]", "[Type]", "[Agents]"],
    agentRegistry: [
        "[Agent]",
        "[Type]",
        "[Creator]",
        "[Lifecycle Order]",
        "[Lifecycle]",
        "[Usage Review]",
        "[Users]",
        "[Sessions]",
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
} as const;
