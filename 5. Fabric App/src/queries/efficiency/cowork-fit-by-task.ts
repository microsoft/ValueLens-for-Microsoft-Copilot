//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { workWeightGrade } from "@/lib/grading-method";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./cowork-fit-by-task.dax?raw";
import spec from "./cowork-fit-by-task.json";

/** The chart's colour domain, strongest first, as the stack reads left to right. */
export const COWORK_GRADE_DOMAIN = ["Strong fit", "Fair fit", "Worth a look"] as const;

const columnMetadata: ColumnMetadataMap = {
    "[Task]": { name: "Task", displayName: "Task" },
    "[Grade]": { name: "Grade", displayName: "Fit" },
    "[Grade Order]": { name: "Grade Order", displayName: "Fit order", format: FORMAT_WHOLE },
    "[Share]": { name: "Share", displayName: "Share of the task", format: FORMAT_PERCENT },
    "[Sessions]": { name: "Sessions", displayName: "Graded sessions", format: FORMAT_WHOLE },
    "[Task Sessions]": { name: "Task Sessions", displayName: "Graded sessions in the task", format: FORMAT_WHOLE },
};

/**
 * The report's "what work goes to Cowork" chart: each Cowork task category
 * split by grade, as a share of that category's graded sessions. Sessions too
 * light to grade are left out, as they are from every share.
 */
export function coworkFitByTask() {
    return { connection, query, columnMetadata, vegaLiteSpec: spec as VisualizationSpec };
}

/** Writes every grade under the report's current name, whichever naming the model uses. */
export function withGradeNames(table: DataTable): DataTable {
    const grade = table.columns.findIndex((column) => column.name === "Grade");
    const order = table.columns.findIndex((column) => column.name === "Grade Order");
    if (grade < 0) return table;
    return {
        ...table,
        rows: table.rows.map((row) => {
            const next = [...row];
            next[grade] = workWeightGrade(row[grade], order >= 0 ? row[order] : undefined)?.name ?? row[grade];
            return next;
        }),
    };
}
