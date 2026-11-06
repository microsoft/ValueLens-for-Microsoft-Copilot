//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./feedback-trend.dax?raw";
import spec from "./feedback-trend.json";

const columnMetadata: ColumnMetadataMap = {
    "[Week Start]": { name: "Week Start", displayName: "Week starting", format: "dd mmm yyyy" },
    "[Feedback Type]": { name: "Feedback Type", displayName: "Feedback" },
    "[Count]": { name: "Count", displayName: "Items", format: FORMAT_WHOLE },
    "[Signed Count]": { name: "Signed Count", displayName: "Items", format: FORMAT_WHOLE },
    "[Satisfaction]": { name: "Satisfaction", displayName: "Satisfaction", format: FORMAT_PERCENT },
    "[Total Feedback]": { name: "Total Feedback", displayName: "Total feedback", format: FORMAT_WHOLE },
};

/**
 * Weekly thumbs up and thumbs down as one diverging rhythm.
 *
 * The model only has three `MonthStart` buckets in the preview window, so
 * weeks show the movement without pretending a second-axis line is precise
 * enough for the small weekly sample sizes.
 */
export function feedbackTrend() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
