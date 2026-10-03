//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./license-priority-by-org.dax?raw";
import spec from "./license-priority-by-org.json";

const columnMetadata: ColumnMetadataMap = {
    "[Organization]": { name: "Organization", displayName: "Organization" },
    "[Active Unlicensed Users]": {
        name: "Active Unlicensed Users",
        displayName: "Active unlicensed users",
        format: FORMAT_WHOLE,
    },
    "[Active Days Per Week]": {
        name: "Active Days Per Week",
        displayName: "Active days per week",
        format: FORMAT_RATE,
    },
    "[Sessions Per User Per Week]": {
        name: "Sessions Per User Per Week",
        displayName: "Sessions per user per week",
        format: FORMAT_RATE,
    },
};

/**
 * The report's organization bubble matrix, rendered as a rank instead.
 *
 * In the live tenant every organization has five active unlicensed users and
 * sits in a tight diagonal band. A bar makes the priority order legible while
 * keeping days active and user count in the tooltip.
 */
export function licensePriorityByOrg() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
