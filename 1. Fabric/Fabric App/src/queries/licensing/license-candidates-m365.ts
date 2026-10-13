//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./license-candidates-m365.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Rank]": { name: "Rank", displayName: "Rank", format: FORMAT_WHOLE },
    "[User]": { name: "User", displayName: "User" },
    "[Organization]": { name: "Organization", displayName: "Organization" },
    "[Priority Score]": { name: "Priority Score", displayName: "Priority score", format: FORMAT_WHOLE },
    "[Sessions Per Week]": {
        name: "Sessions Per Week",
        displayName: "Sessions per week",
        format: FORMAT_RATE,
    },
    "[Active Days Per Week]": {
        name: "Active Days Per Week",
        displayName: "Active days per week",
        format: FORMAT_RATE,
    },
    "[Workloads Per Day]": {
        name: "Workloads Per Day",
        displayName: "Workloads per day",
        format: FORMAT_RATE,
    },
};

/** Workloads per active day that earn the breadth part of the score in full. */
export const LICENSE_BREADTH_FULL_MARKS = 4;

/**
 * {@link licenseCandidates} with Microsoft 365 activity folded into the
 * score. The model's score is 60 points for Copilot volume and 40 for active
 * days. Here those become 50 and 30, and the last 20 go to how many Microsoft
 * 365 workloads a person uses on an active day, full at
 * {@link LICENSE_BREADTH_FULL_MARKS}: a license puts Copilot inside those
 * apps, so the more of them someone works in, the more it has to work with.
 * Anyone with no Microsoft 365 activity in the selection keeps the model's
 * score rather than losing the 20 points.
 */
export function licenseCandidatesM365() {
    return { connection, query, columnMetadata };
}
