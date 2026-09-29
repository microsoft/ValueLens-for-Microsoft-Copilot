//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./license-demand-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Active Unlicensed Users]": {
        name: "Active Unlicensed Users",
        displayName: "Active unlicensed users",
        format: FORMAT_WHOLE,
    },
    "[Unlicensed Share]": { name: "Unlicensed Share", displayName: "Unlicensed share", format: FORMAT_PERCENT },
    "[Median Sessions Per User Per Week]": {
        name: "Median Sessions Per User Per Week",
        displayName: "Median sessions per user per week",
        format: FORMAT_RATE,
    },
    "[Observed Sessions Per User Per Week]": {
        name: "Observed Sessions Per User Per Week",
        displayName: "Observed sessions per user per week",
        format: FORMAT_RATE,
    },
};

/**
 * Demand from people already using Copilot without a license, kept separate
 * from the roster so date and organization slicers only shape activity.
 */
export function licenseDemandSummary() {
    return { connection, query, columnMetadata };
}
