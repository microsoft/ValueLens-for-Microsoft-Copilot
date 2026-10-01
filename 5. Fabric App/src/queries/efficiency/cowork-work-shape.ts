//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { workWeightGrade } from "@/lib/grading-method";
import { toRollupTree, type RollupTree } from "@/lib/rollup-tree";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./cowork-work-shape.dax?raw";

const GRADE_COLUMN = "Chat + Agent Interactions (Audit Logs)Work Weight Grade";
const GRADE_SORT_COLUMN = "Chat + Agent Interactions (Audit Logs)Work Weight Grade Sort";
const SHAPE_COLUMN = "Chat + Agent Interactions (Audit Logs)Work Shape";
const SHAPE_SORT_COLUMN = "Chat + Agent Interactions (Audit Logs)Work Shape Sort";

/** The grid's first column: the grade on group rows, how the work was done on leaf rows. */
export const WORK_LABEL_COLUMN = "Work";
export const COWORK_SHAPE_FIELDS = [
    "Sessions",
    "Decided By",
    "Could Have Used",
    "Share Of Work",
    "Source Items",
    "Source Types",
] as const;

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[Work Weight Grade]": { name: GRADE_COLUMN, displayName: "Grade" },
    "Chat + Agent Interactions (Audit Logs)[Work Weight Grade Sort]": { name: GRADE_SORT_COLUMN },
    "Chat + Agent Interactions (Audit Logs)[Work Shape]": { name: SHAPE_COLUMN, displayName: "How it was done" },
    "Chat + Agent Interactions (Audit Logs)[Work Shape Sort]": { name: SHAPE_SORT_COLUMN },
    "[Is Grand Total]": { name: "Is Grand Total" },
    "[Is Group Total]": { name: "Is Group Total" },
    "[Sessions]": { name: "Sessions", displayName: "Sessions", format: FORMAT_WHOLE },
    "[Decided By]": { name: "Decided By", displayName: "Decided by" },
    "[Could Have Used]": { name: "Could Have Used", displayName: "Could have used" },
    "[Share Of Work]": { name: "Share Of Work", displayName: "% of work", format: FORMAT_PERCENT },
    // Medians of the sources each session touched, to one decimal place as in the report.
    "[Source Items]": { name: "Source Items", displayName: "Source items", format: FORMAT_HOURS },
    "[Source Types]": { name: "Source Types", displayName: "Source types", format: FORMAT_HOURS },
};

/**
 * The report's "what is being done today" table: each grade, then the shape
 * of work inside it, with the commonest reason for the grade, the everyday
 * tool that could have done Worth-a-look work, its share of graded work and
 * the median number and kinds of sources a session touched.
 */
export function coworkWorkShape() {
    return { connection, query, columnMetadata };
}

/** Grade rows under the report's current names, each holding its work shapes. */
export function toWorkShapeTree(table: DataTable): RollupTree {
    return toRollupTree(table, {
        group: GRADE_COLUMN,
        leaf: SHAPE_COLUMN,
        grandTotalFlag: "Is Grand Total",
        groupTotalFlag: "Is Group Total",
        label: WORK_LABEL_COLUMN,
        fields: COWORK_SHAPE_FIELDS,
        groupLabel: (value, cell) => workWeightGrade(value, cell(GRADE_SORT_COLUMN))?.name,
    });
}
