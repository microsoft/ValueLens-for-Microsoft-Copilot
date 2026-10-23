//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_WHOLE } from "../shared";
import query from "./executive-work-kinds.dax?raw";
import spec from "./executive-work-kinds.json";

/** How many kinds of work the chart ranks. */
export const WORK_KINDS_SHOWN = 6;

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]": {
        name: "Chat + Agent Interactions (Audit Logs)Task Breakdown Category",
        displayName: "Kind of work",
    },
    "[Hours]": { name: "Hours", displayName: "Expert-equivalent hours", format: FORMAT_HOURS },
    "[Tasks]": { name: "Tasks", displayName: "Tasks", format: FORMAT_WHOLE },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
};

/**
 * What the work is: the six kinds of work with the most expert-equivalent
 * hours. General Chat and General Assistance are left out, as they are from
 * the unique-skills count, because they say nothing about the work.
 */
export function executiveWorkKinds() {
    return {
        connection,
        query,
        columnMetadata,
        vegaLiteSpec: structuredClone(spec) as unknown as VisualizationSpec,
    };
}
