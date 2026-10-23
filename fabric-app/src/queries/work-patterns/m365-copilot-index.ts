//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_RATE } from "../shared";
import query from "./m365-copilot-index.dax?raw";
import spec from "./m365-copilot-index.json";

const columnMetadata: ColumnMetadataMap = {
    "[Metric]": { name: "Metric", displayName: "Per person, per week" },
    "[Copilot Users]": { name: "Copilot Users", displayName: "Copilot users", format: FORMAT_RATE },
    "[Others]": { name: "Others", displayName: "Everyone else", format: FORMAT_RATE },
    "[Index]": { name: "Index", displayName: "Ratio", format: FORMAT_RATE },
};

/**
 * How a week on Microsoft 365 looks for people who use Copilot, set against
 * everyone else active in the same selection. A ratio above 1 means Copilot
 * users do more of it per week. It describes the two groups; it doesn't say
 * Copilot caused the difference.
 */
export function m365CopilotIndex() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
