//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./cowork-readiness-by-org.dax?raw";
import spec from "./cowork-readiness-by-org.json";

const columnMetadata: ColumnMetadataMap = {
    "[Organization]": { name: "Organization", displayName: "Organization" },
    "[Eligible Users]": { name: "Eligible Users", displayName: "Eligible users", format: FORMAT_WHOLE },
    "[Surfaces Per Day]": { name: "Surfaces Per Day", displayName: "Apps per active day", format: FORMAT_RATE },
    "[Prompts Per Session]": {
        name: "Prompts Per Session",
        displayName: "Prompts per session",
        format: FORMAT_RATE,
    },
    "[Agent User Share]": {
        name: "Agent User Share",
        displayName: "% already using agents",
        format: FORMAT_PERCENT,
    },
};

/**
 * Readiness signals per organization, ranked by breadth of everyday use.
 *
 * The report plots breadth against depth as a scatter. Depth — prompts per
 * session — only separates organizations once the audit log records
 * multi-turn sessions; where every session is a single prompt the scatter
 * collapses onto one line. Breadth carries the most weight in the readiness
 * score, so it takes the axis and depth rides along in the tooltip.
 */
export function coworkReadinessByOrg() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
