//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { formatKpi } from "@/lib/format-kpi";
import { leaderHeadline, type FigureOptions, type Headline } from "@/lib/headline";
import { HOURS_PER_WEEK_COLUMN, TASK_CATEGORY_COLUMN } from "@/queries/value";
import { taskBreakdown, taskDimensions, type TaskDimension } from "@/queries/work";

function columnIndex(table: DataTable, name: string): number {
    return table.columns.findIndex((column) => column.name === name);
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Reads a headline from only the rows whose `column` holds `value`, as a chart filtered to one lens draws them. */
export function rowsWhere(column: string, value: string, headline: Headline): Headline {
    return (table) => {
        const at = columnIndex(table, column);
        if (at < 0) return undefined;
        return headline({ ...table, rows: table.rows.filter((row) => row[at] === value) });
    };
}

export interface LargestOptions extends FigureOptions {
    /** The category column, by its cleaned name. */
    label: string;
    /** The measure column, by its cleaned name; read row by row, never summed. */
    value: string;
    /** What the value is, mid-sentence: "expert-equivalent hours a week". */
    of: string;
}

/**
 * "Drafting has the most expert-equivalent hours a week, at 12.3." The
 * largest row and its own figure, for measures that don't add up into a
 * whole, so no share is claimed. Says nothing with fewer than two rows, any
 * negative value, or a tie for first.
 */
export function largestHeadline(options: LargestOptions): Headline {
    return (table) => {
        const labelAt = columnIndex(table, options.label);
        const valueAt = columnIndex(table, options.value);
        if (labelAt < 0 || valueAt < 0) return undefined;
        const rows: [string, number][] = [];
        for (const row of table.rows) {
            const name = text(row[labelAt]);
            const amount = finite(row[valueAt]);
            if (!name || amount === undefined || amount === 0) continue;
            rows.push([name, amount]);
        }
        if (rows.length < 2 || rows.some(([, amount]) => amount < 0)) return undefined;
        rows.sort((a, b) => b[1] - a[1]);
        const [name, amount] = rows[0];
        if (rows[1][1] === amount) return undefined;
        const figure = formatKpi(amount, options.format ?? "whole", { prefix: options.prefix });
        return `${name} has the most ${options.of}, at ${figure}.`;
    };
}

/**
 * "Estimated value is highest relative to cost for Copilot Studio credits,
 * at 5.4×." Which cost is set against the most estimated value. A
 * comparison of ratios, not a claim about what the spending did.
 */
export const pairReturnHeadline: Headline = (table) => {
    const lineAt = columnIndex(table, "Cost Line");
    const returnAt = columnIndex(table, "Return");
    if (lineAt < 0 || returnAt < 0) return undefined;
    const ratios: [string, number][] = [];
    for (const row of table.rows) {
        const name = text(row[lineAt]);
        const ratio = finite(row[returnAt]);
        if (name && ratio !== undefined && ratio >= 0) ratios.push([name, ratio]);
    }
    if (ratios.length < 2) return undefined;
    ratios.sort((a, b) => b[1] - a[1]);
    const [name, ratio] = ratios[0];
    if (ratio <= 0 || ratios[1][1] === ratio) return undefined;
    return `Estimated value is highest relative to cost for ${name}, at ${formatKpi(ratio, "multiple")}.`;
};

/**
 * "Estimated value is at or above the allocated cost for 3 of 7 agents."
 * Counts only agents with both a cost and a value; says nothing with fewer
 * than two.
 */
export const agentCoverageHeadline: Headline = (table) => {
    const returnAt = columnIndex(table, "Return");
    if (returnAt < 0) return undefined;
    const ratios = table.rows.map((row) => finite(row[returnAt])).filter((ratio) => ratio !== undefined);
    if (ratios.length < 2) return undefined;
    const covered = ratios.filter((ratio) => ratio >= 1).length;
    const count =
        covered === ratios.length
            ? `all ${ratios.length} agents`
            : covered === 0
              ? `none of the ${ratios.length} agents`
              : `${covered} of ${ratios.length} agents`;
    return `Estimated value is at or above the allocated cost for ${count}.`;
};

const surfaceLeader = leaderHeadline({ label: "Category", value: "All Tasks", of: "tasks" });

/** "Tasks by app": the app most requests came from. */
export const SURFACE_HEADLINE = rowsWhere("Lens", "Surface", surfaceLeader);

/** "Tasks by model": the model that answered most requests. */
export const MODEL_HEADLINE = rowsWhere("Lens", "Model", surfaceLeader);

const taskLeader = leaderHeadline({ label: "Category", value: "Tasks", of: "tasks" });

/** The task breakdown's leading category, per lens, keyed as the toggle keys them. */
export const TASK_BREAKDOWN_HEADLINES = Object.fromEntries(
    taskDimensions.map(({ id }) => [id, rowsWhere("Dimension", taskBreakdown({ dimension: id }).dimension, taskLeader)]),
) as Record<TaskDimension, Headline>;

/** "Time saved by Task Breakdown": the task with the most expert-equivalent hours. */
export const TIME_SAVED_HEADLINE = largestHeadline({
    label: TASK_CATEGORY_COLUMN,
    value: HOURS_PER_WEEK_COLUMN,
    of: "expert-equivalent hours a week",
    format: "hours",
});
