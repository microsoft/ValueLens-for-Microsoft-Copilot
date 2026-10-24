//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./model-usage.dax?raw";
import spec from "./model-usage.json";

const columnMetadata: ColumnMetadataMap = {
    "[Model]": { name: "Model", displayName: "Model" },
    "[Cost Tier]": { name: "Cost Tier", displayName: "Cost tier" },
    "[Tier Sort]": { name: "Tier Sort", displayName: "Tier sort", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Usage Share]": { name: "Usage Share", displayName: "Share", format: FORMAT_PERCENT },
};

/**
 * Shows which logged model names carry the work, with the semantic model's
 * own cost tier beside them so unclassified usage stays visible.
 */
export function modelUsage() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
