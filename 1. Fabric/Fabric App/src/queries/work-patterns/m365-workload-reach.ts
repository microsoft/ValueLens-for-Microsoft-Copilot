//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./m365-workload-reach.dax?raw";
import spec from "./m365-workload-reach.json";

const columnMetadata: ColumnMetadataMap = {
    "[Workload]": { name: "Workload", displayName: "Workload" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Reach]": { name: "Reach", displayName: "Share of active people", format: FORMAT_PERCENT },
    "[Days Per Week]": { name: "Days Per Week", displayName: "Days per week, when used", format: FORMAT_RATE },
};

/**
 * How far each workload reaches across the people active on Microsoft 365,
 * and how many days a week the people who use it do.
 */
export function m365WorkloadReach() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
