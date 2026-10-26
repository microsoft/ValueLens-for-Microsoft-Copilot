//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection } from "../shared";
import query from "./signal-impact.dax?raw";
import taskDescriptions from "./task-descriptions.json";

const columnMetadata: ColumnMetadataMap = {
    "[Signal]": { name: "Signal", displayName: "Signal" },
    "[AI Tasks]": { name: "AI Tasks", displayName: "Task Breakdown" },
    "[Use Case]": { name: "Use Case", displayName: "Use case" },
    "[Value Outcome]": { name: "Value Outcome", displayName: "Value outcome" },
    "[Human Equivalent (Minutes)]": {
        name: "Human Equivalent (Minutes)",
        displayName: "Human minutes",
        format: "0",
    },
    "[Research Source]": { name: "Research Source", displayName: "Research source" },
    "[Source URL]": { name: "Source URL", displayName: "Source URL" },
    "[Confidence]": { name: "Confidence", displayName: "Confidence" },
    "[Category]": { name: "Category", displayName: "Task Category" },
};

const descriptions = new Map<string, string>(Object.entries(taskDescriptions));

/**
 * Adds a plain-language Description of each Task Breakdown. The text ships with
 * the app, as in the templates, so models deployed before the column existed
 * show it too; a task with no entry is left blank.
 */
export function withTaskDescriptions(table: DataTable): DataTable {
    const index = table.columns.findIndex((column) => column.name === "AI Tasks");
    return {
        ...table,
        columns: [...table.columns, { name: "Description", displayName: "Description" }],
        rows: table.rows.map((row) => {
            const task = index < 0 ? undefined : row[index];
            return [...row, (typeof task === "string" && descriptions.get(task)) || null];
        }),
    };
}

/**
 * The report's Signal → Impact appendix: each audit-log signal, the Task
 * Breakdown it is read as, and the human-time estimate and research behind its value.
 *
 * `Behavior Value Map` holds the signals and `Human Time Estimates` the
 * editable minutes; they are joined on Behavior with LOOKUPVALUE so the query
 * does not depend on which way the model's relationship filters.
 */
export function signalImpact() {
    return { connection, query, columnMetadata };
}
