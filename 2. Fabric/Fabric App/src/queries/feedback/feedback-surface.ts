//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./feedback-surface.dax?raw";
import spec from "./feedback-surface.json";

export const FEEDBACK_SURFACE_MIN_COUNT = 5;

const columnMetadata: ColumnMetadataMap = {
    "[Surface / Agent]": { name: "Surface / Agent", displayName: "Surface or agent" },
    "[Total Feedback]": { name: "Total Feedback", displayName: "Total feedback", format: FORMAT_WHOLE },
    "[Thumbs Up]": { name: "Thumbs Up", displayName: "Thumbs up", format: FORMAT_WHOLE },
    "[Thumbs Down]": { name: "Thumbs Down", displayName: "Thumbs down", format: FORMAT_WHOLE },
    "[Satisfaction]": { name: "Satisfaction", displayName: "Satisfaction", format: FORMAT_PERCENT },
};

/**
 * Satisfaction by the surface or agent named on the feedback row.
 *
 * The query suppresses tiny samples before ranking, so a surface needs at
 * least five feedback items before it can look better or worse than it is.
 */
export function feedbackSurface() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
