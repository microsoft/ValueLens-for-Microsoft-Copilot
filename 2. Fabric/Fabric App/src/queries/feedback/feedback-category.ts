//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./feedback-category.dax?raw";
import spec from "./feedback-category.json";

const columnMetadata: ColumnMetadataMap = {
    "[Category]": { name: "Category", displayName: "Category" },
    "[Feedback Type]": { name: "Feedback Type", displayName: "Feedback" },
    "[Count]": { name: "Count", displayName: "Items", format: FORMAT_WHOLE },
    "[Total Feedback]": { name: "Total Feedback", displayName: "Total feedback", format: FORMAT_WHOLE },
    "[Satisfaction]": { name: "Satisfaction", displayName: "Satisfaction", format: FORMAT_PERCENT },
};

/**
 * What the feedback is about, with the report's testing and uncategorized
 * buckets removed.
 *
 * Category labels arrive with emoji prefixes in the model. The query strips
 * those prefixes before the chart sees them, while preserving the topic name.
 */
export function feedbackCategory() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
