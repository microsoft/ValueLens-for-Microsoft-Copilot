//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./trend-heatmap-headline.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Active Users Headline]": { name: "Active Users Headline", displayName: "Active users headline" },
    "[Active Days Headline]": { name: "Active Days Headline", displayName: "Active days headline" },
    "[Expert Hours Headline]": { name: "Expert Hours Headline", displayName: "Expert hours headline" },
    "[Sessions Headline]": { name: "Sessions Headline", displayName: "Sessions headline" },
};

/**
 * Heatmap headlines evaluated through the model's disconnected toggle table,
 * so the sentence stays identical to the report while the chart stays local.
 */
export function trendHeatmapHeadline() {
    return { connection, query, columnMetadata };
}
