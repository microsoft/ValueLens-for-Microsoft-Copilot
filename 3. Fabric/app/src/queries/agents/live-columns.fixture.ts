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
 * and resolve. The per-grade breakdown the report draws beneath them is
 * deliberately not built until a tenant with Cowork rows can confirm its
 * shape.
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
        "[Cowork Users]",
        "[Cowork Sessions]",
        "[Graded Sessions]",
        "[Strong Fit Share]",
        "[Low Fit Share]",
        "[Cowork Hours]",
        "[Fit Notice]",
    ],
} as const;
