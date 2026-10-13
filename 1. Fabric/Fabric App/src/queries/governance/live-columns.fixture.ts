//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names each governance query returns, as its `ROW` or
 * `SELECTCOLUMNS` names them. They read the `Sharing Scope`, `Owner account`,
 * `Data Access` and `Governance Flags` columns added to `Agents 365`, so
 * re-capture them against a published `ValueLens - Fabric` model once one
 * carries those columns.
 */
export const liveColumns = {
    governanceSummary: [
        "[Tenant Agents]",
        "[Needs Review]",
        "[No Sign In]",
        "[Owner Left]",
        "[No Owner]",
        "[Org Wide Org Data]",
        "[Shared Unused]",
        "[Org Wide]",
        "[Owners Checked]",
    ],
    governanceExposure: [
        "[Scope Order]",
        "[Sharing Scope]",
        "[Access Order]",
        "[Data Access]",
        "[Agents]",
        "[Unused Agents]",
    ],
    governanceOwners: ["[Status Order]", "[Owner Status]", "[Agents]"],
    governanceReviewQueue: [
        "[Agent]",
        "[Registry Id]",
        "[Type]",
        "[Creator]",
        "[Sharing Scope]",
        "[Data Access]",
        "[Users]",
        "[Owner Account]",
        "[Flag Count]",
        "[Priority]",
        "[Flags]",
    ],
    // Shadow AI reads the optional Defender tables and measures.
    shadowAiSummary: [
        "[Tools Watched]",
        "[Unsanctioned Tools]",
        "[Tools Found]",
        "[Tools This Week]",
        "[Devices]",
        "[Users]",
        "[Cloud Users]",
        "[Status]",
    ],
    shadowAiTools: ["[Tool]", "[Layer]", "[Posture]", "[Devices]", "[Users]"],
    shadowAiStatus: ["[Probe]", "[Status]", "[Source]", "[Rows]", "[Message]", "[Run At]"],
    governanceResourceGraph: [
        "[Configured Agents]",
        "[Matched Agents]",
        "[No Sign In]",
        "[No Sign In Configured]",
        "[Web Search]",
        "[Foundry Resources]",
        "[Foundry Public]",
        "[Foundry Public Projects]",
        "[Agent Status]",
        "[Foundry Status]",
    ],
} as const;
