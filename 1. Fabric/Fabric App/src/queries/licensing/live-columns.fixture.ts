//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Column names as returned by the live semantic model for the license
 * readiness queries, captured against the published `ValueLens - Fabric`
 * model before wiring the stage.
 */
export const liveColumns = {
    licenseDemandSummary: [
        "[Active Unlicensed Users]",
        "[Unlicensed Share]",
        "[Median Sessions Per User Per Week]",
        "[Observed Sessions Per User Per Week]",
    ],
    licenseEstateSummary: [
        "[Total Licensed Users]",
        "[Avg Days Since Last Active]",
        "[License Evidence Notice]",
        "[Reclaim Cost Notice]",
        "[License Inventory Usable]",
    ],
    licensePriorityByOrg: [
        "[Organization]",
        "[Active Unlicensed Users]",
        "[Active Days Per Week]",
        "[Sessions Per User Per Week]",
    ],
    licenseCandidates: [
        "[Rank]",
        "[User]",
        "[Organization]",
        "[Priority Score]",
        "[Sessions Per Week]",
        "[Active Days Per Week]",
    ],
    // Ran cleanly on the live model on 2026-10-03 but returned no rows (no Copilot
    // interactions on that tenant yet), so these columns are as authored.
    licenseCandidatesM365: [
        "[Rank]",
        "[User]",
        "[Organization]",
        "[Priority Score]",
        "[Sessions Per Week]",
        "[Active Days Per Week]",
        "[Workloads Per Day]",
    ],
    licenseDormancy: ["[Dormancy Bucket Order]", "[Dormancy Bucket]", "[Licensed Users]"],
} as const;
