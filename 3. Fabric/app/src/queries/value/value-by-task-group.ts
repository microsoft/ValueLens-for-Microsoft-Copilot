//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./value-by-task-group.dax?raw";
import spec from "./value-by-task-group.json";

export const TASK_GROUP_COLUMN = "Chat + Agent Interactions (Audit Logs)Task Breakdown Group";

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]": {
        name: TASK_GROUP_COLUMN,
        displayName: "Task group",
    },
    "[Expert Equivalent Hours]": {
        name: "Expert Equivalent Hours",
        displayName: "Expert-equivalent hours",
        format: FORMAT_HOURS,
    },
    "[AI Assisted Value]": { name: "AI Assisted Value", displayName: "Estimated value", format: FORMAT_WHOLE },
    "[Share of Value]": { name: "Share of Value", displayName: "Share of value", format: FORMAT_PERCENT },
};

/**
 * Estimated value by the model's own task-breakdown group.
 *
 * The Work stage already charts task volume by behavioural, action and
 * outcome lenses. This chart stays on value and uses the report's grouped
 * task field, so it answers where the estimate comes from rather than
 * repeating the activity mix.
 */
export function valueByTaskGroup() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}
