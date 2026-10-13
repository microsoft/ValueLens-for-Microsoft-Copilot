//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./model-match-by-tool.dax?raw";
import spec from "./model-match-by-tool.json";

const columnMetadata: ColumnMetadataMap = {
    "[Activity]": { name: "Activity", displayName: "Activity" },
    "[Outcome]": { name: "Outcome", displayName: "Outcome" },
    "[Outcome Order]": { name: "Outcome Order", displayName: "Outcome order", format: FORMAT_WHOLE },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Share]": { name: "Share", displayName: "Share", format: FORMAT_PERCENT },
};

/**
 * Splits the model-fit verdict by Copilot and Agents instead of letting the
 * shared activity filter hide one side of the comparison.
 */
export function modelMatchByTool() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
