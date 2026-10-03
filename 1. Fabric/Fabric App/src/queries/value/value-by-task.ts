//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { Row } from "@microsoft/fabric-datagrid";
import type { VegaVisualCapabilities, VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { connection, FORMAT_HOURS, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./value-by-task.dax?raw";
import spec from "./value-by-task.json";

export const TASK_GROUP_COLUMN = "Chat + Agent Interactions (Audit Logs)Task Breakdown Group";
export const TASK_CATEGORY_COLUMN = "Chat + Agent Interactions (Audit Logs)Task Breakdown Category";
export const ACTIVITY_SHARE_COLUMN = "Activity Share";
export const HOURS_PER_WEEK_COLUMN = "Expert Equivalent Hours Per Week";
export const VALUE_PER_WEEK_COLUMN = "AI Assisted Value Per Week";
const GRAND_TOTAL_FLAG = "Is Grand Total";
const GROUP_TOTAL_FLAG = "Is Group Total";

/** The grid's first column: the category on group rows, the task on leaf rows. */
export const TASK_LABEL_COLUMN = "Task";

// Every task stays on screen (16 on the demo model, past the default scroll
// threshold of 15) and every category name stays whole in the legend.
const capabilities: VegaVisualCapabilities = {
    disableCategoricalScroll: true,
    disableLegendTruncation: true,
};

const columnMetadata: ColumnMetadataMap = {
    "Chat + Agent Interactions (Audit Logs)[Task Breakdown Group]": {
        name: TASK_GROUP_COLUMN,
        displayName: "Category",
    },
    "Chat + Agent Interactions (Audit Logs)[Task Breakdown Category]": {
        name: TASK_CATEGORY_COLUMN,
        displayName: "Task",
    },
    "[Is Grand Total]": { name: GRAND_TOTAL_FLAG },
    "[Is Group Total]": { name: GROUP_TOTAL_FLAG },
    "[Activity Share]": { name: ACTIVITY_SHARE_COLUMN, displayName: "Activity share", format: FORMAT_PERCENT },
    "[Expert Equivalent Hours Per Week]": {
        name: HOURS_PER_WEEK_COLUMN,
        displayName: "Expert-equivalent hours per week",
        format: FORMAT_HOURS,
    },
    "[AI Assisted Value Per Week]": {
        name: VALUE_PER_WEEK_COLUMN,
        displayName: "Assisted value per week",
        format: FORMAT_WHOLE,
    },
};

/**
 * The report's Copilot Value Table: each task category, drilling down to the
 * rule-based tasks inside it, with activity share, expert-equivalent hours
 * per week and assisted value per week.
 *
 * Category and total rows come from the model's own rollup rather than being
 * summed here: value per week is not additive across tasks, so a sum would
 * disagree with the report.
 */
export function valueByTask() {
    return { connection, query, columnMetadata, capabilities, vegaLiteSpec: spec as VisualizationSpec };
}

export interface ValueTaskTree {
    /** Category rows, each holding its tasks as `_children`. */
    rows: Row[];
    /** The model's grand-total row, shaped for `DataGrid` `grandTotals.data`. */
    total: DataTable | undefined;
    /** Task rows only, for the time-saved chart. */
    tasks: DataTable;
}

const MEASURES = [ACTIVITY_SHARE_COLUMN, HOURS_PER_WEEK_COLUMN, VALUE_PER_WEEK_COLUMN] as const;

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Folds the rollup result into category rows with their tasks nested inside.
 * Categories with no task rows (a blank task column) keep their measures but
 * are not expandable.
 */
export function toValueTaskTree(table: DataTable): ValueTaskTree {
    const index = new Map(table.columns.map((column, i) => [column.name, i]));
    const at = (row: readonly unknown[], name: string) => {
        const i = index.get(name);
        return i === undefined ? undefined : row[i];
    };
    const measures = (row: readonly unknown[]) => Object.fromEntries(MEASURES.map((name) => [name, at(row, name) as Row[string]]));

    const groups = new Map<string, Row>();
    const children = new Map<string, Row[]>();
    let totalRow: readonly unknown[] | undefined;
    const taskRows: unknown[][] = [];

    for (const row of table.rows) {
        if (at(row, GRAND_TOTAL_FLAG) === true) {
            totalRow = row;
            continue;
        }
        const group = text(at(row, TASK_GROUP_COLUMN));
        if (!group) continue;
        if (at(row, GROUP_TOTAL_FLAG) === true) {
            groups.set(group, { _id: `group:${group}`, [TASK_LABEL_COLUMN]: group, ...measures(row) });
            continue;
        }
        const task = text(at(row, TASK_CATEGORY_COLUMN)) ?? "Not classified";
        const list = children.get(group) ?? [];
        list.push({ _id: `task:${group}/${task}`, [TASK_LABEL_COLUMN]: task, ...measures(row) });
        children.set(group, list);
        taskRows.push([group, task, ...MEASURES.map((name) => at(row, name))]);
    }

    const rows = [...groups.values()].map((group) => {
        const nested = children.get(group[TASK_LABEL_COLUMN] as string) ?? [];
        return nested.length > 0 ? { ...group, _children: nested } : group;
    });

    const measureColumns = MEASURES.map((name) => index.get(name)).map((i) =>
        i === undefined ? undefined : table.columns[i],
    );
    const taskColumns = [
        { name: TASK_GROUP_COLUMN, displayName: "Category" },
        { name: TASK_CATEGORY_COLUMN, displayName: "Task" },
        ...MEASURES.map((name, i) => measureColumns[i] ?? { name }),
    ];

    return {
        rows,
        total: totalRow
            ? {
                  columns: [{ name: TASK_LABEL_COLUMN }, ...MEASURES.map((name, i) => measureColumns[i] ?? { name })],
                  rows: [["Total", ...MEASURES.map((name) => at(totalRow as readonly unknown[], name))]],
              }
            : undefined,
        tasks: { columns: taskColumns, rows: taskRows },
    };
}
