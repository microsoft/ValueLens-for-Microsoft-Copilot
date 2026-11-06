//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./m365-workload-trend.dax?raw";
import spec from "./m365-workload-trend.json";

const columnMetadata: ColumnMetadataMap = {
    "[Week Start]": { name: "Week Start", displayName: "Week starting", format: "dd mmm yyyy" },
    "[Workload]": { name: "Workload", displayName: "Workload" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Share]": { name: "Share", displayName: "Share of active people", format: FORMAT_PERCENT },
};

/**
 * Each week, the share of people active on Microsoft 365 who used each
 * workload. Only complete Monday-to-Sunday weeks are kept, so the latest
 * partial week doesn't read as a drop.
 */
export function m365WorkloadTrend() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
