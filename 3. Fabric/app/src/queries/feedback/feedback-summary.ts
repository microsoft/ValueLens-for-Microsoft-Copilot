//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./feedback-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Satisfaction]": { name: "Satisfaction", displayName: "Satisfaction", format: FORMAT_PERCENT },
    "[Total Feedback]": { name: "Total Feedback", displayName: "Total feedback", format: FORMAT_WHOLE },
    "[Thumbs Up]": { name: "Thumbs Up", displayName: "Thumbs up", format: FORMAT_WHOLE },
    "[Thumbs Down]": { name: "Thumbs Down", displayName: "Thumbs down", format: FORMAT_WHOLE },
    "[Theme Summary]": { name: "Theme Summary", displayName: "Theme summary" },
};

/**
 * The one-row feedback headline, including the model's own narrative.
 *
 * The report spreads these figures across cards and narrative text; the app
 * keeps them together so the reader can see the sentiment and the sample size
 * before reading any breakdown.
 */
export function feedbackSummary() {
    return { connection, query, columnMetadata };
}
